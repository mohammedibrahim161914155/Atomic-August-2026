/**
 * src/pipelines/tool-builder/index.ts
 *
 * Tool Builder Pipeline (Part 5 — Pipeline B)
 *
 * Takes a tool concept (what it does, what it connects to, which agent uses it)
 * and generates a complete, MCP-compatible tool specification plus implementation
 * skeleton.
 *
 * The output is ready to paste into an MCP server or Vercel AI SDK tool registry.
 */

import { z } from 'zod';
import { generateJson, generateText } from '../../engine/openrouter';
import { withRetry } from '../../engine/withRetry';
import { log } from '../../engine/logger';
import type { ModelConfig } from '../../engine/config';
import { createHash } from 'crypto';
import type { EngineEvent } from '../../engine/types';

// ── Input / Output Types ───────────────────────────────────────────────────

export interface ToolBuilderInput {
  toolConcept: string;            // What the tool does in plain English
  targetAgent: string;            // Which agent will use this tool
  externalSystem?: string;        // External API or service it connects to (optional)
  authMechanism?: string;         // e.g. "API key in Authorization header", "OAuth2"
  expectedCallFrequency?: string; // e.g. "high-frequency, called 100x/min"
  constraints?: string;           // e.g. "must be idempotent", "max 200ms latency"
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const JsonSchemaPropertySchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    type: z.string(),
    description: z.string().optional(),
    enum: z.array(z.string()).optional(),
    items: JsonSchemaPropertySchema.optional(),
    properties: z.record(z.string(), JsonSchemaPropertySchema).optional(),
    required: z.array(z.string()).optional(),
    default: z.unknown().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
  })
);

const ToolErrorSchema = z.object({
  code: z.string().describe('Machine-readable error code, e.g. TOOL_TIMEOUT'),
  message: z.string().describe('Human-readable error description'),
  retryable: z.boolean(),
  httpStatus: z.number().int().optional(),
});

const SecurityNoteSchema = z.object({
  category: z.enum(['injection', 'credential-handling', 'data-leakage', 'rate-limit', 'auth', 'other']),
  finding: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  mitigation: z.string(),
});

const OpenApiOperationSchema = z.object({
  operationId: z.string(),
  summary: z.string(),
  description: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string(),
  requestBody: z.any().optional(),
  responses: z.record(z.string(), z.unknown()),
}).nullable();

export const ToolBlueprintSchema = z.object({
  toolName: z.string().regex(/^[a-z][a-z0-9_]*$/, 'Tool names must be snake_case'),
  toolDescription: z.string().min(50).describe('Optimised for LLM comprehension — explains WHEN to use the tool, not just WHAT it does'),
  version: z.string().default('1.0.0'),
  inputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), JsonSchemaPropertySchema),
    required: z.array(z.string()),
    additionalProperties: z.literal(false),
  }),
  outputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), JsonSchemaPropertySchema),
    required: z.array(z.string()),
  }),
  mcpDefinition: z.string().describe('Ready-to-paste MCP tool definition (TypeScript)'),
  implementationSkeleton: z.string().describe('TypeScript implementation skeleton with TODOs'),
  testSuite: z.string().describe('Vitest/Jest spec file with unit and integration tests'),
  openApiFragment: OpenApiOperationSchema.describe('OpenAPI 3.1 operation fragment, null if no HTTP API'),
  securityNotes: z.array(SecurityNoteSchema),
  rateLimitStrategy: z.string().describe('Recommended rate limiting approach for this tool'),
  retryStrategy: z.string().describe('When and how to retry calls to this tool'),
  errors: z.array(ToolErrorSchema),
  usageExamples: z.array(z.object({
    scenario: z.string(),
    input: z.record(z.string(), z.unknown()),
    expectedOutput: z.record(z.string(), z.unknown()),
    notes: z.string().optional(),
  })),
  qualityScore: z.number().min(0).max(100).default(0),
});

export type ToolBlueprint = z.infer<typeof ToolBlueprintSchema>;

