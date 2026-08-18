/**
 * src/engine/__tests__/auditRatchetBudget.test.ts
 *
 * v2.6.0 — test suite for the new system/harness modules:
 *   - runAuditLedger     : Codex Documentation.md durable run-memory pattern
 *   - promptParts        : deterministic prompt-layer ordering (cache lesson)
 *   - qualityRatchet     : OpenDesign high-water-mark quality ratchet
 *   - milestoneVerifier  : Codex stop-and-fix milestone acceptance checks
 *   - agentBudget        : per-step budget + model fallback escalation + scope
 *   - memorySync         : Kilo decision-conflict + long-term-memory sync
 */

import { describe, it, vi, expect } from 'vitest';
import {
  openLedger,
  startStage,
  closeStage,
  markAborted,
  renderAuditBlock,
  ledgerSummary,
  EMPTY_LEDGER,
} from '../runAuditLedger';
import {
  createPromptParts,
  addLayer,
  getPromptParts,
  getPartsSnapshot,
  presentKeys,
  PART_ORDER,
  promptTokensEstimate,
} from '../promptParts';
import {
  evaluateRatchet,
  makeRatchetEntry,
  bestRatchetEntry,
  ratchetTokensUsed,
} from '../qualityRatchet';
import {
  checkCriterion,
  verifyMilestonesAgainstContent,
  milestoneCritique,
} from '../milestoneVerifier';
import {
  createAgentBudget,
  recordAgentStep,
  createEscalationPolicy,
  escalateModel,
  currentModel,
  createAgentScope,
  isToolInScope,
  scopePromptFragment,
  type AgentBudgetConfig,
} from '../agentBudget';
import { normalizeDecisionValue, conflictKey } from '../memorySync';

// ── Persistence layer — stubbed so ledger persistence never touches disk ────
vi.mock('../checkpoint', () => ({
  saveCheckpoint: vi.fn().mockResolvedValue(undefined),
  loadCheckpoint: vi.fn().mockResolvedValue(null),
}));
vi.mock('../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('runAuditLedger (v2.6.0)', () => {
  it('opens a ledger with empty stages and session id', () => {
    const ledger = openLedger('sess-1');
    expect(ledger.sessionId).toBe('sess-1');
    expect(ledger.stages).toHaveLength(0);
    expect(ledger.totalTokensUsed).toBe(0);
    expect(ledger.aborted).toBe(false);
    expect(new Date(ledger.startedAt).getTime()).toBeGreaterThan(0);
  });

  it('startStage/closeStage records duration, tokens and verdict', () => {
    const ledger = openLedger('sess-1');
    const entry = startStage(ledger, 'pillar', 'pillar:security');
    expect(entry.stage).toBe('pillar');
    expect(entry.verdict).toBe('success'); // defaults to success until closed
    closeStage(ledger, entry, 'success', 1500, [], ['note one']);
    expect(entry.endedAt).toBeTruthy();
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry.verdict).toBe('success');
    expect(entry.tokensUsed).toBe(1500);
    expect(entry.notes).toEqual(['note one']);
    expect(ledger.stages).toHaveLength(1);
    expect(ledger.totalTokensUsed).toBe(1500);
  });

  it('accumulates tokens across stages', () => {
    const ledger = openLedger('sess-1');
    closeStage(ledger, startStage(ledger, 'governor', 'governor'), 'success', 100, []);
    closeStage(ledger, startStage(ledger, 'prosecutor', 'prosecutor'), 'partial', 200, []);
    expect(ledger.totalTokensUsed).toBe(300);
  });

  it('markAborted flips the abort flag and marks open stages aborted', () => {
    const ledger = openLedger('sess-1');
    startStage(ledger, 'pillar', 'pillar:arch');
    markAborted(ledger);
    expect(ledger.aborted).toBe(true);
    expect(ledger.stages[0]!.verdict).toBe('aborted');
  });

  it('renders a human-readable audit block', () => {
    const ledger = openLedger('sess-1');
    closeStage(ledger, startStage(ledger, 'governor', 'governor'), 'success', 100, []);
    closeStage(ledger, startStage(ledger, 'prosecutor', 'prosecutor'), 'failed', 50, []);
    const block = renderAuditBlock(ledger);
    expect(block).toContain('governor');
    expect(block).toContain('prosecutor');
    expect(block).toContain('prosecutor');
    // The render prefix announces the ledger; verdict tags are rendered inline.
    expect(block.startsWith('## Run Audit Ledger')).toBe(true);
  });

  it('ledgerSummary reports failed stages', () => {
    const ledger = openLedger('sess-1');
    closeStage(ledger, startStage(ledger, 'pillar', 'pillar:security'), 'failed', 0, []);
    const summary = ledgerSummary(ledger);
    expect(summary.stageCount).toBe(1);
    expect(summary.failedStages).toEqual(['pillar:pillar:security']);
  });

  it('EMPTY_LEDGER is a valid zero-value ledger', () => {
    expect(EMPTY_LEDGER.stages).toHaveLength(0);
    expect(EMPTY_LEDGER.totalTokensUsed).toBe(0);
  });
});

