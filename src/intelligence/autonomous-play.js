'use strict';

const crypto = require('node:crypto');

const PROTOCOL_VERSION = 1;
const BOARD_SIZE = 4;
const MAX_GAME_MOVES = 64;
const QUIET_MINUTES = 15;
const CONDITIONS = Object.freeze(['autonomous_choice', 'assigned_play', 'quiet_control']);
const ACTIVITIES = Object.freeze(['merge_grid', 'quiet']);
const DIRECTIONS = Object.freeze(['up', 'right', 'down', 'left']);
const SHA256 = /^[a-f0-9]{64}$/;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function boundedText(value, field, max, { optional = false } = {}) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
  if (!optional && !normalized) throw new Error(`autonomous play requires ${field}`);
  return normalized || null;
}

function unit(seed, label) {
  const hex = commitment(`${seed}:${label}`).slice(0, 13);
  return Number.parseInt(hex, 16) / 0x10000000000000;
}

function emptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));
}

function normalizeBoard(board) {
  if (!Array.isArray(board) || board.length !== BOARD_SIZE
    || board.some(row => !Array.isArray(row) || row.length !== BOARD_SIZE
      || row.some(value => !Number.isInteger(value) || value < 0
        || value > 65536 || (value && (value & (value - 1)) !== 0)))) {
    throw new Error('merge grid requires a valid four by four power-of-two board');
  }
  return board.map(row => [...row]);
}

function spawn(board, seed, spawnIndex) {
  const next = normalizeBoard(board);
  const empty = [];
  next.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    if (!value) empty.push([rowIndex, columnIndex]);
  }));
  if (!empty.length) return { board: next, spawned: null };
  const position = empty[Math.floor(unit(seed, `position:${spawnIndex}`) * empty.length)];
  const value = unit(seed, `value:${spawnIndex}`) < 0.1 ? 4 : 2;
  next[position[0]][position[1]] = value;
  return { board: next, spawned: { row: position[0], column: position[1], value } };
}

function initialBoard(seed) {
  const first = spawn(emptyBoard(), seed, 0);
  return spawn(first.board, seed, 1).board;
}

function mergeLine(values) {
  const compact = values.filter(Boolean);
  const merged = [];
  let scoreDelta = 0;
  for (let index = 0; index < compact.length; index += 1) {
    if (compact[index] === compact[index + 1]) {
      const value = compact[index] * 2;
      merged.push(value); scoreDelta += value; index += 1;
    } else merged.push(compact[index]);
  }
  while (merged.length < BOARD_SIZE) merged.push(0);
  return { values: merged, score_delta: scoreDelta };
}

function projectLines(board, direction) {
  const vertical = direction === 'up' || direction === 'down';
  const reverse = direction === 'right' || direction === 'down';
  const lines = Array.from({ length: BOARD_SIZE }, (_, index) => Array.from({ length: BOARD_SIZE },
    (__, offset) => vertical ? board[offset][index] : board[index][offset]));
  return reverse ? lines.map(line => [...line].reverse()) : lines;
}

function restoreLines(lines, direction) {
  const vertical = direction === 'up' || direction === 'down';
  const reverse = direction === 'right' || direction === 'down';
  const oriented = reverse ? lines.map(line => [...line].reverse()) : lines;
  const board = emptyBoard();
  oriented.forEach((line, index) => line.forEach((value, offset) => {
    if (vertical) board[offset][index] = value;
    else board[index][offset] = value;
  }));
  return board;
}

function moveBoard(board, direction) {
  if (!DIRECTIONS.includes(direction)) throw new Error('merge grid direction is invalid');
  const prior = normalizeBoard(board);
  let scoreDelta = 0;
  const lines = projectLines(prior, direction).map(line => {
    const result = mergeLine(line); scoreDelta += result.score_delta; return result.values;
  });
  const moved = restoreLines(lines, direction);
  return { board: moved, score_delta: scoreDelta,
    changed: canonicalJson(prior) !== canonicalJson(moved) };
}

