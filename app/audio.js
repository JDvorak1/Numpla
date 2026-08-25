// Render to sound.
//
// VISION.md asks for a real waveform, not the Desmos trick of a sine whose
// pitch tracks the y-axis. So this module takes the *actual solution* of a
// model, resamples it densely onto an audio grid, and hands the browser real
// samples. If the string rings at 40 Hz in simulation time, what you hear is
// that ring — every overtone, every collision transient, exactly as solved.
//
// The one thing that has to be chosen for you is TIME COMPRESSION: how many
// simulation seconds go into one audio second. A trajectory over t in [0, 20]
// is twenty seconds of mostly-inaudible wobble; at a compression of 20 it is
// one second of sound an octave-ish structure you can actually hear. That
// mapping is the honest version of a pitch control — it stretches the whole
// spectrum by a known factor instead of inventing a tone.
//
//   audio second s  <->  simulation time  t0 + s * compression
//
// WIRING IT UP (the whole of it):
//
//   import { SoundPlayer } from './audio.js';
//   const player = new SoundPlayer();          // no AudioContext yet
//   ...
//   // inside a click handler, so the browser lets audio start:
//   await player.playModel(model, {
//     state: 'x_3', states: diagnostics.states, // or state: 4 by index
//     window: demo.tSpan,                       // defaults to the solved span
//     compression: 20,                          // sim seconds per audio second
//   });
//   player.stop();                              // and later
//   await player.dispose();                     // closes the AudioContext
//
// `playModel` returns the Rendered object it played, so the same samples can
// be drawn, measured or re-played without solving again.
//
// TESTING. Everything above `SoundPlayer` is pure arithmetic over plain
// arrays and runs in Node with no Web Audio at all — that is what
// `audio.test.mjs` exercises. `SoundPlayer` is the only part that touches the
// browser, and it takes its AudioContext class as an option so even it can be
// driven by a fake.

/** @typedef {(t: number) => number} Reader a signal, readable at any time */

/**
 * @typedef {object} RenderOptions
 * @property {number|string} [state]   state index, or a name (needs `states`)
 * @property {string[]} [states]       the state vector order, from Diagnostics
 * @property {[number, number]} [window]  simulation times to listen to
 * @property {number} [compression]    simulation seconds per audio second
 * @property {number} [sampleRate]     audio frames per second
 * @property {number} [fade]           seconds of fade at each end
 * @property {number} [peak]           normalisation target, 0 < peak <= 1
 * @property {number} [maxSeconds]     hard cap on how long the sound may be
 *
 * @typedef {object} Rendered
 * @property {Float32Array} samples    mono, in [-peak, peak], both ends at 0
 * @property {number} sampleRate
 * @property {number} frames
 * @property {number} duration         seconds of audio
 * @property {[number, number]} window simulation span actually rendered
 * @property {number} compression      simulation seconds per audio second
 * @property {number} peak
 * @property {boolean} clipped         true if `maxSeconds` cut the window short
 * @property {boolean} silent          true if the signal was flat (all zeros)
 */

/** Defaults, in one place so the UI can show them. */
export const DEFAULTS = Object.freeze({
  compression: 20,
  sampleRate: 44100,
  fade: 0.005,
  peak: 0.9,
  maxSeconds: 20,
});

/** Below this the signal is flat and normalising it would amplify rounding. */
const SILENCE = 1e-12;

/**
 * Resolve `state` to an index into the state vector.
 * @param {number|string|undefined} state
 * @param {string[]|undefined} states
 * @returns {number}
 */
export function stateIndex(state, states) {
  if (state === undefined || state === null) return 0;
  if (typeof state === 'number') {
    if (!Number.isInteger(state) || state < 0) {
      throw new Error(`audio: state index must be a non-negative integer, got ${state}`);
    }
    return state;
  }
  if (!Array.isArray(states)) {
    throw new Error(`audio: listening to "${state}" by name needs the states list`);
  }
  const i = states.indexOf(state);
  if (i < 0) throw new Error(`audio: no state named "${state}" (have ${states.join(', ')})`);
  return i;
}

/**
 * How long the sound is, and how much of the window fits inside `maxSeconds`.
 *
 * Compression maps simulation time onto audio time, so a 12-second window at
 * a compression of 20 is 0.6 s of sound. When that would run past
 * `maxSeconds` the WINDOW is shortened rather than the mapping bent, so a
 * second of audio always means the same number of simulation seconds.
 *
 * @param {RenderOptions} [options]
 * @returns {{frames: number, duration: number, window: [number, number],
 *            compression: number, sampleRate: number, clipped: boolean}}
 */
