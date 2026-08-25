// ============================================================================
// main.js - the Numpla browser shell.
//
// Flow:
//   boot()   ->  load MathField + WASM  ->  reveal the app (eased)
//   edit     ->  debounce  ->  set_source  ->  per-row diagnostics  ->  solve
//   pan/zoom ->  debounce  ->  solve over the NEW window  ->  re-sample
//   sliders  ->  a parameter slider rewrites its own row and re-solves
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
// THERE IS NO `t` ANY MORE - not a slider, not a row, not a playhead. It was a
// dial attached to nothing twice over, because it answered a question nobody
// asks: nobody wants to SET a span, they want to LOOK somewhere and have the
// software compute what they are looking at. So (docs/ui-v5.md):
//
//   THE VISIBLE WINDOW IS THE INTEGRATION SPAN.
//
// The frame's x0..x1 is what gets solved, at the resolution the canvas can
// draw. Pan or zoom the horizontal axis and the model re-solves over the new
// span, debounced exactly the way editing is, with the last good curve left on
// screen in the meantime.
//
// Five structural rules this file exists to enforce:
//
//   1. GRAY-NOT-RED. `severity: "pending"` is muted. Only `"error"` is red,
//      and only an `"error"` pauses the solve - the last good curve stays on
//      screen while the document is mid-edit.
//   2. ONE PLOT, EVERYTHING IN IT. A single canvas and a single frame; every
//      enabled view draws into it, overlapping. Nothing is tiled. A view the
//      model supports turns itself ON; the views menu is how you turn one off.
//   3. THE FRAME IS THE USER'S - AND IT IS THE QUERY. -5..5 on both axes to
//      begin with, then theirs: drag an axis to scale it, drag the body to pan,
//      wheel to zoom. A re-solve never moves it; moving it causes a re-solve.
//   4. THE METHOD IS ON THE SURFACE. Discrete versus continuous - Tsit5 against
//      Verlet and Yoshida4 - is one click on the plot's strip, and a symplectic
//      method asked of a document with no second-order structure is REFUSED in
//      a sentence, never quietly downgraded to something that draws.
//   5. NOTHING MOVES WHILE YOU TYPE. Panes have explicit sizes and scroll
//      internally; diagnostics occupy reserved space; the slider settings, the
//      demo gallery, the views menu and the reference are overlays. The only
//      thing that may change size is the field under the caret.
//
// No bundler, no dependencies, no network. Plain ES modules.
// ============================================================================

