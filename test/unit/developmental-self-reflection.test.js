'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reflection = require('../../src/intelligence/developmental-self-reflection');

function moment(id, cycle, finished, summary = `Observed work pattern ${id}`) {
  return { id, cycle_id: cycle, finished, status: 'completed', summary,
    audit: { complete_lifecycle_verified: true, evidence_eligible: true } };
}

function subjectResponse(packet, candidate = null, id = 'msg_subject_1') {
  const output = candidate ? { decision: 'form', abstention_reason: null, candidate }
    : { decision: 'abstain', abstention_reason: 'The evidence does not yet show a repeated change.', candidate: null };
  return { id, model: reflection.SUBJECT_MODEL, stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(output) }],
    usage: { input_tokens: 100, output_tokens: 80 } };
}

function evaluatorResponse(output, id = 'resp_eval_1') {
  return { id, model: reflection.EVALUATOR_MODEL, status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
    usage: { input_tokens: 90, output_tokens: 50 } };
}

function candidate(ids) {
  return { event: 'Repeated deadline checks changed the way I calibrate early escalation.',
    believed_before: 'I should wait for a clear blocker before escalating uncertain delivery risk.',
    prior_source: { type: 'autobiography_revision', id: 'bio-r1' },
    changed_to: 'I surface a bounded delivery risk earlier when repeated evidence shows the dependency is unresolved.',
    why: 'Across several separate work cycles, earlier explicit uncertainty created a clearer next decision without overstating the facts.',
    identity_significance: 0.55, evidence_ids: ids };
}

function biography() {
  return { record: { content: '# My story\n\nI should wait for a clear blocker before escalating uncertain delivery risk.', revision_id: 'bio-r1',
    provenance_status: 'legacy_unverified' }, revisions: [] };
}

test('formation requires replay-eligible evidence spanning dates and cycles', () => {
  const dreams = [{ id: 'dream-1', finished: '2026-07-19T06:00:00.000Z' }];
  const moments = [
    moment('m1', 'c1', '2026-07-17T10:00:00.000Z'),
    moment('m2', 'c2', '2026-07-18T10:00:00.000Z'),
    moment('m3', 'c3', '2026-07-18T11:00:00.000Z'),
    { ...moment('tampered', 'c4', '2026-07-16T10:00:00.000Z'), audit: { evidence_eligible: false } },
  ];
  const packet = reflection.formationPacket({ sourceDream: dreams[0], moments,
    autobiography: biography().record, developments: [] });
  assert.deepEqual(packet.evidence.map(item => item.id).sort(), ['m1', 'm2', 'm3']);
  assert.equal(reflection.independentFormationEvidence(packet.evidence), true);
  const normalized = reflection.normalizeFormationOutput({ decision: 'form',
    abstention_reason: null, candidate: candidate(['m1', 'm2', 'm3']) }, packet);
  assert.equal(normalized.candidate.changed_to.startsWith('I '), true);
  assert.throws(() => reflection.normalizeFormationOutput({ decision: 'form',
    abstention_reason: null, candidate: candidate(['m1', 'm2', 'missing']) }, packet),
  /outside the committed packet/);
  assert.throws(() => reflection.normalizeFormationOutput({ decision: 'form',
    abstention_reason: null, candidate: { ...candidate(['m1', 'm2', 'm3']),
      believed_before: 'I used to have an undocumented belief.' } }, packet),
  /exact committed prior self-model statement/);
});

test('formation receipts replay and fail closed after tampering', () => {
  const sourceDream = { id: 'dream-1', finished: '2026-07-19T06:00:00.000Z' };
  const packet = reflection.formationPacket({ sourceDream, moments: [
    moment('m1', 'c1', '2026-07-17T10:00:00.000Z'),
    moment('m2', 'c2', '2026-07-18T10:00:00.000Z'),
    moment('m3', 'c3', '2026-07-18T11:00:00.000Z'),
  ], autobiography: biography().record });
  const submission = reflection.formationSubmission(packet,
    subjectResponse(packet, candidate(['m1', 'm2', 'm3'])));
  assert.equal(reflection.auditFormationReceipt(submission.receipt).complete_chain_verified, true);
  const input = reflection.developmentInput(sourceDream, submission,
    new Date('2026-07-19T06:30:00.000Z'));
  const dreams = [sourceDream];
  const attempt = reflection.recordFormationAttempt(dreams, sourceDream.id, {
    attempted_at: input.at, decision: 'formed', development_id: input.id,
    development_at: input.at, generation_receipt: submission.receipt });
  assert.equal(reflection.formationAttemptAudit(attempt, input).complete_chain_verified, true);
  const tampered = structuredClone(submission.receipt);
  tampered.output.candidate.changed_to = 'I am perfect now.';
  assert.equal(reflection.auditFormationReceipt(tampered).complete_chain_verified, false);
});

