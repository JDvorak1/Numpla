//! Symbolic differentiation.
//!
//! # What "with respect to `x`" means here
//!
//! Every other name is a constant. `diff(k*x, "x")` is `k`, not `k + x*dk/dx`,
//! because a Numpla document is a list of *independent* rows and a name that is
//! not `x` is a slider, a parameter, or another variable — never a hidden
//! function of `x`. This is the same convention Maple and Mathematica use, and
//! it is stated here because it is a choice rather than a fact.
//!
//! # What this refuses, and why refusing beats guessing
//!
//! - **A primed name.** `x'` already means "the derivative with respect to the
//!   document's independent variable", and the compute pane has no document, so
//!   `diff(x', "x")` has no answer that is not a guess about what `x'` is a
//!   derivative *of*. It is refused rather than treated as an opaque symbol,
//!   because the plausible answer (`0`, or `x''`) is wrong exactly when it
//!   matters.
//! - **A noise source.** `smooth(t)` is a lattice sample, not a differentiable
//!   function of `t`, and `white(t)` is not even continuous. There is no
//!   derivative to return.
//! - **A user function with no definition in scope.** `f(x)` differentiates
//!   only once `f` has been inlined (see [`crate::inline_user_functions`]); a
//!   call to a name nothing defines is refused rather than treated as constant.
//! - **`mod(u, v)` where `v` depends on the variable.** `mod` is
//!   `rem_euclid`, whose derivative with respect to its second argument is a
//!   step function of both; a constant modulus is the case with an honest
//!   answer, and it is the only one taken.
//!
//! # The two derivatives that are only correct almost everywhere
//!
//! `abs`, `sign`, `floor`, `ceil`, `round`, `min` and `max` are differentiated
//! at the points where they *are* differentiable — `abs` gives `sign(u)u'`, the
//! step functions give `0`, and `min`/`max` come from the identity
//! `max(u,v) = (u + v + |u - v|)/2`. At a corner or a jump there is no
//! derivative to be right about, and returning the almost-everywhere answer is
//! what every CAS does. It is written down here so nobody has to guess whether
//! it was considered.

use numpla_expr::{BinOp, Expr};

use crate::simplify::{bin, neg, simplify};
use crate::CasError;

/// The symbolic derivative of `e` with respect to `var`, simplified.
pub fn diff(e: &Expr, var: &str) -> Result<Expr, CasError> {
    Ok(diff_with_steps(e, var)?.1)
}

/// The derivative twice: as the rules produced it, and simplified.
///
/// The compute pane shows both, because they answer different questions.
/// `1 * cos(x) + 0` says *which rule fired where*; `cos(x)` says what the answer
/// is. Somebody checking their own working needs the first, and a step that was
/// reconstructed for display rather than actually taken would be a lie about
/// what the software did — so this returns the real intermediate, not a
/// narration of one.
pub fn diff_with_steps(e: &Expr, var: &str) -> Result<(Expr, Expr), CasError> {
    let raw = raw_diff(e, var)?;
    let done = simplify(&raw);
    Ok((raw, done))
}

/// The derivative before simplification — the literal output of the rules.
///
/// Exposed within the crate so the compute pane can show it as a step: seeing
/// `1 * cos(x) + 0` collapse to `cos(x)` is how someone checks that the chain
/// rule was applied where they thought it was.
///
/// The hole check happens once, here, rather than at every node: a half-typed
/// expression has no derivative, and the constant-folding gate below would
/// otherwise answer `0` for `1 +` — confidently, and wrongly.
pub(crate) fn raw_diff(e: &Expr, var: &str) -> Result<Expr, CasError> {
    if e.has_hole() {
        return Err(CasError::Incomplete);
    }
    rule(e, var)
}