function availableMoves(board) {
  return DIRECTIONS.filter(direction => moveBoard(board, direction).changed);
}

function gameManifest(game) {
  return { kind: game.kind, initial_board_commitment: game.initial_board_commitment,
    seed_commitment: game.seed_commitment, maximum_moves: game.maximum_moves };
}

function createGame(seed) {
  const board = initialBoard(seed);
  const game = {
    kind: 'merge_grid', seed, seed_commitment: commitment(seed), board, score: 0,
    move_count: 0, spawn_count: 2, maximum_moves: MAX_GAME_MOVES, events: [],
    initial_board_commitment: commitment(board), game_manifest_commitment: null,
  };
  game.game_manifest_commitment = commitment(gameManifest(game));
  return game;
}

function applyMove(game, direction, at = new Date()) {
  if (!game || game.kind !== 'merge_grid' || game.move_count >= game.maximum_moves) {
    throw new Error('merge grid does not accept another move');
  }
  const priorBoardCommitment = commitment(game.board);
  const result = moveBoard(game.board, direction);
  let next = result.board; let spawned = null;
  if (result.changed) {
    const spawnedResult = spawn(next, game.seed, game.spawn_count);
    next = spawnedResult.board; spawned = spawnedResult.spawned; game.spawn_count += 1;
    game.score += result.score_delta;
  }
  const event = {
    index: game.events.length, direction, accepted: result.changed,
    score_delta: result.changed ? result.score_delta : 0, spawned,
    prior_board_commitment: priorBoardCommitment, board: next,
    board_commitment: commitment(next), recorded_at: new Date(at).toISOString(),
    event_commitment: null,
  };
  event.event_commitment = commitment({ ...event, event_commitment: null });
  game.board = next; game.move_count += 1; game.events.push(event);
  return event;
}

function normalizeModelControl(value = {}) {
  const result = { provider: String(value.provider || '').trim(), model: String(value.model || '').trim(),
    agent_build_commitment: String(value.agent_build_commitment || '').trim().toLowerCase() };
  if (!result.provider || !result.model || !SHA256.test(result.agent_build_commitment)) {
    throw new Error('autonomous play requires a committed provider, model, and build');
  }
  return result;
}

function normalizePreState(value = {}) {
  const metric = key => Math.max(0, Math.min(1, Number(value[key]) || 0));
  return { stimulation_deficit: metric('stimulation_deficit'), novelty_deficit: metric('novelty_deficit'),
    idle_minutes: Math.max(0, Math.min(1440, Math.round(Number(value.idle_minutes) || 0))),
    operational_load: metric('operational_load'), observed_at: new Date(value.observed_at).toISOString() };
}

function sessionManifest(session) {
  return {
    id: session.id, protocol_version: session.protocol_version, condition: session.condition,
    condition_assignment_commitment: session.condition_assignment_commitment,
    available_activities: session.available_activities, model_control: session.model_control,
    state_commitment: session.state_commitment, pre_state: session.pre_state,
    hidden_seed_commitment: session.hidden_seed_commitment, created_at: session.created_at,
    maximum_game_moves: session.maximum_game_moves, quiet_minutes: session.quiet_minutes,
  };
}

function assignedSelection(condition, at) {
  const activity = condition === 'quiet_control' ? 'quiet' : 'merge_grid';
  const selection = { activity, selected_by: 'preregistered_condition', rationale: null,
    predicted_satisfaction: null, predicted_engagement: null,
    selected_at: new Date(at).toISOString(), provider_receipt: null, selection_commitment: null };
  selection.selection_commitment = commitment({ ...selection, selection_commitment: null });
  return selection;
}

