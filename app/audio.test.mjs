// Verification for the render-to-sound module — `node app/audio.test.mjs`.
//
// The whole point of `audio.js` is that the sample-making arithmetic is plain
// JavaScript over plain arrays, so all of it runs here with no browser and no
// Web Audio. Three things get checked:
//
//   1. the buffer is well formed  — length, no NaN, no DC, normalised, faded
//   2. it is the REAL signal      — a known oscillator, integrated by the real
//                                   WASM solver, must come out with exactly as
//                                   many zero crossings as its frequency says
//   3. playback behaves           — lazy AudioContext, stop, and no context
//                                   left running afterwards (driven by a fake)
//
// (2) is the one that matters. Anything can produce a normalised buffer;
// producing one whose zero crossings match cos(w t) means the samples are the
// solution and not decoration.

import { readFileSync } from 'node:fs';
import * as wasm from './pkg/numpla_wasm.js';
import {
  DEFAULTS,
  SoundPlayer,
  audioContextClass,
  audioPlan,
  conditionSamples,
  isSupported,
  renderModel,
  renderSamples,
  renderSignal,
  resample,
  stateIndex,
} from './audio.js';

wasm.initSync({
  module: readFileSync(new URL('./pkg/numpla_wasm_bg.wasm', import.meta.url)),
});

// --- tiny test harness ------------------------------------------------------

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write('.');
  } catch (e) {
    failures.push({ name, message: e && e.message ? e.message : String(e) });
    process.stdout.write('F');
  }
}

function ok(cond, message) {
  if (!cond) throw new Error(message);
}

function close(got, want, tol, message) {
  ok(
    Number.isFinite(got) && Math.abs(got - want) <= tol,
    `${message}: got ${got}, wanted ${want} +/- ${tol}`
  );
}

function throws(fn, needle, message) {
  let caught = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  ok(caught !== null, `${message}: nothing was thrown`);
  ok(
    String(caught.message).includes(needle),
    `${message}: message was ${JSON.stringify(caught.message)}, wanted ${JSON.stringify(needle)}`
  );
}

// --- measurements -----------------------------------------------------------

const maxAbs = (v) => v.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;

/** Sign changes: for a wave, twice the number of cycles. */
function zeroCrossings(v) {
  let n = 0;
  for (let i = 1; i < v.length; i++) if (v[i - 1] < 0 !== v[i] < 0) n += 1;
  return n;
}

function allFinite(v) {
  for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return false;
  return true;
}

/** A cosine at `f` Hz, as a reader. */
const cosine = (f, offset = 0, amp = 1) => (t) => offset + amp * Math.cos(2 * Math.PI * f * t);

// =============================================================================
// 1. The plan: window, compression and sample rate decide the length
// =============================================================================

await test('compression maps simulation seconds onto audio seconds', () => {
  const plan = audioPlan({ window: [0, 10], compression: 5, sampleRate: 8000 });
  close(plan.duration, 2, 1e-12, '10 simulation seconds at 5x is 2 seconds of audio');
  ok(plan.frames === 16000, `expected 16000 frames, got ${plan.frames}`);
  ok(!plan.clipped, 'nothing should have been cut');
  ok(plan.window[0] === 0 && plan.window[1] === 10, 'the whole window is used');
});

await test('a different compression is a different length, same window', () => {
  const slow = audioPlan({ window: [3, 23], compression: 1, sampleRate: 1000 });
  const fast = audioPlan({ window: [3, 23], compression: 40, sampleRate: 1000 });
  ok(slow.frames === 20000, `slow: ${slow.frames}`);
  ok(fast.frames === 500, `fast: ${fast.frames}`);
});

await test('maxSeconds shortens the window rather than bending the mapping', () => {
  const plan = audioPlan({ window: [0, 100], compression: 1, maxSeconds: 2, sampleRate: 1000 });
  close(plan.duration, 2, 1e-12, 'capped at maxSeconds');
  ok(plan.clipped, 'it must say it clipped');
  close(plan.window[1], 2, 1e-12, 'one audio second is still one simulation second');
});

