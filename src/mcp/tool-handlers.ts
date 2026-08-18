/**
 * src/mcp/tool-handlers.ts
 *
 * Implementation of MCP tool handlers, mapped to the real Atomic server REST API.
 *
 * Route mapping (verified against server.ts):
 *   atomic_generate_blueprint → POST /api/v1/generate-start (returns sessionId immediately)
 *   atomic_get_status         → GET  /api/v1/sessions/{id}
 *   atomic_get_result         → GET  /api/v1/sessions/{id}/blueprint
 *   atomic_list_blueprints    → GET  /api/v1/blueprints?limit=&offset=&search=&tag=&sort=&dateAfter=&qualityMin=
 *   atomic_rerun_pillar       → POST /api/v1/rerun-pillar  (sessionId | inline blueprint + pillarName)
 *   atomic_export_bundle      → GET  /api/v1/blueprints/{id}/export?format=json|md|html
 *   atomic_validate_task      → POST /api/v1/validate
 *
 * Aborted requests (cancellation from the client) throw an AtomicApiClientError
 * before touching the API where possible; in-flight requests are not retractable
 * on the server side and this is noted in results.
 */

import { atomicRequest, AtomicApiClientError } from './atomic-client';

export interface ToolHandlerContext {
  abortSignal?: AbortSignal;
  apiKey?: string;
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AtomicApiClientError('Request cancelled by client');
}

async function run<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  assertNotCancelled(signal);
  // Poll aborts between async steps — not retroactive to in-flight fetches.
  const result = await fn();
  assertNotCancelled(signal);
  return result;
}

export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolHandlerContext = {},
): Promise<unknown> {
  switch (toolName) {
    case 'atomic_generate_blueprint': {
      const {
        prompt, mode = 'fast', apiKey, provider, fastModel, proModel,
      } = args as {
        prompt: string; mode?: string; apiKey?: string; provider?: string;
        fastModel?: string; proModel?: string;
      };

      const result = await run(
        () => atomicRequest<{
          sessionId: string; statusUrl: string; sseUrl: string; message: string;
        }>('/api/v1/generate-start', {
          method: 'POST',
          body: {
            prompt: prompt.trim(),
            mode,
            ...(provider ? { provider } : {}),
            ...(fastModel ? { fastModel } : {}),
            ...(proModel ? { proModel } : {}),
          },
          apiKey,
          timeoutMs: 30_000,
        }),
        ctx.abortSignal,
      );

      return {
        sessionId:  result.sessionId,
        statusUrl:  result.statusUrl,
        sseUrl:     result.sseUrl,
        message:
          `Blueprint generation started in the background. Poll the session with ` +
          `atomic_get_status using sessionId="${result.sessionId}", then fetch the ` +
          `completed blueprint with atomic_get_result once the status is "complete". ` +
          `Background runs take 1-10 minutes depending on mode and provider.`,
      };
    }

    case 'atomic_get_status': {
      const { sessionId } = args as { sessionId: string };
      return run(
        () => atomicRequest<unknown>(`/api/v1/sessions/${sessionId}`, { apiKey: args.apiKey as string | undefined, timeoutMs: 15_000 }),
        ctx.abortSignal,
      );
    }

    case 'atomic_get_result': {
      const { sessionId, format = 'json' } = args as { sessionId: string; format?: string };

      const blueprint = await run(
        () => atomicRequest<Record<string, unknown>>(`/api/v1/sessions/${sessionId}/blueprint`, {
          apiKey: args.apiKey as string | undefined, timeoutMs: 30_000,
        }),
        ctx.abortSignal,
      );

      if (format === 'summary') {
        const bp = blueprint as {
          sections?: { executive_summary?: string };
          quality_score?: number; prompt?: string;
        };
        return {
          prompt: bp.prompt,
          qualityScore: bp.quality_score,
          executiveSummary: bp.sections?.executive_summary ?? '',
          message: 'Use atomic_export_bundle for serialized exports (json/md/html).',
        };
      }
      return blueprint;
    }

    case 'atomic_list_blueprints': {
      const {
        limit = 20, offset = 0, search, tag, sort = 'newest', dateAfter, qualityMin,
      } = args as {
        limit?: number; offset?: number; search?: string; tag?: string;
        sort?: string; dateAfter?: string; qualityMin?: number;
      };
      return run(
        () => atomicRequest<unknown>('/api/v1/blueprints', {
          query: {
            limit: String(limit),
            offset: String(offset),
            ...(search ? { search } : {}),
            ...(tag ? { tag } : {}),
            ...(sort ? { sort } : {}),
            ...(dateAfter ? { dateAfter } : {}),
            ...(qualityMin !== undefined ? { qualityMin: String(qualityMin) } : {}),
          },
          apiKey: args.apiKey as string | undefined,
          timeoutMs: 15_000,
        }),
        ctx.abortSignal,
      );
    }

    case 'atomic_rerun_pillar': {
      const { pillarName, sessionId, blueprint, additionalContext } = args as {
        pillarName: string; sessionId?: string; blueprint?: Record<string, unknown>;
        additionalContext?: string;
      };
      const body: Record<string, unknown> = {
        pillarName,
        ...(sessionId ? { sessionId } : {}),
        ...(blueprint ? { blueprint } : {}),
        ...(additionalContext ? { additionalContext } : {}),
      };
      const result = await run(
        () => atomicRequest<{ sessionId?: string; message?: string }>(
          '/api/v1/rerun-pillar',
          { method: 'POST', body, apiKey: args.apiKey as string | undefined, timeoutMs: 60_000 },
        ),
        ctx.abortSignal,
      );
      return {
        ...result,
        message:
          `Pillar "${pillarName}" rerun started. The Atomic server streams progress via ` +
          `SSE; check session status with atomic_get_status. Note: pillar reruns cannot ` +
          `be cancelled once dispatched.`,
      };
    }

    case 'atomic_export_bundle': {
      const { blueprintId, format = 'md' } = args as { blueprintId: string; format?: string };
      // format enum is validated upstream (json|md|html only — server contract)
      return run(
        () => atomicRequest<unknown>(`/api/v1/blueprints/${blueprintId}/export`, {
          query: { format: String(format) },
          apiKey: args.apiKey as string | undefined,
          timeoutMs: 30_000,
        }),
        ctx.abortSignal,
      );
    }

    case 'atomic_validate_task': {
      const { prompt } = args as { prompt: string };
      return run(
        () => atomicRequest<unknown>('/api/v1/validate', {
          method: 'POST',
          body: { prompt: prompt.trim() },
          apiKey: args.apiKey as string | undefined,
          timeoutMs: 30_000,
        }),
        ctx.abortSignal,
      );
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
