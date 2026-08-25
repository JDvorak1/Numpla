//! Tsitouras 5(4) — the non-stiff default.
//!
//! Chosen over Dormand–Prince: same six evaluations per step and comparable
//! stability, but a leading error coefficient roughly an order of magnitude
//! smaller. Free accuracy at identical cost.
//!
//! FSAL, so the seventh stage becomes the next step's first — six right-hand
//! side evaluations per accepted step, seven per rejected one.
//!
//! Ships a fourth-order continuous extension. That is not a bonus feature here:
//! Numpla scrubs time, so a method without dense output could not be used at
//! all. See `docs/solvers.md`.

use crate::solution::{Solution, StopReason, Step, StepRecord, Telemetry};
use crate::system::System;

pub const STAGES: usize = 7;
const ORDER: f64 = 5.0;

// Nodes
const C2: f64 = 0.161;
const C3: f64 = 0.327;
const C4: f64 = 0.9;
const C5: f64 = 0.980_025_540_904_509_7;

// Stage coefficients
const A21: f64 = 0.161;
const A31: f64 = -0.008_480_655_492_356_989;
const A32: f64 = 0.335_480_655_492_357;
const A41: f64 = 2.897_153_057_105_493_5;
const A42: f64 = -6.359_448_489_975_075;
const A43: f64 = 4.362_295_432_869_581_5;
const A51: f64 = 5.325_864_828_439_257;
const A52: f64 = -11.748_883_564_062_828;
const A53: f64 = 7.495_539_342_889_836_5;
const A54: f64 = -0.092_495_066_361_755_25;
const A61: f64 = 5.861_455_442_946_42;
const A62: f64 = -12.920_969_317_847_11;
const A63: f64 = 8.159_367_898_576_159;
const A64: f64 = -0.071_584_973_281_401;
const A65: f64 = -0.028_269_050_394_068_383;

// Fifth-order weights (also the seventh stage row — FSAL).
const B1: f64 = 0.096_460_766_818_065_23;
const B2: f64 = 0.01;
const B3: f64 = 0.479_889_650_414_499_6;
const B4: f64 = 1.379_008_574_103_742;
const B5: f64 = -3.290_069_515_436_081;
const B6: f64 = 2.324_710_524_099_774;

// Difference between the fifth- and fourth-order weights: the error estimate.
const E1: f64 = -0.001_780_011_052_225_777;
const E2: f64 = -0.000_816_434_459_656_746_9;
const E3: f64 = 0.007_880_878_010_261_995;
const E4: f64 = -0.144_711_007_173_262_9;
const E5: f64 = 0.582_357_165_452_555_2;
const E6: f64 = -0.458_082_105_929_186_97;
const E7: f64 = 0.015_151_515_151_515_152;

// Continuous extension. Each stage weight is a polynomial in theta; the whole
// set collapses to the fifth-order weights at theta = 1, which is asserted in
// the tests below and is the sharpest available check on these constants.
const R11: f64 = 1.0;
const R12: f64 = -2.763_706_197_274_826;
const R13: f64 = 2.913_255_461_821_912_6;
const R14: f64 = -1.053_088_497_729_021_6;
const R22: f64 = 0.131_699_999_999_999_98;
const R23: f64 = -0.2234;
const R24: f64 = 0.1017;
const R32: f64 = 3.930_296_236_894_751_6;
const R33: f64 = -5.941_033_872_131_505;
const R34: f64 = 2.490_627_285_651_253;
const R42: f64 = -12.411_077_166_933_676;
const R43: f64 = 30.338_188_630_282_32;
const R44: f64 = -16.548_102_889_244_902;
const R52: f64 = 37.509_313_416_511_04;
const R53: f64 = -88.178_904_894_766_4;
const R54: f64 = 47.379_521_962_819_28;
const R62: f64 = -27.896_526_289_197_286;
const R63: f64 = 65.091_894_674_793_66;
const R64: f64 = -34.870_657_861_496_6;
const R72: f64 = 1.5;
const R73: f64 = -4.0;
const R74: f64 = 2.5;

