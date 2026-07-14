'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapDifference, pairedBootstrapDifference, pairedBootstrapAgainstBestControl, wilsonInterval } = require('../../src/intelligence/statistics');

test('stratified bootstrap intervals are deterministic and preserve separated effects', () => {
  const first = bootstrapDifference([0.9, 0.9, 0.9], [0.4, 0.4, 0.4], { seed: 'committed-seed', iterations: 500 });
  const second = bootstrapDifference([0.9, 0.9, 0.9], [0.4, 0.4, 0.4], { seed: 'committed-seed', iterations: 500 });
  assert.deepEqual(first, second);
  assert.ok(Math.abs(first.observed_effect - 0.5) < 1e-12);
  assert.ok(first.lower >= 0.49);
  assert.ok(first.upper <= 0.51);
});

test('uncertain overlapping samples do not produce a one-sided effect interval', () => {
  const interval = bootstrapDifference([0, 1], [0, 1], { seed: 'overlap', iterations: 2000 });
  assert.ok(interval.lower < 0);
  assert.ok(interval.upper > 0);
});

test('paired bootstrap preserves event matching and ignores incomplete pairs', () => {
  const result = pairedBootstrapDifference([0.1, 0.2, 0.1, NaN], [0.5, 0.6, 0.5, 0.9], { seed: 'paired', iterations: 500 });
  assert.equal(result.paired_samples, 3);
  assert.ok(Math.abs(result.observed_effect + 0.4) < 1e-12);
  assert.ok(result.upper < 0);
});

test('paired adaptive bootstrap reselects the best control inside every resample', () => {
  const result = pairedBootstrapAgainstBestControl([0, 0], [[1, -1], [0, 0]], { seed: 'best-control', iterations: 2000 });
  assert.equal(result.observed_effect, 0);
  assert.equal(result.control_count, 2);
  assert.equal(result.upper, 0);
  assert.ok(result.lower < 0);
});

test('Wilson intervals preserve uncertainty for finite match counts', () => {
  const perfect = wilsonInterval(10, 10);
  assert.equal(perfect.estimate, 1);
  assert.ok(perfect.lower > 0.7 && perfect.lower < 0.8);
  const chance = wilsonInterval(5, 10);
  assert.ok(chance.lower < 0.5 && chance.upper > 0.5);
  assert.equal(wilsonInterval(0, 0), null);
});
