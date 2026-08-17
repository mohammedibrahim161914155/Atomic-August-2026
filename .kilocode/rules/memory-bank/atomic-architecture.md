---
description: Core architectural decisions for the Atomic multi-agent blueprint generator. Preserved across sessions for Kilo Code's Memory Bank.
---

# Atomic Architecture — Memory Bank

## What Atomic Does
Atomic generates production-ready software architecture blueprints using a multi-agent pipeline. It makes **zero inference calls itself** — the host coding agent (Kilo Code, Claude Code, Cursor, etc.) provides all LLM capability.

## Core Pipeline Stages

```
1. Governor       → Extracts structured GovernorIntent from user prompt (Zod-validated)
2. Pillars (×7)   → Run in parallel; each has agents + reviewer + prosecutor
3. Prosecutor     → Cross-pillar gap detection with extended thinking
4. Rerun Loop     → Max 3 reruns of flagged pillars
5. Synthesizer    → Merges all outputs into Blueprint
6. Bundle Gen     → Produces Claude Code–ready output bundle
```

## The Seven Pillars
`planning` · `production` · `edge_cases` · `integration` · `security` · `quality` · `completeness`

Each pillar: agents run in sequence → reviewer + prosecutor run in parallel → pillar synthesizer assembles output.

## Key Architectural Decisions

### AsyncLocalStorage for Session Propagation
Session IDs propagate through `AsyncLocalStorage` (`src/engine/agentMemory.ts`). **Do not add `sessionId` as a function parameter** — this is intentional to keep agent tool signatures clean.

### Redis/SQLite Dual Store
- Development: SQLite (`src/engine/store.sqlite.ts`)
- Production: Redis (`src/engine/store.redis.ts`)
- Fallback: Redis failure silently falls back to SQLite — no data loss
- Sessions are NOT shared across replicas without Redis

### Context Budget Management
`ContextBudgetManager` (`src/engine/contextBudget.ts`) must be called before every LLM dispatch. If `available < 1000` tokens, dispatch fails fast with `ContextOverflowError`. Never silently send an oversized context.

### Model Registry
`src/models/registry.ts` is the **single source of truth** for all model IDs. Any model string outside this file is a defect. The registry includes: display name, OpenRouter slug, context window, max output tokens, capabilities, and per-million-token pricing.

### Retry Strategy
`withRetry()` (`src/engine/withRetry.ts`) wraps all LLM calls. Classifies errors as: `rate_limit` (retry with backoff), `server_error` (retry), `timeout` (retry), `auth` (fail fast), `content_filter` (fail fast).

### Extended Thinking
Enabled for Anthropic models (Claude) via `providerOptions.anthropic.thinking`. The `modelSupportsThinking()` function in `openrouter.ts` determines eligibility. The Prosecutor always uses extended thinking when available.

### SSE Events
All pipeline progress streams via Server-Sent Events. Event types are defined in `EngineEvent` union (`src/engine/types.ts`). Wire format: `data: ${JSON.stringify(event)}\n\n`. Heartbeat every 15s.

### Checkpoint/Resume
Every stage saves a checkpoint before transitioning. On resume, completed stages are skipped. Checkpoints are stored in the active store (Redis/SQLite) with a TTL.

## File Locations Reference

| Concern | File |
|---------|------|
| Pipeline orchestration | `src/engine/index.ts` |
| All types + schemas | `src/engine/types.ts` |
| Model IDs (canonical) | `src/models/registry.ts` |
| UI model list | `src/lib/providers.ts` |
| LLM provider layer | `src/engine/openrouter.ts` |
| Context budget | `src/engine/contextBudget.ts` |
| MCP server | `src/mcp/server.ts` |
| HTTP API | `server.ts` |

## TypeScript Conventions
- Strict mode — zero `any`
- Zod at every external boundary
- Discriminated union errors — never generic `Error` strings
- `withRetry()` for all LLM calls
- Structured logging via pino (`src/engine/logger.ts`)
- No sync I/O in request path

## Adding a New Pillar (Checklist)
1. Create `src/engine/pillars/<name>.ts` (follow `planning.ts` pattern)
2. Add to `PILLAR_REGISTRY` in `pillarRegistry.ts`
3. Add to `PillarName` union in `types.ts`
4. Increment `PILLAR_COUNT` in `types.ts`
5. Add test file `src/engine/pillars/<name>.test.ts`
