'use strict';

const crypto = require('node:crypto');

const PROTOCOL_VERSION = 1;

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

module.exports = { PROTOCOL_VERSION, commitment, derive, render, sourceCommitment, validAppraisal, verify };