export function audioPlan(options = {}) {
  const sampleRate = options.sampleRate ?? DEFAULTS.sampleRate;
  const compression = options.compression ?? DEFAULTS.compression;
  const maxSeconds = options.maxSeconds ?? DEFAULTS.maxSeconds;
  const [t0, t1] = options.window ?? [0, 1];

  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) {
    throw new Error(`audio: sample rate must be positive, got ${sampleRate}`);
  }
  if (!(compression > 0) || !Number.isFinite(compression)) {
    throw new Error(`audio: time compression must be positive, got ${compression}`);
  }
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || !(t1 > t0)) {
    throw new Error(`audio: the window must run forwards, got [${t0}, ${t1}]`);
  }

  const wanted = (t1 - t0) / compression;
  const duration = Math.min(wanted, maxSeconds);
  const clipped = duration < wanted;
  const end = clipped ? t0 + duration * compression : t1;
  const frames = Math.max(2, Math.round(duration * sampleRate));

  return {
    frames,
    duration: frames / sampleRate,
    window: [t0, end],
    compression,
    sampleRate,
    clipped,
  };
}

/**
 * Read a signal at `frames` points spread evenly across `[t0, t1]`, endpoints
 * included. This is the dense resampling: the solver is asked for the value at
 * every audio frame, so nothing is interpolated twice.
 *
 * @param {Reader} readAt
 * @param {[number, number]} window
 * @param {number} frames
 * @returns {Float64Array}
 */
export function resample(readAt, [t0, t1], frames) {
  if (!Number.isInteger(frames) || frames < 2) {
    throw new Error(`audio: need at least 2 frames, got ${frames}`);
  }
  const out = new Float64Array(frames);
  const dt = (t1 - t0) / (frames - 1);
  for (let i = 0; i < frames; i++) {
    const v = readAt(t0 + i * dt);
    if (!Number.isFinite(v)) {
      throw new Error(`audio: the signal is ${v} at t = ${t0 + i * dt}; nothing to play`);
    }
    out[i] = v;
  }
  return out;
}

/**
 * Turn raw signal values into audio samples: remove the DC offset, normalise
 * to `peak`, and fade both ends so the buffer starts and stops at exactly
 * zero (a buffer that begins at 0.7 makes a click, every time).
 *
 * Order matters. DC first, because normalising an offset signal wastes half
 * the headroom on the offset; fades last, because a fade applied before
 * normalisation would be scaled back out again.
 *
 * @param {ArrayLike<number>} values
 * @param {{sampleRate?: number, fade?: number, peak?: number}} [options]
 * @returns {{samples: Float32Array, silent: boolean, fadeFrames: number}}
 */
export function conditionSamples(values, options = {}) {
  const sampleRate = options.sampleRate ?? DEFAULTS.sampleRate;
  const fade = options.fade ?? DEFAULTS.fade;
  const peak = options.peak ?? DEFAULTS.peak;
  const n = values.length;

  if (n < 2) throw new Error(`audio: need at least 2 samples, got ${n}`);
  if (!(peak > 0) || peak > 1) throw new Error(`audio: peak must be in (0, 1], got ${peak}`);
  if (!(fade >= 0) || !Number.isFinite(fade)) {
    throw new Error(`audio: fade must be a non-negative number of seconds, got ${fade}`);
  }

  // DC: the mean of the signal is a constant the speaker cannot render and
  // the ear cannot hear, but it eats headroom and thumps on the way in.
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) throw new Error(`audio: sample ${i} is ${v}`);
    mean += v;
  }
  mean /= n;

  const centred = new Float64Array(n);
  let loudest = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i] - mean;
    centred[i] = v;
    const a = v < 0 ? -v : v;
    if (a > loudest) loudest = a;
  }

  const samples = new Float32Array(n);
  const silent = loudest <= SILENCE;
  const gain = silent ? 0 : peak / loudest;

  // A raised cosine, so the ramp leaves and arrives with zero slope: gentler
  // than a straight line and still exactly 0 at the very first and last frame.
  const fadeFrames = Math.min(Math.max(Math.round(fade * sampleRate), 0), Math.floor(n / 2));
  const ramp = (i) => (i >= fadeFrames ? 1 : 0.5 * (1 - Math.cos((Math.PI * i) / fadeFrames)));

  for (let i = 0; i < n; i++) {
    const shape = fadeFrames > 0 ? ramp(i) * ramp(n - 1 - i) : 1;
    samples[i] = centred[i] * gain * shape;
  }

  return { samples, silent, fadeFrames };
}

