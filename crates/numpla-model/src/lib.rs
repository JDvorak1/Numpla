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
//! 4. **A run that gives up still draws.** `x' = x^2` escapes to infinity at
//!    `t = 1`; the rise into that is the interesting part of the model and not
//!    a reason for a blank screen. So an integration the numerics abandoned
//!    reports [`ok: true`](SolveReport::ok) with a curve over the span it
//!    managed, plus [`stopped`](SolveReport::stopped) saying how far it got and
//!    why it went no further. `ok: false` is reserved for having produced
//!    *nothing*. Partial is never presented as complete, and incomplete is
//!    never presented as nothing.
//! 5. **The method is the user's choice, and the report says which one ran.**
//!    No fixed-step integrator preserves the symplectic form, momentum and
//!    energy at once (Ge–Marsden, `docs/solvers.md`); which one a method gives
//!    up is the most useful thing a long run can teach, so swapping integrators
//!    is one argument and the answer never claims to be something it is not.

pub mod cas;
pub mod conserve;
pub mod document;
pub mod report;
pub mod system;

pub use cas::{CasReply, CasStep};
pub use document::{Derived, Document, StateRhs};
pub use report::{
    ConservationReport, Diagnostics, Drift, Fix, Issue, MethodJson, MethodsJson, Severity,
    SolveReport, StepJson, StopKind, Stopped, TelemetryJson,
};
pub use system::ModelSystem;

/// Re-exported so that choosing a method costs a caller nothing but this crate.
pub use numpla_ode::Method;

use numpla_ode::{
    solve, solve_with as solve_second_order, Opts, Paired, Solution, SolveError, StopReason, System,
};

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

/// One completed integration, and the one thing about it that cannot be read
/// back off the [`Solution`].
///
/// Whether the run had a symplectic structure to preserve is a property of the
/// *document* — an acceleration row that mentions `x'` has none — so it is
/// answered once, where the system is built, and carried out rather than
/// recomputed by each caller.
struct Run {
    solution: Solution,
    velocity_dependent: bool,
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
    /// a sentence saying why — and safe to call on one that *misbehaves*, which
    /// comes back as `ok: true` over a shorter window with
    /// [`SolveReport::stopped`] saying where it gave up.
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
    /// # When the numerics give up part-way
    ///
    /// That is not a failure of this call. The steps that were taken are kept,
    /// [`SolveReport::t_end`] says how far they reached, and
    /// [`SolveReport::stopped`] says why they stopped — `ok` stays true,
    /// because there is a curve to draw and it is the curve the person asked
    /// for, just shorter. The blowup is usually the thing they were looking at.
    ///
    /// A right-hand side that could not be *evaluated* is different and still
    /// fails the whole solve: the integrator carried on past it with a
    /// substituted zero, so everything after that point is fiction rather than
    /// a shorter truth, and there is no honest place to cut the curve.
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
            // Nothing ran, so the integrated window is empty. Reporting `t1`
            // here would claim a span that was never touched.
            t_end: t0,
            stopped: None,
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

        let y0 = self.doc.y0.clone();
        let run = match self.integrate(t0, t1, method, &y0) {
            Ok(run) => run,
            Err(error) => return fail(error),
        };

