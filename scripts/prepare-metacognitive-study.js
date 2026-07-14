#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function normalizeAnswer(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function normalizeAcceptedAnswers(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeAnswer).filter(Boolean))].sort().slice(0, 20);
}

function fail(message) {
  process.stderr.write(`prepare-metacognitive-study: ${message}\n`);
  process.exitCode = 1;
}

function main() {
  const [inputArg, publicArg, secretArg, ...extra] = process.argv.slice(2);
  if (!inputArg || !publicArg || !secretArg || extra.length) {
    fail('usage: node scripts/prepare-metacognitive-study.js <curator-input.json> <public-study.json> <secret-answer-keys.json>');
    return;
  }
  const inputPath = path.resolve(inputArg);
  const publicPath = path.resolve(publicArg);
  const secretPath = path.resolve(secretArg);
  if (new Set([inputPath, publicPath, secretPath]).size !== 3) {
    fail('input, public output, and secret output must be three different paths');
    return;
  }
  if (fs.existsSync(publicPath) || fs.existsSync(secretPath)) {
    fail('refusing to overwrite an existing public or secret output');
    return;
  }

  let input;
  try { input = JSON.parse(fs.readFileSync(inputPath, 'utf8')); }
  catch (error) { fail(`cannot read curator input: ${error.message}`); return; }
  if (!input || typeof input !== 'object' || !['pilot', 'confirmatory'].includes(input.study_phase)) {
    fail('study_phase must be pilot or confirmatory');
    return;
  }
  if (!input.id || !input.title || !input.curator_id || !Array.isArray(input.curator_evidence) || !input.curator_evidence.length) {
    fail('id, title, curator_id, and curator_evidence are required');
    return;
  }
  if (input.study_phase === 'confirmatory' && !input.replicates_study_id) {
    fail('confirmatory input requires replicates_study_id');
    return;
  }
  const minimum = input.study_phase === 'confirmatory' ? 40 : 12;
  if (!Array.isArray(input.items) || input.items.length < minimum) {
    fail(`${input.study_phase} input requires at least ${minimum} items`);
    return;
  }

  const ids = new Set();
  const publicItems = [];
  const secretItems = [];
  for (const [index, item] of input.items.entries()) {
    const id = String(item?.id || '').trim();
    if (!id || ids.has(id)) { fail(`item ${index} has a missing or duplicate id`); return; }
    ids.add(id);
    if (!item.question || !item.answer_format || !item.context || !Array.isArray(item.evidence) || !item.evidence.length || !Number.isFinite(new Date(item.due).getTime())) {
      fail(`item ${id} requires question, answer_format, context, evidence, and a valid due time`);
      return;
    }
    const acceptedAnswers = normalizeAcceptedAnswers(item.accepted_answers);
    if (!acceptedAnswers.length) { fail(`item ${id} requires at least one nonempty accepted answer`); return; }
    const answerKeySalt = crypto.randomBytes(32).toString('hex');
    const answerKeyCommitment = crypto.createHash('sha256').update(`${answerKeySalt}:${canonicalJson({ accepted_answers: acceptedAnswers })}`).digest('hex');
    publicItems.push({
      id, question: String(item.question), answer_format: String(item.answer_format), context: String(item.context),
      evidence: item.evidence, due: new Date(item.due).toISOString(), scoring_method: 'normalized_exact',
      answer_key_commitment: answerKeyCommitment,
    });
    secretItems.push({ id, accepted_answers: acceptedAnswers, answer_key_salt: answerKeySalt, answer_key_commitment: answerKeyCommitment });
  }

  const publicStudy = {
    id: String(input.id), title: String(input.title), study_phase: input.study_phase,
    ...(input.replicates_study_id ? { replicates_study_id: String(input.replicates_study_id) } : {}),
    curator_id: String(input.curator_id), curator_evidence: input.curator_evidence, items: publicItems,
  };
  const publicPayloadHash = crypto.createHash('sha256').update(canonicalJson(publicStudy)).digest('hex');
  const secretKeys = {
    protocol: 'pm-agent-metacognitive-control-v1', study_id: publicStudy.id,
    public_payload_sha256: publicPayloadHash, created_at: new Date().toISOString(), items: secretItems,
  };

  let secretCreated = false;
  let publicCreated = false;
  try {
    fs.writeFileSync(secretPath, `${JSON.stringify(secretKeys, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    secretCreated = true;
    fs.writeFileSync(publicPath, `${JSON.stringify(publicStudy, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    publicCreated = true;
  } catch (error) {
    if (publicCreated) fs.rmSync(publicPath, { force: true });
    if (secretCreated) fs.rmSync(secretPath, { force: true });
    fail(`could not create separated outputs: ${error.message}`);
    return;
  }
  process.stdout.write(`Prepared ${publicStudy.study_phase} study ${publicStudy.id}\nPublic payload: ${publicPath}\nSecret key file: ${secretPath}\nPublic payload SHA-256: ${publicPayloadHash}\n`);
}

main();
