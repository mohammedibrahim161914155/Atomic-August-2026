/**
 * src/pipelines/feature-creator/index.ts
 *
 * Feature Creator Pipeline (Part 5 — Pipeline A)
 *
 * Takes an existing codebase context + feature description and generates a
 * complete, implementation-ready feature blueprint that a coding agent can
 * execute directly.
 *
 * Architecture:
 *   8 specialist pillars → Parallel Reviewer + Prosecutor → Synthesizer
 *
 * Reuses the Vercel AI SDK generateText / generateJson infrastructure from
 * the main blueprint pipeline, with a Feature-specific type system.
 */

import { z } from 'zod';
import { createHash } from 'crypto';
import { generateJson, generateText } from '../../engine/openrouter';
import { withRetry } from '../../engine/withRetry';
import { log } from '../../engine/logger';
import type { ModelConfig } from '../../engine/config';
import type { EngineEvent } from '../../engine/types';

// ── Input / Output Types ───────────────────────────────────────────────────

export interface FeatureCreatorInput {
  featureDescription: string;
  codebaseContext: string;       // tech stack, architecture overview, key conventions
  existingApiContracts?: string; // OpenAPI / GraphQL schema snippets
  constraints?: string;          // e.g. "must be backwards compatible", "no new dependencies"
  targetComplexity?: 'small' | 'medium' | 'large'; // Fibonacci complexity hint
}

const FileChangeSchema = z.object({
  path: z.string().describe('File path relative to project root'),
  changeType: z.enum(['create', 'modify', 'delete', 'rename']),
  rationale: z.string().describe('Why this change is necessary'),
  codeSketch: z.string().describe('Pseudocode or key TypeScript/code snippet'),
  estimatedLinesChanged: z.number().int().nonnegative(),
});

const RiskMatrixEntrySchema = z.object({
  risk: z.string(),
  likelihood: z.enum(['low', 'medium', 'high']),
  impact: z.enum(['low', 'medium', 'high', 'critical']),
  mitigation: z.string(),
});

const TestPlanSchema = z.object({
  unit: z.array(z.string()).describe('Unit test cases to write'),
  integration: z.array(z.string()).describe('Integration test scenarios'),
  e2e: z.array(z.string()).describe('End-to-end user journey tests'),
  coverageTarget: z.number().int().min(0).max(100).describe('Target line coverage %'),
});

const MigrationPlanSchema = z.object({
  required: z.boolean(),
  steps: z.array(z.string()),
  rollbackSteps: z.array(z.string()),
  estimatedDowntimeMs: z.number().int().nonnegative(),
});

export const FeatureBlueprintSchema = z.object({
  featureName: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  architectureDiagram: z.string().describe('Mermaid diagram syntax'),
  fileChanges: z.array(FileChangeSchema),
  testPlan: TestPlanSchema,
  migrationPlan: MigrationPlanSchema,
  riskMatrix: z.array(RiskMatrixEntrySchema),
  implementationOrder: z.array(z.string()).describe('Dependency-sorted task list'),
  estimatedComplexity: z.number().int().min(1).max(13).describe('Fibonacci story points: 1,2,3,5,8,13'),
  estimatedSprintDays: z.number().int().min(1),
  breakingChanges: z.array(z.string()),
  dependenciesRequired: z.array(z.string()),
  qualityScore: z.number().min(0).max(100).default(0),
});

export type FeatureBlueprint = z.infer<typeof FeatureBlueprintSchema>;

// ── Pillar definitions ─────────────────────────────────────────────────────

interface FeaturePillar {
  name: string;
  systemPrompt: string;
}

