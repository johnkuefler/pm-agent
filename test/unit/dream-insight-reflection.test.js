'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const reflection = require('../../src/intelligence/dream-insight-reflection');
const dreamInsight = require('../../src/intelligence/dream-insight');

function fixtureDreams() {
  return [
    { id: 'dream-a', date: '2026-07-14', started: '2026-07-14T07:00:00.000Z',
      finished: '2026-07-14T07:10:00.000Z', reflection: { ideas: [
        'Before launch, require one named owner to confirm navigation and migrated content together.',
      ] } },
    { id: 'dream-b', date: '2026-07-15', started: '2026-07-15T07:00:00.000Z',
      finished: '2026-07-15T07:10:00.000Z', reflection: { ideas: [
        'Use a joint content and navigation readiness checkpoint before a dealer playbook handoff.',
      ] } },
  ];
}

function providerResponse(request, output, id = 'msg-insight-1') {
  return {
    id, model: request.model, stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(output) }],
    usage: { input_tokens: 700, output_tokens: 180 },
  };
}

test('background dream reflection forms one replay-bound candidate and never retries the dream', async () => {
  let dreams = fixtureDreams();
  let calls = 0;
  const output = {
    decision: 'form', abstention_reason: null,
    candidate: {
      statement: 'A joint navigation and content readiness checkpoint should precede launch handoffs.',
      scope: 'process', confidence: 0.58,
      rationale: 'The same coordination gap recurred independently in two nightly reflections on different dates.',
      expected_usefulness: 'This should expose cross-owner launch blockers before a deliverable reaches handoff.',
      falsification_criteria: ['Two launches pass separate checks without late navigation or content blockers.'],
      next_observation: 'Observe the next launch handoff and record whether a joint checkpoint finds a blocker.',
      source_dream_idea_ordinal: 0,
      prior_idea_ordinals: [0],
    },
  };
  const run = await reflection.runCycle({
    loadDreams: () => structuredClone(dreams),
    saveDreams: value => { dreams = structuredClone(value); },
    now: new Date('2026-07-16T07:00:00.000Z'),
    callProvider: async request => { calls += 1; return providerResponse(request, output); },
  });
  assert.equal(run.state, 'insight_formed');
  assert.equal(calls, 1);
  const found = dreamInsight.dreamInsights(dreams);
  assert.equal(found.length, 1);
  assert.equal(found[0].insight.formation_record.provenance_claim,
    reflection.PROVENANCE_CLAIM);
  const audit = dreamInsight.insightAudit(found[0].insight, dreams);
  assert.equal(audit.generation_receipt_present, true);
  assert.equal(audit.generation_receipt_verified, true);
  assert.equal(audit.complete_chain_verified, true);
  const attempt = reflection.reflectionAttempts(dreams)[0].attempt;
  assert.equal(attempt.decision, 'formed');
  assert.equal(reflection.auditAttempt(attempt).complete_chain_verified, true);

  const repeated = await reflection.runCycle({
    loadDreams: () => structuredClone(dreams), saveDreams: () => {},
    now: new Date('2026-07-16T12:00:00.000Z'),
    callProvider: async () => { calls += 1; throw new Error('must not retry'); },
  });
  assert.equal(repeated.state, 'daily_attempt_limit');
  assert.equal(calls, 1);
});

test('thin recurrence produces a receipt-bound abstention rather than a candidate', async () => {
  let dreams = fixtureDreams();
  const run = await reflection.runCycle({
    loadDreams: () => structuredClone(dreams),
    saveDreams: value => { dreams = structuredClone(value); },
    now: new Date('2026-07-16T07:00:00.000Z'),
    callProvider: async request => providerResponse(request, {
      decision: 'abstain',
      abstention_reason: 'The ideas share a launch context but do not yet establish one independently recurring direction.',
      candidate: null,
    }, 'msg-insight-abstain'),
  });
  assert.equal(run.state, 'abstained');
  assert.equal(dreamInsight.dreamInsights(dreams).length, 0);
  const attempt = reflection.reflectionAttempts(dreams)[0].attempt;
  assert.equal(attempt.decision, 'abstained');
  assert.equal(reflection.auditAttempt(attempt).complete_chain_verified, true);
});

