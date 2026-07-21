'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parameters = require('../../src/intelligence/cognitive-parameters');
const { computeAppraisal, computeDrives, scoreWorkspace } = require('../../src/intelligence/cognition');

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function blend(previous, target, responsiveness = 0.35) {
  return clamp01((Number(previous) || 0) * (1 - responsiveness) + clamp01(target) * responsiveness);
}

function legacyDrives(state, input, now) {
  const previous = state.cognition?.drives || {};
  const open = state.commitments.filter(item => item.status === 'open');
  const overdue = open.filter(item => item.due && new Date(item.due).getTime() < now.getTime());
  const loops = state.episodes.flatMap(item => item.open_loops || []).filter(item => item.status === 'open');
  const unresolved = (input.predictions || []).filter(item => !item.outcome);
  const negative = state.traces.slice(-40).filter(item => ['negative', 'corrected', 'ignored', 'interrupted'].includes(item.outcome)).length;
  const staleCycle = state.cycles.some(item => item.status === 'running'
    && Math.max(0, (now.getTime() - new Date(item.started).getTime()) / 86400000) > 0.15);
  const activeExperiments = state.experiments.filter(item => item.status === 'active').length;
  const targets = {
    uncertainty: clamp01((unresolved.length + Number(input.disputed_memories || 0) * 2) / 12),
    unfinished: clamp01((overdue.length * 2 + loops.length + open.length * 0.35) / 10),
    social_debt: clamp01((negative + Number(input.unanswered_people || 0)) / 8),
    overload: clamp01((open.length + loops.length + (staleCycle ? 5 : 0) + Number(input.soma?.stress || 0) * 5) / 18),
    curiosity: clamp01((unresolved.length + (2 - Math.min(2, activeExperiments)) * 2) / 12),
    continuity: clamp01((loops.length + state.episodes.filter(item => item.status === 'open').length
      + (staleCycle ? 3 : 0)) / 12),
  };
  return Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, {
    level: blend(previous[name]?.level, target), target, updated: now.toISOString(),
  }]));
}

function legacyAppraisal(state, drives, input, now) {
  const previous = state.cognition?.appraisal || {};
  const traces = state.traces.slice(-40);
  const positive = traces.filter(item => ['positive', 'helpful', 'accepted', 'fulfilled'].includes(item.outcome)).length;
  const negative = traces.filter(item => ['negative', 'corrected', 'ignored', 'interrupted'].includes(item.outcome)).length;
  const surprises = (state.cognition?.surprises || []).filter(item =>
    Math.max(0, (now.getTime() - new Date(item.at).getTime()) / 86400000) < 7);
  const resolved = (input.predictions || []).filter(item => item.outcome === 'right' || item.outcome === 'wrong');
  const accuracy = resolved.length ? resolved.filter(item => item.outcome === 'right').length / resolved.length : 0.6;
  const raw = {
    valence: clamp01(0.5 + (positive - negative) / Math.max(8, traces.length)),
    arousal: clamp01(0.2 + drives.unfinished.level * 0.35 + drives.overload.level * 0.25
      + Math.min(0.3, surprises.length * 0.08)),
    control: clamp01(0.85 - drives.overload.level * 0.45 - drives.uncertainty.level * 0.2),
    social_safety: clamp01(0.75 + positive * 0.025 - negative * 0.07),
    coherence: clamp01(0.35 + accuracy * 0.55 - Math.min(0.25, surprises.length * 0.04)),
  };
  const result = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, blend(previous[key], value, 0.3)]));
  result.updated = now.toISOString();
  result.basis = { positive_outcomes: positive, negative_outcomes: negative,
    recent_surprises: surprises.length, prediction_accuracy: accuracy,
    verified_active_aims: 0, progressing_aims: 0, stalled_aims: 0,
    goal_affect_commitment: null };
  result.label = result.arousal > 0.68 && result.valence < 0.45 ? 'strained and alert'
    : result.valence > 0.62 && result.control > 0.55 ? 'engaged and capable'
      : result.coherence < 0.45 ? 'uncertain and reflective'
        : result.arousal < 0.32 ? 'quietly attentive' : 'attentive and measured';
  return result;
}

