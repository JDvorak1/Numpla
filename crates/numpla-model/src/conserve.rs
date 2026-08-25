//! Measuring a quantity the document itself names, along the solution.
//!
//! `numpla-ode::measure` takes an invariant as a closure over `(t, y)` and is
//! deliberately blind to where it came from. This is where it comes from: a
//! row someone typed. `E = 0.5(x'^2 + x^2)` is not a constant — it has no value
//! until there is a trajectory — so the compiler sets it aside as a
//! [`Derived`](crate::document::Derived) row, and this module walks the
//! solution binding the states and evaluating it sample by sample.
//!
//! That is the whole conservation monitor: type an energy, watch the line. No
//! energy is built in, because the interesting quantity is a property of the
//! model rather than of the software — momentum, angular momentum, a Casimir,
//! the Lotka–Volterra `V`, or the total energy of a coupled system are all the
//! same shape of row.
//!
//! ## Two failures inherited from `numpla-ode`, not repeated here
//!
//! **Undersampling invents drift.** A symplectic method's energy error does not
//! grow, but it does oscillate at twice the system's frequency; sample that too
//! sparsely and the samples alias, creeping through the oscillation's phase and
//! reporting a widening band that is not there. `numpla-ode` measured a
//! nineteenfold phantom growth at two samples per period. The monitor's pixel
//! width is therefore *not* allowed to set the sample rate — see
//! [`sample_count`].
//!
//! **An exactly-conserved quantity is exact at step points, not on the
//! interpolant.** The series the monitor plots is sampled uniformly on the
//! dense output, because that is the curve the user is looking at and it must
//! share a time axis with everything else. So the summary reports the drift
//! twice: once on that curve, once at the integrator's own step points. When
//! they disagree, the difference is the cubic Hermite between steps, not the
//! method losing the invariant, and a monitor that reported only the first
//! would blame the integrator for the interpolation.

use std::cell::RefCell;

use numpla_expr::{eval, Env, Expr, Value};
use numpla_ode::{measure, Conservation, Solution};

use crate::document::{bind_derived, describe, Document};
use crate::report::{ConservationReport, Drift};

/// Never fewer samples than this, however short the run.
///
/// A run of twenty steps still draws a curve, and a curve of twenty points has
/// visible corners that read as structure in the quantity rather than as a
/// shortage of points.
const MIN_SAMPLES: usize = 256;

/// Never more than this, however long the run. Beyond a few thousand points the
/// monitor is drawing several samples per pixel and paying for a `Float64Array`
/// it cannot show.
const MAX_SAMPLES: usize = 20_000;

/// How many samples to take, given what the caller asked for.
///
/// The caller's number is treated as a *floor to be raised*, never as an
/// instruction to be obeyed downwards, and that inversion is the point. A
/// monitor asks for its pixel width, which is a fact about a screen; aliasing
/// is a fact about the system, and it is what turns a bounded wobble into a
/// reported drift. So the model takes the larger of the two: what was asked
/// for, and one sample per accepted step.
///
/// The step count is the right scale because the integrator has already
/// measured the system's own time scale — that is what step-size control *is*,
/// and a fixed-step method has been handed the same information in `dt0`.
/// Whatever resolution the method needed to resolve the dynamics is a
/// resolution that cannot alias them. `samples` is reported back so the shell
/// can never assume it got what it asked for.
fn sample_count(requested: usize, accepted_steps: usize) -> usize {
    requested.max((accepted_steps + 1).clamp(MIN_SAMPLES, MAX_SAMPLES))
}

/// One document row, ready to be evaluated at any point of a solution.
///
/// The environment is mutated in place behind a `RefCell` for the same reason
/// [`crate::ModelSystem`] does it: this runs once per sample, thousands of
/// times per measurement, and cloning an `Env` per point would cost more than
/// the arithmetic. Failures are recorded rather than raised, because the
/// closure `measure` wants returns an `f64` and has nowhere to put a message.
struct Quantity<'a> {
    expr: &'a Expr,
    keys: &'a [String],
    derived: &'a [crate::document::Derived],
    env: RefCell<Env>,
    failure: RefCell<Option<String>>,
}

impl<'a> Quantity<'a> {
    fn new(doc: &'a Document, expr: &'a Expr) -> Quantity<'a> {
        let mut env = doc.env.clone();
        env.set("t", 0.0);
        for (name, v) in doc.states.iter().zip(&doc.y0) {
            env.set(name, *v);
        }
        Quantity {
            expr,
            keys: &doc.states,
            derived: &doc.derived,
            env: RefCell::new(env),
            failure: RefCell::new(None),
        }
    }

    fn at(&self, t: f64, y: &[f64]) -> f64 {
        let mut env = self.env.borrow_mut();
        env.set("t", t);
        for (key, value) in self.keys.iter().zip(y) {
            env.set(key, *value);
        }
        // Every *other* derived row is bound first, so an energy written as
        // `E = K + U` measures the same as one written out in full.
        bind_derived(self.derived, &mut env);
        match eval(self.expr, &env) {
            Ok(Value::Scalar(v)) => v,
            Ok(Value::Unevaluated) => {
                self.fail("it is waiting on something not defined yet".to_string());
                f64::NAN
            }
            Ok(Value::List(_)) => {
                self.fail("it is a list, and only a single number can be tracked".to_string());
                f64::NAN
            }
            Err(e) => {
                self.fail(describe(&e));
                f64::NAN
            }
        }
    }

    fn fail(&self, message: String) {
        let mut slot = self.failure.borrow_mut();
        if slot.is_none() {
            *slot = Some(message);
        }
    }
}

