'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'public/js/dashboard-portfolio.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');

function portfolioContext() {
  const context = { console, Intl };
  vm.createContext(context);
  vm.runInContext(source + '\n;globalThis.__portfolio = {'
    + 'signals: portfolioProjectSignals, priority: portfolioPriority, date: portfolioDate, state: projectPortfolioState};',
  context);
  return context.__portfolio;
}

function project(overrides = {}) {
  return {
    key: 'project-1', name: 'Client launch', health: 'unknown',
    next_milestone_due: '2099-08-10T00:00:00.000Z',
    completeness: { ratio: 1, missing: [] },
    decision_state: { open_count: 0, candidates: [] },
    hydration: { source: 'teamwork_project_story', schedule: {
      open_tasks: 8, overdue_tasks: 0, unassigned_tasks: 0, open_milestones: 1,
    } },
    ...overrides,
  };
}

test('portfolio opens as Nora default workspace and retains every existing room', () => {
  assert.match(html, /data-tab="projects" aria-selected="true"/);
  assert.match(html, /id="page-projects" class="page active"/);
  assert.match(html, /What needs management now/);
  assert.match(html, /Nora's judgment/);
  assert.match(html, /id="pm-autopilot-summary"/);
  assert.match(html, /id="project-autopilot-panel"/);
  assert.match(html, /id="decision-detail"/);
  assert.match(html, /id="decision-detail-content"/);
  assert.match(source, /Why Nora believes this/);
  assert.match(source, /viewDecisionCandidate/);
  assert.match(source, /Teamwork task detail/);
  assert.match(source, /Context still needed/);
  assert.match(html, /data-project-filter="attention"/);
  assert.equal([...html.matchAll(/data-tab="([^"]+)"/g)].length, 15);
});

test('portfolio attention is source-bound and does not turn unknown health red', () => {
  const portfolio = portfolioContext();
  const quiet = project();
  const quietSignals = portfolio.signals(quiet);
  assert.equal(quietSignals.attention, false);
  assert.equal(quietSignals.healthAttention, false);

  const overdue = project({ hydration: { source: 'teamwork_project_story', schedule: {
    open_tasks: 8, overdue_tasks: 2, unassigned_tasks: 1, open_milestones: 1,
  } } });
  assert.equal(portfolio.signals(overdue).attention, true);
  assert.ok(portfolio.priority(overdue) > portfolio.priority(quiet));
});

test('decision candidates and verified risks independently raise portfolio priority', () => {
  const portfolio = portfolioContext();
  const quiet = project();
  const decision = project({ key: 'project-2', decision_state: { open_count: 2, candidates: [] } });
  assert.equal(portfolio.signals(decision).decisions, 2);
  assert.ok(portfolio.priority(decision) > portfolio.priority(quiet));

  portfolio.state.risks.push({ project_key: 'project-1', severity: 'high' });
  const riskSignals = portfolio.signals(quiet);
  assert.equal(riskSignals.openRisks.length, 1);
  assert.equal(riskSignals.attention, true);
  assert.ok(portfolio.priority(quiet) > portfolio.priority(decision));
});

test('Teamwork date-only timestamps stay on their source calendar day', () => {
  const portfolio = portfolioContext();
  assert.match(portfolio.date('2026-08-06T00:00:00.000Z'), /Aug 6/);
  const now = new Date();
  const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    + `-${String(now.getUTCDate()).padStart(2, '0')}T00:00:00.000Z`;
  assert.equal(portfolio.signals(project({ next_milestone_due: today })).checkpointOverdue, false);
});

test('portfolio loads the durable PM sources together and never starts its own polling loop', () => {
  assert.match(source, /api\('\/pm-control'\)/);
  assert.match(source, /api\('\/pm-control\/evaluation'\)/);
  assert.match(source, /api\('\/pm-control\/hydration'\)/);
  assert.match(source, /api\('\/pm-control\/autopilot\/report'\)/);
  assert.match(source, /api\('\/projects'\)/);
  assert.match(source, /operatorApi\(`\/pm-control\/autopilot\/charters/);
  assert.match(source, /operatorApi\(`\/pm-control\/autopilot\/actions/);
  assert.match(source, /operatorApi\(`\/pm-control\/autopilot\/meetings/);
  assert.match(source, /Hydration never spends a human interruption/);
  assert.doesNotMatch(source, /setInterval\(/);
  assert.doesNotThrow(() => new vm.Script(source));
});
