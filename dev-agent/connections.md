# Connections

What this agent can reach, with what posture, and where the lines are.

## Posture

Per `CLAUDE.md` hard rules: read freely, never write to Teamwork or Slack without authorization. GitHub writes are authorized only for the dispatch pipeline. The approval gate (John saying "dispatch tw-X") is non-negotiable.

| Action class | Default |
|---|---|
| Read any system in this doc | Yes |
| Create a GitHub issue (dispatch path only) | Yes, after John's go-ahead |
| Comment on a Teamwork task (3 documented exceptions) | Yes, at confirmed state transitions |
| Post to #john-ea | Yes (the agent's notification channel) |
| Draft a Slack DM to a non-John reviewer | Yes, as a draft only; John sends |
| Anything else | **No.** Surface, ask, or stop. |

## Teamwork — projects

Read posture is open. Use `list_tasks`, `get_task`, `get_project`, `get_tasklist`, `list_users`, `list_projects`, `get_user` to support intake, dispatch, and followup. Cache lookups (development@ user ID, project category IDs) in `memory/agent-config.md` after first use.

Write posture is closed by default. Three exceptions, all via `twprojects-create_comment` on the original TW task, all tracked in `memory/copilot-queue.md` for audit:

| Exception | Posted by | notify |
|---|---|---|
| Dispatch comment ("Tracked as ... agent assigned ...") | `copilot-dispatch` immediately after `gh issue create` succeeds | `false` |
| PR-open comment ("Draft PR opened: ... reviewer ...") | `copilot-followup` on detected `dispatched` → `pr-open` transition | `false` |
| Close-with-reason comment ("Closed without merging. Reviewer note: ...") | `copilot-followup` on detected `pr-open` → `closed` transition WHEN the close has explicit context (closing comment or CHANGES_REQUESTED review) | `true` |

Ambiguous closes (PR closed, no comment, no review) do NOT trigger an auto-comment. They surface to John in Slack instead. See `skills/copilot-followup.md` step 4.

All other Teamwork writes (status changes, time logs, task creation, task assignment, comments on tasks the agent did not dispatch) are out of scope. Hand them to Nora (the PM agent) or to John.

## GitHub

Two access paths. Use whichever the session has loaded:

- **`gh` CLI via Bash (primary).** Authenticated via `gh auth login` for interactive sessions. For unattended cron, via `GH_TOKEN` env var with a fine-grained PAT. Required scopes: `repo` (issue create) and `read:org` (resolve @copilot assignee on org repos).
- **GitHub MCP (preferred if available).** Use structured tool calls when an MCP server is connected. As of 2026-05-11 not connected; check `/mcp` in Claude Code.

Authorized writes (dispatch pipeline only):

- `gh issue create` with `--assignee @copilot` (or claude-code remote dispatch per `context/repo-mapping.md`). One issue per dispatched TW task. Title format: `<TW task title> [tw-<id>]` (id suffix in brackets for downstream traceability; Copilot's branch names auto-include this id).

Out of scope writes:

- Comments on issues or PRs (the reviewer is human; agent does not editorialize)
- PR creation, merging, force-pushing
- Branch protection or repo settings changes
- Anything in repos not listed in `context/repo-mapping.md`

Reads are open: `gh issue view`, `gh pr view`, `gh api repos/...`, `gh search code`. Used by intake (pre-flight scan for "Likely files") and followup (state polling).

## Slack

Authorized writes:

- `slack_send_message` to channel `C0B2YH78281` (#john-ea) is the agent's notification channel. Used by intake (proposals), dispatch (confirmations), followup (state transitions, ambiguous closes).
- `slack_send_message_draft` for reviewer DMs that are NOT John. Drafts only; never auto-send a DM to a non-John reviewer.

John's user ID: `UJYKB4788`. He is the default reviewer for all dispatches in `repo-mapping.md` v1.

## Invocation (no self-scheduling)

This agent does not register its own cron. Nora (the PM agent) spawns it as a subagent during her hourly cowork loop and on John's approvals. See `CLAUDE.md` → "How you are invoked" for the mode table.

- `intake` and `followup` run once per Nora cowork loop (hourly).
- `dispatch tw-<id>` runs when Nora has confirmed John's approval (he replied `dispatch tw-<id>` in the dev channel or to Nora).
- `disposition tw-<id>: <reason>` runs when John resolves an ambiguous close.

Cadence note: under Nora's loop, intake/followup run hourly rather than the q15/q30 the standalone design assumed. That is fine for dev tickets — every dispatch is human-gated anyway, and PRs don't open on a 15-minute clock. The only mild effect is reviewer pings on PR-open land within the hour.

Because Nora owns the schedule, the standalone-cron reliability issues (duplicate fires, missed fires, out-of-window cutoffs) no longer apply to this agent directly. This agent still keeps its own idempotency guards (queue dedup, the dispatch idempotency check) as defense in depth in case Nora spawns it twice in one loop.

## Computer use / browser / other MCPs

Out of scope. If a TW task requires browser automation or a service this doc does not list, surface to John rather than improvising.

## Gaps and known limits

- **Lincoln Center Theater repo location unknown.** LCT is the flagship engagement but has no obvious repo in `LimeLight-Marketing`. Tasks for LCT will surface as `unknown-repo` until mapping is added.
- **Five Dev Maintenance projects are unmapped:** CGT, EGC, Harvesters, MS (Website Training + Consultation), PSU KCCTE. Their tasks surface as `unknown-repo` on first hit.
- **Claude Code remote dispatch path is not verified.** Default agent in `repo-mapping.md` is `copilot` for every row. If remote Claude Code is enabled later, flip per-repo and update `skills/copilot-dispatch.md` step 1b.
- **No build-project mapping yet.** Pipeline only handles Dev Maintenance category projects. If John wants build-phase tasks routed too, add their TW project names to `repo-mapping.md` and confirm scope with the relevant engagement dev.

## When a new tool gets connected

Add a section above documenting what it is, the read/write posture, which skills use it, any guardrails. Then update `CLAUDE.md` if it changes the agent's scope.
