/**
 * src/engine/settingsStore.ts
 *
 * Settings Persistence — §14 of the v4 spec.
 *
 * All settings are persisted to SQLite and applied at runtime.
 * Changes to active settings take effect on the next agent invocation.
 * No restart required.
 *
 * Settings are organized by agent/component:
 *   - Artemis: model, skills, tools, breakdown strategy, confidence threshold, tone
 *   - Curator: model, skills, tools, trusted domains, refinement depth, edit mode
 *   - General: model, skills, tools
 *   - Pipeline: global model, per-pillar overrides, parallelism, failure strategy
 *   - Skills: manages custom skills (CRUD)
 *   - System: developer mode, token budgets, streaming, version retention
 */

import { randomUUID } from 'crypto';
import { getDb } from './store.sqlite';
import { publishEvent } from './eventBus';
import type { AtomicSettings } from './systemState';
import { AtomicStateManager } from './systemState';

// ── DB setup ──────────────────────────────────────────────────────────────────

let dbReady = false;

function ensureDb(): void {
  if (dbReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS atomic_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  dbReady = true;
}

// ── Merge utility ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source ?? {})) {
    const sourceVal = source[key];
    const targetVal = target[key];
    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(targetVal, sourceVal);
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }
  return result;
}

// ── Settings store ────────────────────────────────────────────────────────────

const SETTINGS_KEY = 'global_atomic_settings';

class SettingsStoreImpl {
  /**
   * Load settings from SQLite. Returns defaults if not yet saved.
   */
  load(): AtomicSettings {
    ensureDb();
    const db = getDb();
    const row = db.prepare<[string], { value: string }>(
      'SELECT value FROM atomic_settings WHERE key = ? LIMIT 1'
    ).get(SETTINGS_KEY);

    const defaults = AtomicStateManager.DEFAULT_SETTINGS;
    if (!row) return defaults;

    try {
      const saved = JSON.parse(row.value) as Partial<AtomicSettings>;
      return deepMerge(defaults, saved);
    } catch {
      return defaults;
    }
  }

  /**
   * Persist settings to SQLite.
   */
  save(settings: AtomicSettings, section?: string): void {
    ensureDb();
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO atomic_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(SETTINGS_KEY, JSON.stringify(settings), now);
    publishEvent('settings.changed', 'system', randomUUID(), { section: section ?? 'all' });
  }

  /**
   * Update a sub-section of settings and persist.
   */
  patch<K extends keyof AtomicSettings>(section: K, updates: Partial<AtomicSettings[K]>): AtomicSettings {
    const current = this.load();
    const updated = {
      ...current,
      [section]: deepMerge(current[section] as Record<string, unknown>, updates as Record<string, unknown>),
    } as AtomicSettings;
    this.save(updated, String(section));
    return updated;
  }

  /**
   * Reset all settings to defaults.
   */
  reset(): AtomicSettings {
    const defaults = AtomicStateManager.DEFAULT_SETTINGS;
    this.save(defaults, 'reset');
    return defaults;
  }
}

export const settingsStore = new SettingsStoreImpl();
