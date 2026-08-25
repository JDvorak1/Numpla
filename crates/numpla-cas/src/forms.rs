//! `equal(e)` — every way of writing an expression that this CAS can find.
//!
//! Not one canonical answer: a *list*, for a person to choose from. `simplify`
//! decides for you and is often right; `equal` shows the alternatives and lets
//! you be right instead. `equal(1^(1/2))` offers `1` and `sqrt(1)`, because
//! which of those is the useful form depends on what you are doing next, and
//! the CAS does not know that.
//!
//! # The rule that keeps the list worth reading
//!
//! **Every candidate equals the input.** A list with something unequal in it is
//! worse than no list: the whole value of a choice list is that you can pick
//! without checking, and one wrong entry destroys that for every entry.
//!
//! Some identities are only true on part of the domain — `sqrt(u)^2 = u`,
//! `ln(e^u) = u`, `(u^a)^b = u^(ab)` — and those are not silently dropped and
//! not silently offered. They come back as [`FormKind::Conditional`] carrying a
//! machine-checkable [`Condition`], which the UI renders next to the form and
//! `tests/value_preserving.rs` evaluates: a conditional candidate is checked at
//! every sample point where its condition holds, and it must be equal at all of
//! them.
//!
//! # Where candidates come from
//!
//! - `simplify`, `expand` and `factor` — the existing rewrites are candidates
//!   too, which is what the user asked for in as many words.
//! - Radical and exponent notation, in both directions.
//! - The logarithm laws, in both directions, each with its condition where it
//!   has one.
//! - The exponent laws that hold for real numbers rather than only for positive
//!   ones — integer exponents, and positive literal bases.
//! - Trigonometric identities: Pythagorean, double angle, angle addition,
//!   sum-to-product, and the hyperbolic definitions.
//! - Rationalising a denominator, putting a sum over a common denominator, and
//!   partial fractions where the denominator's roots are rational.
//! - The numeric value, and — when the expression is a number — every closed
//!   form that matches it (see [`crate::identify`]), tagged as an
//!   identification rather than as an identity.
//!
//! Each rule is tried at every node, so `ln(x*y) + 1` gets the same candidates
//! `ln(x*y)` does, rebuilt in place.

use numpla_expr::{BinOp, Env, Expr};

use crate::identify::{agreeing_digits, identify};
use crate::num::{as_integer, const_value, rational_expr};
use crate::simplify::{additive_terms, bin, neg, provably_positive, simplify};

/// The most candidates that will be collected before the list is trimmed. A
/// choice list nobody can scan is not a choice.
const MAX_FORMS: usize = 32;

/// A side condition on a rewrite, in a form a test can evaluate.
///
/// A sentence would be enough for the UI and is not enough for the property
/// test, and the property test is what makes the sentence true.
#[derive(Debug, Clone, PartialEq)]
pub enum Guard {
    Positive(Expr),
    NonNegative(Expr),
    NonZero(Expr),
}

impl Guard {
    fn holds(&self, env: &Env) -> bool {
        let value = |e: &Expr| match numpla_expr::eval(e, env) {
            Ok(numpla_expr::Value::Scalar(x)) if x.is_finite() => Some(x),
            _ => None,
        };
        match self {
            Guard::Positive(e) => value(e).is_some_and(|v| v > 0.0),
            Guard::NonNegative(e) => value(e).is_some_and(|v| v >= 0.0),
            // A strict margin, not `!= 0`: a rewrite that divides by `u - v` is
            // useless where that is 1e-18, and a test that sampled there would
            // be testing floating point rather than algebra.
            Guard::NonZero(e) => value(e).is_some_and(|v| v.abs() > 1e-6),
        }
    }

    fn describe(&self) -> String {
        let src = crate::to_source(self.expr());
        match self {
            Guard::Positive(_) => format!("{} > 0", src),
            Guard::NonNegative(_) => format!("{} >= 0", src),
            Guard::NonZero(_) => format!("{} != 0", src),
        }
    }

    fn expr(&self) -> &Expr {
        match self {
            Guard::Positive(e) | Guard::NonNegative(e) | Guard::NonZero(e) => e,
        }
    }
}

/// Everything that has to be true for a candidate to equal the input.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Condition {
    pub guards: Vec<Guard>,
}

impl Condition {
    /// Does the condition hold at this point? Unknown counts as no, which is
    /// the direction that never lets an unchecked candidate through.
    pub fn holds(&self, env: &Env) -> bool {
        self.guards.iter().all(|g| g.holds(env))
    }

    /// The condition as a sentence: "x > 0 and y > 0".
    pub fn describe(&self) -> String {
        self.guards
            .iter()
            .map(Guard::describe)
            .collect::<Vec<_>>()
            .join(" and ")
    }
}

/// What kind of claim a candidate is making. The UI must be able to tell these
/// apart, which is why it is an enum and not a sentence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormKind {
    /// Equal to the input wherever the input has a value at all.
    Exact,
    /// Equal where its [`Condition`] holds, and carrying that condition.
    Conditional,
    /// The floating-point value. An approximation, and says so.
    Decimal,
    /// A closed form that *matches the number* to near machine precision. Not
    /// proved. See [`crate::identify`].
    Identification,
}

