//! Solving an equation for one unknown.
//!
//! The crate docs used to say equation solving was out of scope because "a
//! symbolic root-finder that handles quadratics and gives up on cubics would be
//! a worse promise than none". That was the wrong conclusion from a right
//! observation. The problem was never the cubic; it was a solver that gives up
//! *without saying so*. So this module keeps the observation and changes the
//! promise: it answers a stated list of shapes completely, and every other
//! equation gets a refusal that names the shape it is and the reason.
//!
//! # What it answers
//!
//! - **Any polynomial of degree 1 or 2**, with numeric or symbolic
//!   coefficients. `a x = b` is a question with an answer, so it gets one, and
//!   the assumption it rests on (`a != 0`) is written into
//!   [`Solutions::note`] rather than left for the reader to notice.
//! - **Higher degree, through its rational roots.** Every rational root is
//!   found exactly (the rational root theorem, run in integer arithmetic — see
//!   [`crate::poly`]) and divided out; if what is left is linear, quadratic or
//!   biquadratic, the answer is complete and says so.
//! - **Biquadratics**: `x^4 + b x^2 + c`, solved as a quadratic in `x^2`.
//! - **Anything the unknown occurs in exactly once**, by inverting the
//!   operations from the outside in: `2x = 2`, `a e^(b x) = c`, `ln x = c`,
//!   `a x^n = c`, `sqrt(x + 1) = 3`, `2^x = 8`. Each inversion carries its own
//!   domain check, so `sqrt(x) = -1` comes back as "no solutions" rather than
//!   as `1`.
//! - **Products**: a product is zero exactly where one of its factors is, so
//!   `exp(x)(x - 1) = 0` is `x = 1` — `exp` contributing nothing because it is
//!   never zero, which is a fact and not an omission.
//!
//! # What it refuses, by name
//!
//! - **A cubic or quartic with no rational roots.** Cardano's formula is real
//!   and this crate will not print it: the answer to `x^3 - 6x - 6 = 0` is
//!   `(4 + 4)^(1/3) + (4 - 4)^(1/3)`-shaped nesting that nobody reads, and in
//!   the casus irreducibilis it is a real number written as the sum of two
//!   complex ones. An expression a person cannot check is not an answer, so the
//!   refusal says the polynomial has no rational roots and stops.
//! - **Degree five and above** with no rational roots, for Abel's reason.
//! - **Trigonometric equations.** `sin(x) = 0` has infinitely many solutions
//!   and this returns finite sets; a solver that quietly answered `0` would be
//!   wrong in the way that matters.
//! - **Anything the unknown appears in more than once** and that is not a
//!   polynomial — `x + ln(x) = 1` — because there is no inversion to run.
//! - **Complex roots.** `x^2 = -1` has none *over the reals*, which is the
//!   field `numpla-expr` evaluates in, and the refusal says which field it is
//!   talking about.

use numpla_expr::{BinOp, Expr};

use crate::num::{as_integer, const_value, rational_expr};
use crate::poly::{integer_form, rational_roots, Poly};
use crate::simplify::{bin, neg, simplify};
use crate::CasError;

/// The answer to one equation.
#[derive(Debug, Clone, PartialEq)]
pub struct Solutions {
    pub var: String,
    /// Every solution, in a deterministic order. Empty means there are none —
    /// which is an answer, not a failure.
    pub roots: Vec<Expr>,
    /// How it was reached: "linear", "quadratic formula", "rational roots".
    /// The UI shows it; the point is that a person can tell whether to believe
    /// it without reading this file.
    pub method: String,
    /// What the answer assumes, when it assumes anything.
    pub note: Option<String>,
    /// `x = x`: every value works, so the root list would be meaningless.
    pub every_value: bool,
}

impl Solutions {
    fn new(var: &str, roots: Vec<Expr>, method: &str) -> Solutions {
        Solutions {
            var: var.to_string(),
            roots,
            method: method.to_string(),
            note: None,
            every_value: false,
        }
    }

    fn noting(mut self, note: impl Into<String>) -> Solutions {
        self.note = Some(note.into());
        self
    }
}

/// The names an equation could be solved for.
///
/// `pi`, `e` and the rest are excluded: the CAS reads them as the constants the
/// evaluator gives them (see the crate docs), so they are never the unknown.
pub fn unknowns(lhs: &Expr, rhs: &Expr) -> Vec<String> {
    let mut names = crate::factor::free_names(lhs);
    for n in crate::factor::free_names(rhs) {
        if !names.contains(&n) {
            names.push(n);
        }
    }
    names.sort();
    names
}