function fixture() {
  return {
    commitments: [
      { id: 'late', what: 'Send launch plan', project: 'Launch', owner: 'Nora', status: 'open', due: '2026-07-16T12:00:00Z' },
      { id: 'later', what: 'Review budget', project: 'Finance', owner: 'John', status: 'open', due: '2026-07-20T12:00:00Z' },
    ],
    episodes: [{ id: 'episode-1', status: 'open', open_loops: [{ status: 'open' }] }],
    experiments: [{ id: 'experiment-1', status: 'active', behavior: 'Verify before claiming' }],
    relationships: [{ id: 'john', name: 'John', observations: [{ status: 'active', observation: 'Prefers specifics' }] }],
    traces: [{ outcome: 'positive' }, { outcome: 'helpful' }, { outcome: 'corrected' }],
    cycles: [{ id: 'cycle-1', status: 'running', started: '2026-07-17T06:00:00Z' }],
    cognition: {
      drives: { unfinished: { level: 0.6 }, overload: { level: 0.2 } },
      appraisal: { valence: 0.4, arousal: 0.3, control: 0.8, social_safety: 0.7, coherence: 0.6 },
      surprises: [{ id: 'surprise-1', expectation: 'The launch was ready', magnitude: 0.8, at: '2026-07-17T10:00:00Z' }],
      mind_changes: [{ id: 'mind-1', status: 'open', prior_belief: 'The plan was complete' }],
      development: [{ id: 'development-1', status: 'integrated', identity_significance: 0.8, changed_to: 'Verify completion evidence' }],
      recurrent_signals: [{ id: 'feedback-1', status: 'active', signal: 'Specificity matters' }],
      attention_schema: { directives: [] }, background_inference: { pulses: [] },
      prospection: { simulations: [] }, integrated_self: { frames: [] },
      epistemic_ledger: { propositions: [], discrepancies: [] },
    },
  };
}

test('DIALS defaults are immutable, bounded, and byte-stable', () => {
  assert.equal(Object.keys(parameters.DEFINITIONS).length, 113);
  assert.equal(Object.isFrozen(parameters.DEFAULTS), true);
  assert.equal(Object.isFrozen(parameters.DEFAULTS.workspace), true);
  assert.equal(parameters.DEFAULTS.workspace.capacity, 7);
  assert.throws(() => parameters.mergePatch(parameters.DEFAULTS, { workspace: { unknown: 1 } }), /unknown/);
  assert.throws(() => parameters.createRevision(parameters.defaultRecord(),
    { workspace: { capacity: 99 } }, { updatedBy: 'John', note: 'test' }), /between 3 and 10/);
});

test('DIALS ledger is replay-verifiable, append-only, and fails closed on corruption', () => {
  const genesis = parameters.defaultRecord();
  const first = parameters.createRevision(genesis, { workspace: { capacity: 6 } }, {
    updatedBy: 'John', note: 'Bounded test adjustment', now: new Date('2026-07-17T12:00:00Z'),
  });
  const ledger = parameters.createLedger(first.record, [genesis]);
  assert.equal(parameters.auditLedger(ledger).valid, true);
  assert.deepEqual(first.changed_paths, ['workspace.capacity']);
  assert.equal(first.record.previous_commitment, genesis.content_commitment);
  assert.throws(() => parameters.createRevision(first.record, { workspace: { capacity: 5 } }, {
    updatedBy: 'Nora', note: 'Self tune',
  }), /autonomous cognitive parameter tuning is disabled/);
  const rollback = parameters.createRevision(first.record, genesis.params, {
    updatedBy: 'John', note: 'Rollback', now: new Date('2026-07-17T13:00:00Z'),
  });
  assert.equal(rollback.record.revision, 3);
  assert.equal(rollback.record.params.workspace.capacity, 7);
  const tampered = structuredClone(ledger);
  tampered.current.params.workspace.capacity = 10;
  assert.equal(parameters.auditLedger(tampered).valid, false);
});

