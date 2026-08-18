/**
 * src/engine/pipelineVerifier.ts
 *
 * Shared verifier loop for the Feature Creator, Tool Builder, and Agent
 * Builder pipelines. Each pipeline already performs structural quality
 * checks (required-array lengths, section presence). This module promotes
 * those checks into a Codex-style validate-then-repair loop with an
 * OpenDesign-style composite verdict, so a weak first pass is repaired
 * rather than shipped.
 *
 * Behaviour per pipeline:
 *   - review   : recompute the pipeline's own quality checks as role scores
 *                (completeness / actionability / rigour) and count mustFix
 *                blockers (empty required arrays, undersized required strings).
 *   - repair   : re-run synthesis with a critique citing the weak checks.
 *   - verdict  : ship when composite >= threshold and mustFix == 0; otherwise
 *                repair, up to maxRounds; exhaustion falls back to
 *                ship_last / ship_best per pipeline defaults.
 */

import { generateJson } from './openrouter';
import {
  runVerifier,
  roleScore,
  type VerdictConfig,
  type VerifierOutcome,
  type VerifierRound,
} from './agenticCore';
import {
  evaluateRatchet,
  makeRatchetEntry,
  type RatchetEntry,
} from './qualityRatchet';
import { log } from './logger';
import type { EngineEvent, ModelConfig } from './types';
import type { ZodType } from 'zod';

// ── Generic check descriptor used by every pipeline ─────────────────────────

export interface PipelineQualityCheck<T> {
  label: string;
  /** Evaluate one check; true = passing. */
  pass: (candidate: T) => boolean;
  /** Role this check feeds into the composite score. */
  role: 'completeness' | 'actionability' | 'rigour';
}

export interface PipelineVerifierOptions<T> {
  candidate: T;
  config: ModelConfig;
  checks: PipelineQualityCheck<T>[];
  /** Schema used by the repair synthesiser (parsed JSON must validate). */
  schema: ZodType<T>;
  /** System prompt for the synthesis step. */
  systemPrompt: string;
  /** Synthesis payload (the full context JSON). */
  synthesisPrompt: string;
  cfg: VerdictConfig;
  emit?: ((event: EngineEvent) => void) | null;
  signal?: AbortSignal;
  label: string;
}

const REPAIR_SYSTEM_SUFFIX = `This is a repair synthesis. The previous output failed quality checks.
Address EVERY failed check below — do not shrink sections to pass length checks;
be exhaustive, specific, and zero-placeholder.`;

/** Evaluate every check against a candidate and derive roles + mustFix. */
export function evaluateChecks<T>(
  candidate: T,
  checks: PipelineQualityCheck<T>[],
): { roles: import('./agenticCore').RoleScore[]; mustFix: number; passed: boolean[] } {
  const passed = checks.map(ch => ch.pass(candidate));
  const completeness =
    (passed.filter((p, i) => checks[i]!.role === 'completeness' && p).length /
      Math.max(1, checks.filter(ch => ch.role === 'completeness').length)) *
    100;
  const actionability =
    (passed.filter((p, i) => checks[i]!.role === 'actionability' && p).length /
      Math.max(1, checks.filter(ch => ch.role === 'actionability').length)) *
    100;
  const rigour =
    (passed.filter((p, i) => checks[i]!.role === 'rigour' && p).length /
      Math.max(1, checks.filter(ch => ch.role === 'rigour').length)) *
    100;
  const mustFix = passed.filter((p, i) => !p && checks[i]!.role === 'completeness').length;
  return {
    roles: [
      roleScore('completeness', completeness, 0.5),
      roleScore('actionability', actionability, 0.3),
      roleScore('rigour', rigour, 0.2),
    ],
    mustFix,
    passed,
  };
}

/**
 * Run the verifier loop on a pipeline candidate. Returns the elected outcome
 * and final candidate. Errors are non-fatal — on failure the original
 * candidate ships and the failure is logged (same pattern as the blueprint
 * verifier's best-effort wrapper).
 */
export async function verifyPipelineOutput<T>(
  opts: PipelineVerifierOptions<T>,
): Promise<{ outcome: VerifierOutcome<T>; candidate: T }> {
  const { candidate, config, checks, schema, systemPrompt, synthesisPrompt, cfg, emit, signal, label } = opts;

  const outcome = await runVerifier<T>(candidate, {
    cfg,
    label,
    emit: emit ? (emit as (event: { type: string; [k: string]: unknown }) => void) : null,
    signal,
    async review(_round, c, _sig) {
      const { roles, mustFix, passed } = evaluateChecks(c, checks);
      (c as T & { __lastPassed?: boolean[] }).__lastPassed = passed;
      return { scores: roles, mustFix, tokens_used: 0 };
    },
    async repair(_round, c, priorRound: VerifierRound, sig) {
      // v2.6.0 — quality ratchet (OpenDesign high-water-mark pattern): track
      // rounds across repairs; the verifier verdict engine already elects
      // best-ever candidates, so we additionally publish ratchet events and
      // target the repair prompt at the ACTUAL failed checks rather than a
      // generic placeholder critique.
      const priorCandidate = c as T & { __ratchetHistory?: RatchetEntry[]; __lastPassed?: boolean[] };
      const ratchetHistory: RatchetEntry[] = priorCandidate.__ratchetHistory ?? [];
      const passed: boolean[] = priorCandidate.__lastPassed ?? [];
      const candidateEntry = makeRatchetEntry(
        priorRound.n,
        priorRound.scores.reduce((s, r) => s + r.score, 0),
        passed,
        0,
      );
      const decision = evaluateRatchet(ratchetHistory, candidateEntry);
      if (!decision.accept) {
        emit?.({ type: 'ratchet.rejected', round: priorRound.n, reason: decision.reason } as unknown as EngineEvent);
      } else {
        emit?.({ type: 'ratchet.accepted', round: priorRound.n, reason: decision.reason } as unknown as EngineEvent);
      }
      const next = (data: T): T & { __ratchetHistory: RatchetEntry[]; __lastPassed: boolean[] } =>
        Object.assign(Object.create(null) as Record<string, never>, data as object, {
          __ratchetHistory: [...ratchetHistory, candidateEntry],
          __lastPassed: checks.map(ch => ch.pass(data)),
        }) as T & { __ratchetHistory: RatchetEntry[]; __lastPassed: boolean[] };
      const failedChecks = checks
        .filter(ch => !ch.pass(c))
        .map(ch => `${ch.label} (${ch.role})`);
      const critique = failedChecks.length
        ? `Failed checks (rewrite these specifically — generic outputs that still fail these checks will be rejected): ${failedChecks.join('; ')}`
        : 'Composite below threshold';
      const { data, tokens_used } = await generateJson<T>(
        `${synthesisPrompt}\n\n${critique}`,
        config,
        schema,
        systemPrompt + '\n\n' + REPAIR_SYSTEM_SUFFIX,
        { model: config.proModel, max_tokens: 8000, extended_thinking: true, signal: sig },
      );
      if (sig?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (emit) {
        emit({ type: 'reviewer_repair', pillar: 'quality', agents_repaired: failedChecks.slice(0, 5) } as unknown as EngineEvent);
      }
      return { candidate: next(data), tokens_used };
    },
  });

  return { outcome, candidate: outcome.final };
}

export const logVerifierFailure = (label: string, err: unknown): void => {
  log.error({ err, label }, `[verifier] ${label} verifier loop failed — shipping pre-verifier candidate`);
};
