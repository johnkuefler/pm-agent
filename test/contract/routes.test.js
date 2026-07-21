const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.NORA_TEST_MODE = '1';
process.env.DATABASE_URL = '';
process.env.NORA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-routes-'));

const { app } = require('../../server');

test.after(() => fs.rmSync(process.env.NORA_DATA_DIR, { recursive: true, force: true }));

test('the complete HTTP route surface remains registered in the same order', () => {
  const router = app.router || app._router;
  const actual = router.stack
    .filter(layer => layer.route)
    .flatMap(layer => Object.keys(layer.route.methods).map(method => `${method.toUpperCase()} ${layer.route.path}`));
  const expected = fs.readFileSync(path.join(__dirname, '../fixtures/routes.txt'), 'utf8').trim().split(/\r?\n/);
  assert.equal(expected.length, 433, 'route fixture should cover the complete known API surface');
  assert.deepEqual(actual, expected);
});
