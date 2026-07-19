// Read the API key embedded by the server after Basic auth and include it as
    // Bearer on every fetch. If empty (dev mode without NORA_API_KEY), the server's
    // requireAuth middleware skips the check anyway, so this is no-op safe.
    const NORA_API_KEY = (document.querySelector('meta[name="nora-api-key"]') || {}).content || '';
    function api(path, opts) {
      opts = opts || {};
      const headers = Object.assign({}, opts.headers || {});
      if (NORA_API_KEY) headers['Authorization'] = 'Bearer ' + NORA_API_KEY;
      return fetch(path, Object.assign({}, opts, { headers: headers }));
    }

    const pageMeta = {
      live: ['Live', 'See Nora\'s hourly work, conversations, and background processes as they happen.'],
      meeting: ['Meeting', 'Send Nora into a call with the right context, mandate, and participation mode.'],
      tasks: ['Tasks', 'Review Nora\'s action queue, schedule follow-up work, and close completed items.'],
      projects: ['Projects', 'Manage the durable project context Nora uses across meetings, Slack, and scheduled work.'],
      transcripts: ['Transcripts', 'Review and correct the conversations Nora captured in meetings.'],
      memory: ['Memory', 'Search, maintain, and vectorize the facts Nora can recall.'],
      dreams: ['Dreams', 'Review nightly consolidation, reflection, and learning.'],
      markers: ['Markers', 'Inspect the operational records that prevent repeated work.'],
      routine: ['Routine', 'Edit the ordered work Nora performs during each scheduled session.'],
      charter: ['Charter', 'Define what Nora may decide, commit to, or escalate on your behalf.'],
      self: ['Self', 'Understand Nora\'s system state, continuity, wants, autobiography, and persona.'],
      intelligence: ['Intelligence', 'See what Nora is doing now, then open learning, self-model, research, or history only when you need it.'],
      admin: ['Administration', 'Monitor connections, bots, access controls, calendar automation, and sync health.']
    };

    let currentFilter = 'pending';

    function showTab(name) {
      if (!pageMeta[name]) name = 'meeting';
      document.querySelectorAll('.tab').forEach(t => {
        const active = t.dataset.tab === name;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-' + name).classList.add('active');
      document.getElementById('page-title').textContent = pageMeta[name][0];
      document.getElementById('page-description').textContent = pageMeta[name][1];
      document.title = pageMeta[name][0] + ' | Nora';
      history.replaceState(null, '', location.pathname + location.search + '#' + name);
      closeMobileNav();
      closeCommandPalette();
      if (name === 'memory') loadMemory();
      if (name === 'live') loadRuntimeActivity();
      if (name === 'tasks') loadTasks();
      if (name === 'projects') loadProjects();
      if (name === 'transcripts') loadTranscripts();
      if (name === 'dreams') loadDreams();
      if (name === 'markers') loadMarkers();
      if (name === 'routine') loadRoutineEditor();
      if (name === 'charter') loadCharterEditor();
      if (name === 'self') loadSelfTab();
      if (name === 'intelligence') loadIntelligence();
      else if (typeof suspendIntelligence === 'function') suspendIntelligence();
      if (name === 'admin') loadAdmin();
    }

    function toggleMobileNav() {
      const sidebar = document.querySelector('.sidebar');
      const button = document.querySelector('.nav-toggle');
      const open = sidebar.classList.toggle('nav-open');
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      button.textContent = open ? 'Close' : 'Menu';
    }

    function closeMobileNav() {
      const sidebar = document.querySelector('.sidebar');
      const button = document.querySelector('.nav-toggle');
      if (!sidebar || !button) return;
      sidebar.classList.remove('nav-open');
      button.setAttribute('aria-expanded', 'false');
      button.textContent = 'Menu';
    }

    function applyTheme(theme) {
      document.documentElement.dataset.theme = theme;
      localStorage.setItem('nora-theme', theme);
      const button = document.getElementById('theme-toggle');
      if (button) button.textContent = theme === 'dark' ? 'Light theme' : 'Dark theme';
    }

    function toggleTheme() {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    }

    function openCommandPalette() {
      const palette = document.getElementById('command-palette');
      palette.classList.add('open');
      palette.setAttribute('aria-hidden', 'false');
      const input = document.getElementById('command-input');
      input.value = '';
      renderCommandResults();
      input.focus();
    }

    function closeCommandPalette(event) {
      if (event && event.target !== document.getElementById('command-palette')) return;
      const palette = document.getElementById('command-palette');
      if (!palette) return;
      palette.classList.remove('open');
      palette.setAttribute('aria-hidden', 'true');
    }

    function renderCommandResults() {
      const query = document.getElementById('command-input').value.trim().toLowerCase();
      const matches = Object.entries(pageMeta).filter(([key, value]) => !query || key.includes(query) || value.join(' ').toLowerCase().includes(query));
      document.getElementById('command-results').innerHTML = matches.length
        ? matches.map(([key, value]) => `<button class="command-result" type="button" onclick="showTab('${key}')">${value[0]}</button>`).join('')
        : '<div class="command-empty">No matching view</div>';
    }
