#!/usr/bin/env tsx
/**
 * benchmarks/benchmark.ts
 *
 * Pipeline Benchmark Harness (Part 8.2 — Addition 5)
 *
 * Runs all reference tasks, scores them against the rubric, compares against
 * baselines, and fails if any score regresses by more than 5 points.
 *
 * Usage:
 *   npx tsx benchmarks/benchmark.ts [--task task-001] [--dry-run]
 *
 * Environment variables required:
 *   OPENROUTER_API_KEY — API key for the AI provider
 *
 * Options:
 *   --task <id>     Run only a specific task (e.g. --task task-001)
 *   --dry-run       Skip AI calls; score existing fixtures in benchmarks/fixtures/
 *   --update-baseline  Update the baseline scores from the current run results
 *   --parallel <n>  Run N tasks concurrently (default: 1 to avoid rate limits)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { scoreBlueprint, detectRegression, type ScoringContext } from './scoring-rubric';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ReferenceTask {
  id: string;
  name: string;
  complexity: string;
  prompt: string;
  expectedSections: string[];
  minimumQualityScore: number;
  scoreBaseline: Record<string, number>;
  requiredKeywords: string[];
  forbiddenPatterns: string[];
}

interface BenchmarkResult {
  taskId: string;
  taskName: string;
  complexity: string;
  scoring: ReturnType<typeof scoreBlueprint>;
  regression: ReturnType<typeof detectRegression>;
  durationMs: number;
  error?: string;
}

interface BenchmarkReport {
  runAt: string;
  totalTasks: number;
  passed: number;
  failed: number;
  regressions: number;
  results: BenchmarkResult[];
  summary: string;
}

function parseArgs(): { taskFilter?: string; dryRun: boolean; updateBaseline: boolean; parallel: number } {
  const args = process.argv.slice(2);
  let taskFilter: string | undefined;
  let dryRun = false;
  let updateBaseline = false;
  let parallel = 1;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--task' && args[i + 1]) taskFilter = args[++i];
    if (args[i] === '--dry-run') dryRun = true;
    if (args[i] === '--update-baseline') updateBaseline = true;
    if (args[i] === '--parallel' && args[i + 1]) parallel = parseInt(args[++i]!, 10);
  }

  return { taskFilter, dryRun, updateBaseline, parallel: Math.max(1, parallel) };
}

function loadReferenceTasks(): ReferenceTask[] {
  const tasksPath = path.join(__dirname, 'reference-tasks.json');
  const raw = fs.readFileSync(tasksPath, 'utf-8');
  return JSON.parse(raw) as ReferenceTask[];
}

function loadFixture(taskId: string): any | null {
  const fixturePath = path.join(__dirname, 'fixtures', `${taskId}.json`);
  if (!fs.existsSync(fixturePath)) return null;
  return JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
}

function saveFixture(taskId: string, blueprint: any): void {
  const fixturesDir = path.join(__dirname, 'fixtures');
  if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixturesDir, `${taskId}.json`),
    JSON.stringify(blueprint, null, 2),
    'utf-8',
  );
}

async function runTask(
  task: ReferenceTask,
  dryRun: boolean,
): Promise<{ blueprint: any; durationMs: number }> {
  const start = Date.now();

  if (dryRun) {
    const fixture = loadFixture(task.id);
    if (fixture) {
      return { blueprint: fixture, durationMs: Date.now() - start };
    }
    // No fixture — return a mock empty blueprint for dry-run
    return {
      blueprint: { sections: {}, pillars: [] },
      durationMs: 0,
    };
  }

  // Dynamic import to avoid loading the full engine in dry-run mode
  const { generateBlueprint } = await import('../src/engine/index');
  const { resolveConfig } = await import('../src/engine/config');

  const config = resolveConfig({});
  const events: any[] = [];

  let blueprint: any = null;
  await generateBlueprint(
    task.prompt,
    config,
    (event: any) => {
      events.push(event);
      if (event.type === 'complete') blueprint = event.blueprint;
    },
    'fast',
  );

  if (!blueprint) {
    throw new Error('Blueprint generation did not produce a blueprint');
  }

  const durationMs = Date.now() - start;
  saveFixture(task.id, blueprint);

  return { blueprint, durationMs };
}

async function benchmarkTask(task: ReferenceTask, dryRun: boolean): Promise<BenchmarkResult> {
  console.log(`\n  [${task.id}] ${task.name} (${task.complexity})...`);

  const taskStart = Date.now();
  let blueprint: any = {};
  let error: string | undefined;

  try {
    const result = await runTask(task, dryRun);
    blueprint = result.blueprint;
    console.log(`    ✓ Generation complete (${result.durationMs}ms)`);
  } catch (err: any) {
    error = err?.message ?? 'Unknown error';
    console.error(`    ✗ Generation failed: ${error}`);
  }

  const ctx: ScoringContext = {
    taskId: task.id,
    prompt: task.prompt,
    blueprint,
    expectedSections: task.expectedSections,
    requiredKeywords: task.requiredKeywords,
    forbiddenPatterns: task.forbiddenPatterns,
  };

  const scoring = scoreBlueprint(ctx, task.minimumQualityScore);
  const regression = detectRegression(scoring, task.scoreBaseline);

  console.log(`    Score: ${scoring.total}/100 (minimum: ${task.minimumQualityScore}) — ${scoring.passed ? '✓ PASS' : '✗ FAIL'}`);
  if (regression.regressed) {
    console.warn(`    ⚠️  REGRESSION detected in: ${regression.regressions.map(r => `${r.dimension} (${r.baseline}→${r.current}, Δ${r.delta})`).join(', ')}`);
  }

  const failFindings = scoring.findings.filter(f => f.severity === 'fail');
  if (failFindings.length > 0) {
    for (const finding of failFindings.slice(0, 3)) {
      console.log(`    ✗ [${finding.dimension}] ${finding.message}`);
    }
  }

  return {
    taskId: task.id,
    taskName: task.name,
    complexity: task.complexity,
    scoring,
    regression,
    durationMs: Date.now() - taskStart,
    error,
  };
}

async function runBenchmark(): Promise<void> {
  const { taskFilter, dryRun, updateBaseline, parallel } = parseArgs();

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║         Atomic Blueprint Pipeline Benchmark            ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`Mode: ${dryRun ? 'DRY-RUN (fixtures only)' : 'LIVE (AI calls)'}`);
  console.log(`Parallelism: ${parallel}`);
  if (taskFilter) console.log(`Task filter: ${taskFilter}`);
  console.log('');

  let tasks = loadReferenceTasks();
  if (taskFilter) {
    tasks = tasks.filter(t => t.id === taskFilter || t.name === taskFilter);
    if (tasks.length === 0) {
      console.error(`Task "${taskFilter}" not found in reference-tasks.json`);
      process.exit(1);
    }
  }

  console.log(`Running ${tasks.length} benchmark task(s)...\n`);

  const results: BenchmarkResult[] = [];

  // Run in batches of `parallel`
  for (let i = 0; i < tasks.length; i += parallel) {
    const batch = tasks.slice(i, i + parallel);
    const batchResults = await Promise.all(batch.map(t => benchmarkTask(t, dryRun)));
    results.push(...batchResults);
  }

  // Update baselines if requested
  if (updateBaseline) {
    const updatedTasks = loadReferenceTasks().map(task => {
      const result = results.find(r => r.taskId === task.id);
      if (!result) return task;
      return {
        ...task,
        scoreBaseline: {
          completeness: result.scoring.completeness,
          specificity: result.scoring.specificity,
          correctness: result.scoring.correctness,
          implementationClarity: result.scoring.implementationClarity,
        },
      };
    });
    const tasksPath = path.join(__dirname, 'reference-tasks.json');
    fs.writeFileSync(tasksPath, JSON.stringify(updatedTasks, null, 2), 'utf-8');
    console.log('\n✓ Baseline scores updated in reference-tasks.json');
  }

  // Final report
  const passed = results.filter(r => r.scoring.passed && !r.error).length;
  const failed = results.length - passed;
  const regressions = results.filter(r => r.regression.regressed).length;
  const withErrors = results.filter(r => r.error).length;

  const report: BenchmarkReport = {
    runAt: new Date().toISOString(),
    totalTasks: results.length,
    passed,
    failed,
    regressions,
    results,
    summary: `${passed}/${results.length} tasks passed, ${regressions} regressions, ${withErrors} errors`,
  };

  // Write report
  const reportsDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `benchmark-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║                   Benchmark Summary                    ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log(`║  Tasks:       ${String(results.length).padEnd(40)}║`);
  console.log(`║  Passed:      ${String(passed).padEnd(40)}║`);
  console.log(`║  Failed:      ${String(failed).padEnd(40)}║`);
  console.log(`║  Regressions: ${String(regressions).padEnd(40)}║`);
  console.log(`║  Errors:      ${String(withErrors).padEnd(40)}║`);
  console.log(`║  Report:      ${reportPath.slice(-40).padEnd(40)}║`);
  console.log('╚════════════════════════════════════════════════════════╝');

  if (regressions > 0 || failed > 0) {
    console.log('\n✗ Benchmark FAILED — see report for details\n');
    process.exit(1);
  } else {
    console.log('\n✓ All benchmarks PASSED\n');
    process.exit(0);
  }
}

runBenchmark().catch(err => {
  console.error('Benchmark runner crashed:', err);
  process.exit(1);
});
