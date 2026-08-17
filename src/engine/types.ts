import { z } from 'zod';

export type PillarName = 
  | 'planning' | 'production' | 'edge_cases' 
  | 'integration' | 'security' | 'quality' | 'completeness';

export const PILLAR_COUNT = 7;

export type { ModelConfig } from './config';

export interface AgentOutput {
  agent: string;
  content: string;
  tokens_used: number;
  status?: 'ok' | 'failed';
}

export const PillarProsecutorReportSchema = z.object({
  pillar: z.string(),
  verdict: z.enum(['pass', 'issues_found']),
  key_decisions: z.array(z.object({
    decision: z.string(),
    rationale: z.string(),
    affects_pillars: z.array(z.string())
  })),
  issues: z.array(z.object({
    severity: z.enum(['critical', 'high', 'medium']),
    agents_involved: z.array(z.string()),
    issue: z.string(),
    resolution: z.string()
  })),
  cross_pillar_flags: z.array(z.object({
    flag: z.string(),
    affects: z.array(z.string()),
    urgency: z.enum(['must_know', 'should_know'])
  }))
});

export type PillarProsecutorReport = z.infer<typeof PillarProsecutorReportSchema>;

export const PillarReviewerReportSchema = z.object({
  verdict: z.enum(['passes_quality_gate', 'needs_rework']),
  constructive_feedback: z.string(),
  critical_flaws: z.array(z.string())
});

export type PillarReviewerReport = z.infer<typeof PillarReviewerReportSchema>;

export interface PillarOutput {
  pillar: PillarName;
  agents: AgentOutput[];
  failed_agents: string[]; // names of agents that threw
  reviewer_report?: PillarReviewerReport;
  reverifier_issues: number;
  prosecutor_report?: PillarProsecutorReport;
  synthesizer_output?: string;
  summary: PillarSummary;
  // ■■ NEW: track ALL tokens for this pillar ■■
  tokens_reviewer: number; // 0 if reviewer failed/skipped
  tokens_prosecutor: number; // 0 if prosecutor failed/skipped
  tokens_synthesizer: number; // 0 if synthesizer failed/skipped
  tokens_total: number; // sum of all four sub-components
}

export type PillarOutputMap = Partial<Record<PillarName, PillarOutput>>;

export const ProsecutorResultSchema = z.object({
  gaps_found: z.number().optional(),
  gaps_resolved: z.number().optional(),
  verdict: z.enum(['approved', 'requires_revision']),
  gaps: z.array(z.object({
    id: z.string(),
    severity: z.enum(['critical', 'high', 'medium']),
    pillars_involved: z.array(z.string()),
    agents_involved: z.array(z.string()).optional(),
    description: z.string(),
    resolution: z.string()
  })).optional()
});

export type ProsecutorResult = z.infer<typeof ProsecutorResultSchema> & { tokens_used?: number };

export type ProsecutorGap = {
  id: string;
  severity: 'critical' | 'high' | 'medium';
  pillars_involved: string[];
  agents_involved?: string[];
  description: string;
  resolution: string;
};

export type GenerationMode = 'fast' | 'safe';

/** Which pipeline the user selected on the Landing page. */
export type PipelineType = 'blueprint' | 'feature-creator' | 'tool-builder' | 'agent-builder';

export interface SessionMeta {
  id: string;
  prompt: string;
  mode: GenerationMode;
  created_at: string;
  status: 'running' | 'complete' | 'partial';
  last_checkpoint: string | null;
  session_token?: string;
}

export const GovernorIntentSchema = z.object({
  product_name: z.string().min(1),
  domain: z.string().min(1),
  core_problem: z.string().min(1),
  target_users: z.string().min(1),
  key_features: z.array(z.string()).nonempty(),
  tech_constraints: z.array(z.string()),
  scale_assumptions: z.string().min(1),
  compliance_requirements: z.array(z.string()),
  integration_targets: z.array(z.string()),
  success_definition: z.string().min(1)
});

export type GovernorIntent = z.infer<typeof GovernorIntentSchema>;
  
export const PillarBriefSchema = z.object({
  requirements: z.array(z.string()),
  priority_concerns: z.array(z.string()),
  constraints: z.array(z.string()),
  success_criteria: z.array(z.string())
});

export type PillarBrief = z.infer<typeof PillarBriefSchema>;

export const PillarSummarySchema = z.object({
  decisions: z.array(z.object({
    feature: z.string(),
    rationale: z.string(),
    implementation_detail: z.string()
  })),
  schemas: z.array(z.object({
    name: z.string(),
    definition: z.string(),
    purpose: z.string()
  })),
  technical_constraints: z.array(z.string()),
  master_record_md: z.string()
});

export type PillarSummary = z.infer<typeof PillarSummarySchema>;

export interface HookifyRule {
  filename: string;  // e.g. "hookify.no-console-log.local.md"
  content: string;   // full file content including YAML frontmatter
}

export interface AgentDefinition {
  filename: string;  // e.g. "security-reviewer.md"
  content: string;   // full agent markdown with YAML frontmatter
}

export interface OutputBundle {
  claude_md: string;
  settings_json: string;
  hookify_rules: HookifyRule[];
  agent_definitions: AgentDefinition[];
  agents_md: string;
}

export const BlueprintSectionsSchema = z.object({
  executive_summary: z.string(),
  architecture: z.string(),
  data_model: z.string(),
  api_contracts: z.string(),
  security_model: z.string(),
  edge_cases: z.string(),
  testing_strategy: z.string(),
  deployment: z.string(),
  launch_checklist: z.string(),
  technical_debt: z.string()
});

export type BlueprintSections = z.infer<typeof BlueprintSectionsSchema>;

