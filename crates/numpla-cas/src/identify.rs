//! Inverse symbolic lookup: going from a number back to a closed form.
//!
//! `1.6449340668482264` is `pi^2/6`, and a CAS that can say so is a different
//! tool from one that cannot. This is the thing people remember Maple for.
//!
//! # It is a guess, and it is labelled as one
//!
//! Nothing here is proved. A match means "this closed form and your number
//! agree to more digits than a coincidence plausibly would", which is evidence
//! and not a derivation, and every result crosses the boundary tagged as an
//! *identification* so the UI can say so. **A false identity is the worst thing
//! a CAS can hand somebody**: it looks like the answer, it gets copied into the
//! next document, and nothing downstream will ever question it again. So the
//! whole design here is about the tolerance.
//!
//! # The tolerance, and why it is [`TOLERANCE`]
//!
//! Two numbers bound the choice from opposite sides.
//!
//! *From below*: the value being identified was computed in `f64`, usually
//! through several operations. A well-behaved expression loses a few ulps, so
//! agreement is expected at a relative `1e-15` and can degrade to `1e-13` for
//! something that cancels. Demanding more than that would reject true matches.
//!
//! *From above*: how close does a *wrong* candidate get by luck? The table
//! below searches about twenty thousand closed forms. Near a value of order one,
//! roughly three thousand of them land within a factor of two, so the typical
//! gap between neighbouring candidates is around `3e-4`. The chance that an
//! unrelated number falls within `eps` of one of them is about `2 eps / 3e-4`.
//!
//! At `1e-12` that is a false-match probability of about **seven in a billion**
//! per query, with three orders of magnitude of headroom above the accumulated
//! rounding error. Loosening to `1e-9` would buy nothing — no true identity
//! needs it — and would raise the coincidence rate by a thousandfold. So: a
//! relative `1e-12`, and every candidate is re-evaluated from the expression
//! that will actually be shown rather than from the arithmetic that found it,
//! so what is displayed is what was checked.
//!
//! Two further guards, both about information rather than arithmetic. A value
//! below `1e-6` in magnitude is not identified at all: everything is close to
//! zero in relative terms down there, and "your number is `0`" is not a
//! discovery. Neither is anything above `1e12`, where `f64` has no digits left
//! below the decimal point.

use numpla_expr::{parse, Expr, Stmt};

use crate::num::{const_value, rationalize};

/// Relative agreement required before a closed form is offered. See the module
/// docs — this number is the entire safety argument.
pub const TOLERANCE: f64 = 1e-12;

/// Below this, a relative tolerance stops meaning anything.
const TOO_SMALL: f64 = 1e-6;

/// Above this, `f64` has no fractional digits left to match on.
const TOO_LARGE: f64 = 1e12;

/// The largest numerator and denominator in a rational multiple of a constant.
/// Raising it widens the search quadratically and the false-match rate with it;
/// 24 covers the multiples that appear in real closed forms.
const MAX_MULTIPLE: i64 = 24;

/// One closed form that matches a number.
#[derive(Debug, Clone, PartialEq)]
pub struct Identified {
    /// The closed form, as an expression that prints as Numpla source.
    pub expr: Expr,
    /// What it is, in words: "pi squared over six", "the golden ratio".
    pub name: String,
    /// How closely it agreed, relative. Reported rather than hidden so a caller
    /// can show it: "to 16 digits" is the evidence, and evidence is the point.
    pub relative_error: f64,
    /// Lower is simpler. Only used to order the answers.
    complexity: u32,
}

/// The constants a value is tried against, as rational multiples.
///
/// Each is Numpla source, parsed once per lookup — which is cheap and means the
/// expression offered is guaranteed to be something the parser accepts, rather
/// than a tree assembled here that might print into something else.
const CONSTANTS: &[(&str, &str)] = &[
    ("pi", "pi"),
    ("pi^2", "pi squared"),
    ("pi^3", "pi cubed"),
    ("pi^4", "pi to the fourth"),
    ("e", "e"),
    ("e^2", "e squared"),
    ("exp(pi)", "e to the pi"),
    ("sqrt(pi)", "the square root of pi"),
    ("sqrt(2)", "the square root of 2"),
    ("sqrt(3)", "the square root of 3"),
    ("sqrt(5)", "the square root of 5"),
    ("sqrt(6)", "the square root of 6"),
    ("sqrt(7)", "the square root of 7"),
    ("sqrt(10)", "the square root of 10"),
    ("2^(1/3)", "the cube root of 2"),
    ("3^(1/3)", "the cube root of 3"),
    ("ln(2)", "the natural log of 2"),
    ("ln(3)", "the natural log of 3"),
    ("ln(5)", "the natural log of 5"),
    ("ln(7)", "the natural log of 7"),
    ("ln(10)", "the natural log of 10"),
    ("ln(2)^2", "the square of the natural log of 2"),
    ("ln(pi)", "the natural log of pi"),
    ("(1 + sqrt(5))/2", "the golden ratio"),
];

