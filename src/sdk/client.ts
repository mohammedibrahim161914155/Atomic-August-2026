/**
 * src/sdk/client.ts
 *
 * AtomicClient — the primary entry point for the Atomic TypeScript SDK.
 *
 * Usage:
 *   import { AtomicClient } from '@atomic/sdk';
 *   const client = new AtomicClient({ baseUrl: 'http://localhost:5000' });
 *   const { blueprint } = await client.blueprints.generate({ prompt: '...' });
 */

import type { AtomicClientConfig } from './types';
import { Blueprints } from './resources/blueprints';
import { ArtemisResource } from './resources/artemis';
import { CuratorResource } from './resources/curator';
import { SkillsResource } from './resources/skills';
import { VersionsResource } from './resources/versions';
import { ChatResource } from './resources/chat';

export { AtomicError, AtomicRateLimitError, AtomicAuthError } from './types';

// ── Internal fetch wrapper ────────────────────────────────────────────────────

export interface RequestOptions {
  method?:  string;
  body?:    unknown;
  signal?:  AbortSignal;
  headers?: Record<string, string>;
}

export class AtomicHTTP {
  readonly baseUrl: string;
  private readonly apiKey?:  string;
  private readonly timeout:  number;
  private readonly _fetch:   typeof globalThis.fetch;

  constructor(config: AtomicClientConfig) {
    this.baseUrl  = (config.baseUrl ?? 'http://localhost:5000').replace(/\/$/, '');
    this.apiKey   = config.apiKey;
    this.timeout  = config.timeout ?? 120_000;
    this._fetch   = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Build full URL from path (strips leading /api/v1 duplication) */
  url(path: string): string {
    const clean = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}/api/v1${clean}`;
  }

  /** Perform a JSON request */
  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const { AtomicError: AError, AtomicRateLimitError, AtomicAuthError } = await import('./types');

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), this.timeout);
    const signal     = opts.signal
      ? AbortSignal.any([opts.signal, controller.signal])
      : controller.signal;

    try {
      const res = await this._fetch(this.url(path), {
        method:  opts.method ?? 'GET',
        headers: {
          'Content-Type':  'application/json',
          'Accept':        'application/json',
          ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
          ...opts.headers,
        },
        body:   opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal,
      });

      if (res.status === 401) throw new AtomicAuthError();
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        throw new AtomicRateLimitError(retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined);
      }

      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        let details: unknown;
        try {
          const body = await res.json() as { error?: string; details?: unknown };
          message  = body.error ?? message;
          details  = body.details;
        } catch { /* ignore parse errors */ }
        throw new AError(res.status, message, details);
      }

      return await res.json() as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Stream an SSE endpoint, calling onChunk for each text delta. Returns full text. */
  async stream(
    path:    string,
    body:    unknown,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const { AtomicError: AError } = await import('./types');

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), this.timeout);
    const mergedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    let accumulated = '';
    try {
      const res = await this._fetch(this.url(path), {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
        },
        body:   JSON.stringify(body),
        signal: mergedSignal,
      });

      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const b = await res.json() as { error?: string }; msg = b.error ?? msg; } catch { /* */ }
        throw new AError(res.status, msg);
      }

      const reader  = res.body?.getReader();
      if (!reader) throw new AError(500, 'No response body');
      const decoder = new TextDecoder();

      // eslint-disable-next-line no-constant-condition -- SSE stream read loop, exits on {done: true}
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const lines = decoder.decode(value, { stream: true }).split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') break;
          try {
            const parsed = JSON.parse(payload) as { chunk?: string; error?: string };
            if (parsed.error) throw new AError(500, parsed.error);
            if (parsed.chunk) {
              accumulated += parsed.chunk;
              onChunk(parsed.chunk);
            }
          } catch (e) {
            if (e instanceof Error && e.name !== 'SyntaxError') throw e;
            /* partial JSON — skip */
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }

    return accumulated;
  }
}

// ── Client ────────────────────────────────────────────────────────────────────

/**
 * AtomicClient — the main entry point for the Atomic SDK.
 *
 * @example
 * ```typescript
 * import { AtomicClient } from '@atomic/sdk';
 *
 * const client = new AtomicClient({
 *   baseUrl: 'https://your-atomic-instance.example.com',
 *   apiKey:  process.env.ATOMIC_API_KEY,
 * });
 *
 * // Generate a blueprint
 * const { blueprint } = await client.blueprints.generate({
 *   prompt: 'A SaaS for restaurant inventory management',
 *   mode: 'safe',
 *   onProgress: (ev) => console.log(ev.type, ev.pillar ?? ''),
 * });
 *
 * console.log('Quality:', blueprint.quality_score);
 * ```
 */
export class AtomicClient {
  /** Blueprint CRUD, generation, and management */
  readonly blueprints: Blueprints;
  /** Artemis pre-pipeline scoping agent */
  readonly artemis:    ArtemisResource;
  /** Curator post-pipeline refinement agent */
  readonly curator:    CuratorResource;
  /** Skills management */
  readonly skills:     SkillsResource;
  /** Blueprint version history */
  readonly versions:   VersionsResource;
  /** Chat (general Q&A) */
  readonly chat:       ChatResource;

  /** @internal */
  readonly http: AtomicHTTP;

  constructor(config: AtomicClientConfig = {}) {
    this.http       = new AtomicHTTP(config);
    this.blueprints = new Blueprints(this.http);
    this.artemis    = new ArtemisResource(this.http);
    this.curator    = new CuratorResource(this.http);
    this.skills     = new SkillsResource(this.http);
    this.versions   = new VersionsResource(this.http);
    this.chat       = new ChatResource(this.http);
  }
}
