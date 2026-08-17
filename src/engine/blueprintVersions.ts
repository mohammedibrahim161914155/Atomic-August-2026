/**
 * src/engine/blueprintVersions.ts
 *
 * Blueprint Version History
 *
 * Every time the blueprint is modified, a new version is created.
 * The original is permanently preserved. Restoring a version always
 * creates a new version — it is NEVER a destructive overwrite.
 *
 * Version creation triggers:
 *   - Curator applies any edit
 *   - User manually saves a checkpoint
 *   - Pipeline completes a full run
 *   - A pillar improvement pass changes its output
 *
 * Storage: SQLite via the existing blueprintStore + a dedicated versions table.
 * Integrity: SHA-256 hash of each snapshot for corruption detection.
 */

import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';
import { getDb } from './store.sqlite';
import { publishEvent } from './eventBus';
import type { Blueprint } from './types';

// ── Types ──────────────────────────────────────────────────────────────────────

export const BlueprintVersionAuthorSchema = z.enum(['curator', 'pipeline', 'user', 'pillar_subagent']);
export type BlueprintVersionAuthor = z.infer<typeof BlueprintVersionAuthorSchema>;

export const BlueprintVersionChangeTypeSchema = z.enum(['full', 'pillar', 'checkpoint', 'restore']);
export type BlueprintVersionChangeType = z.infer<typeof BlueprintVersionChangeTypeSchema>;

export interface DiffSection {
  path:    string;
  before?: string;
  after?:  string;
}

export interface BlueprintDiff {
  added:     DiffSection[];
  removed:   DiffSection[];
  modified:  DiffSection[];
  unchanged: number;
}

export interface BlueprintVersion {
  id:              string;
  blueprintId:     string;
  versionNumber:   number; // monotonically increasing, never reused
  parentVersion:   number | null;
  timestamp:       string;
  author:          BlueprintVersionAuthor;
  authorDetail:    string;
  changeSummary:   string;
  changeType:      BlueprintVersionChangeType;
  affectedPillars: string[];
  diff:            BlueprintDiff;
  snapshot:        Blueprint; // full snapshot — never delta-only
  integrityHash:   string;   // SHA-256 of JSON.stringify(snapshot)
}

// ── DB initialization ─────────────────────────────────────────────────────────

let initialized = false;

