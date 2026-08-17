import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startGeneration, resumeGeneration, startRerunPillar } from './sse';

// Minimal fetch mock factory
function makeFetchMock(events: string[], opts: { status?: number; contentType?: string } = {}) {
  const body = events.map(e => `data: ${e}\n\n`).join('');
  const encoder = new TextEncoder();
  const encoded = encoder.encode(body);
  let offset = 0;

  const reader = {
    read: vi.fn(async () => {
      if (offset >= encoded.length) return { done: true, value: undefined };
      const chunk = encoded.slice(offset, offset + 64);
      offset += 64;
      return { done: false, value: chunk };
    }),
  };

  return vi.fn().mockResolvedValue({
    ok: opts.status === undefined || opts.status < 400,
    status: opts.status ?? 200,
    headers: { get: () => opts.contentType ?? 'text/event-stream' },
    json: async () => ({}),
    body: { getReader: () => reader },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('startGeneration', () => {
  it('emits session_start and complete events', async () => {
    const events = [
      JSON.stringify({ type: 'session_start', sessionId: 'abc', mode: 'fast' }),
      JSON.stringify({ type: 'complete', sessionId: 'abc' }),
    ];
    
    // Original fetch (SSE) and then secondary fetch (Blueprint)
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(makeFetchMock(events)());
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ blueprint: { id: '1' } }),
      });
    }));

    const received: string[] = [];
    startGeneration('Build an app', 'fast', (e) => received.push(e.type));

    await vi.runAllTimersAsync();
    expect(received).toContain('session_start');
    expect(received).toContain('complete');
  });

  it('emits error event on non-ok response', async () => {
    vi.stubGlobal('fetch', makeFetchMock([], { status: 429 }));

    const received: string[] = [];
    startGeneration('Build an app', 'fast', (e) => received.push(e.type));

    await vi.runAllTimersAsync();
    expect(received).toContain('error');
  });

  it('emits error when content-type is text/html', async () => {
    vi.stubGlobal('fetch', makeFetchMock([], { contentType: 'text/html' }));

    const received: string[] = [];
    startGeneration('Build an app', 'fast', (e) => received.push(e.type));

    await vi.runAllTimersAsync();
    expect(received).toContain('error');
  });

  it('abort cancels the stream without emitting error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })));

    const received: string[] = [];
    const cancel = startGeneration('Build an app', 'fast', (e) => received.push(e.type));
    cancel();

    await vi.runAllTimersAsync();
    expect(received).not.toContain('error');
  });
});

describe('resumeGeneration', () => {
  it('emits complete event on success', async () => {
    const events = [JSON.stringify({ type: 'complete', blueprint: { id: '1' } })];
    vi.stubGlobal('fetch', makeFetchMock(events));

    const received: string[] = [];
    resumeGeneration('session-xyz', (e) => received.push(e.type));

    await vi.runAllTimersAsync();
    expect(received).toContain('complete');
  });

  it('handles already-complete sessions returned as JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ blueprint: { id: '99' } }),
      body: { getReader: () => ({ read: vi.fn().mockResolvedValue({ done: true }) }) },
    }));

    const received: any[] = [];
    resumeGeneration('session-xyz', (e) => received.push(e));

    await vi.runAllTimersAsync();
    expect(received[0]?.type).toBe('complete');
    expect(received[0]?.blueprint?.id).toBe('99');
  });

  it('gives up after 5 retries and emits error', async () => {
    // Stream closes immediately without a complete event each time
    vi.stubGlobal('fetch', makeFetchMock([]));

    const received: string[] = [];
    resumeGeneration('session-xyz', (e) => received.push(e.type), new AbortController(), 4);

    await vi.runAllTimersAsync();
    expect(received).toContain('error');
  });
});

describe('startRerunPillar', () => {
  it('sends pillarName and sessionId in request body', async () => {
    const fetchMock = makeFetchMock([JSON.stringify({ type: 'rerun_complete', blueprint: {} })]);
    vi.stubGlobal('fetch', fetchMock);

    startRerunPillar('security', 'session-abc', vi.fn());
    await vi.runAllTimersAsync();

    const call = fetchMock.mock.calls[0]!;
    const body = JSON.parse(call[1]!.body);
    expect(body.pillarName).toBe('security');
    expect(body.sessionId).toBe('session-abc');
  });

  it('sends blueprint object when passed instead of sessionId', async () => {
    const fetchMock = makeFetchMock([JSON.stringify({ type: 'rerun_complete', blueprint: {} })]);
    vi.stubGlobal('fetch', fetchMock);

    startRerunPillar('planning', { id: 'bp-1', prompt: 'test' } as any, vi.fn());
    await vi.runAllTimersAsync();

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body);
    expect(body.blueprint).toBeDefined();
    expect(body.sessionId).toBeUndefined();
  });
});


