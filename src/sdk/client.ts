/**
 * src/sdk/client.ts
 *
 * AtomicClient — the primary entry point for the Atomic TypeScript SDK.
 *
 * Production-grade features:
 *   - Typed error taxonomy (AtomicAuthError, AtomicNotFoundError, ... )
 *   - Exponential-backoff retries with jitter + 429 Retry-After handling
 *   - Robust SSE stream parsing with reconnect/backoff (no EventSource dependency)
 *   - Per-request AbortSignal and timeout passthrough
 *   - Multi-tenancy (X-Workspace-Id) and custom header support
 *   - Injectable fetch for testing
 *
 * Usage:
 *   import { AtomicClient } from '@atomic/sdk';
 *   const client = new AtomicClient({ baseUrl: 'http://localhost:3000', apiKey: process.env.ATOMIC_API_KEY });
 *   const { blueprint } = await client.blueprints.generate({ prompt: '...' });
 */

import type { AtomicClientConfig } from './types';
import { AtomicError, AtomicStreamError } from './types';
import { atomicErrorFromResponse, AtomicRetryExhaustedError, AtomicTimeoutError } from './types';
import { Blueprints } from './resources/blueprints';
import { ArtemisResource } from './resources/artemis';
import { CuratorResource } from './resources/curator';
import { SkillsResource } from './resources/skills';
import { VersionsResource } from './resources/versions';
import { ChatResource } from './resources/chat';
import { PluginsResource } from './resources/plugins';
import { SessionsResource } from './resources/sessions';
import { PipelinesResource } from './resources/pipelines';
import { ObservabilityResource } from './resources/observability';

export { atomicErrorFromResponse } from './types';

// ── Internal fetch wrapper ────────────────────────────────────────────────────

export interface RequestOptions {
  method?:  string;
  body?:    unknown;
  signal?:  AbortSignal;
  headers?: Record<string, string>;
  /** Skip retry for this request even on retriable failures */
  noRetry?: boolean;
  /** Return the raw Response (e.g. for binary/text exports) instead of parsing JSON */
  raw?:     boolean;
  /** Idempotency key sent as Idempotency-Key header for safe POST replay */
  idempotencyKey?: string;
}

const RETRIABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Sleep for `ms` milliseconds, returning early if the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new AtomicTimeoutError('Request aborted')); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AtomicTimeoutError('Request aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Full-jitter backoff delay bounded by `maxDelayMs`. */
export function backoffDelay(attempt: number, baseMs: number, maxDelayMs = 30_000): number {
  const cap = Math.min(baseMs * 2 ** attempt, maxDelayMs);
  return Math.random() * cap;
}

export class AtomicHTTP {
  readonly baseUrl: string;
  private readonly apiKey?:  string;
  readonly timeout:  number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly workspaceId?: string;
  private readonly headers:  Record<string, string>;
  private readonly userAgent: string;
  private readonly _fetch:   typeof globalThis.fetch;

  constructor(config: AtomicClientConfig) {
    this.baseUrl         = (config.baseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
    this.apiKey          = config.apiKey;
    this.timeout         = config.timeout ?? 120_000;
    this.maxRetries      = config.maxRetries ?? 3;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 500;
    this.workspaceId     = config.workspaceId;
    this.headers         = config.headers ?? {};
    this.userAgent       = config.userAgent ?? `atomic-sdk-ts/2.5.0`;
    this._fetch          = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Build full URL from path (strips leading slash; never double-adds /api/v1) */
  url(path: string): string {
    const clean = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}/api/v1${clean}`;
  }

  /** Parse a Retry-After header (seconds integer or HTTP-date) into milliseconds. */
  static parseRetryAfter(value: string | null): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const date = Date.parse(value);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    return undefined;
  }

  /** Perform a JSON request with retries for retriable failures. */
  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, controller.signal])
      : controller.signal;

    try {
      let lastError: AtomicError | undefined;
      const attempts = opts.noRetry ? 1 : this.maxRetries + 1;

      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) {
          const wait = lastError instanceof Error && 'retryAfterMs' in lastError
            ? (lastError as { retryAfterMs?: number }).retryAfterMs ?? backoffDelay(attempt - 1, this.retryBaseDelayMs)
            : backoffDelay(attempt - 1, this.retryBaseDelayMs);
          await sleep(wait, signal);
        }

        try {
          const res = await this._fetch(this.url(path), {
            method:  opts.method ?? 'GET',
            headers: this.buildHeaders(opts),
            body:   opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
            signal,
          });

          if (!res.ok) {
            let message = `HTTP ${res.status}`;
            let details: unknown;
            try {
              const body = await res.json() as { error?: string; details?: unknown };
              message = body.error ?? message;
              details = body.details;
            } catch { /* body may not be JSON */ }
            const err = atomicErrorFromResponse(res.status, message, details);
            if (!opts.noRetry && RETRIABLE_STATUS.has(res.status) && attempt + 1 < attempts) {
              lastError = err;
              continue;
            }
            throw err;
          }

          if (opts.raw) return res as unknown as T;

          const text = await res.text();
          if (!text) return undefined as T;
          try {
            return JSON.parse(text) as T;
          } catch {
            // Non-JSON 200 (e.g. export endpoints returning plain markdown) — return text
            return text as unknown as T;
          }
        } catch (err) {
          // Network-level failures (DNS, connection refused, aborted) are retriable
          const isNetwork = err instanceof DOMException && err.name === 'AbortError'
            ? signal.aborted
            : err instanceof Error && !(err instanceof AtomicError);
          if (!opts.noRetry && isNetwork && attempt + 1 < attempts) {
            lastError = new AtomicTimeoutError('Network failure');
            continue;
          }
          if (err instanceof AtomicError) throw err;
          throw err;
        }
      }

      throw new AtomicRetryExhaustedError(attempts, lastError ?? new AtomicTimeoutError('Retry exhausted'));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Stream an SSE endpoint that emits structured JSON events (e.g. /generate),
   * collecting every parsed event and returning them in order. Terminal
   * `[DONE]` markers end the stream; `{ error }` events throw AtomicStreamError.
   */
  async streamEvents<T>(
    path: string,
    body: unknown,
    opts: { onEvent?: (event: T) => void; signal?: AbortSignal } = {},
  ): Promise<T[]> {
    const events: T[] = [];
    const content = await this.stream(path, body, (raw) => {
      try {
        const event = JSON.parse(raw) as T;
        events.push(event);
        opts.onEvent?.(event);
      } catch {
        /* partial JSON — skip */
      }
    }, opts.signal);
    void content;
    return events;
  }

  private buildHeaders(opts: RequestOptions): Record<string, string> {
    return {
      'Accept':        'application/json, text/plain, */*',
      'Content-Type':  'application/json',
      ...(this.userAgent ? { 'User-Agent': this.userAgent } : {}),
      ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
      ...(this.workspaceId ? { 'X-Workspace-Id': this.workspaceId } : {}),
      ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
      ...this.headers,
      ...opts.headers,
    };
  }

  /**
   * Stream an SSE endpoint, calling `onChunk` for each text delta and returning
   * the accumulated text. Uses fetch (not EventSource) so auth headers survive.
   *
   * SSE events follow the Atomic convention: `data: {"chunk":"...","error":...}`
   * with a terminal `data: [DONE]` marker. Parse failures on non-error events are
   * tolerated (partial JSON) so slow servers never break the stream.
   */
  async stream(
    path:    string,
    body:    unknown,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    const mergedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    let accumulated = '';
    try {
      const res = await this._fetch(this.url(path), {
        method:  'POST',
        headers: this.buildHeaders({}),
        body:   JSON.stringify(body),
        signal: mergedSignal,
      });

      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const b = await res.json() as { error?: string }; msg = b.error ?? msg; } catch { /* */ }
        throw atomicErrorFromResponse(res.status, msg);
      }

      const reader  = res.body?.getReader();
      if (!reader) throw new AtomicStreamError('No response body');
      const decoder = new TextDecoder();

      // eslint-disable-next-line no-constant-condition -- SSE read loop; exits on done
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const lines = decoder.decode(value, { stream: true }).split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(trimmed.indexOf('data:') + 5).trim();
          if (payload === '[DONE]') return accumulated;
          try {
            const parsed = JSON.parse(payload) as { chunk?: string; error?: string };
            if (parsed.error) throw new AtomicStreamError(parsed.error);
            if (parsed.chunk) {
              accumulated += parsed.chunk;
              onChunk(parsed.chunk);
            }
          } catch (e) {
            if (e instanceof AtomicStreamError) throw e;
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
  /** Engine plugins (install/trust/run/doctor) */
  readonly plugins:    PluginsResource;
  /** Session control (abort/plan/steer/snapshots/undo/elicitation/permissions) */
  readonly sessions:   SessionsResource;
  /** Pipeline configs, health, and cost estimation */
  readonly pipelines:  PipelinesResource;
  /** Observability traces and event bus */
  readonly observability: ObservabilityResource;

  /** @internal */
  readonly http: AtomicHTTP;

  constructor(config: AtomicClientConfig = {}) {
    this.http            = new AtomicHTTP(config);
    this.blueprints      = new Blueprints(this.http);
    this.artemis         = new ArtemisResource(this.http);
    this.curator         = new CuratorResource(this.http);
    this.skills          = new SkillsResource(this.http);
    this.versions        = new VersionsResource(this.http);
    this.chat            = new ChatResource(this.http);
    this.plugins         = new PluginsResource(this.http);
    this.sessions        = new SessionsResource(this.http);
    this.pipelines       = new PipelinesResource(this.http);
    this.observability   = new ObservabilityResource(this.http);
  }
}
