/**
 * src/plugins/doctor.ts
 *
 * Client-side plugin manifest validation (mirrors the engine plugin doctor,
 * `src/plugins/engine/doctor.ts`). The Zod schema expresses the grammar; the
 * doctor expresses the cross-field rules the grammar cannot:
 *
 *   - Plugin ids follow the namespaced convention (`scope/name`) and must be
 *     URL-safe kebab-case / dotted identifiers.
 *   - Version must be strict semver (x.y.z).
 *   - Export plugins MUST declare `exportLabel` and an `execute` hook;
 *     integration plugins MUST declare `push`.
 *   - Declared permissions must belong to the v2 permission vocabulary.
 *   - `network:outbound` is a WARNING-level concern for pure export plugins
 *     that produce local content (they should not need network access).
 *   - Unknown permissions are WARNINGS (not errors), so forward spec patches
 *     can introduce new permissions without breaking existing installs
 *     (OpenDesign-style forward compatibility).
 *
 * This module is safe for both browser and Node (no node: imports).
 */

import { z } from 'zod';
import { PLUGIN_CATEGORIES, PLUGIN_PERMISSIONS, type PluginCategory, type PluginPermission } from './types';

// ── Schema ────────────────────────────────────────────────────────────────────

/** Strict semver: x.y.z, each component 0–999. */
const SEMVER = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Plugin id: optional `scope/` namespace prefix followed by a dotted,
 * URL-safe kebab-case name (e.g. `built-in/export-markdown`).
 */
const PLUGIN_ID = /^([a-z][a-z0-9_-]{1,24}\/)?[a-z][a-z0-9._-]{1,95}$/;

/** Namespaces that are reserved for built-in plugins shipped with Atomic. */
const BUILT_IN_NAMESPACES = new Set(['built-in', 'builtin', 'atomic']);

/**
 * Trusted built-in plugin ids permitted to live in the reserved namespace.
 * Third-party plugins using `built-in/` are rejected below.
 */
export const TRUSTED_BUILTIN_IDS = new Set([
  'built-in/export-markdown',
  'built-in/export-linear',
  'built-in/export-notion',
]);

export const ClientPluginManifestSchema = z.object({
  id:          z.string().min(3).max(120).regex(PLUGIN_ID, 'plugin id must be a scoped kebab-case identifier, e.g. "built-in/export-markdown"'),
  name:        z.string().min(2).max(120),
  description: z.string().min(10).max(1000),
  version:     z.string().regex(SEMVER, 'version must be strict semver (x.y.z)'),
  author:      z.string().max(120).optional(),
  homepage:    z.string().url().optional(),
  icon:        z.string().max(64).optional(),
  category:    z.enum(PLUGIN_CATEGORIES),
  permissions: z.array(z.string()).min(0).max(20),
});

export interface DoctorResult {
  ok:        boolean;
  errors:    string[];
  warnings:  string[];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate an arbitrary manifest-shaped value against the schema and the
 * cross-field doctor rules. Returns `{ ok, errors, warnings }`.
 */
export function validateManifest(value: unknown): DoctorResult {
  const parsed = ClientPluginManifestSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok:       false,
      warnings: [],
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
      ),
    };
  }
  // doctor() requires the fully parsed (schema-inferred) shape, but we only
  // need id/category for the cross-field checks below, so narrow safely.
    return doctor(parsed.data);
}

const PERMISSION_SET = new Set(PLUGIN_PERMISSIONS);

/**
 * Cross-field doctor rules. Operates on a schema-clean manifest and returns
 * additional errors plus advisory warnings.
 */
