//! Measuring what an integrator fails to conserve.
//!
//! Every method lies about something — that is the Ge–Marsden result, not a
//! defect of any particular implementation (`docs/solvers.md`). The useful
//! response is not to pick the method with the smallest lie but to *show the
//! lie*, which is what the conservation monitor does: pick a quantity that the
//! true flow keeps constant, evaluate it along the computed solution, and plot
//! how far it wanders.
//!
//! Deliberately general. The invariant is a closure over `(t, y)`, not an
//! energy: momentum, angular momentum, a Casimir, the Lotka–Volterra `V`, or a
//! quantity someone typed into a row are all the same shape of thing here. The
//! sampling is on the dense output rather than on step points, because the
//! monitor draws a curve against the same time axis as everything else and must
//! not have its resolution set by wherever the stepper happened to land.
//!
//! ## Found while implementing: undersampling invents a drift
//!
//! A symplectic method's energy error does not grow, but it does *oscillate*,
//! at twice the system's own frequency. Sample that oscillation too sparsely
//! and the samples alias: they creep through the oscillation's phase over the
//! course of a run, and a bounded wobble is reported as a band that widens.
//! Measured on Yoshida4 over two thousand periods of an oscillator, two samples
//! per period claimed the band grew nineteenfold; the same run at ten samples
//! per period, and the step points themselves, both show it flat to four
//! figures.
//!
//! So the monitor must sample by the *system's* time scale, not by its own
//! pixel count — a few samples per oscillation at the very least. A plot that
//! turns a conserved quantity into a drifting one is precisely the wrong
//! lesson, and it is the same class of failure as an adaptive stepper leaping
//! over a narrow pulse (`docs/solvers.md`): the picture is smooth, confident,
//! and about a system nobody has.

use crate::solution::Solution;

/// An invariant sampled along a solution, plus the summary the monitor shows.
#[derive(Debug, Clone, PartialEq)]
pub struct Conservation {
    /// Sample times, uniform across the integrated span.
    pub t: Vec<f64>,
    /// The invariant at those times. This is the series that gets plotted.
    pub values: Vec<f64>,
    /// The value at the start of the run — the thing everything else is
    /// measured against, since the *true* value is whatever the initial
    /// condition had.
    pub initial: f64,
    /// The largest `|value - initial|` anywhere in the run.
    pub max_abs_deviation: f64,
    /// `max_abs_deviation` relative to `|initial|`, so that oscillators with an
    /// energy of 3000 and of 0.003 are comparable. Falls back to the absolute
    /// figure when the invariant is (near) zero, where a ratio is meaningless.
    pub relative_drift: f64,
    /// Signed end-to-end change. Its sign is worth showing: a method that
    /// steadily gains energy looks very different on a plot from one that
    /// steadily loses it, and the difference is often the first hint of what is
    /// wrong with a model.
    pub net_drift: f64,
}

impl Conservation {
    /// The half-width of the band the invariant occupies over a fraction of the
    /// run: `band(0.0, 0.1)` is the first tenth, `band(0.9, 1.0)` the last.
    ///
    /// Comparing those two is the operational test for the property that
    /// matters. A symplectic method's band is set by the step size and is the
    /// same at the end of a run as at the start; a non-symplectic method's
    /// grows without bound. One number each, from the same series the monitor
    /// is already plotting.
    pub fn band(&self, from: f64, to: f64) -> f64 {
        let n = self.values.len();
        if n == 0 {
            return 0.0;
        }
        let idx = |f: f64| ((f.clamp(0.0, 1.0) * (n - 1) as f64).round() as usize).min(n - 1);
        let (a, b) = (idx(from), idx(to));
        let (a, b) = (a.min(b), a.max(b));
        self.values[a..=b]
            .iter()
            .fold(0.0f64, |acc, v| acc.max((v - self.initial).abs()))
    }

    /// How much worse the end of the run is than the beginning. Around 1 means
    /// bounded — the signature of a structure-preserving method. Large means
    /// secular drift.
    pub fn secular_ratio(&self) -> f64 {
        let first = self.band(0.0, 0.1);
        let last = self.band(0.9, 1.0);
        if first > 0.0 {
            last / first
        } else if last > 0.0 {
            f64::INFINITY
        } else {
            1.0
        }
    }
}

