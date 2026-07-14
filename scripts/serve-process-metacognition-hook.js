#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createHookExecutor } = require('../src/intelligence/process-metacognition-hook-service');

const MAX_BODY_BYTES = 1024 * 1024;

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

function loadJson(filePath, label) {
  let value;
  try { value = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (error) {
    throw new Error(`${label} could not be read as JSON: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must contain one JSON object`);
  return value;
}

async function loadBackend(modulePath, backendConfig) {
  const loaded = require(modulePath);
  if (typeof loaded.createBackend === 'function') return loaded.createBackend(backendConfig || {});
  if (typeof loaded.execute === 'function') return loaded;
  throw new Error('backend module must export createBackend(config) or execute(packet)');
}

function readBody(request, maximum = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maximum) {
        reject(Object.assign(new Error('request body is too large'), { statusCode: 413 }));
        request.destroy(); return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (_) { reject(Object.assign(new Error('request body must be JSON'), { statusCode: 400 })); }
    });
    request.on('error', reject);
  });
}

function send(response, statusCode, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': encoded.length, 'Cache-Control': 'no-store' });
  response.end(encoded);
}

function createHookServer(executor, { logger = console } = {}) {
  if (!executor || typeof executor.execute !== 'function') throw new Error('a hook executor is required');
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') {
        send(response, 200, { ok: true, protocol: 'pm-process-metacognition-v5',
          hook_public_key_fingerprint: executor.public_key_fingerprint,
          runner_commitment: executor.config.runner_commitment,
          baseline_calibration_commitment: executor.config.baseline_calibration_commitment,
          subject_model_commitment: require('../src/intelligence/process-metacognition-study')
            .hash(executor.config.subject_model) });
        return;
      }
      if (request.method !== 'POST' || !['/', '/run'].includes(url.pathname)) {
        send(response, 404, { error: 'not_found' }); return;
      }
      if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        send(response, 415, { error: 'content_type_must_be_application_json' }); return;
      }
      send(response, 200, await executor.execute(await readBody(request)));
    } catch (error) {
      logger.error?.(`process-metacognition-hook: ${error.message}`);
      if (!response.headersSent) send(response, error.statusCode || 400, { error: 'hook_request_rejected' });
      else response.destroy();
    }
  });
}

async function buildExecutor(configPath) {
  const absoluteConfig = path.resolve(configPath);
  const directory = path.dirname(absoluteConfig);
  const config = loadJson(absoluteConfig, 'hook config');
  const resolveFromConfig = value => path.resolve(directory, String(value || ''));
  if (!config.signing_private_key_file || !config.backend_module) {
    throw new Error('hook config requires signing_private_key_file and backend_module');
  }
  const backendConfig = { ...(config.backend_config || {}) };
  for (const field of ['config', 'worker']) {
    if (backendConfig[field]) backendConfig[field] = resolveFromConfig(backendConfig[field]);
  }
  const backend = await loadBackend(resolveFromConfig(config.backend_module), backendConfig);
  return createHookExecutor({ private_key_pem: fs.readFileSync(resolveFromConfig(config.signing_private_key_file), 'utf8'),
    runner_commitment: config.runner_commitment,
    baseline_calibration_commitment: config.baseline_calibration_commitment,
    subject_model: config.subject_model, backend, study_id: config.study_id || null });
}

async function main() {
  const args = process.argv.slice(2);
  try {
    const configPath = option(args, '--config', process.env.PROCESS_METACOGNITION_HOOK_CONFIG);
    if (!configPath) throw new Error('--config or PROCESS_METACOGNITION_HOOK_CONFIG is required');
    const host = option(args, '--host', process.env.PROCESS_METACOGNITION_HOOK_HOST || '127.0.0.1');
    const port = Number(option(args, '--port', process.env.PROCESS_METACOGNITION_HOOK_PORT || '3417'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('hook port is invalid');
    const executor = await buildExecutor(configPath);
    const server = createHookServer(executor);
    server.listen(port, host, () => process.stdout.write(`process-metacognition-hook listening on http://${host}:${port}/run fingerprint=${executor.public_key_fingerprint}\n`));
  } catch (error) {
    process.stderr.write(`serve-process-metacognition-hook: ${error.message}\n`); process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { MAX_BODY_BYTES, option, loadJson, loadBackend, readBody, createHookServer, buildExecutor, main };
