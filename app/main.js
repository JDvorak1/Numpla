// ============================================================================
// main.js - the Numpla browser shell (M4, the vertical slice).
//
// Flow:
//   boot()  ->  load + instantiate WASM  ->  reveal the app (eased)
//   edit    ->  debounce  ->  set_source  ->  diagnostics  ->  solve  ->  sample
//   scrub   ->  eval(t)   ->  playhead marker + numeric readout
//
// No bundler, no dependencies, no network. Plain ES modules.
// ============================================================================

import { TimePlot, PhasePlot, seriesColor, fmtValue } from './plot.js';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const el = {
  loader:       $('loader'),
  loaderStatus: $('loader-status'),
  loaderDetail: $('loader-detail'),
  app:          $('app'),

  source:   $('source'),
  gutter:   $('gutter'),
  diags:    $('diags'),
  diagCount:$('diag-count'),
  t0:       $('t0'),
  t1:       $('t1'),

  legend:     $('legend'),
  canvasTime: $('canvas-time'),
  canvasPhase:$('canvas-phase'),
  phaseWrap:  $('phase-wrap'),
  phaseAxes:  $('phase-axes'),
  plots:      document.querySelector('.pane--plots'),

  play:    $('play'),
  scrub:   $('scrub'),
  tval:    $('tval'),
  readout: $('readout'),

  statAccepted: $('stat-accepted'),
  statRejected: $('stat-rejected'),
  statRhs:      $('stat-rhs'),
  statSolve:    $('stat-solve'),
};

const timePlot  = new TimePlot(el.canvasTime);
const phasePlot = new PhasePlot(el.canvasPhase);

// ---------------------------------------------------------------------------
// Loading screen
// ---------------------------------------------------------------------------

const BOOT_START = performance.now();
const MIN_LOADER_MS = 620;   // never flash the loader; let it breathe
let revealed = false;
let failed = false;

function status(text) {
  if (!failed) el.loaderStatus.textContent = text;
}

/** Terminal failure: stay on the loading screen and say what went wrong. */
function fail(message, detail) {
  if (failed || revealed) return;
  failed = true;
  el.loader.classList.add('is-failed');
  el.loaderStatus.textContent = message;
  const text = detail == null ? '' : (detail.stack || detail.message || String(detail));
  if (text) {
    el.loaderDetail.textContent = text;
    el.loaderDetail.hidden = false;
  }
  console.error('[numpla] boot failed:', message, detail);
}

/**
 * The eased hand-off. The loader fades + drifts + blurs out while the app
 * fades and lifts in underneath it (with a small delay so the two motions
 * read as one gesture, not a swap). Once the loader's transition finishes it
 * is removed from the layer tree entirely.
 */
function reveal() {
  if (revealed || failed) return;
  revealed = true;

  status('ready');
  el.app.setAttribute('aria-hidden', 'false');

  // two frames: let the first paint of the app happen at opacity 0 so the
  // transition has something to interpolate from.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.body.classList.add('ready');
  }));

  let done = false;
  const retire = () => {
    if (done) return;
    done = true;
    el.loader.classList.add('is-gone');
    el.loader.setAttribute('aria-hidden', 'true');
    resizeAll();
  };
  el.loader.addEventListener('transitionend', (e) => {
    if (e.propertyName === 'opacity') retire();
  });
  setTimeout(retire, 1400); // belt and braces
}

window.addEventListener('error', (e) => {
  if (!revealed) fail('Startup failed.', e.error || new Error(e.message));
});
window.addEventListener('unhandledrejection', (e) => {
  if (!revealed) fail('Startup failed.', e.reason);
});

// ---------------------------------------------------------------------------
// Model adapter
//
// wasm-bindgen keeps Rust method names as-is, but we bind defensively so a
// camelCase build still works. A genuinely missing method throws loudly -
// nothing here fakes the WASM away.
// ---------------------------------------------------------------------------

function bindMethod(obj, name) {
  const camel = name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const fn = typeof obj[name] === 'function' ? obj[name]
           : typeof obj[camel] === 'function' ? obj[camel]
           : null;
  if (!fn) throw new Error(`Model.${name}() is missing from the WASM module.`);
  return (...args) => fn.apply(obj, args);
}

