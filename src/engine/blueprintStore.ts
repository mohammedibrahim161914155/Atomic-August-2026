/**
 * src/engine/blueprintStore.ts
 *
 * Persistent blueprint storage backed by SQLite.
 * Completely independent of the KV store — uses a dedicated `blueprints` table
 * in the same database file, sharing the WAL-mode connection via getDb().
 *
 * Responsibilities:
 *   - Upsert blueprints on generation completion
 *   - Paginated list with FTS5 full-text search (falls back to LIKE) + tag filter
 *   - Per-blueprint feedback: star ratings + per-section markdown notes
 *   - Tags: string[] per blueprint, filterable in list queries
 *   - Multi-tenant workspace isolation
 *   - Formal migration runner (schema_migrations table tracks applied changes)
 */

import { getDb } from './store.sqlite';
import { Blueprint } from './types';
import { log } from './logger';

// ── Base schema (idempotent — safe on every startup) ─────────────────────────

const BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blueprints (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT,
  prompt              TEXT NOT NULL,
  product_name        TEXT,
  domain              TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  quality_score       INTEGER NOT NULL DEFAULT 0,
  total_tokens        INTEGER NOT NULL DEFAULT 0,
  generation_time_ms  INTEGER NOT NULL DEFAULT 0,
  rating              INTEGER CHECK(rating IS NULL OR (rating >= 1 AND rating <= 5)),
  notes_json          TEXT NOT NULL DEFAULT '{}',
  tags_json           TEXT NOT NULL DEFAULT '[]',
  workspace_id        TEXT NOT NULL DEFAULT 'default',
  blueprint_json      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blueprints_created_at ON blueprints(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_blueprints_session_id ON blueprints(session_id);
CREATE INDEX IF NOT EXISTS idx_blueprints_quality    ON blueprints(quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_blueprints_workspace  ON blueprints(workspace_id, created_at DESC);
`;

// ── Incremental migrations ────────────────────────────────────────────────────

interface Migration {
  id:  string;
  up:  string;
}

/**
 * Each migration runs exactly once, tracked in `schema_migrations`.
 * Order is significant — never reorder or delete entries.
 */
const MIGRATIONS: Migration[] = [
  // 001–003: backfill columns that may be missing on pre-migration installs
  {
    id: '001_backfill_tags_json',
    up: `ALTER TABLE blueprints ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'`,
  },
  {
    id: '002_backfill_workspace_id',
    up: `ALTER TABLE blueprints ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default'`,
  },
  {
    id: '003_workspace_index',
    up: `CREATE INDEX IF NOT EXISTS idx_blueprints_workspace ON blueprints(workspace_id, created_at DESC)`,
  },
  // 004–008: FTS5 full-text search
  {
    id: '004_fts5_table',
    up: `
      CREATE VIRTUAL TABLE IF NOT EXISTS blueprints_fts USING fts5(
        id        UNINDEXED,
        prompt,
        product_name,
        domain,
        content='blueprints',
        content_rowid='rowid'
      )
    `,
  },
  {
    id: '005_fts5_trigger_insert',
    up: `
      CREATE TRIGGER IF NOT EXISTS blueprints_ai AFTER INSERT ON blueprints BEGIN
        INSERT INTO blueprints_fts(rowid, id, prompt, product_name, domain)
        VALUES (new.rowid, new.id, new.prompt, new.product_name, new.domain);
      END
    `,
  },
  {
    id: '006_fts5_trigger_delete',
    up: `
      CREATE TRIGGER IF NOT EXISTS blueprints_ad AFTER DELETE ON blueprints BEGIN
        INSERT INTO blueprints_fts(blueprints_fts, rowid, id, prompt, product_name, domain)
        VALUES ('delete', old.rowid, old.id, old.prompt, old.product_name, old.domain);
      END
    `,
  },
  {
    id: '007_fts5_trigger_update',
    up: `
      CREATE TRIGGER IF NOT EXISTS blueprints_au AFTER UPDATE ON blueprints BEGIN
        INSERT INTO blueprints_fts(blueprints_fts, rowid, id, prompt, product_name, domain)
        VALUES ('delete', old.rowid, old.id, old.prompt, old.product_name, old.domain);
        INSERT INTO blueprints_fts(rowid, id, prompt, product_name, domain)
        VALUES (new.rowid, new.id, new.prompt, new.product_name, new.domain);
      END
    `,
  },
  {
    id: '008_fts5_rebuild',
    up: `INSERT INTO blueprints_fts(blueprints_fts) VALUES ('rebuild')`,
  },
  // 009: Add project_id column for multi-project scoping
  {
    id: '009_add_project_id',
    up: `ALTER TABLE blueprints ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default'`,
  },
  // 010: Index project_id for fast per-project queries
  {
    id: '010_project_id_index',
    up: `CREATE INDEX IF NOT EXISTS idx_blueprints_project ON blueprints(project_id, created_at DESC)`,
  },
];

// ── Migration runner ──────────────────────────────────────────────────────────

let migrationsApplied = false;
let ftsAvailable      = false;

function applyMigrations(): void {
  if (migrationsApplied) return;
  const db = getDb();

  // Run the base schema (idempotent).
  db.exec(BASE_SCHEMA_SQL);

  // Apply each pending migration inside its own transaction.
  for (const m of MIGRATIONS) {
    const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(m.id);
    if (already) continue;

    try {
      db.transaction(() => {
        db.exec(m.up.trim());
        db.prepare(
          `INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)`
        ).run(m.id, new Date().toISOString());
      })();
      log.info({ migration: m.id }, '[blueprintStore] migration applied');
    } catch (err: any) {
      // Idempotent DDL (e.g., ALTER TABLE on a column that already exists) can
      // safely be skipped. DML errors (e.g., FTS5 rebuild) should also not crash
      // the server — we fall back to LIKE search.
      const msg: string = err?.message ?? '';
      const isIdempotent =
        msg.includes('duplicate column') ||
        msg.includes('already exists')   ||
        msg.includes('no such module: fts5');
      if (isIdempotent) {
        // Record as applied so we don't retry on every startup.
        try {
          db.prepare(
            `INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`
          ).run(m.id, new Date().toISOString());
        } catch { /* ignore */ }
        log.warn({ migration: m.id, reason: msg }, '[blueprintStore] migration skipped (idempotent)');
      } else {
        log.error({ migration: m.id, err }, '[blueprintStore] migration failed — non-fatal, continuing');
      }
    }
  }

  // Probe whether FTS5 is available by querying the virtual table.
  try {
    db.prepare('SELECT * FROM blueprints_fts LIMIT 0').all();
    ftsAvailable = true;
    log.debug('[blueprintStore] FTS5 full-text search is active');
  } catch {
    ftsAvailable = false;
    log.warn('[blueprintStore] FTS5 not available — falling back to LIKE search');
  }

  migrationsApplied = true;
}

// Alias used internally — callers all go through this gate.
function ensureSchema(): void {
  applyMigrations();
}

// ── FTS5 query helpers ────────────────────────────────────────────────────────

/**
 * Convert a user-supplied search string to a safe FTS5 MATCH expression.
 * Each whitespace-delimited word becomes a quoted prefix term.
 * Special FTS5 characters inside words are stripped.
 */
function toFtsQuery(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 0)
    .map(w => `"${w.replace(/['"*?-]/g, '')}"*`)
    .join(' ');
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface BlueprintListItem {
  id:                 string;
  session_id?:        string;
  prompt:             string;
  product_name?:      string;
  domain?:            string;
  created_at:         string;
  updated_at:         string;
  quality_score:      number;
  total_tokens:       number;
  generation_time_ms: number;
  rating?:            number;
  tags:               string[];
}

export interface SavedBlueprint extends BlueprintListItem {
  blueprint:   Blueprint;
  notes:       Record<string, string>;
}

export interface ListBlueprintsOptions {
  limit?:        number;
  offset?:       number;
  search?:       string;
  tag?:          string;
  sort?:         'newest' | 'oldest' | 'quality';
  quality_min?:  number;
  date_after?:   string;
  workspace_id?: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function safeParseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

// ── CRUD operations ───────────────────────────────────────────────────────────

/**
 * Upsert a completed blueprint. Called automatically after generation completes.
 * Idempotent — re-running with the same blueprint.id just updates the record.
 */
export function saveBlueprint(blueprint: Blueprint): void {
  try {
    ensureSchema();
    const db = getDb();
    const ts = now();
    db.prepare(`
      INSERT INTO blueprints (
        id, session_id, prompt, product_name, domain,
        created_at, updated_at,
        quality_score, total_tokens, generation_time_ms,
        blueprint_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        updated_at         = excluded.updated_at,
        quality_score      = excluded.quality_score,
        total_tokens       = excluded.total_tokens,
        generation_time_ms = excluded.generation_time_ms,
        blueprint_json     = excluded.blueprint_json
    `).run(
      blueprint.id,
      blueprint.session_id ?? null,
      blueprint.prompt,
      blueprint.intent?.product_name ?? null,
      blueprint.intent?.domain ?? null,
      blueprint.created_at,
      ts,
      blueprint.quality_score,
      blueprint.total_tokens,
      blueprint.generation_time_ms,
      JSON.stringify(blueprint),
    );
    log.info({ blueprintId: blueprint.id }, '[blueprintStore] blueprint saved');
  } catch (err) {
    log.error({ err }, '[blueprintStore] saveBlueprint failed — blueprint not persisted');
  }
}

/**
 * Return a paginated, optionally-filtered list of blueprint summaries.
 *
 * When FTS5 is available, search uses MATCH for ranked full-text search.
 * Falls back to LIKE when FTS5 is unavailable.
 * Tag filter uses json_each() for exact array membership.
 */
export function listBlueprints(opts: ListBlueprintsOptions = {}): {
  items: BlueprintListItem[];
  total: number;
} {
  ensureSchema();
  const db          = getDb();
  const limit       = Math.min(opts.limit  ?? 20, 100);
  const offset      = opts.offset ?? 0;
  const search      = opts.search?.trim();
  const tag         = opts.tag?.trim();
  const sort        = opts.sort ?? 'newest';
  const qualityMin  = typeof opts.quality_min === 'number' ? opts.quality_min : null;
  const dateAfter   = opts.date_after?.trim() ?? null;
  const workspaceId = opts.workspace_id ?? 'default';

  const whereClauses: string[] = [];
  const params: (string | number)[] = [];

  whereClauses.push(`workspace_id = ?`);
  params.push(workspaceId);

  if (search) {
    if (ftsAvailable) {
      // FTS5 prefix MATCH — scales to millions of rows with no full-table scan.
      whereClauses.push(
        `id IN (SELECT id FROM blueprints_fts WHERE blueprints_fts MATCH ?)`
      );
      params.push(toFtsQuery(search));
    } else {
      // LIKE fallback for environments where FTS5 is unavailable.
      whereClauses.push(`(prompt LIKE ? OR product_name LIKE ? OR domain LIKE ?)`);
      const like = `%${search}%`;
      params.push(like, like, like);
    }
  }

  if (tag) {
    whereClauses.push(
      `id IN (SELECT b.id FROM blueprints b, json_each(b.tags_json) WHERE json_each.value = ?)`
    );
    params.push(tag);
  }

  if (qualityMin !== null) {
    whereClauses.push(`quality_score >= ?`);
    params.push(qualityMin);
  }

  if (dateAfter) {
    whereClauses.push(`created_at >= ?`);
    params.push(dateAfter);
  }

  const where = `WHERE ${whereClauses.join(' AND ')}`;

  const orderBy =
    sort === 'oldest'  ? 'ORDER BY created_at ASC' :
    sort === 'quality' ? 'ORDER BY quality_score DESC, created_at DESC' :
                         'ORDER BY created_at DESC';

  const total = (db.prepare(`SELECT COUNT(*) as n FROM blueprints ${where}`)
    .get(...params) as { n: number }).n;

  const rows = db.prepare(`
    SELECT id, session_id, prompt, product_name, domain,
           created_at, updated_at, quality_score, total_tokens,
           generation_time_ms, rating, tags_json
    FROM blueprints
    ${where}
    ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Array<Omit<BlueprintListItem, 'tags'> & { tags_json: string }>;

  return {
    items: rows.map(r => ({
      ...r,
      tags: safeParseJson<string[]>(r.tags_json, []),
    })),
    total,
  };
}

/**
 * Return the full blueprint object plus notes+tags for a given ID.
 * Returns null if not found.
 */
export function getBlueprint(id: string): SavedBlueprint | null {
  ensureSchema();
  const row = getDb().prepare(`
    SELECT id, session_id, prompt, product_name, domain,
           created_at, updated_at, quality_score, total_tokens,
           generation_time_ms, rating, notes_json, tags_json, blueprint_json
    FROM blueprints WHERE id = ?
  `).get(id) as any;

  if (!row) return null;

  const blueprint = safeParseJson<Blueprint>(row.blueprint_json, null as any);
  if (!blueprint) return null;

  return {
    id:                 row.id,
    session_id:         row.session_id ?? undefined,
    prompt:             row.prompt,
    product_name:       row.product_name ?? undefined,
    domain:             row.domain ?? undefined,
    created_at:         row.created_at,
    updated_at:         row.updated_at,
    quality_score:      row.quality_score,
    total_tokens:       row.total_tokens,
    generation_time_ms: row.generation_time_ms,
    rating:             row.rating ?? undefined,
    tags:               safeParseJson<string[]>(row.tags_json, []),
    notes:              safeParseJson<Record<string, string>>(row.notes_json, {}),
    blueprint,
  };
}

/**
 * Delete a blueprint by ID. Returns true if a row was deleted.
 */
export function deleteBlueprint(id: string): boolean {
  ensureSchema();
  const result = getDb().prepare('DELETE FROM blueprints WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Set the star rating (1–5) for a blueprint. Pass null to clear it.
 */
export function setRating(id: string, rating: number | null): boolean {
  ensureSchema();
  if (rating !== null && (rating < 1 || rating > 5 || !Number.isInteger(rating))) {
    throw new RangeError(`Rating must be an integer 1–5, got ${rating}`);
  }
  const result = getDb().prepare(`
    UPDATE blueprints SET rating = ?, updated_at = ? WHERE id = ?
  `).run(rating, now(), id);
  return result.changes > 0;
}

/**
 * Upsert a per-section note. Pass an empty string to clear a section's note.
 */
export function setNote(id: string, sectionKey: string, note: string): boolean {
  ensureSchema();
  const db  = getDb();
  const row = db.prepare('SELECT notes_json FROM blueprints WHERE id = ?').get(id) as any;
  if (!row) return false;

  const notes = safeParseJson<Record<string, string>>(row.notes_json, {});
  if (note.trim() === '') {
    delete notes[sectionKey];
  } else {
    notes[sectionKey] = note.trim();
  }

  const result = db.prepare(`
    UPDATE blueprints SET notes_json = ?, updated_at = ? WHERE id = ?
  `).run(JSON.stringify(notes), now(), id);
  return result.changes > 0;
}

/**
 * Replace the tags array for a blueprint.
 * Tags are normalised: lowercased, trimmed, deduplicated, max 10 tags, max 32 chars each.
 */
export function setTags(id: string, tags: string[]): boolean {
  ensureSchema();
  const normalised = Array.from(
    new Set(
      tags
        .map(t => t.trim().toLowerCase().replace(/[^a-z0-9\s\-_]/g, '').trim())
        .filter(t => t.length > 0 && t.length <= 32)
    )
  ).slice(0, 10);

  const result = getDb().prepare(`
    UPDATE blueprints SET tags_json = ?, updated_at = ? WHERE id = ?
  `).run(JSON.stringify(normalised), now(), id);
  return result.changes > 0;
}

/**
 * Return all distinct tags with their blueprint counts, ordered by frequency.
 * Uses SQLite's json_each() — requires SQLite ≥ 3.38 (bundled with better-sqlite3).
 */
export function listAllTags(): { tag: string; count: number }[] {
  try {
    ensureSchema();
    const rows = getDb().prepare(`
      SELECT je.value AS tag, COUNT(*) AS count
      FROM blueprints b, json_each(b.tags_json) je
      WHERE je.value != ''
      GROUP BY je.value
      ORDER BY count DESC, je.value ASC
    `).all() as { tag: string; count: number }[];
    return rows;
  } catch {
    return [];
  }
}

/**
 * Count of all saved blueprints (for dashboard display).
 */
export function countBlueprints(): number {
  try {
    ensureSchema();
    return ((getDb().prepare('SELECT COUNT(*) as n FROM blueprints').get()) as { n: number }).n;
  } catch {
    return 0;
  }
}
