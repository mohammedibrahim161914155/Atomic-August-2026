/**
 * src/mcp/server.ts
 *
 * MCP (Model Context Protocol) 2025-03-26 server exposing Atomic's pipeline as
 * tools for host coding agents (Claude Code, Cursor, Kilo Code, VS Code Copilot,
 * Codex, Replit Agent, and any Streamable-HTTP-capable client).
 *
 * Transports:
 *   - stdio:    newline-delimited JSON-RPC over stdin/stdout (MCP CLI default)
 *   - http:     MCP Streamable HTTP on POST /mcp (SSE streaming responses when
 *               the client sends Accept: text/event-stream), GET /mcp
 *               compatibility, and /health
 *
 * Protocol behavior:
 *   - initialize handshake REQUIRED before tools/prompts/resources requests
 *     (pre-init requests → -32002 Not initialized; spec §Lifecycle)
 *   - strict tool input validation → -32602 Invalid params with per-path errors
 *   - request cancellation via notifications/cancelled (requestIds)
 *   - logging/progress notifications
 *   - session tracking (Mcp-Session-Id header) with LRU eviction cap
 *
 * Start: npm run mcp  |  npx atomic-mcp  |  MCP_TRANSPORT=http npx atomic-mcp
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { dispatch, JsonRpcRequest, JsonRpcResponse, DispatchContext, isKnownSession } from './dispatch';
import { PROTOCOL_VERSION, SERVER_INFO } from './dispatch';
import { log } from '../engine/logger';

const MCP_HEADER = 'Mcp-Session-Id';
const ACCEPT_HEADER = 'Accept';
const HTTP_MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB request cap
const SSE_HEARTBEAT_MS = 15_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage, limitBytes = HTTP_MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Request body exceeds size limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function isAllowedOrigin(req: IncomingMessage): boolean {
  const origin = String(req.headers.origin ?? '');
  const allowed = process.env['MCP_ALLOWED_ORIGIN'] ?? process.env['ALLOWED_ORIGIN'] ?? '*';
  if (allowed === '*') return true;
  return origin === allowed || origin === '';
}

// ── Streamable HTTP transport ─────────────────────────────────────────────────

/**
 * POST /mcp — MCP Streamable HTTP.
 *
 * If the client sends `Accept: text/event-stream`, the response is an SSE
 * stream carrying the JSON-RPC response(s) as `data:` events. Otherwise the
 * response is plain JSON.
 *
 * Session lifecycle:
 *   - initialize → server returns Mcp-Session-Id header; client echoes it on
 *     subsequent POST /mcp requests and GET /mcp?session_id=
 *   - invalid/unknown session → 404 Not Found (spec §4.5)
 */
