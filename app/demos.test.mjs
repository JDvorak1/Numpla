// Verification for the demo gallery — run with `node app/demos.test.mjs`.
//
// Every demo is compiled and integrated by the REAL WebAssembly build, exactly
// as the browser would, and then interrogated about its physics. A demo that
// parses is not good enough: the point of a demo is that something happens, so
// each one has to prove that the right thing happens.
//
// Five layers, from cheap to meaningful:
//
//   1. shape       — ids, knob ranges, and that a knob names a row that exists
//   2. view        — it declares the one view it is about
//   3. compiles    — zero "error" and zero "pending" diagnostics
//   4. interesting — solves, stays finite, and actually moves
//   5. physics     — a named invariant or behaviour, written per demo
//
// Layer 5 is the one that matters. A generic "it varies" check passes on
// nonsense; "this integral is x^a to one part in 10^12", "this envelope has
// exactly six nulls because the detuning says so", "these arrows ARE the
// right-hand side" do not.

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

/**
 * The right-hand side on a grid, as the `field` view draws it: one
 * `{x, y, dx, dy}` per sample. The arrows are supposed to BE the equation, so
 * the field demos check them against the equation by hand.
 */
function field(source, [x0, x1, y0, y1], nx, ny, t = 0) {
  const model = new wasm.Model();
  model.set_source(source);
  const flat = model.vector_field(x0, x1, y0, y1, nx, ny, t);
  const out = [];
  for (let i = 0; i * 4 < flat.length; i++) {
    const [x, y, dx, dy] = flat.subarray(4 * i, 4 * i + 4);
    out.push({ x, y, dx, dy });
  }
  return out;
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

/** Move a starting point without touching anything else. */
function setStart(source, name, value) {
  const row = new RegExp(`^([ \\t]*)${escapeRe(name)}\\(0\\)[ \\t]*=[ \\t]*[^#\\n]*`, 'gm');
  ok(row.test(source), `no starting row for ${name}`);
  return source.replace(row, `$1${name}(0) = ${literal(value)}`);
}

// --- trajectory measurements ------------------------------------------------

const slice = (v, from, to) => v.slice(Math.floor(v.length * from), Math.floor(v.length * to));
const maxAbs = (v) => v.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const spread = (v) => Math.max(...v) - Math.min(...v);
const drift = (v) => spread(v) / Math.max(1e-12, Math.abs(v[0]));
const rms = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);

/** Sign changes — a cheap, robust stand-in for "how many oscillations". */
function zeroCrossings(v) {
  let n = 0;
  for (let i = 1; i < v.length; i++) if (v[i - 1] < 0 !== v[i] < 0) n += 1;
  return n;
}

/**
 * Instantaneous amplitude of an oscillator of frequency `w`: the radius in the
 * phase plane, sqrt(x^2 + (v/w)^2). For beating this is far sharper than a
 * windowed peak — it reaches zero exactly at the moment the two tones cancel,
 * instead of smearing that moment across a window.
 */
const amplitude = (q, v, w) => q.map((x, i) => Math.hypot(x, v[i] / w));

/** Index of the largest value — for comparing which peak comes first. */
const argmax = (v) => v.reduce((best, x, i) => (x > v[best] ? i : best), 0);

/** Radius column of a two-state run. */
const radius = (r, a, b) => r.col(a).map((x, i) => Math.hypot(x, r.col(b)[i]));

// =============================================================================
// Layer 5: the physics. One entry per demo id; every demo must have one.
// =============================================================================

