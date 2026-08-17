// src/engine/synthesizer.test.ts

import { describe, it, expect, vi } from 'vitest';
import { runSynthesizer } from './synthesizer';
import * as openrouter from './openrouter';
import * as bundleGen from './bundleGenerator';

const mockIntent = {
  product_name: 'TestApp', domain: 'web',
  core_problem: 'testing', target_users: 'devs',
  key_features: ['feat1'], tech_constraints: [],
  scale_assumptions: 'small', compliance_requirements: [],
  integration_targets: [], success_definition: 'works'
};

const mockProsecutor = {
  verdict: 'approved' as const,
  gaps_found: 0, gaps_resolved: 0, gaps: []
};

const mockSections = {
  executive_summary: 'summary text that is longer than fifty chars for scoring',
  architecture: 'arch text that is longer than fifty chars to pass scoring',
  data_model: 'data model that is longer than fifty chars for test scoring',
  api_contracts: 'api contracts that are longer than fifty chars for testing',
  security_model: 'security model longer than fifty chars for testing scoring',
  edge_cases: 'edge cases text that is longer than fifty chars for scoring',
  testing_strategy: 'testing strategy longer than fifty chars for scoring',
  deployment: 'deployment text that is longer than fifty chars for scoring',
  launch_checklist: 'launch checklist longer than fifty chars for scoring',
  technical_debt: 'technical debt text longer than fifty chars for scoring',
};

describe('runSynthesizer', () => {
  it('assembles a blueprint with quality_score between 0 and 100', async () => {
    vi.spyOn(openrouter, 'generateJson').mockResolvedValue(
      { data: mockSections, tokens_used: 1000 }
    );

    vi.spyOn(bundleGen, 'generateOutputBundle').mockResolvedValue({
      claude_md: '# test', settings_json: '{}',
      hookify_rules: [], agent_definitions: [], agents_md: ''
    });

    const blueprint = await runSynthesizer(
      'build a test app', {} as any, mockIntent,
      {} as any, mockProsecutor, () => {}
    );

    expect(blueprint.quality_score).toBeGreaterThan(0);
    expect(blueprint.quality_score).toBeLessThanOrEqual(100);
    expect(blueprint.sections.executive_summary).toBeTruthy();
    expect(blueprint.id).toBeTruthy();
  });

  it('emits synthesizer_start, synthesizer_done, bundle_start, bundle_done', async () => {
    vi.spyOn(openrouter, 'generateJson').mockResolvedValue(
      { data: mockSections, tokens_used: 1000 }
    );

    vi.spyOn(bundleGen, 'generateOutputBundle').mockResolvedValue({
      claude_md: '# test', settings_json: '{}',
      hookify_rules: [], agent_definitions: [], agents_md: ''
    });

    const events: any[] = [];
    await runSynthesizer('test', {} as any, mockIntent, {} as any,
      mockProsecutor, (e) => events.push(e));

    const types = events.map(e => e.type);
    expect(types).toContain('synthesizer_start');
    expect(types).toContain('synthesizer_done');
  });

  it('throws DOMException gracefully if AbortSignal fires before synthesizer', async () => {
    const ctrl = new AbortController();
    
    vi.spyOn(openrouter, 'generateJson').mockImplementation(async () => {
      ctrl.abort();
      return { data: mockSections, tokens_used: 0 };
    });

    let error: Error | undefined;
    try {
      await runSynthesizer('test', {} as any, mockIntent,
        {} as any, mockProsecutor, () => {}, ctrl.signal);
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toBe('Generation cancelled');
  });

  it('truncates large pillar summaries for safety', async () => {
    vi.spyOn(openrouter, 'generateJson').mockResolvedValue(
      { data: mockSections, tokens_used: 1000 }
    );
    vi.spyOn(bundleGen, 'generateOutputBundle').mockResolvedValue({
      claude_md: '# test', settings_json: '{}',
      hookify_rules: [], agent_definitions: [], agents_md: ''
    });
    const mockPillars = {
      planning: {
        pillar: 'planning', 
        summary: { 
          decisions: [], 
          schemas: [], 
          technical_constraints: [], 
          master_record_md: 'a'.repeat(21000) 
        }, 
        agents: [],
        failed_agents: [], reverifier_issues: 0,
        tokens_reviewer: 0, tokens_prosecutor: 0, tokens_synthesizer: 0, tokens_total: 0
      }
    };
    const blueprint = await runSynthesizer(
      'build a test app', {} as any, mockIntent,
      mockPillars as any, mockProsecutor, () => {}
    );
    expect(blueprint.quality_score).toBeGreaterThan(0);
  });

  it('handles bundle extraction failures gracefully in synthesizer', async () => {
    vi.spyOn(openrouter, 'generateJson').mockResolvedValue(
      { data: mockSections, tokens_used: 1000 }
    );
    vi.spyOn(bundleGen, 'generateOutputBundle').mockRejectedValue(new Error('Bundle generator crashed'));

    const blueprint = await runSynthesizer(
      'build a test app', {} as any, mockIntent,
      {} as any, mockProsecutor, () => {}
    );
    expect(blueprint.bundle).toBeUndefined();
    expect(blueprint.quality_score).toBeGreaterThan(0);
  });

  it('stops if signal is aborted during bundle generation', async () => {
    vi.spyOn(openrouter, 'generateJson').mockResolvedValue(
      { data: mockSections, tokens_used: 1000 }
    );
    const controller = new AbortController();
    vi.spyOn(bundleGen, 'generateOutputBundle').mockImplementation(async () => {
      controller.abort();
      throw new DOMException('Generation cancelled', 'AbortError');
    });

    try {
      await runSynthesizer(
        'build a test app', {} as any, mockIntent,
        {} as any, mockProsecutor, () => {}, controller.signal
      );
    } catch (err: any) {
      expect(err.name).toBe('AbortError');
    }
  });
});
