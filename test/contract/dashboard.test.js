const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');

test('dashboard has one page for every navigation tab and no duplicate ids', () => {
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map(match => match[1]);
  assert.equal(tabs.length, 12);
  assert.equal(new Set(tabs).size, tabs.length);
  for (const tab of tabs) assert.match(html, new RegExp(`id="page-${tab}"`));

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'element ids must remain unique');
});

test('dashboard presentation and behavior live in focused external assets', () => {
  assert.doesNotMatch(html, /<style>/);
  assert.doesNotMatch(html, /^\s*<script>\s*$/m);
  assert.match(html, /href="\/assets\/dashboard\.css\?v=\{\{ASSET_VERSION\}\}"/);

  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(scripts.map(source => source.replace(/\?v=.*$/, '')), [
    '/assets/js/dashboard-core.js',
    '/assets/js/dashboard-identity.js',
    '/assets/js/dashboard-meeting.js',
    '/assets/js/dashboard-tasks.js',
    '/assets/js/dashboard-memory.js',
    '/assets/js/dashboard-knowledge.js',
    '/assets/js/dashboard-admin.js',
    '/assets/js/dashboard-intelligence.js',
    '/assets/js/dashboard-init.js',
  ]);

  assert.ok(fs.statSync(path.join(root, 'public/dashboard.css')).size > 1000);
  for (const source of scripts) {
    const file = path.join(root, 'public', source.replace('/assets/', '').replace(/\?v=.*$/, ''));
    const code = fs.readFileSync(file, 'utf8');
    assert.ok(code.length > 100, `${source} should not be empty`);
    assert.doesNotThrow(() => new vm.Script(code, { filename: file }));
  }
  const intelligenceJs = fs.readFileSync(path.join(root, 'public/js/dashboard-intelligence.js'), 'utf8');
  assert.match(intelligenceJs, /authorship-boundary\/studies/);
  assert.match(intelligenceJs, /Only completed independently curated confirmatory studies enter the indicator/);
  assert.match(intelligenceJs, /matched self-prediction/);
  assert.match(intelligenceJs, /yoked-minus-self Brier/);
  assert.match(intelligenceJs, /shared-only gap/);
  assert.match(intelligenceJs, /strategic metacognitive-control/);
  assert.match(intelligenceJs, /self-minus-observer reward/);
  assert.match(intelligenceJs, /exact-answer observer/);
  assert.match(intelligenceJs, /adaptive value over/);
  assert.match(intelligenceJs, /static 95% CI/);
  assert.match(intelligenceJs, /blinded introspective access/);
  assert.match(intelligenceJs, /causal self-authored goal guidance/);
  assert.match(intelligenceJs, /Adaptive epistemic action/);
  assert.match(intelligenceJs, /answer-key commitments verified/);
  assert.match(intelligenceJs, /legacy uncommitted truth \(ineligible\)/);
  assert.match(intelligenceJs, /complete integrity chain verified/);
  assert.match(intelligenceJs, /integrity chain failed \(ineligible\)/);
  assert.match(intelligenceJs, /Episodic autobiographical prospection/);
  assert.match(intelligenceJs, /fact-equivalent/);
  assert.match(intelligenceJs, /Constructive future-self simulation/);
  assert.match(intelligenceJs, /remembered and imagined content source-separated/);
  assert.match(intelligenceJs, /Integrated operational self/);
  assert.match(intelligenceJs, /functional self-integration, not phenomenal unity/);
  assert.match(intelligenceJs, /Revealed-preference studies/);
  assert.match(intelligenceJs, /overall_invariance/);
  assert.match(intelligenceJs, /Between-invocation dynamics/);
  assert.match(intelligenceJs, /not continuous LLM inference/);
});

test('dashboard declares a real mobile viewport and responsive control patterns', () => {
  const css = fs.readFileSync(path.join(root, 'public/dashboard.css'), 'utf8');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(css, /font-size:16px!important/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.memory-item\{flex-direction:column/);
  assert.match(css, /\.nav\{grid-template-columns:minmax\(0,1fr\)/);
});

test('memory editor passes stable ids as strings and dashboard assets are deploy-versioned', () => {
  const memoryJs = fs.readFileSync(path.join(root, 'public/js/dashboard-memory.js'), 'utf8');
  assert.doesNotMatch(memoryJs, /saveMemoryEdit\(\$\{idx\}\)/);
  assert.match(memoryJs, /saveMemoryEdit\(this\.dataset\.memoryKey\)/);
  assert.match(html, /dashboard-core\.js\?v=\{\{ASSET_VERSION\}\}/);
  assert.match(html, /dashboard-memory\.js\?v=\{\{ASSET_VERSION\}\}/);
});
