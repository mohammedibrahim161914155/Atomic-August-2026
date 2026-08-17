# AGENTS.md — Atomic Blueprint Generator

> Used by Codex CLI, OpenAI Assistants, and OpenAI-compatible agents.

Atomic is a zero-inference-cost multi-agent AI blueprint generator. The host agent (you) makes all LLM calls. Atomic is the orchestration framework.

## Quick Start

```bash
npm install
npm run dev        # Start on http://localhost:5000
```

## Project Structure

```
server.ts                    # Express API + Vite dev server
src/
  engine/
    index.ts                 # Pipeline entry point: generateBlueprint()
    governor.ts              # Intent extraction from user prompt
    pillarRunner.ts          # Parallel pillar execution
    agentRunner.ts           # Single-agent agentic loop (5 tool steps)
    prosecutor.ts            # Cross-pillar gap detection
    synthesizer.ts           # Final blueprint assembly
    bundleGenerator.ts       # Claude Code bundle output
    types.ts                 # All types + Zod schemas
    config.ts                # Model configuration
    contextBudget.ts         # Token budget enforcement
    store.ts                 # Redis/SQLite dual-store
    agentMemory.ts           # Shared session memory (AsyncLocalStorage)
    withRetry.ts             # Exponential backoff retry
    pillars/                 # 7 domain pillar definitions
  models/
    registry.ts              # Canonical model registry (IDs, pricing, capabilities)
  mcp/
    server.ts                # MCP server — exposes Atomic as agent tools
    index.ts                 # MCP entry point
  lib/
    providers.ts             # UI model/provider list
    sse.ts                   # SSE client helper
```

## Key API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/generate` | Start blueprint generation (SSE stream) |
| `GET`  | `/api/v1/sessions/:id` | Get session status |
| `GET`  | `/api/v1/sessions/:id/blueprint` | Get completed blueprint |
| `POST` | `/api/v1/sessions/:id/rerun` | Rerun a specific pillar |
| `GET`  | `/api/v1/blueprints` | List all saved blueprints |
| `POST` | `/api/v1/configure-key` | Store encrypted API key |

## Agent Pipeline

```
User Prompt
    │
    ▼
Governor (intent extraction)
    │
    ▼
┌─────────────────────────────────────────────┐
│  Parallel Pillars (each runs agents + QA)   │
│  planning · production · edge_cases         │
│  integration · security · quality           │
│  completeness                               │
└─────────────────────────────────────────────┘
    │
    ▼
Global Prosecutor (cross-pillar gaps)
    │
    ▼
Rerun Loop (max 3 iterations)
    │
    ▼
Final Synthesizer
    │
    ▼
Blueprint + Claude Code Bundle
```

## TypeScript Conventions

- **Strict mode** — zero `any` types
- **Zod validation** at every external boundary (user input, LLM output, API response)
- **`withRetry()`** wraps all LLM calls — exponential backoff with error classification
- **`ContextBudgetManager`** — check before every LLM dispatch to prevent overflow
- **No sync I/O** in request path — async only

## Testing

```bash
npm run test           # Full Vitest suite
npm run test:http      # HTTP integration tests (requires running server)
npm run lint           # TypeScript + ESLint
```

Tests live next to source files as `*.test.ts`. Use `vi.mock()` for LLM provider mocking.

## Adding New Features

1. **New pillar**: Create `src/engine/pillars/<name>.ts`, register in `pillarRegistry.ts`, add to `PillarName` type
2. **New model**: Add to `src/models/registry.ts` + `src/lib/providers.ts`
3. **New API endpoint**: Add to `server.ts` with Zod input validation and rate limiting
4. **New MCP tool**: Add to `src/mcp/server.ts` following the existing tool pattern

## OpenAI-Specific Notes

- All prompts follow the `system + user` message pattern
- Tool calls use the standard OpenAI function-calling format via Vercel AI SDK
- The `generateJson<T>()` function in `openrouter.ts` uses `generateObject` with a Zod schema
- Extended thinking is enabled for Anthropic models via `providerOptions`
