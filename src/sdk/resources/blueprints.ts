/**
 * src/sdk/resources/blueprints.ts
 *
 * Blueprint resource — full CRUD + generation with live SSE streaming.
 */

import type { AtomicHTTP } from '../client';
import type {
  Blueprint, BlueprintListResponse, BlueprintSummary,
  GenerateOptions, GenerateResult, GenerationEvent,
} from '../types';

export class Blueprints {
  constructor(private readonly http: AtomicHTTP) {}

  /**
   * Generate a blueprint using the Atomic multi-agent pipeline.
   *
   * If `opts.onProgress` is provided, SSE events are forwarded in real time.
   * The returned promise resolves once the pipeline is complete and the blueprint
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

    // Step 1 — kick off async generation (returns sessionId immediately)
    const { sessionId } = await this.http.request<{ sessionId: string }>('/generate-start', {
      method: 'POST',
      body: { prompt, mode, pipelineType, config: modelConfig },
    });

    // Step 2 — subscribe to SSE stream
    return new Promise<GenerateResult>((resolve, reject) => {
      const url   = this.http.url(`/generate-stream/${sessionId}`);
      const es    = new EventSource(url);
      let done    = false;

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data as string) as GenerationEvent;
          onProgress?.(event);
          if (event.type === 'complete' && event['blueprintId']) {
            done = true;
            es.close();
            this.get(event['blueprintId'] as string)
              .then(blueprint => resolve({ sessionId, blueprint }))
              .catch(reject);
          } else if (event.type === 'error') {
            done = true;
            es.close();
            reject(new Error((event.message ?? 'Generation failed')));
          }
        } catch { /* partial event */ }
      };

      es.onerror = (err) => {
        if (!done) { es.close(); reject(new Error(`SSE connection error: ${String(err)}`)); }
      };
    });
  }

  /** Get a single blueprint by ID */
  async get(id: string): Promise<Blueprint> {
    return this.http.request<Blueprint>(`/blueprints/${id}`);
  }

  /**
   * List blueprints with optional filters.
   *
   * @param opts.page     1-based page number (default: 1)
   * @param opts.pageSize Results per page (default: 20, max: 100)
   * @param opts.search   Full-text search query
   * @param opts.sort     'created_at' | 'quality_score' | 'rating'
   */
  async list(opts: {
    page?:     number;
    pageSize?: number;
    search?:   string;
    sort?:     'created_at' | 'quality_score' | 'rating';
    order?:    'asc' | 'desc';
  } = {}): Promise<BlueprintListResponse> {
    const params = new URLSearchParams();
    if (opts.page     != null) params.set('page',     String(opts.page));
    if (opts.pageSize != null) params.set('pageSize', String(opts.pageSize));
    if (opts.search)           params.set('search',   opts.search);
    if (opts.sort)             params.set('sort',     opts.sort);
    if (opts.order)            params.set('order',    opts.order);
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

  /** Export blueprint as Markdown */
  async exportMarkdown(id: string): Promise<string> {
    const res = await globalThis.fetch(this.http.url(`/blueprints/${id}/export?format=markdown`));
    if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`);
    return res.text();
  }

  /** Export blueprint as JSON */
  async exportJson(id: string): Promise<Blueprint> {
    return this.http.request<Blueprint>(`/blueprints/${id}/export?format=json`);
  }

  /** Export blueprint as HTML */
  async exportHtml(id: string): Promise<string> {
    const res = await globalThis.fetch(this.http.url(`/blueprints/${id}/export?format=html`));
    if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`);
    return res.text();
  }
}
