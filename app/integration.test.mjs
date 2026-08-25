// Integration test: boot the REAL main.js against the REAL WASM, from the REAL
// index.html, and drive it the way a person would.
//
// Why this exists: every bug the user has reported so far — the demo loader
// doing nothing, the `t` slider being inert — was invisible to the unit suites
// because each piece worked in isolation and the seam between them did not.
// Unit tests prove the parts; this proves the app.

import { readFileSync } from 'node:fs';
import { install, buildFromHtml, doc, dispatch } from './dom-shim.mjs';

const APP = new URL('./', import.meta.url);
const p = (rel) => new URL(rel, APP).pathname.replace(/^\/([A-Za-z]:)/, '$1');

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
async function settleSolve() { await wait(260); await settle(40); }

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
ok('it lists every view', viewItems().length === 3, `${viewItems().length}`);
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

console.log();
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log('  - ' + f);
}
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
