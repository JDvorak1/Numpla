//! Noise signals: `n(t)`, pure, band-limited, cheap.

use crate::rng::{hash, scramble, signed_unit, substream};

/// Lattice points per unit of time when the caller does not say otherwise.
///
/// One is deliberate rather than arbitrary: a Numpla document's time axis is
/// usually seconds, and noise that wanders on the scale of a second is what a
/// first look at `x' = -x + smooth(t)` should show. Anything faster looks like
/// a solid band and hides the shape.
pub const DEFAULT_RATE: f64 = 1.0;

/// The seed a document starts with. Every stream derives from it.
pub const DEFAULT_SEED: u64 = 0;

/// A rate must be positive and finite to define a lattice. Zero or negative
/// rates are clamped here rather than producing NaN: a slider dragged to the
/// bottom of its range must not poison a trajectory, and the limit is
/// physically meaningful anyway — as `rate` goes to zero the lattice cell grows
/// without bound and the signal becomes a constant.
const MIN_RATE: f64 = 1e-12;

/// Fraction of a lattice cell a [`Kind::Telegraph`] edge is ramped over.
///
/// Small enough that the signal sits at exactly +/-1 for 85% of every cell,
/// large enough that the edge is resolvable by the step controller.
const TELEGRAPH_EDGE: f64 = 0.15;

/// The six spectra of `docs/noise.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    /// Flat spectrum up to the lattice cutoff. Harsh; forcing and dither.
    White,
    /// `1/f`. Equal power per octave — the spectrum most physical noise has.
    Pink,
    /// `1/f^2`. Drifts and wanders; slow parameter drift.
    ///
    /// Not a Wiener process: it does not rescale correctly under step
    /// refinement and must not be used as one. Genuine Brownian motion needs a
    /// fixed-step SDE solver with a Brownian bridge, which is a separate
    /// mechanism — see `docs/noise.md`.
    Brown,
    /// `f`. Thin and hissy; the complement of pink.
    Blue,
    /// A single band-limited lattice. Rolling, continuous, and the safest
    /// default for driving a physical model.
    Smooth,
    /// Two-state, switching between +/-1 on the lattice.
    Telegraph,
}

/// How many octaves each kind sums, and how the amplitude changes per octave.
///
/// Octave `j = 0` is the finest lattice (spacing `1/rate`); each further octave
/// halves the frequency. For a spectrum `S(f) ~ f^-beta`, the power in the
/// octave ending at `f` is proportional to `f^(1-beta)`, so the per-octave
/// amplitude ratio going coarser is `2^((beta-1)/2)`. That one line is the
/// whole difference between these signals: white, pink, brown and blue run
/// identical code with a different ratio.
///
/// Two different rules set the octave counts, and the reason is the cost:
/// every octave is two more hashes on a path the integrator walks six times
/// per step. Where the amplitude decays going coarser (white, blue) the count
/// is where the remaining variance drops under ~2%. Where it does not (pink,
/// brown) nothing converges, so the count is a judgement about the slowest
/// wobble a user should see — six octaves puts it at 32 lattice cells, which
/// reads as drift over a typical time span without turning into a constant
/// offset.
///
/// `norm` scales the sum to unit RMS: `1 / (LATTICE_RMS * sqrt(sum a_j^2))`.
/// Every kind lands on the same amplitude so that swapping `smooth(t)` for
/// `pink(t)` in a model does not silently rescale the forcing.
struct Spectrum {
    octaves: u32,
    ratio: f64,
    norm: f64,
}

/// RMS of one octave of value noise: `sqrt(2/3 * integral of fade^2)`, with
/// lattice values uniform on `[-1, 1)`. Derived, not measured — but
/// `normalisation_constants_match_their_derivation` re-derives them from it.
#[cfg(test)]
const LATTICE_RMS: f64 = 0.511_060_917_291_924_9;

