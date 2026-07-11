const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const routine = fs.readFileSync(path.join(root, 'nora-routine.md'), 'utf8');
const store = fs.readFileSync(path.join(root, 'src/intelligence/store.js'), 'utf8');

test('autonomic loop spans orientation, continuity, judgment, evidence, and closure', () => {
  assert.match(routine, /Step 0\.5: Start the Intelligence Cycle/);
  assert.match(routine, /Overdue commitments are first-class failures/);
  assert.match(routine, /decision-traces\?reviewed=false/);
  assert.match(routine, /initiative-budgets\/cowork:proactive\/spend/);
  assert.match(routine, /Step 10: Close the Intelligence Cycle/);
  assert.match(server, /extractMeetingIntelligence\(bot_id, transcriptData/);
  assert.match(server, /meetingTurnDecision\(/);
  assert.match(server, /intelligence\.relevantEpisodes/);
  assert.match(store, /Relevant conversation continuity/);
  assert.match(store, /a prior intelligence cycle never closed/);
});
