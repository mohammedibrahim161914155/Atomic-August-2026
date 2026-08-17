# Contributing to Atomic

Thank you for your interest in contributing. Atomic is a multi-agent AI
blueprint generator built on a strict event-driven architecture — the
guidelines below exist to preserve the integrity of that design.

## Before You Start

Read `README.md` (what the app does and how to run it) and `AGENTS.md` /
`CLAUDE.md` (the codebase's own operating conventions) before touching code.

## Architecture Invariants (non-negotiable)

1. **All inter-component communication flows through the event bus**
   (`src/engine/eventBus.ts`). Direct function calls between major components
   are prohibited — new features must publish and subscribe to typed events.
2. **Events are a discriminated union** (`AtomicEventType` in `eventBus.ts`).
   Adding an event type requires updating the union, the payload types, and
   any consumers.
3. **Every prompt passes through the validation gates**
   (`src/engine/validationGates.ts`) before entering the pipeline.
4. **The Governor controls concurrency.** Never add unbounded parallelism.
5. **Zero dependency on a paid LLM account in the code path.** Providers are
   user-configured; the engine never embeds keys.

## Development Setup

```bash
npm install
npm run dev          # full-stack dev (frontend + server)
npm test             # full test suite — must pass before PR
npm run lint         # type check + eslint — must be clean
npm run build        # production client + server build
```

The `test:all` script additionally runs the HTTP integration suite, which
boots the Express app in-process with supertest (no manual server start
required).

## Pull Request Checklist

- [ ] All tests pass (`npm test` and `npm run test:all`)
- [ ] `npm run lint` is clean (strict TypeScript, zero eslint warnings)
- [ ] New behavior is covered by unit tests in `src/engine/__tests__/`
- [ ] New events are added to `AtomicEventType` and typed payloads exist
- [ ] No LLM keys, secrets, or placeholder tokens in code or tests
- [ ] CHANGELOG.md updated with the change

## Code Style

- TypeScript strict mode, no `any`, no non-null assertions without a comment
- Zod schemas at every API boundary (config, events, prompts, outputs)
- Pino structured logging only — no bare `console.log` in engine code
- Error handling: classify errors explicitly (`withRetry` categories); never
  swallow failures silently

## Reporting Bugs

Open an issue with: reproduction steps, expected vs actual behavior, and the
relevant log excerpt (strip any API keys first).

## License

This project is distributed under the terms in `LICENSE`.
