//! The bridge from a text document to an integrated solution.
//!
//! Everything the browser shell can ask for lives on [`Model`]; `numpla-wasm`
//! only marshals. The rules that shape this crate come from the product, not
//! from the mathematics:
//!
//! 1. **Nothing fails outward.** Every entry point returns a value. A document
//!    that is half-typed, empty, or broken produces diagnostics, never a panic
//!    and never an exception across the boundary.
//! 2. **Pending is not an error.** A row waiting on something not yet typed is
//!    reported as [`Severity::Pending`](report::Severity::Pending) and rendered
//!    muted; only genuinely broken rows go red.
//! 3. **A solution is a function of `t`.** Sampling and scrubbing both read the
//!    dense output rather than a stored point list.

pub mod document;
pub mod report;
pub mod system;

pub use document::{Document, StateRhs};
pub use report::{Diagnostics, Issue, Severity, SolveReport, StepJson, TelemetryJson};
pub use system::ModelSystem;

use numpla_ode::{solve, Opts, SolveError, Solution};

/// How many steps the solver is forced to take, at minimum, across the
/// requested span.
///
/// `dt_max` must not be infinite. An adaptive controller starting on a flat
/// stretch grows the step geometrically and can leap clean over a narrow
/// feature — the error estimate never sees a bump the method never lands on,
/// and the result is a silently wrong plot, which is far worse than a slow one.
/// See the `dt_max` section of `docs/solvers.md`. Tying the cap to the width of
/// the requested window means the guarantee scales with what is being drawn.
const MIN_STEPS_ACROSS_SPAN: f64 = 100.0;

/// A document plus its most recent solution.
#[derive(Debug, Clone, Default)]
pub struct Model {
    doc: Document,
    solution: Option<Solution>,
}

impl Model {
    pub fn new() -> Self {
        Model::default()
    }

    /// Replace the whole document.
    ///
    /// Cheap enough to run on every keystroke, which is how the shell uses it.
    /// Any previous solution is dropped: the state vector may have changed
    /// shape, and stale samples drawn against a new model would be a lie.
    pub fn set_source(&mut self, src: &str) -> Diagnostics {
        self.doc = document::compile(src);
        self.solution = None;
        self.doc.diagnostics()
    }

    pub fn set_source_json(&mut self, src: &str) -> String {
        to_json(&self.set_source(src))
    }

    /// Integrate over `[t0, t1]`. Safe to call on a document that cannot be
    /// integrated — that comes back as `ok: false` with a sentence saying why.
    pub fn solve(&mut self, t0: f64, t1: f64) -> SolveReport {
        self.solution = None;
        let states = self.doc.states.clone();
        let dim = self.doc.dim();
        let fail = |error: String| SolveReport {
            ok: false,
            t0,
            t1,
            dim,
            states: states.clone(),
            accepted: 0,
            rejected: 0,
            rhs_evals: 0,
            error: Some(error),
        };

        if let Some(message) = self.doc.first_error() {
            return fail(message);
        }
        if dim == 0 {
            return fail("there are no ODE rows to integrate".to_string());
        }
        // Reported, but as a statement of fact rather than a complaint: the
        // shell is expected to hold off on solving while rows are still pending.
        if self.doc.is_pending() {
            return fail("the model is still incomplete".to_string());
        }

        let sys = ModelSystem::new(&self.doc);
        let opts = Opts {
            dt_max: step_cap(t0, t1),
            ..Default::default()
        };

        match solve(&sys, (t0, t1), &self.doc.y0, &opts) {
            Ok(solution) => {
                // A right-hand side cannot fail outward, so a failure recorded
                // during the run outranks an integration that merely finished.
                if let Some(message) = sys.failure() {
                    return fail(message);
                }
                let telemetry = solution.telemetry.clone();
                self.solution = Some(solution);
                SolveReport {
                    ok: true,
                    t0,
                    t1,
                    dim,
                    states,
                    accepted: telemetry.accepted,
                    rejected: telemetry.rejected,
                    rhs_evals: telemetry.rhs_evals,
                    error: None,
                }
            }
            Err(e) => fail(sys.failure().unwrap_or_else(|| describe_solve_error(&e))),
        }
    }

    pub fn solve_json(&mut self, t0: f64, t1: f64) -> String {
        to_json(&self.solve(t0, t1))
    }

