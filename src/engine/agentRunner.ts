/**
 * src/engine/agentRunner.ts
 *
 * True agentic agent execution using Vercel AI SDK's multi-step tool loop.
 *
 * Replaces the single `generateText` call per agent with a real agentic loop:
 *   1. Agent reads shared memory to check what peers have already decided.
 *   2. Agent looks up domain best practices from the built-in knowledge base.
 *   3. Agent reasons and writes concrete decisions back to shared memory.
 *   4. Agent flags cross-cutting concerns for the prosecutor.
 *   5. Agent produces its complete final deliverable with full grounded context.
 *
 * The Vercel AI SDK `generateText` with `tools` + `stopWhen: stepCountIs(N)`
 * drives the agentic loop — the model decides when to stop calling tools and
 * produce its final output, rather than being forced through a single call.
 */

import { generateText, stepCountIs } from 'ai';
import { z } from 'zod';
import { ModelConfig } from './config';
import { agentMemory, sessionIdStorage } from './agentMemory';
import { getModelForConfig } from './openrouter';
import { log } from './logger';
import { withRetry } from './withRetry';
import type { EngineEvent, PillarName } from './types';

// ── Domain knowledge base ─────────────────────────────────────────────────────
// Agents query this via the `lookupPattern` tool before writing recommendations.