fn rule(e: &Expr, var: &str) -> Result<Expr, CasError> {
    // Anything that does not mention the variable is a constant, whatever it
    // is. This is not an optimisation: it is what makes `rand(3)`, `pi` and a
    // parameter differentiate to zero without a case each, and it is why a
    // noise term is only ever refused when it actually depends on `var`.
    if !mentions(e, var) {
        return Ok(Expr::Num(0.0));
    }

    match e {
        Expr::Num(_) => Ok(Expr::Num(0.0)),
        Expr::Var(name) => Ok(Expr::Num(if name == var { 1.0 } else { 0.0 })),
        Expr::Hole => Err(CasError::Incomplete),
        Expr::Deriv { name, order } => Err(CasError::Unsupported(format!(
            "{}{} is a derivative with respect to the document's independent variable, so the compute pane cannot differentiate it again",
            name,
            "'".repeat(*order as usize)
        ))),
        Expr::Neg(a) => Ok(neg(rule(a, var)?)),
        Expr::List(items) => Ok(Expr::List(
            items
                .iter()
                .map(|i| rule(i, var))
                .collect::<Result<_, _>>()?,
        )),
        Expr::Bin { op, lhs, rhs } => binary(*op, lhs, rhs, var),
        Expr::Call { name, args } => call(name, args, var),
    }
}

fn binary(op: BinOp, lhs: &Expr, rhs: &Expr, var: &str) -> Result<Expr, CasError> {
    let (u, v) = (lhs.clone(), rhs.clone());
    match op {
        BinOp::Add => Ok(bin(BinOp::Add, rule(lhs, var)?, rule(rhs, var)?)),
        BinOp::Sub => Ok(bin(BinOp::Sub, rule(lhs, var)?, rule(rhs, var)?)),
        // (uv)' = u'v + uv'
        BinOp::Mul => {
            let (du, dv) = (rule(lhs, var)?, rule(rhs, var)?);
            Ok(bin(
                BinOp::Add,
                bin(BinOp::Mul, du, v.clone()),
                bin(BinOp::Mul, u, dv),
            ))
        }
        // (u/v)' = (u'v - uv')/v^2
        BinOp::Div => {
            let (du, dv) = (rule(lhs, var)?, rule(rhs, var)?);
            Ok(bin(
                BinOp::Div,
                bin(
                    BinOp::Sub,
                    bin(BinOp::Mul, du, v.clone()),
                    bin(BinOp::Mul, u, dv),
                ),
                bin(BinOp::Pow, v, Expr::Num(2.0)),
            ))
        }
        BinOp::Pow => power(lhs, rhs, var),
    }
}

/// `u^v`, in the three cases that need different formulas.
///
/// The general case goes through `u^v = exp(v ln u)`, which is the only way to
/// get `x^x` right — and it is *real-domain* correct, meaning it holds where
/// `u > 0` and returns NaN elsewhere rather than returning something wrong.
/// The constant-exponent case is special-cased ahead of it precisely so that
/// the everyday `x^2` never acquires a spurious `ln x` and its domain
/// restriction.
fn power(base: &Expr, exp: &Expr, var: &str) -> Result<Expr, CasError> {
    let base_moves = mentions(base, var);
    let exp_moves = mentions(exp, var);

    if base_moves && !exp_moves {
        // v u^(v-1) u'
        let du = rule(base, var)?;
        let reduced = bin(BinOp::Sub, exp.clone(), Expr::Num(1.0));
        return Ok(bin(
            BinOp::Mul,
            bin(
                BinOp::Mul,
                exp.clone(),
                bin(BinOp::Pow, base.clone(), reduced),
            ),
            du,
        ));
    }
    if !base_moves && exp_moves {
        // u^v ln(u) v'
        let dv = rule(exp, var)?;
        return Ok(bin(
            BinOp::Mul,
            bin(
                BinOp::Mul,
                bin(BinOp::Pow, base.clone(), exp.clone()),
                call1("ln", base.clone()),
            ),
            dv,
        ));
    }
    // u^v (v' ln u + v u'/u)
    let du = rule(base, var)?;
    let dv = rule(exp, var)?;
    Ok(bin(
        BinOp::Mul,
        bin(BinOp::Pow, base.clone(), exp.clone()),
        bin(
            BinOp::Add,
            bin(BinOp::Mul, dv, call1("ln", base.clone())),
            bin(
                BinOp::Div,
                bin(BinOp::Mul, exp.clone(), du),
                base.clone(),
            ),
        ),
    ))
}

