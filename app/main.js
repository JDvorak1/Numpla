// ============================================================================
// main.js - the Numpla browser shell.
//
// Flow:
//   boot()  ->  load MathField + WASM  ->  reveal the app (eased)
//   edit    ->  debounce  ->  set_source  ->  per-row diagnostics  ->  solve
//   sliders ->  t drives eval(t); a parameter slider rewrites its own row
//
// Three structural rules this file exists to enforce:
//
//   1. GRAY-NOT-RED. `severity: "pending"` is muted. Only `"error"` is red,
//      and only an `"error"` pauses the solve - the last good curve stays on
//      screen while the document is mid-edit.
//   2. ONE PLOT. A single canvas with view chips on it. A chip is enabled only
//      when the model can actually support that view; disabled chips stay
//      visible, because they are how the capability is discovered.
//   3. NOTHING MOVES WHILE YOU TYPE. Panes have explicit sizes and scroll
//      internally; diagnostics occupy reserved space; the slider settings are
//      an overlay. The only thing that may change size is the field under the
//      caret.
//
// No bundler, no dependencies, no network. Plain ES modules.
// ============================================================================

import { Plot, seriesColor, fmtValue } from './plot.js';
import { DEMOS } from './demos.js';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const el = {
  loader:       $('loader'),
  loaderStatus: $('loader-status'),
  loaderDetail: $('loader-detail'),
  app:          $('app'),

  rows:      $('rows'),
  addRow:    $('add-row'),
  diagCount: $('diag-count'),

  divider: $('divider'),

  views:  $('views'),
  legend: $('legend'),
  canvas: $('canvas'),

  play:    $('play'),
  readout: $('readout'),
  sliders: $('sliders'),

  settings:     $('slider-settings'),
  settingsName: $('settings-name'),
  settingsMin:  $('settings-min'),
  settingsMax:  $('settings-max'),
  settingsStep: $('settings-step'),
  settingsFoot: $('settings-foot'),

  statAccepted: $('stat-accepted'),
  statRejected: $('stat-rejected'),
  statRhs:      $('stat-rhs'),
  statSolve:    $('stat-solve'),

  demosBtn: $('demos-btn'),
  demomenu: $('demomenu'),
};

const plot = new Plot(el.canvas);

const DEFAULT_DOC = [
  'k = 0.4',
  "x' = -y - k*x",
  "y' = x",
  'x(0) = 1',
  'y(0) = 0',
];

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
 * fades and lifts in underneath it (with a small delay so the two motions read
 * as one gesture, not a swap). Once the loader's transition finishes it is
 * removed from the layer tree entirely.
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
    scheduleDraw();
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
    console.error(`[numpla] ${what} was not valid JSON:`, text, err);
    return null;
  }
}

let M = null;             // { setSource, solve, sample, eval }
let MathField = null;     // the class from ./mathfield.js

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

const state = {
  names: [],       // state variable names, in solver order
  params: [],      // named constants reported by the compiler
  frame: null,     // last GOOD frame; an error never clears this
  t0: 0,
  t1: 20,
  t: 0,            // playhead time
  playing: false,
  lastFrameMs: 0,
};

const PLAY_SECONDS = 9;   // real seconds to traverse the whole span once

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// Number helpers - used by both the sliders and the source rewriter
// ---------------------------------------------------------------------------

function stepDecimals(step) {
  if (!(step > 0) || !isFinite(step)) return 3;
  const s = String(step);
  const e = s.indexOf('e-');
  if (e >= 0) return Math.min(8, parseInt(s.slice(e + 2), 10) + 1);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : Math.min(8, s.length - dot - 1);
}

/** Display form: as many decimals as the step justifies, no more. */
function fmtStepped(v, step) {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  return v.toFixed(Math.max(0, Math.min(6, stepDecimals(step))));
}

/** Source form: the shortest text that round-trips through the parser. */
function numText(v, step) {
  if (!isFinite(v)) return '0';
  const d = Math.max(0, Math.min(8, stepDecimals(step)));
  let s = String(Number(v.toFixed(d)));
  if (s.indexOf('e') >= 0) s = v.toFixed(8);   // the parser wants plain digits
  return s;
}

function niceCeil(x) {
  if (!(x > 0) || !isFinite(x)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(x)));
  const n = x / mag;
  const s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return s * mag;
}

/** A first guess at a parameter slider's range, from its current value. */
function defaultRange(v) {
  if (!isFinite(v) || v === 0) return { min: -1, max: 1 };
  const hi = niceCeil(Math.abs(v) * 2);
  return v < 0 ? { min: -hi, max: hi } : { min: 0, max: hi };
}

