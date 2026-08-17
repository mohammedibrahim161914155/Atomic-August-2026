/**
 * src/models/registry.ts
 *
 * SINGLE SOURCE OF TRUTH for all model identifiers, capabilities, and pricing.
 * Every model string in the codebase must reference an entry here.
 * Any model ID that lives outside this file is a defect.
 */

// ── Capability flags ──────────────────────────────────────────────────────────

export interface ModelCapabilities {
  /** Supports multi-step extended thinking / reasoning traces (Anthropic, Gemini thinking levels) */
  extendedThinking: boolean;
  /** Context window > 500K tokens */
  longContext: boolean;
  /** Specifically tuned for tool-heavy agentic workflows */
  agenticOptimised: boolean;
  /** A :free tier is available on OpenRouter */
  freeAvailable: boolean;
  /** Supports function / tool calling */
  toolCalling: boolean;
  /** Supports streaming responses */
  streaming: boolean;
}

// ── Tier labels for UI display ────────────────────────────────────────────────

export type ModelTier = 'free' | 'standard' | 'premium';

// ── Full model entry ──────────────────────────────────────────────────────────

export interface ModelEntry {
  /** Canonical OpenRouter slug (or direct provider model ID) */
  id: string;
  /** Human-readable display name */
  displayName: string;
  /** Provider name */
  provider: string;
  /** Maximum context window in tokens */
  contextWindow: number;
  /** Maximum output tokens per call */
  maxOutputTokens: number;
  /** Cost per million input tokens in USD */
  inputCostPer1M: number;
  /** Cost per million output tokens in USD */
  outputCostPer1M: number;
  /** Capability flags */
  capabilities: ModelCapabilities;
  /** UI tier badge */
  tier: ModelTier;
  /** Recommended use cases within Atomic */
  recommendedFor: string[];
  /** Last verified date (YYYY-MM-DD) */
  lastVerified: string;
}

// ── Registry ──────────────────────────────────────────────────────────────────