// ── Pillar definitions ─────────────────────────────────────────────────────

interface ToolPillar {
  name: string;
  systemPrompt: string;
}

const PILLARS: ToolPillar[] = [
  {
    name: 'tool-specification-architect',
    systemPrompt: `You are the Tool Specification Architect for the Tool Builder pipeline.

Your job: Define the tool's interface contract with precision suitable for production use.

Deliver:
1. TOOL NAME — snake_case, describes the action (verb_noun pattern: get_user, create_issue, search_documents)
2. DESCRIPTION — optimised for LLM comprehension. Tell the agent WHEN to call this tool (not just what it does). Include: purpose, preconditions, side effects, idempotency
3. INPUT PARAMETERS — every parameter with type, description, valid values, constraints, required/optional
4. OUTPUT STRUCTURE — the exact shape returned on success
5. ERROR MODES — every failure condition with error code, message, and whether it's retryable
6. SIDE EFFECTS — does calling this tool modify state? What gets changed?
7. IDEMPOTENCY — is the tool safe to call multiple times with the same input?

Produce strict TypeScript types for the complete interface.`,
  },
  {
    name: 'mcp-adapter-designer',
    systemPrompt: `You are the MCP Adapter Designer for the Tool Builder pipeline.

Your job: Design the MCP (Model Context Protocol) wrapper that exposes this tool to AI agents.

Deliver:
1. MCP TOOL DEFINITION — complete TypeScript code for an MCP tool registration including:
   - tool name (must match spec)
   - description (verbatim from spec or improved)
   - inputSchema (JSON Schema object with full field descriptions)
   - handler function signature
2. HANDLER SKELETON — the execute() function body with proper error handling and typed return
3. TRANSPORT — which MCP transport to use (stdio, HTTP SSE, WebSocket) and why
4. REGISTRATION — how to register this tool in the MCP server's tool list

Use the @modelcontextprotocol/sdk TypeScript types. Output complete, compilable TypeScript.`,
  },
  {
    name: 'api-integration-planner',
    systemPrompt: `You are the API Integration Planner for the Tool Builder pipeline.

Your job: Design the external API integration layer (if the tool wraps an external service).

Deliver:
1. AUTH STRATEGY — how credentials are stored, loaded, and validated
2. HTTP CLIENT — which library (axios, fetch, got) and why; base URL config; timeout settings
3. RATE LIMITING — rate limit handling (detect 429, implement token bucket or queue)
4. RETRY LOGIC — retry policy (which errors to retry, backoff algorithm, max attempts)
5. CIRCUIT BREAKER — fail-fast when the external API is degraded
6. RESPONSE PARSING — how to deserialize, validate, and transform the API response
7. OPENAPI FRAGMENT — the relevant OpenAPI 3.1 path+operation object

If no external API is involved, design the equivalent internal service integration.`,
  },
  {
    name: 'error-taxonomy-designer',
    systemPrompt: `You are the Error Taxonomy Designer for the Tool Builder pipeline.

Your job: Define the complete, typed error taxonomy for this tool.

Deliver:
1. ERROR ENUM — every error code the tool can return (e.g., TOOL_TIMEOUT, AUTH_INVALID, INPUT_VALIDATION_FAILED)
2. ERROR CLASSES — TypeScript Error subclasses with typed properties for each error category
3. RETRY MATRIX — for each error code: retryable (Y/N), retry delay strategy, max retries
4. USER-FACING MESSAGES — safe, actionable messages for each error (no internal details exposed)
5. LOGGING STRATEGY — what to log for each error type (which fields, at what level)
6. AGENT GUIDANCE — for each error, what should the calling agent do? (give up, retry, escalate, ask user)

Every error code must have: code, message template, httpStatus (if applicable), retryable, severity.`,
  },
  {
    name: 'documentation-writer',
    systemPrompt: `You are the Documentation Writer for the Tool Builder pipeline.

Your job: Generate complete, production-quality documentation for this tool.

Deliver:
1. OVERVIEW — one paragraph explaining the tool's purpose and when to use it
2. PARAMETERS TABLE — all input parameters with type, required/optional, description, and example values
3. RETURN VALUE — complete description of the output structure with examples
4. USAGE EXAMPLES — 3-5 realistic examples showing different use cases (happy path and edge cases)
5. ERROR REFERENCE — all error codes with explanations and resolution steps
6. RATE LIMITS & QUOTAS — any usage restrictions the calling agent should be aware of
7. CHANGELOG — version history template

Write for a developer who is integrating this tool into an AI agent. Be precise, not verbose.`,
  },
  {
    name: 'test-harness-designer',
    systemPrompt: `You are the Test Harness Designer for the Tool Builder pipeline.

Your job: Design a complete test suite for this tool.

Deliver a complete Vitest/Jest spec file (TypeScript) containing:
1. UNIT TESTS — test the handler logic in isolation using mocks for external dependencies
2. INTEGRATION TESTS — test the full tool execution path with a real or stubbed external system
3. CONTRACT TESTS — validate that inputs and outputs match the declared JSON schemas
4. NEGATIVE TESTS — malformed inputs, auth failures, rate limits, network timeouts
5. MOCK STRATEGY — how to mock the external API (MSW, nock, or vitest.mock)
6. FIXTURES — reusable test data (valid inputs, invalid inputs, API response stubs)

Output a complete, runnable TypeScript test file. Include all imports.`,
  },
  {
    name: 'security-reviewer',
    systemPrompt: `You are the Security Reviewer for the Tool Builder pipeline.

Your job: Attack this tool specification from a security perspective and identify every risk.

Deliver:
1. INJECTION RISKS — can a malicious input compromise the tool's behavior? (SQL injection, path traversal, SSRF)
2. CREDENTIAL HANDLING — are API keys/tokens handled securely? (not logged, not exposed in errors, stored safely)
3. DATA LEAKAGE — does the tool output contain data that should not be exposed to the calling agent?
4. INPUT VALIDATION GAPS — which inputs are not adequately validated? What could go wrong?
5. RATE LIMIT ABUSE — can the tool be used to exhaust quota or trigger financial damage?
6. DEPENDENCY RISKS — are any third-party packages used? Do they have known vulnerabilities?

For each finding: severity (critical/high/medium/low), description, concrete mitigation.
Do not output generic security advice — attack THIS specific tool.`,
  },
];