test('DIALS schema adoption repairs only transport-verified stale ledgers', () => {
  const staleRecord = structuredClone(parameters.defaultRecord());
  staleRecord.bounds_commitment = 'legacy-bounds';
  delete staleRecord.params.memory.retrieval.emotional_weight;
  delete staleRecord.params.memory.retrieval.social_weight;
  staleRecord.content_commitment = parameters.commitment(parameters.manifest(staleRecord));
  const staleLedger = {
    protocol_version: parameters.PROTOCOL_VERSION,
    history: [],
    current: staleRecord,
  };
  staleLedger.ledger_commitment = parameters.commitment({
    protocol_version: staleLedger.protocol_version,
    history_commitments: [],
    current_commitment: staleRecord.content_commitment,
  });

  assert.equal(parameters.auditLedger(staleLedger).valid, false);
  assert.equal(parameters.auditTransportLedger(staleLedger).valid, true);
  const adopted = parameters.createSchemaAdoptionLedger(staleLedger, {
    updatedBy: 'test_migration',
    note: 'Adopt stale schema in test',
    now: new Date('2026-07-21T00:00:00.000Z'),
  });
  assert.equal(adopted.repaired, true);
  assert.equal(parameters.auditLedger(adopted.ledger).valid, true);
  assert.equal(adopted.ledger.current.previous_commitment, staleRecord.content_commitment);
  assert.equal(adopted.ledger.current.params.memory.retrieval.emotional_weight, 0.08);
  assert.equal(adopted.adoption.added_default_paths.includes('memory.retrieval.emotional_weight'), true);

  const tampered = structuredClone(staleLedger);
  tampered.current.params.workspace.capacity = 9;
  const refused = parameters.createSchemaAdoptionLedger(tampered);
  assert.equal(refused.repaired, false);
  assert.equal(refused.transport_audit.valid, false);
});

test('pre-DIALS drive and appraisal behavior is exactly preserved by defaults', () => {
  const now = new Date('2026-07-17T12:00:00Z');
  const state = fixture();
  const input = { predictions: [{}, { outcome: 'right' }, { outcome: 'wrong' }],
    disputed_memories: 1, unanswered_people: 2, soma: { stress: 0.4 } };
  const expectedDrives = legacyDrives(state, input, now);
  assert.deepEqual(computeDrives(state, input, now), expectedDrives);
  assert.deepEqual(computeAppraisal(state, expectedDrives, input, now),
    legacyAppraisal(state, expectedDrives, input, now));
});

test('pre-DIALS workspace ranking is preserved and a custom dial changes only its target', () => {
  const now = new Date('2026-07-17T12:00:00Z');
  const state = fixture();
  const baseline = scoreWorkspace(state, { person: 'John', query: 'launch plan', includeCandidateManifest: true }, now);
  assert.deepEqual(baseline.candidate_manifest.map(item => [item.type, item.id, item.score]), [
    ['commitment', 'late', 16], ['feedback', 'feedback-1', 13], ['relationship', 'john', 11],
    ['surprise', 'surprise-1', 13], ['mind_change', 'mind-1', 8],
    ['development', 'development-1', 7.4], ['commitment', 'later', 5],
    ['experiment', 'experiment-1', 4], ['drive', 'unfinished', 8.4],
  ].sort((a, b) => b[2] - a[2] || `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`)));
  assert.equal(baseline.capacity, 7);

  const custom = structuredClone(parameters.DEFAULTS);
  custom.workspace.commitment.overdue_base = 5;
  const changed = scoreWorkspace(state, { person: 'John', query: 'launch plan', includeCandidateManifest: true }, now, custom);
  const before = Object.fromEntries(baseline.candidate_manifest.map(item => [`${item.type}:${item.id}`, item.score]));
  const after = Object.fromEntries(changed.candidate_manifest.map(item => [`${item.type}:${item.id}`, item.score]));
  assert.equal(after['commitment:late'], 9);
  delete before['commitment:late'];
  delete after['commitment:late'];
  assert.deepEqual(after, before);
});
