# Atomic — Multi-Agent AI Blueprint Generator

## Overview
Atomic is an elite multi-agent AI system that generates production-ready software architecture blueprints. It orchestrates seven specialized AI agent "pillars" (Planning, Production, Edge Cases, Integration, Security, Quality, and Completeness). Each pillar runs **true autonomous agents** using the Vercel AI SDK's multi-step tool loop — agents read shared memory, look up domain best practices, write decisions, and flag concerns before producing their final output.

## Tech Stack
- **Frontend**: React 19, Vite, Tailwind CSS v4, Lucide React, React Router DOM v7, Framer Motion, React Markdown
- **Backend**: Express.js (Node.js) with TypeScript
- **AI Engine**: Vercel AI SDK (`ai`, `@ai-sdk/*`) — multi-provider, true multi-agent pipeline
  - Providers: OpenRouter, OpenAI, Anthropic, Google, xAI, Mistral, DeepSeek, ZAI, MiniMax
  - Extended thinking: Anthropic Claude 4.x (via `providerOptions`)
  - Structured output: `generateObject` with Zod schemas
  - Agentic loops: `generateText` with `tools` + `stopWhen: stepCountIs(5)` — real multi-step reasoning
  - Streaming: `streamText` with `textStream` async iterator
- **Background Jobs**: Trigger.dev v3 (`@trigger.dev/sdk`) — optional async blueprint dispatch
- **Database**: SQLite (`better-sqlite3`) for session state and checkpointing; optional Redis for production
- **Language**: TypeScript (full-stack)
- **Package Manager**: npm
- **Node.js**: 20.x (required for native packages)

## Project Structure
```
/
├── server.ts                   # Express backend + Vite dev server in middleware mode
│                               # Includes: blueprint CRUD, rating/note PATCH, export GET/POST,
│                               # auto-save after generation/rerun, HTML renderer (marked)
├── trigger.config.ts           # Trigger.dev v3 configuration
├── src/
│   ├── App.tsx                 # Main React app with routing — includes /history route + nav
│   ├── engine/                 # AI orchestration engine
│   │   ├── openrouter.ts       # Vercel AI SDK provider layer + getModelForConfig export
│   │   ├── config.ts           # ModelConfig, ProviderSlug, SERVER_DEFAULT_CONFIG (May 2026 models)
│   │   ├── agentMemory.ts      # Session-scoped shared memory for agent coordination (AsyncLocalStorage)
│   │   ├── agentRunner.ts      # Agentic loop — generateText wrapped with withRetry
│   │   ├── pillarRunner.ts     # Parallel pillar execution; governor/reviewer/prosecutor/synthesizer all wrapped with withRetry
│   │   ├── withRetry.ts        # Exponential backoff retry with error classification (rate_limit/server_error/timeout/auth/content_filter)
│   │   ├── blueprintStore.ts   # SQLite blueprint persistence with FTS5 full-text search + formal migration runner
│   │   ├── qualityScorer.ts    # Standalone 0-100 quality scoring (sections 40pt + pillars 30pt + prosecutor 30pt)
│   │   ├── governor.ts         # Intent extraction
│   │   ├── perPillarReviewer.ts# Per-pillar quality gate (uses fastModel for cost efficiency)
│   │   ├── prosecutor.ts       # Cross-pillar gap detection (proModel + extended thinking); logs truncation events
│   │   ├── synthesizer.ts      # Final blueprint assembly; imports scoreBlueprint from qualityScorer
│   │   └── ...
│   ├── trigger/
│   │   └── blueprint.ts        # Trigger.dev task for background generation
│   ├── context/
│   │   └── GenerationContext.tsx   # Global SSE manager — survives navigation; exposes start/resume/stop/terminate
│   ├── components/
│   │   └── GenerationBanner.tsx    # Fixed-bottom floating progress bar with Stop/Terminate buttons
│   ├── pages/
│   │   ├── Landing.tsx         # Prompt entry (banner shown when generation active)
│   │   ├── Generating.tsx      # Live SSE progress via GenerationContext; Stop + Terminate buttons
│   │   ├── Blueprint.tsx       # Blueprint view — StarRating, SectionNote, export buttons
│   │   ├── History.tsx         # My Blueprints — paginated card grid, search, tag/date/quality/sort filters
│   │   ├── Settings.tsx
│   │   └── Onboarding.tsx
│   ├── hooks/
│   │   ├── useBlueprintHistory.ts  # Paginated history with search, delete, rate, setNote, date/quality/sort filters
│   │   ├── useKeyboardShortcuts.ts # Mod+K (new), Mod+H (history), Mod+, (settings) global shortcuts
│   │   └── ...
│   └── lib/
│       └── providers.ts        # Provider/model list (May 2026 real models)
├── vite.config.ts
└── tsconfig.json
```

