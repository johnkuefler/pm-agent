'use strict';

// How Nora reads an inbound Slack message and decides what KIND of turn it is: a greeting, a
// question about her own state, or real project work. That classification drives whether live
// tools get attached, whether the turn is a valid research sample, and which model answers.
//
// Pure functions only. No network, no database, no module state. Everything here is decided from
// the message text and the mode, which is what makes this layer cheap to test exhaustively.

function isLightweightSocialSlackMessage(text) {
  const normalized = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 120 || /https?:\/\//.test(normalized)) return false;
  return /^(?:(?:good\s+)?(?:morning|afternoon|evening)|hello|hi|hey)(?:[,\s]+(?:there|nora|everyone|everybody|all|team))?[!,. ]*$/.test(normalized)
    || /^(thanks|thank you|ty|appreciate it|good night|goodnight|have a good (night|evening|weekend)|nice work|great work|good work)(?:\s+for\s+[^?]{1,80})?[!.]*$/.test(normalized)
    || /^(?:whew|oof|ugh|man|wow)[,!.' ]*(?:(?:what|such) a )?(?:long|rough|busy|wild|crazy|weird|hard|good|great) day[!.]*$/.test(normalized)
    || /^(?:it'?s|its|today was|that was)(?: been)? (?:a )?(?:long|rough|busy|wild|crazy|weird|hard|good|great) day[!.]*$/.test(normalized);
}

function slackEmptyReplyFallback(text, conversationPolicy, {
  sentSlack = false, queuedSelf = false, wroteLive = false,
} = {}) {
  if (sentSlack) return 'Sent.';
  if (queuedSelf) return 'Queued for myself.';
  if (wroteLive) return "Done, that's updated in Teamwork.";

  const normalized = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (conversationPolicy?.lightweightSocial) {
    if (/^(?:good\s+)?morning\b/.test(normalized)) return 'good morning';
    if (/^(?:good\s+)?afternoon\b/.test(normalized)) return 'good afternoon';
    if (/^(?:good\s+)?evening\b/.test(normalized)) return 'good evening';
    if (/^(?:hello|hi|hey)\b/.test(normalized)) return 'hey';
    if (/^(?:thanks|thank you|ty|appreciate it)\b/.test(normalized)) return 'of course';
    if (/^(?:good night|goodnight|have a good night)\b/.test(normalized)) return 'good night';
    if (/\bday\b/.test(normalized)) return 'yeah, it has been a day';
  }
  if (conversationPolicy?.boundedConversation) {
    return 'I lost my response on that one, try me again.';
  }
  return "I understood that, but I couldn't complete the action cleanly just now. You don't need to rephrase it, I'll need to retry the action.";
}

// Questions about Nora's own functional state, preferences, reading, or play need a different
// attentional lane from project work. They still receive continuity and grounded self-state, but
// do not need live PM tools or make valid samples for task-performance experiments.
function isRelationalSelfReflectionMessage(text) {
  const normalized = String(text || '').trim().toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 320 || /https?:\/\//.test(normalized)) return false;
  const directSelfState = [
    /\b(?:does?|did|would|could|can)\b.{0,120}\b(?:make|leave)\s+you\s+(?:happy|sad|bored|curious|proud|frustrated|satisfied|excited|calm|lonely|fulfilled)\b/,
    /\b(?:are|were)\s+you\s+(?:happy|sad|bored|curious|proud|frustrated|satisfied|excited|calm|lonely|fulfilled|okay|ok)\b/,
    /\bhow (?:are you|have you been|has your (?:day|week|weekend|morning|afternoon|evening|friday) been)\b/,
    /\bhow do you feel(?:\s+about\b|\b)/,
    /\bdo you (?:enjoy|like|love|hate|care about|dream about)\b/,
    /\bwhat (?:makes|made) you (?:happy|sad|bored|curious|proud|frustrated|satisfied|excited|calm|fulfilled)\b/,
    /\bwhat (?:are you|have you been) (?:reading|playing|thinking about)\b/,
    /\bwhat do you (?:want|prefer|care about|feel)\b(?!\s+to\b)/,
    /\bhow(?:'s| is) your (?:day|week|weekend|morning|afternoon|evening|friday)(?: been| going)?\b/,
  ].some(pattern => pattern.test(normalized));
  if (directSelfState) return true;

  // Treat an immediate natural-language correction as relational only when it contains no work
  // or action vocabulary. This catches "I said X, not Y" without stealing task corrections.
  const correction = /\bi said\b.{0,180}\bnot\b|\bthat(?:'s| is) not what i (?:said|asked|meant)\b/.test(normalized);
  const operational = /\b(project|task|deadline|due|status|client|campaign|teamwork|email|calendar|meeting|deliverable|budget|timeline|brief|report|document|file|drive|send|post|create|update|change|complete|assign|schedule|draft|write|rewrite|analy[sz]e|recommend|plan|prioriti[sz]e|search|look up)\b/.test(normalized);
  return correction && !operational;
}

function slackConversationPolicy(text, mode = 'normal') {
  const lightweightSocial = mode === 'normal' && isLightweightSocialSlackMessage(text);
  const relationalSelfReflection = mode === 'normal' && isRelationalSelfReflectionMessage(text);
  const boundedConversation = lightweightSocial || relationalSelfReflection;
  return {
    lightweightSocial,
    relationalSelfReflection,
    boundedConversation,
    attachLiveTools: !boundedConversation,
    contextTrialsEnabled: !boundedConversation,
    pmLearningEnabled: !boundedConversation,
  };
}

// Flatten a Slack message into one searchable string: text plus attachment text/links and any
// block text or button URLs. The Zoom app puts its join link in a button or attachment as often
// as in the message text, so a bare event.text scan would miss it.
function slackMessageAllText(event) {
  const parts = [event.text || ''];
  for (const a of (event.attachments || [])) parts.push(a.text || '', a.fallback || '', a.title_link || '', a.title || '');
  for (const b of (event.blocks || [])) {
    if (b.text && b.text.text) parts.push(b.text.text);
    if (b.url) parts.push(b.url);
    if (b.accessory && b.accessory.url) parts.push(b.accessory.url);
    for (const el of (b.elements || [])) { if (el.url) parts.push(el.url); if (el.text && el.text.text) parts.push(el.text.text); if (typeof el.text === 'string') parts.push(el.text); }
    for (const f of (b.fields || [])) parts.push(f.text || '');
  }
  return parts.join(' ');
}

function slackResponseModel(text, mode = 'normal') {
  const normalized = String(text || '').trim().toLowerCase().replace(/[\u2019']/g, '').replace(/\s+/g, ' ');
  const deepWork = /\b(analy[sz]e|analysis|strategy|strategic|plan|planning|trade-?offs?|recommend|recommendation|draft|write|rewrite|review|investigate|root cause|compare|prioriti[sz]e|risk assessment|explain|why)\b/.test(normalized);
  const fastBoundedTurn = mode === 'normal' && normalized.length <= 1200
    && !/https?:\/\//.test(normalized) && !deepWork;
  return fastBoundedTurn ? 'claude-sonnet-4-6' : 'claude-opus-4-8';
}

// Build a session key that scopes conversation history correctly.
// - DMs: per-channel (a DM channel = one conversation)
// - Channel threads: per-thread (so distinct threads in same channel don't bleed)
// - Top-level channel messages: per (channel, USER). One person's sequential top-level messages
//   share a key so the back-and-forth accumulates (continuity), but two DIFFERENT people's parallel
//   top-level exchanges never share a transcript. That second part is a SECURITY boundary, not just
//   tidiness: financial access is per-user, so an approved user's reply (with real dollar figures)
//   must never sit in-context when an UNapproved user speaks next in the same channel.
function slackSessionKey(channel, threadTs, channelType, user = '') {
  if (channelType === 'im' || channelType === 'mpim') return `dm:${channel}`;
  if (threadTs) return `thread:${channel}:${threadTs}`;
  return `channel:${channel}:${user}`;
}

function stripSlackLookupNarration(value) {
  const reply = String(value || '').trim();
  if (!reply) return reply;
  // A provider can occasionally echo an old conversational pattern even though the live prompt
  // forbids it. Remove a leading lookup-status sentence; if that was the entire response, the
  // ordinary empty-response recovery below will produce an honest terminal answer instead.
  const leading = reply.match(/^\s*([^\n]{1,140}?(?:[.!?…]+|\n+))\s*([\s\S]*)$/);
  if (!leading) return reply;
  const sentence = leading[1].trim();
  const progressOpener = /^(?:on it|one sec(?:ond)?|give me a sec(?:ond)?|let me (?:check|look|pull))\b/i;
  const lookupActivity = /\b(?:check(?:ing)?|look(?:ing)?|pull(?:ing)?|fetch(?:ing)?|live details|teamwork)\b/i;
  return progressOpener.test(sentence) && lookupActivity.test(sentence)
    ? leading[2].trim() : reply;
}

function slackThreadHasNoraReply(parent, replies, botUserId) {
  const nora = String(botUserId || '');
  if (!nora) return false;
  // For a top-level mention, every thread reply necessarily follows the mention. For a later
  // thread-broadcast mention, reply_users may include Nora because of an older reply; require an
  // actual Nora reply timestamp after this specific mention instead.
  if (!parent?.thread_ts
    && (parent?.reply_users || []).some(user => String(user) === nora)) return true;
  const mentionTs = Number.parseFloat(String(parent?.ts || '0')) || 0;
  return (Array.isArray(replies) ? replies : []).some(reply =>
    String(reply?.ts || '') !== String(parent?.ts || '')
    && String(reply?.user || '') === nora
    && (Number.parseFloat(String(reply?.ts || '0')) || 0) > mentionTs);
}

module.exports = {
  isLightweightSocialSlackMessage,
  slackEmptyReplyFallback,
  isRelationalSelfReflectionMessage,
  slackConversationPolicy,
  slackMessageAllText,
  slackResponseModel,
  slackSessionKey,
  stripSlackLookupNarration,
  slackThreadHasNoraReply,
};
