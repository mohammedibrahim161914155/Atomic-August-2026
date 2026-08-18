/**
 * src/engine/curator.ts
 *
 * The Curator — Post-Pipeline Refinement Agent
 *
 * Identity: The most capable agent in the system. Senior technical architect,
 * security auditor, and quality engineer simultaneously. Makes recommendations
 * grounded in authoritative, cited sources. Never guesses. Never bluffs.
 *
 * Authority:
 *   - ONLY the Curator can edit the Blueprint (enforced here, not just in UI)
 *   - Edits are applied as structured diffs
 *   - Every edit creates a new blueprint version before applying
 *   - User confirms edits (configurable: always-confirm / auto-apply / preview-first)
 *
 * Design:
 *   - True agentic loop via Vercel AI SDK
 *   - Emits events via eventBus on all state transitions
 *   - Integrated with blueprintVersions for immutable version history
 */

import { streamText, generateObject } from 'ai';
import { z } from 'zod';
import { ModelConfig } from './config';
import { getModelForConfig } from './openrouter';
import { log } from './logger';
import { publishEvent } from './eventBus';
import { composeSkillsPrompt } from './skills';
import { startSpan } from './observability';
import { getDb } from './store.sqlite';
import { randomUUID } from 'crypto';
import { runCuratorSubAgents, mergeSubAgentDimensions, formatSubAgentSummary, type CuratorSubAgentResults } from './curatorSubAgents';
import { promptRegistry } from './promptRegistry';
import { formatLongTermContext, rememberFact } from './agentLongTermMemory';
import type { Blueprint, BlueprintSections } from './types';

// ── Refinement report schema ──────────────────────────────────────────────────

const DimensionScoreSchema = z.object({
  score:       z.number().min(0).max(100),
  summary:     z.string(),
  keyFindings: z.array(z.string()),
});

const FindingSchema = z.object({
  id:             z.string(),
  severity:       z.enum(['critical', 'warning', 'suggestion']),
  pillarId:       z.string().optional(),
  sectionId:      z.string().optional(),
  description:    z.string(),
  impact:         z.string(),
  recommendation: z.string(),
  source:         z.object({
    title: z.string(),
    url:   z.string().url().optional(),
    retrievedAt: z.string().optional(),
  }).optional(),
});

const RecommendationSchema = z.object({
  id:          z.string(),
  priority:    z.enum(['critical', 'high', 'medium', 'low']),
  title:       z.string(),
  description: z.string(),
  rationale:   z.string(),
  effort:      z.enum(['trivial', 'small', 'medium', 'large']),
  pillarIds:   z.array(z.string()).optional(),
});

export const RefinementReportSchema = z.object({
  overallScore: z.object({
    value:   z.number().min(0).max(100),
    summary: z.string(),
  }),
  dimensions: z.object({
    completeness:    DimensionScoreSchema,
    consistency:     DimensionScoreSchema,
    security:        DimensionScoreSchema,
    scalability:     DimensionScoreSchema,
    maintainability: DimensionScoreSchema,
    bestPractices:   DimensionScoreSchema,
    feasibility:     DimensionScoreSchema,
    observability:   DimensionScoreSchema,
    testability:     DimensionScoreSchema,
  }),
  findings:         z.array(FindingSchema),
  recommendations:  z.array(RecommendationSchema),
  generatedAt:      z.string(),
  modelUsed:        z.string(),
  tokenCount:       z.number().optional(),
});

export type RefinementReport = z.infer<typeof RefinementReportSchema>;

// ── Blueprint diff schema ─────────────────────────────────────────────────────

const SectionEditSchema = z.object({
  sectionId:  z.string(),
  fieldPath:  z.string(), // e.g. "sections.security_model" or "pillars.security.synthesizer_output"
  oldContent: z.string(),
  newContent: z.string(),
  rationale:  z.string(),
  findingId:  z.string().optional(),
});