/**
 * Render any readable signal to audio.
 * @param {Reader} readAt
 * @param {RenderOptions} [options]
 * @returns {Rendered}
 */
export function renderSignal(readAt, options = {}) {
  const plan = audioPlan(options);
  const raw = resample(readAt, plan.window, plan.frames);
  const peak = options.peak ?? DEFAULTS.peak;
  const { samples, silent } = conditionSamples(raw, {
    sampleRate: plan.sampleRate,
    fade: options.fade,
    peak,
  });
  return {
    samples,
    sampleRate: plan.sampleRate,
    frames: plan.frames,
    duration: plan.duration,
    window: plan.window,
    compression: plan.compression,
    peak,
    clipped: plan.clipped,
    silent,
  };
}

/**
 * Render one state of a solved Numpla model.
 *
 * The model is read through `eval(t)` — the solver's own dense output — once
 * per audio frame, rather than through `sample(n)` plus interpolation. `eval`
 * is a few hundred nanoseconds, so a second of 44.1 kHz audio costs about
 * 15 ms, and what comes out is the solution rather than a piecewise-linear
 * drawing of it. `sample(n)` also fixes its own uniform grid over the whole
 * integrated span, which cannot express a sub-window.
 *
 * @param {{eval: (t: number) => ArrayLike<number>}} model
 * @param {RenderOptions} [options]
 * @returns {Rendered}
 */
export function renderModel(model, options = {}) {
  if (!model || typeof model.eval !== 'function') {
    throw new Error('audio: renderModel needs a Numpla Model with an eval(t) method');
  }
  const index = stateIndex(options.state, options.states);
  const probe = model.eval(options.window ? options.window[0] : 0);
  if (!probe || probe.length === 0) {
    throw new Error('audio: the model has no solution to listen to — solve it first');
  }
  if (index >= probe.length) {
    throw new Error(`audio: state ${index} is out of range, the model has ${probe.length}`);
  }
  return renderSignal((t) => model.eval(t)[index], options);
}

/**
 * Render an already-sampled signal — values taken at uniform times across
 * `window`. Use this when the samples are in hand (a `Model.sample()` column,
 * a recorded trace) and there is nothing left to ask the solver for.
 *
 * The values are resampled onto the audio grid by linear interpolation, so
 * give it at least a couple of points per audio frame if the signal is fast.
 *
 * @param {ArrayLike<number>} values
 * @param {RenderOptions} [options]
 * @returns {Rendered}
 */
export function renderSamples(values, options = {}) {
  const n = values.length;
  if (n < 2) throw new Error(`audio: need at least 2 samples, got ${n}`);
  const [t0, t1] = options.window ?? [0, 1];
  const step = (t1 - t0) / (n - 1);
  const readAt = (t) => {
    const x = (t - t0) / step;
    const i = Math.min(n - 2, Math.max(0, Math.floor(x)));
    const f = Math.min(1, Math.max(0, x - i));
    return values[i] * (1 - f) + values[i + 1] * f;
  };
  return renderSignal(readAt, options);
}

// ---------------------------------------------------------------------------
// Playback. The only part that needs a browser.
// ---------------------------------------------------------------------------

/**
 * The AudioContext constructor, or null where there is none (Node, an old
 * browser, a locked-down embed).
 * @param {Function} [override]
 * @returns {Function|null}
 */
export function audioContextClass(override) {
  if (typeof override === 'function') return override;
  const g = /** @type {any} */ (globalThis);
  return g.AudioContext || g.webkitAudioContext || null;
}

/** @returns {boolean} whether `play` has any chance of working here. */
export function isSupported(override) {
  return audioContextClass(override) !== null;
}

const UNSUPPORTED =
  'Web Audio is not available here, so there is nothing to play the samples ' +
  'through. The rendering still works — renderModel() returns the samples.';

