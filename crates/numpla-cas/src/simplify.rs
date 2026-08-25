//! Simplification: arithmetic folding, identity and zero laws, like terms, and
//! a canonical order for the commutative operators.
//!
//! # The rule everything here obeys
//!
//! **A rewrite that changes the value is a bug, not a trade-off.** A simplifier
//! that is merely plausible is worse than none, because the person reading the
//! answer cannot tell when it lied. So several textbook rewrites are *not*
//! applied here, each for a stated reason:
//!
//! - `(a^b)^c -> a^(b*c)` only when `b` and `c` are both integer literals.
//!   `(x^2)^0.5` is `|x|`, not `x`.
//! - `x^a * x^b -> x^(a+b)` only for integer literal exponents, for the same
//!   reason: `x^0.5 * x^0.5` is not `x` when `x < 0`.
//! - `exp(ln u) -> u` and `sqrt(u)^2 -> u` are never applied: both change the
//!   value outside the domain of the inner function. `ln(exp u) -> u` *is*
//!   applied, and the asymmetry is the point — see [`call`].
//! - `ln(u*v) -> ln u + ln v` is not applied unless both factors are provably
//!   positive, because `ln((-2)(-3))` is a number and `ln(-2) + ln(-3)` is not.
//!   The conditional form is offered by [`crate::equal`] *with its condition
//!   attached*, which is the only honest way to hand somebody a rewrite that
//!   is true on part of the domain.
//! - Transcendental calls of a literal are left alone. `sin(2)` is a number the
//!   way `sqrt(2)` is; turning it into `0.9092974268256817` throws away the
//!   only exact form there is. `evalf` is where you ask for a number.
//!
//! Two rewrites *do* change the value at isolated points, and are kept because
//! every CAS keeps them and the alternative is an unusable simplifier:
//! `0 * u -> 0` and cancelling `u/u -> 1`, both of which differ from the input
//! where `u` is not finite. The property test skips points where the *input*
//! is not finite, which is exactly the set on which they disagree.
//!
//! Merging logarithms is a third, of a different kind: `ln u + ln v` and
//! `ln(u v)` are the same real number, but the product can overflow to infinity
//! where the two logarithms were ordinary — so the rewrite is bounded to the
//! coefficients that make an expression shorter (see [`MAX_LOG_COEFF`]) and the
//! disagreement, where it happens at all, is the floating-point range and not
//! the algebra.
//!
//! # Shape of the algorithm
//!
//! Sums and products are flattened into n-ary bags, because that is the only
//! form in which "collect like terms" and "canonical order" are one step rather
//! than a search over associativity:
//!
//! - a sum becomes `constant + sum of (coefficient, term)`, terms merged by
//!   structural equality;
//! - a product becomes `numerator/denominator constant * product of
//!   (base, exponent)`, bases merged by structural equality.
//!
//! Rebuilding is left-associative and sorted, so the output of `simplify` is
//! already in the canonical form the next pass expects — which is what makes
//! the fixpoint loop terminate in two or three passes.

use std::cmp::Ordering;

use numpla_expr::{BinOp, Expr};

/// Simplify to a fixpoint.
///
/// The bound exists because a rewrite set that oscillates is a bug we would
/// rather see as a stale answer than as a hung tab; in practice this settles
/// after two passes (the second one proving the first reached the fixpoint).
pub fn simplify(e: &Expr) -> Expr {
    fixpoint(e, true)
}

/// Simplify without collecting a sum of logarithms back into one.
///
/// [`crate::expand`] wants the *other* direction, and a final pass that undid
/// what it had just done would make expansion of a logarithm a no-op with extra
/// steps. Everything else about the two is identical, so this is one flag
/// rather than a second simplifier that could drift from this one.
pub(crate) fn simplify_keeping_logs_apart(e: &Expr) -> Expr {
    fixpoint(e, false)
}

fn fixpoint(e: &Expr, merge_logs: bool) -> Expr {
    let step = |e: &Expr| {
        let reduced = pass(e);
        if merge_logs {
            merge_log_sums(&reduced)
        } else {
            reduced
        }
    };
    let mut cur = step(e);
    for _ in 0..8 {
        let next = step(&cur);
        if next == cur {
            break;
        }
        cur = next;
    }
    cur
}