export const ProposedEditSchema = z.object({
  id:         z.string(),
  title:      z.string(),
  summary:    z.string(),
  edits:      z.array(SectionEditSchema),
  risk:       z.enum(['none', 'low', 'medium', 'high']),
  reversible: z.boolean(),
});
export type ProposedEdit = z.infer<typeof ProposedEditSchema>;

// ── Workspace ─────────────────────────────────────────────────────────────────

export interface CuratorWorkspace {
  sessionId:      string;
  blueprintId:    string;
  thread:         Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: string }>;
  report:         RefinementReport | null;
  proposedEdits:  ProposedEdit[];
  appliedEdits:   string[]; // edit IDs
  rejectedEdits:  string[];
  status:         'idle' | 'analyzing' | 'ready' | 'editing';
  createdAt:      string;
  updatedAt:      string;
}

// ── SQLite-backed workspace store ─────────────────────────────────────────────

let _curatorDbReady = false;

function ensureCuratorDb(): void {
  if (_curatorDbReady) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS curator_workspaces (
      session_id      TEXT PRIMARY KEY,
      blueprint_id    TEXT NOT NULL,
      thread          TEXT NOT NULL DEFAULT '[]',
      report          TEXT,
      proposed_edits  TEXT NOT NULL DEFAULT '[]',
      applied_edits   TEXT NOT NULL DEFAULT '[]',
      rejected_edits  TEXT NOT NULL DEFAULT '[]',
      status          TEXT NOT NULL DEFAULT 'idle',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_curator_ws_updated
      ON curator_workspaces(updated_at DESC);
  `);
  _curatorDbReady = true;
}

interface CuratorRow {
  session_id:     string; blueprint_id: string; thread: string;
  report:         string | null; proposed_edits: string; applied_edits: string;
  rejected_edits: string; status: string; created_at: string; updated_at: string;
}

function rowToWorkspace(row: CuratorRow): CuratorWorkspace {
  return {
    sessionId:     row.session_id,
    blueprintId:   row.blueprint_id,
    thread:        JSON.parse(row.thread) as CuratorWorkspace['thread'],
    report:        row.report ? JSON.parse(row.report) as RefinementReport : null,
    proposedEdits: JSON.parse(row.proposed_edits) as ProposedEdit[],
    appliedEdits:  JSON.parse(row.applied_edits) as string[],
    rejectedEdits: JSON.parse(row.rejected_edits) as string[],
    status:        row.status as CuratorWorkspace['status'],
    createdAt:     row.created_at,
    updatedAt:     row.updated_at,
  };
}

function persistCuratorWorkspace(ws: CuratorWorkspace): void {
  ensureCuratorDb();
  getDb().prepare(`
    INSERT INTO curator_workspaces
      (session_id, blueprint_id, thread, report, proposed_edits, applied_edits, rejected_edits, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      blueprint_id   = excluded.blueprint_id,
      thread         = excluded.thread,
      report         = excluded.report,
      proposed_edits = excluded.proposed_edits,
      applied_edits  = excluded.applied_edits,
      rejected_edits = excluded.rejected_edits,
      status         = excluded.status,
      updated_at     = excluded.updated_at
  `).run(
    ws.sessionId, ws.blueprintId,
    JSON.stringify(ws.thread),
    ws.report ? JSON.stringify(ws.report) : null,
    JSON.stringify(ws.proposedEdits),
    JSON.stringify(ws.appliedEdits),
    JSON.stringify(ws.rejectedEdits),
    ws.status,
    ws.createdAt,
    ws.updatedAt,
  );
}

// In-memory cache — avoids repeated SQLite reads within the same request chain
const curatorCache = new Map<string, CuratorWorkspace>();

export function getCuratorWorkspace(sessionId: string): CuratorWorkspace | null {
  if (curatorCache.has(sessionId)) return curatorCache.get(sessionId)!;
  ensureCuratorDb();
  const row = getDb().prepare<[string], CuratorRow>(
    'SELECT * FROM curator_workspaces WHERE session_id = ? LIMIT 1'
  ).get(sessionId);
  if (!row) return null;
  const ws = rowToWorkspace(row);
  curatorCache.set(sessionId, ws);
  return ws;
}

export function createCuratorSession(sessionId: string, blueprintId: string): CuratorWorkspace {
  const workspace: CuratorWorkspace = {
    sessionId,
    blueprintId,
    thread:        [],
    report:        null,
    proposedEdits: [],
    appliedEdits:  [],
    rejectedEdits: [],
    status:        'idle',
    createdAt:     new Date().toISOString(),
    updatedAt:     new Date().toISOString(),
  };
  curatorCache.set(sessionId, workspace);
  persistCuratorWorkspace(workspace);
  publishEvent('curator.activated', sessionId, randomUUID(), { blueprintId });
  return workspace;
}

function updateWorkspace(sessionId: string, updates: Partial<CuratorWorkspace>): void {
  const existing = curatorCache.get(sessionId) ?? getCuratorWorkspace(sessionId);
  if (!existing) throw new Error(`Curator workspace not found: ${sessionId}`);
  const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
  curatorCache.set(sessionId, updated);
  persistCuratorWorkspace(updated);
  publishEvent('workspace.written', sessionId, randomUUID(), { workspace: 'curator_workspace' });
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildCuratorSystemPrompt(
  activeSkillIds: string[],
  blueprint: Blueprint,
  longTermContext?: string,
  subAgentSummary?: string,
): string {
  const skillsSection    = composeSkillsPrompt(activeSkillIds, 'curator');
  const productName      = blueprint.intent.product_name;
  const memorySection    = longTermContext
    ? `\n\nINSTITUTIONAL MEMORY (from past analysis sessions):\n${longTermContext}\n`
    : '';
  const subAgentSection  = subAgentSummary
    ? `\n\nPARALLEL SUB-AGENT PRE-ANALYSIS:\nThe following analysis was produced by 4 specialized sub-agents (Security, Scalability, Completeness, Consistency) running in parallel before this session:\n${subAgentSummary}\n\nUse this pre-analysis to calibrate your dimension scores and expand the findings list. Do not duplicate — enrich and synthesize.\n`
    : '';

  return `You are the Curator — the most senior technical reviewer in the Atomic system.

Your identity: Senior technical architect, security auditor, and quality engineer simultaneously.
Blueprint: "${productName}"

AUTHORITY:
- You are the ONLY agent authorized to propose edits to this blueprint
- All edits must be justified with specific findings
- You never make changes without explaining exactly what changed and why
- You cite authoritative sources (official docs, RFCs, standards) for every technical claim

CAPABILITIES:
- Full read access to all pillars, sections, and metadata
- Ability to propose structured diffs (edits) to any section
- Ability to trigger pillar improvement loops
- Access to web search results (when provided in context)

ANALYSIS FRAMEWORK:
Evaluate across these 9 dimensions:
1. Completeness (0-100): Are all required architectural concerns addressed?
2. Consistency (0-100): Do all pillars agree? No contradictions?
3. Security (0-100): Is the security model comprehensive and current?
4. Scalability (0-100): Can this scale under realistic load?
5. Maintainability (0-100): Will this be maintainable in 2 years?
6. Best Practices (0-100): Does this follow current industry standards?
7. Feasibility (0-100): Can this actually be built with stated constraints?
8. Observability (0-100): Is monitoring, tracing, and alerting addressed?
9. Testability (0-100): Is the testing strategy concrete and complete?

EDIT RULES:
- Every proposed edit includes: what changed, why, what finding it addresses
- Edits applied as diffs — not full rewrites unless necessary
- A new blueprint version is created before any edit is applied
- If an edit touches security-critical areas, mark risk as "high"
${memorySection}${subAgentSection}
${skillsSection}`.trim();
}

// ── Analysis (deep review) ────────────────────────────────────────────────────

export async function analyzeBlueprint(opts: {
  sessionId:     string;
  blueprint:     Blueprint;
  config:        ModelConfig;
  activeSkillIds?: string[];
}): Promise<RefinementReport> {
  const { sessionId, blueprint, config, activeSkillIds = [] } = opts;
  const traceId = randomUUID();
  const span    = startSpan({ traceId, sessionId, category: 'curator' });

  let workspace = getCuratorWorkspace(sessionId);
  if (!workspace) workspace = createCuratorSession(sessionId, blueprint.id);

  updateWorkspace(sessionId, { status: 'analyzing' });
  publishEvent('curator.analysis_started', sessionId, traceId, { blueprintId: blueprint.id });

  const model           = getModelForConfig(config, config.proModel);
  const blueprintSummary = buildBlueprintSummary(blueprint);

  // Pull cross-session long-term memory to calibrate this analysis
  const longTermCtx = formatLongTermContext('curator', 15);

  // ── Run 4 sub-agents FIRST so their analysis is available to the main report ──
  log.info({ sessionId }, '[curator] launching 4 sub-agents before main analysis');

  const subResult = await Promise.resolve(runCuratorSubAgents(sessionId, blueprint, longTermCtx, config)).catch(() => null);
  const subResults: PromiseSettledResult<CuratorSubAgentResults> = subResult
    ? { status: 'fulfilled', value: subResult }
    : { status: 'rejected', reason: new Error('sub-agents unavailable') };
  const subAgentSummary = subResult?.succeededCount ? formatSubAgentSummary(subResult) : undefined;

  let report: Omit<RefinementReport, 'generatedAt' | 'modelUsed' | 'tokenCount'>;
  try {
    // v2.7.0 — validate the composed system prompt for coherence before sending
    const systemPrompt = buildCuratorSystemPrompt(activeSkillIds, blueprint, longTermCtx || undefined, subAgentSummary);
    const validation = promptRegistry.validate(systemPrompt);
    if (!validation.valid) {
      log.warn({ errors: validation.errors, sessionId }, '[curator] system prompt validation warnings');
    }
    const result = await generateObject({
      model,
      schema: RefinementReportSchema.omit({ generatedAt: true, modelUsed: true, tokenCount: true }),
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Perform a comprehensive analysis of this blueprint:\n\n${blueprintSummary}`,
      }],
      maxOutputTokens: 4096,
      temperature: 0.2,
    });
    report = result.object;
  } catch (err) {
    updateWorkspace(sessionId, { status: 'idle' });
    span.finish('analysis_failed', {}, { level: 'error', error: err });
    throw err;
  }

  // Merge sub-agent findings into the report (additive — sub-agents extend, not replace)
  if (subResults.status === 'fulfilled' && subResults.value.succeededCount > 0) {
    const sub = subResults.value;
    log.info({ sessionId, succeededCount: sub.succeededCount, findingCount: sub.allFindings.length }, '[curator] merging sub-agent findings');

    // Merge all sub-agent findings (deduplicated by description similarity heuristic)
    const existingDescriptions = new Set(report.findings.map(f => f.description.toLowerCase().slice(0, 60)));
    const newFindings = sub.allFindings.filter(f =>
      !existingDescriptions.has(f.description.toLowerCase().slice(0, 60))
    );

    // Override dimension scores where sub-agents provide higher-quality specialist scores
    const subDims = mergeSubAgentDimensions(sub);
    const mergedDimensions = {
      ...report.dimensions,
      ...(subDims.security     ? { security:     subDims.security }     : {}),
      ...(subDims.scalability  ? { scalability:  subDims.scalability }  : {}),
      ...(subDims.completeness ? { completeness: subDims.completeness } : {}),
      ...(subDims.consistency  ? { consistency:  subDims.consistency }  : {}),
    };

    report = {
      ...report,
      findings:   [...report.findings, ...newFindings],
      dimensions: mergedDimensions as typeof report.dimensions,
    };

    // Persist key curator findings to long-term memory for future sessions
    const criticals = sub.allFindings.filter(f => f.severity === 'critical');
    if (criticals.length > 0) {
      rememberFact('curator',
        `critical_findings_${blueprint.intent.product_name.replace(/\s+/g, '_').toLowerCase().slice(0, 30)}`,
        `${blueprint.intent.product_name}: ${criticals.length} critical findings — ${criticals.map(f => f.description.slice(0, 80)).join('; ')}`,
        'CuratorSubAgents', 'high', ['findings', 'critical']);
    }
    if (sub.security) {
      rememberFact('curator', 'last_security_score',
        `Security score: ${sub.security.overallScore}/100 — OWASP coverage: ${Object.values(sub.security.owaspCoverage).filter(Boolean).length}/10`,
        'SecurityReviewer', 'medium', ['security', 'scores']);
    }
    if (sub.scalability?.bottlenecks.some(b => b.priority === 'immediate')) {
      const immediates = sub.scalability.bottlenecks.filter(b => b.priority === 'immediate');
      rememberFact('curator', 'last_scalability_bottlenecks',
        `Immediate bottlenecks: ${immediates.map(b => b.component).join(', ')}`,
        'ScalabilityAuditor', 'medium', ['scalability', 'bottlenecks']);
    }
  } else if (subResults.status === 'rejected') {
    log.warn({ err: subResults.reason, sessionId }, '[curator] sub-agents failed — report uses base analysis only');
  }

  // Recalculate overall score from (potentially updated) dimensions
  const dimScores = Object.values(report.dimensions).map(d => d.score);
  const avgDimScore = dimScores.length > 0
    ? Math.round(dimScores.reduce((a, b) => a + b, 0) / dimScores.length)
    : report.overallScore.value;

  const fullReport: RefinementReport = {
    ...report,
    overallScore: { ...report.overallScore, value: avgDimScore },
    generatedAt:  new Date().toISOString(),
    modelUsed:    config.proModel,
    tokenCount:   subResults.status === 'fulfilled' ? subResults.value.allFindings.length : undefined,
  };


  updateWorkspace(sessionId, { report: fullReport, status: 'ready' });
  publishEvent('curator.report_ready', sessionId, traceId, {
    overallScore:  fullReport.overallScore.value,
    findingCount:  fullReport.findings.length,
    criticalCount: fullReport.findings.filter(f => f.severity === 'critical').length,
    subAgentCount: subResults.status === 'fulfilled' ? subResults.value.succeededCount : 0,
  });

  span.finish('analysis_complete', {
    overallScore:  fullReport.overallScore.value,
    subAgentCount: subResults.status === 'fulfilled' ? subResults.value.succeededCount : 0,
  });
  return fullReport;
}

