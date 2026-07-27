'use strict';

const axios = require('axios');

// Is this project the agency's own work rather than a client engagement?
//
// The client field carries a Teamwork-style code suffix, so every internal project reads
// "LimeLight Marketing (LL)". The previous check compared for exact equality against
// "limelight marketing", which that value never matches, so all fifteen internal projects sailed
// through the exclusion. They also score as the thinnest projects in the portfolio, because nobody
// writes client research about internal billing buckets, which put them at the very top of the
// "most in need first" sort and handed the idle-research loop the same dead ends every run.
//
// Parentheticals are stripped rather than special-cased so a renamed code, a trailing "LLC", or
// stray whitespace cannot quietly reopen the same hole.
function isLimeLightInternalClient(client) {
  const normalized = String(client || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return normalized === 'limelight' || normalized.startsWith('limelight marketing');
}

function registerProjectRoutes(app, deps) {
  const { requireAuth, loadProjects, saveProjects, loadMemory } = deps;

  // Projects API — manage project knowledge bases
  app.get('/projects', requireAuth, (req, res) => res.json(loadProjects()));

  // Compute the coverage row for a single project — shared by /projects/:name/coverage
  // and the bulk /projects/coverage endpoint that drives idle-time research.
  function computeProjectCoverage(project, allMemories) {
    const projectMemories = allMemories.filter(m =>
      m.project && m.project.toLowerCase() === project.name.toLowerCase()
    );
    const last_memory_at = projectMemories.reduce(
      (max, m) => (m.added && m.added > max) ? m.added : max, ''
    );
    const detailsLen = (project.details || '').length;
    const days_since_last_memory = last_memory_at
      ? Math.floor((Date.now() - new Date(last_memory_at).getTime()) / 86400000)
      : null;
    const days_since_last_research = project.last_research_at
      ? Math.floor((Date.now() - new Date(project.last_research_at).getTime()) / 86400000)
      : null;
    const thinness =
      Math.min(projectMemories.length, 20) * 5 +
      Math.min(detailsLen, 1000) / 50 +
      (project.client ? 5 : 0) +
      (project.status ? 5 : 0) +
      (project.pm ? 5 : 0);
    return {
      name: project.name,
      status: project.status || null,
      memory_count: projectMemories.length,
      last_memory_at,
      days_since_last_memory,
      details_length: detailsLen,
      last_activity: project.last_activity || null,
      updated: project.updated || null,
      last_research_at: project.last_research_at || null,
      days_since_last_research,
      auto_created: !!project.auto_created,
      has_client: !!project.client,
      has_status: !!project.status,
      has_pm: !!project.pm,
      has_phase: !!project.phase,
      thinness_score: Math.round(thinness)
    };
  }

  // Bulk coverage view — drives the cowork idle-time research loop.
  // Sorted "most in need first": never-researched bubbles up, then thinness, then oldest research.
  // By default skips archived/wrapped/completed projects, "Opportunity - " sales pipeline projects,
  // and LimeLight-internal projects (the agency's own work, not client work) since those don't
  // benefit from proactive research focused on client engagements.
  app.get('/projects/coverage', requireAuth, (req, res) => {
    const limit = parseInt(req.query.limit || '20', 10);
    const includeArchived = req.query.include_archived === 'true';
    const includeOpportunities = req.query.include_opportunities === 'true';
    const includeInternal = req.query.include_internal === 'true';
    const cooldownDays = parseInt(req.query.cooldown_days || '1', 10);

    const projects = loadProjects();
    const memory = loadMemory();
    const cooldownMs = cooldownDays * 86400000;

    let rows = projects.map(p => computeProjectCoverage(p, memory));

    if (!includeArchived) {
      rows = rows.filter(r => {
        const s = (r.status || '').toLowerCase();
        return !['archived', 'wrapped', 'completed', 'done'].includes(s);
      });
    }
    if (!includeOpportunities) {
      rows = rows.filter(r => !r.name.toLowerCase().startsWith('opportunity - '));
    }
    if (!includeInternal) {
      // Detect LimeLight-internal projects by name prefix or client field. Two heuristics because
      // some internal projects use the "LimeLight ..." name convention while others carry the
      // agency in the client field under names like "LLM - T&M Billing".
      const byName = new Map(projects.map(project => [project.name, project]));
      rows = rows.filter(r => {
        const name = r.name.toLowerCase();
        if (name.startsWith('limelight ') || name === 'limelight') return false;
        return !isLimeLightInternalClient(byName.get(r.name)?.client);
      });
    }

    // Filter out projects researched within the cooldown window — prevents same-project
    // re-pick on the next hourly run after the cowork loop touches it.
    rows = rows.filter(r => {
      if (!r.last_research_at) return true; // never researched, fair game
      return (Date.now() - new Date(r.last_research_at).getTime()) > cooldownMs;
    });

    // Sort: never-researched first, then thinnest, then oldest research date as tiebreaker
    rows.sort((a, b) => {
      if (!a.last_research_at && b.last_research_at) return -1;
      if (a.last_research_at && !b.last_research_at) return 1;
      if (a.thinness_score !== b.thinness_score) return a.thinness_score - b.thinness_score;
      return (a.last_research_at || '').localeCompare(b.last_research_at || '');
    });

    res.json({
      count: rows.length,
      cooldown_days: cooldownDays,
      projects: rows.slice(0, limit)
    });
  });

  app.get('/projects/:name', requireAuth, (req, res) => {
    const projects = loadProjects();
    const project = projects.find(p => p.name.toLowerCase() === req.params.name.toLowerCase());
    if (!project) return res.status(404).json({ error: 'Project not found' });
    // Include project-specific memories
    const memory = loadMemory();
    const projectMemories = memory.filter(m => m.project && m.project.toLowerCase() === req.params.name.toLowerCase());
    // Summary: most recent memory date, count
    const memory_count = projectMemories.length;
    const last_memory_at = projectMemories.reduce((max, m) => (m.added && m.added > max) ? m.added : max, '');
    res.json({ ...project, memory_count, last_memory_at, memories: projectMemories });
  });

  // Coverage view — used by the cowork loop to identify projects needing more research.
  // Returns metrics that help rank "thin" or "stale" projects without pulling all memories.
  app.get('/projects/:name/coverage', requireAuth, (req, res) => {
    const projects = loadProjects();
    const project = projects.find(p => p.name.toLowerCase() === req.params.name.toLowerCase());
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(computeProjectCoverage(project, loadMemory()));
  });

  // Mark a project as researched. Cowork calls this after completing an idle-research round
  // so the same project doesn't get re-picked on the next hourly run.
  // Optionally accepts a free-text "summary" describing what was found / where, stored on
  // the project for context.
  app.post('/projects/:name/research-touch', requireAuth, (req, res) => {
    const projects = loadProjects();
    const idx = projects.findIndex(p => p.name.toLowerCase() === req.params.name.toLowerCase());
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });
    projects[idx].last_research_at = new Date().toISOString();
    if (req.body && typeof req.body.summary === 'string') {
      projects[idx].last_research_summary = req.body.summary;
    }
    saveProjects(projects);
    console.log('🔬 Project research-touched:', projects[idx].name);
    res.json({ ok: true, project: projects[idx] });
  });

  // Sync Nora's /projects store from Teamwork. Pulls active Teamwork projects, filters out
  // archived/opportunity/LimeLight-internal, and reconciles against the local store:
  //   - Missing Teamwork projects → created in /projects with metadata from TW
  //   - Auto-created stubs that match a TW project → promoted with TW metadata (clears auto_created)
  //   - Existing curated records → left alone (don't overwrite manual edits)
  //
  // Replaces the multi-step MCP workflow that was in the cowork prompt's Idle Knowledge Round.
  // Server-side gives us: one HTTP call from cowork, structured error reporting, and reliable
  // idempotent execution that doesn't depend on cowork honoring a multi-step procedure.
  //
  // Body (optional): { "dry_run": true } to see what would change without applying.
  app.post('/projects/sync-from-teamwork', requireAuth, async (req, res) => {
    const twKey = process.env.TEAMWORK_API_KEY;
    const twBase = process.env.TEAMWORK_BASE_URL;
    if (!twKey || !twBase) {
      return res.status(500).json({ error: 'TEAMWORK_API_KEY and TEAMWORK_BASE_URL must be set' });
    }
    const dryRun = !!(req.body && req.body.dry_run === true);

    const twAuth = 'Basic ' + Buffer.from(`${twKey}:`).toString('base64');
    const twHeaders = { Authorization: twAuth, 'Content-Type': 'application/json' };

    try {
      // Pull active Teamwork projects with pagination. v3 endpoint returns up to 50 by default;
      // we ask for the larger pageSize. status=ACTIVE filters out archived/completed.
      const twProjects = [];
      let page = 1;
      const pageSize = 250;
      let hasMore = true;
      let pagesFetched = 0;
      const MAX_PAGES = 20; // safety cap (~5000 projects)
      const syncDeadlineAt = Date.now() + 30000;
      while (hasMore && pagesFetched < MAX_PAGES) {
        const remainingMs = syncDeadlineAt - Date.now();
        if (remainingMs <= 0) throw new Error('Teamwork project sync exceeded 30s total deadline');
        const url = `${twBase}/projects/api/v3/projects.json?status=ACTIVE&pageSize=${pageSize}&page=${page}&include=companies`;
        const r = await axios.get(url, { headers: twHeaders, timeout: Math.min(8000, remainingMs) });
        const projects = r.data?.projects || [];
        const companies = r.data?.included?.companies || {};
        for (const p of projects) {
          // Resolve company name from the included sideload
          const companyId = p.company?.id || p.companyId;
          const companyName = companyId && companies[companyId]?.name || p.company?.name || '';
          twProjects.push({
            id: p.id || null,
            name: (p.name || '').trim(),
            description: p.description || '',
            company: companyName
          });
        }
        hasMore = projects.length === pageSize;
        page++;
        pagesFetched++;
      }

      // Filter out the categories Nora doesn't research:
      //   - "Opportunity - " sales pipeline
      //   - LimeLight-internal (name prefix or company = LimeLight)
      const filtered = twProjects.filter(p => {
        const name = (p.name || '').toLowerCase();
        if (!name) return false;
        if (name.startsWith('opportunity - ')) return false;
        if (name.startsWith('limelight ') || name === 'limelight') return false;
        const company = (p.company || '').toLowerCase().trim();
        if (company === 'limelight' || company === 'limelight marketing') return false;
        return true;
      });

      // Reconcile against the local store
      const existing = loadProjects();
      const now = new Date().toISOString();
      let created = 0;
      let promoted = 0;
      let unchanged = 0;
      let idBackfilled = 0;
      const createdNames = [];
      const promotedNames = [];

      for (const tw of filtered) {
        const lcName = tw.name.toLowerCase();
        const existingIdx = existing.findIndex(p => p.name.toLowerCase() === lcName);

        if (existingIdx === -1) {
          // Missing — create a new record
          if (!dryRun) {
            existing.push({
              name: tw.name,
              details: tw.description || '',
              client: tw.company || '',
              status: 'active',
              created: now,
              last_activity: now,
              teamwork_id: tw.id || null
            });
          }
          created++;
          createdNames.push(tw.name);
        } else {
          const proj = existing[existingIdx];
          if (proj.auto_created) {
            // Stub created by a memory reference — promote with TW metadata
            if (!dryRun) {
              if (!proj.client && tw.company) proj.client = tw.company;
              if (!proj.status) proj.status = 'active';
              if (!proj.details && tw.description) proj.details = tw.description;
              if (!proj.teamwork_id && tw.id) proj.teamwork_id = tw.id;
              proj.updated = now;
              delete proj.auto_created;
            }
            promoted++;
            promotedNames.push(tw.name);
          } else {
            // Curated record — leave manual edits alone, but backfill teamwork_id if missing.
            // The TW ID is an objective fact, not subjective metadata, so this is safe to set
            // without overwriting anything the user touched. Useful when the Teamwork MCP is
            // unhealthy and Nora needs the project ID some other way.
            if (!dryRun && !proj.teamwork_id && tw.id) {
              proj.teamwork_id = tw.id;
              idBackfilled++;
            }
            unchanged++;
          }
        }
      }

      if (!dryRun && (created > 0 || promoted > 0 || idBackfilled > 0)) {
        saveProjects(existing);
        console.log(`📁 Sync from Teamwork: created ${created}, promoted ${promoted}, id_backfilled ${idBackfilled}, unchanged ${unchanged}`);
      }

      res.json({
        ok: true,
        dry_run: dryRun,
        teamwork_total: twProjects.length,
        after_filter: filtered.length,
        pages_fetched: pagesFetched,
        created,
        promoted,
        id_backfilled: idBackfilled,
        unchanged,
        created_names: createdNames.slice(0, 20),
        promoted_names: promotedNames.slice(0, 20)
      });
    } catch (err) {
      console.error('sync-from-teamwork error:', err.response?.data || err.message);
      res.status(500).json({
        error: err.response?.data?.message || err.message,
        details: err.response?.data || null
      });
    }
  });

  app.post('/projects', requireAuth, (req, res) => {
    const { name, details, client, status, pm, phase, tags } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const projects = loadProjects();
    const existing = projects.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Project already exists', project: existing });
    const project = {
      name,
      details: details || '',
      created: new Date().toISOString()
    };
    if (client !== undefined) project.client = client;
    if (status !== undefined) project.status = status;
    if (pm !== undefined) project.pm = pm;
    if (phase !== undefined) project.phase = phase;
    if (tags !== undefined) project.tags = Array.isArray(tags) ? tags : [];
    projects.push(project);
    saveProjects(projects);
    console.log('📁 Project added:', name);
    res.json({ ok: true, project });
  });

  app.put('/projects/:name', requireAuth, (req, res) => {
    const projects = loadProjects();
    const idx = projects.findIndex(p => p.name.toLowerCase() === req.params.name.toLowerCase());
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });
    const { name, details, client, status, pm, phase, tags } = req.body;
    if (name) projects[idx].name = name;
    if (details !== undefined) projects[idx].details = details;
    if (client !== undefined) projects[idx].client = client;
    if (status !== undefined) projects[idx].status = status;
    if (pm !== undefined) projects[idx].pm = pm;
    if (phase !== undefined) projects[idx].phase = phase;
    if (tags !== undefined) projects[idx].tags = Array.isArray(tags) ? tags : [];
    projects[idx].updated = new Date().toISOString();
    // Promoting a stub to a curated record clears the auto_created flag
    if (projects[idx].auto_created && (details || client || status || pm || phase)) {
      delete projects[idx].auto_created;
    }
    saveProjects(projects);
    console.log('📁 Project updated:', projects[idx].name);
    res.json({ ok: true, project: projects[idx] });
  });

  app.delete('/projects/:name', requireAuth, (req, res) => {
    const projects = loadProjects();
    const idx = projects.findIndex(p => p.name.toLowerCase() === req.params.name.toLowerCase());
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });
    const removed = projects.splice(idx, 1);
    saveProjects(projects);
    console.log('📁 Project deleted:', removed[0].name);
    res.json({ ok: true });
  });
}

module.exports = { registerProjectRoutes, isLimeLightInternalClient };
