# WASM API contract — v1

The boundary between the Rust core and the browser shell. Both sides are built
against this document, so it is the source of truth: if the code disagrees with
this file, the code is wrong.

Design rules:

- **JSON for structure, `Float64Array` for bulk numbers.** Trajectory samples
  cross the boundary as flat `f64` arrays with no per-point allocation.
- **Nothing throws across the boundary.** Every call returns a value; problems
  are reported as diagnostics data. Half-typed input is a normal state, not an
  error — that is the gray-not-red rule, enforced at the API level.
- **A solve always answers.** An integration that gives up part-way returns the
  part it managed, not an error. `x' = x^2` blowing up at `t = 1` is the reason
  someone typed it; a blank plot is never the right answer to it. See
  "Runs that stop early".
- **`numpla-wasm` holds no logic.** It marshals, and that is all.

## Document source format (v1)

Plain text, one row per line. Blank lines and `#` comments are ignored.

```
# a harmonic oscillator
x' = -y
y' = x
x(0) = 1
y(0) = 0
```

Row kinds:

| Form | Meaning |
|---|---|
| `x' = <expr>` | ODE row. `x` becomes a state variable. |
| `x'' = <expr>` | Second order. Lowered to two first-order states (see below). |
| `dx/dt = <expr>` | The same ODE row in Leibniz notation. The denominator names the independent variable — see below. |
| `d2x/dt2 = <expr>` | Second order, Leibniz. `d^2x/dt^2` spells the same thing. |
| `x(0) = <number>` | Initial condition for state `x`. Defaults to 0 if absent, *and says so* — see "missing information". |
| `k = <expr>` | Parameter/constant, visible to every row. |
| `E = <expr reading states or t>` | **Derived row** — a function of the solution, not a constant. See below. |
| `f(x) = <expr>` | Function definition. |

### Derived rows

A `name = ...` row whose expression reads a state, a lowered velocity, the
independent variable, or another derived row is not a constant: it has no value
until there is a trajectory to read it along. The compiler recognises that and sets it aside.

```
x'' = -x
x(0) = 1
x'(0) = 0
E = 0.5(x'^2 + x^2)      # derived: the energy, sampled along the solution
```

Derived rows appear in `Diagnostics.derived`, **not** in `params`, and they are
the names `conservation` accepts. They may be written in named pieces —
`K = 0.5x'^2`, `U = 0.5x^2`, `E = K + U` — and are relaxed against each other at
every sample, so order does not matter here either. A typo inside one is
reported when it is typed, like any other row.

An ODE right-hand side may *read* a derived row — `x' = -E` with `E = 0.5x^2`
is the substitution it looks like, and the cheapest spelling of a feedback
loop there is. The named quantity is evaluated at the solver's own `(t, y)` on
every call, through the same environment as everything else, so the solve
agrees with the probe pass that accepted the row. A derived damping term
(`x'' = -x - D`, `D = 0.4x'`) is still damping: it costs Verlet the iterated
kick and the run its `symplectic` flag, exactly as the inline spelling does.

Added after v1. Previously such a row was an `"error"` ("`x` is not defined"),
so the change only ever turns red rows green.

Second-order rows are lowered automatically: `x'' = -x` introduces a hidden
state for `x'`, and `x'(0) = v` sets its initial condition. State order in all
vectors is **declaration order of the ODE rows**, with each lowered velocity
state placed immediately after its position state.

Inside an ODE right-hand side, the independent variable is bound to the
current value of the solver's parameter — `t` unless the document says
otherwise, which is what the next section is about.

### Leibniz notation, and the independent variable

`dx/dt = -y` and `x' = -y` are the same row in every respect: the same parsed
tree, the same state vector, the same trajectory to the last bit. A document
may use either spelling, or both.

The difference is that the Leibniz row says one extra thing — **the denominator
names the independent variable**:

```
df/dx = 2x
f(0) = 0
```

integrates `f` along `x` and gives `f = x²`. An integral is a differential
equation you already know how to write, and the horizontal axis of that plot is
`x`, not `t`.

| | |
|---|---|
| spellings | `dx/dt`, `d2x/dt2`, `d^2x/dt^2`. Whitespace is irrelevant (`d x / d t` is the same row). Numerator and denominator orders must match; `d2x/dt` is reported. |
| default | A document of `x' = ...` rows names no independent variable and gets `t`, exactly as before. |
| one per document | Mixing `dx/dt` and `dy/ds` is an **error on both rows**, each naming the other's line. There is one solver parameter and one horizontal axis, so there is nothing to pick between. |
| where it reaches | `Diagnostics.independent`. It is the environment key the solver binds every step, the name a right-hand side may legitimately read, and the label the horizontal axis deserves. |

