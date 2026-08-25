// ============================================================================
// main.js - the Numpla browser shell.
//
// Flow:
//   boot()   ->  load MathField + WASM  ->  reveal the app (eased)
//   edit     ->  debounce  ->  set_source  ->  per-row diagnostics  ->  solve
//   pan/zoom ->  debounce  ->  solve over the NEW window  ->  re-sample
//                          ->  re-ask vector_field for the NEW window
//   sliders  ->  a parameter slider rewrites its own row and re-solves
//   click    ->  a seed on the plane  ->  trajectory_from, throttled while
//                it is dragged, and it NEVER writes a row
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
// The same sentence is why the `field` view exists: the window is the query
// there too, so the arrows are re-sampled for wherever you are looking. And a
// SEED - a starting point dropped on the plane - is a view of the model rather
// than a change to it: it gets its own trajectory over the same window and
// never touches a row (docs/fields-and-seeds.md).
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
  Plot, VIEWS, VIEW_LABEL, PLANE_VIEWS, panned, scaled, zoomed, seriesColor,
  fmtValue, fieldGrid,
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
  seedsBtn:  $('seeds-btn'),
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

  // narrow layout
  panetabs:  $('panetabs'),
  tabPlot:   $('tab-plot'),
  tabSystem: $('tab-system'),
  docPane:   $('docpane'),
  plotPane:  $('plotpane'),

  // the math keyboard
  kb:      $('mathkb'),
  kbVars:  $('kb-vars'),
  kbGrid:  $('kb-grid'),
  kbHide:  $('kb-hide'),
  kbOpen:  $('kb-open'),
  kbPages: [$('kb-page-123'), $('kb-page-abc'), $('kb-page-fn')],
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
  tEnd: 5,         // how far the last integration actually got: t1 unless it
                   // gave up early, in which case the curve stops there
  // What the loaded document says is worth drawing (`show`), or null for
  // everything. A display choice: the states left out are still solved.
  show: null,
  // The right-hand side as last sampled across the visible window:
  // { nx, ny, t, data, gen, win } or null. The window is the query, so this is
  // re-asked whenever the window moves.
  field: null,
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
  // A row taking the caret is the whole trigger for the math keyboard: on a
  // touch device it slides up, and on a narrow screen the system pane has to
  // be the one on screen for that to mean anything. See "The math keyboard".
  if (row) onRowFocused(row);
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
  navHandled = true;      // the keyboard's arrow keys read this - see kbNavigate
  focusRow(j, !forward);
}

/**
 * Set by navigate(). The keyboard's arrow keys have to know whether the FIELD
 * already walked the caret out of its own edge and into the next row (which it
 * does by calling onNavigate, which is navigate()), because otherwise a single
 * tap on `→` at the end of a row would move two rows: once through the field's
 * own edge handling and once through the keyboard's.
 */
let navHandled = false;

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
  // The keyboard's name row is the same fact, drawn as keys.
  renderKeyboardVars();
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
    // A field told it is touch-driven does not raise the OS keyboard - the
    // panel at the bottom of the screen is the keyboard. Passed as an option
    // AND set again below, because a build of mathfield.js that predates the
    // option must not lose the fact when one that has it lands.
    touchDriven: touchMode,
    documentNames: docNames(),
    onChange: () => {
      // Typing into the blank row is what makes it a row. A fresh blank one
      // takes its place immediately, so the list always ends in one.
      ensureTail();
      renumber();
      scheduleRecompute();
    },
    onFocus: () => setActiveRow(row),
    onBlur: () => { row.el.classList.remove('is-active'); onRowBlurred(); },
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

  try { row.field.touchDriven = touchMode; } catch (err) { /* older field */ }

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

  // A seed is a point in THIS system's state space. Another system is another
  // space, so the handles do not carry over.
  clearSeeds();

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
  field: ['the equation itself, as arrows', 'needs exactly 2 states'],
};

const caps = { time: true, phase: false, polar: false, field: false };

/**
 * The one-line reason a view is or is not drawable. `field` has a second way
 * to be unavailable that has nothing to do with the document: an `app/pkg/`
 * built before `vector_field` existed. Saying which is which is the difference
 * between "your model is wrong" and "your build is old".
 */
function viewWhy(view) {
  const t = VIEW_WHY[view];
  if (!t) return '';
  if (caps[view]) return t[0];
  if (view === 'field' && !fieldApi) return 'this WASM build has no vector_field';
  return t[1];
}

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
  // Turning the field on IS the query; turning it off drops the arrows.
  scheduleField(0);
  syncSeeds();
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
    why.textContent = viewWhy(view);

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
  const plane = Array.isArray(names) && names.length === 2;
  caps.time = true;
  caps.phase = plane;
  caps.polar = polarMapFor(names) !== null;
  // The same condition as `phase`, for the same reason - the plane has two
  // axes - plus a build that can actually answer for the right-hand side.
  caps.field = plane && !!fieldApi;
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
  resampleForFrame();
  scheduleDraw();
  scheduleResolve(delay);
  // The window is the field's query too, so the arrows follow it - debounced
  // the same way, with the ones already on screen left up in the meantime.
  scheduleField(delay);
}

/**
 * Re-sample the CURRENT solution across the visible window, before any
 * re-solve.
 *
 * `sample(n)` spreads its points evenly over the whole integrated span, so
 * after solving [0, 20] and zooming to [9, 11] only a tenth of them land on
 * screen — stretched across the full width, which draws a visibly polygonal
 * line until the debounced re-solve lands. The line was not wrong about the
 * data; it was drawing a tenth of it.
 *
 * The solver's dense output already answers at any `t` inside the solved span,
 * so zooming *in* never needs a re-solve at all: ask it once per pixel over the
 * part of the window it can answer for. Roughly 900 evaluations, about a
 * quarter of a millisecond — far cheaper than an integration, and correct
 * immediately rather than 180 ms later.
 *
 * Only a window reaching outside the solved span still needs the real re-solve,
 * which is exactly what `scheduleResolve` is for.
 */
