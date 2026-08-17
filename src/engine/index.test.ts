import { describe, it, vi, expect, afterEach } from 'vitest';
import { generateBlueprint } from './index';

vi.mock('./checkpoint', () => ({
  isValidSessionId: vi.fn().mockReturnValue(true),
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
  saveMeta: vi.fn(),
  loadMeta: vi.fn(),
  saveCheckpoint: vi.fn()
}));

vi.mock('./governor', () => ({ runGovernor: vi.fn().mockResolvedValue({ intent: { verdict: 'approved' }, tokens_used: 0 }) }));
vi.mock('./pillarRunner', () => ({ runPillar: vi.fn().mockResolvedValue({ summary: 'test', agents: [] }) }));
vi.mock('./prosecutor', () => ({ runProsecutor: vi.fn().mockResolvedValue({ verdict: 'approved' }) }));
vi.mock('./rerun', () => ({ runRerunLoop: vi.fn().mockImplementation(p => p) }));
vi.mock('./synthesizer', () => ({ runSynthesizer: vi.fn().mockResolvedValue({ title: 'test blueprint' }) }));

vi.mock('./openrouter');

vi.mock('./safeMode', () => ({ generateBlueprintSafe: vi.fn() }));

describe('Index generated', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('covers abort signals', async () => {
    const config: any = { provider: 'openrouter', apiKey: 'test', fastModel: 'm1', proModel: 'm2' };
    const ac = new AbortController();
    ac.abort();
    const emit = vi.fn();
    await generateBlueprint('prompt', config, emit, 'fast', 'session-123', ac.signal);
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'complete' }));
  });

  it('covers existing session id', async () => {
    const config: any = { provider: 'openrouter', apiKey: 'test', fastModel: 'm1', proModel: 'm2' };
    const emit = vi.fn();
    await generateBlueprint('prompt', config, emit, 'fast', 'session-456');
    expect(emit).toHaveBeenCalled();
  });

  it('generates properly without any checkpoints in fast mode', async () => {
    vi.mocked((await import('./checkpoint')).checkpointExists).mockResolvedValue(false);
    const config: any = { provider: 'openrouter', apiKey: 'test', fastModel: 'm1', proModel: 'm2' };
    const emit = vi.fn();
    await generateBlueprint('new prompt', config, emit, 'fast', 'session-new');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'complete' }));
  });

  it('restores from all checkpoints properly in fast mode', async () => {
    vi.mocked((await import('./checkpoint')).checkpointExists).mockResolvedValue(true);
    vi.mocked((await import('./checkpoint')).loadCheckpoint).mockImplementation(async (session, key) => {
      if (key === 'intent') return { verdict: 'approved' };
      if (key === 'blueprint') return { title: 'Restored blueprint', quality_score: 100, sections: {} };
      if (key.startsWith('pillar_')) return { summary: 'test', agents: [] };
      return { verdict: 'approved', summary: 'test', gaps: [], gaps_found: 0 };
    });
    const config: any = { provider: 'openrouter', apiKey: 'test', fastModel: 'm1', proModel: 'm2' };
    const emit = vi.fn();
    await generateBlueprint('prompt', config, emit, 'fast', 'session-restored');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'complete' }));
  });

  it('emits error if the pipeline throws', async () => {
    const emit = vi.fn();
    const config: any = { provider: 'openrouter', apiKey: 'test', fastModel: 'm1', proModel: 'm2' };
    vi.mocked((await import('./checkpoint')).checkpointExists).mockResolvedValue(false);
    vi.mocked((await import('./governor')).runGovernor).mockRejectedValueOnce(new Error('Pipeline crash'));
    
    await generateBlueprint('prompt', config, emit, 'fast', 'sess-err');
    
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Pipeline crash' }));
  });

  it('delegates to generateBlueprintSafe for safe modes', async () => {
    const emit = vi.fn();
    const config: any = { provider: 'openrouter', apiKey: 'test', fastModel: 'm1', proModel: 'm2' };

    await generateBlueprint('prompt', config, emit, 'safe', 'sess-safe');
    expect((await import('./safeMode')).generateBlueprintSafe).toHaveBeenCalled();
  });
});