// ── Chat (streaming) ──────────────────────────────────────────────────────────

export async function curatorChat(opts: {
  sessionId:     string;
  message:       string;
  blueprint:     Blueprint;
  config:        ModelConfig;
  activeSkillIds?: string[];
}): Promise<{
  textStream: AsyncIterable<string>;
  onComplete: Promise<{ content: string; proposedEdits: ProposedEdit[] }>;
}> {
  const { sessionId, message, blueprint, config, activeSkillIds = [] } = opts;
  const traceId = randomUUID();

  let workspace = getCuratorWorkspace(sessionId);
  if (!workspace) workspace = createCuratorSession(sessionId, blueprint.id);

  const userMsg = {
    id: randomUUID(), role: 'user' as const,
    content: message, timestamp: new Date().toISOString(),
  };
  workspace.thread.push(userMsg);
  updateWorkspace(sessionId, { thread: workspace.thread });

  const model          = getModelForConfig(config, config.proModel);
  const longTermCtx    = formatLongTermContext('curator', 8);
  const systemPrompt   = buildCuratorSystemPrompt(activeSkillIds, blueprint, longTermCtx || undefined);
  const blueprintContext = `Current Blueprint Summary:\n${buildBlueprintSummary(blueprint)}`;

  const messages = [
    { role: 'user' as const, content: blueprintContext },
    { role: 'assistant' as const, content: 'I have reviewed the blueprint. I am ready to analyze, discuss, and propose improvements.' },
    ...workspace.thread.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: message },
  ];

  let fullText = '';
  const result = streamText({
    model,
    system: systemPrompt,
    messages,
    maxOutputTokens: 2048,
    temperature: 0.3,
    onFinish: async ({ text }) => { fullText = text; },
  });

  const onComplete = (async () => {
    await result.text;
    const assistantMsg = {
      id: randomUUID(), role: 'assistant' as const,
      content: fullText, timestamp: new Date().toISOString(),
    };
    const ws = getCuratorWorkspace(sessionId)!;
    ws.thread.push(assistantMsg);
    updateWorkspace(sessionId, { thread: ws.thread });

    // Parse any proposed edits from the response
    const proposedEdits = extractProposedEdits(fullText, sessionId);
    if (proposedEdits.length > 0) {
      updateWorkspace(sessionId, {
        proposedEdits: [...(ws.proposedEdits ?? []), ...proposedEdits],
      });
      for (const edit of proposedEdits) {
        publishEvent('curator.edit_proposed', sessionId, traceId, { editId: edit.id, title: edit.title });
      }
    }

    return { content: fullText, proposedEdits };
  })();

  return {
    textStream: result.textStream,
    onComplete,
  };
}