**`d` is still an ordinary name.** The notation is recognised only when it
spans the *whole* left-hand side of an `=`, so `d = 0.25` is a parameter and
`y' = -c y + d x y` reads `d` as the coefficient it is. A `dx/dt` written
inside an expression, or without an `=`, stays the arithmetic it always was —
reading it as a derivative there would need a symbolic derivative rather than
a notation, and is deliberately not attempted.

Every document whose meaning this changes was previously a red row (`dx/dt = 1`
was an unsupported implicit equation), so the addition can only turn red rows
green.

### Calls and coefficients

`f(u)` is a call; `g (u)` is `g` times `u`. Which one a row means is decided by
the rest of the document: a name with an `f(u) = ...` row is a function, and
every other name followed by `(` is a coefficient. So `f(y - x)^3` cubes the
result of a call, while `g (y - x)^3` cubes the difference and then scales it —
the same tokens, two different systems.

Because the answer depends on the whole document, `set_source` reads the rows
twice: once to gather the function definitions, once to build the trees. This
is why a row cannot be compiled on its own.

### `rand()`

`rand()` and `randn()` are *numbers*, not draws from a stream — the same
document reopened gives the same numbers, which is what makes a model with
randomness in it reproducible and integrable (see `numpla-noise`). Each call
site in a document gets its own stream, so two `rand()`s are two different
numbers, and a site keeps its stream when unrelated rows are edited.
`rand(s)` names a stream explicitly and is left exactly as written.

## Exported API

```rust
#[wasm_bindgen]
pub struct Model;

#[wasm_bindgen]
impl Model {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Model;

    /// Replace the whole document. Returns Diagnostics as a JSON string.
    /// Never throws: unparseable rows come back as diagnostics.
    pub fn set_source(&mut self, src: &str) -> String;

    /// Integrate over [t0, t1] with the default method (Tsit5).
    /// Returns SolveReport as a JSON string.
    /// Safe to call when the document is invalid — reports ok: false.
    /// A run that gives up part-way reports ok: true with tEnd < t1
    /// and a `stopped` object — see "Runs that stop early".
    pub fn solve(&mut self, t0: f64, t1: f64) -> String;

    /// Integrate with a named method: "Tsit5" | "Verlet" | "Yoshida4",
    /// case-insensitive. Returns SolveReport as a JSON string.
    /// An unknown name is reported, never silently defaulted.
    pub fn solve_with(&mut self, t0: f64, t1: f64, method: &str) -> String;

    /// The available methods as JSON, in slider order. Static — call as
    /// `Model.methods()`, no instance needed.
    pub fn methods() -> String;

    /// Uniformly sample the last solution: n points, flattened row-major as
    /// [t, y_0, .., y_{d-1}] repeated n times. Length = n * (dim + 1).
    /// Spans [t0, tEnd] — what was integrated, not what was asked for.
    /// Empty if there is no solution.
    pub fn sample(&self, n: usize) -> Vec<f64>;

    /// State at one time, length = dim. Clamped to the integrated span:
    /// past tEnd it holds the last state reached, it never extrapolates.
    /// Empty if there is no solution.
    pub fn eval(&self, t: f64) -> Vec<f64>;

    /// The right-hand side sampled on a grid across [x0,x1] x [y0,y1], at
    /// time `t`. Flat, row-major, four numbers per sample:
    /// [x, y, dx, dy] repeated nx * ny times, with x varying fastest.
    /// Empty when the document does not have exactly two states, does not
    /// compile, or the grid is empty. Never throws.
    pub fn vector_field(&self, x0: f64, x1: f64, y0: f64, y1: f64,
                        nx: usize, ny: usize, t: f64) -> Vec<f64>;

    /// One trajectory from an explicit starting state, sampled uniformly.
    /// Flat: [t, y_0 .. y_{dim-1}] * n — the same layout as `sample`.
    /// Does NOT disturb the stored solution.
    /// Empty when y0.len() != dim, n is 0, the method name is unknown, or
    /// the document cannot be integrated. Never throws.
    /// Obeys the same stop-early rule as `solve`.
    pub fn trajectory_from(&self, t0: f64, t1: f64, method: &str,
                           y0: &[f64], n: usize) -> Vec<f64>;

    /// StepRecord list as JSON — for the telemetry strip.
    pub fn telemetry(&self) -> String;

    /// Track a named row along the last solution.
    /// Returns ConservationReport as a JSON string.
    /// `samples` is a floor, not a quota — pass 0 to let the model choose.
    pub fn conservation(&mut self, name: &str, samples: usize) -> String;

    /// The series behind the last `conservation` call, flattened as
    /// [t, value] pairs. Length = 2 * samples. Empty if that call failed.
    pub fn conservation_series(&self) -> Vec<f64>;
}
```

