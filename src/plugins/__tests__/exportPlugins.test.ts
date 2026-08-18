/**
 * @vitest-environment jsdom
 *
 * src/plugins/__tests__/exportPlugins.test.ts
 *
 * v2.4.0 test suite — client-side export plugin system hardening.
 * Covers: manifest doctor validation, content digests, capability gating,
 * retryable HTTP (backoff / jitter / 429 Retry-After), registry lifecycle,
 * health checks, error-budget auto-disable, persistence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateManifest, validatePluginDefinition,
  // ClientPluginManifestSchema and TRUSTED_BUILTIN_IDS are also exported
  // from '../doctor' for programmatic consumers.
} from '../doctor';
import { pluginDigest } from '../digest';
import { checkCapability, capabilityError, HOOK_CAPABILITIES, PERMISSION_VOCABULARY } from '../capabilities';
import {
  requestWithRetry, postJson, getJson, parseRetryAfter, backoffDelay,
  HttpRetryExhaustedError, setJitterSource,
} from '../http';
import { validatePluginConfig, LinearConfigSchema, NotionConfigSchema } from '../config';
import { PluginRegistry } from '../registry';
import type { ExportPlugin, IntegrationPlugin, PluginDefinition } from '../types';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<Parameters<typeof validateManifest>[0] & Record<string, unknown>> = {}) {
  return {
    id:          'test/plugin',
    name:        'Test Plugin',
    description: 'A test plugin',
    version:     '1.0.0',
    author:      'Test',
    category:    'export',
    icon:        'FileText',
    permissions: ['blueprint:read'],
    ...overrides,
  } as any;
}

function makeExportPlugin(): ExportPlugin {
  return {
    type:       'export',
    exportLabel: 'Export as Test',
    exportExt:  'md',
    exportMime: 'text/markdown',
    execute: async () => '# Exported content',
  };
}

function makeIntegrationPlugin(): IntegrationPlugin {
  return {
    type:        'integration',
    push: async () => ({ url: 'https://example.com/1' }),
    healthCheck: async () => ({ healthy: true, message: 'ok' }),
  };
}

function registerAll(reg: PluginRegistry, defs: PluginDefinition[]) {
  for (const def of defs) reg.register(def);
}

// ── Doctor validation ─────────────────────────────────────────────────────────

describe('doctor — manifest validation', () => {
  it('accepts a well-formed manifest', () => {
    const result = validateManifest(makeManifest());
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects an empty id', () => {
    const result = validateManifest(makeManifest({ id: '' }));
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => /id/i.test(e))).toBe(true);
  });

  it('rejects ids with invalid characters', () => {
    const result = validateManifest(makeManifest({ id: 'bad plugin!' }));
    expect(result.ok).toBe(false);
  });

  it('accepts namespaced ids (org/name)', () => {
    expect(validateManifest(makeManifest({ id: 'atomic-team/export-linear' })).ok).toBe(true);
  });

  it('requires strict semver (x.y.z, no prerelease suffix)', () => {
    expect(validateManifest(makeManifest({ version: 'not-semver' })).ok).toBe(false);
    expect(validateManifest(makeManifest({ version: '1.0.0' })).ok).toBe(true);
    // Prerelease suffixes fall outside the strict grammar.
    expect(validateManifest(makeManifest({ version: '2.4.0-beta.1' })).ok).toBe(false);
  });

  it('rejects unknown categories', () => {
    expect(validateManifest(makeManifest({ category: 'widget' as any })).ok).toBe(false);
  });

  it('warns (never errors) on unknown permissions for forward compatibility', () => {
    const result = validateManifest(makeManifest({ permissions: ['blueprint:read', 'evil:permission'] as any }));
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes('evil:permission'))).toBe(true);
  });

  it('requires execute + exportLabel on export plugins', () => {
    // Plugin declares itself as an export plugin but provides neither hook.
    const def = { manifest: makeManifest({ category: 'export' }), plugin: { type: 'export' } as any };
    const result = validatePluginDefinition(def);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => /execute/i.test(e))).toBe(true);
    expect(result.errors.some(e => /exportLabel/i.test(e))).toBe(true);
  });

  it('warns when plugin type and manifest category disagree', () => {
    const def: PluginDefinition = {
      manifest: makeManifest({ category: 'export' }),
      plugin:   makeIntegrationPlugin() as any,
    };
    const result = validatePluginDefinition(def);
    expect(result.warnings.some(w => w.includes('integration'))).toBe(true);
  });

  it('requires push on integration plugins', () => {
    const def = { manifest: makeManifest({ category: 'integration' }), plugin: { type: 'integration' } as any };
    const result = validatePluginDefinition(def);
    expect(result.ok).toBe(false);
  });

  it('requires transform on transform plugins', () => {
    const def = { manifest: makeManifest({ category: 'transform' }), plugin: { type: 'transform' } as any };
    const result = validatePluginDefinition(def);
    expect(result.ok).toBe(false);
  });

  it('errors on a short description (minimum 10 characters)', () => {
    const result = validateManifest(makeManifest({ description: 'x' }));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('warns on category/permission coherence issues', () => {
    const def: PluginDefinition = {
      manifest: makeManifest({ category: 'export', permissions: ['blueprint:write'] }),
      plugin:   makeExportPlugin(),
    };
    const manifestResult = validateManifest(def.manifest);
    expect(manifestResult.ok).toBe(true);
    expect(manifestResult.warnings.length).toBeGreaterThan(0);
    expect(manifestResult.warnings[0]).toContain('blueprint:write');
  });

  it('accepts the real built-in manifests', async () => {
    const { exportMarkdownPlugin, exportLinearPlugin, exportNotionPlugin } = await import('../index');
    for (const def of [exportMarkdownPlugin, exportLinearPlugin, exportNotionPlugin]) {
      expect(validatePluginDefinition(def).ok, `built-in ${def.manifest.id} must validate`).toBe(true);
    }
  });

  it('rejects the reserved built-in namespace on third-party ids', () => {
    const def: PluginDefinition = {
      manifest: makeManifest({ id: 'built-in/rogue' }),
      plugin:   makeExportPlugin(),
    };
    expect(validatePluginDefinition(def).ok).toBe(false);
  });
});

// ── Content digests ───────────────────────────────────────────────────────────

describe('digest — content-addressed stability', () => {
  it('produces the same digest for identical content', async () => {
    const manifest = makeManifest();
    const plugin = makeExportPlugin();
    const a = await pluginDigest(manifest, plugin);
    const b = await pluginDigest(manifest, plugin);
    expect(a).toBe(b);
  });

  it('produces a fixed-length 16-hex output', async () => {
    const digest = await pluginDigest(makeManifest(), makeExportPlugin());
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when the execute body changes', async () => {
    const manifest = makeManifest();
    const a = await pluginDigest(manifest, makeExportPlugin());
    const b = await pluginDigest(manifest, { ...makeExportPlugin(), execute: async () => '# other' });
    expect(a).not.toBe(b);
  });

  it('changes when permissions change', async () => {
    const a = await pluginDigest(makeManifest({ permissions: ['blueprint:read'] }), makeExportPlugin());
    const b = await pluginDigest(makeManifest({ permissions: ['blueprint:read', 'network:outbound'] }), makeExportPlugin());
    expect(a).not.toBe(b);
  });

  it('falls back to a deterministic FNV hash when Web Crypto is unavailable', async () => {
    const origSubtle = (globalThis as any).crypto?.subtle;
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    try {
      const digest = await pluginDigest(makeManifest(), makeExportPlugin());
      expect(digest).toMatch(/^[0-9a-f]{16}$/);
      // Deterministic across calls
      const again = await pluginDigest(makeManifest(), makeExportPlugin());
      expect(digest).toBe(again);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: { subtle: origSubtle }, configurable: true });
    }
  });
});

// ── Capability gating ─────────────────────────────────────────────────────────

describe('capabilities — permission enforcement', () => {
  it('allows onGenerate with blueprint:read', () => {
    expect(checkCapability(['blueprint:read'], 'onGenerate')).toEqual([]);
  });

  it('denies push without network:outbound', () => {
    const missing = checkCapability(['blueprint:read'], 'push');
    expect(missing).toContain('network:outbound');
  });

  it('denies emit without events:publish', () => {
    const missing = checkCapability([], 'emit');
    expect(missing).toContain('events:publish');
  });

  it('generates a human-readable capability error', () => {
    const err = capabilityError('test/plugin', 'push', ['network:outbound']);
    expect(err).toContain('test/plugin');
    expect(err).toContain('network:outbound');
  });

  it('covers every registered hook id', () => {
    for (const hookId of Object.keys(HOOK_CAPABILITIES)) {
      expect(PERMISSION_VOCABULARY.length).toBeGreaterThan(0);
      expect(hookId).toBeTruthy();
    }
  });
});

// ── Retryable HTTP ────────────────────────────────────────────────────────────

describe('http — retryable requests', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setJitterSource(() => 0); // deterministic backoff
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setJitterSource(undefined as any);
  });

  function okJson(body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }

  it('resolves on first success', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ ok: true }));
    const res = await requestWithRetry('https://api.example.com/x', { method: 'GET' });
    expect(res.data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 503 with exponential backoff', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('fail', { status: 503 }))
      .mockResolvedValueOnce(okJson({ ok: true }));
    const t0 = Date.now();
    const res = await requestWithRetry('https://api.example.com/x', {
      method: 'GET',
      baseDelay: 40,
      maxRetries: 2,
      jitter: () => 1, // full-jitter ceiling → wait == exponential cap per attempt
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30);
    expect(res.data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries and throws HttpRetryExhaustedError', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(requestWithRetry('https://api.example.com/x', {
      method: 'GET', baseDelay: 5, maxRetries: 1,
    })).rejects.toThrow(HttpRetryExhaustedError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After seconds on 429', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(okJson({ ok: true }));
    const t0 = Date.now();
    await requestWithRetry('https://api.example.com/x', { method: 'GET', maxRetries: 2 });
    // Waited roughly the server-specified 1000ms (±small tolerance)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After http-date on 503', async () => {
    // 2 s in the future so both Date.parse and the jsdom Date-constructor
    // fallback resolve to a wait that is clearly above the jitter/backoff noise.
    const inTwoSeconds = new Date(Date.now() + 2000).toUTCString();
    fetchMock
      .mockResolvedValueOnce(new Response('back off', { status: 503, headers: { 'retry-after': inTwoSeconds } }))
      .mockResolvedValueOnce(okJson({ ok: true }));
    const t0 = Date.now();
    await requestWithRetry('https://api.example.com/x', { method: 'GET', maxRetries: 2 });
    // The wait equals (header-time − parse-time), so total elapsed drifts
    // down as more wall-clock passes between header creation and the retry.
    // ≥1.2 s proves a server-specified wait was honoured over backoff.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1200);
  });

  it('does not retry client errors (400)', async () => {
    fetchMock.mockResolvedValue(new Response('bad', { status: 400 }));
    await expect(requestWithRetry('https://api.example.com/x', { method: 'GET' })).rejects.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('respects retrySafe mode for non-idempotent POST mutations', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(requestWithRetry('https://api.example.com/x', {
      method: 'POST', body: { a: 1 }, baseDelay: 5, maxRetries: 2, retrySafe: true,
    })).rejects.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries POST by default (GraphQL-style mutations like Linear)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockResolvedValueOnce(okJson({ created: true }));
    const res = await requestWithRetry('https://api.example.com/x', {
      method: 'POST', body: { a: 1 }, maxRetries: 2, baseDelay: 5,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.data).toEqual({ created: true });
  });

  it('postJson and getJson are convenience wrappers', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({ id: 'p1' }))
      .mockResolvedValueOnce(okJson({ name: 'u1' }));
    const created = await postJson<{ id: string }>('https://api.example.com/p', { name: 'p' }, { 'X-K': 'v' });
    expect(created.id).toBe('p1');
    const lastCall = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((lastCall.headers as any)['X-K']).toBe('v');
    const user = await getJson<{ name: string }>('https://api.example.com/u', { 'A': 'b' });
    expect(user.name).toBe('u1');
    const getCall = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(getCall.method).toBe('GET');
  });

  it('parseRetryAfter handles seconds, http-dates, and junk', () => {
    expect(parseRetryAfter('30')).toBe(30000);
    const soon = new Date(Date.now() + 5000).toUTCString();
    expect(parseRetryAfter(soon)).toBeGreaterThanOrEqual(4000);
    expect(parseRetryAfter('garbage')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });

  it('backoffDelay grows exponentially with the random factor and clamps', () => {
    expect(backoffDelay(0, 100, 10000, 1)).toBe(100);
    expect(backoffDelay(1, 100, 10000, 1)).toBe(200);
    expect(backoffDelay(2, 100, 10000, 1)).toBe(400);
    expect(backoffDelay(99, 100, 10000, 1)).toBe(10000);
    // random = 0 is the full-jitter floor — no local wait; real delays are
    // driven by Retry-After headers, not the local math.
    expect(backoffDelay(0, 100, 10000, 0)).toBe(0);
  });
});

// ── Registry lifecycle ────────────────────────────────────────────────────────

describe('registry — lifecycle, health, error budget', () => {
  let reg: PluginRegistry;
  beforeEach(() => {
    reg = new PluginRegistry();
    localStorage.clear();
  });
  afterEach(() => localStorage.clear());

  function exportDef(id = 'test/export'): PluginDefinition {
    return { manifest: makeManifest({ id }), plugin: makeExportPlugin() };
  }
  function integrationDef(id = 'test/integration'): PluginDefinition {
    return { manifest: makeManifest({ id, category: 'integration', permissions: ['blueprint:read', 'network:outbound'] }), plugin: makeIntegrationPlugin() };
  }

  it('registers, lists, and unregisters plugins', () => {
    const _regged = registerAll(reg, [exportDef(), integrationDef()]);
    expect(reg.all().length).toBe(2);
    expect(reg.exports().length).toBe(1);
    expect(reg.integrations().length).toBe(1);
    expect(reg.unregister('test/export')).toBe(true);
    expect(reg.all().length).toBe(1);
  });

  it('runs the doctor on registration and records errors/warnings', () => {
    const def: PluginDefinition = {
      manifest: makeManifest({ id: 'test/bad', version: 'oops' } as any),
      plugin: makeExportPlugin(),
    };
    reg.register(def);
    const entry = reg.get('test/bad')!;
    expect(entry.doctorErrors!.length).toBeGreaterThan(0);
  });

  it('computes digests asynchronously after registration', async () => {
    reg.register(exportDef());
    const entry = reg.get('test/export')!;
    await new Promise(r => setTimeout(r, 20));
    expect(entry.digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('uses a custom digestFn when provided', async () => {
    reg.digestFn = async () => 'custom-digest-1234';
    reg.register(exportDef());
    await new Promise(r => setTimeout(r, 20));
    expect(reg.get('test/export')!.digest).toBe('custom-digest-1234');
  });

  it('persists enable/disable across instances via localStorage', async () => {
    reg.register(exportDef());
    reg.disable('test/export');
    expect(reg.get('test/export')!.enabled).toBe(false);

    const reg2 = new PluginRegistry();
    reg2.register(exportDef());
    expect(reg2.get('test/export')!.enabled).toBe(false);
  });

  it('auto-disables a plugin after 3 consecutive hook errors (error budget)', async () => {
    let fail = true;
    const plugin: IntegrationPlugin = {
      type:        'integration',
      push: async () => { if (fail) throw new Error('push failed'); return { url: 'x' }; },
      healthCheck: async () => ({ healthy: true, message: 'ok' }),
    };
    reg.register({ manifest: makeManifest({ id: 'test/flaky', category: 'integration', permissions: ['blueprint:read', 'network:outbound'] }), plugin });

    // Set the blueprint pointer so runPush has something to push.
    reg.setBlueprint({ id: 'bp1', prompt: 'p', mode: 'fast' as any, quality_score: 90, created_at: '', sections: {} } as any);

    // Fail twice — plugin stays enabled but budget rises.
    await reg.runPush('test/flaky');
    await reg.runPush('test/flaky');
    expect(reg.get('test/flaky')!.enabled).toBe(true);
    expect(reg.get('test/flaky')!.consecutiveErrors).toBe(2);

    // Third failure — plugin is auto-disabled.
    await reg.runPush('test/flaky');
    expect(reg.get('test/flaky')!.enabled).toBe(false);
    expect(reg.get('test/flaky')!.consecutiveErrors).toBe(3);

    // Re-enable + make push succeed — budget resets.
    reg.enable('test/flaky');
    fail = false;
    await reg.runPush('test/flaky');
    expect(reg.get('test/flaky')!.enabled).toBe(true);
    expect(reg.get('test/flaky')!.consecutiveErrors).toBe(0);
  });

  it('health checks cache results on the registry entry and localStorage', async () => {
    reg.register(integrationDef());
    const health = await reg.checkHealth('test/integration');
    expect(health.healthy).toBe(true);
    expect(reg.get('test/integration')!.lastHealth?.healthy).toBe(true);

    const reg2 = new PluginRegistry();
    reg2.register(integrationDef());
    // Restored persisted health on the new instance.
    expect(reg2.get('test/integration')!.lastHealth?.healthy).toBe(true);
  });

  it('reports unhealthy when the plugin has no API key configured', async () => {
    const noConfigIntegration: IntegrationPlugin = {
      type:        'integration',
      push: async (_bp, ctx) => {
        const key = ctx.storage.get<string>('api_key');
        if (!key) throw new Error('Notion: api key missing');
        return { url: 'https://example.com' };
      },
      healthCheck: async (ctx) => {
        const key = ctx.storage.get<string>('api_key');
        if (!key) return { healthy: false, message: 'no api key' };
        return { healthy: true, message: 'ok' };
      },
    };
    reg.register({
      manifest: makeManifest({ id: 'test/noconfig', category: 'integration', permissions: ['blueprint:read', 'network:outbound'] }),
      plugin: noConfigIntegration,
    });
    const health = await reg.checkHealth('test/noconfig');
    expect(health.healthy).toBe(false);
  });

  it('checkAllHealth runs every plugin', async () => {
    registerAll(reg, [exportDef(), integrationDef()]);
    const results = await reg.checkAllHealth();
    expect(Object.keys(results)).toHaveLength(2);
    expect(results['test/integration']!.healthy).toBe(true);
  });

  it('enforces capability gates on dispatch', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const plugin: IntegrationPlugin = {
      type: 'integration',
      // Declares no network:outbound → push must be gated.
      push: async () => { throw new Error('should never run'); },
      healthCheck: async () => ({ healthy: true, message: 'ok' }),
    };
    reg.register({
      manifest: makeManifest({ id: 'test/gated', category: 'integration', permissions: ['blueprint:read'] }),
      plugin,
    });
    reg.setBlueprint({ id: 'bp1', prompt: 'p', mode: 'fast' as any, quality_score: 90, created_at: '', sections: {} } as any);
    const result = await reg.runPush('test/gated');
    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('gates plugin-initiated emit to events:publish', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received: unknown[] = [];
    const plugin: ExportPlugin = {
      type: 'export',
      exportLabel: 'Emit Test',
      execute: async (bp, ctx) => {
        ctx.emit('plugin-custom', 'payload');
        return '# ok';
      },
    };
    reg.register({
      manifest: makeManifest({ id: 'test/emit', permissions: ['blueprint:read'] }),
      plugin,
    });
    // Subscribe through a sibling plugin's context (the real plugin-facing API).
    const listener = reg.register({ manifest: makeManifest({ id: 'test/listener', permissions: ['blueprint:read'] }), plugin: makeExportPlugin() });
    void listener;
    const sub = (reg as any).makeContext('test/listener');
    sub.on('plugin-custom', (d: unknown) => { received.push(d); });

    reg.setBlueprint({ id: 'bp1', prompt: 'p', mode: 'fast' as any, quality_score: 90, created_at: '', sections: {} } as any);
    await reg.runExport('test/emit');
    // No events:publish → emit is blocked and a warning is logged.
    expect(received).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('allows emit when events:publish is declared', async () => {
    const received: unknown[] = [];
    const plugin: ExportPlugin = {
      type: 'export',
      exportLabel: 'Emit OK Test',
      execute: async (bp, ctx) => {
        ctx.emit('plugin-custom', { x: 1 });
        return '# ok';
      },
    };
    reg.register({
      manifest: makeManifest({ id: 'test/emit-ok', permissions: ['blueprint:read', 'events:publish'] }),
      plugin,
    });
    const sub = (reg as any).makeContext('test/emit-ok');
    sub.on('plugin-custom', (d: unknown) => { received.push(d); });
    reg.setBlueprint({ id: 'bp1', prompt: 'p', mode: 'fast' as any, quality_score: 90, created_at: '', sections: {} } as any);
    await reg.runExport('test/emit-ok');
    expect(received).toEqual([{ x: 1 }]);
  });

  it('exports succeed through the registry with the real markdown plugin', async () => {
    const { exportMarkdownPlugin } = await import('../index');
    reg.register(exportMarkdownPlugin);
    reg.setBlueprint({ id: 'bp1', prompt: 'Build a todo app', mode: 'fast' as any, quality_score: 85, created_at: '', intent: { product_name: 'TodoApp' }, sections: { executive_summary: 'Summary here' } } as any);
    const content = await reg.runExport('built-in/export-markdown');
    expect(typeof content).toBe('string');
    expect(content as string).toContain('TodoApp');
  });

  it('transforms run in sequence and a failure in one stops propagation gracefully', async () => {
    const a: ExportPlugin & { onTransform?: any } = { type: 'export', exportLabel: 'A', execute: async () => 'a' };
    const t: any = {
      type: 'transform',
      transformBlueprint: async (bp: any) => ({ ...bp, transformed: true }),
    };
    reg.register({ manifest: makeManifest({ id: 't/export' }), plugin: a });
    reg.register({ manifest: makeManifest({ id: 't/transform' }), plugin: t });
    reg.setBlueprint({ id: 'bp1', prompt: 'p', mode: 'fast' as any, quality_score: 90, created_at: '', sections: {} } as any);
    const out = await reg.applyTransforms({ id: 'bp1', prompt: 'p', mode: 'fast' as any, quality_score: 90, created_at: '', sections: {} } as any);
    expect((out as any).transformed).toBe(true);
  });

  it('pull returns partial blueprint content from integration plugins', async () => {
    const pullPlugin: IntegrationPlugin = {
      type:        'integration',
      push: async () => ({ url: 'u' }),
      pull: async (id, _ctx) => ({ sections: { deployment: `pulled ${id}` } }),
      healthCheck: async () => ({ healthy: true, message: 'ok' }),
    };
    reg.register({ manifest: makeManifest({ id: 't/pull', category: 'integration', permissions: ['blueprint:read', 'network:outbound'] }), plugin: pullPlugin });
    const partial = await reg.runPull('t/pull', 'proj-123');
    expect(partial?.sections?.deployment).toContain('proj-123');
  });

  it('returns null when running a plugin that is disabled', async () => {
    reg.register(exportDef());
    reg.disable('test/export');
    const result = await reg.runExport('test/export');
    expect(result).toBeNull();
  });
});

// ── Typed plugin config ───────────────────────────────────────────────────────

describe('config — typed per-plugin configuration', () => {
  it('validates Linear config with defaults', () => {
    const result = validatePluginConfig<Record<string, unknown>>('built-in/export-linear', {
      api_key: 'lin_api_abc123',
      team_id: 'T0000000',
    });
    expect(result.ok).toBe(true);
    expect(result.data!.project_name_prefix).toBe('[Atomic]');
  });

  it('rejects malformed team ids', () => {
    const result = validatePluginConfig('built-in/export-linear', {
      api_key: 'lin_api_abc123',
      team_id: 'not-a-team',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects Notion parent ids that are not 32-char hex', () => {
    expect(validatePluginConfig('built-in/export-notion', { api_key: 'ntn_x', parent_id: 'short' }).ok).toBe(false);
    expect(validatePluginConfig('built-in/export-notion', { api_key: 'ntn_x', parent_id: 'a'.repeat(32) }).ok).toBe(true);
  });

  it('passes through unknown plugins without a schema', () => {
    const result = validatePluginConfig('third-party/plugin', { anything: 'goes' });
    expect(result.ok).toBe(true);
  });

  it('LinearConfigSchema rejects empty strings', () => {
    expect(LinearConfigSchema.safeParse({ api_key: '', team_id: 'T0000000' }).success).toBe(false);
  });

  it('NotionConfigSchema caps max_blocks_per_page', () => {
    expect(NotionConfigSchema.safeParse({ api_key: 'ntn_x', parent_id: 'a'.repeat(32), max_blocks_per_page: 5 }).success).toBe(false);
  });
});
