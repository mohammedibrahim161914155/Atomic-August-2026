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

// ── Built-in plugin imports ───────────────────────────────────────────────────

import { exportMarkdownPlugin } from './built-in/export-markdown';
import { exportLinearPlugin    } from './built-in/export-linear';
import { exportNotionPlugin    } from './built-in/export-notion';
import { pluginRegistry        } from './registry';

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