/// The two sides of whatever the parser made of an equation.
///
/// One line of source can come back as four different [`Stmt`]s and three of
/// them are equations: `x^2 = 1` is an `Equation`, `x = 1` is an `Assign` with
/// no parameters, and `sin(x) = 0` is an `Assign` *with* one, because the
/// parser cannot tell a definition from an equation without knowing which names
/// are already functions. A bare expression means `= 0`. Getting this wrong is
/// how `solve(sin(x) = 0, x)` ends up solving `sin = 0` for `x` and reporting
/// that `x` does not appear, so it is written once, here, where both the
/// compute pane and the tests can use it.
///
/// [`Stmt`]: numpla_expr::Stmt
pub fn equation_of(stmt: &numpla_expr::Stmt) -> Option<(Expr, Expr)> {
    use numpla_expr::Stmt;
    match stmt {
        Stmt::Equation { lhs, rhs } => Some((lhs.clone(), rhs.clone())),
        Stmt::Assign { name, params, rhs } if params.is_empty() => {
            Some((Expr::Var(name.clone()), rhs.clone()))
        }
        Stmt::Assign { name, params, rhs } => Some((
            Expr::Call {
                name: name.clone(),
                args: params.iter().map(|p| Expr::Var(p.clone())).collect(),
            },
            rhs.clone(),
        )),
        Stmt::Expr(e) => Some((e.clone(), Expr::Num(0.0))),
        Stmt::Ode { .. } => None,
    }
}

/// Solve `lhs = rhs` for `var`.
pub fn solve(lhs: &Expr, rhs: &Expr, var: &str) -> Result<Solutions, CasError> {
    if lhs.has_hole() || rhs.has_hole() {
        return Err(CasError::Incomplete);
    }
    let f = simplify(&bin(BinOp::Sub, lhs.clone(), rhs.clone()));
    let mut answer = solve_zero(&f, var)?;
    // Distributing is what turns `(2 - sqrt(8))/2` into `1 - sqrt(2)`. Both are
    // the same number and only one of them can be read at a glance, which for a
    // root is most of the point.
    answer.roots = answer.roots.iter().map(crate::expand).collect();
    sort_roots(&mut answer.roots);
    Ok(answer)
}

/// Ascending, when the roots are numbers.
///
/// A solution *set* has no order, so any order is a presentation choice — and
/// the one that helps is the number line. Roots that are not numbers keep the
/// order they were found in, which is deterministic for a different reason:
/// the rational root search walks its divisors in a fixed sequence.
fn sort_roots(roots: &mut [Expr]) {
    if roots.iter().all(|r| const_value(r).is_some()) {
        roots.sort_by(|a, b| {
            const_value(a)
                .unwrap_or(f64::NAN)
                .total_cmp(&const_value(b).unwrap_or(f64::NAN))
        });
    }
}

/// Solve `f = 0`, which is every equation once it has been rearranged.
fn solve_zero(f: &Expr, var: &str) -> Result<Solutions, CasError> {
    if !f.deps().contains(var) {
        return Ok(match const_value(f) {
            Some(0.0) => Solutions {
                every_value: true,
                ..Solutions::new(var, Vec::new(), "identity")
            },
            _ => Solutions::new(var, Vec::new(), "no dependence on the unknown").noting(format!(
                "`{}` does not appear once the two sides are subtracted, so nothing can be solved for it",
                var
            )),
        });
    }

    // In order: the complete method first, then the one that needs a special
    // shape, then the one that needs the unknown to occur once. A strategy that
    // does not recognise the equation answers `Ok(None)` and the next one gets
    // it; a strategy that recognises it and will not guess answers `Err`, and
    // that sentence is what the caller sees if nothing later succeeds.
    let mut refusal: Option<CasError> = None;
    for strategy in [polynomial, product_of_factors, isolate] {
        match strategy(f, var) {
            Ok(Some(s)) => return Ok(s),
            Ok(None) => {}
            Err(e) => refusal = refusal.or(Some(e)),
        }
    }
    Err(refusal.unwrap_or_else(|| {
        CasError::Unsupported(format!(
            "this CAS cannot solve `{} = 0` for {}: it is not a polynomial, not a product of solvable factors, and {} occurs more than once so there is nothing to invert",
            crate::to_source(f),
            var,
            var
        ))
    }))
}

// ---- polynomials ---------------------------------------------------------

fn polynomial(f: &Expr, var: &str) -> Result<Option<Solutions>, CasError> {
    let Some(p) = Poly::from_expr(f, var) else {
        return Ok(None);
    };
    match p.degree() {
        0 => Ok(None),
        1 => Ok(Some(linear(&p, var))),
        2 => Ok(Some(quadratic(&p.coeffs[2], &p.coeffs[1], &p.coeffs[0], var)?)),
        _ => higher_degree(&p, var).map(Some),
    }
}

fn linear(p: &Poly, var: &str) -> Solutions {
    let (a, b) = (&p.coeffs[1], &p.coeffs[0]);
    let root = simplify(&bin(BinOp::Div, neg(b.clone()), a.clone()));
    let s = Solutions::new(var, vec![root], "linear");
    match const_value(a) {
        Some(_) => s,
        None => s.noting(format!(
            "assuming {} is not zero — if it is, the equation is either an identity or has no solutions",
            crate::to_source(a)
        )),
    }
}

