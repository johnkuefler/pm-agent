'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { databaseSslPolicy, databaseConnectionString } = require('../../db');

test('public database connections verify TLS certificates by default', () => {
  const policy = databaseSslPolicy('postgres://user:pass@db.example.com:5432/nora', {});
  assert.deepEqual(policy, {
    ssl: { rejectUnauthorized: true },
    mode: 'tls_verified',
    reject_unauthorized: true,
    private_network: false,
  });
});

test('Railway private-network database connections do not pretend plaintext has TLS verification', () => {
  const policy = databaseSslPolicy(
    'postgres://user:pass@postgres.railway.internal:5432/railway', {});
  assert.equal(policy.ssl, false);
  assert.equal(policy.mode, 'private_network_plaintext');
  assert.equal(policy.private_network, true);
});

test('certificate authorities are supported and URL flags cannot override the resolved policy', () => {
  const source = 'postgres://user:pass@db.example.com/nora?sslmode=require&application_name=nora';
  const policy = databaseSslPolicy(source, {
    DB_SSL_CA_BASE64: Buffer.from('trusted-ca').toString('base64'),
  });
  assert.deepEqual(policy.ssl, { rejectUnauthorized: true, ca: 'trusted-ca' });
  const normalized = databaseConnectionString(source);
  assert.doesNotMatch(normalized, /sslmode/);
  assert.match(normalized, /application_name=nora/);
});

test('unverified TLS and disabled TLS require an explicit operator choice', () => {
  const url = 'postgres://user:pass@db.example.com/nora';
  const unverified = databaseSslPolicy(url, { DB_SSL_MODE: 'no-verify' });
  assert.equal(unverified.ssl.rejectUnauthorized, false);
  assert.equal(unverified.mode, 'tls_without_verification_explicitly');
  const disabled = databaseSslPolicy(url, { DB_SSL_MODE: 'disable' });
  assert.equal(disabled.ssl, false);
  assert.equal(disabled.mode, 'disabled_explicitly');
});