const PHYSICS = {
  integral: (demo) => {
    // THE CLAIM: `df/dx = a x^(a-1)` with `f(0) = 0` is the integral, and the
    // integral of a x^(a-1) is x^a. Checked against the closed form at every
    // sample, at five powers, including a fractional one.
    for (const a of [1, 2, 3, 4, 2.5]) {
      const r = run(setParam(demo.source, 'a', a), demo.tSpan);
      const f = r.col('f');
      close(f[0], 0, 0, 'the area under a point is zero');
      let worst = 0;
      for (let i = 0; i < r.t.length; i++) {
        worst = Math.max(worst, Math.abs(f[i] - Math.pow(r.t[i], a)));
      }
      ok(worst < 1e-6, `a = ${a}: the integral is off x^a by ${worst}`);
      // And the end point is the exact power, which is what the eye reads.
      close(f[f.length - 1], Math.pow(demo.tSpan[1], a), 1e-6, `f(3) at a = ${a}`);
    }

    // The denominator names the axis. A document written `df/dx` is drawing f
    // against x, and calling that axis `t` would describe a different picture.
    const base = run(demo.source, demo.tSpan);
    ok(base.diagnostics.independent === 'x',
       `independent should be x, got ${base.diagnostics.independent}`);
    ok(base.diagnostics.states.join(',') === 'f', 'the only state is the integral itself');

    // The knob really is the power: at a = 4 the curve ends nine times higher
    // than at a = 2.
    const two = run(setParam(demo.source, 'a', 2), demo.tSpan).col('f');
    const four = run(setParam(demo.source, 'a', 4), demo.tSpan).col('f');
    close(four[3999] / two[3999], 9, 1e-6, '3^4 / 3^2');
  },

  rose: (demo) => {
    // dr/dq = -k sin(kq) from r(0) = 1 is r = cos(kq), exactly. That closed
    // form is the whole demo, so it is checked at every sample.
    for (const k of [1, 2, 3, 5, 9]) {
      const r = run(setParam(demo.source, 'k', k), demo.tSpan);
      const rad = r.col('r');
      let worst = 0;
      for (let i = 0; i < r.t.length; i++) {
        worst = Math.max(worst, Math.abs(rad[i] - Math.cos(k * r.t[i])));
      }
      ok(worst < 1e-5, `k = ${k}: r is off cos(kq) by ${worst}`);
      close(Math.max(...rad), 1, 1e-4, `k = ${k}: the petals reach radius 1`);
      close(Math.min(...rad), -1, 1e-4, `k = ${k}: and reach through the origin`);

      // The petal count is not written anywhere: it is 2k crossings of the
      // origin over one turn, which is what makes the picture a rose.
      close(zeroCrossings(rad), 2 * k, 0, `k = ${k}: a rose has 2k crossings per turn`);
    }

    // The angle is the independent variable, and `r` is a real state — which
    // together are exactly what the polar view needs to draw this.
    const base = run(demo.source, demo.tSpan);
    ok(base.diagnostics.independent === 'q',
       `independent should be q, got ${base.diagnostics.independent}`);
    ok(base.diagnostics.states.indexOf('r') >= 0, 'polar needs a state named r');
    close(demo.tSpan[1], 2 * Math.PI, 1e-12, 'the window is exactly one turn');
  },

  'energy-drift': (demo) => {
    // The demo's claim is about METHODS, not about the model: the same exact
    // energy is held by a symplectic integrator and let go by an adaptive one.
    // So the check has to compare integrators, not just look at one curve.
    const m = new wasm.Model();
    const d = JSON.parse(m.set_source(demo.source));
    ok(Array.isArray(d.derived) && d.derived.includes('E'),
       `E should be a derived row, got ${JSON.stringify(d.derived)}`);
    ok(d.states.join(',') === "x,x'",
       `d2x/dt2 must lower to a position and a velocity, got ${d.states}`);

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

    // And the quantity really is the energy of THIS spring: it starts at
    // 0.5 w^2, and the trajectory is the cosine the closed form promises.
    const r = run(demo.source, demo.tSpan);
    const x = r.col('x');
    for (let i = 0; i < r.t.length; i += 401) {
      close(x[i], Math.cos(r.t[i]), 2e-3, `x(${r.t[i]}) should be cos t`);
    }
  },

  hopf: (demo) => {
    // A SUPERCRITICAL HOPF: below the threshold everything falls into the
    // origin, above it a circle of radius sqrt(a) appears and attracts
    // everything. Both halves are checked against the closed-form radius.
    for (const a of [-0.6, -0.2]) {
      const r = run(setParam(demo.source, 'a', a), demo.tSpan);
      const late = slice(radius(r, 'x', 'y'), 0.8, 1);
      ok(Math.max(...late) < 1e-3, `at a = ${a} everything should die: radius ${Math.max(...late)}`);
    }
    for (const a of [0.5, 1.2]) {
      const r = run(setParam(demo.source, 'a', a), demo.tSpan);
      const late = slice(radius(r, 'x', 'y'), 0.8, 1);
      close(Math.min(...late), Math.sqrt(a), 1e-3, `the cycle radius at a = ${a}`);
      close(Math.max(...late), Math.sqrt(a), 1e-3, `the cycle radius at a = ${a}`);
    }

    // It ARRIVES on the cycle rather than starting there — the document starts
    // at radius 0.05 and the attracting ring is at 0.707.
    const base = run(demo.source, demo.tSpan);
    const rad = radius(base, 'x', 'y');
    close(rad[0], 0.05, 1e-12, 'it starts near the origin');
    ok(Math.max(...slice(rad, 0, 0.05)) < 0.3, 'the wind-on must be visible in the window');

    // THE FIELD IS THE EQUATION. This is the assertion a field demo exists
    // for: every arrow the view draws is the right-hand side at that point,
    // exactly, not a second and subtly different evaluation of it.
    const arrows = field(demo.source, [-2, 2, -2, 2], 9, 7);
    ok(arrows.length === 63, `the grid should be 9 x 7, got ${arrows.length}`);
    for (const { x, y, dx, dy } of arrows) {
      const rr = x * x + y * y;
      close(dx, 0.5 * x - y - x * rr, 1e-12, `arrow dx at (${x}, ${y})`);
      close(dy, x + 0.5 * y - y * rr, 1e-12, `arrow dy at (${x}, ${y})`);
    }
    // The arrows turn: on the ring the flow is purely rotational, so the field
    // there is perpendicular to the radius.
    const onRing = field(demo.source, [Math.SQRT1_2, Math.SQRT1_2, 0, 0], 1, 1)[0];
    close(onRing.x * onRing.dx + onRing.y * onRing.dy, 0, 1e-12,
          'on the limit cycle the flow has no radial part');
  },

  'pendulum-field': (demo) => {
    // Released at 3.1 radians, a whisker inside the separatrix: it must
    // librate — swing back — rather than go over the top.
    const r = run(demo.source, demo.tSpan);
    const x = r.col('x');
    const y = r.col('y');
    close(x[0], 3.1, 1e-12, 'released from 3.1 radians');
    ok(maxAbs(x) <= 3.1 + 1e-6, 'inside the separatrix it can never pass the top');
    ok(Math.min(...x) < -3.09, 'and it must reach the same angle on the far side');

    // Undamped, so the pendulum energy is exactly conserved. It also says
    // WHICH side of the separatrix this is: E < 1 librates, E > 1 circulates.
    const E = x.map((q, i) => 0.5 * y[i] * y[i] - Math.cos(q));
    ok(drift(E) < 1e-3, `energy drifted by ${drift(E)}`);
    ok(E[0] < 1, `E = ${E[0]} — this start is supposed to be inside the separatrix`);

    // THE POINT OF THE PICTURE: near the separatrix the period blows up. The
    // small-angle period is 2 pi; here it is more than three times that.
    const period = (src) => {
      const rr = run(src, demo.tSpan);
      const n = zeroCrossings(rr.col('x'));
      ok(n >= 2, 'not enough swings to measure a period');
      return (2 * (demo.tSpan[1] - demo.tSpan[0])) / n;
    };
    const small = period(setStart(demo.source, 'x', 0.05));
    close(small, 2 * Math.PI, 0.2, 'small swings should have period 2 pi');
    ok(period(demo.source) > 3 * small, 'near the separatrix the period must blow up');

    // KNOB: with drag the eyes become drains, so the whole thing stops.
    const damped = run(setParam(demo.source, 'c', 0.8), demo.tSpan);
    ok(maxAbs(slice(damped.col('x'), 0.9, 1)) < 1e-3, 'with drag it must settle at the bottom');
    ok(maxAbs(slice(damped.col('y'), 0.9, 1)) < 1e-3, 'and stop moving');

    // THE FIELD IS THE EQUATION, at every sample of the grid the view draws.
    const arrows = field(demo.source, [-2 * Math.PI, 2 * Math.PI, -3, 3], 13, 9);
    ok(arrows.length === 117, `the grid should be 13 x 9, got ${arrows.length}`);
    for (const { x: qx, y: qy, dx, dy } of arrows) {
      close(dx, qy, 1e-12, `arrow dx at (${qx}, ${qy})`);
      close(dy, -Math.sin(qx), 1e-12, `arrow dy at (${qx}, ${qy})`);
    }
    // The eyes and the saddles are where the arrows vanish: at every multiple
    // of pi on the axis, and nowhere else on it.
    const axis = field(demo.source, [0, 3 * Math.PI, 0, 0], 7, 1);
    axis.forEach((a, i) => {
      const still = Math.hypot(a.dx, a.dy) < 1e-9;
      ok(still === (i % 2 === 0), `the field should rest exactly at multiples of pi (i = ${i})`);
    });
  },

  'van-der-pol': (demo) => {
    // A LIMIT CYCLE is defined by not depending on where you started. Three
    // wildly different starts, one destination.
    const late = (x0, y0) => {
      const s = setStart(setStart(demo.source, 'x', x0), 'y', y0);
      return maxAbs(slice(run(s, demo.tSpan).col('x'), 0.75, 1));
    };
    const a = late(0.1, 0);
    close(late(3, 2), a, 0.01, 'a limit cycle must not remember its initial condition');
    close(late(-2.5, -1), a, 0.01, 'a limit cycle must not remember its initial condition');
    close(a, 2.02, 0.05, 'the van der Pol cycle sits at amplitude ~2');

    // And it really is a cycle: the last quarter of the window repeats the
    // quarter before it rather than growing or dying.
    const r = run(demo.source, demo.tSpan);
    close(maxAbs(slice(r.col('x'), 0.75, 1)), maxAbs(slice(r.col('x'), 0.5, 0.75)), 1e-3,
          'the orbit must repeat');

    // KNOB: large m is a relaxation oscillator — the same width, a far more
    // violent snap. That is the difference between a hum and a buzz, and it is
    // the reason this one is worth listening to.
    const stiff = run(setParam(demo.source, 'm', 8), demo.tSpan);
    const gentle = run(setParam(demo.source, 'm', 0.1), demo.tSpan);
    ok(maxAbs(stiff.col('y')) > 4 * maxAbs(gentle.col('y')),
       `raising m should sharpen the spikes: ${maxAbs(gentle.col('y'))} -> ${maxAbs(stiff.col('y'))}`);
    close(maxAbs(slice(stiff.col('x'), 0.75, 1)), 2.02, 0.1, 'amplitude stays ~2 regardless of m');

    // THE FIELD IS THE EQUATION — including the m the slider is holding.
    const arrows = field(demo.source, [-3, 3, -4, 4], 11, 9);
    ok(arrows.length === 99, `the grid should be 11 x 9, got ${arrows.length}`);
    for (const { x, y, dx, dy } of arrows) {
      close(dx, y, 1e-12, `arrow dx at (${x}, ${y})`);
      close(dy, 2 * (1 - x * x) * y - x, 1e-12, `arrow dy at (${x}, ${y})`);
    }
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

    // The helper row is load-bearing: one function, called twice.
    ok(r.diagnostics.params.join(',') === 'm,v',
       `the function must not become a parameter, got ${r.diagnostics.params}`);

    // It is an ellipse with perihelion where it launched and aphelion where
    // the vis-viva equation says: a = 1/(2 - v^2), r_max = 2a - 1.
    const rad = radius(r, 'x', 'y');
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
    ok(spread(radius(circle, 'x', 'y')) < 1e-5, 'v = 1 should be a circle');

    // And it closes: after one period it is back where it started.
    const period = 2 * Math.PI * Math.pow(a, 1.5);
    const idx = Math.round(
      ((period - demo.tSpan[0]) / (demo.tSpan[1] - demo.tSpan[0])) * (x.length - 1)
    );
    close(x[idx], x[0], 5e-3, 'the ellipse must close after one period');
    close(y[idx], y[0], 5e-3, 'the ellipse must close after one period');
  },

  lorenz: (demo) => {
    const r = run(demo.source, demo.tSpan);
    const x = r.col('x');

    // Bounded but never repeating: it stays on the attractor.
    ok(maxAbs(x) < 60 && maxAbs(r.col('z')) < 120, 'the attractor must stay bounded');
    ok(zeroCrossings(x) > 10, 'it should flip between the wings many times');

    // SENSITIVE DEPENDENCE. One part in a million in the starting x. The two
    // runs track each other closely for ten seconds and are unrelated by
    // forty — that is the whole idea of chaos, made checkable.
    const other = run(setParam(demo.source, 'a', 1.000001), demo.tSpan).col('x');
    const at = (f) => {
      const i = Math.floor((x.length - 1) * f);
      return Math.abs(x[i] - other[i]);
    };
    ok(at(0.25) < 0.1, `the two runs should still agree at t = 10: apart by ${at(0.25)}`);
    let separated = 0;
    for (let j = 0; j < x.length; j++) if (Math.abs(x[j] - other[j]) > 5) separated += 1;
    ok(separated > 200, 'a millionth of a nudge must end up changing everything');
    ok(maxAbs(x.map((v, j) => v - other[j])) > 10, 'the nudged run must diverge completely');

    // BELOW THE THRESHOLD the chaos genuinely switches off: at r = 10 the flow
    // settles onto a steady roll at sqrt(b(r-1)) and simply stops moving.
    const calm = run(setParam(demo.source, 'r', 10), demo.tSpan);
    const end = calm.col('x');
    ok(spread(slice(end, 0.9, 1)) < 1e-3, 'at r = 10 it must settle to a fixed point');
    close(Math.abs(end[end.length - 1]), Math.sqrt((8 / 3) * 9), 1e-3,
          'and the fixed point is the one the equations name');
  },

  'lotka-volterra': (demo) => {
    const r = run(demo.source, demo.tSpan);
    const x = r.col('x');
    const y = r.col('y');
    ok(Math.min(...x) > 0 && Math.min(...y) > 0, 'populations must never go negative');

    // Lotka-Volterra has an exact conserved quantity. It is the reason the
    // orbits close instead of spiralling, so it is the honest check here — and
    // it is rebuilt from the knobs as written, not from remembered numbers.
    const A = Number(readParam(demo.source, 'a'));
    const B = Number(readParam(demo.source, 'b'));
    const invariant = (rr, a, b) => {
      const p = rr.col('x');
      const q = rr.col('y');
      return p.map((v, i) => 0.25 * v - 0.75 * Math.log(v) + b * q[i] - a * Math.log(q[i]));
    };
    ok(drift(invariant(r, A, B)) < 1e-4, `the conserved quantity drifted by ${drift(invariant(r, A, B))}`);

    // The predator peak LAGS the prey peak — predators can only grow after
    // there is something to eat.
    ok(argmax(slice(y, 0, 0.5)) > argmax(slice(x, 0, 0.5)) + 100,
       'the predator peak must come well after the prey peak');

    // It swings hard, and it keeps swinging: the last cycle is as big as the
    // first, which is what "closed orbit" means on a t-y plot.
    ok(Math.max(...x) / Math.min(...x) > 4, 'the cycle should be dramatic, not a wobble');
    close(Math.max(...slice(x, 0.6, 1)), Math.max(...slice(x, 0, 0.4)), 0.02,
          'the cycle must not decay');

    // KNOB: the loop the same start sits on is set by the knobs. Slacken the
    // predation and this start lands on a far wider orbit — and it is still a
    // closed one, because the invariant is exact at every setting.
    for (const b of [0.2, 1.5]) {
      const other = run(setParam(demo.source, 'b', b), demo.tSpan);
      ok(drift(invariant(other, A, b)) < 1e-4, `at b = ${b} the orbit stopped being closed`);
    }
    const slack = run(setParam(demo.source, 'b', 0.2), demo.tSpan);
    const slackSwing = Math.max(...slack.col('x')) / Math.min(...slack.col('x'));
    ok(slackSwing > 2 * (Math.max(...x) / Math.min(...x)),
       `the predation knob should change the size of the cycle, got ${slackSwing}`);
  },

  duffing: (demo) => {
    // The drive period. Everything below is about whether the answer shares it.
    const T = (2 * Math.PI) / 1.2;

    /** How well the late motion repeats itself one drive period earlier. */
    const repeatError = (g) => {
      const r = run(setParam(demo.source, 'g', g), demo.tSpan, 8000);
      const x = r.col('x');
      const k = Math.round(T / (r.t[1] - r.t[0]));
      let worst = 0;
      for (let i = Math.floor(x.length * 0.75); i < x.length; i++) {
        worst = Math.max(worst, Math.abs(x[i] - x[i - k]));
      }
      return { worst, x };
    };

    // LOCKED: at g = 0.2 the answer has the drive's own period, to a hair,
    // and it never leaves the well it settled in.
    const locked = repeatError(0.2);
    ok(locked.worst < 0.05, `at g = 0.2 it should repeat the drive: error ${locked.worst}`);
    ok(zeroCrossings(slice(locked.x, 0.5, 1)) === 0, 'and stay in one well');

    // CHAOTIC: at the default it never repeats, and it hops between the wells
    // in an order with no period at all.
    const wild = repeatError(0.35);
    ok(wild.worst > 1, `at g = 0.35 it must not repeat: error ${wild.worst}`);
    ok(zeroCrossings(slice(wild.x, 0.5, 1)) >= 4,
       'the whole point is that it changes wells, repeatedly and late');
    ok(Math.max(...wild.x) > 0.8 && Math.min(...wild.x) < -0.8, 'it must visit both wells');

    // It is bounded chaos, not a blow-up: the two wells sit at x = +/-1 and it
    // never gets far from them.
    const r = run(demo.source, demo.tSpan);
    ok(r.report.stopped === undefined, 'the run must cover the whole window');
    ok(maxAbs(r.col('x')) < 2, `it must stay in the double well: reached ${maxAbs(r.col('x'))}`);

    // And the drive is what does it: with the shove almost off it falls into a
    // well and stays put, period-locked and tiny.
    const quiet = repeatError(demo.knobs[0].min);
    ok(quiet.worst < 0.05, 'a weak drive is period-locked too');
    ok(maxAbs(quiet.x) < maxAbs(wild.x), 'and much smaller than the chaotic one');
  },

  beats: (demo) => {
    // The two tones are 1 and 1 + b, so their sum is
    //   s = 2 cos(b t / 2) cos((1 + b/2) t),
    // an envelope of 2|cos(b t / 2)| on a carrier. Every number below is that
    // formula, and none of them is written in the document.
    const envelope = (b) => {
      const src = setParam(demo.source, 'b', b);
      const r = run(src, demo.tSpan, 8000);
      const s = r.col('x').map((v, i) => v + r.col('y')[i]);
      const sv = r.col("x'").map((v, i) => v + r.col("y'")[i]);
      return { r, s, e: amplitude(s, sv, 1) };
    };

    // UNISON: at b = 0 there is no beat at all. One tone, amplitude exactly 2,
    // for the whole window.
    const unison = envelope(0);
    close(Math.max(...unison.e), 2, 1e-3, 'two identical tones add to amplitude 2');
    ok(spread(unison.e) < 1e-3, `at b = 0 nothing should throb: spread ${spread(unison.e)}`);

    // BEATING: at the default the sum really does cancel — the envelope comes
    // within a twentieth of silence — and returns to full amplitude.
    const base = envelope(0.08);
    ok(Math.min(...base.e) < 0.1, `the beat never nulls: min ${Math.min(...base.e)}`);
    ok(Math.max(...base.e) > 1.9, 'and it must come back to full amplitude');

    // THE RATE, EXACTLY. The envelope crosses half amplitude wherever
    // |cos(b t / 2)| = 1/2, i.e. at t = (n pi/3) * 2/b for n not a multiple of
    // 3. Counting those in the window is a closed-form prediction of the
    // picture, and it must be right on the nose at every detuning.
    for (const b of [0.02, 0.08, 0.2, 0.5]) {
      let want = 0;
      for (let n = 1; (n * Math.PI) / 3 <= (b * demo.tSpan[1]) / 2; n++) if (n % 3 !== 0) want += 1;
      const got = zeroCrossings(envelope(b).e.map((v) => v - 1));
      close(got, want, 0, `b = ${b}: the beat rate should give ${want} half-amplitude crossings`);
    }

    // The sum is a derived row, not a state: it is drawn from the solution
    // rather than integrated, and it is the series this demo shows.
    ok(base.r.diagnostics.derived.join(',') === 's', 'the sum must be a derived row');
    ok(base.r.diagnostics.states.join(',') === "x,x',y,y'", 'and the states are the two springs');
    const m = new wasm.Model();
    m.set_source(demo.source);
    JSON.parse(m.solve(demo.tSpan[0], demo.tSpan[1]));
    const c = JSON.parse(m.conservation('s', 0));
    ok(c.ok === true, `the monitor must be able to read s: ${c.error}`);
    close(c.initial, 2, 1e-9, 'the two tones start in phase, so s starts at 2');
  },

  'noise-resonator': (demo) => {
    // 1. DETERMINISM, which is the property that makes noise integrable at
    // all. Two runs of the same document are the same numbers, bit for bit.
    const a = run(demo.source, demo.tSpan);
    const b = run(demo.source, demo.tSpan);
    for (let i = 0; i < a.col('x').length; i += 37) {
      ok(a.col('x')[i] === b.col('x')[i], `noise is not reproducible at sample ${i}`);
    }
    ok(a.report.stopped === undefined,
       'a band-limited noise source must not collapse the step size');

    // 2. IT IS THE NOISE DOING IT. Turn the level to zero and the resonator
    // sits at exactly zero forever — a control run, not an eyeball.
    const silent = run(setParam(demo.source, 'f', 0), demo.tSpan);
    close(maxAbs(silent.col('x')), 0, 0, 'with f = 0 nothing should move at all');
    ok(spread(a.col('x')) > 1, `with f = 1 it should really move: span ${spread(a.col('x'))}`);

    // 3. HISS IN, A PITCH OUT. The resonator answers at ITS OWN frequency
    // (w = 1, so 2 T / 2 pi crossings in the window) whatever the noise rate
    // is set to — that is what "resonance" means, and it is measurable.
    const expected = (2 * (demo.tSpan[1] - demo.tSpan[0])) / (2 * Math.PI);
    for (const rate of [1, 6, 40]) {
      const r = run(setParam(demo.source, 'r', rate), demo.tSpan);
      close(zeroCrossings(r.col('x')), expected, 3,
            `at noise rate ${rate} it should still ring at its own frequency`);
    }

    // 4. THE DAMPING KNOB IS THE WIDTH OF THAT RESONANCE: less damping, far
    // more of the hiss gets through at the peak.
    const sharp = rms(run(setParam(demo.source, 'c', 0.02), demo.tSpan).col('x'));
    const dull = rms(run(setParam(demo.source, 'c', 2), demo.tSpan).col('x'));
    ok(sharp > 4 * dull, `a sharper resonance should ring much louder: ${dull} -> ${sharp}`);
  },

  epidemic: (demo) => {
    const r = run(demo.source, demo.tSpan);
    const s = r.col('s');
    const i = r.col('i');
    const rr = r.col('r');

    // Nobody is created or destroyed. Nothing in the document says so — it is
    // a consequence of the three right-hand sides summing to zero.
    for (const v of s.map((v0, j) => v0 + i[j] + rr[j])) {
      close(v, 1, 1e-9, 's + i + r must stay exactly 1');
    }

    // Susceptibles only ever fall, recovered only ever rise.
    for (let j = 1; j < s.length; j++) {
      ok(s[j] <= s[j - 1] + 1e-12, 'susceptibles cannot increase');
      ok(rr[j] >= rr[j - 1] - 1e-12, 'the recovered count cannot fall');
    }

    // There is a real outbreak, and it is over by the end of the window.
    ok(Math.max(...i) > 0.2, `the epidemic never took off: peak ${Math.max(...i)}`);
    ok(i[i.length - 1] < 0.01, 'the outbreak should have burnt out inside the span');

    // The final size is not a guess either: it is the root of
    // 1 - s_inf = 1 - exp(-(b/g)(1 - s_inf)), which the curve must land on.
    const R0 = Number(readParam(demo.source, 'b')) / Number(readParam(demo.source, 'g'));
    let sInf = 0.5;
    for (let k = 0; k < 500; k++) sInf = Math.exp(-R0 * (1 - sInf));
    close(s[s.length - 1], sInf, 2e-3, 'the final susceptible fraction has a closed form');

    // BELOW THRESHOLD: b/g < 1 and the seed infection just fizzles. Checked
    // from both knobs, because the threshold is the ratio and not either one.
    for (const src of [setParam(demo.source, 'b', 0.05), setParam(demo.source, 'g', 0.6)]) {
      const damp = run(src, demo.tSpan);
      ok(Math.max(...damp.col('i')) <= 0.001 + 1e-9, 'below threshold nothing should grow');
      ok(damp.col('r')[damp.col('r').length - 1] < 0.05, 'and almost nobody is infected');
    }
  },
};

