/**
 * src/engine/costBudget.ts
 *
 * Pre-run cost estimation and budget enforcement (Part 4.2 §4 + Part 8.2 §6).
 *
 * Before starting a pipeline run, this module:
 *   1. Calculates an estimated cost using the model registry's pricing data.
 *   2. Enforces a configurable maxBudgetUsd hard cap.
 *   3. Tracks actual vs. estimated cost in the final run metadata.
 *
 * Cost estimation is conservative (uses worst-case token counts) to prevent
 * budget overruns. Actual cost is calculated from usage data returned by the SDK.
 */

import { MODEL_REGISTRY } from '../models/registry';

export class BudgetExceededError extends Error {
  constructor(
    public readonly estimatedUsd: number,
    public readonly maxBudgetUsd: number,
  ) {
    super(
      `Estimated cost $${estimatedUsd.toFixed(4)} exceeds budget cap $${maxBudgetUsd.toFixed(4)}. ` +
      `Increase MAX_BUDGET_USD or choose a less expensive model.`
    );
    this.name = 'BudgetExceededError';
  }
}

export interface CostEstimate {
  modelId: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalUsd: number;
  breakdown: CostLine[];
}

interface CostLine {
  stage: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

interface RunCostOptions {
  fastModel: string;
  proModel: string;
  mode: 'fast' | 'safe';
  pillarCount: number;       // typically 6 non-planning pillars
  agentsPerPillar: number;   // typically 5
  promptLengthChars: number; // user-supplied prompt character count
}

/** Tokens per character estimate (conservative). */
const CHARS_PER_TOKEN = 3.5;

/** Estimated token budgets by role (conservative, worst-case). */
const TOKEN_BUDGET = {
  GOVERNOR_INPUT:        2_000,
  GOVERNOR_OUTPUT:       1_500,
  PILLAR_GOVERNOR_IN:    3_000,
  PILLAR_GOVERNOR_OUT:   1_000,
  AGENT_INPUT:           8_000,
  AGENT_OUTPUT:          6_000,
  AGENT_STEPS:           3,       // avg tool call steps per agent (adds overhead)
  REVIEWER_INPUT:        6_000,
  REVIEWER_OUTPUT:       2_000,
  PROSECUTOR_IN:         12_000,
  PROSECUTOR_OUT:        4_000,
  SYNTHESIZER_IN:        20_000,
  SYNTHESIZER_OUT:       8_000,
  GLOBAL_PROSECUTOR_IN:  40_000,
  GLOBAL_PROSECUTOR_OUT: 8_000,
} as const;

function getPricing(modelId: string): { inputPer1M: number; outputPer1M: number } {
  const entry = MODEL_REGISTRY.find(m => m.id === modelId);
  if (entry) {
    return { inputPer1M: entry.inputCostPer1M, outputPer1M: entry.outputCostPer1M };
  }
  // Conservative fallback pricing (OpenAI GPT-4 class)
  return { inputPer1M: 5.0, outputPer1M: 15.0 };
}

function tokenCost(inputTokens: number, outputTokens: number, pricing: { inputPer1M: number; outputPer1M: number }): number {
  return (inputTokens / 1_000_000) * pricing.inputPer1M + (outputTokens / 1_000_000) * pricing.outputPer1M;
}

/**
 * Estimate total cost for a pipeline run before it starts.
 *
 * The estimate is deliberately conservative (+20% buffer) to avoid
 * underestimating and blowing a budget cap.
 */
export function estimatePipelineCost(opts: RunCostOptions): CostEstimate {
  const { fastModel, proModel, pillarCount, agentsPerPillar, promptLengthChars } = opts;

  const fastPricing = getPricing(fastModel);
  const proPricing = getPricing(proModel);

  const promptTokens = Math.ceil(promptLengthChars / CHARS_PER_TOKEN);
  const breakdown: CostLine[] = [];

  // Governor (fast model, extended thinking)
  const govIn = TOKEN_BUDGET.GOVERNOR_INPUT + promptTokens;
  const govOut = TOKEN_BUDGET.GOVERNOR_OUTPUT;
  breakdown.push({
    stage: 'Governor',
    inputTokens: govIn,
    outputTokens: govOut,
    usd: tokenCost(govIn, govOut, fastPricing),
  });

  // Per-pillar governor + agents + reviewer + per-pillar prosecutor + synthesizer
  for (let i = 0; i < pillarCount; i++) {
    const pillarLabel = `Pillar ${i + 1}`;

    // Pillar governor (pro model)
    const pgIn = TOKEN_BUDGET.PILLAR_GOVERNOR_IN + govOut;
    const pgOut = TOKEN_BUDGET.PILLAR_GOVERNOR_OUT;
    breakdown.push({ stage: `${pillarLabel} Governor`, inputTokens: pgIn, outputTokens: pgOut, usd: tokenCost(pgIn, pgOut, proPricing) });

    // Agents (pro model, multi-step)
    for (let j = 0; j < agentsPerPillar; j++) {
      const agIn = TOKEN_BUDGET.AGENT_INPUT + pgOut + promptTokens;
      const agOut = TOKEN_BUDGET.AGENT_OUTPUT;
      const steps = TOKEN_BUDGET.AGENT_STEPS;
      // Each step costs approximately: previous_output_tokens re-processed as input
      const agentTotal = tokenCost(agIn * steps, agOut, proPricing);
      breakdown.push({ stage: `${pillarLabel} Agent ${j + 1}`, inputTokens: agIn * steps, outputTokens: agOut, usd: agentTotal });
    }

    // Reviewer (fast model)
    const revIn = TOKEN_BUDGET.REVIEWER_INPUT + TOKEN_BUDGET.AGENT_OUTPUT * agentsPerPillar;
    const revOut = TOKEN_BUDGET.REVIEWER_OUTPUT;
    breakdown.push({ stage: `${pillarLabel} Reviewer`, inputTokens: revIn, outputTokens: revOut, usd: tokenCost(revIn, revOut, fastPricing) });

    // Per-pillar Prosecutor (pro model, extended thinking)
    const ppIn = TOKEN_BUDGET.PROSECUTOR_IN + TOKEN_BUDGET.AGENT_OUTPUT * agentsPerPillar;
    const ppOut = TOKEN_BUDGET.PROSECUTOR_OUT;
    breakdown.push({ stage: `${pillarLabel} Prosecutor`, inputTokens: ppIn, outputTokens: ppOut, usd: tokenCost(ppIn, ppOut, proPricing) });

    // Synthesizer (pro model)
    const synIn = TOKEN_BUDGET.SYNTHESIZER_IN;
    const synOut = TOKEN_BUDGET.SYNTHESIZER_OUT;
    breakdown.push({ stage: `${pillarLabel} Synthesizer`, inputTokens: synIn, outputTokens: synOut, usd: tokenCost(synIn, synOut, proPricing) });
  }

  // Global Prosecutor (pro model, extended thinking)
  const gpIn = TOKEN_BUDGET.GLOBAL_PROSECUTOR_IN;
  const gpOut = TOKEN_BUDGET.GLOBAL_PROSECUTOR_OUT;
  breakdown.push({ stage: 'Global Prosecutor', inputTokens: gpIn, outputTokens: gpOut, usd: tokenCost(gpIn, gpOut, proPricing) });

  // Final Synthesizer
  const fsIn = TOKEN_BUDGET.SYNTHESIZER_IN * 2;
  const fsOut = TOKEN_BUDGET.SYNTHESIZER_OUT;
  breakdown.push({ stage: 'Final Synthesizer', inputTokens: fsIn, outputTokens: fsOut, usd: tokenCost(fsIn, fsOut, proPricing) });

  const rawUsd = breakdown.reduce((s, l) => s + l.usd, 0);
  const estimatedTotalUsd = rawUsd * 1.2; // 20% buffer

  return {
    modelId: proModel,
    estimatedInputTokens: breakdown.reduce((s, l) => s + l.inputTokens, 0),
    estimatedOutputTokens: breakdown.reduce((s, l) => s + l.outputTokens, 0),
    estimatedTotalUsd,
    breakdown,
  };
}

/**
 * Enforce the budget cap. Throws BudgetExceededError if the estimate
 * exceeds the cap. Call this before starting a pipeline run.
 */
export function enforceBudgetCap(estimate: CostEstimate): void {
  const maxBudgetUsd = parseFloat(process.env.MAX_BUDGET_USD ?? '0');
  if (maxBudgetUsd > 0 && estimate.estimatedTotalUsd > maxBudgetUsd) {
    throw new BudgetExceededError(estimate.estimatedTotalUsd, maxBudgetUsd);
  }
}

/**
 * Calculate actual cost from real token usage after a pipeline run.
 */
export function calculateActualCost(
  usage: { totalInputTokens: number; totalOutputTokens: number },
  modelId: string,
): number {
  const pricing = getPricing(modelId);
  return tokenCost(usage.totalInputTokens, usage.totalOutputTokens, pricing);
}
