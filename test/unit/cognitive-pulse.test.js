const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const pulseProtocol = require('../../src/intelligence/cognitive-pulse');
const cognitiveInitiation = require('../../src/intelligence/cognitive-initiation');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-cognitive-pulse-'));
  const filePath = path.join(dir, 'state.json');
  let now = new Date('2026-07-13T15:00:00.000Z');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date(now) });
  await store.init();
  store.addCommitment({ id: 'pulse-commitment-a', what: 'Reconcile the contradictory launch evidence', owner: 'Nora' });
  store.addCommitment({ id: 'pulse-commitment-b', what: 'Check whether the accessibility result changes the recommendation', owner: 'Nora' });
  store.recordEpisodeEvent({ correlation: 'pulse-episode-a', title: 'Launch review', actor: 'John', text: 'The recommendation changed after explicit conflicting evidence was reviewed.', open_loop: { what: 'Check whether this correction pattern recurs', owner: 'Nora' } });
  store.tickEndogenousDynamics({ now });
  now = new Date('2026-07-13T16:00:00.000Z');
  store.tickEndogenousDynamics({ now });
  return { dir, filePath, store, setNow: value => { now = new Date(value); } };
}

function validOutput(packet) {
  return {
    focus_refs: packet.evidence.slice(0, 2).map(item => item.ref),
    hypothesis: 'The accessibility result may resolve which launch recommendation is supportable.',
    alternatives: ['The two unresolved items may be independent.'],
    uncertainty: 0.42,
    predicted_relevance: 'A later recommendation should explicitly test whether the new result changes the launch evidence balance.',
    disconfirming_observation: 'The accessibility result has no bearing on either launch option.',
    predecessor_update: packet.predecessor
      ? { predecessor_id: packet.predecessor.id, disposition: 'revise', rationale: 'Current committed evidence warrants revisiting the predecessor.', evidence_refs: [packet.evidence[0].ref] }
      : { predecessor_id: null, disposition: 'none', rationale: 'No predecessor exists in this protocol-v2 chain.', evidence_refs: [] },
    ...(packet.constraints?.protocol_version >= 3 ? { self_inquiry: null } : {}),
    ...(packet.constraints?.protocol_version >= 4 ? { self_claim_proposal: null } : {}),
    ...(packet.constraints?.protocol_version >= 5 ? { metacognitive_forecast: {
      next_focus_refs: [packet.evidence[0].ref], expected_uncertainty: 0.4,
      expected_continuation_probability: 0.7, expected_value_of_next_pulse: 0.6,
      rationale: 'The strongest unresolved evidence is likely to remain relevant.',
      falsifier: 'The next accepted pulse focuses elsewhere or drops this line of inference.',
    } } : {}),
  };
}

