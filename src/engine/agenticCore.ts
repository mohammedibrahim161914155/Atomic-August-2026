/**
 * src/engine/agenticCore.ts
 *
 * Agentic Core v2.1 — shared primitives for all Atomic pipelines.
 *
 * This module consolidates the patterns found superior in the leading open
 * agentic systems and implemented here with real, working, production logic:
 *
 *  - OpenAI Codex  : turn/step loops with per-run token + step budgets,
 *                    retry-per-step with abort propagation, and verifier loops
 *                    that must validate-and-repair before advancing.
 *  - OpenCode      : per-tool-call error handling that feeds synthetic results
 *                    back to the model, plus parent-linked sub-agent sessions.
 *  - Kilo Code     : content-addressed stage snapshots with undo/restore
 *                    (every stage captures its state before it begins).
 *  - Kimi CLI      : supervisor-driven fan-out where partial failure triggers
 *                    autonomous re-planning instead of aborting the whole run.
 *  - OpenDesign    : role-weighted composite scoreboards with an explicit
 *                    ship / repair / fail verdict and configurable fallback
 *                    policy when convergence is never reached.
 *
 * All consumers are additive — existing pipeline behaviour is preserved.
 */

import { randomUUID } from 'crypto';
import { generateJson } from './openrouter';
import type { ModelConfig } from './config';
import { withRetry, classifyError } from './withRetry';
import { saveCheckpoint, loadCheckpoint } from './checkpoint';
import { log } from './logger';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Composite verdict engine (OpenDesign pattern)
// ─────────────────────────────────────────────────────────────────────────────

/** A score contributed by one reviewer role (e.g. Accuracy, Clarity). */
export interface RoleScore {
  role: string;
  /** 0–100 score for this role. */
  score: number;
  /** Weight for this role — normalised against the sum of present weights. */
  weight: number;
}

export type FallbackPolicy = 'fail' | 'ship_last' | 'ship_best';

export interface VerdictConfig {
  /** Composite score (0–100) required to ship. Default 80. */
  scoreThreshold?: number;
  /** Number of mustFix blockers allowed. Default 0. */
  maxMustFix?: number;
  /** Epsilon for float comparison (score within this of threshold counts). */
  epsilon?: number;
  /** What to do when max repair rounds are exhausted without shipping. */
  fallbackPolicy?: FallbackPolicy;
  /** Hard cap on repair/iteration rounds before escalation. */
  maxRounds?: number;
}

export type Verdict = 'ship' | 'repair' | 'fail';

export interface VerdictState {
  n: number;
  composite: number;
  mustFix: number;
  scores: RoleScore[];
}

/**
 * Role-weighted composite score. Absent roles contribute nothing; the weights
 * of present roles are re-normalised so a partial panel still scores fairly.
 */
export function computeComposite(scores: RoleScore[]): number {
  const present = scores.filter(s => s.score !== undefined && s.score !== null);
  if (present.length === 0) return 0;
  const totalWeight = present.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight < 1e-9) return 0;
  return present.reduce((sum, s) => sum + (s.weight / totalWeight) * s.score, 0);
}

/**
 * Applies the convergence rule: 'ship' when composite >= threshold (with
 * float epsilon) AND mustFix blockers are within tolerance; else 'repair'.
 */
export function decideVerdict(
  composite: number,
  mustFix: number,
  cfg: VerdictConfig,
): Verdict {
  const threshold = cfg.scoreThreshold ?? 80;
  const epsilon = cfg.epsilon ?? 1e-9;
  const maxMustFix = cfg.maxMustFix ?? 0;
  if (composite >= threshold - epsilon && mustFix <= maxMustFix) return 'ship';
  return 'repair';
}

/**
 * Selects the elected round state when no round achieved 'ship'.
 *  - fail      : no round is acceptable; caller must report failure.
 *  - ship_last : the most recent round ships regardless of its quality.
 *  - ship_best : the highest-composite round ships (ties broken by round
 *                number, i.e. most recent wins).
 */
