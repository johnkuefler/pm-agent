'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reflection = require('../../src/intelligence/professional-viewpoint-reflection');
const provenance = require('../../src/intelligence/professional-viewpoint-provenance');
const { createIntelligenceStore } = require('../../src/intelligence/store');

const NOW = new Date('2026-07-19T19:30:00.000Z');

function memories() {
  return [
    { id: 'memory-owner-alpha', added: '2026-07-17', project: 'Alpha', source: 'auto', kind: 'fact',
      status: 'active', fact: 'A dated task without an assignee remained at zero percent through its due date.' },
    { id: 'memory-owner-beta', added: '2026-07-16', project: 'Beta', source: 'auto', kind: 'fact',
      status: 'active', fact: 'A comparable dated task with a named owner moved before the same review window.' },
  ];
}

function legacyFormation() {
  const packet = reflection.packetFor({ memories: memories(), dream: { id: 'dream-legacy-owner' }, now: NOW });
  delete packet.source_family_context;
  for (const item of packet.evidence) delete item.provenance_family;
  const output = {
    decision: 'form', abstention_reason: null,
    candidate: {
      topic_key: 'delivery.owner-before-date',
      statement: 'Named ownership is a stronger early delivery signal than the presence of a due date alone.',
      polarity: 'supports', confidence: 0.62,
      rationale: 'Two separate project records contrast motion with ownership against stagnation without it.',
      falsification_criteria: ['Comparable unassigned tasks repeatedly move on time without intervention.'],
      evidence_ids: ['memory-owner-alpha', 'memory-owner-beta'],
    },
  };
  const request = reflection.requestFor(packet).request;
  const response = {
    id: 'msg-legacy-provenance', model: request.model, stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(output) }],
    usage: { input_tokens: 400, output_tokens: 100 },
  };
  return reflection.submissionFor(packet, response);
}

async function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-viewpoint-provenance-'));
  const filePath = path.join(dir, 'state.json');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(NOW) });
  await store.init();
  return { dir, filePath, store };
}

function formLegacyViewpoint(store) {
  const submission = legacyFormation();
  const candidate = submission.output.candidate;
  const evidence = candidate.evidence_ids.map(id => ({ type: 'memory', id }));
  return store.recordEpistemicPosition({
    proposition_kind: 'professional_viewpoint',
    topic_key: candidate.topic_key, statement: candidate.statement,
    source_family: reflection.LEGACY_SOURCE_FAMILY, source_family_evidence: evidence,
    owner_type: 'nora_belief', polarity: candidate.polarity, confidence: candidate.confidence,
    rationale: reflection.rationaleForCandidate(candidate), evidence,
    recorded_by: `${reflection.RECORDED_BY_PREFIX}${submission.receipt.model}:legacy`,
    generation_receipt: submission.receipt,
  });
}

test('legacy viewpoint provenance is appended without rewriting history or earlier exposures', async () => {
  const { dir, store } = await makeStore();
  const proposition = formLegacyViewpoint(store);
  let snapshot = store.earnedViewpointsSnapshot();
  assert.equal(snapshot.viewpoints[0].source_family_provenance_verified, false);
  assert.equal(snapshot.viewpoints[0].source_family_provenance_method, null);

  const beforePrompt = store.promptContext({ query: 'How should we treat a dated task with no owner?',
    returnContextReceipt: true });
  const firstInteraction = {
    id: 'ix-before-attestation', created: NOW.toISOString(), channel: 'C0123456789',
    thread_ts: '1784490000.000001', ts: '1784490001.000001',
    trigger: 'How should we treat a dated task with no owner?', text: 'Find an owner before relying on the date.',
  };
  const earlier = store.recordProfessionalViewpointAccessApplication(
    firstInteraction, beforePrompt.context_receipt.professional_viewpoints);
  assert.equal(earlier.observational_outcome_eligible, false);

  const result = store.attestLegacyProfessionalViewpointProvenance();
  assert.equal(result.state, 'attested');
  assert.equal(result.viewpoint_id, proposition.id);
  assert.equal(result.derived_evidence_family, 'automated_work_memory');
  snapshot = store.earnedViewpointsSnapshot({ includeAccessRecords: true });
  assert.equal(snapshot.viewpoints[0].source_family, reflection.LEGACY_SOURCE_FAMILY,
    'the historical source family remains immutable');
  assert.equal(snapshot.viewpoints[0].source_family_provenance_verified, true);
  assert.equal(snapshot.viewpoints[0].source_family_provenance_method, 'legacy_posthoc_attestation');
  assert.equal(snapshot.report.provenance_bound, 1);
  assert.equal(snapshot.access_applications[0].observational_outcome_eligible, false,
    'the attestation must not retroactively qualify an earlier exposure');
  const provenanceSnapshot = store.professionalViewpointProvenanceSnapshot();
  assert.deepEqual(provenanceSnapshot.report,
    { total: 1, replay_verified: 1, eligible_legacy_remaining: 0 });
  assert.equal(provenanceSnapshot.attestations[0].audit.complete_chain_verified, true);
  const revisionBeforeNoop = store.snapshotRevision();
  assert.equal(store.attestLegacyProfessionalViewpointProvenance().state,
    'no_eligible_legacy_viewpoint');
  assert.equal(store.snapshotRevision(), revisionBeforeNoop,
    'the recurring background check must not serialize state when no attestation is due');

  const afterPrompt = store.promptContext({ query: 'What predicts whether an ownerless task will move?',
    returnContextReceipt: true });
  const later = store.recordProfessionalViewpointAccessApplication({
    id: 'ix-after-attestation', created: '2026-07-19T19:31:00.000Z', channel: 'C0123456789',
    thread_ts: '1784490060.000001', ts: '1784490061.000001',
    trigger: 'What predicts whether an ownerless task will move?', text: 'Ownership is the stronger early signal.',
  }, afterPrompt.context_receipt.professional_viewpoints);
  assert.equal(later.observational_outcome_eligible, true,
    'only future access receipts become measurable');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('legacy provenance attestation fails closed under content or ledger tampering', async () => {
  const { dir, filePath, store } = await makeStore();
  formLegacyViewpoint(store);
  store.attestLegacyProfessionalViewpointProvenance();
  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const proposition = raw.cognition.epistemic_ledger.propositions[0];
  assert.equal(provenance.auditAttestation(
    proposition.source_family_provenance_attestation, proposition).complete_chain_verified, true);
  proposition.source_family_provenance_attestation.derived_evidence_family = 'slack_work_memory';
  fs.writeFileSync(filePath, JSON.stringify(raw));

  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(NOW) });
  await reloaded.init();
  const status = reloaded.earnedViewpointsSnapshot();
  assert.equal(status.current_verified, false);
  assert.deepEqual(status.viewpoints, [],
    'tampering with an attested source binding withholds the whole derived projection');
  assert.equal(reloaded.professionalViewpointProvenanceSnapshot().report.replay_verified, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
