//! wasm-bindgen boundary. Thin by policy: no logic lives here.
//!
//! Every method below hands straight to `numpla-model`. Two rules from
//! `docs/wasm-api.md` are visible in the signatures and are the reason the
//! boundary looks like this:
//!
//! - **Nothing throws across it.** Every call returns a value; problems come
//!   back as diagnostics data, because half-typed input is a normal state and
//!   an exception per keystroke is not. A model that blows up is the same kind
//!   of normal state: `solve` answers with the curve up to the blowup and a
//!   sentence, not with nothing.
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

    /// Integrate over `[t0, t1]` with the default method. Returns SolveReport
    /// as a JSON string. Safe to call when the document is invalid — reports
    /// `ok: false`.
    ///
    /// A run that gives up part-way is **not** that case: it reports
    /// `ok: true` with `tEnd` short of `t1` and a `stopped` object saying why.
    /// Draw the curve and show the sentence; see `docs/wasm-api.md`.
    pub fn solve(&mut self, t0: f64, t1: f64) -> String {
        self.inner.solve_json(t0, t1)
    }

    /// Integrate with a named method — `"Tsit5"`, `"Verlet"`, `"Yoshida4"`,
    /// case-insensitive. This is what the mode slider calls.
    ///
    /// A string rather than an enum because `wasm_bindgen` enums cross as
    /// integers, and an integer is exactly the kind of thing that ends up one
    /// off between a shell and a rebuilt module. The name is echoed back in the
    /// report, so a mistyped one reports itself instead of silently selecting
    /// a neighbour.
    pub fn solve_with(&mut self, t0: f64, t1: f64, method: &str) -> String {
        self.inner.solve_named_json(t0, t1, method)
    }

    /// The available methods as JSON, in slider order — so the shell builds the
    /// slider from the implementation rather than from a copy of it.
    pub fn methods() -> String {
        numpla_model::Model::methods_json()
    }

    /// Uniformly sample the last solution: `n` points, flattened row-major as
    /// `[t, y_0, .., y_{d-1}]` repeated `n` times. Length = `n * (dim + 1)`.
    /// Empty if there is no solution.
    ///
    /// Spans `[t0, tEnd]`, which is what was integrated — after a run that
    /// stopped early the curve ends where the run did.
    pub fn sample(&self, n: usize) -> Vec<f64> {
        self.inner.sample(n)
    }

    /// State at one time, length = `dim`. Clamped to the integrated span.
    /// Empty if there is no solution.
    pub fn eval(&self, t: f64) -> Vec<f64> {
        self.inner.eval(t)
    }

    /// The right-hand side sampled on a grid across `[x0, x1] x [y0, y1]` at
    /// time `t`, flattened as `[x, y, dx, dy]` per sample, `x` varying fastest.
    ///
    /// Empty when the document does not have exactly two states, does not
    /// compile, or the grid is empty. Never throws — the `field` view simply
    /// draws nothing, which is the same answer `phase` gives to a document with
    /// the wrong number of axes.
    ///
    /// `t` is an argument because a non-autonomous system has a different field
    /// at every instant; the shell passes the left edge of its window and says
    /// so on screen.
    #[allow(clippy::too_many_arguments)]
    pub fn vector_field(
        &self,
        x0: f64,
        x1: f64,
        y0: f64,
        y1: f64,
        nx: usize,
        ny: usize,
        t: f64,
    ) -> Vec<f64> {
        self.inner.vector_field(x0, x1, y0, y1, nx, ny, t)
    }

    /// One trajectory from an explicit starting state — a seed — sampled
    /// uniformly into the same flat layout as `sample`.
    ///
    /// Takes `&self`, which is the contract's "does not disturb the stored
    /// solution" stated where the compiler can check it: the document's own
    /// curve, its telemetry and its conservation series all survive any number
    /// of seeds.
    ///
    /// Empty rather than thrown when `y0` is the wrong length, `n` is zero, the
    /// method name is unknown, or the document cannot be integrated. Obeys the
    /// same stop-early rule as `solve`: a seed that blows up comes back short,
    /// and its last `t` is where it stopped.
    pub fn trajectory_from(
        &self,
        t0: f64,
        t1: f64,
        method: &str,
        y0: &[f64],
        n: usize,
    ) -> Vec<f64> {
        self.inner.trajectory_from_named(t0, t1, method, y0, n)
    }

    /// StepRecord list as JSON — for the telemetry strip.
    pub fn telemetry(&self) -> String {
        self.inner.telemetry_json()
    }

    /// Track a named row along the last solution. Returns ConservationReport as
    /// a JSON string; the series itself comes back from `conservation_series`.
    ///
    /// `samples` is a floor, not a quota — pass 0 to let the model choose. See
    /// `docs/wasm-api.md`: asking for a pixel count is how a bounded energy
    /// wobble gets reported as drift.
    pub fn conservation(&mut self, name: &str, samples: usize) -> String {
        self.inner.conservation_json(name, samples)
    }

    /// The series behind the last `conservation` call, flattened as `[t, value]`
    /// pairs. Length = `2 * samples`. Empty if that call failed.
    pub fn conservation_series(&self) -> Vec<f64> {
        self.inner.conservation_series()
    }

    // ---- the compute pane -------------------------------------------------
    //
    // All of them take `&self`: algebra never disturbs the document or the
    // curve on screen, and the signature is where that promise is kept.
    //
    // Most return a CasReply as a JSON string — `{ ok, input, output, steps?,
    // error?, pending? }` — and `output` is Numpla source that parses, so the
    // shell can offer "paste into document" on any answer. `cas_solve` and
    // `cas_equal` return their own shapes, because a solution set and a list of
    // alternative forms are not one expression. See `docs/wasm-api.md`.
    //
    // The document is in scope: a function defined in a row can be used in the
    // pane, and `cas_eval` reads the document's parameter values.

    /// Fold arithmetic, apply the identity and zero laws, collect like terms,
    /// and put commutative operands in a canonical order.
    pub fn cas_simplify(&self, expr: &str) -> String {
        self.inner.cas_simplify(expr)
    }

    /// Differentiate with respect to `var`.
    ///
    /// Refusals are answers too: `x'`, a noise source and a `mod` with a moving
    /// modulus come back `ok: false` with a sentence saying why, rather than
    /// with a plausible expression.
    pub fn cas_diff(&self, expr: &str, var: &str) -> String {
        self.inner.cas_diff(expr, var)
    }

    /// Multiply out products over sums.
    pub fn cas_expand(&self, expr: &str) -> String {
        self.inner.cas_expand(expr)
    }

    /// Factor over the rationals. Complete for a polynomial in one variable;
    /// a common factor in more than one; `x^2 - 2` comes back unchanged,
    /// because it does not factor over the rationals and `sqrt(2)` is `solve`'s
    /// answer rather than `factor`'s.
    pub fn cas_factor(&self, expr: &str) -> String {
        self.inner.cas_factor(expr)
    }

    /// The best exact form the CAS can reach, with the document's values put
    /// in. `sqrt(2)` stays `sqrt(2)`; an expression that still reads a name
    /// with no value comes back symbolic with a step saying which name.
    pub fn cas_eval(&self, expr: &str) -> String {
        self.inner.cas_eval(expr)
    }

    /// A number, always. When it cannot be one — a name in the expression has
    /// no value — it comes back `ok: false` with the sentence saying which.
    pub fn cas_evalf(&self, expr: &str) -> String {
        self.inner.cas_evalf(expr)
    }

    /// Substitute a name: `cas_subs("x = 3", "x^2 + 1")` is `10`.
    pub fn cas_subs(&self, assignment: &str, expr: &str) -> String {
        self.inner.cas_subs(assignment, expr)
    }

    /// Solve one equation for one unknown. Returns a **CasSolveReply** as JSON:
    /// `{ ok, input, variable, solutions: [{ expr, verified, value? }],
    /// everyValue?, method?, note?, error?, pending? }`.
    ///
    /// `var` may be `""` when the equation has exactly one unknown, which is
    /// what makes `solve(2x = 2)` answerable without naming `x`. What it will
    /// not do it refuses by name — a trigonometric equation has infinitely many
    /// solutions, and a cubic with no rational root has no readable ones.
    pub fn cas_solve(&self, equation: &str, var: &str) -> String {
        self.inner.cas_solve(equation, var)
    }

    /// Every equivalent form the CAS can find, for the user to choose from.
    /// Returns a **CasFormsReply** as JSON: `{ ok, input, forms: [{ expr,
    /// label, kind, condition?, note? }], value?, error?, pending? }`.
    ///
    /// `kind` is the field that matters: `"exact"`, `"conditional"` (with the
    /// condition it depends on), `"decimal"`, or `"identification"` — a closed
    /// form recognised from the *number*, which is evidence and not a proof.
    /// Render that difference; it is the reason the field exists.
    pub fn cas_equal(&self, expr: &str) -> String {
        self.inner.cas_equal(expr)
    }

    /// `sum(e, k, a, b)`: a closed form where one exists, the series added up
    /// where the limits are numbers, and otherwise a refusal naming the shape.
    pub fn cas_sum(&self, expr: &str, index: &str, from: &str, to: &str) -> String {
        self.inner.cas_sum(expr, index, from, to)
    }

    /// `product(e, k, a, b)`, on the same terms as `cas_sum`.
    pub fn cas_product(&self, expr: &str, index: &str, from: &str, to: &str) -> String {
        self.inner.cas_product(expr, index, from, to)
    }

    /// One worksheet line as typed — `solve(2x = 2, x)`, `equal(1^(1/2))`, or a
    /// bare expression, which means `eval`.
    ///
    /// `history` is a JSON array of previous results, most recent first, for
    /// `%`, `%%`, `%%%`; pass `"[]"` when there is none. Returns a
    /// **CasCommandReply**: `{ command, source, reply }`, where `command` says
    /// which of the three reply shapes `reply` is. Switch on it rather than
    /// sniffing fields.
    ///
    /// The line parsing lives in Rust so that the shell and the CAS cannot
    /// disagree about what `sum(e, k, a, b)` means.
    pub fn cas_command(&self, line: &str, history: &str) -> String {
        self.inner.cas_command(line, history)
    }

    /// The command names and signatures, as JSON — so tab completion is built
    /// from the implementation rather than from a copy of it.
    pub fn cas_commands() -> String {
        numpla_model::Model::cas_commands_json()
    }
}
