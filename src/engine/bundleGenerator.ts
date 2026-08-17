import { generateJson } from './openrouter';
import { GovernorIntent, OutputBundle, ModelConfig, PillarOutputMap } from './types';
import { log } from './logger';
import { z } from 'zod';

const BundleSchema = z.object({
  claude_md: z.string(),
  settings_json: z.union([z.string(), z.record(z.string(), z.any())]),
  hookify_rules: z.array(z.object({ filename: z.string(), content: z.string() })),
  agent_definitions: z.array(z.object({ filename: z.string(), content: z.string() })),
  agents_md: z.string()
});

const BUNDLE_PROMPT = `You are a DevSecOps AI architect. Convert the application design (intent + pillars) into a set of precise rules and sub-agent instructions for Claude Code (.claude/ environment).
Ensure all technical constraints from the pillars are accurately reflected in the generated instructions.
Produce the complete system configuration now.`;

export async function generateOutputBundle(
  intent: GovernorIntent,
  pillars: PillarOutputMap,
  config: ModelConfig,
  signal?: AbortSignal
): Promise<OutputBundle> {
  // Use the fast model to keep the time reasonable, or the pro model if required.
  // The system uses 'proModel' for deep generation usually, but we will use proModel for higher quality agents.
  const PILLAR_CHAR_LIMIT = 20_000;
  const truncatedPillars = Object.fromEntries(
    Object.entries(pillars).map(([name, p]) => {
      const raw = JSON.stringify(p, null, 2);
      return [name, raw.length > PILLAR_CHAR_LIMIT ? raw.slice(0, PILLAR_CHAR_LIMIT) + '\n... [truncated]' : raw];
    })
  );
  const prompt = `Project Intent:\n${JSON.stringify(intent, null, 2)}\n\nPillar Data:\n${JSON.stringify(truncatedPillars, null, 2)}`;

  try {
    const res = await generateJson(prompt, config, BundleSchema, BUNDLE_PROMPT, { signal, model: config.proModel });
    const data = res.data;

    const bundle: OutputBundle = {
      claude_md: typeof data.claude_md === 'string' ? data.claude_md : '# CLAUDE.md',
      settings_json: typeof data.settings_json === 'string' 
        ? data.settings_json 
        : JSON.stringify(data.settings_json || {}, null, 2),
      hookify_rules: Array.isArray(data.hookify_rules) ? data.hookify_rules : [],
      agent_definitions: Array.isArray(data.agent_definitions) ? data.agent_definitions : [],
      agents_md: typeof data.agents_md === 'string' ? data.agents_md : '# AGENTS.md',
    };

    return bundle;
  } catch (err: any) {
    if (signal?.aborted) {
      throw err;
    }
    log.error({ err }, 'Failed to generate output bundle');
    throw new Error('Failed to generate output bundle: ' + (err.message || 'Unknown error'));
  }
}