    /// Uniformly sample the last solution: `n` points, flattened row-major as
    /// `[t, y_0, .., y_{d-1}]`. Empty when there is nothing solved.
    ///
    /// Flat and preallocated because this crosses into JS as one
    /// `Float64Array`; a point-per-allocation shape would dominate the cost of
    /// drawing a curve.
    pub fn sample(&self, n: usize) -> Vec<f64> {
        let Some(sol) = &self.solution else {
            return Vec::new();
        };
        if n == 0 {
            return Vec::new();
        }
        let dim = sol.dim();
        let (a, b) = (sol.t_start(), sol.t_end);
        let mut out = Vec::with_capacity(n * (dim + 1));
        let mut buf = vec![0.0; dim];
        for i in 0..n {
            let t = if n == 1 {
                a
            } else {
                a + (b - a) * (i as f64) / ((n - 1) as f64)
            };
            sol.eval_into(t, &mut buf);
            out.push(t);
            out.extend_from_slice(&buf);
        }
        out
    }

    /// State at one time — the scrubber playhead. Clamped to the integrated
    /// span rather than extrapolated.
    pub fn eval(&self, t: f64) -> Vec<f64> {
        match &self.solution {
            Some(sol) => sol.eval(t),
            None => Vec::new(),
        }
    }

    pub fn telemetry(&self) -> TelemetryJson {
        let steps = match &self.solution {
            Some(sol) => sol
                .telemetry
                .steps
                .iter()
                .map(|s| StepJson {
                    t: s.t,
                    dt: s.dt,
                    error: s.error,
                    accepted: s.accepted,
                })
                .collect(),
            None => Vec::new(),
        };
        TelemetryJson { steps }
    }

    pub fn telemetry_json(&self) -> String {
        to_json(&self.telemetry())
    }

    /// The compiled document, for callers that want the typed form rather than
    /// the wire form.
    pub fn document(&self) -> &Document {
        &self.doc
    }
}

fn step_cap(t0: f64, t1: f64) -> f64 {
    let span = (t1 - t0).abs();
    if span > 0.0 {
        span / MIN_STEPS_ACROSS_SPAN
    } else {
        f64::INFINITY
    }
}

/// Solver failures, phrased as what happened to the model rather than as what
/// happened to the integrator. Stiffness is the usual cause and saying so is
/// more use than reporting a step size.
fn describe_solve_error(e: &SolveError) -> String {
    match e {
        SolveError::StepTooSmall { t, .. } => format!(
            "the step size collapsed near t = {} — the system is probably stiff there",
            t
        ),
        SolveError::TooManySteps { t } => {
            format!("gave up after too many steps near t = {}", t)
        }
        SolveError::NonFinite { t } => {
            format!("the solution stopped being finite near t = {} — it blew up", t)
        }
        SolveError::DimensionMismatch { expected, got } => format!(
            "internal error: the system has {} states but {} initial values",
            expected, got
        ),
    }
}

