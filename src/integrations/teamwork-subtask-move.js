'use strict';

const { randomUUID } = require('node:crypto');
const MOVE_TOOL = 'teamwork_move_tasks_under_parent';
const NATIVE_CONNECTION = 'nora-native-teamwork';
const listId = t => Number(t.tasklist?.id || t.tasklistId);
const parentId = t => Number(t.parentTask?.id || t.parentTaskId || 0);
const projectId = t => Number(t.tasklist?.meta?.projectId || t.projectId);
const pathFor = id => `/projects/api/v3/tasks/${id}.json`;

function id(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Supply a valid Teamwork numeric ID from the task or task-list link.');
  return n;
}

function preserved(t) {
  return JSON.stringify([t.name, t.description || '', t.status, t.startDate || null,
    t.dueDate || null, t.estimateMinutes || 0, t.progress || 0, t.priority || null,
    (t.assignees || []).map(a => `${a.type}:${a.id}`).sort(),
    (t.attachments || []).map(a => a.id).sort(), (t.tags || []).map(a => a.id).sort()]);
}

function usable(t) {
  if (!t?.id || !listId(t) || t.deletedAt || t.isArchived) throw new Error('A requested task is unavailable or archived. No move started.');
  if (t.userPermissions?.canEdit === false) throw new Error(`No edit access to task ${t.id}.`);
}

