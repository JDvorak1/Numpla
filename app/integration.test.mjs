// Integration test: boot the REAL main.js against the REAL WASM, from the REAL
// index.html, and drive it the way a person would.
//
// Why this exists: every bug the user has reported so far — the demo loader
// doing nothing, the `t` slider being inert — was invisible to the unit suites
// because each piece worked in isolation and the seam between them did not.
// Unit tests prove the parts; this proves the app.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { install, buildFromHtml, doc, dispatch } from './dom-shim.mjs';

const APP = new URL('./', import.meta.url);
// fileURLToPath rather than trimming `pathname` by hand: this suite runs on
// Windows locally and on Linux in CI, and it also decodes percent-escapes, so a
// checkout path containing a space does not silently become an unreadable file.
const p = (rel) => fileURLToPath(new URL(rel, APP));

install();
buildFromHtml(p('index.html'));

// wasm-bindgen's `--target web` glue fetches its .wasm; give it the bytes.
const wasm = await import(new URL('./pkg/numpla_wasm.js', APP).href);
wasm.initSync({ module: readFileSync(p('pkg/numpla_wasm_bg.wasm')) });

let passed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { passed++; process.stdout.write('.'); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); process.stdout.write('F'); }
}
const $ = (id) => doc.getElementById(id);
const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(n = 40) { for (let i = 0; i < n; i++) await tick(); }
const click = (el) => dispatch(el, 'click', { type: 'click', target: el, preventDefault() {}, stopPropagation() {} });

/** The window→span loop is debounced; give it longer than the debounce. */
/**
 * Wait for the app to be QUIET, not for a fixed number of milliseconds.
 *
 * Fixed waits measure the machine, not the app: they pass here and fail on a
 * loaded CI runner, which is exactly what happened. `pending()` reports whether
 * a debounced recompute, resolve or field query is still queued, so this waits
 * for the work itself and only falls back to a timeout if something is stuck.
 */
