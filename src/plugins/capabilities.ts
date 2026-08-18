/**
 * src/plugins/capabilities.ts
 *
 * Capability gate — maps every plugin hook to the minimum permission set
 * required to invoke it. The registry enforces this table before dispatching
 * any hook: a plugin that declares fewer permissions than its hook requires
 * is denied execution with a precise error (never silently skipped).
 *
 * Design (OpenDesign trust model, Atomic-adapted):
 *   - Permissions are declared up front in the manifest (least privilege).
 *   - Enforcement is centralized here — plugins cannot self-grant access.
 *   - `events:subscribe` is implied for the `on` subscription API; only
 *     `events:publish` gates the `emit` API (publishing is the elevated act).
 *   - The capability table is data-driven so it can be serialized, audited,
 *     and extended without touching dispatch logic.
 */

import { PLUGIN_PERMISSIONS, type PluginPermission } from './types';

/** Hook ids the capability table keys on. */
export type HookId =
  | 'onLoad'
  | 'onUnload'
  | 'onGenerate'
  | 'onVersionCreated'
  | 'onEvent'
  | 'onTransform'
  | 'execute'   // export plugin
  | 'push'      // integration plugin
  | 'pull'      // integration plugin
  | 'healthCheck'
  | 'emit';     // ctx.emit (events:publish)

/** Minimum permissions required to invoke each hook. */
export const HOOK_CAPABILITIES: Record<HookId, readonly PluginPermission[]> = {
  onLoad:           [],
  onUnload:         [],
  onGenerate:       ['blueprint:read'],
  onVersionCreated: ['blueprint:read'],
  onEvent:          [],
  onTransform:      ['blueprint:read'],
  execute:          ['blueprint:read'],
  push:             ['blueprint:read', 'network:outbound'],
  pull:             ['network:outbound'],
  healthCheck:      [],
  emit:             ['events:publish'],
};

/** All permissions a plugin must declare to be granted `blueprint:write`. */
export const WRITE_REQUIRING_PERMISSIONS = ['blueprint:write', 'versions:write', 'skills:write'] as const;

export { PLUGIN_PERMISSIONS };

// ── Capability helpers ────────────────────────────────────────────────────────

/** The full permission vocabulary. */
export const PERMISSION_VOCABULARY = [...PLUGIN_PERMISSIONS];

/**
 * Check whether a declared permission set satisfies the requirements of a hook.
 * Returns the missing permissions (empty array = allowed).
 */
export function checkCapability(
  declared: readonly PluginPermission[],
  hook: HookId,
): readonly PluginPermission[] {
  const required = HOOK_CAPABILITIES[hook];
  return required.filter(p => !declared.includes(p));
}

/**
 * Build a capability-grant error message for a denied hook invocation.
 */
export function capabilityError(
  pluginId: string,
  hook: HookId,
  missing: readonly PluginPermission[],
): string {
  return `plugin '${pluginId}' cannot run hook '${hook}': missing permission${missing.length > 1 ? 's' : ''} ${missing.map(p => `'${p}'`).join(', ')}`;
}
