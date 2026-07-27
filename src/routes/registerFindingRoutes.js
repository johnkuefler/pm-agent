'use strict';

const findings = require('../intelligence/findings');

// Where Nora records something she has noticed that nobody has fixed.
//
// The point of keying these is that a repeat lands on the existing record and increments it. She
// reported one coverage bug five times and the fifth report was as easy to skim past as the first,
// because nothing carried the count. Past a threshold a finding escalates and comes back into her
// prompt, so she leads with it and says how long it has been going on.
function registerFindingRoutes(app, deps) {
  const { requireAuth, loadFindings, saveFindings, now = () => new Date() } = deps;

  app.get('/findings', requireAuth, async (req, res) => {
    try {
      const list = await loadFindings();
      const snapshot = findings.findingsSnapshot(list, now());
      if (req.query.escalated === 'true') {
        return res.json({ ...snapshot, findings: findings.escalatedFindings(list, now()) });
      }
      if (req.query.status === 'open') {
        return res.json({ ...snapshot, findings: list.filter(item => item.status === 'open') });
      }
      res.json(snapshot);
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post('/findings', requireAuth, async (req, res) => {
    try {
      const current = await loadFindings();
      const result = findings.recordFinding(current, req.body || {}, now());
      await saveFindings(result.findings);
      // escalated_now is the moment it stops being an observation and becomes a standing problem.
      // Worth logging once rather than on every repeat, so the log line means something.
      if (result.escalated_now) {
        console.warn(`Finding escalated after ${result.record.occurrences} reports: `
          + `${result.record.key} (${result.record.summary})`);
      }
      res.json({ ok: true, escalated_now: result.escalated_now, finding: result.record });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  // Acknowledging quiets a finding for one cycle without pretending it is fixed. The count keeps
  // climbing, and it returns loudly if the condition is still there next time she looks.
  app.post('/findings/:key/acknowledge', requireAuth, async (req, res) => {
    try {
      const current = await loadFindings();
      const result = findings.acknowledgeFinding(current, req.params.key,
        { at: now(), by: String(req.body?.by || 'unknown') });
      if (!result.record) return res.status(404).json({ error: 'finding not found' });
      await saveFindings(result.findings);
      res.json({ ok: true, finding: result.record });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post('/findings/:key/resolve', requireAuth, async (req, res) => {
    try {
      const current = await loadFindings();
      const result = findings.resolveFinding(current, req.params.key,
        { at: now(), by: String(req.body?.by || 'unknown'), note: String(req.body?.note || '') });
      if (!result.record) return res.status(404).json({ error: 'finding not found' });
      await saveFindings(result.findings);
      console.log(`Finding resolved after ${result.record.occurrences} reports: ${result.record.key}`);
      res.json({ ok: true, finding: result.record });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });
}

module.exports = { registerFindingRoutes };