function resampleForFrame() {
  const f = state.sol;
  if (!M || !f || !f.dim || !f.n) return;

  const w = plot.getWindow();
  const a = Math.max(state.t0, Math.min(w.x0, w.x1));
  const b = Math.min(state.tEnd, Math.max(w.x0, w.x1));
  if (!(b > a)) return;                      // nothing of the solution is in view

  const n = sampleCount();
  const stride = f.dim + 1;
  const data = new Float64Array(n * stride);
  for (let i = 0; i < n; i++) {
    const t = a + ((b - a) * i) / (n - 1);
    let y;
    try {
      y = toF64(M.eval(t));
    } catch (err) {
      return;                                // leave the last good curve alone
    }
    if (y.length < f.dim) return;
    data[i * stride] = t;
    for (let d = 0; d < f.dim; d++) data[i * stride + 1 + d] = y[d];
  }

  f.data = data;
  f.n = n;
  f.t0 = a;
  f.t1 = b;
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

/**
 * A tap that lands a seed must not also be half of a double click, and a
 * double click must still reset the frame. So an add remembers where and when
 * it happened: a second tap in the same place inside the threshold is the same
 * gesture and adds nothing, and the dblclick that follows takes the seed back
 * out instead of resetting the frame.
 *
 * Two windows, because they guard opposite mistakes. Suppressing the second
 * tap must not swallow a deliberate second click, so it stays at the platform's
 * own double-click threshold. Undoing on `dblclick` only ever runs when the
 * platform has ALREADY ruled the pair a double click, so it can afford to be
 * generous - and it has to be, because the two events are separated by an
 * integration and a repaint.
 */
const ADD_SUPPRESS_MS = 500;
const DBL_UNDO_MS = 900;
const DBL_PX = 6;
let lastSeedAdd = { t: -1e9, x: 0, y: 0, id: 0 };

/**
 * TWO FINGERS.
 *
 * The window IS the integration span, so on a phone pinch and drag are how a
 * model gets re-solved over a different interval - which makes them the most
 * important gestures in the app, not a nicety. `pointerdown` already covers a
 * single finger (a touch pointer is a pointer), so what is missing is the
 * second one: while two are down the frame is panned by their midpoint and
 * zoomed by the distance between them, in one motion, the way a map behaves.
 *
 * Held in module scope so the pointerdown handler and the pinch handlers are
 * looking at one set of pointers rather than two.
 */
const touchPoints = new Map();     // pointerId -> { x, y }
let pinch = null;
let pinchEndedAt = -1e9;

/** The midpoint and separation of the two live pointers. */
function pinchPose() {
  const pts = Array.from(touchPoints.values());
  if (pts.length < 2) return null;
  const [a, b] = pts;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return {
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    dist: Math.max(1, Math.hypot(dx, dy)),
  };
}

/**
 * Data coordinates of a pixel in a GIVEN window - `plot.dataAt` answers for the
 * window the plot currently holds, and a pinch has to anchor in the window the
 * gesture started from, after this frame's pan has been applied to it.
 */
function dataIn(win, box, px, py) {
  const w = Math.max(1, box.R - box.L);
  const h = Math.max(1, box.B - box.T);
  return {
    x: win.x0 + ((px - box.L) / w) * (win.x1 - win.x0),
    y: win.y0 + ((box.B - py) / h) * (win.y1 - win.y0),
  };
}

function wireCanvasGestures() {
  const cv = el.canvas;
  let drag = null;

  const pinchMove = (ev) => {
    if (!pinch) return;
    if (touchPoints.has(ev.pointerId)) {
      const q = canvasPoint(ev);
      touchPoints.set(ev.pointerId, q);
    }
    const pose = pinchPose();
    if (!pose) return;
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    const box = pinch.box;
    // Pan by the midpoint first, then zoom about where the midpoint now is.
    const moved = panned(pinch.win, box,
      pose.mid.x - pinch.mid.x, pose.mid.y - pinch.mid.y);
    const f = pinch.dist / pose.dist;    // fingers apart -> f < 1 -> zoom in
    const at = dataIn(moved, box, pose.mid.x, pose.mid.y);
    plot.setWindow(zoomed(moved, f, at.x, at.y));
    frameChanged();
  };

  const pinchEnd = (ev) => {
    if (ev) touchPoints.delete(ev.pointerId);
    if (!pinch || touchPoints.size >= 2) return;
    pinch = null;
    pinchEndedAt = performance.now();
    cv.removeEventListener('pointermove', pinchMove);
    cv.removeEventListener('pointerup', pinchEnd);
    cv.removeEventListener('pointercancel', pinchEnd);
  };

  const startPinch = () => {
    const pose = pinchPose();
    const box = plot.box;
    if (!pose || !box) return;
    // One gesture at a time: whatever the first finger had started doing, the
    // second finger has just made it a pinch instead.
    drag = null;
    pinch = { win: plot.getWindow(), box, mid: pose.mid, dist: pose.dist };
    cv.addEventListener('pointermove', pinchMove);
    cv.addEventListener('pointerup', pinchEnd);
    cv.addEventListener('pointercancel', pinchEnd);
  };

  // Every touch pointer is recorded before anything else looks at it, so the
  // second one can turn the gesture into a pinch.
  cv.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    touchPoints.set(e.pointerId, canvasPoint(e));
    if (touchPoints.size === 2) startPinch();
  }, true);
  cv.addEventListener('pointerup', pinchEnd, true);
  cv.addEventListener('pointercancel', pinchEnd, true);
  cv.addEventListener('pointerleave', pinchEnd, true);

  const setHover = (id) => {
    if (hoverSeedId === id) return;
    hoverSeedId = id;
    syncSeeds();
    scheduleDraw();
  };

  cv.addEventListener('pointermove', (e) => {
    if (drag) return;
    const p = canvasPoint(e);
    const seed = plot.hitSeed(p.x, p.y);
    setHover(seed && !seed.locked ? seed.id : 0);
    if (seed) {
      cv.style.cursor = seed.locked ? 'default' : seed.part === 'remove' ? 'pointer' : 'move';
      return;
    }
    const hit = plot.hit(p.x, p.y);
    cv.style.cursor = hit ? CURSOR[hit.region] : 'default';
  });

  cv.addEventListener('pointerleave', () => { if (!drag) setHover(0); });

  cv.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    const p = canvasPoint(e);

    // A handle takes the pointer before the frame does: grabbing a seed is
    // never a pan, and its × is never a seed.
    const seed = plot.hitSeed(p.x, p.y);
    if (seed && !seed.locked) {
      e.preventDefault();
      closeSettings();
      if (seed.part === 'remove') { removeSeed(seed.id); return; }
      dragSeed(cv, e, p, seed.id);
      return;
    }

    const hit = plot.hit(p.x, p.y);
    if (!hit) return;
    if (pinch) return;                 // two fingers already own this gesture
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
      const rec = drag;
      drag = null;
      const q = canvasPoint(ev);
      // A press on the plane that never turned into a pan is a click, and a
      // click on the plane is where a seed goes.
      const wasPinch = pinch || performance.now() - pinchEndedAt < 400;
      if (rec && !rec.moved && !wasPinch && rec.region === 'body' && ev.type === 'pointerup') {
        placeSeedAt(q, plot.dataAt(rec.box, q.x, q.y));
      }
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
    // The first half of this gesture may have dropped a seed. Take it back -
    // and then do what a double click has always done here. One intent, one
    // outcome: the frame goes home and no seed is left behind to prove the
    // shell was confused about which gesture it was watching.
    const fresh = lastSeedAdd.id
      && performance.now() - lastSeedAdd.t < DBL_UNDO_MS
      && Math.abs(p.x - lastSeedAdd.x) <= DBL_PX
      && Math.abs(p.y - lastSeedAdd.y) <= DBL_PX;
    if (fresh) {
      removeSeed(lastSeedAdd.id);
      lastSeedAdd = { t: -1e9, x: 0, y: 0, id: 0 };
    }
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

/**
 * Drop a seed where the pointer was released - if a click there can mean a
 * state at all. With only `t–y` on the horizontal axis is time, so a click
 * names no starting point and nothing is placed; the seeds control on the
 * strip carries the reason.
 */
function placeSeedAt(px, at) {
  if (!canPlaceSeeds() || !at) return;
  const now = performance.now();
  // the second tap of a double click is the same gesture, not a second seed
  if (now - lastSeedAdd.t < ADD_SUPPRESS_MS &&
      Math.abs(px.x - lastSeedAdd.x) <= DBL_PX &&
      Math.abs(px.y - lastSeedAdd.y) <= DBL_PX) return;
  const s = addSeed(at.x, at.y);
  if (s) lastSeedAdd = { t: now, x: px.x, y: px.y, id: s.id };
}

/**
 * Drag one seed. The handle is repositioned on every pointermove and the
 * re-integration is throttled underneath it, so the curve keeps up instead of
 * flickering - the same bargain the frame gestures make with the solve.
 */