/// Chain rule over the builtins.
///
/// Every function `numpla-expr` can evaluate is answered here — with a
/// derivative, or with a refusal that says why. A builtin that quietly fell
/// through to "constant" would be the worst possible outcome, so the fallthrough
/// is an error.
fn call(name: &str, args: &[Expr], var: &str) -> Result<Expr, CasError> {
    // Two-argument builtins first: their shapes do not fit the chain-rule
    // template.
    match (name, args.len()) {
        ("log", 2) => return log_base(&args[0], &args[1], var),
        ("min", 2) | ("max", 2) => return extremum(name, &args[0], &args[1], var),
        ("mod", 2) => {
            if mentions(&args[1], var) {
                return Err(CasError::Unsupported(
                    "mod(u, v) with v depending on the variable has no derivative this CAS will guess at".into(),
                ));
            }
            // mod(u, c) = u - c floor(u/c): away from the jumps its slope is
            // just u'.
            return rule(&args[0], var);
        }
        _ => {}
    }

    if args.len() != 1 {
        return Err(CasError::Unsupported(format!(
            "no derivative rule for {} with {} arguments",
            name,
            args.len()
        )));
    }
    let u = &args[0];
    let du = rule(u, var)?;
    let outer = match name {
        "sin" => call1("cos", u.clone()),
        "cos" => neg(call1("sin", u.clone())),
        // sec(u)^2, written with the functions this language has.
        "tan" => reciprocal(bin(BinOp::Pow, call1("cos", u.clone()), Expr::Num(2.0))),
        "arcsin" => reciprocal(call1("sqrt", one_minus_square(u))),
        "arccos" => neg(reciprocal(call1("sqrt", one_minus_square(u)))),
        "arctan" => reciprocal(bin(
            BinOp::Add,
            Expr::Num(1.0),
            bin(BinOp::Pow, u.clone(), Expr::Num(2.0)),
        )),
        "sinh" => call1("cosh", u.clone()),
        "cosh" => call1("sinh", u.clone()),
        // 1/cosh^2 rather than 1 - tanh^2: the same function, but the second
        // form loses every significant digit to cancellation for |u| > 10.
        "tanh" => reciprocal(bin(BinOp::Pow, call1("cosh", u.clone()), Expr::Num(2.0))),
        "sqrt" => reciprocal(bin(
            BinOp::Mul,
            Expr::Num(2.0),
            call1("sqrt", u.clone()),
        )),
        "exp" => call1("exp", u.clone()),
        "ln" => reciprocal(u.clone()),
        // `log(u)` with one argument is base 10; d/du = 1/(u ln 10).
        "log" => reciprocal(bin(
            BinOp::Mul,
            u.clone(),
            call1("ln", Expr::Num(10.0)),
        )),
        "abs" => call1("sign", u.clone()),
        // Constant except where they jump, and where they jump there is no
        // derivative to report. See the module docs.
        "sign" | "floor" | "ceil" | "round" => Expr::Num(0.0),
        _ if is_noise(name) => {
            return Err(CasError::Unsupported(format!(
                "{} is a noise sample, not a differentiable function",
                name
            )))
        }
        _ => {
            return Err(CasError::Unsupported(format!(
                "no derivative rule for {}; if it is a function you defined, it has to be in scope to be differentiated",
                name
            )))
        }
    };
    Ok(bin(BinOp::Mul, outer, du))
}

/// `log(b, u)` is `ln(u)/ln(b)` — note the *base first*, which is how
/// `numpla_expr::eval` reads it. Both arguments may move, so this is the
/// quotient rule rather than a scaled `1/u`.
fn log_base(b: &Expr, u: &Expr, var: &str) -> Result<Expr, CasError> {
    let ratio = bin(
        BinOp::Div,
        call1("ln", u.clone()),
        call1("ln", b.clone()),
    );
    rule(&ratio, var)
}

/// `max(u,v) = (u + v + |u - v|)/2` and `min` is the same with the sign
/// flipped, so both derivatives fall out of rules already written. Correct
/// wherever `u != v`, which is everywhere the function is differentiable.
fn extremum(name: &str, u: &Expr, v: &Expr, var: &str) -> Result<Expr, CasError> {
    let (du, dv) = (rule(u, var)?, rule(v, var)?);
    let gap = call1("sign", bin(BinOp::Sub, u.clone(), v.clone()));
    let swing = bin(BinOp::Mul, gap, bin(BinOp::Sub, du.clone(), dv.clone()));
    let sum = bin(BinOp::Add, du, dv);
    let combined = if name == "max" {
        bin(BinOp::Add, sum, swing)
    } else {
        bin(BinOp::Sub, sum, swing)
    };
    Ok(bin(BinOp::Div, combined, Expr::Num(2.0)))
}

