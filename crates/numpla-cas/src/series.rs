//! `sum(e, k, a, b)` and `product(e, k, a, b)`.
//!
//! Three answers, in this order, and the order is the design:
//!
//! 1. **A closed form**, where one of the handful this crate knows applies.
//!    `sum(k, k, 1, n)` is `n(n+1)/2` whether or not `n` is a number, and that
//!    is the answer somebody asking symbolically wants.
//! 2. **The sum itself**, added up, when the limits are numbers and there are
//!    not too many terms. Slower than a formula and exactly as correct.
//! 3. **A refusal that names the shape.** `sum(1/k, k, 1, n)` is a harmonic
//!    number and there is no elementary closed form; saying so is the answer.
//!    Returning an unevaluated `sum(...)` back to the caller would look like
//!    progress and be none.
//!
//! # The closed forms
//!
//! Any polynomial in `k` of degree at most three, by the power sums; geometric
//! `r^k` and `exp(c k)`; and for products, a factor free of `k` and a geometric
//! one. The power sums are written from `a` to `b` rather than from 1, because
//! `sum(k, k, 3, n)` is a question people ask and re-deriving the offset by hand
//! is where sign errors come from.
//!
//! # Factorials
//!
//! `product(k, k, 1, n)` is `n!`, and Numpla has no factorial. The honest thing
//! is to say that in the refusal rather than to invent a name that nothing else
//! in the language can read — every string this crate returns is source that
//! parses, and `n!` would not be. With numeric limits the same product is a
//! number, and that is what comes back.

use numpla_expr::{BinOp, Expr};

use crate::num::{as_integer, const_value};
use crate::poly::Poly;
use crate::simplify::{bin, simplify};
use crate::CasError;

/// The largest number of terms that will be added up one at a time when the
/// summand is a closed expression. Ten thousand terms of arithmetic is a few
/// milliseconds; it is also about where a partial sum stops telling anybody
/// anything they did not already know.
const MAX_NUMERIC_TERMS: i64 = 100_000;

/// The same, when the summand still has free names in it and every term has to
/// be kept as an expression. A five-hundred-term polynomial is already past
/// reading.
const MAX_SYMBOLIC_TERMS: i64 = 512;

/// A closed form, and how it was arrived at.
#[derive(Debug, Clone, PartialEq)]
pub struct Closed {
    pub expr: Expr,
    /// "power sums", "geometric series", "added up term by term".
    pub method: String,
    pub note: Option<String>,
}

impl Closed {
    fn new(expr: Expr, method: &str) -> Closed {
        Closed { expr: simplify(&expr), method: method.to_string(), note: None }
    }
    fn noting(mut self, note: impl Into<String>) -> Closed {
        self.note = Some(note.into());
        self
    }
}

/// `sum(e, k, a, b)`.
pub fn sum(e: &Expr, k: &str, a: &Expr, b: &Expr) -> Result<Closed, CasError> {
    incomplete_guard(e, a, b)?;
    if let Some(empty) = empty_range(a, b, 0.0) {
        return Ok(empty);
    }
    if let Some(c) = polynomial_sum(e, k, a, b) {
        return Ok(c);
    }
    if let Some(c) = geometric_sum(e, k, a, b)? {
        return Ok(c);
    }
    if let Some(c) = term_by_term(e, k, a, b, BinOp::Add)? {
        return Ok(c);
    }
    Err(CasError::Unsupported(format!(
        "this CAS has no closed form for `sum({}, {}, ...)`. It knows polynomials in {} up to degree three, geometric `r^{}` and `exp(c {})`, and it will add up any summand over numeric limits — this is none of those.",
        crate::to_source(e),
        k,
        k,
        k,
        k
    )))
}

/// `product(e, k, a, b)`.
pub fn product(e: &Expr, k: &str, a: &Expr, b: &Expr) -> Result<Closed, CasError> {
    incomplete_guard(e, a, b)?;
    if let Some(empty) = empty_range(a, b, 1.0) {
        return Ok(empty);
    }
    if !e.deps().contains(k) {
        // A factor that does not move: the product is a power.
        return Ok(Closed::new(
            bin(BinOp::Pow, e.clone(), count(a, b)),
            "a constant factor, repeated",
        ));
    }
    if let Some(c) = geometric_product(e, k, a, b) {
        return Ok(c);
    }
    if let Some(c) = term_by_term(e, k, a, b, BinOp::Mul)? {
        return Ok(c);
    }
    if Poly::from_expr(e, k).is_some_and(|p| p.degree() >= 1) {
        return Err(CasError::Unsupported(format!(
            "`product({}, {}, {}, {})` is a factorial, and Numpla has no factorial to write the answer with. Everything this CAS returns is source you can paste back into a document, and `!` is not part of the language — with numeric limits it will give you the number.",
            crate::to_source(e),
            k,
            crate::to_source(a),
            crate::to_source(b)
        )));
    }
    Err(CasError::Unsupported(format!(
        "this CAS has no closed form for `product({}, {}, ...)`. It knows a factor free of {}, geometric `r^{}`, and any factor at all over numeric limits.",
        crate::to_source(e),
        k,
        k,
        k
    )))
}

