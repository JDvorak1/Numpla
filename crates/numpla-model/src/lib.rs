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
//! 4. **The method is the user's choice, and the report says which one ran.**
//!    No fixed-step integrator preserves the symplectic form, momentum and
//!    energy at once (Ge–Marsden, `docs/solvers.md`); which one a method gives
//!    up is the most useful thing a long run can teach, so swapping integrators
//!    is one argument and the answer never claims to be something it is not.

pub mod conserve;
pub mod document;
pub mod report;
pub mod system;

pub use document::{Derived, Document, StateRhs};
pub use report::{
    ConservationReport, Diagnostics, Drift, Fix, Issue, MethodJson, MethodsJson, Severity,
    SolveReport, StepJson, TelemetryJson,
};
pub use system::ModelSystem;

/// Re-exported so that choosing a method costs a caller nothing but this crate.
pub use numpla_ode::Method;

use numpla_ode::{solve, solve_with as solve_second_order, Opts, Paired, SolveError, Solution};

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

/// How many steps a fixed-step method takes across the requested span when
/// nobody has said otherwise.
///
/// Verlet and Yoshida4 have no error estimate to size their own step with, so
/// this number *is* their accuracy and it has to be chosen rather than
/// defaulted to something round.
///
/// It was picked against the one thing the slider must not do: change the frame
/// time. Tsit5 at its default tolerance settles near thirty accepted steps per
/// oscillation for a smooth system, at six right-hand-side evaluations each —
/// so roughly 170 evaluations per oscillation. Five thousand fixed steps across
/// the visible window costs Verlet one evaluation per step and Yoshida4 three,
/// which lands in the same range for a window with tens of oscillations in it.
/// Dragging from one method to the next then changes the *shape* of the error
/// and not the cost of getting it, which is the comparison the slider exists to
/// make.
///
/// It is tied to the span for the same reason `dt_max` is: the visible window
/// is the only scale available before the system has been integrated once. The
/// consequence is honest and worth stating — a wider window is a coarser step,
/// so a symplectic energy band *widens* as you zoom out. That is a true fact
/// about fixed-step integration rather than an artefact, and the band stays
/// flat across the run either way, which is the property being shown.
const FIXED_STEPS_ACROSS_SPAN: f64 = 5000.0;

