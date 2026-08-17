/**
 * src/engine/providerHealthMonitor.ts
 *
 * Provider Health Scoring & Smart Routing (Part 8.2 — Addition 6).
 *
 * Tracks per-model:
 *   - P50/P95 latency over the last 100 calls (rolling window)
 *   - Error rate (5xx, timeout, rate-limit) per model per hour
 *   - Output quality score (from Prosecutor evaluations)
 *
 * The Governor uses this to route pillars to the best-performing model
 * at dispatch time, not just any available model.
 *
 * Uses in-process storage (Map) — correct for single-replica deployments.
 * For multi-replica deployments, extend to use the Redis store.
 */

export type ModelHealth = 'healthy' | 'degraded' | 'unavailable';

interface LatencyWindow {
  samples: number[];   // last N call durations in ms
  maxSize: number;
}

interface ErrorBucket {
  counts: number[];    // errors per 5-minute bucket (last 12 = 1 hour)
  timestamps: number[]; // bucket start times
}

interface QualityRecord {
  scores: number[];    // last 20 prosecutor quality scores (0-100)
}

interface ModelMetrics {
  latency: LatencyWindow;
  errors: ErrorBucket;
  quality: QualityRecord;
  consecutiveFailures: number;
  lastHealthChange: number;
  probeInFlight: boolean;
}

const WINDOW_SIZE = 100;
const ERROR_BUCKET_COUNT = 12;
const BUCKET_SIZE_MS = 5 * 60 * 1000; // 5 minutes
const QUALITY_WINDOW = 20;
const DEGRADED_ERROR_RATE_THRESHOLD = 0.15;  // 15% error rate → degraded
const UNAVAILABLE_ERROR_RATE_THRESHOLD = 0.40; // 40% error rate → unavailable
const DEGRADED_P95_THRESHOLD_MS = 30_000;     // 30s p95 → degraded
const CONSECUTIVE_FAILURE_THRESHOLD = 3;      // 3 consecutive failures → unavailable

class ProviderHealthMonitor {
  private metrics = new Map<string, ModelMetrics>();
  private listeners: Array<(modelId: string, health: ModelHealth) => void> = [];

  private getOrCreate(modelId: string): ModelMetrics {
    let m = this.metrics.get(modelId);
    if (!m) {
      m = {
        latency: { samples: [], maxSize: WINDOW_SIZE },
        errors: { counts: new Array(ERROR_BUCKET_COUNT).fill(0), timestamps: [] },
        quality: { scores: [] },
        consecutiveFailures: 0,
        lastHealthChange: Date.now(),
        probeInFlight: false,
      };
      this.metrics.set(modelId, m);
    }
    return m;
  }

  /** Record a successful LLM call. Call this after every generation completes. */
  recordSuccess(modelId: string, durationMs: number): void {
    const m = this.getOrCreate(modelId);

    // Latency
    m.latency.samples.push(durationMs);
    if (m.latency.samples.length > m.latency.maxSize) {
      m.latency.samples.shift();
    }

    // Reset consecutive failures
    m.consecutiveFailures = 0;

    this.recomputeHealth(modelId);
  }

  /** Record a failed LLM call (5xx, timeout, rate-limit, etc.). */
  recordError(modelId: string, _errorType: 'server_error' | 'timeout' | 'rate_limit' | 'auth' | 'unknown'): void {
    const m = this.getOrCreate(modelId);

    // Add to the current error bucket
    const now = Date.now();
    const bucketIdx = this.getCurrentBucketIdx(now);
    this.rotateBuckets(m, now);
    m.errors.counts[bucketIdx] = (m.errors.counts[bucketIdx] ?? 0) + 1;

    m.consecutiveFailures++;

    this.recomputeHealth(modelId);
  }

  /** Record a quality score from the Prosecutor (0-100). */
  recordQualityScore(modelId: string, score: number): void {
    const m = this.getOrCreate(modelId);
    m.quality.scores.push(Math.max(0, Math.min(100, score)));
    if (m.quality.scores.length > QUALITY_WINDOW) {
      m.quality.scores.shift();
    }
  }

  /** Get current health status for a model. */
  getHealth(modelId: string): ModelHealth {
    const m = this.metrics.get(modelId);
    if (!m) return 'healthy'; // unknown = optimistically healthy

    if (m.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) return 'unavailable';

    const errRate = this.getErrorRate(m);
    if (errRate >= UNAVAILABLE_ERROR_RATE_THRESHOLD) return 'unavailable';
    if (errRate >= DEGRADED_ERROR_RATE_THRESHOLD) return 'degraded';

    const p95 = this.getP95(m.latency.samples);
    if (p95 >= DEGRADED_P95_THRESHOLD_MS) return 'degraded';

    return 'healthy';
  }

  /** Get summary metrics for a model (for cost dashboard / observability). */
  getMetricsSummary(modelId: string): {
    health: ModelHealth;
    p50Ms: number;
    p95Ms: number;
    errorRate: number;
    avgQualityScore: number;
    sampleCount: number;
    consecutiveFailures: number;
  } {
    const m = this.metrics.get(modelId);
    if (!m) {
      return { health: 'healthy', p50Ms: 0, p95Ms: 0, errorRate: 0, avgQualityScore: 0, sampleCount: 0, consecutiveFailures: 0 };
    }

    const samples = m.latency.samples;
    return {
      health: this.getHealth(modelId),
      p50Ms: this.getPercentile(samples, 50),
      p95Ms: this.getPercentile(samples, 95),
      errorRate: this.getErrorRate(m),
      avgQualityScore: m.quality.scores.length > 0
        ? m.quality.scores.reduce((a, b) => a + b, 0) / m.quality.scores.length
        : 0,
      sampleCount: samples.length,
      consecutiveFailures: m.consecutiveFailures,
    };
  }

