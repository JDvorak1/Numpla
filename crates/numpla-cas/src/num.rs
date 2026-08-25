//! The small amount of exact arithmetic the rest of the crate needs.
//!
//! Numpla's numbers are `f64` everywhere — the evaluator, the solver and the
//! plot all agree on that, and introducing a second numeric tower inside the
//! CAS would mean two answers to "what is this number". So the exactness that
//! solving and factoring need is recovered *locally*: a coefficient is turned
//! into a rational only long enough to run an integer algorithm on it, and the
//! answer is checked back against the float it came from.
//!
//! That is why every function here reports failure rather than rounding. A
//! rationalisation that quietly returned the nearest fraction would let
//! `factor` claim a root that is not one.

use numpla_expr::{Env, Expr};

/// The value of a closed expression — one with no free names left.
///
/// Used everywhere a rule needs to ask "is this exponent one half?" without
/// caring whether the user wrote `0.5`, `1/2` or `2^-1`. Returns `None` for
/// anything that reads a name, is not finite, or is not a scalar, so a caller
/// can never mistake "unknown" for a number.
pub fn const_value(e: &Expr) -> Option<f64> {
    let env = Env::new();
    match numpla_expr::eval(e, &env) {
        Ok(numpla_expr::Value::Scalar(x)) if x.is_finite() => Some(x),
        _ => None,
    }
}

/// The value of `e` with `var` bound to `x`, when everything else is closed.
pub fn value_at(e: &Expr, var: &str, x: f64) -> Option<f64> {
    let mut env = Env::new();
    env.set(var, x);
    match numpla_expr::eval(e, &env) {
        Ok(numpla_expr::Value::Scalar(v)) if v.is_finite() => Some(v),
        _ => None,
    }
}

/// Is `x` an integer, small enough that `i64` arithmetic on it is exact?
pub fn as_integer(x: f64) -> Option<i64> {
    (x.fract() == 0.0 && x.abs() < 9e15).then_some(x as i64)
}

/// `p/q` in lowest terms with `q <= max_den`, but only when it is *the* value
/// of `x` rather than merely near it.
///
/// Continued fractions, stopped at the first convergent that reproduces `x` to
/// within a relative `1e-13` — a dozen digits, which is what a coefficient that
/// has been through a parse and a simplify pass still has. Anything looser
/// would let `factor` turn `x^2 - 0.3333333` into a factorisation of
/// `x^2 - 1/3`, which is a different polynomial.
pub fn rationalize(x: f64, max_den: i64) -> Option<(i64, i64)> {
    if !x.is_finite() || x.abs() > 1e15 {
        return None;
    }
    if x == 0.0 {
        return Some((0, 1));
    }
    // h/k are the convergents; the recurrence is the standard one.
    let (mut h0, mut h1) = (1i64, 0i64);
    let (mut k0, mut k1) = (0i64, 1i64);
    let mut v = x;
    for _ in 0..64 {
        let a = v.floor();
        let ai = as_integer(a)?;
        let h = ai.checked_mul(h0)?.checked_add(h1)?;
        let k = ai.checked_mul(k0)?.checked_add(k1)?;
        if k.abs() > max_den {
            return None;
        }
        (h1, h0) = (h0, h);
        (k1, k0) = (k0, k);
        if k0 != 0 {
            let approx = h0 as f64 / k0 as f64;
            if (approx - x).abs() <= 1e-13 * x.abs().max(1.0) {
                return normalize(h0, k0);
            }
        }
        let frac = v - a;
        if frac == 0.0 {
            return normalize(h0, k0);
        }
        v = 1.0 / frac;
    }
    None
}

fn normalize(p: i64, q: i64) -> Option<(i64, i64)> {
    if q == 0 {
        return None;
    }
    let g = gcd(p.unsigned_abs(), q.unsigned_abs()) as i64;
    let (p, q) = (p / g, q / g);
    Some(if q < 0 { (-p, -q) } else { (p, q) })
}

pub fn gcd(a: u64, b: u64) -> u64 {
    let (mut a, mut b) = (a, b);
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a.max(1)
}

/// A rational as the expression a person would write: `2`, `1/3`, `-2/3`.
///
/// Never `0.6666666666666666`. A fraction is both shorter and exact, and the
/// printer round-trips it, so this is the form that goes into an answer.
pub fn rational_expr(p: i64, q: i64) -> Expr {
    let Some((p, q)) = normalize(p, q) else {
        return Expr::Num(f64::NAN);
    };
    if q == 1 {
        return Expr::Num(p as f64);
    }
    // The sign goes in the numerator, not around the fraction: `-1/2` is what
    // a person writes, and `-(1/2)` is what a printer writes when the tree was
    // built the lazy way round.
    crate::simplify::bin(
        numpla_expr::BinOp::Div,
        Expr::Num(p as f64),
        Expr::Num(q as f64),
    )
}

