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
// THE START SCREEN
//
// Two ways in, offered AFTER the eased loading screen and inside the app shell
// rather than in front of it: same ground, same easing, one motion. The choice
// is remembered so it asks once, and the logo is the way back to it.
// ---------------------------------------------------------------------------

const inspectEarly = globalThis.__numplaInspect;
{
  ok('the app opens on the start screen', inspectEarly.route() === 'chooser',
     inspectEarly.route());
  ok('the route is a class on <body>', doc.body.classList.contains('route-chooser'));
  ok('the chooser lives INSIDE the app shell, not in front of the loader',
     $('app').contains($('chooser')) && !$('loader').contains($('chooser')));
  ok('the top bar has already arrived under it',
     doc.querySelectorAll('.topbar').length === 1 && $('app').contains($('home-btn')));
  ok('both ways in are offered', !!$('choice-solve') && !!$('choice-compute'));
  ok('the workspace is built underneath, so choosing costs no re-measure',
     rowEls().length > 0 && $('canvas') !== null);

  // A build with no CAS must SAY so on the card rather than open a dead pane.
  if (!inspectEarly.probe().cas) {
    ok('with no CAS the Compute card is offered as unavailable',
       $('choice-compute').getAttribute('aria-disabled') === 'true');
    ok('and it names the calls it is missing',
       /cas_simplify/.test($('choice-compute-why').textContent),
       $('choice-compute-why').textContent.slice(0, 90));
    click($('choice-compute'));
    await settle(5);
    ok('pressing it opens nothing', inspectEarly.route() === 'chooser',
       inspectEarly.route());
  }

  click($('choice-solve'));
  await settle(10);
  ok('choosing solve & simulate opens the workspace',
     inspectEarly.route() === 'solve' && doc.body.classList.contains('route-solve'));
  ok('and the chooser is no longer the route',
     !doc.body.classList.contains('route-chooser'));
  ok('the choice is remembered so it does not nag on reload',
     localStorage.getItem('numpla.route') === 'solve');

  click($('home-btn'));
  await settle(5);
  ok('the logo is the way back to the chooser', inspectEarly.route() === 'chooser');
  click($('choice-solve'));
  await settle(10);
  ok('and back in again', inspectEarly.route() === 'solve');
}

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

// Two documents the suite writes for itself. Borrowing a demo for a property
// test - "this one is first-order", "this one shares a parameter across rows" -
// couples the test to a gallery that gets rewritten, and the coupling fails
// SILENTLY: the demo changes shape, the assertion still runs, and it no longer
// tests what its name says.
const SECOND_ORDER = ["x'' = -x", 'x(0) = 1', "x'(0) = 0"].join('\n');
const FIRST_ORDER = ["x' = -y", "y' = x", 'x(0) = 1', 'y(0) = 0'].join('\n');
const WAITING_DOC = [
  'k = 3',
  "x_1'' = -k x_1",
  "x_2'' = -k x_2",
  "x_3'' = -k x_3",
  'x_1(0) = 1',
  'x_2(0) = 0.8',
  'x_3(0) = 0.6',
  "x_1'(0) = 0",
  "x_2'(0) = 0",
  "x_3'(0) = 0",
].join('\n');
click($('demos-btn'));
await settle(10);
const items = $('demomenu').querySelectorAll('.demoitem');
ok('the demo menu lists every demo', items.length === DEMOS.length,
   `${items.length} of ${DEMOS.length}`);

async function loadDemoById(id) {
  const i = DEMOS.findIndex((d) => d.id === id);
  if (i < 0) return null;
  if ($('demomenu').hidden) { click($('demos-btn')); await settle(5); }
  click($('demomenu').querySelectorAll('.demoitem')[i]);
  await settleSolve();
  return DEMOS[i];
}

/**
 * A demo picked by what it IS, never by its id. The gallery gets rewritten; a
 * test that names one entry rots with it, and rots silently - the name still
 * resolves to something, and the assertion stops meaning what it says.
 */
async function loadDemoWhere(what, pred) {
  const demo = DEMOS.find(pred) || null;
  ok('the gallery still has ' + what, !!demo, DEMOS.length + ' demos');
  return demo ? loadDemoById(demo.id) : null;
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
  // Against the real numbers, not the badge's rounded text: a demo may declare
  // an irrational span (2pi, for a full turn) and the badge is a readout.
  const sp = globalThis.__numplaInspect.span();
  const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  ok(`${demo.id}: its tSpan became the span that was integrated`,
     near(sp.t0, demo.tSpan[0]) && near(sp.t1, demo.tSpan[1]),
     `${sp.t0}..${sp.t1} vs tSpan ${JSON.stringify(demo.tSpan)}`);
  const fw = globalThis.__numplaInspect.window();
  ok(`${demo.id}: and its frame`,
     near(fw.x0, demo.tSpan[0]) && near(fw.x1, demo.tSpan[1]),
     `${fw.x0}..${fw.x1} vs tSpan ${JSON.stringify(demo.tSpan)}`);
}

// ---------------------------------------------------------------------------
// `show`: a document saying what is worth looking at
// ---------------------------------------------------------------------------

const chipNames = () =>
  $('readout').querySelectorAll('.chip__name').map((n) => n.textContent);

{
  const demo = await loadDemoWhere('a demo that says what to look at',
                                   (d) => Array.isArray(d.show) && d.show.length);
  if (demo) {
    const names = chipNames();
    const states = globalThis.__numplaInspect.names().states;
    ok('show filters the legend to what the document asked for',
       JSON.stringify(names) === JSON.stringify(demo.show),
       JSON.stringify(names) + ' vs show ' + JSON.stringify(demo.show));
    ok('the states left out are still solved',
       !/error|failed/i.test($('stat-solve').textContent) &&
       names.length < states.length,
       names.length + ' drawn of ' + states.length);
  }
}

{
  // The first demo with no `show` that this build can actually compile. A demo
  // that will not parse is already reported, once, by the loop above; making
  // every later test fail again for the same reason only hides the new ones.
  let demo = null;
  for (const d of DEMOS.filter((x) => !x.show)) {
    await loadDemoById(d.id);
    if (!rowEls().some((r) => r.classList.contains('is-error'))) { demo = d; break; }
  }
  ok('the gallery still has a demo with no show list', !!demo, DEMOS.length + ' demos');
  if (demo) {
    const names = chipNames();
    const states = globalThis.__numplaInspect.names().states;
    ok('no show list means every state is in the legend',
       states.length > 0 && states.every((n) => names.indexOf(n) >= 0),
       JSON.stringify(names) + ' vs states ' + JSON.stringify(states));
  }
}

// ---------------------------------------------------------------------------
// The integrator switch — on the strip, and it actually switches
// ---------------------------------------------------------------------------

// Second-order, because the next few checks are about the symplectic methods
// and a first-order document is refused by them - which is the check AFTER
// these ones. Written here rather than inherited from whichever demo ran last.
inspectEarly.setDocument(SECOND_ORDER);
await settleSolve();

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
  // Written here rather than borrowed from the gallery: the property under test
  // is "this document is first-order", and a demo can stop being that between
  // one commit and the next, quietly disarming the test that names it.
  inspectEarly.setDocument(FIRST_ORDER);
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
  inspectEarly.setDocument(WAITING_DOC);
  await settleSolve();
  const chipsBefore = chipNames().length;
  ok('the document drew something to begin with', chipsBefore > 0);

  const kRow = rowMatching(/^k=3$/);
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
// WHAT A DEMO ARRIVES AS
//
// The complaint: "the same graph is in every view". Every view the model
// supported used to turn itself on, so the t–y curve was drawn whichever view
// you had come for. A demo now declares the one view it is ABOUT, and loading
// it turns that view on and the others off — while leaving the menu free to
// turn anything back on a moment later.
// ---------------------------------------------------------------------------

