/**
 * src/engine/withRetry.ts
 *
 * Enterprise-grade retry loop with:
 *   - Per-error-category retry budgets and backoff curves
 *   - Exponential backoff with configurable jitter (prevents thundering herd)
 *   - AbortSignal-aware sleep (exits immediately on abort without waiting)
 *   - Structured logging on each retry and final exhaustion
 */

import { log as rootLog } from './logger';

// ── Error taxonomy ────────────────────────────────────────────────────────────

export type ErrorCategory =
  | 'rate_limit'      // 429 — back off and retry
  | 'server_error'    // 5xx — retry with backoff
  | 'timeout'         // network/model timeout — single retry, no delay
  | 'transient'       // unknown/connection drop — retry with backoff
  | 'auth'            // 401/403 — do not retry (key is wrong)
  | 'content_filter'; // content policy — do not retry (prompt is the problem)

export interface RetryConfig {
  readonly maxAttempts:  number;  // total calls including first
  readonly baseDelayMs:  number;  // delay after first failure (ms)
  readonly maxDelayMs:   number;  // cap on delay (ms)
  readonly jitterFactor: number;  // 0–1: fraction of delay added as random noise
}

const RETRY_CONFIGS: Readonly<Record<ErrorCategory, RetryConfig>> = {
  rate_limit:     { maxAttempts: 4, baseDelayMs: 2_000, maxDelayMs: 30_000, jitterFactor: 0.4 },
  server_error:   { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 10_000, jitterFactor: 0.25 },
  timeout:        { maxAttempts: 2, baseDelayMs:     0, maxDelayMs:      0, jitterFactor: 0   },
  transient:      { maxAttempts: 3, baseDelayMs:   500, maxDelayMs:  5_000, jitterFactor: 0.3 },
  auth:           { maxAttempts: 1, baseDelayMs:     0, maxDelayMs:      0, jitterFactor: 0   },
  content_filter: { maxAttempts: 1, baseDelayMs:     0, maxDelayMs:      0, jitterFactor: 0   },
};

// ── Error classification ──────────────────────────────────────────────────────

export function classifyError(err: unknown): ErrorCategory {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  if (/rate.?limit|429|too many requests|quota.?exceeded|ratelimit/i.test(msg))
    return 'rate_limit';
  if (/401|403|forbidden|unauthorized|invalid.?api.?key|invalid.?key|api.?key/i.test(msg))
    return 'auth';
  if (/content.?filter|content.?policy|flagged|safety|moderat|harmful/i.test(msg))
    return 'content_filter';
  if (/timeout|timed.?out|408|etimedout/i.test(msg))
    return 'timeout';
  if (/500|502|503|504|server.?error|bad.?gateway|service.?unavailable/i.test(msg))
    return 'server_error';

  return 'transient';
}

// ── AbortSignal-aware sleep ───────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ── Public retry wrapper ──────────────────────────────────────────────────────

/**
 * Execute `fn` with automatic retry on transient failures.
 *
 * @param fn        Async operation to retry. Receives 0-based attempt number.
 * @param signal    AbortSignal — propagated to sleep; exits the loop immediately.
 * @param label     Diagnostic label emitted with every log line.
 * @param overrides Optional per-call overrides to the default RetryConfig.
 */
export async function withRetry<T>(
  fn:        (attempt: number) => Promise<T>,
  signal?:   AbortSignal,
  label      = 'operation',
  overrides?: Partial<RetryConfig>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    try {
      // Anchor the rejection handler synchronously so that runtimes (and
      // tools like Vitest's promise-rejection hook) never observe an
      // "unhandled rejection" for the fn's promise before the try/catch
      // can attach its await handler.
      const result = fn(attempt);
      result.catch(() => undefined);
      return await result;

    } catch (err: unknown) {
      // Never retry on user-initiated cancellation.
      // Note: if `signal` aborted *during* `fn`, the abort listener on the
      // pending sleep may not have fired yet — check the flag explicitly.
      if (signal?.aborted) {
        throw err instanceof DOMException && err.name === 'AbortError' ? err : new DOMException('Aborted', 'AbortError');
      }
      if (err instanceof DOMException && err.name === 'AbortError') throw err;

      const category = classifyError(err);
      const config: RetryConfig = { ...RETRY_CONFIGS[category], ...overrides };

      if (attempt + 1 >= config.maxAttempts) {
        rootLog.warn(
          { label, attempt, category, maxAttempts: config.maxAttempts },
          '[retry] all attempts exhausted — propagating error',
        );
        throw err;
      }

      // Exponential backoff: base * 2^attempt, capped at max
      const base   = config.baseDelayMs * Math.pow(2, attempt);
      const capped = Math.min(base, config.maxDelayMs);
      const delay  = capped + capped * config.jitterFactor * Math.random();

      rootLog.warn(
        { label, attempt, category, delayMs: Math.round(delay) },
        '[retry] transient failure — retrying after backoff',
      );

      try {
        await sleep(delay, signal);
      } catch (err) {
        // Sleep was interrupted by the abort signal — surface cancellation
        // instead of silently starting another attempt.
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        throw err;
      }
    }
  }
}
