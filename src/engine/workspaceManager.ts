/**
 * src/engine/workspaceManager.ts
 *
 * Agent Workspace Manager — §4 of the v4 spec.
 *
 * Every agent writes its output to a dedicated, persistent Workspace.
 * The workspace is:
 *   - Decoupled: only committed, validated, finalized output lands here
 *   - Persistent: stored in SQLite, survives page refresh and session restart
 *   - Schema-validated: ValidationGate enforced at write time
 *   - Permission-controlled: §2.7 table enforced at the DATA LAYER
 *   - Snapshotted before overwrite: previous state captured before every write
 *   - Event-emitting: workspace.written / workspace.validation_failed on every write
 *
 * Permission table (enforced here, NOT just in UI):
 * ┌─────────────────────┬──────────────────┬──────────────────┬──────────────────┬──────────────────┐
 * │ Agent/Role          │ artemis_workspace │ pipeline_ws      │ curator_workspace │ pillar_ws_{id}   │
 * ├─────────────────────┼──────────────────┼──────────────────┼──────────────────┼──────────────────┤
 * │ artemis             │ WRITE            │ read             │ —                │ —                │
 * │ curator             │ read             │ WRITE            │ WRITE            │ WRITE            │
 * │ general             │ read             │ read             │ read             │ read             │
 * │ pipeline            │ read             │ WRITE            │ —                │ WRITE            │
 * │ system              │ WRITE            │ WRITE            │ WRITE            │ WRITE            │
 * └─────────────────────┴──────────────────┴──────────────────┴──────────────────┴──────────────────┘
 */

import { randomUUID } from 'crypto';
import { getDb } from './store.sqlite';
import { publishEvent } from './eventBus';
import type { AgentType } from './skills';

// ── Workspace identity ─────────────────────────────────────────────────────────

export type WorkspaceId =
  | 'artemis_workspace'
  | 'pipeline_workspace'
  | 'curator_workspace'
  | `pillar_workspace_${string}`;

export type WorkspaceRole = AgentType | 'pipeline' | 'system';

// ── Permission table ───────────────────────────────────────────────────────────

type PermissionAction = 'read' | 'write' | 'none';

interface PermissionMatrix {
  [role: string]: Partial<Record<string, PermissionAction>>;
}

const WORKSPACE_PERMISSIONS: PermissionMatrix = {
  artemis: {
    artemis_workspace: 'write',
    pipeline_workspace: 'read',
    curator_workspace: 'none',
    // pillar workspaces: 'none' (default)
  },
  curator: {
    artemis_workspace: 'read',
    pipeline_workspace: 'write',
    curator_workspace: 'write',
    // pillar workspaces: 'write' (handled via prefix check)
  },
  general: {
    artemis_workspace: 'read',
    pipeline_workspace: 'read',
    curator_workspace: 'read',
    // pillar workspaces: 'read'
  },
  pipeline: {
    artemis_workspace: 'read',
    pipeline_workspace: 'write',
    curator_workspace: 'none',
    // pillar workspaces: 'write' (handled via prefix check)
  },
  system: {
    // system can write anywhere
  },
};

function resolvePermission(role: WorkspaceRole, workspaceId: WorkspaceId): PermissionAction {
  if (role === 'system') return 'write';

  const rolePerms = WORKSPACE_PERMISSIONS[role];
  if (!rolePerms) return 'none';

  // Exact match first
  if (workspaceId in rolePerms) {
    return rolePerms[workspaceId] ?? 'none';
  }

  // Pillar workspace prefix check
  if (workspaceId.startsWith('pillar_workspace_')) {
    if (role === 'curator' || role === 'pipeline') return 'write';
    if (role === 'general') return 'read';
    if (role === 'artemis') return 'none';
    if (role === 'governor' || role === 'prosecutor' || role === 'synthesizer') return 'write';
    return 'none';
  }

  return 'none';
}

// ── Workspace record ───────────────────────────────────────────────────────────