const { VIEWS } = await import(new URL('./plot.js', APP).href);

/** Did the demo currently loaded actually compile in this build? */
const docCompiles = () => !rowEls().some((r) => r.classList.contains('is-error'));

{
  const undeclared = DEMOS.filter((d) => VIEWS.indexOf(d.view) < 0);
  ok('every demo declares the one view it is about', undeclared.length === 0,
     undeclared.map((d) => d.id + ':' + d.view).join(', '));

  for (const demo of DEMOS) {
    await loadDemoById(demo.id);
    const want = VIEWS.indexOf(demo.view) >= 0 ? demo.view : 'time';
    ok(demo.id + ': loading it adopts its declared view',
       inspect.demoView().want === want,
       inspect.demoView().want + ' vs ' + want);

    // A demo this build cannot compile is already reported by the loop above;
    // its capabilities say nothing, so there is nothing here to read.
    if (!docCompiles()) continue;

    const v = inspect.views();
    const expect = v.caps[want] ? want : 'time';
    ok(demo.id + ': exactly one view is drawing', v.on.length === 1,
       JSON.stringify(v.on));
    ok(demo.id + ': and it is ' + expect, v.on[0] === expect,
       JSON.stringify(v.on) + ' — caps ' + JSON.stringify(v.caps));
  }
}

// A document nobody chose the subject of keeps the old policy: everything the
// model supports is on. Nothing here may pretend to know what it is about.
{
  inspect.setDocument(FIRST_ORDER);
  await settleSolve();
  const v = inspect.views();
  ok('a plain document still lights up everything it supports',
     v.on.length > 1 && v.on.indexOf('time') >= 0 && v.on.indexOf('phase') >= 0,
     JSON.stringify(v.on));
}

// The menu is untouched by the policy: it is still how any supported view goes
// on, and a demo's choice is arrival, not a lock.
{
  let loaded = null;
  for (const d of DEMOS) {
    await loadDemoById(d.id);
    if (docCompiles()) { loaded = d; break; }
  }
  ok('at least one demo loads in this build', !!loaded,
     loaded ? loaded.id : 'none of ' + DEMOS.length);

  if (loaded) {
    const one = inspect.views().on;
    ok('it arrived with exactly one view', one.length === 1, JSON.stringify(one));

    const caps = inspect.views().caps;
    const other = VIEWS.find((v) => v !== one[0] && caps[v]);
    if (other) {
      if ($('viewmenu').hidden) { click(viewsBtn); await settle(5); }
      click(viewItem(other));
      await settleSolve();
      const now = inspect.views().on;
      ok('the menu still turns any supported view on after a demo',
         now.indexOf(other) >= 0, JSON.stringify(now));
      ok('and the demo view is still there beside it',
         now.indexOf(one[0]) >= 0 && now.length === 2, JSON.stringify(now));
      if (!$('viewmenu').hidden) { click(viewsBtn); await settle(5); }
    }
  }
}

// ---------------------------------------------------------------------------
// NEW: an empty document and the default frame, in one press
// ---------------------------------------------------------------------------

{
  ok('the new button is in the top bar', !!$('new-btn') &&
     $('new-btn').closest('.topbar') !== null);

  // Arrive from something with rows, a moved frame, a slider and a seed.
  inspect.setDocument(WAITING_DOC);
  await settleSolve();
  ok('there is something to clear', rowEls().length > 3, rowEls().length + ' rows');

  click($('new-btn'));
  await settleSolve();

  const rs = rowEls();
  ok('NEW CLEARS TO AN EMPTY DOCUMENT',
     rs.length === 1 && rs[0].classList.contains('is-tail'),
     rs.length + ' rows: ' + rs.map((r) => r.textContent).join(' | ').slice(0, 80));
  ok('and the document really is empty', inspect.source().trim() === '',
     JSON.stringify(inspect.source()));

  const w = inspect.window();
  ok('and to the default frame',
     w.x0 === -5 && w.x1 === 5 && w.y0 === -5 && w.y1 === 5, JSON.stringify(w));
  ok('the sliders go with it', rowsHost.querySelectorAll('.knob').length === 0);
  ok('so do the seeds', inspect.seeds().length === 0, JSON.stringify(inspect.seeds()));
  ok('and the demo it came from is forgotten',
     !$('demos-btn').getAttribute('data-demo'),
     String($('demos-btn').getAttribute('data-demo')));
  ok('an empty document is not an error',
     !$('stat-solve').classList.contains('is-bad'),
     'status: ' + $('stat-solve').textContent);
  ok('nothing is drawn, and nothing is claimed',
     !rowEls().some((r) => r.classList.contains('is-error')));

  // Typing into the blank row is all it takes to be going again.
  inspect.setDocument(FIRST_ORDER);
  await settleSolve();
  ok('and it is ready to be typed into again',
     /solved/.test($('stat-solve').textContent), 'status: ' + $('stat-solve').textContent);
}

// ---------------------------------------------------------------------------
// THE COMPUTE PANE — a worksheet, not a form
//
// The second route: input, its result beneath it, then the next input — a
// scrolling document you can go back through. Commands are TYPED
// (`solve(2x = 2, x)`), `%` is the previous result, Tab completes a command
// with the caret inside its parentheses, and `equal` comes back as a choice
// list in which a numeric identification is visibly not a proof.
//
// Driven against stubs, because the pane is the shell's job and the calls are
// the crate's — the same way the field and seed calls are tested. Two stubs,
// because there are two ways in: `cas_command(line, history)`, where the crate
// reads the line, and the individual verbs, where this shell does. Both must
// work, because `app/pkg/` can be older than the crate. The last section then
// runs the whole thing against whatever the real build actually exports.
// ---------------------------------------------------------------------------

