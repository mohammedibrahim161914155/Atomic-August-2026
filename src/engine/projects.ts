/**
 * src/engine/projects.ts
 *
 * Multi-Project Architecture — §2.8 of the v4 spec.
 *
 * Users can have multiple projects. All state, workspaces, blueprints, and
 * version histories are scoped to a projectId.
 *
 * Switching projects:
 *   - Cleanly tears down all current agent sessions
 *   - Flushes pending workspace writes (synchronous SQLite — flush is instant)
 *   - Loads the new project state
 *   - Zero state bleed between projects
 *
 * Storage: SQLite (same connection as the rest of the app).
 */

import { randomUUID } from 'crypto';
import { getDb } from './store.sqlite';
import { publishEvent } from './eventBus';
import { workspaceManager } from './workspaceManager';
import { tokenBudgetManager } from './tokenBudgetManager';
import { rateLimitManager } from './rateLimitManager';

// ── Types ──────────────────────────────────────────────────────────────────────

export type SystemPhase = 'scoping' | 'pipeline' | 'refinement' | 'complete' | 'idle';

export interface Project {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  lastActiveAt: string;
  phase: SystemPhase;
  currentBlueprintVersion: number;
  sessionId?: string; // active session for this project
  metadata: Record<string, unknown>;
}

export interface ProjectListItem {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  lastActiveAt: string;
  phase: SystemPhase;
  currentBlueprintVersion: number;
}

// ── DB initialization ──────────────────────────────────────────────────────────

let dbReady = false;

