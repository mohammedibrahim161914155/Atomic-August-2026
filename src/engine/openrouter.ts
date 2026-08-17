/**
 * src/engine/openrouter.ts
 *
 * AI provider layer — migrated to Vercel AI SDK.
 * Maintains identical public API so no other engine files need to change.
 *
 * Supported providers:
 *   openrouter · openai · anthropic · google · xai · mistral · deepseek · zai · minimax
 */

import {
  generateText as aiGenerateText,
  streamText,
  generateObject,
} from 'ai';
import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createXai } from '@ai-sdk/xai';
import { createMistral } from '@ai-sdk/mistral';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import { ModelConfig, validateConfig } from './config';
import { log } from './logger';
import { AsyncLocalStorage } from 'async_hooks';
import { createHash } from 'crypto';
import { trackHealth } from './providerHealthMonitor';

// ── Message type used internally ──────────────────────────────────────────────
type InternalMessage = { role: 'system' | 'user' | 'assistant'; content: string };

// ── Thinking-capable providers/models ────────────────────────────────────────

const THINKING_MODEL_PREFIXES = ['anthropic/', 'claude-'];

export function modelSupportsThinking(provider: string, model: string): boolean {
  if (provider === 'anthropic') return true;
  if (provider === 'openrouter') {
    return THINKING_MODEL_PREFIXES.some(p => model.toLowerCase().startsWith(p));
  }
  return false;
}

// ── Provider factory cache ────────────────────────────────────────────────────

type ProviderFactory = (modelId: string) => LanguageModel;

function buildProviderFactory(config: ModelConfig): ProviderFactory {
  switch (config.provider) {
    case 'openai': {
      const p = createOpenAI({ apiKey: config.apiKey });
      return (id) => p(id);
    }
    case 'anthropic': {
      const p = createAnthropic({ apiKey: config.apiKey });
      return (id) => p(id);
    }
    case 'google': {
      const p = createGoogleGenerativeAI({ apiKey: config.apiKey });
      return (id) => p(id);
    }
    case 'xai': {
      const p = createXai({ apiKey: config.apiKey });
      return (id) => p(id);
    }
    case 'mistral': {
      const p = createMistral({ apiKey: config.apiKey });
      return (id) => p(id);
    }
    case 'deepseek': {
      const p = createDeepSeek({ apiKey: config.apiKey });
      return (id) => p(id);
    }
    case 'openrouter': {
      const p = createOpenRouter({ apiKey: config.apiKey });
      return (id) => p(id);
    }
    case 'zai': {
      const p = createOpenAI({
        baseURL: 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: config.apiKey,
      });
      return (id) => p(id);
    }
    case 'minimax': {
      const p = createOpenAI({
        baseURL: 'https://api.minimax.chat/v1',
        apiKey: config.apiKey,
      });
      return (id) => p(id);
    }
    default: {
      const p = createOpenAI({ apiKey: config.apiKey });
      return (id) => p(id);
    }
  }
}

interface CacheEntry { factory: ProviderFactory; timestamp: number }
const providerCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE = 50;

function getProviderFactory(config: ModelConfig): ProviderFactory {
  validateConfig(config);
  const key = `${config.provider}:${createHash('sha256').update(config.apiKey).digest('hex').slice(0, 16)}`;
  const now = Date.now();

  const cached = providerCache.get(key);
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    cached.timestamp = now;
    return cached.factory;
  }

  if (providerCache.size >= MAX_CACHE) {
    for (const [k, v] of providerCache.entries()) {
      if (now - v.timestamp >= CACHE_TTL_MS) providerCache.delete(k);
    }
    if (providerCache.size >= MAX_CACHE) {
      let oldest: string | null = null;
      let oldestTime = now;
      for (const [k, v] of providerCache.entries()) {
        if (v.timestamp < oldestTime) { oldestTime = v.timestamp; oldest = k; }
      }
      if (oldest) providerCache.delete(oldest);
    }
  }

  const factory = buildProviderFactory(config);
  providerCache.set(key, { factory, timestamp: now });
  return factory;
}

function getModel(config: ModelConfig, modelId: string): LanguageModel {
  return getProviderFactory(config)(modelId);
}

/**
 * Exported for use by agentRunner.ts so true agentic loops can obtain
 * a LanguageModel instance to pass directly to the Vercel AI SDK.
 */
