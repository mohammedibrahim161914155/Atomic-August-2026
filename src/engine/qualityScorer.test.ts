import { describe, it, expect } from 'vitest';
import { scoreBlueprint, SCORED_SECTION_KEYS } from './qualityScorer';
import type { BlueprintSections, PillarOutputMap, ProsecutorResult } from './types';

function makeSections(overrides: Partial<BlueprintSections> = {}): BlueprintSections {
  const base: Record<string, string> = {};
  for (const k of SCORED_SECTION_KEYS) {
    base[k] = 'x'.repeat(100);
  }
  return { ...base, ...overrides } as BlueprintSections;
}

const PILLAR_NAMES = [
  'planning', 'production', 'edge_cases', 'integration', 'security', 'quality', 'completeness',
] as const;

function makePillars(count: number, failedCount = 0): PillarOutputMap {
  const pillars: PillarOutputMap = {};
  for (let i = 0; i < Math.min(count, PILLAR_NAMES.length); i++) {
    const name = PILLAR_NAMES[i]!;
    (pillars as any)[name] = {
      pillar:        name,
      agents:        [],
      failed_agents: i < failedCount ? ['agent_x'] : [],
      summary:       { master_record_md: '' },
      tokens_reviewer:   0,
      tokens_prosecutor: 0,
      tokens_synthesizer:0,
      tokens_total:      0,
      reverifier_issues: 0,
    };
  }
  return pillars;
}

function makeApprovedProsecutor(): ProsecutorResult {
  return { verdict: 'approved', gaps: [], gaps_found: 0, gaps_resolved: 0 };
}

function makeProsecutorWithGaps(count: number): ProsecutorResult {
  return {
    verdict: 'requires_revision',
    gaps: Array.from({ length: count }, (_, i) => ({
      id: `g${i}`, severity: 'high' as const, description: 'gap',
      pillars_involved: [], agents_involved: [], resolution: '',
    })),
    gaps_found:    count,
    gaps_resolved: 0,
  };
}

describe('scoreBlueprint', () => {
  it('returns 100 for a perfect blueprint', () => {
    const result = scoreBlueprint(makeSections(), makePillars(7, 0), makeApprovedProsecutor());
    expect(result.score).toBe(100);
    expect(result.breakdown.sections).toBe(40);
    expect(result.breakdown.pillars).toBe(30);
    expect(result.breakdown.prosecutor).toBe(30);
  });

  it('returns breakdown summing to score', () => {
    const result = scoreBlueprint(makeSections(), makePillars(5, 2), makeProsecutorWithGaps(2));
    const { sections, pillars, prosecutor } = result.breakdown;
    expect(sections + pillars + prosecutor).toBe(result.score);
  });

  it('deducts section points proportionally for empty sections', () => {
    const half = Math.floor(SCORED_SECTION_KEYS.length / 2);
    const sections = makeSections();
    SCORED_SECTION_KEYS.slice(0, half).forEach(k => { (sections as any)[k] = ''; });
    const result = scoreBlueprint(sections, makePillars(7), makeApprovedProsecutor());
    expect(result.breakdown.sections).toBe(20);
  });

  it('gives 0 pillar points when there are no pillars', () => {
    const result = scoreBlueprint(makeSections(), {}, makeApprovedProsecutor());
    expect(result.breakdown.pillars).toBe(0);
  });

  it('deducts pillar points for failed agents', () => {
    const result = scoreBlueprint(makeSections(), makePillars(4, 2), makeApprovedProsecutor());
    expect(result.breakdown.pillars).toBe(15);
  });

  it('deducts 5 pts per gap from prosecutor score', () => {
    const result = scoreBlueprint(makeSections(), makePillars(7), makeProsecutorWithGaps(3));
    expect(result.breakdown.prosecutor).toBe(15);
  });

  it('floors prosecutor score at 0 even with many gaps', () => {
    const result = scoreBlueprint(makeSections(), makePillars(7), makeProsecutorWithGaps(10));
    expect(result.breakdown.prosecutor).toBe(0);
  });

  it('does not count sections shorter than 50 chars', () => {
    const sections = makeSections({ executive_summary: 'too short' });
    const result = scoreBlueprint(sections, makePillars(7), makeApprovedProsecutor());
    expect(result.breakdown.sections).toBe(36);
  });

  it('counts a section with exactly 50 chars as filled', () => {
    const sections = makeSections({ executive_summary: 'x'.repeat(50) });
    const result = scoreBlueprint(sections, makePillars(7), makeApprovedProsecutor());
    expect(result.breakdown.sections).toBe(40);
  });

  it('score is always between 0 and 100', () => {
    const worst = scoreBlueprint(
      makeSections(Object.fromEntries(SCORED_SECTION_KEYS.map(k => [k, ''])) as any),
      {},
      makeProsecutorWithGaps(10),
    );
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(worst.score).toBeLessThanOrEqual(100);
  });
});
