/**
 * src/plugins/config.ts
 *
 * Typed configuration schemas for built-in plugins.
 *
 * Where the engine plugin platform uses Zod input forms
 * (`src/plugins/engine/schema.ts` PluginInputSchema), client-side plugins need
 * lightweight typed config because they run in the browser and store values in
 * localStorage. Each built-in plugin declares a config schema that the UI and
 * the plugin itself can use to validate values before use.
 */

import { z } from 'zod';

// ── Primitive validators ─────────────────────────────────────────────────────

/** Non-empty trimmed string. */
const nonEmptyString = z.string().trim().min(1);

/** Linear API key: 32-char hex token (`lin_api_...` or raw hex). */
const linearApiKey = nonEmptyString.describe('Linear API key');

/** Linear team id: `T0000000` format. */
const linearTeamId = nonEmptyString
  .regex(/^T\d{7}$/, 'team id must look like T0000000')
  .describe('Linear team ID');

/** Notion integration token (`ntn_...` or `secret_...`). */
const notionApiKey = nonEmptyString.describe('Notion integration token');

/** Notion parent page id: 32-char uuid without dashes. */
const notionParentId = nonEmptyString
  .regex(/^[0-9a-f]{32}$/i, 'parent id must be a 32-char Notion page/database ID')
  .describe('Notion parent page ID');

// ── Per-plugin config schemas ────────────────────────────────────────────────

export const LinearConfigSchema = z.object({
  api_key:               linearApiKey,
  team_id:               linearTeamId,
  project_name_prefix:   z.string().max(40).default('[Atomic]'),
  max_issues_per_project: z.number().int().min(1).max(20).default(10),
});

export const NotionConfigSchema = z.object({
  api_key:    notionApiKey,
  parent_id:  notionParentId,
  max_blocks_per_page: z.number().int().min(10).max(100).default(100),
});

export const MarkdownConfigSchema = z.object({
  include_pillar_analysis: z.boolean().default(true),
  include_quality_score:   z.boolean().default(true),
});

export type LinearConfig  = z.infer<typeof LinearConfigSchema>;
export type NotionConfig  = z.infer<typeof NotionConfigSchema>;
export type MarkdownConfig = z.infer<typeof MarkdownConfigSchema>;

/** Plugin id → config schema lookup for the built-in set. */
export const BUILT_IN_CONFIG_SCHEMAS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  'built-in/export-linear':   LinearConfigSchema,
  'built-in/export-notion':   NotionConfigSchema,
  'built-in/export-markdown': MarkdownConfigSchema,
};

// ── Public helpers ────────────────────────────────────────────────────────────

export interface ConfigValidationResult<T = unknown> {
  ok:     boolean;
  errors: string[];
  data?:  T;
}

/**
 * Validate and normalize a plugin's raw config against its schema.
 * Missing optional fields are filled with defaults when the schema defines them.
 */
export function validatePluginConfig<T>(
  pluginId: string,
  raw:      unknown,
): ConfigValidationResult<T> {
  const schema = BUILT_IN_CONFIG_SCHEMAS[pluginId];
  if (!schema) {
    // Unknown / third-party plugin: pass through as-is (no schema to enforce).
    return { ok: true, errors: [], data: raw as T };
  }
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(i => `${i.path.join('.') || '<root>'}: ${i.message}`),
    };
  }
  return { ok: true, errors: [], data: parsed.data as T };
}
