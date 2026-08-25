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
| `x(0) = <number>` | Initial condition for state `x`. Defaults to 0 if absent, *and says so* — see "missing information". |
| `k = <expr>` | Parameter/constant, visible to every row. |
| `f(x) = <expr>` | Function definition. |

Second-order rows are lowered automatically: `x'' = -x` introduces a hidden
state for `x'`, and `x'(0) = v` sets its initial condition. State order in all
vectors is **declaration order of the ODE rows**, with each lowered velocity
state placed immediately after its position state.

Inside an ODE right-hand side, `t` is bound to the current time.

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

    /// Integrate over [t0, t1]. Returns SolveReport as a JSON string.
    /// Safe to call when the document is invalid — reports ok: false.
    pub fn solve(&mut self, t0: f64, t1: f64) -> String;

    /// Uniformly sample the last solution: n points, flattened row-major as
    /// [t, y_0, .., y_{d-1}] repeated n times. Length = n * (dim + 1).
    /// Empty if there is no solution.
    pub fn sample(&self, n: usize) -> Vec<f64>;

    /// State at one time, length = dim. Clamped to the integrated span.
    /// Empty if there is no solution.
    pub fn eval(&self, t: f64) -> Vec<f64>;

    /// StepRecord list as JSON — for the telemetry strip.
    pub fn telemetry(&self) -> String;
}
```

`Vec<f64>` returns arrive in JS as a `Float64Array`.

## JSON shapes

```jsonc
// Diagnostics — returned by set_source
{
  "states": ["x", "y"],          // state vector order, length = dim
  "params": ["k"],               // named constants in scope
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
// SolveReport — returned by solve
{
  "ok": true,
  "t0": 0.0, "t1": 20.0,
  "dim": 2,
  "states": ["x", "y"],
  "accepted": 84, "rejected": 3, "rhsEvals": 522,
  "error": null                  // else a human-readable string, ok: false
}
```

```jsonc
// telemetry
{
  "steps": [ { "t": 0.0, "dt": 0.01, "error": 0.42, "accepted": true } ]
}
```

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
- `sample` is for drawing the whole curve; `eval` is for the scrubber playhead.