/**
 * Plays Rendered buffers, and owns the one AudioContext.
 *
 * The context is created on the FIRST play and not before, because a context
 * built outside a user gesture starts suspended in every current browser. It
 * is suspended again the moment playback ends and closed after a short idle,
 * so an idle tab is never holding the audio device open; `dispose()` closes it
 * immediately.
 */
export class SoundPlayer {
  /**
   * @param {{AudioContextClass?: Function, idleMs?: number}} [options]
   */
  constructor(options = {}) {
    this._Ctx = options.AudioContextClass;
    this._idleMs = options.idleMs ?? 15000;
    this._ctx = null;
    this._source = null;
    this._idleTimer = null;
    this._playing = false;
  }

  /** @returns {boolean} */
  get playing() {
    return this._playing;
  }

  /** @returns {number} the context's sample rate, or 0 if there is no context */
  get sampleRate() {
    return this._ctx ? this._ctx.sampleRate : 0;
  }

  /**
   * Play a rendered buffer. Stops whatever was already playing.
   * @param {Rendered} rendered
   * @param {{onended?: () => void}} [options]
   * @returns {Promise<Rendered>} the buffer that started playing
   */
  async play(rendered, options = {}) {
    if (!rendered || !rendered.samples || !rendered.samples.length) {
      throw new Error('audio: nothing to play — render some samples first');
    }
    const Ctx = audioContextClass(this._Ctx);
    if (!Ctx) throw new Error(UNSUPPORTED);

    this.stop();
    this._cancelIdle();

    // A context locked to another rate would resample behind our back, which
    // is exactly the sort of quiet mangling this module exists to avoid.
    if (this._ctx && Math.abs(this._ctx.sampleRate - rendered.sampleRate) > 0.5) {
      await this._close();
    }
    if (!this._ctx) {
      try {
        this._ctx = new Ctx({ sampleRate: rendered.sampleRate });
      } catch (e) {
        throw new Error(`${UNSUPPORTED} (${e && e.message ? e.message : e})`);
      }
    }
    const ctx = this._ctx;
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') await ctx.resume();

    const buffer = ctx.createBuffer(1, rendered.samples.length, rendered.sampleRate);
    if (typeof buffer.copyToChannel === 'function') {
      buffer.copyToChannel(rendered.samples, 0);
    } else {
      buffer.getChannelData(0).set(rendered.samples);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      if (this._source !== source) return;
      this._source = null;
      this._playing = false;
      this._goIdle();
      if (options.onended) options.onended();
    };

    this._source = source;
    this._playing = true;
    source.start();
    return rendered;
  }

  /**
   * Render a model and play it. This is the two-line path for the UI.
   * @param {{eval: (t: number) => ArrayLike<number>}} model
   * @param {RenderOptions & {onended?: () => void}} [options]
   * @returns {Promise<Rendered>}
   */
  async playModel(model, options = {}) {
    return this.play(renderModel(model, options), { onended: options.onended });
  }

  /** Stop immediately. Safe to call when nothing is playing. */
  stop() {
    const source = this._source;
    this._source = null;
    this._playing = false;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch (e) {
        // Already stopped, or never started. Either way there is nothing to do.
      }
      try {
        source.disconnect();
      } catch (e) {
        /* same */
      }
      this._goIdle();
    }
  }

  /** Stop and close the AudioContext. The player stays usable afterwards. */
  async dispose() {
    this.stop();
    this._cancelIdle();
    await this._close();
  }

  /** Suspend now, close shortly — an idle tab holds no audio device. */
  _goIdle() {
    const ctx = this._ctx;
    if (!ctx) return;
    if (typeof ctx.suspend === 'function' && ctx.state === 'running') {
      Promise.resolve(ctx.suspend()).catch(() => {});
    }
    this._cancelIdle();
    if (this._idleMs > 0 && typeof setTimeout === 'function') {
      this._idleTimer = setTimeout(() => {
        this._idleTimer = null;
        if (!this._playing) this._close();
      }, this._idleMs);
      if (this._idleTimer && typeof this._idleTimer.unref === 'function') {
        this._idleTimer.unref();
      }
    }
  }

  _cancelIdle() {
    if (this._idleTimer !== null) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  async _close() {
    const ctx = this._ctx;
    this._ctx = null;
    if (ctx && typeof ctx.close === 'function' && ctx.state !== 'closed') {
      try {
        await ctx.close();
      } catch (e) {
        /* a context that refuses to close is already gone */
      }
    }
  }
}

export default SoundPlayer;
