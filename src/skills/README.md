# Atomic Skills Directory

This directory contains domain-specific knowledge files that the Governor
can inject into pillar agents to provide specialized context.

Inspired by Kilo Code's Memory Bank pattern (Part 8.2 — Addition 4, 7).

## How Skills Work

The Governor reads all `.md` files in this directory before decomposing
a task. Skills that are relevant to the task type are injected into
pillar system prompts as additional context.

## Available Skills

| File | Domain | Description |
|------|--------|-------------|
| `authentication.md` | Security | Auth patterns, OAuth, JWT, passkeys |
| `database-design.md` | Data | Schema design, migrations, indexing |
| `api-design.md` | API | REST, GraphQL, rate limiting |
| `frontend-architecture.md` | Frontend | React, state management, accessibility |
| `devops.md` | Deployment | CI/CD, Docker, Kubernetes, observability |
| `security-hardening.md` | Security | OWASP Top-10, secrets management |
| `performance.md` | Scalability | Caching, query optimization, CDN |
| `testing-strategy.md` | Quality | Test pyramid, property-based testing |

## Creating a New Skill

1. Create a `.md` file in this directory
2. Use the frontmatter format:
   ```markdown
   ---
   skill: <skill-name>
   domains: [domain1, domain2]
   applies_to: [pillar1, pillar2]  # or "all"
   priority: high | medium | low
   ---
   ```
3. Write the skill content in Markdown
4. The Governor will auto-discover it on the next run

## Skill Format

Skills should contain:
- Concrete patterns (not vague advice)
- Specific technology choices with tradeoffs
- Anti-patterns to avoid
- Example code snippets where helpful
