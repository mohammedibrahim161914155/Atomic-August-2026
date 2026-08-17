import { generateJson } from './openrouter';
import { ProsecutorResult, ProsecutorResultSchema, EngineEvent, ModelConfig, PILLAR_COUNT, PillarOutputMap } from './types';
import { log } from './logger';


function summarisePillars(pillars: PillarOutputMap): string {
  const degraded = Object.entries(pillars)
    .filter(([, p]) => p.failed_agents?.length)
    .map(([n, p]) => `${n}: [${p.failed_agents.join(', ')}] FAILED`);
  const preamble = degraded.length
    ? `WARNING: The following agents failed and their output is missing:\n`
      + degraded.join('\n') + '\n\nAccount for these gaps in your analysis.\n'
    : '';

  const PILLAR_CHAR_LIMIT = 20_000;

  const summary = Object.entries(pillars).map(([name, pillar]) => {
    const header = `${'='.repeat(60)}\nPILLAR: ${name.toUpperCase()}\n${'='.repeat(60)}\n`;
    let content = "";
    
    if (pillar.synthesizer_output) {
      content = pillar.synthesizer_output;
    } else if (pillar.prosecutor_report) {
      content = JSON.stringify(pillar.prosecutor_report, null, 2);
    } else {
      content = pillar.agents.map(a => ` [${a.agent}]\n${a.content}`).join('\n');
    }

    if (content.length > PILLAR_CHAR_LIMIT) {
      log.warn(
        { pillar: name, originalChars: content.length, limitChars: PILLAR_CHAR_LIMIT },
        '[prosecutor] pillar content truncated — prosecutor may miss contradictions in cut portion'
      );
      content = content.slice(0, PILLAR_CHAR_LIMIT) + '\n... [truncated for context safety]';
    }

    return header + content;
  }).join('\n');

  return preamble + summary;
}

export async function runProsecutor(pillars: PillarOutputMap, config: ModelConfig, emit: (event: EngineEvent) => void, signal?: AbortSignal): Promise<ProsecutorResult> {
  if (signal?.aborted) {
    throw new Error('AbortError: generation cancelled');
  }
  emit({ type: 'prosecutor_start' });

  const systemPrompt = `Think very hard before identifying gaps. Shallow analysis produces false gaps. Deep analysis produces real ones. Only the real ones matter.\n\nYou are the Supreme Prosecutor. You have received the complete outputs of all ${PILLAR_COUNT} specialist pillars of the Hail Mary blueprint system. Your job is to find every gap, contradiction, and oversight that exists BETWEEN pillars — things that no individual pillar caught because they were each focused on their domain.

Specifically hunt for:
1. A decision in Pillar A that contradicts a decision in Pillar B
2. A requirement stated in one pillar that is not addressed by any other pillar
3. Security requirements that are not reflected in the architecture
4. Scalability requirements that the data model cannot support
5. Features declared in Completeness that are not designed in Planning
6. Edge cases in EdgeCases that have no corresponding error handling in Integration
7. Compliance requirements in Security that are not reflected in Documentation

If verdict is "requires_revision", the resolution field for each gap must contain the complete corrected content, not instructions to revise. Be extremely specific in 'agents_involved' if you know exactly which agent needs to fix it.`;

  const context = `Pillar Outputs:\n${summarisePillars(pillars)}`;
  
  const { data: result, tokens_used } = await generateJson<ProsecutorResult>(
    context, 
    config,
    ProsecutorResultSchema, 
    systemPrompt,
    { model: config.proModel, max_tokens: 8192, extended_thinking: true, signal }
  );
  
  const gaps = result.gaps || [];
  
  emit({ 
    type: 'prosecutor_done', 
    gaps_found: gaps.length, 
    gaps: gaps.map((g: any) => g.description) 
  });

  // FIX(1.1): gaps are not resolved at prosecution time — only the rerun loop resolves them
  return {
    gaps_found: gaps.length,
    gaps_resolved: 0, // ← was: gaps.length (wrong)
    verdict: result.verdict === 'requires_revision' ? 'requires_revision' : 'approved',
    gaps,
    tokens_used
  };
}