function ensureTable(): void {
  if (initialized) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS blueprint_versions (
      id              TEXT PRIMARY KEY,
      blueprint_id    TEXT NOT NULL,
      version_number  INTEGER NOT NULL,
      parent_version  INTEGER,
      timestamp       TEXT NOT NULL,
      author          TEXT NOT NULL,
      author_detail   TEXT NOT NULL,
      change_summary  TEXT NOT NULL,
      change_type     TEXT NOT NULL,
      affected_pillars TEXT NOT NULL,
      diff            TEXT NOT NULL,
      snapshot        TEXT NOT NULL,
      integrity_hash  TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bpv_blueprint_version
      ON blueprint_versions(blueprint_id, version_number);
    CREATE INDEX IF NOT EXISTS idx_bpv_blueprint_id
      ON blueprint_versions(blueprint_id);
  `);
  initialized = true;
}

// ── Hash ──────────────────────────────────────────────────────────────────────

function computeHash(snapshot: Blueprint): string {
  return createHash('sha256')
    .update(JSON.stringify(snapshot))
    .digest('hex');
}

// ── Diff computation ──────────────────────────────────────────────────────────

function computeDiff(before: Blueprint | null, after: Blueprint): BlueprintDiff {
  const added:    DiffSection[] = [];
  const removed:  DiffSection[] = [];
  const modified: DiffSection[] = [];
  let unchanged = 0;

  if (!before) {
    // First version — everything is "added"
    for (const [k, v] of Object.entries(after.sections ?? {})) {
      if (v) added.push({ path: `sections.${k}`, after: String(v).slice(0, 200) });
    }
    return { added, removed, modified, unchanged: 0 };
  }

  // Compare sections
  const allSectionKeys = new Set([
    ...Object.keys(before.sections ?? {}),
    ...Object.keys(after.sections ?? {}),
  ]);

  for (const key of allSectionKeys) {
    const b = (before.sections as Record<string, string>)[key];
    const a = (after.sections as Record<string, string>)[key];
    if (!b && a)     added.push({ path: `sections.${key}`, after: a.slice(0, 200) });
    else if (b && !a) removed.push({ path: `sections.${key}`, before: b.slice(0, 200) });
    else if (b !== a) modified.push({ path: `sections.${key}`, before: b?.slice(0, 200), after: a?.slice(0, 200) });
    else unchanged++;
  }

  // Compare pillar synthesizer outputs
  const allPillarKeys = new Set([
    ...Object.keys(before.pillars ?? {}),
    ...Object.keys(after.pillars ?? {}),
  ]);

  for (const key of allPillarKeys) {
    const bp = (before.pillars ?? {})[key];
    const ap = (after.pillars ?? {})[key];
    const bs = bp?.synthesizer_output;
    const as_ = ap?.synthesizer_output;
    if (!bs && as_)      added.push({ path: `pillars.${key}`, after: as_.slice(0, 200) });
    else if (bs && !as_) removed.push({ path: `pillars.${key}`, before: bs.slice(0, 200) });
    else if (bs !== as_) modified.push({ path: `pillars.${key}`, before: bs?.slice(0, 200), after: as_?.slice(0, 200) });
    else unchanged++;
  }

  return { added, removed, modified, unchanged };
}

// ── Detect affected pillars ───────────────────────────────────────────────────

function detectAffectedPillars(before: Blueprint | null, after: Blueprint): string[] {
  if (!before) return Object.keys(after.pillars ?? {});
  const affected: string[] = [];
  for (const key of Object.keys(after.pillars ?? {})) {
    const bp = before.pillars[key];
    const ap = after.pillars[key];
    if (JSON.stringify(bp) !== JSON.stringify(ap)) affected.push(key);
  }
  return affected;
}

// ── Core API ──────────────────────────────────────────────────────────────────

export function getNextVersionNumber(blueprintId: string): number {
  ensureTable();
  const db = getDb();
  const row = db.prepare(
    'SELECT MAX(version_number) as max_v FROM blueprint_versions WHERE blueprint_id = ?'
  ).get(blueprintId) as { max_v: number | null };
  return (row?.max_v ?? 0) + 1;
}

export function createVersion(opts: {
  blueprintId:    string;
  snapshot:       Blueprint;
  author:         BlueprintVersionAuthor;
  authorDetail:   string;
  changeSummary:  string;
  changeType:     BlueprintVersionChangeType;
  sessionId:      string;
  previousSnapshot?: Blueprint | null;
}): BlueprintVersion {
  ensureTable();
  const db = getDb();

  const versionNumber = getNextVersionNumber(opts.blueprintId);
  const diff          = computeDiff(opts.previousSnapshot ?? null, opts.snapshot);
  const affectedPillars = detectAffectedPillars(opts.previousSnapshot ?? null, opts.snapshot);
  const integrityHash = computeHash(opts.snapshot);

  // Get parent version number
  const parentRow = db.prepare(
    'SELECT version_number FROM blueprint_versions WHERE blueprint_id = ? ORDER BY version_number DESC LIMIT 1'
  ).get(opts.blueprintId) as { version_number: number } | undefined;

  const version: BlueprintVersion = {
    id:              randomUUID(),
    blueprintId:     opts.blueprintId,
    versionNumber,
    parentVersion:   parentRow?.version_number ?? null,
    timestamp:       new Date().toISOString(),
    author:          opts.author,
    authorDetail:    opts.authorDetail,
    changeSummary:   opts.changeSummary,
    changeType:      opts.changeType,
    affectedPillars,
    diff,
    snapshot:        opts.snapshot,
    integrityHash,
  };

  db.prepare(`
    INSERT INTO blueprint_versions
      (id, blueprint_id, version_number, parent_version, timestamp, author, author_detail,
       change_summary, change_type, affected_pillars, diff, snapshot, integrity_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    version.id,
    version.blueprintId,
    version.versionNumber,
    version.parentVersion,
    version.timestamp,
    version.author,
    version.authorDetail,
    version.changeSummary,
    version.changeType,
    JSON.stringify(version.affectedPillars),
    JSON.stringify(version.diff),
    JSON.stringify(version.snapshot),
    version.integrityHash
  );

  publishEvent('blueprint.version_created', opts.sessionId, randomUUID(), {
    blueprintId:   opts.blueprintId,
    versionNumber,
    author:        opts.author,
    changeSummary: opts.changeSummary,
  });

  return version;
}

export function listVersions(blueprintId: string): Omit<BlueprintVersion, 'snapshot'>[] {
  ensureTable();
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, blueprint_id, version_number, parent_version, timestamp, author,
           author_detail, change_summary, change_type, affected_pillars, diff, integrity_hash
    FROM blueprint_versions
    WHERE blueprint_id = ?
    ORDER BY version_number DESC
  `).all(blueprintId) as Array<{
    id: string; blueprint_id: string; version_number: number; parent_version: number | null;
    timestamp: string; author: string; author_detail: string; change_summary: string;
    change_type: string; affected_pillars: string; diff: string; integrity_hash: string;
  }>;

  return rows.map(r => ({
    id:              r.id,
    blueprintId:     r.blueprint_id,
    versionNumber:   r.version_number,
    parentVersion:   r.parent_version,
    timestamp:       r.timestamp,
    author:          r.author as BlueprintVersionAuthor,
    authorDetail:    r.author_detail,
    changeSummary:   r.change_summary,
    changeType:      r.change_type as BlueprintVersionChangeType,
    affectedPillars: JSON.parse(r.affected_pillars) as string[],
    diff:            JSON.parse(r.diff) as BlueprintDiff,
    integrityHash:   r.integrity_hash,
  }));
}

export function getVersion(blueprintId: string, versionNumber: number): BlueprintVersion | null {
  ensureTable();
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM blueprint_versions
    WHERE blueprint_id = ? AND version_number = ?
  `).get(blueprintId, versionNumber) as {
    id: string; blueprint_id: string; version_number: number; parent_version: number | null;
    timestamp: string; author: string; author_detail: string; change_summary: string;
    change_type: string; affected_pillars: string; diff: string; snapshot: string; integrity_hash: string;
  } | undefined;

  if (!row) return null;

  const snapshot = JSON.parse(row.snapshot) as Blueprint;
  return {
    id:              row.id,
    blueprintId:     row.blueprint_id,
    versionNumber:   row.version_number,
    parentVersion:   row.parent_version,
    timestamp:       row.timestamp,
    author:          row.author as BlueprintVersionAuthor,
    authorDetail:    row.author_detail,
    changeSummary:   row.change_summary,
    changeType:      row.change_type as BlueprintVersionChangeType,
    affectedPillars: JSON.parse(row.affected_pillars) as string[],
    diff:            JSON.parse(row.diff) as BlueprintDiff,
    snapshot,
    integrityHash:   row.integrity_hash,
  };
}

