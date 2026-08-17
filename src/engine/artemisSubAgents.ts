/**
 * src/engine/artemisSubAgents.ts
 *
 * Artemis Parallel Sub-Agent Ensemble
 *
 * Four specialized sub-agents run simultaneously via Promise.all to produce a
 * richer, multi-dimensional Project Brief than any single model pass can achieve.
 *
 * Sub-agents:
 *   1. RequirementsExtractor   — Derives structured functional + non-functional requirements
 *   2. TechStackAdvisor        — Recommends an optimal technology stack with cited rationale
 *   3. TimelineEstimator       — Builds a phased delivery plan with risk-adjusted estimates
 *   4. RiskAssessor            — Identifies top project risks with mitigations + early warnings
 *
 * All four receive the same transcript + long-term memory context and run in parallel.
 * The caller (artemis.ts) synthesizes their outputs into the final ProjectBrief.
 *
 * Architecture:
 *   - Each sub-agent uses generateObject (structured Zod output) for precision
 *   - Uses the fastModel (cost-efficient) since each task is focused and bounded
 *   - Individual failures are isolated — a failed sub-agent returns null so the
 *     orchestrator can still produce a partial brief
 *   - All outputs are emitted as events for the DevPanel and observability
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { ModelConfig } from './config';
import { getModelForConfig } from './openrouter';
import { publishEvent } from './eventBus';
import { log } from './logger';
import { withRetry } from './withRetry';
import { randomUUID } from 'crypto';

// ── Sub-agent output schemas ──────────────────────────────────────────────────

// 1 — Requirements Extractor
const RequirementSchema = z.object({
  id:          z.string(),
  category:    z.enum(['functional', 'non-functional', 'constraint', 'assumption']),
  description: z.string(),
  priority:    z.enum(['must', 'should', 'could', 'wont']),
  confidence:  z.number().min(0).max(1).describe('How certain we are this requirement was stated vs assumed'),
  rationale:   z.string().optional(),
});

const RequirementsAnalysisSchema = z.object({
  requirements:     z.array(RequirementSchema),
  mvpScope:         z.array(z.string()).describe('Features explicitly in MVP scope'),
  deferredScope:    z.array(z.string()).describe('Features explicitly deferred to later phases'),
  implicitAssumptions: z.array(z.string()).describe('Things assumed true but never stated'),
  clarificationNeeded: z.array(z.string()).describe('Critical ambiguities that should be resolved'),
  requirementCount: z.object({
    must: z.number(), should: z.number(), could: z.number(), wont: z.number(),
  }),
});

export type RequirementsAnalysis = z.infer<typeof RequirementsAnalysisSchema>;

// 2 — Tech Stack Advisor
const TechChoiceSchema = z.object({
  name:       z.string(),
  version:    z.string().optional(),
  rationale:  z.string(),
  tradeoffs:  z.string(),
  popularity: z.enum(['standard', 'mainstream', 'emerging', 'niche']),
});

const TechStackAnalysisSchema = z.object({
  frontend:         z.array(TechChoiceSchema),
  backend:          z.array(TechChoiceSchema),
  database:         z.array(TechChoiceSchema),
  infrastructure:   z.array(TechChoiceSchema),
  devTools:         z.array(TechChoiceSchema),
  alternatives: z.array(z.object({
    component:   z.string(),
    recommended: z.string(),
    alternative: z.string(),
    whenToSwitch: z.string(),
  })),
  stackCohesionScore: z.number().min(0).max(100).describe('How well these choices work together (0-100)'),
  summary:            z.string(),
  warnings:           z.array(z.string()).describe('Stack-specific risks or anti-patterns to watch'),
});

export type TechStackAnalysis = z.infer<typeof TechStackAnalysisSchema>;

// 3 — Timeline Estimator
const DeliveryPhaseSchema = z.object({
  id:            z.string(),
  name:          z.string(),
  durationWeeks: z.number().int().min(1),
  team:          z.string().describe('Suggested team composition for this phase'),
  deliverables:  z.array(z.string()),
  risks:         z.array(z.string()),
  isParallelizable: z.boolean().describe('Can this phase overlap with the previous?'),
});

const TimelineAnalysisSchema = z.object({
  optimisticWeeks:  z.number().int().min(1).describe('Best case with no blockers'),
  realisticWeeks:   z.number().int().min(1).describe('Most likely outcome (P50)'),
  pessimisticWeeks: z.number().int().min(1).describe('Risk-adjusted worst case (P90)'),
  phases:           z.array(DeliveryPhaseSchema),
  criticalPath:     z.array(z.string()).describe('Phases or deliverables that gate everything else'),
  bufferRecommendation: z.string().describe('Recommended sprint/time buffer and why'),
  confidence:       z.number().min(0).max(1).describe('Confidence in these estimates given available info'),
  assumptions:      z.array(z.string()),
  summary:          z.string(),
});

export type TimelineAnalysis = z.infer<typeof TimelineAnalysisSchema>;

// 4 — Risk Assessor
const RiskSchema = z.object({
  id:           z.string(),
  title:        z.string(),
  category:     z.enum(['technical', 'business', 'operational', 'security', 'compliance', 'team', 'external']),
  probability:  z.enum(['low', 'medium', 'high']).describe('Likelihood this risk materialises'),
  impact:       z.enum(['low', 'medium', 'high', 'critical']).describe('Severity if it materialises'),
  description:  z.string(),
  mitigation:   z.string().describe('Proactive steps to reduce probability or impact'),
  contingency:  z.string().optional().describe('Reactive plan if the risk materialises'),
  earlyWarnings: z.array(z.string()).describe('Observable signals the risk is materialising'),
  owner:        z.string().optional().describe('Recommended role to own this risk'),
});

const RiskAnalysisSchema = z.object({
  risks:             z.array(RiskSchema),
  overallRiskLevel:  z.enum(['low', 'medium', 'high', 'critical']),
  topRisks:          z.array(z.string()).max(3).describe('IDs of the top 3 risks by severity × probability'),
  riskHeatmap: z.object({
    critical: z.number().describe('# of critical-impact risks'),
    high:     z.number(),
    medium:   z.number(),
    low:      z.number(),
  }),
  executiveSummary: z.string(),
});

export type RiskAnalysis = z.infer<typeof RiskAnalysisSchema>;

// ── Aggregated results ────────────────────────────────────────────────────────

export interface ArtemisSubAgentResults {
  requirements: RequirementsAnalysis | null;
  techStack:    TechStackAnalysis    | null;
  timeline:     TimelineAnalysis     | null;
  risks:        RiskAnalysis         | null;
  durationMs:   number;
  succeededCount: number;
}

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * Run all four Artemis sub-agents in parallel.
 * Each failure is isolated — the rest continue and the caller handles nulls.
 */
