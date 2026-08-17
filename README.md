# Atomic — Multi-Agent AI Blueprint Generator

![Version](https://img.shields.io/badge/version-2.1.0-blue)
![Tests](https://img.shields.io/badge/tests-268%20passing-green)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![License](https://img.shields.io/badge/license-MIT-green)

Atomic is an enterprise-grade, zero-inference-cost multi-agent AI system that generates production-ready software architecture blueprints, feature plans, MCP tool specifications, and agent definitions. It orchestrates specialised AI agent "pillars" through a `Governor → Parallel Pillars → Reviewer + Prosecutor → Rerun Loop → Synthesizer` pipeline, streaming results via SSE in real time.

> **Zero inference cost**: Atomic itself makes no LLM calls — it delegates 100 % of inference to your host model (OpenRouter, OpenAI, Anthropic, Google, xAI, Mistral, DeepSeek, ZAI, or MiniMax). Bring your own API key.

---

## What's New in 2.1.0 — Agentic Pipelines (August 2026)

All four pipelines now run on a shared **agentic core** distilled from
studying the actual source code of OpenAI Codex, OpenCode, Kimi, Kilo Code,
and OpenDesign. The Blueprint pipeline gets the flagship upgrade: a
verifier-repair loop that scores the synthesized blueprint across four
weighted quality roles (accuracy, completeness, actionability, clarity),
counts MUST-FIX blockers, and triggers up to three targeted repair rounds
before shipping — backed by content-addressed stage snapshots, per-run
step and token budgets, abort-safe sub-agent supervision, and Codex-style
plan mode with mid-run steering. Feature Creator, Tool Builder, and Agent
Builder received the same verifier loop, budgets, and (for Agent Builder)
supervisor coordination, plus a new runtime-tunable verdict/budget
configuration API.

## What's New in 2.0.0 (August 2026)

The 2.0.0 release hardens Atomic to production / FAANG-grade engineering standards:

- **Testability by design** — the Express application is now created through an exported `createApp()` factory, enabling deterministic in-process HTTP testing with supertest (27 new end-to-end HTTP tests, 244 total, all green).
- **Strict validation gates** — the blueprint output gate now enforces a complete schema covering every required blueprint section, pillar token accounting, and quality metadata.
- **Hardened configuration** — provider slugs are validated against the registry, placeholder API keys are rejected at startup, and BYOK overrides are honored deterministically.
- **Resilient retries** — `withRetry` now aborts propagation (throws `AbortError`) when a request is cancelled mid-backoff, with correct error classification for transient vs permanent failures.
- **Browser-safe bundle split** — the Node-only SQLite and system layers no longer leak into the client bundle; `dist/client` is a pure browser build, `dist/server` carries the runtime.
- **Cross-environment ID generation** — UUID generation now works in both Node and browser contexts via a lazy environment-aware helper.
- **Clean static analysis** — zero eslint errors across the entire codebase; all pre-existing issues resolved or formally disabled with justifications.
- **Production tooling** — GitHub Actions CI (lint + typecheck + full test suite), multi-stage Dockerfile, docker-compose deployment profile, SECURITY.md, CONTRIBUTING.md, and CHANGELOG.md.

---

## Pipelines

| Pipeline | Button | Description |
|----------|--------|-------------|
| **Blueprint** | Generate | Full 7-pillar system architecture blueprint — planning, production, edge cases, integration, security, quality, completeness |
| **Feature Creator** | Build Feature | Implementation-ready feature plan for an existing codebase |
| **Tool Builder** | Build Tool | MCP-compatible tool specification + skeleton code |
| **Agent Builder** | Build Agent | Full agent spec with system prompt, capabilities, constraints, and evaluation harness |

---

## Architecture

### Tech Stack

- **Frontend**: React 19, Vite 6, Tailwind CSS v4, Framer Motion, React Router DOM v7, Lucide React, React Markdown
- **Backend**: Express.js (Node.js 20) with TypeScript strict
- **AI Engine**: Vercel AI SDK v5 (`ai`, `@ai-sdk/*`) — true agentic loops with `generateText + tools + stopWhen`
- **Streaming**: SSE (`text/event-stream`) with 15 s heartbeats, `Last-Event-ID` reconnection, client-disconnect cleanup
- **Storage**: SQLite (`better-sqlite3`) with FTS5 full-text search + Redis (optional, for multi-replica deployments)
- **Background Jobs**: Trigger.dev v3 (optional async dispatch)
- **MCP Server**: `npx atomic-mcp` — integrates with Claude Code, Cursor, Kilo Code, VS Code Copilot

### Blueprint Pipeline

```
User prompt
  → Governor (intent extraction, Zod-validated GovernorIntent)
  → 7 Pillars in parallel (each runs 5 agents in an agentic loop)
      ↳ Per-pillar Reviewer  (quality gate, fastModel)
      ↳ Per-pillar Prosecutor (gap detection, proModel + extended thinking)
  → Supreme Prosecutor (cross-pillar gaps, proModel + extended thinking)
  → Rerun Loop (targeted pillar reruns, max 3 iterations)
  → Synthesizer (final Markdown blueprint + Claude Code bundle)
  → Atomic Memory Bank (.atomic/memory/session-<id>.md)
```

### The 7 Blueprint Pillars

1. **Planning** — System Architecture, Domain Modeling, Dependency Mapping
2. **Production** — Scalability, Performance, Reliability, Observability
3. **Edge Cases** — Boundary conditions, Failure Modes, Concurrency
4. **Integration** — API Contracts, Data Flow, State Sync
5. **Security** — Auth/Authz, Data Protection, Attack Surfaces
6. **Quality** — Testing Strategy, Standards, Technical Debt
7. **Completeness** — Feature depth, Implementation paths, Launch Readiness

### True Agentic Loops

Each agent follows a 5-step protocol before producing output:

1. `readMemory(all_pillars)` — check peer decisions
2. `lookupPattern(domain)` — retrieve proven patterns + pitfalls
3. Reason and produce full analysis
4. `writeDecision(key, value, rationale)` — record key architectural choices
5. `flagConcern(severity, description)` — flag cross-cutting risks for the Prosecutor

### Atomic Memory Bank

After every successful blueprint run, a session summary is written to `.atomic/memory/session-<id>.md`. The Governor reads all summaries on subsequent runs, giving the pipeline accumulative project knowledge across separate generations. Up to 50 sessions are retained (oldest evicted automatically).

---

## MCP Server Integration

Atomic exposes its pipeline as MCP tools so AI coding agents can call it directly.

### Supported Tools

| Tool | Description |
|------|-------------|
| `atomic_generate_blueprint` | Start a blueprint generation (returns `sessionId` immediately via REST) |
| `atomic_get_status` | Poll job progress by session ID |
| `atomic_get_result` | Retrieve completed blueprint (json / markdown / summary) |
| `atomic_list_blueprints` | List all past blueprints with search + quality filters |
| `atomic_rerun_pillar` | Trigger targeted rerun of a specific pillar |
| `atomic_export_bundle` | Export in json / markdown / yaml / claude_md / agents_md |
| `atomic_validate_task` | Pre-validate a task description + estimate cost |

### Setup

**Claude Code** — `.claude/settings.json` is already pre-configured. Run `npx atomic-mcp` and it connects automatically.

**Cursor** — `.cursor/mcp.json` is pre-configured.

**VS Code Copilot** — `.github/copilot-instructions.md` provides project context.

**Manual setup** (any MCP client):
```bash
# stdio transport (default — works with all MCP clients)
npx atomic-mcp

# HTTP transport (for debugging)
MCP_TRANSPORT=http MCP_PORT=3100 npx atomic-mcp
```

Environment variables for the MCP server:
- `ATOMIC_API_URL` — URL of the running Atomic server (default: `http://localhost:5000`)
- `MCP_TRANSPORT` — `stdio` (default) or `http`
- `MCP_PORT` — port for HTTP transport (default: `3100`)

---

## REST API

All endpoints are under `/api/v1/`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/generate` | Start blueprint generation (SSE streaming — for browser clients) |
| `POST` | `/generate-start` | Start blueprint generation in background, returns `{ sessionId }` immediately (for MCP / REST clients) |
| `POST` | `/generate-pipeline` | Start Feature Creator / Tool Builder / Agent Builder (SSE streaming) |
| `POST` | `/validate` | Pre-validate a task description, returns cost estimate |
| `GET` | `/sessions/:id` | Get session status and metadata |
| `GET` | `/sessions/:id/blueprint` | Get completed blueprint JSON |
| `GET` | `/blueprints` | List all blueprints (paginated, search, quality filter) |
| `POST` | `/blueprints/:id/export` | Export in json / markdown / yaml / claude_md |
| `POST` | `/rerun-pillar` | Rerun a specific pillar |
| `PATCH` | `/blueprints/:id/rating` | Set star rating (1–5) |
| `PATCH` | `/blueprints/:id/note` | Set per-section note |

---

## Getting Started

### Prerequisites

- Node.js 20+ (required for native packages like `@tailwindcss/oxide`)
- An API key from your chosen provider (OpenRouter recommended)

### Installation

```bash
npm install
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: `5000`) |
| `OPENROUTER_API_KEY` | Yes* | Default AI provider key |
| `CONFIG_ENCRYPTION_KEY` | Production | 32-byte hex key for BYOK key encryption |
| `ALLOWED_ORIGIN` | Production | Exact CORS origin (e.g. `https://yourdomain.com`) |
| `MAX_CONCURRENT_GENERATIONS` | No | Concurrent generation cap (default: `3`) |
| `REDIS_URL` | No | Redis URL for multi-replica session sharing |
| `LOG_LEVEL` | No | Pino log level (default: `info`) |
| `TRIGGER_SECRET_KEY` | No | Trigger.dev key for async background jobs |
| `MAX_BUDGET_USD` | No | Per-run cost cap in USD (e.g. `0.50`) |
| `ATOMIC_API_URL` | MCP only | URL of the Atomic server the MCP tool connects to |

*Users can supply their own key via the Settings page (BYOK, AES-256-GCM encrypted at rest).

### Running

```bash
# Development (Express + Vite middleware)
npm run dev

# Production build
npm run build

# Production start
NODE_ENV=production node dist/server.js

# MCP server (stdio transport)
npm run mcp
# or: npx atomic-mcp
```

---

## Testing & CI

```bash
npm test            # 268 unit + integration tests (vitest)
npm run test:http   # 27 end-to-end HTTP tests (supertest, in-process app)
npm run lint        # TypeScript check + eslint (zero-error policy)
npm run build       # Client + server production bundles
```

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs `lint`, type-checking, and the full test suite on every push and pull request. No code is merged unless the suite is green.

---

## Docker

```bash
# Build and run
docker compose up -d --build

# Only the API server (no dev deps)
docker compose --profile api up -d --build
```

The `Dockerfile` uses a multi-stage build: a full build stage compiles the client and server, and a slim production stage ships only `dist/` and production dependencies, running as a non-root user.

---

## AI Providers (June 2026)

Default server config uses `openrouter` provider with:
- `fastModel`: `openai/gpt-5.3-chat` (reviewer — cost-efficient)
- `proModel`: `openai/gpt-5.4` (agents, prosecutor, synthesizer — full reasoning)

Supported providers and models:

| Provider | Example Models |
|----------|---------------|
| **OpenAI** | GPT-5.5/5.5-Pro, GPT-5.4/5.4-Pro, GPT-5.3-Chat, o3, o3-Pro |
| **Anthropic** | Claude Opus 4.7, Claude Sonnet/Opus 4.6 |
| **Google** | Gemini 3.1 Pro/Flash/Flash-Lite |
| **xAI** | Grok 4.3, Grok 4.20 |
| **Mistral** | Devstral |
| **DeepSeek** | DeepSeek V4 Pro/Flash |
| **ZAI (GLM)** | GLM-5-Plus, GLM-5-Air, GLM-5-Flash |
| **MiniMax** | MiniMax M2 Pro/Standard/Mini |

All model IDs are maintained in `src/models/registry.ts` — the single source of truth.

---

## Project Structure

```
/
├── server.ts                    # Express backend (createApp factory) + Vite dev middleware
├── src/
│   ├── App.tsx                  # Router — Landing, Generating, Blueprint, History, Settings, Compare
│   ├── engine/
│   │   ├── index.ts             # Pipeline orchestrator (Governor → Pillars → Prosecutor → Synthesizer)
│   │   ├── governor.ts          # Intent extraction + task sanitiser
│   │   ├── pillarRunner.ts      # Parallel pillar execution + content poisoning detection
│   │   ├── agentRunner.ts       # Agentic loop (generateText + tools + stopWhen: stepCountIs(5))
│   │   ├── agentMemory.ts       # Session-scoped shared memory (AsyncLocalStorage, LRU eviction)
│   │   ├── prosecutor.ts        # Cross-pillar gap detection (extended thinking)
│   │   ├── synthesizer.ts       # Final blueprint assembly + quality score
│   │   ├── qualityScorer.ts     # 0–100 scoring (sections 40pt + pillars 30pt + prosecutor 30pt)
│   │   ├── withRetry.ts         # Exponential backoff with error classification
│   │   ├── costBudget.ts        # Pre-run cost estimation + budget cap enforcement
│   │   ├── contextBudget.ts     # Per-pillar token budget enforcement
│   │   ├── taskSanitizer.ts     # Prompt injection defence
│   │   ├── providerHealthMonitor.ts # P50/P95 latency + error rate per model
│   │   ├── blueprintStore.ts    # SQLite persistence with FTS5 full-text search
│   │   ├── checkpoint.ts        # Session state persistence
│   │   ├── agenticCore.ts       # Shared agentic engine (verdicts, turns, snapshots, supervisor, plans)
│   │   ├── blueprintVerifier.ts # Blueprint verifier-repair loop (4-role quality composite)
│   │   ├── pipelineVerifier.ts  # Shared verifier-repair loop for secondary pipelines
│   │   ├── openrouter.ts        # Multi-provider Vercel AI SDK layer
│   │   ├── config.ts            # ModelConfig, ProviderSlug, SERVER_DEFAULT_CONFIG
│   │   └── types.ts             # All shared TypeScript types
│   ├── models/
│   │   └── registry.ts          # Single source of truth for all model IDs + pricing
│   ├── pipelines/
│   │   ├── feature-creator/     # Feature Creator pipeline
│   │   ├── tool-builder/        # Tool Builder pipeline
│   │   └── agent-builder/       # Agent Builder pipeline
│   ├── exporters/               # JSON / Markdown / YAML / CLAUDE.md / AGENTS.md exporters
│   ├── mcp/
│   │   ├── server.ts            # MCP server (7 tools, stdio + HTTP transports)
│   │   └── index.ts             # Entry point (npx atomic-mcp)
│   ├── context/
│   │   └── GenerationContext.tsx # Global SSE manager — survives navigation
│   ├── components/
│   │   └── GenerationBanner.tsx  # Fixed-bottom floating progress bar
│   └── pages/
│       ├── Landing.tsx          # Pipeline selector + prompt entry
│       ├── Generating.tsx       # Live SSE progress
│       ├── Blueprint.tsx        # Blueprint view — rating, notes, export, rerun
│       ├── History.tsx          # My Blueprints — search, filter, compare
│       ├── Compare.tsx          # Two-panel LCS diff view
│       └── Settings.tsx         # Provider / auth / model config
├── .atomic/memory/              # Atomic Memory Bank (session summaries)
├── .claude/                     # Claude Code integration bundle
├── .cursor/mcp.json             # Cursor MCP config
├── .github/
│   ├── workflows/ci.yml         # GitHub Actions CI
│   └── copilot-instructions.md  # GitHub Copilot project context
├── .vscode/                     # VS Code tasks + extensions
├── benchmarks/                  # Pipeline performance benchmarks
├── SECURITY.md                  # Security policy and vulnerability disclosure
├── CONTRIBUTING.md              # Contribution guidelines
└── CHANGELOG.md                 # Version history
```

---

## Security

See [SECURITY.md](SECURITY.md) for the disclosure policy.

- BYOK keys encrypted with AES-256-GCM (unique IV per encryption, auth tag verified on decrypt)
- All user inputs validated with Zod at the API boundary
- Content poisoning detection on all agent outputs (8 injection pattern classes)
- Prompt injection defence in the Governor (`taskSanitizer`)
- Session tokens stored as SHA-256 hashes (never raw), delivered as `httpOnly` cookies
- Placeholder API keys rejected at startup; provider slugs validated against the registry
- No secrets in code — all credentials via environment variables

---

## Observability

- **Structured logging**: Pino JSON logs with request-scoped child loggers (no `console.log`)
- **Pipeline spans**: `atomic.pipeline.run` span logged after every successful run carrying `job.id`, `model.id`, `tokens.total`, `quality.score`, `duration_ms`, `pillars.count`, `mode`
- **Provider health**: P50/P95 latency + error rate tracked per model via `providerHealthMonitor`
- **Cost tracking**: Per-run token cost logged and enforced against `MAX_BUDGET_USD` cap

---

## License

MIT
