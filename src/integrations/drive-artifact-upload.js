const crypto = require('crypto');
const path = require('path');

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const LEDGER_VERSION = 1;
const RECEIPT_KIND = 'nora_drive_artifact_upload_receipt';

const MIME_BY_EXTENSION = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
  json: 'application/json', html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      if (value[key] !== undefined) out[key] = canonical(value[key]);
      return out;
    }, {});
  }
  return value;
}

function commitment(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function validateIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key)) {
    throw new Error('Idempotency-Key must be 8-128 characters using letters, numbers, dot, underscore, colon, or hyphen');
  }
  return key;
}

function validateFolderId(value) {
  const id = String(value || '').trim();
  if (id !== 'root' && !/^[A-Za-z0-9_-]{10,200}$/.test(id)) {
    throw new Error('X-Nora-Drive-Folder-Id must be a Google Drive folder ID or root');
  }
  return id;
}

function validateFilename(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 180 || name === '.' || name === '..' || /[\x00-\x1f\x7f]/.test(name)
    || name !== path.basename(name) || /[\\/]/.test(name)) {
    throw new Error('X-Nora-Filename must be a safe 1-180 character filename without a path');
  }
  return name;
}

function guessMimeType(filename, supplied) {
  const explicit = String(supplied || '').trim().toLowerCase();
  if (explicit) {
    if (explicit.length > 160 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+*-]+(?:;[\x20-\x7e]+)?$/.test(explicit)) {
      throw new Error('Content-Type is not a valid MIME type');
    }
    return explicit;
  }
  const ext = (String(filename).split('.').pop() || '').toLowerCase();
  return MIME_BY_EXTENSION[ext] || 'application/octet-stream';
}

function prepareArtifactRequest({ bytes, idempotencyKey, filename, parentFolderId, mimetype }) {
  if (!Buffer.isBuffer(bytes)) throw new Error('artifact body must be raw bytes');
  if (!bytes.length) throw new Error('artifact body cannot be empty');
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    throw new Error(`artifact exceeds the ${MAX_ARTIFACT_BYTES} byte limit`);
  }
  const request = {
    filename: validateFilename(filename),
    parent_folder_id: validateFolderId(parentFolderId),
    mimetype: null,
    size_bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  request.mimetype = guessMimeType(request.filename, mimetype);
  return {
    idempotency_key: validateIdempotencyKey(idempotencyKey),
    request,
    request_commitment: commitment(request),
  };
}

function normalizeDriveFile(file) {
  if (!file || typeof file !== 'object' || !String(file.id || '').trim()) {
    throw new Error('Google Drive did not return a file ID');
  }
  return {
    id: String(file.id),
    name: String(file.name || ''),
    webViewLink: file.webViewLink ? String(file.webViewLink) : null,
    mimeType: file.mimeType ? String(file.mimeType) : null,
    parents: Array.isArray(file.parents) ? file.parents.map(String) : [],
  };
}

function createReceipt(prepared, file, { completedAt = new Date().toISOString(), recovered = false } = {}) {
  const body = {
    kind: RECEIPT_KIND,
    schema_version: 1,
    idempotency_key: prepared.idempotency_key,
    request: prepared.request,
    request_commitment: prepared.request_commitment,
    file: normalizeDriveFile(file),
    completed_at: completedAt,
    recovered_from_provider: Boolean(recovered),
  };
  return { ...body, receipt_commitment: commitment(body) };
}

function auditReceipt(receipt) {
  if (!receipt || receipt.kind !== RECEIPT_KIND || receipt.schema_version !== 1) {
    return { valid: false, reason: 'unsupported_receipt' };
  }
  const { receipt_commitment: claimed, ...body } = receipt;
  if (!/^[a-f0-9]{64}$/.test(String(claimed || '')) || commitment(body) !== claimed) {
    return { valid: false, reason: 'receipt_commitment_mismatch' };
  }
  if (commitment(receipt.request) !== receipt.request_commitment) {
    return { valid: false, reason: 'request_commitment_mismatch' };
  }
  try {
    validateIdempotencyKey(receipt.idempotency_key);
    validateFilename(receipt.request.filename);
    validateFolderId(receipt.request.parent_folder_id);
    normalizeDriveFile(receipt.file);
  } catch (error) {
    return { valid: false, reason: error.message };
  }
  return { valid: true, reason: null };
}

function emptyLedger() {
  return { version: LEDGER_VERSION, records: [] };
}

function normalizeLedger(value) {
  if (!value || value.version !== LEDGER_VERSION || !Array.isArray(value.records)) return emptyLedger();
  return { version: LEDGER_VERSION, records: value.records.filter(record => record && record.idempotency_key) };
}

function pruneLedger(ledger, maxRecords = 250) {
  const normalized = normalizeLedger(ledger);
  if (normalized.records.length <= maxRecords) return normalized;
  const pending = normalized.records.filter(record => record.state === 'pending');
  const settled = normalized.records.filter(record => record.state !== 'pending')
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, Math.max(0, maxRecords - pending.length));
  return { version: LEDGER_VERSION, records: [...pending, ...settled] };
}

module.exports = {
  MAX_ARTIFACT_BYTES,
  MIME_BY_EXTENSION,
  commitment,
  validateIdempotencyKey,
  prepareArtifactRequest,
  createReceipt,
  auditReceipt,
  emptyLedger,
  normalizeLedger,
  pruneLedger,
  normalizeDriveFile,
};