export async function handleHttpMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET') {
    // GET /mcp — used by clients for subscription-listen or compatibility.
    // Spec: respond 405 Method Not Allowed unless streaming is supported.
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method Not Allowed — use POST /mcp' }, id: null }));
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  if (!isAllowedOrigin(req)) {
    sendJson(res, 403, { error: 'Origin not allowed' });
    return;
  }

  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch (err) {
    sendJson(res, 413, { error: (err as Error).message });
    return;
  }

  let request: JsonRpcRequest;
  try {
    request = JSON.parse(raw.toString('utf8')) as JsonRpcRequest;
  } catch (err) {
    sendJson(res, 400, {
      jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${(err as Error).message}` },
    });
    return;
  }

  if (request.jsonrpc !== '2.0') {
    sendJson(res, 400, {
      jsonrpc: '2.0', id: request.id ?? null, error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
    });
    return;
  }

  const headerSessionId = req.headers[String(MCP_HEADER).toLowerCase()] as string | undefined;
  const wantsStream = String(req.headers[ACCEPT_HEADER.toLowerCase()] ?? '').includes('text/event-stream');

  // initialize may omit the session header (spec: "initialize" MAY omit);
  // notifications/initialized also carry no session header (spec §Lifecycle);
  // every other method MUST include a valid Mcp-Session-Id (404 otherwise).
  const sessionlessAllowed = request.method === 'initialize' || request.method === 'notifications/initialized';
  if (!sessionlessAllowed && !headerSessionId) {
    sendJson(res, 404, {
      jsonrpc: '2.0', id: request.id ?? null,
      error: { code: -32001, message: `Invalid or missing session ID — send "${MCP_HEADER}" header from an initialize response` },
    });
    return;
  }

  // Reject unknown session IDs at the HTTP layer — never silently create new
  // sessions from untrusted headers (prevents session fixation and unbounded
  // session maps from malformed clients).
  if (headerSessionId && request.method !== 'initialize' && !isKnownSession(headerSessionId)) {
    sendJson(res, 404, {
      jsonrpc: '2.0', id: request.id ?? null,
      error: { code: -32001, message: `Unknown session ID: ${headerSessionId}` },
    });
    return;
  }

  // HTTP transport: mint a fresh session for headerless initialize requests
  // (never share the stdio default session across HTTP clients).
  const ctx: DispatchContext = { sessionId: headerSessionId ?? (request.method === 'initialize' ? undefined : null) };

  if (wantsStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': keepalive\n\n'); }, SSE_HEARTBEAT_MS);
    req.on('close', () => clearInterval(heartbeat));
    const response = await dispatch(request, ctx);
    clearInterval(heartbeat);
    if (response && 'id' in response) {
      const initResponse = request.method === 'initialize' && (response as JsonRpcResponse).result;
      if (initResponse) res.setHeader(MCP_HEADER, ctx.sessionId ?? '');
      res.write(`data: ${JSON.stringify(response)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      // notification (no response expected) — end stream
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return;
  }

  const response = await dispatch(request, ctx);
  if (!response) {
    // Notification — spec: respond 202 Accepted with empty body
    res.writeHead(202);
    res.end();
    return;
  }
  const initResponse = request.method === 'initialize' && (response as JsonRpcResponse).result;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (initResponse) headers[MCP_HEADER] = ctx.sessionId ?? '';
  sendJson(res, 200, response, headers);
}

// ── stdio transport ───────────────────────────────────────────────────────────

export function startStdioTransport(): void {
  process.stdin.setEncoding('utf8');
  let buffer = '';

  process.stdin.on('data', async (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch (err) {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${(err as Error).message}` },
        }) + '\n');
        continue;
      }

      if (request.jsonrpc !== '2.0') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: request.id ?? null, error: { code: -32600, message: 'Invalid Request' },
        }) + '\n');
        continue;
      }

      try {
        const response = await dispatch(request, { sessionId: null });
        if (response) {
          process.stdout.write(JSON.stringify(response) + '\n');
        }
        // notifications → no stdout response (spec-compliant)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: `Internal error: ${message}` },
        }) + '\n');
      }
    }
  });

  process.stdin.on('end', () => process.exit(0));
  log.info({ transport: 'stdio', protocolVersion: PROTOCOL_VERSION, ...SERVER_INFO }, '[atomic-mcp] stdio transport started');
}

// ── HTTP server factory ───────────────────────────────────────────────────────

export function createMcpServer(_port = 3100) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/health' || req.url === '/mcp/health')) {
        sendJson(res, 200, {
          status: 'ok',
          server: 'atomic-mcp',
          version: SERVER_INFO.version,
          protocolVersion: PROTOCOL_VERSION,
          atomicApiUrl: process.env['ATOMIC_API_URL'] ?? 'http://localhost:3000',
        });
        return;
      }
      if (req.url === '/mcp' || req.url === '/mcp/') {
        await handleHttpMcp(req, res);
        return;
      }
      if (req.method === 'OPTIONS') {
        sendJson(res, 204, null, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': `Content-Type, ${ACCEPT_HEADER}, ${MCP_HEADER}`,
          'Access-Control-Max-Age': '3600',
        });
        return;
      }
      sendJson(res, 404, { error: 'Not Found — use POST /mcp' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, '[atomic-mcp] transport error');
      if (!res.headersSent) sendJson(res, 500, { error: `Internal error: ${message}` });
      else res.end();
    }
  });

  return server;
}
