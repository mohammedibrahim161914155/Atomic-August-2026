/**
 * src/engine/permissionRegistry.ts
 *
 * Operation permission tiers — the OpenAI Codex pattern (codex-rs
 * execpolicy tiers: prompt / ask / eoff / full-auto) combined with Kilo
 * Code's per-tool permission grants (packages/core/src/permission/).
 *
 * Atomic's "tools" are pipeline operations. Each operation (generate, repair,
 * rerun-pillar, steer, plan, compact) is assigned a tier:
 *
 *   - 'full-auto' : may execute without any approval (default for baseline
 *                   pipeline operations — Atomic is an offline blueprint
 *                   generator, so the baseline cost/reputation risk is low).
 *   - 'ask'       : must be gated by the UI/operator before executing.
 *                   The pipeline emits a `permission.ask` SSE event and the
 *                   caller supplies approval via approveOperation.
 *   - 'deny'      : never executes (hard policy, e.g. for disallowed models
 *                   or disabled pipeline stages).
 *
 * The registry ships with sensible defaults (everything baseline is
 * full-auto, high-cost operations start as full-auto too — Atomic generates
 * text, not filesystem mutations) and exposes per-operation overrides that
 * persist via the existing checkpoint store. This mirrors Codex's
 * ~/.codex/config.json permission config.
 */

import { saveCheckpoint, loadCheckpoint } from './checkpoint';

// ── Types ─────────────────────────────────────────────────────────────────────

export type OperationTier = 'full-auto' | 'ask' | 'deny';

export type PipelineOperation =
  | 'generate'
  | 'repair'
  | 'rerun-pillar'
  | 'steer'
  | 'plan'
  | 'compact'
  | 'verifier-loop'
  | 'snapshot'
  | 'undo';

export interface PermissionGrant {
  operation: PipelineOperation;
  /** Per-session override ('full-auto' | 'ask' | 'deny'). */
  tier: OperationTier;
}

export type PermissionDecision = 'allowed' | 'ask' | 'denied';

// ── Defaults ──────────────────────────────────────────────────────────────────

/**
 * Default tiers per operation. Codex's execpolicy starts at 'prompt' for
 * baseline tools and escalates; Atomic's inverse-risk profile starts
 * everything at full-auto because operations mutate generated text only.
 */
export const DEFAULT_OPERATION_TIERS: Record<PipelineOperation, OperationTier> = {
  generate: 'full-auto',
  repair: 'full-auto',
  'rerun-pillar': 'full-auto',
  steer: 'full-auto',
  plan: 'full-auto',
  compact: 'full-auto',
  'verifier-loop': 'full-auto',
  snapshot: 'full-auto',
  undo: 'full-auto',
};

const PERMS_PREFIX = 'perms:';

// ── Core API ──────────────────────────────────────────────────────────────────

/**
 * Resolve the effective tier for an operation: session override → global
 * override (checkpoint key 'perms:global') → default.
 */
export async function resolveTier(
  session: string | null,
  operation: PipelineOperation,
): Promise<OperationTier> {
  if (session) {
    const overrides = await loadCheckpoint<Record<string, OperationTier>>(session, `${PERMS_PREFIX}overrides`);
    if (overrides && overrides[operation]) return overrides[operation]!;
  }
  const global = await loadCheckpoint<Record<string, OperationTier>>(null as unknown as string, `${PERMS_PREFIX}global`);
  if (global && global[operation]) return global[operation]!;
  return DEFAULT_OPERATION_TIERS[operation];
}

/** Decide whether an operation may proceed right now. */
export async function decidePermission(
  session: string | null,
  operation: PipelineOperation,
): Promise<{ decision: PermissionDecision; tier: OperationTier }> {
  const tier = await resolveTier(session, operation);
  const decision: PermissionDecision =
    tier === 'deny' ? 'denied' : tier === 'ask' ? 'ask' : 'allowed';
  return { decision, tier };
}

/**
 * Override the tier for one operation (session-scoped when a session is
 * given, otherwise global). Persisted in the checkpoint store so settings
 * survive restarts.
 */
export async function setOperationTier(
  session: string | null,
  operation: PipelineOperation,
  tier: OperationTier,
): Promise<OperationTier> {
  if (session) {
    const overrides =
      (await loadCheckpoint<Record<string, OperationTier>>(session, `${PERMS_PREFIX}overrides`)) ?? {};
    overrides[operation] = tier;
    await saveCheckpoint(session, `${PERMS_PREFIX}overrides`, overrides);
    return tier;
  }
  const global =
    (await loadCheckpoint<Record<string, OperationTier>>(null as unknown as string, `${PERMS_PREFIX}global`)) ?? {};
  global[operation] = tier;
  await saveCheckpoint(null as unknown as string, `${PERMS_PREFIX}global`, global);
  return tier;
}

/** Read every effective tier (session overrides merged over global over defaults). */
export async function listEffectiveTiers(session: string | null): Promise<
  Array<{ operation: PipelineOperation; tier: OperationTier }>
> {
  const out: Array<{ operation: PipelineOperation; tier: OperationTier }> = [];
  for (const op of Object.keys(DEFAULT_OPERATION_TIERS) as PipelineOperation[]) {
    out.push({ operation: op, tier: await resolveTier(session, op) });
  }
  return out;
}

/** Approval for an operation pending an 'ask' decision. */
export async function approveOperation(
  session: string,
  operation: PipelineOperation,
): Promise<PermissionDecision> {
  const tier = await resolveTier(session, operation);
  if (tier === 'deny') return 'denied';
  return 'allowed';
}