function createSession(input = {}, at = new Date()) {
  const condition = String(input.condition || '');
  if (!CONDITIONS.includes(condition)) throw new Error('autonomous play condition is invalid');
  const hiddenSeed = String(input.hidden_seed || '');
  if (hiddenSeed.length < 16) throw new Error('autonomous play requires a hidden randomization seed');
  const createdAt = new Date(at);
  const stateCommitment = String(input.state_commitment || '').toLowerCase();
  if (!SHA256.test(stateCommitment)) throw new Error('autonomous play requires committed pre-session state');
  const id = boundedText(input.id || `play-${Date.now().toString(36)}-${commitment(`${hiddenSeed}:${createdAt}`).slice(0, 8)}`,
    'session id', 180);
  const session = {
    id, protocol_version: PROTOCOL_VERSION, condition,
    condition_assignment_commitment: commitment({ condition, hidden_seed_commitment: commitment(hiddenSeed) }),
    available_activities: [...ACTIVITIES], model_control: normalizeModelControl(input.model_control),
    state_commitment: stateCommitment, pre_state: normalizePreState(input.pre_state),
    hidden_seed: hiddenSeed, hidden_seed_commitment: commitment(hiddenSeed),
    created_at: createdAt.toISOString(), started_at: null, completed_at: null,
    maximum_game_moves: MAX_GAME_MOVES, quiet_minutes: QUIET_MINUTES,
    status: condition === 'autonomous_choice' ? 'awaiting_selection'
      : condition === 'assigned_play' ? 'active' : 'incubating',
    selection: null, game: null, incubation_due_at: null, appraisal: null,
    functional_aftereffect: null, outcome_commitment: null, session_manifest_commitment: null,
  };
  if (condition !== 'autonomous_choice') {
    session.selection = assignedSelection(condition, createdAt);
    session.started_at = createdAt.toISOString();
    if (condition === 'assigned_play') session.game = createGame(hiddenSeed);
    else session.incubation_due_at = new Date(createdAt.getTime() + QUIET_MINUTES * 60000).toISOString();
  }
  session.session_manifest_commitment = commitment(sessionManifest(session));
  return session;
}

function providerReceipt(input, session, requestCommitment) {
  const receipt = {
    response_id: boundedText(input?.response_id, 'provider response id', 300),
    provider: boundedText(input?.provider, 'provider', 100),
    model: boundedText(input?.model, 'provider model', 200),
    agent_build_commitment: String(input?.agent_build_commitment || '').trim().toLowerCase(),
    request_commitment: String(input?.request_commitment || '').trim().toLowerCase(),
  };
  if (receipt.provider !== session.model_control.provider || receipt.model !== session.model_control.model
    || receipt.agent_build_commitment !== session.model_control.agent_build_commitment
    || receipt.request_commitment !== requestCommitment) {
    throw new Error('autonomous play provider receipt does not match the committed request');
  }
  return receipt;
}

function selectionRequest(session) {
  if (session?.status !== 'awaiting_selection') return null;
  const packet = { protocol_version: PROTOCOL_VERSION, session_id: session.id,
    condition: 'condition_blinded_autonomous_choice', pre_state: session.pre_state,
    activities: session.available_activities, output_schema: {
      activity: 'merge_grid or quiet', rationale: 'one bounded sentence',
      predicted_satisfaction: 'number from 0 to 1', predicted_engagement: 'number from 0 to 1',
    } };
  return { ...packet, request_commitment: commitment(packet) };
}

function boundedMetric(value, field) {
  const metric = Number(value);
  if (!Number.isFinite(metric) || metric < 0 || metric > 1) {
    throw new Error(`autonomous play ${field} must be between zero and one`);
  }
  return Number(metric.toFixed(3));
}

function commitSelection(session, input = {}, at = new Date()) {
  const request = selectionRequest(session);
  if (!request) throw new Error('autonomous play session is not awaiting a selection');
  const activity = String(input.output?.activity || '');
  if (!session.available_activities.includes(activity)) throw new Error('autonomous play selected an unavailable activity');
  const selection = {
    activity, selected_by: 'nora', rationale: boundedText(input.output?.rationale, 'selection rationale', 500),
    predicted_satisfaction: boundedMetric(input.output?.predicted_satisfaction, 'predicted satisfaction'),
    predicted_engagement: boundedMetric(input.output?.predicted_engagement, 'predicted engagement'),
    selected_at: new Date(at).toISOString(),
    provider_receipt: providerReceipt(input.provider_receipt, session, request.request_commitment),
    selection_commitment: null,
  };
  selection.selection_commitment = commitment({ ...selection, selection_commitment: null });
  session.selection = selection; session.started_at = selection.selected_at;
  if (activity === 'merge_grid') { session.game = createGame(session.hidden_seed); session.status = 'active'; }
  else {
    session.status = 'incubating';
    session.incubation_due_at = new Date(new Date(at).getTime() + session.quiet_minutes * 60000).toISOString();
  }
  return selection;
}