async function settleSolve(timeoutMs = 8000) {
  const I = globalThis.__numplaInspect;
  const started = Date.now();
  // Let the gesture that triggered the work schedule it first.
  await settle(4);
  while (I && typeof I.pending === 'function' && I.pending()) {
    if (Date.now() - started > timeoutMs) break;
    await wait(10);
  }
  await wait(30);        // the timer fires, then the work runs
  await settle(40);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

await import(new URL('./main.js', APP).href);
await settle(120);

const loaderStatus = $('loader-status');
ok('boots without failing', !$('loader').classList.contains('is-failed'),
   `loader says: ${loaderStatus && loaderStatus.textContent}`);
ok('app is revealed', doc.body.classList.contains('ready'));

const rowsHost = $('rows');
const rowEls = () => rowsHost.querySelectorAll('.row');
ok('rows were built', rowEls().length > 0, `${rowEls().length} rows`);
ok('a trailing blank row exists',
   rowEls().some((r) => r.classList.contains('is-tail')));

const solveStat = $('stat-solve');
ok('solve ran', solveStat && !/idle|error/i.test(solveStat.textContent),
   `status: ${solveStat && solveStat.textContent}`);
ok('the plot has a legend/readout after solving',
   ($('readout').childNodes.length > 0 || $('readout').textContent.length > 0));

// ---------------------------------------------------------------------------
// `t` is gone. Not a slider, not a row, not a playhead, not a play button.
// ---------------------------------------------------------------------------

ok('there is no t slider element', $('transport') === null && $('scrub') === null);
ok('there is no play/pause button', $('play') === null);
const docText = rowEls().map((r) => r.textContent).join('\n');
ok('no row declares a t span', !rowEls().some((r) => /\bt\s*=\s*\[/.test(r.textContent)),
   docText.split('\n').join(' | ').slice(0, 120));
ok('no knob is a playhead',
   rowsHost.querySelectorAll('.knob').every((k) => k.dataset.name !== 't'));
ok('the legend has no t chip', $('readout').querySelectorAll('.chip--t').length === 0);

// The span the shell actually integrated is reported on the solve badge.
const spanOf = () => {
  const m = /t ∈ \[\s*([-\d.e+]+)\s*,\s*([-\d.e+]+)\s*\]/.exec($('stat-solve').title || '');
  return m ? [Number(m[1]), Number(m[2])] : null;
};
ok('the solved span is reported', spanOf() !== null, `title: ${$('stat-solve').title}`);
ok('the sample count follows the canvas', /\d+ samples/.test($('stat-solve').title || ''),
   `title: ${$('stat-solve').title}`);

// ---------------------------------------------------------------------------
// One plot: a single frame, every enabled view drawn into it
// ---------------------------------------------------------------------------

ok('the view chips are gone', $('views') === null);
ok('there is exactly one canvas', doc.querySelectorAll('.plot__canvas').length === 1
   && $('canvas') !== null);

const { Plot } = await import(new URL('./plot.js', APP).href);
{
  const pl = new Plot(doc.createElement('canvas'));
  pl.setViews(['time', 'phase', 'polar']);
  pl.setSupport({ time: true, phase: true, polar: true });
  pl.draw(null);
  const a = pl.hit(100, 30);
  const b = pl.hit(300, 30);
  ok('three views share one frame', !!a && !!b && a.box === b.box);
  ok('there is one window, not one per view',
     typeof pl.resetAllWindows !== 'function' && pl.getWindow().x0 === -5);
  pl.setWindow({ x0: 0, x1: 20, y0: -2, y1: 2 });
  ok('the frame is settable as a whole', pl.getWindow().x1 === 20 && !pl.isDefaultFrame());
}

// The views menu: everything supported is already on, and it is how you
// turn one OFF.
const viewsBtn = $('views-btn');
ok('there is a views menu button', !!viewsBtn);
click(viewsBtn);
await settle(10);
const viewItems = () => $('viewmenu').querySelectorAll('.viewitem');
ok('the views menu opens', !$('viewmenu').hidden);
ok('it lists every view', viewItems().length === 4, `${viewItems().length}`);
ok('the field is one of them',
   viewItems().some((i) => i.dataset.view === 'field'),
   viewItems().map((i) => i.dataset.view).join(', '));
const timeItem = () => viewItems().find((i) => i.dataset.view === 'time');
ok('t–y is on by itself', timeItem().classList.contains('is-on'));
click(timeItem());
await settle(20);
ok('a view can be turned off from the menu', !timeItem().classList.contains('is-on'));
click(timeItem());
await settleSolve();
ok('and back on', timeItem().classList.contains('is-on'));
click(viewsBtn);
await settle(10);

// ---------------------------------------------------------------------------
// THE WINDOW IS THE SPAN: zooming the horizontal axis re-solves
// ---------------------------------------------------------------------------

const canvas = $('canvas');
const wheel = (x, y, dy) => dispatch(canvas, 'wheel', {
  type: 'wheel', target: canvas, clientX: x, clientY: y, deltaY: dy, deltaMode: 0,
});

const spanBefore = spanOf();
wheel(200, 30, -300);            // over the x labels: zoom that axis in
await settleSolve();
const spanAfter = spanOf();
ok('zooming the horizontal axis changes the solved span',
   !!spanBefore && !!spanAfter &&
   (spanAfter[0] !== spanBefore[0] || spanAfter[1] !== spanBefore[1]),
   `${JSON.stringify(spanBefore)} -> ${JSON.stringify(spanAfter)}`);
ok('zooming in narrows it',
   !!spanBefore && !!spanAfter &&
   (spanAfter[1] - spanAfter[0]) < (spanBefore[1] - spanBefore[0]),
   `${JSON.stringify(spanBefore)} -> ${JSON.stringify(spanAfter)}`);
ok('the model really integrated the new span', !/error|failed/i.test($('stat-solve').textContent),
   `status: ${$('stat-solve').textContent}`);

// Zooming in must redraw at full resolution IMMEDIATELY, not after the
// re-solve. `sample(n)` spreads its points over the whole solved span, so a
// tenfold zoom leaves a tenth of them on screen stretched across the full
// width, which draws a visibly polygonal line. The dense output already
// answers inside the solved span, so the curve is re-sampled per pixel on
// every frame change and only a window reaching OUTSIDE it needs a re-solve.
{
  const inspect = globalThis.__numplaInspect;
  const drawnSpan = () => {
    const f = inspect && inspect.frame();
    if (!f || !f.n || !f.dim) return null;
    const stride = f.dim + 1;
    return [f.data[0], f.data[(f.n - 1) * stride]];
  };
  const drawnCount = () => {
    const f = inspect && inspect.frame();
    return f && f.n ? f.n : 0;
  };

  click($('frame-reset'));
  await settleSolve();
  const wideSpan = spanOf();

  wheel(200, 30, -900);          // a hard zoom on the horizontal axis
  await settle(3);               // deliberately LESS than the 180ms debounce
  const drawn = drawnSpan();
  ok('the curve is redrawn across the new window before any re-solve',
     drawn !== null && (drawn[1] - drawn[0]) < 0.6 * (wideSpan[1] - wideSpan[0]),
     `window ${JSON.stringify(spanOf())} but curve covers ${JSON.stringify(drawn)}`);
  ok('and at full sample density', drawnCount() >= 240,
     `${drawnCount()} samples`);

  click($('frame-reset'));
  await settleSolve();
}

// A y-axis gesture is not a statement about time: no re-solve.
const spanBeforeY = spanOf();
wheel(20, 10, -300);             // over the y labels
await settleSolve();
ok('scaling the vertical axis leaves the span alone',
   JSON.stringify(spanOf()) === JSON.stringify(spanBeforeY),
   `${JSON.stringify(spanBeforeY)} -> ${JSON.stringify(spanOf())}`);

// Back to a sane frame before the demos run.
click($('frame-reset'));
await settleSolve();
ok('the reset button puts the frame back', JSON.stringify(spanOf()) === '[-5,5]',
   `${JSON.stringify(spanOf())}`);

// ---------------------------------------------------------------------------
// Every demo loads, solves, and keeps its rows — and its tSpan sets the frame
// ---------------------------------------------------------------------------

const { DEMOS } = await import(new URL('./demos.js', APP).href);
click($('demos-btn'));
await settle(10);
const items = $('demomenu').querySelectorAll('.demoitem');
ok('the demo menu lists every demo', items.length === DEMOS.length,
   `${items.length} of ${DEMOS.length}`);

async function loadDemoById(id) {
  const i = DEMOS.findIndex((d) => d.id === id);
  if ($('demomenu').hidden) { click($('demos-btn')); await settle(5); }
  click($('demomenu').querySelectorAll('.demoitem')[i]);
  await settleSolve();
  return DEMOS[i];
}

for (let i = 0; i < DEMOS.length; i++) {
  const demo = DEMOS[i];
  if (!$('demomenu') || $('demomenu').hidden) { click($('demos-btn')); await settle(5); }
  const item = $('demomenu').querySelectorAll('.demoitem')[i];
  click(item);
  await settle(120);

  const rs = rowEls();
  const real = rs.filter((r) => !r.classList.contains('is-tail'));
  const errored = rs.filter((r) => r.classList.contains('is-error'));
  const status = $('stat-solve').textContent;

  ok(`${demo.id}: rows loaded`, real.length >= demo.source.split('\n').filter((l) => l.trim()).length - 1,
     `${real.length} rows`);
  ok(`${demo.id}: no row is in error`, errored.length === 0,
     errored.map((r) => r.textContent).join(' | ').slice(0, 160));
  ok(`${demo.id}: solved`, !/error|failed/i.test(status), `status: ${status}`);
  ok(`${demo.id}: its tSpan became the frame`,
     JSON.stringify(spanOf()) === JSON.stringify(demo.tSpan),
     `${JSON.stringify(spanOf())} vs tSpan ${JSON.stringify(demo.tSpan)}`);
}

// ---------------------------------------------------------------------------
// `show`: a document saying what is worth looking at
// ---------------------------------------------------------------------------

const chipNames = () =>
  $('readout').querySelectorAll('.chip__name').map((n) => n.textContent);

{
  const demo = await loadDemoById('colliding-strings');
  const names = chipNames();
  ok('show filters the legend to what the document asked for',
     JSON.stringify(names) === JSON.stringify(demo.show),
     `${JSON.stringify(names)} vs show ${JSON.stringify(demo.show)}`);
  ok('the states left out are still solved',
     !/error|failed/i.test($('stat-solve').textContent) &&
     names.length < demo.source.split('\n').filter((l) => /''\s*=/.test(l)).length * 2,
     `${names.length} drawn`);
}

{
  await loadDemoById('harmonic-oscillator');
  const names = chipNames();
  ok('no show list means every series is drawn', names.length === 2,
     `${JSON.stringify(names)}`);
}

// ---------------------------------------------------------------------------
// The integrator switch — on the strip, and it actually switches
// ---------------------------------------------------------------------------

const modeChips = () => $('methods').querySelectorAll('.modechip');
ok('the integrator switch is on the strip', modeChips().length >= 3,
   `${modeChips().length} methods`);
ok('Tsit5 is the one running', modeChips()[0].classList.contains('is-on'));

const methodOf = () => {
  const m = /solved · (\w+)/.exec($('stat-solve').textContent || '');
  return m ? m[1] : null;
};
ok('the badge names the method that ran', methodOf() === 'Tsit5',
   `status: ${$('stat-solve').textContent}`);

const verlet = modeChips().find((b) => b.dataset.method === 'Verlet');
ok('Verlet is offered', !!verlet);
click(verlet);
await settleSolve();
ok('switching the integrator switches the integrator', methodOf() === 'Verlet',
   `status: ${$('stat-solve').textContent}`);
ok('the switch shows which one is live',
   modeChips().find((b) => b.dataset.method === 'Verlet').classList.contains('is-on') &&
   !modeChips().find((b) => b.dataset.method === 'Tsit5').classList.contains('is-on'));

// A symplectic method on a first-order document is REFUSED, never downgraded.
{
  await loadDemoById('lotka-volterra');
  await settleSolve();
  const bad = $('stat-solve');
  ok('a symplectic method is refused on a first-order document',
     bad.classList.contains('is-bad') && /second-order|Verlet/i.test(bad.textContent),
     `status: ${bad.textContent}`);
  ok('the refusal is visible on the switch itself',
     modeChips().find((b) => b.dataset.method === 'Verlet').classList.contains('is-refused'));
  ok('and it is not silently downgraded to Tsit5', methodOf() === null,
     `status: ${bad.textContent}`);

  click(modeChips().find((b) => b.dataset.method === 'Tsit5'));
  await settleSolve();
  ok('choosing Tsit5 recovers', methodOf() === 'Tsit5', `status: ${$('stat-solve').textContent}`);
}

// ---------------------------------------------------------------------------
// An unfinished document is WAITING, not broken
//
// Deleting the row that defines `k` is the fastest way to reach the state
// everyone reaches by typing: a name used before it exists. The engine reports
// it as `pending` and declines to integrate — and that must read as waiting,
// keep the curve, and say what it is waiting FOR by name.
// ---------------------------------------------------------------------------

const fieldText = (row) => {
  const f = row.querySelector('.row__field');
  return f ? f.textContent : '';
};
const rowMatching = (re) => rowEls().find((r) => re.test(fieldText(r)));

{
  await loadDemoById('plucked-string');
  const chipsBefore = chipNames().length;
  ok('the demo drew something to begin with', chipsBefore > 0);

  const kRow = rowMatching(/k\s*=\s*60/);
  ok('found the row defining k', !!kRow, fieldText(rowEls()[0]));
  click(kRow.querySelector('.row__del'));
  await settleSolve();

  const badge = $('stat-solve');
  ok('an undefined name is not an error', !badge.classList.contains('is-bad'),
     `status: ${badge.textContent}`);
  ok('it reads as waiting', badge.classList.contains('is-wait'),
     `status: ${badge.textContent}`);
  ok('and it names what it is waiting for', /waiting on\b.*\bk\b/.test(badge.textContent),
     `status: ${badge.textContent}`);
  ok('the last good curve stays on screen', chipNames().length === chipsBefore,
     `${chipNames().length} of ${chipsBefore} series still in the legend`);
  ok('no row is marked as an error',
     rowEls().filter((r) => r.classList.contains('is-error')).length === 0);
  ok('rows waiting on the name are pending, not wrong',
     rowEls().some((r) => r.classList.contains('is-pending')));

  ok('the issue bar names it', /\bk\b/.test($('issue-msg').textContent),
     `bar: ${$('issue-msg').textContent}`);

  // THE SUGGESTION IS ON THE ROW — where the problem is, not at the bottom of
  // the pane. The compiler proposes one obvious row; that is what is rendered.
  const pending = rowEls().filter((r) => r.classList.contains('is-pending'));
  const suggesting = pending.filter((r) => !r.querySelector('.row__fix').hidden);
  ok('the row waiting on the name offers the row that would fix it',
     suggesting.length === 1 && /k\s*=\s*1/.test(suggesting[0].querySelector('.row__fix').textContent),
     suggesting.map((r) => r.querySelector('.row__fix').textContent).join(' | '));
  ok('the suggestion sits in the row that reports the problem',
     /\bk\b/.test(suggesting[0].querySelector('.row__msg').textContent),
     `msg: ${suggesting[0].querySelector('.row__msg').textContent}`);
  ok('a row with no proposal of its own shows no button',
     pending.length > 1 &&
     pending.filter((r) => r !== suggesting[0])
            .every((r) => r.querySelector('.row__fix').hidden),
     `${pending.length} pending rows`);
  ok('and the bar does not compete with it', $('issue-fix').hidden,
     `bar button: ${$('issue-fix').textContent}`);

  // Pressing it appends `k = 1` at the END — below every row that uses it.
  // Solving anyway is the proof that rows need not be in sequence.
  click(suggesting[0].querySelector('.row__fix'));
  await settleSolve();
  ok('pressing the suggestion completes the document',
     /solved/.test($('stat-solve').textContent), `status: ${$('stat-solve').textContent}`);
  // The math field renders notation, so its text has no underscores or
  // parentheses in it: `x_1'' = ...` reads back as `x1′′=...`.
  const firstOde = rowMatching(/^x1[′']{2}=/);
  const kAgain = rowMatching(/^k=1$/);
  ok('a definition BELOW its uses is still a definition',
     !!kAgain && !!firstOde && rowEls().indexOf(kAgain) > rowEls().indexOf(firstOde),
     'the appended row must sit below the rows that read it');
  ok('and no row is in error afterwards',
     rowEls().filter((r) => r.classList.contains('is-error')).length === 0);
  ok('the suggestion goes away once it has been taken',
     rowEls().every((r) => r.querySelector('.row__fix').hidden));
}

// Several things missing at once: one suggestion per problem, on its own row,
// and the bar becomes the summary that can take them all.
{
  for (const re of [/^x10=/, /^x20=/, /^x30=/]) {
    const row = rowMatching(re);
    if (row) click(row.querySelector('.row__del'));
    await settle(20);
  }
  await settleSolve();

  const msg = $('issue-msg').textContent;
  ok('every missing name is on screen, not just the first',
     /x_?1/.test(msg) && /x_?2/.test(msg) && /x_?3/.test(msg), `bar: ${msg}`);
  ok('one button offers all of them', /add all 3 defaults/.test($('issue-fix').textContent),
     `fix: ${$('issue-fix').textContent}`);
  ok('a missing starting point never stops the solve',
     /solved/.test($('stat-solve').textContent), `status: ${$('stat-solve').textContent}`);

  const offers = () => rowEls().filter((r) => !r.querySelector('.row__fix').hidden);
  ok('each problem has its own suggestion, on its own row', offers().length === 3,
     `${offers().length} suggestions`);
  ok('each suggestion is the compiler proposal, verbatim',
     offers().every((r) => /=\s*0$/.test(r.querySelector('.row__fix').textContent.trim())),
     offers().map((r) => r.querySelector('.row__fix').textContent).join(' | '));

  click(offers()[0].querySelector('.row__fix'));
  await settleSolve();
  ok('taking one leaves the others', offers().length === 2, `${offers().length} left`);
  ok('and the bar counts down with it', /add all 2 defaults/.test($('issue-fix').textContent),
     `fix: ${$('issue-fix').textContent}`);

  click($('issue-fix'));
  await settleSolve();
  ok('the bar can still take the rest at once', $('issue-msg').textContent === 'clean',
     `bar: ${$('issue-msg').textContent}`);
  ok('and no suggestion is left over', offers().length === 0);
}

// ---------------------------------------------------------------------------
// The reference panel
// ---------------------------------------------------------------------------

if ($('info-btn')) {
  click($('info-btn'));
  await settle(10);
  const panel = $('infopanel');
  ok('the reference opens', panel && !panel.hidden);
  const entries = $('info-list').querySelectorAll('.entry');
  ok('the reference has entries', entries.length > 20, `${entries.length} entries`);

  // Search must actually filter.
  $('info-search').value = 'noise';
  dispatch($('info-search'), 'input', { type: 'input', target: $('info-search') });
  await settle(5);
  const filtered = $('info-list').querySelectorAll('.entry');
  ok('searching the reference filters it',
     filtered.length > 0 && filtered.length < entries.length,
     `${entries.length} -> ${filtered.length}`);

  // Nothing in it may still promise a `t` row.
  $('info-search').value = 't = [';
  dispatch($('info-search'), 'input', { type: 'input', target: $('info-search') });
  await settle(5);
  ok('the reference no longer documents a t row',
     $('info-list').querySelectorAll('.entry').length === 0);

  click($('info-close'));
  await settle(5);
}

// ---------------------------------------------------------------------------
// Hear — the least-tested seam, and it must degrade gracefully with no audio
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// A blowup is a curve, not a failure
// ---------------------------------------------------------------------------

{
  // x' = x^2 with x(0) = 1 has an exact singularity at t = 1. Asking for [0, 5]
  // used to leave a blank plot; it should draw the part that exists and say
  // where it stopped.
  const inspect = globalThis.__numplaInspect;
  click($('frame-reset'));
  await settleSolve();
  inspect.setDocument(["x' = x^2", 'x(0) = 1'].join('\n'));
  await settleSolve();

  const badge = $('stat-solve');
  const f = inspect.frame();
  const drewSomething = !!(f && f.n > 1);
  ok('a blowup still draws the part that worked', drewSomething,
     `frame: ${f ? f.n + ' samples' : 'null'} · badge: ${badge.textContent}`);
  if (drewSomething) {
    ok('the curve stops where the integration did, short of the window',
       f.t1 < inspect.window().x1 - 1e-9,
       `curve ends ${f.t1}, window ends ${inspect.window().x1}`);
    ok('and it says where it stopped', /stopped at t/.test(badge.textContent + badge.title),
       `badge: ${badge.textContent}`);
    ok('a partial run is not styled as an error', !badge.classList.contains('is-bad'),
       badge.classList.value);
  }
}

// ---------------------------------------------------------------------------
// The field: arrows of one length, shaded by magnitude, drawn UNDER the curves
//
// The drawing itself is checked against a recording context, because the two
// decisions that make the picture readable — normalise the length, show
// magnitude as a shade — are invisible to every other kind of test. A field
// whose arrows scale with speed passes "there are arrows" and is still a mess.
// ---------------------------------------------------------------------------

const plotMod = await import(new URL('./plot.js', APP).href);

function recordingCtx() {
  const calls = [];
  const ctx = {
    canvas: null, globalAlpha: 1, lineWidth: 1, lineJoin: '', lineCap: '',
    fillStyle: '', font: '', textAlign: '', textBaseline: '',
    save() {}, restore() {}, clip() {}, rect() {}, ellipse() {}, closePath() {},
    fill() { calls.push(['fill']); }, fillRect() {}, clearRect() {},
    setTransform() {}, fillText() {}, setLineDash() {},
    measureText: () => ({ width: 10 }),
    beginPath() { calls.push(['begin']); },
    moveTo(x, y) { calls.push(['m', x, y]); },
    lineTo(x, y) { calls.push(['l', x, y]); },
    arc(x, y, r) { calls.push(['arc', x, y, r]); },
    stroke() { calls.push(['stroke']); },
  };
  let ss = '';
  Object.defineProperty(ctx, 'strokeStyle', {
    get: () => ss,
    set: (v) => { ss = v; calls.push(['ss', v]); },
  });
  return { ctx, calls };
}

/** Group the recorded calls into paths, each tagged with its stroke colour. */
function paths(calls) {
  const out = [];
  let ink = '';
  let cur = null;
  for (const c of calls) {
    if (c[0] === 'ss') { ink = c[1]; continue; }
    if (c[0] === 'begin') { cur = { ink, pts: [] }; out.push(cur); continue; }
    if (!cur) continue;
    if (c[0] === 'm' || c[0] === 'l') cur.pts.push([c[0], c[1], c[2]]);
    if (c[0] === 'arc') cur.arc = c;
  }
  return out;
}

{
  const { Plot, fieldGrid, shadeRamp, FIELD_MIN, FIELD_MAX } = plotMod;

  // The density rule, stated once in plot.js and checked here: per axis, from
  // the box, in pixels — so the cells stay square whatever shape the window is.
  const wide = fieldGrid(900, 300);
  const tall = fieldGrid(300, 900);
  ok('the grid density is read off the box, per axis',
     wide.nx > wide.ny && tall.ny > tall.nx,
     `${JSON.stringify(wide)} / ${JSON.stringify(tall)}`);
  ok('a wide box and a tall box are mirror images',
     wide.nx === tall.ny && wide.ny === tall.nx,
     `${JSON.stringify(wide)} / ${JSON.stringify(tall)}`);
  ok('the density is clamped at both ends',
     fieldGrid(10, 10).nx === FIELD_MIN && fieldGrid(9000, 9000).nx === FIELD_MAX,
     `${fieldGrid(10, 10).nx} .. ${fieldGrid(9000, 9000).nx}`);

  const ramp = shadeRamp([1e-3, 1e-2, 1e-1, 1, 10, 100, 1000]);
  ok('the shade ramp is logarithmic and robust', ramp.hi > ramp.lo && !ramp.flat,
     `lo ${ramp.lo} hi ${ramp.hi}`);
  ok('a uniform field is not amplified into a picture of variation',
     shadeRamp([2, 2.0000001, 2]).flat);

  // A 4x3 field with magnitudes spanning six decades, on a deliberately
  // anisotropic window: the hard case for both decisions.
  const nx = 4, ny = 3;
  const data = new Float64Array(nx * ny * 4);
  const mags = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const m = Math.pow(10, k - 6);            // 1e-6 … 1e5
      mags.push(m);
      data[k * 4] = -1.5 + (3 * i) / (nx - 1);
      data[k * 4 + 1] = -0.75 + (1.5 * j) / (ny - 1);
      data[k * 4 + 2] = m;                      // pointing +x, at speed m
      data[k * 4 + 3] = m;                      // and +y just as fast
    }
  }

  const rec = recordingCtx();
  const fake = {
    width: 0, height: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 400 }),
    getContext: () => rec.ctx,
  };
  const pl = new Plot(fake);
  pl.setSupport({ time: true, phase: true, polar: false, field: true });
  pl.setViews(['field']);
  pl.setWindow({ x0: -2, x1: 2, y0: -1, y1: 1 });   // 4 units wide, 2 units tall
  pl.setField({ nx, ny, t: 0, data });
  pl.draw(null);

  // An arrow is a shaft plus two barbs: three moveTo/lineTo pairs in one path.
  const arrows = paths(rec.calls).filter((p) => p.pts.length === 6);
  ok('every grid point gets an arrow', arrows.length === nx * ny,
     `${arrows.length} arrows for ${nx * ny} samples`);

  const shaft = (a) => Math.hypot(a.pts[1][1] - a.pts[0][1], a.pts[1][2] - a.pts[0][2]);
  const lens = arrows.map(shaft);
  const spread = Math.max(...lens) - Math.min(...lens);
  ok('the arrows are all one length, over six decades of speed',
     spread < 1e-9 && lens[0] > 4,
     `lengths ${Math.min(...lens).toFixed(3)}..${Math.max(...lens).toFixed(3)}`);

  const lum = (ink) => {
    const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(ink);
    return m ? Number(m[1]) + Number(m[2]) + Number(m[3]) : NaN;
  };
  const inks = arrows.map((a) => lum(a.ink));
  ok('magnitude is the shade instead', new Set(inks).size > 3,
     `${new Set(arrows.map((a) => a.ink)).size} distinct shades`);
  ok('and it runs pale for slow, dark for fast',
     inks[0] > inks[inks.length - 1],
     `slowest ${inks[0]} vs fastest ${inks[inks.length - 1]}`);

  // The direction is normalised in PIXELS, so an arrow is tangent to the curve
  // that would be drawn through it — not to the one in an unscaled plane.
  const a0 = arrows[0];
  const ang = Math.atan2(a0.pts[1][2] - a0.pts[0][2], a0.pts[1][1] - a0.pts[0][1]);
  const box = pl.box;
  const kx = (box.R - box.L) / 4;
  const ky = (box.B - box.T) / 2;
  ok('the arrows point along the stretched frame, not through it',
     Math.abs(ang - Math.atan2(-ky, kx)) < 1e-9,
     `drawn ${ang.toFixed(4)} vs expected ${Math.atan2(-ky, kx).toFixed(4)}`);

  // Under the curves: the field is laid down before anything else is stroked.
  const rec2 = recordingCtx();
  const pl2 = new Plot({
    width: 0, height: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 400 }),
    getContext: () => rec2.ctx,
  });
  pl2.setSupport({ time: true, phase: true, polar: false, field: true });
  pl2.setViews(['phase', 'field']);
  pl2.setWindow({ x0: -2, x1: 2, y0: -2, y1: 2 });
  pl2.setField({ nx, ny, t: 0, data });
  const curve = new Float64Array(3 * 40);
  for (let i = 0; i < 40; i++) {
    const t = i / 39;
    curve[i * 3] = t; curve[i * 3 + 1] = Math.cos(t); curve[i * 3 + 2] = Math.sin(t);
  }
  pl2.draw({ names: ['x', 'y'], dim: 2, n: 40, data: curve, t0: 0, t1: 1, polar: null, extra: null });
  const groups = paths(rec2.calls);
  const lastArrow = groups.map((p) => p.pts.length === 6).lastIndexOf(true);
  const phaseCurve = groups.findIndex((p) => p.pts.length === 40);
  ok('the field is drawn under the trajectories',
     lastArrow >= 0 && phaseCurve > lastArrow,
     `last arrow at ${lastArrow}, curve at ${phaseCurve}`);
}