import {
  Plot, VIEWS, VIEW_LABEL, panned, scaled, zoomed, seriesColor, fmtValue,
} from './plot.js';
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

  methods:   $('methods'),
  viewsBtn:  $('views-btn'),
  viewmenu:  $('viewmenu'),
  canvas:     $('canvas'),
  frameFit:   $('frame-fit'),
  frameReset: $('frame-reset'),

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
  derived: [],     // rows that are functions of the solution (energy, ...)
  sol: null,       // last GOOD solution; an error never clears this
  // The span that was last actually integrated. It exists so a pan that ends
  // where it began does not re-solve, and so the shell can say what is drawn.
  t0: -5,
  t1: 5,
  // What the loaded document says is worth drawing (`show`), or null for
  // everything. A display choice: the states left out are still solved.
  show: null,
};

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
 *          offerEl:HTMLButtonElement, fixEl:HTMLButtonElement, fixInsert:string,
 *          offerName:string, knobKey:string, field:any}[]} */
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

  // The suggestion, in the row's own reserved line - which is to say, WHERE THE
  // PROBLEM IS. The bottom of the pane is not where your eye is when a row is
  // half-written; this row is. It is deliberately not clever: the compiler
  // proposes exactly one obvious row per issue, and this presses that row into
  // the document. Nothing is invented, ranked or inferred here.
  const fixEl = document.createElement('button');
  fixEl.type = 'button';
  fixEl.className = 'row__fix';
  fixEl.hidden = true;

  const offerEl = document.createElement('button');
  offerEl.type = 'button';
  offerEl.className = 'row__offer';
  offerEl.textContent = 'add slider';
  offerEl.hidden = true;

  footEl.append(msgEl, fixEl, offerEl);

  // Where a promoted slider lives. Empty (and therefore invisible) otherwise.
  const knobEl = document.createElement('div');
  knobEl.className = 'row__knob';

  wrap.append(idxEl, host, del, footEl, knobEl);

  const row = {
    el: wrap, host, idxEl, msgEl, footEl, knobEl, offerEl, fixEl,
    fixInsert: '', offerName: '', knobKey: '', field: null,
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

  fixEl.addEventListener('click', (e) => {
    e.preventDefault();
    applyFix(row.fixInsert);
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
  closeViews();

  // A demo's author has already answered the question the offer asks, so its
  // knobs arrive promoted, with the ranges over which they are interesting.
  pendingKnobs.clear();
  promoted.clear();
  knobRanges.clear();
  for (const k of demo.knobs || []) {
    pendingKnobs.set(k.name, k);
    promoted.add(k.name);
  }

  // Drop every slider so they are rebuilt against the demo's ranges.
  for (const [name, s] of Array.from(sliders)) {
    s.el.remove();
    sliders.delete(name);
  }

  // A demo still declares a `tSpan`, and it sets the FRAME - not the other way
  // round. There is no row and no widget left to write it into: the window IS
  // the span, so moving the window there is the whole of "load this demo over
  // the interval its author had in mind".
  const span = Array.isArray(demo.tSpan) && demo.tSpan.length === 2
    ? demo.tSpan
    : [0, 20];
  const t0 = Number(span[0]);
  const t1 = Number(span[1]);
  if (isFinite(t0) && isFinite(t1) && t1 > t0) {
    const win = plot.getWindow();
    plot.setWindow({ x0: t0, x1: t1, y0: win.y0, y1: win.y1 });
  }

  // `show` names the series that ARE the picture - one line per string rather
  // than one per state. Everything is still solved; this only says what to draw.
  state.show = Array.isArray(demo.show) && demo.show.length ? demo.show.slice() : null;

  clearRows();
  buildRows(demo.source.split('\n'));

  el.demosBtn.setAttribute('data-demo', demo.title);
  syncFrameButtons();
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

/** The from/to the panel last filled in by itself, so a typed one is never
 *  overwritten while a stale one always is. */
const hearOffered = { from: '', to: '' };

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

  // The window is the span, so the span is what there is to listen to. A value
  // typed by hand is kept; anything the panel put there itself is refreshed,
  // because a window offered two zooms ago is not the run on screen.
  if (!el.hearFrom.value || el.hearFrom.value === hearOffered.from) {
    el.hearFrom.value = String(state.t0);
    hearOffered.from = el.hearFrom.value;
  }
  if (!el.hearTo.value || el.hearTo.value === hearOffered.to) {
    el.hearTo.value = String(state.t1);
    hearOffered.to = el.hearTo.value;
  }
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
    const msg = String((err && err.message) || err);
    note(msg);
    // An absent AudioContext is an environment fact, not a fault; saying so in
    // the panel is the whole handling. Anything else is worth a console entry.
    if (!/not available/i.test(msg)) console.error('[numpla] hear failed', err);
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

function setRowDiagnostic(row, severity, message, fix) {
  const sev = severity === 'error' ? 'error' : severity === 'pending' ? 'pending' : null;
  row.el.classList.toggle('is-error', sev === 'error');
  row.el.classList.toggle('is-pending', sev === 'pending');
  row.msgEl.textContent = sev ? (message || (sev === 'error' ? 'error' : 'incomplete')) : '';
  row.msgEl.title = row.msgEl.textContent;

  // The proposal, rendered verbatim. An issue with no `fix` gets the message
  // and no button, because there is nothing to press and inventing one would be
  // exactly the cleverness this must not have.
  const insert = fix && typeof fix.insert === 'string' ? fix.insert : '';
  row.fixInsert = insert;
  row.fixEl.hidden = !insert;
  row.fixEl.textContent = insert ? (fix.label || 'add ' + insert) : '';
  if (insert) {
    row.fixEl.title = 'Write `' + insert + '` into the document';
    row.fixEl.setAttribute('aria-label', 'Add the row ' + insert);
  } else {
    row.fixEl.removeAttribute('title');
    row.fixEl.removeAttribute('aria-label');
  }

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

  // What is actually on offer, in the order the compiler reported it. Each
  // distinct proposal is offered ONCE, on the earliest row that wants it - the
  // contract already guarantees that, so three rows waiting on the same name
  // produce one suggestion, in one place.
  const fixes = collectFixes(issues);
  const byLine = new Map();
  for (const f of fixes) {
    if (f.line >= 0 && !byLine.has(f.line)) byLine.set(f.line, f);
  }

  const real = realRowCount();
  rows.forEach((row, i) => {
    // The trailing blank row is not part of the document and a comment row is
    // prose for the reader: neither is ever diagnosed.
    const diagnosable = i < real && !isCommentRow(row);
    const d = diagnosable ? worst.get(i) : null;
    const f = diagnosable ? byLine.get(i) : null;
    if (f) f.attached = true;      // it has a row of its own to be pressed on
    setRowDiagnostic(row, d ? d.sev : null, d ? d.msg : '', f);
  });

  renderIssueBar(issues, fixes);
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

/**
 * The thing a proposed row would define: `k = 1` -> `k`, `y(0) = 0` -> `y(0)`,
 * `x'(0) = 0` -> `x'(0)`. This is the word the document is waiting for, and
 * "what is it waiting for" is the only question being asked at that moment - so
 * it has to be on screen by NAME, not counted.
 */
function fixTarget(insert) {
  const m = /^\s*([A-Za-z_][A-Za-z_0-9]*'*)\s*(\(\s*0\s*\))?/.exec(insert);
  if (!m) return insert;
  return m[1] + (m[2] ? '(0)' : '');
}

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
  return { insert, label, message, target: fixTarget(insert) };
}

/** The fixes currently on offer, in the order they were reported. */
let offeredFixes = [];

/**
 * Every proposal the compiler is making that is not already written down, once
 * each, carrying the line it belongs to.
 *
 * A genuine error outranks a missing default: there is no point offering to
 * complete a document that cannot be read yet.
 */
function collectFixes(issues) {
  if (issues.some((i) => i.severity === 'error')) return [];
  // Something already written down is not missing, whatever the compiler said
  // a moment ago.
  const have = new Set(realRows().map((r) => squash(rowSource(r))));
  const seen = new Set();
  const out = [];
  for (const it of issues) {
    const f = usableFix(it);
    if (!f) continue;
    const key = squash(f.insert);
    if (seen.has(key) || have.has(key)) continue;
    seen.add(key);
    out.push({ ...f, line: Number.isInteger(it.line) ? it.line : -1, attached: false });
  }
  return out;
}

/** Write one proposed row into the document, at the end, and recompute. */
function applyFix(insert) {
  const text = typeof insert === 'string' ? insert.trim() : '';
  if (!text) return null;
  const have = new Set(realRows().map((r) => squash(rowSource(r))));
  if (have.has(squash(text))) return null;

  const row = makeRow(text, realRowCount());   // before the trailing blank row
  ensureTail();
  renumber();
  scheduleRecompute(0);
  // The button that had focus has just gone away; put the caret where the new
  // text is instead of dropping focus on the floor.
  placeCaret(row, true);
  return row;
}

function renderIssueBar(issues, fixes) {
  const errs = issues.filter((i) => i.severity === 'error').length;
  const pend = issues.length - errs;

  offeredFixes = fixes || [];

  // The message: NAME what is missing. "1 issue · and 2 more" answers a
  // question nobody asked; the one being asked is "what is it waiting for", and
  // every fix already knows. The first keeps its full sentence, the rest are
  // listed by name, and the hover text has all of them in full.
  if (offeredFixes.length) {
    const more = offeredFixes.length - 1;
    el.issueMsg.textContent = more
      ? offeredFixes[0].message + ' · also ' +
        offeredFixes.slice(1).map((f) => f.target).join(', ')
      : offeredFixes[0].message;
    el.issueMsg.title = offeredFixes.map((f) => f.message).join('   ·   ');
  } else {
    const bits = [];
    if (errs) bits.push(errs + (errs === 1 ? ' error' : ' errors'));
    if (pend) bits.push(pend + ' pending');
    el.issueMsg.textContent = bits.length ? bits.join(' · ') : 'clean';
    el.issueMsg.title = el.issueMsg.textContent;
  }

  // The button: the bar is the SUMMARY now. The primary place to press is the
  // row itself, where the problem is, so the bar adds a button only when it can
  // do something the rows cannot - all of them at once, or one that has no row
  // of its own to sit on (a proposal whose line is not a row you can see).
  //
  // Several share one button because they are all the same kind of answer -
  // "this is what it would otherwise have assumed" - and clicking through them
  // one re-solve at a time is exactly the asking-for-things this is meant to
  // remove. Every row still carries its own message, so batching hides nothing.
  const orphans = offeredFixes.filter((f) => !f.attached);
  const barFixes = offeredFixes.length > 1 ? offeredFixes : orphans;

  if (barFixes.length) {
    el.issueFix.textContent = barFixes.length > 1
      ? 'add all ' + barFixes.length + ' defaults'
      : barFixes[0].label;
    el.issueFix.title = barFixes.map((f) => f.insert).join('   ·   ');
    el.issueFix.hidden = false;
    el.issuebar.classList.add('has-fix');
  } else {
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
  // The same set the button is offering: everything when there are several,
  // and otherwise only the one with no row of its own to be pressed on.
  const orphans = offeredFixes.filter((f) => !f.attached);
  const wanted = offeredFixes.length > 1 ? offeredFixes : orphans;
  if (!wanted.length) return;

  const have = new Set(realRows().map((r) => squash(rowSource(r))));
  let last = null;
  for (const f of wanted) {
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
  el.statSolve.classList.toggle('is-wait', kind === 'wait');
}

/**
 * GRAY-NOT-RED, APPLIED TO THE SOLVE.
 *
 * `solve` refuses to run while a name is used but never defined, and says so:
 * "the model is still incomplete — line 1: k is not defined yet". That is not a
 * failure. It is the ordinary state of a document that is being written, and
 * showing it in red teaches someone that half-typing is a mistake.
 *
 * Note what is NOT in here: order. Rows may be written in any sequence - an
 * initial condition above its ODE row, a parameter used before it is defined, a
 * function called before it is written - and the compiler resolves the document
 * as a whole. So a document that is waiting is waiting for a name to EXIST
 * somewhere, never for it to exist ABOVE.
 *
 * Three situations wear one shape (`ok: false` plus a sentence) and they are
 * not the same event:
 *
 *   'waiting'  a name has not been typed yet   gray, and the curve stays
 *   'refused'  a method this document has no structure for   red, no curve
 *   'failed'   anything else                                 red, no curve
 */
function classifySolveFailure(msg, issues) {
  // Every engine refusal of a method opens with that method's name.
  if (methodNames.some((n) => msg.indexOf(n) === 0)) return 'refused';
  if (/incomplete|not defined/i.test(msg)) return 'waiting';
  if (issues.some((i) => i.severity === 'pending' && i.fix)) return 'waiting';
  return 'failed';
}

/**
 * What the document is waiting for, by name. Only an undefined name actually
 * stops the solve - a missing initial condition is reported AND defaulted in
 * the same pass, so it is never what the model is waiting on.
 */
function waitingOn() {
  const names = offeredFixes.map((f) => f.target).filter((t) => !/\(0\)$/.test(t));
  return names.length
    ? 'waiting on ' + names.join(', ')
    : 'waiting for the rest of the document';
}

// ---------------------------------------------------------------------------
// Views - a small menu, not three chips spending permanent width
//
// Every view the model supports turns itself ON. That is the right default
// because the views SHARE ONE FRAME now: an extra one is an extra curve over
// the same axes, not a tile taken out of the picture, so there is nothing to
// pay for having it on. The menu exists for the other direction - turning one
// OFF when it is in the way - and a view the model cannot support is listed
// with the reason, because that is how the capability is discovered.
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

const VIEW_WHY = {
  time:  ['every state against time', 'every state against time'],
  phase: ['state 2 against state 1', 'needs exactly 2 states'],
  polar: ['r against the angle', 'needs a state named r'],
};

const caps = { time: true, phase: false, polar: false };

/**
 * The views the user has explicitly switched OFF. Everything the model supports
 * and is not in here is on - so gaining a second state lights the phase
 * portrait up by itself, and turning it off keeps it off across recompiles and
 * demo loads, because that was a decision and decisions are remembered.
 */
const viewsOff = new Set();

/** The views actually drawn: supported, and not switched off. */
function activeViews() {
  return VIEWS.filter((v) => caps[v] && !viewsOff.has(v));
}

/** Push the on-set and the capability set at the plot, then repaint. */
function applyViews() {
  plot.setViews(activeViews());
  plot.setSupport(caps);
  renderViewMenu();
  syncFrameButtons();
  scheduleDraw();
}

function toggleView(view) {
  if (VIEWS.indexOf(view) < 0) return;
  if (viewsOff.has(view)) {
    if (!caps[view]) return;        // an unsupported view has nothing to show
    viewsOff.delete(view);
  } else {
    viewsOff.add(view);
  }
  applyViews();
  // Turning t–y back on hands the span back to the horizontal axis, and the
  // axis may have moved while it was off.
  scheduleResolve(0);
}

/** The menu itself: one line per view, checked when it is drawing. */
function renderViewMenu() {
  if (!el.viewmenu) return;
  el.viewmenu.textContent = '';
  const live = activeViews();
  for (const view of VIEWS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'viewitem';
    item.setAttribute('role', 'menuitemcheckbox');
    item.dataset.view = view;

    const on = live.indexOf(view) >= 0;
    item.classList.toggle('is-on', on);
    item.classList.toggle('is-off', !caps[view]);
    item.setAttribute('aria-checked', on ? 'true' : 'false');
    item.setAttribute('aria-disabled', caps[view] ? 'false' : 'true');

    const mark = document.createElement('span');
    mark.className = 'viewitem__mark';
    mark.textContent = on ? '✓' : '';

    const name = document.createElement('span');
    name.className = 'viewitem__name';
    name.textContent = VIEW_LABEL[view] || view;

    const why = document.createElement('span');
    why.className = 'viewitem__why';
    const t = VIEW_WHY[view];
    why.textContent = t ? (caps[view] ? t[0] : t[1]) : '';

    item.append(mark, name, why);
    item.addEventListener('click', () => toggleView(view));
    el.viewmenu.append(item);
  }
  el.viewsBtn.classList.toggle('is-live', viewsOff.size > 0);
  el.viewsBtn.title = live.length
    ? 'drawing: ' + live.map((v) => VIEW_LABEL[v] || v).join(', ')
    : 'nothing is drawn — turn a view on';
}

function openViews() {
  renderViewMenu();
  const r = el.viewsBtn.getBoundingClientRect();
  el.viewmenu.hidden = false;
  el.viewsBtn.setAttribute('aria-expanded', 'true');
  const w = el.viewmenu.offsetWidth;
  el.viewmenu.style.left = clamp(r.left, 8, Math.max(8, window.innerWidth - w - 8)) + 'px';
  el.viewmenu.style.top = (r.bottom + 8) + 'px';
}

function closeViews() {
  if (!el.viewmenu || el.viewmenu.hidden) return;
  el.viewmenu.hidden = true;
  el.viewsBtn.setAttribute('aria-expanded', 'false');
}

function toggleViewMenu() {
  if (el.viewmenu.hidden) openViews(); else closeViews();
}

/**
 * What the document can currently show. A view that GAINS support turns on by
 * itself unless it was switched off by hand; one that loses it stops drawing
 * and says why in the menu, because a curve that cannot exist is not a curve
 * anyone is owed.
 */
function updateCapabilities(names) {
  caps.time = true;
  caps.phase = Array.isArray(names) && names.length === 2;
  caps.polar = polarMapFor(names) !== null;
  applyViews();
}

// ---------------------------------------------------------------------------
// `show` - a document saying what is worth looking at
//
// `colliding-strings` has twelve states and is about two strings. `show` names
// the series that are the picture; the rest are still solved and still in the
// hear panel, they are simply not drawn and not in the legend. Absent - or
// naming nothing that exists in this document - means everything.
// ---------------------------------------------------------------------------

function shownSelection(names, extra) {
  const want = state.show;
  if (!Array.isArray(want) || !want.length) return { states: null, extra: null };

  const states = [];
  const derived = [];
  (names || []).forEach((n, i) => { if (want.indexOf(n) >= 0) states.push(i); });
  (extra || []).forEach((ex, i) => { if (want.indexOf(ex.name) >= 0) derived.push(i); });

  // A `show` list that matches nothing would draw an empty plot, which is a
  // worse answer than ignoring it.
  if (!states.length && !derived.length) return { states: null, extra: null };
  return { states, extra: derived };
}

// ---------------------------------------------------------------------------
// The readout - which is also the legend
//
// Colour, name, and the value at the right-hand edge of the window - the end of
// the span that was solved. A separate legend would repeat two thirds of that,
// so there is only one of them and it sits on the plot's control strip.
// ---------------------------------------------------------------------------

function renderReadout(names, values) {
  el.readout.innerHTML = '';
  if (!Array.isArray(names) || !names.length) return;

  const sol = state.sol;
  const extra = (sol && sol.extra) || [];
  const showStates = sol && Array.isArray(sol.showStates) ? sol.showStates : null;
  const showExtra = sol && Array.isArray(sol.showExtra) ? sol.showExtra : null;

  const have = values && values.length;
  names.forEach((name, i) => {
    if (showStates && showStates.indexOf(i) < 0) return;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.title = name + ' at t = ' + fmtValue(state.t1) + ', the right edge of the window';
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

  // Derived rows report their drift rather than a value: the point of an energy
  // row is not what it reads now but whether it is holding. secularRatio
  // compares the band over the last tenth of the run against the first — around
  // 1 is a band, well above 1 is a genuine drift.
  extra.forEach((ex, e) => {
    if (showExtra && showExtra.indexOf(e) < 0) return;
    const chip = document.createElement('span');
    chip.className = 'chip chip--derived';
    const dot = document.createElement('span');
    dot.className = 'chip__dot';
    dot.style.background = seriesColor(names.length + e);
    const n = document.createElement('span');
    n.className = 'chip__name';
    n.textContent = ex.name;
    const v = document.createElement('span');
    v.className = 'chip__val';
    const r = ex.drift && Number(ex.drift.secularRatio);
    const rel = ex.drift && Number(ex.drift.relativeDrift);
    if (isFinite(r)) {
      v.textContent = r < 1.5 ? 'holding' : `drifting ${r.toFixed(1)}x`;
      chip.title = `${ex.name}: relative drift ${isFinite(rel) ? rel.toExponential(1) : '?'}`
        + `, secular ratio ${r.toFixed(3)} (about 1 means a bounded band)`;
    } else {
      v.textContent = '—';
    }
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
    plot.draw(state.sol);
  });
}

// ---------------------------------------------------------------------------
// The frame - -5..5 by default, the user's from then on, and THE QUERY
//
// Desmos' bargain: a fixed, predictable window is what makes two runs
// comparable, so the plot does not fit itself around the data. What it does
// instead is put the frame entirely in the user's hands:
//
//   drag the plot body      pan both axes
//   drag along the x labels scale x about the value you grabbed
//   drag along the y labels scale y about the value you grabbed
//   wheel                   zoom about the cursor (over an axis: that axis)
//   double click            back to -5..5
//   the -5..5 button        back to -5..5
//   the fit button          around the curve, when asked
//
// A re-solve never touches any of it. The other direction is new: while `t–y`
// is on, x0..x1 IS the span, so every one of those gestures ends in a re-solve
// (scheduleResolve, below) over whatever the horizontal axis now shows.
// ---------------------------------------------------------------------------

function syncFrameButtons() {
  const dirty = !plot.isDefaultFrame();
  el.frameReset.classList.toggle('is-live', dirty);
  el.frameReset.setAttribute('aria-disabled', dirty ? 'false' : 'true');
  el.frameFit.disabled = !state.sol;
}

/** Every gesture ends here: repaint now, re-solve shortly. */
function frameChanged(delay) {
  syncFrameButtons();
  scheduleDraw();
  scheduleResolve(delay);
}

function resetFrames() {
  plot.resetWindow();
  frameChanged(0);
}

function fitFrames() {
  if (!state.sol) return;
  const win = plot.fitWindow(state.sol);
  if (win) {
    // Fitting x while `t–y` is on would be circular - x already IS the solved
    // span, so "fit" there can only mean "fit what the curves are doing
    // vertically". The span is left exactly where the user put it.
    const keepX = activeViews().indexOf('time') >= 0;
    const now = plot.getWindow();
    plot.setWindow(keepX ? { ...win, x0: now.x0, x1: now.x1 } : win);
  }
  frameChanged(0);
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
      box: hit.box,
      region: hit.region,
      x: p.x,
      y: p.y,
      // The window as it was when the gesture began. Every move recomputes
      // from this rather than accumulating, so a drag cannot drift.
      win: plot.getWindow(),
      anchor: plot.dataAt(hit.box, p.x, p.y),
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
        plot.setWindow(panned(drag.win, drag.box, dx, dy));
      } else if (drag.region === 'x') {
        // Drag right and the axis stretches: the span shrinks, the value you
        // grabbed stays under the pointer.
        const w = Math.max(1, drag.box.R - drag.box.L);
        plot.setWindow(scaled(drag.win, 'x', Math.exp(-dx / (w * 0.5)), drag.anchor.x));
      } else {
        const h = Math.max(1, drag.box.B - drag.box.T);
        plot.setWindow(scaled(drag.win, 'y', Math.exp(dy / (h * 0.5)), drag.anchor.y));
      }
      // The picture follows the pointer at once; the SOLVE is debounced, so a
      // drag is one integration at the end of it and not one per pointermove.
      frameChanged();
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
    plot.resetWindow();
    frameChanged(0);
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
    const at = plot.dataAt(hit.box, p.x, p.y);
    const win = plot.getWindow();
    if (hit.region === 'x') plot.setWindow(scaled(win, 'x', f, at.x));
    else if (hit.region === 'y') plot.setWindow(scaled(win, 'y', f, at.y));
    else plot.setWindow(zoomed(win, f, at.x, at.y));
    frameChanged();
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
// `t` is not one of these and never will be again: the span is the window, and
// a window already has a way to be moved.
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

/** name -> slider record, for every parameter that has been asked for. */
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
    writeParam(s);
  });
}

/**
 * A slider, on the row that defines the thing it drives. It carries no name and
 * no value readout, because the row above it says both - `k = 60` is the
 * readout, and dragging rewrites it live.
 */
function makeSlider(name, init) {
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
  gear.title = 'Range and step for ' + name;
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
    label: knob && knob.label ? String(knob.label) : '',
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
  // No readout of its own: the row above it is the readout. The hover text is
  // where a demo's description of the knob goes.
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
  el.settingsFoot.textContent = 'Esc to close';

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

  if (isFinite(min) && isFinite(max) && max > min) {
    s.min = min;
    s.max = max;
  }
  if (isFinite(step) && step > 0) s.step = step;

  applyRange(s);

  // A chosen range outlives the slider: deleting and retyping the row, or
  // dismissing and re-adding the slider, must not throw it away.
  knobRanges.set(s.name, { min: s.min, max: s.max, step: s.step });
}

// -- parameter sliders write back into their own row ------------------------

const NUM = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?`;

const ASSIGN_RE = new RegExp(String.raw`^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(${NUM})\s*$`);

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
    if (state.names.indexOf(name) >= 0) continue;   // it is a state, not a knob
    drivable.add(name);
  }

  const wanted = new Map();     // row -> { name, value }
  const seen = new Set();
  for (const row of realRows()) {
    const m = ASSIGN_RE.exec(rowSource(row).split('#')[0]);
    if (!m) continue;
    const name = m[1];
    if (!drivable.has(name) || seen.has(name)) continue;
    seen.add(name);
    wanted.set(row, { name, value: Number(m[2]) });
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
      const s = sliders.get(w.name) || makeSlider(w.name, initialRangeFor(w.name, w.value));
      if (s.el.parentNode !== row.knobEl) row.knobEl.appendChild(s.el);
    } else {
      row.offerName = w.name;
      row.offerEl.hidden = false;
      row.offerEl.title = 'Add a slider for ' + w.name;
      row.offerEl.setAttribute('aria-label', 'Add a slider for ' + w.name);
    }
    row.knobKey = key;
  }

  // 3. drop the sliders whose variable left the document
  for (const [name, s] of Array.from(sliders)) {
    if (seen.has(name)) continue;
    if (openSlider === s) closeSettings();
    s.el.remove();
    sliders.delete(name);
  }

  // 4. keep the document's value and the slider's value in step
  for (const w of wanted.values()) {
    const s = sliders.get(w.name);
    if (s && !s.dragging) setSliderValue(s, w.value);
  }
}

// ---------------------------------------------------------------------------
// The compute pipeline
// ---------------------------------------------------------------------------

/**
 * How many points to ask for: one per device pixel across the canvas. Asking
 * for more than the canvas can draw is waste, and asking for fewer is a lie
 * about the curve (docs/ui-v5.md).
 */
function sampleCount() {
  const w = el.canvas.getBoundingClientRect().width || 900;
  const dpr = Math.min(4, Math.max(1, window.devicePixelRatio || 1));
  return Math.round(clamp(w * dpr, 240, 4000));
}

/**
 * THE SPAN. While `t–y` is on, the horizontal axis is time, so the window IS
 * the integration range and there is nothing else to read it from.
 *
 * With `t–y` off, the horizontal axis is a state (phase) or a coordinate
 * (polar), and panning it is not a statement about time at all - so the last
 * span simply stands, unchanged, until `t–y` comes back. Silently re-solving
 * over the phase plane's x range would be a number arrived at by accident.
 */
function spanFromFrame() {
  if (activeViews().indexOf('time') < 0) return { t0: state.t0, t1: state.t1 };
  const w = plot.getWindow();
  return { t0: w.x0, t1: w.x1 };
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
  // Rows that are functions of the solution rather than constants. They carry
  // no value until there is a curve, which is why they are not parameters.
  const derived = Array.isArray(diag.derived) ? diag.derived : [];

  applyDiagnostics(issues);

  state.names = names;
  state.params = params;
  state.derived = derived;
  refreshDocumentNames();   // Tab now completes the document's own vocabulary

  const hasError = issues.some((i) => i.severity === 'error');
  if (hasError) {
    // Keep the last good curve - AND the last good chips, legend and sliders -
    // on screen. The document is mid-edit, not dead, and nothing should move.
    setSolveBadge('paused on error', 'bad');
    return;
  }

  // `pending` is not an error, so the views still track the document live:
  // `phase` lights up the moment a system gains its second state.
  updateCapabilities(names);
  syncKnobs(params);

  if (!names.length) {
    setSolveBadge('no states', null);
    state.sol = null;
    el.statAccepted.textContent = '—';
    el.statRejected.textContent = '—';
    el.statRhs.textContent = '—';
    el.readout.innerHTML = '';
    scheduleDraw();
    return;
  }

  // The window is the query: whatever the horizontal axis is showing is what
  // gets integrated.
  const { t0, t1 } = spanFromFrame();
  if (!isFinite(t0) || !isFinite(t1) || t1 <= t0) {
    setSolveBadge('bad span', 'bad');
    return;
  }

  // 2. solve, with whichever integrator is selected on the strip
  const report = parseJson(solveNow(t0, t1), 'SolveReport');
  if (!report || report.ok !== true) {
    const why = report && report.error ? String(report.error) : 'solve failed';
    const kind = classifySolveFailure(why, issues);
    // A refusal is data, not an exception: remember which method was turned
    // down, so the strip says so instead of leaving a blank plot unexplained.
    // Nothing else earns that mark - a document mid-sentence is not the
    // integrator's fault.
    lastMethodError = kind === 'refused' ? { method: currentMethod, message: why } : null;
    renderMethods();

    if (kind === 'waiting') {
      // Not a failure: a document mid-sentence. Say what it is waiting FOR, in
      // the muted style, and leave the last good curve exactly where it is -
      // the same courtesy an `error` row already gets. The issue bar below has
      // the names and the one-click rows that finish the thought.
      setSolveBadge(waitingOn(), 'wait');
      el.statSolve.title = why;
      return;
    }

    setSolveBadge(why, 'bad');
    if (report) {
      el.statAccepted.textContent = report.accepted ?? '—';
      el.statRejected.textContent = report.rejected ?? '—';
      el.statRhs.textContent = report.rhsEvals ?? '—';
    }
    // A refused solve has already invalidated the previous solution inside the
    // model, so there is nothing left to draw and drawing the old curve would
    // be a lie. Put the refusal itself on the canvas, where a plot that has
    // gone blank would otherwise just look broken - this is how a symplectic
    // method asked of a first-order document says so.
    state.t0 = t0;
    state.t1 = t1;
    state.sol = { message: why };
    el.readout.innerHTML = '';
    syncFrameButtons();
    scheduleDraw();
    return;
  }

  el.statAccepted.textContent = report.accepted ?? '—';
  el.statRejected.textContent = report.rejected ?? '—';
  el.statRhs.textContent = report.rhsEvals ?? '—';

  const dim = Number.isInteger(report.dim) ? report.dim : names.length;
  const reportNames = Array.isArray(report.states) && report.states.length
    ? report.states
    : names;

  // 3. sample the whole curve, at the resolution the canvas can draw
  const n = sampleCount();
  const data = toF64(M.sample(n));
  const stride = dim + 1;
  const got = stride > 0 ? Math.floor(data.length / stride) : 0;

  state.t0 = isFinite(report.t0) ? report.t0 : t0;
  state.t1 = isFinite(report.t1) ? report.t1 : t1;

  // The report echoes the method it actually used, so the badge can never name
  // one that did not run.
  setSolveBadge(report.method ? 'solved · ' + report.method : 'solved', 'ok');
  el.statSolve.title = (report.method ? report.method + ' · ' : '')
    + 't ∈ [' + fmtValue(state.t0) + ', ' + fmtValue(state.t1) + ']'
    + ' · ' + got + ' samples';
  lastMethodError = null;
  renderMethods();

  if (!got) {
    state.sol = null;
    scheduleDraw();
    return;
  }

  if (String(reportNames) !== String(names)) updateCapabilities(reportNames);

  const extra = derivedSeries(state.derived, got);
  const sel = shownSelection(reportNames, extra);

  state.sol = {
    names: reportNames,
    dim,
    n: got,
    data,
    t0: state.t0,
    t1: state.t1,
    polar: polarMapFor(reportNames),
    extra,
    showStates: sel.states,
    showExtra: sel.extra,
  };

  // A re-solve draws inside the frame the user left. It is never moved here.
  syncFrameButtons();
  renderReadout(reportNames, endValues());
  scheduleDraw();
}

/**
 * The state at the right-hand edge of the window - what the legend reads. There
 * is no playhead to read instead, and the end of the span is the one time every
 * curve on screen actually reaches.
 */
function endValues() {
  if (!M) return new Float64Array(0);
  try {
    return toF64(M.eval(state.t1));
  } catch (err) {
    console.error('[numpla] eval failed', err);
    return new Float64Array(0);
  }
}

/**
 * Evaluate the document's derived rows along the solution.
 *
 * A derived row (`E = 0.5(x'^2 + x^2)`) is a function of the solution rather
 * than a parameter, so it has no value until there is a curve. Drawing it beside
 * the states is the conservation monitor: with a symplectic method the line sits
 * in a band forever, and with an adaptive one it walks away. `secularRatio` is
 * the number that says which — around 1 is a band, well above 1 is a drift.
 *
 * The sample count is a request, not a promise: the compiler raises it to at
 * least one per accepted step, because too few samples per oscillation alias a
 * conserved quantity into a drifting one. It reports back what it really took.
 */
function derivedSeries(names, n) {
  if (!M || !names || !names.length) return null;
  const out = [];
  for (const name of names) {
    try {
      const rep = parseJson(M.conservation(name, n), 'ConservationReport');
      if (!rep || rep.ok !== true) continue;
      const pairs = toF64(M.conservationSeries());
      if (pairs.length < 4) continue;
      out.push({
        name,
        pairs,                       // flat [t, value] * samples
        n: Math.floor(pairs.length / 2),
        initial: rep.initial,
        drift: rep.drift || null,
      });
    } catch (err) {
      console.error('[numpla] conservation failed for ' + name, err);
    }
  }
  return out.length ? out : null;
}

let debounceTimer = 0;

function runRecompute() {
  try {
    recompute();
  } catch (err) {
    console.error('[numpla] recompute failed', err);
    setSolveBadge('internal error', 'bad');
  }
}

function scheduleRecompute(delay = 160) {
  clearTimeout(debounceTimer);
  clearTimeout(resolveTimer);       // an edit subsumes a pending window solve
  debounceTimer = setTimeout(runRecompute, delay);
}

// ---------------------------------------------------------------------------
// The window -> span loop
//
// Every frame gesture calls this. It is debounced exactly the way typing is,
// and for the same reason: a pointermove is not a decision. The picture follows
// the pointer at 60fps (scheduleDraw redraws the curve already in hand inside
// the new window), and ONE integration happens when the hand stops - so a drag
// across the canvas costs one solve, not two hundred.
//
// The guard is the span itself, not "did something move": panning vertically,
// scaling y, or moving the frame with `t–y` switched off all leave the span
// exactly where it was, and re-solving for an identical span would be work
// nobody asked for.
// ---------------------------------------------------------------------------

const RESOLVE_MS = 180;
let resolveTimer = 0;

function spanUnchanged(a, b) {
  // Compared relatively: at t ∈ [0, 400] a difference of 1e-9 is not a pan.
  const scale = Math.max(1e-12, Math.abs(a.t1 - a.t0));
  return Math.abs(a.t0 - b.t0) < scale * 1e-9 && Math.abs(a.t1 - b.t1) < scale * 1e-9;
}

function scheduleResolve(delay = RESOLVE_MS) {
  clearTimeout(resolveTimer);
  resolveTimer = setTimeout(() => {
    const want = spanFromFrame();
    if (!isFinite(want.t0) || !isFinite(want.t1) || want.t1 <= want.t0) return;
    if (spanUnchanged(want, { t0: state.t0, t1: state.t1 })) return;
    runRecompute();
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
let methodInfo = new Map();           // name -> { adaptive, symplectic, order }
let currentMethod = FALLBACK_METHODS[0];
let lastMethodError = null;           // { method, message } after a refusal

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
    methodInfo = new Map(list.map((m) => [m.name, m]));
    currentMethod = methodNames[0];
  }
  return { call: (t0, t1, name) => model[fn](t0, t1, name), list };
}

/**
 * Does this document have the position/velocity structure a symplectic method
 * needs? A second-order row is lowered to two states with the velocity named
 * `x'`, so a primed state name is exactly that structure showing through
 * `Diagnostics.states` (docs/wasm-api.md, "State order").
 *
 * This only DIMS the entry - it never blocks the click. The engine's refusal
 * names the offending row and says what to write instead, and that sentence is
 * worth more than a disabled button.
 */
function hasSecondOrderRows() {
  return (state.names || []).some((n) => typeof n === 'string' && n.indexOf("'") >= 0);
}

/**
 * The integrator switch on the plot's strip: discrete versus continuous, one
 * click, the live choice legible without hovering anything. Built from
 * `Model.methods()` so a method added to numpla-ode arrives here on its own.
 */
let methodsSignature = null;

function renderMethods() {
  if (!el.methods) return;

  const structural = hasSecondOrderRows();
  // Rebuilding these on every solve would tear the strip apart under a drag -
  // and take the focus ring with it. Nothing here changes unless one of these
  // three facts does.
  const signature = [
    currentMethod, structural ? '2' : '1',
    lastMethodError ? lastMethodError.method + ':' + lastMethodError.message : '',
    methodNames.join(','),
  ].join('|');
  if (signature === methodsSignature) return;
  methodsSignature = signature;

  el.methods.textContent = '';
  for (const name of methodNames) {
    const info = methodInfo.get(name) || {};
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'modechip';
    btn.dataset.method = name;
    btn.textContent = name;

    const live = name === currentMethod;
    const refused = !!(lastMethodError && lastMethodError.method === name);
    const needsStructure = info.symplectic === true && !structural;

    btn.classList.toggle('is-on', live);
    btn.classList.toggle('is-refused', live && refused);
    btn.classList.toggle('is-unavailable', needsStructure && !live);
    btn.setAttribute('aria-pressed', live ? 'true' : 'false');

    const kind = info.adaptive === true ? 'adaptive'
      : info.adaptive === false ? 'fixed step' : '';
    const order = Number.isFinite(info.order) ? ', order ' + info.order : '';
    btn.title = refused && live
      ? lastMethodError.message
      : name + (kind ? ' — ' + kind + order : '')
        + (info.symplectic ? ' · symplectic' : '')
        + (needsStructure ? ' · this document has no x\'\' rows to preserve' : '');

    if (!methodApi) {
      btn.setAttribute('aria-disabled', 'true');
      btn.title = 'the loaded app/pkg/ build has no solve_with — rebuild the WASM';
    } else {
      btn.addEventListener('click', () => chooseMethod(name));
    }
    el.methods.append(btn);
  }
}

/** Integrate with whichever integrator is selected, or plainly. */
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
  if (currentMethod !== name) lastMethodError = null;
  currentMethod = name;
  renderMethods();
  if (!el.info.hidden) renderReference();
  scheduleRecompute(0);
  return true;
}

const REFERENCE = [
  {
    group: 'Row kinds',
    note: 'One row per line, in any order — the compiler reads the whole document at once, so an initial condition may sit above its ODE row and a parameter may be used before the row that defines it. Each of these writes a new row into the document.',
    rows: true,
    entries: [
      { sig: "x' = -y", desc: 'An ODE row. `x` becomes a state variable, and `t` is bound to the current time on the right-hand side.', keys: 'ode derivative state' },
      { sig: "x'' = -x", desc: 'Second order. Lowered to two states automatically; the hidden velocity state sits immediately after its position.', keys: 'second order acceleration' },
      { sig: "x'(0) = 0", desc: 'The starting velocity of a second-order row.', keys: 'initial velocity' },
      { sig: 'x(0) = 1', desc: 'An initial condition. Leave it out and it is 0 — reported, not assumed in silence.', keys: 'initial condition start' },
      { sig: 'k = 0.4', desc: 'A parameter, visible to every row. A plain numeric one can be given a slider on its own row.', keys: 'parameter constant knob' },
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
      { sig: 't', desc: 'Bound to the current time inside any right-hand side. There is no row and no slider for it: the span it runs over is whatever the plot’s horizontal axis is showing.', insert: 't', keys: 'time span window integration range' },
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
      { sig: 'the window is the span', desc: 'What is on screen is what gets solved. Pan or zoom the horizontal axis and the model re-integrates over the new interval, at one sample per pixel of canvas. There is no `t` slider, no playhead and no play button, because the frame already knows where you are looking. Zooming far out is a genuinely longer integration and may take longer — the telemetry says so.', keys: 'time span window zoom pan integration range playhead transport scrub' },
      { sig: 'add slider', desc: 'Every plain `k = number` row offers one, in the line it already reserves for its diagnostic. It sits on the row that defines the number, and dragging it rewrites that row.', keys: 'slider knob parameter drag' },
      { sig: 'one plot, everything in it', desc: 't–y, phase and polar all draw into ONE frame, overlapping — nothing is tiled. A view the model supports turns itself on; the views menu on the strip is how you turn one off when it is in the way.', keys: 'view phase polar toggle overlap menu tile' },
      { sig: 'discrete versus continuous', desc: 'The integrator is on the strip: Tsit5 against Verlet and Yoshida4, one click, the live one marked. A symplectic method asked of a document with no second-order rows is refused by name and the sentence is drawn on the plot — there is deliberately no silent fallback.', keys: 'integrator method symplectic verlet yoshida tsit5 switch mode' },
      { sig: 'what to draw', desc: 'A demo may declare `show: [...]` — the series that are the picture. Only those are drawn and only those are in the legend; the rest are still solved.', keys: 'show series legend filter demo' },
      { sig: 'the frame is yours', desc: '−5 to 5 on both axes to begin with, so two runs are comparable. Drag an axis to scale it, drag the body to pan, wheel to zoom about the cursor, double-click to put it back. A re-solve never moves it — moving it is what causes one.', keys: 'axes zoom pan scale window frame reset' },
      { sig: 'rows in any order', desc: 'The whole document is compiled at once, twice over, so nothing has to be written before anything else: put an initial condition above its ODE row, use a parameter three rows before you define it, call a function you have not written yet. A name that is missing is reported as missing — never as out of order.', keys: 'order sequence sort forward reference declaration' },
      { sig: 'gray, not red', desc: 'An incomplete document is muted, never an error, and only a real error pauses the solve — the last good curve stays on screen while you type. A solve waiting on an undefined name says “waiting on k”, in the same muted style, and keeps the curve too: half-written is a normal state, not a fault.', keys: 'pending error diagnostic waiting incomplete' },
      { sig: 'the issue bar', desc: 'What the document still needs, by name — every missing name listed, with the rows the compiler would have written one click away.', keys: 'fix missing initial condition waiting undefined' },
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
        ? ' The same switch is on the plot’s strip. Click one to switch; the live one is marked, and the report names the method that actually ran.'
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

function wire() {
  applyViews();               // pushes the on-set at the plot for the first draw
  renderMethods();
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

  el.viewsBtn.addEventListener('click', toggleViewMenu);

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
    if (e.key === 'Escape' && el.viewmenu && !el.viewmenu.hidden) {
      e.preventDefault();
      closeViews();
      el.viewsBtn.focus();
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
    }
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
    if (el.viewmenu && !el.viewmenu.hidden && dt && typeof dt.closest === 'function' &&
        !dt.closest('.viewmenu') && !dt.closest('#views-btn')) {
      closeViews();
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
    closeViews();
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
      conservation:       bindMethod(model, 'conservation'),
      conservationSeries: bindMethod(model, 'conservation_series'),
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