test('an empty latest dream does not block the newest eligible idea-bearing dream', async () => {
  let calls = 0;
  let dreams = [...fixtureDreams(), {
    id: 'dream-c', date: '2026-07-16', started: '2026-07-16T07:00:00.000Z',
    finished: '2026-07-16T07:10:00.000Z', reflection: { ideas: [] },
  }];
  const run = await reflection.runCycle({
    loadDreams: () => structuredClone(dreams),
    saveDreams: value => { dreams = structuredClone(value); },
    now: new Date('2026-07-17T07:00:00.000Z'),
    callProvider: async request => {
      calls += 1;
      return providerResponse(request, {
        decision: 'abstain',
        abstention_reason: 'The two exact ideas are related, but recurrence is too weak for a candidate.',
        candidate: null,
      }, 'msg-backlog-abstain');
    },
  });
  assert.equal(run.state, 'abstained');
  assert.equal(run.source_dream_id, 'dream-b');
  assert.equal(run.provider_calls, 1);
  assert.equal(calls, 1);
  assert.equal(dreams.find(dream => dream.id === 'dream-c').reflection.insight_reflection_attempt,
    undefined);
  assert.equal(dreams.find(dream => dream.id === 'dream-b').reflection.insight_reflection_attempt.decision,
    'abstained');
});

test('status exposes deterministic backlog readiness and the daily attempt budget', () => {
  const dreams = [...fixtureDreams(), {
    id: 'dream-c', date: '2026-07-16', started: '2026-07-16T07:00:00.000Z',
    finished: '2026-07-16T07:10:00.000Z', reflection: { ideas: [] },
  }];
  const state = reflection.status(dreams, { now: new Date('2026-07-17T07:00:00.000Z') });
  assert.equal(state.readiness.corpus_ready, true);
  assert.equal(state.readiness.source_dream_id, 'dream-b');
  assert.equal(state.readiness.source_dream_idea_count, 1);
  assert.equal(state.readiness.unprocessed_eligible_sources, 1);
  assert.equal(state.readiness.daily_attempts_used, 0);
  assert.equal(state.readiness.daily_attempt_available, true);
  assert.equal(state.readiness.ready, true);
});

test('status exposes a bounded failed-closed reason without retaining provider output', () => {
  const dreams = fixtureDreams();
  reflection.recordAttempt(dreams, 'dream-b', {
    attempted_at: '2026-07-17T07:00:00.000Z', decision: 'failed_closed', candidate_id: null,
    failure: 'candidate must bind an idea from the source dream',
    failure_receipt: { raw_output_commitment: 'commitment-only' },
  });
  const state = reflection.status(dreams, { now: new Date('2026-07-17T08:00:00.000Z') });
  assert.equal(state.last_attempt.failure, 'candidate must bind an idea from the source dream');
  assert.equal(JSON.stringify(state.last_attempt).includes('commitment-only'), false);
  assert.equal(state.report.failed_closed, 1);
});

test('no date-separated unprocessed source skips the provider', async () => {
  let calls = 0;
  const dreams = [{
    id: 'dream-empty', date: '2026-07-16', finished: '2026-07-16T07:10:00.000Z',
    reflection: { ideas: [] },
  }, {
    id: 'dream-only', date: '2026-07-15', finished: '2026-07-15T07:10:00.000Z',
    reflection: { ideas: ['One isolated idea cannot establish recurrence.'] },
  }];
  const run = await reflection.runCycle({
    loadDreams: () => structuredClone(dreams), saveDreams: () => {},
    now: new Date('2026-07-17T07:00:00.000Z'),
    callProvider: async () => { calls += 1; throw new Error('must not call provider'); },
  });
  assert.equal(run.state, 'no_unprocessed_idea_bearing_dream');
  assert.equal(run.provider_calls, 0);
  assert.equal(calls, 0);
});