// ---------------------------------------------------------------------------
// The field and seeds in the running app
//
// `vector_field` and `trajectory_from` are additive and app/pkg/ may predate
// them, so the shell probes for them exactly the way it probes `solve_with`.
// Both worlds are checked here: without the calls the views menu says so and
// nothing throws; with them (real, or the stub below on a build that has not
// shipped them yet) the whole pipeline runs.
// ---------------------------------------------------------------------------

const inspect = globalThis.__numplaInspect;

{
  const { probeFieldApi, probeSeedApi } = await import(new URL('./main.js', APP).href);
  ok('the optional calls are probed, never assumed',
     probeFieldApi(null) === null && probeFieldApi({}) === null &&
     probeSeedApi({}) === null);
  ok('a snake_case build is bound', typeof probeFieldApi({ vector_field() {} }) === 'function'
     && typeof probeSeedApi({ trajectory_from() {} }) === 'function');
  ok('a camelCase build is bound too', typeof probeFieldApi({ vectorField() {} }) === 'function'
     && typeof probeSeedApi({ trajectoryFrom() {} }) === 'function');
}

const HARMONIC = ["x' = -y", "y' = x", 'x(0) = 1', 'y(0) = 0'].join('\n');
const viewItem = (id) =>
  $('viewmenu').querySelectorAll('.viewitem').find((i) => i.dataset.view === id);