`Vec<f64>` returns arrive in JS as a `Float64Array`.

## JSON shapes

```jsonc
// Diagnostics — returned by set_source
{
  "states": ["x", "y"],          // state vector order, length = dim
  "params": ["k"],               // named constants in scope
  "derived": ["E"],              // rows that are functions of the solution;
                                 // always present, [] when there are none.
                                 // These are the names `conservation` accepts.
  "independent": "t",            // what the rows differentiate with respect
                                 // to: the `t` of `dx/dt`, the `x` of `df/dx`.
                                 // Always present; "t" when nothing said.
                                 // Label the horizontal axis with it.
  "issues": [
    {
      "line": 3,                 // 0-based line in the source
      "severity": "error",       // "error" | "pending"
      "message": "missing )",
      "start": 5, "end": 6       // byte offsets within that line
    },
    {
      "line": 1,
      "severity": "pending",
      "message": "y has no starting point",
      "start": 0, "end": 7,
      "fix": {                   // optional; absent when nothing is proposed
        "label": "add y(0) = 0", // button text, imperative
        "insert": "y(0) = 0"     // a complete row to append to the document
      }
    }
  ]
}
```

`severity: "pending"` means *incomplete, not wrong* — the UI must render it in
the muted style, never as an error. `"error"` means genuinely broken.

Issues found by evaluating a row rather than by reading a token span the whole
row: `start` is 0 and `end` is the length of the row's code (comments and
trailing whitespace excluded). There is always something real to highlight.

### `fix` — the row the compiler would write

Added after v1, and backwards compatible: the key is **absent entirely** unless
the compiler can propose something concrete. Never `null`.

| field | meaning |
|---|---|
| `label` | Button text, imperative — "add y(0) = 0". |
| `insert` | A **complete, parseable row**. Append it to the document verbatim and call `set_source` again. |

The shell should append `insert` as a new line at the end of the document. Each
distinct proposal is offered **once**, on the earliest row that wants it, so
three rows waiting on the same undefined name produce three pending issues and
one button — clicking it resolves all three.

### Missing information

The compiler reports what the document still needs rather than guessing in
silence, and proposes the answer instead of demanding it (`docs/ui-v3.md` §3).

| situation | severity | message | fix | blocks `solve`? |
|---|---|---|---|---|
| state has no initial condition | `pending` | "`y` has no starting point" | append `y(0) = 0` | no |
| lowered velocity state has none | `pending` | "`x'` has no starting point" | append `x'(0) = 0` | no |
| name used but never defined | `pending` | "`k` is not defined yet" | append `k = 1` | yes |

`line` points at the row that **introduced the state** — the ODE row — because
that is the line a person can look at and see why the state exists.

A missing initial condition does **not** stop the document integrating: it is
reported and defaulted to 0 in the same pass, so the model still draws. An
undefined name does stop it, because nothing has been assumed on the user's
behalf and there is nothing to integrate until the proposal is accepted.
`solve` reports that as `ok: false` with a message naming the row.

A genuine mistake — bad syntax, a wrong arity, a row the format has no meaning
for — stays `"error"` and carries no `fix`.

```jsonc
// SolveReport — returned by solve and solve_with
{
  "ok": true,
  "t0": 0.0, "t1": 20.0,         // the window that was *asked for*
  "tEnd": 20.0,                  // the window that was *integrated*
                                 // `stopped` absent => tEnd === t1
  "dim": 2,
  "states": ["x", "y"],
  "accepted": 84, "rejected": 3, "rhsEvals": 522,
  "method": "Verlet",            // the integrator that produced this solution
  "symplectic": true,            // did this *run* preserve the symplectic form
  "error": null                  // else a human-readable string, ok: false
}
```

### Runs that stop early

Added after v1. Backwards compatible in shape — `tEnd` is a new key and
`stopped` is **absent entirely** on a run that reached `t1`, never `null` —
but *not* in meaning: solves that used to come back `ok: false` on a blowup now
come back `ok: true` with a shorter curve.

