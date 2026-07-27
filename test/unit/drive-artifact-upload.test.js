const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const artifactUpload = require('../../src/integrations/drive-artifact-upload');
const { registerCoworkInstructionsRoute } = require('../../src/routes/cowork-instructions');

const input = {
  bytes: Buffer.from('real binary bytes\0\1', 'utf8'),
  idempotencyKey: 'task-nora-123-deadbeef',
  filename: 'Kizik_ABM_Brief.pptx',
  parentFolderId: '1Ge01p3v30o5xH4example',
};

test('prepares a byte- and destination-bound artifact commitment', () => {
  const prepared = artifactUpload.prepareArtifactRequest(input);
  assert.equal(prepared.request.size_bytes, input.bytes.length);
  assert.match(prepared.request.sha256, /^[a-f0-9]{64}$/);
  assert.equal(prepared.request.mimetype,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation');

  const changedBytes = artifactUpload.prepareArtifactRequest({ ...input, bytes: Buffer.from('different') });
  const changedFolder = artifactUpload.prepareArtifactRequest({ ...input,
    parentFolderId: '1Ge01p3v30o5xH4different' });
  assert.notEqual(prepared.request_commitment, changedBytes.request_commitment);
  assert.notEqual(prepared.request_commitment, changedFolder.request_commitment);
  assert.equal(artifactUpload.prepareArtifactRequest({ ...input, parentFolderId: 'root' })
    .request.parent_folder_id, 'root');
});

test('rejects unsafe metadata, empty bodies, and oversized artifacts before provider access', () => {
  assert.throws(() => artifactUpload.prepareArtifactRequest({ ...input, bytes: Buffer.alloc(0) }),
    /cannot be empty/);
  assert.throws(() => artifactUpload.prepareArtifactRequest({ ...input, filename: '../brief.pdf' }),
    /safe/);
  assert.throws(() => artifactUpload.prepareArtifactRequest({ ...input, parentFolderId: 'not a folder!' }),
    /folder ID/);
  assert.throws(() => artifactUpload.prepareArtifactRequest({ ...input, idempotencyKey: 'short' }),
    /Idempotency-Key/);
  assert.throws(() => artifactUpload.prepareArtifactRequest({ ...input,
    bytes: Buffer.alloc(artifactUpload.MAX_ARTIFACT_BYTES + 1) }), /exceeds/);
});

test('receipt audit detects tampering with either request or provider result', () => {
  const prepared = artifactUpload.prepareArtifactRequest(input);
  const receipt = artifactUpload.createReceipt(prepared, {
    id: 'drive-file-123', name: input.filename,
    webViewLink: 'https://drive.google.com/file/d/drive-file-123/view',
    mimeType: prepared.request.mimetype, parents: [input.parentFolderId],
  }, { completedAt: '2026-07-18T22:00:00.000Z' });
  assert.deepEqual(artifactUpload.auditReceipt(receipt), { valid: true, reason: null });

  const changedLink = structuredClone(receipt);
  changedLink.file.webViewLink = 'https://example.com/not-drive';
  assert.equal(artifactUpload.auditReceipt(changedLink).valid, false);
  const changedSha = structuredClone(receipt);
  changedSha.request.sha256 = '0'.repeat(64);
  assert.equal(artifactUpload.auditReceipt(changedSha).valid, false);
});

test('ledger compaction retains pending work and bounds settled receipts', () => {
  const records = Array.from({ length: 8 }, (_, index) => ({
    idempotency_key: `task-key-${String(index).padStart(3, '0')}`,
    state: index < 2 ? 'pending' : 'completed',
    updated_at: `2026-07-18T22:00:0${index}.000Z`,
  }));
  const compacted = artifactUpload.pruneLedger({ version: 1, records }, 4);
  assert.equal(compacted.records.length, 4);
  assert.equal(compacted.records.filter(record => record.state === 'pending').length, 2);
  assert.deepEqual(compacted.records.filter(record => record.state === 'completed')
    .map(record => record.idempotency_key), ['task-key-007', 'task-key-006']);
});

test('unattended-work instructions expose raw upload, retry, and receipt verification', () => {
  const root = path.resolve(__dirname, '../..');
  const cowork = fs.readFileSync(path.join(root, 'src/routes/cowork-instructions.js'), 'utf8');
  const routine = fs.readFileSync(path.join(root, 'nora-routine.md'), 'utf8');
  for (const text of [cowork, routine]) {
    assert.match(text, /\/admin\/drive\/upload-artifact/);
    assert.match(text, /--data-binary/);
    assert.match(text, /Idempotency-Key/);
    assert.match(text, /receipt\.request\.sha256/);
  }

  let handler;
  registerCoworkInstructionsRoute({ get(route, ...handlers) {
    if (route === '/cowork-instructions') handler = handlers.at(-1);
  } });
  let rendered = '';
  assert.doesNotThrow(() => handler({}, {
    type() { return this; },
    send(value) { rendered = value; },
  }));
  assert.match(rendered, /\$\{BASE\}\/admin\/drive\/upload-artifact/);
  assert.match(rendered, /task-\$\{TASK_ID\}-\$\{ARTIFACT_SHA\}/);
});
