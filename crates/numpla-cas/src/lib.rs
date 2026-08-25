//! A small computer algebra system: simplify, differentiate, expand,
//! substitute, evaluate.
//!
//! # The rule that makes it trustworthy
//!
//! **Every rewrite preserves value.** A simplifier that is merely plausible is
//! worse than none, because the person reading the answer cannot tell when it
//! lied — and unlike a wrong plot, a wrong algebraic identity gets copied into
//! the next document. So the crate is built around a property test rather than
//! around a rule list: `tests/value_preserving.rs` evaluates every input and
//! every output at many pseudo-random points and fails on any disagreement, and
//! it checks each symbolic derivative against a high-order numerical one. Rules
//! that could not survive that test are absent, and each absence is written
//! down where it would otherwise be added back (see [`simplify`] and [`diff`]).
//!
//! Everything returned is **Numpla source that parses**: [`to_source`] is part
//! of the contract, not a debugging aid, because an answer you cannot paste
//! back into your document is not an answer.
//!
//! # Scope
//!
//! In:
//!
//! - [`simplify`] — arithmetic folding, identity and zero laws, like terms,
//!   canonical ordering of commutative operands, exact radicals, and the
//!   logarithm laws in the combining direction.
//! - [`diff`] — sum, product, quotient, chain and power rules, and every
//!   builtin `numpla-expr` can evaluate.
//! - [`expand`] — products over sums, small integer powers of sums, and the
//!   logarithm laws in the splitting direction where they hold unconditionally.
//! - [`factor`] — over the rationals, completely for one variable.
//! - [`solve`] — one equation, one unknown. Polynomials through their rational
//!   roots, quadratics and biquadratics in closed form, and anything the
//!   unknown occurs once in, by inverting the operations around it. Everything
//!   else is refused by name; the list is in [`solve`]'s own docs.
//! - [`sum`] and [`product`] — closed forms for the shapes that have one, the
//!   series itself over numeric limits, and a refusal otherwise.
//! - [`equal`] — every equivalent form the crate can find, as a list to choose
//!   from, each labelled and each carrying its condition if it has one.
//! - [`identify`] — inverse symbolic lookup: a number back to a closed form,
//!   labelled as a numeric match rather than as a proof.
//! - [`subs`] and [`value`] — substitution and numeric evaluation.
//!
//! Out, deliberately, and not half-done:
//!
//! - **Symbolic integration.** There is no algorithm short of Risch that gives
//!   an honest answer, and a table lookup that silently fails on `exp(-x^2)` is
//!   the kind of tool that teaches people not to trust the tool.
//! - **The cubic and quartic formulas.** [`solve`] finds every *rational* root
//!   of any polynomial and finishes a quadratic or biquadratic remainder. It
//!   will not print Cardano: nested radicals nobody can check are not an
//!   answer, and in the casus irreducibilis they are a real root written as a
//!   sum of complex numbers.
//! - **Complex numbers.** `numpla-expr` evaluates over `f64`, so `x^2 = -1` has
//!   no solutions here and the refusal says which field it means.
//! - **Limits and series expansions.** Both need an ordering on growth rates
//!   that this representation does not have. (`sum` and `product` are finite;
//!   an infinite series is not offered.)
//! - **Matrices.** `numpla-linalg` is where linear algebra lives; a second,
//!   symbolic notion of a matrix here would be a fork of it.
//!
//! Asking for any of them is not a failure mode this crate has: either there is
//! no function to call, or the refusal names itself. That is the honest form of
//! "out of scope".
//!
//! # One assumption, stated once
//!
//! `pi`, `tau` and `e` are read as the constants `numpla-expr` gives them. They
//! are ordinary names that a document is free to bind to something else, and if
//! one does, the algebra here is answering a question about a different
//! expression than the document is. The alternative — refusing to fold `sqrt(2)`
//! in case somebody rebound `e` — would make the CAS useless to everyone in
//! order to be right about nobody. The one place this rule is *not* taken is
//! inside [`simplify`], where a rewrite happens without being asked for: there,
//! only literals count as positive.
//!
//! # Depends only on `numpla-expr`
//!
//! No external crates, and none of the rest of the workspace. The CAS reads and
//! writes the same [`Expr`] every other crate walks, so nothing here can drift
//! away from the language the document is actually written in.

