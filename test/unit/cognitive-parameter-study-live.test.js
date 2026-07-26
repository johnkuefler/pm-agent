'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-dials-live-'));
process.env.NORA_TEST_MODE = '1';
process.env.NORA_DATA_DIR = dataDir;
delete process.env.DATABASE_URL;
delete process.env.DATABASE_PUBLIC_URL;

const { __test } = require('../../server');
const { readServerSource } = require('../helpers/server-source');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('live Slack prompt applies one sealed DIALS assignment without changing the global document', () => {
  const before = __test.cognitiveParameterSnapshot({ includeHistory: false });
  __test.intelligenceStore.createCognitiveParameterStudy({
    id: 'dial-live-wiring-pilot', created_by: 'test-research-owner', study_phase: 'pilot',
    parameter_path: 'workspace.relevance_per_term', candidate_value: 2.4,
    minimum_samples_per_arm: 10, maximum_assignments: 40,
    evaluation_window_days: 14, minimum_effect: 0.08, guard_minimum_rate: 0.9,
  });

  const diagnostic = __test.buildSystemPrompt('slack', null, null,
    { source: 'slack', requester: { name: 'John' } }, {
      cacheSplit: true, sideEffectFree: true, latencyCritical: true,
      conversationText: 'status check', semanticMemories: [], trialUnitKey: 'diagnostic-turn',
      cognitiveParameterStudiesEnabled: true, captureIntelligenceReceipt: true,
    });
  assert.equal(diagnostic.cognitiveParameterAssignment, null);
  assert.equal(diagnostic.diagnostics.cognitive_parameter_assignment_present, false);
  assert.equal(__test.intelligenceStore.cognitiveParameterStudiesSnapshot().studies[0].assignments, 0);

  const live = __test.buildSystemPrompt('slack', null, null,
    { source: 'slack', requester: { name: 'John' } }, {
      cacheSplit: true, latencyCritical: true, contextTrialsEnabled: false,
      conversationText: 'what is most relevant for launch qa', semanticMemories: [],
      trialUnitKey: 'slack:C1:1700000000.001', cognitiveParameterStudiesEnabled: true,
      captureIntelligenceReceipt: true, procedureCandidatesAvailable: true,
      exemplarsAvailable: true,
    });
  assert.ok(live.cognitiveParameterAssignment?.assignment_id);
  assert.equal(live.diagnostics.cognitive_parameter_assignment_present, true);
  assert.equal(live.diagnostics.within_budget, true);
  assert.equal(live.intelligenceContextReceipt.cognitive_parameter_assignment.assignment_id,
    live.cognitiveParameterAssignment.assignment_id);
  assert.match(live.intelligenceContextReceipt.workspace_commitment, /^[a-f0-9]{64}$/);

  const publicStudy = __test.intelligenceStore.cognitiveParameterStudiesSnapshot().studies[0];
  assert.equal(publicStudy.conditions_sealed, true);
  assert.equal(publicStudy.assignments, 1);
  assert.equal(JSON.stringify(publicStudy).includes('workspace.relevance_per_term'), false);
  assert.equal(JSON.stringify(publicStudy).includes('applied_value'), false);
  const after = __test.cognitiveParameterSnapshot({ includeHistory: false });
  assert.equal(after.current.content_commitment, before.current.content_commitment);
  assert.equal(after.status.revision, before.status.revision);
});

test('DIALS study machinery has no foreground provider, embedding, database, or network client', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'intelligence',
    'cognitive-parameter-study.js'), 'utf8');
  assert.doesNotMatch(source,
    /fetch\(|axios|anthropic|openai|pgvector|\bembed(?:ding)?\s*\(|\bdb\./i);
  const serverSource = readServerSource();
  assert.match(serverSource, /cognitiveParameterStudiesEnabled: mode === 'normal' && isDirect/);
  assert.match(serverSource, /interactive_latency: slackLatencyTrace\?\.outcome \|\| null/);
  assert.match(serverSource, /resolveCognitiveParameterAssignmentOutcome/);
  assert.match(serverSource, /excludeCognitiveParameterAssignment/);
});
