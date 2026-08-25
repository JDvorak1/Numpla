//! Velocity Verlet and Yoshida 4 — the structure-preserving pair.
//!
//! These exist for a reason that has nothing to do with accuracy per unit work,
//! which is the axis Tsit5 wins on. They exist because of the negative result
//! in `docs/solvers.md`: **a fixed-step integrator cannot simultaneously
//! preserve the symplectic form, momentum, and energy** for a non-integrable
//! system (Ge–Marsden). Something has to give, and *which* thing gives is the
//! most useful piece of intuition this software can hand someone. Tsit5 gives
//! up all three and buys accuracy over a short run; these two keep the
//! symplectic form and momentum, and let energy wobble in a band that never
//! grows. Same system, two integrators, two different lies — visible on a
//! single plot, with no explanatory text needed.
//!
//! Both methods are fixed step, and both need the system in second-order form
//! `q'' = a(t, q)`. See [`SecondOrderSystem`] for why that is a separate trait
//! and how a lowered first-order system gets back to it.
//!
//! ## Dense output
//!
//! Not optional here either. A fixed-step method has no stage tableau to
//! interpolate, but a second-order system hands over something better: at both
//! ends of a step we hold the position *and* the velocity, and the velocity is
//! the position's derivative. Two values and two slopes is exactly what a cubic
//! Hermite wants, so the continuous extension is free and its `O(dt^4)` error
//! matches Yoshida4's global order instead of degrading it. `Solution::eval`
//! cannot tell which method produced the step it lands in.
//!
//! ## Yoshida's coefficients, derived
//!
//! Velocity Verlet's map `S(h)` is *symmetric*: `S(-h) = S(h)^-1`. Compose the
//! triple jump
//!
//! ```text
//!     Y(h) = S(w1 h) . S(w0 h) . S(w1 h)
//! ```
//!
//! Two conditions pin the weights down.
//!
//! 1. **Consistency** — the substeps must add up to the step: `2 w1 + w0 = 1`.
//! 2. **Third order** — a palindromic composition of a symmetric method is
//!    itself symmetric, and a symmetric method's error expansion contains only
//!    odd powers of `h`, so its order is always even. Kill the `h^3` term and
//!    order 3 is order 4 for free. That term's coefficient is
//!    `2 w1^3 + w0^3`, so the condition is `2 w1^3 + w0^3 = 0`.
//!
//! Substituting `c = 2^(1/3)` and trying `w1 = 1/(2 - c)`, `w0 = -c/(2 - c)`:
//! condition 1 gives `(2 - c)/(2 - c) = 1`, and condition 2 gives
//! `(2 - c^3)/(2 - c)^3 = (2 - 2)/(2 - c)^3 = 0`. Both hold exactly, which is
//! the derivation. Numerically `w1 = 1.3512071919596578` and
//! `w0 = -1.7024143839193155` — note `w0` is negative and `|w0| > 1`, so the
//! middle substep steps *backwards*, further than the whole step goes forwards.
//! That is what the cancellation costs, and the reason a naive implementation
//! that clamps step signs quietly turns Yoshida4 back into a second-order
//! method. Both conditions are asserted as tests below, because a mistyped
//! digit in `w1` shows up as order 2 and nowhere else.

use crate::solution::{Solution, StopReason, Step, StepRecord, Telemetry};
use crate::system::SecondOrderSystem;
use crate::tsit5::{Opts, SolveError};

/// The outer weight of the triple jump: `1 / (2 - 2^(1/3))`.
pub const W1: f64 = 1.351_207_191_959_657_8;
/// The middle weight, `-2^(1/3) / (2 - 2^(1/3))`, written as the consistency
/// condition solves for it so that `2*W1 + W0` is exactly 1 in floating point.
/// A step that does not cover its own span is a first-order error; the
/// third-order condition it also satisfies only needs to hold to round-off.
pub const W0: f64 = 1.0 - 2.0 * W1;

/// When `Opts::dt0` is absent, a fixed-step method takes the span divided by
/// this. Erroring instead would be defensible in a library and wrong in this
/// product: the mode slider must be able to swap Tsit5 for Verlet under a
/// running plot without the plot going blank, and a step tied to the visible
/// span is the same instinct that makes `dt_max` follow the time window.
const DEFAULT_STEPS_PER_SPAN: f64 = 1000.0;

/// Velocity Verlet: kick, drift, kick. Second order, symplectic, and time
/// reversible.
pub fn solve_verlet<S: SecondOrderSystem>(
    sys: &S,
    t_span: (f64, f64),
    y0: &[f64],
    opts: &Opts,
) -> Result<Solution, SolveError> {
    solve_composition(sys, t_span, y0, opts, &[1.0])
}

