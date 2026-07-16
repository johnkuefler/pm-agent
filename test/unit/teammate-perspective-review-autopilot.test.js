'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const teammatePerspective = require('../../src/intelligence/teammate-perspective');
const slackEvidence = require('../../src/intelligence/slack-evidence');
const autopilot = require('../../src/intelligence/teammate-perspective-review-autopilot');

function slackRef(iso, micros = '000001') {
  const seconds = Math.floor(new Date(iso).getTime() / 1000);
  const ts = `${seconds}.${micros}`;
  return { type: 'slack_message', id: `C12345678:${ts}:${ts}` };
}

async function fixture(suffix = 'a') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-perspective-review-'));
  let now = new Date('2026-07-16T10:00:00.000Z');
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: () => new Date(now) });
  await store.init();
  const formationEvidence = slackRef('2026-07-16T09:55:00.000Z', suffix === 'a' ? '000001' : '000002');
  const outcomeEvidence = slackRef(suffix === 'd'
    ? '2026-07-18T12:00:00.000Z' : '2026-07-16T12:00:00.000Z',
  suffix === 'a' ? '000001' : '000002');
  const perspective = store.observePerspective({
    id: `perspective-provider-review-${suffix}`, name: 'John Kuefler',
    hypothesis: 'John may ask for the decision risks before approving the next bounded launch recommendation.',
    dimension: 'decision_concern', confidence: 0.6, evidence: [formationEvidence],
    prediction: {
      observable: 'John explicitly asks for the decision risks before approving the launch recommendation.',
      due_at: '2026-07-17T10:00:00.000Z', probability: 0.7, control_probability: 0.5,
      falsification_criteria: ['John approves the recommendation without asking about decision risks.'],
    },
  });
  now = new Date('2026-07-16T12:05:00.000Z');
  store.resolvePerspective(perspective.id, {
    outcome: 'supported',
    observed: 'John explicitly asked which launch risks remained before he approved the recommendation.',
    evidence: [outcomeEvidence], confounds: [],
  });
  return { dir, store, perspective, outcomeEvidence,
    setNow(value) { now = new Date(value); } };
}

function snapshot(ref, overrides = {}) {
  const parsed = slackEvidence.parseCanonicalMessageRef(ref);
  return {
    evidence_ref: ref, channel: parsed.channel, thread_ts: parsed.thread_ts,
    message_ts: parsed.message_ts, author_id: 'UJYKB4788', author_name: 'John Kuefler',
    author_name_verified: true,
    text: 'Which launch risks remain before I approve this recommendation?', edited_ts: null,
    ...overrides,
  };
}

function modelResponse({ role, evidenceId, outcome = 'supported' }) {
  const fields = outcome === 'supported'
    ? { person_identity_match: 'confirmed', observable_result: 'observed',
      confound_assessment: 'none_material', supports_resolution: true }
    : outcome === 'contradicted'
      ? { person_identity_match: 'confirmed', observable_result: 'falsified',
        confound_assessment: 'none_material', supports_resolution: true }
      : { person_identity_match: 'unresolved', observable_result: 'unresolved',
        confound_assessment: 'unresolved', supports_resolution: false };
  const output = {
    outcome, person_identity_match: fields.person_identity_match,
    observable_result: fields.observable_result, confound_assessment: fields.confound_assessment,
    evidence_assessments: [{ evidence_id: evidenceId,
      supports_resolution: fields.supports_resolution,
      observation: outcome === 'supported'
        ? 'The verified author asks about launch risks before approval inside the frozen window.'
        : outcome === 'contradicted'
          ? 'The verified author approves without requesting the preregistered risk information.'
          : 'The exact evidence does not resolve identity, timing, or the preregistered observable.' }],
    rationale: outcome === 'supported'
      ? 'The verified person performs the preregistered observable within the frozen time window without a material confound.'
      : outcome === 'contradicted'
        ? 'The verified person performs the preregistered falsifier within the frozen time window.'
        : 'The evidence leaves at least one required dimension unresolved, so the prediction cannot be scored.',
  };
  return {
    id: `resp-perspective-${role}-${outcome}`, model: autopilot.DEFAULT_MODEL,
    status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
      text: JSON.stringify(output) }] }], usage: { input_tokens: 120, output_tokens: 70 },
  };
}