impl FormKind {
    /// The wire spelling. Fixed here so the shell and the tests agree.
    pub fn as_str(self) -> &'static str {
        match self {
            FormKind::Exact => "exact",
            FormKind::Conditional => "conditional",
            FormKind::Decimal => "decimal",
            FormKind::Identification => "identification",
        }
    }
}

/// One way of writing the input.
#[derive(Debug, Clone, PartialEq)]
pub struct Form {
    pub expr: Expr,
    /// How it was obtained — "simplify", "log of a product", "double angle".
    pub label: String,
    pub kind: FormKind,
    pub condition: Option<Condition>,
    /// A sentence for the cases where the label is not the whole story: what an
    /// identification agreed to, mostly.
    pub note: Option<String>,
}

/// Every equivalent form of `e` this CAS can find.
pub fn equal(e: &Expr) -> Vec<Form> {
    let mut out: Vec<Form> = Vec::new();
    let reduced = simplify(e);

    push(&mut out, Form { expr: reduced.clone(), label: "simplify".into(), kind: FormKind::Exact, condition: None, note: None });
    push(&mut out, Form { expr: crate::expand(e), label: "expand".into(), kind: FormKind::Exact, condition: None, note: None });
    push(&mut out, Form { expr: crate::factor(e), label: "factor".into(), kind: FormKind::Exact, condition: None, note: None });

    // Both the input as typed and its simplified form are used as seeds: a rule
    // that matches `1^(1/2)` and a rule that matches `1` are both worth having,
    // and neither seed alone finds both.
    let mut rewritten = Vec::new();
    collect(e, &mut rewritten);
    if reduced != *e {
        collect(&reduced, &mut rewritten);
    }
    for r in rewritten {
        let condition = (!r.guards.is_empty()).then_some(Condition { guards: r.guards });
        push(
            &mut out,
            Form {
                expr: r.expr,
                label: r.label.to_string(),
                kind: if condition.is_some() { FormKind::Conditional } else { FormKind::Exact },
                condition,
                note: None,
            },
        );
    }

    if let Some(v) = const_value(&reduced) {
        push(&mut out, Form {
            expr: Expr::Num(v),
            label: "the value, to machine precision".into(),
            kind: FormKind::Decimal,
            condition: None,
            note: None,
        });
        for found in identify(v) {
            let digits = agreeing_digits(found.relative_error);
            push(&mut out, Form {
                expr: found.expr,
                label: "recognised from the number".into(),
                kind: FormKind::Identification,
                condition: None,
                note: Some(format!(
                    "{} — agrees with {} to {} significant digits. This is a numeric match, not a proof.",
                    found.name, v, digits
                )),
            });
        }
    }

    // The input as typed is not one of "the other ways to write it".
    let original = crate::to_source(e);
    out.retain(|f| crate::to_source(&f.expr) != original);
    out.truncate(MAX_FORMS);
    out
}

fn push(out: &mut Vec<Form>, form: Form) {
    if out.len() >= MAX_FORMS {
        return;
    }
    let src = crate::to_source(&form.expr);
    // A second route to the same text is not a second option. The first label
    // wins, and the order candidates are generated in is therefore the order of
    // preference: simplify, expand, factor, then the structural rules.
    if out.iter().any(|f| crate::to_source(&f.expr) == src) {
        return;
    }
    out.push(form);
}

// ---- walking the tree ----------------------------------------------------

struct Rewrite {
    expr: Expr,
    label: &'static str,
    guards: Vec<Guard>,
}

fn rw(expr: Expr, label: &'static str) -> Rewrite {
    Rewrite { expr, label, guards: Vec::new() }
}

fn guarded(expr: Expr, label: &'static str, guards: Vec<Guard>) -> Rewrite {
    Rewrite { expr, label, guards }
}

/// A rewrite whose result is assembled rather than written: a common
/// denominator, a partial fraction, a rationalised quotient.
///
/// These are the ones where the raw tree is correct and unreadable —
/// `1 * sqrt(2)/2`, `(-1/2)/(x + 1)` — so they go through `simplify` before
/// being offered. The rules that are *about* a particular spelling do not:
/// simplifying `x^(1/2)` back to `x^0.5` would throw away the candidate.
fn rw_tidied(expr: Expr, label: &'static str) -> Rewrite {
    rw(simplify(&expr), label)
}

/// Every rewrite of `e`, at every node, as a whole-tree candidate.
fn collect(e: &Expr, out: &mut Vec<Rewrite>) {
    if out.len() >= MAX_FORMS * 2 {
        return;
    }
    out.extend(rewrites_at(e));
    let kids = children(e);
    for (i, kid) in kids.iter().enumerate() {
        let mut inner = Vec::new();
        collect(kid, &mut inner);
        for r in inner {
            out.push(Rewrite {
                expr: with_child(e, i, r.expr),
                label: r.label,
                guards: r.guards,
            });
        }
    }
}

fn children(e: &Expr) -> Vec<&Expr> {
    match e {
        Expr::Num(_) | Expr::Var(_) | Expr::Deriv { .. } | Expr::Hole => Vec::new(),
        Expr::Neg(a) => vec![a],
        Expr::Bin { lhs, rhs, .. } => vec![lhs, rhs],
        Expr::Call { args, .. } => args.iter().collect(),
        Expr::List(items) => items.iter().collect(),
    }
}

