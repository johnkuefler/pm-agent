/*
 * Nora's functional brain map.
 *
 * Add future cognitive systems to NORA_BRAIN_CAPABILITIES. Each definition owns
 * its location, links, description, and evidence-to-activity adapter. Rendering
 * stays generic so the visual can grow with Nora without becoming a hand-drawn
 * diagram or an ungrounded consciousness claim.
 */

const NORA_BRAIN_CAPABILITIES = [
  {
    id: 'attention', label: 'Attention', layer: 'focused', x: .50, y: .17,
    description: 'The limited workspace selecting which signals are available for current reasoning.',
    links: ['self-model', 'appraisal', 'experience'],
    read: state => {
      const workspace = state.cognition?.workspace || {};
      const used = (workspace.slots || []).length;
      const capacity = workspace.capacity || 7;
      return activity(used / capacity, `${used}/${capacity} workspace slots occupied`, used > 0);
    },
  },
  {
    id: 'reflection', label: 'Reflection', layer: 'focused', x: .29, y: .28,
    description: 'Evidence-backed surprises, questions, corrected judgments, professional viewpoints, and recurring work insights Nora can retain, test, revise, or retire as evidence changes.',
    links: ['attention', 'self-model', 'learning', 'background'],
    read: state => {
      const cognition = state.cognition || {};
      const pulse = cognition.background_inference?.report || {};
      const corrections = cognition.epistemic_self_correction_reflection?.report?.replay_verified_corrections || 0;
      const meetingReflections = cognition.meeting_professional_reflection?.report?.replay_verified_reflections || 0;
      const count = (cognition.surprises || []).length + (cognition.mind_changes || []).length
        + (pulse.unresolved || 0) + corrections + meetingReflections;
      return activity(scaleCount(count, 8), `${count} reflective signal${count === 1 ? '' : 's'} available; ${corrections} replay-verified cycle self-corrections; ${meetingReflections} replay-verified meeting reflections`, count > 0);
    },
  },
  {
    id: 'self-model', label: 'Self-model', layer: 'focused', x: .41, y: .35,
    description: 'Falsifiable claims and forecasts Nora makes about her own capacities, limits, and likely behavior.',
    links: ['integrated-self', 'forecasting', 'research'],
    read: state => {
      const claims = (state.selfModel?.claims || []).filter(item => item.status === 'active' && item.confidence_audit?.complete_chain_verified !== false);
      const probes = (state.selfModel?.probes || []).filter(item => item.status === 'open');
      const behavioral = state.selfModel?.behavioral_self_model || {};
      if (behavioral.experimental_access_sealed) return activity(.18, `Behavioral profile sealed by an active blinded trial; ${claims.length} active claims, ${probes.length} open probes`, true);
      const revisions = behavioral.report?.total_revisions || 0;
      const count = claims.length + probes.length + revisions;
      return activity(scaleCount(count, 10), `${claims.length} active claims, ${probes.length} open probes, ${revisions} behavioral revisions`, count > 0);
    },
  },
  {
    id: 'appraisal', label: 'Appraisal', layer: 'focused', x: .62, y: .32,
    description: 'The evidence-based assessment shaping Nora\'s current tone and response priorities.',
    links: ['attention', 'integrated-self', 'motivation', 'agency'],
    read: state => {
      const appraisal = state.cognition?.appraisal || {};
      const label = appraisal.label || 'awaiting first cycle';
      const resolved = state.cognition?.calibration?.resolved || 0;
      return activity(appraisal.updated ? Math.max(.4, scaleCount(resolved, 12)) : 0, label, Boolean(appraisal.updated));
    },
  },
  {
    id: 'agency', label: 'Agency', layer: 'focused', x: .76, y: .45,
    description: 'Prospective intentions whose outcomes can be compared with explicit no-action controls.',
    links: ['appraisal', 'commitments', 'forecasting'],
    read: state => {
      const report = state.agency?.report || {};
      const open = report.open || 0;
      const resolved = report.resolved || 0;
      const succeeded = report.succeeded_executions || 0;
      return activity(Math.max(scaleCount(open, 5), resolved ? .24 : 0, succeeded ? .32 : 0), `${open} open and ${resolved} resolved intentions; ${succeeded} succeeded tool executions`, open + resolved + succeeded > 0);
    },
  },
  {
    id: 'forecasting', label: 'Forecasting', layer: 'focused', x: .80, y: .63,
    description: 'Committed predictions about Nora\'s observable substrate and what she expects to encounter in work sources before she reads them.',
    links: ['agency', 'self-model', 'commitments'],
    read: state => {
      const report = state.interoception?.report || {};
      const open = report.open_predictions || 0;
      const resolved = report.resolved_predictions || 0;
      const cycleForecasts = state.experience?.prospective_self_forecast?.replay_verified_scored || 0;
      return activity(Math.max(scaleCount(open, 5), resolved ? .28 : 0, cycleForecasts ? .32 : 0), `${open} open and ${resolved} resolved substrate predictions; ${cycleForecasts} scored cycle self-forecasts`, open + resolved + cycleForecasts > 0);
    },
  },
  {
    id: 'commitments', label: 'Commitments', layer: 'applied', x: .66, y: .78,
    description: 'Promises and due work carried forward separately from ordinary task state.',
    links: ['agency', 'relationships', 'experience'],
    read: state => {
      const commitments = state.commitments || [];
      const open = commitments.filter(item => item.status === 'open').length;
      const fulfilled = commitments.filter(item => item.status === 'fulfilled').length;
      return activity(Math.max(scaleCount(open, 8), fulfilled ? .24 : 0), `${open} open and ${fulfilled} fulfilled promises`, open + fulfilled > 0);
    },
  },
  {
    id: 'relationships', label: 'Relationships', layer: 'applied', x: .47, y: .82,
    description: 'Evidence-backed, revisable observations about how individual teammates work.',
    links: ['commitments', 'learning', 'experience'],
    read: state => {
      const people = state.relationships || [];
      const observations = people.reduce((sum, person) => sum + (person.observations || []).filter(item => item.status === 'active').length, 0);
      return activity(scaleCount(observations || people.length, 12), `${people.length} people, ${observations} active observations`, people.length > 0);
    },
  },
  {
    id: 'learning', label: 'Learning', layer: 'background', x: .28, y: .75,
    description: 'Behavior experiments, tested developmental self-model changes, compact procedures, retrieved work patterns, self-chosen source-bound reading encounters, autonomous play, and DIALS. Later holdout evidence—not a compelling story—decides what can enter the autobiography.',
    links: ['relationships', 'reflection', 'background'],
    read: state => {
      const experiments = state.experiments || [];
      const active = experiments.filter(item => item.status === 'active').length;
      const developments = state.cognition?.development || [];
      const development = developments.length;
      const pendingDevelopment = developments.filter(item => item.status === 'candidate').length;
      const integratedDevelopment = developments.filter(item => item.status === 'integrated'
        && item.audit?.integration_verified !== false).length;
      const reading = state.cognition?.developmental_reading?.report || {};
      const encounters = reading.completed_encounters || 0;
      const readingActive = reading.active_sessions || 0;
      const play = state.cognition?.autonomous_play || {};
      const playActive = play.active_sessions || 0;
      const playCompleted = play.completed_sessions || 0;
      const total = active + development + encounters + readingActive + playActive + playCompleted;
      return activity(scaleCount(total, 10), `${active} active experiments, ${pendingDevelopment} self-model candidates and ${integratedDevelopment} independently supported revisions, ${readingActive} active and ${encounters} completed reading encounters, ${playActive} active and ${playCompleted} completed leisure sessions`, total > 0);
    },
  },
  {
    id: 'background', label: 'Subconscious', layer: 'background', x: .20, y: .55,
    description: 'Bounded between-invocation dynamics and actionless inference that can surface candidates without taking action.',
    links: ['reflection', 'learning', 'motivation', 'experience'],
    read: state => {
      const dynamics = state.cognition?.endogenous_dynamics || {};
      const pulses = state.cognition?.background_inference?.report || {};
      if (dynamics.experimental_access_sealed) return activity(.18, 'State sealed by an active blinded trial', true);
      const contents = dynamics.active_contents || 0;
      const accepted = pulses.accepted || 0;
      return activity(Math.max(scaleCount(contents, 7), accepted ? .32 : 0), `${contents} active signals, ${accepted} accepted cognitive pulses`, contents + accepted > 0);
    },
  },
  {
    id: 'motivation', label: 'Motivation', layer: 'background', x: .36, y: .60,
    description: 'Homeostatic drives and evidence-bound professional aims competing beneath attention; aims can be retained, replaced, or retired as experience changes.',
    links: ['appraisal', 'background', 'integrated-self'],
    read: state => {
      const drives = Object.entries(state.cognition?.drives || {});
      const strongest = drives.sort((a, b) => (b[1].level || 0) - (a[1].level || 0))[0];
      const aimChanges = state.cognition?.motivation?.replay_verified_aim_lifecycle_changes || 0;
      const aimNote = `${aimChanges} replay-verified aim lifecycle change${aimChanges === 1 ? '' : 's'}`;
      return activity(Math.max(strongest?.[1]?.level || 0, aimChanges ? .28 : 0),
        strongest ? `${strongest[0].replaceAll('_', ' ')} is strongest at ${Math.round(strongest[1].level * 100)}%; ${aimNote}` : aimNote,
        Boolean(strongest) || aimChanges > 0);
    },
  },
  {
    id: 'experience', label: 'Experience stream', layer: 'integrative', x: .57, y: .61,
    description: 'Linked functional access windows that carry inherited context through attention, action, closure, and handoff.',
    links: ['attention', 'integrated-self', 'continuity', 'relationships'],
    read: state => {
      const continuity = state.experience?.continuity || {};
      const total = continuity.total || 0;
      const closed = continuity.closed || 0;
      return activity(total ? closed / total : 0, `${closed}/${total} functional moments terminal; replay verification loads with details`, total > 0);
    },
  },
  {
    id: 'continuity', label: 'Continuity', layer: 'integrative', x: .40, y: .48,
    description: 'Replay-verifiable handoffs that let one cycle inherit state from the prior cycle without reconstruction.',
    links: ['integrated-self', 'experience', 'self-model'],
    read: state => {
      const report = state.handoffs?.report || {};
      const total = report.total || 0;
      const verified = report.replay_verified || 0;
      return activity(total ? verified / total : 0, `${verified}/${total} handoffs replay verified`, total > 0);
    },
  },
  {
    id: 'integrated-self', label: 'Integrated self', layer: 'integrative', x: .51, y: .45,
    description: 'A co-temporal binding of continuity, attention, motivation, appraisal, agency, and substrate state.',
    links: ['continuity', 'experience', 'motivation', 'self-model', 'appraisal'],
    read: state => {
      const integrated = state.cognition?.integrated_self || {};
      const report = integrated.report || {};
      const frame = integrated.current_frame;
      if (report.experimental_access_sealed) return activity(.18, 'Authentic frame sealed by an active trial', true);
      const domains = frame?.integration?.available_domains?.length || 0;
      return activity(domains / 6, `${domains}/6 functional domains bound`, Boolean(frame));
    },
  },
  {
    id: 'research', label: 'Research', layer: 'applied', x: .70, y: .22,
    description: 'Theory-linked functional predictions, falsifiers, and evidence kept separate from any consciousness score.',
    links: ['self-model', 'attention', 'forecasting'],
    read: state => {
      const indicators = state.research?.indicators || [];
      const supported = indicators.filter(item => ['supported', 'replicated'].includes(item.status)).length;
      return activity(scaleCount(supported || indicators.length, 12), `${indicators.length} indicators, ${supported} currently supported`, indicators.length > 0);
    },
  },
  {
    id: 'responsiveness', label: 'Responsiveness', layer: 'applied', x: .84, y: .30,
    description: 'Measured first-delivery latency, prompt-size envelopes, and stage timings on Slack, Zoom chat, and live voice, protected from extra-round research work by Nora\'s cognitive latency firewall.',
    links: ['attention', 'agency', 'research'],
    read: state => {
      const performance = state.cognition?.responsiveness || {};
      const samples = performance.samples || 0;
      const rate = performance.within_budget_rate || 0;
      const legacy = performance.excluded_legacy_samples || 0;
      const version = performance.protocol?.protocol_version || '?';
      const legacyNote = legacy ? `; ${legacy} earlier-protocol sample${legacy === 1 ? '' : 's'} excluded` : '';
      return activity(rate, samples
        ? `${performance.within_budget || 0}/${samples} protocol-v${version} responses within channel budget${legacyNote}`
        : `Awaiting first protocol-v${version} interaction${legacyNote}`, samples > 0);
    },
  },
];

