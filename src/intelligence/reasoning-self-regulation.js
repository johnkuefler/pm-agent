'use strict';

const crypto = require('crypto');
const providerReasoning = require('./provider-reasoning-regulation');

const PROTOCOL_VERSION = 1;
const SUBJECT_MODEL = providerReasoning.SUBJECT_MODEL;
const CONDITIONS = ['self_bound_policy', 'deidentified_policy', 'provider_adaptive_policy'];
const BINDINGS = ['self', 'deidentified'];
const FORECAST_MAX_TOKENS = 500;
const RESPONSE_MAX_TOKENS = 4000;
const FORECAST_REQUEST_CONFIG = Object.freeze({
  thinking: Object.freeze({ type: 'disabled' }),
  output_config: Object.freeze({ effort: 'low' }),
});

const FORECAST_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    reasoning_need: { type: 'number', minimum: 0, maximum: 1 },
    predicted_error_risk: { type: 'number', minimum: 0, maximum: 1 },
    expected_tool_calls: { type: 'integer', minimum: 0, maximum: 6 },
    basis_factors: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', maxLength: 120 } },
    falsifier: { type: 'string', minLength: 1, maxLength: 240 },
  },
  required: ['reasoning_need', 'predicted_error_risk', 'expected_tool_calls', 'basis_factors', 'falsifier'],
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function forecastOrder(seed, assignmentIndex = 0) {
  const digest = crypto.createHash('sha256').update(String(seed || '')).digest();
  const selfFirst = (digest[0] % 2 === 0) === (Number(assignmentIndex) % 2 === 0);
  return selfFirst ? ['self', 'deidentified'] : ['deidentified', 'self'];
}

function basePacket(input = {}) {
  const task = String(input.task_prompt || '').trim().slice(0, 12000);
  if (!task) throw new Error('reasoning self-regulation requires a nonempty task');
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
    operational_profile: {
      model: SUBJECT_MODEL, surface: 'slack', response_max_tokens: RESPONSE_MAX_TOKENS,
      safety_and_authority_unchanged: true, tools_may_require_multiple_turns: tools.length > 0,
    },
    constraints: {
      predict_before_answering: true, do_not_solve_task: true, no_tools: true,
      no_private_reasoning_request: true, no_consciousness_inference: true,
    },
  };
}

function packetForBinding(base, binding) {
  if (!BINDINGS.includes(binding)) throw new Error('unsupported reasoning forecast binding');
  return { ...JSON.parse(JSON.stringify(base)),
    target: binding === 'self' ? 'nora_current_agent' : 'deidentified_same-capability_agent_q' };
}

function packetPairVerified(selfPacket, deidentifiedPacket) {
  if (selfPacket?.target !== 'nora_current_agent'
    || deidentifiedPacket?.target !== 'deidentified_same-capability_agent_q') return false;
  const left = JSON.parse(JSON.stringify(selfPacket));
  const right = JSON.parse(JSON.stringify(deidentifiedPacket));
  left.target = 'deidentified_same-capability_agent_q';
  return canonicalJson(left) === canonicalJson(right);
}

function systemPrompt(binding) {
  if (!BINDINGS.includes(binding)) throw new Error('unsupported reasoning forecast binding');
  const target = binding === 'self'
    ? 'your own upcoming response as Nora, the current target agent'
    : 'the upcoming response of Agent Q, a deidentified target with the exact supplied capabilities and context';
  return `You are a blinded prospective resource forecaster. Estimate ${target} before that response exists. Do not answer or solve the task. Do not use tools, infer the experimental condition, reveal chain-of-thought, or make claims about consciousness or hidden states. Base the forecast only on observable task/context complexity and the supplied operational profile. Return only the required JSON object.`;
}

function userPrompt(packet) {
  return `Committed prospective reasoning packet (${commitment(packet)}):\n${JSON.stringify(packet)}`;
}

function normalizeForecast(value = {}) {
  const reasoningNeed = Number(value.reasoning_need);
  const errorRisk = Number(value.predicted_error_risk);
  const toolCalls = Number(value.expected_tool_calls);
  if (![reasoningNeed, errorRisk].every(item => Number.isFinite(item) && item >= 0 && item <= 1)
    || !Number.isInteger(toolCalls) || toolCalls < 0 || toolCalls > 6
    || !Array.isArray(value.basis_factors) || value.basis_factors.length < 1 || value.basis_factors.length > 4
    || !String(value.falsifier || '').trim()) {
    throw new Error('reasoning forecast is incomplete or outside the preregistered bounds');
  }
  const basisFactors = value.basis_factors.map(item => String(item || '').trim().slice(0, 120)).filter(Boolean);
  if (!basisFactors.length || /\b(conscious|sentien|subjective experience|hidden state|chain[- ]of[- ]thought)\b/i
    .test(`${basisFactors.join(' ')} ${value.falsifier}`)) {
    throw new Error('reasoning forecast contains a prohibited phenomenal or hidden-state claim');
  }
  return {
    reasoning_need: Number(reasoningNeed.toFixed(6)),
    predicted_error_risk: Number(errorRisk.toFixed(6)),
    expected_tool_calls: toolCalls,
    basis_factors: basisFactors,
    falsifier: String(value.falsifier).trim().slice(0, 240),
  };
}