/// Interpolation weights at `theta` in 0..=1.
pub(crate) fn b_theta(theta: f64) -> [f64; STAGES] {
    let t = theta;
    let t2 = t * t;
    [
        t * (R11 + t * (R12 + t * (R13 + t * R14))),
        t2 * (R22 + t * (R23 + t * R24)),
        t2 * (R32 + t * (R33 + t * R34)),
        t2 * (R42 + t * (R43 + t * R44)),
        t2 * (R52 + t * (R53 + t * R54)),
        t2 * (R62 + t * (R63 + t * R64)),
        t2 * (R72 + t * (R73 + t * R74)),
    ]
}

#[derive(Debug, Clone, PartialEq)]
pub struct Opts {
    pub rtol: f64,
    pub atol: f64,
    /// Initial step. `None` selects one automatically.
    pub dt0: Option<f64>,
    pub dt_min: f64,
    pub dt_max: f64,
    pub max_steps: usize,
    pub safety: f64,
    /// Bounds on how fast the step size may change between attempts.
    pub min_factor: f64,
    pub max_factor: f64,
}

impl Default for Opts {
    fn default() -> Self {
        Opts {
            rtol: 1e-6,
            atol: 1e-9,
            dt0: None,
            dt_min: 1e-12,
            dt_max: f64::INFINITY,
            max_steps: 1_000_000,
            safety: 0.9,
            min_factor: 0.2,
            max_factor: 10.0,
        }
    }
}

/// The only things a solve can refuse to do.
///
/// Everything here is a **programming error**: the call itself does not make
/// sense, and there is no partial answer worth keeping because no integration
/// was ever possible. Numerical give-up — stiffness, blowup, a spent step
/// budget — is deliberately *not* in this enum. That is
/// [`StopReason`], it arrives attached to a real
/// [`Solution`], and the reasoning is written out there.
#[derive(Debug, Clone, PartialEq)]
pub enum SolveError {
    /// The initial state is not the width the system says it is.
    DimensionMismatch { expected: usize, got: usize },
    /// A fixed-step method was handed a step it cannot use — zero, negative,
    /// or not a number. Unlike a step that *collapses* during a run, this one
    /// was wrong before the first evaluation, so there is nothing to return.
    InvalidStep { dt: f64 },
}

impl std::fmt::Display for SolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SolveError::DimensionMismatch { expected, got } => write!(
                f,
                "the system has {} states but was given {} initial values",
                expected, got
            ),
            SolveError::InvalidStep { dt } => {
                write!(f, "{} is not a usable step size", dt)
            }
        }
    }
}

impl std::error::Error for SolveError {}

/// PI step-size controller (Hairer/Wanner). The integral term damps the
/// oscillation a pure elementary controller shows near a stability boundary.
const PI_ALPHA: f64 = 0.17;
const PI_BETA: f64 = 0.04;

fn error_norm(err: &[f64], y: &[f64], y_new: &[f64], opts: &Opts) -> f64 {
    let n = err.len();
    let mut acc = 0.0;
    for i in 0..n {
        let sc = opts.atol + opts.rtol * y[i].abs().max(y_new[i].abs());
        let e = err[i] / sc;
        acc += e * e;
    }
    (acc / n as f64).sqrt()
}

/// Hairer's automatic starting step.
fn initial_step<S: System>(sys: &S, t0: f64, y0: &[f64], f0: &[f64], opts: &Opts) -> f64 {
    let n = y0.len();
    let sc: Vec<f64> = (0..n)
        .map(|i| opts.atol + opts.rtol * y0[i].abs())
        .collect();

    let norm = |v: &[f64]| -> f64 {
        let acc: f64 = (0..n).map(|i| (v[i] / sc[i]).powi(2)).sum();
        (acc / n as f64).sqrt()
    };

    let d0 = norm(y0);
    let d1 = norm(f0);
    let h0 = if d0 < 1e-5 || d1 < 1e-5 {
        1e-6
    } else {
        0.01 * d0 / d1
    };

    let mut y1 = vec![0.0; n];
    for i in 0..n {
        y1[i] = y0[i] + h0 * f0[i];
    }
    let mut f1 = vec![0.0; n];
    sys.rhs(t0 + h0, &y1, &mut f1);

    let mut diff = vec![0.0; n];
    for i in 0..n {
        diff[i] = f1[i] - f0[i];
    }
    let d2 = norm(&diff) / h0;

    let h1 = if d1.max(d2) <= 1e-15 {
        (h0 * 1e-3).max(1e-6)
    } else {
        (0.01 / d1.max(d2)).powf(1.0 / (ORDER + 1.0))
    };

    (100.0 * h0).min(h1).min(opts.dt_max)
}