const PATTERN_KB: Record<string, { patterns: string; pitfalls: string; tradeoffs: string }> = {
  authentication: {
    patterns: `
- JWT (access + refresh): Short-lived access tokens (15 min), rotating refresh tokens (7–30 days) in httpOnly cookies. Validate on every request. Use RS256 asymmetric keys across services.
- OAuth2 / OIDC: PKCE for SPAs and native apps. Validate nonce, state, aud. Never implicit flow.
- Session-based: Server-side sessions with httpOnly, Secure, SameSite=Lax cookies. Redis for shared session storage in multi-instance deployments.
- Passkeys / WebAuthn: Highest phishing resistance. Relying-party ID must match origin exactly. Provide robust fallback and account-recovery flows.
- API keys: Prefix with a recognizable string (sk_live_, pk_test_). Store hashed (SHA-256). Support scoped, rotatable keys with last-used tracking.
- MFA: TOTP (RFC 6238) for most use cases. Backup codes stored hashed. FIDO2 for enterprise.`,
    pitfalls: `
- Symmetric JWT secrets across services — use RS256/ES256 asymmetric keys.
- Storing tokens in localStorage — vulnerable to XSS; use httpOnly cookies.
- Missing refresh token rotation with family invalidation — detect reuse and invalidate all family tokens.
- No absolute session timeout — set MaxAge plus idle timeout.
- No rate limiting on auth endpoints — exponential backoff + account lockout after N failures.`,
    tradeoffs: `
- Stateless JWT vs. stateful sessions: JWT scales horizontally but can't be immediately revoked without a denylist.
- SSO vs. per-service auth: SSO reduces friction but creates a single point of failure.
- Passkeys vs. passwords: Passkeys have no credential stuffing risk but need robust device-loss fallback flows.`,
  },
  authorization: {
    patterns: `
- RBAC: Roles → permissions. Good for most B2B SaaS. Store roles in JWT claims or session. Keep role count below 20.
- ABAC: Policy engine evaluates resource + user attributes. Use for complex, dynamic rules.
- ReBAC: Google Zanzibar model for document/resource sharing ACLs.
- Permissions table: user_id, resource_type, resource_id, action. Scales to multi-tenant with proper tenant scoping.
- Policy-as-code: OPA or Cedar for centralised, auditable, testable policy evaluation.`,
    pitfalls: `
- Checking permissions only in the UI — always enforce server-side.
- Over-privileged service accounts — apply least privilege to every service identity.
- Missing tenant isolation — always scope queries by tenant_id at the DB layer.
- Horizontal privilege escalation — validate resource ownership, not just role membership.`,
    tradeoffs: `
- RBAC simplicity vs. ABAC expressiveness: Start with RBAC; graduate to ABAC when rules become conditional.
- Centralised policy vs. distributed enforcement: OPA sidecars add latency but centralise auditing.`,
  },
  database: {
    patterns: `
- Connection pooling: PgBouncer (PostgreSQL). Max 10–20 connections per service. Never open a connection per request.
- Read replicas: Route SELECT to replicas; writes always to primary. Synchronous replication for read-your-writes.
- Indexing: B-tree for equality/range; GIN for JSONB/full-text; partial indexes for sparse conditions.
- CQRS: Separate read and write models for high-read-volume or reporting domains.
- Soft deletes: deleted_at TIMESTAMPTZ column. Filter WHERE deleted_at IS NULL.
- Migrations: Forward-only, schema-first. Never run migrations in application startup in production.`,
    pitfalls: `
- N+1 queries — use joins or eager loading; detect with a query counter in test environments.
- Missing indices on foreign keys — always index FK columns.
- Unbounded queries — always paginate. Cursor-based for large datasets; offset for small admin views.
- No retry logic on transient failures — exponential backoff + jitter.`,
    tradeoffs: `
- Normalized vs. denormalized: Normalise for OLTP; denormalize for read-heavy analytics or reporting.
- SQL vs. NoSQL: SQL for relational ACID data; NoSQL for unstructured, high-throughput, or geo-distributed.`,
  },
  api: {
    patterns: `
- REST: Resource-oriented URLs (nouns). HTTP semantics GET/POST/PUT/PATCH/DELETE. Status codes: 200/201/204/400/401/403/404/409/422/500.
- GraphQL: Single endpoint, DataLoader for N+1 batching. Persisted queries for production.
- gRPC: Binary Protobuf for internal services. Strongly typed contracts. Not browser-compatible without gRPC-web.
- Rate limiting: Token bucket or sliding window. Return 429 with Retry-After header. Apply per user, IP, and route.
- Idempotency: All mutating endpoints accept Idempotency-Key. Store results with TTL to allow safe retries.`,
    pitfalls: `
- Chatty APIs — aggregate server-side rather than requiring multiple client round-trips.
- Exposing internal error details — map all errors to safe user-facing messages.
- No pagination — default page size ≤ 100; maximum ≤ 1000.
- Missing API versioning strategy — define at v1 launch; retrofitting is painful.`,
    tradeoffs: `
- REST vs. GraphQL: REST is CDN-cacheable and familiar; GraphQL reduces over/under-fetching at the cost of caching complexity.
- Sync vs. event-driven: Sync is easy to reason about; event-driven is resilient to downstream failures.`,
  },
  security: {
    patterns: `
- OWASP Top 10: Injection → parameterized queries; Broken Auth → MFA + secure sessions; XSS → CSP + output encoding; IDOR → server-side ownership checks; SSRF → allowlist outbound.
- Secrets management: Environment variables backed by a secrets manager. Never hardcode or commit secrets.
- Encryption at rest: AES-256-GCM. Enable transparent DB encryption. Envelope encryption for PII fields.
- Encryption in transit: TLS 1.3 minimum. HSTS with preload. mTLS between internal services.
- CSP: Disallow inline scripts. Nonces for dynamic content. report-uri for violation monitoring.
- Audit logging: Log auth events, permission changes, PII access with user, IP, timestamp, outcome. Immutable log.`,
    pitfalls: `
- Dependency vulnerabilities — run npm audit / pip-audit in CI. Dependabot for automated PRs.
- Missing server-side input validation — validate all inputs; never trust client data.
- Overly broad service permissions — least privilege for every service identity.
- Missing security headers — X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy.`,
    tradeoffs: `
- Defense-in-depth vs. velocity: More layers = more security and more complexity.
- E2E encryption vs. server-side processing: E2E prevents server-side search, analytics, and moderation.`,
  },
  scalability: {
    patterns: `
- Horizontal scaling: Stateless services behind a load balancer. Session state in Redis, never in-memory.
- Caching tiers: CDN (static assets, public API) → Application cache (Redis) → avoid DB query cache.
- Message queues: Decouple producers from consumers. Dead-letter queues for failed messages.
- Auto-scaling: Target-tracking on CPU/request-count. Min fleet ≥ 2 for high availability.
- DB scaling order: Vertical → read replicas → caching → sharding (last resort).
- Async processing: Move non-critical work to background jobs — email, image processing, reports.`,
    pitfalls: `
- Premature sharding — exhaust vertical and read-replica scaling first.
- Chatty synchronous inter-service calls — prefer async events for non-critical paths.
- Cache stampede — probabilistic early expiry or a distributed mutex on cache miss.
- Missing circuit breakers — fail fast with a fallback to protect downstream services.`,
    tradeoffs: `
- Monolith vs. microservices: Start monolith; extract when team/domain boundaries emerge.
- Strong vs. eventual consistency: Strong = simpler, lower throughput; eventual = higher throughput, complex conflict resolution.`,
  },
  testing: {
    patterns: `
- Test pyramid: Many unit, fewer integration, few E2E. Unit: ≥80% coverage on business logic. Integration: real DB/queue, no mocks for I/O. E2E: smoke critical user journeys.
- Contract testing: Pact for consumer-driven contracts between microservices.
- Property-based testing: fast-check (JS) / Hypothesis (Python) for complex business rules.
- CI gate: All tests pass before merge. Coverage regression blocks deployment.`,
    pitfalls: `
- Over-mocking — mocks that don't reflect production produce green CI and broken prod.
- Flaky tests — quarantine immediately; fix root cause or delete.
- Testing implementation, not behaviour — test what the code does, not how.
- No negative tests — test error cases, boundaries, and rejection scenarios.`,
    tradeoffs: `
- Test speed vs. confidence: Unit tests are fast but low confidence; E2E tests are slow but catch real integration issues.`,
  },
  deployment: {
    patterns: `
- CI/CD: Source → lint/test → build → staging → production. Automated rollback on error rate spike.
- Blue-green: Two identical production environments. Instant rollback by re-routing the load balancer.
- Canary: Route 1–5% of traffic to new version. Promote based on error rate and p99 latency.
- IaC: Terraform or Pulumi for all infrastructure. Version-controlled. Require plan review before apply.
- Containers: Immutable Docker images. Tag with git SHA. No mutable containers in production.
- Health checks: /health/live (process alive) and /health/ready (traffic ready). K8s liveness + readiness probes.`,
    pitfalls: `
- Manual production changes — all changes through CI/CD pipeline. No direct SSH to prod.
- Untested rollback — rehearse rollback in staging regularly.
- Hardcoded environment config — use environment variables or config maps; never bake config into images.`,
    tradeoffs: `
- Blue-green vs. canary: Blue-green gives clean instant rollback; canary limits blast radius.
- Serverless vs. containers: Serverless is ops-free but has cold starts; containers are predictable but need cluster management.`,
  },
  error_handling: {
    patterns: `
- Retry with exponential backoff + jitter: Base 100ms, max 30s, jitter ±25%. Retry only idempotent operations.
- Circuit breaker: closed → open (after threshold) → half-open (probing). Fail fast and degrade gracefully.
- Dead-letter queue: All failed async messages to DLQ for inspection and replay. Alert on DLQ depth.
- Structured error types: Domain error classes with machine-readable codes, safe user messages, internal metadata.
- Graceful degradation: Return cached stale data or partial response rather than hard failure.`,
    pitfalls: `
- Retrying non-idempotent operations without Idempotency-Key — can cause duplicate charges or records.
- Swallowing errors — every catch must log or re-throw.
- Missing correlation IDs — propagate trace ID through all downstream calls.`,
    tradeoffs: `
- Fail fast vs. graceful degradation: Fail fast surfaces problems; degradation gives better UX under partial failure.`,
  },
  observability: {
    patterns: `
- Structured logging: JSON with timestamp, level, trace_id, span_id, user_id, service, environment.
- Metrics — RED method: Rate, Errors, Duration (p50/p99/p999). USE for resources: Utilisation, Saturation, Errors.
- Distributed tracing: OpenTelemetry SDK. W3C TraceContext propagation. Sample 100% errors, 1–5% successes.
- Alerting: Alert on symptoms (error rate, p99 latency), not causes (CPU). Every alert needs a runbook.
- SLOs: Define availability and latency SLOs. Alert on error budget burn rate.`,
    pitfalls: `
- Logging PII or credentials — scrub before logging.
- Alert fatigue — tune thresholds; require runbooks for every alert.
- High-cardinality metric labels (user_id, raw URL paths) — causes metric explosion.`,
    tradeoffs: `
- Logs vs. metrics vs. traces: Each serves a different debugging purpose. All four pillars are needed.`,
  },
  caching: {
    patterns: `
- Cache-aside (lazy loading): Check cache, load from DB on miss, populate cache. Most common and safe.
- Write-through: Write to cache and DB simultaneously. Always consistent; adds write latency.
- TTL strategy: Short TTL (seconds–minutes) for dynamic data; long (hours–days) for stable data. Always set a TTL.
- Cache key design: Include version/tenant/locale. Document key schema. Use consistent hashing for distributed caches.`,
    pitfalls: `
- Thundering herd on expiry — probabilistic early expiry or distributed mutex on miss.
- Caching auth-sensitive responses without user scoping — include user/tenant in cache key.
- No cache versioning — add version prefix for instant global invalidation.`,
    tradeoffs: `
- Consistency vs. performance: Write-through = consistent, more DB load. Write-behind = faster, risk of lost data.`,
  },
  data_modeling: {
    patterns: `
- JSONB columns (PostgreSQL) for variable attributes instead of EAV — indexable, queryable.
- Polymorphic associations: Single table with discriminator + JSONB payload; or table-per-concrete-type.
- Soft deletes: deleted_at TIMESTAMPTZ. Filter WHERE deleted_at IS NULL.
- Temporal: valid_from + valid_until for effective dating. system_from + system_until for audit history.
- Multi-tenancy: Schema-per-tenant (strong isolation) vs. row-level with tenant_id (simpler, strict filtering required).
- UUIDs: UUIDv7 (time-ordered) or ULID to avoid B-tree index fragmentation.`,
    pitfalls: `
- Missing created_at + updated_at on every table — non-negotiable for debugging and sync.
- EAV anti-pattern — query-hostile and schema-less; use JSONB or typed columns.
- Premature normalisation of analytics data — read-optimised schemas are deliberately denormalised.`,
    tradeoffs: `
- Relational vs. document: Relational for structured ACID data; document for hierarchical or schema-flexible data.`,
  },
};

