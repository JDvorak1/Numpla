// Verification for the demo gallery — run with `node app/demos.test.mjs`.
//
// Every demo is compiled and integrated by the REAL WebAssembly build, exactly
// as the browser would, and then interrogated about its physics. A demo that
// parses is not good enough: the point of a demo is that something happens, so
// each one has to prove that the right thing happens.
//
// Four layers, from cheap to meaningful:
//
//   1. shape       — ids, knob ranges, and that a knob names a row that exists
//   2. compiles    — zero "error" and zero "pending" diagnostics
//   3. interesting — solves, stays finite, and actually moves
//   4. physics     — a named invariant or behaviour, written per demo
//
// Layer 4 is the one that matters. A generic "it varies" check passes on
// nonsense; "this undamped oscillator conserves energy to one part in 10^4"
// does not.

import { readFileSync } from 'node:fs';
import * as wasm from './pkg/numpla_wasm.js';
import { DEMOS, demoById } from './demos.js';

wasm.initSync({
  module: readFileSync(new URL('./pkg/numpla_wasm_bg.wasm', import.meta.url)),
});

// --- tiny test harness ------------------------------------------------------

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    failures.push({ name, message: e && e.message ? e.message : String(e) });
    process.stdout.write('F');
    return;
  }
  process.stdout.write('.');
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

// --- running a document -----------------------------------------------------

/**
 * Compile and integrate a source, and hand back the trajectory as named
 * columns. `n` uniform samples, which is what the plot would draw.
 */
