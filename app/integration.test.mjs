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
async function settle(n = 40) { for (let i = 0; i < n; i++) await tick(); }
const click = (el) => dispatch(el, 'click', { type: 'click', target: el, preventDefault() {}, stopPropagation() {} });

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

// ---------------------------------------------------------------------------
// The document's own text is the source of truth
// ---------------------------------------------------------------------------

const solveStat = $('stat-solve');
ok('solve ran', solveStat && !/idle|error/i.test(solveStat.textContent),
   `status: ${solveStat && solveStat.textContent}`);
ok('the plot has a legend/readout after solving',
   ($('readout').childNodes.length > 0 || $('readout').textContent.length > 0));

// ---------------------------------------------------------------------------
// `t` is an ordinary row, not a widget
// ---------------------------------------------------------------------------

ok('there is no dedicated t slider element', $('transport') === null && $('scrub') === null);
const docText = rowEls().map((r) => r.textContent).join('\n');
ok('a t span row is present in the document',
   rowEls().some((r) => /^\s*\d*\s*t\s*=\s*[-\d]/.test(r.textContent)),
   docText.slice(0, 100).split('\n').join(' | '));

// ---------------------------------------------------------------------------
// Views are independent switches
// ---------------------------------------------------------------------------

const chips = $('views').querySelectorAll('.viewchip');
ok('three view chips', chips.length === 3);
const on = () => chips.filter((c) => c.classList.contains('is-on')).length;
const before = on();
click(chips[1]);
await settle(10);
ok('turning a second view on does not turn the first off', on() === before + 1 || on() >= 2,
   `${before} -> ${on()}`);
click(chips[1]);
await settle(10);
ok('a view can be turned back off', on() === before);

// ---------------------------------------------------------------------------
// Every demo loads, solves, and keeps its rows
// ---------------------------------------------------------------------------

const { DEMOS } = await import(new URL('./demos.js', APP).href);
click($('demos-btn'));
await settle(10);
const items = $('demomenu').querySelectorAll('.demoitem');
ok('the demo menu lists every demo', items.length === DEMOS.length,
   `${items.length} of ${DEMOS.length}`);

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
}

// ---------------------------------------------------------------------------
// Hear — the least-tested seam, and it must degrade gracefully with no audio
// ---------------------------------------------------------------------------

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