/** Step helper: round DOWN to a nice value so a track stays fine-grained. */
function niceFloor(x) {
  if (!(x > 0) || !isFinite(x)) return 0.01;
  const mag = Math.pow(10, Math.floor(Math.log10(x)));
  const n = x / mag;
  const s = n >= 5 ? 5 : n >= 2 ? 2 : 1;
  return s * mag;
}

/** ~200 stops across the track: fine enough to scrub, coarse enough to read. */
const niceStepFor = (span) => niceFloor(Math.abs(span) / 200) || 0.01;

// ---------------------------------------------------------------------------
// The expression list - one MathField per row
// ---------------------------------------------------------------------------

/** @type {{el:HTMLElement, host:HTMLElement, idxEl:HTMLElement,
 *          msgEl:HTMLElement, field:any}[]} */
const rows = [];

const DEL_MARK = '×';   // ×

function rowSource(row) {
  try {
    const s = row.field ? row.field.source : '';
    return typeof s === 'string' ? s.replace(/[\r\n]+/g, ' ') : '';
  } catch (err) {
    console.error('[numpla] MathField.source threw', err);
    return '';
  }
}

/** The document sent to set_source: the rows' sources, joined with newlines. */
function docSource() {
  return rows.map(rowSource).join('\n');
}

function indexOfRow(row) {
  return rows.indexOf(row);
}

function renumber() {
  rows.forEach((row, i) => {
    row.idxEl.textContent = String(i + 1);
  });
}

function focusRow(i, atEnd) {
  const row = rows[clamp(i, 0, rows.length - 1)];
  if (!row || !row.field) return;
  try {
    row.field.focus(atEnd);
  } catch (err) {
    console.error('[numpla] MathField.focus threw', err);
  }
  setActiveRow(row);
}

function setActiveRow(row) {
  rows.forEach((r) => r.el.classList.toggle('is-active', r === row));
}

/**
 * The field calls this when the caret walks out of one of its edges.
 * `dir` is 'up' | 'down' | 'left' | 'right': up/left go to the previous row
 * (caret at the end), down/right to the next one (caret at the start).
 */
function navigate(row, dir) {
  const forward = dir === 'down' || dir === 'right' || dir === 1 || dir === 'next';
  const i = indexOfRow(row);
  if (i < 0) return;
  const j = i + (forward ? 1 : -1);
  if (j < 0 || j >= rows.length) return;
  focusRow(j, !forward);
}

function makeRow(source, at) {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  wrap.setAttribute('role', 'listitem');

  const idxEl = document.createElement('span');
  idxEl.className = 'row__idx';

  const host = document.createElement('div');
  host.className = 'row__field';

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'row__del';
  del.title = 'Delete this row';
  del.setAttribute('aria-label', 'Delete this row');
  del.textContent = DEL_MARK;

  const msgEl = document.createElement('div');
  msgEl.className = 'row__msg';

  wrap.append(idxEl, host, del, msgEl);

  const row = { el: wrap, host, idxEl, msgEl, field: null };

  const index = at == null ? rows.length : clamp(at, 0, rows.length);
  const before = rows[index] ? rows[index].el : null;
  el.rows.insertBefore(wrap, before);
  rows.splice(index, 0, row);

  row.field = new MathField(host, {
    value: source || '',
    onChange: () => scheduleRecompute(),
    onFocus: () => setActiveRow(row),
    onBlur: () => row.el.classList.remove('is-active'),
    onEnter: () => insertAfter(row),
    onNavigate: (field, dir) => navigate(row, dir),
  });

  del.addEventListener('click', (e) => {
    e.preventDefault();
    removeRow(row);
  });

  // Backspace in an already-empty row deletes the row. Captured on the host so
  // it is decided BEFORE the field sees the key - otherwise a backspace that
  // empties the field would immediately delete the row too.
  host.addEventListener('keydown', (e) => {
    if (e.key !== 'Backspace' || rows.length < 2) return;
    let empty = false;
    try {
      empty = typeof row.field.isEmpty === 'function'
        ? !!row.field.isEmpty()
        : rowSource(row) === '';
    } catch (err) {
      empty = rowSource(row) === '';
    }
    if (!empty) return;
    e.preventDefault();
    e.stopPropagation();
    removeRow(row);
  }, true);

  renumber();
  return row;
}

function insertAfter(row) {
  const i = indexOfRow(row);
  const created = makeRow('', i < 0 ? rows.length : i + 1);
  scheduleRecompute();
  focusRow(indexOfRow(created), false);
  return created;
}

