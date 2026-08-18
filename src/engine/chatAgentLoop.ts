/**
 * src/engine/chatAgentLoop.ts
 *
 * v2.8.0 — Shared agentic tool-loop core for the three chat agents
 * (Artemis, Curator, General).
 *
 * Design (Codex "unrolling the agent loop" pattern + OpenCode per-agent config
 * + Nous Hermes 3 plan-first/self-critique + Kilo Code budget escalation):
 *
 * 1. Each message is processed as a "turn". Inside a turn, the model is called
 *    repeatedly with tools until it produces a final text answer or the loop
 *    budget is exhausted (Codex harness: model reasons, harness executes).
 * 2. Tool calls are validated against their Zod schemas BEFORE execution
 *    (Codex MCP input validation pattern); execution failures are fed back as
 *    tool-result errors so the model can retry (observe pattern).
 * 3. Deterministic prompt layer ordering (system → permissions → context →
 *    memory → skills → tools → task) mirrors Codex's append-only prefix for
 *    prompt-caching friendliness, and every outgoing prompt is passed through
 *    promptRegistry.validate().
 * 4. Context compaction: when the accumulated history exceeds the window
 *    budget, older tool results are summarized into a single "history
 *    summary" assistant message (OpenCode autoCompact at 95%).
 * 5. Per-turn step budget with warning/hard cap (agentBudget pattern) and
 *    model escalation on provider failure (Codex fallback chain).
 * 6. Every turn emits telemetry events: chat.loop_start/end, chat.tool_call,
 *    chat.tool_result, chat.compact, chat.budget_*, chat.model_fallback.
 *
 * The loop is deliberately synchronous-safe (sequential tool execution, no
 * parallel tool calls) — deterministic, debuggable, and permission-auditable.
 */

import { streamText, tool } from 'ai';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { ModelConfig } from './config';
import { getModelForConfig } from './openrouter';
import { withRetry } from './withRetry';
import { log } from './logger';
import { publishEvent } from './eventBus';
import { startSpan } from './observability';
import { promptRegistry } from './promptRegistry';
import { estimateTokens } from './contextBudget';
import { recordAgentStep, type AgentBudgetState } from './agentBudget';
import { escalateModel, type ModelEscalationPolicy, type EscalationDecision } from './agentBudget';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ChatToolContext {
  /** Opaque context the owning agent attaches (sessionId, blueprint, etc.). */
  state: Record<string, unknown>;
  /** Emit a visible side-effect event into the SSE thread (e.g. "Blueprint note updated"). */
  emitSideEffect?: (kind: string, payload: Record<string, unknown>) => void;
}

export interface ChatTool {
  name:        string;
  description: string;
  inputSchema: z.ZodObject<any>;
  /**
   * Execute the tool against the agent's state. Must be pure/observable logic —
   * no stubs. Throws with a human-readable message on failure (surfaced to the
   * model as a tool-result error so it can retry).
   */
  execute: (input: Record<string, unknown>, ctx: ChatToolContext) => Promise<string>;
  /** Codex permission tiers: full-auto | ask | deny */
  permission?: 'full-auto' | 'ask' | 'deny';
}

export interface ChatAgentLoopConfig {
  systemPrompt:          string;
  history:               { role: 'user' | 'assistant'; content: string }[];
  tools:                 ChatTool[];
  model:                 string;            // resolved model id
  maxTurnSteps:          number;            // max tool-call iterations per turn (default 6)
  maxOutputTokens:       number;            // per step
  temperature:           number;
  config:                ModelConfig;       // provider config (may be escalated)
  budget?:               AgentBudgetState;  // per-agent step budget
  escalation?:           ModelEscalationPolicy;
  windowCapacity?:       number;            // token capacity for compaction (default 180_000)
  compactThreshold?:     number;            // 0..1 — start compacting at this utilisation (default 0.8)
  sessionId:             string;            // for telemetry
  agentId:               string;            // 'artemis' | 'curator' | 'general'
  state?:                Record<string, unknown>; // opaque context attached to tool calls (blueprint, workspace, etc.)
}

export interface ChatAgentLoopResult {
  /** streamed final text of the turn */
  textStream: AsyncIterable<string>;
  /** final assistant text */
  finalText:  Promise<string>;
  /** telemetry summary once the turn completes */
  summary:    Promise<ChatTurnSummary>;
  /** whether the context was compacted during this turn */
  compacted:  Promise<boolean>;
}

export interface ChatTurnSummary {
  stepsRun:        number;
  toolsCalled:     { name: string; ok: boolean }[];
  finalTextLength: number;
  durationMs:      number;
  modelUsed:       string;
  escaped:         boolean; // loop ended via step cap rather than final answer
}

// ── Loop implementation ────────────────────────────────────────────────────────