// ── Pipeline runner ────────────────────────────────────────────────────────

async function runPillar(
  pillar: ToolPillar,
  input: ToolBuilderInput,
  config: ModelConfig,
  emitFn: (e: EngineEvent) => void,
  signal?: AbortSignal,
): Promise<string> {
  const pillarName = pillar.name as any;
  emitFn({ type: 'agent_start', pillar: pillarName, agent: pillar.name });

  const userPrompt = `Tool Concept: ${input.toolConcept}
Target Agent: ${input.targetAgent}
${input.externalSystem ? `External System: ${input.externalSystem}` : ''}
${input.authMechanism ? `Auth Mechanism: ${input.authMechanism}` : ''}
${input.expectedCallFrequency ? `Expected Call Frequency: ${input.expectedCallFrequency}` : ''}
${input.constraints ? `Constraints: ${input.constraints}` : ''}

Execute your specialized role now. Be exhaustive. Zero placeholders.`;

  try {
    const result = await withRetry(
      () => generateText(userPrompt, config, pillar.systemPrompt, {
        model: config.proModel,
        max_tokens: 6000,
        signal,
      }),
      signal,
      `tool-builder:${pillar.name}`,
    );

    const preview = result.text.substring(0, 100).replace(/\n/g, ' ') + '...';
    emitFn({ type: 'agent_done', pillar: pillarName, agent: pillar.name, preview });
    return result.text;
  } catch (err: any) {
    log.error({ err, pillar: pillar.name }, '[tool-builder] pillar failed');
    emitFn({ type: 'agent_done', pillar: pillarName, agent: pillar.name, preview: '[PILLAR FAILED]' });
    return `[${pillar.name} output unavailable: ${(err as Error)?.message ?? 'unknown error'}]`;
  }
}

