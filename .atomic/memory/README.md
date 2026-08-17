# Atomic Memory Bank

This directory stores session summaries produced by completed pipeline runs. The Governor reads all summaries before decomposing new tasks, giving the pipeline accumulative project knowledge across separate runs.

## File Format

Each session writes a `session-<id>.md` file after completion:

```markdown
---
session_id: <uuid>
prompt: <original user prompt>
completed_at: <ISO timestamp>
quality_score: <0-100>
pillars_completed: <list>
---

## Intent
<GovernorIntent summary>

## Key Decisions
<bullet list of architectural decisions from writeDecision tool calls>

## Flagged Concerns
<concerns from flagConcern calls that survived to the final blueprint>

## Output Summary
<one-paragraph summary of the generated blueprint>
```

## Usage

The Governor's system prompt includes:

```
<memory_bank>
{{memory_bank_summaries}}
</memory_bank>
```

If this project has been blueprinted before, prior architectural decisions inform the new run — preventing repeated mistakes and maintaining consistency across related blueprints.

## Retention

Session summaries older than 90 days are automatically pruned. Only the 50 most recent summaries are injected into the Governor context to stay within token budget.