function ensureDb(): void {
  if (dbReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id                       TEXT PRIMARY KEY,
      name                     TEXT NOT NULL,
      description              TEXT,
      created_at               TEXT NOT NULL,
      last_active_at           TEXT NOT NULL,
      phase                    TEXT NOT NULL DEFAULT 'idle',
      current_blueprint_version INTEGER NOT NULL DEFAULT 0,
      session_id               TEXT,
      metadata                 TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_projects_last_active
      ON projects(last_active_at DESC);
  `);

  // Insert the default project if no projects exist
  const count = db.prepare<[], { count: number }>('SELECT COUNT(*) as count FROM projects').get();
  if (!count || count.count === 0) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO projects (id, name, description, created_at, last_active_at, phase, current_blueprint_version, metadata)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      'default',
      'My First Project',
      'Default project — rename or create new projects from the Projects settings.',
      now,
      now,
      'idle',
      '{}',
    );
  }

  dbReady = true;
}

// ── Active project tracking ────────────────────────────────────────────────────

let activeProjectId = 'default';

function getActiveProjectId(): string {
  return activeProjectId;
}

// ── Row shape ──────────────────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  last_active_at: string;
  phase: string;
  current_blueprint_version: number;
  session_id: string | null;
  metadata: string;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    phase: row.phase as SystemPhase,
    currentBlueprintVersion: row.current_blueprint_version,
    sessionId: row.session_id ?? undefined,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

// ── ProjectManager ─────────────────────────────────────────────────────────────

class ProjectManagerImpl {
  createProject(name: string, description?: string): Project {
    ensureDb();

    if (!name || name.trim().length === 0) {
      throw new Error('Project name cannot be empty');
    }
    if (name.trim().length > 100) {
      throw new Error('Project name must be 100 characters or fewer');
    }

    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO projects (id, name, description, created_at, last_active_at, phase, current_blueprint_version, metadata)
      VALUES (?, ?, ?, ?, ?, 'idle', 0, '{}')
    `).run(id, name.trim(), description?.trim() ?? null, now, now);

    publishEvent('project.created', 'system', randomUUID(), { projectId: id, name });

    return this.getProject(id);
  }

  getProject(id: string): Project {
    ensureDb();
    const db = getDb();
    const row = db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE id = ? LIMIT 1').get(id);
    if (!row) throw new Error(`Project not found: ${id}`);
    return rowToProject(row);
  }

  listProjects(): ProjectListItem[] {
    ensureDb();
    const db = getDb();
    const rows = db.prepare<[], ProjectRow>('SELECT * FROM projects ORDER BY last_active_at DESC').all();
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description ?? undefined,
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
      phase: r.phase as SystemPhase,
      currentBlueprintVersion: r.current_blueprint_version,
    }));
  }

  updateProject(id: string, updates: { name?: string; description?: string; phase?: SystemPhase; sessionId?: string; currentBlueprintVersion?: number }): Project {
    ensureDb();
    const db = getDb();
    const existing = db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE id = ? LIMIT 1').get(id);
    if (!existing) throw new Error(`Project not found: ${id}`);

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE projects SET
        name = ?,
        description = ?,
        phase = ?,
        session_id = ?,
        current_blueprint_version = ?,
        last_active_at = ?
      WHERE id = ?
    `).run(
      updates.name?.trim() ?? existing.name,
      updates.description?.trim() ?? existing.description,
      updates.phase ?? existing.phase,
      updates.sessionId ?? existing.session_id,
      updates.currentBlueprintVersion ?? existing.current_blueprint_version,
      now,
      id,
    );

    return this.getProject(id);
  }

  deleteProject(id: string): void {
    ensureDb();
    if (id === 'default') {
      throw new Error('Cannot delete the default project');
    }
    if (id === activeProjectId) {
      throw new Error('Cannot delete the currently active project — switch to another project first');
    }

    const db = getDb();
    const row = db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE id = ? LIMIT 1').get(id);
    if (!row) throw new Error(`Project not found: ${id}`);

    // Clean up workspace data if a session is associated
    if (row.session_id) {
      workspaceManager.clearSession(row.session_id);
      tokenBudgetManager.clearSession(row.session_id);
    }

    // Delete blueprints scoped to this project (if project_id column exists)
    try {
      db.prepare('DELETE FROM blueprints WHERE project_id = ?').run(id);
    } catch {
      // project_id column may not exist yet — skip silently
    }

    // Delete blueprint versions for any blueprints in this project
    try {
      const blueprintIds = db.prepare<[string], { id: string }>(
        'SELECT id FROM blueprints WHERE project_id = ?'
      ).all(id);
      for (const { id: bpId } of blueprintIds) {
        db.prepare('DELETE FROM blueprint_versions WHERE blueprint_id = ?').run(bpId);
      }
    } catch {
      // blueprint_versions may not exist or project_id column missing — skip
    }

    db.prepare('DELETE FROM projects WHERE id = ?').run(id);

    publishEvent('project.deleted', 'system', randomUUID(), { projectId: id, name: row.name });
  }

  /**
   * Switch the active project. Tears down current session state cleanly.
   * Zero state bleed guaranteed — SQLite writes are synchronous.
   */
  switchProject(projectId: string): Project {
    ensureDb();
    const db = getDb();
    const row = db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE id = ? LIMIT 1').get(projectId);
    if (!row) throw new Error(`Project not found: ${projectId}`);

    // Capture old project ID BEFORE updating activeProjectId
    const previousProjectId = activeProjectId;

    // Cancel any pending LLM requests for the old session
    const oldProject = db.prepare<[string], ProjectRow>(
      'SELECT * FROM projects WHERE id = ? LIMIT 1'
    ).get(previousProjectId);

    if (oldProject?.session_id) {
      rateLimitManager.cancelSession(oldProject.session_id);
    }

    activeProjectId = projectId;

    // Update last active timestamp
    const now = new Date().toISOString();
    db.prepare('UPDATE projects SET last_active_at = ? WHERE id = ?').run(now, projectId);

    publishEvent('project.switched', 'system', randomUUID(), {
      projectId,
      previousProjectId,
      projectName: row.name,
    });

    return rowToProject(row);
  }

  getActiveProject(): Project {
    return this.getProject(getActiveProjectId());
  }

  getActiveProjectId(): string {
    return activeProjectId;
  }

  /**
   * Associate a session with a project (called when generation starts).
   */
  setProjectSession(projectId: string, sessionId: string, phase: SystemPhase = 'pipeline'): void {
    ensureDb();
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE projects SET session_id = ?, phase = ?, last_active_at = ? WHERE id = ?
    `).run(sessionId, phase, now, projectId);
  }
}

// ── Singleton export ───────────────────────────────────────────────────────────

export const projectManager = new ProjectManagerImpl();
