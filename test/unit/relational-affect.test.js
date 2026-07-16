'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const relationalAffect = require('../../src/intelligence/relational-affect');
const { createIntelligenceStore } = require('../../src/intelligence/store');

const now = new Date('2026-07-16T15:00:00.000Z');

function relationship(signal = 'corrected') {
  return {
    id: 'person-john', name: 'John', observations: [{
      id: `observation-${signal}`, dimension: 'response_feedback',
      observation: `${signal}: explicit reviewed interaction outcome`, confidence: 0.9,
      evidence: { channel: 'slack', id: `message-${signal}`, captured_at: now.toISOString() },
      observed_at: '2026-07-16T14:00:00.000Z', status: 'active',
    }],
  };
}

test('relational attunement admits only explicit receipted outcomes and commits identity and sources', () => {
  const john = relationship('corrected');
  john.observations.push({
    id: 'observation-free-text', dimension: 'communication',
    observation: 'Seems anxious and probably wants reassurance', confidence: 1,
    evidence: { channel: 'slack', id: 'message-free-text' },
    observed_at: '2026-07-16T14:30:00.000Z', status: 'active',
  });
  john.observations.push({
    id: 'observation-no-receipt', dimension: 'response_feedback',
    observation: 'appreciated: thanks', confidence: 1, evidence: null,
    observed_at: '2026-07-16T14:45:00.000Z', status: 'active',
  });

  const projection = relationalAffect.derive([john], now);
  assert.equal(projection.eligible_observation_count, 1);
  assert.equal(projection.excluded_observation_count, 2);
  assert.equal(projection.stances[0].mode, 'repair_and_reconnect');
  assert.equal(relationalAffect.audit(projection, [john]).complete_chain_verified, true);
  assert.match(relationalAffect.render(projection.stances[0]), /Prospective prediction/);

  const sourceTamper = structuredClone(john);
  sourceTamper.observations[0].observation = 'corrected: altered after projection';
  assert.equal(relationalAffect.audit(projection, [sourceTamper]).complete_chain_verified, false);
  const identityTamper = structuredClone(john);
  identityTamper.name = 'Jane';
  assert.equal(relationalAffect.audit(projection, [identityTamper]).complete_chain_verified, false);
});

test('positive explicit outcomes select proportionate collaborative warmth', () => {
  const projection = relationalAffect.derive([relationship('appreciated')], now);
  assert.equal(projection.stances[0].mode, 'warm_collaboration');
  assert.match(projection.stances[0].relational_tendency, /collaborative_warmth/);
});

test('store applies only the matching replay-verified teammate stance and fails closed after tampering', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-relational-affect-'));
  const filePath = path.join(dir, 'state.json');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => now });
  await store.init();

  store.observeRelationship({ name: 'John', dimension: 'communication',
    observation: 'Prefers concise updates', confidence: 0.9 });
  store.observeRelationship({ name: 'John', dimension: 'response_feedback',
    observation: 'corrected: decision owner was missing', confidence: 0.9,
    evidence: { channel: 'slack', id: 'message-1', captured_at: now.toISOString() } });

  const snapshot = store.relationalAffectSnapshot();
  assert.equal(snapshot.report.current_verified, true);
  assert.equal(snapshot.report.eligible_observations, 1);
  assert.equal(snapshot.report.excluded_observations, 1);
  assert.equal(snapshot.current.stances[0].mode, 'repair_and_reconnect');
  assert.match(store.promptContext({ person: 'John', channel: 'slack', query: 'What should we do next?' }), /Evidence-bound relational attunement/);
  assert.match(store.promptContext({ person: 'John', channel: 'slack', query: 'What should we do next?' }), /repair and reconnect/);
  assert.doesNotMatch(store.promptContext({ person: 'Jane', channel: 'slack', query: 'What should we do next?' }), /Evidence-bound relational attunement/);
  const indicator = store.consciousnessResearchStatus().indicators.find(item => item.id === 'relational_affective_attunement');
  assert.equal(indicator.status, 'collecting');
  assert.equal(indicator.evidence.current_projection_verified, true);
  assert.throws(() => store.observeRelationship({ name: 'John', observation: 'unsupported',
    relational_signal: 'telepathy' }), /invalid relational_signal/);

  const tamperedState = store.snapshot();
  tamperedState.relationships[0].observations.find(item => item.dimension === 'response_feedback').observation = 'corrected: tampered source';
  fs.writeFileSync(filePath, JSON.stringify(tamperedState));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => now });
  await reloaded.init();
  assert.equal(reloaded.relationalAffectSnapshot().report.current_verified, false);
  assert.doesNotMatch(reloaded.promptContext({ person: 'John', channel: 'slack' }), /Evidence-bound relational attunement/);
  fs.rmSync(dir, { recursive: true, force: true });
});
