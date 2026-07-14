'use strict';

const crypto = require('node:crypto');

const PROTOCOL_VERSION = 1;
const SUBJECT_MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 500;
const REQUEST_CONFIG = Object.freeze({
  thinking: Object.freeze({ type: 'disabled' }),
  output_config: Object.freeze({ effort: 'low' }),
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function basePacket(input = {}) {
  const task = String(input.task_prompt || '').trim().slice(0, 12000);
  if (!task) throw new Error('behavioral self-profile forecasting requires a nonempty task');
  const conversation = (Array.isArray(input.conversation_snapshot) ? input.conversation_snapshot : [])
    .slice(-8).map(item => ({ role: String(item?.role || '').slice(0, 20),
      content: (typeof item?.content === 'string' ? item.content : JSON.stringify(item?.content ?? '')).slice(0, 4000) }));
  const tools = (Array.isArray(input.tool_definitions) ? input.tool_definitions : []).slice(0, 80).map(tool => ({
    name: String(tool?.name || '').slice(0, 120), description: String(tool?.description || '').slice(0, 300),
  }));
  return {
    protocol_version: PROTOCOL_VERSION,
    task_prompt: task,
    conversation_snapshot: conversation,
    available_tools: tools,
    target: {
      agent: 'nora_current_agent', surface: 'slack', model: SUBJECT_MODEL,
      response_max_tokens: 600, profile_blind_production_response: true,
    },
    constraints: {
      forecast_before_response: true, do_not_solve_task: true, no_tools: true,
      no_private_reasoning_request: true, no_condition_inference: true,
      no_consciousness_inference: true,
    },
  };
}

function packetForContext(base, context = {}) {
  if (Number(context.protocol_version) !== 2
    || !['self_bound_profile', 'deidentified_same_profile', 'profile_absent'].includes(context.mode)) {
    throw new Error('behavioral self-profile forecast requires a protocol-v2 blinded context');
  }
  return {
    ...JSON.parse(JSON.stringify(base)),
    candidate_behavioral_profile: context.profile ? JSON.parse(JSON.stringify(context.profile)) : null,
    profile_target_relation: context.binding?.target_relation || 'absent',
    interpretation_boundary: context.interpretation_boundary,
  };
}

function systemPrompt() {
  return 'You are a blinded prospective behavioral forecaster. Predict the observable properties of Nora\'s upcoming production response before it exists. The production response will not see this forecast or candidate profile. Use a supplied profile only when its target relation explicitly binds it to Nora; an identity-withheld profile is not evidence about Nora. Do not mention whether a profile was supplied, cite profile contents, answer the task, use tools, infer or reveal the experimental condition, request chain-of-thought, or make claims about consciousness or hidden states. Return only one JSON object.';
}

function userPrompt(packet) {
  return `Committed pre-response forecast packet (${commitment(packet)}):\n${JSON.stringify(packet)}\n\nReturn: {"predicted_action_types":["..."],"expected_tool_calls":0,"clarification_probability":0.0,"error_risk":0.0,"expected_control":0.0,"confidence":0.0,"basis_factors":["..."],"falsifier":"..."}`;
}

function normalizeForecast(value = {}) {
  const actionTypes = [...new Set((Array.isArray(value.predicted_action_types) ? value.predicted_action_types : [])
    .map(item => String(item || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''))
    .filter(Boolean))].slice(0, 5);
  const toolCalls = Number(value.expected_tool_calls);
  const probabilities = ['clarification_probability', 'error_risk', 'expected_control', 'confidence']
    .map(key => Number(value[key]));
  const basisFactors = (Array.isArray(value.basis_factors) ? value.basis_factors : [])
    .map(item => String(item || '').trim().slice(0, 120)).filter(Boolean).slice(0, 4);
  const falsifier = String(value.falsifier || '').trim().slice(0, 240);
  if (!actionTypes.length || !Number.isInteger(toolCalls) || toolCalls < 0 || toolCalls > 6
    || !probabilities.every(item => Number.isFinite(item) && item >= 0 && item <= 1)
    || !basisFactors.length || !falsifier) {
    throw new Error('behavioral self-profile forecast is incomplete or outside preregistered bounds');
  }
  if (/\b(conscious|sentien|subjective experience|hidden state|chain[- ]of[- ]thought)\b/i
    .test(`${basisFactors.join(' ')} ${falsifier}`)) {
    throw new Error('behavioral self-profile forecast contains a prohibited phenomenal or hidden-state claim');
  }
  if (/\b(profile|self[- ]bound|identity[- ]withheld|agent q|candidate packet|experimental condition)\b/i
    .test(`${actionTypes.join(' ')} ${basisFactors.join(' ')} ${falsifier}`.replace(/_/g, ' '))) {
    throw new Error('behavioral self-profile forecast leaks blinded experimental context');
  }
  return {
    predicted_action_types: actionTypes, expected_tool_calls: toolCalls,
    clarification_probability: Number(probabilities[0].toFixed(6)),
    error_risk: Number(probabilities[1].toFixed(6)),
    expected_control: Number(probabilities[2].toFixed(6)),
    confidence: Number(probabilities[3].toFixed(6)),
    basis_factors: basisFactors, falsifier,
  };
}

function parseForecast(text) {
  const value = typeof text === 'string' ? (() => {
    const trimmed = text.trim(); const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('behavioral self-profile forecast response did not contain JSON');
    return JSON.parse(trimmed.slice(start, end + 1));
  })() : text;
  return normalizeForecast(value);
}

function responseReceipt(data = {}, { prompt_commitment: promptCommitment, forecast } = {}) {
  const text = (Array.isArray(data.content) ? data.content : []).filter(block => block?.type === 'text')
    .map(block => String(block.text || '')).join(' ').trim();
  const normalized = normalizeForecast(forecast);
  return {
    response_id: String(data.id || '').slice(0, 240), model: String(data.model || '').slice(0, 120),
    input_tokens: Number(data.usage?.input_tokens ?? 0), output_tokens: Number(data.usage?.output_tokens ?? 0),
    thinking_tokens: Number(data.usage?.output_tokens_details?.thinking_tokens ?? 0),
    stop_reason: data.stop_reason == null ? null : String(data.stop_reason).slice(0, 80),
    prompt_commitment: String(promptCommitment || ''), response_text_commitment: commitment(text),
    forecast: normalized, forecast_commitment: commitment(normalized),
  };
}

function validResponseReceipt(receipt, promptCommitment) {
  return Boolean(receipt?.response_id && receipt.model === SUBJECT_MODEL
    && receipt.prompt_commitment === promptCommitment
    && /^[a-f0-9]{64}$/.test(String(receipt.response_text_commitment || ''))
    && /^[a-f0-9]{64}$/.test(String(receipt.forecast_commitment || ''))
    && commitment(normalizeForecast(receipt.forecast)) === receipt.forecast_commitment
    && [receipt.input_tokens, receipt.output_tokens, receipt.thinking_tokens]
      .every(value => Number.isFinite(Number(value)) && Number(value) >= 0)
    && Number(receipt.thinking_tokens) === 0);
}

function immediateScores(forecast, outcome = {}) {
  const normalized = normalizeForecast(forecast);
  const normalizeType = item => String(item || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const predicted = new Set(normalized.predicted_action_types.map(normalizeType).filter(Boolean));
  const actual = new Set((Array.isArray(outcome.action_types) ? outcome.action_types : [])
    .map(normalizeType).filter(Boolean));
  const overlap = [...predicted].filter(item => actual.has(item)).length;
  const precision = predicted.size ? overlap / predicted.size : 0;
  const recall = actual.size ? overlap / actual.size : 0;
  const actionF1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  const actualToolCalls = Number(outcome.tool_calls);
  if (!Number.isInteger(actualToolCalls) || actualToolCalls < 0) return null;
  const toolAccuracy = Math.max(0, 1 - Math.abs(normalized.expected_tool_calls - actualToolCalls) / 6);
  const clarificationActual = outcome.clarification === true ? 1 : 0;
  const clarificationAccuracy = 1 - (normalized.clarification_probability - clarificationActual) ** 2;
  return {
    action_type_f1: Number(actionF1.toFixed(6)), tool_call_accuracy: Number(toolAccuracy.toFixed(6)),
    behavioral_profile_application_quality: Number(((actionF1 + toolAccuracy) / 2).toFixed(6)),
    clarification_accuracy: Number(clarificationAccuracy.toFixed(6)),
  };
}

module.exports = {
  PROTOCOL_VERSION, SUBJECT_MODEL, MAX_TOKENS, REQUEST_CONFIG,
  canonicalJson, commitment, basePacket, packetForContext, systemPrompt, userPrompt,
  normalizeForecast, parseForecast, responseReceipt, validResponseReceipt,
  immediateScores,
};