await test('the defaults are the documented ones', () => {
  const plan = audioPlan({ window: [0, 20] });
  ok(plan.sampleRate === DEFAULTS.sampleRate, 'sample rate');
  ok(plan.compression === DEFAULTS.compression, 'compression');
  close(plan.duration, 1, 1e-3, '20 simulation seconds at 20x is a second of audio');
});

await test('a nonsense plan is refused with a clear message', () => {
  throws(() => audioPlan({ window: [5, 5] }), 'run forwards', 'an empty window');
  throws(() => audioPlan({ window: [0, 1], compression: 0 }), 'compression', 'zero compression');
  throws(() => audioPlan({ window: [0, 1], sampleRate: -3 }), 'sample rate', 'a negative rate');
});

// =============================================================================
// 2. Resampling
// =============================================================================

await test('resampling hits both endpoints exactly', () => {
  const seen = [];
  resample((t) => {
    seen.push(t);
    return t;
  }, [2, 6], 5);
  ok(seen.length === 5, `asked for 5 points, read ${seen.length}`);
  close(seen[0], 2, 1e-12, 'starts at t0');
  close(seen[4], 6, 1e-12, 'ends at t1');
  close(seen[2], 4, 1e-12, 'evenly spaced');
});

await test('a signal that blows up is reported, not played', () => {
  throws(() => resample(() => NaN, [0, 1], 8), 'nothing to play', 'a NaN signal');
  throws(() => resample(() => Infinity, [0, 1], 8), 'nothing to play', 'an infinite signal');
});

// =============================================================================
// 3. Conditioning: DC, normalisation, fades
// =============================================================================

await test('the DC offset is removed', () => {
  const raw = resample(cosine(5, 17.5), [0, 1], 4410);
  ok(Math.abs(mean(raw)) > 17, 'the raw signal really does sit at 17.5');
  const { samples } = conditionSamples(raw, { sampleRate: 4410, fade: 0 });
  ok(Math.abs(mean(samples)) < 1e-6, `mean after DC removal was ${mean(samples)}`);
});

await test('an asymmetric signal is centred too, not just scaled', () => {
  // Two thirds of the time at -1, one third at +1: mean -1/3.
  const raw = new Float64Array(3000);
  for (let i = 0; i < raw.length; i++) raw[i] = i % 3 === 0 ? 1 : -1;
  const { samples } = conditionSamples(raw, { sampleRate: 1000, fade: 0 });
  close(mean(samples), 0, 1e-6, 'the mean must be pulled to zero');
});

await test('the result is normalised to the peak, and never past it', () => {
  const raw = resample(cosine(3, 0, 0.004), [0, 2], 8000);
  const { samples } = conditionSamples(raw, { sampleRate: 4000, fade: 0, peak: 0.9 });
  close(maxAbs(samples), 0.9, 1e-6, 'a quiet signal is brought up to the peak');

  const loud = resample(cosine(3, 0, 900), [0, 2], 8000);
  const out = conditionSamples(loud, { sampleRate: 4000, fade: 0, peak: 0.9 }).samples;
  close(maxAbs(out), 0.9, 1e-6, 'a loud signal is brought down to the peak');
  for (let i = 0; i < out.length; i++) ok(Math.abs(out[i]) <= 0.9 + 1e-6, 'nothing may clip');
});

await test('the fades reach exactly zero at both ends', () => {
  const raw = resample(cosine(50), [0, 1], 44100);
  const { samples, fadeFrames } = conditionSamples(raw, { sampleRate: 44100, fade: 0.005 });
  ok(fadeFrames === 221, `expected 221 fade frames at 5 ms, got ${fadeFrames}`);
  ok(samples[0] === 0, `the first sample is ${samples[0]}, not 0 — that is a click`);
  ok(samples[samples.length - 1] === 0, `the last sample is ${samples[samples.length - 1]}`);
  // Inside the ramp the envelope really is rising, and past it, it is not.
  const head = maxAbs(samples.slice(0, fadeFrames));
  const tail = maxAbs(samples.slice(-fadeFrames));
  const body = maxAbs(samples.slice(fadeFrames, -fadeFrames));
  ok(head < body, `the head is not faded: ${head} vs ${body}`);
  ok(tail < body, `the tail is not faded: ${tail} vs ${body}`);
  close(body, 0.9, 1e-6, 'the body keeps the full normalised amplitude');
});

