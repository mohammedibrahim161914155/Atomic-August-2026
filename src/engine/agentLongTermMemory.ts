/**
 * src/engine/agentLongTermMemory.ts
 *
 * Cross-session persistent memory for Artemis and Curator agents.
 *
 * Unlike agentMemory.ts (which is in-process and session-scoped),
 * this store survives server restarts and persists architectural learnings
 * across multiple generation sessions.
 *
 * Design:
 *   - SQLite-backed with an in-memory read-cache for hot entries
 *   - Keyed by domain + key (e.g. "security", "preferred_auth_strategy")
 *   - Ranked by importance and access frequency for context injection
 *   - Pruning removes stale low-importance entries automatically
 *
 * Use cases:
 *   - Artemis recalls recurring user preferences across sessions
 *   - Curator recalls past findings to avoid repeating recommendations
 *   - Both agents build institutional knowledge over time
 */

import { getDb } from './store.sqlite';
import { log } from './logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type MemoryImportance = 'critical' | 'high' | 'medium' | 'low';

export interface LongTermMemoryEntry {
  id:           string;
  domain:       string;
  key:          string;
  value:        string;
  sourceAgent:  string;
  importance:   MemoryImportance;
  tags:         string[];
  createdAt:    string;
  accessedAt:   string;
  accessCount:  number;
}

// ── DB setup ──────────────────────────────────────────────────────────────────

let _dbReady = false;

