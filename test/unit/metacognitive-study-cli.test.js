const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

test('curator CLI separates public commitments from secret normalized answer keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-metacognitive-cli-'));
  const inputPath = path.join(dir, 'curator-input.json');
  const publicPath = path.join(dir, 'public-study.json');
  const secretPath = path.join(dir, 'secret-keys.json');
  const input = {
    id: 'cli-metacognitive-pilot', title: 'CLI metacognitive pilot', study_phase: 'pilot',
    curator_id: 'independent-curator', curator_evidence: [{ type: 'registry', id: 'independent-curator' }],
    items: Array.from({ length: 12 }, (_, index) => ({
      id: `cli-item-${index}`, question: `Return the concealed benchmark key for item ${index}.`,
      answer_format: 'One short factual token.', context: `Public context ${index}.`,
      evidence: [{ type: 'benchmark', id: `source-${index}` }], due: `2026-09-01T${String(index).padStart(2, '0')}:00:00Z`,
      accepted_answers: [`  Secret Key ${index}  `, `secret   key ${index}`],
    })),
  };
  fs.writeFileSync(inputPath, JSON.stringify(input));
  const script = path.resolve(__dirname, '../../scripts/prepare-metacognitive-study.js');
  const run = spawnSync(process.execPath, [script, inputPath, publicPath, secretPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Public payload SHA-256/);
  assert.doesNotMatch(run.stdout, /Secret Key 0/);
  const publicStudy = JSON.parse(fs.readFileSync(publicPath, 'utf8'));
  const secretKeys = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  assert.equal(publicStudy.items.length, 12);
  assert.equal(JSON.stringify(publicStudy).includes('accepted_answers'), false);
  assert.equal(JSON.stringify(publicStudy).includes('answer_key_salt'), false);
  assert.equal(secretKeys.public_payload_sha256, crypto.createHash('sha256').update(canonicalJson(publicStudy)).digest('hex'));
  for (const [index, item] of publicStudy.items.entries()) {
    const secret = secretKeys.items.find(row => row.id === item.id);
    assert.deepEqual(secret.accepted_answers, [`secret key ${index}`]);
    assert.equal(crypto.createHash('sha256').update(`${secret.answer_key_salt}:${canonicalJson({ accepted_answers: secret.accepted_answers })}`).digest('hex'), item.answer_key_commitment);
    assert.equal(secret.answer_key_commitment, item.answer_key_commitment);
  }
  const overwrite = spawnSync(process.execPath, [script, inputPath, publicPath, secretPath], { encoding: 'utf8' });
  assert.notEqual(overwrite.status, 0);
  assert.match(overwrite.stderr, /refusing to overwrite/);
  fs.rmSync(dir, { recursive: true, force: true });
});