/// `a u^2 + b u + c = 0`, for `u` the unknown itself or a power of it.
fn quadratic(a: &Expr, b: &Expr, c: &Expr, var: &str) -> Result<Solutions, CasError> {
    let roots = quadratic_roots(a, b, c)?;
    let numeric = [a, b, c].iter().all(|e| const_value(e).is_some());
    let s = Solutions::new(
        var,
        roots,
        if numeric { "quadratic formula" } else { "quadratic formula, symbolically" },
    );
    Ok(if numeric {
        s
    } else {
        s.noting(format!(
            "assuming {} is not zero and the discriminant {} is not negative — with symbols there is no way to check either",
            crate::to_source(a),
            crate::to_source(&discriminant(a, b, c))
        ))
    })
}

fn discriminant(a: &Expr, b: &Expr, c: &Expr) -> Expr {
    simplify(&bin(
        BinOp::Sub,
        bin(BinOp::Pow, b.clone(), Expr::Num(2.0)),
        bin(
            BinOp::Mul,
            Expr::Num(4.0),
            bin(BinOp::Mul, a.clone(), c.clone()),
        ),
    ))
}

/// The roots themselves, so a biquadratic can reuse them for `x^2`.
fn quadratic_roots(a: &Expr, b: &Expr, c: &Expr) -> Result<Vec<Expr>, CasError> {
    let disc = discriminant(a, b, c);
    let two_a = simplify(&bin(BinOp::Mul, Expr::Num(2.0), a.clone()));
    let root = |sign: f64| {
        let radical = Expr::Call { name: "sqrt".into(), args: vec![disc.clone()] };
        let top = bin(
            if sign > 0.0 { BinOp::Add } else { BinOp::Sub },
            neg(b.clone()),
            radical,
        );
        simplify(&bin(BinOp::Div, top, two_a.clone()))
    };
    match const_value(&disc) {
        // Over the reals there is nothing here, and saying which field this is
        // matters: somebody who wanted `i` should be told they will not get it.
        Some(d) if d < 0.0 => Ok(Vec::new()),
        Some(0.0) => Ok(vec![simplify(&bin(
            BinOp::Div,
            neg(b.clone()),
            two_a,
        ))]),
        _ => {
            let mut roots = vec![root(-1.0), root(1.0)];
            roots.dedup();
            Ok(roots)
        }
    }
}

/// Degree three and up: divide out every rational root, then finish whatever is
/// left if it is a shape with a readable answer.
fn higher_degree(p: &Poly, var: &str) -> Result<Solutions, CasError> {
    let Some(coeffs) = p.numeric() else {
        return Err(CasError::Unsupported(format!(
            "a polynomial of degree {} with symbolic coefficients has no formula this CAS will print — give the coefficients numbers and it will find the rational roots",
            p.degree()
        )));
    };
    if let Some(s) = biquadratic(&coeffs, var)? {
        return Ok(s);
    }
    let Some(ints) = integer_form(&coeffs) else {
        return Err(CasError::Unsupported(format!(
            "the coefficients of this degree-{} polynomial are not fractions this CAS can work with exactly, and a root found in floating point is not a root",
            p.degree()
        )));
    };
    let Some((rational, rest)) = rational_roots(&ints) else {
        return Err(CasError::Unsupported(
            "the rational root search could not be run on these coefficients — they are too large to factorise".into(),
        ));
    };

    let mut roots: Vec<Expr> = rational
        .iter()
        .map(|(n, d)| rational_expr(*n, *d))
        .collect();
    let rest: Vec<f64> = rest.iter().map(|c| *c as f64).collect();
    let leftover = rest.len().saturating_sub(1);
    match leftover {
        0 => {}
        1 => {
            let q = Poly { coeffs: rest.iter().map(|c| Expr::Num(*c)).collect() };
            roots.extend(linear(&q, var).roots);
        }
        2 => roots.extend(quadratic_roots(
            &Expr::Num(rest[2]),
            &Expr::Num(rest[1]),
            &Expr::Num(rest[0]),
        )?),
        _ => {
            if let Some(s) = biquadratic(&rest, var)? {
                roots.extend(s.roots);
            } else if rational.is_empty() {
                return Err(CasError::Unsupported(format!(
                    "`{}` has no rational roots. This CAS does not print the cubic or quartic formula — its nested radicals are not something a person can check, and for degree five and above no such formula exists. Rational roots, quadratics and `x^4 + b x^2 + c` are what it does answer.",
                    crate::to_source(&p.to_expr(var))
                )));
            } else {
                return Err(CasError::Unsupported(format!(
                    "found the rational roots of `{}` but the remaining degree-{} factor has none, and this CAS does not print the cubic or quartic formula. The answer would be incomplete, so it is not offered.",
                    crate::to_source(&p.to_expr(var)),
                    leftover
                )));
            }
        }
    }
    dedup_roots(&mut roots);
    Ok(Solutions::new(var, roots, "rational roots, then the remaining factor"))
}

