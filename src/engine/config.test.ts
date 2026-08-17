import { describe, it, expect } from 'vitest';
import { validateConfig, resolveConfig } from './config';

describe('Config', () => {
  it('validates config correctly — rejects empty API key', () => {
    expect(() => validateConfig({ apiKey: '', provider: 'openrouter' } as any)).toThrow();
  });

  it('validates config — rejects unknown providers', () => {
    expect(() =>
      validateConfig({ apiKey: 'sk-test-key-long-enough-here', provider: 'acme-ai' } as any),
    ).toThrow(/Unsupported AI provider/);
  });

  it('validates config — rejects placeholder keys', () => {
    expect(() =>
      validateConfig({ apiKey: 'sk-or-v1-test-key-change-me', provider: 'openrouter' } as any),
    ).toThrow(/Placeholder API key detected/);
  });

  it('validates config — rejects keys that are too short', () => {
    expect(() =>
      validateConfig({ apiKey: 'sk-a', provider: 'openrouter' } as any),
    ).toThrow(/too short/);
  });

  it('resolves config', () => {
    // API key requires an explicit provider
    expect(() => resolveConfig({ apiKey: 'sk-test-key-long-enough' })).toThrow();
    const resolved = resolveConfig({
      provider: 'openrouter',
      apiKey: 'sk-test-key-long-enough',
    });
    expect(resolved.provider).toBe('openrouter');
  });

  it('resolveConfig honors provider-only overrides', () => {
    const resolved = resolveConfig({ provider: 'anthropic' });
    expect(resolved.provider).toBe('anthropic');
  });

  it('resolveConfig rejects unknown provider overrides', () => {
    expect(() => resolveConfig({ provider: 'acme-ai' as any })).toThrow();
  });
});
