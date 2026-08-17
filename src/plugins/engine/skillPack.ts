/**
 * src/plugins/engine/skillPack.ts
 *
 * Atomic Skill Pack generator (the "run anywhere" bridge).
 *
 * Codex, Claude Code, OpenCode, and Kilo Code all consume the same universal
 * plugin denominators: SKILL.md (skills protocol), AGENTS.md (cwd-scoped
 * agent instructions), and .claude-plugin/plugin.json (Claude Code's plugin
 * manifest). OpenCode additionally honours AGENTS.md in the workspace root.
 *
 * This module renders Atomic's four pipelines as installable skill packs so
 * that Atomic's quality (7-pillar deliberation + verifier-repair loop) is
 * reproducible inside any of those systems.
 */
import type { EnginePluginManifest } from './schema';

export interface SkillPackFile {
  /** Relative path inside the skill pack directory, e.g. 'SKILL.md' */
  path: string;
  /** UTF-8 content */
  content: string;
}

export interface SkillPack {
  /** Pack identifier: 'atomic-blueprint' | 'atomic-feature' | 'atomic-tool' | 'atomic-agent' | 'atomic-all' */
  id: string;
  files: SkillPackFile[];
}

interface PipelineSkill {
  id: string;
  name: string;
  trigger: string;
  skillBody: string;
}