// ── Zod schemas (extracted to module scope for proper TypeScript inference) ───

const readMemorySchema = z.object({
  scope: z.enum(['same_pillar', 'all_pillars']).describe(
    'same_pillar = decisions from agents in this pillar | all_pillars = all decisions in this session'
  ),
  key: z.string().optional().describe(
    'Specific key to look up (e.g. "primary_database"). Omit to list all decisions.'
  ),
});

const writeDecisionSchema = z.object({
  key: z.string().describe(
    'Short unique key (e.g. "primary_database", "auth_strategy", "cache_layer")'
  ),
  decision: z.string().describe(
    'The concrete decision made (e.g. "PostgreSQL 16 with PgBouncer — 20 connections per service")'
  ),
  rationale: z.string().describe('1–2 sentence rationale for this decision'),
});

const flagConcernSchema = z.object({
  description: z.string().describe('Clear description of the concern and why it matters'),
  severity: z.enum(['critical', 'high', 'medium', 'low']).describe(
    'critical = blocks launch | high = significant risk | medium = should fix | low = nice to address'
  ),
  affects_pillars: z.array(z.string()).describe(
    'Pillar names affected (e.g. ["security", "production"])'
  ),
});

const lookupPatternSchema = z.object({
  domain: z.string().describe(
    'Architectural domain to look up (e.g. "authentication", "database", "security")'
  ),
  aspect: z.enum(['patterns', 'pitfalls', 'tradeoffs', 'all']).default('all').describe(
    'patterns = what to do | pitfalls = what to avoid | tradeoffs = what to weigh | all = everything'
  ),
});

