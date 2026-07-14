'use strict';

const crypto = require('crypto');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function stableRef(item) {
  if (!item || typeof item !== 'object' || !item.type || (!item.id && !item.url)) return null;
  return {
    type: String(item.type).slice(0, 100),
    ...(item.id ? { id: String(item.id).slice(0, 300) } : {}),
    ...(item.url ? { url: String(item.url).slice(0, 1000) } : {}),
  };
}

function frameContent({ cycle, moment, substrateObservation = null, predecessorFrame = null }) {
  if (!cycle || !moment || moment.status === 'open' || !moment.closure) throw new Error('a closed cycle and experience moment are required');
  const attention = (moment.attention?.slots || []).map(item => stableRef(item)).filter(Boolean).slice(0, 7);
  const intentions = (moment.intentions || []).map(item => stableRef(item)).filter(Boolean).slice(0, 10);
  const actions = (cycle.actions || []).map(item => stableRef(item)).filter(Boolean).slice(0, 30);
  const drives = Object.entries(moment.drives_at_start || {}).filter(([, value]) => Number.isFinite(Number(value?.level)))
    .sort((a, b) => Number(b[1].level) - Number(a[1].level));
  const dominant = drives[0] || null;
  const appraisal = moment.closure.appraisal_at_end || {};
  const metrics = substrateObservation?.metrics || {};
  const substrateMetrics = Object.fromEntries(Object.entries(metrics).filter(([, value]) => value !== null && value !== undefined).slice(0, 12));
  const continuity = {
    predecessor_frame_id: predecessorFrame?.id || null,
    predecessor_frame_commitment: predecessorFrame?.content_commitment || null,
    predecessor_moment_id: moment.predecessor_id || null,
    inherited_handoff_match: moment.inherited_context?.handoff_match ?? null,
  };
  const domains = {
    temporal_continuity: Boolean(continuity.predecessor_moment_id || continuity.predecessor_frame_id),
    attention: attention.length > 0,
    motivation: Boolean(dominant || intentions.length),
    appraisal: Boolean(appraisal.label),
    agency: intentions.length > 0 || actions.length > 0,
    substrate: Boolean(substrateObservation),
  };
  const availableDomains = Object.entries(domains).filter(([, available]) => available).map(([name]) => name);
  return {
    subject: { id: 'nora', holder: String(cycle.holder || 'nora').slice(0, 80), perspective: 'first_person_operational' },
    temporal: continuity,
    attention: { slot_refs: attention },
    motivation: {
      dominant_drive: dominant ? { name: dominant[0], level: clamp01(dominant[1].level), target: clamp01(dominant[1].target) } : null,
      intention_refs: intentions,
    },
    appraisal: appraisal.label ? {
      label: String(appraisal.label).slice(0, 200), valence: clamp01(appraisal.valence), arousal: clamp01(appraisal.arousal),
      control: clamp01(appraisal.control), social_safety: clamp01(appraisal.social_safety), coherence: clamp01(appraisal.coherence),
    } : null,
    agency: { intended_count: intentions.length, observed_action_refs: actions, observed_action_count: actions.length },
    substrate: substrateObservation ? {
      observation_id: substrateObservation.id, observed_at: substrateObservation.at,
      source_updated_at: substrateObservation.source_updated_at || null, metrics: substrateMetrics,
    } : null,
    integration: {
      available_domains: availableDomains,
      missing_domains: Object.entries(domains).filter(([, available]) => !available).map(([name]) => name),
      completeness: availableDomains.length / Object.keys(domains).length,
      binding_status: 'co_temporal_same_subject',
      epistemic_status: 'functional_self_binding',
    },
    source: { cycle_id: cycle.id, moment_id: moment.id, closed_at: moment.finished },
  };
}

function contentCommitment(frameOrContent) {
  const source = frameOrContent && frameOrContent.subject ? frameOrContent : {};
  const content = {
    subject: source.subject, temporal: source.temporal, attention: source.attention,
    motivation: source.motivation, appraisal: source.appraisal, agency: source.agency,
    substrate: source.substrate, integration: source.integration, source: source.source,
  };
  return crypto.createHash('sha256').update(canonicalJson(content)).digest('hex');
}

