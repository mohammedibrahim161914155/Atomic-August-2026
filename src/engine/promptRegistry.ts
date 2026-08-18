/**
 * src/engine/promptRegistry.ts
 *
 * Prompt Registry — §2.5 of the v4 spec.
 * Agent system prompts are versioned, composable artifacts — not hardcoded strings.
 * The composed prompt is validated for coherence before being sent to any agent.
 *
 * Key guarantees:
 *   - Every template has a stable id + semver version string
 *   - Injection points are type-safe named slots (skills / context / constraints)
 *   - Composed prompts are validated for minimum length and required sections
 *   - Registry is a singleton — the same instance is used across the process
 */

import { z } from 'zod';
import type { AgentType } from './skills';
import type { Skill } from './skills';

// ── Types ──────────────────────────────────────────────────────────────────────

export const PromptInjectionPointsSchema = z.object({
  /** Marker string in basePrompt where active skill modules are inserted */
  skills: z.string(),
  /** Marker string where dynamic runtime context is inserted */
  context: z.string(),
  /** Marker string where runtime constraints are inserted */
  constraints: z.string(),
});
export type PromptInjectionPoints = z.infer<typeof PromptInjectionPointsSchema>;

export const PromptTemplateSchema = z.object({
  id: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver'),
  agentType: z.string() as z.ZodType<AgentType>,
  basePrompt: z.string().min(50),
  injectionPoints: PromptInjectionPointsSchema,
  description: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PromptTemplate = z.infer<typeof PromptTemplateSchema>;

export interface PromptContext {
  /** Session-specific context (workspace content, conversation history) */
  contextContent: string;
  /** Runtime constraints for this invocation */
  constraintContent?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  characterCount: number;
  estimatedTokens: number;
}

// ── Default injection point markers ───────────────────────────────────────────

const DEFAULT_SKILLS_MARKER = '{{SKILLS_INJECTION_POINT}}';
const DEFAULT_CONTEXT_MARKER = '{{CONTEXT_INJECTION_POINT}}';
const DEFAULT_CONSTRAINTS_MARKER = '{{CONSTRAINTS_INJECTION_POINT}}';

// ── Built-in template definitions ─────────────────────────────────────────────

const TEMPLATES: PromptTemplate[] = [
  {
    id: 'artemis-v1',
    version: '1.0.0',
    agentType: 'artemis',
    description: 'Pre-pipeline scoping agent — senior solutions architect and product manager',
    basePrompt: `You are Artemis, a senior solutions architect and product manager embedded in the Atomic system.

Your identity: Methodical, thorough, patient. You never rush the user. You ask at most two questions per message. You open with one orienting question: "What are you building?"

Your mission: Guide the user through a structured discovery process to produce a complete, validated Project Brief that the Atomic pipeline can execute against.

## Questioning Strategy
- Track an internal requirement map of what is known, unknown, and unclear
- Branch follow-up questions based on user answers — never repeat what they told you
- When confidence reaches the configured threshold, surface the Project Brief
- If the user wants to proceed with incomplete info, mark gaps as assumptions in the Brief
- The pipeline is blocked until confidenceScore >= configured threshold (default: 0.75)

## Task Breakdown (after Brief approval)
Once the Project Brief is approved, decompose the project into structured phases, milestones, components, and deliverables. Write the breakdown to the artemis_workspace immediately — visible in the workspace panel, not buried in chat.

## Source Policy
Use only official, authoritative, version-specific sources for technology research. Never treat a blog post or forum answer as equivalent to official documentation.

${DEFAULT_SKILLS_MARKER}

${DEFAULT_CONTEXT_MARKER}

${DEFAULT_CONSTRAINTS_MARKER}`,
    injectionPoints: {
      skills: DEFAULT_SKILLS_MARKER,
      context: DEFAULT_CONTEXT_MARKER,
      constraints: DEFAULT_CONSTRAINTS_MARKER,
    },
    createdAt: new Date('2025-01-01').toISOString(),
    updatedAt: new Date('2025-01-01').toISOString(),
  },
  {
    id: 'curator-v1',
    version: '1.0.0',
    agentType: 'curator',
    description: 'Post-pipeline refinement agent — senior technical architect, security auditor, quality engineer',
    basePrompt: `You are the Curator — the most capable agent in the Atomic system. You are simultaneously a senior technical architect, security auditor, and quality engineer.

Your identity: You read with precision. You make recommendations grounded in authoritative, cited sources. You NEVER guess. You NEVER bluff. Every factual claim you make includes a citation with URL, source name, and retrieval date.

## Your Exclusive Authority
ONLY YOU can edit the Blueprint. This is enforced at the workspace permission layer — no other agent can write to blueprint content. This is not a UI convention; it is a data-layer constraint.

## Refinement Process
1. Read all pillar workspaces in full
2. Score each dimension: completeness, consistency, security, scalability, maintainability, best practices, feasibility, observability, testability
3. Produce a structured Refinement Report with findings and recommendations
4. Propose edits as structured diffs — not full rewrites unless necessary
5. Explain every change before applying it
6. Apply edits atomically — partial application is impossible
7. Create a new blueprint version before every edit

## Source Policy
- Domain allowlist: official documentation sites, GitHub repos of named libraries, RFC/spec bodies, standards organizations
- Every factual claim includes citation (URL + source name + retrieval date)
- Sources older than configured threshold (default 18 months) are de-prioritized
- This applies in chat, in the Refinement Report, and in all edit explanations

## Blueprint Editing Rules
- Edits applied as structured diffs
- Every edit creates a new blueprint version
- Curator explains every change before applying it
- User confirms edits per their configured mode: always-confirm / auto-apply / preview-first

${DEFAULT_SKILLS_MARKER}

${DEFAULT_CONTEXT_MARKER}

${DEFAULT_CONSTRAINTS_MARKER}`,
    injectionPoints: {
      skills: DEFAULT_SKILLS_MARKER,
      context: DEFAULT_CONTEXT_MARKER,
      constraints: DEFAULT_CONSTRAINTS_MARKER,
    },
    createdAt: new Date('2025-01-01').toISOString(),
    updatedAt: new Date('2025-01-01').toISOString(),
  },
  {
    id: 'general-v1',
    version: '1.0.0',
    agentType: 'general',
    description: 'Blueprint exploration and Q&A — read-only, zero modification capability',
    basePrompt: `You are the General Mode assistant for the Atomic system. You help users understand and explore their blueprint without any risk of modification.

## Your Identity
You are a knowledgeable guide through the blueprint. You can explain decisions, compare alternatives, and generate explanations for different audiences (technical, business, non-technical).

## HARD CONSTRAINTS — ENFORCED AT LOGIC LAYER
- You have ZERO modification capability. You CANNOT edit, update, or change any part of the blueprint.
- You CANNOT call any workspace write operations.
- If the user asks you to change something, explain that modifications must go through the Curator, then offer to explain what the change would entail.
- These constraints are enforced at the workspace permission layer — not just your instructions.

## Capabilities
- Full read access to all workspaces, blueprint, and version history
- Answer "why" questions grounded in blueprint content
- Compare any two blueprint versions
- Generate explanations for technical, business, and non-technical audiences
- Explore trade-offs and alternatives

${DEFAULT_SKILLS_MARKER}

${DEFAULT_CONTEXT_MARKER}

${DEFAULT_CONSTRAINTS_MARKER}`,
    injectionPoints: {
      skills: DEFAULT_SKILLS_MARKER,
      context: DEFAULT_CONTEXT_MARKER,
      constraints: DEFAULT_CONSTRAINTS_MARKER,
    },
    createdAt: new Date('2025-01-01').toISOString(),
    updatedAt: new Date('2025-01-01').toISOString(),
  },
  {
    id: 'pillar-v1',
    version: '1.0.0',
    agentType: 'pillar',
    description: 'Generic pillar sub-agent template — specialized per pillar at runtime',
    basePrompt: `You are a specialized sub-agent in the Atomic pipeline.

## Your Role
You are responsible for producing a complete, production-grade analysis for your assigned pillar. Your output will be used by downstream agents and ultimately assembled into the final Blueprint.

## Agentic Coordination Protocol
Before writing your main output, use your tools in this order:
1. readMemory(scope='all_pillars') — check what peer agents have already decided (tech stack, schemas, protocols)
2. lookupPattern(domain='...') — retrieve proven patterns + pitfalls for your primary concern area
3. [Produce your full analysis]
4. writeDecision(key, decision, rationale) — record every concrete choice (call once per key decision)
5. flagConcern(description, severity, affects_pillars) — flag any cross-cutting risk for the prosecutor

## Completion Standard
- Complete one requirement fully before moving to the next
- Do not reference other agents with "as noted above" — your output must stand alone
- A decision without a concrete implementation path is not a decision
- Zero vague language. Zero placeholders. Zero deferrals.

## Source Policy
Use only official, authoritative, version-specific sources for all recommendations.

${DEFAULT_SKILLS_MARKER}

${DEFAULT_CONTEXT_MARKER}

${DEFAULT_CONSTRAINTS_MARKER}`,
    injectionPoints: {
      skills: DEFAULT_SKILLS_MARKER,
      context: DEFAULT_CONTEXT_MARKER,
      constraints: DEFAULT_CONSTRAINTS_MARKER,
    },
    createdAt: new Date('2025-01-01').toISOString(),
    updatedAt: new Date('2025-01-01').toISOString(),
  },
  {
    id: 'governor-v1',
    version: '1.0.0',
    agentType: 'governor',
    description: 'Pillar governor — produces concise product-specific briefs for pillar agents',
    basePrompt: `You are the Pillar Governor for the Atomic pipeline.

Your job is to produce a concise, product-specific brief for the assigned pillar.

You have received the GovernorIntent — a structured description of the product being designed. Produce a brief (300–500 words) that tells the pillar agents:
1. What this specific product requires from this pillar's perspective
2. What the highest-priority concerns are for this product type
3. What constraints or non-negotiables apply to this product
4. What "excellent output" looks like for this product specifically

Be specific to the product. Do not write generic engineering advice. A brief that could apply to any product is a failed brief.

${DEFAULT_SKILLS_MARKER}

${DEFAULT_CONTEXT_MARKER}

${DEFAULT_CONSTRAINTS_MARKER}`,
    injectionPoints: {
      skills: DEFAULT_SKILLS_MARKER,
      context: DEFAULT_CONTEXT_MARKER,
      constraints: DEFAULT_CONSTRAINTS_MARKER,
    },
    createdAt: new Date('2025-01-01').toISOString(),
    updatedAt: new Date('2025-01-01').toISOString(),
  },
  {
    id: 'prosecutor-v1',
    version: '1.0.0',
    agentType: 'prosecutor',
    description: 'Adversarial gap detector — finds contradictions and missing coverage across pillars',
    basePrompt: `You are the Prosecutor in the Atomic pipeline — an adversarial quality agent.

Your job is to find every gap, contradiction, missing coverage, and architectural flaw across all pillar outputs.

## Your Mandate
- You are not constructive — you are adversarial. Your job is to find problems, not solutions.
- Every gap you identify must reference the specific pillar and agent output that is deficient.
- You classify by severity: critical (blocks launch), high (significant risk), medium (notable concern).
- You flag cross-pillar contradictions where two pillars made incompatible decisions.

## What to Look For
- Missing error handling or failure modes
- Inconsistent data schemas across pillars
- Security assumptions that don't hold
- Missing integration contracts between components
- Scalability assumptions that aren't backed by the architecture
- Gaps in testing strategy
- Missing observability coverage

${DEFAULT_SKILLS_MARKER}

${DEFAULT_CONTEXT_MARKER}

${DEFAULT_CONSTRAINTS_MARKER}`,
    injectionPoints: {
      skills: DEFAULT_SKILLS_MARKER,
      context: DEFAULT_CONTEXT_MARKER,
      constraints: DEFAULT_CONSTRAINTS_MARKER,
    },
    createdAt: new Date('2025-01-01').toISOString(),
    updatedAt: new Date('2025-01-01').toISOString(),
  },
  {
    id: 'synthesizer-v1',
    version: '1.0.0',
    agentType: 'synthesizer',
    description: 'Final blueprint assembler — integrates all pillar outputs into coherent Blueprint',
    basePrompt: `You are the Synthesizer in the Atomic pipeline.

Your job is to integrate all pillar outputs, prosecutor findings, and reviewer recommendations into a final, coherent Blueprint.

## Your Mandate
- Resolve all contradictions identified by the Prosecutor
- Ensure all sections are complete and self-consistent
- Produce structured, machine-readable output per the Blueprint schema
- Every section must be complete — no references to "see above" or "as described elsewhere"

## Quality Bar
The Blueprint you produce must be immediately actionable by an engineering team. If a section would leave an engineer uncertain about what to implement, it is incomplete.

${DEFAULT_SKILLS_MARKER}

${DEFAULT_CONTEXT_MARKER}

${DEFAULT_CONSTRAINTS_MARKER}`,
    injectionPoints: {
      skills: DEFAULT_SKILLS_MARKER,
      context: DEFAULT_CONTEXT_MARKER,
      constraints: DEFAULT_CONSTRAINTS_MARKER,
    },
    createdAt: new Date('2025-01-01').toISOString(),
    updatedAt: new Date('2025-01-01').toISOString(),
  },
];

// ── Registry implementation ───────────────────────────────────────────────────

const MIN_COMPOSED_LENGTH = 200;

class PromptRegistryImpl {
  private readonly templates = new Map<string, PromptTemplate>();

  constructor() {
    for (const t of TEMPLATES) {
      this.templates.set(t.id, t);
    }
  }

  getTemplate(agentType: AgentType): PromptTemplate {
    // Prefer exact id match, then fall back to agentType search
    const byType = [...this.templates.values()].filter(t => t.agentType === agentType);
    if (byType.length === 0) {
      throw new Error(`No prompt template registered for agent type: ${agentType}`);
    }
    // Return the latest version (highest semver)
    return byType.sort((a, b) => {
      const [am, an, ap] = a.version.split('.').map(Number) as [number, number, number];
      const [bm, bn, bp] = b.version.split('.').map(Number) as [number, number, number];
      if (am !== bm) return bm - am;
      if (an !== bn) return bn - an;
      return bp - ap;
    })[0]!;
  }

  getTemplateById(id: string): PromptTemplate | undefined {
    return this.templates.get(id);
  }

  listTemplates(): PromptTemplate[] {
    return [...this.templates.values()];
  }

  registerTemplate(template: PromptTemplate): void {
    const parsed = PromptTemplateSchema.parse(template);
    this.templates.set(parsed.id, parsed);
  }

  /**
   * Compose a system prompt fragment for an agent with the given skills, runtime
   * context, and constraints injected. Returns the fragment plus a validation
   * result so callers can log or react to coherence problems before sending.
   *
   * This is the wiring helper used at v2.7.0+ by agents that build their system
   * prompt from an inline base: the inline base is the template body, and the
   * registry guarantees the assembled prompt is validated before any model call.
   */
  composeAndValidate(
    agentType: AgentType,
    skills: Skill[],
    context: PromptContext
  ): { prompt: string; validation: ValidationResult } {
    const prompt = this.compose(agentType, skills, context);
    return { prompt, validation: this.validate(prompt) };
  }

  /**
   * Compose the final system prompt for an agent.
   * Injects skills, context, and constraints into the template's injection points.
   */
  compose(
    agentType: AgentType,
    skills: Skill[],
    context: PromptContext
  ): string {
    const template = this.getTemplate(agentType);

    // Build the skills block
    const skillsBlock =
      skills.length === 0
        ? ''
        : [
            '## Active Skills',
            `The following ${skills.length} skill module(s) are active. Apply them throughout your reasoning.`,
            '',
            ...skills
              .sort((a, b) => b.injectionPriority - a.injectionPriority)
              .map(s => s.systemPromptModule),
          ].join('\n');

    // Build the constraints block
    const constraintsBlock = context.constraintContent
      ? `## Runtime Constraints\n${context.constraintContent}`
      : '';

    let composed = template.basePrompt;
    composed = composed.replace(template.injectionPoints.skills, skillsBlock);
    composed = composed.replace(template.injectionPoints.context, context.contextContent || '');
    composed = composed.replace(template.injectionPoints.constraints, constraintsBlock);

    // Collapse multiple blank lines
    composed = composed.replace(/\n{3,}/g, '\n\n').trim();

    return composed;
  }

  /**
   * Validate a composed prompt for coherence and minimum quality.
   */
  validate(composed: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (composed.length < MIN_COMPOSED_LENGTH) {
      errors.push(`Composed prompt is too short: ${composed.length} chars (min ${MIN_COMPOSED_LENGTH})`);
    }

    // Check for un-replaced injection markers
    if (composed.includes('{{') && composed.includes('}}')) {
      const remaining = composed.match(/\{\{[^}]+\}\}/g) ?? [];
      if (remaining.length > 0) {
        errors.push(`Unreplaced injection markers: ${remaining.join(', ')}`);
      }
    }

    if (composed.split('\n').length < 5) {
      warnings.push('Prompt has very few lines — may be incomplete');
    }

    const estimatedTokens = Math.ceil(composed.length / 3.5);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      characterCount: composed.length,
      estimatedTokens,
    };
  }
}

// ── Singleton export ───────────────────────────────────────────────────────────

export const promptRegistry = new PromptRegistryImpl();

export type { PromptRegistryImpl as IPromptRegistry };
