/**
 * src/engine/curatorSubAgents.ts
 *
 * Curator Parallel Sub-Agent Ensemble
 *
 * Four specialized sub-agents run in parallel to produce a comprehensive
 * multi-dimensional quality analysis of a blueprint. Each sub-agent is a
 * domain expert that focuses exclusively on its area of concern.
 *
 * Sub-agents:
 *   1. SecurityReviewer      — OWASP Top 10, auth patterns, secrets management, encryption
 *   2. ScalabilityAuditor    — Load capacity, bottlenecks, horizontal scaling, caching strategy
 *   3. CompletenessChecker   — Missing architectural sections, unaddressed concerns, gaps
 *   4. ConsistencyAnalyzer   — Cross-pillar contradictions, naming inconsistencies, logical conflicts
 *
 * Architecture:
 *   - Each sub-agent uses generateObject (structured Zod output) for precision
 *   - All use proModel since this is deep architectural review work
 *   - Individual failures are isolated — the orchestrator merges non-null results
 *   - All findings are tagged with sub-agent provenance for traceability
 *   - Findings are merged and deduped before surfacing to the RefinementReport
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { ModelConfig } from './config';
import { getModelForConfig } from './openrouter';
import { publishEvent } from './eventBus';
import { log } from './logger';
import { withRetry } from './withRetry';
import { randomUUID } from 'crypto';
import type { Blueprint } from './types';

// ── Shared finding schema (matches RefinementReport.FindingSchema) ─────────────

const SubFindingSchema = z.object({
  id:             z.string(),
  severity:       z.enum(['critical', 'warning', 'suggestion']),
  pillarId:       z.string().optional(),
  sectionId:      z.string().optional(),
  description:    z.string(),
  impact:         z.string(),
  recommendation: z.string(),
  source: z.object({
    title:       z.string(),
    url:         z.string().optional(),
    retrievedAt: z.string().optional(),
  }).optional(),
  subAgent: z.string(), // which sub-agent produced this finding
});

type SubFinding = z.infer<typeof SubFindingSchema>;

// ── 1. Security Reviewer schema ───────────────────────────────────────────────

const SecurityAnalysisSchema = z.object({
  findings:           z.array(SubFindingSchema),
  overallScore:       z.number().min(0).max(100),
  owaspCoverage: z.object({
    injection:           z.boolean(),
    brokenAuth:          z.boolean(),
    sensitiveData:       z.boolean(),
    xxe:                 z.boolean(),
    brokenAccessControl: z.boolean(),
    securityMisconfig:   z.boolean(),
    xss:                 z.boolean(),
    insecureDeserialization: z.boolean(),
    knownVulnComponents: z.boolean(),
    insufficientLogging: z.boolean(),
  }),
  strengths:          z.array(z.string()).describe('Security practices done well'),
  criticalGaps:       z.array(z.string()).describe('Security areas with no coverage in blueprint'),
  summary:            z.string(),
});

export type SecurityAnalysis = z.infer<typeof SecurityAnalysisSchema>;

// ── 2. Scalability Auditor schema ─────────────────────────────────────────────

const BottleneckSchema = z.object({
  component:           z.string(),
  estimatedLimitRPS:   z.number().optional().describe('Estimated requests/sec before saturation'),
  failureMode:         z.string(),
  mitigation:          z.string(),
  priority:            z.enum(['immediate', 'near-term', 'future']),
});

const ScalabilityAnalysisSchema = z.object({
  findings:            z.array(SubFindingSchema),
  overallScore:        z.number().min(0).max(100),
  bottlenecks:         z.array(BottleneckSchema),
  scalingStrategy:     z.enum(['vertical', 'horizontal', 'mixed', 'unknown']).describe('Current implied strategy'),
  missingPatterns:     z.array(z.string()).describe('e.g. circuit breakers, caching, read replicas'),
  targetLoadAssessment: z.string().describe('Whether stated load targets can be met with proposed architecture'),
  summary:             z.string(),
});

export type ScalabilityAnalysis = z.infer<typeof ScalabilityAnalysisSchema>;

// ── 3. Completeness Checker schema ────────────────────────────────────────────

const MissingAreaSchema = z.object({
  area:        z.string(),
  severity:    z.enum(['critical', 'warning', 'suggestion']),
  description: z.string(),
  whyItMatters: z.string(),
  suggestion:  z.string(),
});

const CompletenessAnalysisSchema = z.object({
  findings:            z.array(SubFindingSchema),
  overallScore:        z.number().min(0).max(100),
  missingAreas:        z.array(MissingAreaSchema),
  wellCoveredAreas:    z.array(z.string()),
  architecturalCoverage: z.object({
    authentication:    z.boolean(),
    authorization:     z.boolean(),
    dataModel:         z.boolean(),
    apiDesign:         z.boolean(),
    errorHandling:     z.boolean(),
    observability:     z.boolean(),
    deployment:        z.boolean(),
    backupRecovery:    z.boolean(),
    rateLimiting:      z.boolean(),
    multiTenancy:      z.boolean().optional(),
    compliance:        z.boolean().optional(),
  }),
  summary:             z.string(),
});

export type CompletenessAnalysis = z.infer<typeof CompletenessAnalysisSchema>;

// ── 4. Consistency Analyzer schema ────────────────────────────────────────────

const ContradictionSchema = z.object({
  id:               z.string(),
  severity:         z.enum(['critical', 'warning', 'suggestion']),
  pillarsInvolved:  z.array(z.string()),
  claim_a:          z.string().describe('First conflicting claim'),
  claim_b:          z.string().describe('Second conflicting claim (contradicts claim_a)'),
  resolution:       z.string().describe('Recommended way to resolve the contradiction'),
});

const ConsistencyAnalysisSchema = z.object({
  findings:          z.array(SubFindingSchema),
  overallScore:      z.number().min(0).max(100),
  contradictions:    z.array(ContradictionSchema),
  namingIssues:      z.array(z.string()).describe('Naming inconsistencies across pillars'),
  assumptionConflicts: z.array(z.string()).describe('Conflicting assumptions between pillars'),
  summary:           z.string(),
});

export type ConsistencyAnalysis = z.infer<typeof ConsistencyAnalysisSchema>;

// ── Aggregated results ────────────────────────────────────────────────────────

export interface CuratorSubAgentResults {
  security:     SecurityAnalysis    | null;
  scalability:  ScalabilityAnalysis | null;
  completeness: CompletenessAnalysis | null;
  consistency:  ConsistencyAnalysis  | null;
  durationMs:   number;
  succeededCount: number;
  allFindings:  SubFinding[];
}

// ── Blueprint summarizer (shared by all sub-agents) ───────────────────────────

function buildBlueprintContext(blueprint: Blueprint): string {
  const pillarSummaries = Object.entries(blueprint.pillars)
    .map(([name, p]) => `### ${name} Pillar\n${p.synthesizer_output?.slice(0, 600) ?? '(no output)'}`)
    .join('\n\n');

  return `# Blueprint: ${blueprint.intent.product_name}

## Problem Statement
${blueprint.intent.core_problem}

## Target Users
${blueprint.intent.target_users ?? 'not specified'}

## Executive Summary
${blueprint.sections?.executive_summary?.slice(0, 1000) ?? '(not generated)'}

## Architecture Overview
${blueprint.sections?.architecture?.slice(0, 1000) ?? '(not generated)'}

## Security Model
${blueprint.sections?.security_model?.slice(0, 800) ?? '(not generated)'}

## Data Model
${blueprint.sections?.data_model?.slice(0, 800) ?? '(not generated)'}

## API Contracts
${blueprint.sections?.api_contracts?.slice(0, 800) ?? '(not generated)'}

## Deployment Strategy
${blueprint.sections?.deployment?.slice(0, 600) ?? '(not generated)'}

## Testing Strategy
${blueprint.sections?.testing_strategy?.slice(0, 600) ?? '(not generated)'}

## Edge Cases
${blueprint.sections?.edge_cases?.slice(0, 600) ?? '(not generated)'}

## Pillar Outputs
${pillarSummaries}

## Quality Score: ${blueprint.quality_score}/100`;
}

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * Run all four Curator sub-agents in parallel.
 * Each failure is isolated — null results are excluded from the final merge.
 */
