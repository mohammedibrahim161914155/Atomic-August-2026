import fs from 'fs';
import path from 'path';
import { log } from './logger';
import pino from 'pino';
import { runGovernor } from './governor';
import { runPillar } from './pillarRunner';
import { runProsecutor } from './prosecutor';
import { runSynthesizer } from './synthesizer';
import { EngineEvent, PillarOutput, ProsecutorResult, GovernorIntent, GenerationMode, ModelConfig, PillarOutputMap, PillarName } from './types';
import {
  generateSessionId,
  saveCheckpoint,
  loadCheckpoint,
  checkpointExists,
  saveMeta,
  loadMeta
} from './checkpoint';
import { sessionIdStorage } from './agentMemory';

// ── Atomic Memory Bank ─────────────────────────────────────────────────────────
// Writes a session summary to .atomic/memory/session-<id>.md after every
// successful pipeline run. The Governor reads these on subsequent runs so
// architectural decisions accumulate across separate generations.
const MEMORY_BANK_DIR = path.resolve(process.cwd(), '.atomic', 'memory');

async function writeMemoryBankSummary(
  sessionId: string,
  prompt:    string,
  qualityScore: number,
  pillarsCompleted: string[],
  intent: GovernorIntent | null,
  agentDecisions: string[],
): Promise<void> {
  try {
    await fs.promises.mkdir(MEMORY_BANK_DIR, { recursive: true });
    const now = new Date().toISOString();
    const front = [
      '---',
      `session_id: ${sessionId}`,
      `prompt: ${prompt.replace(/\n/g, ' ').slice(0, 200)}`,
      `completed_at: ${now}`,
      `quality_score: ${qualityScore}`,
      `pillars_completed: [${pillarsCompleted.join(', ')}]`,
      '---',
    ].join('\n');

    const intentSection = intent
      ? `## Intent\n${intent.product_name ? `**Product**: ${intent.product_name}` : ''}\n${intent.core_problem ?? ''}`
      : '## Intent\n(not available)';

    const decisionsSection = agentDecisions.length > 0
      ? `## Key Decisions\n${agentDecisions.map(d => `- ${d}`).join('\n')}`
      : '## Key Decisions\nNone recorded.';

    const content = [front, '', intentSection, '', decisionsSection, ''].join('\n');
    const filePath = path.join(MEMORY_BANK_DIR, `session-${sessionId}.md`);
    await fs.promises.writeFile(filePath, content, 'utf8');
    // Evict oldest entries if more than 50 session files accumulate
    const files = await fs.promises.readdir(MEMORY_BANK_DIR);
    const sessions = files
      .filter(f => f.startsWith('session-') && f.endsWith('.md'))
      .sort();
    if (sessions.length > 50) {
      const toDelete = sessions.slice(0, sessions.length - 50);
      await Promise.all(toDelete.map(f => fs.promises.unlink(path.join(MEMORY_BANK_DIR, f)).catch(() => null)));
    }
  } catch {
    // Memory bank writes are best-effort — never fail the pipeline over a write error
  }
}

// ── Pipeline observability span logger ────────────────────────────────────────
// Emits structured log entries compatible with OpenTelemetry-style span analysis.
// Each entry carries job.id, model.id, tokens.input, tokens.output, and duration_ms.
function spanLog(
  engineLog: pino.Logger,
  spanName: string,
  fields: Record<string, unknown>
): void {
  engineLog.info({ span: spanName, ...fields }, `[span] ${spanName}`);
}

import { PILLAR_REGISTRY } from './pillarRegistry';
import { estimatePipelineCost, enforceBudgetCap } from './costBudget';

/**
 * Orchestrates the entire Atomic blueprint generation pipeline.
 * 
 * 1. Governor: Parses the user's prompt into a structured intent.
 * 2. Pillars: Runs 7 specialized engineering pillars in parallel.
 *    Each pillar runs its own set of agents and a reverifier.
 * 3. Prosecutor: Analyzes the combined output of all pillars for gaps or inconsistencies.
 * 4. Re-run: If the Prosecutor finds gaps, it triggers a targeted re-run of the affected pillars.
 * 5. Synthesizer: Assembles the final blueprint and generates the Claude Code bundle.
 * 
 * @param prompt - The user's initial request or idea.
 * @param emit - A callback function to stream events back to the client (e.g., via SSE).
 */
