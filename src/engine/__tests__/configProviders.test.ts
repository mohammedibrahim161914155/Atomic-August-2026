/**
 * src/engine/__tests__/configProviders.test.ts
 *
 * Unit tests for the AI provider configuration layer:
 *   - Config validation (empty keys, placeholder keys, unknown providers)
 *   - Config resolution (defaults, overrides)
 *   - Provider registry completeness and consistency
 *   - Pillar registry completeness and consistency
 */

import { describe, it, expect } from 'vitest';
import { resolveConfig, validateConfig, SERVER_DEFAULT_CONFIG, PROVIDER_BASE_URLS, type ProviderSlug } from '../config';
import { PROVIDERS } from '../../lib/providers';
import { PILLAR_REGISTRY, PILLAR_MAP } from '../pillarRegistry';
import { PILLAR_COUNT } from '../types';

const ALL_PROVIDER_SLUGS: ProviderSlug[] = Object.keys(PROVIDER_BASE_URLS) as ProviderSlug[];

describe('validateConfig', () => {
  it('accepts a well-formed config', () => {
    expect(() =>
      validateConfig({ provider: 'openrouter', apiKey: 'sk-or-test-key', fastModel: 'm1', proModel: 'm2' }),
    ).not.toThrow();
  });

  it('rejects an empty API key', () => {
    expect(() =>
      validateConfig({ provider: 'openrouter', apiKey: '', fastModel: 'm1', proModel: 'm2' }),
    ).toThrow();
  });

  it('rejects known placeholder keys (e.g. the public example key)', () => {
    expect(() =>
      validateConfig({
        provider: 'openrouter',
        apiKey: 'sk-or-v1-test-key-change-me',
        fastModel: 'm1',
        proModel: 'm2',
      }),
    ).toThrow();
  });

  it('rejects unknown provider slugs', () => {
    expect(() =>
      validateConfig({
        provider: 'acme-ai' as ProviderSlug,
        apiKey: 'sk-or-valid-key-here',
        fastModel: 'm1',
        proModel: 'm2',
      }),
    ).toThrow();
  });
});

describe('resolveConfig', () => {
  it('returns the server defaults when no overrides are given', () => {
    const resolved = resolveConfig({});
    expect(resolved.provider).toBe(SERVER_DEFAULT_CONFIG.provider);
  });

  it('applies overrides on top of defaults', () => {
    const resolved = resolveConfig({ provider: 'anthropic' });
    expect(resolved.provider).toBe('anthropic');
  });

  it('throws when an override uses an unknown provider', () => {
    expect(() => resolveConfig({ provider: 'unknown-provider' as ProviderSlug })).toThrow();
  });
});

describe('Provider registry', () => {
  it('every supported provider slug has a public metadata entry', () => {
    const providerMap = new Map(PROVIDERS.map(p => [p.slug, p]));
    for (const slug of ALL_PROVIDER_SLUGS) {
      const meta = providerMap.get(slug);
      expect(meta, `Provider metadata missing for ${slug}`).toBeDefined();
      expect(meta?.name, `Provider name missing for ${slug}`).toBeTruthy();
      expect(meta?.defaultFast, `Provider defaultFast missing for ${slug}`).toBeTruthy();
      expect(meta?.defaultPro, `Provider defaultPro missing for ${slug}`).toBeTruthy();
      expect(meta?.models.length, `Provider models missing for ${slug}`).toBeGreaterThan(0);
    }
  });

  it('all nine supported providers are registered', () => {
    expect(ALL_PROVIDER_SLUGS.length).toBe(9);
    const expected: ProviderSlug[] = ['openrouter', 'openai', 'anthropic', 'google', 'xai', 'mistral', 'deepseek', 'zai', 'minimax'];
    for (const slug of expected) {
      expect(ALL_PROVIDER_SLUGS).toContain(slug);
    }
  });

  it('no two providers share the same slug or name', () => {
    const slugs = PROVIDERS.map(p => p.slug);
    const names = PROVIDERS.map(p => p.name);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('Pillar registry', () => {
  it('registers all seven blueprint pillars', () => {
    expect(PILLAR_REGISTRY.length).toBe(PILLAR_COUNT);
    const names = PILLAR_REGISTRY.map(p => p.name);
    expect(names).toEqual(['planning', 'production', 'edge_cases', 'integration', 'security', 'quality', 'completeness']);
  });

  it('every pillar name has a runner entry in the pillar map', () => {
    for (const def of PILLAR_REGISTRY) {
      expect(PILLAR_MAP[def.name], `Pillar runner missing for ${def.name}`).toBeDefined();
    }
  });

  it('every pillar declares non-empty agents, governor and prosecutor prompts', () => {
    for (const def of PILLAR_REGISTRY) {
      expect(def.agents.length, `Pillar ${def.name} has no agents`).toBeGreaterThan(0);
      expect(def.govSysPrompt.trim().length, `Pillar ${def.name} has no governor system prompt`).toBeGreaterThan(0);
      expect(def.prosSysPrompt.trim().length, `Pillar ${def.name} has no prosecutor system prompt`).toBeGreaterThan(0);
      expect(def.staticGovPrompt.trim().length, `Pillar ${def.name} has no static governor prompt`).toBeGreaterThan(0);
    }
  });
});
