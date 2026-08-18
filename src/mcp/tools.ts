/**
 * src/mcp/tools.ts
 *
 * MCP tool/prompt/resource definitions for the Atomic MCP server.
 *
 * Tools map 1:1 onto the real Atomic server REST contract
 * (POST /generate-start, GET /sessions/:id, GET /blueprints?search=&quality_min=,
 *  POST /rerun-pillar, GET /blueprints/:id/export?format=, POST /validate).
 *
 * Prompts follow the MCP prompt spec: templates with named arguments that
 * resolve to messages. Resources expose server health and blueprint data
 * as MCP resources with URIs.
 */

import { atomicRequest } from './atomic-client';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface McpTool {
  name:        string;
  description: string;
  inputSchema: {
    type:       'object';
    properties: Record<string, McpProperty>;
    required?:  string[];
  };
}

export interface McpProperty {
  type:        string | string[];
  description: string;
  enum?:       string[];
  default?:    unknown;
  items?:      { type: string };
  minimum?:    number;
  maximum?:    number;
  minLength?:  number;
  maxLength?:  number;
}

export interface McpPromptArgument {
  name:        string;
  description: string;
  required?:   boolean;
}

export interface McpPrompt {
  name:        string;
  description: string;
  arguments:   McpPromptArgument[];
  /** Resolve prompt arguments into a prompt template result. */
  handle: (args: Record<string, string>) => McpPromptResult;
}

export interface McpPromptResult {
  description: string;
  messages:    { role: 'user' | 'assistant'; content: { type: 'text'; text: string } }[];
}

export interface McpResource {
  uri:         string;
  uriTemplate?: string;
  name:        string;
  description: string;
  mimeType:    string;
  read:        (uri: string) => Promise<McpResourceContent[]>;
}

