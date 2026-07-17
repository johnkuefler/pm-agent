'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

function observedPosition(index) {
  return {
    topic_key: `performance.observation.${index}`,
    statement: `Performance observation ${index} remains bound to its recorded source.`,
    source_family: 'performance-fixture',
    source_family_evidence: [{ type: 'fixture', id: `source-${index}` }],
    owner_type: 'observed_fact', source_key: `telemetry-${index}`,
    polarity: 'supports', confidence: 0.8,
    evidence: [{ type: 'telemetry', id: `signal-${index}` }],
    rationale: 'A bounded fixture supplies one integrity-verifiable observation.',
    recorded_by: 'test-telemetry',
  };
}

test('research-ledger verification is incremental on the hot path and full after hydration', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-ledger-performance-'));
  const filePath = path.join(dir, 'state.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false,
    clock: () => new Date('2026-07-17T03:00:00.000Z') });
  await store.init();

  for (let index = 0; index < 24; index += 1) {
    store.recordEpistemicPosition(observedPosition(index));
  }
  const hot = store.researchLedgerVerificationPerformance();
  assert.ok(hot.incremental_checks >= 20, 'appended events should verify from the cached head');
  assert.ok(hot.cache_hits >= 20, 'repeated same-head audits should be constant-time cache hits');
  assert.ok(hot.full_scans <= 2, 'ordinary append-only work must not repeatedly scan the full ledger');
  assert.equal(hot.cached_event_count, 23,
    'the latest append is verified incrementally by the next integrity consumer');

  const beforeExport = hot.full_scans;
  assert.equal(store.researchLedgerSnapshot().report.valid, true);
  assert.ok(store.researchLedgerVerificationPerformance().full_scans > beforeExport,
    'the externally inspectable ledger snapshot keeps a full-scan boundary');

  await store.persist();
  const tampered = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  tampered.cognition.research_ledger.events[5].kind = 'tampered_event';
  fs.writeFileSync(filePath, JSON.stringify(tampered));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false,
    clock: () => new Date('2026-07-17T03:01:00.000Z') });
  await reloaded.init();
  assert.throws(() => reloaded.recordEpistemicPosition(observedPosition(99)),
    /research ledger integrity failure/,
    'hydration must discard the verifier cache and detect at-rest tampering before mutation');
});
