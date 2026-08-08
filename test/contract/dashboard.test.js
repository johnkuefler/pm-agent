const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');

test('dashboard has one page for every navigation tab and no duplicate ids', () => {
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map(match => match[1]);
  assert.equal(tabs.length, 13);
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
    '/assets/js/dashboard-activity.js',
    '/assets/js/dashboard-identity.js',
    '/assets/js/dashboard-meeting.js',
    '/assets/js/dashboard-tasks.js',
    '/assets/js/dashboard-memory.js',
    '/assets/js/dashboard-knowledge.js',
    '/assets/js/dashboard-portfolio.js',
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
  const coreJs = fs.readFileSync(path.join(root, 'public/js/dashboard-core.js'), 'utf8');
  const meetingJs = fs.readFileSync(path.join(root, 'public/js/dashboard-meeting.js'), 'utf8');
  const adminJs = fs.readFileSync(path.join(root, 'public/js/dashboard-admin.js'), 'utf8');
  assert.match(coreJs, /Dashboard request timed out/,
    'every dashboard request must inherit a finite browser deadline');
  assert.match(intelligenceJs, /playroomPoller = createCompletionAwarePoller/,
    'playroom polling must remain single-flight');
  assert.match(intelligenceJs, /readingRoomPoller = createCompletionAwarePoller/,
    'reading polling must remain single-flight');
  assert.match(meetingJs, /if \(meetingStatusRefreshInFlight\) return;/,
    'meeting status polling must remain single-flight');
  assert.match(meetingJs, /Promise\.all\(MEETING_FLAGS\.map/,
    'meeting controls should load concurrently instead of serially taxing the dashboard');
  assert.match(html, /id="gift-deliberation-list"/);
  assert.match(html, /id="portfolio-overview"/);
  assert.match(html, /id="pm-hydration-status"/);
  assert.match(html, /id="pm-control-posture"/);
  assert.match(html, /id="pm-control-decisions"/);
  assert.match(html, /id="pm-autopilot-summary"/);
  assert.match(html, /id="project-autopilot-panel"/);
  assert.match(html, /signed approval authorizes that exact gift/);
  assert.match(html, /Slack conversation with you and the recipient/);
  assert.match(html, /current itemized estimate/);
  assert.match(adminJs, /\/gifts\/deliberations\?limit=20/);
  assert.match(adminJs, /operatorApi\(`\/gifts\/intents/);
  assert.match(adminJs, /Approve and send/);
  assert.match(adminJs, /Approve the exact/);
  assert.match(adminJs, /allow_per_gift_overage: true/);
  assert.match(adminJs, /Estimated Goody total/);
  assert.match(adminJs, /type="button"/);
  assert.match(adminJs, /requestGiftDecision\(id, 'approve'/);
  assert.match(adminJs, /Gift approved, but not sent/);
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
  assert.match(intelligenceJs, /Why this focus won/);
  assert.match(intelligenceJs, /choice_changed_by_motivation/);
  assert.match(intelligenceJs, /curiosity_delta/);
  assert.match(intelligenceJs, /relational_delta/);
  assert.match(intelligenceJs, /evidence_delta/);
  assert.match(intelligenceJs, /revision_audit/);
  assert.match(intelligenceJs, /Server-bound/);
  assert.match(intelligenceJs, /consequence_delta/);
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
  assert.match(html, /id="memory-tier"/);
  assert.match(html, /id="memory-digest"/);
  assert.match(html, /id="new-fact-retention"/);
  assert.match(memoryJs, /api\('\/memory\?view=stats'\)/);
  assert.match(memoryJs, /api\('\/memory\?view=digest'\)/);
  assert.match(memoryJs, /el\.textContent = counts/,
    'memory digest content must be rendered as text');
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
  assert.equal(sections.length, 17);
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
  assert.match(intelligenceJs, /\/epistemic-agenda/);
  assert.match(html, /id="epistemic-agenda-state"/);
  assert.match(intelligenceJs, /held for revision/);
  assert.match(intelligenceJs, /held from work/);
  assert.match(intelligenceJs, /prompt_access\?\.eligible/);
  assert.match(intelligenceJs, /startReadingRoomPolling/);
  assert.match(intelligenceJs, /Provider-bound autonomous selection/);
  assert.match(intelligenceJs, /candidate.*frozen/);
  assert.match(intelligenceJs, /encountered/);
  assert.match(intelligenceJs, /60000/);
  assert.match(html, /id="reading-room-state"/);
  assert.match(html, /data-intelligence-jump="reading-room"/,
    'developmental reading should be directly discoverable from the workspace navigation');
  assert.match(intelligenceJs, /function openIntelligenceSection\(name\)/);
  assert.match(intelligenceJs, /loadIntelligenceSection\(name, token\)/,
    'an explicit section jump should load its bounded endpoint without waiting for viewport discovery');
  assert.match(intelligenceJs, /Details load when this section approaches the viewport/);
  assert.match(intelligenceJs, /consciousness-research\/ledger\?summary=1/);
  assert.match(intelligenceJs, /self-model\?allow_stale=1&view=dashboard/,
    'the progressive dashboard must use the compact worker snapshot rather than force a live audit');
  assert.match(intelligenceJs, /self-model\/claim-proposals/);
  assert.match(intelligenceJs, /Self-knowledge formation/);
  assert.match(intelligenceJs, /source-diverse evidence/);
  const initialLoader = intelligenceJs.slice(intelligenceJs.indexOf('async function loadIntelligence()'), intelligenceJs.indexOf('async function loadIntelligenceBench'));
  assert.doesNotMatch(initialLoader, /\/cognition|\/self-model|\/consciousness-research\/status|\/developmental-reading/);
  assert.match(brainJs, /noraBrainVisibilityObserver/);
  assert.match(brainJs, /time - noraBrainLastDraw >= 40/);
});

test('dashboard exposes one central live activity surface across every room', () => {
  const activityJs = fs.readFileSync(path.join(root, 'public/js/dashboard-activity.js'), 'utf8');
  const activityCss = fs.readFileSync(path.join(root, 'public/dashboard.css'), 'utf8');
  assert.match(html, /data-tab="live"/);
  assert.match(html, /id="global-activity-strip"/);
  assert.match(html, /id="page-live" class="page"/);
  assert.match(html, /id="live-current-list"/);
  assert.match(html, /id="live-history-list"/);
  assert.match(html, /id="live-cortex"/);
  assert.equal([...html.matchAll(/data-live-region="[^"]+"/g)].length, 7,
    'the live cortex should route activity into seven bounded functional regions');
  assert.match(html, /id="live-reading-snapshot"/);
  assert.match(html, /id="live-play-snapshot"/);
  assert.match(html, /<details class="section live-history-section">/,
    'the chronological audit should be secondary and collapsed by default');
  assert.match(activityJs, /new EventSource\('\/runtime-activity\/events'\)/);
  assert.match(activityJs, /fetchRuntimeActivitySnapshot/);
  assert.match(activityJs, /runtimeActivitySnapshotPromise/,
    'live snapshot fallbacks must coalesce concurrent reconnect and visibility requests');
  assert.match(activityJs, /createCompletionAwarePoller\(\{/,
    'live fallback polling must wait a full interval after each completed request');
  assert.doesNotMatch(activityJs, /setInterval\(/,
    'live reconnect fallback must not accumulate overlapping snapshot requests');
  assert.match(activityJs, /function runtimeActivityRegion\(item = \{\}\)/);
  assert.match(activityJs, /\/runtime-activity\/context/);
  assert.match(activityCss, /\.live-cortex\{[^}]*contain:layout paint/);
  assert.match(activityCss, /@media\(prefers-reduced-motion:no-preference\)/);
  assert.match(html, /message text, prompts, tool arguments, or tool results/i);
  assert.match(html, /not literal neural imaging or evidence of phenomenal consciousness/i);
  assert.doesNotThrow(() => new vm.Script(activityJs, { filename: 'dashboard-activity.js' }));
});

test('dashboard polling is completion-aware, cancelable, and visibility scoped', () => {
  const coreJs = fs.readFileSync(path.join(root, 'public/js/dashboard-core.js'), 'utf8');
  const meetingJs = fs.readFileSync(path.join(root, 'public/js/dashboard-meeting.js'), 'utf8');
  const intelligenceJs = fs.readFileSync(path.join(root, 'public/js/dashboard-intelligence.js'), 'utf8');
  assert.match(coreJs, /function createCompletionAwarePoller\(options\)/);
  assert.match(coreJs, /await options\.work\(controller\.signal\)/,
    'one poll must settle before the next interval is scheduled');
  assert.match(coreJs, /controller\?\.abort\(new DOMException\('Dashboard poll stopped'/,
    'stopping a view must cancel its active request');
  assert.doesNotMatch(meetingJs, /setInterval\(/);
  assert.match(meetingJs, /document\.visibilityState === 'visible'[\s\S]*?page-meeting/);
  assert.doesNotMatch(intelligenceJs, /setInterval\(/);
  assert.match(intelligenceJs, /readingRoomPoller = createCompletionAwarePoller/);
  assert.match(intelligenceJs, /playroomPoller = createCompletionAwarePoller/);
});

test('dashboard poll owner never overlaps work and aborts the active request on stop', async () => {
  const coreJs = fs.readFileSync(path.join(root, 'public/js/dashboard-core.js'), 'utf8');
  const helperSource = coreJs.slice(coreJs.indexOf('function createCompletionAwarePoller'),
    coreJs.indexOf('const pageMeta'));
  const context = { AbortController, DOMException, setTimeout, clearTimeout };
  vm.createContext(context);
  vm.runInContext(helperSource, context);
  let runs = 0;
  let active = 0;
  let maximumActive = 0;
  let release = null;
  let activeSignal = null;
  const poller = context.createCompletionAwarePoller({
    intervalMs: 250,
    initialDelayMs: 0,
    work: signal => new Promise((resolve, reject) => {
      runs += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      activeSignal = signal;
      release = () => { active -= 1; resolve(); };
      signal.addEventListener('abort', () => {
        active -= 1;
        reject(signal.reason);
      }, { once: true });
    }),
  });
  poller.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(runs, 1);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(runs, 1, 'a slow request must not be overlapped by an interval tick');
  release();
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.equal(runs, 2, 'the next interval begins only after the prior request settles');
  poller.stop();
  assert.equal(activeSignal.aborted, true);
  assert.equal(maximumActive, 1);
});

test('intelligence detail is divided into bounded human-readable views', () => {
  const intelligenceJs = fs.readFileSync(path.join(root, 'public/js/dashboard-intelligence.js'), 'utf8');
  const intelligenceCss = fs.readFileSync(path.join(root, 'public/dashboard.css'), 'utf8');
  const expectedViews = ['overview', 'learning', 'self', 'research', 'history'];
  const viewButtons = [...html.matchAll(/data-intelligence-view-button="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(viewButtons, expectedViews);
  assert.match(html, /id="page-intelligence" class="page" data-active-view="overview"/);
  assert.match(html, /id="intelligence-at-a-glance"/);
  assert.match(intelligenceJs, /function setIntelligenceView\(name, \{ load = true \} = \{\}\)/);
  assert.match(intelligenceJs, /intelligenceViews\[view\]\.sections\.forEach/,
    'switching rooms should load only the selected bounded group');
  assert.match(intelligenceCss, /#page-intelligence>\[data-intelligence-view\]\{display:none!important\}/);

  const sections = [...html.matchAll(/data-intelligence-view="([^"]+)" data-intelligence-section="([^"]+)"/g)]
    .map(([, view, section]) => ({ view, section }));
  assert.equal(sections.length, 17);
  assert.ok(sections.every(({ view }) => expectedViews.includes(view)));
  assert.equal(new Set(sections.map(({ section }) => section)).size, sections.length,
    'every detail section should belong to exactly one room');
});