export const MODEL_REGISTRY: ModelEntry[] = [

  // ── OpenAI ──────────────────────────────────────────────────────────────────

  {
    id: 'openai/gpt-5.5',
    displayName: 'GPT-5.5',
    provider: 'openai',
    contextWindow: 256_000,
    maxOutputTokens: 16_384,
    inputCostPer1M: 5,
    outputCostPer1M: 15,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: true, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'premium',
    recommendedFor: ['pillar-agent', 'synthesizer'],
    lastVerified: '2026-04-30',
  },
  {
    id: 'openai/gpt-5.5-pro',
    displayName: 'GPT-5.5 Pro',
    provider: 'openai',
    contextWindow: 256_000,
    maxOutputTokens: 16_384,
    inputCostPer1M: 30,
    outputCostPer1M: 60,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: true, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'premium',
    recommendedFor: ['prosecutor', 'supreme-prosecutor'],
    lastVerified: '2026-05-01',
  },
  {
    id: 'openai/gpt-5.4',
    displayName: 'GPT-5.4',
    provider: 'openai',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputCostPer1M: 2.5,
    outputCostPer1M: 10,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: true, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'premium',
    recommendedFor: ['pillar-agent', 'prosecutor', 'synthesizer'],
    lastVerified: '2026-04-12',
  },
  {
    id: 'openai/gpt-5.4-pro',
    displayName: 'GPT-5.4 Pro',
    provider: 'openai',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputCostPer1M: 30,
    outputCostPer1M: 60,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: true, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'premium',
    recommendedFor: ['supreme-prosecutor'],
    lastVerified: '2026-05-01',
  },
  {
    id: 'openai/gpt-5.3-chat',
    displayName: 'GPT-5.3 Chat',
    provider: 'openai',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    inputCostPer1M: 1,
    outputCostPer1M: 3,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: false, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'standard',
    recommendedFor: ['governor', 'reviewer', 'fast-extraction'],
    lastVerified: '2026-04-12',
  },
  {
    id: 'openai/gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex',
    provider: 'openai',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    inputCostPer1M: 1.75,
    outputCostPer1M: 5,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: false, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'standard',
    recommendedFor: ['code-generation'],
    lastVerified: '2026-05-01',
  },
  {
    id: 'openai/o3',
    displayName: 'o3 (Reasoning)',
    provider: 'openai',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    inputCostPer1M: 10,
    outputCostPer1M: 40,
    capabilities: { extendedThinking: true, longContext: false, agenticOptimised: true, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'premium',
    recommendedFor: ['prosecutor', 'supreme-prosecutor', 'complex-reasoning'],
    lastVerified: '2026-04-12',
  },
  {
    id: 'openai/o3-pro',
    displayName: 'o3-pro',
    provider: 'openai',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    inputCostPer1M: 20,
    outputCostPer1M: 80,
    capabilities: { extendedThinking: true, longContext: false, agenticOptimised: true, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'premium',
    recommendedFor: ['supreme-prosecutor'],
    lastVerified: '2026-04-12',
  },
  {
    id: 'openai/gpt-4.1',
    displayName: 'GPT-4.1',
    provider: 'openai',
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    inputCostPer1M: 2,
    outputCostPer1M: 8,
    capabilities: { extendedThinking: false, longContext: true, agenticOptimised: false, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'standard',
    recommendedFor: ['long-context-synthesis'],
    lastVerified: '2026-04-12',
  },
  {
    id: 'openai/gpt-4.1-mini',
    displayName: 'GPT-4.1 Mini',
    provider: 'openai',
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    inputCostPer1M: 0.4,
    outputCostPer1M: 1.6,
    capabilities: { extendedThinking: false, longContext: true, agenticOptimised: false, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'standard',
    recommendedFor: ['reviewer', 'governor'],
    lastVerified: '2026-04-12',
  },
  {
    id: 'openai/gpt-4.1-nano',
    displayName: 'GPT-4.1 Nano',
    provider: 'openai',
    contextWindow: 1_047_576,
    maxOutputTokens: 16_384,
    inputCostPer1M: 0.1,
    outputCostPer1M: 0.4,
    capabilities: { extendedThinking: false, longContext: true, agenticOptimised: false, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'standard',
    recommendedFor: ['fast-extraction', 'lightweight-tasks'],
    lastVerified: '2026-04-12',
  },

  // ── Anthropic ────────────────────────────────────────────────────────────────

  {
    id: 'anthropic/claude-opus-4-8',
    displayName: 'Claude Opus 4.8',
    provider: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    inputCostPer1M: 15,
    outputCostPer1M: 75,
    capabilities: { extendedThinking: true, longContext: false, agenticOptimised: true, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'premium',
    recommendedFor: ['supreme-prosecutor', 'prosecutor', 'complex-reasoning'],
    lastVerified: '2026-06-01',
  },
  {
    id: 'anthropic/claude-opus-4.7',
    displayName: 'Claude Opus 4.7',
    provider: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    inputCostPer1M: 5,
    outputCostPer1M: 25,
    capabilities: { extendedThinking: true, longContext: false, agenticOptimised: true, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'premium',
    recommendedFor: ['pillar-agent', 'prosecutor'],
    lastVerified: '2026-04-30',
  },
  {
    id: 'anthropic/claude-4.6-sonnet',
    displayName: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    inputCostPer1M: 3,
    outputCostPer1M: 15,
    capabilities: { extendedThinking: true, longContext: false, agenticOptimised: true, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'premium',
    recommendedFor: ['pillar-agent', 'synthesizer', 'governor'],
    lastVerified: '2026-04-12',
  },
  {
    id: 'anthropic/claude-4.6-opus',
    displayName: 'Claude Opus 4.6',
    provider: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    inputCostPer1M: 15,
    outputCostPer1M: 75,
    capabilities: { extendedThinking: true, longContext: false, agenticOptimised: true, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'premium',
    recommendedFor: ['prosecutor', 'supreme-prosecutor'],
    lastVerified: '2026-04-12',
  },

  // ── Google ───────────────────────────────────────────────────────────────────

  {
    id: 'google/gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro',
    provider: 'google',
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    inputCostPer1M: 1.25,
    outputCostPer1M: 5,
    capabilities: { extendedThinking: true, longContext: true, agenticOptimised: true, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'premium',
    recommendedFor: ['long-context-synthesis', 'prosecutor', 'pillar-agent'],
    lastVerified: '2026-06-01',
  },
  {
    id: 'google/gemini-3.5-flash',
    displayName: 'Gemini 3.5 Flash',
    provider: 'google',
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    inputCostPer1M: 0.075,
    outputCostPer1M: 0.3,
    capabilities: { extendedThinking: false, longContext: true, agenticOptimised: false, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'standard',
    recommendedFor: ['reviewer', 'governor', 'fast-extraction'],
    lastVerified: '2026-06-01',
  },
  {
    id: 'google/gemini-3.1-pro',
    displayName: 'Gemini 3.1 Pro (stable)',
    provider: 'google',
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    inputCostPer1M: 1.25,
    outputCostPer1M: 5,
    capabilities: { extendedThinking: true, longContext: true, agenticOptimised: true, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'premium',
    recommendedFor: ['long-context-synthesis', 'prosecutor'],
    lastVerified: '2026-04-12',
  },
  {
    id: 'google/gemini-3.1-flash',
    displayName: 'Gemini 3.1 Flash',
    provider: 'google',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    inputCostPer1M: 0.075,
    outputCostPer1M: 0.3,
    capabilities: { extendedThinking: false, longContext: true, agenticOptimised: false, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'standard',
    recommendedFor: ['reviewer', 'governor'],
    lastVerified: '2026-04-12',
  },
  {
    id: 'google/gemini-3.1-flash-lite',
    displayName: 'Gemini 3.1 Flash-Lite',
    provider: 'google',
    contextWindow: 1_000_000,
    maxOutputTokens: 16_384,
    inputCostPer1M: 0.025,
    outputCostPer1M: 0.1,
    capabilities: { extendedThinking: false, longContext: true, agenticOptimised: false, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'standard',
    recommendedFor: ['fast-extraction', 'lightweight-tasks'],
    lastVerified: '2026-04-30',
  },
  {
    id: 'google/gemini-3-flash',
    displayName: 'Gemini 3 Flash',
    provider: 'google',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    inputCostPer1M: 0.5,
    outputCostPer1M: 1.5,
    capabilities: { extendedThinking: false, longContext: true, agenticOptimised: false, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'standard',
    recommendedFor: ['reviewer'],
    lastVerified: '2026-04-30',
  },

  // ── NVIDIA ───────────────────────────────────────────────────────────────────

  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b',
    displayName: 'Nemotron 3 Ultra 550B',
    provider: 'nvidia',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    inputCostPer1M: 3.5,
    outputCostPer1M: 14,
    capabilities: { extendedThinking: false, longContext: true, agenticOptimised: true, freeAvailable: true, toolCalling: true, streaming: true },
    tier: 'premium',
    recommendedFor: ['supreme-prosecutor', 'pillar-agent', 'agentic-pipelines'],
    lastVerified: '2026-06-01',
  },
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    displayName: 'Nemotron 3 Ultra 550B (Free)',
    provider: 'nvidia',
    contextWindow: 1_000_000,
    maxOutputTokens: 16_384,
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    capabilities: { extendedThinking: false, longContext: true, agenticOptimised: true, freeAvailable: true, toolCalling: true, streaming: true },
    tier: 'free',
    recommendedFor: ['pillar-agent', 'reviewer'],
    lastVerified: '2026-06-01',
  },

  // ── Qwen ─────────────────────────────────────────────────────────────────────

  {
    id: 'qwen/qwen3.7-plus',
    displayName: 'Qwen 3.7 Plus',
    provider: 'qwen',
    contextWindow: 131_072,
    maxOutputTokens: 16_384,
    inputCostPer1M: 0.5,
    outputCostPer1M: 2,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: false, freeAvailable: true, toolCalling: true, streaming: true },
    tier: 'standard',
    recommendedFor: ['code-generation', 'pillar-agent'],
    lastVerified: '2026-06-01',
  },
  {
    id: 'qwen/qwen3.7-plus:free',
    displayName: 'Qwen 3.7 Plus (Free)',
    provider: 'qwen',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: false, freeAvailable: true, toolCalling: true, streaming: true },
    tier: 'free',
    recommendedFor: ['reviewer', 'fast-extraction'],
    lastVerified: '2026-06-01',
  },

  // ── xAI ─────────────────────────────────────────────────────────────────────

  {
    id: 'xai/grok-4.3',
    displayName: 'Grok 4.3',
    provider: 'xai',
    contextWindow: 131_072,
    maxOutputTokens: 16_384,
    inputCostPer1M: 2,
    outputCostPer1M: 8,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: true, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'premium',
    recommendedFor: ['pillar-agent', 'prosecutor'],
    lastVerified: '2026-04-30',
  },
  {
    id: 'xai/grok-4.20',
    displayName: 'Grok 4.20',
    provider: 'xai',
    contextWindow: 131_072,
    maxOutputTokens: 16_384,
    inputCostPer1M: 2,
    outputCostPer1M: 8,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: true, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'premium',
    recommendedFor: ['pillar-agent'],
    lastVerified: '2026-04-12',
  },

  // ── Mistral ──────────────────────────────────────────────────────────────────

  {
    id: 'mistralai/devstral-small:free',
    displayName: 'Devstral Small (Free)',
    provider: 'mistral',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: false, freeAvailable: true, toolCalling: true, streaming: true },
    tier: 'free',
    recommendedFor: ['code-generation', 'reviewer'],
    lastVerified: '2026-05-01',
  },
  {
    id: 'mistral/devstral',
    displayName: 'Devstral',
    provider: 'mistral',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    inputCostPer1M: 2,
    outputCostPer1M: 6,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: false, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'standard',
    recommendedFor: ['code-generation'],
    lastVerified: '2026-04-12',
  },

  // ── DeepSeek ─────────────────────────────────────────────────────────────────

  {
    id: 'deepseek/deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    contextWindow: 163_840,
    maxOutputTokens: 16_384,
    inputCostPer1M: 0.44,
    outputCostPer1M: 1.76,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: false, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'standard',
    recommendedFor: ['pillar-agent', 'cost-efficient'],
    lastVerified: '2026-04-30',
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    provider: 'deepseek',
    contextWindow: 163_840,
    maxOutputTokens: 16_384,
    inputCostPer1M: 0.14,
    outputCostPer1M: 0.56,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: false, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'standard',
    recommendedFor: ['reviewer', 'fast-extraction'],
    lastVerified: '2026-04-30',
  },
  {
    id: 'deepseek/deepseek-r1:free',
    displayName: 'DeepSeek R1 (Free)',
    provider: 'deepseek',
    contextWindow: 163_840,
    maxOutputTokens: 16_384,
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    capabilities: { extendedThinking: true, longContext: false, agenticOptimised: false, freeAvailable: true, toolCalling: false, streaming: true },
    tier: 'free',
    recommendedFor: ['reasoning', 'cost-efficient'],
    lastVerified: '2026-05-01',
  },

  // ── Z.ai (GLM) ───────────────────────────────────────────────────────────────

  {
    id: 'z-ai/glm-5.1',
    displayName: 'GLM-5.1',
    provider: 'zai',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    inputCostPer1M: 1.4,
    outputCostPer1M: 5.6,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: false, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'standard',
    recommendedFor: ['pillar-agent'],
    lastVerified: '2026-04-12',
  },
  {
    id: 'z-ai/glm-4.5-air',
    displayName: 'GLM-4.5 Air (Free)',
    provider: 'zai',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: false, freeAvailable: true, toolCalling: true, streaming: true },
    tier: 'free',
    recommendedFor: ['fast-extraction', 'lightweight-tasks'],
    lastVerified: '2026-04-30',
  },

  // ── MiniMax ──────────────────────────────────────────────────────────────────

  {
    id: 'minimax/minimax-m2.7',
    displayName: 'MiniMax M2.7',
    provider: 'minimax',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    inputCostPer1M: 0.3,
    outputCostPer1M: 1.2,
    capabilities: { extendedThinking: false, longContext: true, agenticOptimised: false, freeAvailable: false, toolCalling: true, streaming: true },
    tier: 'standard',
    recommendedFor: ['long-context-synthesis'],
    lastVerified: '2026-04-12',
  },

  // ── Free / Community ─────────────────────────────────────────────────────────

  {
    id: 'openrouter/free',
    displayName: 'Free Router (Auto)',
    provider: 'openrouter',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: false, freeAvailable: true, toolCalling: false, streaming: true },
    tier: 'free',
    recommendedFor: ['experimentation'],
    lastVerified: '2026-04-30',
  },
  {
    id: 'nvidia/nemotron-3-super:free',
    displayName: 'Nemotron 3 Super (Free)',
    provider: 'nvidia',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: true, freeAvailable: true, toolCalling: true, streaming: true },
    tier: 'free',
    recommendedFor: ['reviewer', 'experimentation'],
    lastVerified: '2026-04-30',
  },
  {
    id: 'openai/gpt-oss-120b:free',
    displayName: 'GPT-OSS 120B (Free)',
    provider: 'openai',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: false, freeAvailable: true, toolCalling: true, streaming: true },
    tier: 'free',
    recommendedFor: ['experimentation'],
    lastVerified: '2026-05-01',
  },
  {
    id: 'google/gemma-4-31b-it:free',
    displayName: 'Gemma 4 31B (Free)',
    provider: 'google',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    capabilities: { extendedThinking: false, longContext: false, agenticOptimised: false, freeAvailable: true, toolCalling: false, streaming: true },
    tier: 'free',
    recommendedFor: ['experimentation'],
    lastVerified: '2026-05-01',
  },
];

// ── Lookup helpers ────────────────────────────────────────────────────────────

/** Get a model entry by its canonical ID. Returns undefined if not found. */
export function getModelById(id: string): ModelEntry | undefined {
  return MODEL_REGISTRY.find(m => m.id === id);
}

/** Get all models that have a specific capability enabled. */
export function getModelsByCapability(
  capability: keyof ModelCapabilities
): ModelEntry[] {
  return MODEL_REGISTRY.filter(m => m.capabilities[capability]);
}

/** Get all models recommended for a specific use case. */
export function getModelsForUseCase(useCase: string): ModelEntry[] {
  return MODEL_REGISTRY.filter(m => m.recommendedFor.includes(useCase));
}

/** Get all free-tier models (inputCostPer1M === 0). */
export function getFreeModels(): ModelEntry[] {
  return MODEL_REGISTRY.filter(m => m.tier === 'free');
}

/**
 * Estimate cost in USD for a given model and token counts.
 * Returns 0 for free models.
 */
export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const model = getModelById(modelId);
  if (!model) return 0;
  const inputCost = (inputTokens / 1_000_000) * model.inputCostPer1M;
  const outputCost = (outputTokens / 1_000_000) * model.outputCostPer1M;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

/**
 * Check if a model ID is registered. Use this to validate user-supplied model IDs.
 */
export function isRegisteredModel(id: string): boolean {
  return MODEL_REGISTRY.some(m => m.id === id);
}

/** All unique provider names in the registry. */
export const REGISTERED_PROVIDERS: string[] = [
  ...new Set(MODEL_REGISTRY.map(m => m.provider))
];