function turnRequest(session) {
  if (session?.status !== 'active' || !session.game) return null;
  const packet = {
    protocol_version: PROTOCOL_VERSION, session_id: session.id, game: session.game.kind,
    board: session.game.board, score: session.game.score, move_count: session.game.move_count,
    maximum_moves: session.game.maximum_moves, legal_directions: availableMoves(session.game.board),
    output_schema: { directions: 'one to eight values from up, right, down, left',
      continue_playing: 'boolean', intention: 'one short externally reportable strategy',
      predicted_score_gain: 'nonnegative integer' },
  };
  return { ...packet, request_commitment: commitment(packet) };
}

function commitTurn(session, input = {}, at = new Date()) {
  const request = turnRequest(session);
  if (!request) throw new Error('autonomous play session is not ready for a turn');
  const directions = Array.isArray(input.output?.directions) ? input.output.directions.map(String).slice(0, 8) : [];
  if (!directions.length || directions.some(direction => !DIRECTIONS.includes(direction))) {
    throw new Error('autonomous play turn requires one to eight valid directions');
  }
  const receipt = providerReceipt(input.provider_receipt, session, request.request_commitment);
  const events = [];
  for (const direction of directions) {
    if (session.game.move_count >= session.game.maximum_moves || !availableMoves(session.game.board).length) break;
    events.push(applyMove(session.game, direction, at));
  }
  const turn = {
    index: session.game.turns?.length || 0, directions, event_commitments: events.map(event => event.event_commitment),
    continue_playing: input.output?.continue_playing !== false,
    intention: boundedText(input.output?.intention, 'turn intention', 400),
    predicted_score_gain: Math.max(0, Math.min(100000, Math.round(Number(input.output?.predicted_score_gain) || 0))),
    provider_receipt: receipt, recorded_at: new Date(at).toISOString(), turn_commitment: null,
  };
  turn.turn_commitment = commitment({ ...turn, turn_commitment: null });
  session.game.turns = session.game.turns || []; session.game.turns.push(turn);
  if (!turn.continue_playing || session.game.move_count >= session.game.maximum_moves
    || !availableMoves(session.game.board).length) session.status = 'awaiting_appraisal';
  return turn;
}

function appraisalRequest(session, at = new Date()) {
  const quietDue = session?.status === 'incubating'
    && new Date(at).getTime() >= new Date(session.incubation_due_at).getTime();
  if (session?.status !== 'awaiting_appraisal' && !quietDue) return null;
  const activity = session.selection?.activity;
  const packet = {
    protocol_version: PROTOCOL_VERSION, session_id: session.id, activity,
    pre_state: session.pre_state,
    outcome: activity === 'merge_grid' ? { score: session.game.score,
      moves: session.game.move_count, maximum_tile: Math.max(...session.game.board.flat()),
      accepted_moves: session.game.events.filter(event => event.accepted).length }
      : { quiet_minutes: session.quiet_minutes },
    output_schema: { engagement: 'number from 0 to 1', satisfaction: 'number from 0 to 1',
      frustration: 'number from 0 to 1', surprise: 'number from 0 to 1',
      competence: 'number from 0 to 1', play_again: 'boolean', reflection: 'one bounded sentence',
      possible_insight: 'nullable bounded sentence', work_transfer_hypothesis: 'nullable falsifiable sentence' },
  };
  return { ...packet, request_commitment: commitment(packet) };
}