```jsonc
// x' = x^2, x(0) = 1, asked for [0, 5]. It exists only up to t = 1.
{
  "ok": true,                    // there is a curve, and it is the right curve
  "t0": 0.0, "t1": 5.0,
  "tEnd": 1.0000003,             // where it actually got
  "stopped": {
    "reason": "stepTooSmall",    // "stepTooSmall" | "nonFinite" | "tooManySteps"
    "message": "stopped at t = 1 — the step size collapsed there; the system is
                probably stiff, or heading for a singularity"
  },
  "dim": 1, "states": ["x"],
  "accepted": 141, "rejected": 126, "rhsEvals": 1863,
  "method": "Tsit5", "symplectic": false,
  "error": null                  // `stopped` is not an error
}
```

**What `ok` means.** *Is there a solution to draw* — not *did everything go
well*. A run that blew up at `t = 1` produced a correct curve on `[0, 1]`, and
that curve is the most interesting thing Numpla can put on screen, so it is
`ok: true`. `ok: false` means **nothing was integrated at all** and
`sample`/`eval` are empty: a document that will not compile, no ODE rows, a
symplectic method asked of a first-order document, an unknown method name.

| | `ok` | `error` | `stopped` | `tEnd` | `sample`/`eval` |
|---|---|---|---|---|---|
| covered the whole span | `true` | `null` | absent | `= t1` | the full curve |
| gave up part-way | `true` | `null` | present | `< t1` | the curve so far |
| never started | `false` | a sentence | absent | `= t0` | empty |

| `reason` | what happened |
|---|---|
| `stepTooSmall` | the step size collapsed — stiffness, or a finite-time singularity |
| `nonFinite` | the state stopped being a number — a blowup, or a NaN out of a row |
| `tooManySteps` | the step budget ran out before the end of the window |

**How a shell must present a partial run.**

- **Draw it.** `sample(n)` spans `[t0, tEnd]`, so the curve simply ends where
  the run did. Its last `t` equals `tEnd`; use that, not `t1`, for the plot's
  right-hand edge or for a "how far along" readout.
- **Never present it as complete.** The window the user asked for is `t1` and
  the window they got is `tEnd`. Show the difference — the honest reading is a
  marker at `tEnd` with the rest of the window left visibly empty, so the gap
  between the curve's end and the window's end is the thing that says what
  happened. Filling that gap, or rescaling the axis to `tEnd` so the curve
  looks full-width, is exactly the lie this contract exists to prevent.
- **Show `message` as a caption, not as an error.** It is a fact about the
  model, phrased for a person and always naming where. Style it like the muted
  `"pending"` severity rather than the red `"error"` one: nothing is broken, and
  for `x' = x^2` the blowup is the answer.
- **Do not blank anything on it.** The telemetry strip, the conservation
  monitor and the scrubber all work on a partial solution, over the shorter
  span. The rejected steps piling up near `tEnd` are the picture of the run
  running out of road, which is the most instructive thing on screen.
- **`eval(t)` past `tEnd` holds** the last state reached, for the whole
  remainder of the window — it does not extrapolate. Dragging the scrubber into
  the empty region is safe and gives a flat, finite reading, which reads
  correctly as "nothing is known here".

A caller that genuinely needs the whole span — a batch export, a convergence
check — compares `stopped` against absent. There is no separate strict entry
point; the distinction is a field, not a second API.

```jsonc
// telemetry
{
  "steps": [ { "t": 0.0, "dt": 0.01, "error": 0.42, "accepted": true } ]
}
```

A fixed-step method has no error estimate to report, so after a `Verlet` or
`Yoshida4` run every step is `"error": 0.0, "accepted": true` and the strip has
only step size to draw. `methods()[i].adaptive` says which kind is on screen.

## Choosing a method

The mode slider is the point of this. Three integrators over one state layout
and one solution type; swapping them changes the shape of the error and nothing
else about the call.

```jsonc
// methods — returned by Model.methods(), in slider order
{
  "methods": [
    { "name": "Tsit5",    "adaptive": true,  "symplectic": false, "order": 5 },
    { "name": "Verlet",   "adaptive": false, "symplectic": true,  "order": 2 },
    { "name": "Yoshida4", "adaptive": false, "symplectic": true,  "order": 4 }
  ]
}
```

**The method is an argument, not a setting.** There is no `set_method`: the call
that produces an answer is the one that says which method produced it, so the
report and the drawn curve cannot drift apart. `solve(t0, t1)` is exactly
`solve_with(t0, t1, "Tsit5")`.

