'use strict';

function registerProjectRoutes(app, deps) {
  const { requireAuth, loadProjects, saveProjects } = deps;

  app.get('/projects', requireAuth, (_req, res) => res.json(loadProjects()));

  app.get('/projects/:name', requireAuth, (req, res) => {
    const project = loadProjects()
      .find(item => item.name.toLowerCase() === req.params.name.toLowerCase());
    if (!project) return res.status(404).json({ error: 'Project not found' });
    return res.json(project);
  });

  app.post('/projects', requireAuth, (req, res) => {
    const { name, details, client, status, pm, phase, tags, teamwork_id } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const projects = loadProjects();
    const existing = projects.find(item => item.name.toLowerCase() === name.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Project already exists', project: existing });
    const project = { name, details: details || '', created: new Date().toISOString() };
    if (client !== undefined) project.client = client;
    if (status !== undefined) project.status = status;
    if (pm !== undefined) project.pm = pm;
    if (phase !== undefined) project.phase = phase;
    if (tags !== undefined) project.tags = Array.isArray(tags) ? tags : [];
    if (teamwork_id !== undefined) project.teamwork_id = String(teamwork_id || '').trim() || null;
    projects.push(project);
    saveProjects(projects);
    return res.json({ ok: true, project });
  });

  app.put('/projects/:name', requireAuth, (req, res) => {
    const projects = loadProjects();
    const index = projects.findIndex(item =>
      item.name.toLowerCase() === req.params.name.toLowerCase());
    if (index === -1) return res.status(404).json({ error: 'Project not found' });
    const { name, details, client, status, pm, phase, tags, teamwork_id } = req.body;
    if (name) projects[index].name = name;
    if (details !== undefined) projects[index].details = details;
    if (client !== undefined) projects[index].client = client;
    if (status !== undefined) projects[index].status = status;
    if (pm !== undefined) projects[index].pm = pm;
    if (phase !== undefined) projects[index].phase = phase;
    if (tags !== undefined) projects[index].tags = Array.isArray(tags) ? tags : [];
    if (teamwork_id !== undefined) {
      projects[index].teamwork_id = String(teamwork_id || '').trim() || null;
    }
    projects[index].updated = new Date().toISOString();
    if (projects[index].auto_created && (details || client || status || pm || phase)) {
      delete projects[index].auto_created;
    }
    saveProjects(projects);
    return res.json({ ok: true, project: projects[index] });
  });

  app.delete('/projects/:name', requireAuth, (req, res) => {
    const projects = loadProjects();
    const index = projects.findIndex(item =>
      item.name.toLowerCase() === req.params.name.toLowerCase());
    if (index === -1) return res.status(404).json({ error: 'Project not found' });
    projects.splice(index, 1);
    saveProjects(projects);
    return res.json({ ok: true });
  });
}

module.exports = { registerProjectRoutes };