## AI Provider Configuration (May 2026)
Default server-side config:
- `provider`: `openrouter`
- `fastModel`: `openai/gpt-5.3-chat` — used for reviewer (lower cost, adequate for constructive review)
- `proModel`: `openai/gpt-5.4` — used for agents, prosecutor, synthesizer (full reasoning power)

Supported models (representative):
- **OpenAI**: GPT-5.5/5.5-Pro, GPT-5.4/5.4-Pro, GPT-5.3-Chat, GPT-5.3-Codex, o3, o3-Pro, GPT-4.1/Mini/Nano
- **Anthropic**: Claude Opus 4.7, Claude Sonnet/Opus 4.6
- **Google**: Gemini 3.1 Pro/Flash/Flash-Lite, Gemini 3 Flash
- **xAI**: Grok 4.3, Grok 4.20
- **Mistral**: Devstral
- **DeepSeek**: DeepSeek V4 Pro/Flash
- **ZAI (GLM)**: GLM-5-Plus, GLM-5-Air, GLM-5-Flash, GLM-4.5-Air
- **MiniMax**: MiniMax M2 Pro/Standard/Mini

## True Agentic Architecture
Each of the 35 agents now runs a real agentic loop (not a single LLM call):

### Agent Tools (src/engine/agentTools.ts via agentRunner.ts)
| Tool | Description |
|------|-------------|
| `readMemory` | Read architectural decisions from shared session memory (same pillar or all pillars) |
| `writeDecision` | Record a key decision so parallel agents stay consistent |
| `flagConcern` | Flag cross-cutting risks for the prosecutor (severity: critical/high/medium/low) |
| `lookupPattern` | Query built-in architectural knowledge base (12 domains) |
| `estimateComplexity` | Classify implementation complexity with sprint estimates and risk drivers |

### Agent Loop Protocol
Each agent follows this process:
1. `readMemory(all_pillars)` — check what peers have decided
2. `lookupPattern(domain)` — retrieve proven patterns + pitfalls
3. Reason and produce full analysis
4. `writeDecision(key, decision, rationale)` — record each key choice
5. `flagConcern(...)` — flag any cross-cutting risks

Up to 5 reasoning steps (tool calls) before the final output is produced.

### Shared Memory (src/engine/agentMemory.ts)
- Per-session, in-process key-value store scoped by pillar + key
- SessionId propagated via `AsyncLocalStorage.enterWith()` — no function signature pollution
- Cross-pillar read: any agent can see decisions from any other pillar
- Concerns store: flagged risks are readable by the prosecutor
- Safety guards: MAX_SESSIONS=200 cap with LRU eviction; MAX_DECISIONS_PER_SESSION=500 per-session cap
- Design note: in-process is correct — each generation is tied to one SSE connection on one replica

