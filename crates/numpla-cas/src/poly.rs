//! Univariate polynomials, extracted from an expression tree.
//!
//! This is the shared floor under [`crate::solve`] and [`crate::factor`]:
//! both of them need "is this a polynomial in `x`, and what are its
//! coefficients", and both need the rational root theorem run honestly.
//!
//! # Coefficients stay expressions
//!
//! `a*x^2 + b*x + c` is a polynomial in `x` whether or not `a`, `b` and `c` are
//! numbers, and `solve(a x = b, x)` is a question with an answer. So a
//! coefficient here is an [`Expr`] that does not read the variable, and the
//! numeric algorithms ask for [`Poly::numeric`] first and refuse when it says
//! no. Keeping the symbolic case in the same type is what stops there being two
//! polynomial extractors that disagree about what counts as one.
//!
//! # The rational root theorem, exactly
//!
//! Coefficients arrive as `f64`. Testing a candidate root by evaluating the
//! polynomial in floating point cannot distinguish "zero" from "1e-17", and a
//! CAS that factored `x^2 - 2` as `(x - 1.414..)(x + 1.414..)` would be handing
//! out a lie in a form that looks more precise than the truth. So candidates are
//! tested in exact integer arithmetic on a scaled copy of the polynomial, and a
//! coefficient that is not a fraction with a small denominator makes the whole
//! search refuse rather than approximate.

use numpla_expr::{BinOp, Expr};

use crate::num::{as_integer, divisors, gcd, rationalize};
use crate::simplify::{bin, neg, simplify};

/// The largest degree that will be extracted. Beyond this the convolutions cost
/// more than any answer is worth, and nothing this crate does with a polynomial
/// (solving, factoring, partial fractions) has an honest answer at degree 24
/// anyway.
const MAX_DEGREE: usize = 24;

/// The largest denominator a coefficient may have before the exact algorithms
/// give up on it. `x^2 - 1/3` is worth handling; a coefficient that needs a
/// denominator of a million is a float that happens to be near a fraction.
const MAX_DEN: i64 = 10_000;

/// A polynomial in one variable: `coeffs[i]` multiplies `var^i`.
///
/// Always trimmed, so `coeffs.last()` is a coefficient that is not provably
/// zero and `degree()` is the real degree. The zero polynomial is the empty
/// vector.
#[derive(Debug, Clone, PartialEq)]
pub struct Poly {
    pub coeffs: Vec<Expr>,
}

impl Poly {
    /// Read `e` as a polynomial in `var`, or `None` if it is not one.
    ///
    /// "Not one" is a structural fact, not a failure: `sin(x)` and `1/x` are
    /// perfectly good expressions that this function correctly declines to
    /// describe, and the callers have other things to try.
    pub fn from_expr(e: &Expr, var: &str) -> Option<Poly> {
        let p = extract(e, var)?;
        Some(p.trimmed())
    }

    pub fn degree(&self) -> usize {
        self.coeffs.len().saturating_sub(1)
    }

    pub fn is_zero(&self) -> bool {
        self.coeffs.is_empty()
    }

    /// The coefficients as numbers, or `None` if any of them is symbolic.
    pub fn numeric(&self) -> Option<Vec<f64>> {
        self.coeffs
            .iter()
            .map(|c| match simplify(c) {
                Expr::Num(n) if n.is_finite() => Some(n),
                _ => None,
            })
            .collect()
    }

    /// Rebuild an expression: `a x^2 + b x + c`, highest power first.
    pub fn to_expr(&self, var: &str) -> Expr {
        let mut out: Option<Expr> = None;
        for (i, c) in self.coeffs.iter().enumerate() {
            let power = match i {
                0 => Expr::Num(1.0),
                1 => Expr::Var(var.to_string()),
                _ => bin(BinOp::Pow, Expr::Var(var.to_string()), Expr::Num(i as f64)),
            };
            let term = bin(BinOp::Mul, c.clone(), power);
            out = Some(match out {
                None => term,
                Some(acc) => bin(BinOp::Add, term, acc),
            });
        }
        simplify(&out.unwrap_or(Expr::Num(0.0)))
    }

