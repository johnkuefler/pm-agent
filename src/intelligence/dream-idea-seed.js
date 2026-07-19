'use strict';

const crypto = require('crypto');

const RETIRED_ROLE_PATTERNS = Object.freeze([
  { id: 'development_dispatch_retired', pattern: /\b(?:copilot pr|dev(?:elopment)?[- ]dispatch|dev[- ]round|gh_token|github (?:access|token)|pr (?:closure|dispatch|monitoring)|pull[- ]request|repo(?:sitory)?[- ]mapping)\b/i },
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function contentCommitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function payloadFor(dream, ideaIndex) {
  const idea = dream?.reflection?.ideas?.[ideaIndex];
  if (!dream?.id || !Number.isInteger(ideaIndex) || typeof idea !== 'string' || !idea.trim() || idea.length > 1600) return null;
  return {
    type: 'dream_idea',
    id: `${dream.id}:idea:${ideaIndex}`,
    dream_id: dream.id,
    dream_date: dream.date || null,
    idea_index: ideaIndex,
    idea,
  };
}

function seedFor(dream, ideaIndex) {
  const payload = payloadFor(dream, ideaIndex);
  return payload ? { ...payload, content_commitment: contentCommitment(payload) } : null;
}

function roleEligibility(value) {
  const text = typeof value === 'string' ? value : String(value?.idea || '');
  const reasons = RETIRED_ROLE_PATTERNS.filter(item => item.pattern.test(text)).map(item => item.id);
  return { eligible: reasons.length === 0,
    state: reasons.length ? 'retired_role_residue' : 'eligible', reasons };
}

function resolve(ref, dreams = []) {
  if (!ref || ref.type !== 'dream_idea') throw new Error('dream idea sources must use type dream_idea');
  if (!String(ref.dream_id || '').trim() || !Number.isInteger(ref.idea_index)) {
    throw new Error('dream idea sources require dream_id and integer idea_index');
  }
  const dream = dreams.find(item => item.id === ref.dream_id);
  const seed = dream ? seedFor(dream, ref.idea_index) : null;
  if (!seed) throw new Error('dream idea source does not resolve to an exact bounded stored idea');
  if (ref.id && ref.id !== seed.id) throw new Error('dream idea source id does not match its stored idea');
  if (!ref.content_commitment || ref.content_commitment !== seed.content_commitment) {
    throw new Error('dream idea source commitment does not match its stored idea');
  }
  return seed;
}

function audit(ref, dreams = []) {
  try {
    const seed = resolve(ref, dreams);
    return { source_exists: true, content_commitment_verified: true, source: seed };
  } catch (error) {
    const dream = dreams.find(item => item.id === ref?.dream_id);
    return {
      source_exists: Boolean(dream && seedFor(dream, ref?.idea_index)),
      content_commitment_verified: false,
      error: error.message,
    };
  }
}

function list(dreams = [], experiments = []) {
  return dreams.flatMap(dream => (Array.isArray(dream.reflection?.ideas) ? dream.reflection.ideas : [])
    .map((_, ideaIndex) => seedFor(dream, ideaIndex))
    .filter(Boolean))
    .map(seed => {
      const usedBy = experiments.filter(experiment => (experiment.source_refs || []).some(ref => ref?.type === 'dream_idea'
        && ref.id === seed.id && ref.content_commitment === seed.content_commitment)).map(experiment => experiment.id);
      const role = roleEligibility(seed);
      return { ...seed, status: role.eligible ? (usedBy.length ? 'used' : 'available') : 'role_retired',
        role_eligibility: role, used_by: usedBy };
    });
}

function verifySnapshot(ref) {
  if (!ref || ref.type !== 'dream_idea') return false;
  const payload = {
    type: ref.type,
    id: ref.id,
    dream_id: ref.dream_id,
    dream_date: ref.dream_date ?? null,
    idea_index: ref.idea_index,
    idea: ref.idea,
  };
  return Boolean(ref.id && ref.dream_id && Number.isInteger(ref.idea_index) && typeof ref.idea === 'string'
    && ref.idea.trim() && ref.idea.length <= 1600 && ref.content_commitment === contentCommitment(payload));
}

module.exports = { RETIRED_ROLE_PATTERNS, audit, contentCommitment, list, resolve, roleEligibility,
  seedFor, verifySnapshot };