// =============================================================================
// Layers 1-4, applied to every demo.
// =============================================================================

const VIEWS = ['time', 'phase', 'polar', 'field'];

test('the gallery is not empty and has stable, unique ids', () => {
  ok(Array.isArray(DEMOS), 'DEMOS must be an array');
  ok(DEMOS.length >= 10, `expected a real gallery, got ${DEMOS.length} demos`);
  const ids = DEMOS.map((d) => d.id);
  ok(new Set(ids).size === ids.length, `duplicate ids: ${ids}`);
  for (const id of ids) ok(/^[a-z0-9-]+$/.test(id), `id ${id} should be a slug`);
});

test('demoById finds every demo and nothing else', () => {
  for (const d of DEMOS) ok(demoById(d.id) === d, `demoById lost ${d.id}`);
  ok(demoById('no-such-demo') === undefined, 'demoById must return undefined when it misses');
});

test('the gallery covers the views, the notation and the ear', () => {
  // A gallery that is all t-y is a gallery that never shows the equation
  // itself. Fields are the half people never see, so there are several.
  const fields = DEMOS.filter((d) => d.view === 'field');
  ok(fields.length >= 2, `expected at least two field demos, got ${fields.length}`);
  ok(DEMOS.some((d) => d.view === 'time'), 'something must be about t-y');

  const all = DEMOS.map((d) => d.source).join('\n');
  ok(/^d[a-z](_\d)?\/d[a-z]\d? = /m.test(all), 'nothing shows Leibniz notation');
  ok(/^df\/dx = /m.test(all), 'no integral written as a differential equation');
  ok(/^d2[a-z]\/d[a-z]2 = /m.test(all), 'nothing shows second-order Leibniz notation');
  ok(/^[a-z]' = /m.test(all), "nothing uses the x' spelling");
  ok(/^[a-z]'' = /m.test(all), "nothing uses the x'' spelling");
  ok(/^[a-z]\([a-z], [a-z]\) = /m.test(all), 'no function definition anywhere');
  ok(/(white|pink|brown|blue|smooth|telegraph)\(/.test(all), 'nothing uses the noise family');

  ok(DEMOS.filter((d) => d.audio).length >= 3, 'several demos should be worth hearing');
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
    // An example is read by looking at it. The title and blurb carry the
    // words; the source carries only the mathematics.
    ok(!demo.source.includes('#'), 'a demo source must carry no comments');
    // Rows are the cost of a demo, so there is a ceiling on them.
    const rows = demo.source.split('\n').filter((l) => l.trim().length > 0).length;
    ok(rows <= 9, `${rows} rows is too many to read at a glance`);
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

  // --- 2. view --------------------------------------------------------------

  test(at('declares the one view it is about'), () => {
    ok(typeof demo.view === 'string', 'a demo must say which view it is about');
    ok(VIEWS.indexOf(demo.view) >= 0, `view ${demo.view} is not one of ${VIEWS}`);
  });

  // --- 3. compiles ----------------------------------------------------------

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

  test(at('the view it declares is one the document can actually draw'), () => {
    const states = compiled.diagnostics.states;
    // The shell's rule, and this is the whole reason the layer exists: a demo
    // that declares a view its own document cannot draw arrives as a fallback
    // to t-y, which is a demo arriving as the wrong picture.
    if (demo.view === 'phase' || demo.view === 'field') {
      ok(states.length === 2,
         `${demo.view} needs exactly two states — this has ${states.length}: ${states}`);
    }
    if (demo.view === 'field') {
      // And `vector_field` has to actually answer for it.
      ok(field(demo.source, [-1, 1, -1, 1], 4, 4).length === 16, 'the field came back empty');
    }
    if (demo.view === 'polar') {
      ok(states.indexOf('r') >= 0, `polar needs a state named r, got ${states}`);
    }
  });

  // --- 4. interesting -------------------------------------------------------

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

  // --- 5. physics -----------------------------------------------------------

  test(at('obeys its physics'), () => {
    const check = PHYSICS[demo.id];
    // `show` is a display choice, but a name that does not exist is a typo the
    // shell would silently ignore — so it is checked here instead.
    if (demo.show !== undefined) {
      ok(Array.isArray(demo.show) && demo.show.length > 0,
         '`show`, when present, must be a non-empty array');
      const m = new wasm.Model();
      const d = JSON.parse(m.set_source(demo.source));
      const known = new Set([...(d.states || []), ...(d.derived || [])]);
      for (const name of demo.show || []) {
        ok(known.has(name),
           `show lists ${name}, which is neither a state nor a derived row`);
      }
      ok(demo.show.length < (d.states || []).length,
         '`show` that lists everything is pointless — drop it instead');
    }

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
