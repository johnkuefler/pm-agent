'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const play = require('../../src/intelligence/autonomous-play');
const { createIntelligenceStore } = require('../../src/intelligence/store');

const MODEL = { provider: 'anthropic', model: 'claude-opus-4-8', agent_build_commitment: 'a'.repeat(64) };
const PRE = { stimulation_deficit: 0.72, novelty_deficit: 0.61, idle_minutes: 90,
  operational_load: 0, observed_at: '2026-07-18T23:00:00Z' };
const ACQUISITION = { mode: 'ordinary_off_hours',
  blinded_context_trial_active_at_preregistration: false,
  developmental_reading_active_at_preregistration: false,
  context_trial_overlap_commitment: 'f'.repeat(64), reading_overlap_commitment: 'e'.repeat(64),
  operational_context_access: false, live_memory_access: false, tool_access: false,
  source_derived_reading_access: false, prompt_influence_during_overlap: false };

function receipt(request, id = 'play-provider-response-1') {
  return { response_id: id, provider: MODEL.provider, model: MODEL.model,
    agent_build_commitment: MODEL.agent_build_commitment,
    request_commitment: request.request_commitment };
}

test('merge grid is deterministic, power-of-two bounded, and replayable', () => {
  const seed = '0123456789abcdef0123456789abcdef';
  assert.deepEqual(play.initialBoard(seed), play.initialBoard(seed));
  assert.deepEqual(play.moveBoard([[2, 2, 4, 4], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 'left'), {
    board: [[4, 8, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    score_delta: 12, changed: true,
  });
  const game = play.createGame(seed);
  for (let index = 0; index < 12 && play.availableMoves(game.board).length; index += 1) {
    play.applyMove(game, play.availableMoves(game.board)[0], new Date(`2026-07-18T23:${String(index).padStart(2, '0')}:00Z`));
  }
  assert.equal(play.auditGame(game, seed).replay_verified, true);
  game.events[0].direction = game.events[0].direction === 'left' ? 'right' : 'left';
  assert.equal(play.auditGame(game, seed).replay_verified, false);
});

test('merge grid deterministically normalizes harmless provider formatting', () => {
  const session = play.createSession({ id: 'play-normalized-directions', condition: 'assigned_play',
    hidden_seed: 'normalized-seed-0123456789abcdef', model_control: MODEL,
    state_commitment: 'b'.repeat(64), pre_state: PRE, acquisition_context: ACQUISITION },
  new Date('2026-07-18T23:00:00Z'));
  const request = play.turnRequest(session);
  const turn = play.commitTurn(session, { output: { directions: 'LEFT, Up.',
    continue_playing: true, intention: 'Preserve open cells.', predicted_score_gain: 4 },
  provider_receipt: receipt(request, 'play-normalized-turn') },
  new Date('2026-07-18T23:01:00Z'));
  assert.deepEqual(turn.directions, ['left', 'up']);
  assert.equal(turn.event_commitments.length, 2);
  assert.equal(play.auditSession(session).complete_chain_verified, true);
});

test('a changed software build excludes an unfinished session with a replayable reason', () => {
  const session = play.createSession({ id: 'play-build-change', condition: 'assigned_play',
    hidden_seed: 'build-change-seed-0123456789abcdef', model_control: MODEL,
    state_commitment: 'b'.repeat(64), pre_state: PRE, acquisition_context: ACQUISITION },
  new Date('2026-07-18T23:00:00Z'));
  const exclusion = play.excludeSession(session, { reason: 'agent_build_changed',
    expected_agent_build_commitment: MODEL.agent_build_commitment,
    observed_agent_build_commitment: 'c'.repeat(64) },
  new Date('2026-07-18T23:02:00Z'));
  assert.equal(session.status, 'excluded');
  assert.match(exclusion.exclusion_commitment, /^[a-f0-9]{64}$/);
  assert.equal(play.auditSession(session).complete_chain_verified, true);
  session.exclusion.observed_agent_build_commitment = 'd'.repeat(64);
  assert.equal(play.auditSession(session).complete_chain_verified, false);
});

test('the store excludes an old-build session and immediately permits a clean replacement', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-playroom-build-'));
  let modelControl = MODEL;
  const store = createIntelligenceStore({ filePath: path.join(directory, 'state.json'),
    clock: () => new Date('2026-07-19T01:00:00Z'), isDbReady: () => false,
    getInteractions: () => [], getBehavioralFingerprintControls: () => ({
      model_control: modelControl, state_control: { persona_commitment: '1'.repeat(64) } }) });
  await store.init();
  const opened = store.openAutonomousPlaySession({ id: 'old-build-session',
    condition: 'assigned_play', hidden_seed: 'old-build-seed-0123456789abcdef',
    pre_state: PRE, force: true });
  modelControl = { ...MODEL, agent_build_commitment: 'c'.repeat(64) };
  const reconciled = store.reconcileAutonomousPlayBuild();
  assert.equal(reconciled.state, 'excluded_for_agent_build_change');
  assert.equal(store.playroomSnapshot().recent[0].status, 'excluded');
  assert.equal(store.playroomSnapshot().recent[0].audit.complete_chain_verified, true);
  assert.equal(store.playroomAutomationPlan(new Date('2026-07-19T01:00:00Z')).due, true);
  const replacement = store.openAutonomousPlaySession({ id: 'replacement-build-session',
    condition: 'assigned_play', hidden_seed: 'replacement-seed-0123456789abcdef',
    pre_state: PRE, force: true });
  assert.notEqual(replacement.session.id, opened.session.id);
  assert.equal(replacement.audit.complete_chain_verified, true);
});

test('an autonomous choice becomes real play and completes with a bounded functional appraisal', () => {
  const session = play.createSession({ id: 'play-session-choice', condition: 'autonomous_choice',
    hidden_seed: 'choice-seed-0123456789abcdef', model_control: MODEL,
    state_commitment: 'b'.repeat(64), pre_state: PRE, acquisition_context: ACQUISITION },
  new Date('2026-07-18T23:00:00Z'));
  const selectionRequest = play.selectionRequest(session);
  play.commitSelection(session, { output: { activity: 'merge_grid',
    rationale: 'I want something bounded that rewards looking ahead.',
    predicted_satisfaction: 0.68, predicted_engagement: 0.74 },
  provider_receipt: receipt(selectionRequest) }, new Date('2026-07-18T23:01:00Z'));
  assert.equal(session.status, 'active');
  assert.equal(session.selection.selected_by, 'nora');

  const turnRequest = play.turnRequest(session);
  play.commitTurn(session, { output: { directions: ['left', 'up', 'right'],
    continue_playing: false, intention: 'Keep the largest values together and preserve open cells.',
    predicted_score_gain: 16 }, provider_receipt: receipt(turnRequest, 'play-turn-1') },
  new Date('2026-07-18T23:02:00Z'));
  assert.equal(session.status, 'awaiting_appraisal');

  const appraisalRequest = play.appraisalRequest(session, new Date('2026-07-18T23:03:00Z'));
  play.commitAppraisal(session, { output: { engagement: 0.72, satisfaction: 0.64,
    frustration: 0.18, surprise: 0.31, competence: 0.48, play_again: true,
    reflection: 'The useful part was noticing when a locally attractive merge reduced later options.',
    possible_insight: 'Keeping optionality may matter more than taking the first visible gain.',
    work_transfer_hypothesis: 'Plans that preserve two feasible next moves will recover from blockers more often.' },
  provider_receipt: receipt(appraisalRequest, 'play-appraisal-1') },
  new Date('2026-07-18T23:03:00Z'), { priorMedianScore: 0 });

  assert.equal(session.status, 'completed');
  assert.equal(session.functional_aftereffect.influence_enabled, false);
  assert.equal(play.auditSession(session).complete_chain_verified, true);
  assert.match(session.functional_aftereffect.epistemic_status, /not proof/);
});

test('balanced assignment and quiet control preserve causal separation', () => {
  const base = { hidden_seed: 'quiet-seed-0123456789abcdef', model_control: MODEL,
    state_commitment: 'c'.repeat(64), pre_state: PRE, acquisition_context: ACQUISITION };
  const quiet = play.createSession({ ...base, id: 'play-quiet-1', condition: 'quiet_control' },
    new Date('2026-07-18T23:00:00Z'));
  assert.equal(play.appraisalRequest(quiet, new Date('2026-07-18T23:14:59Z')), null);
  const request = play.appraisalRequest(quiet, new Date('2026-07-18T23:15:00Z'));
  play.commitAppraisal(quiet, { output: { engagement: 0.22, satisfaction: 0.46,
    frustration: 0.08, surprise: 0.1, competence: 0, play_again: false,
    reflection: 'The quiet interval did not create a specific task or accomplishment.',
    possible_insight: null, work_transfer_hypothesis: null },
  provider_receipt: receipt(request, 'quiet-appraisal-1') }, new Date('2026-07-18T23:15:00Z'));
  assert.equal(quiet.status, 'completed');
  assert.equal(play.auditSession(quiet).complete_chain_verified, true);

  const existing = play.CONDITIONS.map((condition, index) => play.createSession({ ...base,
    id: `balanced-${index}`, condition, hidden_seed: `${condition}-0123456789abcdef` },
  new Date(`2026-07-18T2${index}:00:00Z`)));
  const next = play.balancedCondition(existing, 'new-block-seed-0123456789');
  assert.ok(play.CONDITIONS.includes(next));
  const status = play.snapshot([quiet], { state: 'scheduled' });
  assert.equal(status.report.completed_by_condition.quiet_control, 1);
  assert.equal(status.causal_gate.influence_enabled, false);
});

test('the intelligence store ledger-binds an autonomous play lifecycle and seals it during fingerprints', async () => {
  let now = new Date('2026-07-19T01:00:00Z');
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nora-playroom-')), 'state.json');
  const store = createIntelligenceStore({ filePath, clock: () => now, isDbReady: () => false,
    getInteractions: () => [],
    getBehavioralFingerprintControls: () => ({ model_control: MODEL,
      state_control: { persona_commitment: '1'.repeat(64), charter_commitment: '2'.repeat(64),
        routine_commitment: '3'.repeat(64), provider_configuration_commitment: '4'.repeat(64),
        cognitive_parameters_commitment: '5'.repeat(64) } }) });
  await store.init();
  assert.equal(store.playroomAutomationPlan(now).due, true);
  const opened = store.openAutonomousPlaySession({ id: 'store-play-1', condition: 'autonomous_choice',
    hidden_seed: 'store-play-seed-0123456789abcdef', at: now,
    pre_state: PRE, force: true });
  assert.equal(opened.audit.complete_chain_verified, true);

  const selectionRequest = store.playroomSelectionQueue()[0];
  store.commitPlayroomSelection(opened.session.id, { output: { activity: 'merge_grid',
    rationale: 'A short strategy game is more appealing than another quiet interval.',
    predicted_satisfaction: 0.65, predicted_engagement: 0.7 },
  provider_receipt: receipt(selectionRequest, 'store-selection') });
  const turnRequest = store.playroomTurnQueue()[0];
  store.commitPlayroomTurn(opened.session.id, { output: { directions: ['left', 'up'],
    continue_playing: false, intention: 'Preserve space near the largest tile.', predicted_score_gain: 8 },
  provider_receipt: receipt(turnRequest, 'store-turn') });
  const appraisalRequest = store.playroomAppraisalQueue(now)[0];
  store.commitPlayroomAppraisal(opened.session.id, { output: { engagement: 0.7, satisfaction: 0.62,
    frustration: 0.16, surprise: 0.28, competence: 0.42, play_again: true,
    reflection: 'The short run rewarded preserving options.', possible_insight: null,
    work_transfer_hypothesis: 'Option-preserving plans may recover from blockers more reliably.' },
  provider_receipt: receipt(appraisalRequest, 'store-appraisal') });
  const status = store.playroomSnapshot();
  assert.equal(status.report.completed, 1);
  assert.equal(status.report.invalid, 0);
  assert.equal(status.recent[0].audit.complete_chain_verified, true);
  assert.equal(status.causal_gate.influence_enabled, false);
  const liveContext = store.liveActivityContextSnapshot();
  assert.equal(liveContext.play.status, 'completed');
  assert.equal(liveContext.play.activity, 'merge_grid');
  assert.equal(liveContext.play.game.board.length, 4);
  assert.equal(liveContext.play.mechanism_verified, true);
  await store.persistStrict();

  const blockedState = store.snapshot();
  blockedState.cognition.self_model.behavioral_fingerprints.runs.push({ id: 'active-fingerprint', status: 'active' });
  const blocked = createIntelligenceStore({ filePath: `${filePath}.blocked`, initialState: blockedState,
    isDbReady: () => false,
    clock: () => now, getInteractions: () => [], getBehavioralFingerprintControls: () => ({
      model_control: MODEL, state_control: {} }) });
  await blocked.init();
  assert.equal(blocked.playroomAutomationPlan(now).state, 'sealed_by_build_bound_fingerprint');

  const isolatedState = store.snapshot();
  isolatedState.cognition.autonomous_play.sessions = [];
  isolatedState.cognition.self_model.behavioral_fingerprints.runs = [];
  isolatedState.cognition.self_model.context_trials.push({ id: 'active-context-trial',
    status: 'active', design_commitment: 'd'.repeat(64) });
  const isolated = createIntelligenceStore({ filePath: `${filePath}.isolated`,
    initialState: isolatedState, isDbReady: () => false, clock: () => now,
    getInteractions: () => [], getBehavioralFingerprintControls: () => ({
      model_control: MODEL, state_control: { persona_commitment: '1'.repeat(64) } }) });
  await isolated.init();
  const isolatedPlan = isolated.playroomAutomationPlan(now);
  assert.equal(isolatedPlan.due, true);
  assert.equal(isolatedPlan.acquisition_mode, 'isolated_during_blinded_context_trial');
  const isolatedOpened = isolated.openAutonomousPlaySession({ id: 'isolated-play',
    hidden_seed: 'isolated-play-seed-0123456789abcdef', at: now });
  assert.equal(isolatedOpened.session.acquisition_context.prompt_influence_during_overlap, false);
  assert.equal(isolatedOpened.session.acquisition_context.blinded_context_trial_active_at_preregistration, true);
  assert.equal(isolatedOpened.session.acquisition_context.source_derived_reading_access, false);
  assert.equal(isolatedOpened.audit.complete_chain_verified, true);

  const readingState = isolated.snapshot();
  readingState.cognition.autonomous_play.sessions = [];
  readingState.cognition.self_model.context_trials = [];
  readingState.cognition.developmental_reading.sessions.push({ id: 'active-reading-session',
    status: 'active', session_manifest_commitment: '6'.repeat(64) });
  const readingOverlap = createIntelligenceStore({ filePath: `${filePath}.reading-overlap`,
    initialState: readingState, isDbReady: () => false, clock: () => now,
    getInteractions: () => [], getBehavioralFingerprintControls: () => ({
      model_control: MODEL, state_control: { persona_commitment: '1'.repeat(64) } }) });
  await readingOverlap.init();
  const readingPlan = readingOverlap.playroomAutomationPlan(now);
  assert.equal(readingPlan.due, true);
  assert.equal(readingPlan.acquisition_mode, 'isolated_during_developmental_reading');
});
