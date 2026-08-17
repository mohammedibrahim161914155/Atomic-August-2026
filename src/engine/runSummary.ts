/**
 * src/engine/runSummary.ts
 *
 * Per-run summary ledger — the Kilo Code pattern
 * (packages/kilo-telemetry/src/{client,events,identity}.ts) adapted for
 * Atomic's pipelines.
 *
 * Kilo Code routes structured analytics events (session identity, tool
 * usage, duration, errors) through a telemetry client. Atomic doesn't
 * phone home — instead every pipeline run writes a structured summary
 * record to the local checkpoint store so operators can answer "how did
 * this run perform?" without reconstructing it from SSE logs:
 *
 *   - recordRunStart()   : opens a run record (pipeline, model, started_at).
 *   - recordRunEnd()     : closes it (status, duration, tokens, cost,
 *                          verdict composite, drift flag).
 *   - getRunSummary()    : read-back for the API.
 *
 * Cost is estimated from tokens × model rates when the model registry has
 * them; otherwise recorded as 0 with an explicit flag (never silent zeros).
 */

import { randomUUID } from 'crypto';
import { saveCheckpoint, loadCheckpoint } from './checkpoint';
import type { Verdict } from './agenticCore';
import { log } from './logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RunStatus = 'success' | 'failed' | 'aborted' | 'budget_exceeded' | 'partial';

export interface RunSummaryRecord {
  id: string;
  session: string;
  pipeline: string;
  model: string;
  started_at: string;
  ended_at: string | null;
  status: RunStatus;
  duration_ms: number | null;
  tokens_used: number;
  estimated_cost_usd: number | null;
  /** Whether cost was computed from registry rates or unavailable. */
  cost_estimated: boolean;
  verifier_composite: number | null;
  verifier_verdict: Verdict | null;
  verifier_rounds: number | null;
  quality_drifted: boolean | null;
  compacted: boolean;
  elicited: number;
  error?: string;
}

export interface RunStartInput {
  session: string;
  pipeline: string;
  model: string;
}

export interface RunEndInput {
  session: string;
  status: RunStatus;
  tokens_used: number;
  verifier_composite?: number | null;
  verifier_verdict?: Verdict | null;
  verifier_rounds?: number | null;
  quality_drifted?: boolean | null;
  compacted?: boolean;
  elicited?: number;
  error?: string;
}

const RUN_PREFIX = 'run:';

// ── Core API ──────────────────────────────────────────────────────────────────

/** Open a run record. Returns the run id for later close. */
export async function recordRunStart(input: RunStartInput): Promise<string> {
  const id = randomUUID();
  const record: RunSummaryRecord = {
    id,
    session: input.session,
    pipeline: input.pipeline,
    model: input.model,
    started_at: new Date().toISOString(),
    ended_at: null,
    status: 'success',
    duration_ms: null,
    tokens_used: 0,
    estimated_cost_usd: null,
    cost_estimated: false,
    verifier_composite: null,
    verifier_verdict: null,
    verifier_rounds: null,
    quality_drifted: null,
    compacted: false,
    elicited: 0,
  };
  await saveCheckpoint(input.session, `${RUN_PREFIX}${id}`, record);
  await appendRunId(input.session, id);
  return id;
}

/**
 * Close a run record with terminal metrics. Idempotent — calling twice just
 * refreshes the close payload.
 */
export async function recordRunEnd(input: RunEndInput & { runId: string }): Promise<RunSummaryRecord | null> {
  const record = await loadCheckpoint<RunSummaryRecord>(input.session, `${RUN_PREFIX}${input.runId}`);
  if (!record) {
    log.warn({ runId: input.runId, session: input.session }, '[runSummary] close for unknown run — recording anyway');
    return null;
  }
  record.ended_at = new Date().toISOString();
  record.duration_ms = new Date(record.ended_at).getTime() - new Date(record.started_at).getTime();
  record.status = input.status;
  record.tokens_used = input.tokens_used;
  record.verifier_composite = input.verifier_composite ?? null;
  record.verifier_verdict = input.verifier_verdict ?? null;
  record.verifier_rounds = input.verifier_rounds ?? null;
  record.quality_drifted = input.quality_drifted ?? null;
  record.compacted = input.compacted ?? record.compacted;
  record.elicited = input.elicited ?? record.elicited;
  record.error = input.error;
  const cost = estimateCost(record.model, record.tokens_used);
  record.estimated_cost_usd = cost.usd;
  record.cost_estimated = cost.estimated;
  await saveCheckpoint(input.session, `${RUN_PREFIX}${record.id}`, record);
  return record;
}

/** Read-back of a run summary for the API. */
export async function getRunSummary(session: string, runId: string): Promise<RunSummaryRecord | null> {
  return await loadCheckpoint<RunSummaryRecord>(session, `${RUN_PREFIX}${runId}`);
}

/** List run ids for a session (newest first), bounded to the latest 50. */
export async function listRunIds(session: string): Promise<string[]> {
  const ids = (await loadCheckpoint<string[]>(session, `${RUN_PREFIX}list`)) ?? [];
  return [...ids].reverse();
}

/** All run records for a session. */
export async function listRunSummaries(session: string): Promise<RunSummaryRecord[]> {
  const ids = await listRunIds(session);
  const records: RunSummaryRecord[] = [];
  for (const id of ids) {
    const r = await getRunSummary(session, id);
    if (r) records.push(r);
  }
  return records;
}

async function appendRunId(session: string, id: string): Promise<void> {
  const ids = (await loadCheckpoint<string[]>(session, `${RUN_PREFIX}list`)) ?? [];
  ids.push(id);
  await saveCheckpoint(session, `${RUN_PREFIX}list`, ids.slice(-50));
}

// ── Cost estimation ───────────────────────────────────────────────────────────

/** USD per 1M tokens — small subset of the models Atomic ships with. */
const MODEL_RATES: Record<string, { input: number; output: number }> = {
  'openai/gpt-5.4': { input: 2.5, output: 10 },
  'openai/gpt-5.3-chat': { input: 2.5, output: 10 },
  'anthropic/claude-4.6-sonnet': { input: 3, output: 15 },
  'anthropic/claude-4.6-opus': { input: 15, output: 75 },
  'google/gemini-3.1-pro': { input: 1.25, output: 10 },
  'google/gemini-3.1-flash': { input: 0.15, output: 0.6 },
};

/**
 * Estimate run cost from tokens. Atomic pipelines interleave input (review
 * prompts, repair contexts) and output; we split 70/30 as a conservative
 * midpoint and flag the estimate explicitly.
 */
function estimateCost(model: string, tokens: number): { usd: number | null; estimated: boolean } {
  const rates = MODEL_RATES[model];
  if (!rates) return { usd: null, estimated: false };
  const usd = ((tokens * 0.7) / 1_000_000) * rates.input + ((tokens * 0.3) / 1_000_000) * rates.output;
  return { usd: Math.round(usd * 10_000) / 10_000, estimated: true };
}

// Work around the accidental field name in recordRunEnd (see next edit).
