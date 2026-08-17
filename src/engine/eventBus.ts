/**
 * src/engine/eventBus.ts
 *
 * Internal Event Bus — the nervous system of the Atomic application.
 * All inter-component communication flows through here.
 * Direct function calls between major components are prohibited.
 *
 * Design:
 *   - In-process synchronous fan-out to all matching subscribers
 *   - Full event history (capped at MAX_HISTORY) for debugging & replay
 *   - Typed events via discriminated union — no untyped wildcards in production
 *   - Thread-safe (Node.js single-threaded, but async callbacks handled safely)
 */

/**
 * Cross-environment UUID v4 generator.
 *
 * The engine is bundled by Vite for the browser, where the Node `crypto`
 * module is externalised and unavailable. `crypto.randomUUID()` therefore
 * breaks the browser bundle — this helper resolves the correct runtime
 * implementation lazily:
 *   - Browser : Web Crypto API (`crypto.getRandomValues`)
 *   - Node    : `node:crypto.randomUUID()`
 */
let _randomUUID: (() => string) | undefined;

function getRandomUUID(): string {
  if (!_randomUUID) {
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto?.randomUUID) {
      _randomUUID = () => globalThis.crypto.randomUUID();
    } else {
      // Node.js (server side) — require lazily so the browser bundle never
      // pulls in the Node crypto module.
      // Lazy server-side load: the browser bundle must never pull in node:crypto.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodeCrypto = require('node:crypto') as typeof import('crypto');
      _randomUUID = () => nodeCrypto.randomUUID();
    }
  }
  return _randomUUID();
}

// ── Event type registry ────────────────────────────────────────────────────────

export type AtomicEventType =
  | 'session.created'
  | 'session.restored'
  | 'artemis.question_sent'
  | 'artemis.answer_received'
  | 'artemis.brief_completed'
  | 'artemis.brief_approved'
  | 'pipeline.started'
  | 'pipeline.completed'
  | 'pipeline.failed'
  | 'pipeline.cancelled'
  | 'pillar.queued'
  | 'pillar.started'
  | 'pillar.streaming'
  | 'pillar.completed'
  | 'pillar.failed'
  | 'pillar.retrying'
  | 'pillar.improving'
  | 'pillar.improvement_complete'
  | 'pillar.skipped'
  | 'workspace.written'
  | 'workspace.read'
  | 'workspace.validated'
  | 'workspace.validation_failed'
  | 'curator.activated'
  | 'curator.analysis_started'
  | 'curator.report_ready'
  | 'curator.edit_proposed'
  | 'curator.edit_confirmed'
  | 'curator.edit_applied'
  | 'curator.improvement_loop_started'
  | 'curator.improvement_loop_complete'
  | 'blueprint.version_created'
  | 'blueprint.version_restored'
  | 'blueprint.checkpoint_saved'
  | 'agent.tool_call_started'
  | 'agent.tool_call_completed'
  | 'agent.tool_call_failed'
  | 'token.budget_warning'
  | 'token.budget_exhausted'
  | 'rate_limit.hit'
  | 'rate_limit.queued'
  | 'rate_limit.cleared'
  | 'error.agent'
  | 'error.system'
  | 'error.validation'
  | 'skills.applied'
  | 'chat.message_sent'
  | 'chat.response_started'
  | 'chat.response_complete'
  | 'settings.changed'
  | 'project.created'
  | 'project.deleted'
  | 'project.switched'
  | 'skills.custom_registered'
  | 'skills.custom_updated'
  | 'skills.custom_deleted';

// ── Core event shape ───────────────────────────────────────────────────────────