/// Closed forms whose rational part is too unusual for the multiple search.
///
/// `zeta(4)` is `pi^4/90` and 90 is well past [`MAX_MULTIPLE`]; widening the
/// search to reach it would multiply the number of candidates — and the
/// coincidence rate — by more than a decimal order. Naming the few values worth
/// having costs nothing and keeps the search tight, which is the trade this
/// whole module is about.
const NAMED: &[(&str, &str)] = &[
    ("pi^2/6", "pi squared over six, which is zeta(2)"),
    ("pi^4/90", "pi to the fourth over ninety, which is zeta(4)"),
    ("pi^6/945", "zeta(6)"),
    ("pi^3/32", "pi cubed over thirty-two"),
    ("pi^2/8", "pi squared over eight"),
    ("2/sqrt(pi)", "two over root pi"),
    ("1/sqrt(2 * pi)", "the Gaussian normalisation"),
    ("(1 + sqrt(5))/2", "the golden ratio"),
    ("(sqrt(5) - 1)/2", "the golden ratio minus one"),
];

/// The constants a two-term combination may be built on.
///
/// Deliberately shorter than [`CONSTANTS`]: a two-term family is quadratic in
/// the size of the rational search, and the point of the tolerance argument is
/// that the candidate count stays in the tens of thousands.
const COMBINATION_BASES: &[&str] = &["pi", "e", "sqrt(2)", "sqrt(3)", "sqrt(5)", "ln(2)"];

/// The closed forms matching `v`, simplest first, at most three of them.
///
/// An empty list is the normal answer and means exactly what it says: nothing in
/// the table agrees with this number to twelve digits.
pub fn identify(v: f64) -> Vec<Identified> {
    if !v.is_finite() || v.abs() < TOO_SMALL || v.abs() > TOO_LARGE {
        return Vec::new();
    }
    let mut found: Vec<Identified> = Vec::new();

    // A plain fraction. The denominator is allowed to be much larger here than
    // in the multiple search because there is only *one* candidate: the
    // continued fraction produces the unique best rational, so widening it does
    // not widen the search.
    if let Some((p, q)) = rationalize(v, 10_000) {
        if q != 1 {
            push(&mut found, crate::num::rational_expr(p, q), "a fraction", v, q as u32);
        }
    }

    for (source, name) in CONSTANTS {
        let Some(c) = parse_const(source) else { continue };
        let Some((p, q)) = rationalize(v / c.1, MAX_MULTIPLE) else { continue };
        if p == 0 {
            continue;
        }
        let expr = multiple(p, q, &c.0);
        push(&mut found, expr, name, v, p.unsigned_abs() as u32 + q as u32 + 4);
    }

    for (source, name) in NAMED {
        let Some(c) = parse_const(source) else { continue };
        // Halves and doubles only. These entries are already specific closed
        // forms, so a wide multiplier search on them buys nothing and costs
        // plenty: it is what turns `pi^2/6` into an offer of `4(pi^2/8)/3`,
        // which is true, useless, and exactly the kind of noise that makes a
        // choice list stop being one.
        let Some((p, q)) = rationalize(v / c.1, 2) else { continue };
        if p.abs() > 2 {
            continue;
        }
        if p == 0 {
            continue;
        }
        let expr = multiple(p, q, &c.0);
        push(&mut found, expr, name, v, p.unsigned_abs() as u32 + q as u32 + 2);
    }

    combinations(v, &mut found);

    found.sort_by(|a, b| {
        a.complexity
            .cmp(&b.complexity)
            .then(a.relative_error.total_cmp(&b.relative_error))
    });
    found.dedup_by(|a, b| crate::to_source(&a.expr) == crate::to_source(&b.expr));
    found.truncate(3);
    found
}

/// `p/q + (r/s) C`, for small rationals on both sides.
///
/// This is where the golden ratio would come from if it were not already in the
/// table, and where `3/2 + pi/4` comes from. Kept to denominators of four and
/// numerators of four so that the family stays a few thousand candidates rather
/// than a few million.
fn combinations(v: f64, found: &mut Vec<Identified>) {
    for source in COMBINATION_BASES {
        let Some((expr, c)) = parse_const(source) else { continue };
        for s in 1..=4i64 {
            for r in -4..=4i64 {
                // In lowest terms only: `2/4` of a constant is `1/2` of it,
                // and offering both is offering the same number twice.
                if r == 0 || crate::num::gcd(r.unsigned_abs(), s.unsigned_abs()) != 1 {
                    continue;
                }
                let residual = v - (r as f64 / s as f64) * c;
                let Some((p, q)) = rationalize(residual, 4) else { continue };
                if p == 0 || q > 4 {
                    continue;
                }
                let term = multiple(r, s, &expr);
                let whole = crate::simplify::bin(
                    numpla_expr::BinOp::Add,
                    crate::num::rational_expr(p, q),
                    term,
                );
                push(
                    found,
                    whole,
                    "a rational plus a rational multiple of a constant",
                    v,
                    (p.unsigned_abs() + r.unsigned_abs()) as u32 + (q + s) as u32 + 12,
                );
            }
        }
    }
}