fn with_child(e: &Expr, i: usize, child: Expr) -> Expr {
    let replace = |args: &Vec<Expr>| {
        let mut args = args.clone();
        args[i] = child.clone();
        args
    };
    match e {
        Expr::Neg(_) => Expr::Neg(Box::new(child)),
        Expr::Bin { op, lhs, rhs } => {
            let (l, r) = if i == 0 {
                (child, (**rhs).clone())
            } else {
                ((**lhs).clone(), child)
            };
            Expr::Bin { op: *op, lhs: Box::new(l), rhs: Box::new(r) }
        }
        Expr::Call { name, args } => Expr::Call { name: name.clone(), args: replace(args) },
        Expr::List(items) => Expr::List(replace(items)),
        _ => e.clone(),
    }
}

// ---- the rules -----------------------------------------------------------

fn rewrites_at(e: &Expr) -> Vec<Rewrite> {
    let mut out = Vec::new();
    radicals(e, &mut out);
    logarithms(e, &mut out);
    exponents(e, &mut out);
    trigonometry(e, &mut out);
    fractions(e, &mut out);
    sums(e, &mut out);
    out
}

fn call1(name: &str, u: Expr) -> Expr {
    Expr::Call { name: name.to_string(), args: vec![u] }
}

fn unary<'a>(e: &'a Expr, name: &str) -> Option<&'a Expr> {
    match e {
        Expr::Call { name: n, args } if n == name && args.len() == 1 => Some(&args[0]),
        _ => None,
    }
}

fn squared(e: &Expr) -> Option<&Expr> {
    match e {
        Expr::Bin { op: BinOp::Pow, lhs, rhs } if matches!(**rhs, Expr::Num(n) if n == 2.0) => {
            Some(lhs)
        }
        _ => None,
    }
}

// -- radicals and exponents --

fn radicals(e: &Expr, out: &mut Vec<Rewrite>) {
    if let Some(u) = unary(e, "sqrt") {
        out.push(rw(
            bin(BinOp::Pow, u.clone(), rational_expr(1, 2)),
            "a square root as an exponent",
        ));
        // `sqrt(u^2)` is `abs(u)` for *every* real `u`, which is exactly why
        // this is offered and `sqrt(u^2) = u` is not.
        if let Some(inner) = squared(u) {
            out.push(rw(call1("abs", inner.clone()), "a square root of a square is an absolute value"));
            out.push(guarded(
                inner.clone(),
                "a square root of a square, if the inside is not negative",
                vec![Guard::NonNegative(inner.clone())],
            ));
        }
    }
    if let Expr::Bin { op: BinOp::Pow, lhs, rhs } = e {
        if const_value(rhs) == Some(0.5) {
            out.push(rw(call1("sqrt", (**lhs).clone()), "a half power as a square root"));
        }
        // `sqrt(u)^2 = u` only where `u >= 0`; outside that the left side is
        // not a number and the right side is.
        if matches!(**rhs, Expr::Num(n) if n == 2.0) {
            if let Some(u) = unary(lhs, "sqrt") {
                out.push(guarded(
                    u.clone(),
                    "the square of a square root",
                    vec![Guard::NonNegative(u.clone())],
                ));
            }
        }
    }
}

fn exponents(e: &Expr, out: &mut Vec<Rewrite>) {
    let Expr::Bin { op, lhs, rhs } = e else {
        // `exp(u) exp(v)` is the combining direction, handled at the product.
        if let Some(Expr::Bin { op: op @ (BinOp::Add | BinOp::Sub), lhs, rhs }) = unary(e, "exp")
        {
            out.push(rw(
                bin(
                    if *op == BinOp::Add { BinOp::Mul } else { BinOp::Div },
                    call1("exp", (**lhs).clone()),
                    call1("exp", (**rhs).clone()),
                ),
                "exp of a sum",
            ));
        }
        return;
    };
    match op {
        BinOp::Pow => {
            let integer = |x: &Expr| const_value(x).and_then(as_integer);
            // `(u v)^n = u^n v^n` and `(u^m)^n = u^(m n)` hold for every real
            // `u` when the exponents are integers, and only for positive `u`
            // otherwise. Both versions are offered; only one of them is exact.
            if let Some(n) = integer(rhs) {
                if let Expr::Bin { op: BinOp::Mul, lhs: a, rhs: b } = &**lhs {
                    out.push(rw(
                        bin(
                            BinOp::Mul,
                            bin(BinOp::Pow, (**a).clone(), Expr::Num(n as f64)),
                            bin(BinOp::Pow, (**b).clone(), Expr::Num(n as f64)),
                        ),
                        "an integer power of a product",
                    ));
                }
            }
            if let Expr::Bin { op: BinOp::Pow, lhs: base, rhs: inner } = &**lhs {
                let combined = bin(
                    BinOp::Pow,
                    (**base).clone(),
                    simplify(&bin(BinOp::Mul, (**inner).clone(), (**rhs).clone())),
                );
                match (integer(inner), integer(rhs)) {
                    (Some(_), Some(_)) => out.push(rw(combined, "a power of a power")),
                    _ => out.push(guarded(
                        combined,
                        "a power of a power, for a non-negative base",
                        vec![Guard::Positive((**base).clone())],
                    )),
                }
            }
            // `b^u = exp(u ln b)`, for a positive numeric base. Restricted to a
            // literal on purpose: `e` is an ordinary name that a document may
            // bind, and a rewrite that assumed otherwise would be wrong in
            // exactly the document that did.
            if matches!(**lhs, Expr::Num(b) if b > 0.0 && b != 1.0) {
                out.push(rw(
                    call1("exp", bin(BinOp::Mul, (**rhs).clone(), call1("ln", (**lhs).clone()))),
                    "a power as an exponential",
                ));
            }
        }
        BinOp::Mul => {
            if let (Some(u), Some(v)) = (unary(lhs, "exp"), unary(rhs, "exp")) {
                out.push(rw(
                    call1("exp", bin(BinOp::Add, u.clone(), v.clone())),
                    "a product of exponentials",
                ));
            }
            // `u^n v^n = (u v)^n`, integer `n`, which is the direction that
            // makes an expression shorter.
            if let (
                Expr::Bin { op: BinOp::Pow, lhs: a, rhs: m },
                Expr::Bin { op: BinOp::Pow, lhs: b, rhs: n },
            ) = (&**lhs, &**rhs)
            {
                if m == n && const_value(m).and_then(as_integer).is_some() {
                    out.push(rw(
                        bin(
                            BinOp::Pow,
                            bin(BinOp::Mul, (**a).clone(), (**b).clone()),
                            (**m).clone(),
                        ),
                        "equal integer powers of two factors",
                    ));
                }
            }
        }
        _ => {}
    }
}

