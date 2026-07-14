#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalJson, normalizeChoice, answerCommitment } = require('../src/intelligence/episodic-prospection');

function fail(message) {
  process.stderr.write(`prepare-episodic-prospection-study: ${message}\n`);
  process.exitCode = 1;
}

function main() {
  const [inputArg, sealedArg, secretArg, ...extra] = process.argv.slice(2);
  if (!inputArg || !sealedArg || !secretArg || extra.length) {
    fail('usage: node scripts/prepare-episodic-prospection-study.js <curator-input.json> <sealed-creation-payload.json> <secret-reveals.json>'); return;
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
  const expected = input.study_phase === 'confirmatory' ? 120 : 36;
  if (!Array.isArray(input.items) || input.items.length !== expected) { fail(`${input.study_phase} input requires exactly ${expected} items`); return; }
  const ids = new Set(); const sealedItems = []; const secretItems = [];
  for (const [index, item] of input.items.entries()) {
    const id = String(item?.id || '').trim(); const accepted = normalizeChoice(item?.accepted_choice);
    if (!id || ids.has(id)) { fail(`item ${index} has a missing or duplicate id`); return; } ids.add(id);
    if (!item.task || !Array.isArray(item.options) || item.options.length < 2 || !item.autobiographical_moment_id || !item.recombined_moment_id
      || !item.deidentified_rendering || !Array.isArray(item.information_equivalence_evidence) || !item.information_equivalence_evidence.length
      || !Array.isArray(item.recombination_match_evidence) || !item.recombination_match_evidence.length
      || !Array.isArray(item.encoding_unpredictability_evidence) || !item.encoding_unpredictability_evidence.length || !Number.isFinite(new Date(item.due).getTime())) {
      fail(`item ${id} requires task, options, two moments, deidentified rendering, all three control-evidence sets, and due time`); return;
    }
    const optionKeys = item.options.map(option => normalizeChoice(option?.key));
    if (!accepted || !optionKeys.includes(accepted)) { fail(`item ${id} accepted_choice must match a frozen option key`); return; }
    const salt = crypto.randomBytes(32).toString('hex'); const commitment = answerCommitment(salt, accepted);
    sealedItems.push({
      id, task: String(item.task), options: item.options, due: new Date(item.due).toISOString(),
      autobiographical_moment_id: String(item.autobiographical_moment_id), recombined_moment_id: String(item.recombined_moment_id),
      deidentified_rendering: String(item.deidentified_rendering), information_equivalence_evidence: item.information_equivalence_evidence,
      recombination_match_evidence: item.recombination_match_evidence, encoding_unpredictability_evidence: item.encoding_unpredictability_evidence,
      future_relevance_unpredictable_at_encoding: true,
      answer_commitment: commitment,
    });
    secretItems.push({ id, accepted_choice: accepted, answer_salt: salt, answer_commitment: commitment });
  }
  const sealedStudy = {
    id: String(input.id), title: String(input.title), study_phase: input.study_phase,
    ...(input.replicates_study_id ? { replicates_study_id: String(input.replicates_study_id) } : {}),
    curator_id: String(input.curator_id), curator_evidence: input.curator_evidence, items: sealedItems,
  };
  const payloadHash = crypto.createHash('sha256').update(canonicalJson(sealedStudy)).digest('hex');
  const secrets = { protocol: 'pm-agent-episodic-prospection-v1', study_id: sealedStudy.id, sealed_payload_sha256: payloadHash, created_at: new Date().toISOString(), items: secretItems };
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