const toF64 = (v) =>
  v instanceof Float64Array ? v : v && v.length ? Float64Array.from(v) : new Float64Array(0);

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error(`[numpla] ${what} was not valid JSON:`, text);
    return null;
  }
}

let M = null; // { setSource, solve, sample, eval }

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

const state = {
  names: [],
  dim: 0,
  frame: null,      // last good { names, dim, n, data, t0, t1, playT, playY }
  t0: 0,
  t1: 20,
  u: 0,             // playhead position, normalised 0..1 across the span
  playing: false,
  lastFrameMs: 0,
};

const PLAY_SECONDS = 9; // real seconds to traverse the whole span once

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function renderGutter(lineCount, worstByLine) {
  const rows = [];
  for (let i = 0; i < lineCount; i++) {
    const sev = worstByLine.get(i);
    const cls = sev === 'error' ? ' class="ln--error"'
              : sev === 'pending' ? ' class="ln--pending"'
              : '';
    rows.push(`<div${cls}>${i + 1}</div>`);
  }
  el.gutter.innerHTML = rows.join('');
  el.gutter.scrollTop = el.source.scrollTop;
}

function renderDiagnostics(issues, lineCount) {
  const worst = new Map();
  for (const it of issues) {
    const line = Number.isInteger(it.line) ? it.line : 0;
    if (worst.get(line) !== 'error') worst.set(line, it.severity === 'error' ? 'error' : 'pending');
  }
  renderGutter(lineCount, worst);

  el.diags.innerHTML = '';

  if (!issues.length) {
    const li = document.createElement('li');
    li.className = 'diags__clean';
    li.textContent = 'No issues.';
    el.diags.appendChild(li);
    el.diagCount.textContent = 'clean';
    return;
  }

  const sorted = issues.slice().sort((a, b) => (a.line || 0) - (b.line || 0));
  for (const it of sorted) {
    // THE RULE: "pending" is incomplete-not-wrong. Muted, never red.
    const isError = it.severity === 'error';
    const li = document.createElement('li');
    li.className = 'diag ' + (isError ? 'diag--error' : 'diag--pending');

    const ln = document.createElement('span');
    ln.className = 'diag__ln';
    ln.textContent = Number.isInteger(it.line) ? String(it.line + 1) : '-';

    const msg = document.createElement('span');
    msg.className = 'diag__msg';
    msg.textContent = it.message || (isError ? 'error' : 'incomplete');

    li.append(ln, msg);
    el.diags.appendChild(li);
  }

  const errs = issues.filter((i) => i.severity === 'error').length;
  const pend = issues.length - errs;
  const bits = [];
  if (errs) bits.push(errs + (errs === 1 ? ' error' : ' errors'));
  if (pend) bits.push(pend + ' pending');
  el.diagCount.textContent = bits.join(' / ');
}

function setSolveBadge(text, kind) {
  el.statSolve.textContent = text;
  el.statSolve.classList.toggle('is-ok', kind === 'ok');
  el.statSolve.classList.toggle('is-bad', kind === 'bad');
}

// ---------------------------------------------------------------------------
// Legend / readout
// ---------------------------------------------------------------------------

function renderLegend(names) {
  el.legend.innerHTML = '';
  names.forEach((name, i) => {
    const span = document.createElement('span');
    span.className = 'legend__item';
    const sw = document.createElement('span');
    sw.className = 'legend__swatch';
    sw.style.background = seriesColor(i);
    const label = document.createElement('span');
    label.textContent = name;
    span.append(sw, label);
    el.legend.appendChild(span);
  });
}

