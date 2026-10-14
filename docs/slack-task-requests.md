# Specialist task requests

Specialists can mention Nora in a Slack channel or DM her to request a Teamwork task.
No channel-to-project mapping setup is required.

## Required before creation

- Clear task title and an existing active project/task list.
- Assignee. "Me" resolves against the Slack sender's email or unique exact full name in Teamwork.
- Positive estimate, stored in minutes.
- Start date and due date, with start no later than due.

Nora uses links, the thread, and live project/list lookups. If the destination is ambiguous,
she offers concrete choices. She asks for all missing details together rather than guessing
dates, estimates, a sprint or a new task list. Relative dates use America/Chicago.

Project search first tries the requested name, then checks a bounded live active-project
directory using both project and client names. This handles abbreviated project titles without
maintaining mappings. Nora offers up to three real project links as numbered choices and saves
their IDs with the pending draft. Suggestions need the requester's selection, not an automatic
assignment to the top result. Missing estimate/start/due questions go in the same reply.
Search is capped at five directory pages and eight seconds total, respects caller cancellation,
and reports incomplete coverage if capped or unavailable. No plausible match means asking for
a client, keyword or link, not inventing project names.

The `nora_task_details` tool persists a pending draft for seven days. Only replies by its
requester in that conversation bypass the generic short-message/engagement filters.
Cancellation and verified creation close the pending draft. Slack mention dedup remains intact.

## Creation and retry safety

`teamwork_create_task` validates the schedule and confirms that the task list belongs to the
active project before writing. It reads the created task back to verify title, list, assignees,
estimate and dates. The confirmation contains the task link and those details.

Slack creation claims and provider IDs are saved in the existing durable marker store, scoped
to the requester, conversation and task title. A retry reads the existing task instead of
posting again. An unknown creation outcome is held for investigation, not retried blindly.
Requests to create another same-named task in the same thread require a fresh conversation.

Batch plan tasks require the same schedule fields. Alternate Teamwork MCP create/clone task
tools are excluded from Slack so they cannot bypass the native validator and readback path.
This does not add unsolicited task creation, project sweeps or approval requirements.

## QA

`node --test test/unit/task-intake.test.js` covers missing and invalid fields, identity ambiguity,
wrong destinations, readback drift, failed persistence, uncertain writes, duplicate retries,
short replies, requester isolation, expiry/cancellation and the batch/connector bypasses.

For a manual Slack test, ask for a task without dates or an estimate, then answer Nora's
grouped question in-thread without mentioning her again. Verify all fields using her task link.

`node --test test/unit/teamwork-project-search.test.js` covers client-name fallback,
pagination/ranking, exact-name ambiguity, active-only filtering, partial search, deadlines,
and the structured-result meeting-preparation consumer.