/// Yoshida's fourth-order triple jump of velocity Verlet. Still symplectic —
/// a composition of symplectic maps is symplectic — at three times the cost of
/// Verlet and two orders more accuracy.
pub fn solve_yoshida4<S: SecondOrderSystem>(
    sys: &S,
    t_span: (f64, f64),
    y0: &[f64],
    opts: &Opts,
) -> Result<Solution, SolveError> {
    solve_composition(sys, t_span, y0, opts, &[W1, W0, W1])
}

/// Working buffers for one integration. Named rather than inlined because the
/// substep needs five vectors and passing them individually made the signature
/// unreadable.
struct Work {
    q: Vec<f64>,
    v: Vec<f64>,
    /// Acceleration at the current `(t, q, v)` — carried across substeps
    /// because the second kick's evaluation is already the next substep's
    /// first, the second-order analogue of FSAL.
    a: Vec<f64>,
    /// Velocity estimate for the iterated kick, used only when the
    /// acceleration reads velocities.
    v_try: Vec<f64>,
}

/// One velocity-Verlet substep of length `h`, in place.
///
/// On entry `w.a` holds `a(t, q, v)`; on exit it holds the acceleration at the
/// far end of the substep, which is the next substep's starting value. Returns
/// the number of acceleration evaluations it spent.
fn substep<S: SecondOrderSystem>(sys: &S, t: f64, h: f64, w: &mut Work) -> usize {
    let n = w.q.len();
    let mut evals = 0;

    // A velocity-dependent acceleration invalidates the carried value: it was
    // evaluated at the half-step velocity, not at the one we now hold.
    if sys.reads_velocity() {
        sys.accel(t, &w.q, &w.v, &mut w.a);
        evals += 1;
    }

    // Kick: v becomes the half-step velocity.
    for i in 0..n {
        w.v[i] += 0.5 * h * w.a[i];
    }
    // Drift.
    for i in 0..n {
        w.q[i] += h * w.v[i];
    }
    // Kick again. For a conservative force this evaluation is exact — the
    // acceleration does not care that `v` is a half-step value — which is why
    // the method costs one evaluation per step and is symplectic.
    sys.accel(t + h, &w.q, &w.v, &mut w.a);
    evals += 1;

    if sys.reads_velocity() {
        // With damping the second kick's force depends on the velocity it is
        // computing, and using the half-step value would leave an O(dt^2) local
        // error — silently dropping the method to first order. One fixed-point
        // iteration restores second order. Symplecticity is already gone here;
        // this is only about not lying about the order.
        for i in 0..n {
            w.v_try[i] = w.v[i] + 0.5 * h * w.a[i];
        }
        sys.accel(t + h, &w.q, &w.v_try, &mut w.a);
        evals += 1;
    }

    for i in 0..n {
        w.v[i] += 0.5 * h * w.a[i];
    }
    evals
}