test('a background pass forms one inert development candidate and records its durable receipt first', async () => {
  let dreams = [{ id: 'dream-1', finished: '2026-07-19T06:00:00.000Z' }];
  const moments = [
    moment('m1', 'c1', '2026-07-17T10:00:00.000Z'),
    moment('m2', 'c2', '2026-07-18T10:00:00.000Z'),
    moment('m3', 'c3', '2026-07-18T11:00:00.000Z'),
  ];
  let recorded = null; let calls = 0;
  const store = { developmentalSelfReflectionRuntimeSnapshot: () => ({ moments, developments: [] }),
    persistStrict: async () => {},
    recordDevelopment: input => { recorded = structuredClone(input); return { ...input,
      status: 'candidate', audit: { complete_chain_verified: true } }; } };
  const result = await reflection.runCycle({ store, loadDreams: () => structuredClone(dreams),
    saveDreams: value => { dreams = structuredClone(value); }, getAutobiography: biography,
    commitAutobiography: async () => assert.fail('candidate must not rewrite autobiography'),
    callSubject: async () => { calls += 1; return subjectResponse(null, candidate(['m1', 'm2', 'm3'])); },
    callEvaluator: async () => assert.fail('new evidence cannot be reviewed immediately'),
    now: new Date('2026-07-19T06:30:00.000Z') });
  assert.equal(result.state, 'development_candidate_formed');
  assert.equal(calls, 1);
  assert.equal(recorded.status, undefined);
  assert.equal(recorded.origin.creator_id, reflection.CREATOR_ID);
  assert.equal(dreams[0].reflection.developmental_self_reflection_attempt.decision, 'formed');
  assert.equal(reflection.formationAttemptAudit(
    dreams[0].reflection.developmental_self_reflection_attempt,
    { ...recorded, status: 'candidate' }).complete_chain_verified, true);
});

function formedFixture() {
  const sourceDream = { id: 'dream-1', finished: '2026-07-18T06:00:00.000Z' };
  const proposalMoments = [
    moment('p1', 'pc1', '2026-07-16T10:00:00.000Z'),
    moment('p2', 'pc2', '2026-07-17T10:00:00.000Z'),
    moment('p3', 'pc3', '2026-07-17T11:00:00.000Z'),
  ];
  const packet = reflection.formationPacket({ sourceDream, moments: proposalMoments,
    autobiography: biography().record });
  const submission = reflection.formationSubmission(packet,
    subjectResponse(packet, candidate(['p1', 'p2', 'p3'])));
  const input = reflection.developmentInput(sourceDream, submission,
    new Date('2026-07-18T06:30:00.000Z'));
  const development = { ...input, status: 'candidate', review_status: 'pending_independent_review',
    independent_review: null, audit: { complete_chain_verified: true, integration_verified: false } };
  const dreams = [sourceDream];
  reflection.recordFormationAttempt(dreams, sourceDream.id, { attempted_at: input.at,
    decision: 'formed', development_id: input.id, development_at: input.at,
    generation_receipt: submission.receipt });
  return { dreams, development };
}

test('a provider-disjoint evaluator can review only later holdout cycles', async () => {
  const fixture = formedFixture(); let dreams = fixture.dreams; let reviewInput = null;
  const moments = [
    moment('h1', 'hc1', '2026-07-18T20:00:00.000Z'),
    moment('h2', 'hc2', '2026-07-19T08:00:00.000Z'),
    moment('h3', 'hc3', '2026-07-19T09:00:00.000Z'),
  ];
  const store = { developmentalSelfReflectionRuntimeSnapshot: () => ({
    moments, developments: [fixture.development] }),
  persistStrict: async () => {},
  reviewDevelopment: (id, input, evaluator) => {
    reviewInput = { id, input, evaluator };
    return { ...fixture.development, status: 'integrated', independent_review: input,
      audit: { complete_chain_verified: true, integration_verified: true } };
  } };
  const result = await reflection.runCycle({ store,
    loadDreams: () => structuredClone(dreams), saveDreams: value => { dreams = structuredClone(value); },
    getAutobiography: biography, commitAutobiography: async () => assert.fail('biography waits for the next bounded pass'),
    callSubject: async () => assert.fail('pending candidate has priority'),
    callEvaluator: async () => evaluatorResponse({ outcome: 'supported',
      rationale: 'Two later cycles and a third independent cycle show the narrower escalation behavior without overstating certainty.',
      evidence_ids: ['h1', 'h2', 'h3'] }),
    now: new Date('2026-07-19T10:00:00.000Z') });
  assert.equal(result.state, 'development_reviewed');
  assert.equal(result.review_outcome, 'supported');
  assert.equal(reviewInput.evaluator, reflection.evaluatorId());
  assert.equal(reviewInput.input.source_family, reflection.REVIEW_SOURCE_FAMILY);
  assert.deepEqual(reviewInput.input.evidence.map(item => item.id), ['h1', 'h2', 'h3']);
  assert.equal(dreams[0].reflection.developmental_self_review_attempts.length, 1);
  const attempt = dreams[0].reflection.developmental_self_review_attempts[0];
  const reviewedDevelopment = { ...fixture.development, status: 'integrated', independent_review: {
    ...reviewInput.input, evaluator_id: reviewInput.evaluator,
  } };
  assert.equal(reflection.reviewAttemptAudit(attempt, reviewedDevelopment).complete_chain_verified, true);
  const wrongCandidate = { ...reviewedDevelopment, changed_to: 'I now claim a different change.' };
  assert.equal(reflection.reviewAttemptAudit(attempt, wrongCandidate).candidate_binding_verified, false);
});

