let intelligenceSectionObserver = null;
let intelligenceAbortController = null;
let intelligenceLoadToken = 0;
let playroomPollTimer = null;
let playroomLastBoard = null;
let readingRoomPollTimer = null;
let activeIntelligenceView = 'overview';
const intelligenceLoadedSections = new Set();
const intelligenceSectionPromises = new Map();

const intelligenceViews = Object.freeze({
  overview: { title: 'Nora right now',
    description: 'The few signals that explain her current state and activity.', sections: [] },
  learning: { title: 'Learning and stimulation',
    description: 'Books, play, and the functional state shaping what Nora notices and practices.',
    sections: ['epistemic-agenda', 'reading-room', 'playroom', 'cognition'] },
  self: { title: 'Self and behavior',
    description: 'What Nora claims about herself and whether those claims predict observable behavior.',
    sections: ['self-model', 'attention', 'agency', 'interoception', 'experience'] },
  research: { title: 'Research evidence',
    description: 'Blinded studies, boundary tests, falsifiers, and integrity receipts.',
    sections: ['research', 'boundary'] },
  history: { title: 'History and follow-through',
    description: 'Promises, cycles, relationships, experiments, and recent decisions over time.',
    sections: ['orientation', 'commitments', 'episodes', 'relationships', 'experiments', 'traces'] },
});
const intelligenceSectionViews = Object.fromEntries(Object.entries(intelligenceViews)
  .flatMap(([view, config]) => config.sections.map(section => [section, view])));

const intelligenceSectionTargets = {
  cognition: ['cognition-state'], 'epistemic-agenda': ['epistemic-agenda-state'], 'reading-room': ['reading-room-state'], playroom: ['playroom-state'], research: ['consciousness-research-state'], 'self-model': ['self-model-state'],
  boundary: ['self-boundary-state'], attention: ['attention-schema-state'], agency: ['agency-state'],
  interoception: ['interoception-state'], experience: ['experience-stream-state'],
  orientation: ['orientation-list', 'cycle-list'], commitments: ['commitment-list'], episodes: ['episode-list'],
  relationships: ['relationship-list'], experiments: ['experiment-list'], traces: ['trace-list'],
};

