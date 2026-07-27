'use strict';

const crypto = require('crypto');

const PROTOCOL_VERSION = 1;
const MANUAL_ATTESTATION_SCOPE = 'intelligence:evidence:manual-attest';
const MAX_REFERENCES = 30;
const MAX_SOURCE_SNAPSHOT_BYTES = 64 * 1024;

const STORE_SOURCES = Object.freeze({
  commitment: { collection: 'commitments', canonicalType: 'commitment' },
  episode: { collection: 'episodes', canonicalType: 'episode' },
  relationship: { collection: 'relationships', canonicalType: 'relationship' },
  decision_trace: { collection: 'traces', canonicalType: 'decision_trace' },
  trace: { collection: 'traces', canonicalType: 'decision_trace' },
  learning_experiment: { collection: 'experiments', canonicalType: 'learning_experiment' },
  experiment: { collection: 'experiments', canonicalType: 'learning_experiment' },
  intelligence_cycle: { collection: 'cycles', canonicalType: 'intelligence_cycle' },
  cycle: { collection: 'cycles', canonicalType: 'intelligence_cycle' },
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function boundedSourceSnapshot(record) {
  let serialized;
  try { serialized = JSON.stringify(record); }
  catch {
    throw new Error('canonical evidence source is not JSON serializable');
  }
  if (typeof serialized !== 'string') {
    throw new Error('canonical evidence source is not JSON serializable');
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_SOURCE_SNAPSHOT_BYTES) {
    throw new Error(`canonical evidence source exceeds ${MAX_SOURCE_SNAPSHOT_BYTES} byte snapshot limit`);
  }
  return JSON.parse(serialized);
}

function cleanText(value, maximum) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maximum);
}

function normalizeReference(reference, field = 'evidence') {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
    throw new Error(`${field} references must be objects`);
  }
  const type = cleanText(reference.type || reference.channel, 100).toLowerCase();
  const id = cleanText(reference.id, 500);
  const url = cleanText(reference.url, 1000);
  if (!type || (!id && !url)) {
    throw new Error(`${field} references require type and id or url`);
  }
  return { type, ...(id ? { id } : {}), ...(url ? { url } : {}) };
}

function principalScopes(principal = {}) {
  const raw = Array.isArray(principal.scopes) ? principal.scopes
    : typeof principal.scope === 'string' ? principal.scope.split(/\s+/)
      : [];
  return new Set(raw.map(value => cleanText(value, 160)).filter(Boolean));
}

function actorFromPrincipal(principal = {}) {
  const kind = cleanText(principal.kind, 100);
  const id = cleanText(principal.id, 200);
  if (!kind || !id) throw new Error('authenticated principal identity is required');
  return {
    kind,
    id,
    authentication: cleanText(principal.authentication, 100) || 'authenticated_middleware',
  };
}

function manualAttestationAuthority(principal = {}) {
  let actor;
  try { actor = actorFromPrincipal(principal); }
  catch { return null; }
  const scopes = principalScopes(principal);
  const explicitlyScoped = scopes.has(MANUAL_ATTESTATION_SCOPE);
  const researchCredential = actor.kind === 'research'
    && actor.authentication === 'research_key';
  const operatorCredential = actor.kind === 'dashboard_operator'
    && ['signed_operator_session', 'signed_dashboard_bearer', 'basic_password']
      .includes(actor.authentication);
  if (actor.kind === 'research' && (researchCredential || explicitlyScoped)) {
    return { ...actor, kind: 'research' };
  }
  if (actor.kind === 'dashboard_operator' && (operatorCredential || explicitlyScoped)) {
    return { ...actor, kind: 'operator' };
  }
  return null;
}

function manualAttestationRequest(input = {}) {
  if (input?.manual_attestation != null) return input.manual_attestation;
  if (input?.evidence_mode === 'manual_attestation') {
    return {
      authority: input.manual_attestation_authority,
      rationale: input.manual_attestation_rationale,
    };
  }
  return null;
}

