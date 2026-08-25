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
| `x(0) = <number>` | Initial condition for state `x`. Defaults to 0 if absent. |
| `k = <expr>` | Parameter/constant, visible to every row. |
| `f(x) = <expr>` | Function definition. |

Second-order rows are lowered automatically: `x'' = -x` introduces a hidden
state for `x'`, and `x'(0) = v` sets its initial condition. State order in all
vectors is **declaration order of the ODE rows**, with each lowered velocity
state placed immediately after its position state.

Inside an ODE right-hand side, `t` is bound to the current time.

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
    }
  ]
}
```

`severity: "pending"` means *incomplete, not wrong* — the UI must render it in
the muted style, never as an error. `"error"` means genuinely broken.

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
  no `"error"` issues.
- `dt_max` is set internally from `t1 - t0` so a narrow feature cannot be
  stepped over — see `docs/solvers.md`.
- `sample` is for drawing the whole curve; `eval` is for the scrubber playhead.
