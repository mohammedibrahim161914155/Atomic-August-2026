import { generateJson } from './openrouter';
import { ModelConfig, AgentOutput, GovernorIntent, PillarReviewerReport, PillarReviewerReportSchema, PillarBrief } from './types';

export async function runPerPillarReviewer(
  pillarName: string,
  intent: GovernorIntent,
  pillarBrief: string | PillarBrief,
  agents: AgentOutput[],
  config: ModelConfig,
  signal?: AbortSignal
): Promise<{ data: PillarReviewerReport; tokens_used: number }> {
  const systemPrompt = `You are a Per-Pillar Reviewer. Your role is to provide a constructive quality gate BEFORE the adversarial prosecutor step.
Review the raw agent outputs for the ${pillarName} pillar. 
Provide constructive feedback and identify any critical flaws that would waste the prosecutor's time.
Focus on structurally improving the pillar's cohesive output and ensuring it adheres to the original brief and intent.`;

  const context = `Pillar: ${pillarName}\n\n` +
    `Intent:\n${JSON.stringify(intent, null, 2)}\n\n` +
    `Brief:\n${pillarBrief}\n\n` +
    `Agent Outputs:\n${agents.map(a => `=== ${a.agent} ===\n${a.content}`).join('\n\n')}`;

  const result = await generateJson<PillarReviewerReport>(
    context,
    config,
    PillarReviewerReportSchema,
    systemPrompt,
    { model: config.fastModel, max_tokens: 4096, signal }
  );

  return result;
}