impl Kind {
    /// Name as written in the math language.
    pub const fn name(self) -> &'static str {
        match self {
            Kind::White => "white",
            Kind::Pink => "pink",
            Kind::Brown => "brown",
            Kind::Blue => "blue",
            Kind::Smooth => "smooth",
            Kind::Telegraph => "telegraph",
        }
    }

    /// Look a kind up by the name the parser produced. Keeps `numpla-expr`'s
    /// builtin table from drifting away from this crate's list.
    pub fn from_name(name: &str) -> Option<Kind> {
        match name {
            "white" => Some(Kind::White),
            "pink" => Some(Kind::Pink),
            "brown" => Some(Kind::Brown),
            "blue" => Some(Kind::Blue),
            "smooth" => Some(Kind::Smooth),
            "telegraph" => Some(Kind::Telegraph),
            _ => None,
        }
    }

    /// Every kind Numpla exposes, in the order `docs/noise.md` lists them.
    pub const ALL: [Kind; 6] = [
        Kind::White,
        Kind::Pink,
        Kind::Brown,
        Kind::Blue,
        Kind::Smooth,
        Kind::Telegraph,
    ];

    /// A distinct constant per kind, folded into the seed.
    ///
    /// Without this, `white(t)` and `pink(t)` on the default document seed
    /// would be built from the *same* octave streams and differ only in how
    /// they weight them — which is a correlation of about 0.8, and exactly the
    /// accidental coupling between two noise sources in one model that the
    /// spec says must not happen. Changing the kind has to change the stream.
    const fn salt(self) -> u64 {
        match self {
            Kind::White => 0x243F_6A88_85A3_08D3,
            Kind::Pink => 0x1319_8A2E_0370_7344,
            Kind::Brown => 0xA409_3822_299F_31D0,
            Kind::Blue => 0x082E_FA98_EC4E_6C89,
            Kind::Smooth => 0x4528_21E6_38D0_1377,
            Kind::Telegraph => 0xBE54_66CF_34E9_0C6C,
        }
    }

    const fn spectrum(self) -> Spectrum {
        match self {
            // beta = 0: ratio 2^-0.5, sum a_j^2 = 1.96875 over 6 octaves.
            Kind::White => Spectrum {
                octaves: 6,
                ratio: std::f64::consts::FRAC_1_SQRT_2,
                norm: 1.394_543_431_096_877_2,
            },
            // beta = 1: ratio 1, sum = 6 over 6 octaves. Equal power per
            // octave, so nothing here converges — the octave count is a
            // decision about the slowest wobble the user should see, and six
            // octaves puts it at 32 lattice cells.
            Kind::Pink => Spectrum {
                octaves: 6,
                ratio: 1.0,
                norm: 0.798_825_104_113_109_2,
            },
            // beta = 2: ratio 2^0.5, sum = 63 over 6 octaves. The coarsest
            // octave dominates, which is exactly the wandering character; six
            // octaves means it wanders on the scale of ~32/rate, slow enough
            // to read as drift over a typical time span and not so slow that
            // it degenerates into a constant offset.
            Kind::Brown => Spectrum {
                octaves: 6,
                ratio: std::f64::consts::SQRT_2,
                norm: 0.246_522_779_196_939_18,
            },
            // beta = -1: ratio 0.5, sum = 1.328125 over 4 octaves. Amplitude
            // falls off fastest of all, so four octaves is already convergent.
            Kind::Blue => Spectrum {
                octaves: 4,
                ratio: 0.5,
                norm: 1.697_883_367_549_646_3,
            },
            // One octave: the lattice itself, nothing below it.
            Kind::Smooth => Spectrum {
                octaves: 1,
                ratio: 1.0,
                norm: 1.956_713_898_802_765_3,
            },
            // Telegraph does not sum octaves; it is already +/-1.
            Kind::Telegraph => Spectrum {
                octaves: 1,
                ratio: 1.0,
                norm: 1.0,
            },
        }
    }
}

/// A noise source. Construct it and ask for values; it never mutates.
///
/// `Copy` and constructor-cheap on purpose — the expression evaluator builds
/// one per call inside the integrator's inner loop rather than caching them,
/// and that has to cost a single hash.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Noise {
    kind: Kind,
    rate: f64,
    /// Pre-scrambled seed. Storing the scrambled form keeps the per-sample
    /// path down to one mix per lattice point.
    stream: u64,
}

impl Noise {
    pub fn new(kind: Kind, rate: f64, seed: u64) -> Self {
        let rate = if rate.is_finite() && rate > MIN_RATE {
            rate
        } else {
            MIN_RATE
        };
        Noise {
            kind,
            rate,
            stream: scramble(seed ^ kind.salt()),
        }
    }

    pub fn kind(&self) -> Kind {
        self.kind
    }

    pub fn rate(&self) -> f64 {
        self.rate
    }

    /// The signal at time `t`. Pure: same `t`, same seed, same bits, forever.
    pub fn at(&self, t: f64) -> f64 {
        if !t.is_finite() {
            return 0.0;
        }
        match self.kind {
            Kind::Telegraph => self.telegraph(t),
            _ => self.fbm(t),
        }
    }

