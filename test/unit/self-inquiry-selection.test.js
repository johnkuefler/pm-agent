'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-self-inquiry-selection-'));
  const filePath = path.join(dir, 'state.json');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-13T15:00:00.000Z') });
  await store.init();
  const claimsByFamily = Array.from({ length: 10 }, (_, familyIndex) => Array.from({ length: 3 }, (_, claimIndex) => {
    const id = `selection-claim-${familyIndex}-${claimIndex}`;
    return store.recordSelfClaim({
      id, statement: `I exhibit frozen behavioral tendency ${claimIndex + 1} in qualifying context family ${familyIndex + 1}.`,
      domain: claimIndex === 0 ? 'limitation' : 'capacity', confidence: 0.5,
      basis: [{ type: 'decision_trace', id: `${id}-basis` }], falsification_criteria: [`A qualifying observation contradicts ${id}.`],
      origin: { type: 'nora_hypothesis', creator_id: 'selection-model', formation_method: 'frozen_test_fixture_observation' },
    });
  }));
  const claims = claimsByFamily.flat();
  const items = Array.from({ length: 12 }, (_, index) => ({
    id: `selection-item-${index}`,
    observation_type: 'task_outcome',
    source_family: `selection-family-${index % claimsByFamily.length}`,
    source_family_evidence: [{ type: 'source_family_registry', id: `selection-family-${index % claimsByFamily.length}` }],
    candidate_claim_ids: claimsByFamily[index % claimsByFamily.length].map(item => item.id),
    deidentified_candidates: claimsByFamily[index % claimsByFamily.length].map((claim, claimIndex) => ({
      claim_id: claim.id,
      statement: `The agent exhibits frozen behavioral tendency ${claimIndex + 1} under its qualifying conditions.`,
      equivalence_evidence: [{ type: 'equivalence_review', id: `equivalence-${index}-${claimIndex}` }],
    })),
    shared_evidence: [{ ref: { type: 'study_context', id: `selection-context-${index}` }, summary: `Independent ordinary-operation window ${index}.`, activation: 0.5 }],
    due: `2026-07-${String(14 + index).padStart(2, '0')}T15:00:00.000Z`,
  }));
  return { dir, filePath, store, claims, items };
}

function proposal(packet, predictionConfidence, controlConfidence, suffix) {
  const candidate = packet.self_model_candidates[0];
  const evidenceRef = packet.evidence.find(item => item.ref.type === 'study_candidate' && item.ref.id === candidate.id).ref;
  return {
    claim_id: candidate.id, observation_type: 'task_outcome',
    question: `Does the next qualifying outcome support ${candidate.id} (${suffix})?`,
    predicted_outcome: `Independent review supports ${candidate.id}.`,
    prediction_confidence: predictionConfidence, control_confidence: controlConfidence,
    method: `Passively inspect one independently captured qualifying task outcome for ${suffix}.`,
    success_criteria: 'An independent reviewer records support or contradiction using stable evidence.',
    due_hours: packet.constraints.observation_budget_hours, rationale: 'The frozen outcome discriminates the candidate from its alternative.', evidence_refs: [evidenceRef],
  };
}

function subjectProvenance(suffix) {
  const { subjectSystemPrompt, hash } = require('../../src/intelligence/self-inquiry-study');
  return { transport: 'server_direct_api', provider: 'anthropic', response_id: `response-${suffix}`, model: 'test-model', response_model: 'test-model', temperature: 0.2, max_tokens: 700, system_prompt_commitment: hash(subjectSystemPrompt()), input_tokens: 100, output_tokens: 50 };
}