### Model Tiering
| Role | Model |
|------|-------|
| Per-pillar Reviewer | `fastModel` (constructive review, doesn't need deep reasoning) |
| Pillar Agents (×35) | `proModel` (main work, full agentic loop) |
| Per-pillar Prosecutor | `proModel` + extended thinking |
| Global Prosecutor | `proModel` + extended thinking |
| Synthesizer | `proModel` |

### Pipeline Performance
- Reviewer + Prosecutor run in **parallel** per pillar (not sequential) — ~50% QA time reduction
- All 6 non-planning pillars run in parallel
- Per-agent timeout: 5 minutes (extended for multi-step tool loops)
- Graceful fallback: if provider doesn't support tool calling, falls back to plain `generateText`

## SSE Events (Engine → UI)
New `agent_tool_call` event emitted when an agent calls a tool:
```typescript
{ type: 'agent_tool_call', pillar: PillarName, agent: string, tool: string, input: Record<string, unknown> }
```

## Vercel AI SDK Notes
- `maxOutputTokens` not `maxTokens` (v5 API naming)
- `stopWhen: stepCountIs(N)` not `maxSteps` (v5 API for multi-step tool loops)
- `onStepFinish` callback provides text + toolCalls for each step
- Extended thinking: `providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: N } } }`
- `tool()` helper from `@ai-sdk/provider-utils` v5 uses `inputSchema` not `parameters` in TypeScript types — agentRunner.ts uses plain objects (`Record<string, any>`) to bypass overload inference issues; runtime accepts `parameters` fine
- Provider instances cached per `provider:keyHash` (60 min TTL, LRU eviction at 50 entries)

## Trigger.dev Integration (Optional Background Jobs)
- Task: `generate-blueprint` in `src/trigger/blueprint.ts`
- Dispatch: `POST /api/v1/generate-async` — returns `{ runId, publicAccessToken }`
- Status: `GET /api/v1/run/:runId` — proxies run status
- Falls back gracefully with 503 when `TRIGGER_SECRET_KEY` not set

## Environment Variables
- `PORT` — Server port (set to 5000 for Replit)
- `OPENROUTER_API_KEY` — Default AI provider API key
- `CONFIG_ENCRYPTION_KEY` — Required in production (32-byte hex key)
- `ALLOWED_ORIGIN` — Required in production (exact CORS origin)
- `REDIS_URL` — Optional (Redis for multi-replica session sharing)
- `ADMIN_TOKEN` — For accessing `/api/v1/sessions` and `/api/v1/metrics`
- `MAX_CONCURRENT_GENERATIONS` — Defaults to 3
- `LOG_LEVEL` — Pino log level (default: 'info')
- `TRIGGER_SECRET_KEY` — Trigger.dev API key (enables async generation)
- `TRIGGER_PROJECT_ID` — Trigger.dev project ID (optional)

## Running the App
- **Development**: `npm run dev` (runs `tsx server.ts` which starts Express + Vite middleware)
- **Production Build**: `npm run build` (runs `vite build` + `esbuild` for server)
- **Production Start**: `NODE_ENV=production node dist/server.js`

## Replit Configuration
- Workflow: "Start application" → `npm run dev` → port 5000
- Deployment: autoscale, build=`npm run build`, run=`node dist/server.js`
- `PORT=5000` set as shared env var
- Vite configured with `host: '0.0.0.0'` and `allowedHosts: true` for Replit proxy compatibility

## UI Design System (Claude-Inspired — May 2026)
Consistent design language applied across all screens:
- **Background**: `#f5f4f0` warm off-white (all main content areas)
- **Dark surfaces**: `#1c1612` (sidebar, header bars in Blueprint/Settings/History)
- **Cards**: `#ffffff` white with `border-gray-200` and `shadow-sm`
- **Typography**: Clean sans-serif; `font-mono` for ATOMIC logo + code
- **Brand accent**: `rose-900` for primary actions; `gray-900` for secondary CTAs
- **Inputs**: White bg, subtle border, `focus:ring-gray-900/10` focus ring
- **Spacing**: Generous — `p-5..p-8` cards, `space-y-5` between sections

### Pages
| Page | Layout | Key Feature |
|------|---------|-------------|
| **Onboarding** | Centered, white card, thin step lines | 4-step walkthrough, slide transitions |
| **Landing** | Centered, 2xl max-w, warm bg | Segmented mode control inside textarea toolbar |
| **Generating** | Centered, prompt card + spinner | N-segment progress track with % display |
| **Blueprint** | Dark header + TOC sidebar + white section cards | Star rating, per-section notes, pillar re-run, export |
| **History** | Dark sidebar (tags) + warm main (list cards) | Tag filtering, compare mode, inline tag editor |
| **Settings** | Dark sidebar nav + warm main | Provider/Auth/Model sections, per-section nav |
| **Compare** | Two-panel diff + section navigator | LCS diff, unified/split mode, score delta |

## Key Configuration Notes
1. `vite.config.ts` — Uses `process.cwd()` instead of `fileURLToPath(import.meta.url)` (tsx ESM compatibility)
2. `vite.config.ts` — Added `host: '0.0.0.0'` and `allowedHosts: true` for proxy support
3. `server.ts` — Added `allowedHosts: true` to embedded Vite server config
4. `server.ts` — HMR `clientPort` now uses `PORT` variable instead of hardcoded 3000
5. Node.js 20 required (native packages like `@tailwindcss/oxide` require Node >= 20)