    /// Sum of octaves of value noise. One multiply per octave keeps the
    /// amplitude and frequency schedules out of `powf`.
    fn fbm(&self, t: f64) -> f64 {
        let Spectrum {
            octaves,
            ratio,
            norm,
        } = self.kind.spectrum();
        let mut sum = 0.0;
        let mut amp = 1.0;
        let mut x = lattice_position(t * self.rate);
        for j in 0..octaves {
            // Each octave gets its own sub-stream, so octaves cannot line up
            // and produce a spurious periodic component.
            let stream = substream(self.stream, j as u64);
            sum += amp * value_noise(stream, x);
            amp *= ratio;
            // Halving the position is halving the octave's frequency, and it
            // cannot overflow the way multiplying the time by a frequency can.
            x *= 0.5;
        }
        sum * norm
    }

    /// Two-state noise, +/-1, one independent coin per lattice cell.
    ///
    /// An ideal telegraph signal steps discontinuously, and a discontinuous
    /// right-hand side defeats the step controller for the same reason a
    /// non-deterministic one does: the embedded error estimate sees the jump,
    /// not the truncation error, and the step collapses. So the edge is ramped
    /// over [`TELEGRAPH_EDGE`] of a cell with the same quintic fade used
    /// everywhere else, which is C2 where it meets the flat parts. The result
    /// is still two-state — it sits at exactly +/-1 for most of every cell —
    /// but it is something an adaptive solver can walk over.
    fn telegraph(&self, t: f64) -> f64 {
        let x = lattice_position(t * self.rate);
        let i = floor_index(x);
        let u = x - i as f64;
        let here = coin(self.stream, i);
        if u >= TELEGRAPH_EDGE {
            return here;
        }
        let before = coin(self.stream, i.wrapping_sub(1));
        before + (here - before) * fade(u / TELEGRAPH_EDGE)
    }
}

/// Perlin's quintic fade, `6u^5 - 15u^4 + 10u^3`.
///
/// The interpolation choice is the one place this crate has to answer to the
/// integrator. Linear interpolation would be C0: the derivative of the forcing
/// jumps at every lattice point, Tsit5's embedded estimator reads that kink as
/// error, and the controller shrinks the step to resolve a corner that never
/// resolves. A cubic (smoothstep) fixes the derivative but leaves the curvature
/// discontinuous, which a fifth-order method still notices. The quintic fade
/// has `s(0)=0, s(1)=1` and vanishing first *and* second derivatives at both
/// ends, so the interpolant is C2 across every lattice point and the solver
/// sees a smooth signal at the cost of two extra multiplies.
///
/// The price is that `n'(t)` is zero at every lattice point — the standard
/// value-noise artefact. That is a visible regularity only when `rate` is low
/// and the signal is plotted alone; against the benefit of an integrable
/// signal it is the right trade, and summing octaves hides it for every kind
/// except `smooth`.
#[inline]
fn fade(u: f64) -> f64 {
    u * u * u * (u * (u * 6.0 - 15.0) + 10.0)
}

/// Value noise: interpolate between two hashed lattice values.
#[inline]
fn value_noise(stream: u64, x: f64) -> f64 {
    let i = floor_index(x);
    let u = x - i as f64;
    let a = signed_unit(hash(stream, i));
    let b = signed_unit(hash(stream, i.wrapping_add(1)));
    a + (b - a) * fade(u)
}

/// A hashed +/-1 for one lattice cell.
#[inline]
fn coin(stream: u64, i: i64) -> f64 {
    if hash(stream, i) & 1 == 0 {
        -1.0
    } else {
        1.0
    }
}

/// `floor` as a lattice index. Rust's float-to-int casts saturate rather than
/// wrap or trap, so an absurd `t` gives a clamped index instead of nonsense.
#[inline]
fn floor_index(x: f64) -> i64 {
    x.floor() as i64
}

/// Largest lattice position with any fractional resolution left.
///
/// Past 2^52 an `f64` cannot represent the offset within a cell at all, so
/// `x - floor(x)` is identically zero and the signal is meaningless anyway.
/// Clamping there — rather than letting `t * rate` reach infinity and produce
/// a NaN — costs one comparison per evaluation and guarantees the invariant
/// the solver depends on: this function never returns anything but a finite
/// number.
const MAX_POSITION: f64 = 4.503_599_627_370_496e15;