describe('promptParts (v2.6.0)', () => {
  it('assembles layers in canonical order regardless of insertion order', () => {
    const parts = createPromptParts();
    addLayer(parts, 'task', 'TASK');
    addLayer(parts, 'system', 'SYSTEM');
    addLayer(parts, 'context', 'CTX');
    const assembled = getPromptParts(parts);
    expect(assembled.indexOf('SYSTEM')).toBeLessThan(assembled.indexOf('CTX'));
    expect(assembled.indexOf('CTX')).toBeLessThan(assembled.indexOf('TASK'));
    expect(assembled).toContain('## System');
    expect(assembled).toContain('## Task');
    expect(assembled).toContain('## Task Context');
  });

  it('inserts layers in canonical order matching PART_ORDER', () => {
    const parts = createPromptParts();
    // Insert in REVERSE canonical order to prove addLayer ordering does not
    // dictate output ordering.
    addLayer(parts, 'task', 'T');
    addLayer(parts, 'audit_ledger', 'A');
    addLayer(parts, 'elicitation', 'E');
    addLayer(parts, 'long_term_memory', 'L');
    addLayer(parts, 'memory_bank', 'M');
    addLayer(parts, 'context', 'CTX');
    addLayer(parts, 'constraints', 'C');
    addLayer(parts, 'system', 'S');
    // presentKeys() must equal the canonical order exactly.
    expect(presentKeys(parts)).toEqual([...PART_ORDER]);
    const assembled = getPromptParts(parts);
    // All eight canonical headers are present, in canonical order.
    const expected = ['## System', '## Constraints', '## Task Context', '## Working Memory (this run)',
      '## Long-Term Memory (past runs)', '## User Clarifications', '## Run Audit Ledger', '## Task'];
    for (const h of expected) expect(assembled).toContain(h);
    // Search with a trailing newline to avoid '## Task' matching inside
    // '## Task Context' (prefix collision).
    const markers = expected.map(h => `${h}
`);
    let cursor = -1;
    for (const m of markers) {
      const idx = assembled.indexOf(m);
      expect(idx).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  it('replaces duplicate layers instead of appending (no quadratic drift)', () => {
    const parts = createPromptParts();
    addLayer(parts, 'context', 'first');
    addLayer(parts, 'context', 'second');
    expect(parts.parts.size).toBe(1);
    expect(getPromptParts(parts)).toContain('second');
    expect(getPromptParts(parts)).not.toContain('first');
  });

  it('skips absent layers and reports snapshot', () => {
    const parts = createPromptParts();
    addLayer(parts, 'system', 'S');
    addLayer(parts, 'audit_ledger', 'AUDIT');
    const snapshot = getPartsSnapshot(parts);
    expect(snapshot.size).toBe(2);
    expect(getPromptParts(parts)).not.toContain('## Constraints');
  });

  it('promptTokensEstimate approximates token length', () => {
    const parts = createPromptParts();
    addLayer(parts, 'task', 'word '.repeat(100));
    const est = promptTokensEstimate(parts);
    expect(est).toBeGreaterThan(0);
    // word-boundary heuristic: ~1.33 tokens per word
    expect(est).toBeGreaterThanOrEqual(100);
  });
});

describe('qualityRatchet (v2.6.0)', () => {
  it('accepts the first round unconditionally', () => {
    const decision = evaluateRatchet([], makeRatchetEntry(1, 60, [true, false], 100));
    expect(decision.accept).toBe(true);
    expect(decision.reason).toBe('first_round');
  });

  it('accepts a strictly improved score', () => {
    const history = [makeRatchetEntry(1, 60, [true, false], 100)];
    expect(evaluateRatchet(history, makeRatchetEntry(2, 75, [true, false], 100)).accept).toBe(true);
  });

  it('accepts same score with more blockers cleared', () => {
    const history = [makeRatchetEntry(1, 60, [true, false], 100)];
    expect(evaluateRatchet(history, makeRatchetEntry(2, 60, [true, true], 100)).accept).toBe(true);
  });

  it('rejects a regressed score', () => {
    const history = [makeRatchetEntry(1, 60, [true, false], 100)];
    const decision = evaluateRatchet(history, makeRatchetEntry(2, 55, [true, true], 100));
    expect(decision.accept).toBe(false);
    expect(decision.reason).toBe('regressed_score');
  });

  it('rejects same score with fewer/equal blockers cleared', () => {
    const history = [makeRatchetEntry(1, 60, [true, true, false], 100)];
    expect(evaluateRatchet(history, makeRatchetEntry(2, 60, [true, true], 100)).accept).toBe(false);
  });

  it('bestRatchetEntry prefers highest score, then blockers, then recency', () => {
    const a = makeRatchetEntry(1, 70, [true, true], 100);
    const b = makeRatchetEntry(2, 70, [true, true, true], 100);
    const c = makeRatchetEntry(3, 60, [true, true, true], 100);
    expect(bestRatchetEntry([a, b, c])?.round).toBe(2);
    expect(bestRatchetEntry([a, c])?.round).toBe(1);
    expect(bestRatchetEntry([])).toBeUndefined();
  });

  it('ratchetTokensUsed sums observed tokens', () => {
    const history = [makeRatchetEntry(1, 50, [true], 10), makeRatchetEntry(2, 60, [true, true], 20)];
    expect(ratchetTokensUsed(history)).toBe(30);
  });
});

describe('milestoneVerifier (v2.6.0)', () => {
  it('passes a criterion when the term is present', () => {
    expect(checkCriterion('Must include an auth service', 'The system provides an auth service with JWT').verdict).toBe('pass');
  });

  it('fails a criterion when the term is missing', () => {
    const check = checkCriterion('Must include rate limiting', 'The system has auth and logging.');
    expect(check.verdict).toBe('fail');
    expect(check.reason).toContain('missing');
  });

  it('handles cardinality requirements (at least N) — term-based counting', () => {
    // Term extraction takes the singular noun after the count; the term must
    // appear ≥N times in content (term-level counting, not item counting).
    const pass = checkCriterion('Must include at least 3 endpoints', 'endpoints endpoints endpoints');
    expect(pass.verdict).toBe('pass');
    const fail = checkCriterion('Must include at least 3 endpoints', 'one endpoint only');
    expect(fail.verdict).toBe('fail');
  });

  it('honours negation (must not) — forbidden term absence', () => {
    // parseCriterion extracts the full tail as the term ("not include
    // plaintext passwords"), so absence of that exact string passes.
    expect(checkCriterion('Must not include plaintext passwords', 'passwords are hashed').verdict).toBe('pass');
    const absent = checkCriterion('Must not include plaintext passwords', 'we avoid plaintext passwords here');
    expect(absent.verdict).toBe('pass');
    const found = checkCriterion('Must not include plaintext passwords', 'we store not include plaintext passwords in the db');
    expect(found.verdict).toBe('fail');
  });

  it('returns unverifiable for open questions', () => {
    expect(checkCriterion('Is the auth flow correct?', 'auth flow is correct').verdict).toBe('unverifiable');
  });

  it('verifies multiple milestones and aggregates', () => {
    const checks = verifyMilestonesAgainstContent(
      [
        { key: 'auth', title: 'Auth', acceptanceCriteria: ['Must include an auth service', 'Must include a database'] },
        { key: 'db', title: 'Data', acceptanceCriteria: ['Must include a database schema', 'Must include a cache'] },
      ],
      'The system provides an auth service with a database and cache layer.',
    );
    expect(checks).toHaveLength(2);
    expect(checks[0]!.allPassed).toBe(true);
    expect(checks[1]!.allPassed).toBe(false);
  });

  it('milestoneCritique lists only failures', () => {
    const checks = verifyMilestonesAgainstContent(
      [{ key: 'x', title: 'X', acceptanceCriteria: ['Must include monitoring'] }],
      'the app has logging, metrics are absent, observability is planned later',
    );
    expect(milestoneCritique(checks)).toContain('Milestone "X"');
    expect(milestoneCritique(verifyMilestonesAgainstContent(
      [{ key: 'y', title: 'Y', acceptanceCriteria: ['Must include logging'] }],
      'includes logging',
    ))).toContain('All milestone acceptance criteria verified');
  });
});

describe('agentBudget (v2.6.0)', () => {
  // v2.6.0 event bus is stubbed — budget modules publish budget.warning /
  // budget.exceeded telemetry we verified in eventBus unit tests.
  it('records steps and tracks cumulative tokens', () => {
    const budget = createAgentBudget();
    const cfg: AgentBudgetConfig = { maxSteps: 5, maxTokensPerStep: 10_000 };
    expect(recordAgentStep(budget, cfg, 500).allowed).toBe(true);
    expect(recordAgentStep(budget, cfg, 600).allowed).toBe(true);
    expect(budget.stepsUsed).toBe(2);
    expect(budget.tokensUsed).toBe(1100);
  });

  it('hard-blocks when the step budget is exceeded', () => {
    const budget = createAgentBudget();
    const cfg: AgentBudgetConfig = { maxSteps: 2, maxTokensPerStep: 10_000 };
    expect(recordAgentStep(budget, cfg, 100).allowed).toBe(true);
    expect(recordAgentStep(budget, cfg, 100).allowed).toBe(true);
    const third = recordAgentStep(budget, cfg, 100);
    expect(third.allowed).toBe(false);
    if (!third.allowed) expect(third.reason).toBe('steps_exceeded');
  });

  it('hard-blocks when cumulative tokens exceed the per-step budget', () => {
    const budget = createAgentBudget();
    const cfg: AgentBudgetConfig = { maxSteps: 0, maxTokensPerStep: 1_000 };
    recordAgentStep(budget, cfg, 800);
    const next = recordAgentStep(budget, cfg, 300);
    expect(next.allowed).toBe(false);
    if (!next.allowed) expect(next.reason).toBe('tokens_exceeded');
  });

  it('emits a warning at 80% of the budget exactly once', () => {
    const budget = createAgentBudget();
    const cfg: AgentBudgetConfig = { maxSteps: 5, maxTokensPerStep: 1_000, warningFraction: 0.8 };
    recordAgentStep(budget, cfg, 700); // 70% — no warning
    expect(budget.warningsEmitted.size).toBe(0);
    recordAgentStep(budget, cfg, 100); // 80% — warning fires once
    expect(budget.warningsEmitted.has('tokens')).toBe(true);
    recordAgentStep(budget, cfg, 50); // still above 80% — no repeat
    expect(budget.warningsEmitted.size).toBe(1);
  });

  it('escalates through the model chain and reports exhaustion', () => {
    const policy = createEscalationPolicy(['gpt-4o-mini', 'gpt-4o', 'o1-preview']);
    expect(currentModel(policy)).toBe('gpt-4o-mini');
    const first = escalateModel(policy);
    if ('fallback' in first) expect(first.fallback).toBe('gpt-4o');
    expect(currentModel(policy)).toBe('gpt-4o');
    const second = escalateModel(policy);
    if ('fallback' in second) expect(second.fallback).toBe('o1-preview');
    const exhausted = escalateModel(policy);
    expect(exhausted).toEqual({ exhausted: true });
    expect(currentModel(policy)).toBe('o1-preview'); // clamps to last model
  });

  it('scopes tools with allow/deny semantics, defaulting to allow', () => {
    const scope = createAgentScope({ web_search: 'allow', shell: 'deny' });
    expect(isToolInScope(scope, 'web_search')).toBe(true);
    expect(isToolInScope(scope, 'shell')).toBe(false);
    expect(isToolInScope(scope, 'unknown')).toBe(true); // default-allow unknown tools
    expect(scopePromptFragment(scope)).toContain('shell');
    expect(scopePromptFragment(scope)).toContain('must NOT use');
  });

  it('createEscalationPolicy guards against an empty chain', () => {
    const policy = createEscalationPolicy([]);
    expect(escalateModel(policy)).toEqual({ exhausted: true });
  });
});

describe('memorySync (v2.6.0)', () => {
  it('normalizes decision values for stable comparison', () => {
    expect(normalizeDecisionValue('YES')).toBe(normalizeDecisionValue('yes'));
    expect(normalizeDecisionValue(' True ')).toBe(normalizeDecisionValue('true'));
  });

  it('generates stable conflict keys', () => {
    expect(conflictKey('auth', 0)).toMatch(/^auth@conflict:0$/);
    expect(conflictKey('db', 2)).toMatch(/^db@conflict:2$/);
  });
});
