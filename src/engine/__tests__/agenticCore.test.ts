/**
 * src/engine/__tests__/agenticCore.test.ts
 *
 * Unit tests for the shared Agentic Core primitives — the turn runner,
 * composite verdict engine, stage snapshots, sub-agent supervisor, and the
 * verifier repair loop. All engine dependencies (OpenRouter, checkpoint
 * store) are mocked so these tests exercise the pure logic at unit speed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../engine/openrouter', () => ({
  generateText: vi.fn(),
  generateJson: vi.fn(),
}));

const checkpointStore = new Map<string, unknown>();
vi.mock('../../engine/checkpoint', () => ({
  saveCheckpoint: vi.fn(async (session: string, key: string, value: unknown) => {
    checkpointStore.set(`${session}:${key}`, value);
  }),
  loadCheckpoint: vi.fn(async (session: string, key: string) =>
    (checkpointStore.get(`${session}:${key}`) ?? null) as never
  ),
  checkpointExists: vi.fn(async (session: string, key: string) =>
    checkpointStore.has(`${session}:${key}`)
  ),
}));

vi.mock('../../engine/withRetry', async importOriginal => {
  const actual = await importOriginal<typeof import('../../engine/withRetry')>();
  return {
    ...actual,
    withRetry: vi.fn(async <T>(fn: (attempt: number) => Promise<T>, _signal?: AbortSignal) => fn(1)) as never,
  };
});

import {
  computeComposite, decideVerdict, selectFallbackRound, roleScore,
  runTurn, captureStageSnapshot, listStageSnapshots, undoLatestStage,
  runSupervisor, runVerifier, resolvePipelineDefaults,
} from '../agenticCore';
import type { VerdictConfig, FallbackPolicy as _FallbackPolicy, TurnStep } from '../agenticCore';

beforeEach(() => checkpointStore.clear());
afterEach(() => vi.restoreAllMocks());

// ── 1. Composite verdict engine (OpenDesign pattern) ────────────────────────

describe('composite verdict engine', () => {
  const weights = { accuracy: 2, clarity: 1, rigour: 1 };

  it('scores a full panel against the threshold', () => {
    const scores = [
      roleScore('Accuracy', 90, weights.accuracy),
      roleScore('Clarity', 70, weights.clarity),
      roleScore('Rigour', 80, weights.rigour),
    ];
    // (2*90 + 1*70 + 1*80) / 4 = 82.5
    expect(computeComposite(scores)).toBeCloseTo(82.5);
    const cfg: VerdictConfig = { scoreThreshold: 80, maxMustFix: 0 };
    expect(decideVerdict(82.5, 0, cfg)).toBe('ship');
    expect(decideVerdict(79, 0, cfg)).toBe('repair');
  });

  it('re-normalises weights when a role panel is partial', () => {
    const scores = [roleScore('Accuracy', 80, 2)]; // only one role present
    expect(computeComposite(scores)).toBe(80);
  });

  it('fails must-fix blockers even when composite passes', () => {
    const cfg: VerdictConfig = { scoreThreshold: 80, maxMustFix: 0 };
    expect(decideVerdict(95, 1, cfg)).toBe('repair');
  });

  it('allows mustFix within tolerance', () => {
    const cfg: VerdictConfig = { scoreThreshold: 80, maxMustFix: 1 };
    expect(decideVerdict(95, 1, cfg)).toBe('ship');
  });

  it('ships the best round under ship_best policy', () => {
    const rounds = [
      { n: 1, composite: 70, mustFix: 0, scores: [] },
      { n: 2, composite: 88, mustFix: 0, scores: [] },
      { n: 3, composite: 82, mustFix: 0, scores: [] },
    ];
    expect(selectFallbackRound(rounds, 'ship_best')?.n).toBe(2);
    expect(selectFallbackRound(rounds, 'ship_last')?.n).toBe(3);
    expect(selectFallbackRound(rounds, 'fail')).toBeNull();
  });

  it('falls back to the last round under ship_last', () => {
    const rounds = [
      { n: 1, composite: 99, mustFix: 0, scores: [] },
      { n: 2, composite: 40, mustFix: 0, scores: [] },
    ];
    expect(selectFallbackRound(rounds, 'ship_last')?.n).toBe(2);
  });

  it('ties break by most recent round', () => {
    const rounds = [
      { n: 1, composite: 80, mustFix: 0, scores: [] },
      { n: 2, composite: 80, mustFix: 0, scores: [] },
    ];
    expect(selectFallbackRound(rounds, 'ship_best')?.n).toBe(2);
  });
});

// ── 2. Turn runner with budgets (Codex pattern) ─────────────────────────────

describe('runTurn', () => {
  it('executes every step and aggregates tokens', async () => {
    const steps: TurnStep<{ tokens_used: number }>[] = [
      { key: 'a', label: 'A', run: async () => ({ tokens_used: 100 }), verify: () => ({ ok: true }) },
      { key: 'b', label: 'B', run: async () => ({ tokens_used: 200 }) },
    ];
    const out = await runTurn(steps, { budget: { maxSteps: 64, maxTokens: 10_000 } });
    expect(out.status).toBe('done');
    expect(out.steps).toBe(2);
    expect(out.tokens).toBe(300);
    expect(out.results.get('a')).toBeTruthy();
  });

  it('fails the turn when a step throws after retries', async () => {
    const { withRetry } = await import('../../engine/withRetry');
    (withRetry as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => { throw new Error('step boom'); },
    );
    const out = await runTurn([{ key: 'x', label: 'X', run: async () => ({ tokens_used: 0 }) }]);
    expect(out.status).toBe('failed');
    expect(out.failedStep).toBe('x');
  });

  it('fails the turn when per-step verification fails', async () => {
    const out = await runTurn([
      { key: 'v', label: 'V', run: async () => ({ tokens_used: 5 }), verify: () => ({ ok: false, reason: 'bad' }) },
    ]);
    expect(out.status).toBe('failed');
    expect(out.failedStep).toBe('v');
  });

  it('honours the step budget and emits budget.exceeded', async () => {
    const events: unknown[] = [];
    const out = await runTurn(
      [{ key: 's', label: 'S', run: async () => ({ tokens_used: 1 }) }],
      { emit: e => events.push(e), budget: { maxSteps: 1 } },
    );
    expect(out.status).toBe('budget_exceeded');
    expect(events.some(e => (e as { type: string }).type === 'budget.exceeded')).toBe(true);
  });

  it('honours the token budget across steps', async () => {
    // Tokens are checked at step boundaries; once the running total reaches
    // the cap the turn stops before executing the next step (guard step).
    let call = 0;
    const out = await runTurn(
      [
        { key: 't1', label: 'T1', run: async () => { call += 1; return { tokens_used: 30 }; } },
        { key: 't2', label: 'T2', run: async () => { call += 1; return { tokens_used: 30 }; } },
      ],
      { budget: { maxTokens: 30 } },
    );
    // t1 finishes and brings the total to 30; the guard fires before t2
    // because accumulated tokens (30) have reached the cap (30).
    expect(out.status).toBe('budget_exceeded');
    expect(out.results.has('t1')).toBe(true);
    expect(out.results.has('t2')).toBe(false);
    expect(call).toBe(1);
  });

  it('aborts immediately when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await runTurn([{ key: 'k', label: 'K', run: async () => ({ tokens_used: 0 }) }], { signal: controller.signal });
    expect(out.status).toBe('aborted');
  });
});

// ── 3. Stage snapshots with undo (Kilo Code pattern) ────────────────────────

describe('stage snapshots', () => {
  it('captures, lists, and undoes snapshots in sequence order', async () => {
    const s1 = await captureStageSnapshot('sess1', 'synthesized', { sections: ['a'] });
    const s2 = await captureStageSnapshot('sess1', 'verifier', { verdict: 'repair' });
    expect(s2.sequence).toBeGreaterThan(s1.sequence);

    const listed = await listStageSnapshots('sess1');
    expect(listed).toHaveLength(2);
    expect(listed.map(x => x.stage)).toEqual(['synthesized', 'verifier']);

    const undone = await undoLatestStage('sess1');
    expect(undone?.stage).toBe('verifier');
    expect(await listStageSnapshots('sess1')).toHaveLength(1);
  });

  it('returns null when there is nothing to undo', async () => {
    expect(await undoLatestStage('empty-sess')).toBeNull();
  });
});

// ── 4. Sub-agent supervisor (Kimi + OpenCode pattern) ───────────────────────

describe('runSupervisor', () => {
  it('aggregates all sub-agent outcomes without aborting on partial failure', async () => {
    const { withRetry } = await import('../../engine/withRetry');
    (withRetry as ReturnType<typeof vi.fn>)
      // first task succeeds
      .mockImplementationOnce(async fn => fn(1))
      // second task fails after retries
      .mockImplementationOnce(async () => { throw new Error('sub-agent boom'); });

    const res = await runSupervisor<string>(
      [
        { key: 'p1', run: async () => ({ result: 'done', tokens_used: 10 } as never) },
        { key: 'p2', run: async () => ({ result: 'done', tokens_used: 5 } as never) },
      ],
      { parent: 'root' },
    );
    expect(res.succeeded).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.results[0]?.status).toBe('done');
    expect(res.results[1]?.status).toBe('failed');
  });

  it('emits subagent.started/done events for each task', async () => {
    const { withRetry } = await import('../../engine/withRetry');
    (withRetry as ReturnType<typeof vi.fn>).mockImplementation(async fn => fn(1));
    const events: unknown[] = [];
    await runSupervisor(
      [{ key: 'q', run: async () => 'ok' }],
      { emit: e => events.push(e), parent: 'r' },
    );
    const types = events.map(e => (e as { type: string }).type);
    expect(types).toContain('subagent.started');
    expect(types).toContain('subagent.done');
  });

  it('aborts all tasks when the supervisor signal aborts', async () => {
    // Aborting the supervisor aborts pending tasks; a task that is already
    // executing must honor its derived signal, which is why the run below
    // throws AbortError when signalled.
    const controller = new AbortController();
    controller.abort();
    const res = await runSupervisor(
      [
        { key: 'k1', run: async () => 'ok' },
        { key: 'k2', run: async ({ signal }) => { if (signal?.aborted) throw new DOMException('aborted', 'AbortError'); return 'late'; } },
      ],
      { signal: controller.signal },
    );
    const statuses = res.results.map(r => r.status);
    expect(statuses).toContain('aborted');
    expect(res.failed).toBeGreaterThan(0);
  });
});

// ── 5. Verifier repair loop (Codex validate-then-repair + OpenDesign) ───────

describe('runVerifier', () => {
  const cfg = { scoreThreshold: 80, maxMustFix: 0, maxRounds: 3 };

  it('ships the first candidate when it already passes the gate', async () => {
    const result = await runVerifier<{ qualityScore: number }>(
      { qualityScore: 90 },
      {
        cfg,
        review: async () => ({ scores: [roleScore('Quality', 90, 1)], mustFix: 0, tokens_used: 50 }),
        repair: async (_r, c) => ({ candidate: c, tokens_used: 0 }),
      },
    );
    expect(result.verdict).toBe('ship');
    expect(result.rounds).toHaveLength(1);
    expect(result.tokens_used).toBe(50);
  });

  it('repairs until the gate passes within the round budget', async () => {
    let call = 0;
    const result = await runVerifier<{ qualityScore: number }>(
      { qualityScore: 60 },
      {
        cfg,
        review: async (_n, c) => ({
          scores: [roleScore('Quality', c.qualityScore, 1)],
          mustFix: c.qualityScore < 80 ? 1 : 0,
          tokens_used: 30,
        }),
        repair: async () => {
          call += 1;
          return { candidate: { qualityScore: 60 + call * 15 }, tokens_used: 100 };
        },
      },
    );
    expect(result.verdict).toBe('ship');
    // round1: 60 fails → repair to 75; round2: 75 fails → repair to 90; round3: 90 ships
    expect(result.final.qualityScore).toBe(90);
    expect(result.rounds).toHaveLength(3);
    expect(result.tokens_used).toBe(30 * 3 + 100 * 2); // 3 reviews + 2 repairs
  });

  it('falls back per policy when the budget is exhausted', async () => {
    const result = await runVerifier<{ qualityScore: number }>(
      { qualityScore: 30 },
      {
        cfg: { scoreThreshold: 80, maxMustFix: 0, maxRounds: 2, fallbackPolicy: 'fail' },
        review: async (_n, c) => ({
          scores: [roleScore('Quality', c.qualityScore, 1)],
          mustFix: 1,
          tokens_used: 20,
        }),
        repair: async () => ({ candidate: { qualityScore: 40 }, tokens_used: 60 }),
      },
    );
    expect(result.verdict).toBe('fail');
    expect(result.rounds).toHaveLength(2);
  });

  it('emits verdict lifecycle events for each round', async () => {
    const events: unknown[] = [];
    await runVerifier<{ q: number }>(
      { q: 90 },
      {
        cfg,
        review: async () => ({ scores: [roleScore('Q', 90, 1)], mustFix: 0 }),
        repair: async (_r, c) => ({ candidate: c }),
        emit: e => events.push(e),
      },
    );
    const types = events.map(e => (e as { type: string }).type);
    expect(types).toContain('verdict.round.start');
    expect(types).toContain('verdict.issued');
    expect(types).toContain('verdict.shipped');
  });
});

// ── 6. Defaults registry ────────────────────────────────────────────────────

describe('resolvePipelineDefaults', () => {
  it('returns per-pipeline defaults', () => {
    expect(resolvePipelineDefaults('tool-builder').verdict.scoreThreshold).toBe(85);
    expect(resolvePipelineDefaults('feature-creator').verdict.scoreThreshold).toBe(75);
  });

  it('falls back to blueprint defaults for unknown names', () => {
    expect(resolvePipelineDefaults('unknown-pipeline').name).toBe('blueprint');
  });
});
