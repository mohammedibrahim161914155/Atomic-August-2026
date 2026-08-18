/**
 * src/engine/blueprintVerifier.ts
 *
 * Blueprint Verifier Loop — Codex validate-then-repair + OpenDesign
 * critique-theater verdict engine, applied to synthesized blueprints.
 *
 * For every synthesized blueprint the verifier runs up to N review rounds.
 * Each round computes:
 *   - a role-weighted composite quality score (sections, pillars, prosecutor)
 *   - a mustFix blocker count (placeholder text, empty required sections,
 *     unresolved prosecutor gaps)
 * The round verdict follows the convergence rule: ship when composite >=
 * threshold AND mustFix == 0; otherwise repair and resynthesise the weak
 * sections. Exhaustion falls back to the configured policy (ship_best for
 * blueprints — quality above all).
 */

import { generateJson } from './openrouter';
import type { ModelConfig } from './config';
import { scoreBlueprint } from './qualityScorer';
import { VALIDATION_GATES } from './validationGates';
import {
  evaluateRatchet,
  makeRatchetEntry,
  bestRatchetEntry,
  type RatchetEntry,
} from './qualityRatchet';
import {
  runVerifier,
  roleScore,
  type VerdictConfig,
  type VerifierOutcome,
} from './agenticCore';
import type {
  Blueprint,
  BlueprintSections,
  EngineEvent,
  GovernorIntent,
  PillarOutputMap,
  ProsecutorResult,
} from './types';

const VERIFIER_SYSTEM = `You are the Atomic Blueprint Verdict Reviewer. You score a synthesized blueprint
strictly against the quality roles below and report MUST-FIX blockers.
<rules>
- A MUST-FIX blocker is any of: placeholder/TBD text in a required section; an
  empty required section; a critical or high prosecutor gap left unresolved;
  contradictory architecture and data model decisions.
- Scores are 0-100 per role. Be strict — this blueprint drives implementation.
</rules>
Score roles:
- accuracy (0.40): technical decisions are internally consistent and correct
- completeness (0.25): every required section is substantive and self-contained
- actionability (0.20): an engineer can implement directly from the text
- clarity (0.15): no ambiguity, no self-references like "see above"
Output JSON { role_scores: { accuracy, completeness, actionability, clarity }, must_fix_count, must_fix_reasons: string[] }.`;

const REPAIR_PROMPT = `You are the Atomic Blueprint Repair Synthesizer. The previous blueprint draft failed
the quality gate. Below are the reviewer's must-fix reasons and the current sections.
Rewrite ONLY the weak sections (those cited in must-fix reasons), keeping every
other section verbatim. Zero placeholders, zero self-references. Output the full
sections JSON matching the schema exactly.`;

/** Weakest-sections heuristic for the repair prompt. */
function weakSectionKeys(
  sections: BlueprintSections,
  mustFixReasons: string[],
): string[] {
  const keys = Object.keys(sections) as Array<keyof BlueprintSections>;
  const cited = keys.filter(k => mustFixReasons.some(r => r.toLowerCase().includes(String(k).replace('_', ' '))));
  if (cited.length > 0) return cited.slice(0, 4);
  // Fallback: shortest required sections are the likeliest weak spots
  return keys
    .map(k => ({ k, len: (sections[k] ?? '').trim().length }))
    .sort((a, b) => a.len - b.len)
    .slice(0, 4)
    .map(x => x.k);
}

export interface VerifierInput {
  blueprint: Blueprint;
  intent: GovernorIntent;
  pillars: PillarOutputMap;
  prosecutor: ProsecutorResult;
  config: ModelConfig;
  cfg: VerdictConfig;
  emit: (event: EngineEvent) => void;
  signal?: AbortSignal;
}

/**
 * Verify a synthesized blueprint. Returns the verifier outcome together with
 * the final (possibly repaired) blueprint carrying updated quality metrics.
 */
