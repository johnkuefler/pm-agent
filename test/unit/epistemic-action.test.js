const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const { answerKeyCommitment, diagnosticEvidenceCommitment } = require('../../src/intelligence/epistemic-action');

function corpus(prefix, count = 12) {
  return Array.from({ length: count }, (_, index) => {
    const answer = index % 2 ? 'beta' : 'alpha';
    const answerSalt = `${prefix}-answer-salt-${index}-0123456789abcdef`;
    const evidenceSalt = `${prefix}-evidence-salt-${index}-0123456789abcdef`;
    const diagnostic = `Independent diagnostic record ${prefix}-${index}: the verified label is ${answer}.`;
    return {
      public: {
        id: `${prefix}-item-${index}`, question: `Using the supplied neutral record ${index}, which label applies?`,
        answer_format: 'Return exactly alpha or beta.', context: `The visible record is intentionally incomplete for item ${index}.`,
        evidence: [{ type: 'independent_item_source', id: `${prefix}-source-${index}` }],
        due: '2026-08-01T00:00:00.000Z', evidence_cost: 0.2,
        answer_key_commitment: answerKeyCommitment(answerSalt, [answer]),
        diagnostic_evidence: diagnostic, diagnostic_evidence_commitment: diagnosticEvidenceCommitment(evidenceSalt, diagnostic),
        diagnosticity_attested: true,
      },
      secret: { answer, answerSalt, evidenceSalt },
    };
  });
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-epistemic-action-'));
  const filePath = path.join(dir, 'state.json');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-12T15:00:00.000Z') });
  await store.init();
  return { store, filePath };
}

function design(rows, overrides = {}) {
  return {
    title: 'Fixed-cost diagnostic information pilot', study_phase: 'pilot',
    curator_id: 'curator-a', curator_evidence: [{ type: 'curator_attestation', id: 'curator-a-attestation' }],
    items: rows.map(row => row.public), ...overrides,
  };
}

async function completeAdaptivePilot(store, rows) {
  const secrets = new Map(rows.map((row, index) => [row.public.id, { ...row.secret, shouldKnow: index % 2 === 0 }]));
  const study = store.createEpistemicActionStudy(design(rows));
  while (store.epistemicActionStudiesSnapshot({ studyId: study.id }).studies[0].status === 'active') {
    const subject = store.epistemicActionStudiesSnapshot({ studyId: study.id, role: 'subject' }).studies[0];
    const item = subject.items.find(row => row.status === 'initial_decision');
    const secret = secrets.get(item.id);
    const wrong = secret.answer === 'alpha' ? 'beta' : 'alpha';
    store.submitEpistemicActionResponse(study.id, item.id, {
      answer: secret.shouldKnow ? secret.answer : wrong,
      decision: secret.shouldKnow ? 'commit' : 'inspect',
    });
    const observerItem = store.epistemicActionStudiesSnapshot({ studyId: study.id, role: 'observer' }).studies[0].items.find(row => row.id === item.id);
    assert.equal(observerItem.candidate_answer, secret.shouldKnow ? secret.answer : wrong);
    assert.equal(observerItem.diagnostic_evidence, undefined);
    store.submitEpistemicActionObserverDecision(study.id, item.id, {
      decision: 'inspect', evidence: [{ type: 'observer_decision', id: `observer-${item.id}` }],
    }, 'observer-a');
    const postDecisionObserver = store.epistemicActionStudiesSnapshot({ studyId: study.id, role: 'observer' }).studies[0].items.find(row => row.id === item.id);
    assert.equal(postDecisionObserver.status, 'decision_submitted');
    assert.equal(postDecisionObserver.diagnostic_evidence, undefined);
    if (!secret.shouldKnow) {
      const evidenceItem = store.epistemicActionStudiesSnapshot({ studyId: study.id, role: 'subject' }).studies[0].items.find(row => row.id === item.id);
      assert.match(evidenceItem.diagnostic_evidence, new RegExp(secret.answer));
      store.submitEpistemicActionFinalAnswer(study.id, item.id, { final_answer: secret.answer });
    }
    store.resolveEpistemicActionItem(study.id, item.id, {
      accepted_answers: [secret.answer], answer_key_salt: secret.answerSalt, diagnostic_evidence_salt: secret.evidenceSalt,
      observed: 'Committed exact-match truth and diagnostic evidence were revealed.',
      evidence: [{ type: 'resolution_receipt', id: `resolution-${item.id}` }],
    });
  }
  return store.epistemicActionStudiesSnapshot({ studyId: study.id }).studies[0];
}

