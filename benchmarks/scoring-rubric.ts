/**
 * benchmarks/scoring-rubric.ts
 *
 * Blueprint quality scoring rubric for the benchmark harness (Part 8.2 — Addition 5).
 *
 * Scores blueprints on four dimensions:
 *   1. Completeness (0-25) — are all expected sections present and non-trivial?
 *   2. Specificity (0-25)  — are there concrete technology choices, not vague recommendations?
 *   3. Correctness (0-25)  — are technical recommendations sound? No contradictions?
 *   4. Implementation Clarity (0-25) — would a coding agent know exactly what to build?
 *
 * Total: 0-100 points.
 *
 * This rubric is used by benchmark.ts to score generated blueprints against
 * the baseline defined in reference-tasks.json.
 */

export interface ScoringContext {
  taskId: string;
  prompt: string;
  blueprint: {
    sections?: Record<string, string>;
    pillars?: Array<{
      pillar: string;
      agents?: Array<{ agent: string; content: string; tokens_used: number }>;
      summary?: { decisions?: unknown[]; schemas?: unknown[]; technical_constraints?: unknown[] };
    }>;
    quality_score?: number;
  };
  expectedSections: string[];
  requiredKeywords: string[];
  forbiddenPatterns: string[];
}

export interface ScoringResult {
  taskId: string;
  total: number;
  completeness: number;
  specificity: number;
  correctness: number;
  implementationClarity: number;
  findings: Finding[];
  passed: boolean;
  minimumScore: number;
}

interface Finding {
  dimension: 'completeness' | 'specificity' | 'correctness' | 'implementationClarity';
  severity: 'pass' | 'warn' | 'fail';
  message: string;
  points: number;
}

// ── Dimension scorers ──────────────────────────────────────────────────────

function scoreCompleteness(ctx: ScoringContext): { score: number; findings: Finding[] } {
  const findings: Finding[] = [];
  let score = 25;

  const sections = ctx.blueprint.sections ?? {};
  const sectionKeys = Object.keys(sections);

  for (const expected of ctx.expectedSections) {
    const found = sectionKeys.some(k =>
      k.toLowerCase().includes(expected.toLowerCase()) ||
      expected.toLowerCase().includes(k.toLowerCase())
    );

    if (!found) {
      const deduction = 4;
      score -= deduction;
      findings.push({
        dimension: 'completeness',
        severity: 'fail',
        message: `Missing expected section: "${expected}"`,
        points: -deduction,
      });
    } else {
      const content = sections[expected] ?? sections[sectionKeys.find(k =>
        k.toLowerCase().includes(expected.toLowerCase())
      )!];
      if (!content || content.length < 100) {
        const deduction = 2;
        score -= deduction;
        findings.push({
          dimension: 'completeness',
          severity: 'warn',
          message: `Section "${expected}" is present but thin (< 100 chars)`,
          points: -deduction,
        });
      } else {
        findings.push({
          dimension: 'completeness',
          severity: 'pass',
          message: `Section "${expected}" present (${content.length} chars)`,
          points: 0,
        });
      }
    }
  }

  // Check pillar coverage
  const pillars = ctx.blueprint.pillars ?? [];
  if (pillars.length === 0) {
    score -= 5;
    findings.push({
      dimension: 'completeness',
      severity: 'fail',
      message: 'No pillars present in blueprint',
      points: -5,
    });
  } else if (pillars.length < 4) {
    score -= 2;
    findings.push({
      dimension: 'completeness',
      severity: 'warn',
      message: `Only ${pillars.length} pillars (expected ≥ 6)`,
      points: -2,
    });
  }

  return { score: Math.max(0, score), findings };
}

