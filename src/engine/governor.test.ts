import { describe, it, expect, vi } from 'vitest';

vi.mock('./openrouter', () => ({
  generateJson: vi.fn().mockResolvedValue({
    data: { 
      product_name: 'TestApp', 
      domain: 'SaaS', 
      core_problem: 'Test',
      target_users: 'Devs', 
      key_features: ['A'], 
      tech_constraints: [],
      scale_assumptions: '100 users', 
      compliance_requirements: [],
      integration_targets: [], 
      success_definition: 'MVP shipped' 
    },
    tokens_used: 100,
  }),
}));

import { runGovernor } from './governor';

describe('runGovernor', () => {
  it('returns a structured GovernorIntent', async () => {
    const emit = vi.fn();
    const config: any = { provider: 'openrouter', apiKey: 'test', fastModel: 'm1', proModel: 'm2' };
    const { intent, tokens_used } = await runGovernor('Build a todo app', config, emit);
    expect(intent.product_name).toBe('TestApp');
    expect(tokens_used).toBe(100);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'governor_start' })
    );
  });
});
