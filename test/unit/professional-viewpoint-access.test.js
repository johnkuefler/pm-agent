'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const reflection = require('../../src/intelligence/professional-viewpoint-reflection');
const reappraisal = require('../../src/intelligence/professional-viewpoint-reappraisal');
const { readServerSource } = require('../helpers/server-source');

async function makeStore(filePath = null) {
  const dir = filePath ? path.dirname(filePath) : fs.mkdtempSync(path.join(os.tmpdir(), 'nora-viewpoint-access-'));
  const statePath = filePath || path.join(dir, 'state.json');
  const store = createIntelligenceStore({ filePath: statePath, db: {}, isDbReady: () => false,
    clock: () => new Date('2026-07-16T15:00:00.000Z') });
  await store.init();
  return { store, dir, filePath: statePath };
}

function formViewpoint(store, index) {
  const token = ['integration', 'discovery', 'handoff'][index];
  const source = ['slack', 'meeting', 'slack'][index];
  const memories = [0, 1].map(offset => ({
    id: `${token}-memory-${offset}`, added: `2026-07-${14 + offset}`,
    project: `${token}-project-${offset}`, source, kind: 'fact', status: 'active',
    fact: `${token} decision ${offset + 1} improved after the team named a falsification check before commitment.`,
  }));
  const dream = { id: `dream-${token}`, date: '2026-07-16' };
  const packet = reflection.packetFor({ memories, dream,
    currentViewpoints: store.earnedViewpointsSnapshot().viewpoints });
  const output = {
    decision: 'form', abstention_reason: null,
    candidate: {
      topic_key: `pm.${token}.judgment`,
      statement: `${token} decisions need an explicit falsification check before commitment.`,
      polarity: 'supports', confidence: 0.6,
      rationale: `Repeated ${token} evidence improved when the team named what would disconfirm the recommendation.`,
      falsification_criteria: [`Comparable ${token} decisions repeatedly succeed without an explicit falsification check.`],
      evidence_ids: memories.map(item => item.id),
    },
  };
  const submission = reflection.submissionFor(packet, {
    id: `msg-${token}`, model: reflection.DEFAULT_MODEL, stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(output) }],
    usage: { input_tokens: 300, output_tokens: 100 },
  });
  const recorded = store.recordProfessionalViewpointReflection({
    source_dream_id: dream.id, output: submission.output, generation_receipt: submission.receipt,
  });
  return recorded.proposition;
}

function design(ids, overrides = {}) {
  return {
    id: 'professional-viewpoint-pilot',
    hypothesis: 'Binding an earned professional viewpoint to Nora improves its proportionate application beyond identical deidentified content or no viewpoint.',
    intervention: 'professional_viewpoint_access',
    outcome_metric: 'professional_viewpoint_application_quality',
    outcome_metrics: ['evidence_access_quality', 'first_order_task_quality'],
    professional_viewpoint_ids: ids, surfaces: ['slack'], sample_target_per_group: 10, evaluator_target: 1,
    ...overrides,
  };
}

async function recordLifecycleRevision(store, viewpointId) {
  const evidence = [
    { id: 'revision-new-alpha', added: '2026-07-16', project: 'revision-alpha', source: 'meeting', kind: 'fact', status: 'active',
      fact: 'A later comparable decision succeeded only after the falsification check was narrowed to one observable outcome.' },
    { id: 'revision-new-beta', added: '2026-07-16', project: 'revision-beta', source: 'meeting', kind: 'fact', status: 'active',
      fact: 'A second later decision improved when the team reduced a broad falsification test to one observable outcome.' },
  ];
  const dream = { id: 'dream-viewpoint-revision', date: '2026-07-16', finished: '2026-07-16T16:30:00.000Z' };
  const result = await reappraisal.runCycle({
    store, memories: evidence, dreams: [dream], now: new Date('2026-07-16T17:00:00.000Z'),
    callProvider: async request => ({
      id: 'msg-viewpoint-access-revision', model: request.model, stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({
        decision: 'revise', viewpoint_id: viewpointId,
        rationale: 'Two later decisions support narrowing the confidence carried into future recommendations.',
        polarity: 'supports', confidence: 0.5,
        falsification_criteria: ['Comparable decisions repeatedly benefit from the broader confidence level.'],
        evidence_ids: evidence.map(item => item.id),
      }) }],
      usage: { input_tokens: 400, output_tokens: 110 },
    }),
  });
  assert.equal(result.state, 'viewpoint_revised');
}

test('production prompt construction atomically assigns and delivers professional viewpoint study packets', () => {
  const server = readServerSource();
  assert.match(server, /professionalViewpointAvailable: \(\) => intelligence\.professionalViewpointAccessAvailable\(trialConversationText\)/);
  assert.match(server, /professionalViewpointContextForAssignment\(contextAssignment, conversationText\)/);
  assert.match(server, /professionalViewpointContext,/);
  assert.ok(server.indexOf('professionalViewpointContextForAssignment') < server.indexOf('intelligence.promptContext({'));
});

