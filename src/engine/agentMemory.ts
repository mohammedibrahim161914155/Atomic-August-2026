/**
 * src/engine/agentMemory.ts
 *
 * Session-scoped in-process memory store for agent coordination.
 * Agents within the same generation can read/write shared state
 * without needing external storage, enabling genuine cross-agent coordination.
 *
 * Architecture note — why in-process is correct here:
 *   Each blueprint generation is tied to a single SSE connection and runs
 *   entirely within one Node.js process (pillars run via Promise.all, not
 *   distributed across replicas). The store is keyed by sessionId and cleaned
 *   up after generation completes, so there is no cross-session contamination.
 *   If the engine is ever extended to distribute pillar work across replicas,
 *   this store should be backed by the Redis KV store (src/engine/store.ts).
 *
 * Safety guards:
 *   - MAX_SESSIONS cap: evicts the oldest sessions when the limit is reached,
 *     preventing unbounded memory growth if cleanup() is not called (e.g., on
 *     server crash mid-generation).
 *   - Per-session decision cap (MAX_DECISIONS_PER_SESSION): prevents a runaway
 *     agent from writing an unbounded number of entries in a single session.
 *
 * Uses AsyncLocalStorage so the sessionId flows down the call stack
 * without polluting every function signature.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { log } from './logger';

// ── Session ID propagation ────────────────────────────────────────────────────
// Set this in generateBlueprint so all agent tool calls can read the sessionId.
export const sessionIdStorage = new AsyncLocalStorage<string>();

// ── Limits ────────────────────────────────────────────────────────────────────

/** Maximum number of live sessions held in memory at once. */
const MAX_SESSIONS = 200;

/** Maximum number of decision entries per session. Prevents runaway agents. */
const MAX_DECISIONS_PER_SESSION = 500;

// ── Memory entry ──────────────────────────────────────────────────────────────

export interface MemoryEntry {
  key:    string;
  value:  string;
  agent:  string;
  pillar: string;
  ts:     number;
}

export interface ConcernEntry {
  description:     string;
  severity:        'critical' | 'high' | 'medium' | 'low';
  affects_pillars: string[];
  agent:           string;
  pillar:          string;
  ts:              number;
}

// ── Memory store ──────────────────────────────────────────────────────────────

class AgentMemoryStore {
  /** Ordered insertion map — iteration order is insertion order (ES2015+). */
  private decisions = new Map<string, MemoryEntry[]>();
  private concerns  = new Map<string, ConcernEntry[]>();

  // ── Decisions ─────────────────────────────────────────────────────────────

  writeDecision(
    sessionId: string,
    pillar:    string,
    agent:     string,
    key:       string,
    value:     string,
  ): void {
    this.evictIfNeeded();
    const entries = this.decisions.get(sessionId) ?? [];
    const norm    = `${pillar}:${key}`;
    const idx     = entries.findIndex(e => `${e.pillar}:${e.key}` === norm);
    const entry: MemoryEntry = { key, value, agent, pillar, ts: Date.now() };

    if (idx >= 0) {
      entries[idx] = entry;
    } else {
      if (entries.length >= MAX_DECISIONS_PER_SESSION) {
        log.warn(
          { sessionId, limit: MAX_DECISIONS_PER_SESSION },
          '[memory] session decision cap reached — oldest entry evicted'
        );
        entries.shift();
      }
      entries.push(entry);
    }
    this.decisions.set(sessionId, entries);
    log.debug({ sessionId, pillar, agent, key }, '[memory] decision written');
  }

  readDecisions(
    sessionId: string,
    pillar?:   string,  // undefined or '*' = all pillars
    key?:      string,
  ): MemoryEntry[] {
    const all = this.decisions.get(sessionId) ?? [];
    return all.filter(e =>
      (!pillar || pillar === '*' || e.pillar === pillar) &&
      (!key    || e.key === key)
    );
  }

  // ── Concerns ──────────────────────────────────────────────────────────────

  flagConcern(
    sessionId:       string,
    pillar:          string,
    agent:           string,
    description:     string,
    severity:        ConcernEntry['severity'],
    affects_pillars: string[],
  ): void {
    this.evictIfNeeded();
    const entries = this.concerns.get(sessionId) ?? [];
    entries.push({ description, severity, affects_pillars, agent, pillar, ts: Date.now() });
    this.concerns.set(sessionId, entries);
    log.debug({ sessionId, pillar, agent, severity }, '[memory] concern flagged');
  }

  readConcerns(sessionId: string, pillar?: string): ConcernEntry[] {
    const all = this.concerns.get(sessionId) ?? [];
    return pillar ? all.filter(e => e.pillar === pillar || affectsPillar(e, pillar)) : all;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  cleanup(sessionId: string): void {
    const hadDecisions = this.decisions.delete(sessionId);
    const hadConcerns  = this.concerns.delete(sessionId);
    if (hadDecisions || hadConcerns) {
      log.debug({ sessionId }, '[memory] session cleaned up');
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Evict the oldest session if we are at the MAX_SESSIONS cap.
   * Map iteration is insertion-order, so `.keys().next()` gives the oldest.
   */
  private evictIfNeeded(): void {
    if (this.decisions.size < MAX_SESSIONS) return;
    const oldest = this.decisions.keys().next().value;
    if (oldest) {
      this.decisions.delete(oldest);
      this.concerns.delete(oldest);
      log.warn(
        { evictedSession: oldest, limit: MAX_SESSIONS },
        '[memory] session evicted from memory — MAX_SESSIONS cap reached'
      );
    }
  }
}

function affectsPillar(e: ConcernEntry, pillar: string): boolean {
  return e.affects_pillars.some(p => p.toLowerCase() === pillar.toLowerCase());
}

export const agentMemory = new AgentMemoryStore();

// ── Convenience helpers ───────────────────────────────────────────────────────

export function formatMemoryForContext(sessionId: string): string {
  const decisions = agentMemory.readDecisions(sessionId);
  if (decisions.length === 0) return '';
  const grouped = decisions.reduce<Record<string, MemoryEntry[]>>((acc, e) => {
    (acc[e.pillar] ??= []).push(e);
    return acc;
  }, {});
  const lines = Object.entries(grouped).map(([pillar, entries]) =>
    `[${pillar}] ${entries.map(e => `${e.key}: ${e.value.substring(0, 120)}`).join(' | ')}`
  );
  return `Shared architectural decisions so far:\n${lines.join('\n')}`;
}
