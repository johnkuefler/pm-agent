'use strict';

function taskTags(task, included = {}) {
  const refs = [...new Map([...(task.tagIds || []).map(id => ({ id })),
    ...(Array.isArray(task.tags) ? task.tags : [])].map(tag => [Number(tag.id), tag])).values()];
  return refs.map(tag => ({ id: Number(tag.id), name: tag.name || included.tags?.[tag.id]?.name || null }));
}

function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Supply valid YYYY-MM-DD dates.');
  return value;
}

async function pages(get, path, field, request, maxPages = 20) {
  const rows = new Map(); const included = {};
  for (let page = 1; page <= maxPages; page++) {
    request.signal?.throwIfAborted();
    const data = await get(`${path}&pageSize=250&page=${page}`, request);
    if (!Array.isArray(data?.[field])) throw new Error(`Incomplete ${field} lookup; do not report zero matches.`);
    for (const row of data[field]) rows.set(row.id, row);
    for (const [kind, values] of Object.entries(data.included || {})) {
      included[kind] = { ...included[kind], ...values };
    }
    if (data.meta?.page?.hasMore === false || (data.meta?.page?.hasMore == null && data[field].length < 250)) {
      return { rows: [...rows.values()], included };
    }
  }
  throw new Error(`${field} lookup exceeded its page limit; do not publish an incomplete report.`);
}

function createTaggedTasksTool({ get }) {
  return {
    definition: {
      name: 'teamwork_find_tagged_tasks',
      description: 'Read tasks with an exact Teamwork tag name (for example tentative) whose START OR DUE date is inside the inclusive date window. Resolves live tag IDs and paginates across projects in one call. Returns verified tag membership, project, assignees and dates for a report. Active projects and incomplete tasks only by default. No tasks or tags are changed. Use this for the weekly tentative sweep instead of guessing from task names or filtering only by due date. If this tool errors, leave the report pending; never publish a tooling-gap message as a completed sweep.',
      input_schema: { type: 'object', properties: {
        tag_name: { type: 'string' },
        window_start: { type: 'string', description: 'Inclusive YYYY-MM-DD, Monday for calendar-week sweeps' },
        window_end: { type: 'string', description: 'Inclusive YYYY-MM-DD, Sunday for calendar-week sweeps' },
        include_completed: { type: 'boolean', description: 'Default false' },
        active_projects_only: { type: 'boolean', description: 'Default true' },
      }, required: ['tag_name', 'window_start', 'window_end'] },
    },
    execute: async ({ tag_name, window_start, window_end, include_completed = false, active_projects_only = true }, request = {}) => {
      const name = String(tag_name || '').trim();
      if (!name || name.length > 120) throw new Error('Supply the exact tag name.');
      const start = date(window_start), end = date(window_end);
      if (start > end) throw new Error('Window end must be on or after its start.');
      const tags = await pages(get, `/projects/api/v3/tags.json?searchTerm=${encodeURIComponent(name)}`, 'tags', request, 8);
      const matches = tags.rows.filter(t => !t.deletedAt && t.name?.trim().toLowerCase() === name.toLowerCase());
      if (!matches.length) throw new Error(`No accessible tag exactly matches "${name}". Check the tag name/access; this does not mean no tasks exist.`);
      const ids = new Set(matches.map(t => Number(t.id)));
      // Do not combine start and due server filters: that would require BOTH dates in the
      // window and miss tasks starting this week but due later (or starting earlier, due now).
      const found = await pages(get, `/projects/api/v3/tasks.json?tagIds=${[...ids].join(',')}&includeCompletedTasks=${include_completed}&showCompletedLists=${include_completed}&getSubTasks=true&nestSubTasks=false&include=tags,users,tasklists,projects&orderBy=id`, 'tasks', request);
      const projects = { ...found.included.projects }; const result = [];
      for (const t of found.rows) {
        if (t.deletedAt || t.isArchived || (!include_completed && t.status === 'completed')) continue;
        if (t.tags === undefined && t.tagIds === undefined) throw new Error(`Tag membership missing for task ${t.id}; report incomplete.`);
        if (!taskTags(t, found.included).some(tag => ids.has(tag.id))) continue;
        if (![t.startDate, t.dueDate].some(d => d && d.slice(0, 10) >= start && d.slice(0, 10) <= end)) continue;
        const list = found.included.tasklists?.[t.tasklist?.id] || t.tasklist?.meta || {};
        const projectId = Number(list.project?.id || list.projectId || t.tasklist?.meta?.projectId);
        if (!projectId) throw new Error(`Cannot resolve project for task ${t.id}; report incomplete.`);
        if (!projects[projectId]?.status) projects[projectId] = (await get(`/projects/api/v3/projects/${projectId}.json`, request)).project;
        const project = projects[projectId];
        if (!project?.status || !project.name) throw new Error(`Cannot verify project ${projectId}; report incomplete.`);
        if (active_projects_only && !['active', 'current'].includes(project.status.toLowerCase())) continue;
        result.push({ id: t.id, name: t.name, project: project.name, project_id: projectId,
          tasklist: list.name || null, start_date: t.startDate || null, due_date: t.dueDate || null,
          assignees: (t.assignees || []).map(a => {
            const user = found.included.users?.[a.id];
            return user ? [user.firstName, user.lastName].filter(Boolean).join(' ') : `${a.type || 'user'} #${a.id}`;
          }), tags: taskTags(t, { tags: Object.fromEntries(matches.map(tag => [tag.id, tag])) }) });
      }
      if (result.length > 150) throw new Error('More than 150 matching tasks. Narrow the date window before publishing; no partial table returned.');
      result.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
      const output = { complete: true, tag: name, tag_ids: [...ids], window: { start, end },
        active_projects_only, include_completed, count: result.length, tasks: result };
      if (JSON.stringify(output).length > 11000) throw new Error('Matching tasks exceed the tool response budget. Narrow the window; do not publish a truncated table.');
      return output;
    },
  };
}

module.exports = { createTaggedTasksTool, taskTags };
