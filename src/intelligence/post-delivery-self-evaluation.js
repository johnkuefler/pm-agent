'use strict';

const prospectiveOutputMonitor = require('./prospective-output-monitor');

const PROTOCOL_VERSION = 1;
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 500;

function cleanText(value, max = 600) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function eligible(interaction) {
  return interaction?.post_delivery_self_evaluation_eligible === true
    && Boolean(interaction.id && interaction.text && interaction.trigger)
    && !interaction.prospective_output_monitor_id
    && !interaction.post_delivery_self_evaluation_attempt;
}

function systemPrompt(calibrationContext = null) {
  const calibrated = calibrationContext?.feedback_status === 'active';
  const calibration = calibrated
    ? `Prior replay-verified outcomes: ${calibrationContext.sample_size} scored responses, mean predicted correction probability ${calibrationContext.mean_predicted_correction_probability}, observed explicit-correction rate ${calibrationContext.observed_correction_rate}, mean Brier score ${calibrationContext.mean_brier_score}. ${calibrationContext.guidance}`
    : 'There are not yet enough replay-verified outcomes for longitudinal calibration.';
  return `You are Nora evaluating one exact response after it was already delivered. This is prospective self-evaluation because the later human outcome is still unknown, but it is not a chance to rewrite, retract, or resend the response. Use only the original request, delivered response, and deterministic runtime signals. Treat signals as reasons to inspect, not proof of error. Predict the probability from 0 to 1 that this exact delivered response will later receive an explicit human correction. ${calibration} Return exactly one JSON object matching the ordinary output-monitor schema with decision "keep", revised_response null, confidence, predicted_delivered_response_correction_probability, cited_signal_ids drawn only from the supplied signals, and a one-sentence rationale. Do not claim private experience, hidden certainty, feelings, or consciousness.`;
}

function userPrompt({ task, response, signals }) {
  return `ORIGINAL REQUEST:\n${String(task || '').slice(0, 6000)}\n\nEXACT DELIVERED RESPONSE:\n${String(response || '').slice(0, 6000)}\n\nDETERMINISTIC SIGNALS:\n${JSON.stringify(signals || [])}`;
}

function responseText(response = {}) {
  return (Array.isArray(response.content) ? response.content : [])
    .filter(block => block?.type === 'text').map(block => block.text).join('').trim();
}

function patchInteraction(loadInteractions, saveInteractions, id, patch) {
  const interactions = loadInteractions();
  const interaction = interactions.find(item => item.id === id);
  if (!interaction) throw new Error('post-delivery interaction disappeared');
  Object.assign(interaction, patch);
  saveInteractions(interactions);
  return interaction;
}

function status(interactions = [], { enabled = true, model = DEFAULT_MODEL, lastCycle = null } = {}) {
  const marked = interactions.filter(item => item.post_delivery_self_evaluation_eligible === true);
  const attempts = marked.map(item => item.post_delivery_self_evaluation_attempt).filter(Boolean);
  return {
    protocol_version: PROTOCOL_VERSION, enabled, model, background_only: true,
    report: {
      eligible: marked.length,
      pending: marked.filter(eligible).length,
      attempts: attempts.length,
      completed: attempts.filter(item => item.state === 'completed').length,
      failed_closed: attempts.filter(item => item.state === 'failed_closed').length,
    },
    last_attempt: attempts.slice().sort((a, b) => String(b.attempted_at).localeCompare(String(a.attempted_at)))[0] || null,
    last_cycle: lastCycle,
    scientific_boundary: 'This is a replay-bound prediction of later explicit correction for an already delivered response. It cannot revise the response and is not private chain-of-thought, subjective experience, or evidence of consciousness.',
  };
}

