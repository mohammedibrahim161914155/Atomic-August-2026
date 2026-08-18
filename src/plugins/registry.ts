/**
 * src/plugins/registry.ts
 *
 * Plugin registry — loads, enables, disables, and manages all plugins.
 * Plugins are isolated: errors in one plugin never crash another.
 *
 * v2.4.0 hardening (engine-plugin parity):
 *   - Manifest doctor validation runs on every registration (errors/warnings
 *     recorded on the RegisteredPlugin entry).
 *   - A content-addressed digest is computed asynchronously per plugin and
 *     exposed on the registry entry (override via `digestFn`).
 *   - Every hook dispatch is capability-gated against the manifest's declared
 *     permissions (central policy table in `src/plugins/capabilities.ts`).
 *   - An error budget (3 consecutive failures) auto-disables misbehaving
 *     plugins to protect the host app.
 *   - Enable/disable state and health-check results persist to localStorage
 *     so preferences survive reloads and registry re-instantiation.
 *   - `checkHealth` / `checkAllHealth` health-check surface for the UI.
 */

import {
  validatePluginDefinition,
} from './doctor';
import { pluginDigest } from './digest';
import {
  checkCapability,
  capabilityError,
  type HookId,
} from './capabilities';
import type {
  PluginDefinition, RegisteredPlugin, PluginContext, PluginStorage,
  ExportPlugin, IntegrationPlugin, TransformPlugin,
} from './types';
import type { Blueprint, GenerationEvent } from '../sdk/types';

// ── Persistence constants ─────────────────────────────────────────────────────

const STATE_KEY = 'atomic_plugin_state';
const HEALTH_PREFIX = 'atomic_plugin_health_';

interface PersistedState {
  [pluginId: string]: { enabled?: boolean };
}

interface PersistedHealth {
  healthy: boolean;
  message?: string;
  checkedAt?: string;
}

// ── In-memory storage per plugin ──────────────────────────────────────────────

function makeStorage(pluginId: string): PluginStorage {
  const prefix = `atomic_plugin_${pluginId}_`;
  return {
    get<T>(key: string): T | null {
      try {
        const raw = localStorage.getItem(`${prefix}${key}`);
        return raw ? JSON.parse(raw) as T : null;
      } catch { return null; }
    },
    set<T>(key: string, value: T): void {
      try { localStorage.setItem(`${prefix}${key}`, JSON.stringify(value)); } catch { /* */ }
    },
    delete(key: string): void {
      try { localStorage.removeItem(`${prefix}${key}`); } catch { /* */ }
    },
    clear(): void {
      try {
        const keys = Object.keys(localStorage).filter(k => k.startsWith(prefix));
        keys.forEach(k => localStorage.removeItem(k));
      } catch { /* */ }
    },
  };
}

// ── Persistence helpers ───────────────────────────────────────────────────────

function loadPersistedState(): PersistedState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? (JSON.parse(raw) as PersistedState) : {};
  } catch { return {}; }
}

function savePersistedState(state: PersistedState): void {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* */ }
}

function loadPersistedHealth(pluginId: string): PersistedHealth | null {
  try {
    const raw = localStorage.getItem(`${HEALTH_PREFIX}${pluginId}`);
    return raw ? (JSON.parse(raw) as PersistedHealth) : null;
  } catch { return null; }
}

function savePersistedHealth(pluginId: string, health: PersistedHealth): void {
  try { localStorage.setItem(`${HEALTH_PREFIX}${pluginId}`, JSON.stringify(health)); } catch { /* */ }
}

type EventHandler = (data: unknown) => void;

// ── Registry ──────────────────────────────────────────────────────────────────

/** The maximum number of consecutive hook failures before a plugin auto-disables. */
export const ERROR_BUDGET = 3;

export class PluginRegistry {
  private plugins   = new Map<string, RegisteredPlugin>();
  private listeners = new Map<string, Set<EventHandler>>();
  private state     = loadPersistedState();

  /** The current active blueprint — updated by the app on navigation */
  private currentBlueprint: Blueprint | null = null;

  /** Notification handler — set by the host app */
  onNotify?: (pluginId: string, message: string, level: 'info' | 'success' | 'warning' | 'error') => void;

  /**
   * Override the default digest computation (tests / custom installations).
   * Default is the content-addressed `pluginDigest` from `./digest`.
   */
  digestFn: (manifest: unknown, plugin: unknown) => Promise<string> = (m, p) =>
    pluginDigest(m as Parameters<typeof pluginDigest>[0], p as Parameters<typeof pluginDigest>[1]);

  // ── Blueprint pointer ──────────────────────────────────────────────────────

