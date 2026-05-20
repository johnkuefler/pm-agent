# Connections

What this agent can reach, with what posture, and where the lines are.

## Identity & attribution

This agent runs on the same server as Nora, sharing the same connectors. That has one important consequence: **the account an action posts under is determined by the connector's credential, not by which agent made the call.** When you `twprojects-create_comment`, the comment appears under whatever Teamwork user the MCP's API key belongs to — the same user Nora posts as, unless separate credentials are provisioned. Same for Slack (the bot token's identity) and GitHub (whoever `gh` is authenticated as).

Because the account is shared, **attribution is by signature, not by account.** Every Teamwork comment you write ends with `— Posted by LimeLight's dev agent.` so a human reading the task can tell your comments from Nora's. Never drop that signature — it is the only thing distinguishing your writes on a shared account.

Division of communication with Nora (the orchestrator):
- **You** post your own operational Teamwork comments (dispatch / PR-open / close-with-reason) and your own #pm-team updates (intake summaries, followup sweeps, ambiguous closes). You own these surfaces.
- **Nora** spawns you, greenlights learned-mapping items, and gives a one-line headline of the dev round in her end-of-run summary. She does not re-post your content.

If dedicated identities get provisioned later (a separate Teamwork user / a GitHub machine-user PAT / a dev-bot Slack app), nothing in this agent's logic changes — it's purely a credential swap on the server. The most visible one to consider first is GitHub: with a shared `gh` auth, dispatched issues show as created by whoever that token belongs to.

## Posture

Per `CLAUDE.md` hard rules: read freely, write only the authorized actions below. GitHub writes are authorized only for the dispatch pipeline. Assignment to development@ plus a clean Ready triage is the dispatch go-ahead; learned-mapping items need Nora's greenlight.

| Action class | Default |
|---|---|
| Read any system in this doc | Yes |
| Create a GitHub issue (dispatch path) | Yes, for a clean Ready item (curated mapping) or a Nora-greenlit learned-mapping item |
| Comment on a Teamwork task (3 documented exceptions) | Yes, at confirmed state transitions |
| Post to #pm-team | Yes (the agent's notification channel) |
| Draft a Slack DM to a reviewer | Yes, as a draft only; a human sends |
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

**Access is the `gh` CLI via Bash. That is the path — there is no GitHub MCP/connector in the cowork loop, so don't look for one.** The MCP registry has no GitHub server, and Anthropic's managed GitHub connector (the OAuth integration for Chat / Projects / remote Claude Code) is a separate product not present in this cowork environment.

The cowork sandbox is ephemeral: by default it has neither `gh` installed nor a token. So **Nora bootstraps GitHub access at the top of each dev round** (cowork-prompt Step 3.8 step 0): she installs `gh` if missing, fetches the PAT from Nora's server (`GET /admin/github-token` — the durable home is `GH_TOKEN` on Railway, not a sandbox env var), and runs `gh auth login --with-token`. That writes to gh's own config, so by the time you (the subagent) run, every `gh` call is already authenticated for the session.

The PAT is fine-grained, scoped to the `LimeLight-Marketing` org with Issues read/write + Contents read + Pull requests read/write + Metadata read (covers issue create + `@copilot` assignment + followup reads).

If a `gh` call fails with an auth error, the bootstrap didn't run or `GH_TOKEN` isn't set on Railway — surface that to #pm-team and stop (the dispatch can't proceed without it); don't try to find an alternate GitHub path or self-install.

Authorized writes (dispatch pipeline only):

- `gh issue create` with `--assignee @copilot` (or claude-code remote dispatch per `context/repo-mapping.md`). One issue per dispatched TW task. Title format: `<TW task title> [tw-<id>]` (id suffix in brackets for downstream traceability; Copilot's branch names auto-include this id).

Out of scope writes:

- Comments on issues or PRs (the reviewer is human; agent does not editorialize)
- PR creation, merging, force-pushing
- Branch protection or repo settings changes
- Anything in repos not listed in `context/repo-mapping.md`

Reads are open: `gh issue view`, `gh pr view`, `gh api repos/...`, `gh search code`. Used by intake (pre-flight scan for "Likely files") and followup (state polling).

## Slack

**Channel posts go out as the Nora app, not the connected Slack user.** That means posting through Nora's `/notify` HTTP endpoint (which sends via the Slack bot token), NOT the `slack_send_message` MCP tool (which posts as whatever Slack user the MCP is connected to). Nora passes you the API base URL + key when she spawns you.

Authorized writes:

- **#pm-team channel posts** (`C031HHSBM1Q`) — intake run summary, dispatch confirmations, followup transitions, ambiguous closes — via:
  ```bash
  curl -s -X POST "${BASE}/notify?key=${KEY}" -H 'Content-Type: application/json' \
    -d '{"channel":"C031HHSBM1Q","text":"<message>"}'
  ```
  This is the only Nora API endpoint you use, and only for posting to #pm-team. Do NOT touch `/memory`, `/projects`, `/tasks`, or any other Nora API surface.
- **Reviewer DMs** — `slack_send_message_draft`, drafts only; a human sends them. (A draft lands in a person's Slack and is sent by them, so the app-vs-user identity question doesn't apply here.)

Default reviewer for dispatches is whoever `repo-mapping.md` lists for the repo (`UJYKB4788` / John on v1 rows). Reviewer assignment is config, not identity — it changes per repo as the curated mapping grows.

## Invocation (no self-scheduling)

This agent does not register its own cron. Nora (the PM agent) spawns it as a subagent during her hourly cowork loop. See `CLAUDE.md` → "How you are invoked" for the mode table.

- `intake` and `followup` run once per Nora cowork loop (hourly). Intake auto-dispatches clean Ready items.
- `dispatch tw-<id>` runs on Nora's greenlight for a learned-mapping item, or on an explicit team request for a specific id.
- `disposition tw-<id>: <reason>` runs when the team resolves an ambiguous close.

Cadence note: under Nora's loop, intake/followup run hourly rather than the q15/q30 the standalone design assumed. That is fine for dev tickets — readiness triage gates dispatch, and PRs don't open on a 15-minute clock. The only mild effect is reviewer pings on PR-open land within the hour.

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
