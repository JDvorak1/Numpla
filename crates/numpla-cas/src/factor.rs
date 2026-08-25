//! Factoring, over the rationals and no further.
//!
//! `expand`'s module docs say factoring "does not have a unique answer", and
//! that is still true of the general problem — but it *does* have one once the
//! question is narrowed, and narrowing it is what makes an answer worth
//! printing:
//!
//! - **Over the rationals.** `x^2 - 2` comes back as `x^2 - 2`, not as
//!   `(x - sqrt(2))(x + sqrt(2))`. Both are true; only the first is what
//!   somebody factoring a polynomial is asking for, and the second is available
//!   from `solve` for anyone who wants the roots themselves.
//! - **Complete over the rationals for one variable.** Every rational root is
//!   found by the rational root theorem and divided out exactly, so the leftover
//!   factor genuinely has none. "Found nothing" is therefore an answer rather
//!   than a shrug.
//! - **Common factors otherwise.** `2x + 4y` is `2(x + 2y)` in any number of
//!   variables. Multivariate factoring proper needs a different algorithm and a
//!   much larger one, and half of it would be worse than none.
//!
//! Everything produced is checked back against the input with
//! [`crate::num::agrees`] before it is returned. The integer arithmetic
//! underneath is exact, but it starts from `f64` coefficients, and the one
//! thing this crate will not do is hand out an expression that is not the one
//! it was asked about.

use std::collections::BTreeMap;

use numpla_expr::{BinOp, Expr};

use crate::num::{agrees, gcd, rationalize};
use crate::poly::{integer_form, rational_roots, Poly};
use crate::simplify::{bin, neg, simplify};

/// Factor `e` as far as this crate honestly can.
///
/// Never fails: an expression with nothing to factor comes back simplified,
/// which is the true answer to "what are its factors".
pub fn factor(e: &Expr) -> Expr {
    let s = simplify(e);
    // Polynomial first: it is the complete answer where it applies, and the
    // common-factor pass would only find a prefix of it.
    for candidate in [factor_polynomial(&s), factor_common(&s)].into_iter().flatten() {
        let candidate = simplify(&candidate);
        if candidate != s && agrees(&s, &candidate) {
            return candidate;
        }
    }
    s
}

/// The free names of an expression, minus the built-in constants.
pub(crate) fn free_names(e: &Expr) -> Vec<String> {
    e.deps()
        .into_iter()
        .filter(|n| !matches!(n.as_str(), "pi" | "tau" | "e" | "inf"))
        .collect()
}

// ---- one variable, over the rationals ------------------------------------

fn factor_polynomial(e: &Expr) -> Option<Expr> {
    let names = free_names(e);
    let [var] = names.as_slice() else {
        return None;
    };
    let p = Poly::from_expr(e, var)?;
    if p.degree() < 2 {
        return None;
    }
    let coeffs = p.numeric()?;
    let (roots, rest) = rational_roots(&integer_form(&coeffs)?)?;
    if roots.is_empty() {
        return None;
    }

    // Group repeated roots so `(x - 1)(x - 1)` prints as `(x - 1)^2`.
    let mut multiplicity: BTreeMap<(i64, i64), u32> = BTreeMap::new();
    for r in &roots {
        *multiplicity.entry(*r).or_insert(0) += 1;
    }

    let mut out: Option<Expr> = None;
    let mut leading = 1.0f64;
    for ((p_num, q_den), m) in &multiplicity {
        leading *= (*q_den as f64).powi(*m as i32);
        let linear = simplify(&bin(
            BinOp::Sub,
            bin(BinOp::Mul, Expr::Num(*q_den as f64), Expr::Var(var.clone())),
            Expr::Num(*p_num as f64),
        ));
        let piece = if *m == 1 {
            linear
        } else {
            bin(BinOp::Pow, linear, Expr::Num(*m as f64))
        };
        out = Some(match out {
            None => piece,
            Some(acc) => bin(BinOp::Mul, acc, piece),
        });
    }
    let mut product = out?;

    // Whatever the rational roots did not account for.
    if rest.len() > 1 {
        let remainder = Poly {
            coeffs: rest.iter().map(|c| Expr::Num(*c as f64)).collect(),
        };
        leading *= *rest.last()? as f64;
        product = bin(BinOp::Mul, product, remainder.to_expr(var));
    } else {
        leading *= *rest.first()? as f64;
    }

    // The scale the integer arithmetic threw away, recovered from the leading
    // coefficient rather than tracked: one division instead of a content that
    // has to stay right through every deflation.
    let scale = coeffs.last()? / leading;
    Some(if scale == 1.0 {
        product
    } else {
        bin(BinOp::Mul, Expr::Num(scale), product)
    })
}

// ---- any number of variables: the common factor --------------------------

fn factor_common(e: &Expr) -> Option<Expr> {
    let mut terms: Vec<(f64, BTreeMap<String, f64>)> = Vec::new();
    let mut originals: Vec<Expr> = Vec::new();
    collect_terms(e, 1.0, &mut originals);
    if originals.len() < 2 {
        return None;
    }
    for t in &originals {
        terms.push(term_parts(t));
    }

    let coefficient = common_rational(&terms.iter().map(|(c, _)| *c).collect::<Vec<_>>())?;
    let mut shared: BTreeMap<String, f64> = terms[0].1.clone();
    for (_, powers) in &terms[1..] {
        shared.retain(|name, exp| {
            // Only a power that every term carries, and only in the direction
            // that leaves the quotient a polynomial.
            match powers.get(name) {
                Some(other) if *exp > 0.0 && *other > 0.0 => {
                    *exp = exp.min(*other);
                    true
                }
                _ => false,
            }
        });
    }
    shared.retain(|_, exp| *exp > 0.0);
    if coefficient == 1.0 && shared.is_empty() {
        return None;
    }

    let mut divisor = Expr::Num(coefficient);
    for (name, exp) in &shared {
        let power = if *exp == 1.0 {
            Expr::Var(name.clone())
        } else {
            bin(BinOp::Pow, Expr::Var(name.clone()), Expr::Num(*exp))
        };
        divisor = bin(BinOp::Mul, divisor, power);
    }
    let divisor = simplify(&divisor);

    let mut inner: Option<Expr> = None;
    for t in &originals {
        let quotient = simplify(&bin(BinOp::Div, t.clone(), divisor.clone()));
        inner = Some(match inner {
            None => quotient,
            Some(acc) => bin(BinOp::Add, acc, quotient),
        });
    }
    Some(bin(BinOp::Mul, divisor, inner?))
}

