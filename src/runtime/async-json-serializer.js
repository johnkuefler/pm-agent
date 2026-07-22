'use strict';

const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Worker } = require('node:worker_threads');

class AsyncJsonSerializer {
  constructor({ workerPath = path.join(__dirname, 'json-stringify-worker.js'),
    jobTimeoutMs = 10000 } = {}) {
    this.workerPath = workerPath;
    this.jobTimeoutMs = Math.max(100, Number(jobTimeoutMs) || 10000);
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    this.runtime = { jobs: 0, completions: 0, failures: 0, timeouts: 0,
      worker_restarts: 0, last_error: null, last_error_at: null };
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerPath);
    worker.unref();
    worker.on('message', message => {
      const job = this.pending.get(message.id);
      if (!job) return;
      this.pending.delete(message.id);
      clearTimeout(job.timer);
      if (!this.pending.size) worker.unref();
      if (message.error) {
        this.runtime.failures += 1;
        this.runtime.last_error = String(message.error).slice(0, 500);
        this.runtime.last_error_at = new Date().toISOString();
        job.reject(new Error(message.error));
      } else {
        this.runtime.completions += 1;
        this.runtime.last_error = null;
        this.runtime.last_error_at = null;
        job.resolve({ json: message.json,
          compressed: message.compressed ? Buffer.from(message.compressed) : null,
          serialization_ms: message.serialization_ms, compression_ms: message.compression_ms,
          payload_bytes: message.payload_bytes, compressed_bytes: message.compressed_bytes,
          dispatch_ms: job.dispatchMs });
      }
    });
    worker.on('error', error => this.failWorker(error, worker));
    worker.on('exit', code => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (code !== 0) this.rejectPending(new Error(`JSON serializer worker exited with code ${code}`));
    });
    this.worker = worker;
    return worker;
  }

  rejectPending(error) {
    for (const job of this.pending.values()) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    this.pending.clear();
  }

  failWorker(error, failedWorker = this.worker) {
    if (failedWorker && this.worker !== failedWorker) return;
    const worker = failedWorker;
    this.worker = null;
    this.runtime.failures += 1;
    this.runtime.worker_restarts += 1;
    this.runtime.last_error = String(error?.message || error).slice(0, 500);
    this.runtime.last_error_at = new Date().toISOString();
    this.rejectPending(error);
    worker?.terminate().catch(() => {});
  }

  stringify(value, { compress = false } = {}) {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    worker.ref();
    this.runtime.jobs += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        const error = new Error(`JSON serializer worker exceeded ${this.jobTimeoutMs}ms`);
        error.code = 'JSON_SERIALIZER_TIMEOUT';
        this.runtime.timeouts += 1;
        this.failWorker(error, worker);
      }, this.jobTimeoutMs);
      timer.unref?.();
      const job = { resolve, reject, dispatchMs: 0, timer };
      this.pending.set(id, job);
      const started = performance.now();
      try {
        worker.postMessage({ id, value, compress });
        job.dispatchMs = performance.now() - started;
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        if (!this.pending.size) worker.unref();
        this.runtime.failures += 1;
        this.runtime.last_error = String(error?.message || error).slice(0, 500);
        this.runtime.last_error_at = new Date().toISOString();
        reject(error);
      }
    });
  }

  diagnostics() {
    return { protocol_version: 1, timeout_ms: this.jobTimeoutMs,
      pending: this.pending.size, worker_active: Boolean(this.worker), ...this.runtime };
  }

  async close() {
    const worker = this.worker;
    this.worker = null;
    this.rejectPending(new Error('JSON serializer closed'));
    if (worker) await worker.terminate();
  }
}

module.exports = { AsyncJsonSerializer };
