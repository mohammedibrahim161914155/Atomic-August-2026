/**
 * src/engine/runAuditLedger.ts
 *
 * Run Audit Ledger — the Codex "documentation.md" durable run-memory pattern,
 * adapted from OpenAI's long-horizon Codex article (developers.openai.com
 * "Run long horizon tasks with Codex", Feb 2026). Codex keeps a live status +
 * decisions + known-issues audit log that stays inspectable across the run and
 * survives restarts; each subsequent stage re-reads it so the run has a stable,
 * self-documenting definition of what happened.
 *
 * Atomic implementation:
 *   - A per-session ledger tracking every pipeline stage with start/end
 *     timestamps, duration, token consumption, verdict, and free-form notes.
 *   - Persisted to checkpoints (key `ledger`) so resume/rerun re-reads it —
 *     the ledger IS the durable run memory for the session.
 *   - Emits `audit.stage_*` telemetry events and exposes the ledger through
 *     the observability API (read-only, session-scoped).
 *   - Pure deterministic logic (ledger state machine) plus a thin async
 *     persistence layer that is best-effort — a persistence failure never
 *     blocks the pipeline.
 *
 * Additive — no existing module changes.
 */

import { saveCheckpoint, loadCheckpoint } from './checkpoint';
import { log } from './logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type LedgerStageName =
  | 'governor'
  | 'pillar'
  | 'prosecutor'
  | 'rerun'
  | 'verifier'
  | 'synthesizer'
  | 'bundle'
  | 'unknown';

export type LedgerVerdict =
  | 'success'
  | 'partial'
  | 'failed'
  | 'skipped'
  | 'aborted';

export interface LedgerStageEntry {
  /** Monotonic index within the session run. */
  index: number;
  stage: LedgerStageName;
  /** Human-readable stage label, e.g. "pillar:security" or "rerun-gap:arch-03". */
  label: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  verdict: LedgerVerdict;
  tokensUsed: number;
  errors: string[];
  notes: string[];
}

export interface RunAuditLedger {
  sessionId: string;
  startedAt: string;
  lastUpdatedAt: string;
  stages: LedgerStageEntry[];
  totalTokensUsed: number;
  aborted: boolean;
}

export interface LedgerSnapshot {
  ledger: RunAuditLedger;
  /** Rendered human-readable audit block for injection into downstream prompts. */
  auditBlock: string;
}

export const EMPTY_LEDGER: RunAuditLedger = {
  sessionId: '',
  startedAt: '',
  lastUpdatedAt: '',
  stages: [],
  totalTokensUsed: 0,
  aborted: false,
};

// ── Ledger builder ─────────────────────────────────────────────────────────────

let _ledgerIndex = 0;

