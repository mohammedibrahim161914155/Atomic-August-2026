/**
 * src/engine/contextWindowManager.ts
 *
 * Context Window Manager — §2.9 of the v4 spec.
 *
 * Called before every agent API call. If the assembled context exceeds the
 * model's context window, it applies priority ordering to fit within the budget.
 *
 * Priority order (highest to lowest — highest is preserved last):
 *   1. System prompt + active skills
 *   2. Last N messages from conversation history (always included)
 *   3. Relevant workspace sections (by semantic relevance to current query)
 *   4. Blueprint summary (full blueprint only if within budget)
 *   5. Earlier conversation history (summarized if over budget)
 *   6. Tool call history (summarized)
 *
 * The manager is deterministic and does not call LLMs — summarization uses
 * extractive truncation with structural markers so agents always know
 * where content was trimmed.
 */

import { estimateTokens, ContextBudgetManager } from './contextBudget';
import { getModelById } from '../models/registry';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}

export interface WorkspaceSection {
  workspaceId: string;
  key: string;
  content: string;
  /** Relevance score 0–1 (set by caller, or computed by keyword overlap) */
  relevanceScore?: number;
}

export interface ContextAssemblyInput {
  modelId: string;
  /** Current user query / request */
  currentQuery: string;
  /** System prompt (always included, highest priority) */
  systemPrompt: string;
  /** Conversation history, newest last */
  conversationHistory?: ConversationMessage[];
  /** Workspace content sections available for injection */
  workspaceSections?: WorkspaceSection[];
  /** Full blueprint text (included only if budget allows) */
  blueprintContent?: string;
  /** Recent tool call summaries */
  toolCallHistory?: Array<{ tool: string; summary: string; timestamp: string }>;
  /** How many tokens to reserve for the model's output */
  outputReserve?: number;
  /** Always include the last N conversation turns regardless of budget */
  minRecentTurns?: number;
  /** Override context window if model not in registry */
  contextWindowOverride?: number;
}

export interface AssemblyResult {
  systemPrompt: string;
  contextText: string;
  /** Total estimated tokens in (systemPrompt + contextText + outputReserve) */
  totalEstimatedTokens: number;
  contextWindowCapacity: number;
  /** Fraction of context window used */
  utilizationFraction: number;
  /** Which content categories were truncated */
  truncated: {
    earlyHistory: boolean;
    workspaceSections: boolean;
    blueprint: boolean;
    toolCallHistory: boolean;
  };
  /** Assembly audit — which sections are included and at what token cost */
  audit: Array<{ section: string; tokens: number; included: boolean }>;
}

const DEFAULT_OUTPUT_RESERVE = 4_096;
const DEFAULT_MIN_RECENT_TURNS = 4;
const DEFAULT_CONTEXT_WINDOW = 128_000;

const TRIM_MARKER = '[...content trimmed to fit context window...]';

// ── Relevance scorer ───────────────────────────────────────────────────────────

/**
 * Compute keyword overlap between query and content.
 * Returns 0–1. Simple but deterministic and free.
 */
function keywordRelevance(query: string, content: string): number {
  if (!content) return 0;
  const q = query.toLowerCase();
  const words = q.split(/\W+/).filter(w => w.length > 3);
  if (words.length === 0) return 0.5; // no signal, include moderately

  const c = content.toLowerCase();
  const matches = words.filter(w => c.includes(w)).length;
  return matches / words.length;
}

// ── Context Window Manager ─────────────────────────────────────────────────────

