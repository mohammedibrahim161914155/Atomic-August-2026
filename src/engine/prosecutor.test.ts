// src/engine/prosecutor.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runProsecutor } from './prosecutor';
import * as openrouter from './openrouter';

const mockPillars = {
  planning: { pillar: 'planning', agents: [], failed_agents: [],
  reverifier_issues: 0, summary: 'plan summary',
  synthesizer_output: 'plan synth',
  tokens_reviewer:0, tokens_prosecutor:0,
  tokens_synthesizer:0, tokens_total:0 },
  security: { pillar: 'security', agents: [], failed_agents: [],
  reverifier_issues: 0, summary: 'sec summary',
  tokens_reviewer:0, tokens_prosecutor:0,
  tokens_synthesizer:0, tokens_total:0 },
};

describe('runProsecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(openrouter, 'generateJson').mockResolvedValue({
      data: { verdict: 'approved', gaps: [] },
      tokens_used: 500
    });
  });

  it('emits prosecutor_start and prosecutor_done events', async () => {
    const events: any[] = [];
    await runProsecutor(mockPillars as any, {} as any, e => events.push(e));
    expect(events[0].type).toBe('prosecutor_start');
    expect(events[1].type).toBe('prosecutor_done');
  });

  it('returns approved verdict when no gaps', async () => {
    const result = await runProsecutor(mockPillars as any, {} as any, () => {});
    expect(result.verdict).toBe('approved');
    expect(result.gaps).toHaveLength(0);
  });

  it('returns requires_revision when gaps present', async () => {
    vi.spyOn(openrouter, 'generateJson').mockResolvedValue({
      data: {
        verdict: 'requires_revision',
        gaps: [{ id: 'g1', severity: 'high',
          pillars_involved: ['planning'],
          description: 'missing rate limiting',
          resolution: 'add rate limit middleware' }]
      },
      tokens_used: 800
    });

    const result = await runProsecutor(mockPillars as any, {} as any, () => {});
    expect(result.verdict).toBe('requires_revision');
    expect(result.gaps_found).toBe(1);
  });

  it('respects AbortSignal — rejects before API call if already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    // runProsecutor should short-circuit
    const spy = vi.spyOn(openrouter, 'generateJson');
    
    // If abort is checked before the call, spy should not be called
    try {
      await runProsecutor(mockPillars as any, {} as any, () => {}, ctrl.signal);
    } catch {
      // It may throw or suppress, we just want to know spy wasn't called
    }
    
    expect(spy).not.toHaveBeenCalled();
  });
});
