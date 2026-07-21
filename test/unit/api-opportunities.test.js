const test = require('node:test');
const assert = require('node:assert/strict');
const apiOps = require('../../src/integrations/api-opportunities');

test('API opportunities require safe public HTTPS proposals with evidence', () => {
  const base = {
    id: 'api-weather',
    name: 'Open-Meteo',
    provider: 'Open-Meteo',
    base_url: 'https://api.open-meteo.com',
    sample_path: '/v1/forecast',
    use_case: 'Provide quick public weather context for travel-sensitive meeting and project planning.',
    evidence: [{ type: 'web_doc', url: 'https://open-meteo.com/' }],
  };
  const created = apiOps.createProposal(base, apiOps.emptyRegistry());
  assert.equal(created.proposal.status, 'proposed');
  assert.equal(created.proposal.auth_model, 'none');
  assert.match(created.proposal.proposal_commitment, /^[a-f0-9]{64}$/);
  assert.throws(() => apiOps.createProposal({ ...base, id: 'bad-http', base_url: 'http://example.com' }, apiOps.emptyRegistry()), /https/);
  assert.throws(() => apiOps.createProposal({ ...base, id: 'bad-local', base_url: 'https://localhost' }, apiOps.emptyRegistry()), /not allowed/);
  assert.throws(() => apiOps.createProposal({ ...base, id: 'bad-use-case', use_case: 'nice' }, apiOps.emptyRegistry()), /operational benefit/);
});

test('approved public GET APIs can be executed with bounded receipts', async () => {
  const created = apiOps.createProposal({
    id: 'api-weather',
    name: 'Open-Meteo',
    provider: 'Open-Meteo',
    base_url: 'https://api.open-meteo.com',
    sample_path: '/v1/forecast',
    use_case: 'Provide quick public weather context for travel-sensitive meeting and project planning.',
    evidence: [{ type: 'web_doc', url: 'https://open-meteo.com/' }],
  }, apiOps.emptyRegistry());
  await assert.rejects(() => apiOps.executeApprovedGet(created.registry, 'api-weather', {
    fetchImpl: async () => new Response('{}', { status: 200 }),
  }), /approved/);
  const approved = apiOps.approveProposal(created.registry, 'api-weather');
  const result = await apiOps.executeApprovedGet(approved.registry, 'api-weather', {
    path: '/v1/forecast',
    query: { latitude: '38.6', longitude: '-90.2' },
    fetchImpl: async url => {
      assert.equal(String(url).startsWith('https://api.open-meteo.com/v1/forecast?'), true);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  assert.equal(result.response.ok, true);
  assert.equal(result.response.body_text, '{"ok":true}');
  assert.equal(result.registry.usage.length, 1);
  assert.match(result.usage.usage_commitment, /^[a-f0-9]{64}$/);
  await assert.rejects(() => apiOps.executeApprovedGet(approved.registry, 'api-weather', {
    path: 'https://example.com/steal',
    fetchImpl: async () => new Response('{}', { status: 200 }),
  }), /approved API origin/);
});

test('APIs requiring credentials stay proposal-only until human setup exists', async () => {
  const created = apiOps.createProposal({
    id: 'api-keyed',
    name: 'Keyed API',
    provider: 'Example',
    base_url: 'https://api.example.com',
    auth_model: 'api_key',
    use_case: 'Could enrich project research after a human reviews terms and configures credentials.',
    evidence: [{ type: 'docs', url: 'https://api.example.com/docs' }],
  }, apiOps.emptyRegistry());
  assert.equal(created.proposal.requires_human_setup, true);
  const approved = apiOps.approveProposal(created.registry, 'api-keyed');
  await assert.rejects(() => apiOps.executeApprovedGet(approved.registry, 'api-keyed', {
    fetchImpl: async () => new Response('{}', { status: 200 }),
  }), /human setup/);
});