// -- logarithms --

fn logarithms(e: &Expr, out: &mut Vec<Rewrite>) {
    if let Some(u) = unary(e, "ln") {
        match u {
            Expr::Bin { op: op @ (BinOp::Mul | BinOp::Div), lhs, rhs } => {
                let split = bin(
                    if *op == BinOp::Mul { BinOp::Add } else { BinOp::Sub },
                    call1("ln", (**lhs).clone()),
                    call1("ln", (**rhs).clone()),
                );
                let label = if *op == BinOp::Mul {
                    "the log of a product"
                } else {
                    "the log of a quotient"
                };
                if provably_positive(lhs) && provably_positive(rhs) {
                    out.push(rw(split, label));
                } else {
                    out.push(guarded(
                        split,
                        label,
                        vec![
                            Guard::Positive((**lhs).clone()),
                            Guard::Positive((**rhs).clone()),
                        ],
                    ));
                }
            }
            Expr::Bin { op: BinOp::Pow, lhs, rhs } => {
                let split = bin(BinOp::Mul, (**rhs).clone(), call1("ln", (**lhs).clone()));
                let odd = const_value(rhs).and_then(as_integer).is_some_and(|n| n % 2 != 0);
                if odd || provably_positive(lhs) {
                    // For an odd power the input is only a number where the
                    // base is positive anyway, so there is no condition left
                    // to state.
                    out.push(rw(split, "the log of a power"));
                } else {
                    out.push(guarded(
                        split,
                        "the log of a power",
                        vec![Guard::Positive((**lhs).clone())],
                    ));
                }
            }
            _ => {}
        }
        if let Some(inner) = unary(u, "exp") {
            out.push(rw(inner.clone(), "the log of an exponential"));
        }
    }
    // `exp(ln u) = u` only for `u > 0`; it is the direction that is *not* an
    // identity, and the crate refuses to apply it silently anywhere.
    if let Some(u) = unary(e, "exp") {
        if let Some(inner) = unary(u, "ln") {
            out.push(guarded(
                inner.clone(),
                "the exponential of a log",
                vec![Guard::Positive(inner.clone())],
            ));
        }
    }
    // `log(u)` and `log(b, u)` in terms of the natural log, and back.
    if let Expr::Call { name, args } = e {
        if name == "log" {
            let base = match args.len() {
                1 => Some(Expr::Num(10.0)),
                2 => Some(args[0].clone()),
                _ => None,
            };
            let arg = args.last().cloned();
            if let (Some(base), Some(arg)) = (base, arg) {
                out.push(rw(
                    bin(BinOp::Div, call1("ln", arg), call1("ln", base)),
                    "a logarithm in terms of ln",
                ));
            }
        }
    }
    if let Expr::Bin { op: BinOp::Div, lhs, rhs } = e {
        if let (Some(u), Some(b)) = (unary(lhs, "ln"), unary(rhs, "ln")) {
            out.push(rw(
                Expr::Call { name: "log".into(), args: vec![b.clone(), u.clone()] },
                "a ratio of logs as a logarithm",
            ));
        }
    }
}

// -- trigonometry --