export async function runArtemisSubAgents(
  sessionId:         string,
  transcript:        string,
  longTermContext:   string,
  config:            ModelConfig,
  signal?:           AbortSignal,
): Promise<ArtemisSubAgentResults> {
  const t0      = Date.now();
  const model   = getModelForConfig(config, config.fastModel);
  const traceId = randomUUID();

  const context = [
    longTermContext ? `${longTermContext}\n\n` : '',
    `Project scoping conversation transcript:\n\n${transcript}`,
  ].join('');

  log.info({ sessionId, traceId }, '[artemis-sub] starting 4 parallel sub-agents');
  publishEvent('agent.tool_call_started', sessionId, traceId, {
    agent: 'ArtemisOrchestrator',
    tool:  'runSubAgents',
    input: { count: 4, phase: 'parallel_start' },
  });

  // ── Sub-agent 1: Requirements Extractor ─────────────────────────────────────

  const requirementsP = withRetry(async () => {
    const { object } = await generateObject({
      model,
      schema: RequirementsAnalysisSchema,
      system: `You are a Requirements Analyst sub-agent within the Artemis scoping system.
Your sole task: extract ALL requirements from the provided project scoping transcript.

Rules:
- Separate explicitly stated requirements from inferred ones (mark confidence < 0.7 for inferred)
- Use MoSCoW prioritization (must/should/could/wont) based on how the user described priority
- Distinguish functional requirements (what the system does) from non-functional (how well it does it)
- Flag every ambiguity as clarification_needed if it would affect architecture
- Never invent requirements — only extract and classify what is present in the transcript`,
      messages: [{ role: 'user', content: context }],
      maxOutputTokens: 2048,
      temperature: 0,
      abortSignal: signal,
    });
    return object;
  }, signal, 'artemis-requirements', { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 8000, jitterFactor: 0.3 })
    .catch((err: unknown) => {
      log.warn({ err, sessionId }, '[artemis-sub] requirements extractor failed');
      return null;
    });

  // ── Sub-agent 2: Tech Stack Advisor ─────────────────────────────────────────

  const techStackP = withRetry(async () => {
    const { object } = await generateObject({
      model,
      schema: TechStackAnalysisSchema,
      system: `You are a Tech Stack Advisor sub-agent within the Artemis scoping system.
Your sole task: recommend the optimal technology stack for this project.

Rules:
- Base recommendations on constraints explicitly stated in the transcript (language, platform, team skills, etc.)
- Prefer mainstream, well-documented technologies unless the project clearly calls for something specialized
- For each choice, give a honest tradeoff assessment — no stack is perfect
- Calculate stackCohesionScore: how well these technologies work together in production (0-100)
- Include at least one credible alternative for each major component with a clear migration trigger
- Warn about any emerging tech that may carry production risk
- Never recommend a technology you are not confident exists and is mature enough for production`,
      messages: [{ role: 'user', content: context }],
      maxOutputTokens: 2048,
      temperature: 0,
      abortSignal: signal,
    });
    return object;
  }, signal, 'artemis-techstack', { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 8000, jitterFactor: 0.3 })
    .catch((err: unknown) => {
      log.warn({ err, sessionId }, '[artemis-sub] tech stack advisor failed');
      return null;
    });

  // ── Sub-agent 3: Timeline Estimator ─────────────────────────────────────────

  const timelineP = withRetry(async () => {
    const { object } = await generateObject({
      model,
      schema: TimelineAnalysisSchema,
      system: `You are a Timeline Estimator sub-agent within the Artemis scoping system.
Your sole task: produce a realistic, risk-adjusted delivery timeline.

Rules:
- Provide three estimates: optimistic (P10), realistic (P50), pessimistic (P90)
- Break the timeline into logical phases with clear deliverables and team requirements
- Identify the critical path — tasks that directly gate the final delivery date
- Account for: team ramp-up, infrastructure setup, QA cycles, stakeholder review, and deployment
- Include explicit assumptions (e.g. "assumes a team of 4 engineers")
- Confidence should reflect how much information was provided — low confidence = wide range
- Never round to suspiciously clean numbers; real estimates have awkward fractions`,
      messages: [{ role: 'user', content: context }],
      maxOutputTokens: 2048,
      temperature: 0,
      abortSignal: signal,
    });
    return object;
  }, signal, 'artemis-timeline', { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 8000, jitterFactor: 0.3 })
    .catch((err: unknown) => {
      log.warn({ err, sessionId }, '[artemis-sub] timeline estimator failed');
      return null;
    });

  // ── Sub-agent 4: Risk Assessor ───────────────────────────────────────────────

  const risksP = withRetry(async () => {
    const { object } = await generateObject({
      model,
      schema: RiskAnalysisSchema,
      system: `You are a Risk Assessor sub-agent within the Artemis scoping system.
Your sole task: identify, classify, and provide mitigations for every significant project risk.

Rules:
- Assess risk across: technical, business, operational, security, compliance, team, and external categories
- Probability × Impact matrix: a high-probability/high-impact risk is ALWAYS critical
- For each risk: provide both a proactive mitigation and a reactive contingency plan
- earlyWarnings must be concrete and observable (e.g. "sprint velocity drops below 70% for 2 consecutive sprints")
- Don't manufacture generic risks — only include ones that are genuinely relevant to this specific project
- Flag any single point of failure as critical regardless of perceived probability`,
      messages: [{ role: 'user', content: context }],
      maxOutputTokens: 2048,
      temperature: 0,
      abortSignal: signal,
    });
    return object;
  }, signal, 'artemis-risks', { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 8000, jitterFactor: 0.3 })
    .catch((err: unknown) => {
      log.warn({ err, sessionId }, '[artemis-sub] risk assessor failed');
      return null;
    });

  // ── Await all in parallel ────────────────────────────────────────────────────

  const [requirements, techStack, timeline, risks] = await Promise.all([
    requirementsP, techStackP, timelineP, risksP,
  ]);

  const durationMs     = Date.now() - t0;
  const succeededCount = [requirements, techStack, timeline, risks].filter(Boolean).length;

  log.info(
    { sessionId, durationMs, succeededCount },
    `[artemis-sub] ${succeededCount}/4 sub-agents completed in ${durationMs}ms`,
  );

  publishEvent('agent.tool_call_completed', sessionId, traceId, {
    agent: 'ArtemisOrchestrator',
    tool:  'subAgentsComplete',
    input: { succeededCount, durationMs, phase: 'parallel_done' },
  });

  return { requirements, techStack, timeline, risks, durationMs, succeededCount };
}