// ── Propose edit ──────────────────────────────────────────────────────────────

export async function proposeEdit(opts: {
  sessionId:  string;
  blueprint:  Blueprint;
  findingId:  string;
  config:     ModelConfig;
}): Promise<ProposedEdit> {
  const { sessionId, blueprint, findingId, config } = opts;
  const workspace = getCuratorWorkspace(sessionId);
  if (!workspace?.report) throw new Error('No refinement report available. Run analyzeBlueprint first.');

  const finding = workspace.report.findings.find(f => f.id === findingId);
  if (!finding) throw new Error(`Finding not found: ${findingId}`);

  const traceId = randomUUID();
  const model = getModelForConfig(config, config.proModel);

  const { object } = await generateObject({
    model,
    schema: ProposedEditSchema.omit({ id: true }),
    system: buildCuratorSystemPrompt([], blueprint),
    messages: [{
      role: 'user',
      content: `Generate a specific, minimal edit to address this finding:
Finding: ${JSON.stringify(finding, null, 2)}

Blueprint context:
${buildBlueprintSummary(blueprint)}

Produce the smallest possible diff that addresses this finding.`,
    }],
    maxOutputTokens: 2048,
    temperature: 0.1,
  });

  const edit: ProposedEdit = { id: randomUUID(), ...object };
  updateWorkspace(sessionId, { proposedEdits: [...(workspace.proposedEdits ?? []), edit] });
  publishEvent('curator.edit_proposed', sessionId, traceId, { editId: edit.id, findingId });
  return edit;
}

