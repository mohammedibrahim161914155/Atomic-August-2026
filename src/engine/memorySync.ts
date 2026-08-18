/**
 * src/engine/memorySync.ts
 *
 * Decision Memory Hygiene — two Codex/Kilo lessons combined:
 *
 *   1. Decision-conflict detection (Kilo pattern). The session store now keeps
 *      structured decisions keyed by (domain, key). Two agents disagreeing on
 *      the same key used to be last-writer-wins — silently corrupting the
 *      session's decision record. Now: writing a conflicting value emits
 *      memory.conflict_detected, preserves the existing value under a
 *      suffixed key (history intact), and installs the newer value as the
 *      active decision. See agentMemory.recordStructuredDecision().
 *   2. Long-term memory sync (Codex durable-project-memory pattern).
 *      High-value session decisions (importance high/critical) are synced
 *      into the persistent long-term memory store at run end so subsequent
 *      sessions inherit institutional knowledge — Artemis and Curator read
 *      this store.
 *
 * Pure logic + a thin sync helper.
 */

import { agentMemory, type AgentDecision } from './agentMemory';
import { rememberFact, type MemoryImportance } from './agentLongTermMemory';

// ── Conflict detection helpers (pure) ──────────────────────────────────────────

export interface DecisionConflict {
  /** (domain, key) pair where the conflict occurred. */
  domain: string;
  key: string;
  /** The value that was already stored. */
  existing: string;
  /** The conflicting incoming value. */
  incoming: string;
  /** Source agent of the incoming decision. */
  sourceAgent: string;
}

/**
 * Check whether a new decision conflicts with existing decisions in memory.
 * A conflict means the SAME (domain, key) already has a decision whose
 * normalized value differs from the incoming one.
 */
export function detectDecisionConflict(
  sessionId: string,
  decision: AgentDecision,
): DecisionConflict | null {
  const mem = agentMemory.readStructuredDecisions(sessionId, decision.domain);
  const existing = mem.decisions.find(d => d.key === decision.key);
  if (!existing) return null;
  if (normalizeDecisionValue(existing.value) === normalizeDecisionValue(decision.value)) {
    return null;
  }
  return {
    domain: decision.domain,
    key: decision.key,
    existing: existing.value,
    incoming: decision.value,
    sourceAgent: decision.sourceAgent,
  };
}

/** Normalize a decision value for conflict comparison. */
export function normalizeDecisionValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim();
}

/** Conflict-safe decision key suffix. */
export function conflictKey(key: string, conflictIndex: number): string {
  return `${key}@conflict:${conflictIndex}`;
}

// ── Long-term memory sync ───────────────────────────────────────────────────────

export interface SyncReport {
  synced: number;
  skipped: number;
  errors: number;
}

/**
 * Sync high-value session decisions into the persistent long-term memory
 * store so institutional knowledge survives restarts. Rules:
 *   - Only decisions with importance 'high' or 'critical' sync.
 *   - Values are truncated to 2000 chars to protect the store from huge
 *     blobs while preserving substance.
 *   - Failures are counted, never thrown — sync is best-effort.
 */
export function syncSessionDecisionsToLongTermMemory(sessionId: string): SyncReport {
  const report: SyncReport = { synced: 0, skipped: 0, errors: 0 };
  const domain = agentMemory.getSessionDomain(sessionId);
  if (!domain) return { synced: 0, skipped: 0, errors: 0 };

  const mem = agentMemory.readStructuredDecisions(sessionId);
  for (const d of mem.decisions) {
    if (d.importance !== 'high' && d.importance !== 'critical') {
      report.skipped += 1;
      continue;
    }
    // Skip history-preserved conflict copies — only the active value syncs.
    if (/@conflict:\d+$/.test(d.key)) {
      report.skipped += 1;
      continue;
    }
    try {
      const importance: MemoryImportance =
        d.importance === 'critical' ? 'critical' : 'high';
      rememberFact(
        domain,
        d.key,
        d.value.slice(0, 2000),
        d.sourceAgent,
        importance,
        ['synced-from-session'],
      );
      report.synced += 1;
    } catch {
      report.errors += 1;
    }
  }
  return report;
}