/// Do two expressions agree numerically wherever both are defined?
///
/// The backstop under [`crate::factor`] and [`crate::solve`]: those two build
/// their answers out of integer arithmetic on coefficients that came from
/// floats, and a mistake there — a dropped content, an off-by-one in a
/// deflation — shows up as an expression that is simply not the one asked
/// about. Sampling catches that in the one place it can be caught cheaply, and
/// costs a few dozen evaluations.
///
/// It is not a proof and is not treated as one: it is the *veto*. A candidate
/// that disagrees is discarded; a candidate that agrees is still only offered
/// because an argument was made for it upstream.
///
/// Samples are positive, which keeps `ln`, `sqrt` and fractional powers inside
/// their domains — the point is to catch a wrong polynomial, and a polynomial
/// identity that holds at enough positive points holds everywhere.
pub fn agrees(a: &Expr, b: &Expr) -> bool {
    let names: Vec<String> = a
        .deps()
        .union(&b.deps())
        .filter(|n| !matches!(n.as_str(), "pi" | "tau" | "e" | "inf"))
        .cloned()
        .collect();
    // SplitMix64 with a fixed seed: a veto nobody can reproduce is a coin toss.
    let mut state = 0x9E37_79B9_7F4A_7C15u64;
    let mut next = move || {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        0.3 + 2.7 * (((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64)
    };
    for _ in 0..24 {
        let mut env = Env::new();
        for n in &names {
            env.set(n, next());
        }
        let (x, y) = (scalar(a, &env), scalar(b, &env));
        if let (Some(x), Some(y)) = (x, y) {
            if (x - y).abs() > 1e-9 * x.abs().max(y.abs()).max(1.0) {
                return false;
            }
        } else if x.is_some() != y.is_some() {
            // One of them has a value here and the other does not. That is a
            // disagreement about the domain, which is a disagreement.
            return false;
        }
    }
    true
}

fn scalar(e: &Expr, env: &Env) -> Option<f64> {
    match numpla_expr::eval(e, env) {
        Ok(numpla_expr::Value::Scalar(x)) if x.is_finite() => Some(x),
        _ => None,
    }
}

/// The positive divisors of `n`, for the rational root theorem.
///
/// Bounded: past a few million the trial division costs more than the roots are
/// worth, and a polynomial with a constant term that large is not one anybody
/// is reading factored anyway. Returning `None` there is a refusal, not a
/// silent empty list — the caller must not conclude "no rational roots".
pub fn divisors(n: i64) -> Option<Vec<i64>> {
    let n = n.unsigned_abs();
    if n == 0 || n > 4_000_000 {
        return None;
    }
    let mut out = Vec::new();
    let mut d = 1u64;
    while d * d <= n {
        if n.is_multiple_of(d) {
            out.push(d as i64);
            if d * d != n {
                out.push((n / d) as i64);
            }
        }
        d += 1;
    }
    out.sort_unstable();
    Some(out)
}

/// The largest `k` with `k^2 | n`, and what is left: `sqrt(72) = 6 sqrt(2)`.
///
/// Only ever applied to a non-negative integer literal, where it is an exact
/// identity rather than a domain-conditional one.
pub fn square_factor(n: i64) -> (i64, i64) {
    if n <= 0 {
        return (1, n);
    }
    let mut outside = 1i64;
    let mut rest = n;
    let mut d = 2i64;
    while d * d <= rest {
        while rest % (d * d) == 0 {
            rest /= d * d;
            outside *= d;
        }
        d += 1;
    }
    (outside, rest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::print::to_source;

    #[test]
    fn rationalizes_only_what_is_actually_a_fraction() {
        assert_eq!(rationalize(0.5, 1000), Some((1, 2)));
        assert_eq!(rationalize(-2.0 / 3.0, 1000), Some((-2, 3)));
        assert_eq!(rationalize(7.0, 1000), Some((7, 1)));
        // pi is not a small fraction, and saying it is 355/113 would be a lie
        // dressed as an answer.
        assert_eq!(rationalize(std::f64::consts::PI, 1000), None);
    }

    #[test]
    fn a_rational_prints_as_a_fraction() {
        assert_eq!(to_source(&rational_expr(1, 2)), "1/2");
        assert_eq!(to_source(&rational_expr(-2, 4)), "-1/2");
        assert_eq!(to_source(&rational_expr(6, 3)), "2");
    }

    #[test]
    fn square_factors_come_out() {
        assert_eq!(square_factor(72), (6, 2));
        assert_eq!(square_factor(8), (2, 2));
        assert_eq!(square_factor(7), (1, 7));
        assert_eq!(square_factor(16), (4, 1));
    }

    #[test]
    fn divisors_refuse_rather_than_return_nothing() {
        assert_eq!(divisors(12), Some(vec![1, 2, 3, 4, 6, 12]));
        assert_eq!(divisors(0), None);
        assert_eq!(divisors(1_000_000_007), None);
    }
}
