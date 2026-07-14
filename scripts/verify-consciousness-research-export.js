#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const transparency = require('../src/intelligence/research-transparency');

function fail(message) {
  process.stderr.write(`verify-consciousness-research-export: ${message}\n`);
  process.exitCode = 1;
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

function readJson(filePath, label) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) { throw new Error(`cannot read ${label}: ${error.message}`); }
}

function writeNewJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function main() {
  const args = process.argv.slice(2);
  const bundleArg = args[0];
  if (!bundleArg || bundleArg.startsWith('--')) {
    fail('usage: node scripts/verify-consciousness-research-export.js <bundle.json> [--signing-key private.pem --receipt receipt.json --verifier-id id] [--verify-receipt receipt.json --public-key public.pem]');
    return;
  }
  try {
    const known = new Set(['--signing-key', '--receipt', '--verifier-id', '--verified-at', '--verify-receipt', '--public-key']);
    for (let index = 1; index < args.length; index += 2) {
      if (!known.has(args[index])) throw new Error(`unknown option: ${args[index]}`);
      if (!args[index + 1]) throw new Error(`${args[index]} requires a value`);
    }
    const bundlePath = path.resolve(bundleArg); const bundle = readJson(bundlePath, 'bundle');
    const audit = transparency.verifyBundle(bundle);
    const signingKeyArg = option(args, '--signing-key');
    const receiptOutputArg = option(args, '--receipt');
    const verifierId = option(args, '--verifier-id');
    const receiptInputArg = option(args, '--verify-receipt');
    const publicKeyArg = option(args, '--public-key');
    if (!audit.complete_chain_verified) {
      process.stdout.write(`${JSON.stringify({ bundle: audit }, null, 2)}\n`);
      process.exitCode = 1; return;
    }
    if (signingKeyArg || receiptOutputArg || verifierId) {
      if (!signingKeyArg || !receiptOutputArg || !verifierId || receiptInputArg || publicKeyArg) {
        throw new Error('witness creation requires --signing-key, --receipt, and --verifier-id only');
      }
      const privateKey = fs.readFileSync(path.resolve(signingKeyArg), 'utf8');
      const receipt = transparency.createWitnessReceipt(bundle, privateKey,
        { verifier_id: verifierId, verified_at: option(args, '--verified-at') || new Date() });
      const receiptPath = path.resolve(receiptOutputArg); writeNewJson(receiptPath, receipt);
      process.stdout.write(`${JSON.stringify({ bundle: audit, witness_receipt: {
        path: receiptPath, public_key_sha256: receipt.payload.public_key_sha256,
        bundle_commitment: receipt.payload.bundle_commitment } }, null, 2)}\n`);
      return;
    }
    if (receiptInputArg || publicKeyArg) {
      if (!receiptInputArg || !publicKeyArg) throw new Error('witness verification requires --verify-receipt and --public-key');
      const receipt = readJson(path.resolve(receiptInputArg), 'witness receipt');
      const publicKey = fs.readFileSync(path.resolve(publicKeyArg), 'utf8');
      const witness = transparency.verifyWitnessReceipt(bundle, receipt, publicKey);
      process.stdout.write(`${JSON.stringify({ bundle: audit, witness }, null, 2)}\n`);
      if (!witness.complete_chain_verified) process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({ bundle: audit }, null, 2)}\n`);
  } catch (error) { fail(error.message); }
}

if (require.main === module) main();

module.exports = { main };