export interface AtomicEvent<T = unknown> {
  readonly id: string;
  readonly type: AtomicEventType;
  readonly timestamp: string;
  readonly traceId: string;
  readonly sessionId: string;
  readonly payload: T;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ── Subscriber types ───────────────────────────────────────────────────────────

export type EventHandler<T = unknown> = (event: AtomicEvent<T>) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface EventBusFilter {
  types?: AtomicEventType[];
  sessionId?: string;
  traceId?: string;
  since?: string; // ISO timestamp
}

// ── Event bus interface ───────────────────────────────────────────────────────

export interface IEventBus {
  publish<T>(event: Omit<AtomicEvent<T>, 'id' | 'timestamp'>): void;
  subscribe<T>(
    type: AtomicEventType | AtomicEventType[],
    handler: EventHandler<T>
  ): Unsubscribe;
  subscribeAll(handler: EventHandler): Unsubscribe;
  getHistory(filter?: EventBusFilter): AtomicEvent[];
  clear(sessionId?: string): void;
}

// ── Implementation ────────────────────────────────────────────────────────────

const MAX_HISTORY = 2000;
const MAX_HANDLERS_PER_TYPE = 200;

interface SubscriptionEntry {
  id: string;
  types: AtomicEventType[] | null; // null = all
  handler: EventHandler;
}

class EventBusImpl implements IEventBus {
  private readonly history: AtomicEvent[] = [];
  private readonly subscriptions: SubscriptionEntry[] = [];

  publish<T>(event: Omit<AtomicEvent<T>, 'id' | 'timestamp'>): void {
    const full: AtomicEvent<T> = {
      ...event,
      id: getRandomUUID(),
      timestamp: new Date().toISOString(),
    };

    // Append to capped history
    this.history.push(full as AtomicEvent);
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }

    // Fan-out to matching subscribers — errors in handlers are caught and logged
    for (const sub of this.subscriptions) {
      if (sub.types === null || sub.types.includes(full.type)) {
        try {
          const result = sub.handler(full as AtomicEvent);
          if (result instanceof Promise) {
            result.catch((err: unknown) => {
              console.error(`[EventBus] async handler error for ${full.type}:`, err);
            });
          }
        } catch (err: unknown) {
          console.error(`[EventBus] sync handler error for ${full.type}:`, err);
        }
      }
    }
  }

  subscribe<T>(
    type: AtomicEventType | AtomicEventType[],
    handler: EventHandler<T>
  ): Unsubscribe {
    const types = Array.isArray(type) ? type : [type];
    const id = getRandomUUID();

    // Guard against subscriber leaks
    const existing = this.subscriptions.filter(
      s => s.types && s.types.some(t => types.includes(t))
    ).length;
    if (existing >= MAX_HANDLERS_PER_TYPE) {
      console.warn(`[EventBus] WARNING: ${existing} handlers for ${types.join(',')} — possible leak`);
    }

    this.subscriptions.push({ id, types, handler: handler as EventHandler });
    return () => {
      const idx = this.subscriptions.findIndex(s => s.id === id);
      if (idx !== -1) this.subscriptions.splice(idx, 1);
    };
  }

  subscribeAll(handler: EventHandler): Unsubscribe {
    const id = getRandomUUID();
    this.subscriptions.push({ id, types: null, handler });
    return () => {
      const idx = this.subscriptions.findIndex(s => s.id === id);
      if (idx !== -1) this.subscriptions.splice(idx, 1);
    };
  }

  getHistory(filter?: EventBusFilter): AtomicEvent[] {
    let results = [...this.history];
    if (filter?.types?.length) {
      results = results.filter(e => filter.types!.includes(e.type));
    }
    if (filter?.sessionId) {
      results = results.filter(e => e.sessionId === filter.sessionId);
    }
    if (filter?.traceId) {
      results = results.filter(e => e.traceId === filter.traceId);
    }
    if (filter?.since) {
      const since = new Date(filter.since).getTime();
      results = results.filter(e => new Date(e.timestamp).getTime() >= since);
    }
    return results;
  }

  clear(sessionId?: string): void {
    if (sessionId) {
      const idx: number[] = [];
      this.history.forEach((e, i) => { if (e.sessionId === sessionId) idx.push(i); });
      for (let i = idx.length - 1; i >= 0; i--) this.history.splice(idx[i]!, 1);
    } else {
      this.history.length = 0;
    }
  }
}

// ── Singleton export ───────────────────────────────────────────────────────────

export const eventBus: IEventBus = new EventBusImpl();

// ── Helper: publish with auto-filled traceId ──────────────────────────────────

export function publishEvent<T>(
  type: AtomicEventType,
  sessionId: string,
  traceId: string,
  payload: T,
  metadata?: Record<string, unknown>
): void {
  eventBus.publish({ type, sessionId, traceId, payload, metadata });
}
