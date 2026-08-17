/**
 * src/plugins/engine/builtIns.ts
 *
 * Atomic built-in engine plugins. Built-ins are implicitly trusted
 * (see trust.ts `trustedPlugins`) and ship with a single stage that runs
 * through the same runtime as any third-party plugin — so their behaviour
 * is exercise-identical to user-installed plugins.
 *
 * Coverage mirrors OpenDesign's plugin kinds: reporter (cost-estimator,
 * quality-ledger-audit), reviewer (blueprint-reviewer).
 */
import type { EnginePluginManifest } from './schema';

export const BUILT_IN_PLUGINS: EnginePluginManifest[] = [
  {
    id: 'builtin:blueprint-reviewer',
    specVersion: '1.0.0',
    name: 'Blueprint Reviewer',
    version: '2.3.0',
    description:
      'Runs an additional verifier-repair round over a completed blueprint, scoring it on the shared 4-role panel and repairing the weakest sections.',
    author: 'Atomic',
    license: 'MIT',
    kind: 'reviewer',
    tags: ['quality', 'blueprint'],
    capabilities: ['blueprint:read'],
    inputs: [
      { name: 'focus', type: 'select', label: 'Review focus', required: true, options: ['full', 'security', 'edge-cases', 'integration'], default: 'full' },
    ],
    pipeline: {
      stages: [
        {
          id: 'review',
          kind: 'review',
          prompt: 'Review the provided blueprint (respecting the plugin inputs section — run the focus area deeply when given). Score it on the shared 4-role panel (Accuracy, Completeness, Actionability, Clarity). Report: (1) the four role scores, (2) any must-fix blockers, (3) a prioritised list of the weakest sections with concrete repair instructions. Be strict — the blueprint must survive production scrutiny.',
          max_tokens: 4000,
          repeat: true,
          until: 'composite>=85 || iterations>=2',
          max_iterations: 2,
        },
      ],
    },
    skippable: true,
  },
  {
    id: 'builtin:cost-estimator',
    specVersion: '1.0.0',
    name: 'Cost Estimator',
    version: '2.3.0',
    description:
      'Estimates token usage and cost for the current session run using the engine cost model, and reports per-run economics.',
    author: 'Atomic',
    license: 'MIT',
    kind: 'reporter',
    tags: ['cost', 'telemetry'],
    capabilities: [],
    inputs: [],
    pipeline: {
      stages: [
        {
          id: 'estimate',
          kind: 'report',
          prompt: 'Produce a short, structured cost/economics report for the session\'s pipeline run: estimated input vs output tokens (use a 70/30 input/output split if actual figures are unavailable), cost range across the common pro-models (GPT-5.x class, Claude Sonnet/Opus class, Gemini Pro class), and two concrete recommendations for lowering cost without losing quality (e.g. enabling the fast-model governor path, lowering repair rounds). Keep the report under 400 words and strictly factual.',
          max_tokens: 2000,
          repeat: false,
          max_iterations: 1,
        },
      ],
    },
    skippable: true,
  },
  {
    id: 'builtin:quality-ledger-audit',
    specVersion: '1.0.0',
    name: 'Quality Ledger Audit',
    version: '2.3.0',
    description:
      'Audits the session quality ledger: reports high-water marks, rolling averages, and any quality drift relative to the ratchet tolerance.',
    author: 'Atomic',
    license: 'MIT',
    kind: 'reporter',
    tags: ['quality', 'audit', 'drift'],
    capabilities: [],
    inputs: [
      { name: 'window', type: 'select', label: 'Audit window', required: true, options: ['last-5', 'last-10', 'all'], default: 'last-10' },
    ],
    pipeline: {
      stages: [
        {
          id: 'audit',
          kind: 'report',
          prompt: 'Audit the session\'s quality ledger over the configured window. Report: (1) the quality high-water mark, (2) rolling average composite, (3) whether the latest scores show drift below the ratchet tolerance, (4) a short action plan to recover quality if drift is detected. Cite the actual scores and verdicts recorded in the ledger. Keep it under 400 words.',
          max_tokens: 2000,
          repeat: false,
          max_iterations: 1,
        },
      ],
    },
    skippable: true,
  },
];
