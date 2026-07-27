'use strict';

function createTeamworkWriteTools({ client, twYmd } = {}) {
  if (!client || typeof client.send !== 'function') {
    throw new TypeError('Teamwork write tools require a send client');
  }
  if (typeof twYmd !== 'function') {
    throw new TypeError('Teamwork write tools require a date normalizer');
  }

  return [
    {
      definition: {
        name: 'teamwork_create_task',
        description: 'Create a NEW task in a Teamwork tasklist. Tasks live inside tasklists, so first resolve the project (teamwork_find_projects) and its tasklist (teamwork_list_tasklists). To assign someone, get their id via teamwork_list_people. Use ONLY when explicitly asked to add/create a task. After it succeeds, tell the user what you created.',
        input_schema: {
          type: 'object',
          properties: {
            tasklist_id: { type: 'string', description: 'required — the tasklist to add the task to' },
            name: { type: 'string', description: 'the task title' },
            assignee_ids: { type: 'array', items: { type: 'string' }, description: 'optional Teamwork person ids' },
            due_date: { type: 'string', description: 'optional, YYYY-MM-DD' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'optional' },
            description: { type: 'string', description: 'optional detail' },
          },
          required: ['tasklist_id', 'name'],
        },
      },
      execute: async ({
        tasklist_id,
        name,
        assignee_ids,
        due_date,
        priority,
        description,
      }) => {
        const item = { content: name };
        if (assignee_ids && assignee_ids.length) {
          item['responsible-party-id'] = assignee_ids.join(',');
        }
        if (due_date) item['due-date'] = twYmd(due_date);
        if (priority) item.priority = priority;
        if (description) item.description = description;
        const data = await client.send(
          'post',
          `/tasklists/${encodeURIComponent(tasklist_id)}/tasks.json`,
          { 'todo-item': item },
        );
        return {
          ok: true,
          task_id: data.id || data.taskId || (data.task && data.task.id),
          status: data.STATUS || 'OK',
        };
      },
    },
    {
      definition: {
        name: 'teamwork_update_task',
        description: 'Update an existing task: rename, change due date, reassign, set priority or progress. Use ONLY when explicitly asked to change a task. Resolve the task id first (teamwork_list_tasks / teamwork_find_projects). Report what you changed.',
        input_schema: {
          type: 'object',
          properties: {
            task_id: { type: 'string' },
            name: { type: 'string', description: 'optional new title' },
            due_date: { type: 'string', description: 'optional, YYYY-MM-DD' },
            assignee_ids: { type: 'array', items: { type: 'string' }, description: 'optional — replaces assignees' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'] },
            progress: { type: 'integer', description: 'optional 0-100' },
          },
          required: ['task_id'],
        },
      },
      execute: async ({ task_id, name, due_date, assignee_ids, priority, progress }) => {
        const item = {};
        if (name) item.content = name;
        if (due_date) item['due-date'] = twYmd(due_date);
        if (assignee_ids) item['responsible-party-id'] = assignee_ids.join(',');
        if (priority) item.priority = priority;
        if (progress != null) item.progress = progress;
        await client.send(
          'put',
          `/tasks/${encodeURIComponent(task_id)}.json`,
          { 'todo-item': item },
        );
        return { ok: true, updated: Object.keys(item) };
      },
    },
    {
      definition: {
        name: 'teamwork_complete_task',
        description: 'Mark a task complete (done). Use when asked to close/finish/complete a task.',
        input_schema: {
          type: 'object',
          properties: { task_id: { type: 'string' } },
          required: ['task_id'],
        },
      },
      execute: async ({ task_id }) => {
        await client.send('put', `/tasks/${encodeURIComponent(task_id)}/complete.json`, {});
        return { ok: true, status: 'completed' };
      },
    },
    {
      definition: {
        name: 'teamwork_reopen_task',
        description: 'Reopen a completed task (mark it not done again).',
        input_schema: {
          type: 'object',
          properties: { task_id: { type: 'string' } },
          required: ['task_id'],
        },
      },
      execute: async ({ task_id }) => {
        await client.send('put', `/tasks/${encodeURIComponent(task_id)}/uncomplete.json`, {});
        return { ok: true, status: 'reopened' };
      },
    },
    {
      definition: {
        name: 'teamwork_add_comment',
        description: 'Add a comment to a task. Use when asked to leave a note/update/comment on a task. Does not notify followers by default.',
        input_schema: {
          type: 'object',
          properties: {
            task_id: { type: 'string' },
            body: { type: 'string', description: 'the comment text' },
          },
          required: ['task_id', 'body'],
        },
      },
      execute: async ({ task_id, body }) => {
        const data = await client.send(
          'post',
          `/tasks/${encodeURIComponent(task_id)}/comments.json`,
          { comment: { body, notify: 'false' } },
        );
        return {
          ok: true,
          comment_id: data.commentId || data.id || (data.comment && data.comment.id),
        };
      },
    },
  ];
}

module.exports = {
  createTeamworkWriteTools,
};
