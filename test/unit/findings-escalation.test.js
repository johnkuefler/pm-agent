const test = require('node:test');
const assert = require('node:assert/strict');

const findings = require('../../src/intelligence/findings');

const DAY = 86400000;
const START = new Date('2026-07-22T09:00:00.000Z');
const day = n => new Date(START.getTime() + n * DAY);

function report(list, overrides = {}, at = START) {
  return findings.recordFinding(list, {
    key: 'coverage-internal-buckets',
    summary: '/projects/coverage hands me all 15 internal buckets as the thinnest slots',
    severity: 'degraded', surface: 'cowork', ...overrides,
  }, at);
}

// The actual history. She reported this five times and the fifth read exactly like the first,
// which is why it sat for days.
test('repeats accumulate onto one record instead of reading as fresh news', () => {
  let list = [];
  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    const result = report(list, {}, day(i));
    list = result.findings;
    seen.push({ n: result.record.occurrences, escalated: result.record.escalated, now: result.escalated_now });
  }
  assert.equal(list.length, 1, 'five reports of one problem are one finding, not five');
  assert.deepEqual(seen.map(s => s.n), [1, 2, 3, 4, 5]);
  assert.deepEqual(seen.map(s => s.escalated), [false, false, true, true, true]);
  assert.deepEqual(seen.map(s => s.now), [false, false, true, false, false],
    'escalation fires once, so the log line means something');
});

test('the prompt line carries the count and the age, which is what was missing', () => {
  let list = [];
  for (let i = 0; i < 5; i += 1) list = report(list, {}, day(i)).findings;
  const block = findings.findingsPromptBlock(list, day(5));
  assert.match(block, /raised 5 times over 5 days/);
  assert.match(block, /Lead with these rather than re-reporting them as if they were new/);
});

test('a single observation stays quiet', () => {
  const { findings: list } = report([]);
  assert.deepEqual(findings.escalatedFindings(list, START), []);
  assert.equal(findings.findingsPromptBlock(list, START), '');
});

test('resolving takes it out of her prompt', () => {
  let list = [];
  for (let i = 0; i < 3; i += 1) list = report(list, {}, day(i)).findings;
  assert.equal(findings.escalatedFindings(list, day(3)).length, 1);
  list = findings.resolveFinding(list, 'coverage-internal-buckets', { at: day(3), by: 'claude' }).findings;
  assert.deepEqual(findings.escalatedFindings(list, day(3)), []);
  assert.equal(findings.findingsPromptBlock(list, day(3)), '');
});

// A fixed thing that comes back is a regression, and the original count is the most useful fact
// about it. Starting the count over would make it read as first-time news all over again.
test('a resolved finding that recurs keeps its history', () => {
  let list = [];
  for (let i = 0; i < 3; i += 1) list = report(list, {}, day(i)).findings;
  list = findings.resolveFinding(list, 'coverage-internal-buckets', { at: day(3) }).findings;
  const result = report(list, {}, day(10));
  assert.equal(result.record.occurrences, 4, 'the count carries across the resolution');
  assert.equal(result.record.status, 'open');
  assert.ok(result.record.reopened_at, 'and the regression is marked as such');
});

// Acknowledging is not fixing. It buys one cycle of quiet so she does not repeat herself at
// someone who already heard, and then it comes back if the condition is still there.
test('acknowledging quiets one cycle, not the problem', () => {
  let list = [];
  for (let i = 0; i < 3; i += 1) list = report(list, {}, day(i)).findings;
  list = findings.acknowledgeFinding(list, 'coverage-internal-buckets', { at: day(3), by: 'john' }).findings;
  assert.deepEqual(findings.escalatedFindings(list, day(3)), [], 'quiet right after acknowledgement');
  list = report(list, {}, day(4)).findings;
  assert.equal(findings.escalatedFindings(list, day(4)).length, 1, 'and back once it recurs');
  assert.equal(list[0].occurrences, 4, 'the count never stopped climbing');
});

test('a finding nobody re-observes ages out', () => {
  let list = [];
  for (let i = 0; i < 3; i += 1) list = report(list, {}, day(i)).findings;
  assert.equal(findings.escalatedFindings(list, day(3)).length, 1);
  assert.deepEqual(findings.escalatedFindings(list, day(20)), [],
    'a week of silence means it was fixed or stopped mattering');
});

test('a blocker outranks an annoyance no matter how often the annoyance recurs', () => {
  let list = [];
  for (let i = 0; i < 6; i += 1) list = report(list, { key: 'minor', severity: 'annoyance' }, day(i)).findings;
  for (let i = 0; i < 3; i += 1) list = report(list, { key: 'major', severity: 'blocker' }, day(i)).findings;
  assert.deepEqual(findings.escalatedFindings(list, day(6)).map(f => f.key), ['major', 'minor']);
});

test('severity only ratchets up, so a later mild report cannot bury a blocker', () => {
  let list = report([], { severity: 'blocker' }).findings;
  list = report(list, { severity: 'annoyance' }, day(1)).findings;
  assert.equal(list[0].severity, 'blocker');
});

test('a finding without a stable key or a summary is refused', () => {
  assert.throws(() => findings.recordFinding([], { summary: 'x' }), /stable key/);
  assert.throws(() => findings.recordFinding([], { key: 'k' }), /summary/);
  assert.equal(findings.normalizeKey('  Coverage / Internal Buckets!! '), 'coverage-internal-buckets');
});