function commitAppraisal(session, input = {}, at = new Date(), { priorMedianScore = 0 } = {}) {
  const request = appraisalRequest(session, at);
  if (!request) throw new Error('autonomous play session is not ready for appraisal');
  const output = input.output || {};
  const appraisal = {
    engagement: boundedMetric(output.engagement, 'engagement'),
    satisfaction: boundedMetric(output.satisfaction, 'satisfaction'),
    frustration: boundedMetric(output.frustration, 'frustration'),
    surprise: boundedMetric(output.surprise, 'surprise'), competence: boundedMetric(output.competence, 'competence'),
    play_again: output.play_again === true,
    reflection: boundedText(output.reflection, 'appraisal reflection', 700),
    possible_insight: boundedText(output.possible_insight, 'possible insight', 700, { optional: true }),
    work_transfer_hypothesis: boundedText(output.work_transfer_hypothesis,
      'work transfer hypothesis', 700, { optional: true }),
    provider_receipt: providerReceipt(input.provider_receipt, session, request.request_commitment),
    recorded_at: new Date(at).toISOString(), appraisal_commitment: null,
  };
  appraisal.appraisal_commitment = commitment({ ...appraisal, appraisal_commitment: null });
  const score = session.game?.score || 0;
  const denominator = Math.max(128, Number(priorMedianScore) || 0);
  const learningProgress = session.selection.activity === 'merge_grid'
    ? Math.max(-1, Math.min(1, (score - (Number(priorMedianScore) || 0)) / denominator)) : 0;
  const autonomy = session.condition === 'autonomous_choice' ? 1 : 0;
  session.appraisal = appraisal;
  session.functional_aftereffect = {
    protocol_version: PROTOCOL_VERSION,
    satisfaction_signal: Number((0.45 * appraisal.satisfaction + 0.2 * appraisal.engagement
      + 0.2 * Math.max(0, learningProgress) + 0.15 * autonomy).toFixed(3)),
    activation_delta: Number(((appraisal.engagement - 0.5) * 0.2).toFixed(3)),
    valence_delta: Number(((appraisal.satisfaction - appraisal.frustration) * 0.2).toFixed(3)),
    learning_progress: Number(learningProgress.toFixed(3)),
    influence_enabled: false,
    epistemic_status: 'A preregistered functional appraisal derived from behavior and a bounded self-report. It is not proof of subjective satisfaction, a mood fact, or consciousness.',
  };
  session.status = 'completed'; session.completed_at = appraisal.recorded_at;
  session.outcome_commitment = commitment(outcomeManifest(session));
  return appraisal;
}

function outcomeManifest(session) {
  return { session_id: session.id, condition: session.condition,
    selection_commitment: session.selection.selection_commitment,
    game_final_commitment: session.game ? commitment({ board: session.game.board, score: session.game.score,
      event_commitments: session.game.events.map(event => event.event_commitment) }) : null,
    appraisal_commitment: session.appraisal.appraisal_commitment,
    functional_aftereffect: session.functional_aftereffect, completed_at: session.completed_at };
}

function auditGame(game, hiddenSeed) {
  if (!game) return { manifest_verified: true, replay_verified: true };
  const manifestVerified = game.seed === hiddenSeed && game.seed_commitment === commitment(hiddenSeed)
    && game.game_manifest_commitment === commitment(gameManifest(game));
  const replay = createGame(hiddenSeed);
  let replayVerified = manifestVerified;
  for (const recorded of game.events || []) {
    if (!replayVerified) break;
    const observed = applyMove(replay, recorded.direction, recorded.recorded_at);
    replayVerified = observed.event_commitment === recorded.event_commitment;
  }
  replayVerified = replayVerified && commitment(replay.board) === commitment(game.board)
    && replay.score === game.score && replay.move_count === game.move_count;
  return { manifest_verified: manifestVerified, replay_verified: replayVerified };
}