/// Integrate `sys` from `t_span.0` to `t_span.1`.
///
/// **Always produces a solution.** If the numerics give up — the step size
/// collapses, the state stops being finite, the step budget runs out — the
/// steps taken so far come back anyway, with [`Solution::t_end`] short of
/// `t_span.1` and [`Solution::stopped`] saying why. `Err` is reserved for a
/// call that never made sense. See [`StopReason`] for the product rule behind
/// that split, and [`Solution::require_complete`] for the strict path.
pub fn solve<S: System>(
    sys: &S,
    t_span: (f64, f64),
    y0: &[f64],
    opts: &Opts,
) -> Result<Solution, SolveError> {
    let n = sys.dim();
    if y0.len() != n {
        return Err(SolveError::DimensionMismatch {
            expected: n,
            got: y0.len(),
        });
    }

    let (t0, t1) = t_span;
    let mut telemetry = Telemetry::default();
    let mut steps: Vec<Step> = Vec::new();

    let mut t = t0;
    let mut y = y0.to_vec();

    if t1 <= t0 {
        return Ok(Solution {
            steps,
            telemetry,
            y_end: y,
            t_end: t0,
            // A span of zero width was asked for and a span of zero width was
            // delivered. Nothing gave up.
            stopped: None,
        });
    }

    // Stage derivatives, flattened as k[stage * n + i].
    let mut k = vec![0.0; STAGES * n];
    let mut tmp = vec![0.0; n];
    let mut y_new = vec![0.0; n];
    let mut err = vec![0.0; n];

    sys.rhs(t, &y, &mut k[0..n]);
    telemetry.rhs_evals += 1;

    let mut dt = match opts.dt0 {
        Some(h) => h,
        None => {
            let f0 = k[0..n].to_vec();
            let h = initial_step(sys, t0, &y, &f0, opts);
            telemetry.rhs_evals += 1;
            h
        }
    };
    dt = dt.min(t1 - t0).max(opts.dt_min);

    // Previous accepted error, for the integral term. Starts at 1 so the first
    // step behaves like a plain elementary controller.
    let mut err_prev: f64 = 1.0;
    let mut attempts = 0usize;

    // Why the loop stopped short, if it did. Every exit below is a `break` and
    // not a `return`: the steps taken so far are the answer, and the product
    // rule is that a run that gave up still draws. See [`StopReason`].
    let mut stopped: Option<StopReason> = None;

    while t < t1 {
        if attempts >= opts.max_steps {
            stopped = Some(StopReason::TooManySteps);
            break;
        }
        attempts += 1;

        if t + dt > t1 {
            dt = t1 - t;
        }

        // --- stages -------------------------------------------------------
        for i in 0..n {
            tmp[i] = y[i] + dt * A21 * k[i];
        }
        {
            let (_, rest) = k.split_at_mut(n);
            sys.rhs(t + C2 * dt, &tmp, &mut rest[0..n]);
        }

        for i in 0..n {
            tmp[i] = y[i] + dt * (A31 * k[i] + A32 * k[n + i]);
        }
        {
            let (_, rest) = k.split_at_mut(2 * n);
            sys.rhs(t + C3 * dt, &tmp, &mut rest[0..n]);
        }

        for i in 0..n {
            tmp[i] = y[i] + dt * (A41 * k[i] + A42 * k[n + i] + A43 * k[2 * n + i]);
        }
        {
            let (_, rest) = k.split_at_mut(3 * n);
            sys.rhs(t + C4 * dt, &tmp, &mut rest[0..n]);
        }

        for i in 0..n {
            tmp[i] = y[i]
                + dt * (A51 * k[i]
                    + A52 * k[n + i]
                    + A53 * k[2 * n + i]
                    + A54 * k[3 * n + i]);
        }
        {
            let (_, rest) = k.split_at_mut(4 * n);
            sys.rhs(t + C5 * dt, &tmp, &mut rest[0..n]);
        }

        for i in 0..n {
            tmp[i] = y[i]
                + dt * (A61 * k[i]
                    + A62 * k[n + i]
                    + A63 * k[2 * n + i]
                    + A64 * k[3 * n + i]
                    + A65 * k[4 * n + i]);
        }
        {
            let (_, rest) = k.split_at_mut(5 * n);
            sys.rhs(t + dt, &tmp, &mut rest[0..n]);
        }

        for i in 0..n {
            y_new[i] = y[i]
                + dt * (B1 * k[i]
                    + B2 * k[n + i]
                    + B3 * k[2 * n + i]
                    + B4 * k[3 * n + i]
                    + B5 * k[4 * n + i]
                    + B6 * k[5 * n + i]);
        }
        {
            let (_, rest) = k.split_at_mut(6 * n);
            sys.rhs(t + dt, &y_new, &mut rest[0..n]);
        }
        telemetry.rhs_evals += 6;

        // --- error estimate ----------------------------------------------
        for i in 0..n {
            err[i] = dt
                * (E1 * k[i]
                    + E2 * k[n + i]
                    + E3 * k[2 * n + i]
                    + E4 * k[3 * n + i]
                    + E5 * k[4 * n + i]
                    + E6 * k[5 * n + i]
                    + E7 * k[6 * n + i]);
        }

        if y_new.iter().any(|v| !v.is_finite()) {
            // `y` and `t` still hold the last accepted state, so the solution
            // ends cleanly at the last point that was a number. The bad step is
            // not recorded in the telemetry either — its error norm is NaN,
            // which is not a height the strip can draw.
            stopped = Some(StopReason::NonFinite);
            break;
        }

        let e = error_norm(&err, &y, &y_new, opts);
        let accepted = e <= 1.0;
        telemetry.steps.push(StepRecord {
            t,
            dt,
            error: e,
            accepted,
        });

        // --- PI control ---------------------------------------------------
        let factor = if e == 0.0 {
            opts.max_factor
        } else {
            let f = opts.safety * e.powf(-PI_ALPHA) * err_prev.powf(PI_BETA);
            f.clamp(opts.min_factor, opts.max_factor)
        };

        if accepted {
            telemetry.accepted += 1;
            steps.push(Step::rk(t, dt, y.clone(), k.clone()));
            t += dt;
            y.copy_from_slice(&y_new);
            // FSAL: the last stage is the next step's first.
            k.copy_within(6 * n..7 * n, 0);
            err_prev = e.max(1e-4);
            dt *= factor;
        } else {
            telemetry.rejected += 1;
            // Never grow a rejected step.
            dt *= factor.min(1.0);
        }

        dt = dt.min(opts.dt_max);
        // Only report a collapsed step while there is still span left to cover.
        // Reaching `t1` in a whole number of capped steps leaves a final gap of
        // a few ulps, and the next proposed step inherits that width — which is
        // arithmetic, not stiffness, and must not be reported as a failure.
        if t < t1 && dt < opts.dt_min {
            stopped = Some(StopReason::StepTooSmall { dt });
            break;
        }
    }

    Ok(Solution {
        steps,
        telemetry,
        y_end: y,
        t_end: t,
        stopped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solution::StopReason;
    use crate::system::Field;

    /// The sharpest possible check on the interpolation constants: at the end
    /// of a step the continuous extension must reproduce the fifth-order
    /// weights exactly. A single mistyped digit fails this.
    #[test]
    fn interpolant_collapses_to_the_step_weights_at_theta_one() {
        let b = b_theta(1.0);
        let want = [B1, B2, B3, B4, B5, B6, 0.0];
        for (got, want) in b.iter().zip(want.iter()) {
            assert!(
                (got - want).abs() < 1e-12,
                "interpolant {} vs weight {}",
                got,
                want
            );
        }
    }

    #[test]
    fn interpolant_vanishes_at_theta_zero() {
        for b in b_theta(0.0) {
            assert_eq!(b, 0.0);
        }
    }

    fn decay() -> Field<impl Fn(f64, &[f64], &mut [f64])> {
        Field::new(1, |_t, y: &[f64], dy: &mut [f64]| dy[0] = -y[0])
    }

    #[test]
    fn exponential_decay_matches_the_closed_form() {
        let opts = Opts {
            rtol: 1e-10,
            atol: 1e-12,
            ..Default::default()
        };
        let sol = solve(&decay(), (0.0, 5.0), &[1.0], &opts).unwrap();
        let want = (-5.0f64).exp();
        assert!(
            (sol.y_end[0] - want).abs() < 1e-9,
            "got {}, want {}",
            sol.y_end[0],
            want
        );
    }

    #[test]
    fn dense_output_is_accurate_between_step_points() {
        let opts = Opts {
            rtol: 1e-8,
            atol: 1e-10,
            ..Default::default()
        };
        let sol = solve(&decay(), (0.0, 5.0), &[1.0], &opts).unwrap();
        // Deliberately off-grid times: this is what scrubbing does.
        for i in 0..=200 {
            let t = 5.0 * (i as f64) / 200.0;
            let got = sol.eval(t)[0];
            let want = (-t).exp();
            assert!(
                (got - want).abs() < 1e-7,
                "at t={}: got {}, want {}",
                t,
                got,
                want
            );
        }
    }

    #[test]
    fn interpolant_is_continuous_across_step_boundaries() {
        let sys = Field::new(2, |_t, y: &[f64], dy: &mut [f64]| {
            dy[0] = -y[1];
            dy[1] = y[0];
        });
        let sol = solve(&sys, (0.0, 20.0), &[1.0, 0.0], &Opts::default()).unwrap();
        for w in sol.steps.windows(2) {
            let end = sol.eval(w[1].t);
            for i in 0..2 {
                assert!(
                    (end[i] - w[1].y[i]).abs() < 1e-9,
                    "discontinuity at t={}",
                    w[1].t
                );
            }
        }
    }

    #[test]
    fn harmonic_oscillator_tracks_the_circle() {
        let sys = Field::new(2, |_t, y: &[f64], dy: &mut [f64]| {
            dy[0] = -y[1];
            dy[1] = y[0];
        });
        let opts = Opts {
            rtol: 1e-10,
            atol: 1e-12,
            ..Default::default()
        };
        let sol = solve(&sys, (0.0, std::f64::consts::TAU), &[1.0, 0.0], &opts).unwrap();
        assert!((sol.y_end[0] - 1.0).abs() < 1e-8, "{:?}", sol.y_end);
        assert!(sol.y_end[1].abs() < 1e-8, "{:?}", sol.y_end);
    }

    fn pulse() -> Field<impl Fn(f64, &[f64], &mut [f64])> {
        // A narrow bump centred at t = 5, essentially zero elsewhere.
        Field::new(1, |t: f64, _y: &[f64], dy: &mut [f64]| {
            dy[0] = (-(t - 5.0) * (t - 5.0) * 50.0).exp();
        })
    }

    #[test]
    fn adaptive_stepping_responds_to_the_solution() {
        // The step size must shrink around t = 5 and grow away from it.
        let opts = Opts {
            dt_max: 1.0,
            ..Default::default()
        };
        let sol = solve(&pulse(), (0.0, 10.0), &[0.0], &opts).unwrap();
        let near: f64 = sol
            .steps
            .iter()
            .filter(|s| (s.t - 5.0).abs() < 0.5)
            .map(|s| s.dt)
            .fold(f64::INFINITY, f64::min);
        let far: f64 = sol
            .steps
            .iter()
            .filter(|s| s.t < 2.0)
            .map(|s| s.dt)
            .fold(0.0, f64::max);
        assert!(near < far, "near={} far={}", near, far);
    }

    /// A known and unavoidable property of *every* adaptive method, pinned here
    /// so it is a documented limit rather than a surprise: starting on a flat
    /// stretch, the controller grows the step geometrically and can leap over a
    /// narrow feature entirely. The error estimate cannot see a bump the method
    /// never lands on.
    ///
    /// The product consequence: `dt_max` must default to something tied to the
    /// visible time window rather than to infinity, or a user can plot a pulse
    /// that the solver never notices.
    #[test]
    fn narrow_features_can_be_stepped_over_without_a_step_cap() {
        let uncapped = solve(&pulse(), (0.0, 10.0), &[0.0], &Opts::default()).unwrap();
        let capped = solve(
            &pulse(),
            (0.0, 10.0),
            &[0.0],
            &Opts {
                dt_max: 1.0,
                ..Default::default()
            },
        )
        .unwrap();

        // The exact integral of the bump over the real line.
        let want = (std::f64::consts::PI / 50.0).sqrt();
        let missed = (uncapped.y_end[0] - want).abs();
        let caught = (capped.y_end[0] - want).abs();

        assert!(
            missed > 0.1 * want,
            "expected the uncapped run to miss the pulse, got {}",
            uncapped.y_end[0]
        );
        assert!(caught < 1e-6, "capped run should resolve it, got {}", caught);
    }

    /// Regression: a capped step size that divides the span evenly used to end
    /// the run with a `StepTooSmall` error raised *after* `t1` was reached.
    /// `dt_max` is set from the time window on every solve the product makes,
    /// so this was reachable from a plain `x' = 1`.
    #[test]
    fn reaching_the_end_in_whole_capped_steps_is_not_reported_as_stiffness() {
        let sys = Field::new(1, |_t, _y: &[f64], dy: &mut [f64]| dy[0] = 1.0);
        let opts = Opts {
            dt_max: 0.03,
            ..Default::default()
        };
        let sol = solve(&sys, (0.0, 3.0), &[0.0], &opts).expect("integration failed");
        assert!((sol.t_end - 3.0).abs() < 1e-12);
        assert!((sol.y_end[0] - 3.0).abs() < 1e-9);
    }

    #[test]
    fn telemetry_accounts_for_every_attempt() {
        let sol = solve(&decay(), (0.0, 5.0), &[1.0], &Opts::default()).unwrap();
        let t = &sol.telemetry;
        assert_eq!(t.steps.len(), t.accepted + t.rejected);
        assert_eq!(t.accepted, sol.steps.len());
        assert!(t.rhs_evals >= 6 * t.accepted);
        assert!(t.steps.iter().all(|s| s.accepted == (s.error <= 1.0)));
    }

    #[test]
    fn integration_ends_exactly_on_the_requested_time() {
        let sol = solve(&decay(), (0.0, 3.7), &[1.0], &Opts::default()).unwrap();
        assert!((sol.t_end - 3.7).abs() < 1e-12);
    }

    #[test]
    fn scrubbing_past_the_ends_holds_rather_than_extrapolating() {
        let sol = solve(&decay(), (0.0, 2.0), &[1.0], &Opts::default()).unwrap();
        assert_eq!(sol.eval(-10.0)[0], 1.0);
        assert_eq!(sol.eval(99.0)[0], sol.y_end[0]);
    }

    #[test]
    fn tighter_tolerance_gives_a_smaller_error() {
        let err_at = |rtol: f64| {
            let opts = Opts {
                rtol,
                atol: rtol * 1e-3,
                ..Default::default()
            };
            let sol = solve(&decay(), (0.0, 5.0), &[1.0], &opts).unwrap();
            (sol.y_end[0] - (-5.0f64).exp()).abs()
        };
        assert!(err_at(1e-10) < err_at(1e-5));
    }

    /// `y' = y^2` from `y(0) = 1` has the closed form `1 / (1 - t)` and escapes
    /// to infinity at `t = 1` exactly. Someone typing that into Numpla is
    /// entitled to watch the curve rise and stop — the blowup is the point of
    /// the model, and an `Err` that threw away the rise would leave them
    /// staring at nothing.
    fn blowup() -> Field<impl Fn(f64, &[f64], &mut [f64])> {
        Field::new(1, |_t, y: &[f64], dy: &mut [f64]| dy[0] = y[0] * y[0])
    }

    #[test]
    fn a_blowup_still_returns_the_curve_up_to_where_it_blew() {
        // The span asked for is five times longer than the solution exists for.
        let sol = solve(&blowup(), (0.0, 5.0), &[1.0], &Opts::default())
            .expect("a blowup must not be an error");

        assert!(sol.stopped.is_some(), "the run cannot claim to be complete");
        assert!(!sol.is_complete());
        // It got essentially all the way to the singularity, and no further.
        // Not *exactly* to `t = 1`: near the pole the state is around 1e11 and
        // the step is around 1e-12, so the last few steps land a handful of
        // ulps either side of it. Where the pole is to twelve digits is not a
        // question a stepper can answer, and not one anyone is asking.
        assert!(
            (sol.t_end - 1.0).abs() < 1e-3,
            "stopped at t = {}, expected essentially 1",
            sol.t_end
        );
        assert!(sol.t_end < 5.0);
        assert!(sol.steps.len() > 10, "only {} steps", sol.steps.len());

        // And the part it did integrate is right. Checked against the closed
        // form, not merely against itself.
        for i in 0..=100 {
            let t = 0.99 * (i as f64) / 100.0;
            let got = sol.eval(t)[0];
            let want = 1.0 / (1.0 - t);
            assert!(
                (got - want).abs() < 1e-4 * want,
                "at t = {}: got {}, want {}",
                t,
                got,
                want
            );
        }
    }

    /// The other half of the same contract: past the point where integration
    /// stopped, dense output must hold rather than extrapolate. Extrapolating a
    /// fifth-order polynomial out of a singularity would draw a confident,
    /// enormous, entirely fictional curve across the rest of the window.
    #[test]
    fn dense_output_past_a_blowup_holds_instead_of_extrapolating() {
        let sol = solve(&blowup(), (0.0, 5.0), &[1.0], &Opts::default()).unwrap();
        let last = sol.y_end[0];
        assert!(last.is_finite());
        for t in [sol.t_end, 1.5, 3.0, 5.0, 1e6] {
            assert_eq!(sol.eval(t)[0], last, "at t = {}", t);
        }
        // Every sample is finite, which is what the plotter needs.
        assert!(sol.sample(500).iter().all(|y| y[0].is_finite()));
    }

    /// A right-hand side that simply hands back NaN. Nothing overflows on the
    /// way — the state stops being a number in one step — so this exercises the
    /// non-finite guard on its own rather than through a blowup.
    #[test]
    fn a_nan_right_hand_side_stops_the_run_at_the_last_real_state() {
        let sys = Field::new(1, |t: f64, y: &[f64], dy: &mut [f64]| {
            dy[0] = if t < 1.0 { -y[0] } else { f64::NAN };
        });
        let sol = solve(&sys, (0.0, 5.0), &[1.0], &Opts::default()).unwrap();
        assert_eq!(sol.stopped, Some(StopReason::NonFinite));
        assert!(sol.t_end <= 1.0, "stopped at {}", sol.t_end);
        assert!(sol.y_end.iter().all(|v| v.is_finite()));
        assert!(sol.sample(200).iter().all(|y| y[0].is_finite()));
    }

    /// Step-size collapse without a blowup: the state stays small and bounded,
    /// but no step is ever small enough to be accepted, because the right-hand
    /// side changes between calls. `dt_min` is what stops this running forever.
    #[test]
    fn a_step_size_collapse_returns_what_it_managed() {
        use std::cell::Cell;
        let calls = Cell::new(0u32);
        let sys = Field::new(1, |_t: f64, y: &[f64], dy: &mut [f64]| {
            let n = calls.get();
            calls.set(n.wrapping_add(1));
            // Bounded, but inconsistent from one evaluation to the next, so the
            // error estimator measures the disagreement and never converges.
            dy[0] = -y[0] + 0.5 * ((n % 7) as f64 - 3.0);
        });
        let sol = solve(&sys, (0.0, 50.0), &[0.0], &Opts::default()).unwrap();
        assert!(
            matches!(
                sol.stopped,
                Some(StopReason::StepTooSmall { .. }) | Some(StopReason::TooManySteps)
            ),
            "expected a collapse, got {:?}",
            sol.stopped
        );
        assert!(sol.t_end < 50.0);
        assert!(sol.y_end.iter().all(|v| v.is_finite()));
    }

    /// A budget too small for the span. The run still answers; it just answers
    /// about less time than was asked for.
    #[test]
    fn exhausting_the_step_budget_is_a_short_run_not_a_failed_one() {
        let opts = Opts {
            dt_max: 0.01,
            max_steps: 25,
            ..Default::default()
        };
        let sol = solve(&decay(), (0.0, 5.0), &[1.0], &opts).unwrap();
        assert_eq!(sol.stopped, Some(StopReason::TooManySteps));
        assert!(sol.t_end > 0.0 && sol.t_end < 5.0, "{}", sol.t_end);
        assert!((sol.y_end[0] - (-sol.t_end).exp()).abs() < 1e-6);
    }

    /// The strict path. A caller pinning an endpoint — a convergence study, a
    /// batch job — must not be handed a short run that looks like a good one.
    #[test]
    fn strictness_still_tells_a_partial_run_from_a_complete_one() {
        let whole = solve(&decay(), (0.0, 5.0), &[1.0], &Opts::default()).unwrap();
        assert!(whole.is_complete());
        assert!(whole.require_complete().is_ok());

        let partial = solve(&blowup(), (0.0, 5.0), &[1.0], &Opts::default()).unwrap();
        assert!(partial.require_complete().is_err());
    }

    /// Still a hard error: nothing about this call can be salvaged, so there is
    /// no partial answer to keep.
    #[test]
    fn dimension_mismatch_is_caught() {
        let r = solve(&decay(), (0.0, 1.0), &[1.0, 2.0], &Opts::default());
        assert_eq!(
            r.unwrap_err(),
            SolveError::DimensionMismatch {
                expected: 1,
                got: 2
            }
        );
    }

    /// Every solve that ran to `t1` says so, so `stopped` cannot quietly become
    /// noise that a caller learns to ignore.
    #[test]
    fn an_ordinary_run_reports_no_stop_reason() {
        let sol = solve(&decay(), (0.0, 5.0), &[1.0], &Opts::default()).unwrap();
        assert_eq!(sol.stopped, None);
        assert!((sol.t_end - 5.0).abs() < 1e-12);
    }

    #[test]
    fn lotka_volterra_conserves_its_invariant_reasonably() {
        // V = d*x - c*ln x + b*y - a*ln y is constant along trajectories.
        let (a, b, c, d) = (1.5, 1.0, 3.0, 1.0);
        let sys = Field::new(2, move |_t, y: &[f64], dy: &mut [f64]| {
            dy[0] = a * y[0] - b * y[0] * y[1];
            dy[1] = -c * y[1] + d * y[0] * y[1];
        });
        let opts = Opts {
            rtol: 1e-10,
            atol: 1e-12,
            ..Default::default()
        };
        let y0 = [1.0, 1.0];
        let sol = solve(&sys, (0.0, 30.0), &y0, &opts).unwrap();
        let v = |y: &[f64]| d * y[0] - c * y[0].ln() + b * y[1] - a * y[1].ln();
        assert!(
            (v(&sol.y_end) - v(&y0)).abs() < 1e-6,
            "invariant drifted: {} -> {}",
            v(&y0),
            v(&sol.y_end)
        );
    }
}
