import { ProsecutorResult, ModelConfig, EngineEvent, GovernorIntent, PillarOutputMap, PillarName, ProsecutorGap } from './types';
import { runPillar, AgentDef } from './pillarRunner';
import { runProsecutor } from './prosecutor';
import { saveCheckpoint } from './checkpoint';
import { log } from './logger';

export interface RerunPillarDef {
  name: PillarName;
  govSysPrompt: string;
  prosSysPrompt: string;
  staticGovPrompt: string;
  agents: AgentDef[];
  prior?: string;
}

/**
 * Targeted rerun loop: after the initial prosecutor run, if gaps remain,
 * re-runs only the implicated pillars and re-prosecutes until either:
 *   - All gaps are resolved (verdict === 'approved')
 *   - MAX_RERUN_ATTEMPTS is reached
 *   - No gaps were resolved in the last 2 attempts (early exit)
 *   - The session token budget is exceeded
 *
 * @param tokenBudget  Optional ceiling on total tokens across all rerun attempts.
 *                     When provided, a new attempt is skipped if accumulated pillar
 *                     tokens already exceed the budget. The SSE abort signal provides
 *                     a complementary reactive ceiling at the server layer.
 */
export async function runRerunLoop(
  pillars: PillarOutputMap,
  pillarDefs: RerunPillarDef[],
  prosecutor: ProsecutorResult,
  config: ModelConfig,
  intent: GovernorIntent,
  emit: (event: EngineEvent) => void,
  signal: AbortSignal | undefined,
  sessionId: string,
  tokenBudget?: number,
): Promise<ProsecutorResult> {
  const MAX_RERUN_ATTEMPTS = 4;
  let rerunAttempt = 0;
  let previousProsecutor = prosecutor;

  while (
    prosecutor.verdict === 'requires_revision' &&
    prosecutor.gaps?.length &&
    rerunAttempt < MAX_RERUN_ATTEMPTS
  ) {
    if (signal?.aborted) return prosecutor;

    // ── Proactive token budget check ────────────────────────────────────────
    // Sum tokens already accumulated across all pillars. If we are already at
    // or beyond the budget, starting another rerun would exceed it further.
    if (tokenBudget !== undefined) {
      const tokensUsedSoFar = Object.values(pillars).reduce(
        (sum, p) => sum + (p.tokens_total ?? 0), 0
      );
      if (tokensUsedSoFar >= tokenBudget) {
        log.warn(
          { tokenBudget, tokensUsedSoFar, rerunAttempt, gapsRemaining: prosecutor.gaps?.length ?? 0 },
          '[rerun] token budget reached — skipping further rerun attempts'
        );
        emit({ type: 'rerun_exhausted', remaining_gaps: prosecutor.gaps?.length ?? 0 });
        return prosecutor;
      }
    }

    rerunAttempt++;

    const pillarsToRerun   = new Set<string>();
    const implicatedAgents = new Set<string>();
    prosecutor.gaps.forEach((gap: ProsecutorGap) => {
      gap.pillars_involved?.forEach((p: string) => pillarsToRerun.add(p.toLowerCase()));
      gap.agents_involved?.forEach((a: string) => implicatedAgents.add(a.toLowerCase()));
    });

    // Log cumulative token spend so ops can monitor cost trends per attempt.
    const tokensBeforeRerun = Object.values(pillars).reduce(
      (sum, p) => sum + (p.tokens_total ?? 0), 0
    );
    log.info({
      rerunAttempt,
      maxAttempts:        MAX_RERUN_ATTEMPTS,
      gapsRemaining:      prosecutor.gaps?.length ?? 0,
      pillarsToRerun:     [...pillarsToRerun],
      cumulativeTokens:   tokensBeforeRerun,
      tokenBudget:        tokenBudget ?? 'unlimited',
    }, '[rerun] attempt started');

    const rerunDefs = pillarDefs.filter(d => {
      const normalize = (s: string) =>
        s.toLowerCase().replace(/_/g, '').replace(/\s+/g, '');
      const normalizedName = normalize(d.name);
      return Array.from(pillarsToRerun).some(
        entry => normalize(entry) === normalizedName || entry === d.name
      );
    });

    const rerunResults = await Promise.all(
      rerunDefs.map(async ({ name, govSysPrompt, prosSysPrompt, staticGovPrompt, agents, prior }) => {
        const existingOutputs = pillars[name]?.agents;
        const result = await runPillar(
          name, config, govSysPrompt, prosSysPrompt, staticGovPrompt,
          agents, intent, emit, signal, prior, Array.from(implicatedAgents), existingOutputs
        );
        if (signal?.aborted) throw new DOMException('Generation cancelled', 'AbortError');
        await saveCheckpoint(sessionId, `pillar_${name}`, result);
        return result;
      })
    );
    if (signal?.aborted) return prosecutor;
    rerunResults.forEach(p => { if (p) pillars[p.pillar] = p; });

    previousProsecutor = prosecutor;
    prosecutor = await runProsecutor(pillars, config, emit, signal);
    if (signal?.aborted) return prosecutor;
    await saveCheckpoint(sessionId, 'prosecutor', prosecutor);

    // Diff gap IDs to compute how many were actually resolved this round.
    const previousIds  = new Set((previousProsecutor.gaps ?? []).map((g: ProsecutorGap) => g.id));
    const currentIds   = new Set((prosecutor.gaps ?? []).map((g: ProsecutorGap) => g.id));
    const resolvedCount = [...previousIds].filter(id => !currentIds.has(id)).length;
    prosecutor = { ...prosecutor, gaps_resolved: resolvedCount };

    // Tokens consumed during this rerun attempt.
    const tokensAfterRerun = Object.values(pillars).reduce(
      (sum, p) => sum + (p.tokens_total ?? 0), 0
    );
    const tokensThisAttempt = tokensAfterRerun - tokensBeforeRerun;

    log.info({
      rerunAttempt,
      resolvedThisRound:  resolvedCount,
      gapsRemainingAfter: prosecutor.gaps?.length ?? 0,
      converged:          prosecutor.verdict === 'approved',
      tokensThisAttempt,
      cumulativeTokens:   tokensAfterRerun,
    }, '[rerun] attempt complete');

    // Early exit: if no progress in two consecutive attempts, further reruns
    // will not help and would waste token budget unnecessarily.
    if (resolvedCount === 0 && rerunAttempt >= 2) {
      log.warn(
        { rerunAttempt, gapsRemaining: prosecutor.gaps?.length ?? 0 },
        '[rerun] no gaps resolved after 2 attempts — exiting early to avoid wasted cost'
      );
      break;
    }
  }

  log.info({
    totalAttempts: rerunAttempt,
    finalVerdict:  prosecutor.verdict,
    finalGapCount: prosecutor.gaps?.length ?? 0,
  }, '[rerun] loop finished');

  if (prosecutor.verdict === 'requires_revision') {
    log.warn({ remaining_gaps: prosecutor.gaps?.length ?? 0 }, '[rerun] exhausted max attempts without resolving all gaps');
    emit({
      type:           'rerun_exhausted',
      remaining_gaps: prosecutor.gaps?.length ?? 0,
    });
  }

  return prosecutor;
}