fn incomplete_guard(e: &Expr, a: &Expr, b: &Expr) -> Result<(), CasError> {
    if e.has_hole() || a.has_hole() || b.has_hole() {
        return Err(CasError::Incomplete);
    }
    Ok(())
}

/// `b < a` is the empty range: a sum of nothing is zero and a product of
/// nothing is one. Only decided when both limits are numbers — with a symbolic
/// `b` the formulas below are the answer for every `b >= a - 1` anyway.
fn empty_range(a: &Expr, b: &Expr, identity: f64) -> Option<Closed> {
    let (a, b) = (const_value(a)?, const_value(b)?);
    (b < a).then(|| Closed::new(Expr::Num(identity), "an empty range"))
}

/// `b - a + 1`, the number of terms.
fn count(a: &Expr, b: &Expr) -> Expr {
    simplify(&bin(
        BinOp::Add,
        bin(BinOp::Sub, b.clone(), a.clone()),
        Expr::Num(1.0),
    ))
}

// ---- polynomials in k ----------------------------------------------------

fn polynomial_sum(e: &Expr, k: &str, a: &Expr, b: &Expr) -> Option<Closed> {
    let p = Poly::from_expr(e, k)?;
    if p.degree() > 3 {
        return None;
    }
    let mut out: Option<Expr> = None;
    for (i, c) in p.coeffs.iter().enumerate() {
        let term = bin(BinOp::Mul, c.clone(), power_sum(i, a, b));
        out = Some(match out {
            None => term,
            Some(acc) => bin(BinOp::Add, acc, term),
        });
    }
    Some(Closed::new(out?, "power sums"))
}

/// `sum(k^i, k, a, b)` for `i` up to three, as `P(b) - P(a - 1)`.
///
/// Writing it as a difference of the same antiderivative-like function at the
/// two ends is what keeps the offset right: there is one formula per power and
/// the limits go in the same slots every time.
fn power_sum(i: usize, a: &Expr, b: &Expr) -> Expr {
    let below = simplify(&bin(BinOp::Sub, a.clone(), Expr::Num(1.0)));
    match i {
        0 => count(a, b),
        _ => bin(BinOp::Sub, faulhaber(i, b), faulhaber(i, &below)),
    }
}

/// `sum(k^i, k, 1, n)`.
fn faulhaber(i: usize, n: &Expr) -> Expr {
    let n1 = bin(BinOp::Add, n.clone(), Expr::Num(1.0));
    match i {
        1 => bin(BinOp::Div, bin(BinOp::Mul, n.clone(), n1), Expr::Num(2.0)),
        2 => bin(
            BinOp::Div,
            bin(
                BinOp::Mul,
                bin(BinOp::Mul, n.clone(), n1),
                bin(
                    BinOp::Add,
                    bin(BinOp::Mul, Expr::Num(2.0), n.clone()),
                    Expr::Num(1.0),
                ),
            ),
            Expr::Num(6.0),
        ),
        _ => bin(
            BinOp::Pow,
            bin(BinOp::Div, bin(BinOp::Mul, n.clone(), n1), Expr::Num(2.0)),
            Expr::Num(2.0),
        ),
    }
}

// ---- geometric -----------------------------------------------------------

/// `c * r^k` — the coefficient and the ratio, or `None` if it is not that
/// shape.
///
/// `exp(c k)` counts: it is `exp(c)^k`, and writing it that way is what lets one
/// formula cover both spellings instead of two nearly identical ones.
fn as_geometric(e: &Expr, k: &str) -> Option<(Expr, Expr)> {
    let mut coefficient = Expr::Num(1.0);
    let mut ratio: Option<Expr> = None;
    let mut factors = Vec::new();
    gather_factors(e, &mut factors);
    for f in factors {
        if !f.deps().contains(k) {
            coefficient = bin(BinOp::Mul, coefficient, f);
            continue;
        }
        if ratio.is_some() {
            return None;
        }
        ratio = Some(ratio_of(&f, k)?);
    }
    Some((simplify(&coefficient), simplify(&ratio?)))
}