fn pass(e: &Expr) -> Expr {
    match e {
        Expr::Num(_) | Expr::Var(_) | Expr::Deriv { .. } | Expr::Hole => e.clone(),
        Expr::List(items) => Expr::List(items.iter().map(pass).collect()),
        Expr::Call { name, args } => call(name, args.iter().map(pass).collect()),
        // `-u` is `(-1) * u`, so it goes through the product path and comes
        // back out as a `Neg` only if the coefficient is still exactly -1.
        // Doing it any other way means writing every product rule twice.
        Expr::Neg(a) => product(&[(Expr::Num(-1.0), false), (pass(a), false)]),
        Expr::Bin { op, lhs, rhs } => {
            let (l, r) = (pass(lhs), pass(rhs));
            match op {
                BinOp::Add => sum(&[(l, false), (r, false)]),
                BinOp::Sub => sum(&[(l, false), (r, true)]),
                BinOp::Mul => product(&[(l, false), (r, false)]),
                BinOp::Div => product(&[(l, false), (r, true)]),
                BinOp::Pow => power(l, r),
            }
        }
    }
}

// ---- sums ---------------------------------------------------------------

/// One addend, as a numeric coefficient times a canonical remainder.
struct Term {
    coeff: f64,
    rest: Expr,
}

/// Flatten, collect and rebuild a sum. Each input is `(expr, negated)`.
fn sum(parts: &[(Expr, bool)]) -> Expr {
    let mut konst = 0.0f64;
    let mut terms: Vec<Term> = Vec::new();
    for (e, neg) in parts {
        gather_sum(e, if *neg { -1.0 } else { 1.0 }, &mut konst, &mut terms);
    }

    // A coefficient of exactly zero drops the term: `x - x` is `0`, and that is
    // the whole reason anyone runs a simplifier.
    terms.retain(|t| t.coeff != 0.0);
    // Descending degree, so a polynomial reads the way it is written by hand —
    // `x^2 + x + 1` rather than `1 + x + x^2`. Degree is a display heuristic
    // (see `degree`); `cmp_expr` breaks every tie, so the order is total and
    // the output is deterministic.
    terms.sort_by(|a, b| {
        degree(&b.rest)
            .partial_cmp(&degree(&a.rest))
            .unwrap_or(Ordering::Equal)
            .then_with(|| cmp_expr(&a.rest, &b.rest))
    });

    let mut out: Option<Expr> = None;
    for t in &terms {
        out = Some(match out {
            // The leading term keeps its sign inside the coefficient, so a sum
            // opens `-2x` rather than `-(2x)`.
            None => scale(t.coeff, &t.rest),
            Some(acc) => bin(
                if t.coeff < 0.0 { BinOp::Sub } else { BinOp::Add },
                acc,
                scale(t.coeff.abs(), &t.rest),
            ),
        });
    }

    match out {
        None => Expr::Num(konst),
        Some(acc) if konst == 0.0 => acc,
        Some(acc) if konst < 0.0 => bin(BinOp::Sub, acc, Expr::Num(-konst)),
        Some(acc) => bin(BinOp::Add, acc, Expr::Num(konst)),
    }
}

fn gather_sum(e: &Expr, sign: f64, konst: &mut f64, terms: &mut Vec<Term>) {
    match e {
        Expr::Num(n) => *konst += sign * n,
        Expr::Neg(a) => gather_sum(a, -sign, konst, terms),
        Expr::Bin { op: BinOp::Add, lhs, rhs } => {
            gather_sum(lhs, sign, konst, terms);
            gather_sum(rhs, sign, konst, terms);
        }
        Expr::Bin { op: BinOp::Sub, lhs, rhs } => {
            gather_sum(lhs, sign, konst, terms);
            gather_sum(rhs, -sign, konst, terms);
        }
        _ => {
            let (c, rest) = split_coeff(e);
            let coeff = sign * c;
            match terms.iter_mut().find(|t| t.rest == rest) {
                Some(t) => t.coeff += coeff,
                None => terms.push(Term { coeff, rest }),
            }
        }
    }
}

/// Split `2x` into `(2, x)` so that `2x + 3x` can become `5x`.
///
/// Only the leading literal counts. `x*2` never occurs in simplified output —
/// the product rebuild always puts the coefficient first — so there is no
/// second shape to look for.
fn split_coeff(e: &Expr) -> (f64, Expr) {
    match e {
        Expr::Bin { op: BinOp::Mul, lhs, rhs } => match **lhs {
            Expr::Num(n) => (n, (**rhs).clone()),
            _ => (1.0, e.clone()),
        },
        Expr::Neg(a) => {
            let (c, rest) = split_coeff(a);
            (-c, rest)
        }
        _ => (1.0, e.clone()),
    }
}