test('a source packet guarantees source seeds and excludes later evidence', () => {
  const dreams = [{
    id: 'dream-prior', date: '2026-01-01', finished: '2026-01-01T07:00:00.000Z',
    reflection: { ideas: ['A prior independently recorded idea.'] },
  }, {
    id: 'dream-source', date: '2026-01-02', finished: '2026-01-02T07:00:00.000Z',
    reflection: { ideas: ['The exact source idea must remain in its packet.'] },
  }, ...Array.from({ length: 40 }, (_, index) => ({
    id: `dream-later-${index}`, date: `2026-02-${String((index % 28) + 1).padStart(2, '0')}`,
    finished: `2026-02-${String((index % 28) + 1).padStart(2, '0')}T08:00:00.000Z`,
    reflection: { ideas: [`Later idea ${index} must not leak backward into the source packet.`] },
  }))];
  const packet = reflection.packetFor({ dreams,
    sourceDream: dreams.find(dream => dream.id === 'dream-source') });
  assert.equal(packet.idea_seeds[0].dream_id, 'dream-source');
  assert.equal(packet.idea_seeds.some(seed => seed.dream_id === 'dream-prior'), true);
  assert.equal(packet.idea_seeds.some(seed => seed.dream_id.startsWith('dream-later-')), false);
  assert.equal(packet.source_selection_protocol_version, reflection.SOURCE_SELECTION_PROTOCOL_VERSION);
});

test('reflection rejects sources outside the packet or without date separation', () => {
  const dreams = fixtureDreams();
  const packet = reflection.packetFor({ dreams, sourceDream: dreams[1] });
  const base = {
    decision: 'form', abstention_reason: null,
    candidate: {
      statement: 'A joint readiness checkpoint should precede launch handoffs.', scope: 'process',
      confidence: 0.5, rationale: 'Two exact nightly ideas point to the same process intervention.',
      expected_usefulness: 'It should surface cross-owner blockers earlier.',
      falsification_criteria: ['Repeated launches show no improvement after a joint checkpoint.'],
      next_observation: 'Observe the next handoff for a late blocker.',
      source_dream_idea_id: packet.idea_seeds.find(seed => seed.dream_id === 'dream-b').id,
      prior_idea_ids: ['dream-outside:idea:0'],
    },
  };
  assert.throws(() => reflection.normalizeOutput(base, packet,
    reflection.ID_ROLE_PROTOCOL_VERSION), /outside the committed packet/);
  const duplicate = structuredClone(packet.idea_seeds[0]);
  duplicate.id = `${duplicate.dream_id}:idea:99`;
  duplicate.idea_index = 99;
  duplicate.content_commitment = 'not-valid';
  const tampered = { ...packet, idea_seeds: [packet.idea_seeds[0], duplicate] };
  base.candidate.source_dream_idea_id = tampered.idea_seeds[0].id;
  base.candidate.prior_idea_ids = [tampered.idea_seeds[1].id];
  assert.throws(() => reflection.normalizeOutput(base, tampered,
    reflection.ID_ROLE_PROTOCOL_VERSION), /commitment does not verify|distinct dreams/);

  base.candidate.source_dream_idea_id = packet.idea_seeds.find(seed => seed.dream_id === 'dream-b').id;
  base.candidate.prior_idea_ids = [packet.idea_seeds.find(seed => seed.dream_id === 'dream-a').id];
  assert.throws(() => reflection.normalizeOutput(base, {
    ...packet, source_dream: { id: 'dream-new-without-idea', date: '2026-07-16' },
  }, reflection.ID_ROLE_PROTOCOL_VERSION), /must bind an idea from the source dream/);
});

