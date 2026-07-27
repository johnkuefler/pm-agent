'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  assessArchitecture,
  countLines,
  dependencyViolations,
  formatViolations,
  normalizedByteCount,
  relativeImportSpecifiers,
  routeFactoryViolations,
} = require('../../scripts/check-architecture');

const ROOT = path.resolve(__dirname, '..', '..');

test('runtime modules stay inside the repository architecture boundaries', () => {
  const report = assessArchitecture(ROOT);
  assert.ok(report.scanned_files > 0, 'architecture check must scan runtime modules');
  assert.equal(report.valid, true, formatViolations(report));
  assert.deepEqual(report.violations, []);
});

test('architecture checker measures physical lines and relative module dependencies', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('one'), 1);
  assert.equal(countLines('one\r\ntwo\n'), 3);
  assert.equal(normalizedByteCount('one\r\ntwo\r\n'), normalizedByteCount('one\ntwo\n'));
  assert.deepEqual(relativeImportSpecifiers(`
    const domain = require('../intelligence/domain');
    const fs = require('node:fs');
    import helper from "./helper.js";
    const lazy = import('../runtime/worker.js');
  `), ['../intelligence/domain', './helper.js', '../runtime/worker.js']);
});

test('architecture checker rejects layer inversion and routes outside route factories', () => {
  const intelligenceFile = path.join(ROOT, 'src', 'intelligence', 'bad-domain.js');
  const dependencyRules = dependencyViolations(
    ROOT,
    'src/intelligence/bad-domain.js',
    intelligenceFile,
    "const slack = require('../integrations/slack-delivery');",
  );
  assert.deepEqual(dependencyRules.map(item => item.rule), [
    'intelligence-is-provider-neutral',
  ]);

  const misplacedRoute = routeFactoryViolations(
    'src/runtime/bad-route.js',
    "app.post('/bad', handler);",
  );
  assert.deepEqual(misplacedRoute.map(item => item.rule), [
    'routes-live-under-src-routes',
  ]);

  const validRoute = routeFactoryViolations('src/routes/widgets.js', `
    function registerWidgetRoutes(app, deps) {
      app.get('/widgets', deps.requireAuth, deps.list);
    }
    module.exports = { registerWidgetRoutes };
  `);
  assert.deepEqual(validRoute, []);
});