function auditSession(session) {
  const manifestVerified = Boolean(session?.protocol_version === PROTOCOL_VERSION
    && session.session_manifest_commitment === commitment(sessionManifest(session))
    && session.hidden_seed_commitment === commitment(session.hidden_seed));
  const selectionVerified = !session.selection || session.selection.selection_commitment
    === commitment({ ...session.selection, selection_commitment: null });
  const game = auditGame(session.game, session.hidden_seed);
  const turns = session.game?.turns || [];
  const flattenedTurnEvents = turns.flatMap(turn => turn.event_commitments || []);
  const turnsVerified = turns.every((turn, index) => turn.index === index
      && turn.turn_commitment === commitment({ ...turn, turn_commitment: null }))
    && canonicalJson(flattenedTurnEvents) === canonicalJson(
      (session.game?.events || []).map(event => event.event_commitment));
  const receipts = [session.selection?.provider_receipt,
    ...turns.map(turn => turn.provider_receipt), session.appraisal?.provider_receipt].filter(Boolean);
  const providerReceiptsVerified = receipts.every(receipt => receipt.provider === session.model_control.provider
      && receipt.model === session.model_control.model
      && receipt.agent_build_commitment === session.model_control.agent_build_commitment
      && SHA256.test(receipt.request_commitment) && receipt.response_id)
    && new Set(receipts.map(receipt => receipt.response_id)).size === receipts.length;
  const appraisalVerified = !session.appraisal || session.appraisal.appraisal_commitment
    === commitment({ ...session.appraisal, appraisal_commitment: null });
  const completionVerified = session.status !== 'completed' || Boolean(session.outcome_commitment
    && session.completed_at && session.appraisal && session.functional_aftereffect
    && session.outcome_commitment === commitment(outcomeManifest(session)));
  return { manifest_verified: manifestVerified, selection_verified: selectionVerified,
    game_manifest_verified: game.manifest_verified, game_replay_verified: game.replay_verified,
    turns_verified: turnsVerified, provider_receipts_verified: providerReceiptsVerified,
    appraisal_verified: appraisalVerified, completion_verified: completionVerified,
    complete_chain_verified: manifestVerified && selectionVerified && game.manifest_verified
      && game.replay_verified && turnsVerified && providerReceiptsVerified
      && appraisalVerified && completionVerified };
}

function publicSession(session) {
  const conditionRevealed = ['completed', 'excluded'].includes(session.status);
  const game = session.game ? {
    kind: session.game.kind, board: session.game.board, score: session.game.score,
    move_count: session.game.move_count, maximum_moves: session.game.maximum_moves,
    maximum_tile: Math.max(...session.game.board.flat()),
    accepted_moves: session.game.events.filter(event => event.accepted).length,
    recent_moves: session.game.events.slice(-12).map(event => ({ index: event.index,
      direction: event.direction, accepted: event.accepted, score_delta: event.score_delta,
      spawned: event.spawned, recorded_at: event.recorded_at })),
  } : null;
  return {
    id: session.id, protocol_version: session.protocol_version,
    condition: conditionRevealed ? session.condition : 'sealed_until_completion',
    status: session.status, created_at: session.created_at, started_at: session.started_at,
    completed_at: session.completed_at, pre_state: session.pre_state,
    selection: session.selection ? { activity: session.selection.activity,
      selected_by: conditionRevealed ? session.selection.selected_by : 'sealed_until_completion',
      rationale: conditionRevealed ? session.selection.rationale : null,
      predicted_satisfaction: conditionRevealed ? session.selection.predicted_satisfaction : null,
      predicted_engagement: conditionRevealed ? session.selection.predicted_engagement : null,
      selected_at: session.selection.selected_at } : null,
    game, appraisal: session.appraisal ? { engagement: session.appraisal.engagement,
      satisfaction: session.appraisal.satisfaction, frustration: session.appraisal.frustration,
      surprise: session.appraisal.surprise, competence: session.appraisal.competence,
      play_again: session.appraisal.play_again, reflection: session.appraisal.reflection,
      possible_insight: session.appraisal.possible_insight,
      work_transfer_hypothesis: session.appraisal.work_transfer_hypothesis } : null,
    functional_aftereffect: session.functional_aftereffect,
    outcome_commitment: session.outcome_commitment, audit: auditSession(session),
  };
}