export async function runCuratorSubAgents(
  sessionId:       string,
  blueprint:       Blueprint,
  longTermContext: string,
  config:          ModelConfig,
  signal?:         AbortSignal,
): Promise<CuratorSubAgentResults> {
  const t0             = Date.now();
  const model          = getModelForConfig(config, config.proModel);
  const traceId        = randomUUID();
  const blueprintCtx   = buildBlueprintContext(blueprint);

  const fullContext = [
    longTermContext ? `${longTermContext}\n\n` : '',
    blueprintCtx,
  ].join('');

  log.info({ sessionId, traceId }, '[curator-sub] starting 4 parallel sub-agents');
  publishEvent('agent.tool_call_started', sessionId, traceId, {
    agent: 'CuratorOrchestrator',
    tool:  'runSubAgents',
    input: { count: 4, blueprintId: blueprint.id, phase: 'parallel_start' },
  });

  // ── Sub-agent 1: Security Reviewer ──────────────────────────────────────────

  const securityP = withRetry(async () => {
    const { object } = await generateObject({
      model,
      schema: SecurityAnalysisSchema,
      system: `You are a Security Reviewer sub-agent within the Curator system.
You are a senior application security engineer and OWASP expert.
Your sole task: perform a comprehensive security review of this blueprint.

Review framework:
1. Authentication: Are JWT/session/OAuth/MFA patterns correct and secure?
2. Authorization: RBAC/ABAC coverage, least privilege, tenant isolation
3. Input validation: Are all input surfaces validated server-side?
4. Secrets management: Are secrets handled via proper vaults/env vars?
5. Encryption: At rest (AES-256-GCM) and in transit (TLS 1.3)?
6. OWASP Top 10: Coverage and gaps across all 10 categories
7. Audit logging: Auth events, privilege changes, PII access with immutable log
8. CORS/CSP: Are headers and policies appropriate?
9. Rate limiting: Throttling on auth endpoints, API endpoints?
10. Dependency security: Any obvious supply-chain risks?

Severity rules:
- critical = vulnerability that would be exploited in production
- warning = significant gap that should be fixed before launch
- suggestion = hardening improvements, defense-in-depth

Every finding must include a specific, actionable recommendation with cited standard (OWASP, RFC, NIST, etc.).`,
      messages: [{ role: 'user', content: `Perform a comprehensive security review of this blueprint:\n\n${fullContext}` }],
      maxOutputTokens: 3000,
      temperature: 0,
      abortSignal: signal,
    });

    // Tag findings with sub-agent
    return {
      ...object,
      findings: object.findings.map(f => ({ ...f, subAgent: 'SecurityReviewer' })),
    };
  }, signal, 'curator-security', { maxAttempts: 2, baseDelayMs: 2000, maxDelayMs: 15000, jitterFactor: 0.3 })
    .catch((err: unknown) => {
      log.warn({ err, sessionId }, '[curator-sub] security reviewer failed');
      return null;
    });

  // ── Sub-agent 2: Scalability Auditor ────────────────────────────────────────

  const scalabilityP = withRetry(async () => {
    const { object } = await generateObject({
      model,
      schema: ScalabilityAnalysisSchema,
      system: `You are a Scalability Auditor sub-agent within the Curator system.
You are a senior infrastructure architect specializing in distributed systems and performance.
Your sole task: audit the scalability of this blueprint.

Review framework:
1. Database scalability: Connection pooling, read replicas, query efficiency, sharding readiness
2. Application layer: Horizontal scaling, statelessness, session storage strategy
3. Caching: Cache tiers (CDN → app → DB), TTL strategies, stampede prevention
4. Message queues: Async processing for non-critical paths, DLQ handling
5. API layer: Rate limiting, circuit breakers, bulkhead patterns
6. Load balancing: Sticky sessions implications, health checks
7. Single points of failure: Every SPOF must be flagged
8. Auto-scaling: Triggers, scale-in policies, minimum fleet size
9. Data partitioning: Multi-tenancy isolation, sharding strategy
10. Observability for scale: SLO definitions, RED metrics, error budgets

For each bottleneck, estimate the realistic load limit before saturation.
Severity: critical = will fail at stated load targets, warning = will struggle, suggestion = optimization`,
      messages: [{ role: 'user', content: `Perform a comprehensive scalability audit of this blueprint:\n\n${fullContext}` }],
      maxOutputTokens: 3000,
      temperature: 0,
      abortSignal: signal,
    });

    return {
      ...object,
      findings: object.findings.map(f => ({ ...f, subAgent: 'ScalabilityAuditor' })),
    };
  }, signal, 'curator-scalability', { maxAttempts: 2, baseDelayMs: 2000, maxDelayMs: 15000, jitterFactor: 0.3 })
    .catch((err: unknown) => {
      log.warn({ err, sessionId }, '[curator-sub] scalability auditor failed');
      return null;
    });

  // ── Sub-agent 3: Completeness Checker ───────────────────────────────────────

  const completenessP = withRetry(async () => {
    const { object } = await generateObject({
      model,
      schema: CompletenessAnalysisSchema,
      system: `You are a Completeness Checker sub-agent within the Curator system.
You are a principal architect who has reviewed hundreds of system designs.
Your sole task: identify architectural gaps and missing concerns in this blueprint.

Review framework — check for presence and adequate depth of:
1. Authentication & authorization design
2. Data model and schema design
3. API design (REST/GraphQL contracts, versioning, error formats)
4. Error handling strategy (retry, circuit breaker, DLQ, structured errors)
5. Observability (structured logging, distributed tracing, RED metrics, alerting, runbooks)
6. Deployment strategy (CI/CD, blue-green/canary, rollback, IaC)
7. Backup and disaster recovery (RPO/RTO targets, restore testing)
8. Rate limiting and abuse prevention
9. Security model (if not covered by another agent, note the gap)
10. Testing strategy (unit, integration, E2E, performance, load)
11. Multi-tenancy (if applicable): isolation model, data scoping
12. Compliance requirements (GDPR, HIPAA, PCI, SOC2 if relevant)
13. Developer experience (local dev setup, seed data, docs)
14. Cost model (compute, storage, bandwidth at scale)
15. Launch checklist (feature flags, dark launches, monitoring dashboards)

For each missing area: explain why it matters and what a minimal viable treatment looks like.`,
      messages: [{ role: 'user', content: `Check this blueprint for architectural completeness:\n\n${fullContext}` }],
      maxOutputTokens: 3000,
      temperature: 0,
      abortSignal: signal,
    });

    return {
      ...object,
      findings: object.findings.map(f => ({ ...f, subAgent: 'CompletenessChecker' })),
    };
  }, signal, 'curator-completeness', { maxAttempts: 2, baseDelayMs: 2000, maxDelayMs: 15000, jitterFactor: 0.3 })
    .catch((err: unknown) => {
      log.warn({ err, sessionId }, '[curator-sub] completeness checker failed');
      return null;
    });

  // ── Sub-agent 4: Consistency Analyzer ───────────────────────────────────────

  const consistencyP = withRetry(async () => {
    const { object } = await generateObject({
      model,
      schema: ConsistencyAnalysisSchema,
      system: `You are a Consistency Analyzer sub-agent within the Curator system.
You are a principal architect specializing in cross-system coherence and architectural governance.
Your sole task: identify contradictions, inconsistencies, and conflicts across the blueprint.

Review framework:
1. Technology contradictions: Same component named differently or specified differently in different pillars
2. Protocol conflicts: One pillar uses REST, another specifies gRPC for the same interface
3. Data model conflicts: Same entity modeled differently in data_model vs API contracts vs edge_cases
4. Scalability contradictions: Stateless session claim conflicts with in-memory session storage
5. Security contradictions: Auth described in security pillar conflicts with API pillar auth
6. Naming inconsistencies: UserService vs UserModule vs user-service across pillars
7. Assumption conflicts: One pillar assumes PostgreSQL, another assumes DynamoDB
8. Timeline conflicts: Implementation timeline doesn't align with MVP scope
9. Ownership conflicts: Responsibility for a component is claimed by multiple pillars
10. Dependency conflicts: Pillar A depends on a decision Pillar B hasn't made yet

For each contradiction: quote both conflicting claims, explain the impact, and recommend resolution.
Severity: critical = system cannot be built coherently, warning = would cause confusion, suggestion = minor cleanup`,
      messages: [{ role: 'user', content: `Analyze this blueprint for cross-pillar consistency:\n\n${fullContext}` }],
      maxOutputTokens: 3000,
      temperature: 0,
      abortSignal: signal,
    });

    return {
      ...object,
      findings: object.findings.map(f => ({ ...f, subAgent: 'ConsistencyAnalyzer' })),
    };
  }, signal, 'curator-consistency', { maxAttempts: 2, baseDelayMs: 2000, maxDelayMs: 15000, jitterFactor: 0.3 })
    .catch((err: unknown) => {
      log.warn({ err, sessionId }, '[curator-sub] consistency analyzer failed');
      return null;
    });

  // ── Await all in parallel ────────────────────────────────────────────────────

  const [security, scalability, completeness, consistency] = await Promise.all([
    securityP, scalabilityP, completenessP, consistencyP,
  ]);

  const durationMs     = Date.now() - t0;
  const succeededCount = [security, scalability, completeness, consistency].filter(Boolean).length;

  // Merge all findings into a single deduplicated list
  const allFindings: SubFinding[] = [
    ...(security?.findings ?? []),
    ...(scalability?.findings ?? []),
    ...(completeness?.findings ?? []),
    ...(consistency?.findings ?? []),
  ];

  log.info(
    { sessionId, durationMs, succeededCount, findingCount: allFindings.length },
    `[curator-sub] ${succeededCount}/4 sub-agents completed in ${durationMs}ms — ${allFindings.length} findings`,
  );

  publishEvent('agent.tool_call_completed', sessionId, traceId, {
    agent: 'CuratorOrchestrator',
    tool:  'subAgentsComplete',
    input: { succeededCount, durationMs, findingCount: allFindings.length, phase: 'parallel_done' },
  } as any);

  return { security, scalability, completeness, consistency, durationMs, succeededCount, allFindings };
}

