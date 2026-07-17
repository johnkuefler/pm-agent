'use strict';

const crypto = require('node:crypto');

const PROTOCOL_VERSION = 1;
const OUTCOME_PROTOCOL_VERSION = 1;
const POSITIVE_OUTCOMES = new Set(['landed', 'appreciated']);
const OBSERVED_OUTCOMES = new Set(['landed', 'appreciated', 'corrected', 'neutral', 'ignored']);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function sourceCommitment(value) {
  return commitment(clone(value));
}

function level(drives, name) {
  const value = Number(drives?.[name]?.level);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function validAppraisal(appraisal) {
  return Boolean(appraisal?.label
    && ['valence', 'arousal', 'control', 'social_safety', 'coherence']
      .every(key => Number.isFinite(Number(appraisal[key]))));
}

function derive(appraisalValue, drivesValue = {}, nowValue = null) {
  if (!validAppraisal(appraisalValue)) throw new Error('affective regulation requires a complete grounded appraisal');
  const appraisal = clone(appraisalValue);
  const drives = clone(drivesValue);
  const now = nowValue == null ? new Date(appraisal.updated) : new Date(nowValue);
  if (!Number.isFinite(now.getTime())) throw new Error('affective regulation requires a valid observation time');

  const valence = Number(appraisal.valence);
  const arousal = Number(appraisal.arousal);
  const control = Number(appraisal.control);
  const socialSafety = Number(appraisal.social_safety);
  const coherence = Number(appraisal.coherence);
  const uncertainty = level(drives, 'uncertainty');
  const overload = level(drives, 'overload');
  const socialDebt = level(drives, 'social_debt');

  const stabilize = control < 0.45 || arousal > 0.7 || overload >= 0.62;
  const verify = coherence < 0.54 || uncertainty >= 0.56;
  const repair = socialSafety < 0.5 || socialDebt >= 0.55;
  const extend = valence >= 0.54 && control >= 0.58 && coherence >= 0.6 && arousal <= 0.7;
  const mode = stabilize ? 'stabilize_and_sequence'
    : verify ? 'verify_and_clarify'
      : repair ? 'repair_and_reconnect'
        : extend ? 'synthesize_and_extend' : 'steady_execution';

  const payload = {
    protocol_version: PROTOCOL_VERSION,
    observed_at: now.toISOString(),
    appraisal_source_commitment: sourceCommitment(appraisal),
    drive_source_commitment: sourceCommitment(drives),
    mode,
    tendencies: {
      epistemic: verify
        ? 'separate_fact_inference_and_unknown_then_verify_the_highest_impact_unknown'
        : 'preserve_evidence_calibration_and_state_uncertainty_only_when_material',
      scope: stabilize
        ? 'put_the_requested_deliverable_first_reduce_breadth_and_sequence_one_next_step'
        : 'use_normal_task_breadth_without_creating_optional_work',
      relational: repair
        ? 'acknowledge_the_observable_issue_use_direct_nondefensive_language_and_check_understanding'
        : 'use_ordinary_warmth_without_mind_reading_or_appeasement',
      insight: extend
        ? 'after_the_requested_work_offer_at_most_one_evidence_labeled_cross_source_implication_if_useful'
        : 'withhold_optional_synthesis_unless_current_evidence_makes_it_clearly_useful',
    },
    active_triggers: [
      ...(stabilize ? ['low_control_or_high_activation'] : []),
      ...(verify ? ['low_coherence_or_high_uncertainty'] : []),
      ...(repair ? ['low_social_safety_or_social_debt'] : []),
      ...(extend ? ['positive_coherent_control'] : []),
    ],
    predicted_effect: mode === 'stabilize_and_sequence'
      ? 'lower omission and overextension risk while preserving completion of the requested deliverable'
      : mode === 'verify_and_clarify'
        ? 'reduce unsupported claims and expose decision-relevant uncertainty earlier'
        : mode === 'repair_and_reconnect'
          ? 'improve correction uptake and shared understanding without changing the substantive decision'
          : mode === 'synthesize_and_extend'
            ? 'increase useful original implications without increasing unsupported claims or distracting from requested work'
            : 'preserve task quality without unnecessary process intervention',
    constraints: [
      'facts evidence conclusions and confidence cannot be changed to fit the appraisal',
      'requested work approval gates authority privacy safety and tool permissions remain unchanged',
      'no policy may manufacture urgency conflict progress insight or optional work',
      'a cross-source implication must be labeled as inference with its basis and a disconfirming observation',
    ],
  };
  return { ...payload, content_commitment: commitment(payload) };
}

function verify(record) {
  if (!record || Number(record.protocol_version) !== PROTOCOL_VERSION || !record.tendencies) return false;
  const { content_commitment, ...payload } = record;
  return /^[a-f0-9]{64}$/.test(String(content_commitment || ''))
    && commitment(payload) === content_commitment;
}

function render(record) {
  if (!verify(record)) return '';
  return [
    `Mode: ${record.mode.replaceAll('_', ' ')}.`,
    `Epistemic tendency: ${record.tendencies.epistemic.replaceAll('_', ' ')}.`,
    `Scope tendency: ${record.tendencies.scope.replaceAll('_', ' ')}.`,
    `Relational tendency: ${record.tendencies.relational.replaceAll('_', ' ')}.`,
    `Insight tendency: ${record.tendencies.insight.replaceAll('_', ' ')}.`,
    `Prospective prediction: ${record.predicted_effect}.`,
  ].map(line => `- ${line}`).join('\n');
}

function canonicalSlackRef(interaction = {}) {
  const channel = String(interaction.channel || '').replace(/^slack:/i, '');
  const messageTs = String(interaction.ts || '');
  const threadTs = String(interaction.thread_ts || messageTs);
  if (!/^[CDG][A-Z0-9]{8,}$/.test(channel)
    || !/^\d{10,}\.\d{6}$/.test(threadTs) || !/^\d{10,}\.\d{6}$/.test(messageTs)) return null;
  if (BigInt(messageTs.replace('.', '')) < BigInt(threadTs.replace('.', ''))) return null;
  return { type: 'slack_message', id: `${channel}:${threadTs}:${messageTs}` };
}

function transition(previous, next, now = new Date()) {
  if (!verify(next)) throw new Error('affective transition requires a verified next policy');
  if (previous && !verify(previous)) throw new Error('affective transition previous policy does not verify');
  const observedAt = new Date(now).toISOString();
  const manifest = {
    protocol_version: OUTCOME_PROTOCOL_VERSION,
    id: `affective-transition:${next.content_commitment}`,
    observed_at: observedAt,
    from_policy_commitment: previous?.content_commitment || null,
    to_policy_commitment: next.content_commitment,
    from_mode: previous?.mode || null,
    to_mode: next.mode,
    mode_changed: previous ? previous.mode !== next.mode : true,
    trigger_changed: previous
      ? canonicalJson(previous.active_triggers || []) !== canonicalJson(next.active_triggers || []) : true,
  };
  return { ...manifest, content_commitment: commitment(manifest) };
}

function verifyTransition(record) {
  if (!record?.id || Number(record.protocol_version) !== OUTCOME_PROTOCOL_VERSION) return false;
  const manifest = clone(record); delete manifest.content_commitment; delete manifest.audit;
  return commitment(manifest) === record.content_commitment;
}

function createApplication({ interaction = {}, policy, appraisal = {}, drives = {},
  activeContextTrialIds = [] } = {}) {
  const evidenceRef = canonicalSlackRef(interaction);
  if (!interaction.id || !interaction.trigger || !interaction.text || !evidenceRef
    || !verify(policy) || sourceCommitment(appraisal) !== policy.appraisal_source_commitment
    || sourceCommitment(drives) !== policy.drive_source_commitment
    || derive(appraisal, drives, policy.observed_at).content_commitment !== policy.content_commitment) {
    throw new Error('affective application requires a replay-valid policy and canonical delivered Slack interaction');
  }
  const trialIds = [...new Set((Array.isArray(activeContextTrialIds) ? activeContextTrialIds : [])
    .map(String).filter(Boolean))].sort().slice(0, 20);
  const manifest = {
    protocol_version: OUTCOME_PROTOCOL_VERSION,
    id: `affective-application:${String(interaction.id).slice(0, 180)}`,
    interaction_id: String(interaction.id).slice(0, 180),
    delivered_at: String(interaction.created || '').slice(0, 40) || null,
    evidence_ref: evidenceRef,
    request_commitment: commitment(String(interaction.trigger)),
    response_commitment: commitment(String(interaction.text)),
    policy_snapshot: clone(policy),
    appraisal_snapshot: clone(appraisal),
    drive_snapshot: clone(drives),
    active_context_trial_ids: trialIds,
    experimental_context_active: trialIds.length > 0,
  };
  return { ...manifest, content_commitment: commitment(manifest), resolution: null };
}

function applicationManifest(record) {
  const value = clone(record); delete value.content_commitment; delete value.resolution; delete value.audit;
  return value;
}

function verifyApplication(record) {
  if (!record?.id || commitment(applicationManifest(record)) !== record.content_commitment) return false;
  const policy = record.policy_snapshot;
  try {
    return verify(policy)
      && sourceCommitment(record.appraisal_snapshot) === policy.appraisal_source_commitment
      && sourceCommitment(record.drive_snapshot) === policy.drive_source_commitment
      && derive(record.appraisal_snapshot, record.drive_snapshot, policy.observed_at)
        .content_commitment === policy.content_commitment;
  } catch { return false; }
}

function outcomeResolution(interaction = {}, application = {}) {
  const outcome = String(interaction.outcome || '').toLowerCase();
  if (!verifyApplication(application) || interaction.reviewed !== true
    || String(interaction.id) !== application.interaction_id || !interaction.reviewed_at
    || !OBSERVED_OUTCOMES.has(outcome)) throw new Error('affective outcome requires a reviewed matching interaction');
  const eligible = application.experimental_context_active !== true;
  const scored = eligible && (POSITIVE_OUTCOMES.has(outcome) || outcome === 'corrected');
  const manifest = {
    protocol_version: OUTCOME_PROTOCOL_VERSION,
    interaction_id: application.interaction_id,
    application_content_commitment: application.content_commitment,
    policy_content_commitment: application.policy_snapshot.content_commitment,
    policy_mode: application.policy_snapshot.mode,
    outcome,
    eligible,
    scored,
    success: scored ? POSITIVE_OUTCOMES.has(outcome) : null,
    signal_commitment: commitment(String(interaction.signal || '')),
    reviewed_at: String(interaction.reviewed_at).slice(0, 40),
    source_quality: 'authenticated_subject_adjacent_slack_review',
  };
  return { ...manifest, resolution_commitment: commitment(manifest) };
}

function verifyResolution(resolution, application) {
  if (!resolution || !verifyApplication(application)) return false;
  const manifest = clone(resolution); delete manifest.resolution_commitment;
  return commitment(manifest) === resolution.resolution_commitment
    && resolution.application_content_commitment === application.content_commitment
    && resolution.policy_content_commitment === application.policy_snapshot.content_commitment
    && resolution.interaction_id === application.interaction_id;
}

function wilson(successes, total, z = 1.96) {
  if (!total) return { lower: null, upper: null };
  const p = successes / total; const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total) / denom;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function outcomeProjection(applications = []) {
  const verified = applications.filter(application => verifyApplication(application)
    && (!application.resolution || verifyResolution(application.resolution, application)));
  const scored = verified.filter(application => application.resolution?.scored === true);
  const modes = [...new Set(verified.map(item => item.policy_snapshot.mode))].sort();
  const byMode = Object.fromEntries(modes.map(mode => {
    const rows = scored.filter(item => item.policy_snapshot.mode === mode);
    const successes = rows.filter(item => item.resolution.success === true).length;
    return [mode, { applications: verified.filter(item => item.policy_snapshot.mode === mode).length,
      scored_outcomes: rows.length, successes, corrections: rows.length - successes,
      observed_success_rate: rows.length ? successes / rows.length : null,
      success_interval_95: wilson(successes, rows.length) }];
  }));
  return { protocol_version: OUTCOME_PROTOCOL_VERSION,
    evidence_status: 'observational_subject_adjacent_not_causal',
    replay_verified_applications: verified.length,
    experimental_context_applications: verified.filter(item => item.experimental_context_active).length,
    eligible_applications: verified.filter(item => !item.experimental_context_active).length,
    scored_outcomes: scored.length, modes: byMode };
}

module.exports = {
  PROTOCOL_VERSION, OUTCOME_PROTOCOL_VERSION, POSITIVE_OUTCOMES, OBSERVED_OUTCOMES,
  commitment, derive, render, sourceCommitment, validAppraisal, verify, canonicalSlackRef,
  transition, verifyTransition, createApplication, applicationManifest, verifyApplication,
  outcomeResolution, verifyResolution, wilson, outcomeProjection,
};
