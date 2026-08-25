// Demo gallery.
//
// Demos are part of the product, not marketing (VISION.md). Each entry is a
// complete document in the v1 source format plus the sliders that make it
// worth touching.
//
// Rules every entry obeys, all enforced by `demos.test.mjs` against the real
// WASM build:
//
//   - only v1 document rows: `x' =`, `x'' =`, `k =`, `f(u) =`, `x(0) =`, `#`
//   - every knob `name` is a parameter that exists in the source, on its own
//     line, so the shell can rewrite that one line and re-solve
//   - it is interesting inside its own `tSpan`, at its own default knob values
//   - the source says what to look at in a line or two, and names the knobs
//     whose letters are not self-explaining. No essays.

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
 * @property {[number, number]} tSpan
 * @property {Knob[]} knobs
 * @property {boolean} audio   worth offering "render to sound"
 * @property {string[]} tags
 */

/** @type {Demo[]} */
export const DEMOS = [
  {
    id: 'plucked-string',
    // One string, so one line: the bead that carries the note.
    show: ['x_3'],
    title: 'Plucked string',
    blurb:
      'Six beads on a string, pulled aside and let go. Raise the tension and the pitch climbs; raise the damping and the note dies away. Turn up the stretch nonlinearity with a big pluck and the tone changes shape while it decays.',
    source: doc(`
      k = 60
      c = 0.15
      g = 0
      a = 1

      x_1'' = k(x_2 - 2x_1) + g((x_2 - x_1)^3 - x_1^3) - c x_1'
      x_2'' = k(x_3 - 2x_2 + x_1) + g((x_3 - x_2)^3 - (x_2 - x_1)^3) - c x_2'
      x_3'' = k(x_4 - 2x_3 + x_2) + g((x_4 - x_3)^3 - (x_3 - x_2)^3) - c x_3'
      x_4'' = k(x_5 - 2x_4 + x_3) + g((x_5 - x_4)^3 - (x_4 - x_3)^3) - c x_4'
      x_5'' = k(x_6 - 2x_5 + x_4) + g((x_6 - x_5)^3 - (x_5 - x_4)^3) - c x_5'
      x_6'' = k(x_5 - 2x_6) + g(-x_6^3 - (x_6 - x_5)^3) - c x_6'

      x_1(0) = 0.5a
      x_2(0) = a
      x_3(0) = 0.8a
      x_4(0) = 0.6a
      x_5(0) = 0.4a
      x_6(0) = 0.2a
      x_1'(0) = 0
      x_2'(0) = 0
      x_3'(0) = 0
      x_4'(0) = 0
      x_5'(0) = 0
      x_6'(0) = 0
    `),
    tSpan: [0, 20],
    knobs: [
      { name: 'k', min: 10, max: 250, step: 1, value: 60, label: 'tension' },
      { name: 'c', min: 0, max: 2, step: 0.01, value: 0.15, label: 'damping' },
      { name: 'g', min: 0, max: 300, step: 1, value: 0, label: 'stretch nonlinearity' },
      { name: 'a', min: 0.1, max: 3, step: 0.05, value: 1, label: 'pluck depth' },
    ],
    audio: true,
    tags: ['waves', 'coupling', 'audio', 'nonlinear'],
  },

  {
    id: 'colliding-strings',
    // Twelve states, but the thing being shown is two strings. Draw the middle
    // bead of each; the rest are still solved, they are just not the picture.
    show: ['a_2', 'b_2'],
    title: 'Colliding strings',
    blurb:
      'Two strings a knob apart, plucked away from each other so they swing back and clash. Wind the distance down and every cycle ends in a clatter; wind it up past about 1.2 and they never touch again, and ring on independently.',
    source: doc(`
      k = 60
      c = 0.2
      d = 0.5
      p = 20000
      r = 0.1
      q = 0.5

      a_1'' = k(a_2 - 2a_1) - c a_1' + p max(0, 2r - (d + a_1 - b_1))
      a_2'' = k(a_3 - 2a_2 + a_1) - c a_2' + p max(0, 2r - (d + a_2 - b_2))
      a_3'' = k(-2a_3 + a_2) - c a_3' + p max(0, 2r - (d + a_3 - b_3))
      b_1'' = k(b_2 - 2b_1) - c b_1' - p max(0, 2r - (d + a_1 - b_1))
      b_2'' = k(b_3 - 2b_2 + b_1) - c b_2' - p max(0, 2r - (d + a_2 - b_2))
      b_3'' = k(-2b_3 + b_2) - c b_3' - p max(0, 2r - (d + a_3 - b_3))

      a_1(0) = 0.5q
      a_2(0) = q
      a_3(0) = 0.5q
      b_1(0) = -q
      b_2(0) = -0.7q
      b_3(0) = -0.4q
      a_1'(0) = 0
      a_2'(0) = 0
      a_3'(0) = 0
      b_1'(0) = 0
      b_2'(0) = 0
      b_3'(0) = 0
    `),
    tSpan: [0, 12],
    knobs: [
      { name: 'd', min: 0.25, max: 2, step: 0.01, value: 0.5, label: 'string distance' },
      { name: 'k', min: 10, max: 250, step: 1, value: 60, label: 'tension' },
      { name: 'c', min: 0, max: 1.5, step: 0.01, value: 0.2, label: 'damping' },
    ],
    audio: true,
    tags: ['contact', 'collision', 'waves', 'coupling', 'audio'],
  },

  {
    id: 'harmonic-oscillator',
    title: 'Mass on a spring',
    blurb:
      'The whole of vibration in one row. Damping starts at zero, so the phase portrait is a perfect closed circle and the energy never moves; nudge c off zero and the circle becomes a spiral.',
    source: doc(`
      w = 1
      c = 0

      x'' = -w^2 x - c x'

      x(0) = 1
      x'(0) = 0
    `),
    tSpan: [0, 20],
    knobs: [
      { name: 'w', min: 0.2, max: 3, step: 0.01, value: 1, label: 'frequency' },
      { name: 'c', min: 0, max: 2, step: 0.01, value: 0, label: 'damping' },
    ],
    audio: false,
    tags: ['oscillator', 'conservation', 'phase-portrait', 'starter'],
  },

  {
    id: 'energy-drift',
    title: 'Does your integrator lie?',
    blurb:
      'An orbit with its energy written as a row. Energy should never change — so any change you see is the method, not the physics. Open the reference and switch the integrator: an adaptive method drifts away forever, a symplectic one wanders inside a band and stays there.',
    source: doc(`
      w = 1

      x'' = -w^2 x
      x(0) = 1
      x'(0) = 0

      E = 0.5(x'^2 + w^2 x^2)
    `),
    tSpan: [0, 400],
    knobs: [
      { name: 'w', min: 0.5, max: 4, step: 0.01, value: 1, label: 'frequency' },
    ],
    audio: false,
    tags: ['conservation', 'integrator', 'derived'],
  },

  {
    id: 'pendulum',
    title: 'Pendulum, swung hard',
    blurb:
      'A pendulum is only a sine wave when you barely disturb it. Started at 3 radians it hangs at the top and rushes through the bottom — pull the angle down toward zero and watch the shape relax into a sine and the period drop by half.',
    source: doc(`
      g = 9.81
      l = 1
      c = 0
      a = 3

      q'' = -(g/l) sin q - c q'

      q(0) = a
      q'(0) = 0
    `),
    tSpan: [0, 20],
    knobs: [
      { name: 'a', min: 0.1, max: 3.13, step: 0.01, value: 3, label: 'release angle' },
      { name: 'l', min: 0.2, max: 3, step: 0.01, value: 1, label: 'length' },
      { name: 'c', min: 0, max: 1, step: 0.01, value: 0, label: 'air drag' },
    ],
    audio: false,
    tags: ['oscillator', 'nonlinear', 'phase-portrait'],
  },

  {
    id: 'driven-resonance',
    title: 'Driven oscillator: resonance',
    blurb:
      'The same spring, now shaken at frequency u. Sweep u slowly through 1 and the response swells about twenty-fold, then collapses again — that peak is resonance, and lowering the damping makes it sharper and taller.',
    source: doc(`
      w = 1
      c = 0.15
      u = 1
      f = 0.5

      x'' = -w^2 x - c x' + f cos(u t)

      x(0) = 0
      x'(0) = 0
    `),
    tSpan: [0, 60],
    knobs: [
      { name: 'u', min: 0.1, max: 3, step: 0.01, value: 1, label: 'drive frequency' },
      { name: 'c', min: 0.02, max: 1, step: 0.01, value: 0.15, label: 'damping' },
      { name: 'f', min: 0, max: 2, step: 0.01, value: 0.5, label: 'drive strength' },
      { name: 'w', min: 0.2, max: 3, step: 0.01, value: 1, label: 'natural frequency' },
    ],
    audio: true,
    tags: ['oscillator', 'resonance', 'forcing', 'audio'],
  },

  {
    id: 'coupled-beats',
    title: 'Two pendulums, one spring',
    blurb:
      'Start one swinging and the other still. Within twenty seconds the first has stopped dead and the second has all the motion — then it hands it back. Coupling strength sets how fast they trade; this is the clearest picture of coupling there is.',
    source: doc(`
      w = 1
      c = 0.2

      x'' = -w^2 x + c(y - x)
      y'' = -w^2 y + c(x - y)

      x(0) = 1
      y(0) = 0
      x'(0) = 0
      y'(0) = 0
    `),
    tSpan: [0, 60],
    knobs: [
      { name: 'c', min: 0.02, max: 1, step: 0.01, value: 0.2, label: 'coupling' },
      { name: 'w', min: 0.5, max: 2, step: 0.01, value: 1, label: 'frequency' },
    ],
    audio: false,
    tags: ['coupling', 'oscillator', 'beats'],
  },

  {
    id: 'van-der-pol',
    title: 'Van der Pol: a limit cycle',
    blurb:
      'A spring with negative damping when it is small and positive damping when it is large, so it can neither die out nor run away. Every starting point winds onto the same loop — look at it in the phase view, and raise m to see the sine wave turn into a relaxation twitch.',
    source: doc(`
      m = 2

      x'' = m(1 - x^2)x' - x

      x(0) = 0.1
      x'(0) = 0
    `),
    tSpan: [0, 40],
    knobs: [
      { name: 'm', min: 0.1, max: 8, step: 0.05, value: 2, label: 'nonlinearity' },
    ],
    audio: true,
    tags: ['limit-cycle', 'nonlinear', 'phase-portrait', 'audio'],
  },

  {
    id: 'lotka-volterra',
    title: 'Predator and prey',
    blurb:
      'Hares boom, lynxes follow, hares crash, lynxes starve, repeat — forever, in a closed loop in the phase view. The peaks are permanently a quarter-cycle apart, and no knob setting ever damps the cycle out.',
    source: doc(`
      a = 1
      b = 0.5
      c = 0.75
      d = 0.25

      x' = a x - b x y
      y' = -c y + d x y

      x(0) = 6
      y(0) = 2
    `),
    tSpan: [0, 30],
    knobs: [
      { name: 'a', min: 0.2, max: 2, step: 0.01, value: 1, label: 'prey growth' },
      { name: 'b', min: 0.1, max: 1.5, step: 0.01, value: 0.5, label: 'predation' },
      { name: 'c', min: 0.2, max: 1.5, step: 0.01, value: 0.75, label: 'predator death' },
    ],
    audio: false,
    tags: ['ecology', 'coupling', 'phase-portrait', 'conservation'],
  },

  {
    id: 'sir-epidemic',
    title: 'Epidemic',
    blurb:
      'Three populations that only ever pass people between them, so the total is pinned at 1 forever. Drop the contact rate b below about 0.15 and the outbreak never starts at all — the curve goes flat, which is the entire argument for intervening early.',
    source: doc(`
      b = 0.6
      g = 0.15

      s' = -b s i
      i' = b s i - g i
      r' = g i

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
    tags: ['epidemiology', 'coupling', 'conservation'],
  },

  {
    id: 'lorenz',
    title: 'Lorenz: chaos',
    blurb:
      'The butterfly. Move the initial x by one part in a million — the a knob — and the two runs stay glued together for fifteen seconds before separating completely. Pull r below 24.7 and the chaos vanishes into a fixed point.',
    source: doc(`
      s = 10
      r = 28
      b = 8/3
      a = 1

      x' = s(y - x)
      y' = x(r - z) - y
      z' = x y - b z

      x(0) = a
      y(0) = 1
      z(0) = 20
    `),
    tSpan: [0, 40],
    knobs: [
      { name: 'a', min: 0.9, max: 1.1, step: 0.000001, value: 1, label: 'initial x' },
      { name: 'r', min: 0.5, max: 45, step: 0.1, value: 28, label: 'drive (Rayleigh)' },
      { name: 's', min: 2, max: 20, step: 0.1, value: 10, label: 'Prandtl' },
    ],
    audio: false,
    tags: ['chaos', 'nonlinear', 'phase-portrait'],
  },

  {
    id: 'orbit',
    title: 'Orbit',
    blurb:
      'Inverse-square gravity in two rows, written with a helper function for the distance. At v = 1 the orbit is a circle; anything else is an ellipse that swings out and speeds through perihelion, and past about 1.41 it never comes back.',
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
    tags: ['orbital', 'conservation', 'phase-portrait'],
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