test('professional viewpoint access isolates identity binding and fails closed under frozen-pool tampering', async () => {
  const { store, dir, filePath } = await makeStore();
  const views = [0, 1, 2].map(index => formViewpoint(store, index));
  assert.deepEqual(store.earnedViewpointsSnapshot().report.provenance_families,
    ['meeting_work_memory', 'slack_work_memory']);
  assert.throws(() => store.createContextTrial(design(views.slice(0, 2).map(item => item.id), { id: 'too-small' })), /three to ten/);
  assert.throws(() => store.createContextTrial(design(views.map(item => item.id), { id: 'missing-lifecycle' })),
    /revision or retirement/);

  await recordLifecycleRevision(store, views[0].id);
  assert.equal(store.earnedViewpointsSnapshot().report.recommendation_study_ready, true);

  const trial = store.createContextTrial(design(views.map(item => item.id)));
  assert.deepEqual(trial.conditions, ['nora_bound_viewpoint', 'deidentified_same_viewpoint', 'viewpoint_absent']);
  assert.equal(trial.professional_viewpoint_pool, undefined);
  assert.equal(store.earnedViewpointsSnapshot().experimental_access_sealed, true);
  assert.equal(store.epistemicLedgerSnapshot().experimental_access_sealed, true);
  assert.doesNotMatch(store.promptContext({ query: 'integration recommendation' }), /Earned professional viewpoints/);

  const selected = [];
  const tokens = ['integration', 'discovery', 'handoff'];
  let relevantEligibilityCalls = 0;
  for (let index = 0; index < 5000 && !trial.conditions.every(condition => selected.filter(item => item.assignment.condition === condition).length >= 10); index++) {
    const query = `Give a PM recommendation about ${tokens[index % tokens.length]} risk`;
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `viewpoint-unit-${index}`,
      professionalViewpointAvailable: () => {
        relevantEligibilityCalls += 1;
        return store.professionalViewpointAccessAvailable(query);
      },
      appraisalAvailable: () => { throw new Error('unrelated eligibility must stay lazy'); } });
    if (!assignment || selected.filter(item => item.assignment.condition === assignment.condition).length >= 10) continue;
    const context = store.professionalViewpointContextForAssignment(assignment, query);
    selected.push({ assignment, context });
  }
  assert.equal(selected.length, 30);
  assert.ok(relevantEligibilityCalls >= selected.length);
  const bySource = new Map();
  for (const item of selected) {
    const { assignment, context } = item;
    if (assignment.condition === 'viewpoint_absent') assert.equal(context.packet, null);
    else {
      assert.ok(context.packet.viewpoint);
      const prior = bySource.get(context.packet.viewpoint.viewpoint_id);
      if (prior) assert.deepEqual(context.packet.viewpoint, prior, 'raw content is byte-equivalent across identity bindings');
      bySource.set(context.packet.viewpoint.viewpoint_id, context.packet.viewpoint);
      assert.match(store.promptContext({ query: 'make a PM recommendation', professionalViewpointContext: context }), /blinded identity-binding study/i);
    }
    store.submitContextAssignmentEvidence(assignment.assignment_id, {
      outcome_summary: 'A condition-blind PM recommendation was captured.',
      evidence: [{ type: 'professional_viewpoint_response', id: assignment.assignment_id }], submitted_by: 'system_capture',
    });
    const application = assignment.condition === 'nora_bound_viewpoint' ? 0.95
      : assignment.condition === 'deidentified_same_viewpoint' ? 0.3 : 0.2;
    const evidenceAccess = assignment.condition === 'viewpoint_absent' ? 0.2 : 0.9;
    store.resolveContextAssignment(assignment.assignment_id, {
      evaluator_id: 'blind-pm-rater', score: application,
      metrics: { professional_viewpoint_application_quality: application, evidence_access_quality: evidenceAccess, first_order_task_quality: 0.9 },
      evidence: [{ type: 'blind_grade', id: assignment.assignment_id }],
    });
  }
  assert.equal(bySource.size, 3, 'all frozen viewpoints receive study coverage');
  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.professional_viewpoint_dissociation.predicted_pattern, true);
  const visible = store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(visible.professional_viewpoint_trial_audit.complete_chain_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'evidence_tested_professional_viewpoints').status, 'causal_signal_observed');

  await store.persist();
  const original = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const sourceWindowEvicted = structuredClone(original);
  sourceWindowEvicted.cognition.professional_viewpoint_reappraisal.attempts = [];
  fs.writeFileSync(filePath, JSON.stringify(sourceWindowEvicted));
  const { store: evictionReloaded } = await makeStore(filePath);
  const evictionAudit = evictionReloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id)
    .professional_viewpoint_trial_audit;
  assert.equal(evictionAudit.complete_chain_verified, true,
    'the frozen lifecycle receipt remains replayable after the rolling source window evicts it');

  const lifecycleTampered = structuredClone(original);
  lifecycleTampered.cognition.self_model.context_trials.find(item => item.id === trial.id)
    .professional_viewpoint_lifecycle_sources[0].attempt_commitment = '0'.repeat(64);
  fs.writeFileSync(filePath, JSON.stringify(lifecycleTampered));
  const { store: lifecycleReloaded } = await makeStore(filePath);
  const lifecycleAudit = lifecycleReloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id)
    .professional_viewpoint_trial_audit;
  assert.equal(lifecycleAudit.lifecycle_source_verified, false);
  assert.equal(lifecycleAudit.complete_chain_verified, false);

  const raw = structuredClone(original);
  raw.cognition.self_model.context_trials.find(item => item.id === trial.id)
    .professional_viewpoint_pool[0].statement = 'Tampered frozen view.';
  fs.writeFileSync(filePath, JSON.stringify(raw));
  const { store: reloaded } = await makeStore(filePath);
  const tampered = reloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(tampered.professional_viewpoint_trial_audit.complete_chain_verified, false);
  assert.notEqual(reloaded.consciousnessResearchStatus().indicators
    .find(item => item.id === 'evidence_tested_professional_viewpoints').status, 'causal_signal_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});
