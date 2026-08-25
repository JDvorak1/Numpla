// ============================================================================
// main.js - the Numpla browser shell.
//
// Flow:
//   boot()  ->  load MathField + WASM  ->  reveal the app (eased)
//   edit    ->  debounce  ->  set_source  ->  per-row diagnostics  ->  solve
//   sliders ->  t drives eval(t); a parameter slider rewrites its own row
//
// Rows are Desmos-shaped: a blank row always sits at the end of the list and is
// not a real row until something is typed into it, Enter opens a row below, and
// Backspace in an empty row deletes it the way Backspace deletes a character.
// There is no "add row" button, because rows appear by typing.
//
// A parameter's slider lives ON the row that defines it, and only once it has
// been asked for: every scalar row offers "add slider" in the line it already
// reserves for its diagnostic.
//
// `t` IS ONE OF THOSE ROWS. It used to be a special widget in a bar of its own,
// which is exactly why it felt like a dial attached to nothing. It is a
// variable in the system now: the row `t = [0, 20]` says what the span is - a
// list literal, which today's parser already reads, and which the solver's own
// binding of `t` overrides while it integrates, so the row cannot change what
// the equations mean - and the slider promoted on that row is the playhead
// inside it. Same offer, same knob, same gear, same x as every other variable.
//
// Five structural rules this file exists to enforce:
//
//   1. GRAY-NOT-RED. `severity: "pending"` is muted. Only `"error"` is red,
//      and only an `"error"` pauses the solve - the last good curve stays on
//      screen while the document is mid-edit.
//   2. ONE PLOT. A single canvas. Each view is an independent switch, and the
//      canvas is tiled between the ones that are on. A chip the model cannot
//      support stays visible but inert, because that is how the capability is
//      discovered - and nothing is ever switched off on the user's behalf.
//   3. THE FRAME IS THE USER'S. -5..5 on both axes to begin with, then theirs:
//      drag an axis to scale it, drag the body to pan, wheel to zoom. A
//      re-solve redraws inside the frame they left.
//   4. `t` MOVES THE PICTURE. A marker rides the curve and the trajectory is
//      drawn travelled-vs-ahead, so scrubbing reads as motion. Nothing else
//      would have justified a control for it.
//   5. NOTHING MOVES WHILE YOU TYPE. Panes have explicit sizes and scroll
//      internally; diagnostics occupy reserved space; the slider settings, the
//      demo gallery and the reference are overlays. The only thing that may
//      change size is the field under the caret.
//
// No bundler, no dependencies, no network. Plain ES modules.
// ============================================================================

import { Plot, VIEWS, panned, scaled, zoomed, seriesColor, fmtValue } from './plot.js';
import { DEMOS } from './demos.js';
import { SoundPlayer, DEFAULTS as AUDIO_DEFAULTS } from './audio.js';

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
  issuebar:  $('issuebar'),
  issueMsg:  $('issue-msg'),
  issueFix:  $('issue-fix'),

  divider: $('divider'),

  views:      $('views'),
  canvas:     $('canvas'),
  frameFit:   $('frame-fit'),
  frameReset: $('frame-reset'),

  play:    $('play'),
  readout: $('readout'),

  infoBtn:    $('info-btn'),
  info:       $('infopanel'),
  infoSearch: $('info-search'),
  infoList:   $('info-list'),
  infoFoot:   $('info-foot'),
  infoClose:  $('info-close'),

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

  hearBtn:   $('hear-btn'),
  hearPanel: $('hearpanel'),
  hearClose: $('hear-close'),
  hearState: $('hear-state'),
  hearFrom:  $('hear-from'),
  hearTo:    $('hear-to'),
  hearComp:  $('hear-compression'),
  hearNote:  $('hear-note'),
  hearPlay:  $('hear-play'),

  demosBtn: $('demos-btn'),
  demomenu: $('demomenu'),
};

const plot = new Plot(el.canvas);