export function doctor(manifest: z.infer<typeof ClientPluginManifestSchema>): DoctorResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Namespace ownership ────────────────────────────────────────────────
  const [namespace] = manifest.id.split('/');
  if (namespace && BUILT_IN_NAMESPACES.has(namespace) && !TRUSTED_BUILTIN_IDS.has(manifest.id)) {
    errors.push(
      `plugin id '${manifest.id}' uses a built-in namespace ('${namespace}/'); ` +
      `third-party plugins must use their own namespace (e.g. 'acme/my-plugin')`,
    );
  }

  // ── Permission vocabulary ──────────────────────────────────────────────
  const unique = new Set<string>();
  for (const perm of manifest.permissions) {
    if (!PERMISSION_SET.has(perm as PluginPermission)) {
      warnings.push(`permission '${perm}' is not in the v2 vocabulary; surface this to the operator`);
    }
    if (unique.has(perm)) {
      warnings.push(`permission '${perm}' is declared more than once`);
    }
    unique.add(perm);
  }

  // ── Category / permission coherence ────────────────────────────────────
  if (manifest.category === 'integration' && !manifest.permissions.includes('network:outbound')) {
    warnings.push(
      `category '${manifest.category}' usually requires the 'network:outbound' permission; verify the manifest`,
    );
  }

  if (manifest.category === 'export' && manifest.permissions.includes('blueprint:write')) {
    warnings.push(
      `category '${manifest.category}' declares 'blueprint:write' but exports should be read-only over the blueprint`,
    );
  }

  if (manifest.category === 'visualization' && manifest.permissions.includes('network:outbound')) {
    warnings.push(
      `category '${manifest.category}' declares 'network:outbound' but visualization plugins should not need network access`,
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Validate a full PluginDefinition (manifest + plugin shape).
 *
 * - The manifest must pass `validateManifest`.
 * - Export plugins must declare `execute` and an `exportLabel`.
 * - Integration plugins must declare `push` and `type === 'integration'`.
 * - Transform plugins must declare `transform` and `type === 'transform'`.
 */
export function validatePluginDefinition(value: unknown): DoctorResult {
  if (!value || typeof value !== 'object') {
    return { ok: false, errors: ['plugin definition must be an object with { manifest, plugin }'], warnings: [] };
  }
  const def = value as { manifest?: unknown; plugin?: unknown };
  if (!def.manifest || !def.plugin) {
    return { ok: false, errors: ['plugin definition must contain both "manifest" and "plugin"'], warnings: [] };
  }
  const manifestResult = validateManifest(def.manifest);
  // manifest.category is only consulted when the schema validation passed;
  // fall back to an empty string otherwise so category-coherence warnings
  // are simply skipped on manifests that are already invalid.
  const manifest = manifestResult.ok
    ? (def.manifest as { id?: string; category?: string })
    : { id: undefined, category: '' };

  const plugin = def.plugin as { type?: string; execute?: unknown; push?: unknown; transformBlueprint?: unknown; transform?: unknown; exportLabel?: unknown; exportMime?: unknown };
  const errors = [...manifestResult.errors];
  const warnings = [...manifestResult.warnings];

  switch (plugin.type) {
    case 'export':
      if (typeof plugin.execute !== 'function') errors.push('plugin.execute is required for export plugins');
      if (typeof plugin.exportLabel !== 'string' || plugin.exportLabel.length === 0) errors.push('plugin.exportLabel is required for export plugins');
      if (typeof plugin.exportMime === 'string' && !/^[\w/.+*-]+$/.test(plugin.exportMime)) {
        warnings.push(`exportMime '${plugin.exportMime}' does not look like a valid MIME type`);
      }
      if (manifest.category !== 'export') {
        warnings.push(`plugin.type 'export' declared under category '${manifest.category}' — category should be 'export'`);
      }
      break;
    case 'integration':
      if (typeof plugin.push !== 'function') errors.push('plugin.push is required for integration plugins');
      if (manifest.category !== 'integration') {
        warnings.push(`plugin.type 'integration' declared under category '${manifest.category}' — category should be 'integration'`);
      }
      break;
    case 'transform':
      if (typeof plugin.transformBlueprint !== 'function') errors.push('plugin.transformBlueprint is required for transform plugins');
      if (manifest.category !== 'transform') {
        warnings.push(`plugin.type 'transform' declared under category '${manifest.category}' — category should be 'transform'`);
      }
      break;
    default:
      errors.push(`plugin.type must be one of 'export' | 'integration' | 'transform' (got '${plugin.type ?? 'undefined'}')`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Type-only helper so callers can narrow after `validateManifest` succeeds. */
export type ClientPluginManifest = z.infer<typeof ClientPluginManifestSchema>;

export type { PluginCategory, PluginPermission };
