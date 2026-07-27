'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const workspace = require('../../src/intelligence/conscious-workspace');
const {
  registerConsciousWorkspaceRoutes,
} = require('../../src/routes/registerConsciousWorkspaceRoutes');

function candidate(key, priority, authorityClass) {
  return {
    key,
    type: key.startsWith('uncertainty:') ? 'uncertainty' : 'task',
    label: key,
    priority,
    ...(authorityClass ? { authority_class: authorityClass } : {}),
    evidence: [{ type: 'test_source', id: `${key}-evidence` }],
  };
}

function frameInput(overrides = {}) {
  return {
    id: 'cw-route-test',
    mode: 'operational',
    current_activity: 'Choose the best bounded next step.',
    why_this: 'Three evidence-backed alternatives need explicit arbitration.',
    attention_candidates: [
      candidate('task:first', 0.8),
      candidate('uncertainty:second', 0.6),
      candidate('task:third', 0.4),
    ],
    selected_focus_key: 'task:first',
    evidence: [{ type: 'test_cycle', id: 'cycle-route-test' }],
    created_by: 'John',
    ...overrides,
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function setup(overrides = {}) {
  const registrations = {};
  const app = {
    get(path, ...handlers) { registrations[`GET ${path}`] = handlers; },
    post(path, ...handlers) { registrations[`POST ${path}`] = handlers; },
  };
  let ledger = structuredClone(overrides.initialLedger || workspace.emptyLedger());
  let saves = 0;
  let operatorChecks = 0;
  const requireOperatorAuth = typeof overrides.requireOperatorAuth === 'function'
    ? overrides.requireOperatorAuth
    : (req, res, next) => {
      operatorChecks += 1;
      if (req.headers?.['x-test-operator'] === 'approved') {
        req.operatorAuthority = 'dashboard';
        return next();
      }
      return res.status(401).json({ error: 'operator approval required' });
    };
  const deps = {
    requireAuth: (_req, _res, next) => next(),
    loadConsciousWorkspace: () => ledger,
    saveConsciousWorkspace: async next => {
      ledger = structuredClone(next);
      saves += 1;
    },
    loadInteractions: () => overrides.interactions || [],
    verifyAutomatedReviewReceipt: overrides.verifyAutomatedReviewReceipt
      || ((_interaction, receipt) => receipt?.valid === true),
  };
  if (overrides.operatorAuthConfigured !== false) deps.requireOperatorAuth = requireOperatorAuth;
  registerConsciousWorkspaceRoutes(app, deps);

  async function request(key, body, headers = {}) {
    const req = { body, headers, query: {}, params: {} };
    const res = responseRecorder();
    const handlers = registrations[key];
    let index = 0;
    async function dispatch() {
      const handler = handlers[index++];
      if (!handler || res.body != null) return;
      await handler(req, res, dispatch);
    }
    await dispatch();
    return { req, res };
  }

  return {
    registrations,
    request,
    state: () => ({ ledger, saves, operatorChecks }),
  };
}

test('autonomous workspace frames are optional-authority and server-attributed', async () => {
  const fixture = setup();
  const result = await fixture.request('POST /conscious-workspace/frames', frameInput());
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.res.body.ok, true);
  assert.equal(result.res.body.frame.created_by, 'Nora autonomous');
  assert.deepEqual(result.res.body.frame.attention_candidates.map(item => item.authority_class),
    ['optional', 'optional', 'optional']);
  assert.equal(fixture.state().operatorChecks, 0);
  assert.equal(fixture.state().saves, 1);
});

test('bounded and required API authority need a signed operator and actor is server-stamped', async () => {
  const fixture = setup();
  const privileged = frameInput({
    id: 'cw-privileged',
    attention_candidates: [
      candidate('task:first', 0.8, 'required'),
      candidate('uncertainty:second', 0.6, 'bounded'),
      candidate('task:third', 0.4, 'optional'),
    ],
  });
  const denied = await fixture.request('POST /conscious-workspace/frames', privileged);
  assert.equal(denied.res.statusCode, 401);
  assert.equal(fixture.state().saves, 0);

  const approved = await fixture.request('POST /conscious-workspace/frames', privileged,
    { 'x-test-operator': 'approved' });
  assert.equal(approved.res.statusCode, 200);
  assert.equal(approved.res.body.frame.created_by, 'Dashboard operator');
  assert.deepEqual(approved.res.body.frame.attention_candidates.map(item => item.authority_class),
    ['required', 'bounded', 'optional']);
  assert.equal(fixture.state().operatorChecks, 2);
  assert.equal(fixture.state().saves, 1);
});

test('API callers cannot reserve or supply server lifecycle state', async () => {
  const fixture = setup();
  const suppliedLifecycle = await fixture.request('POST /conscious-workspace/frames', frameInput({
    lifecycle: { cycle_id: 'forged-cycle', phase: 'operations' },
  }), { 'x-test-operator': 'approved' });
  assert.equal(suppliedLifecycle.res.statusCode, 400);
  assert.match(suppliedLifecycle.res.body.error, /lifecycle is server-derived/);

  const reservedId = await fixture.request('POST /conscious-workspace/frames', frameInput({
    id: 'cw-lifecycle-forged-cycle-operations',
  }));
  assert.equal(reservedId.res.statusCode, 400);
  assert.match(reservedId.res.body.error, /ids are reserved/);
  assert.equal(fixture.state().operatorChecks, 0);
  assert.equal(fixture.state().saves, 0);
});

test('autonomous revisions preserve a privileged prior winner instead of downgrading it', async () => {
  const cycleId = 'cycle-authority-floor';
  const prior = workspace.createFrame(frameInput({
    id: `cw-lifecycle-${cycleId}-operations`,
    attention_candidates: [
      candidate('task:required-obligation', 0.8, 'required'),
      candidate('uncertainty:second', 0.6, 'optional'),
      candidate('task:third', 0.4, 'optional'),
    ],
    selected_focus_key: 'task:required-obligation',
    lifecycle: { cycle_id: cycleId, phase: 'operations' },
    evidence: [{ type: 'intelligence_cycle', id: cycleId }],
    created_by: 'Nora runtime',
  }));
  const withFeedback = workspace.addFeedback({
    frame_id: prior.frame.id,
    signal: 'Later evidence redirects the discretionary alternative but cannot erase the obligation.',
    effect: 'redirected',
    evidence: [{ type: 'reviewed_source', id: 'review-authority-floor' }],
  }, prior.ledger);
  const fixture = setup({ initialLedger: withFeedback.ledger });
  const revised = await fixture.request('POST /conscious-workspace/frames', frameInput({
    id: 'cw-authority-floor-revision',
    revision_of_frame_id: prior.frame.id,
    attention_candidates: [
      {
        ...candidate('task:required-obligation', 0.1),
        label: 'Caller tried to rewrite and downgrade the required obligation.',
      },
      {
        ...candidate('uncertainty:second', 1),
        feedback_refs: [{ type: 'workspace_feedback', id: withFeedback.feedback.id }],
      },
      candidate('task:third', 0.4),
    ],
    selected_focus_key: 'uncertainty:second',
  }));
  assert.equal(revised.res.statusCode, 200);
  const inherited = revised.res.body.frame.attention_candidates
    .find(item => item.key === 'task:required-obligation');
  assert.equal(inherited.authority_class, 'required');
  assert.equal(inherited.label, 'task:required-obligation');
  assert.equal(revised.res.body.frame.selected_focus_key, 'task:required-obligation');
  assert.equal(revised.res.body.frame.created_by, 'Nora autonomous');
});

test('duplicate candidate keys are rejected before arbitration', async () => {
  const fixture = setup();
  const duplicated = await fixture.request('POST /conscious-workspace/frames', frameInput({
    attention_candidates: [
      candidate('task:same', 0.8),
      candidate('task:same', 0.6),
      candidate('task:third', 0.4),
    ],
  }));
  assert.equal(duplicated.res.statusCode, 400);
  assert.match(duplicated.res.body.error, /keys must be unique/);
  assert.equal(fixture.state().saves, 0);
});

test('autonomous feedback is derived from a replay-verified outcome, not caller prose', async () => {
  const reviewCommitment = 'a'.repeat(64);
  const interaction = {
    id: 'interaction-corrected',
    reviewed: true,
    outcome: 'corrected',
    signal: 'The teammate supplied a newer source and corrected the proposed deadline.',
    reviewed_at: '2099-07-26T12:00:00.000Z',
    automated_review_receipt: { valid: true, receipt_commitment: reviewCommitment },
  };
  const fixture = setup({ interactions: [interaction] });
  await fixture.request('POST /conscious-workspace/frames', frameInput());
  const result = await fixture.request('POST /conscious-workspace/feedback', {
    frame_id: 'cw-route-test',
    signal: 'Fabricated praise from the caller.',
    effect: 'redirected',
    evidence: [{ type: 'interaction', id: interaction.id }],
    recorded_by: 'John',
  });
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.res.body.feedback.signal, interaction.signal);
  assert.equal(result.res.body.feedback.effect, 'redirected');
  assert.equal(result.res.body.feedback.recorded_by, 'Nora verified outcome');
  assert.deepEqual(result.res.body.feedback.evidence, [{
    type: 'interaction',
    id: interaction.id,
    note: `replay-verified automated review ${reviewCommitment}`,
  }]);
  assert.equal(fixture.state().operatorChecks, 0);
});

