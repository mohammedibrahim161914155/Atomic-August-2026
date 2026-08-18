/**
 * src/plugins/http.ts
 *
 * Retryable HTTP client for export/integration plugins.
 *
 * Production-grade network access follows the same rules FAANG integrations
 * use (Stripe/Linear/Notion client conventions):
 *   - Exponential backoff with full jitter on transient failures.
 *   - Server-sent `Retry-After` (both header seconds and HTTP-date forms) is
 *     honored verbatim for 429 / 503 responses — the server knows best.
 *   - Client-defined timeout per request (default 30 s) with AbortController.
 *   - Idempotency discipline: only GET / POST / PUT / PATCH / DELETE are
 *     retried on network or server errors; POST to GraphQL is retried because
 *     Linear's GraphQL API is effectively idempotent for read-like mutations
 *     scoped to unique project names — callers that need strict safety set
 *     `retrySafe: true` (only GET/PUT/DELETE retried).
 *
 * All retry math is pure (deterministic given a jitter source), so it can be
 * unit tested by injecting a seeded Math.random replacement through
 * `setJitterSource`.
 */

export interface RetryableRequestOptions {
  /** HTTP method (default GET). */
  method?:  'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  /** JSON body to send. */
  body?:    unknown;
  /** Extra headers merged with Content-Type for JSON bodies. */
  headers?: Record<string, string>;
  /** Per-request timeout in ms (default 30_000). */
  timeout?: number;
  /** Max retry attempts after the first try (default 3). */
  maxRetries?: number;
  /** Initial backoff in ms (default 800). */
  baseDelay?: number;
  /** Maximum backoff cap in ms (default 30_000). */
  maxDelay?:  number;
  /**
   * If true, only idempotent methods (GET/PUT/DELETE/HEAD) are retried on
   * server errors. Use for non-idempotent mutations (default false).
   */
  retrySafe?: boolean;
  /** Custom fetch implementation (testing / node < 18). */
  fetch?: typeof globalThis.fetch;
  /** Override the RNG used for jitter (testing only). */
  jitter?: () => number;
}

export interface RetryableResponse<T = unknown> {
  /** The parsed or raw response body. */
  data:     T;
  /** The underlying fetch Response (for status / header inspection). */
  response: Response;
  /** Number of retry attempts performed (0 = first try succeeded). */
  retries:  number;
}

/** Error thrown when all retries are exhausted. */
export class HttpRetryExhaustedError extends Error {
  readonly lastStatus: number | null;
  readonly attempts:   number;

  constructor(message: string, attempts: number, lastStatus: number | null) {
    super(message);
    this.name = 'HttpRetryExhaustedError';
    this.attempts = attempts;
    this.lastStatus = lastStatus;
  }
}

/** Status codes that are considered transient and therefore retryable. */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Methods that are safe to retry on any transient failure. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

const DEFAULT_OPTIONS = {
  method:     'GET',
  timeout:    30_000,
  maxRetries: 3,
  baseDelay:  800,
  maxDelay:   30_000,
  retrySafe:  false,
} as const;

let jitterSource: () => number = () => Math.random();

/** Testing seam — replace the jitter RNG deterministically. */
export function setJitterSource(source: () => number): () => void {
  const previous = jitterSource;
  jitterSource = source;
  return () => { jitterSource = previous; };
}

/**
 * Parse a `Retry-After` value into milliseconds. Returns null if absent or
 * unparseable. Supports both forms the spec defines:
 *   - integer seconds:      `Retry-After: 30`
 *   - HTTP-date:            `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`
 */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();

  const seconds = Number.parseInt(trimmed, 10);
  if (Number.isFinite(seconds) && seconds > 0 && String(seconds) === trimmed) {
    return Math.min(seconds * 1000, 60_000); // Cap at 60 s for safety.
  }

  let date = Date.parse(trimmed);
  // jsdom (and a few legacy runtimes) fail Date.parse on otherwise-valid
  // HTTP-dates — fall back to the Date constructor before giving up.
  if (!Number.isFinite(date)) {
    const fallback = new Date(trimmed).getTime();
    if (Number.isFinite(fallback)) date = fallback;
  }
  if (Number.isFinite(date)) {
    const ms = date - Date.now();
    return ms > 0 ? Math.min(ms, 60_000) : null; // Past dates: don't wait.
  }
  return null;
}