const PILLARS: FeaturePillar[] = [
  {
    name: 'codebase-archaeologist',
    systemPrompt: `You are the Codebase Archaeologist for the Feature Creator pipeline.

Your job: Analyse the existing architecture and identify exactly WHERE the new feature hooks in.

Deliver:
1. INSERTION POINTS — specific files, functions, classes, and modules that must be modified
2. CONVENTIONS — naming patterns, folder structure, code style conventions the new feature must follow
3. DEPENDENCIES — existing internal APIs and utilities the feature should reuse (not reinvent)
4. RISKS — existing technical debt or fragile areas that could complicate the feature
5. COMPATIBILITY CONSTRAINTS — backwards-compat requirements, existing API contracts that must be preserved

Format: structured technical analysis. No vague language. Name specific files and functions.`,
  },
  {
    name: 'feature-architect',
    systemPrompt: `You are the Feature Architect for the Feature Creator pipeline.

Your job: Design the feature's high-level architecture and component breakdown.

Deliver:
1. ARCHITECTURE OVERVIEW — how the feature fits into the existing system
2. COMPONENT BREAKDOWN — every new component, service, or module needed
3. DATA FLOW — how data moves through the feature from request to response
4. DEPENDENCY GRAPH — which components depend on which
5. MERMAID DIAGRAM — a complete flowchart or sequence diagram of the feature

Be specific. Every component must have a clear name, responsibility, and interface.
A "TBD" in your output is a failed deliverable.`,
  },
  {
    name: 'api-contract-designer',
    systemPrompt: `You are the API Contract Designer for the Feature Creator pipeline.

Your job: Define every new HTTP endpoint, WebSocket channel, or event the feature introduces.

Deliver for EACH endpoint:
1. METHOD + PATH — e.g. POST /api/v1/features/:id/activate
2. REQUEST SCHEMA — all fields with types, validation rules, and examples
3. RESPONSE SCHEMA — success and error shapes with status codes
4. AUTH REQUIREMENTS — which roles/permissions are required
5. RATE LIMITING — rate limit tier for this endpoint
6. IDEMPOTENCY — is the operation idempotent? Does it need an Idempotency-Key?

Output valid TypeScript types or JSON Schema. No placeholders.`,
  },
  {
    name: 'data-model-designer',
    systemPrompt: `You are the Data Model Designer for the Feature Creator pipeline.

Your job: Design every new database table, column, index, and migration.

Deliver:
1. NEW TABLES — full SQL CREATE TABLE statements with all columns, types, and constraints
2. MODIFIED TABLES — ALTER TABLE statements for columns added to existing tables
3. INDEXES — every index with justification (query pattern it serves)
4. FOREIGN KEYS — all referential integrity constraints
5. MIGRATION SCRIPT — forward migration with rollback
6. SEED DATA — any required initial data

Use Postgres-compatible SQL. Include deleted_at for soft-deleteable entities. Include created_at / updated_at on every table.`,
  },
  {
    name: 'frontend-blueprint',
    systemPrompt: `You are the Frontend Blueprint Designer for the Feature Creator pipeline.

Your job: Design the complete UI layer for the feature.

Deliver:
1. COMPONENT TREE — every new React component with its props interface
2. STATE MANAGEMENT — what state is local vs. global (Redux/Zustand/Context)
3. API INTEGRATION — which hooks or queries fetch data, with loading/error/success states
4. USER FLOWS — step-by-step interaction flows with edge cases (empty state, error state, optimistic update)
5. ACCESSIBILITY — ARIA roles, keyboard navigation, focus management requirements
6. RESPONSIVE DESIGN — breakpoint-specific layout decisions

Produce TypeScript interface definitions for all props. No placeholder component names.`,
  },
  {
    name: 'backend-blueprint',
    systemPrompt: `You are the Backend Blueprint Designer for the Feature Creator pipeline.

Your job: Design the complete server-side implementation of the feature.

Deliver:
1. SERVICE LAYER — all new service classes/functions with method signatures and contracts
2. BUSINESS LOGIC — the core algorithms, validation rules, and domain logic
3. ERROR HANDLING — all failure modes with typed errors and safe user-facing messages
4. TRANSACTIONS — which operations require DB transactions and why
5. BACKGROUND JOBS — any async work that should run outside the request cycle
6. CACHING — what should be cached, cache key design, TTL strategy, invalidation triggers

Use TypeScript interfaces for all public APIs. Every function must have JSDoc.`,
  },
  {
    name: 'test-strategy-designer',
    systemPrompt: `You are the Test Strategy Designer for the Feature Creator pipeline.

Your job: Design a complete test plan that gives high confidence the feature works correctly.

Deliver:
1. UNIT TESTS — specific test cases for business logic, validators, and utilities (name each test)
2. INTEGRATION TESTS — real DB/queue tests for service layer and API endpoints
3. E2E TESTS — critical user journeys from frontend to database
4. EDGE CASES — empty states, concurrent writes, malformed inputs, permission boundaries
5. PERFORMANCE TESTS — load test scenarios if the feature is on a hot path
6. COVERAGE TARGET — line and branch coverage targets with justification

For each test category, list specific test cases, not just "test the API". Be exhaustive.`,
  },
  {
    name: 'risk-assessor',
    systemPrompt: `You are the Risk Assessor for the Feature Creator pipeline.

Your job: Identify every risk that could cause the feature to fail, introduce security vulnerabilities, or degrade system performance.

Deliver:
1. SECURITY RISKS — injection, auth bypass, privilege escalation, data exposure
2. PERFORMANCE RISKS — N+1 queries, missing indexes, unbounded queries, cache misses
3. BREAKING CHANGES — API, schema, or behavioral changes that could break existing consumers
4. DEPENDENCY RISKS — new packages, version conflicts, license issues
5. OPERATIONAL RISKS — deployment complexity, rollback difficulty, monitoring gaps
6. ROLLBACK PLAN — step-by-step rollback procedure if the feature must be reverted

For each risk: likelihood (low/medium/high), impact (low/medium/high/critical), mitigation.`,
  },
];

