'use strict';

// Is this reply asking for clarification rather than confirming an action?
//
// Pure string judgement over Nora's own outbound text, with no session or store behind it, so
// the borderline phrasings can be pinned directly instead of through a live turn.

// Detect if Nora's reply is asking clarifying questions rather than confirming an action
function isAskingClarification(reply) {
  const lower = reply.toLowerCase();
  const clarifyPatterns = [
    /do you mean/,
    /which (one|project|client|competitor|team|person)/,
    /can you clarify/,
    /what (specifically|exactly|do you mean)/,
    /could you (be more specific|clarify|elaborate)/,
    /are you (referring to|talking about|looking for)/,
    /did you mean/,
    /just to clarify/,
    /before i (do that|get started|jump in|dig in|start)/,
    /a few questions/,
    /couple (of )?questions/,
    /first.{0,20}(need to know|need some clarity|want to understand)/,
    /what('s| is) the (scope|timeline|deadline|priority)/,
    /who('s| is| should) (the|be)/
  ];
  // Must end with a question mark or match clarification patterns
  const hasQuestion = reply.trim().endsWith('?');
  const matchesPattern = clarifyPatterns.some(p => p.test(lower));
  return hasQuestion && matchesPattern;
}

// Did Nora just tell someone she could not find something?
//
// This decides whether a turn that used live connectors is still worth queueing research for.
// The distinction is the reason a research task exists at all: research searches Drive and
// Confluence, so it can only help when the thing missing is documentation.
//
// The failure this prevents: three scheduling turns in a row read two people's calendars,
// answered correctly, and then filed "research John and Kinsey's calendar availability for
// tomorrow" as documentation homework. Nothing in Drive can answer that, and the answer expires
// overnight. A live read already consulted the system of record, so a substantive answer built on
// one is not a knowledge gap. Saying she came up empty still is.
function acknowledgesMissingInformation(reply) {
  const lower = String(reply || '').toLowerCase();
  return [
    /(don't|do not|didn't|did not) (have|see|find)/,
    /(can't|cannot|couldn't|could not) (find|see|access|locate|get (to|into))/,
    /(no|not) (access|record|records|documentation|details|visibility)/,
    /nothing (in|on|about|for) /,
    /(isn't|is not|wasn't|was not) (in|on) (there|drive|confluence|teamwork)/,
    /not sure where/,
    /i'd have to (ask|check with|dig)/,
    /(no|couldn't find any) (results|matches)/,
  ].some(pattern => pattern.test(lower));
}

// Is a documentation search capable of answering what this turn could not?
//
// The gap detector behind research tasks is a provider call, and its own instructions already
// exclude action requests and confidently answered questions. It ignored both on three consecutive
// scheduling turns, filing "research John and Kinsey's calendar availability for tomorrow" as
// documentation homework each time. Nothing in Drive can answer that, and the answer expires
// overnight.
//
// A live tool read consulted the system of record, so an answer built on one is not a knowledge
// gap. Saying she came up empty still is, and that case has to keep queueing research.
function researchCouldHelp(firedTools = [], reply = '') {
  if (!Array.isArray(firedTools) || firedTools.length === 0) return true;
  return acknowledgesMissingInformation(reply);
}

module.exports = { isAskingClarification, acknowledgesMissingInformation, researchCouldHelp };