const DEFAULT_DOC = [
  't = [0, 20]',
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
let ModelCtor = null;     // the Model class itself - demo previews need their own
let MathField = null;     // the class from ./mathfield.js
let funcNames = () => []; // MathField's functionNamesIn, bound at boot

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
//
// `rows` holds every row, and the LAST one is always the trailing blank row: a
// real, focusable field that is not part of the document. It is not numbered,
// never diagnosed and never reaches the solver; the moment something is typed
// into it, it becomes a real row and a fresh blank one takes its place. Because
// it is always last, leaving it out of the document cannot shift any other
// row's line number - row i is still line i.
// ---------------------------------------------------------------------------

/** @type {{el:HTMLElement, host:HTMLElement, idxEl:HTMLElement,
 *          msgEl:HTMLElement, footEl:HTMLElement, knobEl:HTMLElement,
 *          offerEl:HTMLButtonElement, offerName:string, knobKey:string,
 *          field:any}[]} */
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

/** "Nothing has been typed here" - the trailing blank row's whole definition. */
function rowIsEmpty(row) {
  if (!row) return true;
  try {
    if (row.field && typeof row.field.isEmpty === 'function') return !!row.field.isEmpty();
  } catch (err) { /* fall through to the source */ }
  return rowSource(row).trim() === '';
}

/**
 * A `# ...` row: prose for the reader, skipped by the parser. The field knows
 * (it renders comments as prose); the text is the fallback.
 */
function isCommentRow(row) {
  try {
    if (row && row.field && typeof row.field.isComment === 'function') {
      return !!row.field.isComment();
    }
  } catch (err) { /* fall through to the source */ }
  return rowSource(row).trim().charAt(0) === '#';
}

/**
 * How many rows are real: everything except a trailing blank one. Computed
 * rather than remembered, so it is correct even in the middle of a keystroke.
 */
function realRowCount() {
  const n = rows.length;
  return n && rowIsEmpty(rows[n - 1]) ? n - 1 : n;
}

function realRows() {
  return rows.slice(0, realRowCount());
}

function isTailRow(row) {
  const n = rows.length;
  return n > 0 && rows[n - 1] === row && rowIsEmpty(row);
}

/** The document sent to set_source: the REAL rows' sources, joined. */
function docSource() {
  return realRows().map(rowSource).join('\n');
}

function indexOfRow(row) {
  return rows.indexOf(row);
}

/**
 * The number in the gutter counts equations. Comment rows, blank spacer rows
 * and the trailing blank get none - a document with four lines of prose in it
 * should not read as a list with holes punched in it. A row's *position* is
 * still its line, which is what diagnostics are keyed by.
 */
function renumber() {
  const real = realRowCount();
  let n = 0;
  rows.forEach((row, i) => {
    const tail = i >= real;
    const comment = !tail && isCommentRow(row);
    const blank = !tail && rowIsEmpty(row);
    row.el.classList.toggle('is-tail', tail);
    row.el.classList.toggle('is-comment', comment);
    row.idxEl.textContent = (tail || comment || blank) ? '' : String(++n);
    if (tail) setRowDiagnostic(row, null, '');
  });
}

/** The invariant: a blank row is always sitting at the end of the list. */
function ensureTail() {
  if (rows.length && rowIsEmpty(rows[rows.length - 1])) return null;
  return makeRow('', rows.length);
}

/**
 * Put the caret in a row. `atEnd` is the entire point of this function: walking
 * UP into a row, or backspacing INTO one, has to land after that row's last
 * atom, never before its first. MathField.focus() takes no position, so the
 * caret is set on the model first and the field is repainted after focusing.
 */
function placeCaret(row, atEnd) {
  if (!row || !row.field) return;
  try {
    const m = row.field.model;
    if (m && typeof m.end === 'function' && typeof m.home === 'function') {
      if (atEnd) m.end(); else m.home();
    }
    row.field.focus();
    if (typeof row.field.render === 'function') row.field.render();
  } catch (err) {
    console.error('[numpla] focusing a row threw', err);
  }
  setActiveRow(row);
}

function focusRow(i, atEnd) {
  placeCaret(rows[clamp(i, 0, rows.length - 1)], atEnd);
}

/** Clicking the empty space below the list lands in the blank row. */
function focusTail() {
  ensureTail();
  placeCaret(rows[rows.length - 1], true);
}

/** The row the reference inserts into: the last one that had the caret. */
let lastActiveRow = null;

function setActiveRow(row) {
  if (row) lastActiveRow = row;
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

// ---------------------------------------------------------------------------
// Which names the document defines as functions
//
// `d(x, y)` is a call only when the document has a `d(x, y) = ...` row;
// otherwise it is `d` times `(x, y)`. Same tokens, two different systems. The
// Rust parser resolves this in a two-pass compile, and the field has to agree
// with it or a correct document gets silently rewritten into a broken one - so
// the shell is what tells both of them, from the one document they share.
//
// Rows are constructed with the set already known, which is the reliable path:
// once a row has been DISPLAYED in the wrong reading, its text genuinely means
// the wrong thing and re-reading it later cannot always recover the intent.
// setFunctions() is the safety net for a definition appearing later.
// ---------------------------------------------------------------------------

let docFunctions = [];

/**
 * What the document itself calls things, for Tab completion. `functions` is
 * NOT included: refreshFunctions() owns that fact and forwarding it from two
 * places would let the two drift apart.
 */
function docNames() {
  return { functions: docFunctions, params: state.params || [], states: state.names || [] };
}

/** Push the document's vocabulary to every row. Completion only; never re-reads. */
function refreshDocumentNames() {
  const names = docNames();
  for (const row of rows) {
    try {
      if (row.field && typeof row.field.setDocumentNames === 'function') {
        row.field.setDocumentNames({ params: names.params, states: names.states });
      }
    } catch (err) {
      console.error('[numpla] MathField.setDocumentNames threw', err);
    }
  }
}

const sameNames = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Re-derive the function set from the document and hand it to every row.
 * Returns true if any row had to be re-read - its `source` may have changed, so
 * the caller must re-read the document too.
 */
function refreshFunctions(src) {
  let next;
  try {
    next = funcNames(src) || [];
  } catch (err) {
    console.error('[numpla] functionNamesIn threw', err);
    return false;
  }
  if (sameNames(next, docFunctions)) return false;
  docFunctions = next;

  let changed = false;
  for (const row of rows) {
    try {
      if (row.field && typeof row.field.setFunctions === 'function' &&
          row.field.setFunctions(next)) {
        changed = true;
      }
    } catch (err) {
      console.error('[numpla] MathField.setFunctions threw', err);
    }
  }
  return changed;
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

  // The reserved line under the field. It carries the diagnostic AND the slider
  // offer, so neither of them appearing can move anything: the space is already
  // spoken for.
  const footEl = document.createElement('div');
  footEl.className = 'row__foot';

  const msgEl = document.createElement('div');
  msgEl.className = 'row__msg';

  const offerEl = document.createElement('button');
  offerEl.type = 'button';
  offerEl.className = 'row__offer';
  offerEl.textContent = 'add slider';
  offerEl.hidden = true;

  footEl.append(msgEl, offerEl);

  // Where a promoted slider lives. Empty (and therefore invisible) otherwise.
  const knobEl = document.createElement('div');
  knobEl.className = 'row__knob';

  wrap.append(idxEl, host, del, footEl, knobEl);

  const row = {
    el: wrap, host, idxEl, msgEl, footEl, knobEl, offerEl,
    offerName: '', knobKey: '', field: null,
  };

  const index = at == null ? rows.length : clamp(at, 0, rows.length);
  const before = rows[index] ? rows[index].el : null;
  el.rows.insertBefore(wrap, before);
  rows.splice(index, 0, row);

  row.field = new MathField(host, {
    value: source || '',
    functions: docFunctions,
    documentNames: docNames(),
    onChange: () => {
      // Typing into the blank row is what makes it a row. A fresh blank one
      // takes its place immediately, so the list always ends in one.
      ensureTail();
      renumber();
      scheduleRecompute();
    },
    onFocus: () => setActiveRow(row),
    onBlur: () => row.el.classList.remove('is-active'),
    onEnter: () => insertAfter(row),
    onNavigate: (field, dir) => navigate(row, dir),
  });

  del.addEventListener('click', (e) => {
    e.preventDefault();
    const i = removeRow(row);
    if (i >= 0) focusRow(Math.min(i, rows.length - 1), true);
  });

  offerEl.addEventListener('click', (e) => {
    e.preventDefault();
    promoteParam(row.offerName);
  });

  // Backspace in an already-empty row deletes the row and leaves the caret at
  // the END of the row above - deleting the row you are in should feel like
  // deleting a character, not like operating a control. Captured on the host so
  // it is decided BEFORE the field sees the key; otherwise the backspace that
  // empties a field would delete its row in the same stroke.
  host.addEventListener('keydown', (e) => {
    if (e.key !== 'Backspace' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!rowIsEmpty(row)) return;                 // there is a character to eat
    const i = indexOfRow(row);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();

    if (isTailRow(row)) {
      // The blank row is not a row, so there is nothing here to delete. Step
      // back over it instead, the way backspacing over a line break does.
      if (i > 0) focusRow(i - 1, true);
      return;
    }

    removeRow(row);
    // i > 0: land at the end of the row above. i === 0: there is no row above,
    // so land at the start of whatever moved up into first place.
    focusRow(Math.max(0, i - 1), i > 0);
  }, true);

  renumber();
  return row;
}

function insertAfter(row) {
  const i = indexOfRow(row);
  const created = makeRow('', i < 0 ? rows.length : i + 1);
  ensureTail();
  renumber();
  scheduleRecompute();
  placeCaret(created, false);
  return created;
}

/** Removes a row and returns the index it occupied (-1 if it was not there). */
function removeRow(row) {
  const i = indexOfRow(row);
  if (i < 0) return -1;

  if (lastActiveRow === row) lastActiveRow = null;
  if (openSlider && openSlider.el && row.el.contains(openSlider.el)) closeSettings();

  try { row.field.destroy(); } catch (err) { console.error('[numpla] destroy threw', err); }
  row.el.remove();
  rows.splice(i, 1);
  ensureTail();
  renumber();
  scheduleRecompute(0);
  return i;
}

function buildRows(lines) {
  // Before any row is constructed: a row that has already been displayed in the
  // wrong reading cannot always be talked out of it.
  try {
    docFunctions = funcNames(lines.join('\n')) || [];
  } catch (err) {
    console.error('[numpla] functionNamesIn threw', err);
    docFunctions = [];
  }
  lines.forEach((line) => makeRow(line, null));
  ensureTail();
  renumber();
}

function clearRows() {
  closeSettings();
  lastActiveRow = null;
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
// know - so loading one stages those ranges for syncKnobs to pick up when it
// creates the sliders.
// ---------------------------------------------------------------------------

const pendingKnobs = new Map();

function loadDemo(demo) {
  closeDemos();
  closeSettings();
  setPlaying(false);

  // A demo's author has already answered the question the offer asks, so its
  // knobs arrive promoted, with the ranges over which they are interesting.
  pendingKnobs.clear();
  promoted.clear();
  knobRanges.clear();
  promoted.add('t');           // the playhead is on by default, like a demo knob
  for (const k of demo.knobs || []) {
    pendingKnobs.set(k.name, k);
    promoted.add(k.name);
  }

  // Drop every slider so they are rebuilt against the demo's ranges.
  for (const [name, s] of Array.from(sliders)) {
    s.el.remove();
    sliders.delete(name);
  }

  const [t0, t1] = demo.tSpan;
  state.t0 = t0;
  state.t1 = t1;
  state.t = t0;

  // A demo declares its span in `tSpan` rather than in its source, so the shell
  // writes the row that says it. It is an ordinary row from that moment on:
  // editable, sliderable, deletable.
  const lines = demo.source.split('\n');
  if (!lines.some((line) => SPAN_RE.test(line.split('#')[0]))) {
    lines.unshift(spanRow(t0, t1));
  }

  clearRows();
  buildRows(lines);

  el.demosBtn.setAttribute('data-demo', demo.title);
  scheduleRecompute(0);
}

// ---------------------------------------------------------------------------
// Hear
//
// Sound is another way of looking at a signal, so it lives beside the view
// switches rather than being a headline control. The window and the speed are
// exposed because they are the whole interaction: a trajectory over t in [0,20]
// is not twenty seconds of interesting sound, and mapping simulation time onto
// audio time is the honest version of a pitch control.
// ---------------------------------------------------------------------------

const player = new SoundPlayer();
let hearing = false;

function hearStateNames() {
  return state.names && state.names.length ? state.names : [];
}

function openHear() {
  const names = hearStateNames();
  el.hearState.textContent = '';
  names.forEach((n, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = n;
    el.hearState.append(o);
  });
  el.hearState.disabled = names.length === 0;

  if (!el.hearFrom.value) el.hearFrom.value = String(state.t0);
  if (!el.hearTo.value) el.hearTo.value = String(state.t1);
  if (!el.hearComp.value) el.hearComp.value = String(AUDIO_DEFAULTS.compression);

  const r = el.hearBtn.getBoundingClientRect();
  el.hearPanel.hidden = false;
  el.hearBtn.setAttribute('aria-expanded', 'true');
  const w = el.hearPanel.offsetWidth;
  el.hearPanel.style.left = clamp(r.left, 8, Math.max(8, window.innerWidth - w - 8)) + 'px';
  el.hearPanel.style.top = (r.bottom + 8) + 'px';

  if (names.length === 0) note('nothing to listen to yet — solve a system first');
}

function closeHear() {
  if (el.hearPanel.hidden) return;
  el.hearPanel.hidden = true;
  el.hearBtn.setAttribute('aria-expanded', 'false');
}

function note(text) {
  el.hearNote.textContent = text;
}

function setHearing(on) {
  hearing = on;
  el.hearPlay.textContent = on ? 'stop' : 'listen';
  el.hearBtn.classList.toggle('is-on', on);
}

async function toggleHear() {
  if (hearing) {
    player.stop();
    setHearing(false);
    return;
  }
  if (!M) return;
  const idx = Number(el.hearState.value);
  const from = Number(el.hearFrom.value);
  const to = Number(el.hearTo.value);
  const compression = Number(el.hearComp.value);
  if (!isFinite(from) || !isFinite(to) || to <= from) {
    note('the window needs to run forwards');
    return;
  }
  try {
    setHearing(true);
    note('rendering…');
    // renderModel only needs an eval(t); M.eval is the bound wasm method.
    const rendered = await player.playModel({ eval: M.eval }, {
      state: Number.isFinite(idx) ? idx : 0,
      window: [from, to],
      compression: isFinite(compression) && compression > 0 ? compression : undefined,
      onended: () => setHearing(false),
    });
    const secs = rendered && rendered.duration ? rendered.duration.toFixed(1) : '?';
    note(rendered && rendered.silent
      ? 'that state never moves — nothing to hear'
      : `${secs}s of sound${rendered && rendered.clipped ? ' (window shortened)' : ''}`);
    if (rendered && rendered.silent) setHearing(false);
  } catch (err) {
    setHearing(false);
    note(String((err && err.message) || err));
    console.error('[numpla] hear failed', err);
  }
}

function buildDemoMenu() {
  el.demomenu.textContent = '';
  DEMOS.forEach((demo, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'demoitem';
    item.setAttribute('role', 'menuitem');
    item.dataset.index = String(i);

    // The blurb is no longer on screen - the preview says it better - but it is
    // still the best hover text there is.
    const tip = [demo.blurb, demo.audio ? 'a good candidate for render-to-sound' : '']
      .filter(Boolean).join(' · ');
    if (tip) item.title = tip;

    const title = document.createElement('span');
    title.className = 'demoitem__title';
    title.textContent = demo.title;

    const canvas = document.createElement('canvas');
    canvas.className = 'demoitem__preview';
    canvas.width = PREVIEW_W;
    canvas.height = PREVIEW_H;
    canvas.setAttribute('aria-hidden', 'true');

    item.append(title, canvas);
    item.addEventListener('click', () => loadDemo(demo));
    el.demomenu.append(item);
  });
}

// -- previews ---------------------------------------------------------------
//
// The entry shows what the demo actually does: a thumbnail of its own
// trajectory. Each is a throwaway Model - set_source, solve, sample - drawn
// once into a small canvas. They are generated the first time the menu opens,
// one per animation frame so the menu paints immediately, and never again: the
// menu's DOM outlives closing it, so the pixels are the cache. A preview that
// cannot be produced takes its canvas with it, leaving the title alone.

const PREVIEW_W = 112;
const PREVIEW_H = 34;
const PREVIEW_N = 220;
let previewsStarted = false;

function previewSeries(demo) {
  let m = null;
  try {
    m = new ModelCtor();
    const setSource = bindMethod(m, 'set_source');
    const solve = bindMethod(m, 'solve');
    const sample = bindMethod(m, 'sample');

    const diag = parseJson(setSource(demo.source), 'Diagnostics');
    if (!diag) return null;
    const issues = Array.isArray(diag.issues) ? diag.issues : [];
    if (issues.some((i) => i.severity === 'error')) return null;

    const span = Array.isArray(demo.tSpan) && demo.tSpan.length === 2 ? demo.tSpan : [0, 20];
    const report = parseJson(solve(span[0], span[1]), 'SolveReport');
    if (!report || report.ok !== true) return null;

    const dim = Number.isInteger(report.dim) ? report.dim : 0;
    if (dim < 1) return null;

    const stride = dim + 1;
    const data = toF64(sample(PREVIEW_N));
    const n = Math.floor(data.length / stride);
    return n >= 2 ? { dim, stride, n, data } : null;
  } catch (err) {
    console.warn('[numpla] demo preview failed:', demo && demo.title, err);
    return null;
  } finally {
    try { if (m && typeof m.free === 'function') m.free(); } catch (err) { /* fine */ }
  }
}

function drawPreview(canvas, s) {
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.round(PREVIEW_W * dpr);
  canvas.height = Math.round(PREVIEW_H * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);

  // One shared range for every state, so their relative sizes stay honest.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < s.n; i++) {
    for (let d = 1; d <= s.dim; d++) {
      const v = s.data[i * s.stride + d];
      if (!isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!isFinite(lo) || !isFinite(hi)) return false;
  if (hi - lo < 1e-12) { const c = (hi + lo) / 2; lo = c - 1; hi = c + 1; }

  const padX = 3;
  const padY = 4;
  const xAt = (i) => padX + (i / (s.n - 1)) * (PREVIEW_W - padX * 2);
  const yAt = (v) => PREVIEW_H - padY - ((v - lo) / (hi - lo)) * (PREVIEW_H - padY * 2);

  const shown = Math.min(s.dim, 3);
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let d = 0; d < shown; d++) {
    ctx.strokeStyle = seriesColor(d);
    ctx.globalAlpha = d === 0 ? 1 : 0.5;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < s.n; i++) {
      const v = s.data[i * s.stride + d + 1];
      if (!isFinite(v)) { started = false; continue; }
      const px = xAt(i);
      const py = yAt(v);
      if (started) { ctx.lineTo(px, py); } else { ctx.moveTo(px, py); started = true; }
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return true;
}

function generatePreviews() {
  if (previewsStarted || typeof ModelCtor !== 'function') return;
  previewsStarted = true;

  const items = Array.from(el.demomenu.querySelectorAll('.demoitem'));
  let i = 0;
  const step = () => {
    if (i >= items.length) return;
    const item = items[i++];
    const canvas = item.querySelector('.demoitem__preview');
    const demo = DEMOS[Number(item.dataset.index)];
    if (canvas) {
      let ok = false;
      try {
        const s = demo ? previewSeries(demo) : null;
        ok = s ? drawPreview(canvas, s) : false;
      } catch (err) {
        console.warn('[numpla] preview draw failed', err);
        ok = false;
      }
      if (!ok) canvas.remove();      // just the title; never a broken box
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function openDemos() {
  const r = el.demosBtn.getBoundingClientRect();
  el.demomenu.hidden = false;
  el.demosBtn.setAttribute('aria-expanded', 'true');
  generatePreviews();
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

  const real = realRowCount();
  rows.forEach((row, i) => {
    // The trailing blank row is not part of the document and a comment row is
    // prose for the reader: neither is ever diagnosed.
    const d = (i < real && !isCommentRow(row)) ? worst.get(i) : null;
    setRowDiagnostic(row, d ? d.sev : null, d ? d.msg : '');
  });

  renderIssueBar(issues);
}

// ---------------------------------------------------------------------------
// The issue bar - what the document still needs, and the default on offer
//
// A state with no initial condition used to start silently at zero: a guess
// presented as a fact. Now it is stated in a plain sentence, with the default
// one click away. `fix` is optional in the contract - the compiler emits it
// only when it can propose something concrete - so a missing `fix` means no
// button, never a crash and never an empty one.
// ---------------------------------------------------------------------------

const squash = (s) => s.replace(/\s+/g, '');

function usableFix(it) {
  const f = it && it.fix;
  if (!f || typeof f !== 'object') return null;
  const insert = typeof f.insert === 'string' ? f.insert.trim() : '';
  if (!insert) return null;
  const label = typeof f.label === 'string' && f.label.trim()
    ? f.label.trim()
    : 'add ' + insert;
  const message = typeof it.message === 'string' && it.message.trim()
    ? it.message.trim()
    : label;
  return { insert, label, message };
}

/** The fixes the bar is currently offering, in the order they were reported. */
let offeredFixes = [];

function renderIssueBar(issues) {
  const errs = issues.filter((i) => i.severity === 'error').length;
  const pend = issues.length - errs;

  // Something already written down is not missing, whatever the compiler said
  // a moment ago.
  const have = new Set(realRows().map((r) => squash(rowSource(r))));
  const seen = new Set();
  const fixes = [];
  for (const it of issues) {
    const f = usableFix(it);
    if (!f) continue;
    const key = squash(f.insert);
    if (seen.has(key) || have.has(key)) continue;
    seen.add(key);
    fixes.push(f);
  }

  // A genuine error outranks a missing default: there is no point offering to
  // complete a document that cannot be read yet.
  offeredFixes = errs ? [] : fixes;

  if (offeredFixes.length) {
    const more = offeredFixes.length - 1;
    el.issueMsg.textContent = more
      ? offeredFixes[0].message + ' · and ' + more + ' more'
      : offeredFixes[0].message;
    // One fix gets its own imperative label. Several share one button: they are
    // all the same kind of answer - "this is what it would have assumed" - and
    // making someone click through them one re-solve at a time is exactly the
    // asking-for-things this is meant to remove. Every row still carries its
    // own message, so batching hides nothing.
    el.issueFix.textContent = more
      ? 'add all ' + offeredFixes.length + ' defaults'
      : offeredFixes[0].label;
    el.issueFix.title = offeredFixes.map((f) => f.insert).join('   ·   ');
    el.issueFix.hidden = false;
    el.issuebar.classList.add('has-fix');
  } else {
    const bits = [];
    if (errs) bits.push(errs + (errs === 1 ? ' error' : ' errors'));
    if (pend) bits.push(pend + ' pending');
    el.issueMsg.textContent = bits.length ? bits.join(' · ') : 'clean';
    el.issueFix.hidden = true;
    el.issueFix.textContent = '';
    el.issueFix.removeAttribute('title');
    el.issuebar.classList.remove('has-fix');
  }

  el.issueMsg.classList.toggle('is-error', errs > 0);
}

/** Append every proposed row to the document, then recompile. */
function applyOfferedFixes() {
  if (!offeredFixes.length) return;
  const have = new Set(realRows().map((r) => squash(rowSource(r))));
  let last = null;
  for (const f of offeredFixes) {
    const key = squash(f.insert);
    if (have.has(key)) continue;
    have.add(key);
    last = makeRow(f.insert, realRowCount());   // before the trailing blank row
  }

  offeredFixes = [];
  el.issueFix.hidden = true;
  el.issuebar.classList.remove('has-fix');

  ensureTail();
  renumber();
  scheduleRecompute(0);
  // The button that had focus has just gone away; put the caret where the new
  // text is instead of dropping focus on the floor.
  if (last) placeCaret(last, true);
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

/**
 * The views that are ON. A set, not a choice: `t–y`, `phase` and `polar` are
 * three independent switches and any number of them may be on at once. The
 * canvas is tiled between them (see plot.js, "HOW SEVERAL VIEWS SHARE THE
 * CANVAS"). Nothing but a click on its own chip ever takes a view out of here.
 */
const viewsOn = new Set(['time']);

function collectChips() {
  el.views.querySelectorAll('.viewchip').forEach((btn) => {
    const view = btn.dataset.view;
    if (!view) return;
    chips.set(view, btn);
    btn.addEventListener('click', () => toggleView(view));
  });
}

function renderChips() {
  chips.forEach((btn, view) => {
    const ok = !!caps[view];
    const on = viewsOn.has(view);
    btn.classList.toggle('is-on', on);
    btn.classList.toggle('is-off', !ok);
    // Inert only while it is off AND unsupported: a view that is already on
    // can always be turned off, whatever the document has become.
    btn.setAttribute('aria-disabled', ok || on ? 'false' : 'true');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const t = CHIP_TITLE[view];
    if (t) btn.title = ok ? t[0] : t[1];
  });
}

/** Push the on-set and the capability set at the plot, then repaint. */
function applyViews() {
  plot.setViews(VIEWS.filter((v) => viewsOn.has(v)));
  plot.setSupport(caps);
  renderChips();
  syncFrameButtons();
  scheduleDraw();
}

function toggleView(view) {
  if (!chips.has(view)) return;
  if (viewsOn.has(view)) viewsOn.delete(view);
  else if (caps[view]) viewsOn.add(view);
  else return;                      // muted chips are inert, not hidden
  applyViews();
}

/**
 * What the document can currently show. This NEVER changes what is on: a view
 * that loses its support stays where the user put it and says why on its own
 * tile, because switching something off on someone's behalf is how a UI
 * teaches them not to trust it.
 */
function updateCapabilities(names) {
  caps.time = true;
  caps.phase = Array.isArray(names) && names.length === 2;
  caps.polar = polarMapFor(names) !== null;
  plot.setSupport(caps);
  renderChips();
}

// ---------------------------------------------------------------------------
// The readout - which is also the legend
//
// Colour, name, and the value at the playhead: a separate legend would repeat
// two thirds of that, so there is only one of them and it sits on the plot's
// control strip.
// ---------------------------------------------------------------------------

function renderReadout(names, values) {
  el.readout.innerHTML = '';
  if (!Array.isArray(names) || !names.length) return;

  // `t` first, because with no widget of its own this is where it is read.
  const tc = document.createElement('span');
  tc.className = 'chip chip--t';
  const td = document.createElement('span');
  td.className = 'chip__dot';
  const tn = document.createElement('span');
  tn.className = 'chip__name';
  tn.textContent = 't';
  const tv = document.createElement('span');
  tv.className = 'chip__val';
  tv.textContent = fmtValue(state.t);
  tc.append(td, tn, tv);
  el.readout.appendChild(tc);

  const have = values && values.length;
  names.forEach((name, i) => {
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
    v.textContent = have && i < values.length ? fmtValue(values[i]) : '—';
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
// The frame - -5..5 by default, and the user's from then on
//
// Desmos' bargain: a fixed, predictable window is what makes two runs
// comparable, so the plot does not fit itself around the data. What it does
// instead is put the frame entirely in the user's hands:
//
//   drag the plot body      pan both axes
//   drag along the x labels scale x about the value you grabbed
//   drag along the y labels scale y about the value you grabbed
//   wheel                   zoom about the cursor (over an axis: that axis)
//   double click            that tile back to -5..5
//   the -5..5 button        every tile back to -5..5
//   the fit button          every tile around its own curve, when asked
//
// A re-solve never touches any of it.
// ---------------------------------------------------------------------------

function syncFrameButtons() {
  const dirty = !plot.isDefaultFrame();
  el.frameReset.classList.toggle('is-live', dirty);
  el.frameReset.setAttribute('aria-disabled', dirty ? 'false' : 'true');
  el.frameFit.disabled = !state.frame;
}

function resetFrames() {
  plot.resetAllWindows();
  syncFrameButtons();
  scheduleDraw();
}

function fitFrames() {
  if (!state.frame) return;
  for (const view of VIEWS) {
    if (!viewsOn.has(view)) continue;
    const win = plot.fitWindow(view, state.frame);
    if (win) plot.setWindow(view, win);
  }
  syncFrameButtons();
  scheduleDraw();
}

/** Where the pointer is, in the canvas' own CSS pixels. */
function canvasPoint(e) {
  const r = el.canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

const CURSOR = { body: 'grab', x: 'ew-resize', y: 'ns-resize' };

function wireCanvasGestures() {
  const cv = el.canvas;
  let drag = null;

  cv.addEventListener('pointermove', (e) => {
    if (drag) return;
    const p = canvasPoint(e);
    const hit = plot.hit(p.x, p.y);
    cv.style.cursor = hit ? CURSOR[hit.region] : 'default';
  });

  cv.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    const p = canvasPoint(e);
    const hit = plot.hit(p.x, p.y);
    if (!hit) return;
    e.preventDefault();
    closeSettings();

    drag = {
      id: e.pointerId,
      view: hit.view,
      box: hit.box,
      region: hit.region,
      x: p.x,
      y: p.y,
      // The window as it was when the gesture began. Every move recomputes
      // from this rather than accumulating, so a drag cannot drift.
      win: plot.getWindow(hit.view),
      anchor: plot.dataAt(hit.view, hit.box, p.x, p.y),
      moved: false,
    };
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }
    if (hit.region === 'body') cv.style.cursor = 'grabbing';

    const move = (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const q = canvasPoint(ev);
      const dx = q.x - drag.x;
      const dy = q.y - drag.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;

      if (drag.region === 'body') {
        plot.setWindow(drag.view, panned(drag.win, drag.box, dx, dy));
      } else if (drag.region === 'x') {
        // Drag right and the axis stretches: the span shrinks, the value you
        // grabbed stays under the pointer.
        const w = Math.max(1, drag.box.R - drag.box.L);
        plot.setWindow(drag.view, scaled(drag.win, 'x', Math.exp(-dx / (w * 0.5)), drag.anchor.x));
      } else {
        const h = Math.max(1, drag.box.B - drag.box.T);
        plot.setWindow(drag.view, scaled(drag.win, 'y', Math.exp(dy / (h * 0.5)), drag.anchor.y));
      }
      syncFrameButtons();
      scheduleDraw();
    };

    const up = (ev) => {
      if (drag && ev.pointerId !== drag.id) return;
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('pointercancel', up);
      drag = null;
      const q = canvasPoint(ev);
      const h = plot.hit(q.x, q.y);
      cv.style.cursor = h ? CURSOR[h.region] : 'default';
    };

    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
  });

  cv.addEventListener('dblclick', (e) => {
    const p = canvasPoint(e);
    const hit = plot.hit(p.x, p.y);
    if (!hit) return;
    e.preventDefault();
    plot.resetWindow(hit.view);
    syncFrameButtons();
    scheduleDraw();
  });

  // Wheel zooms about the cursor. Over an axis strip it zooms that axis only,
  // which is the same gesture as dragging it, without the drag.
  cv.addEventListener('wheel', (e) => {
    const p = canvasPoint(e);
    const hit = plot.hit(p.x, p.y);
    if (!hit) return;
    e.preventDefault();
    const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const f = Math.exp(clamp(step, -260, 260) / 420);
    const at = plot.dataAt(hit.view, hit.box, p.x, p.y);
    const win = plot.getWindow(hit.view);
    if (hit.region === 'x') plot.setWindow(hit.view, scaled(win, 'x', f, at.x));
    else if (hit.region === 'y') plot.setWindow(hit.view, scaled(win, 'y', f, at.y));
    else plot.setWindow(hit.view, zoomed(win, f, at.x, at.y));
    syncFrameButtons();
    scheduleDraw();
  }, { passive: false });
}

// ---------------------------------------------------------------------------
// Sliders
//
// A slider is a statement that THIS number is worth playing with, and only the
// person writing the document knows which ones those are. So a scalar row is
// offered a slider - a quiet "add slider" in the line the row already reserves
// - and one click promotes it into a real slider, sitting on the row that
// defines the number it drives. The × on it goes back to the offer.
//
// `t` is no longer an exception to any of that. Its row says `t = [0, 20]`, it
// is offered a slider like every other variable, and it arrives promoted the
// way a demo's knobs do - because the playhead is what the plot is for. What
// dragging it means is the only difference: a parameter slider rewrites its row
// and re-solves, `t`'s moves the playhead through a solution already computed.
//
// Range and step live in an overlay that opens on demand - they are set once,
// while the value is watched constantly, so giving them permanent screen space
// buries the number that matters. The overlay is positioned over the page
// rather than inserted into it, so opening it cannot move anything.
// ---------------------------------------------------------------------------

const GEAR_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/>' +
  '<circle cx="13" cy="8" r="1.5"/></svg>';

/** name -> slider record. Every variable that has been asked for, `t` included. */
const sliders = new Map();
let openSlider = null;

/** Parameter names the user (or a demo) has asked to have a slider for. */
const promoted = new Set();

/** name -> the range the user chose, kept across recompiles and row edits. */
const knobRanges = new Map();

function wireRange(s) {
  s.range.addEventListener('pointerdown', () => { s.dragging = true; });
  s.range.addEventListener('input', () => {
    const v = Number(s.range.value);
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
}

/**
 * A slider, on the row that defines the thing it drives. It carries no name and
 * no value readout, because the row above it says both - `k = 60` is the
 * readout, and dragging rewrites it live.
 *
 * `t` gets exactly this, from exactly this function. The only difference is
 * what dragging it means: a parameter slider rewrites its row and re-solves,
 * while `t`'s moves the playhead through a solution that is already there.
 *
 * @param {'param'|'time'} kind
 */
function makeSlider(name, init, kind) {
  const wrap = document.createElement('div');
  wrap.className = 'knob';
  wrap.dataset.name = name;

  const range = document.createElement('input');
  range.type = 'range';
  range.className = 'range';
  range.setAttribute('aria-label', name);

  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'knob__btn knob__gear';
  gear.innerHTML = GEAR_SVG;
  gear.title = kind === 'time'
    ? 'The span t is integrated over'
    : 'Range and step for ' + name;
  gear.setAttribute('aria-label', 'Range and step for ' + name);
  gear.setAttribute('aria-expanded', 'false');

  const off = document.createElement('button');
  off.type = 'button';
  off.className = 'knob__btn knob__off';
  off.textContent = DEL_MARK;
  off.title = 'Remove the slider for ' + name;
  off.setAttribute('aria-label', 'Remove the slider for ' + name);

  wrap.append(range, gear, off);

  const knob = pendingKnobs.get(name);
  const s = {
    name,
    kind: kind === 'time' ? 'time' : 'param',
    label: kind === 'time'
      ? 'the playhead'
      : (knob && knob.label ? String(knob.label) : ''),
    el: wrap,
    nameBtn: gear,          // what the settings overlay hangs off and returns to
    valueEl: null,
    range,
    min: init.min,
    max: init.max,
    step: init.step,
    value: init.value,
    dragging: false,
  };

  gear.addEventListener('click', (e) => { e.preventDefault(); openSettingsFor(s); });
  off.addEventListener('click', (e) => { e.preventDefault(); demoteParam(name); });

  wireRange(s);
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
  // No readout of its own: the row above it is the readout, and for `t` the
  // readout on the plot is. The hover text is where a demo's description of the
  // knob goes.
  s.range.title = s.name + ' = ' + fmtStepped(s.value, s.step) +
    (s.label ? ' · ' + s.label : '');
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
    ? 'min and max are the span; they rewrite the row · Esc to close'
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

  // A chosen range outlives the slider: deleting and retyping the row, or
  // dismissing and re-adding the slider, must not throw it away.
  if (s.kind === 'param') {
    knobRanges.set(s.name, { min: s.min, max: s.max, step: s.step });
  }

  // The span is written down in the document, so changing it here changes the
  // row that says it - the same bargain a parameter slider makes.
  if (s.kind === 'time' && spanChanged) writeSpan(s);
}

// -- parameter sliders write back into their own row ------------------------

const NUM = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?`;

const ASSIGN_RE = new RegExp(String.raw`^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(${NUM})\s*$`);

/**
 * The row that says how far time runs: `t = [0, 20]`.
 *
 * A list literal, because that is a row the parser already reads and the math
 * field already draws - no new row kind was invented to get `t` onto the page.
 * The solver rebinds `t` at every right-hand-side evaluation, so the row cannot
 * change what the equations mean; it is read by the shell and inert to the
 * engine, which is exactly what "the span" is.
 */
const SPAN_RE = new RegExp(String.raw`^\s*t\s*=\s*\[\s*(${NUM})\s*,\s*(${NUM})\s*\]\s*$`);

/** The first well-formed span row, or null when the document has none. */
function scanSpan() {
  for (const row of realRows()) {
    const m = SPAN_RE.exec(rowSource(row).split('#')[0]);
    if (!m) continue;
    const t0 = Number(m[1]);
    const t1 = Number(m[2]);
    if (isFinite(t0) && isFinite(t1) && t1 > t0) return { row, t0, t1 };
  }
  return null;
}

/** The text of a span row, for writing one. */
const spanRow = (t0, t1) => 't = [' + numText(t0, 0.001) + ', ' + numText(t1, 0.001) + ']';

/** Every `name = <number>` row in the document, mapped to its row. */
function scanAssignments() {
  const map = new Map();
  for (const row of realRows()) {
    const code = rowSource(row).split('#')[0];
    const m = ASSIGN_RE.exec(code);
    if (m && !map.has(m[1])) map.set(m[1], { value: Number(m[2]), row });
  }
  return map;
}

/** Push a new span back into the row that states it, then re-solve. */
function writeSpan(s) {
  const hit = scanSpan();
  if (!hit) return;
  const raw = rowSource(hit.row);
  const hash = raw.indexOf('#');
  const note = hash >= 0 ? '  ' + raw.slice(hash) : '';
  try {
    hit.row.field.source = spanRow(s.min, s.max) + note;
  } catch (err) {
    console.error('[numpla] MathField.source= threw', err);
    return;
  }
  state.t0 = s.min;
  state.t1 = s.max;
  setTime(state.t);              // the readout must not lag the new span
  scheduleRecompute(220);
}

function writeParam(s) {
  const hit = scanAssignments().get(s.name);
  if (!hit) return;
  // Rewrite the number, not the row: a note the author left at the end of the
  // line is theirs, and dragging a slider must not eat it.
  const raw = rowSource(hit.row);
  const hash = raw.indexOf('#');
  const note = hash >= 0 ? '  ' + raw.slice(hash) : '';
  const text = s.name + ' = ' + numText(s.value, s.step) + note;
  try {
    hit.row.field.source = text;
  } catch (err) {
    console.error('[numpla] MathField.source= threw', err);
    return;
  }
  scheduleRecompute(70);
}

/**
 * Where a slider's range comes from, most specific first: the range the user
 * set by hand, then the range the demo's author declared, then a guess made
 * around the value that is written in the document.
 */
function initialRangeFor(name, v) {
  const saved = knobRanges.get(name);
  if (saved && isFinite(saved.min) && isFinite(saved.max) && saved.max > saved.min) {
    return { min: saved.min, max: saved.max, step: saved.step, value: v };
  }
  const knob = pendingKnobs.get(name);
  if (knob && isFinite(knob.min) && isFinite(knob.max) && knob.max > knob.min) {
    return {
      min: knob.min,
      max: knob.max,
      step: knob.step > 0 ? knob.step : niceStepFor(knob.max - knob.min),
      value: v,
    };
  }
  const r = defaultRange(v);
  return { min: r.min, max: r.max, step: niceStepFor(r.max - r.min), value: v };
}

function promoteParam(name) {
  if (!name || promoted.has(name)) return;
  promoted.add(name);
  syncKnobs(state.params);
  const s = sliders.get(name);
  if (s && s.range) s.range.focus();   // the click's target is gone; land on the track
}

function demoteParam(name) {
  if (!name || !promoted.has(name)) return;
  const s = sliders.get(name);
  if (s && openSlider === s) closeSettings();
  promoted.delete(name);
  syncKnobs(state.params);
  const row = rows.find((r) => r.offerName === name);
  if (row && !row.offerEl.hidden) row.offerEl.focus();
}

/**
 * Reconcile every row's knob area with the document.
 *
 * A row earns a knob when it is a plain numeric assignment to a name the
 * compiler reports as a parameter - those are the only ones a slider can
 * actually drive. Promoted names get the slider; everything else gets the
 * offer. A row whose knob is already correct is not touched at all: moving a
 * node someone is dragging is exactly the jitter this shell exists to avoid.
 */
function syncKnobs(params) {
  const drivable = new Set();
  for (const name of params) {
    if (name === 't') continue;       // its row is a span, not a plain number
    if (state.names.indexOf(name) >= 0) continue;   // it is a state, not a knob
    drivable.add(name);
  }

  const wanted = new Map();     // row -> { name, value, kind, min?, max? }
  const seen = new Set();
  for (const row of realRows()) {
    const m = ASSIGN_RE.exec(rowSource(row).split('#')[0]);
    if (!m) continue;
    const name = m[1];
    if (!drivable.has(name) || seen.has(name)) continue;
    seen.add(name);
    wanted.set(row, { name, value: Number(m[2]), kind: 'param' });
  }

  // `t` earns its knob the same way every other variable does - by having a
  // row that says numbers a slider could drive. Its row says two, which is the
  // span; the slider inside that span is the playhead.
  const span = scanSpan();
  if (span && !wanted.has(span.row)) {
    seen.add('t');
    wanted.set(span.row, {
      name: 't', kind: 'time', value: state.t, min: span.t0, max: span.t1,
    });
  }

  const keyFor = (w) => (w ? (promoted.has(w.name) ? 'slider:' : 'offer:') + w.name : '');

  // 1. clear the rows whose knob is no longer what it should be
  for (const row of rows) {
    if (row.knobKey === keyFor(wanted.get(row))) continue;
    row.knobEl.textContent = '';
    row.offerEl.hidden = true;
    row.offerEl.removeAttribute('title');
    row.offerName = '';
    row.knobKey = '';
  }

  // 2. mount what each row should have
  for (const [row, w] of wanted) {
    const key = keyFor(w);
    if (row.knobKey === key) continue;
    if (promoted.has(w.name)) {
      const s = sliders.get(w.name) || (w.kind === 'time'
        ? makeSlider('t', {
            min: w.min, max: w.max,
            step: niceStepFor(w.max - w.min),
            value: clamp(state.t, w.min, w.max),
          }, 'time')
        : makeSlider(w.name, initialRangeFor(w.name, w.value), 'param'));
      if (s.el.parentNode !== row.knobEl) row.knobEl.appendChild(s.el);
    } else {
      row.offerName = w.name;
      row.offerEl.hidden = false;
      row.offerEl.title = 'Add a slider for ' + w.name;
      row.offerEl.setAttribute('aria-label', 'Add a slider for ' + w.name);
    }
    row.knobKey = key;
  }

  // 3. drop the sliders whose variable left the document - `t` included, since
  //    deleting its row is a perfectly good way to say you are done scrubbing
  for (const [name, s] of Array.from(sliders)) {
    if (seen.has(name)) continue;
    if (openSlider === s) closeSettings();
    s.el.remove();
    sliders.delete(name);
  }

  // 4. keep the document's value and the slider's value in step
  for (const w of wanted.values()) {
    const s = sliders.get(w.name);
    if (!s) continue;
    if (w.kind === 'time') {
      // The row is the authority on the range; the playhead is the value.
      if (s.min !== w.min || s.max !== w.max) {
        s.min = w.min;
        s.max = w.max;
        s.step = niceStepFor(w.max - w.min);
        applyRange(s);
      }
      if (!s.dragging) setSliderValue(s, clamp(state.t, w.min, w.max));
    } else if (s.kind === 'param' && !s.dragging) {
      setSliderValue(s, w.value);
    }
  }
}

// ---------------------------------------------------------------------------
// The playhead
//
// `t` has no widget of its own any more. It moves from three places - its
// slider on its own row, play/pause on the plot, and the space bar - and what
// it does is move a marker along the curve.
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

  // 0. tell every row which names are functions; a row that had to be re-read
  //    may say something slightly different now, so take the document again.
  let src = docSource();
  if (refreshFunctions(src)) src = docSource();

  // 1. set_source - cheap, runs on every edit, never throws.
  const diag = parseJson(M.setSource(src), 'Diagnostics')
    || { states: [], params: [], issues: [] };
  const issues = Array.isArray(diag.issues) ? diag.issues : [];
  const names = Array.isArray(diag.states) ? diag.states : [];
  const params = Array.isArray(diag.params) ? diag.params : [];

  applyDiagnostics(issues);

  state.names = names;
  state.params = params;
  refreshDocumentNames();   // Tab now completes the document's own vocabulary

  const hasError = issues.some((i) => i.severity === 'error');
  if (hasError) {
    // Keep the last good curve - AND the last good chips, legend and sliders -
    // on screen. The document is mid-edit, not dead, and nothing should move.
    setSolveBadge('paused on error', 'bad');
    return;
  }

  // The document says how far time runs. A `t = [0, 20]` row is the authority
  // whenever there is one; delete it and the last span simply stands, which is
  // the same courtesy every other deleted row gets.
  const span = scanSpan();
  if (span) {
    state.t0 = span.t0;
    state.t1 = span.t1;
    state.t = clamp(state.t, span.t0, span.t1);
  }

  // `pending` is not an error, so the chips still track the document live:
  // `phase` lights up the moment a system gains its second state.
  updateCapabilities(names);
  syncKnobs(params);

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

  // 2. solve, with whichever integrator the reference has selected
  const report = parseJson(solveNow(t0, t1), 'SolveReport');
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
  // The report echoes the method it actually used, so the badge can never name
  // one that did not run.
  setSolveBadge(report.method ? 'solved · ' + report.method : 'solved', 'ok');

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

  if (!got) {
    state.frame = null;
    scheduleDraw();
    return;
  }

  if (String(reportNames) !== String(names)) updateCapabilities(reportNames);

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

  // A re-solve draws inside the frame the user left. It is never moved here.
  syncFrameButtons();
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

// ===========================================================================
// The reference - what can I type here?
//
// Until now that question was answerable only by reading Rust. Everything
// below is taken from the source it documents:
//
//   builtins + arities   crates/numpla-expr/src/{lexer.rs,eval.rs}
//   noise                docs/noise.md, crates/numpla-noise/src/lib.rs
//   rows, calls, rand()  docs/wasm-api.md
//   integrators          docs/solvers.md, crates/numpla-ode/src/method.rs
//
// Every entry can be written into the document, because a reference you can
// only read leaves you to retype what it just told you.
// ===========================================================================

// -- the integrator ---------------------------------------------------------
//
// `Model.solve_with(t0, t1, name)` and the static `Model.methods()` are the
// boundary for this (crates/numpla-wasm/src/lib.rs). Both are probed rather
// than assumed, because `app/pkg/` is a build artefact that can be older than
// the crate: a shell that calls a method the loaded module does not have is a
// blank screen, and a shell that probes is a shell that keeps working while
// someone rebuilds. Without them the entries below still document the choice.
//
// The names come from the module when it can supply them, so a method added to
// numpla-ode reaches this list without an edit here.

const FALLBACK_METHODS = ['Tsit5', 'Verlet', 'Yoshida4'];
let methodApi = null;                 // { call(t0,t1,name), list } once present
let methodNames = FALLBACK_METHODS.slice();
let currentMethod = FALLBACK_METHODS[0];

function probeMethodApi(model, ctor) {
  const fn = typeof model.solve_with === 'function' ? 'solve_with'
           : typeof model.solveWith === 'function' ? 'solveWith'
           : null;
  if (!fn) return null;

  let list = null;
  try {
    const raw = ctor && typeof ctor.methods === 'function' ? ctor.methods() : null;
    const parsed = raw ? parseJson(raw, 'MethodsJson') : null;
    if (parsed && Array.isArray(parsed.methods) && parsed.methods.length) {
      list = parsed.methods.filter((m) => m && typeof m.name === 'string');
    }
  } catch (err) {
    console.warn('[numpla] Model.methods() failed', err);
  }

  if (list && list.length) {
    methodNames = list.map((m) => m.name);
    currentMethod = methodNames[0];
  }
  return { call: (t0, t1, name) => model[fn](t0, t1, name), list };
}

/** Integrate with whatever the reference has selected, or plainly. */
function solveNow(t0, t1) {
  if (methodApi) {
    try {
      return methodApi.call(t0, t1, currentMethod);
    } catch (err) {
      console.error('[numpla] solve_with threw', err);
    }
  }
  return M.solve(t0, t1);
}

function chooseMethod(name) {
  if (!methodApi || methodNames.indexOf(name) < 0) return false;
  currentMethod = name;
  renderReference();
  scheduleRecompute(0);
  return true;
}

const REFERENCE = [
  {
    group: 'Row kinds',
    note: 'One row per line. Each of these writes a new row into the document.',
    rows: true,
    entries: [
      { sig: "x' = -y", desc: 'An ODE row. `x` becomes a state variable, and `t` is bound to the current time on the right-hand side.', keys: 'ode derivative state' },
      { sig: "x'' = -x", desc: 'Second order. Lowered to two states automatically; the hidden velocity state sits immediately after its position.', keys: 'second order acceleration' },
      { sig: "x'(0) = 0", desc: 'The starting velocity of a second-order row.', keys: 'initial velocity' },
      { sig: 'x(0) = 1', desc: 'An initial condition. Leave it out and it is 0 — reported, not assumed in silence.', keys: 'initial condition start' },
      { sig: 'k = 0.4', desc: 'A parameter, visible to every row. A plain numeric one can be given a slider on its own row.', keys: 'parameter constant knob' },
      { sig: 't = [0, 20]', desc: 'How far time runs. `t` is a variable in the system like any other — this row says its span, and the slider you can put on it is the playhead inside that span. The solver rebinds `t` while it integrates, so the row cannot change what the equations mean.', keys: 'time span playhead integration range scrub transport' },
      { sig: 'f(u) = u^2', desc: 'A function definition — and what makes `f(u)` a call rather than a coefficient anywhere else in the document.', keys: 'function definition' },
      { sig: '# a note', desc: 'A comment row: prose for the reader, skipped by the parser, never numbered and never diagnosed.', keys: 'comment prose' },
    ],
  },
  {
    group: 'Functions',
    note: 'Every builtin, with its exact arity. Parentheses are optional for the one-argument ones: `sin x` is `sin(x)`, and it binds tighter than × .',
    entries: [
      { sig: 'sin(x)', desc: 'Sine. Radians, like every trigonometric function here.', insert: 'sin(' , keys: 'trig' },
      { sig: 'cos(x)', desc: 'Cosine, radians.', insert: 'cos(', keys: 'trig' },
      { sig: 'tan(x)', desc: 'Tangent, radians.', insert: 'tan(', keys: 'trig' },
      { sig: 'arcsin(x)', desc: 'Inverse sine, radians.', insert: 'arcsin(', keys: 'trig inverse asin' },
      { sig: 'arccos(x)', desc: 'Inverse cosine, radians.', insert: 'arccos(', keys: 'trig inverse acos' },
      { sig: 'arctan(x)', desc: 'Inverse tangent, radians. One argument only — there is no two-argument atan2.', insert: 'arctan(', keys: 'trig inverse atan atan2' },
      { sig: 'sinh(x)', desc: 'Hyperbolic sine.', insert: 'sinh(', keys: 'hyperbolic' },
      { sig: 'cosh(x)', desc: 'Hyperbolic cosine.', insert: 'cosh(', keys: 'hyperbolic' },
      { sig: 'tanh(x)', desc: 'Hyperbolic tangent. The usual soft saturation.', insert: 'tanh(', keys: 'hyperbolic saturate limit' },
      { sig: 'sqrt(x)', desc: 'Square root.', insert: 'sqrt(', keys: 'root radical' },
      { sig: 'exp(x)', desc: 'e to the power x.', insert: 'exp(', keys: 'exponential' },
      { sig: 'ln(x)', desc: 'Natural logarithm, base e.', insert: 'ln(', keys: 'logarithm' },
      { sig: 'log(x)', desc: 'Logarithm base 10.', insert: 'log(', keys: 'logarithm base ten' },
      { sig: 'log(b, x)', desc: 'Logarithm of x in base b — the base comes FIRST: log(2, 8) is 3.', insert: 'log(2, ', keys: 'logarithm base two arity' },
      { sig: 'abs(x)', desc: 'Absolute value.', insert: 'abs(', keys: 'magnitude modulus' },
      { sig: 'floor(x)', desc: 'Round down to an integer.', insert: 'floor(', keys: 'integer' },
      { sig: 'ceil(x)', desc: 'Round up to an integer.', insert: 'ceil(', keys: 'integer' },
      { sig: 'round(x)', desc: 'Round to the nearest integer, halves away from zero: round(2.5) is 3, round(−2.5) is −3.', insert: 'round(', keys: 'integer nearest' },
      { sig: 'sign(x)', desc: '−1, 0 or 1. sign(0) is 0, not ±1 — which is what makes it usable in a friction term.', insert: 'sign(', keys: 'signum friction' },
      { sig: 'min(a, b)', desc: 'The smaller of two. Exactly two arguments.', insert: 'min(', keys: 'clamp' },
      { sig: 'max(a, b)', desc: 'The larger of two. `max(0, overlap)` is how a one-sided contact force is written while there is no event detection.', insert: 'max(0, ', keys: 'clamp contact collision penalty' },
      { sig: 'mod(a, b)', desc: 'Euclidean remainder — never negative for a positive b: mod(−1, 3) is 2. A function, not an operator.', insert: 'mod(', keys: 'remainder modulo wrap' },
    ],
  },
  {
    group: 'Constants',
    entries: [
      { sig: 'pi', desc: '3.14159…', insert: 'pi', keys: 'circle' },
      { sig: 'tau', desc: '2π — one whole turn.', insert: 'tau', keys: 'circle turn' },
      { sig: 'e', desc: "Euler's number, 2.71828…", insert: 'e', keys: 'euler exponential' },
      { sig: 'inf', desc: 'Positive infinity.', insert: 'inf', keys: 'infinity' },
    ],
  },
  {
    group: 'Noise',
    note: 'Noise is a deterministic function of time: same t, same seed, same value, always — randomness enters through the seed, not through the call, which is what lets an adaptive solver step a noisy model at all. Each takes n(t), n(t, rate) or n(t, rate, seed): rate is lattice points per unit time (default 1, and doubling it doubles both the roughness and the work), seed names an independent stream (default 0). All six are zero-mean and unit-RMS, so swapping one for another does not rescale the forcing.',
    entries: [
      { sig: 'white(t, rate, seed)', desc: 'Flat spectrum: harsh, every frequency equally. Forcing and dither.', insert: 'white(t)', keys: 'noise random stochastic' },
      { sig: 'pink(t, rate, seed)', desc: '1/f: natural and balanced — what most physical noise looks like.', insert: 'pink(t)', keys: 'noise random flicker' },
      { sig: 'brown(t, rate, seed)', desc: '1/f²: drifting, wandering. Slow drift, not a Wiener process.', insert: 'brown(t)', keys: 'noise random drift brownian' },
      { sig: 'blue(t, rate, seed)', desc: 'f: thin and hissy, the complement of pink.', insert: 'blue(t)', keys: 'noise random' },
      { sig: 'smooth(t, rate, seed)', desc: 'One band-limited lattice, C² everywhere. The safest thing to drive a physical model with.', insert: 'smooth(t)', keys: 'noise random perlin gentle' },
      { sig: 'telegraph(t, rate, seed)', desc: 'Switches between ±1, with the edges ramped so it stays integrable.', insert: 'telegraph(t)', keys: 'noise random switch square binary' },
      { sig: 'rand()', desc: 'A number, not a draw: uniform on [0, 1), fixed when the document is compiled, so the same document reopened gives the same number. Each call site has its own stream — two rand()s are two different numbers, and a site keeps its stream when unrelated rows are edited.', insert: 'rand()', keys: 'random uniform reproducible' },
      { sig: 'randn()', desc: 'The same, drawn from a standard normal instead of a uniform.', insert: 'randn()', keys: 'random gaussian normal' },
      { sig: 'rand(s)', desc: 'Names a stream explicitly, and is left exactly as written — the same s is the same number everywhere.', insert: 'rand(', keys: 'random seed stream' },
    ],
  },
  {
    group: 'Notation',
    note: 'A name is ONE letter plus an optional subscript, the Desmos convention — so `xy` is x times y, never a variable called xy.',
    entries: [
      { sig: '2(x + 1)', desc: 'Implicit multiplication: juxtaposition binds exactly as tightly as ×.', insert: '2(', keys: 'implicit multiplication juxtaposition' },
      { sig: 'k_1', desc: 'A subscript. `k_{max}` works too, and means the same as `k_max`.', insert: 'k_1', keys: 'subscript index' },
      { sig: "x'", desc: "A prime: the derivative of x. On a right-hand side it is the velocity state a second-order row introduced.", insert: "x'", keys: 'prime derivative velocity' },
      { sig: 'x^2', desc: 'Powers, right-associative: 2^3^2 is 512. Unary minus binds looser, so −2^2 is −4.', insert: 'x^2', keys: 'power exponent caret' },
      { sig: 'f(u) versus g (u)', desc: '`f(u)` is a call only when the document has an `f(u) = …` row; every other name followed by ( is a coefficient. So `f(y − x)^3` cubes the result of a call while `g (y − x)^3` cubes the difference and then scales it — the same tokens, two different systems.', insert: 'f(u) = u^2', asRow: true, keys: 'call coefficient ambiguity parser' },
      { sig: 't', desc: 'Bound to the current time inside any right-hand side. Its span is a row of its own — see `t = [0, 20]`.', insert: 't', keys: 'time' },
      { sig: '[a, b, c]', desc: 'A list. Arithmetic broadcasts a scalar across a list and zips two lists of equal length; the builtin functions take scalars only.', insert: '[', keys: 'list vector array' },
      { sig: '+ − * / ^', desc: 'The whole operator set. No comparisons, no factorial, no % — `mod` is a function, and `=` splits a row into a statement rather than comparing.', keys: 'operators precedence comparison factorial' },
    ],
  },
  {
    group: 'The integrator',
    note: 'Accuracy or structure — no fixed-step method preserves the symplectic form, momentum and energy at once, and that is a theorem rather than a gap (docs/solvers.md). This is the discrete-versus-continuous switch. The symplectic two need second-order rows to work on: they integrate positions and velocities separately, so a document of plain x’ = rows is refused by name rather than quietly solved with something else.',
    methods: true,
    entries: [
      { sig: 'Tsit5 — adaptive, order 5', method: 'Tsit5', desc: 'Tsitouras 5(4). Chooses its own step from a local error estimate, so a narrow feature costs steps only where it is: the most accuracy per unit work over a short run. It preserves nothing — over a long one the energy drifts away.', keys: 'runge kutta adaptive accurate dense output' },
      { sig: 'Verlet — fixed step, order 2', method: 'Verlet', desc: 'Velocity Verlet: symplectic, so the energy oscillates in a bounded band instead of drifting, however long the run. The cheapest step there is, but it is a fixed one — you pay for the narrowest feature everywhere. Needs x’’ rows.', keys: 'symplectic leapfrog energy conserving structure second order' },
      { sig: 'Yoshida4 — fixed step, order 4', method: 'Yoshida4', desc: "Yoshida's composition of three Verlet substeps: fourth-order accuracy with the same bounded energy. What a long run should be integrated with when second order is too coarse. Needs x’’ rows.", keys: 'symplectic composition energy conserving structure second order' },
    ],
  },
  {
    group: 'Features',
    entries: [
      { sig: 't is a variable, not a widget', desc: 'The row `t = [0, 20]` says the span; the slider you promote on that row is the playhead. Dragging it moves a marker along the curve and redraws the trajectory travelled-versus-ahead — it does not re-solve, because the solution does not depend on where you are looking. Widening the span in the gear rewrites the row, and that does.', keys: 'time transport play scrub span playhead slider' },
      { sig: 'add slider', desc: 'Every plain `k = number` row offers one, in the line it already reserves for its diagnostic. It sits on the row that defines the number, and dragging it rewrites that row.', keys: 'slider knob parameter drag' },
      { sig: 'three views, any number on', desc: 't–y, phase and polar are independent switches; the canvas is tiled between whichever are on. A view the document cannot support stays visible but inert — that is how you find out it exists.', keys: 'view phase polar toggle tile' },
      { sig: 'the frame is yours', desc: '−5 to 5 on both axes to begin with, so two runs are comparable. Drag an axis to scale it, drag the body to pan, wheel to zoom about the cursor, double-click a tile to put it back. A re-solve never moves it.', keys: 'axes zoom pan scale window frame reset' },
      { sig: 'gray, not red', desc: 'An incomplete document is muted, never an error, and only a real error pauses the solve — the last good curve stays on screen while you type.', keys: 'pending error diagnostic' },
      { sig: 'the issue bar', desc: 'What the document still needs, as a sentence, with the row the compiler would have written one click away.', keys: 'fix missing initial condition' },
    ],
  },
];

/** Everything flattened once, with the text the search matches against. */
const REF_ENTRIES = [];
for (const g of REFERENCE) {
  for (const e of g.entries) {
    REF_ENTRIES.push({
      ...e,
      group: g.group,
      asRow: e.asRow || !!g.rows,
      insert: e.insert != null ? e.insert : (g.rows ? e.sig : ''),
      hay: [g.group, e.sig, e.desc, e.keys || ''].join(' ').toLowerCase(),
    });
  }
}

let refSelection = -1;      // index into the entries currently rendered
let refRendered = [];       // { entry, el } in display order

function refFoot(msg) {
  el.infoFoot.textContent = msg;
}

/** Write an entry into the document. Rows become rows; the rest is typed. */
function insertEntry(entry) {
  if (!entry || !entry.insert) return;

  if (entry.asRow) {
    const row = makeRow(entry.insert, realRowCount());   // before the blank one
    ensureTail();
    renumber();
    scheduleRecompute(0);
    closeInfo();
    placeCaret(row, true);
    return;
  }

  let row = lastActiveRow && indexOfRow(lastActiveRow) >= 0 ? lastActiveRow : null;
  if (!row) {
    ensureTail();
    row = rows[rows.length - 1];
  }
  if (!row) return;

  try {
    const m = row.field.model;
    if (m && typeof m.type === 'function') {
      m.type(entry.insert);
      row.field.render();
    } else {
      row.field.source = rowSource(row) + entry.insert;
    }
  } catch (err) {
    console.error('[numpla] inserting from the reference threw', err);
    return;
  }

  ensureTail();
  renumber();
  scheduleRecompute(0);
  closeInfo();
  // Not placeCaret: the caret is already sitting after what was just typed,
  // which is where the next character belongs.
  try { row.field.focus(); } catch (err) { /* the row may be gone */ }
  setActiveRow(row);
}

function copyText(text) {
  const done = () => refFoot('copied  ' + text);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => refFoot('could not copy'));
      return;
    }
  } catch (err) { /* fall through to the textarea */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    done();
  } catch (err) {
    refFoot('could not copy');
  }
}

function refPrimary(entry) {
  if (entry.method) {
    if (chooseMethod(entry.method)) refFoot(entry.method + ' is now integrating');
    else refFoot('not switchable yet — ' + currentMethod + ' is what runs');
    return;
  }
  if (entry.insert) insertEntry(entry);
  else copyText(entry.sig);
}

function selectRef(i) {
  refSelection = i;
  refRendered.forEach((r, j) => {
    const on = j === i;
    r.el.classList.toggle('is-sel', on);
    if (on && typeof r.el.scrollIntoView === 'function') {
      r.el.scrollIntoView({ block: 'nearest' });
    }
  });
}

function renderReference() {
  const q = (el.infoSearch.value || '').trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const match = (e) => terms.every((t) => e.hay.indexOf(t) >= 0);

  el.infoList.textContent = '';
  refRendered = [];

  let shown = 0;
  for (const g of REFERENCE) {
    const hits = REF_ENTRIES.filter((e) => e.group === g.group && match(e));
    if (!hits.length) continue;

    const head = document.createElement('div');
    head.className = 'info__group';
    head.textContent = g.group;
    el.infoList.appendChild(head);

    // The note is the part of the group that is not any one entry. It shows
    // whole, so a search that hits a group still explains it.
    let note = g.note || '';
    if (g.methods) {
      note += methodApi
        ? ' Click one to switch; the live one is marked, and the report names the method that actually ran.'
        : ' The loaded app/pkg/ build has no solve_with, so these entries document the choice and copy their names — rebuild the WASM and they become buttons.';
    }
    if (note) {
      const p = document.createElement('p');
      p.className = 'info__note';
      p.textContent = note;
      el.infoList.appendChild(p);
    }

    for (const entry of hits) {
      const item = document.createElement('div');
      item.className = 'entry';
      item.setAttribute('role', 'listitem');
      if (entry.method && entry.method === currentMethod) item.classList.add('is-live');

      const sig = document.createElement('span');
      sig.className = 'entry__sig';
      sig.textContent = entry.method && entry.method === currentMethod
        ? entry.sig + '  ·  live'
        : entry.sig;

      const desc = document.createElement('span');
      desc.className = 'entry__desc';
      desc.textContent = entry.desc || '';

      item.append(sig, desc);

      if (entry.method) {
        if (methodApi) {
          const use = document.createElement('button');
          use.type = 'button';
          use.className = 'entry__act';
          use.textContent = entry.method === currentMethod ? 'in use' : 'use';
          use.title = 'Integrate with ' + entry.method;
          use.addEventListener('click', (ev) => { ev.stopPropagation(); refPrimary(entry); });
          item.appendChild(use);
        }
      } else if (entry.insert) {
        const ins = document.createElement('button');
        ins.type = 'button';
        ins.className = 'entry__act';
        ins.textContent = entry.asRow ? 'add row' : 'insert';
        ins.title = entry.asRow
          ? 'Write this row into the document'
          : 'Type this into the row you were last in';
        ins.addEventListener('click', (ev) => { ev.stopPropagation(); insertEntry(entry); });
        item.appendChild(ins);
      }

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'entry__act';
      copy.textContent = 'copy';
      copy.title = 'Copy to the clipboard';
      copy.addEventListener('click', (ev) => {
        ev.stopPropagation();
        copyText(entry.insert || entry.sig);
      });
      item.appendChild(copy);

      const index = refRendered.length;
      item.addEventListener('click', () => refPrimary(entry));
      item.addEventListener('pointerenter', () => selectRef(index));
      refRendered.push({ entry, el: item });
      el.infoList.appendChild(item);
      shown++;
    }
  }

  if (!shown) {
    const none = document.createElement('p');
    none.className = 'info__empty';
    none.textContent = 'nothing matches “' + q + '”';
    el.infoList.appendChild(none);
  }

  selectRef(shown ? 0 : -1);
  refFoot(shown
    ? shown + (shown === 1 ? ' entry' : ' entries') + '  ·  ↑ ↓ to move  ·  Enter inserts  ·  Esc closes'
    : 'no match  ·  Esc closes');
}

function positionInfo() {
  const r = el.infoBtn.getBoundingClientRect();
  const w = el.info.offsetWidth || 440;
  const left = clamp(r.right - w, 10, Math.max(10, window.innerWidth - w - 10));
  el.info.style.left = left + 'px';
  el.info.style.top = (r.bottom + 8) + 'px';
}

function openInfo() {
  if (!el.info.hidden) return;
  closeDemos();
  closeSettings();
  el.info.hidden = false;
  el.infoBtn.setAttribute('aria-expanded', 'true');
  renderReference();
  positionInfo();
  el.infoSearch.focus();
  if (typeof el.infoSearch.select === 'function') el.infoSearch.select();
}

function closeInfo() {
  if (el.info.hidden) return;
  el.info.hidden = true;
  el.infoBtn.setAttribute('aria-expanded', 'false');
}

function toggleInfo() {
  if (el.info.hidden) openInfo(); else { closeInfo(); el.infoBtn.focus(); }
}

function wireInfo() {
  el.infoBtn.addEventListener('click', toggleInfo);
  el.infoClose.addEventListener('click', () => { closeInfo(); el.infoBtn.focus(); });
  el.infoSearch.addEventListener('input', renderReference);

  el.infoSearch.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!refRendered.length) return;
      const next = refSelection + (e.key === 'ArrowDown' ? 1 : -1);
      selectRef((next + refRendered.length) % refRendered.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const hit = refRendered[refSelection];
      if (hit) refPrimary(hit.entry);
    }
  });
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

/**
 * Would this key belong to the thing that has focus? A field, an input - and a
 * button, because space is how a focused button is pressed and play/pause has
 * no business stealing it.
 */
function isTypingTarget(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = node.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return true;
  if (node.isContentEditable) return true;
  return typeof node.closest === 'function' && !!node.closest('.row__field, .settings');
}

function wire() {
  collectChips();
  applyViews();               // pushes the on-set at the plot for the first draw
  wireDivider();
  wireCanvasGestures();
  wireInfo();

  el.frameReset.addEventListener('click', resetFrames);
  el.frameFit.addEventListener('click', fitFrames);

  // Clicking the empty space below the list lands in the trailing blank row;
  // clicking a row's own margins lands at the end of that row. mousedown, not
  // click, so the caret arrives with the press like it does inside a field.
  el.rows.addEventListener('mousedown', (e) => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    if (t.closest('.row__field') || t.closest('.row__del') ||
        t.closest('.row__offer') || t.closest('.row__knob')) return;
    const rowEl = t.closest('.row');
    if (rowEl) {
      const row = rows.find((r) => r.el === rowEl);
      if (!row) return;
      e.preventDefault();
      placeCaret(row, true);
      return;
    }
    e.preventDefault();
    focusTail();
  });

  el.issueFix.addEventListener('click', (e) => {
    e.preventDefault();
    applyOfferedFixes();
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

  el.hearBtn.addEventListener('click', () => {
    if (el.hearPanel.hidden) openHear(); else closeHear();
  });
  el.hearClose.addEventListener('click', () => { closeHear(); el.hearBtn.focus(); });
  el.hearPlay.addEventListener('click', toggleHear);

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
    if (e.key === 'F1') {
      e.preventDefault();
      toggleInfo();
      return;
    }
    if (e.key === 'Escape' && !el.hearPanel.hidden) {
      e.preventDefault();
      closeHear();
      el.hearBtn.focus();
      return;
    }
    if (e.key === 'Escape' && !el.demomenu.hidden) {
      e.preventDefault();
      closeDemos();
      el.demosBtn.focus();
      return;
    }
    if (e.key === 'Escape' && !el.info.hidden) {
      e.preventDefault();
      closeInfo();
      el.infoBtn.focus();
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
    if (!el.info.hidden && dt && typeof dt.closest === 'function' &&
        !dt.closest('.info') && !dt.closest('#info-btn')) {
      closeInfo();
    }
    if (!openSlider) return;
    const t = e.target;
    if (t && typeof t.closest === 'function' &&
        (t.closest('.settings') || t.closest('.knob.is-open'))) return;
    closeSettings();
  }, true);

  // HiDPI-correct redraw whenever the plot box changes size
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => scheduleDraw());
    document.querySelectorAll('.plot__canvas').forEach((n) => ro.observe(n));
  }

  window.addEventListener('resize', () => {
    closeSettings();
    if (!el.info.hidden) positionInfo();
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
    funcNames = typeof mf.functionNamesIn === 'function'
      ? mf.functionNamesIn
      : () => [];
  } catch (err) {
    fail('Could not load ./mathfield.js.', err);
    return;
  }

  // `t` arrives with its slider already on, the way a demo's knobs do: the
  // playhead is what the plot is for. It is an ordinary promotion, so the x on
  // it puts `t` back to an offer like any other variable.
  promoted.add('t');

  try {
    buildDemoMenu();
    buildRows(DEFAULT_DOC);
  } catch (err) {
    fail('The math field would not mount.', err);
    return;
  }

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
    ModelCtor = mod.Model;      // demo previews each solve in their own Model
    const model = new mod.Model();
    M = {
      setSource: bindMethod(model, 'set_source'),
      solve:     bindMethod(model, 'solve'),
      sample:    bindMethod(model, 'sample'),
      eval:      bindMethod(model, 'eval'),
    };
    // Probed, never assumed: app/pkg/ can be older than the crate.
    methodApi = probeMethodApi(model, mod.Model);
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