test('a replay-valid but older outcome cannot be recycled as later workspace feedback', async () => {
  const interaction = {
    id: 'interaction-before-frame',
    reviewed: true,
    outcome: 'corrected',
    signal: 'This outcome predates the workspace frame.',
    reviewed_at: '2000-01-01T00:00:00.000Z',
    automated_review_receipt: { valid: true, receipt_commitment: 'b'.repeat(64) },
  };
  const fixture = setup({ interactions: [interaction] });
  await fixture.request('POST /conscious-workspace/frames', frameInput());
  const denied = await fixture.request('POST /conscious-workspace/feedback', {
    frame_id: 'cw-route-test',
    evidence: [{ type: 'interaction', id: interaction.id }],
  });
  assert.equal(denied.res.statusCode, 401);
  assert.equal(fixture.state().operatorChecks, 1);
});

test('unverified feedback fails closed unless a signed operator supplies it', async () => {
  const fixture = setup();
  await fixture.request('POST /conscious-workspace/frames', frameInput());
  const input = {
    frame_id: 'cw-route-test',
    signal: 'A human reviewed the exact source and found the premise was wrong.',
    effect: 'contradicted',
    evidence: [{ type: 'task_review', id: 'review-1' }],
    recorded_by: 'Spoofed operator',
  };
  const denied = await fixture.request('POST /conscious-workspace/feedback', input);
  assert.equal(denied.res.statusCode, 401);
  const approved = await fixture.request('POST /conscious-workspace/feedback', input,
    { 'x-test-operator': 'approved' });
  assert.equal(approved.res.statusCode, 200);
  assert.equal(approved.res.body.feedback.signal, input.signal);
  assert.equal(approved.res.body.feedback.effect, 'contradicted');
  assert.equal(approved.res.body.feedback.recorded_by, 'Dashboard operator');
});

