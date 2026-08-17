/**
 * src/engine/skills.ts
 *
 * Skills System — composable units that modify how agents think and communicate.
 * Skills are NOT tools (tools do things); skills shape how the agent reasons.
 *
 * Skills are stacked and injected into agent prompts in injectionPriority order
 * through the Prompt Registry.
 */

import { z } from 'zod';
import { getDb } from './store.sqlite';
import { publishEvent } from './eventBus';

/**
 * Cross-environment UUID v4 generator.
 *
 * The Vite client bundle externalises the Node `crypto` module, so a static
 * `import { randomUUID } from 'crypto'` breaks the browser build. This helper
 * resolves the correct runtime implementation lazily:
 *   - Browser : Web Crypto API (`globalThis.crypto.randomUUID`)
 *   - Node    : `node:crypto.randomUUID()`
 */
let _uuidFn: (() => string) | undefined;

function genUUID(): string {
  if (!_uuidFn) {
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto?.randomUUID) {
      _uuidFn = () => globalThis.crypto.randomUUID();
    } else {
      // Lazy server-side load: the browser bundle must never pull in node:crypto.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodeCrypto = require('node:crypto') as typeof import('crypto');
      _uuidFn = () => nodeCrypto.randomUUID();
    }
  }
  return _uuidFn();
}

// ── Types ──────────────────────────────────────────────────────────────────────

// Browser-safe type definitions and the static built-in skills data live in
// `skillsData.ts`. Keeping them there ensures the Vite client bundle never
// pulls the Node persistence layer (better-sqlite3, fs, path, os) into the
// browser — the client only needs the data, not the SQLite layer.
import { BUILT_IN_SKILLS } from './skillsData';
export { BUILT_IN_SKILLS };
import type { Skill, AgentType } from './skillsData';
export type { Skill, AgentType };

export const AgentTypeSchema = z.enum([
  'artemis',
  'curator',
  'general',
  'pipeline',
  'pillar',
  'governor',
  'prosecutor',
  'synthesizer',
] as const);

export const SkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  systemPromptModule: z.string().min(1),
  toolRestrictions: z.array(z.string()).optional(),
  outputFormatOverride: z.string().optional(),
  domainTags: z.array(z.string()),
  compatibleAgents: z.array(AgentTypeSchema),
  injectionPriority: z.number().int().min(0).max(100),
  isBuiltIn: z.boolean(),
  createdAt: z.string().datetime().optional(),
});


// ── Built-in Skills Library ───────────────────────────────────────────────────
// The canonical built-in skills library now lives in src/engine/skillsData.ts
// (browser-safe static data — the client bundle must never pull in the Node
// persistence layer). All edits to the built-in library go there; this module
// re-exports it above.
export const _LEGACY_BUILT_IN_SKILLS_ARRAY_REMOVED = true as const;

// ── Custom skill storage (SQLite-backed) ─────────────────────────────────────

let dbReady = false;

