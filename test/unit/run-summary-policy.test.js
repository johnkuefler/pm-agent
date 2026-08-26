'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRunSummary, recordRunSummaryEvaluation } = require('../../src/intelligence/run-summary-policy');

const EVIDENCE = [{ type: 'teamwork_task', ref: 'tw-40708119' }];

test('quiet checks, idle research, bookkeeping, and watchlists stay private', () => {
  const result = evaluateRunSummary({
    recipient: 'John',
    signals: [
      { kind: 'quiet_check', description: 'No tasks, unread mail, or missed mentions.' },
      { kind: 'idle_research', description: 'An idle round found old project details.',
        materiality: 1, recipient_needs_to_know: true, evidence: EVIDENCE },
      { kind: 'bookkeeping', description: 'Cleaned up project records.' },
      { kind: 'watchlist', description: 'Several stale tasks remain open.', evidence: EVIDENCE },
    ],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.classification, 'suppressed');
  assert.equal(result.private_signal_count, 4);
  assert.match(result.reasons.join(' '), /stays private/);
});

test('a discovered project concern is not an hourly DM without a new bounded action', () => {
  const result = evaluateRunSummary({
    recipient: 'John',
    signals: [{
      kind: 'new_risk',
      description: 'A fixed-date printed asset points at an unowned landing-page dependency.',
      severity: 'high',
      materiality: 0.9,
      new_information: true,
      evidence: EVIDENCE,
    }],
  });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(' '), /private control picture/);
});

test('verified requested delivery can return to its requester without spending proactive attention', () => {
  const result = evaluateRunSummary({
    recipient: 'John',
    signals: [{
      kind: 'requested_delivery',
      description: 'The five requested task lists were built and verified.',
      materiality: 0.9,
      requested_by_recipient: true,
      recipient_needs_to_know: true,
      evidence: [{ type: 'teamwork_tasklist', ref: '4241792' }],
    }],
  });
  assert.equal(result.allowed, true);
  assert.equal(result.classification, 'requested_delivery');
  assert.equal(result.uses_human_budget, false);
});

test('a new high risk or delivery incident needs evidence and a specific recipient action', () => {
  const result = evaluateRunSummary({
    recipient: 'John',
    signals: [{
      kind: 'delivery_incident',
      description: 'The Teamwork connector is absent and blocks the scheduled task sweep.',
      materiality: 0.95,
      new_information: true,
      recipient_action: 'Reattach the Teamwork connector to the Cowork session.',
      evidence: [{ type: 'connector_probe', ref: 'twprojects:not-attached:2026-08-08T14:00:00Z' }],
    }],
  });
  assert.equal(result.allowed, true);
  assert.equal(result.classification, 'escalation');
  assert.equal(result.uses_human_budget, true);
});

test('an explicit status request is answered even when the run itself was quiet', () => {
  const result = evaluateRunSummary({
    recipient: 'John',
    explicitly_requested: true,
    signals: [{ kind: 'quiet_check', description: 'No new work arrived.' }],
  });
  assert.equal(result.allowed, true);
  assert.equal(result.classification, 'requested_summary');
  assert.equal(result.uses_human_budget, false);
});

test('summary decisions leave compact durable receipts for anti-noise evaluation', () => {
  const recorded = recordRunSummaryEvaluation({}, {
    recipient: 'John',
    signals: [{ kind: 'quiet_check', description: 'Nothing changed.' },
      { kind: 'bookkeeping', description: 'Updated internal markers.' }],
  }, { now: new Date('2026-08-08T14:00:00.000Z') });
  assert.equal(recorded.evaluation.allowed, false);
  assert.equal(recorded.evaluation.receipt.private_signal_count, 2);
  assert.equal(recorded.ledger.summary_evaluations.length, 1);
  assert.equal(recorded.ledger.summary_evaluations.length, 1);
  assert.equal(recorded.ledger.summary_evaluations[0].classification, 'suppressed');
});