test('provider-disjoint consensus reviews exact prospective evidence without Nora outcome anchoring', async () => {
  const f = await fixture('a');
  const candidate = f.store.perspectiveReviewQueue()[0];
  assert.equal(candidate.formed_at, '2026-07-16T10:00:00.000Z');
  const exactSnapshot = snapshot(f.outcomeEvidence);
  const built = autopilot.buildReviewRequest(candidate, [exactSnapshot]);
  assert.equal(built.request.store, false);
  assert.equal(built.request.text.format.type, 'json_schema');
  assert.equal(built.request.text.format.strict, true);
  assert.equal(built.packet.subject_observation, undefined);
  assert.equal(JSON.stringify(built.packet).includes(candidate.subject_observation.observed), false);
  assert.equal(JSON.stringify(built.packet).includes('"outcome":"supported"'), false);

  const requests = [];
  const result = await autopilot.runCycle({
    store: f.store,
    readEvidence: async ref => snapshot(ref),
    callProvider: async (request, meta) => {
      requests.push({ request, meta });
      return modelResponse({ role: meta.role, evidenceId: f.outcomeEvidence.id });
    },
  });
  assert.equal(result.state, 'reviewed');
  assert.equal(result.reviewed, 1);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(item => item.request.store === false));
  assert.ok(requests.every(item => !item.request.input[1].content
    .includes(candidate.subject_observation.observed)));

  const record = f.store.snapshot().relationships[0].perspectives[0];
  const audit = teammatePerspective.auditPerspective(record, 'John Kuefler');
  assert.equal(record.status, 'independently_supported');
  assert.equal(audit.final_evidence_eligible, true);
  assert.equal(audit.automated_review_receipt_verified, true);
  assert.equal(record.independent_review.automated_review_receipt.subject_outcome_blind, true);
  assert.equal(record.independent_review.automated_review_receipt.reviews.length, 2);
  const indicator = f.store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'calibrated_teammate_perspective');
  assert.equal(indicator.evidence.provider_disjoint_outcome_blind_consensus_reviews, 1);

  const receipt = structuredClone(record.independent_review.automated_review_receipt);
  receipt.subject_outcome_blind = false;
  assert.equal(teammatePerspective.validAutomatedReviewReceipt(receipt,
    record.independent_review.evidence, record.independent_review.outcome,
    record.independent_review.evaluator_id), false);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('role disagreement becomes inconclusive while late or identity-unverified support fails closed', async () => {
  const disagreement = await fixture('b');
  const disagreed = await autopilot.runCycle({
    store: disagreement.store, readEvidence: async ref => snapshot(ref),
    callProvider: async (_request, meta) => modelResponse({ role: meta.role,
      evidenceId: disagreement.outcomeEvidence.id,
      outcome: meta.role === 'evidence_first' ? 'supported' : 'unclear' }),
  });
  assert.equal(disagreed.reviewed, 1);
  const disagreedRecord = disagreement.store.snapshot().relationships[0].perspectives[0];
  assert.equal(disagreedRecord.status, 'inconclusive');
  assert.equal(teammatePerspective.auditPerspective(disagreedRecord, 'John Kuefler')
    .complete_chain_verified, true);
  fs.rmSync(disagreement.dir, { recursive: true, force: true });

  for (const [suffix, overrides] of [
    ['c', { author_name_verified: false }],
    ['d', {}],
  ]) {
    const f = await fixture(suffix);
    const failed = await autopilot.runCycle({
      store: f.store, readEvidence: async ref => snapshot(ref, overrides),
      callProvider: async (_request, meta) => modelResponse({ role: meta.role,
        evidenceId: f.outcomeEvidence.id }),
    });
    assert.equal(failed.reviewed, 0);
    assert.equal(failed.state, 'failed_closed');
    assert.equal(f.store.perspectiveReviewQueue().length, 1);
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('runtime config requires provider and Slack readback credentials', () => {
  const { __test } = require('../../server');
  assert.equal(__test.teammatePerspectiveReviewAutopilotRuntimeConfig({
    OPENAI_API_KEY: 'configured', SLACK_BOT_TOKEN: 'configured', NORA_TEST_MODE: '0',
  }).enabled, true);
  assert.equal(__test.teammatePerspectiveReviewAutopilotRuntimeConfig({
    OPENAI_API_KEY: 'configured', SLACK_BOT_TOKEN: 'configured', NORA_TEST_MODE: '1',
  }).enabled, false);
});