// ── Pipeline runner ────────────────────────────────────────────────────────

function emit(event: EngineEvent, emitFn: (e: EngineEvent) => void): void {
  emitFn(event);
}

async function runPillar(
  pillar: FeaturePillar,
  input: FeatureCreatorInput,
  config: ModelConfig,
  emitFn: (e: EngineEvent) => void,
  signal?: AbortSignal,
): Promise<string> {
  const pillarName = pillar.name as any;
  emit({ type: 'agent_start', pillar: pillarName, agent: pillar.name }, emitFn);

  const userPrompt = `Feature Request: ${input.featureDescription}

Codebase Context:
${input.codebaseContext}

${input.existingApiContracts ? `Existing API Contracts:\n${input.existingApiContracts}\n` : ''}
${input.constraints ? `Constraints:\n${input.constraints}\n` : ''}
${input.targetComplexity ? `Target Complexity: ${input.targetComplexity}\n` : ''}

Execute your specialized role now. Be exhaustive and specific. Zero placeholders.`;

  try {
    const result = await withRetry(
      () => generateText(userPrompt, config, pillar.systemPrompt, {
        model: config.proModel,
        max_tokens: 6000,
        signal,
      }),
      signal,
      `feature-creator:${pillar.name}`,
    );

    const preview = result.text.substring(0, 100).replace(/\n/g, ' ') + '...';
    emit({ type: 'agent_done', pillar: pillarName, agent: pillar.name, preview }, emitFn);

    return result.text;
  } catch (err: any) {
    log.error({ err, pillar: pillar.name }, '[feature-creator] pillar failed');
    emit({ type: 'agent_done', pillar: pillarName, agent: pillar.name, preview: '[PILLAR FAILED]' }, emitFn);
    return `[${pillar.name} output unavailable: ${(err as Error)?.message ?? 'unknown error'}]`;
  }
}

const SYNTHESIZER_PROMPT = `You are the Feature Blueprint Synthesizer. You receive outputs from 8 specialist analysis agents and must produce a single, complete, machine-readable FeatureBlueprint.

Rules:
- Every field must be populated. No placeholders, no "TBD", no empty arrays for required fields.
- fileChanges must name real files — infer paths from the codebase context provided.
- acceptanceCriteria must be user-story formatted: "Given X, When Y, Then Z"
- architectureDiagram must be valid Mermaid syntax
- implementationOrder must be topologically sorted (no circular dependencies)
- estimatedComplexity uses Fibonacci: 1, 2, 3, 5, 8, or 13 story points
- breakingChanges must list EVERY change that could break existing clients (empty array only if truly zero)

Synthesize now. Output valid JSON matching the FeatureBlueprint schema.`;

/**
 * Run the Feature Creator pipeline.
 *
 * Registered in the Governor's pipeline selector via the 'feature' pipeline type.
 */
