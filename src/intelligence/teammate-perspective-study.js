'use strict';

const perspective = require('./teammate-perspective');

const CONDITIONS = Object.freeze([
  'current_teammate_bound_model',
  'identity_withheld_same_model',
  'reviewed_observations_only',
]);

function neutralizePerson(value, person) {
  const text = String(value || '');
  const target = String(person || '').trim();
  if (!target) return text;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, 'gi'),
    '$1the observed teammate');
}

function personNeutral(value, person) {
  const serialized = JSON.stringify(value);
  return neutralizePerson(serialized, person) === serialized;
}

function rawObservations(frame = {}) {
  return (frame.source_records || []).map(item => ({
    dimension: item.dimension,
    hypothesis: neutralizePerson(item.hypothesis, frame.person),
    confidence: item.confidence,
    prediction: {
      observable: neutralizePerson(item.formation_record?.prediction?.observable, frame.person),
      probability: item.formation_record?.prediction?.probability,
      control_probability: item.formation_record?.prediction?.control_probability,
      falsification_criteria: (item.formation_record?.prediction?.falsification_criteria || [])
        .map(value => neutralizePerson(value, frame.person)),
    },
    observed_outcome: item.independent_review?.outcome,
    observed: neutralizePerson(item.resolution_record?.observed, frame.person),
    confounds: (item.resolution_record?.confounds || [])
      .map(value => neutralizePerson(value, frame.person)),
  }));
}

function modelSynthesis(frame = {}) {
  return {
    dimensions: [...(frame.dimensions || [])],
    scored_prediction_count: frame.scored_prediction_count,
    supported_patterns: (frame.supported_patterns || []).map(item => ({
      ...JSON.parse(JSON.stringify(item)),
      hypothesis: neutralizePerson(item.hypothesis, frame.person),
      observable: neutralizePerson(item.observable, frame.person),
      falsification_criteria: (item.falsification_criteria || [])
        .map(value => neutralizePerson(value, frame.person)),
    })),
    contradicted_patterns: (frame.contradicted_patterns || []).map(item => ({
      ...JSON.parse(JSON.stringify(item)),
      hypothesis: neutralizePerson(item.hypothesis, frame.person),
      observable: neutralizePerson(item.observable, frame.person),
    })),
    calibration: JSON.parse(JSON.stringify(frame.calibration || {})),
  };
}

function conditionPacket(frame, condition) {
  if (!CONDITIONS.includes(condition)) throw new Error('unsupported teammate perspective condition');
  return {
    protocol_version: 1,
    target_relation: condition === 'current_teammate_bound_model' ? 'current_teammate'
      : condition === 'identity_withheld_same_model' ? 'identity_withheld'
        : 'model_withheld',
    reviewed_observations: rawObservations(frame),
    model: condition === 'reviewed_observations_only' ? null : modelSynthesis(frame),
  };
}

module.exports = {
  CONDITIONS,
  canonicalJson: perspective.canonicalJson,
  commitment: perspective.commitment,
  conditionPacket,
  modelSynthesis,
  neutralizePerson,
  personNeutral,
  rawObservations,
};
