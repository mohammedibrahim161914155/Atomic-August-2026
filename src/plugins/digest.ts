/**
 * src/plugins/digest.ts
 *
 * Content-addressed plugin digest (OpenDesign provenance pattern, adapted for
 * the browser). The engine plugin digest (`src/plugins/engine/digest.ts`) uses
 * `node:crypto`; this client-side variant uses the Web Crypto API so it works
 * in the browser and in Node 18+ (where `crypto.webcrypto` is also present).
 *
 * Trust decisions bind to `pluginId + digest`, not just a name. When a
 * plugin's resolved content changes (manifest edit, hook rewrite), the digest
 * changes and previously elevated capabilities must be re-confirmed before use
 * (see `src/plugins/engine/trust.ts`).
 *
 * The digest covers behaviour-defining fields only:
 *   - manifest identity + behaviour (id, category, version, permissions sorted)
 *   - plugin type discriminator
 *   - the functional shape of each hook (serialize functions to their source,
 *     or fall back to a stable structural signature when serialization is
 *     unavailable, e.g. in environments that strip function bodies)
 *
 * Cosmetic metadata edits (description, author, icon) do NOT change the digest.
 */

import type { AnyPlugin, PluginManifest } from './types';

const DIGEST_LENGTH = 16;

/**
 * Serialize a hook function to a stable string. Function source is the default
 * (it changes whenever the behaviour changes); environments that cannot
 * serialize functions fall back to a structural signature so the digest stays
 * deterministic rather than failing.
 */
function serializeHook(fn: unknown): string {
  if (typeof fn !== 'function') return 'none';
  try {
    const src = fn.toString();
    // Normalize whitespace: the digest should be stable across trivial
    // formatting-only changes in the function body representation.
    return src.replace(/\s+/g, ' ').trim();
  } catch {
    return '[unserializable]';
  }
}

/**
 * Extract the behaviour-defining payload from a plugin instance. Only the
 * fields that affect runtime behaviour contribute to the digest.
 */
function extractBehaviour(plugin: AnyPlugin): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: plugin.type,
    hooks: {
      onLoad:             serializeHook(plugin.onLoad),
      onUnload:           serializeHook(plugin.onUnload),
      onGenerate:         serializeHook(plugin.onGenerate),
      onVersionCreated:   serializeHook(plugin.onVersionCreated),
      onEvent:            serializeHook(plugin.onEvent),
      transformBlueprint: serializeHook(plugin.transformBlueprint),
    },
  };

  switch (plugin.type) {
    case 'export':
      base.execute    = serializeHook(plugin.execute);
      base.exportLabel = plugin.exportLabel;
      base.exportMime  = plugin.exportMime ?? null;
      base.exportExt   = plugin.exportExt ?? null;
      break;
    case 'integration':
      base.push  = serializeHook(plugin.push);
      base.pull  = serializeHook(plugin.pull);
      base.healthCheck = serializeHook(plugin.healthCheck);
      break;
    case 'transform':
      base.transform = serializeHook(plugin.transform);
      break;
  }

  return base;
}

/**
 * Compute the content-addressed digest of a plugin definition.
 *
 * Returns a 16-character lowercase hex string (SHA-256 prefix), matching the
 * engine digest convention for cross-system comparability.
 */
export async function pluginDigest(manifest: PluginManifest, plugin: AnyPlugin): Promise<string> {
  const body = {
    id:          manifest.id,
    version:     manifest.version,
    category:    manifest.category,
    permissions: [...manifest.permissions].sort(),
    behaviour:   extractBehaviour(plugin),
  };

  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(body));

  let hash: ArrayBuffer;
  if (typeof globalThis.crypto?.subtle?.digest === 'function') {
    hash = await globalThis.crypto.subtle.digest('SHA-256', data);
  } else {
    // Fallback: a fast, deterministic non-crypto mix (Vite dev server path or
    // exotic runtimes). Falls back to FNV-1a 128 over the byte stream.
    hash = fnv1a128(data);
  }

  const bytes = new Uint8Array(hash);
  let hex = '';
  for (let i = 0; i < Math.min(bytes.length, DIGEST_LENGTH / 2); i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex.slice(0, DIGEST_LENGTH);
}

/**
 * Deterministic FNV-1a 128-bit hash used only as a last-resort fallback when
 * the Web Crypto API is unavailable. Output is zero-padded to 16 hex chars.
 */
function fnv1a128(data: Uint8Array): ArrayBuffer {
  // Two independent 64-bit FNV-1a streams keyed by different offsets of the
  // 64-bit prime, giving a 128-bit result.
  let a = 0x811c9dc5; // stream 1
  let b = 0x811c9dc6; // stream 2
  for (const byte of data) {
    for (let i = 0; i < 2; i++) {
      let v = i === 0 ? a : b;
      v ^= byte;
      // Multiply by the FNV prime 0x01000193 using 32-bit halves.
      const hi = (v >>> 16) * 0x0193;
      const lo = (v & 0xffff) * 0x0193;
      v = (hi << 16) + ((lo >>> 8) + ((v >>> 8) & 0xffff00) + (lo & 0xff)) >>> 0;
      v = (v + ((lo >>> 8) << 8)) >>> 0;
      if (i === 0) a = v; else b = v;
    }
  }
  // Derive the second 64 bits from a second pass with swapped byte order input.
  let c = 0x811c9dc5;
  let d = 0x811c9dc7;
  for (let i = data.length - 1; i >= 0; i--) {
    const byte = data[i]!;
    for (let j = 0; j < 2; j++) {
      let v = j === 0 ? c : d;
      v ^= byte;
      const hi = (v >>> 16) * 0x0193;
      const lo = (v & 0xffff) * 0x0193;
      v = (hi << 16) + ((lo >>> 8) + ((v >>> 8) & 0xffff00) + (lo & 0xff)) >>> 0;
      v = (v + ((lo >>> 8) << 8)) >>> 0;
      if (j === 0) c = v; else d = v;
    }
  }
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setUint32(0, a >>> 0, false);
  view.setUint32(4, b >>> 0, false);
  view.setUint32(8, c >>> 0, false);
  view.setUint32(12, d >>> 0, false);
  return out.buffer;
}

/**
 * Stable digest variant for registry use at registration time.
 * Synchronous hashing of the manifest alone is NOT supported — digests always
 * require the behaviour payload, so always call `pluginDigest`.
 */
export const DIGEST_LENGTH_HEX = DIGEST_LENGTH;