/// A document plus its most recent solution.
#[derive(Debug, Clone, Default)]
pub struct Model {
    doc: Document,
    solution: Option<Solution>,
    /// The method that produced [`Model::solution`]. Kept so nothing downstream
    /// has to be told twice.
    method: Option<Method>,
    /// The most recent conservation measurement, so its series can cross the
    /// boundary as a `Float64Array` rather than as JSON.
    conservation: Option<(ConservationReport, Vec<f64>)>,
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
        self.forget_solution();
        self.doc.diagnostics()
    }

    pub fn set_source_json(&mut self, src: &str) -> String {
        to_json(&self.set_source(src))
    }

    /// Integrate over `[t0, t1]` with the default method. Safe to call on a
    /// document that cannot be integrated — that comes back as `ok: false` with
    /// a sentence saying why.
    pub fn solve(&mut self, t0: f64, t1: f64) -> SolveReport {
        self.solve_with(t0, t1, Method::Tsit5)
    }

    pub fn solve_json(&mut self, t0: f64, t1: f64) -> String {
        to_json(&self.solve(t0, t1))
    }

    /// Integrate over `[t0, t1]` with a chosen integrator.
    ///
    /// # Why the method is an argument and not a setting
    ///
    /// The mode slider's whole purpose is to put two answers to the same
    /// question side by side, so the call that produces an answer is the right
    /// place to say which method produced it. A setter would let the stored
    /// choice and the drawn curve disagree for as long as it took someone to
    /// call `solve` again — which is precisely the lie
    /// [`SolveReport::method`] exists to make impossible. An options object
    /// would cost a JSON parse on the hottest path in the product and could not
    /// be checked by the type system on the Rust side. One argument, one
    /// answer, and the report echoes what ran.
    ///
    /// # When the document has no second-order structure
    ///
    /// A symplectic method needs to know which states are positions and which
    /// are their velocities; a document of plain `x' = ...` rows does not say.
    /// That is reported as a failed solve rather than quietly satisfied by
    /// running Tsit5 instead. Falling back would draw a Tsit5 curve under a
    /// label reading "Verlet" — and since the two curves for a well-behaved
    /// system look identical for the first few periods, the person would learn
    /// the opposite of what the slider is there to teach. `ok: false` with a
    /// sentence naming the missing structure costs a blank plot and teaches
    /// the actual lesson: symplectic integration is a property of how the model
    /// is *written*, not a setting to be turned on.
    pub fn solve_with(&mut self, t0: f64, t1: f64, method: Method) -> SolveReport {
        self.forget_solution();
        let states = self.doc.states.clone();
        let dim = self.doc.dim();
        let name = method.name().to_string();
        let fail = |error: String| SolveReport {
            ok: false,
            t0,
            t1,
            dim,
            states: states.clone(),
            accepted: 0,
            rejected: 0,
            rhs_evals: 0,
            method: name.clone(),
            // Nothing ran, so nothing was preserved. Saying `true` here because
            // the method is nominally symplectic would be the report's one
            // chance to lie.
            symplectic: false,
            error: Some(error),
        };

        if let Some(message) = self.doc.first_error() {
            return fail(message);
        }
        if dim == 0 {
            return fail("there are no ODE rows to integrate".to_string());
        }
        // Reported, but as a statement of fact rather than a complaint: the
        // shell is expected to hold off on solving while rows are still
        // pending. Only the pending rows that actually block count — a state
        // with no initial condition is reported *and* defaulted, so a document
        // that has not said where everything starts still draws.
        if let Some(blocker) = self.doc.first_blocker() {
            return fail(format!("the model is still incomplete — {}", blocker));
        }

        let sys = ModelSystem::new(&self.doc);
        let opts = Opts {
            dt_max: step_cap(t0, t1),
            // Fixed-step methods take their step from here and have nothing
            // else to go on; the adaptive one picks its own first step.
            dt0: (!method.is_adaptive()).then(|| fixed_step(t0, t1)),
            ..Default::default()
        };

        // `reads_velocity` is answered from the document, exactly, before the
        // solver is built: a damped row costs an extra acceleration evaluation
        // per step to stay second order, and there is nothing symplectic left
        // to preserve. Guessing `true` would tax every undamped oscillator;
        // guessing `false` would silently drop a damped one to first order.
        let velocity_dependent = self.doc.reads_velocity();
        let outcome = if method.is_adaptive() {
            solve(&sys, (t0, t1), &self.doc.y0, &opts)
        } else {
            match self.doc.pairs() {
                Err(why) => {
                    return fail(format!(
                        "{} needs second-order rows — {}. Write it as `x'' = ...`, or choose {}",
                        name,
                        why,
                        Method::Tsit5.name()
                    ))
                }
                Ok(pairs) => {
                    // `Paired` re-checks the pairing against the interleaved
                    // layout the whole product speaks. It cannot fail for a
                    // pairing this crate produced — which is the point of
                    // stating it rather than letting the solver infer one.
                    let paired = match Paired::new(&sys, &pairs) {
                        Ok(p) => p,
                        Err(e) => return fail(format!("internal error: {}", e)),
                    };
                    let paired = if velocity_dependent {
                        paired.reading_velocity()
                    } else {
                        paired
                    };
                    solve_second_order(method, &paired, (t0, t1), &self.doc.y0, &opts)
                }
            }
        };

        match outcome {
            Ok(solution) => {
                // A right-hand side cannot fail outward, so a failure recorded
                // during the run outranks an integration that merely finished.
                if let Some(message) = sys.failure() {
                    return fail(message);
                }
                let telemetry = solution.telemetry.clone();
                self.solution = Some(solution);
                self.method = Some(method);
                SolveReport {
                    ok: true,
                    t0,
                    t1,
                    dim,
                    states,
                    accepted: telemetry.accepted,
                    rejected: telemetry.rejected,
                    rhs_evals: telemetry.rhs_evals,
                    method: name,
                    symplectic: method.is_symplectic() && !velocity_dependent,
                    error: None,
                }
            }
            Err(e) => fail(sys.failure().unwrap_or_else(|| describe_solve_error(&e))),
        }
    }

    pub fn solve_with_json(&mut self, t0: f64, t1: f64, method: Method) -> String {
        to_json(&self.solve_with(t0, t1, method))
    }

    /// Integrate with a method named by string — the shape the slider sends.
    ///
    /// An unknown name is a report, not a panic and not a silent default: a
    /// shell that sends "verlet5" gets told so, rather than watching Tsit5 draw
    /// under the wrong label.
    pub fn solve_named(&mut self, t0: f64, t1: f64, method: &str) -> SolveReport {
        match method_named(method) {
            Some(m) => self.solve_with(t0, t1, m),
            None => SolveReport {
                ok: false,
                t0,
                t1,
                dim: self.doc.dim(),
                states: self.doc.states.clone(),
                accepted: 0,
                rejected: 0,
                rhs_evals: 0,
                // Echoed verbatim, because the name is the thing that was wrong.
                method: method.to_string(),
                symplectic: false,
                error: Some(format!(
                    "there is no method called {} — try {}",
                    method,
                    Method::ALL
                        .iter()
                        .map(|m| m.name())
                        .collect::<Vec<_>>()
                        .join(", ")
                )),
            },
        }
    }

    pub fn solve_named_json(&mut self, t0: f64, t1: f64, method: &str) -> String {
        to_json(&self.solve_named(t0, t1, method))
    }

    /// Which method produced the current solution, if there is one.
    pub fn method(&self) -> Option<Method> {
        self.method
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

    /// Track a named row along the current solution and report its drift.
    ///
    /// This is the conservation monitor's whole input surface. The quantity is
    /// a row the person wrote — `E = 0.5(x'^2 + x^2)` — because the invariant
    /// worth watching is a property of the model, not of the software: energy,
    /// momentum, a Casimir and the Lotka–Volterra `V` are all the same shape of
    /// row, and building one of them in would have been picking a favourite.
    /// A state name or a constant is accepted too; asking whether a state is
    /// constant is the same question asked about a simpler expression.
    ///
    /// `samples` is a **floor, not a quota**. Ask for a monitor's pixel width
    /// and you may get considerably more, because a pixel count is a fact about
    /// a screen and aliasing is a fact about the system: sampling a conserved
    /// quantity a few times per oscillation reports a drift that is not there
    /// (`numpla-ode`'s `conserve` measured a nineteenfold phantom growth at two
    /// samples per period). Pass 0 to leave the choice entirely to the model.
    /// [`ConservationReport::samples`] says what was actually taken.
    pub fn conservation(&mut self, name: &str, samples: usize) -> ConservationReport {
        self.conservation = None;
        let Some(sol) = &self.solution else {
            return ConservationReport {
                ok: false,
                name: name.to_string(),
                samples: 0,
                initial: f64::NAN,
                drift: Drift::default(),
                at_steps: Drift::default(),
                error: Some("nothing has been integrated yet".to_string()),
            };
        };
        let (report, series) = conserve::measure_named(&self.doc, sol, name, samples);
        self.conservation = Some((report.clone(), series));
        report
    }

    pub fn conservation_json(&mut self, name: &str, samples: usize) -> String {
        to_json(&self.conservation(name, samples))
    }

    /// The series behind the last [`Model::conservation`] call, flattened as
    /// `[t, value]` pairs. Empty if the last measurement failed or none has
    /// been made.
    ///
    /// Separate from the report for the reason every bulk array is: it crosses
    /// into JS as one `Float64Array`, and a few thousand numbers spelled out in
    /// a JSON string would be parsed on every drag of the slider.
    pub fn conservation_series(&self) -> Vec<f64> {
        match &self.conservation {
            Some((_, series)) => series.clone(),
            None => Vec::new(),
        }
    }

    /// The methods a document can be solved with, in slider order.
    ///
    /// Answered by the model rather than hard-coded in the shell so that a
    /// method added to `numpla-ode` reaches the slider without a second edit —
    /// and so the UI's labels for "adaptive" and "symplectic" come from the
    /// implementation instead of from someone's memory of it.
    pub fn methods() -> MethodsJson {
        MethodsJson {
            methods: Method::ALL
                .iter()
                .map(|m| MethodJson {
                    name: m.name().to_string(),
                    adaptive: m.is_adaptive(),
                    symplectic: m.is_symplectic(),
                    order: m.order(),
                })
                .collect(),
        }
    }

    pub fn methods_json() -> String {
        to_json(&Model::methods())
    }

    /// The compiled document, for callers that want the typed form rather than
    /// the wire form.
    pub fn document(&self) -> &Document {
        &self.doc
    }

    /// Everything downstream of a solution, dropped together.
    ///
    /// A conservation series outliving the solution it was measured on is the
    /// same class of bug as a stale sample: a plot of numbers that no longer
    /// describe anything on screen.
    fn forget_solution(&mut self) {
        self.solution = None;
        self.method = None;
        self.conservation = None;
    }
}

