'use strict';

const apiOpportunities = require('../integrations/api-opportunities');

function publicProposal(proposal) {
  return {
    id: proposal.id,
    status: proposal.status,
    name: proposal.name,
    provider: proposal.provider,
    base_url: proposal.base_url,
    sample_path: proposal.sample_path,
    method: proposal.method,
    auth_model: proposal.auth_model,
    requires_human_setup: proposal.requires_human_setup === true,
    pricing: proposal.pricing,
    docs_url: proposal.docs_url || null,
    terms_url: proposal.terms_url || null,
    capability: proposal.capability,
    data_classification: proposal.data_classification,
    use_case: proposal.use_case,
    risk_notes: proposal.risk_notes || '',
    evidence: proposal.evidence || [],
    proposal_commitment: proposal.proposal_commitment || null,
    proposed_by: proposal.proposed_by,
    created_at: proposal.created_at,
    approved_by: proposal.approved_by || null,
    approved_at: proposal.approved_at || null,
    rejected_by: proposal.rejected_by || null,
    rejected_at: proposal.rejected_at || null,
    rejection_note: proposal.rejection_note || null,
  };
}

function publicUsage(usage) {
  return {
    id: usage.id,
    proposal_id: usage.proposal_id,
    url: usage.url,
    status: usage.status,
    ok: usage.ok === true,
    content_type: usage.content_type || '',
    response_chars: usage.response_chars || 0,
    duration_ms: usage.duration_ms || 0,
    requester: usage.requester || null,
    used_at: usage.used_at,
    usage_commitment: usage.usage_commitment || null,
  };
}

function registerApiOpportunityRoutes(app, deps) {
  const { requireAuth, loadApiRegistry, saveApiRegistry } = deps;

  app.get('/api-opportunities/policy', requireAuth, (_req, res) => {
    res.json(apiOpportunities.publicPolicy(loadApiRegistry()));
  });

  app.get('/api-opportunities/proposals', requireAuth, (req, res) => {
    const registry = loadApiRegistry();
    const status = req.query.status ? String(req.query.status) : null;
    const proposals = status ? registry.proposals.filter(item => item.status === status) : registry.proposals;
    res.json({
      policy: apiOpportunities.publicPolicy(registry),
      count: proposals.length,
      proposals: proposals.slice(-100).map(publicProposal),
    });
  });

  app.get('/api-opportunities/usage', requireAuth, (req, res) => {
    const registry = loadApiRegistry();
    const proposalId = req.query.proposal_id ? String(req.query.proposal_id) : null;
    const usage = proposalId ? registry.usage.filter(item => item.proposal_id === proposalId) : registry.usage;
    res.json({ count: usage.length, usage: usage.slice(-100).map(publicUsage) });
  });

  app.post('/api-opportunities/proposals', requireAuth, async (req, res) => {
    try {
      const result = apiOpportunities.createProposal(req.body || {}, loadApiRegistry());
      await saveApiRegistry(result.registry);
      res.json({ ok: true, proposal: publicProposal(result.proposal), policy: result.policy });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api-opportunities/proposals/:id/approve', requireAuth, async (req, res) => {
    try {
      const result = apiOpportunities.approveProposal(loadApiRegistry(), req.params.id, {
        approvedBy: req.body?.approved_by || 'John',
      });
      await saveApiRegistry(result.registry);
      res.json({ ok: true, proposal: publicProposal(result.proposal), policy: result.policy });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api-opportunities/proposals/:id/reject', requireAuth, async (req, res) => {
    try {
      const result = apiOpportunities.rejectProposal(loadApiRegistry(), req.params.id, {
        rejectedBy: req.body?.rejected_by || 'John',
        note: req.body?.note || '',
      });
      await saveApiRegistry(result.registry);
      res.json({ ok: true, proposal: publicProposal(result.proposal), policy: result.policy });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api-opportunities/proposals/:id/execute', requireAuth, async (req, res) => {
    try {
      const result = await apiOpportunities.executeApprovedGet(loadApiRegistry(), req.params.id, {
        path: req.body?.path || '',
        query: req.body?.query || {},
        requester: req.body?.requester || 'Nora',
      });
      await saveApiRegistry(result.registry);
      res.json({ ok: true, usage: publicUsage(result.usage), response: result.response });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
}

module.exports = { publicProposal, publicUsage, registerApiOpportunityRoutes };
