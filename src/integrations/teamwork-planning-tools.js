'use strict';

const WRITE_TOOL_NAMES = Object.freeze([
  'teamwork_create_project',
  'teamwork_create_tasklist',
  'teamwork_create_milestone',
]);

function required(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function createTeamworkPlanningTools({ send, get, ymd }) {
  if (typeof send !== 'function' || typeof get !== 'function' || typeof ymd !== 'function') {
    throw new Error('Teamwork planning tools require send, get, and ymd functions');
  }
  return [
    {
      definition: {
        name: 'teamwork_create_project',
        description: 'Create a Teamwork project only when the requester explicitly asks for a new project. Do not use this when an existing project should be updated. Resolve the client company id first when the project must be attached to a company.',
        input_schema: { type: 'object', properties: {
          name: { type: 'string', description: 'Project name.' },
          description: { type: 'string', description: 'Optional project objective or scope.' },
          company_id: { type: 'string', description: 'Optional Teamwork company id.' },
        }, required: ['name'] },
      },
      execute: async ({ name, description, company_id }) => {
        const project = { name: required(name, 'name') };
        if (description) project.description = String(description).trim();
        if (company_id) project['company-id'] = String(company_id).trim();
        const created = await send('post', '/projects.json', { project });
        const projectId = String(created?.id || '').trim();
        if (!projectId) return { error: 'Teamwork accepted the request without returning a project id.' };
        const readback = await get(`/projects/api/v3/projects/${encodeURIComponent(projectId)}.json?include=companies`);
        const verified = String(readback?.project?.id || readback?.projects?.[0]?.id || '') === projectId;
        return { ok: verified, verified, project_id: projectId,
          project: readback?.project || readback?.projects?.[0] || null,
          ...(!verified ? { error: 'Project creation could not be verified by readback.' } : {}) };
      },
    },
    {
      definition: {
        name: 'teamwork_create_tasklist',
        description: 'Create a task list inside an existing Teamwork project when the requester explicitly asks to add a phase, workstream, or task grouping. Resolve the project id first.',
        input_schema: { type: 'object', properties: {
          project_id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          milestone_id: { type: 'string', description: 'Optional milestone to associate with the list.' },
        }, required: ['project_id', 'name'] },
      },
      execute: async ({ project_id, name, description, milestone_id }) => {
        const projectId = required(project_id, 'project_id');
        const list = { name: required(name, 'name') };
        if (description) list.description = String(description).trim();
        if (milestone_id) list['milestone-id'] = String(milestone_id).trim();
        const created = await send('post', `/projects/${encodeURIComponent(projectId)}/tasklists.json`,
          { 'todo-list': list });
        const tasklistId = String(created?.TASKLISTID || created?.id || '').trim();
        if (!tasklistId) return { error: 'Teamwork accepted the request without returning a task-list id.' };
        const readback = await get(`/tasklists/${encodeURIComponent(tasklistId)}.json`);
        const actual = readback?.['todo-list'] || readback?.tasklist || null;
        const verified = String(actual?.id || '') === tasklistId;
        return { ok: verified, verified, tasklist_id: tasklistId, tasklist: actual,
          ...(!verified ? { error: 'Task-list creation could not be verified by readback.' } : {}) };
      },
    },
    {
      definition: {
        name: 'teamwork_create_milestone',
        description: 'Create a dated milestone in an existing Teamwork project only when explicitly requested. Resolve both the project id and responsible person id first.',
        input_schema: { type: 'object', properties: {
          project_id: { type: 'string' },
          title: { type: 'string' },
          deadline: { type: 'string', description: 'Milestone deadline in YYYY-MM-DD format.' },
          responsible_person_id: { type: 'string', description: 'Teamwork person id responsible for the milestone.' },
          description: { type: 'string' },
        }, required: ['project_id', 'title', 'deadline', 'responsible_person_id'] },
      },
      execute: async ({ project_id, title, deadline, responsible_person_id, description }) => {
        const projectId = required(project_id, 'project_id');
        const milestone = {
          title: required(title, 'title'),
          deadline: ymd(required(deadline, 'deadline')),
          'responsible-party-ids': required(responsible_person_id, 'responsible_person_id'),
        };
        if (description) milestone.description = String(description).trim();
        if (!/^\d{8}$/.test(milestone.deadline)) throw new Error('deadline must be YYYY-MM-DD');
        const created = await send('post', `/projects/${encodeURIComponent(projectId)}/milestones.json`,
          { milestone });
        const milestoneId = String(created?.milestoneid || created?.id || '').trim();
        if (!milestoneId) return { error: 'Teamwork accepted the request without returning a milestone id.' };
        const readback = await get(`/projects/api/v3/milestones.json?ids=${encodeURIComponent(milestoneId)}&pageSize=1`);
        const actual = (readback?.milestones || []).find(item => String(item.id) === milestoneId) || null;
        const verified = Boolean(actual);
        return { ok: verified, verified, milestone_id: milestoneId, milestone: actual,
          ...(!verified ? { error: 'Milestone creation could not be verified by readback.' } : {}) };
      },
    },
  ];
}

module.exports = { WRITE_TOOL_NAMES, createTeamworkPlanningTools };