function dragSeed(cv, e, p, id) {
  draggingSeedId = id;
  hoverSeedId = id;
  const box = plot.box;
  syncSeeds();
  scheduleDraw();
  cv.style.cursor = 'grabbing';
  try { cv.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }

  const move = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    const q = canvasPoint(ev);
    const at = plot.dataAt(box, q.x, q.y);
    moveSeed(id, at.x, at.y, true);
  };

  const up = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    cv.removeEventListener('pointermove', move);
    cv.removeEventListener('pointerup', up);
    cv.removeEventListener('pointercancel', up);
    draggingSeedId = 0;
    const q = canvasPoint(ev);
    const at = plot.dataAt(box, q.x, q.y);
    // One last integration at the position the pointer actually stopped at,
    // un-throttled: the final frame is the one that has to be exact.
    moveSeed(id, at.x, at.y, false);
    cv.style.cursor = 'move';
  };

  cv.addEventListener('pointermove', move);
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
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
  // How far the integration ACTUALLY got. On a blowup this falls short of t1,
  // and it is the right edge of the curve - the window keeps its own width, so
  // the rest of it stays visibly empty rather than being back-filled with a
  // flat line or rescaled to make a partial run look complete.
  state.tEnd = isFinite(report.tEnd) ? report.tEnd : state.t1;

  // The report echoes the method it actually used, so the badge can never name
  // one that did not run. A run that gave up part-way still produced a usable
  // curve, so it reads as an observation in the muted style - not a failure.
  const stopped = report.stopped && report.stopped.message ? report.stopped : null;
  if (stopped) {
    setSolveBadge(stopped.message, 'wait');
  } else {
    setSolveBadge(report.method ? 'solved · ' + report.method : 'solved', 'ok');
  }
  el.statSolve.title = (report.method ? report.method + ' · ' : '')
    + 't ∈ [' + fmtValue(state.t0) + ', ' + fmtValue(state.tEnd) + ']'
    + (stopped ? ' of [' + fmtValue(state.t0) + ', ' + fmtValue(state.t1) + ']' : '')
    + ' · ' + got + ' samples'
    + (stopped ? ' · ' + stopped.message : '');
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
    // Where the CURVE ends, which is where the integration got to — not where
    // the window ends. On a partial run the rest of the window stays visibly
    // empty, so a blowup reads as a blowup rather than as a full-width answer.
    t1: state.tEnd,
    polar: polarMapFor(reportNames),
    extra,
    showStates: sel.states,
    showExtra: sel.extra,
  };

  // A re-solve draws inside the frame the user left. It is never moved here.
  syncFrameButtons();
  renderReadout(reportNames, endValues());
  // The equation moved, so both views of it move with it: the arrows are of
  // this right-hand side, and every seed is over this span.
  scheduleField(0);
  refreshSeeds();
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

// A deliberate inspection hook. The integration suite has to be able to ask
// what is actually on screen - which samples, over which span - because that is
// the difference between "the curve is right" and "the curve is a tenth of the
// data stretched across the width". Read-only, and named so nobody mistakes it
// for API.
globalThis.__numplaInspect = {
  frame: () => state.sol,
  window: () => plot.getWindow(),
  span: () => ({ t0: state.t0, t1: state.t1, tEnd: state.tEnd }),
  /** Replace the whole document, the way loading a demo does. */
  /** True while a debounced recompute, resolve or field query is still queued. */
  pending: () => pendingWork.recompute || pendingWork.resolve || pendingWork.field,
  setDocument: (text) => {
    clearRows();
    buildRows(String(text).split(/\r?\n/));
    ensureTail();
    scheduleRecompute(0);
  },

  /** Which views are drawable, and which are drawing. */
  views: () => ({ on: activeViews(), caps: { ...caps } }),

  /**
   * The arrows as last computed: the grid, the instant, and a generation
   * counter that ticks once per recompute - which is how the suite can tell
   * "the field followed the window" from "the field happens to look the same".
   */
  field: () => {
    const f = state.field;
    if (!f) return null;
    return { nx: f.nx, ny: f.ny, t: f.t, gen: f.gen, win: f.win, count: f.data.length / 4 };
  },

  /** Seed zero (the document's, locked) and every seed the user placed. */
  seeds: () => plot.seeds.map((s) => ({
    id: s.id, x: s.x, y: s.y, locked: !!s.locked, n: s.sol ? s.sol.n : 0,
  })),

  /** Which optional WASM calls this build actually has. */
  probe: () => ({ field: !!fieldApi, seed: !!seedApi }),

  /**
   * Swap the optional calls out. The suite uses this twice: with `null`, to
   * prove the shell degrades when `app/pkg/` predates them; and with a stub,
   * to drive the whole field/seed pipeline on a build that has not shipped
   * them yet. `null` restores whatever the real probe found.
   */
  setApis: (next) => {
    fieldApi = next && 'field' in next ? next.field : probedApis.field;
    seedApi = next && 'seed' in next ? next.seed : probedApis.seed;
    updateCapabilities(state.names);
    clearSeeds();
    scheduleField(0);
  },

  // --- the phone -----------------------------------------------------------

  /** Side by side, or one pane at a time - and which one. */
  layout: () => ({ narrow, pane, breakpoint: NARROW_MAX, width: viewportWidth() }),

  /**
   * Resize the window. The suite cannot resize a real one, and the whole
   * narrow layout hangs off this number, so it is settable - the same handler
   * the resize event runs is what reads it back.
   */
  setViewport: (w, h) => {
    if (typeof w === 'number' && w > 0) window.innerWidth = w;
    if (typeof h === 'number' && h > 0) window.innerHeight = h;
    applyLayout();
    return { narrow, pane };
  },

  /** Show the plot, or the system. Same call the segmented switch makes. */
  setPane: (name) => { setPane(name, true); return pane; },

  /** Armed or not, and what armed it. */
  touch: () => ({ on: touchMode, reason: touchReason, locked: touchLocked }),

  /**
   * Force the answer. `true` is "a finger touched the glass", `false` is "a
   * mouse user, leave the screen alone"; `null` un-locks it and re-runs the
   * capability probe, which is what a fresh page load would do.
   */
  setTouch: (on) => {
    if (on == null) {
      touchLocked = false;
      setTouchMode(coarseOnlyDevice(), 'probed');
    } else {
      touchLocked = true;
      setTouchMode(!!on, 'set by the suite');
    }
    return touchMode;
  },

  /**
   * The keyboard as it stands: open or not, which page, every key on it by id,
   * the names it is offering, and what the last "keep the row visible" pass
   * actually did - which is the only way to prove the panel is not sitting on
   * top of the row being edited.
   */
  keyboard: () => ({
    open: kbOpen,
    page: kbPage,
    height: keyboardHeight(),
    // Array.from first: a browser's querySelectorAll returns a NodeList, which
    // has no .map — only the test shim's happens to. The suite runs on the
    // shim, so without the wrap this would pass every test and throw in every
    // real browser.
    keys: el.kbGrid ? Array.from(el.kbGrid.querySelectorAll('.kbkey')).map((b) => b.dataset.k) : [],
    vars: el.kbVars ? Array.from(el.kbVars.querySelectorAll('.kbvar')).map((b) => b.textContent) : [],
    keep: kbLastKeep,
    api: {
      insert: !!(lastActiveRow && typeof lastActiveRow.field.insert === 'function'),
      command: !!(lastActiveRow && typeof lastActiveRow.field.command === 'function'),
      touchDriven: !!(lastActiveRow && 'touchDriven' in lastActiveRow.field),
    },
  }),

  /** Open or close it by hand, the way the `keys` button does. */
  setKeyboard: (on) => { if (on) openKeyboard(); else closeKeyboard(); return kbOpen; },

  /** Press one key, by id, exactly as a tap on it would. */
  press: (id) => {
    const key = keyById(id);
    if (!key) return false;
    return pressKey(key);
  },

  /** Which row the keys are typing into, by index. */
  activeRow: () => indexOfRow(lastActiveRow),

  /** The document as the compiler sees it. */
  source: () => docSource(),

  /**
   * Hide the field's command API, or give it back. `false` shadows `insert`
   * and `command` on every row so the shell sees the mathfield.js it had
   * before they landed - which is the only way to prove the keyboard still
   * types on a build that predates them. Anything else restores them.
   */
  setFieldApi: (on) => {
    for (const r of rows) {
      if (on === false) { r.field.insert = undefined; r.field.command = undefined; }
      else { delete r.field.insert; delete r.field.command; }
    }
    const f = rows[0] && rows[0].field;
    return { insert: !!(f && typeof f.insert === 'function'),
             command: !!(f && typeof f.command === 'function') };
  },
};

// Is there scheduled work that has not run yet?
//
// The integration suite used to wait a fixed number of milliseconds for each
// debounce, which passes on a fast machine and fails on a loaded CI runner -
// a test that measures the runner rather than the app. Waiting on this instead
// makes those assertions deterministic.
const pendingWork = { recompute: false, resolve: false, field: false };

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
  pendingWork.resolve = false;
  pendingWork.recompute = true;
  debounceTimer = setTimeout(() => { pendingWork.recompute = false; runRecompute(); }, delay);
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
  pendingWork.resolve = true;
  resolveTimer = setTimeout(() => {
    pendingWork.resolve = false;
    const want = spanFromFrame();
    if (!isFinite(want.t0) || !isFinite(want.t1) || want.t1 <= want.t0) return;
    if (spanUnchanged(want, { t0: state.t0, t1: state.t1 })) return;
    runRecompute();
  }, delay);
}

