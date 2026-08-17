/**
 * src/engine/tokenBudgetManager.ts
 *
 * Token Budget Manager — §2.4 of the v4 spec.
 *
 * Session-scoped token budget tracking. All agents check their budget before
 * calling the LLM. Budget exhaustion emits token.budget_exhausted and blocks
 * further LLM calls in that session.
 *
 * Design:
 *   - Per-session budgets initialized on session creation
 *   - Per-agent consumption tracking within the session
 *   - Warning threshold: emits token.budget_warning at 80% usage
 *   - Exhaustion: emits token.budget_exhausted, consume() returns { allowed: false }
 *   - LRU eviction: max MAX_SESSIONS sessions tracked simultaneously
 */

import { publishEvent, eventBus, type Unsubscribe } from './eventBus';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TokenBudget {
  sessionId: string;
  totalBudget: number;         // max tokens for the whole session
  consumed: number;            // tokens consumed so far
  remaining: number;           // totalBudget - consumed
  warningThreshold: number;    // emit warning when consumed exceeds this
  warningEmitted: boolean;
  exhausted: boolean;
  perAgent: Record<string, number>; // agentId → tokens consumed
  createdAt: string;
  lastUpdatedAt: string;
}

export interface ConsumptionResult {
  allowed: boolean;            // false if budget exhausted
  consumed: number;            // tokens actually recorded (may be 0 if not allowed)
  remaining: number;
  budgetPct: number;           // 0–100, how much of the budget has been used
  warningTriggered: boolean;
}

export interface TokenUsageReport {
  sessionId: string;
  totalBudget: number;
  totalConsumed: number;
  remaining: number;
  utilizationPct: number;
  perAgent: Array<{ agentId: string; tokens: number; pct: number }>;
  exhausted: boolean;
  warningEmitted: boolean;
}

export interface BudgetConfig {
  /** Total token budget for the session */
  totalBudget: number;
  /** Fraction of budget that triggers a warning (default 0.80) */
  warningFraction?: number;
}

const DEFAULT_TOTAL_BUDGET = 500_000;   // ~500K tokens per session
const DEFAULT_WARNING_FRACTION = 0.80;
const MAX_SESSIONS = 200;

// ── Manager implementation ────────────────────────────────────────────────────

class TokenBudgetManagerImpl {
  private readonly sessions = new Map<string, TokenBudget>();
  private readonly accessOrder: string[] = []; // LRU tracking

  /**
   * Initialize budget for a new session.
   * Idempotent — safe to call multiple times (returns existing budget).
   */
  initSession(sessionId: string, config: BudgetConfig = { totalBudget: DEFAULT_TOTAL_BUDGET }): TokenBudget {
    if (this.sessions.has(sessionId)) {
      this.touch(sessionId);
      return this.sessions.get(sessionId)!;
    }

    // LRU eviction if at capacity
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.accessOrder.shift();
      if (oldest) this.sessions.delete(oldest);
    }

    const warningThreshold = Math.floor(
      config.totalBudget * (config.warningFraction ?? DEFAULT_WARNING_FRACTION)
    );

    const now = new Date().toISOString();
    const budget: TokenBudget = {
      sessionId,
      totalBudget: config.totalBudget,
      consumed: 0,
      remaining: config.totalBudget,
      warningThreshold,
      warningEmitted: false,
      exhausted: false,
      perAgent: {},
      createdAt: now,
      lastUpdatedAt: now,
    };

    this.sessions.set(sessionId, budget);
    this.accessOrder.push(sessionId);
    return budget;
  }

  /**
   * Get the current budget for a session. Auto-initializes if not found.
   */
  getBudget(sessionId: string): TokenBudget {
    if (!this.sessions.has(sessionId)) {
      return this.initSession(sessionId);
    }
    this.touch(sessionId);
    return this.sessions.get(sessionId)!;
  }

  /**
   * Record token consumption for an agent.
   * Returns ConsumptionResult indicating whether the consumption was allowed.
   */
  consume(sessionId: string, agentId: string, tokens: number, traceId = 'unknown'): ConsumptionResult {
    const budget = this.getBudget(sessionId);

    if (budget.exhausted) {
      return {
        allowed: false,
        consumed: 0,
        remaining: budget.remaining,
        budgetPct: 100,
        warningTriggered: false,
      };
    }

    // Apply consumption
    budget.consumed += tokens;
    budget.remaining = Math.max(0, budget.totalBudget - budget.consumed);
    budget.perAgent[agentId] = (budget.perAgent[agentId] ?? 0) + tokens;
    budget.lastUpdatedAt = new Date().toISOString();

    const budgetPct = Math.round((budget.consumed / budget.totalBudget) * 100);

    // Warning threshold
    let warningTriggered = false;
    if (!budget.warningEmitted && budget.consumed >= budget.warningThreshold) {
      budget.warningEmitted = true;
      warningTriggered = true;
      publishEvent('token.budget_warning', sessionId, traceId, {
        agentId,
        consumed: budget.consumed,
        remaining: budget.remaining,
        totalBudget: budget.totalBudget,
        pct: budgetPct,
      });
    }

    // Exhaustion
    if (budget.remaining === 0) {
      budget.exhausted = true;
      publishEvent('token.budget_exhausted', sessionId, traceId, {
        agentId,
        totalConsumed: budget.consumed,
        totalBudget: budget.totalBudget,
      });
    }

    return {
      allowed: true,
      consumed: tokens,
      remaining: budget.remaining,
      budgetPct,
      warningTriggered,
    };
  }

  /**
   * Check if a session has budget for an estimated token count (non-consuming).
   */
  isWithinBudget(sessionId: string, estimatedTokens: number): boolean {
    const budget = this.getBudget(sessionId);
    return !budget.exhausted && budget.remaining >= estimatedTokens;
  }

  /**
   * Generate a detailed usage report for a session.
   */
  getUsage(sessionId: string): TokenUsageReport {
    const budget = this.getBudget(sessionId);
    const utilizationPct = Math.round((budget.consumed / budget.totalBudget) * 100);

    const perAgent = Object.entries(budget.perAgent)
      .map(([agentId, tokens]) => ({
        agentId,
        tokens,
        pct: Math.round((tokens / budget.totalBudget) * 100),
      }))
      .sort((a, b) => b.tokens - a.tokens);

    return {
      sessionId,
      totalBudget: budget.totalBudget,
      totalConsumed: budget.consumed,
      remaining: budget.remaining,
      utilizationPct,
      perAgent,
      exhausted: budget.exhausted,
      warningEmitted: budget.warningEmitted,
    };
  }

  /**
   * Register a handler for budget warning events (convenience wrapper).
   * Returns unsubscribe function.
   */
  onBudgetWarning(handler: (sessionId: string, remaining: number) => void): Unsubscribe {
    return eventBus.subscribe<{ remaining: number }>('token.budget_warning', (event) => {
      handler(event.sessionId, event.payload.remaining);
    });
  }

  /**
   * Clear all budget data for a session (call on session teardown).
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    const idx = this.accessOrder.indexOf(sessionId);
    if (idx !== -1) this.accessOrder.splice(idx, 1);
  }

  private touch(sessionId: string): void {
    const idx = this.accessOrder.indexOf(sessionId);
    if (idx !== -1) {
      this.accessOrder.splice(idx, 1);
      this.accessOrder.push(sessionId);
    }
  }
}

// ── Singleton export ───────────────────────────────────────────────────────────

export const tokenBudgetManager = new TokenBudgetManagerImpl();