function removeRow(row) {
  const i = indexOfRow(row);
  if (i < 0) return;

  // Never leave the document with no rows: empty the last one instead.
  if (rows.length === 1) {
    try { row.field.source = ''; } catch (err) { /* the field is gone; fine */ }
    setRowDiagnostic(row, null, '');
    scheduleRecompute(0);
    focusRow(0, true);
    return;
  }

  try { row.field.destroy(); } catch (err) { console.error('[numpla] destroy threw', err); }
  row.el.remove();
  rows.splice(i, 1);
  renumber();
  scheduleRecompute(0);
  focusRow(Math.min(i, rows.length - 1), true);
}

function buildRows(lines) {
  lines.forEach((line) => makeRow(line, null));
}

function clearRows() {
  for (const row of rows) {
    try { row.field.destroy(); } catch (err) { console.error('[numpla] destroy threw', err); }
    row.el.remove();
  }
  rows.length = 0;
}

// ---------------------------------------------------------------------------
// Demos
//
// Demos are part of the product, not marketing: they are how someone finds out
// what the software can do. Each carries the range over which its knobs are
// actually interesting, which a generic guess around the current value cannot
// know - so loading one stages those ranges for syncSliders to pick up when it
// creates the sliders.
// ---------------------------------------------------------------------------

const pendingKnobs = new Map();

function loadDemo(demo) {
  closeDemos();
  closeSettings();
  setPlaying(false);

  pendingKnobs.clear();
  for (const k of demo.knobs || []) pendingKnobs.set(k.name, k);

  // Drop the parameter sliders so they are rebuilt against the demo's ranges.
  for (const [name, s] of Array.from(sliders)) {
    if (name === 't') continue;
    s.el.remove();
    sliders.delete(name);
  }
  sliderOrderKey = '';

  clearRows();
  buildRows(demo.source.split('\n'));

  const [t0, t1] = demo.tSpan;
  state.t0 = t0;
  state.t1 = t1;
  state.t = t0;
  const ts = sliders.get('t');
  if (ts) {
    ts.min = t0;
    ts.max = t1;
    ts.step = niceStepFor(t1 - t0);
    setSliderValue(ts, t0);
  }

  el.demosBtn.setAttribute('data-demo', demo.title);
  scheduleRecompute(0);
}

function buildDemoMenu() {
  el.demomenu.textContent = '';
  for (const demo of DEMOS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'demoitem';
    item.setAttribute('role', 'menuitem');

    const title = document.createElement('span');
    title.className = 'demoitem__title';
    title.textContent = demo.title;

    const blurb = document.createElement('span');
    blurb.className = 'demoitem__blurb';
    blurb.textContent = demo.blurb;

    item.append(title, blurb);

    if (demo.audio) {
      const tag = document.createElement('span');
      tag.className = 'demoitem__tag';
      tag.textContent = 'audio';
      tag.title = 'A good candidate for render-to-sound';
      item.append(tag);
    }

    item.addEventListener('click', () => loadDemo(demo));
    el.demomenu.append(item);
  }
}

function openDemos() {
  const r = el.demosBtn.getBoundingClientRect();
  el.demomenu.hidden = false;
  el.demosBtn.setAttribute('aria-expanded', 'true');
  // Position after unhiding so the measured height is real.
  const mw = el.demomenu.offsetWidth;
  const left = clamp(r.left, 8, Math.max(8, window.innerWidth - mw - 8));
  el.demomenu.style.left = left + 'px';
  el.demomenu.style.top = (r.bottom + 8) + 'px';
  const first = el.demomenu.querySelector('.demoitem');
  if (first) first.focus();
}

function closeDemos() {
  if (el.demomenu.hidden) return;
  el.demomenu.hidden = true;
  el.demosBtn.setAttribute('aria-expanded', 'false');
}

function toggleDemos() {
  if (el.demomenu.hidden) openDemos(); else closeDemos();
}

// ---------------------------------------------------------------------------
// Diagnostics -> the rows themselves
// ---------------------------------------------------------------------------

function setRowDiagnostic(row, severity, message) {
  const sev = severity === 'error' ? 'error' : severity === 'pending' ? 'pending' : null;
  row.el.classList.toggle('is-error', sev === 'error');
  row.el.classList.toggle('is-pending', sev === 'pending');
  row.msgEl.textContent = sev ? (message || (sev === 'error' ? 'error' : 'incomplete')) : '';
  row.msgEl.title = row.msgEl.textContent;
  try {
    if (row.field && typeof row.field.setDiagnostic === 'function') {
      row.field.setDiagnostic(sev, message || '');
    }
  } catch (err) {
    console.error('[numpla] MathField.setDiagnostic threw', err);
  }
}

