'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerDreamRoutes } = require('../../src/routes/registerDreamRoutes');
const dreamInsight = require('../../src/intelligence/dream-insight');

function harness(studyActive = true, { dreams = [], clock = () => new Date() } = {}) {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'delete']) {
    app[method] = (path, ...handlers) => routes.set(`${method.toUpperCase()} ${path}`, handlers.at(-1));
  }
  registerDreamRoutes(app, {
    requireAuth: (_req, _res, next) => next?.(),
    requireEvaluatorAuth: (_req, _res, next) => next?.(),
    loadDreams: () => dreams,
    saveDreams: () => {},
    listExperiments: () => [],
    dreamInsightStudyActive: () => studyActive,
    MAX_DREAMS_KEPT: 120,
    clock,
  });
  const invoke = (method, path, req = {}) => {
    const output = { statusCode: 200, body: null };
    const res = {
      status(code) { output.statusCode = code; return this; },
      json(body) { output.body = body; return this; },
    };
    routes.get(`${method} ${path}`)({ query: {}, params: {}, body: {}, ...req }, res);
    return output;
  };
  return { invoke };
}

function sourceDreams() {
  return [
    { id: 'dream-a', date: '2026-07-01', finished: '2026-07-01T06:00:00.000Z',
      reflection: { ideas: ['Ownership gaps create silent handoff expiration.'] } },
    { id: 'dream-b', date: '2026-07-03', finished: '2026-07-03T06:00:00.000Z',
      reflection: { ideas: ['Unowned handoffs repeatedly expire without a visible escalation.'] } },
  ];
}

function candidateBody() {
  return {
    statement: 'Unowned handoffs may be the common cause of silent delivery expiration.',
    scope: 'process', confidence: 0.52,
    rationale: 'The same ownership mechanism recurred in two independently dated reflections.',
    expected_usefulness: 'Prioritizing missing ownership may expose delivery risk earlier.',
    falsification_criteria: ['Owned and unowned handoffs expire at the same observed rate.'],
    next_observation: 'Observe the next ordinary handoffs and record ownership plus expiration.',
    observation_plan: { window_days: 7, minimum_opportunities: 2,
      opportunity_definition: 'One naturally occurring handoff with ownership and delivery outcome recorded.' },
    source_ideas: [{ dream_id: 'dream-a', idea_index: 0 }, { dream_id: 'dream-b', idea_index: 0 }],
  };
}

test('active insight-synthesis study seals every subject-facing dream route', () => {
  const { invoke } = harness(true);
  const routes = [
    ['GET', '/dreams'],
    ['GET', '/dreams/:id'],
    ['GET', '/dream-idea-seeds'],
    ['GET', '/dream-insights'],
    ['POST', '/dream-insights'],
    ['POST', '/dream-insights/:id/resolve'],
    ['POST', '/dreams'],
    ['DELETE', '/dreams/:id'],
    ['POST', '/dreams/:id/restore'],
  ];
  for (const [method, path] of routes) {
    const response = invoke(method, path);
    assert.equal(response.statusCode, 423, `${method} ${path}`);
    assert.equal(response.body.experimental_access_sealed, true, `${method} ${path}`);
  }
});