// ===========================================================================
// The field, and the seeds
//
// Two halves of one idea (docs/fields-and-seeds.md): an equation is a field of
// arrows, and a solution is a point dropped into it. Numpla drew only the
// second half, for the single starting point the document happened to name.
//
// Both calls are OPTIONAL. `app/pkg/` can be older than the crate, so they are
// probed exactly the way `solve_with` is - never assumed - and everything
// below degrades to "the menu says why" when they are not there.
// ===========================================================================

/** (x0, x1, y0, y1, nx, ny, t) -> Float64Array, or null if the build has none. */
let fieldApi = null;
/** (t0, t1, method, y0, n) -> Float64Array, or null if the build has none. */
let seedApi = null;
/** What the probe found, so a test that swaps them can put them back. */
let probedApis = { field: null, seed: null };

/** Bind `vector_field` off a model, camelCase or not. Null when absent. */
export function probeFieldApi(model) {
  if (!model) return null;
  const fn = typeof model.vector_field === 'function' ? 'vector_field'
           : typeof model.vectorField === 'function' ? 'vectorField'
           : null;
  if (!fn) return null;
  return (x0, x1, y0, y1, nx, ny, t) => model[fn](x0, x1, y0, y1, nx, ny, t);
}

/** Bind `trajectory_from` off a model, camelCase or not. Null when absent. */
export function probeSeedApi(model) {
  if (!model) return null;
  const fn = typeof model.trajectory_from === 'function' ? 'trajectory_from'
           : typeof model.trajectoryFrom === 'function' ? 'trajectoryFrom'
           : null;
  if (!fn) return null;
  return (t0, t1, method, y0, n) => model[fn](t0, t1, method, y0, n);
}

// ---------------------------------------------------------------------------
// The field
//
// The window is the query, so the grid follows the window: every pan and zoom
// re-asks for the arrows where you are now looking, debounced at the same
// 180 ms as the re-solve and for the same reason - a pointermove is not a
// decision. The previous arrows stay up meanwhile; they are drawn at their own
// data coordinates, so a pan slides them along with everything else and only
// the newly exposed edge is briefly bare.
//
// The grid density comes from the BOX, in pixels, per axis - see `fieldGrid`
// in plot.js, which owns the rule.
//
// A non-autonomous system has a different field at every instant. This is the
// one at the START of the window, and the canvas says so rather than implying
// the picture is timeless.
// ---------------------------------------------------------------------------

let fieldTimer = 0;
let fieldGen = 0;

/** The data box in CSS pixels - the plot's if it has drawn, else the canvas. */
function fieldBoxSize() {
  const b = plot.box;
  if (b && b.R - b.L > 8 && b.B - b.T > 8) return { w: b.R - b.L, h: b.B - b.T };
  const r = el.canvas.getBoundingClientRect();
  return { w: Math.max(80, (r.width || 900) * 0.86), h: Math.max(60, (r.height || 420) * 0.82) };
}

function clearField() {
  if (!state.field) return;
  state.field = null;
  plot.setField(null);
  scheduleDraw();
}

function computeField() {
  if (!fieldApi || !caps.field || activeViews().indexOf('field') < 0) {
    clearField();
    return;
  }
  const win = plot.getWindow();
  const size = fieldBoxSize();
  const { nx, ny } = fieldGrid(size.w, size.h);
  // The start of the window is the instant being sampled. With `t–y` off the
  // window says nothing about time, so the span that was last integrated does.
  const t = spanFromFrame().t0;

  let data = null;
  try {
    data = toF64(fieldApi(win.x0, win.x1, win.y0, win.y1, nx, ny, t));
  } catch (err) {
    console.error('[numpla] vector_field threw', err);
    data = null;
  }
  // "Empty when the document does not have exactly two states, or does not
  // compile" - a normal answer, not a failure.
  if (!data || data.length < nx * ny * 4) {
    clearField();
    return;
  }

  state.field = { nx, ny, t, data, gen: ++fieldGen, win };
  plot.setField(state.field);
  scheduleDraw();
}

function scheduleField(delay = RESOLVE_MS) {
  clearTimeout(fieldTimer);
  pendingWork.field = true;
  fieldTimer = setTimeout(() => { pendingWork.field = false; computeField(); }, Math.max(0, delay));
}

// ---------------------------------------------------------------------------
// Seeds
//
// A seed is a starting point the user put down, integrated over the same
// window in the same frame. It is a VIEW of the model and never a change to
// it: nothing here writes a row, and the document's own initial condition is
// seed zero - drawn with the same ring, given no more weight than the rest.
//
// WHAT A SEED MEANS WITH ONLY `t–y` ON. Placing one is a phase-plane idea: a
// click only names a state when both axes are states, and with `t–y` on the
// horizontal axis is time. So a seed can only be PLACED while the plane is on
// (`phase` or `field`) - and once placed it is not a phase-plane-only object.
// Its trajectory is drawn against t as well, thin, one line per state, which
// is the same starting point read the other way round.
//
// WHY DRAGGING STAYS SMOOTH. The handle follows the pointer every frame; the
// integration is THROTTLED to one every 55 ms, leading edge plus a trailing
// call so the last position is never the one that got skipped. Between them
// the previous trajectory stays on screen, drawn slightly faded, so a drag is
// a curve keeping up rather than a curve blinking out.
// ---------------------------------------------------------------------------

/** User-placed seeds, in placement order. Ids start at 1: 0 is the document. */
const seeds = [];
let seedIdSeq = 0;
let hoverSeedId = 0;
let draggingSeedId = 0;

const SEED_THROTTLE_MS = 55;

/** Can a seed exist at all? Two states, and a build that can integrate one. */
function seedsUsable() {
  return !!seedApi && caps.phase;
}

/** Is the plane - where a seed is placed and shown - on screen? */
function planeIsOn() {
  return activeViews().some((v) => PLANE_VIEWS.indexOf(v) >= 0);
}

/** Seeds may be PLACED only where a click names a state on both axes. */
function canPlaceSeeds() {
  return seedsUsable() && planeIsOn();
}

/**
 * What the plot draws: seed zero (the document's own start, locked) followed
 * by the user's, each carrying its colour slot and its live gesture state.
 */
function seedList() {
  const out = [];
  const f = state.sol;
  if (f && f.dim === 2 && f.n) {
    out.push({ id: 0, locked: true, slot: 0, x: f.data[1], y: f.data[2], sol: null });
  }
  seeds.forEach((s, i) => out.push({
    id: s.id,
    slot: i,
    x: s.x,
    y: s.y,
    sol: s.sol,
    stale: !!s.stale,
    hover: hoverSeedId === s.id,
    dragging: draggingSeedId === s.id,
  }));
  return out;
}

function syncSeeds() {
  plot.setSeeds(seedList());
  renderSeedsButton();
}

/**
 * One seed's trajectory. `trajectory_from` does not disturb the stored
 * solution, so this costs exactly its own integration and the document's curve
 * is untouched.
 */
function integrateSeed(s) {
  clearTimeout(s.timer);
  s.timer = 0;
  if (!seedsUsable()) {
    if (s.sol) { s.sol = null; s.stale = false; syncSeeds(); scheduleDraw(); }
    return;
  }
  const { t0, t1 } = spanFromFrame();
  if (!isFinite(t0) || !isFinite(t1) || t1 <= t0) return;

  const n = sampleCount();
  let data = null;
  try {
    data = toF64(seedApi(t0, t1, currentMethod, Float64Array.of(s.x, s.y), n));
  } catch (err) {
    console.error('[numpla] trajectory_from threw', err);
    return;                       // keep the last good curve exactly where it is
  }
  const stride = 3;               // [t, y0, y1] - the same layout as `sample`
  const got = Math.floor(data.length / stride);
  s.stale = false;
  // Empty is the contract's answer to a refusal or a mismatch, not a throw.
  s.sol = got > 1 ? { dim: 2, n: got, data } : null;
  syncSeeds();
  scheduleDraw();
}

