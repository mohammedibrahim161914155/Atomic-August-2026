// src/engine/config.ts
// SINGLE SOURCE OF TRUTH for all AI configuration.
// Every engine file imports from here — nothing else.

import { modelSupportsThinking } from './openrouter';

export type ProviderSlug =
  | 'openrouter'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'xai'
  | 'mistral'
  | 'zai'
  | 'minimax';

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

/**
 * Maps effort level to max_tokens budget for proModel calls.
 * Low = fast/cheap, Max = full extended context.
 */
export const EFFORT_TOKEN_BUDGETS: Record<EffortLevel, number> = {
  low:    4_096,
  medium: 8_192,
  high:   16_000,
  max:    32_000,
};

export interface ModelConfig {
  provider: ProviderSlug;
  apiKey: string;
  fastModel: string;   // Governor + JSON extraction + simple pillar agents
  proModel: string;    // Pillar agents, Prosecutor, Synthesizer (deep reasoning)
  extendedThinking?: boolean;
  effort?: EffortLevel;
  thinkingEnabled?: boolean;
}

// Provider base URLs (kept for reference — Vercel AI SDK handles these internally)
export const PROVIDER_BASE_URLS: Record<ProviderSlug, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic:  'https://api.anthropic.com/v1',
  openai:     'https://api.openai.com/v1',
  google:     'https://generativelanguage.googleapis.com/v1beta/openai/',
  deepseek:   'https://api.deepseek.com/v1',
  xai:        'https://api.x.ai/v1',
  mistral:    'https://api.mistral.ai/v1',
  zai:        'https://open.bigmodel.cn/api/paas/v4',
  minimax:    'https://api.minimax.chat/v1',
};

// Default server-side config (May 2026 models — read from env once at startup)
export const SERVER_DEFAULT_CONFIG: ModelConfig = {
  provider: 'openrouter',
  apiKey: process.env.OPENROUTER_API_KEY || '',
  // Fast: cheap & quick for JSON extraction, governor, reviewer
  fastModel: 'openai/gpt-5.3-chat',
  // Pro: strongest reasoning for pillar agents, prosecutor, synthesizer
  proModel: 'openai/gpt-5.4',
};

/** Set of recognised provider slugs — the canonical allow-list. */
export const VALID_PROVIDERS: ReadonlySet<string> = new Set(Object.keys(PROVIDER_BASE_URLS));

/**
 * Known placeholder / example API keys that must NEVER reach a live provider.
 * Checked case-insensitively after trimming.
 */
const FORBIDDEN_KEYS = new Set([
  'your_key_here',
  'undefined',
  'sk-or-v1-test-key-change-me',
  'change_me',
  'your-openrouter-api-key-here',
]);

/**
 * Validate a ModelConfig before it is used for any provider call.
 *
 * Checks performed (in order):
 *   1. Provider slug must be on the canonical allow-list.
 *   2. API key must be non-empty after trimming.
 *   3. API key must not be a known placeholder or example value.
 *   4. API key must look like a real key (minimum 8 characters) — catches
 *      accidental env-var interpolation failures like "${KEY}".
 */
export function validateConfig(c: ModelConfig): void {
  if (!VALID_PROVIDERS.has(c.provider)) {
    throw new Error(
      `Unsupported AI provider "${c.provider}". Supported providers: ${[...VALID_PROVIDERS].join(', ')}.`
    );
  }

  const key = c.apiKey?.trim();
  if (!key) {
    throw new Error(
      `No valid API key for provider "${c.provider}". ` +
      `Set OPENROUTER_API_KEY in secrets or provide a key in Settings.`
    );
  }

  if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
    throw new Error(
      `Placeholder API key detected for provider "${c.provider}" — ` +
      `provide a real key in Settings or set the OPENROUTER_API_KEY secret.`
    );
  }

  if (key.length < 8) {
    throw new Error(
      `API key for provider "${c.provider}" is too short to be valid — ` +
      `check your environment configuration.`
    );
  }
}

/**
 * Resolve the effective ModelConfig: server defaults merged with caller
 * overrides. Throws if an override targets an unsupported provider.
 */
export function resolveConfig(override?: Partial<ModelConfig>): ModelConfig {
  if (override?.apiKey && !override?.provider) {
    throw new Error('Provider must be specified when providing an API key.');
  }

  if (override?.provider && !VALID_PROVIDERS.has(override.provider)) {
    throw new Error(
      `Unsupported AI provider "${override.provider}". Supported providers: ${[...VALID_PROVIDERS].join(', ')}.`
    );
  }

  // Merge: caller overrides always win, even when no API key is supplied —
  // e.g. switching providers while keeping the default key.
  const base: ModelConfig = { ...SERVER_DEFAULT_CONFIG, ...(override ?? {}) };

  if (base.extendedThinking === undefined) {
    base.extendedThinking = modelSupportsThinking(base.provider, base.proModel);
  }
  return base;
}
