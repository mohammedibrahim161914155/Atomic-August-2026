/**
 * src/engine/rateLimitManager.ts
 *
 * Rate Limit & Request Queue Manager — §2.4 of the v4 spec.
 *
 * All LLM requests from all parallel pillar sub-agents are routed through this
 * manager. No agent calls the LLM client directly without going through this layer.
 *
 * Design:
 *   - Priority queue: higher-priority requests (governor, synthesizer) pre-empt lower
 *   - Concurrency cap: configurable MAX_CONCURRENT (default 5)
 *   - Exponential backoff on 429 / rate limit responses
 *   - Event bus integration: rate_limit.hit / rate_limit.queued / rate_limit.cleared
 *   - Full observability: queue depth, estimated wait time, per-agent metrics
 */

import { randomUUID } from 'crypto';
import { publishEvent } from './eventBus';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RequestPriority = 'critical' | 'high' | 'normal' | 'low';

const PRIORITY_WEIGHTS: Record<RequestPriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

export interface QueuedRequest<T = unknown> {
  id: string;
  agentId: string;
  sessionId: string;
  priority: RequestPriority;
  fn: () => Promise<T>;
  enqueuedAt: number;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export interface RateLimitManagerConfig {
  maxConcurrent: number;
  /** Base delay in ms for exponential backoff on rate limit hit */
  baseBackoffMs: number;
  /** Maximum backoff delay cap in ms */
  maxBackoffMs: number;
}

const DEFAULT_CONFIG: RateLimitManagerConfig = {
  maxConcurrent: 5,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
};

// ── Queue metrics ─────────────────────────────────────────────────────────────

export interface QueueMetrics {
  queueDepth: number;
  activeRequests: number;
  totalProcessed: number;
  totalRateLimitHits: number;
  estimatedWaitMs: number;
  /** Average processing time of last 20 requests, in ms */
  avgProcessingMs: number;
}

// ── Rate Limit Manager ─────────────────────────────────────────────────────────

class RateLimitManagerImpl {
  private readonly config: RateLimitManagerConfig;
  private readonly queue: Array<QueuedRequest<unknown>> = [];
  private activeCount = 0;
  private totalProcessed = 0;
  private totalRateLimitHits = 0;
  private backoffMs = 0;
  private backoffUntil = 0;
  private readonly processingTimes: number[] = [];

  constructor(config: Partial<RateLimitManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Enqueue an LLM request for execution.
   * Returns a Promise that resolves when the request completes.
   */
  enqueue<T>(
    agentId: string,
    sessionId: string,
    fn: () => Promise<T>,
    priority: RequestPriority = 'normal',
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID();
      const entry: QueuedRequest<T> = {
        id,
        agentId,
        sessionId,
        priority,
        fn,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      };

      publishEvent('rate_limit.queued', sessionId, id, {
        agentId,
        priority,
        queueDepth: this.queue.length + 1,
      });

      // Insert in priority order (highest first, FIFO within same priority)
      const insertIdx = this.queue.findIndex(
        q => PRIORITY_WEIGHTS[q.priority] < PRIORITY_WEIGHTS[priority]
      );
      if (insertIdx === -1) {
        this.queue.push(entry as QueuedRequest<unknown>);
      } else {
        this.queue.splice(insertIdx, 0, entry as QueuedRequest<unknown>);
      }

      this.drain();
    });
  }

  private drain(): void {
    // Wait for backoff to clear
    const now = Date.now();
    if (now < this.backoffUntil) {
      const delay = this.backoffUntil - now;
      setTimeout(() => this.drain(), delay);
      return;
    }

    while (this.activeCount < this.config.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.activeCount++;
      const startTime = Date.now();

      entry.fn().then(
        (value) => {
          this.activeCount--;
          this.totalProcessed++;
          const elapsed = Date.now() - startTime;
          this.processingTimes.push(elapsed);
          if (this.processingTimes.length > 20) this.processingTimes.shift();

          // Reset backoff on success
          this.backoffMs = 0;

          publishEvent('rate_limit.cleared', entry.sessionId, entry.id, {
            agentId: entry.agentId,
            processingMs: elapsed,
          });

          (entry.resolve as (v: unknown) => void)(value);
          this.drain();
        },
        (err: unknown) => {
          this.activeCount--;

          const isRateLimit = this.isRateLimitError(err);
          if (isRateLimit) {
            // Exponential backoff
            this.totalRateLimitHits++;
            this.backoffMs = Math.min(
              this.backoffMs === 0 ? this.config.baseBackoffMs : this.backoffMs * 2,
              this.config.maxBackoffMs,
            );
            this.backoffUntil = Date.now() + this.backoffMs;

            publishEvent('rate_limit.hit', entry.sessionId, entry.id, {
              agentId: entry.agentId,
              backoffMs: this.backoffMs,
              totalHits: this.totalRateLimitHits,
            });

            // Re-queue with same priority (at front) after backoff
            setTimeout(() => {
              this.queue.unshift(entry);
              this.drain();
            }, this.backoffMs);
          } else {
            (entry.reject as (r: unknown) => void)(err);
            this.drain();
          }
        }
      ).catch((err: unknown) => {
        this.activeCount--;
        (entry.reject as (r: unknown) => void)(err);
        this.drain();
      });
    }
  }

  private isRateLimitError(err: unknown): boolean {
    if (!err) return false;
    if (typeof err === 'object') {
      const e = err as Record<string, unknown>;
      if (e['status'] === 429 || e['statusCode'] === 429) return true;
      if (typeof e['message'] === 'string') {
        const msg = e['message'].toLowerCase();
        if (msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('quota')) {
          return true;
        }
      }
    }
    return false;
  }

  getMetrics(): QueueMetrics {
    const avgProcessingMs =
      this.processingTimes.length === 0
        ? 0
        : Math.round(this.processingTimes.reduce((a, b) => a + b, 0) / this.processingTimes.length);

    const estimatedWaitMs =
      this.queue.length === 0
        ? 0
        : Math.max(
            (this.backoffUntil > Date.now() ? this.backoffUntil - Date.now() : 0) +
            Math.ceil(this.queue.length / this.config.maxConcurrent) * avgProcessingMs,
            0,
          );

    return {
      queueDepth: this.queue.length,
      activeRequests: this.activeCount,
      totalProcessed: this.totalProcessed,
      totalRateLimitHits: this.totalRateLimitHits,
      estimatedWaitMs,
      avgProcessingMs,
    };
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  getEstimatedWaitMs(): number {
    return this.getMetrics().estimatedWaitMs;
  }

  /** Clear pending queue for a specific session (used on cancel/terminate) */
  cancelSession(sessionId: string): number {
    const before = this.queue.length;
    const toCancel = this.queue.filter(q => q.sessionId === sessionId);
    toCancel.forEach(q => {
      const idx = this.queue.indexOf(q);
      if (idx !== -1) this.queue.splice(idx, 1);
      (q.reject as (r: unknown) => void)(new Error('Session cancelled'));
    });
    return before - this.queue.length;
  }
}

// ── Singleton export ───────────────────────────────────────────────────────────

export const rateLimitManager = new RateLimitManagerImpl();

export { RateLimitManagerImpl };
