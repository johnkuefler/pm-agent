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
- Fixed-destination delivery uses the existing task delivery endpoint so the bot receipt,
  result and recurrence advancement are persisted together. A later completion call cannot
  advance that occurrence again.
- Prior verified receipts are scoped to the current occurrence. Uncertain writes, including
  older ones, still block automatic replay until reconciled.
- The fallback allows eight tool rounds within its existing overall deadline; Slack
  interaction priority and the external-action safety checks remain unchanged.

The primary desktop scheduler can be stale independently of connector credentials. Inspect
`/runtime/performance`, the task's last delivery and its native attempt marker before
replaying anything. A healthy API key alone does not prove a scheduled task completed.
