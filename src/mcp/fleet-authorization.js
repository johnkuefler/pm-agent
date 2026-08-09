'use strict';

const TEAM_FLEET_WRITE_TOOLS = new Set([
  'pause_agent',
  'set_agent_once_instructions',
  'set_task_routing',
  'update_agent_config',
]);

const OWNER_FLEET_WRITE_TOOLS = new Set([
  ...TEAM_FLEET_WRITE_TOOLS,
  'resume_agent',
]);

const SAFE_AGENT_CONFIG_FIELDS = new Set([
  'cadence',
  'hoursTimezone',
  'operatingHours',
  'slug',
  'sweepCadenceHours',
  'teamworkBindings',
  'twAssigneeId',
  'twProjectId',
  'twProjectName',
  'twTasklistId',
  'twTasklistName',
  'twWatchTasklistIds',
]);

const FLEET_OBJECT = /\b(?:agent|fleet|routine|cadence|config(?:uration)?|task routing|teamwork binding|operating hours|one[- ]time instruction)\b|\bpush(?:ing)?\s+(?:a|the|this)?\s*task\b/i;
const CHANGE_ACTION = /\b(?:queue|push|wake|run|retry|pause|resume|change|update|set|fix|bind|route|reconfigure|configure|move|assign|tell|clear|withdraw)\b/i;
const CONFIRMATION = /^(?:yes|yep|yeah|ok(?:ay)?|go ahead|do it|please do|make it so|sounds good|that works)[\s.!]*$/i;
const SENSITIVE_INSTRUCTION = /\b(?:api[ _-]?key|access token|auth(?:orization)? token|bearer token|password|credential|private key|client secret|signing secret)\b/i;
const ONCE_REQUEST = /\b(?:queue|push|wake|retry|run|rerun|tell)\b[^.!?]{0,100}\b(?:agent|routine|task|run)\b|\bone[- ]time instructions?\b/i;
const CONFIG_REQUEST = /\b(?:change|update|set|fix|bind|rebind|reconfigure|configure|clear)\b[^.!?]{0,100}\b(?:cadence|operating hours?|sweep cadence|teamwork bindings?|tasklists?|config(?:uration)?)\b|\b(?:cadence|operating hours?|sweep cadence|teamwork bindings?|tasklists?|config(?:uration)?)\b[^.!?]{0,100}\b(?:change|update|set|fix|bind|rebind|reconfigure|configure|clear)\b/i;
const ROUTING_REQUEST = /\b(?:change|update|set|fix|route|assign|clear)\b[^.!?]{0,100}\b(?:task routing|approver|next[- ]assignee|follower)\b|\b(?:task routing|approver|next[- ]assignee|follower)\b[^.!?]{0,100}\b(?:change|update|set|fix|route|assign|clear)\b/i;
const PAUSE_REQUEST = /\b(?:pause|stop)\b[^.!?]{0,80}\bagent\b|\bagent\b[^.!?]{0,80}\b(?:pause|stop)\b/i;
const RESUME_REQUEST = /\b(?:resume|unpause|reactivate)\b[^.!?]{0,80}\bagent\b|\bagent\b[^.!?]{0,80}\b(?:resume|unpause|reactivate)\b/i;

function clean(value, max = 2000) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function requestedFleetTools(requestText, conversationText = '') {
  const current = clean(requestText);
  const confirmation = CONFIRMATION.test(current);
  const source = confirmation ? clean(conversationText, 3000) : current;
  if (!FLEET_OBJECT.test(source) || !CHANGE_ACTION.test(source)) return [];
  const requested = new Set();
  if (ONCE_REQUEST.test(source)) requested.add('set_agent_once_instructions');
  if (CONFIG_REQUEST.test(source)) requested.add('update_agent_config');
  if (ROUTING_REQUEST.test(source)) requested.add('set_task_routing');
  if (PAUSE_REQUEST.test(source)) requested.add('pause_agent');
  if (RESUME_REQUEST.test(source)) requested.add('resume_agent');
  if (confirmation && requested.size !== 1) return [];
  return [...requested];
}

function explicitFleetMutationRequest(requestText, conversationText = '') {
  return requestedFleetTools(requestText, conversationText).length > 0;
}

function verifiedSlackAttestation(attestation, requesterId, interactionRef) {
  const event = attestation?.source_snapshot?.event;
  return attestation?.provider === 'slack'
    && attestation?.status === 'provider_verified'
    && attestation?.receipt?.cryptographically_verified_at_ingress === true
    && event?.user === requesterId
    && interactionRef === `slack:${event?.channel}:${event?.ts}`;
}