    fn trimmed(mut self) -> Poly {
        while self.coeffs.last().is_some_and(is_zero_expr) {
            self.coeffs.pop();
        }
        self
    }
}

fn is_zero_expr(e: &Expr) -> bool {
    matches!(simplify(e), Expr::Num(n) if n == 0.0)
}

fn extract(e: &Expr, var: &str) -> Option<Poly> {
    if !e.deps().contains(var) {
        return Some(Poly { coeffs: vec![e.clone()] });
    }
    match e {
        Expr::Var(n) if n == var => Some(Poly {
            coeffs: vec![Expr::Num(0.0), Expr::Num(1.0)],
        }),
        Expr::Neg(a) => {
            let p = extract(a, var)?;
            Some(Poly {
                coeffs: p.coeffs.iter().map(|c| simplify(&neg(c.clone()))).collect(),
            })
        }
        Expr::Bin { op, lhs, rhs } => match op {
            BinOp::Add => add(&extract(lhs, var)?, &extract(rhs, var)?, false),
            BinOp::Sub => add(&extract(lhs, var)?, &extract(rhs, var)?, true),
            BinOp::Mul => mul(&extract(lhs, var)?, &extract(rhs, var)?),
            // `p(x)/q(x)` is a polynomial only when the denominator does not
            // read the variable; anything else is a rational function and
            // belongs to whoever asked, not here.
            BinOp::Div if !rhs.deps().contains(var) => {
                let p = extract(lhs, var)?;
                Some(Poly {
                    coeffs: p
                        .coeffs
                        .iter()
                        .map(|c| simplify(&bin(BinOp::Div, c.clone(), (**rhs).clone())))
                        .collect(),
                })
            }
            BinOp::Pow => {
                let n = as_integer(crate::num::const_value(rhs)?)?;
                if !(0..=MAX_DEGREE as i64).contains(&n) {
                    return None;
                }
                let base = extract(lhs, var)?;
                let mut acc = Poly { coeffs: vec![Expr::Num(1.0)] };
                for _ in 0..n {
                    acc = mul(&acc, &base)?;
                }
                Some(acc)
            }
            _ => None,
        },
        // A call that reads the variable is not polynomial in it, and neither is
        // a list or a hole. The `deps` check above already took the free cases.
        _ => None,
    }
}

fn add(a: &Poly, b: &Poly, subtract: bool) -> Option<Poly> {
    let n = a.coeffs.len().max(b.coeffs.len());
    let zero = Expr::Num(0.0);
    let mut coeffs = Vec::with_capacity(n);
    for i in 0..n {
        let x = a.coeffs.get(i).unwrap_or(&zero).clone();
        let y = b.coeffs.get(i).unwrap_or(&zero).clone();
        coeffs.push(simplify(&bin(
            if subtract { BinOp::Sub } else { BinOp::Add },
            x,
            y,
        )));
    }
    Some(Poly { coeffs })
}

fn mul(a: &Poly, b: &Poly) -> Option<Poly> {
    if a.coeffs.is_empty() || b.coeffs.is_empty() {
        return Some(Poly { coeffs: Vec::new() });
    }
    let n = a.coeffs.len() + b.coeffs.len() - 1;
    if n > MAX_DEGREE + 1 {
        return None;
    }
    let mut coeffs = vec![Expr::Num(0.0); n];
    for (i, x) in a.coeffs.iter().enumerate() {
        for (j, y) in b.coeffs.iter().enumerate() {
            let term = bin(BinOp::Mul, x.clone(), y.clone());
            coeffs[i + j] = simplify(&bin(BinOp::Add, coeffs[i + j].clone(), term));
        }
    }
    Some(Poly { coeffs })
}