fn collect_terms(e: &Expr, sign: f64, out: &mut Vec<Expr>) {
    match e {
        Expr::Neg(a) => collect_terms(a, -sign, out),
        Expr::Bin { op: BinOp::Add, lhs, rhs } => {
            collect_terms(lhs, sign, out);
            collect_terms(rhs, sign, out);
        }
        Expr::Bin { op: BinOp::Sub, lhs, rhs } => {
            collect_terms(lhs, sign, out);
            collect_terms(rhs, -sign, out);
        }
        _ => out.push(if sign < 0.0 { neg(e.clone()) } else { e.clone() }),
    }
}

/// One term as a numeric coefficient and the powers of the plain names in it.
///
/// Anything that is not a name to a literal power is ignored rather than
/// guessed at, which makes the shared factor a lower bound — the honest
/// direction for something that has to divide every term exactly.
fn term_parts(e: &Expr) -> (f64, BTreeMap<String, f64>) {
    let mut coeff = 1.0;
    let mut powers = BTreeMap::new();
    walk_term(e, 1.0, &mut coeff, &mut powers);
    (coeff, powers)
}

fn walk_term(e: &Expr, sign: f64, coeff: &mut f64, powers: &mut BTreeMap<String, f64>) {
    match e {
        Expr::Num(n) => *coeff *= n.powf(sign),
        Expr::Neg(a) => {
            *coeff = -*coeff;
            walk_term(a, sign, coeff, powers);
        }
        Expr::Var(name) => *powers.entry(name.clone()).or_insert(0.0) += sign,
        Expr::Bin { op: BinOp::Mul, lhs, rhs } => {
            walk_term(lhs, sign, coeff, powers);
            walk_term(rhs, sign, coeff, powers);
        }
        Expr::Bin { op: BinOp::Div, lhs, rhs } => {
            walk_term(lhs, sign, coeff, powers);
            walk_term(rhs, -sign, coeff, powers);
        }
        Expr::Bin { op: BinOp::Pow, lhs, rhs } => {
            if let (Expr::Var(name), Expr::Num(n)) = (&**lhs, &**rhs) {
                *powers.entry(name.clone()).or_insert(0.0) += sign * n;
            }
        }
        _ => {}
    }
}

/// The greatest rational that divides all of `values` exactly.
///
/// `gcd` of the numerators over `lcm` of the denominators, which is the
/// definition for rationals. A value that is not a small fraction makes the
/// whole thing `None`, because a "common factor" that is only approximately
/// common is not one.
fn common_rational(values: &[f64]) -> Option<f64> {
    let mut num = 0i64;
    let mut den = 1i64;
    for v in values {
        let (p, q) = rationalize(*v, 10_000)?;
        num = gcd(num.unsigned_abs(), p.unsigned_abs()) as i64;
        let g = gcd(den.unsigned_abs(), q.unsigned_abs()) as i64;
        den = den.checked_mul(q / g)?;
        if den > 1_000_000 {
            return None;
        }
    }
    let g = num as f64 / den as f64;
    // Pull out a leading minus as well, so `-2x - 4y` is `-2(x + 2y)`.
    Some(if values.iter().all(|v| *v < 0.0) { -g } else { g })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::print::to_source;
    use numpla_expr::{parse, Stmt};

    fn f(src: &str) -> String {
        let tree = match parse(src).0 {
            Stmt::Expr(e) => e,
            other => panic!("not an expression: {:?}", other),
        };
        to_source(&factor(&tree))
    }

    #[test]
    fn factors_a_polynomial_over_the_rationals() {
        assert_eq!(f("x^2 - 1"), "(x + 1) * (x - 1)");
        assert_eq!(f("x^2 + 2x + 1"), "(x + 1)^2");
        assert_eq!(f("x^2 + x"), "x * (x + 1)");
        assert_eq!(f("2x^2 - 5x + 3"), "(x - 1) * (2x - 3)");
    }

    /// A quadratic with irrational roots is already factored, over the field
    /// this function works in. Saying so beats inventing `sqrt(2)`.
    #[test]
    fn stops_at_the_rationals() {
        assert_eq!(f("x^2 - 2"), "x^2 - 2");
        assert_eq!(f("x^2 + 1"), "x^2 + 1");
    }

    #[test]
    fn pulls_out_a_common_factor_in_any_number_of_variables() {
        assert_eq!(f("2x + 4y"), "2(x + 2y)");
        assert_eq!(f("x*y + x*z"), "x * (y + z)");
        assert_eq!(f("3x^2*y + 6x*y^2"), "3x * y * (x + 2y)");
    }

    #[test]
    fn leaves_alone_what_has_no_factors() {
        assert_eq!(f("x + 1"), "x + 1");
        assert_eq!(f("sin(x) + 1"), "sin(x) + 1");
        assert_eq!(f("x + y"), "x + y");
    }
}