/**
 * Re-integrate during a drag: at most one every 55 ms, and always one more
 * after the pointer stops. The handle itself has already moved.
 */
function seedSolveThrottled(s) {
  const now = performance.now();
  const wait = SEED_THROTTLE_MS - (now - (s.last || 0));
  clearTimeout(s.timer);
  if (wait <= 0) {
    s.last = now;
    integrateSeed(s);
    return;
  }
  s.stale = true;                 // the curve on screen is one step behind
  s.timer = setTimeout(() => { s.last = performance.now(); integrateSeed(s); }, wait);
}

/** Every seed, over the current span. Called whenever the model or span moves. */
function refreshSeeds() {
  if (!seeds.length) { syncSeeds(); return; }
  for (const s of seeds) integrateSeed(s);
  syncSeeds();
}

function addSeed(x, y) {
  if (!isFinite(x) || !isFinite(y)) return null;
  const s = { id: ++seedIdSeq, x, y, sol: null, stale: false, timer: 0, last: 0 };
  seeds.push(s);
  hoverSeedId = s.id;
  integrateSeed(s);
  syncSeeds();
  scheduleDraw();
  return s;
}

function seedById(id) {
  return seeds.find((s) => s.id === id) || null;
}

function moveSeed(id, x, y, live) {
  const s = seedById(id);
  if (!s || !isFinite(x) || !isFinite(y)) return;
  s.x = x;
  s.y = y;
  syncSeeds();
  scheduleDraw();                 // the handle keeps up with the pointer
  if (live) seedSolveThrottled(s); else integrateSeed(s);
}

function removeSeed(id) {
  const i = seeds.findIndex((s) => s.id === id);
  if (i < 0) return false;
  clearTimeout(seeds[i].timer);
  seeds.splice(i, 1);
  if (hoverSeedId === id) hoverSeedId = 0;
  if (draggingSeedId === id) draggingSeedId = 0;
  syncSeeds();
  scheduleDraw();
  return true;
}

function clearSeeds() {
  if (!seeds.length) { syncSeeds(); return; }
  for (const s of seeds) clearTimeout(s.timer);
  seeds.length = 0;
  hoverSeedId = 0;
  draggingSeedId = 0;
  syncSeeds();
  scheduleDraw();
}

/**
 * The seeds control on the strip. With none placed it is the only place that
 * says the gesture exists; with some placed it is how they all go away.
 */
/** Why a seed can or cannot be placed right now, in one sentence. */
function seedsWhy() {
  if (!seedApi) return 'this WASM build has no trajectory_from — rebuild the WASM';
  if (!caps.phase) return 'a seed is a point in the plane — this document needs exactly 2 states';
  if (!planeIsOn()) {
    return 'seeds are a phase-plane idea — turn on phase or field, then click the plane';
  }
  return 'click the plane to drop a starting point';
}