await test('a fade of zero leaves the ends alone', () => {
  const raw = resample(cosine(50), [0, 1], 4410);
  const { samples, fadeFrames } = conditionSamples(raw, { sampleRate: 4410, fade: 0 });
  ok(fadeFrames === 0, 'no fade frames');
  ok(samples[0] !== 0, 'the first sample keeps its value');
});

await test('a flat signal comes out silent rather than as amplified rounding', () => {
  const raw = new Float64Array(1000).fill(4.25);
  const { samples, silent } = conditionSamples(raw, { sampleRate: 1000 });
  ok(silent, 'it must report the silence');
  ok(maxAbs(samples) === 0, 'and produce actual zeros');
  ok(allFinite(samples), 'with no NaN from dividing by nothing');
});

await test('conditioning refuses what it cannot condition', () => {
  throws(() => conditionSamples([1], {}), 'at least 2 samples', 'one sample');
  throws(() => conditionSamples([1, NaN, 2], {}), 'sample 1 is NaN', 'a NaN in the input');
  throws(() => conditionSamples([1, 2], { peak: 2 }), 'peak', 'a peak above 1');
  throws(() => conditionSamples([1, 2], { fade: -1 }), 'fade', 'a negative fade');
});

// =============================================================================
// 4. renderSignal / renderSamples end to end
// =============================================================================

await test('renderSignal reports what it actually made', () => {
  const r = renderSignal(cosine(2), { window: [0, 8], compression: 4, sampleRate: 8000 });
  ok(r.samples.length === r.frames, 'samples and frames must agree');
  ok(r.frames === 16000, `2 seconds at 8 kHz is 16000 frames, got ${r.frames}`);
  close(r.duration, 2, 1e-9, 'two seconds of audio');
  ok(r.sampleRate === 8000 && r.compression === 4, 'the settings come back');
  ok(allFinite(r.samples), 'no NaN or Infinity anywhere in the buffer');
  ok(!r.silent && !r.clipped, 'a cosine is neither silent nor clipped');
});

await test('renderSamples plays an array that is already sampled', () => {
  const n = 2001;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = Math.cos((2 * Math.PI * 5 * i) / (n - 1));
  const r = renderSamples(values, { window: [0, 1], compression: 0.5, sampleRate: 8000 });
  close(r.duration, 2, 1e-9, '1 simulation second at 0.5x is 2 audio seconds');
  ok(allFinite(r.samples), 'no NaN');
  // 5 cycles of cosine over the window, whatever the audio grid.
  close(zeroCrossings(r.samples), 10, 0, 'five cycles is ten sign changes');
});

// =============================================================================
// 5. THE ONE THAT MATTERS: a real solution, listened to
//
// x'' = -w^2 x, x(0) = 1, x'(0) = 0  is  x(t) = cos(w t)  exactly. Over a
// window of T simulation seconds at f = w/2pi cycles per second there are
// 2 f T zero crossings, and the buffer must have precisely that many.
//
// Note the count does not depend on the compression: compression is a change
// of playback rate, so it moves the pitch and not the waveform. Both are
// checked, because a renderer that fabricated a tone would have no reason to
// keep that true.
// =============================================================================

/** Solve x'' = -w^2 x over [0, span] and hand back the model. */
function oscillator(f, span) {
  const model = new wasm.Model();
  const w = 2 * Math.PI * f;
  const diagnostics = JSON.parse(
    model.set_source(`w = ${w.toFixed(15)}\nx'' = -w^2 x\nx(0) = 1\nx'(0) = 0`)
  );
  const report = JSON.parse(model.solve(0, span));
  ok(report.ok, `the oscillator failed to solve: ${report.error}`);
  return { model, states: diagnostics.states };
}