function applyDiagnostics(issues) {
  // Worst severity per line wins; `error` outranks `pending`.
  const worst = new Map();
  for (const it of issues) {
    const line = Number.isInteger(it.line) ? it.line : 0;
    const sev = it.severity === 'error' ? 'error' : 'pending';
    const prev = worst.get(line);
    if (!prev || (prev.sev !== 'error' && sev === 'error')) {
      worst.set(line, { sev, msg: it.message || '' });
    }
  }

  rows.forEach((row, i) => {
    const d = worst.get(i);
    setRowDiagnostic(row, d ? d.sev : null, d ? d.msg : '');
  });

  const errs = issues.filter((i) => i.severity === 'error').length;
  const pend = issues.length - errs;
  const bits = [];
  if (errs) bits.push(errs + (errs === 1 ? ' error' : ' errors'));
  if (pend) bits.push(pend + ' pending');
  el.diagCount.textContent = bits.length ? bits.join(' · ') : 'clean';
  el.diagCount.classList.toggle('is-error', errs > 0);
}

function setSolveBadge(text, kind) {
  el.statSolve.textContent = text;
  el.statSolve.title = text;
  el.statSolve.classList.toggle('is-ok', kind === 'ok');
  el.statSolve.classList.toggle('is-bad', kind === 'bad');
}

// ---------------------------------------------------------------------------
// View chips - what the model can actually show
// ---------------------------------------------------------------------------

const ANGLE_NAMES = ['theta', 'θ', 'phi', 'φ'];

/**
 * Polar is drawable only when a *state* called `r` exists: that is the radius
 * the sample buffer actually carries. The angle is a state named `theta` (or
 * `phi`) if there is one, and `t` otherwise. Anything less certain leaves the
 * chip present but disabled - hiding it would hide the capability.
 */
function polarMapFor(names) {
  if (!Array.isArray(names)) return null;
  const r = names.indexOf('r');
  if (r < 0) return null;
  let theta = -1;
  for (let i = 0; i < names.length; i++) {
    if (ANGLE_NAMES.indexOf(names[i]) >= 0) { theta = i; break; }
  }
  return { r, theta };
}

const CHIP_TITLE = {
  time:  ['every state against time', 'every state against time'],
  phase: ['state 2 against state 1', 'the phase plane needs exactly 2 states'],
  polar: ['r against the angle', 'no polar content: define a state named r'],
};

const chips = new Map();          // view id -> button
const caps = { time: true, phase: false, polar: false };
let activeView = 'time';

function collectChips() {
  el.views.querySelectorAll('.viewchip').forEach((btn) => {
    const view = btn.dataset.view;
    if (!view) return;
    chips.set(view, btn);
    btn.addEventListener('click', () => setView(view));
  });
}

function renderChips() {
  chips.forEach((btn, view) => {
    const ok = !!caps[view];
    btn.classList.toggle('is-off', !ok);
    btn.classList.toggle('is-active', ok && view === activeView);
    btn.setAttribute('aria-disabled', ok ? 'false' : 'true');
    btn.setAttribute('aria-pressed', ok && view === activeView ? 'true' : 'false');
    const t = CHIP_TITLE[view];
    if (t) btn.title = ok ? t[0] : t[1];
  });
}

function setView(view) {
  if (!caps[view]) return;          // muted chips are inert, not hidden
  activeView = view;
  plot.setView(view);
  renderChips();
  scheduleDraw();
}

function updateCapabilities(names) {
  caps.time = true;
  caps.phase = Array.isArray(names) && names.length === 2;
  caps.polar = polarMapFor(names) !== null;
  if (!caps[activeView]) {
    activeView = 'time';
    plot.setView('time');
  }
  renderChips();
}

// ---------------------------------------------------------------------------
// Legend + readout
// ---------------------------------------------------------------------------

function renderLegend(names) {
  el.legend.innerHTML = '';
  names.forEach((name, i) => {
    const item = document.createElement('span');
    item.className = 'legend__item';
    const sw = document.createElement('span');
    sw.className = 'legend__swatch';
    sw.style.background = seriesColor(i);
    const label = document.createElement('span');
    label.textContent = name;
    item.append(sw, label);
    el.legend.appendChild(item);
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
    plot.draw(state.frame);
  });
}

// ---------------------------------------------------------------------------
// ONE controls section: every slider, `t` included
//
// At rest a row shows name, value, track. Range and step live in an overlay
// that opens on demand - they are set once, while the value is watched
// constantly, so giving them permanent screen space buries the number that
// matters. The overlay is positioned over the page rather than inserted into
// it, so opening it cannot move anything.
// ---------------------------------------------------------------------------

const GEAR_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/>' +
  '<circle cx="13" cy="8" r="1.5"/></svg>';

/** name -> slider record */
const sliders = new Map();
let openSlider = null;
let sliderOrderKey = '';

