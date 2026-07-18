'use strict';

const crypto = require('node:crypto');

const PROTOCOL_VERSION = 1;
const SESSION_PROTOCOL_VERSION = 2;
const RIGHTS_BASES = Object.freeze(['public_domain', 'open_license', 'user_provided_authorized']);
const SOURCE_KINDS = Object.freeze(['book', 'essay', 'manual', 'paper', 'other']);
const STANCES = Object.freeze(['agree', 'disagree', 'uncertain', 'complicate']);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function text(value, field, max, { optional = false } = {}) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
  if (!optional && !normalized) throw new Error(`developmental reading requires ${field}`);
  return normalized || null;
}

function sourceManifest(source) {
  return {
    id: source.id, protocol_version: source.protocol_version, title: source.title,
    author: source.author, source_kind: source.source_kind, source_url: source.source_url,
    rights_basis: source.rights_basis, rights_note: source.rights_note,
    content_commitment: source.content_commitment, content_chars: source.content_chars,
    chunk_commitments: source.chunk_commitments, admitted_by: source.admitted_by,
    admitted_at: source.admitted_at,
  };
}

function createSource(input = {}, at = new Date()) {
  const id = text(input.id, 'source id', 160);
  const rightsBasis = String(input.rights_basis || '');
  if (!RIGHTS_BASES.includes(rightsBasis)) throw new Error('reading source requires an allowed rights basis');
  const sourceKind = String(input.source_kind || 'book');
  if (!SOURCE_KINDS.includes(sourceKind)) throw new Error('reading source requires an allowed source kind');
  const sourceUrl = text(input.source_url, 'source URL', 1000);
  let parsed;
  try { parsed = new URL(sourceUrl); } catch { throw new Error('reading source URL must be valid'); }
  if (parsed.protocol !== 'https:') throw new Error('reading source URL must use HTTPS');
  const chunkCommitments = Array.isArray(input.chunk_commitments)
    ? input.chunk_commitments.map(String) : [];
  if (!chunkCommitments.length || chunkCommitments.length > 500
    || chunkCommitments.some(item => !/^[a-f0-9]{64}$/.test(item))) {
    throw new Error('reading source requires one to five hundred committed chunks');
  }
  const contentCommitment = String(input.content_commitment || '');
  const contentChars = Number(input.content_chars);
  if (!/^[a-f0-9]{64}$/.test(contentCommitment)
    || !Number.isInteger(contentChars) || contentChars < 500 || contentChars > 1500000) {
    throw new Error('reading source requires bounded committed content');
  }
  const source = {
    id, protocol_version: PROTOCOL_VERSION,
    title: text(input.title, 'title', 300), author: text(input.author, 'author', 240),
    source_kind: sourceKind, source_url: sourceUrl, rights_basis: rightsBasis,
    rights_note: text(input.rights_note, 'rights note', 800),
    content_commitment: contentCommitment, content_chars: contentChars,
    chunk_commitments: chunkCommitments, admitted_by: text(input.admitted_by, 'admitting actor', 120),
    admitted_at: new Date(at).toISOString(), status: 'available', content_manifest_commitment: null,
  };
  source.content_manifest_commitment = commitment(sourceManifest(source));
  return source;
}

function verifySource(source) {
  try {
    return Boolean(source?.protocol_version === PROTOCOL_VERSION
      && source.content_manifest_commitment === commitment(sourceManifest(source))
      && createSource(source, source.admitted_at).content_manifest_commitment
        === source.content_manifest_commitment);
  } catch { return false; }
}

function sessionManifest(session) {
  const manifest = {
    id: session.id, protocol_version: session.protocol_version, source_id: session.source_id,
    source_commitment: session.source_commitment, selected_by: session.selected_by,
    selection_rationale: session.selection_rationale, guiding_questions: session.guiding_questions,
    predicted_influence: session.predicted_influence, started_at: session.started_at,
  };
  if (Number(session.protocol_version) >= SESSION_PROTOCOL_VERSION) {
    manifest.selection_mode = session.selection_mode;
    manifest.selection_provider_receipt = session.selection_provider_receipt;
  }
  return manifest;
}

function sessionSelectionPayload(value) {
  return {
    decision: 'select', source_id: value.source_id,
    selection_rationale: value.selection_rationale,
    guiding_questions: value.guiding_questions,
    predicted_influence: value.predicted_influence,
  };
}