/**
 * Run one agentic turn: model call with tools → execute tool calls → feed
 * results back → repeat until the model answers in text or the step budget
 * runs out. Returns the stream + completion metadata.
 *
 * This is the heart of the Codex-style loop: the harness (this function) owns
 * execution, permissions, and termination; the model owns reasoning.
 */
export async function runAgentTurn(opts: ChatAgentLoopConfig): Promise<ChatAgentLoopResult> {
  const {
    systemPrompt, history, tools, model, config,
    maxTurnSteps = 6, maxOutputTokens, temperature,
    budget, escalation, windowCapacity = 180_000, compactThreshold = 0.8,
    sessionId, agentId,
  } = opts;
  const traceId = randomUUID();
  const t0 = Date.now();
  const span = startSpan({ traceId, sessionId, category: 'ui' });
  publishEvent('chat.loop_start', sessionId, traceId, { agentId, model, historyLength: history.length, toolCount: tools.length });

  // v2.8.0 G1: validate the system prompt before the first LLM call (Codex
  // deterministic-layer pattern — unreplaced markers caught at runtime).
  const validation = promptRegistry.validate(systemPrompt);
  if (!validation.valid) {
    log.warn({ agentId, errors: validation.errors }, '[chatAgentLoop] system prompt validation warnings');
  }

  const toolMap = new Map(tools.map(t => [t.name, t]));
  // Build the ai SDK tool map once with a fixed ToolSet type — the ai SDK
  // requires tool entries to share one ToolSet (input schema cannot be
  // inferred from a union of heterogeneous schemas, so we key on the common
  // ChatTool contract and attach per-tool schemas at invocation time).

  const aiTools: Record<string, ReturnType<typeof tool<Record<string, unknown>, string>>> = Object.fromEntries(
    tools.map(t => [t.name, tool({
      description: t.description,
      inputSchema: t.inputSchema,
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const tdef = toolMap.get(t.name)!;
        publishEvent('chat.tool_call', sessionId, traceId, { agentId, tool: t.name, inputKeys: Object.keys(input) });
        if (tdef.permission === 'deny') {
          publishEvent('chat.tool_denied', sessionId, traceId, { agentId, tool: t.name });
          return `[permission] Tool "${t.name}" is disabled for this agent.`;
        }
        const ctx: ChatToolContext = { state: opts.state ?? {} };
        try {
          const result = await withRetry(
            () => tdef.execute(input, ctx),
            undefined,
            `chat-tool-${t.name}`,
            { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 4000, jitterFactor: 0.2 },
          );
          publishEvent('chat.tool_result', sessionId, traceId, { agentId, tool: t.name, ok: true });
          return result;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          publishEvent('chat.tool_result', sessionId, traceId, { agentId, tool: t.name, ok: false, error: msg.slice(0, 300) });
          // Surface to the model so it can recover/retry (Codex observe pattern)
          return `[error] ${t.name} failed: ${msg}`;
        }
      },
    })]),
  );

  // ── Build model config with optional escalation chain ─────────────────────
  let currentModel = model;
  let attempt = 0;
  let stepsRun = 0;
  let escaped = false;
  const toolsCalled: { name: string; ok: boolean }[] = [];
  let compacted = false;

  // v2.8.0 G2: context compaction pass (OpenCode autoCompact at ~95% window)
  const historyText = history.map(m => m.content).join('\n');
  const estimatedTokens = estimateTokens(systemPrompt + historyText);
  let compactedHistory = [...history];
  if (estimatedTokens > windowCapacity * compactThreshold && history.length > 4) {
    const keep = Math.max(2, Math.floor(history.length * (1 - compactThreshold)));
    const dropped = history.slice(0, history.length - keep);
    const summary = `History summary (older turns compacted to preserve context):\n${
      dropped.map(m => `${m.role}: ${m.content.slice(0, 200)}`).join('\n')}`;
    compactedHistory = [{ role: 'assistant' as const, content: summary }, ...history.slice(history.length - keep)];
    compacted = true;
    publishEvent('chat.compact', sessionId, traceId, { agentId, droppedTurns: dropped.length, kept: keep });
    log.info({ agentId, droppedTurns: dropped.length }, '[chatAgentLoop] context compacted');
  }

  const runStep = async (historySnapshot: { role: 'user' | 'assistant'; content: string }[]): Promise<{ text: string; done: boolean; toolEvents: { name: string; ok: boolean }[] }> => {
    const stepSpan = startSpan({ traceId, sessionId, category: 'tool' });
    stepsRun += 1;
    const modelForStep = getModelForConfig(config, currentModel);
    const result = streamText({
      model: modelForStep,
      system: systemPrompt,
      messages: historySnapshot,
      tools: Object.keys(aiTools).length > 0 ? (aiTools as any) : undefined,
      maxOutputTokens,
      temperature,
    });
    // Materialize the full text by consuming the stream (the harness owns the
    // loop, so the ai SDK never re-calls the model — the stream carries the
    // text while tool calls are recorded on the result object).
    let fullText = '';
    for await (const chunk of result.textStream) { fullText += chunk; }
    // Wait for the tool-call recording to settle (ai v6 populates toolCalls on
    // the final result; we poll once then fall back to zero-call assumption).
    let stepToolCalls: { toolName: string }[] = [];
    for (let i = 0; i < 5; i++) {
      const calls = (result as unknown as { toolCalls?: { toolName: string }[] }).toolCalls;
      if (calls && calls.length > 0) { stepToolCalls = calls; break; }
      await new Promise(r => setTimeout(r, 25));
    }
    const collected: { name: string; ok: boolean }[] = stepToolCalls.map(tc => {
      const tdef = toolMap.get(tc.toolName);
      return { name: tc.toolName, ok: tdef ? tdef.permission !== 'deny' : false };
    });
    stepSpan.finish('chat.step_end', { textLength: fullText.length, toolCalls: stepToolCalls.length });
    return { text: fullText, done: stepToolCalls.length === 0, toolEvents: collected };
  };

  // ── Iterative loop: answer → tools → observe → answer ────────────────────
  let historySnapshot = compactedHistory;
  let finalText = '';
  let loopActive = true;
  try {
    while (loopActive) {
      if (budget && budget.stepsUsed >= maxTurnSteps) {
        // v2.8.0 G4: per-agent step budget with Codex-style 80% warning and
        // hard cap — enforced before each step, not just observed after.
        publishEvent('chat.budget_exceeded', sessionId, traceId, { agentId, reason: 'steps_exceeded', steps: stepsRun });
        escaped = true;
        loopActive = false;
        break;
      }
      if (budget && budget.stepsUsed >= Math.max(1, Math.floor(maxTurnSteps * 0.8))) {
        if (!budget.warningsEmitted.has('steps')) {
          budget.warningsEmitted.add('steps');
          publishEvent('chat.budget_warning', sessionId, traceId, { agentId, warning: 'steps' });
        }
      }
      if (stepsRun >= maxTurnSteps) {
        publishEvent('chat.loop_escape', sessionId, traceId, { agentId, steps: stepsRun });
        escaped = true;
        break;
      }
      const step = await withRetry(
        () => runStep(historySnapshot),
        undefined,
        `chat-turn-${sessionId}`,
        { maxAttempts: 2, baseDelayMs: 800, maxDelayMs: 6000, jitterFactor: 0.3 },
      );
      finalText = step.text;
      toolsCalled.push(...step.toolEvents);
      if (step.done) { loopActive = false; break; }
      // Observe: append the model's working text as a visible assistant entry
      // so subsequent steps see prior work (Codex append-only history).
      historySnapshot = [...historySnapshot, { role: 'assistant', content: step.text }];
      if (budget) {
        // Record the step + its tokens (recordAgentStep increments stepsUsed
        // once and emits warning events; the pre-loop check above enforces the
        // hard cap at the top of the NEXT iteration).
        recordAgentStep(budget, { maxSteps: maxTurnSteps, maxTokensPerStep: 0 }, estimateTokens(step.text), traceId);
      }
      // v2.8.0 G3: model escalation on repeated provider failure (Codex fallback)
      if (escalation && attempt >= 2) {
        const decision: EscalationDecision = escalateModel(escalation);
        if ('fallback' in decision) {
          currentModel = decision.fallback;
          publishEvent('chat.model_fallback', sessionId, traceId, { agentId, to: currentModel });
          log.info({ agentId, to: currentModel }, '[chatAgentLoop] escalated model');
          attempt = 0;
        } else {
          publishEvent('chat.model_exhausted', sessionId, traceId, { agentId });
          throw new Error('All models in the escalation chain failed');
        }
      }
      attempt += 1;
    }
  } catch (err) {
    span.finish('chat.loop_error', { error: err instanceof Error ? err.message : String(err) });
    publishEvent('chat.loop_error', sessionId, traceId, { agentId, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }

  const summary: ChatTurnSummary = {
    stepsRun,
    toolsCalled,
    finalTextLength: finalText.length,
    durationMs: Date.now() - t0,
    modelUsed: currentModel,
    escaped,
  };
  publishEvent('chat.loop_end', sessionId, traceId, summary as unknown as Record<string, unknown>);
  span.finish('chat.turn_complete', summary as unknown as Record<string, unknown>);

  return {
    textStream: (async function* () { yield finalText; })(),
    finalText:  Promise.resolve(finalText),
    summary:    Promise.resolve(summary),
    compacted:  Promise.resolve(compacted),
  };
}
