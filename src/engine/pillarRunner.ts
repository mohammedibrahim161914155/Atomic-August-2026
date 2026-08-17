import { generateJson } from './openrouter';
import { runAgentWithTools } from './agentRunner';
import { withRetry } from './withRetry';
import { PillarName, PillarOutput, AgentOutput, GovernorIntent, EngineEvent, ModelConfig, PillarProsecutorReport, PillarProsecutorReportSchema, PillarBrief, PillarBriefSchema, PillarSummary } from './types';
import { EFFORT_TOKEN_BUDGETS } from './config';
import { runPerPillarSynthesizer } from './perPillarSynthesizer';
import { runPerPillarReviewer } from './perPillarReviewer';
import { log } from './logger';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Agent timeout after ${ms}ms: ${label}`)), ms)
    ),
  ]);
}

export interface AgentDef {
  name: string;
  systemPrompt: string;
}

const COMPLETION_STANDARD = `COMPLETION STANDARD:
- Complete one requirement fully before moving to the next.
- Do not begin the next section until the current one is complete and self-contained.
- Do not reference other agents with phrases like "as noted above" — your output must stand alone.
- A decision without a concrete implementation path is not a decision.
- Zero vague language. Zero placeholders. Zero deferrals.
Produce your complete, exhaustive output now.`;

// Injected into every agent's system prompt to enable agentic coordination.
const AGENT_TOOL_INSTRUCTIONS = `
AGENTIC COORDINATION PROTOCOL:
You have access to shared tools that enable genuine multi-agent coordination across the pipeline.
Use them in this order before writing your main output:

  1. readMemory(scope='all_pillars')  — check what other agents have already decided (tech stack, schemas, protocols)
  2. lookupPattern(domain='...')      — retrieve proven patterns + pitfalls for your primary concern area
  3. [produce your full analysis]
  4. writeDecision(key, decision, rationale) — record every concrete choice you make (call once per key decision)
  5. flagConcern(description, severity, affects_pillars) — flag any cross-cutting risk for the prosecutor

This is not optional ceremony — without readMemory you may contradict decisions already made by peers.
Without writeDecision your choices are invisible to subsequent agents.`;

const PILLAR_GOVERNOR_SYSTEM_PROMPT = `You are the {pillarName} Pillar Governor for the Atomic pipeline.
Your job is to produce a concise, product-specific brief for the {pillarName} pillar.

You have received the GovernorIntent — a structured description of the product being designed.
Produce a brief (300–500 words) that tells the {pillarName} pillar agents:

1. What this specific product requires from the {pillarName} perspective
2. What the highest-priority concerns are for this product type
3. What constraints or non-negotiables apply to this product
4. What "excellent output" looks like for this product specifically