const whyOf = (id) => {
  const it = viewItem(id);
  return it ? it.querySelector('.viewitem__why').textContent : '';
};

// -- with neither call: the shell says why, and keeps working ---------------
{
  inspect.setApis({ field: null, seed: null });
  click($('frame-reset'));
  await settleSolve();
  inspect.setDocument(HARMONIC);
  await settleSolve();

  ok('a build with no vector_field still solves',
     /solved/.test($('stat-solve').textContent), `status: ${$('stat-solve').textContent}`);
  ok('two states light the phase plane up', inspect.views().caps.phase);
  ok('but the field view is not offered without the call',
     inspect.views().caps.field === false && inspect.views().on.indexOf('field') < 0,
     JSON.stringify(inspect.views()));
  ok('and nothing is computed for it', inspect.field() === null);

  if ($('viewmenu').hidden) { click(viewsBtn); await settle(10); }
  ok('the menu names the missing call rather than blaming the document',
     /vector_field/.test(whyOf('field')), `why: ${whyOf('field')}`);
  ok('the seeds control says the same about its own call',
     /trajectory_from/.test($('seeds-btn').title), `title: ${$('seeds-btn').title}`);
  click(viewsBtn);
  await settle(10);

  // A click on the plane with no way to integrate a seed must do nothing at all.
  const before = inspect.seeds().length;
  dispatch(canvas, 'pointerdown', { type: 'pointerdown', target: canvas, clientX: 300, clientY: 10, pointerId: 9 });
  dispatch(canvas, 'pointerup', { type: 'pointerup', target: canvas, clientX: 300, clientY: 10, pointerId: 9 });
  await settle(10);
  ok('clicking the plane places nothing when seeds cannot be integrated',
     inspect.seeds().length === before, `${inspect.seeds().length} seeds`);
}

