# Skill: copilot-followup

## When to use this

Nora runs this once per cowork loop (hourly) when she spawns this agent in `followup` mode. Sweeps GitHub for status changes on issues and PRs created by `copilot-dispatch`, posts a Teamwork comment when the PR opens, pings the reviewer in Slack, and closes the loop on the queue.

Also: when John says "what is the dev queue doing", "status on dispatched tasks", "any PRs ready" — Nora spawns this agent in followup mode in response.

Silent unless something changed.

## Pre-flight

### Load the dispatched queue

Read `memory/copilot-queue.md`. Collect all entries with `status` in {`dispatched`, `pr-open`}. These are the items being watched. Ignore `ready`, `needs-clarification`, `skipped`, `unknown-repo`, `merged`, `closed`.

### Determine delta window

Use the timestamp of the most recent `pr-open` or status transition in the queue as the floor. If none, use the earliest `dispatched` timestamp among active items.

## Process

### 1. Sweep each active item

For each queue entry with `status: dispatched` or `status: pr-open`, query GitHub:

```bash
gh issue view N --repo OWNER/REPO --json state,assignees,linkedPullRequests
```

Possible state transitions to detect:
- `dispatched` → `pr-open`: a linked PR has been opened by the coding agent
- `pr-open` → `merged`: the PR was merged
- `pr-open` → `closed`: the PR was closed without merging (or the issue was closed without a PR)
- `dispatched` → `issue-closed-no-pr`: the GitHub issue was closed and no PR was ever linked
- `dispatched` → `stale`: more than 24 hours have passed and no PR exists yet (do NOT auto-transition; surface as a question)

For `dispatched` items: if `gh issue view N` returns `state: closed` and `linkedPullRequests` is empty, classify as `dispatched` → `issue-closed-no-pr`. Do not silently ignore it. Surface to John in the sweep post (same section as ambiguous closes). Append queue block: `status: closed`, `closed_reason: issue-closed-no-pr`, `awaiting_john_disposition: true`. This is always treated as ambiguous — no TW comment without John's call.

### 2. On `dispatched` → `pr-open`

When a linked PR is detected for the first time:

**Step A: Comment on Teamwork.** Per `connections.md`, this is the documented Teamwork-write exception (along with the original dispatch comment).

Use `twprojects-create_comment` on the original TW task. Pass `notify=false` (status update, no follower ping needed):

```
Draft PR opened: [PR URL]

Reviewer: [Reviewer name]. They will review and merge or send back.

— Posted by LimeLight's dev agent.
```

**Step B: Ping the reviewer.** Draft a Slack DM (per `connections.md`, drafts only for non-`#john-ea` channels):

```
PR is ready for review.

[PR URL]

This is the coding agent's first pass on [TW task URL]. Review it on its merits. If it is close, merge it. If it is not, close it with a comment so the queue updates.

— John (via LimeLight's dev agent)
```

**Step C: Update the queue.** Append:

```
---
id: tw-[id]
status: pr-open
pr_url: [URL]
pr_number: [N]
pr_opened: [YYYY-MM-DD HH:MM CDT]
---
```

### 3. On `pr-open` → `merged`

**Step A: Comment on Teamwork.** Pass `notify=true` (real status change, followers should see it):

```
Merged: [PR URL]

This Teamwork task is complete pending Nora's verification.

— Posted by LimeLight's dev agent.
```

**Step B: Update the queue.** Append a `status: merged` block with `merged: [timestamp]`.

**Step C: Surface in the next sweep post.** Do not draft any further outbound. The TW comment is enough.

### 4. On `pr-open` → `closed` (not merged)

A PR closed without merging can mean different things. Do NOT assume rejection. Classify the close before posting anything to Teamwork.

**Step A: Pull closing context.** Gather all available signal:

- The last comment on the PR by a human (not `app/copilot-swe-agent`). Use `gh pr view N --comments --json comments`.
- The latest review on the PR and its state (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, or none). Use `gh pr view N --json latestReviews,reviews`.
- Who closed the PR. Use `gh api repos/OWNER/REPO/pulls/N --jq '.closed_by.login'`.
- Whether the underlying issue is also closed and by whom.

**Step B: Classify the close.**

| Signal | Classification |
|---|---|
| Latest review is `CHANGES_REQUESTED` or `COMMENTED` with substantive text | **Explicit rejection.** Use the review body as the reason. |
| A non-bot human left a closing comment on the PR or the linked issue | **Explicit close with reason.** Use the comment body as the reason. |
| No comments, no reviews, PR just closed (possibly with the issue also closed by the same person within ~60 sec) | **Ambiguous close.** No conclusion about quality. Could be a test, scope change, parallel work, or silent rejection. Surface to John, do NOT auto-post to Teamwork. |
| PR closed by someone other than the listed reviewer for this dispatch | **Out-of-band close.** Always surface to John regardless of comment state. |

**Step C: Branch on classification.**

**C1. Explicit rejection or explicit close with reason:**

Post Teamwork comment using the reviewer's actual reason (no editorializing, no AI gloss). Pass `notify=true` (real status change, action may be needed):

```
The draft PR was closed without merging: [PR URL]

Reviewer note: [closing comment or review body, trimmed to 200 chars, preserving the reviewer's wording]

This task is back on the human queue.

— Posted by LimeLight's dev agent.
```

Append queue block: `status: closed`, `closed_reason: explicit-rejection` (or `explicit-close-with-reason`), `closed_reason_text: [the trimmed body]`.

**C2. Ambiguous close:**

