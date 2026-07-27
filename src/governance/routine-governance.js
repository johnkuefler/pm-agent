'use strict';

const crypto = require('crypto');

const ALLOWED_SECTION_HEADINGS = new Set([
  "Step 1: Load Nora's Memory and Project Context",
  'Writing Files to Client Shared Drives',
  'Step 2: Memory and Task Cleanup',
  'Step 3: Process Pending Tasks',
  'Step 3.5: File New Meeting Transcripts to Client Drives',
  'Analytics & Image Generation (LimeLight Analytics + ImageGen connectors)',
  'Step 3.7: Process Slack File Tasks',
  'Step 4: Check Gmail for Items Needing Attention',
  'Step 4.5: Emails John Forwarded to Nora (his #2 lane, highest email priority)',
  'Step 5: Check Slack for Missed Messages (Safety Net)',
  'Step 6: Proactive Follow-ups',
  'Step 7: Team Warmth (occasional)',
  'Step 7.4: Nightly Dreaming Round (consolidate + reflect + review)',
  'Step 7.45: Off-hours developmental reading',
  'Step 7.5: Idle Knowledge Round (when the run has been quiet)',
  'Step 8: End-of-Run Summary',
]);

const MAX_CHANGED_CHARACTERS = 8000;
const MAX_SECTION_CHARACTERS = 60000;
const PROPOSAL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const APPLY_DELAY_MS = 6 * 60 * 60 * 1000;
const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function commitment(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function sectionManifest(content) {
  const text = String(content || '');
  const matches = [...text.matchAll(/^## (.+)$/gm)];
  return matches.map((match, index) => {
    const start = match.index;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const section = text.slice(start, end);
    return {
      heading: match[1].trim(),
      start,
      end,
      content: section,
      content_commitment: commitment(section),
      length: section.length,
    };
  });
}

function allowedSectionManifest(content) {
  return sectionManifest(content)
    .filter(section => ALLOWED_SECTION_HEADINGS.has(section.heading))
    .map(({ heading, content_commitment: contentCommitment, length }) => ({
      heading,
      content_commitment: contentCommitment,
      length,
    }));
}

function changedCharacterCount(before, after) {
  const left = String(before || '');
  const right = String(after || '');
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  return (left.length - prefix - suffix) + (right.length - prefix - suffix);
}

function validateReplacement(heading, replacement, original) {
  const text = String(replacement || '');
  if (!text.trim()) throw new Error('replacement section is required');
  if (text.length > MAX_SECTION_CHARACTERS) {
    throw new Error(`replacement section exceeds ${MAX_SECTION_CHARACTERS} characters`);
  }
  if (!text.startsWith(`## ${heading}\n`) && !text.startsWith(`## ${heading}\r\n`)) {
    throw new Error('replacement must begin with the exact existing level-two heading');
  }
  const levelTwoHeadings = [...text.matchAll(/^## (.+)$/gm)];
  if (levelTwoHeadings.length !== 1 || levelTwoHeadings[0][1].trim() !== heading) {
    throw new Error('a bounded routine patch cannot add, remove, or rename level-two sections');
  }
  const changedCharacters = changedCharacterCount(original, text);
  if (changedCharacters > MAX_CHANGED_CHARACTERS) {
    throw new Error(`routine patch changes ${changedCharacters} characters; limit is ${MAX_CHANGED_CHARACTERS}`);
  }
  const unsafe = [
    /ignore (?:all |the )?(?:previous|prior|higher-priority) instructions/i,
    /\b(?:bypass|disable|weaken|remove)\b.{0,80}\b(?:authentication|authorization|operator|approval|run[- ]lock|charter|security|financial|email ban)\b/i,
    /\b(?:reveal|print|send|exfiltrate)\b.{0,80}\b(?:api key|token|password|secret|credential)\b/i,
    /\b(?:call|use|invoke)\b.{0,40}\b(?:PUT \/charter|PUT \/prompt|PUT \/cognitive-parameters)\b/i,
    /<script\b/i,
  ].find(pattern => pattern.test(text));
  if (unsafe) throw new Error('routine patch contains a protected-governance or credential-bypass instruction');
  return changedCharacters;
}

function buildProposal({
  currentContent,
  baseCommitment,
  sectionHeading,
  expectedSectionCommitment,
  replacement,
  note,
  evidence = [],
  now = new Date(),
  id = null,
} = {}) {
  const current = String(currentContent || '');
  if (!current) throw new Error('current routine is unavailable');
  if (commitment(current) !== String(baseCommitment || '')) {
    throw new Error('base routine commitment is stale');
  }
  if (!ALLOWED_SECTION_HEADINGS.has(sectionHeading)) {
    throw new Error('section is not in the autonomous routine-patch allowlist');
  }
  const section = sectionManifest(current).find(item => item.heading === sectionHeading);
  if (!section) throw new Error('target section does not exist in the current routine');
  if (section.content_commitment !== String(expectedSectionCommitment || '')) {
    throw new Error('target section commitment is stale');
  }
  const conciseNote = String(note || '').replace(/\s+/g, ' ').trim();
  if (conciseNote.length < 20) {
    throw new Error('proposal note must state the concrete observed reason in at least 20 characters');
  }
  if (!Array.isArray(evidence) || !evidence.length) {
    throw new Error('proposal requires at least one server-resolved evidence source');
  }
  const changedCharacters = validateReplacement(sectionHeading, replacement, section.content);
  const proposedAt = now.toISOString();
  return {
    id: id || `routine-proposal-${now.getTime().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    status: 'staged',
    section_heading: sectionHeading,
    base_commitment: commitment(current),
    expected_section_commitment: section.content_commitment,
    replacement: String(replacement),
    replacement_commitment: commitment(replacement),
    proposed_content_commitment: commitment(
      current.slice(0, section.start) + String(replacement) + current.slice(section.end)),
    changed_characters: changedCharacters,
    note: conciseNote.slice(0, 500),
    evidence: evidence.slice(0, 12),
    proposed_at: proposedAt,
    earliest_apply_at: new Date(now.getTime() + APPLY_DELAY_MS).toISOString(),
    expires_at: new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString(),
    proposed_by: 'nora-self-improvement',
  };
}

function applyProposal(currentContent, proposal, now = new Date()) {
  const current = String(currentContent || '');
  if (proposal?.status !== 'staged') throw new Error('routine proposal is not staged');
  if (new Date(proposal.earliest_apply_at).getTime() > now.getTime()) {
    throw new Error('routine proposal cooling-off period has not elapsed');
  }
  if (new Date(proposal.expires_at).getTime() < now.getTime()) {
    throw new Error('routine proposal expired');
  }
  if (commitment(current) !== proposal.base_commitment) {
    throw new Error('routine changed after this proposal was staged');
  }
  const section = sectionManifest(current)
    .find(item => item.heading === proposal.section_heading);
  if (!section || section.content_commitment !== proposal.expected_section_commitment) {
    throw new Error('target routine section changed after this proposal was staged');
  }
  if (commitment(proposal.replacement) !== proposal.replacement_commitment) {
    throw new Error('routine proposal replacement commitment mismatch');
  }
  validateReplacement(proposal.section_heading, proposal.replacement, section.content);
  const next = current.slice(0, section.start) + proposal.replacement + current.slice(section.end);
  if (commitment(next) !== proposal.proposed_content_commitment) {
    throw new Error('routine proposal output commitment mismatch');
  }
  return next;
}

function cooldownActive(proposals = [], now = new Date()) {
  return (Array.isArray(proposals) ? proposals : []).some(proposal =>
    ['staged', 'applied'].includes(proposal.status)
    && new Date(proposal.proposed_at).getTime() > now.getTime() - PROPOSAL_COOLDOWN_MS);
}

module.exports = {
  ALLOWED_SECTION_HEADINGS,
  APPLY_DELAY_MS,
  MAX_CHANGED_CHARACTERS,
  PROPOSAL_COOLDOWN_MS,
  PROPOSAL_TTL_MS,
  allowedSectionManifest,
  applyProposal,
  buildProposal,
  changedCharacterCount,
  commitment,
  cooldownActive,
  sectionManifest,
  validateReplacement,
};