function makeSlider(name, kind, init) {
  const wrap = document.createElement('div');
  wrap.className = 'slider';
  wrap.dataset.name = name;

  const top = document.createElement('div');
  top.className = 'slider__top';

  const nameBtn = document.createElement('button');
  nameBtn.type = 'button';
  nameBtn.className = 'slider__name';
  nameBtn.textContent = name;
  nameBtn.title = 'Range and step for ' + name;
  nameBtn.setAttribute('aria-expanded', 'false');

  const valueEl = document.createElement('span');
  valueEl.className = 'slider__value';

  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'slider__gear';
  gear.innerHTML = GEAR_SVG;
  gear.title = 'Range and step for ' + name;
  gear.setAttribute('aria-label', 'Range and step for ' + name);

  top.append(nameBtn, valueEl, gear);

  const range = document.createElement('input');
  range.type = 'range';
  range.className = 'range';
  range.setAttribute('aria-label', name);

  wrap.append(top, range);
  el.sliders.appendChild(wrap);

  const s = {
    name,
    kind,
    el: wrap,
    nameBtn,
    valueEl,
    range,
    min: init.min,
    max: init.max,
    step: init.step,
    value: init.value,
    dragging: false,
  };

  const toggle = (e) => {
    e.preventDefault();
    openSettingsFor(s);
  };
  nameBtn.addEventListener('click', toggle);
  gear.addEventListener('click', toggle);

  range.addEventListener('pointerdown', () => { s.dragging = true; });
  range.addEventListener('input', () => {
    const v = Number(range.value);
    if (!isFinite(v)) return;
    s.value = v;
    paintSlider(s);
    if (s.kind === 'time') {
      if (state.playing) setPlaying(false);
      setTime(v, true);
    } else {
      writeParam(s);
    }
  });

  applyRange(s);
  sliders.set(name, s);
  return s;
}

/** Push min/max/step onto the input without ever discarding the value. */
function applyRange(s) {
  const step = s.step > 0 && isFinite(s.step) ? s.step : niceStepFor(s.max - s.min);
  s.range.min = String(s.min);
  s.range.max = String(s.max);
  s.range.step = String(step);
  s.range.value = String(clamp(s.value, Math.min(s.min, s.max), Math.max(s.min, s.max)));
  paintSlider(s);
}

function paintSlider(s) {
  s.valueEl.textContent = s.kind === 'time'
    ? s.value.toFixed(3)
    : fmtStepped(s.value, s.step);
}

function setSliderValue(s, v) {
  if (!isFinite(v) || s.value === v) return;
  s.value = v;
  if (!s.dragging) s.range.value = String(clamp(v, Math.min(s.min, s.max), Math.max(s.min, s.max)));
  paintSlider(s);
}

// -- the settings overlay ---------------------------------------------------

function openSettingsFor(s) {
  if (openSlider === s) { closeSettings(); return; }
  closeSettings();

  openSlider = s;
  s.el.classList.add('is-open');
  s.nameBtn.setAttribute('aria-expanded', 'true');

  el.settingsName.textContent = s.name;
  el.settingsMin.value = String(s.min);
  el.settingsMax.value = String(s.max);
  el.settingsStep.value = String(s.step);
  el.settingsFoot.textContent = s.kind === 'time'
    ? 'min and max are the integration span · Esc to close'
    : 'Esc to close';

  el.settings.hidden = false;
  positionSettings(s);
  el.settingsMin.focus();
  if (typeof el.settingsMin.select === 'function') el.settingsMin.select();
}

function positionSettings(s) {
  const r = s.el.getBoundingClientRect();
  const w = el.settings.offsetWidth || 268;
  const h = el.settings.offsetHeight || 150;
  const left = clamp(r.left, 10, Math.max(10, window.innerWidth - w - 10));
  let top = r.top - h - 10;
  if (top < 10) top = Math.min(window.innerHeight - h - 10, r.bottom + 10);
  el.settings.style.left = left + 'px';
  el.settings.style.top = Math.max(10, top) + 'px';
}

function closeSettings() {
  if (!openSlider) return;
  openSlider.el.classList.remove('is-open');
  openSlider.nameBtn.setAttribute('aria-expanded', 'false');
  openSlider = null;
  el.settings.hidden = true;
}

function readSettings() {
  const s = openSlider;
  if (!s) return;

  const min = parseFloat(el.settingsMin.value);
  const max = parseFloat(el.settingsMax.value);
  const step = parseFloat(el.settingsStep.value);

  let spanChanged = false;
  if (isFinite(min) && isFinite(max) && max > min) {
    spanChanged = s.min !== min || s.max !== max;
    s.min = min;
    s.max = max;
  }
  if (isFinite(step) && step > 0) s.step = step;

  applyRange(s);

  if (s.kind === 'time' && spanChanged) {
    state.t0 = s.min;
    state.t1 = s.max;
    setTime(state.t);          // the readout must not lag the new span
    scheduleRecompute(220);
  }
}