await test('a known oscillator renders with the right number of zero crossings', () => {
  const F = 3;
  const T = 20;
  const { model, states } = oscillator(F, T);
  const r = renderModel(model, {
    state: 'x',
    states,
    window: [0, T],
    compression: 20,
    sampleRate: 44100,
  });
  ok(allFinite(r.samples), 'no NaN or Infinity in a rendered solution');
  close(r.duration, 1, 1e-3, '20 simulation seconds at 20x is one audio second');
  close(zeroCrossings(r.samples), 2 * F * T, 2, `${F} Hz over ${T} s is ${2 * F * T} crossings`);
});

await test('the audible frequency is the simulated one times the compression', () => {
  const F = 3;
  const T = 20;
  const { model, states } = oscillator(F, T);
  for (const compression of [5, 20, 50]) {
    const r = renderModel(model, { state: 'x', states, window: [0, T], compression });
    // The waveform is untouched: same crossings, whatever the playback rate.
    close(zeroCrossings(r.samples), 2 * F * T, 2, `crossings at ${compression}x`);
    // And the pitch is the simulated pitch, stretched by the compression.
    const heardHz = zeroCrossings(r.samples) / 2 / r.duration;
    close(heardHz, F * compression, 1, `${compression}x should sound like ${F * compression} Hz`);
  }
});

await test('listening to a different state hears a different signal', () => {
  const { model, states } = oscillator(2, 10);
  const opts = { states, window: [0, 10], compression: 10, sampleRate: 16000 };
  const x = renderModel(model, { ...opts, state: 'x' });
  const v = renderModel(model, { ...opts, state: "x'" });
  ok(x.samples.length === v.samples.length, 'same length');
  // Position and velocity are a quarter cycle apart, so they are never equal
  // sample for sample even though they have the same frequency.
  close(zeroCrossings(v.samples), zeroCrossings(x.samples), 2, 'same frequency');
  let differ = 0;
  for (let i = 0; i < x.samples.length; i++) {
    if (Math.abs(x.samples[i] - v.samples[i]) > 0.05) differ += 1;
  }
  ok(differ > x.samples.length * 0.5, 'x and x-prime must not render to the same buffer');
});

await test('a sub-window renders only that part of the solution', () => {
  const F = 4;
  const { model, states } = oscillator(F, 20);
  const r = renderModel(model, { state: 'x', states, window: [5, 10], compression: 5 });
  close(r.duration, 1, 1e-3, '5 simulation seconds at 5x is one second');
  close(zeroCrossings(r.samples), 2 * F * 5, 2, 'only the crossings inside the window');
});

await test('a demo document renders to sound', async () => {
  const { DEMOS } = await import('./demos.js');
  const demo = DEMOS.find((d) => d.id === 'colliding-strings');
  const model = new wasm.Model();
  const diagnostics = JSON.parse(model.set_source(demo.source));
  const report = JSON.parse(model.solve(demo.tSpan[0], demo.tSpan[1]));
  ok(report.ok, `the demo failed to solve: ${report.error}`);
  const r = renderModel(model, {
    state: 'a_2',
    states: diagnostics.states,
    window: demo.tSpan,
    compression: 12,
  });
  ok(allFinite(r.samples), 'a collision must not render NaN');
  ok(maxAbs(r.samples) > 0.5, 'and it must be audible');
  ok(!r.silent, 'a struck string is not silent');
});

await test('renderModel says what is wrong instead of guessing', () => {
  throws(() => renderModel(null, {}), 'eval(t)', 'no model');
  throws(() => renderModel(new wasm.Model(), {}), 'no solution', 'an unsolved model');
  const { model, states } = oscillator(1, 5);
  throws(
    () => renderModel(model, { state: 'nope', states, window: [0, 5] }),
    'no state named',
    'a state that does not exist'
  );
  throws(
    () => renderModel(model, { state: 9, window: [0, 5] }),
    'out of range',
    'an index past the end'
  );
});