/// The shared driver. `weights` are the substep fractions of one outer step:
/// `[1]` is plain Verlet, `[W1, W0, W1]` is Yoshida4, and adding a
/// higher-order composition later means adding a coefficient list and nothing
/// else.
fn solve_composition<S: SecondOrderSystem>(
    sys: &S,
    t_span: (f64, f64),
    y0: &[f64],
    opts: &Opts,
    weights: &[f64],
) -> Result<Solution, SolveError> {
    let dof = sys.dof();
    let dim = 2 * dof;
    if y0.len() != dim {
        return Err(SolveError::DimensionMismatch {
            expected: dim,
            got: y0.len(),
        });
    }

    let (t0, t1) = t_span;
    let mut telemetry = Telemetry::default();
    let mut steps: Vec<Step> = Vec::new();

    if t1 <= t0 {
        return Ok(Solution {
            steps,
            telemetry,
            y_end: y0.to_vec(),
            t_end: t0,
            stopped: None,
        });
    }

    let dt_fixed = opts
        .dt0
        .unwrap_or((t1 - t0) / DEFAULT_STEPS_PER_SPAN)
        .min(opts.dt_max)
        .min(t1 - t0);
    // A hard error rather than a stop: the step was unusable before the first
    // evaluation, so unlike a step that *collapses* mid-run there is no partial
    // trajectory to hand back. Somebody passed `dt0: Some(0.0)`.
    if !dt_fixed.is_finite() || dt_fixed <= 0.0 {
        return Err(SolveError::InvalidStep { dt: dt_fixed });
    }

    let mut w = Work {
        q: (0..dof).map(|i| y0[2 * i]).collect(),
        v: (0..dof).map(|i| y0[2 * i + 1]).collect(),
        a: vec![0.0; dof],
        v_try: vec![0.0; dof],
    };
    sys.accel(t0, &w.q, &w.v, &mut w.a);
    telemetry.rhs_evals += 1;

    // The interleaved state and its derivative at the start of the step. Both
    // ends of each step are needed for the Hermite extension, and the start of
    // one step is the end of the last, so they are carried rather than rebuilt.
    let mut y = y0.to_vec();
    let mut f = vec![0.0; dim];
    for i in 0..dof {
        f[2 * i] = w.v[i];
        f[2 * i + 1] = w.a[i];
    }

    // How many steps, decided up front rather than by accumulating `t` and
    // asking whether it has arrived. Accumulation leaves a final sliver of a
    // few ulps and takes a whole extra step to cover it — arithmetic reported
    // as physics, which is the same bug the Tsit5 driver has a regression test
    // for. A step index also keeps `t` from drifting over a hundred thousand
    // additions.
    let raw = (t1 - t0) / dt_fixed;
    let n_steps = if (raw - raw.round()).abs() < 1e-9 * raw.max(1.0) {
        raw.round()
    } else {
        raw.ceil()
    } as usize;

    // A budget too small for the span is not a refusal to run: take as many
    // steps as the budget allows and report where that left off. Same rule as
    // a blowup — an answer that covers less time beats no answer at all. The
    // step itself is *not* enlarged to fit the budget, because a symplectic
    // method's guarantee is about one map applied repeatedly and silently
    // coarsening it would trade a short honest run for a long misleading one.
    let mut stopped: Option<StopReason> = None;
    let n_run = if n_steps > opts.max_steps {
        stopped = Some(StopReason::TooManySteps);
        opts.max_steps
    } else {
        n_steps
    };

    // Then the step actually used is the span divided by that count: the
    // largest step no bigger than the one asked for that divides the span
    // evenly. The alternative — full steps and a short one at the end — is
    // worse than it looks, because a symplectic method's guarantee is about
    // *one map applied repeatedly*. Change the step for a single step and that
    // step is a different map, which shows up as a one-off jump in the energy
    // that no amount of further integration undoes. Shrinking every step
    // slightly instead keeps the run uniform and still lands exactly on `t1`.
    let dt = (t1 - t0) / n_steps as f64;

    // Where the run actually reached. Advanced only by a step that completed,
    // so a step that produces a non-finite state leaves this at the last time
    // the state was still a number.
    let mut t_reached = t0;

    for step in 0..n_run {
        let t = t0 + step as f64 * dt;
        // The last step is stretched by a few ulps so that `t + dt` is exactly
        // `t1`: a scrubber dragged to the right-hand edge must find something
        // there, and an interpolant whose domain stops a hair short of the end
        // would leave a gap for the binary search to fall into.
        // `n_steps`, not `n_run`: a run cut short by the step budget never
        // reaches its last step, and stretching some earlier step to land on
        // `t1` would claim a span it did not integrate.
        let dt = if step + 1 == n_steps { t1 - t } else { dt };

        let mut t_sub = t;
        for &weight in weights {
            let h = weight * dt;
            telemetry.rhs_evals += substep(sys, t_sub, h, &mut w);
            t_sub += h;
        }

        if w.q.iter().chain(w.v.iter()).any(|x| !x.is_finite()) {
            // `y` is still the state at the start of this step — the last one
            // that was finite — and it has not been moved into a `Step` yet.
            stopped = Some(StopReason::NonFinite);
            break;
        }

        let mut y_end = vec![0.0; dim];
        let mut f_end = vec![0.0; dim];
        for i in 0..dof {
            y_end[2 * i] = w.q[i];
            y_end[2 * i + 1] = w.v[i];
            f_end[2 * i] = w.v[i];
            // `w.a` is the acceleration at the far end of the last substep, so
            // for a conservative force this is exactly `y'` there.
            f_end[2 * i + 1] = w.a[i];
        }

        // `y` and `f` are moved into the step and immediately replaced by the
        // far end, which is the next step's near end. Two vectors per step, not
        // four.
        steps.push(Step::hermite(t, dt, y, y_end.clone(), f, f_end.clone()));
        telemetry.accepted += 1;
        // A fixed-step method has no embedded estimate, so there is no error to
        // report — the honest value is zero, not a fabricated one. What the
        // telemetry strip shows for these methods is a flat line, which is the
        // truth about them.
        telemetry.steps.push(StepRecord {
            t,
            dt,
            error: 0.0,
            accepted: true,
        });

        y = y_end;
        f = f_end;
        t_reached = t + dt;
    }

    Ok(Solution {
        steps,
        telemetry,
        y_end: y,
        // `dt_fixed` is capped at the span, so a run that took all its steps
        // finished on `t1` exactly — the last step is stretched by a few ulps
        // above to guarantee it. A run that stopped short reports where it got.
        t_end: if stopped.is_none() { t1 } else { t_reached },
        stopped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conserve::measure;
    use crate::solution::StopReason;
    use crate::system::{Accel, AccelFn, Lowered, Paired, System};
    use crate::tsit5;
    use std::f64::consts::TAU;

    /// One of the fixed-step solvers, as a value — so that a test can be
    /// written once and run against both.
    type Solver = fn(&Accel<AccelFn>, (f64, f64), &[f64], &Opts) -> Result<Solution, SolveError>;

    /// `q'' = -q`: the harmonic oscillator, whose solution is a circle in phase
    /// space and whose energy `(q^2 + v^2)/2` is exactly constant.
    fn spring() -> Accel<AccelFn> {
        Accel::new(1, |_t, q: &[f64], _v: &[f64], a: &mut [f64]| a[0] = -q[0])
    }

    fn energy(y: &[f64]) -> f64 {
        0.5 * (y[0] * y[0] + y[1] * y[1])
    }

    fn fixed(dt: f64) -> Opts {
        Opts {
            dt0: Some(dt),
            max_steps: 10_000_000,
            ..Default::default()
        }
    }

    // --- the coefficients ------------------------------------------------

    /// The derivation in the module header, as arithmetic. Getting `W1` wrong
    /// in the last few digits leaves everything running and silently drops
    /// Yoshida4 to second order.
    #[test]
    fn yoshida_weights_satisfy_their_two_conditions() {
        assert_eq!(2.0 * W1 + W0, 1.0, "the substeps must cover the step");
        assert!(
            (2.0 * W1.powi(3) + W0.powi(3)).abs() < 1e-14,
            "third-order term not cancelled: {}",
            2.0 * W1.powi(3) + W0.powi(3)
        );
        // And the closed forms they came from.
        let c = 2f64.powf(1.0 / 3.0);
        assert!((W1 - 1.0 / (2.0 - c)).abs() < 1e-15);
        assert!((W0 + c / (2.0 - c)).abs() < 1e-15);
    }

    // --- order of accuracy -----------------------------------------------

    /// Halve the step, watch the error fall by `2^order`. This is the sharpest
    /// available check that the composition is right: a wrong Yoshida weight
    /// shows up here as a ratio near 4 instead of near 16.
    fn error_ratio(solve: Solver, dt: f64) -> f64 {
        let sys = spring();
        let t_end = 10.0;
        let err = |dt: f64| {
            let sol = solve(&sys, (0.0, t_end), &[1.0, 0.0], &fixed(dt)).unwrap();
            (sol.y_end[0] - t_end.cos()).abs() + (sol.y_end[1] + t_end.sin()).abs()
        };
        err(dt) / err(dt / 2.0)
    }

    #[test]
    fn verlet_is_second_order() {
        let r = error_ratio(solve_verlet, 0.02);
        assert!((r - 4.0).abs() < 0.2, "error ratio {} is not 4", r);
    }

    #[test]
    fn yoshida4_is_fourth_order() {
        let r = error_ratio(solve_yoshida4, 0.1);
        assert!((r - 16.0).abs() < 1.0, "error ratio {} is not 16", r);
    }

    #[test]
    fn yoshida4_is_far_more_accurate_than_verlet_at_the_same_step() {
        let end = |solve: Solver| {
            let sol = solve(&spring(), (0.0, 10.0), &[1.0, 0.0], &fixed(0.05)).unwrap();
            (sol.y_end[0] - 10f64.cos()).abs()
        };
        assert!(end(solve_yoshida4) < 1e-2 * end(solve_verlet));
    }

    // --- symplecticity ----------------------------------------------------

    /// Symplecticity, concretely. For a linear system the one-step map is a
    /// matrix, and preserving the symplectic form means (in one degree of
    /// freedom) preserving area: `det = 1` exactly, not approximately. The
    /// columns of the matrix are the map applied to the basis vectors.
    fn one_step_determinant(solve: Solver, dt: f64) -> f64 {
        let sys = spring();
        let col = |y0: [f64; 2]| solve(&sys, (0.0, dt), &y0, &fixed(dt)).unwrap().y_end;
        let c0 = col([1.0, 0.0]);
        let c1 = col([0.0, 1.0]);
        c0[0] * c1[1] - c1[0] * c0[1]
    }

    #[test]
    fn verlet_preserves_phase_space_area_exactly() {
        let d = one_step_determinant(solve_verlet, 0.37);
        assert!((d - 1.0).abs() < 1e-15, "det = {}", d);
    }

    #[test]
    fn yoshida4_preserves_phase_space_area_exactly() {
        let d = one_step_determinant(solve_yoshida4, 0.37);
        assert!((d - 1.0).abs() < 1e-14, "det = {}", d);
    }

    /// Tsit5 does not, and is not trying to. Included so the contrast is a
    /// measurement rather than an assertion in a doc comment.
    #[test]
    fn tsit5_does_not_preserve_phase_space_area() {
        let sys = Lowered::new(spring());
        let opts = Opts {
            dt0: Some(0.37),
            dt_max: 0.37,
            rtol: 1e-3,
            atol: 1e-6,
            ..Default::default()
        };
        let col = |y0: [f64; 2]| {
            tsit5::solve(&sys, (0.0, 0.37), &y0, &opts)
                .unwrap()
                .y_end
        };
        let c0 = col([1.0, 0.0]);
        let c1 = col([0.0, 1.0]);
        let d = c0[0] * c1[1] - c1[0] * c0[1];
        assert!((d - 1.0).abs() > 1e-12, "det = {}, suspiciously exact", d);
    }

    // --- the headline property -------------------------------------------

    /// **This is the whole reason both methods ship.**
    ///
    /// Over two thousand periods of a harmonic oscillator, Verlet's energy
    /// error oscillates inside a band it never leaves — the band is set by the
    /// step size, not by the elapsed time — while Tsit5's, for all that it is
    /// three orders more accurate per step, walks steadily away from the truth
    /// and keeps walking. The test compares the deviation band in the first
    /// tenth of the run against the last tenth: Verlet's two bands are the same
    /// size, Tsit5's last is far worse than its first.
    ///
    /// That contrast is the pedagogical point of the mode slider. It is a
    /// theorem about what a fixed-step method can preserve (Ge–Marsden, see
    /// `docs/solvers.md`), not a quality difference between two libraries, and
    /// it is the single most useful thing a plot of a long run can teach.
    #[test]
    fn verlet_energy_stays_in_a_band_while_tsit5_drifts_away() {
        let periods = 2000.0;
        let span = (0.0, periods * TAU);
        let y0 = [1.0, 0.0];

        let verlet = solve_verlet(&spring(), span, &y0, &fixed(0.2)).unwrap();
        let tsit5 = tsit5::solve(&Lowered::new(spring()), span, &y0, &Opts::default()).unwrap();

        // Ten samples per period. Sampling any coarser aliases the energy's own
        // oscillation and reports a band that depends on the sample phase — see
        // the note in `conserve.rs`, which this test is the reason for.
        let samples = 10 * periods as usize;
        let v = measure(&verlet, samples, |_t, y| energy(y));
        let s = measure(&tsit5, samples, |_t, y| energy(y));

        // Verlet: the band in the last tenth is the same size as in the first.
        let (v_first, v_last) = (v.band(0.0, 0.1), v.band(0.9, 1.0));
        assert!(
            v_last < 1.5 * v_first && v_first > 0.0,
            "Verlet energy band grew: {} -> {}",
            v_first,
            v_last
        );

        // Tsit5: the deviation in the last tenth dwarfs the first. Its per-step
        // accuracy is not in question — its total drift is. Ten is the ceiling
        // for a drift growing linearly in `t` (the last tenth ends at `T`, the
        // first at `T/10`), so anything well above 1 is the signature.
        let (s_first, s_last) = (s.band(0.0, 0.1), s.band(0.9, 1.0));
        assert!(
            s_last > 5.0 * s_first,
            "expected Tsit5 to drift, got {} -> {}",
            s_first,
            s_last
        );

        // And the drift is secular, not noise: taken a tenth of the run at a
        // time, Tsit5's band grows every time while Verlet's never does. A plot
        // of these two rows of numbers *is* the conservation monitor.
        let deciles = |c: &crate::conserve::Conservation| -> Vec<f64> {
            (0..10)
                .map(|i| c.band(i as f64 / 10.0, (i + 1) as f64 / 10.0))
                .collect()
        };
        let (dv, ds) = (deciles(&v), deciles(&s));
        assert!(
            ds.windows(2).all(|w| w[1] > w[0]),
            "Tsit5's energy error should grow every tenth: {:?}",
            ds
        );
        assert!(
            dv.windows(2).all(|w| w[1] < 1.5 * w[0]),
            "Verlet's energy band should not grow: {:?}",
            dv
        );
    }

    // --- the Kepler problem ----------------------------------------------

    /// `q'' = -q / |q|^3` in the plane: the classic demonstration, because an
    /// eccentric orbit punishes any method that leaks energy — the orbit either
    /// stays closed or visibly spirals.
    fn kepler() -> Accel<AccelFn> {
        Accel::new(2, |_t, q: &[f64], _v: &[f64], a: &mut [f64]| {
            let r2 = q[0] * q[0] + q[1] * q[1];
            let r3 = r2 * r2.sqrt();
            a[0] = -q[0] / r3;
            a[1] = -q[1] / r3;
        })
    }

    /// Eccentricity 0.5, semi-major axis 1, so the period is `2*pi` and the
    /// energy is exactly `-1/2`.
    fn kepler_start(e: f64) -> [f64; 4] {
        [1.0 - e, 0.0, 0.0, ((1.0 + e) / (1.0 - e)).sqrt()]
    }

    fn kepler_energy(y: &[f64]) -> f64 {
        let r = (y[0] * y[0] + y[2] * y[2]).sqrt();
        0.5 * (y[1] * y[1] + y[3] * y[3]) - 1.0 / r
    }

    /// Angular momentum `q x v`. A symplectic integrator applied to a central
    /// force preserves it *exactly*, not approximately — this is Noether at the
    /// discrete level, and it is the momentum half of the Ge–Marsden trade.
    fn kepler_momentum(y: &[f64]) -> f64 {
        y[0] * y[3] - y[2] * y[1]
    }

    #[test]
    fn verlet_keeps_an_eccentric_orbit_closed_where_an_rk2_of_the_same_order_spirals() {
        let y0 = kepler_start(0.5);
        let dt = 0.02;
        let span = (0.0, 200.0 * TAU);

        let sol = solve_verlet(&kepler(), span, &y0, &fixed(dt)).unwrap();
        let sym = measure(&sol, 5000, |_t, y| kepler_energy(y));

        // Explicit midpoint: second order, like Verlet, and not symplectic.
        // Same order and same step, so the only difference under test is
        // structure. Written here rather than shipped because a method without
        // dense output has no business in this crate.
        let lowered = Lowered::new(kepler());
        let n = ((span.1 - span.0) / dt).round() as usize;
        let mut y = y0.to_vec();
        let (mut k1, mut k2, mut mid) = (vec![0.0; 4], vec![0.0; 4], vec![0.0; 4]);
        let mut rk2_worst: f64 = 0.0;
        for step in 0..n {
            let t = span.0 + step as f64 * dt;
            lowered.rhs(t, &y, &mut k1);
            for i in 0..4 {
                mid[i] = y[i] + 0.5 * dt * k1[i];
            }
            lowered.rhs(t + 0.5 * dt, &mid, &mut k2);
            for i in 0..4 {
                y[i] += dt * k2[i];
            }
            rk2_worst = rk2_worst.max((kepler_energy(&y) - kepler_energy(&y0)).abs());
        }

        assert!(
            sym.max_abs_deviation < 0.1 * rk2_worst,
            "Verlet {} vs RK2 {}",
            sym.max_abs_deviation,
            rk2_worst
        );
        // Closed, not merely better on average: the energy band is the same
        // width at the end of two hundred orbits as at the start, and narrow
        // enough that the semi-major axis a = -1/(2E) moves by a tenth of a
        // percent.
        assert!(sym.secular_ratio() < 1.05, "band grew: {}", sym.secular_ratio());
        assert!(
            sym.relative_drift < 0.01,
            "orbit not closed: {}",
            sym.relative_drift
        );

        // Angular momentum is the *exactly* preserved quantity here: a
        // symplectic method applied to a central force conserves it to
        // round-off, over any number of orbits. Measured at the step points
        // rather than through `measure`, because the Hermite interpolant is an
        // approximation living between them and does not inherit the property —
        // a distinction worth knowing before plotting a conservation monitor
        // and wondering where the 1e-7 came from.
        let l0 = kepler_momentum(&y0);
        let worst = sol
            .steps
            .iter()
            .fold(0.0f64, |acc, s| acc.max((kepler_momentum(&s.y) - l0).abs()));
        assert!(worst < 1e-12, "angular momentum drifted by {}", worst);
    }

    #[test]
    fn yoshida4_beats_verlet_on_kepler_at_the_same_step() {
        let y0 = kepler_start(0.5);
        let span = (0.0, 20.0 * TAU);
        let dt = 0.02;
        let dev = |sol: &Solution| measure(sol, 2000, |_t, y| kepler_energy(y)).max_abs_deviation;
        let v = dev(&solve_verlet(&kepler(), span, &y0, &fixed(dt)).unwrap());
        let y = dev(&solve_yoshida4(&kepler(), span, &y0, &fixed(dt)).unwrap());
        assert!(y < 0.01 * v, "Yoshida4 {} vs Verlet {}", y, v);
    }

    // --- dense output ------------------------------------------------------

    #[test]
    fn dense_output_is_accurate_between_step_points() {
        // Coarse steps and a sample count coprime to them, so almost every
        // query lands strictly inside a step and the interpolant is doing real
        // work rather than hiding behind a dense set of nodes. The tolerance is
        // set by the cubic Hermite's O(dt^4), which is Yoshida4's own order —
        // dense output that degraded the method would be no use.
        let sol = solve_yoshida4(&spring(), (0.0, 10.0), &[1.0, 0.0], &fixed(0.05)).unwrap();
        for i in 0..=997 {
            let t = 10.0 * (i as f64) / 997.0;
            let y = sol.eval(t);
            assert!(
                (y[0] - t.cos()).abs() < 1e-5 && (y[1] + t.sin()).abs() < 1e-5,
                "at t={}: got {:?}, want [{}, {}]",
                t,
                y,
                t.cos(),
                -t.sin()
            );
        }
    }

    #[test]
    fn dense_output_is_continuous_across_step_boundaries() {
        let sol = solve_verlet(&spring(), (0.0, 20.0), &[1.0, 0.0], &fixed(0.1)).unwrap();
        for w in sol.steps.windows(2) {
            let end = sol.eval(w[1].t);
            for i in 0..2 {
                assert!(
                    (end[i] - w[1].y[i]).abs() < 1e-12,
                    "discontinuity at t={}",
                    w[1].t
                );
            }
        }
    }

    /// The interpolant must reproduce the step's own endpoints exactly, or
    /// scrubbing to a node and scrubbing to a hair either side of it would
    /// disagree.
    #[test]
    fn the_interpolant_hits_both_ends_of_its_step() {
        let sol = solve_verlet(&spring(), (0.0, 3.0), &[1.0, 0.5], &fixed(0.1)).unwrap();
        let mut out = vec![0.0; 2];
        for (i, step) in sol.steps.iter().enumerate() {
            step.eval_theta_into(0.0, &mut out);
            assert_eq!(out, step.y);
            step.eval_theta_into(1.0, &mut out);
            let want = sol
                .steps
                .get(i + 1)
                .map(|s| s.y.clone())
                .unwrap_or_else(|| sol.y_end.clone());
            for j in 0..2 {
                assert!((out[j] - want[j]).abs() < 1e-14);
            }
        }
    }

    // --- housekeeping -----------------------------------------------------

    #[test]
    fn integration_ends_exactly_on_the_requested_time() {
        // A step size that does not divide the span: the last step is short.
        let sol = solve_verlet(&spring(), (0.0, 3.7), &[1.0, 0.0], &fixed(0.3)).unwrap();
        assert!((sol.t_end - 3.7).abs() < 1e-12);
        assert!((sol.y_end[0] - 3.7f64.cos()).abs() < 1e-2);
    }

    #[test]
    fn a_missing_step_size_falls_back_to_the_span_rather_than_failing() {
        // Switching method on the slider must not blank the plot.
        let sol = solve_verlet(&spring(), (0.0, 10.0), &[1.0, 0.0], &Opts::default()).unwrap();
        assert_eq!(sol.steps.len(), 1000);
        assert!((sol.y_end[0] - 10f64.cos()).abs() < 1e-4);
    }

    #[test]
    fn telemetry_reports_every_step() {
        let sol = solve_verlet(&spring(), (0.0, 1.0), &[1.0, 0.0], &fixed(0.01)).unwrap();
        let t = &sol.telemetry;
        assert_eq!(t.accepted, sol.steps.len());
        assert_eq!(t.rejected, 0);
        assert_eq!(t.steps.len(), t.accepted);
        assert!(t.steps.iter().all(|s| s.accepted));
        // One acceleration per step for a conservative force, plus the one that
        // primes the loop.
        assert_eq!(t.rhs_evals, t.accepted + 1);
    }

    #[test]
    fn dimension_mismatch_is_caught() {
        let r = solve_verlet(&spring(), (0.0, 1.0), &[1.0], &Opts::default());
        assert_eq!(
            r.unwrap_err(),
            SolveError::DimensionMismatch {
                expected: 2,
                got: 1
            }
        );
    }

    #[test]
    fn an_empty_span_returns_the_initial_state() {
        let sol = solve_verlet(&spring(), (2.0, 2.0), &[1.0, 0.0], &fixed(0.1)).unwrap();
        assert_eq!(sol.y_end, vec![1.0, 0.0]);
        assert_eq!(sol.t_end, 2.0);
        assert_eq!(sol.eval(2.0), vec![1.0, 0.0]);
    }

    /// A fixed-step method has no error estimate to warn it, so it walks into a
    /// finite-time escape and only finds out when the numbers stop being
    /// numbers. It must still hand back everything up to that point.
    #[test]
    fn a_blown_up_trajectory_still_returns_the_part_that_was_finite() {
        let runaway: AccelFn = |_t, q, _v, a| a[0] = q[0] * q[0] * q[0] * 1e6;
        let sys = Accel::new(1, runaway);
        let sol = solve_verlet(&sys, (0.0, 10.0), &[1.0, 0.0], &fixed(0.01)).unwrap();
        assert_eq!(sol.stopped, Some(StopReason::NonFinite));
        assert!(sol.t_end > 0.0 && sol.t_end < 10.0, "{}", sol.t_end);
        assert!(sol.y_end.iter().all(|v| v.is_finite()));
        // The scrubber can be dragged anywhere in the requested window and
        // always lands on a real number.
        assert!(sol.sample(300).iter().all(|y| y.iter().all(|v| v.is_finite())));
    }

    /// A step budget smaller than the span the fixed step needs. The step is
    /// *not* coarsened to fit — a symplectic method's guarantee is about one map
    /// applied repeatedly — so the run covers less time and says so.
    #[test]
    fn a_spent_step_budget_shortens_the_run_rather_than_failing_it() {
        let opts = Opts {
            dt0: Some(1e-3),
            max_steps: 10,
            ..Default::default()
        };
        let sol = solve_verlet(&spring(), (0.0, 1.0), &[1.0, 0.0], &opts).unwrap();
        assert_eq!(sol.stopped, Some(StopReason::TooManySteps));
        assert_eq!(sol.steps.len(), 10);
        assert!((sol.t_end - 0.01).abs() < 1e-12, "{}", sol.t_end);
        // Ten Verlet steps of a millisecond each are still an accurate cosine.
        assert!((sol.y_end[0] - 0.01f64.cos()).abs() < 1e-8);
        assert!(sol.require_complete().is_err());
    }

    /// Not a stop but a hard error: a step of zero was never going to integrate
    /// anything, so there is no partial trajectory to keep.
    #[test]
    fn an_unusable_fixed_step_is_a_hard_error() {
        let r = solve_verlet(&spring(), (0.0, 1.0), &[1.0, 0.0], &fixed(0.0));
        assert_eq!(r.unwrap_err(), SolveError::InvalidStep { dt: 0.0 });
    }

    #[test]
    fn an_ordinary_fixed_step_run_reports_no_stop_reason() {
        let sol = solve_yoshida4(&spring(), (0.0, 3.0), &[1.0, 0.0], &fixed(0.01)).unwrap();
        assert!(sol.is_complete());
        assert_eq!(sol.t_end, 3.0);
    }

    // --- reaching the methods from a lowered document ---------------------

    /// The path `numpla-model` will take: it produces a first-order system with
    /// position/velocity pairs, and that must be integrable by a symplectic
    /// method without anyone re-typing the physics.
    #[test]
    fn a_lowered_first_order_system_can_be_integrated_symplectically() {
        // Exactly what `x'' = -x` compiles to: state 0 is x, state 1 is x'.
        let doc = crate::system::Field::new(2, |_t, y: &[f64], dy: &mut [f64]| {
            dy[0] = y[1];
            dy[1] = -y[0];
        });
        let sys = Paired::new(doc, &[(0, 1)]).unwrap();
        let sol = solve_verlet(&sys, (0.0, TAU), &[1.0, 0.0], &fixed(0.001)).unwrap();
        assert!((sol.y_end[0] - 1.0).abs() < 1e-6, "{:?}", sol.y_end);
        assert!(sol.y_end[1].abs() < 1e-6, "{:?}", sol.y_end);
    }

    /// A damped row is the case the `v` argument exists for. It has no
    /// conserved energy to preserve, so all that is claimed is that the method
    /// stays second order — which the iterated kick is there to guarantee, and
    /// which a naive velocity-Verlet would quietly fail.
    #[test]
    fn a_velocity_dependent_acceleration_stays_second_order() {
        let damped: AccelFn = |_t, q, v, a| a[0] = -q[0] - 0.4 * v[0];
        let sys = Accel::new(1, damped).reading_velocity();
        // x'' = -x - 0.4x', x(0) = 1, x'(0) = 0. Underdamped: the closed form
        // is exp(-0.2 t) (cos(w t) + (0.2/w) sin(w t)) with w = sqrt(1 - 0.04).
        let w = (1.0f64 - 0.04).sqrt();
        let exact = |t: f64| (-0.2 * t).exp() * ((w * t).cos() + 0.2 / w * (w * t).sin());
        let err = |dt: f64| {
            let sol = solve_verlet(&sys, (0.0, 10.0), &[1.0, 0.0], &fixed(dt)).unwrap();
            (sol.y_end[0] - exact(10.0)).abs()
        };
        let r = err(0.02) / err(0.01);
        assert!((r - 4.0).abs() < 0.3, "error ratio {} is not 4", r);
    }
}