**`method` vs `symplectic`.** `method` is what ran. `symplectic` is what the run
achieved, and they are different questions: Verlet applied to
`x'' = -x - 0.4x'` is a symplectic *method* on a system with no symplectic
structure left to preserve, and reports `"method": "Verlet", "symplectic":
false`. Only the model layer can answer that, because only it knows whether the
acceleration row mentions `x'`. Label a plot from `method`; set the conservation
monitor's expectations from `symplectic`.

### Symplectic methods need second-order rows

`Verlet` and `Yoshida4` integrate positions and velocities separately, so they
have to know which states are which. A document of plain `x' = ...` rows never
said, and **that is reported rather than worked around**:

```jsonc
{
  "ok": false,
  "method": "Verlet", "symplectic": false,
  "error": "Verlet needs second-order rows — x is a first-order row, so the
            document has no position/velocity structure. Write it as
            `x'' = ...`, or choose Tsit5"
}
```

There is deliberately **no silent fallback to Tsit5**. For the first few periods
of a well-behaved system the two curves are indistinguishable, so a fallback
would draw a Tsit5 curve under a label reading "Verlet" and teach the opposite of
what the slider exists to show. A mixed document — one first-order row among
second-order ones — is refused the same way, naming the row.

Shell consequence: if the current document has no second-order rows, the
symplectic entries on the slider are not available. Either disable them, or let
the click happen and render the returned sentence — it names the row and the
fix. `solve` invalidates the previous solution *before* it checks, so a refused
solve leaves `sample`/`eval` empty rather than showing a stale curve.

### Step size

Fixed-step methods take their step from the visible window: `(t1 - t0) / 5000`.
Chosen so that dragging the slider does not change the frame time — Tsit5 at its
default tolerance spends roughly the same number of right-hand-side evaluations
on the same window — and so Verlet's second-order error stays under a pixel for
a window with tens of oscillations in it. The honest consequence: a wider window
is a coarser step, so a symplectic energy band *widens* as you zoom out. It stays
flat across the run, which is the property being shown.

## The field, and seeds

Added after v1, and purely additive: nothing existing changes shape. Two calls
that together turn one curve into a portrait — the equation as a field of
arrows, and as many trajectories through it as somebody cares to place. See
`docs/fields-and-seeds.md` for the view they are built for.

### `vector_field(x0, x1, y0, y1, nx, ny, t)`

The right-hand side evaluated on a grid across the visible window.

```js
const f = model.vector_field(xMin, xMax, yMin, yMax, 24, 16, t0);
// sample (i, j) — column i of row j — is four numbers at 4 * (j * nx + i)
for (let j = 0; j < ny; j++)
  for (let i = 0; i < nx; i++) {
    const k = 4 * (j * nx + i);
    const [x, y, dx, dy] = f.subarray(k, k + 4);
  }
```

| | |
|---|---|
| layout | flat, row-major, `[x, y, dx, dy]` per sample; `x` varies fastest |
| length | `nx * ny * 4` |
| grid | endpoint-inclusive in both directions — `x0` and `x1` are both sampled. `nx == 1` sits on `x0`, the same rule `sample` uses for a single time |
| empty when | the document does not have exactly two states, does not compile, has a name it is still waiting on, `nx` or `ny` is 0, or a row could not be evaluated at some sample |

**What a shell does with an empty return: draw nothing and offer the `phase`
view's explanation.** Empty is not an error and carries no message — it is the
same "there are not two axes here" that `phase` already answers, plus the
ordinary "this document does not compile yet", which the issue bar is already
showing. A field of zero-length arrows is what a *stationary* system looks like,
so a failed evaluation returns nothing rather than a picture of rest.

**`t` is an argument, not zero.** A non-autonomous system — `x' = y`,
`y' = -sin(t)` — genuinely has a different field at every instant. Sample it at
the left edge of the window and **say so on screen**; a time-dependent field
drawn without a time on it is the same class of lie as a partial run drawn
full-width.

**The arrows are the solver's own evaluation.** `vector_field` and every
integration in the product go through one `ModelSystem` — the same right-hand
side, the same environment, the same reading of the rows. So an arrow is the
tangent of the trajectory through the point it sits on, by construction and not
by coincidence, and it stays so whichever method drew the curves on top of it.

### `trajectory_from(t0, t1, method, y0, n)`

One trajectory from a starting point the user placed. `method` is spelled the
way `solve_with` spells it.

```js
model.solve(t0, t1);                       // the document's own curve
const own = model.sample(n);
const seed = model.trajectory_from(t0, t1, "Tsit5", new Float64Array([2, 0]), n);
model.sample(n);                           // — still `own`, exactly
```