// -- parameter sliders write back into their own row ------------------------

const ASSIGN_RE =
  /^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*$/;

/** Every `name = <number>` row in the document, mapped to its row. */
function scanAssignments() {
  const map = new Map();
  for (const row of rows) {
    const code = rowSource(row).split('#')[0];
    const m = ASSIGN_RE.exec(code);
    if (m) map.set(m[1], { value: Number(m[2]), row });
  }
  return map;
}

function writeParam(s) {
  const hit = scanAssignments().get(s.name);
  if (!hit) return;
  const text = s.name + ' = ' + numText(s.value, s.step);
  try {
    hit.row.field.source = text;
  } catch (err) {
    console.error('[numpla] MathField.source= threw', err);
    return;
  }
  scheduleRecompute(70);
}

/**
 * Reconcile the slider set with the document: `t` always first, then every
 * scalar parameter that is a plain numeric assignment (those are the only ones
 * a slider can actually drive).
 */
function syncSliders(params) {
  const assign = scanAssignments();
  const wanted = [];
  for (const name of params) {
    if (name === 't') continue;
    if (state.names.indexOf(name) >= 0) continue;   // it is a state, not a knob
    if (!assign.has(name)) continue;                // not a plain number
    if (wanted.indexOf(name) < 0) wanted.push(name);
  }

  // drop sliders whose parameter left the document
  for (const [name, s] of Array.from(sliders)) {
    if (name === 't' || wanted.indexOf(name) >= 0) continue;
    if (openSlider === s) closeSettings();
    s.el.remove();
    sliders.delete(name);
  }

  // add the new ones, seeded from the value written in the document
  for (const name of wanted) {
    if (sliders.has(name)) continue;
    const v = assign.get(name).value;
    // A demo knows the range over which its knob is interesting; a generic
    // guess around the current value usually does not. Prefer the demo's.
    const knob = pendingKnobs.get(name);
    const r = knob ? { min: knob.min, max: knob.max } : defaultRange(v);
    makeSlider(name, 'param', {
      min: r.min,
      max: r.max,
      step: (knob && knob.step > 0) ? knob.step : niceStepFor(r.max - r.min),
      value: v,
    });
    if (knob && knob.label) {
      const made = sliders.get(name);
      const btn = made && made.el.querySelector('.slider__name');
      if (btn) btn.title = knob.label;
    }
  }

  // keep the document's value and the slider's value in step
  for (const name of wanted) {
    const s = sliders.get(name);
    if (s && !s.dragging) setSliderValue(s, assign.get(name).value);
  }

  // only touch DOM order when the set actually changed - moving nodes around
  // while someone is dragging one of them is exactly the jitter we are here to
  // eliminate.
  const key = 't|' + wanted.join('|');
  if (key !== sliderOrderKey) {
    sliderOrderKey = key;
    const t = sliders.get('t');
    if (t) el.sliders.appendChild(t.el);
    for (const name of wanted) {
      const s = sliders.get(name);
      if (s) el.sliders.appendChild(s.el);
    }
  }
}

// ---------------------------------------------------------------------------
// Playhead + transport
// ---------------------------------------------------------------------------