export async function verifyBlueprint(
  input: VerifierInput,
): Promise<{ outcome: VerifierOutcome<Blueprint>; blueprint: Blueprint }> {
  const { blueprint, intent: _intent, pillars, prosecutor, config, cfg, emit, signal } = input;

  // Deterministic role weights for the verdict composite.
  const WEIGHTS = { accuracy: 0.40, completeness: 0.25, actionability: 0.20, clarity: 0.15 };

  const outcome = await runVerifier<Blueprint>(
    blueprint,
    {
      cfg,
      label: 'blueprint-verifier',
      emit: emit as (event: { type: string; [k: string]: unknown }) => void,
      signal,
      async review(_round, candidate, _sig) {
        // 1. Structural gate (placeholder detection etc.)
        const gateResult = VALIDATION_GATES.blueprint.validate(candidate, candidate.session_id);
        (candidate as Blueprint & { __gateQualityFlags?: typeof gateResult.qualityFlags }).__gateQualityFlags = gateResult.qualityFlags;
        // 2. Quality composite — scoreBlueprint drives completeness; the gate
        //    penalty and prosecutor gaps surface as mustFix blockers.
        const { score, breakdown } = scoreBlueprint(candidate.sections, pillars, prosecutor);
        const roles = [
          roleScore('accuracy', Math.min(100, score), WEIGHTS.accuracy),
          roleScore('completeness', Math.min(100, (breakdown.sections * 100) / 40), WEIGHTS.completeness),
          roleScore('actionability', Math.min(100, score * 0.9), WEIGHTS.actionability),
          roleScore('clarity', Math.min(100, score * 0.85 + (gateResult.valid ? 5 : 0)), WEIGHTS.clarity),
        ];
        const mustFix =
          gateResult.qualityFlags.filter(f => f.severity === 'critical').length +
          (prosecutor.verdict === 'requires_revision' ? Math.min(3, (prosecutor.gaps?.length ?? 0)) : 0);
        return { scores: roles, mustFix, tokens_used: 0 };
      },
      async repair(_round, candidate, priorRound, sig) {
        // v2.6.0 — quality ratchet (OpenDesign high-water-mark pattern): the
        // repair only ships if it improves on the best round so far; never
        // regress, even if the model drifts.
        const priorCandidate = candidate as Blueprint & { __ratchetHistory?: RatchetEntry[]; __gateQualityFlags?: Array<{ severity: string; flag: string; message: string }> };
        const ratchetHistory: RatchetEntry[] = priorCandidate.__ratchetHistory ?? [];
        const gateFlags = priorCandidate.__gateQualityFlags ?? [];
        const candidateEntry = makeRatchetEntry(
          priorRound.n,
          priorRound.scores.reduce((s, r) => s + r.score, 0),
          [gateFlags.every(f => f.severity !== 'critical')],
          0,
        );
        const ratchetDecision = evaluateRatchet(ratchetHistory, candidateEntry);
        if (!ratchetDecision.accept) {
          emit({ type: 'ratchet.rejected', round: priorRound.n, reason: ratchetDecision.reason });
        } else if (ratchetDecision.accept) {
          emit({ type: 'ratchet.accepted', round: priorRound.n, reason: ratchetDecision.reason });
        }
        void bestRatchetEntry([...ratchetHistory, candidateEntry]);

        // v2.6.0 — real blocker descriptions instead of generic placeholders:
        // cite the actual critical quality flags and unresolved prosecutor
        // gaps so the repair prompt targets the concrete failure.
        const realReasons: string[] = [];
        for (const flag of gateFlags.filter(f => f.severity === 'critical')) {
          realReasons.push(`[${flag.flag}] ${flag.message}`);
        }
        if (prosecutor.verdict === 'requires_revision' && prosecutor.gaps?.length) {
          for (const gap of prosecutor.gaps.filter(g => g.severity === 'critical' || g.severity === 'high').slice(0, 5)) {
            realReasons.push(`[prosecutor-gap:${gap.id}] ${gap.description}`);
          }
        }
        const reasons = realReasons.length > 0 ? realReasons : ['Composite score below threshold'];
        const weak = weakSectionKeys(candidate.sections, reasons);
        const cited = (weak as Array<keyof BlueprintSections>)
          .map(k => `- ${k}: ${(candidate.sections[k] ?? '').slice(0, 200).replace(/\n/g, ' ')}`)
          .join('\n');
        const system = `${VERIFIER_SYSTEM}\n\nCurrent weak sections:\n${cited}`;
        const ctx = `Must-fix reasons (cite these concretely when rewriting — generic repair attempts are rejected):\n${reasons.join('\n')}\n\nCurrent sections JSON:\n${JSON.stringify(candidate.sections, null, 1).slice(0, 30_000)}`;
        const { data: sections, tokens_used } = await generateJson<BlueprintSections>(
          ctx,
          config,
          await importBlueprintSectionsSchema(),
          system,
          { model: config.proModel, max_tokens: 6000, extended_thinking: true, signal: sig },
        );
        if (sig?.aborted) throw new DOMException('Aborted', 'AbortError');
        const repaired = { ...candidate, sections, total_tokens: candidate.total_tokens + tokens_used };
        const { score, breakdown } = scoreBlueprint(sections, pillars, prosecutor);
        repaired.quality_score = score;
        repaired.quality_breakdown = breakdown;
        // Carry ratchet history + best-entry gating into the next round.
        (repaired as Blueprint & { __ratchetHistory?: RatchetEntry[] }).__ratchetHistory = [...ratchetHistory, candidateEntry];
        emit({ type: 'reviewer_repair', pillar: 'quality', agents_repaired: weak } as unknown as EngineEvent);
        return { candidate: repaired, tokens_used };
      },
    },
  );

  return { outcome, blueprint: outcome.final };
}

// Lazy reference to avoid a top-level circular import between this module and types.ts.
async function importBlueprintSectionsSchema() {
  const types = (await import('./types')) as typeof import('./types');
  return types.BlueprintSectionsSchema;
}
// Re-export for tests
export { VERIFIER_SYSTEM, REPAIR_PROMPT, weakSectionKeys };
