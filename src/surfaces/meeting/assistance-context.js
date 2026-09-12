'use strict';

const crypto = require('crypto');
const STOP = new Set('the and for with from weekly biweekly monthly daily meeting sync check catch up call review planning project team internal external int llm limelight marketing nora zoom google meet com org net www status session website web'.split(' '));
const PUBLIC_DOMAINS = new Set(['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com']);
const compact = (value, max = 2000) => String(value || '').replace(/<[^>]*>/g, ' ').trim().slice(0, max);
const tokens = value => [...new Set(compact(value).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [])].filter(t => !STOP.has(t));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');

function eventMetadata(event = {}, email = '') {
  const raw = event.raw || {};
  const attendees = [...(event.attendees || []), ...(raw.attendees || []),
    event.organizer, raw.organizer].filter(Boolean).map(a => ({
    email: compact(a.email || a.emailAddress?.address || a.address, 200).toLowerCase(),
    name: compact(a.displayName || a.emailAddress?.name || a.name, 150),
    declined: a.responseStatus === 'declined' || a.status?.response === 'declined',
  })).filter(a => a.email && !a.declined);
  const unique = [...new Map(attendees.map(a => [a.email, a])).values()];
  const title = compact(raw.summary || raw.subject || event.summary, 250);
  return {
    event_id: String(event.id || ''), series_id: String(raw.recurringEventId || raw.seriesMasterId || event.ical_uid || raw.iCalUID || ''),
    ical_uid: String(event.ical_uid || raw.iCalUID || ''),
    title, description: compact(raw.description || raw.body?.content || event.description, 4000),
    start: event.start_time || raw.start?.dateTime || null,
    end: event.end_time || raw.end?.dateTime || null,
    meeting_url: String(event.meeting_url || raw.hangoutLink || ''), attendees: unique,
    invited: Boolean(email && unique.some(a => a.email === email.toLowerCase())),
    cancelled: Boolean(event.is_deleted || raw.status === 'cancelled' || raw.isCancelled
      || /\[(?:no|skip)-nora\]/i.test(title)),
  };
}

function meetingTerms(meta, ownEmail) {
  const ownDomain = String(ownEmail || '').split('@')[1];
  const domains = [...new Set((meta.attendees || []).map(a => a.email.split('@')[1])
    .filter(d => d && d !== ownDomain && !PUBLIC_DOMAINS.has(d)))];
  return [...new Set([...tokens(meta.title), ...domains.flatMap(d => tokens(d.split('.')[0]))])].slice(0, 4);
}

function internalMeeting(meta, ownEmail) {
  const domain = String(ownEmail || '').split('@')[1];
  return Boolean(domain && !PUBLIC_DOMAINS.has(domain) && meta.attendees?.length
    && meta.attendees.every(a => a.email.split('@')[1] === domain));
}

function priorMatch(meta, prior) {
  if (!prior?.meta || prior.meta.event_id === meta.event_id) return false;
  // A reused room or client name is not enough to disclose a different group's conversation.
  const people = a => (a.attendees || []).map(p => p.email).sort().join(',');
  if (!people(meta) || people(meta) !== people(prior.meta)) return false;
  return Boolean(meta.series_id && meta.series_id === prior.meta.series_id)
    || (tokens(meta.title).length > 0 && compact(meta.title).toLowerCase() === compact(prior.meta.title).toLowerCase());
}

function selectProjects(candidates, terms, title = '') {
  const topicWords = text => (String(text).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [])
    .map(t => t === 'web' ? 'website' : t).filter(t => (!STOP.has(t) || t === 'website') && !terms.includes(t));
  const topics = topicWords(title);
  const matches = [...new Map(candidates.map(p => [String(p.id), p])).values()]
    .filter(p => terms.some(term => tokens(`${p.name} ${p.company}`).includes(term)))
    .map(p => ({ project: p, score: terms.reduce((score, term) => score
      + (tokens(p.company).includes(term) ? 3 : 0) + (tokens(p.name).includes(term) ? 2 : 0)
      + (String(p.name).toLowerCase().startsWith(term) ? 2 : 0), 0)
      + topics.filter(t => topicWords(p.name).includes(t)).length * 2 }));
  const groups = new Map();
  for (const match of matches) {
    const company = compact(match.project.company || match.project.name).toLowerCase();
    if (!groups.has(company)) groups.set(company, []);
    groups.get(company).push(match);
  }
  const ranked = [...groups.values()].map(group => group.sort((a, b) => b.score - a.score))
    .sort((a, b) => b[0].score - a[0].score);
  if (!ranked.length || (ranked[1] && ranked[0][0].score - ranked[1][0].score < 2)) return [];
  const best = ranked[0];
  // A distinctive topic (website versus client journey, for example) narrows an account meeting
  // to its actual project. Similar scores keep a bounded account-level view instead.
  return (best[1] && best[0].score - best[1].score >= 2 ? best.slice(0, 1) : best.slice(0, 3)).map(m => m.project);
}

