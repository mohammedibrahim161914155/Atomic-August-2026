import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateManifest } from '../engine/doctor';
import { pluginDigest } from '../engine/digest';
import { evaluateUntil, isValidUntil } from '../engine/runtime';
import {
  effectiveCapabilities, trustView, grantTrust, revokeTrust,
  decideCapability, isTrusted, GRANTABLE_CAPABILITIES,
} from '../engine/trust';
import { BUILT_IN_PLUGINS } from '../engine/builtIns';
import { PIPELINE_MANIFESTS } from '../engine/skillPack';
import {
  generateSkillPack, listSkillPacks,
} from '../engine/skillPack';
import {
  listPlugins, getPlugin, getPublicPlugin, installPlugin, uninstallPlugin,
} from '../engine/registry';
import { publicManifest, type EnginePluginManifest } from '../engine/schema';

// ── In-memory checkpoint mock: grantTrust saves records that
//    effectiveCapabilities/loadRecord actually read back. ─────────────────────
const mem = new Map<string, unknown>();
vi.mock('../../engine/checkpoint', () => ({
  isValidSessionId: (id: unknown) =>
    typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
  saveCheckpoint: vi.fn(async (session: string, key: string, data: unknown) => {
    mem.set(`${session}:${key}`, data);
  }),
  loadCheckpoint: vi.fn(async (session: string, key: string) => {
    const v = mem.get(`${session}:${key}`);
    return v === undefined ? null : v;
  }),
}));

vi.mock('../../engine/openrouter', () => ({
  generateText: vi.fn(async (_p: string, _c: any, _s?: string, _o?: any) => ({
    text: 'review output for the stage',
    tokens_used: 100,
  })),
  generateJson: vi.fn(async (_p: string, _c: any, schema: any) => ({
    data: schema.parse({ accuracy: 90, completeness: 88, actionability: 85, clarity: 92 }),
    tokens_used: 40,
  })),
  getAi: vi.fn(),
  createQueue: vi.fn(() => ({ add: (fn: any) => fn() })),
  queueStorage: { run: (_q: any, fn: any) => fn(), getStore: () => null },
}));

// session ids must pass isValidSessionId (uuid v4 shape, 36 chars)
const SESSION = 'a0000000-b000-4000-8000-000000000001';
const MODEL_CONFIG = {
  provider: 'openrouter' as const,
  apiKey: 'sk-test',
  fastModel: 'mock-fast',
  proModel: 'mock-pro',
};

beforeEach(() => {
  mem.clear();
});

// Non-trusted user manifests used across the trust/runtime suites so that
// grant/deny semantics can be exercised without tripping the built-in trust
// allow-list.
const USER_MANIFEST = {
  id: 'user:unknown-test', specVersion: '1.0.0', name: 'Unknown Test', version: '1.0.0',
  description: 'An unknown plugin for trust isolation testing', kind: 'reporter', tags: [],
  capabilities: ['blueprint:read'], skippable: true,
} as unknown as EnginePluginManifest;

const USER_REVIEWER = {
  id: 'user:reviewer-test', specVersion: '1.0.0', name: 'Reviewer Test', version: '1.0.0',
  description: 'A reviewer plugin for capability gating tests', kind: 'reviewer', tags: [],
  capabilities: ['blueprint:read'], skippable: true,
  pipeline: { stages: [{ id: 'review', kind: 'review', prompt: 'Review the blueprint thoroughly and score it', max_tokens: 1000, repeat: true, until: 'composite>=85', max_iterations: 2 }] },
} as unknown as EnginePluginManifest;

