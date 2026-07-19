'use strict';

const crypto = require('node:crypto');
const accessOutcome = require('./professional-viewpoint-access-outcome');

const PROTOCOL_VERSION = 1;
const MIN_CALIBRATION_SAMPLES = 3;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function statusFor({ helpful, corrections, scored }) {
  if (scored < MIN_CALIBRATION_SAMPLES) return 'collecting_evidence';
  if (corrections >= 2 && corrections >= helpful) return 'needs_caution';
  if (helpful >= MIN_CALIBRATION_SAMPLES && corrections === 0) return 'provisionally_helpful';
  return 'mixed';
}

function derive(applications = [], currentViewpoints = []) {
  const currentById = new Map((currentViewpoints || []).filter(item => item?.viewpoint_id)
    .map(item => [item.viewpoint_id, item]));
  const ambiguous = [];
  const eligible = [];

  for (const record of applications || []) {
    if (record?.audit?.complete_chain_verified !== true
      || !accessOutcome.verifyApplication(record)
      || !record.resolution || !accessOutcome.verifyResolution(record.resolution, record)
      || record.observational_outcome_eligible !== true || record.resolution.eligible !== true) continue;
    if (record.prompt_viewpoints.length !== 1) {
      ambiguous.push(record.id);
      continue;
    }
    const supplied = record.prompt_viewpoints[0];
    const current = currentById.get(supplied.viewpoint_id);
    if (!current || current.current_position_commitment !== supplied.current_position_commitment) continue;
    eligible.push(record);
  }

  const grouped = new Map();
  for (const record of eligible) {
    const viewpointId = record.prompt_viewpoints[0].viewpoint_id;
    const rows = grouped.get(viewpointId) || [];
    rows.push(record);
    grouped.set(viewpointId, rows);
  }

  const calibrations = [...grouped.entries()].map(([viewpointId, rows]) => {
    const outcomes = rows.map(record => record.resolution);
    const helpful = outcomes.filter(item => item.success === true).length;
    const corrections = outcomes.filter(item => item.outcome === 'corrected').length;
    const neutral = outcomes.filter(item => item.outcome === 'neutral').length;
    const ignored = outcomes.filter(item => item.outcome === 'ignored').length;
    const scored = helpful + corrections;
    const sourceReceipts = rows.map(record => ({
      application_id: record.id,
      application_content_commitment: record.content_commitment,
      resolution_commitment: record.resolution.resolution_commitment,
      outcome: record.resolution.outcome,
      reviewed_at: record.resolution.reviewed_at,
    })).sort((left, right) => left.application_id.localeCompare(right.application_id));
    return {
      viewpoint_id: viewpointId,
      current_position_commitment: currentById.get(viewpointId).current_position_commitment,
      reviewed_single_viewpoint_exposures: rows.length,
      scored_outcomes: scored,
      helpful_outcomes: helpful,
      corrections,
      neutral_outcomes: neutral,
      ignored_outcomes: ignored,
      observed_helpfulness_rate: scored ? helpful / scored : null,
      helpfulness_interval_95: accessOutcome.wilson(helpful, scored),
      calibration_status: statusFor({ helpful, corrections, scored }),
      latest_reviewed_at: outcomes.map(item => item.reviewed_at).sort().at(-1) || null,
      source_receipts: sourceReceipts,
    };
  }).sort((left, right) => left.viewpoint_id.localeCompare(right.viewpoint_id));

  const payload = {
    protocol_version: PROTOCOL_VERSION,
    evidence_status: 'observational_whole_reply_usefulness_not_viewpoint_use_truth_or_causal_effect',
    minimum_scored_samples_for_calibration: MIN_CALIBRATION_SAMPLES,
    eligible_resolved_single_viewpoint_applications: eligible.length,
    ambiguous_multi_viewpoint_applications_excluded: ambiguous.length,
    calibrations,
  };
  return { ...payload, content_commitment: commitment(payload) };
}

function verify(projection, applications = [], currentViewpoints = []) {
  if (!projection || Number(projection.protocol_version) !== PROTOCOL_VERSION) return false;
  const { content_commitment: contentCommitment, ...payload } = projection;
  const replay = derive(applications, currentViewpoints);
  return commitment(payload) === contentCommitment
    && canonicalJson(projection) === canonicalJson(replay);
}

function guidance(calibration) {
  if (!calibration) return null;
  const base = `${calibration.reviewed_single_viewpoint_exposures} eligible reviewed whole-reply exposures; ${calibration.helpful_outcomes} landed/appreciated, ${calibration.corrections} corrected, ${calibration.neutral_outcomes} neutral, ${calibration.ignored_outcomes} ignored`;
  if (calibration.calibration_status === 'needs_caution') {
    return `${base}. Prior usefulness needs caution: verify the current evidence before surfacing this view.`;
  }
  if (calibration.calibration_status === 'provisionally_helpful') {
    return `${base}. Provisionally useful, but this does not raise the view's truth confidence.`;
  }
  if (calibration.calibration_status === 'mixed') {
    return `${base}. Mixed usefulness: apply selectively and verify.`;
  }
  return `${base}. Still collecting evidence; do not change behavior from this signal yet.`;
}

function compact(projection) {
  return {
    ...projection,
    calibrations: (projection?.calibrations || []).map(({ source_receipts: _receipts, ...item }) => item),
  };
}

module.exports = {
  PROTOCOL_VERSION, MIN_CALIBRATION_SAMPLES, canonicalJson, commitment,
  statusFor, derive, verify, guidance, compact,
};
