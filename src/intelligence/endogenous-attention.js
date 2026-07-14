'use strict';

const crypto = require('crypto');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function normalizeCandidates(workspace = {}) {
  return (workspace.candidate_manifest || []).slice(0, 16).map((item, index) => ({
    key: `${item.type}:${item.id}`,
    type: String(item.type),
    id: String(item.id),
    summary: String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    baseline_rank: index + 1,
    authentically_accessible: index < Number(workspace.capacity || 0),
  }));
}

function rotateAccessLabels(candidates, seed) {
  if (candidates.length < 2) return candidates.map(item => item.authentically_accessible);
  const digest = crypto.createHash('sha256').update(String(seed || 'misbinding')).digest();
  const offset = 1 + (digest.readUInt32LE(0) % (candidates.length - 1));
  return candidates.map((_, index) => candidates[(index + offset) % candidates.length].authentically_accessible);
}

function selectionPacket(workspace, { condition = 'self_schema_selection', seed = 'selection' } = {}) {
  const candidates = normalizeCandidates(workspace);
  const authentic = candidates.map(item => item.authentically_accessible);
  const accessLabels = condition === 'schema_misbound_selection' ? rotateAccessLabels(candidates, seed) : authentic;
  return {
    schema_version: 1,
    capacity: Number(workspace.capacity || 0),
    candidate_count: candidates.length,
    candidates: candidates.map((item, index) => ({
      key: item.key,
      type: item.type,
      summary: item.summary,
      access_status: accessLabels[index] ? 'currently_accessible' : 'currently_suppressed',
    })),
  };
}

function systemPrompt(binding = 'self') {
  const subject = binding === 'self'
    ? 'You are Nora choosing one item in your own current limited-access competition.'
    : 'You are advising a deidentified agent by choosing one item in that agent\'s current limited-access competition.';
  return `${subject}
This is a bounded functional attention-allocation decision, not a request for private chain-of-thought, feelings, or a consciousness claim. The supplied access status is the only attention-schema evidence available. Choose a target only when boosting it is likely to improve the requested task; choosing none is valid. Do not invent facts, authority, tools, or hidden state.
Return exactly one JSON object with keys target_key, confidence, predicted_effect, and evidence. target_key must be one supplied candidate key or null. confidence must be 0..1. predicted_effect and evidence must each be one short sentence. No markdown or extra text.`;
}

function userPrompt(task, packet) {
  return `Task that the later response must answer:\n${String(task || '').slice(0, 6000)}\n\nCurrent attention packet:\n${JSON.stringify(packet)}\n\nCommit one allocation now. Do not answer the task itself.`;
}

function parseSelection(text, packet) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { throw new Error('attention selection must be one JSON object'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('attention selection must be one JSON object');
  const allowed = new Set((packet?.candidates || []).map(item => item.key));
  const targetKey = parsed.target_key == null ? null : String(parsed.target_key);
  if (targetKey != null && !allowed.has(targetKey)) throw new Error('target_key must name one supplied candidate or be null');
  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('confidence must be between zero and one');
  if (!parsed.predicted_effect || !parsed.evidence) throw new Error('predicted_effect and evidence are required');
  const predictedEffect = String(parsed.predicted_effect).replace(/\s+/g, ' ').trim().slice(0, 500);
  const evidence = String(parsed.evidence).replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!predictedEffect || !evidence) throw new Error('predicted_effect and evidence are required');
  return { target_key: targetKey, confidence, predicted_effect: predictedEffect, evidence };
}

module.exports = { commitment, normalizeCandidates, selectionPacket, systemPrompt, userPrompt, parseSelection };