function updatePlayhead(redraw = true) {
  const t = clamp(state.t, state.t0, state.t1);
  state.t = t;

  const ts = sliders.get('t');
  if (ts) setSliderValue(ts, t);

  const f = state.frame;
  if (!f) {
    el.readout.innerHTML = '';
    if (redraw) scheduleDraw();
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

function setTime(t, fromSlider = false) {
  state.t = clamp(t, state.t0, state.t1);
  const ts = sliders.get('t');
  if (ts) {
    ts.value = state.t;
    if (!fromSlider) ts.range.value = String(state.t);
    paintSlider(ts);
  }
  updatePlayhead();
}

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
  const span = state.t1 - state.t0;
  let t = state.t + (dt / PLAY_SECONDS) * span;
  if (t > state.t1) t = state.t0 + ((t - state.t0) % (span || 1));
  setTime(t);
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// The compute pipeline
// ---------------------------------------------------------------------------

function sampleCount() {
  const w = el.canvas.getBoundingClientRect().width || 900;
  const dpr = Math.min(4, Math.max(1, window.devicePixelRatio || 1));
  return Math.round(Math.min(4000, Math.max(240, w * dpr * 1.2)));
}

function recompute() {
  if (!M) return;

  const src = docSource();

  // 1. set_source - cheap, runs on every edit, never throws.
  const diag = parseJson(M.setSource(src), 'Diagnostics')
    || { states: [], params: [], issues: [] };
  const issues = Array.isArray(diag.issues) ? diag.issues : [];
  const names = Array.isArray(diag.states) ? diag.states : [];
  const params = Array.isArray(diag.params) ? diag.params : [];

  applyDiagnostics(issues);

  state.names = names;
  state.params = params;

  const hasError = issues.some((i) => i.severity === 'error');
  if (hasError) {
    // Keep the last good curve - AND the last good chips, legend and sliders -
    // on screen. The document is mid-edit, not dead, and nothing should move.
    setSolveBadge('paused on error', 'bad');
    return;
  }

  // `pending` is not an error, so the chips still track the document live:
  // `phase` lights up the moment a system gains its second state.
  updateCapabilities(names);
  renderLegend(names);
  syncSliders(params);

  if (!names.length) {
    setSolveBadge('no states', null);
    state.frame = null;
    el.statAccepted.textContent = '—';
    el.statRejected.textContent = '—';
    el.statRhs.textContent = '—';
    el.readout.innerHTML = '';
    scheduleDraw();
    return;
  }

  const t0 = state.t0;
  const t1 = state.t1;
  if (!isFinite(t0) || !isFinite(t1) || t1 <= t0) {
    setSolveBadge('bad span', 'bad');
    return;
  }

  // 2. solve
  const report = parseJson(M.solve(t0, t1), 'SolveReport');
  if (!report || report.ok !== true) {
    setSolveBadge(report && report.error ? String(report.error) : 'solve failed', 'bad');
    if (report) {
      el.statAccepted.textContent = report.accepted ?? '—';
      el.statRejected.textContent = report.rejected ?? '—';
      el.statRhs.textContent = report.rhsEvals ?? '—';
    }
    return;
  }

  el.statAccepted.textContent = report.accepted ?? '—';
  el.statRejected.textContent = report.rejected ?? '—';
  el.statRhs.textContent = report.rhsEvals ?? '—';
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

  state.t0 = isFinite(report.t0) ? report.t0 : t0;
  state.t1 = isFinite(report.t1) ? report.t1 : t1;
  state.t = clamp(state.t, state.t0, state.t1);

  const ts = sliders.get('t');
  if (ts && (ts.min !== state.t0 || ts.max !== state.t1)) {
    ts.min = state.t0;
    ts.max = state.t1;
    if (!(ts.step > 0)) ts.step = niceStepFor(state.t1 - state.t0);
    applyRange(ts);
  }

  if (!got) {
    state.frame = null;
    scheduleDraw();
    return;
  }

  if (String(reportNames) !== String(names)) {
    updateCapabilities(reportNames);
    renderLegend(reportNames);
  }

  state.frame = {
    names: reportNames,
    dim,
    n: got,
    data,
    t0: state.t0,
    t1: state.t1,
    playT: state.t,
    playY: new Float64Array(0),
    polar: polarMapFor(reportNames),
  };

  updatePlayhead();
}

let debounceTimer = 0;

function scheduleRecompute(delay = 160) {
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

// ---------------------------------------------------------------------------
// The divider - the user owns the pane widths, and they stay put
// ---------------------------------------------------------------------------

const LAYOUT_KEY = 'numpla.docWidth';
const DOC_MIN = 260;
const DOC_DEFAULT = 348;
let docWidth = DOC_DEFAULT;

function docMax() {
  return Math.max(DOC_MIN, Math.min(680, window.innerWidth - 420));
}

function setDocWidth(px, persist) {
  const w = Math.round(clamp(px, DOC_MIN, docMax()));
  docWidth = w;
  document.documentElement.style.setProperty('--doc-w', w + 'px');
  el.divider.setAttribute('aria-valuenow', String(w));
  el.divider.setAttribute('aria-valuemin', String(DOC_MIN));
  el.divider.setAttribute('aria-valuemax', String(docMax()));
  if (persist) {
    try { localStorage.setItem(LAYOUT_KEY, String(w)); } catch (err) { /* private mode */ }
  }
  scheduleDraw();
}

function restoreDocWidth() {
  let stored = null;
  try { stored = localStorage.getItem(LAYOUT_KEY); } catch (err) { stored = null; }
  const n = stored == null ? NaN : parseFloat(stored);
  setDocWidth(isFinite(n) ? n : DOC_DEFAULT, false);
}

function wireDivider() {
  el.divider.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    closeSettings();

    const startX = e.clientX;
    const startW = docWidth;
    el.divider.classList.add('is-active');
    document.body.classList.add('is-resizing');
    try { el.divider.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }

    const move = (ev) => setDocWidth(startW + (ev.clientX - startX), false);
    const up = () => {
      el.divider.removeEventListener('pointermove', move);
      el.divider.removeEventListener('pointerup', up);
      el.divider.removeEventListener('pointercancel', up);
      el.divider.classList.remove('is-active');
      document.body.classList.remove('is-resizing');
      setDocWidth(docWidth, true);
    };
    el.divider.addEventListener('pointermove', move);
    el.divider.addEventListener('pointerup', up);
    el.divider.addEventListener('pointercancel', up);
  });

  el.divider.addEventListener('dblclick', () => setDocWidth(DOC_DEFAULT, true));

  el.divider.addEventListener('keydown', (e) => {
    const nudge = e.shiftKey ? 48 : 12;
    if (e.key === 'ArrowLeft')       { e.preventDefault(); setDocWidth(docWidth - nudge, true); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setDocWidth(docWidth + nudge, true); }
    else if (e.key === 'Home')       { e.preventDefault(); setDocWidth(DOC_MIN, true); }
    else if (e.key === 'End')        { e.preventDefault(); setDocWidth(docMax(), true); }
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function isTypingTarget(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = node.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (node.isContentEditable) return true;
  return typeof node.closest === 'function' && !!node.closest('.row__field, .settings');
}

function wire() {
  collectChips();
  renderChips();
  wireDivider();

  el.addRow.addEventListener('click', () => {
    const created = makeRow('', rows.length);
    scheduleRecompute(0);
    focusRow(indexOfRow(created), false);
  });

  el.play.addEventListener('click', () => setPlaying(!state.playing));

  // a pointer released anywhere ends whatever slider drag was in progress
  const endDrag = () => { sliders.forEach((s) => { s.dragging = false; }); };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  [el.settingsMin, el.settingsMax, el.settingsStep].forEach((input) => {
    input.addEventListener('input', readSettings);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); closeSettings(); }
    });
  });

  el.demosBtn.addEventListener('click', toggleDemos);

  el.demomenu.addEventListener('keydown', (e) => {
    const items = Array.from(el.demomenu.querySelectorAll('.demoitem'));
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
      const target = items[(next + items.length) % items.length];
      if (target) target.focus();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.demomenu.hidden) {
      e.preventDefault();
      closeDemos();
      el.demosBtn.focus();
      return;
    }
    if (e.key === 'Escape' && openSlider) {
      e.preventDefault();
      const back = openSlider.nameBtn;
      closeSettings();
      back.focus();
      return;
    }
    if (e.key !== ' ' && e.code !== 'Space') return;
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    setPlaying(!state.playing);
  });

  // a click anywhere outside the overlay closes it
  document.addEventListener('pointerdown', (e) => {
    const dt = e.target;
    if (!el.demomenu.hidden && dt && typeof dt.closest === 'function' &&
        !dt.closest('.demomenu') && !dt.closest('#demos-btn')) {
      closeDemos();
    }
    if (!openSlider) return;
    const t = e.target;
    if (t && typeof t.closest === 'function' &&
        (t.closest('.settings') || t.closest('.slider.is-open'))) return;
    closeSettings();
  }, true);

  // HiDPI-correct redraw whenever the plot box changes size
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => scheduleDraw());
    document.querySelectorAll('.plot__canvas').forEach((n) => ro.observe(n));
  }

  window.addEventListener('resize', () => {
    closeSettings();
    setDocWidth(docWidth, false);   // re-clamp; the user's choice is kept
    scheduleDraw();
  });

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
  restoreDocWidth();

  // 1. the math field
  try {
    status('Loading the math field…');
    const mf = await import('./mathfield.js');
    if (typeof mf.MathField !== 'function') {
      throw new Error('mathfield.js does not export a MathField class.');
    }
    MathField = mf.MathField;
  } catch (err) {
    fail('Could not load ./mathfield.js.', err);
    return;
  }

  try {
    buildDemoMenu();
    buildRows(DEFAULT_DOC);
  } catch (err) {
    fail('The math field would not mount.', err);
    return;
  }

  // the time slider exists from the first frame: `t` is a slider like any other
  makeSlider('t', 'time', {
    min: state.t0,
    max: state.t1,
    step: niceStepFor(state.t1 - state.t0),
    value: state.t,
  });
  sliderOrderKey = 't|';

  // 2. the compute core
  let mod;
  try {
    status('Fetching compute core…');
    mod = await import('./pkg/numpla_wasm.js');
  } catch (err) {
    fail(
      'Could not load ./pkg/numpla_wasm.js — build the WASM first.',
      new Error(
        'wasm-pack build --target web --out-dir ../../app/pkg crates/numpla-wasm\n\n' +
        (err && (err.stack || err.message) ? err.stack || err.message : String(err))
      )
    );
    return;
  }

  try {
    status('Instantiating WebAssembly…');
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
    status('Integrating…');
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
