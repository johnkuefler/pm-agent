# Skill: copilot-dispatch

## When to use this

This is the dispatch action — it ships a Ready item. It runs in three ways:

1. **Automatically during intake** for a clean Ready item (clear scope + confident *curated* repo mapping). `copilot-intake` calls this skill directly for each. Assignment to development@ plus a clean triage is the go-ahead; no separate approval.
2. **On Nora's greenlight** for a learned-mapping item she reviewed and OK'd.
3. **On an explicit team request** for a specific id ("dispatch tw-[id]", "ship tw-[id]") — e.g. to re-dispatch a held item after its blocker is resolved. Someone on the team can also say "dispatch all ready" to ship every `status: ready` item with a curated mapping at once; confirm the count back in #pm-team before bulk-acting.

This skill is the action layer. The protection is upstream (only clean Ready items reach auto-dispatch; learned mappings need Nora's eyes) and downstream (repo-existence verification here, human PR review before merge). No per-task human pre-approval.

## Pre-flight

### Read the queue entry

Open `memory/copilot-queue.md`. Find the entry matching the requested id (e.g., `tw-12345`). Confirm `status: ready`. If status is anything else, refuse and explain.

### Confirm this item is clear to dispatch

Two ways an item reaches this skill, both already cleared:
- **Auto** — `copilot-intake` triaged it Ready with a confident *curated* repo mapping. That triage IS the go-ahead; no further confirmation needed.
- **Greenlit** — it's a learned-mapping item Nora reviewed and greenlit, or someone on the team explicitly asked to dispatch this id.

Either way: confirm the queue entry's mapping source. If `mapping_source: learned` and there's no Nora greenlight recorded (`awaiting_nora_greenlight` still true), STOP — a learned mapping must not dispatch without her go-ahead. Otherwise proceed.

### Idempotency check

Before any write, search the target repo for an existing open issue with `[tw-<id>]` in the title:

```bash
gh issue list --repo OWNER/REPO --state open --search "[tw-<id>]" --json number,title,url
```

If a match is found, do NOT create a second issue. Note the existing issue URL in the queue and #pm-team post; do not re-create. A duplicate issue confuses the coding agent and splits the PR trail.

## Process

### 1. Create the GitHub issue

Use `gh` CLI via Bash:

```bash
gh issue create \
  --repo OWNER/REPO \
  --title "TITLE" \
  --body-file ISSUE_BODY_FILE \
  --assignee @copilot
```

Where:
- `TITLE` is the TW task title, trimmed to <72 chars, with `[tw-<id>]` suffix appended for traceability
- `ISSUE_BODY_FILE` is the `issue_body` from the queue entry, written to a temp file
- `--assignee @copilot` only for agent=copilot. For agent=claude-code, skip the assignee and follow the claude-code dispatch path (see step 1b).

Capture the returned issue URL.

**Temp file cleanup.** Write the issue body to a named temp file (e.g., `/tmp/tw-<id>-issue-body.md`). After `gh issue create` returns (success or failure), delete it:

```bash
rm -f /tmp/tw-<id>-issue-body.md
```

Do not leave issue bodies on disk. They may contain verbatim TW task content.

#### 1b. Claude-code remote dispatch (only if agent=claude-code)

If the queue entry says `agent: claude-code`, use the Anthropic remote-agent dispatch path instead of `--assignee @copilot`. The exact mechanism depends on which remote-agent product is enabled on the account. If not verified, stop and surface to #pm-team before proceeding. Do NOT improvise (no spinning up a Chrome session to drive claude.com manually).

### 2. Comment on the Teamwork task

Per `connections.md`, Teamwork writes are Nora's territory. This skill is the documented exception: a single comment on the task linking back to the GitHub issue. Nothing else is written to Teamwork.

Use `twprojects-create_comment` against the original TW task. Pass `notify=false` (do not ping followers): the assignee change to development@ is itself the signal; an extra notification is noise.

```
Tracked as [GitHub issue URL].

Coding agent assigned: [@copilot or remote Claude Code]. Draft PR expected shortly.

Reviewer for the PR: [Reviewer name].

— Posted by LimeLight's dev agent.
```

Keep it factual. No marketing language. No AI tells.

### 3. Ping the reviewer in Slack

Send a DM to the reviewer (the Slack user ID from the queue entry). Use `slack_send_message_draft` to land it as a draft for a human to send. Per `connections.md` we do not auto-send DMs to other team members.

Draft template:

```
Heads up: [coding agent] is taking a first pass at this dev task.

- Teamwork: [TW task URL]
- GitHub issue: [GH issue URL]
- Repo: [owner/name]

When the draft PR opens, you are the reviewer. I will ping again with the link.

— LimeLight's dev agent
```

### 4. Update the queue

Append a new block to `memory/copilot-queue.md` with the SAME `id` and the updated state:

```
---
id: tw-[id]
status: dispatched
dispatched: [YYYY-MM-DD HH:MM CDT]
gh_issue_url: [URL]
gh_issue_number: [N]
tw_comment_id: [comment ID from twprojects-create_comment response, if available]
slack_dm_draft_id: [the draft ID for reference]
---
```

Append, do not edit in place. The queue file is an event log.

### 5. Confirm in #pm-team

Post a short confirmation to **#pm-team** (`C031HHSBM1Q`). For auto-dispatches during intake, this can be rolled into the single intake summary post (don't double-post per item); for a standalone/greenlit dispatch, post its own line:

```
*Dispatched tw-[id]*
- Issue: <gh_issue_url|owner/repo#N>
- Teamwork comment posted
- Reviewer: [Reviewer name] (DM drafted for whoever sends reviewer pings)
```

Three lines. No more.

### 6. Log the run

Append to `memory/run-log.md`:

```
[YYYY-MM-DD HH:MM CDT] copilot-dispatch — tw-[id] → owner/repo#N, agent=[copilot|claude-code]. [issue URL]
```

## Verification before any write

- [ ] Queue entry exists and `status: ready`
- [ ] If `mapping_source: learned`, Nora has greenlit it (not still `awaiting_nora_greenlight`)
- [ ] Repo is in `context/repo-mapping.md` (curated) or a greenlit learned mapping — re-verify the repo exists; do not trust the queue entry alone
- [ ] Reviewer Slack ID resolves to a real user (sanity check via `slack_search_users` if uncertain)
- [ ] Issue body cites the TW task URL as source
- [ ] No invented context or files in the issue body

## Hard rules specific to this skill

- **One TW comment per dispatch.** Idempotent: if the queue shows the dispatch already happened, refuse to re-dispatch.
- **Never dispatch a learned-mapping item without Nora's greenlight.** Curated-mapping Ready items dispatch automatically; learned ones don't.
- **Reviewer DM is a draft, never a send.** Per `connections.md`, only #pm-team is auto-send authorized.
- **No issue edits after creation.** If the issue needs changes, the reviewer handles it in GitHub.
- **No PR creation.** That is the coding agent's job. This skill only creates the issue and assigns the agent.

## What this skill does NOT do

- Does not poll for PR status after dispatch. `copilot-followup` handles that.
- Does not run the original TW triage. That is `copilot-intake`.
- Does not handle non-Ready queue items. If asked to dispatch an entry that is `needs-clarification`, refuse and explain.
- Does not touch any system outside GitHub (one write), Teamwork (one comment), and Slack (one draft).