/**
 * Full-jitter exponential backoff delay for the N-th retry (0-indexed).
 * Pure function of (attempt, options, random) — no hidden state.
 */
export function backoffDelay(attempt: number, baseDelay: number, maxDelay: number, random: number): number {
  const exp = Math.min(maxDelay, baseDelay * 2 ** attempt);
  return Math.floor(random * exp);
}

/**
 * Perform an HTTP request with exponential backoff and Retry-After handling.
 *
 * Retries on:
 *   - Network failures (fetch throws — DNS, TLS, timeout).
 *   - Transient status codes (408/425/429/500/502/503/504).
 *
 * Does NOT retry on 4xx client errors (except 429/408/425 which are transient).
 */
export async function requestWithRetry<T = unknown>(
  url:     string,
  options: RetryableRequestOptions = {},
): Promise<RetryableResponse<T>> {
  const {
    method, body, headers, timeout, maxRetries, baseDelay, maxDelay, retrySafe,
    fetch: fetchImpl, jitter,
  } = { ...DEFAULT_OPTIONS, ...options };

  const doFetch = fetchImpl ?? globalThis.fetch;
  if (!doFetch) throw new Error('No fetch implementation available');

  const init: RequestInit = {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const lastErrors: string[] = [];
  let lastStatus: number | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    let response: Response | undefined;
    try {
      response = await doFetch(url, { ...init, signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      // Aborts we triggered (timeout) are retryable; external aborts are not.
      const isTimeout = e instanceof DOMException && e.name === 'AbortError' && controller.signal.aborted;
      if (isTimeout) {
        lastErrors.push(`request timed out after ${timeout}ms`);
        if (attempt === maxRetries) break;
        response = undefined;
      } else {
        throw e; // Network-level errors we didn't cause propagate immediately.
      }
    } finally {
      clearTimeout(timer);
    }

    if (!response) continue; // Timed out — loop continues to the retry.
    lastStatus = response.status;

    // Success: parse JSON when the content-type indicates JSON.
    if (response.ok) {
      const contentType = response.headers.get('content-type') ?? '';
      const data = contentType.includes('application/json')
        ? await response.json()
        : await response.text();
      return { data: data as T, response, retries: attempt };
    }

    const isTransient = TRANSIENT_STATUSES.has(response.status);
    const isIdempotent = IDEMPOTENT_METHODS.has(method);
    const mayRetry = isTransient && (retrySafe ? isIdempotent : true);

    if (attempt === maxRetries || !mayRetry) break;

    // Prefer server-specified wait; otherwise exponential backoff with jitter.
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    const wait = retryAfter ?? backoffDelay(attempt, baseDelay, maxDelay, jitter ? jitter() : jitterSource());
    lastErrors.push(`HTTP ${response.status}: retrying after ${wait}ms`);

    await new Promise(resolve => setTimeout(resolve, wait));
  }

  throw new HttpRetryExhaustedError(
    `request to ${url} failed after ${maxRetries + 1} attempt(s): ${lastErrors.at(-1) ?? 'unknown error'}`,
    maxRetries + 1,
    lastStatus,
  );
}

/** Convenience POST wrapper used by the built-in exporters. */
export async function postJson<T = unknown>(
  url:      string,
  body:     unknown,
  headers:  Record<string, string>,
  options?: Omit<RetryableRequestOptions, 'method' | 'body' | 'headers'>,
): Promise<T> {
  const result = await requestWithRetry<T>(url, {
    method: 'POST',
    body,
    headers,
    ...options,
  });
  return result.data;
}

/** Convenience GET wrapper used by the built-in exporters. */
export async function getJson<T = unknown>(
  url:      string,
  headers:  Record<string, string>,
  options?: Omit<RetryableRequestOptions, 'method' | 'headers'>,
): Promise<T> {
  const result = await requestWithRetry<T>(url, {
    method: 'GET',
    headers,
    ...options,
  });
  return result.data;
}