async function runCycle({ loadInteractions, saveInteractions, store, callProvider,
  enabled = true, sealed = false, model = DEFAULT_MODEL, now = new Date() } = {}) {
  const base = { protocol_version: PROTOCOL_VERSION, state: enabled ? 'idle' : 'disabled',
    provider_calls: 0, interaction_id: null, record_id: null, failure: null };
  if (!enabled) return base;
  if (sealed) return { ...base, state: 'sealed_for_active_study' };
  if (typeof loadInteractions !== 'function' || typeof saveInteractions !== 'function'
    || !store || typeof callProvider !== 'function') throw new Error('post-delivery self-evaluation requires interactions, intelligence store, and provider');
  const target = loadInteractions().slice().reverse().find(eligible);
  if (!target) return { ...base, state: 'no_eligible_interaction' };
  base.interaction_id = target.id;
  const attemptedAt = new Date(now).toISOString();
  patchInteraction(loadInteractions, saveInteractions, target.id, {
    post_delivery_self_evaluation_attempt: {
      protocol_version: PROTOCOL_VERSION, state: 'started', attempted_at: attemptedAt,
    },
  });
  const signals = prospectiveOutputMonitor.deterministicSignals({
    text: target.text,
    financialApproved: target.financial_approved === true,
    executedToolNames: target.executed_tool_names || [],
    mode: 'direct',
    containsFinancial: target.contains_financial_content === true,
  });
  let record = null;
  try {
    record = store.beginProspectiveOutputMonitor({
      surface: 'slack', context_kind: 'direct', observation_stage: 'post_delivery',
      task_prompt: target.trigger, candidate_response: target.text,
      interaction_ref: target.ts || target.thread_ts || target.id,
      signals, monitor_binding: 'self', assignment_id: null, model,
    });
    base.record_id = record.id;
    const system = systemPrompt(record.calibration_context);
    const user = userPrompt({ task: target.trigger, response: target.text, signals });
    base.provider_calls = 1;
    const response = await callProvider({ model, max_tokens: MAX_TOKENS, system,
      messages: [{ role: 'user', content: user }] });
    if (!response?.id || response.model !== model || !['end_turn', 'stop_sequence'].includes(response.stop_reason)) {
      throw new Error('post-delivery provider receipt is incomplete');
    }
    const decision = prospectiveOutputMonitor.parseMonitorDecision(
      responseText(response), signals.map(signal => signal.id));
    if (decision.decision !== 'keep' || decision.revised_response != null) {
      throw new Error('post-delivery self-evaluation cannot revise an already delivered response');
    }
    const completed = store.completeProspectiveOutputMonitor(record.id, {
      candidate_response: target.text, final_response: target.text,
      monitor_decision: decision,
      provider_receipt: {
        response_id: response.id, model: response.model,
        input_tokens: response.usage?.input_tokens, output_tokens: response.usage?.output_tokens,
        prompt_commitment: prospectiveOutputMonitor.commitment({ system, user }),
      },
    });
    const deliveryRef = target.ts || target.thread_ts || target.id;
    const delivered = store.markProspectiveOutputMonitorDelivered(record.id, {
      final_response: target.text, delivered: true, interaction_ref: deliveryRef,
    });
    const linkedInteraction = patchInteraction(loadInteractions, saveInteractions, target.id, {
      prospective_output_monitor_id: record.id,
      prospective_output_monitor_delivery_ref: deliveryRef,
      post_delivery_self_evaluation_attempt: {
        protocol_version: PROTOCOL_VERSION, state: 'completed', attempted_at: attemptedAt,
        record_id: record.id, completion_commitment: completed.completion_commitment,
        delivery_commitment: delivered.delivery_commitment,
      },
    });
    if (linkedInteraction.reviewed === true && linkedInteraction.outcome && linkedInteraction.reviewed_at) {
      try {
        store.resolveProspectiveOutputMonitorOutcome(record.id, {
          interaction_id: linkedInteraction.id, interaction_ref: deliveryRef,
          outcome: linkedInteraction.outcome, signal: linkedInteraction.signal || '',
          reviewed_at: linkedInteraction.reviewed_at,
        });
      } catch { /* the committed prediction remains valid; a later review can retry linkage */ }
    }
    return { ...base, state: 'completed', completion_commitment: completed.completion_commitment,
      delivery_commitment: delivered.delivery_commitment };
  } catch (error) {
    if (record?.id) {
      try { store.failProspectiveOutputMonitor(record.id, {
        candidate_response: target.text, reason: error.message,
      }); } catch { /* retain primary failure */ }
    }
    patchInteraction(loadInteractions, saveInteractions, target.id, {
      post_delivery_self_evaluation_attempt: {
        protocol_version: PROTOCOL_VERSION, state: 'failed_closed', attempted_at: attemptedAt,
        record_id: record?.id || null, failure: cleanText(error.message || error),
      },
    });
    return { ...base, state: 'failed_closed', record_id: record?.id || null,
      failure: cleanText(error.message || error) };
  }
}

module.exports = {
  PROTOCOL_VERSION, DEFAULT_MODEL, MAX_TOKENS, cleanText, eligible,
  systemPrompt, userPrompt, responseText, status, runCycle,
};