// ── Context formatter for brief generation ────────────────────────────────────

/**
 * Format sub-agent results as a structured context block for the brief generator.
 * The brief generator receives this as additional grounding context.
 */
export function formatSubAgentContext(results: ArtemisSubAgentResults): string {
  const sections: string[] = [];

  if (results.requirements) {
    const r = results.requirements;
    sections.push(`== REQUIREMENTS ANALYSIS (${r.requirements.length} requirements extracted) ==
MVP scope: ${r.mvpScope.join(', ') || 'not defined'}
Deferred: ${r.deferredScope.join(', ') || 'none'}
Must-have requirements: ${r.requirements.filter(req => req.priority === 'must').map(req => req.description).join('; ')}
Implicit assumptions: ${r.implicitAssumptions.join('; ') || 'none'}
Needs clarification: ${r.clarificationNeeded.join('; ') || 'none'}`);
  }

  if (results.techStack) {
    const t = results.techStack;
    const stack = [
      t.frontend.map(c => c.name).join(', '),
      t.backend.map(c => c.name).join(', '),
      t.database.map(c => c.name).join(', '),
    ].filter(Boolean).join(' | ');
    sections.push(`== TECH STACK RECOMMENDATION (cohesion: ${t.stackCohesionScore}/100) ==
Stack: ${stack}
Summary: ${t.summary}
Warnings: ${t.warnings.join('; ') || 'none'}`);
  }

  if (results.timeline) {
    const t = results.timeline;
    sections.push(`== TIMELINE ESTIMATE ==
Realistic: ${t.realisticWeeks} weeks (optimistic: ${t.optimisticWeeks}w, pessimistic: ${t.pessimisticWeeks}w)
Phases: ${t.phases.map(p => `${p.name} (${p.durationWeeks}w)`).join(' → ')}
Critical path: ${t.criticalPath.join(' → ')}
Confidence: ${Math.round(t.confidence * 100)}%`);
  }

  if (results.risks) {
    const r = results.risks;
    const topRisks = r.risks.filter(risk => r.topRisks.includes(risk.id));
    sections.push(`== RISK ASSESSMENT (overall: ${r.overallRiskLevel}) ==
Top risks: ${topRisks.map(risk => `${risk.title} [${risk.probability}×${risk.impact}]`).join(', ')}
Heatmap: ${r.riskHeatmap.critical} critical, ${r.riskHeatmap.high} high, ${r.riskHeatmap.medium} medium, ${r.riskHeatmap.low} low`);
  }

  return sections.length > 0
    ? `Sub-agent analysis results (use to enrich the brief):\n\n${sections.join('\n\n')}`
    : '';
}