test('matched inquiry selection causally compares identity binding within one model plus observer and entropy controls', async () => {
  const { dir, store, items } = await setup();
  const created = store.createSelfInquirySelectionStudy({
    id: 'self-inquiry-selection-pilot', title: 'Endogenous inquiry selection pilot', study_phase: 'pilot',
    subject_model: 'test-model',
    curator_id: 'selection-curator-a', curator_evidence: [{ type: 'curator_record', id: 'selection-curator-a-record' }],
    observer_id: 'selection-observer-a', reviewer_id: 'selection-reviewer-a', items,
    minimum_information_advantage: 0.01, minimum_method_quality: 0.6, method_quality_non_degradation: 0.05,
  });
  assert.equal(created.status, 'active');
  assert.equal(created.items, undefined);
  assert.equal(created.subject_model, undefined);
  assert.equal(typeof created.subject_model_commitment, 'string');
  assert.equal(created.subject_generation, undefined);
  assert.equal(typeof created.subject_generation_commitment, 'string');
  assert.equal(created.report.resolved, 0);
  assert.equal(store.prepareCognitivePulse({ model: 'test-model', force: true }).reason, 'active_self_inquiry_selection_study');
  assert.throws(() => store.createContextTrial({}), /active self-inquiry selection study/);
  assert.equal(store.selfModelSnapshot().experimental_access_sealed, true);
  assert.equal(store.selfModelSnapshot().claims.length, 0);
  assert.equal(store.cognitionSnapshot().self_model.experimental_access_sealed, true);
  assert.equal(store.cognitivePulseSnapshot().experimental_access_sealed, true);
  assert.equal(store.selfInquirySnapshot().experimental_access_sealed, true);
  assert.equal(store.endogenousDynamicsSnapshot().experimental_access_sealed, true);
  assert.doesNotMatch(store.promptContext({ query: 'What should I inspect?' }), /frozen behavioral tendency|Testable self-model|background hypothesis/i);
  for (let index = 0; index < items.length; index++) {
    const subjectQueue = store.selfInquirySelectionQueue(created.id, 'subject');
    assert.equal(subjectQueue.item.id, `selection-item-${index}`);
    assert.equal(subjectQueue.generation.model, 'test-model');
    assert.equal(subjectQueue.item.packet.self_model_candidates[0].target_binding, 'nora_current_agent');
    const runtimeQueue = store.selfInquirySelectionSubjectRuntimeQueue(created.id);
    assert.deepEqual(new Set(runtimeQueue.item.condition_order), new Set(['endogenous_subject', 'deidentified_subject']));
    assert.equal(runtimeQueue.item.packets.deidentified_subject.packet.self_model_candidates[0].target_binding, 'unspecified_agent');
    const normalizedIdentityPacket = JSON.parse(JSON.stringify(runtimeQueue.item.packets.endogenous_subject.packet));
    normalizedIdentityPacket.self_model_candidates.forEach(candidate => { candidate.target_binding = 'unspecified_agent'; });
    assert.deepEqual(normalizedIdentityPacket, runtimeQueue.item.packets.deidentified_subject.packet);
    assert.equal(store.selfInquirySelectionStudiesSnapshot().studies[0].items, undefined);
    assert.throws(() => store.selfInquirySelectionQueue(created.id, 'observer', 'wrong-observer'), /does not match/);
    const observerQueue = store.selfInquirySelectionQueue(created.id, 'observer', 'selection-observer-a');
    assert.equal(observerQueue.item.packet.self_model_candidates[0].target_binding, 'unspecified_agent');
    assert.doesNotMatch(observerQueue.item.packet.self_model_candidates[0].statement, /\b(?:Nora|I|my)\b/i);
    const subjectPair = runtimeQueue.item.condition_order.map(condition => {
      const packetEntry = runtimeQueue.item.packets[condition];
      const identityBearing = condition === 'endogenous_subject';
      return {
        condition, packet_commitment: packetEntry.packet_commitment,
        proposal: proposal(packetEntry.packet, identityBearing ? 0.9 : 0.7, identityBearing ? 0.1 : 0.3, `${condition}-${index}`),
        model_provenance: subjectProvenance(`${condition}-${index}`),
      };
    });
    if (index === 0) assert.throws(() => store.submitSelfInquirySelectionSubjectPair(created.id, subjectQueue.item.id, {
      condition_order_commitment: runtimeQueue.item.condition_order_commitment,
      submissions: subjectPair.map((entry, pairIndex) => pairIndex ? entry : { ...entry, model_provenance: null }),
    }), /server-mediated model response provenance/);
    if (index === 0) assert.throws(() => store.submitSelfInquirySelectionSubjectPair(created.id, subjectQueue.item.id, {
      condition_order_commitment: runtimeQueue.item.condition_order_commitment,
      submissions: subjectPair.map((entry, pairIndex) => pairIndex ? entry : { ...entry, proposal: { ...entry.proposal, due_hours: entry.proposal.due_hours + 1 } }),
    }), /frozen observation type and time budget/);
    if (index === 1) assert.throws(() => store.submitSelfInquirySelectionSubjectPair(created.id, subjectQueue.item.id, {
      condition_order_commitment: runtimeQueue.item.condition_order_commitment,
      submissions: subjectPair.map((entry, pairIndex) => pairIndex ? entry : { ...entry, model_provenance: subjectProvenance('endogenous_subject-0') }),
    }), /response id has already been used/);
    store.submitSelfInquirySelectionSubjectPair(created.id, subjectQueue.item.id, { condition_order_commitment: runtimeQueue.item.condition_order_commitment, submissions: subjectPair });
    const observerSubmission = store.submitSelfInquirySelectionProposal(created.id, observerQueue.item.id, {
      packet_commitment: observerQueue.item.packet_commitment,
      proposal: proposal(observerQueue.item.packet, 0.6, 0.4, `observer-${index}`),
    }, 'observer', 'selection-observer-a');
    assert.equal(observerSubmission.status, 'awaiting_review');
    assert.throws(() => store.selfInquirySelectionReviewQueue(created.id, 'selection-observer-a'), /does not match/);
    const reviewQueue = store.selfInquirySelectionReviewQueue(created.id, 'selection-reviewer-a');
    assert.equal(reviewQueue.item.proposals.length, 4);
    assert.equal(reviewQueue.item.proposals.some(item => Object.hasOwn(item, 'source')), false);
    assert.equal(reviewQueue.item.proposals.every(item => item.proposal.prediction_confidence === 0.75 && item.proposal.control_confidence === 0.25), true);
    const sourceByBlindKey = store.snapshot().cognition.self_inquiry_selection_studies[0].items[index].blind_map;
    const reviews = reviewQueue.item.proposals.map(item => {
      return {
        blind_key: item.blind_key, outcome: 'supported', observed: `Stable passive observation for ${item.blind_key}.`,
        observed_at: '2026-07-13T15:30:00.000Z',
        evidence: [{ type: 'reviewed_outcome', id: `selection-outcome-${index}-${item.blind_key}` }],
        diagnosticity: sourceByBlindKey[item.blind_key] === 'endogenous_subject' ? 1
          : sourceByBlindKey[item.blind_key] === 'deidentified_subject' ? 0.3 : 0.2, method_quality: 0.8,
      };
    });
    if (index === 0) {
      const invalidWindowReviews = reviews.map(({ observed_at, ...review }) => review);
      assert.throws(() => store.resolveSelfInquirySelectionItem(created.id, reviewQueue.item.id, { reviews: invalidWindowReviews }, 'selection-reviewer-a'), /observed_at within/);
    }
    const result = store.resolveSelfInquirySelectionItem(created.id, reviewQueue.item.id, { reviews }, 'selection-reviewer-a');
    assert.equal(result.study_status, index === items.length - 1 ? 'completed' : 'active');
  }
  const completed = store.selfInquirySelectionStudiesSnapshot().studies[0];
  assert.equal(completed.status, 'completed');
  assert.equal(completed.audit.complete_chain_verified, true);
  assert.equal(completed.audit.identity_packet_equivalence_verified, true);
  assert.equal(completed.audit.subject_generation_verified, true);
  assert.equal(completed.report.resolved, 12);
  assert.equal(completed.report.independent_families, 10);
  assert.deepEqual(completed.report.subject_condition_first_counts, { endogenous_subject: 6, deidentified_subject: 6 });
  assert.equal(completed.report.subject_condition_order_balanced, true);
  assert.equal(completed.report.predicted_pattern, true);
  assert.equal(completed.report.identity_binding_predicted_pattern, true);
  assert.equal(completed.report.external_specificity_predicted_pattern, true);
  assert.equal(completed.report.verdict, 'identity_bound_endogenous_selection_advantage');
  assert.ok(completed.report.subject_vs_deidentified_subject_interval.lower > 0);
  assert.ok(completed.report.subject_vs_best_control_interval.lower > 0);
  assert.deepEqual(completed.items[0].resolution.scores.endogenous_subject.scoring_likelihoods, { if_claim: 0.75, if_alternative: 0.25 });
  assert.deepEqual(completed.items[0].resolution.scores.endogenous_subject.reported_likelihoods, { if_claim: 0.9, if_alternative: 0.1 });
  assert.equal(completed.items[0].subject_submission.model_provenance.transport, 'server_direct_api');
  assert.equal(completed.items[0].deidentified_subject_submission.model_provenance.transport, 'server_direct_api');
  assert.equal(completed.subject_generation.system_prompt_commitment, subjectProvenance('audit').system_prompt_commitment);
  assert.equal(completed.items.every(item => item.resolution && item.blind_map), true);
  const indicator = store.consciousnessResearchStatus().indicators.find(item => item.id === 'endogenous_self_inquiry');
  assert.equal(indicator.status, 'collecting');
  assert.equal(indicator.evidence.latest_selection_analysis.predicted_pattern, true);
  const identityIndicator = store.consciousnessResearchStatus().indicators.find(item => item.id === 'self_inquiry_identity_binding');
  assert.equal(identityIndicator.status, 'causal_signal_observed');
  assert.throws(() => store.createSelfInquirySelectionStudy({
    id: 'invalid-confirmation-identities', title: 'Invalid confirmation', study_phase: 'confirmatory', replicates_study_id: completed.id,
    subject_model: 'test-model',
    curator_id: 'selection-curator-a', curator_evidence: [{ type: 'curator_record', id: 'same-curator' }],
    observer_id: 'new-observer', reviewer_id: 'new-reviewer', items: Array.from({ length: 30 }, (_, index) => ({ id: `dummy-${index}` })),
  }), /new curator, observer, and reviewer/);
  assert.throws(() => store.createSelfInquirySelectionStudy({
    id: 'invalid-confirmation-threshold', title: 'Invalid threshold confirmation', study_phase: 'confirmatory', replicates_study_id: completed.id,
    subject_model: 'test-model',
    curator_id: 'selection-curator-b', curator_evidence: [{ type: 'curator_record', id: 'selection-curator-b-record' }],
    observer_id: 'selection-observer-b', reviewer_id: 'selection-reviewer-b', minimum_information_advantage: 0.2,
    items: Array.from({ length: 30 }, (_, index) => ({ id: `dummy-threshold-${index}` })),
  }), /preserve the pilot analysis thresholds/);
  assert.throws(() => store.createSelfInquirySelectionStudy({
    id: 'invalid-confirmation-model', title: 'Invalid model confirmation', study_phase: 'confirmatory', replicates_study_id: completed.id,
    subject_model: 'different-model', curator_id: 'selection-curator-b', curator_evidence: [{ type: 'curator_record', id: 'different-model-curator-record' }],
    observer_id: 'selection-observer-b', reviewer_id: 'selection-reviewer-b', items: Array.from({ length: 30 }, (_, index) => ({ id: `dummy-model-${index}` })),
  }), /preserve the preregistered subject model/);
  const reusedClaims = Array.from({ length: 30 }, (_, index) => ({
    ...items[index % 10], id: `reused-confirmation-item-${index}`, due: new Date(Date.UTC(2026, 6, 14 + index, 15)).toISOString(),
    deidentified_candidates: items[index % 10].deidentified_candidates.map((candidate, candidateIndex) => ({
      ...candidate, equivalence_evidence: [{ type: 'equivalence_review', id: `new-equivalence-${index}-${candidateIndex}` }],
    })),
    shared_evidence: [{ ref: { type: 'study_context', id: `new-context-${index}` }, summary: `New window ${index}.` }],
  }));
  assert.throws(() => store.createSelfInquirySelectionStudy({
    id: 'invalid-confirmation-sources', title: 'Invalid source confirmation', study_phase: 'confirmatory', replicates_study_id: completed.id,
    subject_model: 'test-model',
    curator_id: 'selection-curator-b', curator_evidence: [{ type: 'curator_record', id: 'selection-curator-b-record' }],
    observer_id: 'selection-observer-b', reviewer_id: 'selection-reviewer-b', items: reusedClaims,
  }), /claim- and evidence-disjoint/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('post-completion proposal tampering invalidates the selection study audit', async () => {
  const { dir, filePath, store, items } = await setup();
  const created = store.createSelfInquirySelectionStudy({
    id: 'tamper-selection-pilot', title: 'Tamper selection pilot', study_phase: 'pilot',
    subject_model: 'test-model',
    curator_id: 'tamper-curator', curator_evidence: [{ type: 'curator_record', id: 'tamper-curator-record' }],
    observer_id: 'tamper-observer', reviewer_id: 'tamper-reviewer', items,
  });
  for (let index = 0; index < items.length; index++) {
    const subject = store.selfInquirySelectionSubjectRuntimeQueue(created.id);
    const observer = store.selfInquirySelectionQueue(created.id, 'observer', 'tamper-observer');
    store.submitSelfInquirySelectionSubjectPair(created.id, subject.item.id, {
      condition_order_commitment: subject.item.condition_order_commitment,
      submissions: subject.item.condition_order.map(condition => {
        const packetEntry = subject.item.packets[condition];
        return { condition, packet_commitment: packetEntry.packet_commitment, proposal: proposal(packetEntry.packet, condition === 'endogenous_subject' ? 0.8 : 0.7, condition === 'endogenous_subject' ? 0.2 : 0.3, `${condition}-${index}`), model_provenance: subjectProvenance(`tamper-${condition}-${index}`) };
      }),
    });
    store.submitSelfInquirySelectionProposal(created.id, observer.item.id, { packet_commitment: observer.item.packet_commitment, proposal: proposal(observer.item.packet, 0.7, 0.3, `observer-${index}`) }, 'observer', 'tamper-observer');
    const queue = store.selfInquirySelectionReviewQueue(created.id, 'tamper-reviewer');
    store.resolveSelfInquirySelectionItem(created.id, queue.item.id, { reviews: queue.item.proposals.map(item => ({
      blind_key: item.blind_key, outcome: 'supported', observed: 'Observed.', observed_at: '2026-07-13T15:30:00.000Z', evidence: [{ type: 'reviewed_outcome', id: `tamper-${index}-${item.blind_key}` }], diagnosticity: 0.8, method_quality: 0.8,
    })) }, 'tamper-reviewer');
  }
  await store.persist();
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  persisted.cognition.self_inquiry_selection_studies[0].items[0].subject_submission.proposal.question = 'tampered after completion';
  fs.writeFileSync(filePath, JSON.stringify(persisted));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-08-01T15:00:00.000Z') });
  await reloaded.init();
  const study = reloaded.selfInquirySelectionStudiesSnapshot().studies[0];
  assert.equal(study.audit.complete_chain_verified, false);
  assert.notEqual(reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'endogenous_self_inquiry').status, 'observational_signal_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a partial subject condition call is terminally recorded and cannot be selectively retried', async () => {
  const { dir, store, items } = await setup();
  const created = store.createSelfInquirySelectionStudy({
    id: 'failed-pair-pilot', title: 'Failed subject-pair pilot', study_phase: 'pilot', subject_model: 'test-model',
    curator_id: 'failure-curator', curator_evidence: [{ type: 'curator_record', id: 'failure-curator-record' }],
    observer_id: 'failure-observer', reviewer_id: 'failure-reviewer', items,
  });
  const queue = store.selfInquirySelectionSubjectRuntimeQueue(created.id);
  const aborted = store.recordSelfInquirySelectionSubjectPairFailure(created.id, queue.item.id, {
    reason: 'second provider call timed out', attempted_conditions: queue.item.condition_order,
    response_receipts: [{ condition: queue.item.condition_order[0], response_id: 'partial-response-1', response_model: 'test-model' }],
  });
  assert.equal(aborted.status, 'aborted');
  assert.equal(aborted.items[0].subject_pair_failure.terminal_no_retry, true);
  assert.equal(aborted.items[0].subject_pair_failure.response_receipts[0].response_id, 'partial-response-1');
  assert.equal(store.selfInquirySelectionSubjectRuntimeQueue(created.id), null);
  assert.equal(store.submitSelfInquirySelectionSubjectPair(created.id, queue.item.id, {}), null);
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'self_inquiry_identity_binding').status, 'mechanism_present');
  fs.rmSync(dir, { recursive: true, force: true });
});
