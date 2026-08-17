/**
 * src/engine/qualityScorer.ts
 *
 * Standalone, independently testable quality scoring for generated blueprints.
 * Called by the synthesizer after all sections are assembled.
 *
 * Scoring breakdown (100 pts total):
 *   40 pts — Section completeness: each of 10 required sections with ≥50 chars
 *   30 pts — Pillar health: fraction of pillars with zero failed agents
 *   30 pts — Prosecutor verdict: approved = 30; deduct 5 per unresolved gap (floor 0)
 */

import { ProsecutorResult, BlueprintSections, PillarOutputMap } from './types';

export interface QualityBreakdown {
  sections:   number;
  pillars:    number;
  prosecutor: number;
}

export interface QualityResult {
  score:     number;
  breakdown: QualityBreakdown;
}

export const SCORED_SECTION_KEYS = [
  'executive_summary',
  'architecture',
  'data_model',
  'api_contracts',
  'security_model',
  'edge_cases',
  'testing_strategy',
  'deployment',
  'launch_checklist',
  'technical_debt',
] as const;

const MIN_SECTION_CHARS = 50;
const MAX_SECTION_SCORE = 40;
const MAX_PILLAR_SCORE  = 30;
const MAX_PROS_SCORE    = 30;
const GAP_PENALTY       = 5;

/**
 * Score a completed blueprint on a 0–100 scale.
 * All inputs are read-only — no side effects.
 */
export function scoreBlueprint(
  sections:   BlueprintSections,
  pillars:    PillarOutputMap,
  prosecutor: ProsecutorResult,
): QualityResult {
  const filledSections = SCORED_SECTION_KEYS.filter(
    k => (sections[k] ?? '').trim().length >= MIN_SECTION_CHARS
  ).length;
  const sectionScore = Math.round(
    (filledSections / SCORED_SECTION_KEYS.length) * MAX_SECTION_SCORE
  );

  const totalPillars   = Object.values(pillars).length;
  const healthyPillars = Object.values(pillars).filter(p => !p.failed_agents?.length).length;
  const pillarScore    = totalPillars > 0
    ? Math.round((healthyPillars / totalPillars) * MAX_PILLAR_SCORE)
    : 0;

  const prosecutorScore = prosecutor.verdict === 'approved'
    ? MAX_PROS_SCORE
    : Math.max(0, MAX_PROS_SCORE - (prosecutor.gaps?.length ?? 0) * GAP_PENALTY);

  return {
    score: sectionScore + pillarScore + prosecutorScore,
    breakdown: {
      sections:   sectionScore,
      pillars:    pillarScore,
      prosecutor: prosecutorScore,
    },
  };
}
