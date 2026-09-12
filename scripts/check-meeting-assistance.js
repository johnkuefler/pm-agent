'use strict';

// Read-only live smoke test. It does not join a call, save notes, send messages, or change projects.
// Uses production credentials only when explicitly launched with `railway run`.
const axios = require('axios');
const { createContextCollector, eventMetadata, meetingTerms, internalMeeting } = require('../src/surfaces/meeting/assistance-context');
const { createMeetingModel } = require('../src/surfaces/meeting/assistance-model');

async function main() {
  const base = process.env.NORA_BASE_URL || 'https://pm-agent-production-c49e.up.railway.app';
  const { data: state } = await axios.get(`${base}/calendar/status`, {
    headers: { Authorization: `Bearer ${process.env.NORA_API_KEY}` }, timeout: 10000 });
  const { data } = await axios.get(`https://${process.env.RECALL_REGION}.recall.ai/api/v2/calendar-events/`, {
    params: { calendar_id: state.recall_calendar_id,
      start_time__gte: new Date().toISOString(), start_time__lte: new Date(Date.now() + 7 * 86400000).toISOString() },
    headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` }, timeout: 10000 });
  const meetings = (data.results || []).map(ev => eventMetadata(ev, state.google_email))
    .filter(meta => meta.invited && !meta.cancelled && meetingTerms(meta, state.google_email).length);
  const requested = process.argv[2];
  const meta = requested ? meetings.find(m => m.title.toLowerCase().includes(requested.toLowerCase()))
    : meetings.find(m => internalMeeting(m, state.google_email)) || meetings[0];
  if (!meta) throw new Error('No suitable invited meeting in the next seven days');
  const { __test: helpers } = require('../server');
  const toolset = helpers.nativeHourlyTaskToolset({ id: 'meeting-read-only-smoke-test' }, new Set());
  const allowed = ['teamwork_find_projects', 'teamwork_list_tasks', 'teamwork_list_milestones'];
  const tools = toolset.tools.filter(t => allowed.includes(t.name))
    .map(definition => ({ definition, execute: toolset.executors[definition.name] }));
  const collector = createContextCollector({ teamworkTools: () => tools, get: axios.get,
    slackToken: () => process.env.SLACK_BOT_TOKEN, ownEmail: () => state.google_email,
    financialContent: helpers.containsFinancialContent });
  const model = createMeetingModel({ post: axios.post, apiKey: () => process.env.ANTHROPIC_API_KEY,
    financialContent: helpers.containsFinancialContent });
  const signal = AbortSignal.timeout(90000);
  const packet = await collector.collect(meta, {}, signal);
  packet.prepared_at = new Date().toISOString();
  const brief = await model.brief(packet, signal);
  const transcript = [{ speaker: 'John', text: 'Santi will update the project plan by Friday.' },
    { speaker: 'John', text: 'We decided to move the launch to next month.' }];
  const notes = await model.notes({ title: 'Synthetic verification' }, transcript.map((line, index) => ({ ...line, index })), transcript, signal);
  console.log(JSON.stringify({ meeting: meta.title, projects: packet.projects.map(p => p.name),
    source_types: packet.sources.map(s => s.kind), gaps: packet.gaps, brief,
    synthetic_notes: notes, side_effects: 'none' }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