export interface McpResourceContent {
  uri:      string;
  mimeType: string;
  text?:    string;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const ATOMIC_TOOLS: McpTool[] = [
  {
    name: 'atomic_generate_blueprint',
    description:
      'Start a full Atomic multi-agent pipeline run to generate a production-ready ' +
      'software architecture blueprint for a task description. Covers planning, ' +
      'production, edge cases, integration, security, quality, and completeness pillars. ' +
      'Returns immediately with a session ID; poll the session status with ' +
      'atomic_get_status, then fetch the result with atomic_get_result when complete. ' +
      'Runs in the background — no persistent connection needed.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type:        'string',
          description:
            'The task or product description to generate a blueprint for. Be specific ' +
            'about what you are building, the target users, and technical constraints. ' +
            'Example: "Build a real-time collaborative document editor with offline ' +
            'support, targeting 10K concurrent users."',
          minLength:   10,
          maxLength:   8000,
        },
        mode: {
          type:        'string',
          enum:        ['fast', 'safe'],
          description:
            '"fast" (default) runs all pillars in parallel. "safe" runs a staged ' +
            'pipeline with more checkpointing — use for long or complex tasks.',
          default:     'fast',
        },
        apiKey: {
          type:        'string',
          description:
            'AI provider API key to use for this run. If omitted, the MCP server uses ' +
            'its configured ATOMIC_API_KEY / OPENROUTER_API_KEY env var.',
        },
        provider: {
          type:        'string',
          enum:        ['openrouter', 'openai', 'anthropic', 'google', 'deepseek', 'xai', 'mistral', 'zai', 'minimax'],
          description: 'AI provider to use. Defaults to the server-configured provider.',
        },
        fastModel: {
          type:        'string',
          description: 'Model ID for fast operations (governor, reviewer).',
        },
        proModel: {
          type:        'string',
          description: 'Model ID for deep reasoning operations (pillar agents, prosecutor, synthesizer).',
        },
      },
      required: ['prompt'],
    },
  },

  {
    name: 'atomic_get_status',
    description:
      'Poll the status of a blueprint generation session. Returns the current phase, ' +
      'per-pillar progress, token counts, and whether the session is complete, ' +
      'running, or failed. Call repeatedly after atomic_generate_blueprint until ' +
      'status is "complete" or "failed".',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type:        'string',
          description: 'The session ID returned by atomic_generate_blueprint. ' +
            'Example: "sess_a1b2c3d4e5f6".',
          minLength:   8,
        },
      },
      required: ['sessionId'],
    },
  },

  {
    name: 'atomic_get_result',
    description:
      'Fetch the completed blueprint for a finished session. Returns the full ' +
      'Blueprint JSON (all pillars, sections, scores). Use "summary" format for a ' +
      'compact executive view, or atomic_export_bundle for serialized exports.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type:        'string',
          description: 'The session ID whose blueprint to fetch.',
          minLength:   8,
        },
        format: {
          type:        'string',
          enum:        ['json', 'summary'],
          description: '"json" returns the full blueprint. "summary" returns only the ' +
            'prompt, quality score, and executive summary. Defaults to "json".',
          default:     'json',
        },
      },
      required: ['sessionId'],
    },
  },

  {
    name: 'atomic_list_blueprints',
    description:
      'List previously generated (persisted) blueprints with filtering, sorting, ' +
      'and pagination. Use the returned IDs with atomic_get_result, ' +
      'atomic_rerun_pillar, and atomic_export_bundle.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type:        'integer',
          description: 'Maximum number of blueprints to return. Defaults to 20.',
          default:     20,
          minimum:     1,
          maximum:     100,
        },
        offset: {
          type:        'integer',
          description: 'Pagination offset. Defaults to 0.',
          default:     0,
          minimum:     0,
        },
        search: {
          type:        'string',
          description: 'Full-text search over prompts and blueprint content.',
        },
        tag: {
          type:        'string',
          description: 'Filter blueprints by a tag value.',
        },
        sort: {
          type:        'string',
          enum:        ['newest', 'oldest', 'quality'],
          description: 'Sort order. Defaults to "newest".',
          default:     'newest',
        },
        dateAfter: {
          type:        'string',
          description: 'ISO-8601 date — only return blueprints created after this.',
        },
        qualityMin: {
          type:        'integer',
          description: 'Minimum quality score (0-100).',
          minimum:     0,
          maximum:     100,
        },
      },
      required: [],
    },
  },

  {
    name: 'atomic_rerun_pillar',
    description:
      'Rerun a single pillar of an existing blueprint (e.g. just the security ' +
      'pillar) without regenerating everything. Requires either a sessionId with ' +
      'the session token cookie, or the full inline blueprint JSON to spawn a new ' +
      'rerun session. Streams progress via SSE on the Atomic server side.',
    inputSchema: {
      type: 'object',
      properties: {
        pillarName: {
          type:        'string',
          description:
            'The pillar to rerun. Valid values: "planning", "production", ' +
            '"edge_cases", "integration", "security", "quality", "completeness".',
          minLength:   1,
        },
        sessionId: {
          type:        'string',
          description: 'Existing session ID to rerun the pillar within.',
          minLength:   8,
        },
        blueprint: {
          type:        'object',
          description:
            'Full inline Blueprint JSON to rerun a pillar from (alternative to sessionId).',
        },
        additionalContext: {
          type:        'string',
          description:
            'Optional additional context for the pillar agents in this rerun. ' +
            'Example: "Focus on GDPR compliance requirements for EU users."',
          maxLength:   4000,
        },
      },
      required: ['pillarName'],
    },
  },

  {
    name: 'atomic_export_bundle',
    description:
      'Export a persisted blueprint as downloadable content. Supported formats are ' +
      'JSON (full Blueprint JSON), Markdown (human-readable document), and HTML ' +
      '(styled document). Note: the server does NOT support CLAUDE.md / AGENTS.md ' +
      'export formats — use the exported Markdown/JSON with a coding agent instead.',
    inputSchema: {
      type: 'object',
      properties: {
        blueprintId: {
          type:        'string',
          description: 'The ID of the persisted blueprint to export.',
          minLength:   8,
        },
        format: {
          type:        'string',
          enum:        ['json', 'md', 'html'],
          description:
            '"json" = full Blueprint JSON. "md" = human-readable Markdown document. ' +
            '"html" = styled HTML document. The Atomic server only supports these ' +
            'three formats.',
          default:     'md',
        },
      },
      required: ['blueprintId', 'format'],
    },
  },

  {
    name: 'atomic_validate_task',
    description:
      'Pre-validate a task description before running the full pipeline. Checks ' +
      'well-formedness, estimates token cost and USD cost, and previews how the ' +
      'Governor will decompose the task. Faster and cheaper than running the full ' +
      'pipeline — use it when uncertain the task description is good.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type:        'string',
          description: 'The task description to validate. Same format as atomic_generate_blueprint.',
          minLength:   10,
          maxLength:   8000,
        },
      },
      required: ['prompt'],
    },
  },
];

