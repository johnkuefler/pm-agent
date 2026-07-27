const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const readDashboardScript = name => fs.readFileSync(path.join(root, 'public/js', name), 'utf8');
const taskSource = readDashboardScript('dashboard-tasks.js');
const meetingSource = readDashboardScript('dashboard-meeting.js');
const knowledgeSource = readDashboardScript('dashboard-knowledge.js');
const adminSource = readDashboardScript('dashboard-admin.js');
const initSource = readDashboardScript('dashboard-init.js');

const payload = `double" apostrophe' <img src=x onerror="evil()"> onclick='evil()'`;
const plain = value => JSON.parse(JSON.stringify(value));

function escapeText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function makeButton(dataset = {}) {
  const listeners = {};
  return {
    dataset,
    addEventListener(type, listener) { listeners[type] = listener; },
    click() {
      assert.equal(typeof listeners.click, 'function', 'expected a click listener');
      return listeners.click({ preventDefault() {}, stopPropagation() {} });
    },
  };
}

test('dashboard renderers do not serialize dynamic values into inline handlers', () => {
  for (const [name, source] of Object.entries({
    'dashboard-tasks.js': taskSource,
    'dashboard-meeting.js': meetingSource,
    'dashboard-knowledge.js': knowledgeSource,
    'dashboard-admin.js': adminSource,
  })) {
    assert.doesNotMatch(source, /\sonclick\s*=/i, `${name} should bind handlers from JavaScript`);
  }

  assert.doesNotMatch(taskSource, /value="\$\{escHtml\(/);
  assert.doesNotMatch(knowledgeSource, /editUtterance\(\$\{i\},/);
  assert.doesNotMatch(knowledgeSource, /viewProject\('\$\{/);
  assert.doesNotMatch(adminSource, /href="\$\{escHtml\(/);
  assert.match(adminSource, /href="\$\{safeUrlAttr\(item\.goody_gift_link\)\}"/);
  assert.doesNotMatch(meetingSource, /sel\.innerHTML\s*=/);

  const projectLoader = knowledgeSource.slice(
    knowledgeSource.indexOf('async function loadProjects()'),
    knowledgeSource.indexOf('async function viewProject'),
  );
  assert.doesNotMatch(projectLoader, /\btranscripts\b/, 'project loading must not reference transcript state');
});

test('task edit payloads stay in input properties instead of editor markup', () => {
  const controls = new Map();
  for (const field of ['action', 'detail', 'assignee', 'due', 'scheduled', 'recurrence']) {
    controls.set(`[data-task-field="${field}"]`, {
      value: '',
      addEventListener() {},
      focus() {},
    });
  }
  controls.set('.task-save-btn', makeButton());
  controls.set('.task-cancel-btn', makeButton());
  const row = {
    html: '',
    set innerHTML(value) { this.html = value; },
    get innerHTML() { return this.html; },
    querySelector(selector) { return controls.get(selector) || null; },
  };
  const context = { document: {}, payload, row };
  vm.createContext(context);
  vm.runInContext(taskSource, context);
  vm.runInContext(`
    taskDataCache = new Map([[payload, {
      action: payload,
      detail: payload,
      assignee: payload,
      due: payload,
      scheduled_for: '',
      recurrence: payload,
    }]]);
    editTask(payload, row);
  `, context);

  assert.equal(row.html.includes(payload), false);
  for (const field of ['action', 'detail', 'assignee', 'due', 'recurrence']) {
    assert.equal(controls.get(`[data-task-field="${field}"]`).value, payload);
  }
});

test('transcript payloads render as text and view/delete listeners retain exact IDs', async () => {
  const viewButton = makeButton();
  const deleteButton = makeButton();
  const transcriptRow = {
    dataset: { transcriptIndex: '0' },
    querySelector(selector) {
      if (selector === '.transcript-view-btn') return viewButton;
      if (selector === '.transcript-delete-btn') return deleteButton;
      return null;
    },
  };
  const transcriptList = {
    html: '',
    style: {},
    setAttribute() {},
    set innerHTML(value) { this.html = value; },
    get innerHTML() { return this.html; },
    querySelectorAll(selector) {
      return selector === '[data-transcript-index]' ? [transcriptRow] : [];
    },
  };
  const transcriptContent = {
    html: '',
    set innerHTML(value) { this.html = value; },
    get innerHTML() { return this.html; },
    querySelectorAll() { return []; },
  };
  const utteranceControls = new Map([
    ['[data-utterance-field="speaker"]', { value: '', focus() {} }],
    ['[data-utterance-field="text"]', { value: '' }],
    ['.utterance-save-btn', makeButton()],
    ['.utterance-cancel-btn', makeButton()],
  ]);
  const utteranceRow = {
    html: '',
    set innerHTML(value) { this.html = value; },
    get innerHTML() { return this.html; },
    querySelector(selector) { return utteranceControls.get(selector) || null; },
  };
  const elements = new Map([
    ['transcript-list', transcriptList],
    ['transcript-detail', { style: {} }],
    ['transcript-content', transcriptContent],
    ['utt-0', utteranceRow],
  ]);
  const calls = [];
  const context = {
    payload,
    calls,
    escHtml: escapeText,
    document: { getElementById: id => elements.get(id) || null },
    api: async endpoint => {
      assert.equal(endpoint, '/transcripts');
      return {
        json: async () => [{
          bot_id: payload,
          utterance_count: 1,
          ended: '2026-07-26T12:00:00.000Z',
        }],
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(knowledgeSource, context);
  vm.runInContext(`
    viewTranscript = botId => calls.push(['view', botId]);
    deleteTranscript = botId => calls.push(['delete', botId]);
  `, context);

  await vm.runInContext('loadTranscripts()', context);
  assert.equal(transcriptList.html.includes('<img'), false);
  assert.match(transcriptList.html, /&lt;img/);
  viewButton.click();
  deleteButton.click();
  assert.deepEqual(plain(calls), [['view', payload], ['delete', payload]]);

  vm.runInContext(`
    renderUtterances([{
      speaker: payload,
      text: payload,
      timestamp: '2026-07-26T12:00:00.000Z',
    }]);
    editUtterance(0);
  `, context);
  assert.equal(transcriptContent.html.includes('<img'), false);
  assert.match(transcriptContent.html, /&lt;img/);
  assert.equal(utteranceRow.html.includes(payload), false);
  assert.equal(utteranceControls.get('[data-utterance-field="speaker"]').value, payload);
  assert.equal(utteranceControls.get('[data-utterance-field="text"]').value, payload);
});

test('project hint payloads are assigned through option value and text properties', async () => {
  const start = meetingSource.indexOf('async function loadProjectHintOptions()');
  const end = meetingSource.indexOf('loadProjectHintOptions();', start);
  assert.ok(start >= 0 && end > start);
  const loadProjectHintOptionsSource = meetingSource.slice(start, end);
  const select = {
    value: 'remembered-project',
    children: [],
    replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); },
  };
  const context = {
    payload,
    document: {
      getElementById: id => id === 'project-hint' ? select : null,
      createElement: tag => {
        assert.equal(tag, 'option');
        return { value: '', textContent: '' };
      },
    },
    api: async endpoint => {
      assert.equal(endpoint, '/projects');
      return { json: async () => [{ name: payload, status: payload }] };
    },
  };
  vm.createContext(context);
  vm.runInContext(loadProjectHintOptionsSource, context);
  await vm.runInContext('loadProjectHintOptions()', context);

  assert.equal(select.children.length, 2);
  assert.equal(select.children[1].value, payload);
  assert.equal(select.children[1].textContent, `${payload} (${payload})`);
});

test('gift payloads use safe links and bound action listeners', async () => {
  const approveButton = makeButton({ giftAction: 'approve' });
  const rejectButton = makeButton({ giftAction: 'reject' });
  const intentRow = {
    dataset: { giftIndex: '0' },
    querySelectorAll(selector) {
      return selector === '.gift-intent-action' ? [approveButton, rejectButton] : [];
    },
  };
  const policy = { innerHTML: '' };
  const intentList = {
    html: '',
    set innerHTML(value) { this.html = value; },
    get innerHTML() { return this.html; },
    querySelectorAll(selector) {
      return selector === '[data-gift-index]' ? [intentRow] : [];
    },
  };
  const deliberationList = { innerHTML: '' };
  const elements = new Map([
    ['gift-policy-state', policy],
    ['gift-intent-list', intentList],
    ['gift-deliberation-list', deliberationList],
  ]);
  const context = {
    payload,
    calls: [],
    URL,
    URLSearchParams,
    document: {
      createElement() {
        let text = '';
        return {
          set textContent(value) { text = String(value ?? ''); },
          get innerHTML() { return escapeText(text); },
        };
      },
      getElementById: id => elements.get(id) || null,
    },
    window: {
      location: { origin: 'https://dashboard.example', search: '', pathname: '/' },
    },
    history: { replaceState() {} },
    api: async endpoint => {
      if (endpoint === '/gifts/intents') {
        return {
          ok: true,
          json: async () => ({
            report: {},
            intents: [{
              id: payload,
              status: 'proposed',
              recipient_name: payload,
              reason: payload,
              amount_cents: 2500,
              goody_gift_link: `javascript:${payload}`,
            }],
          }),
        };
      }
      assert.equal(endpoint, '/gifts/deliberations?limit=20');
      return { ok: true, json: async () => ({ report: {}, deliberations: [] }) };
    },
  };
  vm.createContext(context);
  vm.runInContext(initSource.slice(initSource.indexOf('function escHtml')), context);
  vm.runInContext(adminSource, context);
  vm.runInContext('decideGiftIntent = (id, action) => calls.push([id, action]);', context);

  await vm.runInContext('loadGiftDeliberations()', context);
  assert.equal(intentList.html.includes('<img'), false);
  assert.match(intentList.html, /href="#"/);
  approveButton.click();
  rejectButton.click();
  assert.deepEqual(plain(context.calls), [[payload, 'approve'], [payload, 'reject']]);
});