fn trigonometry(e: &Expr, out: &mut Vec<Rewrite>) {
    if let Expr::Call { name, args } = e {
        if args.len() == 1 {
            let u = &args[0];
            match name.as_str() {
                "sin" | "cos" => {
                    if let Some(half) = halved(u) {
                        double_angle(name, &half, out);
                    }
                    if let Expr::Bin { op: BinOp::Add, lhs, rhs } = u {
                        angle_sum(name, lhs, rhs, out);
                    }
                }
                "tan" => out.push(rw(
                    bin(BinOp::Div, call1("sin", u.clone()), call1("cos", u.clone())),
                    "tan as a ratio",
                )),
                "tanh" => out.push(rw(
                    bin(BinOp::Div, call1("sinh", u.clone()), call1("cosh", u.clone())),
                    "tanh as a ratio",
                )),
                "sinh" | "cosh" => {
                    let op = if name == "sinh" { BinOp::Sub } else { BinOp::Add };
                    out.push(rw(
                        bin(
                            BinOp::Div,
                            bin(op, call1("exp", u.clone()), call1("exp", neg(u.clone()))),
                            Expr::Num(2.0),
                        ),
                        "the hyperbolic function written out",
                    ));
                }
                _ => {}
            }
        }
    }
    if let Expr::Bin { op: BinOp::Div, lhs, rhs } = e {
        if let (Some(a), Some(b)) = (unary(lhs, "sin"), unary(rhs, "cos")) {
            if a == b {
                out.push(rw(call1("tan", a.clone()), "a ratio as tan"));
            }
        }
        if let (Some(a), Some(b)) = (unary(lhs, "sinh"), unary(rhs, "cosh")) {
            if a == b {
                out.push(rw(call1("tanh", a.clone()), "a ratio as tanh"));
            }
        }
    }
}

/// `u/2` for an argument written as `2u` or `u + u`, so a double angle can be
/// recognised however it was typed.
fn halved(u: &Expr) -> Option<Expr> {
    match u {
        Expr::Bin { op: BinOp::Mul, lhs, rhs } => match (&**lhs, &**rhs) {
            (Expr::Num(n), other) | (other, Expr::Num(n)) if *n == 2.0 => Some(other.clone()),
            _ => None,
        },
        Expr::Bin { op: BinOp::Add, lhs, rhs } if lhs == rhs => Some((**lhs).clone()),
        _ => None,
    }
}

fn double_angle(name: &str, u: &Expr, out: &mut Vec<Rewrite>) {
    let (s, c) = (call1("sin", u.clone()), call1("cos", u.clone()));
    let sq = |x: Expr| bin(BinOp::Pow, x, Expr::Num(2.0));
    if name == "sin" {
        out.push(rw(
            bin(BinOp::Mul, bin(BinOp::Mul, Expr::Num(2.0), s), c),
            "the double angle for sin",
        ));
        return;
    }
    out.push(rw(
        bin(BinOp::Sub, sq(c.clone()), sq(s.clone())),
        "the double angle for cos",
    ));
    out.push(rw(
        bin(BinOp::Sub, Expr::Num(1.0), bin(BinOp::Mul, Expr::Num(2.0), sq(s))),
        "the double angle for cos, in sin alone",
    ));
    out.push(rw(
        bin(BinOp::Sub, bin(BinOp::Mul, Expr::Num(2.0), sq(c)), Expr::Num(1.0)),
        "the double angle for cos, in cos alone",
    ));
}

fn angle_sum(name: &str, a: &Expr, b: &Expr, out: &mut Vec<Rewrite>) {
    let (sa, ca) = (call1("sin", a.clone()), call1("cos", a.clone()));
    let (sb, cb) = (call1("sin", b.clone()), call1("cos", b.clone()));
    let expanded = if name == "sin" {
        bin(
            BinOp::Add,
            bin(BinOp::Mul, sa, cb),
            bin(BinOp::Mul, ca, sb),
        )
    } else {
        bin(
            BinOp::Sub,
            bin(BinOp::Mul, ca, cb),
            bin(BinOp::Mul, sa, sb),
        )
    };
    out.push(rw(expanded, "the angle addition formula"));
}

// -- fractions --

fn fractions(e: &Expr, out: &mut Vec<Rewrite>) {
    let Expr::Bin { op: BinOp::Div, lhs, rhs } = e else {
        return;
    };
    // `c/sqrt(u) = c sqrt(u)/u`. Wherever the input is a number, `u > 0`, so
    // there is nothing to assume.
    if let Some(u) = unary(rhs, "sqrt") {
        out.push(rw_tidied(
            bin(
                BinOp::Div,
                bin(BinOp::Mul, (**lhs).clone(), call1("sqrt", u.clone())),
                u.clone(),
            ),
            "rationalising the denominator",
        ));
    }
    // `c/(sqrt(a) + sqrt(b))`, by the conjugate. This one *does* need a
    // condition: the conjugate introduces `a - b` in the denominator, which the
    // original did not have.
    if let Expr::Bin { op: op @ (BinOp::Add | BinOp::Sub), lhs: l, rhs: r } = &**rhs {
        if let (Some(a), Some(b)) = (unary(l, "sqrt"), unary(r, "sqrt")) {
            let conjugate = bin(
                if *op == BinOp::Add { BinOp::Sub } else { BinOp::Add },
                call1("sqrt", a.clone()),
                call1("sqrt", b.clone()),
            );
            let difference = bin(BinOp::Sub, a.clone(), b.clone());
            out.push(guarded(
                simplify(&bin(
                    BinOp::Div,
                    bin(BinOp::Mul, (**lhs).clone(), conjugate),
                    difference.clone(),
                )),
                "rationalising by the conjugate",
                vec![Guard::NonZero(simplify(&difference))],
            ));
        }
    }
    if let Some(pf) = partial_fractions(lhs, rhs) {
        out.push(rw_tidied(pf, "partial fractions"));
    }
}