// ── Dimension score merger ────────────────────────────────────────────────────

/**
 * Merge sub-agent scores into the RefinementReport dimension scores.
 * Sub-agents fill in their specialised dimensions; the caller computes overall.
 */
export function mergeSubAgentDimensions(results: CuratorSubAgentResults) {
  const mkDim = (score: number, summary: string, keyFindings: string[]) => ({
    score, summary, keyFindings,
  });

  return {
    security: results.security
      ? mkDim(
          results.security.overallScore,
          results.security.summary,
          results.security.findings.filter(f => f.severity === 'critical').map(f => f.description),
        )
      : undefined,
    scalability: results.scalability
      ? mkDim(
          results.scalability.overallScore,
          results.scalability.summary,
          results.scalability.bottlenecks.map(b => `${b.component}: ${b.failureMode}`),
        )
      : undefined,
    completeness: results.completeness
      ? mkDim(
          results.completeness.overallScore,
          results.completeness.summary,
          results.completeness.missingAreas.filter(a => a.severity === 'critical').map(a => a.area),
        )
      : undefined,
    consistency: results.consistency
      ? mkDim(
          results.consistency.overallScore,
          results.consistency.summary,
          results.consistency.contradictions.filter(c => c.severity === 'critical').map(c => c.claim_a.slice(0, 100)),
        )
      : undefined,
  };
}

