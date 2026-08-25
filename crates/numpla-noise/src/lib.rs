//! Numpla's noise: randomness that an adaptive solver can integrate.
//!
//! One rule, and everything here follows from it:
//!
//! > **Noise is a deterministic function of time.** Same `t`, same seed, same
//! > value — always. Randomness enters through the *seed*, not through the
//! > call.
//!
//! The obvious alternative — a `rand()` that returns something new each call —
//! is not merely untidy, it does not work. Tsit5 evaluates the right-hand side
//! six times per step, retries rejected steps over the *same* interval, and
//! forms its error estimate by differencing two solutions of that interval. A
//! right-hand side that disagrees with itself makes the estimator measure the
//! disagreement instead of the truncation error, the controller responds by
//! halving the step, and the integration grinds down to `StepTooSmall` without
//! ever converging. `noise_driven_ode_actually_integrates` and
//! `a_non_deterministic_rhs_fails_to_integrate` at the bottom of this file are
//! the two halves of that argument, run as code.
//!
//! Determinism also buys the two things the product needs anyway: scrubbing
//! time backwards shows the same trajectory it just showed, and two runs of a
//! saved document agree.
//!
//! # Band-limiting
//!
//! A noise source is a signal sampled on a lattice of spacing `1/rate` and
//! interpolated. The interpolation is what bounds the frequency content, and
//! that bound is what makes the signal integrable — unbounded high-frequency
//! content drives the step size to zero for the same reason non-determinism
//! does. `rate` is therefore a real parameter with real consequences and is
//! exposed to the user, not hidden.
//!
//! # No dependencies
//!
//! The PRNG is a counter-based hash written out in [`rng`] — a dozen integer
//! instructions, all `u64` wrapping arithmetic, identical on `wasm32` and
//! x86-64. `rand` would be a heavy dependency for this, and its stateful
//! generators are the wrong shape: there is no state here to advance.
//!
//! ```
//! use numpla_noise::{smooth, DEFAULT_RATE};
//!
//! // Same argument, same answer. Forever, and on every platform.
//! assert_eq!(smooth(1.25, DEFAULT_RATE, 7), smooth(1.25, DEFAULT_RATE, 7));
//! ```

pub mod noise;
pub mod rng;

pub use noise::{
    blue, brown, pink, smooth, telegraph, value, white, Kind, Noise, DEFAULT_RATE, DEFAULT_SEED,
};
pub use rng::seed_from_f64;

use rng::{hash, mix64, scramble, unit};

/// Uniform on `[0, 1)`, a pure function of the seed.
///
/// Not a generator: `rand(3)` is a number, the same number every time, the way
/// `sqrt(3)` is. One-shot randomness in a document comes from choosing a
/// different seed, not from calling again.
pub fn rand(seed: u64) -> f64 {
    unit(hash(scramble(seed), 0))
}

/// The `n`-th independent draw from `seed`. What a call-site counter feeds:
/// the document supplies its seed, each site supplies its index, and the two
/// together name a stream that survives re-evaluation of the document.
pub fn rand_at(seed: u64, index: i64) -> f64 {
    unit(hash(scramble(seed), index))
}

/// Standard normal, a pure function of the seed.
///
/// Box–Muller on two hashed uniforms. The rejection-free polar form is
/// cheaper on average but *loops*, and a loop whose trip count depends on the
/// draw is exactly the kind of thing that makes one platform's answer differ
/// from another's. Two hashes and a fixed formula cost more and are worth it.
pub fn randn(seed: u64) -> f64 {
    randn_at(seed, 0)
}