const PIPELINE_SKILLS: PipelineSkill[] = [
  {
    id: 'atomic-blueprint',
    name: 'Atomic Blueprint',
    trigger: 'Generate a software architecture blueprint',
    skillBody: `# Atomic Blueprint Pipeline

## Purpose
Produce a production-ready software architecture blueprint for any software system,
following Atomic's deliberative multi-agent protocol.

## Protocol (execute faithfully — do not skip stages)

### Stage 1 — Governor
1. Extract the user's intent from the request.
2. Sanitize the task: reject unsafe intents (malware, credential theft,
   destructive operations against third-party systems), normalize the scope,
   and classify the workload (system-design, migration, feature, tooling).
3. If the request is underspecified, ask the user targeted clarifying
   questions BEFORE proceeding. Do not guess silently.

### Stage 2 — Seven Parallel Pillars
Spawn seven specialist agents and run them in parallel, one per pillar:

| Pillar | Focus |
|---|---|
| Planning | Architecture decisions, module decomposition, tech stack |
| Production | Core implementation plan, data flow, algorithms |
| Edge Cases | Failure modes, error handling, boundary conditions |
| Integration | External systems, APIs, contracts, data migration |
| Security | Threat model, authn/authz, secrets, data protection |
| Quality | Testing strategy, observability, performance, reliability |
| Completeness | Documentation, deployment, runbooks, launch checklist |

Each pillar agent MUST follow this 5-step protocol:
1. **readMemory** — read relevant memory bank entries (if present).
2. **lookupPattern** — check the built-in pattern library for the pillar.
3. **reason** — deliberate internally before writing.
4. **writeDecision** — record decisions with rationale and trade-offs.
5. **flagConcern** — flag any unresolved risks or blockers for review.

### Stage 3 — Reviewer + Prosecutor
Every pillar output is reviewed by its dedicated Reviewer (checks quality,
completeness, adherence) and challenged by a Prosecutor (actively searches for
gaps, contradictions, and weak reasoning). Pillars that fail review are
rerun with targeted feedback.

### Stage 4 — Supreme Prosecutor
A cross-pillar pass hunts for inter-pillar gaps: contradictions between
pillars, unaddressed cross-cutting concerns, and silent assumptions.

### Stage 5 — Targeted Rerun Loop
Failed pillars rerun with explicit feedback. Maximum 3 iterations. Pillars
that still fail after 3 reruns ship their best output with flags attached.

### Stage 6 — Synthesizer
Merge all pillar outputs into ONE coherent blueprint with this exact shape:

1. Executive Summary
2. Architecture Overview (diagram description)
3. Module/Service Breakdown
4. Data Model & Storage
5. API Contracts
6. Security Model
7. Edge Cases & Failure Handling
8. Integration Points
9. Testing Strategy
10. Deployment & Infrastructure
11. Observability
12. Launch Checklist
13. Technical Debt & Follow-ups
14. Pillar Pros/Cons Trade-offs

### Stage 7 — Verifier-Repair Loop (quality gate, non-negotiable)
Before shipping, score the synthesized blueprint with the 4-role panel
(0–100 each): **Accuracy, Completeness, Actionability, Clarity**.
Weights: accuracy 0.35, completeness 0.25, actionability 0.25, clarity 0.15.
Re-normalise against the present roles.

- If composite >= 80 and must-fix blockers == 0: SHIP.
- Otherwise repair ONLY the weakest section(s) (lowest role scores first)
  and rescore. Max 3 repair rounds.
- On exhaustion, ship the highest-scoring round (ship_best).
- Flag any MUST-FIX items the user must resolve manually.

## Output rules
- Full Markdown, no placeholder tokens (TODO/XXX/TBD placeholders are rejected).
- Every section >= 150 words unless the blueprint is genuinely trivial.
- Token/cost accounting must be internally consistent.
- Never invent API endpoints or library names that do not exist.
`,
  },
  {
    id: 'atomic-feature',
    name: 'Atomic Feature Creator',
    trigger: 'Plan or design a software feature',
    skillBody: `# Atomic Feature Creator Pipeline

## Purpose
Turn a feature idea into a complete, implementation-ready feature specification.

## Protocol
1. **Pillars** — run the seven Atomic pillars in parallel scoped to the feature:
   planning, production, edge cases, integration, security, quality, completeness.
   Each pillar follows the 5-step protocol (readMemory, lookupPattern, reason,
   writeDecision, flagConcern).
2. **Reviewer + Prosecutor** — review and challenge each pillar output; rerun
   failed pillars with targeted feedback (max 3 iterations).
3. **Verifier-repair loop** — score the assembled spec with the 4-role panel
   (accuracy 0.35 / completeness 0.25 / actionability 0.25 / clarity 0.15).
   Pass threshold: composite >= 75 with zero must-fix blockers. Repair only the
   weakest sections; max 3 repair rounds; on exhaustion ship the best round.

## Spec shape
User story and acceptance criteria, UX flow, data model changes, API contracts,
edge cases, security considerations, testing plan, rollout strategy, and
telemetry/observability requirements. No placeholder tokens allowed.
`,
  },
  {
    id: 'atomic-tool',
    name: 'Atomic Tool Builder',
    trigger: 'Design an MCP tool, API tool, or utility',
    skillBody: `# Atomic Tool Builder Pipeline

## Purpose
Produce a production-ready tool specification (MCP tool, API endpoint, CLI
utility) with full implementation detail.

## Protocol
1. **Pillars** — run the seven Atomic pillars scoped to the tool: planning,
   production, edge cases, integration, security, quality, completeness.
2. **Reviewer + Prosecutor** — review/challenge; rerun failed pillars
   (max 3 iterations).
3. **Verifier-repair loop** — 4-role composite scoring (accuracy 0.35 /
   completeness 0.25 / actionability 0.25 / clarity 0.15), pass threshold 75,
   repair weakest sections, max 3 rounds, ship_best fallback.

## Spec shape
Tool name and intent, input schema (typed), output schema, error contracts,
side-effect and idempotency notes, auth/permission model, examples, and a
complete test matrix including adversarial inputs. No placeholder tokens.
`,
  },
  {
    id: 'atomic-agent',
    name: 'Atomic Agent Builder',
    trigger: 'Define an autonomous AI agent',
    skillBody: `# Atomic Agent Builder Pipeline

## Purpose
Define a complete autonomous agent: identity, goals, tools, guardrails, and
operational behaviour.

## Protocol
1. **Sub-agent fan-out** — spawn specialist sub-agents (persona/goals,
   toolset design, guardrails & permissions, memory strategy, failure
   recovery) with supervised parallel execution: each sub-task gets a derived
   abort signal so a cancelled parent cancels all children.
2. **Aggregation** — merge sub-agent outputs; resolve conflicts via a
   supervisor pass.
3. **Verifier-repair loop** — 4-role composite scoring (accuracy 0.35 /
   completeness 0.25 / actionability 0.25 / clarity 0.15), pass threshold 75,
   repair weakest sections, max 3 rounds, ship_best fallback.

## Definition shape
Agent identity and persona, goals and success criteria, toolset with
per-tool permission tiers (full-auto | ask | deny), guardrails and safety
policies, memory and context strategy, failure/retry behaviour, escalation
paths, and observability hooks. No placeholder tokens.
`,
  },
];

/** The four pipeline manifests for the registry (data-only; prompts live in
 *  SKILL.md bodies). */