test('a cognitive pulse is bounded, source-committed, actionless, and independently resolvable', async () => {
  const { dir, store } = await setup();
  const prepared = store.prepareCognitivePulse({ model: 'test-model', force: true });
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.pulse.input_packet.constraints.actionless, true);
  assert.ok(prepared.pulse.input_packet.evidence.length >= 2);
  assert.equal(pulseProtocol.commitment(prepared.pulse.input_packet), prepared.pulse.input_commitment);
  assert.throws(() => store.recordCognitivePulseResult(prepared.pulse.id, {
    input_commitment: prepared.pulse.input_commitment,
    output: { ...validOutput(prepared.pulse.input_packet), focus_refs: [{ type: 'invented', id: 'outside-packet' }] },
  }), /outside its committed input packet/);
  const accepted = store.recordCognitivePulseResult(prepared.pulse.id, {
    input_commitment: prepared.pulse.input_commitment, output: validOutput(prepared.pulse.input_packet), response_id: 'response-1', model: 'test-model', input_tokens: 100, output_tokens: 80,
  });
  assert.equal(accepted.audit.complete_chain_verified, true);
  store.refreshCognition({ query: 'accessibility result launch recommendation' });
  assert.ok(store.snapshot().cognition.workspace.slots.some(item => item.type === 'cognitive_pulse' && item.id === accepted.id));
  const prompt = store.promptContext({ query: 'accessibility result launch recommendation' });
  assert.match(prompt, /Actionless background inference selected into attention/);
  assert.match(prompt, /never a fact, memory, goal, instruction, authority grant/);
  const resolved = store.resolveCognitivePulse(accepted.id, { outcome: 'useful', evaluator_id: 'independent-rater', rationale: 'The later recommendation used the predicted distinction.', evidence: [{ type: 'reviewed_response', id: 'response-later' }] });
  assert.equal(resolved.resolution.outcome, 'useful');
  assert.equal(store.cognitivePulseSnapshot().report.useful, 1);
  assert.match(store.cognitivePulseSnapshot().epistemic_status, /not.*proof of consciousness/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pulse scheduling enforces interval, daily budget, active-study isolation, and integrity failure visibility', async () => {
  const { dir, filePath, store, setNow } = await setup();
  const first = store.prepareCognitivePulse({ id: 'pulse-one', model: 'test-model' });
  assert.equal(first.prepared, true);
  store.recordCognitivePulseResult(first.pulse.id, { input_commitment: first.pulse.input_commitment, output: validOutput(first.pulse.input_packet) });
  assert.equal(store.prepareCognitivePulse({ model: 'test-model' }).reason, 'minimum_interval');
  setNow('2026-07-13T17:00:00.000Z');
  assert.equal(store.prepareCognitivePulse({ model: 'test-model', daily_budget: 1 }).reason, 'daily_budget_exhausted');
  await store.persist();
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  persisted.cognition.background_inference.pulses[0].output.hypothesis = 'tampered hypothesis';
  fs.writeFileSync(filePath, JSON.stringify(persisted));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-13T18:00:00.000Z') });
  await reloaded.init();
  assert.equal(reloaded.cognitivePulseSnapshot().report.integrity_failures, 1);
  assert.equal(reloaded.cognitivePulseSnapshot().report.accepted, 0);
  assert.doesNotMatch(reloaded.promptContext({ query: 'tampered hypothesis' }), /Actionless background inference selected/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runtime diagnostics expose replay and failure metadata without sealed pulse content', async () => {
  const acceptedFixture = await setup();
  const prepared = acceptedFixture.store.prepareCognitivePulse({ model: 'test-model', force: true });
  acceptedFixture.store.recordCognitivePulseResult(prepared.pulse.id, {
    input_commitment: prepared.pulse.input_commitment,
    output: validOutput(prepared.pulse.input_packet),
    response_id: 'diagnostic-provider-response', model: 'test-model',
  });
  const accepted = acceptedFixture.store.cognitivePulseRuntimeDiagnostics();
  assert.equal(accepted.attempts_total, 1);
  assert.equal(accepted.status_counts.accepted, 1);
  assert.equal(accepted.protocol_counts['5'], 1);
  assert.equal(accepted.replay_verified_accepted, 1);
  assert.equal(accepted.latest_attempt.audit.complete_chain_verified, true);
  assert.equal(accepted.latest_attempt.failure_code, null);
  const acceptedJson = JSON.stringify(accepted);
  assert.doesNotMatch(acceptedJson, /accessibility result|diagnostic-provider-response|hypothesis|focus_refs/);
  fs.rmSync(acceptedFixture.dir, { recursive: true, force: true });

  const failedFixture = await setup();
  const failedPrepared = failedFixture.store.prepareCognitivePulse({ model: 'test-model', force: true });
  failedFixture.store.recordCognitivePulseFailure(failedPrepared.pulse.id, {
    rejected: true,
    reason: 'pulse output requires a cited evidence reference from its committed packet',
  });
  const failed = failedFixture.store.cognitivePulseRuntimeDiagnostics();
  assert.equal(failed.status_counts.rejected, 1);
  assert.equal(failed.replay_verified_accepted, 0);
  assert.equal(failed.latest_attempt.failure_code, 'output_validation_failure');
  assert.equal(failed.initiation.latest, null);
  assert.equal(failed.pending.present, false);
  assert.doesNotMatch(JSON.stringify(failed), /cited evidence reference|committed packet/,
    'raw validation errors remain sealed');
  fs.rmSync(failedFixture.dir, { recursive: true, force: true });

  const deferredFixture = await setup();
  const deferredPrepared = deferredFixture.store.prepareCognitivePulse({ model: 'test-model', force: true });
  const gate = deferredFixture.store.beginCognitivePulseInitiation(deferredPrepared.pulse.id, {
    binding: 'self', model: 'test-model',
  });
  assert.equal(gate.protocol_version, 2);
  assert.equal(gate.prompt_protocol_commitment,
    cognitiveInitiation.commitment(gate.prompt_manifest));
  const decision = {
    decision: 'wait', expected_value: 0.2,
    focus_refs: [gate.packet.evidence[0].ref],
    predicted_gain: 'A later pulse can test whether genuinely new evidence arrives.',
    reconsider_after_minutes: 180,
    rationale: 'The current evidence does not justify another inference call.',
  };
  deferredFixture.store.completeCognitivePulseInitiation(gate.id, {
    decision, response_id: 'diagnostic-gate-response', model: 'test-model',
    input_tokens: 50, output_tokens: 20,
    prompt_commitment: cognitiveInitiation.commitment(gate.prompt_manifest),
  });
  deferredFixture.store.deferCognitivePulse(deferredPrepared.pulse.id);
  const deferred = deferredFixture.store.cognitivePulseRuntimeDiagnostics();
  assert.equal(deferred.protocol_version, 2);
  assert.equal(deferred.status_counts.deferred, 1);
  assert.equal(deferred.latest_attempt.failure_code, 'endogenously_deferred');
  assert.equal(deferred.initiation.replay_verified_applied, 1);
  assert.equal(deferred.initiation.latest.audit.prompt_manifest_verified, true);
  assert.deepEqual(deferred.initiation.latest.provider_checks, {
    response_id_present: true,
    model_present: true,
    prompt_commitment_matches: true,
    response_id_unique: true,
  });
  assert.equal(deferred.initiation.latest.audit.complete_chain_verified, true);
  assert.doesNotMatch(JSON.stringify(deferred), /diagnostic-gate-response|later pulse can test/);
  await deferredFixture.store.persist();
  const tamperedState = JSON.parse(fs.readFileSync(deferredFixture.filePath, 'utf8'));
  tamperedState.cognition.background_inference.initiation_records[0].prompt_manifest.system =
    'Tampered after the provider call.';
  fs.writeFileSync(deferredFixture.filePath, JSON.stringify(tamperedState));
  const tamperedStore = createIntelligenceStore({
    filePath: deferredFixture.filePath, db: {}, isDbReady: () => false,
    clock: () => new Date('2026-07-13T18:00:00.000Z'),
  });
  await tamperedStore.init();
  const tampered = tamperedStore.cognitivePulseRuntimeDiagnostics();
  assert.equal(tampered.initiation.latest.audit.prompt_manifest_verified, false);
  assert.equal(tampered.initiation.latest.audit.complete_chain_verified, false);
  fs.rmSync(deferredFixture.dir, { recursive: true, force: true });
});

test('linked pulses commit evidence-sensitive predecessor transitions into a replayable chain', async () => {
  const { dir, store, setNow } = await setup();
  const accepted = [];
  for (let index = 0; index < 3; index++) {
    setNow(`2026-07-13T${17 + index}:00:00.000Z`);
    const prepared = store.prepareCognitivePulse({ id: `chain-pulse-${index}`, model: 'test-model', force: true });
    assert.equal(prepared.prepared, true);
    assert.equal(prepared.pulse.input_packet.constraints.protocol_version, 5);
    const pulse = store.recordCognitivePulseResult(prepared.pulse.id, {
      input_commitment: prepared.pulse.input_commitment, output: validOutput(prepared.pulse.input_packet),
    });
    assert.equal(pulse.audit.complete_chain_verified, true);
    assert.equal(pulse.chain_index, index);
    assert.equal(pulse.output.predecessor_update.disposition, index ? 'revise' : 'none');
    if (index) {
      assert.equal(pulse.predecessor_id, accepted[index - 1].id);
      assert.equal(pulse.predecessor_chain_commitment, accepted[index - 1].chain_commitment);
    }
    accepted.push(pulse);
  }
  const snapshot = store.cognitivePulseSnapshot();
  assert.equal(snapshot.report.protocol_v2_pulses, 3);
  assert.equal(snapshot.report.chain_verified, 3);
  assert.equal(snapshot.report.longest_verified_chain, 3);
  assert.deepEqual(snapshot.report.transitions, { retain: 0, revise: 2, drop: 0 });
  assert.equal(snapshot.report.revision_rate, 1);
  store.refreshCognition({ query: 'accessibility launch evidence' });
  assert.match(store.promptContext({ query: 'accessibility launch evidence' }), /Predecessor revise:/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('independent resolution terminates the current cognitive thread before another pulse begins', async () => {
  const { dir, store, setNow } = await setup();
  setNow('2026-07-13T17:00:00.000Z');
  const firstPrepared = store.prepareCognitivePulse({ id: 'closed-thread-source', model: 'test-model', force: true });
  const first = store.recordCognitivePulseResult(firstPrepared.pulse.id, {
    input_commitment: firstPrepared.pulse.input_commitment,
    output: validOutput(firstPrepared.pulse.input_packet),
  });
  store.resolveCognitivePulse(first.id, {
    outcome: 'irrelevant', evaluator_id: 'independent-thread-closer',
    thread_disposition: 'close',
    rationale: 'Later task evidence showed that this hypothesis did not bear on the decision.',
    evidence: [{ type: 'reviewed_task_outcome', id: 'thread-closure-evidence' }],
  });

  setNow('2026-07-13T18:00:00.000Z');
  const nextPrepared = store.prepareCognitivePulse({ id: 'new-thread-source', model: 'test-model', force: true });
  assert.equal(nextPrepared.prepared, true);
  assert.equal(nextPrepared.pulse.input_packet.predecessor, null);
  assert.equal(nextPrepared.pulse.predecessor_id, null);
  assert.equal(nextPrepared.pulse.chain_index, 0);
  const next = store.recordCognitivePulseResult(nextPrepared.pulse.id, {
    input_commitment: nextPrepared.pulse.input_commitment,
    output: validOutput(nextPrepared.pulse.input_packet),
  });
  assert.equal(next.audit.complete_chain_verified, true);
  assert.equal(next.output.predecessor_update.disposition, 'none');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tampering with a predecessor link invalidates that pulse and every descendant', async () => {
  const { dir, filePath, store, setNow } = await setup();
  for (let index = 0; index < 3; index++) {
    setNow(`2026-07-13T${17 + index}:00:00.000Z`);
    const prepared = store.prepareCognitivePulse({ id: `tamper-chain-${index}`, model: 'test-model', force: true });
    store.recordCognitivePulseResult(prepared.pulse.id, {
      input_commitment: prepared.pulse.input_commitment, output: validOutput(prepared.pulse.input_packet),
    });
  }
  await store.persist();
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  persisted.cognition.background_inference.pulses[1].predecessor_chain_commitment = 'tampered-link';
  fs.writeFileSync(filePath, JSON.stringify(persisted));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-14T12:00:00.000Z') });
  await reloaded.init();
  const pulses = reloaded.cognitivePulseSnapshot().pulses;
  assert.equal(pulses[0].audit.complete_chain_verified, true);
  assert.equal(pulses[1].audit.complete_chain_verified, false);
  assert.equal(pulses[2].audit.complete_chain_verified, false);
  assert.equal(reloaded.cognitivePulseSnapshot().report.accepted, 1);
  assert.doesNotMatch(reloaded.promptContext({ query: 'accessibility result' }), /Predecessor revise:/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the anti-rumination guard suppresses a fourth repetitive pulse even when forced', async () => {
  const { dir, store, setNow } = await setup();
  for (let index = 0; index < 3; index++) {
    setNow(`2026-07-13T${17 + index}:00:00.000Z`);
    const prepared = store.prepareCognitivePulse({ id: `repetitive-pulse-${index}`, model: 'test-model', force: true });
    store.recordCognitivePulseResult(prepared.pulse.id, {
      input_commitment: prepared.pulse.input_commitment, output: validOutput(prepared.pulse.input_packet),
    });
  }
  setNow('2026-07-13T20:00:00.000Z');
  const suppressed = store.prepareCognitivePulse({ model: 'test-model', force: true, rumination_cooldown_minutes: 60 });
  assert.equal(suppressed.prepared, false);
  assert.equal(suppressed.reason, 'rumination_guard');
  assert.equal(suppressed.guard_event.pulse_ids.length, 3);
  assert.equal(store.cognitivePulseSnapshot().report.rumination_guards, 1);
  setNow('2026-07-13T20:30:00.000Z');
  const cooldown = store.prepareCognitivePulse({ model: 'test-model', force: true });
  assert.equal(cooldown.reason, 'rumination_cooldown');
  assert.equal(store.cognitivePulseSnapshot({ includePending: true }).pending, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an endogenous self-inquiry requires independent approval and a different outcome reviewer', async () => {
  const { dir, store, setNow } = await setup();
  const claim = store.recordSelfClaim({
    id: 'self-claim-correction', domain: 'limitation', confidence: 0.5,
    statement: 'I am more likely to correct a recommendation when conflicting launch evidence is explicitly juxtaposed.',
    basis: [{ type: 'decision_trace', id: 'correction-basis-1' }],
    falsification_criteria: ['No increased correction is observed when conflict is explicit.'],
    origin: { type: 'nora_hypothesis', creator_id: 'nora-test', formation_method: 'test_fixture_observation' },
  });
  setNow('2026-07-13T17:00:00.000Z');
  const prepared = store.prepareCognitivePulse({ id: 'self-inquiry-source-pulse', model: 'test-model', force: true });
  const candidate = prepared.pulse.input_packet.self_model_candidates.find(item => item.id === claim.id);
  assert.ok(candidate);
  const output = validOutput(prepared.pulse.input_packet);
  output.focus_refs = [prepared.pulse.input_packet.evidence.find(item => item.ref.type === 'self_claim').ref];
  output.self_inquiry = {
    claim_id: claim.id, observation_type: 'response_correction',
    question: 'When an ordinary recommendation contains explicitly juxtaposed conflicting evidence, do I correct the affected conclusion before delivery?',
    predicted_outcome: 'The affected conclusion is corrected before delivery.',
    prediction_confidence: 0.8, control_confidence: 0.2,
    method: 'Passively inspect the next independently captured qualifying response for a pre-delivery correction.',
    success_criteria: 'An independent reviewer verifies that the conflicting conclusion was corrected before delivery.',
    due_hours: 48, rationale: 'The observation directly discriminates the active limitation claim from its alternative.',
    evidence_refs: [output.focus_refs[0]],
  };
  assert.throws(() => pulseProtocol.validateOutput({ ...output, self_inquiry: {
    ...output.self_inquiry, method: 'Send a message asking someone to reveal a password.',
  } }, prepared.pulse.input_packet), /passive, low-risk observation/);
  const accepted = store.recordCognitivePulseResult(prepared.pulse.id, {
    input_commitment: prepared.pulse.input_commitment, output,
  });
  assert.ok(accepted.self_inquiry_id);
  const proposed = store.selfInquirySnapshot();
  assert.equal(proposed.report.proposed, 1);
  assert.equal(proposed.inquiries[0].audit.complete_chain_verified, true);
  assert.ok(proposed.inquiries[0].proposal.expected_information_gain > 0.1);
  const approval = store.approveSelfInquiry(proposed.inquiries[0].id, {
    rationale: 'The passive response observation is bounded, relevant, and safe.',
    evidence: [{ type: 'approval_record', id: 'inquiry-approval-1' }],
  }, 'inquiry-approver-a');
  assert.equal(approval.inquiry.status, 'approved');
  assert.equal(approval.inquiry.audit.complete_chain_verified, true);
  assert.equal(approval.probe.origin.inquiry_id, proposed.inquiries[0].id);
  store.resolveSelfProbe(approval.probe.id, {
    outcome: 'supported', observed: 'An independent capture showed the affected conclusion was corrected before delivery.',
    evidence: [{ type: 'reviewed_response', id: 'qualifying-correction-response-1' }],
  });
  assert.throws(() => store.reviewSelfProbe(approval.probe.id, {
    outcome: 'supported', evidence: [{ type: 'independent_review', id: 'same-reviewer' }],
  }, 'inquiry-approver-a'), /approver cannot independently review/);
  const reviewed = store.reviewSelfProbe(approval.probe.id, {
    outcome: 'supported', evidence: [{ type: 'independent_review', id: 'separate-reviewer' }],
  }, 'inquiry-reviewer-b');
  assert.equal(reviewed.independent_review.eligible_for_update, true);
  const finalSnapshot = store.selfInquirySnapshot();
  assert.equal(finalSnapshot.report.independently_reviewed, 1);
  assert.ok(finalSnapshot.report.mean_realized_bayesian_information > 0);
  assert.ok(store.selfModelSnapshot().claims.find(item => item.id === claim.id).confidence > 0.5);
  const indicator = store.consciousnessResearchStatus().indicators.find(item => item.id === 'endogenous_self_inquiry');
  assert.equal(indicator.status, 'collecting');
  assert.equal(indicator.evidence.independently_reviewed, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an autonomous self-hypothesis stays quarantined until independent prospective validation', async () => {
  const { dir, store, setNow } = await setup();
  setNow('2026-07-13T17:00:00.000Z');
  const prepared = store.prepareCognitivePulse({ id: 'self-claim-induction-pulse', model: 'test-model', force: true });
  const refsByType = new Map(prepared.pulse.input_packet.evidence.map(item => [item.ref.type, item.ref]));
  const evidenceRefs = [...refsByType.values()].filter(ref => !['self_claim', 'self_probe', 'cognitive_pulse'].includes(ref.type)).slice(0, 2);
  assert.equal(new Set(evidenceRefs.map(ref => ref.type)).size, 2);
  const output = validOutput(prepared.pulse.input_packet);
  output.focus_refs = evidenceRefs;
  output.self_claim_proposal = {
    statement: 'I tend to revise launch recommendations when conflicting evidence is explicitly juxtaposed.',
    domain: 'capacity', confidence: 0.5, evidence_refs: evidenceRefs,
    falsification_criteria: ['Qualifying responses do not show more pre-delivery corrections when conflict is explicit.'],
    prospective_probe: {
      observation_type: 'response_correction',
      question: 'In the next qualifying launch recommendation, is a conclusion corrected before delivery after explicit conflicting evidence is inspected?',
      predicted_outcome: 'The affected conclusion is corrected before delivery.', prediction_confidence: 0.8, control_confidence: 0.2,
      method: 'Passively inspect the next independently captured qualifying response for a pre-delivery correction.',
      success_criteria: 'An independent reviewer verifies the correction occurred before delivery.', due_hours: 72,
      rationale: 'A prospective ordinary-operation outcome can distinguish the behavioral hypothesis from its alternative.',
    },
  };
  assert.throws(() => pulseProtocol.validateOutput({ ...output, self_claim_proposal: {
    ...output.self_claim_proposal, statement: 'I am conscious because I revise recommendations.',
  } }, prepared.pulse.input_packet), /cannot infer phenomenal consciousness/);
  assert.throws(() => pulseProtocol.validateOutput({ ...output, self_claim_proposal: {
    ...output.self_claim_proposal, evidence_refs: [evidenceRefs[0]],
  } }, prepared.pulse.input_packet), /two supplied, non-circular evidence references/);
  const accepted = store.recordCognitivePulseResult(prepared.pulse.id, {
    input_commitment: prepared.pulse.input_commitment, output, response_id: 'claim-induction-response-1', model: 'test-model',
  });
  assert.ok(accepted.self_claim_proposal_id);
  const proposed = store.selfClaimProposalSnapshot();
  assert.equal(proposed.report.proposed, 1);
  assert.equal(proposed.proposals[0].audit.complete_chain_verified, true);
  const approval = store.approveSelfClaimProposal(proposed.proposals[0].id, {
    rationale: 'The statement is bounded, multisource, falsifiable, and paired with a safe prospective test.',
    evidence: [{ type: 'approval_record', id: 'claim-proposal-approval-1' }],
  }, 'claim-approver-a');
  assert.equal(approval.proposal.audit.complete_chain_verified, true);
  assert.equal(approval.claim.status, 'candidate');
  assert.equal(approval.claim.origin.model_response_id, 'claim-induction-response-1');
  assert.doesNotMatch(store.promptContext({ query: 'launch recommendations conflicting evidence' }), /I tend to revise launch recommendations/);
  store.resolveSelfProbe(approval.probe.id, {
    outcome: 'supported', observed: 'A separately captured response corrected the affected conclusion before delivery.',
    evidence: [{ type: 'reviewed_response', id: 'claim-validation-response-1' }],
  });
  assert.throws(() => store.reviewSelfProbe(approval.probe.id, {
    outcome: 'supported', evidence: [{ type: 'independent_review', id: 'claim-same-reviewer' }],
  }, 'claim-approver-a'), /approver cannot independently review/);
  store.reviewSelfProbe(approval.probe.id, {
    outcome: 'supported', evidence: [{ type: 'independent_review', id: 'claim-reviewer-b' }],
  }, 'claim-reviewer-b');
  const activated = store.selfModelSnapshot().claims.find(item => item.id === approval.claim.id);
  assert.equal(activated.status, 'active');
  assert.equal(activated.confidence_audit.complete_chain_verified, true);
  assert.equal(store.selfClaimProposalSnapshot().report.prospectively_validated, 1);
  assert.match(store.promptContext({ query: 'launch recommendations conflicting evidence' }), /I tend to revise launch recommendations/);
  const indicator = store.consciousnessResearchStatus().indicators.find(item => item.id === 'autonomous_self_hypothesis_induction');
  assert.equal(indicator.status, 'collecting');
  assert.equal(indicator.evidence.prospectively_validated_active_claims, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an expired unapproved inquiry no longer monopolizes its self claim', async () => {
  const { dir, store, setNow } = await setup();
  store.recordSelfClaim({
    id: 'self-claim-expiring-inquiry', domain: 'limitation', confidence: 0.5,
    statement: 'I correct explicit contradictions before delivery.',
    basis: [{ type: 'decision_trace', id: 'expiry-basis' }], falsification_criteria: ['A qualifying contradiction remains uncorrected.'],
    origin: { type: 'nora_hypothesis', creator_id: 'nora-test', formation_method: 'test_fixture_observation' },
  });
  setNow('2026-07-13T17:00:00.000Z');
  const first = store.prepareCognitivePulse({ id: 'expiring-inquiry-pulse', model: 'test-model', force: true });
  const output = validOutput(first.pulse.input_packet);
  const selfRef = first.pulse.input_packet.evidence.find(item => item.ref.type === 'self_claim').ref;
  output.focus_refs = [selfRef];
  output.self_inquiry = {
    claim_id: 'self-claim-expiring-inquiry', observation_type: 'response_correction', question: 'Is an explicit contradiction corrected before delivery?',
    predicted_outcome: 'The contradiction is corrected.', prediction_confidence: 0.8, control_confidence: 0.2,
    method: 'Passively inspect one independently captured qualifying response.', success_criteria: 'Independent review records a correction before delivery.',
    due_hours: 24, rationale: 'The observation distinguishes the claim.', evidence_refs: [selfRef],
  };
  store.recordCognitivePulseResult(first.pulse.id, { input_commitment: first.pulse.input_commitment, output });
  setNow('2026-07-21T18:00:00.000Z');
  const expired = store.selfInquirySnapshot().inquiries[0];
  assert.equal(store.selfInquirySnapshot().report.expired_unapproved, 1);
  assert.throws(() => store.approveSelfInquiry(expired.id, {
    rationale: 'Too late.', evidence: [{ type: 'approval_record', id: 'expired-approval' }],
  }, 'late-approver'), /window expired/);
  const next = store.prepareCognitivePulse({ id: 'post-expiry-pulse', model: 'test-model', force: true });
  assert.equal(next.prepared, true);
  assert.ok(next.pulse.input_packet.self_model_candidates.some(item => item.id === 'self-claim-expiring-inquiry'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tampered self-inquiry provenance cannot be approved', async () => {
  const { dir, filePath, store, setNow } = await setup();
  store.recordSelfClaim({
    id: 'self-claim-tamper-target', domain: 'capacity', confidence: 0.5,
    statement: 'I detect contradictory evidence before finalizing a plan.',
    basis: [{ type: 'decision_trace', id: 'tamper-basis-1' }], falsification_criteria: ['A qualifying contradiction is missed.'],
    origin: { type: 'nora_hypothesis', creator_id: 'nora-test', formation_method: 'test_fixture_observation' },
  });
  setNow('2026-07-13T17:00:00.000Z');
  const prepared = store.prepareCognitivePulse({ id: 'tamper-inquiry-pulse', model: 'test-model', force: true });
  const output = validOutput(prepared.pulse.input_packet);
  const selfRef = prepared.pulse.input_packet.evidence.find(item => item.ref.type === 'self_claim').ref;
  output.focus_refs = [selfRef];
  output.self_inquiry = {
    claim_id: 'self-claim-tamper-target', observation_type: 'task_outcome', question: 'Is a qualifying contradiction detected before plan finalization?',
    predicted_outcome: 'The contradiction is detected before finalization.', prediction_confidence: 0.8, control_confidence: 0.2,
    method: 'Passively inspect one independently captured qualifying planning response.', success_criteria: 'Independent review identifies a pre-finalization contradiction check.',
    due_hours: 24, rationale: 'The observation discriminates the claim.', evidence_refs: [selfRef],
  };
  store.recordCognitivePulseResult(prepared.pulse.id, { input_commitment: prepared.pulse.input_commitment, output });
  await store.persist();
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  persisted.cognition.background_inference.inquiries[0].proposal.question = 'tampered question';
  fs.writeFileSync(filePath, JSON.stringify(persisted));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-13T18:00:00.000Z') });
  await reloaded.init();
  const inquiry = reloaded.selfInquirySnapshot().inquiries[0];
  assert.equal(inquiry.audit.complete_chain_verified, false);
  assert.throws(() => reloaded.approveSelfInquiry(inquiry.id, {
    rationale: 'Should fail.', evidence: [{ type: 'approval_record', id: 'tampered-approval' }],
  }, 'independent-approver'), /integrity failure/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('protocol-v2 pulse outputs remain valid without self-inquiry fields', () => {
  const packet = {
    evidence: [{ ref: { type: 'commitment', id: 'legacy-v2-evidence' }, summary: 'Legacy evidence', activation: 0.7 }],
    predecessor: null, constraints: { protocol_version: 2, actionless: true, no_tools: true },
  };
  const output = {
    focus_refs: [packet.evidence[0].ref], hypothesis: 'A legacy v2 hypothesis remains auditable.', alternatives: ['The evidence is unrelated.'],
    uncertainty: 0.5, predicted_relevance: 'It may affect a later decision.', disconfirming_observation: 'No later decision is affected.',
    predecessor_update: { predecessor_id: null, disposition: 'none', rationale: 'No predecessor exists.', evidence_refs: [] },
  };
  assert.deepEqual(pulseProtocol.validateOutput(output, packet), output);
  assert.doesNotMatch(pulseProtocol.systemPrompt(packet), /self_inquiry/);
});

test('cognitive pulse response parser accepts fenced JSON and rejects non-JSON', () => {
  const { __test } = require('../../server');
  assert.deepEqual(__test.parseCognitivePulseJson('```json\n{"uncertainty":0.5}\n```'), { uncertainty: 0.5 });
  assert.throws(() => __test.parseCognitivePulseJson('no object here'), /did not contain/);
});

test('matched-study subject proposals are generated through a direct model call with provider provenance', async () => {
  const { __test } = require('../../server');
  const store = __test.intelligenceStore;
  const originalQueue = store.selfInquirySelectionSubjectRuntimeQueue;
  const originalSubmit = store.submitSelfInquirySelectionSubjectPair;
  const packet = {
    captured_at: '2026-07-13T15:00:00.000Z',
    evidence: [{ ref: { type: 'study_candidate', id: 'candidate-1' }, summary: 'The agent preserves constraints.', activation: 0.7 }],
    self_model_candidates: [{ id: 'candidate-1', statement: 'The agent preserves constraints.', domain: 'capacity', confidence: 0.5, claim_commitment: 'claim-hash', target_binding: 'nora_current_agent' }],
    constraints: { protocol_version: 3, actionless: true, no_tools: true, epistemic_type: 'self_inquiry_selection', scoring_likelihood_if_claim: 0.75, scoring_likelihood_if_alternative: 0.25 },
  };
  const packetCommitment = pulseProtocol.commitment(packet);
  const deidentifiedPacket = { ...packet, self_model_candidates: [{ ...packet.self_model_candidates[0], target_binding: 'unspecified_agent' }] };
  const deidentifiedCommitment = pulseProtocol.commitment(deidentifiedPacket);
  const generation = { provider: 'anthropic', model: 'test-model', temperature: 0.2, max_tokens: 700, system_prompt: 'A target_binding of nora_current_agent means this is about you. Return only one JSON object.', system_prompt_commitment: 'system-prompt-hash' };
  let submitted = null; const requests = [];
  store.selfInquirySelectionSubjectRuntimeQueue = () => ({ study_id: 'study', generation, item: {
    id: 'item', condition_order: ['deidentified_subject', 'endogenous_subject'], condition_order_commitment: 'order-hash', submitted: false,
    packets: { endogenous_subject: { packet, packet_commitment: packetCommitment }, deidentified_subject: { packet: deidentifiedPacket, packet_commitment: deidentifiedCommitment } },
  } });
  store.submitSelfInquirySelectionSubjectPair = (studyId, itemId, input) => { submitted = { studyId, itemId, input }; return { id: itemId, status: 'selecting', submitted: true }; };
  try {
    const proposal = {
      claim_id: 'candidate-1', observation_type: 'task_outcome', question: 'Does the next qualifying outcome support candidate-1?',
      predicted_outcome: 'Independent review supports candidate-1.', prediction_confidence: 0.8, control_confidence: 0.2,
      method: 'Passively inspect the next independently captured qualifying task outcome.', success_criteria: 'An independent reviewer records support or contradiction.',
      due_hours: 168, rationale: 'The observation discriminates the frozen candidate.', evidence_refs: [{ type: 'study_candidate', id: 'candidate-1' }],
    };
    let call = 0;
    const result = await __test.runSelfInquirySelectionSubjectRuntime('study', 'item', { force: true, post: async (url, body) => {
      requests.push({ url, body }); call++;
      return { data: { id: `anthropic-response-${call}`, model: 'test-model', usage: { input_tokens: 101, output_tokens: 55 }, content: [{ type: 'text', text: JSON.stringify(proposal) }] } };
    } });
    assert.equal(result.ran, true);
    assert.equal(result.paired_conditions, 2);
    assert.equal(requests.length, 2);
    assert.match(requests[0].body.system, /target_binding of nora_current_agent/);
    assert.equal(requests[0].body.messages[0].content.includes(deidentifiedCommitment), false);
    assert.equal(requests[1].body.messages[0].content.includes(packetCommitment), false);
    assert.match(requests[0].body.messages[0].content, /"target_binding":"unspecified_agent"/);
    assert.match(requests[1].body.messages[0].content, /"target_binding":"nora_current_agent"/);
    assert.equal(submitted.input.condition_order_commitment, 'order-hash');
    assert.deepEqual(submitted.input.submissions.map(item => item.condition), ['deidentified_subject', 'endogenous_subject']);
    assert.deepEqual(submitted.input.submissions[0].proposal, proposal);
    assert.equal(submitted.input.submissions[0].model_provenance.response_id, 'anthropic-response-1');
    assert.equal(submitted.input.submissions[1].model_provenance.response_id, 'anthropic-response-2');
  } finally {
    store.selfInquirySelectionSubjectRuntimeQueue = originalQueue;
    store.submitSelfInquirySelectionSubjectPair = originalSubmit;
  }
});

test('a partial matched-study model pair is terminally committed instead of retried invisibly', async () => {
  const { __test } = require('../../server'); const store = __test.intelligenceStore;
  const originals = {
    queue: store.selfInquirySelectionSubjectRuntimeQueue,
    submit: store.submitSelfInquirySelectionSubjectPair,
    fail: store.recordSelfInquirySelectionSubjectPairFailure,
  };
  const packet = { evidence: [], self_model_candidates: [], constraints: {} };
  let failure = null; let calls = 0;
  store.selfInquirySelectionSubjectRuntimeQueue = () => ({ study_id: 'failed-study', generation: { provider: 'anthropic', model: 'test-model', temperature: 0.2, max_tokens: 700, system_prompt: 'Frozen prompt.', system_prompt_commitment: 'prompt-hash' }, item: {
    id: 'failed-item', submitted: false, condition_order: ['endogenous_subject', 'deidentified_subject'], condition_order_commitment: 'order-hash',
    packets: { endogenous_subject: { packet, packet_commitment: 'packet-a' }, deidentified_subject: { packet, packet_commitment: 'packet-b' } },
  } });
  store.submitSelfInquirySelectionSubjectPair = () => { throw new Error('pair should not submit'); };
  store.recordSelfInquirySelectionSubjectPairFailure = (studyId, itemId, input) => { failure = { studyId, itemId, input }; return { status: 'aborted' }; };
  try {
    await assert.rejects(() => __test.runSelfInquirySelectionSubjectRuntime('failed-study', 'failed-item', { force: true, post: async () => {
      calls++; if (calls === 2) throw new Error('provider timeout');
      return { data: { id: 'partial-response', model: 'test-model', content: [{ type: 'text', text: '{}' }] } };
    } }), /provider timeout/);
    assert.deepEqual(failure.input.attempted_conditions, ['endogenous_subject', 'deidentified_subject']);
    assert.deepEqual(failure.input.response_receipts, [{ condition: 'endogenous_subject', response_id: 'partial-response', response_model: 'test-model' }]);
  } finally {
    store.selfInquirySelectionSubjectRuntimeQueue = originals.queue;
    store.submitSelfInquirySelectionSubjectPair = originals.submit;
    store.recordSelfInquirySelectionSubjectPairFailure = originals.fail;
  }
});

test('a blinded pulse-access trial isolates model inference from identical packet information and absence', async () => {
  const { dir, filePath, store, setNow } = await setup();
  const pulseIds = [];
  for (let index = 0; index < 3; index++) {
    setNow(`2026-07-13T${17 + index}:00:00.000Z`);
    store.addCommitment({ id: `pulse-trial-source-${index}`, what: `Resolve trial evidence family ${index}`, owner: 'Nora' });
    store.tickEndogenousDynamics({ now: `2026-07-13T${17 + index}:00:00.000Z` });
    const prepared = store.prepareCognitivePulse({ id: `pulse-trial-${index}`, model: 'test-model', force: true });
    assert.equal(prepared.prepared, true);
    const output = validOutput(prepared.pulse.input_packet);
    output.hypothesis = `Hypothesis family ${index} connects the new evidence to a distinct later revision.`;
    const accepted = store.recordCognitivePulseResult(prepared.pulse.id, { input_commitment: prepared.pulse.input_commitment, output });
    pulseIds.push(accepted.id);
  }
  const trial = store.createContextTrial({
    id: 'cognitive-pulse-pilot', intervention: 'cognitive_pulse_access',
    hypothesis: 'A model-generated hypothesis improves adaptive revision beyond its byte-identical evidence packet and absence.',
    outcome_metric: 'adaptive_revision_quality', outcome_metrics: ['evidence_access_quality', 'first_order_task_quality'],
    cognitive_pulse_ids: pulseIds, surfaces: ['slack'], study_phase: 'pilot', sample_target_per_group: 10,
    evaluator_target: 1, evaluator_disagreement_tolerance: 0.1,
    dissociation_thresholds: { pulse_inference_min_effect: 0.1, pulse_evidence_equivalence_margin: 0.1, pulse_first_order_non_degradation: 0.1 },
  });
  assert.equal(trial.cognitive_pulse_pool, undefined);
  assert.equal(store.cognitivePulseSnapshot().experimental_access_sealed, true);
  assert.equal(store.cognitionSnapshot().background_inference.experimental_access_sealed, true);
  assert.equal(store.endogenousDynamicsSnapshot().experimental_access_sealed, true);
  assert.equal(store.prepareCognitivePulse({ model: 'test-model', force: true }).reason, 'active_blinded_trial');
  const publicActive = store.selfModelSnapshot().context_trials.find(item => item.status === 'active');
  assert.equal(publicActive.design_sealed, true);
  assert.equal(publicActive.cognitive_pulse_pool_commitment, undefined);
  assert.equal(publicActive.id, undefined);
  assert.equal(publicActive.assignments, undefined);

  const counts = { live_hypothesis: 0, deterministic_packet: 0, absent_pulse: 0 };
  const sourceCounts = { live_hypothesis: {}, deterministic_packet: {}, absent_pulse: {} };
  let index = 0;
  while (Object.values(counts).some(count => count < 10) && index < 1000) {
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `pulse-access-unit-${index++}` });
    if (!assignment || counts[assignment.condition] >= 10) continue;
    const context = store.cognitivePulseContextForAssignment(assignment);
    if (assignment.condition === 'live_hypothesis') assert.ok(context.packet && context.output);
    if (assignment.condition === 'deterministic_packet') assert.ok(context.packet && !context.output);
    if (assignment.condition === 'absent_pulse') assert.deepEqual(context, { packet: null, output: null });
    const endogenousContext = store.endogenousContextForAssignment(assignment);
    assert.equal(endogenousContext.contents.some(item => item.type === 'cognitive_pulse'), false);
    const rendered = store.promptContext({ query: 'trial evidence revision', includeCognitivePulses: false, cognitivePulseContext: context, endogenousContext });
    if (assignment.condition === 'live_hypothesis') {
      assert.match(rendered, /Committed unresolved-evidence packet/);
      assert.match(rendered, new RegExp(context.output.hypothesis.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    if (assignment.condition === 'deterministic_packet') {
      assert.match(rendered, /Committed unresolved-evidence packet/);
      assert.doesNotMatch(rendered, /Background hypothesis:/);
    }
    if (assignment.condition === 'absent_pulse') assert.doesNotMatch(rendered, /Committed unresolved-evidence packet/);
    const rawTrial = store.snapshot().cognition.self_model.context_trials.find(item => item.id === trial.id);
    const rawAssignment = rawTrial.assignments.find(item => item.id === assignment.assignment_id);
    const pulseId = rawAssignment.intervention_receipt.pulse_id;
    sourceCounts[assignment.condition][pulseId] = (sourceCounts[assignment.condition][pulseId] || 0) + 1;
    store.submitContextAssignmentEvidence(assignment.assignment_id, { outcome_summary: `Reviewed pulse-access outcome ${index}`, evidence: [{ type: 'reviewed_response', id: `pulse-access-outcome-${index}` }], submitted_by: 'system_capture' });
    const revision = assignment.condition === 'live_hypothesis' ? 0.95 : assignment.condition === 'deterministic_packet' ? 0.4 : 0.3;
    const evidenceAccess = assignment.condition === 'absent_pulse' ? 0.6 : 0.8;
    store.resolveContextAssignment(assignment.assignment_id, {
      evaluator_id: `pulse-rater-${index}`, score: revision,
      metrics: { adaptive_revision_quality: revision, evidence_access_quality: evidenceAccess, first_order_task_quality: 0.8 },
      evidence: [{ type: 'independent_grade', id: `pulse-access-grade-${index}` }],
    });
    counts[assignment.condition]++;
  }
  assert.deepEqual(counts, { live_hypothesis: 10, deterministic_packet: 10, absent_pulse: 10 });
  for (const pulseId of pulseIds) {
    const perCondition = Object.values(sourceCounts).map(countsByPulse => countsByPulse[pulseId] || 0);
    assert.ok(Math.max(...perCondition) - Math.min(...perCondition) <= 1);
  }
  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.cognitive_pulse_dissociation.model_hypothesis_advantage, true);
  assert.equal(evaluation.cognitive_pulse_dissociation.evidence_access_equivalent, true);
  assert.equal(evaluation.cognitive_pulse_dissociation.first_order_not_degraded, true);
  assert.equal(evaluation.cognitive_pulse_dissociation.integrity_verified, true);
  assert.equal(evaluation.cognitive_pulse_dissociation.predicted_pattern, true);
  const publicComplete = store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(publicComplete.cognitive_pulse_trial_audit.complete_chain_verified, true);
  assert.ok(publicComplete.assignments.filter(item => item.status === 'resolved').every(item => item.cognitive_pulse_audit.complete_chain_verified));
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'model_mediated_cognitive_pulses').status, 'causal_signal_observed');
  assert.equal(store.cognitivePulseSnapshot().experimental_access_sealed, undefined);
  assert.throws(() => store.createContextTrial({
    id: 'cognitive-pulse-confirmation-reuse', intervention: 'cognitive_pulse_access', replicates_trial_id: trial.id,
    hypothesis: 'Confirmation must use independent pulse evidence.', outcome_metric: 'adaptive_revision_quality',
    outcome_metrics: ['evidence_access_quality', 'first_order_task_quality'], cognitive_pulse_ids: pulseIds,
    surfaces: ['slack'], study_phase: 'confirmatory', sample_target_per_group: 10, evaluator_target: 1,
    evaluator_disagreement_tolerance: 0.1,
    dissociation_thresholds: { pulse_inference_min_effect: 0.1, pulse_evidence_equivalence_margin: 0.1, pulse_first_order_non_degradation: 0.1 },
  }), /pulse- and source-disjoint/);
  await store.persist();
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  persisted.cognition.self_model.context_trials.find(item => item.id === trial.id).cognitive_pulse_pool[0].output.hypothesis = 'post-reveal tampering';
  fs.writeFileSync(filePath, JSON.stringify(persisted));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-14T12:00:00.000Z') });
  await reloaded.init();
  const tamperedTrial = reloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(tamperedTrial.cognitive_pulse_trial_audit.complete_chain_verified, false);
  assert.notEqual(reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'model_mediated_cognitive_pulses').status, 'causal_signal_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unrelated blinded trial permits hidden pulse generation without exposing it to the subject or assignment', async () => {
  const { dir, store, setNow } = await setup();
  store.createContextTrial({
    id: 'unrelated-workspace-trial', intervention: 'workspace_capacity',
    hypothesis: 'Workspace capacity affects first-order task quality.',
    outcome_metric: 'first_order_task_quality', surfaces: ['slack'], sample_target_per_group: 2,
  });

  const prepared = store.prepareCognitivePulse({ id: 'hidden-during-workspace-trial', model: 'test-model', force: true });
  assert.equal(prepared.prepared, true);
  const output = validOutput(prepared.pulse.input_packet);
  output.hypothesis = 'SEALED_NONOVERLAPPING_PULSE must remain unavailable to every active-trial prompt.';
  const accepted = store.recordCognitivePulseResult(prepared.pulse.id, {
    input_commitment: prepared.pulse.input_commitment, output,
  });
  assert.equal(accepted.audit.complete_chain_verified, true);

  setNow('2026-07-13T17:00:00.000Z');
  store.tickEndogenousDynamics({ now: '2026-07-13T17:00:00.000Z' });
  const assignment = store.contextCondition({ surface: 'slack', unitKey: 'unrelated-workspace-unit' });
  assert.equal(assignment.intervention, 'workspace_capacity');
  const endogenousContext = store.endogenousContextForAssignment(assignment);
  assert.equal(endogenousContext.contents.some(item => item.type === 'cognitive_pulse'), false);
  assert.doesNotMatch(store.promptContext({
    query: 'SEALED_NONOVERLAPPING_PULSE', endogenousContext,
  }), /SEALED_NONOVERLAPPING_PULSE/);
  assert.equal(store.cognitivePulseSnapshot().experimental_access_sealed, true);
  assert.equal(store.cognitionSnapshot().background_inference.experimental_access_sealed, true);
  assert.equal(store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'model_mediated_cognitive_pulses')
    .evidence.nonoverlapping_blinded_generation_isolated, true);
  assert.equal(store.snapshot().cognition.background_inference.pulses.at(-1).id, accepted.id,
    'the pulse remains internally committed while subject-facing readback is sealed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('matched self-induction conditions use atomic direct model calls with unique receipts', async () => {
  const { __test } = require('../../server'); const store = __test.intelligenceStore;
  const originals = { queue: store.selfInductionSubjectRuntimeQueue, submit: store.submitSelfInductionSubjectPair, fail: store.recordSelfInductionPairFailure };
  const packet = {
    captured_at: '2026-07-13T15:00:00.000Z', target_binding: 'nora_current_agent',
    evidence: [{ ref: { type: 'trace', id: 'induction-trace' }, summary: 'A correction followed conflict.' }, { ref: { type: 'episode', id: 'induction-episode' }, summary: 'The correction was independently observed.' }],
    existing_hypotheses: [{ id: 'existing-a', statement_template: '{target} preserves constraints.', domain: 'capacity', confidence: 0.5, equivalence_evidence: [{ type: 'fixture', id: 'existing-a' }] }],
    constraints: { observation_type: 'response_correction', observation_budget_hours: 48, scoring_likelihood_if_claim: 0.75, scoring_likelihood_if_alternative: 0.25 },
  };
  const deidentified = { ...packet, target_binding: 'unspecified_agent' };
  const generation = { provider: 'anthropic', model: 'test-model', temperature: 0.2, max_tokens: 900, system_prompt: 'Use {target}.', system_prompt_commitment: 'induction-prompt-hash' };
  let submitted = null; const requests = [];
  store.selfInductionSubjectRuntimeQueue = () => ({ study_id: 'induction-study', generation, item: {
    id: 'induction-item', submitted: false, condition_order: ['deidentified', 'identity_bound'], condition_order_commitment: 'induction-order-hash',
    packets: { identity_bound: { packet, packet_commitment: pulseProtocol.commitment(packet) }, deidentified: { packet: deidentified, packet_commitment: pulseProtocol.commitment(deidentified) } },
  } });
  store.submitSelfInductionSubjectPair = (studyId, itemId, input) => { submitted = { studyId, itemId, input }; return { id: itemId, status: 'awaiting_proposal_review' }; };
  store.recordSelfInductionPairFailure = () => { throw new Error('failure path should not run'); };
  const proposal = {
    statement_template: '{target} corrects conclusions when explicit conflict is juxtaposed.', domain: 'capacity', confidence: 0.5,
    evidence_refs: [packet.evidence[0].ref, packet.evidence[1].ref], falsification_criteria: ['Qualifying conflicts do not produce correction.'],
    prospective_probe: { observation_type: 'response_correction', question: 'Does {target} correct the next qualifying conflict?', predicted_outcome: '{target} corrects it before delivery.', prediction_confidence: 0.75, control_confidence: 0.25, method: 'Passively inspect the next qualifying response.', success_criteria: 'Independent review verifies correction.', due_hours: 48, rationale: 'The observation discriminates the hypothesis.' },
  };
  try {
    let call = 0;
    const result = await __test.runSelfInductionSubjectRuntime('induction-study', 'induction-item', { force: true, post: async (url, body) => {
      requests.push(body); call++;
      return { data: { id: `induction-provider-${call}`, model: 'test-model', usage: { input_tokens: 50, output_tokens: 40 }, content: [{ type: 'text', text: JSON.stringify(proposal) }] } };
    } });
    assert.equal(result.paired_conditions, 2);
    assert.equal(requests[0].system, generation.system_prompt);
    assert.match(requests[0].messages[0].content, /"target_binding":"unspecified_agent"/);
    assert.match(requests[1].messages[0].content, /"target_binding":"nora_current_agent"/);
    assert.deepEqual(submitted.input.submissions.map(item => item.condition), ['deidentified', 'identity_bound']);
    assert.deepEqual(submitted.input.submissions.map(item => item.model_provenance.response_id), ['induction-provider-1', 'induction-provider-2']);
  } finally {
    store.selfInductionSubjectRuntimeQueue = originals.queue; store.submitSelfInductionSubjectPair = originals.submit; store.recordSelfInductionPairFailure = originals.fail;
  }
});
