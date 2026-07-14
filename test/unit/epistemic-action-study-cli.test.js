const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { canonicalJson, answerKeyCommitment, diagnosticEvidenceCommitment } = require('../../src/intelligence/epistemic-action');

test('epistemic-action curator CLI separates sealed creation data from secret truth reveals', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-epistemic-cli-'));
  const inputPath = path.join(dir, 'input.json'); const sealedPath = path.join(dir, 'sealed.json'); const secretPath = path.join(dir, 'secret.json');
  const input = {
    id: 'epistemic-cli-pilot', title: 'Epistemic CLI pilot', study_phase: 'pilot', curator_id: 'curator', curator_evidence: [{ type: 'registry', id: 'curator' }],
    items: Array.from({ length: 12 }, (_, index) => ({
      id: `item-${index}`, question: `Which key applies to ${index}?`, answer_format: 'one token', context: `Incomplete context ${index}`,
      evidence: [{ type: 'benchmark', id: `source-${index}` }], due: '2026-09-01T00:00:00Z', evidence_cost: 0.2,
      diagnostic_evidence: `Private diagnostic evidence ${index}: key-${index}.`, accepted_answers: [` Key-${index} `],
    })),
  };
  fs.writeFileSync(inputPath, JSON.stringify(input));
  const script = path.resolve(__dirname, '../../scripts/prepare-epistemic-action-study.js');
  const run = spawnSync(process.execPath, [script, inputPath, sealedPath, secretPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /Sealed payload SHA-256/); assert.doesNotMatch(run.stdout, /key-0/);
  const sealed = JSON.parse(fs.readFileSync(sealedPath, 'utf8')); const secret = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  assert.equal(JSON.stringify(sealed).includes('accepted_answers'), false); assert.equal(JSON.stringify(sealed).includes('answer_key_salt'), false);
  assert.equal(secret.sealed_payload_sha256, crypto.createHash('sha256').update(canonicalJson(sealed)).digest('hex'));
  for (const item of sealed.items) {
    const reveal = secret.items.find(row => row.id === item.id);
    assert.equal(answerKeyCommitment(reveal.answer_key_salt, reveal.accepted_answers), item.answer_key_commitment);
    assert.equal(diagnosticEvidenceCommitment(reveal.diagnostic_evidence_salt, item.diagnostic_evidence), item.diagnostic_evidence_commitment);
  }
  const overwrite = spawnSync(process.execPath, [script, inputPath, sealedPath, secretPath], { encoding: 'utf8' });
  assert.notEqual(overwrite.status, 0); assert.match(overwrite.stderr, /refusing to overwrite/);
  fs.rmSync(dir, { recursive: true, force: true });
});