describe('plugin manifest schema', () => {
  it('accepts a minimal valid manifest', () => {
    const result = validateManifest({
      id: 'example-basic',
      specVersion: '1.0.0',
      name: 'Basic',
      version: '1.0.0',
      description: 'Minimal plugin',
      kind: 'reporter',
      tags: [],
      capabilities: [],
      skippable: true,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts namespaced ids', () => {
    expect(validateManifest({
      id: 'scope:name', specVersion: '1.0.0', name: 'Scoped', version: '1.0.0',
      description: 'Namespaced id test', kind: 'skill', tags: [], skippable: false,
    }).ok).toBe(true);
  });

  it('rejects a manifest missing required fields', () => {
    const result = validateManifest({ id: 'bad', name: 'Bad' });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects unknown kinds and invalid capability strings', () => {
    const badKind = validateManifest({
      id: 'unknown-kind', specVersion: '1.0.0', name: 'Unknown Kind', version: '1.0.0',
      description: 'x', kind: 'wizard', tags: [], capabilities: [], skippable: false,
    });
    expect(badKind.ok).toBe(false);

    const badCap = validateManifest({
      id: 'bad-capability', specVersion: '1.0.0', name: 'Bad Capability', version: '1.0.0',
      description: 'x', kind: 'reporter', tags: [],
      capabilities: ['reality:bend'], skippable: true,
    });
    expect(badCap.ok).toBe(false);
  });

  it('warns on kind/capability mismatches but not on clean manifests', () => {
    const warn = validateManifest({
      id: 'reporter-writer', specVersion: '1.0.0', name: 'Reporter Writer', version: '1.0.0',
      description: 'A read-only reporter that declares write caps', kind: 'reporter', tags: [],
      capabilities: ['blueprint:write'], skippable: true,
    });
    expect(warn.ok).toBe(true);
    expect(warn.warnings.length).toBeGreaterThan(0);

    const clean = validateManifest({
      id: 'clean-reviewer', specVersion: '1.0.0', name: 'Clean Reviewer', version: '1.0.0',
      description: 'A well-formed reviewer plugin with valid caps', kind: 'reviewer', tags: [],
      capabilities: ['blueprint:read'], skippable: true,
      pipeline: { stages: [{ id: 'r', kind: 'review', prompt: 'Review thoroughly', max_tokens: 1000, repeat: true, until: 'composite>=85', max_iterations: 2 }] },
    });
    expect(clean.ok).toBe(true);
    expect(clean.warnings).toHaveLength(0);
  });
});

describe('doctor cross-field rules', () => {
  it('errors when a repeat stage lacks an until expression', () => {
    const result = validateManifest({
      id: 'no-until', specVersion: '1.0.0', name: 'No Until', version: '1.0.0',
      description: 'A plugin missing its until expression', kind: 'reviewer', tags: [], capabilities: ['blueprint:read'], skippable: true,
      pipeline: { stages: [{ id: 'r', kind: 'review', prompt: 'Review thoroughly', max_tokens: 1000, repeat: true }] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('until'))).toBe(true);
  });

  it('errors on repeat stages with max_iterations=1', () => {
    const result = validateManifest({
      id: 'single-iteration', specVersion: '1.0.0', name: 'Single Iteration', version: '1.0.0',
      description: 'A repeat stage with one iteration only', kind: 'reviewer', tags: [], capabilities: [], skippable: true,
      pipeline: { stages: [{ id: 'r', kind: 'review', prompt: 'Review thoroughly', max_tokens: 1000, repeat: true, until: 'composite>=80', max_iterations: 1 }] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('max_iterations'))).toBe(true);
  });

  it('errors on select inputs with a default outside the options', () => {
    const result = validateManifest({
      id: 'select-default', specVersion: '1.0.0', name: 'Select Default', version: '1.0.0',
      description: 'A plugin with a bad select default', kind: 'reviewer', tags: [], capabilities: [], skippable: true,
      inputs: [{ name: 'mode', type: 'select', label: 'Mode', required: true, options: ['a', 'b'], default: 'z' }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('options'))).toBe(true);
  });

  it('warns when an exporter declares no outbound capability', () => {
    const result = validateManifest({
      id: 'silent-exporter', specVersion: '1.0.0', name: 'Silent Exporter', version: '1.0.0',
      description: 'An exporter declaring no outbound capability', kind: 'exporter', tags: [], capabilities: [], skippable: true,
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes('api:call'))).toBe(true);
  });
});

describe('content-addressed digests', () => {
  it('is stable for the same manifest', () => {
    const m = BUILT_IN_PLUGINS[0]!;
    expect(pluginDigest(m)).toBe(pluginDigest(m));
  });

  it('changes when behaviour-defining fields change', () => {
    const base = BUILT_IN_PLUGINS[0]!;
    const mutated = { ...base, capabilities: [...(base.capabilities ?? []), 'events'] } as unknown as EnginePluginManifest;
    expect(pluginDigest(mutated)).not.toBe(pluginDigest(base));
  });

  it('ignores cosmetic metadata (description/tag edits)', () => {
    const base = BUILT_IN_PLUGINS[0]!;
    const cosmetic = { ...base, description: base.description + ' (updated)', tags: ['new'] } as unknown as EnginePluginManifest;
    expect(pluginDigest(cosmetic)).toBe(pluginDigest(base));
  });

  it('is deterministic and short', () => {
    expect(pluginDigest(BUILT_IN_PLUGINS[1]!)).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(pluginDigest(BUILT_IN_PLUGINS[1]!))).toBe(true);
  });
});

describe('until expression evaluation (OpenDesign grammar)', () => {
  it('passes on composite thresholds', () => {
    expect(evaluateUntil('composite>=80', 85, 1)).toBe(true);
    expect(evaluateUntil('composite>=80', 79, 1)).toBe(false);
    expect(evaluateUntil('composite>80', 80, 1)).toBe(false);
  });

  it('passes on iteration thresholds', () => {
    expect(evaluateUntil('iterations>=2', 50, 2)).toBe(true);
    expect(evaluateUntil('iterations>=2', 50, 1)).toBe(false);
  });

  it('supports || combinations (all parts must be valid grammar)', () => {
    expect(evaluateUntil('composite>=90 || iterations>=3', 92, 3)).toBe(true);
    expect(evaluateUntil('composite>=90 || iterations>=3', 50, 2)).toBe(false);
    expect(isValidUntil('composite>=90 || iterations>=3')).toBe(true);
    expect(isValidUntil('iterations>=3')).toBe(true);
    // Invalid grammar anywhere rejects the whole expression.
    expect(isValidUntil('composite>=90 || eval(code)')).toBe(false);
  });

  it('rejects dangerous or malformed expressions', () => {
    for (const bad of ['eval("x")', 'iterations=3', 'composite<80', '', 'score>=', '90']) {
      expect(isValidUntil(bad)).toBe(false);
    }
  });
});

describe('trust store', () => {
  it('starts every unknown plugin restricted (prompt:inject only)', async () => {
    expect(await effectiveCapabilities(SESSION, USER_MANIFEST.id, USER_MANIFEST)).toEqual(['prompt:inject']);
  });

  it('grants capabilities per session and reflects them', async () => {
    const manifest = USER_MANIFEST;
    const granted = await grantTrust(SESSION, manifest.id, ['blueprint:read'], manifest);
    expect(granted).toEqual(['blueprint:read']);
    const caps = await effectiveCapabilities(SESSION, manifest.id, manifest);
    expect(caps).toContain('blueprint:read');
    expect(await decideCapability(SESSION, manifest.id, 'blueprint:read', manifest)).toBe(true);
    expect(await decideCapability(SESSION, manifest.id, 'api:call', manifest)).toBe(false);
  });

  it('re-locks grants when the manifest content changes (digest re-lock)', async () => {
    const base = USER_MANIFEST;
    await grantTrust(SESSION, base.id, ['blueprint:read'], base);
    const mutated = { ...base, capabilities: [...(base.capabilities ?? []), 'events'] } as unknown as EnginePluginManifest;
    expect(await effectiveCapabilities(SESSION, base.id, mutated)).toEqual(['prompt:inject']);
  });

  it('revokes all non-default capabilities', async () => {
    const manifest = USER_MANIFEST;
    await grantTrust(SESSION, manifest.id, ['blueprint:read'], manifest);
    await revokeTrust(SESSION, manifest.id);
    expect(await effectiveCapabilities(SESSION, manifest.id, manifest)).toEqual(['prompt:inject']);
  });

  it('rejects ungrantable and invalid inputs', async () => {
    const manifest = USER_MANIFEST;
    await expect(grantTrust(SESSION, manifest.id, ['prompt:inject'] as never, manifest)).rejects.toThrow();
    await expect(grantTrust('not-a-session', manifest.id, ['blueprint:read'], manifest)).rejects.toThrow();
    await expect(grantTrust(SESSION, manifest.id, [], manifest)).rejects.toThrow();
    expect(await trustView(SESSION, manifest.id, manifest)).toMatchObject({ trusted: false });
  });

  it('trusts built-ins implicitly without session grants', async () => {
    const id = BUILT_IN_PLUGINS[1]!.id;
    expect(isTrusted(id)).toBe(true);
    const caps = await effectiveCapabilities(SESSION, id, BUILT_IN_PLUGINS[1]!);
    expect(caps).toContain('api:call');
    const view = await trustView(SESSION, id, BUILT_IN_PLUGINS[1]!);
    expect(view.trusted).toBe(true);
  });
});

describe('plugin registry (boot)', () => {
  it('ships with the 4 pipeline skill packs + 3 engine built-ins', () => {
    const plugins = listPlugins();
    const ids = plugins.map((p) => p.manifest.id);
    for (const m of PIPELINE_MANIFESTS) expect(ids).toContain(m.id);
    for (const m of BUILT_IN_PLUGINS) expect(ids).toContain(m.id);
    expect(plugins.length).toBe(7);
    for (const p of plugins) expect(p.source).toBe('builtin');
  });

  it('exposes digests and valid doctor status for every boot plugin', () => {
    for (const p of listPlugins()) {
      expect(p.digest).toHaveLength(16);
      expect(p.doctor.ok).toBe(true);
    }
  });

  it('hides prompt bodies in the public view', () => {
    const reviewer = getPublicPlugin('builtin:blueprint-reviewer');
    expect(reviewer).toBeTruthy();
    const m = reviewer!.manifest;
    if (m.pipeline) {
      expect((m.pipeline.stages[0] as { prompt?: unknown }).prompt).toBeUndefined();
    }
    expect(JSON.stringify(m).includes('Review the provided blueprint')).toBe(false);
  });

  it('rejects installing invalid manifests', () => {
    const result = installPlugin({ id: 'u:x', name: 'X' });
    expect(result.entry).toBeUndefined();
    expect(result.doctor.ok).toBe(false);
  });

  it('installs valid user manifests and refuses to uninstall built-ins', () => {
    const { entry } = installPlugin({
      id: 'user:scratch', specVersion: '1.0.0', name: 'Scratch', version: '0.1.0',
      description: 'temporary plugin manifest', kind: 'reporter', tags: [], capabilities: [], skippable: true,
      pipeline: { stages: [{ id: 'r', kind: 'report', prompt: 'Report the findings', max_tokens: 500, repeat: false, max_iterations: 1 }] },
    });
    expect(entry?.source).toBe('user');
    expect(uninstallPlugin('builtin:cost-estimator')).toBe(false);
    expect(uninstallPlugin('user:scratch')).toBe(true);
    expect(getPlugin('user:scratch')).toBeUndefined();
  });
});

describe('runtime capability gating', () => {
  const costManifest = BUILT_IN_PLUGINS[1]! as never as EnginePluginManifest;

  it('runs a trusted built-in reporter plugin end-to-end', async () => {
    const { runPluginPipeline } = await import('../engine/runtime');
    const outcome = await runPluginPipeline({
      sessionId: SESSION,
      manifest: costManifest,
      config: MODEL_CONFIG,
      inputs: {},
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.errors).toHaveLength(0);
    for (const s of outcome.stages) expect(s.verdict).toBe('pass');
  });

  it('skips stages whose capability was not granted (degraded)', async () => {
    const reviewer = USER_REVIEWER;
    const { runPluginPipeline } = await import('../engine/runtime');
    const outcome = await runPluginPipeline({
      sessionId: SESSION,
      manifest: reviewer,
      config: MODEL_CONFIG,
      inputs: { focus: 'full' },
      blueprintText: 'A short blueprint stub.',
    });
    expect(outcome.status).toBe('degraded');
    expect(outcome.errors.some((e) => e.includes('blueprint:read not granted'))).toBe(true);
    expect(outcome.stages.length).toBe(0);
  });

  it('runs read stages once the capability is granted', async () => {
    const reviewer = USER_REVIEWER;
    await grantTrust(SESSION, reviewer.id, ['blueprint:read'], reviewer);
    const { runPluginPipeline } = await import('../engine/runtime');
    const outcome = await runPluginPipeline({
      sessionId: SESSION,
      manifest: reviewer,
      config: MODEL_CONFIG,
      inputs: { focus: 'full' },
      blueprintText: 'A short blueprint stub.',
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.stages.some((s) => s.stageId === 'review')).toBe(true);
  });
});

describe('skill packs (the "run anywhere" bridge)', () => {
  it('generates a pack per pipeline plus the all-in-one pack', () => {
    const ids = listSkillPacks().map((p) => p.id);
    for (const packId of ['atomic-blueprint', 'atomic-feature', 'atomic-tool', 'atomic-agent', 'atomic-all']) {
      expect(ids).toContain(packId);
    }
    for (const packId of ids) expect(generateSkillPack(packId)).toBeTruthy();
  });

  it('includes the three universal plugin denominators', () => {
    const pack = generateSkillPack('atomic-blueprint')!;
    const paths = pack.files.map((f) => f.path);
    expect(paths).toContain('SKILL.md');
    expect(paths).toContain('.claude-plugin/plugin.json');
    expect(paths).toContain('AGENTS.md');
    expect(paths).toContain('README.md');
  });

  it('encodes the 7-pillar protocol in the blueprint skill body', () => {
    const pack = generateSkillPack('atomic-blueprint')!;
    const body = pack.files.find((f) => f.path === 'SKILL.md')!.content;
    for (const phrase of ['Seven Parallel Pillars', 'Stage 7 — Verifier-Repair', 'Supreme Prosecutor', 'flagConcern', 'readMemory']) {
      expect(body).toContain(phrase);
    }
  });

  it('renders valid .claude-plugin/plugin.json with commands', () => {
    const pack = generateSkillPack('atomic-agent')!;
    const json = pack.files.find((f) => f.path === '.claude-plugin/plugin.json')!.content;
    const parsed = JSON.parse(json);
    expect(parsed.commands.length).toBeGreaterThan(0);
    expect(parsed.agents.length).toBeGreaterThan(0);
  });

  it('the all pack contains every pipeline skill', () => {
    const pack = generateSkillPack('atomic-all')!;
    const packSkillPaths = pack.files.filter((f) => f.path.startsWith('skills/') && f.path.endsWith('SKILL.md')).map((f) => f.path);
    for (const m of PIPELINE_MANIFESTS) {
      const skillId = m.id.split(':').pop();
      expect(packSkillPaths.some((p) => p.endsWith(`${skillId}/SKILL.md`))).toBe(true);
    }
  });
});

describe('public manifest projection', () => {
  it('strips stage prompt bodies from the public view', () => {
    const reviewer = USER_REVIEWER;
    const pub = publicManifest(reviewer);
    if (pub.pipeline) {
      for (const s of pub.pipeline.stages) {
        expect((s as { prompt?: unknown }).prompt).toBeUndefined();
      }
    }
    expect(pub.id).toBe(reviewer.id);
    expect(pub.version).toBe(reviewer.version);
  });
});

describe('GRANTABLE_CAPABILITIES consistency', () => {
  it('lists every grantable capability except prompt:inject', () => {
    const all = ['prompt:inject', 'blueprint:read', 'blueprint:write', 'events', 'api:call'];
    expect([...GRANTABLE_CAPABILITIES]).toEqual(all.filter((c) => c !== 'prompt:inject'));
  });
});
