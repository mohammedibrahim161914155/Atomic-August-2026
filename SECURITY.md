# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.x (August 2026 and later) | :white_check_mark: Active |
| 1.x (July 2026 and earlier) | :x: End-of-life |

## Reporting a Vulnerability

We take security seriously. If you discover a vulnerability in Atomic, please
report it **privately** — do not open a public issue.

Email the maintainers at the repository contact listed in this project's
`package.json`/`README.md`, or use GitHub's "Report a vulnerability"
(Advisories) feature on this repository.

You can expect:

1. An acknowledgment of your report within 72 hours.
2. A proposed remediation plan and an estimated fix timeline within 14 days.
3. Public disclosure only after a fix is released and users have had time to
   upgrade.

## Security Architecture Overview

- **No inference keys in transit or logs.** All LLM API keys are provided by
  the end user and are encrypted at rest (`CONFIG_ENCRYPTION_KEY`, 32-byte hex)
  in the SQLite-backed KV store. They are never written to log files.
- **Strict input sanitization.** Every prompt payload passes through
  `inputSanitizer.ts`, which strips injection patterns across all agents
  before content reaches any LLM provider.
- **Governed concurrency.** The Governor caps simultaneous generations
  (`MAX_CONCURRENT_GENERATIONS`, default 3) and enforces per-session rate
  limits to prevent resource exhaustion.
- **Provider allow-list.** Only validated, allow-listed LLM provider slugs
  are accepted; placeholder and malformed API keys are rejected at config
  validation time.
- **CORS origin enforcement.** `ALLOWED_ORIGIN` restricts browser access to
  an exact origin; mismatched origins are rejected before any payload is
  processed.
- **Resilient provider calls.** All provider requests run through `withRetry`,
  which classifies errors (auth / content-filter / rate-limit / transient)
  and applies per-category retry budgets with exponential backoff and jitter.
- **Non-root container execution.** The production Docker image runs as an
  unprivileged user with a read-only workspace layout where possible.
