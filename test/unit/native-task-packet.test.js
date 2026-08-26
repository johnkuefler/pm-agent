'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { boundedNativeTask, buildNativeTaskPacket } =
  require('../../src/runtime/native-task-packet');

test('native task packet bounds operational fields', () => {
  const packet = boundedNativeTask({
    id: 'task-1', action: 'a'.repeat(1400), metadata: { destination_channel: 'C123' },
  });
  assert.equal(packet.id, 'task-1');
  assert.equal(packet.action.length, 1200);
  assert.equal(packet.metadata.destination_channel, 'C123');
});

test('native task packet identifies a Slack id and human channel name as one destination', async () => {
  const packet = await buildNativeTaskPacket({
    id: 'task-2', action: 'Post to #pm-team',
    metadata: { destination_channel: 'C031HHSBM1Q' },
  }, { resolveChannelName: async id => id === 'C031HHSBM1Q' ? 'pm-team' : null });

  assert.deepEqual(packet.delivery_destination, {
    channel_id: 'C031HHSBM1Q',
    channel_name: 'pm-team',
    display_name: '#pm-team',
    verified_same_destination: true,
  });
});