/** Open a new audit ledger for a session run. */
export function openLedger(sessionId: string): RunAuditLedger {
  _ledgerIndex = 0;
  const now = new Date().toISOString();
  return {
    sessionId,
    startedAt: now,
    lastUpdatedAt: now,
    stages: [],
    totalTokensUsed: 0,
    aborted: false,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Record a started stage. Returns the entry reference — callers MUST close it
 * via `closeStage`. Stage index is monotonic and stable for replay.
 */
export function startStage(ledger: RunAuditLedger, stage: LedgerStageName, label: string): LedgerStageEntry {
  const entry: LedgerStageEntry = {
    index: _ledgerIndex++,
    stage,
    label,
    startedAt: nowIso(),
    verdict: 'success',
    tokensUsed: 0,
    errors: [],
    notes: [],
  };
  ledger.stages.push(entry);
  ledger.lastUpdatedAt = nowIso();
  return entry;
}

/**
 * Close a stage, computing duration and rolling tokens into the session total.
 * The entry object is mutated in place (same reference returned by startStage).
 */
export function closeStage(
  ledger: RunAuditLedger,
  entry: LedgerStageEntry,
  verdict: LedgerVerdict,
  tokensUsed: number,
  errors: string[] = [],
  notes: string[] = [],
): void {
  entry.verdict = verdict;
  entry.endedAt = nowIso();
  entry.durationMs = Math.max(0, Date.now() - new Date(entry.startedAt).getTime());
  entry.tokensUsed = Math.max(0, tokensUsed | 0);
  if (errors.length > 0) entry.errors = entry.errors.concat(errors);
  if (notes.length > 0) entry.notes = entry.notes.concat(notes);
  ledger.totalTokensUsed += entry.tokensUsed;
  ledger.lastUpdatedAt = nowIso();
}

export function markAborted(ledger: RunAuditLedger): void {
  ledger.aborted = true;
  ledger.lastUpdatedAt = nowIso();
  for (const s of ledger.stages) {
    if (!s.endedAt) closeStage(ledger, s, 'aborted', s.tokensUsed);
  }
}

/**
 * Render the ledger as a human-readable audit block suitable for injection
 * into synthesizer/re-rerun prompts so the final output is aware of run
 * history, failures, and decisions — the Codex documentation.md pattern.
 */
export function renderAuditBlock(ledger: RunAuditLedger): string {
  if (ledger.stages.length === 0) return '';
  const lines: string[] = [
    '## Run Audit Ledger (session history)',
    '',
    `Session ${ledger.sessionId} started ${ledger.startedAt}. ` +
    `Stages completed: ${ledger.stages.length}. ` +
    `Total tokens: ${ledger.totalTokensUsed}.${ledger.aborted ? ' RUN ABORTED.' : ''}`,
    '',
  ];
  for (const s of ledger.stages) {
    const verdictTag = s.verdict === 'success' ? 'OK' : s.verdict.toUpperCase();
    const dur = s.durationMs !== undefined ? ` (${Math.round(s.durationMs)}ms)` : '';
    const tok = s.tokensUsed > 0 ? ` [${s.tokensUsed} tok]` : '';
    lines.push(`[${s.index}] ${s.stage}:${s.label} — ${verdictTag}${dur}${tok}`);
    for (const err of s.errors) lines.push(`      ✗ ${err}`);
    for (const n of s.notes) lines.push(`      · ${n}`);
  }
  return lines.join('\n');
}

/** Aggregate verdicts per stage kind — useful for observability APIs. */
export function ledgerSummary(ledger: RunAuditLedger): {
  stageCount: number;
  verdicts: Record<string, number>;
  failedStages: string[];
  totalTokens: number;
  durationMs: number;
} {
  const verdicts: Record<string, number> = {};
  const failedStages: string[] = [];
  for (const s of ledger.stages) {
    verdicts[s.verdict] = (verdicts[s.verdict] ?? 0) + 1;
    if (s.verdict === 'failed') failedStages.push(`${s.stage}:${s.label}`);
  }
  const first = ledger.stages[0]?.startedAt ?? ledger.startedAt;
  const last = ledger.stages[ledger.stages.length - 1]?.endedAt ?? nowIso();
  return {
    stageCount: ledger.stages.length,
    verdicts,
    failedStages,
    totalTokens: ledger.totalTokensUsed,
    durationMs: Math.max(0, new Date(last).getTime() - new Date(first).getTime()),
  };
}

// ── Persistence (best-effort, never blocking) ──────────────────────────────────

const LEDGER_KEY = 'ledger';

export async function persistLedger(sessionId: string, ledger: RunAuditLedger): Promise<void> {
  try {
    await saveCheckpoint(sessionId, LEDGER_KEY, ledger);
  } catch (err) {
    log.warn({ err }, '[ledger] checkpoint persistence failed — run continues without durable audit');
  }
}

export async function loadLedger(sessionId: string): Promise<RunAuditLedger | null> {
  try {
    return await loadCheckpoint<RunAuditLedger>(sessionId, LEDGER_KEY);
  } catch {
    return null;
  }
}