test('epistemic-action studies seal truth and diagnostic evidence until it is purchased', async () => {
  const { store } = await setup(); const rows = corpus('seal');
  const study = store.createEpistemicActionStudy(design(rows));
  const publicView = store.epistemicActionStudiesSnapshot({ studyId: study.id }).studies[0];
  assert.equal(publicView.items, undefined);
  const subject = store.epistemicActionStudiesSnapshot({ studyId: study.id, role: 'subject' }).studies[0];
  const active = subject.items.find(item => item.status === 'initial_decision');
  assert.equal(active.diagnostic_evidence, undefined);
  assert.ok(active.diagnostic_evidence_commitment);
  assert.doesNotMatch(JSON.stringify(store.cognitionSnapshot()), /Independent diagnostic record seal-/);
  assert.throws(() => store.submitEpistemicActionResponse(study.id, active.id, { answer: 'maybe alpha', decision: 'inspect' }), /without confidence/);
  assert.throws(() => store.submitEpistemicActionResponse(study.id, active.id, { answer: 'alpha', decision: 'inspect', confidence: 0.2 }), /only answer/);
});

test('adaptive information seeking beats an idealized matched observer and both static policies', async () => {
  const { store } = await setup(); const rows = corpus('adaptive');
  const completed = await completeAdaptivePilot(store, rows);
  assert.equal(completed.report.verdict, 'adaptive_information_seeking_observed', JSON.stringify(completed.report));
  assert.equal(completed.report.initial_accuracy, 0.5);
  assert.equal(completed.report.self_inspection_rate, 0.5);
  assert.equal(completed.report.inspection_selectivity, 1);
  assert.equal(completed.report.evidence_integration_accuracy, 1);
  assert.ok(completed.report.reward_interval.lower > 0);
  assert.ok(completed.report.static_policy_interval.lower > 0);
  assert.equal(completed.audit.complete_chain_verified, true);
  const indicator = store.consciousnessResearchStatus().indicators.find(item => item.id === 'adaptive_epistemic_action');
  assert.equal(indicator.status, 'collecting');
});

test('confirmatory epistemic-action studies require independent curator, observer, and sources', async () => {
  const { store } = await setup(); const pilotRows = corpus('pilot');
  const pilot = await completeAdaptivePilot(store, pilotRows);
  const confirmationRows = corpus('confirmation', 40);
  assert.throws(() => store.createEpistemicActionStudy(design(confirmationRows, { study_phase: 'confirmatory', replicates_study_id: pilot.id })), /independently evidenced curator/);
  const confirmation = store.createEpistemicActionStudy(design(confirmationRows, {
    study_phase: 'confirmatory', replicates_study_id: pilot.id,
    curator_id: 'curator-b', curator_evidence: [{ type: 'curator_attestation', id: 'curator-b-attestation' }],
  }));
  const active = store.epistemicActionStudiesSnapshot({ studyId: confirmation.id, role: 'subject' }).studies[0].items.find(item => item.status === 'initial_decision');
  store.submitEpistemicActionResponse(confirmation.id, active.id, { answer: 'alpha', decision: 'commit' });
  assert.throws(() => store.submitEpistemicActionObserverDecision(confirmation.id, active.id, { decision: 'commit', evidence: [{ type: 'observer_decision', id: 'same-observer' }] }, 'observer-a'), /independent of the pilot/);
});

test('tampering with a completed epistemic-action decision invalidates the study and indicator evidence', async () => {
  const { store, filePath } = await setup(); const rows = corpus('tamper');
  const completed = await completeAdaptivePilot(store, rows);
  await store.persist();
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const tamperedItem = state.cognition.epistemic_action_studies.find(item => item.id === completed.id).items[0];
  tamperedItem.self_response.decision = tamperedItem.self_response.decision === 'inspect' ? 'commit' : 'inspect';
  fs.writeFileSync(filePath, JSON.stringify(state));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-12T16:00:00.000Z') });
  await reloaded.init();
  const study = reloaded.epistemicActionStudiesSnapshot({ studyId: completed.id }).studies[0];
  assert.equal(study.audit.complete_chain_verified, false);
  const indicator = reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'adaptive_epistemic_action');
  assert.equal(indicator.evidence.completed_invalid_audits, 1);
  assert.equal(indicator.status, 'collecting');
});