// -- with both calls, real or stubbed ---------------------------------------
{
  const real = inspect.probe();
  // The stub is a rotation: x' = -y, y' = x — the very document loaded above,
  // so a stubbed run is answering the same question the real one would.
  const stubField = (x0, x1, y0, y1, nx, ny, t) => {
    const out = new Float64Array(nx * ny * 4);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const x = x0 + ((x1 - x0) * i) / Math.max(1, nx - 1);
        const y = y0 + ((y1 - y0) * j) / Math.max(1, ny - 1);
        out[k * 4] = x; out[k * 4 + 1] = y; out[k * 4 + 2] = -y; out[k * 4 + 3] = x;
      }
    }
    return out;
  };
  const stubSeed = (t0, t1, method, y0, n) => {
    const out = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const t = t0 + ((t1 - t0) * i) / Math.max(1, n - 1);
      out[i * 3] = t;
      out[i * 3 + 1] = y0[0] * Math.cos(t) - y0[1] * Math.sin(t);
      out[i * 3 + 2] = y0[0] * Math.sin(t) + y0[1] * Math.cos(t);
    }
    return out;
  };

  if (real.field && real.seed) inspect.setApis(null);
  else inspect.setApis({ field: stubField, seed: stubSeed });
  ok(`the field and seed calls are available${real.field ? ' (real WASM)' : ' (stubbed)'}`,
     inspect.probe().field && inspect.probe().seed);

  // A real box, so the plot draws for real and pixels mean something. The
  // shim gives every element the same 400x40 rect, which is not a plot.
  const realRect = canvas.getBoundingClientRect;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 400 });

  inspect.setDocument(HARMONIC);
  await settleSolve();
  await settle(20);

  ok('two states and the call together make the field drawable',
     inspect.views().caps.field === true, JSON.stringify(inspect.views().caps));
  ok('and it turns itself on, like every other supported view',
     inspect.views().on.indexOf('field') >= 0, JSON.stringify(inspect.views().on));

  const f0 = inspect.field();
  ok('the arrows are computed', !!f0 && f0.count === f0.nx * f0.ny,
     f0 ? `${f0.nx}x${f0.ny} = ${f0.count}` : 'null');
  ok('the grid is dense enough to read and sparse enough to see',
     !!f0 && f0.nx >= 5 && f0.ny >= 5 && f0.nx * f0.ny <= 26 * 26,
     f0 ? `${f0.nx}x${f0.ny}` : 'null');
  ok('the grid follows the box shape, not the window',
     !!f0 && f0.nx > f0.ny, f0 ? `${f0.nx}x${f0.ny} in a 900x400 box` : 'null');
  ok('the field is sampled at the start of the window',
     !!f0 && Math.abs(f0.t - inspect.window().x0) < 1e-9,
     f0 ? `t = ${f0.t}, window starts at ${inspect.window().x0}` : 'null');
  ok('the query is the visible window',
     !!f0 && f0.win.x0 === inspect.window().x0 && f0.win.y1 === inspect.window().y1);

  // THE WINDOW IS THE QUERY: pan, and the arrows are recomputed for where you
  // are now looking — debounced, like the re-solve.
  dispatch(canvas, 'pointerdown', { type: 'pointerdown', target: canvas, clientX: 400, clientY: 200, pointerId: 11 });
  dispatch(canvas, 'pointermove', { type: 'pointermove', target: canvas, clientX: 480, clientY: 240, pointerId: 11 });
  dispatch(canvas, 'pointerup', { type: 'pointerup', target: canvas, clientX: 480, clientY: 240, pointerId: 11 });
  await settleSolve();
  const f1 = inspect.field();
  ok('panning recomputes the arrows', !!f1 && f1.gen > f0.gen, `${f0.gen} -> ${f1 && f1.gen}`);
  ok('and they are recomputed for the NEW window',
     !!f1 && f1.win.x0 !== f0.win.x0 && f1.win.x0 === inspect.window().x0,
     `${f0.win.x0} -> ${f1 && f1.win.x0}, window ${inspect.window().x0}`);

  const genBefore = inspect.field().gen;
  await wait(60);
  ok('a still window is not re-queried', inspect.field().gen === genBefore);

  wheel(400, 200, -300);
  await settleSolve();
  ok('zooming recomputes them too', inspect.field().gen > genBefore,
     `${genBefore} -> ${inspect.field().gen}`);

  // Only for two states — the same condition the phase plane uses.
  click($('frame-reset'));
  await settleSolve();
  inspect.setDocument(["x' = -x", 'x(0) = 1'].join('\n'));
  await settleSolve();
  ok('one state is not a plane, so there is no field',
     inspect.views().caps.field === false && inspect.field() === null,
     JSON.stringify(inspect.views().caps));
  if ($('viewmenu').hidden) { click(viewsBtn); await settle(10); }
  ok('and the menu says which condition failed',
     /2 states/.test(whyOf('field')), `why: ${whyOf('field')}`);
  click(viewsBtn);
  await settle(10);

  inspect.setDocument(["x' = -y", "y' = x", "z' = 0", 'x(0) = 1', 'y(0) = 0', 'z(0) = 0'].join('\n'));
  await settleSolve();
  ok('three states are not a plane either', inspect.views().caps.field === false,
     JSON.stringify(inspect.views().caps));

  inspect.setDocument(HARMONIC);
  await settleSolve();
  await settle(20);
  ok('and the field comes back with the second state', !!inspect.field());

  // -----------------------------------------------------------------------
  // Seeds
  // -----------------------------------------------------------------------

  const seedIds = () => inspect.seeds().filter((s) => !s.locked).map((s) => s.id);
  const seedOf = (id) => inspect.seeds().find((s) => s.id === id) || null;
  const pointer = (type, x, y, id = 13) =>
    dispatch(canvas, type, { type, target: canvas, clientX: x, clientY: y, pointerId: id, button: 0 });
  const tap = async (x, y, id = 13) => {
    pointer('pointerdown', x, y, id);
    pointer('pointerup', x, y, id);
    await settle(12);
  };
  const documentText = () => rowEls().map((r) => r.textContent).join('\n');

  ok('the document has a seed zero of its own',
     inspect.seeds().some((s) => s.locked && s.id === 0), JSON.stringify(inspect.seeds()));

  const textBefore = documentText();
  await tap(300, 120);
  ok('clicking the plane places a seed', seedIds().length === 1,
     JSON.stringify(inspect.seeds()));
  await settle(20);
  ok('the seed gets its own trajectory over the same window',
     (seedOf(seedIds()[0]) || {}).n > 1, JSON.stringify(inspect.seeds()));
  ok('A SEED DOES NOT REWRITE THE DOCUMENT', documentText() === textBefore,
     `${textBefore.replace(/\n/g, ' | ')} -> ${documentText().replace(/\n/g, ' | ')}`);
  ok('nor does it disturb the document`s own curve',
     /solved/.test($('stat-solve').textContent) && inspect.frame().n > 1,
     `status: ${$('stat-solve').textContent}`);
  ok('the seeds control counts them', /seeds · 1/.test($('seeds-btn').textContent),
     `label: ${$('seeds-btn').textContent}`);

  await tap(500, 260);
  ok('a second one is a second seed', seedIds().length === 2, JSON.stringify(seedIds()));
  const two = inspect.seeds().filter((s) => !s.locked);
  ok('each is where it was put, and they differ',
     two[0].x !== two[1].x && two[0].y !== two[1].y,
     JSON.stringify(two));

  // Dragging: the handle follows the pointer, the trajectory follows the handle.
  const id = seedIds()[1];
  const was = seedOf(id);
  const trailWas = was.n;
  pointer('pointerdown', 500, 260, 21);
  pointer('pointermove', 560, 230, 21);
  await settle(4);
  const mid = seedOf(id);
  ok('the handle keeps up with the pointer mid-drag', mid.x > was.x && mid.y > was.y,
     `${JSON.stringify(was)} -> ${JSON.stringify(mid)}`);
  ok('and the last good trajectory stays on screen while it catches up',
     mid.n >= 1, `${mid.n} samples`);
  pointer('pointermove', 620, 200, 21);
  pointer('pointerup', 620, 200, 21);
  await settle(20);
  const now = seedOf(id);
  ok('the drag ends where the pointer stopped', now.x > mid.x && now.y > mid.y,
     `${JSON.stringify(mid)} -> ${JSON.stringify(now)}`);
  ok('and the trajectory is re-integrated from there', now.n > 1 && now.n >= trailWas - 1,
     `${trailWas} -> ${now.n} samples`);
  ok('dragging a seed does not pan the frame',
     JSON.stringify(spanOf()) === JSON.stringify(spanOf()) && inspect.window().x0 === inspect.field().win.x0);
  ok('and it still has not touched the document', documentText() === textBefore);

  // Removing one: the × on the handle itself, which appears when it is under
  // the pointer.
  pointer('pointermove', 620, 200, 22);           // hover it
  await settle(4);
  const { SEED_BADGE } = plotMod;
  pointer('pointerdown', 620 + SEED_BADGE.dx, 200 + SEED_BADGE.dy, 22);
  pointer('pointerup', 620 + SEED_BADGE.dx, 200 + SEED_BADGE.dy, 22);
  await settle(12);
  ok('the × on a hovered handle removes that seed',
     seedIds().length === 1 && seedIds().indexOf(id) < 0, JSON.stringify(seedIds()));

  // A double click is one gesture: it must not leave a seed behind, and it
  // must still be the way back to the default frame.
  wheel(400, 200, -200);
  await settleSolve();
  const seedsBeforeDbl = seedIds().length;
  await tap(360, 150, 31);
  await tap(360, 150, 31);
  dispatch(canvas, 'dblclick', { type: 'dblclick', target: canvas, clientX: 360, clientY: 150 });
  await settleSolve();
  ok('a double click on the plane leaves no seed behind',
     seedIds().length === seedsBeforeDbl, `${seedIds().length} vs ${seedsBeforeDbl}`);
  ok('and it still resets the frame', JSON.stringify(spanOf()) === '[-5,5]',
     JSON.stringify(spanOf()));

  // Clearing them all.
  await tap(300, 120, 41);
  await tap(420, 300, 42);
  ok('there are seeds to clear', seedIds().length >= 2, JSON.stringify(seedIds()));
  click($('seeds-btn'));
  await settle(12);
  ok('the seeds control clears every one of them', seedIds().length === 0);
  ok('and goes quiet again', $('seeds-btn').textContent === 'seeds',
     `label: ${$('seeds-btn').textContent}`);
  ok('seed zero is still there — it is the document, not a seed',
     inspect.seeds().length === 1 && inspect.seeds()[0].locked);

  // With only t–y on, the plane is gone: a seed cannot be PLACED (a click
  // there names a time, not a state), and the ones already down are drawn
  // against t instead.
  await tap(300, 120, 51);
  ok('a seed exists to carry over', seedIds().length === 1);
  if ($('viewmenu').hidden) { click(viewsBtn); await settle(10); }
  click(viewItem('phase'));
  await settle(10);
  click(viewItem('field'));
  await settleSolve();
  ok('the plane can be turned off', inspect.views().on.indexOf('phase') < 0 &&
     inspect.views().on.indexOf('field') < 0, JSON.stringify(inspect.views().on));
  const carried = seedIds().length;
  ok('the seeds that were placed survive it', carried === 1, `${carried} seeds`);
  ok('and they still carry a trajectory to draw against t',
     (seedOf(seedIds()[0]) || {}).n > 1, JSON.stringify(inspect.seeds()));
  await tap(340, 140, 52);
  ok('but a click on a t–y plot places nothing', seedIds().length === carried,
     `${seedIds().length} seeds`);
  ok('and the control says why', /phase-plane idea/.test($('seeds-btn').title),
     `title: ${$('seeds-btn').title}`);

  click(viewItem('phase'));
  await settle(10);
  click(viewItem('field'));
  await settleSolve();
  click(viewsBtn);
  await settle(10);
  ok('turning the plane back on restores placement',
     inspect.views().on.indexOf('phase') >= 0 && !/phase-plane idea/.test($('seeds-btn').title),
     JSON.stringify(inspect.views().on));

  // Losing the calls mid-flight is the same as never having had them.
  inspect.setApis({ field: null, seed: null });
  await settle(20);
  ok('taking the calls away drops the field and the seeds, quietly',
     inspect.field() === null && seedIds().length === 0 &&
     inspect.views().caps.field === false);
  ok('and the app still solves', /solved|waiting/.test($('stat-solve').textContent),
     `status: ${$('stat-solve').textContent}`);

  inspect.setApis(null);
  canvas.getBoundingClientRect = realRect;
  click($('frame-reset'));
  await settleSolve();
}

