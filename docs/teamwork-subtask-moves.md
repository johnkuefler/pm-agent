# Moving existing tasks under a parent

In a DM or direct @Nora request, provide the source task-list link (or specific task links)
and the destination parent task link. For example:

> @Nora move all open tasks from [task-list link] under [parent task link] as subtasks.
> Keep their existing details and history.

Nora previews the live source and parent, then queues the saved selection through the existing
deferred worker. A cross-project move uses Teamwork's V1 move endpoint before V3 reparenting:
V3 alone currently rejects cross-project moves with descendants. These are updates to existing
records, never copy-and-delete operations. The task IDs, attached history and child hierarchy
stay with the tasks. Existing missing dates/estimates do not trigger task-creation intake.

When completed-task scope is unclear, Nora asks with the open/completed counts. An explicit
scope does not need a second permission round. Selected descendants move with their selected
ancestor and remain nested. The parent cannot be inside the selection. Recurring tasks are
refused because conversion can remove their repeat schedule.

Plans expire after 30 minutes and freeze the selected roots. The worker rereads location,
parent ancestry and task details before writing; it verifies the new parent/list and preserved
fields afterward. It posts verified counts and the parent link in the originating Slack thread.
Large batches run outside the Slack reply deadline, with a seven-minute execution bound and
at most 250 selected roots. Time-limited or uncertain runs explicitly report partial results.

The `subtask-move:<plan ID>` marker records execution and results. A running, stopped or partial
plan cannot be replayed. Inspect the named task after a timeout; do not blindly queue a fresh
plan for it. Re-preview the verified remaining tasks when safe. Completed plans return their
stored result without writing again. The deferred queue must be durable before accepting a move.

Validation includes isolated cross-project QA with an existing child and comment, verifying
the same task IDs, dates, estimate, comment and nested hierarchy, then removing the QA projects.

API references: [cross-project move](https://apidocs.teamwork.com/docs/teamwork/v1/tasks/put-tasks-task-id-move-json),
[task update](https://apidocs.teamwork.com/docs/teamwork/v3/tasks/patch-projects-api-v3-tasks-task-id-json).