/// `(p/q) * c`, written the way a person would: `2c`, `c/3`, `-2c/3`, `c`.
///
/// The minus goes on the numerator rather than around the whole fraction, for
/// the same reason it does in [`crate::num::rational_expr`]: `-pi/4` is the
/// answer somebody recognises and `-(pi/4)` is a printer talking to itself.
fn multiple(p: i64, q: i64, c: &Expr) -> Expr {
    use numpla_expr::BinOp;
    let scaled = if p.abs() == 1 {
        if p < 0 {
            crate::simplify::neg(c.clone())
        } else {
            c.clone()
        }
    } else {
        crate::simplify::bin(BinOp::Mul, Expr::Num(p as f64), c.clone())
    };
    if q == 1 {
        scaled
    } else {
        crate::simplify::bin(BinOp::Div, scaled, Expr::Num(q as f64))
    }
}

/// Accept a candidate only if the expression *as it will be shown* evaluates
/// close enough.
///
/// The arithmetic that found the candidate is not the arithmetic that will be
/// printed — `v / pi` rounding one way and `2pi/3` rounding another — and the
/// only claim worth making is about the thing on screen. So the check happens
/// here, once, on the finished expression.
fn push(out: &mut Vec<Identified>, expr: Expr, name: &str, v: f64, complexity: u32) {
    let Some(value) = const_value(&expr) else {
        return;
    };
    let error = (value - v).abs() / v.abs().max(1.0);
    if error <= TOLERANCE {
        out.push(Identified { expr, name: name.to_string(), relative_error: error, complexity });
    }
}

fn parse_const(source: &str) -> Option<(Expr, f64)> {
    let (stmt, errs) = parse(source);
    if !errs.is_empty() {
        return None;
    }
    let Stmt::Expr(e) = stmt else { return None };
    let v = const_value(&e)?;
    (v != 0.0).then_some((e, v))
}

/// How many significant digits a match agrees to, for the sentence a UI shows.
pub fn agreeing_digits(relative_error: f64) -> u32 {
    if relative_error <= 0.0 {
        return 17;
    }
    (-relative_error.log10()).floor().clamp(0.0, 17.0) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::print::to_source;

    fn names(v: f64) -> Vec<String> {
        identify(v).iter().map(|i| to_source(&i.expr)).collect()
    }

    #[test]
    fn finds_the_famous_ones() {
        assert!(names(std::f64::consts::PI).contains(&"pi".to_string()));
        assert!(names(std::f64::consts::PI.powi(2) / 6.0).contains(&"pi^2/6".to_string()));
        assert!(names(2.0f64.sqrt()).contains(&"sqrt(2)".to_string()));
        assert!(names(1.0 / 3.0).contains(&"1/3".to_string()));
        assert!(names((1.0 + 5.0f64.sqrt()) / 2.0).contains(&"(1 + sqrt(5))/2".to_string()));
        assert!(names(std::f64::consts::PI.powi(4) / 90.0).contains(&"pi^4/90".to_string()));
        assert!(names(2.0f64.ln()).contains(&"ln(2)".to_string()));
    }

    #[test]
    fn finds_small_rational_multiples() {
        assert!(names(2.0 * std::f64::consts::PI / 3.0).contains(&"2pi/3".to_string()));
        assert!(names(-std::f64::consts::PI / 4.0).contains(&"-pi/4".to_string()));
    }

    /// The property that matters more than any of the above: a number that is
    /// merely *near* a closed form is not identified as one.
    #[test]
    fn refuses_a_near_miss() {
        // Seven correct digits of pi is not pi. (Built from `PI` rather than
        // typed out, so that nothing here is a decimal that has to be trusted.)
        let seven_digits = (std::f64::consts::PI * 1e7).trunc() / 1e7;
        assert!(names(seven_digits).is_empty());
        // ...and neither is pi shifted in the eleventh digit.
        assert!(names(std::f64::consts::PI * (1.0 + 1e-11)).is_empty());
        // ...while pi shifted in the fifteenth still is, which is the other
        // half of the claim: real values arrive with rounding on them.
        assert!(!names(std::f64::consts::PI * (1.0 + 1e-15)).is_empty());
    }

    #[test]
    fn declines_where_there_is_no_information() {
        assert!(names(0.0).is_empty());
        assert!(names(1e-9).is_empty());
        assert!(names(f64::NAN).is_empty());
        assert!(names(1e20).is_empty());
    }

    /// Nothing in the table is offered unless it really does evaluate to the
    /// number. This re-checks the guarantee `push` makes, from outside.
    #[test]
    fn every_offer_evaluates_to_the_number_it_was_offered_for() {
        for v in [
            std::f64::consts::PI,
            std::f64::consts::E * 3.0,
            7.0 / 11.0,
            2.0f64.sqrt() / 2.0,
            std::f64::consts::PI.powi(2) / 6.0,
        ] {
            for found in identify(v) {
                let got = const_value(&found.expr).expect("a closed form evaluates");
                assert!(
                    (got - v).abs() <= TOLERANCE * v.abs().max(1.0),
                    "{} was offered for {} but is {}",
                    to_source(&found.expr),
                    v,
                    got
                );
            }
        }
    }
}