export async function runFeatureCreatorPipeline(
  input: FeatureCreatorInput,
  config: ModelConfig,
  emitFn: (e: EngineEvent) => void,
  signal?: AbortSignal,
): Promise<FeatureBlueprint> {
  emit({ type: 'governor_start', prompt: input.featureDescription }, emitFn);

  // Run all 8 pillars in parallel
  const pillarOutputs = await Promise.all(
    PILLARS.map(p => runPillar(p, input, config, emitFn, signal))
  );

  emit({ type: 'governor_done', intent: { app_name: 'Feature Creator', description: input.featureDescription } as any }, emitFn);

  // Synthesize into a structured blueprint
  const synthesisPrompt = PILLARS.map((p, i) =>
    `=== ${p.name.toUpperCase()} ===\n${pillarOutputs[i]}`
  ).join('\n\n') + `\n\nFeature: ${input.featureDescription}\nCodebase: ${input.codebaseContext.slice(0, 2000)}`;

  const { data } = await withRetry(
    () => generateJson<FeatureBlueprint>(
      synthesisPrompt,
      config,
      FeatureBlueprintSchema,
      SYNTHESIZER_PROMPT,
      { model: config.proModel, max_tokens: 8000, signal },
    ),
    signal,
    'feature-creator:synthesizer',
  );

  // Agentic Core verifier loop (Codex validate-then-repair + OpenDesign
  // composite verdict) — weak first passes are repaired up to N rounds
  // before the verdict is final. Failure degrades gracefully to the
  // pre-verifier candidate.
  let candidate: FeatureBlueprint = data;
  try {
    const { verifyPipelineOutput } = await import('../../engine/pipelineVerifier');
    const { resolvePipelineDefaults, captureStageSnapshot } = await import('../../engine/agenticCore');
    const sessionId = deriveSessionId(input.featureDescription);
    const snap = await captureStageSnapshot(
      sessionId,
      'synthesized',
      { pipeline: 'feature-creator', sections: Object.keys(data) },
    );
    emitFn({ type: 'snapshot.captured', stage: 'synthesized', snapshotId: snap.id } as EngineEvent);
    const { outcome, candidate: verified } = await verifyPipelineOutput<FeatureBlueprint>({
      candidate: data,
      config,
      checks: FEATURE_CREATOR_CHECKS,
      schema: FeatureBlueprintSchema,
      systemPrompt: SYNTHESIZER_PROMPT,
      synthesisPrompt,
      cfg: resolvePipelineDefaults('feature-creator').verdict,
      emit: emitFn,
      signal,
      label: 'feature-creator-verifier',
    });
    candidate = verified;
    try {
      const { saveCheckpoint } = await import('../../engine/checkpoint');
      await saveCheckpoint(sessionId, 'verdict', outcome);
      emitFn({ type: 'checkpoint_saved', key: 'verdict' });
    } catch {
      /* checkpoint best-effort */
    }
  } catch (err) {
    log.error({ err }, '[feature-creator] verifier loop failed — shipping pre-verifier candidate');
  }

  // Compute a simple quality score for the elected candidate.
  const hasAllSections = [
    candidate.fileChanges.length > 0,
    candidate.testPlan.unit.length > 0,
    candidate.riskMatrix.length > 0,
    candidate.acceptanceCriteria.length > 0,
    candidate.architectureDiagram.length > 50,
    candidate.implementationOrder.length > 0,
  ];
  candidate.qualityScore = Math.round((hasAllSections.filter(Boolean).length / hasAllSections.length) * 100);

  return candidate;
}

/** Pipeline-level quality checks powering the feature-creator verifier. */
const FEATURE_CREATOR_CHECKS: import('../../engine/pipelineVerifier').PipelineQualityCheck<FeatureBlueprint>[] = [
  { label: 'file-changes', pass: c => c.fileChanges.length > 0, role: 'completeness' },
  { label: 'test-plan', pass: c => c.testPlan.unit.length > 0, role: 'completeness' },
  { label: 'risk-matrix', pass: c => c.riskMatrix.length > 0, role: 'completeness' },
  { label: 'acceptance-criteria', pass: c => c.acceptanceCriteria.length > 0, role: 'completeness' },
  { label: 'mermaid-diagram', pass: c => c.architectureDiagram.length > 50, role: 'actionability' },
  { label: 'implementation-order', pass: c => c.implementationOrder.length > 0, role: 'rigour' },
];

function deriveSessionId(seed: string): string {
  try {
    return createHash('sha256').update(seed).digest('hex').slice(0, 32);
  } catch {
    return 'feature-' + Math.random().toString(36).slice(2, 10);
  }
}
