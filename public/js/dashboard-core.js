// Read the API key embedded by the server after Basic auth and include it as
    // Bearer on every fetch. If empty (dev mode without NORA_API_KEY), the server's
    // requireAuth middleware skips the check anyway, so this is no-op safe.
    const NORA_API_KEY = (document.querySelector('meta[name="nora-api-key"]') || {}).content || '';
    const NORA_OPERATOR_TOKEN = (document.querySelector('meta[name="nora-operator-token"]') || {}).content || '';
    async function api(path, opts) {
      opts = opts || {};
      const headers = Object.assign({}, opts.headers || {});
      if (NORA_API_KEY) headers['Authorization'] = 'Bearer ' + NORA_API_KEY;
      const controller = new AbortController();
      const upstreamSignal = opts.signal;
      const abortFromUpstream = () => controller.abort(upstreamSignal.reason);
      if (upstreamSignal && upstreamSignal.aborted) abortFromUpstream();
      else if (upstreamSignal) upstreamSignal.addEventListener('abort', abortFromUpstream, { once: true });
      const timeoutMs = Math.max(1000, Math.min(120000, Number(opts.timeoutMs) || 30000));
      const timer = setTimeout(() => controller.abort(new DOMException('Dashboard request timed out', 'TimeoutError')), timeoutMs);
      const requestOptions = Object.assign({}, opts, { headers: headers, signal: controller.signal });
      delete requestOptions.timeoutMs;
      try { return await fetch(path, requestOptions); }
      finally {
        clearTimeout(timer);
        if (upstreamSignal) upstreamSignal.removeEventListener('abort', abortFromUpstream);
      }
    }
    function operatorApi(path, opts) {
      opts = opts || {};
      const headers = Object.assign({}, opts.headers || {});
      if (NORA_OPERATOR_TOKEN) headers['X-Nora-Operator-Token'] = NORA_OPERATOR_TOKEN;
      return api(path, Object.assign({}, opts, { headers: headers }));
    }

    // Browser polling must have the same ownership guarantees as Nora's server schedulers:
    // one active run, a full quiet interval after completion, and cancellation on stop.
    function createCompletionAwarePoller(options) {
      const intervalMs = Math.max(250, Number(options.intervalMs) || 1000);
      const initialDelayMs = options.initialDelayMs == null
        ? intervalMs : Math.max(0, Number(options.initialDelayMs) || 0);
      const shouldRun = options.shouldRun || (() => true);
      const onError = options.onError || (() => {});
      let timer = null;
      let controller = null;
      let stopped = true;

      const schedule = delayMs => {
        if (stopped || timer || controller) return;
        timer = setTimeout(run, Math.max(0, Number(delayMs) || 0));
      };
      const run = async () => {
        timer = null;
        if (stopped) return;
        if (!shouldRun()) {
          schedule(intervalMs);
          return;
        }
        controller = new AbortController();
        try {
          await options.work(controller.signal);
        } catch (error) {
          if (error?.name !== 'AbortError') onError(error);
        } finally {
          controller = null;
          schedule(intervalMs);
        }
      };
      return {
        start() {
          if (!stopped) return;
          stopped = false;
          schedule(initialDelayMs);
        },
        stop() {
          stopped = true;
          if (timer) clearTimeout(timer);
          timer = null;
          controller?.abort(new DOMException('Dashboard poll stopped', 'AbortError'));
        },
        trigger() {
          if (stopped) return;
          if (timer) clearTimeout(timer);
          timer = null;
          schedule(0);
        },
      };
    }

    const pageMeta = {
      live: ['Live', 'See Nora\'s hourly work, conversations, and background processes as they happen.'],
      meeting: ['Meeting', 'Send Nora into a call with the right context, mandate, and participation mode.'],
      tasks: ['Tasks', 'Review Nora\'s action queue, schedule follow-up work, and close completed items.'],
      projects: ['Portfolio', 'See what needs management now, what Nora knows, and why she is staying quiet or stepping in.'],
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
      if (name === 'meeting' && typeof checkMuteState === 'function') checkMuteState();
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
