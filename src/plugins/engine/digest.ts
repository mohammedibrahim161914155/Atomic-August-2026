/**
 * src/plugins/engine/digest.ts
 *
 * Content-addressed plugin digest (OpenDesign provenance pattern).
 *
 * Trust grants bind to `pluginId + digest`, not just a name. When a plugin's
 * resolved content changes (manifest edit, prompt rewrite, capability
 * addition), the digest changes and previously elevated capabilities must be
 * re-confirmed before use.
 *
 * The digest covers the behaviour-defining fields only (id, specVersion,
 * version, capabilities, pipeline), so cosmetic metadata edits (description,
 * tags, author) do not force a re-grant.
 */
import { createHash } from 'node:crypto';
import type { EnginePluginManifest } from './schema';

export function pluginDigest(manifest: EnginePluginManifest): string {
  const body = {
    id: manifest.id,
    specVersion: manifest.specVersion,
    version: manifest.version,
    kind: manifest.kind,
    capabilities: [...(manifest.capabilities ?? [])].sort(),
    pipeline: manifest.pipeline?.stages.map((s) => ({
      id: s.id,
      kind: s.kind,
      max_tokens: s.max_tokens,
      repeat: s.repeat,
      until: s.until ?? null,
      max_iterations: s.max_iterations,
      prompt: s.prompt,
    })),
  };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
}
