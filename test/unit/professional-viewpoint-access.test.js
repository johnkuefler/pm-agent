'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

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
  const family = index === 1 ? 'qualitative-product-evidence' : 'delivery-outcome-evidence';
  const refs = [{ type: 'interaction', id: `${token}-interaction-${index}` }, { type: 'decision_trace', id: `${token}-trace-${index}` }];
  return store.recordEpistemicPosition({
    proposition_kind: 'professional_viewpoint', topic_key: `pm.${token}.judgment`,
    statement: `${token} decisions need an explicit falsification check before commitment.`,
    source_family: family, source_family_evidence: refs, owner_type: 'nora_belief', polarity: 'supports',
    confidence: 0.6, evidence: refs,
    rationale: `Repeated ${token} evidence improved when the team named what would disconfirm the recommendation.`,
    recorded_by: 'nora-nightly-reflection',
  });
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

test('production prompt construction atomically assigns and delivers professional viewpoint study packets', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(server, /professionalViewpointAvailable: intelligence\.professionalViewpointAccessAvailable\(trialConversationText\)/);
  assert.match(server, /professionalViewpointContextForAssignment\(contextAssignment, conversationText\)/);
  assert.match(server, /professionalViewpointContext,/);
  assert.ok(server.indexOf('professionalViewpointContextForAssignment') < server.indexOf('intelligence.promptContext({'));
});

test('professional viewpoint access isolates identity binding and fails closed under frozen-pool tampering', async () => {
  const { store, dir, filePath } = await makeStore();
  const views = [0, 1, 2].map(index => formViewpoint(store, index));
  assert.throws(() => store.createContextTrial(design(views.slice(0, 2).map(item => item.id), { id: 'too-small' })), /three to ten/);

  const trial = store.createContextTrial(design(views.map(item => item.id)));
  assert.deepEqual(trial.conditions, ['nora_bound_viewpoint', 'deidentified_same_viewpoint', 'viewpoint_absent']);
  assert.equal(trial.professional_viewpoint_pool, undefined);
  assert.equal(store.earnedViewpointsSnapshot().experimental_access_sealed, true);
  assert.equal(store.epistemicLedgerSnapshot().experimental_access_sealed, true);
  assert.doesNotMatch(store.promptContext({ query: 'integration recommendation' }), /Earned professional viewpoints/);

  const selected = [];
  const tokens = ['integration', 'discovery', 'handoff'];
  for (let index = 0; index < 5000 && !trial.conditions.every(condition => selected.filter(item => item.assignment.condition === condition).length >= 10); index++) {
    const query = `Give a PM recommendation about ${tokens[index % tokens.length]} risk`;
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `viewpoint-unit-${index}`,
      professionalViewpointAvailable: store.professionalViewpointAccessAvailable(query) });
    if (!assignment || selected.filter(item => item.assignment.condition === assignment.condition).length >= 10) continue;
    const context = store.professionalViewpointContextForAssignment(assignment, query);
    selected.push({ assignment, context });
  }
  assert.equal(selected.length, 30);
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
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.cognition.self_model.context_trials.find(item => item.id === trial.id).professional_viewpoint_pool[0].statement = 'Tampered frozen view.';
  fs.writeFileSync(filePath, JSON.stringify(raw));
  const { store: reloaded } = await makeStore(filePath);
  const tampered = reloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(tampered.professional_viewpoint_trial_audit.complete_chain_verified, false);
  assert.notEqual(reloaded.consciousnessResearchStatus().indicators
    .find(item => item.id === 'evidence_tested_professional_viewpoints').status, 'causal_signal_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});
