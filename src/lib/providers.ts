import { ProviderSlug } from '../engine/config';

export interface ProviderInfo {
  slug: ProviderSlug;
  name: string;
  description: string;
  icon: string;
  tier: 1 | 2;
  models: {
    id: string;
    name: string;
    isPro?: boolean;
    costPer1M?: number;
    lastVerified?: string;
  }[];
  defaultFast: string;
  defaultPro: string;
  keyPlaceholder?: string;
  keyDocsUrl?: string;
}

export const PROVIDERS: ProviderInfo[] = [
  // ── Tier 1: OpenRouter (recommended — all providers, one key) ──────────────
  {
    slug: 'openrouter',
    name: 'OpenRouter',
    description: 'Recommended — all providers, one key',
    icon: 'Globe',
    tier: 1,
    models: [
      // ── Free models ──────────────────────────────────────────────────────
      { id: 'openrouter/free', name: '⚡ Free Router (Auto)', costPer1M: 0, lastVerified: '2026-04-30' },
      { id: 'openrouter/free', name: '⚡ Free Router (Auto)', isPro: true, costPer1M: 0, lastVerified: '2026-04-30' },
      { id: 'nvidia/nemotron-3-super:free', name: 'Nemotron 3 Super (Free)', costPer1M: 0, lastVerified: '2026-04-30' },
      { id: 'nvidia/nemotron-3-super:free', name: 'Nemotron 3 Super (Free)', isPro: true, costPer1M: 0, lastVerified: '2026-04-30' },
      { id: 'openai/gpt-oss-120b:free', name: 'GPT-OSS 120B (Free)', costPer1M: 0, lastVerified: '2026-05-01' },
      { id: 'openai/gpt-oss-120b:free', name: 'GPT-OSS 120B (Free)', isPro: true, costPer1M: 0, lastVerified: '2026-05-01' },
      { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B (Free)', costPer1M: 0, lastVerified: '2026-05-01' },
      { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B (Free)', isPro: true, costPer1M: 0, lastVerified: '2026-05-01' },
      { id: 'inclusionai/ling-2.6-1t:free', name: 'Ling-2.6-1T (Free)', costPer1M: 0, lastVerified: '2026-04-30' },
      { id: 'tencent/hy3-preview:free', name: 'Hy3 Preview (Free)', isPro: true, costPer1M: 0, lastVerified: '2026-04-30' },
      { id: 'minimax/minimax-m2.5:free', name: 'MiniMax M2.5 (Free)', isPro: true, costPer1M: 0, lastVerified: '2026-04-30' },
      { id: 'z-ai/glm-4.5-air:free', name: 'GLM-4.5 Air (Free)', costPer1M: 0, lastVerified: '2026-04-30' },
      { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek R1 (Free)', isPro: true, costPer1M: 0, lastVerified: '2026-05-01' },
      { id: 'mistralai/devstral-small:free', name: 'Devstral Small (Free)', costPer1M: 0, lastVerified: '2026-05-01' },
      // ── OpenAI ───────────────────────────────────────────────────────────
      { id: 'openai/gpt-5.5', name: 'GPT-5.5', isPro: true, costPer1M: 5, lastVerified: '2026-04-30' },
      { id: 'openai/gpt-5.5-pro', name: 'GPT-5.5 Pro', isPro: true, costPer1M: 30, lastVerified: '2026-05-01' },
      { id: 'openai/gpt-5.4', name: 'GPT-5.4', isPro: true, costPer1M: 2.50, lastVerified: '2026-04-12' },
      { id: 'openai/gpt-5.4-pro', name: 'GPT-5.4 Pro', isPro: true, costPer1M: 30, lastVerified: '2026-05-01' },
      { id: 'openai/gpt-5.3-chat', name: 'GPT-5.3 Chat', costPer1M: 1, lastVerified: '2026-04-12' },
      { id: 'openai/gpt-5.3-codex', name: 'GPT-5.3 Codex', isPro: true, costPer1M: 1.75, lastVerified: '2026-05-01' },
      { id: 'openai/o3', name: 'o3 (Reasoning)', isPro: true, costPer1M: 10, lastVerified: '2026-04-12' },
      { id: 'openai/o3-pro', name: 'o3-pro', isPro: true, costPer1M: 20, lastVerified: '2026-04-12' },
      { id: 'openai/gpt-4.1', name: 'GPT-4.1', costPer1M: 2, lastVerified: '2026-04-12' },
      { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 Mini', costPer1M: 0.40, lastVerified: '2026-04-12' },
      { id: 'openai/gpt-4.1-nano', name: 'GPT-4.1 Nano', costPer1M: 0.10, lastVerified: '2026-04-12' },
      // ── Anthropic ─────────────────────────────────────────────────────────
      { id: 'anthropic/claude-opus-4-8', name: 'Claude Opus 4.8 ✦', isPro: true, costPer1M: 15, lastVerified: '2026-06-01' },
      { id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7', isPro: true, costPer1M: 5, lastVerified: '2026-04-30' },
      { id: 'anthropic/claude-4.6-sonnet', name: 'Claude Sonnet 4.6', isPro: true, costPer1M: 3, lastVerified: '2026-04-12' },
      { id: 'anthropic/claude-4.6-opus', name: 'Claude Opus 4.6', isPro: true, costPer1M: 15, lastVerified: '2026-04-12' },
      // ── Google ────────────────────────────────────────────────────────────
      { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro ✦', isPro: true, costPer1M: 1.25, lastVerified: '2026-06-01' },
      { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash ✦', costPer1M: 0.075, lastVerified: '2026-06-01' },
      { id: 'google/gemini-3.1-pro', name: 'Gemini 3.1 Pro', isPro: true, costPer1M: 1.25, lastVerified: '2026-04-12' },
      { id: 'google/gemini-3.1-flash', name: 'Gemini 3.1 Flash', costPer1M: 0.075, lastVerified: '2026-04-12' },
      { id: 'google/gemini-3-flash', name: 'Gemini 3 Flash', costPer1M: 0.50, lastVerified: '2026-04-30' },
      { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', costPer1M: 0.25, lastVerified: '2026-04-30' },
      // ── xAI ──────────────────────────────────────────────────────────────
      { id: 'xai/grok-4.3', name: 'Grok 4.3', isPro: true, costPer1M: 2, lastVerified: '2026-04-30' },
      { id: 'xai/grok-4.20', name: 'Grok 4.20', isPro: true, costPer1M: 2, lastVerified: '2026-04-12' },
      // ── Mistral ───────────────────────────────────────────────────────────
      { id: 'mistral/devstral', name: 'Devstral', isPro: true, costPer1M: 2, lastVerified: '2026-04-12' },
      { id: 'mistralai/mistral-small-4', name: 'Mistral Small 4', costPer1M: 0.10, lastVerified: '2026-04-30' },
      // ── NVIDIA ────────────────────────────────────────────────────────────
      { id: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'Nemotron 3 Ultra 550B ✦', isPro: true, costPer1M: 3.5, lastVerified: '2026-06-01' },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra 550B (Free)', costPer1M: 0, lastVerified: '2026-06-01' },
      { id: 'nvidia/nemotron-3-super:free', name: 'Nemotron 3 Super (Free)', costPer1M: 0, lastVerified: '2026-04-30' },
      // ── Qwen ──────────────────────────────────────────────────────────────
      { id: 'qwen/qwen3.7-plus', name: 'Qwen 3.7 Plus ✦', isPro: true, costPer1M: 0.5, lastVerified: '2026-06-01' },
      { id: 'qwen/qwen3.7-plus:free', name: 'Qwen 3.7 Plus (Free)', costPer1M: 0, lastVerified: '2026-06-01' },
      // ── DeepSeek ──────────────────────────────────────────────────────────
      { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', isPro: true, costPer1M: 0.44, lastVerified: '2026-04-30' },
      { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', costPer1M: 0.14, lastVerified: '2026-04-30' },
      // ── Z.ai (GLM) ────────────────────────────────────────────────────────
      { id: 'z-ai/glm-5.1', name: 'GLM-5.1', isPro: true, costPer1M: 1.40, lastVerified: '2026-04-12' },
      { id: 'z-ai/glm-5', name: 'GLM-5', isPro: true, costPer1M: 0.95, lastVerified: '2026-04-12' },
      { id: 'z-ai/glm-5-turbo', name: 'GLM-5 Turbo', costPer1M: 1.20, lastVerified: '2026-04-12' },
      { id: 'z-ai/glm-5v-turbo', name: 'GLM-5V Turbo', costPer1M: 0.39, lastVerified: '2026-04-12' },
      { id: 'z-ai/glm-4.7', name: 'GLM-4.7', costPer1M: 0.50, lastVerified: '2026-04-12' },
      { id: 'z-ai/glm-4.5-air', name: 'GLM-4.5 Air', costPer1M: 0, lastVerified: '2026-04-12' },
      // ── Moonshot (Kimi) ───────────────────────────────────────────────────
      { id: 'moonshotai/kimi-k2.7', name: 'Kimi K2.7 ✦', isPro: true, costPer1M: 0.60, lastVerified: '2026-06-19' },
      { id: 'moonshotai/kimi-k2.7:free', name: 'Kimi K2.7 (Free)', costPer1M: 0, lastVerified: '2026-06-19' },
      { id: 'moonshotai/kimi-k2', name: 'Kimi K2', isPro: true, costPer1M: 0.50, lastVerified: '2026-06-19' },
      // ── MiniMax ───────────────────────────────────────────────────────────
      { id: 'minimax/minimax-m2.7', name: 'MiniMax M2.7', isPro: true, costPer1M: 0.30, lastVerified: '2026-04-12' },
      { id: 'minimax/minimax-m2.5', name: 'MiniMax M2.5', isPro: true, costPer1M: 0.30, lastVerified: '2026-04-12' },
      { id: 'minimax/minimax-m2.1', name: 'MiniMax M2.1', costPer1M: 0.20, lastVerified: '2026-04-12' },
      { id: 'minimax/minimax-01', name: 'MiniMax-01', isPro: true, costPer1M: 0.30, lastVerified: '2026-04-12' },
      { id: 'minimax/minimax-m2-her', name: 'MiniMax M2-her', costPer1M: 0.30, lastVerified: '2026-04-12' },
    ],
    defaultFast: 'openai/gpt-5.3-chat',
    defaultPro: 'openai/gpt-5.4',
    keyPlaceholder: 'sk-or-v1-...',
    keyDocsUrl: 'https://openrouter.ai/keys',
  },

  // ── Tier 1: OpenAI Direct ──────────────────────────────────────────────────
  {
    slug: 'openai',
    name: 'OpenAI',
    description: 'Direct access — flagship & reasoning models',
    icon: 'Sparkles',
    tier: 1,
    models: [
      { id: 'gpt-5.5', name: 'GPT-5.5', isPro: true, costPer1M: 5, lastVerified: '2026-04-30' },
      { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro', isPro: true, costPer1M: 30, lastVerified: '2026-04-30' },
      { id: 'gpt-5.4', name: 'GPT-5.4', isPro: true, costPer1M: 2.50, lastVerified: '2026-04-12' },
      { id: 'gpt-5.4-pro', name: 'GPT-5.4 Pro', isPro: true, costPer1M: 30, lastVerified: '2026-04-12' },
      { id: 'gpt-5.3', name: 'GPT-5.3 Instant', costPer1M: 1, lastVerified: '2026-04-12' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', isPro: true, costPer1M: 1.75, lastVerified: '2026-05-01' },
      { id: 'o3', name: 'o3 (Reasoning)', isPro: true, costPer1M: 10, lastVerified: '2026-04-12' },
      { id: 'o3-pro', name: 'o3-pro', isPro: true, costPer1M: 20, lastVerified: '2026-04-12' },
      { id: 'gpt-4.1', name: 'GPT-4.1', costPer1M: 2, lastVerified: '2026-04-12' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', costPer1M: 0.40, lastVerified: '2026-04-12' },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', costPer1M: 0.10, lastVerified: '2026-04-12' },
    ],
    defaultFast: 'gpt-5.3',
    defaultPro: 'gpt-5.4',
    keyPlaceholder: 'sk-proj-...',
    keyDocsUrl: 'https://platform.openai.com/api-keys',
  },

  // ── Tier 1: Anthropic Direct ──────────────────────────────────────────────
  {
    slug: 'anthropic',
    name: 'Anthropic',
    description: 'Direct access — extended thinking & long context',
    icon: 'Brain',
    tier: 1,
    models: [
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8 ✦', isPro: true, costPer1M: 15, lastVerified: '2026-06-01' },
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', isPro: true, costPer1M: 5, lastVerified: '2026-04-30' },
      { id: 'claude-4.6-sonnet', name: 'Claude Sonnet 4.6', isPro: true, costPer1M: 3, lastVerified: '2026-04-12' },
      { id: 'claude-4.6-opus', name: 'Claude Opus 4.6', isPro: true, costPer1M: 15, lastVerified: '2026-04-12' },
    ],
    defaultFast: 'claude-4.6-sonnet',
    defaultPro: 'claude-opus-4-8',
    keyPlaceholder: 'sk-ant-...',
    keyDocsUrl: 'https://console.anthropic.com/settings/keys',
  },

  // ── Tier 1: Google Direct ─────────────────────────────────────────────────
  {
    slug: 'google',
    name: 'Google',
    description: 'Direct access — frontier at the lowest cost',
    icon: 'Zap',
    tier: 1,
    models: [
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro ✦', isPro: true, costPer1M: 1.25, lastVerified: '2026-06-01' },
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash ✦', costPer1M: 0.075, lastVerified: '2026-06-01' },
      { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', isPro: true, costPer1M: 1.25, lastVerified: '2026-04-12' },
      { id: 'gemini-3.1-flash', name: 'Gemini 3.1 Flash', costPer1M: 0.075, lastVerified: '2026-04-12' },
      { id: 'gemini-3-flash', name: 'Gemini 3 Flash', costPer1M: 0.50, lastVerified: '2026-04-30' },
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', costPer1M: 0.25, lastVerified: '2026-04-30' },
    ],
    defaultFast: 'gemini-3.5-flash',
    defaultPro: 'gemini-3.1-pro-preview',
    keyPlaceholder: 'AIza...',
    keyDocsUrl: 'https://aistudio.google.com/app/apikey',
  },

  // ── Tier 1: DeepSeek Direct ───────────────────────────────────────────────
  {
    slug: 'deepseek',
    name: 'DeepSeek',
    description: 'Direct access — near-frontier, cost-efficient',
    icon: 'Brain',
    tier: 1,
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', isPro: true, costPer1M: 0.44, lastVerified: '2026-04-30' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', costPer1M: 0.14, lastVerified: '2026-04-30' },
      // ⚠️ deepseek-chat deprecated July 24 2026 — migrate to deepseek-v4-flash
      { id: 'deepseek-chat', name: 'DeepSeek V3.2 (legacy)', isPro: true, costPer1M: 0.28, lastVerified: '2026-04-12' },
    ],
    defaultFast: 'deepseek-v4-flash',
    defaultPro: 'deepseek-v4-pro',
    keyPlaceholder: 'sk-...',
    keyDocsUrl: 'https://platform.deepseek.com/api_keys',
  },

  // ── Tier 1: xAI Direct ───────────────────────────────────────────────────
  {
    slug: 'xai',
    name: 'xAI',
    description: 'Direct access — Grok multi-agent series',
    icon: 'Sparkles',
    tier: 1,
    models: [
      { id: 'grok-4.3', name: 'Grok 4.3', isPro: true, costPer1M: 2, lastVerified: '2026-04-30' },
      { id: 'grok-4.20', name: 'Grok 4.20', isPro: true, costPer1M: 2, lastVerified: '2026-04-12' },
    ],
    defaultFast: 'grok-4.20',
    defaultPro: 'grok-4.3',
    keyPlaceholder: 'xai-...',
    keyDocsUrl: 'https://console.x.ai/',
  },

  // ── Tier 1: Mistral Direct ───────────────────────────────────────────────
  {
    slug: 'mistral',
    name: 'Mistral',
    description: 'Direct access — open-weight coding specialist',
    icon: 'Zap',
    tier: 1,
    models: [
      { id: 'devstral-small-2505', name: 'Devstral Small (May 25)', isPro: true, costPer1M: 0.10, lastVerified: '2026-05-01' },
      { id: 'devstral', name: 'Devstral', isPro: true, costPer1M: 2, lastVerified: '2026-04-12' },
      { id: 'mistral-small-4', name: 'Mistral Small 4', costPer1M: 0.10, lastVerified: '2026-04-30' },
      { id: 'mistral-large-latest', name: 'Mistral Large', isPro: true, costPer1M: 2, lastVerified: '2026-04-30' },
    ],
    defaultFast: 'mistral-small-4',
    defaultPro: 'devstral',
    keyPlaceholder: '...',
    keyDocsUrl: 'https://console.mistral.ai/api-keys/',
  },

  // ── Tier 2: ZAI (GLM) ────────────────────────────────────────────────────
  {
    slug: 'zai',
    name: 'Z.ai (GLM)',
    description: 'Direct access — top SWE-Bench ranked models',
    icon: 'Brain',
    tier: 2,
    models: [
      { id: 'glm-5.1', name: 'GLM-5.1', isPro: true, costPer1M: 1.40, lastVerified: '2026-04-12' },
      { id: 'glm-5', name: 'GLM-5', isPro: true, costPer1M: 0.95, lastVerified: '2026-04-12' },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo', costPer1M: 1.20, lastVerified: '2026-04-12' },
      { id: 'glm-5v-turbo', name: 'GLM-5V Turbo', costPer1M: 0.39, lastVerified: '2026-04-12' },
      { id: 'glm-4.7', name: 'GLM-4.7', costPer1M: 0.50, lastVerified: '2026-04-12' },
      { id: 'glm-4.5-air', name: 'GLM-4.5 Air', costPer1M: 0, lastVerified: '2026-04-12' },
    ],
    defaultFast: 'glm-5-turbo',
    defaultPro: 'glm-5.1',
    keyPlaceholder: '...',
    keyDocsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },

  // ── Tier 2: MiniMax ───────────────────────────────────────────────────────
  {
    slug: 'minimax',
    name: 'MiniMax',
    description: 'Direct access — ultra-long context window',
    icon: 'Globe',
    tier: 2,
    models: [
      { id: 'minimax-m2.7', name: 'M2.7', isPro: true, costPer1M: 0.30, lastVerified: '2026-04-12' },
      { id: 'minimax-m2.5', name: 'M2.5', isPro: true, costPer1M: 0.30, lastVerified: '2026-04-12' },
      { id: 'minimax-m2.1', name: 'M2.1', costPer1M: 0.20, lastVerified: '2026-04-12' },
      { id: 'minimax-01', name: 'MiniMax-01', isPro: true, costPer1M: 0.30, lastVerified: '2026-04-12' },
      { id: 'minimax-m2-her', name: 'M2-her', costPer1M: 0.30, lastVerified: '2026-04-12' },
    ],
    defaultFast: 'minimax-m2.1',
    defaultPro: 'minimax-m2.7',
    keyPlaceholder: '...',
    keyDocsUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
];