export class ContextWindowManager {
  /**
   * Assemble the context for an LLM call, applying priority ordering to fit
   * within the model's context window.
   */
  static assemble(input: ContextAssemblyInput): AssemblyResult {
    const {
      modelId,
      currentQuery,
      systemPrompt,
      conversationHistory = [],
      workspaceSections = [],
      blueprintContent,
      toolCallHistory = [],
      outputReserve = DEFAULT_OUTPUT_RESERVE,
      minRecentTurns = DEFAULT_MIN_RECENT_TURNS,
      contextWindowOverride,
    } = input;

    // Resolve model context window
    const registry = getModelById(modelId);
    const contextWindow = contextWindowOverride ?? registry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;

    const systemTokens = estimateTokens(systemPrompt);
    let budgetRemaining = contextWindow - systemTokens - outputReserve;

    const audit: Array<{ section: string; tokens: number; included: boolean }> = [];
    const parts: string[] = [];
    const truncated = {
      earlyHistory: false,
      workspaceSections: false,
      blueprint: false,
      toolCallHistory: false,
    };

    // ── Step 1: Current query (always included) ───────────────────────────────
    const queryTokens = estimateTokens(currentQuery);
    if (queryTokens <= budgetRemaining) {
      parts.push(`## Current Request\n${currentQuery}`);
      budgetRemaining -= queryTokens;
      audit.push({ section: 'current_query', tokens: queryTokens, included: true });
    } else {
      // Truncate to fit
      const maxChars = Math.floor(budgetRemaining * 3.5);
      parts.push(`## Current Request\n${currentQuery.slice(0, maxChars)}${TRIM_MARKER}`);
      budgetRemaining = 0;
      audit.push({ section: 'current_query', tokens: queryTokens, included: true });
    }

    // ── Step 2: Last N conversation turns (always included) ───────────────────
    const recentHistory = conversationHistory.slice(-minRecentTurns * 2);
    const recentText = recentHistory
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    const recentTokens = estimateTokens(recentText);

    if (recentText && recentTokens <= budgetRemaining) {
      parts.push(`## Recent Conversation\n${recentText}`);
      budgetRemaining -= recentTokens;
      audit.push({ section: 'recent_history', tokens: recentTokens, included: true });
    } else if (recentText) {
      const maxChars = Math.floor(budgetRemaining * 3.5);
      const trimmed = recentText.slice(-maxChars);
      parts.push(`## Recent Conversation\n${TRIM_MARKER}\n${trimmed}`);
      budgetRemaining = 0;
      audit.push({ section: 'recent_history', tokens: recentTokens, included: true });
    }

    // ── Step 3: Workspace sections (sorted by relevance) ─────────────────────
    const scoredSections = workspaceSections
      .map(s => ({
        ...s,
        score: s.relevanceScore ?? keywordRelevance(currentQuery, s.content),
      }))
      .sort((a, b) => b.score - a.score);

    const includedSections: string[] = [];
    for (const section of scoredSections) {
      const sectionText = `### ${section.workspaceId} / ${section.key}\n${section.content}`;
      const sectionTokens = estimateTokens(sectionText);

      if (sectionTokens <= budgetRemaining && budgetRemaining > 500) {
        includedSections.push(sectionText);
        budgetRemaining -= sectionTokens;
        audit.push({ section: `workspace_${section.workspaceId}_${section.key}`, tokens: sectionTokens, included: true });
      } else {
        truncated.workspaceSections = true;
        audit.push({ section: `workspace_${section.workspaceId}_${section.key}`, tokens: sectionTokens, included: false });
      }
    }

    if (includedSections.length > 0) {
      parts.push(`## Workspace Context\n${includedSections.join('\n\n')}`);
    }

    // ── Step 4: Blueprint summary ──────────────────────────────────────────────
    if (blueprintContent && budgetRemaining > 1000) {
      const bpTokens = estimateTokens(blueprintContent);
      if (bpTokens <= budgetRemaining) {
        parts.push(`## Blueprint\n${blueprintContent}`);
        budgetRemaining -= bpTokens;
        audit.push({ section: 'blueprint', tokens: bpTokens, included: true });
      } else {
        // Include first N chars as summary
        const maxChars = Math.floor(budgetRemaining * 3.5 * 0.5);
        if (maxChars > 500) {
          const summary = blueprintContent.slice(0, maxChars);
          parts.push(`## Blueprint (partial — truncated to fit context window)\n${summary}${TRIM_MARKER}`);
          budgetRemaining = Math.floor(budgetRemaining * 0.5);
          truncated.blueprint = true;
          audit.push({ section: 'blueprint', tokens: bpTokens, included: true });
        } else {
          truncated.blueprint = true;
          audit.push({ section: 'blueprint', tokens: bpTokens, included: false });
        }
      }
    }

    // ── Step 5: Earlier conversation history (summarized) ────────────────────
    const earlierHistory = conversationHistory.slice(0, -minRecentTurns * 2);
    if (earlierHistory.length > 0 && budgetRemaining > 500) {
      const earlierText = earlierHistory
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');
      const earlierTokens = estimateTokens(earlierText);

      if (earlierTokens <= budgetRemaining) {
        parts.push(`## Earlier Conversation\n${earlierText}`);
        budgetRemaining -= earlierTokens;
        audit.push({ section: 'earlier_history', tokens: earlierTokens, included: true });
      } else {
        // Summarize: take first 200 chars of each message
        const summarized = earlierHistory
          .map(m => `${m.role === 'user' ? 'User' : 'Asst'}: ${m.content.slice(0, 200)}`)
          .join('\n');
        const summarizedTokens = estimateTokens(summarized);
        if (summarizedTokens <= budgetRemaining) {
          parts.push(`## Earlier Conversation (summarized)\n${summarized}`);
          budgetRemaining -= summarizedTokens;
        } else {
          truncated.earlyHistory = true;
        }
        audit.push({ section: 'earlier_history', tokens: earlierTokens, included: !truncated.earlyHistory });
      }
    }

    // ── Step 6: Tool call history (summarized) ─────────────────────────────────
    if (toolCallHistory.length > 0 && budgetRemaining > 300) {
      const toolText = toolCallHistory
        .slice(-10) // last 10 tool calls only
        .map(t => `[${t.tool}] ${t.summary}`)
        .join('\n');
      const toolTokens = estimateTokens(toolText);

      if (toolTokens <= budgetRemaining) {
        parts.push(`## Tool Call History (recent)\n${toolText}`);
        budgetRemaining -= toolTokens;
        audit.push({ section: 'tool_history', tokens: toolTokens, included: true });
      } else {
        truncated.toolCallHistory = true;
        audit.push({ section: 'tool_history', tokens: toolTokens, included: false });
      }
    }

    const contextText = parts.join('\n\n---\n\n');
    const totalEstimatedTokens = systemTokens + estimateTokens(contextText) + outputReserve;
    const utilizationFraction = Math.min(1, totalEstimatedTokens / contextWindow);

    return {
      systemPrompt,
      contextText,
      totalEstimatedTokens,
      contextWindowCapacity: contextWindow,
      utilizationFraction,
      truncated,
      audit,
    };
  }

  /**
   * Quick check: will these inputs fit in the context window?
   */
  static wouldFit(
    modelId: string,
    systemPrompt: string,
    contextText: string,
    outputReserve = DEFAULT_OUTPUT_RESERVE,
    contextWindowOverride?: number,
  ): boolean {
    const budget = ContextBudgetManager.calculate({
      modelId,
      systemPrompt,
      context: contextText,
      outputReserve,
      contextWindowOverride,
    });
    return budget.withinBudget;
  }
}
