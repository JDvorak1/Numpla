//! The result of an integration: a sequence of steps, each carrying its own
//! continuous extension.
//!
//! Numpla scrubs time, so a solution is a *function of `t`*, not a list of
//! samples. Every step stores whatever its interpolant needs — stage
//! derivatives for a Runge-Kutta method, both endpoints and their slopes for a
//! fixed-step symplectic one — and [`Solution::eval`] answers at arbitrary `t`
//! by binary search plus interpolation. Which method produced a solution is
//! invisible from the outside, which is what lets the mode slider swap
//! integrators under a plot that keeps drawing. This is also what event
//! detection will bracket against.

/// How a step answers for the times strictly inside it.
///
/// An enum rather than a boxed `dyn Interpolant`: the set of continuous
/// extensions is closed and small, `Step` stays `Clone + Debug` without a hand
/// written impl, and a solution of a hundred thousand steps pays no per-step
/// indirection. Adding a method means adding a variant here, which is the right
/// amount of friction — a method arriving without an interpolant is exactly the
/// thing this crate refuses to ship.
#[derive(Debug, Clone)]
pub(crate) enum Interp {
    /// A Runge-Kutta continuous extension: the stage derivatives, flattened as
    /// `k[stage * dim + i]`, weighted by polynomials in `theta`.
    Rk { k: Vec<f64> },
    /// Cubic Hermite from both endpoints of the step.
    ///
    /// This is what the fixed-step symplectic methods carry. They have no stage
    /// tableau to interpolate, but they *do* have the state and its derivative
    /// at both ends for free — for a second-order system the derivative of the
    /// position half is the velocity, which is already part of the state. Two
    /// values and two slopes is precisely the data a cubic Hermite wants, and
    /// its `O(dt^4)` error matches Yoshida4's global order rather than
    /// degrading it.
    Hermite {
        y_end: Vec<f64>,
        /// `y'` at the start of the step.
        f0: Vec<f64>,
        /// `y'` at the end of the step.
        f1: Vec<f64>,
    },
}

/// One accepted step, plus everything its dense output needs.
#[derive(Debug, Clone)]
pub struct Step {
    /// Time at the start of the step.
    pub t: f64,
    /// Step size. The step covers `[t, t + dt]`.
    pub dt: f64,
    /// State at `t`.
    pub y: Vec<f64>,
    pub(crate) interp: Interp,
}

impl Step {
    /// A step whose dense output is a Runge-Kutta continuous extension.
    pub(crate) fn rk(t: f64, dt: f64, y: Vec<f64>, k: Vec<f64>) -> Step {
        Step {
            t,
            dt,
            y,
            interp: Interp::Rk { k },
        }
    }

    /// A step whose dense output is a cubic Hermite through both endpoints.
    pub(crate) fn hermite(
        t: f64,
        dt: f64,
        y: Vec<f64>,
        y_end: Vec<f64>,
        f0: Vec<f64>,
        f1: Vec<f64>,
    ) -> Step {
        Step {
            t,
            dt,
            y,
            interp: Interp::Hermite { y_end, f0, f1 },
        }
    }

    pub fn t_end(&self) -> f64 {
        self.t + self.dt
    }

    pub fn dim(&self) -> usize {
        self.y.len()
    }

    /// Interpolate within this step. `theta` runs 0..=1 across `[t, t+dt]`.
    pub fn eval_theta_into(&self, theta: f64, out: &mut [f64]) {
        let n = self.dim();
        match &self.interp {
            Interp::Rk { k } => {
                let b = crate::tsit5::b_theta(theta);
                for i in 0..n {
                    let mut acc = 0.0;
                    for (s, bs) in b.iter().enumerate() {
                        acc += bs * k[s * n + i];
                    }
                    out[i] = self.y[i] + self.dt * acc;
                }
            }
            Interp::Hermite { y_end, f0, f1 } => {
                // The standard cubic Hermite basis. Written out rather than
                // folded into a Horner form because these four polynomials are
                // recognisable on sight, and being able to check them against a
                // textbook matters more here than four multiplies.
                let th = theta;
                let th2 = th * th;
                let th3 = th2 * th;
                let h00 = 2.0 * th3 - 3.0 * th2 + 1.0;
                let h10 = th3 - 2.0 * th2 + th;
                let h01 = -2.0 * th3 + 3.0 * th2;
                let h11 = th3 - th2;
                for i in 0..n {
                    out[i] = h00 * self.y[i]
                        + h01 * y_end[i]
                        + self.dt * (h10 * f0[i] + h11 * f1[i]);
                }
            }
        }
    }

    pub fn eval_into(&self, t: f64, out: &mut [f64]) {
        let theta = if self.dt == 0.0 {
            0.0
        } else {
            (t - self.t) / self.dt
        };
        self.eval_theta_into(theta, out);
    }
}

/// Per-step record. Feeds the telemetry strip and the save file.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StepRecord {
    pub t: f64,
    pub dt: f64,
    /// Scaled local error estimate. `<= 1` means the step was accepted.
    pub error: f64,
    pub accepted: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Telemetry {
    pub accepted: usize,
    pub rejected: usize,
    pub rhs_evals: usize,
    /// Every attempted step, in order — including rejections. Rejections are
    /// the interesting ones: they show *where* a problem is stiff.
    pub steps: Vec<StepRecord>,
}

#[derive(Debug, Clone)]
pub struct Solution {
    pub steps: Vec<Step>,
    pub telemetry: Telemetry,
    /// State at the final time. Kept explicitly so the last step's endpoint is
    /// exact rather than interpolated.
    pub y_end: Vec<f64>,
    pub t_end: f64,
}

impl Solution {
    pub fn t_start(&self) -> f64 {
        self.steps.first().map(|s| s.t).unwrap_or(self.t_end)
    }

    pub fn dim(&self) -> usize {
        self.y_end.len()
    }

    /// Evaluate at any `t`. Outside the integrated span the nearest endpoint is
    /// returned rather than extrapolating — a scrubber dragged past the end
    /// should hold, not fly off.
    pub fn eval_into(&self, t: f64, out: &mut [f64]) {
        if self.steps.is_empty() {
            out.copy_from_slice(&self.y_end);
            return;
        }
        if t <= self.t_start() {
            out.copy_from_slice(&self.steps[0].y);
            return;
        }
        if t >= self.t_end {
            out.copy_from_slice(&self.y_end);
            return;
        }
        // Last step whose start is <= t.
        let idx = match self
            .steps
            .binary_search_by(|s| s.t.partial_cmp(&t).unwrap_or(std::cmp::Ordering::Less))
        {
            Ok(i) => i,
            Err(i) => i.saturating_sub(1),
        };
        self.steps[idx].eval_into(t, out);
    }

    pub fn eval(&self, t: f64) -> Vec<f64> {
        let mut out = vec![0.0; self.dim()];
        self.eval_into(t, &mut out);
        out
    }

    /// Sample on a uniform grid. What the plotter asks for.
    pub fn sample(&self, n: usize) -> Vec<Vec<f64>> {
        if n == 0 {
            return Vec::new();
        }
        let (a, b) = (self.t_start(), self.t_end);
        (0..n)
            .map(|i| {
                let t = if n == 1 {
                    a
                } else {
                    a + (b - a) * (i as f64) / ((n - 1) as f64)
                };
                self.eval(t)
            })
            .collect()
    }
}
