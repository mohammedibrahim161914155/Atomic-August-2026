/**
 * src/sdk/resources/blueprints.ts
 *
 * Blueprint resource — full CRUD + synchronous and asynchronous generation.
 * Query parameters follow the real server contract exactly
 * (limit/offset/search/tag/sort/date_after/quality_min).
 */

import type { AtomicHTTP } from '../client';
import type {
  Blueprint, BlueprintListOptions, BlueprintListResponse, BlueprintSummary,
  GenerateOptions, GenerateResult, GenerationEvent,
  GenerateAsyncOptions, GenerateAsyncResult, RunInfo, RunStatus,
} from '../types';
import { AtomicError, AtomicStreamError } from '../types';



export class Blueprints {
  constructor(private readonly http: AtomicHTTP) {}

  /**
   * Generate a blueprint using the Atomic multi-agent pipeline (synchronous SSE).
   *
   * If `opts.onProgress` is provided, pipeline events are forwarded in real time.
   * The returned promise resolves once the pipeline completes and the blueprint
   * has been persisted.
   *
   * @example
   * ```ts
   * const { blueprint } = await client.blueprints.generate({
   *   prompt: 'A food-delivery SaaS with real-time tracking',
   *   mode:   'safe',
   *   onProgress: ev => process.stdout.write(`[${ev.type}] ${ev.message ?? ''}\n`),
   * });
   * ```
   */
  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const { prompt, mode = 'fast', pipelineType = 'blueprint', modelConfig, onProgress } = opts;

    const body: Record<string, unknown> = {
      prompt: prompt.trim(),
      mode,
      pipelineType,
      ...(modelConfig ? { config: modelConfig } : {}),
    };

    const events = await this.http.streamEvents<GenerationEvent>('/generate', body, {
      onEvent: (event) => {
        // Surface non-terminal events via the progress callback
        if (event.type !== 'complete' && event.type !== 'done' && onProgress) onProgress(event);
      },
    });

    const complete = events.find(ev => ev.type === 'complete' || ev.type === 'done');
    const blueprint = complete?.blueprint as Blueprint | undefined;

    if (!blueprint) {
      const failure = events.find(ev => ev.type === 'error' || ev.type === 'failed');
      throw new AtomicStreamError(failure?.message ?? 'Generation completed without a blueprint');
    }

    const sessionId = blueprint.session_id ?? String(complete?.sessionId ?? '');
    return { sessionId, blueprint };
  }

  /**
   * Start an asynchronous generation and return a run id immediately.
   * Poll with `getRun` until the status is `completed` or `failed`.
   */
  async generateAsync(opts: GenerateAsyncOptions): Promise<GenerateAsyncResult> {
    const { prompt, mode = 'fast', pipelineType = 'blueprint', modelConfig } = opts;
    const result = await this.http.request<{ runId?: string; run_id?: string }>('/generate-async', {
      method: 'POST',
      body: {
        prompt: prompt.trim(),
        mode,
        pipelineType,
        ...(modelConfig ? { config: modelConfig } : {}),
      },
    });
    return { runId: result.runId ?? result.run_id ?? '' };
  }

  /** Poll the state of an async generation run. */
  async getRun(runId: string): Promise<RunInfo> {
    return this.http.request<RunInfo>(`/run/${runId}`);
  }

  /** Poll until an async run reaches a terminal state (completed/failed/aborted). */
  async waitForRun(runId: string, opts: { pollIntervalMs?: number; timeoutMs?: number } = {}): Promise<RunInfo> {
    const pollIntervalMs = opts.pollIntervalMs ?? 1_500;
    const timeoutMs      = opts.timeoutMs ?? this.http.timeout;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const info = await this.getRun(runId);
      if (['completed', 'failed', 'aborted'].includes(info.status as RunStatus)) return info;
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    throw new AtomicError(408, `Run ${runId} did not complete within ${timeoutMs}ms`);
  }

  /** Get a single blueprint by ID */
  async get(id: string): Promise<Blueprint> {
    return this.http.request<Blueprint>(`/blueprints/${id}`);
  }

  /**
   * List blueprints with optional filters.
   *
   * Parameters are translated to the server's real query contract:
   * `pageSize` → limit, `page` → offset, `search`, `tag`,
   * `sort` (newest|oldest|quality), `dateAfter`, `qualityMin`.
   */
  async list(opts: BlueprintListOptions = {}): Promise<BlueprintListResponse> {
    const params = new URLSearchParams();
    const limit = Math.min(Math.max(opts.pageSize ?? 20, 1), 100);
    params.set('limit', String(limit));
    if (opts.page) params.set('offset', String((opts.page - 1) * limit));
    if (opts.search)    params.set('search', opts.search);
    if (opts.tag)       params.set('tag', opts.tag);
    if (opts.sort)      params.set('sort', opts.sort);
    if (opts.dateAfter) params.set('date_after', opts.dateAfter);
    if (opts.qualityMin != null) params.set('quality_min', String(opts.qualityMin));
    if (opts.order)     params.set('order', opts.order);
    const qs = params.toString();
    return this.http.request<BlueprintListResponse>(`/blueprints${qs ? `?${qs}` : ''}`);
  }

  /** Delete a blueprint */
  async delete(id: string): Promise<{ deleted: boolean }> {
    return this.http.request<{ deleted: boolean }>(`/blueprints/${id}`, { method: 'DELETE' });
  }

  /**
   * Rate a blueprint (1–5 stars).
   * @param rating 1–5 (null removes the rating)
   */
  async rate(id: string, rating: number | null): Promise<BlueprintSummary> {
    return this.http.request<BlueprintSummary>(`/blueprints/${id}/rating`, {
      method: 'PATCH',
      body:   { rating },
    });
  }

  /** Save a per-section note */
  async saveNote(id: string, sectionKey: string, note: string): Promise<{ saved: boolean }> {
    return this.http.request<{ saved: boolean }>(`/blueprints/${id}/note`, {
      method: 'PATCH',
      body:   { sectionKey, note },
    });
  }

  /** Manage tags on a blueprint */
  async setTags(id: string, tags: string[]): Promise<{ tags: string[] }> {
    return this.http.request<{ tags: string[] }>(`/blueprints/${id}/tags`, {
      method: 'PATCH',
      body:   { tags },
    });
  }

  /** List all known blueprint tags */
  async listTags(): Promise<{ tags: string[] }> {
    return this.http.request<{ tags: string[] }>('/blueprints/tags');
  }

  /** Export blueprint as Markdown */
  async exportMarkdown(id: string): Promise<string> {
    return this.http.request<string>(`/blueprints/${id}/export?format=markdown`);
  }

  /** Export blueprint as JSON */
  async exportJson(id: string): Promise<Blueprint> {
    return this.http.request<Blueprint>(`/blueprints/${id}/export?format=json`);
  }

  /** Export blueprint as HTML */
  async exportHtml(id: string): Promise<string> {
    return this.http.request<string>(`/blueprints/${id}/export?format=html`);
  }

  /** Run a plugin-driven export action (e.g. push to Linear/Notion) */
  async exportAction(id: string, action: string, options?: Record<string, unknown>): Promise<{ success: boolean; output?: unknown; error?: string }> {
    return this.http.request(`/blueprints/${id}/export-action`, {
      method: 'POST',
      body:   { action, options },
    });
  }

  /** Render an inline blueprint object to Markdown without persisting it */
  async exportInline(blueprint: Blueprint, format: 'markdown' | 'html' = 'markdown'): Promise<string> {
    return this.http.request<string>('/blueprints/export-inline', {
      method: 'POST',
      body:   { blueprint, format },
    });
  }
}
