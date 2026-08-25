//! Distribution: products over sums.
//!
//! `expand` is the one direction of the factor/expand pair that has a unique
//! answer. Factoring does not — `x^2 - 1` is `(x-1)(x+1)` or `(1-x)(-1-x)` or a
//! dozen partial factorings, and choosing between them is a search — so this
//! crate does one of the two and says so, rather than doing both badly.
//!
//! Everything here builds a *sum of products* and then hands it to
//! [`crate::simplify`], which is what collects `x*1 + 1*x` into `2x`. Expansion
//! that did its own collecting would be a second, subtly different simplifier.

use numpla_expr::{BinOp, Expr};

use crate::num::as_integer;
use crate::simplify::{bin, neg, provably_positive, simplify_keeping_logs_apart};

/// The largest integer power of a sum that will be multiplied out.
///
/// `(x + y)^12` is 91 terms; `(x + y)^40` is 861 and climbing quadratically,
/// and nobody asked to read that. Beyond the cap the power is left standing,
/// which is a true statement about the expression rather than a partial one.
const MAX_POWER: f64 = 12.0;

/// A ceiling on how many terms one product may produce. Reaching it leaves that
/// product unexpanded — standing, rather than half-multiplied.
///
/// It is low on purpose. A 256-term polynomial is past the point of being read
/// by anyone, and the cost of producing one is not only time: a sum is a
/// left-associated tree, so `n` terms is `n` frames deep in *every* recursive
/// walk over it — this crate's, the evaluator's, the printer's. A random-tree
/// test overflowed the stack at four thousand.
const MAX_TERMS: usize = 256;

/// Distribute products over sums, then simplify.
pub fn expand(e: &Expr) -> Expr {
    expand_with_steps(e).1
}

/// The expansion twice: distributed, then collected.
///
/// `(x + 1)^2` becomes `x*x + x*1 + 1*x + 1*1` and only then `x^2 + 2x + 1`,
/// and the middle form is the one that shows *why* the coefficient is 2. Both
/// are what the code actually computed, in that order.
pub fn expand_with_steps(e: &Expr) -> (Expr, Expr) {
    let distributed = distribute(e);
    // Not the ordinary `simplify`: that one collects `ln u + ln v` back into
    // `ln(u v)`, which is the opposite of what was just asked for.
    let collected = simplify_keeping_logs_apart(&distributed);
    (distributed, collected)
}

fn distribute(e: &Expr) -> Expr {
    match e {
        Expr::Num(_) | Expr::Var(_) | Expr::Deriv { .. } | Expr::Hole => e.clone(),
        Expr::List(items) => Expr::List(items.iter().map(distribute).collect()),
        Expr::Call { name, args } => {
            let call = Expr::Call {
                name: name.clone(),
                args: args.iter().map(distribute).collect(),
            };
            split_transcendental(&call).unwrap_or(call)
        }
        // A negation is a product by -1, so it distributes: `-(x + y)` is
        // `-x - y`. Wrapping it instead - which is what `neg` alone would do -
        // leaves the one product in the language that `expand` was not
        // expanding.
        Expr::Neg(a) => cross(&Expr::Num(-1.0), &distribute(a)),
        Expr::Bin { op, lhs, rhs } => {
            let (l, r) = (distribute(lhs), distribute(rhs));
            match op {
                BinOp::Add | BinOp::Sub => bin(*op, l, r),
                BinOp::Mul => cross(&l, &r),
                // `(a + b)/c` distributes; `a/(b + c)` does not, and pretending
                // otherwise is the classic wrong answer.
                BinOp::Div => {
                    let parts: Vec<Expr> = terms(&l)
                        .into_iter()
                        .map(|t| bin(BinOp::Div, t, r.clone()))
                        .collect();
                    join(parts)
                }
                BinOp::Pow => integer_power(&l, &r),
            }
        }
    }
}

/// The logarithm laws, in the direction that breaks one call into several.
///
/// This is where `expand` has to be more careful than a textbook:
/// `ln((-2)(-3))` is `ln 6`, while `ln(-2) + ln(-3)` is not a number at all. So
/// a product is only split when both factors are *provably* positive, and a
/// power only when the exponent is an odd integer — where `u^n < 0` for `u < 0`
/// makes the input undefined too, so nothing is lost — or the base is provably
/// positive.
///
/// The conditional forms are not thrown away: [`crate::equal`] offers them with
/// the condition written out, which is where a rewrite that holds on part of
/// the domain belongs.
///
/// **`exp(u + v) -> exp(u) exp(v)` is deliberately absent.** It is an exact
/// identity in the reals and a trap in floating point: `exp(500 - 500)` is `1`
/// and `exp(500)/exp(500)` is `inf/inf`, so the rewrite turns an ordinary
/// number into a NaN on a perfectly reasonable input. Splitting a logarithm
/// only ever makes the intermediate values *smaller*, which is why that
/// direction is safe and this one is not. `equal` offers it, where a candidate
/// is something you choose rather than something you are given.
fn split_transcendental(e: &Expr) -> Option<Expr> {
    let Expr::Call { name, args } = e else {
        return None;
    };
    if args.len() != 1 {
        return None;
    }
    match (name.as_str(), &args[0]) {
        ("ln", Expr::Bin { op: op @ (BinOp::Mul | BinOp::Div), lhs, rhs })
            if provably_positive(lhs) && provably_positive(rhs) =>
        {
            let part = |u: &Expr| Expr::Call { name: "ln".into(), args: vec![u.clone()] };
            Some(bin(
                if *op == BinOp::Mul { BinOp::Add } else { BinOp::Sub },
                part(lhs),
                part(rhs),
            ))
        }
        ("ln", Expr::Bin { op: BinOp::Pow, lhs, rhs }) => {
            let odd = crate::num::const_value(rhs)
                .and_then(as_integer)
                .is_some_and(|n| n % 2 != 0);
            (odd || provably_positive(lhs)).then(|| {
                bin(
                    BinOp::Mul,
                    (**rhs).clone(),
                    Expr::Call { name: "ln".into(), args: vec![(**lhs).clone()] },
                )
            })
        }
        _ => None,
    }
}

