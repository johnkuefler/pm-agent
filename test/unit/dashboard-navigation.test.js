const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const coreJs = fs.readFileSync(path.join(root, 'public/js/dashboard-core.js'), 'utf8');
const helperSource = coreJs.slice(
  coreJs.indexOf('function resetMainView'),
  coreJs.indexOf('function showTab'),
);
const focusTrapSource = coreJs.slice(
  coreJs.indexOf('function trapCommandPaletteFocus'),
  coreJs.indexOf('function renderCommandResults'),
);
const plain = value => JSON.parse(JSON.stringify(value));

test('dashboard main-view reset wins restored scroll before focusing the heading', () => {
  const frames = [];
  const calls = [];
  const heading = {
    focus(options) { calls.push(['focus', options]); },
  };
  const context = {
    document: {
      getElementById(id) {
        assert.equal(id, 'page-title');
        return heading;
      },
    },
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    window: {
      scrollTo(options) { calls.push(['scroll', options]); },
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context);

  context.resetMainView();
  assert.deepEqual(plain(calls), [['scroll', { top: 0, left: 0, behavior: 'auto' }]]);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.deepEqual(plain(calls), [
    ['scroll', { top: 0, left: 0, behavior: 'auto' }],
    ['scroll', { top: 0, left: 0, behavior: 'auto' }],
    ['focus', { preventScroll: true }],
  ]);
});

test('dashboard initial reset does not steal focus and region navigation focuses after scrolling', () => {
  const frames = [];
  const calls = [];
  const heading = {
    focus(options) { calls.push(['page-focus', options]); },
  };
  const regionHeading = {
    scrollIntoView(options) { calls.push(['region-scroll', options]); },
    focus(options) { calls.push(['region-focus', options]); },
  };
  const context = {
    document: { getElementById: () => heading },
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    window: {
      scrollTo(options) { calls.push(['scroll', options]); },
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context);

  context.resetMainView({ focus: false });
  frames.shift()();
  assert.equal(calls.filter(([name]) => name === 'page-focus').length, 0);

  context.focusDashboardRegionHeading(regionHeading);
  frames.shift()();
  assert.deepEqual(plain(calls.slice(-2)), [
    ['region-scroll', { behavior: 'auto', block: 'start' }],
    ['region-focus', { preventScroll: true }],
  ]);
});

test('command palette focus trap wraps in both directions', () => {
  const calls = [];
  const document = {
    activeElement: null,
    getElementById(id) {
      assert.equal(id, 'command-palette');
      return palette;
    },
  };
  const first = {
    disabled: false,
    getAttribute: () => null,
    focus() { document.activeElement = first; calls.push('first'); },
  };
  const last = {
    disabled: false,
    getAttribute: () => null,
    focus() { document.activeElement = last; calls.push('last'); },
  };
  const palette = {
    classList: { contains: name => name === 'open' },
    contains: element => element === first || element === last,
    querySelectorAll: () => [first, last],
  };
  const context = { document };
  vm.createContext(context);
  vm.runInContext(focusTrapSource, context);

  document.activeElement = last;
  let prevented = false;
  context.trapCommandPaletteFocus({
    shiftKey: false,
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(document.activeElement, first);

  document.activeElement = first;
  prevented = false;
  context.trapCommandPaletteFocus({
    shiftKey: true,
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(document.activeElement, last);
  assert.deepEqual(calls, ['first', 'last']);
});
