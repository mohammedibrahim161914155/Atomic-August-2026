import { describe, it, expect, vi } from 'vitest';
import { generateBlueprint } from './index';
import { generateOutputBundle as generateBlueprintBundle } from './bundleGenerator';
import {
  saveCheckpoint, loadCheckpoint, checkpointExists,
  saveMeta, loadMeta,
  pruneOldSessions, isValidSessionId
} from './checkpoint';
import * as storeModule from './store';

vi.mock('./openrouter');

describe('Core Pipeline Integration', () => {
  const mockConfig = {
    provider: 'openrouter' as const,
    apiKey: 'test-key',
    fastModel: 'fast-model',
    proModel: 'pro-model',
  };

  it('fast mode emits session_start and does not emit error', async () => {
    const emitted: string[] = [];
    await generateBlueprint(
      'Make a fast app',
      mockConfig,
      (event) => { emitted.push(event.type); },
      'fast',
      'test-session-fast'
    );
    expect(emitted).toContain('session_start');
    expect(emitted).not.toContain('error');
  });

  it('safe mode emits session_start and does not emit error', async () => {
    const emitted: string[] = [];
    await generateBlueprint(
      'Make a safe app',
      mockConfig,
      (event) => { emitted.push(event.type); },
      'safe',
      'test-session-safe'
    );
    expect(emitted).toContain('session_start');
    expect(emitted).not.toContain('error');
  });

  it('safe mode checkpoint recovery path re-emits session_start without error', async () => {
    const emitted: string[] = [];
    // Second run against same session exercises checkpoint reload paths
    await generateBlueprint(
      'Make a safe app',
      mockConfig,
      (event) => { emitted.push(event.type); },
      'safe',
      'test-session-safe'
    );
    expect(emitted).toContain('session_start');
    expect(emitted).not.toContain('error');
  });

  it('bundle generator returns a defined bundle object', async () => {
    const bundle = await generateBlueprintBundle({} as any, {} as any, mockConfig);
    expect(bundle).toBeDefined();
  });

  it('checkpoint round-trip works through mocked store', async () => {
    const mockMeta = {
      id: 'test-session',
      prompt: 'test prompt',
      mode: 'fast' as const,
      created_at: new Date().toISOString(),
      status: 'running' as const,
      last_checkpoint: null,
    };

    const mockStore = {
      set: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(JSON.stringify(mockMeta)),
      exists: vi.fn().mockResolvedValue(true),
      del: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn().mockResolvedValue(['meta:1', 'meta:2']),
      incr: vi.fn().mockResolvedValue(1),
      decr: vi.fn().mockResolvedValue(0),
      expire: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(storeModule, 'getStore').mockResolvedValue(mockStore as any);

    await saveCheckpoint('session', 'key', { data: 1 });
    expect(mockStore.set).toHaveBeenCalledWith(
      'ck:session:key',
      JSON.stringify({ data: 1 })
    );

    const loaded = await loadCheckpoint('session', 'key');
    expect(loaded).toEqual(mockMeta);

    const exists = await checkpointExists('session', 'key');
    expect(exists).toBe(true);

    await saveMeta('session', mockMeta);
    expect(mockStore.set).toHaveBeenCalledWith(
      'meta:session',
      JSON.stringify(mockMeta)
    );

    const meta = await loadMeta('session');
    expect(meta).toEqual(mockMeta);

    vi.restoreAllMocks();
  });

  it('isValidSessionId accepts valid UUID v4 and rejects short strings', () => {
    expect(isValidSessionId('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe(true);
    expect(isValidSessionId('no')).toBe(false);
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId(123 as any)).toBe(false);
  });

  it('pruneOldSessions runs without throwing', async () => {
    await expect(pruneOldSessions()).resolves.not.toThrow();
  });
});