  /** Get all monitored models and their health. */
  getAllHealthStatuses(): Record<string, { health: ModelHealth; p95Ms: number; errorRate: number }> {
    const result: Record<string, { health: ModelHealth; p95Ms: number; errorRate: number }> = {};
    for (const [modelId, m] of this.metrics) {
      result[modelId] = {
        health: this.getHealth(modelId),
        p95Ms: this.getP95(m.latency.samples),
        errorRate: this.getErrorRate(m),
      };
    }
    return result;
  }

  /**
   * Select the best available model from a list, preferring healthy over degraded.
   * Falls back to degraded if no healthy models are available.
   */
  selectBestModel(candidates: string[]): string | null {
    if (candidates.length === 0) return null;

    const healthy = candidates.filter(m => this.getHealth(m) === 'healthy');
    const degraded = candidates.filter(m => this.getHealth(m) === 'degraded');

    if (healthy.length > 0) {
      // Among healthy, prefer lowest p95 latency
      return this.lowestLatency(healthy);
    }
    if (degraded.length > 0) {
      return this.lowestLatency(degraded);
    }
    // All unavailable — return first candidate and let it fail naturally
    return candidates[0]!;
  }

  /** Subscribe to health change events. */
  onHealthChange(listener: (modelId: string, health: ModelHealth) => void): void {
    this.listeners.push(listener);
  }

  /** Reset metrics for a model (for testing or manual recovery). */
  reset(modelId: string): void {
    this.metrics.delete(modelId);
  }

  /** Export all raw metrics (for serialization / persistence). */
  exportMetrics(): Record<string, ModelMetrics> {
    return Object.fromEntries(this.metrics);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private recomputeHealth(modelId: string): void {
    const health = this.getHealth(modelId);
    const m = this.metrics.get(modelId);
    if (!m) return;

    // Notify listeners when health status changes (debounce with lastHealthChange)
    const previousHealth = this.getPreviousHealth(m);
    if (previousHealth !== health) {
      m.lastHealthChange = Date.now();
      for (const listener of this.listeners) {
        listener(modelId, health);
      }
    }
  }

  private getPreviousHealth(m: ModelMetrics): ModelHealth {
    // Re-derive health without modifying anything — just for comparison
    if (m.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) return 'unavailable';
    const errRate = this.getErrorRate(m);
    if (errRate >= UNAVAILABLE_ERROR_RATE_THRESHOLD) return 'unavailable';
    if (errRate >= DEGRADED_ERROR_RATE_THRESHOLD) return 'degraded';
    return 'healthy';
  }

  private getErrorRate(m: ModelMetrics): number {
    const recentErrors = m.errors.counts.reduce((a, b) => a + b, 0);
    const recentSuccess = m.latency.samples.length;
    const total = recentErrors + recentSuccess;
    return total === 0 ? 0 : recentErrors / total;
  }

  private getCurrentBucketIdx(now: number): number {
    return Math.floor(now / BUCKET_SIZE_MS) % ERROR_BUCKET_COUNT;
  }

  private rotateBuckets(m: ModelMetrics, now: number): void {
    const currentBucket = Math.floor(now / BUCKET_SIZE_MS);
    const lastBucket = m.errors.timestamps[0] ?? 0;
    const bucketsToReset = Math.min(currentBucket - lastBucket, ERROR_BUCKET_COUNT);

    if (bucketsToReset > 0) {
      for (let i = 0; i < bucketsToReset; i++) {
        const idx = (currentBucket - i) % ERROR_BUCKET_COUNT;
        m.errors.counts[idx] = 0;
      }
      m.errors.timestamps[0] = currentBucket;
    }
  }

  private getPercentile(samples: number[], p: number): number {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)] ?? 0;
  }

  private getP95(samples: number[]): number {
    return this.getPercentile(samples, 95);
  }

  private lowestLatency(models: string[]): string {
    let best = models[0]!;
    let bestP95 = this.getP95(this.getOrCreate(best).latency.samples);

    for (let i = 1; i < models.length; i++) {
      const p95 = this.getP95(this.getOrCreate(models[i]!).latency.samples);
      if (p95 < bestP95) {
        best = models[i]!;
        bestP95 = p95;
      }
    }
    return best;
  }
}

/** Singleton health monitor — shared across the entire process. */
export const healthMonitor = new ProviderHealthMonitor();

/**
 * Wrap an async LLM call with automatic health tracking.
 *
 * Usage:
 *   const result = await trackHealth('openai/gpt-4o', () => generateText(...));
 */
export async function trackHealth<T>(
  modelId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    healthMonitor.recordSuccess(modelId, Date.now() - start);
    return result;
  } catch (err: any) {
    const errType = classifyError(err);
    healthMonitor.recordError(modelId, errType);
    throw err;
  }
}

function classifyError(err: any): 'server_error' | 'timeout' | 'rate_limit' | 'auth' | 'unknown' {
  const msg = (err?.message ?? '').toLowerCase();
  if (msg.includes('429') || msg.includes('rate limit')) return 'rate_limit';
  if (msg.includes('401') || msg.includes('403') || msg.includes('auth')) return 'auth';
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('abort')) return 'timeout';
  if (msg.includes('500') || msg.includes('502') || msg.includes('503')) return 'server_error';
  return 'unknown';
}