/// A rough polynomial degree, used only to order the terms of a sum.
fn degree(e: &Expr) -> f64 {
    match e {
        Expr::Num(_) | Expr::Hole => 0.0,
        Expr::Var(_) | Expr::Deriv { .. } => 1.0,
        // A call is one "unit" of complexity plus whatever it is applied to, so
        // `sin(x^2)` sorts after `sin(x)`.
        Expr::Call { args, .. } => 1.0 + args.iter().map(degree).fold(0.0, f64::max),
        Expr::Neg(a) => degree(a),
        Expr::List(items) => items.iter().map(degree).fold(0.0, f64::max),
        Expr::Bin { op, lhs, rhs } => match op {
            BinOp::Add | BinOp::Sub => degree(lhs).max(degree(rhs)),
            BinOp::Mul => degree(lhs) + degree(rhs),
            BinOp::Div => degree(lhs) - degree(rhs),
            BinOp::Pow => match **rhs {
                Expr::Num(n) => degree(lhs) * n,
                _ => degree(lhs) + 1.0,
            },
        },
    }
}

// ---- logarithms ---------------------------------------------------------

/// The largest coefficient a logarithm may carry into a merge.
///
/// `ln u + ln v -> ln(u v)` is exact in the reals, but `u v` can overflow to
/// infinity where `u` and `v` were both finite — the same class of
/// finite-precision compromise as `0 * u -> 0` differing at infinities, and
/// documented in the module header for the same reason. A coefficient of a
/// thousand turns that from a corner case into the normal case (`1000 ln 2` is
/// `ln(2^1000)`, which is `ln(inf)`), so the merge is limited to the
/// coefficients that actually make an expression shorter to read.
const MAX_LOG_COEFF: f64 = 8.0;

/// `ln u + ln v -> ln(u v)`, over a whole sum at once.
///
/// This is the direction that is unconditionally true, which is why it lives
/// here rather than in [`crate::equal`] with a condition attached: wherever the
/// input has a value at all, `ln u` and `ln v` are both defined, so `u` and `v`
/// are both positive and the product law holds with nothing left to assume.
/// Breaking `ln(u v)` back apart is *not* symmetric — `u` and `v` could both be
/// negative — so that direction lives in `expand` behind a positivity check and
/// in `equal` behind a stated condition.
///
/// A lone term is left alone: `2 ln(x)` is not more readable as `ln(x^2)`, and
/// a rewrite whose only effect is to move things around is noise.
fn merge_log_sums(e: &Expr) -> Expr {
    let mapped = map_children(e, merge_log_sums);
    if matches!(mapped, Expr::Bin { op: BinOp::Add | BinOp::Sub, .. } | Expr::Neg(_)) {
        if let Some(merged) = merged_logs(&mapped) {
            return merged;
        }
    }
    mapped
}

fn merged_logs(e: &Expr) -> Option<Expr> {
    let mut terms: Vec<(f64, Expr)> = Vec::new();
    additive_terms(e, 1.0, &mut terms);
    let is_mergeable_log = |c: &f64, rest: &Expr| {
        c.fract() == 0.0 && c.abs() <= MAX_LOG_COEFF && log_argument(rest).is_some()
    };
    if terms.iter().filter(|(c, r)| is_mergeable_log(c, r)).count() < 2 {
        return None;
    }

    let mut factors: Vec<(Expr, bool)> = Vec::new();
    let mut rest: Vec<(Expr, bool)> = Vec::new();
    for (c, term) in &terms {
        match log_argument(term) {
            Some(u) if is_mergeable_log(c, term) => {
                factors.push((bin(BinOp::Pow, u.clone(), Expr::Num(c.abs())), *c < 0.0));
            }
            _ => rest.push((scale(c.abs(), term), *c < 0.0)),
        }
    }
    rest.push((
        Expr::Call { name: "ln".into(), args: vec![product(&factors)] },
        false,
    ));
    Some(sum(&rest))
}

fn log_argument(e: &Expr) -> Option<&Expr> {
    match e {
        Expr::Call { name, args } if name == "ln" && args.len() == 1 => Some(&args[0]),
        _ => None,
    }
}

