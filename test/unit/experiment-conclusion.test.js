const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createIntelligenceStore } = require('../../src/intelligence/store');

async function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-experiment-'));
  const store = createIntelligenceStore({
    filePath: path.join(dir, 'state.json'), db: {}, isDbReady: () => false,
  });
  await store.init();
  return { store, dir };
}

function activeExperiment(store, overrides = {}) {
  return store.createExperiment({
    behavior: 'Lead with the recommendation before the detail',
    hypothesis: 'John acts on the first message more often',
    metric: 'positive_rate', target: 0.65, minimum_samples: 5,
    review_at: new Date(Date.now() - 86400000).toISOString(),
    ...overrides,
  });
}

function sample(store, id, value, times = 1) {
  for (let i = 0; i < times; i += 1) {
    store.recordExperimentSample({ experiment_id: id, outcome: 'positive', value });
  }
}

// The failure this replaces: evaluateExperiment defaulted conclude to false, that parameter was
// documented nowhere Nora could reach, and the due filter is status-based. So evaluating a decisive
// result recomputed the numbers, left the experiment active, and it resurfaced every hour forever.
// Fourteen experiments existed in production and not one had ever been concluded.
test('a decisive experiment can be closed and leaves the due queue', async () => {
  const { store } = await freshStore();
  const experiment = activeExperiment(store);
  sample(store, experiment.id, 0.71, 95);

  // Evaluating alone is explicitly NOT terminal, which is the distinction that was missing.
  store.evaluateExperiment(experiment.id, {});
  assert.equal(store.list('experiments')[0].status, 'active');
  assert.equal(store.orient().experiments.due.length, 1,
    'evaluating recomputes the numbers and must not clear the review point on its own');

  const { experiment: closed } = store.concludeExperiment(experiment.id,
    { disposition: 'retain', notes: '0.71 against a 0.65 target over 95 samples' });
  assert.equal(closed.status, 'retained');
  assert.equal(closed.disposition, 'retain');
  assert.ok(closed.concluded_at);
  assert.equal(store.orient().experiments.due.length, 0,
    'a concluded experiment must stop surfacing as due');
});

// The property that matters more than any single disposition: there must be no state an experiment
// can reach where no decision is recordable. That is the trap being removed, and gating retire or
// revise behind an evidence bar would rebuild it one level up.
test('every active experiment can always reach a terminal state', async () => {
  for (const disposition of ['retire', 'revise']) {
    const { store } = await freshStore();
    const experiment = activeExperiment(store);
    // Zero samples: far below the minimum, the worst case for getting stuck.
    const result = store.concludeExperiment(experiment.id, {
      disposition,
      notes: 'stop condition hit early',
      successor: { behavior: 'Try the shorter framing instead', hypothesis: 'Fewer follow-up questions' },
    });
    assert.equal(result.experiment.status, disposition === 'retire' ? 'retired' : 'revised',
      `${disposition} must work with no evidence at all`);
    // Zero either way: retiring closes it outright, and a revision's successor carries a fresh
    // future review point rather than inheriting the one that already passed.
    assert.equal(store.orient().experiments.due.length, 0,
      'closing the original must clear the original review point');
  }
});

// Retain is the one claim the samples have to carry.
test('retain requires evidence, and says what to do instead', async () => {
  const { store } = await freshStore();
  const experiment = activeExperiment(store);
  sample(store, experiment.id, 0.9, 2);
  assert.throws(() => store.concludeExperiment(experiment.id,
    { disposition: 'retain', notes: 'looks good' }),
  /at least 5 outcome samples.*has 2.*Retire or revise/s);
  // And the experiment is untouched, so the decision is still open rather than half-applied.
  assert.equal(store.list('experiments')[0].status, 'active');
});

