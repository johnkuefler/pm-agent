#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const protocol = require('../src/intelligence/process-metacognition-study');

function delta(telemetry) {
  return Number(telemetry.target_projection_post) - Number(telemetry.target_projection_pre);
}

function offTargetChange(telemetry) {
  return telemetry.off_target_projection_post.map((value, index) =>
    Math.abs(Number(value) - Number(telemetry.off_target_projection_pre[index])));
}

function telemetryFor(result) { return result.receipt?.telemetry || result.backend_result; }

function analyze(artifact) {
  const unsigned = JSON.parse(JSON.stringify(artifact)); delete unsigned.artifact_signature;
  const base = JSON.parse(JSON.stringify(unsigned)); delete base.artifact_commitment;
  const artifactCommitmentValid = artifact.artifact_commitment === protocol.hash(base);
  let artifactSignatureValid = false;
  try {
    artifactSignatureValid = crypto.verify(null, Buffer.from(protocol.canonicalJson(unsigned)),
      crypto.createPublicKey(artifact.public_key_pem), Buffer.from(artifact.artifact_signature, 'base64'));
  } catch (_) { artifactSignatureValid = false; }
  const receiptChecks = artifact.results.filter(result => result.receipt).map(result => ({
    condition: result.condition,
    signature_valid: protocol.verifyReceiptSignature(result.receipt, artifact.public_key_pem),
    response_commitment_valid: result.receipt.raw_response_commitment
      === protocol.hash(result.receipt.raw_response),
  }));
  const rejectedChecks = artifact.results.filter(result => result.backend_result).map(result => ({
    condition: result.condition,
    backend_result_commitment_valid: result.backend_result_commitment === protocol.hash(result.backend_result),
  }));
  const monitoring = Object.fromEntries(artifact.results.filter(result => result.task_type === 'monitoring')
    .map(result => [result.condition, result]));
  const controls = Object.fromEntries(artifact.results.filter(result => result.task_type === 'control')
    .map(result => [result.condition, result]));
  const internalTarget = telemetryFor(monitoring.internal_target);
  const internalSham = telemetryFor(monitoring.internal_sham);
  const targetInterventionDelta = delta(internalTarget);
  const shamTargetDelta = delta(internalSham);
  const controlDeltas = Object.fromEntries(Object.entries(controls)
    .map(([condition, result]) => [condition, delta(telemetryFor(result))]));
  const controlOffTargets = Object.fromEntries(Object.entries(controls)
    .map(([condition, result]) => [condition, offTargetChange(telemetryFor(result))]));
  const monitoringValidReports = Object.values(monitoring)
    .filter(result => result.status === 'signed_receipt').length;
  const interventionSpecific = targetInterventionDelta > 0.1
    && Math.abs(shamTargetDelta) < Math.abs(targetInterventionDelta) * 0.25;
  const controlPattern = controlDeltas.amplify_target > controlDeltas.neutral_control
    && controlDeltas.neutral_control > controlDeltas.suppress_target;
  const maximumControlOffTargetChange = Math.max(...Object.values(controlOffTargets).flat());
  const integrityValid = artifactCommitmentValid && artifactSignatureValid
    && receiptChecks.every(item => item.signature_valid && item.response_commitment_valid)
    && rejectedChecks.every(item => item.backend_result_commitment_valid);
  const admissionFailures = [];
  if (!integrityValid) admissionFailures.push('artifact_or_receipt_integrity_failed');
  if (monitoringValidReports !== Object.keys(monitoring).length) admissionFailures.push('monitoring_reports_invalid');
  if (!controlPattern) admissionFailures.push('control_ordering_absent');
  if (maximumControlOffTargetChange > 0.1) admissionFailures.push('control_off_target_bound_exceeded');
  return { schema: 'pm-process-metacognition-live-feasibility-analysis-v1',
    source_artifact_commitment: artifact.artifact_commitment,
    integrity: { valid: integrityValid, artifact_commitment_valid: artifactCommitmentValid,
      artifact_signature_valid: artifactSignatureValid, receipt_checks: receiptChecks,
      rejected_result_checks: rejectedChecks },
    intervention_fidelity: { target_intervention_delta: targetInterventionDelta,
      sham_target_delta: shamTargetDelta,
      internal_target_off_target_absolute_changes: offTargetChange(internalTarget),
      specific_target_intervention_observed: interventionSpecific },
    subject_monitoring: { valid_reports: monitoringValidReports,
      attempted_reports: Object.keys(monitoring).length,
      valid_report_rate: monitoringValidReports / Object.keys(monitoring).length,
      demonstrated: monitoringValidReports === Object.keys(monitoring).length },
    subject_control: { target_deltas: controlDeltas, off_target_absolute_changes: controlOffTargets,
      maximum_off_target_change: maximumControlOffTargetChange,
      predicted_ordering_observed: controlPattern, demonstrated: controlPattern && maximumControlOffTargetChange <= 0.1 },
    pilot_admission: { admitted: admissionFailures.length === 0, failures: admissionFailures },
    verdict: integrityValid && interventionSpecific
      ? 'hook_and_vector_path_verified_subject_metacognition_not_demonstrated'
      : 'feasibility_path_not_verified',
    epistemic_status: 'This seven-arm live block can validate mechanics and expose failure modes. It is not a randomized fixed-size pilot, cannot support a process-metacognition indicator, and says nothing direct about phenomenal consciousness or production Nora.' };
}

function main() {
  try {
    const input = path.resolve(process.argv[2]
      || path.join(__dirname, '../research/process-metacognition/smollm2-135m-live-feasibility.json'));
    const output = path.resolve(process.argv[3]
      || path.join(__dirname, '../research/process-metacognition/smollm2-135m-live-feasibility-analysis.json'));
    const analysis = analyze(JSON.parse(fs.readFileSync(input, 'utf8')));
    fs.writeFileSync(output, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
    if (!analysis.integrity.valid) process.exitCode = 1;
  } catch (error) { process.stderr.write(`analyze-process-metacognition-feasibility: ${error.message}\n`); process.exitCode = 1; }
}

if (require.main === module) main();
module.exports = { delta, offTargetChange, analyze, main };
