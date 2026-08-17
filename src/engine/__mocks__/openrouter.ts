import { vi } from 'vitest';


// Deterministic mock that returns valid JSON for generateJson and text for
// generateText
export const generateText = vi.fn(async (prompt: string, config: any, sys?: string, _opts?: any) => {
  if (sys && sys.includes('===CLAUDE_MD===')) {
    return {
      text: '===CLAUDE_MD===\nclaude\n===SETTINGS_JSON===\n{"test":true}\n===HOOKIFY_RULES===\nFILE:rule.js\nrule_content\nEND_FILE\n===END===',
      tokens_used: 50
    };
  }
  if (sys && sys.includes('===AGENTS_MD===')) {
      return {
      text: '===AGENTS_MD===\nmd\n===AGENT_FILES===\nFILE:agent.md\nagent_content\nEND_FILE\n===END===',
      tokens_used: 50
    };
  }
  return {
    text: 'Mock agent output for: ' + prompt.slice(0, 50),
    tokens_used: 100,
  }
});

export const generateJson = vi.fn(async (
  _prompt: string, _config: any, schema: any, _sys?: string
) => {
  // Return a minimal valid object matching common schemas
  const mockData: Record<string, any> = {
    product_name: 'MockProduct', domain: 'SaaS',
    core_problem: 'Test problem', target_users: 'Developers',
    key_features: ['Feature A'], tech_constraints: [],
    scale_assumptions: '1000 users', compliance_requirements: [],
    integration_targets: [], success_definition: 'Users happy',
    verdict: 'approved', gaps_found: 0, gaps: [], gaps_resolved: 0,
    pillar: 'planning', issues: [], key_decisions: [], cross_pillar_flags: [],
    
    // Reviewer fields
    constructive_feedback: 'Looks good',
    critical_flaws: [],
    
    // Synthesizer fields
    executive_summary: 'mock',
    architecture: 'mock',
    data_model: 'mock',
    api_contracts: 'mock',
    security_model: 'mock',
    edge_cases: 'mock',
    testing_strategy: 'mock',
    deployment: 'mock',
    launch_checklist: 'mock',
    technical_debt: 'mock',
    
    // Check if it's a bundle schema
    ...(schema?.shape?.claude_md ? { 
      claude_md: 'mock md', 
      settings_json: '{"mock": true}', 
      hookify_rules: [], 
      agent_definitions: [], 
      agents_md: 'mock agents md' 
    } : {}),
    
    // Check if it's a reviewer schema to return passed quality gate
    ...(schema?.shape?.constructive_feedback ? { verdict: 'passes_quality_gate' } : {}),
    // Check if it's a PillarProsecutorReportSchema
    ...(schema?.shape?.key_decisions ? { verdict: 'pass' } : {}),
  };
  return { data: schema.parse(mockData), tokens_used: 50 };
});

export const getAi = vi.fn();
export const createQueue = vi.fn(() => ({ add: (fn: any) => fn() }));
export const queueStorage = { run: (_q: any, fn: any) => fn(), getStore: () => null };