test('privileged workspace writes fail closed when operator auth is not configured', async () => {
  const fixture = setup({ operatorAuthConfigured: false });
  const denied = await fixture.request('POST /conscious-workspace/frames', frameInput({
    attention_candidates: [
      candidate('task:first', 0.8, 'required'),
      candidate('uncertainty:second', 0.6, 'optional'),
      candidate('task:third', 0.4, 'optional'),
    ],
  }));
  assert.equal(denied.res.statusCode, 503);
  assert.match(denied.res.body.error, /operator authentication is not configured/);
});

test('focus commitment actor is server-owned while internal lifecycle frames remain usable', async () => {
  const cycleId = 'cycle-internal-lifecycle';
  const internal = workspace.createFrame(frameInput({
    id: `cw-lifecycle-${cycleId}-operations`,
    attention_candidates: [
      candidate('task:first', 0.8, 'bounded'),
      candidate('uncertainty:second', 0.6, 'optional'),
      candidate('task:third', 0.4, 'optional'),
    ],
    lifecycle: { cycle_id: cycleId, phase: 'operations' },
    evidence: [{ type: 'intelligence_cycle', id: cycleId }],
    created_by: 'Nora runtime',
  }));
  const fixture = setup({ initialLedger: internal.ledger });
  const result = await fixture.request('POST /conscious-workspace/focus-commitments', {
    frame_id: internal.frame.id,
    selected_focus_key: internal.frame.selected_focus_key,
    disposition: 'follow_after_required_checks',
    planned_expression: 'Check the exact task evidence before taking the bounded next step.',
    evidence: [{ type: 'intelligence_cycle', id: cycleId }],
    committed_by: 'John',
  });
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.res.body.focus_commitment.committed_by, 'Nora autonomous');
  assert.equal(result.res.body.focus_commitment.audit.complete_chain_verified, true);
});