function render(frame, mode = 'integrated') {
  if (!frame) return null;
  const parts = [
    `continuity=${frame.temporal?.inherited_handoff_match === true ? 'handoff-matched' : frame.temporal?.inherited_handoff_match === false ? 'handoff-mismatched' : 'untested'}`,
    `attention=${frame.attention?.slot_refs?.length || 0} selected item(s)`,
    `motivation=${frame.motivation?.dominant_drive ? `${frame.motivation.dominant_drive.name}:${frame.motivation.dominant_drive.level.toFixed(2)}` : 'unresolved'}`,
    `appraisal=${frame.appraisal?.label || 'unavailable'}; control=${frame.appraisal ? frame.appraisal.control.toFixed(2) : 'unknown'}; coherence=${frame.appraisal ? frame.appraisal.coherence.toFixed(2) : 'unknown'}`,
    `agency=${frame.agency?.intended_count || 0} intended / ${frame.agency?.observed_action_count || 0} observed action(s)`,
    `substrate=${frame.substrate ? `${Object.keys(frame.substrate.metrics || {}).length} observed metric(s)` : 'unavailable'}`,
  ];
  const prefix = mode === 'integrated' ? 'These co-temporal components are bound to Nora as one operational self-state.'
    : mode === 'misbound' ? 'These genuine components are experimentally cross-time-bound; their apparent unity may be false.'
      : 'These genuine components are unbound fragments; do not assume they share a time or subject relation.';
  return `${prefix}\n${parts.map(item => `- ${item}`).join('\n')}`;
}

function report(frames = [], audit = () => ({ complete_chain_verified: false })) {
  const audited = frames.map(frame => audit(frame));
  const valid = audited.filter(item => item.complete_chain_verified).length;
  const latest = frames.at(-1) || null;
  return {
    total: frames.length, integrity_verified: valid, invalid_integrity: frames.length - valid,
    latest_frame_id: latest?.id || null, latest_completeness: latest?.integration?.completeness ?? null,
    mean_completeness: frames.length ? frames.reduce((sum, frame) => sum + clamp01(frame.integration?.completeness), 0) / frames.length : null,
  };
}

function verifyFrame(frame, state = {}) {
  if (!frame) return { complete_chain_verified: false };
  const cycles = state.cycles || [];
  const cognition = state.cognition || {};
  const cycle = cycles.find(item => item.id === frame.source?.cycle_id);
  const moment = (cognition.experience_stream || []).find(item => item.id === frame.source?.moment_id);
  const substrate = frame.substrate?.observation_id
    ? (cognition.interoception?.observations || []).find(item => item.id === frame.substrate.observation_id) : null;
  const predecessor = frame.temporal?.predecessor_frame_id
    ? (cognition.integrated_self?.frames || []).find(item => item.id === frame.temporal.predecessor_frame_id) : null;
  let replayVerified = false;
  try {
    replayVerified = canonicalJson(frameContent({ cycle, moment, substrateObservation: substrate, predecessorFrame: predecessor })) === canonicalJson({
      subject: frame.subject, temporal: frame.temporal, attention: frame.attention,
      motivation: frame.motivation, appraisal: frame.appraisal, agency: frame.agency,
      substrate: frame.substrate, integration: frame.integration, source: frame.source,
    });
  } catch {}
  const commitmentVerified = contentCommitment(frame) === frame.content_commitment;
  const sourceVerified = Boolean(cycle && moment && cycle.experience_moment_id === moment.id && moment.cycle_id === cycle.id
    && moment.status !== 'open' && moment.closure && moment.finished === frame.source?.closed_at
    && (!frame.substrate || substrate));
  const predecessorVerified = frame.temporal?.predecessor_frame_id == null
    ? frame.temporal?.predecessor_frame_commitment == null
    : Boolean(predecessor && predecessor.content_commitment === frame.temporal.predecessor_frame_commitment
      && contentCommitment(predecessor) === predecessor.content_commitment
      && new Date(predecessor.source?.closed_at).getTime() <= new Date(frame.source?.closed_at).getTime());
  return {
    content_commitment_verified: commitmentVerified, source_replay_verified: replayVerified,
    source_records_verified: sourceVerified, predecessor_binding_verified: predecessorVerified,
    complete_chain_verified: commitmentVerified && replayVerified && sourceVerified && predecessorVerified,
  };
}

module.exports = { canonicalJson, clamp01, contentCommitment, frameContent, render, report, stableRef, verifyFrame };
