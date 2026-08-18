/**
 * src/sdk/resources/observability.ts
 *
 * Observability resource — traces, event-bus history, and long-term agent memory.
 */

import type { AtomicHTTP } from '../client';

export interface TraceEntry {
  id:        string;
  name:      string;
  duration?: number;
  status?:   string;
  [key: string]: unknown;
}

export interface EventEntry {
  id:        string;
  type:      string;
  payload?:  Record<string, unknown>;
  timestamp: string;
  [key: string]: unknown;
}

export class ObservabilityResource {
  constructor(private readonly http: AtomicHTTP) {}

  /** List recent traces. */
  async listTraces(opts: { limit?: number; pipeline?: string } = {}): Promise<{ traces: TraceEntry[] }> {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.pipeline) params.set('pipeline', opts.pipeline);
    const qs = params.toString();
    return this.http.request<{ traces: TraceEntry[] }>(`/observability/traces${qs ? `?${qs}` : ''}`);
  }

  /** List event-bus history. */
  async listEvents(opts: { limit?: number; type?: string } = {}): Promise<{ events: EventEntry[] }> {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.type) params.set('type', opts.type);
    const qs = params.toString();
    return this.http.request<{ events: EventEntry[] }>(`/event-bus/history${qs ? `?${qs}` : ''}`);
  }

  /** Long-term agent memory entries (optional domain filter). */
  async listMemory(domain?: string): Promise<{ entries: unknown[] }> {
    const qs = domain ? `?domain=${encodeURIComponent(domain)}` : '';
    return this.http.request<{ entries: unknown[] }>(`/agent/memory/long-term${qs}`);
  }

  /** Clear long-term memory for a domain. */
  async clearMemory(domain: string): Promise<{ deleted: boolean }> {
    return this.http.request<{ deleted: boolean }>(`/agent/memory/long-term/${encodeURIComponent(domain)}`, {
      method: 'DELETE',
    });
  }
}