/**
 * Format sub-agent results as a context block for the curator's main prompt.
 * This enriches the main generateObject call with sub-agent analysis.
 */
export function formatSubAgentSummary(results: CuratorSubAgentResults): string {
  const sections: string[] = [];

  if (results.security) {
    const criticals = results.security.findings.filter(f => f.severity === 'critical');
    sections.push(`SECURITY (score: ${results.security.overallScore}/100)
Critical issues: ${criticals.length}
${criticals.map(f => `  • ${f.description}`).join('\n')}
Summary: ${results.security.summary}`);
  }

  if (results.scalability) {
    const spofs = results.scalability.bottlenecks.filter(b => b.priority === 'immediate');
    sections.push(`SCALABILITY (score: ${results.scalability.overallScore}/100)
Immediate bottlenecks: ${spofs.length}
${spofs.map(b => `  • ${b.component}: ${b.failureMode}`).join('\n')}
Summary: ${results.scalability.summary}`);
  }

  if (results.completeness) {
    const critical = results.completeness.missingAreas.filter(a => a.severity === 'critical');
    sections.push(`COMPLETENESS (score: ${results.completeness.overallScore}/100)
Critical gaps: ${critical.length}
${critical.map(a => `  • ${a.area}: ${a.whyItMatters}`).join('\n')}
Summary: ${results.completeness.summary}`);
  }

  if (results.consistency) {
    const critCont = results.consistency.contradictions.filter(c => c.severity === 'critical');
    sections.push(`CONSISTENCY (score: ${results.consistency.overallScore}/100)
Critical contradictions: ${critCont.length}
${critCont.map(c => `  • ${c.pillarsInvolved.join(' vs ')}: ${c.resolution}`).join('\n')}
Summary: ${results.consistency.summary}`);
  }

  return sections.length > 0
    ? `Sub-agent analysis (4 parallel reviewers, ${results.succeededCount}/4 completed):\n\n${sections.join('\n\n')}`
    : '';
}