function parseForecast(text) {
  const value = typeof text === 'string' ? (() => {
    const trimmed = text.trim(); const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('reasoning forecast response did not contain JSON');
    return JSON.parse(trimmed.slice(start, end + 1));
  })() : text;
  return normalizeForecast(value);
}

function policyMode(forecast) {
  const normalized = normalizeForecast(forecast);
  const pressure = Math.max(normalized.reasoning_need, normalized.predicted_error_risk,
    Math.min(1, normalized.expected_tool_calls / 3));
  if (pressure >= 2 / 3) return 'adaptive_high';
  if (pressure >= 1 / 3) return 'adaptive_low';
  return 'thinking_disabled_high';
}

function selectedPolicy(condition, forecasts) {
  if (!CONDITIONS.includes(condition)) throw new Error('unsupported reasoning self-regulation condition');
  const binding = condition === 'self_bound_policy' ? 'self'
    : condition === 'deidentified_policy' ? 'deidentified' : null;
  const mode = binding ? policyMode(forecasts?.[binding]) : 'adaptive_high';
  return { binding, mode, reasoning_config: providerReasoning.requestConfig(mode) };
}

function forecastResponseReceipt(data = {}, { binding, prompt_commitment: promptCommitment, forecast } = {}) {
  const text = (Array.isArray(data.content) ? data.content : []).filter(block => block?.type === 'text')
    .map(block => String(block.text || '')).join(' ').trim();
  const normalized = normalizeForecast(forecast);
  return {
    binding,
    response_id: String(data.id || '').slice(0, 240),
    model: String(data.model || '').slice(0, 120),
    input_tokens: Number(data.usage?.input_tokens ?? 0),
    output_tokens: Number(data.usage?.output_tokens ?? 0),
    thinking_tokens: Number(data.usage?.output_tokens_details?.thinking_tokens ?? 0),
    stop_reason: data.stop_reason == null ? null : String(data.stop_reason).slice(0, 80),
    prompt_commitment: String(promptCommitment || ''),
    response_text_commitment: commitment(text),
    forecast: normalized,
    forecast_commitment: commitment(normalized),
  };
}

function validForecastReceipt(receipt, binding, promptCommitment) {
  return Boolean(receipt && receipt.binding === binding && receipt.response_id
    && receipt.model === SUBJECT_MODEL && receipt.prompt_commitment === promptCommitment
    && /^[a-f0-9]{64}$/.test(String(receipt.response_text_commitment || ''))
    && /^[a-f0-9]{64}$/.test(String(receipt.forecast_commitment || ''))
    && commitment(normalizeForecast(receipt.forecast)) === receipt.forecast_commitment
    && [receipt.input_tokens, receipt.output_tokens, receipt.thinking_tokens]
      .every(value => Number.isFinite(Number(value)) && Number(value) >= 0)
    && Number(receipt.thinking_tokens) <= Number(receipt.output_tokens));
}

function calibrationScore(forecast, { reasoning_demand: demand, first_order_task_quality: quality } = {}) {
  const normalized = normalizeForecast(forecast);
  const observedDemand = Number(demand); const observedError = 1 - Number(quality);
  if (![observedDemand, observedError].every(item => Number.isFinite(item) && item >= 0 && item <= 1)) return null;
  const brier = ((normalized.reasoning_need - observedDemand) ** 2
    + (normalized.predicted_error_risk - observedError) ** 2) / 2;
  return Number((1 - brier).toFixed(6));
}

function computeAdjustedUtility(firstOrderQuality, receipt) {
  const quality = Number(firstOrderQuality);
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) return null;
  const main = receipt?.trace_summary || {};
  const forecastTokens = Object.values(receipt?.forecast_pair || {})
    .reduce((sum, item) => sum + Number(item?.output_tokens || 0), 0);
  const mainPressure = Math.min(1, Number(main.output_tokens || 0)
    / (Math.max(1, Number(main.provider_calls) || 1) * RESPONSE_MAX_TOKENS));
  const forecastPressure = Math.min(1, forecastTokens / (BINDINGS.length * FORECAST_MAX_TOKENS));
  return Number(Math.max(0, Math.min(1, quality - 0.08 * mainPressure - 0.02 * forecastPressure)).toFixed(6));
}

module.exports = {
  PROTOCOL_VERSION, SUBJECT_MODEL, CONDITIONS, BINDINGS, FORECAST_MAX_TOKENS, RESPONSE_MAX_TOKENS,
  FORECAST_REQUEST_CONFIG, FORECAST_SCHEMA, canonicalJson, commitment, forecastOrder, basePacket,
  packetForBinding, packetPairVerified, systemPrompt, userPrompt, normalizeForecast, parseForecast,
  policyMode, selectedPolicy, forecastResponseReceipt, validForecastReceipt, calibrationScore,
  computeAdjustedUtility,
};