/// `a x^4 + b x^2 + c = 0` as a quadratic in `x^2`.
///
/// Worth its own case because the alternative for `x^4 - 5x^2 + 5` is a
/// refusal, and this one has four perfectly readable roots.
fn biquadratic(coeffs: &[f64], var: &str) -> Result<Option<Solutions>, CasError> {
    if coeffs.len() != 5 || coeffs[1] != 0.0 || coeffs[3] != 0.0 {
        return Ok(None);
    }
    let squares = quadratic_roots(
        &Expr::Num(coeffs[4]),
        &Expr::Num(coeffs[2]),
        &Expr::Num(coeffs[0]),
    )?;
    let mut roots = Vec::new();
    for s in &squares {
        // `x^2 = s` contributes two roots when `s > 0`, one when it is zero,
        // and none when it is negative — over the reals, which is the field.
        match const_value(s) {
            Some(v) if v < 0.0 => {}
            Some(0.0) => roots.push(Expr::Num(0.0)),
            _ => {
                let r = simplify(&Expr::Call { name: "sqrt".into(), args: vec![s.clone()] });
                roots.push(simplify(&neg(r.clone())));
                roots.push(r);
            }
        }
    }
    dedup_roots(&mut roots);
    Ok(Some(Solutions::new(
        var,
        roots,
        "quadratic in x^2, then square roots",
    )))
}

fn dedup_roots(roots: &mut Vec<Expr>) {
    let mut seen: Vec<String> = Vec::new();
    roots.retain(|r| {
        let key = crate::to_source(r);
        if seen.contains(&key) {
            false
        } else {
            seen.push(key);
            true
        }
    });
}

// ---- products ------------------------------------------------------------

/// A product is zero exactly where one of its factors is.
///
/// Only tried after the polynomial path, so this is here for the factors that
/// are not polynomials: `exp(x)(x - 1)`, `sqrt(x)(x - 4)`. A factor that cannot
/// be solved makes the *whole* answer a refusal rather than a partial list,
/// because "some of the solutions" is the one thing a solution set must never
/// be.
fn product_of_factors(f: &Expr, var: &str) -> Result<Option<Solutions>, CasError> {
    let mut factors = Vec::new();
    let mut divisors = Vec::new();
    gather_factors(f, false, &mut factors, &mut divisors);
    if factors.iter().filter(|x| x.deps().contains(var)).count() < 2 {
        return Ok(None);
    }

    let mut roots = Vec::new();
    for factor in &factors {
        if !factor.deps().contains(var) {
            continue;
        }
        let part = solve_zero(factor, var)?;
        if part.every_value {
            return Ok(None);
        }
        roots.extend(part.roots);
    }
    // A root of the numerator that also kills a denominator is not a solution:
    // the expression has no value there at all.
    roots.retain(|r| {
        divisors.iter().all(|d| {
            let at = simplify(&crate::subs(d, var, r));
            const_value(&at) != Some(0.0)
        })
    });
    dedup_roots(&mut roots);
    Ok(Some(Solutions::new(var, roots, "zero product")))
}

fn gather_factors(e: &Expr, inverted: bool, top: &mut Vec<Expr>, bottom: &mut Vec<Expr>) {
    match e {
        Expr::Neg(a) => gather_factors(a, inverted, top, bottom),
        Expr::Bin { op: BinOp::Mul, lhs, rhs } => {
            gather_factors(lhs, inverted, top, bottom);
            gather_factors(rhs, inverted, top, bottom);
        }
        Expr::Bin { op: BinOp::Div, lhs, rhs } => {
            gather_factors(lhs, inverted, top, bottom);
            gather_factors(rhs, !inverted, top, bottom);
        }
        _ => {
            if inverted {
                bottom.push(e.clone());
            } else {
                top.push(e.clone());
            }
        }
    }
}

// ---- inverting, one layer at a time --------------------------------------

/// Peel the operations off the unknown from the outside in.
///
/// Only runs when the unknown occurs exactly once, which is what makes each
/// step a genuine inverse rather than a rearrangement that might lose a
/// solution. Every step that has a domain condition checks it against a number
/// — `exp(u) = c` needs `c > 0`, `u^2 = c` needs `c >= 0` — and refuses when the
/// other side is symbolic, because "the answer exists when `c > 0`" is not
/// something to hand somebody without the ability to say whether it does.
fn isolate(f: &Expr, var: &str) -> Result<Option<Solutions>, CasError> {
    if occurrences(f, var) != 1 {
        return Ok(None);
    }
    // Each entry is one branch of the answer: `u^2 = 4` splits into two.
    let mut pending = vec![(f.clone(), Expr::Num(0.0))];
    let mut roots = Vec::new();
    let mut note: Option<String> = None;
    for _ in 0..64 {
        let Some((lhs, rhs)) = pending.pop() else {
            break;
        };
        if matches!(&lhs, Expr::Var(n) if n == var) {
            roots.push(simplify(&rhs));
            continue;
        }
        let step = peel(&lhs, &rhs, var)?;
        if let Some(assumption) = step.note {
            note = note.or(Some(assumption));
        }
        pending.extend(step.branches);
    }
    if !pending.is_empty() {
        return Err(CasError::Unsupported(
            "this equation needs more inversions than this CAS will run — it is nested deeper than any answer would be readable".into(),
        ));
    }
    dedup_roots(&mut roots);
    roots.sort_by(crate::simplify::cmp_expr);
    let mut s = Solutions::new(var, roots, "inverting the operations on the unknown");
    s.note = note;
    Ok(Some(s))
}

