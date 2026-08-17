/**
 * src/plugins/engine/registry.ts
 *
 * Engine plugin registry. Built-in plugins are registered in memory and
 * always available; user-installed plugins (uploaded manifests) are added
 * per server restart and validated by the doctor before registration.
 *
 * Distinct from the client-side plugin system (src/plugins/registry.ts,
 * export plugins) — this registry serves the server-side agentic pipelines
 * and the plugin API surface.
 */
import { validateManifest, type DoctorResult } from './doctor';
import { pluginDigest } from './digest';
import { BUILT_IN_PLUGINS } from './builtIns';
import { PIPELINE_MANIFESTS } from './skillPack';
import type { EnginePluginManifest, PluginManifestPublic } from './schema';
import { publicManifest } from './schema';

export interface RegisteredEnginePlugin {
  manifest: EnginePluginManifest;
  digest: string;
  doctor: DoctorResult;
  /** Installation source: 'builtin' or user-provided. */
  source: 'builtin' | 'user';
}

const REGISTRY = new Map<string, RegisteredEnginePlugin>();

function register(manifest: EnginePluginManifest, source: 'builtin' | 'user'): RegisteredEnginePlugin {
  const doctor = validateManifest(manifest);
  const entry: RegisteredEnginePlugin = {
    manifest,
    digest: pluginDigest(manifest),
    doctor,
    source,
  };
  REGISTRY.set(manifest.id, entry);
  return entry;
}

// Boot: register Atomic's own pipeline skill packs + engine built-ins.
for (const manifest of [...PIPELINE_MANIFESTS, ...BUILT_IN_PLUGINS]) {
  register(manifest, 'builtin');
}

export function listPlugins(): RegisteredEnginePlugin[] {
  return [...REGISTRY.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

export function getPlugin(id: string): RegisteredEnginePlugin | undefined {
  return REGISTRY.get(id);
}

/** Public (prompt-body-hidden) view of a plugin for the API. */
export function getPublicPlugin(id: string): { manifest: PluginManifestPublic; digest: string } | undefined {
  const entry = REGISTRY.get(id);
  if (!entry) return undefined;
  return { manifest: publicManifest(entry.manifest), digest: entry.digest };
}

/**
 * Register a user-provided manifest. Validation errors prevent registration
 * entirely (doctor errors are fatal; warnings are preserved and returned).
 */
export function installPlugin(manifest: unknown): { entry?: RegisteredEnginePlugin; doctor: DoctorResult } {
  const doctor = validateManifest(manifest);
  if (!doctor.ok) return { doctor };
  const parsed = manifest as EnginePluginManifest;
  const entry = register(parsed, 'user');
  return { entry, doctor: entry.doctor };
}

export function uninstallPlugin(id: string): boolean {
  const entry = REGISTRY.get(id);
  if (!entry || entry.source === 'builtin') return false;
  REGISTRY.delete(id);
  return true;
}