#[inline]
fn lattice_position(x: f64) -> f64 {
    if x.is_nan() {
        0.0
    } else {
        x.clamp(-MAX_POSITION, MAX_POSITION)
    }
}

/// `white(t, rate, seed)`.
pub fn white(t: f64, rate: f64, seed: u64) -> f64 {
    Noise::new(Kind::White, rate, seed).at(t)
}

/// `pink(t, rate, seed)`.
pub fn pink(t: f64, rate: f64, seed: u64) -> f64 {
    Noise::new(Kind::Pink, rate, seed).at(t)
}

/// `brown(t, rate, seed)`.
pub fn brown(t: f64, rate: f64, seed: u64) -> f64 {
    Noise::new(Kind::Brown, rate, seed).at(t)
}

/// `blue(t, rate, seed)`.
pub fn blue(t: f64, rate: f64, seed: u64) -> f64 {
    Noise::new(Kind::Blue, rate, seed).at(t)
}

/// `smooth(t, rate, seed)`.
pub fn smooth(t: f64, rate: f64, seed: u64) -> f64 {
    Noise::new(Kind::Smooth, rate, seed).at(t)
}

/// `telegraph(t, rate, seed)`.
pub fn telegraph(t: f64, rate: f64, seed: u64) -> f64 {
    Noise::new(Kind::Telegraph, rate, seed).at(t)
}

