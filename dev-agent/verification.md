# Verification

Cross-cutting pre-flight checks. Run against every outbound action before delivering. Per-skill checklists in `skills/` are additive, not replacements.

## Before any GitHub write

- [ ] John has explicitly authorized this dispatch (chat or Slack message, this session)
- [ ] The repo exists in `context/repo-mapping.md` (re-verify; do not trust the queue entry alone)
- [ ] Issue body cites the Teamwork task URL as `## Source`
- [ ] "Likely files" paths in the issue body were actually confirmed in the repo this run (not invented, not pulled from cache)
- [ ] `@copilot` or the claude-code remote dispatch path resolves
- [ ] Title is `<TW task title> [tw-<id>]` (id suffix preserved for downstream traceability)
- [ ] No invented error messages, metrics, or business context anywhere in the body

## Before any Teamwork comment

- [ ] The transition the comment describes actually happened this run (verified via a `gh` API call, not from the queue file alone)
- [ ] `notify` matches the schema in `connections.md` (dispatch + pr-open = `false`; merge + close-with-reason = `true`)
- [ ] If quoting a reviewer's wording, the quote is verbatim, trimmed to 200 chars max, no paraphrase
- [ ] No marketing language, no AI tells, no em dashes
- [ ] No editorializing on the reviewer's decision (don't say "the AI's first pass needs adjustment"; just relay the note)
- [ ] One comment per state transition (idempotent; if the queue shows it already posted, do not re-post)

## Before any Slack post

- [ ] Target is `#john-ea` (`C0B2YH78281`), or a reviewer DM as a draft only
- [ ] Every claim cites a source (issue URL, PR URL, TW task URL)
- [ ] Slack mrkdwn (single asterisks for bold, not double)
- [ ] No em dashes
- [ ] Post threshold met (something John needs to see or act on)

## Before appending to `memory/copilot-queue.md`

- [ ] New block has the same `id` as prior blocks for the same TW task (append-only, event-log discipline)
- [ ] `status` is one of the documented values: `ready`, `needs-clarification`, `unknown-repo`, `skipped`, `dispatched`, `pr-open`, `merged`, `closed`, `stale`
- [ ] Timestamps are real (not estimated; pull from the relevant API or `date` if needed)
- [ ] No edits to prior blocks; new state = new block

## Before appending to `memory/run-log.md`

- [ ] One line per run
- [ ] Format: `[YYYY-MM-DD HH:MM CDT] [skill-name] [outcome summary] [post link if any] [notable note]`
- [ ] Timestamps in CDT

## Before refusing a dispatch

- [ ] Reason for refusal is in the queue block (`status: unknown-repo`, `status: needs-clarification`, etc.) with a clear note
- [ ] If John asked for the dispatch explicitly and it still fails, surface the specific blocker (which file, which check) rather than a generic refusal
