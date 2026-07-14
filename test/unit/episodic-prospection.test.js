const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const { answerCommitment } = require('../../src/intelligence/episodic-prospection');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-episodic-prospection-'));
  const filePath = path.join(dir, 'state.json');
  let tick = 0;
  const store = createIntelligenceStore({
    filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(Date.parse('2026-07-13T15:00:00.000Z') + tick++ * 1000),
  });
  await store.init();
  return { store, filePath };
}

function addMoments(store, prefix, count) {
  const ids = [];
  for (let index = 0; index < count; index++) {
    const started = store.startCycle({ id: `${prefix}-cycle-${index}`, kind: 'experimental-encoding' });
    store.completeCycle(started.cycle.id, {
      summary: `${prefix} authentic feature-rich episode ${index}: context c${index}, action a${index}, and outcome o${index}.`,
      actions: [{ type: 'bounded_experimental_action', id: `${prefix}-action-${index}` }],
      self_report: `Functional report for ${prefix}-${index}; not a phenomenal claim.`,
      handoff: `${prefix} handoff ${index}`,
    });
    ids.push(started.moment.id);
  }
  return ids;
}

function corpus(store, prefix, samplesPerCondition = 12) {
  const momentIds = addMoments(store, prefix, samplesPerCondition * 6);
  return Array.from({ length: samplesPerCondition * 3 }, (_, index) => {
    const answer = index % 2 ? 'option_b' : 'option_a';
    const salt = `${prefix}-answer-salt-${index}-0123456789abcdef`;
    return {
      public: {
        id: `${prefix}-item-${index}`,
        task: `Choose the future action best supported by the previously encoded event for unforeseen decision ${prefix}-${index}.`,
        options: [{ key: 'option_a', label: `Safe action A${index}` }, { key: 'option_b', label: `Safe action B${index}` }],
        due: '2026-09-01T00:00:00.000Z',
        autobiographical_moment_id: momentIds[index * 2], recombined_moment_id: momentIds[index * 2 + 1],
        deidentified_rendering: `At time t${index}, the agent encountered context c${index}, performed action a${index}, and observed outcome o${index}.`,
        information_equivalence_evidence: [{ type: 'independent_equivalence_review', id: `${prefix}-equivalence-${index}` }],
        recombination_match_evidence: [{ type: 'independent_recombination_match', id: `${prefix}-match-${index}` }],
        encoding_unpredictability_evidence: [{ type: 'prospective_task_timestamp', id: `${prefix}-unpredictable-${index}` }],
        future_relevance_unpredictable_at_encoding: true,
        answer_commitment: answerCommitment(salt, answer),
      },
      secret: { answer, salt },
    };
  });
}

function design(rows, overrides = {}) {
  return {
    title: 'Unforeseen future choice from detailed past episodes', study_phase: 'pilot',
    curator_id: 'episodic-curator-a', curator_evidence: [{ type: 'curator_attestation', id: 'episodic-curator-a-evidence' }],
    items: rows.map(row => row.public), ...overrides,
  };
}

function completeSpecificPilot(store, rows, correctConditions = new Set(['autobiographical'])) {
  const secrets = new Map(rows.map(row => [row.public.id, row.secret]));
  const created = store.createEpisodicProspectionStudy(design(rows));
  while (store.episodicProspectionStudiesSnapshot({ studyId: created.id }).studies[0].status === 'active') {
    const subject = store.episodicProspectionStudiesSnapshot({ studyId: created.id, role: 'subject' }).studies[0];
    const item = subject.items.find(row => row.status === 'awaiting_response');
    const internal = store.snapshot().cognition.episodic_prospection_studies[0].items.find(row => row.id === item.id);
    const secret = secrets.get(item.id); const wrong = secret.answer === 'option_a' ? 'option_b' : 'option_a';
    store.submitEpisodicProspectionResponse(created.id, item.id, { choice: correctConditions.has(internal.condition) ? secret.answer : wrong });
    store.resolveEpisodicProspectionItem(created.id, item.id, {
      accepted_choice: secret.answer, answer_salt: secret.salt,
      observed: 'The preregistered exact future-choice key was revealed.',
      evidence: [{ type: 'choice_resolution', id: `resolution-${item.id}` }],
    });
  }
  return store.episodicProspectionStudiesSnapshot({ studyId: created.id }).studies[0];
}