/// One call, by kind. The evaluator's dispatch target.
pub fn value(kind: Kind, t: f64, rate: f64, seed: u64) -> f64 {
    Noise::new(kind, rate, seed).at(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sample a kind on a regular grid. A grid is fine for statistics here
    /// because the lattice rate and the sample rate are deliberately
    /// incommensurate.
    fn samples(kind: Kind, n: usize, dt: f64, rate: f64, seed: u64) -> Vec<f64> {
        let noise = Noise::new(kind, rate, seed);
        (0..n).map(|i| noise.at(i as f64 * dt)).collect()
    }

    fn mean(xs: &[f64]) -> f64 {
        xs.iter().sum::<f64>() / xs.len() as f64
    }

    fn rms(xs: &[f64]) -> f64 {
        (xs.iter().map(|x| x * x).sum::<f64>() / xs.len() as f64).sqrt()
    }

    /// Mean absolute successive difference: a roughness proxy. It is the
    /// discrete first derivative averaged, so it grows with high-frequency
    /// content — no FFT needed to rank spectra by it.
    fn roughness(xs: &[f64]) -> f64 {
        xs.windows(2).map(|w| (w[1] - w[0]).abs()).sum::<f64>() / (xs.len() - 1) as f64
    }

    /// Typical size of the window average, over an ensemble of seeds.
    ///
    /// A window average kills everything oscillating faster than the window
    /// and passes everything slower, so this is a low-pass measurement: it is
    /// large exactly when the signal has power below `1/window`. That is the
    /// half of the spectrum [`roughness`] is blind to.
    ///
    /// It has to be taken over an ensemble rather than from one seed, because
    /// for a single seed it is one draw of a random variable — a signal that
    /// wanders will sometimes wander back to zero.
    /// Ensemble size and window for [`drift`]. The window has to be long
    /// compared with the slowest octave (32 lattice cells) for the ratios
    /// between kinds to settle; 1000 units is about thirty of them.
    const DRIFT_SEEDS: u64 = 48;
    const DRIFT_N: usize = 10_000;
    const DRIFT_DT: f64 = 0.1;

    fn drift(kind: Kind, seeds: u64, n: usize, dt: f64, rate: f64) -> f64 {
        let mut acc = 0.0;
        for seed in 0..seeds {
            acc += mean(&samples(kind, n, dt, rate, seed)).powi(2);
        }
        (acc / seeds as f64).sqrt()
    }

    fn correlation(a: &[f64], b: &[f64]) -> f64 {
        let (ma, mb) = (mean(a), mean(b));
        let (mut cov, mut va, mut vb) = (0.0, 0.0, 0.0);
        for (x, y) in a.iter().zip(b) {
            cov += (x - ma) * (y - mb);
            va += (x - ma) * (x - ma);
            vb += (y - mb) * (y - mb);
        }
        cov / (va.sqrt() * vb.sqrt())
    }

    // ---- determinism ----------------------------------------------------

    /// The rule the whole crate exists to enforce: same t, same seed, same
    /// bits. Not "close" — bit-identical, because the solver compares two
    /// evaluations of the same interval and any difference at all is read as
    /// truncation error.
    #[test]
    fn repeated_calls_are_bit_identical() {
        for kind in Kind::ALL {
            let n = Noise::new(kind, 3.0, 42);
            for i in 0..500 {
                let t = i as f64 * 0.0137;
                let first = n.at(t);
                for _ in 0..4 {
                    assert_eq!(n.at(t).to_bits(), first.to_bits(), "{:?} at {}", kind, t);
                }
            }
        }
    }

    /// Freshly built generators must agree with old ones: there is no hidden
    /// state, so re-solving a document after an edit reproduces it exactly.
    #[test]
    fn fresh_generators_agree() {
        for kind in Kind::ALL {
            for i in 0..200 {
                let t = i as f64 * 0.031;
                let a = Noise::new(kind, 2.5, 9).at(t);
                let b = Noise::new(kind, 2.5, 9).at(t);
                assert_eq!(a.to_bits(), b.to_bits(), "{:?}", kind);
            }
        }
    }

    /// Evaluation order must not matter either — an adaptive solver revisits
    /// times out of order (rejected steps, then dense output while scrubbing).
    #[test]
    fn order_of_evaluation_does_not_matter() {
        let n = Noise::new(Kind::Pink, 1.5, 3);
        let forward: Vec<f64> = (0..300).map(|i| n.at(i as f64 * 0.05)).collect();
        let backward: Vec<f64> = (0..300).rev().map(|i| n.at(i as f64 * 0.05)).collect();
        for (i, v) in backward.iter().rev().enumerate() {
            assert_eq!(v.to_bits(), forward[i].to_bits());
        }
    }

    // ---- independence ---------------------------------------------------

    /// Correlations between every pair of seeds 1..=8, for one kind.
    fn seed_pair_correlations(kind: Kind) -> Vec<f64> {
        let series: Vec<Vec<f64>> = (1..=8u64)
            .map(|s| samples(kind, 30_000, 0.02, 1.0, s))
            .collect();
        let mut out = Vec::new();
        for a in 0..series.len() {
            for b in (a + 1)..series.len() {
                out.push(correlation(&series[a], &series[b]));
            }
        }
        out
    }

    /// Two noise sources in one model must not correlate by accident. Seeds
    /// 1..8 are the seeds a user actually types, and they are adjacent inputs
    /// to the hash, so this is the case most likely to fail.
    ///
    /// The statistic is the *mean* correlation over all 28 pairs, not each
    /// pair on its own. A single pair's correlation has real sampling width:
    /// a 600-unit window holds only ~20 independent draws of brown's slowest
    /// octave, so an individual `r` of 0.2 says nothing. Averaging 28 pairs
    /// narrows that by more than five, while any *systematic* coupling — a
    /// shared stream, an octave schedule that ignores the seed, seeds that
    /// alias onto each other — survives the average and would show up as an
    /// `r` near 1. The per-pair bound is the second half of that: it catches a
    /// single colliding pair that the mean would dilute.
    #[test]
    fn different_seeds_are_uncorrelated() {
        for kind in Kind::ALL {
            let rs = seed_pair_correlations(kind);
            let m = mean(&rs);
            assert!(m.abs() < 0.05, "{:?}: mean correlation {}", kind, m);
            for r in &rs {
                assert!(r.abs() < 0.5, "{:?}: a pair correlated at {}", kind, r);
            }
        }
    }

    /// Different kinds on the same seed must be independent too. This is the
    /// case the design nearly got wrong: every kind is built from the same
    /// octave machinery, so without a per-kind salt `white(t)` and `pink(t)`
    /// on the default document seed are the same octave streams under
    /// different weights, and correlate at about 0.8.
    #[test]
    fn different_kinds_on_one_seed_are_independent() {
        for a in 0..Kind::ALL.len() {
            for b in (a + 1)..Kind::ALL.len() {
                let (ka, kb) = (Kind::ALL[a], Kind::ALL[b]);
                let xs = samples(ka, 30_000, 0.02, 1.0, DEFAULT_SEED);
                let ys = samples(kb, 30_000, 0.02, 1.0, DEFAULT_SEED);
                let r = correlation(&xs, &ys);
                assert!(r.abs() < 0.35, "{:?} vs {:?}: r = {}", ka, kb, r);
            }
        }
    }

    // ---- continuity -----------------------------------------------------

    /// `smooth` has no jumps, and the bound scales with the sample spacing —
    /// which is the statement that the signal is Lipschitz, not merely
    /// jump-free. A discontinuous signal would fail the second half even
    /// though it passed the first.
    #[test]
    fn smooth_is_continuous_and_lipschitz() {
        let n = Noise::new(Kind::Smooth, 4.0, 11);
        let mut worst_coarse: f64 = 0.0;
        let mut worst_fine: f64 = 0.0;
        for i in 0..20_000 {
            let t = i as f64 * 1e-3;
            worst_coarse = worst_coarse.max((n.at(t + 1e-3) - n.at(t)).abs());
            worst_fine = worst_fine.max((n.at(t + 1e-4) - n.at(t)).abs());
        }
        assert!(worst_coarse < 0.05, "jump of {}", worst_coarse);
        // Ten times closer samples, roughly ten times smaller steps.
        assert!(
            worst_fine < worst_coarse * 0.2,
            "not Lipschitz: {} vs {}",
            worst_fine,
            worst_coarse
        );
    }

    /// The derivative is continuous too, which is the property the step
    /// controller actually depends on: a kink in `f` is read as error, and the
    /// controller answers a kink by shrinking the step forever.
    ///
    /// Absolute bounds prove nothing here — the derivative is genuinely large
    /// at rate 4 and moves a lot over any finite gap. What identifies
    /// continuity is the *scaling*: sample the numerical derivative at two
    /// points a gap apart, and the change must shrink in proportion to the
    /// gap. Linear interpolation would fail this outright (the change across a
    /// lattice point does not shrink at all, however small the gap gets).
    #[test]
    fn smooth_has_a_continuous_derivative() {
        let n = Noise::new(Kind::Smooth, 4.0, 11);
        let h = 1e-6;
        let d = |t: f64| (n.at(t + h) - n.at(t - h)) / (2.0 * h);
        let worst_over = |gap: f64| {
            let mut worst: f64 = 0.0;
            // Step across lattice points, where a kink would live.
            for i in 0..40_000 {
                let t = i as f64 * 1e-3;
                worst = worst.max((d(t + gap) - d(t)).abs());
            }
            worst
        };
        let coarse = worst_over(1e-3);
        let fine = worst_over(1e-4);
        assert!(coarse < 1.0, "derivative moves by {} over 1e-3", coarse);
        assert!(
            fine < coarse * 0.2,
            "derivative is not continuous: {} over 1e-4 vs {} over 1e-3",
            fine,
            coarse
        );
    }

    /// Every kind is bounded, including at absurd times. NaN in a right-hand
    /// side is fatal to the solver, so this is a hard requirement, not hygiene.
    #[test]
    fn every_kind_is_finite_and_bounded() {
        for kind in Kind::ALL {
            let n = Noise::new(kind, 2.0, 4);
            for t in [0.0, -1e3, 1e3, -1e12, 1e12, f64::MAX, f64::MIN] {
                let v = n.at(t);
                assert!(v.is_finite(), "{:?} at {}: {}", kind, t, v);
                assert!(v.abs() < 8.0, "{:?} at {}: {}", kind, t, v);
            }
            assert_eq!(n.at(f64::NAN), 0.0);
            assert_eq!(n.at(f64::INFINITY), 0.0);
        }
    }

    /// A rate of zero (or negative, or infinite) is a slider position, not a
    /// bug report. It must degrade to a constant rather than to NaN.
    #[test]
    fn degenerate_rates_stay_finite() {
        for rate in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            for kind in Kind::ALL {
                let n = Noise::new(kind, rate, 1);
                assert!(n.at(0.0).is_finite());
                assert!(n.at(10.0).is_finite());
            }
        }
    }

    // ---- spectral character ---------------------------------------------

    /// Roughness ranks the spectra. Mean absolute successive difference is a
    /// discrete derivative, and differentiating multiplies the spectrum by f,
    /// so a signal with more high-frequency content must score higher. If
    /// `blue > white > pink > brown` holds, the four really are the spectral
    /// family they claim to be — no FFT required to see it.
    #[test]
    fn roughness_orders_the_spectra() {
        let (n, dt, rate, seed) = (60_000, 0.01, 1.0, 17);
        let r = |k| roughness(&samples(k, n, dt, rate, seed));
        let (blue, white, pink, brown) = (
            r(Kind::Blue),
            r(Kind::White),
            r(Kind::Pink),
            r(Kind::Brown),
        );
        assert!(blue > white, "blue {} !> white {}", blue, white);
        assert!(white > pink, "white {} !> pink {}", white, pink);
        assert!(pink > brown, "pink {} !> brown {}", pink, brown);
        // The spread is a factor, not a rounding difference.
        assert!(blue > 4.0 * brown, "blue {} vs brown {}", blue, brown);
    }

    /// `smooth` is exactly one octave: it lives *at* the lattice scale and has
    /// no content anywhere else. That is what "band-limited lattice" in the
    /// spec means, and it is the reason it is the recommended default — the
    /// signal is entirely described by `rate`, with nothing hiding at scales
    /// the user did not ask for.
    ///
    /// Two measurements pin it. Its roughness sits in the same range as the
    /// kinds that also put most of their energy at the top of the band —
    /// white and blue — because all three share the same finest lattice.
    /// (Brown is deliberately excluded: it is an order of magnitude smoother
    /// at the top, which is the whole point of brown.) And it must drift
    /// *less* than every other kind, because it has nothing below that octave
    /// at all.
    #[test]
    fn smooth_is_a_single_band() {
        let (n, dt, rate, seed) = (60_000, 0.01, 1.0, 17);
        let s = roughness(&samples(Kind::Smooth, n, dt, rate, seed));
        for k in [Kind::White, Kind::Blue] {
            let other = roughness(&samples(k, n, dt, rate, seed));
            let ratio = s / other;
            assert!(
                (0.5..2.0).contains(&ratio),
                "smooth {} against {:?} {}: ratio {}",
                s,
                k,
                other,
                ratio
            );
        }

        let smooth_drift = drift(Kind::Smooth, DRIFT_SEEDS, DRIFT_N, DRIFT_DT, 1.0);
        for k in [Kind::White, Kind::Pink, Kind::Brown, Kind::Blue] {
            let other = drift(k, DRIFT_SEEDS, DRIFT_N, DRIFT_DT, 1.0);
            assert!(
                smooth_drift < other,
                "smooth drifts {} but {:?} only {}",
                smooth_drift,
                k,
                other
            );
        }
    }

    /// Brown wanders and white does not. Power at frequencies below the
    /// averaging window is exactly what stops a window mean from settling on
    /// zero, so [`drift`] measures the low-frequency half of the spectral
    /// claim — the half roughness is blind to. Roughness ranks the kinds at
    /// the top of the band and drift ranks them at the bottom; between them
    /// the spectrum is pinned at both ends, with the same ordering
    /// (`blue, white, pink, brown`) running one way for one statistic and the
    /// other way for the other. That reversal is the signature of a spectral
    /// family and is hard to produce by accident.
    #[test]
    fn brown_wanders_and_white_does_not() {
        let d = |k| drift(k, DRIFT_SEEDS, DRIFT_N, DRIFT_DT, 1.0);
        let (blue, white, pink, brown) =
            (d(Kind::Blue), d(Kind::White), d(Kind::Pink), d(Kind::Brown));
        // Margins rather than bare inequalities, so a change that merely
        // blurs the distinction still fails. The margins cannot be arbitrarily
        // large: every kind is normalised to unit variance, so how far brown
        // can outdrift white is capped by how much of that one unit of
        // variance sits below 1/window — with six octaves that ceiling is
        // about 2.8, which is what this measures.
        assert!(brown > 2.5 * white, "brown {} vs white {}", brown, white);
        assert!(
            pink > 1.4 * white,
            "pink {} should drift more than white {}",
            pink,
            white
        );
        assert!(
            white > 1.2 * blue,
            "white {} should drift more than blue {}",
            white,
            blue
        );
    }

    /// Rate is a real parameter with real consequences, as the spec insists:
    /// doubling it must double the roughness of the signal, not merely change
    /// the shape. This is also what makes rate worth exposing to the user.
    #[test]
    fn rate_sets_the_time_scale() {
        let slow = roughness(&samples(Kind::Smooth, 40_000, 0.005, 1.0, 8));
        let fast = roughness(&samples(Kind::Smooth, 40_000, 0.005, 4.0, 8));
        let ratio = fast / slow;
        assert!(
            (2.5..5.5).contains(&ratio),
            "4x rate gave {}x roughness",
            ratio
        );
    }

    /// Amplitudes are comparable across kinds, so swapping `smooth(t)` for
    /// `pink(t)` in a model does not silently rescale the forcing by 10x.
    #[test]
    fn unit_rms_across_kinds() {
        for kind in [Kind::White, Kind::Pink, Kind::Brown, Kind::Blue, Kind::Smooth] {
            let mut acc = 0.0;
            // Average over seeds: one seed of brown is dominated by a single
            // slow octave, so its RMS over a short window is a lottery.
            let seeds = 24;
            for seed in 0..seeds {
                let xs = samples(kind, 20_000, 0.011, 1.0, seed);
                acc += rms(&xs).powi(2);
            }
            let r = (acc / seeds as f64).sqrt();
            assert!((0.6..1.6).contains(&r), "{:?} rms = {}", kind, r);
        }
    }

    /// The baked normalisation constants are not magic numbers: re-derive
    /// them from the octave schedule and the analytic lattice RMS. If someone
    /// changes an octave count and forgets the constant, this catches it.
    #[test]
    fn normalisation_constants_match_their_derivation() {
        for (kind, expected_sum) in [
            (Kind::White, 1.968_75),
            (Kind::Pink, 6.0),
            (Kind::Brown, 63.0),
            (Kind::Blue, 1.328_125),
            (Kind::Smooth, 1.0),
        ] {
            let sp = kind.spectrum();
            let mut sum = 0.0;
            let mut amp = 1.0;
            for _ in 0..sp.octaves {
                sum += amp * amp;
                amp *= sp.ratio;
            }
            assert!((sum - expected_sum).abs() < 1e-9, "{:?}: {}", kind, sum);
            let want = 1.0 / (LATTICE_RMS * sum.sqrt());
            assert!((sp.norm - want).abs() < 1e-12, "{:?}: {} vs {}", kind, sp.norm, want);
        }
    }

    /// Every kind is centred: noise added to a model must not act as a
    /// constant bias term.
    #[test]
    fn kinds_are_centred() {
        for kind in Kind::ALL {
            let mut acc = 0.0;
            let seeds = 32;
            for seed in 0..seeds {
                acc += mean(&samples(kind, 8_000, 0.013, 1.0, seed));
            }
            let m = acc / seeds as f64;
            assert!(m.abs() < 0.1, "{:?} mean = {}", kind, m);
        }
    }

    // ---- telegraph ------------------------------------------------------

    /// Two states, and it spends most of its time in them exactly. The ramped
    /// edges are the only excursions, and they are bounded by +/-1 — a
    /// telegraph must never overshoot into forcing the model harder than
    /// requested.
    #[test]
    fn telegraph_is_two_state() {
        let n = Noise::new(Kind::Telegraph, 1.0, 6);
        let mut settled = 0;
        let total = 40_000;
        for i in 0..total {
            let v = n.at(i as f64 * 0.011);
            assert!(v.abs() <= 1.0 + 1e-12, "overshoot: {}", v);
            if (v.abs() - 1.0).abs() < 1e-12 {
                settled += 1;
            }
        }
        let fraction = settled as f64 / total as f64;
        assert!(fraction > 0.8, "only {} of samples at +/-1", fraction);
    }

    /// It does switch, and roughly as often as a fair coin per cell says it
    /// should — around half of the cell boundaries.
    #[test]
    fn telegraph_switches_about_half_the_time() {
        let n = Noise::new(Kind::Telegraph, 1.0, 6);
        let cells = 4000;
        let mut switches = 0;
        for i in 0..cells {
            // Sample the flat middle of consecutive cells.
            let a = n.at(i as f64 + 0.5);
            let b = n.at(i as f64 + 1.5);
            if a != b {
                switches += 1;
            }
        }
        let p = switches as f64 / cells as f64;
        assert!((0.42..0.58).contains(&p), "switch rate {}", p);
    }

    /// The edges are ramps, not jumps — the reason an adaptive solver can
    /// integrate this at all.
    #[test]
    fn telegraph_has_no_discontinuity() {
        let n = Noise::new(Kind::Telegraph, 1.0, 6);
        let mut worst: f64 = 0.0;
        for i in 0..200_000 {
            let t = i as f64 * 1e-4;
            worst = worst.max((n.at(t + 1e-4) - n.at(t)).abs());
        }
        // A true jump would be 2.0 here. The ramp spans 0.15 of a cell, so the
        // largest slope is about 2 / (0.15) * 1.875 (quintic peak slope).
        assert!(worst < 0.01, "jump of {}", worst);
    }
}