{
  // A result put back into the line goes through the parser and back out, so
  // what returns is the same EXPRESSION and not necessarily the same string:
  // `pi^2/6` comes back as `(pi^2)/(6)`. Comparing through the same round trip
  // is what makes these assertions about meaning rather than about spelling.
  const mfMod = await import(new URL('./mathfield.js', APP).href);
  const norm = (src) => mfMod.toSource(mfMod.parseSource(String(src)));

  const reply = (input, output, extra) =>
    JSON.stringify({ ok: true, input, output, ...(extra || {}) });

  // Every argument every call received, in order, so "the right thing was
  // sent" is checkable rather than inferred from the answer.
  const calls = [];
  const rec = (name, fn) => (...args) => { calls.push([name, ...args]); return fn(...args); };

  // The real shapes, from docs/wasm-api.md: a solve answers with SOLUTIONS and
  // how far each was checked; an equal answers with FORMS and what each claims.
  const SOLVE = (e, v) => JSON.stringify({
    ok: true, input: e, variable: v || 'x', method: 'quadratic formula',
    solutions: [
      { expr: '-2', verified: 'exact', value: -2 },
      { expr: 'sqrt(2)', verified: 'numeric', value: 1.4142135623730951 },
    ],
  });

  const EQUAL = (e) => JSON.stringify({
    ok: true, input: e, value: 1.6449340668482264,
    forms: [
      { expr: '1', label: 'simplify', kind: 'exact' },
      { expr: 'sqrt(1)', label: 'a half power as a square root', kind: 'exact' },
      { expr: 'ln(2) + ln(3)', label: 'the logarithm of a product',
        kind: 'conditional', condition: 'u > 0 and v > 0' },
      { expr: '1.6449340668482264', label: 'the value, to machine precision',
        kind: 'decimal' },
      { expr: 'pi^2/6', label: 'recognised from the number', kind: 'identification',
        note: 'pi squared over six, which is zeta(2) — agrees with ' +
              '1.6449340668482264 to 17 significant digits. This is a numeric ' +
              'match, not a proof.' },
    ],
  });

  // A build with every verb but NO cas_command: this shell reads the line.
  const verbCas = {
    eval:     rec('eval',     (e) => reply(e, '7')),
    evalf:    rec('evalf',    (e) => reply(e, '3.14159265')),
    solve:    rec('solve',    (e, v) => SOLVE(e, v)),
    equal:    rec('equal',    (e) => EQUAL(e)),
    simplify: rec('simplify', (e) => reply(e, '5x')),
    expand:   rec('expand',   (e) => reply(e, 'x^(2) + 2x + 1')),
    factor:   rec('factor',   (e) => reply(e, '(x + 1)^(2)')),
    diff:     rec('diff',     (e, v) => reply(e, '3' + v + '^(2)')),
    sum:      rec('sum',      (e, k, a, b) => reply(e, '2' + k)),
    product:  rec('product',  (e, k, a, b) => reply(e, '3' + k)),
    subs:     rec('subs',     (s, e) => reply(e, '9')),
  };

  // The build that shipped before any of it: the original four verbs.
  const oldCas = {
    eval: verbCas.eval, simplify: verbCas.simplify,
    expand: verbCas.expand, diff: verbCas.diff,
  };

  const real = inspect.probe().cas;
  inspect.setCasApi(verbCas);
  ok('the CAS calls are available' + (real ? ' (a real build is here too)' : ''),
     inspect.cas().available, JSON.stringify(inspect.cas().ops));
  ok('and without cas_command the SHELL reads the line',
     inspect.cas().dispatch === 'the shell', inspect.cas().dispatch);

  ok('the Compute card is live once the calls are there',
     $('choice-compute').getAttribute('aria-disabled') === 'false');
  ok('and the card names the worksheet rather than four buttons',
     /solve\(2x = 2, x\)/.test($('choice-compute-why').textContent),
     $('choice-compute-why').textContent.slice(0, 80));

  click($('choice-compute'));
  await settle(10);
  ok('choosing Compute opens the compute pane',
     inspect.route() === 'compute' && doc.body.classList.contains('route-compute'),
     inspect.route());
  ok('and the workspace is no longer the route',
     !doc.body.classList.contains('route-solve'));
  ok('the prompt is a MathField, like every other input here',
     $('compute-field').querySelectorAll('.mf').length === 1);

  const sheet = () => $('compute-log').querySelectorAll('.casitem');
  ok('the sheet starts empty and says what this is',
     sheet().length === 0 && /bare expression with no command is eval/
       .test($('compute-log').textContent),
     $('compute-log').textContent.slice(0, 70));
  ok('and the gutter is offering line 1',
     $('compute-gutter').textContent === '[1]', $('compute-gutter').textContent);

  // The shim has no descendant selectors, so reach a field through its host —
  // which is the point anyway: input and result are real MathFields.
  const partOf = (item, cls) => {
    const host = item.querySelector(cls);
    return host ? host.querySelector('.mf') : null;
  };

  // -- 1. COMMANDS ARE TYPED --------------------------------------------

  calls.length = 0;
  const e1 = inspect.runCompute('diff(x^3, x)');
  ok('TYPING A COMMAND RUNS IT', !!e1 && e1.op === 'diff' && e1.output === '3x^(2)',
     JSON.stringify(e1 && { op: e1.op, output: e1.output }));
  ok('and its arguments reach the call, in order',
     calls.length === 1 && calls[0][0] === 'diff' &&
     calls[0][1] === 'x^3' && calls[0][2] === 'x',
     JSON.stringify(calls));
  ok('the worksheet grew a line for it', sheet().length === 1);
  ok('the line is numbered', sheet()[0].dataset.n === '1', sheet()[0].dataset.n);
  ok('and the gutter has moved on to line 2',
     $('compute-gutter').textContent === '[2]', $('compute-gutter').textContent);
  ok('the input is rendered as mathematics, not as a line of text',
     partOf(sheet()[0], '.casitem__in') !== null);
  ok('and the result beneath it likewise',
     partOf(sheet()[0], '.casitem__out') !== null);

  calls.length = 0;
  const bare = inspect.runCompute('2 + 3*4');
  ok('A BARE EXPRESSION WITH NO COMMAND IS eval',
     !!bare && bare.op === 'eval' && bare.output === '7',
     JSON.stringify(bare && { op: bare.op, output: bare.output }));
  ok('and it is the whole expression that is sent, untouched',
     calls.length === 1 && calls[0][1] === '2 + 3*4', JSON.stringify(calls));

  const notACall = inspect.runCompute('solve(x) + 1');
  ok('a command that is not the whole line is read as an expression',
     notACall.op === 'eval', notACall.op);

  calls.length = 0;
  const inferred = inspect.runCompute('solve(2x = 2)');
  ok('the unknown may be left out', inferred.op === 'solve' && !inferred.error,
     JSON.stringify({ op: inferred.op, error: inferred.error }));
  ok('and it is inferred from the expression, not guessed silently',
     calls[0][2] === 'x' &&
     inspect.cas().log.find((e) => e.n === inferred.n).inferred === 'x',
     JSON.stringify(calls));

  calls.length = 0;
  const wrongArity = inspect.runCompute('sum(k, k)');
  ok('a command called with the wrong number of arguments refuses by signature',
     !!wrongArity.error && /sum\(k, k, 1, n\)/.test(wrongArity.error) &&
     /4 arguments/.test(wrongArity.error), wrongArity.error);
  ok('and nothing was sent to the CAS for it', calls.length === 0);

  calls.length = 0;
  inspect.runCompute('sum(k, k, 1, n)');
  ok('and with the right number it goes through with all four',
     calls.length === 1 && calls[0].slice(1).join('|') === 'k|k|1|n',
     JSON.stringify(calls));

  // -- 2. % — THE DITTO OPERATOR ----------------------------------------

  const dittoNow = () => inspect.cas().ditto;

  ok('% is the previous result',
     dittoNow()[0] &&
     dittoNow()[0].n === inspect.cas().log.filter((e) => e.output).pop().n,
     JSON.stringify(dittoNow()[0]));
  ok('%% is the one before, and %%% the one before that',
     dittoNow()[1] && dittoNow()[2] &&
     dittoNow()[0].n > dittoNow()[1].n && dittoNow()[1].n > dittoNow()[2].n,
     JSON.stringify(dittoNow()));
  ok('and the three of them are results, never refused lines',
     dittoNow().every((d) => {
       const e = inspect.cas().log.find((x) => x.n === d.n);
       return e && e.output && !e.error;
     }), JSON.stringify(dittoNow()));

  const prevOut = dittoNow()[0].output;
  const prevSrc = dittoNow()[0].source;
  const sub1 = inspect.expandDitto('solve(% = 12)');
  ok('% IS SUBSTITUTED BEFORE THE LINE IS SENT',
     sub1.text === 'solve(' + prevSrc + ' = 12)' && sub1.missing === 0,
     JSON.stringify(sub1));
  const sub2 = inspect.expandDitto('%% + %');
  ok('and %% and % resolve to different results',
     sub2.text === dittoNow()[1].source + ' + ' + prevSrc,
     JSON.stringify(sub2));

  calls.length = 0;
  const dittoRun = inspect.runCompute('solve(% = 12)');
  ok('SO diff(x^3, x) THEN solve(% = 12) RETYPES NOTHING',
     dittoRun.op === 'solve' && calls[0][1] === prevSrc + ' = 12',
     JSON.stringify(calls));
  ok('and the line the sheet keeps is the substituted one',
     dittoRun.input === 'solve(' + prevSrc + ' = 12)', dittoRun.input);

  // WHAT % MEANS AFTER A FAILURE: it does not move. A refusal produced no
  // expression, so the ditto steps straight over it — Maple's own behaviour.
  const beforeFail = dittoNow()[0].n;
  const failed = inspect.runCompute('solve(2x = 2, x, x)');
  ok('a refused line is still written into the worksheet',
     !!failed.error && !failed.output, failed.error);
  ok('AFTER A FAILURE % DOES NOT MOVE — IT STEPS OVER THE REFUSAL',
     dittoNow()[0] && dittoNow()[0].n === beforeFail,
     JSON.stringify(dittoNow()[0]));
  ok('and the refusal is on its own line, marked as one',
     sheet()[sheet().length - 1].classList.contains('is-error') &&
     sheet()[sheet().length - 1].querySelector('.casitem__err') !== null);

  const tooFar = inspect.expandDitto('%%%%');
  ok('% never reaches further back than Maple lets it', tooFar.missing === 4,
     JSON.stringify(tooFar));
  const tooFarRun = inspect.runCompute('%%%% + 1');
  ok('and asking it to says so, in a sentence',
     !!tooFarRun.error && /%/.test(tooFarRun.error), tooFarRun.error);

  // The `%` key itself. `%` is not a character a math field types — it is not
  // mathematics — so the pane claims the key before the field ever sees it.
  inspect.clearCas();
  dispatch($('compute-field'), 'keydown', { key: '%' });
  await settle(5);
  ok('THE % KEY ITSELF SUBSTITUTES THE PREVIOUS RESULT',
     inspect.cas().input === norm(dittoNow()[0].source),
     JSON.stringify(inspect.cas().input));
  dispatch($('compute-field'), 'keydown', { key: '%' });
  await settle(5);
  ok('and pressing the key again walks back, it does not stack a second copy',
     inspect.cas().input === norm(dittoNow()[1].source),
     JSON.stringify(inspect.cas().input));
  ok('and the pane says which entry it reached',
     /^%% is \[\d+\]/.test($('compute-foot').textContent),
     $('compute-foot').textContent.slice(0, 40));

  inspect.clearCas();
  const d1 = inspect.pressDitto(null);
  ok('PRESSING % PUTS THE PREVIOUS RESULT IN THE LINE',
     d1.level === 1 && d1.input === norm(dittoNow()[0].source),
     JSON.stringify(d1));
  const d2 = inspect.pressDitto(null);
  ok('and pressing it again walks back to %%',
     d2.level === 2 && d2.input === norm(dittoNow()[1].source),
     JSON.stringify(d2));
  const d3 = inspect.pressDitto(null);
  ok('and again to %%%',
     d3.level === 3 && d3.input === norm(dittoNow()[2].source),
     JSON.stringify(d3));

  // The chips reach the same three levels, which is how a phone gets there:
  // there is no `%` on a mathematics keyboard.
  const dittoChips = () => $('compute-ops').querySelectorAll('.casop--ditto');
  ok('the strip carries the three ditto keys', dittoChips().length === 3,
     dittoChips().map((b) => b.textContent).join(' '));
  inspect.clearCas();
  click(dittoChips()[1]);
  await settle(5);
  ok('and tapping %% reaches the second result',
     inspect.cas().input === norm(dittoNow()[1].source),
     inspect.cas().input);

  // -- 3. TAB COMPLETION, THROUGH THE FIELD'S OWN MACHINERY --------------

  inspect.clearCas();
  inspect.typeCas('sol');
  ok('the signature is shown while you are choosing',
     /solve\(2x = 2, x\)/.test(inspect.cas().sig), inspect.cas().sig);

  const tabbed = inspect.tabCas();
  ok('TAB COMPLETES A COMMAND', tabbed.input === 'solve()', JSON.stringify(tabbed));
  const caret = inspect.casCaret();
  ok('WITH THE CARET INSIDE THE PARENTHESES',
     !!caret && caret.path.length === 1 && caret.path[0][1] === 'body' &&
     caret.index === 0, JSON.stringify(caret));
  inspect.typeCas('2');
  ok('so the next thing typed lands inside the call',
     inspect.cas().input === 'solve(2)', inspect.cas().input);
  ok('and the signature follows the caret into the call',
     /solve\(2x = 2, x\)/.test(inspect.cas().sig), inspect.cas().sig);

  inspect.clearCas();
  inspect.typeCas('ev');
  inspect.tabCas();
  ok('an ambiguous prefix does not pick for you',
     inspect.cas().input !== 'eval()', inspect.cas().input);
  ok('and the signature strip offers every match',
     /evalf\(e\)/.test(inspect.cas().sig) && /eval\(e\)/.test(inspect.cas().sig),
     inspect.cas().sig);

  inspect.clearCas();
  const before = inspect.cas().log.length;
  const chip = $('compute-ops').querySelectorAll('.casop')
    .find((b) => b.dataset.op === 'factor');
  click(chip);
  await settle(5);
  ok('A COMMAND CHIP TYPES THE COMMAND, IT DOES NOT RUN IT',
     inspect.cas().input === 'factor()' && inspect.cas().log.length === before,
     inspect.cas().input);
  ok('and it leaves the caret inside the parentheses too',
     inspect.casCaret().path.length === 1 && inspect.casCaret().index === 0,
     JSON.stringify(inspect.casCaret()));

  // An EQUATION inside a command. The field's own rule is that `=` splits a
  // row, so typing one steps out of whatever structure the caret is in — right
  // for `dx/dt = -y`, wrong for `solve(2x = 2, x)`. In the worksheet the
  // equation is an argument, and it stays where it was typed.
  inspect.clearCas();
  inspect.typeCas('sol');
  inspect.tabCas();
  inspect.typeCas('2x = 2, x');
  ok('AN EQUATION CAN BE TYPED INSIDE A COMMAND',
     inspect.cas().input === 'solve(2x = 2, x)', JSON.stringify(inspect.cas().input));
  calls.length = 0;
  inspect.enterCompute();
  ok('and it reaches the call as two arguments, equation and unknown',
     calls.length === 1 && calls[0][1] === '2x = 2' && calls[0][2] === 'x',
     JSON.stringify(calls));

  inspect.clearCas();
  inspect.typeCas('x^2 = 3');
  ok('while an = outside a command still splits the line, as the field says',
     inspect.cas().input === 'x^(2) = 3', JSON.stringify(inspect.cas().input));

  // Tab into a command, then `%` INSIDE its parentheses: the ditto splices
  // into whatever list the caret is standing in, not onto the end of the line.
  inspect.clearCas();
  inspect.typeCas('sol');
  inspect.tabCas();
  inspect.pressDitto(1);
  inspect.typeCas(' = 12');
  ok('TAB THEN % BUILDS solve(% = 12) WITH NOTHING RETYPED',
     inspect.cas().input === norm('solve(' + dittoNow()[0].source + ' = 12)'),
     JSON.stringify(inspect.cas().input));
  calls.length = 0;
  inspect.enterCompute();
  ok('and running it sends the substituted equation, not a %',
     calls.length === 1 && calls[0][0] === 'solve' && !/%/.test(calls[0][1]),
     JSON.stringify(calls));

  // -- 4. ENTER RUNS THE LINE -------------------------------------------

  inspect.clearCas();
  inspect.typeCas('evalf(');
  inspect.typeCas('pi');
  const linesBefore = sheet().length;
  const entered = inspect.enterCompute();
  ok('ENTER RUNS THE LINE', !!entered && entered.op === 'evalf' &&
     entered.output === '3.14159265', JSON.stringify(entered));
  ok('and the worksheet grew by exactly one', sheet().length === linesBefore + 1);
  ok('and the prompt is empty, ready for the next line',
     inspect.cas().input === '', JSON.stringify(inspect.cas().input));

  inspect.typeCas('2');
  click($('compute-run'));
  await settle(5);
  ok('the enter button runs the line too', sheet().length === linesBefore + 2);

  // -- 5. GOING BACK THROUGH THE DOCUMENT --------------------------------

  const last = sheet()[sheet().length - 1];
  const use = last.querySelector('.casitem__use');
  ok('a result offers to go back into the line', !!use && !use.hidden);
  click(use);
  await settle(5);
  ok('A RESULT ROUND-TRIPS BACK INTO THE LINE',
     inspect.cas().input === '7', JSON.stringify(inspect.cas().input));

  inspect.clearCas();
  click(last.querySelector('.casitem__out'));
  await settle(5);
  ok('EVERY RESULT IS SELECTABLE: clicking the answer inserts it',
     inspect.cas().input === '7', JSON.stringify(inspect.cas().input));

  const edit = last.querySelector('.casitem__edit');
  ok('and the input of an old line is one click away too', !!edit);
  click(edit);
  await settle(5);
  ok('AN OLD LINE CAN BE PULLED BACK INTO THE PROMPT',
     inspect.cas().input === '2', JSON.stringify(inspect.cas().input));

  // -- 6. equal — THE CHOICE LIST, AND WHAT EACH FORM CLAIMS -------------

  inspect.clearCas();
  const eqBeforeDitto = dittoNow()[0].n;
  const eq = inspect.runCompute('equal(1^(1/2))');
  ok('equal COMES BACK AS A LIST OF CANDIDATE FORMS',
     !!eq.forms && eq.forms.length === 5, JSON.stringify(eq.forms && eq.forms.length));

  const eqItem = sheet()[sheet().length - 1];
  const forms = () => eqItem.querySelectorAll('.casform');
  const kindRow = (k) => forms().find((f) => f.dataset.kind === k);
  const textOf = (row, cls) => {
    const n = row.querySelector(cls);
    return n ? n.textContent : null;
  };

  ok('and the list is rendered, one row per form', forms().length === 5,
     forms().length + ' rows');
  ok('every form carries the label that says how it was obtained',
     forms().every((f) => (textOf(f, '.casform__label') || '').length > 0),
     forms().map((f) => textOf(f, '.casform__label')).join(' / '));
  ok('and every form is rendered as mathematics',
     forms().every((f) => partOf(f, '.casform__math') !== null));

  ok('THE FOUR CLAIMS ARE RENDERED APART',
     forms().map((f) => f.dataset.kind).join(',') ===
       'exact,exact,conditional,decimal,identification',
     forms().map((f) => f.dataset.kind).join(','));

  ok('an exact form is an equals sign, and says only "exact"',
     textOf(kindRow('exact'), '.casform__rel') === '=' &&
     textOf(kindRow('exact'), '.casform__flag') === 'exact');

  ok('A CONDITIONAL FORM CARRIES ITS CONDITION, NEVER WITHOUT IT',
     textOf(kindRow('conditional'), '.casform__flag') === 'where u > 0 and v > 0',
     textOf(kindRow('conditional'), '.casform__flag'));

  ok('a decimal is written with ≈, and says it is an approximation',
     textOf(kindRow('decimal'), '.casform__rel') === '≈' &&
     kindRow('decimal').classList.contains('is-approx') &&
     textOf(kindRow('decimal'), '.casform__flag') === 'an approximation',
     textOf(kindRow('decimal'), '.casform__flag'));

  const ident = () => kindRow('identification');
  ok('A NUMERIC IDENTIFICATION IS MARKED AS ONE', !!ident());
  ok('and it is NOT written as an equality',
     textOf(ident(), '.casform__rel') === '≈' &&
     ident().classList.contains('is-approx'),
     textOf(ident(), '.casform__rel'));
  ok('and it says in words that it is not a proof',
     /not a proven identity/.test(textOf(ident(), '.casform__flag')),
     textOf(ident(), '.casform__flag'));
  ok("and it shows the crate's own sentence about what it agreed to",
     /This is a numeric match, not a proof/.test(textOf(ident(), '.casform__note')),
     String(textOf(ident(), '.casform__note')).slice(0, 60));
  ok('a screen reader is told what the relation is, not left a glyph',
     ident().querySelector('.casform__rel').getAttribute('aria-label') ===
       'approximately equal' &&
     kindRow('exact').querySelector('.casform__rel').getAttribute('aria-label') ===
       'equals');

  ok('the pane says how many of them are only numeric',
     /1 of them numeric identifications, not proofs/.test($('compute-foot').textContent),
     $('compute-foot').textContent.slice(0, 100));

  // ...and counts in English rather than in template slots: a list of one
  // identification is "a numeric identification, not a proof".
  inspect.setCasApi({ ...verbCas, equal: () => JSON.stringify({ ok: true, forms: [
    { expr: 'pi^2/6', label: 'recognised from the number', kind: 'identification' },
  ] }) });
  inspect.runCompute('equal(1.6449340668482264)');
  ok('and a single one is a numeric identification, not "1 of them"',
     /a numeric identification, not a proof/.test($('compute-foot').textContent),
     $('compute-foot').textContent.slice(0, 100));
  inspect.setCasApi(verbCas);

  // PICKING ONE PUTS IT IN THE INPUT.
  click(forms()[1].querySelector('.casform__use'));
  await settle(5);
  ok('PICKING A FORM PUTS IT INTO THE LINE',
     inspect.cas().input === 'sqrt(1)', JSON.stringify(inspect.cas().input));

  click(ident().querySelector('.casform__use'));
  await settle(5);
  ok('and picking the numeric one says so as it lands',
     inspect.cas().input === norm('pi^2/6') &&
     /NUMERIC identification, not a proven identity/.test($('compute-foot').textContent),
     $('compute-foot').textContent.slice(0, 100));
  ok('the pick is recorded as an identification, not as an identity',
     inspect.cas().lastPick && inspect.cas().lastPick.kind === 'identification',
     JSON.stringify(inspect.cas().lastPick));

  click(kindRow('conditional').querySelector('.casform__use'));
  await settle(5);
  ok('and picking a conditional one repeats its condition',
     /valid where u > 0 and v > 0/.test($('compute-foot').textContent),
     $('compute-foot').textContent.slice(0, 100));

  ok('equal does not move % — a list is not a result',
     dittoNow()[0] && dittoNow()[0].n === eqBeforeDitto,
     JSON.stringify(dittoNow()[0]));

  // An empty list is an ANSWER — there was no other way of writing it — and
  // saying "no answer" would be a different, wrong claim.
  inspect.setCasApi({ ...verbCas, equal: () => JSON.stringify({ ok: true, forms: [] }) });
  const noForms = inspect.runCompute('equal(2x)');
  ok('an equal with no alternatives says there were none, and is not an error',
     !noForms.error && /no other way of writing it/.test(noForms.note || ''),
     JSON.stringify(noForms));

  // A reply that spells its candidates some other way is still read: a shell
  // that hard-codes one spelling of a shape breaks on a build it was not
  // compiled against.
  inspect.setCasApi({
    ...verbCas,
    equal: () => JSON.stringify({ ok: true, candidates: [
      { output: 'x + x', how: 'expand' },
      { output: '1.4142135', numeric: true, label: 'looks like sqrt(2)' },
      '2x',
    ] }),
  });
  const loose = inspect.runCompute('equal(2x)');
  ok('a differently-spelled candidate list is still read',
     !!loose.forms && loose.forms.length === 3, JSON.stringify(loose.forms));
  ok('a bare string candidate is taken as an expression',
     loose.forms[2].expr === '2x', JSON.stringify(loose.forms[2]));
  ok('and "numeric" spelled another way is still an identification',
     loose.forms[1].kind === 'identification' && loose.forms[0].kind === 'unknown',
     loose.forms.map((f) => f.kind).join(', '));
  ok('a candidate that claims neither claims NEITHER — no invented exactness',
     sheet()[sheet().length - 1].querySelectorAll('.casform')
       .filter((f) => f.dataset.kind === 'exact').length === 0);
  inspect.setCasApi(verbCas);

  // The label says where a form came from and the badge says what it is worth.
  // When the label has already said it, saying it twice reads as a stutter.
  inspect.setCasApi({ ...verbCas, equal: () => JSON.stringify({ ok: true, forms: [
    { expr: '1', label: 'exact, by the Pythagorean identity', kind: 'exact' },
  ] }) });
  inspect.runCompute('equal(sin(x)^2 + cos(x)^2)');
  ok('and a badge that only repeats the label is dropped, not stuttered',
     sheet()[sheet().length - 1].querySelector('.casform__flag') === null,
     String(sheet()[sheet().length - 1].textContent).slice(0, 90));
  inspect.setCasApi(verbCas);

  // -- 7. solve — THE SOLUTIONS ARE A LIST TOO ---------------------------

  inspect.clearCas();
  const sol = inspect.runCompute('solve(x^2 = 4, x)');
  ok('a solve answers with its solutions, as rows to pick from',
     !!sol.forms && sol.forms.length === 2, JSON.stringify(sol.forms));
  ok('and % after a solve is still an EXPRESSION — a list when there are several',
     sol.output === '[-2, sqrt(2)]', JSON.stringify(sol.output));
  const solItem = sheet()[sheet().length - 1];
  const solRows = () => solItem.querySelectorAll('.casform');
  ok('each solution says how far it was checked',
     solRows().map((r) => r.dataset.kind).join(',') === 'exact,checked',
     solRows().map((r) => r.dataset.kind).join(','));
  ok('a root checked only numerically says so, and is still an equality',
     textOf(solRows()[1], '.casform__flag') === 'checked numerically' &&
     textOf(solRows()[1], '.casform__rel') === '=',
     textOf(solRows()[1], '.casform__flag'));
  ok('and each solution is labelled with the method that found it',
     textOf(solRows()[0], '.casform__label') === 'quadratic formula',
     textOf(solRows()[0], '.casform__label'));
  click(solRows()[0].querySelector('.casform__use'));
  await settle(5);
  ok('and one root can be taken on its own', inspect.cas().input === '-2',
     JSON.stringify(inspect.cas().input));

  // An empty list with ok: true means there are NONE. That is an answer.
  inspect.setCasApi({ ...verbCas, solve: () => JSON.stringify({
    ok: true, input: 'x^2 = -1', variable: 'x', solutions: [],
    method: 'quadratic formula' }) });
  const none = inspect.runCompute('solve(x^2 = -1, x)');
  ok('NO SOLUTIONS IS AN ANSWER, NOT A REFUSAL',
     !none.error && /no solutions/.test(none.note || ''), JSON.stringify(none));
  ok('and it is not drawn as an error',
     !sheet()[sheet().length - 1].classList.contains('is-error') &&
     /no solutions/.test(sheet()[sheet().length - 1].textContent));

  // `x = x`: the list is not the answer and must not be shown as one.
  inspect.setCasApi({ ...verbCas, solve: () => JSON.stringify({
    ok: true, input: 'x = x', variable: 'x', everyValue: true,
    solutions: [{ expr: '0', verified: 'exact' }] }) });
  const every = inspect.runCompute('solve(x = x, x)');
  ok('everyValue is not shown as a solution list',
     !every.forms && !every.output && /every value of x/.test(every.note || ''),
     JSON.stringify(every));

  // What the answer assumes is shown. An assumption you cannot see is one you
  // cannot check.
  inspect.setCasApi({ ...verbCas, solve: () => JSON.stringify({
    ok: true, input: 'a x = b', variable: 'x', method: 'linear',
    note: 'assuming a is not zero',
    solutions: [{ expr: 'b/a', verified: 'exact' }] }) });
  const assumed = inspect.runCompute('solve(a x = b, x)');
  ok('AN ASSUMPTION IS SHOWN, NOT SWALLOWED',
     /assuming a is not zero/.test(assumed.note || '') &&
     sheet()[sheet().length - 1].querySelector('.casitem__note') !== null,
     JSON.stringify(assumed.note));
  inspect.setCasApi(verbCas);

  // -- 8. cas_command — THE CRATE READS THE LINE -------------------------
  //
  // When the build can dispatch a whole line, the shell hands it the line and
  // the history and switches on the `command` that comes back. That is one
  // reading of a worksheet line, in the crate, instead of two that can drift.

  const seenLines = [];
  const commandCas = {
    ...verbCas,
    command: (line, history) => {
      seenLines.push([line, history]);
      if (/^equal\(/.test(line)) {
        return JSON.stringify({ command: 'equal', source: line,
                                reply: JSON.parse(EQUAL(line)) });
      }
      if (/^solve\(/.test(line)) {
        return JSON.stringify({ command: 'solve', source: 'solve((3x^2) = 12, x)',
                                reply: JSON.parse(SOLVE('(3x^2) = 12', 'x')) });
      }
      return JSON.stringify({ command: 'eval', source: line,
                              reply: { ok: true, input: line, output: '14' } });
    },
    commands: () => JSON.stringify([
      { name: 'solve', signature: 'solve(equation, var)' },
      { name: 'eval', signature: 'eval(e)' },
      { name: 'zeta', signature: 'zeta(s)' },
    ]),
  };

  inspect.setCasApi(commandCas);
  await settle(5);
  ok('WHEN THE BUILD CAN DISPATCH A LINE, THE CRATE READS IT',
     inspect.cas().dispatch === 'cas_command', inspect.cas().dispatch);
  ok('and the verb list comes FROM THE MODULE', inspect.cas().listed);
  ok("so the module's own signature is what the pane shows",
     inspect.cas().commands.find((c) => c.id === 'solve').sig ===
       'solve(equation, var)',
     JSON.stringify(inspect.cas().commands.find((c) => c.id === 'solve')));
  ok('a verb only the module knows is offered anyway',
     inspect.cas().commands.some((c) => c.id === 'zeta') &&
     !!$('compute-ops').querySelectorAll('.casop').find((b) => b.dataset.op === 'zeta'),
     inspect.cas().commands.map((c) => c.id).join(','));
  inspect.clearCas();
  inspect.typeCas('zet');
  inspect.tabCas();
  ok('AND IT COMPLETES, WITHOUT AN EDIT TO THIS SHELL',
     inspect.cas().input === 'zeta()', JSON.stringify(inspect.cas().input));

  inspect.clearCas();
  seenLines.length = 0;
  calls.length = 0;
  const viaCmd = inspect.runCompute('diff(x^3, x)');
  ok('a line goes to cas_command whole, exactly as typed',
     seenLines.length === 1 && seenLines[0][0] === 'diff(x^3, x)' &&
     calls.length === 0, JSON.stringify(seenLines));
  ok('and the reply is read by the COMMAND it names, not by sniffing fields',
     viaCmd.op === 'eval' && viaCmd.output === '14',
     JSON.stringify({ op: viaCmd.op, output: viaCmd.output }));

  seenLines.length = 0;
  inspect.runCompute('solve(% = 12, x)');
  const history = JSON.parse(seenLines[0][1]);
  ok('THE HISTORY IS HANDED OVER, MOST RECENT FIRST',
     Array.isArray(history) && history[0] === '14',
     JSON.stringify(history));
  ok('and the line the sheet keeps is the SOURCE the crate substituted',
     inspect.cas().log[inspect.cas().log.length - 1].input ===
       'solve((3x^2) = 12, x)',
     inspect.cas().log[inspect.cas().log.length - 1].input);
  ok('and a solve reply is read as solutions even through cas_command',
     (inspect.cas().log[inspect.cas().log.length - 1].forms || []).length === 2);

  inspect.setCasApi({ command: () => 'not json at all' });
  const cmdGarbage = inspect.runCompute('2 + 2');
  ok('a cas_command that does not answer in JSON is a refusal, not a crash',
     !!cmdGarbage.error && /JSON/.test(cmdGarbage.error), cmdGarbage.error);
  inspect.setCasApi({ command: () => { throw new Error('boom'); } });
  const cmdThrew = inspect.runCompute('2 + 2');
  ok('and one that throws likewise',
     !!cmdThrew.error && /cas_command\(\)/.test(cmdThrew.error), cmdThrew.error);

  // -- 9. A CALL MISSING FROM THE BUILD ----------------------------------

  inspect.setCasApi(oldCas);
  await settle(5);
  ok('a build with only the original four still opens the pane',
     inspect.cas().available && inspect.cas().ops.length === 4,
     JSON.stringify(inspect.cas().ops));
  ok('and the header names what it is missing, by its Rust name',
     /no cas_/.test($('compute-note').textContent),
     $('compute-note').textContent.slice(0, 90));
  ok('but it does not shout about it — an old build is a fact, not a fault',
     !$('compute-note').classList.contains('is-bad'));

  const solveChip = () => $('compute-ops').querySelectorAll('.casop')
    .find((b) => b.dataset.op === 'solve');
  ok('a command the build lacks is offered as unavailable, not hidden',
     !!solveChip() && solveChip().getAttribute('aria-disabled') === 'true');
  ok('and the chip says which call would turn it on',
     /cas_solve\(\)/.test(solveChip().title), solveChip().title);

  const noSolve = inspect.runCompute('solve(2x = 2, x)');
  ok('A MISSING CALL REFUSES BY NAME AND DOES NOT THROW',
     !!noSolve.error && /cas_solve\(\)/.test(noSolve.error), noSolve.error);
  ok('and the commands that ARE there still work',
     inspect.runCompute('diff(x^3, x)').output === '3x^(2)');

  inspect.setCasApi({ ...oldCas, diff: () => { throw new Error('boom'); },
                      simplify: () => 'not json at all' });
  const threw = inspect.runCompute('diff(x^3, x)');
  ok('a call that throws becomes a refusal, not a blank screen',
     !!threw.error && /cas_diff\(\)/.test(threw.error), threw.error);
  const garbage = inspect.runCompute('simplify(2x)');
  ok('and a reply that is not JSON says exactly that',
     !!garbage.error && /JSON/.test(garbage.error), garbage.error);

  // gray, not red: a half-typed expression is unfinished, never wrong.
  inspect.setCasApi({ ...oldCas,
    eval: (e) => JSON.stringify({ ok: false, pending: true, input: e,
                                  error: 'expected an expression' }) });
  const pend = inspect.runCompute('2 +');
  ok('an unfinished expression is pending, not an error',
     !!pend.pending && !sheet()[sheet().length - 1].classList.contains('is-error') &&
     sheet()[sheet().length - 1].classList.contains('is-pending'),
     JSON.stringify(pend));
  ok('and the pane does not shout about it',
     !$('compute-foot').classList.contains('is-bad'),
     $('compute-foot').textContent.slice(0, 60));
  inspect.setCasApi(verbCas);

  // -- 10. THE WORKSHEET AS A DOCUMENT -----------------------------------

  const ordered = inspect.cas().log;
  ok('the worksheet keeps every line, oldest first',
     ordered.length > 5 && ordered.every((e, i) => i === 0 || e.n > ordered[i - 1].n),
     ordered.map((e) => e.n).join(','));
  ok('and the sheet draws them in the same order',
     sheet().map((i) => Number(i.dataset.n)).join(',') ===
       ordered.map((e) => e.n).join(','));

  // LAYOUT STABILITY: the prompt, the signature line, the strip and the foot
  // are all outside the scroller, so a result arriving cannot move the line
  // you are typing into. The sheet is the only thing that grows.
  const promptEls = ['compute-gutter', 'compute-field', 'compute-run',
                     'compute-sig', 'compute-ops', 'compute-foot'];
  ok('the prompt lives outside the scroller, so results cannot move it',
     promptEls.every((id) => {
       const node = $(id);
       for (let p = node; p; p = p.parentNode) if (p.id === 'compute-log') return false;
       return !!node;
     }), promptEls.join(', '));
  ok('and the sheet is the scroller',
     $('compute-log').classList.contains('compute__sheet'));

  click($('compute-clear'));
  await settle(5);
  ok('the worksheet can be emptied',
     sheet().length === 0 && inspect.cas().log.length === 0);
  ok('and the numbering starts again at one',
     $('compute-gutter').textContent === '[1]', $('compute-gutter').textContent);
  ok('with nothing for % to reach',
     inspect.cas().ditto.every((d) => d === null), JSON.stringify(inspect.cas().ditto));
  const orphan = inspect.runCompute('% + 1');
  ok('and % says so rather than sending a half-substituted line',
     !!orphan.error && /previous result/.test(orphan.error), orphan.error);

  ok('the compute route is remembered too',
     localStorage.getItem('numpla.route') === 'compute',
     String(localStorage.getItem('numpla.route')));

  // -- 11. THE REFERENCE IS WHERE THE COMMANDS ARE LISTED ----------------

  if ($('info-btn')) {
    click($('info-btn'));
    await settle(10);
    $('info-search').value = 'evalf';
    dispatch($('info-search'), 'input', { type: 'input', target: $('info-search') });
    await settle(5);
    ok('THE COMMANDS ARE IN THE REFERENCE, NOT IN A SECOND PLACE',
       $('info-list').querySelectorAll('.entry').length > 0 &&
       /evalf\(e\)/.test($('info-list').textContent),
       $('info-list').textContent.slice(0, 90));

    $('info-search').value = 'ditto';
    dispatch($('info-search'), 'input', { type: 'input', target: $('info-search') });
    await settle(5);
    ok('and so is the ditto operator, with what it does after a failure',
       /steps\s+straight over it/.test($('info-list').textContent),
       $('info-list').textContent.slice(0, 120));

    $('info-search').value = 'solve(';
    dispatch($('info-search'), 'input', { type: 'input', target: $('info-search') });
    await settle(5);
    inspect.clearCas();
    const solveEntry = $('info-list').querySelectorAll('.entry')
      .find((e) => /solve\(2x = 2, x\)/.test(e.textContent));
    ok('the reference offers to write a command into the worksheet', !!solveEntry);
    if (solveEntry) {
      // The entry itself, not its button: the shim has no real event
      // propagation, so a click on the button would reach both.
      click(solveEntry);
      await settle(5);
      ok('AND INSERTING FROM IT TYPES INTO THE LINE, NOT INTO THE DOCUMENT',
         inspect.cas().input === 'solve()' && inspect.route() === 'compute',
         JSON.stringify(inspect.cas().input));
    }
    if (!$('infopanel').hidden) { click($('info-close')); await settle(5); }
  }

  // -- 12. THE PHONE FOLLOWS INTO THE WORKSHEET --------------------------

  const wasTouch = inspect.touch().on;
  inspect.setTouch(true);
  inspect.setKeyboard(true);
  await settle(5);
  ok('the math keyboard follows into the worksheet', inspect.keyboard().open);
  inspect.clearCas();
  inspect.press('7');
  await settle(5);
  ok('and it types into the prompt',
     inspect.cas().input === '7', JSON.stringify(inspect.cas().input));
  const kbBefore = inspect.cas().log.length;
  inspect.press('newrow');
  await settle(5);
  ok('and ITS Enter runs the line, since there is no row below',
     inspect.cas().log.length === kbBefore + 1 && inspect.cas().input === '',
     JSON.stringify({ n: inspect.cas().log.length, input: inspect.cas().input }));
  inspect.setKeyboard(false);
  inspect.setTouch(wasTouch ? true : null);
  await settle(5);

  // -- 13. AND ON THE REAL BUILD -----------------------------------------
  //
  // Everything above is a stub, because the pane is the shell's job. This is
  // not: it drives the worksheet through whatever app/pkg/ actually exports,
  // so "the commands are typed" is proved against the real CAS.

  inspect.setCasApi(null);
  if (real) {
    click($('choice-compute'));
    await settle(10);
    click($('compute-clear'));
    await settle(5);
    inspect.clearCas();

    const rd = inspect.runCompute('diff(x^3, x)');
    ok('the REAL build answers a typed diff() line',
       !!rd && !rd.error && rd.output.length > 0,
       JSON.stringify(rd && { op: rd.op, output: rd.output, error: rd.error }));
    const re = inspect.runCompute('2 + 3*4');
    ok('and a bare expression is eval, on the real thing too',
       !!re && re.op === 'eval' && re.output === '14',
       JSON.stringify(re && { op: re.op, output: re.output }));
    const rp = inspect.runCompute('simplify(% + 1)');
    ok('and % carries the real answer into the next real line',
       !!rp && !rp.error && /14/.test(rp.input), JSON.stringify(rp));

    const rs = inspect.runCompute('solve(2x = 2, x)');
    ok('the REAL solve answers with its solutions',
       !!rs && !rs.error && (rs.forms || []).length === 1 && rs.output === '1',
       JSON.stringify(rs && { output: rs.output, forms: rs.forms }));

    const rq = inspect.runCompute('equal(1^(1/2))');
    ok('the REAL equal answers with a choice list',
       !!rq && (rq.forms || []).length >= 2,
       JSON.stringify(rq && rq.forms));
    ok('and every one of its forms is exact, so every one is an equals sign',
       (rq.forms || []).every((f) => f.kind === 'exact'),
       (rq.forms || []).map((f) => f.kind).join(','));

    const rid = inspect.runCompute('equal(1.6449340668482264)');
    const idForm = (rid.forms || []).find((f) => f.kind === 'identification');
    ok('THE REAL INVERSE LOOKUP COMES BACK AS AN IDENTIFICATION, NOT AN IDENTITY',
       !!idForm && /not a proof/.test(idForm.note || ''),
       JSON.stringify(rid && rid.forms));
    ok('and the pane draws it with ≈ rather than =',
       (() => {
         const row = sheet()[sheet().length - 1]
           .querySelectorAll('.casform').find((f) => f.dataset.kind === 'identification');
         return !!row && row.querySelector('.casform__rel').textContent === '≈';
       })());

    ok('the REAL build lists its own verbs, so the strip comes from the module',
       inspect.cas().listed && inspect.cas().dispatch === 'cas_command',
       JSON.stringify({ listed: inspect.cas().listed, dispatch: inspect.cas().dispatch }));

    click($('compute-clear'));
    await settle(5);
  }

  // -- 14. AND WHEN THE BUILD HAS NONE OF THE CALLS ----------------------

  inspect.setCasApi(false);
  await settle(5);
  ok('losing the calls does not strand you in a dead pane',
     inspect.route() === 'solve', inspect.route());
  ok('the Compute card goes back to unavailable',
     $('choice-compute').getAttribute('aria-disabled') === 'true');
  ok('and it names the calls it wants',
     /cas_simplify/.test($('choice-compute-why').textContent),
     $('choice-compute-why').textContent.slice(0, 80));

  click($('home-btn'));
  await settle(5);
  click($('choice-compute'));
  await settle(5);
  ok('and the card cannot be pressed into a dead pane',
     inspect.route() === 'chooser', inspect.route());

  // Back to a working state for whatever comes next.
  inspect.setCasApi(verbCas);
  click($('choice-solve'));
  await settle(10);
  ok('and back to solve & simulate', inspect.route() === 'solve');
  inspect.setCasApi(null);
}

// ---------------------------------------------------------------------------

console.log();
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log('  - ' + f);
}
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