/// The addends of a sum, each as `(signed coefficient, remainder)`.
///
/// Separate from `gather_sum` because that one is folding into an accumulator
/// and this one needs the terms themselves; sharing it would mean one function
/// with two jobs and a flag.
pub(crate) fn additive_terms(e: &Expr, sign: f64, out: &mut Vec<(f64, Expr)>) {
    match e {
        Expr::Neg(a) => additive_terms(a, -sign, out),
        Expr::Bin { op: BinOp::Add, lhs, rhs } => {
            additive_terms(lhs, sign, out);
            additive_terms(rhs, sign, out);
        }
        Expr::Bin { op: BinOp::Sub, lhs, rhs } => {
            additive_terms(lhs, sign, out);
            additive_terms(rhs, -sign, out);
        }
        _ => {
            let (c, rest) = split_coeff(e);
            out.push((sign * c, rest));
        }
    }
}

/// Rebuild `e` with `f` applied to each of its immediate children.
///
/// Written once here because four of this crate's passes are "recurse, then
/// look at this node", and four hand-written copies of the same nine-arm match
/// is four places for a new [`Expr`] variant to be forgotten.
pub(crate) fn map_children(e: &Expr, f: impl Fn(&Expr) -> Expr) -> Expr {
    match e {
        Expr::Num(_) | Expr::Var(_) | Expr::Deriv { .. } | Expr::Hole => e.clone(),
        Expr::Neg(a) => Expr::Neg(Box::new(f(a))),
        Expr::List(items) => Expr::List(items.iter().map(f).collect()),
        Expr::Call { name, args } => Expr::Call {
            name: name.clone(),
            args: args.iter().map(f).collect(),
        },
        Expr::Bin { op, lhs, rhs } => Expr::Bin {
            op: *op,
            lhs: Box::new(f(lhs)),
            rhs: Box::new(f(rhs)),
        },
    }
}

/// Is this expression strictly positive for every value its names can take?
///
/// Deliberately narrow, and the omissions are the interesting part. `pi` is
/// *not* here: it is an ordinary `Var` that a document is free to bind, and a
/// rewrite that assumed otherwise would break in exactly the document that
/// wrote `pi = 3` as a joke. `u^2` is not here either — it is non-negative, not
/// positive, and `ln(0)` is the difference.
pub(crate) fn provably_positive(e: &Expr) -> bool {
    match e {
        Expr::Num(n) => *n > 0.0,
        Expr::Call { name, args } => match (name.as_str(), args.len()) {
            // `exp` is positive wherever it is a number at all, and `cosh` is
            // at least 1.
            ("exp", 1) | ("cosh", 1) => true,
            ("sqrt", 1) => provably_positive(&args[0]),
            _ => false,
        },
        Expr::Bin { op, lhs, rhs } => match op {
            BinOp::Add | BinOp::Mul | BinOp::Div => {
                provably_positive(lhs) && provably_positive(rhs)
            }
            BinOp::Pow => provably_positive(lhs),
            BinOp::Sub => false,
        },
        _ => false,
    }
}

// ---- products -----------------------------------------------------------

/// One factor, as a base raised to an exponent.
struct Factor {
    base: Expr,
    exp: Expr,
}

