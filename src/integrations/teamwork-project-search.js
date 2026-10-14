'use strict';

const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const terms = value => [...new Set(normalize(value).split(' ').filter(t => t && !['the', 'project', 'projects'].includes(t)))];

function rankProjects(projects, query) {
  const wanted = terms(query);
  return projects.map(project => {
    const name = terms(project.name), company = terms(project.company);
    const exact = normalize(project.name) === normalize(query);
    const hits = wanted.filter(t => name.includes(t) || company.includes(t)).length;
    return { project, exact, score: exact ? 10000 : hits * 10
      + wanted.filter(t => company.includes(t)).length * 3 + wanted.filter(t => name.includes(t)).length };
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.project.name.localeCompare(b.project.name));
}

function createProjectSearchTool({ get, baseUrl = () => process.env.TEAMWORK_BASE_URL, now = Date.now }) {
  return {
    definition: {
      name: 'teamwork_find_projects',
      description: 'Find active Teamwork projects by name or client. Automatically broadens an unsuccessful exact-name search to a bounded live directory and returns up to 3 ranked suggestions. Show the returned real names/client/link and ask which one when requires_confirmation=true; never silently select a suggestion or ask the user to hunt for an exact name. If none are plausible, ask for a client, keyword or project link. Omit query to list active projects. Check search_complete before claiming there are no matches.',
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Requested project/client name; omit to list active projects.' } } },
    },
    execute: async ({ query } = {}, request = {}) => {
      query = String(query || '').trim();
      const deadline = now() + Math.min(request.timeoutMs || 8000, 8000);
      const projects = new Map();
      let complete = false, unavailable = false;
      const read = async (page, search = '') => {
        request.signal?.throwIfAborted();
        const remaining = deadline - now();
        if (remaining <= 0) throw new Error('Project lookup budget exhausted');
        const data = await get(`/projects/api/v3/projects.json?status=ACTIVE&pageSize=100&include=companies&page=${page}${search ? `&searchTerm=${encodeURIComponent(search)}` : ''}`,
          { ...request, timeoutMs: remaining });
        if (!Array.isArray(data?.projects)) throw new Error('Project lookup returned no project collection');
        for (const p of data.projects) {
          if (String(p.status).toLowerCase() !== 'active') continue;
          projects.set(String(p.id), { id: p.id, name: p.name, status: p.status,
            company: data.included?.companies?.[p.company?.id]?.name || p.company?.name || '',
            url: `${String(baseUrl() || '').replace(/\/$/, '')}/app/projects/${p.id}` });
        }
        return data.meta?.page?.hasMore ?? data.projects.length >= 100;
      };
      try {
        // Provider name search cannot join a client's full name to an abbreviated project title.
        // Resolve that in one tool call, so Slack's small tool budget still leaves room for intake.
        if (query) {
          const more = await read(1, query);
          const exact = rankProjects([...projects.values()], query).filter(p => p.exact);
          if (exact.length && !more) return { projects: exact.map(p => p.project), match_type: 'exact',
            requires_confirmation: exact.length !== 1, search_complete: true };
        }
        for (let page = 1; page <= 5; page++) {
          if (!await read(page)) { complete = true; break; }
        }
      } catch (error) {
        if (request.signal?.aborted) throw error;
        unavailable = true;
      }
      const ranked = query ? rankProjects([...projects.values()], query) : [];
      const exact = ranked.filter(p => p.exact);
      const matches = query ? (exact.length ? exact : ranked.slice(0, 3)).map(p => p.project) : [...projects.values()];
      return { projects: matches, match_type: query ? (exact.length ? 'exact' : 'suggestions') : 'directory',
        requires_confirmation: !!query && (!exact.length || exact.length !== 1 || !complete), search_complete: complete,
        ...(unavailable ? { warning: 'Project lookup was interrupted or unavailable. Results may be incomplete; do not claim no matching project exists.' }
          : !complete ? { warning: 'Bounded directory scan is incomplete. Ask for a narrower client/keyword/link if these suggestions do not fit.' } : {}),
      };
    },
  };
}

module.exports = { createProjectSearchTool, rankProjects };