function createContextCollector({ teamworkTools, get, slackToken, ownEmail, financialContent }) {
  const tool = name => teamworkTools().find(t => t.definition.name === name)?.execute;
  async function collect(meta, records, signal) {
    const email = ownEmail();
    const terms = meetingTerms(meta, email);
    const gaps = [], sources = [];
    const safe = value => JSON.parse(JSON.stringify(value, (_key, item) =>
      typeof item === 'string' && financialContent(item) ? '[Financial detail withheld]' : item));
    const read = async (label, fn) => {
      try { signal?.throwIfAborted(); return await fn(); }
      catch (error) { if (signal?.aborted) throw error; gaps.push(`${label} unavailable`); return null; }
    };
    const prior = Object.values(records).filter(r => r.notes?.status === 'ready' && priorMatch(meta, r)
      && new Date(r.meta.start).getTime() < new Date(meta.start).getTime()
      && new Date(r.meta.start).getTime() > new Date(meta.start).getTime() - 45 * 86400000)
      .sort((a, b) => String(b.meta.start).localeCompare(String(a.meta.start))).slice(0, 2);
    for (const r of prior) sources.push({ kind: 'previous_meeting', bot_id: r.bot_id,
      title: r.meta.title, at: r.meta.start, notes: safe(r.notes.result) });
    if (!terms.length && prior.length) terms.push(...tokens(prior[0].prep?.projects?.[0]?.company).slice(0, 3));
    // Unknown audiences (for example a bare pasted Zoom URL) receive no private-source preload.
    if (!meta.attendees?.length) {
      gaps.push('Calendar attendees could not be resolved; preparation uses supplied meeting context only.');
      return { meeting: safe(meta), sources, projects: [], gaps };
    }
    const find = tool('teamwork_find_projects');
    const candidates = [];
    for (const query of terms.slice(0, 3)) {
      if (!find) break;
      const result = await read('Teamwork project search', () => find({ query }, { signal, timeoutMs: 8000 }));
      if (Array.isArray(result)) candidates.push(...result);
    }
    const projects = selectProjects(candidates, terms, meta.title);
    if (!projects.length) gaps.push('No unambiguous active Teamwork client/project match.');
    for (const p of projects) {
      const rows = await read('Teamwork tasks', () => tool('teamwork_list_tasks')({ project_id: String(p.id) }, { signal, timeoutMs: 8000 }));
      const milestones = await read('Teamwork milestones', () => tool('teamwork_list_milestones')({ project_id: String(p.id) }, { signal, timeoutMs: 8000 }));
      sources.push({ kind: 'teamwork', project: safe(p), tasks: safe(rows || []), milestones: safe(milestones || []),
        coverage: 'Bounded snapshot: at most 75 tasks and 75 milestones per project; not exhaustive.' });
    }
    if (internalMeeting(meta, email) && terms.length && slackToken()) {
      let cursor = '';
      const channels = [];
      for (let page = 0; page < 3; page++) {
        const data = await read('Slack channel discovery', async () => {
          const r = await get('https://slack.com/api/conversations.list', { params: {
            types: 'public_channel,private_channel', limit: 200, exclude_archived: true, cursor },
          headers: { Authorization: `Bearer ${slackToken()}` }, timeout: 8000, signal });
          if (!r.data.ok) throw new Error(r.data.error);
          return r.data;
        });
        if (!data) break;
        channels.push(...(data.channels || []).filter(c => c.is_member && terms.some(t => tokens(c.name).includes(t))));
        cursor = data.response_metadata?.next_cursor || '';
        if (!cursor) break;
      }
      if (!channels.length) gaps.push('No matching Slack channel accessible to Nora bot.');
      for (const c of channels.slice(0, 2)) {
        const data = await read('Slack history', async () => {
          const r = await get('https://slack.com/api/conversations.history', { params: {
            channel: c.id, oldest: String((Date.now() - 14 * 86400000) / 1000), limit: 40 },
          headers: { Authorization: `Bearer ${slackToken()}` }, timeout: 8000, signal });
          if (!r.data.ok) throw new Error(r.data.error);
          return r.data;
        });
        if (data) sources.push({ kind: 'slack', channel_id: c.id, channel: c.name,
          messages: (data.messages || []).map(m => ({ ts: m.ts, text: safe(compact(m.text, 1500)) })),
          coverage: 'Latest 40 channel messages within 14 days; replies may not be included.' });
      }
    } else gaps.push('Slack preparation omitted because the attendee audience is external or unknown.');
    return { meeting: safe(meta), projects, sources, gaps };
  }
  return { collect };
}

module.exports = { compact, digest, tokens, eventMetadata, meetingTerms, internalMeeting,
  priorMatch, selectProjects, createContextCollector };