/// The `n`-th independent standard normal draw from `seed`.
pub fn randn_at(seed: u64, index: i64) -> f64 {
    let stream = scramble(seed);
    // Two draws per normal, from indices that cannot collide with a
    // neighbouring call site's pair.
    let a = hash(stream, index.wrapping_mul(2));
    let b = hash(stream, index.wrapping_mul(2).wrapping_add(1));
    // Nudge off zero: ln(0) is -inf and one infinity in a right-hand side ends
    // the integration. The shift is 2^-53, far below any visible effect.
    let u1 = unit(a) + f64::from_bits(0x3CA0_0000_0000_0000);
    let u2 = unit(b);
    (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
}

/// Derive a seed for one row of a document from the document seed.
///
/// Two noise sources in one model must not correlate, and users will not think
/// to type distinct seeds. The document assigns each site an index and this
/// turns the pair into a stream that is independent of every other pair.
pub fn derive_seed(document_seed: u64, site: u64) -> u64 {
    mix64(scramble(document_seed) ^ site.wrapping_mul(0xD6E8_FEB8_6659_FD93))
}

#[cfg(test)]
mod distribution {
    use super::*;

    fn draws(n: usize, f: impl Fn(i64) -> f64) -> Vec<f64> {
        (0..n as i64).map(f).collect()
    }

    fn mean(xs: &[f64]) -> f64 {
        xs.iter().sum::<f64>() / xs.len() as f64
    }

    fn variance(xs: &[f64]) -> f64 {
        let m = mean(xs);
        xs.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / xs.len() as f64
    }

    #[test]
    fn rand_is_pure() {
        for s in 0..100u64 {
            assert_eq!(rand(s).to_bits(), rand(s).to_bits());
            assert_eq!(randn(s).to_bits(), randn(s).to_bits());
        }
    }

    /// Uniform on [0, 1): the mean lands on 1/2, and every bucket gets its
    /// share. The mean alone would pass for a two-point distribution at 0 and
    /// 1, so the buckets are the part that proves uniformity.
    #[test]
    fn rand_is_uniform() {
        let n = 200_000;
        let xs = draws(n, |i| rand_at(1, i));
        assert!(xs.iter().all(|x| (0.0..1.0).contains(x)));

        let m = mean(&xs);
        assert!((m - 0.5).abs() < 0.005, "mean {}", m);
        // Variance of U(0,1) is 1/12.
        let v = variance(&xs);
        assert!((v - 1.0 / 12.0).abs() < 0.003, "variance {}", v);

        let buckets = 20;
        let mut counts = vec![0usize; buckets];
        for x in &xs {
            counts[(x * buckets as f64) as usize] += 1;
        }
        let expected = n as f64 / buckets as f64;
        for (i, c) in counts.iter().enumerate() {
            let dev = (*c as f64 - expected) / expected;
            assert!(dev.abs() < 0.05, "bucket {} off by {}", i, dev);
        }
    }

    /// Standard normal: mean 0, variance 1, and the 2-sigma mass at 95.45%.
    /// Mean and variance together still admit a uniform distribution with the
    /// right spread; the 1/2/3-sigma masses are what identify the shape.
    #[test]
    fn randn_is_standard_normal() {
        let n = 200_000;
        let xs = draws(n, |i| randn_at(2, i));

        let m = mean(&xs);
        assert!((m - 0.0).abs() < 0.01, "mean {}", m);
        let v = variance(&xs);
        assert!((v - 1.0).abs() < 0.02, "variance {}", v);

        let within = |k: f64| xs.iter().filter(|x| x.abs() < k).count() as f64 / n as f64;
        assert!((within(1.0) - 0.6827).abs() < 0.01, "1s {}", within(1.0));
        assert!((within(2.0) - 0.9545).abs() < 0.01, "2s {}", within(2.0));
        assert!((within(3.0) - 0.9973).abs() < 0.005, "3s {}", within(3.0));
        assert!(xs.iter().all(|x| x.is_finite()));
    }

    /// Consecutive draws must be independent: a normal generator that pairs up
    /// its uniforms wrongly shows up as lag-1 correlation.
    #[test]
    fn successive_normal_draws_are_independent() {
        let n = 100_000;
        let xs = draws(n, |i| randn_at(3, i));
        let m = mean(&xs);
        let cov: f64 = xs.windows(2).map(|w| (w[0] - m) * (w[1] - m)).sum::<f64>() / n as f64;
        assert!(cov.abs() < 0.01, "lag-1 covariance {}", cov);
    }

    /// Adjacent seeds are what users type. They must still name unrelated
    /// streams.
    #[test]
    fn adjacent_seeds_are_unrelated() {
        let a: Vec<f64> = (1..=20u64).map(rand).collect();
        let b: Vec<f64> = (2..=21u64).map(rand).collect();
        assert!(a.iter().zip(&b).all(|(x, y)| x != y));
        // And they are spread over the interval, not clustered.
        let m = mean(&a);
        assert!((0.3..0.7).contains(&m), "mean of 20 draws {}", m);
    }

    /// Per-site seeds derived from one document seed must not correlate — the
    /// mechanism behind "two noise sources in one model are independent".
    #[test]
    fn derived_seeds_give_independent_streams() {
        let doc = 12345u64;
        let n = 4000;
        let series = |site: u64| -> Vec<f64> {
            let s = derive_seed(doc, site);
            (0..n).map(|i| smooth(i as f64 * 0.017, 1.0, s)).collect()
        };
        for i in 0..4u64 {
            for j in (i + 1)..5u64 {
                let (x, y) = (series(i), series(j));
                let (mx, my) = (mean(&x), mean(&y));
                let cov: f64 = x
                    .iter()
                    .zip(&y)
                    .map(|(a, b)| (a - mx) * (b - my))
                    .sum::<f64>();
                let vx: f64 = x.iter().map(|a| (a - mx) * (a - mx)).sum();
                let vy: f64 = y.iter().map(|b| (b - my) * (b - my)).sum();
                let r = cov / (vx.sqrt() * vy.sqrt());
                assert!(r.abs() < 0.15, "sites {},{}: r = {}", i, j, r);
            }
        }
    }
}

/// The tests that justify the design.
///
/// Everything else in this crate is a consequence of wanting these two to hold
/// at once: noise that a fifth-order adaptive solver walks straight through,
/// and a trajectory that is the same every time you ask for it.
#[cfg(test)]
mod integration {
    use super::*;
    use numpla_ode::{solve, Field, Opts, SolveError};

    /// `x' = -x + 0.5*smooth(t)`: a first-order lag driven by noise, the
    /// smallest model anyone would actually write. It has to integrate the way
    /// any other forced linear system does — a sane number of accepted steps,
    /// no rejection spiral, no `StepTooSmall`.
    #[test]
    fn noise_driven_ode_actually_integrates() {
        let sys = Field::new(1, |t: f64, y: &[f64], dy: &mut [f64]| {
            dy[0] = -y[0] + 0.5 * smooth(t, DEFAULT_RATE, 7);
        });
        let sol = solve(&sys, (0.0, 50.0), &[0.0], &Opts::default()).expect("noise must integrate");

        let tel = &sol.telemetry;
        // 50 time units of unit-rate noise at rtol 1e-6. A few hundred steps is
        // the right order; thousands would mean the forcing is fighting the
        // controller, and `StepTooSmall` would mean it had won.
        assert!(
            tel.accepted > 20 && tel.accepted < 2_000,
            "accepted {} steps",
            tel.accepted
        );
        // Rejections are how a collapsing step shows up before it collapses.
        assert!(
            tel.rejected * 4 < tel.accepted,
            "{} rejected vs {} accepted",
            tel.rejected,
            tel.accepted
        );
        // The response of a stable lag stays bounded by its forcing.
        assert!(sol.y_end[0].abs() < 2.0, "y_end {}", sol.y_end[0]);
        assert!(sol.eval(37.5)[0].is_finite());
    }

    /// And solving it twice gives the same numbers — bit for bit, including
    /// the step sequence. This is what makes scrubbing time backwards show the
    /// same picture, and what makes a saved document reproduce.
    #[test]
    fn solving_twice_is_identical() {
        let build = || {
            Field::new(1, |t: f64, y: &[f64], dy: &mut [f64]| {
                dy[0] = -y[0] + 0.5 * smooth(t, DEFAULT_RATE, 7);
            })
        };
        let a = solve(&build(), (0.0, 50.0), &[0.0], &Opts::default()).unwrap();
        let b = solve(&build(), (0.0, 50.0), &[0.0], &Opts::default()).unwrap();

        assert_eq!(a.telemetry.accepted, b.telemetry.accepted);
        assert_eq!(a.telemetry.rejected, b.telemetry.rejected);
        assert_eq!(a.y_end[0].to_bits(), b.y_end[0].to_bits());
        for i in 0..500 {
            let t = i as f64 * 0.1;
            assert_eq!(a.eval(t)[0].to_bits(), b.eval(t)[0].to_bits(), "at t = {}", t);
        }
    }

    /// The counter-example, and the reason the rule at the top of this file is
    /// a rule. Same equation, same tolerances, but the forcing is drawn fresh
    /// on every call instead of being a function of `t`. The error estimator
    /// now measures the disagreement between calls rather than the truncation
    /// error, so no step size is ever small enough and the solve dies — with
    /// `StepTooSmall` if it collapses fast, or `TooManySteps` after the
    /// controller settles on a step far below anything the problem needs.
    ///
    /// This is not a hypothetical hazard being documented; it is the failure
    /// mode a `rand()` builtin would ship.
    #[test]
    fn a_non_deterministic_rhs_fails_to_integrate() {
        use std::cell::Cell;

        let calls = Cell::new(0i64);
        let sys = Field::new(1, |_t: f64, y: &[f64], dy: &mut [f64]| {
            let n = calls.get();
            calls.set(n + 1);
            // Exactly the same amplitude of forcing as the test above — the
            // only difference is that it is a function of the call, not of t.
            dy[0] = -y[0] + 0.5 * (2.0 * rand_at(7, n) - 1.0);
        });
        let err = solve(&sys, (0.0, 50.0), &[0.0], &Opts::default()).unwrap_err();
        assert!(
            matches!(
                err,
                SolveError::StepTooSmall { .. } | SolveError::TooManySteps { .. }
            ),
            "expected the solve to collapse, got {:?}",
            err
        );
    }

    /// Every kind is integrable, not just the recommended one — including
    /// `telegraph`, whose ramped edges are the whole reason it is usable as
    /// forcing at all.
    #[test]
    fn every_kind_is_integrable() {
        for kind in Kind::ALL {
            let sys = Field::new(1, move |t: f64, y: &[f64], dy: &mut [f64]| {
                dy[0] = -y[0] + 0.5 * value(kind, t, 1.0, 3);
            });
            let sol = solve(&sys, (0.0, 20.0), &[0.0], &Opts::default())
                .unwrap_or_else(|e| panic!("{:?} failed to integrate: {:?}", kind, e));
            assert!(
                sol.telemetry.accepted < 5_000,
                "{:?} needed {} steps",
                kind,
                sol.telemetry.accepted
            );
            assert!(sol.y_end[0].is_finite());
        }
    }

    /// Raising `rate` costs steps, in proportion. That is the honest price of
    /// the parameter and the reason it belongs in the user's hands rather than
    /// buried as a constant: a document that suddenly integrates slowly should
    /// point at a knob the user turned.
    #[test]
    fn rate_costs_steps() {
        let steps = |rate: f64| {
            let sys = Field::new(1, move |t: f64, y: &[f64], dy: &mut [f64]| {
                dy[0] = -y[0] + 0.5 * smooth(t, rate, 7);
            });
            solve(&sys, (0.0, 20.0), &[0.0], &Opts::default())
                .unwrap()
                .telemetry
                .accepted
        };
        assert!(steps(16.0) > steps(1.0), "faster noise should cost steps");
    }
}