// ---- exact integer arithmetic on the coefficients ------------------------

/// The polynomial scaled to primitive integer coefficients, or `None` when a
/// coefficient is not a fraction this crate is willing to call exact.
///
/// The scale is deliberately thrown away: everything downstream — root finding,
/// deflation — is invariant under it, and the callers rebuild the leading
/// constant from the original float coefficients rather than from here.
pub fn integer_form(coeffs: &[f64]) -> Option<Vec<i128>> {
    let mut fracs = Vec::with_capacity(coeffs.len());
    let mut lcm: i64 = 1;
    for c in coeffs {
        let (p, q) = rationalize(*c, MAX_DEN)?;
        fracs.push((p, q));
        let g = gcd(lcm.unsigned_abs(), q.unsigned_abs()) as i64;
        lcm = lcm.checked_mul(q / g)?;
        if lcm > 1_000_000 {
            return None;
        }
    }
    let mut out = Vec::with_capacity(fracs.len());
    for (p, q) in fracs {
        out.push((p as i128).checked_mul((lcm / q) as i128)?);
    }
    // Primitive: the rational root theorem is stated for a content-free
    // polynomial, and dividing out here keeps the divisor searches small.
    let content = out
        .iter()
        .fold(0u128, |g, c| gcd_u128(g, c.unsigned_abs()))
        .max(1);
    for c in &mut out {
        *c /= content as i128;
    }
    Some(out)
}

