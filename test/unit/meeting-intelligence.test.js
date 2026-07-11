const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const { applyMeetingIntelligence, compactTranscript, meetingIntelligenceSystemPrompt, parseMeetingIntelligence } = require('../../src/intelligence/meeting');

test('meeting intelligence parser preserves only structured continuity', () => {
  const parsed = parseMeetingIntelligence('```json\n{"summary":"Launch moved.","project":"Launch","participants":["John","Nora"],"decisions":["Ship Friday"],"open_loops":[{"what":"Confirm QA","owner":"Nora"}],"commitments":[{"what":"Send recap","owner":"Nora","evidence_quote":"I will send it"}]}\n```');
  assert.equal(parsed.commitments[0].what, 'Send recap');
  assert.equal(parsed.open_loops[0].what, 'Confirm QA');
  assert.match(meetingIntelligenceSystemPrompt(), /requires explicit promissory language/);
});

test('meeting intelligence closes continuity and deduplicates explicit promises', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-meeting-intelligence-'));
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {}, isDbReady: () => false });
  await store.init();
  const extracted = { summary: 'Nora promised a recap.', project: 'Launch', participants: ['Nora', 'John'], decisions: ['Ship Friday'], open_loops: [{ what: 'Confirm QA', owner: 'Nora' }], commitments: [{ what: 'Send recap', owner: 'Nora', beneficiary: 'John', evidence_quote: 'I will send the recap' }] };
  const first = applyMeetingIntelligence(store, { botId: 'bot-1', ended: '2026-07-11T18:00:00Z', extracted });
  const second = applyMeetingIntelligence(store, { botId: 'bot-1', ended: '2026-07-11T18:00:00Z', extracted });
  assert.equal(first.episode.id, second.episode.id);
  assert.equal(store.list('commitments').length, 1);
  assert.equal(store.get('episodes', first.episode.id).open_loops.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('meeting transcript compaction bounds context and keeps the latest turns', () => {
  const transcript = Array.from({ length: 200 }, (_, index) => ({ speaker: 'John', text: `turn-${index} ${'x'.repeat(100)}` }));
  const compact = compactTranscript(transcript, 1000);
  assert.ok(compact.length <= 1000);
  assert.match(compact, /turn-199/);
});