function scoreSpecificity(ctx: ScoringContext): { score: number; findings: Finding[] } {
  const findings: Finding[] = [];
  let score = 25;

  const allContent = Object.values(ctx.blueprint.sections ?? {}).join('\n').toLowerCase();

  // Check required keywords are present
  for (const keyword of ctx.requiredKeywords) {
    if (!allContent.includes(keyword.toLowerCase())) {
      const deduction = 2;
      score -= deduction;
      findings.push({
        dimension: 'specificity',
        severity: 'warn',
        message: `Required keyword not found: "${keyword}"`,
        points: -deduction,
      });
    } else {
      findings.push({
        dimension: 'specificity',
        severity: 'pass',
        message: `Required keyword present: "${keyword}"`,
        points: 0,
      });
    }
  }

  // Check for concrete technology names (specificity indicators)
  const techIndicators = [
    /postgresql|mysql|mongodb|redis|elasticsearch|clickhouse/i,
    /react|vue|angular|nextjs|svelte/i,
    /express|fastapi|django|rails|nest\.?js/i,
    /docker|kubernetes|aws|gcp|azure|cloudflare/i,
    /jwt|oauth|saml|passkeys|webauthn/i,
    /stripe|twilio|sendgrid|datadog|sentry/i,
  ];

  const techMatches = techIndicators.filter(re => re.test(allContent)).length;
  if (techMatches < 2) {
    score -= 5;
    findings.push({
      dimension: 'specificity',
      severity: 'fail',
      message: `Low technology specificity — only ${techMatches}/${techIndicators.length} tech categories mentioned`,
      points: -5,
    });
  } else if (techMatches < 4) {
    score -= 2;
    findings.push({
      dimension: 'specificity',
      severity: 'warn',
      message: `Medium technology specificity — ${techMatches}/${techIndicators.length} tech categories mentioned`,
      points: -2,
    });
  } else {
    findings.push({
      dimension: 'specificity',
      severity: 'pass',
      message: `Good technology specificity — ${techMatches}/${techIndicators.length} tech categories mentioned`,
      points: 0,
    });
  }

  // Penalise vague language
  const vaguePatterns = [
    /appropriate\s+(technology|solution|approach)/i,
    /consider\s+using/i,
    /depending\s+on\s+(your|the)\s+needs/i,
    /various\s+options/i,
    /can\s+be\s+implemented/i,
    /it\s+is\s+recommended\s+to\s+possibly/i,
  ];
  const vagueMatches = vaguePatterns.filter(re => re.test(allContent)).length;
  if (vagueMatches > 3) {
    score -= 3;
    findings.push({
      dimension: 'specificity',
      severity: 'warn',
      message: `${vagueMatches} instances of vague language detected`,
      points: -3,
    });
  }

  return { score: Math.max(0, score), findings };
}

function scoreCorrectness(ctx: ScoringContext): { score: number; findings: Finding[] } {
  const findings: Finding[] = [];
  let score = 25;

  const allContent = Object.values(ctx.blueprint.sections ?? {}).join('\n');

  // Check for forbidden patterns (placeholders, incomplete sections)
  for (const pattern of ctx.forbiddenPatterns) {
    const re = new RegExp(pattern, 'gi');
    const matches = allContent.match(re) ?? [];
    if (matches.length > 0) {
      const deduction = Math.min(5, matches.length * 2);
      score -= deduction;
      findings.push({
        dimension: 'correctness',
        severity: 'fail',
        message: `Forbidden pattern "${pattern}" found ${matches.length} time(s)`,
        points: -deduction,
      });
    }
  }

  // Check for internal contradictions (basic heuristic)
  const contradictionPairs: Array<[RegExp, RegExp]> = [
    [/stateless/i, /session-based state/i],
    [/no database/i, /database schema/i],
    [/single-tenant/i, /multi-tenant/i],
    [/no authentication/i, /jwt\s+token/i],
  ];

  for (const [termA, termB] of contradictionPairs) {
    if (termA.test(allContent) && termB.test(allContent)) {
      score -= 3;
      findings.push({
        dimension: 'correctness',
        severity: 'warn',
        message: `Potential contradiction detected: "${termA.source}" vs "${termB.source}"`,
        points: -3,
      });
    }
  }

  // Security correctness checks
  if (ctx.requiredKeywords.some(k => /hipaa|pci|sox/i.test(k))) {
    if (!/encryption/i.test(allContent)) {
      score -= 5;
      findings.push({
        dimension: 'correctness',
        severity: 'fail',
        message: 'Compliance-sensitive app missing encryption specification',
        points: -5,
      });
    }
    if (!/audit/i.test(allContent)) {
      score -= 3;
      findings.push({
        dimension: 'correctness',
        severity: 'warn',
        message: 'Compliance-sensitive app missing audit logging specification',
        points: -3,
      });
    }
  }

  return { score: Math.max(0, score), findings };
}

