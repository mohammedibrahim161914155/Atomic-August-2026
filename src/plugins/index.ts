/**
 * src/plugins/index.ts
 *
 * Plugin system entry point — registers all built-in plugins.
 *
 * @example
 * ```typescript
 * import { pluginRegistry, initBuiltInPlugins } from './plugins';
 *
 * // Initialize once at app startup
 * initBuiltInPlugins();
 *
 * // Use the registry
 * const exports = pluginRegistry.exports();
 * const result  = await pluginRegistry.runExport('built-in/export-markdown');
 * ```
 */

export { pluginRegistry, PluginRegistry } from './registry';

export type {
  PluginManifest,
  PluginCategory,
  PluginPermission,
  PluginContext,
  PluginStorage,
  PluginHooks,
  ExportPlugin,
  IntegrationPlugin,
  TransformPlugin,
  AnyPlugin,
  PluginDefinition,
  RegisteredPlugin,
} from './types';

// ── Platform re-exports (v2.4.0 hardened plugin platform) ─────────────────────
// These modules form the shared plugin platform reused by the client plugin
// system: Zod manifest/definition doctor validation, content-addressed digests,
// capability gating for hooks, retryable HTTP, and typed plugin configuration.

export {
  validateManifest,
  validatePluginDefinition,
  doctor,
  ClientPluginManifestSchema,
  TRUSTED_BUILTIN_IDS,
} from './doctor';

export { pluginDigest } from './digest';

export {
  checkCapability,
  capabilityError,
  HOOK_CAPABILITIES,
  PERMISSION_VOCABULARY,
} from './capabilities';

export {
  requestWithRetry,
  postJson,
  getJson,
  parseRetryAfter,
  backoffDelay,
  HttpRetryExhaustedError,
  setJitterSource,
} from './http';

export {
  validatePluginConfig,
  LinearConfigSchema,
  NotionConfigSchema,
  MarkdownConfigSchema,
  BUILT_IN_CONFIG_SCHEMAS,
} from './config';

// ── Built-in plugin imports ───────────────────────────────────────────────────

import { exportMarkdownPlugin } from './built-in/export-markdown';
import { exportLinearPlugin    } from './built-in/export-linear';
import { exportNotionPlugin    } from './built-in/export-notion';
import { pluginRegistry        } from './registry';
import type { Blueprint as SdkBlueprint } from '../sdk/types';

/**
 * v2.4.0 — adapt the engine's internal blueprint shape (which predates the SDK
 * client model) to the SDK `Blueprint` interface consumed by the client plugin
 * platform (`registry.setBlueprint`, `runExport` / `runPush`). Missing fields
 * are filled with sensible defaults so the SDK model stays the single source
 * of truth for plugins while the engine keeps its own schema.
 */
export function toSdkBlueprint(engineBlueprint: {
  id:              string;
  prompt?:         string;
  quality_score?:  number;
  created_at?:     string;
  intent?:         { product_name?: string; [key: string]: unknown };
  sections?:       Record<string, string>;
  [key: string]:   unknown;
}): SdkBlueprint {
  return {
    id:            engineBlueprint.id,
    prompt:        (engineBlueprint.prompt as string) ?? '',
    mode:          ((engineBlueprint.mode as SdkBlueprint['mode']) ?? 'safe') as SdkBlueprint['mode'],
    quality_score: (typeof engineBlueprint.quality_score === 'number' ? engineBlueprint.quality_score : 0),
    created_at:    (engineBlueprint.created_at as string) ?? new Date().toISOString(),
    intent:        (engineBlueprint.intent as SdkBlueprint['intent']) ?? {},
    sections:      (engineBlueprint.sections as Record<string, string>) ?? {},
    pillars:       (engineBlueprint.pillars as SdkBlueprint['pillars']) ?? {},
  };
}

export { exportMarkdownPlugin, exportLinearPlugin, exportNotionPlugin };

/**
 * Register all built-in plugins.
 * Call this once at app startup (e.g. in main.tsx or App.tsx).
 */
export function initBuiltInPlugins(): void {
  pluginRegistry.register(exportMarkdownPlugin);
  pluginRegistry.register(exportLinearPlugin);
  pluginRegistry.register(exportNotionPlugin);
}
