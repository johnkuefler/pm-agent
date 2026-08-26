'use strict';

const crypto = require('crypto');

const PROTOCOL_VERSION = 1;
const BLOCKED_RESPONSE = 'I couldn\'t verify that every claimed external action completed, so I won\'t say it did. I can check the result or retry.';
const EXTERNAL_OBJECT = /\b(?:task|ticket|project|milestone|status|deadline|due date|assignee|assignment|comment|message|email|slack|teamwork|jira|calendar|meeting|invite|event|document|doc|file|folder|sheet|deck|report|record|website|page|post|notification|reminder)\b/i;
const FAMILY_PATTERNS = Object.freeze({
  communication: /\b(?:sent|posted|messaged|emailed|notified|shared|commented)\b/i,
  create: /\b(?:created|added|opened)\b/i,
  update: /\b(?:updated|edited|changed|moved|renamed|assigned|reassigned|scheduled|booked|set)\b/i,
  complete: /\b(?:completed|closed|finished|resolved|reopened|marked)\b/i,
  delete: /\b(?:deleted|removed)\b/i,
  upload: /\b(?:uploaded|attached)\b/i,
});
const REQUEST_PATTERNS = Object.freeze({
  communication: /\b(?:send|post|message|email|notify|share|comment)\b/i,
  create: /\b(?:create|add|open)\b/i,
  update: /\b(?:update|edit|change|move|rename|assign|reassign|schedule|book|set)\b/i,
  complete: /\b(?:complete|close|finish|resolve|reopen|mark)\b/i,
  delete: /\b(?:delete|remove)\b/i,
  upload: /\b(?:upload|attach)\b/i,
});
const TOOL_SUPPORT = Object.freeze({
  communication: /(?:send|post|message|email|notify|share|comment)/i,
  // Google Workspace exposes both Calendar creation and modification through one verified
  // `manage_event` write. Treat that exact connector tool as support for either requested family;
  // otherwise a successful Calendar write is hidden behind the generic unverified-action reply.
  create: /(?:create|add|open|manage[_ ]?event)/i,
  update: /(?:update|edit|change|move|rename|assign|schedule|book|set|manage[_ ]?event)/i,
  complete: /(?:complete|close|finish|resolve|reopen|update|mark)/i,
  delete: /(?:delete|remove)/i,
  upload: /(?:upload|attach)/i,
});

function commitment(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function requestedFamilies(task = '') {
  const value = String(task || '');
  if (!EXTERNAL_OBJECT.test(value)) return [];
  return Object.entries(REQUEST_PATTERNS).filter(([, pattern]) => pattern.test(value))
    .map(([family]) => family);
}

function detectClaims(text = '', task = '') {
  const value = String(text || '');
  const requested = requestedFamilies(task);
  const claims = [];
  const firstPerson = /\b(?:I['’]ve|I have|I)\s+(?:just\s+|already\s+|now\s+|successfully\s+)?([^.!?\n]{1,140})/gi;
  let match;
  while ((match = firstPerson.exec(value))) {
    const phrase = match[1];
    for (const [family, pattern] of Object.entries(FAMILY_PATTERNS)) {
      const verb = phrase.match(pattern);
      if (!verb) continue;
      const afterVerb = phrase.slice((verb.index || 0) + verb[0].length);
      const externallyGrounded = EXTERNAL_OBJECT.test(afterVerb)
        || (requested.includes(family) && /^(?:\s+(?:it|that|them))?(?:\s|$|[,;:—-])/i.test(afterVerb));
      if (externallyGrounded) claims.push({ family, start: match.index,
        end: match.index + match[0].length });
    }
  }
  if (requested.length && /(?:^|[.!?\n]\s*)(?:done|all set|taken care of|that['’]s updated)(?:[.!?\n]|$)/i.test(value)) {
    for (const family of requested) claims.push({ family, start: 0, end: value.length, implicit: true });
  }
  const unique = [];
  const keys = new Set();
  for (const claim of claims) {
    const key = `${claim.family}:${claim.start}:${claim.end}`;
    if (!keys.has(key)) { keys.add(key); unique.push(claim); }
  }
  return unique;
}

function receiptSupportsFamily(execution, family) {
  if (!execution || execution.status !== 'succeeded' || execution.actor_class !== 'model_selected'
    || execution.access_mode !== 'write' || execution.audit?.complete_chain_verified !== true) return false;
  const searchable = `${execution.tool_name || ''} ${execution.tool_family || ''}`;
  return Boolean(TOOL_SUPPORT[family]?.test(searchable));
}

function apply({ task = '', candidate = '', executions = [] } = {}) {
  const response = String(candidate || '').trim();
  const claims = detectClaims(response, task);
  const bindings = [];
  const unsupported = [];
  const usedExecutionIds = new Set();
  for (const claim of claims) {
    const execution = executions.find(item => !usedExecutionIds.has(item.id)
      && receiptSupportsFamily(item, claim.family));
    if (execution) bindings.push({ family: claim.family, execution_id: execution.id,
      execution_content_commitment: execution.content_commitment });
    else unsupported.push(claim);
    if (execution) usedExecutionIds.add(execution.id);
  }
  const uniqueBindings = [...new Map(bindings.map(item =>
    [`${item.family}:${item.execution_id}`, item])).values()];
  const disposition = !claims.length ? 'no_claim' : unsupported.length ? 'blocked' : 'verified';
  const finalResponse = disposition === 'blocked' ? BLOCKED_RESPONSE : response;
  return {
    protocol_version: PROTOCOL_VERSION, disposition,
    detected_claim_count: claims.length,
    claim_families: [...new Set(claims.map(item => item.family))].sort(),
    unsupported_claim_families: [...new Set(unsupported.map(item => item.family))].sort(),
    claim_receipt_bindings: uniqueBindings.sort((a, b) => a.family.localeCompare(b.family)
      || a.execution_id.localeCompare(b.execution_id)),
    candidate_commitment: commitment(response), final_response_commitment: commitment(finalResponse),
    response: finalResponse,
  };
}

module.exports = {
  BLOCKED_RESPONSE, FAMILY_PATTERNS, PROTOCOL_VERSION, apply, commitment, detectClaims,
  receiptSupportsFamily, requestedFamilies,
};