function normalizeManualAttestation(request, principal) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('manual_attestation must be an explicit object');
  }
  const authority = manualAttestationAuthority(principal);
  if (!authority) {
    throw new Error('manual evidence attestation requires an authenticated operator or research principal');
  }
  const requestedAuthority = cleanText(request.authority, 40).toLowerCase();
  if (requestedAuthority && requestedAuthority !== authority.kind) {
    throw new Error(`manual evidence attestation authority does not match authenticated ${authority.kind} scope`);
  }
  const statement = cleanText(request.rationale || request.statement || request.note, 1200);
  if (!statement) throw new Error('manual evidence attestation requires a rationale');
  return { authority, statement };
}

function safeRecords(getter) {
  if (typeof getter !== 'function') return [];
  try {
    const value = getter();
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function sourceIdentityMatches(record, reference, { externalIds = false } = {}) {
  if (!record || typeof record !== 'object') return false;
  if (reference.id && String(record.id || '') === reference.id) return true;
  if (reference.url) {
    return [record.url, record.source_url, record.link]
      .filter(Boolean).some(value => String(value) === reference.url);
  }
  if (!externalIds || !reference.id) return false;
  return [record.ts, record.thread_ts, record.external_id, record.source_ref?.id]
    .filter(Boolean).some(value => String(value) === reference.id);
}

function additionalSourceDescriptor(value, requestedType) {
  if (Array.isArray(value)) return { canonicalType: requestedType, records: value };
  if (!value || typeof value !== 'object') return null;
  const records = typeof value.getRecords === 'function' ? safeRecords(value.getRecords)
    : Array.isArray(value.records) ? value.records : [];
  return {
    canonicalType: cleanText(value.canonicalType || value.canonical_type || requestedType, 100)
      .toLowerCase(),
    records,
    externalIds: value.externalIds === true || value.external_ids === true,
  };
}

function canonicalReferenceShape(reference = {}) {
  return {
    type: String(reference.type || ''),
    ...(reference.id ? { id: String(reference.id) } : {}),
    ...(reference.url ? { url: String(reference.url) } : {}),
  };
}

function canonicalEvidenceReceiptPayload(reference = {}) {
  const receipt = reference.canonical_evidence || {};
  return {
    protocol_version: receipt.protocol_version,
    mode: receipt.mode,
    reference: canonicalReferenceShape(reference),
    source_snapshot: receipt.source_snapshot,
    captured_at: receipt.captured_at,
    source_commitment: receipt.source_commitment,
    resolved_by: receipt.resolved_by,
  };
}

function referenceReceipt(reference, record, actor, capturedAt) {
  const sourceSnapshot = boundedSourceSnapshot(record);
  const result = {
    ...reference,
    canonical_evidence: {
      protocol_version: PROTOCOL_VERSION,
      mode: 'canonical_resolution',
      source_snapshot: sourceSnapshot,
      captured_at: capturedAt,
      source_commitment: commitment(sourceSnapshot),
      resolved_by: { kind: actor.kind, id: actor.id },
    },
  };
  result.canonical_evidence.receipt_commitment =
    commitment(canonicalEvidenceReceiptPayload(result));
  return result;
}

function auditCanonicalEvidence(reference, currentRecord = null) {
  const receipt = reference?.canonical_evidence || {};
  let snapshotBytes = null;
  let snapshotSerializable = false;
  try {
    const serialized = JSON.stringify(receipt.source_snapshot);
    snapshotBytes = typeof serialized === 'string'
      ? Buffer.byteLength(serialized, 'utf8') : null;
    snapshotSerializable = snapshotBytes != null
      && snapshotBytes <= MAX_SOURCE_SNAPSHOT_BYTES;
  } catch {
    snapshotSerializable = false;
  }
  const protocolVerified = receipt.protocol_version === PROTOCOL_VERSION
    && receipt.mode === 'canonical_resolution';
  const capturedAtVerified = Number.isFinite(new Date(receipt.captured_at).getTime());
  const snapshotCommitmentVerified = snapshotSerializable
    && Boolean(receipt.source_commitment)
    && receipt.source_commitment === commitment(receipt.source_snapshot);
  const receiptCommitmentVerified = Boolean(receipt.receipt_commitment)
    && receipt.receipt_commitment === commitment(canonicalEvidenceReceiptPayload(reference));
  let currentSourceMatch = null;
  if (currentRecord != null) {
    try {
      currentSourceMatch = commitment(boundedSourceSnapshot(currentRecord))
        === receipt.source_commitment;
    } catch {
      currentSourceMatch = false;
    }
  }
  const complete = protocolVerified && capturedAtVerified
    && snapshotCommitmentVerified && receiptCommitmentVerified
    && currentSourceMatch !== false;
  return {
    complete_chain_verified: complete,
    protocol_verified: protocolVerified,
    captured_at_verified: capturedAtVerified,
    snapshot_serializable_and_bounded: snapshotSerializable,
    snapshot_bytes: snapshotBytes,
    source_commitment_verified: snapshotCommitmentVerified,
    receipt_commitment_verified: receiptCommitmentVerified,
    current_source_match: currentSourceMatch,
    reason: complete ? null : 'canonical_evidence_receipt_failed_replay',
  };
}

function manualReferenceReceipt(reference, normalized) {
  const payload = {
    protocol_version: PROTOCOL_VERSION,
    mode: 'authorized_manual_attestation',
    source_reference: reference,
    authority: {
      kind: normalized.authority.kind,
      principal_kind: normalized.authority.kind === 'operator'
        ? 'dashboard_operator' : normalized.authority.kind,
      id: normalized.authority.id,
      authentication: normalized.authority.authentication,
    },
    statement: normalized.statement,
  };
  const attestationCommitment = commitment(payload);
  return {
    type: 'manual_attestation',
    id: `manual-attestation-${attestationCommitment}`,
    attested_reference: reference,
    evidence_attestation: {
      ...payload,
      attestation_commitment: attestationCommitment,
    },
  };
}

function createCanonicalEvidenceResolver({
  store = null,
  getDreams = () => [],
  getWants = () => [],
  getInteractions = () => [],
  getPredictions = () => [],
  getMemory = () => [],
  getConsequenceReviews = () => ({}),
  getAdditionalSources = () => ({}),
  resolveReference = null,
  clock = () => new Date(),
} = {}) {
  function builtInSource(reference) {
    const directSources = {
      dream: { canonicalType: 'dream', records: safeRecords(getDreams) },
      want: { canonicalType: 'want', records: safeRecords(getWants) },
      interaction: { canonicalType: 'interaction', records: safeRecords(getInteractions) },
      prediction: { canonicalType: 'prediction', records: safeRecords(getPredictions) },
      memory: { canonicalType: 'memory', records: safeRecords(getMemory) },
    };
    if (directSources[reference.type]) return directSources[reference.type];

    if (['slack', 'message', 'slack_message'].includes(reference.type)) {
      return { canonicalType: 'slack_message', records: safeRecords(getInteractions),
        externalIds: true };
    }

    let consequenceLedger = {};
    if (typeof getConsequenceReviews === 'function') {
      try { consequenceLedger = getConsequenceReviews() || {}; }
      catch { consequenceLedger = {}; }
    }
    if (reference.type === 'consequence_action') {
      return { canonicalType: 'consequence_action',
        records: Array.isArray(consequenceLedger.actions) ? consequenceLedger.actions : [] };
    }
    if (reference.type === 'consequence_observation') {
      return { canonicalType: 'consequence_observation',
        records: Array.isArray(consequenceLedger.observations) ? consequenceLedger.observations : [] };
    }
    if (reference.type === 'consequence_application') {
      return { canonicalType: 'consequence_application',
        records: Array.isArray(consequenceLedger.applications) ? consequenceLedger.applications : [] };
    }

    const storeSource = STORE_SOURCES[reference.type];
    if (storeSource && typeof store?.list === 'function') {
      return {
        canonicalType: storeSource.canonicalType,
        records: safeRecords(() => store.list(storeSource.collection)),
      };
    }
    if (['development', 'experience_moment', 'mind_change'].includes(reference.type)
      && typeof store?.autobiographyEvidence === 'function') {
      const resolved = store.autobiographyEvidence(reference);
      return resolved?.record
        ? { canonicalType: reference.type, records: [resolved.record] } : null;
    }

    const additional = typeof getAdditionalSources === 'function'
      ? (getAdditionalSources() || {}) : {};
    return additionalSourceDescriptor(additional[reference.type], reference.type);
  }

  function resolveOne(reference, {
    principal,
    field = 'evidence',
    capturedAt = new Date(clock()).toISOString(),
  } = {}) {
    const normalized = normalizeReference(reference, field);
    const actor = actorFromPrincipal(principal);
    if (!Number.isFinite(new Date(capturedAt).getTime())) {
      throw new Error('canonical evidence capture time is invalid');
    }
    if (typeof resolveReference === 'function') {
      const externallyResolved = resolveReference(normalized);
      if (externallyResolved?.record) {
        const canonical = normalizeReference(
          externallyResolved.reference || normalized, field);
        return referenceReceipt(canonical, externallyResolved.record, actor, capturedAt);
      }
    }
    const source = builtInSource(normalized);
    if (!source) throw new Error(`${field} reference not found: ${normalized.type}:${normalized.id || normalized.url}`);
    const record = source.records.find(candidate =>
      sourceIdentityMatches(candidate, normalized, { externalIds: source.externalIds }));
    if (!record) {
      throw new Error(`${field} reference not found: ${normalized.type}:${normalized.id || normalized.url}`);
    }
    const canonicalReference = {
      type: source.canonicalType,
      ...(normalized.id ? { id: normalized.id } : {}),
      ...(normalized.url ? { url: normalized.url } : {}),
    };
    return referenceReceipt(canonicalReference, record, actor, capturedAt);
  }

  function resolve(references, {
    principal,
    field = 'evidence',
    manualAttestation = null,
    allowSingle = false,
    preserveShape = false,
  } = {}) {
    const wasArray = Array.isArray(references);
    const list = wasArray ? references : allowSingle && references ? [references] : null;
    if (!list?.length) throw new Error(`${field} requires at least one evidence reference`);
    if (list.length > MAX_REFERENCES) {
      throw new Error(`${field} accepts at most ${MAX_REFERENCES} evidence references`);
    }
    let resolved;
    if (manualAttestation != null) {
      const normalized = normalizeManualAttestation(manualAttestation, principal);
      resolved = list.map(reference =>
        manualReferenceReceipt(normalizeReference(reference, field), normalized));
    } else {
      const capturedAt = new Date(clock()).toISOString();
      resolved = list.map(reference =>
        resolveOne(reference, { principal, field, capturedAt }));
    }
    const seen = new Set();
    for (const reference of resolved) {
      const key = `${reference.type}:${reference.id || reference.url}`;
      if (seen.has(key)) throw new Error(`${field} cannot repeat the same evidence reference`);
      seen.add(key);
    }
    return preserveShape && !wasArray ? resolved[0] : resolved;
  }

  return { resolve, resolveOne };
}

module.exports = {
  MANUAL_ATTESTATION_SCOPE,
  MAX_SOURCE_SNAPSHOT_BYTES,
  PROTOCOL_VERSION,
  actorFromPrincipal,
  auditCanonicalEvidence,
  boundedSourceSnapshot,
  canonicalJson,
  canonicalEvidenceReceiptPayload,
  commitment,
  createCanonicalEvidenceResolver,
  manualAttestationAuthority,
  manualAttestationRequest,
  normalizeReference,
};
