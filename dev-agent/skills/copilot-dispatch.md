# Skill: copilot-dispatch

## When to use this

Nora spawns this agent in `dispatch tw-[id]` mode after she has confirmed John's approval. John approves by saying "dispatch tw-[id]", "ship tw-[id]", "go on tw-[id]", or any variant referencing a queue id from `memory/copilot-queue.md`, in the dev channel or directly to Nora. Nora reads those approvals from Slack and spawns this agent with the specific id(s).

John may also say "dispatch all ready" to bulk-approve everything in the current queue with `status: ready`. When Nora relays a bulk approval, confirm the count first ("you're approving 5 items, confirm?") before acting — Nora surfaces that confirmation back to John.

This skill is the gated action layer. `copilot-intake` produces proposals; this skill ships them. The approval gate is unchanged by the orchestration: no dispatch without John's explicit go-ahead, now relayed through Nora.

## Pre-flight

### Read the queue entry

Open `memory/copilot-queue.md`. Find the entry matching the requested id (e.g., `tw-12345`). Confirm `status: ready`. If status is anything else, refuse and explain.

### Idempotency check

Before any write, search the target repo for an existing open issue with `[tw-<id>]` in the title:

```bash
gh issue list --repo OWNER/REPO --state open --search "[tw-<id>]" --json number,title,url
```

If a match is found, do NOT create a second issue. Surface the existing issue URL to John and ask whether to re-use it or close it and re-dispatch. A duplicate issue confuses the coding agent and splits the PR trail.

### Confirm the dispatch payload with John

Before any write, echo back the key facts in a single line:

> Dispatching `tw-12345`: issue → `owner/repo`, agent `copilot`, reviewer `<@U0XXX>`. Confirm?

Wait for affirmative ("yes", "go", "ship it"). If anything in the payload looks wrong (repo, reviewer, agent), let John correct it before proceeding.

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

If the queue entry says `agent: claude-code`, use the Anthropic remote-agent dispatch path instead of `--assignee @copilot`. The exact mechanism depends on which remote-agent product is enabled on the account. If not verified, stop and ask John before proceeding. Do NOT improvise (no spinning up a Chrome session to drive claude.com manually).

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

Send a DM to the reviewer (the Slack user ID from the queue entry). Use `slack_send_message_draft` to land it as a draft for John to send. Per `connections.md` we do not auto-send DMs to other team members.

Draft template:

```
Heads up: [coding agent] is taking a first pass at this dev task.

- Teamwork: [TW task URL]
- GitHub issue: [GH issue URL]
- Repo: [owner/name]

When the draft PR opens, you are the reviewer. I will ping again with the link.

— John (via LimeLight's dev agent)
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
slack_dm_draft_id: [the draft ID for John's reference]
---
```

Append, do not edit in place. The queue file is an event log.

### 5. Confirm to John

Post a short confirmation in the channel John used to invoke this skill (typically chat in Claude Code, or `#john-ea` if John triggered via a Slack-based interaction):

```
*Dispatched tw-[id]*
- Issue: <gh_issue_url|owner/repo#N>
- Teamwork comment posted
- Reviewer ping drafted in your Slack drafts (review and send)
```

Three lines. No more.

### 6. Log the run

Append to `memory/run-log.md`:

```
[YYYY-MM-DD HH:MM CDT] copilot-dispatch — tw-[id] → owner/repo#N, agent=[copilot|claude-code]. [issue URL]
```

## Verification before any write

- [ ] Queue entry exists and `status: ready`
- [ ] John gave explicit "go" in the chat (or Slack message) — not inferred, not implied
- [ ] Repo is in `context/repo-mapping.md` (re-verify; do not trust the queue entry alone)
- [ ] Reviewer Slack ID resolves to a real user (sanity check via `slack_search_users` if uncertain)
- [ ] Issue body cites the TW task URL as source
- [ ] No invented context or files in the issue body

## Hard rules specific to this skill

- **One TW comment per dispatch.** Idempotent: if the queue shows the dispatch already happened, refuse to re-dispatch.
- **Reviewer DM is a draft, never a send.** Per `connections.md`, only `#john-ea` is auto-send authorized.
- **No issue edits after creation.** If the issue needs changes, John or the reviewer handles it in GitHub.
- **No PR creation.** That is the coding agent's job. This skill only creates the issue and assigns the agent.

## What this skill does NOT do

- Does not poll for PR status after dispatch. `copilot-followup` handles that.
- Does not run the original TW triage. That is `copilot-intake`.
- Does not handle non-Ready queue items. If John says "dispatch tw-X" and the entry is `needs-clarification`, refuse and explain.
- Does not touch any system outside GitHub (one write), Teamwork (one comment), and Slack (one draft).
