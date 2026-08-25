// Demo gallery.
//
// Demos are part of the product, not marketing (VISION.md). Each entry is a
// complete document in the v1 source format plus the sliders that make it
// worth touching.
//
// Rules every entry obeys, all enforced by `demos.test.mjs` against the real
// WASM build:
//
//   - as few rows as possible: a demo is read at a glance, so rows are the
//     cost. Any one row may be as long as it needs to be.
//   - no comments. The title and the blurb carry the words; the source carries
//     only the mathematics.
//   - `view` names the one view the demo is about — `time`, `phase`, `polar`
//     or `field`. Loading it shows exactly that and turns the others off.
//   - every knob `name` is a parameter that exists in the source, on its own
//     line, so the shell can rewrite that one line and re-solve
//   - it is interesting inside its own `tSpan`, at its own default knob values
//
// Between them the set is also the notation tour: `x'` and `dx/dt`, `x''` and
// `d2x/dt2`, `df/dx` as an integral, a function definition, a derived row, and
// the noise family.

/**
 * Strip the leading newline and the common indentation from a source block, so
 * documents can be written at a readable indent in this file and still reach
 * the parser flush left.
 * @param {string} text
 * @returns {string}
 */
function doc(text) {
  const lines = text.replace(/^\n/, '').replace(/\s+$/, '').split('\n');
  const widths = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => l.match(/^ */)[0].length);
  const indent = widths.length ? Math.min(...widths) : 0;
  return lines.map((l) => l.slice(indent)).join('\n');
}

/**
 * @typedef {object} Knob
 * @property {string} name    parameter name, must match a `name = ...` row
 * @property {number} min
 * @property {number} max
 * @property {number} step
 * @property {number} value   the value the source ships with
 * @property {string} [label] short human name for the slider
 *
 * @typedef {object} Demo
 * @property {string} id
 * @property {string} title
 * @property {string} blurb
 * @property {string} source
 * @property {'time' | 'phase' | 'polar' | 'field'} view
 * @property {[number, number]} tSpan
 * @property {Knob[]} knobs
 * @property {boolean} audio   worth offering "render to sound"
 * @property {string[]} tags
 * @property {string[]} [show] the series that ARE the picture
 */

