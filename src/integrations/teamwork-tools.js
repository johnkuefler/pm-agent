'use strict';

const { createTeamworkWriteTools } = require('./teamwork-write-tools');

const TW_WRITE_NAMES = new Set([
  'teamwork_create_task',
  'teamwork_update_task',
  'teamwork_complete_task',
  'teamwork_reopen_task',
  'teamwork_add_comment',
]);

function twYmd(value) {
  return value ? String(value).replace(/[^0-9]/g, '').slice(0, 8) : undefined;
}

function slimTwTask(task, included = {}) {
  const users = included.users || {};
  const tasklists = included.tasklists || {};
  const projects = included.projects || {};
  const assignees = (task.assignees || []).map((assignee) => {
    const user = users[assignee.id];
    return user
      ? [user.firstName, user.lastName].filter(Boolean).join(' ')
      : `#${assignee.id}`;
  });
  const tasklist = (task.tasklist && tasklists[task.tasklist.id]) || null;
  const projectId = tasklist && ((tasklist.project && tasklist.project.id) || tasklist.projectId);
  return {
    id: task.id,
    name: task.name,
    status: task.status,
    assignees: assignees.length ? assignees : undefined,
    due: task.dueDate || undefined,
    start: task.startDate || undefined,
    priority: task.priority || undefined,
    progress: task.progress != null ? task.progress : undefined,
    tasklist: (tasklist && tasklist.name) || undefined,
    project: (projectId && projects[projectId] && projects[projectId].name) || undefined,
  };
}

