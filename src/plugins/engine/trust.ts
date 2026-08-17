/**
 * src/plugins/engine/trust.ts
 *
 * Plugin trust store (OpenDesign trust-and-capabilities model, adapted).
 *
 *   - Every plugin starts `restricted`: its only usable capability is
 *     `prompt:inject` (instructions-only; the runner injects the plugin's
 *     prompts but grants no read/write/outbound access).
 *   - Capabilities can be granted per session: blueprint:read,
 *     blueprint:write, events, api:call. Grants persist in the checkpoint
 *     store and survive restarts.
 *   - Trust binds to pluginId + digest (content-addressed provenance).
 *     If the manifest content changes (digest changes), previously granted
 *     capabilities beyond `prompt:inject` are re-locked until re-granted.
 *   - `trusted` status (e.g. Atomic built-ins) implicitly unlocks all
 *     capabilities regardless of session grants.
 */
import { saveCheckpoint, loadCheckpoint, isValidSessionId } from '../../engine/checkpoint';
import { pluginDigest } from './digest';
import type { EnginePluginManifest } from './schema';

export type GrantableCapability = Exclude<
  import('./schema').EngineCapability,
  'prompt:inject'
>;

export const GRANTABLE_CAPABILITIES: GrantableCapability[] = [
  'blueprint:read',
  'blueprint:write',
  'events',
  'api:call',
];

export interface TrustRecord {
  /** pluginId + digest the grant was made against */
  digest: string;
  granted: GrantableCapability[];
  /** ISO timestamp of the latest grant event */
  grantedAt: string;
}

const TRUST_KEY = 'plugin.trust';

async function loadRecord(
  sessionId: string,
  pluginId: string,
): Promise<TrustRecord | null> {
  return loadCheckpoint<TrustRecord>(sessionId, `${TRUST_KEY}:${pluginId}`);
}

async function saveRecord(
  sessionId: string,
  pluginId: string,
  record: TrustRecord | null,
): Promise<void> {
  if (record) {
    await saveCheckpoint(sessionId, `${TRUST_KEY}:${pluginId}`, record);
  } else {
    // Best-effort delete: checkpoints are append-only in SQLite, so we
    // overwrite with a tombstone marker that the loader treats as "no trust".
    await saveCheckpoint(sessionId, `${TRUST_KEY}:${pluginId}`, { __tombstone: true });
  }
}

/** All currently-trusted plugin ids (never require per-session grants). */
export function trustedPlugins(): string[] {
  return ['builtin:blueprint-reviewer', 'builtin:cost-estimator', 'builtin:quality-ledger-audit'];
}

export function isTrusted(pluginId: string): boolean {
  return trustedPlugins().includes(pluginId);
}

/** Effective capabilities a plugin may use in the given session. */
export async function effectiveCapabilities(
  sessionId: string,
  pluginId: string,
  manifest: EnginePluginManifest,
): Promise<import('./schema').EngineCapability[]> {
  if (isTrusted(pluginId)) return ['prompt:inject', ...GRANTABLE_CAPABILITIES];

  const record = await loadRecord(sessionId, pluginId);
  if (!record || (record as { __tombstone?: boolean }).__tombstone) {
    return ['prompt:inject'];
  }

  const digest = pluginDigest(manifest);
  // Provenance re-lock: granted capabilities only apply when the digest
  // matches what was granted against.
  if (record.digest !== digest) return ['prompt:inject'];
  return ['prompt:inject', ...record.granted];
}

/** Decide whether a specific capability is allowed in this session. */
export async function decideCapability(
  sessionId: string,
  pluginId: string,
  capability: import('./schema').EngineCapability,
  manifest: EnginePluginManifest,
): Promise<boolean> {
  if (capability === 'prompt:inject') return true;
  const caps = await effectiveCapabilities(sessionId, pluginId, manifest);
  return caps.includes(capability);
}

/** Effective trust view for UI/API consumption. */
export async function trustView(
  sessionId: string,
  pluginId: string,
  manifest: EnginePluginManifest,
): Promise<{
  trusted: boolean;
  digest: string;
  granted: GrantableCapability[];
  digestMatches: boolean;
}> {
  const digest = pluginDigest(manifest);
  if (isTrusted(pluginId)) {
    return { trusted: true, digest, granted: [...GRANTABLE_CAPABILITIES], digestMatches: true };
  }
  const record = await loadRecord(sessionId, pluginId);
  if (!record || (record as { __tombstone?: boolean }).__tombstone) {
    return { trusted: false, digest, granted: [], digestMatches: false };
  }
  return {
    trusted: false,
    digest,
    granted: record.granted,
    digestMatches: record.digest === digest,
  };
}

/** Grant one or more capabilities for a session (digest-bound). */
export async function grantTrust(
  sessionId: string,
  pluginId: string,
  capabilities: GrantableCapability[],
  manifest: EnginePluginManifest,
): Promise<GrantableCapability[]> {
  if (!isValidSessionId(sessionId)) throw new Error('Invalid session id');
  if (isTrusted(pluginId)) throw new Error('Built-in trusted plugin — no grants needed');

  const requested = capabilities.filter((c) => GRANTABLE_CAPABILITIES.includes(c));
  if (requested.length !== capabilities.length) {
    throw new Error('One or more requested capabilities are not grantable');
  }
  if (requested.length === 0) throw new Error('No capabilities to grant');

  const record: TrustRecord = {
    digest: pluginDigest(manifest),
    granted: [...requested],
    grantedAt: new Date().toISOString(),
  };
  await saveRecord(sessionId, pluginId, record);
  return requested;
}

/** Revoke all non-default capabilities for a session. */
export async function revokeTrust(sessionId: string, pluginId: string): Promise<void> {
  if (!isValidSessionId(sessionId)) throw new Error('Invalid session id');
  await saveRecord(sessionId, pluginId, null);
}
