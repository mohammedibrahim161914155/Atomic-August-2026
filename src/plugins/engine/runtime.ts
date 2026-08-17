/**
 * src/plugins/engine/runtime.ts
 *
 * Plugin pipeline runtime. Executes a plugin's declared stages through the
 * shared agentic core — the same verdict-engine discipline every Atomic
 * pipeline already runs on.
 *
 *   - Each stage is one `generateText` call with the stage prompt plus an
 *     accumulated context (previous stage outputs + plugin inputs).
 *   - Stages with `repeat: true` enter a verifier-lite loop: the stage's
 *     `until` expression is evaluated against a role-weighted composite
 *     quality score after each attempt, up to max_iterations.
 *   - Every capability the plugin touches (blueprint:read/write, api:call,
 *     events) is decided through the trust store per session.
 *   - Non-fatal: a failing stage marks the run `degraded` and ships what
 *     was produced; a `prompt:inject`-only restricted plugin can still run
 *     — it just never receives data access.
 */
import type { EnginePluginManifest } from './schema';
import { decideCapability } from './trust';
import { generateText, generateJson } from '../../engine/openrouter';
import type { ModelConfig } from '../../engine/config';
import { resolvePipelineDefaults } from '../../engine/agenticCore';
import type { RoleScore } from '../../engine/agenticCore';
import { roleScore, computeComposite } from '../../engine/agenticCore';
import { log as logger } from '../../engine/logger';
import { z } from 'zod';

export interface PluginRunOptions {
  sessionId: string;
  manifest: EnginePluginManifest;
  config: ModelConfig;
  /** Resolved user answers for the manifest's input forms. */
  inputs: Record<string, unknown>;
  /** Optional accumulated blueprint text for blueprint:read stages. */
  blueprintText?: string;
  emit?: (event: { type: string; [k: string]: unknown }) => void;
  signal?: AbortSignal;
  label?: string;
}

export interface PluginStageResult {
  stageId: string;
  kind: string;
  attempts: number;
  score?: number;
  output: string;
  tokens_used: number;
  stoppedBy: 'until' | 'max_iterations' | 'error';
  verdict: 'pass' | 'fail';
}

export interface PluginRunOutcome {
  status: 'ok' | 'degraded';
  stages: PluginStageResult[];
  tokens_used: number;
  errors: string[];
}

/**
 * Evaluate an OpenDesign-style `until` expression against a stage attempt.
 * Supported forms: "composite>=N", "composite>N", "iterations>=N",
 * "score>=N", and "x || y" combinations. Anything else is rejected
 * (the grammar is deliberately small and deterministic — no eval).
 */
export function evaluateUntil(until: string, score: number | undefined, iteration: number): boolean {
  const normalized = until.replace(/\s+/g, '');
  const parts = normalized.split('||').map((s) => s.trim());
  return parts.every((part) => {
    const m = part.match(/^(composite|score|iterations)(>=|>)(\d+(?:\.\d+)?)$/);
    if (!m) return false;
    const [, name, op, raw] = m;
    if (!name || !op || !raw) return false;
    const threshold = parseFloat(raw);
    const value = name === 'iterations' ? iteration : (score ?? 0);
    return op === '>=' ? value >= threshold : value > threshold;
  });
}

/** Invalid until expression — doctor validation rejects these at install. */
export function isValidUntil(until: string): boolean {
  const normalized = until.replace(/\s+/g, '');
  return normalized
    .split('||')
    .map((s) => s.trim())
    .every((part) => /^(composite|score|iterations)(>=|>)(\d+(?:\.\d+)?)$/.test(part));
}

const ROLE_WEIGHTS: Record<string, number> = {
  accuracy: 0.35,
  completeness: 0.25,
  actionability: 0.25,
  clarity: 0.15,
};

/**
 * Composite quality threshold for a stage pass. Mirrors the verdict engine's
 * pass semantics: the shared role panel scores 0–100 and the stage passes
 * when the composite reaches the pipeline's passScore.
 */
export function stagePassScore(): number {
  return resolvePipelineDefaults('blueprint').verdict.scoreThreshold ?? 80;
}

const REVIEW_SCORE_SCHEMA = z.object({
  accuracy: z.number().min(0).max(100),
  completeness: z.number().min(0).max(100),
  actionability: z.number().min(0).max(100),
  clarity: z.number().min(0).max(100),
});

/**
 * Rate arbitrary content against the shared 4-role quality panel
 * (accuracy / completeness / actionability / clarity) — the same panel the
 * blueprint verifier-repair loop uses. Scoring is a checkpoint, so it runs
 * on the fast model with a small token budget.
 */
async function reviewContent(
  output: string,
  _label: string,
  config: ModelConfig,
): Promise<Array<{ role: string; score: number }>> {
  const prompt = `Rate this content 0–100 on each dimension. Be strict but fair. Only respond with JSON.\n\n${output.slice(0, 8000)}`;
  const { data } = await generateJson(
    prompt,
    config,
    REVIEW_SCORE_SCHEMA,
    'You are the shared 4-role quality panel (Accuracy, Completeness, Actionability, Clarity). Respond with four 0-100 scores as JSON.',
    { model: config.fastModel, max_tokens: 512 },
  );
  return [
    { role: 'accuracy', score: data.accuracy },
    { role: 'completeness', score: data.completeness },
    { role: 'actionability', score: data.actionability },
    { role: 'clarity', score: data.clarity },
  ];
}

/** Score a stage output with the role-weighted composite (OpenDesign
 *  critique-theater analogue, backed by the engine's role scorer). */
