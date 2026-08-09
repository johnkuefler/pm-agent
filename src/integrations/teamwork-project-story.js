'use strict';

const crypto = require('crypto');
const projectControl = require('../intelligence/project-control');

const HYDRATION_VERSION = 3;
const DECISION_PATTERN = /\b(?:approv(?:e|al)|sign[ -]?off|decision|choose|confirm)\b/i;
const GATE_PATTERN = /\b(?:launch|go[ -]?live|deploy|uat|qa|quality assurance|approv(?:e|al)|sign[ -]?off|handoff|migration|cutover)\b/i;
const PHASE_RULES = Object.freeze([
  ['launch', /\b(?:launch|go[ -]?live|deploy|cutover|hypercare)\b/i],
  ['quality assurance', /\b(?:qa|uat|quality assurance|testing|review|proof)\b/i],
  ['development', /\b(?:develop|development|build|implementation|integration|migration)\b/i],
  ['design and content', /\b(?:design|creative|copy|content|wireframe|prototype)\b/i],
  ['discovery and planning', /\b(?:discovery|strategy|planning|requirements|kickoff|scope)\b/i],
]);

function clean(value, max = 1000) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sourceDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function dueDate(value) {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? `${value}T00:00:00.000Z` : value;
  return sourceDate(normalized);
}

function dateKey(value) {
  const date = sourceDate(value);
  return date ? date.slice(0, 10) : '';
}

