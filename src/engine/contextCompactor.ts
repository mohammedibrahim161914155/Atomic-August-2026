/**
 * src/engine/contextCompactor.ts
 *
 * Context Auto-Compaction — the OpenAI Codex pattern (codex-rs core/src/
 * compact*.rs, token_budget.rs, context_window.rs) adapted for Atomic's
 * pipeline runs.
 *
 * Codex compact behaviour distilled from source:
 *   - Each turn tracks token usage; when the accumulated context exceeds a
 *     budget, the conversation history is summarised by the model and the
 *     summary replaces the pre-compaction history so the run continues
 *     without resetting.
 *   - A rollout budget is a hard cap that aborts the run before it overruns.
 *
 * Atomic implementation:
 *   - compactHistory() summarises a conversation (or history chunks) via the
 *     fast model into a dense "continuation summary" block.
 *   - CompactionDecision.decide() evaluates estimated vs. budgeted tokens and
 *     emits the canonical Codex decision tree: ok / warn / compact / abort.
 *   - compactIfNeeded() is the one-call helper pipelines use at each stage
 *     boundary: when the context exceeds the compact threshold, it compacts
 *     and returns the compacted text together with a "compacted_historyo
 *     preserved" marker so downstream agents know history was condensed.
 *
 * Additive — existing ContextWindowManager and ContextBudgetManager continue
 * to operate as before; this module adds the Codex-style *preemptive*
 * summarise-and-continue behaviour on top of the existing *reactive*
 * truncation.
 */

import { generateText } from './openrouter';
import type { ModelConfig } from './config';
import { estimateTokens } from './contextBudget';
import { log } from './logger';
import { withRetry } from './withRetry';

export type CompactionDecision =
  | { action: 'ok' }
  | { action: 'warn'; utilization: number }
  | { action: 'compact'; utilization: number }
  | { action: 'abort'; utilization: number };

export interface CompactionThresholds {
  /** Emit `context.warning` when utilisation exceeds this (Codex 80% warn). */
  warnAt?: number;
  /** Compact when utilisation exceeds this. */
  compactAt?: number;
  /** Abort outright when utilisation exceeds this (Codex hard rollout cap). */
  abortAt?: number;
}

/**
 * Decide what to do with the current context relative to the model's window.
 * Mirrors Codex turn/rollout budget guards: warn at 80%, compact at the
 * compaction threshold, abort at the hard cap.
 */
export function decideCompaction(
  usedTokens: number,
  capacity: number,
  thresholds: CompactionThresholds = {},
): CompactionDecision {
  if (capacity <= 0) return { action: 'ok' };
  const utilization = usedTokens / capacity;
  const warnAt = thresholds.warnAt ?? 0.8;
  const compactAt = thresholds.compactAt ?? 0.9;
  const abortAt = thresholds.abortAt ?? 0.98;
  if (utilization >= abortAt) return { action: 'abort', utilization };
  if (utilization >= compactAt) return { action: 'compact', utilization };
  if (utilization >= warnAt) return { action: 'warn', utilization };
  return { action: 'ok' };
}

const COMPACT_PROMPT = `You are the Atomic Conversation Compactor. You summarise conversation history
into a dense continuation summary so a pipeline agent can keep working after
compaction without losing latent state.

<rules>
- Preserve: user goals, product requirements, technical decisions already made,
  rejected options and why they were rejected, errors encountered and fixes,
  outstanding open questions.
- Compress: greetings, pleasantries, repeated information, verbose reasoning.
- Output between 300 and 900 words. Never invent details not present in the
  history. If the history is empty, output "No prior context."
</rules>
Output the summary as plain text now.`;

/** Summarise conversation history into a dense continuation summary. */
export async function compactHistory(
  history: string[],
  config: ModelConfig,
  signal?: AbortSignal,
): Promise<{ summary: string; tokens_used: number }> {
  if (history.length === 0) {
    return { summary: 'No prior context.', tokens_used: 0 };
  }
  const input = history.join('\n\n---\n\n').slice(0, 120_000);
  const { text, tokens_used } = await withRetry(
    async () =>
      generateText(input, config, COMPACT_PROMPT, {
        model: config.fastModel,
        max_tokens: 2048,
        signal,
      }),
    signal,
    'context-compaction',
  );
  return {
    summary: `## Compacted Continuation Summary\n${text}\n\n<compaction-note>Earlier conversation was compacted to preserve context window. The summary above preserves goals, decisions, rejections, and open questions.</compaction-note>`,
    tokens_used,
  };
}

export interface CompactIfNeededInput {
  /** Estimated tokens already consumed by this run (system + context + output reserve). */
  usedTokens: number;
  /** Model context window capacity. */
  capacity: number;
  /** The accumulated conversation text to potentially compact. */
  history: string[];
  config: ModelConfig;
  signal?: AbortSignal;
  thresholds?: CompactionThresholds;
}

export interface CompactIfNeededResult {
  decision: CompactionDecision;
  /** Context text to use after compaction (may equal joined history if no compaction). */
  context: string;
  /** Whether compaction was actually performed. */
  compacted: boolean;
  tokens_used: number;
}

/**
 * Evaluate the context budget and compact when the compact threshold is
 * crossed. Returns the usable context text plus the decision taken. History
 * compaction is idempotent for the caller — the summary replaces the
 * pre-compaction history exactly once per crossing.
 */
export async function compactIfNeeded(input: CompactIfNeededInput): Promise<CompactIfNeededResult> {
  const { usedTokens, capacity, history, config, signal, thresholds } = input;
  const decision = decideCompaction(usedTokens, capacity, thresholds);

  if (decision.action === 'compact') {
    const { summary, tokens_used } = await compactHistory(history, config, signal);
    if (signal?.aborted) {
      return { decision, context: '', compacted: false, tokens_used: 0 };
    }
    log.info(
      { utilization: decision.utilization, summaryTokens: estimateTokens(summary) },
      '[contextCompactor] context compacted — summary substituted for pre-compaction history',
    );
    return { decision, context: summary, compacted: true, tokens_used };
  }

  if (decision.action === 'warn') {
    log.warn({ utilization: decision.utilization }, '[contextCompactor] context utilisation warning');
  } else if (decision.action === 'abort') {
    log.error({ utilization: decision.utilization }, '[contextCompactor] context utilisation exceeded hard cap');
  }
  return { decision, context: history.join('\n\n---\n\n'), compacted: false, tokens_used: 0 };
}
