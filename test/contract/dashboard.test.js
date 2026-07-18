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
    '/assets/js/dashboard-brain.js',
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
  assert.match(intelligenceJs, /Behavioral fingerprint/);
  assert.match(intelligenceJs, /same-model rolling baseline/);
  assert.match(intelligenceJs, /portability disabled/);
  assert.match(intelligenceJs, /Integrated operational self/);
  assert.match(intelligenceJs, /functional self-integration, not phenomenal unity/);
  assert.match(intelligenceJs, /Revealed-preference studies/);
  assert.match(intelligenceJs, /overall_invariance/);
  assert.match(intelligenceJs, /Between-invocation dynamics/);
  assert.match(intelligenceJs, /not continuous LLM inference/);
  assert.match(intelligenceJs, /verified cycle self-corrections across/);
  assert.match(intelligenceJs, /replay-verified completed-cycle self-corrections/);
  assert.match(intelligenceJs, /Library:/);
  assert.match(intelligenceJs, /observational only until randomized transfer testing/);
  assert.match(intelligenceJs, /books never directly rewrite the persona/);
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

test('intelligence view includes a maintainable live functional brain map', () => {
  const brainJs = fs.readFileSync(path.join(root, 'public/js/dashboard-brain.js'), 'utf8');
  assert.match(html, /id="brain-canvas"/);
  assert.match(html, /id="brain-node-list"/);
  assert.match(html, /Background processing/);
  assert.match(brainJs, /NORA_BRAIN_CAPABILITIES/);
  assert.match(brainJs, /replay-verified cycle self-corrections/);
  assert.match(brainJs, /self-chosen source-bound reading encounters/);
  assert.match(brainJs, /never directly rewrites the persona/);
  assert.match(brainJs, /prefers-reduced-motion/);
  assert.match(brainJs, /ResizeObserver/);
  assert.doesNotThrow(() => new vm.Script(brainJs, { filename: 'dashboard-brain.js' }));

  const context = {};
  vm.runInNewContext(`${brainJs}\n;globalThis.__brainCapabilities = NORA_BRAIN_CAPABILITIES;`, context);
  const capabilities = context.__brainCapabilities;
  const ids = capabilities.map(item => item.id);
  assert.ok(capabilities.length >= 12, 'the map should cover focused, integrative, applied, and background systems');
  assert.equal(new Set(ids).size, ids.length, 'capability ids must remain unique');
  for (const capability of capabilities) {
    assert.ok(['focused', 'integrative', 'applied', 'background'].includes(capability.layer));
    assert.ok(capability.links.every(target => ids.includes(target)), `${capability.id} links must target registered systems`);
    const reading = capability.read({});
    assert.ok(reading.level >= 0 && reading.level <= 1, `${capability.id} activity must be normalized`);
    assert.equal(typeof reading.evidence, 'string');
  }
});

test('intelligence dashboard paints a fast summary before progressively loading details', () => {
  const intelligenceJs = fs.readFileSync(path.join(root, 'public/js/dashboard-intelligence.js'), 'utf8');
  const brainJs = fs.readFileSync(path.join(root, 'public/js/dashboard-brain.js'), 'utf8');
  const sections = [...html.matchAll(/data-intelligence-section="([^"]+)"/g)].map(match => match[1]);
  assert.equal(sections.length, 16);
  assert.equal(new Set(sections).size, sections.length);
  const targetLiteral = intelligenceJs.match(/const intelligenceSectionTargets = (\{[\s\S]*?\n\});/);
  assert.ok(targetLiteral, 'progressive section registry should stay inspectable');
  const targetNames = Object.keys(vm.runInNewContext(`(${targetLiteral[1]})`));
  assert.deepEqual(targetNames.sort(), sections.sort(), 'every dashboard section should have one matching loader key');
  assert.match(intelligenceJs, /intelligence\/dashboard-summary/);
  assert.match(intelligenceJs, /SELECT exemplars:/);
  assert.match(intelligenceJs, /no foreground network call/);
  assert.match(intelligenceJs, /IntersectionObserver/);
  assert.match(intelligenceJs, /\/playroom/);
  assert.match(intelligenceJs, /startPlayroomPolling/);
  assert.match(html, /id="playroom-state"/);
  assert.match(intelligenceJs, /\/developmental-reading/);
  assert.match(intelligenceJs, /startReadingRoomPolling/);
  assert.match(intelligenceJs, /Provider-bound autonomous selection/);
  assert.match(intelligenceJs, /60000/);
  assert.match(html, /id="reading-room-state"/);
  assert.match(html, /data-intelligence-jump="reading-room"/,
    'developmental reading should be directly discoverable from the workspace navigation');
  assert.match(intelligenceJs, /function openIntelligenceSection\(name\)/);
  assert.match(intelligenceJs, /loadIntelligenceSection\(name, token\)/,
    'an explicit section jump should load its bounded endpoint without waiting for viewport discovery');
  assert.match(intelligenceJs, /Details load when this section approaches the viewport/);
  assert.match(intelligenceJs, /consciousness-research\/ledger\?summary=1/);
  assert.match(intelligenceJs, /self-model\?allow_stale=1/,
    'the progressive dashboard must use the worker snapshot rather than force a live audit');
  const initialLoader = intelligenceJs.slice(intelligenceJs.indexOf('async function loadIntelligence()'), intelligenceJs.indexOf('async function loadIntelligenceBench'));
  assert.doesNotMatch(initialLoader, /\/cognition|\/self-model|\/consciousness-research\/status|\/developmental-reading/);
  assert.match(brainJs, /noraBrainVisibilityObserver/);
  assert.match(brainJs, /time - noraBrainLastDraw >= 40/);
});
