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
  assert.throws(() => apiOps.createProposal({ ...base, id: 'bad-userinfo', base_url: 'https://key@example.com' }, apiOps.emptyRegistry()), /credentials/);
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
    resolveDns: async () => [{ address: '1.1.1.1' }],
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

test('approved APIs refuse private DNS and redirects outside the approved origin', async () => {
  const created = apiOps.createProposal({ id: 'api-safe', name: 'Safe API', base_url: 'https://api.example.com',
    sample_path: '/lookup', use_case: 'Look up bounded public context without sending any private operational data.',
    evidence: [{ type: 'docs', url: 'https://example.com/docs' }] }, apiOps.emptyRegistry());
  const approved = apiOps.approveProposal(created.registry, 'api-safe');
  await assert.rejects(() => apiOps.executeApprovedGet(approved.registry, 'api-safe', {
    resolveDns: async () => [{ address: '127.0.0.1' }], fetchImpl: async () => { throw new Error('must not fetch'); },
  }), /private network/);
  await assert.rejects(() => apiOps.executeApprovedGet(approved.registry, 'api-safe', {
    resolveDns: async () => [{ address: '::ffff:127.0.0.1' }], fetchImpl: async () => { throw new Error('must not fetch'); },
  }), /private network/);
  const redirected = await apiOps.executeApprovedGet(approved.registry, 'api-safe', {
    resolveDns: async () => [{ address: '1.1.1.1' }],
    fetchImpl: async () => new Response('', { status: 302, headers: { Location: 'https://elsewhere.example/data' } }),
  });
  assert.equal(redirected.response.ok, false);
  assert.match(redirected.response.error, /redirects are refused/);
});

test('installed API tools learn from usefulness outcomes and retire when repeatedly unhelpful', async () => {
  let state = apiOps.createProposal({ id: 'api-context', name: 'Context API', base_url: 'https://api.example.com',
    sample_path: '/context', use_case: 'Supply bounded public context for project scheduling decisions when requested.',
    tool: { query_parameters: [{ name: 'location', type: 'string', required: true, description: 'Public city name' }] },
    evidence: [{ type: 'docs', url: 'https://example.com/docs' }] }, apiOps.emptyRegistry());
  state = apiOps.approveProposal(state.registry, 'api-context');
  const bindings = apiOps.toolBindings(state.registry, async (_proposal, args) => ({ args }));
  assert.equal(bindings.tools[0].name, 'public_api_context_api');
  assert.deepEqual(bindings.tools[0].input_schema.required, ['purpose', 'location']);
  for (let index = 0; index < 5; index += 1) {
    const result = await apiOps.executeApprovedGet(state.registry, 'api-context', {
      purpose: 'Check public context for the current planning decision.', query: { location: 'Chicago' },
      resolveDns: async () => [{ address: '1.1.1.1' }],
      fetchImpl: async () => new Response('{"ok":true}', { status: 200 }),
    });
    state.registry = result.registry;
    state = apiOps.recordUsageOutcome(state.registry, result.usage.id, {
      outcome: 'unhelpful', note: 'The result did not change or improve the decision.',
      evidence: [{ type: 'interaction', id: `interaction-${index}` }],
    });
  }
  assert.equal(state.proposal.status, 'retired');
  assert.match(state.proposal.retirement_reason, /unhelpful/);
  assert.equal(apiOps.toolBindings(state.registry, async () => {}).tools.length, 0);
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
    fetchImpl: async () => new Response('{}', { status: 200 }), resolveDns: async () => [{ address: '1.1.1.1' }],
  }), /human setup/);
});
