# Skill: copilot-intake

## When to use this

Nora runs this once per cowork loop (hourly) when she spawns this agent in `intake` mode. Polls Teamwork for new tasks assigned to `development@limelightmarketing.com`, triages them, enriches them, and queues a dispatch proposal for John.

Also: when John says "check the dev queue", "run intake", "any new dev tasks" — Nora spawns this agent in intake mode in response.

This skill never dispatches on its own. It produces a proposal. Dispatch happens via `skills/copilot-dispatch.md` after John approves and Nora spawns the dispatch mode.

## Pre-flight

### Determine the delta window

Read `memory/copilot-queue.md`. Find the most recent `created` field in the file. The `created` field is **only present on initial intake blocks** (those written by this skill with `status` in `ready | needs-clarification | skipped | unknown-repo`). State-transition blocks (`dispatched`, `pr-open`, `merged`, `closed`, `stale`) do not have a `created` field and must be skipped when scanning. That most recent `created` timestamp is the start of the window. Now is the end. If no `created` field exists anywhere in the file, treat the window as the last 24 hours.

### Load mapping

Read `context/repo-mapping.md`. This is the source of truth for TW project → GH repo. If the file is missing or empty, surface the issue and stop.

## Process

### 1. Pull new Teamwork tasks

Use the `twprojects-list_tasks` tool with filters that return tasks:
- Assigned to user `development@limelightmarketing.com` (look up the user ID first via `twprojects-list_users` if needed; cache it in `memory/agent-config.md` after the first run)
- Created after the delta-window start

Per `connections.md`, Teamwork is Nora's territory and the EA agent has read-only posture there. This skill reads only; the only Teamwork write is a comment on the task AFTER dispatch (done by `copilot-dispatch`), not here.

For each task, fetch full content via `twprojects-get_task` so you have the description body to triage on.

**Dedup guard.** Before triaging a task, check whether its `tw-[id]` already appears in `memory/copilot-queue.md` with a status of `ready`, `dispatched`, `pr-open`, `merged`, or `closed`. If it does, skip it entirely (do not append a new entry, do not include in the Slack post). A task already in the active or completed pipeline does not need re-triaging. Only re-triage if the existing status is `needs-clarification`, `skipped`, or `unknown-repo`, and only if the task was updated in Teamwork after the queue entry's `created` timestamp.

### 2. Triage every task

Classify each task into one of four buckets:

| Bucket | Criteria | Action |
|---|---|---|
| **Ready** | Clear bug or small enhancement. Reproducer or expected behavior is obvious from the description. Scope is bounded (one feature, one screen, one bug). | Enrich and queue. |
| **Needs clarification** | Symptom described but no repro steps. Or the ask is ambiguous ("the page is broken"). Or scope is unclear. | Queue with `status: needs-clarification` and a one-line note on what is missing. Do not enrich. |
| **Out of scope** | Strategy, design, content writing, anything not bug/code. Or it is a duplicate of an existing open queue item. | Queue with `status: skipped` and the reason. Comment is NOT posted to TW for skipped items. |
| **Unknown repo** | Task content does not match any row in `context/repo-mapping.md`. | Queue with `status: unknown-repo`. Surface in the Slack post for John to map. |

When in doubt between Ready and Needs-clarification, default to Needs-clarification. A wrong dispatch is worse than a delayed one.

### 3. For "Ready" tasks: enrich

For each Ready task, produce a proposed GitHub issue body. Read the target repo to inform it.

**Step A: Identify the repo.** Look up the task's TW project **by exact project-name match** in `context/repo-mapping.md` (the curated, human-vetted file). The curated file always wins.

- If the project is mapped to a single repo, use that repo.
- If the project is mapped to multiple repos with routing rules (e.g., `GB - Dev Support`, `PE - Website Retainer 2026`), concatenate the TW task title and body, lowercase, and evaluate each routing rule in order. First match wins. Use the matched repo.
- If the project is mapped but the routing rules return no match AND no safe default is specified, classify the task as `unknown-repo` and surface in step 5 with reason "ambiguous repo within mapped project; need disambiguation". Do NOT pick a default repo silently.
- **If the TW project does not appear in the curated file, check the learned file** `context/repo-mapping-learned.md` (disk-only; may not exist). If the project is mapped there, use that repo BUT mark this as a learned mapping: set `mapping_source: learned` in the queue block and surface it in the step 5 proposal with `repo via learned mapping (confidence X, source Y) — confirm before approving`. The approval gate is the backstop; a learned mapping never auto-dispatches.
- If the TW project appears in neither file, classify as `unknown-repo` with reason "TW project '<name>' not in repo-mapping.md or repo-mapping-learned.md".

Reviewer and agent come from the matched row (curated or learned).

**Staleness check.** If this task already has a `ready` block in `memory/copilot-queue.md` that is more than 48 hours old (comparing `created` to now), the prior issue body's "Likely files" may be stale. Re-run step B to refresh the repo scan before writing a new issue body. Note `re-enriched: true` in the queue block.

**Step B: Pre-flight scan the repo.** Use `gh` CLI (or GitHub MCP if available) to:
- List recent commits (`gh api repos/OWNER/REPO/commits --jq '.[0:10] | .[] | .commit.message'`) to understand active areas
- Search for likely file paths based on task content (`gh search code --repo OWNER/REPO 'keyword'`)
- Read 1-3 candidate files to confirm the lead

