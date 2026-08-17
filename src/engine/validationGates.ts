/**
 * src/engine/validationGates.ts
 *
 * Output Validation Gates — §2.6 of the v4 spec.
 *
 * Before any agent commits output to its workspace, the output passes through
 * a validation gate registered for that workspace's schema.
 *
 * Failed validations:
 *   - Emit workspace.validation_failed events
 *   - Trigger the sub-agent's configured failure strategy
 *
 * Each gate has:
 *   - A schema validator (Zod-based)
 *   - A completeness scorer (0–1)
 *   - Quality flag detection
 *   - onFail strategy: 'retry' | 'flag' | 'block'
 */

import { z } from 'zod';
import { publishEvent } from './eventBus';

// ── Core types ────────────────────────────────────────────────────────────────

export type OnFailStrategy = 'retry' | 'flag' | 'block';

export interface QualityFlag {
  code: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  path?: string;
}

export interface ValidationError {
  path: string;
  message: string;
  received?: unknown;
}

export interface ValidationResult<T = unknown> {
  valid: boolean;
  parsed?: T;
  errors: ValidationError[];
  completenessScore: number; // 0–1
  qualityFlags: QualityFlag[];
}

export interface ValidationGate<T> {
  readonly id: string;
  readonly onFail: OnFailStrategy;
  readonly maxRetries: number;
  validate(output: unknown, sessionId?: string, traceId?: string): ValidationResult<T>;
}

// ── Helper: parse Zod errors ──────────────────────────────────────────────────

function zodErrorsToValidationErrors(err: z.ZodError): ValidationError[] {
  const issues = err.issues ?? (err as z.ZodError & { errors?: z.ZodIssue[] }).errors ?? [];
  return issues.map((e: z.ZodIssue) => ({
    path: e.path.join('.') || 'root',
    message: e.message,
    received: 'received' in e ? (e as z.ZodIssue & { received?: unknown }).received : undefined,
  }));
}

// ── Helper: completeness scorer ───────────────────────────────────────────────

/**
 * Score the completeness of a string field: penalises placeholder text and
 * empty values.
 */
function scoreField(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'string') {
    const v = value.trim();
    if (v.length === 0) return 0;
    // Penalise placeholder patterns
    const placeholders = ['TODO', 'TBD', 'PLACEHOLDER', 'NOT IMPLEMENTED', 'N/A', '...'];
    if (placeholders.some(p => v.toUpperCase().startsWith(p))) return 0.2;
    // Score by length — very short strings are likely incomplete
    if (v.length < 20) return 0.3;
    if (v.length < 100) return 0.6;
    return 1.0;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return 0.3;
    const fieldScores = value.map(scoreField);
    return fieldScores.reduce((a, b) => a + b, 0) / fieldScores.length;
  }
  if (typeof value === 'object') {
    const vals = Object.values(value as Record<string, unknown>);
    if (vals.length === 0) return 0.3;
    const fieldScores = vals.map(scoreField);
    return fieldScores.reduce((a, b) => a + b, 0) / fieldScores.length;
  }
  return 1.0;
}

function computeCompletenessScore(obj: Record<string, unknown>): number {
  const values = Object.values(obj);
  if (values.length === 0) return 0;
  const scores = values.map(scoreField);
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100;
}

// ── Quality flag detectors ────────────────────────────────────────────────────