  setBlueprint(bp: Blueprint | null): void {
    this.currentBlueprint = bp;
  }

  // ── Context factory ────────────────────────────────────────────────────────

  /**
   * Build the plugin-facing context. `makeContext` is deliberately *not*
   * private: advanced consumers (e.g. nested plugin supervisors, tests) may
   * construct their own context for a registered plugin id.
   */
  makeContext(pluginId: string): PluginContext {
    const reg = this.plugins.get(pluginId);
    const permissions = reg?.manifest.permissions ?? [];
    return {
      blueprint: this.currentBlueprint,
      emit: (event, data) => this.emitFor(pluginId, event, data, permissions),
      on:   (event, handler) => {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event)!.add(handler);
        return () => this.listeners.get(event)?.delete(handler);
      },
      notify: (message, level = 'info') => {
        this.onNotify?.(pluginId, message, level);
      },
      storage: makeStorage(pluginId),
      log: (level, message, data) => {
        const tag = `[Plugin:${pluginId}]`;
        switch (level) {
          case 'debug': console.debug(tag, message, data ?? ''); break;
          case 'info':  console.info(tag, message, data ?? ''); break;
          case 'warn':  console.warn(tag, message, data ?? ''); break;
          case 'error': console.error(tag, message, data ?? ''); break;
        }
      },
    };
  }

  private emitFor(
    pluginId: string,
    event:    string,
    data?:    unknown,
    permissions: readonly string[] = [],
  ): void {
    const missing = checkCapability(
      permissions as Parameters<typeof checkCapability>[0],
      'emit' satisfies HookId,
    );
    if (missing.length > 0) {
      console.warn(capabilityError(pluginId, 'emit' satisfies HookId, missing));
      return;
    }
    this.dispatchEvent(event, data);
  }

  // ── Registration ───────────────────────────────────────────────────────────

  /**
   * Register a plugin.
   * If a plugin with the same ID is already registered, it is replaced.
   * Manifest validation runs on every registration; errors and warnings are
   * recorded on the entry (registration proceeds either way so the UI can
   * surface problems while still offering the plugin).
   */
  register(def: PluginDefinition): RegisteredPlugin {
    const { manifest, plugin } = def;
    const existing = this.plugins.get(manifest.id);
    if (existing) {
      this.safeUnload(existing);
    }

    const doctorResult = validatePluginDefinition(def);
    const persistedHealth = loadPersistedHealth(manifest.id);
    const persistedEnabled = this.state[manifest.id]?.enabled ?? true;

    const registered: RegisteredPlugin = {
      manifest,
      plugin,
      enabled:         persistedEnabled,
      loadedAt:        new Date().toISOString(),
      doctorErrors:    doctorResult.errors,
      doctorWarnings:  doctorResult.warnings,
      consecutiveErrors: 0,
      lastHealth:      persistedHealth ?? undefined,
    };

    this.plugins.set(manifest.id, registered);

    // Fire-and-forget content digest — the entry may render before this
    // resolves; consumers simply see `digest` appear when ready.
    this.digestFn(manifest, plugin)
      .then(digest => { registered.digest = digest; })
      .catch(() => { /* best-effort */ });

    // Call onLoad hook
    const ctx = this.makeContext(manifest.id);
    this.safeCall(manifest.id, 'onLoad' satisfies HookId, () => plugin.onLoad?.(ctx));

    return registered;
  }

  /** Unregister a plugin by ID */
  unregister(id: string): boolean {
    const reg = this.plugins.get(id);
    if (!reg) return false;
    this.safeUnload(reg);
    this.plugins.delete(id);
    const { [id]: _omitted, ...rest } = this.state;
    this.state = rest;
    savePersistedState(this.state);
    return true;
  }

  private safeUnload(reg: RegisteredPlugin): void {
    const ctx = this.makeContext(reg.manifest.id);
    this.safeCall(reg.manifest.id, 'onUnload' satisfies HookId, () => reg.plugin.onUnload?.(ctx));
  }

  // ── Enable / disable ───────────────────────────────────────────────────────

  enable(id: string): void {
    const reg = this.plugins.get(id);
    if (reg) {
      reg.enabled = true;
      this.state[id] = { enabled: true };
      savePersistedState(this.state);
    }
  }

  disable(id: string): void {
    const reg = this.plugins.get(id);
    if (reg) {
      reg.enabled = false;
      this.state[id] = { enabled: false };
      savePersistedState(this.state);
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  all(): RegisteredPlugin[] {
    return Array.from(this.plugins.values());
  }

  get(id: string): RegisteredPlugin | undefined {
    return this.plugins.get(id);
  }

  enabled(): RegisteredPlugin[] {
    return this.all().filter(p => p.enabled);
  }

  byCategory(category: string): RegisteredPlugin[] {
    return this.enabled().filter(p => p.manifest.category === category);
  }

  exports(): (RegisteredPlugin & { plugin: ExportPlugin })[] {
    return this.enabled().filter(
      (p): p is RegisteredPlugin & { plugin: ExportPlugin } =>
        (p.plugin as ExportPlugin).type === 'export',
    );
  }

  integrations(): (RegisteredPlugin & { plugin: IntegrationPlugin })[] {
    return this.enabled().filter(
      (p): p is RegisteredPlugin & { plugin: IntegrationPlugin } =>
        (p.plugin as IntegrationPlugin).type === 'integration',
    );
  }

  // ── Hook dispatch ──────────────────────────────────────────────────────────

  /** Notify all enabled plugins of a new blueprint */
  async notifyGenerate(blueprint: Blueprint): Promise<void> {
    this.currentBlueprint = blueprint;
    for (const reg of this.enabled()) {
      if (this.isGated(reg, 'onGenerate')) continue;
      const ctx = this.makeContext(reg.manifest.id);
      await this.safeCall(reg.manifest.id, 'onGenerate' satisfies HookId, () => reg.plugin.onGenerate?.(blueprint, ctx));
    }
  }

  /** Notify all enabled plugins of a version creation */
  async notifyVersionCreated(blueprint: Blueprint, versionNumber: number): Promise<void> {
    for (const reg of this.enabled()) {
      if (this.isGated(reg, 'onVersionCreated')) continue;
      const ctx = this.makeContext(reg.manifest.id);
      await this.safeCall(reg.manifest.id, 'onVersionCreated' satisfies HookId,
        () => reg.plugin.onVersionCreated?.(blueprint, versionNumber, ctx));
    }
  }

  /** Pipe a generation event through all enabled plugins */
  async notifyEvent(event: GenerationEvent): Promise<void> {
    for (const reg of this.enabled()) {
      if (this.isGated(reg, 'onEvent')) continue;
      const ctx = this.makeContext(reg.manifest.id);
      await this.safeCall(reg.manifest.id, 'onEvent' satisfies HookId, () => reg.plugin.onEvent?.(event, ctx));
    }
  }

  /** Run all transform plugins on a blueprint in sequence */
  async applyTransforms(blueprint: Blueprint): Promise<Blueprint> {
    let current = blueprint;
    const transforms = this.enabled().filter(
      (p): p is RegisteredPlugin & { plugin: TransformPlugin } =>
        (p.plugin as TransformPlugin).type === 'transform',
    );
    for (const reg of transforms) {
      if (this.isGated(reg, 'onTransform')) continue;
      const ctx = this.makeContext(reg.manifest.id);
      const result = await this.safeCall<Blueprint>(
        reg.manifest.id, 'onTransform' satisfies HookId,
        () => reg.plugin.transformBlueprint?.(current, ctx) ?? Promise.resolve(current),
      );
      if (result) current = result;
    }
    return current;
  }

  /** Run an export plugin by ID */
  async runExport(pluginId: string): Promise<string | Blob | null> {
    const reg = this.plugins.get(pluginId);
    if (!reg || !reg.enabled) return null;
    const exportPlugin = reg.plugin as ExportPlugin;
    if (exportPlugin.type !== 'export') return null;
    if (this.isGated(reg, 'execute')) return null;
    const ctx = this.makeContext(pluginId);
    if (!ctx.blueprint) {
      ctx.notify('No blueprint loaded', 'warning');
      return null;
    }
    const result = await this.safeCall<string | Blob>(
      pluginId, 'execute' satisfies HookId,
      () => exportPlugin.execute(ctx.blueprint!, ctx),
    );
    return result ?? null;
  }

  /** Run an integration plugin push by ID */
  async runPush(pluginId: string): Promise<{ url?: string; id?: string } | null> {
    const reg = this.plugins.get(pluginId);
    if (!reg || !reg.enabled) return null;
    const intPlugin = reg.plugin as IntegrationPlugin;
    if (intPlugin.type !== 'integration') return null;
    if (this.isGated(reg, 'push')) return null;
    const ctx = this.makeContext(pluginId);
    if (!ctx.blueprint) {
      ctx.notify('No blueprint loaded', 'warning');
      return null;
    }
    const result = await this.safeCall(pluginId, 'push' satisfies HookId, () => intPlugin.push(ctx.blueprint!, ctx));
    return result ?? null;
  }

  /** Pull partial blueprint content from an integration plugin */
  async runPull(pluginId: string, externalId: string): Promise<Partial<Blueprint> | null> {
    const reg = this.plugins.get(pluginId);
    if (!reg || !reg.enabled) return null;
    const intPlugin = reg.plugin as IntegrationPlugin;
    if (intPlugin.type !== 'integration' || !intPlugin.pull) return null;
    if (this.isGated(reg, 'pull')) return null;
    const ctx = this.makeContext(pluginId);
    const result = await this.safeCall(pluginId, 'pull' satisfies HookId, () => intPlugin.pull!(externalId, ctx));
    return result ?? null;
  }

  // ── Health checks ──────────────────────────────────────────────────────────

  /**
   * Run a health check for one plugin and cache the result on the entry and
   * in localStorage (restored by future registry instances).
   */
  async checkHealth(pluginId: string): Promise<{ healthy: boolean; message: string }> {
    const reg = this.plugins.get(pluginId);
    const fallback = { healthy: false, message: 'plugin not found' };
    if (!reg) return fallback;

    let result: { healthy: boolean; message?: string };

    const integration = reg.plugin as IntegrationPlugin;
    if (integration.type === 'integration' && typeof integration.healthCheck === 'function') {
      const ctx = this.makeContext(pluginId);
      try {
        result = await integration.healthCheck(ctx);
      } catch (e) {
        result = { healthy: false, message: `health check threw: ${String(e)}` };
      }
    } else if ((reg.plugin as ExportPlugin).type === 'export') {
      // Export plugins are healthy when their execute path can produce content
      // for a loaded blueprint — no side effects are triggered.
      if (!this.currentBlueprint) {
        result = { healthy: true, message: 'plugin loaded (no blueprint loaded to export)' };
      } else {
        const content = await this.runExport(pluginId);
        result = {
          healthy: content !== null,
          message: content !== null ? 'export path healthy' : 'export path produced no content',
        };
      }
    } else {
      result = { healthy: true, message: 'plugin loaded' };
    }

    const health = {
      healthy:   result.healthy,
      message:   result.message ?? (result.healthy ? 'healthy' : 'unhealthy'),
      checkedAt: new Date().toISOString(),
    };
    reg.lastHealth = health;
    savePersistedHealth(pluginId, health);
    return { healthy: health.healthy, message: health.message };
  }

  /** Run health checks for every registered plugin */
  async checkAllHealth(): Promise<Record<string, { healthy: boolean; message: string }>> {
    const results: Record<string, { healthy: boolean; message: string }> = {};
    for (const reg of this.all()) {
      results[reg.manifest.id] = await this.checkHealth(reg.manifest.id);
    }
    return results;
  }

  // ── Event bus ──────────────────────────────────────────────────────────────

  dispatchEvent(event: string, data?: unknown): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try { handler(data); } catch (e) { console.error(`[PluginRegistry] event handler error:`, e); }
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private isGated(reg: RegisteredPlugin, hook: HookId): boolean {
    const missing = checkCapability(reg.manifest.permissions, hook);
    if (missing.length > 0) {
      console.error(capabilityError(reg.manifest.id, hook, missing));
      this.recordFailure(reg.manifest.id);
      return true;
    }
    return false;
  }

  private recordFailure(pluginId: string): void {
    const reg = this.plugins.get(pluginId);
    if (!reg) return;
    reg.consecutiveErrors = (reg.consecutiveErrors ?? 0) + 1;
    if (reg.consecutiveErrors >= ERROR_BUDGET) {
      console.warn(
        `[Plugin:${pluginId}] error budget exhausted (${reg.consecutiveErrors} consecutive failures); disabling`,
      );
      reg.enabled = false;
      this.state[pluginId] = { enabled: false };
      savePersistedState(this.state);
    }
  }

  /** Mark a successful hook call — resets the error budget for that plugin. */
  private recordSuccess(pluginId: string): void {
    const reg = this.plugins.get(pluginId);
    if (reg) reg.consecutiveErrors = 0;
  }

  // ── Safe call wrapper ──────────────────────────────────────────────────────

  private async safeCall<T>(
    pluginId: string,
    hookName: HookId,
    fn:       () => T | Promise<T> | undefined,
  ): Promise<T | undefined> {
    try {
      const result = await fn();
      this.recordSuccess(pluginId);
      return result;
    } catch (e) {
      this.recordFailure(pluginId);
      const reg = this.plugins.get(pluginId);
      if (reg) reg.error = String(e);
      console.error(`[Plugin:${pluginId}] Error in hook "${hookName}":`, e);
      return undefined;
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const pluginRegistry = new PluginRegistry();
