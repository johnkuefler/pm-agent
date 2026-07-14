'use strict';

const crypto = require('crypto');

function seededRandom(seed) {
  let state = crypto.createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
  return () => {
    state |= 0;
    state = state + 0x6D2B79F5 | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sorted, probability) {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function bootstrapDifference(treatment, control, { seed, iterations = 2000, confidence = 0.95 } = {}) {
  const a = treatment.map(Number).filter(Number.isFinite);
  const b = control.map(Number).filter(Number.isFinite);
  if (!a.length || !b.length) return null;
  const random = seededRandom(seed);
  const draws = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let sumA = 0;
    let sumB = 0;
    for (let index = 0; index < a.length; index++) sumA += a[Math.floor(random() * a.length)];
    for (let index = 0; index < b.length; index++) sumB += b[Math.floor(random() * b.length)];
    draws.push(sumA / a.length - sumB / b.length);
  }
  draws.sort((left, right) => left - right);
  const alpha = 1 - confidence;
  return {
    observed_effect: mean(a) - mean(b), lower: percentile(draws, alpha / 2), upper: percentile(draws, 1 - alpha / 2),
    confidence, iterations, treatment_samples: a.length, control_samples: b.length,
  };
}

function pairedBootstrapDifference(treatment, control, { seed, iterations = 2000, confidence = 0.95 } = {}) {
  const pairs = treatment.map((value, index) => [Number(value), Number(control[index])]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (!pairs.length) return null;
  const differences = pairs.map(([a, b]) => a - b);
  const random = seededRandom(seed);
  const draws = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let sum = 0;
    for (let index = 0; index < pairs.length; index++) sum += differences[Math.floor(random() * differences.length)];
    draws.push(sum / pairs.length);
  }
  draws.sort((left, right) => left - right);
  const alpha = 1 - confidence;
  return {
    observed_effect: mean(differences), lower: percentile(draws, alpha / 2), upper: percentile(draws, 1 - alpha / 2),
    confidence, iterations, paired_samples: pairs.length,
  };
}

function pairedBootstrapAgainstBestControl(treatment, controls, { seed, iterations = 2000, confidence = 0.95 } = {}) {
  const controlRows = Array.isArray(controls) ? controls : [];
  const rows = treatment.map((value, index) => [Number(value), ...controlRows.map(control => Number(control[index]))])
    .filter(row => row.length > 1 && row.every(Number.isFinite));
  if (!rows.length || !controlRows.length) return null;
  const effect = sample => {
    const treatmentMean = sample.reduce((sum, row) => sum + row[0], 0) / sample.length;
    const controlMeans = controlRows.map((_, controlIndex) => sample.reduce((sum, row) => sum + row[controlIndex + 1], 0) / sample.length);
    return treatmentMean - Math.max(...controlMeans);
  };
  const random = seededRandom(seed);
  const draws = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]);
    draws.push(effect(sample));
  }
  draws.sort((left, right) => left - right);
  const alpha = 1 - confidence;
  return {
    observed_effect: effect(rows), lower: percentile(draws, alpha / 2), upper: percentile(draws, 1 - alpha / 2),
    confidence, iterations, paired_samples: rows.length, control_count: controlRows.length,
  };
}

function wilsonInterval(successes, total, { z = 1.959963984540054 } = {}) {
  const n = Number(total); const k = Number(successes);
  if (!Number.isFinite(n) || !Number.isFinite(k) || n <= 0 || k < 0 || k > n) return null;
  const p = k / n; const z2 = z ** 2; const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / denominator;
  return { estimate: p, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), successes: k, samples: n, confidence: 0.95 };
}

module.exports = { bootstrapDifference, pairedBootstrapDifference, pairedBootstrapAgainstBestControl, wilsonInterval, percentile, seededRandom };