        // A run that gave up part-way is still `ok`. It produced a real curve
        // over `[t0, t_end]`, and for `x' = x^2` that curve *is* the answer —
        // the rise into the singularity is what someone typed the model to
        // see. `ok` therefore means "there is something to draw", and `stopped`
        // carries the rest, so the shell can render the curve and the sentence
        // together instead of choosing between a plot and an explanation.
        let telemetry = run.solution.telemetry.clone();
        let t_end = run.solution.t_end;
        let stopped = run
            .solution
            .stopped
            .map(|reason| describe_stop(reason, t_end));
        self.solution = Some(run.solution);
        self.method = Some(method);
        SolveReport {
            ok: true,
            t0,
            t1,
            t_end,
            stopped,
            dim,
            states,
            accepted: telemetry.accepted,
            rejected: telemetry.rejected,
            rhs_evals: telemetry.rhs_evals,
            method: name,
            symplectic: method.is_symplectic() && !run.velocity_dependent,
            error: None,
        }
    }

    /// Integrate this document from an arbitrary starting state, without
    /// touching anything the model has stored.
    ///
    /// Every integration in this crate goes through here — the document's own
    /// solve, a seed's trajectory, and (through [`ModelSystem`]) the sampled
    /// vector field. That is deliberate: a second entry point would be a second
    /// chance for the picture on screen and the system being integrated to
    /// drift apart, and the whole value of a phase portrait is that every curve
    /// and every arrow in it answers to the same equations.
    ///
    /// `&self`, so the borrow checker guarantees what the contract promises: an
    /// extra trajectory cannot disturb the stored solution, whatever it does.
    ///
    /// The `Err` side is reserved for having produced *nothing* — the same
    /// meaning `ok: false` has in a [`SolveReport`]. A run the numerics
    /// abandoned part-way comes back as `Ok` with a short [`Solution`] and
    /// [`Solution::stopped`] set.
    fn integrate(&self, t0: f64, t1: f64, method: Method, y0: &[f64]) -> Result<Run, String> {
        let dim = self.doc.dim();
        let name = method.name();

        if let Some(message) = self.doc.first_error() {
            return Err(message);
        }
        if dim == 0 {
            return Err("there are no ODE rows to integrate".to_string());
        }
        // Reported, but as a statement of fact rather than a complaint: the
        // shell is expected to hold off on solving while rows are still
        // pending. Only the pending rows that actually block count — a state
        // with no initial condition is reported *and* defaulted, so a document
        // that has not said where everything starts still draws.
        if let Some(blocker) = self.doc.first_blocker() {
            return Err(format!("the model is still incomplete — {}", blocker));
        }
        if y0.len() != dim {
            return Err(format!(
                "this document has {} states, but {} starting values were given",
                dim,
                y0.len()
            ));
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
            solve(&sys, (t0, t1), y0, &opts)
        } else {
            match self.doc.pairs() {
                Err(why) => {
                    return Err(format!(
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
                        Err(e) => return Err(format!("internal error: {}", e)),
                    };
                    let paired = if velocity_dependent {
                        paired.reading_velocity()
                    } else {
                        paired
                    };
                    solve_second_order(method, &paired, (t0, t1), y0, &opts)
                }
            }
        };

        match outcome {
            Ok(solution) => {
                // A right-hand side cannot fail outward, so a failure recorded
                // during the run outranks an integration that merely finished.
                match sys.failure() {
                    Some(message) => Err(message),
                    None => Ok(Run {
                        solution,
                        velocity_dependent,
                    }),
                }
            }
            Err(e) => Err(sys.failure().unwrap_or_else(|| describe_solve_error(&e))),
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
                t_end: t0,
                stopped: None,
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
    /// The samples span what was **integrated**, not what was requested, so a
    /// run that stopped early draws a curve that ends where the run did rather
    /// than a flat tail across the rest of the window pretending to be physics.
    /// The last `t` here equals [`SolveReport::t_end`].
    ///
    /// The flattening itself is [`sample_solution`], shared with
    /// [`Model::trajectory_from`] so that a seed and the document's own curve
    /// cannot come back in different shapes.
    pub fn sample(&self, n: usize) -> Vec<f64> {
        match &self.solution {
            Some(sol) => sample_solution(sol, n),
            None => Vec::new(),
        }
    }

    /// State at one time — the scrubber playhead. Clamped to the integrated
    /// span rather than extrapolated.
    ///
    /// After a run that stopped early this holds the last state it reached for
    /// the whole remainder of the requested window. Holding reads as "nothing
    /// is known here"; extrapolating a fifth-order polynomial out of a
    /// singularity would read as a confident answer and be fiction.
    pub fn eval(&self, t: f64) -> Vec<f64> {
        match &self.solution {
            Some(sol) => sol.eval(t),
            None => Vec::new(),
        }
    }

    /// The right-hand side sampled on a grid across `[x0, x1] x [y0, y1]`, at
    /// time `t`.
    ///
    /// Flat and row-major, four numbers per sample: `[x, y, dx, dy]` repeated
    /// `nx * ny` times. `x` varies fastest, so sample `(i, j)` — column `i` of
    /// row `j` — starts at index `4 * (j * nx + i)`. Both ranges are sampled
    /// endpoint-inclusive, the way [`Model::sample`] treats a time span; a grid
    /// one wide sits on `x0`.
    ///
    /// Empty, never a panic, when there is nothing honest to draw: a document
    /// without exactly two states (the phase plane has two axes and no opinion
    /// about a third), one that does not compile, an empty grid, or a row that
    /// could not be evaluated at some sample. That last case matters: a failed
    /// row substitutes a zero derivative, and a grid of zero-length arrows
    /// looks exactly like a system at rest. Nothing is the honest answer.
    ///
    /// # Why `t` is an argument
    ///
    /// A non-autonomous system — `x' = y`, `y' = -sin(t)` — genuinely has a
    /// different field at every instant, so there is no field to draw without
    /// being told which one. Assuming zero would quietly show the wrong picture
    /// for exactly the models whose time dependence is the point.
    ///
    /// # Why this shares the solver's evaluation
    ///
    /// The arrows come from [`ModelSystem`]'s `rhs` — the same call, on the
    /// same type, that Tsit5 makes six times per step, and that `Paired` calls
    /// underneath Verlet and Yoshida4. There is deliberately no second
    /// evaluator here: a field drawn from a subtly different reading of the
    /// document would be a lie about the system whose trajectories are drawn on
    /// top of it, and the failure mode — arrows that do not quite point along
    /// the curves — is one nobody would think to distrust.
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
        if self.doc.dim() != 2 || nx == 0 || ny == 0 {
            return Vec::new();
        }
        if self.doc.first_error().is_some() || self.doc.first_blocker().is_some() {
            return Vec::new();
        }

        let sys = ModelSystem::new(&self.doc);
        let mut out = Vec::with_capacity(nx * ny * 4);
        let mut state = [0.0f64; 2];
        let mut dy = [0.0f64; 2];
        for j in 0..ny {
            let y = grid_coord(y0, y1, j, ny);
            for i in 0..nx {
                let x = grid_coord(x0, x1, i, nx);
                state[0] = x;
                state[1] = y;
                sys.rhs(t, &state, &mut dy);
                out.extend_from_slice(&[x, y, dy[0], dy[1]]);
            }
        }

        // Checked after the sweep rather than per sample: `rhs` records only
        // the first failure, and one unevaluable row makes the whole field
        // fiction, not just the arrow that hit it.
        if sys.failure().is_some() {
            return Vec::new();
        }
        out
    }

    /// One trajectory from an explicit starting state, sampled uniformly.
    ///
    /// Flat: `[t, y_0, .., y_{dim-1}]` repeated `n` times — the same layout as
    /// [`Model::sample`], so a seed and the document's own curve are drawn by
    /// the same code.
    ///
    /// This is what a seed is: a starting point somebody placed on the plane,
    /// integrated over the same window and drawn in the same frame. The
    /// document's own initial condition is seed zero and is not special.
    ///
    /// # It cannot disturb the stored solution
    ///
    /// `&self` — the guarantee is the signature, not a promise in prose. The
    /// shell calls this once per seed on top of the document's own run, and a
    /// portrait whose curves quietly replaced each other as they were drawn
    /// would be worse than no portrait. Nothing is cached either: a trajectory
    /// belongs to the seed that asked for it, and the model has no business
    /// remembering the last one.
    ///
    /// # Empty rather than thrown
    ///
    /// A `y0` of the wrong length is a normal state — the shell is holding a
    /// seed from before the document grew a third row — so it comes back empty,
    /// like every other "nothing to draw" in this API. So does `n == 0`, and so
    /// does a document that cannot be integrated at all.
    ///
    /// # A seed that blows up
    ///
    /// Same rule as [`Model::solve`]: the part that worked is returned. The
    /// samples span `[t0, t_end]`, so a seed sitting where solutions escape to
    /// infinity draws a short curve that stops where the integration did — and
    /// its last `t` is the only thing that says where. Read it, or a seed's
    /// shortfall gets drawn as though it covered the window.
    pub fn trajectory_from(
        &self,
        t0: f64,
        t1: f64,
        method: Method,
        y0: &[f64],
        n: usize,
    ) -> Vec<f64> {
        if n == 0 {
            return Vec::new();
        }
        match self.integrate(t0, t1, method, y0) {
            Ok(run) => sample_solution(&run.solution, n),
            Err(_) => Vec::new(),
        }
    }

    /// [`Model::trajectory_from`] with the method named by string — the shape
    /// the shell sends, and the same spelling [`Model::solve_named`] accepts.
    ///
    /// An unknown name is empty rather than a silent Tsit5: a seed drawn with
    /// the wrong integrator, beside document curves drawn with the right one,
    /// would put two methods in one picture under one label.
    pub fn trajectory_from_named(
        &self,
        t0: f64,
        t1: f64,
        method: &str,
        y0: &[f64],
        n: usize,
    ) -> Vec<f64> {
        match method_named(method) {
            Some(m) => self.trajectory_from(t0, t1, m, y0, n),
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

    // ---- the compute pane ------------------------------------------------
    //
    // Four calls, all `&self`: algebra reads the document and never disturbs
    // it. That is stated in the signature rather than in a comment so the
    // compiler keeps the promise — asking to differentiate something must never
    // be able to throw away the curve on screen.
    //
    // Each returns `CasReply` as JSON. `output` is Numpla source that parses;
    // see `cas` for the three decisions about what "the document's scope" means
    // here, and `docs/wasm-api.md` for the wire shape.

    /// Fold arithmetic, apply the identity and zero laws, collect like terms.
    pub fn cas_simplify(&self, expr: &str) -> String {
        to_json(&cas::simplify_expr(&self.doc, expr))
    }

    /// Differentiate with respect to `var`.
    pub fn cas_diff(&self, expr: &str, var: &str) -> String {
        to_json(&cas::diff_expr(&self.doc, expr, var))
    }

    /// Multiply out products over sums.
    pub fn cas_expand(&self, expr: &str) -> String {
        to_json(&cas::expand_expr(&self.doc, expr))
    }

    /// Evaluate to a number where the document gives enough to do so, and to
    /// the simplified expression where it does not.
    pub fn cas_eval(&self, expr: &str) -> String {
        to_json(&cas::eval_expr(&self.doc, expr))
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

/// Uniformly sample a solution into the flat `[t, y_0, .., y_{d-1}]` layout the
/// whole product draws from.
///
/// Shared by [`Model::sample`] and [`Model::trajectory_from`] so a seed and the
/// document's own curve can never come back in different shapes.
///
/// Flat and preallocated because this crosses into JS as one `Float64Array`; a
/// point-per-allocation shape would dominate the cost of drawing a curve.
fn sample_solution(sol: &Solution, n: usize) -> Vec<f64> {
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

/// Sample `i` of `n` across `[a, b]`, endpoints included.
///
/// The same rule [`sample_solution`] uses for time, for the same reason: the
/// window the caller asked for is the window that gets drawn, edges and all. A
/// single sample sits at `a` rather than in the middle, so a degenerate grid is
/// a point on the boundary rather than one nobody asked about.
fn grid_coord(a: f64, b: f64, i: usize, n: usize) -> f64 {
    if n <= 1 {
        a
    } else {
        a + (b - a) * (i as f64) / ((n - 1) as f64)
    }
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

/// An early stop, phrased as what happened to the *model* rather than to the
/// integrator, and always naming where — because "it blew up" is only half an
/// answer and "it blew up at t = 1" is the whole one.
///
/// These sentences sit beside a curve that is still on screen, so they read as
/// a caption for it, not as an apology. The diagnosis goes here rather than in
/// [`StopKind`] so that a shell never has to translate a machine token into
/// English of its own.
fn describe_stop(reason: StopReason, t_end: f64) -> Stopped {
    let (kind, message) = match reason {
        StopReason::StepTooSmall { .. } => (
            StopKind::StepTooSmall,
            format!(
                "stopped at t = {} — the step size collapsed there; the system is probably stiff, or heading for a singularity",
                fmt_t(t_end)
            ),
        ),
        StopReason::NonFinite => (
            StopKind::NonFinite,
            format!(
                "stopped at t = {} — the solution stopped being a number there; it blew up",
                fmt_t(t_end)
            ),
        ),
        StopReason::TooManySteps => (
            StopKind::TooManySteps,
            format!(
                "stopped at t = {} — the step budget ran out before the end of the window",
                fmt_t(t_end)
            ),
        ),
    };
    Stopped {
        reason: kind,
        message,
    }
}

/// A time as a person would read it in a sentence. Six significant figures is
/// more than enough to point at a feature on a plot, and the full seventeen
/// digits of an `f64` in the middle of a caption is noise.
fn fmt_t(t: f64) -> String {
    let s = format!("{:.6}", t);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-" {
        "0".to_string()
    } else {
        s.to_string()
    }
}

/// The failures that leave nothing to draw. Both are programming errors — this
/// crate builds the system and the initial vector itself, so reaching either
/// one means something upstream is wrong, and saying so is more useful than
/// pretending it is a modelling mistake.
fn describe_solve_error(e: &SolveError) -> String {
    match e {
        SolveError::DimensionMismatch { expected, got } => format!(
            "internal error: the system has {} states but {} initial values",
            expected, got
        ),
        SolveError::InvalidStep { dt } => {
            format!("internal error: {} is not a usable step size", dt)
        }
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

    /// The change this whole contract exists for. `x' = x^2` from `x(0) = 1`
    /// has the closed form `1 / (1 - t)` and escapes at `t = 1`; asked for five
    /// units of time it can only give one, and the one it gives is the curve
    /// somebody typed the model to see.
    #[test]
    fn a_blow_up_still_draws_the_part_that_worked() {
        let mut m = Model::new();
        m.set_source("x' = x^2\nx(0) = 1");
        let r = m.solve(0.0, 5.0);

        // There is a solution, so `ok`. It is not the whole span, so `stopped`.
        assert!(r.ok, "{:?}", r.error);
        assert!(r.error.is_none());
        let stopped = r.stopped.as_ref().expect("a blowup must say it stopped");
        assert_eq!(stopped.reason, StopKind::StepTooSmall);
        assert!(
            stopped.message.contains("stopped at t = 1"),
            "{}",
            stopped.message
        );

        assert_eq!(r.t1, 5.0, "the window asked for is reported unchanged");
        assert!((r.t_end - 1.0).abs() < 1e-3, "reached t = {}", r.t_end);

        // And there is a real curve, right to the closed form.
        let s = m.sample(200);
        assert_eq!(s.len(), 400);
        for row in s.chunks(2) {
            let (t, x) = (row[0], row[1]);
            if t > 0.99 {
                continue; // the last hundredth is where the pole is
            }
            let want = 1.0 / (1.0 - t);
            assert!(
                (x - want).abs() < 1e-3 * want,
                "at t = {}: {} vs {}",
                t,
                x,
                want
            );
        }
        // The samples stop where the integration did, so the plot's right-hand
        // edge and `tEnd` are the same fact.
        assert!((s[s.len() - 2] - r.t_end).abs() < 1e-12);
    }

    /// Past the point it reached, the scrubber holds. Extrapolating out of a
    /// singularity would draw four units of confident fiction.
    #[test]
    fn scrubbing_past_a_blow_up_holds_the_last_real_state() {
        let mut m = Model::new();
        m.set_source("x' = x^2\nx(0) = 1");
        let r = m.solve(0.0, 5.0);
        let last = m.eval(r.t_end)[0];
        assert!(last.is_finite());
        for t in [r.t_end + 1e-9, 2.0, 5.0, 1e6] {
            assert_eq!(m.eval(t)[0], last, "at t = {}", t);
        }
    }

    /// A row that stops being a number part-way. `sqrt(x)` is fine while `x`
    /// is positive and NaN the moment it is not, and `x` is falling.
    #[test]
    fn a_nan_right_hand_side_is_a_short_run_not_a_blank_screen() {
        let mut m = Model::new();
        m.set_source("x' = -1\nx(0) = 1\ny' = sqrt(x)\ny(0) = 0");
        let r = m.solve(0.0, 3.0);
        assert!(r.ok, "{:?}", r.error);
        let stopped = r.stopped.as_ref().expect("NaN must be reported");
        assert_eq!(stopped.reason, StopKind::NonFinite);
        assert!(stopped.message.contains("blew up"), "{}", stopped.message);
        assert!(r.t_end > 0.5 && r.t_end <= 1.0, "reached t = {}", r.t_end);
        // Nothing that reaches the plotter is NaN.
        assert!(m.sample(300).iter().all(|v| v.is_finite()));
    }

    /// A run that could not start at all is a different answer from a run that
    /// started and stopped, and the two must not be confused: `ok: false` means
    /// there is nothing to draw, and it never carries a `stopped`.
    #[test]
    fn a_refused_solve_reports_no_span_and_no_stop_reason() {
        let mut m = Model::new();
        m.set_source("x' = q");
        let r = m.solve(2.0, 9.0);
        assert!(!r.ok);
        assert!(r.stopped.is_none());
        assert_eq!(r.t_end, 2.0, "nothing was integrated, so no span was covered");
        assert!(m.sample(10).is_empty());
    }

    /// Every stop gets a sentence that names where it happened, because "it
    /// blew up" is half an answer and "it blew up at t = 1" is the whole one.
    #[test]
    fn every_stop_reason_gets_a_sentence_that_says_where() {
        let cases = [
            (
                StopReason::StepTooSmall { dt: 1e-14 },
                StopKind::StepTooSmall,
                "stiff",
            ),
            (StopReason::NonFinite, StopKind::NonFinite, "blew up"),
            (StopReason::TooManySteps, StopKind::TooManySteps, "budget"),
        ];
        for (reason, kind, needle) in cases {
            let s = describe_stop(reason, 1.9997);
            assert_eq!(s.reason, kind);
            assert!(s.message.contains(needle), "{:?}: {}", kind, s.message);
            assert!(
                s.message.contains("t = 1.9997"),
                "{:?} must say where: {}",
                kind,
                s.message
            );
        }
        // Six figures is enough to point at a feature; seventeen is noise.
        assert_eq!(fmt_t(1.000_000_346_123_815_8), "1");
        assert_eq!(fmt_t(0.0), "0");
        assert_eq!(fmt_t(-2.5), "-2.5");
    }

    /// The strict distinction survives the trip through the model: a complete
    /// run and a partial one are told apart by a field, not by inference from
    /// `t_end` against a float comparison.
    #[test]
    fn a_complete_run_carries_no_stop_reason() {
        let mut m = Model::new();
        m.set_source("x' = -x\nx(0) = 1");
        let r = m.solve(0.0, 5.0);
        assert!(r.ok && r.stopped.is_none());
        assert_eq!(r.t_end, r.t1);
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

    /// A derived row is usable *from* an ODE row, not only watchable beside
    /// one. The probe pass has always accepted `x' = -E` — it binds the
    /// derived rows before probing — so a solver that then refused it gave two
    /// answers to one document: a clean compile and a failed solve. Naming a
    /// quantity and using it is also the cheapest feedback-loop spelling there
    /// is (VISION.md), so the substitution has to actually integrate.
    #[test]
    fn an_ode_row_can_read_a_derived_row() {
        let mut m = Model::new();
        // E defined below its use, like any other row: rows are a set.
        let d = m.set_source("x' = -E\nx(0) = 1\nE = 0.5x^2");
        assert!(d.issues.is_empty(), "{:?}", d.issues);
        assert_eq!(d.derived, vec!["E".to_string()]);
        let r = m.solve(0.0, 6.0);
        assert!(r.ok, "{:?}", r.error);
        // x' = -x^2/2 from x(0) = 1 has the closed form 2/(t + 2).
        for i in 0..=30 {
            let t = 6.0 * (i as f64) / 30.0;
            let got = m.eval(t)[0];
            let want = 2.0 / (t + 2.0);
            assert!((got - want).abs() < 1e-6, "at t={}: {} vs {}", t, got, want);
        }
        // The row is still a derived row: the monitor can watch the same E the
        // solver is reading.
        let c = m.conservation("E", 0);
        assert!(c.ok, "{:?}", c.error);
        assert!((c.initial - 0.5).abs() < 1e-12, "{:?}", c);
    }

    /// A derived row folded into an acceleration is still that acceleration:
    /// `x'' = -x - D` with `D = 0.4x'` is damping, and both halves of the
    /// answer have to see through the name — the run must not be reported as
    /// symplectic, and the iterated kick must keep it second order.
    #[test]
    fn velocity_dependence_is_seen_through_a_derived_row() {
        let mut m = Model::new();
        let d = m.set_source("x'' = -x - D\nx(0) = 1\nx'(0) = 0\nD = 0.4x'");
        assert!(d.issues.is_empty(), "{:?}", d.issues);
        assert!(m.document().reads_velocity(), "the damping is behind a name");

        let r = m.solve_with(0.0, 12.0, Method::Verlet);
        assert!(r.ok, "{:?}", r.error);
        assert!(!r.symplectic, "damping through a derived row is still damping");
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

    // --- the field, and the curves seeded into it --------------------------

    /// One arrow out of a field, by grid position.
    fn arrow(field: &[f64], nx: usize, i: usize, j: usize) -> [f64; 4] {
        let k = 4 * (j * nx + i);
        [field[k], field[k + 1], field[k + 2], field[k + 3]]
    }

    /// The circle, written first order. `x' = -y`, `y' = x`.
    const CIRCLE: &str = "x' = -y\ny' = x\nx(0) = 1\ny(0) = 0";

    #[test]
    fn the_field_is_a_flat_grid_of_point_and_derivative() {
        let mut m = Model::new();
        m.set_source(CIRCLE);
        let (nx, ny) = (5, 3);
        let f = m.vector_field(-1.0, 1.0, 0.0, 2.0, nx, ny, 0.0);
        assert_eq!(f.len(), nx * ny * 4);

        // Endpoint-inclusive in both directions, `x` varying fastest, so the
        // corners of the window are the corners of the grid.
        assert_eq!(arrow(&f, nx, 0, 0)[0..2], [-1.0, 0.0]);
        assert_eq!(arrow(&f, nx, 4, 0)[0..2], [1.0, 0.0]);
        assert_eq!(arrow(&f, nx, 0, 2)[0..2], [-1.0, 2.0]);
        assert_eq!(arrow(&f, nx, 4, 2)[0..2], [1.0, 2.0]);
        // and evenly spaced between them
        assert_eq!(arrow(&f, nx, 2, 1)[0..2], [0.0, 1.0]);

        // A one-wide grid sits on the low edge rather than somewhere nobody
        // named; the same rule `sample` uses for a single time.
        let f = m.vector_field(3.0, 9.0, 4.0, 8.0, 1, 1, 0.0);
        assert_eq!(f[0..2], [3.0, 4.0]);
        // An empty grid is empty, not a panic on `n - 1`.
        assert!(m.vector_field(-1.0, 1.0, -1.0, 1.0, 0, 4, 0.0).is_empty());
        assert!(m.vector_field(-1.0, 1.0, -1.0, 1.0, 4, 0, 0.0).is_empty());
    }

    /// The arrows are the equations, not a picture of them. For the circle the
    /// field is a quarter turn anticlockwise of the position vector.
    #[test]
    fn the_field_points_where_the_rows_point() {
        let mut m = Model::new();
        m.set_source(CIRCLE);
        let f = m.vector_field(-1.0, 1.0, -1.0, 1.0, 3, 3, 0.0);

        // (1, 0) -> (0, 1)
        let a = arrow(&f, 3, 2, 1);
        assert_eq!(&a[0..2], &[1.0, 0.0]);
        assert!(a[2].abs() < 1e-12 && (a[3] - 1.0).abs() < 1e-12, "{:?}", a);

        // (0, 1) -> (-1, 0)
        let b = arrow(&f, 3, 1, 2);
        assert_eq!(&b[0..2], &[0.0, 1.0]);
        assert!((b[2] + 1.0).abs() < 1e-12 && b[3].abs() < 1e-12, "{:?}", b);

        // and the fixed point at the origin has no arrow at all
        let c = arrow(&f, 3, 1, 1);
        assert_eq!(&c[2..4], &[0.0, 0.0]);
    }

    /// The plane has two axes. One state has nothing to put on the second and
    /// three has nothing to do with the third, so both draw nothing rather than
    /// projecting a picture nobody asked for.
    #[test]
    fn a_field_needs_exactly_two_states() {
        let mut m = Model::new();
        m.set_source("x' = -x\nx(0) = 1");
        assert!(m.vector_field(-1.0, 1.0, -1.0, 1.0, 4, 4, 0.0).is_empty());

        m.set_source("x' = -y\ny' = x\nz' = -z\nx(0) = 1");
        assert_eq!(m.document().dim(), 3);
        assert!(m.vector_field(-1.0, 1.0, -1.0, 1.0, 4, 4, 0.0).is_empty());

        // A second-order row is two states and does have a field: position on
        // one axis, its velocity on the other.
        m.set_source("x'' = -x\nx(0) = 1");
        assert_eq!(m.vector_field(-1.0, 1.0, -1.0, 1.0, 4, 4, 0.0).len(), 64);
    }

    /// `t` is a parameter because for these rows the field genuinely is a
    /// different field at every instant. Sampling at zero and calling it *the*
    /// field would be the one thing the view must not do.
    #[test]
    fn a_non_autonomous_field_changes_with_time() {
        let mut m = Model::new();
        m.set_source("x' = sin(t)\ny' = x\nx(0) = 0\ny(0) = 0");

        let a = m.vector_field(-1.0, 1.0, -1.0, 1.0, 4, 4, 0.0);
        let b = m.vector_field(-1.0, 1.0, -1.0, 1.0, 4, 4, std::f64::consts::FRAC_PI_2);
        assert_eq!(a.len(), b.len());

        // Same grid points, genuinely different arrows.
        for k in (0..a.len()).step_by(4) {
            assert_eq!((a[k], a[k + 1]), (b[k], b[k + 1]));
            assert!(a[k + 2].abs() < 1e-12, "at t = 0, x' = sin(0) = 0");
            assert!((b[k + 2] - 1.0).abs() < 1e-12, "at t = pi/2, x' = 1");
        }
        assert!(a != b);

        // An autonomous document is the honest opposite: same field forever.
        m.set_source(CIRCLE);
        assert_eq!(
            m.vector_field(-1.0, 1.0, -1.0, 1.0, 4, 4, 0.0),
            m.vector_field(-1.0, 1.0, -1.0, 1.0, 4, 4, 17.5)
        );
    }

    /// Half-typed input is a normal state here too. Nothing throws; the view
    /// simply has nothing to draw until the row means something.
    #[test]
    fn a_document_that_does_not_compile_has_no_field() {
        let mut m = Model::new();
        // a genuine error
        m.set_source("x' = -y)\ny' = x");
        assert!(m.vector_field(-1.0, 1.0, -1.0, 1.0, 4, 4, 0.0).is_empty());
        // a name nobody has defined yet — pending, and equally undrawable
        m.set_source("x' = -k y\ny' = x");
        assert!(m.vector_field(-1.0, 1.0, -1.0, 1.0, 4, 4, 0.0).is_empty());
        // mid-keystroke
        m.set_source("x' = -\ny' = x");
        assert!(m.vector_field(-1.0, 1.0, -1.0, 1.0, 4, 4, 0.0).is_empty());
        // and nothing at all
        assert!(Model::new()
            .vector_field(-1.0, 1.0, -1.0, 1.0, 4, 4, 0.0)
            .is_empty());
    }

    /// The property the whole field view rests on: the arrows and the curves
    /// come out of one evaluation of the document, so an arrow is the tangent
    /// of the trajectory through the point it sits on. Checked against a
    /// trajectory the solver actually integrated, not against a formula — a
    /// second reading of the rows here would test the wrong thing.
    #[test]
    fn every_arrow_is_the_tangent_of_the_curve_through_it() {
        // Nonlinear and asymmetric, so a swapped or sign-flipped component
        // could not pass by coincidence.
        let mut m = Model::new();
        m.set_source("x' = x - x y\ny' = x y - y\nx(0) = 1\ny(0) = 0.5");

        let h = 1e-4;
        for &(x, y) in &[(1.0, 0.5), (0.4, 1.7), (2.3, 0.9), (1.5, 1.5)] {
            let f = m.vector_field(x, x, y, y, 1, 1, 0.0);
            let seed = m.trajectory_from(0.0, h, Method::Tsit5, &[x, y], 2);
            assert_eq!(seed.len(), 6);
            let (dx, dy) = ((seed[4] - seed[1]) / h, (seed[5] - seed[2]) / h);
            assert!((f[2] - dx).abs() < 1e-3, "at ({}, {}): {:?}", x, y, f);
            assert!((f[3] - dy).abs() < 1e-3, "at ({}, {}): {:?}", x, y, f);
        }

        // The same holds through the symplectic path, where the solver reaches
        // the rows via `Paired` rather than directly: one `ModelSystem`, so one
        // right-hand side whichever integrator is on the slider.
        m.set_source("x'' = -sin(x) - 0.3x'\nx(0) = 1\nx'(0) = 0");
        for &(x, v) in &[(1.0, 0.0), (-0.7, 1.2), (2.0, -0.5)] {
            let f = m.vector_field(x, x, v, v, 1, 1, 0.0);
            let seed = m.trajectory_from(0.0, h, Method::Verlet, &[x, v], 2);
            assert_eq!(seed.len(), 6);
            let (dx, dv) = ((seed[4] - seed[1]) / h, (seed[5] - seed[2]) / h);
            assert!((f[2] - dx).abs() < 1e-3, "at ({}, {}): {:?}", x, v, f);
            assert!((f[3] - dv).abs() < 1e-3, "at ({}, {}): {:?}", x, v, f);
        }
    }

    /// A seed is a different starting point, and it draws a different curve.
    /// The document's own initial condition is seed zero and nothing more.
    #[test]
    fn a_seed_draws_its_own_curve() {
        let m = solved(CIRCLE, 0.0, std::f64::consts::TAU);
        let own = m.sample(64);
        let seed = m.trajectory_from(0.0, std::f64::consts::TAU, Method::Tsit5, &[2.0, 0.0], 64);

        assert_eq!(seed.len(), own.len(), "the same flat layout as `sample`");
        // Same times, twice the radius.
        for row in 0..64 {
            let k = row * 3;
            assert!((seed[k] - own[k]).abs() < 1e-12, "same sample times");
            let r = (seed[k + 1].powi(2) + seed[k + 2].powi(2)).sqrt();
            assert!((r - 2.0).abs() < 1e-6, "radius {} at row {}", r, row);
        }
        assert!(seed != own);
    }

    /// The property most likely to break, asserted on its own: a seed is a
    /// *view* of the model. The shell draws one per seed on top of the
    /// document's own run, and that run — its curve, its telemetry, its
    /// conservation series — has to be exactly where it was left.
    #[test]
    fn a_seed_leaves_the_stored_solution_untouched() {
        let mut m = solved(
            "x'' = -x\nx(0) = 1\nx'(0) = 0\nE = 0.5(x'^2 + x^2)",
            0.0,
            20.0,
        );
        let before_sample = m.sample(200);
        let before_eval = m.eval(7.5);
        let before_method = m.method();
        let before_telemetry = m.telemetry().steps.len();
        m.conservation("E", 0);
        let before_series = m.conservation_series();
        assert!(!before_series.is_empty());

        // Several seeds, different starting points, different methods, and one
        // that cannot be integrated at all.
        for method in Method::ALL {
            for start in [[0.5, 0.0], [0.0, 3.0], [-2.0, 1.5]] {
                let seed = m.trajectory_from(0.0, 20.0, method, &start, 100);
                assert_eq!(seed.len(), 300, "{} from {:?}", method, start);
            }
        }
        assert!(m
            .trajectory_from(0.0, 20.0, Method::Tsit5, &[1.0], 100)
            .is_empty());

        assert_eq!(m.sample(200), before_sample, "the document's own curve");
        assert_eq!(m.eval(7.5), before_eval);
        assert_eq!(m.method(), before_method);
        assert_eq!(m.telemetry().steps.len(), before_telemetry);
        assert_eq!(
            m.conservation_series(),
            before_series,
            "and its drift curve"
        );
    }

    /// A stale seed — one the shell is still holding from before the document
    /// grew a row — is a normal state, and normal states come back empty.
    #[test]
    fn a_seed_of_the_wrong_length_draws_nothing() {
        let m = solved(CIRCLE, 0.0, 10.0);
        assert!(m
            .trajectory_from(0.0, 10.0, Method::Tsit5, &[], 50)
            .is_empty());
        assert!(m
            .trajectory_from(0.0, 10.0, Method::Tsit5, &[1.0], 50)
            .is_empty());
        assert!(m
            .trajectory_from(0.0, 10.0, Method::Tsit5, &[1.0, 0.0, 0.0], 50)
            .is_empty());
        // and asking for no samples is asking for nothing
        assert!(m
            .trajectory_from(0.0, 10.0, Method::Tsit5, &[1.0, 0.0], 0)
            .is_empty());
    }

    /// The same rule `solve` obeys: the part that worked is the answer. A seed
    /// dropped where solutions escape to infinity is usually dropped there on
    /// purpose.
    #[test]
    fn a_seed_that_blows_up_returns_the_part_that_worked() {
        // `x' = x^2` escapes at `t = 1 / x(0)`; `y' = 1` is a clock beside it.
        let mut m = Model::new();
        m.set_source("x' = x^2\ny' = 1\nx(0) = 0\ny(0) = 0");

        // The document's own seed sits at x = 0 and never leaves.
        let r = m.solve(0.0, 5.0);
        assert!(r.ok && r.stopped.is_none(), "{:?}", r);

        let seed = m.trajectory_from(0.0, 5.0, Method::Tsit5, &[1.0, 0.0], 100);
        assert_eq!(seed.len(), 300, "short in time, not in samples");

        // It stops where the singularity is, and the last sample is the only
        // thing that says so.
        let last_t = seed[297];
        assert!((last_t - 1.0).abs() < 1e-3, "reached t = {}", last_t);
        assert!(seed[0].abs() < 1e-12, "still starts at t0");

        // Usable, not a row of infinities: the rise into the pole is the curve.
        for row in seed.chunks(3) {
            assert!(row[1].is_finite() && row[2].is_finite(), "{:?}", row);
            if row[0] < 0.9 {
                let want = 1.0 / (1.0 - row[0]);
                assert!((row[1] - want).abs() < 1e-3 * want, "{:?}", row);
            }
        }

        // And the document's own solution still covers the whole window.
        assert!((m.sample(2)[3] - 5.0).abs() < 1e-12);
    }

    /// A seed is the model's answer, not the integrator's. Two methods over one
    /// starting point land on one curve, which is what makes the mode slider a
    /// comparison rather than a change of subject.
    #[test]
    fn the_same_seed_agrees_under_two_methods() {
        let m = solved("x'' = -x\nx(0) = 1\nx'(0) = 0", 0.0, 10.0);
        let start = [0.4, 1.3];
        let a = m.trajectory_from(0.0, 10.0, Method::Tsit5, &start, 200);
        let b = m.trajectory_from(0.0, 10.0, Method::Yoshida4, &start, 200);
        assert_eq!(a.len(), b.len());
        for (i, (p, q)) in a.iter().zip(&b).enumerate() {
            assert!((p - q).abs() < 1e-6, "at {}: {} vs {}", i, p, q);
        }
    }

    /// The wire spelling, and the one thing it refuses to guess.
    #[test]
    fn a_seed_names_its_method_the_way_the_slider_does() {
        let m = solved(CIRCLE, 0.0, 6.0);
        let start = [0.0, 1.0];
        assert_eq!(
            m.trajectory_from_named(0.0, 6.0, "tsit5", &start, 32),
            m.trajectory_from(0.0, 6.0, Method::Tsit5, &start, 32)
        );
        // Not a silent default: a seed drawn with an integrator nobody chose,
        // beside curves drawn with one somebody did, is two pictures in one.
        assert!(m
            .trajectory_from_named(0.0, 6.0, "verlet5", &start, 32)
            .is_empty());
        // A first-order document has no position/velocity structure, so a
        // symplectic seed is refused exactly as a symplectic solve is.
        assert!(m
            .trajectory_from_named(0.0, 6.0, "Verlet", &start, 32)
            .is_empty());
    }

    /// Seeds work on a document that has never been solved: the field and its
    /// curves are a function of the rows, not of what happens to be stored.
    #[test]
    fn a_seed_does_not_need_a_stored_solution_first() {
        let mut m = Model::new();
        m.set_source(CIRCLE);
        assert!(m.sample(10).is_empty(), "nothing solved yet");
        let seed = m.trajectory_from(0.0, std::f64::consts::TAU, Method::Tsit5, &[1.0, 0.0], 16);
        assert_eq!(seed.len(), 48);
        // ...and it still has not stored one.
        assert!(m.sample(10).is_empty());
        assert!(m.method().is_none());
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

    // --- Leibniz notation -------------------------------------------------

    /// Every sample of one curve against every sample of the other. The claim
    /// is not "equivalent notations" but *the same system*, and the only way
    /// to say that about a differential equation is numerically.
    fn same_trajectory(a: &str, b: &str, t1: f64) {
        let (ma, mb) = (solved(a, 0.0, t1), solved(b, 0.0, t1));
        let (sa, sb) = (ma.sample(200), mb.sample(200));
        assert_eq!(sa.len(), sb.len(), "different shapes:
{}
{}", a, b);
        assert!(!sa.is_empty());
        for (i, (x, y)) in sa.iter().zip(&sb).enumerate() {
            assert_eq!(x.to_bits(), y.to_bits(), "sample {} of
{}
{}", i, a, b);
        }
    }

    #[test]
    fn a_leibniz_row_integrates_exactly_as_its_primed_twin_does() {
        same_trajectory(
            "dx/dt = -y
dy/dt = x
x(0) = 1
y(0) = 0",
            "x' = -y
y' = x
x(0) = 1
y(0) = 0",
            std::f64::consts::TAU,
        );
    }

    #[test]
    fn a_second_order_leibniz_row_integrates_exactly_as_its_primed_twin_does() {
        for leibniz in ["d2x/dt2 = -x - 0.4x'", "d^2x/dt^2 = -x - 0.4x'"] {
            same_trajectory(
                &format!("{}
x(0) = 1
x'(0) = 0", leibniz),
                "x'' = -x - 0.4x'
x(0) = 1
x'(0) = 0",
                12.0,
            );
        }
    }

    /// The reason this is more than sugar. `df/dx = 2x` with `f(0) = 0` is how
    /// you write an integral in a tool that solves differential equations, and
    /// the answer had better be `x^2`.
    #[test]
    fn an_integral_written_as_a_differential_equation_gives_the_closed_form() {
        let mut m = solved("df/dx = 2x
f(0) = 0
E = f - x^2", 0.0, 3.0);
        assert_eq!(m.document().independent, "x");
        assert_eq!(m.document().states, vec!["f".to_string()]);
        for x in [0.5, 1.0, 2.0, 2.75, 3.0] {
            let f = m.eval(x)[0];
            assert!((f - x * x).abs() < 1e-8, "f({}) = {}", x, f);
        }
        // The residual is a derived row reading the independent variable under
        // its own name, so the monitor has to bind `x` too — and it is flat at
        // zero exactly when the whole chain agrees on what `x` means.
        let c = m.conservation("E", 0);
        assert!(c.ok, "{:?}", c.error);
        assert!(c.drift.max_abs_deviation < 1e-8, "{:?}", c.drift);
    }

    /// The independent variable is a name the solver binds, so a row is
    /// entitled to read it — under whatever name the document chose.
    #[test]
    fn the_independent_variable_is_readable_inside_a_right_hand_side() {
        // `t` when `t` is what the document differentiates by.
        let m = solved("x' = t", 0.0, 2.0);
        assert!((m.eval(2.0)[0] - 2.0).abs() < 1e-9);
        // and `s` when it is not, integrating s -> s^2/2.
        let m = solved("dx/ds = s", 0.0, 2.0);
        assert_eq!(m.document().independent, "s");
        assert!((m.eval(2.0)[0] - 2.0).abs() < 1e-9);
    }

    /// One document, one horizontal axis. Neither row is the wrong one, so
    /// both are underlined and both sentences name the pair.
    #[test]
    fn mixing_independent_variables_is_an_error_naming_both_rows() {
        let errs = errors_on("dx/dt = -y
dy/ds = x");
        assert_eq!(errs.len(), 2, "{:?}", errs);
        let lines: Vec<usize> = errs.iter().map(|i| i.line).collect();
        assert_eq!(lines, vec![0, 1], "{:?}", errs);
        for e in &errs {
            assert!(e.message.contains("line 1"), "{:?}", e);
            assert!(e.message.contains("line 2"), "{:?}", e);
            assert!(e.message.contains(" t "), "{:?}", e);
            assert!(e.message.contains(" s "), "{:?}", e);
        }
        // Agreement is not a disagreement, however many rows agree.
        assert!(errors_on("dx/dt = -y
dy/dt = x").is_empty());
        // A prime asserts nothing, so it never conflicts with anything.
        assert!(errors_on("df/dx = 2y
y' = 1").is_empty());
    }

    /// The predator-prey demo's `d` is a predation rate, and it stays one. If
    /// the notation reached past the left of an `=`, `d x y` would change
    /// meaning and the model would quietly become a different one.
    #[test]
    fn d_is_still_an_ordinary_parameter() {
        let src = "a = 1
b = 0.5
c = 0.75
d = 0.25
                   x' = a x - b x y
y' = -c y + d x y
x(0) = 6
y(0) = 2";
        let diag = Model::new().set_source(src);
        assert!(diag.params.contains(&"d".to_string()), "{:?}", diag.params);
        assert_eq!(diag.independent, "t");
        assert!(diag.issues.is_empty(), "{:?}", diag.issues);
        // The same system with the parameter spelled `p` must integrate to the
        // same numbers, which is only true if `d` was read as a coefficient.
        same_trajectory(src, &src.replace('d', "p"), 12.0);
    }

    /// Both spellings of the superscript, and the notation left alone in the
    /// one place it would have to guess.
    #[test]
    fn superscripts_and_non_rows() {
        // A mismatched pair is a slip of the pen and is told so.
        let errs = errors_on("d2x/dt = -x");
        assert_eq!(errs.len(), 1, "{:?}", errs);
        assert!(errs[0].message.contains("d2x/dt"), "{:?}", errs);
        // Third order is not supported, and says so under either spelling.
        assert!(!errors_on("d3x/dt3 = -x").is_empty());
        // A name cannot be integrated against itself.
        let errs = errors_on("dx/dx = 1");
        assert_eq!(errs.len(), 1, "{:?}", errs);
        assert!(errs[0].message.contains("independent variable"), "{:?}", errs);
    }

    #[test]
    fn the_independent_variable_reaches_the_wire() {
        let json = Model::new().set_source_json("df/dx = 2x
f(0) = 0");
        assert!(json.contains(r#""independent":"x""#), "{}", json);
        // A document that never says gets the default, spelled out rather than
        // left for the shell to assume.
        let json = Model::new().set_source_json("x' = -y
y' = x");
        assert!(json.contains(r#""independent":"t""#), "{}", json);
        // Including an empty one, so the axis has a label before the first row.
        let json = Model::new().set_source_json("");
        assert!(json.contains(r#""independent":"t""#), "{}", json);
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
        assert!(json.contains("\"tEnd\":20.0"), "{}", json);
        assert!(json.contains("\"dim\":2"), "{}", json);
        assert!(json.contains("\"states\":[\"x\",\"y\"]"), "{}", json);
        assert!(json.contains("\"rhsEvals\":"), "{}", json);
        assert!(json.contains("\"error\":null"), "{}", json);
        // A run that reached the end says nothing about stopping — the key is
        // absent, not null, so `if (report.stopped)` is the whole check.
        assert!(!json.contains("\"stopped\""), "{}", json);
    }

    /// The partial run, on the wire. This is what a shell draws a curve and a
    /// caption from.
    #[test]
    fn a_partial_run_reaches_the_wire_as_ok_with_a_reason() {
        let mut m = Model::new();
        m.set_source("x' = x^2\nx(0) = 1");
        let json = m.solve_json(0.0, 5.0);
        assert!(json.contains("\"ok\":true"), "{}", json);
        assert!(json.contains("\"t1\":5.0"), "{}", json);
        assert!(json.contains("\"error\":null"), "{}", json);
        assert!(json.contains("\"tEnd\":1.000"), "{}", json);
        assert!(
            json.contains("\"stopped\":{\"reason\":\"stepTooSmall\",\"message\":\"stopped at t = 1"),
            "{}",
            json
        );

        // And a refused solve carries neither.
        m.set_source("x' = q");
        let json = m.solve_json(0.0, 5.0);
        assert!(json.contains("\"ok\":false"), "{}", json);
        assert!(!json.contains("\"stopped\""), "{}", json);
        assert!(json.contains("\"tEnd\":0.0"), "{}", json);
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