Capture the top 2-3 file paths most likely to be relevant. These go into the issue body as a hint, not as a directive.

**Step C: Write the issue body.** Use this template:

```
## Context
[2-3 sentences pulling the relevant background from the TW task and any related thread. Plain English, not PM-speak.]

## Expected behavior
[What should happen.]

## Actual behavior
[What is happening. Include error messages verbatim if present in the TW task.]

## Steps to reproduce
[Numbered list if the TW task contains them. If not, write "Not provided in source; agent: please confirm before changing code."]

## Likely files
[2-3 file paths from the pre-flight scan. Mark them as hints, not directives.]
- `path/to/likely/file.ts`
- `path/to/other/file.ts`

## Acceptance criteria
- [ ] [Restate the desired outcome as a checkable item]
- [ ] Existing tests still pass
- [ ] [Any repo-specific criteria from repo-mapping notes]

## Source
Teamwork task: [URL to the TW task]
```

Do not include anything in the issue body that does not exist in the TW task or the repo. No invented context. No invented metrics.

### 4. Append to the queue

For each task processed (any status), append an entry to `memory/copilot-queue.md`. Format:

```
---
id: tw-[teamwork-task-id]
created: [YYYY-MM-DD HH:MM CDT]
status: ready | needs-clarification | skipped | unknown-repo
tw_url: [Teamwork task URL]
tw_title: [Teamwork task title]
target_repo: [owner/name, or empty if unknown]
reviewer: [Slack user ID, or empty]
agent: copilot | claude-code (from repo-mapping; empty for non-ready)
issue_body: |
  [the full issue body from step 3, only for status=ready]
notes: [one-line reason for needs-clarification / skipped / unknown-repo]
---
```

This is the audit log. Every TW task that hits this skill produces exactly one entry, even if the action is "skip".

### 5. Build the Slack proposal

Post a single message to John's EA channel (`C0B2YH78281`) with all proposals from this run. Use `slack_send_message` (authorized for this channel per `connections.md`).

Template:

```
*Dev intake, [HH:MM CDT]*

*Ready to dispatch* ([N])
- `tw-[id]` [task title] → [owner/repo] (reviewer: <@U-id>, agent: [copilot|claude-code])
  > [one-line summary of the issue body]
  > To ship: tell Claude "dispatch tw-[id]"
- ...

*Needs clarification from the PM* ([N])
- `tw-[id]` [task title]: [what is missing]
- ...

*Unknown repo* ([N])
- `tw-[id]` [task title]: project "[TW project]" is not in repo-mapping.md
- ...

*Skipped* ([N])
- `tw-[id]` [task title]: [reason]

Queue state: memory/copilot-queue.md
```

Skip empty sections. If everything in this run was skipped or empty, do not post; log only.

### 6. Decision: post or silent

Post if any bucket has at least one item that needs John's attention (ready, needs-clarification, unknown-repo). Stay silent if the run was 0 new tasks, or only skipped (duplicates / out-of-scope).

Logging always happens (step 7).

### 7. Log the run

Append one line to `memory/run-log.md`:

```
[YYYY-MM-DD HH:MM CDT] copilot-intake — [N] new tasks: [N] ready, [N] need-clarification, [N] unknown-repo, [N] skipped. [post link or "silent"]
```

## Verification before posting

- [ ] Every "ready" issue body cites the Teamwork task URL as source
- [ ] No invented files in "Likely files" (every path was actually confirmed in the repo)
- [ ] No invented metrics or error messages
- [ ] Reviewer Slack ID is from `context/repo-mapping.md`, not invented
- [ ] No em dashes anywhere
- [ ] Queue file has one entry per task processed (no duplicates, no gaps)
- [ ] Slack post explicitly tells John how to dispatch (the "tell Claude" line)
- [ ] Nothing was created in GitHub. Nothing was commented on Teamwork. This skill is read-only on both systems.

## Hard rules specific to this skill

- **No autonomous dispatch.** Never call `gh issue create` or any GitHub write. Dispatch is `copilot-dispatch`, gated on John's go-ahead.
- **No Teamwork writes.** Per `connections.md`, Teamwork is read-only for this agent. The post-dispatch TW comment happens in `copilot-dispatch`, not here.
- **No issue creation on `unknown-repo` items.** Surface them; let John add the mapping row first.
- **Voice rules apply to the issue body.** No AI tells, no em dashes, plain technical English. The issue body is going to live in a public-ish (internal) GitHub repo, so it represents John's team.

## What this skill does NOT do

- Does not create GitHub issues. (`copilot-dispatch` does that.)
- Does not comment on Teamwork. (`copilot-dispatch` does that.)
- Does not chase down clarification from PMs. Surfaces the gap; John or the PM decides what to do.
- Does not retry "needs-clarification" items automatically. If the TW task gets updated with more detail, the next intake pass picks it up.
- Does not handle Teamwork Desk (support tickets). Only Teamwork Projects tasks.

## Template for memory/copilot-queue.md (first-run)

If the file does not exist, create it with this header:

```
# Copilot dispatch queue

Append-only log of every TW task that hit copilot-intake. One block per task. Entries are not edited in place; status transitions are new blocks with the same id.

Statuses: ready | needs-clarification | unknown-repo | skipped | dispatched | pr-open | merged | closed

See skills/copilot-intake.md and skills/copilot-dispatch.md for the schema.

---
```
