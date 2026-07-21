const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const expectationForecast = require('../../src/intelligence/expectation-forecast');

test('EXPECT scores source-bound outcomes and calibration without scoring unavailable perception', () => {
  const claims = expectationForecast.normalizeClaims([{ scope: 'slack_inbox', claims: [
    { claim: 'A teammate asks for a status update', probability: 0.8 },
  ] }], () => 'claim-1');
  assert.equal(claims[0].claims[0].probability, 0.8);
  assert.deepEqual(expectationForecast.scoreClaim(claims[0].claims[0], { outcome: false }), {
    scored: true, brier: 0.6400000000000001, predicted: true, confidence: 0.8,
    miss: true, high_confidence_miss: true, magnitude: 0.8,
  });
  assert.equal(expectationForecast.scoreClaim(claims[0].claims[0], { outcome: 'unclear' }).scored, false);
  assert.throws(() => expectationForecast.normalizeEvidence([{ type: 'made_up', id: 'x' }]), /invalid expectation evidence type/);
  assert.throws(() => expectationForecast.normalizeClaims([{ scope: 'run_shape', claims: [
    { claim: 'p', probability: 0.5 },
  ] }], () => 'claim-junk'), /concrete observable sentence/);
});

test('EXPECT is preregistered after the self-forecast, resolved in the same cycle, and reloads replay-valid', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-expect-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'state.json');
  let now = new Date('2026-07-17T14:00:00.000Z');
  const makeStore = () => createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date(now) });
  const store = makeStore();
  await store.init();
  const started = store.startCycle({ id: 'expect-cycle', holder: 'nora', run_lock_holder: 'run-expect' });
  assert.throws(() => store.createExpectationForecast(started.cycle.id, {
    rationale: 'Before perception', scopes: [{ scope: 'slack_inbox', claims: [{ claim: 'A DM is waiting', probability: 0.9 }] }],
  }), /replay-verified cycle self-forecast/);
  store.preregisterCycleSelfForecast(started.cycle.id, {
    predicted_action_types: ['review'], surprise_probability: 0.2, control_at_close: 0.7,
    confidence: 0.6, rationale: 'The run should remain bounded and source-grounded.',
    evidence: [{ type: 'intelligence_cycle', id: started.cycle.id }],
  });
  const forecast = store.createExpectationForecast(started.cycle.id, {
    rationale: 'Recent hourly runs usually contain a Slack request while email availability can vary.',
    producer: { kind: 'cowork_cycle', model: 'test-model' },
    scopes: [
      { scope: 'slack_inbox', claims: [{ claim: 'At least one actionable DM is waiting', probability: 0.9 }] },
      { scope: 'email_inbox', claims: [{ claim: 'Email is available for inspection', probability: 0.7 }] },
    ],
  });
  assert.equal(forecast.audit.complete_chain_verified, true);
  assert.doesNotMatch(store.promptContext({}), /At least one actionable DM is waiting/,
    'EXPECT claims must not enter Slack, Zoom-chat, or realtime prompt context');
  assert.throws(() => store.completeCycle(started.cycle.id, { summary: 'too early' }), /resolve expectation forecast/);
  now = new Date('2026-07-17T14:03:00.000Z');
  const [slackClaim, emailClaim] = forecast.scopes.flatMap(group => group.claims);
  const resolutionPayload = { claims: [
    { claim_id: slackClaim.id, outcome: false, observed_at: now.toISOString(),
      evidence: [{ type: 'run_observation', id: 'slack-scan-1' }] },
    { claim_id: emailClaim.id, outcome: 'unclear', observed_at: now.toISOString(),
      evidence: [{ type: 'connector_failure', id: 'gmail-invalidated-1' }] },
  ] };
  assert.deepEqual(store.validateExpectationForecastResolution(forecast.id, resolutionPayload), {
    valid: true, forecast_id: forecast.id, claim_count: 2,
  });
  assert.equal(store.expectationForecastSnapshot().forecasts[0].status, 'open',
    'validation must not resolve the one-shot forecast');
  assert.throws(() => store.validateExpectationForecastResolution(forecast.id, { claims: [
    { ...resolutionPayload.claims[0], evidence: [{ type: 'email_message', id: 'wrong-scope' }] },
    resolutionPayload.claims[1],
  ] }), /not valid for slack_inbox/);
  assert.equal(store.expectationForecastSnapshot().forecasts[0].status, 'open');
  const resolved = store.resolveExpectationForecast(forecast.id, resolutionPayload);
  assert.equal(resolved.audit.complete_chain_verified, true);
  assert.equal(resolved.resolution.score.scored, 1);
  assert.equal(resolved.resolution.score.unclear, 1);
  assert.equal(resolved.resolution.score.high_confidence_misses, 1);
  const surprise = store.snapshot().cognition.surprises.find(item => item.forecast_id === forecast.id);
  assert.equal(surprise.source_bound, true);
  assert.equal(store.expectationSurprise(surprise.id).id, surprise.id);
  const snapshot = store.expectationForecastSnapshot();
  assert.equal(snapshot.report.rolling_30_day.overall.n, 1);
  assert.equal(snapshot.report.rolling_30_day.overall.direction, 'overconfident');
  assert.equal(snapshot.report.collection_gate.ready, false);
  assert.throws(() => store.completeCycle(started.cycle.id, { summary: 'probe', handoff: 'probe' }),
    /diagnostic placeholder/);
  assert.equal(store.list('cycles').find(item => item.id === started.cycle.id).status, 'running');
  assert.deepEqual(store.validateCycleCompletion(started.cycle.id, {
    summary: 'Perception completed and EXPECT resolved.', actions: [],
  }), { valid: true, cycle_id: started.cycle.id, action_count: 0 });
  store.completeCycle(started.cycle.id, { summary: 'Perception completed and EXPECT resolved.', actions: [] });
  await store.persistStrict();

  const reloaded = makeStore();
  await reloaded.init();
  const replay = reloaded.expectationForecastSnapshot();
  assert.equal(replay.report.replay_verified_resolved, 1);
  assert.equal(replay.forecasts[0].audit.complete_chain_verified, true);
  assert.equal(replay.report.collection_gate.scored_claims, 1);
  assert.equal(replay.report.collection_gate.scored_scopes, 1);
  assert.equal(replay.report.collection_gate.longest_consecutive_collection_days, 1);
  assert.equal(replay.report.collection_gate.source_bound_surprises, 1);

  const staleCycle = reloaded.startCycle({ id: 'expect-stale-cycle', holder: 'nora', run_lock_holder: 'run-stale' });
  reloaded.preregisterCycleSelfForecast(staleCycle.cycle.id, {
    predicted_action_types: ['review'], surprise_probability: 0.2, control_at_close: 0.7,
    confidence: 0.6, rationale: 'The run should close normally unless its process is interrupted.',
    evidence: [{ type: 'intelligence_cycle', id: staleCycle.cycle.id }],
  });
  const staleForecast = reloaded.createExpectationForecast(staleCycle.cycle.id, {
    rationale: 'Commit one source expectation before a simulated process interruption.',
    scopes: [{ scope: 'run_shape', claims: [{ claim: 'The cycle closes normally', probability: 0.8 }] }],
  });
  now = new Date('2026-07-17T16:00:00.000Z');
  reloaded.recoverStaleCycles({ now, staleAfterMs: 60 * 60000, reason: 'test_process_interruption' });
  const abandoned = reloaded.expectationForecastSnapshot().forecasts.find(item => item.id === staleForecast.id);
  assert.equal(abandoned.status, 'abandoned');
  assert.equal(abandoned.audit.abandonment_commitment_verified, true);
  assert.equal(abandoned.audit.complete_chain_verified, true);

  const tamperedState = reloaded.snapshot();
  tamperedState.cognition.expectations.forecasts[0].scopes[0].claims[0].probability = 0.1;
  const tampered = createIntelligenceStore({ filePath: path.join(dir, 'tampered-state.json'), db: {},
    isDbReady: () => false, initialState: tamperedState, clock: () => new Date(now) });
  await tampered.init();
  const excluded = tampered.expectationForecastSnapshot();
  assert.equal(excluded.forecasts[0].audit.complete_chain_verified, false);
  assert.equal(excluded.report.rolling_30_day.overall.n, 0,
    'integrity-invalid forecasts must not become calibration self-knowledge');
  assert.equal(excluded.report.collection_gate.source_bound_surprises, 0);
});