function createSubtaskMoveTools({ get, send, mutateMarkers, baseUrl }) {
  const task = async (taskId, request) => {
    const t = (await get(pathFor(taskId), request)).task;
    usable(t);
    if (Number(t.id) !== Number(taskId)) throw new Error('Task lookup returned the wrong record.');
    return t;
  };
  const save = (key, value) => mutateMarkers(m => { m[key] = value; }, { strict: true });
  return [
    {
      definition: {
        name: 'teamwork_preview_subtask_move',
        description: 'Inspect moving EXISTING tasks under a parent task, including across projects. Supply a source task-list ID OR explicit task IDs, and a parent TASK ID from its link. Does not move or recreate anything. Returns open/completed counts and a saved plan. Use scope=inspect when completed-task scope is unclear, then ask one question; use open or all when explicitly specified. Existing descendants stay nested and move with their parent. Missing estimates/dates do not block moving existing work. Once scope and destination are clear, pass the returned plan_id to teamwork_move_tasks_under_parent without another permission round.',
        input_schema: { type: 'object', properties: {
          source_tasklist_id: { type: 'integer' },
          task_ids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 250 },
          parent_task_id: { type: 'integer' },
          scope: { type: 'string', enum: ['inspect', 'open', 'all'] },
        }, required: ['parent_task_id', 'scope'] },
      },
      execute: async (args, request = {}) => {
        if (!['inspect', 'open', 'all'].includes(args.scope)) throw new Error('Specify inspect, open, or all.');
        if (Boolean(args.source_tasklist_id) === Boolean(args.task_ids?.length)) throw new Error('Supply one source task list OR explicit task IDs.');
        const parent = await task(id(args.parent_task_id), request);
        if (parent.userPermissions?.canAddSubtasks === false) throw new Error('No permission to add subtasks to this parent.');
        let rows = [];
        if (args.source_tasklist_id) {
          const source = id(args.source_tasklist_id);
          for (let page = 1; page <= 8; page++) {
            const data = await get(`/projects/api/v3/tasklists/${source}/tasks.json?pageSize=250&page=${page}&includeCompletedTasks=true&showCompletedLists=true&getSubTasks=true&nestSubTasks=false&orderBy=id`, request);
            if (!Array.isArray(data.tasks)) throw new Error('Incomplete task-list lookup; no move planned.');
            if (data.tasks.some(t => listId(t) !== source)) throw new Error('Task-list lookup returned tasks outside the requested list.');
            rows.push(...data.tasks);
            if (data.meta?.page?.hasMore === false || (data.meta?.page?.hasMore == null && data.tasks.length < 250)) break;
            if (page === 8) throw new Error('List exceeds the supported page limit. Narrow the selection.');
          }
        } else {
          if (args.task_ids.length > 250) throw new Error('Select at most 250 tasks.');
          for (const value of new Set(args.task_ids.map(id))) rows.push(await task(value, request));
        }
        rows = [...new Map(rows.map(t => [t.id, t])).values()];
        const counts = { open: rows.filter(t => t.status !== 'completed').length,
          completed: rows.filter(t => t.status === 'completed').length };
        const destination = { parent_task_id: parent.id, parent_name: parent.name,
          tasklist_id: listId(parent), project_id: projectId(parent) };
        if (args.scope === 'inspect') return { ...counts, destination,
          instruction: 'Clarify whether to move open tasks only or include completed tasks, then preview that scope.' };
        const chosen = rows.filter(t => args.scope === 'all' || t.status !== 'completed');
        const chosenIds = new Set(chosen.map(t => t.id));
        const ancestors = new Set(); let ancestor = parent;
        while (ancestor) {
          if (ancestors.has(ancestor.id) || ancestors.size >= 50) throw new Error('Cannot verify a safe parent hierarchy.');
          ancestors.add(ancestor.id);
          if (chosenIds.has(ancestor.id)) throw new Error('The selection contains the destination parent or its ancestor. Select only the tasks to move.');
          ancestor = parentId(ancestor) ? await task(parentId(ancestor), request) : null;
        }
        // Only move the top of each selected subtree. Its children keep their current hierarchy.
        const indexed = new Map(rows.map(t => [t.id, t])); const roots = [];
        for (const t of chosen) {
          let up = parentId(t); const seen = new Set([t.id]); let carried = false;
          while (up) {
            if (seen.has(up) || seen.size >= 50) throw new Error('Cannot verify the source hierarchy.');
            seen.add(up);
            if (chosenIds.has(up)) { carried = true; break; }
            if (!indexed.has(up)) indexed.set(up, await task(up, request));
            up = parentId(indexed.get(up));
          }
          if (!carried) roots.push(t);
        }
        if (roots.length > 250) throw new Error('More than 250 root tasks selected. Narrow the selection.');
        for (const t of chosen) {
          usable(t);
          if (t.sequenceId || t.sequence?.id) throw new Error(`Task ${t.id} repeats. Converting it can remove its repeat schedule; handle that explicitly first.`);
        }
        const planId = randomUUID(); const key = `subtask-move:${planId}`;
        await save(key, { status: 'ready', set_at: new Date().toISOString(),
          expires_at: Date.now() + 30 * 60 * 1000, destination, roots,
          scope: args.scope, counts });
        return { plan_id: planId, ...counts, selected_roots: roots.length, destination,
          sample: roots.slice(0, 8).map(t => ({ id: t.id, name: t.name })),
          instruction: 'When this matches the explicit request, execute this plan. Do not recreate tasks or ask for new estimates/dates.' };
      },
    },
    {
      definition: { name: MOVE_TOOL,
        description: 'Execute the exact saved preview plan to move existing tasks under its parent. In Slack this runs in the background and posts verified counts and the parent link in this thread. Never recreate tasks. Never queue twice or retry an uncertain move. Requires a plan_id from teamwork_preview_subtask_move with explicit open/all scope.',
        input_schema: { type: 'object', properties: { plan_id: { type: 'string' } }, required: ['plan_id'] } },
      execute: async ({ plan_id }, request = {}) => {
        const key = `subtask-move:${String(plan_id)}`;
        const claim = await mutateMarkers(m => {
          const p = m[key];
          if (!p) throw new Error('Move preview not found. Preview the request first.');
          if (p.status === 'done') return { prior: p.result };
          if (p.status !== 'ready') throw new Error('This move already started. Inspect its recorded outcome before retrying.');
          if (p.expires_at < Date.now()) throw new Error('Move preview expired. Refresh it before moving tasks.');
          m[key] = { ...p, status: 'executing' }; return { plan: p };
        }, { strict: true });
        if (claim.result.prior) return claim.result.prior;
        const plan = claim.result.plan; const moved = [], already = [], remaining = [];
        const end = Date.now() + Math.min(Number(request.timeoutMs) || 420000, 420000);
        const bounded = () => ({ ...request, timeoutMs: Math.max(1, Math.min(12000, end - Date.now())) });
        const dest = plan.destination;
        let uncertain = null;
        try {
          // Recheck the target and its ancestry at execution time, including queue delays.
          const rootIds = new Set(plan.roots.map(t => t.id)); let cursor = await task(dest.parent_task_id, bounded());
          if (listId(cursor) !== dest.tasklist_id || projectId(cursor) !== dest.project_id) throw new Error('Destination changed after preview; refresh the preview.');
          const seen = new Set();
          while (cursor) {
            if (seen.has(cursor.id) || seen.size >= 50 || rootIds.has(cursor.id)) throw new Error('Parent hierarchy changed or would form a cycle.');
            seen.add(cursor.id); cursor = parentId(cursor) ? await task(parentId(cursor), bounded()) : null;
          }
          for (let index = 0; index < plan.roots.length; index++) {
            const before = plan.roots[index];
            if (end - Date.now() < 15000) { remaining.push(...plan.roots.slice(index).map(t => t.id)); break; }
            request.signal?.throwIfAborted();
            const current = await task(before.id, bounded());
            if (parentId(current) === dest.parent_task_id && listId(current) === dest.tasklist_id) { already.push(current.id); continue; }
            if (listId(current) !== listId(before) || parentId(current) !== parentId(before)
                || preserved(current) !== preserved(before) || current.sequenceId || current.sequence?.id) {
              throw new Error(`Task ${before.id} changed after preview. Refresh the remaining selection.`);
            }
            // V3 cannot carry a subtree across projects. Its V1 move endpoint does, preserving
            // record IDs/history. Reparent only after verifying the move into the parent's list.
            uncertain = before.id;
            if (listId(current) !== dest.tasklist_id) {
              await send('PUT', `/tasks/${before.id}/move.json`, {
                taskId: before.id, projectId: dest.project_id, tasklistId: dest.tasklist_id,
              }, bounded());
              const relocated = await task(before.id, bounded());
              if (listId(relocated) !== dest.tasklist_id || preserved(relocated) !== preserved(current)) {
                throw new Error(`Task ${before.id} move needs inspection before changing its parent.`);
              }
            }
            await send('PATCH', pathFor(before.id), {
              task: { parentTaskId: dest.parent_task_id },
              taskOptions: { notify: false },
            }, bounded());
            const after = await task(before.id, bounded());
            if (parentId(after) !== dest.parent_task_id || listId(after) !== dest.tasklist_id
                || preserved(after) !== preserved(current)) throw new Error(`Move readback did not match for task ${before.id}. Inspect before retrying.`);
            moved.push(before.id); uncertain = null;
          }
          const url = `${String(baseUrl()).replace(/\/$/, '')}/app/tasks/${dest.parent_task_id}`;
          const result = { verified: !remaining.length, moved, already, remaining, parent_url: url,
            message: remaining.length
              ? `Moved ${moved.length} tasks under "${dest.parent_name}"; ${remaining.length} remain. The run reached its time limit. ${url}`
              : `Moved ${moved.length} existing ${moved.length === 1 ? 'task' : 'tasks'} under "${dest.parent_name}"${already.length ? ` (${already.length} were already there)` : ''}. Existing subtasks stay nested. ${url}` };
          await save(key, { ...plan, status: remaining.length ? 'partial' : 'done', result });
          return result;
        } catch (error) {
          const result = { verified: false, moved, already, uncertain_task_id: uncertain,
            error: String(error.message || error).slice(0, 350),
            message: `Moved and verified ${moved.length} tasks; the rest were not confirmed. ${uncertain ? `Task ${uncertain} needs a check before retrying. ` : ''}${String(error.message || error).slice(0, 220)}` };
          await save(key, { ...plan, status: 'stopped', result }).catch(() => {});
          return result;
        }
      },
    },
  ];
}

module.exports = { createSubtaskMoveTools, MOVE_TOOL, NATIVE_CONNECTION, preserved };