export const BlueprintSchema = z.object({
  id: z.string().uuid().or(z.string()),
  session_id: z.string().optional(),
  created_at: z.string(),
  prompt: z.string().min(1).max(10000),
  intent: GovernorIntentSchema,
  pillars: z.record(
    z.string(),
    z.object({
      pillar: z.string(),
      agents: z.array(z.object({
        agent: z.string(),
        content: z.string(),
        tokens_used: z.number(),
      })),
      failed_agents: z.array(z.string()),
      summary: PillarSummarySchema,
      synthesizer_output: z.string().optional(),
      prosecutor_report: PillarProsecutorReportSchema.optional(),
      tokens_total: z.number(),
      reverifier_issues: z.number().catch(0),
      tokens_reviewer: z.number().catch(0),
      tokens_prosecutor: z.number().catch(0),
      tokens_synthesizer: z.number().catch(0)
    }) // removed passthrough, using explicit props in interface + extra for flex
  ),
  prosecutor: ProsecutorResultSchema,
  quality_score: z.number(),
  quality_breakdown: z.object({
    sections: z.number(),
    pillars: z.number(),
    prosecutor: z.number(),
  }),
  total_tokens: z.number(),
  estimated_cost_usd: z.number().optional(),
  estimated_cost_approximate: z.boolean().optional(),
  generation_time_ms: z.number(),
  bundle: z.custom<OutputBundle>().optional(),
  sections: BlueprintSectionsSchema
});

export type Blueprint = z.infer<typeof BlueprintSchema>;

export type EngineEvent =
  | { type: 'session_start'; sessionId: string; mode: GenerationMode }
  | { type: 'resume_start'; sessionId: string; resumeFrom: string }
  | { type: 'rerun_start'; pillarName: string }
  | { type: 'rerun_complete'; sessionId: string; blueprint?: Blueprint }
  | { type: 'stage_start'; stage: string }
  | { type: 'stage_complete'; stage: string }
  | { type: 'checkpoint_saved'; key: string }
  | { type: 'governor_start'; prompt: string }
  | { type: 'governor_done'; intent: GovernorIntent }
  | { type: 'pillar_start'; pillar: PillarName; agents: string[] }
  | { type: 'agent_start'; pillar: PillarName; agent: string }
  | { type: 'agent_chunk'; pillar: PillarName; agent: string; chunk: string }
  | { type: 'agent_done'; pillar: PillarName; agent: string; preview: string }
  | { type: 'agent_tool_call'; pillar: PillarName; agent: string; tool: string; input: Record<string, unknown> }
  | { type: 'pillar_degraded'; pillar: PillarName; failed: string[] }
  | { type: 'reviewer_repair'; pillar: PillarName; agents_repaired: string[] } // FIX(2.1): new event — add to EngineEvent union in types.ts
  | { type: 'pillar_prosecuted'; pillar: PillarName }
  | { type: 'prosecutor_start' }
  | { type: 'prosecutor_done'; gaps_found: number; gaps: string[] }
  | { type: 'rerun_exhausted'; remaining_gaps: number }
  | { type: 'synthesizer_start' }
  | { type: 'synthesizer_done' }
  | { type: 'bundle_start' }
  | { type: 'bundle_done' }
  | { type: 'complete'; sessionId: string; blueprint?: Blueprint }
  | { type: 'stream_interrupted'; message: string; reqId?: string }
  | { type: 'error'; message: string; reqId?: string }
  | { type: 'request_id'; reqId: string }
  // ■■ Agentic Core v2.1 — composite verdict rounds (OpenDesign pattern) ■■
  | { type: 'verdict.round.start'; round: number; label?: string }
  | { type: 'verdict.issued'; round: number; verdict: string; composite: number; mustFix: number; policy?: string; label?: string }
  | { type: 'verdict.shipped'; round: number; composite: number; label?: string }
  | { type: 'verdict.repair.start'; round: number; label?: string }
  | { type: 'verdict.repair.done'; round: number; label?: string }
  | { type: 'verdict.final'; verdict: string; elected_round: number | null; label?: string }
  // ■■ Agentic Core v2.1 — plan mode (Codex pattern) ■■
  | { type: 'plan.created'; title: string; milestones: number }
  | { type: 'milestone.started'; key: string }
  | { type: 'milestone.passed'; key: string }
  | { type: 'milestone.failed'; key: string }
  // ■■ Agentic Core v2.1 — supervisor fan-out (Kimi/OpenCode pattern) ■■
  | { type: 'subagent.started'; subagent: string; parent?: string | null }
  | { type: 'subagent.done'; subagent: string; parent?: string | null }
  | { type: 'subagent.failed'; subagent: string; parent?: string | null; category?: string; message?: string }
  | { type: 'subagent.aborted'; subagent: string; parent?: string | null }
  // ■■ Agentic Core v2.1 — turn budgets (Codex pattern) ■■
  | { type: 'budget.warning'; budget_type: 'steps' | 'tokens'; label?: string; tokens_used?: number }
  | { type: 'budget.exceeded'; budget_type: 'steps' | 'tokens'; label?: string }
  | { type: 'step.done'; step: string; label?: string }
  | { type: 'step.failed'; step: string; label?: string; category?: string; message?: string }
  // ■■ Agentic Core v2.1 — snapshots + steering (Kilo pattern) ■■
  | { type: 'snapshot.captured'; stage: string; snapshotId: string }
  | { type: 'snapshot.restored'; snapshotId: string }
  | { type: 'steer.received'; message: string };

/** Human-readable verdict strings emitted by the agentic verdict engine. */
export type AgenticVerdict = 'ship' | 'repair' | 'fail';
