# Changelog

All notable changes to Atomic are documented here.

## [2.3.0] — August 2026

### Added — engine plugin platform (OpenDesign plugin parity + universal SKILL.md bridge)

Atomic now ships a full server-side plugin engine so pipelines can be extended
by installable plugins and — via skill packs — Atomic's own 7-pillar pipelines
can run inside Codex, Claude Code, OpenCode, and Kilo Code.

- `src/plugins/engine/schema.ts` — **manifest schema** (Zod): versioned
  `specVersion`, kind taxonomy (`reviewer`/`skill`/`generator`/`exporter`/
  `transformer`/`reporter`), capability allow-list (`prompt:inject`,
  `blueprint:read`, `blueprint:write`, `events`, `api:call`), stage pipeline
  shape with OpenDesign-style `repeat`/`until`/`max_iterations` loops.
- `src/plugins/engine/doctor.ts` — **doctor** validation with cross-field
  rules (id format, until-grammar, stage ordering, capability/kind
  compatibility) plus warning diagnostics, exactly like OpenDesign's
  `validate-manifest`.
- `src/plugins/engine/digest.ts` — **content-addressed plugin digests** (Kilo
  Code pattern): behaviour-defining fields are hashed to a 16-hex id; cosmetic
  metadata edits are ignored. Digests bind trust grants so a mutated plugin
  must be re-approved.
- `src/plugins/engine/trust.ts` — **per-session trust store** with persistent
  grants, deny-lists, digest re-locking on re-install, and capability gating
  (restricted plugins never touch blueprint data).
- `src/plugins/engine/runtime.ts` — **stage pipeline runner** over the
  agentic core: `generate` → `review` → `transform`/`export` stages with
  `repeat: true` + `until` composite-score loops, token budgets, abort
  propagation, and the same 4-role composite verdict as the pipelines.
- `src/plugins/engine/skillPack.ts` — the **"run anywhere" bridge**: Atomic's
  four pipelines rendered as portable skill packs (SKILL.md + AGENTS.md +
  `.claude-plugin/plugin.json` + README) so Atomic itself becomes an
  installable plugin in Codex (`--add-skills`), Claude Code (plugin
  manifest), OpenCode (`~/.config/opencode/skills/`), and Kilo Code
  (`.claude/skills/`).
- `src/plugins/engine/builtIns.ts` — four trusted built-ins:
  `builtin:atomic-{blueprint,feature,tool,agent}` pipeline skills plus
  `builtin:blueprint-reviewer`, `builtin:cost-estimator`, and
  `builtin:quality-ledger-audit` engine plugins.
- `src/plugins/engine/registry.ts` — registry with public projection (prompt
  hiding), install/uninstall lifecycle, and a protected built-in allow-list.
- Seven new API endpoints: `POST /plugins/doctor`, `POST /plugins/install`,
  `DELETE /plugins/:id`, `GET /plugins/:id/pack` (skill pack),
  `GET /skill-packs`, `POST /plugins/:id/run`, plus trust GET/PATCH/DELETE —
  all rate-limited and validated.
- 38 new tests (337 total passing) covering schema, doctor rules, digest
  stability, trust isolation, until evaluation, capability gating, registry
  lifecycle, and the full skill-pack render.

## [2.2.0] — August 2026

### Added — comparative gap-closing layer (Codex · OpenCode · Kimi · Kilo Code · OpenDesign)

A systematic source-repo comparison against OpenAI Codex (Rust), OpenCode (Go),
Kimi CLI, Kilo Code (TS), and OpenDesign (TS) surfaced five concrete capability
gaps. All five were closed with real working logic, full unit coverage, and
production smoke verification.

- `contextCompactor.ts` — **context auto-compaction** (Codex `compact*.rs`
  pattern). Every pipeline checks utilisation before its big synthesis call
  (warn ≥80%, auto-compact ≥90% against a 200k-token pro-model window, abort
  ≥98%) and emits `context.compaction` SSE events. Over-long runs can no longer
  push a single prompt past the model window.
- `elicitation.ts` — **model-driven elicitation queues** (Codex elicitation +
  Kilo Code question tool). Pipelines can ask typed clarifying questions
  (`clarify`/`confirm`/`choose` with options, fallback answers, auto-deny
  deadlines). Questions are persisted, auto-expired, answerable mid-run, and
  fully auditable via the API.
- `permissionRegistry.ts` — **operation permission tiers** (Codex execpolicy +
  Kilo Code permission model). Nine pipeline operations (`generate`, `repair`,
  `rerun-pillar`, `steer`, `plan`, `compact`, `verifier-loop`, `snapshot`,
  `undo`) sit under `full-auto` | `ask` | `deny` tiers with global defaults and
  per-session overrides persisted across restarts.
- `qualityLedger.ts` — **quality ledger with drift detection** (OpenDesign
  conformance/ratchet pattern). Every verifier round of every run is recorded;
  the ledger exposes high-water marks, rolling averages, and drift alerts when
  quality slides below the ratchet tolerance.