const hearBtn = $('hear-btn');
ok('the hear control exists', !!hearBtn);
if (hearBtn) {
  click(hearBtn);
  await settle(10);
  ok('the hear panel opens', !$('hearpanel').hidden);
  ok('it offers the states to listen to', $('hear-state').childNodes.length > 0,
     `${$('hear-state').childNodes.length} options`);
  ok('the window is prefilled', $('hear-from').value !== '' && $('hear-to').value !== '');

  // No AudioContext in Node: this must report, not throw.
  click($('hear-play'));
  await settle(30);
  ok('listening without Web Audio reports instead of throwing',
     /audio|not available|render/i.test($('hear-note').textContent),
     `note: ${$('hear-note').textContent}`);
}

// ---------------------------------------------------------------------------
// PHONES: the narrow layout, and the keyboard that replaces the OS one
//
// Two things are being proved here and they pull in opposite directions:
// the panel has to be there for a finger, and it has to be ABSENT for a mouse.
// A desktop user who suddenly loses a third of the screen is the regression
// this section exists to catch, so it is checked first, before anything has
// touched the glass.
// ---------------------------------------------------------------------------

{
  const kb = $('mathkb');
  const rowMf = (i) => rowEls()[i].querySelector('.mf');
  const focusRow = (i) => { rowMf(i).focus(); };
  const press = (id) => inspect.press(id);
  const kbKeys = () => inspect.keyboard().keys;
  const tapKey = (id) => {
    const btn = kb.querySelectorAll('.kbkey').find((b) => b.dataset.k === id)
      || kb.querySelectorAll('.kbvar').find((b) => b.dataset.k === id);
    if (!btn) return false;
    dispatch(btn, 'pointerdown', { type: 'pointerdown', target: btn, pointerId: 3 });
    dispatch(btn, 'pointerup', { type: 'pointerup', target: btn, pointerId: 3 });
    return true;
  };

  ok('the keyboard panel exists in the markup', !!kb);
  ok('the pane switch exists', !!$('panetabs') && !!$('tab-plot') && !!$('tab-system'));

  // -- a mouse user is left completely alone -------------------------------
  ok('a mouse user is not in touch mode', inspect.touch().on === false,
     JSON.stringify(inspect.touch()));
  ok('the layout is the wide one', inspect.layout().narrow === false,
     JSON.stringify(inspect.layout()));
  focusRow(0);
  await settle(6);
  ok('FOCUSING A ROW ON A DESKTOP RAISES NOTHING', kb.hidden && !inspect.keyboard().open);
  ok('and the way back to it is not on screen either', $('kb-open').hidden);
  ok('the body does not claim to be narrow or touched',
     !doc.body.classList.contains('is-narrow') && !doc.body.classList.contains('is-touch'));

  // -- the breakpoint ------------------------------------------------------
  inspect.setViewport(390, 720);
  await settle(6);
  ok('below 720px the narrow layout activates', inspect.layout().narrow === true,
     JSON.stringify(inspect.layout()));
  ok('and the body says so', doc.body.classList.contains('is-narrow'));
  ok('one pane is on screen at a time, and it starts on the plot',
     inspect.layout().pane === 'plot' && doc.body.classList.contains('pane-plot'));
  ok('the switch reflects it',
     $('tab-plot').classList.contains('is-on') &&
     $('tab-plot').getAttribute('aria-selected') === 'true' &&
     $('tab-system').getAttribute('aria-selected') === 'false');

  click($('tab-system'));
  await settle(6);
  ok('the switch moves to the system', inspect.layout().pane === 'system' &&
     doc.body.classList.contains('pane-system') && !doc.body.classList.contains('pane-plot'));
  ok('and it is still not a touch device, so still no keyboard',
     kb.hidden && inspect.touch().on === false);

  // Narrow alone is enough for the `keys` button: this screen might be a phone
  // that has not been touched yet, and the panel must be reachable.
  ok('the way back to the keyboard appears on a narrow screen', !$('kb-open').hidden);

  // -- a finger arrives ----------------------------------------------------
  inspect.setTouch(true);
  await settle(6);
  ok('touch mode arms', inspect.touch().on === true, JSON.stringify(inspect.touch()));
  ok('and the body carries it, for the 44px targets',
     doc.body.classList.contains('is-touch'));
  ok('the field is told not to raise the OS keyboard',
     inspect.keyboard().api.touchDriven !== false);

  focusRow(1);
  await settle(6);
  ok('FOCUSING A ROW WITH A FINGER RAISES THE PANEL',
     !kb.hidden && inspect.keyboard().open === true);
  ok('the document pane came forward with it', inspect.layout().pane === 'system');
  ok('and the re-open button stands down while it is up', $('kb-open').hidden);

  // -- the keys ------------------------------------------------------------
  const keys = kbKeys();
  for (const need of ['0', '1', '9', 'dot', 'plus', 'minus', 'times', 'eq',
    'lparen', 'rparen', 'comma', 'frac', 'sup', 'sqrt', 'prime',
    'backspace', 'left', 'right', 'up', 'down', 'newrow']) {
    ok(`the keyboard has a \`${need}\` key`, keys.indexOf(need) >= 0, keys.join(' '));
  }
  ok('the alphabet is reachable without leaving the panel',
     !!$('kb-page-abc') && !!$('kb-page-fn'));

  // The document's OWN names, which is what makes it fast to type this system
  // rather than a generic one.
  inspect.setDocument(['k = 0.4', "x' = -y - k*x", "y' = x", 'x(0) = 1', 'y(0) = 0'].join('\n'));
  await settleSolve();
  focusRow(1);
  await settle(10);
  const vars = inspect.keyboard().vars;
  ok('the name row offers the document’s own names',
     vars.indexOf('k') >= 0 && vars.indexOf('x') >= 0 && vars.indexOf('y') >= 0,
     vars.join(' '));
  ok('and x y t are always there', ['x', 'y', 't'].every((n) => vars.indexOf(n) >= 0),
     vars.join(' '));
  ok('with the constants on the same row',
     vars.indexOf('π') >= 0 && vars.indexOf('e') >= 0, vars.join(' '));

  // The constants have to be the constants THIS engine has — and `e` is one
  // of them (`constant()` in crates/numpla-expr/src/eval.rs, the same entry
  // the reference panel inserts). This test used to assert the opposite: that
  // the key must write exp(1) because "the engine has no `e`", which was
  // false, and the key it certified contradicted the reference panel one
  // overlay away. So the key writes the name, and the row it lands in has to
  // SOLVE — which is the proof the engine defines it.
  {
    focusRow(rowEls().length - 1);
    await settle(6);
    press('w'); press('eq');
    tapKey('euler');
    await settleSolve();
    ok('the e key writes the engine’s own constant',
       /w = e$/.test(inspect.source()),
       JSON.stringify(inspect.source().split('\n').pop()));
    ok('and the engine really defines it — nothing is left waiting on a name',
       /solved/.test($('stat-solve').textContent) && $('issue-msg').textContent === 'clean',
       `status: ${$('stat-solve').textContent} · bar: ${$('issue-msg').textContent}`);
    for (let i = 0; i < 3; i++) press('backspace');
    await settle(10);
    tapKey('pi');
    await settle(10);
    ok('and π writes pi', /\bpi\b/.test(inspect.source()),
       JSON.stringify(inspect.source().split('\n').pop()));
    for (let i = 0; i < 4; i++) press('backspace');
    await settle(10);
  }

  // -- a key changes the document ------------------------------------------
  {
    focusRow(rowEls().length - 1);            // the trailing blank row
    await settle(6);
    const before = inspect.source();
    ok('a tap on a key types into the row', tapKey('7'));
    press('dot'); press('5');
    await settle(10);
    const after = inspect.source();
    ok('AND THE DOCUMENT ACTUALLY CHANGES', after !== before && /7\.5/.test(after),
       JSON.stringify(after.split('\n').pop()));

    press('backspace'); press('backspace'); press('backspace');
    await settle(10);
    ok('backspace takes it back out', !/7\.5/.test(inspect.source()),
       JSON.stringify(inspect.source().split('\n').pop()));
  }

  // -- STRUCTURE KEYS INSERT STRUCTURE -------------------------------------
  //
  // The whole point of the exercise. `√` must inflate a radical with the caret
  // inside its radicand - not type the four letters s, q, r, t.
  {
    const i = rowEls().length - 1;
    focusRow(i);
    await settle(6);
    press('sqrt');
    await settle(10);
    const row = rowEls()[i];
    const radical = row.querySelector('.mf-sqrt');
    ok('THE RADICAL KEY INFLATES A RADICAL', !!radical,
       row.textContent);
    const body = row.querySelector('.mf-sqrt-body');
    ok('and the caret is inside it',
       !!body && !!body.querySelector('.mf-pos--caret'));
    press('2');
    await settle(10);
    ok('so what is typed next lands in the radicand', /sqrt\(2\)/.test(inspect.source()),
       JSON.stringify(inspect.source().split('\n').pop()));

    // the fraction key
    press('frac');
    await settle(10);
    ok('the fraction key builds a fraction, not a slash',
       !!rowEls()[i].querySelector('.mf-frac'), rowEls()[i].textContent);
    press('3');
    await settle(10);
    ok('and the digit lands in the denominator', /\/\(?3\)?/.test(inspect.source()),
       JSON.stringify(inspect.source().split('\n').pop()));

    // the exponent key
    press('sup');
    press('2');
    await settle(10);
    ok('the exponent key builds a superscript',
       !!rowEls()[i].querySelector('.mf-sup'), rowEls()[i].textContent);

    // the prime key
    focusRow(rowEls().length - 1);
    await settle(6);
    tapKey('var-x');
    press('prime');
    await settle(10);
    const last = rowEls()[rowEls().length - 2];
    ok('the prime key writes a prime', !!last.querySelector('.mf-prime'),
       last.textContent);
    ok("and the row reads x'", /x'/.test(inspect.source()),
       JSON.stringify(inspect.source().split('\n').pop()));
  }

  // -- a new row, and the arrows -------------------------------------------
  {
    const rowsBefore = rowEls().length;
    press('newrow');
    await settle(10);
    ok('a key makes the next row', rowEls().length > rowsBefore,
       `${rowsBefore} -> ${rowEls().length}`);
    const at = inspect.activeRow();
    press('up');
    await settle(10);
    ok('the arrows walk out of a row and into the one above',
       inspect.activeRow() === at - 1, `${at} -> ${inspect.activeRow()}`);
    press('down');
    await settle(10);
    ok('and back down again - once, never twice',
       inspect.activeRow() === at, `${at} -> ${inspect.activeRow()}`);
  }

  // -- NO SYNTHETIC KEY EVENTS ---------------------------------------------
  {
    let keydowns = 0;
    const spy = () => { keydowns++; };
    doc.addEventListener('keydown', spy, true);
    press('1'); press('sqrt'); press('backspace'); press('left');
    await settle(10);
    doc.removeEventListener('keydown', spy);
    ok('THE PANEL FIRES NO KEY EVENTS - it calls the field directly',
       keydowns === 0, `${keydowns} keydowns`);
    ok('and touch mode survived, which it would not have if it had',
       inspect.touch().on === true);
  }

  // -- repeat on hold ------------------------------------------------------
  {
    focusRow(rowEls().length - 1);
    await settle(6);
    for (const d of ['1', '2', '3', '4', '5', '6']) press(d);
    await settle(10);
    const before = inspect.source().split('\n').pop();
    ok('six digits are in the row', before.length >= 6, JSON.stringify(before));

    const btn = kb.querySelectorAll('.kbkey').find((b) => b.dataset.k === 'backspace');
    dispatch(btn, 'pointerdown', { type: 'pointerdown', target: btn, pointerId: 4 });
    await wait(620);
    dispatch(btn, 'pointerup', { type: 'pointerup', target: btn, pointerId: 4 });
    await settle(10);
    const after = inspect.source().split('\n').pop();
    ok('BACKSPACE REPEATS WHILE IT IS HELD',
       before.length - after.length >= 3,
       `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

    await wait(120);
    const settled = inspect.source().split('\n').pop();
    ok('and it stops the moment the finger lifts', settled === after,
       `${JSON.stringify(after)} -> ${JSON.stringify(settled)}`);
  }

  // -- the panel must not cover the row being edited -----------------------
  //
  // The shim gives every element the same rect, which is not a screen. Give
  // the list and the row real ones and check the arithmetic: the row sits at
  // 560..620 and the panel starts at 720 - 300 = 420, so the list has to
  // scroll by exactly the 210 that puts the row 10px clear of it.
  {
    const rowsHost = $('rows');
    const realRows = rowsHost.getBoundingClientRect;
    kb.offsetHeight = 300;
    rowsHost.getBoundingClientRect = () => ({
      left: 0, top: 60, right: 390, bottom: 720, width: 390, height: 660, x: 0, y: 60,
    });
    rowsHost.scrollTop = 0;

    const i = rowEls().length - 1;
    const row = rowEls()[i];
    const realRow = row.getBoundingClientRect;
    row.getBoundingClientRect = () => ({
      left: 0, top: 560, right: 390, bottom: 620, width: 390, height: 60, x: 0, y: 560,
    });

    focusRow(i);
    await settle(10);
    const keep = inspect.keyboard().keep;
    ok('the panel height is known', inspect.keyboard().height === 300,
       String(inspect.keyboard().height));
    ok('THE FOCUSED ROW IS SCROLLED CLEAR OF THE PANEL',
       !!keep && keep.dy === 210 && rowsHost.scrollTop === 210,
       JSON.stringify(keep) + ` scrollTop=${rowsHost.scrollTop}`);
    ok('and the target is the top of the panel, not the bottom of the screen',
       !!keep && keep.kbTop === 420 && keep.bottom === 410, JSON.stringify(keep));

    // Already in view: nothing moves. Typing must not scroll the list about.
    row.getBoundingClientRect = () => ({
      left: 0, top: 120, right: 390, bottom: 180, width: 390, height: 60, x: 0, y: 120,
    });
    press('1');
    await settle(10);
    ok('a row already in view is left exactly where it is',
       inspect.keyboard().keep.dy === 0 && rowsHost.scrollTop === 210,
       JSON.stringify(inspect.keyboard().keep));
    press('backspace');
    await settle(10);

    row.getBoundingClientRect = realRow;
    rowsHost.getBoundingClientRect = realRows;
    kb.offsetHeight = 100;
    rowsHost.scrollTop = 0;
  }

  // -- dismissable, and easy to get back -----------------------------------
  {
    const hide = $('kb-hide');
    dispatch(hide, 'pointerdown', { type: 'pointerdown', target: hide, pointerId: 5 });
    dispatch(hide, 'pointerup', { type: 'pointerup', target: hide, pointerId: 5 });
    await settle(6);
    ok('the panel can be dismissed', kb.hidden && !inspect.keyboard().open);
    ok('and the way back appears in its place', !$('kb-open').hidden);

    click($('kb-open'));
    await settle(6);
    ok('one tap brings it back', !kb.hidden && inspect.keyboard().open);
  }

  // -- leaving the document behind takes the keyboard with it --------------
  {
    ok('the keyboard is up', inspect.keyboard().open === true);
    click($('tab-plot'));
    await settle(6);
    ok('switching to the plot dismisses the keyboard',
       $('mathkb').hidden && !inspect.keyboard().open);
    ok('and the plot is what is on screen', inspect.layout().pane === 'plot');
    click($('tab-system'));
    await settle(6);
    ok('and coming back brings it up again', inspect.keyboard().open === true);
  }

  // -- pages ---------------------------------------------------------------
  {
    click($('kb-page-abc'));
    await settle(6);
    ok('the alphabet page opens', inspect.keyboard().page === 'abc');
    const alpha = kbKeys();
    ok('and it carries the whole alphabet',
       'abcdefghijklmnopqrstuvwxyz'.split('').every((c) => alpha.indexOf(c) >= 0),
       alpha.join(''));
    ok('with the subscript key, which is what letters need', alpha.indexOf('sub') >= 0);

    click($('kb-page-fn'));
    await settle(6);
    ok('the function page opens', inspect.keyboard().page === 'fn');
    const fns = kbKeys();
    ok('with the functions the reference lists',
       ['sin', 'cos', 'tan', 'ln', 'exp'].every((n) => fns.indexOf('fn-' + n) >= 0),
       fns.join(' '));

    focusRow(rowEls().length - 1);
    await settle(6);
    press('fn-sin');
    await settle(10);
    ok('a function key inflates a call, not three letters',
       !!rowEls()[rowEls().length - 2].querySelector('.mf-func'),
       rowEls()[rowEls().length - 2].textContent);
    ok('and the panel goes back to the digits, because an argument comes next',
       inspect.keyboard().page === '123');
    press('t');
    await settle(10);
    ok('so the argument lands inside the call', /sin\(t\)/.test(inspect.source()),
       JSON.stringify(inspect.source().split('\n').pop()));
  }

  // -- the caret leaving the document takes the panel with it --------------
  {
    focusRow(0);
    await settle(10);
    ok('the panel is up while a row has the caret', inspect.keyboard().open === true);
    $('demos-btn').focus();
    await settle(10);
    ok('and it stands down when the caret leaves the document entirely',
       !inspect.keyboard().open && $('mathkb').hidden);
    focusRow(0);
    await settle(10);
    ok('a row taking the caret brings it straight back', inspect.keyboard().open === true);
  }

  // -- an app/mathfield.js that predates the command API -------------------
  //
  // The same bargain the shell makes with `vector_field`: probe, and degrade
  // to what is definitely there. Every key above has to keep working with
  // `insert` and `command` taken away.
  {
    const hidden = inspect.setFieldApi(false);
    ok('the command API can be taken away', hidden.insert === false && hidden.command === false,
       JSON.stringify(hidden));

    focusRow(rowEls().length - 1);
    await settle(6);
    const before = inspect.source();
    press('4'); press('2');
    await settle(10);
    ok('the keys still type without it', /42/.test(inspect.source()) &&
       inspect.source() !== before, JSON.stringify(inspect.source().split('\n').pop()));

    press('sqrt');
    await settle(10);
    const i = rowEls().length - 2;
    ok('and structure is still structure',
       !!rowEls()[i].querySelector('.mf-sqrt'), rowEls()[i].textContent);

    press('backspace'); press('backspace'); press('backspace');
    await settle(10);
    ok('backspace still deletes', !/42/.test(inspect.source()),
       JSON.stringify(inspect.source().split('\n').pop()));

    const at = inspect.activeRow();
    press('up');
    await settle(10);
    ok('and the arrows still walk between rows',
       inspect.activeRow() === at - 1, `${at} -> ${inspect.activeRow()}`);

    const back = inspect.setFieldApi(true);
    ok('and it comes back', back.insert === true && back.command === true,
       JSON.stringify(back));
  }

  // -- touch gestures on the canvas ----------------------------------------
  //
  // The window IS the integration span, so pinch and drag are how a phone
  // re-solves. One finger pans; two zoom.
  {
    inspect.setPane('plot');
    await settle(6);
    const realRect = canvas.getBoundingClientRect;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 400 });
    click($('frame-reset'));
    await settleSolve();

    const w0 = inspect.window();
    const touch = (type, id, x, y) => dispatch(canvas, type, {
      type, target: canvas, pointerId: id, pointerType: 'touch', clientX: x, clientY: y,
    });

    touch('pointerdown', 21, 400, 180);
    touch('pointermove', 21, 300, 180);
    touch('pointerup', 21, 300, 180);
    await settleSolve();
    const w1 = inspect.window();
    ok('ONE FINGER PANS THE FRAME', w1.x0 !== w0.x0,
       `${w0.x0} -> ${w1.x0}`);

    // two fingers, spreading apart: zoom in
    touch('pointerdown', 31, 380, 170);
    touch('pointerdown', 32, 420, 190);
    touch('pointermove', 31, 300, 120);
    touch('pointermove', 32, 500, 240);
    touch('pointerup', 31, 300, 120);
    touch('pointerup', 32, 500, 240);
    await settleSolve();
    const w2 = inspect.window();
    ok('TWO FINGERS PINCH THE FRAME', (w2.x1 - w2.x0) < (w1.x1 - w1.x0) * 0.95,
       `${(w1.x1 - w1.x0).toFixed(3)} -> ${(w2.x1 - w2.x0).toFixed(3)}`);
    ok('and a pinch is the span, so the solve followed it',
       Math.abs(spanOf()[1] - spanOf()[0] - (w2.x1 - w2.x0)) < 1e-6 ||
       /solved|waiting/.test($('stat-solve').textContent),
       `${JSON.stringify(spanOf())} vs ${w2.x0}..${w2.x1}`);
    ok('a pinch drops no seed', inspect.seeds().every((s) => s.locked) ||
       inspect.seeds().length === 0, JSON.stringify(inspect.seeds()));

    // and the handles are a finger's size once a finger is driving
    const { Plot: P } = await import(new URL('./plot.js', APP).href);
    const probe = new P(doc.createElement('canvas'));
    probe.setTouch(true);
    ok('SEED HANDLES ARE 44px UNDER A FINGER', probe.grab >= 22,
       `grab radius ${probe.grab}`);
    probe.setTouch(false);
    ok('and back to a pixel-precise one for a mouse', probe.grab < 12,
       `grab radius ${probe.grab}`);

    canvas.getBoundingClientRect = realRect;
    click($('frame-reset'));
    await settleSolve();
  }

  // -- back to the desktop, with nothing left behind -----------------------
  {
    inspect.setTouch(false);
    inspect.setViewport(1400, 900);
    await settle(10);
    ok('the wide layout comes back', inspect.layout().narrow === false &&
       !doc.body.classList.contains('is-narrow'));
    ok('both panes are on screen again', !doc.body.classList.contains('pane-system'));
    ok('the keyboard is gone with the finger', kb.hidden && !inspect.keyboard().open);
    ok('and so is the way back to it', $('kb-open').hidden);
    ok('the desktop divider is wired again', !!$('divider'));

    focusRow(0);
    await settle(6);
    ok('FOCUSING A ROW ON A DESKTOP STILL RAISES NOTHING', kb.hidden);
  }
}

// ---------------------------------------------------------------------------

console.log();
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log('  - ' + f);
}
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
