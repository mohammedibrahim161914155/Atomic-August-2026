/**
 * src/engine/qualityRatchet.ts
 *
 * Quality Delta Ratchet — the OpenDesign quality-ratchet pattern, adapted
 * from OpenDesign's repair-loop quality gating and Codex's stop-and-fix
 * milestone verification (developers.openai.com long-horizon article,
 * Feb 2026).
 *
 * Ratchet rule: a repaired candidate is only accepted as "improved" if its
 * quality score is STRICTLY higher than the previous round, or — when the
 * previous round's mustFix blockers list is non-empty — it passes strictly
 * more of those blockers. A candidate that regresses is rejected and the
 * loop falls back to the best prior candidate instead of shipping the
 * regression. This converts the verifier repair loop from "last round wins"
 * into a monotonically non-regressing quality walk.
 *
 * Design:
 *   - RatchetEntry records one verifier round: score, mustFix passed count,
 *     candidate fingerprint (hash of passed checks) and an optional token
 *     cost for observability.
 *   - evaluateRatchet() decides accept / reject / best-with-regression for
 *     a new candidate against the history.
 *   - The ratchet is pure and unit-testable — wiring into verifier loops is
 *     a one-line policy decision at the call site.
 */

/** Fingerprint of which checks passed in a round — for exact comparison. */
export type CheckFingerprint = string;

export interface RatchetEntry {
  round: number;
  score: number;
  mustFixPassed: number;
  mustFixTotal: number;
  fingerprint: CheckFingerprint;
  tokensUsed: number;
}

export type RatchetDecision =
  | { accept: true; reason: 'improved_score' | 'improved_mustfix' | 'first_round' }
  | { accept: false; reason: 'regressed_score' | 'regressed_mustfix' };

/** Fingerprint a passed-checks boolean array into a stable string. */
export function fingerprintChecks(passed: boolean[]): CheckFingerprint {
  return passed.map(p => (p ? '1' : '0')).join('');
}

export function makeRatchetEntry(
  round: number,
  score: number,
  passed: boolean[],
  tokensUsed: number,
): RatchetEntry {
  const mustFix = passed.filter(Boolean).length;
  return {
    round,
    score,
    mustFixPassed: mustFix,
    mustFixTotal: passed.length,
    fingerprint: fingerprintChecks(passed),
    tokensUsed,
  };
}

/**
 * Decide whether a new verifier round should be accepted as the current
 * candidate. Rules (Codex stop-and-fix semantics):
 *   - First round: always accepted (baseline).
 *   - Otherwise, accept when score strictly improves OR mustFix coverage
 *     strictly improves while score does not regress below the previous
 *     score's mustFix coverage delta. Concretely: accept if score is higher,
 *     or score ties and more blockers were cleared.
 *   - Anything else is a regression → reject; the caller falls back to the
 *     best prior entry (track best separately).
 */
export function evaluateRatchet(
  history: RatchetEntry[],
  candidate: RatchetEntry,
): RatchetDecision {
  if (history.length === 0) {
    return { accept: true, reason: 'first_round' };
  }
  const prior = history[history.length - 1]!;
  if (candidate.score > prior.score) {
    return { accept: true, reason: 'improved_score' };
  }
  if (candidate.score === prior.score && candidate.mustFixPassed > prior.mustFixPassed) {
    return { accept: true, reason: 'improved_mustfix' };
  }
  // Score decreased, or same score with fewer/equal blockers cleared → regress.
  if (candidate.score < prior.score) {
    return { accept: false, reason: 'regressed_score' };
  }
  return { accept: false, reason: 'regressed_mustfix' };
}

/** Select the best entry from ratchet history (highest score, ties → most blockers cleared, then latest round). */
export function bestRatchetEntry(history: RatchetEntry[]): RatchetEntry | undefined {
  if (history.length === 0) return undefined;
  return [...history].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.mustFixPassed !== a.mustFixPassed) return b.mustFixPassed - a.mustFixPassed;
    return b.round - a.round;
  })[0];
}

/** Total tokens spent across ratchet rounds (observability). */
export function ratchetTokensUsed(history: RatchetEntry[]): number {
  return history.reduce((sum, e) => sum + (e.tokensUsed | 0), 0);
}
