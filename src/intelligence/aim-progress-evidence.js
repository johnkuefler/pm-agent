'use strict';

const crypto = require('crypto');

const PROTOCOL_VERSION = 1;
const TRANSPORT = 'server_bound_aim_progress_evidence_v1';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function cleanText(value, max = 1000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function entryPayload(entry = {}) {
  return {
    at: cleanText(entry.at || entry.date, 40),
    note: cleanText(entry.note, 1000),
    evidence: (Array.isArray(entry.evidence) ? entry.evidence : []).map(ref => ({
      type: cleanText(ref?.type, 40), id: cleanText(ref?.id, 200),
    })).filter(ref => ref.type && ref.id).slice(0, 12),
  };
}

function sourceSnapshot(memory = {}) {
  const id = cleanText(memory.id, 200);
  const fact = String(memory.fact == null ? '' : memory.fact).trim();
  if (!id || !fact) throw new Error('aim progress evidence must resolve to a stored memory');
  const payload = {
    type: 'memory', id,
    added: cleanText(memory.added, 40) || null,
    project: cleanText(memory.project, 500) || null,
    source: cleanText(memory.source, 80) || null,
    fact_commitment: commitment(fact),
  };
  return { ...payload, source_commitment: commitment(payload) };
}

function receiptPayload(receipt = {}) {
  const value = JSON.parse(JSON.stringify(receipt || {}));
  delete value.receipt_commitment;
  return value;
}

function createReceipt(entry, memories = [], now = new Date()) {
  const normalized = entryPayload(entry);
  if (!normalized.at || !normalized.note || !normalized.evidence.length) {
    throw new Error('receipt-bound aim progress requires a dated note and memory evidence');
  }
  if (normalized.evidence.some(ref => ref.type !== 'memory')) {
    throw new Error('receipt-bound aim progress currently accepts stored memory evidence only');
  }
  const byId = new Map((Array.isArray(memories) ? memories : []).map(memory => [String(memory?.id || ''), memory]));
  const sourceSnapshots = normalized.evidence.map(ref => {
    const memory = byId.get(ref.id);
    if (!memory) throw new Error(`aim progress evidence memory not found: ${ref.id}`);
    return sourceSnapshot(memory);
  });
  const observationDate = /^\d{4}-\d{2}-\d{2}/.exec(normalized.at)?.[0] || null;
  if (!observationDate || sourceSnapshots.some(source => !source.added
    || !String(source.added).startsWith(observationDate))) {
    throw new Error('aim progress evidence must come from a memory recorded on the progress date');
  }
  const boundAt = new Date(now).toISOString();
  if (!Number.isFinite(new Date(boundAt).getTime())) throw new Error('aim progress evidence requires a valid binding time');
  const receipt = {
    protocol_version: PROTOCOL_VERSION,
    transport: TRANSPORT,
    bound_at: boundAt,
    entry: normalized,
    source_snapshots: sourceSnapshots,
  };
  receipt.receipt_commitment = commitment(receiptPayload(receipt));
  return receipt;
}

function auditReceipt(receipt, entry = null) {
  const normalizedEntry = entryPayload(entry || receipt?.entry || {});
  const sources = Array.isArray(receipt?.source_snapshots) ? receipt.source_snapshots : [];
  const checks = {
    protocol_verified: receipt?.protocol_version === PROTOCOL_VERSION && receipt?.transport === TRANSPORT,
    binding_time_verified: Boolean(receipt?.bound_at && Number.isFinite(new Date(receipt.bound_at).getTime())),
    entry_binding_verified: canonicalJson(receipt?.entry) === canonicalJson(normalizedEntry),
    source_bindings_verified: Boolean(normalizedEntry.evidence.length
      && sources.length === normalizedEntry.evidence.length
      && sources.every((source, index) => {
        const ref = normalizedEntry.evidence[index];
        if (ref.type !== 'memory' || source?.type !== ref.type || source?.id !== ref.id
          || !/^[a-f0-9]{64}$/.test(String(source?.fact_commitment || ''))
          || !/^[a-f0-9]{64}$/.test(String(source?.source_commitment || ''))) return false;
        const { source_commitment: sourceCommitment, ...payload } = source;
        return sourceCommitment === commitment(payload);
      })),
    receipt_verified: Boolean(receipt?.receipt_commitment
      && receipt.receipt_commitment === commitment(receiptPayload(receipt))),
  };
  return { ...checks, complete_chain_verified: Object.values(checks).every(Boolean) };
}

function attachReceipt(entry, memories = [], now = new Date()) {
  const normalized = entryPayload(entry);
  return { ...normalized, evidence_receipt: createReceipt(normalized, memories, now) };
}

function verifiedEntry(entry) {
  return Boolean(entry?.evidence_receipt
    && auditReceipt(entry.evidence_receipt, entry).complete_chain_verified);
}

module.exports = {
  PROTOCOL_VERSION, TRANSPORT, canonicalJson, commitment, cleanText, entryPayload,
  sourceSnapshot, receiptPayload, createReceipt, auditReceipt, attachReceipt, verifiedEntry,
};
