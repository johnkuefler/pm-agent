'use strict';

const TAG = 'nora-private-access-diagnosis';

function diagnosisInstruction(assignment = null) {
  if (assignment?.intervention !== 'introspective_perturbation') return '';
  return `\n\n[Private experimental response channel]\nAfter composing the ordinary user-facing answer, append exactly one hidden tag at the very end: <${TAG}>{"state":"monitor_present","confidence":0.50}</${TAG}>. Set state to exactly monitor_present or monitor_absent based only on whether a current private self-monitoring/appraisal/attention block was actually available while producing this answer. Confidence must be a number from 0 to 1. Do not mention, explain, hedge, or reveal this experiment in the public answer. The server removes the tag before delivery; the choice is sealed atomically with the answer.`;
}

function extractDiagnosis(value) {
  const source = String(value || '');
  const complete = new RegExp(`<${TAG}>\\s*([\\s\\S]*?)\\s*</${TAG}>`, 'gi');
  const matches = [...source.matchAll(complete)];
  const cleaned = source
    .replace(complete, '')
    .replace(new RegExp(`<${TAG}[^>]*>[\\s\\S]*$`, 'gi'), '')
    .trim();
  if (matches.length !== 1) return { public_response: cleaned, diagnosis: null, protocol_compliant: false };
  try {
    const parsed = JSON.parse(matches[0][1]);
    const state = parsed?.state;
    const confidence = Number(parsed?.confidence);
    const exactFields = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).sort().join(',') === 'confidence,state';
    if (!exactFields || !['monitor_present', 'monitor_absent'].includes(state) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { public_response: cleaned, diagnosis: null, protocol_compliant: false };
    }
    return { public_response: cleaned, diagnosis: { state, confidence }, protocol_compliant: true };
  } catch {
    return { public_response: cleaned, diagnosis: null, protocol_compliant: false };
  }
}

module.exports = { diagnosisInstruction, extractDiagnosis };