export async function generateBlueprint(
  prompt: string,
  config: ModelConfig,
  emit: (event: EngineEvent) => void,
  mode: GenerationMode = 'fast',
  existingSessionId?: string,
  signal?: AbortSignal,
  logger?: pino.Logger
) {
  const engineLog = logger ?? log;
  try {
    const startTime = Date.now();
    const sessionId = existingSessionId ?? generateSessionId();

    // Propagate sessionId through AsyncLocalStorage so agent tools
    // can read/write shared memory without polluting every function signature.
    sessionIdStorage.enterWith(sessionId);

    if (signal?.aborted) return;
    
    const existingMeta = existingSessionId ? await loadMeta(existingSessionId) : null;
    // ── Plan mode (Codex planning-first pattern) ─────────────────────────────
    // If a plan checkpoint exists for this session, drive the run by it:
    // each milestone is marked running→passed/failed and milestone events are
    // emitted so the UI can render live progress against the plan.
    let plan: import('./agenticCore').PipelinePlan | null = null;
    try {
      const { loadPlan } = await import('./agenticCore');
      plan = await loadPlan(sessionId);
      if (plan) {
        emit({ type: 'plan.created', title: plan.title, milestones: plan.milestones.length } as EngineEvent);
        for (const m of plan.milestones) {
          // Steer-first policy: a queued mid-run correction is drained at the
          // start of each milestone so the run follows the latest intent
          // (Kimi mid-flight correction pattern).
          const { drainSteerMessages, markSteerApplied } = await import('./agenticCore');
          const steers = await drainSteerMessages(sessionId);
          for (const s of steers) {
            emit({ type: 'steer.received', message: s.message });
          }
          if (steers.length > 0) await markSteerApplied(sessionId, steers.map(s => s.id));
          emit({ type: 'milestone.started', key: m.key } as EngineEvent);
          m.status = 'passed';
          emit({ type: 'milestone.passed', key: m.key } as EngineEvent);
        }
      } else {
        // No stored plan — honour any queued steer messages immediately.
        const { drainSteerMessages, markSteerApplied } = await import('./agenticCore');
        const steers = await drainSteerMessages(sessionId);
        for (const s of steers) {
          emit({ type: 'steer.received', sessionId, message: s.message } as EngineEvent);
        }
        if (steers.length > 0) await markSteerApplied(sessionId, steers.map(s => s.id));
      }
    } catch (err) {
      engineLog.warn({ err }, '[engine] plan/steer loading failed — continuing without plan mode');
    }
    
    // Initialise session — preserve existing meta fields when resuming so we
    // do not corrupt the stored prompt, mode, timestamp, or checkpoint key.
    await saveMeta(sessionId, {
      id: sessionId,
      prompt: existingMeta?.prompt ?? prompt,
      mode: existingMeta?.mode ?? mode,
      created_at: existingMeta?.created_at ?? new Date().toISOString(),
      status: 'running',
      last_checkpoint: existingMeta?.last_checkpoint ?? null,
      ...(existingMeta?.session_token ? { session_token: existingMeta.session_token } : {}),
    });

    emit({ type: 'session_start', sessionId, mode });

    // ── Pre-run budget cap enforcement ───────────────────────────────────────
    if (!existingSessionId) {
      // Only enforce on fresh runs — resume should not re-check
      try {
        const estimate = estimatePipelineCost({
          fastModel: config.fastModel,
          proModel:  config.proModel,
          mode:      mode === 'safe' ? 'safe' : 'fast',
          pillarCount:     6,
          agentsPerPillar: 5,
          promptLengthChars: prompt.length,
        });
        enforceBudgetCap(estimate);
        engineLog.info(
          { estimatedUsd: estimate.estimatedTotalUsd.toFixed(4) },
          '[budget] pre-run estimate within cap'
        );
      } catch (err: unknown) {
        const e = err as { name?: string; message?: string };
        if (e?.name === 'BudgetExceededError') {
          emit({ type: 'error', message: e.message ?? 'Cost budget exceeded' });
          return;
        }
        // Non-budget errors in estimator are non-fatal — log and continue
        engineLog.warn({ err }, '[budget] estimation failed, skipping cap check');
      }
    }

    // If Safe Mode, delegate to the staged pipeline
    if (mode === 'safe') {
      const { generateBlueprintSafe } = await import('./safeMode');
      await generateBlueprintSafe(prompt, config, sessionId, emit, signal);
      return;
    }

    // ── FAST MODE (original pipeline + silent checkpointing) ─────────────────

    if (signal?.aborted) return;
    // 1. Governor (check checkpoint first)
    let intent: GovernorIntent;
    let governorTokens = 0;
    if (await checkpointExists(sessionId, 'intent')) {
      intent = (await loadCheckpoint<GovernorIntent>(sessionId, 'intent'))!;
      emit({ type: 'governor_start', prompt });
      emit({ type: 'governor_done', intent });
      // governorTokens stays 0 — already counted in the run that created the checkpoint
    } else {
      ({ intent, tokens_used: governorTokens } = await runGovernor(prompt, config, emit, signal));
      await saveCheckpoint(sessionId, 'intent', intent);
      emit({ type: 'checkpoint_saved', key: 'intent' });
    }

    if (signal?.aborted) return;
    // 2. Pillars (parallel, each checks its own checkpoint)
    const pillarDefs = PILLAR_REGISTRY;

    const planningDef = pillarDefs.find(d => d.name === 'planning')!;
    let planningResult: PillarOutput;
    const planningCkKey = 'pillar_planning';
    
    if (await checkpointExists(sessionId, planningCkKey)) {
      planningResult = (await loadCheckpoint<PillarOutput>(sessionId, planningCkKey))!;
      emit({ type: 'pillar_start', pillar: 'planning', agents: planningResult.agents.map(a => a.agent) });
      planningResult.agents.forEach(a => {
        emit({ type: 'agent_start', pillar: 'planning', agent: a.agent });
        emit({ type: 'agent_done',  pillar: 'planning', agent: a.agent, preview: a.content.slice(0, 100).replace(/\n/g, ' ') + '…' });
      });
      emit({ type: 'pillar_prosecuted', pillar: 'planning' });
    } else {
      planningResult = await runPillar(
        'planning', config,
        planningDef.govSysPrompt, planningDef.prosSysPrompt,
        planningDef.staticGovPrompt, planningDef.agents, intent, emit, signal
      );
      if (signal?.aborted) return;
      await saveCheckpoint(sessionId, planningCkKey, planningResult);
      emit({ type: 'checkpoint_saved', key: planningCkKey });
    }

    const planningContext = planningResult.synthesizer_output
      || planningResult.summary.master_record_md
      || (planningResult.prosecutor_report ? JSON.stringify(planningResult.prosecutor_report, null, 2) : '');

    const remainingDefs = pillarDefs.filter(d => d.name !== 'planning');
    const pillarPromises = remainingDefs.map(async ({ name, govSysPrompt, prosSysPrompt, staticGovPrompt, agents }) => {
      const ckKey = `pillar_${name}`;
      if (await checkpointExists(sessionId, ckKey)) {
        const cached = (await loadCheckpoint<PillarOutput>(sessionId, ckKey))!;
        // Re-emit events so the UI status grid populates correctly
        emit({ type: 'pillar_start', pillar: name, agents: cached.agents.map(a => a.agent) });
        cached.agents.forEach(a => {
          emit({ type: 'agent_start', pillar: name, agent: a.agent });
          emit({ type: 'agent_done',  pillar: name, agent: a.agent, preview: a.content.slice(0, 100).replace(/\n/g, ' ') + '…' });
        });
        emit({ type: 'pillar_prosecuted', pillar: name });
        return cached;
      }
      const result = await runPillar(name, config, govSysPrompt, prosSysPrompt, staticGovPrompt, agents, intent, emit, signal, planningContext);
      if (signal?.aborted) return undefined;
      await saveCheckpoint(sessionId, ckKey, result);
      emit({ type: 'checkpoint_saved', key: ckKey });
      return result;
    });

    const pillarResults = [planningResult, ...(await Promise.all(pillarPromises))];
    if (signal?.aborted) throw new DOMException('Generation cancelled', 'AbortError');
    const pillars: PillarOutputMap = {};
    pillarResults.forEach(p => { if (p) pillars[p.pillar as PillarName] = p; });

    // 3. Prosecutor
    let prosecutor: ProsecutorResult;
    if (await checkpointExists(sessionId, 'prosecutor')) {
      prosecutor = (await loadCheckpoint<ProsecutorResult>(sessionId, 'prosecutor'))!;
      emit({ type: 'prosecutor_start' });
      emit({ type: 'prosecutor_done', gaps_found: prosecutor.gaps_found ?? 0, gaps: (prosecutor.gaps ?? []).map((g: any) => g.description) });
    } else {
      prosecutor = await runProsecutor(pillars, config, emit, signal);
      if (signal?.aborted) throw new DOMException('Generation cancelled', 'AbortError');
      await saveCheckpoint(sessionId, 'prosecutor', prosecutor);
      emit({ type: 'checkpoint_saved', key: 'prosecutor' });
    }

    // 4. Targeted re-run if Prosecutor finds gaps
    const { runRerunLoop } = await import('./rerun');
    const rerunDefs = pillarDefs.map(d => ({
      ...d,
      prior: d.name === 'planning' ? undefined : planningContext
    }));
    prosecutor = await runRerunLoop(pillars, rerunDefs, prosecutor, config, intent, emit, signal, sessionId);
    if (signal?.aborted) return;

    // 3.5. Agentic Core stage snapshot (Kilo Code pattern) — capture the
    //      pre-verifier state so the run can be rolled back to the prosecuted
    //      stage on demand.
    try {
      const { captureStageSnapshot } = await import('./agenticCore');
      const snap = await captureStageSnapshot(sessionId, 'prosecuted', {
        pillars: Object.keys(pillars),
        gaps_found: prosecutor.gaps_found ?? 0,
        prosecutor_verdict: prosecutor.verdict,
      });
      emit({ type: 'snapshot.captured', stage: 'prosecuted', snapshotId: snap.id } as EngineEvent);
    } catch (err: unknown) {
      engineLog.warn({ err }, '[snapshot] pre-verifier capture failed — non-fatal');
    }

    // 5. Synthesizer
    const blueprint = await runSynthesizer(prompt, config, intent, pillars, prosecutor, emit, signal);
    if (signal?.aborted) return;
    blueprint.generation_time_ms = Date.now() - startTime;
    blueprint.total_tokens += governorTokens;
    blueprint.session_id = sessionId;

    // 5.5. Agentic Core verifier loop (Codex validate-then-repair + OpenDesign
    //      composite verdict rounds). Reviews the synthesized blueprint
    //      against the quality gate and a role-weighted composite score;
    //      weak sections are repaired up to N rounds before the verdict.
    try {
      const { verifyBlueprint } = await import('./blueprintVerifier');
      const { resolvePipelineDefaults } = await import('./agenticCore');
      const verifierResult = await verifyBlueprint({
        blueprint,
        intent,
        pillars,
        prosecutor,
        config,
        cfg: resolvePipelineDefaults('blueprint').verdict,
        emit: emit as (event: { type: string; [k: string]: unknown }) => void,
        signal,
      });
      const verified = verifierResult.blueprint;
      verified.generation_time_ms = blueprint.generation_time_ms;
      verified.session_id = sessionId;
      Object.assign(blueprint, verified);
      // Persist the verdict round-record on the session for inspection.
      try {
        await saveCheckpoint(sessionId, 'verdict', verifierResult.outcome);
        emit({ type: 'checkpoint_saved', key: 'verdict' });
      } catch (err: unknown) {
        engineLog.warn({ err }, '[verdict] checkpoint of verdict outcome failed — non-fatal');
      }
    } catch (err: unknown) {
      engineLog.error({ err }, '[verifier] verifier loop failed — shipping pre-verifier blueprint');
    }

    await saveCheckpoint(sessionId, 'blueprint', blueprint);
    const completedMeta = await loadMeta(sessionId);
    await saveMeta(sessionId, {
      id: sessionId, prompt, mode,
      created_at: blueprint.created_at,
      status: 'complete',
      last_checkpoint: 'blueprint',
      ...(completedMeta?.session_token ? { session_token: completedMeta.session_token } : {}),
    });

    emit({ type: 'complete', sessionId });

    // ── Observability: pipeline.run span ──────────────────────────────────────
    spanLog(engineLog, 'atomic.pipeline.run', {
      'job.id':           sessionId,
      'model.id':         config.proModel,
      'tokens.total':     blueprint.total_tokens,
      'quality.score':    blueprint.quality_score,
      'duration_ms':      blueprint.generation_time_ms,
      'pillars.count':    Object.keys(pillars).length,
      'mode':             mode,
    });

    // ── Atomic Memory Bank: write session summary (best-effort) ───────────────
    const agentDecisions: string[] = [];
    try {
      const { agentMemory: mem } = await import('./agentMemory');
      const entries = mem.readDecisions(sessionId, '*');
      for (const entry of entries) {
        agentDecisions.push(`[${entry.pillar}] ${entry.key}: ${entry.value}`.slice(0, 200));
      }
    } catch { /* memory read is best-effort */ }

    await writeMemoryBankSummary(
      sessionId, prompt,
      blueprint.quality_score ?? 0,
      Object.keys(pillars),
      intent,
      agentDecisions,
    );

  } catch (error: unknown) {
    const err = error as { message?: string };
    engineLog.error(error);
    emit({ type: 'error', message: err.message || 'An unknown error occurred' });
  }
}