function latestDate(values) {
  return values.map(sourceDate).filter(Boolean).sort().at(-1) || null;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function userName(user = {}) {
  return clean([user.firstName, user.lastName].filter(Boolean).join(' ') || user.name, 240);
}

function externalProject(project = {}, companies = {}) {
  const name = clean(project.name, 300).toLowerCase();
  const companyId = project.company?.id || project.companyId;
  const company = clean(companies[companyId]?.name || project.company?.name, 300).toLowerCase();
  if (!name || name.startsWith('opportunity - ')) return false;
  if (name === 'limelight' || name.startsWith('limelight ')) return false;
  return company !== 'limelight' && !company.startsWith('limelight marketing');
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 30000));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function createTeamworkReader({ baseUrl = process.env.TEAMWORK_BASE_URL,
  apiKey = process.env.TEAMWORK_API_KEY, fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl || !apiKey) throw new Error('TEAMWORK_API_KEY and TEAMWORK_BASE_URL must be set');
  if (typeof fetchImpl !== 'function') throw new Error('Teamwork project hydration requires fetch');
  const base = String(baseUrl).replace(/\/+$/, '');
  const authorization = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  return async function getJson(path, { signal, timeoutMs = 30000 } = {}) {
    const response = await fetchImpl(`${base}${path}`, {
      headers: { Authorization: authorization, Accept: 'application/json' },
      signal: combinedSignal(signal, timeoutMs),
    });
    if (!response.ok) {
      const detail = clean(await response.text(), 300);
      throw new Error(`Teamwork ${path} returned ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return response.json();
  };
}

function mergeIncluded(target, source = {}) {
  for (const [kind, records] of Object.entries(source || {})) {
    if (!target[kind]) target[kind] = {};
    Object.assign(target[kind], records || {});
  }
}

async function fetchPages(getJson, {
  path,
  collection,
  pageSize,
  maxPages,
  signal,
  timeoutMs,
}) {
  const rows = [];
  const included = {};
  let pages = 0;
  let priorSignature = '';
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const data = await getJson(`${path}${separator}page=${page}`, { signal, timeoutMs });
    const batch = Array.isArray(data?.[collection]) ? data[collection] : [];
    const signature = batch.length ? `${batch[0]?.id}:${batch.at(-1)?.id}:${batch.length}` : '';
    if (signature && signature === priorSignature) break;
    priorSignature = signature;
    rows.push(...batch);
    mergeIncluded(included, data?.included);
    pages += 1;
    if (batch.length < pageSize) break;
  }
  return { rows, included, pages };
}

async function fetchTeamworkPortfolio({ getJson = createTeamworkReader(), signal } = {}) {
  const [projectsPage, peoplePage, milestonesPage, tasksPage] = await Promise.all([
    fetchPages(getJson, {
      path: '/projects/api/v3/projects.json?status=ACTIVE&pageSize=250&include=companies',
      collection: 'projects', pageSize: 250, maxPages: 10, signal, timeoutMs: 30000,
    }),
    fetchPages(getJson, {
      path: '/projects/api/v3/people.json?pageSize=250',
      collection: 'people', pageSize: 250, maxPages: 10, signal, timeoutMs: 30000,
    }),
    fetchPages(getJson, {
      path: '/projects/api/v3/milestones.json?pageSize=250&include=projects,users',
      collection: 'milestones', pageSize: 250, maxPages: 10, signal, timeoutMs: 30000,
    }),
    fetchPages(getJson, {
      path: '/projects/api/v3/tasks.json?pageSize=250&includeCompletedTasks=false&include=users,tasklists,projects&orderBy=dueDate&orderMode=asc',
      collection: 'tasks', pageSize: 250, maxPages: 20, signal, timeoutMs: 30000,
    }),
  ]);

  const companies = projectsPage.included.companies || {};
  const projects = projectsPage.rows.filter(project => externalProject(project, companies));
  const activeProjectIds = new Set(projects.map(project => String(project.id)));
  const people = Object.fromEntries(peoplePage.rows.map(person => [String(person.id), person]));
  for (const [id, person] of Object.entries(tasksPage.included.users || {})) people[id] = person;
  for (const [id, person] of Object.entries(milestonesPage.included.users || {})) people[id] = person;
  const tasklists = tasksPage.included.tasklists || {};

  const tasks = tasksPage.rows.filter(task => {
    const tasklist = tasklists[task.tasklist?.id || task.tasklistId] || {};
    const projectId = tasklist.project?.id || tasklist.projectId || task.project?.id || task.projectId;
    const complete = task.status === 'completed' || task.completed === true || Number(task.progress) >= 100;
    return projectId && activeProjectIds.has(String(projectId)) && !complete && !task.deletedAt;
  }).map(task => {
    const tasklistId = task.tasklist?.id || task.tasklistId;
    const tasklist = tasklists[tasklistId] || {};
    return {
      id: String(task.id),
      project_id: String(tasklist.project?.id || tasklist.projectId || task.project?.id || task.projectId),
      tasklist_id: tasklistId ? String(tasklistId) : '',
      tasklist_name: clean(tasklist.name, 300),
      milestone_id: (tasklist.milestone?.id || tasklist.milestoneId)
        ? String(tasklist.milestone?.id || tasklist.milestoneId) : '',
      name: clean(task.name, 500),
      description: clean(task.description, 800),
      priority: clean(task.priority, 40).toLowerCase(),
      progress: Math.max(0, Math.min(100, Number(task.progress) || 0)),
      start_at: dueDate(task.startDate),
      due_at: dueDate(task.dueDate),
      updated_at: sourceDate(task.updatedAt || task.dateUpdated),
      out_of_sequence: task.outOfSequence === true,
      assignees: (task.assignees || []).map(ref => userName(people[String(ref.id)] || ref)).filter(Boolean),
    };
  });

  const milestones = milestonesPage.rows.map(milestone => ({
    id: String(milestone.id),
    project_id: String(milestone.project?.id || milestone.projectId || ''),
    name: clean(milestone.name, 500),
    due_at: dueDate(milestone.deadline || milestone.dueDate),
    updated_at: sourceDate(milestone.updatedAt || milestone.dateUpdated),
    completed: milestone.completed === true || milestone.status === 'completed',
  })).filter(milestone => activeProjectIds.has(milestone.project_id) && !milestone.completed);

  return {
    observed_at: new Date().toISOString(),
    projects: projects.map(project => {
      const companyId = project.company?.id || project.companyId;
      const ownerId = project.projectOwner?.id || project.projectOwnerId
        || project.ownerId || project.ownedBy;
      return {
        id: String(project.id),
        name: clean(project.name, 300),
        description: clean(project.description, 1600),
        company: clean(companies[companyId]?.name || project.company?.name, 300),
        status: clean(project.status, 40).toLowerCase(),
        start_at: sourceDate(project.startAt || project.startDate),
        end_at: sourceDate(project.endAt || project.endDate),
        owner: userName(people[String(ownerId)] || {}),
        updated_at: sourceDate(project.updatedAt),
      };
    }),
    tasks,
    milestones,
    pagination: {
      project_pages: projectsPage.pages,
      people_pages: peoplePage.pages,
      milestone_pages: milestonesPage.pages,
      task_pages: tasksPage.pages,
    },
  };
}

function unresolvedCheckpoint(items, nowKey) {
  const dated = items.filter(item => item.due_at);
  const future = dated.filter(item => dateKey(item.due_at) >= nowKey)
    .sort((left, right) => left.due_at.localeCompare(right.due_at));
  if (future.length) return future[0];
  return dated.sort((left, right) => right.due_at.localeCompare(left.due_at))[0] || null;
}

function inferPhase(project, tasks, checkpoint, nowKey) {
  if (project.start_at && dateKey(project.start_at) > nowKey) return {
    value: 'planned', source: 'teamwork_project_start', confidence: 1,
  };
  for (const [value, pattern] of PHASE_RULES) {
    if (checkpoint?.name && pattern.test(checkpoint.name)) {
      return { value, source: 'teamwork_next_checkpoint', confidence: 0.85 };
    }
  }
  const scored = PHASE_RULES.map(([value, pattern]) => ({ value,
    score: tasks.slice(0, 30).filter(task => pattern.test(`${task.name} ${task.tasklist_name}`)).length }))
    .sort((left, right) => right.score - left.score);
  if (scored[0]?.score) return { value: scored[0].value,
    source: 'teamwork_open_work_mix', confidence: 0.75 };
  if (/\bretainer\b/i.test(project.name)) return {
    value: 'ongoing delivery', source: 'teamwork_project_name', confidence: 0.8,
  };
  return { value: tasks.length ? 'active delivery' : 'monitoring',
    source: tasks.length ? 'teamwork_open_tasks' : 'teamwork_no_open_tasks', confidence: 0.65 };
}

function inferObjective(project, phase, checkpoint) {
  if (project.description) return project.description;
  if (checkpoint) {
    const due = checkpoint.due_at ? ` by ${dateKey(checkpoint.due_at)}` : '';
    return `Advance ${project.name} through ${phase} to ${checkpoint.name}${due}.`;
  }
  return phase === 'monitoring' ? `Maintain delivery oversight for ${project.name}.`
    : `Complete the current ${phase} scope for ${project.name}.`;
}

function taskPriority(task, nextMilestone) {
  let score = 0;
  if (task.milestone_id && nextMilestone && task.milestone_id === nextMilestone.id) score += 100;
  if (task.priority === 'high') score += 50;
  if (task.out_of_sequence) score += 40;
  if (GATE_PATTERN.test(`${task.name} ${task.tasklist_name}`)) score += 30;
  if (task.due_at) score += 20;
  return score;
}

function buildProjectStories(snapshot = {}, { now = new Date() } = {}) {
  const nowKey = dateKey(now) || new Date().toISOString().slice(0, 10);
  const tasksByProject = new Map();
  const milestonesByProject = new Map();
  for (const task of snapshot.tasks || []) {
    if (!tasksByProject.has(task.project_id)) tasksByProject.set(task.project_id, []);
    tasksByProject.get(task.project_id).push(task);
  }
  for (const milestone of snapshot.milestones || []) {
    if (!milestonesByProject.has(milestone.project_id)) milestonesByProject.set(milestone.project_id, []);
    milestonesByProject.get(milestone.project_id).push(milestone);
  }

  return (snapshot.projects || []).map(project => {
    const tasks = tasksByProject.get(project.id) || [];
    const milestones = milestonesByProject.get(project.id) || [];
    const nextMilestone = unresolvedCheckpoint(milestones, nowKey);
    const nextTask = unresolvedCheckpoint(tasks, nowKey);
    const checkpoint = nextMilestone || nextTask || (project.end_at ? {
      id: project.id, name: 'Teamwork project end date', due_at: project.end_at, kind: 'project',
    } : null);
    const checkpointKind = nextMilestone ? 'milestone' : nextTask ? 'task' : checkpoint ? 'project' : 'unknown';
    const phase = inferPhase(project, tasks, checkpoint, nowKey);
    const criticalTasks = tasks.map(task => ({ task, score: taskPriority(task, nextMilestone) }))
      .filter(item => item.score >= 30)
      .sort((left, right) => right.score - left.score
        || String(left.task.due_at || '9999').localeCompare(String(right.task.due_at || '9999')))
      .slice(0, 5).map(item => item.task);
    const decisions = tasks.filter(task => DECISION_PATTERN.test(`${task.name} ${task.tasklist_name}`))
      .sort((left, right) => String(left.due_at || '9999').localeCompare(String(right.due_at || '9999')))
      .slice(0, 10);
    const objective = inferObjective(project, phase.value, checkpoint);
    const objectiveSource = project.description ? 'teamwork_project_description' : 'teamwork_project_schedule';
    const evidence = [{ type: 'teamwork_project_story', ref: `teamwork:project:${project.id}`,
      ...(project.updated_at ? { observed_at: project.updated_at } : {}) }];
    if (nextMilestone) evidence.push({ type: 'teamwork_project_story',
      ref: `teamwork:milestone:${nextMilestone.id}`,
      ...(nextMilestone.updated_at ? { observed_at: nextMilestone.updated_at } : {}) });
    for (const task of [...criticalTasks, ...decisions].slice(0, 8)) {
      evidence.push({ type: 'teamwork_project_story', ref: `teamwork:task:${task.id}`,
        ...(task.updated_at ? { observed_at: task.updated_at } : {}) });
    }
    const overdue = tasks.filter(task => task.due_at && dateKey(task.due_at) < nowKey).length;
    const unassigned = tasks.filter(task => !task.assignees.length).length;
    const sourceUpdatedAt = latestDate([project.updated_at,
      ...tasks.map(task => task.updated_at), ...milestones.map(item => item.updated_at)]);
    const sourceShape = {
      project, checkpoint: checkpoint ? { id: checkpoint.id, due_at: checkpoint.due_at,
        name: checkpoint.name, kind: checkpointKind } : null,
      phase, critical_task_ids: criticalTasks.map(task => task.id),
      decision_tasks: decisions.map(task => ({ id: task.id, name: task.name,
        description: task.description, tasklist_name: task.tasklist_name,
        priority: task.priority, progress: task.progress, start_at: task.start_at,
        due_at: task.due_at, updated_at: task.updated_at, out_of_sequence: task.out_of_sequence,
        assignees: task.assignees })),
      task_count: tasks.length, milestone_count: milestones.length,
    };
    return {
      key: project.id,
      teamwork_id: project.id,
      name: project.name,
      client: project.company,
      objective,
      phase: phase.value,
      pm: project.owner,
      next_milestone: checkpoint ? (checkpointKind === 'task'
        ? `Scheduled task: ${checkpoint.name}` : checkpoint.name) : '',
      next_milestone_due: checkpoint?.due_at || null,
      critical_path: criticalTasks.map(task => `${task.name}${task.due_at ? ` due ${dateKey(task.due_at)}` : ''}`),
      decision_refs: decisions.map(task => `teamwork:task:${task.id}`),
      decision_state: {
        status: decisions.length ? 'open_candidates' : 'clear',
        open_count: decisions.length,
        candidates: decisions.map(task => ({ id: task.id, title: task.name,
          description: task.description, tasklist: task.tasklist_name,
          priority: task.priority, progress: task.progress, start_at: task.start_at,
          due_at: task.due_at, updated_at: task.updated_at,
          out_of_sequence: task.out_of_sequence, assignees: task.assignees,
          evidence_ref: `teamwork:task:${task.id}` })),
      },
      evidence,
      source_updated_at: sourceUpdatedAt,
      hydration: {
        source: 'teamwork_project_story',
        version: HYDRATION_VERSION,
        source_signature: stableHash(sourceShape),
        field_sources: {
          objective: { source: objectiveSource, confidence: project.description ? 1 : 0.7,
            derived: !project.description, refs: [`teamwork:project:${project.id}`] },
          phase: { source: phase.source, confidence: phase.confidence, derived: phase.confidence < 1,
            refs: [`teamwork:project:${project.id}`, ...criticalTasks.slice(0, 3).map(task => `teamwork:task:${task.id}`)] },
          pm: { source: 'teamwork_project_owner', confidence: project.owner ? 1 : 0,
            derived: false, refs: [`teamwork:project:${project.id}`] },
          next_milestone: { source: `teamwork_${checkpointKind}`, confidence: nextMilestone ? 1 : nextTask ? 0.8 : checkpoint ? 1 : 0,
            derived: checkpointKind === 'task', refs: checkpoint ? [`teamwork:${checkpointKind}:${checkpoint.id}`] : [] },
          critical_path: { source: 'teamwork_schedule_gate_heuristic', confidence: criticalTasks.length ? 0.7 : 0,
            derived: true, refs: criticalTasks.map(task => `teamwork:task:${task.id}`) },
          decision_state: { source: 'teamwork_decision_task_heuristic', confidence: 0.7,
            derived: true, refs: decisions.map(task => `teamwork:task:${task.id}`) },
        },
        schedule: {
          open_tasks: tasks.length,
          overdue_tasks: overdue,
          unassigned_tasks: unassigned,
          open_milestones: milestones.length,
        },
      },
    };
  });
}

function sameValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function applyProjectStories(ledger, stories, { now = new Date(), dryRun = false } = {}) {
  let current = projectControl.normalizeLedger(ledger);
  const original = current;
  const preview = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let fieldsFilled = 0;
  for (const story of stories) {
    const existing = current.projects.find(item => item.teamwork_id === story.teamwork_id
      || item.key === story.key || item.name.toLowerCase() === story.name.toLowerCase());
    const priorManaged = new Set(existing?.hydration?.managed_fields || []);
    const managedFields = new Set(priorManaged);
    const input = { key: existing?.key || story.key, name: story.name, teamwork_id: story.teamwork_id };
    const changedFields = [];
    const directFields = ['client', 'objective', 'phase', 'pm', 'critical_path', 'decision_refs', 'decision_state'];
    for (const field of directFields) {
      const candidate = story[field];
      const unknownDecisionState = field === 'decision_state' && existing?.decision_state?.status === 'unknown'
        && !existing.decision_state.candidates?.length && !existing.decision_state.open_count;
      const missing = unknownDecisionState || (Array.isArray(existing?.[field])
        ? existing[field].length === 0 : !existing?.[field]);
      if ((missing || priorManaged.has(field)) && candidate
        && (!Array.isArray(candidate) || candidate.length)) {
        input[field] = candidate;
        managedFields.add(field);
        if (!sameValue(existing?.[field], candidate)) {
          changedFields.push(field);
          if (missing) fieldsFilled += 1;
        }
      }
    }
    const milestoneManaged = priorManaged.has('next_milestone');
    if ((!existing?.next_milestone || milestoneManaged) && story.next_milestone) {
      input.next_milestone = story.next_milestone;
      input.next_milestone_due = story.next_milestone_due;
      managedFields.add('next_milestone');
      managedFields.add('next_milestone_due');
      if (!sameValue(existing?.next_milestone, story.next_milestone)) changedFields.push('next_milestone');
      if (!sameValue(existing?.next_milestone_due, story.next_milestone_due)) changedFields.push('next_milestone_due');
      if (!existing?.next_milestone) fieldsFilled += 1;
      if (!existing?.next_milestone_due && story.next_milestone_due) fieldsFilled += 1;
    }
    const priorEvidence = (existing?.evidence || []).filter(item => item.type !== 'teamwork_project_story');
    input.evidence = [...priorEvidence, ...story.evidence].slice(0, 20);
    input.source_updated_at = story.source_updated_at;
    input.hydration = {
      ...story.hydration,
      hydrated_at: new Date(now).toISOString(),
      managed_fields: [...managedFields].sort(),
    };
    const sourceChanged = existing?.hydration?.source_signature !== story.hydration.source_signature;
    const evidenceChanged = !sameValue(existing?.evidence, input.evidence);
    if (existing && !sourceChanged && !changedFields.length && !evidenceChanged) {
      unchanged += 1;
      continue;
    }
    preview.push({ key: input.key, name: story.name, created: !existing, changed_fields: changedFields });
    if (!existing) created += 1;
    else updated += 1;
    if (!dryRun) current = projectControl.upsertProject(current, input, { now }).ledger;
  }
  const result = { projects_seen: stories.length, created, updated, unchanged, fields_filled: fieldsFilled,
    preview: preview.slice(0, 100) };
  if (dryRun) return { ledger: original, ...result, dry_run: true };
  const sync = projectControl.recordSync(current, {
    source: 'teamwork_project_story', projects_seen: stories.length,
    projects_updated: created + updated,
    note: `Hydrated ${created + updated} project stories; filled ${fieldsFilled} missing control fields.`,
  }, { now });
  return { ledger: sync.ledger, sync: sync.sync, ...result, dry_run: false };
}

module.exports = {
  HYDRATION_VERSION,
  createTeamworkReader,
  fetchTeamworkPortfolio,
  buildProjectStories,
  applyProjectStories,
  externalProject,
};
