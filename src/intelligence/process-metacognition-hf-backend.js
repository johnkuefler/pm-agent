'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

function createBackend({ python = process.env.PROCESS_METACOGNITION_PYTHON || 'python',
  worker = path.resolve(__dirname, '../../scripts/process_metacognition_hf_worker.py'),
  config, startup_timeout_ms = 300000, request_timeout_ms = 180000 } = {}) {
  if (!config) throw new Error('Hugging Face backend requires a worker config path');
  const child = spawn(String(python), [path.resolve(worker), '--config', path.resolve(config)],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map(); let sequence = 0; let buffer = ''; let stderr = ''; let ready = false;
  const rejectAll = error => {
    for (const record of pending.values()) { clearTimeout(record.timeout); record.reject(error); }
    pending.clear();
  };
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-16000); });
  child.on('error', rejectAll);
  child.on('exit', code => rejectAll(new Error(`Hugging Face worker exited (${code}): ${stderr.trim() || 'no diagnostic'}`)));
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n'); if (newline === -1) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch (_) { rejectAll(new Error('Hugging Face worker emitted invalid JSON')); continue; }
      const record = pending.get(message.id);
      if (!record) continue;
      pending.delete(message.id); clearTimeout(record.timeout);
      if (message.ok) record.resolve(message.result); else record.reject(new Error(message.error || 'Hugging Face worker failed'));
    }
  });
  const call = (method, params, timeoutMs) => new Promise((resolve, reject) => {
    const id = `hf-${++sequence}`;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Hugging Face worker ${method} timed out`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timeout });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
      if (error) { clearTimeout(timeout); pending.delete(id); reject(error); }
    });
  });
  return call('health', {}, Number(startup_timeout_ms)).then(health => {
    if (!health?.ready) throw new Error('Hugging Face worker did not become ready');
    ready = true;
    return { health, execute: packet => {
      if (!ready) throw new Error('Hugging Face worker is not ready');
      return call('execute', { packet }, Number(request_timeout_ms));
    }, close: () => { ready = false; child.kill(); } };
  });
}

module.exports = { createBackend };
