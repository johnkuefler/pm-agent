# Selective team conversation

Nora can participate in casual conversation in #pm-team (`C031HHSBM1Q`) without an
@mention. This runs from signed Slack message events, not the hourly routine.
The Slack app must be a channel member and subscribe to `message.channels` for
public channels or `message.groups` for private channels, with matching history
scopes. An `app_mention` subscription alone does not deliver untagged messages.

Ordinary DMs, @mentions, task-detail follow-ups, and active work threads keep their
existing routing. Other plain messages in #pm-team can enter a separate social
path. It reads at most 12 recent messages from that channel or the current thread,
keeps only the last 30 minutes, and asks for either silence or a brief reply.
It has no tools, memories, private messages, linked-page fetches, or task actions.
Social replies do not join an operational thread or create a task session.

## Limits

- Unprompted contributions: at most two per Chicago calendar day, two hours apart.
- Clearly invited replies can continue without a tag. Evidence must include Nora's
  name, a reply under her message, or a second-person response to her recent post;
  the model must also judge that the message actually addresses her.
- At most two replies in a 30-minute exchange before waiting for someone to address
  Nora by name again. At least 30 seconds between replies and eight social replies
  total per day, including invited replies.
- At most one evaluation per 15 seconds, 80 per day. Overlapping events are dropped,
  not queued. These are ceilings, not targets.
- No replies to old events, bots, edits, file drops, URLs, user/broadcast mentions,
  or obvious operational requests. The model stays silent for work discussions,
  sensitive topics, frustration, and jokes nobody responded to.
- Replies stay inline in channel conversation, or inside an existing thread.

The existing financial-content scrubber applies regardless of who triggered the
reply. Financial messages are excluded from context. Output with links, mentions,
execution claims, or more than 350 characters is suppressed.

## Persistence and operations

The `slack-banter:C031HHSBM1Q` operational marker stores counters, timestamps, and
the last delivery receipt, not conversation text. Events are claimed before the
model call; allowances are reserved durably before posting as Nora's bot. An
uncertain send is never retried. Failures stay silent in Slack and emit a compact
`Slack ambient banter` server log entry. Limits survive restarts. In production the
social path waits for database hydration before accepting any events.

Set `NORA_PM_TEAM_BANTER_ENABLED=false` to disable. For an immediate operator-only
stop without deployment, set `disabled: true` on the existing marker using the
authenticated markers API, preserving its other fields. Clear that flag to resume.
No hourly task, project mapping, or new UI is involved.