struct Peeled {
    branches: Vec<(Expr, Expr)>,
    note: Option<String>,
}

impl Peeled {
    fn one(lhs: Expr, rhs: Expr) -> Peeled {
        Peeled { branches: vec![(lhs, simplify(&rhs))], note: None }
    }
    fn none() -> Peeled {
        Peeled { branches: Vec::new(), note: None }
    }
    fn noting(mut self, note: impl Into<String>) -> Peeled {
        self.note = Some(note.into());
        self
    }
}

fn peel(lhs: &Expr, rhs: &Expr, var: &str) -> Result<Peeled, CasError> {
    let has = |e: &Expr| e.deps().contains(var);
    match lhs {
        Expr::Neg(a) => Ok(Peeled::one((**a).clone(), neg(rhs.clone()))),
        Expr::Bin { op, lhs: l, rhs: r } => {
            let (inner, other, left) = if has(l) {
                ((**l).clone(), (**r).clone(), true)
            } else {
                ((**r).clone(), (**l).clone(), false)
            };
            match op {
                BinOp::Add => Ok(Peeled::one(inner, bin(BinOp::Sub, rhs.clone(), other))),
                BinOp::Sub if left => Ok(Peeled::one(inner, bin(BinOp::Add, rhs.clone(), other))),
                BinOp::Sub => Ok(Peeled::one(inner, bin(BinOp::Sub, other, rhs.clone()))),
                BinOp::Mul => Ok(divide_by(inner, rhs, &other)),
                BinOp::Div if left => Ok(Peeled::one(inner, bin(BinOp::Mul, rhs.clone(), other))),
                // `k/u = c` inverts to `u = k/c`, which needs `c != 0`; and
                // `c = 0` really does mean no solution, because a quotient with
                // a finite numerator is never zero.
                BinOp::Div => Ok(match const_value(rhs) {
                    Some(0.0) => Peeled::none(),
                    _ => Peeled::one(inner, bin(BinOp::Div, other, rhs.clone())),
                }),
                BinOp::Pow if left => power_base(inner, rhs, &other),
                BinOp::Pow => power_exponent(inner, rhs, &other),
            }
        }
        Expr::Call { name, args } if args.len() == 1 => {
            unary_call(name, args[0].clone(), rhs)
        }
        Expr::Call { name, args } if name == "log" && args.len() == 2 && !has(&args[0]) => {
            // `log(b, u) = c` is `u = b^c`, for a base that is a positive
            // number other than one.
            match const_value(&args[0]) {
                Some(b) if b > 0.0 && b != 1.0 => Ok(Peeled::one(
                    args[1].clone(),
                    bin(BinOp::Pow, args[0].clone(), rhs.clone()),
                )),
                _ => Err(CasError::Unsupported(
                    "a logarithm's base has to be a positive number other than 1 before this can be inverted".into(),
                )),
            }
        }
        other => Err(CasError::Unsupported(format!(
            "this CAS has no inverse for `{}`, so it cannot get {} on its own",
            crate::to_source(other),
            var
        ))),
    }
}

/// `u * k = c` becomes `u = c/k`, which is only an inverse when `k != 0`.
fn divide_by(inner: Expr, rhs: &Expr, other: &Expr) -> Peeled {
    let step = Peeled::one(inner, bin(BinOp::Div, rhs.clone(), other.clone()));
    match const_value(other) {
        Some(_) => step,
        None => step.noting(format!(
            "assuming {} is not zero",
            crate::to_source(other)
        )),
    }
}

/// `u^n = c`. The exponent decides how many answers there are.
fn power_base(inner: Expr, rhs: &Expr, exponent: &Expr) -> Result<Peeled, CasError> {
    let Some(n) = const_value(exponent) else {
        return Err(CasError::Unsupported(
            "a power with a symbolic exponent cannot be inverted without knowing whether it is odd, even or fractional".into(),
        ));
    };
    let Some(n) = as_integer(n).filter(|n| *n != 0) else {
        return Err(CasError::Unsupported(format!(
            "this CAS only inverts integer powers, and the exponent here is {}: a fractional power is a root whose domain depends on the sign of both sides, and guessing which branch was meant is how a solver invents solutions",
            n
        )));
    };
    if n % 2 != 0 {
        // Odd: one real root, and the sign follows the right-hand side.
        return Ok(Peeled::one(inner, nth_root(rhs, n)));
    }
    match const_value(rhs) {
        Some(c) if c < 0.0 => Ok(Peeled::none()),
        Some(0.0) => Ok(Peeled::one(inner, Expr::Num(0.0))),
        Some(_) => {
            let root = nth_root(rhs, n);
            Ok(Peeled {
                branches: vec![
                    (inner.clone(), simplify(&root)),
                    (inner, simplify(&neg(root))),
                ],
                note: None,
            })
        }
        None => Err(CasError::Unsupported(format!(
            "`u^{}` has two real roots when the other side is positive, one when it is zero and none when it is negative — and `{}` is a symbol, so this CAS cannot tell which",
            n,
            crate::to_source(rhs)
        ))),
    }
}