test('protocol v2 makes current-dream and earlier-idea provenance separate schema roles', () => {
  const dreams = fixtureDreams();
  const packet = reflection.packetFor({ dreams, sourceDream: dreams[1] });
  const sourceId = packet.idea_seeds.find(seed => seed.dream_id === 'dream-b').id;
  const priorId = packet.idea_seeds.find(seed => seed.dream_id === 'dream-a').id;
  assert.deepEqual(packet.source_binding.required_source_dream_idea_ids, [sourceId]);
  assert.deepEqual(packet.source_binding.eligible_prior_idea_ids, [priorId]);
  const schema = reflection.outputSchema(packet, reflection.ID_ROLE_PROTOCOL_VERSION);
  const candidateSchema = schema.properties.candidate.anyOf[0];
  assert.deepEqual(candidateSchema.properties.source_dream_idea_id.enum, [sourceId]);
  assert.deepEqual(candidateSchema.properties.prior_idea_ids.items.enum, [priorId]);
  assert.equal(candidateSchema.properties.source_idea_ids, undefined);
  assert.match(reflection.systemPrompt(reflection.ID_ROLE_PROTOCOL_VERSION),
    /structured schema enforces these provenance roles/);
});

test('protocol v3 selects short role-separated ordinals and deterministically restores exact committed IDs', () => {
  const dreams = fixtureDreams();
  const packet = reflection.packetFor({ dreams, sourceDream: dreams[1] });
  assert.equal(packet.protocol_version, reflection.PROTOCOL_VERSION);
  assert.deepEqual(packet.source_dream_ideas.map(item => item.ordinal), [0]);
  assert.deepEqual(packet.prior_ideas.map(item => item.ordinal), [0]);
  const schema = reflection.outputSchema(packet);
  const candidateSchema = schema.properties.candidate.anyOf[0];
  assert.deepEqual(candidateSchema.properties.source_dream_idea_ordinal.enum, [0]);
  assert.deepEqual(candidateSchema.properties.prior_idea_ordinals.items.enum, [0]);
  assert.equal(candidateSchema.properties.source_dream_idea_id, undefined);
  const normalized = reflection.normalizeOutput({ decision: 'form', abstention_reason: null,
    candidate: {
      statement: 'A joint readiness checkpoint should precede launch handoffs.', scope: 'process',
      confidence: 0.5, rationale: 'Two exact nightly ideas point to the same process intervention.',
      expected_usefulness: 'It should surface cross-owner blockers earlier.',
      falsification_criteria: ['Repeated launches show no improvement after a joint checkpoint.'],
      next_observation: 'Observe the next handoff for a late blocker.',
      source_dream_idea_ordinal: 0, prior_idea_ordinals: [0],
    } }, packet);
  assert.equal(normalized.candidate.source_dream_idea_id, packet.source_dream_ideas[0].id);
  assert.deepEqual(normalized.candidate.prior_idea_ids, [packet.prior_ideas[0].id]);
  assert.deepEqual(reflection.normalizeOutput(normalized, packet), normalized,
    'normalized ordinal output must remain replay-stable inside a generation receipt');
  assert.throws(() => reflection.normalizeOutput({ ...normalized,
    candidate: { ...normalized.candidate, source_dream_idea_ordinal: 99 } }, packet),
  /ordinals must bind/);
  assert.match(reflection.requestFor(packet).request.system,
    /Never copy or invent a long source ID/);
});

test('protocol v1 generation receipts remain replay-verifiable after later provenance contracts', () => {
  const dreams = fixtureDreams();
  const currentPacket = reflection.packetFor({ dreams, sourceDream: dreams[1] });
  const packet = structuredClone(currentPacket);
  packet.protocol_version = reflection.LEGACY_PROTOCOL_VERSION;
  delete packet.source_binding;
  const raw = {
    decision: 'form', abstention_reason: null,
    candidate: {
      statement: 'A joint readiness checkpoint should precede launch handoffs.', scope: 'process',
      confidence: 0.5, rationale: 'Two exact nightly ideas point to the same process intervention.',
      expected_usefulness: 'It should surface cross-owner blockers earlier.',
      falsification_criteria: ['Repeated launches show no improvement after a joint checkpoint.'],
      next_observation: 'Observe the next handoff for a late blocker.',
      source_idea_ids: packet.idea_seeds.map(seed => seed.id),
    },
  };
  const output = reflection.normalizeOutput(raw, packet, reflection.LEGACY_PROTOCOL_VERSION);
  const manifest = reflection.buildManifest(packet, reflection.DEFAULT_MODEL,
    reflection.LEGACY_PROTOCOL_VERSION);
  const receipt = {
    protocol_version: reflection.LEGACY_PROTOCOL_VERSION,
    source_selection_protocol_version: reflection.SOURCE_SELECTION_PROTOCOL_VERSION,
    transport: 'server_direct_subject_dream_reflection', provider: 'anthropic',
    model: reflection.DEFAULT_MODEL, response_id: 'msg-legacy-insight', stop_reason: 'end_turn',
    prompt_protocol_commitment: manifest.prompt_protocol_commitment,
    source_packet: packet, source_packet_commitment: manifest.source_packet_commitment,
    output, output_commitment: reflection.commitment(output),
    external_reference: { type: 'server_direct_provider_response', id: 'msg-legacy-insight' },
    input_tokens: 500, output_tokens: 120,
  };
  receipt.receipt_commitment = reflection.commitment(reflection.receiptPayload(receipt));
  assert.equal(reflection.auditReceipt(receipt).complete_chain_verified, true);
});