await test('stateIndex takes a name or an index', () => {
  ok(stateIndex(2, ['a', 'b', 'c']) === 2, 'an index passes through');
  ok(stateIndex('c', ['a', 'b', 'c']) === 2, 'a name is looked up');
  ok(stateIndex(undefined, ['a']) === 0, 'the default is the first state');
  throws(() => stateIndex('a'), 'states list', 'a name with no states list');
  throws(() => stateIndex(-1, ['a']), 'non-negative', 'a negative index');
});

// =============================================================================
// 6. Playback, driven by a fake AudioContext
// =============================================================================

class FakeSource {
  constructor(ctx) {
    this.ctx = ctx;
    this.buffer = null;
    this.onended = null;
    this.started = false;
    this.stopped = false;
    this.connected = 0;
  }
  connect() {
    this.connected += 1;
  }
  disconnect() {
    this.connected -= 1;
  }
  start() {
    this.started = true;
    this.ctx.started += 1;
  }
  stop() {
    if (!this.started) throw new Error('not started');
    this.stopped = true;
  }
}

class FakeContext {
  constructor({ sampleRate } = {}) {
    this.sampleRate = sampleRate || 44100;
    this.state = 'running';
    this.destination = {};
    this.started = 0;
    this.sources = [];
    FakeContext.made += 1;
  }
  createBuffer(channels, length, sampleRate) {
    const data = new Float32Array(length);
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData: () => data,
    };
  }
  createBufferSource() {
    const s = new FakeSource(this);
    this.sources.push(s);
    return s;
  }
  async resume() {
    this.state = 'running';
  }
  async suspend() {
    this.state = 'suspended';
  }
  async close() {
    this.state = 'closed';
  }
}
FakeContext.made = 0;

const tone = renderSignal(cosine(220), { window: [0, 1], compression: 1, sampleRate: 8000 });

await test('Node has no Web Audio, and the module says so plainly', () => {
  ok(audioContextClass() === null, 'there is no AudioContext here');
  ok(isSupported() === false, 'so isSupported must be false');
});

await test('play without Web Audio fails with an explanation, not a TypeError', async () => {
  const player = new SoundPlayer();
  let message = '';
  try {
    await player.play(tone);
  } catch (e) {
    message = e.message;
  }
  ok(message.includes('Web Audio is not available'), `message was ${JSON.stringify(message)}`);
  ok(message.includes('renderModel'), 'and it should point at what still works');
});

await test('the AudioContext is created on the first play, not before', async () => {
  const before = FakeContext.made;
  const player = new SoundPlayer({ AudioContextClass: FakeContext });
  ok(FakeContext.made === before, 'constructing a player must not open the audio device');
  ok(player.playing === false, 'and nothing is playing');
  await player.play(tone);
  ok(FakeContext.made === before + 1, 'one context, made on demand');
  ok(player.playing === true, 'and it is playing');
  ok(player.sampleRate === tone.sampleRate, 'at the rate the buffer was rendered for');
  await player.dispose();
});

await test('the samples handed to Web Audio are the samples rendered', async () => {
  const player = new SoundPlayer({ AudioContextClass: FakeContext });
  await player.play(tone);
  const source = player._ctx.sources[0];
  ok(source.started, 'the source must actually be started');
  ok(source.connected === 1, 'and connected to the destination');
  const data = source.buffer.getChannelData(0);
  ok(data.length === tone.samples.length, 'same length');
  let same = true;
  for (let i = 0; i < data.length; i += 37) if (data[i] !== tone.samples[i]) same = false;
  ok(same, 'the buffer must carry the rendered samples, unmodified');
  await player.dispose();
});

await test('a second play replaces the first', async () => {
  const player = new SoundPlayer({ AudioContextClass: FakeContext });
  await player.play(tone);
  const first = player._ctx.sources[0];
  await player.play(tone);
  ok(first.stopped, 'the first source must be stopped');
  ok(player._ctx.sources.length === 2, 'and a second one started');
  ok(player.playing === true, 'still playing');
  await player.dispose();
});