export function getModelForConfig(config: ModelConfig, modelId: string): LanguageModel {
  return getModel(config, modelId);
}

// Build provider options for Anthropic thinking — must use providerOptions at call-site.
function buildProviderOptions(config: ModelConfig, withThinking: boolean, budgetTokens: number) {
  if (!withThinking) return undefined;
  if (config.provider === 'anthropic' || config.provider === 'openrouter') {
    return {
      anthropic: { thinking: { type: 'enabled' as const, budgetTokens } },
    };
  }
  return undefined;
}

// ── Legacy getAi shim (kept for backward compat) ─────────────────────────────
export const getAi = (config: ModelConfig) => {
  validateConfig(config);
  return { _config: config };
};

// ── API key validation ────────────────────────────────────────────────────────

export async function validateApiKey(config: ModelConfig): Promise<boolean> {
  try {
    validateConfig(config);
    const model = getModel(config, config.fastModel);
    await aiGenerateText({
      model,
      messages: [{ role: 'user', content: 'Say ok' }],
      maxOutputTokens: 5,
      maxRetries: 0,
    });
    return true;
  } catch (err: any) {
    log.error({ err }, `API key validation failed for ${config.provider}: ${err.message}`);
    return false;
  }
}

// ── Concurrency queue ─────────────────────────────────────────────────────────

class PQueue {
  private queue: (() => Promise<void>)[] = [];
  private activeCount = 0;
  constructor(private concurrency: number) {}

  add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        this.activeCount++;
        try { resolve(await fn()); } catch (err) { reject(err); } finally {
          this.activeCount--;
          this.next();
        }
      };
      this.queue.push(run);
      this.next();
    });
  }

  private next() {
    if (this.activeCount < this.concurrency && this.queue.length > 0) {
      this.queue.shift()?.();
    }
  }
}

export function createQueue(concurrency: number) { return new PQueue(concurrency); }
export const queueStorage = new AsyncLocalStorage<PQueue>();

// ── Retry wrapper ─────────────────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  attempt = 0,
  signal?: AbortSignal
): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    const e = err as Record<string, unknown>;
    const status = (e?.status ?? (e?.response as Record<string, unknown>)?.status) as number | undefined;
    const isNetworkError = !status && (e?.name === 'TypeError' || e?.name === 'FetchError' || e?.code === 'ECONNREFUSED');
    const isRetryable = isNetworkError || status === 429 || (status !== undefined && status >= 500);
    const isAuthError =
      (e?.message as string)?.includes('API key not valid') ||
      status === 401 || status === 403;

    if (retries > 0 && isRetryable && !isAuthError) {
      if (signal?.aborted) throw err;
      const delay = Math.min(1500 * Math.pow(2, attempt), 15_000) + Math.random() * 500;
      log.warn(`[ai-sdk] call failed (attempt ${attempt + 1}), retrying in ${Math.round(delay)}ms — ${(err as Error)?.message}`);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('Generation cancelled', 'AbortError'));
        }, { once: true });
      });
      return withRetry(fn, retries - 1, attempt + 1, signal);
    }
    throw err;
  }
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface GenerateResult { text: string; tokens_used: number; }

export interface GenerateOptions {
  model?: string;
  max_tokens?: number;
  extended_thinking?: boolean;
  onChunk?: (chunk: string) => void;
  signal?: AbortSignal;
}

export class StreamInterruptionError extends Error {
  constructor(message: string) { super(message); this.name = 'StreamInterruptionError'; }
}

// ── generateText ──────────────────────────────────────────────────────────────

