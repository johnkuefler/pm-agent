'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reflection = require('../../src/intelligence/professional-viewpoint-reflection');
const { createIntelligenceStore } = require('../../src/intelligence/store');

const NOW = new Date('2026-07-16T16:00:00.000Z');

function memories() {
  return [
    { id: 'memory-qa-july-15', added: '2026-07-15', project: 'Alpha', source: 'auto', kind: 'fact',
      status: 'active', fact: 'Integration QA began after content approval and exposed two launch-blocking defects.' },
    { id: 'memory-qa-july-10', added: '2026-07-10', project: 'Beta', source: 'auto', kind: 'fact',
      status: 'active', fact: 'A compressed integration QA window pushed the Beta launch by three working days.' },
    { id: 'memory-scope-july-16', added: '2026-07-16', project: 'Gamma', source: 'auto', kind: 'fact',
      status: 'active', fact: 'The Gamma team confirmed scope before development and held its planned review date.' },
    { id: 'memory-learning-excluded', added: '2026-07-16', project: 'Alpha', source: 'learning', kind: 'learning',
      status: 'active', fact: 'This self-learning must not become source evidence for a work viewpoint.' },
  ];
}

function modelResponse(request, output) {
  return {
    id: 'msg-viewpoint-reflection-1', model: request.model, stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(output) }],
    usage: { input_tokens: 500, output_tokens: 120 },
  };
}

async function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-viewpoint-reflection-'));
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: () => new Date(NOW) });
  await store.init();
  return { dir, store };
}

test('subject reflection forms one receipt-bound viewpoint and fails closed under receipt tampering', async () => {
  const { dir, store } = await makeStore();
  const dreams = [{ id: 'dream-natural-july-16', date: '2026-07-16',
    started: '2026-07-16T05:00:00.000Z', finished: '2026-07-16T05:10:00.000Z' }];
  const result = await reflection.runCycle({
    store, memories: memories(), dreams, now: NOW,
    callProvider: async request => modelResponse(request, {
      decision: 'form', abstention_reason: null,
      candidate: {
        topic_key: 'delivery.integration-qa-contingency',
        statement: 'Integration-heavy delivery plans benefit from an explicit QA contingency before launch.',
        polarity: 'supports', confidence: 0.62,
        rationale: 'Two separate projects lost schedule when integration QA was compressed or late.',
        falsification_criteria: ['Comparable integration-heavy launches repeatedly hold schedule without an explicit QA contingency.'],
        evidence_ids: ['memory-qa-july-15', 'memory-qa-july-10'],
      },
    }),
  });
  assert.equal(result.state, 'viewpoint_formed');
  assert.equal(result.provider_calls, 1);
  assert.ok(result.position_id);

  const projection = store.earnedViewpointsSnapshot();
  assert.equal(projection.current_verified, true);
  assert.equal(projection.viewpoints.length, 1);
  assert.match(projection.viewpoints[0].rationale, /Falsify if:/);
  const status = store.professionalViewpointReflectionSnapshot();
  assert.deepEqual(status.report, { total: 1, formed: 1, abstained: 0, replay_verified: 1 });
  const indicator = store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'evidence_tested_professional_viewpoints');
  assert.equal(indicator.evidence.replay_verified_subject_reflections, 1);
  assert.equal(indicator.evidence.subject_reflection_formations, 1);

  const rawPosition = store.snapshot().cognition.epistemic_ledger.propositions[0].positions[0];
  assert.equal(reflection.auditReceipt(rawPosition.generation_receipt, {
    topicKey: 'delivery.integration-qa-contingency',
    statement: 'Integration-heavy delivery plans benefit from an explicit QA contingency before launch.',
    position: rawPosition,
  }).complete_chain_verified, true);
  const tampered = structuredClone(rawPosition.generation_receipt);
  tampered.output.candidate.confidence = 0.7;
  assert.equal(reflection.auditReceipt(tampered, {
    topicKey: 'delivery.integration-qa-contingency',
    statement: 'Integration-heavy delivery plans benefit from an explicit QA contingency before launch.',
    position: rawPosition,
  }).complete_chain_verified, false);

  let calls = 0;
  const duplicate = await reflection.runCycle({ store, memories: memories(), dreams, now: NOW,
    callProvider: async () => { calls += 1; throw new Error('must not run'); } });
  assert.equal(duplicate.state, 'dream_already_reflected');
  assert.equal(calls, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reflection can abstain without creating a viewpoint and balances its evidence packet', async () => {
  const selected = reflection.selectEvidence(memories(), NOW);
  assert.equal(selected.some(item => item.ref.id === 'memory-learning-excluded'), false);
  assert.ok(new Set(selected.map(item => item.project)).size >= 2);

  const { dir, store } = await makeStore();
  const dreams = [{ id: 'dream-abstain-july-16', date: '2026-07-16',
    finished: '2026-07-16T05:10:00.000Z' }];
  const result = await reflection.runCycle({
    store, memories: memories().slice(0, 2), dreams, now: NOW,
    callProvider: async request => modelResponse(request, {
      decision: 'abstain',
      abstention_reason: 'The two records identify a possible QA pattern, but they do not yet separate integration complexity from unrelated schedule pressure.',
      candidate: null,
    }),
  });
  assert.equal(result.state, 'abstained');
  assert.equal(store.earnedViewpointsSnapshot().viewpoints.length, 0);
  assert.deepEqual(store.professionalViewpointReflectionSnapshot().report,
    { total: 1, formed: 0, abstained: 1, replay_verified: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('formation rejects evidence outside the packet or a single date and project', () => {
  const packet = reflection.packetFor({ memories: memories(), dream: { id: 'dream-validation' }, now: NOW });
  const base = {
    decision: 'form', abstention_reason: null,
    candidate: {
      topic_key: 'delivery.integration-qa-contingency',
      statement: 'Integration-heavy delivery plans benefit from an explicit QA contingency before launch.',
      polarity: 'supports', confidence: 0.6,
      rationale: 'Repeated delivery evidence suggests the planning pattern is worth carrying as a bounded prior.',
      falsification_criteria: ['Comparable launches repeatedly hold schedule without the proposed contingency.'],
      evidence_ids: ['memory-qa-july-15', 'missing-memory'],
    },
  };
  assert.throws(() => reflection.normalizeOutput(base, packet), /outside the committed packet/);
  const singleContextPacket = reflection.packetFor({ memories: memories().map((item, index) => ({
    ...item, id: `single-${index}`, added: '2026-07-16', project: 'Only Project', source: 'auto',
  })), dream: { id: 'dream-one-context' }, now: NOW });
  assert.throws(() => reflection.normalizeOutput({ ...base, candidate: { ...base.candidate,
    evidence_ids: ['single-0', 'single-1'] } }, singleContextPacket), /two dates or projects/);
});

test('runtime enables subject reflection only with a provider credential outside test mode', () => {
  const { __test } = require('../../server');
  assert.equal(__test.professionalViewpointReflectionRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '0',
  }).enabled, true);
  assert.equal(__test.professionalViewpointReflectionRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '1',
  }).enabled, false);
  assert.equal(__test.professionalViewpointReflectionRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '0',
    NORA_PROFESSIONAL_VIEWPOINT_REFLECTION: '0',
  }).enabled, false);
});