// ── Prompts ───────────────────────────────────────────────────────────────────

export const ATOMIC_PROMPTS: McpPrompt[] = [
  {
    name: 'atomic-generate-from-task',
    description:
      'Generate a task prompt for atomic_generate_blueprint from a rough product idea. ' +
      'Fills in target users, constraints, and success criteria so the pipeline gets ' +
      'a well-formed task description on the first try.',
    arguments: [
      { name: 'idea', description: 'Rough product idea or feature description.', required: true },
      { name: 'audience', description: 'Target users of the system (e.g. "enterprise teams", "consumers").' },
      { name: 'constraints', description: 'Technical or business constraints (e.g. "must be serverless").' },
      { name: 'mode', description: '"fast" or "safe" pipeline mode. Defaults to "fast".' },
    ],
    handle: (args) => ({
      description: `Well-formed task prompt derived from idea "${args.idea ?? ''}"`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              'Turn this product idea into a precise task description for the Atomic ' +
              'blueprint pipeline, then call atomic_generate_blueprint with it.\n\n' +
              `Idea: ${args.idea ?? ''}\n` +
              (args.audience ? `Target audience: ${args.audience}\n` : '') +
              (args.constraints ? `Constraints: ${args.constraints}\n` : '') +
              (args.mode ? `Pipeline mode: ${args.mode}\n` : '') +
              '\n' +
              'Produce a task description of 100-400 words that specifies: the system ' +
              'to build, its primary users and their key workflows, non-functional ' +
              'requirements (scale, latency, availability), technology preferences or ' +
              'constraints, security and compliance considerations, and what "done" ' +
              'looks like. Keep it factual and specific.',
          },
        },
      ],
    }),
  },
  {
    name: 'atomic-review-blueprint',
    description:
      'Ask the model to critically review a completed blueprint and propose concrete ' +
      'improvements per pillar (feasibility, missing risks, integration gaps).',
    arguments: [
      { name: 'blueprintId', description: 'ID of the persisted blueprint to review.', required: true },
      { name: 'focus', description: 'Optional pillar or aspect to focus the review on (e.g. "security").' },
    ],
    handle: (args) => ({
      description: 'Critical review prompt for blueprint ' + args.blueprintId,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Fetch blueprint "${args.blueprintId}" with atomic_get_result, then perform ` +
              'a critical architecture review. Evaluate each pillar for feasibility, ' +
              'missing risks, over-engineering, and integration gaps. Be specific and ' +
              'prioritize: list the top 5 concrete improvements with rationale. ' +
              'Then propose precise edits you would make via atomic_rerun_pillar for ' +
              'each weak pillar.' +
              (args.focus ? `\nFocus area: ${args.focus}` : ''),
          },
        },
      ],
    }),
  },
  {
    name: 'atomic-explain-blueprint',
    description:
      'Explain a completed blueprint at a chosen audience level (executive, technical, ' +
      'onboarding). Useful for docs, stakeholder briefings, and handover.',
    arguments: [
      { name: 'blueprintId', description: 'ID of the persisted blueprint to explain.', required: true },
      { name: 'audience', description: '"executive", "technical", or "onboarding". Defaults to "technical".' },
    ],
    handle: (args) => ({
      description: 'Explanation prompt for blueprint ' + args.blueprintId,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Fetch blueprint "${args.blueprintId}" with atomic_get_result, then explain ` +
              'it in plain language for the chosen audience. Cover: what the system is, ' +
              'its key architectural decisions and trade-offs, the main pillars and their ' +
              'recommendations, and the suggested implementation order.' +
              (args.audience ? `\nAudience: ${args.audience}` : ''),
          },
        },
      ],
    }),
  },
];

