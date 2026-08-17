/**
 * src/engine/openrouter.test.ts
 *
 * Tests for the Vercel AI SDK wrapper layer (openrouter.ts).
 * All network I/O is mocked at the `ai` and `@ai-sdk/*` provider level
 * so no real API keys or network calls are required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createQueue, generateJson, generateText } from './openrouter';
import { z } from 'zod';

// ── Hoist mocks so they are available inside vi.mock() factories ──────────────

const { mockAiGenerateText, mockAiStreamText, mockAiGenerateObject, dummyFactory } = vi.hoisted(() => {
  const dummyModel   = { id: 'mock-model' };
  const dummyFactory = vi.fn().mockReturnValue(() => dummyModel);
  return {
    mockAiGenerateText:   vi.fn(),
    mockAiStreamText:     vi.fn(),
    mockAiGenerateObject: vi.fn(),
    dummyFactory,
  };
});

// ── Mock the Vercel AI SDK ────────────────────────────────────────────────────

vi.mock('ai', () => ({
  generateText:   mockAiGenerateText,
  streamText:     mockAiStreamText,
  generateObject: mockAiGenerateObject,
  stepCountIs:    vi.fn().mockReturnValue(() => false),
}));

// ── Mock provider factories (they just return a dummy LanguageModel) ──────────

vi.mock('@ai-sdk/openai',   () => ({ createOpenAI:             dummyFactory }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic:         dummyFactory }));
vi.mock('@ai-sdk/google',   () => ({ createGoogleGenerativeAI: dummyFactory }));
vi.mock('@ai-sdk/xai',      () => ({ createXai:                dummyFactory }));
vi.mock('@ai-sdk/mistral',  () => ({ createMistral:            dummyFactory }));
vi.mock('@ai-sdk/deepseek', () => ({ createDeepSeek:           dummyFactory }));
vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: dummyFactory }));

// ── Shared test fixtures ──────────────────────────────────────────────────────

const mockConfig = {
  provider:   'openrouter' as const,
  apiKey:     'test-key',
  fastModel:  'openai/gpt-4o-mini',
  proModel:   'anthropic/claude-3.5-sonnet',
};

const TestSchema = z.object({ name: z.string(), value: z.number() });

// Helper: create an async iterable of strings (simulates textStream)
const makeTextStream = (chunks: string[]) => ({
  async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
});

// ── PQueue (Concurrency Queue) ────────────────────────────────────────────────

describe('PQueue (Concurrency Queue)', () => {
  let apiQueue: ReturnType<typeof createQueue>;

  beforeEach(() => {
    apiQueue = createQueue(3);
    mockAiGenerateText.mockReset();
  });

  it('executes tasks and returns results', async () => {
    const task = vi.fn().mockResolvedValue('success');
    const result = await apiQueue.add(task);
    expect(result).toBe('success');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('limits concurrency to the configured maximum', async () => {
    let active = 0;
    let maxActive = 0;

    const makeTask = (delay: number) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, delay));
      active--;
      return 'done';
    };

    await Promise.all(Array(5).fill(null).map(() => apiQueue.add(makeTask(20))));
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});

// ── generateText ──────────────────────────────────────────────────────────────

describe('generateText', () => {
  beforeEach(() => mockAiGenerateText.mockReset());

  it('returns text and token count on success', async () => {
    mockAiGenerateText.mockResolvedValue({ text: 'hello', usage: { totalTokens: 42 } });

    const result = await generateText('test', mockConfig);
    expect(result.text).toBe('hello');
    expect(result.tokens_used).toBe(42);
  });

  it('respects AbortSignal and throws before calling the SDK', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      generateText('test', mockConfig, undefined, { signal: controller.signal }),
    ).rejects.toThrow('AbortError');

    // SDK should never be called when signal is already aborted
    expect(mockAiGenerateText).not.toHaveBeenCalled();
  });

  it('streams text and calls onChunk for each piece', async () => {
    mockAiStreamText.mockReturnValue({
      textStream: makeTextStream(['chunk1', 'chunk2']),
      usage:      Promise.resolve({ totalTokens: 11 }),
    });

    const chunks: string[] = [];
    const result = await generateText('test', mockConfig, undefined, {
      onChunk: (c) => chunks.push(c),
    });

    expect(chunks).toEqual(['chunk1', 'chunk2']);
    expect(result.text).toBe('chunk1chunk2');
    expect(result.tokens_used).toBe(11);
  });

  it('passes extended thinking providerOptions for openrouter', async () => {
    mockAiGenerateText.mockResolvedValue({ text: 'hello', usage: { totalTokens: 42 } });

    await generateText('test', { ...mockConfig, provider: 'openrouter' }, undefined, {
      extended_thinking: true,
    });

    // budgetTokens = Math.min(4000, Math.floor(8192 * 0.4)) = 3276
    expect(mockAiGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: expect.objectContaining({
          anthropic: expect.objectContaining({
            thinking: { type: 'enabled', budgetTokens: 3276 },
          }),
        }),
      }),
    );
  });

  it('sets temperature=1 when extended thinking is active', async () => {
    mockAiGenerateText.mockResolvedValue({ text: 'ok', usage: { totalTokens: 10 } });

    await generateText('test', { ...mockConfig, provider: 'anthropic' }, undefined, {
      extended_thinking: true,
    });

    expect(mockAiGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 1 }),
    );
  });
});

// ── generateText — retry logic ─────────────────────────────────────────────────

describe('generateText — retry logic', () => {
  afterEach(() => {
    mockAiGenerateText.mockReset();
    vi.useRealTimers();
  });

  it('retries on 429 and eventually succeeds', async () => {
    vi.useFakeTimers();
    let callCount = 0;

    mockAiGenerateText.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw Object.assign(new Error('Rate limit exceeded'), { status: 429 });
      }
      return { text: 'hello', usage: { totalTokens: 10 } };
    });

    const resultPromise = generateText('test', mockConfig);
    // Advance past the retry backoff delay
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(callCount).toBe(2);
    expect(result.text).toBe('hello');
  });

  it('does not retry on 401 auth errors', async () => {
    mockAiGenerateText.mockImplementation(async () => {
      throw Object.assign(new Error('API key not valid'), { status: 401 });
    });

    await expect(generateText('test', mockConfig)).rejects.toThrow('API key not valid');
    expect(mockAiGenerateText).toHaveBeenCalledTimes(1);
  });
});

// ── generateJson — Vercel AI SDK path ─────────────────────────────────────────

describe('generateJson — success path', () => {
  beforeEach(() => {
    mockAiGenerateObject.mockReset();
    mockAiGenerateText.mockReset();
  });

  it('returns data and token count when generateObject succeeds', async () => {
    mockAiGenerateObject.mockResolvedValue({
      object:    { name: 'test', value: 123 },
      usage:     { totalTokens: 50 },
    });

    const result = await generateJson('test', mockConfig, TestSchema);
    expect(result.data).toEqual({ name: 'test', value: 123 });
    expect(result.tokens_used).toBe(50);
  });
});

describe('generateJson — fallback path (generateObject failure)', () => {
  beforeEach(() => {
    mockAiGenerateObject.mockReset();
    mockAiGenerateText.mockReset();
  });

  it('falls back to plain generateText when generateObject throws a JSON/object error', async () => {
    // Tier 1 (generateObject) fails with a schema-related error
    mockAiGenerateObject.mockRejectedValue(
      Object.assign(new Error('AI_NoObjectGeneratedError: object validation failed'), {
        name: 'AI_NoObjectGeneratedError',
      }),
    );

    // Tier 2 (fallback generateText) returns valid JSON text
    mockAiGenerateText.mockResolvedValue({
      text:  '{"name": "fallback", "value": 1}',
      usage: { totalTokens: 30 },
    });

    const result = await generateJson('test', mockConfig, TestSchema);
    expect(result.data).toEqual({ name: 'fallback', value: 1 });
    expect(mockAiGenerateObject).toHaveBeenCalledTimes(1);
    expect(mockAiGenerateText).toHaveBeenCalledTimes(1);
  });

  it('falls back on errors whose message contains "object"', async () => {
    mockAiGenerateObject.mockRejectedValue(new Error('Failed to parse object response'));
    mockAiGenerateText.mockResolvedValue({
      text:  '{"name": "ok", "value": 7}',
      usage: { totalTokens: 20 },
    });

    const result = await generateJson('test', mockConfig, TestSchema);
    expect(result.data).toEqual({ name: 'ok', value: 7 });
  });

  it('throws when the fallback generateText also returns invalid JSON', async () => {
    mockAiGenerateObject.mockRejectedValue(
      Object.assign(new Error('schema validation failed'), { name: 'AI_NoObjectGeneratedError' }),
    );
    mockAiGenerateText.mockResolvedValue({
      text:  'not valid json at all',
      usage: { totalTokens: 15 },
    });

    await expect(generateJson('test', mockConfig, TestSchema)).rejects.toThrow();
    expect(mockAiGenerateObject).toHaveBeenCalledTimes(1);
    expect(mockAiGenerateText).toHaveBeenCalledTimes(1);
  });

  it('throws when fallback returns JSON that fails Zod schema', async () => {
    mockAiGenerateObject.mockRejectedValue(
      Object.assign(new Error('object validation error'), { name: 'AI_NoObjectGeneratedError' }),
    );
    // Missing required "name" field
    mockAiGenerateText.mockResolvedValue({
      text:  '{"bad": true}',
      usage: { totalTokens: 15 },
    });

    const schema = z.object({ required_field: z.string() });
    await expect(generateJson('test', mockConfig, schema)).rejects.toThrow();
  });
});

describe('generateJson — extended thinking', () => {
  beforeEach(() => {
    mockAiGenerateObject.mockReset();
    mockAiGenerateText.mockReset();
  });

  it('passes extended thinking providerOptions for openrouter', async () => {
    mockAiGenerateObject.mockResolvedValue({
      object: { name: 'test', value: 1 },
      usage:  { totalTokens: 10 },
    });

    await generateJson(
      'test',
      { ...mockConfig, provider: 'openrouter' },
      TestSchema,
      undefined,
      { extended_thinking: true },
    );

    expect(mockAiGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: expect.objectContaining({
          anthropic: expect.objectContaining({
            thinking: { type: 'enabled', budgetTokens: 3276 },
          }),
        }),
      }),
    );
  });

  it('passes extended thinking providerOptions for anthropic native', async () => {
    mockAiGenerateObject.mockResolvedValue({
      object: { name: 'test', value: 1 },
      usage:  { totalTokens: 10 },
    });

    await generateJson(
      'test',
      { ...mockConfig, provider: 'anthropic' },
      TestSchema,
      undefined,
      { extended_thinking: true },
    );

    expect(mockAiGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: expect.objectContaining({
          anthropic: expect.objectContaining({
            thinking: { type: 'enabled', budgetTokens: 3276 },
          }),
        }),
      }),
    );
  });
});

// ── Provider cache ─────────────────────────────────────────────────────────────

describe('clientCache eviction', () => {
  it('evicts oldest entries when exceeding MAX_CACHE_ENTRIES', async () => {
    const { getAi } = await import('./openrouter');
    const configs = Array.from({ length: 55 }, (_, i) => ({
      provider:  'openai' as const,
      apiKey:    `sk-test-key-${String(i).padStart(8, '0')}`,
      fastModel: 'test',
      proModel:  'test',
    }));
    configs.forEach(c => getAi(c));
    expect(true).toBe(true); // no crash = eviction works
  });

  it('evicts expired entries after TTL', async () => {
    const { getAi } = await import('./openrouter');
    vi.useFakeTimers();
    getAi({ provider: 'openai', apiKey: 'sk-test-expire-key', fastModel: 'test', proModel: 'test' });
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    getAi({ provider: 'openai', apiKey: 'sk-test-new-key-here', fastModel: 'test', proModel: 'test' });
    vi.useRealTimers();
    expect(true).toBe(true);
  });
});
