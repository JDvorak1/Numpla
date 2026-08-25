// Demo gallery.
//
// Demos are part of the product, not marketing (VISION.md). Each one is a
// complete document in the v1 source format plus the sliders that make it
// worth touching: the knob is the whole point, because a model you can only
// look at teaches far less than one you can lean on.
//
// Rules every entry here obeys, all enforced by `demos.test.mjs` against the
// real WASM build:
//
//   - only v1 document rows: `x' =`, `x'' =`, `k =`, `f(u) =`, `x(0) =`, `#`
//   - every knob `name` is a parameter that actually exists in the source, on
//     its own line, so the shell can rewrite that one line and re-solve
//   - the source comments explain the physics; the source *is* the teaching
//     material, so nothing here is written to be clever
//   - it is interesting inside its own `tSpan`, at its own default knob values
//
// Identifiers follow the Desmos convention the lexer implements: one letter
// plus an optional subscript, so `x y` is a product and `x_3` is a name. That
// is why the string's masses are `x_1 .. x_6` and not `m1 .. m6`.

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
    title: 'Plucked string',
    blurb:
      'Six beads on a string, pulled aside and let go. Raise the tension and the pitch climbs; raise the damping and the note dies away. Turn up the stretch nonlinearity with a big pluck and the tone changes shape while it decays.',
    source: doc(`
      # A PLUCKED STRING
      #
      # A string is a chain of little masses, each one pulled toward its two
      # neighbours. Write that chain out and you have discretised the wave
      # equation: k(x_{i+1} - 2x_i + x_{i-1}) is the curvature of the string
      # around mass i, and curvature is what accelerates it.
      #
      # The two ends are nailed down. Mass 0 and mass 7 are the nut and the
      # bridge, so they never move and never appear as states — they show up
      # in rows 1 and 6 as the missing neighbour.

      # tension: how hard a neighbour pulls. This is the pitch.
      k = 60
      # damping: energy lost to the air and the bridge.
      c = 0.15
      # stretch nonlinearity: a real string gets stiffer the further you pull
      # it. At g = 0 the modes never talk; above it they trade energy and the
      # tone shifts as the note decays. Needs a big pluck (a) to bite.
      g = 0
      # pluck depth.
      a = 1

      x_1'' = k(x_2 - 2x_1) + g((x_2 - x_1)^3 - x_1^3) - c x_1'
      x_2'' = k(x_3 - 2x_2 + x_1) + g((x_3 - x_2)^3 - (x_2 - x_1)^3) - c x_2'
      x_3'' = k(x_4 - 2x_3 + x_2) + g((x_4 - x_3)^3 - (x_3 - x_2)^3) - c x_3'
      x_4'' = k(x_5 - 2x_4 + x_3) + g((x_5 - x_4)^3 - (x_4 - x_3)^3) - c x_4'
      x_5'' = k(x_6 - 2x_5 + x_4) + g((x_6 - x_5)^3 - (x_5 - x_4)^3) - c x_5'
      x_6'' = k(x_5 - 2x_6) + g(-x_6^3 - (x_6 - x_5)^3) - c x_6'

      # THE PLUCK: a triangle with its corner at mass 2, released from rest.
      # Every velocity starts at 0, which is what "let go" means.
      x_1(0) = 0.5a
      x_2(0) = a
      x_3(0) = 0.8a
      x_4(0) = 0.6a
      x_5(0) = 0.4a
      x_6(0) = 0.2a
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
    id: 'harmonic-oscillator',
    title: 'Mass on a spring',
    blurb:
      'The whole of vibration in one row. Damping starts at zero, so the phase portrait is a perfect closed circle and the energy never moves; nudge c off zero and the circle becomes a spiral.',
    source: doc(`
      # A MASS ON A SPRING
      #
      # The spring pulls back in proportion to how far the mass has moved
      # (-w^2 x) and the dashpot resists however fast it is moving (-c x').
      # One second-order row; the solver splits it into position and velocity
      # for you, which is why the phase portrait x against x' is available.

      # natural frequency: how stiff the spring feels.
      w = 1
      # damping. At 0 this runs forever; energy is exactly conserved.
      c = 0

      x'' = -w^2 x - c x'

      # Pulled aside by 1 and released from rest.
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
    id: 'pendulum',
    title: 'Pendulum, swung hard',
    blurb:
      'A pendulum is only a sine wave when you barely disturb it. Started at 3 radians it hangs at the top and rushes through the bottom — pull the angle down toward zero and watch the shape relax into a sine and the period drop by half.',
    source: doc(`
      # A PENDULUM AT LARGE ANGLE
      #
      # The textbook pendulum uses sin q = q, which is a lie that only holds
      # for small swings. Keep the sine and the swing is no longer a sine
      # wave in time: near the top the restoring pull almost vanishes, so the
      # bob loiters there, and the period grows with the amplitude.
      #
      # At a = 0.2 the period is 2.0 s. At a = 3.0 it is 5.0 s. Same pendulum.

      # gravity and length set the small-angle period, 2 pi sqrt(l/g).
      g = 9.81
      l = 1
      # air drag. Leave at 0 to compare periods honestly.
      c = 0
      # the angle it is released from, in radians. pi would be straight up.
      a = 3

      q'' = -(g/l) sin q - c q'

      q(0) = a
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
      # A DRIVEN, DAMPED OSCILLATOR
      #
      # Push a swing at any old rhythm and nothing much happens. Push it at
      # its own frequency and it grows until the damping can bleed away
      # exactly as much energy per cycle as you put in.
      #
      # The first few seconds are the transient — the oscillator's own ring,
      # dying at rate c. What survives is the drive, at the drive's frequency.
      # Steady-state amplitude peaks at u = w, where it is about f/(c w).

      # the oscillator's own frequency.
      w = 1
      # damping. Small damping means a tall, narrow resonance peak.
      c = 0.15
      # the DRIVE frequency. This is the knob to sweep.
      u = 1
      # how hard we shake it.
      f = 0.5

      x'' = -w^2 x - c x' + f cos(u t)

      # starts at rest, at the origin: everything you see was driven.
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
      # BEATING: ENERGY SLOSHING BETWEEN TWO OSCILLATORS
      #
      # Two identical pendulums, joined by a weak spring. The spring only
      # cares about the difference between them, so it pushes each one toward
      # the other: c(y - x) for the first, c(x - y) for the second. That is
      # the entire coupling — two terms.
      #
      # Alone, each has frequency w. Together they have two normal modes:
      # swinging together (still w) and swinging against each other (faster,
      # sqrt(w^2 + 2c)). Starting one pendulum alone excites both modes
      # equally, and the two frequencies drift in and out of step. When they
      # are out of step, all the motion is in one pendulum; the other is
      # completely still. Nothing was lost — it is all in the neighbour.

      # each pendulum's own frequency.
      w = 1
      # coupling: how stiff the spring between them is. Weak coupling means a
      # slow, complete handover; strong coupling means a fast, muddier one.
      c = 0.2

      x'' = -w^2 x + c(y - x)
      y'' = -w^2 y + c(x - y)

      # one pulled aside, one hanging still.
      x(0) = 1
      y(0) = 0
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
      # THE VAN DER POL OSCILLATOR
      #
      # m(1 - x^2)x' is a damping term that changes its mind. Near x = 0 the
      # bracket is positive, so the "damping" pumps energy IN. Out past
      # x = 1 it goes negative and takes energy back out. Neither rest nor
      # runaway is stable, so the system settles onto the one orbit where the
      # pumping and the bleeding cancel over a cycle: a LIMIT CYCLE.
      #
      # Change x(0), change x'(0), start anywhere you like — after a few
      # seconds you are on the same loop, at amplitude about 2. That is what
      # makes it a limit cycle rather than just an orbit: the system chooses
      # it, not the initial conditions. Heartbeats and neurons work this way.
      #
      # At large m the shape stops being a wave: it creeps, then snaps.

      # nonlinearity. Small m: nearly a sine. Large m: relaxation spikes.
      m = 2

      x'' = m(1 - x^2)x' - x

      # a tiny nudge off the (unstable) resting point is all it takes.
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
      # LOTKA-VOLTERRA: PREDATOR AND PREY
      #
      # x is prey, y is predators. Prey breed on their own (a x) and are
      # eaten at a rate set by how often the two meet (b x y). Predators
      # starve on their own (-c y) and are fed by the same meetings (d x y).
      # The product x y is the whole model: it is the coupling.
      #
      # The population sits at a fixed point when x = c/d and y = a/b.
      # Anywhere else it circles that point forever — the predator peak
      # always lags the prey peak by a quarter of a cycle, because predators
      # can only grow once there is something to eat.
      #
      # It never settles. There is a conserved quantity hiding in here, the
      # same way energy hides in a pendulum: d x - c ln x + b y - a ln y.

      # prey birth rate.
      a = 1
      # how efficiently predators find prey.
      b = 0.5
      # predator death rate.
      c = 0.75
      # how much a meal is worth to a predator.
      d = 0.25

      x' = a x - b x y
      y' = -c y + d x y

      # well away from the fixed point (3, 2), so the swings are big.
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
      # THE SIR EPIDEMIC MODEL
      #
      # s susceptible, i infected, r recovered — as fractions of one
      # population. Nobody is created or destroyed: every term that leaves
      # one row arrives in another, so s + i + r stays exactly 1. That is a
      # conservation law, and it is worth watching the solver hold it.
      #
      # b s i is the meeting term again (see the predator-prey demo — the
      # mathematics does not care that one is foxes and the other is flu).
      # g i is recovery.
      #
      # The outbreak grows only while b s > g. Since s starts at ~1, the
      # whole story is the ratio b/g: above 1 there is an epidemic, below 1
      # the seed infection just fizzles. Nothing else matters at the start.

      # contact rate.
      b = 0.6
      # recovery rate — 1/g is how long people stay infectious.
      g = 0.15

      s' = -b s i
      i' = b s i - g i
      r' = g i

      # one person in a thousand starts out infected.
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
      # THE LORENZ SYSTEM
      #
      # A savagely cut-down model of a convecting fluid: x is the roll speed,
      # y and z are two temperature differences. Three rows, two nonlinear
      # terms (x z and x y), and no periodic solution anywhere.
      #
      # The trajectory never repeats and never escapes. It circles one wing
      # of the attractor a while, then flips to the other, with no rule you
      # can write down for when.
      #
      # SENSITIVE DEPENDENCE: a is just the starting x. Change it from 1 to
      # 1.000001 — a millionth — and the two runs are indistinguishable for
      # about fifteen seconds, then have nothing to do with each other. This
      # is why weather forecasts stop, and it is why "deterministic" and
      # "predictable" are not the same word.
      #
      # r is the drive. Below about 24.74 all this stops and the flow settles
      # onto a steady roll; the chaos genuinely switches off.

      s = 10
      r = 28
      b = 8/3
      # the starting x. Nudge the last digit.
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
      # AN ORBIT
      #
      # Gravity pulls toward the origin, along (x, y), with strength m/r^2.
      # Splitting that into components divides by another r, so each row
      # carries m/r^3 — which is what the helper row below computes once and
      # both rows then use.
      #
      # A helper function is an ordinary row: name it, give it arguments, use
      # it anywhere.
      #
      # At v = 1 the pull exactly matches what a circle needs. Slower and the
      # orbit falls inward into an ellipse; faster and it swings out into a
      # longer one, moving slowest at the far end and fastest at the near end
      # — Kepler's second law, visible as the spacing of the trail. Past
      # v = sqrt(2) = 1.414 it is a hyperbola and never returns.
      #
      # Two things stay fixed to machine precision the whole way round:
      # energy, and angular momentum x y' - y x'. Good test of a solver.

      # the central mass (times G).
      m = 1
      # the speed it is launched with, sideways, from a distance of 1.
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
