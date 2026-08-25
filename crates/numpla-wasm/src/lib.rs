//! wasm-bindgen boundary. Thin by policy: no logic lives here.
//!
//! Every method below hands straight to `numpla-model`. Two rules from
//! `docs/wasm-api.md` are visible in the signatures and are the reason the
//! boundary looks like this:
//!
//! - **Nothing throws across it.** Every call returns a value; problems come
//!   back as diagnostics data, because half-typed input is a normal state and
//!   an exception per keystroke is not.
//! - **JSON for structure, `Float64Array` for bulk numbers.** Trajectory
//!   samples cross as flat `f64` arrays with no per-point allocation.

use wasm_bindgen::prelude::*;

/// A document and its most recent solution.
#[wasm_bindgen]
pub struct Model {
    inner: numpla_model::Model,
}

impl Default for Model {
    fn default() -> Self {
        Model::new()
    }
}

#[wasm_bindgen]
impl Model {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Model {
        Model {
            inner: numpla_model::Model::new(),
        }
    }

    /// Replace the whole document. Returns Diagnostics as a JSON string.
    /// Never throws: unparseable rows come back as diagnostics.
    pub fn set_source(&mut self, src: &str) -> String {
        self.inner.set_source_json(src)
    }

    /// Integrate over `[t0, t1]`. Returns SolveReport as a JSON string.
    /// Safe to call when the document is invalid — reports `ok: false`.
    pub fn solve(&mut self, t0: f64, t1: f64) -> String {
        self.inner.solve_json(t0, t1)
    }

    /// Uniformly sample the last solution: `n` points, flattened row-major as
    /// `[t, y_0, .., y_{d-1}]` repeated `n` times. Length = `n * (dim + 1)`.
    /// Empty if there is no solution.
    pub fn sample(&self, n: usize) -> Vec<f64> {
        self.inner.sample(n)
    }

    /// State at one time, length = `dim`. Clamped to the integrated span.
    /// Empty if there is no solution.
    pub fn eval(&self, t: f64) -> Vec<f64> {
        self.inner.eval(t)
    }

    /// StepRecord list as JSON — for the telemetry strip.
    pub fn telemetry(&self) -> String {
        self.inner.telemetry_json()
    }
}