test('EXPECT collection gate requires longitudinal, cross-scope, surprise-bearing evidence', () => {
  const forecasts = Array.from({ length: 7 }, (_, day) => ({
    made_at: `2026-07-${String(10 + day).padStart(2, '0')}T14:00:00.000Z`,
    resolution: { resolved_at: `2026-07-${String(10 + day).padStart(2, '0')}T14:05:00.000Z`,
      claims: [] },
    scopes: ['slack_inbox', 'email_inbox', 'teamwork_deadlines'].map((scope, scopeIndex) => ({
      scope, claims: Array.from({ length: 2 }, (_, claimIndex) => ({
        id: `${day}-${scopeIndex}-${claimIndex}`, probability: 0.7, claim: 'bounded observable claim',
      })),
    })),
  }));
  for (const forecast of forecasts) {
    forecast.resolution.claims = forecast.scopes.flatMap(group => group.claims.map(claim => ({
      claim_id: claim.id, outcome: true,
    })));
  }
  const calibration = expectationForecast.summarize(forecasts);
  const gate = expectationForecast.collectionGate(forecasts, [{ origin: 'expectation_forecast',
    source_bound: true, replay_verified: true }], calibration);
  assert.equal(gate.scored_claims, 42);
  assert.equal(gate.scored_scopes, 3);
  assert.equal(gate.longest_consecutive_collection_days, 7);
  assert.equal(gate.source_bound_surprises, 1);
  assert.equal(gate.ready, true);
});

test('EXPECT exposes compact calibration before forecast formation without adding a provider path', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'intelligence.js'), 'utf8');
  const routine = fs.readFileSync(path.join(__dirname, '..', '..', 'nora-routine.md'), 'utf8');
  const instructions = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes',
    'cowork-instructions.js'), 'utf8');
  assert.match(routes, /req\.query\.summary === '1'[\s\S]*epistemic_status:[\s\S]*report:/);
  assert.match(routes, /resolution_contract: expectationForecast\.resolutionContract/);
  assert.match(routes, /validate_only[\s\S]*validation_commitment[\s\S]*require_validation/);
  assert.deepEqual(expectationForecast.resolutionContract().evidence_types_by_scope.run_shape,
    ['run_observation', 'intelligence_cycle', 'connector_failure']);
  assert.ok(routine.indexOf('GET /expectations?summary=1')
    < routine.indexOf('POST /expectations`'),
  'calibration must be available before the same invocation commits its forecast');
  assert.match(routine, /historically overconfident scope modestly[\s\S]*toward 0\.5/);
  assert.match(instructions, /Use calibration only[\s\S]*never as evidence about the current inbox/);
  assert.doesNotMatch(instructions, /EXPECT[\s\S]{0,500}(?:anthropic|claude|provider call required)/i);
});