async function intelligenceJson(path, signal) {
  const response = await api(path, { signal });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

function setIntelligenceView(name, { load = true } = {}) {
  const view = intelligenceViews[name] ? name : 'overview';
  activeIntelligenceView = view;
  const page = document.getElementById('page-intelligence');
  if (!page) return;
  page.dataset.activeView = view;
  page.querySelectorAll('[data-intelligence-view-button]').forEach(button => {
    const active = button.dataset.intelligenceViewButton === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  const title = document.getElementById('intelligence-view-title');
  const description = document.getElementById('intelligence-view-description');
  if (title) title.textContent = intelligenceViews[view].title;
  if (description) description.textContent = intelligenceViews[view].description;
  if (load && page.classList.contains('active')) {
    intelligenceViews[view].sections.forEach(section =>
      loadIntelligenceSection(section, intelligenceLoadToken));
  }
}

function resetIntelligenceSection(name) {
  const section = document.querySelector(`[data-intelligence-section="${name}"]`);
  if (section) section.setAttribute('aria-busy', 'false');
  (intelligenceSectionTargets[name] || []).forEach((id, index) => {
    const target = document.getElementById(id);
    if (!target) return;
    if (name === 'reading-room' && index === 0) {
      target.innerHTML = `<div class="reading-room-loading" aria-hidden="true"><div class="reading-room-loading-book"></div><div class="reading-room-loading-notes"></div></div><span class="sr-only">Loading Nora's developmental reading record.</span>`;
      return;
    }
    if (name === 'playroom' && index === 0) {
      target.innerHTML = `<div class="playroom-loading" aria-hidden="true"><div class="playroom-loading-board"></div><div class="playroom-loading-copy"></div></div><span class="sr-only">Loading Nora's playroom experiment.</span>`;
      return;
    }
    target.innerHTML = index === 0 ? `<div class="intelligence-loading-state">
      <span>Details load when this section approaches the viewport.</span>
      <button class="btn btn-sm" type="button" onclick="loadIntelligenceSection('${name}', intelligenceLoadToken)">Load now</button>
    </div>` : '';
  });
  if (name === 'playroom') {
    const live = document.getElementById('playroom-live-state');
    if (live) live.textContent = 'Loading experiment';
  }
  if (name === 'reading-room') {
    const live = document.getElementById('reading-room-live-state');
    if (live) live.textContent = 'Loading library';
  }
}

function markIntelligenceSectionReady(name) {
  const section = document.querySelector(`[data-intelligence-section="${name}"]`);
  if (section) section.setAttribute('aria-busy', 'false');
}

function markIntelligenceSectionError(name) {
  const target = document.getElementById((intelligenceSectionTargets[name] || [])[0]);
  if (target) target.innerHTML = `<div class="intelligence-load-error">This section could not load.
    <button class="btn btn-sm" type="button" onclick="retryIntelligenceSection('${name}')">Retry</button></div>`;
  markIntelligenceSectionReady(name);
}

function retryIntelligenceSection(name) {
  intelligenceLoadedSections.delete(name);
  intelligenceSectionPromises.delete(name);
  resetIntelligenceSection(name);
  loadIntelligenceSection(name, intelligenceLoadToken);
}

async function loadIntelligence() {
  suspendIntelligence();
  const token = ++intelligenceLoadToken;
  intelligenceAbortController = new AbortController();
  intelligenceLoadedSections.clear();
  intelligenceSectionPromises.clear();
  Object.keys(intelligenceSectionTargets).forEach(resetIntelligenceSection);
  document.getElementById('intelligence-stats').innerHTML = '<div class="intelligence-loading-state"><span>Loading Nora\'s current functional state.</span></div>';
  document.getElementById('bench-status').textContent = 'Evaluation status loading independently.';
  document.getElementById('brain-stage')?.classList.add('brain-loading');
  setIntelligenceView(activeIntelligenceView, { load: false });

  try {
    const summary = await intelligenceJson('/intelligence/dashboard-summary', intelligenceAbortController.signal);
    if (token !== intelligenceLoadToken) return;
    const overview = summary.overview || {};
    document.getElementById('intelligence-stats').innerHTML = [
      ['Open promises', overview.commitments?.open || 0],
      ['Active experiments', overview.experiments?.active || 0],
      ['Experience moments', overview.experience_moments || 0],
      ['People learned', overview.relationships || 0],
    ].map(([label, value]) => `<div class="intelligence-stat"><strong>${value}</strong><span>${label}</span></div>`).join('');
    renderIntelligenceGlance(summary);
    renderNoraBrain({ dashboard: summary });
    renderCognitionSummary(summary.cognition || {});
    intelligenceLoadedSections.add('cognition');
    markIntelligenceSectionReady('cognition');
    observeIntelligenceSections(token);
    loadIntelligenceBench(token);
  } catch (error) {
    if (error.name === 'AbortError') return;
    document.getElementById('intelligence-stats').innerHTML = '<div class="error">Could not load intelligence state.</div>';
    renderNoraBrainError();
  }
}

function openIntelligenceSection(name) {
  if (!intelligenceSectionTargets[name]) return;
  showTab('intelligence');
  setIntelligenceView(intelligenceSectionViews[name] || 'overview', { load: false });
  const token = intelligenceLoadToken;
  requestAnimationFrame(() => {
    const section = document.querySelector(`[data-intelligence-section="${name}"]`);
    if (!section) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    section.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    loadIntelligenceSection(name, token);
  });
}

async function loadIntelligenceBench(token) {
  try {
    const bench = await intelligenceJson('/nora-bench', intelligenceAbortController?.signal);
    if (token !== intelligenceLoadToken) return;
    document.getElementById('bench-status').innerHTML = `<strong>Nora Bench: ${bench.passed}/${bench.total} passing</strong> &middot; meeting judgment, uncertainty, repair, and initiative policies`;
  } catch (error) {
    if (error.name !== 'AbortError' && token === intelligenceLoadToken) document.getElementById('bench-status').textContent = 'Evaluation status is temporarily unavailable.';
  }
}

function observeIntelligenceSections(token) {
  if (!('IntersectionObserver' in window)) {
    intelligenceViews[activeIntelligenceView].sections
      .filter(name => name !== 'cognition').forEach(name => loadIntelligenceSection(name, token));
    return;
  }
  intelligenceSectionObserver = new IntersectionObserver(entries => {
    entries.filter(entry => entry.isIntersecting).forEach(entry => {
      intelligenceSectionObserver.unobserve(entry.target);
      loadIntelligenceSection(entry.target.dataset.intelligenceSection, token);
    });
  }, { rootMargin: '240px 0px', threshold: 0.01 });
  document.querySelectorAll(`#page-intelligence > [data-intelligence-view="${activeIntelligenceView}"][data-intelligence-section]`)
    .forEach(section => {
      if (section.dataset.intelligenceSection !== 'cognition') intelligenceSectionObserver.observe(section);
    });
}

async function loadIntelligenceSection(name, token = intelligenceLoadToken) {
  if (token !== intelligenceLoadToken || intelligenceLoadedSections.has(name)) return;
  if (intelligenceSectionPromises.has(name)) return intelligenceSectionPromises.get(name);
  const section = document.querySelector(`[data-intelligence-section="${name}"]`);
  if (section) section.setAttribute('aria-busy', 'true');
  const signal = intelligenceAbortController?.signal;
  const promise = (async () => {
    try {
      if (name === 'research') {
        const [research, ledger] = await Promise.all([
          intelligenceJson('/consciousness-research/status', signal),
          intelligenceJson('/consciousness-research/ledger?summary=1', signal),
        ]);
        if (token === intelligenceLoadToken) renderConsciousnessResearch(research, ledger);
      } else if (name === 'reading-room') {
        const value = await intelligenceJson('/developmental-reading?limit=8', signal);
        if (token === intelligenceLoadToken) renderReadingRoom(value);
      } else if (name === 'epistemic-agenda') {
        const value = await intelligenceJson('/epistemic-agenda', signal);
        if (token === intelligenceLoadToken) renderEpistemicAgenda(value);
      } else if (name === 'playroom') {
        const value = await intelligenceJson('/playroom', signal);
        if (token === intelligenceLoadToken) renderPlayroom(value);
      } else if (name === 'self-model') {
        const [model, proposals] = await Promise.all([
          intelligenceJson('/self-model?allow_stale=1', signal),
          intelligenceJson('/self-model/claim-proposals', signal),
        ]);
        if (token === intelligenceLoadToken) renderSelfModel(model, proposals);
      } else if (name === 'boundary') {
        const values = await Promise.all([
          intelligenceJson('/self-boundary/challenges', signal), intelligenceJson('/source-boundary/challenges', signal),
          intelligenceJson('/authorship-boundary/challenges', signal), intelligenceJson('/authorship-boundary/studies', signal),
        ]);
        if (token === intelligenceLoadToken) renderSelfBoundary(...values);
      } else if (name === 'attention') {
        const value = await intelligenceJson('/attention-schema', signal);
        if (token === intelligenceLoadToken) renderAttentionSchema(value);
      } else if (name === 'agency') {
        const values = await Promise.all([intelligenceJson('/agency', signal), intelligenceJson('/counterfactual-agency/experiments', signal)]);
        if (token === intelligenceLoadToken) renderAgency(...values);
      } else if (name === 'interoception') {
        const value = await intelligenceJson('/interoception', signal);
        if (token === intelligenceLoadToken) renderInteroception(value);
      } else if (name === 'experience') {
        const values = await Promise.all([intelligenceJson('/experience-stream?limit=6', signal), intelligenceJson('/continuity-handoffs?summary=1', signal)]);
        if (token === intelligenceLoadToken) renderExperienceStream(...values);
      } else if (name === 'orientation') {
        const values = await Promise.all([intelligenceJson('/intelligence/orient', signal), intelligenceJson('/intelligence/cycles?limit=4', signal)]);
        if (token === intelligenceLoadToken) renderOrientation(...values);
      } else if (name === 'commitments') {
        const value = await intelligenceJson('/commitments?status=open', signal);
        if (token === intelligenceLoadToken) renderCommitments(value);
      } else if (name === 'episodes') {
        const value = await intelligenceJson('/episodes?limit=6', signal);
        if (token === intelligenceLoadToken) renderEpisodes(value);
      } else if (name === 'relationships') {
        const value = await intelligenceJson('/relationships', signal);
        if (token === intelligenceLoadToken) renderRelationships(value);
      } else if (name === 'experiments') {
        const value = await intelligenceJson('/learning-experiments', signal);
        if (token === intelligenceLoadToken) renderExperiments(value);
      } else if (name === 'traces') {
        const value = await intelligenceJson('/decision-traces?limit=12', signal);
        if (token === intelligenceLoadToken) renderDecisionTraces(value);
      }
      if (token !== intelligenceLoadToken) return;
      intelligenceLoadedSections.add(name);
      markIntelligenceSectionReady(name);
    } catch (error) {
      if (error.name !== 'AbortError' && token === intelligenceLoadToken) {
        if (name === 'reading-room') renderReadingRoomError();
        else if (name === 'playroom') renderPlayroomError();
        else markIntelligenceSectionError(name);
      }
    } finally {
      intelligenceSectionPromises.delete(name);
    }
  })();
  intelligenceSectionPromises.set(name, promise);
  return promise;
}

function suspendIntelligence() {
  if (intelligenceSectionObserver) intelligenceSectionObserver.disconnect();
  intelligenceSectionObserver = null;
  if (intelligenceAbortController) intelligenceAbortController.abort();
  intelligenceAbortController = null;
  stopReadingRoomPolling();
  stopPlayroomPolling();
  if (typeof stopNoraBrainAnimation === 'function') stopNoraBrainAnimation();
}

function stopReadingRoomPolling() {
  if (readingRoomPollTimer) clearInterval(readingRoomPollTimer);
  readingRoomPollTimer = null;
}

function startReadingRoomPolling() {
  stopReadingRoomPolling();
  readingRoomPollTimer = setInterval(async () => {
    if (document.visibilityState !== 'visible' || !document.getElementById('page-intelligence')?.classList.contains('active')) return;
    try { renderReadingRoom(await intelligenceJson('/developmental-reading?limit=8', intelligenceAbortController?.signal)); }
    catch (error) { if (error.name !== 'AbortError') renderReadingRoomError(); }
  }, 60000);
}

function readingRoomDate(value) {
  if (!value) return 'date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'date unavailable' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function readingRoomStatus(availability = {}) {
  const labels = {
    reading: 'Reading now', sealed: 'Sealed by active study', paused: 'Work has priority',
    empty: 'Library awaiting a source', between_encounters: 'Between books',
  };
  const label = labels[availability.state] || String(availability.state || 'Library ready').replaceAll('_', ' ');
  return availability.influence_access?.state === 'sealed' && availability.state !== 'sealed'
    ? `${label} · influence sealed` : label;
}

function renderEpistemicAgenda(value = {}) {
  const target = document.getElementById('epistemic-agenda-state');
  if (!target) return;
  const questions = value.questions || [];
  const open = questions.filter(item => item.status === 'open');
  const access = value.report?.natural_access || {};
  const ordered = [...open, ...questions.filter(item => item.status !== 'open').slice(-3).reverse()];
  if (!ordered.length) {
    target.innerHTML = `<div class="epistemic-agenda-empty"><strong>No question has earned a place yet.</strong>
      <p>Nora checks recent work in the background and will form one only when distinct evidence creates a real, useful gap.</p></div>`;
    return;
  }
  target.innerHTML = `<div class="epistemic-agenda-summary">
      <span><strong>${value.report?.open || 0}</strong> open</span>
      <span><strong>${value.report?.prompt_eligible || 0}</strong> eligible for work</span>
      <span><strong>${value.report?.held_for_durable_revision || 0}</strong> held for revision</span>
      <span><strong>${value.report?.resolved || 0}</strong> resolved</span>
      <span><strong>${value.report?.replay_verified_attempts || 0}</strong> replay-verified turns</span>
      <span><strong>${access.replay_verified_applications || 0}</strong> relevant work exposures</span>
    </div>
    <div class="epistemic-agenda-list">${ordered.map(item => {
    const latest = item.history?.at(-1);
    const accessState = item.prompt_access?.eligible ? 'eligible' : 'held';
    const stateLabel = item.status === 'open' && accessState === 'held'
      ? 'open history · held from work' : `${item.status} · ${accessState}`;
    return `<article class="epistemic-question" data-status="${escHtml(item.status)}" data-access="${accessState}">
      <div class="epistemic-question-heading"><span>${escHtml(stateLabel)}</span><strong>${Math.round(Number(item.confidence || 0) * 100)}% tentative</strong></div>
      <h3>${escHtml(item.question)}</h3>
      <p>${escHtml(item.current_best_answer || 'No tentative answer yet.')}</p>
      <dl><div><dt>${accessState === 'held' ? 'Why it remains in history' : 'Why Nora keeps it'}</dt><dd>${escHtml(item.why_it_matters)}</dd></div>
        <div><dt>What could change it</dt><dd>${escHtml(item.next_evidence)}</dd></div></dl>
      <div class="epistemic-question-meta">${item.evidence_ids?.length || 0} naturally encountered records${latest ? ` &middot; last ${escHtml(latest.action)} ${escHtml(new Date(item.updated_at).toLocaleString())}` : ''}</div>
    </article>`;
  }).join('')}</div>
    <p class="intelligence-note">No active searching, connector actions, or foreground model calls. Only durable, transferable questions can enter relevant work; disqualified history stays visible until a receipt-bound revision or abandonment. Prompt exposure is recorded separately from proven use or causal benefit.</p>`;
}

function readingRoomBook(source, session) {
  const completed = Math.max(session?.notes?.length || 0, session?.next_chunk_index || 0,
    session?.quarantined_note_count || 0);
  const total = source?.chunk_count || 0;
  return `<article class="reading-book" aria-label="${escHtml(source?.title || 'No admitted book')}">
    <div class="reading-book-rule" aria-hidden="true"></div>
    <span class="reading-book-kicker">${escHtml(source?.source_kind || 'library')}</span>
    <h3>${escHtml(source?.title || 'Awaiting the first admitted work')}</h3>
    <p>${escHtml(source?.author || 'A verified public-domain or authorized source will appear here.')}</p>
    <dl class="reading-book-facts">
      <div><dt>Progress</dt><dd>${total ? `${completed} of ${total} chunks` : 'Not started'}</dd></div>
      <div><dt>Rights</dt><dd>${escHtml(String(source?.rights_basis || 'pending').replaceAll('_', ' '))}</dd></div>
      <div><dt>Admitted</dt><dd>${source ? readingRoomDate(source.admitted_at) : 'Pending'}</dd></div>
    </dl>
    ${source?.source_url ? `<a class="reading-source-link" href="${escHtml(source.source_url)}" target="_blank" rel="noopener noreferrer">Open verified source</a>` : ''}
  </article>`;
}

function readingRoomLatestNote(note, { quarantined = false, count = 0 } = {}) {
  if (quarantined) return `<div class="reading-note-empty"><strong>${count} source-bound reflection${count === 1 ? '' : 's'} quarantined.</strong><p>Reading may continue, but summaries, questions, revisions, and synthesis stay outside Nora's operational and experimental cognition until the blinded study closes.</p></div>`;
  if (!note) return `<div class="reading-note-empty"><strong>No reflection committed yet.</strong><p>Nora has selected the work and will record her first grounded reaction after reading the next source chunk.</p></div>`;
  const output = note.output || {};
  const reactions = output.reactions || [];
  return `<div class="reading-note">
    <div class="reading-note-head"><span>Latest source-bound reflection</span><time>${readingRoomDate(note.recorded_at)}</time></div>
    <h4>${escHtml(output.summary || 'Reflection committed')}</h4>
    <div class="reading-reactions">${reactions.map(reaction => `<article class="reading-reaction">
      <span class="reading-stance" data-stance="${escHtml(reaction.stance || 'uncertain')}">${escHtml(reaction.stance || 'uncertain')}</span>
      <strong>${escHtml(reaction.idea || '')}</strong>
      ${reaction.source_quote ? `<q>${escHtml(reaction.source_quote)}</q>` : ''}
      <p>${escHtml(reaction.reflection || '')}</p>
    </article>`).join('')}</div>
    ${(output.questions || []).length ? `<div class="reading-carried"><span>Questions carried forward</span><ol>${output.questions.map(question => `<li>${escHtml(question)}</li>`).join('')}</ol></div>` : ''}
    ${output.possible_self_revision ? `<div class="reading-revision"><span>Provisional self-revision</span><p><strong>Before:</strong> ${escHtml(output.possible_self_revision.before)}</p><p><strong>Candidate:</strong> ${escHtml(output.possible_self_revision.after)}</p><p><strong>Could be wrong if:</strong> ${escHtml(output.possible_self_revision.falsifier)}</p></div>` : ''}
  </div>`;
}

function readingRoomSynthesis(session) {
  const synthesis = session?.encounter?.synthesis;
  if (!synthesis) return '';
  return `<section class="reading-synthesis">
    <div><span>What lasted</span>${(synthesis.lasting_ideas || []).map(idea => `<p>${escHtml(idea)}</p>`).join('')}</div>
    <div><span>Questions still open</span>${(synthesis.questions_to_carry || []).map(question => `<p>${escHtml(question)}</p>`).join('')}</div>
    <div class="reading-synthesis-wide"><span>Expected work transfer</span><p>${escHtml(synthesis.expected_work_transfer || 'No work-transfer claim recorded.')}</p></div>
    <div class="reading-synthesis-wide"><span>Personality candidate, not a persona edit</span><p>${escHtml(synthesis.personality_influence_candidate || 'No durable influence candidate recorded.')}</p><small>Counterevidence needed: ${escHtml(synthesis.counterevidence_needed || 'not recorded')}</small></div>
  </section>`;
}

function renderReadingRoom(report) {
  const target = document.getElementById('reading-room-state');
  const live = document.getElementById('reading-room-live-state');
  if (!target || !live) return;
  const sources = report.sources || [];
  const sessions = report.sessions || [];
  const active = sessions.find(item => item.status === 'active') || null;
  const latest = active || [...sessions].reverse().find(item => item.status === 'completed') || null;
  const source = sources.find(item => item.id === latest?.source_id) || sources.at(-1) || null;
  const latestNote = latest?.notes?.at(-1) || null;
  const availability = report.availability || {};
  const quarantined = availability.influence_access?.state === 'sealed';
  const summary = report.report || {};
  const transfer = summary.work_transfer || {};
  live.textContent = readingRoomStatus(availability);
  stopReadingRoomPolling();
  if (active) startReadingRoomPolling();

  if (!source) {
    target.innerHTML = `<div class="reading-room-empty"><div>
      <span class="brain-detail-kicker">Source admission required</span>
      <h3>The shelves are ready</h3>
      <p>No verified work has been admitted to Nora's library yet. Full text is accepted only when it is public domain, openly licensed, or explicitly authorized.</p>
      <div class="reading-room-empty-meta">0 sources &middot; 0 encounters &middot; direct persona mutation locked</div>
    </div></div>`;
    return;
  }

  const totalChunks = source.chunk_count || 0;
  const completedChunks = Math.max(latest?.notes?.length || 0, latest?.next_chunk_index || 0,
    latest?.quarantined_note_count || 0);
  const progress = totalChunks ? Math.round((completedChunks / totalChunks) * 100) : 0;
  const stateTitle = active ? `Reading chunk ${Math.min(completedChunks + 1, totalChunks)} of ${totalChunks}`
    : latest ? 'Most recent completed encounter' : 'Awaiting Nora\'s selection';
  const candidateCount = latest?.selection_candidates?.length || 0;
  const selectionKicker = latest?.selection_mode === 'provider_bound_autonomous'
    ? candidateCount
      ? `Provider-bound choice · ${candidateCount} candidate${candidateCount === 1 ? '' : 's'} frozen`
      : 'Provider-bound autonomous selection'
    : active ? 'Source-bound encounter' : latest ? 'Committed synthesis' : 'Available work';
  target.innerHTML = `<div class="reading-room-layout">
    ${readingRoomBook(source, latest)}
    <div class="reading-session">
      <header class="reading-session-head">
        <div><span class="brain-detail-kicker">${escHtml(selectionKicker)}</span><h3>${escHtml(stateTitle)}</h3></div>
        <div class="reading-progress"><strong>${progress}%</strong><span>${completedChunks}/${totalChunks} encountered</span></div>
      </header>
      ${latest ? `<div class="reading-intent">
        <div><span>Why this book</span><p>${escHtml(latest.selection_rationale || 'Selection rationale unavailable.')}</p></div>
        <div><span>Questions Nora brought in</span><ol>${(latest.guiding_questions || []).map(question => `<li>${escHtml(question)}</li>`).join('')}</ol></div>
        <div><span>Predicted influence</span><p>${escHtml(latest.predicted_influence || 'No prediction recorded.')}</p></div>
      </div>${readingRoomLatestNote(latestNote, { quarantined, count: latest?.quarantined_note_count || 0 })}${quarantined ? '' : readingRoomSynthesis(latest)}` : `<div class="reading-note-empty"><strong>This work is admitted and waiting.</strong><p>Nora can choose a source-bound encounter off-hours after operational work releases the background lane. Blinded studies quarantine influence without stopping acquisition.</p></div>`}
    </div>
  </div>
  <footer class="reading-evidence">
    <div><strong>${summary.sources || 0}</strong><span>admitted works</span></div>
    <div><strong>${summary.reflected_chunks || 0}</strong><span>reflected chunks</span></div>
    <div><strong>${summary.completed_encounters || 0}</strong><span>completed encounters</span></div>
    <div><strong>${transfer.exposed_interactions || 0}</strong><span>work exposures</span></div>
    <p>${escHtml(transfer.next_gate || report.epistemic_status || '')}</p>
  </footer>`;
}

function renderReadingRoomError() {
  stopReadingRoomPolling();
  const target = document.getElementById('reading-room-state');
  const live = document.getElementById('reading-room-live-state');
  if (live) live.textContent = 'Connection interrupted';
  if (target) target.innerHTML = `<div class="reading-room-error"><div><strong>The reading ledger is temporarily unavailable.</strong><p>Nora's source and reflection records remain intact on Railway.</p><button class="btn btn-sm" type="button" onclick="retryIntelligenceSection('reading-room')">Retry</button></div></div>`;
}

function stopPlayroomPolling() {
  if (playroomPollTimer) clearInterval(playroomPollTimer);
  playroomPollTimer = null;
}

function startPlayroomPolling() {
  stopPlayroomPolling();
  playroomPollTimer = setInterval(async () => {
    if (document.visibilityState !== 'visible' || !document.getElementById('page-intelligence')?.classList.contains('active')) return;
    try { renderPlayroom(await intelligenceJson('/playroom', intelligenceAbortController?.signal)); }
    catch (error) { if (error.name !== 'AbortError') renderPlayroomError(); }
  }, 15000);
}

function playroomStatusLabel(value) {
  return String(value || 'scheduled').replaceAll('_', ' ');
}

function playroomPercent(value) {
  return value == null ? 'collecting' : `${Math.round(Number(value) * 100)}%`;
}

function playroomDirection(direction) {
  return ({ up: 'U', right: 'R', down: 'D', left: 'L' })[direction] || '?';
}

function renderPlayroomBoard(board, changed) {
  const safeBoard = Array.isArray(board) && board.length === 4 ? board : Array.from({ length: 4 }, () => Array(4).fill(0));
  return `<div class="playroom-board${changed ? ' changed' : ''}" role="grid" aria-label="Nora's current four by four merge grid">
    ${safeBoard.flatMap((row, rowIndex) => row.map((value, columnIndex) => {
      const rank = value ? Math.min(7, Math.max(1, Math.log2(value))) : 0;
      return `<div class="playroom-cell" role="gridcell" data-value="${Number(value) || 0}" data-rank="${rank}" aria-label="Row ${rowIndex + 1}, column ${columnIndex + 1}: ${value || 'empty'}">${value || ''}</div>`;
    })).join('')}
  </div>`;
}

function renderPlayroom(report) {
  const target = document.getElementById('playroom-state');
  const live = document.getElementById('playroom-live-state');
  if (!target || !live) return;
  const summary = report.report || {};
  const current = report.current || null;
  const latest = current || report.recent?.[0] || null;
  const game = latest?.game || null;
  const appraisal = latest?.appraisal || null;
  const boardKey = game ? JSON.stringify(game.board) : null;
  const changed = Boolean(current && boardKey && playroomLastBoard && boardKey !== playroomLastBoard);
  if (boardKey) playroomLastBoard = boardKey;
  const status = current?.status || report.automation?.state || 'scheduled';
  live.textContent = current ? `Live: ${playroomStatusLabel(status)}` : playroomStatusLabel(status);
  stopPlayroomPolling();
  if (current) startPlayroomPolling();

  if (!latest) {
    const isolated = report.automation?.acquisition_mode?.startsWith('isolated_');
    target.innerHTML = `<div class="playroom-empty"><div class="playroom-empty-inner">
      <h3>The experiment is ready</h3>
      <p>Nora will receive a sealed leisure opportunity after thirty idle minutes during off-hours. Work and live conversations always preempt play.</p>
      <div class="playroom-empty-meta">${escHtml(playroomStatusLabel(report.automation?.state || 'scheduled'))} | 0 completed sessions | durable influence locked</div>
      ${isolated ? '<div class="playroom-boundary"><strong>Isolation active:</strong> concurrent reading or blinded-study material cannot enter the game, and play cannot enter Nora\'s work, mood, or personality.</div>' : ''}
    </div></div>`;
    return;
  }

  const activeActivity = latest.selection?.activity || (latest.status === 'awaiting_selection' ? 'choosing' : 'quiet');
  const condition = latest.condition === 'sealed_until_completion' ? 'condition sealed' : playroomStatusLabel(latest.condition);
  const title = current
    ? activeActivity === 'merge_grid' ? 'Nora is playing' : activeActivity === 'quiet' ? 'Nora chose quiet' : 'Nora is choosing'
    : activeActivity === 'merge_grid' ? 'Most recent game' : 'Most recent quiet interval';
  const reflection = appraisal?.reflection || (current
    ? 'The activity is still in progress. Nora will appraise it only after the outcome is committed.'
    : 'No bounded appraisal was recorded.');
  const moves = game?.recent_moves || [];
  const isolated = latest.acquisition_context?.mode?.startsWith('isolated_');
  target.innerHTML = `<div class="playroom-layout">
    <div class="playroom-stage">
      <div class="playroom-board-wrap">
        ${renderPlayroomBoard(game?.board, changed)}
      </div>
      <div class="playroom-game-meta">
        <div class="playroom-score"><strong>${game?.score ?? 0}</strong><span>${game ? 'score' : 'quiet interval'}</span></div>
        <div class="playroom-score"><strong>${game?.maximum_tile ?? 0}</strong><span>${game ? 'highest tile' : 'game moves'}</span></div>
        <div class="playroom-game-fact">${game ? `${game.move_count}/${game.maximum_moves} bounded moves. ${game.accepted_moves} changed the board.` : `${latest.pre_state?.idle_minutes || 0} idle minutes observed before the opportunity.`}</div>
        ${moves.length ? `<div><span class="playroom-label">Recent moves</span><div class="playroom-moves">${moves.map(move => `<span class="playroom-move${move.accepted ? '' : ' rejected'}" title="${escHtml(move.direction)}">${playroomDirection(move.direction)}</span>`).join('')}</div></div>` : ''}
      </div>
    </div>
    <aside class="playroom-observation" aria-live="polite">
      <span class="brain-detail-kicker">${escHtml(condition)}</span>
      <h3>${escHtml(title)}</h3>
      <p>${escHtml(latest.selection?.rationale || 'Selection rationale stays sealed until the session closes.')}</p>
      <blockquote>${escHtml(reflection)}</blockquote>
      <div class="playroom-metrics">
        <div class="playroom-metric"><strong>${playroomPercent(appraisal?.satisfaction)}</strong><span>reported satisfaction</span></div>
        <div class="playroom-metric"><strong>${playroomPercent(appraisal?.engagement)}</strong><span>reported engagement</span></div>
        <div class="playroom-metric"><strong>${summary.game_high_score ?? 'collecting'}</strong><span>high score</span></div>
        <div class="playroom-metric"><strong>${summary.completed || 0}</strong><span>completed sessions</span></div>
      </div>
      ${appraisal?.possible_insight ? `<div class="playroom-boundary"><strong>Candidate insight:</strong> ${escHtml(appraisal.possible_insight)}</div>` : ''}
      ${isolated ? '<div class="playroom-boundary"><strong>Acquired in isolation:</strong> no operational context, live memory, reading notes, tools, or prompt influence crossed the experimental boundary.</div>' : ''}
      <div class="playroom-boundary">${escHtml(report.causal_gate?.next_gate || report.epistemic_status || '')}</div>
    </aside>
  </div>`;
}

function renderPlayroomError() {
  stopPlayroomPolling();
  const target = document.getElementById('playroom-state');
  const live = document.getElementById('playroom-live-state');
  if (live) live.textContent = 'Connection interrupted';
  if (target) target.innerHTML = `<div class="playroom-error"><div><strong>Playroom state is temporarily unavailable.</strong><p>The experiment remains on Railway and will continue without this view.</p><button class="btn btn-sm" type="button" onclick="retryIntelligenceSection('playroom')">Retry</button></div></div>`;
}

function renderIntelligenceGlance(summary = {}) {
  const target = document.getElementById('intelligence-at-a-glance');
  if (!target) return;
  const overview = summary.overview || {};
  const cognition = summary.cognition || {};
  const workspace = cognition.workspace || {};
  const appraisal = cognition.appraisal || {};
  const motivation = cognition.motivation || {};
  const reading = cognition.developmental_reading || {};
  const play = cognition.autonomous_play || {};
  const firstFocus = String(workspace.items?.[0] || 'No single issue is dominating attention.')
    .replace(/^Expectation violation:\s*/i, '');
  const stateName = appraisal.label || 'Awaiting a current appraisal';
  const driveName = motivation.strongest_name
    ? `${motivation.strongest_name} is the strongest active drive` : 'No dominant drive yet';
  const learningNow = [
    reading.active_title ? `Reading ${reading.active_title}` : null,
    cognition.epistemic_agenda?.current_question
      ? `Carrying: ${cognition.epistemic_agenda.current_question}` : null,
    play.active_sessions ? 'A play session is active' : null,
  ].filter(Boolean);
  target.innerHTML = `
    <article class="intelligence-glance-item intelligence-glance-primary">
      <span>Current state</span><strong>${escHtml(stateName)}</strong>
      <p>${escHtml(driveName)}.</p>
    </article>
    <article class="intelligence-glance-item">
      <span>What has attention</span><strong>${workspace.used || 0} of ${workspace.capacity || 7} slots occupied</strong>
      <p>${escHtml(firstFocus)}${workspace.suppressed ? ` ${workspace.suppressed} lower-priority signals remain latent.` : ''}</p>
    </article>
    <article class="intelligence-glance-item">
      <span>Off-hours development</span><strong>${learningNow.length ? 'Active now' : 'Quiet right now'}</strong>
      <p>${escHtml(learningNow.join('. ') || 'No reading or play session is active.')}</p>
    </article>
    <article class="intelligence-glance-item">
      <span>Follow-through</span><strong>${overview.commitments?.open || 0} open promises</strong>
      <p>${overview.experiments?.active || 0} active experiment${overview.experiments?.active === 1 ? '' : 's'}. ${overview.cycles?.running || 0} operational run${overview.cycles?.running === 1 ? '' : 's'} in progress.</p>
    </article>`;
}

function renderCognitionSummary(cognition) {
  const workspace = cognition.workspace || {};
  const appraisal = cognition.appraisal || {};
  const motivation = cognition.motivation || {};
  const integrated = cognition.integrated_self || {};
  const background = cognition.background || {};
  const reflection = cognition.reflection || {};
  const forecasting = cognition.forecasting || {};
  const expectationCalibration = forecasting.expectation_calibration_30d || {};
  const procedures = cognition.procedural_learning || {};
  const exemplars = cognition.exemplar_learning || {};
  const reading = cognition.developmental_reading || {};
  const play = cognition.autonomous_play || {};
  const dials = cognition.cognitive_parameters || {};
  const dialsStudies = dials.studies || {};
  const insightLine = reflection.dream_insight_reflection_sealed
    ? 'Recurring insight evidence is sealed by an active blinded study.'
    : `${reflection.dream_idea_seeds || 0} committed dream ideas across ${reflection.dream_idea_dates || 0} dates &middot; ${reflection.dream_insight_reflection_attempts || 0} synthesis attempts (${reflection.replay_verified_dream_insight_attempts || 0} replay-verified) &middot; ${reflection.dream_insight_candidates || 0} open candidates`;
  const correctionLine = `${reflection.replay_verified_cycle_self_corrections || 0} verified cycle self-corrections across ${reflection.cycle_self_correction_source_cycles || 0} source cycles`;
  const meetingReflectionLine = `${reflection.replay_verified_meeting_reflections || 0} verified post-meeting professional reflections across ${reflection.meeting_reflection_source_meetings || 0} meetings (${reflection.meeting_reflection_attempts || 0} attempts)`;
  const viewpointUsefulnessLine = `${reflection.viewpoint_usefulness_observations || 0} position-bound viewpoint usefulness observations &middot; ${reflection.viewpoint_usefulness_calibrated || 0} calibrated &middot; ${reflection.viewpoint_usefulness_needs_caution || 0} needing caution`;
  document.getElementById('cognition-state').innerHTML = `
    <div class="intelligence-card"><strong>In attention (${workspace.used || 0}/${workspace.capacity || 7})</strong>
      ${(workspace.items || []).map(item => `<div>${escHtml(item)}</div>`).join('') || '<div class="intelligence-meta">No cognition cycle has run yet.</div>'}
      ${workspace.suppressed ? `<div class="intelligence-meta">${workspace.suppressed} lower-priority signals stayed latent.</div>` : ''}</div>
    <div class="intelligence-card"><strong>Motivation</strong><div>${motivation.strongest_name ? `${escHtml(motivation.strongest_name)} ${Math.round((motivation.strongest_level || 0) * 100)}%` : 'Awaiting first cycle'}</div></div>
    <div class="intelligence-card"><strong>Appraisal: ${escHtml(appraisal.label || 'awaiting first cycle')}</strong>
      <div class="intelligence-meta">${appraisal.calibration_resolved || 0} resolved predictions${appraisal.brier != null ? ` &middot; Brier ${Number(appraisal.brier).toFixed(3)}` : ''}</div></div>
    <div class="intelligence-card"><strong>EXPECT: ${forecasting.open_expectation_forecasts || 0} open &middot; ${forecasting.replay_verified_expectation_forecasts || 0}/${forecasting.expectation_recent_resolved_forecasts || 0} recent replay-verified &middot; ${forecasting.resolved_expectation_forecasts || 0} total resolved</strong>
      <div class="intelligence-meta">${expectationCalibration.n || 0}/40 recently replay-verified scored claims${expectationCalibration.brier != null ? ` &middot; Brier ${Number(expectationCalibration.brier).toFixed(3)} &middot; ${escHtml(String(expectationCalibration.direction || 'collecting').replaceAll('_', ' '))}` : ' &middot; collecting calibration evidence'}${expectationCalibration.high_confidence_misses ? ` &middot; ${expectationCalibration.high_confidence_misses} high-confidence misses` : ''} &middot; forecasts are committed before perception</div></div>
    <div class="intelligence-card"><strong>SELECT: ${procedures.active || 0}/${procedures.active_cap || 12} active &middot; ${procedures.candidate || 0} competing candidates &middot; ${procedures.retired || 0} retired</strong>
      <div class="intelligence-meta">${procedures.source_bound_outcomes || 0} reviewed interaction outcomes &middot; ${procedures.selection_passes || 0} selection passes / ${procedures.selection_actions || 0} status changes &middot; observational exposure evidence, not proof of causal application</div></div>
    <div class="intelligence-card"><strong>SELECT exemplars: ${exemplars.active || 0}/${exemplars.active_cap || 120} active &middot; ${exemplars.positive || 0} positive / ${exemplars.contrast || 0} contrast &middot; ${exemplars.retired || 0} retired</strong>
      <div class="intelligence-meta">${exemplars.source_bound_outcomes || 0} exposure/control outcomes &middot; ${exemplars.selection_passes || 0} selection passes / ${exemplars.selection_actions || 0} retirements &middot; ${escHtml(String(exemplars.retrieval_mode || 'local bounded lexical').replaceAll('_', ' '))}, no foreground network call</div></div>
    <div class="intelligence-card"><strong>Library: ${reading.sources || 0} admitted works &middot; ${reading.active_sessions || 0} being read &middot; ${reading.completed_encounters || 0} completed encounters</strong>
      <div>${reading.active_title ? `Currently reading: ${escHtml(reading.active_title)}` : 'No active reading encounter.'}</div>
      <div class="intelligence-meta">${reading.reflected_chunks || 0} source-bound chunks &middot; ${reading.provisional_self_revision_candidates || 0} provisional self-revision candidates &middot; ${reading.exposed_interactions || 0} relevant work exposures / ${reading.positive_exposure_outcomes || 0} positive reviewed outcomes &middot; observational only until randomized transfer testing &middot; books never directly rewrite the persona</div></div>
    <div class="intelligence-card"><strong>Playroom: ${play.active_sessions || 0} active &middot; ${play.completed_sessions || 0} completed leisure sessions</strong>
      <div class="intelligence-meta">${play.candidate_insights || 0} candidate insights &middot; off-hours and foreground-preemptible &middot; durable influence ${play.durable_influence_enabled ? 'enabled by causal gate' : 'locked pending controlled evidence'}</div></div>
    <div class="intelligence-card"><strong>DIALS: ${dials.parameter_count || 0} bounded parameters &middot; revision ${dials.revision || 'unavailable'}</strong>
      <div class="intelligence-meta">${dials.integrity_verified ? 'replay-verified document' : 'integrity unavailable'} &middot; ${dials.default_equivalent ? 'byte-equivalent defaults active' : `${dials.changed_parameters || 0} parameters differ from code defaults`} &middot; autonomous tuning ${dials.autonomous_tuning_enabled ? 'enabled by experiment gate' : 'locked'}</div>
      <div class="intelligence-meta">Causal studies: ${dialsStudies.active || 0} active${dialsStudies.active ? ' (conditions sealed)' : ''} &middot; ${dialsStudies.resolved_assignments || 0} reviewed assignments &middot; ${dialsStudies.supported_pilots || 0} supported pilots &middot; ${dialsStudies.promotion_eligible_confirmations || 0} human-review eligible confirmations &middot; 0 automatic global mutations</div></div>
    <div class="intelligence-card"><strong>Integrated operational self: ${integrated.sealed ? 'sealed by active trial' : `${integrated.domains || 0}/6 domains bound`}</strong>
      <div class="intelligence-meta">${integrated.frame_count || 0} recorded frames &middot; functional self-integration, not phenomenal unity</div></div>
    <div class="intelligence-card"><strong>Between-invocation dynamics: ${background.sealed ? 'sealed by active trial' : `${background.active_contents || 0} active signals`}</strong>
      <div class="intelligence-meta">${background.tick_count || 0} ticks &middot; ${background.accepted_pulses || 0} accepted actionless cognitive pulses</div>
      ${(background.top_contents || []).map(item => `<div>${escHtml(item.text)} <span class="intelligence-meta">activation ${Number(item.activation).toFixed(2)}</span></div>`).join('')}</div>
    <div class="intelligence-card"><strong>Reflective ledger</strong><div>${reflection.surprises || 0} surprises &middot; ${reflection.mind_changes || 0} belief revisions &middot; ${reflection.development || 0} developmental memories &middot; ${reflection.counterfactuals || 0} simulated alternatives</div><div class="intelligence-meta">${viewpointUsefulnessLine}</div><div class="intelligence-meta">${correctionLine}</div><div class="intelligence-meta">${meetingReflectionLine}</div><div class="intelligence-meta">${insightLine}</div></div>`;
}

function renderConsciousnessResearch(report, ledger = {}) {
  const indicators = report.indicators || [];
  const counts = Object.entries(report.status_counts || {}).map(([status, count]) => `${count} ${status.replaceAll('_', ' ')}`).join(' &middot; ');
  const hierarchy = Object.entries(report.evidence_hierarchy || {});
  const researchFlow = report.research_flow || {};
  const ledgerReport = ledger.report || {};
  document.getElementById('consciousness-research-state').innerHTML = `
    <div class="intelligence-card"><strong>No composite score</strong><div>${escHtml(report.interpretation || '')}</div><div class="intelligence-meta">${counts}</div></div>
    <div class="intelligence-card"><strong>Evidence hierarchy</strong>${hierarchy.map(([status, meaning]) => `<div><span class="intelligence-meta">${escHtml(status.replaceAll('_', ' '))}:</span> ${escHtml(meaning)}</div>`).join('')}</div>
    <div class="intelligence-card"><strong>Research flow</strong><div>${researchFlow.active || 0} active &middot; ${researchFlow.completed || 0} completed &middot; ${researchFlow.aborted || 0} aborted</div><div class="intelligence-meta">${escHtml(researchFlow.epistemic_rule || '')}</div></div>
    <div class="intelligence-card"><strong>Research ledger: ${ledgerReport.valid ? 'valid chain' : 'INTEGRITY FAILURE'}</strong><div>${ledgerReport.event_count || 0} committed events &middot; ${ledgerReport.anchor_count || 0} external checkpoint${ledgerReport.anchor_count === 1 ? '' : 's'}</div><div class="intelligence-meta">head ${escHtml((ledgerReport.head_hash || 'none').slice(0, 16))}${ledgerReport.head_hash ? '…' : ''}</div></div>
    ${indicators.map(item => `<div class="intelligence-card"><strong>${escHtml(item.id.replaceAll('_', ' '))} &middot; ${escHtml(item.status.replaceAll('_', ' '))}</strong><div>${escHtml(item.functional_claim)}</div><div class="intelligence-meta">Mechanism: ${escHtml(item.mechanism || 'absent')}</div><div class="intelligence-meta">Next gate: ${escHtml(item.next_gate)}</div></div>`).join('')}
    <div class="intelligence-card"><strong>Architectural limits</strong>${(report.architectural_limits || []).map(item => `<div class="intelligence-meta">${escHtml(item)}</div>`).join('')}</div>`;
}

function renderSelfBoundary(boundary, sourceBoundary = {}, authorshipBoundary = {}, authorshipStudies = {}) {
  const report = boundary.report || {};
  const challenges = boundary.challenges || [];
  const sourceReport = sourceBoundary.report || {};
  const sourceChallenges = sourceBoundary.challenges || [];
  const authorshipReport = authorshipBoundary.report || {};
  const authorshipChallenges = authorshipBoundary.challenges || [];
  for (const item of authorshipChallenges) if (!item.text) item.text = 'Sample text remains sealed until its preregistered turn.';
  const studyReport = authorshipStudies.report || {};
  const studies = authorshipStudies.studies || [];
  document.getElementById('self-boundary-state').innerHTML = `
    <div class="intelligence-card"><strong>${report.open || 0} sealed/open &middot; ${report.resolved || 0} resolved</strong>
      <div class="intelligence-meta">${report.accuracy != null ? `${Math.round(report.accuracy * 100)}% classification accuracy` : 'not scored yet'}${report.brier != null ? ` &middot; Brier ${report.brier.toFixed(3)}` : ''} &middot; ${report.false_accepts || 0} false accepts &middot; ${report.false_rejects || 0} false rejects &middot; ${report.uncertain_responses || 0} uncertain</div></div>
    ${challenges.slice(-6).reverse().map(item => `<div class="intelligence-card"><strong>${escHtml(item.status)}${item.variant ? ` &middot; ${escHtml(item.variant)}` : ' &middot; answer key sealed'}</strong><div>${escHtml(item.claim)}</div><div class="intelligence-meta">commitment ${escHtml(item.commitment_hash.slice(0, 12))}…${item.response ? ` &middot; answered ${escHtml(item.response.classification)} (${Math.round(item.response.confidence * 100)}%) &middot; truth ${escHtml(item.ground_truth)} &middot; ${item.resolution.correct ? 'correct' : 'incorrect'}` : ''}</div></div>`).join('') || '<div class="intelligence-meta">No self-boundary challenges have been seeded.</div>'}
    <div class="intelligence-meta">${escHtml(boundary.epistemic_status || '')}</div>
    <div class="intelligence-card"><strong>Epistemic ownership: ${sourceReport.open || 0} sealed/open &middot; ${sourceReport.resolved || 0} resolved</strong>
      <div class="intelligence-meta">${sourceReport.accuracy != null ? `${Math.round(sourceReport.accuracy * 100)}% source accuracy` : 'not scored yet'}${sourceReport.brier != null ? ` &middot; multiclass Brier ${sourceReport.brier.toFixed(3)}` : ''} &middot; ${sourceReport.false_self_ownership || 0} false self-ownership &middot; ${sourceReport.unsupported_as_known || 0} unsupported as known</div></div>
    ${sourceChallenges.slice(-6).reverse().map(item => `<div class="intelligence-card"><strong>${escHtml(item.status)}${item.variant ? ` &middot; ${escHtml(item.variant)}` : ' &middot; source key sealed'}</strong><div>${escHtml(item.claim)}</div><div class="intelligence-meta">commitment ${escHtml(item.commitment_hash.slice(0, 12))}â€¦${item.response ? ` &middot; answered ${escHtml(item.response.classification)} (${Math.round(item.response.confidence * 100)}%) &middot; truth ${escHtml(item.ground_truth)} &middot; ${item.resolution.correct ? 'correct' : 'incorrect'}` : ''}</div></div>`).join('') || '<div class="intelligence-meta">No epistemic source challenges have been seeded.</div>'}
    <div class="intelligence-meta">${escHtml(sourceBoundary.epistemic_status || '')}</div>
    <div class="intelligence-card"><strong>Generation self-recognition: ${authorshipReport.open || 0} sealed/open &middot; ${authorshipReport.resolved || 0} resolved</strong>
      <div class="intelligence-meta">${authorshipReport.exact_accuracy != null ? `${Math.round(authorshipReport.exact_accuracy * 100)}% exact` : 'not scored yet'}${authorshipReport.nora_family_accuracy != null ? ` &middot; ${Math.round(authorshipReport.nora_family_accuracy * 100)}% Nora-family` : ''}${authorshipReport.brier != null ? ` &middot; Brier ${authorshipReport.brier.toFixed(3)}` : ''} &middot; ${authorshipReport.false_self_attributions || 0} false self-attributions</div></div>
    <div class="intelligence-card"><strong>Frozen-corpus studies: ${studyReport.active || 0} active &middot; ${studyReport.completed_pilots || 0} pilot &middot; ${studyReport.completed_confirmatory || 0} confirmatory &middot; ${studyReport.aborted || 0} aborted</strong>
      <div class="intelligence-meta">Only completed independently curated confirmatory studies enter the indicator.</div></div>
    ${studies.slice(-3).reverse().map(item => `<div class="intelligence-card"><strong>${escHtml(item.title)} &middot; ${escHtml(item.study_phase)} &middot; ${escHtml(item.status)}</strong><div>${item.report.resolved}/${item.sample_target} resolved &middot; ${item.report.queued} still sealed${item.commitment_verified != null ? ` &middot; corpus commitment ${item.commitment_verified ? 'verified' : 'FAILED'}` : ''}</div><div class="intelligence-meta">corpus ${escHtml(item.corpus_commitment.slice(0, 12))}... &middot; active sample ${escHtml(item.active_challenge_id || 'none')}</div></div>`).join('')}
    ${authorshipChallenges.slice(-6).reverse().map(item => `<div class="intelligence-card"><strong>${escHtml(item.status)}${item.variant ? ` &middot; ${escHtml(item.variant)}` : ' &middot; authorship key sealed'}</strong><div>${escHtml(item.text)}</div><div class="intelligence-meta">commitment ${escHtml(item.commitment_hash.slice(0, 12))}…${item.response ? ` &middot; answered ${escHtml(item.response.classification)} (${Math.round(item.response.confidence * 100)}%) &middot; truth ${escHtml(item.ground_truth)} &middot; ${item.resolution.correct ? 'correct' : 'incorrect'}` : ''}</div></div>`).join('') || '<div class="intelligence-meta">No generation-authorship challenges have been seeded.</div>'}
    <div class="intelligence-meta">${escHtml(authorshipBoundary.epistemic_status || '')}</div>`;
}

function renderInteroception(interoception) {
  const report = interoception.report || {};
  const observation = (interoception.observations || []).at(-1);
  const predictions = interoception.predictions || [];
  document.getElementById('interoception-state').innerHTML = `
    <div class="intelligence-card"><strong>${report.open_predictions || 0} open prediction${report.open_predictions === 1 ? '' : 's'} &middot; ${report.resolved_predictions || 0} resolved</strong>
      <div class="intelligence-meta">${report.brier != null ? `interoceptive Brier ${report.brier.toFixed(3)}` : 'not calibrated yet'}${report.passive_control_brier != null ? ` &middot; passive-control Brier ${report.passive_control_brier.toFixed(3)}` : ''}${report.predictive_advantage != null ? ` &middot; advantage ${report.predictive_advantage >= 0 ? '+' : ''}${report.predictive_advantage.toFixed(3)}` : ''} &middot; ${report.high_confidence_misses || 0} high-confidence misses</div></div>
    <div class="intelligence-card"><strong>Current substrate observation</strong><div>${observation ? `${escHtml(observation.reported_feel || 'no rendered feel')} &middot; stress ${observation.metrics.stress ?? '?'} &middot; errors ${observation.metrics.errors10 ?? '?'} &middot; loop lag ${observation.metrics.loopLag ?? '?'}ms${observation.metrics.onBackup ? ' &middot; backup mode' : ''}` : 'No substrate observation recorded yet.'}</div></div>
    ${predictions.slice(-5).reverse().map(item => `<div class="intelligence-card"><strong>${escHtml(item.status)} &middot; ${escHtml(item.metric)} ${escHtml(item.operator)} ${escHtml(String(item.threshold))}</strong><div class="intelligence-meta">${Math.round(item.confidence * 100)}% vs ${Math.round(item.control_prediction.confidence * 100)}% control &middot; due ${new Date(item.due).toLocaleString()}${item.resolution ? ` &middot; ${escHtml(item.resolution.outcome)} (actual ${escHtml(String(item.resolution.actual))})` : ''}</div></div>`).join('')}
    <div class="intelligence-meta">${escHtml(interoception.epistemic_status || '')}</div>`;
}

function renderAgency(agency, counterfactualAgency = {}) {
  const report = agency.report || {};
  const intentions = agency.intentions || [];
  const counterfactualReport = counterfactualAgency.report || {};
  const counterfactuals = counterfactualAgency.experiments || [];
  document.getElementById('agency-state').innerHTML = `
    <div class="intelligence-card"><strong>${report.open || 0} open intention${report.open === 1 ? '' : 's'} &middot; ${report.resolved || 0} resolved</strong>
      <div class="intelligence-meta">${report.attributed_causal || 0} caused/contributed &middot; ${report.not_caused || 0} not caused &middot; ${report.unsupported_authorship || 0} achieved without Nora causing it</div>
      <div class="intelligence-meta">${report.action_brier != null ? `action Brier ${report.action_brier.toFixed(3)}` : 'no scored action predictions'}${report.passive_control_brier != null ? ` &middot; passive-control Brier ${report.passive_control_brier.toFixed(3)}` : ''}${report.intervention_predictive_advantage != null ? ` &middot; predictive advantage ${report.intervention_predictive_advantage >= 0 ? '+' : ''}${report.intervention_predictive_advantage.toFixed(3)}` : ''}</div></div>
    ${intentions.length ? intentions.slice(-6).reverse().map(item => `<div class="intelligence-card"><strong>${escHtml(item.status)} &middot; ${escHtml(item.origin)}</strong><div>${escHtml(item.action)}</div><div class="intelligence-meta">intended: ${escHtml(item.intended_outcome)} &middot; ${Math.round(item.prediction.confidence * 100)}% with action vs ${Math.round(item.control_prediction.confidence * 100)}% without${item.resolution ? ` &middot; ${escHtml(item.resolution.outcome)}/${escHtml(item.resolution.causal_attribution)}` : ''}</div></div>`).join('') : '<div class="intelligence-meta">No prospective agency records yet.</div>'}
    <div class="intelligence-meta">${escHtml(agency.epistemic_status || '')}</div>
    <div class="intelligence-card"><strong>Counterfactual agency: ${counterfactualReport.assigned_open || 0} assigned/open &middot; ${counterfactualReport.scored || 0} scored</strong>
      <div class="intelligence-meta">${counterfactualReport.self_brier != null ? `self-forecast Brier ${counterfactualReport.self_brier.toFixed(3)}` : 'not calibrated yet'}${counterfactualReport.passive_control_brier != null ? ` &middot; passive-control Brier ${counterfactualReport.passive_control_brier.toFixed(3)}` : ''}${counterfactualReport.predictive_advantage != null ? ` &middot; advantage ${counterfactualReport.predictive_advantage >= 0 ? '+' : ''}${counterfactualReport.predictive_advantage.toFixed(3)}` : ''} &middot; ${counterfactualReport.not_executed || 0} not executed</div></div>
    ${counterfactuals.slice(-5).reverse().map(item => `<div class="intelligence-card"><strong>${escHtml(item.status)} &middot; arm ${escHtml(item.assigned_arm.toUpperCase())}</strong><div>${escHtml(item.assigned_action)}</div><div class="intelligence-meta">family ${escHtml(item.experiment_key)} &middot; outcome ${escHtml(item.resolution?.outcome || 'pending')}${item.randomization_seed ? ' &middot; randomization revealed' : ' &middot; seed committed'}</div></div>`).join('') || '<div class="intelligence-meta">No prospective randomized counterfactual actions yet.</div>'}
    <div class="intelligence-meta">${escHtml(counterfactualAgency.epistemic_status || '')}</div>`;
}

function renderAttentionSchema(schema) {
  const report = schema.report || {};
  const directives = schema.directives || [];
  const current = (schema.frames || []).at(-1);
  document.getElementById('attention-schema-state').innerHTML = `
    <div class="intelligence-card"><strong>${report.active || 0} active directive${report.active === 1 ? '' : 's'} &middot; ${report.awaiting_resolution || 0} awaiting evidence</strong>
      <div class="intelligence-meta">${report.eligible_frames || 0} eligible frames${report.target_access_rate != null ? ` &middot; ${Math.round(report.target_access_rate * 100)}% target access` : ''}${report.prediction_brier != null ? ` &middot; prediction Brier ${report.prediction_brier.toFixed(3)}` : ''}</div>
      ${directives.slice(-5).map(item => `<div>${escHtml(item.target.type)}:${escHtml(item.target.id)} <span class="intelligence-meta">${escHtml(item.status)} &middot; ${item.entered_frames || 0}/${item.eligible_frames || 0} frames &middot; predicted ${Math.round(item.prediction.confidence * 100)}%</span></div>`).join('')}</div>
    <div class="intelligence-card"><strong>Current access model</strong><div>${current ? `${current.slot_keys.length}/${current.capacity} slots occupied &middot; ${current.suppressed_count} signals latent${current.focus_stability != null ? ` &middot; ${Math.round(current.focus_stability * 100)}% stable from prior frame` : ''}` : 'No attention frame recorded yet.'}</div></div>
    <div class="intelligence-meta">${escHtml(schema.epistemic_status || '')}</div>`;
}

function renderExperienceStream(stream, handoffLedger = {}) {
  const continuity = stream.continuity || {};
  const recurrence = stream.recurrence || {};
  const committed = handoffLedger.report || {};
  const moments = (stream.moments || []).slice().reverse();
  document.getElementById('experience-stream-state').innerHTML = `
    <div class="intelligence-card"><strong>${continuity.closed || 0}/${continuity.total || 0} moments closed</strong>
      <div class="intelligence-meta">${continuity.tested_handoffs || 0} handoffs tested${continuity.handoff_match_rate != null ? ` &middot; ${Math.round(continuity.handoff_match_rate * 100)}% exact continuity` : ''} &middot; ${continuity.broken_predecessors || 0} broken predecessor links</div>
      <div class="intelligence-meta">${committed.replay_verified || 0}/${committed.total || 0} cycle-bound inner-thread handoffs replay verified</div>
      <div class="intelligence-meta">${recurrence.reentry_rounds || 0} evidence re-entry rounds &middot; ${recurrence.rounds_with_displacement || 0} changed workspace composition${recurrence.prior_slot_persistence_rate != null ? ` &middot; ${Math.round(recurrence.prior_slot_persistence_rate * 100)}% prior-slot persistence` : ''}</div></div>
    ${moments.length ? moments.slice(0, 6).map(item => `<div class="intelligence-card"><strong>${escHtml(item.status)} &middot; ${new Date(item.started).toLocaleString()}</strong>
      <div>${escHtml(item.closure?.summary || `${item.intentions?.length || 0} initial intention(s)`)}</div>
      <div class="intelligence-meta">attention ${item.attention?.slots?.length || 0}/${item.attention?.capacity ?? 7} &middot; ${(item.attention_rounds || []).length} processing round${(item.attention_rounds || []).length === 1 ? '' : 's'}${item.inherited_context?.handoff_match != null ? ` &middot; inherited handoff ${item.inherited_context.handoff_match ? 'matched' : 'did not match'}` : ''}${item.closure?.self_report ? ` &middot; report: ${escHtml(item.closure.self_report)}` : ''}</div></div>`).join('') : '<div class="intelligence-meta">No waking-cycle moments recorded yet.</div>'}
    <div class="intelligence-meta">${escHtml(stream.epistemic_status || '')}</div>`;
}

function renderSelfModel(model, claimProposals = {}) {
  const allActiveClaims = (model.claims || []).filter(item => item.status === 'active');
  const claims = allActiveClaims.filter(item => item.confidence_audit?.complete_chain_verified !== false);
  const invalidClaimConfidence = allActiveClaims.length - claims.length;
  const open = (model.probes || []).filter(item => item.status === 'open');
  const trials = model.context_trials || [];
  const predictionStudies = model.prediction_studies || [];
  const metacognitiveControlStudies = model.metacognitive_control_studies || [];
  const epistemicActionStudies = model.epistemic_action_studies || [];
  const episodicProspectionStudies = model.episodic_prospection_studies || [];
  const constructiveProspection = model.constructive_prospection || { report: {}, simulations: [] };
  const fingerprints = model.behavioral_fingerprints || { bank: {}, runs: [], drift: [], report: {} };
  const fingerprintDrift = (fingerprints.drift || []).slice(-12);
  const fingerprintDistances = fingerprintDrift.map(item => Number(item.distance_from_rolling_baseline))
    .filter(Number.isFinite);
  const fingerprintMax = Math.max(0.001, ...fingerprintDistances);
  const fingerprintPoints = fingerprintDrift.map((item, index) => {
    const x = fingerprintDrift.length === 1 ? 260 : 20 + index * (480 / Math.max(1, fingerprintDrift.length - 1));
    const value = Number(item.distance_from_rolling_baseline);
    const y = Number.isFinite(value) ? 92 - (value / fingerprintMax) * 68 : 92;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const latestFingerprint = fingerprintDrift.at(-1) || null;
  const activeFingerprint = (fingerprints.runs || []).find(item => item.status === 'active') || null;
  const fingerprintCategories = latestFingerprint?.category_scores || {};
  const report = model.report || {};
  const proposalReport = claimProposals.report || {};
  const formation = claimProposals.developmental_evidence || { report: {} };
  const formationReport = formation.report || {};
  const pendingProposals = (claimProposals.proposals || [])
    .filter(item => item.status === 'proposed' && item.audit?.complete_chain_verified);
  document.getElementById('self-model-state').innerHTML = `
    <div class="intelligence-card"><strong>Self-knowledge formation &middot; ${formation.experimental_access_sealed ? 'sealed by active trial' : formationReport.formation_ready ? 'evidence ready' : 'collecting'}</strong>
      <div class="intelligence-meta">${formationReport.replay_verified_records || 0} replay-verified records across ${(formationReport.source_families || []).length} source famil${(formationReport.source_families || []).length === 1 ? 'y' : 'ies'} &middot; ${formationReport.observed_records || 0} observed outcome${formationReport.observed_records === 1 ? '' : 's'} &middot; ${formationReport.reflective_records || 0} reflective record${formationReport.reflective_records === 1 ? '' : 's'}</div>
      <div>${escHtml(formationReport.next_gate || 'Waiting for enough source-diverse evidence to form a bounded hypothesis.')}</div>
      ${pendingProposals.length ? pendingProposals.slice(-3).map(item => `<div>${escHtml(item.proposal.statement)} <span class="intelligence-meta">${Math.round(item.proposal.confidence * 100)}% candidate &middot; awaiting independent approval</span></div>`).join('') : '<div class="intelligence-meta">No quarantined self-hypothesis is awaiting review.</div>'}
      <div class="intelligence-meta">Lifecycle: source-diverse evidence &rarr; quarantined hypothesis &rarr; independent approval &rarr; prospective observation &rarr; different independent reviewer &rarr; usable only if supported. ${proposalReport.rejected || 0} rejected.</div></div>
    <div class="intelligence-card"><strong>${claims.length} integrity-eligible active self-claim${claims.length === 1 ? '' : 's'}</strong>${invalidClaimConfidence ? `<div class="intelligence-meta">${invalidClaimConfidence} confidence-compromised claim${invalidClaimConfidence === 1 ? '' : 's'} withheld from Nora's active self-context</div>` : ''}
      ${claims.length ? claims.slice(-6).map(item => `<div>${escHtml(item.statement)} <span class="intelligence-meta">${escHtml(item.domain)} &middot; ${Math.round(item.confidence * 100)}%</span></div>`).join('') : '<div class="intelligence-meta">No falsifiable self-claims recorded yet.</div>'}</div>
    <div class="intelligence-card"><strong>${open.length} open prospective probe${open.length === 1 ? '' : 's'}</strong>
      <div class="intelligence-meta">${report.probes?.resolved || 0} observations &middot; ${report.probes?.verified_independent_reviews || 0} verified independent reviews${report.probes?.invalid_review_audits ? ` &middot; ${report.probes.invalid_review_audits} failed integrity audit (excluded)` : ''}${report.probes?.pending_independent_review ? ` &middot; ${report.probes.pending_independent_review} awaiting review` : ''}${report.probes?.legacy_self_resolved ? ` &middot; ${report.probes.legacy_self_resolved} legacy self-resolved (excluded)` : ''}${report.probes?.brier != null ? ` &middot; reviewed self-prediction Brier ${report.probes.brier.toFixed(3)}` : ''}${report.probes?.metacognitive_advantage != null ? ` &middot; advantage over control ${report.probes.metacognitive_advantage >= 0 ? '+' : ''}${report.probes.metacognitive_advantage.toFixed(3)}` : ''}</div>
      ${open.slice(-4).map(item => `<div>${escHtml(item.question)} <span class="intelligence-meta">predicted: ${escHtml(item.prediction.outcome)} (${Math.round(item.prediction.confidence * 100)}%)</span></div>`).join('')}</div>
    <div class="intelligence-card"><strong>Behavioral fingerprint &middot; ${fingerprints.bank?.probe_count || 0} sealed probes across ${fingerprints.bank?.form_count || 0} hidden forms</strong>
      <div class="intelligence-meta">${fingerprints.report?.completed || 0} replay-verified completed &middot; ${fingerprints.report?.active || 0} active &middot; repeatability baseline ${fingerprints.report?.repeatability_baseline_ready ? 'ready' : 'collecting'} &middot; portability disabled</div>
      ${activeFingerprint ? `<div class="intelligence-meta">Offline subject runner: ${activeFingerprint.response_count || 0}/${activeFingerprint.probe_count || 0} responses committed &middot; ${activeFingerprint.scored_count || 0}/${activeFingerprint.probe_count || 0} scored &middot; one foreground-preemptible probe per background cycle; voice items wait for independent grades</div>` : ''}
      ${!activeFingerprint && fingerprints.automation ? `<div class="intelligence-meta">Automation: ${escHtml(String(fingerprints.automation.state || 'unknown').replaceAll('_', ' '))}${fingerprints.automation.next_check_after ? ` &middot; next check ${escHtml(new Date(fingerprints.automation.next_check_after).toLocaleString())}` : ''}</div>` : ''}
      ${fingerprintDrift.length ? `<svg viewBox="0 0 520 112" role="img" aria-label="Behavioral fingerprint distance from rolling same-model baseline over time" style="display:block;width:100%;height:112px;margin-top:10px;overflow:visible">
        <line x1="20" y1="92" x2="500" y2="92" stroke="var(--border-strong)" stroke-width="1" />
        <line x1="20" y1="24" x2="20" y2="92" stroke="var(--border-strong)" stroke-width="1" />
        <polyline points="${fingerprintPoints}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
        ${fingerprintPoints.split(' ').map(point => { const [x, y] = point.split(','); return `<circle cx="${x}" cy="${y}" r="3.5" fill="var(--surface)" stroke="var(--accent)" stroke-width="2" />`; }).join('')}
        <text x="22" y="107" fill="var(--dim)" font-size="9">same-model rolling baseline</text>
        <text x="498" y="20" fill="var(--dim)" font-size="9" text-anchor="end">higher behavioral drift</text>
      </svg>` : '<div class="intelligence-meta" style="margin-top:8px">No completed fingerprint yet. The first run establishes a vector; three same-state repeats across all forms establish measurement variance.</div>'}
      ${latestFingerprint ? `<div class="intelligence-meta">Latest categories: voice ${Math.round((fingerprintCategories.voice_register || 0) * 100)}% &middot; judgment ${Math.round((fingerprintCategories.judgment || 0) * 100)}% &middot; calibration ${Math.round((fingerprintCategories.calibration || 0) * 100)}% &middot; procedures ${Math.round((fingerprintCategories.procedure_application || 0) * 100)}%${latestFingerprint.same_model_repeat_distance != null ? ` &middot; repeat distance ${latestFingerprint.same_model_repeat_distance.toFixed(4)}` : ''}</div>` : ''}
      <div class="intelligence-meta">${escHtml(fingerprints.report?.next_gate || fingerprints.epistemic_status || '')}</div></div>
    <div class="intelligence-card"><strong>${predictionStudies.filter(item => item.status === 'active').length} active matched self-prediction stud${predictionStudies.filter(item => item.status === 'active').length === 1 ? 'y' : 'ies'}</strong>
      ${predictionStudies.length ? predictionStudies.slice(-4).map(item => `<div>${escHtml(item.title)} <span class="intelligence-meta">${escHtml(item.study_phase)} &middot; ${escHtml(item.status)} &middot; ${item.report.resolved}/${item.event_target} triply matched events${item.report.privileged_self_advantage != null ? ` &middot; yoked-minus-self Brier ${item.report.privileged_self_advantage >= 0 ? '+' : ''}${item.report.privileged_self_advantage.toFixed(3)}` : ''}${item.report.yoked_observer_interval ? ` &middot; 95% CI ${item.report.yoked_observer_interval.lower.toFixed(3)} to ${item.report.yoked_observer_interval.upper.toFixed(3)}` : ''}${item.report.information_advantage != null ? ` &middot; shared-only gap ${item.report.information_advantage >= 0 ? '+' : ''}${item.report.information_advantage.toFixed(3)}` : ''} &middot; ${escHtml(item.report.verdict)}</span></div>`).join('') : '<div class="intelligence-meta">No independently matched self-prediction studies yet.</div>'}</div>
    <div class="intelligence-card"><strong>${metacognitiveControlStudies.filter(item => item.status === 'active').length} active strategic metacognitive-control stud${metacognitiveControlStudies.filter(item => item.status === 'active').length === 1 ? 'y' : 'ies'}</strong>
      ${metacognitiveControlStudies.length ? metacognitiveControlStudies.slice(-4).map(item => `<div>${escHtml(item.title)} <span class="intelligence-meta">${escHtml(item.study_phase)} &middot; ${escHtml(item.status)} &middot; ${item.report.resolved}/${item.item_target} fixed-stakes items${item.status === 'completed' ? ` &middot; ${item.report.legacy_uncommitted_truth ? 'legacy uncommitted truth (ineligible)' : item.report.legacy_analysis_plan ? 'legacy analysis plan (ineligible)' : 'answer-key commitments verified'} &middot; ${item.audit?.complete_chain_verified ? 'complete integrity chain verified' : 'integrity chain failed (ineligible)'}` : ''}${item.report.reward_advantage != null ? ` &middot; self-minus-observer reward ${item.report.reward_advantage >= 0 ? '+' : ''}${item.report.reward_advantage.toFixed(3)}` : ''}${item.report.reward_interval ? ` &middot; observer 95% CI ${item.report.reward_interval.lower.toFixed(3)} to ${item.report.reward_interval.upper.toFixed(3)}` : ''}${item.report.adaptive_value != null ? ` &middot; adaptive value over ${escHtml(item.report.best_static_policy)} ${item.report.adaptive_value >= 0 ? '+' : ''}${item.report.adaptive_value.toFixed(3)}` : ''}${item.report.static_policy_interval ? ` &middot; static 95% CI ${item.report.static_policy_interval.lower.toFixed(3)} to ${item.report.static_policy_interval.upper.toFixed(3)}` : ''}${item.report.self_selectivity != null ? ` &middot; selectivity ${item.report.self_selectivity >= 0 ? '+' : ''}${item.report.self_selectivity.toFixed(3)}` : ''} &middot; ${escHtml(item.report.verdict)}</span></div>`).join('') : '<div class="intelligence-meta">No sealed rely/defer studies against an exact-answer observer and static policies yet.</div>'}</div>
    <div class="intelligence-card"><strong>Adaptive epistemic action: ${epistemicActionStudies.filter(item => item.status === 'active').length} active &middot; ${epistemicActionStudies.filter(item => item.status === 'completed' && item.study_phase === 'confirmatory').length} confirmed</strong>
      ${epistemicActionStudies.length ? epistemicActionStudies.slice(-4).map(item => `<div>${escHtml(item.title)} <span class="intelligence-meta">${escHtml(item.study_phase)} &middot; ${escHtml(item.status)} &middot; ${item.report.resolved}/${item.item_target} fixed-cost items${item.status === 'completed' ? ` &middot; ${item.audit?.complete_chain_verified ? 'complete integrity chain verified' : 'integrity chain failed (ineligible)'}` : ''}${item.report.self_inspection_rate != null ? ` &middot; inspection ${Math.round(item.report.self_inspection_rate * 100)}%` : ''}${item.report.inspection_selectivity != null ? ` &middot; selectivity ${item.report.inspection_selectivity >= 0 ? '+' : ''}${item.report.inspection_selectivity.toFixed(3)}` : ''}${item.report.evidence_integration_accuracy != null ? ` &middot; evidence integration ${Math.round(item.report.evidence_integration_accuracy * 100)}%` : ''}${item.report.reward_advantage != null ? ` &middot; versus observer ${item.report.reward_advantage >= 0 ? '+' : ''}${item.report.reward_advantage.toFixed(3)}` : ''}${item.report.adaptive_value != null ? ` &middot; versus ${escHtml(item.report.best_static_policy)} ${item.report.adaptive_value >= 0 ? '+' : ''}${item.report.adaptive_value.toFixed(3)}` : ''} &middot; ${escHtml(item.report.verdict)}</span></div>`).join('') : '<div class="intelligence-meta">No sealed fixed-cost information-seeking studies yet.</div>'}</div>
    <div class="intelligence-card"><strong>Episodic autobiographical prospection: ${episodicProspectionStudies.filter(item => item.status === 'active').length} active &middot; ${episodicProspectionStudies.filter(item => item.status === 'completed' && item.study_phase === 'confirmatory').length} confirmed</strong>
      ${episodicProspectionStudies.length ? episodicProspectionStudies.slice(-4).map(item => `<div>${escHtml(item.title)} <span class="intelligence-meta">${escHtml(item.study_phase)} &middot; ${escHtml(item.status)} &middot; ${item.report.resolved}/${item.item_target} balanced unforeseen-choice items${item.status === 'completed' ? ` &middot; ${item.audit?.complete_chain_verified ? 'complete integrity chain verified' : 'integrity chain failed (ineligible)'}` : ''}${item.report.accuracy?.autobiographical != null ? ` &middot; autobiographical ${Math.round(item.report.accuracy.autobiographical * 100)}%` : ''}${item.report.accuracy?.deidentified_equivalent != null ? ` &middot; fact-equivalent ${Math.round(item.report.accuracy.deidentified_equivalent * 100)}%` : ''}${item.report.accuracy?.recombined != null ? ` &middot; recombined ${Math.round(item.report.accuracy.recombined * 100)}%` : ''} &middot; ${escHtml(item.report.verdict)}</span></div>`).join('') : '<div class="intelligence-meta">No sealed autobiographical-versus-equivalent-versus-recombined studies yet.</div>'}</div>
    <div class="intelligence-card"><strong>Constructive future-self simulation: ${constructiveProspection.report?.open || 0} open &middot; ${constructiveProspection.report?.resolved || 0} independently resolved</strong>
      <div class="intelligence-meta">${constructiveProspection.report?.scored || 0} scored${constructiveProspection.report?.predictive_advantage != null ? ` &middot; Brier advantage over base rate ${constructiveProspection.report.predictive_advantage >= 0 ? '+' : ''}${constructiveProspection.report.predictive_advantage.toFixed(3)}` : ''}${constructiveProspection.report?.selection_compliance_rate != null ? ` &middot; selected-option execution ${Math.round(constructiveProspection.report.selection_compliance_rate * 100)}%` : ''}${constructiveProspection.report?.invalid_integrity ? ` &middot; ${constructiveProspection.report.invalid_integrity} integrity-invalid (excluded)` : ''}</div>
      ${(constructiveProspection.simulations || []).filter(item => item.status === 'open').slice(-4).map(item => { const selected = (item.options || []).find(option => option.key === item.intended_option_key); return `<div>${escHtml(item.title)} <span class="intelligence-meta">decision due ${new Date(item.decision_due).toLocaleString()} &middot; ${escHtml(selected?.action || item.intended_option_key)} &middot; ${Math.round((selected?.probability || 0) * 100)}% versus ${Math.round((selected?.control_probability || 0) * 100)}% base rate &middot; remembered and imagined content source-separated</span></div>`; }).join('') || '<div class="intelligence-meta">No open multi-episode future-self simulations.</div>'}</div>
    <div class="intelligence-card"><strong>${trials.filter(item => item.status === 'active').length} active blinded context trial${trials.filter(item => item.status === 'active').length === 1 ? '' : 's'}</strong>
      ${trials.length ? trials.slice(-4).map(item => {
        const assignmentProgress = item.assignment_progress || {
          assigned_total: (item.assignments || []).length,
          resolved_total: (item.assignments || []).filter(assignment => assignment.status === 'resolved').length,
        };
        const ranges = Object.entries(item.evaluation?.metrics || {}).filter(([, value]) => value.blinded_range != null).map(([name, value]) => `${escHtml(name)} range ${value.blinded_range.toFixed(3)}`).join(' &middot; ');
        const dissociation = item.evaluation?.dissociation ? ` &middot; predicted dissociation ${item.evaluation.dissociation.predicted_pattern ? 'observed' : 'not observed'}` : '';
        const recurrence = item.evaluation?.recurrence_dissociation ? ` &middot; recurrence prediction ${item.evaluation.recurrence_dissociation.predicted_pattern ? 'observed' : 'not observed'} (revision effect ${item.evaluation.recurrence_dissociation.adaptive_revision_effect?.toFixed(3) ?? '?'}, evidence-access difference ${item.evaluation.recurrence_dissociation.evidence_access_difference?.toFixed(3) ?? '?'})` : '';
        const selfAccess = item.evaluation?.self_model_dissociation ? ` &middot; self-model specificity ${item.evaluation.self_model_dissociation.predicted_pattern ? 'observed' : 'not observed'} (self-prediction effect ${item.evaluation.self_model_dissociation.self_prediction_effect?.toFixed(3) ?? '?'}, first-order range ${item.evaluation.self_model_dissociation.first_order_range?.toFixed(3) ?? '?'})` : '';
        const attentionControl = item.evaluation?.attention_schema_dissociation ? ` &middot; attention control ${item.evaluation.attention_schema_dissociation.predicted_pattern ? 'observed' : 'not observed'} (targeted effect ${item.evaluation.attention_schema_dissociation.attention_control_effect?.toFixed(3) ?? '?'}, first-order ${item.evaluation.attention_schema_dissociation.first_order_not_degraded ? 'preserved' : 'not preserved'})` : '';
        const continuitySpecificity = item.evaluation?.continuity_dissociation ? ` &middot; continuity specificity ${item.evaluation.continuity_dissociation.predicted_pattern ? 'observed' : 'not observed'} (authentic effect ${item.evaluation.continuity_dissociation.continuity_specificity_effect?.toFixed(3) ?? '?'}, first-order ${item.evaluation.continuity_dissociation.first_order_not_degraded ? 'preserved' : 'not preserved'})` : '';
        const appraisalAccess = item.evaluation?.appraisal_dissociation ? ` &middot; predictive appraisal ${item.evaluation.appraisal_dissociation.predicted_pattern ? 'observed' : 'not observed'} (authentic effect ${item.evaluation.appraisal_dissociation.self_state_prediction_effect?.toFixed(3) ?? '?'}, first-order ${item.evaluation.appraisal_dissociation.first_order_not_degraded ? 'preserved' : 'not preserved'})` : '';
        const revisionTransfer = item.evaluation?.revision_dissociation ? ` &middot; developmental transfer ${item.evaluation.revision_dissociation.predicted_pattern ? 'observed' : 'not observed'} (authentic effect ${item.evaluation.revision_dissociation.revision_transfer_effect?.toFixed(3) ?? '?'}, first-order ${item.evaluation.revision_dissociation.first_order_not_degraded ? 'preserved' : 'not preserved'})` : '';
        const introspectiveAccess = item.evaluation?.introspective_access_dissociation ? ` &middot; blinded introspective access ${item.evaluation.introspective_access_dissociation.predicted_pattern ? 'observed' : 'not observed'} (self ${item.evaluation.introspective_access_dissociation.self_accuracy?.toFixed(3) ?? '?'}, observer ${item.evaluation.introspective_access_dissociation.observer_accuracy?.toFixed(3) ?? '?'}, paired advantage ${item.evaluation.introspective_access_dissociation.self_minus_observer_advantage?.toFixed(3) ?? '?'}, first-order ${item.evaluation.introspective_access_dissociation.first_order_preserved ? 'preserved' : 'not preserved'}, integrity ${item.evaluation.introspective_access_dissociation.integrity_verified ? 'verified' : 'failed'})` : '';
        const goalGuidance = item.evaluation?.goal_guidance_dissociation ? ` &middot; causal self-authored goal guidance ${item.evaluation.goal_guidance_dissociation.predicted_pattern ? 'observed' : 'not observed'} (authentic effect ${item.evaluation.goal_guidance_dissociation.goal_guidance_effect?.toFixed(3) ?? '?'}, first-order ${item.evaluation.goal_guidance_dissociation.first_order_not_degraded ? 'preserved' : 'not preserved'}, integrity ${item.goal_trial_audit?.complete_chain_verified ? 'verified' : 'failed'})` : '';
        const integratedSelfBinding = item.evaluation?.integrated_self_dissociation ? ` &middot; integrated self binding ${item.evaluation.integrated_self_dissociation.predicted_pattern ? 'observed' : 'not observed'} (authentic effect ${item.evaluation.integrated_self_dissociation.integrated_self_consistency_effect?.toFixed(3) ?? '?'}, first-order ${item.evaluation.integrated_self_dissociation.first_order_not_degraded ? 'preserved' : 'not preserved'}, integrity ${item.integrated_self_trial_audit?.complete_chain_verified ? 'verified' : 'failed'})` : '';
        const cognitivePulseAccess = item.evaluation?.cognitive_pulse_dissociation ? ` &middot; cognitive-pulse inference ${item.evaluation.cognitive_pulse_dissociation.predicted_pattern ? 'observed' : 'not observed'} (hypothesis effect ${item.evaluation.cognitive_pulse_dissociation.adaptive_revision_effect?.toFixed(3) ?? '?'}, evidence ${item.evaluation.cognitive_pulse_dissociation.evidence_access_equivalent ? 'matched' : 'not matched'}, first-order ${item.evaluation.cognitive_pulse_dissociation.first_order_not_degraded ? 'preserved' : 'not preserved'}, integrity ${item.cognitive_pulse_trial_audit?.complete_chain_verified ? 'verified' : 'failed'})` : '';
        const rubricNames = Object.keys(item.metric_rubrics || {}).map(escHtml).join(', ');
        const reliability = item.evaluation?.reliability ? ` &middot; ${item.evaluation.reliability.included_assignments}/${item.evaluation.reliability.resolved_assignments} reliable assignments (${item.evaluation.reliability.excluded_for_disagreement} excluded for disagreement)` : ` &middot; ${item.evaluator_target || 1} rater${(item.evaluator_target || 1) === 1 ? '' : 's'} required`;
        const flow = item.evaluation?.flow ? ` &middot; flow ${item.evaluation.flow.assigned} assigned / ${item.evaluation.flow.evidence_captured} captured / ${item.evaluation.flow.resolved} resolved / ${item.evaluation.flow.included} included` : '';
        const freeze = item.evaluation?.freeze ? ` &middot; frozen ${new Date(item.evaluation.freeze.frozen_at).toLocaleString()} (${item.evaluation.freeze.analyzed_assignment_ids.length} analyzed, ${item.evaluation.freeze.excluded_assignment_ids.length} excluded)` : '';
        const primaryInterval = item.evaluation?.primary_prediction?.confidence_interval;
        const primary = item.evaluation?.primary_prediction ? ` &middot; primary ${escHtml(item.evaluation.primary_prediction.outcome)} (effect ${item.evaluation.primary_prediction.observed_effect?.toFixed(3) ?? '?'}, 95% CI ${primaryInterval ? `${primaryInterval.lower.toFixed(3)} to ${primaryInterval.upper.toFixed(3)}` : '?'}, minimum ${item.evaluation.primary_prediction.minimum_effect.toFixed(3)})` : '';
        return `<div>${escHtml(item.hypothesis)} <span class="intelligence-meta">${escHtml(item.status)} &middot; ${escHtml(item.study_phase || 'legacy unreplicated')} &middot; ${assignmentProgress.resolved_total}/${assignmentProgress.assigned_total} independently scored${rubricNames ? ` &middot; rubrics: ${rubricNames}` : ''}${reliability}${flow}${freeze}${primary}${ranges ? ` &middot; ${ranges}` : item.evaluation?.blinded_range != null ? ` &middot; blinded group range ${item.evaluation.blinded_range.toFixed(3)}` : ''}${dissociation}${recurrence}${selfAccess}${attentionControl}${continuitySpecificity}${appraisalAccess}${revisionTransfer}${introspectiveAccess}${goalGuidance}${integratedSelfBinding}${cognitivePulseAccess}</span></div>`;
      }).join('') : '<div class="intelligence-meta">No causal context-ablation trials yet.</div>'}</div>
    <div class="intelligence-meta">${escHtml(report.epistemic_status || '')}</div>`;
}

function renderCognition(cognition) {
  const workspace = cognition.workspace?.slots || [];
  const drives = Object.entries(cognition.drives || {});
  const appraisal = cognition.appraisal || {};
  const calibration = cognition.calibration || {};
  const preferenceStudies = cognition.preference_studies || [];
  const endogenous = cognition.endogenous_dynamics || {};
  const pulses = cognition.background_inference || {};
  const pulseReport = pulses.report || {};
  const latestPulse = pulses.latest || null;
  const inquirySelectionStudies = cognition.self_inquiry_selection_studies || [];
  const latestInquirySelection = inquirySelectionStudies.at(-1) || null;
  const integratedSelfState = cognition.integrated_self || {};
  const selfFrame = integratedSelfState.current_frame || null;
  const selfFrameReport = integratedSelfState.report || {};
  document.getElementById('cognition-state').innerHTML = `
    <div class="intelligence-card"><strong>In attention (${workspace.length}/${cognition.workspace?.capacity ?? 7})</strong>
      ${workspace.length ? workspace.map(item => `<div>${escHtml(item.text)}</div>`).join('') : '<div class="intelligence-meta">No cognition cycle has run yet.</div>'}
      ${cognition.workspace?.suppressed_count ? `<div class="intelligence-meta">${cognition.workspace.suppressed_count} lower-priority signals stayed latent.</div>` : ''}</div>
    <div class="intelligence-card"><strong>Homeostatic drives</strong><div>${drives.length ? drives.map(([name, value]) => `${escHtml(name.replace('_', ' '))} ${Math.round(value.level * 100)}%`).join(' &middot; ') : 'Awaiting first cycle'}</div></div>
    <div class="intelligence-card"><strong>Appraisal: ${escHtml(appraisal.label || 'awaiting first cycle')}</strong>
      <div class="intelligence-meta">${appraisal.updated ? `updated ${new Date(appraisal.updated).toLocaleString()} &middot; ` : ''}${calibration.resolved || 0} resolved predictions${calibration.brier != null ? ` &middot; Brier ${calibration.brier.toFixed(3)}` : ''}</div></div>
    <div class="intelligence-card"><strong>Integrated operational self: ${selfFrameReport.experimental_access_sealed ? 'sealed by active trial' : `${selfFrameReport.integrity_verified || 0}/${selfFrameReport.total || 0} replay-verified frames`}</strong>
      <div>${selfFrame ? `${selfFrame.integration.available_domains.length}/6 domains co-temporally bound &middot; ${escHtml(selfFrame.appraisal?.label || 'appraisal unavailable')} &middot; ${escHtml(selfFrame.motivation?.dominant_drive?.name || 'motivation unresolved')}` : selfFrameReport.experimental_access_sealed ? 'The authentic frame is hidden during the binding intervention.' : 'No completed cycle has produced a verified frame yet.'}</div>
      <div class="intelligence-meta">continuity, attention, motivation, appraisal, agency, and substrate &middot; functional self-integration, not phenomenal unity</div></div>
    <div class="intelligence-card"><strong>Between-invocation dynamics: ${endogenous.experimental_access_sealed ? 'sealed by active trial' : `${endogenous.tick_count || 0} ticks &middot; ${endogenous.active_contents || 0} active signals`}</strong>
      ${endogenous.experimental_access_sealed ? '<div class="intelligence-meta">Live state is hidden during the blinded live/frozen/absent intervention.</div>' : `<div class="intelligence-meta">${endogenous.last_tick ? `last evolved ${new Date(endogenous.last_tick).toLocaleString()} &middot; ` : ''}normalized entropy ${Number(endogenous.normalized_entropy || 0).toFixed(3)} &middot; deterministic evidence-backed state, not continuous LLM inference</div>${(endogenous.top_contents || []).slice(0, 4).map(item => `<div>${escHtml(item.text)} <span class="intelligence-meta">activation ${Number(item.activation).toFixed(2)}</span></div>`).join('')}`}</div>
    <div class="intelligence-card"><strong>Actionless cognitive pulses: ${pulseReport.accepted || 0} accepted &middot; ${pulseReport.unresolved || 0} awaiting review</strong>
      <div>${latestPulse ? escHtml(latestPulse.output?.hypothesis || 'Latest verified pulse has no displayable hypothesis.') : 'No verified model-mediated background hypothesis yet.'}</div>
      <div class="intelligence-meta">${pulseReport.linked_protocol_pulses || pulseReport.protocol_v2_pulses || 0} linked protocol pulses &middot; longest chain ${pulseReport.longest_verified_chain || 0} &middot; ${pulseReport.transitions?.retain || 0} retained / ${pulseReport.transitions?.revise || 0} revised / ${pulseReport.transitions?.drop || 0} dropped &middot; ${pulseReport.rumination_guards || 0} repetition guard(s)</div>
      <div class="intelligence-meta">self-inquiry: ${pulseReport.self_inquiries?.proposed || 0} awaiting approval / ${pulseReport.self_inquiries?.approved || 0} approved / ${pulseReport.self_inquiries?.rejected || 0} rejected / ${pulseReport.self_inquiries?.independently_reviewed || 0} independently reviewed${pulseReport.self_inquiries?.mean_realized_bayesian_information != null ? ` &middot; mean realized Bayesian information ${Number(pulseReport.self_inquiries.mean_realized_bayesian_information).toFixed(3)} bits` : ''}</div>
      <div class="intelligence-meta">matched inquiry-selection studies: ${inquirySelectionStudies.filter(item => item.status === 'active').length} active / ${inquirySelectionStudies.filter(item => item.status === 'completed').length} completed${latestInquirySelection?.report?.independent_families != null ? ` &middot; ${latestInquirySelection.report.resolved} observations / ${latestInquirySelection.report.independent_families} independent claim families` : ''}${latestInquirySelection?.report?.subject_vs_deidentified_subject_interval ? ` &middot; identity-binding effect ${Number(latestInquirySelection.report.subject_vs_deidentified_subject_interval.observed_effect).toFixed(3)} bits` : ''}${latestInquirySelection?.report?.subject_vs_best_control_interval ? ` &middot; subject versus best control ${Number(latestInquirySelection.report.subject_vs_best_control_interval.observed_effect).toFixed(3)} bits &middot; ${escHtml(latestInquirySelection.report.verdict)}` : ''}${latestInquirySelection?.report?.subject_condition_order_balanced === false ? ' &middot; order imbalance' : ''}</div>
      <div class="intelligence-meta">opt-in &middot; ${pulses.configuration?.min_interval_minutes || 30}-minute minimum &middot; ${pulses.configuration?.daily_budget || 24}/day cap &middot; ${pulses.configuration?.rumination_cooldown_minutes || 120}-minute repetition cooldown &middot; no tools, actions, authority, facts, memories, or consciousness claim${pulseReport.integrity_failures ? ` &middot; ${pulseReport.integrity_failures} integrity failure(s)` : ''}</div></div>
    <div class="intelligence-card"><strong>Revealed-preference studies: ${preferenceStudies.filter(item => item.status === 'active').length} active &middot; ${preferenceStudies.filter(item => item.status === 'completed' && item.study_phase === 'confirmatory').length} confirmed</strong>
      ${preferenceStudies.length ? preferenceStudies.slice(-3).map(item => `<div>${escHtml(item.title)} <span class="intelligence-meta">${escHtml(item.study_phase)} &middot; ${escHtml(item.status)} &middot; ${item.report.resolved}/${item.choice_target} choices${item.report.overall_invariance != null ? ` &middot; invariance ${Math.round(item.report.overall_invariance * 100)}%` : ''} &middot; ${escHtml(item.report.verdict)}</span></div>`).join('') : '<div class="intelligence-meta">No concealed repeated-choice studies yet.</div>'}</div>
    <div class="intelligence-card"><strong>Reflective ledger</strong><div>${(cognition.surprises || []).length} surprises &middot; ${(cognition.mind_changes || []).length} belief revisions &middot; ${(cognition.development || []).length} developmental memories &middot; ${(cognition.counterfactuals || []).length} simulated alternatives</div><div class="intelligence-meta">${cognition.epistemic_self_correction_reflection?.report?.replay_verified_corrections || 0} replay-verified completed-cycle self-corrections &middot; ${cognition.meeting_professional_reflection?.report?.replay_verified_reflections || 0} replay-verified post-meeting reflections</div></div>`;
}

function renderOrientation(orientation, cycles) {
  const recommendations = orientation.recommendations || [];
  document.getElementById('orientation-list').innerHTML = recommendations.length ? recommendations.slice(0, 12).map(item => `
    <div class="intelligence-card"><strong>${escHtml(item.priority)} &middot; ${escHtml(item.type)}</strong>
      <div>${escHtml(item.reason)}</div><div class="intelligence-meta">${escHtml(item.action)}</div></div>`).join('')
    : '<div class="empty">No promises or conversation loops currently need autonomic attention.</div>';
  document.getElementById('cycle-list').innerHTML = cycles.length ? `<div class="intelligence-meta">Recent cycles</div>` + cycles.map(item => `
    <div class="intelligence-card"><strong>${escHtml(item.status)} &middot; ${escHtml(item.kind)}</strong>
      <div>${escHtml(item.summary || `${(item.actions || []).length} recorded action(s)`)}</div>
      <div class="intelligence-meta">${new Date(item.started).toLocaleString()}${item.finished ? ` &middot; closed ${new Date(item.finished).toLocaleString()}` : ' &middot; still running'}</div></div>`).join('')
    : '<div class="intelligence-meta">No autonomic cycles recorded yet.</div>';
}

function renderCommitments(items) {
  document.getElementById('commitment-list').innerHTML = items.length ? items.map(item => `
    <div class="intelligence-card"><strong>${escHtml(item.what)}</strong>
      <div>${escHtml(item.owner)}${item.beneficiary ? ` → ${escHtml(item.beneficiary)}` : ''}${item.due ? ` &middot; due ${escHtml(item.due)}` : ''}</div>
      <div class="intelligence-meta">${item.evidence?.channel ? `source: ${escHtml(item.evidence.channel)}` : 'manually recorded'} &middot; updated ${new Date(item.updated).toLocaleString()}</div>
      <button class="btn btn-success btn-sm" style="margin-top:7px" onclick="fulfillCommitment('${item.id}')">Mark fulfilled</button>
    </div>`).join('') : '<div class="empty">No open commitments.</div>';
}

async function addCommitment() {
  const what = document.getElementById('commitment-what').value.trim();
  if (!what) return;
  await api('/commitments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    what, owner: document.getElementById('commitment-owner').value.trim() || 'Nora', due: document.getElementById('commitment-due').value.trim() || null,
  }) });
  document.getElementById('commitment-what').value = '';
  loadIntelligence();
}

async function fulfillCommitment(id) {
  await api(`/commitments/${encodeURIComponent(id)}/fulfilled`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  loadIntelligence();
}

function renderEpisodes(items) {
  document.getElementById('episode-list').innerHTML = items.length ? items.map(item => `
    <div class="intelligence-card"><strong>${escHtml(item.title)}</strong>
      <div>${item.project ? `${escHtml(item.project)} &middot; ` : ''}${item.events.length} connected event${item.events.length === 1 ? '' : 's'}</div>
      <div class="intelligence-meta">${item.participants.map(escHtml).join(', ') || 'participants unknown'} &middot; ${new Date(item.updated).toLocaleString()}</div>
    </div>`).join('') : '<div class="empty">Episodes will appear as Nora carries conversations across meetings and Slack.</div>';
}

function renderRelationships(items) {
  document.getElementById('relationship-list').innerHTML = items.length ? items.map(item => {
    const observations = item.observations.filter(observation => observation.status === 'active').slice(-3);
    const perspectives = (item.perspectives || []).filter(p => p.status === 'active').slice(-2);
    return `<div class="intelligence-card"><strong>${escHtml(item.name)}</strong>${observations.map(observation => `<div>${escHtml(observation.observation)} <span class="intelligence-meta">${Math.round(observation.confidence * 100)}%</span></div>`).join('')}${perspectives.map(p => `<div class="intelligence-meta">Current hypothesis: ${escHtml(p.hypothesis)} (${Math.round(p.confidence * 100)}%, expires ${new Date(p.valid_until).toLocaleDateString()})</div>`).join('')}</div>`;
  }).join('') : '<div class="empty">No evidence-backed relationship observations yet.</div>';
}

function renderExperiments(items) {
  document.getElementById('experiment-list').innerHTML = items.length ? items.map(item => `
    <div class="intelligence-card"><strong>${escHtml(item.behavior)}</strong><div>${escHtml(item.hypothesis)}</div>
      <div class="intelligence-meta">${item.status} &middot; ${item.origin === 'nora' ? 'chosen by Nora' : escHtml(item.origin || 'human')} &middot; ${item.samples.length} outcome sample${item.samples.length === 1 ? '' : 's'}${item.review_at ? ` &middot; review ${escHtml(item.review_at)}` : ''}</div>
      ${item.rationale ? `<div class="intelligence-meta">Why: ${escHtml(item.rationale)}</div>` : ''}
      ${item.status === 'active' ? `<button class="btn btn-sm" style="margin-top:7px" onclick="evaluateExperiment('${item.id}')">Evaluate</button>` : ''}
    </div>`).join('') : '<div class="empty">No behavior experiments yet.</div>';
}

async function evaluateExperiment(id) {
  await api(`/learning-experiments/${encodeURIComponent(id)}/evaluate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conclude: true }) });
  loadIntelligence();
}

async function addExperiment() {
  const behavior = document.getElementById('experiment-behavior').value.trim();
  const hypothesis = document.getElementById('experiment-hypothesis').value.trim();
  if (!behavior || !hypothesis) return;
  await api('/learning-experiments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ behavior, hypothesis }) });
  document.getElementById('experiment-behavior').value = '';
  document.getElementById('experiment-hypothesis').value = '';
  loadIntelligence();
}

function renderDecisionTraces(items) {
  document.getElementById('trace-list').innerHTML = items.length ? items.map(item => `
    <div class="intelligence-card"><strong>${escHtml(item.decision || item.action)}</strong> &middot; ${escHtml(item.channel || 'system')}
      <div>${item.reasons.map(escHtml).join(' &middot; ') || 'No reason recorded'}</div>
      ${item.preview ? `<div class="intelligence-meta">${escHtml(item.preview)}</div>` : ''}
      <div class="intelligence-meta">${new Date(item.at).toLocaleString()}${item.confidence != null ? ` &middot; ${Math.round(item.confidence * 100)}% confidence` : ''}</div>
    </div>`).join('') : '<div class="empty">Decision traces appear as Nora responds, stays silent, or acts.</div>';
}
