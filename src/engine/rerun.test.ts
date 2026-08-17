// src/engine/rerun.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runRerunLoop } from './rerun';
import { PillarName } from './types';
import * as pillarRunner from './pillarRunner';
import * as prosecutor from './prosecutor';
import * as checkpoint from './checkpoint';

const makeApproved = () => ({
  verdict: 'approved' as const,
  gaps_found: 0, gaps_resolved: 0, gaps: []
});

const makeRevision = (pillars: string[]) => ({
  verdict: 'requires_revision' as const,
  gaps_found: 1, gaps_resolved: 0,
  gaps: [{ id: 'g1', severity: 'high' as const,
    pillars_involved: pillars,
    description: 'test gap', resolution: 'fix it' }]
});

describe('runRerunLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns immediately when prosecutor already approved', async () => {
    const runPillarSpy = vi.spyOn(pillarRunner, 'runPillar');
    const result = await runRerunLoop(
      {}, [], makeApproved(), {} as any, {} as any, () => {}, undefined, 'sess'
    );
    expect(result.verdict).toBe('approved');
    expect(runPillarSpy).not.toHaveBeenCalled();
  });

  it('reruns implicated pillars and re-prosecutes', async () => {
    const pillarDefs = [
      { name: 'planning' as PillarName, govSysPrompt:'', prosSysPrompt:'',
      staticGovPrompt:'', agents:[], prior: undefined }
    ];

    vi.spyOn(pillarRunner, 'runPillar').mockResolvedValue({
      pillar: 'planning', agents: [], failed_agents: [],
      reverifier_issues: 0, summary: 'fixed',
      tokens_reviewer:0, tokens_prosecutor:0,
      tokens_synthesizer:0, tokens_total:0
    } as any);

    vi.spyOn(prosecutor, 'runProsecutor').mockResolvedValue(makeApproved());
    vi.spyOn(checkpoint, 'saveCheckpoint').mockReturnValue(undefined as any);

    const result = await runRerunLoop(
      { planning: {} as any }, pillarDefs,
      makeRevision(['planning']),
      {} as any, {} as any, () => {}, undefined, 'sess'
    );

    expect(result.verdict).toBe('approved');
  });

  it('edge_cases pillar name normalises correctly', async () => {
    const pillarDefs = [
      { name: 'edge_cases' as PillarName, govSysPrompt:'', prosSysPrompt:'',
      staticGovPrompt:'', agents:[], prior: undefined }
    ];

    const runPillarSpy = vi.spyOn(pillarRunner, 'runPillar')
      .mockResolvedValue({ pillar: 'edge_cases', agents: [],
      failed_agents: [], reverifier_issues: 0, summary: '',
      tokens_reviewer:0, tokens_prosecutor:0,
      tokens_synthesizer:0, tokens_total:0 } as any);

    vi.spyOn(prosecutor, 'runProsecutor').mockResolvedValue(makeApproved());
    vi.spyOn(checkpoint, 'saveCheckpoint').mockReturnValue(undefined as any);

    // Prosecutor returns "edge_cases" in pillars_involved
    await runRerunLoop(
      { edge_cases: {} as any }, pillarDefs,
      makeRevision(['edge_cases']),
      {} as any, {} as any, () => {}, undefined, 'sess'
    );

    expect(runPillarSpy).toHaveBeenCalledOnce(); // must be called
  });

  it('stops after MAX_RERUN_ATTEMPTS even if gaps remain', async () => {
    const pillarDefs = [
      { name: 'planning' as PillarName, govSysPrompt:'', prosSysPrompt:'',
      staticGovPrompt:'', agents:[], prior: undefined }
    ];

    vi.spyOn(pillarRunner, 'runPillar').mockResolvedValue({
      pillar: 'planning', agents: [], failed_agents: [],
      reverifier_issues: 0, summary: '',
      tokens_reviewer:0, tokens_prosecutor:0,
      tokens_synthesizer:0, tokens_total:0 
    } as any);

    // Always return requires_revision
    const prosecutorSpy = vi.spyOn(prosecutor, 'runProsecutor')
      .mockResolvedValue(makeRevision(['planning']));

    vi.spyOn(checkpoint, 'saveCheckpoint').mockReturnValue(undefined as any);

    const rerunEvents: any[] = [];
    await runRerunLoop(
      { planning: {} as any }, pillarDefs,
      makeRevision(['planning']),
      {} as any, {} as any, (e) => rerunEvents.push(e), undefined, 'sess'
    );

    // With convergence early-exit, if gaps aren't resolving it will exit at 2 attempts
    expect(prosecutorSpy).toHaveBeenCalledTimes(2);
    expect(rerunEvents.some(e => e.type === 'rerun_exhausted')).toBe(true);
  });

  it('stops immediately if signal is aborted before attempts start', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runRerunLoop(
      {}, [], makeRevision(['planning']), {} as any, {} as any, () => {}, controller.signal, 'sess'
    );
    // Should return original prosecutor result immediately
    expect(result.verdict).toBe('requires_revision');
  });

  it('stops if signal is aborted during pillar run', async () => {
    const pillarDefs = [
      { name: 'planning' as PillarName, govSysPrompt:'', prosSysPrompt:'',
      staticGovPrompt:'', agents:[], prior: undefined }
    ];

    const controller = new AbortController();
    vi.spyOn(pillarRunner, 'runPillar').mockImplementation(async () => {
      controller.abort(); // simulate abort happening here
      throw new DOMException('Generation cancelled', 'AbortError');
    });

    try {
      await runRerunLoop(
        { planning: {} as any }, pillarDefs,
        makeRevision(['planning']),
        {} as any, {} as any, () => {}, controller.signal, 'sess'
      );
    } catch (e: any) {
      expect(e.name).toBe('AbortError');
    }
  });

});