test('independently authenticated insight review queue remains outside the subject seal', () => {
  const response = harness(true).invoke('GET', '/dream-insights/review-queue', {
    evaluatorId: 'independent-reviewer',
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { evaluator_id: 'independent-reviewer', insights: [] });
});

test('new insight candidates cannot resolve early or below their committed opportunity minimum', () => {
  const dreams = sourceDreams();
  let now = new Date('2026-07-10T06:00:00.000Z');
  const { invoke } = harness(false, { dreams, clock: () => now });
  const formed = invoke('POST', '/dream-insights', { body: candidateBody() });
  assert.equal(formed.statusCode, 200);
  const insight = formed.body.insight;
  assert.equal(insight.observation_plan.observation_started_at, '2026-07-10T06:00:00.000Z');
  assert.equal(insight.observation_plan.resolve_not_before, '2026-07-17T06:00:00.000Z');
  assert.equal(insight.audit.observation_plan_verified, true);

  const resolution = { outcome: 'supported', opportunities_observed: 2,
    observation: 'Two ordinary handoffs were observed with ownership and outcome recorded.',
    evidence: [{ type: 'teamwork_task', id: 'task-a' }] };
  let response = invoke('POST', '/dream-insights/:id/resolve', {
    params: { id: insight.id }, body: resolution,
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /observation_window_open/);

  now = new Date('2026-07-17T06:00:00.000Z');
  response = invoke('POST', '/dream-insights/:id/resolve', {
    params: { id: insight.id }, body: { ...resolution, opportunities_observed: 1 },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /at least 2 observed opportunities/);

  response = invoke('POST', '/dream-insights/:id/resolve', {
    params: { id: insight.id }, body: resolution,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.insight.audit.complete_chain_verified, true);
  assert.equal(response.body.insight.resolution_record.opportunities_observed, 2);
  const queue = invoke('GET', '/dream-insights/review-queue', {
    evaluatorId: 'independent-reviewer',
  });
  assert.equal(queue.body.insights[0].observation_plan.minimum_opportunities, 2);
  assert.equal(queue.body.insights[0].subject_observation.opportunities_observed, 2);
  const reviewed = invoke('POST', '/dream-insights/:id/review', {
    evaluatorId: 'independent-reviewer', params: { id: insight.id }, body: {
      outcome: 'supported',
      rationale: 'The independently checked records match the preregistered observation relation.',
      evidence: [{ type: 'independent_review', id: 'review-a' }],
    },
  });
  assert.equal(reviewed.statusCode, 200);
  assert.equal(reviewed.body.insight.status, 'independently_supported');
  assert.equal(reviewed.body.insight.audit.final_evidence_eligible, true);
});

test('historical candidates remain replay-valid and explicitly legacy unbounded', () => {
  const dreams = sourceDreams();
  const formation = { id: 'legacy-insight', statement: candidateBody().statement,
    scope: 'process', confidence: 0.52, rationale: candidateBody().rationale,
    expected_usefulness: candidateBody().expected_usefulness,
    falsification_criteria: candidateBody().falsification_criteria,
    next_observation: candidateBody().next_observation,
    source_ideas: [
      { dream_id: 'dream-a', dream_date: '2026-07-01', idea_index: 0,
        idea: dreams[0].reflection.ideas[0] },
      { dream_id: 'dream-b', dream_date: '2026-07-03', idea_index: 0,
        idea: dreams[1].reflection.ideas[0] },
    ], provenance_claim: 'submitted_as_nora_nightly_reflection',
    formed_at: '2026-07-03T07:00:00.000Z' };
  dreams[1].reflection.insight_candidates = [{ id: formation.id, statement: formation.statement,
    scope: formation.scope, confidence: formation.confidence, status: 'candidate',
    formed_at: formation.formed_at, formation_record: formation,
    formation_commitment: dreamInsight.commitment(formation), resolution_record: null,
    resolution_commitment: null, independent_review: null, independent_review_commitment: null }];
  const { invoke } = harness(false, { dreams,
    clock: () => new Date('2026-07-04T06:00:00.000Z') });
  const listed = invoke('GET', '/dream-insights');
  assert.equal(listed.body.insights[0].resolution_eligibility.reason, 'legacy_unbounded_candidate');
  assert.equal(listed.body.report.legacy_unbounded, 1);
  const resolved = invoke('POST', '/dream-insights/:id/resolve', {
    params: { id: formation.id }, body: { outcome: 'supported',
      observation: 'A later ordinary handoff expired while it remained unowned.',
      evidence: [{ type: 'teamwork_task', id: 'legacy-task' }] },
  });
  assert.equal(resolved.statusCode, 200);
  assert.equal(resolved.body.insight.audit.observation_protocol, 'legacy_unbounded');
  assert.equal(resolved.body.insight.audit.complete_chain_verified, true);
});

test('retired-role insight history cannot earn support and can be explicitly retired', () => {
  const dreams = [{ id: 'dream-role-a', date: '2026-07-01',
    finished: '2026-07-01T06:00:00.000Z', reflection: { ideas: [
      'The dev-dispatch pipeline repeatedly stalls on repository mapping.',
    ] } }, { id: 'dream-role-b', date: '2026-07-03',
    finished: '2026-07-03T06:00:00.000Z', reflection: { ideas: [
      'A repo-mapping standing fix could reduce recurring development dispatch no-ops.',
    ] } }];
  const formation = { id: 'retired-role-insight',
    statement: 'Development dispatch needs a standing repo-mapping repair.',
    scope: 'process', confidence: 0.4,
    rationale: 'Two historical dream records repeated the same now-retired operational concern.',
    expected_usefulness: 'It would have reduced repeated development-dispatch checks.',
    falsification_criteria: ['The retired run never occurs again.'],
    next_observation: 'Observe the next dev-dispatch run for the same mapping gap.',
    source_ideas: [
      { dream_id: 'dream-role-a', dream_date: '2026-07-01', idea_index: 0,
        idea: dreams[0].reflection.ideas[0] },
      { dream_id: 'dream-role-b', dream_date: '2026-07-03', idea_index: 0,
        idea: dreams[1].reflection.ideas[0] },
    ], provenance_claim: 'submitted_as_nora_nightly_reflection',
    formed_at: '2026-07-03T07:00:00.000Z' };
  dreams[1].reflection.insight_candidates = [{ id: formation.id, statement: formation.statement,
    scope: formation.scope, confidence: formation.confidence, status: 'candidate',
    formed_at: formation.formed_at, formation_record: formation,
    formation_commitment: dreamInsight.commitment(formation), resolution_record: null,
    resolution_commitment: null, independent_review: null, independent_review_commitment: null }];
  const { invoke } = harness(false, { dreams,
    clock: () => new Date('2026-07-04T06:00:00.000Z') });

  const listed = invoke('GET', '/dream-insights');
  assert.equal(listed.body.report.role_retired, 1);
  assert.equal(listed.body.insights[0].audit.complete_chain_verified, true);
  assert.equal(listed.body.insights[0].audit.role_eligibility.eligible, false);
  assert.equal(listed.body.insights[0].resolution_eligibility.reason, 'retired_role_residue');

  const evidence = [{ type: 'operational_role_boundary', id: 'development-dispatch-retired' }];
  const unsupported = invoke('POST', '/dream-insights/:id/resolve', {
    params: { id: formation.id }, body: { outcome: 'supported',
      observation: 'The historical condition is no longer part of Nora operational role.', evidence },
  });
  assert.equal(unsupported.statusCode, 400);
  assert.match(unsupported.body.error, /retired_role_residue/);

  const retired = invoke('POST', '/dream-insights/:id/resolve', {
    params: { id: formation.id }, body: { outcome: 'retired',
      observation: 'Development dispatch and repository follow-up were removed from Nora role.', evidence },
  });
  assert.equal(retired.statusCode, 200);
  assert.equal(retired.body.insight.status, 'retired');
  assert.equal(retired.body.insight.audit.complete_chain_verified, true);
  assert.equal(retired.body.insight.audit.final_evidence_eligible, false);
});
