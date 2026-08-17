/**
 * src/plugins/registry.ts
 *
 * Plugin registry — loads, enables, disables, and manages all plugins.
 * Plugins are isolated: errors in one plugin never crash another.
 */

import type {
  PluginDefinition, RegisteredPlugin, AnyPlugin as _AnyPlugin, PluginContext, PluginStorage,
  ExportPlugin, IntegrationPlugin, TransformPlugin,
} from './types';
import type { Blueprint, GenerationEvent } from '../sdk/types';

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

type EventHandler = (data: unknown) => void;

// ── Registry ──────────────────────────────────────────────────────────────────

export class PluginRegistry {
  private plugins   = new Map<string, RegisteredPlugin>();
  private listeners = new Map<string, Set<EventHandler>>();

  /** The current active blueprint — updated by the app on navigation */
  private currentBlueprint: Blueprint | null = null;

  /** Notification handler — set by the host app */
  onNotify?: (pluginId: string, message: string, level: 'info' | 'success' | 'warning' | 'error') => void;

  // ── Blueprint pointer ──────────────────────────────────────────────────────

  setBlueprint(bp: Blueprint | null): void {
    this.currentBlueprint = bp;
  }

  // ── Context factory ────────────────────────────────────────────────────────

  private makeContext(pluginId: string): PluginContext {
    return {
      blueprint: this.currentBlueprint,
      emit: (event, data) => this.dispatchEvent(event, data),
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

  // ── Registration ───────────────────────────────────────────────────────────

  /**
   * Register a plugin.
   * If a plugin with the same ID is already registered, it is replaced.
   */
  register(def: PluginDefinition): RegisteredPlugin {
    const { manifest, plugin } = def;
    const existing = this.plugins.get(manifest.id);
    if (existing) {
      this.safeUnload(existing);
    }

    const registered: RegisteredPlugin = {
      manifest,
      plugin,
      enabled:  true,
      loadedAt: new Date().toISOString(),
    };

    this.plugins.set(manifest.id, registered);

    // Call onLoad hook
    const ctx = this.makeContext(manifest.id);
    this.safeCall(manifest.id, 'onLoad', () => plugin.onLoad?.(ctx));

    return registered;
  }

  /** Unregister a plugin by ID */
  unregister(id: string): boolean {
    const reg = this.plugins.get(id);
    if (!reg) return false;
    this.safeUnload(reg);
    this.plugins.delete(id);
    return true;
  }

  private safeUnload(reg: RegisteredPlugin): void {
    const ctx = this.makeContext(reg.manifest.id);
    this.safeCall(reg.manifest.id, 'onUnload', () => reg.plugin.onUnload?.(ctx));
  }

  // ── Enable / disable ───────────────────────────────────────────────────────

  enable(id: string): void {
    const reg = this.plugins.get(id);
    if (reg) reg.enabled = true;
  }

  disable(id: string): void {
    const reg = this.plugins.get(id);
    if (reg) reg.enabled = false;
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
      const ctx = this.makeContext(reg.manifest.id);
      await this.safeCall(reg.manifest.id, 'onGenerate', () => reg.plugin.onGenerate?.(blueprint, ctx));
    }
  }

  /** Notify all enabled plugins of a version creation */
  async notifyVersionCreated(blueprint: Blueprint, versionNumber: number): Promise<void> {
    for (const reg of this.enabled()) {
      const ctx = this.makeContext(reg.manifest.id);
      await this.safeCall(reg.manifest.id, 'onVersionCreated',
        () => reg.plugin.onVersionCreated?.(blueprint, versionNumber, ctx));
    }
  }

  /** Pipe a generation event through all enabled plugins */
  async notifyEvent(event: GenerationEvent): Promise<void> {
    for (const reg of this.enabled()) {
      const ctx = this.makeContext(reg.manifest.id);
      await this.safeCall(reg.manifest.id, 'onEvent', () => reg.plugin.onEvent?.(event, ctx));
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
      const ctx = this.makeContext(reg.manifest.id);
      const result = await this.safeCall<Blueprint>(
        reg.manifest.id, 'transform',
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
    const ctx = this.makeContext(pluginId);
    if (!ctx.blueprint) {
      ctx.notify('No blueprint loaded', 'warning');
      return null;
    }
    const result = await this.safeCall<string | Blob>(
      pluginId, 'execute',
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
    const ctx = this.makeContext(pluginId);
    if (!ctx.blueprint) {
      ctx.notify('No blueprint loaded', 'warning');
      return null;
    }
    const result = await this.safeCall(pluginId, 'push', () => intPlugin.push(ctx.blueprint!, ctx));
    return result ?? null;
  }

  // ── Event bus ──────────────────────────────────────────────────────────────

  dispatchEvent(event: string, data?: unknown): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try { handler(data); } catch (e) { console.error(`[PluginRegistry] event handler error:`, e); }
    }
  }

  // ── Safe call wrapper ──────────────────────────────────────────────────────

  private async safeCall<T>(
    pluginId: string,
    hookName: string,
    fn:       () => T | Promise<T> | undefined,
  ): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      const reg = this.plugins.get(pluginId);
      if (reg) reg.error = String(e);
      console.error(`[Plugin:${pluginId}] Error in hook "${hookName}":`, e);
      return undefined;
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const pluginRegistry = new PluginRegistry();