/// `(a + b)(c + d)` as `ac + ad + bc + bd`.
fn cross(l: &Expr, r: &Expr) -> Expr {
    let (ls, rs) = (terms(l), terms(r));
    if ls.len() * rs.len() > MAX_TERMS {
        return bin(BinOp::Mul, l.clone(), r.clone());
    }
    let mut out = Vec::with_capacity(ls.len() * rs.len());
    for a in &ls {
        for b in &rs {
            out.push(bin(BinOp::Mul, a.clone(), b.clone()));
        }
    }
    join(out)
}

/// `(a + b)^3` by repeated multiplication — only for a small non-negative
/// integer literal exponent, which is the only case with a finite answer.
fn integer_power(base: &Expr, exp: &Expr) -> Expr {
    let n = match exp {
        Expr::Num(n) if n.fract() == 0.0 && *n >= 0.0 && *n <= MAX_POWER => *n,
        _ => return bin(BinOp::Pow, base.clone(), exp.clone()),
    };
    if terms(base).len() < 2 {
        return bin(BinOp::Pow, base.clone(), exp.clone());
    }
    if n == 0.0 {
        return Expr::Num(1.0);
    }
    // Seeded with the base rather than with 1, so the distributed form a person
    // reads as a step says `x * x * x` and not `1x * x * x`.
    let mut acc = base.clone();
    for _ in 1..(n as usize) {
        acc = cross(&acc, base);
    }
    acc
}

/// The additive terms of an expression, with any subtraction or negation
/// pushed down into the terms themselves.
fn terms(e: &Expr) -> Vec<Expr> {
    let mut out = Vec::new();
    gather(e, false, &mut out);
    out
}

fn gather(e: &Expr, flip: bool, out: &mut Vec<Expr>) {
    match e {
        Expr::Bin { op: BinOp::Add, lhs, rhs } => {
            gather(lhs, flip, out);
            gather(rhs, flip, out);
        }
        Expr::Bin { op: BinOp::Sub, lhs, rhs } => {
            gather(lhs, flip, out);
            gather(rhs, !flip, out);
        }
        Expr::Neg(a) => gather(a, !flip, out),
        _ => out.push(if flip { neg(e.clone()) } else { e.clone() }),
    }
}

fn join(parts: Vec<Expr>) -> Expr {
    let mut it = parts.into_iter();
    match it.next() {
        None => Expr::Num(0.0),
        Some(first) => it.fold(first, |acc, t| bin(BinOp::Add, acc, t)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::print::to_source;
    use numpla_expr::{parse, Stmt};

    fn x(src: &str) -> String {
        let tree = match parse(src).0 {
            Stmt::Expr(e) => e,
            other => panic!("not an expression: {:?}", other),
        };
        to_source(&expand(&tree))
    }

    #[test]
    fn distributes_products_over_sums() {
        assert_eq!(x("2(x + 3)"), "2x + 6");
        assert_eq!(x("(x + 1)(x - 1)"), "x^2 - 1");
        assert_eq!(x("(a + b)(c + d)"), "a * c + a * d + b * c + b * d");
    }

    #[test]
    fn multiplies_out_small_integer_powers() {
        assert_eq!(x("(x + 1)^2"), "x^2 + 2x + 1");
        assert_eq!(x("(x + 1)^3"), "x^3 + 3x^2 + 3x + 1");
        assert_eq!(x("(x + 1)^0"), "1");
    }

    #[test]
    fn a_sum_over_a_denominator_splits_but_a_sum_under_one_does_not() {
        assert_eq!(x("(x + 2)/y"), "x/y + 2/y");
        assert_eq!(x("x/(y + 2)"), "x/(y + 2)");
    }

    #[test]
    fn leaves_what_it_cannot_finish_standing() {
        // Not an integer power, so there is nothing to multiply out.
        assert_eq!(x("(x + 1)^0.5"), "(x + 1)^0.5");
        assert_eq!(x("(x + 1)^20"), "(x + 1)^20");
    }

    #[test]
    fn expands_inside_calls() {
        assert_eq!(x("sin((x + 1)^2)"), "sin(x^2 + 2x + 1)");
    }
}
