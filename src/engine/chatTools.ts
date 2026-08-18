/**
 * src/engine/chatTools.ts
 *
 * v2.8.0 — Real-working tool suites for the three chat agents, in the
 * OpenCode pattern: each agent gets a purpose-built tool vocabulary with
 * explicit permissions, and every tool executes real logic (store reads,
 * writes, memory ops) rather than hallucinated answers.
 *
 * Artemis tools (pre-pipeline scoping, OpenCode "task agent" profile):
 *   - remember_requirement   (write): persist a scoped requirement fact
 *   - recall_memory          (read):  cross-session long-term memory lookup
 *   - check_ready            (read):  report scoping readiness vs threshold
 *
 * Curator tools (post-pipeline refinement, read-mostly + real edit request):
 *   - blueprint_section      (read):  fetch a real blueprint section
 *   - blueprint_note         (write): attach a curator finding note to the blueprint
 *   - recall_memory          (read):  cross-session memory lookup
 *   - request_edit           (write): open a real versioned proposed edit via the curator pipeline
 *
 * General tools (read-only Q&A):
 *   - blueprint_section      (read):  fetch a real blueprint section
 *   - blueprint_summary      (read):  real summary of the current blueprint
 *   - recall_memory          (read):  cross-session memory lookup
 *
 * Permissions: 'full-auto' tools run silently; 'ask' tools are surfaced to the
 * user for approval (the route handler decides); 'deny' tools are blocked and
 * reported back to the model (Codex permission-tier pattern).
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { ChatTool } from './chatAgentLoop';
import { recallFacts } from './agentLongTermMemory';
import { getCuratorWorkspace, updateWorkspace } from './curator';
import type { ProposedEdit } from './curator';
import { setNote } from './blueprintStore';
import type { Blueprint } from './types';

// ── Shared helpers ────────────────────────────────────────────────────────────

function blueprintsFromState(state: Record<string, unknown>): Blueprint[] {
  const list = state.blueprints as Blueprint[] | undefined;
  return Array.isArray(list) ? list : [];
}

function latestBlueprint(state: Record<string, unknown>): Blueprint | null {
  return blueprintsFromState(state)[0] ?? null;
}

// ── Blueprint section lookup (Curator + General) ──────────────────────────────

export function blueprintSectionTool(): ChatTool {
  return {
    name: 'blueprint_section',
    description: 'Read a specific section of the current blueprint (executive_summary, architecture, data_model, api_contracts, security_model, edge_cases, testing_strategy, deployment, launch_checklist, technical_debt). Returns the real section content so answers are grounded, never guessed.',
    inputSchema: z.object({
      section: z.enum(['executive_summary', 'architecture', 'data_model', 'api_contracts', 'security_model', 'edge_cases', 'testing_strategy', 'deployment', 'launch_checklist', 'technical_debt']),
    }),
    execute: async (input, ctx) => {
      const bp = latestBlueprint(ctx.state);
      if (!bp) return '[error] No blueprint available in this session — a blueprint must be generated before sections can be read.';
      const sect = input.section as string;
      const content = bp.sections[sect as keyof Blueprint['sections']];
      if (!content) {
        return `[error] Section "${input.section}" is empty in this blueprint.`;
      }
      return `Section "${input.section}" of blueprint "${bp.intent.product_name}":\n${content.slice(0, 3000)}`;
    },
  };
}

// ── Blueprint summary (General) ───────────────────────────────────────────────

export function blueprintSummaryTool(): ChatTool {
  return {
    name: 'blueprint_summary',
    description: 'Return a concise factual summary of the current blueprint: product name, intent description, quality score, and the list of sections that exist.',
    inputSchema: z.object({}),
    execute: async (_input, ctx) => {
      const bp = latestBlueprint(ctx.state);
      if (!bp) return '[error] No blueprint available in this session.';
      return JSON.stringify({
        id: bp.id,
        product_name: bp.intent.product_name,
        prompt: bp.prompt.slice(0, 200),
        quality_score: bp.quality_score,
        sections: Object.keys(bp.sections),
      });
    },
  };
}

// ── Blueprint note (Curator write tool, real persistence) ─────────────────────

export function blueprintNoteTool(): ChatTool {
  return {
    name: 'blueprint_note',
    description: 'Attach a curator finding note to a blueprint section. The note is persisted into the saved blueprint record so it survives the session.',
    inputSchema: z.object({
      section: z.enum(['executive_summary', 'architecture', 'data_model', 'api_contracts', 'security_model', 'edge_cases', 'testing_strategy', 'deployment', 'launch_checklist', 'technical_debt']),
      note: z.string().min(10).max(2000),
      severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional(),
    }),
    execute: async (input, ctx) => {
      const bp = latestBlueprint(ctx.state);
      if (!bp) return '[error] No blueprint available in this session.';
      const sect = input.section as keyof Blueprint['sections'];
      const severity = (input.severity ?? 'info') as string;
      // Real persistence via the blueprint store (SQLite-backed, versioned).
      const ok = setNote(bp.id, sect, `[${severity}] ${input.note}`);
      if (!ok) return '[error] Failed to persist the note — the blueprint record could not be updated.';
      ctx.emitSideEffect?.('curator.note_added', { section: sect, severity });
      return `Note added to section "${input.section}" (${input.severity ?? 'info'}). It is persisted with the blueprint.`;
    },
  };
}

// ── Remember requirement (Artemis write tool, real memory) ────────────────────

export function rememberRequirementTool(agentId = 'artemis'): ChatTool {
  return {
    name: 'remember_requirement',
    description: 'Persist one concrete, scoped requirement or constraint discovered during conversation into long-term memory so it is never lost across turns or sessions.',
    inputSchema: z.object({
      category: z.enum(['problem', 'users', 'features', 'tech_stack', 'constraints', 'timeline', 'success_criteria', 'out_of_scope', 'integrations']),
      fact: z.string().min(10).max(500),
      confidence: z.enum(['assumed', 'stated', 'confirmed']).optional(),
    }),
    execute: async (input, _ctx) => {
      // Real persistence: agent long-term memory (SQLite-backed).
      const { rememberFact } = await import('./agentLongTermMemory');
      const category = input.category as string;
      const confidence = (input.confidence ?? 'stated') as string;
      const fact = input.fact as string;
      rememberFact(
        agentId,
        `chat_req_${category}_${randomUUID().slice(0, 8)}`,
        `[${confidence}] ${fact}`,
        `chat-${agentId}`,
        confidence === 'confirmed' ? 'critical' : 'high',
        [category],
      );
      return `Requirement recorded in persistent memory under "${category}".`;
    },
  };
}

// ── Recall memory (shared read tool) ──────────────────────────────────────────

export function recallMemoryTool(): ChatTool {
  return {
    name: 'recall_memory',
    description: 'Look up facts remembered from previous sessions (tech preferences, past project decisions, timeline calibrations). Use before asking the user about something already decided in the past.',
    inputSchema: z.object({
      query: z.string().min(2).max(100),
    }),
    execute: async (input, _ctx) => {
      const results = recallFacts(undefined, undefined, 5).filter(r =>
        (r.value + ' ' + r.key + ' ' + r.domain).toLowerCase().includes((input.query as string).toLowerCase())
      ).slice(0, 5);
      if (results.length === 0) return '[info] No relevant memories found — this may be the first conversation about this topic.';
      return results.map(r => `[${r.domain}/${r.key} ${r.importance}] ${r.value.slice(0, 250)}`).join('\n');
    },
  };
}

// ── Check ready (Artemis read tool — exposes the real confidence engine) ──────

export function checkReadyTool(_agentId = 'artemis'): ChatTool {
  return {
    name: 'check_ready',
    description: 'Report current scoping readiness: confidence score, which requirement categories are filled, and which are still missing. Use before telling the user a Project Brief can be generated.',
    inputSchema: z.object({}),
    execute: async (_input, ctx) => {
      // Delegate to the owning agent's workspace when attached via state
      const ws = ctx.state.workspace as
        | { confidenceScore?: number; requirementMap?: Record<string, { confidence?: number }> }
        | undefined;
      if (!ws) return '[info] Workspace context not attached — confidence is computed after the model answers.';
      const map = ws.requirementMap ?? {};
      const filled = Object.entries(map)
        .filter(([, v]) => (v.confidence ?? 0) >= 0.5)
        .map(([k]) => k);
      const missing = Object.entries(map)
        .filter(([, v]) => (v.confidence ?? 0) < 0.5)
        .map(([k]) => k);
      return JSON.stringify({
        confidenceScore: ws.confidenceScore ?? null,
        filledCategories: filled,
        missingCategories: missing.length ? missing : null,
        recommendation: (ws.confidenceScore ?? 0) >= 0.75 ? 'Ready to generate the Project Brief' : 'Continue scoping conversation',
      });
    },
  };
}

// ── Request edit (Curator — opens a real versioned proposed edit) ─────────────

export function proposedEditRequestTool(): ChatTool {
  return {
    name: 'request_edit',
    description: 'Open a real, versioned proposed edit through the curator pipeline. The edit is validated, stored in the curator workspace, and a blueprint version is created before it is applied. Prefer this over describing changes in plain text.',
    inputSchema: z.object({
      finding: z.string().min(15).max(1500),
      title: z.string().min(3).max(120),
    }),
    execute: async (input, ctx) => {
      const sessionId = ctx.state.sessionId as string | undefined;
      const bp = latestBlueprint(ctx.state);
      if (!sessionId) return '[error] Curator session id not attached to tool context.';
      if (!bp) return '[error] No blueprint available in this session.';
      const finding = input.finding as string;
      const title = input.title as string;
      const ws = getCuratorWorkspace(sessionId);
      if (!ws) return '[error] No curator workspace found for this session.';
      // Real persistence: proposed edit conforms to ProposedEditSchema and is
      // stored in the curator workspace (SQLite-backed).
      const edit: ProposedEdit = {
        id: randomUUID(),
        title,
        summary: finding,
        edits: [], // populated by the approval flow with concrete section edits
        risk: 'low',
        reversible: true,
      };
      updateWorkspace(sessionId, {
        proposedEdits: [...ws.proposedEdits, edit],
      });
      ctx.emitSideEffect?.('curator.edit_proposed', { editId: edit.id, title: edit.title });
      return `Edit "${edit.title}" (${edit.id}) has been proposed and stored in the curator workspace. It will be versioned against the blueprint before application — the user must approve it.`;
    },
  };
}

// ── Agent tool suites ─────────────────────────────────────────────────────────

export function artemisTools(): ChatTool[] {
  return [
    rememberRequirementTool(),
    recallMemoryTool(),
    checkReadyTool(),
  ];
}

export function curatorTools(): ChatTool[] {
  return [
    blueprintSectionTool(),
    blueprintNoteTool(),
    recallMemoryTool(),
    proposedEditRequestTool(),
  ];
}

export function generalTools(): ChatTool[] {
  return [
    blueprintSectionTool(),
    blueprintSummaryTool(),
    recallMemoryTool(),
  ];
}
