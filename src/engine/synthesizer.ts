import { randomUUID } from 'crypto';
import { generateJson } from './openrouter';
import { createPromptParts, addLayer, getPromptParts } from './promptParts';
import { loadLedger, renderAuditBlock, type RunAuditLedger } from './runAuditLedger';
import { Blueprint, BlueprintSections, BlueprintSectionsSchema, ProsecutorResult, GovernorIntent, EngineEvent, ModelConfig, PILLAR_COUNT, PillarOutputMap } from './types';
import { EFFORT_TOKEN_BUDGETS } from './config';
import { PROVIDERS } from '../lib/providers';
import { generateOutputBundle } from './bundleGenerator';
import { scoreBlueprint } from './qualityScorer';

function getCostPerMillion(provider: string, modelId: string): number {
  const p = PROVIDERS.find(p => p.slug === provider);
  const m = p?.models.find(m => m.id === modelId);
  return m?.costPer1M ?? 3.0; // fallback to $3/M if unknown
}

export async function runSynthesizer(
  prompt: string,
  config: ModelConfig,
  intent: GovernorIntent,
  pillars: PillarOutputMap,
  prosecutor: ProsecutorResult,
  emit: (event: EngineEvent) => void,
  signal?: AbortSignal,
  sessionId?: string,
): Promise<Blueprint> {
  emit({ type: 'synthesizer_start' });

  const systemPrompt = `Ultrathink before writing each section. This blueprint will be consumed by an AI coding agent as its sole source of truth. Every ambiguity you leave becomes a wrong implementation.\n\nYou are the Hail Mary Synthesizer. You have received the complete, verified outputs of all ${PILLAR_COUNT} pillars and the Supreme Prosecutor's approval. Your job is to assemble the final master blueprint.

Output a single JSON object that matches the requested schema exactly. 
Every field must be populated. No field may contain placeholder text. 
No field may reference "see above" or "as defined in pillar X". 
Every section must be self-contained and complete.

The blueprint must be machine-readable by a coding agent with zero ambiguity.
A skilled engineer who has never seen the original prompt must be able to implement the complete system from this blueprint alone.`;

  const PILLAR_CHAR_LIMIT = 20_000;
  const pillarSummaries = Object.entries(pillars).map(([name, p]) => {
    let content = p.synthesizer_output ? p.synthesizer_output : JSON.stringify(p.prosecutor_report || p.summary, null, 2);
    if (content.length > PILLAR_CHAR_LIMIT) {
      content = content.slice(0, PILLAR_CHAR_LIMIT) + '\n... [truncated for context safety]';
    }
    return `## ${name}\n${content}`;
  }).join('\n\n');

  // v2.6.0 — deterministic prompt-layer ordering (Codex cache lesson): the
  // system prompt and context are assembled through the prompt-parts builder
  // so every repair/synthesis prompt has a stable layer sequence, which
  // maximises provider-level prompt caching and avoids quadratic drift
  // across verifier rounds.
  const parts = createPromptParts();
  addLayer(parts, 'system', systemPrompt);
  addLayer(parts, 'context', `Intent:\n${JSON.stringify(intent, null, 2)}\n\nPillars:\n${pillarSummaries}\n\nProsecutor:\n${JSON.stringify(prosecutor, null, 2)}`);
  if (sessionId) {
    try {
      const ledger: RunAuditLedger | null = await loadLedger(sessionId);
      if (ledger) addLayer(parts, 'audit_ledger', renderAuditBlock(ledger));
    } catch {
      // Ledger unavailable — synthesis proceeds without the audit block.
    }
  }
  const context = getPromptParts(parts);

  const { data: sections, tokens_used: synthTokens } = await generateJson<BlueprintSections>(
    context,
    config,
    BlueprintSectionsSchema,
    systemPrompt,
    { model: config.proModel, max_tokens: EFFORT_TOKEN_BUDGETS[config.effort ?? 'medium'], extended_thinking: config.thinkingEnabled ?? true, signal }
  );

  if (signal?.aborted) throw new DOMException('Generation cancelled', 'AbortError');
  
  emit({ type: 'bundle_start' });
  let bundle: Awaited<ReturnType<typeof generateOutputBundle>> | undefined;
  try {
    bundle = await generateOutputBundle(intent, pillars, config, signal);
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    // Non-fatal: log and continue — blueprint is still valid without the bundle
    console.warn('[synthesizer] bundle generation failed — blueprint will have no bundle:', err?.message);
  }
  emit({ type: 'bundle_done' });

  emit({ type: 'synthesizer_done' });

  const { score: quality_score, breakdown: quality_breakdown_result } = scoreBlueprint(sections, pillars, prosecutor);

  // We now have exact token tracking for all pillar parts.
  const pillarTokenTotal = Object.values(pillars).reduce((sum, p) => sum + (p.tokens_total || 0), 0);
  const APPROX_COST_PER_MILLION = getCostPerMillion(config.provider, config.proModel);
  const estimatedCostUsd = parseFloat(
    ((pillarTokenTotal + synthTokens + (prosecutor.tokens_used || 0)) / 1_000_000 * APPROX_COST_PER_MILLION).toFixed(4)
  );

  const p = PROVIDERS.find(p => p.slug === config.provider);
  const m = p?.models.find(m => m.id === config.proModel);
  const costIsApproximate = !m; // true if model not in static providers list

  const blueprint: Blueprint = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    prompt,
    intent,
    pillars,
    prosecutor,
    quality_score,
    quality_breakdown: quality_breakdown_result,
    total_tokens: pillarTokenTotal + synthTokens + (prosecutor.tokens_used || 0), // Assumes prosecutor has tokens_used attached
    estimated_cost_usd: estimatedCostUsd,
    estimated_cost_approximate: costIsApproximate,
    generation_time_ms: 0,
    bundle,
    sections
  };

  return blueprint;
}