async function scoreStage(
  output: string,
  label: string,
  config: ModelConfig,
): Promise<{ scores: RoleScore[]; composite: number }> {
  try {
    const review = await reviewContent(output, label, config);
    const scores = review.map((r) => roleScore(r.role, r.score, ROLE_WEIGHTS[r.role] ?? 0.2));
    return { scores, composite: computeComposite(scores) };
  } catch (err) {
    // Scoring failure must not fail the run — treat as a mid score and
    // keep the pipeline moving.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, '[plugin] stage score failed');
    return { scores: [], composite: 50 };
  }
}

export async function runPluginPipeline(opts: PluginRunOptions): Promise<PluginRunOutcome> {
  const { manifest, config, inputs, emit, signal } = opts;
  const stages = manifest.pipeline?.stages ?? [];
  const results: PluginStageResult[] = [];
  const errors: string[] = [];
  let accumulated = '';
  let totalTokens = 0;
  const passScore = stagePassScore();

  emit?.({ type: 'plugin.run.start', plugin_id: manifest.id, stages: stages.length });

  for (const stage of stages) {
    // Capability gate: a stage that reads/writes the blueprint or calls APIs
    // is denied when the session has not granted the capability.
    const dataRead = stage.kind === 'review' || stage.kind === 'transform' || stage.kind === 'report';
    const canRead = dataRead
      ? await decideCapability(opts.sessionId, manifest.id, 'blueprint:read', manifest)
      : true;
    const canWrite = stage.kind === 'transform'
      ? await decideCapability(opts.sessionId, manifest.id, 'blueprint:write', manifest)
      : true;
    const canCallApi = manifest.kind === 'exporter'
      ? await decideCapability(opts.sessionId, manifest.id, 'api:call', manifest)
      : true;

    if (dataRead && !canRead) {
      errors.push(`stage ${stage.id}: blueprint:read not granted — stage skipped`);
      continue;
    }
    if (stage.kind === 'transform' && !canWrite) {
      errors.push(`stage ${stage.id}: blueprint:write not granted — stage skipped`);
      continue;
    }
    if (manifest.kind === 'exporter' && !canCallApi && stage.kind === 'export') {
      errors.push(`stage ${stage.id}: api:call not granted — stage skipped`);
      continue;
    }

    const inputContext = (manifest.inputs ?? [])
      .map((inp) => `[input:${inp.name}]=${inputs[inp.name] ?? (inp.type === 'string' ? '""' : inp.default ?? '')}`)
      .join('\n');
    const stagePrompt =
      `--- PLUGIN INPUTS ---\n${inputContext}\n` +
      `${stage.kind === 'review' && opts.blueprintText ? `\n--- BLUEPRINT ---\n${opts.blueprintText.slice(0, 60_000)}\n` : ''}` +
      `${accumulated ? `\n--- PRIOR STAGE OUTPUTS ---\n${accumulated.slice(0, 60_000)}\n` : ''}\n` +
      `--- STAGE INSTRUCTION (${stage.id}) ---\n${stage.prompt}`;

    emit?.({ type: 'plugin.stage.start', plugin_id: manifest.id, stage_id: stage.id });

    let output = '';
    let tokens = 0;
    let score: number | undefined;
    let attempts = 0;
    let stoppedBy: PluginStageResult['stoppedBy'] = 'max_iterations';
    let stageVerdict: PluginStageResult['verdict'] = 'fail';

    do {
      attempts += 1;
      emit?.({ type: 'plugin.stage.attempt', plugin_id: manifest.id, stage_id: stage.id, attempt: attempts });
      try {
        const result = await generateText(
          stagePrompt,
          config,
          `You are the '${stage.id}' stage (kind: ${stage.kind}) of the '${manifest.name}' Atomic plugin. Follow the stage instruction precisely.`,
          { model: config.proModel, max_tokens: stage.max_tokens, signal },
        );
        output = result.text;
        tokens += result.tokens_used;

        if (stage.repeat && stage.until) {
          const { composite } = await scoreStage(output, `${manifest.id}:${stage.id}`, config);
          score = composite;
          emit?.({
            type: 'plugin.stage.score',
            plugin_id: manifest.id,
            stage_id: stage.id,
            attempt: attempts,
            score,
          });
          if (evaluateUntil(stage.until, composite, attempts)) {
            stoppedBy = 'until';
            break;
          }
        } else {
          stoppedBy = 'max_iterations';
          break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith('AbortError')) {
          emit?.({ type: 'plugin.run.aborted', plugin_id: manifest.id });
          return {
            status: 'degraded',
            stages: results,
            tokens_used: totalTokens,
            errors: [...errors, `stage ${stage.id}: run aborted`],
          };
        }
        errors.push(`stage ${stage.id} attempt ${attempts}: ${message}`);
        logger.warn({ stageId: stage.id, attempt: attempts, err: message }, '[plugin] stage attempt failed');
        if (attempts >= stage.max_iterations) {
          stoppedBy = 'error';
          break;
        }
      }
    } while (attempts < stage.max_iterations);

    stageVerdict = score !== undefined ? (score >= passScore ? 'pass' : 'fail') : output ? 'pass' : 'fail';

    results.push({ stageId: stage.id, kind: stage.kind, attempts, score, output, tokens_used: tokens, stoppedBy, verdict: stageVerdict });
    totalTokens += tokens;
    if (stageVerdict === 'pass' && output) {
      accumulated += `\n\n--- ${stage.id} (${stage.kind}) ---\n${output}`;
    }
    emit?.({ type: 'plugin.stage.done', plugin_id: manifest.id, stage_id: stage.id, verdict: stageVerdict, attempts, score });
  }

  const status = errors.length === 0 ? 'ok' : 'degraded';
  emit?.({ type: 'plugin.run.done', plugin_id: manifest.id, status, stages: results.length, tokens_used: totalTokens });
  return { status, stages: results, tokens_used: totalTokens, errors };
}