export async function generateText(
  prompt: string,
  config: ModelConfig,
  systemInstruction?: string,
  options?: GenerateOptions
): Promise<GenerateResult> {
  const queue = queueStorage.getStore();
  const { signal } = options ?? {};

  const checkAbort = () => {
    if (signal?.aborted) throw new Error('AbortError: generation cancelled');
  };

  const execute = async (): Promise<GenerateResult> => {
    checkAbort();
    const modelId = options?.model ?? config.proModel;
    const withThinking =
      !!(options?.extended_thinking &&
      modelSupportsThinking(config.provider, modelId) &&
      config.extendedThinking !== false);
    const budgetTokens = withThinking
      ? Math.min(4000, Math.floor((options?.max_tokens ?? 8192) * 0.4))
      : 0;

    const model = getModel(config, modelId);
    const messages: InternalMessage[] = [];
    if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
    messages.push({ role: 'user', content: prompt });

    const temperature = withThinking ? 1 : 0;
    const providerOptions = buildProviderOptions(config, withThinking, budgetTokens);

    if (options?.onChunk) {
      return await trackHealth(modelId, () => withRetry(async () => {
        checkAbort();
        const result = streamText({
          model,
          messages,
          maxOutputTokens: options.max_tokens,
          temperature,
          maxRetries: 0,
          abortSignal: signal,
          ...(providerOptions ? { providerOptions } : {}),
        });

        let fullText = '';
        let tokens = 0;
        try {
          for await (const chunk of result.textStream) {
            checkAbort();
            fullText += chunk;
            options.onChunk!(chunk);
          }
          const usage = await result.usage;
          tokens = usage.totalTokens ?? 0;
        } catch (err: unknown) {
          if (signal?.aborted) throw err;
          throw new StreamInterruptionError(`Stream interrupted: ${(err as Error).message}`);
        }
        return { text: fullText, tokens_used: tokens };
      }, 3, 0, signal));
    }

    return trackHealth(modelId, () => withRetry(async () => {
      checkAbort();
      const result = await aiGenerateText({
        model,
        messages,
        maxOutputTokens: options?.max_tokens,
        temperature,
        maxRetries: 0,
        abortSignal: signal,
        ...(providerOptions ? { providerOptions } : {}),
      });
      return { text: result.text, tokens_used: result.usage.totalTokens ?? 0 };
    }, 3, 0, signal));
  };

  return queue ? queue.add(execute) : execute();
}

// ── generateJson ──────────────────────────────────────────────────────────────

export async function generateJson<T>(
  prompt: string,
  config: ModelConfig,
  schema: z.ZodType<T>,
  systemInstruction?: string,
  options?: GenerateOptions
): Promise<{ data: T; tokens_used: number }> {
  const queue = queueStorage.getStore();
  const { signal } = options ?? {};

  const checkAbort = () => {
    if (signal?.aborted) throw new Error('AbortError: generation cancelled');
  };

  const execute = async (): Promise<{ data: T; tokens_used: number }> => {
    checkAbort();
    const modelId = options?.model ?? config.proModel;
    const withThinking =
      !!(options?.extended_thinking &&
      modelSupportsThinking(config.provider, modelId) &&
      config.extendedThinking !== false);
    const budgetTokens = withThinking
      ? Math.min(4000, Math.floor((options?.max_tokens ?? 8192) * 0.4))
      : 0;

    const model = getModel(config, modelId);
    const messages: InternalMessage[] = [];
    if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
    messages.push({ role: 'user', content: prompt });

    const temperature = withThinking ? 1 : 0;
    const providerOptions = buildProviderOptions(config, withThinking, budgetTokens);

    log.debug(`[generateJson] provider=${config.provider} model=${modelId} thinking=${withThinking}`);

    return withRetry(async () => {
      checkAbort();
      try {
        const result = await generateObject({
          model,
          schema,
          messages,
          maxOutputTokens: options?.max_tokens,
          temperature,
          maxRetries: 0,
          abortSignal: signal,
          ...(providerOptions ? { providerOptions } : {}),
        });
        return { data: result.object as T, tokens_used: result.usage.totalTokens ?? 0 };
      } catch (err: any) {
        // Fallback: if generateObject fails, try plain generateText + JSON.parse
        if (
          err?.name === 'AI_NoObjectGeneratedError' ||
          err?.message?.includes('schema') ||
          err?.message?.includes('JSON') ||
          err?.message?.includes('object')
        ) {
          log.warn({ err }, '[generateJson] generateObject failed — using text+parse fallback');
          const fallback = await aiGenerateText({
            model,
            messages: [
              ...messages,
              {
                role: 'user' as const,
                content:
                  'Return ONLY a valid JSON object that matches the required schema. No markdown fences, no explanation.',
              },
            ],
            maxOutputTokens: options?.max_tokens,
            temperature,
            maxRetries: 0,
            abortSignal: signal,
            ...(providerOptions ? { providerOptions } : {}),
          });
          const raw = fallback.text.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
          const parsed = JSON.parse(raw);
          const data = schema.parse(parsed);
          return { data, tokens_used: fallback.usage.totalTokens ?? 0 };
        }
        throw err;
      }
    }, 3, 0, signal);
  };

  return queue ? queue.add(execute) : execute();
}
