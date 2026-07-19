'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createRuntimeActivityStream } = require('../../src/runtime/activity-stream');
const { registerRuntimeActivityRoutes } = require('../../src/routes/runtime-activity');

test('runtime activity stays bounded, redacted, and lifecycle-aware', () => {
  let now = Date.parse('2026-07-18T18:00:00.000Z');
  const stream = createRuntimeActivityStream({
    clock: () => new Date(now),
    limit: 4,
    processEpochId: 'test-epoch',
  });
  const active = stream.begin({ id: 'slack-turn', lane: 'conversation', kind: 'slack_response',
    label: 'Replying in Slack',
    detail: 'Bearer secret-value and ?key=do-not-leak',
    meta: { surface: 'slack', unsafe: 'not allowed' } });
  assert.match(active.detail, /\[redacted\]/);
  assert.doesNotMatch(active.detail, /secret-value|do-not-leak/);
  assert.deepEqual(active.meta, { surface: 'slack' });
  assert.equal(stream.snapshot().current[0].id, 'slack-turn');

  now += 1250;
  stream.progress('slack-turn', { detail: 'First delivery is in progress.' });
  now += 750;
  const finished = stream.finish('slack-turn', { status: 'completed', outcome: 'Delivered.' });
  assert.equal(finished.duration_ms, 2000);
  assert.equal(stream.snapshot().current.length, 0);
  assert.equal(stream.snapshot().recent[0].outcome, 'Delivered.');

  for (let index = 0; index < 8; index += 1) {
    stream.record({ id: `bounded-${index}`, lane: 'background', label: `Check ${index}`, status: 'completed' });
  }
  assert.ok(stream.snapshot().report.retained <= 4);
  assert.equal(stream.snapshot().privacy.raw_messages_included, false);
  assert.equal(stream.snapshot().privacy.tool_results_included, false);
});

test('foreground activity receipts remain an in-memory sub-millisecond-scale operation', () => {
  const stream = createRuntimeActivityStream({ limit: 32, processEpochId: 'performance-epoch' });
  const started = performance.now();
  for (let index = 0; index < 1000; index += 1) {
    const activity = stream.begin({ lane: 'conversation', kind: 'slack_response',
      label: 'Replying in Slack', detail: 'Foreground response path.' });
    stream.finish(activity.id, { status: 'completed', outcome: 'Interactive priority released.' });
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 250, `1000 complete receipt lifecycles should stay cheap (observed ${elapsed.toFixed(1)}ms)`);
  assert.ok(stream.snapshot().report.retained <= 32);
});

test('runtime activity routes stream snapshots and bind hourly phases to the active run lock', async () => {
  let now = Date.parse('2026-07-18T18:00:00.000Z');
  const stream = createRuntimeActivityStream({ clock: () => new Date(now), processEpochId: 'route-epoch' });
  stream.begin({ id: 'hourly:run-live', lane: 'work', kind: 'hourly_run', label: 'Starting hourly work' });
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post']) {
    app[method] = (path, ...handlers) => routes.set(`${method.toUpperCase()} ${path}`, handlers.at(-1));
  }
  registerRuntimeActivityRoutes(app, {
    requireAuth: (_req, _res, next) => next?.(),
    requireDashboardAuth: (_req, _res, next) => next?.(),
    stream,
    getRunLock: () => ({ holder: 'run-live', expires_at: Date.now() + 60000 }),
    getContextSnapshot: () => ({ generated_at: new Date(now).toISOString(),
      reading: { title: 'How We Think', status: 'active' },
      play: { status: 'completed', game: { score: 48 } } }),
  });
  const response = () => ({
    statusCode: 200, body: null, headers: {}, writes: [],
    status(code) { this.statusCode = code; return this; },
    set(name, value) {
      if (typeof name === 'object') Object.assign(this.headers, name);
      else this.headers[name] = value;
      return this;
    },
    json(value) { this.body = value; return this; },
    write(value) { this.writes.push(value); return true; },
    flushHeaders() {},
  });

  const reportRes = response();
  await routes.get('POST /runtime-activity/report')({ body: { phase: 'tasks' } }, reportRes);
  assert.equal(reportRes.body.ok, true);
  assert.equal(stream.snapshot().current[0].label, 'Working the task queues');
  assert.equal(stream.snapshot().recent[0].kind, 'hourly_phase');

  const invalidRes = response();
  await routes.get('POST /runtime-activity/report')({ body: { phase: 'private_thoughts' } }, invalidRes);
  assert.equal(invalidRes.statusCode, 400);

  const contextRes = response();
  routes.get('GET /runtime-activity/context')({}, contextRes);
  assert.equal(contextRes.body.reading.title, 'How We Think');
  assert.equal(contextRes.body.play.game.score, 48);
  assert.equal(contextRes.headers['Cache-Control'], 'private, no-store');

  const listeners = {};
  const streamRes = response();
  routes.get('GET /runtime-activity/events')({
    once(event, listener) { listeners[event] = listener; },
  }, streamRes);
  assert.match(streamRes.headers['Content-Type'], /text\/event-stream/);
  assert.match(streamRes.writes.join(''), /event: snapshot/);
  assert.doesNotMatch(streamRes.writes.join(''), /private_thoughts/);
  listeners.close();
});