/// Evaluate `invariant` at `samples` uniformly spaced times along `sol`.
///
/// `samples` is the caller's, because the monitor knows how many pixels wide it
/// is and there is no point computing more points than it can draw.
pub fn measure<F>(sol: &Solution, samples: usize, invariant: F) -> Conservation
where
    F: Fn(f64, &[f64]) -> f64,
{
    let (t0, t1) = (sol.t_start(), sol.t_end);
    let n = samples.max(1);
    let mut y = vec![0.0; sol.dim()];
    let mut t = Vec::with_capacity(n);
    let mut values = Vec::with_capacity(n);

    for i in 0..n {
        let ti = if n == 1 {
            t0
        } else {
            t0 + (t1 - t0) * (i as f64) / ((n - 1) as f64)
        };
        sol.eval_into(ti, &mut y);
        t.push(ti);
        values.push(invariant(ti, &y));
    }

    let initial = values[0];
    let max_abs_deviation = values
        .iter()
        .fold(0.0f64, |acc, v| acc.max((v - initial).abs()));
    let net_drift = values[values.len() - 1] - initial;
    let relative_drift = if initial.abs() > 1e-300 {
        max_abs_deviation / initial.abs()
    } else {
        max_abs_deviation
    };

    Conservation {
        t,
        values,
        initial,
        max_abs_deviation,
        relative_drift,
        net_drift,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::symplectic::solve_verlet;
    use crate::system::{Accel, AccelFn, Field};
    use crate::tsit5::{solve, Opts};

    fn spring() -> Accel<AccelFn> {
        Accel::new(1, |_t, q: &[f64], _v: &[f64], a: &mut [f64]| a[0] = -q[0])
    }

    #[test]
    fn an_exactly_conserved_quantity_reports_no_drift() {
        // y' = 0: anything at all is conserved, so the measurement must say so
        // rather than reporting round-off as physics.
        let sys = Field::new(1, |_t, _y: &[f64], dy: &mut [f64]| dy[0] = 0.0);
        let sol = solve(&sys, (0.0, 5.0), &[2.0], &Opts::default()).unwrap();
        let c = measure(&sol, 50, |_t, y| y[0]);
        assert_eq!(c.initial, 2.0);
        assert_eq!(c.max_abs_deviation, 0.0);
        assert_eq!(c.net_drift, 0.0);
        assert_eq!(c.secular_ratio(), 1.0);
    }

    #[test]
    fn the_series_is_sampled_on_the_dense_output_not_on_step_points() {
        // Ten steps, a hundred samples: the extra ninety can only come from the
        // interpolant, and they must be right.
        let sol = solve_verlet(
            &spring(),
            (0.0, 1.0),
            &[1.0, 0.0],
            &Opts {
                dt0: Some(0.1),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(sol.steps.len(), 10);
        let c = measure(&sol, 100, |_t, y| 0.5 * (y[0] * y[0] + y[1] * y[1]));
        assert_eq!(c.values.len(), 100);
        assert_eq!(c.t.len(), 100);
        assert!((c.t[99] - 1.0).abs() < 1e-12);
        // Loose on purpose: at ten steps to the radian most of this figure is
        // the interpolant between step points, not the integrator. Sampling the
        // dense output measures what the user is actually shown, which is the
        // right thing to measure and a slightly different number from the one
        // the step points alone would give.
        assert!(c.relative_drift < 1e-2, "{}", c.relative_drift);
    }

    #[test]
    fn a_growing_drift_is_reported_as_growing() {
        // A synthetic solution whose "invariant" is t: every summary should
        // agree that this is secular.
        let sys = Field::new(1, |_t, _y: &[f64], dy: &mut [f64]| dy[0] = 1.0);
        let sol = solve(&sys, (0.0, 10.0), &[0.0], &Opts::default()).unwrap();
        let c = measure(&sol, 101, |_t, y| 1.0 + y[0]);
        assert!((c.initial - 1.0).abs() < 1e-12);
        assert!((c.net_drift - 10.0).abs() < 1e-6);
        assert!((c.max_abs_deviation - 10.0).abs() < 1e-6);
        assert!((c.relative_drift - 10.0).abs() < 1e-6);
        assert!(c.secular_ratio() > 5.0, "{}", c.secular_ratio());
    }

    #[test]
    fn a_band_over_the_whole_run_is_the_max_deviation() {
        let sol = solve_verlet(
            &spring(),
            (0.0, 20.0),
            &[1.0, 0.0],
            &Opts {
                dt0: Some(0.1),
                ..Default::default()
            },
        )
        .unwrap();
        let c = measure(&sol, 500, |_t, y| 0.5 * (y[0] * y[0] + y[1] * y[1]));
        assert_eq!(c.band(0.0, 1.0), c.max_abs_deviation);
        assert!(c.band(0.0, 0.1) <= c.band(0.0, 1.0));
    }

    #[test]
    fn a_single_sample_is_not_a_panic() {
        let sol = solve_verlet(
            &spring(),
            (0.0, 1.0),
            &[1.0, 0.0],
            &Opts {
                dt0: Some(0.1),
                ..Default::default()
            },
        )
        .unwrap();
        let c = measure(&sol, 1, |_t, y| y[0]);
        assert_eq!(c.values.len(), 1);
        assert_eq!(c.max_abs_deviation, 0.0);
        let c0 = measure(&sol, 0, |_t, y| y[0]);
        assert_eq!(c0.values.len(), 1);
    }
}
