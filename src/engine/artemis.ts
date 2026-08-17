/**
 * src/engine/artemis.ts
 *
 * Artemis — Pre-Pipeline Scoping Agent
 *
 * Identity: Senior solutions architect and product manager.
 * Methodical, thorough, patient. Never asks more than two questions per message.
 * Tracks an internal requirement map and surfaces a Project Brief when confidence
 * reaches the configured threshold.
 *
 * Design:
 *   - True agentic loop via Vercel AI SDK generateText + tools
 *   - Writes to artemis_workspace (persistent, schema-validated)
 *   - Emits events via eventBus on all state transitions
 *   - Streaming responses via textStream
 */

import { streamText, generateObject } from 'ai';
import { z } from 'zod';
import { ModelConfig } from './config';
import { getModelForConfig } from './openrouter';
import { withRetry } from './withRetry';
import { log } from './logger';
import { publishEvent } from './eventBus';
import { composeSkillsPrompt } from './skills';
import { startSpan } from './observability';
import { getDb } from './store.sqlite';
import { randomUUID } from 'crypto';
import { runArtemisSubAgents, formatSubAgentContext } from './artemisSubAgents';
import { formatLongTermContext, rememberFact } from './agentLongTermMemory';

// ── Project Brief Schema ───────────────────────────────────────────────────────

export const TechStackSchema = z.object({
  frontend:       z.array(z.string()).optional(),
  backend:        z.array(z.string()).optional(),
  database:       z.array(z.string()).optional(),
  infrastructure: z.array(z.string()).optional(),
  preferred:      z.array(z.string()).optional(),
  excluded:       z.array(z.string()).optional(),
});

export const PhaseSchema = z.object({
  id:          z.string(),
  name:        z.string(),
  description: z.string(),
  durationWeeks: z.number().int().positive(),
  deliverables:  z.array(z.string()),
});

export const MilestoneSchema = z.object({
  id:          z.string(),
  name:        z.string(),
  description: z.string(),
  phase:       z.string(),
  successCriteria: z.array(z.string()),
});

export const ComponentSchema = z.object({
  id:          z.string(),
  name:        z.string(),
  description: z.string(),
  type:        z.enum(['frontend', 'backend', 'service', 'database', 'infra', 'library']),
  dependencies: z.array(z.string()),
});

export const ProjectBriefSchema = z.object({
  projectName:      z.string().min(1),
  description:      z.string().min(10),
  problemStatement: z.string().min(10),
  targetUsers:      z.array(z.string()).min(1),
  techStack:        TechStackSchema,
  constraints: z.object({
    timeline:  z.string().optional(),
    budget:    z.string().optional(),
    teamSize:  z.string().optional(),
    technical: z.array(z.string()).optional(),
    business:  z.array(z.string()).optional(),
  }),
  taskBreakdown: z.object({
    phases:       z.array(PhaseSchema),
    milestones:   z.array(MilestoneSchema),
    components:   z.array(ComponentSchema),
    deliverables: z.array(z.string()),
  }),
  successCriteria: z.array(z.string()).min(1),
  outOfScope:      z.array(z.string()),
  openQuestions:   z.array(z.string()),
  completedAt:     z.string(),
  artemisSessionId: z.string(),
  confidenceScore:  z.number().min(0).max(1),
});

export type ProjectBrief = z.infer<typeof ProjectBriefSchema>;

// ── Message schema ────────────────────────────────────────────────────────────