/// Measure the row called `name` along `sol`.
///
/// Returns the report and the flat `[t, value]` series behind it; the series is
/// kept out of the JSON and crosses the boundary as a `Float64Array`.
pub(crate) fn measure_named(
    doc: &Document,
    sol: &Solution,
    name: &str,
    samples: usize,
) -> (ConservationReport, Vec<f64>) {
    let fail = |error: String| {
        (
            ConservationReport {
                ok: false,
                name: name.to_string(),
                samples: 0,
                initial: f64::NAN,
                drift: Drift::default(),
                at_steps: Drift::default(),
                error: Some(error),
            },
            Vec::new(),
        )
    };

    // A derived row is the intended case; a state or a constant is accepted
    // because refusing them would be pedantry — "is my momentum state actually
    // constant?" is the same question, and a state is a perfectly good `Var`.
    let expr = match doc.derived.iter().find(|d| d.name == name) {
        Some(d) => d.expr.clone(),
        None if doc.states.iter().any(|s| s == name) || doc.env.vars.contains_key(name) => {
            Expr::Var(name.to_string())
        }
        None => {
            return fail(format!(
                "there is no row called {} — write one, such as `{} = 0.5(x'^2 + x^2)`",
                name, name
            ))
        }
    };

    let q = Quantity::new(doc, &expr);
    let n = sample_count(samples, sol.telemetry.accepted);
    let dense = measure(sol, n, |t, y| q.at(t, y));
    if let Some(message) = q.failure.borrow().clone() {
        return fail(format!("{} cannot be measured: {}", name, message));
    }

    let at_steps = summarize(step_point_values(sol, &q));
    let mut series = Vec::with_capacity(2 * dense.values.len());
    for (t, v) in dense.t.iter().zip(&dense.values) {
        series.push(*t);
        series.push(*v);
    }

    (
        ConservationReport {
            ok: true,
            name: name.to_string(),
            samples: dense.values.len(),
            initial: dense.initial,
            drift: drift_of(&dense),
            at_steps,
            error: None,
        },
        series,
    )
}

/// The quantity at the start of every step, plus the final state.
///
/// `y_end` is kept by the solver precisely so the last point is the integrator's
/// own answer rather than an interpolation of it, and the same is true of every
/// `step.y`. This is where an exactly-conserved quantity is exactly conserved.
fn step_point_values(sol: &Solution, q: &Quantity) -> Vec<(f64, f64)> {
    let mut out: Vec<(f64, f64)> = sol.steps.iter().map(|s| (s.t, q.at(s.t, &s.y))).collect();
    out.push((sol.t_end, q.at(sol.t_end, &sol.y_end)));
    out
}

/// The same four numbers [`measure`] computes, over a series it did not choose
/// the times of.
///
/// Written here rather than reached for in `numpla-ode` because `measure`
/// samples uniformly by design — the monitor's curve must share a time axis
/// with the plot — and step points are by definition not uniform.
fn summarize(points: Vec<(f64, f64)>) -> Drift {
    if points.is_empty() {
        return Drift::default();
    }
    let (t, values): (Vec<f64>, Vec<f64>) = points.into_iter().unzip();
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
    drift_of(&Conservation {
        t,
        values,
        initial,
        max_abs_deviation,
        relative_drift,
        net_drift,
    })
}

fn drift_of(c: &Conservation) -> Drift {
    Drift {
        max_abs_deviation: c.max_abs_deviation,
        relative_drift: c.relative_drift,
        net_drift: c.net_drift,
        secular_ratio: c.secular_ratio(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sample_count_is_raised_to_the_step_count_never_lowered_to_the_pixel_count() {
        // The monitor asks for its width; the run took far more steps than that,
        // so the run wins. Asking for 300 pixels' worth of a 4000-step
        // oscillation is exactly how a bounded wobble gets reported as drift.
        assert_eq!(sample_count(300, 4000), 4001);
        // ...and a caller that wants more than the floor gets it.
        assert_eq!(sample_count(9000, 4000), 9000);
        // A twenty-step run still draws a smooth curve.
        assert_eq!(sample_count(0, 20), MIN_SAMPLES);
        // A hundred-thousand-step run does not ship a megabyte of samples.
        assert_eq!(sample_count(0, 500_000), MAX_SAMPLES);
    }
}
