/**
 * src/mcp/server.ts
 *
 * MCP (Model Context Protocol) server that exposes Atomic's pipeline as tools
 * for host coding agents (Claude Code, Cursor, Kilo Code, VS Code Copilot, etc.).
 *
 * Each tool has a precise natural-language description so the model knows exactly
 * when and how to call it, plus a full JSON Schema for parameters.
 *
 * Start this server with: npm run mcp
 * Or use via npx: npx atomic-mcp
 */

import { createServer } from 'http';
import { log } from '../engine/logger';

// ── MCP Protocol types ────────────────────────────────────────────────────────

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, McpProperty>;
    required?: string[];
  };
}

interface McpProperty {
  type: string | string[];
  description: string;
  enum?: string[];
  default?: unknown;
  items?: { type: string };
  minimum?: number;
  maximum?: number;
}

interface McpRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const ATOMIC_TOOLS: McpTool[] = [
  {
    name: 'atomic_generate_blueprint',
    description:
      'Run the full Atomic multi-agent pipeline on a task description to generate a ' +
      'production-ready software architecture blueprint. Use this when you need a ' +
      'comprehensive, multi-pillar architectural analysis covering planning, production, ' +
      'edge cases, integration, security, quality, and completeness. Returns a streaming ' +
      'SSE URL and a job ID you can poll with atomic_get_status.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'The task or product description to generate a blueprint for. ' +
            'Be specific about what you are building, the target users, and any ' +
            'technical constraints. Example: "Build a real-time collaborative ' +
            'document editor with offline support, targeting 10K concurrent users."',
        },
        mode: {
          type: 'string',
          enum: ['fast', 'safe'],
          description:
            '"fast" (default) runs all pillars in parallel for speed. ' +
            '"safe" runs a staged pipeline with more checkpointing — use for ' +
            'long or complex tasks where partial results are valuable.',
          default: 'fast',
        },
        apiKey: {
          type: 'string',
          description:
            'OpenRouter API key to use for this generation. If not provided, ' +
            'the server uses the OPENROUTER_API_KEY environment variable.',
        },
        provider: {
          type: 'string',
          enum: ['openrouter', 'openai', 'anthropic', 'google', 'deepseek', 'xai', 'mistral', 'zai', 'minimax'],
          description:
            'AI provider to use. Defaults to "openrouter" (recommended — all providers, one key).',
          default: 'openrouter',
        },
        fastModel: {
          type: 'string',
          description:
            'Model ID for fast, cheap operations (governor, reviewer). ' +
            'Must be a valid model slug for the selected provider. ' +
            'Example: "openai/gpt-5.3-chat" for OpenRouter.',
        },
        proModel: {
          type: 'string',
          description:
            'Model ID for deep reasoning operations (pillar agents, prosecutor, synthesizer). ' +
            'Must be a valid model slug for the selected provider. ' +
            'Example: "openai/gpt-5.4" for OpenRouter.',
        },
      },
      required: ['prompt'],
    },
  },

  {
    name: 'atomic_get_status',
    description:
      'Poll the status of a blueprint generation job by its session ID. ' +
      'Use this after calling atomic_generate_blueprint to track progress. ' +
      'Returns the current phase, per-pillar progress, token counts, and ' +
      'whether the job is complete, running, or failed.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description:
            'The session ID returned by atomic_generate_blueprint. ' +
            'Example: "sess_a1b2c3d4e5f6".',
        },
      },
      required: ['sessionId'],
    },
  },

  {
    name: 'atomic_get_result',
    description:
      'Retrieve the complete blueprint for a finished generation job. ' +
      'Use this after atomic_get_status reports the job is complete. ' +
      'Returns the full Blueprint object including all pillar outputs, ' +
      'the prosecutor report, quality score, and the Claude Code bundle.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'The session ID of the completed blueprint generation job.',
        },
        format: {
          type: 'string',
          enum: ['json', 'markdown', 'summary'],
          description:
            '"json" (default) returns the full Blueprint object. ' +
            '"markdown" returns a formatted Markdown document. ' +
            '"summary" returns a concise executive summary.',
          default: 'json',
        },
      },
      required: ['sessionId'],
    },
  },

  {
    name: 'atomic_list_blueprints',
    description:
      'List all previously generated blueprints stored on this Atomic server. ' +
      'Use this to find an existing blueprint before generating a new one, ' +
      'or to browse past architectural decisions for reference.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of blueprints to return. Defaults to 20.',
          default: 20,
          minimum: 1,
          maximum: 100,
        },
        offset: {
          type: 'number',
          description: 'Pagination offset. Defaults to 0.',
          default: 0,
          minimum: 0,
        },
        search: {
          type: 'string',
          description:
            'Optional full-text search query to filter blueprints by prompt content.',
        },
        minQualityScore: {
          type: 'number',
          description: 'Filter to blueprints with quality score >= this value (0-100).',
          minimum: 0,
          maximum: 100,
        },
      },
      required: [],
    },
  },

  {
    name: 'atomic_rerun_pillar',
    description:
      'Trigger a targeted rerun of a specific pillar in an existing blueprint. ' +
      'Use this when a pillar produced low-quality output or when you have ' +
      'additional context that should inform a specific domain. ' +
      'Only reruns the requested pillar and updates the blueprint; does not ' +
      're-run the full pipeline.',
    inputSchema: {
      type: 'object',
      properties: {
        blueprintId: {
          type: 'string',
          description: 'The ID of the blueprint to update.',
        },
        pillar: {
          type: 'string',
          enum: ['planning', 'production', 'edge_cases', 'integration', 'security', 'quality', 'completeness'],
          description:
            'Which pillar to rerun. ' +
            '"planning" = architecture and system design decisions. ' +
            '"production" = deployment, scaling, and operational concerns. ' +
            '"edge_cases" = failure modes, boundary conditions, and resilience. ' +
            '"integration" = third-party services and API contracts. ' +
            '"security" = authentication, authorization, and threat modeling. ' +
            '"quality" = testing strategy and observability. ' +
            '"completeness" = gaps and missing requirements.',
        },
        additionalContext: {
          type: 'string',
          description:
            'Optional additional context to provide to the pillar agents for this rerun. ' +
            'Example: "Focus on GDPR compliance requirements for EU users."',
        },
      },
      required: ['blueprintId', 'pillar'],
    },
  },

  {
    name: 'atomic_export_bundle',
    description:
      'Export a completed blueprint in a specified format for use with coding agents ' +
      'or project management tools. Use this to get a Claude Code–ready CLAUDE.md, ' +
      'a structured JSON bundle, or a human-readable Markdown document.',
    inputSchema: {
      type: 'object',
      properties: {
        blueprintId: {
          type: 'string',
          description: 'The ID of the blueprint to export.',
        },
        format: {
          type: 'string',
          enum: ['json', 'markdown', 'yaml', 'claude_md', 'agents_md'],
          description:
            '"json" = full Blueprint JSON with all metadata. ' +
            '"markdown" = human-readable Markdown document. ' +
            '"yaml" = YAML format for config-as-code workflows. ' +
            '"claude_md" = Claude Code CLAUDE.md file content. ' +
            '"agents_md" = AGENTS.md file for Codex CLI / OpenAI agents.',
        },
        includeBundle: {
          type: 'boolean' as const,
          description:
            'Whether to include the full Claude Code output bundle (hookify rules, ' +
            'agent definitions). Only applies to "json" format. Defaults to true.',
          default: true,
        },
      },
      required: ['blueprintId', 'format'],
    },
  },

  {
    name: 'atomic_validate_task',
    description:
      'Pre-validate a task description before running the full pipeline. ' +
      'Use this to check if the task is well-formed, estimate the token cost, ' +
      'and get a preview of how the Governor will decompose the task. ' +
      'Faster and cheaper than running the full pipeline — use it when uncertain ' +
      'whether the task description will produce good results.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'The task description to validate. Same format as atomic_generate_blueprint.',
        },
        provider: {
          type: 'string',
          enum: ['openrouter', 'openai', 'anthropic', 'google', 'deepseek', 'xai', 'mistral', 'zai', 'minimax'],
          description: 'Provider to use for validation. Defaults to "openrouter".',
          default: 'openrouter',
        },
      },
      required: ['prompt'],
    },
  },
];

