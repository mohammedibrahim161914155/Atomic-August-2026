/**
 * src/engine/observability.ts
 *
 * Observability Layer — structured, queryable telemetry for the Atomic system.
 * Every agent action, tool call, state transition, workspace write, and error
 * emits a structured ObservabilityEntry.
 *
 * In development: entries are logged to the console via pino.
 * Developer panel (accessible in dev mode) can query live traces.
 */

import { randomUUID } from 'crypto';
import { log } from './logger';

// ── Types ──────────────────────────────────────────────────────────────────────

export type ObservabilityLevel = 'debug' | 'info' | 'warn' | 'error';
export type ObservabilityCategory =
  | 'agent'
  | 'tool'
  | 'orchestrator'
  | 'workspace'
  | 'ui'
  | 'system'
  | 'artemis'
  | 'curator'
  | 'skills'
  | 'event_bus';

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
}

export interface ObservabilityEntry {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly timestamp: string;
  readonly level: ObservabilityLevel;
  readonly category: ObservabilityCategory;
  readonly agentId?: string;
  readonly pillarId?: string;
  readonly sessionId: string;
  readonly event: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly durationMs?: number;
  readonly tokenCount?: number;
  readonly model?: string;
  readonly error?: SerializedError;
}

export interface ObservabilitySpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly sessionId: string;
  readonly category: ObservabilityCategory;
  readonly agentId?: string;
  readonly pillarId?: string;
  readonly startedAt: number;
  finish(
    event: string,
    data?: Record<string, unknown>,
    overrides?: {
      level?: ObservabilityLevel;
      tokenCount?: number;
      model?: string;
      error?: unknown;
    }
  ): ObservabilityEntry;
}

// ── In-memory trace store ─────────────────────────────────────────────────────

const MAX_ENTRIES = 5000;
const entries: ObservabilityEntry[] = [];

function appendEntry(entry: ObservabilityEntry): void {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
}

// ── Serialize error safely ────────────────────────────────────────────────────

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
      code: (err as Error & { code?: string | number }).code,
    };
  }
  return { name: 'UnknownError', message: String(err) };
}

// ── Span implementation ───────────────────────────────────────────────────────

class ObservabilitySpanImpl implements ObservabilitySpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly sessionId: string;
  readonly category: ObservabilityCategory;
  readonly agentId?: string;
  readonly pillarId?: string;
  readonly startedAt: number;

  constructor(opts: {
    traceId: string;
    parentSpanId?: string;
    sessionId: string;
    category: ObservabilityCategory;
    agentId?: string;
    pillarId?: string;
  }) {
    this.traceId = opts.traceId;
    this.spanId = randomUUID();
    this.parentSpanId = opts.parentSpanId;
    this.sessionId = opts.sessionId;
    this.category = opts.category;
    this.agentId = opts.agentId;
    this.pillarId = opts.pillarId;
    this.startedAt = Date.now();
  }

  finish(
    event: string,
    data: Record<string, unknown> = {},
    overrides: {
      level?: ObservabilityLevel;
      tokenCount?: number;
      model?: string;
      error?: unknown;
    } = {}
  ): ObservabilityEntry {
    const durationMs = Date.now() - this.startedAt;
    const level = overrides.level ?? (overrides.error ? 'error' : 'info');

    const entry: ObservabilityEntry = {
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      timestamp: new Date().toISOString(),
      level,
      category: this.category,
      agentId: this.agentId,
      pillarId: this.pillarId,
      sessionId: this.sessionId,
      event,
      data,
      durationMs,
      tokenCount: overrides.tokenCount,
      model: overrides.model,
      error: overrides.error !== undefined ? serializeError(overrides.error) : undefined,
    };

    appendEntry(entry);

    // Mirror to pino logger
    const logData = {
      traceId: entry.traceId,
      spanId: entry.spanId,
      sessionId: entry.sessionId,
      durationMs,
      ...(entry.tokenCount !== undefined && { tokenCount: entry.tokenCount }),
      ...(entry.model && { model: entry.model }),
      ...(entry.error && { error: entry.error }),
      ...data,
    };

    switch (level) {
      case 'debug': log.debug(logData, `[obs:${this.category}] ${event}`); break;
      case 'info':  log.info(logData,  `[obs:${this.category}] ${event}`); break;
      case 'warn':  log.warn(logData,  `[obs:${this.category}] ${event}`); break;
      case 'error': log.error(logData, `[obs:${this.category}] ${event}`); break;
    }

    return entry;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startSpan(opts: {
  traceId: string;
  parentSpanId?: string;
  sessionId: string;
  category: ObservabilityCategory;
  agentId?: string;
  pillarId?: string;
}): ObservabilitySpan {
  return new ObservabilitySpanImpl(opts);
}

export function recordEvent(
  sessionId: string,
  traceId: string,
  category: ObservabilityCategory,
  level: ObservabilityLevel,
  event: string,
  data: Record<string, unknown> = {},
  opts: { agentId?: string; pillarId?: string; error?: unknown } = {}
): ObservabilityEntry {
  const span = startSpan({ traceId, sessionId, category, agentId: opts.agentId, pillarId: opts.pillarId });
  return span.finish(event, data, { level, error: opts.error });
}

export function getTraces(filter?: {
  sessionId?: string;
  traceId?: string;
  category?: ObservabilityCategory;
  level?: ObservabilityLevel;
  since?: string;
  limit?: number;
}): ObservabilityEntry[] {
  let results = [...entries];

  if (filter?.sessionId) results = results.filter(e => e.sessionId === filter.sessionId);
  if (filter?.traceId)   results = results.filter(e => e.traceId === filter.traceId);
  if (filter?.category)  results = results.filter(e => e.category === filter.category);
  if (filter?.level)     results = results.filter(e => e.level === filter.level);
  if (filter?.since) {
    const since = new Date(filter.since).getTime();
    results = results.filter(e => new Date(e.timestamp).getTime() >= since);
  }

  const limit = filter?.limit ?? 500;
  return results.slice(-limit);
}

export function getSessionMetrics(sessionId: string): {
  totalSpans: number;
  errorCount: number;
  totalTokens: number;
  totalDurationMs: number;
  byCategory: Record<string, number>;
} {
  const sessionEntries = entries.filter(e => e.sessionId === sessionId);
  const byCategory: Record<string, number> = {};

  let errorCount = 0;
  let totalTokens = 0;
  let totalDurationMs = 0;

  for (const e of sessionEntries) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    if (e.level === 'error') errorCount++;
    if (e.tokenCount) totalTokens += e.tokenCount;
    if (e.durationMs) totalDurationMs += e.durationMs;
  }

  return {
    totalSpans: sessionEntries.length,
    errorCount,
    totalTokens,
    totalDurationMs,
    byCategory,
  };
}