| | |
|---|---|
| layout | flat, `[t, y_0, .., y_{dim-1}]` per sample — identical to `sample` |
| length | `n * (dim + 1)`, unless empty |
| span | `[t0, tEnd]`, so a seed that stopped early ends where it stopped |
| empty when | `y0.len() != dim`, `n == 0`, the method name is unknown, the method is symplectic and the document has no second-order rows, or the document does not compile |

**It does not disturb the stored solution.** The document's own curve, its
telemetry and its conservation series are exactly where `solve` left them, after
any number of seeds, in any order, with any method — including a seed that fails.
Nothing is cached either: a trajectory belongs to the seed that asked for it. So
the drawing loop is `solve` once, then `trajectory_from` per seed, and the frame
can be rebuilt in any order without a re-`solve`. Seeds are a *view* of the
model: placing one does not rewrite the document and does not touch what the
document already answered.

**What a shell does with an empty return: drop that seed from the frame and
leave the rest alone.** There is no report and no message, because every empty
case is one the shell can already see: a `y0` from before the document grew a
row (compare its length against `Diagnostics.states`), a symplectic method on a
first-order document (the same refusal the mode slider already renders, from
`solve_with`), or a document that is not compiling (the issue bar has it). One
seed coming back empty says nothing about the others.

**A seed that blows up returns the part that worked**, exactly as `solve` does.
There is no per-seed `stopped` object — the last sample's `t` is where it
stopped. Read it, and end that curve there; stretching a seed's samples across
the full window, or rescaling the axes to it, is the same lie the main run's
`tEnd` exists to prevent. Different seeds legitimately end at different times,
which is a picture worth drawing: it is where the interesting region is.

## Conservation

The Ge–Marsden trade-off (`docs/solvers.md`) says no fixed-step method preserves
the symplectic form, momentum and energy at once. The monitor is how you *see*
which one a method gave up: write the invariant as a derived row, integrate,
and watch the line.

```jsonc
// ConservationReport — returned by conservation(name, samples)
{
  "ok": true,
  "name": "E",
  "samples": 5001,               // what was actually taken — see below
  "initial": 0.5,                // the value at t0; everything is measured
                                 // against it, since the true value is
                                 // whatever the initial condition had
  "drift": {                     // measured on the dense output — the curve
                                 // the monitor draws
    "maxAbsDeviation": 2.0e-4,
    "relativeDrift": 4.0e-4,     // the same, over |initial|
    "netDrift": -1.5e-4,         // signed, end to end
    "secularRatio": 1.0000       // band over the last tenth of the run,
                                 // divided by the band over the first tenth
  },
  "atSteps": { ... },            // the same four, at the integrator's own
                                 // step points
  "error": null                  // else a human-readable string, ok: false
}
```

`secularRatio` is the number the whole feature turns on. **Around 1 means
bounded** — the energy wobbles in a band no wider at the end of the run than at
the start, which is what a symplectic method buys. **Much greater than 1 means
secular drift.** On a harmonic oscillator over 200 time units: Verlet and
Yoshida4 report ≈ 1.0, Tsit5 reports ≈ 11.

The series crosses separately, as a `Float64Array` of `[t, value]` pairs:

```js
const c = JSON.parse(model.conservation("E", 0));
const series = model.conservation_series();   // length 2 * c.samples
```

### `samples` is a floor, not a quota

Ask for 300 and you may get 5001. This is deliberate and it is the one place the
API overrides the caller.

A pixel count is a fact about a screen; aliasing is a fact about the system. A
symplectic method's energy error does not grow, but it *oscillates* at twice the
system's frequency — sample that too sparsely and the samples creep through its
phase over the run, and a bounded wobble is reported as a band that widens.
`numpla-ode` measured a **nineteenfold phantom growth at two samples per
period**, on a run whose energy was flat to four figures. A monitor that turned a
conserved quantity into a drifting one would teach precisely the wrong lesson.

So the floor is one sample per accepted step (clamped to 256…20000): whatever
resolution the integrator needed to resolve the dynamics is a resolution that
cannot alias them. Pass `0` to leave the choice entirely to the model, or pass
your pixel width and read `samples` back to find out what you got.

### Why `drift` and `atSteps` are both reported

A quantity a method conserves *exactly* is exact **at step points**, and only
nearly exact on the interpolant between them. `drift` describes the curve the
user is looking at; `atSteps` describes what the integrator actually did. When
they disagree the difference is the cubic Hermite between step points, not the
method losing the invariant — reporting only `drift` would slander the
integrator, and reporting only `atSteps` would describe a curve nobody can see.
For a well-resolved run they agree to several figures.

### Errors