Be specific to the product. Do not write generic engineering advice.
A brief that could apply to any product is a failed brief.`;

async function runPillarGovernor(
  pillarName: string,
  intent: GovernorIntent,
  config: ModelConfig,
  systemPrompt: string
): Promise<PillarBrief> {
  const prompt = `GovernorIntent:\n${JSON.stringify(intent, null, 2)}\n\nProduce the ${pillarName} pillar brief now.`;
  
  const { data } = await withRetry(
    () => generateJson<PillarBrief>(
      prompt, config, PillarBriefSchema,
      systemPrompt.replace(/\{pillarName\}/g, pillarName),
      { model: config.proModel, max_tokens: 4096 },
    ),
    undefined,
    `governor:${pillarName}`,
  );
  return data;
}

export async function runPillar(
  pillarName: PillarName,
  config: ModelConfig,
  governorSystemPrompt: string,
  prosecutorSystemPrompt: string,
  staticGovPrompt: string,
  agents: AgentDef[],
  intent: GovernorIntent,
  emit: (event: EngineEvent) => void,
  signal?: AbortSignal,
  priorContext?: string,
  implicatedAgents?: string[],
  existingOutputs?: AgentOutput[]
): Promise<PillarOutput> {
  emit({ type: 'pillar_start', pillar: pillarName, agents: agents.map(a => a.name) });
  
  let pillarBrief: string | PillarBrief = staticGovPrompt;
  try {
    pillarBrief = await runPillarGovernor(pillarName, intent, config, governorSystemPrompt || PILLAR_GOVERNOR_SYSTEM_PROMPT);
  } catch (err) {
    log.warn({ err }, `[governor] failed for pillar ${pillarName}, using static fallback:`);
  }

  const briefStr = typeof pillarBrief === 'string' ? pillarBrief : JSON.stringify(pillarBrief, null, 2);
  
  let context = `Intent:\n${JSON.stringify(intent, null, 2)}\n\n`;
  if (priorContext) {
    context += `Architecture context from Planning pillar (use this to inform your output):\n${priorContext}\n\n`;
  }

  const agentPromises = agents.map(async (agent) => {
    // If we only need to re-run specific agents, check if this one is implicated
    if (implicatedAgents && existingOutputs && !implicatedAgents.includes(agent.name.toLowerCase())) {
      const existing = existingOutputs.find(o => o.agent === agent.name);
      if (existing) {
        emit({ type: 'agent_start', pillar: pillarName, agent: agent.name });
        emit({ type: 'agent_done', pillar: pillarName, agent: agent.name, preview: '[reused previous output]' });
        return existing;
      }
    }

    emit({ type: 'agent_start', pillar: pillarName, agent: agent.name });

    // Each agent only receives the Intent and the Prior Context (if any),
    // NOT the raw outputs of all preceding agents in the same pillar.
    const userPrompt =
      `${context}\n` +
      `---\n` +
      `Execute your role now.\n` +
      `${COMPLETION_STANDARD}`;

    // Append the agentic coordination protocol to the agent's system prompt
    // so it knows how and when to use its tools.
    const systemPrompt = `${briefStr}\n\n${agent.systemPrompt}${AGENT_TOOL_INSTRUCTIONS}`;

    try {
      const { content, tokens_used } = await withTimeout(
        runAgentWithTools(
          agent.name,
          pillarName,
          systemPrompt,
          userPrompt,
          config,
          signal,
          (chunk) => emit({ type: 'agent_chunk', pillar: pillarName, agent: agent.name, chunk }),
          emit,
        ),
        5 * 60 * 1000, // 5 minutes — tool loops need more time than a single call
        agent.name,
      );

      const preview = content.substring(0, 100).replace(/\n/g, ' ') + '...';
      emit({ type: 'agent_done', pillar: pillarName, agent: agent.name, preview });

      return { agent: agent.name, content, tokens_used };
    } catch (err: any) {
      log.error({ err }, `Agent ${agent.name} failed:`);
      emit({ type: 'agent_done', pillar: pillarName, agent: agent.name, preview: '[AGENT FAILED — skipped]' });
      return {
        agent: agent.name,
        content: `[AGENT OUTPUT UNAVAILABLE]`,
        tokens_used: 0,
        status: 'failed' as const,
      };
    }
  });

  const agentOutputs = await Promise.all(agentPromises);
  const failedAgents = agentOutputs.filter(o => o.status === 'failed').map(o => o.agent);

  if (failedAgents.length > 0) {
    emit({ type: 'pillar_degraded', pillar: pillarName, failed: failedAgents });
  }

  // ── Content poisoning detection ───────────────────────────────────────────
  // Flag outputs containing obvious prompt-injection patterns before passing
  // them downstream to the Prosecutor and Synthesizer.
  const INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?previous\s+instructions?/i,
    /disregard\s+(all\s+)?prior\s+(instructions?|context)/i,
    /you\s+are\s+now\s+(a\s+)?different/i,
    /act\s+as\s+(a\s+)?(different|new|another)\s+(ai|assistant|model|system)/i,
    /system\s*:\s*override/i,
    /<\s*\/?\s*(system|instructions?)\s*>/i,
    /\[SYSTEM\]\s*override/i,
    /\[\[SYSTEM\]\]/i,
  ];

  for (const output of agentOutputs) {
    if (output.status === 'failed') continue;
    const flagged = INJECTION_PATTERNS.some(p => p.test(output.content));
    if (flagged) {
      log.warn(
        { agent: output.agent, pillar: pillarName },
        '[security] content poisoning pattern detected in agent output — truncating'
      );
      // Truncate the output to prevent downstream injection; preserve structure
      output.content =
        `[CONTENT FILTERED — potential prompt injection detected by Atomic security layer]\n\n` +
        output.content.slice(0, 500);
    }
  }

  // ==== 3 & 4. Per-Pillar Reviewer + Prosecutor — run in PARALLEL ====
  // Reviewer (constructive quality gate) and Prosecutor (adversarial gap detection)
  // are fully independent of each other and both operate only on agentOutputs.
  // Running them in parallel cuts per-pillar overhead roughly in half.
  const pillarLabel = pillarName.charAt(0).toUpperCase() + pillarName.slice(1).replace('_', ' ');
  const prosecutorPrompt =
    `${pillarLabel} Brief (from Governor):\n${briefStr}\n\nAgent Outputs:\n` +
    agentOutputs.map(a => `=== ${a.agent} ===\n${a.content}`).join('\n\n') +
    `\n\nProsecute now. Find every gap.`;

  const [reviewerResult, prosecutorResult] = await Promise.allSettled([
    withRetry(
      () => runPerPillarReviewer(pillarName, intent, pillarBrief, agentOutputs, config, signal),
      signal,
      `reviewer:${pillarName}`,
    ),
    withRetry(
      () => generateJson<PillarProsecutorReport>(
        prosecutorPrompt, config, PillarProsecutorReportSchema, prosecutorSystemPrompt,
        { model: config.proModel, max_tokens: EFFORT_TOKEN_BUDGETS[config.effort ?? 'medium'], extended_thinking: config.thinkingEnabled ?? true, signal },
      ),
      signal,
      `per-pillar-prosecutor:${pillarName}`,
    ),
  ]);

  let tokensReviewer = 0;
  let reviewerReport;
  if (reviewerResult.status === 'fulfilled') {
    reviewerReport = reviewerResult.value.data;
    tokensReviewer = reviewerResult.value.tokens_used;
  } else {
    log.warn({ err: reviewerResult.reason }, `[reviewer] failed for pillar ${pillarName}:`);
  }

  let tokensProsecutor = 0;
  let issuesCount = 0;
  let prosecutorReport: PillarProsecutorReport | undefined = undefined;
  if (prosecutorResult.status === 'fulfilled') {
    tokensProsecutor = prosecutorResult.value.tokens_used;
    prosecutorReport = prosecutorResult.value.data;
    issuesCount = prosecutorReport.issues?.length || 0;
  } else {
    log.warn({ err: prosecutorResult.reason }, `[prosecutor] failed for pillar ${pillarName}:`);
    issuesCount = 0;
  }

  emit({ type: 'pillar_prosecuted', pillar: pillarName });

  let tokensSynthesizer = 0;
  let synthesizerSummary: PillarSummary | undefined = undefined;
  try {
    const result = await withRetry(
      () => runPerPillarSynthesizer(
        pillarName, intent, pillarBrief, agentOutputs, prosecutorReport, config, signal,
      ),
      signal,
      `synthesizer:${pillarName}`,
    );
    synthesizerSummary = result.data;
    tokensSynthesizer = result.tokens_used;
  } catch (err) {
    log.warn({ err }, `[synthesizer] failed for pillar ${pillarName}:`);
  }

  const agentTokens = agentOutputs.reduce((s, a) => s + a.tokens_used, 0);

  const fallbackSummary: PillarSummary = {
    decisions: [],
    schemas: [],
    technical_constraints: [],
    master_record_md: prosecutorReport ? JSON.stringify(prosecutorReport, null, 2) : agentOutputs.map(a => `=== ${a.agent} ===\n${a.content.substring(0, 5000)}`).join('\n\n')
  };

  return {
    pillar: pillarName,
    agents: agentOutputs,
    failed_agents: failedAgents,
    reviewer_report: reviewerReport,
    reverifier_issues: issuesCount,
    prosecutor_report: prosecutorReport,
    synthesizer_output: synthesizerSummary?.master_record_md,
    summary: synthesizerSummary ?? fallbackSummary,
    tokens_reviewer: tokensReviewer,
    tokens_prosecutor: tokensProsecutor,
    tokens_synthesizer: tokensSynthesizer,
    tokens_total: agentTokens + tokensReviewer + tokensProsecutor + tokensSynthesizer
  };
}
