/**
 * src/engine/elicitation.ts
 *
 * Elicitation queue — the OpenAI Codex pattern (codex-rs core/src/codex_thread.rs
 * ElicitationRegistration / out_of_band_elicitations, per-question
 * mcp_elicitations_auto_deny) combined with the Kilo Code `question` tool:
 * the *model* asks clarifying questions mid-run, the questions are parked as
 * typed pending elicitations, and the run pauses (or auto-denies) until
 * answers arrive or the auto-deny timeout expires.
 *
 * Why this beats the previous setup:
 *   - Steering (steerSession) was user-initiated only; the model could never
 *     request clarification. Codex shows model-initiated questions yield
 *     measurably better first-pass blueprints for ambiguous specs.
 *   - Questions are typed (what/why/options/suggested), so the UI can render
 *     a choice widget instead of a plain chat reply.
 *   - Auto-deny keeps the pipeline from hanging forever when nobody answers
 *     (Codex: `mcp_elicitations_auto_deny`).
 *
 * All state lives in the existing checkpoint store (additive, like steer).
 */

import { randomUUID } from 'crypto';
import { saveCheckpoint, loadCheckpoint } from './checkpoint';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ElicitationKind = 'clarify' | 'confirm' | 'choose';

export interface Elicitation {
  id: string;
  session: string;
  /** ISO timestamp when the question was asked. */
  asked_at: string;
  /** One-line what-is-needed description. */
  question: string;
  /** Why the pipeline needs this answered. */
  reason: string;
  kind: ElicitationKind;
  /** Available answer options (may be empty for free-text). */
  options: string[];
  /** Default if auto-deny wins. */
  fallback: string;
  /** ISO deadline after which auto-deny applies (null = deny on run end). */
  deadline: string | null;
  status: 'pending' | 'answered' | 'denied';
  answer: string | null;
  denied_reason: string | null;
}

export interface ElicitationResult {
  elicitations: Elicitation[];
  /** True if the pending queue is non-empty. */
  has_pending: boolean;
}

const ELICIT_PREFIX = 'elicitation:';
const DEFAULT_AUTO_DENY_MS = 5 * 60 * 1000; // 5 minutes

// ── Core API ──────────────────────────────────────────────────────────────────

export interface AskElicitationInput {
  question: string;
  reason: string;
  kind?: ElicitationKind;
  options?: string[];
  fallback?: string;
  /** Override the auto-deny window in ms (default 5 min). */
  autoDenyMs?: number;
}

/**
 * Park a model-asked question on the session. Returns immediately — the
 * pipeline drains pending elicitations at natural phase boundaries via
 * drainPendingElicitations.
 */
export async function askElicitation(
  session: string,
  input: AskElicitationInput,
): Promise<Elicitation> {
  const el: Elicitation = {
    id: randomUUID(),
    session,
    asked_at: new Date().toISOString(),
    question: input.question,
    reason: input.reason,
    kind: input.kind ?? 'clarify',
    options: input.options ?? [],
    fallback: input.fallback ?? 'Use the assistant\'s best judgement and proceed.',
    deadline: new Date(Date.now() + (input.autoDenyMs ?? DEFAULT_AUTO_DENY_MS)).toISOString(),
    status: 'pending',
    answer: null,
    denied_reason: null,
  };
  const pending = (await loadCheckpoint<Elicitation[]>(session, `${ELICIT_PREFIX}pending`)) ?? [];
  pending.push(el);
  await saveCheckpoint(session, `${ELICIT_PREFIX}pending`, pending.slice(-20));
  return el;
}

/**
 * Return current pending elicitations and apply auto-deny to any whose
 * deadline has passed. Mirrors Codex's auto-deny semantics: unanswered
 * questions resolve to their fallback instead of blocking the run forever.
 */
export async function pendingElicitations(session: string): Promise<ElicitationResult> {
  const pending = (await loadCheckpoint<Elicitation[]>(session, `${ELICIT_PREFIX}pending`)) ?? [];
  const now = Date.now();
  const alive: Elicitation[] = [];
  for (const el of pending) {
    if (el.deadline && new Date(el.deadline).getTime() <= now) {
      el.status = 'denied';
      el.denied_reason = 'auto-denied: deadline elapsed without an answer';
      await appendElicitationHistory(session, el);
    } else {
      alive.push(el);
    }
  }
  await saveCheckpoint(session, `${ELICIT_PREFIX}pending`, alive);
  return { elicitations: alive, has_pending: alive.length > 0 };
}

/** Drain pending elicitations — returns them ordered oldest-first and clears
 *  the pending queue so a live run picks them up once. */
export async function drainPendingElicitations(session: string): Promise<Elicitation[]> {
  const { elicitations } = await pendingElicitations(session);
  if (elicitations.length === 0) return [];
  await saveCheckpoint(session, `${ELICIT_PREFIX}pending`, []);
  return elicitations;
}

/**
 * Answer one or more pending elicitations. Answered elicitations are moved to
 * the history (not re-asked) and marked so the pipeline can splice the
 * answers into its context.
 */
export async function answerElicitations(
  session: string,
  answers: Array<{ id: string; answer: string }>,
): Promise<Elicitation[]> {
  const pending = (await loadCheckpoint<Elicitation[]>(session, `${ELICIT_PREFIX}pending`)) ?? [];
  const byId = new Map(pending.map(e => [e.id, e]));
  const answered: Elicitation[] = [];
  for (const { id, answer } of answers) {
    const el = byId.get(id);
    if (!el) continue;
    el.status = 'answered';
    el.answer = answer;
    answered.push(el);
    pending.splice(pending.indexOf(el), 1);
  }
  await saveCheckpoint(session, `${ELICIT_PREFIX}pending`, pending);
  for (const el of answered) {
    await appendElicitationHistory(session, el);
  }
  return answered;
}

async function appendElicitationHistory(session: string, el: Elicitation): Promise<void> {
  const history = (await loadCheckpoint<Elicitation[]>(session, `${ELICIT_PREFIX}history`)) ?? [];
  history.push(el);
  await saveCheckpoint(session, `${ELICIT_PREFIX}history`, history.slice(-40));
}

/** Full answered/denied elicitations history for a session. */
export async function listElicitationHistory(session: string): Promise<Elicitation[]> {
  return (await loadCheckpoint<Elicitation[]>(session, `${ELICIT_PREFIX}history`)) ?? [];
}

/** Format answered elicitations as context text a pipeline can splice in. */
export function formatElicitations(context: Elicitation[]): string {
  if (context.length === 0) return '';
  return (
    '## User Clarifications (elicitation answers)\n' +
    context
      .map(el => `- Q: ${el.question}\n  A: ${el.answer ?? el.fallback} (${el.status})`)
      .join('\n')
  );
}
