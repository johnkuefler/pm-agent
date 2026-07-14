const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const transparency = require('../../src/intelligence/research-transparency');

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-transparency-'));
  const filePath = path.join(dir, 'state.json'); const now = new Date('2026-07-13T16:00:00.000Z');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => now });
  await store.init();
  const commitment = store.addCommitment({ id: 'transparent-source', what: 'Prepare the provider-backed plan',
    owner: 'Nora', due: '2026-07-15T16:00:00.000Z',
    evidence: { channel: 'gmail', id: 'message-transparent', captured_at: '2026-07-13T15:50:00.000Z' } });
  store.attestCommitmentSourceFromReadback(commitment.id, { provider: 'gmail', external_id: 'message-transparent',
    verifier_id: 'independent-reader',
    provider_response_digest: crypto.createHash('sha256').update('unexported provider response bytes').digest('hex'),
    external_reference: { type: 'retained_provider_receipt', id: 'transparent-receipt' },
    retrieved_at: '2026-07-13T15:59:00.000Z' });
  return { dir, store, bundle: store.researchTransparencyBundle() };
}

test('transparency export independently verifies ledger chronology and source provenance under tampering', async () => {
  const { dir, bundle } = await fixture();
  const audit = transparency.verifyBundle(bundle);
  assert.equal(audit.complete_chain_verified, true);
  assert.equal(audit.source_provenance.all_attestations_verified, true);
  assert.equal(JSON.stringify(bundle).includes('unexported provider response bytes'), false);

  const ledgerTampered = structuredClone(bundle);
  ledgerTampered.ledger.events[0].at = '2026-07-13T15:00:00.000Z';
  delete ledgerTampered.bundle_commitment;
  ledgerTampered.bundle_commitment = transparency.hash(ledgerTampered);
  assert.equal(transparency.verifyBundle(ledgerTampered).ledger.valid, false,
    'recomputing the outer bundle hash cannot repair the ledger chain');

  const sourceTampered = structuredClone(bundle);
  sourceTampered.source_provenance.commitments[0].what = 'Substituted task';
  delete sourceTampered.bundle_commitment;
  sourceTampered.bundle_commitment = transparency.hash(sourceTampered);
  const sourceAudit = transparency.verifyBundle(sourceTampered);
  assert.equal(sourceAudit.bundle_commitment_verified, true);
  assert.equal(sourceAudit.source_provenance.all_attestations_verified, false,
    'a recomputed bundle still fails the provider-readback source binding');
  const missingCommitment = structuredClone(bundle);
  missingCommitment.source_provenance.commitments = [];
  delete missingCommitment.bundle_commitment;
  missingCommitment.bundle_commitment = transparency.hash(missingCommitment);
  assert.equal(transparency.verifyBundle(missingCommitment).complete_chain_verified, false,
    'an attestation cannot verify without exporting its bound commitment');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an external Ed25519 witness can sign a valid bundle and detect later substitution', async () => {
  const { dir, bundle } = await fixture();
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const receipt = transparency.createWitnessReceipt(bundle, privateKey,
    { verifier_id: 'outside-lab', verified_at: '2026-07-13T16:05:00.000Z' });
  assert.equal(transparency.verifyWitnessReceipt(bundle, receipt, publicKey).complete_chain_verified, true);
  const substituted = structuredClone(bundle); substituted.state_version += 1;
  delete substituted.bundle_commitment; substituted.bundle_commitment = transparency.hash(substituted);
  assert.equal(transparency.verifyWitnessReceipt(substituted, receipt, publicKey).complete_chain_verified, false);

  const bundlePath = path.join(dir, 'bundle.json'); const privatePath = path.join(dir, 'private.pem');
  const publicPath = path.join(dir, 'public.pem'); const receiptPath = path.join(dir, 'receipt.json');
  fs.writeFileSync(bundlePath, JSON.stringify(bundle));
  fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
  const script = path.resolve(__dirname, '../../scripts/verify-consciousness-research-export.js');
  const signed = spawnSync(process.execPath, [script, bundlePath, '--signing-key', privatePath,
    '--receipt', receiptPath, '--verifier-id', 'outside-cli'], { encoding: 'utf8' });
  assert.equal(signed.status, 0, signed.stderr);
  const verified = spawnSync(process.execPath, [script, bundlePath, '--verify-receipt', receiptPath,
    '--public-key', publicPath], { encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).witness.complete_chain_verified, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