function createFleetRequestAuthority({
  identity,
  requesterId,
  ownerId,
  interactionRef,
  requestText,
  conversationText,
  direct = false,
  sourceAttestation = null,
  now = Date.now(),
  expiresAt = now + 90_000,
} = {}) {
  if (!direct || !verifiedSlackAttestation(sourceAttestation, requesterId, interactionRef)
    || !identity || identity.id !== requesterId) return null;
  if (!identity.fullMember || identity.isBot || identity.isAppUser || identity.deleted) return null;
  const allowedTools = requestedFleetTools(requestText, conversationText);
  if (!interactionRef || !allowedTools.length) return null;
  const authority = {
    kind: 'fleet_request_v1',
    surface: 'slack',
    requesterId: clean(requesterId, 120),
    requesterName: clean(identity.name || requesterId, 160),
    requesterRole: requesterId === ownerId ? 'owner' : 'internal_member',
    interactionRef: clean(interactionRef, 300),
    requestText: clean(requestText, 2000),
    allowedTools: Object.freeze(allowedTools.slice()),
    issuedAt: Number(now),
    expiresAt: Number(expiresAt),
  };
  return Object.freeze(authority);
}

function authorityIsCurrent(authority, now = Date.now()) {
  return authority?.kind === 'fleet_request_v1'
    && authority.surface === 'slack'
    && !!authority.requesterId
    && !!authority.interactionRef
    && Number.isFinite(authority.issuedAt)
    && Number.isFinite(authority.expiresAt)
    && authority.issuedAt <= now
    && authority.expiresAt >= now
    && authority.expiresAt - authority.issuedAt <= 120_000;
}

function allowedFleetWriteTool(toolName, authority, now = Date.now()) {
  if (!authorityIsCurrent(authority, now)) return false;
  const allowlist = authority.requesterRole === 'owner'
    ? OWNER_FLEET_WRITE_TOOLS : TEAM_FLEET_WRITE_TOOLS;
  return allowlist.has(String(toolName || ''))
    && Array.isArray(authority.allowedTools)
    && authority.allowedTools.includes(String(toolName || ''));
}

function objectKeysAreAllowed(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.has(key));
}

function validateFleetWrite(toolName, args, authority, now = Date.now()) {
  if (!allowedFleetWriteTool(toolName, authority, now)) {
    return { allowed: false, reason: 'This Fleet operation is outside the current verified request.' };
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { allowed: false, reason: 'Fleet change arguments must be a bounded object.' };
  }
  const slug = clean(args.slug, 200);
  if (!slug) return { allowed: false, reason: 'A specific agent slug is required.' };

  if (toolName === 'set_agent_once_instructions') {
    if (!objectKeysAreAllowed(args, new Set(['slug', 'onceInstructions']))) {
      return { allowed: false, reason: 'Unexpected one-time instruction fields were blocked.' };
    }
    if (typeof args.onceInstructions !== 'string' || args.onceInstructions.length > 5000) {
      return { allowed: false, reason: 'One-time instructions must be text under 5000 characters.' };
    }
    if (SENSITIVE_INSTRUCTION.test(args.onceInstructions)) {
      return { allowed: false, reason: 'Credential and secret work needs owner handling outside conversational Fleet control.' };
    }
  }

  if (toolName === 'update_agent_config') {
    if (!objectKeysAreAllowed(args, SAFE_AGENT_CONFIG_FIELDS)) {
      return { allowed: false, reason: 'That configuration field is outside Nora\'s bounded Fleet authority.' };
    }
    if (Object.keys(args).length < 2) {
      return { allowed: false, reason: 'At least one bounded configuration change is required.' };
    }
  }

  if ((toolName === 'pause_agent' || toolName === 'resume_agent')
    && !objectKeysAreAllowed(args, new Set(['slug']))) {
    return { allowed: false, reason: 'Pause and resume accept only a specific agent slug.' };
  }

  if (toolName === 'set_task_routing') {
    if (!objectKeysAreAllowed(args, new Set(['slug', 'routing'])) || !Array.isArray(args.routing)
      || args.routing.length > 20) {
      return { allowed: false, reason: 'Task routing must be a complete bounded routing array.' };
    }
  }

  return { allowed: true, reason: 'Verified internal Slack request within the Fleet allowlist.' };
}

module.exports = {
  TEAM_FLEET_WRITE_TOOLS,
  OWNER_FLEET_WRITE_TOOLS,
  SAFE_AGENT_CONFIG_FIELDS,
  requestedFleetTools,
  explicitFleetMutationRequest,
  verifiedSlackAttestation,
  createFleetRequestAuthority,
  authorityIsCurrent,
  allowedFleetWriteTool,
  validateFleetWrite,
};
