'use strict';

function eligible(task, ids, start, end) {
  return task.status === 'new' && !task.deletedAt && !task.isArchived
    && task.assignees?.some(a => ids.includes(Number(a.id)))
    && [task.startDate, task.dueDate].some(d => d && d.slice(0, 10) >= start && d.slice(0, 10) <= end)
    // Missing workflow data is not evidence of stage 0; never reset an active task.
    && task.workflowStages?.length === 1 && task.workflowStages[0].stageId === 0;
}

function createStageSweepTool({ get, send }) {
  return {
    definition: {
      name: 'teamwork_sweep_unstaged_tasks',
      description: 'Run an explicitly requested stage-0 to Ready to Start sweep in one call. Resolve all requested people with ONE teamwork_list_people call first. Checks start OR due date in the supplied week, paginates, skips missing workflows and nonzero stages, rereads candidates before moving, then verifies every move. No task creation, dates, estimates or other stages are changed. Never retry an uncertain result; report its IDs. Send the verified results to the requested Slack destination.',
      input_schema: { type: 'object', properties: {
        assignee_user_ids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 20 },
        week_start: { type: 'string', description: 'Monday YYYY-MM-DD in America/Chicago' },
        week_end: { type: 'string', description: 'Sunday YYYY-MM-DD in America/Chicago' },
      }, required: ['assignee_user_ids', 'week_start', 'week_end'] },
    },
    execute: async ({ assignee_user_ids: ids, week_start: start, week_end: end }, request = {}) => {
      if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some(id => !Number.isInteger(id) || id <= 0)
        || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)
        || !Number.isFinite(Date.parse(start)) || Date.parse(end) - Date.parse(start) !== 6 * 86400000
        || new Date(start).toISOString().slice(0, 10) !== start || new Date(end).toISOString().slice(0, 10) !== end
        || new Date(start).getUTCDay() !== 1) throw new Error('Supply verified people IDs and a Monday-Sunday date window.');
      const all = new Map();
      for (let page = 1; page <= 10; page++) {
        const data = await get(`/projects/api/v3/tasks.json?pageSize=250&page=${page}&includeCompletedTasks=false&responsiblePartyIds=${ids.join(',')}`, request);
        if (!Array.isArray(data.tasks)) throw new Error('Task lookup incomplete; no moves attempted.');
        for (const t of data.tasks) all.set(t.id, t);
        if (data.meta?.page?.hasMore === false || (data.meta?.page?.hasMore == null && data.tasks.length < 250)) break;
        if (page === 10) throw new Error('Task lookup exceeded page limit; no moves attempted.');
      }
      const candidates = [...all.values()].filter(t => eligible(t, ids, start, end));
      if (candidates.length > 100) throw new Error('More than 100 candidates; narrow the requested sweep. No moves attempted.');
      const moved = [], skipped = [], uncertain = [];
      const targets = new Map();
      for (const task of candidates) {
        const workflow = task.workflowStages[0].workflowId;
        if (!targets.has(workflow)) {
          const data = await get(`/projects/api/v3/workflows/${workflow}/stages.json?pageSize=100`, request);
          const matches = (data.stages || []).filter(s => s.name?.trim().toLowerCase() === 'ready to start' && !s.deletedAt);
          if (matches.length !== 1 || data.meta?.page?.hasMore) throw new Error(`Cannot resolve one Ready to Start stage for workflow ${workflow}.`);
          targets.set(workflow, matches[0].id);
        }
      }
      // Revalidate immediately before each write; a prior search snapshot never authorizes
      // overwriting somebody else's move. On an uncertain write, stop instead of retrying.
      for (const task of candidates) {
        request.signal?.throwIfAborted();
        const current = (await get(`/projects/api/v3/tasks/${task.id}.json`, request)).task;
        const workflow = task.workflowStages[0].workflowId;
        if (!current || !eligible(current, ids, start, end) || current.workflowStages[0].workflowId !== workflow) {
          skipped.push({ id: task.id, reason: 'Task changed since lookup' }); continue;
        }
        const target = targets.get(workflow);
        try {
          await send('POST', `/projects/api/v3/workflows/${workflow}/stages/${target}/tasks.json`, { taskIds: [task.id] }, request);
          const actual = (await get(`/projects/api/v3/tasks/${task.id}.json`, request)).task;
          if (!actual?.workflowStages?.some(s => s.workflowId === workflow && s.stageId === target)) throw new Error('Stage readback mismatch');
          moved.push({ id: task.id, name: task.name, assignee_ids: current.assignees.map(a => a.id),
            project_id: current.tasklist?.meta?.projectId, workflow_id: workflow, stage_id: target });
        } catch (error) {
          uncertain.push({ id: task.id, reason: 'Move or readback uncertain. Inspect this task before retrying.' }); break;
        }
      }
      return { verified: !uncertain.length, complete: !uncertain.length,
        window: { start, end }, scanned: all.size, candidates: candidates.length, moved, skipped, uncertain,
        ...(uncertain.length ? { error: 'Sweep stopped on uncertain write; do not repeat automatically.' } : {}) };
    },
  };
}

module.exports = { createStageSweepTool, eligible };