const estimateComplexitySchema = z.object({
  component: z.string().describe('Name of the component or feature'),
  description: z.string().describe('Brief technical description of what it involves'),
  integrations: z.array(z.string()).optional().describe(
    'External integrations involved (e.g. ["payment gateway", "SMS provider"])'
  ),
});

// ── Types inferred from schemas ───────────────────────────────────────────────

type ReadMemoryArgs      = z.infer<typeof readMemorySchema>;
type WriteDecisionArgs   = z.infer<typeof writeDecisionSchema>;
type FlagConcernArgs     = z.infer<typeof flagConcernSchema>;
type LookupPatternArgs   = z.infer<typeof lookupPatternSchema>;
type EstimateComplexityArgs = z.infer<typeof estimateComplexitySchema>;

// ── Tool builder ──────────────────────────────────────────────────────────────
// Built per agent call to close over sessionId, pillarName, agentName, emit.

// Return type is Record<string, any> to bypass the tool() overload inference issues
// in @ai-sdk/provider-utils v5 while keeping full runtime type safety.
// Both `parameters` and `inputSchema` work at runtime; `parameters` matches Vercel AI SDK docs.
function buildAgentTools(
  sessionId: string,
  pillarName: string,
  agentName: string,
  emit?: (event: EngineEvent) => void,
): Record<string, any> {
  return {
    readMemory: {
      description: `Read architectural decisions written by other agents in this generation.
Call this at the START of your reasoning to check what peers have decided so your output is consistent.
Use scope='all_pillars' to see cross-pillar context; scope='same_pillar' for just your pillar.`,
      parameters: readMemorySchema,
      execute: async ({ scope, key }: ReadMemoryArgs): Promise<Record<string, unknown>> => {
        const pillar = scope === 'same_pillar' ? pillarName : undefined;
        const entries = agentMemory.readDecisions(sessionId, pillar, key);
        if (entries.length === 0) {
          return { found: false, message: 'No decisions recorded yet for this scope.' };
        }
        return {
          found: true,
          count: entries.length,
          decisions: entries.map(e => ({
            key: e.key,
            decision: e.value,
            made_by: `${e.pillar}/${e.agent}`,
          })),
        };
      },
    },

    writeDecision: {
      description: `Record a concrete architectural decision to shared agent memory.
Call this for EVERY key decision: technology choices, schemas, protocols, constraints, integrations.
Other agents running in parallel will read these decisions to stay consistent.`,
      parameters: writeDecisionSchema,
      execute: async ({ key, decision, rationale }: WriteDecisionArgs): Promise<Record<string, unknown>> => {
        const value = `${decision} — Rationale: ${rationale}`;
        agentMemory.writeDecision(sessionId, pillarName, agentName, key, value);
        log.debug({ sessionId, pillarName, agentName, key }, '[agent] decision written');
        emit?.({
          type: 'agent_tool_call',
          pillar: pillarName as PillarName,
          agent: agentName,
          tool: 'writeDecision',
          input: { key, decision: decision.slice(0, 80) },
        });
        return { ok: true, stored_as: `${pillarName}:${key}` };
      },
    },

    flagConcern: {
      description: `Flag a risk or cross-cutting concern for the prosecutor and other agents.
Use for issues outside your pillar's scope that could affect the overall design.
Flagging does NOT replace your full deliverable — always complete your output after flagging.`,
      parameters: flagConcernSchema,
      execute: async ({ description, severity, affects_pillars }: FlagConcernArgs): Promise<Record<string, unknown>> => {
        agentMemory.flagConcern(sessionId, pillarName, agentName, description, severity, affects_pillars);
        emit?.({
          type: 'agent_tool_call',
          pillar: pillarName as PillarName,
          agent: agentName,
          tool: 'flagConcern',
          input: { severity, description: description.slice(0, 100) },
        });
        return { ok: true, flagged: true, severity, affects_pillars };
      },
    },

    lookupPattern: {
      description: `Look up proven patterns, pitfalls, and tradeoffs for an architectural domain.
Call this BEFORE writing recommendations to ground your output in established best practices.
Domains: authentication, authorization, database, api, security, scalability, testing, deployment, error_handling, observability, caching, data_modeling`,
      parameters: lookupPatternSchema,
      execute: async ({ domain, aspect }: LookupPatternArgs): Promise<Record<string, unknown>> => {
        const norm = domain.toLowerCase().replace(/[-\s]/g, '_');
        const matchKey = Object.keys(PATTERN_KB).find(
          k => norm === k || norm.includes(k) || k.includes(norm)
        );
        if (!matchKey) {
          return {
            found: false,
            message: `Domain '${domain}' not found.`,
            available: Object.keys(PATTERN_KB).join(', '),
          };
        }
        emit?.({
          type: 'agent_tool_call',
          pillar: pillarName as PillarName,
          agent: agentName,
          tool: 'lookupPattern',
          input: { domain, aspect },
        });
        const entry = PATTERN_KB[matchKey]!;
        if (aspect === 'all') return { found: true, domain: matchKey, ...entry };
        const aspectKey = aspect as 'patterns' | 'pitfalls' | 'tradeoffs';
        return { found: true, domain: matchKey, result: entry[aspectKey] };
      },
    },

    estimateComplexity: {
      description: `Estimate implementation complexity for a component or feature.
Use before writing implementation timelines to ensure estimates are realistic.`,
      parameters: estimateComplexitySchema,
      execute: async ({ component, description, integrations = [] }: EstimateComplexityArgs): Promise<Record<string, unknown>> => {
        const lc = description.toLowerCase();
        const signals: Record<string, boolean> = {
          real_time:         /real.?time|websocket|sse|pubsub|event.?driven|live/.test(lc),
          ml_ai:             /\bml\b|machine.?learn|ai model|inference|embedding|vector/.test(lc),
          compliance:        /pci|hipaa|gdpr|sox|fips|compliance|audit|regulation/.test(lc),
          distributed:       /distributed|multiregion|multi.?tenant|sharding|federation/.test(lc),
          integration_heavy: integrations.length > 2,
          auth_complex:      /\bsso\b|\bsaml\b|oauth|ldap|federation|identity provider/.test(lc),
          high_throughput:   /million|billion|high.?volume|high.?throughput|\btps\b|\bqps\b/.test(lc),
        };
        const active = Object.entries(signals).filter(([, v]) => v).map(([k]) => k);
        const level = active.length >= 3 ? 'very_high' : active.length >= 2 ? 'high' : active.length >= 1 ? 'medium' : 'low';
        const sprintMap: Record<string, string> = { low: '1–2', medium: '2–4', high: '4–8', very_high: '8–16' };
        return {
          component,
          complexity: level,
          estimated_sprints: sprintMap[level],
          risk_drivers: active,
          recommendation: (level === 'very_high' || level === 'high')
            ? 'High complexity — recommend phased delivery, Architecture Decision Records, and a dedicated tech lead.'
            : 'Manageable complexity — standard engineering practices apply.',
        };
      },
    },
  };
}