/// Flatten, collect and rebuild a product. Each input is `(expr, inverted)`.
///
/// The numeric part is accumulated as a numerator and a denominator rather than
/// as one `f64`, so `x/3` stays `x/3` instead of becoming
/// `0.3333333333333333x`, and `2/3*3` folds to `2` instead of to
/// `2.0000000000000004`.
fn product(parts: &[(Expr, bool)]) -> Expr {
    let mut num = 1.0f64;
    let mut den = 1.0f64;
    let mut factors: Vec<Factor> = Vec::new();
    for (e, inv) in parts {
        gather_product(e, *inv, &mut num, &mut den, &mut factors);
    }

    // A zero coefficient wins, but only when the denominator is not itself
    // zero: `0 * (1/0)` is NaN and must stay NaN.
    //
    // The zero returned is the folded coefficient itself, sign and all, not a
    // fresh `0.0`. `-mod(0, 0.5)` folds to `-0`, and a `-0` that silently
    // became `+0` would turn `u/-0` from `-inf` into `+inf` — a sign flip at
    // the one place it is visible. Found by the random-tree property test.
    if num == 0.0 && den != 0.0 {
        return Expr::Num(num);
    }
    if den < 0.0 {
        num = -num;
        den = -den;
    }
    // Divide out only where the quotient is exact — the division either comes
    // out whole (`4x/2` is `2x`) or the whole product is arithmetic and the
    // denominator is a power of two, which is the only other case a binary
    // float divides without loss (`3/4` is `0.75`). Everything else stays a
    // fraction, because `x/3` is a better answer than `0.3333333333333333x`
    // and is also the only *exact* one.
    //
    // The `factors.is_empty()` half of that is what keeps `n(n + 1)/2` from
    // coming back as `0.5n * (n + 1)`. Both are the same number; only one of
    // them is the formula somebody recognises, and a closed form nobody
    // recognises has lost most of its value.
    if den != 0.0
        && den != 1.0
        && (num % den == 0.0 || (is_power_of_two(den) && factors.is_empty()))
    {
        let q = num / den;
        if q * den == num {
            num = q;
            den = 1.0;
        }
    }

    factors.retain(|f| !matches!(f.exp, Expr::Num(n) if n == 0.0));
    factors.sort_by(|a, b| cmp_expr(&a.base, &b.base));

    // The coefficient seeds the chain rather than being wrapped around it, so
    // the product comes out `2x * cos(u)` — left-associated, coefficient first,
    // the way it would be typed — instead of `2(x * cos(u))`.
    let mut top: Option<Expr> = seed(num);
    let mut bottom: Option<Expr> = seed(den);
    for f in &factors {
        // A negative literal exponent is a division: `x^-2` reads as `1/x^2`,
        // and nobody writes the first form.
        let (target, e) = match f.exp {
            Expr::Num(n) if n < 0.0 => (&mut bottom, powered(&f.base, Expr::Num(-n))),
            _ => (&mut top, powered(&f.base, f.exp.clone())),
        };
        *target = Some(match target.take() {
            None => e,
            Some(acc) => bin(BinOp::Mul, acc, e),
        });
    }

    let numerator = match top {
        None => Expr::Num(num),
        // A coefficient of -1 is a sign, not a factor.
        Some(t) if num == -1.0 => neg(t),
        Some(t) => t,
    };
    match bottom {
        None => numerator,
        Some(b) => bin(BinOp::Div, numerator, b),
    }
}

/// The starting accumulator for a product chain: the coefficient itself, unless
/// it is `±1` and therefore carries no information.
fn seed(c: f64) -> Option<Expr> {
    if c == 1.0 || c == -1.0 {
        None
    } else {
        Some(Expr::Num(c))
    }
}

fn gather_product(e: &Expr, inv: bool, num: &mut f64, den: &mut f64, factors: &mut Vec<Factor>) {
    match e {
        Expr::Num(n) => {
            if inv {
                *den *= n;
            } else {
                *num *= n;
            }
        }
        Expr::Neg(a) => {
            *num = -*num;
            gather_product(a, inv, num, den, factors);
        }
        Expr::Bin { op: BinOp::Mul, lhs, rhs } => {
            gather_product(lhs, inv, num, den, factors);
            gather_product(rhs, inv, num, den, factors);
        }
        Expr::Bin { op: BinOp::Div, lhs, rhs } => {
            gather_product(lhs, inv, num, den, factors);
            gather_product(rhs, !inv, num, den, factors);
        }
        Expr::Bin { op: BinOp::Pow, lhs, rhs } => {
            // A literal base with an integer exponent is arithmetic, so fold it
            // into the coefficient: `2^3 * x` is `8x`.
            if let (Expr::Num(b), Expr::Num(p)) = (&**lhs, &**rhs) {
                if p.fract() == 0.0 && p.abs() < 1024.0 {
                    let v = b.powf(*p);
                    if v.is_finite() {
                        if inv {
                            *den *= v;
                        } else {
                            *num *= v;
                        }
                        return;
                    }
                }
            }
            let exp = if inv { negate_exponent(rhs) } else { (**rhs).clone() };
            push_factor((**lhs).clone(), exp, factors);
        }
        _ => {
            let exp = Expr::Num(if inv { -1.0 } else { 1.0 });
            push_factor(e.clone(), exp, factors);
        }
    }
}

/// Merge a factor into the bag, adding exponents when that is provably safe.
///
/// "Provably safe" means both exponents are integer literals: `x^2 * x^-1` is
/// `x` for every `x` that the input itself evaluates at, whereas
/// `x^0.5 * x^0.5` is NaN for negative `x` while `x` is not.
fn push_factor(base: Expr, exp: Expr, factors: &mut Vec<Factor>) {
    if let Some(f) = factors.iter_mut().find(|f| f.base == base) {
        if let (Expr::Num(a), Expr::Num(b)) = (&f.exp, &exp) {
            if a.fract() == 0.0 && b.fract() == 0.0 {
                f.exp = Expr::Num(a + b);
                return;
            }
        }
    }
    factors.push(Factor { base, exp });
}