fn gcd_u128(a: u128, b: u128) -> u128 {
    let (mut a, mut b) = (a, b);
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// Every rational root as `(numerator, denominator)`, with multiplicity, and
/// the integer polynomial left after dividing them all out.
pub type RootsAndRemainder = (Vec<(i64, i64)>, Vec<i128>);

/// Every rational root of an integer polynomial, with multiplicity, together
/// with what is left after dividing them all out.
///
/// `None` means the search could not be run honestly — a coefficient too large
/// to factorise, or arithmetic that would overflow — and is *not* the same
/// answer as "no rational roots". The distinction is the whole point: one of
/// them lets a caller say "this does not factor over the rationals" and the
/// other does not.
pub fn rational_roots(coeffs: &[i128]) -> Option<RootsAndRemainder> {
    let mut work = coeffs.to_vec();
    let mut roots = Vec::new();
    while work.len() > 1 {
        // A zero constant term is the root `0`, and dividing by `x` is a shift.
        if work[0] == 0 {
            roots.push((0, 1));
            work.remove(0);
            continue;
        }
        let Some(found) = one_rational_root(&work) else {
            break;
        };
        let Some(next) = deflate(&work, found.0, found.1) else {
            break;
        };
        roots.push(found);
        work = next;
    }
    Some((roots, work))
}

fn one_rational_root(a: &[i128]) -> Option<(i64, i64)> {
    let n = a.len() - 1;
    let a0 = i64::try_from(a[0]).ok()?;
    let an = i64::try_from(a[n]).ok()?;
    let ps = divisors(a0)?;
    let qs = divisors(an)?;
    for q in &qs {
        for p in &ps {
            for sign in [1i64, -1] {
                let p = sign * p;
                if evaluates_to_zero(a, p, *q)? {
                    let g = gcd(p.unsigned_abs(), q.unsigned_abs()) as i64;
                    return Some((p / g, q / g));
                }
            }
        }
    }
    None
}

/// `sum a_i p^i q^(n-i) == 0`, in exact integer arithmetic.
///
/// `None` on overflow, which propagates out as "the search could not be run"
/// rather than as "not a root".
fn evaluates_to_zero(a: &[i128], p: i64, q: i64) -> Option<bool> {
    // Horner in the homogenised form: acc = acc*p + a_i*q^(n-i). The power of
    // `q` is advanced only when another term needs it, so a polynomial whose
    // last step would overflow is still answered.
    let (p, q) = (p as i128, q as i128);
    let mut acc: i128 = 0;
    let mut qpow: i128 = 1;
    for (k, c) in a.iter().rev().enumerate() {
        if k > 0 {
            qpow = qpow.checked_mul(q)?;
        }
        acc = acc.checked_mul(p)?.checked_add(c.checked_mul(qpow)?)?;
    }
    Some(acc == 0)
}

/// Divide an integer polynomial by `(q x - p)`, exactly.
///
/// Gauss's lemma says the quotient of a primitive integer polynomial by a
/// primitive integer factor is integral, so every division below comes out
/// whole; a remainder means the caller's root was not one, and the answer is
/// `None` rather than a rounded quotient.
fn deflate(a: &[i128], p: i64, q: i64) -> Option<Vec<i128>> {
    let (p, q) = (p as i128, q as i128);
    let n = a.len() - 1;
    let mut b = vec![0i128; n];
    // Top down: a_n = q * b_{n-1}, then a_i = q*b_{i-1} - p*b_i.
    if a[n] % q != 0 {
        return None;
    }
    b[n - 1] = a[n] / q;
    for i in (1..n).rev() {
        let num = a[i].checked_add(p.checked_mul(b[i])?)?;
        if num % q != 0 {
            return None;
        }
        b[i - 1] = num / q;
    }
    // The constant term must vanish, which is the check that `p/q` was a root.
    (a[0].checked_add(p.checked_mul(b[0])?)? == 0).then_some(b)
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

    fn coeffs(src: &str) -> Option<Vec<String>> {
        Poly::from_expr(&tree(src), "x").map(|p| p.coeffs.iter().map(to_source).collect())
    }

    #[test]
    fn reads_a_polynomial_lowest_power_first() {
        assert_eq!(coeffs("2x + 1"), Some(vec!["1".into(), "2".into()]));
        assert_eq!(
            coeffs("(x + 1)^2"),
            Some(vec!["1".into(), "2".into(), "1".into()])
        );
        assert_eq!(coeffs("x^3"), Some(vec!["0".into(), "0".into(), "0".into(), "1".into()]));
    }

    #[test]
    fn coefficients_may_be_symbolic() {
        assert_eq!(coeffs("a*x + b"), Some(vec!["b".into(), "a".into()]));
        assert_eq!(coeffs("x/k"), Some(vec!["0".into(), "1/k".into()]));
    }

    #[test]
    fn declines_what_is_not_a_polynomial() {
        assert_eq!(coeffs("sin(x)"), None);
        assert_eq!(coeffs("1/x"), None);
        assert_eq!(coeffs("x^0.5"), None);
        assert_eq!(coeffs("2^x"), None);
    }

    #[test]
    fn finds_every_rational_root_and_says_what_is_left() {
        // (x - 1)(x + 2)(2x - 3)
        let p = Poly::from_expr(&tree("(x - 1)(x + 2)(2x - 3)"), "x").unwrap();
        let ints = integer_form(&p.numeric().unwrap()).unwrap();
        let (roots, rest) = rational_roots(&ints).unwrap();
        let mut roots = roots;
        roots.sort();
        assert_eq!(roots, vec![(-2, 1), (1, 1), (3, 2)]);
        assert_eq!(rest.len(), 1);
    }

    /// The distinction that matters: no rational roots is an answer, and
    /// "cannot tell" is a different one.
    #[test]
    fn an_irrational_polynomial_reports_no_roots_rather_than_wrong_ones() {
        let p = Poly::from_expr(&tree("x^2 - 2"), "x").unwrap();
        let ints = integer_form(&p.numeric().unwrap()).unwrap();
        let (roots, rest) = rational_roots(&ints).unwrap();
        assert!(roots.is_empty());
        assert_eq!(rest.len(), 3);
        // ...and a coefficient that is not a small fraction is refused outright.
        assert_eq!(integer_form(&[std::f64::consts::PI, 1.0]), None);
    }
}
