# Changelog

All notable changes to Atomic are documented here.

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
