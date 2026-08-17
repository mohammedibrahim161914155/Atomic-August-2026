import { describe, it, expect, vi } from 'vitest';
import { generateOutputBundle } from './bundleGenerator';
import * as openrouter from './openrouter';
import { ModelConfig } from './types';

const mockIntent = {
  product_name: 'TestApp', domain: 'web',
  core_problem: 'testing', target_users: 'devs',
  key_features: ['testing'], tech_constraints: [],
  scale_assumptions: 'small', compliance_requirements: [],
  integration_targets: [], success_definition: 'tests pass'
};

const mockConfig: ModelConfig = { provider: 'openrouter', apiKey: 'test', fastModel: 'fast', proModel: 'pro' };

describe('bundleGenerator', () => {
  it('generates a valid output bundle', async () => {
    vi.spyOn(openrouter, 'generateJson').mockResolvedValue({
      data: {
        claude_md: '# Config',
        settings_json: '{"customHooks": []}',
        hookify_rules: [],
        agent_definitions: [],
        agents_md: '# Registry'
      },
      tokens_used: 100
    });

    const bundle = await generateOutputBundle(mockIntent, {} as any, mockConfig);
    expect(bundle).toHaveProperty('claude_md', '# Config');
    expect(bundle).toHaveProperty('settings_json', '{"customHooks": []}');
    expect(bundle.hookify_rules).toEqual([]);
    expect(bundle.agent_definitions).toEqual([]);
    expect(bundle).toHaveProperty('agents_md', '# Registry');
  });

  it('serializes settings_json if it comes back as an object', async () => {
    vi.spyOn(openrouter, 'generateJson').mockResolvedValue({
      data: {
        claude_md: '# Config',
        settings_json: { customHooks: ['test'] },
        hookify_rules: [],
        agent_definitions: [],
        agents_md: '# Registry'
      },
      tokens_used: 100
    });

    const bundle = await generateOutputBundle(mockIntent, {} as any, mockConfig);
    expect(bundle.settings_json).toContain('"customHooks": [');
  });

  it('throws an error if generation fails', async () => {
    vi.spyOn(openrouter, 'generateJson').mockRejectedValue(new Error('API failure'));
    
    await expect(generateOutputBundle(mockIntent, {} as any, mockConfig)).rejects.toThrow('API failure');
  });
});