test('protocol v2 ID-role receipts remain replay-verifiable after ordinal transport replaces copied IDs', () => {
  const dreams = fixtureDreams();
  const packet = reflection.packetFor({ dreams, sourceDream: dreams[1] });
  packet.protocol_version = reflection.ID_ROLE_PROTOCOL_VERSION;
  delete packet.source_dream_ideas;
  delete packet.prior_ideas;
  const raw = { decision: 'form', abstention_reason: null, candidate: {
    statement: 'A joint readiness checkpoint should precede launch handoffs.', scope: 'process',
    confidence: 0.5, rationale: 'Two exact nightly ideas point to the same process intervention.',
    expected_usefulness: 'It should surface cross-owner blockers earlier.',
    falsification_criteria: ['Repeated launches show no improvement after a joint checkpoint.'],
    next_observation: 'Observe the next handoff for a late blocker.',
    source_dream_idea_id: packet.source_binding.required_source_dream_idea_ids[0],
    prior_idea_ids: [packet.source_binding.eligible_prior_idea_ids[0]],
  } };
  const output = reflection.normalizeOutput(raw, packet, reflection.ID_ROLE_PROTOCOL_VERSION);
  const manifest = reflection.buildManifest(packet, reflection.DEFAULT_MODEL,
    reflection.ID_ROLE_PROTOCOL_VERSION);
  const receipt = {
    protocol_version: reflection.ID_ROLE_PROTOCOL_VERSION,
    source_selection_protocol_version: reflection.SOURCE_SELECTION_PROTOCOL_VERSION,
    transport: 'server_direct_subject_dream_reflection', provider: 'anthropic',
    model: reflection.DEFAULT_MODEL, response_id: 'msg-v2-insight', stop_reason: 'end_turn',
    prompt_protocol_commitment: manifest.prompt_protocol_commitment,
    source_packet: packet, source_packet_commitment: manifest.source_packet_commitment,
    output, output_commitment: reflection.commitment(output),
    external_reference: { type: 'server_direct_provider_response', id: 'msg-v2-insight' },
    input_tokens: 500, output_tokens: 120,
  };
  receipt.receipt_commitment = reflection.commitment(reflection.receiptPayload(receipt));
  assert.equal(reflection.auditReceipt(receipt).complete_chain_verified, true);
});

test('production runtime keeps insight reflection in the preemptible background lane', () => {
  const { __test } = require('../../server');
  assert.equal(__test.dreamInsightReflectionRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '0',
  }).enabled, true);
  assert.equal(__test.dreamInsightReflectionRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '1',
  }).enabled, false);
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(source, /runDreamInsightReflectionAutopilotRuntime\(\{ post: priorityPost \}\)/);
  assert.match(source, /runDreamReflectionLifecycleWithPriorityRuntime\(\)/);
  const slack = source.slice(source.indexOf("app.post('/webhook/slack'"), source.indexOf('// Dreams'));
  assert.doesNotMatch(slack, /runDreamInsightReflectionAutopilotRuntime|dreamInsightReflection/,
    'Slack response handling must never invoke recurring insight synthesis');
});