/** @type {Demo[]} */
export const DEMOS = [
  {
    id: 'integral',
    title: 'An integral is a differential equation',
    blurb:
      'There is no integrate button, and there does not need to be one. Write the integrand as a derivative, say where the area starts, and the answer is the curve: df/dx = a x^(a-1) from f(0) = 0 is exactly x^a, so the horizontal axis is x and not t. Slide a and watch the parabola become a cubic.',
    view: 'time',
    source: doc(`
      a = 2
      df/dx = a x^(a - 1)
      f(0) = 0
    `),
    tSpan: [0, 3],
    knobs: [{ name: 'a', min: 1, max: 4, step: 0.05, value: 2, label: 'power' }],
    audio: false,
    tags: ['integral', 'leibniz', 'notation', 'starter'],
  },

  {
    id: 'rose',
    title: 'A rose in three rows',
    blurb:
      'Differentiate along an angle instead of along time and the plot is a polar one. dr/dq = -k sin(kq) from r(0) = 1 integrates to r = cos(kq), the rose curve — odd k gives k petals, even k gives 2k, and nothing in the document mentions a petal.',
    view: 'polar',
    source: doc(`
      k = 5
      dr/dq = -k sin(k q)
      r(0) = 1
    `),
    tSpan: [0, 6.283185307179586],
    knobs: [{ name: 'k', min: 1, max: 9, step: 1, value: 5, label: 'petals' }],
    audio: false,
    tags: ['polar', 'leibniz', 'closed-form'],
  },

  {
    id: 'energy-drift',
    title: 'Does your integrator lie?',
    blurb:
      'A spring, in Leibniz notation, with its energy written as a derived row — dashed, and measured along the solution. Energy cannot change here, so every wobble you see is the method rather than the physics. Switch the integrator: the adaptive one drifts away forever, the symplectic ones wander inside a band and stay in it.',
    view: 'time',
    source: doc(`
      w = 1
      d2x/dt2 = -w^2 x
      x(0) = 1
      x'(0) = 0
      E = 0.5(x'^2 + w^2 x^2)
    `),
    tSpan: [0, 400],
    knobs: [{ name: 'w', min: 0.5, max: 4, step: 0.01, value: 1, label: 'frequency' }],
    audio: false,
    tags: ['conservation', 'derived', 'integrator', 'leibniz'],
  },

  {
    id: 'hopf',
    title: 'Where a limit cycle comes from',
    blurb:
      'Two rows, one knob, and the arrows change their mind. Below a = 0 every arrow points inward and everything dies at the origin; above it a ring appears out of nothing at radius sqrt(a) and the whole plane winds onto it. The single curve only ever tells you about one starting point — the field tells you about all of them.',
    view: 'field',
    source: doc(`
      a = 0.5
      dx/dt = a x - y - x(x^2 + y^2)
      dy/dt = x + a y - y(x^2 + y^2)
      x(0) = 0.05
      y(0) = 0
    `),
    tSpan: [0, 40],
    knobs: [{ name: 'a', min: -0.6, max: 1.2, step: 0.01, value: 0.5, label: 'bifurcation' }],
    audio: false,
    tags: ['field', 'bifurcation', 'limit-cycle', 'leibniz'],
  },

  {
    id: 'pendulum-field',
    title: 'The whole pendulum at once',
    blurb:
      'One curve is one swing. The field is every swing there is: closed eyes around the hanging positions, a river of arrows along the top where the bob goes over instead of back, and the knife edge between them. Add air drag and the eyes turn into drains.',
    view: 'field',
    source: doc(`
      c = 0
      x' = y
      y' = -sin(x) - c y
      x(0) = 3.1
      y(0) = 0
    `),
    tSpan: [0, 40],
    knobs: [{ name: 'c', min: 0, max: 1.5, step: 0.01, value: 0, label: 'air drag' }],
    audio: false,
    tags: ['field', 'pendulum', 'nonlinear', 'separatrix'],
  },

  {
    id: 'van-der-pol',
    title: 'Every start, one loop',
    blurb:
      'Negative damping when it is small, positive when it is large, so it can neither die out nor run away: drop a point anywhere in the field and it winds onto the same loop. Wind m up and the sine wave collapses into a relaxation twitch — slow charge, sudden snap — which is why it buzzes rather than hums.',
    view: 'field',
    source: doc(`
      m = 2
      dx/dt = y
      dy/dt = m(1 - x^2)y - x
      x(0) = 0.1
      y(0) = 0
    `),
    tSpan: [0, 100],
    knobs: [{ name: 'm', min: 0.1, max: 8, step: 0.05, value: 2, label: 'nonlinearity' }],
    audio: true,
    tags: ['field', 'limit-cycle', 'nonlinear', 'audio'],
  },

  {
    id: 'orbit',
    title: 'Orbit',
    blurb:
      'Inverse-square gravity, kept to two rows by naming the awkward part once: d(p, q) is the cube of the distance, and both accelerations call it. Watch x and y against time — at v = 1 they are two clean sines a quarter turn apart, a circle; wind v away from it and they go lopsided, dawdling at the far point and racing through the near one. Past about 1.41 it never comes back.',
    view: 'time',
    show: ['x', 'y'],
    source: doc(`
      m = 1
      v = 1.1
      d(p, q) = (p^2 + q^2)^1.5
      x'' = -m x / d(x, y)
      y'' = -m y / d(x, y)
      x(0) = 1
      y(0) = 0
      x'(0) = 0
      y'(0) = v
    `),
    tSpan: [0, 20],
    knobs: [
      { name: 'v', min: 0.7, max: 1.35, step: 0.005, value: 1.1, label: 'launch speed' },
      { name: 'm', min: 0.5, max: 2, step: 0.01, value: 1, label: 'central mass' },
    ],
    audio: false,
    tags: ['orbital', 'function', 'conservation', 'kepler'],
  },

  {
    id: 'lorenz',
    title: 'Lorenz: the end of forecasting',
    blurb:
      'x flips between two wings at no time you could predict. Nudge the starting x by one part in a million: the new run lies on top of the old one for ten seconds, then peels off and never agrees with it again — that is the whole of chaos, on one t–y plot. Pull r below 24.7 and it switches off into a fixed point.',
    view: 'time',
    show: ['x'],
    source: doc(`
      r = 28
      a = 1
      x' = 10(y - x)
      y' = x(r - z) - y
      z' = x y - 8z/3
      x(0) = a
      y(0) = 1
      z(0) = 20
    `),
    tSpan: [0, 40],
    knobs: [
      { name: 'a', min: 0.9, max: 1.1, step: 0.000001, value: 1, label: 'starting x' },
      { name: 'r', min: 0.5, max: 45, step: 0.1, value: 28, label: 'drive (Rayleigh)' },
    ],
    audio: false,
    tags: ['chaos', 'nonlinear', 'sensitivity'],
  },

  {
    id: 'lotka-volterra',
    title: 'Predator and prey',
    blurb:
      'Hares boom, lynxes follow, hares crash, lynxes starve, and round it goes — a closed loop that no knob setting ever damps out, because there is an exact conserved quantity holding it shut. The predator peak is permanently a quarter turn behind the prey.',
    view: 'phase',
    source: doc(`
      a = 1
      b = 0.5
      dx/dt = a x - b x y
      dy/dt = -0.75y + 0.25x y
      x(0) = 2
      y(0) = 1
    `),
    tSpan: [0, 30],
    knobs: [
      { name: 'a', min: 0.4, max: 2, step: 0.01, value: 1, label: 'prey growth' },
      { name: 'b', min: 0.2, max: 1.5, step: 0.01, value: 0.5, label: 'predation' },
    ],
    audio: false,
    tags: ['ecology', 'conservation', 'phase-portrait', 'leibniz'],
  },

  {
    id: 'duffing',
    title: 'Two wells and a shove',
    blurb:
      'A spring that has been bent until it has two resting places, then shaken. At g = 0.2 it settles into one well and repeats the drive exactly; at 0.35 it hops between them in an order that never repeats, and the phase plane fills with a tangle instead of a loop. It is the sound of a rattling can, and one slider takes it there.',
    view: 'phase',
    source: doc(`
      g = 0.35
      x'' = x - x^3 - 0.3x' + g cos(1.2t)
      x(0) = 0.1
      x'(0) = 0
    `),
    tSpan: [0, 200],
    knobs: [{ name: 'g', min: 0.1, max: 0.6, step: 0.005, value: 0.35, label: 'drive strength' }],
    audio: true,
    tags: ['chaos', 'forcing', 'nonlinear', 'audio', 'phase-portrait'],
  },

  {
    id: 'beats',
    title: 'Two tones, one knob',
    blurb:
      'Two springs a hair apart in pitch, added together in a derived row. At b = 0 they are one tone, flat as a ruler. Nudge b and the sum swells, vanishes into silence, and swells again every 2 pi / b — nothing is fading, the two tones are simply taking turns cancelling. Push b further and the throb speeds up into roughness, and further still into two pitches you can name.',
    view: 'time',
    show: ['s'],
    source: doc(`
      b = 0.08
      x'' = -x
      y'' = -(1 + b)^2 y
      s = x + y
      x(0) = 1
      y(0) = 1
      x'(0) = 0
      y'(0) = 0
    `),
    tSpan: [0, 240],
    knobs: [{ name: 'b', min: 0, max: 0.5, step: 0.005, value: 0.08, label: 'detuning' }],
    audio: true,
    tags: ['audio', 'beats', 'derived', 'oscillator'],
  },

  {
    id: 'noise-resonator',
    title: 'A pitch out of hiss',
    blurb:
      'smooth(t, r) is band-limited noise, and it is a function rather than a draw: the same document gives the same hiss every time, which is the only reason a solver can integrate it at all. Feed it to a lightly damped spring and the spring answers at its own frequency no matter what you set r to — hiss in, a pitch out. Turn f to zero and the line goes flat.',
    view: 'time',
    source: doc(`
      c = 0.15
      r = 6
      f = 1
      x'' = -x - c x' + f smooth(t, r)
      x(0) = 0
      x'(0) = 0
    `),
    tSpan: [0, 60],
    knobs: [
      { name: 'c', min: 0.02, max: 2, step: 0.01, value: 0.15, label: 'damping' },
      { name: 'r', min: 1, max: 40, step: 0.5, value: 6, label: 'noise rate' },
      { name: 'f', min: 0, max: 3, step: 0.05, value: 1, label: 'noise level' },
    ],
    audio: true,
    tags: ['noise', 'audio', 'resonance', 'stochastic'],
  },

  {
    id: 'epidemic',
    title: 'Epidemic',
    blurb:
      'Three rows that only ever pass people between them, so s + i + r is pinned at 1 forever without anybody writing that down. Drop the contact rate b below the recovery rate g and the outbreak never starts — the curve stays flat at the seed it began with, which is the whole argument for acting early.',
    view: 'time',
    source: doc(`
      b = 0.6
      g = 0.15
      ds/dt = -b s i
      di/dt = b s i - g i
      dr/dt = g i
      s(0) = 0.999
      i(0) = 0.001
      r(0) = 0
    `),
    tSpan: [0, 80],
    knobs: [
      { name: 'b', min: 0.05, max: 1.5, step: 0.01, value: 0.6, label: 'contact rate' },
      { name: 'g', min: 0.05, max: 0.6, step: 0.01, value: 0.15, label: 'recovery rate' },
    ],
    audio: false,
    tags: ['epidemiology', 'conservation', 'threshold', 'leibniz'],
  },
];

/**
 * Look one up by id.
 * @param {string} id
 * @returns {Demo | undefined}
 */
export function demoById(id) {
  return DEMOS.find((d) => d.id === id);
}

export default DEMOS;