fn one_minus_square(u: &Expr) -> Expr {
    bin(
        BinOp::Sub,
        Expr::Num(1.0),
        bin(BinOp::Pow, u.clone(), Expr::Num(2.0)),
    )
}

fn reciprocal(e: Expr) -> Expr {
    bin(BinOp::Div, Expr::Num(1.0), e)
}

fn call1(name: &str, arg: Expr) -> Expr {
    Expr::Call { name: name.to_string(), args: vec![arg] }
}

fn is_noise(name: &str) -> bool {
    matches!(
        name,
        "white" | "pink" | "brown" | "blue" | "smooth" | "telegraph"
    )
}

/// Does `e` read `var` anywhere?
///
/// `Expr::deps` answers this already and is the same notion the recompute graph
/// uses, which is the point: "depends on `x`" must mean one thing across the
/// whole product.
fn mentions(e: &Expr, var: &str) -> bool {
    e.deps().contains(var)
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

    fn d(src: &str, var: &str) -> String {
        to_source(&diff(&tree(src), var).expect("differentiable"))
    }

    fn refused(src: &str, var: &str) -> String {
        match diff(&tree(src), var) {
            Err(e) => e.to_string(),
            Ok(ok) => panic!("expected a refusal, got {}", to_source(&ok)),
        }
    }

    #[test]
    fn the_four_rules() {
        assert_eq!(d("x + 3", "x"), "1");
        assert_eq!(d("x*y", "x"), "y");
        assert_eq!(d("x^3", "x"), "3x^2");
        assert_eq!(d("1/x", "x"), "-1/x^2");
        assert_eq!(d("sin(x^2)", "x"), "2x * cos(x^2)");
    }

    #[test]
    fn other_names_are_constants() {
        assert_eq!(d("k*x", "x"), "k");
        assert_eq!(d("y", "x"), "0");
        assert_eq!(d("pi*x", "x"), "pi");
    }

    /// The case the specification calls out by name: both base and exponent
    /// move, so the answer has to come from `exp(v ln u)`.
    #[test]
    fn x_to_the_x() {
        let out = d("x^x", "x");
        assert!(out.contains("ln(x)"), "{}", out);
        // and it is worth exactly x^x (ln x + 1) at, say, x = 2.
        let mut env = numpla_expr::Env::new();
        env.set("x", 2.0);
        let got = numpla_expr::eval(&tree(&out), &env).unwrap().scalar().unwrap();
        let want = 4.0 * (2.0f64.ln() + 1.0);
        assert!((got - want).abs() < 1e-12, "{} = {}", out, got);
    }

    #[test]
    fn every_builtin_has_an_answer_or_a_reason() {
        for name in [
            "sin", "cos", "tan", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "sqrt",
            "exp", "ln", "log", "abs", "floor", "ceil", "round", "sign",
        ] {
            let src = format!("{}(x)", name);
            assert!(diff(&tree(&src), "x").is_ok(), "{}", name);
        }
        for name in ["min", "max", "mod"] {
            let src = format!("{}(x, 2)", name);
            assert!(diff(&tree(&src), "x").is_ok(), "{}", name);
        }
        for name in ["white", "pink", "brown", "blue", "smooth", "telegraph"] {
            let src = format!("{}(x)", name);
            assert!(refused(&src, "x").contains("noise"), "{}", name);
        }
    }

    #[test]
    fn refusals_say_what_they_are_refusing() {
        assert!(refused("x'", "x").contains("independent variable"));
        assert!(refused("mod(x, x)", "x").contains("mod"));
        // A call to a name nothing defines is not a constant. Built by hand,
        // because `parse` reads `g(x)` as the product `g * x` unless the
        // document says `g` is a function — see `numpla_expr::parse_with`.
        let unknown = Expr::Call { name: "g".into(), args: vec![tree("x")] };
        match diff(&unknown, "x") {
            Err(e) => assert!(e.to_string().contains("no derivative rule"), "{}", e),
            Ok(ok) => panic!("expected a refusal, got {}", to_source(&ok)),
        }
    }

    /// `rand(3)` is a number, so it differentiates to zero rather than being
    /// refused as a random source — the "does not mention the variable" gate
    /// gets this right for free.
    #[test]
    fn a_seeded_draw_is_a_constant() {
        assert_eq!(d("x*rand(3)", "x"), "rand(3)");
    }
}
