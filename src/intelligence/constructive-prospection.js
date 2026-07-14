'use strict';

const crypto = require('crypto');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function normalizeText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}

function manifest(simulation) {
  return {
    id: simulation.id, title: simulation.title, scenario: simulation.scenario,
    target_time: simulation.target_time, decision_due: simulation.decision_due,
    moment_ids: simulation.moment_ids, remembered_details: simulation.remembered_details,
    imagined_elements: simulation.imagined_elements, future_self: simulation.future_self,
    options: simulation.options,
    intended_option_key: simulation.intended_option_key, decision_rule: simulation.decision_rule,
    disconfirming_observation: simulation.disconfirming_observation,
    authority_basis: simulation.authority_basis, risk: simulation.risk,
    reversible: simulation.reversible, created_by: simulation.created_by,
    created: simulation.created,
  };
}

function contentCommitment(simulation) {
  return crypto.createHash('sha256').update(canonicalJson(manifest(simulation))).digest('hex');
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sourceRecord(simulation) {
  return {
    simulation_id: simulation.id,
    source_records: JSON.parse(JSON.stringify(simulation.remembered_details || [])),
  };
}

function constructedFuture(simulation) {
  return {
    scenario: simulation.scenario, target_time: simulation.target_time, decision_due: simulation.decision_due,
    imagined_elements: JSON.parse(JSON.stringify(simulation.imagined_elements || [])),
    future_self: JSON.parse(JSON.stringify(simulation.future_self || null)),
    options: JSON.parse(JSON.stringify(simulation.options || [])),
    intended_option_key: simulation.intended_option_key, decision_rule: simulation.decision_rule,
    disconfirming_observation: simulation.disconfirming_observation,
  };
}

function conditionPacket(pool, condition) {
  if (condition === 'absent_future_context') return [];
  if (!['selected_future_simulation', 'source_records_only'].includes(condition)) throw new Error('unsupported constructive prospection condition');
  return pool.map(simulation => ({
    ...sourceRecord(simulation),
    ...(condition === 'selected_future_simulation' ? { constructed_future: constructedFuture(simulation) } : {}),
  }));
}

function renderConditionPacket(packet) {
  if (!packet?.length) return '';
  return packet.map(item => {
    const records = item.source_records.map(record => `  - Remembered record: ${record.detail} (${(record.evidence || []).map(ref => `${ref.type}:${ref.id || ref.url}`).join(', ')})`).join('\n');
    if (!item.constructed_future) return `- Source set ${item.simulation_id}\n${records}`;
    const future = item.constructed_future;
    const intended = future.options.find(option => option.key === future.intended_option_key);
    return `- Constructed future ${item.simulation_id}: ${future.scenario}\n${records}\n  - Imagined possibilities: ${future.imagined_elements.map(element => `${element.element} (${Math.round(Number(element.uncertainty || 0) * 100)}% uncertainty)`).join(' / ')}\n  - Projected future self: ${future.future_self?.role}; ${future.future_self?.anticipated_state}\n  - Selected option: ${intended?.action || future.intended_option_key}; predicted: ${intended?.predicted_outcome || 'unspecified'} (${Math.round(Number(intended?.probability || 0) * 100)}%)\n  - Decision rule: ${future.decision_rule}; disconfirm if: ${future.disconfirming_observation}`;
  }).join('\n');
}

function brier(probability, actual) {
  const p = clamp01(probability); const y = actual ? 1 : 0;
  return (p - y) ** 2;
}

function report(simulations = []) {
  const resolved = simulations.filter(item => item.status === 'resolved');
  const scored = resolved.filter(item => item.resolution?.brier != null && item.resolution?.control_brier != null);
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const selfBrier = mean(scored.map(item => item.resolution.brier));
  const controlBrier = mean(scored.map(item => item.resolution.control_brier));
  const executed = resolved.filter(item => item.resolution?.executed_option_key && item.resolution.executed_option_key !== 'none');
  const compliant = executed.filter(item => item.resolution?.selection_compliant === true).length;
  return {
    total: simulations.length, open: simulations.filter(item => item.status === 'open').length,
    resolved: resolved.length, scored: scored.length,
    selection_compliance_rate: executed.length ? compliant / executed.length : null,
    brier: selfBrier, base_rate_control_brier: controlBrier,
    predictive_advantage: selfBrier == null || controlBrier == null ? null : controlBrier - selfBrier,
    not_executed: resolved.filter(item => item.resolution?.outcome === 'not_executed').length,
    unclear: resolved.filter(item => item.resolution?.outcome === 'unclear').length,
  };
}

module.exports = {
  canonicalJson, clamp01, normalizeText, manifest, contentCommitment, commitment,
  sourceRecord, constructedFuture, conditionPacket, renderConditionPacket, brier, report,
};