export function selectFallbackRound(
  rounds: VerdictState[],
  policy: FallbackPolicy,
): VerdictState | null {
  if (rounds.length === 0) return null;
  if (policy === 'fail') return null;
  if (policy === 'ship_last') return rounds[rounds.length - 1] ?? null;
  let best: VerdictState | null = null;
  for (const r of rounds) {
    if (
      best === null ||
      r.composite > best.composite + 1e-9 ||
      (Math.abs(r.composite - best.composite) < 1e-9 && r.n > best.n)
    ) {
      best = r;
    }
  }
  return best;
}

/** Score a plain 0–100 value against the default roles (Codex/OpenDesign mix). */
export function roleScore(role: string, score: number, weight: number): RoleScore {
  return { role, score: Math.max(0, Math.min(100, score)), weight };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Turn runner with budgets (Codex pattern)
// ─────────────────────────────────────────────────────────────────────────────

export interface TurnBudget {
  /** Hard cap on steps within a single run. Default 64. */
  maxSteps?: number;
  /** Hard cap on estimated tokens consumed during the run. Default 400k. */
  maxTokens?: number;
}

export interface TurnStep<T> {
  key: string;
  /** Stable human-readable label used in events and logs. */
  label: string;
  /** The unit of work for this step. Receives per-step abort-safe execution. */
  run: (opts: { attempt: number; signal?: AbortSignal }) => Promise<T & { tokens_used?: number }>;
  /** Optional per-step verification. Return { ok, reason? } to pass/fail the step. */
  verify?: (result: T) => { ok: boolean; reason?: string };
}

export type TurnStatus = 'done' | 'aborted' | 'budget_exceeded' | 'failed';

export interface TurnOutcome<T = unknown> {
  status: TurnStatus;
  steps: number;
  tokens: number;
  results: Map<string, T>;
  failedStep?: string;
}

/** True when the run finished every step within budget. */
export function turnPassed<T = unknown>(outcome: TurnOutcome<T>): boolean {
  return outcome.status === 'done';
}

export type TurnEmitter = (event: { type: string; [k: string]: unknown }) => void;

/**
 * Execute a sequence of steps as one turn: each step is wrapped in
 * abort-safe, error-classified retry (withRetry), optional verification, and
 * per-run step/token budgets. Emits `budget.warning` at 80% and
 * `budget.exceeded` when a hard cap is hit, aborting gracefully.
 */
export async function runTurn<T = unknown>(
  steps: TurnStep<T>[],
  opts: {
    emit?: TurnEmitter | ((event: { type: string; [k: string]: unknown }) => void) | null;
    signal?: AbortSignal;
    budget?: TurnBudget;
    /** Label used in logs and event payloads. */
    label?: string;
  } = {},
): Promise<TurnOutcome<T>> {
  const { emit, signal, budget = {}, label = 'turn' } = opts;
  const emitFn = emit ?? null;
  const maxSteps = budget.maxSteps ?? 64;
  const maxTokens = budget.maxTokens ?? 400_000;

  const outcome: TurnOutcome<T> = {
    status: 'done',
    steps: 0,
    tokens: 0,
    results: new Map(),
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    outcome.steps += 1;
    if (signal?.aborted) { outcome.status = 'aborted'; return outcome; }
    if (outcome.steps >= maxSteps) {
      emitFn?.({ type: 'budget.exceeded', budget_type: 'steps', label });
      outcome.status = 'budget_exceeded';
      return outcome;
    }
    if (outcome.tokens >= maxTokens) {
      emitFn?.({ type: 'budget.exceeded', budget_type: 'tokens', label });
      outcome.status = 'budget_exceeded';
      return outcome;
    }
    if (outcome.tokens >= maxTokens * 0.8) {
      emitFn?.({ type: 'budget.warning', budget_type: 'tokens', label, tokens_used: outcome.tokens });
    }

    try {
      const result = await withRetry(
        async (attempt) => step.run({ attempt, signal }),
        signal,
        `${label}:${step.key}`,
      );
      outcome.tokens += result.tokens_used ?? 0;
      if (step.verify && !step.verify(result).ok) {
        log.warn({ step: step.key, label }, `[agenticCore] step verify failed — treating as step failure`);
        outcome.status = 'failed';
        outcome.failedStep = step.key;
        return outcome;
      }
      outcome.results.set(step.key, result);
      emitFn?.({ type: 'step.done', step: step.key, label });
    } catch (err: unknown) {
      if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        outcome.status = 'aborted';
        return outcome;
      }
      const category = classifyError(err);
      log.error({ err, step: step.key, category, label }, `[agenticCore] step failed after retries`);
      emitFn?.({ type: 'step.failed', step: step.key, label, category, message: err instanceof Error ? err.message : String(err) });
      outcome.status = 'failed';
      outcome.failedStep = step.key;
      return outcome;
    }
  }
  return outcome;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Stage snapshots with undo / restore (Kilo Code pattern)
// ─────────────────────────────────────────────────────────────────────────────

export interface StageSnapshot {
  id: string;
  session: string;
  stage: string;
  /** ISO timestamp when the snapshot was captured. */
  captured_at: string;
  /** Monotonically increasing sequence within the session. */
  sequence: number;
  /** Opaque, JSON-serialisable stage state (pipeline result slice). */
  body: unknown;
}

const SNAPSHOT_PREFIX = 'snap:';
const SNAPSHOT_LIST_PREFIX = 'snaps:';

/**
 * Capture the pre-stage state of a pipeline stage into the checkpoint store.
 * Snapshots are content-addressed per session and indexed for listing, so
 * any stage can be rolled back to its pre-stage state (undo).
 */
export async function captureStageSnapshot(
  session: string,
  stage: string,
  body: unknown,
): Promise<StageSnapshot> {
  const sequence = await nextSnapshotSequence(session);
  const snapshot: StageSnapshot = {
    id: randomUUID(),
    session,
    stage,
    captured_at: new Date().toISOString(),
    sequence,
    body,
  };
  await saveCheckpoint(session, `${SNAPSHOT_PREFIX}${snapshot.id}`, snapshot);
  await appendSnapshotId(session, snapshot.id);
  return snapshot;
}

async function nextSnapshotSequence(session: string): Promise<number> {
  const current = await loadCheckpoint<number>(session, 'snap:seq');
  const next = (current ?? 0) + 1;
  await saveCheckpoint(session, 'snap:seq', next);
  return next;
}

async function appendSnapshotId(session: string, id: string): Promise<void> {
  const ids = (await loadCheckpoint<string[]>(session, SNAPSHOT_LIST_PREFIX)) ?? [];
  ids.push(id);
  // Keep at most 50 snapshot ids per session to bound memory
  await saveCheckpoint(session, SNAPSHOT_LIST_PREFIX, ids.slice(-50));
}

export async function listStageSnapshots(session: string): Promise<StageSnapshot[]> {
  const ids = (await loadCheckpoint<string[]>(session, SNAPSHOT_LIST_PREFIX)) ?? [];
  const snapshots: StageSnapshot[] = [];
  for (const id of ids) {
    const snap = await loadCheckpoint<StageSnapshot>(session, `${SNAPSHOT_PREFIX}${id}`);
    if (snap) snapshots.push(snap);
  }
  return snapshots.sort((a, b) => a.sequence - b.sequence);
}

export async function getStageSnapshot(session: string, id: string): Promise<StageSnapshot | null> {
  return await loadCheckpoint<StageSnapshot>(session, `${SNAPSHOT_PREFIX}${id}`);
}

/** Roll back to the latest snapshot and return it (or null when none exist). */
export async function undoLatestStage(session: string): Promise<StageSnapshot | null> {
  const snaps = await listStageSnapshots(session);
  if (snaps.length === 0) return null;
  const latest = snaps[snaps.length - 1]!;
  // The snapshot IS the pre-stage state — callers merge `body` back into the
  // stage they are undoing. Remove the snapshot so a second undo rolls back
  // one step further, mirroring per-message revert semantics.
  await saveCheckpoint(session, `${SNAPSHOT_PREFIX}${latest.id}`, null);
  const ids = (await loadCheckpoint<string[]>(session, SNAPSHOT_LIST_PREFIX)) ?? [];
  await saveCheckpoint(session, SNAPSHOT_LIST_PREFIX, ids.filter(i => i !== latest.id));
  return latest;
}

/** Restore a specific snapshot by id without removing it (checkpoint jump). */
export async function restoreStageSnapshot(session: string, id: string): Promise<StageSnapshot | null> {
  return await getStageSnapshot(session, id);
}

/** Shortcut used by pipelines: capture, then return the prior state body. */
export async function captureAndPrior<T>(
  session: string,
  stage: string,
  body: unknown,
): Promise<{ snapshot: StageSnapshot; prior: T | null }> {
  const snapshot = await captureStageSnapshot(session, stage, body);
  const prior = await loadCheckpoint<T>(session, stage);
  return { snapshot, prior };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Sub-agent supervisor (Kimi + OpenCode pattern)
// ─────────────────────────────────────────────────────────────────────────────

export interface SubAgentResult<R = string> {
  id: string;
  parent: string | null;
  status: 'done' | 'failed' | 'aborted';
  result?: R;
  error?: string;
  tokens_used: number;
}

export interface SupervisorResult<R = string> {
  /** All sub-agent outcomes, preserving order. */
  results: SubAgentResult<R>[];
  /** Number of sub-agents that completed successfully. */
  succeeded: number;
  /** Number of sub-agents that failed or aborted. */
  failed: number;
}

export interface SubAgentTask<R = string> {
  key: string;
  /** The isolated unit of work. Its signal is derived from the parent abort. */
  run: (opts: { signal?: AbortSignal }) => Promise<R & { tokens_used?: number }>;
}

/**
 * Run a fan-out of isolated sub-agent tasks under one supervisor. Each task
 * receives its own derived abort signal (aborting the supervisor aborts all
 * pending tasks). Failures are contained per-task — a single flaky pillar
 * cannot abort the whole run; the supervisor aggregates outcomes so the
 * pipeline can autonomously re-plan around the failed tasks.
 */
export async function runSupervisor<R = string>(
  tasks: SubAgentTask<R>[],
  opts: {
    parent?: string | null;
    signal?: AbortSignal;
    emit?: ((event: { type: string; [k: string]: unknown }) => void) | null;
  } = {},
): Promise<SupervisorResult<R>> {
  const { parent = null, signal, emit } = opts;

  const outcomes = await Promise.all(
    tasks.map(async (task): Promise<SubAgentResult<R>> => {
      const derived = signal ? AbortSignal.any([signal]) : undefined;
      emit?.({ type: 'subagent.started', subagent: task.key, parent });
      try {
        const result = await withRetry(
          async (_attempt) => task.run({ signal: derived }),
          derived,
          `supervisor:${task.key}`,
        );
        emit?.({ type: 'subagent.done', subagent: task.key, parent });
        return {
          id: randomUUID(),
          parent,
          status: 'done',
          result: result as R,
          tokens_used: (result as { tokens_used?: number }).tokens_used ?? 0,
        };
      } catch (err: unknown) {
        if (signal?.aborted || derived?.aborted) {
          emit?.({ type: 'subagent.aborted', subagent: task.key, parent });
          return { id: randomUUID(), parent, status: 'aborted', tokens_used: 0 };
        }
        const category = classifyError(err);
        log.error({ err, task: task.key, category }, '[agenticCore] sub-agent failed');
        emit?.({ type: 'subagent.failed', subagent: task.key, parent, category, message: err instanceof Error ? err.message : String(err) });
        return {
          id: randomUUID(),
          parent,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          tokens_used: 0,
        };
      }
    }),
  );

  return {
    results: outcomes,
    succeeded: outcomes.filter(o => o.status === 'done').length,
    failed: outcomes.filter(o => o.status !== 'done').length,
  };
}

/** True when at least one sub-agent succeeded. */
export function supervisorPartialSuccess<R>(s: SupervisorResult<R>): boolean {
  return s.succeeded > 0;
}

/** True when every sub-agent succeeded. */
export function supervisorFullSuccess<R>(s: SupervisorResult<R>): boolean {
  return s.failed === 0 && s.results.length > 0;
}

/**
 * Build a re-plan from supervisor outcomes: returns the ids of sub-agents
 * that failed and should be retried in the next repair round, ordered by
 * original position. This is the autonomous mid-run re-planning hook.
 */
export function planRetry<R>(supervisor: SupervisorResult<R>): string[] {
  return supervisor.results
    .filter(r => r.status !== 'done')
    .map(r => r.id); // ids are stable within one supervisor invocation
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Verifier loop (Codex validate-then-repair + OpenDesign verdict rounds)
// ─────────────────────────────────────────────────────────────────────────────

export interface VerifierRound {
  n: number;
  composite: number;
  mustFix: number;
  scores: RoleScore[];
  verdict: Verdict;
}

export interface VerifierOptions<R = unknown> {
  cfg: VerdictConfig;
  /** One review/scoring pass. Must return roles + blocker count. */
  review: (round: number, candidate: R, signal?: AbortSignal) => Promise<{
    scores: RoleScore[];
    mustFix: number;
    tokens_used?: number;
  }>;
  /** Repair the candidate from the previous round's review. Return new candidate. */
  repair: (round: number, candidate: R, priorRound: VerifierRound, signal?: AbortSignal) => Promise<RepairResult<R>>;
  emit?: ((event: { type: string; [k: string]: unknown }) => void) | null;
  signal?: AbortSignal;
  label?: string;
}

export interface RepairResult<R> {
  candidate: R;
  tokens_used?: number;
}

export interface VerifierOutcome<R = unknown> {
  verdict: Verdict;
  elected: VerdictState | null;
  rounds: VerifierRound[];
  final: R;
  tokens_used: number;
}

/**
 * Run review → score → decide rounds until the candidate ships, or repair
 * rounds are exhausted. On exhaustion the configured fallback policy picks
 * the elected round (ship_best by default), mirroring OpenDesign's
 * critique-theater recovery modes.
 */
export async function runVerifier<R>(
  initial: R,
  opts: VerifierOptions<R>,
): Promise<VerifierOutcome<R>> {
  const { cfg, review, repair, emit, signal, label = 'verifier' } = opts;
  const maxRounds = cfg.maxRounds ?? 3;

  let candidate = initial;
  const rounds: VerifierRound[] = [];
  let tokens_used = 0;

  for (let n = 1; n <= maxRounds; n++) {
    if (signal?.aborted) break;
    emit?.({ type: 'verdict.round.start', round: n, label });
    const { scores, mustFix, tokens_used: t } = await review(n, candidate, signal);
    tokens_used += t ?? 0;
    const composite = computeComposite(scores);
    const verdict = decideVerdict(composite, mustFix, cfg);
    const round: VerifierRound = { n, composite, mustFix, scores, verdict };
    rounds.push(round);
    emit?.({ type: 'verdict.issued', round: n, verdict, composite: Math.round(composite), mustFix, policy: cfg.fallbackPolicy ?? 'ship_best', label });

    if (verdict === 'ship') {
      emit?.({ type: 'verdict.shipped', round: n, composite: Math.round(composite), label });
      return { verdict: 'ship', elected: round, rounds, final: candidate, tokens_used };
    }
    if (n < maxRounds) {
      emit?.({ type: 'verdict.repair.start', round: n + 1, label });
      const repaired = await repair(n, candidate, round, signal);
      candidate = repaired.candidate;
      tokens_used += repaired.tokens_used ?? 0;
      emit?.({ type: 'verdict.repair.done', round: n + 1, label });
    }
  }

  const elected = selectFallbackRound(rounds, cfg.fallbackPolicy ?? 'ship_best');
  const finalVerdict: Verdict = elected && cfg.fallbackPolicy !== 'fail' ? 'ship' : 'fail';
  emit?.({ type: 'verdict.final', verdict: finalVerdict, elected_round: elected?.n ?? null, label });
  return { verdict: finalVerdict, elected, rounds, final: candidate, tokens_used };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Plan mode (Codex plan mode pattern)
// ─────────────────────────────────────────────────────────────────────────────

export const PipelinePlanSchema = (() => {
  const MilestoneSchema = z.object({
    key: z.string().min(1),
    objective: z.string().min(10),
    acceptanceCriteria: z.array(z.string().min(5)).nonempty(),
    /** Optional validator hint the pipeline maps to a gate or prose check. */
    validator: z.enum(['schema', 'prose', 'custom']).default('prose'),
    status: z.enum(['planned', 'running', 'passed', 'failed', 'skipped', 'repaired']).default('planned'),
  });
  return z.object({
    title: z.string().min(1),
    summary: z.string().min(20),
    milestones: z.array(MilestoneSchema).min(1),
    risks: z.array(z.string().min(5)).default([]),
  });
})();

export type PipelinePlan = {
  title: string;
  summary: string;
  milestones: Array<{
    key: string;
    objective: string;
    acceptanceCriteria: string[];
    validator: 'schema' | 'prose' | 'custom';
    status: 'planned' | 'running' | 'passed' | 'failed' | 'skipped' | 'repaired';
  }>;
  risks: string[];
};

const PLAN_PROMPT = `You are the Atomic Planner — the planning intelligence behind plan-mode generation.
Decompose the user's request into a concrete, milestone-ordered execution plan.

<rules>
- Every milestone must have a specific, measurable objective (no vague "research" steps).
- Acceptance criteria must be concrete statements that can be checked after the milestone runs (start with "The output ..." or "It must ...").
- Risks must be specific to THIS request, not generic.
- Milestone keys must be short kebab-case identifiers, unique, and stable.
</rules>
Output the plan JSON now.`;

/**
 * Generate a PipelinePlan from a user prompt using the fast model. The plan
 * is a first-class artifact: it is stored as a checkpoint ('plan'), can be
 * amended by a steer request, and drives milestone events during execution.
 */
export async function generatePlan(
  prompt: string,
  config: ModelConfig,
  signal?: AbortSignal,
): Promise<PipelinePlan> {
  const { data } = await withRetry(
    async () =>
      generateJson<z.infer<typeof PipelinePlanSchema>>(
        prompt,
        config,
        PipelinePlanSchema,
        PLAN_PROMPT,
        { model: config.fastModel, max_tokens: 4096, signal },
      ),
    signal,
    'plan',
  );
  return data;
}

/** Store a plan under the session with versioning (plan, plan:v2, ...). */
export async function savePlan(session: string, plan: PipelinePlan): Promise<string> {
  const existing = await loadCheckpoint<PipelinePlan>(session, 'plan');
  const version = existing ? (await loadCheckpoint<number>(session, 'plan:version') ?? 1) + 1 : 1;
  await saveCheckpoint(session, 'plan', plan);
  await saveCheckpoint(session, `plan:v${version}`, plan);
  await saveCheckpoint(session, 'plan:version', version);
  return `v${version}`;
}

export const loadPlan = async (session: string): Promise<PipelinePlan | null> =>
  await loadCheckpoint<PipelinePlan>(session, 'plan');

// ─────────────────────────────────────────────────────────────────────────────
// 7. Mid-run steering (Codex pending-input + Kimi mid-flight correction)
// ─────────────────────────────────────────────────────────────────────────────

export interface SteerMessage {
  id: string;
  session: string;
  /** ISO timestamp. */
  at: string;
  message: string;
  applied: boolean;
}

const STEER_PREFIX = 'steer:';

/** Queue a course-correction message for a live pipeline run. */
export async function steerSession(session: string, message: string): Promise<SteerMessage> {
  const entry: SteerMessage = {
    id: randomUUID(),
    session,
    at: new Date().toISOString(),
    message,
    applied: false,
  };
  const pending = (await loadCheckpoint<SteerMessage[]>(session, `${STEER_PREFIX}pending`)) ?? [];
  pending.push(entry);
  await saveCheckpoint(session, `${STEER_PREFIX}pending`, pending.slice(-20));
  return entry;
}

/** Drain queued steer messages; returns them in order (oldest first). */
export async function drainSteerMessages(session: string): Promise<SteerMessage[]> {
  const pending = (await loadCheckpoint<SteerMessage[]>(session, `${STEER_PREFIX}pending`)) ?? [];
  if (pending.length === 0) return [];
  await saveCheckpoint(session, `${STEER_PREFIX}pending`, []);
  return pending;
}

/** Record steer messages that have been applied to the running pipeline. */
export async function markSteerApplied(session: string, ids: string[]): Promise<void> {
  const history = (await loadCheckpoint<SteerMessage[]>(session, `${STEER_PREFIX}history`)) ?? [];
  const pending = (await loadCheckpoint<SteerMessage[]>(session, `${STEER_PREFIX}pending`)) ?? [];
  const applied = pending.filter(m => ids.includes(m.id)).map(m => ({ ...m, applied: true }));
  await saveCheckpoint(session, `${STEER_PREFIX}pending`, pending.filter(m => !ids.includes(m.id)));
  await saveCheckpoint(session, `${STEER_PREFIX}history`, [...history, ...applied].slice(-40));
}

export async function listSteerHistory(session: string): Promise<SteerMessage[]> {
  return (await loadCheckpoint<SteerMessage[]>(session, `${STEER_PREFIX}history`)) ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Pipeline defaults registry (per-pipeline verdict + budget config)
// ─────────────────────────────────────────────────────────────────────────────

export interface PipelineDefaults {
  name: string;
  verdict: VerdictConfig;
  budget: TurnBudget;
}

export const PIPELINE_DEFAULTS: Record<string, PipelineDefaults> = {
  blueprint: {
    name: 'blueprint',
    // Blueprint quality is gated hard — partial convergence ships only the
    // best round; repair rounds are capped at 3 to bound cost.
    verdict: { scoreThreshold: 80, maxMustFix: 0, maxRounds: 3, fallbackPolicy: 'ship_best' },
    budget: { maxSteps: 64, maxTokens: 400_000 },
  },
  'feature-creator': {
    name: 'feature-creator',
    // Feature specs ship the last converged round; a slightly lower bar keeps
    // the feedback loop fast for day-to-day feature work.
    verdict: { scoreThreshold: 75, maxMustFix: 0, maxRounds: 3, fallbackPolicy: 'ship_last' },
    budget: { maxSteps: 40, maxTokens: 200_000 },
  },
  'tool-builder': {
    name: 'tool-builder',
    // MCP tool specs must pass schema validation — correctness dominates.
    verdict: { scoreThreshold: 85, maxMustFix: 0, maxRounds: 3, fallbackPolicy: 'ship_best' },
    budget: { maxSteps: 32, maxTokens: 150_000 },
  },
  'agent-builder': {
    name: 'agent-builder',
    // Agent blueprints tolerate partial sub-agent failure (supervisor
    // re-plans); shipping the best converged round.
    verdict: { scoreThreshold: 80, maxMustFix: 0, maxRounds: 3, fallbackPolicy: 'ship_best' },
    budget: { maxSteps: 64, maxTokens: 300_000 },
  },
};

/**
 * Resolve the defaults for a named pipeline, falling back to the blueprint
 * configuration when the name is unknown (never throws — pipelines must not
 * fail because of a defaults lookup).
 */
export function resolvePipelineDefaults(name: string): PipelineDefaults {
  const found: PipelineDefaults | undefined = Object.prototype.hasOwnProperty.call(PIPELINE_DEFAULTS, name)
    ? (PIPELINE_DEFAULTS[name] as PipelineDefaults)
    : undefined;
  return found ?? (PIPELINE_DEFAULTS.blueprint as PipelineDefaults);
}
