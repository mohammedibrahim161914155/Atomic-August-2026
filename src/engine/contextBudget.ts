/**
 * src/engine/contextBudget.ts
 *
 * Context Window Budget Manager — prevents context overflow before every LLM dispatch.
 *
 * Usage:
 *   const budget = ContextBudgetManager.calculate({ modelId, systemPrompt, context, outputReserve });
 *   if (budget.available < 1000) throw new ContextOverflowError(budget);
 */

import { getModelById } from '../models/registry';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ContextBudget {
  /** OpenRouter / provider model ID */
  modelId: string;
  /** Model's total context window in tokens */
  totalCapacity: number;
  /** Estimated tokens consumed by system prompt */
  systemPromptTokens: number;
  /** Estimated tokens consumed by context/history messages */
  contextTokens: number;
  /** Tokens reserved for the output */
  outputReserve: number;
  /** Available tokens = capacity − systemPrompt − context − outputReserve */
  available: number;
  /** Whether the budget is within safe limits (available >= minimumAvailable) */
  withinBudget: boolean;
  /** Warning threshold: budget is tight but not overflowed */
  tight: boolean;
}

export interface ContextBudgetInput {
  /** Model ID to look up context window from registry */
  modelId: string;
  /** System prompt text */
  systemPrompt?: string;
  /** Context / user message text(s) — can be a string or an array of strings */
  context?: string | string[];
  /** Tokens reserved for model output (default: 4096) */
  outputReserve?: number;
  /** Minimum available tokens before flagging as unsafe (default: 1000) */
  minimumAvailable?: number;
  /** Override context window if model is not in registry */
  contextWindowOverride?: number;
}

// ── Error type ────────────────────────────────────────────────────────────────

export class ContextOverflowError extends Error {
  public readonly budget: ContextBudget;

  constructor(budget: ContextBudget) {
    super(
      `Context overflow for model ${budget.modelId}: ` +
      `available=${budget.available} tokens, ` +
      `needed=${budget.systemPromptTokens + budget.contextTokens + budget.outputReserve}, ` +
      `capacity=${budget.totalCapacity}. ` +
      `Truncate context or use a model with a larger context window.`
    );
    this.name = 'ContextOverflowError';
    this.budget = budget;
  }
}

// ── Token estimator ───────────────────────────────────────────────────────────

/**
 * Fast token estimator using character-to-token ratio.
 * Uses ~3.5 chars/token for English prose (conservative approximation).
 * For production, swap with tiktoken or a provider-specific tokenizer.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~3.5 chars per token for mixed code+prose; round up for safety
  return Math.ceil(text.length / 3.5);
}

// ── Fallback context windows ──────────────────────────────────────────────────

const FALLBACK_CONTEXT_WINDOWS: Record<string, number> = {
  'openai/gpt-5.4': 128_000,
  'openai/gpt-5.3-chat': 128_000,
  'anthropic/claude-4.6-sonnet': 200_000,
  'anthropic/claude-4.6-opus': 200_000,
  'anthropic/claude-opus-4.7': 200_000,
  'anthropic/claude-opus-4-8': 200_000,
  'google/gemini-3.1-pro': 1_000_000,
  'google/gemini-3.1-flash': 1_000_000,
  'google/gemini-3.1-pro-preview': 1_000_000,
  'google/gemini-3.5-flash': 1_000_000,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_OUTPUT_RESERVE = 4_096;
const DEFAULT_MINIMUM_AVAILABLE = 1_000;

// ── Budget calculator ─────────────────────────────────────────────────────────

export class ContextBudgetManager {
  /**
   * Calculate the context budget for an LLM dispatch.
   * Call this before every LLM call — if withinBudget is false, throw ContextOverflowError.
   */
  static calculate(input: ContextBudgetInput): ContextBudget {
    const {
      modelId,
      systemPrompt = '',
      context,
      outputReserve = DEFAULT_OUTPUT_RESERVE,
      minimumAvailable = DEFAULT_MINIMUM_AVAILABLE,
      contextWindowOverride,
    } = input;

    // Resolve context window
    let totalCapacity: number;
    if (contextWindowOverride !== undefined) {
      totalCapacity = contextWindowOverride;
    } else {
      const registryEntry = getModelById(modelId);
      totalCapacity =
        registryEntry?.contextWindow ??
        FALLBACK_CONTEXT_WINDOWS[modelId] ??
        DEFAULT_CONTEXT_WINDOW;
    }

    // Estimate token counts
    const systemPromptTokens = estimateTokens(systemPrompt);
    const contextText = Array.isArray(context)
      ? context.join('\n')
      : (context ?? '');
    const contextTokens = estimateTokens(contextText);

    const used = systemPromptTokens + contextTokens + outputReserve;
    const available = totalCapacity - used;
    const withinBudget = available >= minimumAvailable;
    const tight = withinBudget && available < minimumAvailable * 3;

    return {
      modelId,
      totalCapacity,
      systemPromptTokens,
      contextTokens,
      outputReserve,
      available,
      withinBudget,
      tight,
    };
  }

  /**
   * Assert the budget is safe. Throws ContextOverflowError if not.
   * Use this as a guard before every LLM dispatch.
   */
  static assertSafe(input: ContextBudgetInput): ContextBudget {
    const budget = this.calculate(input);
    if (!budget.withinBudget) {
      throw new ContextOverflowError(budget);
    }
    return budget;
  }

  /**
   * Truncate context text to fit within the budget.
   * Trims from the beginning (oldest content) to preserve the most recent context.
   * Returns the truncated text and a flag indicating whether truncation occurred.
   */
  static truncateToFit(input: ContextBudgetInput & { context: string }): {
    text: string;
    truncated: boolean;
    budget: ContextBudget;
  } {
    let budget = this.calculate(input);
    let { context } = input;
    let truncated = false;

    if (!budget.withinBudget) {
      // Calculate how many characters we can keep
      const systemTokens = budget.systemPromptTokens;
      const outputReserve = input.outputReserve ?? DEFAULT_OUTPUT_RESERVE;
      const minimumAvailable = input.minimumAvailable ?? DEFAULT_MINIMUM_AVAILABLE;
      const availableForContext = budget.totalCapacity - systemTokens - outputReserve - minimumAvailable;
      
      if (availableForContext <= 0) {
        context = '';
      } else {
        // Convert available tokens back to approximate character count (3.5 chars/token)
        const maxChars = Math.floor(availableForContext * 3.5);
        // Trim from the beginning, preserve the end (most recent content)
        context = context.length > maxChars
          ? `[...context truncated for budget...]\n${context.slice(-maxChars)}`
          : context;
      }
      truncated = true;
      budget = this.calculate({ ...input, context });
    }

    return { text: context, truncated, budget };
  }

  /**
   * Format a budget as a human-readable summary for logging.
   */
  static summarize(budget: ContextBudget): string {
    const pct = Math.round((1 - budget.available / budget.totalCapacity) * 100);
    return (
      `[context-budget] model=${budget.modelId} ` +
      `capacity=${budget.totalCapacity} ` +
      `used=${budget.totalCapacity - budget.available} (${pct}%) ` +
      `available=${budget.available} ` +
      `status=${budget.withinBudget ? (budget.tight ? 'TIGHT' : 'OK') : 'OVERFLOW'}`
    );
  }
}
