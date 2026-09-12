# Meeting preparation and draft notes

The server checks invited calendar meetings every 30 seconds. When a meeting is within 15 minutes,
one bounded background job gathers context and asks Claude to prepare a brief. This is separate
from the hourly task routine. A busy Slack interaction can defer or interrupt preparation.

Normal invite titles, attendees and company email domains provide search terms. Teamwork project
and company names are ranked together with meeting topics, so a website status meeting can select
the website project instead of every project for that account. Ambiguous matches are reported as
gaps. Previous calendar-series meetings require the same attendee set and a 45-day recency window.
Historical Recall calendar records can supply previous transcripts from before this feature.

Sources are bounded: up to three project searches, three projects, two Slack channels with 40 recent
messages each, and two previous meetings. Slack reads use Nora's bot and require channel access.
Internal Slack context is omitted for external or unknown attendee audiences. Financial details
are filtered before preparation and the resulting brief is checked again before voice injection.
No general web research or cross-account inbox search runs.

GPT-Live receives a completed brief as startup history. If preparation finishes during the call,
the server sends quiet `session.thinking.append` events. It does not change the mute flag. Nora
still joins muted and speaks only after `Nora unmute` and a direct spoken question. This integration
uses the [official GPT-Live session context API](https://developers.openai.com/api/docs/guides/live-conversations).

A manual join starts without waiting for preparation. If its meeting URL matches an invited
calendar event near that time, the server can recover the title and attendees. Otherwise only
the supplied join-request context is available, and private-source preloading is skipped.

After the durable transcript is marked ended, Claude drafts a summary, decisions, proposed todos,
open questions and risks. Large transcripts are processed in segments followed by reconciliation
of later corrections. Extracted items require a quote that matches the referenced transcript line.
Owners and due-date text absent from that quote remain unconfirmed. Nothing creates a Teamwork
task or posts a Slack message automatically.

Open the meeting in the existing transcript UI to review the brief and notes. The existing
`GET /transcripts/:botId` includes `meeting`, `preparation` and `notes`; Nora's Slack transcript
reader also receives the notes. Transcript edits invalidate stale notes. Deletion removes the
stored meeting content and leaves only an ID tombstone against webhook replay.

Each stage retries at most three times with a delay. Failed preparation/notes appear in the UI;
runtime diagnostics are under `meeting_assistance` in `/runtime/performance`. State is persisted
per meeting in Postgres, with an atomic JSON-file fallback for local development. Restart loads
the latest 300 records and the calendar refresh recovers upcoming meetings.

Verification: `npm test` covers timing, repeat delivery, restarts, changed invitations, cancellations,
transcript edits, evidence validation, foreground preemption, long-meeting reconciliation and voice
context delivery. `railway run node scripts/check-meeting-assistance.js "CCKC Web Status"` is an
optional read-only live smoke test using one real upcoming invite and synthetic transcript lines.
It does not join meetings, save results, send messages or change Teamwork.