`ok: false` with a sentence, never an exception:

| situation | `error` |
|---|---|
| nothing solved yet | "nothing has been integrated yet" |
| no row by that name | "there is no row called `Q` — write one, such as ..." |
| the row cannot be evaluated | "`E` cannot be measured: ..." |

A partial run is measurable like any other: the series spans `[t0, tEnd]`, so
watching the energy of something on its way to blowing up is exactly the useful
thing it looks like. Nothing here needs to know that the run stopped early.

`conservation_series()` is empty whenever the last call failed, and any
`set_source` or `solve` drops it — a drift curve outliving the trajectory it was
measured on is the same bug as a stale sample.

## Notes for the shell

- Call `set_source` on every edit (it is cheap); call `solve` after it reports
  no `"error"` issues. Pending issues are not a reason to hold off — many of
  them (every missing initial condition) solve perfectly well. `solve` says so
  itself when it cannot run.
- An issue carrying a `fix` is an offer, not a complaint. Render the message as
  a plain sentence with the `label` as a button; appending `insert` and
  recompiling is the whole interaction.
- `dt_max` is set internally from `t1 - t0` so a narrow feature cannot be
  stepped over — see `docs/solvers.md`.
- Label the horizontal axis from `Diagnostics.independent`, never from a
  hard-coded `t`. `SolveReport`'s `t0`/`t1`/`tEnd` keep their names — they are
  the solver's parameter whatever the document calls it — but a document
  written `df/dx = 2x` is drawing `f` against `x`, and an axis captioned `t`
  would be describing a different picture.
- `sample` is for drawing the whole curve; `eval` is for the scrubber playhead.
  Both span `[t0, tEnd]`. Read `tEnd` from the report rather than assuming `t1`,
  or a run that stopped early will be drawn as if it covered the window.
- A `stopped` run is not a failed one. Draw its curve, caption it with
  `stopped.message` in the muted style, and leave the rest of the window empty
  so the shortfall is visible.
- Build the mode slider from `Model.methods()` rather than from a hard-coded
  list, so a method added to `numpla-ode` reaches the UI without a second edit.
- Dragging the slider is `solve_with` again over the same window, then a
  re-`sample`. Nothing else changes: the state vector, its column order and the
  dense output are identical whichever method ran.
- Label the plot from `SolveReport.method` and never from what was requested;
  they differ exactly when something went wrong, which is when it matters.
- The `field` view is `vector_field` over the visible window, recomputed on pan
  and zoom, drawn **under** the trajectories: the curves are the answer and the
  field is the question. Normalise the arrow lengths and show magnitude by
  shade — a field whose corners differ by three orders of magnitude is
  unreadable if arrows scale with speed.
- Seeds are `trajectory_from` once each, over the same window and method as the
  document's own run, on top of a single `solve`. Re-run only the seed that
  moved; nothing else in the frame is affected by it.
- Offer the conservation monitor's menu from `Diagnostics.derived`. An empty
  list means the document has not named a quantity to watch yet — the useful
  prompt is a row, e.g. `E = 0.5(x'^2 + x^2)`, not a dialog.

## The compute pane — `simplify`, `diff`, `expand`, `eval`

Numpla's second half: type an expression, get it simplified, differentiated or
multiplied out. Four calls, added after v1 and self-contained — nothing above
this section changes.

```rust
#[wasm_bindgen]
impl Model {
    /// Fold arithmetic, apply the identity and zero laws, collect like
    /// terms, order commutative operands canonically.
    pub fn cas_simplify(&self, expr: &str) -> String;

    /// Differentiate with respect to `var`.
    pub fn cas_diff(&self, expr: &str, var: &str) -> String;

    /// Multiply out products over sums.
    pub fn cas_expand(&self, expr: &str) -> String;

    /// Numeric where the document supplies enough values; the simplified
    /// expression, plus a step saying which name is missing, where it does not.
    pub fn cas_eval(&self, expr: &str) -> String;
}
```

All four take `&self`. Algebra never disturbs the document, the stored solution
or the conservation series — that is in the signature so the compiler keeps it,
and it means the pane can be driven on every keystroke beside a running plot.

### The reply

```jsonc
{
  "ok": true,
  "input": "sin(x^2)",          // echoed back, so a late answer can be matched
  "output": "2x * cos(x^2)",    // Numpla source
  "steps": [                    // optional: present when there is working
    { "rule": "differentiate by x", "expr": "cos(x^2) * (2x^(2 - 1) * 1)" },
    { "rule": "simplify",           "expr": "2x * cos(x^2)" }
  ],
  "error": null,                // omitted when ok
  "pending": false              // omitted unless true
}
```