/// `b^u = c`, for a numeric base.
fn power_exponent(inner: Expr, rhs: &Expr, base: &Expr) -> Result<Peeled, CasError> {
    let Some(b) = const_value(base).filter(|b| *b > 0.0 && *b != 1.0) else {
        return Err(CasError::Unsupported(
            "an exponential's base has to be a positive number other than 1 before this can be inverted".into(),
        ));
    };
    match const_value(rhs) {
        Some(c) if c <= 0.0 => Ok(Peeled::none()),
        Some(c) => {
            let ln = |u: Expr| Expr::Call { name: "ln".into(), args: vec![u] };
            let quotient = bin(BinOp::Div, ln(rhs.clone()), ln(Expr::Num(b)));
            // `2^x = 8` is `x = 3`, not `x = ln(8)/ln(2)`. Both are the same
            // number and only one of them is an answer, so the quotient is
            // rationalised — and then checked by raising the base back to it,
            // because a logarithm that merely *looks* rational is exactly the
            // kind of thing this crate does not pass on.
            Ok(Peeled::one(inner, exact_exponent(&quotient, b, c).unwrap_or(quotient)))
        }
        None => Err(CasError::Unsupported(format!(
            "`{}^u = c` has a solution only when `c > 0`, and `{}` is a symbol, so this CAS cannot tell whether it does",
            crate::to_source(base),
            crate::to_source(rhs)
        ))),
    }
}

/// A logarithm quotient as a fraction, when raising the base to it really does
/// give the number back.
fn exact_exponent(quotient: &Expr, base: f64, target: f64) -> Option<Expr> {
    let v = const_value(quotient)?;
    let (p, q) = crate::num::rationalize(v, 64)?;
    let check = base.powf(p as f64 / q as f64);
    ((check - target).abs() <= 1e-12 * target.abs().max(1.0)).then(|| rational_expr(p, q))
}

/// `c^(1/n)`, written so that a negative `c` under an odd root stays real.
///
/// `(-8)^(1/3)` is NaN in IEEE arithmetic — a fractional power of a negative
/// number has no real value — so the sign is pulled out first and the answer is
/// `-(8^(1/3))`, which is `-2` and which the printer can round-trip.
fn nth_root(c: &Expr, n: i64) -> Expr {
    let radical = |u: Expr| {
        if n == 2 {
            Expr::Call { name: "sqrt".into(), args: vec![u] }
        } else {
            bin(BinOp::Pow, u, rational_expr(1, n))
        }
    };
    let exact = |v: f64| {
        // `32^(1/5)` is `2`, and `simplify` will not say so: it keeps `1/5` as a
        // fraction rather than as `0.2`, which is the right call everywhere
        // except here. So the whole root is folded when it comes out a whole
        // number, checked by raising it back.
        let r = v.abs().powf(1.0 / n as f64).round();
        (n.unsigned_abs() < 64 && r.powi(n as i32) == v.abs()).then_some(r)
    };
    match const_value(c) {
        Some(v) if v < 0.0 => match exact(v) {
            Some(r) => Expr::Num(-r),
            None => neg(radical(Expr::Num(-v))),
        },
        Some(v) => match exact(v) {
            Some(r) => Expr::Num(r),
            None => radical(c.clone()),
        },
        None => radical(c.clone()),
    }
}