export function restoreVersion(opts: {
  blueprintId:  string;
  versionNumber: number;
  sessionId:    string;
}): { restoredVersion: BlueprintVersion; newVersion: BlueprintVersion } | null {
  const target = getVersion(opts.blueprintId, opts.versionNumber);
  if (!target) return null;

  // Get current version to diff against
  const db = getDb();
  const currentRow = db.prepare(`
    SELECT snapshot FROM blueprint_versions
    WHERE blueprint_id = ? ORDER BY version_number DESC LIMIT 1
  `).get(opts.blueprintId) as { snapshot: string } | undefined;

  const currentSnapshot = currentRow ? JSON.parse(currentRow.snapshot) as Blueprint : null;

  // Creating a restore creates a NEW version (never destructive)
  const newVersion = createVersion({
    blueprintId:      opts.blueprintId,
    snapshot:         target.snapshot,
    author:           'user',
    authorDetail:     `Restored from v${opts.versionNumber}`,
    changeSummary:    `Restored blueprint to version ${opts.versionNumber} (${target.changeSummary})`,
    changeType:       'restore',
    sessionId:        opts.sessionId,
    previousSnapshot: currentSnapshot,
  });

  publishEvent('blueprint.version_restored', opts.sessionId, randomUUID(), {
    blueprintId:   opts.blueprintId,
    fromVersion:   opts.versionNumber,
    newVersion:    newVersion.versionNumber,
  });

  return { restoredVersion: target, newVersion };
}

export function verifyIntegrity(blueprintId: string, versionNumber: number): {
  valid: boolean;
  expected: string;
  actual: string;
} {
  const version = getVersion(blueprintId, versionNumber);
  if (!version) throw new Error(`Version not found: v${versionNumber}`);
  const actual = computeHash(version.snapshot);
  return {
    valid:    actual === version.integrityHash,
    expected: version.integrityHash,
    actual,
  };
}