- `runSummary.ts` — **per-run telemetry** (Kilo Code `kilo-telemetry` pattern).
  Each run records duration, token usage, cost (70/30 input/output split across
  six known model rates), verifier verdict, and quality drift.
- Eight new API endpoints: `/answer-elicitation`, `/elicitations`,
  `/permissions` (GET + PATCH), `/quality/:pipeline`, `/runs` — all
  input-validated and rate-limited, exercised by new HTTP integration tests.
- Pipeline integration: auto-compaction, ledger recording, and run telemetry
  wired into the **Blueprint**, **Feature Creator**, **Tool Builder**, and
  **Agent Builder** pipelines; `EngineEvent` extended with the new event
  taxonomy.

## [2.1.0] — August 2026

### Added
- `agenticCore.ts` — a shared agentic engine distilled from the pipelines of
  OpenAI Codex, OpenCode, Kimi, Kilo Code, and OpenDesign:
  - **Verdict engine**: role-weighted composite scoring, MUST-FIX blocker
    counting, capped repair rounds, and deterministic fallback policies
    (`ship_best` / `ship_last` / `ship_highest`).
  - **Turn runner**: per-run step and token budgets with an 80%-warning /
    hard-cap abort model, error-classified retries, and optional per-step
    verification.
  - **Stage snapshots** (Kilo Code pattern): content-addressed checkpoints
    of every pipeline stage with undo/restore.
  - **Sub-agent supervisor** (Kimi pattern): abort-safe fan-out with derived
    signals, per-task retries, and aggregate status reporting.
  - **Plan mode + steering** (Codex pattern): milestone decomposition,
    persisted plans, and a mid-run course-correction queue.
  - **Pipeline defaults registry**: per-pipeline verdict and budget
    configuration, overridable at runtime via the API and persisted
    across restarts.
- `blueprintVerifier.ts` — the Blueprint pipeline's verifier-repair loop:
  structural validation gates plus a four-role quality composite
  (accuracy / completeness / actionability / clarity) with targeted repair
  of only the weakest sections.
- `pipelineVerifier.ts` — shared verifier-repair loop used by the Feature
  Creator, Tool Builder, and Agent Builder pipelines.
- New API endpoints: `/generate-plan`, plan retrieval, steer queue and
  history, stage snapshots + undo, and per-pipeline
  `/pipelines/:name/config` overrides.
- 24 new `agenticCore` unit tests covering the verdict engine, turn budgets,
  snapshot lifecycle, supervisor fan-out, and the verifier loop.

### Changed
- All four pipelines (Blueprint, Feature Creator, Tool Builder, Agent
  Builder) now run their final output through the verifier-repair loop
  with stage snapshots, budgets, and rich SSE progress events.

## [2.0.0] — August 2026

### Added
- Full production-grade CI pipeline (GitHub Actions): strict type check,
  eslint, full test suite, production build, and server smoke test on every
  push/PR to `main`.
- Production Docker image (multi-stage, non-root, health check) and
  `docker-compose.yml` with persistent session volume.
- Browser-safe `skillsData.ts`: the built-in skills library is now shipped
  as pure static data, keeping Node persistence modules out of the client
  bundle and shrinking the frontend payload.
- Cross-environment UUID generator (`eventBus.ts`, `skills.ts`) supporting
  both Node (`node:crypto`) and browser (Web Crypto API) runtimes.
- New test suites: `withRetry` error classification and retry budgets (13
  tests), config/provider validation and registry (13 tests), HTTP integration
  suite rewritten to boot the app in-process with supertest (27 tests).

### Changed
- `server.ts` refactored into a testable `createApp()` factory; the server
  only auto-boots when executed directly.
- `validationGates.ts` blueprint gate hardened: all ten blueprint sections
  are now required, minimum content lengths enforced, placeholder tokens
  rejected, `quality_score` range-validated, and token accounting required.
- `config.ts` hardened: provider allow-list validation, placeholder-key
  rejection, and minimum API key length enforcement; `resolveConfig` now
  honors provider-only overrides.
- `withRetry.ts` abort semantics fixed: an `AbortSignal` now reliably
  terminates an in-flight backoff and surfaces `AbortError`.

### Fixed
- Client bundle no longer pulls `better-sqlite3`, `fs`, `path`, or `os`
  (build no longer fails under Vite).
- Test-suite flakiness: HTTP integration tests no longer depend on a
  manually started server; promise-rejection handling under fake timers
  corrected in `withRetry` tests.

### Removed
- Orphaned placeholder-key acceptance from configuration defaults.

## [1.0.0] — July 2026

Initial release: multi-agent blueprint generation pipeline (Governor →
7 parallel pillars → Reviewer/Prosecutor → Synthesizer), OpenRouter and
first-party provider support, SSE streaming, SQLite session store, MCP
server with GitHub/Linear/Notion/Claude/Jira exports, and the four
generation pipelines (Blueprint, Feature Creator, Tool Builder, Agent Builder).