fn unary_call(name: &str, arg: Expr, rhs: &Expr) -> Result<Peeled, CasError> {
    let call = |n: &str, u: Expr| Expr::Call { name: n.into(), args: vec![u] };
    match name {
        // `ln u = c` needs nothing of `c`: every real is a logarithm of
        // something. This is the one inversion with no condition at all.
        "ln" => Ok(Peeled::one(arg, call("exp", rhs.clone()))),
        "log" => Ok(Peeled::one(
            arg,
            bin(BinOp::Pow, Expr::Num(10.0), rhs.clone()),
        )),
        "exp" => match const_value(rhs) {
            Some(c) if c <= 0.0 => Ok(Peeled::none()),
            Some(_) => Ok(Peeled::one(arg, call("ln", rhs.clone()))),
            None => Err(CasError::Unsupported(format!(
                "`exp(u) = c` has a solution only when `c > 0`, and `{}` is a symbol",
                crate::to_source(rhs)
            ))),
        },
        "sqrt" => match const_value(rhs) {
            Some(c) if c < 0.0 => Ok(Peeled::none()),
            Some(_) => Ok(Peeled::one(
                arg,
                bin(BinOp::Pow, rhs.clone(), Expr::Num(2.0)),
            )),
            None => Err(CasError::Unsupported(format!(
                "`sqrt(u) = c` has a solution only when `c >= 0`, and `{}` is a symbol",
                crate::to_source(rhs)
            ))),
        },
        "abs" => match const_value(rhs) {
            Some(c) if c < 0.0 => Ok(Peeled::none()),
            Some(0.0) => Ok(Peeled::one(arg, Expr::Num(0.0))),
            Some(_) => Ok(Peeled {
                branches: vec![
                    (arg.clone(), simplify(rhs)),
                    (arg, simplify(&neg(rhs.clone()))),
                ],
                note: None,
            }),
            None => Err(CasError::Unsupported(format!(
                "`abs(u) = c` splits into two equations only when the sign of `{}` is known",
                crate::to_source(rhs)
            ))),
        },
        "tanh" => Err(CasError::Unsupported(
            "inverting `tanh` needs `artanh`, which Numpla has no name for — write it as `ln((1 + u)/(1 - u))/2` if you need it".into(),
        )),
        "sinh" | "cosh" => Err(CasError::Unsupported(format!(
            "inverting `{}` needs an inverse hyperbolic function, and Numpla has no name for one",
            name
        ))),
        "sin" | "cos" | "tan" => Err(CasError::Unsupported(format!(
            "`{}(u) = c` has infinitely many solutions, one per period. This CAS returns finite solution sets, so it will not pick one and call it the answer — `arc{}` gives you the principal value if that is what you want.",
            name, name
        ))),
        "arcsin" | "arccos" | "arctan" => Ok(Peeled::one(
            arg,
            call(&name[3..], rhs.clone()),
        )),
        "floor" | "ceil" | "round" | "sign" => Err(CasError::Unsupported(format!(
            "`{}` maps whole intervals to one value, so an equation through it has an interval of solutions rather than a list",
            name
        ))),
        other => Err(CasError::Unsupported(format!(
            "this CAS has no inverse for `{}`",
            other
        ))),
    }
}

fn occurrences(e: &Expr, var: &str) -> usize {
    match e {
        Expr::Var(n) if n == var => 1,
        Expr::Num(_) | Expr::Var(_) | Expr::Deriv { .. } | Expr::Hole => 0,
        Expr::Neg(a) => occurrences(a, var),
        Expr::Bin { lhs, rhs, .. } => occurrences(lhs, var) + occurrences(rhs, var),
        Expr::Call { args, .. } => args.iter().map(|a| occurrences(a, var)).sum(),
        Expr::List(items) => items.iter().map(|i| occurrences(i, var)).sum(),
    }
}

// ---- checking the answer -------------------------------------------------

/// How well a proposed root stands up to being substituted back in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootCheck {
    /// Substituting it and simplifying gives exactly zero. Nothing to argue
    /// with.
    Exact,
    /// It evaluates to zero to within rounding. The usual outcome for a root
    /// with a radical in it, where the algebra to cancel it symbolically is
    /// precisely the algebra this crate refuses to do (`sqrt(u)^2 -> u`).
    Numeric,
    /// It does not vanish, or cannot be evaluated at all. Never returned for a
    /// root this crate produced; the tests assert that.
    Failed,
}

