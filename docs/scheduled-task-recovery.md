# Scheduled task recovery

The hourly fallback executes only explicitly queued tasks. The November recovery keeps
the existing daily stage-0 sweep and biweekly agenda, without adding proactive work.

- `teamwork_sweep_unstaged_tasks` resolves the requested people/date window in one bounded
  lookup, then revalidates each stage-0 candidate and verifies its Ready to Start move.
  Missing workflow data, other stages, completed tasks and out-of-window tasks are excluded.
  Uncertain writes stop the sweep and return the affected ID without retrying.
- Calendar event reads are available with the existing read-only connection. Event writes
  still require the scheduling grant. Shared-calendar IDs are explicit, and event pagination
  is exposed. Public holidays must not be described as confirmed company closures.
- `teamwork_find_tagged_tasks` resolves exact live tag IDs and paginates tagged tasks across
  projects. It checks start OR due date inside the inclusive window, verifies active project
  status and returns the names, assignees and dates needed for the tentative report. Task detail
  and ordinary task lists also retain tag IDs/names. This tool never modifies tasks or tags.
  Missing access, unknown tags, missing membership and truncated searches fail explicitly;
  they must not become zero-match reports or completed blocker posts. The recurring tentative
  task uses the current Central Monday-Sunday window and leaves itself pending on lookup errors.
- Fixed-destination delivery ends the model loop with a memory-only result handoff. The
  scheduler persists that result and calls the task delivery endpoint with its own 15-second
  request timeout, outside the model's deadline. No extra model turn is needed to confirm it.
  Source lookups therefore cannot consume the time reserved for posting the finished message.
- A prepared result survives a restart and is bound to the exact occurrence, instructions,
  and destination. Delivery persists intent before contacting Slack, then saves the receipt
  before completing the task. Persistence errors are surfaced. A retry of an already
  delivered occurrence returns its receipt without posting or advancing the schedule again.
  Late recovery preserves the original biweekly weekday rather than shifting the cadence.
- Prior verified receipts are scoped to the current occurrence. Uncertain writes, including
  older ones, still block automatic replay until reconciled.
- Scheduled collection allows eight tool rounds within 120 seconds, with up to 30 seconds
  per model response. The recovery cycle has 180 seconds overall and a 210-second watchdog,
  inside its 300-second run lock. Live Slack reply budgets are unchanged. Other
  external writes retain their durable receipts and minimum safe start windows. Fixed
  results are delivered separately; they cannot also be posted to the origin by the model.
- Incomplete results and pending delivery retry on the next hourly recovery cycle instead
  of backing off for a full day. Attempt markers retain the error detail and occurrence.

If Slack explicitly rejects a send (for example revoked credentials), the saved result can
retry after the connection is repaired. A timeout or crash after send intent is ambiguous:
`delivery_attempt.status = sending` blocks automatic reposting. Reconcile the destination's
Slack history first. If the message exists, record its receipt; if absence is verified, reset
the attempt to `failed` before retrying. Never clear an uncertain attempt merely to force a run.

The primary desktop scheduler can be stale independently of connector credentials. Inspect
`/runtime/performance`, the task's last delivery and its native attempt marker before
replaying anything. A healthy API key alone does not prove a scheduled task completed.
