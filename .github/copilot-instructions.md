# GitHub Copilot Instructions — Atomic Blueprint Generator

## What is Atomic?
Atomic is a zero-inference-cost multi-agent AI blueprint generator distributed as an npm/npx MCP package. It orchestrates specialized AI agent "pillars" to produce production-ready architecture blueprints. **Atomic itself makes zero LLM calls** — the host agent (GitHub Copilot) makes all calls.

## Architecture
```
Governor → Parallel Pillars → Per-Pillar QA → Global Prosecutor → Synthesizer → Bundle
```

Seven pillars run in parallel: `planning`, `production`, `edge_cases`, `integration`, `security`, `quality`, `completeness`.

## Key Files
| File | Role |
|------|------|
| `src/engine/index.ts` | Main pipeline: `generateBlueprint()` |
| `src/engine/types.ts` | All shared types + Zod schemas |
| `src/engine/config.ts` | Model configuration (single source of truth) |
| `src/models/registry.ts` | Model registry — all IDs, pricing, capabilities |
| `src/engine/contextBudget.ts` | Context window enforcement |
| `src/mcp/server.ts` | MCP tools exposed to coding agents |
| `server.ts` | Express API + Vite middleware |

## Code Style Requirements
1. **Strict TypeScript** — zero `any`, zero unchecked casts
2. **Zod validation** on all external data (user input, LLM responses, API payloads)
3. **Typed errors** — discriminated union error types, never generic `Error` strings
4. **`withRetry()`** for all LLM calls — never call LLM functions directly
5. **Context budget check** before every LLM dispatch via `ContextBudgetManager`
6. **Structured logging** — use `log` from `src/engine/logger.ts`, never `console.log`
7. **No secrets in code** — read from `process.env` only

## Patterns to Follow

### Emitting SSE events
```typescript
emit({ type: 'agent_done', pillar: 'security', agent: 'threat-modeler', preview: text.slice(0, 200) });
```

### Calling an LLM with retry
```typescript
const result = await withRetry(
  () => generateText(prompt, config, systemPrompt),
  { label: 'security-agent', maxAttempts: 3 }
);
```

### Validating LLM JSON output
```typescript
const parsed = MyOutputSchema.safeParse(JSON.parse(raw));
if (!parsed.success) throw new ParseError('agent-name', parsed.error);
```

## What Copilot Should NOT Do
- Add `any` types — suggest `unknown` + narrowing instead
- Use `console.log` — suggest `log.info()` / `log.error()` instead
- Write model ID strings inline — suggest adding to `src/models/registry.ts`
- Skip error handling in async functions — every `await` needs try/catch or `.catch()`
- Use synchronous file I/O in the server request path
