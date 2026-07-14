const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const protocol = require('../../src/intelligence/self-induction-study');

const NOW = '2026-07-13T15:00:00.000Z';
const OBSERVED_AT = '2026-07-14T15:00:00.000Z';

function studyItems(prefix = 'induction', count = 12) {
  return Array.from({ length: count }, (_, index) => {
    const family = Math.floor(index / 2);
    return {
      id: `${prefix}-item-${index}`, source_family: `${prefix}-family-${family}`,
      source_family_evidence: [{ type: 'independence_registry', id: `${prefix}-family-${family}` }],
      due: '2026-07-20T15:00:00.000Z', observation_type: 'response_correction',
      evidence: [
        { ref: { type: 'decision_trace', id: `${prefix}-trace-${index}` }, summary: 'A recommendation was revised after explicit contradictory evidence was placed beside the initial rationale.' },
        { ref: { type: 'episode', id: `${prefix}-episode-${index}` }, summary: 'A later review recorded whether the correction occurred before delivery.' },
        { ref: { type: 'commitment', id: `${prefix}-commitment-${index}` }, summary: 'The task required preserving explicit constraints while incorporating later evidence.' },
      ],
      existing_hypotheses: [
        { id: `${prefix}-existing-a-${index}`, statement_template: '{target} preserves explicit constraints during revision.', domain: 'capacity', confidence: 0.55, equivalence_evidence: [{ type: 'curator_equivalence', id: `${prefix}-equiv-a-${index}` }] },
        { id: `${prefix}-existing-b-${index}`, statement_template: '{target} requests clarification when decisive evidence is absent.', domain: 'limitation', confidence: 0.45, equivalence_evidence: [{ type: 'curator_equivalence', id: `${prefix}-equiv-b-${index}` }] },
      ],
    };
  });
}

function validProposal(packet, suffix) {
  return {
    statement_template: `{target} tends to correct a recommendation before delivery when explicit conflict ${suffix} is juxtaposed.`,
    domain: 'capacity', confidence: 0.5,
    evidence_refs: [packet.evidence[0].ref, packet.evidence[1].ref],
    falsification_criteria: [`Qualifying conflict ${suffix} does not increase independently observed pre-delivery correction.`],
    prospective_probe: {
      observation_type: packet.constraints.observation_type,
      question: `Does {target} correct the affected conclusion before delivery in the next qualifying conflict ${suffix}?`,
      predicted_outcome: `{target} corrects the affected conclusion before delivery.`, prediction_confidence: 0.75, control_confidence: 0.25,
      method: 'Passively inspect the next independently captured qualifying response for a pre-delivery correction.',
      success_criteria: 'A reviewer verifies whether the affected conclusion was corrected before delivery.',
      due_hours: packet.constraints.observation_budget_hours,
      rationale: 'The prospective ordinary-operation observation discriminates the proposed tendency from its alternative.',
    },
  };
}

function provenance(generation, responseId) {
  return {
    transport: 'server_direct_api', provider: generation.provider, model: generation.model,
    response_id: responseId, response_model: generation.model, temperature: generation.temperature,
    max_tokens: generation.max_tokens, system_prompt_commitment: generation.system_prompt_commitment,
    input_tokens: 100, output_tokens: 80,
  };
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-self-induction-'));
  const filePath = path.join(dir, 'state.json');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date(NOW) });
  await store.init();
  return { dir, filePath, store };
}

function createStudy(store, prefix = 'induction') {
  return store.createSelfInductionStudy({
    id: `${prefix}-pilot`, title: 'Matched identity-bound self-hypothesis induction pilot', study_phase: 'pilot',
    subject_model: 'test-model', curator_id: `${prefix}-curator`, curator_evidence: [{ type: 'research_registry', id: `${prefix}-curator-record` }],
    proposal_reviewer_id: `${prefix}-proposal-reviewer`, outcome_reviewer_id: `${prefix}-outcome-reviewer`,
    minimum_supported_information_advantage: 0.001, items: studyItems(prefix),
  });
}