await test('stop is immediate, idempotent, and suspends the context', async () => {
  const player = new SoundPlayer({ AudioContextClass: FakeContext, idleMs: 0 });
  await player.play(tone);
  player.stop();
  ok(player.playing === false, 'stopped');
  player.stop();
  player.stop();
  await Promise.resolve();
  await Promise.resolve();
  ok(player._ctx.state === 'suspended', `context was left ${player._ctx.state}`);
  await player.dispose();
});

await test('reaching the end of the buffer suspends the context and fires onended', async () => {
  const player = new SoundPlayer({ AudioContextClass: FakeContext, idleMs: 0 });
  let ended = 0;
  await player.play(tone, { onended: () => (ended += 1) });
  const ctx = player._ctx;
  ctx.sources[0].onended();
  ok(ended === 1, 'the callback must fire exactly once');
  ok(player.playing === false, 'and the player knows it stopped');
  await Promise.resolve();
  await Promise.resolve();
  ok(ctx.state === 'suspended', `context was left ${ctx.state}`);
  await player.dispose();
});

await test('an idle player closes its context rather than holding the device', async () => {
  const player = new SoundPlayer({ AudioContextClass: FakeContext, idleMs: 5 });
  await player.play(tone);
  const ctx = player._ctx;
  player.stop();
  await new Promise((r) => setTimeout(r, 40));
  ok(ctx.state === 'closed', `after idling the context was ${ctx.state}`);
  ok(player._ctx === null, 'and the player is holding nothing');
  await player.dispose();
});

await test('dispose closes the context and the player still works afterwards', async () => {
  const player = new SoundPlayer({ AudioContextClass: FakeContext });
  await player.play(tone);
  const ctx = player._ctx;
  await player.dispose();
  ok(ctx.state === 'closed', `dispose left the context ${ctx.state}`);
  ok(player._ctx === null, 'and dropped it');
  await player.dispose();
  await player.play(tone);
  ok(player.playing === true, 'a disposed player can be used again');
  await player.dispose();
});

await test('a buffer rendered at another rate gets its own context', async () => {
  const player = new SoundPlayer({ AudioContextClass: FakeContext });
  await player.play(tone);
  const first = player._ctx;
  const other = renderSignal(cosine(220), { window: [0, 1], compression: 1, sampleRate: 22050 });
  await player.play(other);
  ok(player._ctx !== first, 'the 8 kHz context cannot play a 22.05 kHz buffer honestly');
  ok(first.state === 'closed', 'and the old one is closed, not leaked');
  ok(player.sampleRate === 22050, 'the new context runs at the new rate');
  await player.dispose();
});

await test('playModel is the two-line path', async () => {
  const { model, states } = oscillator(5, 10);
  const player = new SoundPlayer({ AudioContextClass: FakeContext });
  const rendered = await player.playModel(model, {
    state: 'x',
    states,
    window: [0, 10],
    compression: 10,
  });
  ok(rendered.samples.length > 0, 'it hands back what it played');
  close(zeroCrossings(rendered.samples), 100, 2, '5 Hz over 10 s is 100 crossings');
  ok(player.playing === true, 'and it is playing');
  await player.dispose();
});

await test('an empty buffer is refused before any device is opened', async () => {
  const player = new SoundPlayer({ AudioContextClass: FakeContext });
  let message = '';
  try {
    await player.play({ samples: new Float32Array(0), sampleRate: 8000 });
  } catch (e) {
    message = e.message;
  }
  ok(message.includes('nothing to play'), `message was ${JSON.stringify(message)}`);
  ok(player._ctx === null, 'and no context was opened for it');
});

// --- report -----------------------------------------------------------------

process.stdout.write('\n');
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL  ${f.name}\n      ${f.message}`);
  console.error(`\n${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`${passed} passed — audio renders the real signal`);
