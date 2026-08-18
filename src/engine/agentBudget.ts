/**
 * src/engine/agentBudget.ts
 *
 * Per-Agent Budget Enforcement + Model Escalation — SOTA lessons from
 * Codex (turn/step budgets with budget.warning/budget.exceeded events),
 * OpenCode (per-agent max steps, per-agent model overrides, tool permission
 * profiles — opencode.ai/docs/agents/) and Kimi CLI (agent-scoped config,
 * moonshotai.github.io/kimi-cli).
 *
 * Atomic's agentRunner already enforces stepCountIs(5). This module adds:
 *
 *   1. AgentBudget tracker: per-agent step + estimated token budgets within
 *      a session, with 80% warning and hard-cap behaviour. Emits the same
 *      budget.warning / budget.exceeded event contract as tokenBudgetManager
 *      but scoped per agent, so the UI and observability API surface it.
 *   2. ModelEscalationPolicy: on provider failure, escalate through a
 *      configured fallback model chain (e.g. proModel → fallbackModel)
 *      instead of dropping to a plain text loop. Mirrors Codex's
 *      --model fallback behaviour: each provider error walks one step down
 *      the chain, and the chain is exhausted → fail the agent with a
 *      clear error instead of silently degrading.
 *   3. AgentScope: typed permission profile (which tools the agent may use)
 *      matching OpenCode's allow/ask/deny profiles; the agentRunner reads it
 *      to deny tool calls outside the agent's scope before execution.
 *
 * Additive — pure logic + small types; agentRunner consumes them.
 */

import { publishEvent } from './eventBus';

// ── Per-agent budget ───────────────────────────────────────────────────────────

export interface AgentBudgetConfig {
  /** Max steps allowed for the agent (0 = unlimited). */
  maxSteps: number;
  /** Estimated per-step token budget (0 = unlimited). */
  maxTokensPerStep: number;
  /** Fraction of either budget that triggers a warning (default 0.80). */
  warningFraction?: number;
}

export interface AgentBudgetState {
  stepsUsed: number;
  tokensUsed: number;
  warningsEmitted: Set<'steps' | 'tokens'>;
}

const DEFAULT_WARNING_FRACTION = 0.8;

export function createAgentBudget(): AgentBudgetState {
  return { stepsUsed: 0, tokensUsed: 0, warningsEmitted: new Set() };
}

export type BudgetCheckResult =
  | { allowed: true; warning: null }
  | { allowed: true; warning: 'steps' | 'tokens' }
  | { allowed: false; reason: 'steps_exceeded' | 'tokens_exceeded' };

/**
 * Record one step + its token usage against the agent budget. Enforces the
 * Codex pattern: warning at 80%, hard block at 100%.
 */
export function recordAgentStep(
  state: AgentBudgetState,
  config: AgentBudgetConfig,
  stepTokens: number,
  traceId = 'unknown',
): BudgetCheckResult {
  const warnAt = config.warningFraction ?? DEFAULT_WARNING_FRACTION;
  state.stepsUsed += 1;
  state.tokensUsed += Math.max(0, stepTokens | 0);

  // Step budget check (hard cap first — a step that already exceeded the cap
  // cannot be "warned" into existence).
  if (config.maxSteps > 0 && state.stepsUsed > config.maxSteps) {
    publishEvent('budget.exceeded', traceId, traceId, { budget_type: 'steps' });
    return { allowed: false, reason: 'steps_exceeded' };
  }
  if (config.maxSteps > 0 && state.stepsUsed >= config.maxSteps * warnAt && !state.warningsEmitted.has('steps')) {
    state.warningsEmitted.add('steps');
    publishEvent('budget.warning', traceId, traceId, { budget_type: 'steps' });
  }

  // Token budget check
  if (config.maxTokensPerStep > 0 && state.tokensUsed > config.maxTokensPerStep) {
    publishEvent('budget.exceeded', traceId, traceId, { budget_type: 'tokens' });
    return { allowed: false, reason: 'tokens_exceeded' };
  }
  if (
    config.maxTokensPerStep > 0 &&
    state.tokensUsed >= config.maxTokensPerStep * warnAt &&
    !state.warningsEmitted.has('tokens')
  ) {
    state.warningsEmitted.add('tokens');
    publishEvent('budget.warning', traceId, traceId, { budget_type: 'tokens' });
  }

  return { allowed: true, warning: null };
}

// ── Model escalation policy ────────────────────────────────────────────────────

export interface ModelEscalationPolicy {
  /** Ordered fallback chain — index 0 is the primary model. */
  chain: string[];
  /** Current position in the chain (0 = primary). */
  position: number;
}

export function createEscalationPolicy(chain: string[]): ModelEscalationPolicy {
  return { chain: chain.length > 0 ? chain : ['primary'], position: 0 };
}

export type EscalationDecision =
  | { fallback: string; position: number }
  | { exhausted: true };

/**
 * Advance one step down the fallback chain after a provider failure.
 * Returns the next model to try, or signals chain exhaustion so the caller
 * fails the agent with a clear error instead of silently degrading.
 */
export function escalateModel(policy: ModelEscalationPolicy): EscalationDecision {
  const next = policy.position + 1;
  if (next >= policy.chain.length) {
    return { exhausted: true };
  }
  policy.position = next;
  return { fallback: policy.chain[next]!, position: next };
}

export function currentModel(policy: ModelEscalationPolicy): string {
  return policy.chain[Math.min(policy.position, policy.chain.length - 1)]!;
}

// ── Agent scope (OpenCode-style tool permission profiles) ──────────────────────

export type ToolPermission = 'allow' | 'deny';

export interface AgentScope {
  /** Per-tool permission map; missing tools default to allow. */
  toolPermissions: Record<string, ToolPermission>;
}

/** Build an agent scope from an allow/deny map. */
export function createAgentScope(permissions: Record<string, ToolPermission> = {}): AgentScope {
  return { toolPermissions: permissions };
}

/**
 * Decide whether a tool call is in scope. Read-only tools are always allowed
 * unless explicitly denied; write/exec tools default to allow but can be
 * denied per-agent (OpenCode plan-agent profile).
 */
export function isToolInScope(scope: AgentScope, toolName: string): boolean {
  const perm = scope.toolPermissions[toolName];
  if (perm === 'deny') return false;
  return true;
}

/** Render the scope as a system-prompt fragment for the agent. */
export function scopePromptFragment(scope: AgentScope): string {
  const denied = Object.entries(scope.toolPermissions)
    .filter(([, p]) => p === 'deny')
    .map(([tool]) => tool);
  if (denied.length === 0) return '';
  return `Tool restrictions: you must NOT use the following tools: ${denied.join(', ')}. For any task requiring them, describe the need instead.`;
}