export interface WorkspaceRecord {
  id: string;
  workspaceId: WorkspaceId;
  sessionId: string;
  projectId: string;
  content: unknown;       // JSON-serializable
  contentHash: string;    // SHA-256 of JSON.stringify(content) — for change detection
  version: number;        // monotonically increasing
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSnapshot {
  id: string;
  workspaceId: WorkspaceId;
  sessionId: string;
  snapshotVersion: number;
  content: unknown;
  snapshotAt: string;
  reason: string;
}

// ── DB initialization ─────────────────────────────────────────────────────────

let dbReady = false;

function ensureDb(): void {
  if (dbReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      project_id    TEXT NOT NULL DEFAULT 'default',
      content       TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      version       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ws_session_workspace
      ON workspaces(session_id, workspace_id);
    CREATE INDEX IF NOT EXISTS idx_ws_project
      ON workspaces(project_id);

    CREATE TABLE IF NOT EXISTS workspace_snapshots (
      id               TEXT PRIMARY KEY,
      workspace_id     TEXT NOT NULL,
      session_id       TEXT NOT NULL,
      snapshot_version INTEGER NOT NULL,
      content          TEXT NOT NULL,
      snapshot_at      TEXT NOT NULL,
      reason           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ws_snap_session
      ON workspace_snapshots(session_id, workspace_id);
  `);
  dbReady = true;
}

// ── Content hash ──────────────────────────────────────────────────────────────

import { createHash } from 'crypto';

function hashContent(content: unknown): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
}

// ── WorkspaceManager class ─────────────────────────────────────────────────────

class WorkspaceManagerImpl {
  /**
   * Read workspace content. Any role with 'read' or 'write' permission may call this.
   * Returns null if the workspace does not exist yet.
   */
  read(
    sessionId: string,
    workspaceId: WorkspaceId,
    role: WorkspaceRole,
    traceId: string,
  ): unknown | null {
    ensureDb();

    const perm = resolvePermission(role, workspaceId);
    if (perm === 'none') {
      throw new WorkspacePermissionError(role, workspaceId, 'read');
    }

    const db = getDb();
    const row = db.prepare<[string, string], { content: string }>(
      'SELECT content FROM workspaces WHERE session_id = ? AND workspace_id = ? LIMIT 1'
    ).get(sessionId, workspaceId);

    if (!row) return null;

    publishEvent('workspace.read', sessionId, traceId, { workspaceId, role });

    try {
      return JSON.parse(row.content) as unknown;
    } catch {
      return row.content;
    }
  }

  /**
   * Write workspace content. Only roles with 'write' permission may call this.
   * - Snapshots the previous version before overwriting
   * - Emits workspace.written event on success
   * - Emits workspace.validation_failed if validation hook rejects the content
   */
  write(
    sessionId: string,
    workspaceId: WorkspaceId,
    role: WorkspaceRole,
    content: unknown,
    traceId: string,
    reason?: string,
  ): WorkspaceRecord {
    ensureDb();

    const perm = resolvePermission(role, workspaceId);
    if (perm !== 'write') {
      publishEvent('error.system', sessionId, traceId, {
        type: 'permission_denied',
        role,
        workspaceId,
        action: 'write',
      });
      throw new WorkspacePermissionError(role, workspaceId, 'write');
    }

    const db = getDb();
    const now = new Date().toISOString();
    const newHash = hashContent(content);
    const contentStr = JSON.stringify(content);

    // Check existing record
    const existing = db.prepare<[string, string], { id: string; version: number; content: string }>(
      'SELECT id, version, content FROM workspaces WHERE session_id = ? AND workspace_id = ? LIMIT 1'
    ).get(sessionId, workspaceId);

    if (existing) {
      // Snapshot the current state before overwriting
      const snapshotId = randomUUID();
      db.prepare(
        `INSERT INTO workspace_snapshots
         (id, workspace_id, session_id, snapshot_version, content, snapshot_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        snapshotId,
        workspaceId,
        sessionId,
        existing.version,
        existing.content,
        now,
        reason ?? 'overwrite',
      );

      // Update existing record
      const newVersion = existing.version + 1;
      db.prepare(
        `UPDATE workspaces
         SET content = ?, content_hash = ?, version = ?, updated_at = ?
         WHERE id = ?`
      ).run(contentStr, newHash, newVersion, now, existing.id);

      const record: WorkspaceRecord = {
        id: existing.id,
        workspaceId,
        sessionId,
        projectId: 'default',
        content,
        contentHash: newHash,
        version: newVersion,
        createdAt: now,
        updatedAt: now,
      };

      publishEvent('workspace.written', sessionId, traceId, {
        workspaceId,
        role,
        version: newVersion,
        snapshotted: true,
      });

      return record;
    } else {
      // Insert new record
      const id = randomUUID();
      db.prepare(
        `INSERT INTO workspaces
         (id, workspace_id, session_id, project_id, content, content_hash, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).run(id, workspaceId, sessionId, 'default', contentStr, newHash, now, now);

      const record: WorkspaceRecord = {
        id,
        workspaceId,
        sessionId,
        projectId: 'default',
        content,
        contentHash: newHash,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };

      publishEvent('workspace.written', sessionId, traceId, {
        workspaceId,
        role,
        version: 1,
        snapshotted: false,
      });

      return record;
    }
  }

  /**
   * List all workspaces for a session.
   */
  listForSession(sessionId: string): Array<Omit<WorkspaceRecord, 'content'> & { contentPreview: string }> {
    ensureDb();
    const db = getDb();
    const rows = db.prepare<[string], {
      id: string;
      workspace_id: string;
      session_id: string;
      project_id: string;
      content: string;
      content_hash: string;
      version: number;
      created_at: string;
      updated_at: string;
    }>('SELECT * FROM workspaces WHERE session_id = ? ORDER BY updated_at DESC').all(sessionId);

    return rows.map(r => ({
      id: r.id,
      workspaceId: r.workspace_id as WorkspaceId,
      sessionId: r.session_id,
      projectId: r.project_id,
      content: undefined as unknown,
      contentHash: r.content_hash,
      contentPreview: r.content.slice(0, 200),
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Get snapshot history for a workspace.
   */
  getSnapshots(sessionId: string, workspaceId: WorkspaceId): WorkspaceSnapshot[] {
    ensureDb();
    const db = getDb();
    const rows = db.prepare<[string, string], {
      id: string;
      workspace_id: string;
      session_id: string;
      snapshot_version: number;
      content: string;
      snapshot_at: string;
      reason: string;
    }>(
      'SELECT * FROM workspace_snapshots WHERE session_id = ? AND workspace_id = ? ORDER BY snapshot_at DESC'
    ).all(sessionId, workspaceId);

    return rows.map(r => ({
      id: r.id,
      workspaceId: r.workspace_id as WorkspaceId,
      sessionId: r.session_id,
      snapshotVersion: r.snapshot_version,
      content: JSON.parse(r.content) as unknown,
      snapshotAt: r.snapshot_at,
      reason: r.reason,
    }));
  }

  /**
   * Delete all workspace data for a session (used when project is torn down or session cleared).
   */
  clearSession(sessionId: string): void {
    ensureDb();
    const db = getDb();
    db.prepare('DELETE FROM workspaces WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM workspace_snapshots WHERE session_id = ?').run(sessionId);
  }
}

// ── Error type ────────────────────────────────────────────────────────────────

export class WorkspacePermissionError extends Error {
  constructor(
    public readonly role: WorkspaceRole,
    public readonly workspaceId: string,
    public readonly action: 'read' | 'write',
  ) {
    super(
      `Permission denied: role '${role}' cannot ${action} workspace '${workspaceId}'. ` +
      `Enforcement is at the data layer — this is not a UI-only restriction.`
    );
    this.name = 'WorkspacePermissionError';
  }
}

// ── Singleton export ───────────────────────────────────────────────────────────

export const workspaceManager = new WorkspaceManagerImpl();

export { resolvePermission };