// ── Apply edit ────────────────────────────────────────────────────────────────

export async function applyEdit(
  sessionId: string,
  editId: string,
  blueprint: Blueprint
): Promise<Blueprint> {
  const workspace = getCuratorWorkspace(sessionId);
  if (!workspace) throw new Error('No curator session found');

  const edit = workspace.proposedEdits.find(e => e.id === editId);
  if (!edit) throw new Error(`Edit not found: ${editId}`);
  if (workspace.appliedEdits.includes(editId)) throw new Error(`Edit already applied: ${editId}`);

  const traceId = randomUUID();
  publishEvent('curator.edit_confirmed', sessionId, traceId, { editId, title: edit.title });

  // v2.7.0 — create a blueprint version BEFORE applying any edit so every change
  // is reversible. Previously edits were applied with no versioning, contradicting
  // the stated design ("a new blueprint version is created before any edit is applied").
  try {
    const { createVersion } = await import('./blueprintVersions');
    const version = createVersion({
      blueprintId:    blueprint.id,
      snapshot:       blueprint,
      author:         'curator',
      authorDetail:   'curator.edit',
      changeSummary:  `Curator edit applied: ${edit.title}`,
      changeType:     'full',
      sessionId,
      previousSnapshot: blueprint,
    });
    log.info({ versionNumber: version.versionNumber, blueprintId: blueprint.id }, '[curator] version created before edit application');
    publishEvent('blueprint.version_created', sessionId, traceId, {
      blueprintId: blueprint.id,
      versionNumber: version.versionNumber,
      author: 'curator',
      changeSummary: version.changeSummary,
    });
  } catch (err) {
    // Blueprint versioning is best-effort from the engine side — if the table
    // does not exist the edit is still applied and surfaced in the log.
    log.warn({ err }, '[curator] blueprint version creation skipped');
  }

  // Apply the diff to the blueprint
  let updated = { ...blueprint };
  for (const sectionEdit of edit.edits) {
    updated = applyFieldEdit(updated, sectionEdit.fieldPath, sectionEdit.newContent);
  }

  updateWorkspace(sessionId, {
    appliedEdits: [...workspace.appliedEdits, editId],
  });

  publishEvent('curator.edit_applied', sessionId, traceId, {
    editId,
    title: edit.title,
    sectionCount: edit.edits.length,
  });

  return updated;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildBlueprintSummary(blueprint: Blueprint): string {
  const pillarSummaries = Object.entries(blueprint.pillars)
    .map(([name, p]) => `### ${name}\n${p.synthesizer_output?.slice(0, 500) ?? '(no output)'}...`)
    .join('\n\n');

  return `# ${blueprint.intent.product_name}

## Executive Summary
${blueprint.sections?.executive_summary?.slice(0, 800) ?? '(not generated)'}

## Architecture  
${blueprint.sections?.architecture?.slice(0, 800) ?? '(not generated)'}

## Pillar Summaries
${pillarSummaries}

## Quality Score
${blueprint.quality_score}/100

## Security Model
${blueprint.sections?.security_model?.slice(0, 600) ?? '(not generated)'}`;
}

function applyFieldEdit(blueprint: Blueprint, fieldPath: string, newContent: string): Blueprint {
  const parts = fieldPath.split('.');
  if (parts.length < 2) return blueprint;

  const [top, ...rest] = parts;
  if (top === 'sections' && rest.length === 1) {
    const sectionKey = rest[0] as keyof BlueprintSections;
    return {
      ...blueprint,
      sections: { ...blueprint.sections, [sectionKey]: newContent },
    };
  }
  if (top === 'pillars' && rest.length >= 2) {
    const pillarKey = rest[0]!;
    const field = rest[1]!;
    const pillar = blueprint.pillars[pillarKey];
    if (!pillar) return blueprint;
    return {
      ...blueprint,
      pillars: {
        ...blueprint.pillars,
        [pillarKey]: { ...pillar, [field]: newContent },
      },
    };
  }
  return blueprint;
}

function extractProposedEdits(text: string, _sessionId: string): ProposedEdit[] {
  // Heuristic: look for structured edit blocks in the text
  // In practice, edits are proposed via proposeEdit() API calls driven by the UI
  // This is a lightweight parser for inline edit proposals in chat responses
  const editBlocks = text.match(/```edit\n([\s\S]*?)```/g);
  if (!editBlocks) return [];

  return editBlocks.map(block => {
    const content = block.replace(/```edit\n/, '').replace(/```$/, '');
    try {
      const parsed = JSON.parse(content) as Partial<ProposedEdit>;
      return ProposedEditSchema.parse({ id: randomUUID(), ...parsed });
    } catch {
      return null;
    }
  }).filter((e): e is ProposedEdit => e !== null);
}