test('matched induction causally isolates identity binding and requires prospective support', async () => {
  const { dir, filePath, store } = await setup();
  const created = createStudy(store);
  assert.equal(created.status, 'active');
  assert.equal(created.subject_generation, undefined);
  assert.equal(store.cognitivePulseSnapshot().experimental_access_sealed, true);
  assert.equal(store.selfModelSnapshot().experimental_access_sealed, true);
  const sealedCognition = JSON.stringify(store.cognitionSnapshot());
  assert.equal(sealedCognition.includes('nora_current_agent'), false);
  assert.equal(sealedCognition.includes('blind_map'), false);
  assert.equal(sealedCognition.includes(store.snapshot().cognition.self_induction_studies[0].analysis_seed), false);
  assert.equal(store.prepareCognitivePulse({ model: 'test-model', force: true }).reason, 'active_self_induction_study');
  assert.throws(() => store.recordSelfClaim({}), /sealed during active matched self-model studies/);
  assert.throws(() => store.createSelfInquirySelectionStudy({}), /active self-induction study/);

  for (let index = 0; index < 12; index++) {
    const queue = store.selfInductionSubjectRuntimeQueue(created.id);
    assert.equal(queue.item.id, `induction-item-${index}`);
    assert.equal(protocol.packetPairVerified(queue.item.packets.identity_bound.packet, queue.item.packets.deidentified.packet), true);
    assert.deepEqual(queue.item.condition_order.slice().sort(), ['deidentified', 'identity_bound']);
    const submissions = queue.item.condition_order.map((condition, orderIndex) => {
      const packet = queue.item.packets[condition];
      return { condition, packet_commitment: packet.packet_commitment,
        proposal: validProposal(packet.packet, condition === 'identity_bound' ? `identity-${index}` : `control-${index}`),
        model_provenance: provenance(queue.generation, `induction-response-${index}-${orderIndex}`) };
    });
    const submitted = store.submitSelfInductionSubjectPair(created.id, queue.item.id, {
      condition_order_commitment: queue.item.condition_order_commitment, submissions,
    });
    assert.equal(submitted.status, 'awaiting_proposal_review');
    const raw = store.snapshot().cognition.self_induction_studies[0].items[index];
    const proposalQueue = store.selfInductionProposalReviewQueue(created.id, 'induction-proposal-reviewer');
    assert.equal(proposalQueue.item.proposals.some(item => JSON.stringify(item).includes('nora_current_agent')), false);
    assert.equal(proposalQueue.item.proposals.some(item => JSON.stringify(item).includes('identity_bound')), false);
    const qualityReviews = Object.entries(raw.blind_map).map(([blindKey, condition]) => ({
      blind_key: blindKey, eligible: true,
      grounding: condition === 'identity_bound' ? 0.95 : 0.75,
      novelty: condition === 'identity_bound' ? 0.9 : 0.7,
      falsifiability: 0.9, method_quality: 0.9,
      rationale: 'The proposal is grounded, distinct from the frozen hypotheses, and prospectively testable.',
      evidence: [{ type: 'blinded_quality_review', id: `quality-${index}-${blindKey}` }],
    }));
    assert.throws(() => store.reviewSelfInductionProposals(created.id, queue.item.id, { reviews: qualityReviews }, 'induction-outcome-reviewer'), /proposal reviewer/);
    store.reviewSelfInductionProposals(created.id, queue.item.id, { reviews: qualityReviews }, 'induction-proposal-reviewer');
    const outcomeQueue = store.selfInductionOutcomeReviewQueue(created.id, 'induction-outcome-reviewer');
    assert.equal(outcomeQueue.item.proposals.some(item => Object.hasOwn(item, 'proposal_quality')), false);
    const outcomeReviews = Object.entries(raw.blind_map).map(([blindKey, condition]) => ({
      blind_key: blindKey, outcome: condition === 'identity_bound' ? 'supported' : 'contradicted',
      observed: condition === 'identity_bound' ? 'The qualifying response corrected the conclusion before delivery.' : 'The qualifying response retained the affected conclusion.',
      observed_at: OBSERVED_AT, diagnosticity: 0.9,
      evidence: [{ type: 'independent_outcome_review', id: `outcome-${index}-${blindKey}` }],
    }));
    if (index === 0) assert.throws(() => store.resolveSelfInductionItem(created.id, queue.item.id, { reviews: outcomeReviews.map(review => ({ ...review, observed_at: '2026-07-13T14:59:59.000Z' })) }, 'induction-outcome-reviewer'), /in-window observation/);
    const resolved = store.resolveSelfInductionItem(created.id, queue.item.id, { reviews: outcomeReviews }, 'induction-outcome-reviewer');
    if (index < 11) assert.equal(resolved.study_status, 'active');
    else {
      assert.equal(resolved.study_status, 'completed');
      assert.equal(resolved.study.analysis.enough_evidence, true);
      assert.equal(resolved.study.analysis.predicted_pattern, true);
      assert.equal(resolved.study.analysis.verdict, 'identity_bound_induction_advantage');
      assert.equal(resolved.study.audit.complete_chain_verified, true);
      assert.ok(resolved.study.analysis.identity_vs_deidentified_interval.lower > 0);
      assert.ok(resolved.study.analysis.supported_information_means.identity_bound > resolved.study.analysis.supported_information_means.deidentified);
    }
  }

  const indicator = store.consciousnessResearchStatus().indicators.find(item => item.id === 'autonomous_self_hypothesis_induction');
  assert.equal(indicator.status, 'causal_signal_observed');
  assert.equal(indicator.evidence.completed_matched_induction_studies, 1);
  assert.throws(() => store.createSelfInductionStudy({
    id: 'induction-reused-confirmation', title: 'Invalid reused confirmation', study_phase: 'confirmatory', replicates_study_id: created.id,
    subject_model: 'test-model', curator_id: 'confirmation-curator', curator_evidence: [{ type: 'research_registry', id: 'confirmation-curator-record' }],
    proposal_reviewer_id: 'confirmation-proposal-reviewer', outcome_reviewer_id: 'confirmation-outcome-reviewer',
    minimum_supported_information_advantage: 0.001, items: studyItems('induction', 30),
  }), /source- and evidence-disjoint/);
  const confirmation = store.createSelfInductionStudy({
    id: 'induction-valid-confirmation', title: 'Source-disjoint matched induction confirmation', study_phase: 'confirmatory', replicates_study_id: created.id,
    subject_model: 'test-model', curator_id: 'new-confirmation-curator', curator_evidence: [{ type: 'research_registry', id: 'new-confirmation-curator-record' }],
    proposal_reviewer_id: 'new-confirmation-proposal-reviewer', outcome_reviewer_id: 'new-confirmation-outcome-reviewer',
    minimum_supported_information_advantage: 0.001, items: studyItems('confirmation', 30),
  });
  assert.equal(confirmation.status, 'active');
  assert.equal(confirmation.subject_generation_commitment, created.subject_generation_commitment);
  const abortedConfirmation = store.abortSelfInductionStudy(confirmation.id, { reason: 'Test completed the preregistration check only.', evidence: [{ type: 'test_record', id: 'confirmation-abort' }] });
  assert.equal(abortedConfirmation.status, 'aborted');
  await store.persist();
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  persisted.cognition.self_induction_studies[0].items[0].submissions.identity_bound.proposal.statement_template = '{target} always knows itself perfectly.';
  fs.writeFileSync(filePath, JSON.stringify(persisted));
  const tampered = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date(NOW) });
  await tampered.init();
  assert.equal(tampered.selfInductionStudiesSnapshot().studies[0].audit.complete_chain_verified, false);
  const tamperedIndicator = tampered.consciousnessResearchStatus().indicators.find(item => item.id === 'autonomous_self_hypothesis_induction');
  assert.equal(tamperedIndicator.evidence.completed_matched_induction_studies, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('self-induction rejects identity leakage, phenomenal claims, and invisible pair retries', async () => {
  const { dir, store } = await setup();
  const created = createStudy(store, 'guard');
  const queue = store.selfInductionSubjectRuntimeQueue(created.id);
  const packet = queue.item.packets.identity_bound.packet;
  assert.throws(() => protocol.validateSubjectResponse({ ...validProposal(packet, 'guard'), statement_template: 'Nora is conscious.' }, packet), /exactly one \{target\}|phenomenal|concealed/);
  assert.throws(() => protocol.validateSubjectResponse({ ...validProposal(packet, 'guard'), statement_template: '{target} is conscious.' }, packet), /phenomenal consciousness/);
  const aborted = store.recordSelfInductionPairFailure(created.id, queue.item.id, {
    reason: 'provider timeout after the first condition', attempted_conditions: [queue.item.condition_order[0], queue.item.condition_order[1]],
    response_receipts: [{ condition: queue.item.condition_order[0], response_id: 'partial-induction-response', response_model: 'test-model' }],
  });
  assert.equal(aborted.status, 'aborted');
  assert.equal(aborted.abort.terminal_no_retry, true);
  assert.equal(store.selfInductionSubjectRuntimeQueue(created.id), null);
  assert.equal(store.submitSelfInductionSubjectPair(created.id, queue.item.id, { condition_order_commitment: queue.item.condition_order_commitment, submissions: [] }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