/// Is this a power of two — i.e. can a float be divided by it exactly?
///
/// Read off the mantissa rather than through `log2`, which is a rounded
/// function and would answer this question about `2^49` incorrectly.
fn is_power_of_two(x: f64) -> bool {
    x.is_finite() && x > 0.0 && (x.to_bits() & 0x000F_FFFF_FFFF_FFFF) == 0
}

fn negate_exponent(e: &Expr) -> Expr {
    match e {
        Expr::Num(n) => Expr::Num(-n),
        _ => neg(e.clone()),
    }
}

// ---- powers, calls, and the small constructors --------------------------

fn power(base: Expr, exp: Expr) -> Expr {
    // `u^0` is 1 for *every* `u` under IEEE `powf`, including infinities and
    // NaN, so this one needs no domain caveat. Likewise `1^v`.
    if matches!(exp, Expr::Num(n) if n == 0.0) {
        return Expr::Num(1.0);
    }
    if matches!(exp, Expr::Num(n) if n == 1.0) {
        return base;
    }
    if matches!(base, Expr::Num(n) if n == 1.0) {
        return Expr::Num(1.0);
    }
    if let (Expr::Num(b), Expr::Num(p)) = (&base, &exp) {
        // Fold only what stays exact: an integer exponent is arithmetic, and a
        // root that lands on an integer (`4^0.5`) is worth folding too.
        // `2^0.5` is left alone for the same reason `sqrt(2)` is.
        let v = b.powf(*p);
        if v.is_finite() && (p.fract() == 0.0 || v.fract() == 0.0) {
            return Expr::Num(v);
        }
    }
    // `(a^b)^c` collapses only when both exponents are integer literals; see
    // the module docs for the `(x^2)^0.5` counterexample.
    if let Expr::Bin { op: BinOp::Pow, lhs, rhs } = &base {
        if let (Expr::Num(b), Expr::Num(c)) = (&**rhs, &exp) {
            if b.fract() == 0.0 && c.fract() == 0.0 {
                return power((**lhs).clone(), Expr::Num(b * c));
            }
        }
    }
    bin(BinOp::Pow, base, exp)
}

/// Fold a builtin applied to literals — but only where the answer is exact.
///
/// `abs(-3)`, `floor(2.7)`, `sqrt(4)` and `sin(0)` all have exact answers and
/// folding them is what a person means by "simplify". `sin(2)` does not, and
/// replacing it with a seventeen-digit decimal would destroy the only exact
/// form of that number the document can hold. The test is "the result is an
/// integer", which is the largest set of exactly-representable answers these
/// functions produce.
fn call(name: &str, args: Vec<Expr>) -> Expr {
    // `ln(exp u) -> u`, but never `exp(ln u) -> u`, and the asymmetry is real
    // rather than an oversight: `exp` is defined on every real and lands in
    // `ln`'s domain, so the first is an identity on the whole line, while the
    // second is false for every `u <= 0`. A CAS that applied both because they
    // "look like inverses" is one that turns `exp(ln(-2))` into `-2`.
    if name == "ln" && args.len() == 1 {
        if let Expr::Call { name: inner, args: inner_args } = &args[0] {
            if inner == "exp" && inner_args.len() == 1 {
                return inner_args[0].clone();
            }
        }
    }
    let literals: Option<Vec<f64>> = args
        .iter()
        .map(|a| match a {
            Expr::Num(n) => Some(*n),
            _ => None,
        })
        .collect();
    if let Some(vals) = literals {
        if let Some(v) = fold_builtin(name, &vals) {
            if v.is_finite() && v.fract() == 0.0 {
                return Expr::Num(v);
            }
            // A square root that comes out exactly, integer or not: `sqrt(0.25)`
            // is `0.5` and squares back to `0.25` with nothing lost. The test is
            // the round trip itself, which is the only one that cannot be fooled
            // by a decimal that merely looks tidy.
            if name == "sqrt" && v.is_finite() && v * v == vals[0] {
                return Expr::Num(v);
            }
        }
        if name == "sqrt" && args.len() == 1 {
            if let Some(extracted) = extract_square_factor(vals[0]) {
                return extracted;
            }
        }
    }
    Expr::Call { name: name.to_string(), args }
}

