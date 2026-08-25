//! Numpla's integrators.
//!
//! Design rule, taken from the UX rather than from numerical tradition:
//! **a solution is a function of `t`, not a list of samples.** Numpla scrubs
//! time, so dense output is in the interface from the start rather than bolted
//! on afterwards. Any method without an adequate continuous extension is
//! disqualified here regardless of efficiency — see `docs/solvers.md`.
//!
//! Second rule: **the solver reports on itself.** Accepted and rejected steps,
//! step sizes, and local error come back as data ([`Telemetry`]), because
//! showing someone *where* their problem got hard is the fastest lesson in
//! stiffness available.
//!
//! ```
//! use numpla_ode::{solve, Field, Opts};
//!
//! // A harmonic oscillator, written as a first-order system.
//! let sys = Field::new(2, |_t, y: &[f64], dy: &mut [f64]| {
//!     dy[0] = -y[1];
//!     dy[1] = y[0];
//! });
//! let sol = solve(&sys, (0.0, 10.0), &[1.0, 0.0], &Opts::default()).unwrap();
//!
//! // Ask for the state at any time, not just where the stepper landed.
//! let state = sol.eval(3.7);
//! assert!((state[0] - 3.7f64.cos()).abs() < 1e-5);
//! ```

// These are numeric kernels over parallel state/derivative buffers. Indexing by
// component is the notation the mathematics is written in, and rewriting it as
// zipped iterators obscures which vector each term comes from.
#![allow(clippy::needless_range_loop)]

pub mod solution;
pub mod system;
pub mod tsit5;

pub use solution::{Solution, Step, StepRecord, Telemetry};
pub use system::{Field, System};
pub use tsit5::{solve, Opts, SolveError};