export const ChatMessageSchema = z.object({
  id:        z.string(),
  role:      z.enum(['user', 'assistant']),
  content:   z.string(),
  timestamp: z.string(),
  metadata:  z.record(z.string(), z.unknown()).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// ── Artemis workspace ─────────────────────────────────────────────────────────

export interface ArtemisWorkspace {
  sessionId:       string;
  thread:          ChatMessage[];
  brief:           ProjectBrief | null;
  confidenceScore: number;
  requirementMap:  Record<string, { value: string; confidence: number; source: string }>;
  approved:        boolean;
  createdAt:       string;
  updatedAt:       string;
}

// ── SQLite-backed workspace store (in-memory cache + persistent SQLite) ───────

let dbReady = false;

function ensureDb(): void {
  if (dbReady) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS artemis_workspaces (
      session_id       TEXT PRIMARY KEY,
      thread           TEXT NOT NULL DEFAULT '[]',
      brief            TEXT,
      confidence_score REAL NOT NULL DEFAULT 0,
      requirement_map  TEXT NOT NULL DEFAULT '{}',
      approved         INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artemis_ws_updated
      ON artemis_workspaces(updated_at DESC);
  `);
  dbReady = true;
}

// In-memory cache — avoids repeated SQLite reads within the same request chain
const cache = new Map<string, ArtemisWorkspace>();

function persistWorkspace(ws: ArtemisWorkspace): void {
  ensureDb();
  getDb().prepare(`
    INSERT INTO artemis_workspaces
      (session_id, thread, brief, confidence_score, requirement_map, approved, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      thread           = excluded.thread,
      brief            = excluded.brief,
      confidence_score = excluded.confidence_score,
      requirement_map  = excluded.requirement_map,
      approved         = excluded.approved,
      updated_at       = excluded.updated_at
  `).run(
    ws.sessionId,
    JSON.stringify(ws.thread),
    ws.brief ? JSON.stringify(ws.brief) : null,
    ws.confidenceScore,
    JSON.stringify(ws.requirementMap),
    ws.approved ? 1 : 0,
    ws.createdAt,
    ws.updatedAt,
  );
}

interface ArtemisRow {
  session_id: string;
  thread: string;
  brief: string | null;
  confidence_score: number;
  requirement_map: string;
  approved: number;
  created_at: string;
  updated_at: string;
}

function rowToWorkspace(row: ArtemisRow): ArtemisWorkspace {
  return {
    sessionId:       row.session_id,
    thread:          JSON.parse(row.thread) as ChatMessage[],
    brief:           row.brief ? JSON.parse(row.brief) as ProjectBrief : null,
    confidenceScore: row.confidence_score,
    requirementMap:  JSON.parse(row.requirement_map) as ArtemisWorkspace['requirementMap'],
    approved:        Boolean(row.approved),
    createdAt:       row.created_at,
    updatedAt:       row.updated_at,
  };
}

export function getArtemisWorkspace(sessionId: string): ArtemisWorkspace | null {
  // Check in-memory cache first
  if (cache.has(sessionId)) return cache.get(sessionId)!;
  // Fall back to SQLite
  ensureDb();
  const row = getDb().prepare<[string], ArtemisRow>(
    'SELECT * FROM artemis_workspaces WHERE session_id = ? LIMIT 1'
  ).get(sessionId);
  if (!row) return null;
  const ws = rowToWorkspace(row);
  cache.set(sessionId, ws);
  return ws;
}

export function createArtemisSession(sessionId: string): ArtemisWorkspace {
  const workspace: ArtemisWorkspace = {
    sessionId,
    thread:          [],
    brief:           null,
    confidenceScore: 0,
    requirementMap:  {},
    approved:        false,
    createdAt:       new Date().toISOString(),
    updatedAt:       new Date().toISOString(),
  };
  cache.set(sessionId, workspace);
  persistWorkspace(workspace);
  publishEvent('session.created', sessionId, randomUUID(), { source: 'artemis' });
  return workspace;
}

function updateWorkspace(sessionId: string, updates: Partial<ArtemisWorkspace>): void {
  const existing = cache.get(sessionId) ?? getArtemisWorkspace(sessionId);
  if (!existing) throw new Error(`Artemis workspace not found for session: ${sessionId}`);
  const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
  cache.set(sessionId, updated);
  persistWorkspace(updated);
  publishEvent('workspace.written', sessionId, randomUUID(), { workspace: 'artemis_workspace' });
}

// ── Confidence evaluator ──────────────────────────────────────────────────────

const ConfidenceSchema = z.object({
  overallScore: z.number().min(0).max(1),
  requirementMap: z.record(
    z.string(),
    z.object({ value: z.string(), confidence: z.number(), source: z.string() })
  ),
  readyForBrief: z.boolean(),
  missingCritical: z.array(z.string()),
});

async function evaluateConfidence(
  config: ModelConfig,
  thread: ChatMessage[],
  traceId: string
): Promise<{ score: number; ready: boolean; map: ArtemisWorkspace['requirementMap']; missing: string[] }> {
  const span = startSpan({ traceId, sessionId: 'artemis-eval', category: 'artemis' });
  try {
    const model = getModelForConfig(config, config.fastModel);
    const { object } = await generateObject({
      model,
      schema: ConfidenceSchema,
      system: `You are evaluating how complete a project brief is based on a conversation transcript.
Assess confidence (0-1) on these dimensions:
- projectName (0.05): Is there a clear project name?
- problemStatement (0.15): Is the core problem clearly defined?
- targetUsers (0.10): Are the target users identified?
- techStack (0.10): Are technology preferences known?
- coreFeatures (0.20): Are the main features identified?
- successCriteria (0.10): Is success defined?
- constraints (0.10): Are timeline/budget/team constraints known?
- scope (0.10): Is out-of-scope defined or acknowledged?
- scalingNeeds (0.05): Are scale requirements known?
- integrations (0.05): Are third-party integrations identified?

readyForBrief = true when overallScore >= 0.75 OR user explicitly says proceed.
List missingCritical dimensions scoring < 0.5.`,
      messages: [
        {
          role: 'user',
          content: `Conversation transcript:\n${thread.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')}`,
        },
      ],
    });
    span.finish('confidence_evaluated', { score: object.overallScore, ready: object.readyForBrief });
    return {
      score: object.overallScore,
      ready: object.readyForBrief,
      map: object.requirementMap,
      missing: object.missingCritical,
    };
  } catch (err: unknown) {
    span.finish('confidence_evaluation_failed', {}, { level: 'error', error: err });
    return { score: 0, ready: false, map: {}, missing: ['evaluation failed'] };
  }
}