const SYNTHESIZER_PROMPT = `You are the Tool Blueprint Synthesizer. You receive outputs from 7 specialist analysis agents and must produce a single, complete, machine-readable ToolBlueprint.

Critical requirements:
- toolName must be snake_case (verb_noun)
- toolDescription must be ≥50 characters and optimised for LLM comprehension (when to use, not just what)
- inputSchema must use JSON Schema 2020-12 with additionalProperties: false
- mcpDefinition must be complete, compilable TypeScript using @modelcontextprotocol/sdk
- implementationSkeleton must include TODO comments marking every section that needs real implementation
- testSuite must be a complete, runnable Vitest spec file
- securityNotes must contain ALL findings from the security reviewer, not a subset
- errors array must cover EVERY failure mode identified across all agents

Synthesize now. Output valid JSON matching the ToolBlueprint schema.`;

/**
 * Run the Tool Builder pipeline.
 */
export async function runToolBuilderPipeline(
  input: ToolBuilderInput,
  config: ModelConfig,
  emitFn: (e: EngineEvent) => void,
  signal?: AbortSignal,
): Promise<ToolBlueprint> {
  emitFn({ type: 'governor_start', prompt: input.toolConcept });

  // v2.2 — Kilo Code-style run telemetry: open a run record so duration,
  // tokens, verdict and drift are readable via GET /api/v1/sessions/:id/runs.
  const sessionId = deriveSessionId(input.toolConcept);
  let runId: string;
  let tokensUsed = 0;
  try {
    const { recordRunStart } = await import('../../engine/runSummary');
    runId = await recordRunStart({ session: sessionId, pipeline: 'tool-builder', model: config.proModel });
  } catch {
    runId = sessionId;
  }

  const pillarOutputs = await Promise.all(
    PILLARS.map(p => runPillar(p, input, config, emitFn, signal))
  );

  emitFn({ type: 'governor_done', intent: { app_name: 'Tool Builder', description: input.toolConcept } as any });

  const synthesisPrompt =
    PILLARS.map((p, i) => `=== ${p.name.toUpperCase()} ===\n${pillarOutputs[i]}`).join('\n\n') +
    `\n\nOriginal Tool Concept: ${input.toolConcept}` +
    `\nTarget Agent: ${input.targetAgent}` +
    (input.externalSystem ? `\nExternal System: ${input.externalSystem}` : '');

  const synthesisResult = await withRetry(
    () => generateJson<ToolBlueprint>(
      synthesisPrompt,
      config,
      ToolBlueprintSchema,
      SYNTHESIZER_PROMPT,
      { model: config.proModel, max_tokens: 8000, signal },
    ),
    signal,
    'tool-builder:synthesizer',
  );
  tokensUsed += (synthesisResult as any)?.tokens_used ?? 0;
  const { data } = synthesisResult;

    // Agentic Core verifier loop (Codex validate-then-repair + OpenDesign
  // composite verdict) — weak first passes are repaired up to N rounds
  // before the verdict is final. Failure degrades gracefully to the
  // pre-verifier candidate.
  let candidate: ToolBlueprint = data;
  try {
    const { verifyPipelineOutput } = await import('../../engine/pipelineVerifier');
    const { resolvePipelineDefaults, captureStageSnapshot } = await import('../../engine/agenticCore');
    const snap = await captureStageSnapshot(
      sessionId,
      'synthesized',
      { pipeline: 'tool-builder', sections: Object.keys(data) },
    );
    emitFn({ type: 'snapshot.captured', stage: 'synthesized', snapshotId: snap.id } as EngineEvent);
    const { outcome, candidate: verified } = await verifyPipelineOutput<ToolBlueprint>({
      candidate: data,
      config,
      checks: TOOL_BUILDER_CHECKS,
      schema: ToolBlueprintSchema,
      systemPrompt: SYNTHESIZER_PROMPT,
      synthesisPrompt,
      cfg: resolvePipelineDefaults('tool-builder').verdict,
      emit: emitFn,
      signal,
      label: 'tool-builder-verifier',
    });
    candidate = verified;
    try {
      const { saveCheckpoint } = await import('../../engine/checkpoint');
      await saveCheckpoint(sessionId, 'verdict', outcome);
      emitFn({ type: 'checkpoint_saved', key: 'verdict' });
    } catch {
      /* checkpoint best-effort */
    }

    // v2.2 — OpenDesign-style quality ledger: persist every verifier round
    // so the run's quality trajectory is visible via the quality API.
    try {
      const { recordVerifierRound } = await import('../../engine/qualityLedger');
      for (const round of outcome.rounds) {
        await recordVerifierRound({
          session: sessionId,
          pipeline: 'tool-builder',
          round: round.n,
          composite: round.composite,
          mustFix: round.mustFix,
          verdict: round.verdict,
          scores: round.scores,
        });
      }
    } catch {
      /* ledger best-effort */
    }
  } catch (err) {
    log.error({ err }, '[tool-builder] verifier loop failed — shipping pre-verifier candidate');
  }

  const hasAll = [
    candidate.toolName.length > 0,
    candidate.toolDescription.length >= 50,
    Object.keys(candidate.inputSchema.properties).length > 0,
    candidate.mcpDefinition.length > 100,
    candidate.implementationSkeleton.length > 100,
    candidate.testSuite.length > 100,
    candidate.securityNotes.length > 0,
    candidate.errors.length > 0,
    candidate.usageExamples.length > 0,
  ];
  candidate.qualityScore = Math.round((hasAll.filter(Boolean).length / hasAll.length) * 100);

  // v2.2 — close the run record with terminal metrics (fire-and-forget).
  void (async () => {
    try {
      const { recordRunEnd } = await import('../../engine/runSummary');
      let driftReport: { drifted: boolean } | null = null;
      try {
        const { evaluateDrift } = await import('../../engine/qualityLedger');
        driftReport = await evaluateDrift({ session: sessionId, pipeline: 'tool-builder', current: candidate.qualityScore });
      } catch { /* drift eval best-effort */ }
      await recordRunEnd({
        session: sessionId,
        runId,
        status: 'success',
        tokens_used: tokensUsed,
        verifier_composite: candidate.qualityScore,
        verifier_verdict: 'ship',
        quality_drifted: driftReport?.drifted ?? null,
      });
    } catch {
      /* telemetry best-effort */
    }
  })();

  return candidate;
}

