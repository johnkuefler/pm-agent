'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRecallTranscriptRecovery } = require('../../src/surfaces/meeting/recall-recovery');

const NOW = new Date('2026-08-12T14:00:00Z');
const staleRow = botId => ({ bot_id: botId, ended: null,
  last_utterance_at: '2026-08-12T13:00:00Z' });

function finishedBot() {
  return {
    status_changes: [
      { code: 'in_call_recording', created_at: '2026-08-12T12:00:00Z' },
      { code: 'done', created_at: '2026-08-12T12:30:00Z' },
    ],
    recordings: [{ media_shortcuts: { transcript: {
      id: 'artifact', data: { download_url: 'https://download.test/transcript' },
    } } }],
  };
}

test('a missed completion webhook is finalized from the authoritative Recall artifact', async () => {
  const persisted = [];
  const recovery = createRecallTranscriptRecovery({
    listTranscripts: async () => [staleRow('bot-1')],
    getTranscript: async () => ({ transcript: [{ source: 'recall', text: 'Hi' }] }),
    fetchBot: async () => finishedBot(),
    fetchDownload: async () => Array.from({ length: 4 }, (_, index) => ({
      participant: { id: 1, name: 'Lydia' },
      words: [{ text: `line ${index}`, start_timestamp: { relative: index },
        end_timestamp: { relative: index + 0.5 } }],
    })),
    persistTranscript: async value => persisted.push(value),
    now: () => NOW,
  });
  const result = await recovery.reconcile();
  assert.equal(result.recovered, 1);
  assert.equal(persisted[0].source, 'recall_authoritative_recovery');
  assert.equal(persisted[0].transcript.length, 4);
  assert.equal(persisted[0].ended, '2026-08-12T12:30:00Z');
});

test('an active bot is checked but not finalized', async () => {
  let persisted = false;
  const recovery = createRecallTranscriptRecovery({
    listTranscripts: async () => [staleRow('bot-live')],
    getTranscript: async () => ({ transcript: [] }),
    fetchBot: async () => ({ status_changes: [{ code: 'in_call_recording' }] }),
    fetchDownload: async () => [],
    persistTranscript: async () => { persisted = true; },
    now: () => NOW,
  });
  const result = await recovery.reconcile();
  assert.equal(result.recovered, 0);
  assert.equal(result.results[0].state, 'not_done');
  assert.equal(persisted, false);
});

test('one Recall failure does not block recovery of the next meeting', async () => {
  const persisted = [];
  const recovery = createRecallTranscriptRecovery({
    listTranscripts: async () => [staleRow('broken'), staleRow('healthy')],
    getTranscript: async () => ({ transcript: [{ source: 'recall', text: 'only line' }] }),
    fetchBot: async botId => {
      if (botId === 'broken') throw new Error('temporary Recall failure');
      return finishedBot();
    },
    fetchDownload: async () => [],
    persistTranscript: async value => persisted.push(value),
    now: () => NOW,
    logger: { warn() {} },
  });
  const result = await recovery.reconcile();
  assert.equal(result.checked, 2);
  assert.equal(result.recovered, 1);
  assert.equal(persisted[0].bot_id, 'healthy');
  assert.equal(persisted[0].source, 'local_finalization');
});

test('the production recovery can clear one bounded outage backlog in a pass', async () => {
  const { createRecallTranscriptRecoveryRuntime } = require('../../src/surfaces/meeting/recall-recovery');
  const persisted = [];
  const sessions = {};
  const runtime = createRecallTranscriptRecoveryRuntime({
    get: async url => ({ data: url.startsWith('download:') ? [] : finishedBot() }),
    recallBase: 'https://recall.test', apiKey: 'test', controlTimeoutMs: 1000,
    listTranscripts: async () => Array.from({ length: 16 }, (_, index) => staleRow(`bot-${index}`)),
    getTranscript: async () => ({ transcript: [] }),
    saveTranscript: async botId => persisted.push(botId),
    sessions, chatSessions: {}, checkpointStalled: new Map(), checkpointAttempts: new Map(),
    persistedCounts: new Map(), clearActiveBot() {}, refreshRecentMeetings: async () => {},
    enqueuePostProcessing() {}, logger: { log() {}, warn() {} },
  });
  const result = await runtime.reconcile();
  assert.equal(result.checked, 16);
  assert.equal(result.recovered, 16);
  assert.equal(persisted.length, 16);
});