export const PIPELINE_MANIFESTS: EnginePluginManifest[] = PIPELINE_SKILLS.map((s) => ({
  id: `builtin:${s.id}`,
  specVersion: '1.0.0',
  name: s.name,
  version: '2.3.0',
  description: `Atomic's ${s.name.toLowerCase()} pipeline, portable as a skill for Codex, Claude Code, OpenCode, and Kilo Code.`,
  author: 'Atomic',
  license: 'MIT',
  kind: 'skill',
  tags: ['atomic', 'pipeline', 'agent-system'],
  capabilities: [],
  skippable: false,
}));

function claudePluginManifest(id: string, name: string, description: string): string {
  const json = {
    $schema: 'https://claude.com/schemas/claude-plugin.v1.json',
    id,
    name,
    version: '2.3.0',
    description,
    author: 'Atomic',
    license: 'MIT',
    homepage: 'https://github.com/mohammedibrahim161914155/Atomic-August-2026',
    commands: [
      {
        name: `atomic-${id.split(':').pop()}`,
        description: `Run Atomic's ${name.toLowerCase()} pipeline (${description.slice(0, 80)}).`,
        prompt: { kind: 'SKILL', skill: name.toLowerCase() },
      },
    ],
    agents: [
      {
        name: id.split(':').pop(),
        description: `Atomic ${name.toLowerCase()} agent — 7-pillar deliberation with a verifier-repair quality loop.`,
      },
    ],
    hooks: [],
    mcpServers: [],
  };
  return JSON.stringify(json, null, 2) + '\n';
}

function agentsMd(name: string, _skillName: string): string {
  return `# Agent instructions for ${name}

This workspace carries Atomic's ${name} skill. When a user request matches the
skill's trigger, follow the protocol in \`SKILL.md\` end-to-end — the seven
pillars in parallel, Reviewer/Prosecutor passes, and the verifier-repair quality
gate (composite >= 80 for blueprints, >= 75 for features/tools/agents) are all
mandatory. Never ship output that fails the quality gate on the first pass;
repair the weakest sections and rescore (max 3 repair rounds).
`;
}

/** Build the skill pack for one pipeline, or `atomic-all` covering all four. */
export function generateSkillPack(id: string): SkillPack | null {
  if (id === 'atomic-all') {
    const files: SkillPackFile[] = [];
    files.push({
      path: 'README.md',
      content:
        `# Atomic Skill Pack (all pipelines)\n\n` +
        `Installable skill pack for Codex, Claude Code, OpenCode, and Kilo Code.\n\n` +
        `| Skill | Trigger |\n|---|---|\n` +
        PIPELINE_SKILLS.map((s) => `| ${s.name} | ${s.trigger} |`).join('\n') +
        `\n\nAdd this directory to your agent's skill path (Codex: \`codex --add-skills\`; ` +
        `Claude Code: register via the plugin manifest; OpenCode: drop in \`~/.config/opencode/skills/\`; ` +
        `Kilo Code: place under the repo's \`.claude/skills/\` or MCP skill config).\n`,
    });
    for (const s of PIPELINE_SKILLS) {
      files.push({ path: `skills/${s.id}/SKILL.md`, content: s.skillBody });
      files.push({ path: `skills/${s.id}/.claude-plugin/plugin.json`, content: claudePluginManifest(s.id, s.name, `Atomic's ${s.name.toLowerCase()} pipeline`) });
      files.push({ path: `skills/${s.id}/AGENTS.md`, content: agentsMd(s.name, s.id) });
    }
    return { id, files };
  }
  const skill = PIPELINE_SKILLS.find((s) => s.id === id);
  if (!skill) return null;
  const files: SkillPackFile[] = [
    { path: 'SKILL.md', content: skill.skillBody },
    {
      path: '.claude-plugin/plugin.json',
      content: claudePluginManifest(`builtin:${skill.id}`, skill.name, `Atomic's ${skill.name.toLowerCase()} pipeline`),
    },
    { path: 'AGENTS.md', content: agentsMd(skill.name, skill.id) },
    {
      path: 'README.md',
      content:
        `# ${skill.name}\n\n${skill.trigger}.\n\n` +
        `Part of Atomic's portable skill pack for Codex, Claude Code, OpenCode, and Kilo Code.\n`,
    },
  ];
  return { id, files };
}

export function listSkillPacks(): Array<{ id: string; name: string; trigger: string }> {
  return [
    ...PIPELINE_SKILLS.map((s) => ({ id: s.id, name: s.name, trigger: s.trigger })),
    { id: 'atomic-all', name: 'Atomic Skill Pack (all pipelines)', trigger: 'Any Atomic pipeline' },
  ];
}
