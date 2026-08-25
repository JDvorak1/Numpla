//! Which integrator, chosen at the call site.
//!
//! This is the mechanism behind the mode slider. Dragging it must be as cheap
//! as changing one enum value — no re-lowering the model, no re-shaping the
//! state vector, no branch anywhere downstream — because the entire point of
//! the slider is to put two answers to the same question side by side and let
//! someone see which parts of the picture are physics and which are the
//! method's. A [`Solution`] does not remember what produced it, so the plotter,
//! the scrubber and the conservation monitor are all unchanged by the choice.
//!
//! Every method here takes the system in second-order form and the state in the
//! interleaved `[q0, v0, q1, v1, ...]` layout described on
//! [`SecondOrderSystem`] — including Tsit5, which reaches it through
//! [`Lowered`]. One layout for all methods is what makes them substitutable;
//! a method that needed its own state order would make the slider a rewrite.

use crate::solution::Solution;
use crate::symplectic::{solve_verlet, solve_yoshida4};
use crate::system::{Lowered, SecondOrderSystem};
use crate::tsit5::{self, Opts, SolveError};

/// The integrators a second-order system can be handed to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Method {
    /// Tsitouras 5(4), adaptive. Most accurate per unit work over a short run,
    /// and preserves nothing.
    Tsit5,
    /// Velocity Verlet: fixed step, second order, symplectic.
    Verlet,
    /// Yoshida's fourth-order composition of Verlet: fixed step, symplectic.
    Yoshida4,
}

impl Method {
    /// In slider order — accuracy at one end, structure at the other.
    pub const ALL: [Method; 3] = [Method::Tsit5, Method::Verlet, Method::Yoshida4];

    /// The label the UI shows.
    pub fn name(self) -> &'static str {
        match self {
            Method::Tsit5 => "Tsit5",
            Method::Verlet => "Verlet",
            Method::Yoshida4 => "Yoshida4",
        }
    }

    /// Does this method preserve the symplectic form (and, for a central force,
    /// momentum) at the cost of exact energy? The conservation monitor uses
    /// this to say *what to expect* before the drift has had time to show.
    pub fn is_symplectic(self) -> bool {
        matches!(self, Method::Verlet | Method::Yoshida4)
    }

    /// Adaptive methods choose their own step and report a local error
    /// estimate; fixed-step ones take `Opts::dt0` and report none. The
    /// telemetry strip needs to know which it is looking at.
    pub fn is_adaptive(self) -> bool {
        matches!(self, Method::Tsit5)
    }

    /// Order of the global error in the step size.
    pub fn order(self) -> u32 {
        match self {
            Method::Tsit5 => 5,
            Method::Verlet => 2,
            Method::Yoshida4 => 4,
        }
    }
}

impl std::fmt::Display for Method {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

/// Integrate a second-order system with the chosen method.
///
/// `y0` is interleaved: position, then its velocity, per degree of freedom.
///
/// ```
/// use numpla_ode::{measure, solve_with, Accel, Method, Opts};
///
/// // A pendulum, small angle: q'' = -q.
/// let sys = Accel::new(1, |_t, q: &[f64], _v: &[f64], a: &mut [f64]| a[0] = -q[0]);
/// let opts = Opts { dt0: Some(0.05), ..Default::default() };
///
/// for method in Method::ALL {
///     let sol = solve_with(method, &sys, (0.0, 200.0), &[1.0, 0.0], &opts).unwrap();
///     let energy = measure(&sol, 1000, |_t, y| 0.5 * (y[0] * y[0] + y[1] * y[1]));
///     // Same call, same state layout, same solution interface — only the
///     // shape of the drift differs, which is the thing worth looking at.
///     assert!(energy.relative_drift < 1.0);
/// }
/// ```
pub fn solve_with<S: SecondOrderSystem>(
    method: Method,
    sys: &S,
    t_span: (f64, f64),
    y0: &[f64],
    opts: &Opts,
) -> Result<Solution, SolveError> {
    match method {
        Method::Tsit5 => tsit5::solve(&Lowered::new(sys), t_span, y0, opts),
        Method::Verlet => solve_verlet(sys, t_span, y0, opts),
        Method::Yoshida4 => solve_yoshida4(sys, t_span, y0, opts),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conserve::measure;
    use crate::system::{Accel, AccelFn};

    fn spring() -> Accel<AccelFn> {
        Accel::new(1, |_t, q: &[f64], _v: &[f64], a: &mut [f64]| a[0] = -q[0])
    }

    /// The property the mode slider depends on: swapping the method changes
    /// nothing a caller has to handle. Same arguments in, same shape out, and
    /// every one of them lands on the same trajectory to plotting accuracy.
    #[test]
    fn every_method_solves_the_same_problem_the_same_way() {
        let opts = Opts {
            dt0: Some(0.002),
            ..Default::default()
        };
        for method in Method::ALL {
            let sol = solve_with(method, &spring(), (0.0, 6.0), &[1.0, 0.0], &opts).unwrap();
            assert_eq!(sol.dim(), 2);
            assert!((sol.t_end - 6.0).abs() < 1e-12, "{}", method);
            // Dense output, at a time no method has a step point at.
            let y = sol.eval(4.321);
            assert!(
                (y[0] - 4.321f64.cos()).abs() < 1e-4,
                "{} gave {:?}",
                method,
                y
            );
        }
    }

    #[test]
    fn the_methods_describe_themselves_for_the_ui() {
        assert!(!Method::Tsit5.is_symplectic() && Method::Tsit5.is_adaptive());
        assert!(Method::Verlet.is_symplectic() && !Method::Verlet.is_adaptive());
        assert!(Method::Yoshida4.is_symplectic());
        assert_eq!(Method::Yoshida4.order(), 4);
        assert_eq!(Method::Verlet.to_string(), "Verlet");
        assert_eq!(Method::ALL.len(), 3);
    }

    /// The slider's payload, in one assertion: over a long run the symplectic
    /// methods keep the energy in a band and Tsit5 does not.
    #[test]
    fn only_the_symplectic_methods_keep_the_energy_bounded() {
        let opts = Opts {
            dt0: Some(0.05),
            max_steps: 10_000_000,
            ..Default::default()
        };
        for method in Method::ALL {
            let sol = solve_with(method, &spring(), (0.0, 5000.0), &[1.0, 0.0], &opts).unwrap();
            let e = measure(&sol, 8000, |_t, y| 0.5 * (y[0] * y[0] + y[1] * y[1]));
            if method.is_symplectic() {
                assert!(
                    e.secular_ratio() < 2.0,
                    "{} should be bounded, ratio {}",
                    method,
                    e.secular_ratio()
                );
            } else {
                assert!(
                    e.secular_ratio() > 5.0,
                    "{} should drift, ratio {}",
                    method,
                    e.secular_ratio()
                );
            }
        }
    }
}
