import { describe, it, vi, expect, afterEach } from 'vitest';
import { generateBlueprintSafe } from './safeMode';

vi.mock('./checkpoint', () => ({
  checkpointExists: vi.fn().mockImplementation(async (session, key) => key === 'intent' || key === 'prosecutor' || key === 'pillar_planning'),
  loadCheckpoint: vi.fn().mockImplementation(async (session, key) => {
    if (key === 'intent') return { verdict: 'approved' };
    if (key === 'prosecutor') return { gaps_found: 0, gaps: [], verdict: 'approved', issues: [] };
    return {
      agents: [{ agent: 'A1', content: 'c1' }],
      gaps_found: 0,
      gaps: [],
      verdict: 'approved',
      issues: [],
      summary: { verdict: 'approved' }
    };
  }),
  saveCheckpoint: vi.fn(),
  saveMeta: vi.fn(),
  loadMeta: vi.fn()
}));

vi.mock('./governor', () => ({ runGovernor: vi.fn().mockResolvedValue({ verdict: 'approved' }) }));
vi.mock('./pillarRunner', () => ({ runPillar: vi.fn().mockResolvedValue({ summary: 'test', agents: [] }) }));
vi.mock('./prosecutor', () => ({ runProsecutor: vi.fn().mockResolvedValue({ verdict: 'approved' }) }));
vi.mock('./rerun', () => ({ runRerunLoop: vi.fn().mockImplementation(p => p) }));
vi.mock('./synthesizer', () => ({ runSynthesizer: vi.fn().mockResolvedValue({ title: 'test blueprint' }) }));

vi.mock('./openrouter');

describe('SafeMode', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('covers checkpoint recovery paths in safe mode', async () => {
    const emit = vi.fn();
    const config: any = { provider: 'openrouter', apiKey: 'test', fastModel: 'm1', proModel: 'm2' };
    await generateBlueprintSafe('safe prompt', config, 'session-abc', emit);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'stage_start', stage: 'governor' }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'governor_done' }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'prosecutor_done' }));
  });

  it('generates properly without any checkpoints', async () => {
    vi.mocked((await import('./checkpoint')).checkpointExists).mockResolvedValue(false);
    vi.mocked(await import('./governor')).runGovernor = vi.fn().mockResolvedValue({ verdict: 'approved' });
    vi.mocked(await import('./pillarRunner')).runPillar = vi.fn().mockResolvedValue({ summary: 'test', agents: [] });
    vi.mocked(await import('./prosecutor')).runProsecutor = vi.fn().mockResolvedValue({ verdict: 'approved' });
    vi.mocked(await import('./rerun')).runRerunLoop = vi.fn().mockImplementation((p) => p);
    vi.mocked(await import('./synthesizer')).runSynthesizer = vi.fn().mockResolvedValue({ title: 'test blueprint' });
    
    const emit = vi.fn();
    const config: any = { provider: 'openrouter', apiKey: 'test', fastModel: 'm1', proModel: 'm2' };
    await generateBlueprintSafe('new prompt', config, 'sess-new', emit);
    
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'stage_complete', stage: 'governor' }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'complete' }));
  });

  it('restores properly with all checkpoints existing', async () => {
    vi.mocked((await import('./checkpoint')).checkpointExists).mockResolvedValue(true);
    vi.mocked((await import('./checkpoint')).loadCheckpoint).mockImplementation(async (session, key) => {
      if (key === 'intent') return { verdict: 'approved' };
      if (key === 'blueprint') return { title: 'Restored blueprint', quality_score: 100, sections: {} };
      if (key.startsWith('pillar_')) return { summary: 'test', agents: [] };
      return { verdict: 'approved', summary: 'test', gaps: [], gaps_found: 0 };
    });
    const emit = vi.fn();
    const config: any = { provider: 'openrouter', apiKey: 'test', fastModel: 'm1', proModel: 'm2' };
    await generateBlueprintSafe('restore prompt', config, 'sess-restore', emit);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'complete' }));
  });

  it('covers abort signals', async () => {
    const emit = vi.fn();
    const config: any = { provider: 'openrouter', apiKey: 'test', fastModel: 'm1', proModel: 'm2' };
    const ac = new AbortController();
    ac.abort();
    await generateBlueprintSafe('safe prompt', config, 'session-abc', emit, ac.signal);
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'complete' }));
  });

  it('emits error and updates meta when pipeline throws', async () => {
    const emit = vi.fn();
    const config: any = { provider: 'openrouter', apiKey: 'test', fastModel: 'm1', proModel: 'm2' };
    vi.mocked((await import('./checkpoint')).checkpointExists).mockResolvedValue(false);
    vi.mocked((await import('./checkpoint')).loadMeta).mockResolvedValue({ status: 'running' } as any);
    vi.mocked((await import('./governor')).runGovernor).mockRejectedValueOnce(new Error('Safe Mode Crash'));

    await generateBlueprintSafe('prompt', config, 'sess-crash', emit);

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Safe Mode Crash' }));
    expect((await import('./checkpoint')).saveMeta).toHaveBeenCalledWith('sess-crash', expect.objectContaining({ status: 'partial' }));
  });
});
