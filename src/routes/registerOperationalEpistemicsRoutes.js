'use strict';

const operationalEpistemics = require('../intelligence/operational-epistemics');

function publicClaim(claim) {
  return {
    id: claim.id,
    status: claim.status,
    statement: claim.statement,
    stance: claim.stance,
    confidence: claim.confidence,
    domain: claim.domain,
    subject_ref: claim.subject_ref || '',
    rationale: claim.rationale || '',
    falsifier: claim.falsifier,
    evidence: claim.evidence || [],
    claim_commitment: claim.claim_commitment,
    created_by: claim.created_by,
    created_at: claim.created_at,
    resolved_at: claim.resolved_at || null,
    resolution_id: claim.resolution_id || null,
    resolution_commitment: claim.resolution_commitment || null,
  };
}

function publicResolution(resolution) {
  return {
    id: resolution.id,
    claim_id: resolution.claim_id,
    outcome: resolution.outcome,
    observed: resolution.observed,
    evidence: resolution.evidence || [],
    resolved_by: resolution.resolved_by,
    resolved_at: resolution.resolved_at,
    resolution_commitment: resolution.resolution_commitment,
  };
}

function registerOperationalEpistemicsRoutes(app, deps) {
  const { requireAuth, loadEpistemicsLedger, saveEpistemicsLedger } = deps;

  app.get('/epistemics/report', requireAuth, (_req, res) => {
    res.json(operationalEpistemics.report(loadEpistemicsLedger()));
  });

  app.get('/epistemics/claims', requireAuth, (req, res) => {
    const ledger = loadEpistemicsLedger();
    const status = req.query.status ? String(req.query.status) : null;
    const domain = req.query.domain ? String(req.query.domain) : null;
    let claims = ledger.claims;
    if (status) claims = claims.filter(item => item.status === status);
    if (domain) claims = claims.filter(item => item.domain === domain);
    res.json({
      report: operationalEpistemics.report(ledger),
      count: claims.length,
      claims: claims.slice(-200).map(publicClaim),
    });
  });

  app.get('/epistemics/claims/:id', requireAuth, (req, res) => {
    const ledger = loadEpistemicsLedger();
    const claim = ledger.claims.find(item => item.id === req.params.id);
    if (!claim) return res.status(404).json({ error: 'epistemic claim not found' });
    const resolutions = ledger.resolutions.filter(item => item.claim_id === claim.id);
    res.json({ claim: publicClaim(claim), resolutions: resolutions.map(publicResolution) });
  });

  app.post('/epistemics/claims', requireAuth, async (req, res) => {
    try {
      const result = operationalEpistemics.createClaim(req.body || {}, loadEpistemicsLedger());
      await saveEpistemicsLedger(result.ledger);
      res.json({ ok: true, claim: publicClaim(result.claim), report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/epistemics/claims/:id/resolve', requireAuth, async (req, res) => {
    try {
      const result = operationalEpistemics.resolveClaim(loadEpistemicsLedger(), req.params.id, req.body || {});
      await saveEpistemicsLedger(result.ledger);
      res.json({
        ok: true,
        claim: publicClaim(result.claim),
        resolution: publicResolution(result.resolution),
        report: result.report,
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
}

module.exports = { publicClaim, publicResolution, registerOperationalEpistemicsRoutes };