Do NOT post a Teamwork comment. The skill's job is to track state truthfully; if we don't know why a PR closed, we don't get to invent a reason on a public task surface.

Instead:
- Append queue block: `status: closed`, `closed_reason: ambiguous`, `tw_comment_posted: false`, `awaiting_john_disposition: true`.
- Add a line to the next sweep post under a new section `*Ambiguous closes (need your call)*` with the PR URL, the TW task URL, and a one-line summary of what was in the PR diff (so John can decide without clicking). Include the prompt: `Tell me: "tw-[id]: test close" / "scope changed" / "rejected because [reason]"`.
- John's response is handled by `skills/copilot-disposition.md`, not this skill.

**C3. Out-of-band close (closed by someone other than the listed reviewer):**

Treat as ambiguous (path C2) by default, but flag in the queue block: `closed_by_unexpected: true` with the actual closer's login. This is a signal worth surfacing in the sweep post even if the reviewer later confirms it was fine.

**Step D: Pipeline-health flag.** Independent of classification, count `explicit-rejection` closes (NOT ambiguous, NOT explicit-close-with-reason) in the trailing 7 days. If 3 or more, surface in the sweep post as "pipeline review needed" with the following response path:

> Recommended actions: (1) John reviews the 3 rejected issues to identify a common pattern. (2) If the pattern is scope/complexity, consider tightening the triage criteria in `skills/copilot-intake.md` step 2. (3) If the pattern is enrichment quality (wrong files, wrong context), consider whether the pre-flight scan in intake step B needs a different search strategy for the affected repo. (4) If the pattern is repo-specific, add a note to that repo's row in `context/repo-mapping.md`. Hold off on new dispatches to that repo until the pattern is understood.

Ambiguous closes do NOT count toward this signal because they may be test or scope closes that say nothing about agent quality.

### 5. On `dispatched` for >24 hours with no PR

Coding agent has not produced output. Possible reasons: agent failed silently, repo is too complex for the issue scope, Copilot has a queue backlog.

Do NOT auto-retry. Surface in the next sweep post:

```
*Stalled dispatch*
- `tw-[id]` [task title] → [issue URL]: dispatched [time ago], no PR yet
```

If John wants to retry, he says so. The skill does not assume.

### 6. Decision: post or silent

Post to `#john-ea` if ANY of these are true since the last run:
- A PR opened (any item transitioned `dispatched` → `pr-open`)
- A PR merged
- A PR closed with explicit rejection or explicit close reason
- A PR closed ambiguously (no comment, no review)
- A PR closed by someone other than the listed reviewer (out-of-band)
- A GH issue was closed with no PR ever linked (`issue-closed-no-pr`)
- A dispatch went stale (>24hr no PR)

Stay silent if the sweep found no transitions.

### 7. Output format (when posting)

```
*Dev pipeline, [HH:MM CDT]*

*PRs opened* ([N])
- `tw-[id]` [task title] → <PR URL|owner/repo#N>, reviewer <@U-id>
- ...

*PRs merged* ([N])
- `tw-[id]` [task title] → <PR URL|owner/repo#N>
- ...

*PRs closed with reason* ([N])
- `tw-[id]` [task title] → <PR URL|owner/repo#N>: [closing reason in 1 line, preserving reviewer wording]
- ...

*Ambiguous closes (need your call)* ([N])
- `tw-[id]` [task title] → <PR URL|owner/repo#N>: closed by [login], no comment/review. PR diff was [1-line summary of files changed]. Tell Claude what happened: "test", "scope changed", "actually rejection: <reason>".
- ...

*Stalled* ([N])
- `tw-[id]` [task title] dispatched [X hours ago], no PR. <issue URL>
- ...

[Optional, if applicable]
*Pipeline note*
- [N] explicit rejections this week. Pipeline review recommended. (Ambiguous closes are not counted.)
```

Skip empty sections.

### 8. Log the run

```
[YYYY-MM-DD HH:MM CDT] copilot-followup — [N] transitions: [N] pr-open, [N] merged, [N] closed, [N] stalled. [post link or "silent"]
```

## Verification before posting

- [ ] Every PR/issue URL came from a real `gh` API call this run (not from the queue file alone; verify state is current)
- [ ] Teamwork comments are factual; no marketing, no AI tells, no em dashes
- [ ] Reviewer DMs are drafts, not sends
- [ ] Queue file has one new block per transition (append, never edit)
- [ ] Stalled-item callouts use real elapsed times, not estimates

## Hard rules specific to this skill

- **No PR review or approval.** This skill never comments on the PR itself, never approves, never merges. Reviewer is a human.
- **No coding agent retries.** Stalled dispatches surface to John, do not silently re-dispatch.
- **Teamwork comments only at confirmed state transitions with confirmed reasons.** PR-open, merged, and explicit closes are the only auto-post triggers. Ambiguous closes do NOT trigger an auto-comment; they wait for John's disposition.
- **No editorializing in Teamwork comments.** When posting a close-with-reason comment, preserve the reviewer's wording. Do not paraphrase, do not add AI gloss, do not soften criticism.
- **One DM per state transition.** Idempotent: if the queue already shows the reviewer was DM'd for this PR, do not re-draft.

## What this skill does NOT do

- Does not create issues or dispatch new work. (`copilot-intake` and `copilot-dispatch`.)
- Does not perform code review. The reviewer is a human dev.
- Does not handle issues created outside this pipeline. Only entries in `memory/copilot-queue.md` are tracked.
- Does not touch Teamwork beyond the two comment exceptions documented in `connections.md`.