/// `sqrt(72) -> 6sqrt(2)`.
///
/// Exact, and only ever applied to a non-negative integer literal, so there is
/// no domain question to answer: the identity `sqrt(k^2 m) = k sqrt(m)` needs
/// `k >= 0`, and `k` here is a positive integer by construction. Worth doing
/// because it is what makes a quadratic's roots readable — `(2 + sqrt(8))/2`
/// is an answer nobody can see is `1 + sqrt(2)`.
fn extract_square_factor(x: f64) -> Option<Expr> {
    let n = crate::num::as_integer(x).filter(|n| *n > 1)?;
    let (outside, rest) = crate::num::square_factor(n);
    (outside > 1).then(|| {
        bin(
            BinOp::Mul,
            Expr::Num(outside as f64),
            Expr::Call { name: "sqrt".into(), args: vec![Expr::Num(rest as f64)] },
        )
    })
}

/// The same arithmetic `numpla_expr::eval` does, for the folding above.
///
/// Deliberately a separate, smaller table: the noise builtins and `rand` read
/// the document's seed, which a CAS pane does not have, so they are absent and
/// simply never fold.
fn fold_builtin(name: &str, a: &[f64]) -> Option<f64> {
    let x = *a.first()?;
    Some(match (name, a.len()) {
        ("sin", 1) => x.sin(),
        ("cos", 1) => x.cos(),
        ("tan", 1) => x.tan(),
        ("arcsin", 1) => x.asin(),
        ("arccos", 1) => x.acos(),
        ("arctan", 1) => x.atan(),
        ("sinh", 1) => x.sinh(),
        ("cosh", 1) => x.cosh(),
        ("tanh", 1) => x.tanh(),
        ("sqrt", 1) => x.sqrt(),
        ("exp", 1) => x.exp(),
        ("ln", 1) => x.ln(),
        ("log", 1) => x.log10(),
        ("log", 2) => a[1].log(x),
        ("abs", 1) => x.abs(),
        ("floor", 1) => x.floor(),
        ("ceil", 1) => x.ceil(),
        ("round", 1) => x.round(),
        ("sign", 1) => {
            if x == 0.0 {
                0.0
            } else {
                x.signum()
            }
        }
        ("min", 2) => x.min(a[1]),
        ("max", 2) => x.max(a[1]),
        ("mod", 2) => x.rem_euclid(a[1]),
        _ => return None,
    })
}

fn scale(c: f64, e: &Expr) -> Expr {
    if c == 1.0 {
        e.clone()
    } else if c == -1.0 {
        neg(e.clone())
    } else if let Expr::Num(n) = e {
        Expr::Num(c * n)
    } else {
        bin(BinOp::Mul, Expr::Num(c), e.clone())
    }
}

fn powered(base: &Expr, exp: Expr) -> Expr {
    if matches!(exp, Expr::Num(n) if n == 1.0) {
        base.clone()
    } else {
        bin(BinOp::Pow, base.clone(), exp)
    }
}

pub(crate) fn bin(op: BinOp, lhs: Expr, rhs: Expr) -> Expr {
    Expr::Bin { op, lhs: Box::new(lhs), rhs: Box::new(rhs) }
}

pub(crate) fn neg(e: Expr) -> Expr {
    match e {
        Expr::Num(n) => Expr::Num(-n),
        Expr::Neg(a) => *a,
        other => Expr::Neg(Box::new(other)),
    }
}

// ---- canonical order ----------------------------------------------------

/// A total order on expressions, so that a commutative bag has exactly one
/// spelling.
///
/// It sorts by *kind* first — numbers, then names, then calls, then compound
/// expressions — which is what makes `x * sin(x)` come out that way round and
/// not the other. Within a kind it compares structurally. The only requirement
/// on it is totality and determinism; the readable part of the ordering is
/// handled by `degree` in the sum rebuild.
pub(crate) fn cmp_expr(a: &Expr, b: &Expr) -> Ordering {
    let (ra, rb) = (rank(a), rank(b));
    if ra != rb {
        return ra.cmp(&rb);
    }
    match (a, b) {
        (Expr::Num(x), Expr::Num(y)) => x.partial_cmp(y).unwrap_or(Ordering::Equal),
        (Expr::Var(x), Expr::Var(y)) => x.cmp(y),
        (Expr::Deriv { name: n1, order: o1 }, Expr::Deriv { name: n2, order: o2 }) => {
            n1.cmp(n2).then(o1.cmp(o2))
        }
        (Expr::Call { name: n1, args: a1 }, Expr::Call { name: n2, args: a2 }) => {
            n1.cmp(n2).then_with(|| cmp_slice(a1, a2))
        }
        (Expr::Neg(x), Expr::Neg(y)) => cmp_expr(x, y),
        (Expr::List(x), Expr::List(y)) => cmp_slice(x, y),
        (
            Expr::Bin { op: o1, lhs: l1, rhs: r1 },
            Expr::Bin { op: o2, lhs: l2, rhs: r2 },
        ) => (*o1 as u8)
            .cmp(&(*o2 as u8))
            .then_with(|| cmp_expr(l1, l2))
            .then_with(|| cmp_expr(r1, r2)),
        _ => Ordering::Equal,
    }
}