/// Substitute `root` back into `lhs = rhs` and see whether the equation holds.
///
/// The point of publishing this is that the answer to "did you check?" should
/// be a value the caller can render, not a claim in a doc comment. The compute
/// pane shows it beside each solution.
pub fn check_root(lhs: &Expr, rhs: &Expr, var: &str, root: &Expr) -> RootCheck {
    let f = bin(BinOp::Sub, lhs.clone(), rhs.clone());
    let residual = simplify(&crate::subs(&f, var, root));
    if matches!(residual, Expr::Num(n) if n == 0.0) {
        return RootCheck::Exact;
    }
    match const_value(&residual) {
        // Scaled by the size of the terms that cancelled, because
        // `1e-16 * 1e20` is still an exact cancellation and `1e-16` next to
        // terms of size 1 is not the same claim.
        Some(v) => {
            let scale = const_value(&simplify(&crate::subs(lhs, var, root)))
                .unwrap_or(1.0)
                .abs()
                .max(1.0);
            if v.abs() <= 1e-9 * scale {
                RootCheck::Numeric
            } else {
                RootCheck::Failed
            }
        }
        None => RootCheck::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::print::to_source;
    use numpla_expr::parse;

    fn equation(src: &str) -> (Expr, Expr) {
        equation_of(&parse(src).0).unwrap_or_else(|| panic!("not an equation: {}", src))
    }

    fn roots(src: &str, var: &str) -> Vec<String> {
        let (l, r) = equation(src);
        solve(&l, &r, var)
            .unwrap_or_else(|e| panic!("{}: {}", src, e))
            .roots
            .iter()
            .map(to_source)
            .collect()
    }

    fn refusal(src: &str, var: &str) -> String {
        let (l, r) = equation(src);
        match solve(&l, &r, var) {
            Err(CasError::Unsupported(m)) => m,
            other => panic!("{} was not refused: {:?}", src, other),
        }
    }

    /// The complaint the whole module exists to answer.
    #[test]
    fn two_x_equals_two() {
        assert_eq!(roots("2x = 2", "x"), vec!["1"]);
    }

    #[test]
    fn linear_with_symbolic_coefficients() {
        assert_eq!(roots("a*x = b", "x"), vec!["b/a"]);
        assert_eq!(roots("3x + 1 = 7", "x"), vec!["2"]);
        let (l, r) = equation("a*x = b");
        assert!(solve(&l, &r, "x").unwrap().note.unwrap().contains("not zero"));
    }

    #[test]
    fn quadratics_including_the_irrational_ones() {
        assert_eq!(roots("x^2 = 4", "x"), vec!["-2", "2"]);
        assert_eq!(roots("x^2 - 3x + 2 = 0", "x"), vec!["1", "2"]);
        assert_eq!(roots("x^2 = 2", "x"), vec!["-sqrt(2)", "sqrt(2)"]);
        // A double root is one root, and the count is part of the answer.
        assert_eq!(roots("x^2 + 2x + 1 = 0", "x"), vec!["-1"]);
        // ...and a discriminant below zero means none, over the reals.
        assert!(roots("x^2 + 1 = 0", "x").is_empty());
    }

    /// `(2 + sqrt(8))/2` is `1 + sqrt(2)`, and nobody can see that. The radical
    /// simplification in `simplify` is what makes these readable.
    #[test]
    fn roots_come_out_in_lowest_terms() {
        assert_eq!(roots("x^2 - 2x - 1 = 0", "x"), vec!["-sqrt(2) + 1", "sqrt(2) + 1"]);
    }

    #[test]
    fn cubics_and_up_through_their_rational_roots() {
        assert_eq!(roots("x^3 - x = 0", "x"), vec!["-1", "0", "1"]);
        assert_eq!(roots("x^3 - 6x^2 + 11x - 6 = 0", "x"), vec!["1", "2", "3"]);
        // One rational root, and a quadratic left that has two more.
        assert_eq!(roots("x^3 - 2x^2 - x + 2 = 0", "x"), vec!["-1", "1", "2"]);
    }

    #[test]
    fn biquadratics() {
        assert_eq!(roots("x^4 - 5x^2 + 4 = 0", "x"), vec!["-2", "-1", "1", "2"]);
    }

    #[test]
    fn the_transcendental_shapes() {
        assert_eq!(roots("ln(x) = 0", "x"), vec!["1"]);
        assert_eq!(roots("2exp(3x) = 8", "x"), vec!["ln(4)/3"]);
        assert_eq!(roots("2^x = 8", "x"), vec!["3"]);
        assert_eq!(roots("x^5 = 32", "x"), vec!["2"]);
        assert_eq!(roots("3x^3 = 24", "x"), vec!["2"]);
        assert_eq!(roots("sqrt(x + 1) = 3", "x"), vec!["8"]);
        // A domain that rules everything out is an answer too.
        assert!(roots("sqrt(x) = -1", "x").is_empty());
        assert!(roots("exp(x) = -1", "x").is_empty());
    }

    #[test]
    fn a_product_is_zero_where_a_factor_is() {
        assert_eq!(roots("exp(x)(x - 1) = 0", "x"), vec!["1"]);
    }

    #[test]
    fn refusals_name_what_they_refused() {
        assert!(refusal("sin(x) = 0", "x").contains("infinitely many"));
        assert!(refusal("x^3 - 6x - 6 = 0", "x").contains("no rational roots"));
        assert!(refusal("x + ln(x) = 1", "x").contains("more than once"));
    }

    #[test]
    fn an_identity_and_a_contradiction_are_different_answers() {
        let (l, r) = equation("2x = 2x");
        assert!(solve(&l, &r, "x").unwrap().every_value);
        let (l, r) = equation("x + 1 = x + 2");
        let s = solve(&l, &r, "x").unwrap();
        assert!(!s.every_value && s.roots.is_empty());
    }

    #[test]
    fn every_root_survives_being_put_back() {
        for (src, var) in [
            ("x^2 - 3x + 2 = 0", "x"),
            ("x^2 = 2", "x"),
            ("2exp(3x) = 8", "x"),
            ("x^4 - 5x^2 + 4 = 0", "x"),
        ] {
            let (l, r) = equation(src);
            for root in solve(&l, &r, var).unwrap().roots {
                assert_ne!(
                    check_root(&l, &r, var, &root),
                    RootCheck::Failed,
                    "{} with {} = {}",
                    src,
                    var,
                    to_source(&root)
                );
            }
        }
    }
}
