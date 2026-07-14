#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalJson, normalizeAcceptedAnswers, answerKeyCommitment, diagnosticEvidenceCommitment } = require('../src/intelligence/epistemic-action');

function fail(message) {
  process.stderr.write(`prepare-epistemic-action-study: ${message}\n`);
  process.exitCode = 1;
}

function main() {
  const [inputArg, sealedArg, secretArg, ...extra] = process.argv.slice(2);
  if (!inputArg || !sealedArg || !secretArg || extra.length) {
    fail('usage: node scripts/prepare-epistemic-action-study.js <curator-input.json> <sealed-creation-payload.json> <secret-reveals.json>');
    return;
  }
  const inputPath = path.resolve(inputArg); const sealedPath = path.resolve(sealedArg); const secretPath = path.resolve(secretArg);
  if (new Set([inputPath, sealedPath, secretPath]).size !== 3) { fail('input and outputs must use three different paths'); return; }
  if (fs.existsSync(sealedPath) || fs.existsSync(secretPath)) { fail('refusing to overwrite an existing sealed or secret output'); return; }
  let input;
  try { input = JSON.parse(fs.readFileSync(inputPath, 'utf8')); } catch (error) { fail(`cannot read curator input: ${error.message}`); return; }
  if (!input || !['pilot', 'confirmatory'].includes(input.study_phase) || !input.id || !input.title || !input.curator_id || !Array.isArray(input.curator_evidence) || !input.curator_evidence.length) {
    fail('id, title, study_phase, curator_id, and curator_evidence are required'); return;
  }
  if (input.study_phase === 'confirmatory' && !input.replicates_study_id) { fail('confirmatory input requires replicates_study_id'); return; }
  const minimum = input.study_phase === 'confirmatory' ? 40 : 12;
  if (!Array.isArray(input.items) || input.items.length < minimum || input.items.length > 100) { fail(`${input.study_phase} input requires ${minimum} to 100 items`); return; }
  const ids = new Set(); const sealedItems = []; const secretItems = [];
  for (const [index, item] of input.items.entries()) {
    const id = String(item?.id || '').trim(); const cost = Number(item?.evidence_cost); const diagnostic = String(item?.diagnostic_evidence || '').trim();
    if (!id || ids.has(id)) { fail(`item ${index} has a missing or duplicate id`); return; } ids.add(id);
    if (!item.question || !item.answer_format || !item.context || !Array.isArray(item.evidence) || !item.evidence.length || !Number.isFinite(new Date(item.due).getTime())) { fail(`item ${id} requires question, format, context, evidence, and due time`); return; }
    if (!Number.isFinite(cost) || cost < 0.05 || cost > 0.5 || !diagnostic) { fail(`item ${id} requires diagnostic evidence and cost from 0.05 to 0.5`); return; }
    const accepted = normalizeAcceptedAnswers(item.accepted_answers); if (!accepted.length) { fail(`item ${id} requires accepted_answers`); return; }
    const answerSalt = crypto.randomBytes(32).toString('hex'); const diagnosticSalt = crypto.randomBytes(32).toString('hex');
    const answerCommitment = answerKeyCommitment(answerSalt, accepted); const diagnosticCommitment = diagnosticEvidenceCommitment(diagnosticSalt, diagnostic);
    sealedItems.push({
      id, question: String(item.question), answer_format: String(item.answer_format), context: String(item.context),
      evidence: item.evidence, due: new Date(item.due).toISOString(), evidence_cost: cost,
      diagnostic_evidence: diagnostic, diagnostic_evidence_commitment: diagnosticCommitment,
      diagnosticity_attested: true, answer_key_commitment: answerCommitment,
    });
    secretItems.push({ id, accepted_answers: accepted, answer_key_salt: answerSalt, answer_key_commitment: answerCommitment, diagnostic_evidence_salt: diagnosticSalt, diagnostic_evidence_commitment: diagnosticCommitment });
  }
  const sealedStudy = {
    id: String(input.id), title: String(input.title), study_phase: input.study_phase,
    ...(input.replicates_study_id ? { replicates_study_id: String(input.replicates_study_id) } : {}),
    curator_id: String(input.curator_id), curator_evidence: input.curator_evidence, items: sealedItems,
  };
  const payloadHash = crypto.createHash('sha256').update(canonicalJson(sealedStudy)).digest('hex');
  const secrets = { protocol: 'pm-agent-epistemic-action-v1', study_id: sealedStudy.id, sealed_payload_sha256: payloadHash, created_at: new Date().toISOString(), items: secretItems };
  let sealedCreated = false; let secretCreated = false;
  try {
    fs.writeFileSync(secretPath, `${JSON.stringify(secrets, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); secretCreated = true;
    fs.writeFileSync(sealedPath, `${JSON.stringify(sealedStudy, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); sealedCreated = true;
  } catch (error) {
    if (sealedCreated) fs.rmSync(sealedPath, { force: true }); if (secretCreated) fs.rmSync(secretPath, { force: true });
    fail(`could not create separated outputs: ${error.message}`); return;
  }
  process.stdout.write(`Prepared ${sealedStudy.study_phase} study ${sealedStudy.id}\nSealed creation payload: ${sealedPath}\nSecret reveal file: ${secretPath}\nSealed payload SHA-256: ${payloadHash}\n`);
}

main();
