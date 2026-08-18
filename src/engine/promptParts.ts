/**
 * src/engine/promptParts.ts
 *
 * Deterministic Prompt Layer Builder — adapted from the Codex prompt-construction
 * model (openai.com/index/unrolling-the-codex-agent-loop/ and the bytebytego
 * Codex architecture analysis, both Mar 2026). Codex's key lessons:
 *
 *   1. Prompts are assembled in a FIXED canonical layer order with role-based
 *      priority (system > developer > user). Any drift in ordering breaks
 *      prompt caching and degrades model attention.
 *   2. More specific instructions appear LATER in the user layer so they win
 *      attention over generic boilerplate.
 *   3. Layer composition must be pure and unit-testable — prompt assembly is
 *      first-class harness engineering, not an afterthought.
 *
 * Atomic implementation:
 *   - buildPromptParts() assembles a synthesis/repair prompt from typed layers
 *     in a single documented order: system → constraints → task context →
 *     memory bank → long-term memory → elicited clarifications → task.
 *   - The order is encoded in PART_ORDER and enforced by getPromptParts()
 *     (unit-tested). A layer may be absent, but present layers are always
 *     concatenated in canonical order.
 *   - addLayer() keeps layers unique per key — duplicates from repair rounds
 *     are replaced, never appended, so repetition does not grow context
 *     quadratically across verifier rounds.
 *
 * Additive — existing string-concatenation paths keep working; this module
 * provides the canonical builder for all repair/synthesis prompts.
 */

export type PromptPartKey =
  | 'system'
  | 'constraints'
  | 'context'
  | 'memory_bank'
  | 'long_term_memory'
  | 'elicitation'
  | 'audit_ledger'
  | 'task';

/** Canonical layer order — this is the contract enforced by getPromptParts(). */
export const PART_ORDER: readonly PromptPartKey[] = [
  'system',
  'constraints',
  'context',
  'memory_bank',
  'long_term_memory',
  'elicitation',
  'audit_ledger',
  'task',
] as const;

const LAYER_HEADERS: Record<PromptPartKey, string> = {
  system: '## System',
  constraints: '## Constraints',
  context: '## Task Context',
  memory_bank: '## Working Memory (this run)',
  long_term_memory: '## Long-Term Memory (past runs)',
  elicitation: '## User Clarifications',
  audit_ledger: '## Run Audit Ledger',
  task: '## Task',
};

export interface PromptParts {
  parts: Map<PromptPartKey, string>;
}

/** Create an empty parts builder. */
export function createPromptParts(): PromptParts {
  return { parts: new Map<PromptPartKey, string>() };
}

/**
 * Add or replace a layer. Replacement (not appending) keeps verifier repair
 * rounds from duplicating layers and blowing up the context budget.
 */
export function addLayer(parts: PromptParts, key: PromptPartKey, content: string): void {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    parts.parts.delete(key);
    return;
  }
  parts.parts.set(key, trimmed);
}

/** Render the parts in canonical order as a single prompt string. */
export function getPromptParts(parts: PromptParts): string {
  const blocks: string[] = [];
  for (const key of PART_ORDER) {
    const content = parts.parts.get(key);
    if (content) {
      blocks.push(`${LAYER_HEADERS[key]}\n\n${content}`);
    }
  }
  return blocks.join('\n\n');
}

/** Return an immutable snapshot of present layers (canonical order). */
export function getPartsSnapshot(parts: PromptParts): ReadonlyMap<PromptPartKey, string> {
  return parts.parts;
}

/** Return the ordered list of keys actually present (canonical order). */
export function presentKeys(parts: PromptParts): PromptPartKey[] {
  return PART_ORDER.filter(k => parts.parts.has(k));
}

/** Estimated tokens of the rendered prompt (1 token ≈ 4 chars heuristic). */
export function promptTokensEstimate(parts: PromptParts): number {
  return Math.ceil(getPromptParts(parts).length / 4);
}