/// The `r` in a factor that is `r^k`, `r^(m k)` or `exp(m k)`.
fn ratio_of(f: &Expr, k: &str) -> Option<Expr> {
    let linear_multiplier = |exp: &Expr| -> Option<Expr> {
        let p = Poly::from_expr(exp, k)?;
        // Exactly `m*k`: degree one with no constant term, so `r^(mk)` really
        // is `(r^m)^k` and not `r^c (r^m)^k`, which would need the constant
        // folded into the coefficient instead.
        (p.degree() == 1 && matches!(simplify(&p.coeffs[0]), Expr::Num(n) if n == 0.0))
            .then(|| p.coeffs[1].clone())
    };
    match f {
        Expr::Bin { op: BinOp::Pow, lhs, rhs } if !lhs.deps().contains(k) => {
            let m = linear_multiplier(rhs)?;
            Some(bin(BinOp::Pow, (**lhs).clone(), m))
        }
        Expr::Call { name, args } if name == "exp" && args.len() == 1 => {
            let m = linear_multiplier(&args[0])?;
            Some(Expr::Call { name: "exp".into(), args: vec![m] })
        }
        _ => None,
    }
}

fn gather_factors(e: &Expr, out: &mut Vec<Expr>) {
    match e {
        Expr::Bin { op: BinOp::Mul, lhs, rhs } => {
            gather_factors(lhs, out);
            gather_factors(rhs, out);
        }
        Expr::Neg(a) => {
            out.push(Expr::Num(-1.0));
            gather_factors(a, out);
        }
        _ => out.push(e.clone()),
    }
}

fn geometric_sum(e: &Expr, k: &str, a: &Expr, b: &Expr) -> Result<Option<Closed>, CasError> {
    let Some((c, r)) = as_geometric(e, k) else {
        return Ok(None);
    };
    // `r = 1` is not a geometric series, it is a constant one, and the formula
    // divides by zero there. The polynomial path already answered that case for
    // a literal 1; this is the guard for anything that folds to it.
    if const_value(&r) == Some(1.0) {
        return Ok(Some(Closed::new(
            bin(BinOp::Mul, c, count(a, b)),
            "a constant term, repeated",
        )));
    }
    let power = |exp: Expr| bin(BinOp::Pow, r.clone(), exp);
    let last = power(bin(BinOp::Add, b.clone(), Expr::Num(1.0)));
    let first = power(a.clone());
    // The same formula, written the way round that keeps the denominator
    // positive. `sum(2^k, k, 0, n)` is `2^(n+1) - 1`; the other orientation
    // gives `-(-2^(n+1) + 1)`, which is the same number and not something
    // anybody recognises as the answer.
    let growing = crate::num::const_value(&r).is_some_and(|v| v > 1.0);
    let (top, bottom) = if growing {
        (bin(BinOp::Sub, last, first), bin(BinOp::Sub, r.clone(), Expr::Num(1.0)))
    } else {
        (bin(BinOp::Sub, first, last), bin(BinOp::Sub, Expr::Num(1.0), r.clone()))
    };
    let closed = bin(BinOp::Div, bin(BinOp::Mul, c, top), bottom);
    let out = Closed::new(closed, "geometric series");
    Ok(Some(match const_value(&r) {
        Some(_) => out,
        None => out.noting(format!(
            "assuming {} is not 1 — at 1 the series is constant and this formula divides by zero",
            crate::to_source(&r)
        )),
    }))
}

fn geometric_product(e: &Expr, k: &str, a: &Expr, b: &Expr) -> Option<Closed> {
    let (c, r) = as_geometric(e, k)?;
    // `prod r^k = r^(sum k)`, exactly, because the exponents are integers.
    let exponent = power_sum(1, a, b);
    let out = bin(
        BinOp::Mul,
        bin(BinOp::Pow, c, count(a, b)),
        bin(BinOp::Pow, r.clone(), exponent),
    );
    let closed = Closed::new(out, "a geometric product: the exponents add up");
    Some(match const_value(&r) {
        Some(v) if v != 0.0 => closed,
        _ => closed.noting(format!(
            "assuming {} is not zero",
            crate::to_source(&r)
        )),
    })
}

// ---- the brute-force answer ----------------------------------------------