function createSession(source, input = {}, at = new Date()) {
  if (!verifySource(source) || source.status !== 'available') throw new Error('reading session requires an available verified source');
  const questions = Array.isArray(input.guiding_questions)
    ? input.guiding_questions.map(item => text(item, 'guiding question', 300)).slice(0, 3) : [];
  if (!questions.length) throw new Error('reading session requires one to three guiding questions');
  const id = text(input.id || `reading-${Date.now().toString(36)}-${commitment(`${source.id}:${at}`).slice(0, 8)}`,
    'session id', 180);
  const selection = {
    source_id: source.id,
    selection_rationale: text(input.selection_rationale, 'selection rationale', 1000),
    guiding_questions: questions,
    predicted_influence: text(input.predicted_influence, 'predicted influence', 800),
  };
  let selectionProviderReceipt = null;
  if (input.selection_provider_receipt) {
    selectionProviderReceipt = {
      response_id: text(input.selection_provider_receipt.response_id, 'selection provider response id', 300),
      provider: text(input.selection_provider_receipt.provider, 'selection provider', 100),
      model: text(input.selection_provider_receipt.model, 'selection provider model', 200),
      request_commitment: text(input.selection_provider_receipt.request_commitment,
        'selection provider request commitment', 64),
      selection_commitment: text(input.selection_provider_receipt.selection_commitment,
        'selection commitment', 64),
    };
    if (!/^[a-f0-9]{64}$/.test(selectionProviderReceipt.request_commitment)
      || selectionProviderReceipt.selection_commitment !== commitment(sessionSelectionPayload(selection))) {
      throw new Error('autonomous reading selection requires a committed provider request and exact selection');
    }
  }
  const session = {
    id, protocol_version: selectionProviderReceipt ? SESSION_PROTOCOL_VERSION : PROTOCOL_VERSION,
    source_id: source.id,
    source_commitment: source.content_manifest_commitment,
    selected_by: text(input.selected_by, 'selecting actor', 120),
    selection_rationale: selection.selection_rationale,
    guiding_questions: selection.guiding_questions,
    predicted_influence: selection.predicted_influence,
    ...(selectionProviderReceipt ? {
      selection_mode: 'provider_bound_autonomous',
      selection_provider_receipt: selectionProviderReceipt,
    } : {}),
    started_at: new Date(at).toISOString(), status: 'active', next_chunk_index: 0,
    notes: [], completed_at: null, encounter: null, session_manifest_commitment: null,
  };
  session.session_manifest_commitment = commitment(sessionManifest(session));
  return session;
}

function verifySession(session, source) {
  const supportedProtocol = [PROTOCOL_VERSION, SESSION_PROTOCOL_VERSION]
    .includes(Number(session?.protocol_version));
  const selectionReceiptVerified = Number(session?.protocol_version) < SESSION_PROTOCOL_VERSION
    || (session.selection_mode === 'provider_bound_autonomous'
      && /^[a-f0-9]{64}$/.test(session.selection_provider_receipt?.request_commitment || '')
      && session.selection_provider_receipt?.selection_commitment
        === commitment(sessionSelectionPayload(session)));
  return Boolean(verifySource(source) && supportedProtocol && selectionReceiptVerified
    && session.source_id === source.id && session.source_commitment === source.content_manifest_commitment
    && session.session_manifest_commitment === commitment(sessionManifest(session))
    && ['active', 'completed', 'abandoned'].includes(session.status));
}

function normalizeOutput(value = {}, { finalChunk = false } = {}) {
  const reactions = Array.isArray(value.reactions) ? value.reactions.slice(0, 4).map(item => {
    const stance = String(item?.stance || 'uncertain');
    if (!STANCES.includes(stance)) throw new Error('reading reaction has an invalid stance');
    const quote = text(item?.source_quote, 'source quote', 220, { optional: true });
    if (quote && quote.split(/\s+/).length > 25) throw new Error('reading source quotes may not exceed twenty-five words');
    return { idea: text(item?.idea, 'reaction idea', 400), stance, source_quote: quote,
      reflection: text(item?.reflection, 'reaction reflection', 600) };
  }) : [];
  if (!reactions.length) throw new Error('reading output requires at least one grounded reaction');
  const questions = Array.isArray(value.questions) ? value.questions
    .map(item => text(item, 'carried question', 300)).slice(0, 3) : [];
  let possibleRevision = null;
  if (value.possible_self_revision) {
    const confidence = Number(value.possible_self_revision.confidence);
    if (!Number.isFinite(confidence) || confidence < 0.1 || confidence > 0.6) {
      throw new Error('reading self-revision candidates require bounded provisional confidence');
    }
    possibleRevision = {
      before: text(value.possible_self_revision.before, 'prior view', 500),
      after: text(value.possible_self_revision.after, 'candidate revised view', 500),
      confidence: Number(confidence.toFixed(3)),
      falsifier: text(value.possible_self_revision.falsifier, 'revision falsifier', 500),
    };
  }
  let completion = null;
  if (finalChunk) {
    const supplied = value.completion || {};
    const list = (key, max) => Array.isArray(supplied[key])
      ? supplied[key].map(item => text(item, key, 500)).slice(0, max) : [];
    completion = {
      lasting_ideas: list('lasting_ideas', 5), disagreements: list('disagreements', 3),
      changed_my_mind: text(supplied.changed_my_mind, 'mind-change summary', 800, { optional: true }),
      questions_to_carry: list('questions_to_carry', 5),
      expected_work_transfer: text(supplied.expected_work_transfer, 'expected work transfer', 800),
      personality_influence_candidate: text(supplied.personality_influence_candidate,
        'personality influence candidate', 800),
      counterevidence_needed: text(supplied.counterevidence_needed, 'counterevidence needed', 800),
    };
    if (!completion.lasting_ideas.length || !completion.questions_to_carry.length) {
      throw new Error('final reading output requires lasting ideas and carried questions');
    }
  }
  return { summary: text(value.summary, 'chunk summary', 700), reactions, questions,
    possible_self_revision: possibleRevision, completion };
}