fn cmp_slice(a: &[Expr], b: &[Expr]) -> Ordering {
    for (x, y) in a.iter().zip(b) {
        let c = cmp_expr(x, y);
        if c != Ordering::Equal {
            return c;
        }
    }
    a.len().cmp(&b.len())
}

fn rank(e: &Expr) -> u8 {
    match e {
        Expr::Num(_) => 0,
        Expr::Var(_) => 1,
        Expr::Deriv { .. } => 2,
        Expr::Call { .. } => 3,
        Expr::Bin { op: BinOp::Pow, .. } => 4,
        Expr::Bin { op: BinOp::Mul, .. } | Expr::Bin { op: BinOp::Div, .. } => 5,
        Expr::Bin { .. } => 6,
        Expr::Neg(_) => 7,
        Expr::List(_) => 8,
        Expr::Hole => 9,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::print::to_source;
    use numpla_expr::{parse, Stmt};

    fn s(src: &str) -> String {
        let tree = match parse(src).0 {
            Stmt::Expr(e) => e,
            other => panic!("not an expression: {:?}", other),
        };
        to_source(&simplify(&tree))
    }

    #[test]
    fn folds_arithmetic() {
        assert_eq!(s("2 + 3*4"), "14");
        assert_eq!(s("2^10"), "1024");
        assert_eq!(s("(1 + 2)/4"), "0.75");
    }

    #[test]
    fn identity_and_zero_laws() {
        assert_eq!(s("x + 0"), "x");
        assert_eq!(s("1 * x"), "x");
        assert_eq!(s("0 * x"), "0");
        assert_eq!(s("x/1"), "x");
        assert_eq!(s("x^1"), "x");
        assert_eq!(s("x^0"), "1");
        assert_eq!(s("x - x"), "0");
        assert_eq!(s("x/x"), "1");
    }

    #[test]
    fn collects_like_terms() {
        assert_eq!(s("2x + 3x"), "5x");
        assert_eq!(s("x + x"), "2x");
        assert_eq!(s("sin(x) + sin(x)"), "2sin(x)");
        assert_eq!(s("2x + 1 - x - 1"), "x");
        assert_eq!(s("x*x"), "x^2");
        assert_eq!(s("x^2 * x^3"), "x^5");
    }

    #[test]
    fn commutative_operands_get_one_spelling() {
        assert_eq!(s("y + x"), s("x + y"));
        assert_eq!(s("y*x"), s("x*y"));
        assert_eq!(s("1 + x^2 + x"), "x^2 + x + 1");
    }

    /// The rewrites this refuses, pinned so that nobody "improves" them later.
    /// Each line is a value that would change.
    #[test]
    fn refuses_the_rewrites_that_would_change_a_value() {
        assert_eq!(s("(x^2)^0.5"), "(x^2)^0.5");
        assert_eq!(s("x^0.5 * x^0.5"), "x^0.5 * x^0.5");
        assert_eq!(s("exp(ln(x))"), "exp(ln(x))");
        assert_eq!(s("sqrt(x)^2"), "sqrt(x)^2");
    }

    #[test]
    fn folds_a_builtin_only_when_the_answer_is_exact() {
        assert_eq!(s("sqrt(4)"), "2");
        assert_eq!(s("abs(-3)"), "3");
        assert_eq!(s("floor(2.7)"), "2");
        assert_eq!(s("cos(0)"), "1");
        // Irrational: the exact form is the one worth keeping.
        assert_eq!(s("sqrt(2)"), "sqrt(2)");
        assert_eq!(s("sin(2)"), "sin(2)");
    }

    #[test]
    fn a_rational_coefficient_stays_a_fraction() {
        assert_eq!(s("x/3"), "x/3");
        assert_eq!(s("2/3 * 3"), "2");
        assert_eq!(s("4x/2"), "2x");
    }

    #[test]
    fn negation_survives_the_product_path() {
        assert_eq!(s("-x"), "-x");
        assert_eq!(s("-(-x)"), "x");
        assert_eq!(s("-2 * -3"), "6");
        assert_eq!(s("-x * y"), "-(x * y)");
    }
}
