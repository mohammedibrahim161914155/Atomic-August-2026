import { generateJson } from './openrouter';
import { ModelConfig, AgentOutput, PillarProsecutorReport, GovernorIntent, PillarSummary, PillarSummarySchema, PillarBrief } from './types';

export async function runPerPillarSynthesizer(
  pillarName: string,
  intent: GovernorIntent,
  pillarBrief: string | PillarBrief,
  agents: AgentOutput[],
  prosecutorReport: PillarProsecutorReport | undefined,
  config: ModelConfig,
  signal?: AbortSignal
): Promise<{ data: PillarSummary; tokens_used: number }> {
  const systemPrompt = `You are a Per-Pillar Synthesizer. Your job is to take the verbose outputs of multiple agents, along with the prosecutor report, and distill them into a dense, non-redundant, comprehensive master record of this pillar's decisions and findings.

Do not lose any technical details, constraints, schemas, or architectural decisions. Do drop conversational fluff, repetition between agents, and generic filler.
Your output will be used as the single source of truth for this pillar for the rest of the pipeline.`;

  const context = `Pillar: ${pillarName}\n\n` +
    `Intent:\n${JSON.stringify(intent, null, 2)}\n\n` +
    `Brief:\n${JSON.stringify(pillarBrief, null, 2)}\n\n` +
    `Agent Outputs:\n${agents.map(a => `=== ${a.agent} ===\n${a.content}`).join('\n\n')}\n\n` +
    `Prosecutor Report:\n${prosecutorReport ? JSON.stringify(prosecutorReport, null, 2) : 'None'}`;

  const result = await generateJson<PillarSummary>(
    context,
    config,
    PillarSummarySchema,
    systemPrompt,
    { model: config.proModel, max_tokens: 8192, signal }
  );

  return result;
}