/// `p(x)/q(x)` as a sum of `A/(x - r)`, when every root of `q` is rational and
/// simple.
///
/// The residue formula `A_i = p(r_i)/q'(r_i)` needs nothing but the roots and
/// one derivative, which is what "where it is cheap" means: no linear system,
/// no undetermined coefficients. Repeated roots need a different formula and
/// are left alone rather than approximated.
fn partial_fractions(num: &Expr, den: &Expr) -> Option<Expr> {
    let names = crate::factor::free_names(den);
    let [var] = names.as_slice() else { return None };
    if num.deps().contains(var) && crate::poly::Poly::from_expr(num, var).is_none() {
        return None;
    }
    let p = crate::poly::Poly::from_expr(num, var)?;
    let q = crate::poly::Poly::from_expr(den, var)?;
    if q.degree() < 2 || p.degree() >= q.degree() {
        return None;
    }
    let (roots, rest) = crate::poly::rational_roots(&crate::poly::integer_form(&q.numeric()?)?)?;
    if rest.len() != 1 || roots.len() != q.degree() {
        return None;
    }
    let mut distinct = roots.clone();
    distinct.sort_unstable();
    distinct.dedup();
    if distinct.len() != roots.len() {
        return None;
    }

    let dq = crate::diff(den, var).ok()?;
    let mut out: Option<Expr> = None;
    for (n, d) in &distinct {
        let r = rational_expr(*n, *d);
        let top = const_value(&simplify(&crate::subs(num, var, &r)))?;
        let bottom = const_value(&simplify(&crate::subs(&dq, var, &r)))?;
        let residue = top / bottom;
        // Only when the residue is a fraction worth printing: a decimal residue
        // is a sign that the roots were not as exact as they looked.
        let (rp, rq) = crate::num::rationalize(residue, 10_000)?;
        let term = bin(
            BinOp::Div,
            rational_expr(rp, rq),
            simplify(&bin(BinOp::Sub, Expr::Var(var.clone()), r)),
        );
        out = Some(match out {
            None => term,
            Some(acc) => bin(BinOp::Add, acc, term),
        });
    }
    out
}

// -- sums: the identities that need more than one term --

fn sums(e: &Expr, out: &mut Vec<Rewrite>) {
    if !matches!(e, Expr::Bin { op: BinOp::Add | BinOp::Sub, .. }) {
        return;
    }
    let mut terms: Vec<(f64, Expr)> = Vec::new();
    additive_terms(e, 1.0, &mut terms);
    if terms.len() > 6 {
        return;
    }
    pythagorean(&terms, out);
    common_denominator(&terms, out);
    if terms.len() == 2 {
        sum_to_product(&terms, out);
    }
    combine_logs(&terms, out);
}

/// Rebuild a sum from `(coefficient, term)` pairs, with the signs where a
/// person would write them.
fn rebuild(terms: &[(f64, Expr)]) -> Expr {
    let mut out: Option<Expr> = None;
    for (c, rest) in terms {
        if *c == 0.0 {
            continue;
        }
        let m = c.abs();
        let magnitude = match rest {
            _ if m == 1.0 => rest.clone(),
            Expr::Num(n) => Expr::Num(m * n),
            _ => bin(BinOp::Mul, Expr::Num(m), rest.clone()),
        };
        out = Some(match out {
            None if *c < 0.0 => neg(magnitude),
            None => magnitude,
            Some(acc) => bin(
                if *c < 0.0 { BinOp::Sub } else { BinOp::Add },
                acc,
                magnitude,
            ),
        });
    }
    out.unwrap_or(Expr::Num(0.0))
}

/// Swap two terms for one, leaving the rest of the sum where it was.
fn replace_pair(terms: &[(f64, Expr)], i: usize, j: usize, with: (f64, Expr)) -> Expr {
    let mut rest: Vec<(f64, Expr)> = terms
        .iter()
        .enumerate()
        .filter(|(k, _)| *k != i && *k != j)
        .map(|(_, t)| t.clone())
        .collect();
    rest.insert(0, with);
    rebuild(&rest)
}

fn pythagorean(terms: &[(f64, Expr)], out: &mut Vec<Rewrite>) {
    let squared_call = |t: &Expr, name: &str| squared(t).and_then(|inner| unary(inner, name)).cloned();
    for i in 0..terms.len() {
        for j in 0..terms.len() {
            if i == j {
                continue;
            }
            let (ci, cj) = (terms[i].0, terms[j].0);
            let (a, b) = (&terms[i].1, &terms[j].1);
            // sin^2 + cos^2 = 1
            if ci == 1.0 && cj == 1.0 {
                if let (Some(u), Some(v)) = (squared_call(a, "sin"), squared_call(b, "cos")) {
                    if u == v {
                        out.push(rw(
                            replace_pair(terms, i, j, (1.0, Expr::Num(1.0))),
                            "the Pythagorean identity",
                        ));
                    }
                }
            }
            // cosh^2 - sinh^2 = 1
            if ci == 1.0 && cj == -1.0 {
                if let (Some(u), Some(v)) = (squared_call(a, "cosh"), squared_call(b, "sinh")) {
                    if u == v {
                        out.push(rw(
                            replace_pair(terms, i, j, (1.0, Expr::Num(1.0))),
                            "the hyperbolic Pythagorean identity",
                        ));
                    }
                }
            }
            // 1 - sin^2 = cos^2, and the other way round
            if ci == 1.0 && cj == -1.0 && matches!(a, Expr::Num(n) if *n == 1.0) {
                for (from, to) in [("sin", "cos"), ("cos", "sin")] {
                    if let Some(u) = squared_call(b, from) {
                        out.push(rw(
                            replace_pair(
                                terms,
                                i,
                                j,
                                (1.0, bin(BinOp::Pow, call1(to, u), Expr::Num(2.0))),
                            ),
                            "one minus a square, by the Pythagorean identity",
                        ));
                    }
                }
            }
        }
    }
}

