/**
 * src/engine/milestoneVerifier.ts
 *
 * Milestone Acceptance Verification — the Codex stop-and-fix milestone
 * pattern (developers.openai.com "Run long horizon tasks with Codex",
 * Feb 2026). Codex's Plan.md pairs every milestone with acceptance criteria
 * and validation commands; a milestone is only marked complete after the
 * validation passes, and failures are repaired before moving on.
 *
 * Atomic already runs plan mode (agenticCore.runSupervisor) and marks
 * milestones passed — but the acceptance criteria were never actually
 * evaluated. This module closes that gap:
 *
 *   - checkMilestoneCriteria(): deterministic, rule-based evaluation of
 *     milestone acceptance criteria text against produced content. Rules:
 *       * criteria containing "must include <term>" / "must cover <term>" /
 *         "must have <term>" must appear verbatim (case-insensitive)
 *       * criteria containing "at least N <term>" must contain the term at
 *         least N times
 *       * criteria starting with "must not" / "must never" forbid the term
 *       * criteria ending with "?" are open questions — flagged as
 *         'unverifiable' so the verifier loop re-checks them via the model
 *   - verifyMilestonesAgainstContent(): evaluates every planned milestone's
 *     criteria against a content snapshot (e.g. the synthesizer output),
 *     returning a per-milestone verdict list usable by plan mode to emit
 *     milestone.passed / milestone.failed with real reasons.
 *
 * The function is pure and unit-testable. Integration with the verifier loop
 * (model-assisted criteria checks for criteria marked 'unverifiable') is done
 * by the verifier call sites via acceptCriteriaVerdict().
 */

export type CriteriaVerdict = 'pass' | 'fail' | 'unverifiable';

export interface CriteriaCheck {
  criterion: string;
  verdict: CriteriaVerdict;
  reason: string;
}

export interface MilestoneCheck {
  key: string;
  title: string;
  criteria: CriteriaCheck[];
  allPassed: boolean;
}

// ── Term extraction from criterion text ────────────────────────────────────────

/** Extract terms + cardinality requirements from a criterion string. */
function parseCriterion(criterion: string): {
  negated: boolean;
  minCount: number;
  term: string;
} {
  const lower = criterion.toLowerCase().trim();
  const negated = /\bmust not\b|\bmust never\b|\bshould not\b/.test(lower);
  const countMatch = lower.match(/at least (\d+) (\S+)/);
  const minCount = countMatch ? Number(countMatch[1]) : 1;
  let term = countMatch ? countMatch[2]! : '';
  if (!term) {
    const includeMatch = lower.match(/must (?:include|cover|have|contain|mention|provide) (.+?)(?:\.|$)/);
    term = includeMatch ? includeMatch[1]! : lower.replace(/^\s*(must|should|include)\s+/, '');
  }
  return { negated, minCount, term: term.replace(/[^a-z0-9 _\-./]/g, '').trim() };
}

/**
 * Evaluate one acceptance criterion against produced content.
 */
export function checkCriterion(criterion: string, content: string): CriteriaCheck {
  const { negated, minCount, term } = parseCriterion(criterion);
  const lower = content.toLowerCase();

  if (criterion.trim().endsWith('?')) {
    return {
      criterion,
      verdict: 'unverifiable',
      reason: 'Open question — requires model-assisted verification.',
    };
  }
  if (!term) {
    return { criterion, verdict: 'unverifiable', reason: 'No extractable checkable term.' };
  }

  const occurrences = (lower.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;

  if (negated) {
    if (occurrences > 0) {
      return {
        criterion,
        verdict: 'fail',
        reason: `Forbidden term "${term}" found ${occurrences} time(s).`,
      };
    }
    return { criterion, verdict: 'pass', reason: 'Forbidden term correctly absent.' };
  }

  if (minCount > 1) {
    if (occurrences >= minCount) {
      return {
        criterion,
        verdict: 'pass',
        reason: `"${term}" mentioned ${occurrences} time(s) (required ≥ ${minCount}).`,
      };
    }
    return {
      criterion,
      verdict: 'fail',
      reason: `"${term}" mentioned ${occurrences} time(s) (required ≥ ${minCount}).`,
    };
  }

  if (occurrences > 0) {
    return { criterion, verdict: 'pass', reason: `Term "${term}" found in content.` };
  }
  return { criterion, verdict: 'fail', reason: `Required term "${term}" missing from content.` };
}

export interface PlannedMilestone {
  key: string;
  title: string;
  /** Acceptance criteria lines (plan.md style). */
  acceptanceCriteria: string[];
}

/**
 * Verify all milestones' acceptance criteria against a content snapshot.
 * Pure and deterministic — used by plan mode + verifier loops.
 */
export function verifyMilestonesAgainstContent(
  milestones: PlannedMilestone[],
  content: string,
): MilestoneCheck[] {
  return milestones.map(m => {
    const criteria = m.acceptanceCriteria.map(c => checkCriterion(c, content));
    return {
      key: m.key,
      title: m.title,
      criteria,
      allPassed: criteria.length > 0 && criteria.every(c => c.verdict === 'pass'),
    };
  });
}

/** Summarize milestone verification for the verifier loop's critique prompt. */
export function milestoneCritique(checks: MilestoneCheck[]): string {
  const failed: string[] = [];
  for (const m of checks) {
    const missed = m.criteria.filter(c => c.verdict === 'fail');
    if (missed.length > 0) {
      failed.push(
        `Milestone "${m.title}": ${missed.map(c => `${c.criterion} — ${c.reason}`).join('; ')}`,
      );
    }
  }
  if (failed.length === 0) return 'All milestone acceptance criteria verified.';
  return 'Failed milestone acceptance criteria:\n- ' + failed.join('\n- ');
}