function ensureDb(): void {
  if (dbReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_skills (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      description         TEXT NOT NULL,
      system_prompt_module TEXT NOT NULL,
      tool_restrictions   TEXT NOT NULL DEFAULT '[]',
      output_format_override TEXT,
      domain_tags         TEXT NOT NULL DEFAULT '[]',
      compatible_agents   TEXT NOT NULL DEFAULT '[]',
      injection_priority  INTEGER NOT NULL DEFAULT 50,
      created_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_custom_skills_priority
      ON custom_skills(injection_priority DESC);
  `);
  dbReady = true;
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  system_prompt_module: string;
  tool_restrictions: string;
  output_format_override: string | null;
  domain_tags: string;
  compatible_agents: string;
  injection_priority: number;
  created_at: string;
}

function rowToSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    systemPromptModule: row.system_prompt_module,
    toolRestrictions: JSON.parse(row.tool_restrictions) as string[],
    outputFormatOverride: row.output_format_override ?? undefined,
    domainTags: JSON.parse(row.domain_tags) as string[],
    compatibleAgents: JSON.parse(row.compatible_agents) as Skill['compatibleAgents'],
    injectionPriority: row.injection_priority,
    isBuiltIn: false,
    createdAt: row.created_at,
  };
}

function loadCustomSkills(): Skill[] {
  ensureDb();
  const rows = getDb().prepare<[], SkillRow>('SELECT * FROM custom_skills ORDER BY injection_priority DESC').all();
  return rows.map(rowToSkill);
}

export function registerCustomSkill(skill: Skill): void {
  const parsed = SkillSchema.parse(skill);
  if (parsed.isBuiltIn) throw new Error('Cannot register a built-in skill as custom');
  if (BUILT_IN_SKILLS.some(s => s.id === parsed.id)) {
    throw new Error(`Skill ID "${parsed.id}" conflicts with a built-in skill`);
  }
  ensureDb();
  const now = parsed.createdAt ?? new Date().toISOString();
  getDb().prepare(`
    INSERT INTO custom_skills
      (id, name, description, system_prompt_module, tool_restrictions, output_format_override,
       domain_tags, compatible_agents, injection_priority, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      system_prompt_module = excluded.system_prompt_module,
      tool_restrictions = excluded.tool_restrictions,
      output_format_override = excluded.output_format_override,
      domain_tags = excluded.domain_tags,
      compatible_agents = excluded.compatible_agents,
      injection_priority = excluded.injection_priority
  `).run(
    parsed.id,
    parsed.name,
    parsed.description,
    parsed.systemPromptModule,
    JSON.stringify(parsed.toolRestrictions ?? []),
    parsed.outputFormatOverride ?? null,
    JSON.stringify(parsed.domainTags),
    JSON.stringify(parsed.compatibleAgents),
    parsed.injectionPriority,
    now,
  );
  publishEvent('skills.custom_registered', 'system', genUUID(), { skillId: parsed.id, name: parsed.name });
}

export function updateCustomSkill(id: string, updates: Partial<Skill>): Skill {
  ensureDb();
  const row = getDb().prepare<[string], SkillRow>('SELECT * FROM custom_skills WHERE id = ? LIMIT 1').get(id);
  if (!row) throw new Error(`Custom skill not found: ${id}`);
  const existing = rowToSkill(row);
  const updated = SkillSchema.parse({ ...existing, ...updates, id, isBuiltIn: false });
  getDb().prepare(`
    UPDATE custom_skills SET
      name = ?,
      description = ?,
      system_prompt_module = ?,
      tool_restrictions = ?,
      output_format_override = ?,
      domain_tags = ?,
      compatible_agents = ?,
      injection_priority = ?
    WHERE id = ?
  `).run(
    updated.name,
    updated.description,
    updated.systemPromptModule,
    JSON.stringify(updated.toolRestrictions ?? []),
    updated.outputFormatOverride ?? null,
    JSON.stringify(updated.domainTags),
    JSON.stringify(updated.compatibleAgents),
    updated.injectionPriority,
    id,
  );
  publishEvent('skills.custom_updated', 'system', genUUID(), { skillId: id });
  return updated;
}

export function deleteCustomSkill(id: string): void {
  ensureDb();
  const row = getDb().prepare<[string], { id: string }>('SELECT id FROM custom_skills WHERE id = ? LIMIT 1').get(id);
  if (!row) throw new Error(`Custom skill not found: ${id}`);
  getDb().prepare('DELETE FROM custom_skills WHERE id = ?').run(id);
  publishEvent('skills.custom_deleted', 'system', genUUID(), { skillId: id });
}

export function getAllSkills(): Skill[] {
  return [...BUILT_IN_SKILLS, ...loadCustomSkills()];
}

export function getSkillById(id: string): Skill | undefined {
  return BUILT_IN_SKILLS.find(s => s.id === id) ?? loadCustomSkills().find(s => s.id === id);
}

export function getSkillsForAgent(agentType: AgentType): Skill[] {
  return getAllSkills()
    .filter(s => s.compatibleAgents.includes(agentType))
    .sort((a, b) => b.injectionPriority - a.injectionPriority);
}

// ── Prompt composition ────────────────────────────────────────────────────────

/**
 * Compose the skills section of a system prompt.
 * Skills are injected in priority order (highest first).
 */
export function composeSkillsPrompt(activeSkillIds: string[], agentType: AgentType): string {
  if (activeSkillIds.length === 0) return '';

  const eligible = getSkillsForAgent(agentType);
  const active = activeSkillIds
    .map(id => eligible.find(s => s.id === id))
    .filter((s): s is Skill => s !== undefined)
    .sort((a, b) => b.injectionPriority - a.injectionPriority);

  if (active.length === 0) return '';

  return [
    '## Active Skills',
    `The following ${active.length} skill module(s) are active for this session. Apply them throughout your reasoning.`,
    '',
    ...active.map(s => s.systemPromptModule),
  ].join('\n');
}

// ── Validation ────────────────────────────────────────────────────────────────

export function validateSkillIds(ids: string[], agentType: AgentType): {
  valid: string[];
  invalid: string[];
  incompatible: string[];
} {
  const all = getAllSkills();
  const eligible = getSkillsForAgent(agentType).map(s => s.id);

  const valid: string[] = [];
  const invalid: string[] = [];
  const incompatible: string[] = [];

  for (const id of ids) {
    const skill = all.find(s => s.id === id);
    if (!skill) {
      invalid.push(id);
    } else if (!eligible.includes(id)) {
      incompatible.push(id);
    } else {
      valid.push(id);
    }
  }

  return { valid, invalid, incompatible };
}