fn sum_to_product(terms: &[(f64, Expr)], out: &mut Vec<Rewrite>) {
    let [(c1, t1), (c2, t2)] = terms else { return };
    if c1.abs() != 1.0 || c2.abs() != 1.0 {
        return;
    }
    let half = |x: Expr| bin(BinOp::Div, x, Expr::Num(2.0));
    for name in ["sin", "cos"] {
        let (Some(a), Some(b)) = (unary(t1, name), unary(t2, name)) else {
            continue;
        };
        // Orient so the first term is the positive one; `sin a - sin b` and
        // `-sin b + sin a` are the same sum and must give the same identity.
        let (a, b, negated) = if *c1 > 0.0 { (a, b, *c2 < 0.0) } else { (b, a, true) };
        let sum = half(bin(BinOp::Add, a.clone(), b.clone()));
        let difference = half(bin(BinOp::Sub, a.clone(), b.clone()));
        // `-sin a - sin b` is the negative of the identity, not the identity,
        // and the sign rides in the leading coefficient so the printer can put
        // it where a person writes it: `-2sin(u) * sin(v)`.
        let sign = if *c1 < 0.0 && *c2 < 0.0 { -2.0 } else { 2.0 };
        let scaled = |k: f64, x: Expr, y: Expr| {
            bin(BinOp::Mul, bin(BinOp::Mul, Expr::Num(k), x), y)
        };
        let product = match (name, negated) {
            ("sin", false) => scaled(sign, call1("sin", sum), call1("cos", difference)),
            ("sin", true) => scaled(sign, call1("cos", sum), call1("sin", difference)),
            ("cos", false) => scaled(sign, call1("cos", sum), call1("cos", difference)),
            _ => scaled(-sign, call1("sin", sum), call1("sin", difference)),
        };
        out.push(rw(product, "sum to product"));
    }
}

/// `ln u + ln v = ln(u v)` as an offered form.
///
/// `simplify` already does this, so the candidate is usually a duplicate and is
/// dropped — but not when the sum has other terms in it that stop `simplify`
/// from reaching the same shape, which is exactly when it is worth offering.
fn combine_logs(terms: &[(f64, Expr)], out: &mut Vec<Rewrite>) {
    for i in 0..terms.len() {
        for j in (i + 1)..terms.len() {
            let (Some(u), Some(v)) = (unary(&terms[i].1, "ln"), unary(&terms[j].1, "ln")) else {
                continue;
            };
            if terms[i].0.abs() != 1.0 || terms[j].0.abs() != 1.0 {
                continue;
            }
            let same_sign = terms[i].0 * terms[j].0 > 0.0;
            let combined = call1(
                "ln",
                bin(
                    if same_sign { BinOp::Mul } else { BinOp::Div },
                    if terms[i].0 > 0.0 { u.clone() } else { v.clone() },
                    if terms[i].0 > 0.0 { v.clone() } else { u.clone() },
                ),
            );
            let sign = if terms[i].0 > 0.0 { 1.0 } else { -1.0 };
            out.push(rw(
                replace_pair(terms, i, j, (sign, combined)),
                "a sum of logs as one log",
            ));
        }
    }
}

/// `a/b + c/d = (a d + c b)/(b d)`.
fn common_denominator(terms: &[(f64, Expr)], out: &mut Vec<Rewrite>) {
    let parts: Vec<(Expr, Expr)> = terms.iter().map(|(c, t)| split_fraction(*c, t)).collect();
    if parts.iter().filter(|(_, d)| !matches!(d, Expr::Num(n) if *n == 1.0)).count() < 2 {
        return;
    }
    let denominator = parts
        .iter()
        .map(|(_, d)| d.clone())
        .reduce(|a, b| if a == b { a } else { bin(BinOp::Mul, a, b) })
        .unwrap_or(Expr::Num(1.0));
    let mut numerator: Option<Expr> = None;
    for (n, d) in &parts {
        let scaled = simplify(&bin(
            BinOp::Mul,
            n.clone(),
            bin(BinOp::Div, denominator.clone(), d.clone()),
        ));
        numerator = Some(match numerator {
            None => scaled,
            Some(acc) => bin(BinOp::Add, acc, scaled),
        });
    }
    if let Some(n) = numerator {
        out.push(rw_tidied(
            bin(BinOp::Div, n, denominator),
            "over a common denominator",
        ));
    }
}