function renderSeedsButton() {
  const btn = el.seedsBtn;
  if (!btn) return;
  const n = seeds.length;
  btn.textContent = n ? 'seeds · ' + n + ' ×' : 'seeds';
  btn.classList.toggle('is-live', n > 0);
  btn.setAttribute('aria-disabled', n ? 'false' : 'true');
  // The count never displaces the reason: with the plane off, the seeds still
  // on screen are exactly when someone needs to be told where to put the next
  // one.
  btn.title = n
    ? 'Remove all ' + n + ' seed' + (n === 1 ? '' : 's') + ' · ' + seedsWhy()
    : seedsWhy();
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
// THE NARROW LAYOUT - a switch, not a horizontal divider
//
// Below 720px the two panes stop being side by side. The spec offered a
// horizontal divider or a segmented switch; this is the switch, and the reason
// is arithmetic.
//
// A phone viewport is about 640 CSS pixels tall. Take the top bar (52) and the
// math keyboard (about 348 while it is up, because 44px keys and five rows of
// them is what the touch rule costs) and 240 are left to divide. Split that and
// the plot gets 120px - and the plot's height is not decoration here,
// because THE WINDOW IS THE QUERY: a 140px-tall frame is a worse question to
// ask the solver, and a 140px-tall row list shows two equations. A divider
// would only let you choose which of the two to make unusable.
//
// Three more reasons the drag loses:
//
//   - the surface directly under the divider is a pan/pinch surface. A drag
//     handle sitting on top of one is a gesture ambiguity on every touch.
//   - a 44px grab strip is 7% of the screen spent on a control that does
//     nothing but resize.
//   - a thumb cannot place a divider precisely, and the two useful positions
//     are "all of it" and "all of the other one" - which is a switch.
//
// So: both panes occupy the same grid cell and exactly one is visible. Hidden
// with `visibility`, never `display`, so the canvas keeps its real size and
// coming back to it does not have to re-measure, re-sample and re-solve.
// ---------------------------------------------------------------------------

const NARROW_MAX = 720;
let narrow = false;
let pane = 'plot';         // 'plot' | 'system' - only meaningful while narrow

function viewportWidth() {
  const w = typeof window !== 'undefined' ? window.innerWidth : 0;
  return typeof w === 'number' && w > 0 ? w : 1024;
}

function viewportHeight() {
  const h = typeof window !== 'undefined' ? window.innerHeight : 0;
  return typeof h === 'number' && h > 0 ? h : 768;
}

/** Which pane is on screen. Ignored while the panes are side by side. */
function setPane(next, fromUser) {
  pane = next === 'system' ? 'system' : 'plot';
  document.body.classList.toggle('pane-plot', pane === 'plot');
  document.body.classList.toggle('pane-system', pane === 'system');
  for (const btn of [el.tabPlot, el.tabSystem]) {
    if (!btn) continue;
    const on = btn.dataset.pane === pane;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  if (pane === 'plot') {
    // Leaving the document behind means leaving its keyboard behind too.
    if (fromUser) closeKeyboard();
    scheduleDraw();
    scheduleField();
  }
}

function applyLayout() {
  const next = viewportWidth() <= NARROW_MAX;
  if (next !== narrow) {
    narrow = next;
    document.body.classList.toggle('is-narrow', narrow);
    // Side by side again: both panes are on screen, so the switch is moot and
    // whatever it last said must not keep one of them hidden.
    setPane(narrow ? pane : 'plot', false);
    closeSettings();
    closeViews();
    scheduleDraw();
    scheduleField();
  }
  syncKeyboardAffordances();
  return narrow;
}

// ---------------------------------------------------------------------------
// IS THIS A FINGER?
//
// Getting this wrong in the permissive direction costs a desktop user a third
// of their screen, so the panel arms on evidence, not on a guess:
//
//   1. CAPABILITY, but only the unambiguous kind. `(pointer: coarse)` alone
//      says "the primary pointer is a finger"; a touchscreen laptop reports
//      coarse for its screen while its owner is on the trackpad. So the panel
//      arms at boot only when the device ALSO has no fine pointer at all
//      (`(any-pointer: fine)` does not match) - a phone or a tablet, with no
//      mouse anywhere.
//
//   2. EVIDENCE. On everything else - a Surface, a touchscreen monitor - the
//      first pointerdown whose `pointerType` is `touch` or `pen` arms it. A
//      hybrid user gets the panel the moment a finger actually touches the
//      glass, and never before.
//
//   3. IT UNARMS. A real keydown carrying a character, while a row has the
//      caret, means a physical keyboard is present and being used - an iPad
//      with a case, say. The panel goes away and stops arming itself for the
//      rest of the session.
//
//   4. IT IS ALWAYS REACHABLE. The `keys` button in the issue bar opens it by
//      hand, on any device. Nothing here is a trap in either direction.
//
// The media queries are only ever consulted through matchMedia when it exists,
// so an engine without it simply falls back on (2) and (4).
// ---------------------------------------------------------------------------

let touchMode = false;
let touchReason = 'none';
let touchLocked = false;      // a keydown proved a real keyboard, or the user chose

function mediaMatches(query) {
  try {
    if (typeof window.matchMedia !== 'function') return false;
    const mq = window.matchMedia(query);
    return !!(mq && mq.matches);
  } catch (err) {
    return false;
  }
}

/** A coarse primary pointer AND no fine pointer anywhere on the device. */
function coarseOnlyDevice() {
  return mediaMatches('(pointer: coarse)') && !mediaMatches('(any-pointer: fine)');
}

function setTouchMode(on, reason) {
  const next = !!on;
  if (reason) touchReason = reason;
  if (next === touchMode) return;
  touchMode = next;
  document.body.classList.toggle('is-touch', touchMode);
  plot.setTouch(touchMode);
  for (const row of rows) {
    try { row.field.touchDriven = touchMode; } catch (err) { /* older field */ }
  }
  if (!touchMode) closeKeyboard();
  syncKeyboardAffordances();
  scheduleDraw();
}

function armTouch(reason) {
  if (touchLocked || touchMode) return;
  setTouchMode(true, reason);
  if (lastActiveRow) openKeyboard();
}

function wireTouchDetection() {
  if (coarseOnlyDevice()) setTouchMode(true, 'coarse-only device');

  // Capture, and on the window, so it is seen whatever the target was.
  window.addEventListener('pointerdown', (e) => {
    if (e && (e.pointerType === 'touch' || e.pointerType === 'pen')) {
      armTouch('a finger touched the screen');
    }
  }, true);
  window.addEventListener('touchstart', () => armTouch('a finger touched the screen'), true);

  // A physical keyboard, being used. That person does not want this panel.
  document.addEventListener('keydown', (e) => {
    if (!touchMode || !e || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const typing = typeof k === 'string' && (k.length === 1 || k === 'Backspace' || k === 'Enter');
    if (!typing) return;
    const t = e.target;
    if (t && typeof t.closest === 'function' && t.closest('.mathkb')) return;
    touchLocked = true;
    setTouchMode(false, 'a physical keyboard was used');
  }, true);
}

// ---------------------------------------------------------------------------
// THE MATH KEYBOARD
//
// A phone keyboard cannot write mathematics: `^`, a radical, a fraction bar and
// a prime are all several taps deep behind a symbols page, if they are there at
// all. So this replaces it outright.
//
// It drives the focused row through MathField's command API and NOTHING else:
//
//     field.insert(text)     types text, inflating structure
//     field.command(name)    one editing command
//
// No synthetic key events, no hidden <input> to keep in sync - a tap and a
// keystroke reach the model through one path, so the two cannot drift.
//
// That API arrived in mathfield.js separately, so everything here is PROBED,
// exactly the way `vector_field` and `trajectory_from` are: when the methods
// are absent the same operations are performed through the model the field has
// always exposed (`field.model`), followed by the render and the onChange the
// field would have fired itself. The keys work either way; the path they take
// is the only difference.
//
// STRUCTURE KEYS INSERT STRUCTURE. `√` does not type four letters: it inflates
// a radical and leaves the caret inside it, because that is what typing `sqrt`
// does. The fraction key is the ÷ key - in this notation they are one thing,
// so there is one key and it is drawn as a fraction.
// ---------------------------------------------------------------------------

const KB_REPEAT_DELAY = 380;   // before a held key starts repeating
const KB_REPEAT_MS = 55;       // and how fast it goes once it does
const KB_HEIGHT = 348;         // fallback for --kb-h in styles.css

let kbOpen = false;
let kbPage = '123';
let kbLastKeep = null;         // what the last "keep the row visible" pass did
let kbRepeatTimer = 0;
let kbRepeatKey = null;

/**
 * One key. `ins` is typed through insert(); `cmd` is a command name; `act` is
 * something only the shell can do (a new row, a page change, hiding).
 * `rep` marks the keys that repeat while they are held.
 */
const K = (id, label, spec) => ({ id, label, ...spec });

const KB_MAIN = [
  [K('7', '7', { ins: '7' }), K('8', '8', { ins: '8' }), K('9', '9', { ins: '9' }),
    K('frac', '▫⁄▫', { cmd: 'frac', cls: 'kbkey--struct', title: 'fraction — the ÷ of this notation' }),
    K('lparen', '(', { ins: '(' }), K('rparen', ')', { ins: ')' })],

  [K('4', '4', { ins: '4' }), K('5', '5', { ins: '5' }), K('6', '6', { ins: '6' }),
    K('times', '×', { ins: '*', title: 'multiply' }),
    K('sup', '▫˄', { cmd: 'sup', cls: 'kbkey--struct', title: 'exponent' }),
    K('sqrt', '√', { cmd: 'sqrt', cls: 'kbkey--struct', title: 'radical' })],

  [K('1', '1', { ins: '1' }), K('2', '2', { ins: '2' }), K('3', '3', { ins: '3' }),
    K('minus', '−', { ins: '-', title: 'minus' }),
    K('prime', '′', { cmd: 'prime', cls: 'kbkey--struct', title: "prime — x' is dx/dt" }),
    K('comma', ',', { ins: ',' })],

  [K('0', '0', { ins: '0' }), K('dot', '.', { ins: '.' }), K('eq', '=', { ins: '=' }),
    K('plus', '+', { ins: '+' }),
    K('backspace', '⌫', { cmd: 'backspace', rep: true, span: 2, cls: 'kbkey--edit' })],

  [K('left', '←', { cmd: 'left', rep: true, cls: 'kbkey--nav' }),
    K('right', '→', { cmd: 'right', rep: true, cls: 'kbkey--nav' }),
    K('up', '↑', { cmd: 'up', rep: true, cls: 'kbkey--nav' }),
    K('down', '↓', { cmd: 'down', rep: true, cls: 'kbkey--nav' }),
    K('newrow', '↵', { act: 'newrow', span: 2, cls: 'kbkey--go', title: 'a new row below' })],
];

/** The rest of the alphabet, without leaving the panel. */
const KB_ALPHA = (() => {
  const letters = 'abcdefghijklmnopqrstuvwx'.split('');
  const grid = [];
  for (let i = 0; i < letters.length; i += 6) {
    grid.push(letters.slice(i, i + 6).map((c) => K(c, c, { ins: c })));
  }
  grid.push([
    K('y', 'y', { ins: 'y' }), K('z', 'z', { ins: 'z' }),
    K('sub', '▫ˍ', { cmd: 'sub', cls: 'kbkey--struct', title: 'subscript — k_1' }),
    K('backspace2', '⌫', { cmd: 'backspace', rep: true, cls: 'kbkey--edit' }),
    K('left2', '←', { cmd: 'left', rep: true, cls: 'kbkey--nav' }),
    K('right2', '→', { cmd: 'right', rep: true, cls: 'kbkey--nav' }),
  ]);
  return grid;
})();

/**
 * Everything the engine answers to by name, three to a row. Pressing one
 * inflates the call and drops the caret between its parentheses, then hands
 * the panel back to the digits - because the next thing wanted is an argument.
 */
const KB_FUNCS = [
  ['sin', 'cos', 'tan'],
  ['arcsin', 'arccos', 'arctan'],
  ['sinh', 'cosh', 'tanh'],
  ['ln', 'log', 'exp'],
  ['sqrt', 'abs', 'sign'],
  ['min', 'max', 'mod'],
  ['floor', 'ceil', 'round'],
  ['pi', 'tau', 'inf'],
  ['white', 'pink', 'brown'],
  ['blue', 'smooth', 'telegraph'],
  ['rand', 'randn'],
].map((r) => r.map((name) => K('fn-' + name, name, {
  ins: name, act: 'fn', cls: 'kbkey--fn', title: name,
})));

/** The letters `x y t` always, and whatever this document already calls things. */
function keyboardNames() {
  const seen = new Set();
  const out = [];
  const push = (name, kind) => {
    const n = String(name == null ? '' : name).trim();
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push({ name: n, kind });
  };

  // Probed, the way everything optional here is: the field publishes what the
  // document defines, and a build that does not yet is not an error - `x y t`
  // is a working keyboard on its own.
  let names = null;
  try {
    const f = lastActiveRow && lastActiveRow.field;
    const d = f && f.documentNames;
    if (d && typeof d === 'object') names = d;
  } catch (err) {
    names = null;
  }
  if (!names) names = docNames();

  for (const n of (names.states || [])) push(n, 'state');
  for (const n of (names.params || [])) push(n, 'param');
  for (const n of (names.functions || [])) push(n, 'func');
  for (const n of ['x', 'y', 't']) push(n, 'state');
  return out;
}

function kbButton(key) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'kbkey' + (key.cls ? ' ' + key.cls : '');
  b.dataset.k = key.id;
  b.textContent = key.label;
  if (key.span) b.style.gridColumn = 'span ' + key.span;
  b.setAttribute('aria-label', key.title || key.label || key.id);
  if (key.title) b.title = key.title;
  bindKey(b, key);
  return b;
}

function kbChip(key, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.dataset.k = key.id;
  b.dataset.name = key.ins || '';
  b.textContent = key.label;
  b.setAttribute('aria-label', key.title || key.label);
  if (key.title) b.title = key.title;
  bindKey(b, key);
  return b;
}

/** The name row: the document's own vocabulary, plus x y t and the constants. */
function renderKeyboardVars() {
  if (!el.kbVars) return;
  const names = keyboardNames();
  const sig = names.map((n) => n.kind + ':' + n.name).join(',');
  if (el.kbVars.dataset.sig === sig) return;
  el.kbVars.dataset.sig = sig;
  el.kbVars.innerHTML = '';
  for (const n of names) {
    el.kbVars.appendChild(kbChip(
      K('var-' + n.name, n.name, { ins: n.name, title: n.name }),
      'kbvar kbvar--' + n.kind
    ));
  }
  // π and e ride the same row: this is where a symbol you want by NAME lives.
  // Both are the engine's own constants (`constant()` in
  // crates/numpla-expr/src/eval.rs) - the same `pi` and `e` the reference
  // panel documents, so the key and the reference cannot disagree about what
  // the letter means.
  el.kbVars.appendChild(kbChip(
    K('pi', 'π', { ins: 'pi', title: 'pi' }), 'kbvar kbvar--const'
  ));
  el.kbVars.appendChild(kbChip(
    K('euler', 'e', { ins: 'e', title: "Euler's number" }), 'kbvar kbvar--const'
  ));
}

function renderKeyboardGrid() {
  if (!el.kbGrid) return;
  const grid = kbPage === 'abc' ? KB_ALPHA : kbPage === 'fn' ? KB_FUNCS : KB_MAIN;
  el.kbGrid.innerHTML = '';
  el.kbGrid.dataset.page = kbPage;
  el.kbGrid.className = 'mathkb__grid mathkb__grid--' + kbPage;
  for (const rowKeys of grid) {
    for (const key of rowKeys) el.kbGrid.appendChild(kbButton(key));
  }
  for (const btn of el.kbPages) {
    if (!btn) continue;
    const on = btn.dataset.page === kbPage;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
}

function setKeyboardPage(page) {
  const next = page === 'abc' || page === 'fn' ? page : '123';
  if (next === kbPage) return;
  kbPage = next;
  renderKeyboardGrid();
}

// --- the bridge to the field ----------------------------------------------

/** The row a key acts on: whichever one last had the caret. */
function targetRow() {
  if (lastActiveRow && indexOfRow(lastActiveRow) >= 0) return lastActiveRow;
  ensureTail();
  return rows[rows.length - 1] || null;
}

/** A caret fingerprint, for telling "the command moved it" from "it did not". */
function caretSig(field) {
  try {
    const st = field && field.model && field.model.st;
    if (!st) return null;
    return JSON.stringify(st.path) + '@' + st.index;
  } catch (err) {
    return null;
  }
}

/** Render, then fire onChange the way the field does when a key is pressed. */
function applyFallback(field, changed) {
  try {
    if (typeof field.render === 'function') field.render();
  } catch (err) {
    console.error('[numpla] field.render threw', err);
  }
  if (changed && field.opts && typeof field.opts.onChange === 'function') {
    try { field.opts.onChange(field); } catch (err) { console.error('[numpla] onChange threw', err); }
  }
  return !!changed;
}

/**
 * Type text into a row. `field.insert` when the field has it; otherwise the
 * same operation through the model, which is what `insert` is built on.
 */
function fieldInsert(field, text) {
  if (!field) return false;
  if (typeof field.insert === 'function') {
    try {
      return field.insert(text) !== false;
    } catch (err) {
      console.error('[numpla] field.insert threw', err);
      return false;
    }
  }
  if (!field.model || typeof field.model.type !== 'function') return false;
  return applyFallback(field, field.model.type(text));
}

/** The model-level stand-in for each command, for a field with no command(). */
const KB_FALLBACK = {
  frac:      (m) => m.type('/'),
  sup:       (m) => m.type('^'),
  sub:       (m) => m.type('_'),
  sqrt:      (m) => m.type('sqrt'),
  prime:     (m) => m.type("'"),
  backspace: (m) => m.backspace(),
  delete:    (m) => m.del(),
  home:      (m) => { m.home(); return false; },
  end:       (m) => { m.end(); return false; },
};

const KB_NAV = ['left', 'right', 'up', 'down'];

/**
 * One arrow. The caret moves inside the row if it can, and walks into the
 * neighbouring row if it cannot - which is exactly what the arrow keys do on a
 * desktop, and it has to be ONE behaviour rather than two.
 */
function fieldNavigate(row, dir) {
  const field = row.field;
  navHandled = false;
  let moved = false;
  if (typeof field.command === 'function') {
    const before = caretSig(field);
    try { field.command(dir); } catch (err) { console.error('[numpla] field.command threw', err); }
    moved = before === null ? true : before !== caretSig(field);
  } else if (field.model) {
    const m = field.model;
    moved = !!(dir === 'left' ? m.left() : dir === 'right' ? m.right()
      : dir === 'up' ? m.up() : m.down());
    applyFallback(field, false);
  }
  // navHandled: the field may have walked out of its own edge already, by
  // calling onNavigate - which IS navigate(). Moving again would skip a row.
  if (!moved && !navHandled) navigate(row, dir);
  navHandled = false;
  return true;
}

function fieldCommand(field, name, row) {
  if (!field) return false;
  if (KB_NAV.indexOf(name) >= 0) return fieldNavigate(row, name);
  if (typeof field.command === 'function') {
    try { field.command(name); return true; } catch (err) { console.error('[numpla] field.command threw', err); return false; }
  }
  const fn = KB_FALLBACK[name];
  if (!fn || !field.model) return false;
  return applyFallback(field, fn(field.model));
}

// --- pressing a key --------------------------------------------------------

function pressKey(key) {
  if (!key) return false;

  if (key.act === 'page') { setKeyboardPage(key.page); return true; }
  if (key.act === 'hide') { closeKeyboard(); return true; }

  const row = targetRow();
  if (!row) return false;

  // The panel never takes the caret (every key preventDefaults its
  // pointerdown), but a row can lose it some other way - a demo load, say.
  try {
    if (row.field && !row.field.focused && typeof row.field.focus === 'function') {
      row.field.focus();
    }
  } catch (err) { /* focus is best effort */ }

  let handled = false;
  if (key.act === 'newrow') {
    insertAfter(row);
    handled = true;
  } else if (key.cmd) {
    handled = fieldCommand(row.field, key.cmd, row);
  } else if (key.ins != null) {
    handled = fieldInsert(row.field, key.ins);
    // A function name wants its argument next, and an argument is digits.
    if (key.act === 'fn') setKeyboardPage('123');
  }

  keepRowVisible(targetRow());
  return handled;
}

function stopRepeat() {
  if (kbRepeatTimer) clearTimeout(kbRepeatTimer);
  kbRepeatTimer = 0;
  kbRepeatKey = null;
}

/**
 * Hold-to-repeat, for backspace and the arrows. A pause first, so a deliberate
 * single tap can never turn into two.
 */
function beginRepeat(key) {
  stopRepeat();
  if (!key.rep) return;
  kbRepeatKey = key;
  const tick = () => {
    if (!kbRepeatKey) return;
    pressKey(kbRepeatKey);
    kbRepeatTimer = setTimeout(tick, KB_REPEAT_MS);
  };
  kbRepeatTimer = setTimeout(tick, KB_REPEAT_DELAY);
}

/**
 * A key is driven by `pointerdown`, not `click`: it has to fire under the
 * finger, it must not move focus out of the row, and a held key repeats.
 * `click` is still wired, for the Tab-and-Enter path, guarded so a real tap -
 * which produces both events - only ever counts once.
 */
/**
 * Every key that has been bound to a button, by id. The inspection hook presses
 * keys through this, so the suite drives the same objects the fingers do rather
 * than a parallel table that could disagree with the panel on screen.
 */
const kbRegistry = new Map();

for (const grid of [KB_MAIN, KB_ALPHA, KB_FUNCS]) {
  for (const rowKeys of grid) for (const key of rowKeys) kbRegistry.set(key.id, key);
}

/** One key by id, or null. */
function keyById(id) {
  return kbRegistry.get(String(id)) || null;
}

function bindKey(btn, key) {
  kbRegistry.set(key.id, key);
  // Per BUTTON, not per panel: a tap on one key must not swallow a click on
  // another one a moment later.
  let downAt = -1e9;
  btn.addEventListener('pointerdown', (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    downAt = performance.now();
    btn.classList.add('is-down');
    pressKey(key);
    beginRepeat(key);
  });
  const release = () => { btn.classList.remove('is-down'); stopRepeat(); };
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('pointerleave', release);
  btn.addEventListener('click', (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (performance.now() - downAt < 700) return;   // this key's tap already ran
    pressKey(key);
  });
  // mousedown too: a preventDefault on pointerdown does not stop the mouse
  // compatibility event, and that one is what would blur the row.
  btn.addEventListener('mousedown', (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
  });
}

// --- opening, closing, and keeping the row in sight ------------------------

function keyboardHeight() {
  if (!kbOpen) return 0;
  const h = el.kb ? el.kb.offsetHeight : 0;
  return h > 0 ? h : KB_HEIGHT;
}

/**
 * THE PANEL MUST NOT COVER THE ROW BEING EDITED.
 *
 * The row list is its own scroller and the panel is fixed to the bottom of the
 * viewport, so this is one subtraction: the visible bottom of the list is the
 * lower of the list's own bottom and the top of the panel, and the focused row
 * has to sit above it. Nothing is resized and nothing is reflowed - only
 * `scrollTop` moves, which is what a scroller is for. The list carries an
 * extra `--kb-pad` of bottom padding while the panel is up, so the LAST row can
 * still reach the top of it.
 */
function keepRowVisible(row) {
  if (!kbOpen || !row || !row.el) return null;
  const scroller = el.rows;
  if (!scroller || typeof scroller.getBoundingClientRect !== 'function') return null;
  let r, sr;
  try {
    r = row.el.getBoundingClientRect();
    sr = scroller.getBoundingClientRect();
  } catch (err) {
    return null;
  }
  const kbTop = viewportHeight() - keyboardHeight();
  const bottom = Math.min(sr.bottom, kbTop) - 10;
  const top = sr.top + 6;
  let dy = 0;
  if (r.bottom > bottom) dy = r.bottom - bottom;
  else if (r.top < top) dy = r.top - top;
  if (dy) scroller.scrollTop = Math.max(0, (scroller.scrollTop || 0) + dy);
  kbLastKeep = { dy, top, bottom, kbTop, scrollTop: scroller.scrollTop || 0 };
  return kbLastKeep;
}

function openKeyboard() {
  if (!el.kb) return;
  if (kbOpen) { keepRowVisible(targetRow()); return; }
  kbOpen = true;
  el.kb.hidden = false;
  document.body.classList.add('kb-open');
  if (el.kbOpen) el.kbOpen.setAttribute('aria-expanded', 'true');
  renderKeyboardVars();
  renderKeyboardGrid();
  syncKeyboardAffordances();
  keepRowVisible(targetRow());
}

function closeKeyboard() {
  stopRepeat();
  if (!el.kb || !kbOpen) { syncKeyboardAffordances(); return; }
  kbOpen = false;
  el.kb.hidden = true;
  document.body.classList.remove('kb-open');
  if (el.kbOpen) el.kbOpen.setAttribute('aria-expanded', 'false');
  syncKeyboardAffordances();
}

function toggleKeyboard() {
  if (kbOpen) { closeKeyboard(); return; }
  // Asking for it by hand is a decision: honour it even on a mouse, and stop
  // second-guessing the pointer afterwards.
  touchLocked = true;
  if (!touchMode) setTouchMode(true, 'the keys button was pressed');
  const row = targetRow();
  if (row && row.field && typeof row.field.focus === 'function') {
    try { row.field.focus(); } catch (err) { /* best effort */ }
  }
  openKeyboard();
}

/** The `keys` button exists only where the panel could be wanted. */
function syncKeyboardAffordances() {
  if (el.kbOpen) el.kbOpen.hidden = !(touchMode || narrow) || kbOpen;
}

/**
 * A row lost the caret. If it went somewhere that is not another row and not
 * the panel itself - the demos button, the reference, the plot - then nothing
 * is being edited any more and the panel has no business covering the screen.
 * Deferred by a tick, because "lost it" and "the next one gained it" are two
 * events and only the second one is the truth.
 */
function onRowBlurred() {
  if (!kbOpen) return;
  setTimeout(() => {
    if (!kbOpen) return;
    const a = document.activeElement;
    if (a && typeof a.closest === 'function' && a.closest('.mathkb')) return;
    if (rows.some((r) => r.field && r.field.focused)) return;
    closeKeyboard();
  }, 0);
}

/** A row took the caret. */
function onRowFocused(row) {
  if (narrow && pane !== 'system') setPane('system', false);
  if (touchMode) openKeyboard();
  else keepRowVisible(row);
}

function wireKeyboard() {
  if (!el.kb) return;
  for (const btn of el.kbPages) {
    if (!btn) continue;
    bindKey(btn, K('page-' + btn.dataset.page, btn.textContent, {
      act: 'page', page: btn.dataset.page,
    }));
  }
  if (el.kbHide) bindKey(el.kbHide, K('hide', '', { act: 'hide' }));
  if (el.kbOpen) {
    el.kbOpen.addEventListener('click', (e) => { e.preventDefault(); toggleKeyboard(); });
  }

  // The panel's own background is not a place to lose the caret either.
  el.kb.addEventListener('mousedown', (e) => {
    if (e.target === el.kb && typeof e.preventDefault === 'function') e.preventDefault();
  });

  renderKeyboardVars();
  renderKeyboardGrid();
}

function wireNarrow() {
  for (const btn of [el.tabPlot, el.tabSystem]) {
    if (!btn) continue;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      setPane(btn.dataset.pane, true);
      if (btn.dataset.pane === 'system' && touchMode && lastActiveRow) openKeyboard();
    });
  }
  if (typeof window.matchMedia === 'function') {
    try {
      const mq = window.matchMedia('(max-width: ' + NARROW_MAX + 'px)');
      if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', applyLayout);
    } catch (err) { /* an engine without it falls back on the resize handler */ }
  }
  applyLayout();
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
  wireNarrow();               // the breakpoint and the pane switch
  wireTouchDetection();       // is this a finger? - and only then
  wireKeyboard();             // the panel that replaces the OS keyboard

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

  if (el.seedsBtn) {
    el.seedsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      clearSeeds();
    });
  }
  renderSeedsButton();

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
    // The grid density is read off the box, so a resized box is a new query.
    const ro = new ResizeObserver(() => { scheduleDraw(); scheduleField(); });
    document.querySelectorAll('.plot__canvas').forEach((n) => ro.observe(n));
  }

  window.addEventListener('resize', () => {
    closeSettings();
    closeViews();
    if (!el.info.hidden) positionInfo();
    setDocWidth(docWidth, false);   // re-clamp; the user's choice is kept
    applyLayout();                  // side by side, or one pane at a time
    keepRowVisible(lastActiveRow);  // the keyboard may now cover a different row
    scheduleDraw();
    scheduleField();
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
    probedApis = { field: probeFieldApi(model), seed: probeSeedApi(model) };
    fieldApi = probedApis.field;
    seedApi = probedApis.seed;
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
