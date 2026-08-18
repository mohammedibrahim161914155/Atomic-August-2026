/**
 * src/plugins/types.ts
 *
 * Plugin system type definitions for Atomic.
 *
 * A Plugin is a first-class extension point that can:
 *   - Add custom export formats (e.g. export to Figma, Linear, Notion, Jira)
 *   - Inject data transforms on blueprint generation
 *   - Register UI affordances (action buttons, sidebar panels)
 *   - Subscribe to event bus events and react to pipeline state changes
 */

import type { Blueprint, GenerationEvent } from '../sdk/types';

// ── Plugin metadata ───────────────────────────────────────────────────────────

export interface PluginManifest {
  /** Unique plugin identifier (e.g. 'export-to-linear') */
  id:          string;
  /** Display name shown in the UI */
  name:        string;
  /** Short description shown in the plugin gallery */
  description: string;
  /** Semver string (e.g. '1.0.0') */
  version:     string;
  /** Plugin author */
  author?:     string;
  /** Optional plugin homepage URL */
  homepage?:   string;
  /** Icon name from Lucide (or a URL) */
  icon?:       string;
  /** Plugin category for the gallery */
  category:    PluginCategory;
  /** Required permission scopes */
  permissions: PluginPermission[];
}

export type PluginCategory =
  | 'export'
  | 'import'
  | 'transform'
  | 'integration'
  | 'visualization'
  | 'automation'
  | 'developer';

export type PluginPermission =
  | 'blueprint:read'
  | 'blueprint:write'
  | 'versions:read'
  | 'versions:write'
  | 'skills:read'
  | 'skills:write'
  | 'events:subscribe'
  | 'events:publish'
  | 'network:outbound';

/** Runtime value arrays for manifest validation (Zod enum input). */
export const PLUGIN_CATEGORIES = [
  'export', 'import', 'transform', 'integration', 'visualization', 'automation', 'developer',
] as const satisfies readonly PluginCategory[];

export const PLUGIN_PERMISSIONS = [
  'blueprint:read', 'blueprint:write', 'versions:read', 'versions:write',
  'skills:read', 'skills:write', 'events:subscribe', 'events:publish', 'network:outbound',
] as const satisfies readonly PluginPermission[];

// ── Plugin context ────────────────────────────────────────────────────────────

/** The context object injected into every plugin hook */
export interface PluginContext {
  /** Current active blueprint (null if none loaded) */
  blueprint:   Blueprint | null;
  /** Emit a custom event on the Atomic event bus */
  emit:        (event: string, data?: unknown) => void;
  /** Subscribe to events on the Atomic event bus */
  on:          (event: string, handler: (data: unknown) => void) => () => void;
  /** Show a toast notification in the UI */
  notify:      (message: string, level?: 'info' | 'success' | 'warning' | 'error') => void;
  /** Read plugin-specific persistent storage */
  storage:     PluginStorage;
  /** Logger — prefixed with plugin id */
  log:         (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export interface PluginStorage {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
  clear(): void;
}

// ── Plugin hooks ──────────────────────────────────────────────────────────────

/** Lifecycle hooks a plugin can implement */
export interface PluginHooks {
  /** Called once when the plugin is registered/loaded */
  onLoad?:        (ctx: PluginContext) => void | Promise<void>;
  /** Called when the plugin is unloaded/disabled */
  onUnload?:      (ctx: PluginContext) => void | Promise<void>;
  /** Called after any blueprint generation completes */
  onGenerate?:    (blueprint: Blueprint, ctx: PluginContext) => void | Promise<void>;
  /** Called after a version is created */
  onVersionCreated?: (blueprint: Blueprint, versionNumber: number, ctx: PluginContext) => void | Promise<void>;
  /** Called when a generation event fires (streaming progress) */
  onEvent?:       (event: GenerationEvent, ctx: PluginContext) => void | Promise<void>;
  /** Transform a blueprint before it is saved (return modified copy or original) */
  transformBlueprint?: (blueprint: Blueprint, ctx: PluginContext) => Blueprint | Promise<Blueprint>;
}

// ── Export plugin ──────────────────────────────────────────────────────────────

/** A plugin that adds a new export format */
export interface ExportPlugin extends PluginHooks {
  type:          'export';
  /** Label shown in the export dropdown */
  exportLabel:   string;
  /** MIME type of the exported content */
  exportMime?:   string;
  /** File extension for the downloaded file */
  exportExt?:    string;
  /** Execute the export — return content string or a Blob */
  execute:       (blueprint: Blueprint, ctx: PluginContext) => string | Blob | Promise<string | Blob>;
}

// ── Integration plugin ─────────────────────────────────────────────────────────

/** A plugin that syncs blueprints with an external platform */
export interface IntegrationPlugin extends PluginHooks {
  type:           'integration';
  /** Push a blueprint to the external platform */
  push:           (blueprint: Blueprint, ctx: PluginContext) => Promise<{ url?: string; id?: string }>;
  /** Pull updates from the external platform (optional) */
  pull?:          (externalId: string, ctx: PluginContext) => Promise<Partial<Blueprint>>;
  /** Check connection health */
  healthCheck?:   (ctx: PluginContext) => Promise<{ healthy: boolean; message?: string }>;
}

// ── Transform plugin ───────────────────────────────────────────────────────────

/** A plugin that transforms blueprint data */
export interface TransformPlugin extends PluginHooks {
  type:      'transform';
  transform: (blueprint: Blueprint, ctx: PluginContext) => Blueprint | Promise<Blueprint>;
}

export type AnyPlugin = ExportPlugin | IntegrationPlugin | TransformPlugin;

// ── Plugin definition (full registration object) ─────────────────────────────

export interface PluginDefinition<P extends AnyPlugin = AnyPlugin> {
  manifest: PluginManifest;
  plugin:   P;
}

// ── Plugin registry shape ──────────────────────────────────────────────────────

export interface RegisteredPlugin {
  manifest: PluginManifest;
  plugin:   AnyPlugin;
  enabled:  boolean;
  loadedAt: string;
  error?:   string;
  /** Content-addressed digest over the plugin's behaviour-defining fields */
  digest?:                string;
  /** Doctor warnings from manifest validation (empty array when clean) */
  doctorWarnings?:        string[];
  /** Doctor errors from manifest validation (registration proceeds but is flagged) */
  doctorErrors?:          string[];
  /** Consecutive hook failures — the plugin auto-disables at 3 */
  consecutiveErrors?:     number;
  /** Most recent health-check result (set by checkHealth / checkAllHealth) */
  lastHealth?:            { healthy: boolean; message?: string; checkedAt?: string };
}
