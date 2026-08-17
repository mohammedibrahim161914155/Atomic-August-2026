/**
 * src/engine/qualityLedger.ts
 *
 * Quality ledger + drift detection — the OpenDesign pattern
 * (apps/daemon/src/critique/{conformance,run-registry,ratchet}.ts) adapted
 * for Atomic's verifier loops.
 *
 * OpenDesign maintains a run registry of every critique run plus a ratchet
 * that prevents shipped quality from decaying release over release. Atomic
 * ships the same two primitives:
 *
 *   - recordVerifierRound()   : persist every verifier round (per-round
 *                               composite, mustFix, verdict) into a
 *                               session-scoped ledger in the checkpoint
 *                               store.
 *   - detectDrift()           : compare the current round against the
 *                               session's own historical best composite
 *                               (the "ratchet high-water mark"). A drop
 *                               below the ratchet minus a tolerance emits
 *                               `quality.drift` so the pipeline/operator
 *                               can see regressions before they ship.
 *
 * This turns the verifier from a one-shot gate into a longitudinal quality
 * instrument — the same way OpenDesign's conformance harness catches parser
 * warnings across the whole adapter matrix.
 */

import { randomUUID } from 'crypto';
import { saveCheckpoint, loadCheckpoint } from './checkpoint';
import type { RoleScore, Verdict } from './agenticCore';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QualityLedgerEntry {
  id: string;
  session: string;
  pipeline: string;
  round: number;
  composite: number;
  mustFix: number;
  verdict: Verdict;
  scores: RoleScore[];
  at: string;
}

export interface DriftReport {
  /** True if the current composite is below the ratchet high-water mark minus tolerance. */
  drifted: boolean;
  highWaterMark: number;
  current: number;
  tolerance: number;
  decline: number;
}

export interface LedgerQuery {
  session: string;
  pipeline: string;
}

const LEDGER_PREFIX = 'quality:';
const DEFAULT_DRIFT_TOLERANCE = 5;

// ── Ledger API ────────────────────────────────────────────────────────────────

/**
 * Append one verifier round to the session ledger. Entries are bounded to
 * the latest 100 per pipeline per session.
 */
export async function recordVerifierRound(input: {
  session: string;
  pipeline: string;
  round: number;
  composite: number;
  mustFix: number;
  verdict: Verdict;
  scores: RoleScore[];
}): Promise<QualityLedgerEntry> {
  const entry: QualityLedgerEntry = {
    id: randomUUID(),
    session: input.session,
    pipeline: input.pipeline,
    round: input.round,
    composite: input.composite,
    mustFix: input.mustFix,
    verdict: input.verdict,
    scores: input.scores,
    at: new Date().toISOString(),
  };
  const key = `${LEDGER_PREFIX}${input.pipeline}`;
  const ledger = (await loadCheckpoint<QualityLedgerEntry[]>(input.session, key)) ?? [];
  ledger.push(entry);
  await saveCheckpoint(input.session, key, ledger.slice(-100));
  return entry;
}

/** Retrieve all ledger entries for a session+pipeline. */
export async function listLedger(input: LedgerQuery): Promise<QualityLedgerEntry[]> {
  const ledger = await loadCheckpoint<QualityLedgerEntry[]>(input.session, `${LEDGER_PREFIX}${input.pipeline}`);
  return (ledger ?? []).sort((a, b) => a.round - b.round);
}

/**
 * The ratchet high-water mark: best composite ever recorded for this
 * session+pipeline. OpenDesign's ratchet refuses to regress below this; we
 * report drift instead of blocking, keeping the pipeline additive.
 */
export async function highWaterMark(input: LedgerQuery): Promise<number> {
  const ledger = await listLedger(input);
  if (ledger.length === 0) return 0;
  return Math.max(...ledger.map(e => e.composite));
}

/**
 * Compare the current round's composite against the session's ratchet.
 * drift = true when current < highWaterMark - tolerance AND the ledger has
 * at least one prior entry (no drift on the first round — nothing to
 * regress against).
 */
export function detectDrift(
  current: number,
  highWater: number,
  options: { tolerance?: number; priorEntries?: number } = {},
): DriftReport {
  const tolerance = options.tolerance ?? DEFAULT_DRIFT_TOLERANCE;
  const decline = Math.max(0, highWater - current);
  const drifted =
    options.priorEntries !== undefined && options.priorEntries > 0
      ? decline > tolerance
      : highWater > 0 && current < highWater - tolerance;
  return { drifted, highWaterMark: highWater, current, tolerance, decline };
}

/**
 * Evaluate drift against the persisted ledger — the one-call helper pipelines
 * use after recording a round.
 */
export async function evaluateDrift(
  input: LedgerQuery & { current: number; tolerance?: number },
): Promise<DriftReport> {
  const ledger = await listLedger(input);
  const priorEntries = ledger.length - 1; // current round not yet recorded if caller records after
  const highWater = await highWaterMark(input);
  return detectDrift(input.current, highWater, {
    tolerance: input.tolerance,
    priorEntries,
  });
}

/** Summary stats over the ledger (for API reporting). */
export function summarizeLedger(entries: QualityLedgerEntry[]): {
  rounds: number;
  bestComposite: number;
  lastComposite: number;
  averageComposite: number;
  shippedRounds: number;
} {
  if (entries.length === 0) {
    return { rounds: 0, bestComposite: 0, lastComposite: 0, averageComposite: 0, shippedRounds: 0 };
  }
  const composites = entries.map(e => e.composite);
  return {
    rounds: entries.length,
    bestComposite: Math.max(...composites),
    lastComposite: composites[composites.length - 1]!,
    averageComposite: Math.round(composites.reduce((s, c) => s + c, 0) / entries.length),
    shippedRounds: entries.filter(e => e.verdict === 'ship').length,
  };
}
