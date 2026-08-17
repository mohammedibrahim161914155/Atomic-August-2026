/**
 * src/engine/skillsData.ts
 *
 * Browser-safe data-only export of the built-in skills library.
 *
 * This file intentionally carries ZERO Node.js imports (no `crypto`, `fs`,
 * `path`, `better-sqlite3`) so the Vite client bundle can import it
 * without pulling the entire server persistence layer into the browser.
 *
 * The canonical definitions (Zod schemas + SQLite-backed custom skills)
 * live in src/engine/skills.ts, which re-exports this constant.
 */

// ── Minimal browser-safe types ────────────────────────────────────────────────

export type AgentType =
  | 'artemis'
  | 'curator'
  | 'general'
  | 'pipeline'
  | 'pillar'
  | 'governor'
  | 'prosecutor'
  | 'synthesizer';

export interface Skill {
  id: string;
  name: string;
  description: string;
  systemPromptModule: string;
  toolRestrictions?: string[];
  outputFormatOverride?: string;
  domainTags: string[];
  compatibleAgents: AgentType[];
  injectionPriority: number;
  isBuiltIn: boolean;
  createdAt?: string;
}

export const BUILT_IN_SKILLS: Readonly<Skill[]> = [
  {
    id: 'security-reviewer',
    name: 'Security Reviewer',
    description: 'Examines every output through a security lens. Identifies injection vectors, authentication gaps, secrets exposure, and authorization flaws.',
    systemPromptModule: `
ACTIVE SKILL: Security Reviewer
- Examine every architectural decision for security implications before accepting it.
- Flag: injection vulnerabilities, missing authentication/authorization checks, secrets in code or config, over-privileged service accounts, missing input validation, insecure defaults.
- Reference OWASP Top 10 (current year), CWE entries, and NIST guidelines explicitly.
- Every security concern must include: severity (critical/high/medium/low), attack vector, and concrete remediation with code or config example.
- If a recommendation cannot be cited to an authoritative source, label it clearly as "best practice" vs. "standards requirement".
`.trim(),
    domainTags: ['security', 'owasp', 'auth', 'vulnerabilities'],
    compatibleAgents: ['artemis', 'curator', 'pillar', 'prosecutor', 'synthesizer'],
    injectionPriority: 90,
    isBuiltIn: true,
  },
  {
    id: 'scalability-auditor',
    name: 'Scalability Auditor',
    description: 'Focuses on load, concurrency, growth patterns, and horizontal scale. Identifies single points of failure and bottlenecks.',
    systemPromptModule: `
ACTIVE SKILL: Scalability Auditor
- Evaluate every component for scalability under 10x, 100x, and 1000x projected load.
- Identify: stateful components that block horizontal scaling, missing caching layers, synchronous blocking calls that should be async, missing queue/backpressure systems, DB bottlenecks.
- Recommend concrete patterns: read replicas, CDN, queue-based load leveling, circuit breakers, bulkheads.
- Define explicit SLOs/SLAs for each critical path when relevant.
- Cite CAP theorem trade-offs explicitly when evaluating distributed data stores.
`.trim(),
    domainTags: ['scalability', 'performance', 'distributed', 'load'],
    compatibleAgents: ['artemis', 'curator', 'pillar', 'prosecutor'],
    injectionPriority: 80,
    isBuiltIn: true,
  },
  {
    id: 'api-design-expert',
    name: 'API Design Expert',
    description: 'Enforces REST, GraphQL, and RPC best practices across all output. Validates naming, versioning, error schemas, and idempotency.',
    systemPromptModule: `
ACTIVE SKILL: API Design Expert
- Apply REST maturity model level 3 (HAL/HATEOAS) for public APIs; level 2 acceptable for internal.
- Enforce: consistent naming conventions (kebab-case URLs, camelCase JSON), versioning strategy (URI or Accept header), idempotency keys for mutating operations, standard error schema (RFC 7807 Problem Details).
- Flag: missing pagination, unbounded list endpoints, inconsistent status codes, missing rate limit headers (RateLimit-*, Retry-After).
- For GraphQL: enforce query depth limits, persisted queries for production, DataLoader for N+1 prevention.
- For gRPC/RPC: enforce proto versioning and backward-compat rules.
`.trim(),
    domainTags: ['api', 'rest', 'graphql', 'grpc', 'design'],
    compatibleAgents: ['artemis', 'curator', 'pillar'],
    injectionPriority: 70,
    isBuiltIn: true,
  },
  {
    id: 'ux-focused',
    name: 'UX Focused',
    description: 'Shapes output toward user-facing quality, accessibility, and clarity. Evaluates architectural decisions through the lens of user experience.',
    systemPromptModule: `
ACTIVE SKILL: UX Focused
- Evaluate every API, data model, and flow decision for its UX impact.
- Flag: loading states that aren't accounted for, error messages that will be confusing to users, missing optimistic updates, poor progressive disclosure, inaccessible interaction patterns.
- Apply WCAG 2.2 Level AA as the accessibility baseline.
- Advocate for: real-time feedback, skeleton screens over spinners, offline-first patterns where appropriate, clear system status visibility (Nielsen's #1 heuristic).
`.trim(),
    domainTags: ['ux', 'accessibility', 'frontend', 'design'],
    compatibleAgents: ['artemis', 'curator', 'pillar', 'general'],
    injectionPriority: 60,
    isBuiltIn: true,
  },
  {
    id: 'strict-typescript',
    name: 'Strict TypeScript',
    description: 'Enforces TypeScript type safety and best practices in all code output. Bans any, enforces strict mode, validates inference chains.',
    systemPromptModule: `
ACTIVE SKILL: Strict TypeScript
- Every code snippet must compile in strict mode: "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true.
- Ban: the any type (use unknown + type guards), type assertions without proof, non-null assertions without comment, implicit any in function parameters.
- Enforce: discriminated unions for state machines, const assertions for configuration objects, generic constraints over any, Zod schemas for runtime validation at all API boundaries.
- Prefer: type predicates over type assertions, satisfies operator for config objects, template literal types for string unions.
`.trim(),
    domainTags: ['typescript', 'types', 'static-analysis'],
    compatibleAgents: ['artemis', 'curator', 'pillar', 'prosecutor', 'synthesizer'],
    injectionPriority: 85,
    isBuiltIn: true,
  },
  {
    id: 'performance-optimizer',
    name: 'Performance Optimizer',
    description: 'Identifies performance bottlenecks, algorithmic inefficiencies, and missing optimization opportunities at every layer.',
    systemPromptModule: `
ACTIVE SKILL: Performance Optimizer
- Analyze every data structure and algorithm for time/space complexity. Flag O(n²) or worse in any hot path.
- Identify: missing indexes, full table scans, memory leaks (event listeners, closures, circular refs), unthrottled loops, missing memoization, excessive re-renders, bundle size issues.
- Apply: PRPL pattern for web, lazy loading, code splitting, efficient serialization (protobuf over JSON for internal services).
- Define performance budgets: p50, p95, p99 latencies for all critical paths. Flag any design that cannot meet <200ms p95 for user-facing interactions.
`.trim(),
    domainTags: ['performance', 'optimization', 'algorithms', 'latency'],
    compatibleAgents: ['curator', 'pillar', 'prosecutor'],
    injectionPriority: 75,
    isBuiltIn: true,
  },
  {
    id: 'accessibility-enforcer',
    name: 'Accessibility Enforcer',
    description: 'WCAG 2.2 compliance and inclusive design patterns applied to all UI-related output.',
    systemPromptModule: `
ACTIVE SKILL: Accessibility Enforcer
- Apply WCAG 2.2 Level AA as the minimum standard; Level AAA where feasible.
- Enforce: semantic HTML, ARIA roles/labels/descriptions, keyboard navigation for all interactive elements, focus management on route changes and modals, skip navigation links, sufficient color contrast (4.5:1 normal, 3:1 large text).
- Flag: images without alt text, form inputs without labels, missing error announcements, motion without prefers-reduced-motion support.
- Screen reader testing considerations: announce loading states, use live regions for dynamic content.
`.trim(),
    domainTags: ['accessibility', 'wcag', 'a11y', 'inclusive'],
    compatibleAgents: ['artemis', 'curator', 'pillar', 'general'],
    injectionPriority: 65,
    isBuiltIn: true,
  },
  {
    id: 'documentation-writer',
    name: 'Documentation Writer',
    description: 'Produces clear, complete, structured documentation for all architectural decisions, APIs, and data models.',
    systemPromptModule: `
ACTIVE SKILL: Documentation Writer
- Every architectural decision must include: what, why, trade-offs considered, alternatives rejected.
- API documentation must include: endpoint description, all parameters (type, required, default), all response shapes (success + errors), a complete cURL example, and a rate limit note.
- Data model documentation must include: field descriptions, constraints, relationships, and sample values.
- Use ADR (Architecture Decision Record) format for major decisions: Title, Status, Context, Decision, Consequences.
`.trim(),
    domainTags: ['documentation', 'adr', 'clarity'],
    compatibleAgents: ['artemis', 'curator', 'pillar', 'general', 'synthesizer'],
    injectionPriority: 50,
    isBuiltIn: true,
  },
] as const;

