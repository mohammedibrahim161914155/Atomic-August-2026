/**
 * src/mcp/dispatch.ts
 *
 * Core MCP JSON-RPC dispatch — transport-agnostic.
 *
 * Protocol: 2025-03-26 capabilities negotiation with initialize handshake.
 * Supports: tools (validate input schema → -32602), prompts, resources,
 * ping, initialize, notifications/cancelled, notifications/progress.
 *
 * Session lifecycle: initialize must complete before tools/prompts/resources
 * requests are honored; pre-init requests return -32002 "Not initialized".
 */

import { ATOMIC_TOOLS, ATOMIC_PROMPTS, ATOMIC_RESOURCES } from './tools';
import { handleToolCall } from './tool-handlers';
import { validateToolInput, invalidParamsError } from './validation';
import { generateId } from './id';

export const PROTOCOL_VERSION = '2025-03-26';

/** Internal error used to short-circuit dispatch with JSON-RPC -32002 Not initialized. */
class McpNotInitializedError extends Error {
  constructor() { super('Not initialized'); this.name = 'McpNotInitializedError'; }
}

/** Internal error used to short-circuit dispatch with JSON-RPC -32601 Method not found. */
class McpMethodNotFoundError extends Error {
  constructor(public readonly method: string) { super(`Method not found: ${method}`); this.name = 'McpMethodNotFoundError'; }
}
export const SERVER_INFO = { name: 'atomic-mcp', version: '2.5.0' };

// ── JSON-RPC types ────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface McpSession {
  id:                string;
  initialized:       boolean;
  clientInfo?:       { name?: string; version?: string };
  clientCapabilities?: Record<string, unknown>;
  lastSeenAt:        number;
}

// ── Session state ─────────────────────────────────────────────────────────────

const sessions = new Map<string, McpSession>();
// Cap how many sessions we keep (evict least-recently-seen)
const MAX_SESSIONS = 1_024;

function evictOldestSessions() {
  if (sessions.size <= MAX_SESSIONS) return;
  let oldestId = '';
  let oldestTime = Infinity;
  for (const [id, s] of sessions) {
    if (s.lastSeenAt < oldestTime) { oldestTime = s.lastSeenAt; oldestId = id; }
  }
  if (oldestId) sessions.delete(oldestId);
}

export function getSession(sessionId: string): McpSession | undefined {
  return sessions.get(sessionId);
}

export function createSession(): McpSession {
  const session: McpSession = {
    id: `atomic-mcp-${generateId()}`,
    initialized: false,
    lastSeenAt: Date.now(),
  };
  sessions.set(session.id, session);
  evictOldestSessions();
  return session;
}

export function sessionCount(): number {
  return sessions.size;
}

// ── Cancellation tracking ─────────────────────────────────────────────────────

const cancelledRequests = new Set<string | number>();
const pendingRequests = new Map<string | number, AbortController>();

export function trackRequest(id: string | number): AbortController {
  const controller = new AbortController();
  pendingRequests.set(id, controller);
  controller.signal.addEventListener('abort', () => pendingRequests.delete(id));
  return controller;
}