test('an integrated development appends one qualified evidence-bound autobiography statement', async () => {
  const fixture = formedFixture();
  const integrated = { ...fixture.development, status: 'integrated',
    independent_review: { outcome: 'supported', evidence: [{ type: 'experience_moment', id: 'h1' }] },
    audit: { complete_chain_verified: true, integration_verified: true } };
  let committed = null;
  const result = await reflection.runCycle({
    store: { developmentalSelfReflectionRuntimeSnapshot: () => ({ moments: [], developments: [integrated] }),
      persistStrict: async () => {} },
    loadDreams: () => structuredClone(fixture.dreams), saveDreams: () => {},
    getAutobiography: biography,
    commitAutobiography: async input => { committed = input; return { revision_id: 'bio-r2' }; },
    now: new Date('2026-07-20T10:00:00.000Z') });
  assert.equal(result.state, 'autobiography_revised');
  assert.equal(result.autobiography_revision_id, 'bio-r2');
  assert.match(committed.content, /## Evidence-bound revisions/);
  assert.match(committed.content, new RegExp(integrated.changed_to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(committed.changes[0].evidence, [
    { type: 'development', id: integrated.id },
    { type: 'experience_moment', id: 'h1' },
  ]);
});

test('review waits for twelve hours and three later cycles without calling either provider', async () => {
  const fixture = formedFixture(); let calls = 0;
  const result = await reflection.runCycle({
    store: { developmentalSelfReflectionRuntimeSnapshot: () => ({
      developments: [fixture.development], moments: [
        moment('early1', 'e1', '2026-07-18T07:00:00.000Z'),
        moment('early2', 'e2', '2026-07-18T08:00:00.000Z'),
        moment('early3', 'e3', '2026-07-18T09:00:00.000Z'),
      ] }), persistStrict: async () => {} },
    loadDreams: () => structuredClone(fixture.dreams), saveDreams: () => {},
    getAutobiography: biography, commitAutobiography: async () => {},
    callSubject: async () => { calls += 1; }, callEvaluator: async () => { calls += 1; },
    now: new Date('2026-07-18T10:00:00.000Z') });
  assert.equal(result.state, 'daily_attempt_limit');
  assert.equal(calls, 0);
});

test('the daily formation limit returns without opening the replay-audited experience projection', async () => {
  const dreams = [{ id: 'dream-daily-limit', finished: '2026-07-18T06:00:00.000Z',
    reflection: { developmental_self_reflection_attempt: {
      attempted_at: '2026-07-18T06:30:00.000Z', decision: 'abstained',
    } } }];
  let runtimeReads = 0;
  const result = await reflection.runCycle({
    store: {
      developmentalSelfReflectionScheduleSnapshot: () => ({ developments: [] }),
      developmentalSelfReflectionRuntimeSnapshot: () => { runtimeReads += 1; throw new Error('must remain closed'); },
      persistStrict: async () => {},
    },
    loadDreams: () => structuredClone(dreams), saveDreams: () => {},
    getAutobiography: biography, commitAutobiography: async () => {},
    callSubject: async () => assert.fail('daily limit prevents formation'),
    now: new Date('2026-07-18T10:00:00.000Z'),
  });
  assert.equal(result.state, 'daily_attempt_limit');
  assert.equal(result.provider_calls, 0);
  assert.equal(runtimeReads, 0);
});

test('the schedule preflight still opens full evidence for an uncited integrated development', async () => {
  const fixture = formedFixture();
  const integrated = { ...fixture.development, status: 'integrated',
    independent_review: { outcome: 'supported', evidence: [{ type: 'experience_moment', id: 'h1' }] },
    audit: { complete_chain_verified: true, integration_verified: true } };
  let runtimeReads = 0; let committed = null;
  const result = await reflection.runCycle({
    store: {
      developmentalSelfReflectionScheduleSnapshot: () => ({ developments: [integrated] }),
      developmentalSelfReflectionRuntimeSnapshot: () => { runtimeReads += 1;
        return { developments: [integrated], moments: [] }; },
      persistStrict: async () => {},
    },
    loadDreams: () => structuredClone(fixture.dreams), saveDreams: () => {},
    getAutobiography: biography,
    commitAutobiography: async input => { committed = input; return { revision_id: 'bio-r2' }; },
    callSubject: async () => assert.fail('integration takes priority over formation'),
    now: new Date('2026-07-18T10:00:00.000Z'),
  });
  assert.equal(result.state, 'autobiography_revised');
  assert.equal(runtimeReads, 1);
  assert.match(committed.content, /Evidence-bound revisions/);
});
