import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';

import {
  decideCompaction,
  compactIfNeeded,
  compactHistory,
} from '../contextCompactor';
import {
  askElicitation,
  drainPendingElicitations,
  answerElicitations,
  pendingElicitations,
  listElicitationHistory,
  formatElicitations,
} from '../elicitation';
import {
  decidePermission,
  resolveTier,
  setOperationTier,
  listEffectiveTiers,
  DEFAULT_OPERATION_TIERS,
} from '../permissionRegistry';
import {
  recordVerifierRound,
  listLedger,
  highWaterMark,
  detectDrift,
  summarizeLedger,
} from '../qualityLedger';
import { recordRunStart, recordRunEnd, listRunSummaries } from '../runSummary';

// Stub the model layer so compactHistory tests don't hit OpenRouter.
vi.mock('../openrouter', () => ({
  generateText: vi.fn(async () => ({ text: 'Goals: ship a todo app. Decisions: Postgres, JWT. Rejected: MySQL (no ACID).', tokens_used: 210 })),
}));
vi.mock('../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

function session(): string {
  return randomUUID();
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Context auto-compaction (Codex pattern)
// ─────────────────────────────────────────────────────────────────────────────

describe('contextCompactor', () => {
  it('decides ok / warn / compact / abort by utilisation thresholds', () => {
    const capacity = 100_000;
    expect(decideCompaction(50_000, capacity)).toEqual({ action: 'ok' });
    expect(decideCompaction(85_000, capacity).action).toBe('warn');
    expect(decideCompaction(93_000, capacity).action).toBe('compact');
    expect(decideCompaction(99_000, capacity).action).toBe('abort');
  });

  it('honours custom thresholds', () => {
    const d = decideCompaction(60_000, 100_000, { warnAt: 0.5, compactAt: 0.55, abortAt: 0.99 });
    expect(d.action).toBe('compact');
  });

  it('compactIfNeeded compacts and marks context when threshold crossed', async () => {
    const result = await compactIfNeeded({
      usedTokens: 95_000,
      capacity: 100_000,
      history: ['User: build a todo app', 'Assistant: ok, using Postgres'],
      config: {
        apiKey: 'sk-test',
        provider: 'openrouter',
        
        proModel: 'openai/gpt-5.3-chat',
        fastModel: 'openai/gpt-5.3-chat',
      },
    });
    expect(result.compacted).toBe(true);
    expect(result.decision.action).toBe('compact');
    expect(result.context).toContain('Compacted Continuation Summary');
    expect(result.context).toContain('compaction-note');
  });

  it('compactIfNeeded passes history through when under threshold', async () => {
    const result = await compactIfNeeded({
      usedTokens: 30_000,
      capacity: 100_000,
      history: ['hello'],
      config: {
        apiKey: 'sk-test',
        provider: 'openrouter',
        
        proModel: 'openai/gpt-5.3-chat',
        fastModel: 'openai/gpt-5.3-chat',
      },
    });
    expect(result.compacted).toBe(false);
    expect(result.decision.action).toBe('ok');
    expect(result.context).toContain('hello');
  });

  it('empty history compacts to a no-context marker', async () => {
    const { summary } = await compactHistory([], {
      apiKey: 'sk-test',
      provider: 'openrouter',
      
      proModel: 'x',
      fastModel: 'x',
    });
    expect(summary).toBe('No prior context.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Elicitation queue (Codex elicitation + Kilo question tool)
// ─────────────────────────────────────────────────────────────────────────────

describe('elicitation', () => {
  let s: string;
  beforeEach(() => { s = session(); });

  it('parks a typed question and exposes it as pending', async () => {
    const el = await askElicitation(s, {
      question: 'Which auth scheme: JWT or session cookies?',
      reason: 'Determines the security pillar decisions',
      kind: 'choose',
      options: ['JWT', 'Session cookies'],
      autoDenyMs: 60_000,
    });
    expect(el.status).toBe('pending');
    const pending = await pendingElicitations(s);
    expect(pending.has_pending).toBe(true);
    expect(pending.elicitations[0]!.question).toBe(el.question);
  });

  it('answers move elicitations to history and clear pending', async () => {
    const el = await askElicitation(s, { question: 'Q?', reason: 'r' });
    const answered = await answerElicitations(s, [{ id: el.id, answer: 'JWT' }]);
    expect(answered[0]!.status).toBe('answered');
    const pending = await pendingElicitations(s);
    expect(pending.has_pending).toBe(false);
    const history = await listElicitationHistory(s);
    expect(history.some(h => h.answer === 'JWT')).toBe(true);
  });

  it('drainPendingElicitations clears the queue', async () => {
    await askElicitation(s, { question: 'Q1', reason: 'r1' });
    await askElicitation(s, { question: 'Q2', reason: 'r2' });
    const drained = await drainPendingElicitations(s);
    expect(drained).toHaveLength(2);
    expect((await pendingElicitations(s)).has_pending).toBe(false);
  });

  it('auto-denies questions whose deadline elapsed', async () => {
    const el = await askElicitation(s, { question: 'Q', reason: 'r', autoDenyMs: -1000 });
    const { elicitations, has_pending } = await pendingElicitations(s);
    expect(has_pending).toBe(false);
    expect(elicitations).toHaveLength(0);
    const history = await listElicitationHistory(s);
    expect(history[0]!.status).toBe('denied');
    expect(history[0]!.denied_reason).toMatch(/deadline/);
    expect(history[0]!.id).toBe(el.id);
  });

  it('formatElicitations produces spliceable context', () => {
    const ctx = formatElicitations([{
      id: 'x', session: 's', asked_at: 't', question: 'Which DB?',
      reason: 'r', kind: 'choose', options: [], fallback: 'f',
      deadline: null, status: 'answered', answer: 'Postgres', denied_reason: null,
    }]);
    expect(ctx).toContain('Which DB?');
    expect(ctx).toContain('Postgres');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Permission tiers (Codex execpolicy + Kilo permission)
// ─────────────────────────────────────────────────────────────────────────────

describe('permissionRegistry', () => {
  let s: string;
  beforeEach(() => { s = session(); });

  it('defaults every operation to full-auto', () => {
    for (const tier of Object.values(DEFAULT_OPERATION_TIERS)) {
      expect(tier).toBe('full-auto');
    }
  });

  it('resolves default tier with no overrides', async () => {
    expect(await resolveTier(s, 'generate')).toBe('full-auto');
  });

  it('session overrides beat defaults', async () => {
    await setOperationTier(s, 'undo', 'ask');
    expect(await resolveTier(s, 'undo')).toBe('ask');
    // other sessions unaffected
    expect(await resolveTier(session(), 'undo')).toBe('full-auto');
  });

  it('deny blocks the operation', async () => {
    await setOperationTier(s, 'repair', 'deny');
    const { decision } = await decidePermission(s, 'repair');
    expect(decision).toBe('denied');
  });

  it('listEffectiveTiers merges session over defaults', async () => {
    await setOperationTier(s, 'plan', 'ask');
    const tiers = await listEffectiveTiers(s);
    const plan = tiers.find(t => t.operation === 'plan');
    expect(plan?.tier).toBe('ask');
    expect(tiers).toHaveLength(Object.keys(DEFAULT_OPERATION_TIERS).length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Quality ledger + drift (OpenDesign ratchet)
// ─────────────────────────────────────────────────────────────────────────────

describe('qualityLedger', () => {
  let s: string;
  beforeEach(() => { s = session(); });

  it('records rounds and reports them ordered', async () => {
    await recordVerifierRound({ session: s, pipeline: 'blueprint', round: 1, composite: 72, mustFix: 1, verdict: 'repair', scores: [] });
    await recordVerifierRound({ session: s, pipeline: 'blueprint', round: 2, composite: 85, mustFix: 0, verdict: 'ship', scores: [] });
    const ledger = await listLedger({ session: s, pipeline: 'blueprint' });
    expect(ledger).toHaveLength(2);
    expect(ledger[0]!.round).toBe(1);
  });

  it('highWaterMark tracks the best composite', async () => {
    await recordVerifierRound({ session: s, pipeline: 'bp', round: 1, composite: 88, mustFix: 0, verdict: 'ship', scores: [] });
    await recordVerifierRound({ session: s, pipeline: 'bp', round: 2, composite: 82, mustFix: 0, verdict: 'ship', scores: [] });
    expect(await highWaterMark({ session: s, pipeline: 'bp' })).toBe(88);
  });

  it('detectDrift flags regression below the ratchet minus tolerance', () => {
    const drifted = detectDrift(80, 88, { tolerance: 5, priorEntries: 2 });
    expect(drifted.drifted).toBe(true);
    expect(drifted.decline).toBe(8);

    const stable = detectDrift(84, 88, { tolerance: 5, priorEntries: 2 });
    expect(stable.drifted).toBe(false);
  });

  it('summarizeLedger computes stats', async () => {
    await recordVerifierRound({ session: s, pipeline: 'bp2', round: 1, composite: 70, mustFix: 1, verdict: 'repair', scores: [] });
    await recordVerifierRound({ session: s, pipeline: 'bp2', round: 2, composite: 90, mustFix: 0, verdict: 'ship', scores: [] });
    const summary = summarizeLedger(await listLedger({ session: s, pipeline: 'bp2' }));
    expect(summary.bestComposite).toBe(90);
    expect(summary.shippedRounds).toBe(1);
    expect(summary.averageComposite).toBe(80);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Run summary telemetry (Kilo Code kilo-telemetry)
// ─────────────────────────────────────────────────────────────────────────────

describe('runSummary', () => {
  let s: string;
  beforeEach(() => { s = session(); });

  it('opens and closes a run record with computed cost', async () => {
    const id = await recordRunStart({ session: s, pipeline: 'blueprint', model: 'anthropic/claude-4.6-sonnet' });
    const closed = await recordRunEnd({
      session: s,
      runId: id,
      status: 'success',
      tokens_used: 1_000_000,
      verifier_composite: 85,
      verifier_verdict: 'ship',
      verifier_rounds: 2,
    });
    expect(closed).not.toBeNull();
    expect(closed!.duration_ms).toBeGreaterThanOrEqual(0);
    expect(closed!.cost_estimated).toBe(true);
    expect(closed!.estimated_cost_usd).toBeGreaterThan(0);
    expect(closed!.verifier_composite).toBe(85);
  });

  it('unknown models record null cost with cost_estimated=false', async () => {
    const id = await recordRunStart({ session: s, pipeline: 'bp', model: 'unknown/model' });
    const closed = await recordRunEnd({ session: s, runId: id, status: 'success', tokens_used: 500 });
    expect(closed!.estimated_cost_usd).toBeNull();
    expect(closed!.cost_estimated).toBe(false);
  });

  it('listRunSummaries returns session runs newest first', async () => {
    const a = await recordRunStart({ session: s, pipeline: 'bp', model: 'm' });
    await recordRunEnd({ session: s, runId: a, status: 'success', tokens_used: 10 });
    const b = await recordRunStart({ session: s, pipeline: 'bp', model: 'm' });
    await recordRunEnd({ session: s, runId: b, status: 'aborted', tokens_used: 5 });
    const list = await listRunSummaries(s);
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe(b);
    expect(list[1]!.id).toBe(a);
  });
});