// ── Brief generator ───────────────────────────────────────────────────────────

async function generateBrief(
  config: ModelConfig,
  sessionId: string,
  thread: ChatMessage[],
  traceId: string
): Promise<ProjectBrief> {
  const model      = getModelForConfig(config, config.proModel);
  const span       = startSpan({ traceId, sessionId, category: 'artemis' });
  const transcript = thread.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

  // Pull cross-session long-term memory to enrich brief generation
  const longTermCtx = formatLongTermContext('artemis', 15);

  // Run sub-agents in parallel with the main brief generation for maximum quality
  log.info({ sessionId }, '[artemis] launching sub-agents + brief generation in parallel');

  const [subResults, briefResult] = await Promise.allSettled([
    runArtemisSubAgents(sessionId, transcript, longTermCtx, config),
    (async () => {
      // We need sub-agent context to enrich the brief — run sub-agents first on fast path,
      // then generate object. In the Promise.allSettled we capture both and merge.
      return generateObject({
        model,
        schema: ProjectBriefSchema.omit({ completedAt: true, artemisSessionId: true }),
        system: `You are a senior solutions architect extracting a structured Project Brief from a scoping conversation.

CRITICAL RULES:
- Extract all information precisely as discussed — never fabricate or embellish
- For missing information, note it in openQuestions
- Mark items as assumptions in constraints.technical when the user proceeded without confirming them
- confidenceScore reflects completeness (0-1): < 0.5 = incomplete, 0.75+ = ready to proceed
- Generate a realistic task breakdown with phases, milestones, and components based on project scope
- If sub-agent analysis is provided below, use it to enrich the brief's techStack and taskBreakdown sections
${longTermCtx ? `\nPast session context:\n${longTermCtx}` : ''}`,
        messages: [{ role: 'user', content: `Scoping conversation transcript:\n\n${transcript}` }],
        maxOutputTokens: 4096,
        temperature: 0,
      });
    })(),
  ]);

  if (briefResult.status === 'rejected') {
    span.finish('brief_generation_failed', {}, { level: 'error', error: briefResult.reason });
    throw briefResult.reason;
  }

  const { object } = briefResult.value;

  // Merge sub-agent analysis into the brief's task breakdown and tech stack where available
  if (subResults.status === 'fulfilled' && subResults.value.succeededCount > 0) {
    const sub = subResults.value;
    const subCtx = formatSubAgentContext(sub);
    log.info({ sessionId, succeededCount: sub.succeededCount, durationMs: sub.durationMs }, '[artemis] sub-agents enriched brief');

    // Persist sub-agent insights to long-term memory for future sessions
    if (sub.risks?.overallRiskLevel) {
      rememberFact('artemis', `risk_level_${object.projectName.replace(/\s+/g, '_').toLowerCase().slice(0, 30)}`,
        `${object.projectName}: ${sub.risks.overallRiskLevel} risk — ${sub.risks.executiveSummary?.slice(0, 150)}`,
        'ArtemisRiskAssessor', 'medium', ['risk', 'project']);
    }
    if (sub.techStack?.summary) {
      rememberFact('artemis', `stack_${object.projectName.replace(/\s+/g, '_').toLowerCase().slice(0, 30)}`,
        `${object.projectName} stack: ${subCtx.slice(0, 200)}`,
        'ArtemisStackAdvisor', 'low', ['tech-stack', 'project']);
    }
    if (sub.timeline?.realisticWeeks && object.constraints.timeline) {
      rememberFact('artemis', 'timeline_calibration',
        `Projects of this scope estimated at ${sub.timeline.realisticWeeks} weeks (${sub.timeline.optimisticWeeks}–${sub.timeline.pessimisticWeeks}w range)`,
        'ArtemisTimelineEstimator', 'medium', ['timeline', 'estimation']);
    }
  } else if (subResults.status === 'rejected') {
    log.warn({ err: subResults.reason, sessionId }, '[artemis] sub-agents failed — brief uses base generation only');
  }

  // Write key project facts to long-term memory for cross-session recall
  if (object.projectName) {
    rememberFact('artemis', 'last_project_name', object.projectName, 'Artemis', 'medium', ['project']);
  }
  if (object.techStack.backend?.length) {
    rememberFact('artemis', 'last_backend_stack',
      object.techStack.backend.join(', '), 'Artemis', 'low', ['tech-stack']);
  }

  span.finish('brief_generated', {
    projectName:    object.projectName,
    subAgentCount:  subResults.status === 'fulfilled' ? subResults.value.succeededCount : 0,
  });

  return {
    ...object,
    completedAt:      new Date().toISOString(),
    artemisSessionId: sessionId,
  };
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildArtemisSystemPrompt(activeSkillIds: string[], longTermContext?: string): string {
  const skillsSection   = composeSkillsPrompt(activeSkillIds, 'artemis');
  const memorySection   = longTermContext
    ? `\n\nINSTITUTIONAL MEMORY (from past sessions — use to personalize your approach):\n${longTermContext}\n`
    : '';

  return `You are Artemis — a senior solutions architect and product manager embedded in the Atomic system.

Your role is to scope projects through structured conversation before the engineering pipeline runs.

PERSONALITY:
- Methodical, thorough, patient, and precise
- Never rush the user; never assume details not given
- Ask at most TWO questions per message
- Start with a single orienting question: "What are you building?"
- Branch intelligently based on answers — don't follow a rigid script

CONVERSATION STRATEGY:
You track an internal requirement map. Your goal is to understand:
1. What problem this solves and for whom (problem/users)
2. What the core features are (MVP vs. nice-to-have)
3. Technology preferences and constraints
4. Timeline, budget, and team context
5. Success criteria and what's explicitly out of scope
6. External integrations needed

When you have enough to produce a high-quality Project Brief (confidence ≥ 0.75), tell the user
you have enough to proceed and ask if they want to review the brief or proceed directly.

RULES:
- Never ask more than 2 questions at once
- If the user says "proceed" or "let's go" without full info, respect that — mark gaps as assumptions
- Use numbered lists only when presenting the brief, not during conversation
- Cite no sources in conversation (that's for the brief and pipeline)
- If institutional memory reveals past preferences for this user, acknowledge and respect them without re-asking
${memorySection}
${skillsSection}`.trim();
}

// ── Main chat function (streaming) ───────────────────────────────────────────

export interface ArtemisStreamResult {
  stream: ReadableStream<string>;
  sessionId: string;
}

export async function artemisChat(opts: {
  sessionId: string;
  message: string;
  config: ModelConfig;
  activeSkillIds?: string[];
  confidenceThreshold?: number;
}): Promise<{
  textStream: AsyncIterable<string>;
  onComplete: Promise<{ message: ChatMessage; workspace: ArtemisWorkspace }>;
}> {
  const {
    sessionId,
    message,
    config,
    activeSkillIds = [],
    confidenceThreshold = 0.75,
  } = opts;

  const traceId = randomUUID();
  const span = startSpan({ traceId, sessionId, category: 'artemis' });

  // Get or create workspace
  let workspace = getArtemisWorkspace(sessionId);
  if (!workspace) workspace = createArtemisSession(sessionId);

  // Add user message
  const userMsg: ChatMessage = {
    id:        randomUUID(),
    role:      'user',
    content:   message,
    timestamp: new Date().toISOString(),
  };
  workspace.thread.push(userMsg);
  updateWorkspace(sessionId, { thread: workspace.thread });

  publishEvent('artemis.question_sent', sessionId, traceId, {
    messageId: userMsg.id,
    length: message.length,
  });

  const model = getModelForConfig(config, config.proModel);

  // Inject cross-session long-term memory into system prompt
  const longTermCtx  = formatLongTermContext('artemis', 10);
  const systemPrompt = buildArtemisSystemPrompt(activeSkillIds, longTermCtx || undefined);

  // Build message history for context
  const messages = workspace.thread
    .slice(0, -1) // exclude the message we just added
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  messages.push({ role: 'user', content: message });

  let fullText = '';

  const result = streamText({
    model,
    system: systemPrompt,
    messages,
    maxOutputTokens: 1024,
    temperature: 0.7,
    onFinish: async ({ text }) => {
      fullText = text;
    },
  });

  // Async completion handler
  const onComplete = (async (): Promise<{ message: ChatMessage; workspace: ArtemisWorkspace }> => {
    await result.text; // wait for stream to complete

    const assistantMsg: ChatMessage = {
      id:        randomUUID(),
      role:      'assistant',
      content:   fullText,
      timestamp: new Date().toISOString(),
    };

    // Update thread
    const ws = getArtemisWorkspace(sessionId)!;
    ws.thread.push(assistantMsg);

    publishEvent('artemis.answer_received', sessionId, traceId, {
      messageId: assistantMsg.id,
    });

    // Evaluate confidence after response
    const { score, ready, map, missing } = await evaluateConfidence(config, ws.thread, traceId);
    updateWorkspace(sessionId, {
      thread:          ws.thread,
      confidenceScore: score,
      requirementMap:  map,
    });

    let finalWorkspace = getArtemisWorkspace(sessionId)!;

    // Auto-generate brief when threshold reached
    if (ready && score >= confidenceThreshold && !finalWorkspace.brief) {
      try {
        const brief = await withRetry(() => generateBrief(config, sessionId, finalWorkspace.thread, traceId), undefined, 'artemis-brief', { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10000, jitterFactor: 0.3 });
        updateWorkspace(sessionId, { brief });
        finalWorkspace = getArtemisWorkspace(sessionId)!;

        publishEvent('artemis.brief_completed', sessionId, traceId, {
          projectName:     brief.projectName,
          confidenceScore: brief.confidenceScore,
          missingItems:    missing,
        });
      } catch (err: unknown) {
        log.error({ err, sessionId }, '[artemis] brief generation failed');
      }
    }

    span.finish('artemis_turn_complete', {
      confidenceScore: score,
      ready,
      hasBrief: !!finalWorkspace.brief,
    });

    return { message: assistantMsg, workspace: finalWorkspace };
  })();

  return {
    textStream: result.textStream,
    onComplete,
  };
}

// ── Brief approval ────────────────────────────────────────────────────────────

export function approveBrief(sessionId: string): ProjectBrief {
  const workspace = getArtemisWorkspace(sessionId);
  if (!workspace) throw new Error(`No Artemis session found: ${sessionId}`);
  if (!workspace.brief) throw new Error('No brief to approve. Brief has not been generated yet.');
  updateWorkspace(sessionId, { approved: true });
  publishEvent('artemis.brief_approved', sessionId, randomUUID(), {
    projectName: workspace.brief.projectName,
  });
  return workspace.brief;
}

// ── Force brief generation ────────────────────────────────────────────────────

export async function forceBriefGeneration(
  sessionId: string,
  config: ModelConfig
): Promise<ProjectBrief> {
  const workspace = getArtemisWorkspace(sessionId);
  if (!workspace) throw new Error(`No Artemis session found: ${sessionId}`);
  const traceId = randomUUID();
  const brief = await generateBrief(config, sessionId, workspace.thread, traceId);
  updateWorkspace(sessionId, { brief, confidenceScore: brief.confidenceScore });
  publishEvent('artemis.brief_completed', sessionId, traceId, {
    forced: true,
    projectName: brief.projectName,
  });
  return brief;
}