function run(source, [t0, t1], n = 4000) {
  const model = new wasm.Model();
  const diagnostics = JSON.parse(model.set_source(source));
  const report = JSON.parse(model.solve(t0, t1));
  const dim = diagnostics.states.length;
  const flat = report.ok ? model.sample(n) : new Float64Array(0);

  const t = [];
  const columns = {};
  for (const s of diagnostics.states) columns[s] = [];
  for (let i = 0; i * (dim + 1) < flat.length; i++) {
    t.push(flat[i * (dim + 1)]);
    diagnostics.states.forEach((s, j) => columns[s].push(flat[i * (dim + 1) + 1 + j]));
  }

  return {
    diagnostics,
    report,
    t,
    dim,
    /** @param {string} name */
    col(name) {
      const c = columns[name];
      if (!c) throw new Error(`no state named ${name} (have ${diagnostics.states})`);
      return c;
    },
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Format a number the v1 lexer can read back: it has no exponent notation. */
function literal(v) {
  const s = String(v);
  return s.includes('e') ? v.toFixed(12) : s;
}

/** The regex that finds a parameter's own row, and only that row. */
const paramRow = (name) =>
  new RegExp(`^([ \\t]*)${escapeRe(name)}[ \\t]*=[ \\t]*([^#\\n]*)`, 'gm');

/** What a parameter row is set to, as written. */
function readParam(source, name) {
  const found = source.match(paramRow(name));
  if (!found || found.length !== 1) {
    throw new Error(
      `expected exactly one row defining ${name}, found ${found ? found.length : 0}`
    );
  }
  return found[0].split('=')[1].trim();
}

/**
 * Turn a knob: rewrite the one row that defines the parameter. This is exactly
 * what the shell's slider does, which is why the tests do it the same way
 * rather than by splicing in a fresh definition.
 */
function setParam(source, name, value) {
  readParam(source, name); // asserts there is precisely one row to rewrite
  return source.replace(paramRow(name), `$1${name} = ${literal(value)}`);
}

// --- trajectory measurements ------------------------------------------------

const slice = (v, from, to) => v.slice(Math.floor(v.length * from), Math.floor(v.length * to));
const maxAbs = (v) => v.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const spread = (v) => Math.max(...v) - Math.min(...v);
const drift = (v) => spread(v) / Math.max(1e-12, Math.abs(v[0]));

/** Sign changes — a cheap, robust stand-in for "how many oscillations". */
function zeroCrossings(v) {
  let n = 0;
  for (let i = 1; i < v.length; i++) if (v[i - 1] < 0 !== v[i] < 0) n += 1;
  return n;
}

/**
 * Instantaneous amplitude of an oscillator of frequency `w`: the radius in the
 * phase plane, sqrt(x^2 + (v/w)^2). For beating this is far sharper than a
 * windowed peak — it reaches zero exactly at the moment the oscillator hands
 * all of its motion to its neighbour, instead of smearing that moment across
 * a window.
 */
const amplitude = (q, v, w) => q.map((x, i) => Math.hypot(x, v[i] / w));

/** Index of the largest value — for comparing which peak comes first. */
const argmax = (v) => v.reduce((best, x, i) => (x > v[best] ? i : best), 0);

// =============================================================================
// Layer 4: the physics. One entry per demo id; every demo must have one.
// =============================================================================

const PHYSICS = {
  'plucked-string': (demo) => {
    const span = demo.tSpan;

    // Released from rest: a pluck is a shape held still, then let go. Every
    // velocity state must start at exactly zero.
    const rest = run(demo.source, span);
    for (const s of rest.diagnostics.states) {
      if (s.endsWith("'")) close(rest.col(s)[0], 0, 0, `${s} must start at rest`);
    }

    // The pluck is a triangle peaking at mass 2, and mass 2 is the highest
    // point of the string at t = 0.
    const start = [1, 2, 3, 4, 5, 6].map((i) => rest.col(`x_${i}`)[0]);
    close(start[1], 1, 1e-12, 'the pluck depth at a = 1');
    ok(start[0] < start[1] && start[1] > start[2], 'mass 2 must be the corner of the pluck');
    ok(
      start[2] > start[3] && start[3] > start[4] && start[4] > start[5],
      'the far side of the pluck must fall off linearly'
    );

    // Undamped, it rings forever: the string still has essentially all of its
    // swing at the end of the window.
    const free = run(setParam(demo.source, 'c', 0), span);
    const early = maxAbs(slice(free.col('x_3'), 0, 0.1));
    const late = maxAbs(slice(free.col('x_3'), 0.9, 1));
    ok(late > 0.8 * early, `undamped string decayed: ${early} -> ${late}`);

    // Damped, it dies away — that is what damping is for.
    const damped = run(demo.source, span);
    const dEarly = maxAbs(slice(damped.col('x_3'), 0, 0.1));
    const dLate = maxAbs(slice(damped.col('x_3'), 0.9, 1));
    ok(dLate < 0.5 * dEarly, `damped string did not decay: ${dEarly} -> ${dLate}`);

    // KNOB: tension is pitch. At the top of the slider the string must go
    // through many more oscillations in the same window than at the bottom.
    const k = demo.knobs.find((x) => x.name === 'k');
    const slack = run(setParam(demo.source, 'k', k.min), span);
    const tight = run(setParam(demo.source, 'k', k.max), span);
    const slackN = zeroCrossings(slack.col('x_3'));
    const tightN = zeroCrossings(tight.col('x_3'));
    ok(slackN >= 4, `at minimum tension the string barely moves: ${slackN} crossings`);
    ok(
      tightN > 2 * slackN,
      `tension knob does not change the pitch: k=${k.min} gave ${slackN} crossings, k=${k.max} gave ${tightN}`
    );

    // KNOB: with the nonlinearity off the string is linear, so doubling the
    // pluck must exactly double the motion...
    const one = run(setParam(demo.source, 'c', 0), span);
    const two = run(setParam(setParam(demo.source, 'c', 0), 'a', 2), span);
    close(maxAbs(two.col('x_4')), 2 * maxAbs(one.col('x_4')), 1e-6, 'a linear string must scale');

    // ...and with it on, it must not: that is the whole point of the knob.
    const stiff = setParam(setParam(demo.source, 'c', 0), 'g', 300);
    const soft = run(setParam(stiff, 'a', 0.5), span);
    const hard = run(setParam(stiff, 'a', 3), span);
    const ratio = zeroCrossings(hard.col('x_3')) / zeroCrossings(soft.col('x_3'));
    ok(ratio > 1.15, `the stretch nonlinearity has no effect on the tone: ratio ${ratio}`);
  },

  'colliding-strings': (demo) => {
    const span = demo.tSpan;
    // Non-penetration is a property of the WHOLE trajectory, so it is sampled
    // far more finely than the plot would: 24000 points over 12 s is 0.5 ms,
    // and a contact lasts about 15 ms at this stiffness.
    const N = 24000;
    const R = Number(readParam(demo.source, 'r'));
    const K = Number(readParam(demo.source, 'k'));
    const P = Number(readParam(demo.source, 'p'));
    const D0 = Number(readParam(demo.source, 'd'));
    const dk = demo.knobs.find((x) => x.name === 'd');
    const kk = demo.knobs.find((x) => x.name === 'k');
    const ck = demo.knobs.find((x) => x.name === 'c');

    /**
     * Facing beads i sit `d + a_i - b_i` apart. Contact begins at 2r, the bead
     * diameter; a gap of ZERO is the two centres crossing, and that is the
     * thing the penalty force exists to prevent.
     */
    const gaps = (r, d) =>
      [1, 2, 3].map((i) => {
        const a = r.col(`a_${i}`);
        const b = r.col(`b_${i}`);
        return a.map((q, j) => d + q - b[j]);
      });
    const closest = (r, d) => Math.min(...gaps(r, d).map((g) => Math.min(...g)));

    /** Kinetic energy of one string plus the tension it has stored. */
    const stringEnergy = (r, name, k) => {
      const x = [1, 2, 3].map((i) => r.col(`${name}_${i}`));
      const v = [1, 2, 3].map((i) => r.col(`${name}_${i}'`));
      return x[0].map((_, j) => {
        const [p1, p2, p3] = [x[0][j], x[1][j], x[2][j]];
        const kinetic = 0.5 * (v[0][j] ** 2 + v[1][j] ** 2 + v[2][j] ** 2);
        const stretch = p1 * p1 + (p2 - p1) ** 2 + (p3 - p2) ** 2 + p3 * p3;
        return kinetic + 0.5 * k * stretch;
      });
    };

    /** Energy stored in the squashed contact springs. */
    const contactEnergy = (r, d, p) => {
      const g = gaps(r, d);
      return g[0].map((_, j) =>
        g.reduce((sum, col) => {
          const overlap = Math.max(0, 2 * R - col[j]);
          return sum + 0.5 * p * overlap * overlap;
        }, 0)
      );
    };

    // Both strings are plucked and let go, so every velocity starts at zero.
    const base = run(demo.source, span, N);
    for (const s of base.diagnostics.states) {
      if (s.endsWith("'")) close(base.col(s)[0], 0, 0, `${s} must start at rest`);
    }

    // THE ASSERTION THIS DEMO EXISTS FOR: the strings never cross. Checked on
    // every facing pair at every sample, at the default and at both ends of
    // the distance knob, and at the corners that hit hardest (max tension,
    // no damping, smallest gap).
    const settings = [
      { d: dk.min, k: K, c: 0.2 },
      { d: D0, k: K, c: 0.2 },
      { d: 0.8, k: K, c: 0.2 },
      { d: dk.max, k: K, c: 0.2 },
      { d: dk.min, k: kk.max, c: ck.min },
      { d: dk.min, k: kk.max, c: ck.max },
      { d: dk.min, k: kk.min, c: ck.min },
      { d: D0, k: kk.max, c: ck.min },
    ];
    for (const s of settings) {
      let src = setParam(demo.source, 'd', s.d);
      src = setParam(src, 'k', s.k);
      src = setParam(src, 'c', s.c);
      const r = run(src, span, N);
      const min = closest(r, s.d);
      const where = `d=${s.d} k=${s.k} c=${s.c}`;
      ok(min > 0, `the strings crossed at ${where}: the gap fell to ${min}`);
      // And they do not merely avoid crossing: the beads squash by less than
      // their own radius, so the contact is stiff enough to be a contact.
      ok(2 * R - min < R, `the beads sank ${2 * R - min} into each other at ${where}`);
    }

    // The penalty force is what does that. Switch it off and the same pluck
    // sends the two strings clean through one another — so the check above is
    // measuring the contact and not the geometry.
    const ghost = run(setParam(demo.source, 'p', 0), span, N);
    const through = closest(ghost, D0);
    ok(through < -0.2, `with p = 0 they should pass through, but the gap only reached ${through}`);

    // At the default distance they really do touch, and gently: less than
    // half a bead radius of squash.
    const nearest = closest(base, D0);
    ok(nearest < 2 * R, `the strings never touch at d = ${D0}: closest gap ${nearest}`);
    ok(2 * R - nearest < 0.5 * R, `the default contact is too soft: ${2 * R - nearest} of squash`);

    // KNOB, far end: wound out to the top of the slider they never touch at
    // all, and with the damping off each string's own energy is then exactly
    // constant — two independent strings, ringing on.
    const apartSrc = setParam(setParam(demo.source, 'd', dk.max), 'c', 0);
    const apart = run(apartSrc, span, N);
    ok(closest(apart, dk.max) > 2 * R, 'at the far end of the knob they must never touch');
    ok(drift(stringEnergy(apart, 'a', K)) < 1e-4, 'an untouched string must conserve its energy');
    ok(drift(stringEnergy(apart, 'b', K)) < 1e-4, 'an untouched string must conserve its energy');

    // KNOB, near end: the collision moves energy from one string to the other
    // — neither is conserved on its own any more — while the pair plus the
    // squashed contact springs still conserve the total.
    const near = run(setParam(demo.source, 'c', 0), span, N);
    const ea = stringEnergy(near, 'a', K);
    const eb = stringEnergy(near, 'b', K);
    const ec = contactEnergy(near, D0, P);
    ok(spread(ea) / ea[0] > 0.5, `the collision barely moved energy: ${spread(ea) / ea[0]}`);
    const total = ea.map((v, j) => v + eb[j] + ec[j]);
    ok(drift(total) < 2e-3, `the colliding pair lost energy: drift ${drift(total)}`);
  },

  'energy-drift': (demo) => {
    // The demo's claim is about METHODS, not about the model: the same exact
    // energy is held by a symplectic integrator and let go by an adaptive one.
    // So the check has to compare integrators, not just look at one curve.
    const m = new wasm.Model();
    const d = JSON.parse(m.set_source(demo.source));
    ok(Array.isArray(d.derived) && d.derived.includes('E'),
       `E should be a derived row, got ${JSON.stringify(d.derived)}`);

    const ratio = (method) => {
      const r = JSON.parse(m.solve_with(demo.tSpan[0], demo.tSpan[1], method));
      ok(r.ok === true, `${method} refused this document: ${r.error}`);
      const c = JSON.parse(m.conservation('E', 2000));
      ok(c.ok === true, `conservation failed under ${method}: ${c.error}`);
      return c.drift.secularRatio;
    };

    // Around 1 is a bounded band; well above 1 is a genuine secular drift.
    const verlet = ratio('Verlet');
    const yoshida = ratio('Yoshida4');
    const tsit5 = ratio('Tsit5');
    ok(verlet < 1.5, `Verlet should hold energy in a band, ratio ${verlet}`);
    ok(yoshida < 1.5, `Yoshida4 should hold energy in a band, ratio ${yoshida}`);
    ok(tsit5 > 2, `the adaptive method should visibly drift, ratio ${tsit5}`);
    ok(tsit5 > 2 * verlet, `the contrast is the demo: ${tsit5} vs ${verlet}`);
  },

  'harmonic-oscillator': (demo) => {
    // Undamped by default, so energy is exactly conserved. Anything that
    // drifts here is the integrator leaking, not the model.
    const { col } = run(demo.source, demo.tSpan);
    const x = col('x');
    const v = col("x'");
    const energy = x.map((q, i) => 0.5 * (v[i] * v[i] + q * q));
    ok(drift(energy) < 1e-4, `energy drifted by ${drift(energy)} over the span`);

    // It is a cosine of unit amplitude, checked against the closed form.
    const { t, col: c2 } = run(demo.source, demo.tSpan);
    const got = c2('x');
    for (let i = 0; i < t.length; i += 97) {
      close(got[i], Math.cos(t[i]), 1e-5, `x(${t[i]}) should be cos t`);
    }

    // Turn the damping knob up and the same oscillator is nearly still by the
    // end of the window.
    const damped = run(setParam(demo.source, 'c', 0.3), demo.tSpan);
    const early = maxAbs(slice(damped.col('x'), 0, 0.1));
    const late = maxAbs(slice(damped.col('x'), 0.9, 1));
    ok(late < 0.15 * early, `damping knob did little: ${early} -> ${late}`);
  },

  pendulum: (demo) => {
    // Undamped, so it must come back to the angle it was released from and
    // never go past it.
    const { col } = run(demo.source, demo.tSpan);
    const q = col('q');
    close(q[0], 3, 1e-12, 'released from 3 radians');
    ok(maxAbs(q) <= 3 + 1e-6, 'an undamped pendulum cannot swing higher than it started');
    ok(Math.min(...q) < -2.9, 'it must reach the same angle on the far side');

    // THE POINT: the period grows with amplitude, which the small-angle
    // (sin q = q) pendulum in every textbook cannot do. Small-angle period
    // here is 2*pi*sqrt(l/g) = 2.006 s.
    const period = (src) => {
      const r = run(src, demo.tSpan);
      const n = zeroCrossings(r.col('q'));
      ok(n >= 4, 'not enough swings to measure a period');
      return (2 * (demo.tSpan[1] - demo.tSpan[0])) / n;
    };
    const small = period(setParam(demo.source, 'a', 0.05));
    const large = period(demo.source);
    close(small, 2.006, 0.05, 'small-angle period should match 2 pi sqrt(l/g)');
    ok(large > 1.8 * small, `large-angle period is not stretched: ${small} -> ${large}`);
  },

  'driven-resonance': (demo) => {
    // On resonance the steady-state amplitude is about f/(c*w) = 3.33.
    const steady = (src) => maxAbs(slice(run(src, demo.tSpan).col('x'), 0.75, 1));
    const on = steady(demo.source);
    close(on, 0.5 / (0.15 * 1), 0.15, 'resonant amplitude should be about f/(c w)');

    // Off resonance it collapses. That contrast is the demo.
    const off = steady(setParam(demo.source, 'u', 2));
    ok(on > 5 * off, `resonance is not sharp: on ${on}, off ${off}`);

    // Lower damping, taller peak.
    const sharp = steady(setParam(demo.source, 'c', 0.05));
    ok(sharp > 2 * on, `less damping should ring louder: ${on} -> ${sharp}`);

    // It starts from rest at the origin, so everything on screen was driven.
    const r = run(demo.source, demo.tSpan);
    close(r.col('x')[0], 0, 0, 'starts at the origin');
    close(r.col("x'")[0], 0, 0, 'starts at rest');

    // And it ends up oscillating at the DRIVE frequency, not its own: over 60
    // seconds at u = 2 that is 2*60/(2*pi) ~ 19 cycles, so ~38 crossings.
    const fast = run(setParam(demo.source, 'u', 2), demo.tSpan);
    const n = zeroCrossings(slice(fast.col('x'), 0.5, 1));
    close(n, (2 * 30) / Math.PI, 4, 'the steady state must follow the drive frequency');
  },

  'coupled-beats': (demo) => {
    const r = run(demo.source, demo.tSpan, 6000);
    const x = r.col('x');
    const y = r.col('y');

    // All the motion starts in x.
    close(x[0], 1, 1e-12, 'x starts pulled aside');
    close(y[0], 0, 1e-12, 'y starts still');

    // COMPLETE HANDOVER: at some moment x is essentially motionless while y
    // is swinging with the full original amplitude. Nothing was lost — it is
    // all in the neighbour.
    const ex = amplitude(x, r.col("x'"), 1);
    const ey = amplitude(y, r.col("y'"), 1);
    ok(Math.min(...ex) < 0.2, `x never goes quiet: min amplitude ${Math.min(...ex)}`);
    ok(Math.max(...ey) > 0.85, `y never picks it all up: max amplitude ${Math.max(...ey)}`);

    // The handover goes back and forth: x is loud, then quiet, then loud
    // again. Measured from the FIRST quiet moment, so the check is about the
    // round trip and not about where the window happens to end.
    const quiet = ex.findIndex((v) => v < 0.2);
    ok(quiet > 0 && quiet < ex.length * 0.6, `the first quiet moment is at index ${quiet}`);
    ok(maxAbs(ex.slice(quiet + 1)) > 0.85, 'x must get the motion back again');

    // Total energy of the pair is conserved (nothing is damped here).
    const vx = r.col("x'");
    const vy = r.col("y'");
    const total = x.map(
      (q, i) =>
        0.5 * (vx[i] * vx[i] + vy[i] * vy[i] + q * q + y[i] * y[i]) +
        0.5 * 0.2 * (q - y[i]) * (q - y[i])
    );
    ok(drift(total) < 1e-4, `pair energy drifted by ${drift(total)}`);

    // Stronger coupling hands the motion over faster.
    const beats = (c) => {
      const rr = run(setParam(demo.source, 'c', c), demo.tSpan, 6000);
      const amp = amplitude(rr.col('x'), rr.col("x'"), 1);
      return zeroCrossings(amp.map((v) => v - 0.5));
    };
    ok(beats(0.6) > 2 * beats(0.05), 'stronger coupling should beat faster');
  },

  'van-der-pol': (demo) => {
    // A LIMIT CYCLE is defined by not depending on where you started. Three
    // wildly different starts, one destination.
    const late = (x0, v0) => {
      const s = demo.source.replace(/^x\(0\) = .*$/m, `x(0) = ${x0}`)
        .replace(/^x'\(0\) = .*$/m, `x'(0) = ${v0}`);
      const r = run(s, demo.tSpan);
      return maxAbs(slice(r.col('x'), 0.75, 1));
    };
    const a = late(0.1, 0);
    const b = late(3, 2);
    const c = late(-2.5, -1);
    close(b, a, 0.01, 'a limit cycle must not remember its initial condition');
    close(c, a, 0.01, 'a limit cycle must not remember its initial condition');
    close(a, 2.02, 0.05, 'the van der Pol cycle sits at amplitude ~2');

    // And it really is a cycle: the second half of the window repeats the
    // amplitude of the first half rather than growing or dying.
    const r = run(demo.source, demo.tSpan);
    const mid = maxAbs(slice(r.col('x'), 0.5, 0.75));
    close(maxAbs(slice(r.col('x'), 0.75, 1)), mid, 1e-3, 'the orbit must repeat');

    // Large m turns the wave into a relaxation twitch: the velocity spikes
    // get far bigger while the displacement stays pinned at ~2.
    const stiff = run(setParam(demo.source, 'm', 8), demo.tSpan);
    ok(
      maxAbs(stiff.col("x'")) > 3 * maxAbs(r.col("x'")),
      'raising m should sharpen the relaxation spikes'
    );
    close(maxAbs(slice(stiff.col('x'), 0.75, 1)), 2.02, 0.1, 'amplitude stays ~2 regardless of m');
  },

  'lotka-volterra': (demo) => {
    const r = run(demo.source, demo.tSpan);
    const x = r.col('x');
    const y = r.col('y');

    ok(Math.min(...x) > 0 && Math.min(...y) > 0, 'populations must never go negative');

    // Lotka-Volterra has an exact conserved quantity. It is the reason the
    // orbits close instead of spiralling, so it is the honest check here.
    const [a, b, c, d] = [1, 0.5, 0.75, 0.25];
    const v = x.map((q, i) => d * q - c * Math.log(q) + b * y[i] - a * Math.log(y[i]));
    ok(drift(v) < 1e-4, `the conserved quantity drifted by ${drift(v)}`);

    // The predator peak LAGS the prey peak — predators can only grow after
    // there is something to eat.
    const preyPeak = argmax(slice(x, 0, 0.5));
    const predPeak = argmax(slice(y, 0, 0.5));
    ok(predPeak > preyPeak, 'the predator peak must come after the prey peak');

    // It swings hard: the prey population changes by a factor of four.
    ok(Math.max(...x) / Math.min(...x) > 4, 'the cycle should be dramatic, not a wobble');
  },

  'sir-epidemic': (demo) => {
    const r = run(demo.source, demo.tSpan);
    const s = r.col('s');
    const i = r.col('i');
    const rr = r.col('r');

    // Nobody is created or destroyed. This is the model's one hard invariant.
    const total = s.map((v, j) => v + i[j] + rr[j]);
    for (const v of total) close(v, 1, 1e-8, 's + i + r must stay exactly 1');

    // Susceptibles only ever fall, recovered only ever rise.
    for (let j = 1; j < s.length; j++) {
      ok(s[j] <= s[j - 1] + 1e-12, 'susceptibles cannot increase');
      ok(rr[j] >= rr[j - 1] - 1e-12, 'the recovered count cannot fall');
    }

    // There is a real outbreak, and it is over by the end of the window.
    ok(Math.max(...i) > 0.2, `the epidemic never took off: peak ${Math.max(...i)}`);
    ok(i[i.length - 1] < 0.01, 'the outbreak should have burnt out inside the span');
    ok(rr[rr.length - 1] > 0.9, 'nearly everyone should have been infected at b = 0.6');

    // BELOW THRESHOLD: with b < g the seed infection just fizzles, and the
    // curve is flat. That contrast is what the knob is for.
    const damp = run(setParam(demo.source, 'b', 0.05), demo.tSpan);
    ok(Math.max(...damp.col('i')) <= 0.001 + 1e-9, 'below threshold nothing should grow');
    ok(damp.col('r')[damp.col('r').length - 1] < 0.01, 'below threshold almost nobody is infected');
  },

  lorenz: (demo) => {
    const r = run(demo.source, demo.tSpan);
    const x = r.col('x');

    // Bounded but never repeating: it stays on the attractor.
    ok(maxAbs(x) < 60 && maxAbs(r.col('z')) < 120, 'the attractor must stay bounded');
    ok(zeroCrossings(x) > 10, 'it should flip between the wings many times');

    // SENSITIVE DEPENDENCE. One part in a million in the initial x. The two
    // runs track each other closely for ten seconds and are unrelated by
    // forty — that is the whole idea of chaos, made checkable.
    const nudged = run(setParam(demo.source, 'a', 1.000001), demo.tSpan);
    const other = nudged.col('x');
    const at = (frac) => Math.abs(x[Math.floor((x.length - 1) * frac)] - other[Math.floor((x.length - 1) * frac)]);
    ok(at(0.25) < 0.1, `the two runs should still agree at t = 10: apart by ${at(0.25)}`);
    let separated = 0;
    for (let j = 0; j < x.length; j++) if (Math.abs(x[j] - other[j]) > 5) separated += 1;
    ok(separated > 200, 'a millionth of a nudge must end up changing everything');
    ok(
      maxAbs(x.map((v, j) => v - other[j])) > 10,
      'the nudged run must diverge completely by the end'
    );

    // BELOW THE THRESHOLD the chaos genuinely switches off: at r = 10 the
    // flow settles onto a steady roll and simply stops moving.
    const calm = run(setParam(demo.source, 'r', 10), demo.tSpan);
    ok(spread(slice(calm.col('x'), 0.9, 1)) < 1e-3, 'at r = 10 it must settle to a fixed point');
  },

  orbit: (demo) => {
    const r = run(demo.source, demo.tSpan);
    const x = r.col('x');
    const y = r.col('y');
    const vx = r.col("x'");
    const vy = r.col("y'");

    // The two invariants of a central force. If either drifts, the "orbit"
    // is an artefact of the integrator.
    const L = x.map((q, i) => q * vy[i] - y[i] * vx[i]);
    const E = x.map(
      (q, i) => 0.5 * (vx[i] * vx[i] + vy[i] * vy[i]) - 1 / Math.hypot(q, y[i])
    );
    ok(drift(L) < 1e-4, `angular momentum drifted by ${drift(L)}`);
    ok(drift(E) < 1e-4, `energy drifted by ${drift(E)}`);

    // It is an ellipse with perihelion where it launched and aphelion where
    // the vis-viva equation says: a = 1/(2 - v^2), r_max = 2a - 1.
    const rad = x.map((q, i) => Math.hypot(q, y[i]));
    const a = 1 / (2 - 1.1 * 1.1);
    close(Math.min(...rad), 1, 1e-3, 'perihelion is the launch radius');
    close(Math.max(...rad), 2 * a - 1, 5e-3, 'aphelion should match the vis-viva equation');

    // Kepler's second law made concrete: it is slowest at the far point.
    const far = argmax(rad);
    const speed = vx.map((u, i) => Math.hypot(u, vy[i]));
    close(speed[far], L[0] / rad[far], 1e-6, 'at aphelion the velocity is purely transverse');
    ok(speed[far] < 0.75 * Math.max(...speed), 'it must crawl at aphelion and race at perihelion');

    // Circular when launched at exactly the circular speed.
    const circle = run(setParam(demo.source, 'v', 1), demo.tSpan);
    const cr = circle.col('x').map((q, i) => Math.hypot(q, circle.col('y')[i]));
    ok(spread(cr) < 1e-5, `v = 1 should be a circle, radius varied by ${spread(cr)}`);

    // And it closes: after one period it is back where it started.
    const period = 2 * Math.PI * Math.pow(a, 1.5);
    const idx = Math.round(((period - demo.tSpan[0]) / (demo.tSpan[1] - demo.tSpan[0])) * (x.length - 1));
    close(x[idx], x[0], 5e-3, 'the ellipse must close after one period');
    close(y[idx], y[0], 5e-3, 'the ellipse must close after one period');
  },
};

// =============================================================================
// Layers 1-3, applied to every demo.
// =============================================================================

test('the gallery is not empty and has stable, unique ids', () => {
  ok(Array.isArray(DEMOS), 'DEMOS must be an array');
  ok(DEMOS.length >= 8, `expected a real gallery, got ${DEMOS.length} demos`);
  const ids = DEMOS.map((d) => d.id);
  ok(new Set(ids).size === ids.length, `duplicate ids: ${ids}`);
  for (const id of ids) ok(/^[a-z0-9-]+$/.test(id), `id ${id} should be a slug`);
});

test('demoById finds every demo and nothing else', () => {
  for (const d of DEMOS) ok(demoById(d.id) === d, `demoById lost ${d.id}`);
  ok(demoById('no-such-demo') === undefined, 'demoById must return undefined when it misses');
});

for (const demo of DEMOS) {
  const at = (what) => `${demo.id}: ${what}`;

  // --- 1. shape -------------------------------------------------------------

  test(at('has the fields the shell needs'), () => {
    ok(typeof demo.title === 'string' && demo.title.length > 0, 'needs a title');
    ok(typeof demo.blurb === 'string' && demo.blurb.length > 20, 'needs a real blurb');
    ok(typeof demo.audio === 'boolean', 'audio must be a boolean');
    ok(Array.isArray(demo.tags) && demo.tags.length > 0, 'needs tags');
    ok(Array.isArray(demo.tSpan) && demo.tSpan.length === 2, 'needs a tSpan pair');
    ok(demo.tSpan[1] > demo.tSpan[0], 'tSpan must run forwards');
    ok(Array.isArray(demo.knobs) && demo.knobs.length > 0, 'a demo without a knob is a picture');
    ok(demo.source.includes('#'), 'the source must explain itself');
  });

  test(at('knob ranges are sane and start where the document does'), () => {
    for (const k of demo.knobs) {
      ok(typeof k.name === 'string' && k.name.length > 0, 'knob needs a name');
      ok(k.min < k.max, `knob ${k.name}: min must be below max`);
      ok(k.step > 0 && k.step <= k.max - k.min, `knob ${k.name}: implausible step`);
      ok(k.value >= k.min && k.value <= k.max, `knob ${k.name}: default outside its range`);
      // The slider must start on the value the document actually ships with,
      // or the first drag would jump.
      const written = Number(readParam(demo.source, k.name));
      ok(
        Number.isFinite(written) && Math.abs(written - k.value) < 1e-12,
        `knob ${k.name}: slider says ${k.value} but the source says ${written}`
      );
    }
  });

  // --- 2. compiles ----------------------------------------------------------

  const compiled = run(demo.source, demo.tSpan);

  test(at('compiles with no errors and nothing pending'), () => {
    const bad = compiled.diagnostics.issues.filter((i) => i.severity === 'error');
    ok(bad.length === 0, `errors: ${JSON.stringify(bad)}`);
    const pending = compiled.diagnostics.issues.filter((i) => i.severity === 'pending');
    ok(pending.length === 0, `pending rows: ${JSON.stringify(pending)}`);
  });

  test(at('every knob names a parameter the model actually has'), () => {
    for (const k of demo.knobs) {
      ok(
        compiled.diagnostics.params.includes(k.name),
        `knob ${k.name} is not a parameter (params: ${compiled.diagnostics.params})`
      );
    }
  });

  // --- 3. interesting -------------------------------------------------------

  test(at('solves over its own tSpan'), () => {
    ok(compiled.report.ok, `solve failed: ${compiled.report.error}`);
    ok(compiled.report.dim > 0, 'a demo needs at least one state');
    ok(compiled.report.accepted > 10, `suspiciously few steps: ${compiled.report.accepted}`);
    ok(compiled.t.length === 4000, `sample returned ${compiled.t.length} points`);
    close(compiled.t[0], demo.tSpan[0], 1e-9, 'sampling starts at t0');
    close(compiled.t[compiled.t.length - 1], demo.tSpan[1], 1e-9, 'sampling ends at t1');
  });

  test(at('is finite everywhere and actually does something'), () => {
    let biggest = 0;
    for (const s of compiled.diagnostics.states) {
      const v = compiled.col(s);
      for (const q of v) ok(Number.isFinite(q), `state ${s} went non-finite`);
      biggest = Math.max(biggest, spread(v));
    }
    ok(biggest > 0.1, `nothing moves: the widest state spans only ${biggest}`);
  });

  // --- 4. physics -----------------------------------------------------------

  test(at('obeys its physics'), () => {
    const check = PHYSICS[demo.id];
    ok(typeof check === 'function', 'no physics check is written for this demo');
    check(demo);
  });
}

// --- report -----------------------------------------------------------------

process.stdout.write('\n');
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL  ${f.name}\n      ${f.message}`);
  console.error(`\n${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`${passed} passed, ${DEMOS.length} demos verified against the wasm build`);