function balancedCondition(sessions = [], seed) {
  const counts = Object.fromEntries(CONDITIONS.map(condition => [condition,
    sessions.filter(session => session.condition === condition).length]));
  const minimum = Math.min(...Object.values(counts));
  const candidates = CONDITIONS.filter(condition => counts[condition] === minimum);
  return candidates[Math.floor(unit(seed, 'balanced-condition') * candidates.length)];
}

function snapshot(sessions = [], automation = null) {
  const valid = sessions.filter(session => auditSession(session).complete_chain_verified);
  const completed = valid.filter(session => session.status === 'completed');
  const byCondition = Object.fromEntries(CONDITIONS.map(condition => [condition,
    completed.filter(session => session.condition === condition).length]));
  const gameSessions = completed.filter(session => session.selection?.activity === 'merge_grid');
  const autonomous = completed.filter(session => session.condition === 'autonomous_choice');
  const mean = (items, accessor) => items.length
    ? Number((items.reduce((sum, item) => sum + accessor(item), 0) / items.length).toFixed(3)) : null;
  return {
    epistemic_status: 'A replay-audited causal pilot of Nora choosing, playing, learning from, and appraising bounded leisure. Functional satisfaction and preference are observable model behavior, not proof of felt experience or consciousness.',
    protocol: { version: PROTOCOL_VERSION, conditions: [...CONDITIONS], activities: [...ACTIVITIES],
      game: 'deterministic merge grid', maximum_game_moves: MAX_GAME_MOVES,
      quiet_minutes: QUIET_MINUTES, prompts_and_conditions_sealed_during_sessions: true },
    report: { sessions: valid.length, active: valid.filter(session => !['completed', 'excluded'].includes(session.status)).length,
      completed: completed.length, invalid: sessions.length - valid.length, completed_by_condition: byCondition,
      autonomous_play_choice_rate: autonomous.length
        ? Number((autonomous.filter(session => session.selection?.activity === 'merge_grid').length / autonomous.length).toFixed(3)) : null,
      mean_satisfaction: mean(completed, session => session.appraisal.satisfaction),
      mean_engagement: mean(completed, session => session.appraisal.engagement),
      game_score_mean: mean(gameSessions, session => session.game.score),
      game_high_score: gameSessions.length ? Math.max(...gameSessions.map(session => session.game.score)) : null,
      candidate_insights: completed.filter(session => session.appraisal.possible_insight).length },
    causal_gate: { influence_enabled: false, status: 'pilot_collecting',
      minimum_completed_per_condition: 12,
      ready_for_blinded_analysis: CONDITIONS.every(condition => byCondition[condition] >= 12),
      next_gate: 'Complete at least twelve replay-valid sessions per condition, preregister blinded downstream measures, and compare against quiet control before allowing play to alter durable personality or work policy.' },
    automation,
    current: valid.find(session => !['completed', 'excluded'].includes(session.status))
      ? publicSession(valid.find(session => !['completed', 'excluded'].includes(session.status))) : null,
    recent: valid.slice(-12).reverse().map(publicSession),
    skill_trajectory: gameSessions.slice(-20).map(session => ({ session_id: session.id,
      completed_at: session.completed_at, condition: session.condition, score: session.game.score,
      maximum_tile: Math.max(...session.game.board.flat()),
      learning_progress: session.functional_aftereffect.learning_progress })),
  };
}

module.exports = {
  PROTOCOL_VERSION, BOARD_SIZE, MAX_GAME_MOVES, QUIET_MINUTES, CONDITIONS, ACTIVITIES, DIRECTIONS,
  canonicalJson, commitment, emptyBoard, normalizeBoard, spawn, initialBoard, mergeLine,
  moveBoard, availableMoves, createGame, applyMove, createSession, selectionRequest,
  commitSelection, turnRequest, commitTurn, appraisalRequest, commitAppraisal,
  outcomeManifest, auditGame, auditSession, publicSession, balancedCondition, snapshot,
};
