'use strict';

const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Worker } = require('node:worker_threads');

class AsyncIntelligenceProjection {
  constructor({ workerPath = path.join(__dirname, 'intelligence-projection-worker.js') } = {}) {
    this.workerPath = workerPath;
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerPath);
    worker.unref();
    worker.on('message', message => {
      const job = this.pending.get(message.id);
      if (!job) return;
      this.pending.delete(message.id);
      if (!this.pending.size) worker.unref();
      if (message.error) job.reject(new Error(message.error));
      else job.resolve({ value: message.value, compute_ms: message.compute_ms,
        dispatch_ms: job.dispatchMs });
    });
    worker.on('error', error => this.failWorker(error));
    worker.on('exit', code => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (code !== 0) this.rejectPending(new Error(`intelligence projection worker exited with code ${code}`));
    });
    this.worker = worker;
    return worker;
  }

  rejectPending(error) {
    for (const job of this.pending.values()) job.reject(error);
    this.pending.clear();
  }

  failWorker(error) {
    const worker = this.worker;
    this.worker = null;
    this.rejectPending(error);
    worker?.terminate().catch(() => {});
  }

  run(state, method, args = {}) {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    worker.ref();
    return new Promise((resolve, reject) => {
      const job = { resolve, reject, dispatchMs: 0 };
      this.pending.set(id, job);
      const started = performance.now();
      try {
        worker.postMessage({ id, state, method, args });
        job.dispatchMs = performance.now() - started;
      } catch (error) {
        this.pending.delete(id);
        if (!this.pending.size) worker.unref();
        reject(error);
      }
    });
  }
}

module.exports = { AsyncIntelligenceProjection };