function detectQualityFlags(output: unknown): QualityFlag[] {
  const flags: QualityFlag[] = [];

  function checkString(value: string, path: string): void {
    if (value.trim().length === 0) {
      flags.push({ code: 'EMPTY_FIELD', severity: 'warning', message: `Field is empty`, path });
    }
    if (/\bTODO\b|\bFIXME\b|\bHACK\b/i.test(value)) {
      flags.push({ code: 'TODO_FOUND', severity: 'warning', message: `Field contains TODO/FIXME marker`, path });
    }
    if (/placeholder|lorem ipsum/i.test(value)) {
      flags.push({ code: 'PLACEHOLDER_TEXT', severity: 'critical', message: `Field contains placeholder text`, path });
    }
    if (/as (described|noted|mentioned) (above|below|elsewhere)/i.test(value)) {
      flags.push({ code: 'SELF_REFERENCE', severity: 'warning', message: `Field self-references other sections instead of standing alone`, path });
    }
  }

  function walk(obj: unknown, path: string): void {
    if (typeof obj === 'string') {
      checkString(obj, path);
    } else if (Array.isArray(obj)) {
      obj.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (obj !== null && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  }

  walk(output, '');
  return flags;
}

// ── Generic schema-based gate factory ────────────────────────────────────────

function createSchemaGate<T>(
  id: string,
  schema: z.ZodType<T>,
  onFail: OnFailStrategy,
  maxRetries: number,
): ValidationGate<T> {
  return {
    id,
    onFail,
    maxRetries,
    validate(output: unknown, sessionId = 'unknown', traceId = 'unknown'): ValidationResult<T> {
      const result = schema.safeParse(output);

      if (!result.success) {
        const errors = zodErrorsToValidationErrors(result.error);
        const flags = detectQualityFlags(output);

        publishEvent(
          'workspace.validation_failed',
          sessionId,
          traceId,
          { gateId: id, errors, flags },
        );

        return {
          valid: false,
          errors,
          completenessScore: 0,
          qualityFlags: flags,
        };
      }

      const flags = detectQualityFlags(result.data);
      const criticalFlags = flags.filter(f => f.severity === 'critical');
      const completenessScore = computeCompletenessScore(
        typeof result.data === 'object' && result.data !== null
          ? (result.data as Record<string, unknown>)
          : { value: result.data }
      );

      publishEvent(
        'workspace.validated',
        sessionId,
        traceId,
        { gateId: id, completenessScore, flagCount: flags.length, criticalCount: criticalFlags.length },
      );

      return {
        valid: criticalFlags.length === 0,
        parsed: result.data,
        errors: criticalFlags.map(f => ({ path: f.path ?? '', message: f.message })),
        completenessScore,
        qualityFlags: flags,
      };
    },
  };
}

// ── Pillar output gate ────────────────────────────────────────────────────────

const PillarOutputGateSchema = z.object({
  pillar: z.string().min(1),
  agents: z.array(z.object({
    agent: z.string(),
    content: z.string().min(10),
    tokens_used: z.number().nonnegative(),
  })).min(1),
  failed_agents: z.array(z.string()),
  summary: z.object({
    master_record_md: z.string().min(10),
    decisions: z.array(z.object({
      feature: z.string(),
      rationale: z.string(),
      implementation_detail: z.string(),
    })),
    schemas: z.array(z.object({
      name: z.string(),
      definition: z.string(),
      purpose: z.string(),
    })),
    technical_constraints: z.array(z.string()),
  }),
  tokens_total: z.number().nonnegative(),
  reverifier_issues: z.number().nonnegative(),
  tokens_reviewer: z.number().nonnegative(),
  tokens_prosecutor: z.number().nonnegative(),
  tokens_synthesizer: z.number().nonnegative(),
});

export const pillarOutputGate = createSchemaGate(
  'pillar-output',
  PillarOutputGateSchema,
  'retry',
  2,
);

// ── Artemis workspace gate ────────────────────────────────────────────────────

export const ArtemisWorkspaceSchema = z.object({
  sessionId: z.string(),
  phase: z.enum(['questioning', 'brief_ready', 'approved', 'decomposing', 'complete']),
  messages: z.array(z.object({
    role: z.enum(['user', 'artemis']),
    content: z.string(),
    timestamp: z.string().datetime(),
  })),
  projectBrief: z.object({
    projectName: z.string().min(1),
    description: z.string().min(1),
    problemStatement: z.string().min(1),
    targetUsers: z.array(z.string()),
    techStack: z.object({
      frontend: z.array(z.string()).optional(),
      backend: z.array(z.string()).optional(),
      database: z.array(z.string()).optional(),
      infrastructure: z.array(z.string()).optional(),
      preferred: z.array(z.string()).optional(),
      excluded: z.array(z.string()).optional(),
    }),
    constraints: z.object({
      timeline: z.string().optional(),
      budget: z.string().optional(),
      teamSize: z.string().optional(),
      technical: z.array(z.string()).optional(),
      business: z.array(z.string()).optional(),
    }),
    taskBreakdown: z.object({
      phases: z.array(z.object({
        name: z.string(),
        description: z.string(),
        duration: z.string().optional(),
      })),
      milestones: z.array(z.object({
        name: z.string(),
        description: z.string(),
        phase: z.string().optional(),
      })),
      components: z.array(z.object({
        name: z.string(),
        description: z.string(),
        type: z.string().optional(),
      })),
      deliverables: z.array(z.object({
        name: z.string(),
        description: z.string(),
        acceptanceCriteria: z.string().optional(),
      })),
    }),
    successCriteria: z.array(z.string()),
    outOfScope: z.array(z.string()),
    openQuestions: z.array(z.string()),
    completedAt: z.string().datetime().optional(),
    artemisSessionId: z.string(),
    confidenceScore: z.number().min(0).max(1),
  }).optional(),
  confidenceScore: z.number().min(0).max(1),
  requirementMap: z.record(z.string(), z.string()),
  toolCallHistory: z.array(z.object({
    tool: z.string(),
    input: z.unknown(),
    output: z.unknown(),
    timestamp: z.string().datetime(),
  })),
  lastUpdated: z.string().datetime(),
});

export type ArtemisWorkspaceData = z.infer<typeof ArtemisWorkspaceSchema>;

export const artemisWorkspaceGate = createSchemaGate<ArtemisWorkspaceData>(
  'artemis-workspace',
  ArtemisWorkspaceSchema,
  'flag',
  1,
);

// ── Curator workspace gate ────────────────────────────────────────────────────

export const CuratorWorkspaceSchema = z.object({
  sessionId: z.string(),
  blueprintId: z.string(),
  phase: z.enum(['idle', 'analyzing', 'report_ready', 'editing', 'complete']),
  refinementReport: z.object({
    overallScore: z.object({
      value: z.number().min(0).max(100),
      label: z.string(),
    }),
    dimensions: z.record(z.string(), z.object({
      score: z.number().min(0).max(100),
      summary: z.string(),
      keyFindings: z.array(z.string()),
    })),
    findings: z.array(z.object({
      id: z.string(),
      severity: z.enum(['critical', 'warning', 'suggestion']),
      pillarId: z.string().optional(),
      description: z.string(),
      impact: z.string(),
      recommendation: z.string(),
      source: z.object({
        url: z.string(),
        title: z.string(),
        retrievedAt: z.string(),
      }).optional(),
    })),
    recommendations: z.array(z.object({
      id: z.string(),
      priority: z.enum(['critical', 'high', 'medium', 'low']),
      title: z.string(),
      description: z.string(),
      targetPillar: z.string().optional(),
    })),
    generatedAt: z.string().datetime(),
    sourcesConsulted: z.array(z.object({
      url: z.string(),
      title: z.string(),
      retrievedAt: z.string(),
    })),
    modelUsed: z.string(),
    tokenCount: z.number().nonnegative(),
  }).optional(),
  proposedEdits: z.array(z.object({
    id: z.string(),
    targetPath: z.string(),
    before: z.string(),
    after: z.string(),
    reason: z.string(),
    status: z.enum(['proposed', 'confirmed', 'applied', 'rejected']),
    createdAt: z.string().datetime(),
  })),
  messages: z.array(z.object({
    role: z.enum(['user', 'curator']),
    content: z.string(),
    timestamp: z.string().datetime(),
  })),
  lastUpdated: z.string().datetime(),
});

export type CuratorWorkspaceData = z.infer<typeof CuratorWorkspaceSchema>;

export const curatorWorkspaceGate = createSchemaGate<CuratorWorkspaceData>(
  'curator-workspace',
  CuratorWorkspaceSchema,
  'flag',
  1,
);

// ── Blueprint validation gate ─────────────────────────────────────────────────
// Enterprise-grade blueprint schema: requires every canonical section to be
// populated (no empty or placeholder content), provenance to be present,
// token accounting to be non-negative, and rejects outputs that contain
// unresolved placeholder tokens.
const PLACEHOLDER_RE = /\b(TBD|lorem ipsum|placeholder example|your[- ]app)\b/i;

const BlueprintGateSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1).optional(),
  created_at: z.string().min(1),
  prompt: z.string().min(1).max(10_000),
  intent: z
    .object({
      product_name: z.string().min(1),
      core_problem: z.string().min(1),
      key_features: z.array(z.string().min(1)).nonempty(),
    })
    .optional(),
  sections: z.object({
    executive_summary: z.string().min(50),
    architecture: z.string().min(50),
    data_model: z.string().min(20),
    api_contracts: z.string().min(20),
    security_model: z.string().min(20),
    edge_cases: z.string().min(20),
    testing_strategy: z.string().min(20),
    deployment: z.string().min(20),
    launch_checklist: z.string().min(10),
    technical_debt: z.string().min(10),
  }),
  prosecutor: z.object({ verdict: z.string() }).optional(),
  quality_score: z.number().min(0).max(100),
  total_tokens: z.number().nonnegative(),
  generation_time_ms: z.number().nonnegative(),
  pillars: z
    .record(
      z.string(),
      z.object({
        pillar: z.string().min(1),
        failed_agents: z.array(z.string()).optional(),
        tokens_total: z.number().nonnegative(),
      }),
    )
    .optional(),
}).refine(
  (bp) => {
    const text = [bp.prompt, bp.sections.executive_summary, bp.sections.architecture].join(' ');
    return !PLACEHOLDER_RE.test(text);
  },
  { message: 'Blueprint contains unresolved placeholder content' },
);

export const blueprintGate = createSchemaGate(
  'blueprint',
  BlueprintGateSchema,
  'retry',
  3,
);

// ── Exported gate registry ─────────────────────────────────────────────────────

export const VALIDATION_GATES = {
  pillarOutput: pillarOutputGate,
  artemisWorkspace: artemisWorkspaceGate,
  curatorWorkspace: curatorWorkspaceGate,
  blueprint: blueprintGate,
} as const;

export type GateId = keyof typeof VALIDATION_GATES;
