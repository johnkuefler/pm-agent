const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const pulseProtocol = require('../../src/intelligence/cognitive-pulse');
const regulation = require('../../src/intelligence/cognitive-self-regulation');

function output(packet, options = {}) {
  const focus = options.focus || packet.evidence[0].ref;
  return { focus_refs: [focus], hypothesis: 'The unresolved evidence may still change the release decision.',
    alternatives: ['The evidence may no longer be decision-relevant.'], uncertainty: options.uncertainty ?? 0.4,
    predicted_relevance: 'A later pulse can test whether the evidence remains active.',
    disconfirming_observation: 'The next pulse drops the hypothesis or focuses on unrelated evidence.',
    predecessor_update: packet.predecessor
      ? { predecessor_id: packet.predecessor.id, disposition: options.disposition || 'revise',
        rationale: 'The next committed evidence still bears on the predecessor.', evidence_refs: [focus] }
      : { predecessor_id: null, disposition: 'none', rationale: 'No predecessor exists.', evidence_refs: [] },
    self_inquiry: null, self_claim_proposal: null,
    metacognitive_forecast: { next_focus_refs: [focus], expected_uncertainty: options.uncertainty ?? 0.4,
      expected_continuation_probability: options.continuation ?? 0.8,
      expected_value_of_next_pulse: options.value ?? 0.8,
      rationale: 'This unresolved evidence is likely to remain the highest-value cognitive target.',
      falsifier: 'The next accepted pulse focuses elsewhere, has materially different uncertainty, or drops the predecessor.' } };
}

test('protocol-v5 forecasts are evidence-bound and calibration gates adaptive cadence', () => {
  const packet = { evidence: [{ ref: { type: 'commitment', id: 'e1' } }], predecessor: null,
    constraints: { protocol_version: 5 } };
  const valid = output(packet);
  assert.deepEqual(pulseProtocol.validateOutput(valid, packet), valid);
  assert.throws(() => pulseProtocol.validateOutput({ ...valid, metacognitive_forecast: {
    ...valid.metacognitive_forecast, next_focus_refs: [{ type: 'commitment', id: 'outside' }] } }, packet),
  /must cite supplied evidence/);
  assert.throws(() => pulseProtocol.validateOutput({ ...valid, metacognitive_forecast: undefined }, packet),
    /requires a metacognitive_forecast/);
  const records = Array.from({ length: 10 }, (_, index) => ({ id: `f${index}`, status: 'resolved',
    resolution: { metrics: { self_forecast_score: 0.9, persistence_baseline_score: 0.7 } } }));
  assert.equal(regulation.calibrationPolicy(records).mode, 'calibrated_adaptive');
  for (const record of records) record.resolution.metrics.self_forecast_score = 0.7;
  assert.equal(regulation.calibrationPolicy(records).mode, 'fixed_default');
  assert.equal(regulation.adaptiveIntervalMinutes({ expected_value_of_next_pulse: 0.8 }), 30);
  assert.equal(regulation.adaptiveIntervalMinutes({ expected_value_of_next_pulse: 0.1 }), 240);
  assert.deepEqual(regulation.cadenceForForecast({ expected_value_of_next_pulse: 0.1 },
    { mode: 'fixed_default' }, 30, false), {
    application_mode: 'fixed_default', adaptive_interval_minutes: 240,
    default_interval_minutes: 30, effective_interval_minutes: 30 });
  assert.equal(regulation.cadenceForForecast({ expected_value_of_next_pulse: 0.1 },
    { mode: 'calibrated_adaptive' }, 30, false).effective_interval_minutes, 240);
  assert.equal(regulation.cadenceForForecast({ expected_value_of_next_pulse: 0.8 },
    { mode: 'calibrated_adaptive' }, 30, true).application_mode, 'study_fixed_default');
});

test('accepted pulses prospectively predict the next state, resolve automatically, and fail closed under tampering', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-cognitive-self-regulation-'));
  const filePath = path.join(dir, 'state.json'); let now = new Date('2026-07-13T15:00:00.000Z');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(now) });
  await store.init();
  store.addCommitment({ id: 'self-regulation-a', what: 'Reconcile the release evidence', owner: 'Nora' });
  store.addCommitment({ id: 'self-regulation-b', what: 'Check the accessibility result', owner: 'Nora' });
  store.tickEndogenousDynamics({ now }); now = new Date('2026-07-13T16:00:00.000Z');
  store.tickEndogenousDynamics({ now });
  const first = store.prepareCognitivePulse({ id: 'self-regulation-pulse-1', model: 'test-model', force: true });
  const firstOutput = output(first.pulse.input_packet);
  store.recordCognitivePulseResult(first.pulse.id,
    { input_commitment: first.pulse.input_commitment, output: firstOutput });
  let snapshot = store.cognitiveSelfRegulationSnapshot();
  assert.equal(snapshot.report.open, 1);
  assert.equal(snapshot.forecasts[0].application_mode, 'fixed_default');
  assert.equal(snapshot.forecasts[0].audit.complete_chain_verified, true);

  now = new Date('2026-07-13T16:10:00.000Z');
  const early = store.prepareCognitivePulse({ id: 'too-early', model: 'test-model' });
  assert.equal(early.reason, 'minimum_interval');
  now = new Date('2026-07-13T16:31:00.000Z');
  const second = store.prepareCognitivePulse({ id: 'self-regulation-pulse-2', model: 'test-model' });
  assert.equal(second.prepared, true);
  const predictedFocus = firstOutput.metacognitive_forecast.next_focus_refs[0];
  assert.ok(second.pulse.input_packet.evidence.some(item =>
    item.ref.type === predictedFocus.type && item.ref.id === predictedFocus.id));
  store.recordCognitivePulseResult(second.pulse.id, { input_commitment: second.pulse.input_commitment,
    output: output(second.pulse.input_packet, { focus: predictedFocus }) });
  snapshot = store.cognitiveSelfRegulationSnapshot();
  assert.equal(snapshot.report.resolved, 1);
  assert.equal(snapshot.forecasts[0].resolution.actual.predecessor_disposition, 'revise');
  assert.equal(snapshot.forecasts.every(record => record.audit.complete_chain_verified), true);

  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.cognition.background_inference.self_regulation.forecasts[0].forecast.expected_uncertainty = 0.99;
  fs.writeFileSync(filePath, JSON.stringify(raw));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(now) });
  await reloaded.init();
  const tampered = reloaded.cognitiveSelfRegulationSnapshot();
  assert.equal(tampered.forecasts[0].audit.complete_chain_verified, false);
  assert.equal(tampered.forecasts[1].audit.calibration_verified, false,
    'later cadence policy inherits the exact replay-valid calibration basis');
  fs.rmSync(dir, { recursive: true, force: true });
});
