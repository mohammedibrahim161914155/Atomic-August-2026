# CLAUDE.md — Atomic Blueprint Generator

Atomic is a zero-inference-cost multi-agent AI blueprint generator. **All LLM calls are made by the host agent (you) — Atomic itself makes no inference calls.** Atomic exposes an MCP server so you can call it as a tool directly.

## Architecture Overview

```
Governor → Parallel Pillars (×7) → Per-Pillar [Reviewer + Prosecutor + Synthesizer]
        → Global Prosecutor → Rerun Loop (max 3) → Final Synthesizer → Bundle Generator
```

- **Governor** (`src/engine/governor.ts`): Parses user prompt into `GovernorIntent` (Zod-validated)
- **Pillars** (`src/engine/pillars/`): 7 domains run in parallel — planning, production, edge_cases, integration, security, quality, completeness
- **Pillar Runner** (`src/engine/pillarRunner.ts`): Each pillar runs agents → reviewer → prosecutor in parallel
- **Agent Runner** (`src/engine/agentRunner.ts`): Agentic loop with 5 tool-call steps (readMemory, writeDecision, flagConcern, lookupPattern, estimateComplexity)
- **Shared Memory** (`src/engine/agentMemory.ts`): AsyncLocalStorage-based per-session key-value store
- **Prosecutor** (`src/engine/prosecutor.ts`): Cross-pillar gap detection with extended thinking
- **Synthesizer** (`src/engine/synthesizer.ts`): Merges all pillar outputs into the final `Blueprint`
- **Bundle Generator** (`src/engine/bundleGenerator.ts`): Produces Claude Code–ready output bundle
- **Store** (`src/engine/store.ts`): Redis (prod) / SQLite (dev) dual-store with graceful fallback
- **Context Budget** (`src/engine/contextBudget.ts`): Token budget enforcement — prevents context overflow before every LLM dispatch

## Dev Server

```bash
npm run dev        # Start Express + Vite on port 5000
npm run build      # Compile frontend + server
npm run test       # Run Vitest test suite
npm run test:http  # HTTP integration tests
```

Server runs on `http://localhost:5000` (or `$PORT`). Frontend is served via Vite middleware in dev.

## Key Files

| File | Purpose |
|------|---------|
| `server.ts` | Express backend + Vite dev server |
| `src/engine/index.ts` | Main pipeline orchestrator (`generateBlueprint`) |
| `src/engine/types.ts` | All TypeScript types + Zod schemas |
| `src/engine/config.ts` | Model config — single source of truth |
| `src/models/registry.ts` | Model registry — all model IDs, capabilities, pricing |
| `src/lib/providers.ts` | UI provider/model list |
| `src/engine/contextBudget.ts` | Context window budget manager |
| `src/mcp/server.ts` | MCP server exposing Atomic as tools |

## Common Agent Tasks

### Adding a new pillar
1. Create `src/engine/pillars/<name>.ts` following the pattern in `planning.ts`
2. Register it in `src/engine/pillarRegistry.ts`
3. Add the pillar name to `PillarName` union in `types.ts`
4. Update `PILLAR_COUNT` in `types.ts`

### Adding a new model
1. Add to `src/models/registry.ts` with full metadata (context window, pricing, capabilities)
2. Add to `src/lib/providers.ts` for the relevant provider's model list
3. Update `src/engine/config.ts` if it should be a new default

### Debugging SSE
- SSE stream: `GET /api/v1/generate` with `Accept: text/event-stream`
- Events are typed `EngineEvent` — see `src/engine/types.ts`
- Heartbeat fires every 15s to keep connection alive
- `Last-Event-ID` replay supported for reconnection

### Debugging the pipeline
- Check `src/engine/logger.ts` — structured pino logs with `[atomic]` prefix
- Checkpoints saved to store after every stage (governor, each pillar, prosecutor, synthesizer)
- Resume: pass `existingSessionId` to `generateBlueprint()`

## Conventions — MUST FOLLOW

1. **Zero `any` types** — strict TypeScript throughout; use `unknown` + type narrowing
2. **Zod at every boundary** — all user inputs, LLM outputs, and API responses must be Zod-validated
3. **No secrets in code** — read from `process.env` only; never hardcode keys
4. **Retry with backoff** — use `withRetry()` from `src/engine/withRetry.ts` for all LLM calls
5. **Context budget check** — call `ContextBudgetManager` before every LLM dispatch
6. **Test-first** — write Vitest tests before implementation for any new engine component
7. **Structured errors** — throw typed errors; never `throw new Error('something went wrong')`
8. **No blocking calls** — never use `fs.readFileSync`, `execSync`, or other sync I/O in the request path

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENROUTER_API_KEY` | Yes (default) | Default AI provider key |
| `PORT` | No (5000) | Server port |
| `CONFIG_ENCRYPTION_KEY` | Prod | 32-byte hex key for BYOK storage |
| `ALLOWED_ORIGIN` | Prod | Exact CORS origin |
| `REDIS_URL` | No | Enables Redis session store |
| `ADMIN_TOKEN` | No | Unlocks `/api/v1/sessions` + `/api/v1/metrics` |
| `MAX_CONCURRENT_GENERATIONS` | No (3) | Concurrency limit |
| `LOG_LEVEL` | No (info) | Pino log level |
| `TRIGGER_SECRET_KEY` | No | Enables async Trigger.dev generation |

## What NOT to Change

- `EngineEvent` union in `types.ts` — UI depends on every event type; adding is OK, removing is breaking
- `BlueprintSchema` shape — persisted in SQLite/Redis; migrations required for field changes
- SSE protocol format — `data: ${JSON.stringify(event)}\n\n` — clients rely on this exact format
- `withRetry` error classification — maps provider errors to retry strategies; changes affect all LLM calls
- `AsyncLocalStorage` usage for session propagation — do not add `sessionId` as function parameters