pub mod diff;
pub mod expand;
pub mod factor;
pub mod forms;
pub mod identify;
pub mod num;
pub mod poly;
pub mod print;
pub mod series;
pub mod simplify;
pub mod solve;

use std::collections::HashMap;
use std::fmt;

use numpla_expr::{Env, EvalError, Expr, Value};

pub use diff::{diff, diff_with_steps};
pub use expand::{expand, expand_with_steps};
pub use factor::factor;
pub use forms::{equal, Condition, Form, FormKind, Guard};
pub use identify::{identify, Identified};
pub use print::to_source;
pub use series::{product, sum, Closed};
pub use simplify::simplify;
pub use solve::{check_root, solve, unknowns, RootCheck, Solutions};

/// Why a CAS call could not answer.
///
/// There are only two kinds, and the split matters to the UI: `Incomplete` is
/// the gray-not-red state the whole product is built around — a half-typed
/// expression is *pending*, not wrong — while `Unsupported` is a considered
/// refusal that names itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CasError {
    /// The expression still has a hole in it. Nothing is wrong yet.
    Incomplete,
    /// A rewrite this CAS will not guess at, and the sentence saying which.
    Unsupported(String),
}

impl fmt::Display for CasError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CasError::Incomplete => write!(f, "the expression is not finished yet"),
            CasError::Unsupported(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for CasError {}

/// Replace every occurrence of `var` with `value`, then simplify.
///
/// Substitution is textual on the tree and needs no scope analysis, because the
/// language has no binding forms: a name means the same thing everywhere in an
/// expression. The one name it deliberately does *not* touch is a primed one —
/// substituting into `x'` would change which function the derivative is of.
pub fn subs(e: &Expr, var: &str, value: &Expr) -> Expr {
    simplify(&replace(e, var, value))
}

fn replace(e: &Expr, var: &str, value: &Expr) -> Expr {
    match e {
        Expr::Var(name) if name == var => value.clone(),
        Expr::Num(_) | Expr::Var(_) | Expr::Deriv { .. } | Expr::Hole => e.clone(),
        Expr::Neg(a) => Expr::Neg(Box::new(replace(a, var, value))),
        Expr::List(items) => Expr::List(items.iter().map(|i| replace(i, var, value)).collect()),
        Expr::Call { name, args } => Expr::Call {
            name: name.clone(),
            args: args.iter().map(|a| replace(a, var, value)).collect(),
        },
        Expr::Bin { op, lhs, rhs } => Expr::Bin {
            op: *op,
            lhs: Box::new(replace(lhs, var, value)),
            rhs: Box::new(replace(rhs, var, value)),
        },
    }
}

/// Simplify, then evaluate numerically against `env`.
///
/// Simplifying first is not an optimisation: it is what lets `x - x` come back
/// as `0` in a document where `x` has no value yet, and what stops `0 * k`
/// reporting `k` as undefined. Evaluation itself is `numpla_expr::eval` — the
/// *same* evaluator the solver runs — so a number from the compute pane and a
/// number from a plot can never disagree.
pub fn value(e: &Expr, env: &Env) -> Result<Value, EvalError> {
    numpla_expr::eval(&simplify(e), env)
}

/// Inline calls to the document's own functions.
///
/// The CAS has no notion of a function definition: `diff(f(x), x)` can only be
/// answered by something that knows what `f` is. Rather than teach the CAS
/// about documents, the caller inlines first — `f(u) = u^2` turns `f(x)` into
/// `x^2` — and everything downstream sees only builtins. That keeps `numpla-cas`
/// dependent on the expression language alone, which is the property that stops
/// it drifting from the language documents are written in.
///
/// Substitution is safe without renaming because the language has no binders
/// beyond the parameter list itself, so a body's free names are exactly the
/// document's globals.
///
/// `depth` bounds mutual recursion: a document may define `f` in terms of `g`
/// and `g` in terms of `f`, and the CAS's answer to that is to stop unfolding
/// rather than to hang.
pub fn inline_user_functions(e: &Expr, funcs: &HashMap<String, (Vec<String>, Expr)>) -> Expr {
    inline(e, funcs, 16)
}

fn inline(e: &Expr, funcs: &HashMap<String, (Vec<String>, Expr)>, depth: usize) -> Expr {
    match e {
        Expr::Num(_) | Expr::Var(_) | Expr::Deriv { .. } | Expr::Hole => e.clone(),
        Expr::Neg(a) => Expr::Neg(Box::new(inline(a, funcs, depth))),
        Expr::List(items) => Expr::List(items.iter().map(|i| inline(i, funcs, depth)).collect()),
        Expr::Bin { op, lhs, rhs } => Expr::Bin {
            op: *op,
            lhs: Box::new(inline(lhs, funcs, depth)),
            rhs: Box::new(inline(rhs, funcs, depth)),
        },
        Expr::Call { name, args } => {
            let args: Vec<Expr> = args.iter().map(|a| inline(a, funcs, depth)).collect();
            if depth > 0 {
                if let Some((params, body)) = funcs.get(name) {
                    if params.len() == args.len() {
                        let mut body = body.clone();
                        for (p, a) in params.iter().zip(&args) {
                            body = replace(&body, p, a);
                        }
                        return inline(&body, funcs, depth - 1);
                    }
                }
            }
            Expr::Call { name: name.clone(), args }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use numpla_expr::{parse, Stmt};

    fn tree(src: &str) -> Expr {
        match parse(src).0 {
            Stmt::Expr(e) => e,
            other => panic!("not an expression: {:?}", other),
        }
    }

    #[test]
    fn substitution_folds_what_it_can() {
        assert_eq!(to_source(&subs(&tree("x^2 + 1"), "x", &tree("3"))), "10");
        assert_eq!(
            to_source(&subs(&tree("x^2 + 1"), "x", &tree("y + 1"))),
            "(y + 1)^2 + 1"
        );
    }

    #[test]
    fn evaluation_simplifies_first() {
        let env = Env::new();
        // `x` has no value, but the expression does not need one.
        assert_eq!(value(&tree("x - x"), &env), Ok(Value::Scalar(0.0)));
        assert_eq!(value(&tree("2 + 3"), &env), Ok(Value::Scalar(5.0)));
        assert!(value(&tree("x + 1"), &env).is_err());
    }

    #[test]
    fn user_functions_inline_before_anything_else_sees_them() {
        let mut funcs = HashMap::new();
        funcs.insert("f".to_string(), (vec!["u".to_string()], tree("u^2 + 1")));
        let called = Expr::Call { name: "f".into(), args: vec![tree("x")] };
        let inlined = inline_user_functions(&called, &funcs);
        assert_eq!(to_source(&simplify(&inlined)), "x^2 + 1");
        assert_eq!(to_source(&diff(&inlined, "x").unwrap()), "2x");
    }

    /// A definition that calls itself unfolds a bounded number of times and
    /// then stops, rather than hanging the tab.
    #[test]
    fn recursive_definitions_stop_rather_than_hang() {
        let mut funcs = HashMap::new();
        funcs.insert(
            "f".to_string(),
            (vec!["u".to_string()], Expr::Call { name: "f".into(), args: vec![tree("u")] }),
        );
        let called = Expr::Call { name: "f".into(), args: vec![tree("x")] };
        assert_eq!(to_source(&inline_user_functions(&called, &funcs)), "f(x)");
    }

    #[test]
    fn an_unfinished_expression_is_pending_not_wrong() {
        let (stmt, _) = parse("1 +");
        let e = match stmt {
            Stmt::Expr(e) => e,
            other => panic!("{:?}", other),
        };
        assert_eq!(diff(&e, "x"), Err(CasError::Incomplete));
    }
}