function ensureDb(): void {
  if (_dbReady) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS agent_long_term_memory (
      id           TEXT    PRIMARY KEY,
      domain       TEXT    NOT NULL,
      key          TEXT    NOT NULL,
      value        TEXT    NOT NULL,
      source_agent TEXT    NOT NULL DEFAULT 'system',
      importance   TEXT    NOT NULL DEFAULT 'medium',
      tags         TEXT    NOT NULL DEFAULT '[]',
      created_at   TEXT    NOT NULL,
      accessed_at  TEXT    NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE (domain, key)
    );
    CREATE INDEX IF NOT EXISTS idx_ltm_domain ON agent_long_term_memory(domain);
    CREATE INDEX IF NOT EXISTS idx_ltm_importance ON agent_long_term_memory(importance);
    CREATE INDEX IF NOT EXISTS idx_ltm_accessed ON agent_long_term_memory(accessed_at DESC);
  `);
  _dbReady = true;
}

// ── Row mapper ────────────────────────────────────────────────────────────────

interface LtmRow {
  id: string; domain: string; key: string; value: string;
  source_agent: string; importance: string; tags: string;
  created_at: string; accessed_at: string; access_count: number;
}

function rowToEntry(row: LtmRow): LongTermMemoryEntry {
  return {
    id:          row.id,
    domain:      row.domain,
    key:         row.key,
    value:       row.value,
    sourceAgent: row.source_agent,
    importance:  row.importance as MemoryImportance,
    tags:        JSON.parse(row.tags) as string[],
    createdAt:   row.created_at,
    accessedAt:  row.accessed_at,
    accessCount: row.access_count,
  };
}

// ── In-memory read cache ───────────────────────────────────────────────────────
// Holds recently accessed entries to avoid repeated SQLite reads.
// Invalidated on every write to ensure consistency.

const readCache = new Map<string, LongTermMemoryEntry>();
const MAX_CACHE  = 500;

function cacheKey(domain: string, key: string): string {
  return `${domain}:${key}`;
}

function invalidateCache(domain?: string): void {
  if (domain) {
    for (const k of readCache.keys()) {
      if (k.startsWith(`${domain}:`)) readCache.delete(k);
    }
  } else {
    readCache.clear();
  }
}

// ── Importance ranking ────────────────────────────────────────────────────────

const IMPORTANCE_RANK: Record<MemoryImportance, number> = {
  critical: 4, high: 3, medium: 2, low: 1,
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Persist or update a long-term memory entry.
 * If domain+key already exists, the value is updated and access_count incremented.
 */
export function rememberFact(
  domain:      string,
  key:         string,
  value:       string,
  sourceAgent: string,
  importance:  MemoryImportance = 'medium',
  tags:        string[]         = [],
): void {
  ensureDb();
  const now = new Date().toISOString();
  const id  = `${domain}:${key}`.replace(/[^a-zA-Z0-9:_-]/g, '_');

  getDb().prepare(`
    INSERT INTO agent_long_term_memory
      (id, domain, key, value, source_agent, importance, tags, created_at, accessed_at, access_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(domain, key) DO UPDATE SET
      value        = excluded.value,
      source_agent = excluded.source_agent,
      importance   = excluded.importance,
      tags         = excluded.tags,
      accessed_at  = excluded.accessed_at,
      access_count = agent_long_term_memory.access_count + 1
  `).run(id, domain, key, value, sourceAgent, importance, JSON.stringify(tags), now, now);

  invalidateCache(domain);
  log.debug({ domain, key, importance }, '[ltm] memory written');
}

/**
 * Read all entries for a domain, ranked by importance then access frequency.
 * Optionally filter by tags.
 */
export function recallFacts(
  domain?:   string,
  tags?:     string[],
  maxItems?: number,
): LongTermMemoryEntry[] {
  ensureDb();

  let sql = 'SELECT * FROM agent_long_term_memory';
  const args: (string | number)[] = [];

  if (domain) {
    sql += ' WHERE domain = ?';
    args.push(domain);
  }

  sql += ' ORDER BY accessed_at DESC';
  if (maxItems) { sql += ' LIMIT ?'; args.push(maxItems * 4); }

  const rows = getDb().prepare<(string | number)[], LtmRow>(sql).all(...args);
  let entries = rows.map(rowToEntry);

  // Filter by tags if specified
  if (tags && tags.length > 0) {
    entries = entries.filter(e => tags.some(t => e.tags.includes(t)));
  }

  // Sort by importance rank DESC, then access_count DESC
  entries.sort((a, b) => {
    const byImportance = IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance];
    if (byImportance !== 0) return byImportance;
    return b.accessCount - a.accessCount;
  });

  if (maxItems) entries = entries.slice(0, maxItems);

  // Update accessed_at for returned entries in the background
  const ids = entries.map(e => e.id);
  if (ids.length > 0) {
    const now = new Date().toISOString();
    const placeholders = ids.map(() => '?').join(',');
    getDb().prepare(`
      UPDATE agent_long_term_memory
      SET accessed_at = ?, access_count = access_count + 1
      WHERE id IN (${placeholders})
    `).run(now, ...ids);
  }

  return entries;
}

/**
 * Look up a specific entry by domain + key.
 */
export function recallFact(domain: string, key: string): LongTermMemoryEntry | null {
  const ck = cacheKey(domain, key);
  if (readCache.has(ck)) return readCache.get(ck)!;

  ensureDb();
  const row = getDb().prepare<[string, string], LtmRow>(
    'SELECT * FROM agent_long_term_memory WHERE domain = ? AND key = ? LIMIT 1'
  ).get(domain, key);

  if (!row) return null;
  const entry = rowToEntry(row);

  if (readCache.size < MAX_CACHE) readCache.set(ck, entry);
  return entry;
}

/**
 * Format long-term memory as a context block for injection into agent prompts.
 * Returns an empty string if no relevant memories exist.
 */
export function formatLongTermContext(domain?: string, maxItems = 20): string {
  const entries = recallFacts(domain, undefined, maxItems);
  if (entries.length === 0) return '';

  const grouped = entries.reduce<Record<string, LongTermMemoryEntry[]>>((acc, e) => {
    (acc[e.domain] ??= []).push(e);
    return acc;
  }, {});

  const sections = Object.entries(grouped).map(([dom, facts]) => {
    const lines = facts.map(f => {
      const badge = f.importance === 'critical' ? '[CRITICAL]' : f.importance === 'high' ? '[HIGH]' : '';
      return `  • ${f.key}: ${f.value.substring(0, 200)}${badge ? ' ' + badge : ''}`;
    }).join('\n');
    return `[${dom.toUpperCase()}]\n${lines}`;
  });

  return `Long-term institutional memory (recalled from past sessions):\n${sections.join('\n\n')}`;
}

/**
 * Prune stale entries older than maxAgeDays.
 * Critical entries are never pruned. High entries are pruned only if > 2x maxAgeDays.
 * Returns number of rows deleted.
 */
export function pruneOldMemories(maxAgeDays = 30): number {
  ensureDb();
  const cutoff     = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
  const longCutoff = new Date(Date.now() - maxAgeDays * 2 * 86_400_000).toISOString();

  const result = getDb().prepare(`
    DELETE FROM agent_long_term_memory
    WHERE (importance IN ('low', 'medium') AND accessed_at < ?)
       OR (importance = 'high' AND accessed_at < ?)
  `).run(cutoff, longCutoff);

  if (result.changes > 0) {
    invalidateCache();
    log.info({ deleted: result.changes, maxAgeDays }, '[ltm] pruned stale memories');
  }

  return result.changes;
}

/**
 * Wipe all memories for a domain (e.g. when resetting a project).
 */
export function forgetDomain(domain: string): void {
  ensureDb();
  getDb().prepare('DELETE FROM agent_long_term_memory WHERE domain = ?').run(domain);
  invalidateCache(domain);
  log.info({ domain }, '[ltm] domain cleared');
}

/**
 * Return all entries as a snapshot (for DevPanel / admin).
 */
export function listAllMemories(limit = 200): LongTermMemoryEntry[] {
  ensureDb();
  const rows = getDb().prepare<[], LtmRow>(
    'SELECT * FROM agent_long_term_memory ORDER BY accessed_at DESC LIMIT 200'
  ).all();
  return rows.slice(0, limit).map(rowToEntry);
}

/**
 * Total count of stored memories.
 */
export function getMemoryCount(): number {
  ensureDb();
  const result = getDb().prepare<[], { c: number }>(
    'SELECT COUNT(*) as c FROM agent_long_term_memory'
  ).get();
  return result?.c ?? 0;
}
