const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.NORA_TEST_MODE = '1';
process.env.DATABASE_URL = '';
process.env.NORA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-queue-'));

const { __test } = require('../../server');
const { computeNextRun } = require('../../src/lib/scheduling');

test.after(() => fs.rmSync(process.env.NORA_DATA_DIR, { recursive: true, force: true }));

const NOW = new Date('2026-07-27T15:00:00.000Z');

function queue(input) {
  const added = [];
  const tool = __test.buildNoraQueueTaskTool({
    channel: 'C123', threadTs: '1.1', user: 'UJYKB4788',
    now: () => NOW, add: task => { added.push(task); return 'task-1'; },
  });
  return { result: tool.definition && tool.execute(input), added };
}

// The scheduler has understood these four cadences all along. Only this tool's schema was narrower,
// so "send that notice every weekday at nine" was unaskable from Slack even though nothing
// underneath was missing.
test('every cadence the scheduler supports is reachable from Slack', async () => {
  const cases = [
    [{ action: 'Post the standup note', repeat: 'daily', local_time: '09:00' }, 'daily:09:00'],
    [{ action: 'Post the standup note', repeat: 'weekdays', local_time: '09:00' }, 'weekdays:09:00'],
    [{ action: 'Send the weekly recap', repeat: 'weekly', weekday: 'monday', local_time: '08:30' }, 'weekly:monday:08:30'],
    [{ action: 'Send the invoice reminder', repeat: 'monthly', day_of_month: 1, local_time: '07:00' }, 'monthly:1:07:00'],
    [{ action: 'Biweekly project sweep', interval_weeks: 2, local_time: '10:00' }, 'every:2:weeks:10:00'],
  ];
  for (const [input, expected] of cases) {
    const { result, added } = queue(input);
    await result;
    assert.equal(added.length, 1, `${input.repeat || 'interval'} should queue one task`);
    assert.equal(added[0].recurrence, expected);
    assert.ok(computeNextRun(added[0].recurrence, NOW),
      `${expected} must be advanceable, or the task would queue and never run`);
  }
});

test('a one-time task still has no recurrence', async () => {
  const { result, added } = queue({ action: 'Draft the Greenbush doc on your next loop' });
  await result;
  assert.equal(added[0].recurrence, null);
});

test('weekly and monthly refuse to guess the missing half of the schedule', async () => {
  assert.match((await queue({ action: 'x', repeat: 'weekly' }).result).error, /weekday is required/);
  assert.match((await queue({ action: 'x', repeat: 'monthly' }).result).error, /day_of_month/);
  assert.match((await queue({ action: 'x', repeat: 'monthly', day_of_month: 0 }).result).error, /day_of_month/);
});

test('conflicting or unknown cadences are rejected rather than silently reinterpreted', async () => {
  assert.match((await queue({ action: 'x', repeat: 'daily', interval_weeks: 2 }).result).error,
    /either repeat or interval_weeks/);
  assert.match((await queue({ action: 'x', repeat: 'hourly' }).result).error, /repeat must be/);
  assert.match((await queue({ action: 'x', repeat: 'daily', local_time: '25:00' }).result).error, /local_time/);
});

test('the destination channel still rides along so the future run knows where to post', async () => {
  const { result, added } = queue({ action: 'Send the recap', repeat: 'weekdays',
    local_time: '09:00', destination_channel: 'C0PMTEAM' });
  await result;
  assert.match(added[0].detail, /C0PMTEAM/);
});