// ── Resources ─────────────────────────────────────────────────────────────────

export const ATOMIC_RESOURCES: McpResource[] = [
  {
    uri:         'atomic://server-info',
    name:        'Atomic Server Info',
    description: 'Server configuration summary, API health, and session counts.',
    mimeType:    'application/json',
    read: async () => {
      const baseUrl = process.env['ATOMIC_API_URL'] ?? 'http://localhost:3000';
      const apiKey = process.env['ATOMIC_API_KEY'] ?? process.env['OPENROUTER_API_KEY'];
      let health: unknown = null;
      try {
        health = await atomicRequest('/api/health', { apiKey, timeoutMs: 5_000 });
      } catch (err) {
        health = { error: err instanceof Error ? err.message : String(err) };
      }
      return [
        {
          uri: 'atomic://server-info',
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              atomicApiUrl: baseUrl,
              apiKeyConfigured: !!apiKey,
              health,
              protocolVersion: '2025-03-26',
              serverInfo: { name: 'atomic-mcp', version: '2.5.0' },
            },
            null,
            2,
          ),
        },
      ];
    },
  },
  {
    uri:         'atomic://blueprints',
    uriTemplate: 'atomic://blueprints',
    name:        'Persisted Blueprints',
    description: 'Listing of all persisted blueprints (ids, prompts, quality scores).',
    mimeType:    'application/json',
    read: async () => {
      const apiKey = process.env['ATOMIC_API_KEY'] ?? process.env['OPENROUTER_API_KEY'];
      const list = await atomicRequest<{ blueprints?: unknown[] }[]>('/api/v1/blueprints', {
        query: { limit: '50' },
        apiKey,
        timeoutMs: 10_000,
      });
      return [
        {
          uri: 'atomic://blueprints',
          mimeType: 'application/json',
          text: JSON.stringify(list, null, 2),
        },
      ];
    },
  },
  {
    uri:         'atomic://blueprint',
    uriTemplate: 'atomic://blueprint/{id}',
    name:        'Blueprint',
    description: 'Full blueprint JSON by ID (use {id} = blueprint id).',
    mimeType:    'application/json',
    read: async (uri) => {
      const apiKey = process.env['ATOMIC_API_KEY'] ?? process.env['OPENROUTER_API_KEY'];
      const id = uri.split('/').pop() ?? '';
      const data = await atomicRequest<unknown>(`/api/v1/sessions/${id}/blueprint`, { apiKey, timeoutMs: 10_000 });
      return [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(data, null, 2),
        },
      ];
    },
  },
  {
    uri:         'atomic://skills',
    uriTemplate: 'atomic://skills',
    name:        'Atomic Skills',
    description: 'Registered pipeline skills available to the generation engine.',
    mimeType:    'application/json',
    read: async () => {
      const apiKey = process.env['ATOMIC_API_KEY'] ?? process.env['OPENROUTER_API_KEY'];
      const data = await atomicRequest<unknown>('/api/v1/skills', { apiKey, timeoutMs: 10_000 });
      return [
        {
          uri: 'atomic://skills',
          mimeType: 'application/json',
          text: JSON.stringify(data, null, 2),
        },
      ];
    },
  },
];
