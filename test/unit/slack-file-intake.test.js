'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

process.env.NORA_TEST_MODE = '1';
process.env.RECALL_ALLOW_UNSIGNED_WEBHOOKS_IN_TEST = '1';

const { __test } = require('../../server');

test('Slack attachment storage identity is stable across webhook replay', () => {
  const file = {
    id: 'F_FILE_1',
    name: 'brief.pdf',
    url_private: 'https://files.slack.com/files-pri/T/F/brief.pdf',
  };
  const first = __test.stableSlackFileInboxId('Ev01', file);
  const replay = __test.stableSlackFileInboxId('Ev01', { ...file });

  assert.equal(replay, first);
  assert.match(first, /^[a-f0-9]{24}$/);
  assert.notEqual(__test.stableSlackFileInboxId('Ev02', file), first);
  assert.notEqual(__test.stableSlackFileInboxId('Ev01', { ...file, id: 'F_FILE_2' }), first);
});

test('required attachment acknowledgements fail closed when Slack has no target', async () => {
  await assert.rejects(
    __test.postRequiredSlackIntakeMessage('', 'done', null, {
      clientMsgId: 'stable-id',
    }),
    error => error.code === 'slack_file_ack_failed',
  );
  assert.equal(await __test.postRequiredSlackIntakeMessage('', 'receipt', null, {
    clientMsgId: 'stable-id',
    required: false,
  }), false);
});

test('attachment intake binds durable source, task, files, and acknowledgements to one event', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = server.indexOf('async function handleSlackFiles(');
  const end = server.indexOf('// Inbox endpoints', start);
  const handler = server.slice(start, end);

  assert.match(handler, /webhookEventId\s*=\s*null/);
  assert.match(handler, /stableSlackFileInboxId\(intakeEventId, f\)/);
  assert.match(handler, /fs\.promises\.rename\(tempPath, fullPath\)/);
  assert.match(handler, /await addTaskStrict\([\s\S]*source_external_id:\s*intakeEventId/);
  assert.match(handler, /task-slack-file-/);
  assert.match(handler, /slack-file:\$\{intakeEventId\}:complete/);
  assert.match(handler, /Number\(deliveryAttempt\) < 5/);
  assert.match(handler, /slack_file_download_retryable/);
  assert.match(handler, /Files not accepted after bounded retries/);
  assert.doesNotMatch(handler, /Date\.now\(\).*Math\.random/);
  assert.doesNotMatch(handler, /axios\.post\('https:\/\/slack\.com\/api\/chat\.postMessage'/);
});
