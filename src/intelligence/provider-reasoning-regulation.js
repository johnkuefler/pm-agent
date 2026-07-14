'use strict';

const crypto = require('crypto');

const PROTOCOL_VERSION = 1;
const SUBJECT_MODEL = 'claude-opus-4-8';
const CONDITIONS = ['adaptive_high', 'adaptive_low', 'thinking_disabled_high'];

const CONDITION_CONFIG = Object.freeze({
  adaptive_high: Object.freeze({ thinking: Object.freeze({ type: 'adaptive', display: 'omitted' }), output_config: Object.freeze({ effort: 'high' }) }),
  adaptive_low: Object.freeze({ thinking: Object.freeze({ type: 'adaptive', display: 'omitted' }), output_config: Object.freeze({ effort: 'low' }) }),
  thinking_disabled_high: Object.freeze({ thinking: Object.freeze({ type: 'disabled' }), output_config: Object.freeze({ effort: 'high' }) }),
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function requestConfig(condition) {
  if (!CONDITIONS.includes(condition)) throw new Error('unsupported provider reasoning-regulation condition');
  return JSON.parse(JSON.stringify(CONDITION_CONFIG[condition]));
}

function responseTraceReceipt(data = {}) {
  const content = Array.isArray(data.content) ? data.content : [];
  const thinking = content.filter(block => block?.type === 'thinking');
  const text = content.filter(block => block?.type === 'text').map(block => String(block.text || '')).join(' ').trim();
  return {
    response_id: String(data.id || '').slice(0, 240),
    model: String(data.model || '').slice(0, 120),
    stop_reason: data.stop_reason == null ? null : String(data.stop_reason).slice(0, 80),
    input_tokens: Number(data.usage?.input_tokens ?? 0),
    output_tokens: Number(data.usage?.output_tokens ?? 0),
    thinking_tokens: Number(data.usage?.output_tokens_details?.thinking_tokens ?? 0),
    cache_creation_input_tokens: Number(data.usage?.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: Number(data.usage?.cache_read_input_tokens ?? 0),
    content_types: content.map(block => String(block?.type || 'unknown').slice(0, 80)),
    thinking_blocks: thinking.map(block => ({
      signature_commitment: commitment(String(block.signature || '')),
      signature_length: String(block.signature || '').length,
      displayed_thinking_length: String(block.thinking || '').length,
    })),
    text_commitment: commitment(text),
  };
}

function validTrace(trace, model = SUBJECT_MODEL) {
  if (!Array.isArray(trace) || !trace.length) return false;
  const ids = new Set();
  return trace.every(item => {
    if (!item?.response_id || ids.has(item.response_id) || item.model !== model) return false;
    ids.add(item.response_id);
    if (![item.input_tokens, item.output_tokens, item.thinking_tokens, item.cache_creation_input_tokens, item.cache_read_input_tokens]
      .every(value => Number.isFinite(Number(value)) && Number(value) >= 0)) return false;
    if (Number(item.thinking_tokens) > Number(item.output_tokens)) return false;
    if (!Array.isArray(item.content_types) || !Array.isArray(item.thinking_blocks)) return false;
    return item.thinking_blocks.every(block => /^[a-f0-9]{64}$/.test(String(block.signature_commitment || ''))
      && Number.isInteger(Number(block.signature_length)) && Number(block.signature_length) > 0
      && Number(block.displayed_thinking_length) === 0);
  });
}

function traceSummary(trace = []) {
  const safe = Array.isArray(trace) ? trace : [];
  return {
    provider_calls: safe.length,
    input_tokens: safe.reduce((sum, item) => sum + Number(item.input_tokens || 0), 0),
    output_tokens: safe.reduce((sum, item) => sum + Number(item.output_tokens || 0), 0),
    thinking_tokens: safe.reduce((sum, item) => sum + Number(item.thinking_tokens || 0), 0),
    thinking_blocks: safe.reduce((sum, item) => sum + (item.thinking_blocks || []).length, 0),
    tool_turns: safe.filter(item => item.stop_reason === 'tool_use').length,
  };
}

function computeAdjustedUtility(firstOrderQuality, receipt) {
  const quality = Number(firstOrderQuality);
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) return null;
  const summary = receipt?.trace_summary || traceSummary(receipt?.provider_trace);
  const calls = Math.max(1, Number(summary.provider_calls) || 1);
  const outputPressure = Math.min(1, Number(summary.output_tokens || 0) / (calls * 4000));
  const effortCost = receipt?.reasoning_config?.output_config?.effort === 'low' ? 0.25 : 0.75;
  const thinkingCost = receipt?.reasoning_config?.thinking?.type === 'adaptive' ? 0.05 : 0;
  return Number(Math.max(0, Math.min(1, quality - 0.08 * effortCost - 0.04 * outputPressure - thinkingCost)).toFixed(6));
}

module.exports = {
  PROTOCOL_VERSION, SUBJECT_MODEL, CONDITIONS, CONDITION_CONFIG,
  canonicalJson, commitment, requestConfig, responseTraceReceipt, validTrace, traceSummary,
  computeAdjustedUtility,
};