/// Serialisation cannot fail for these shapes — every field is a number, a
/// string, a bool or a list of the same — so a failure here is a bug, not a
/// condition the shell should have to handle.
fn to_json<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solved(src: &str, t0: f64, t1: f64) -> Model {
        let mut m = Model::new();
        let d = m.set_source(src);
        assert!(
            !d.issues.iter().any(|i| i.severity == Severity::Error),
            "unexpected errors: {:?}",
            d.issues
        );
        let r = m.solve(t0, t1);
        assert!(r.ok, "solve failed: {:?}", r.error);
        m
    }

    fn issues_on(src: &str) -> Vec<Issue> {
        Model::new().set_source(src).issues
    }

    // --- the model itself -------------------------------------------------

    #[test]
    fn harmonic_oscillator_comes_back_where_it_started() {
        // x' = -y, y' = x traces the unit circle; after one turn it is home.
        let src = "x' = -y\ny' = x\nx(0) = 1\ny(0) = 0";
        let m = solved(src, 0.0, std::f64::consts::TAU);
        let end = m.eval(std::f64::consts::TAU);
        assert!((end[0] - 1.0).abs() < 1e-6, "{:?}", end);
        assert!(end[1].abs() < 1e-6, "{:?}", end);
        // and it is a circle the whole way round, not just at the ends
        for i in 0..=20 {
            let t = std::f64::consts::TAU * (i as f64) / 20.0;
            let y = m.eval(t);
            assert!((y[0] - t.cos()).abs() < 1e-6, "at t={}: {:?}", t, y);
            assert!((y[1] - t.sin()).abs() < 1e-6, "at t={}: {:?}", t, y);
        }
    }

    #[test]
    fn second_order_row_is_lowered_and_matches_cosine() {
        let mut m = Model::new();
        let d = m.set_source("x'' = -x\nx(0) = 1");
        // The hidden velocity sits immediately after its position.
        assert_eq!(d.states, vec!["x".to_string(), "x'".to_string()]);
        let r = m.solve(0.0, 10.0);
        assert!(r.ok, "{:?}", r.error);
        assert_eq!(r.dim, 2);
        for i in 0..=50 {
            let t = 10.0 * (i as f64) / 50.0;
            let y = m.eval(t);
            assert!((y[0] - t.cos()).abs() < 1e-6, "at t={}: {:?}", t, y);
            assert!((y[1] + t.sin()).abs() < 1e-6, "at t={}: {:?}", t, y);
        }
    }

    #[test]
    fn a_second_order_row_can_read_its_own_velocity() {
        // The damped oscillator is the reason a lowered velocity has to be
        // bound under the key `x'` resolves to.
        let src = "x'' = -x - 0.4x'\nx(0) = 1";
        let m = solved(src, 0.0, 12.0);
        let exact = |t: f64| {
            let (zeta, w0) = (0.2f64, 1.0f64);
            let wd = w0 * (1.0 - zeta * zeta).sqrt();
            (-zeta * w0 * t).exp() * (wd * t).cos()
                + (zeta * w0 / wd) * (-zeta * w0 * t).exp() * (wd * t).sin()
        };
        for i in 0..=60 {
            let t = 12.0 * (i as f64) / 60.0;
            let got = m.eval(t)[0];
            assert!((got - exact(t)).abs() < 1e-5, "at t={}: {} vs {}", t, got, exact(t));
        }
        // Damped: the amplitude at the end is a fraction of the start.
        assert!(m.eval(12.0)[0].abs() < 0.2);
    }

    #[test]
    fn declaration_order_decides_the_state_vector() {
        let d = Model::new().set_source("y'' = -y\nx' = 1");
        assert_eq!(
            d.states,
            vec!["y".to_string(), "y'".to_string(), "x".to_string()]
        );
    }

    #[test]
    fn initial_conditions_default_to_zero_and_can_be_expressions() {
        let mut m = Model::new();
        m.set_source("a = 2\nx' = 0\ny' = 0\nx(0) = 3a");
        m.solve(0.0, 1.0);
        assert_eq!(m.eval(1.0), vec![6.0, 0.0]);
    }

    #[test]
    fn a_velocity_initial_condition_reaches_the_lowered_state() {
        // x'' = 0 with x'(0) = 2 is a straight line of slope 2.
        let src = "x'' = 0\nx(0) = 1\nx'(0) = 2";
        let m = solved(src, 0.0, 3.0);
        let y = m.eval(3.0);
        assert!((y[0] - 7.0).abs() < 1e-9, "{:?}", y);
        assert!((y[1] - 2.0).abs() < 1e-9, "{:?}", y);
    }

    #[test]
    fn parameters_are_in_scope_everywhere_and_in_any_order() {
        // k is used above where it is defined, and defined in terms of another
        // constant: rows are a set, not a sequence.
        let src = "x' = -k x\nk = 2 h\nh = 1.5\nx(0) = 1";
        let mut m = Model::new();
        let d = m.set_source(src);
        assert_eq!(d.params, vec!["k".to_string(), "h".to_string()]);
        let r = m.solve(0.0, 2.0);
        assert!(r.ok, "{:?}", r.error);
        let want = (-3.0f64 * 2.0).exp();
        assert!((m.eval(2.0)[0] - want).abs() < 1e-7);
    }

    #[test]
    fn user_functions_can_drive_a_row() {
        let src = "f(u) = -2u\nx' = f(x)\nx(0) = 1";
        let m = solved(src, 0.0, 1.0);
        assert!((m.eval(1.0)[0] - (-2.0f64).exp()).abs() < 1e-7);
    }

    #[test]
    fn t_is_bound_inside_a_right_hand_side() {
        // x' = t integrates to t^2/2.
        let m = solved("x' = t", 0.0, 4.0);
        assert!((m.eval(4.0)[0] - 8.0).abs() < 1e-7, "{:?}", m.eval(4.0));
    }

    #[test]
    fn comments_and_blank_lines_are_ignored_without_shifting_line_numbers() {
        let src = "# a harmonic oscillator\n\nx' = -y\ny' = x   # trailing comment\n\nx(0) = 1";
        let mut m = Model::new();
        let d = m.set_source(src);
        assert_eq!(d.states, vec!["x".to_string(), "y".to_string()]);
        assert!(d.issues.is_empty(), "{:?}", d.issues);
        let r = m.solve(0.0, 1.0);
        assert!(r.ok, "{:?}", r.error);
    }

    // --- gray, not red ----------------------------------------------------

    #[test]
    fn an_undefined_name_is_an_error() {
        let issues = issues_on("x' = q\nx(0) = 1");
        assert_eq!(issues.len(), 1, "{:?}", issues);
        assert_eq!(issues[0].severity, Severity::Error);
        assert_eq!(issues[0].line, 0);
        assert!(issues[0].message.contains('q'), "{:?}", issues[0]);
    }

    #[test]
    fn half_typed_input_is_pending_not_an_error() {
        for src in ["x' = -", "x' = 2 *", "k = \nx' = k"] {
            let issues = issues_on(src);
            assert!(!issues.is_empty(), "{}: expected an issue", src);
            assert!(
                issues.iter().all(|i| i.severity == Severity::Pending),
                "{}: {:?}",
                src,
                issues
            );
        }
    }

    #[test]
    fn a_row_waiting_on_a_half_typed_definition_is_also_pending() {
        let issues = issues_on("k =\nx' = k x\nx(0) = 1");
        assert!(!issues.is_empty());
        assert!(
            issues.iter().all(|i| i.severity == Severity::Pending),
            "{:?}",
            issues
        );
        // The incomplete row and the row waiting on it are both reported.
        assert!(issues.iter().any(|i| i.line == 0));
        assert!(issues.iter().any(|i| i.line == 1));
    }

    #[test]
    fn an_initial_condition_for_a_state_not_yet_typed_is_pending() {
        let issues = issues_on("x(0) = 1");
        assert_eq!(issues.len(), 1, "{:?}", issues);
        assert_eq!(issues[0].severity, Severity::Pending);
    }

    #[test]
    fn a_duplicate_ode_row_is_an_error() {
        let issues = issues_on("x' = 1\nx' = 2");
        assert_eq!(issues.len(), 1, "{:?}", issues);
        assert_eq!(issues[0].severity, Severity::Error);
        assert_eq!(issues[0].line, 1);
    }

    #[test]
    fn issues_carry_the_line_and_the_span_within_it() {
        let issues = issues_on("x' = -y\ny' = sin(x");
        assert_eq!(issues.len(), 1, "{:?}", issues);
        let i = &issues[0];
        assert_eq!(i.line, 1);
        assert_eq!(i.severity, Severity::Error);
        assert_eq!(i.message, "missing )");
        assert_eq!((i.start, i.end), (10, 10));
    }

    #[test]
    fn an_empty_document_is_quiet() {
        let d = Model::new().set_source("\n\n# nothing here\n");
        assert!(d.issues.is_empty());
        assert!(d.states.is_empty());
        assert!(d.params.is_empty());
    }

    #[test]
    fn a_bare_expression_row_is_not_the_models_business() {
        // It is a plot row. The model ignores it rather than complaining.
        let d = Model::new().set_source("x' = -x\nx(0) = 1\n2 + 2");
        assert!(d.issues.is_empty(), "{:?}", d.issues);
    }

    // --- solving ----------------------------------------------------------

    #[test]
    fn solving_a_broken_document_reports_rather_than_failing() {
        let mut m = Model::new();
        m.set_source("x' = q");
        let r = m.solve(0.0, 1.0);
        assert!(!r.ok);
        assert!(r.error.unwrap().contains('q'));
        assert!(m.sample(10).is_empty());
        assert!(m.eval(0.5).is_empty());
    }

    #[test]
    fn solving_an_incomplete_document_is_not_reported_as_broken() {
        let mut m = Model::new();
        m.set_source("x' = -");
        let r = m.solve(0.0, 1.0);
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("incomplete"));
    }

    #[test]
    fn solving_an_empty_document_says_so() {
        let r = Model::new().solve(0.0, 1.0);
        assert!(!r.ok);
        assert_eq!(r.dim, 0);
        assert!(r.error.unwrap().contains("no ODE rows"));
    }

    #[test]
    fn a_blow_up_is_reported_not_returned_as_numbers() {
        // x' = x^2 escapes to infinity at t = 1.
        let mut m = Model::new();
        m.set_source("x' = x^2\nx(0) = 1");
        let r = m.solve(0.0, 2.0);
        assert!(!r.ok);
        assert!(r.error.is_some());
    }

    #[test]
    fn a_narrow_feature_is_not_stepped_over() {
        // A Gaussian pulse of width ~0.3 in a window of 10. With dt_max left at
        // infinity the controller leaps straight over it; the cap is what makes
        // the integral come out right. See docs/solvers.md.
        let src = "x' = exp(-50(t-5)^2)";
        let m = solved(src, 0.0, 10.0);
        let want = (std::f64::consts::PI / 50.0).sqrt();
        assert!((m.eval(10.0)[0] - want).abs() < 1e-6, "{:?}", m.eval(10.0));
    }

    #[test]
    fn a_new_document_invalidates_the_previous_solution() {
        let mut m = Model::new();
        m.set_source("x' = 1");
        assert!(m.solve(0.0, 1.0).ok);
        assert!(!m.sample(4).is_empty());
        m.set_source("x' = 1\ny' = 1");
        assert!(m.sample(4).is_empty(), "stale samples survived an edit");
    }

    // --- the wire shapes --------------------------------------------------

    #[test]
    fn samples_are_flat_and_time_stamped() {
        let m = solved("x' = -y\ny' = x\nx(0) = 1", 0.0, 1.0);
        let n = 5;
        let s = m.sample(n);
        assert_eq!(s.len(), n * 3);
        assert_eq!(s[0], 0.0);
        assert!((s[(n - 1) * 3] - 1.0).abs() < 1e-12);
        // Each row is [t, x, y] and agrees with a point query.
        for i in 0..n {
            let t = s[i * 3];
            let y = m.eval(t);
            assert!((s[i * 3 + 1] - y[0]).abs() < 1e-12);
            assert!((s[i * 3 + 2] - y[1]).abs() < 1e-12);
        }
        assert!(m.sample(0).is_empty());
    }

    #[test]
    fn scrubbing_past_the_ends_holds() {
        let m = solved("x' = 1", 0.0, 2.0);
        assert_eq!(m.eval(-5.0)[0], 0.0);
        assert!((m.eval(99.0)[0] - 2.0).abs() < 1e-9);
    }

    #[test]
    fn diagnostics_json_matches_the_contract() {
        let json = Model::new().set_source_json("x' = -y\ny' = sin(x");
        assert!(json.contains("\"states\":[\"x\",\"y\"]"), "{}", json);
        assert!(json.contains("\"params\":[]"), "{}", json);
        assert!(json.contains("\"severity\":\"error\""), "{}", json);
        assert!(json.contains("\"line\":1"), "{}", json);
        assert!(json.contains("\"start\":10"), "{}", json);
        assert!(json.contains("\"end\":10"), "{}", json);
    }

    #[test]
    fn pending_serialises_as_the_muted_severity() {
        let json = Model::new().set_source_json("x' =");
        assert!(json.contains("\"severity\":\"pending\""), "{}", json);
    }

    #[test]
    fn solve_report_json_matches_the_contract() {
        let mut m = Model::new();
        m.set_source("x' = -y\ny' = x\nx(0) = 1");
        let json = m.solve_json(0.0, 20.0);
        assert!(json.contains("\"ok\":true"), "{}", json);
        assert!(json.contains("\"t0\":0.0"), "{}", json);
        assert!(json.contains("\"t1\":20.0"), "{}", json);
        assert!(json.contains("\"dim\":2"), "{}", json);
        assert!(json.contains("\"states\":[\"x\",\"y\"]"), "{}", json);
        assert!(json.contains("\"rhsEvals\":"), "{}", json);
        assert!(json.contains("\"error\":null"), "{}", json);
    }

    #[test]
    fn telemetry_json_accounts_for_every_attempt() {
        let mut m = Model::new();
        assert_eq!(m.telemetry_json(), "{\"steps\":[]}");
        m.set_source("x' = -y\ny' = x\nx(0) = 1");
        let report = m.solve(0.0, 20.0);
        let t = m.telemetry();
        assert_eq!(t.steps.len(), report.accepted + report.rejected);
        assert!(t.steps.iter().all(|s| s.accepted == (s.error <= 1.0)));
        let json = m.telemetry_json();
        assert!(json.starts_with("{\"steps\":[{\"t\":0.0,\"dt\":"), "{}", json);
        assert!(json.contains("\"accepted\":true"), "{}", json);
    }
}