/// A method by the name the wire uses. Case-insensitive, because a slider label
/// and an enum spelling are not the same kind of thing and only one of them is
/// anybody's business.
pub fn method_named(name: &str) -> Option<Method> {
    Method::ALL
        .iter()
        .copied()
        .find(|m| m.name().eq_ignore_ascii_case(name.trim()))
}

/// The step a fixed-step method takes across `[t0, t1]`.
///
/// Zero-width spans are left to the solver, which returns an empty solution at
/// `t0` before it ever looks at the step.
fn fixed_step(t0: f64, t1: f64) -> f64 {
    (t1 - t0).abs() / FIXED_STEPS_ACROSS_SPAN
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

    /// The exact damped oscillator `x'' = -x - 2 zeta x'` with `x(0) = 1`,
    /// `x'(0) = 0`, written once because two tests want it.
    fn damped(t: f64) -> f64 {
        let (zeta, w0) = (0.2f64, 1.0f64);
        let wd = w0 * (1.0 - zeta * zeta).sqrt();
        (-zeta * w0 * t).exp() * ((wd * t).cos() + (zeta * w0 / wd) * (wd * t).sin())
    }

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

    fn errors_on(src: &str) -> Vec<Issue> {
        issues_on(src)
            .into_iter()
            .filter(|i| i.severity == Severity::Error)
            .collect()
    }

    /// The value a constant row settled on.
    fn param(m: &Model, name: &str) -> f64 {
        match m.document().env.vars.get(name) {
            Some(numpla_expr::Value::Scalar(v)) => *v,
            other => panic!("{} is {:?}", name, other),
        }
    }

    /// The document with every offered row appended, which is what the issue
    /// bar's button does.
    fn with_fixes_applied(src: &str) -> String {
        let mut out = src.to_string();
        for i in issues_on(src) {
            if let Some(f) = i.fix {
                out.push('\n');
                out.push_str(&f.insert);
            }
        }
        out
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
        for i in 0..=60 {
            let t = 12.0 * (i as f64) / 60.0;
            let got = m.eval(t)[0];
            assert!(
                (got - damped(t)).abs() < 1e-5,
                "at t={}: {} vs {}",
                t,
                got,
                damped(t)
            );
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
        let src =
            "# a harmonic oscillator\n\nx' = -y\ny' = x   # trailing comment\n\nx(0) = 1\ny(0) = 0";
        let mut m = Model::new();
        let d = m.set_source(src);
        assert_eq!(d.states, vec!["x".to_string(), "y".to_string()]);
        assert!(d.issues.is_empty(), "{:?}", d.issues);
        let r = m.solve(0.0, 1.0);
        assert!(r.ok, "{:?}", r.error);
    }

    // --- gray, not red ----------------------------------------------------

    /// A name you have not defined *yet* is the ordinary state of a document
    /// being written, so it is pending and carries the definition we would
    /// have written. It still stops the solve — nothing was assumed.
    #[test]
    fn an_undefined_name_is_pending_and_comes_with_a_definition() {
        let issues = issues_on("x' = q\nx(0) = 1");
        assert_eq!(issues.len(), 1, "{:?}", issues);
        assert_eq!(issues[0].severity, Severity::Pending);
        assert_eq!(issues[0].line, 0);
        assert!(issues[0].message.contains('q'), "{:?}", issues[0]);
        assert_eq!(
            issues[0].fix,
            Some(Fix {
                label: "add q = 1".to_string(),
                insert: "q = 1".to_string(),
            })
        );
        // ...and accepting it leaves a document with nothing left to say.
        assert!(
            issues_on(&with_fixes_applied("x' = q\nx(0) = 1")).is_empty(),
            "{:?}",
            issues_on(&with_fixes_applied("x' = q\nx(0) = 1"))
        );
    }

    /// Only what the compiler can propose a row for turns gray. A wrong arity
    /// or an unusable row is a mistake, and mistakes stay red.
    #[test]
    fn a_genuine_mistake_is_still_an_error() {
        for src in ["x' = -y\ny' = sin(x", "x' = min(1)", "x^2 + y^2 = 1", "x''' = 1"] {
            let errors = errors_on(src);
            assert!(!errors.is_empty(), "{}: expected an error", src);
            assert!(
                errors.iter().all(|i| i.fix.is_none()),
                "{}: {:?}",
                src,
                errors
            );
        }
    }

    // --- missing information, and the row that would supply it -------------

    /// A state that starts at zero because nobody said otherwise is a guess
    /// presented as a fact. It gets said out loud, pointed at the row that
    /// introduced the state, and offered.
    #[test]
    fn a_state_with_no_initial_condition_says_so_and_offers_the_default() {
        let issues = issues_on("k = 2\nx' = -k x");
        assert_eq!(issues.len(), 1, "{:?}", issues);
        let i = &issues[0];
        assert_eq!(i.severity, Severity::Pending);
        assert_eq!(i.message, "x has no starting point");
        // the row that introduced the state, not the top of the document
        assert_eq!(i.line, 1);
        assert_eq!((i.start, i.end), (0, "x' = -k x".len()));
        assert_eq!(
            i.fix,
            Some(Fix {
                label: "add x(0) = 0".to_string(),
                insert: "x(0) = 0".to_string(),
            })
        );
    }

    /// A lowered velocity is as real a state as its position, and gets its own
    /// offer under its own name. Both point at the second-order row.
    #[test]
    fn a_lowered_velocity_gets_its_own_offer() {
        let issues = issues_on("x'' = -x");
        let names: Vec<&str> = issues.iter().map(|i| i.message.as_str()).collect();
        assert_eq!(
            names,
            vec!["x has no starting point", "x' has no starting point"]
        );
        assert!(issues.iter().all(|i| i.line == 0), "{:?}", issues);
        assert_eq!(
            issues[1].fix.as_ref().map(|f| f.insert.as_str()),
            Some("x'(0) = 0")
        );
    }

    /// The point of the offer: the row it proposes is a real row, and taking
    /// it up leaves nothing to report.
    #[test]
    fn every_offered_row_parses_and_settles_the_issue_it_answers() {
        for src in ["x' = -y\ny' = x", "x'' = -x", "x' = k x", "y'' = -y\nx' = 1"] {
            let fixed = with_fixes_applied(src);
            assert!(
                issues_on(&fixed).is_empty(),
                "{} -> {:?}: {:?}",
                src,
                fixed,
                issues_on(&fixed)
            );
        }
    }

    #[test]
    fn a_state_that_already_has_a_starting_point_is_not_offered_another() {
        let issues = issues_on("x' = -y\ny' = x\nx(0) = 1\ny(0) = 0");
        assert!(issues.is_empty(), "{:?}", issues);
        // even when the row that states it is itself broken: the person is
        // plainly saying where x starts, and two complaints is one too many
        let issues = issues_on("x' = -x\nx(0) = [1, 2]");
        assert_eq!(issues.len(), 1, "{:?}", issues);
        assert_eq!(issues[0].line, 1);
    }

    /// Reported, and defaulted in the same breath — so the document draws.
    /// This is information, not an obstruction.
    #[test]
    fn a_missing_initial_condition_does_not_stop_the_document_solving() {
        let mut m = Model::new();
        let d = m.set_source("x' = 1");
        assert_eq!(d.issues.len(), 1);
        assert_eq!(d.issues[0].severity, Severity::Pending);
        let r = m.solve(0.0, 2.0);
        assert!(r.ok, "{:?}", r.error);
        assert_eq!(m.eval(0.0)[0], 0.0);
        assert!((m.eval(2.0)[0] - 2.0).abs() < 1e-9);
    }

    /// A missing *definition* is the other kind of pending: nothing has been
    /// assumed on the user's behalf, so there is nothing to integrate.
    #[test]
    fn an_undefined_name_does_stop_the_solve_and_says_which_name() {
        let mut m = Model::new();
        m.set_source("x' = k x\nx(0) = 1");
        let r = m.solve(0.0, 1.0);
        assert!(!r.ok);
        let e = r.error.unwrap();
        assert!(e.contains('k'), "{}", e);
    }

    /// One name, one definition to write. Three rows waiting on `k` are three
    /// pending rows but one offer, or two clicks would write `k = 1` twice.
    #[test]
    fn the_same_proposal_is_offered_once_on_the_earliest_row() {
        let issues = issues_on("x' = k x\ny' = k y\nx(0) = 1\ny(0) = 1");
        let waiting: Vec<&Issue> = issues.iter().filter(|i| i.message.contains('k')).collect();
        assert_eq!(waiting.len(), 2, "{:?}", issues);
        assert!(waiting[0].fix.is_some());
        assert_eq!(waiting[0].line, 0);
        assert!(waiting[1].fix.is_none(), "{:?}", waiting[1]);
    }

    /// Nothing is proposed for a name the document already gives a meaning to
    /// — a constant called `f` would be a second thing under the function's
    /// name, which is worse than the red row it replaced.
    #[test]
    fn no_definition_is_proposed_for_a_name_the_document_already_uses() {
        let issues = issues_on("f(u) = 2u\nx' = f(x)\nk = f\nx(0) = 0");
        assert_eq!(issues.len(), 1, "{:?}", issues);
        assert_eq!(issues[0].line, 2);
        assert_eq!(issues[0].severity, Severity::Error);
        assert!(issues[0].fix.is_none(), "{:?}", issues[0]);
    }

    // --- implicit multiplication vs. function-call syntax -------------------

    /// The regression the two-pass compile exists for. `g (y - x)^3` at
    /// `g = 40, y - x = -1` is `-40`; reading `g(...)` as a call gave
    /// `-64000` — a plausible curve of a different system, silently.
    #[test]
    fn a_coefficient_before_a_group_does_not_capture_the_exponent() {
        let mut m = Model::new();
        m.set_source("g = 40\ny = 0\nx = 1\nz = g (y - x)^3");
        assert_eq!(param(&m, "z"), -40.0);
        // the parenthesised workaround still agrees, so both spellings of the
        // same physics now integrate the same system
        m.set_source("g = 40\ny = 0\nx = 1\nz = g ((y - x)^3)");
        assert_eq!(param(&m, "z"), -40.0);
    }

    /// ...and the same row shape means the other thing when the document has
    /// said the name is a function. Only the document can tell these apart,
    /// which is why the compile reads the rows twice.
    #[test]
    fn a_name_the_document_defines_as_a_function_keeps_call_precedence() {
        let mut m = Model::new();
        m.set_source("f(u) = c u\nc = 2\ny = 0\nx = 1\nz = f(y - x)^3\nw = c (y - x)^3");
        assert_eq!(param(&m, "z"), -8.0); // (2 * -1)^3
        assert_eq!(param(&m, "w"), -2.0); // 2 * (-1)^3
    }

    // --- rand() has a call site --------------------------------------------

    /// Two `rand()`s are two numbers. They used to be the same one, because
    /// nothing below the document knows where a call sits.
    #[test]
    fn two_random_call_sites_draw_different_numbers() {
        let mut m = Model::new();
        m.set_source("a = rand()\nb = rand()\nc = randn()\nd = randn()");
        assert_ne!(param(&m, "a"), param(&m, "b"));
        assert_ne!(param(&m, "c"), param(&m, "d"));
        // two sites on one row are two sites as well
        m.set_source("a = rand() - rand()");
        assert_ne!(param(&m, "a"), 0.0);
    }

    /// The hard requirement. A hashed site name — rather than a counter over
    /// the document — is what keeps an edit somewhere else from re-rolling
    /// numbers the user is already looking at.
    #[test]
    fn random_call_sites_are_stable_across_compiles_and_unrelated_edits() {
        let read = |src: &str| {
            let mut m = Model::new();
            m.set_source(src);
            (param(&m, "a"), param(&m, "b"))
        };
        let base = read("a = rand()\nb = randn()\nx' = 0\nx(0) = 0");
        // the same document, compiled again
        assert_eq!(read("a = rand()\nb = randn()\nx' = 0\nx(0) = 0"), base);
        // a row inserted above both of them
        assert_eq!(read("k = 5\na = rand()\nb = randn()\nx' = 0\nx(0) = 0"), base);
        // an unrelated row edited
        assert_eq!(read("a = rand()\nb = randn()\nx' = 1\nx(0) = 0"), base);
        // a row deleted from underneath them
        assert_eq!(read("a = rand()\nb = randn()\nx' = 0"), base);
    }

    /// `rand(s)` names its own stream and is the user's business, not ours.
    #[test]
    fn an_explicitly_seeded_draw_is_left_exactly_as_written() {
        let mut m = Model::new();
        m.set_source("a = rand(3)\nb = rand(3)\nc = rand(4)");
        assert_eq!(param(&m, "a"), param(&m, "b"));
        assert_ne!(param(&m, "a"), param(&m, "c"));
    }

    /// A drawn number is a *constant*, so the solver sees the same right-hand
    /// side at every stage of every step — which is the property that lets a
    /// document containing randomness be integrated at all.
    #[test]
    fn a_random_coefficient_is_constant_through_a_solve() {
        let m = solved("k = rand()\nx' = k\nx(0) = 0", 0.0, 1.0);
        let k = param(&m, "k");
        assert!(k > 0.0 && k < 1.0, "{}", k);
        assert!((m.eval(1.0)[0] - k).abs() < 1e-9, "{:?}", m.eval(1.0));
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
        let errors = errors_on("x' = 1\nx' = 2");
        assert_eq!(errors.len(), 1, "{:?}", errors);
        assert_eq!(errors[0].line, 1);
    }

    #[test]
    fn issues_carry_the_line_and_the_span_within_it() {
        let errors = errors_on("x' = -y\ny' = sin(x");
        assert_eq!(errors.len(), 1, "{:?}", errors);
        let i = &errors[0];
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

    // --- choosing a method -------------------------------------------------

    /// The property the mode slider rests on: the choice of integrator changes
    /// the error, not the answer. Same document, same state layout, same dense
    /// output, three trajectories that agree to well under a pixel.
    #[test]
    fn every_method_integrates_the_same_second_order_document() {
        for method in Method::ALL {
            let mut m = Model::new();
            m.set_source("x'' = -x\nx(0) = 1");
            let r = m.solve_with(0.0, 20.0, method);
            assert!(r.ok, "{}: {:?}", method, r.error);
            assert_eq!(r.dim, 2);
            assert_eq!(r.method, method.name());
            for i in 0..=40 {
                let t = 20.0 * (i as f64) / 40.0;
                let y = m.eval(t);
                assert!(
                    (y[0] - t.cos()).abs() < 1e-3 && (y[1] + t.sin()).abs() < 1e-3,
                    "{} at t={}: {:?}",
                    method,
                    t,
                    y
                );
            }
        }
    }

    /// `symplectic` answers "did this run preserve the form", which is not the
    /// same question as "is this method symplectic". Damping is the case where
    /// they part company, and the report must not round it off.
    #[test]
    fn the_report_says_what_the_run_preserved_not_what_the_method_usually_does() {
        let mut m = Model::new();
        m.set_source("x'' = -x\nx(0) = 1");
        assert!(m.solve_with(0.0, 10.0, Method::Verlet).symplectic);
        assert!(!m.solve_with(0.0, 10.0, Method::Tsit5).symplectic);

        // The same method, a system with nothing left to preserve.
        m.set_source("x'' = -x - 0.4x'\nx(0) = 1");
        let r = m.solve_with(0.0, 10.0, Method::Verlet);
        assert!(r.ok, "{:?}", r.error);
        assert_eq!(r.method, "Verlet");
        assert!(!r.symplectic, "damping has no symplectic structure to keep");
    }

    /// The honest failure. A document of first-order rows never said which
    /// states are positions, so there is no structure to preserve — and that is
    /// reported rather than quietly answered by running Tsit5 under a label
    /// reading "Verlet".
    #[test]
    fn a_first_order_document_cannot_be_integrated_symplectically() {
        let mut m = Model::new();
        m.set_source("x' = -y\ny' = x\nx(0) = 1\ny(0) = 0");
        for method in [Method::Verlet, Method::Yoshida4] {
            let r = m.solve_with(0.0, 10.0, method);
            assert!(!r.ok, "{} should refuse a first-order document", method);
            assert_eq!(r.method, method.name());
            assert!(!r.symplectic);
            let e = r.error.unwrap();
            assert!(e.contains("second-order"), "{}", e);
            assert!(e.contains("x''"), "{}", e);
            assert!(e.contains("Tsit5"), "{}", e);
            // and nothing is left behind for the plot to draw
            assert!(m.sample(10).is_empty());
            assert!(m.method().is_none());
        }
        // The same document integrates perfectly well with the adaptive method.
        assert!(m.solve_with(0.0, 10.0, Method::Tsit5).ok);
    }

    /// One first-order row among second-order ones is enough: the state vector
    /// is then not a sequence of position/velocity pairs, and pairing what is
    /// left would integrate a system nobody wrote.
    #[test]
    fn a_document_that_mixes_orders_is_refused_by_name() {
        let mut m = Model::new();
        m.set_source("y'' = -y\nx' = 1\ny(0) = 1");
        let r = m.solve_with(0.0, 10.0, Method::Verlet);
        assert!(!r.ok);
        let e = r.error.unwrap();
        assert!(e.contains('x'), "{}", e);
    }

    /// Answered from the row, exactly. The velocity is a named state, so this
    /// is a question about a dependency set and not a guess — and the answer
    /// costs an extra acceleration evaluation per step, which is why guessing
    /// `true` would be a tax on every undamped oscillator there is.
    #[test]
    fn velocity_dependence_is_read_off_the_row_rather_than_assumed() {
        let reads = |src: &str| {
            let mut m = Model::new();
            m.set_source(src);
            m.document().reads_velocity()
        };
        assert!(!reads("x'' = -x"), "a force law in x alone reads no velocity");
        assert!(reads("x'' = -x - 0.4x'"), "damping reads the velocity");
        // Through a user function, whose body is where the velocity is read.
        assert!(reads("f(u) = -u - 0.4x'\nx'' = f(x)"));
        // ...and as an argument to one.
        assert!(reads("f(u) = -0.4u\nx'' = -x + f(x')"));
        // A parameter shadows the state it is spelled like: this is `-u`, not
        // a reference to anything of the model's.
        assert!(!reads("f(u) = -u\nx'' = f(x)"));
        // Any acceleration row counts, not just the first.
        assert!(reads("x'' = -x\ny'' = -y - 0.3y'"));
        // The position row of a lowered pair is `x' = v` by construction. If
        // that counted, every second-order document would answer yes.
        assert!(!reads("x'' = -x\ny'' = -y"));
        // A document with no second-order structure has no velocity to read.
        assert!(!reads("x' = -y\ny' = x"));
    }

    /// The cost side of the same answer, visible in the telemetry: a
    /// conservative row is one acceleration evaluation per step, a damped one
    /// pays for the extra fixed-point iteration that keeps it second order.
    /// This is the only place the answer's *effect* can be observed from
    /// outside, which is why it is asserted rather than trusted.
    #[test]
    fn a_velocity_dependent_row_costs_extra_evaluations_and_stays_second_order() {
        let mut m = Model::new();
        m.set_source("x'' = -x\nx(0) = 1");
        let plain = m.solve_with(0.0, 12.0, Method::Verlet);
        assert!(plain.rhs_evals <= plain.accepted + 1, "{:?}", plain);

        m.set_source("x'' = -x - 0.4x'\nx(0) = 1");
        let damp = m.solve_with(0.0, 12.0, Method::Verlet);
        assert!(damp.ok, "{:?}", damp.error);
        assert!(
            damp.rhs_evals > 2 * damp.accepted,
            "the iterated kick should cost more: {:?}",
            damp
        );
        // And second order is genuinely retained — half a step's worth of
        // error, not a whole one.
        for i in 0..=60 {
            let t = 12.0 * (i as f64) / 60.0;
            let got = m.eval(t)[0];
            assert!(
                (got - damped(t)).abs() < 1e-4,
                "at t={}: {} vs {}",
                t,
                got,
                damped(t)
            );
        }
    }

    #[test]
    fn an_unknown_method_name_is_reported_rather_than_defaulted() {
        let mut m = Model::new();
        m.set_source("x'' = -x\nx(0) = 1");
        let r = m.solve_named(0.0, 10.0, "verlet5");
        assert!(!r.ok);
        // Echoed verbatim: the name is the thing that was wrong.
        assert_eq!(r.method, "verlet5");
        let e = r.error.unwrap();
        assert!(e.contains("Verlet") && e.contains("Tsit5"), "{}", e);
        // The spelling a slider label would send is accepted.
        assert!(m.solve_named(0.0, 10.0, "verlet").ok);
        assert!(m.solve_named(0.0, 10.0, " Yoshida4 ").ok);
    }

    #[test]
    fn the_method_list_describes_the_implementation_not_a_copy_of_it() {
        let list = Model::methods();
        assert_eq!(list.methods.len(), Method::ALL.len());
        assert_eq!(list.methods[0].name, "Tsit5");
        assert!(list.methods[0].adaptive && !list.methods[0].symplectic);
        assert!(list.methods.iter().skip(1).all(|m| m.symplectic));
        assert!(list.methods.iter().all(|m| m.order >= 2));
    }

    // --- conservation ------------------------------------------------------

    /// An energy row is a row like any other. Before the monitor existed this
    /// went red — a name used with nothing behind it — and that was the wrong
    /// answer: it has a value everywhere along the solution, just not before
    /// there is one.
    #[test]
    fn an_energy_row_is_a_function_of_the_solution_not_a_mistake() {
        let mut m = Model::new();
        let d = m.set_source("x'' = -x\nx(0) = 1\nx'(0) = 0\nE = 0.5(x'^2 + x^2)");
        assert!(d.issues.is_empty(), "{:?}", d.issues);
        assert_eq!(d.derived, vec!["E".to_string()]);
        // Not a constant, so not offered as one.
        assert!(d.params.is_empty(), "{:?}", d.params);
        assert!(m.solve(0.0, 10.0).ok);
    }

    /// Nobody writes an energy in one line. `E = K + U` has to work, which
    /// means the derived rows relax against each other at every sample.
    #[test]
    fn a_derived_quantity_can_be_written_in_named_pieces() {
        let mut m = Model::new();
        let d = m.set_source("x'' = -x\nx(0) = 1\nx'(0) = 0\nK = 0.5x'^2\nU = 0.5x^2\nE = K + U");
        assert!(d.issues.is_empty(), "{:?}", d.issues);
        assert_eq!(d.derived, vec!["K".to_string(), "U".to_string(), "E".to_string()]);
        assert!(m.solve_with(0.0, 20.0, Method::Yoshida4).ok);
        let c = m.conservation("E", 0);
        assert!(c.ok, "{:?}", c.error);
        assert!((c.initial - 0.5).abs() < 1e-12, "{:?}", c);
        assert!(c.drift.relative_drift < 1e-5, "{:?}", c.drift);
    }

    /// The whole point of the slider, in one document: the same typed energy,
    /// three integrators, and only the symplectic ones keep it in a band that
    /// is no wider at the end of the run than at the start.
    #[test]
    fn only_the_symplectic_methods_keep_a_typed_energy_bounded() {
        for method in Method::ALL {
            let mut m = Model::new();
            m.set_source("x'' = -x\nx(0) = 1\nE = 0.5(x'^2 + x^2)");
            let r = m.solve_with(0.0, 200.0, method);
            assert!(r.ok, "{}: {:?}", method, r.error);
            let c = m.conservation("E", 0);
            assert!(c.ok, "{}: {:?}", method, c.error);
            assert_eq!(c.name, "E");
            assert!((c.initial - 0.5).abs() < 1e-12, "{}: {:?}", method, c);
            if method.is_symplectic() {
                assert!(
                    c.drift.secular_ratio < 2.0,
                    "{} should stay in a band, ratio {}",
                    method,
                    c.drift.secular_ratio
                );
            } else {
                assert!(
                    c.drift.secular_ratio > 3.0,
                    "{} should drift, ratio {}",
                    method,
                    c.drift.secular_ratio
                );
            }
        }
    }

    /// A first-order document has its invariants too — this one is exactly the
    /// unit circle — and the monitor does not care how the rows were written.
    #[test]
    fn an_invariant_of_a_first_order_document_measures_just_as_well() {
        let mut m = Model::new();
        m.set_source("x' = -y\ny' = x\nx(0) = 1\ny(0) = 0\nR = x^2 + y^2");
        assert!(m.solve(0.0, 50.0).ok);
        let c = m.conservation("R", 0);
        assert!(c.ok, "{:?}", c.error);
        assert_eq!(c.initial, 1.0);
        assert!(c.drift.relative_drift < 1e-4, "{:?}", c.drift);
        // A state and a constant are measurable too — "is my momentum actually
        // constant" is the same question about a simpler expression.
        assert!(m.conservation("x", 0).ok);
        m.set_source("k = 2\nx' = -k x\nx(0) = 1");
        assert!(m.solve(0.0, 1.0).ok);
        let c = m.conservation("k", 0);
        assert!(c.ok, "{:?}", c.error);
        assert_eq!(c.drift.max_abs_deviation, 0.0);
    }

    /// Both summaries are reported because they answer different questions.
    /// Lotka–Volterra's `V` is conserved by the true flow and not by Tsit5, and
    /// the gap between the two figures is the cubic Hermite between step
    /// points — interpolation, not the method losing the invariant.
    #[test]
    fn the_step_point_summary_is_separate_from_the_curve_that_is_drawn() {
        let mut m = Model::new();
        m.set_source(
            "x' = x - x y\ny' = x y - y\nx(0) = 1.2\ny(0) = 0.8\nV = x - ln(x) + y - ln(y)",
        );
        assert!(m.solve(0.0, 200.0).ok);
        let c = m.conservation("V", 0);
        assert!(c.ok, "{:?}", c.error);
        assert!(
            c.at_steps.max_abs_deviation < c.drift.max_abs_deviation,
            "the interpolant should account for the difference: {:?}",
            c
        );
        // ...and they tell the same story about the method, which is what makes
        // the difference safe to report rather than alarming.
        assert!(c.drift.secular_ratio > 2.0 && c.at_steps.secular_ratio > 2.0, "{:?}", c);
    }

    /// The sample count is a floor to be raised, never an instruction to be
    /// obeyed downwards. A monitor asking for its pixel width is asking a
    /// question about a screen; aliasing is a question about the system.
    #[test]
    fn a_request_for_too_few_samples_is_raised_rather_than_honoured() {
        let mut m = Model::new();
        m.set_source("x'' = -x\nx(0) = 1\nE = 0.5(x'^2 + x^2)");
        assert!(m.solve_with(0.0, 200.0, Method::Verlet).ok);
        let coarse = m.conservation("E", 10);
        assert!(coarse.samples > 1000, "{:?}", coarse);
        assert_eq!(coarse.samples, m.conservation_series().len() / 2);
        // Undersampled deliberately, this same run reports a band that grows
        // out of nothing — which is exactly what the floor prevents.
        let asked = m.conservation("E", 0).samples;
        assert!(asked >= 1000);
        // A caller that genuinely wants more still gets more.
        assert_eq!(m.conservation("E", 30_000).samples, 30_000);
    }

    #[test]
    fn the_series_is_flat_time_stamped_pairs_and_dies_with_its_solution() {
        let mut m = Model::new();
        m.set_source("x'' = -x\nx(0) = 1\nE = 0.5(x'^2 + x^2)");
        assert!(m.conservation_series().is_empty());
        assert!(m.solve(0.0, 10.0).ok);
        let c = m.conservation("E", 0);
        let s = m.conservation_series();
        assert_eq!(s.len(), 2 * c.samples);
        assert_eq!(s[0], 0.0);
        assert!((s[1] - c.initial).abs() < 1e-12);
        assert!((s[s.len() - 2] - 10.0).abs() < 1e-9);
        // Re-solving invalidates it: a drift curve outliving the trajectory it
        // was measured on is the same bug as a stale sample.
        assert!(m.solve(0.0, 20.0).ok);
        assert!(m.conservation_series().is_empty());
        m.set_source("x'' = -x\nx(0) = 1");
        assert!(m.conservation_series().is_empty());
    }

    #[test]
    fn measuring_something_that_is_not_there_reports_rather_than_failing() {
        let mut m = Model::new();
        m.set_source("x'' = -x\nx(0) = 1\nE = 0.5(x'^2 + x^2)");
        // Nothing integrated yet.
        let c = m.conservation("E", 0);
        assert!(!c.ok);
        assert!(c.error.unwrap().contains("integrated"));

        assert!(m.solve(0.0, 10.0).ok);
        let c = m.conservation("Q", 0);
        assert!(!c.ok);
        let e = c.error.unwrap();
        assert!(e.contains('Q'), "{}", e);
        assert!(m.conservation_series().is_empty());
    }

    /// A typo inside an energy row is found when it is typed, not when the
    /// monitor is opened — the probe pass evaluates derived rows too.
    #[test]
    fn a_broken_derived_row_is_reported_like_any_other() {
        let issues = issues_on("x'' = -x\nx(0) = 1\nx'(0) = 0\nE = 0.5(x'^2 + q)");
        assert_eq!(issues.len(), 1, "{:?}", issues);
        assert_eq!(issues[0].line, 3);
        assert!(issues[0].message.contains('q'), "{:?}", issues[0]);
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

    /// `fix` is an addition to v1, so it is absent — not null — unless the
    /// compiler has something concrete to propose.
    #[test]
    fn a_proposed_row_reaches_the_wire_and_is_omitted_when_there_is_none() {
        let json = Model::new().set_source_json("x' = -y\ny' = x\nx(0) = 1");
        assert!(
            json.contains(r#""message":"y has no starting point""#),
            "{}",
            json
        );
        assert!(
            json.contains(r#""fix":{"label":"add y(0) = 0","insert":"y(0) = 0"}"#),
            "{}",
            json
        );

        let json = Model::new().set_source_json("x' = -y\ny' = sin(x\nx(0) = 0\ny(0) = 0");
        assert!(json.contains(r#""severity":"error""#), "{}", json);
        assert!(!json.contains("\"fix\""), "{}", json);
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

    /// The two fields the shell needs in order never to label a curve with a
    /// method that did not draw it.
    #[test]
    fn the_solve_report_carries_the_method_on_the_wire() {
        let mut m = Model::new();
        m.set_source("x'' = -x\nx(0) = 1\nx'(0) = 0");
        let json = m.solve_with_json(0.0, 20.0, Method::Yoshida4);
        assert!(json.contains(r#""method":"Yoshida4""#), "{}", json);
        assert!(json.contains(r#""symplectic":true"#), "{}", json);

        let json = m.solve_named_json(0.0, 20.0, "Tsit5");
        assert!(json.contains(r#""method":"Tsit5""#), "{}", json);
        assert!(json.contains(r#""symplectic":false"#), "{}", json);

        // A refusal is still a report, and still names what was asked for.
        m.set_source("x' = 1");
        let json = m.solve_with_json(0.0, 20.0, Method::Verlet);
        assert!(json.contains(r#""ok":false"#), "{}", json);
        assert!(json.contains(r#""method":"Verlet""#), "{}", json);
    }

    #[test]
    fn the_conservation_report_matches_the_contract() {
        let mut m = Model::new();
        m.set_source("x'' = -x\nx(0) = 1\nx'(0) = 0\nE = 0.5(x'^2 + x^2)");
        assert!(m.solve_with(0.0, 20.0, Method::Verlet).ok);
        let json = m.conservation_json("E", 0);
        assert!(json.starts_with(r#"{"ok":true,"name":"E","samples":"#), "{}", json);
        assert!(json.contains(r#""initial":0.5"#), "{}", json);
        for key in [
            "\"drift\":{",
            "\"atSteps\":{",
            "\"maxAbsDeviation\":",
            "\"relativeDrift\":",
            "\"netDrift\":",
            "\"secularRatio\":",
            "\"error\":null",
        ] {
            assert!(json.contains(key), "{} missing from {}", key, json);
        }
        // The series is deliberately not in the JSON — bulk numbers cross as a
        // Float64Array, and a few thousand of them spelled out here would be
        // parsed on every drag of the slider.
        assert!(!json.contains("\"values\""), "{}", json);

        let json = m.conservation_json("nope", 0);
        assert!(json.contains(r#""ok":false"#), "{}", json);
        assert!(json.contains("\"error\":\"there is no row called nope"), "{}", json);
    }

    #[test]
    fn the_method_list_reaches_the_wire() {
        let json = Model::methods_json();
        assert!(
            json.starts_with(r#"{"methods":[{"name":"Tsit5","adaptive":true,"symplectic":false,"order":5}"#),
            "{}",
            json
        );
        assert!(json.contains(r#"{"name":"Verlet","adaptive":false,"symplectic":true,"order":2}"#), "{}", json);
    }

    /// `derived` is an addition to v1 and behaves like `params`: always
    /// present, empty when there is nothing to say.
    #[test]
    fn derived_rows_reach_the_wire_beside_the_parameters() {
        let json = Model::new().set_source_json("k = 2\nx'' = -k x\nx(0) = 1\nE = 0.5x'^2");
        assert!(json.contains(r#""params":["k"]"#), "{}", json);
        assert!(json.contains(r#""derived":["E"]"#), "{}", json);
        let json = Model::new().set_source_json("x' = 1");
        assert!(json.contains(r#""derived":[]"#), "{}", json);
    }
}
