import { log } from './logger';
import { runGovernor } from './governor';
import { runPillar } from './pillarRunner';
import { runProsecutor } from './prosecutor';
import { runSynthesizer } from './synthesizer';
import { EngineEvent, PillarOutput, ProsecutorResult, GovernorIntent, ModelConfig, PillarOutputMap, PillarName } from './types';
import {
  saveCheckpoint, loadCheckpoint, checkpointExists,
  saveMeta, loadMeta
} from './checkpoint';

import { PILLAR_REGISTRY, PILLAR_MAP } from './pillarRegistry';

export async function generateBlueprintSafe(
  prompt: string,
  config: ModelConfig,
  sessionId: string,
  emit: (event: EngineEvent) => void,
  signal?: AbortSignal
): Promise<void> {  
  const startTime = Date.now();

  try {
    if (signal?.aborted) return;
    // ── STAGE 1: Governor ──────────────────────────────────────────────────
    emit({ type: 'stage_start', stage: 'governor' });
    let intent: GovernorIntent;
    if (await checkpointExists(sessionId, 'intent')) {
      intent = (await loadCheckpoint<GovernorIntent>(sessionId, 'intent'))!;
      emit({ type: 'governor_start', prompt });
      emit({ type: 'governor_done', intent });
    } else {
      ({ intent } = await runGovernor(prompt, config, emit, signal));
      if (signal?.aborted) return;
      await saveCheckpoint(sessionId, 'intent', intent);
      emit({ type: 'checkpoint_saved', key: 'intent' });
    }
    emit({ type: 'stage_complete', stage: 'governor' });

    // ── STAGE 2: Planning Pillar ───────────────────────────────────────────
    emit({ type: 'stage_start', stage: 'planning' });
    let planningResult: PillarOutput;
    if (await checkpointExists(sessionId, 'pillar_planning')) {
      planningResult = (await loadCheckpoint<PillarOutput>(sessionId, 'pillar_planning'))!;
      emit({ type: 'pillar_start', pillar: 'planning', agents: planningResult.agents.map(a => a.agent) });
      planningResult.agents.forEach(a => {
        emit({ type: 'agent_start', pillar: 'planning', agent: a.agent });
        emit({ type: 'agent_done',  pillar: 'planning', agent: a.agent, preview: a.content.slice(0, 100).replace(/\n/g, ' ') + '…' });
      });
      emit({ type: 'pillar_prosecuted', pillar: 'planning' });
    } else {
      planningResult = await runPillar('planning', config, PILLAR_MAP['planning'].govSysPrompt, PILLAR_MAP['planning'].prosSysPrompt, PILLAR_MAP['planning'].staticGovPrompt, PILLAR_MAP['planning'].agents, intent, emit, signal);
      if (signal?.aborted) return;
      await saveCheckpoint(sessionId, 'pillar_planning', planningResult);
      emit({ type: 'checkpoint_saved', key: 'pillar_planning' });
    }
    emit({ type: 'stage_complete', stage: 'planning' });

    // Build the planning context string to pass to other pillars
    const planningContext = planningResult.synthesizer_output
      || planningResult.summary.master_record_md
      || (planningResult.prosecutor_report ? JSON.stringify(planningResult.prosecutor_report, null, 2) : '');

    if (signal?.aborted) return;

    // ── STAGE 2.5: Security (with planning context) ────────────────────────
    emit({ type: 'stage_start', stage: 'security' });
    let securityResult: PillarOutput;
    if (await checkpointExists(sessionId, 'pillar_security')) {
      securityResult = (await loadCheckpoint<PillarOutput>(sessionId, 'pillar_security'))!;
      emit({ type: 'pillar_start', pillar: 'security', agents: securityResult.agents.map(a => a.agent) });
      securityResult.agents.forEach(a => {
        emit({ type: 'agent_start', pillar: 'security', agent: a.agent });
        emit({ type: 'agent_done',  pillar: 'security', agent: a.agent, preview: a.content.slice(0, 100).replace(/\n/g, ' ') + '…' });
      });
      emit({ type: 'pillar_prosecuted', pillar: 'security' });
    } else {
      securityResult = await runPillar(
        'security', config, PILLAR_MAP['security'].govSysPrompt, PILLAR_MAP['security'].prosSysPrompt, PILLAR_MAP['security'].staticGovPrompt, PILLAR_MAP['security'].agents, intent, emit, signal, planningContext
      );
      if (signal?.aborted) return;
      await saveCheckpoint(sessionId, 'pillar_security', securityResult);
      emit({ type: 'checkpoint_saved', key: 'pillar_security' });
    }
    emit({ type: 'stage_complete', stage: 'security' });

    const securityContext = securityResult.synthesizer_output
      || securityResult.summary.master_record_md
      || (securityResult.prosecutor_report ? JSON.stringify(securityResult.prosecutor_report, null, 2) : '');

    const fullContext = planningContext + '\n\n' + securityContext;

    if (signal?.aborted) return;

    // ── STAGE 3: Remaining 5 pillars in parallel ───────────────────────────
    emit({ type: 'stage_start', stage: 'pillars' });
    const remainingDefs: Array<{
      name: Parameters<typeof runPillar>[0];
      govSysPrompt: string;
      prosSysPrompt: string;
      staticGovPrompt: string;
      agents: Parameters<typeof runPillar>[5];
      priorContext: string;
    }> = [
      { name: 'production',   govSysPrompt: PILLAR_MAP['production'].govSysPrompt,   prosSysPrompt: PILLAR_MAP['production'].prosSysPrompt,   staticGovPrompt: PILLAR_MAP['production'].staticGovPrompt,   agents: PILLAR_MAP['production'].agents, priorContext: fullContext },
      { name: 'edge_cases',   govSysPrompt: PILLAR_MAP['edge_cases'].govSysPrompt,    prosSysPrompt: PILLAR_MAP['edge_cases'].prosSysPrompt,    staticGovPrompt: PILLAR_MAP['edge_cases'].staticGovPrompt,    agents: PILLAR_MAP['edge_cases'].agents, priorContext: fullContext },
      { name: 'integration',  govSysPrompt: PILLAR_MAP['integration'].govSysPrompt,  prosSysPrompt: PILLAR_MAP['integration'].prosSysPrompt,  staticGovPrompt: PILLAR_MAP['integration'].staticGovPrompt,  agents: PILLAR_MAP['integration'].agents, priorContext: fullContext },
      // Intentional: quality + completeness only need planning context.
      // They govern engineering standards and feature coverage, not security
      // architecture — adding security context would dilute their focus.
      { name: 'quality',      govSysPrompt: PILLAR_MAP['quality'].govSysPrompt,      prosSysPrompt: PILLAR_MAP['quality'].prosSysPrompt,      staticGovPrompt: PILLAR_MAP['quality'].staticGovPrompt,      agents: PILLAR_MAP['quality'].agents, priorContext: planningContext },
      { name: 'completeness', govSysPrompt: PILLAR_MAP['completeness'].govSysPrompt, prosSysPrompt: PILLAR_MAP['completeness'].prosSysPrompt, staticGovPrompt: PILLAR_MAP['completeness'].staticGovPrompt, agents: PILLAR_MAP['completeness'].agents, priorContext: planningContext },
    ];

    const remainingResults = await Promise.all(
      remainingDefs.map(async ({ name, govSysPrompt, prosSysPrompt, staticGovPrompt, agents, priorContext }) => {
        const ckKey = `pillar_${name}`;
        if (await checkpointExists(sessionId, ckKey)) {
          const cached = (await loadCheckpoint<PillarOutput>(sessionId, ckKey))!;
          emit({ type: 'pillar_start', pillar: name, agents: cached.agents.map(a => a.agent) });
          cached.agents.forEach(a => {
            emit({ type: 'agent_start', pillar: name, agent: a.agent });
            emit({ type: 'agent_done',  pillar: name, agent: a.agent, preview: a.content.slice(0, 100).replace(/\n/g, ' ') + '…' });
          });
          emit({ type: 'pillar_prosecuted', pillar: name });
          return cached;
        }
        const result = await runPillar(name, config, govSysPrompt, prosSysPrompt, staticGovPrompt, agents, intent, emit, signal, priorContext);
        if (signal?.aborted) return undefined;
        await saveCheckpoint(sessionId, ckKey, result);
        emit({ type: 'checkpoint_saved', key: ckKey });
        return result;
      })
    );

    if (signal?.aborted) return;

    const pillars: PillarOutputMap = { planning: planningResult, security: securityResult };
    remainingResults.forEach(p => { if (p) pillars[p.pillar as PillarName] = p; });
    emit({ type: 'stage_complete', stage: 'pillars' });

    // ── STAGE 4: Prosecutor ────────────────────────────────────────────────
    emit({ type: 'stage_start', stage: 'prosecutor' });
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
    emit({ type: 'stage_complete', stage: 'prosecutor' });

    if (signal?.aborted) throw new DOMException('Generation cancelled', 'AbortError');

    // ── STAGE 5: Targeted re-run ───────────────────────────────────────────
    const { runRerunLoop } = await import('./rerun');
    const allDefs = PILLAR_REGISTRY.map(def => ({
      ...def,
      prior: def.name === 'planning' ? undefined
        : ['production', 'edge_cases', 'integration'].includes(def.name) ? fullContext
        : planningContext
    }));
    prosecutor = await runRerunLoop(pillars, allDefs, prosecutor, config, intent, emit, signal, sessionId);
    if (signal?.aborted) return;

    // ── STAGE 6: Synthesizer ───────────────────────────────────────────────
    emit({ type: 'stage_start', stage: 'synthesizer' });
    const blueprint = await runSynthesizer(prompt, config, intent, pillars, prosecutor, emit, signal);
    if (signal?.aborted) return;
    blueprint.generation_time_ms = Date.now() - startTime;
    blueprint.session_id = sessionId;
    emit({ type: 'stage_complete', stage: 'synthesizer' });

    await saveCheckpoint(sessionId, 'blueprint', blueprint);
    const existingMeta = await loadMeta(sessionId);
    await saveMeta(sessionId, {
      id: sessionId, prompt, mode: 'safe',
      created_at: blueprint.created_at,
      status: 'complete',
      last_checkpoint: 'blueprint',
      ...(existingMeta?.session_token ? { session_token: existingMeta.session_token } : {}),
    });

    emit({ type: 'complete', sessionId });

  } catch (error: any) {
    if (signal?.aborted) return;
    log.error({ err: error }, '[safeMode]');
    // Update meta to partial
    const meta = await loadMeta(sessionId);
    if (meta) await saveMeta(sessionId, { ...meta, status: 'partial' });
    emit({ type: 'error', message: error.message || 'An unknown error occurred in Safe Mode' });
  }
}