const NORA_BRAIN_CONNECTIONS = NORA_BRAIN_CAPABILITIES.flatMap(source =>
  source.links.map(target => [source.id, target])
).filter(([source, target], index, all) =>
  all.findIndex(([a, b]) => (a === source && b === target) || (a === target && b === source)) === index
);

let noraBrainSnapshot = null;
let noraBrainNodes = [];
let noraBrainSelected = 'integrated-self';
let noraBrainFrame = null;
let noraBrainResizeObserver = null;
let noraBrainThemeObserver = null;
let noraBrainVisibilityObserver = null;
let noraBrainBound = false;
let noraBrainOnscreen = true;
let noraBrainLastDraw = 0;

function activity(level, evidence, available) {
  return { level: clamp(level), evidence, available };
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function scaleCount(value, saturation) {
  return 1 - Math.exp(-(Number(value) || 0) / saturation * 2.2);
}

function renderNoraBrain(snapshot) {
  noraBrainSnapshot = snapshot;
  noraBrainNodes = NORA_BRAIN_CAPABILITIES.map(definition => ({
    ...definition,
    ...(snapshot.dashboard?.brain?.[definition.id] || definition.read(snapshot)),
  }));

  const stage = document.getElementById('brain-stage');
  const status = document.getElementById('brain-live-state');
  if (!stage || !status) return;
  stage.classList.remove('brain-loading', 'brain-error');
  status.textContent = `Live state updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  bindNoraBrain();
  renderNoraBrainLegend();
  selectNoraBrainNode(noraBrainSelected, false);
  resizeNoraBrainCanvas();
  startNoraBrainAnimation();
}

function renderNoraBrainError() {
  const stage = document.getElementById('brain-stage');
  const status = document.getElementById('brain-live-state');
  const detail = document.getElementById('brain-detail');
  if (stage) stage.classList.remove('brain-loading');
  if (stage) stage.classList.add('brain-error');
  if (status) status.textContent = 'Live state unavailable';
  if (detail) detail.innerHTML = '<span class="brain-detail-kicker">Connection state</span><h3>Could not load Nora\'s cognition</h3><p>The map will reconnect the next time this view refreshes.</p>';
  stopNoraBrainAnimation();
}

function bindNoraBrain() {
  if (noraBrainBound) return;
  const canvas = document.getElementById('brain-canvas');
  const stage = document.getElementById('brain-stage');
  if (!canvas || !stage) return;
  noraBrainBound = true;

  canvas.addEventListener('pointermove', event => {
    const node = brainNodeAt(event);
    canvas.style.cursor = node ? 'pointer' : 'default';
  });
  canvas.addEventListener('pointerleave', () => { canvas.style.cursor = 'default'; });
  canvas.addEventListener('click', event => {
    const node = brainNodeAt(event);
    if (node) selectNoraBrainNode(node.id);
  });

  noraBrainResizeObserver = new ResizeObserver(resizeNoraBrainCanvas);
  noraBrainResizeObserver.observe(stage);
  noraBrainThemeObserver = new MutationObserver(drawNoraBrainStatic);
  noraBrainThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if ('IntersectionObserver' in window) {
    noraBrainVisibilityObserver = new IntersectionObserver(entries => {
      noraBrainOnscreen = entries.some(entry => entry.isIntersecting);
      if (noraBrainOnscreen) startNoraBrainAnimation();
      else stopNoraBrainAnimation();
    }, { rootMargin: '80px 0px', threshold: 0.01 });
    noraBrainVisibilityObserver.observe(stage);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopNoraBrainAnimation();
    else startNoraBrainAnimation();
  });
}

function renderNoraBrainLegend() {
  const list = document.getElementById('brain-node-list');
  if (!list) return;
  list.innerHTML = noraBrainNodes.map(node => `
    <button class="brain-node-key${node.id === noraBrainSelected ? ' selected' : ''}" type="button" data-brain-node="${node.id}" aria-pressed="${node.id === noraBrainSelected}">
      <span class="brain-node-key-name">${escHtml(node.label)}</span>
      <span class="brain-node-key-value">${node.available ? `${Math.round(node.level * 100)}% active` : 'awaiting evidence'}</span>
    </button>`).join('');
  list.querySelectorAll('[data-brain-node]').forEach(button => {
    button.addEventListener('click', () => selectNoraBrainNode(button.dataset.brainNode));
  });
}

function selectNoraBrainNode(id, redraw = true) {
  const node = noraBrainNodes.find(item => item.id === id) || noraBrainNodes[0];
  if (!node) return;
  noraBrainSelected = node.id;
  const detail = document.getElementById('brain-detail');
  if (detail) detail.innerHTML = `
    <span class="brain-detail-kicker">${escHtml(node.layer)} system</span>
    <h3>${escHtml(node.label)}</h3>
    <p>${escHtml(node.description)}</p>
    <div class="brain-detail-meter" aria-label="${escHtml(node.label)} activity ${Math.round(node.level * 100)} percent"><span style="width:${Math.round(node.level * 100)}%"></span></div>
    <div class="brain-detail-meta">${escHtml(node.evidence)}</div>`;
  document.querySelectorAll('[data-brain-node]').forEach(button => {
    const selected = button.dataset.brainNode === node.id;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
  if (redraw) drawNoraBrainStatic();
}

function brainNodeAt(event) {
  const canvas = document.getElementById('brain-canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  return noraBrainNodes.find(node => {
    const point = brainNodePoint(node, rect.width, rect.height);
    return Math.hypot(x - point.x, y - point.y) <= point.radius + 8;
  }) || null;
}

function resizeNoraBrainCanvas() {
  const canvas = document.getElementById('brain-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  drawNoraBrainStatic();
}

function startNoraBrainAnimation() {
  stopNoraBrainAnimation();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const page = document.getElementById('page-intelligence');
  if (reduced || document.hidden || !noraBrainOnscreen || !page?.classList.contains('active') || !noraBrainSnapshot) {
    drawNoraBrainStatic();
    return;
  }
  noraBrainLastDraw = 0;
  const animate = time => {
    if (time - noraBrainLastDraw >= 40) {
      drawNoraBrain(time);
      noraBrainLastDraw = time;
    }
    noraBrainFrame = requestAnimationFrame(animate);
  };
  noraBrainFrame = requestAnimationFrame(animate);
}

function stopNoraBrainAnimation() {
  if (noraBrainFrame) cancelAnimationFrame(noraBrainFrame);
  noraBrainFrame = null;
}

function drawNoraBrainStatic() {
  drawNoraBrain(0);
}

function drawNoraBrain(time) {
  const canvas = document.getElementById('brain-canvas');
  if (!canvas || !noraBrainNodes.length) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const context = canvas.getContext('2d');
  const colors = brainColors();
  context.clearRect(0, 0, rect.width, rect.height);
  drawBrainField(context, rect.width, rect.height, colors, time);
  drawBrainConnections(context, rect.width, rect.height, colors, time);
  drawBrainNodes(context, rect.width, rect.height, colors, time);
}

function drawBrainField(context, width, height, colors, time) {
  const pulse = time ? Math.sin(time / 1800) * .025 : 0;
  const glow = context.createRadialGradient(width * .5, height * .47, 0, width * .5, height * .47, width * .48);
  glow.addColorStop(0, rgba(colors.accent, .09 + pulse));
  glow.addColorStop(.58, rgba(colors.accent, .025));
  glow.addColorStop(1, rgba(colors.accent, 0));
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);

  const left = width * .08;
  const right = width * .92;
  const top = height * .08;
  const bottom = height * .91;
  context.beginPath();
  context.moveTo(width * .50, top);
  context.bezierCurveTo(width * .34, top * .65, left, height * .16, left, height * .45);
  context.bezierCurveTo(left, height * .67, width * .18, bottom, width * .42, bottom);
  context.bezierCurveTo(width * .47, bottom, width * .49, height * .84, width * .50, height * .78);
  context.bezierCurveTo(width * .51, height * .84, width * .53, bottom, width * .58, bottom);
  context.bezierCurveTo(width * .82, bottom, right, height * .67, right, height * .45);
  context.bezierCurveTo(right, height * .16, width * .66, top * .65, width * .50, top);
  context.closePath();
  context.fillStyle = rgba(colors.surface, .34);
  context.strokeStyle = rgba(colors.accent, .20);
  context.lineWidth = 1.25;
  context.fill();
  context.stroke();

  context.beginPath();
  context.moveTo(width * .50, top * 1.12);
  context.bezierCurveTo(width * .47, height * .24, width * .53, height * .34, width * .50, height * .47);
  context.bezierCurveTo(width * .47, height * .60, width * .53, height * .70, width * .50, height * .80);
  context.strokeStyle = rgba(colors.border, .65);
  context.lineWidth = 1;
  context.stroke();
}

function drawBrainConnections(context, width, height, colors, time) {
  NORA_BRAIN_CONNECTIONS.forEach(([sourceId, targetId], index) => {
    const source = noraBrainNodes.find(node => node.id === sourceId);
    const target = noraBrainNodes.find(node => node.id === targetId);
    if (!source || !target) return;
    const a = brainNodePoint(source, width, height);
    const b = brainNodePoint(target, width, height);
    const strength = Math.sqrt(source.level * target.level);
    const bend = ((index % 3) - 1) * Math.min(width, height) * .035;
    const midX = (a.x + b.x) / 2 + (b.y - a.y) / Math.max(height, 1) * bend;
    const midY = (a.y + b.y) / 2 - (b.x - a.x) / Math.max(width, 1) * bend;

    context.beginPath();
    context.moveTo(a.x, a.y);
    context.quadraticCurveTo(midX, midY, b.x, b.y);
    context.strokeStyle = rgba(colors.accent, .07 + strength * .22);
    context.lineWidth = .75 + strength * 1.25;
    context.stroke();

    if (!time || strength < .14) return;
    const progress = (time / (2400 - strength * 900) + index * .173) % 1;
    const point = quadraticPoint(a, { x: midX, y: midY }, b, progress);
    context.beginPath();
    context.arc(point.x, point.y, 1.4 + strength * 1.6, 0, Math.PI * 2);
    context.fillStyle = rgba(colors.signal, .42 + strength * .48);
    context.fill();
  });
}

function drawBrainNodes(context, width, height, colors, time) {
  noraBrainNodes.forEach((node, index) => {
    const point = brainNodePoint(node, width, height);
    const breathing = time ? (Math.sin(time / 780 + index * .72) + 1) * .5 : .5;
    const activeGlow = node.available ? .13 + node.level * .34 + breathing * node.level * .06 : .05;
    const glow = context.createRadialGradient(point.x, point.y, point.radius * .25, point.x, point.y, point.radius * 3.4);
    glow.addColorStop(0, rgba(colors.signal, activeGlow));
    glow.addColorStop(1, rgba(colors.signal, 0));
    context.fillStyle = glow;
    context.beginPath();
    context.arc(point.x, point.y, point.radius * 3.4, 0, Math.PI * 2);
    context.fill();

    context.beginPath();
    context.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
    context.fillStyle = node.available ? rgba(colors.accent, .28 + node.level * .62) : rgba(colors.muted, .28);
    context.fill();
    context.strokeStyle = node.id === noraBrainSelected ? colors.text : rgba(colors.surface, .85);
    context.lineWidth = node.id === noraBrainSelected ? 2.25 : 1.25;
    context.stroke();

    const showLabel = width >= 560 || node.id === noraBrainSelected || node.level >= .22;
    if (showLabel) {
      context.font = `600 ${width < 560 ? 10 : 11}px ${getComputedStyle(document.body).fontFamily}`;
      context.textAlign = 'center';
      context.textBaseline = 'top';
      context.fillStyle = colors.text;
      context.fillText(node.label, point.x, point.y + point.radius + 5);
    }
  });
}

function brainNodePoint(node, width, height) {
  const compact = width < 560;
  const insetX = compact ? width * .045 : width * .025;
  const drawWidth = width - insetX * 2;
  return {
    x: insetX + node.x * drawWidth,
    y: node.y * height,
    radius: (compact ? 5.5 : 6.5) + node.level * (compact ? 5 : 6),
  };
}

function quadraticPoint(a, control, b, progress) {
  const inverse = 1 - progress;
  return {
    x: inverse * inverse * a.x + 2 * inverse * progress * control.x + progress * progress * b.x,
    y: inverse * inverse * a.y + 2 * inverse * progress * control.y + progress * progress * b.y,
  };
}

function brainColors() {
  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue('--accent').trim() || '#7c3aed';
  return {
    accent,
    signal: accent,
    surface: styles.getPropertyValue('--surface').trim() || '#ffffff',
    border: styles.getPropertyValue('--border-strong').trim() || '#d6d4e2',
    text: styles.getPropertyValue('--text').trim() || '#1b1a22',
    muted: styles.getPropertyValue('--dim').trim() || '#9a98a6',
  };
}

function rgba(color, alpha) {
  const value = color.replace('#', '').trim();
  if (/^[0-9a-f]{3}$/i.test(value)) {
    const [r, g, b] = value.split('').map(part => parseInt(part + part, 16));
    return `rgba(${r},${g},${b},${alpha})`;
  }
  if (/^[0-9a-f]{6}$/i.test(value)) {
    return `rgba(${parseInt(value.slice(0, 2), 16)},${parseInt(value.slice(2, 4), 16)},${parseInt(value.slice(4, 6), 16)},${alpha})`;
  }
  return color;
}