fn split_fraction(coeff: f64, e: &Expr) -> (Expr, Expr) {
    let scale = |x: &Expr| {
        if coeff == 1.0 {
            x.clone()
        } else {
            simplify(&bin(BinOp::Mul, Expr::Num(coeff), x.clone()))
        }
    };
    match e {
        Expr::Bin { op: BinOp::Div, lhs, rhs } => (scale(lhs), (**rhs).clone()),
        _ => (scale(e), Expr::Num(1.0)),
    }
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

    fn forms(src: &str) -> Vec<String> {
        equal(&tree(src)).iter().map(|f| to_source(&f.expr)).collect()
    }

    fn labelled(src: &str) -> Vec<(String, String, &'static str)> {
        equal(&tree(src))
            .iter()
            .map(|f| (to_source(&f.expr), f.label.clone(), f.kind.as_str()))
            .collect()
    }

    /// The example from the spec, word for word.
    #[test]
    fn one_to_the_half_offers_both_forms() {
        let got = forms("1^(1/2)");
        assert!(got.contains(&"1".to_string()), "{:?}", got);
        assert!(got.contains(&"sqrt(1)".to_string()), "{:?}", got);
    }

    #[test]
    fn radicals_go_both_ways() {
        assert!(forms("sqrt(x)").contains(&"x^(1/2)".to_string()));
        assert!(forms("x^(1/2)").contains(&"sqrt(x)".to_string()));
        assert!(forms("sqrt(x^2)").contains(&"abs(x)".to_string()));
    }

    #[test]
    fn the_log_laws_in_both_directions() {
        assert!(forms("ln(x*y)").contains(&"ln(x) + ln(y)".to_string()));
        assert!(forms("ln(x) + ln(y) + z").contains(&"ln(x * y) + z".to_string()));
        assert!(forms("log(2, x)").contains(&"ln(x)/ln(2)".to_string()));
        assert!(forms("ln(x)/ln(2)").contains(&"log(2, x)".to_string()));
    }

    /// The conditional ones carry their condition, in a form the UI can show
    /// and a test can evaluate.
    #[test]
    fn a_conditional_form_says_what_it_assumes() {
        let split = equal(&tree("ln(x*y)"))
            .into_iter()
            .find(|f| to_source(&f.expr) == "ln(x) + ln(y)")
            .expect("the product law is offered");
        assert_eq!(split.kind, FormKind::Conditional);
        assert_eq!(split.condition.unwrap().describe(), "x > 0 and y > 0");
    }

    /// ...and where the condition is provable, it is not stated, because a
    /// condition that is always true is noise.
    #[test]
    fn a_provable_condition_is_not_stated() {
        let split = equal(&tree("ln(exp(a) * exp(b))"))
            .into_iter()
            .find(|f| to_source(&f.expr) == "ln(exp(a)) + ln(exp(b))")
            .expect("the product law is offered");
        assert_eq!(split.kind, FormKind::Exact);
    }

    #[test]
    fn trigonometry() {
        assert!(forms("sin(2x)").contains(&"2sin(x) * cos(x)".to_string()));
        assert!(forms("cos(2x)").contains(&"cos(x)^2 - sin(x)^2".to_string()));
        assert!(forms("sin(x + y)").contains(&"sin(x) * cos(y) + cos(x) * sin(y)".to_string()));
        assert!(forms("sin(x)^2 + cos(x)^2").contains(&"1".to_string()));
        assert!(forms("sin(a) + sin(b)").contains(&"2sin((a + b)/2) * cos((a - b)/2)".to_string()));
        assert!(forms("tan(x)").contains(&"sin(x)/cos(x)".to_string()));
    }

    #[test]
    fn fractions() {
        assert!(forms("1/sqrt(2)").contains(&"sqrt(2)/2".to_string()));
        assert!(forms("1/x + 1/y").contains(&"(x + y)/(x * y)".to_string()));
        assert!(forms("1/(x^2 - 1)").contains(&"-0.5/(x + 1) + 0.5/(x - 1)".to_string()));
    }

    /// An identification is labelled as one. The distinction between "this is
    /// equal" and "this matches the number" is the whole reason the kind field
    /// exists.
    #[test]
    fn a_recognised_number_is_labelled_as_recognised() {
        // The number rather than the closed form: `equal` never offers back the
        // expression it was given, so asking about `pi^2/6` would hide the one
        // answer this test is about.
        let got = labelled("1.6449340668482264");
        assert_eq!(
            got.iter().find(|(_, _, kind)| *kind == "identification").map(|(e, ..)| e.as_str()),
            Some("pi^2/6"),
            "{:?}",
            got
        );
        // The decimal is offered for anything that has a value - except a
        // decimal, where it would be the input written out again.
        assert!(
            labelled("sqrt(2)").iter().any(|(_, _, kind)| *kind == "decimal"),
            "{:?}",
            labelled("sqrt(2)")
        );
    }

    #[test]
    fn the_input_itself_is_not_one_of_the_alternatives() {
        assert!(!forms("2x + 3x").contains(&"2x + 3x".to_string()));
        assert!(forms("2x + 3x").contains(&"5x".to_string()));
    }
}
