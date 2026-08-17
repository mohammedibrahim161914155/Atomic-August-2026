/**
 * src/plugins/engine/doctor.ts
 *
 * Doctor-level manifest validation. The schema (schema.ts) expresses the
 * grammar; the doctor expresses the cross-field rules the grammar cannot:
 *
 *   - A stage with `repeat: true` MUST declare an `until` expression
 *     (OpenDesign spec §hard constraint — copied verbatim).
 *   - Unknown capabilities are WARNINGS (not errors), so forward spec
 *     patches can introduce new caps without breaking existing installs.
 *   - Select inputs must default to one of their options when a default
 *     is present.
 *   - Repeat stages must sit inside a real pipeline (not manifest-only).
 */
import { EnginePluginManifestSchema, type EnginePluginManifest } from './schema';

export interface DoctorResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const ENGINE_CAPABILITY_SET = new Set([
  'prompt:inject',
  'blueprint:read',
  'blueprint:write',
  'events',
  'api:call',
]);

export function validateManifest(value: unknown): DoctorResult {
  const parsed = EnginePluginManifestSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      warnings: [],
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
      ),
    };
  }
  return doctor(parsed.data);
}

export function doctor(manifest: EnginePluginManifest): DoctorResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const caps = manifest.capabilities ?? [];
  for (const cap of caps) {
    if (!ENGINE_CAPABILITY_SET.has(cap)) {
      warnings.push(`capability '${cap}' is not in the v1 vocabulary; surface this to the operator`);
    }
  }

  if (manifest.kind === 'exporter' && !caps.includes('api:call')) {
    warnings.push(`kind '${manifest.kind}' usually requires the 'api:call' capability; verify the manifest`);
  }

  if (manifest.kind === 'reporter' && (caps.includes('blueprint:write') || caps.includes('api:call'))) {
    warnings.push(
      `kind '${manifest.kind}' declares write/outbound capabilities that read-only reporters should not need`,
    );
  }

  for (const input of manifest.inputs ?? []) {
    if (input.type === 'select' && input.default !== undefined && !input.options.includes(input.default)) {
      errors.push(`inputs[${input.name}]: default '${input.default}' is not one of the declared options`);
    }
    if (input.required && input.type === 'boolean' && input.default === undefined) {
      warnings.push(`inputs[${input.name}]: required boolean input should declare an explicit default`);
    }
  }

  if (!manifest.pipeline) {
    if (manifest.kind === 'generator') {
      errors.push('kind "generator" requires a pipeline declaration');
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  for (const stage of manifest.pipeline.stages) {
    if (stage.repeat && !stage.until) {
      errors.push(`pipeline.stages[${stage.id}]: repeat=true requires an 'until' expression`);
    }
    if (stage.max_iterations < 2 && stage.repeat) {
      errors.push(`pipeline.stages[${stage.id}]: repeat=true is meaningless with max_iterations=1`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