// ── Agent runner ──────────────────────────────────────────────────────────────

export interface AgentRunResult {
  content: string;
  tokens_used: number;
  tool_calls: number;
  steps: number;
}

/**
 * Runs a single agent as a true agentic loop with tools and shared memory.
 *
 * The agent can make up to 5 LLM calls (steps). In each step it can invoke
 * any combination of the 5 agent tools. Tool calls are emitted as
 * `agent_tool_call` SSE events so the UI can display live agent activity.
 *
 * Falls back gracefully to a single plain `generateText` call if the provider
 * does not support tool calling (e.g. some OpenRouter-proxied models).
 */
export async function runAgentWithTools(
  agentName: string,
  pillarName: string,
  systemPrompt: string,
  userPrompt: string,
  config: ModelConfig,
  signal?: AbortSignal,
  onChunk?: (chunk: string) => void,
  emit?: (event: EngineEvent) => void,
): Promise<AgentRunResult> {
  const sessionId = sessionIdStorage.getStore() ?? `anon-${Date.now()}`;
  const model = getModelForConfig(config, config.proModel);
  const tools = buildAgentTools(sessionId, pillarName, agentName, emit);

  let toolCallCount = 0;
  let stepCount = 0;

  try {
    const result = await withRetry(
      () => generateText({
        model,
        tools,
        stopWhen: stepCountIs(5),
        system: systemPrompt,
        prompt: userPrompt,
        maxOutputTokens: 6000,
        temperature: 0,
        maxRetries: 0,           // withRetry owns the retry loop
        abortSignal: signal,
        onStepFinish: (step: any) => {
        stepCount++;
        const toolCalls: any[] = step.toolCalls ?? [];
        const stepText: string = step.text ?? '';

        // Count tool calls not already emitted inside their execute() function
        for (const tc of toolCalls) {
          toolCallCount++;
          log.debug({ sessionId, pillarName, agentName, tool: tc.toolName ?? 'unknown' }, '[agent] tool call');
        }

        // Post-hoc stream text of this step as chunks
        if (stepText && onChunk) {
          const CHUNK = 30;
          for (let i = 0; i < stepText.length; i += CHUNK) {
            onChunk(stepText.slice(i, i + CHUNK));
          }
        }
      },
    }),
    signal,
    `${agentName}@${pillarName}`,
  );

  const totalTokens = result.usage?.totalTokens ?? 0;

    log.debug(
      { sessionId, pillarName, agentName, steps: stepCount, toolCalls: toolCallCount, tokens: totalTokens },
      '[agent] agentic loop complete',
    );

    return { content: result.text, tokens_used: totalTokens, tool_calls: toolCallCount, steps: stepCount };

  } catch (err: any) {
    // Graceful fallback — if tool calling fails (unsupported provider), run plain text
    log.warn({ err: err?.message, agentName, pillarName }, '[agent] tool loop failed — falling back to plain generateText');
    const { generateText: plainGen } = await import('./openrouter');
    const fallback = await plainGen(
      userPrompt, config, systemPrompt,
      { model: config.proModel, max_tokens: 4096, signal, onChunk },
    );
    return { content: fallback.text, tokens_used: fallback.tokens_used, tool_calls: 0, steps: 1 };
  }
}