**`output` is Numpla source and it parses.** So is every `steps[i].expr`. This
is a guarantee, not an aspiration: the whole corpus is round-tripped through the
parser in `numpla-cas`'s property test, because an answer you cannot paste back
into your document is not an answer. Offer "paste into document" on any reply
with `ok: true`.

`steps` is present only when there is working worth showing, and every entry is
an expression the code actually computed on the way to the answer — never a
reconstructed narration. `cas_simplify` therefore usually has no steps: it
rewrites the whole tree at once rather than applying named laws in sequence.

`pending: true` is the gray-not-red rule at this boundary. A half-typed
expression is not wrong, it is unfinished; render it muted and do not report it
as an error. `ok: false` with `pending` absent is a real refusal and carries a
sentence in `error`.

| Reply | Means |
|---|---|
| `ok: true` | An answer. `output` is source. |
| `ok: false`, `pending: true` | Still typing. Mute the pane; say nothing. |
| `ok: false` | A considered refusal. Show `error` as a sentence. |

### The document is in scope

The pane parses with the document's function names, exactly as `set_source`
does, and inlines those calls before the algebra starts. With `f(u) = u^2` in a
row above, `cas_diff("f(x)", "x")` is `2x`. Without it, `f(x)` is `f` times `x`
— the same rule as everywhere else (see "Calls and coefficients").

Parameters are the other half of that, and they behave differently on purpose:

| Call | `k = 3` in the document, expression `k*x + k*x` |
|---|---|
| `cas_simplify` | `2k * x` — you are manipulating the expression you typed |
| `cas_eval` | `6x` — every value the document has is put in; `x` has none, so a step says so |

`cas_eval` is the only one that reads parameter *values*. Folding today's slider
position into an expression somebody is rearranging would quietly destroy the
thing they were working on.

An expression that still reads a name with no value — a state variable, say,
which only has values along a solution — is **not** an error. It comes back
`ok: true` with the simplified expression and one step naming what is missing:

```jsonc
{ "ok": true, "input": "x + x", "output": "2x",
  "steps": [ { "rule": "x has no value in this document, so this stays symbolic",
               "expr": "2x" } ] }
```

### Worked examples

| Call | `output` |
|---|---|
| `cas_simplify("2x + 3x")` | `5x` |
| `cas_simplify("x/3 + x/3")` | `2x/3` |
| `cas_diff("x^3", "x")` | `3x^2` |
| `cas_diff("x^x", "x")` | `x^x * (ln(x) + 1)` |
| `cas_expand("(x + 1)^3")` | `x^3 + 3x^2 + 3x + 1` |
| `cas_eval("2 + 3*4")` | `14` |

### What it will not do, and says so

The refusals are answers. Each comes back `ok: false` with a sentence, never
with a plausible expression:

- **`x'`, `x''`.** A primed name already means "derivative with respect to the
  document's independent variable"; differentiating it again would be guessing
  what it is a derivative *of*.
- **A noise source.** `smooth(t)` is a lattice sample and `white(t)` is not even
  continuous. There is nothing to differentiate.
- **`mod(u, v)` with a moving modulus**, and any name the document has not
  defined as a function.
- **A row.** `x' = -y` has an `=` in it, so it belongs in the document where it
  can be solved. The pane says so rather than computing with one side of it.

And four whole capabilities are out of scope rather than half-implemented, so
there is no call to make: **symbolic integration, equation solving, limits and
series, and symbolic matrices**. The reasons are in `numpla-cas`'s crate docs.

### Why you can trust the answer

Every rewrite preserves value. A simplifier that is merely plausible is worse
than none, because you cannot tell when it lied — so `numpla-cas` is built
around a property test rather than a rule list: a corpus of over a hundred
expressions is evaluated before and after every rewrite at many pseudo-random
points, and any disagreement fails the build. Symbolic derivatives are checked
against a Richardson-extrapolated central difference over the same corpus.

Two rewrites *do* differ from the input at isolated points, and every CAS makes
them: `0 * u` becomes `0`, and `u/u` cancels to `1`. Both differ only where the
input itself is not a finite number.

### Notes for the shell

- Drive it per keystroke if you like; all four calls are cheap and none of them
  touches the solution.
- Match `input` against what you sent before rendering — replies from a fast
  typist can arrive out of order.
- `pending` means muted, never red. It is the same rule the row list follows.
- Show `steps` folded away by default. The unsimplified derivative is what
  somebody checking their own working wants, and it is noise for everyone else.