function renderReadout(names, values) {
  el.readout.innerHTML = '';
  if (!values || !values.length) return;
  names.forEach((name, i) => {
    if (i >= values.length) return;
    const chip = document.createElement('span');
    chip.className = 'chip';
    const dot = document.createElement('span');
    dot.className = 'chip__dot';
    dot.style.background = seriesColor(i);
    const n = document.createElement('span');
    n.className = 'chip__name';
    n.textContent = name;
    const v = document.createElement('span');
    v.className = 'chip__val';
    v.textContent = fmtValue(values[i]);
    chip.append(dot, n, v);
    el.readout.appendChild(chip);
  });
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

let drawQueued = false;

function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

function draw() {
  const f = state.frame;
  timePlot.draw(f);
  if (f && f.dim === 2) phasePlot.draw(f);
}

function resizeAll() {
  scheduleDraw();
}

// ---------------------------------------------------------------------------
// Playhead
// ---------------------------------------------------------------------------

function playheadTime() {
  return state.t0 + state.u * (state.t1 - state.t0);
}

/** Re-evaluate the state at the playhead and refresh everything that shows it. */
function updatePlayhead(redraw = true) {
  const t = playheadTime();
  el.tval.textContent = t.toFixed(3);

  const f = state.frame;
  if (!f) {
    el.readout.innerHTML = '';
    return;
  }

  let y = new Float64Array(0);
  if (M) {
    try {
      y = toF64(M.eval(t));
    } catch (err) {
      console.error('[numpla] eval failed', err);
    }
  }

  f.playT = t;
  f.playY = y;
  renderReadout(f.names, y);
  if (redraw) scheduleDraw();
}

function setU(u, fromSlider = false) {
  state.u = Math.min(1, Math.max(0, u));
  if (!fromSlider) el.scrub.value = String(Math.round(state.u * 1000));
  updatePlayhead();
}

// ---------------------------------------------------------------------------
// Play / pause
// ---------------------------------------------------------------------------

function setPlaying(on) {
  state.playing = on;
  el.play.classList.toggle('is-playing', on);
  el.play.setAttribute('aria-label', on ? 'Pause' : 'Play');
  if (on) {
    state.lastFrameMs = performance.now();
    requestAnimationFrame(tick);
  }
}

function tick(now) {
  if (!state.playing) return;
  const dt = Math.min(0.1, (now - state.lastFrameMs) / 1000);
  state.lastFrameMs = now;
  let u = state.u + dt / PLAY_SECONDS;
  if (u > 1) u -= 1; // loop
  setU(u);
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// The compute pipeline
// ---------------------------------------------------------------------------

function sampleCount() {
  const w = el.canvasTime.getBoundingClientRect().width || 900;
  const dpr = Math.min(4, Math.max(1, window.devicePixelRatio || 1));
  return Math.round(Math.min(4000, Math.max(240, w * dpr * 1.2)));
}

function readSpan() {
  const a = parseFloat(el.t0.value);
  const b = parseFloat(el.t1.value);
  if (!isFinite(a) || !isFinite(b) || b <= a) return null;
  return [a, b];
}

function recompute() {
  if (!M) return;

  const src = el.source.value;
  const lineCount = src.split('\n').length;

  // 1. set_source - cheap, runs on every edit, never throws.
  const diagText = M.setSource(src);
  const diag = parseJson(diagText, 'Diagnostics') || { states: [], issues: [] };
  const issues = Array.isArray(diag.issues) ? diag.issues : [];
  const names = Array.isArray(diag.states) ? diag.states : [];

  renderDiagnostics(issues, lineCount);

  state.names = names;
  state.dim = names.length;
  renderLegend(names);

  const hasError = issues.some((i) => i.severity === 'error');
  if (hasError) {
    // Keep the last good curve on screen; the document is mid-edit, not dead.
    setSolveBadge('paused on error', 'bad');
    return;
  }
  if (!names.length) {
    setSolveBadge('no states', null);
    state.frame = null;
    el.statAccepted.textContent = '-';
    el.statRejected.textContent = '-';
    el.statRhs.textContent = '-';
    showPhase(false);
    scheduleDraw();
    return;
  }

  const span = readSpan();
  if (!span) {
    setSolveBadge('bad span', 'bad');
    return;
  }
  const [t0, t1] = span;

  // 2. solve
  const report = parseJson(M.solve(t0, t1), 'SolveReport');
  if (!report || report.ok !== true) {
    setSolveBadge(report && report.error ? String(report.error) : 'solve failed', 'bad');
    if (report) {
      el.statAccepted.textContent = report.accepted ?? '-';
      el.statRejected.textContent = report.rejected ?? '-';
      el.statRhs.textContent = report.rhsEvals ?? '-';
    }
    return;
  }

  el.statAccepted.textContent = report.accepted ?? '-';
  el.statRejected.textContent = report.rejected ?? '-';
  el.statRhs.textContent = report.rhsEvals ?? '-';
  setSolveBadge('solved', 'ok');

  const dim = Number.isInteger(report.dim) ? report.dim : names.length;
  const reportNames = Array.isArray(report.states) && report.states.length
    ? report.states
    : names;

  // 3. sample the whole curve
  const n = sampleCount();
  const data = toF64(M.sample(n));
  const stride = dim + 1;
  const got = stride > 0 ? Math.floor(data.length / stride) : 0;

  state.t0 = report.t0 ?? t0;
  state.t1 = report.t1 ?? t1;

  if (!got) {
    state.frame = null;
    showPhase(false);
    scheduleDraw();
    return;
  }

  state.frame = {
    names: reportNames,
    dim,
    n: got,
    data,
    t0: state.t0,
    t1: state.t1,
    playT: playheadTime(),
    playY: new Float64Array(0),
  };

  if (reportNames.length) renderLegend(reportNames);
  showPhase(dim === 2, reportNames);
  updatePlayhead();
}

function showPhase(on, names) {
  el.phaseWrap.hidden = !on;
  el.plots.classList.toggle('has-phase', !!on);
  if (on && names && names.length >= 2) {
    el.phaseAxes.textContent = `${names[1]} vs ${names[0]}`;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

let debounceTimer = 0;

function scheduleRecompute(delay = 180) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    try {
      recompute();
    } catch (err) {
      console.error('[numpla] recompute failed', err);
      setSolveBadge('internal error', 'bad');
    }
  }, delay);
}

function wire() {
  el.source.addEventListener('input', () => {
    // gutter line count should track typing immediately, not on the debounce
    renderGutter(el.source.value.split('\n').length, new Map());
    scheduleRecompute();
  });
  el.source.addEventListener('scroll', () => {
    el.gutter.scrollTop = el.source.scrollTop;
  });

  el.t0.addEventListener('input', () => scheduleRecompute(220));
  el.t1.addEventListener('input', () => scheduleRecompute(220));

  el.scrub.addEventListener('input', () => {
    if (state.playing) setPlaying(false);
    setU(Number(el.scrub.value) / 1000, true);
  });

  el.play.addEventListener('click', () => setPlaying(!state.playing));

  document.addEventListener('keydown', (e) => {
    if (e.key !== ' ' && e.code !== 'Space') return;
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
    e.preventDefault();
    setPlaying(!state.playing);
  });

  // HiDPI-correct redraw whenever the plot boxes change size
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => scheduleDraw());
    document.querySelectorAll('.plot__canvas').forEach((n) => ro.observe(n));
  }
  window.addEventListener('resize', scheduleDraw);

  // devicePixelRatio can change when a window moves between monitors
  if (window.matchMedia) {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    if (mq && typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', scheduleDraw);
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  // Show line numbers straight away so the loader never hands over to a blank
  // editor gutter.
  renderGutter(el.source.value.split('\n').length, new Map());

  let mod;
  try {
    status('Fetching compute core...');
    mod = await import('./pkg/numpla_wasm.js');
  } catch (err) {
    fail(
      'Could not load ./pkg/numpla_wasm.js - build the WASM first.',
      new Error(
        'wasm-pack build --target web --out-dir ../../app/pkg crates/numpla-wasm\n\n' +
        (err && (err.stack || err.message) ? err.stack || err.message : String(err))
      )
    );
    return;
  }

  try {
    status('Instantiating WebAssembly...');
    const init = mod.default;
    if (typeof init !== 'function') {
      throw new Error('numpla_wasm.js has no default init() export.');
    }
    await init();
  } catch (err) {
    fail('WebAssembly failed to instantiate.', err);
    return;
  }

  try {
    if (typeof mod.Model !== 'function') {
      throw new Error('numpla_wasm.js does not export a Model class.');
    }
    const model = new mod.Model();
    M = {
      setSource: bindMethod(model, 'set_source'),
      solve:     bindMethod(model, 'solve'),
      sample:    bindMethod(model, 'sample'),
      eval:      bindMethod(model, 'eval'),
    };
  } catch (err) {
    fail('The WASM module does not match docs/wasm-api.md.', err);
    return;
  }

  try {
    status('Integrating...');
    wire();
    recompute();
  } catch (err) {
    fail('The first solve failed.', err);
    return;
  }

  // Hold the loader just long enough that it reads as intentional, then ease.
  const elapsed = performance.now() - BOOT_START;
  setTimeout(reveal, Math.max(0, MIN_LOADER_MS - elapsed));
}

boot();
