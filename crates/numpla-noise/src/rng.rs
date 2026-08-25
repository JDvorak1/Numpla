//! The counter-based hash everything else is built on.
//!
//! Not a generator: there is no state to advance and nothing to seed at
//! startup. `hash(seed, index)` is a pure function of two integers, which is
//! what makes a noise signal a pure function of `t` — see the crate docs for
//! why that is non-negotiable here.
//!
//! SplitMix64's finalizer is the mixing step. It is three xor-shift-multiply
//! rounds, passes BigCrush as a generator, avalanches every input bit, and
//! compiles to about a dozen integer instructions — which matters because this
//! runs several times per right-hand side evaluation inside the integrator.
//! Everything is `u64` wrapping arithmetic, so the bits are identical on
//! `wasm32` and on x86-64.

/// 2^64 / phi. The odd increment SplitMix64 walks its state by; multiplying an
/// index by it spreads consecutive indices across the whole word before the
/// finalizer runs.
const GOLDEN: u64 = 0x9E37_79B9_7F4A_7C15;

/// Keeps seed 0 — the default document seed — from being a degenerate input.
const SEED_SALT: u64 = 0x2545_F491_4F6C_DD1D;

/// SplitMix64's finalizer. Bijective, so distinct inputs give distinct outputs.
#[inline]
pub const fn mix64(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Scramble a user-supplied seed once, up front.
///
/// Users pick seeds like 1, 2, 3. Raw, those are adjacent inputs and would need
/// the mixer to do all the decorrelation work at every lattice point. Mixing
/// once at construction spreads them across the word first, so two streams that
/// differ by one in the seed are as unrelated as any other pair — the
/// independence the spec demands of two noise sources in one model.
#[inline]
pub const fn scramble(seed: u64) -> u64 {
    mix64(seed ^ SEED_SALT)
}

/// One draw from the stream `stream`, at position `index`.
///
/// `stream` is expected to be pre-scrambled ([`scramble`], plus an octave
/// offset); `index` is a lattice coordinate and may be negative.
#[inline]
pub const fn hash(stream: u64, index: i64) -> u64 {
    mix64(stream ^ (index as u64).wrapping_mul(GOLDEN))
}

/// Offset a scrambled seed to get an independent sub-stream (one per octave).
#[inline]
pub const fn substream(stream: u64, k: u64) -> u64 {
    stream.wrapping_add(k.wrapping_mul(GOLDEN))
}

/// Uniform on `[0, 1)`, from the 53 bits an `f64` can hold exactly.
#[inline]
pub fn unit(bits: u64) -> f64 {
    // 2^-53. Exact, so this is a shift-and-scale with no rounding surprises.
    (bits >> 11) as f64 * (1.0 / 9_007_199_254_740_992.0)
}

/// Uniform on `[-1, 1)`. The lattice value distribution.
#[inline]
pub fn signed_unit(bits: u64) -> f64 {
    2.0 * unit(bits) - 1.0
}

/// Interpret an `f64` seed written in the math language as bits.
///
/// Seeds arrive as expression values, so they are floats. `to_bits` is exact
/// and IEEE-754 fixes the layout, so this is platform-independent — and unlike
/// rounding to an integer it does not collapse `0.5` and `0.4` onto the same
/// stream. NaN is folded to a single value because NaN has many bit patterns
/// and two of them must not become two different streams.
#[inline]
pub fn seed_from_f64(x: f64) -> u64 {
    if x.is_nan() {
        return 0x7FF8_0000_0000_0000;
    }
    // -0.0 and 0.0 are the same number and must name the same stream.
    if x == 0.0 {
        return 0;
    }
    x.to_bits()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixer_is_injective_on_a_run_of_inputs() {
        // Bijectivity is what stops two lattice points sharing a value.
        let mut seen = std::collections::HashSet::new();
        for i in 0..10_000u64 {
            assert!(seen.insert(mix64(i)), "collision at {}", i);
        }
    }

    #[test]
    fn adjacent_indices_are_uncorrelated() {
        // The whole point of a counter-based hash: index i and i+1 must look
        // unrelated even though the inputs differ in one bit.
        let s = scramble(7);
        let n = 20_000;
        let (mut sx, mut sy, mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0, 0.0, 0.0);
        for i in 0..n {
            let x = signed_unit(hash(s, i));
            let y = signed_unit(hash(s, i + 1));
            sx += x;
            sy += y;
            sxy += x * y;
            sxx += x * x;
            syy += y * y;
        }
        let n = n as f64;
        let cov = sxy / n - (sx / n) * (sy / n);
        let r = cov / ((sxx / n - (sx / n).powi(2)).sqrt() * (syy / n - (sy / n).powi(2)).sqrt());
        assert!(r.abs() < 0.03, "lag-1 correlation {}", r);
    }

    #[test]
    fn unit_stays_in_range() {
        for i in 0..5_000i64 {
            let u = unit(hash(scramble(3), i));
            assert!((0.0..1.0).contains(&u), "{}", u);
            let s = signed_unit(hash(scramble(3), i));
            assert!((-1.0..1.0).contains(&s), "{}", s);
        }
    }

    #[test]
    fn seed_bits_are_stable_and_distinct() {
        assert_eq!(seed_from_f64(0.0), seed_from_f64(-0.0));
        assert_ne!(seed_from_f64(0.5), seed_from_f64(0.4));
        assert_ne!(seed_from_f64(1.0), seed_from_f64(2.0));
        assert_eq!(seed_from_f64(f64::NAN), seed_from_f64(-f64::NAN));
    }

    /// Golden values. If a refactor changes the bit stream, saved documents
    /// stop reproducing — so the numbers themselves are part of the contract.
    #[test]
    fn hash_is_frozen() {
        assert_eq!(mix64(0), 0);
        assert_eq!(mix64(1), 0x5692_161D_100B_05E5);
        assert_eq!(scramble(0), 0x952F_14F1_E8DD_C491);
        assert_eq!(hash(scramble(0), 0), 0xC7D3_552D_73A5_B57E);
    }
}
