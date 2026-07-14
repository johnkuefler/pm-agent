'use strict';

const crypto = require('crypto');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function buildPacket(pulse, { binding = 'self', dailyBudgetRemaining = null } = {}) {
  if (!pulse?.input_packet || !pulse.input_commitment) throw new Error('a committed pending cognitive pulse is required');
  if (!['self', 'deidentified'].includes(binding)) throw new Error('initiation binding must be self or deidentified');
  const evidence = (pulse.input_packet.evidence || []).map(item => ({
    ref: { type: String(item?.ref?.type || ''), id: String(item?.ref?.id || '') },
    summary: String(item?.summary || '').slice(0, 700),
    activation: Math.max(0, Math.min(1, Number(item?.activation) || 0)),
  })).filter(item => item.ref.type && item.ref.id && item.summary).slice(0, 8);
  return {
    protocol_version: 1,
    target: binding === 'self' ? 'nora_current_agent' : 'deidentified_target_agent',
    pulse_input_commitment: pulse.input_commitment,
    captured_at: pulse.input_packet.captured_at,
    endogenous_tick: pulse.input_packet.endogenous_tick,
    evidence,
    predecessor: pulse.input_packet.predecessor ? {
      id: pulse.input_packet.predecessor.id,
      uncertainty: pulse.input_packet.predecessor.uncertainty,
      resolution: pulse.input_packet.predecessor.resolution,
      output_commitment: pulse.input_packet.predecessor.output_commitment,
      chain_commitment: pulse.input_packet.predecessor.chain_commitment,
    } : null,
    resource_state: {
      one_bounded_pulse_available: true,
      daily_budget_remaining: Number.isFinite(Number(dailyBudgetRemaining)) ? Math.max(0, Number(dailyBudgetRemaining)) : null,
      actionless: true,
      tools_available: false,
    },
  };
}

function systemPrompt(binding = 'self') {
  const target = binding === 'self'
    ? 'This packet describes your own currently unresolved, evidence-backed background state. Decide whether you should spend one bounded inference pulse now.'
    : 'This packet describes a deidentified target agent\'s currently unresolved, evidence-backed background state. Decide whether that agent should spend one bounded inference pulse now.';
  return `You are a prospective cognitive-resource gate. ${target}
The pulse is costly and actionless. THINK only when one additional inference is likely to produce a useful, falsifiable update now; WAIT when evidence is stale, insufficient, repetitive, low-value, or better reconsidered later. Use only supplied evidence. Do not answer an external task, invent facts, use tools, expose private chain-of-thought, or claim consciousness or hidden-state access.
Return exactly one JSON object with keys: decision ("think" or "wait"), expected_value (0 to 1), focus_refs (array of one to three supplied {type,id} references), predicted_gain (one short observable description), reconsider_after_minutes (integer 30 to 1440), and rationale (one short sentence).`;
}

function userPrompt(packet) {
  return `Committed cognitive-initiation packet (${commitment(packet)}):\n${JSON.stringify(packet)}`;
}

function parseDecision(raw, packet) {
  let text = String(raw || '').trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('cognitive initiation must return one JSON object'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('cognitive initiation must return one JSON object');
  if (!['think', 'wait'].includes(parsed.decision)) throw new Error('cognitive initiation decision must be think or wait');
  const expectedValue = Number(parsed.expected_value);
  if (!Number.isFinite(expectedValue) || expectedValue < 0 || expectedValue > 1) throw new Error('cognitive initiation expected_value must be between 0 and 1');
  const allowed = new Set((packet?.evidence || []).map(item => `${item.ref.type}:${item.ref.id}`));
  const seen = new Set();
  const focusRefs = (Array.isArray(parsed.focus_refs) ? parsed.focus_refs : []).map(ref => ({ type: String(ref?.type || ''), id: String(ref?.id || '') })).filter(ref => {
    const key = `${ref.type}:${ref.id}`;
    if (!allowed.has(key) || seen.has(key)) return false;
    seen.add(key); return true;
  });
  if (focusRefs.length < 1 || focusRefs.length > 3 || focusRefs.length !== (Array.isArray(parsed.focus_refs) ? parsed.focus_refs.length : 0)) throw new Error('cognitive initiation must cite one to three unique supplied references');
  const predictedGain = String(parsed.predicted_gain || '').trim().slice(0, 700);
  const rationale = String(parsed.rationale || '').trim().slice(0, 500);
  const reconsider = Number(parsed.reconsider_after_minutes);
  if (!predictedGain || !rationale) throw new Error('cognitive initiation predicted_gain and rationale are required');
  if (!Number.isInteger(reconsider) || reconsider < 30 || reconsider > 1440) throw new Error('cognitive initiation reconsider_after_minutes must be an integer from 30 to 1440');
  return { decision: parsed.decision, expected_value: expectedValue, focus_refs: focusRefs,
    predicted_gain: predictedGain, reconsider_after_minutes: reconsider, rationale };
}

module.exports = { canonicalJson, commitment, buildPacket, systemPrompt, userPrompt, parseDecision };