function scoreImplementationClarity(ctx: ScoringContext): { score: number; findings: Finding[] } {
  const findings: Finding[] = [];
  let score = 25;

  const allContent = Object.values(ctx.blueprint.sections ?? {}).join('\n');
  const wordCount = allContent.split(/\s+/).length;

  // Minimum viable content check
  if (wordCount < 500) {
    score -= 10;
    findings.push({
      dimension: 'implementationClarity',
      severity: 'fail',
      message: `Blueprint too thin — only ${wordCount} words (minimum: 500)`,
      points: -10,
    });
  } else if (wordCount < 1000) {
    score -= 5;
    findings.push({
      dimension: 'implementationClarity',
      severity: 'warn',
      message: `Blueprint has low word count — ${wordCount} words (recommended: ≥ 1000)`,
      points: -5,
    });
  } else {
    findings.push({
      dimension: 'implementationClarity',
      severity: 'pass',
      message: `Good content volume — ${wordCount} words`,
      points: 0,
    });
  }

  // Check for actionable implementation indicators
  const actionablePatterns = [
    { re: /\bCREATE TABLE\b|\bALTER TABLE\b|\bCREATE INDEX\b/i, label: 'SQL schema' },
    { re: /\bPOST\s+\/|GET\s+\/|PUT\s+\/|PATCH\s+\/|DELETE\s+\//i, label: 'API endpoint definitions' },
    { re: /\binterface\s+\w+|type\s+\w+\s*=/i, label: 'TypeScript types' },
    { re: /\bdocker|dockerfile|kubernetes|helm\b/i, label: 'deployment config' },
    { re: /\bcurl\s+-|fetch\(|axios\./i, label: 'code examples' },
  ];

  let actionableCount = 0;
  for (const { re, label } of actionablePatterns) {
    if (re.test(allContent)) {
      actionableCount++;
      findings.push({
        dimension: 'implementationClarity',
        severity: 'pass',
        message: `Found actionable content: ${label}`,
        points: 0,
      });
    }
  }

  if (actionableCount < 2) {
    score -= 5;
    findings.push({
      dimension: 'implementationClarity',
      severity: 'warn',
      message: `Low actionability — only ${actionableCount}/${actionablePatterns.length} implementation artifact types found`,
      points: -5,
    });
  }

  // Check for numbered/ordered implementation steps (shows a coding agent can follow it)
  const hasOrderedSteps = /\b\d+\.\s+\w+|\bStep\s+\d+:/i.test(allContent);
  if (!hasOrderedSteps) {
    score -= 2;
    findings.push({
      dimension: 'implementationClarity',
      severity: 'warn',
      message: 'No ordered implementation steps found — coding agents benefit from step sequences',
      points: -2,
    });
  }

  return { score: Math.max(0, score), findings };
}

// ── Main scorer ────────────────────────────────────────────────────────────

/**
 * Score a blueprint against the rubric.
 *
 * @param ctx - The scoring context including the blueprint and task metadata
 * @param minimumScore - The minimum passing score for this task
 */
export function scoreBlueprint(ctx: ScoringContext, minimumScore: number): ScoringResult {
  const completenessResult = scoreCompleteness(ctx);
  const specificityResult = scoreSpecificity(ctx);
  const correctnessResult = scoreCorrectness(ctx);
  const clarityResult = scoreImplementationClarity(ctx);

  const total =
    completenessResult.score +
    specificityResult.score +
    correctnessResult.score +
    clarityResult.score;

  const allFindings = [
    ...completenessResult.findings,
    ...specificityResult.findings,
    ...correctnessResult.findings,
    ...clarityResult.findings,
  ];

  return {
    taskId: ctx.taskId,
    total,
    completeness: completenessResult.score,
    specificity: specificityResult.score,
    correctness: correctnessResult.score,
    implementationClarity: clarityResult.score,
    findings: allFindings,
    passed: total >= minimumScore,
    minimumScore,
  };
}

/**
 * Compare a current score against a baseline. Returns true if no dimension
 * has regressed by more than 5 points.
 */
export function detectRegression(
  current: ScoringResult,
  baseline: Record<string, number>,
  regressionThreshold = 5,
): { regressed: boolean; regressions: Array<{ dimension: string; current: number; baseline: number; delta: number }> } {
  const regressions: Array<{ dimension: string; current: number; baseline: number; delta: number }> = [];

  const dimensions: Array<keyof typeof baseline> = ['completeness', 'specificity', 'correctness', 'implementationClarity'];

  for (const dim of dimensions) {
    const baselineScore = baseline[dim] ?? 0;
    const currentScore = current[dim as keyof ScoringResult] as number;
    const delta = baselineScore - currentScore;

    if (delta > regressionThreshold) {
      regressions.push({ dimension: dim, current: currentScore, baseline: baselineScore, delta });
    }
  }

  return { regressed: regressions.length > 0, regressions };
}
