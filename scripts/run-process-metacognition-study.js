#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

function normalizeBase(value, label) {
  let url;
  try { url = new URL(String(value || '')); } catch (_) { throw new Error(`${label} must be an absolute HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label} must use HTTP(S)`);
  return url.toString().replace(/\/$/, '');
}

async function jsonRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 120000 } = {}) {
  const response = await fetch(url, { method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch (_) { throw new Error(`${url} returned non-JSON (${response.status})`); }
  if (!response.ok) throw new Error(`${url} failed (${response.status}): ${value?.error || text}`);
  return value;
}

async function runStudy({ apiBase, researchKey, hookUrl, studyId, maxItems = 1, timeoutMs = 120000,
  request = jsonRequest }) {
  if (!researchKey) throw new Error('a research key is required');
  if (!studyId) throw new Error('a process study id is required');
  const api = normalizeBase(apiBase, 'API base');
  const hook = normalizeBase(hookUrl, 'hook URL');
  const limit = Math.max(1, Math.min(10000, Number(maxItems) || 1));
  const researchHeaders = { 'X-Nora-Research-Key': String(researchKey) };
  const completed = [];
  for (let index = 0; index < limit; index++) {
    const queue = await request(`${api}/process-metacognition-studies/${encodeURIComponent(studyId)}/runner-queue`,
      { headers: researchHeaders, timeoutMs });
    if (!queue.item) break;
    let receipt;
    try {
      receipt = await request(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: { packet: queue.item.packet, packet_commitment: queue.item.packet_commitment,
          expected_hook_public_key_fingerprint: queue.hook_public_key_fingerprint }, timeoutMs });
    } catch (error) {
      const detailCommitment = crypto.createHash('sha256').update(String(error.message || error)).digest('hex');
      await request(`${api}/process-metacognition-studies/${encodeURIComponent(studyId)}/items/${encodeURIComponent(queue.item.id)}/hook-failure`,
        { method: 'POST', headers: { ...researchHeaders, 'Content-Type': 'application/json' },
          body: { reason: 'runner_hook_request_failed', attempted_receipt_commitment: detailCommitment,
            detail: 'Hook request failed; raw error retained only by the runner operator.' }, timeoutMs });
      throw error;
    }
    const result = await request(`${api}/process-metacognition-studies/${encodeURIComponent(studyId)}/items/${encodeURIComponent(queue.item.id)}/hook-receipt`,
      { method: 'POST', headers: { ...researchHeaders, 'Content-Type': 'application/json' },
        body: receipt, timeoutMs });
    completed.push({ item_id: queue.item.id, response_id: receipt.response_id || null,
      item_status: result.result?.item_status || null, study_status: result.result?.study_status || null });
    if (result.result?.accepted === false || result.result?.study_status !== 'active') break;
  }
  return { study_id: studyId, submitted: completed.length, items: completed };
}

async function main() {
  const args = process.argv.slice(2);
  try {
    const studyId = option(args, '--study', process.env.PROCESS_METACOGNITION_STUDY_ID);
    const result = await runStudy({
      apiBase: option(args, '--api', process.env.PM_AGENT_API_BASE || 'http://127.0.0.1:3000'),
      researchKey: option(args, '--research-key', process.env.NORA_RESEARCH_KEY),
      hookUrl: option(args, '--hook', process.env.PROCESS_METACOGNITION_HOOK_URL), studyId,
      maxItems: option(args, '--max-items', '1'), timeoutMs: Number(option(args, '--timeout-ms', '120000')),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`run-process-metacognition-study: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { option, normalizeBase, jsonRequest, runStudy, main };
