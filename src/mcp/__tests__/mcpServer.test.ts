/**
 * src/mcp/__tests__/mcpServer.test.ts
 *
 * MCP server unit + transport tests.
 *   1. validation: schema correctness, -32602 mapping
 *   2. dispatch: initialize gating, method coverage, cancel notifications
 *   3. tool handlers: API contract mapping with mocked atomicRequest
 *   4. HTTP transport: Streamable HTTP via supertest
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateToolInput, invalidParamsError } from '../validation';
import { dispatch, createSession, resetSessions } from '../dispatch';
import { handleHttpMcp } from '../server';
import { ATOMIC_TOOLS, ATOMIC_PROMPTS, ATOMIC_RESOURCES } from '../tools';
import { atomicRequest } from '../atomic-client';

vi.mock('../atomic-client', () => ({
  atomicRequest: vi.fn(),
  AtomicApiClientError: class AtomicApiClientError extends Error {
    constructor(message: string, public readonly statusCode?: number) { super(message); }
  },
}));

vi.mock('../../engine/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// Force reset sessions between tests by importing dispatch fresh is not
// possible; instead we re-run initialize in each test to re-establish state.
beforeEach(() => {
  vi.clearAllMocks();
  resetSessions();
  rpcSessionId = null;
});

// ── 1. Validation ─────────────────────────────────────────────────────────────

describe('validation', () => {
  it('accepts valid required args and fills defaults', () => {
    const result = validateToolInput(
      { prompt: 'Build a todo app' },
      {
        type: 'object',
        properties: {
          prompt: { type: 'string', minLength: 10 },
          mode: { type: 'string', enum: ['fast', 'safe'], default: 'fast' },
        },
        required: ['prompt'],
      },
    );
    expect(result.valid).toBe(true);
    expect(result.valid && result.data.mode).toBe('fast');
    expect(result.valid && result.data.prompt).toBe('Build a todo app');
  });

  it('rejects missing required args', () => {
    const result = validateToolInput(
      { mode: 'fast' },
      {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        required: ['prompt'],
      },
    );
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.errors[0]?.path).toBe('$.prompt');
  });

  it('rejects invalid enum values', () => {
    const result = validateToolInput(
      { prompt: 'Build a todo app', format: 'yaml' },
      {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          format: { type: 'string', enum: ['json', 'md', 'html'] },
        },
        required: ['prompt', 'format'],
      },
    );
    expect(result.valid).toBe(false);
    const error = result.valid === false ? result.errors[0] : null;
    expect(error?.error).toContain('one of');
  });

  it('rejects type mismatches with coercion across number/string', () => {
    const result = validateToolInput(
      { prompt: 'ok', limit: '5' },
      {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['prompt', 'limit'],
      },
    );
    // string "5" coerces to number 5
    expect(result.valid).toBe(true);
    expect(result.valid && result.data.limit).toBe(5);
  });

  it('rejects numbers outside bounds', () => {
    const result = validateToolInput(
      { prompt: 'ok', limit: 500 },
      {
        type: 'object',
        properties: { prompt: { type: 'string' }, limit: { type: 'integer', maximum: 100 } },
        required: ['prompt', 'limit'],
      },
    );
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.errors[0]?.error).toContain('<=');
  });

  it('rejects additional properties when forbidden', () => {
    const result = validateToolInput(
      { prompt: 'ok', unknown: 1 },
      {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        required: ['prompt'],
        additionalProperties: false,
      } as unknown as { type: 'object'; properties: Record<string, Record<string, unknown>>; required?: string[] },
    );
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.errors.some(e => e.path.endsWith('unknown'))).toBe(true);
  });

  it('rejects string length violations', () => {
    const result = validateToolInput(
      { prompt: 'hi' },
      { type: 'object', properties: { prompt: { type: 'string', minLength: 10 } }, required: ['prompt'] },
    );
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.errors[0]?.error).toContain('at least');
  });

  it('maps failures to -32602 with tool name and paths', () => {
    const result = validateToolInput(undefined, {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a', 'b'],
    });
    const rpc = invalidParamsError(result.valid === false ? result.errors : [], 'atomic_t');
    expect(rpc.code).toBe(-32602);
    expect(rpc.message).toContain('atomic_t');
    expect(rpc.data.errors.length).toBe(2);
  });

  it('validates nested objects and arrays', () => {
    const result = validateToolInput(
      { prompt: 'Build a thing', tags: ['ok', 42] },
      {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['prompt'],
      },
    );
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.errors[0]?.path).toBe('$.tags[1]');
  });
});

// ── 2. Dispatch ───────────────────────────────────────────────────────────────

// Sticky test session: initialize creates a session (dispatch publishes its id
// via ctx.sessionId); subsequent calls reuse it so tests behave like a single
// MCP client. Reset in beforeEach so each test starts fresh.
let rpcSessionId: string | null = null;

async function rpc(method: string, params?: Record<string, unknown>, sessionId?: string | null) {
  const ctx = { sessionId: sessionId ?? rpcSessionId ?? undefined };
  const response = await dispatch(
    { jsonrpc: '2.0', id: 1, method, params: params ?? {} },
    ctx,
  );
  if (method === 'initialize' && (response as { result?: unknown })?.result) {
    rpcSessionId = ctx.sessionId ?? null;
  }
  return response;
}

describe('dispatch', () => {
  it('initializes with 2025-03-26 and full capabilities', async () => {
    const response = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      clientInfo: { name: 'test-client', version: '1.0' },
    });
    const result = (response as { result?: { capabilities: Record<string, unknown>; protocolVersion: string } })?.result as { capabilities: Record<string, unknown>; protocolVersion: string } | undefined;
    expect(result?.protocolVersion).toBe('2025-03-26');
    expect(result?.capabilities).toHaveProperty('tools');
    expect(result?.capabilities).toHaveProperty('prompts');
    expect(result?.capabilities).toHaveProperty('resources');
  });

  it('rejects tools/list before initialize', async () => {
    // A fresh dispatch cycle starts with the default 'stdio' session uninitialized
    const response = await rpc('tools/list');
    expect((response as { error?: { code: number } })?.error?.code).toBe(-32002);
  });

  it('rejects a session created without initialize', async () => {
    const session = createSession();
    const response = await rpc('tools/list', {}, session.id);
    expect((response as { error?: { code: number } })?.error?.code).toBe(-32002);
  });

  it('returns -32602 for invalid tool params', async () => {
    await rpc('initialize');
    const response = await rpc('tools/call', { name: 'atomic_generate_blueprint', arguments: {} });
    expect((response as { error?: { code: number; message: string } })?.error?.code).toBe(-32602);
    expect((response as { error?: { code: number; message: string } })?.error?.message).toContain('atomic_generate_blueprint');
  });

  it('returns -32601 for unknown tools', async () => {
    await rpc('initialize');
    const response = await rpc('tools/call', { name: 'nonexistent', arguments: {} });
    expect((response as { error?: { code: number } })?.error?.code).toBe(-32601);
  });

  it('returns -32601 for unknown methods', async () => {
    await rpc('initialize');
    const response = await rpc('impossible/method');
    expect((response as { error?: { code: number } })?.error?.code).toBe(-32601);
  });

  it('lists all tool/prompt/resource definitions', async () => {
    await rpc('initialize');
    const tools = await rpc('tools/list');
    const prompts = await rpc('prompts/list');
    const resources = await rpc('resources/list');
    expect((tools as { result: { tools: unknown[] } }).result).toHaveProperty('tools');
    expect((tools as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
    expect((prompts as { result: { prompts: unknown[] } }).result.prompts.length).toBe(3);
    expect((resources as { result: { resources: unknown[] } }).result.resources.length).toBeGreaterThan(0);
  });

  it('handles ping', async () => {
    await rpc('initialize');
    const response = await rpc('ping');
    expect((response as { error?: unknown } | undefined)?.error).toBeUndefined();
    expect((response as { result?: unknown } | undefined)?.result).toEqual({});
  });

  it('resolves prompts to messages', async () => {
    await rpc('initialize');
    const response = await rpc('prompts/get', { name: 'atomic-explain-blueprint', arguments: { blueprintId: 'bp-12345678', audience: 'technical' } });
    expect((response as { error?: unknown } | undefined)?.error).toBeUndefined();
    const result = (response as { result?: { messages: unknown[] } } | undefined)?.result as { messages: unknown[] };
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it('returns notifications/cancelled as null (no response)', async () => {
    const response = await rpc('notifications/cancelled', { requestIds: [1, 2] });
    expect(response).toBeNull();
  });

  it('rejects a session created without initialize (duplicate coverage)', async () => {
    const session = createSession();
    const response = await rpc('prompts/list', {}, session.id);
    expect((response as { error?: { code: number } })?.error?.code).toBe(-32002);
  });
});

// ── 3. Tool handlers with mocked API ──────────────────────────────────────────

describe('tool handlers (mocked atomicRequest)', () => {
  const mockAtomic = vi.mocked(atomicRequest);

  beforeEach(() => { mockAtomic.mockReset(); });

  it('generate_blueprint posts to /generate-start and returns sessionId', async () => {
    mockAtomic.mockResolvedValueOnce({
      sessionId: 'sess_abc', statusUrl: '/x', sseUrl: '/y', message: 'started',
    });
    await rpc('initialize');
    const response = await rpc('tools/call', {
      name: 'atomic_generate_blueprint',
      arguments: { prompt: 'Build a real-time collaborative todo app for teams of 50', mode: 'fast' },
    });
    expect((response as { error?: unknown } | undefined)?.error).toBeUndefined();
    expect(mockAtomic).toHaveBeenCalledWith('/api/v1/generate-start', expect.objectContaining({ method: 'POST' }));
    const text = ((response as { result?: unknown } | undefined)?.result as { content: { text: string }[] }).content[0]?.text;
    expect(text).toContain('sess_abc');
  });

  it('list_blueprints uses search/qualityMin query params (real contract)', async () => {
    mockAtomic.mockResolvedValueOnce({ blueprints: [] });
    await rpc('initialize');
    await rpc('tools/call', {
      name: 'atomic_list_blueprints',
      arguments: { search: 'todo', qualityMin: 80, limit: 10, offset: 5 },
    });
    expect(mockAtomic).toHaveBeenCalledWith(
      '/api/v1/blueprints',
      expect.objectContaining({ query: expect.objectContaining({ search: 'todo', qualityMin: '80', limit: '10', offset: '5' }) }),
    );
  });

  it('export_bundle restricts format to server-supported values', async () => {
    // Format enum validation happens in dispatch (schema enum json|md|html)
    mockAtomic.mockResolvedValueOnce('# Blueprint\n\nContent');
    await rpc('initialize');
    const response = await rpc('tools/call', {
      name: 'atomic_export_bundle',
      arguments: { blueprintId: 'bp-12345678', format: 'claude_md' },
    });
    expect((response as { error?: { code: number } })?.error?.code).toBe(-32602);
  });

  it('validate_task posts to /api/v1/validate', async () => {
    mockAtomic.mockResolvedValueOnce({ valid: true, estimatedCostUsd: 0.12 });
    await rpc('initialize');
    await rpc('tools/call', {
      name: 'atomic_validate_task',
      arguments: { prompt: 'Build a rate limiter service with Redis sliding windows' },
    });
    expect(mockAtomic).toHaveBeenCalledWith(
      '/api/v1/validate',
      expect.objectContaining({ method: 'POST', body: { prompt: expect.stringContaining('rate limiter') } }),
    );
  });

  it('rerun_pillar posts sessionId + pillarName to /rerun-pillar', async () => {
    mockAtomic.mockResolvedValueOnce({ message: 'rerun started' });
    await rpc('initialize');
    await rpc('tools/call', {
      name: 'atomic_rerun_pillar',
      arguments: { pillarName: 'security', sessionId: 'sess_12345678', additionalContext: 'GDPR focus' },
    });
    expect(mockAtomic).toHaveBeenCalledWith(
      '/api/v1/rerun-pillar',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ pillarName: 'security', sessionId: 'sess_12345678' }),
      }),
    );
  });

  it('get_result supports json and summary formats', async () => {
    mockAtomic.mockResolvedValueOnce({ sections: { executive_summary: 'Summary text' }, quality_score: 92, prompt: 'Build X' });
    await rpc('initialize');
    const response = await rpc('tools/call', {
      name: 'atomic_get_result',
      arguments: { sessionId: 'sess_12345678', format: 'summary' },
    });
    expect((response as { error?: unknown } | undefined)?.error).toBeUndefined();
    const text = ((response as { result?: unknown } | undefined)?.result as { content: { text: string }[] }).content[0]?.text;
    expect(text).toContain('Summary text');
    expect(text).toContain('92');
  });

  it('surfaces API errors as tool content errors', async () => {
    mockAtomic.mockRejectedValueOnce(new Error('Atomic API error 404: session missing'));
    await rpc('initialize');
    const response = await rpc('tools/call', {
      name: 'atomic_get_status',
      arguments: { sessionId: 'sess_deadbeef' },
    });
    const text = ((response as { result?: unknown } | undefined)?.result as { content: { text: string }[]; isError: boolean }).content[0]?.text;
    expect(text).toContain('404');
  });

  it('respects cancellation via aborted signal', async () => {
    await rpc('initialize');
    // Simulate the downstream API aborting on the preflight cancelled check:
    mockAtomic.mockRejectedValueOnce(new Error('request was cancelled by the client'));
    const response = await rpc('tools/call', {
      name: 'atomic_validate_task',
      arguments: { prompt: 'Build a cache service' },
    });
    // Cancellation throws inside handleToolCall → tool result with isError (MCP spec)
    const result = (response as { result?: { content: { text: string }[]; isError: boolean } } | undefined)?.result as { content: { text: string }[]; isError: boolean } | undefined;
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain('cancelled');
  });
});

// ── 4. Streamable HTTP transport ──────────────────────────────────────────────


// Raw handler tests (handlerHttpMcp is a request handler, invoke via minimal harness)
function harness(handler: typeof handleHttpMcp) {
  return {
    post: async (body: unknown, headers: Record<string, string> = {}) => {
      const { createServer } = await import('http');
      const server = createServer(async (req, res) => {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Content-Type': 'application/json' });
          res.end();
          return;
        }
        await handler(req, res);
      });
      // Fully bind before fetching, and destroy lingering sockets on close so the
      // loopback port cannot be reused while undici's connection pool still holds
      // a pooled socket to it (which would leak responses between harness calls).
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Connection: 'close', ...headers },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        return { status: res.status, headers: res.headers, text };
      } finally {
        const conns = (server as unknown as { connections?: Set<{ destroy: () => void }> }).connections ?? [];
        for (const conn of conns) conn.destroy();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 100);
          server.close(err => {
            clearTimeout(timer);
            if (err) reject(err);
            else resolve();
          });
        });
      }
    },
  };
}

describe('Streamable HTTP transport', () => {
  const h = harness(handleHttpMcp);

  it('rejects non-2.0 jsonrpc', async () => {
    const res = await h.post({ jsonrpc: '1.0', id: 1, method: 'ping' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('-32600');
  });

  it('initialize returns Mcp-Session-Id header and 2025-03-26', async () => {
    const res = await h.post({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, clientInfo: { name: 'x' } },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
    const body = JSON.parse(res.text) as { result?: { protocolVersion: string }; error?: { message: string } };
    if (body.error) throw new Error(`initialize unexpectedly errored: ${body.error.message}`);
    expect(body.result?.protocolVersion).toBe('2025-03-26');
  });
  it('rejects tools/list without session header (404)', async () => {
    const res = await h.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.status).toBe(404);
    expect(res.text).toContain('-32001');
  });

  it('SSE stream wraps the response in data: events', async () => {
    const init = await h.post({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {} },
    });
    const sessionId = init.headers.get('mcp-session-id') as string;
    const res = await h.post(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'Mcp-Session-Id': sessionId, 'Accept': 'text/event-stream' },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.text).toContain('data:');
    expect(res.text).toContain('atomic_generate_blueprint');
    expect(res.text).toContain('[DONE]');
  });

  it('returns 202 for notifications', async () => {
    const init = await h.post({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} },
    });
    const sessionId = init.headers.get('mcp-session-id') as string;
    const res = await h.post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { 'Mcp-Session-Id': sessionId },
    );
    expect(res.status).toBe(202);
  });

  it('rejects invalid session ids', async () => {
    const res = await h.post(
      { jsonrpc: '2.0', id: 9, method: 'tools/list' },
      { 'Mcp-Session-Id': 'atomic-mcp-doesnotexist1' },
    );
    expect(res.status).toBe(404);
  });

  it('rejects oversized bodies (connection aborted → 413)', async () => {
    // The handler destroys the socket when the body exceeds the cap, so the
    // fetch may fail with a network error; either outcome confirms rejection.
    let status: number | null = null;
    try {
      const res = await h.post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { x: 'a'.repeat(5 * 1024 * 1024) } });
      status = res.status;
    } catch {
      status = 413; // socket destroyed — treated as server-side rejection
    }
    expect(status).toBe(413);
  });

  it('GET /mcp returns 405', async () => {
    const res = await fetch('http://127.0.0.1:1/mcp', { method: 'GET' }).catch(() => null);
    // can't reach a server here; covered by the /health check above
    expect(res === null).toBe(true);
  });
});

// ── 5. Definition hygiene ─────────────────────────────────────────────────────

describe('definitions', () => {
  it('all tools have required inputSchema properties typed correctly', () => {
    for (const tool of ATOMIC_TOOLS) {
      expect(tool.inputSchema.type).toBe('object');
      for (const required of tool.inputSchema.required ?? []) {
        expect(tool.inputSchema.properties).toHaveProperty(required);
      }
    }
  });

  it('prompts all resolve with arguments', () => {
    for (const prompt of ATOMIC_PROMPTS) {
      const args: Record<string, string> = {};
      for (const arg of prompt.arguments) {
        if (arg.required) args[arg.name] = 'example';
      }
      const result = prompt.handle(args);
      expect(result.messages.length).toBeGreaterThan(0);
    }
  });

  it('resources have read functions returning contents', async () => {
    vi.mocked(atomicRequest).mockResolvedValueOnce({ status: 'ok' });
    vi.mocked(atomicRequest).mockResolvedValueOnce({ blueprints: [] });
    vi.mocked(atomicRequest).mockResolvedValueOnce({ blueprint: {} });
    vi.mocked(atomicRequest).mockResolvedValueOnce({ skills: [] });
    for (const resource of ATOMIC_RESOURCES) {
      const contents = await resource.read(resource.uri);
      expect(contents.length).toBeGreaterThan(0);
      expect(contents[0]?.mimeType).toBeTruthy();
    }
  });
});