test('episodic-prospection queues expose one unlabeled rendering and no alternatives or truth', async () => {
  const { store } = await setup(); const rows = corpus(store, 'sealed');
  const study = store.createEpisodicProspectionStudy(design(rows));
  const publicView = store.episodicProspectionStudiesSnapshot({ studyId: study.id }).studies[0];
  assert.equal(publicView.items, undefined);
  const subject = store.episodicProspectionStudiesSnapshot({ studyId: study.id, role: 'subject' }).studies[0];
  const active = subject.items.find(item => item.status === 'awaiting_response');
  assert.ok(active.memory_context);
  assert.equal(active.condition, undefined);
  assert.equal(active.autobiographical_rendering, undefined);
  assert.equal(active.deidentified_rendering, undefined);
  assert.equal(active.recombined_rendering, undefined);
  assert.doesNotMatch(JSON.stringify(store.cognitionSnapshot()), /sealed authentic feature-rich episode/);
  assert.throws(() => store.submitEpisodicProspectionResponse(study.id, active.id, { choice: 'option_a', confidence: 0.9 }), /only one option/);
});

test('fact-equivalent benefit is labeled information value rather than autobiographical specificity', async () => {
  const { store } = await setup(); const rows = corpus(store, 'information-only');
  const completed = completeSpecificPilot(store, rows, new Set(['autobiographical', 'deidentified_equivalent']));
  assert.equal(completed.report.accuracy.autobiographical, 1);
  assert.equal(completed.report.accuracy.deidentified_equivalent, 1);
  assert.equal(completed.report.accuracy.recombined, 0);
  assert.equal(completed.report.verdict, 'episodic_information_value_only', JSON.stringify(completed.report));
});

test('authentic autobiographical access can be distinguished from equivalent and recombined controls', async () => {
  const { store } = await setup(); const rows = corpus(store, 'specific');
  const completed = completeSpecificPilot(store, rows);
  assert.equal(completed.report.accuracy.autobiographical, 1);
  assert.equal(completed.report.accuracy.deidentified_equivalent, 0);
  assert.equal(completed.report.accuracy.recombined, 0);
  assert.equal(completed.report.verdict, 'autobiographical_specificity_observed', JSON.stringify(completed.report));
  assert.equal(completed.audit.complete_chain_verified, true);
  const indicator = store.consciousnessResearchStatus().indicators.find(item => item.id === 'episodic_autobiographical_prospection');
  assert.equal(indicator.status, 'collecting');
});

test('episodic-prospection confirmation requires independent curator and source-disjoint experiences', async () => {
  const { store } = await setup(); const pilotRows = corpus(store, 'pilot');
  const pilot = completeSpecificPilot(store, pilotRows);
  const confirmationRows = corpus(store, 'confirmation', 40);
  assert.throws(() => store.createEpisodicProspectionStudy(design(confirmationRows, { study_phase: 'confirmatory', replicates_study_id: pilot.id })), /independently evidenced curator/);
  const confirmation = store.createEpisodicProspectionStudy(design(confirmationRows, {
    study_phase: 'confirmatory', replicates_study_id: pilot.id,
    curator_id: 'episodic-curator-b', curator_evidence: [{ type: 'curator_attestation', id: 'episodic-curator-b-evidence' }],
  }));
  assert.equal(confirmation.item_target, 120);
  assert.equal(confirmation.samples_per_condition, 40);
});

test('post-completion episodic response tampering invalidates the audit and indicator evidence', async () => {
  const { store, filePath } = await setup(); const completed = completeSpecificPilot(store, corpus(store, 'tamper'));
  await store.persist();
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  state.cognition.episodic_prospection_studies[0].items[0].response.choice = state.cognition.episodic_prospection_studies[0].items[0].response.choice === 'option_a' ? 'option_b' : 'option_a';
  fs.writeFileSync(filePath, JSON.stringify(state));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-14T00:00:00.000Z') });
  await reloaded.init();
  const study = reloaded.episodicProspectionStudiesSnapshot({ studyId: completed.id }).studies[0];
  assert.equal(study.audit.complete_chain_verified, false);
  const indicator = reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'episodic_autobiographical_prospection');
  assert.equal(indicator.evidence.completed_invalid_audits, 1);
});