// ── HTTP client for Atomic API ────────────────────────────────────────────────

const ATOMIC_API_URL = process.env['ATOMIC_API_URL'] ?? 'http://localhost:5000';

async function callAtomicApi(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  body?: unknown
): Promise<unknown> {
  const url = `${ATOMIC_API_URL}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Atomic API error ${response.status}: ${text}`);
  }

  return response.json();
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (toolName) {
    case 'atomic_generate_blueprint': {
      const { prompt, mode = 'fast', apiKey, provider, fastModel, proModel } = args as {
        prompt: string;
        mode?: string;
        apiKey?: string;
        provider?: string;
        fastModel?: string;
        proModel?: string;
      };

      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        throw new Error('prompt is required and must be a non-empty string');
      }

      // Use /api/v1/generate-start — a REST endpoint that starts generation in the background
      // and immediately returns { sessionId }. The SSE endpoint (/api/v1/generate) requires
      // a persistent streaming connection that MCP tools cannot maintain.
      const body: Record<string, unknown> = { prompt: prompt.trim(), mode };
      if (apiKey) body['apiKey'] = apiKey;
      if (provider) body['provider'] = provider;
      if (fastModel) body['fastModel'] = fastModel;
      if (proModel) body['proModel'] = proModel;

      const result = await callAtomicApi('/api/v1/generate-start', 'POST', body) as {
        sessionId: string;
        statusUrl: string;
        sseUrl: string;
        message: string;
      };
      return {
        sessionId:  result.sessionId,
        statusUrl:  result.statusUrl,
        sseUrl:     result.sseUrl,
        message:    `Blueprint generation started. Use atomic_get_status with sessionId="${result.sessionId}" to track progress, then atomic_get_result when complete.`,
      };
    }

    case 'atomic_get_status': {
      const { sessionId } = args as { sessionId: string };
      const result = await callAtomicApi(`/api/v1/sessions/${sessionId}`);
      return result;
    }

    case 'atomic_get_result': {
      const { sessionId, format = 'json' } = args as { sessionId: string; format?: string };
      const blueprint = await callAtomicApi(`/api/v1/sessions/${sessionId}/blueprint`);
      if (format === 'summary') {
        const bp = blueprint as { sections?: { executive_summary?: string }; quality_score?: number; prompt?: string };
        return {
          prompt: bp.prompt,
          qualityScore: bp.quality_score,
          executiveSummary: bp.sections?.executive_summary ?? '',
          message: 'Use atomic_export_bundle for other formats.',
        };
      }
      return blueprint;
    }

    case 'atomic_list_blueprints': {
      const { limit = 20, offset = 0, search, minQualityScore } = args as {
        limit?: number;
        offset?: number;
        search?: string;
        minQualityScore?: number;
      };
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        ...(search ? { q: search } : {}),
        ...(minQualityScore !== undefined ? { minScore: String(minQualityScore) } : {}),
      });
      return callAtomicApi(`/api/v1/blueprints?${params}`);
    }

    case 'atomic_rerun_pillar': {
      const { blueprintId, pillar, additionalContext } = args as {
        blueprintId: string;
        pillar: string;
        additionalContext?: string;
      };
      return callAtomicApi(`/api/v1/blueprints/${blueprintId}/rerun`, 'POST', {
        pillar,
        additionalContext,
      });
    }

    case 'atomic_export_bundle': {
      const { blueprintId, format, includeBundle = true } = args as {
        blueprintId: string;
        format: string;
        includeBundle?: boolean;
      };
      const params = new URLSearchParams({ format, includeBundle: String(includeBundle) });
      return callAtomicApi(`/api/v1/blueprints/${blueprintId}/export?${params}`);
    }

    case 'atomic_validate_task': {
      const { prompt, provider = 'openrouter' } = args as { prompt: string; provider?: string };
      return callAtomicApi('/api/v1/validate', 'POST', { prompt, provider });
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ── MCP JSON-RPC handler ──────────────────────────────────────────────────────

async function handleMcpRequest(request: McpRequest): Promise<McpResponse> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'atomic-mcp', version: '1.0.0' },
          },
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: ATOMIC_TOOLS },
        };

      case 'tools/call': {
        const { name, arguments: toolArgs } = params as { name: string; arguments: Record<string, unknown> };
        const result = await handleToolCall(name, toolArgs ?? {});
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          },
        };
      }

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message },
    };
  }
}

// ── HTTP MCP transport ────────────────────────────────────────────────────────

export function createMcpServer(_port = 3100) {
  // Transport connects to the configured Atomic API endpoint (ATOMIC_API_URL); the port parameter is reserved for future embedded mode.
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', server: 'atomic-mcp', atomicApiUrl: ATOMIC_API_URL }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const request = JSON.parse(body) as McpRequest;
        const response = await handleMcpRequest(request);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: `Parse error: ${message}` },
        }));
      }
    });
  });

  return server;
}

// ── stdio transport (for npx / CLI usage) ────────────────────────────────────

export function startStdioTransport() {
  process.stdin.setEncoding('utf8');
  let buffer = '';

  process.stdin.on('data', async (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const request = JSON.parse(trimmed) as McpRequest;
        const response = await handleMcpRequest(request);
        process.stdout.write(JSON.stringify(response) + '\n');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: `Parse error: ${message}` },
        }) + '\n');
      }
    }
  });

  process.stdin.on('end', () => process.exit(0));
  log.info({ transport: 'stdio', atomicApiUrl: ATOMIC_API_URL }, '[atomic-mcp] stdio transport started');
}