function createTeamworkTools({ client } = {}) {
  if (!client || typeof client.enabled !== 'function'
    || typeof client.get !== 'function' || typeof client.send !== 'function') {
    throw new TypeError('Teamwork tools require an enabled/get/send client');
  }

  async function teamworkTeamCapacity(
    { start_date, end_date, min_free_hours, user_ids },
    request = {},
  ) {
    const roundOne = (number) => Math.round(number * 10) / 10;
    const minFree = min_free_hours != null && min_free_hours !== ''
      ? Number(min_free_hours)
      : null;
    const scope = user_ids
      ? `&userIds=${encodeURIComponent(String(user_ids).split(',').map((id) => id.trim()).filter(Boolean).join(','))}`
      : '';
    const data = await client.get(
      `/projects/api/v3/workload.json?startDate=${encodeURIComponent(start_date)}&endDate=${encodeURIComponent(end_date)}&include=users&pageSize=200${scope}`,
      request,
    );
    const included = data?.included?.users || {};
    const rows = [];
    for (const user of (data?.workload?.users || [])) {
      const info = included[user.userId] || {};
      if (info.isClientUser) continue;
      const name = [info.firstName, info.lastName].filter(Boolean).join(' ') || `#${user.userId}`;
      if (/needs resourced|resource pool/i.test(name)) continue;
      const dayCapacityMinutes = (info.lengthOfDay || 8) * 60;
      let availableDays = 0;
      let freeMinutes = 0;
      let allocatedMinutes = 0;
      let capacityMinutes = 0;
      let over = false;
      for (const day of Object.values(user.dates || {})) {
        if (day.unavailableDay) continue;
        availableDays++;
        const allocated = day.capacityMinutes || 0;
        allocatedMinutes += allocated;
        capacityMinutes += dayCapacityMinutes;
        freeMinutes += Math.max(0, dayCapacityMinutes - allocated);
        if (allocated > dayCapacityMinutes) over = true;
      }
      if (!availableDays) continue;
      const bookedPct = capacityMinutes
        ? Math.round((allocatedMinutes / capacityMinutes) * 100)
        : 0;
      rows.push({
        user: name,
        userId: user.userId,
        freeHours: roundOne(freeMinutes / 60),
        bookedPct,
        availableDays,
        over,
      });
    }
    const tracked = rows
      .filter((row) => row.bookedPct > 0)
      .sort((left, right) => right.freeHours - left.freeHours);
    const hasRoom = (minFree != null
      ? tracked.filter((row) => row.freeHours >= minFree)
      : tracked).map(({ over: _over, ...row }) => row);
    const untracked = rows.filter((row) => row.bookedPct === 0).map((row) => row.user);
    return {
      window: { start: start_date, end: end_date },
      ...(minFree != null ? { min_free_hours: minFree } : {}),
      team_size: rows.length,
      note: 'has_room = members with tracked Teamwork allocation who still have free hours (ranked, these are the real candidates). over_allocated = booked beyond capacity (flag these). unallocated = people with NO tracked workload, which usually means their work just is not estimated in Teamwork, so confirm before assuming they are free.',
      over_allocated: rows
        .filter((row) => row.over)
        .map((row) => ({ user: row.user, bookedPct: row.bookedPct })),
      has_room: hasRoom.slice(0, 25),
      unallocated_count: untracked.length,
      unallocated: untracked.slice(0, 20),
    };
  }

  const tools = [
    {
      definition: {
        name: 'teamwork_find_projects',
        description: 'Find active Teamwork projects by name, or list active projects if no query. Use this first to resolve a project name to its id. Returns id, name, company, status.',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'optional name search; omit to list active projects' },
          },
        },
      },
      execute: async ({ query }, request = {}) => {
        const queryPart = query ? `&searchTerm=${encodeURIComponent(query)}` : '';
        const data = await client.get(
          `/projects/api/v3/projects.json?status=ACTIVE&pageSize=50&include=companies${queryPart}`,
          request,
        );
        const companies = data?.included?.companies || {};
        return (data?.projects || []).slice(0, 50).map((project) => ({
          id: project.id,
          name: project.name,
          status: project.status,
          company: (project.company?.id && companies[project.company.id]?.name)
            || project.company?.name || '',
        }));
      },
    },
    {
      definition: {
        name: 'teamwork_get_project',
        description: 'Get a single Teamwork project\'s details by id: name, company, status, description, dates.',
        input_schema: {
          type: 'object',
          properties: { project_id: { type: 'string' } },
          required: ['project_id'],
        },
      },
      execute: async ({ project_id }, request = {}) => {
        const data = await client.get(
          `/projects/api/v3/projects/${encodeURIComponent(project_id)}.json?include=companies`,
          request,
        );
        const project = data?.project || {};
        const companies = data?.included?.companies || {};
        return {
          id: project.id,
          name: project.name,
          status: project.status,
          description: project.description,
          company: (project.company?.id && companies[project.company.id]?.name) || '',
          startDate: project.startAt || undefined,
          endDate: project.endAt || undefined,
        };
      },
    },
    {
      definition: {
        name: 'teamwork_list_tasks',
        description: 'List tasks across ALL projects (or one project), with optional filters by ASSIGNEE and DUE DATE. Returns task name, assignees, due date, priority, progress, tasklist, project. For "what is due tomorrow for <person>" type questions, this is the tool: first resolve the person with teamwork_list_people to get their user id, pass it as assigned_to_user_ids, and set due_on (or due_after / due_before) to the date. Dates are YYYY-MM-DD. Omit project_id to sweep every active project. Without an assignee or date filter this just lists recent tasks, which across all projects is a noisy dump, so always scope it when answering "what is due for me/them".',
        input_schema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'optional: scope to one project' },
            assigned_to_user_ids: { type: 'string', description: 'optional: comma-separated Teamwork user ids to scope to specific assignees (resolve via teamwork_list_people first)' },
            due_on: { type: 'string', description: 'optional: only tasks due on exactly this date (YYYY-MM-DD)' },
            due_after: { type: 'string', description: 'optional: only tasks due on or after this date (YYYY-MM-DD)' },
            due_before: { type: 'string', description: 'optional: only tasks due on or before this date (YYYY-MM-DD)' },
            include_completed: { type: 'boolean', description: 'default false' },
          },
        },
      },
      execute: async ({
        project_id,
        assigned_to_user_ids,
        due_on,
        due_after,
        due_before,
        include_completed,
      }, request = {}) => {
        const after = due_on || due_after;
        const before = due_on || due_before;
        const assigneeSet = assigned_to_user_ids
          ? new Set(String(assigned_to_user_ids).split(',').map((id) => id.trim()).filter(Boolean))
          : null;
        const filtering = Boolean(assigneeSet || after || before);
        const pageSize = filtering ? 250 : 75;
        const common = [
          `pageSize=${pageSize}`,
          `includeCompletedTasks=${include_completed ? 'true' : 'false'}`,
          'include=users,tasklists,projects',
        ];
        if (project_id) common.push(`projectIds=${encodeURIComponent(project_id)}`);
        let queryParts = common.slice();
        queryParts.push('orderBy=dueDate', 'orderMode=asc');
        if (assigneeSet) {
          queryParts.push(`responsiblePartyIds=${encodeURIComponent([...assigneeSet].join(','))}`);
        }
        if (after) queryParts.push(`dueAfter=${encodeURIComponent(after)}`);
        if (before) queryParts.push(`dueBefore=${encodeURIComponent(before)}`);
        const maxPages = filtering ? 8 : 1;
        const all = [];
        const included = { users: {}, tasklists: {}, projects: {} };
        let page = 1;
        while (page <= maxPages) {
          let data;
          try {
            data = await client.get(
              `/projects/api/v3/tasks.json?${queryParts.join('&')}&page=${page}`,
              request,
            );
          } catch (error) {
            if (queryParts.length <= common.length) throw error;
            queryParts = common.slice();
            data = await client.get(
              `/projects/api/v3/tasks.json?${queryParts.join('&')}&page=${page}`,
              request,
            );
          }
          const tasks = data?.tasks || [];
          const sideload = data?.included || {};
          Object.assign(included.users, sideload.users || {});
          Object.assign(included.tasklists, sideload.tasklists || {});
          Object.assign(included.projects, sideload.projects || {});
          all.push(...tasks);
          if (tasks.length < pageSize) break;
          page++;
        }
        const afterYmd = twYmd(after);
        const beforeYmd = twYmd(before);
        const rows = all.filter((task) => {
          if (assigneeSet) {
            const ids = (task.assignees || []).map((assignee) => String(assignee.id));
            if (!ids.some((id) => assigneeSet.has(id))) return false;
          }
          if (afterYmd || beforeYmd) {
            const dueYmd = twYmd(task.dueDate);
            if (!dueYmd) return false;
            if (afterYmd && dueYmd < afterYmd) return false;
            if (beforeYmd && dueYmd > beforeYmd) return false;
          }
          return true;
        });
        return rows.slice(0, 100).map((task) => slimTwTask(task, included));
      },
    },
    {
      definition: {
        name: 'teamwork_get_task',
        description: 'Get one task\'s full detail by id: description, assignees, due date, progress, status, tasklist, project.',
        input_schema: {
          type: 'object',
          properties: { task_id: { type: 'string' } },
          required: ['task_id'],
        },
      },
      execute: async ({ task_id }, request = {}) => {
        const data = await client.get(
          `/projects/api/v3/tasks/${encodeURIComponent(task_id)}.json?include=users,tasklists,projects`,
          request,
        );
        const task = data?.task || {};
        return {
          ...slimTwTask(task, data?.included || {}),
          description: (task.description || '').slice(0, 1500) || undefined,
        };
      },
    },
    {
      definition: {
        name: 'teamwork_list_milestones',
        description: 'List milestones (deadlines), optionally scoped to a project. Returns name, deadline, status, project. Use for "what\'s due / what\'s the deadline" questions.',
        input_schema: {
          type: 'object',
          properties: { project_id: { type: 'string' } },
        },
      },
      execute: async ({ project_id }, request = {}) => {
        const queryPart = project_id ? `&projectIds=${encodeURIComponent(project_id)}` : '';
        const data = await client.get(
          `/projects/api/v3/milestones.json?pageSize=75&include=projects${queryPart}`,
          request,
        );
        const projects = data?.included?.projects || {};
        return (data?.milestones || []).slice(0, 75).map((milestone) => ({
          id: milestone.id,
          name: milestone.name,
          deadline: milestone.deadline,
          status: milestone.status,
          completed: milestone.completed,
          project: (milestone.project?.id && projects[milestone.project.id]?.name) || undefined,
        }));
      },
    },
    {
      definition: {
        name: 'teamwork_list_tasklists',
        description: 'List a project\'s tasklists (how its work is grouped). Returns id and name. Needs a project_id.',
        input_schema: {
          type: 'object',
          properties: { project_id: { type: 'string' } },
          required: ['project_id'],
        },
      },
      execute: async ({ project_id }, request = {}) => {
        const data = await client.get(
          `/projects/api/v3/tasklists.json?projectIds=${encodeURIComponent(project_id)}&pageSize=100`,
          request,
        );
        return (data?.tasklists || []).slice(0, 100)
          .map((tasklist) => ({ id: tasklist.id, name: tasklist.name }));
      },
    },
    {
      definition: {
        name: 'teamwork_list_people',
        description: 'List Teamwork people (team members). Returns id, name, company, title. Use to resolve who someone is or who\'s on the team.',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'optional name search' } },
        },
      },
      execute: async ({ query }, request = {}) => {
        const queryPart = query ? `&searchTerm=${encodeURIComponent(query)}` : '';
        const data = await client.get(
          `/projects/api/v3/people.json?pageSize=200&include=companies${queryPart}`,
          request,
        );
        const companies = data?.included?.companies || {};
        return (data?.people || []).slice(0, 200).map((person) => ({
          id: person.id,
          name: [person.firstName, person.lastName].filter(Boolean).join(' '),
          company: (person.company?.id && companies[person.company.id]?.name) || '',
          title: person.title,
        }));
      },
    },
    {
      definition: {
        name: 'teamwork_get_task_comments',
        description: 'Get recent comments / activity on a task by id. Use for "what\'s the latest on this task" questions.',
        input_schema: {
          type: 'object',
          properties: { task_id: { type: 'string' } },
          required: ['task_id'],
        },
      },
      execute: async ({ task_id }, request = {}) => {
        const data = await client.get(
          `/projects/api/v3/tasks/${encodeURIComponent(task_id)}/comments.json?include=users&pageSize=20`,
          request,
        );
        const users = data?.included?.users || {};
        return (data?.comments || []).slice(-20).map((comment) => {
          const userId = comment.userId || (comment.author && comment.author.id);
          const user = userId && users[userId];
          return {
            author: user
              ? [user.firstName, user.lastName].filter(Boolean).join(' ')
              : (comment.userFirstName || undefined),
            date: comment.postedDateTime || comment.createdAt || comment.dateTime || undefined,
            body: (comment.body || '').slice(0, 500),
          };
        });
      },
    },
    {
      definition: {
        name: 'teamwork_user_workload',
        description: 'Check how booked one or more people are over a date range (their CAPACITY / scheduling load), for decisions like "how booked is Santi next week" or "who has room to take this on". Returns, per person per day: percent booked, hours already allocated, hours free, and whether they are off/unavailable that day, plus a summary (available days, average booked %, total free hours, and their most-open day). Resolve people with teamwork_list_people to get their ids. Dates are YYYY-MM-DD; use the [Right now] block to work out "next week". This is workload CAPACITY, not the task list. Use teamwork_list_tasks to see WHAT they are actually working on.',
        input_schema: {
          type: 'object',
          properties: {
            user_ids: { type: 'string', description: 'required: comma-separated Teamwork user ids (resolve via teamwork_list_people)' },
            start_date: { type: 'string', description: 'required: window start, YYYY-MM-DD' },
            end_date: { type: 'string', description: 'required: window end, YYYY-MM-DD' },
          },
          required: ['user_ids', 'start_date', 'end_date'],
        },
      },
      execute: async ({ user_ids, start_date, end_date }, request = {}) => {
        const ids = String(user_ids).split(',').map((id) => id.trim()).filter(Boolean).join(',');
        const data = await client.get(
          `/projects/api/v3/workload.json?startDate=${encodeURIComponent(start_date)}&endDate=${encodeURIComponent(end_date)}&userIds=${encodeURIComponent(ids)}&include=users`,
          request,
        );
        const includedUsers = data?.included?.users || {};
        const weekday = (date) => {
          try {
            return new Date(`${date}T00:00:00Z`).toLocaleDateString(
              'en-US',
              { weekday: 'short', timeZone: 'UTC' },
            );
          } catch {
            return '';
          }
        };
        const roundOne = (number) => Math.round(number * 10) / 10;
        return (data?.workload?.users || []).map((user) => {
          const info = includedUsers[user.userId] || {};
          const name = [info.firstName, info.lastName].filter(Boolean).join(' ')
            || `#${user.userId}`;
          const dayHours = info.lengthOfDay || 8;
          const dayCapacityMinutes = dayHours * 60;
          let availableDays = 0;
          let totalFree = 0;
          let availableAllocation = 0;
          let availableCapacity = 0;
          let mostOpen = null;
          const days = Object.entries(user.dates || {}).map(([date, day]) => {
            if (day.unavailableDay) {
              return {
                date,
                weekday: weekday(date),
                status: day.isHoliday ? 'holiday' : 'off',
              };
            }
            const allocated = day.capacityMinutes || 0;
            const freeHours = roundOne(Math.max(0, dayCapacityMinutes - allocated) / 60);
            availableDays++;
            totalFree += freeHours;
            availableAllocation += allocated;
            availableCapacity += dayCapacityMinutes;
            if (!mostOpen || freeHours > mostOpen.freeHours) {
              mostOpen = { date, weekday: weekday(date), freeHours };
            }
            return {
              date,
              weekday: weekday(date),
              status: 'available',
              bookedPct: Math.round((allocated / dayCapacityMinutes) * 100),
              allocatedHours: roundOne(allocated / 60),
              freeHours,
            };
          });
          return {
            user: name,
            userId: user.userId,
            dayHours,
            window: { start: start_date, end: end_date },
            days,
            summary: {
              availableDays,
              avgBookedPct: availableCapacity
                ? Math.round((availableAllocation / availableCapacity) * 100)
                : 0,
              freeHoursTotal: roundOne(totalFree),
              mostOpenDay: mostOpen
                ? `${mostOpen.weekday} ${mostOpen.date} (${mostOpen.freeHours}h free)`
                : 'none (fully booked/unavailable)',
            },
          };
        });
      },
    },
    {
      definition: {
        name: 'teamwork_team_capacity',
        description: 'Sweep the WHOLE delivery team\'s capacity over a date range to answer staffing questions like "who has room next week for a 10-hour build" or "who is overbooked". Returns people ranked by free hours (most open first), plus an over-allocated list. Set min_free_hours to only show people with at least that many free hours (e.g. 10 for a 10h task). Optionally pass user_ids to limit to specific people (resolve via teamwork_list_people); otherwise it sweeps the assignable team and excludes client contacts. Dates are YYYY-MM-DD; use the [Right now] block for "next week". For one specific person\'s day-by-day picture use teamwork_user_workload instead.',
        input_schema: {
          type: 'object',
          properties: {
            start_date: { type: 'string', description: 'required: window start, YYYY-MM-DD' },
            end_date: { type: 'string', description: 'required: window end, YYYY-MM-DD' },
            min_free_hours: { type: 'number', description: 'optional: only list people with at least this many free hours in the window' },
            user_ids: { type: 'string', description: 'optional: comma-separated user ids to limit the sweep to specific people' },
          },
          required: ['start_date', 'end_date'],
        },
      },
      execute: async (args, request = {}) => teamworkTeamCapacity(args, request),
    },
  ];
  tools.push(...createTeamworkWriteTools({ client, twYmd }));

  function realtimeTeamworkTools() {
    if (!client.enabled()) return [];
    return tools
      .filter((tool) => !TW_WRITE_NAMES.has(tool.definition.name))
      .map((tool) => ({
        type: 'function',
        name: tool.definition.name,
        description: tool.definition.description,
        parameters: tool.definition.input_schema,
      }));
  }

  return Object.freeze({
    TEAMWORK_TOOLS: tools,
    TW_WRITE_NAMES,
    realtimeTeamworkTools,
    teamworkEnabled: client.enabled,
    teamworkTeamCapacity,
    twYmd,
  });
}

module.exports = {
  TW_WRITE_NAMES,
  createTeamworkTools,
  slimTwTask,
  twYmd,
};