function noteManifest(note) {
  return {
    id: note.id, protocol_version: note.protocol_version, session_id: note.session_id,
    source_id: note.source_id, chunk_index: note.chunk_index,
    chunk_commitment: note.chunk_commitment, output: note.output,
    prior_note_commitment: note.prior_note_commitment, day_key: note.day_key,
    provider_receipt: note.provider_receipt, recorded_at: note.recorded_at,
  };
}

function appendNote(session, source, input = {}, at = new Date()) {
  if (!verifySession(session, source) || session.status !== 'active') throw new Error('reading note requires an active verified session');
  const index = Number(input.chunk_index);
  if (!Number.isInteger(index) || index !== session.next_chunk_index
    || index < 0 || index >= source.chunk_commitments.length) {
    throw new Error('reading chunks must be committed exactly once in source order');
  }
  if (input.chunk_commitment !== source.chunk_commitments[index]) throw new Error('reading chunk commitment mismatch');
  const dayKey = String(input.day_key || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) throw new Error('reading note requires a bounded day key');
  const receipt = {
    response_id: text(input.provider_receipt?.response_id, 'provider response id', 300),
    provider: text(input.provider_receipt?.provider, 'provider', 100),
    model: text(input.provider_receipt?.model, 'provider model', 200),
    request_commitment: text(input.provider_receipt?.request_commitment, 'provider request commitment', 64),
  };
  if (!/^[a-f0-9]{64}$/.test(receipt.request_commitment)) throw new Error('reading note requires a committed provider request');
  const finalChunk = index === source.chunk_commitments.length - 1;
  const note = {
    id: `${session.id}:chunk-${String(index + 1).padStart(4, '0')}`,
    protocol_version: PROTOCOL_VERSION, session_id: session.id, source_id: source.id,
    chunk_index: index, chunk_commitment: source.chunk_commitments[index],
    output: normalizeOutput(input.output, { finalChunk }),
    prior_note_commitment: session.notes.at(-1)?.note_commitment || null, day_key: dayKey,
    provider_receipt: receipt, recorded_at: new Date(at).toISOString(), note_commitment: null,
  };
  note.note_commitment = commitment(noteManifest(note));
  session.notes.push(note);
  session.next_chunk_index += 1;
  if (finalChunk) {
    session.status = 'completed'; session.completed_at = note.recorded_at;
    session.encounter = {
      protocol_version: PROTOCOL_VERSION, source_id: source.id, session_id: session.id,
      title: source.title, author: source.author, completed_at: session.completed_at,
      selection_rationale: session.selection_rationale, guiding_questions: session.guiding_questions,
      predicted_influence: session.predicted_influence, synthesis: note.output.completion,
      ...(Number(session.protocol_version) >= SESSION_PROTOCOL_VERSION ? {
        selection_mode: session.selection_mode,
        selection_provider_receipt: session.selection_provider_receipt,
      } : {}),
      note_commitments: session.notes.map(item => item.note_commitment), encounter_commitment: null,
      epistemic_status: 'A source-bound intellectual encounter and provisional self-report. It is not a persona edit, trained weight change, independent validation, subjective-experience proof, or consciousness evidence.',
    };
    session.encounter.encounter_commitment = commitment({ ...session.encounter, encounter_commitment: null });
  }
  return note;
}

function auditSession(session, source) {
  const base = verifySession(session, source);
  let prior = null;
  const notes = base && session.notes.every((note, index) => {
    const valid = note.chunk_index === index && note.chunk_commitment === source.chunk_commitments[index]
      && note.prior_note_commitment === prior && note.note_commitment === commitment(noteManifest(note));
    prior = note.note_commitment;
    return valid;
  });
  const progress = base && notes && session.next_chunk_index === session.notes.length;
  const completed = session.status !== 'completed' || Boolean(session.encounter
    && session.notes.length === source.chunk_commitments.length
    && session.encounter.encounter_commitment
      === commitment({ ...session.encounter, encounter_commitment: null }));
  return { source_verified: verifySource(source), session_verified: base,
    note_chain_verified: notes, progress_verified: progress, completion_verified: completed,
    complete_chain_verified: base && notes && progress && completed };
}

module.exports = {
  PROTOCOL_VERSION, SESSION_PROTOCOL_VERSION, RIGHTS_BASES, SOURCE_KINDS, STANCES,
  canonicalJson, commitment, sourceManifest, createSource, verifySource,
  sessionManifest, sessionSelectionPayload, createSession, verifySession, normalizeOutput, noteManifest,
  appendNote, auditSession,
};
