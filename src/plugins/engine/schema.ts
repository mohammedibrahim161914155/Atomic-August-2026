/**
 * src/plugins/engine/schema.ts
 *
 * Atomic engine plugin manifest schema (v1) — the OpenDesign coverage,
 * mapped onto Atomic's server-side pipeline domain.
 *
 * An engine plugin declares:
 *   - identity + metadata (id, specVersion, name, version, author, license)
 *   - typed input forms (od.inputs analogue)
 *   - an ordered pipeline of stages, each optionally `repeat: true` with
 *     an `until` expression (od.pipeline analogue)
 *   - a capability list the plugin requires (od.trust analogue)
 *   - a skippable flag so the pipeline runner can omit it under time
 *     pressure (budget-aware runs)
 *
 * This is a pure data schema — it never touches the filesystem.
 */
import { z } from 'zod';

// ── Capability vocabulary (OpenDesign trust model, Atomic-adapted) ────────────

export const ENGINE_CAPABILITIES = [
  'prompt:inject',   // default for restricted plugins — inject instructions
  'blueprint:read',  // read the session blueprint
  'blueprint:write', // write/patch blueprint sections
  'events',          // emit plugin.* SSE events
  'api:call',        // call an outbound API (exporter integrations)
] as const;

export type EngineCapability = (typeof ENGINE_CAPABILITIES)[number];

export const EngineCapabilitySchema = z
  .enum([...ENGINE_CAPABILITIES])
  .describe('Canonical capability id from the engine vocabulary');

// ── Typed plugin inputs (od.inputs analogue) ──────────────────────────────────

const BasePluginInputSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]{0,63}$/),
  label: z.string().min(1).max(120),
  description: z.string().max(300).optional(),
  required: z.boolean().default(false),
});

export const PluginInputSchema = z.discriminatedUnion('type', [
  BasePluginInputSchema.extend({ type: z.literal('string'), default: z.string().optional() }),
  BasePluginInputSchema.extend({
    type: z.literal('select'),
    options: z.array(z.string().min(1)).min(2).max(40),
    default: z.string().optional(),
  }),
  BasePluginInputSchema.extend({ type: z.literal('boolean'), default: z.boolean().optional() }),
  BasePluginInputSchema.extend({ type: z.literal('number'), default: z.number().optional() }),
]);

export type PluginInput = z.infer<typeof PluginInputSchema>;

// ── Pipeline stages (od.pipeline analogue) ─────────────────────────────────────

export const PluginStageSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]{0,63}$/),
  /** Stage kind drives how the runner executes it. */
  kind: z.enum(['generate', 'review', 'transform', 'export', 'report']),
  /** Model-facing instructions for this stage. */
  prompt: z.string().min(10).max(20_000),
  /** Optional output size hint (max tokens emitted by this stage). */
  max_tokens: z.number().int().min(256).max(16_000).default(4000),
  /** Repeat this stage until the until expression holds or maxIterations is
   *  reached — the OpenDesign `repeat + until` hard constraint. */
  repeat: z.boolean().default(false),
  until: z.string().max(300).optional(),
  max_iterations: z.number().int().min(1).max(10).default(3),
});

export type PluginStage = z.infer<typeof PluginStageSchema>;

// ── Manifest ───────────────────────────────────────────────────────────────────

export const PLUGIN_KINDS = [
  'skill',        // instruction-only (SKILL.md analogue)
  'reviewer',     // critique/repair round over an artifact
  'generator',    // produces new artifact content
  'exporter',     // pushes artifacts out of Atomic (Linear/Notion/...)
  'transformer',  // re-shapes artifact content
  'reporter',     // read-only analytics/report over a session
] as const;

export const EnginePluginManifestSchema = z.object({
  // Namespaced ids (e.g. 'builtin:blueprint-reviewer') are first-class: the
  // optional scope prefix lets registries group plugins while the name
  // remains URL-safe for route params and CLI invocations.
  id: z.string().min(3).max(120).regex(/^[a-z][a-z0-9_.:-]{2,119}$/),
  specVersion: z.literal('1.0.0').default('1.0.0'),
  name: z.string().min(2).max(120),
  version: z.string().min(1).max(32).regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(10).max(1000),
  author: z.string().max(120).optional(),
  license: z.string().max(32).optional(),
  /** OpenDesign plugin kinds, mapped to the engine domain. */
  kind: z.enum([...PLUGIN_KINDS]).default('skill'),
  tags: z.array(z.string().max(40)).max(12).optional(),
  /** Capabilities the plugin requires. `prompt:inject` is always implied. */
  capabilities: z.array(EngineCapabilitySchema).optional(),
  inputs: z.array(PluginInputSchema).max(30).optional(),
  pipeline: z.object({ stages: z.array(PluginStageSchema).min(1).max(20) }).optional(),
  /** If true the runner may skip this plugin when budgets are tight. */
  skippable: z.boolean().default(false),
});

export type EnginePluginManifest = z.infer<typeof EnginePluginManifestSchema>;

/** Manifest shape returned to clients — never exposes the stage prompt body
 *  verbatim (treat prompts as opaque content). */
export type PluginManifestPublic = Omit<EnginePluginManifest, 'pipeline'> & {
  pipeline?: { stages: Array<Omit<PluginStage, 'prompt'> & { prompt_length: number }> };
};

export function publicManifest(manifest: EnginePluginManifest): PluginManifestPublic {
  const { pipeline, ...rest } = manifest;
  return {
    ...rest,
    ...(pipeline
      ? {
          pipeline: {
            stages: pipeline.stages.map(({ prompt, ...s }) => ({
              ...s,
              prompt_length: prompt.length,
            })),
          },
        }
      : {}),
  };
}