/// Add or multiply the terms one at a time, when the limits are numbers.
///
/// Bounded twice over, because the two failure modes are different: a closed
/// summand is cheap per term and the only limit is patience, while a symbolic
/// one grows the answer with every term and stops being readable long before it
/// stops being computable.
fn term_by_term(
    e: &Expr,
    k: &str,
    a: &Expr,
    b: &Expr,
    op: BinOp,
) -> Result<Option<Closed>, CasError> {
    let (Some(lo), Some(hi)) = (const_value(a), const_value(b)) else {
        return Ok(None);
    };
    let (Some(lo), Some(hi)) = (as_integer(lo), as_integer(hi)) else {
        return Err(CasError::Unsupported(
            "the limits of a sum or product have to be whole numbers — a range from 1 to 2.5 has no last term".into(),
        ));
    };
    let symbolic = crate::factor::free_names(e).iter().any(|n| n != k);
    let cap = if symbolic { MAX_SYMBOLIC_TERMS } else { MAX_NUMERIC_TERMS };
    let terms = hi - lo + 1;
    if terms > cap {
        return Err(CasError::Unsupported(format!(
            "that is {} terms and this CAS will only add up {} of them one at a time. A closed form would answer it for any limits; there is none for this summand.",
            terms, cap
        )));
    }

    let mut acc = Expr::Num(if op == BinOp::Add { 0.0 } else { 1.0 });
    for i in lo..=hi {
        let term = crate::subs(e, k, &Expr::Num(i as f64));
        acc = simplify(&bin(op, acc, term));
    }
    Ok(Some(Closed::new(
        acc,
        if op == BinOp::Add { "added up term by term" } else { "multiplied out term by term" },
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::print::to_source;
    use numpla_expr::{parse, Stmt};

    fn tree(src: &str) -> Expr {
        match parse(src).0 {
            Stmt::Expr(e) => e,
            other => panic!("not an expression: {:?}", other),
        }
    }

    fn s(e: &str, k: &str, a: &str, b: &str) -> String {
        to_source(&sum(&tree(e), k, &tree(a), &tree(b)).unwrap().expr)
    }

    fn p(e: &str, k: &str, a: &str, b: &str) -> String {
        to_source(&product(&tree(e), k, &tree(a), &tree(b)).unwrap().expr)
    }

    #[test]
    fn the_power_sums() {
        assert_eq!(s("k", "k", "1", "n"), "n * (n + 1)/2");
        assert_eq!(s("1", "k", "1", "n"), "n");
        assert_eq!(s("c", "k", "1", "n"), "c * n");
        assert_eq!(s("k", "k", "1", "100"), "5050");
        assert_eq!(s("k^2", "k", "1", "10"), "385");
        assert_eq!(s("k^3", "k", "1", "10"), "3025");
        // An offset lower limit, which is where hand-derived formulas go wrong.
        assert_eq!(s("k", "k", "3", "10"), "52");
    }

    #[test]
    fn geometric() {
        assert_eq!(s("2^k", "k", "0", "10"), "2047");
        assert_eq!(s("r^k", "k", "0", "n"), "(-r^(n + 1) + 1)/(-r + 1)");
        assert_eq!(s("3 * 2^k", "k", "0", "5"), "189");
    }

    #[test]
    fn added_up_when_there_is_no_formula() {
        // Exact where it can be: `1/3` is a fraction, not a decimal that lost a
        // digit, so the answer keeps it and folds only what folds cleanly.
        assert_eq!(s("1/k", "k", "1", "4"), "1/3 + 1.75");
        assert_eq!(s("sin(k)", "k", "1", "1"), "sin(1)");
    }

    #[test]
    fn products() {
        assert_eq!(p("k", "k", "1", "5"), "120");
        assert_eq!(p("2", "k", "1", "n"), "2^n");
        assert_eq!(p("2^k", "k", "1", "4"), "1024");
    }

    #[test]
    fn refusals_name_the_shape() {
        let e = product(&tree("k"), "k", &tree("1"), &tree("n")).unwrap_err();
        assert!(e.to_string().contains("factorial"), "{}", e);
        let e = sum(&tree("1/k"), "k", &tree("1"), &tree("n")).unwrap_err();
        assert!(e.to_string().contains("no closed form"), "{}", e);
    }

    #[test]
    fn an_empty_range_is_zero_and_one() {
        assert_eq!(s("k", "k", "3", "1"), "0");
        assert_eq!(p("k", "k", "3", "1"), "1");
    }
}
