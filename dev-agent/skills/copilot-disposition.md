# Skill: copilot-disposition

## When to use this

Someone on the team provides a disposition for a queue item with `awaiting_disposition: true`. Triggered when he says things like:

- "tw-[id] was a test close"
- "tw-[id]: scope changed"
- "disposition tw-[id]: [reason]"
- "close tw-[id], the PR was wrong because [reason]"
- Any statement resolving an ambiguous or out-of-band close surfaced by `copilot-followup`.

This skill only operates on items already in the queue. It does not triage or dispatch.

## Pre-flight

Open `memory/copilot-queue.md`. Find the most recent block for the specified `id`. Confirm it has `awaiting_disposition: true`. If not, the close is already resolved — say so and stop.

Also confirm the `pr_url` and `tw_url` are present in any prior block for this id. You will need both.

## Process

### 1. Classify the disposition

| What was said | Classification | TW comment |
|---|---|---|
| "test close", "testing", "just checking", "ignore it" | `test-close` | None |
| "scope changed", "won't fix", "not doing this", "pulled from queue" | `scope-change` | Yes, `notify=true` |
| "actually rejected because [reason]" or "the PR was wrong because [reason]" | `explicit-rejection` | Yes, `notify=true` |
| Unclear or ambiguous | Confirm interpretation before posting anything |

When in doubt, ask. A wrong TW comment on a resolved task is noise that PMs will see.

### 2. Post TW comment (scope-change and explicit-rejection only)

Use `twprojects-create_comment` on the original TW task.

**Scope change / won't fix:**

```
The draft PR was closed: [PR URL]

Not proceeding. [the stated reason, verbatim.]

This task can be closed or reassigned.

— Posted by LimeLight's dev agent.
```

**Explicit rejection:**

```
The draft PR was closed without merging: [PR URL]

Reason: [the stated reason, verbatim.]

This task is back on the human queue.

— Posted by LimeLight's dev agent.
```

**Test close:** No TW comment. Log only.

### 3. Update the queue

Append a new block with the same `id`:

```
---
id: tw-[id]
status: closed
disposition: test-close | scope-change | explicit-rejection
disposition_source: manual
disposition_note: [the stated reason verbatim, or "test close per the team"]
tw_comment_posted: true | false
resolved: [YYYY-MM-DD HH:MM CDT]
---
```

### 4. Log the run

Append to `memory/run-log.md`:

```
[YYYY-MM-DD HH:MM CDT] copilot-disposition (manual) — tw-[id] resolved as [disposition]. TW comment: [posted | skipped]. Note: [disposition_note].
```

## Hard rules

- Never post a TW comment on a test close. It creates noise on a task that was already handled.
- Never paraphrase the stated reason. Use their words.
- If the TW task was already closed by a human before this skill runs, skip the TW comment and note it in the queue block (`tw_task_already_closed: true`).
- One disposition per item. If the queue already has a block with `disposition_source: manual`, refuse and show the existing disposition.
