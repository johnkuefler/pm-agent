'use strict';

// Who is this utterance actually for?
//
// The meeting gate is deliberately biased toward silence: a mistake here should make Nora
// quieter, never chattier. She used to interrupt with nonsense, and these are the checks that
// stopped it. Pure string judgement, no session state and no I/O, so the awkward cases can be
// tested exhaustively without standing up a realtime session.

// Does this utterance look like a question (so lean-in mode can answer a direct ask even without her
// name)? Statements / cross-talk that aren't questions never trip lean-in.
function looksLikeQuestion(t) {
  const s = (t || '').trim();
  if (!s) return false;
  if (/\?\s*$/.test(s)) return true;
  return /^(what|who|whom|whose|when|where|why|which|how|is|are|am|was|were|do|does|did|can|could|should|would|will|shall|may|might|have|has|had|any|anyone|anybody|could you|can you|do you|did you|is there|are there)\b/i.test(s);
}
// ── Handoff detection ───────────────────────────────────────────────────────────────────────────
// "Kinsey, what do you think?" is the single most important signal that an utterance is NOT for
// Nora, even when it's a question (lean-in) or lands inside her follow-up window. When the room
// hands the floor to a named person, she lets go: no reply, window closes. Known-name list is the
// static team roster plus whoever Recall has actually heard on this call (catches clients/guests).
// Deliberately biased toward false positives: mistakes here make her QUIETER, never chattier.
const TEAM_FIRST_NAMES = ['brandee', 'john', 'andy', 'kyle', 'caitlin', 'kayla', 'kinsey', 'gracie',
  'mallory', 'elle', 'dianne', 'chelsea', 'lydia', 'aaron', 'santiago', 'santi', 'lacy'];
const VOCATIVE_FILLERS = new Set(['hey', 'hi', 'ok', 'okay', 'so', 'alright', 'well', 'um', 'uh', 'yeah', 'and', 'but']);
function addressesSomeoneElse(t, session) {
  const raw = (t || '').trim();
  if (!raw || /\bnora\b/i.test(raw)) return false; // if she's named too, it's (also) for her
  const s = raw.toLowerCase().replace(/[.!?]+\s*$/, '');
  const names = new Set(TEAM_FIRST_NAMES);
  if (session && session.speakersHeard) {
    for (const sp of session.speakersHeard) {
      const first = String(sp).trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z'-]/g, '');
      if (first.length > 2 && first !== 'nora') names.add(first);
    }
  }
  const words = s.split(/\s+/);
  let wi = 0; // skip leading fillers so "hey kinsey can you..." still reads as a leading vocative
  while (wi < words.length - 1 && VOCATIVE_FILLERS.has(words[wi].replace(/[,:]+$/, ''))) wi++;
  const first = (words[wi] || '').replace(/[,:]+$/, '');
  const last = (words[words.length - 1] || '').replace(/[,:]+$/, '');
  for (const name of names) {
    // Leading vocative: "kinsey what do you think" / "kinsey, can you pull that up". Requires a
    // question-ish or second-person continuation so "John said the deadline is Friday" (talking
    // ABOUT John) doesn't read as a handoff TO John.
    if (first === name) {
      const rest = words.slice(wi + 1).join(' ');
      if (/^(what|who|whom|when|where|why|which|how|you\b|your\b|thoughts|any\b|(?:do|did|are|were|is|can|could|would|will|should|have|has)\s+you\b)/i.test(rest)) return true;
    }
    // Trailing vocative on a question: "what do you think kinsey".
    if (last === name && looksLikeQuestion(raw)) return true;
    // Comma-set-off vocative: "so, kinsey, where are we on the build".
    if (new RegExp(`,\\s*${name}[,?!.]?(?:\\s|$)`).test(s)) return true;
  }
  return false;
}
const VOLUNTEER_CUE = /\b(deadline|due|overdue|timeline|launch|ship(?:ping|s|ped)?|estimate|scope|budget|hours|capacity|booked|bandwidth|overloaded|milestone|sprint|blocked|blocker|task|teamwork)\b/i;

module.exports = {
  looksLikeQuestion,
  TEAM_FIRST_NAMES,
  VOCATIVE_FILLERS,
  addressesSomeoneElse,
  VOLUNTEER_CUE,
};
