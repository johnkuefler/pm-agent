const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { canonicalJson, answerCommitment } = require('../../src/intelligence/episodic-prospection');

test('episodic-prospection curator CLI separates committed choices from the creation payload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'episodic-prospection-cli-'));
  const inputPath = path.join(dir, 'pilot.episodic-prospection-curator-input.json');
  const sealedPath = path.join(dir, 'pilot.episodic-prospection-sealed.json');
  const secretPath = path.join(dir, 'pilot.episodic-prospection-secret.json');
  const input = {
    id: 'episodic-cli-pilot', title: 'CLI pilot', study_phase: 'pilot', curator_id: 'curator-cli',
    curator_evidence: [{ type: 'curator_attestation', id: 'curator-cli-evidence' }],
    items: Array.from({ length: 36 }, (_, index) => ({
      id: `item-${index}`, task: `Future choice ${index}`,
      options: [{ key: 'a', label: 'Option A' }, { key: 'b', label: 'Option B' }], accepted_choice: index % 2 ? 'b' : 'a',
      due: '2026-09-01T00:00:00.000Z', autobiographical_moment_id: `authentic-${index}`, recombined_moment_id: `recombined-${index}`,
      deidentified_rendering: `The agent observed event ${index}.`,
      information_equivalence_evidence: [{ type: 'equivalence_review', id: `eq-${index}` }],
      recombination_match_evidence: [{ type: 'match_review', id: `match-${index}` }],
      encoding_unpredictability_evidence: [{ type: 'prospective_task_timestamp', id: `unpredictable-${index}` }],
    })),
  };
  fs.writeFileSync(inputPath, JSON.stringify(input));
  const script = path.resolve(__dirname, '../../scripts/prepare-episodic-prospection-study.js');
  const result = spawnSync(process.execPath, [script, inputPath, sealedPath, secretPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const sealed = JSON.parse(fs.readFileSync(sealedPath, 'utf8')); const secret = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  assert.equal(JSON.stringify(sealed).includes('accepted_choice'), false);
  assert.equal(JSON.stringify(sealed).includes('answer_salt'), false);
  assert.equal(secret.items.length, 36);
  assert.equal(secret.sealed_payload_sha256, crypto.createHash('sha256').update(canonicalJson(sealed)).digest('hex'));
  for (const row of secret.items) assert.equal(answerCommitment(row.answer_salt, row.accepted_choice), row.answer_commitment);
  const overwrite = spawnSync(process.execPath, [script, inputPath, sealedPath, secretPath], { encoding: 'utf8' });
  assert.notEqual(overwrite.status, 0);
  assert.match(overwrite.stderr, /refusing to overwrite/);
});