/** Pipeline-level quality checks powering the tool-builder verifier. */
const TOOL_BUILDER_CHECKS: import('../../engine/pipelineVerifier').PipelineQualityCheck<ToolBlueprint>[] = [
  { label: 'tool-name', pass: c => c.toolName.length > 0, role: 'completeness' },
  { label: 'tool-description', pass: c => c.toolDescription.length >= 50, role: 'completeness' },
  { label: 'input-schema', pass: c => Object.keys(c.inputSchema.properties).length > 0, role: 'completeness' },
  { label: 'mcp-definition', pass: c => c.mcpDefinition.length > 100, role: 'actionability' },
  { label: 'implementation-skeleton', pass: c => c.implementationSkeleton.length > 100, role: 'actionability' },
  { label: 'test-suite', pass: c => c.testSuite.length > 100, role: 'rigour' },
  { label: 'security-notes', pass: c => c.securityNotes.length > 0, role: 'rigour' },
  { label: 'error-handling', pass: c => c.errors.length > 0, role: 'rigour' },
  { label: 'usage-examples', pass: c => c.usageExamples.length > 0, role: 'actionability' },
];

function deriveSessionId(seed: string): string {
  try {
    return createHash('sha256').update(seed).digest('hex').slice(0, 32);
  } catch {
    return 'tool-' + Math.random().toString(36).slice(2, 10);
  }
}