export function abortRequest(id: string | number): boolean {
  if (cancelledRequests.has(id)) return false;
  cancelledRequests.add(id);
  const controller = pendingRequests.get(id);
  controller?.abort();
  return !!controller;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export interface DispatchContext {
  /** MCP session id extracted from headers (Streamable HTTP) or null for stdio. */
  sessionId?: string | null;
  /** Optional progress publisher for request-scoped notifications. */
  onProgress?: (message: string, progress?: number) => void;
}

export async function dispatch(request: JsonRpcRequest, ctx: DispatchContext = {}): Promise<JsonRpcResponse | JsonRpcNotification | null> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case 'initialize': {
        const clientInfo = params?.clientInfo as { name?: string; version?: string } | undefined;
        const session = getSessionOrCreate(ctx.sessionId);
        // Publish the resolved session id back to the transport so it can set
        // the Mcp-Session-Id header on the initialize response (stdio keeps its
        // deterministic 'stdio' id; Streamable HTTP gets the one we minted).
        ctx.sessionId = session.id;
        session.initialized = true;
        session.clientInfo = clientInfo;
        session.clientCapabilities = params?.capabilities as Record<string, unknown> | undefined;
        session.lastSeenAt = Date.now();
        return {
          jsonrpc: '2.0', id: id ?? null,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              tools:        { listChanged: true },
              prompts:      { listChanged: true },
              resources:    { subscribe: false, listChanged: true },
              logging:      {},
            },
            serverInfo: SERVER_INFO,
          },
        };
      }

      case 'notifications/initialized':
        // Lifecycle completion notification — no response (spec: MUST NOT respond)
        touchSession(ctx.sessionId);
        return null;

      case 'notifications/cancelled': {
        const cancelledIds = (params?.['requestId'] !== undefined)
          ? [String(params['requestId'])]
          : (params?.requestIds as (string | number)[] | undefined)?.map(String) ?? [];
        for (const cid of cancelledIds) abortRequest(cid);
        return null;
      }

      case 'ping':
        touchSession(ctx.sessionId);
        return { jsonrpc: '2.0', id: id ?? null, result: {} };

      case 'tools/list':
        requireInitialized(ctx.sessionId);
        touchSession(ctx.sessionId);
        return { jsonrpc: '2.0', id: id ?? null, result: { tools: ATOMIC_TOOLS } };

      case 'prompts/list':
        requireInitialized(ctx.sessionId);
        touchSession(ctx.sessionId);
        return { jsonrpc: '2.0', id: id ?? null, result: { prompts: ATOMIC_PROMPTS } };

      case 'prompts/get': {
        requireInitialized(ctx.sessionId);
        touchSession(ctx.sessionId);
        const { name, arguments: promptArgs } = params as { name: string; arguments?: Record<string, string> };
        const prompt = ATOMIC_PROMPTS.find(p => p.name === name);
        if (!prompt) {
          return { jsonrpc: '2.0', id: id ?? null, error: { code: -32602, message: `Unknown prompt: ${name}` } };
        }
        const promptResult = prompt.handle(promptArgs ?? {});
        return { jsonrpc: '2.0', id: id ?? null, result: promptResult };
      }

      case 'resources/list':
        requireInitialized(ctx.sessionId);
        touchSession(ctx.sessionId);
        return { jsonrpc: '2.0', id: id ?? null, result: { resources: ATOMIC_RESOURCES } };

      case 'resources/read': {
        requireInitialized(ctx.sessionId);
        touchSession(ctx.sessionId);
        const { uri } = params as { uri: string };
        const resource = ATOMIC_RESOURCES.find(r => r.uriTemplate ? uriMatch(r.uriTemplate, uri) : r.uri === uri);
        if (!resource) {
          return { jsonrpc: '2.0', id: id ?? null, error: { code: -32602, message: `Unknown resource: ${uri}` } };
        }
        const contents = await resource.read(uri);
        return { jsonrpc: '2.0', id: id ?? null, result: { contents } };
      }

      case 'tools/call': {
        requireInitialized(ctx.sessionId);
        touchSession(ctx.sessionId);
        const { name, arguments: toolArgs } = params as { name: string; arguments: Record<string, unknown> };

        const tool = ATOMIC_TOOLS.find(t => t.name === name);
        if (!tool) {
          return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Unknown tool: ${name}` } };
        }

        const validation = validateToolInput(toolArgs ?? undefined, tool.inputSchema as unknown as { type: 'object'; properties: Record<string, Record<string, unknown>>; required?: string[] });
        if (!validation.valid) {
          return { jsonrpc: '2.0', id: id ?? null, error: invalidParamsError(validation.errors, name) };
        }

        const controller = trackRequest(id ?? -1);
        const requestCtx = { abortSignal: controller.signal, apiKey: toolArgs?.apiKey as string | undefined };
        try {
          const result = await handleToolCall(name, validation.data, requestCtx);
          return {
            jsonrpc: '2.0', id: id ?? null,
            result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
          };
        } catch (handlerErr) {
          // MCP spec: tool failures are surfaced as content with isError, not
          // as JSON-RPC errors, so hosts can render the error in the tool UI.
          const message = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
          return {
            jsonrpc: '2.0', id: id ?? null,
            result: { content: [{ type: 'text', text: `Tool execution failed: ${message}` }], isError: true },
          };
        } finally {
          pendingRequests.delete(id ?? -1);
        }
      }

      default:
        throw new McpMethodNotFoundError(method);
    }
  } catch (err) {
    if (err instanceof McpNotInitializedError) {
      return { jsonrpc: '2.0', id: id ?? null, error: { code: -32002, message: 'Not initialized — send an "initialize" request first' } };
    }
    if (err instanceof McpMethodNotFoundError) {
      return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Method not found: ${err.method}` } };
    }
    if (err && typeof err === 'object' && 'jsonrpc' in (err as Record<string, unknown>)) {
      return err as JsonRpcResponse;
    }
    const message = err instanceof Error ? err.message : String(err);
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message: `Internal error: ${message}` } };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────


let defaultSession: McpSession | undefined;

/** Test-only: clear all sessions (including the default stdio session). */
export function resetSessions(): void {
  sessions.clear();
  defaultSession = undefined;
}

/** Whether a session id is currently tracked (used by the HTTP transport to reject unknown ids). */
export function isKnownSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

function getSessionOrCreate(sessionId?: string | null): McpSession {
  if (sessionId) {
    let session = sessions.get(sessionId);
    if (!session) {
      session = { id: sessionId, initialized: false, lastSeenAt: Date.now() };
      sessions.set(sessionId, session);
      evictOldestSessions();
    }
    return session;
  }
  if (sessionId === undefined) {
    // Streamable HTTP initialize without a header: mint a fresh session so
    // every HTTP client gets its own id (never share the stdio default).
    const session: McpSession = { id: generateId(), initialized: false, lastSeenAt: Date.now() };
    sessions.set(session.id, session);
    evictOldestSessions();
    return session;
  }
  // stdio transport: single shared session
  if (!defaultSession) {
    defaultSession = { id: 'stdio', initialized: false, lastSeenAt: Date.now() };
    sessions.set('stdio', defaultSession);
  }
  defaultSession.lastSeenAt = Date.now();
  return defaultSession;
}

function touchSession(sessionId?: string | null): void {
  const session = sessions.get(sessionId ?? 'stdio');
  if (session) session.lastSeenAt = Date.now();
}

function requireInitialized(sessionId?: string | null): void {
  // HTTP sessions resolve to their header id; stdio falls back to the shared
  // default session (or 'stdio' key) so pre-init requests return -32002.
  const session = sessionId ? sessions.get(sessionId) : (sessions.get('stdio') ?? defaultSession);
  if (!session?.initialized) {
    throw new McpNotInitializedError();
  }
}

function uriMatch(template: string, uri: string): boolean {
  const regex = template.replace(/\{[^}]+\}/g, '[^/]+');
  return new RegExp(`^${regex}$`).test(uri);
}
