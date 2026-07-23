'use strict';

const HOURLY_PHASES = Object.freeze({
  orientation: ['Orienting to the hour', 'Loading identity, continuity, current commitments, and operating context.'],
  forecast: ['Planning the run', 'Committing a testable forecast before operational work begins.'],
  context: ['Refreshing working context', 'Reviewing memory, projects, and the evidence needed for this pass.'],
  cleanup: ['Checking operational hygiene', 'Reviewing stale bookkeeping and bounded maintenance work.'],
  tasks: ['Working the task queues', 'Checking assigned work and completing authorized requests.'],
  transcripts: ['Reviewing meeting follow-through', 'Checking new meeting records and client filing needs.'],
  files: ['Handling queued files', 'Reviewing file requests and approved Drive destinations.'],
  email: ['Checking email', 'Scanning the connected email lanes for requests that need action.'],
  slack: ['Checking Slack coverage', 'Looking for missed direct requests and unresolved conversation threads.'],
  deadlines: ['Reviewing deadlines', 'Checking live project deadlines and grounded follow-up needs.'],
  relationships: ['Considering teammate follow-through', 'Checking whether a useful, non-repetitive human follow-up is due.'],
  reflection: ['Running off-hours development', 'Using eligible quiet time for bounded reflection, reading, play, or knowledge work.'],
  summary: ['Closing the hourly pass', 'Summarizing actual work, constraints, and the next continuity handoff.'],
});

function registerRuntimeActivityRoutes(app, { requireAuth, requireDashboardAuth, stream,
  getRunLock = () => null, getContextSnapshot = () => ({ reading: null, play: null }) } = {}) {
  if (!stream) throw new Error('runtime activity stream is required');

  app.get('/runtime-activity', requireAuth, (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json(stream.snapshot());
  });

  app.get('/runtime-activity/context', requireAuth, (_req, res) => {
    try {
      res.set('Cache-Control', 'private, no-store');
      res.json(getContextSnapshot());
    } catch (error) {
      res.status(503).json({ error: `live context unavailable: ${error.message}` });
    }
  });

  app.post('/runtime-activity/report', requireAuth, async (req, res) => {
    const requestedHolder = String(req.body?.holder || '').trim();
    const phase = String(req.body?.phase || '').trim().toLowerCase();
    if (!HOURLY_PHASES[phase]) {
      return res.status(400).json({ error: 'unknown hourly activity phase', allowed_phases: Object.keys(HOURLY_PHASES) });
    }
    let lock;
    try { lock = await getRunLock(); }
    catch (error) { return res.status(503).json({ error: `run lock unavailable: ${error.message}` }); }
    if (!lock || (requestedHolder && lock.holder !== requestedHolder) || Number(lock.expires_at) <= Date.now()) {
      return res.status(409).json({ error: 'activity report is not bound to the active hourly run' });
    }
    const holder = lock.holder;
    const [label, detail] = HOURLY_PHASES[phase];
    const parentId = `hourly:${holder}`;
    if (!stream.progress(parentId, { label, detail, meta: { phase } })) {
      stream.begin({ id: parentId, lane: 'work', kind: 'hourly_run', label, detail,
        source: 'hourly-run', meta: { phase } });
    }
    stream.record({ id: `${parentId}:phase:${phase}:${Date.now().toString(36)}`, parent_id: parentId,
      lane: 'work', kind: 'hourly_phase', label, detail, source: 'hourly-run', status: 'completed',
      meta: { phase } });
    return res.json({ ok: true, phase, label });
  });

  app.get('/runtime-activity/events', requireDashboardAuth, (req, res) => {
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    let closed = false;
    let backpressured = false;
    let backpressureTimer = null;
    let heartbeat = null;
    let unsubscribe = () => {};
    const clearBackpressure = () => {
      backpressured = false;
      if (backpressureTimer) clearTimeout(backpressureTimer);
      backpressureTimer = null;
      res.off?.('drain', onDrain);
    };
    const close = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      clearBackpressure();
      unsubscribe();
    };
    const terminateBackpressuredClient = () => {
      if (closed) return;
      close();
      if (!res.writableEnded && !res.destroyed) res.end?.();
    };
    const write = frame => {
      if (closed || backpressured || res.writableEnded || res.destroyed) return false;
      let accepted = false;
      try { accepted = res.write(frame); }
      catch {
        terminateBackpressuredClient();
        return false;
      }
      if (accepted === false) {
        backpressured = true;
        res.once?.('drain', onDrain);
        backpressureTimer = setTimeout(terminateBackpressuredClient, 5000);
        backpressureTimer.unref?.();
      }
      return accepted;
    };
    const send = (event, payload, id = null) => {
      const frame = `${id != null ? `id: ${id}\n` : ''}event: ${event}\n`
        + `data: ${JSON.stringify(payload)}\n\n`;
      return write(frame);
    };
    function onDrain() {
      if (closed) return;
      clearBackpressure();
      // Events that arrived while the socket was saturated were deliberately not buffered.
      // A fresh bounded snapshot restores exact visible state before incremental delivery resumes.
      send('snapshot', stream.snapshot());
    };
    unsubscribe = stream.subscribe(activity => send('activity', activity, activity.sequence));
    send('snapshot', stream.snapshot());
    heartbeat = setInterval(() => write(`: heartbeat ${Date.now()}\n\n`), 15000);
    heartbeat.unref?.();
    req.once('close', close);
    req.once('aborted', close);
  });

  return { hourlyPhases: HOURLY_PHASES };
}

module.exports = { registerRuntimeActivityRoutes, HOURLY_PHASES };
