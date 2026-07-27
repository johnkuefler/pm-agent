const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-transcript-status-'));
Object.assign(process.env, {
  NORA_DATA_DIR: dataDir,
  NORA_TEST_MODE: '1',
  NORA_API_KEY: 'transcript-status-key',
  DATABASE_URL: '',
  DASHBOARD_PASSWORD: 'transcript-status-password',
});

const now = new Date();
const minutesAgo = n => new Date(now.getTime() - n * 60 * 1000).toISOString();
const write = (botId, body) =>
  fs.writeFileSync(path.join(dataDir, `transcript-${botId}.json`), JSON.stringify(body));

// A meeting happening right now: the done webhook has not fired and utterances are still arriving.
write('live', { bot_id: 'live', ended: null, transcript: [{ timestamp: minutesAgo(1), text: 'still talking' }] });
// A meeting that ended cleanly.
write('done', { bot_id: 'done', ended: minutesAgo(45), transcript: [{ timestamp: minutesAgo(46), text: 'wrapped' }] });
// A meeting whose webhook never arrived. It must not be stranded unfilable forever.
write('orphan', { bot_id: 'orphan', ended: null, transcript: [{ timestamp: minutesAgo(90), text: 'bot died' }] });

const { app } = require('../../server');

let server;
let baseUrl;
test.before(async () => {
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${pathname}`, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

const KEY = 'transcript-status-key';

// The regression this guards: the hourly run lists transcripts and files them to Drive. If a
// meeting that is still happening appears filable, it gets filed mid-meeting and the rest of the
// conversation is lost from the filed copy.
test('a live meeting is never offered as filable', async () => {
  const { status, json } = await getJson(`/transcripts?status=ended&key=${KEY}`);
  assert.equal(status, 200);
  const ids = json.map(item => item.bot_id);
  assert.ok(!ids.includes('live'), 'a meeting still producing utterances must not appear in ended');
  assert.ok(ids.includes('done'), 'a cleanly ended meeting must still be filable');
});

test('a transcript whose webhook never fired stays filable rather than stranded', async () => {
  const { json } = await getJson(`/transcripts?status=ended&key=${KEY}`);
  const orphan = json.find(item => item.bot_id === 'orphan');
  assert.ok(orphan, 'an orphaned transcript must remain filable or it is lost forever');
  assert.equal(orphan.orphaned, true, 'and must stay distinguishable from a clean end');
  assert.equal(orphan.ended, null, 'without inventing an end timestamp it never had');
});

test('the live view returns only the meeting in progress', async () => {
  const { json } = await getJson(`/transcripts?status=in_progress&key=${KEY}`);
  assert.deepEqual(json.map(item => item.bot_id), ['live']);
});

test('the default listing still returns every meeting for existing callers', async () => {
  const { json } = await getJson(`/transcripts?key=${KEY}`);
  assert.equal(json.length, 3);
  assert.deepEqual([...json.map(item => item.bot_id)].sort(), ['done', 'live', 'orphan']);
});

// The old JSON path substituted the last utterance timestamp for a missing `ended`, which is what
// made a live meeting look finished to every caller that filtered on `ended`.
test('a live meeting reports no end timestamp at all', async () => {
  const { json } = await getJson(`/transcripts?key=${KEY}`);
  const live = json.find(item => item.bot_id === 'live');
  assert.equal(live.ended, null);
  assert.equal(live.in_progress, true);
  assert.ok(live.last_utterance_at, 'recency is still reported, just not as an end');
});