// A revision keeps the evidence trail instead of becoming an untraceable delete-and-recreate.
test('revising links the closed experiment to its successor in both directions', async () => {
  const { store } = await freshStore();
  const original = activeExperiment(store, { origin: 'nora', chosen_by: 'Nora', scope: 'communication_behavior' });
  sample(store, original.id, 0.4, 10);

  const { experiment: closed, successor } = store.concludeExperiment(original.id, {
    disposition: 'revise',
    notes: 'the behavior helped but the phrasing was too blunt',
    successor: { behavior: 'Lead with the recommendation, then one line of why',
      hypothesis: 'Same speed to action without the terseness complaints' },
  });

  assert.equal(closed.status, 'revised');
  assert.equal(closed.revised_to, successor.id);
  assert.equal(successor.revised_from, original.id);
  assert.equal(successor.status, 'active');
  assert.notEqual(successor.id, original.id);
  // Carried forward so a revision is a continuation, not a fresh unrelated trial.
  assert.equal(successor.origin, 'nora');
  assert.equal(successor.metric, original.metric);
  assert.equal(successor.target, original.target);
  assert.ok(successor.review_at, 'a successor needs its own review point or it can never be judged');
  assert.ok(new Date(successor.review_at).getTime() > Date.now(),
    'the successor review point must be in the future, not inherited from the closed experiment');
});

// Revising a self-chosen experiment must not become a way around the two-active cap.
test('revising a self-chosen experiment does not widen her agency budget', async () => {
  const { store } = await freshStore();
  const first = activeExperiment(store, { origin: 'nora' });
  activeExperiment(store, { origin: 'nora' });
  const before = store.orient().self_experiments;
  assert.equal(before.active.length, 2);
  assert.equal(before.capacity, 0);

  store.concludeExperiment(first.id, {
    disposition: 'revise', notes: 'reformulating',
    successor: { behavior: 'A narrower version', hypothesis: 'Same outcome, less risk' },
  });
  const after = store.orient().self_experiments;
  assert.equal(after.active.length, 2, 'the original closes as the successor opens');
  assert.equal(after.capacity, 0);
});

test('a conclusion requires a disposition and a reason', async () => {
  const { store } = await freshStore();
  const experiment = activeExperiment(store);
  sample(store, experiment.id, 0.8, 10);
  assert.throws(() => store.concludeExperiment(experiment.id, { notes: 'x' }),
    /disposition must be one of retain, revise, retire/);
  assert.throws(() => store.concludeExperiment(experiment.id, { disposition: 'maybe', notes: 'x' }),
    /disposition must be one of/);
  // An unexplained conclusion is how unfalsifiable rules accumulate, the thing experiments prevent.
  assert.throws(() => store.concludeExperiment(experiment.id, { disposition: 'retain' }),
    /requires a note/);
  assert.throws(() => store.concludeExperiment(experiment.id, { disposition: 'retain', notes: '   ' }),
    /requires a note/);
  assert.throws(() => store.concludeExperiment(experiment.id, { disposition: 'revise', notes: 'x' }),
    /successor behavior and hypothesis/);
});

test('an experiment cannot be concluded twice', async () => {
  const { store } = await freshStore();
  const experiment = activeExperiment(store);
  store.concludeExperiment(experiment.id, { disposition: 'retire', notes: 'not worth continuing' });
  assert.throws(() => store.concludeExperiment(experiment.id,
    { disposition: 'retire', notes: 'again' }), /already retired/);
  assert.equal(store.concludeExperiment('experiment-does-not-exist',
    { disposition: 'retire', notes: 'x' }), null);
});

// A capability she cannot see does not exist. That was the entire bug, so the instructions naming
// it are part of the fix rather than a nicety.
test('the conclude endpoint is documented everywhere Nora is told to make the decision', () => {
  const root = path.join(__dirname, '..', '..');
  const cowork = fs.readFileSync(path.join(root, 'src', 'routes', 'cowork-instructions.js'), 'utf8');
  const routine = fs.readFileSync(path.join(root, 'nora-routine.md'), 'utf8');
  const store = fs.readFileSync(path.join(root, 'src', 'intelligence', 'store.js'), 'utf8');
  for (const [name, source] of [['cowork instructions', cowork], ['routine', routine]]) {
    assert.match(source, /learning-experiments\/<id>\/conclude/,
      `${name} must name the endpoint that ends an experiment`);
    assert.match(source, /"disposition"/, `${name} must name the parameter`);
  }
  // The hourly recommendation told her to retain, revise, or retire without saying how.
  assert.match(store, /action: 'POST \/learning-experiments\/<id>\/conclude with disposition/,
    'the due-work recommendation must name the mechanism, not just the goal');
});
