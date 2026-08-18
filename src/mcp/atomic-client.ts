/**
 * src/mcp/atomic-client.ts
 *
 * Retryable HTTP client used by MCP tool handlers to call the Atomic server API.
 *
 * Features:
 *   - Exponential backoff with full jitter, bounded
 *   - 429 Retry-After awareness (seconds or HTTP-date)
 *   - Retriable status set: 408, 429, 500, 502, 503, 504
 *   - Per-request timeout
 *   - Auth header from ATOMIC_API_KEY env (Bearer) with per-call override
 *   - Response body always buffered before error parsing
 */

const RETRIABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;

export class AtomicApiClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AtomicApiClientError';
  }
}

/** Full-jitter backoff bounded by MAX_DELAY_MS. */
export function jitteredBackoff(attempt: number): number {
  return Math.min(Math.random() * Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS), MAX_DELAY_MS);
}

/** Parse a Retry-After header into milliseconds; returns undefined if invalid. */
export function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_DELAY_MS * 2);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), MAX_DELAY_MS * 2));
  return undefined;
}

const _fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface AtomicClientOptions {
  baseUrl?: string;
  /** Override the API key for a single call. */
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

function getBaseUrl(): string {
  return (process.env['ATOMIC_API_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
}

function getDefaultApiKey(): string | undefined {
  return process.env['ATOMIC_API_KEY'] ?? process.env['OPENROUTER_API_KEY'];
}

/**
 * Perform an authenticated request against the Atomic server with retries.
 *
 * GET body parameters: `query` object is serialized as query string.
 */
export async function atomicRequest<T>(
  path: string,
  opts: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    query?: Record<string, string>;
    apiKey?: string;
    /** Disallow retries for this call (e.g. mutations that must not replay). */
    noRetry?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const baseUrl = getBaseUrl();
  const method = opts.method ?? 'GET';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let url = `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  if (opts.query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const apiKey = opts.apiKey ?? getDefaultApiKey();
  const headers: Record<string, string> = {
    'Accept':       'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
  };

  const maxAttempts = opts.noRetry ? 1 : MAX_RETRIES + 1;
  let lastError: AtomicApiClientError | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(jitteredBackoff(attempt - 1));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await _fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const status = response.status;
        const raw = await response.text().catch(() => '');
        let message = `Atomic API error ${status}`;
        let details: unknown;
        try {
          const parsed = JSON.parse(raw) as { error?: string; message?: string; details?: unknown };
          message = `Atomic API error ${status}: ${parsed.error ?? parsed.message ?? raw}`;
          details = parsed.details;
        } catch {
          if (raw) message += `: ${raw.slice(0, 300)}`;
        }

        const err = new AtomicApiClientError(message, status, details);

        if (!opts.noRetry && RETRIABLE_STATUS.has(status) && attempt + 1 < maxAttempts) {
          const retryAfter = status === 429
            ? parseRetryAfterHeader(response.headers.get('Retry-After'))
            : undefined;
          if (retryAfter !== undefined) await sleep(retryAfter);
          lastError = err;
          continue;
        }
        throw err;
      }

      const text = await response.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof AtomicApiClientError) throw err;
      // Non-API errors (network failures, aborted timeouts) are retriable
      const isAborted = err instanceof Error && err.name === 'AbortError';
      const isTypeError = err instanceof TypeError;
      if (!opts.noRetry && (isAborted || isTypeError) && attempt + 1 < maxAttempts) {
        lastError = new AtomicApiClientError(isAborted ? 'Request timed out' : `Network error: ${(err as Error).message}`, undefined, err);
        continue;
      }
      if (err instanceof Error) throw new AtomicApiClientError(err.message, undefined, err);
      throw new AtomicApiClientError(String(err), undefined, err);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError ?? new AtomicApiClientError('Retry exhausted');
}
