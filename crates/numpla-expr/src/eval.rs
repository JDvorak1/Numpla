//! Evaluation.
//!
//! `Unevaluated` propagates through every operation instead of raising. A row
//! that depends on something not yet typed is *pending*, not *wrong* — that
//! distinction is the whole gray-not-red error UX.

use std::collections::HashMap;

use numpla_noise::Kind as NoiseKind;

use crate::ast::{deriv_key, BinOp, Expr};
use crate::lexer::FUNCS;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Scalar(f64),
    List(Vec<f64>),
    /// Not an error: input incomplete or a dependency is still pending.
    Unevaluated,
}

impl Value {
    pub fn scalar(&self) -> Option<f64> {
        match self {
            Value::Scalar(x) => Some(*x),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum EvalError {
    Undefined(String),
    /// Reports the *slot*, not the raw string — "expects a scalar, got a list".
    TypeMismatch { what: String, expected: String },
    Arity {
        name: String,
        got: usize,
        want: usize,
    },
}

#[derive(Debug, Clone)]
pub struct Env {
    pub vars: HashMap<String, Value>,
    /// name -> (parameters, body)
    pub funcs: HashMap<String, (Vec<String>, Expr)>,
    /// The document's noise seed: what `smooth(t)` uses when no seed is
    /// written. Living on the environment rather than in a global is what
    /// keeps noise a pure function — see `numpla_noise`.
    pub noise_seed: u64,
    /// The document's default lattice rate for noise, in samples per unit of
    /// time. Overridden per call by `smooth(t, rate)`.
    pub noise_rate: f64,
}

/// Hand-written because [`Env::noise_rate`] must default to
/// [`numpla_noise::DEFAULT_RATE`], and a derived `Default` would give 0.
impl Default for Env {
    fn default() -> Self {
        Env {
            vars: HashMap::new(),
            funcs: HashMap::new(),
            noise_seed: numpla_noise::DEFAULT_SEED,
            noise_rate: numpla_noise::DEFAULT_RATE,
        }
    }
}

impl Env {
    pub fn new() -> Self {
        Env::default()
    }

    /// Set the document-level noise defaults in one place.
    pub fn set_noise(&mut self, seed: u64, rate: f64) -> &mut Self {
        self.noise_seed = seed;
        self.noise_rate = rate;
        self
    }

    pub fn set(&mut self, name: &str, v: f64) -> &mut Self {
        self.vars.insert(name.to_string(), Value::Scalar(v));
        self
    }

    pub fn set_value(&mut self, name: &str, v: Value) -> &mut Self {
        self.vars.insert(name.to_string(), v);
        self
    }

    pub fn def_fn(&mut self, name: &str, params: &[&str], body: Expr) -> &mut Self {
        let ps = params.iter().map(|s| s.to_string()).collect();
        self.funcs.insert(name.to_string(), (ps, body));
        self
    }
}

fn constant(name: &str) -> Option<f64> {
    match name {
        "pi" => Some(std::f64::consts::PI),
        "tau" => Some(std::f64::consts::TAU),
        "e" => Some(std::f64::consts::E),
        "inf" => Some(f64::INFINITY),
        _ => None,
    }
}

/// Parameters bound for the duration of one function call.
///
/// A function body sees exactly its own parameters plus the globals, so a call
/// needs a small overlay — not a copy of the environment. This replaces an
/// `env.clone()` per invocation, which cloned both hash maps every time and
/// made a document that factored its arithmetic into a named function roughly
/// 3.5x slower than the same arithmetic written inline. That penalty fell on
/// exactly the documents we want people to write, so it was a tax on legibility.
///
/// A linear scan beats a map here: parameter lists are one or two entries long,
/// and this runs inside the integration hot loop.
type Locals<'a> = &'a [(&'a str, Value)];

fn local_lookup(locals: Locals, name: &str) -> Option<Value> {
    locals
        .iter()
        .find(|(p, _)| *p == name)
        .map(|(_, v)| v.clone())
}

pub fn eval(e: &Expr, env: &Env) -> Result<Value, EvalError> {
    eval_in(e, env, &[])
}

fn eval_in(e: &Expr, env: &Env, locals: Locals) -> Result<Value, EvalError> {
    match e {
        Expr::Hole => Ok(Value::Unevaluated),
        Expr::Num(n) => Ok(Value::Scalar(*n)),
        Expr::Var(name) => match local_lookup(locals, name) {
            Some(v) => Ok(v),
            None => match env.vars.get(name) {
                Some(v) => Ok(v.clone()),
                None => match constant(name) {
                    Some(c) => Ok(Value::Scalar(c)),
                    None => Err(EvalError::Undefined(name.clone())),
                },
            },
        },
        // A derivative referenced as a value only means something once a solver
        // has bound it; until then the row is pending, not broken.
        Expr::Deriv { name, order } => {
            let key = deriv_key(name, *order);
            match env.vars.get(&key) {
                Some(v) => Ok(v.clone()),
                None => Ok(Value::Unevaluated),
            }
        }
        Expr::Neg(a) => match eval_in(a, env, locals)? {
            Value::Scalar(x) => Ok(Value::Scalar(-x)),
            Value::List(xs) => Ok(Value::List(xs.into_iter().map(|x| -x).collect())),
            Value::Unevaluated => Ok(Value::Unevaluated),
        },
        Expr::Bin { op, lhs, rhs } => {
            let a = eval_in(lhs, env, locals)?;
            let b = eval_in(rhs, env, locals)?;
            binary(*op, a, b)
        }
        Expr::List(items) => {
            let mut out = Vec::with_capacity(items.len());
            for it in items {
                match eval_in(it, env, locals)? {
                    Value::Scalar(x) => out.push(x),
                    Value::Unevaluated => return Ok(Value::Unevaluated),
                    Value::List(_) => {
                        return Err(EvalError::TypeMismatch {
                            what: "list element".into(),
                            expected: "scalar".into(),
                        })
                    }
                }
            }
            Ok(Value::List(out))
        }
        Expr::Call { name, args } => call(name, args, env, locals),
    }
}

fn apply_scalar(op: BinOp, x: f64, y: f64) -> f64 {
    match op {
        BinOp::Add => x + y,
        BinOp::Sub => x - y,
        BinOp::Mul => x * y,
        BinOp::Div => x / y,
        BinOp::Pow => x.powf(y),
    }
}

fn binary(op: BinOp, a: Value, b: Value) -> Result<Value, EvalError> {
    Ok(match (a, b) {
        (Value::Unevaluated, _) | (_, Value::Unevaluated) => Value::Unevaluated,
        (Value::Scalar(x), Value::Scalar(y)) => Value::Scalar(apply_scalar(op, x, y)),
        // Broadcasting: a scalar meets a list elementwise.
        (Value::Scalar(x), Value::List(ys)) => {
            Value::List(ys.into_iter().map(|y| apply_scalar(op, x, y)).collect())
        }
        (Value::List(xs), Value::Scalar(y)) => {
            Value::List(xs.into_iter().map(|x| apply_scalar(op, x, y)).collect())
        }
        (Value::List(xs), Value::List(ys)) => {
            if xs.len() != ys.len() {
                return Err(EvalError::TypeMismatch {
                    what: format!("lists of length {} and {}", xs.len(), ys.len()),
                    expected: "matching lengths".into(),
                });
            }
            Value::List(
                xs.into_iter()
                    .zip(ys)
                    .map(|(x, y)| apply_scalar(op, x, y))
                    .collect(),
            )
        }
    })
}

fn call(name: &str, args: &[Expr], env: &Env, locals: Locals) -> Result<Value, EvalError> {
    let mut vals = Vec::with_capacity(args.len());
    for a in args {
        let v = eval_in(a, env, locals)?;
        if v == Value::Unevaluated {
            return Ok(Value::Unevaluated);
        }
        vals.push(v);
    }

    if FUNCS.contains(&name) {
        return builtin(name, &vals, env);
    }

    if let Some((params, body)) = env.funcs.get(name) {
        if params.len() != vals.len() {
            return Err(EvalError::Arity {
                name: name.to_string(),
                got: vals.len(),
                want: params.len(),
            });
        }
        // The body sees its own parameters and the globals — not the caller's
        // parameters. Passing a fresh overlay rather than extending the current
        // one is what makes the scoping lexical.
        let frame: Vec<(&str, Value)> = params
            .iter()
            .map(|p| p.as_str())
            .zip(vals)
            .collect();
        return eval_in(body, env, &frame);
    }

    // `k(x+1)` where k is a number, not a function: implicit multiplication.
    // This is required by ordinary math notation, so it is not a fallback hack.
    if vals.len() == 1 {
        if let Some(v) = local_lookup(locals, name).or_else(|| env.vars.get(name).cloned()) {
            return binary(BinOp::Mul, v, vals.into_iter().next().unwrap());
        }
        if let Some(c) = constant(name) {
            return binary(BinOp::Mul, Value::Scalar(c), vals.into_iter().next().unwrap());
        }
    }

    // `x'(0)` before a solver has bound `x'`. Same rule as a bare `x'`: a
    // derivative that nothing has supplied yet is pending, not wrong.
    if name.ends_with('\'') {
        return Ok(Value::Unevaluated);
    }

    Err(EvalError::Undefined(name.to_string()))
}

/// How many arguments a builtin takes, as an inclusive range.
///
/// Most are exactly one. The wider ones are the builtins whose extra arguments
/// have a defensible default: `log(x)` is base 10, and a noise source falls
/// back to the document's rate and seed.
fn arity(name: &str) -> (usize, usize) {
    match name {
        "min" | "max" | "mod" => (2, 2),
        "log" => (1, 2),
        // n(t), n(t, rate), n(t, rate, seed).
        _ if NoiseKind::from_name(name).is_some() => (1, 3),
        // rand() draws from the document seed; rand(s) names its own stream.
        "rand" | "randn" => (0, 1),
        _ => (1, 1),
    }
}

fn builtin(name: &str, args: &[Value], env: &Env) -> Result<Value, EvalError> {
    let (least, most) = arity(name);
    if args.len() < least || args.len() > most {
        return Err(EvalError::Arity {
            name: name.to_string(),
            got: args.len(),
            want: least,
        });
    }

    let scalars: Vec<f64> = args
        .iter()
        .map(|v| {
            v.scalar().ok_or(EvalError::TypeMismatch {
                what: format!("argument of {}", name),
                expected: "scalar".into(),
            })
        })
        .collect::<Result<_, _>>()?;

    // Noise is a function of time, so it dispatches like any other builtin —
    // there is no state to thread through and no evaluation order to respect.
    // That is the whole point of `numpla_noise`; see its crate docs.
    if let Some(kind) = NoiseKind::from_name(name) {
        let rate = scalars.get(1).copied().unwrap_or(env.noise_rate);
        let seed = scalars
            .get(2)
            .map(|s| numpla_noise::seed_from_f64(*s))
            .unwrap_or(env.noise_seed);
        return Ok(Value::Scalar(numpla_noise::value(
            kind, scalars[0], rate, seed,
        )));
    }

    // `rand()` and `randn()` are pure functions of a seed, not draws from a
    // stream: `rand(3)` is a number the way `sqrt(3)` is. Without an argument
    // they take the document's seed, which is what makes a document that uses
    // them reproduce when it is reopened.
    match name {
        "rand" => {
            let seed = scalars
                .first()
                .map(|s| numpla_noise::seed_from_f64(*s))
                .unwrap_or(env.noise_seed);
            return Ok(Value::Scalar(numpla_noise::rand(seed)));
        }
        "randn" => {
            let seed = scalars
                .first()
                .map(|s| numpla_noise::seed_from_f64(*s))
                .unwrap_or(env.noise_seed);
            return Ok(Value::Scalar(numpla_noise::randn(seed)));
        }
        _ => {}
    }

    let x = scalars[0];
    let out = match name {
        "sin" => x.sin(),
        "cos" => x.cos(),
        "tan" => x.tan(),
        "arcsin" => x.asin(),
        "arccos" => x.acos(),
        "arctan" => x.atan(),
        "sinh" => x.sinh(),
        "cosh" => x.cosh(),
        "tanh" => x.tanh(),
        "sqrt" => x.sqrt(),
        "exp" => x.exp(),
        "ln" => x.ln(),
        "log" => {
            if scalars.len() == 2 {
                scalars[1].log(x)
            } else {
                x.log10()
            }
        }
        "abs" => x.abs(),
        "floor" => x.floor(),
        "ceil" => x.ceil(),
        "round" => x.round(),
        "sign" => {
            if x == 0.0 {
                0.0
            } else {
                x.signum()
            }
        }
        "min" => x.min(scalars[1]),
        "max" => x.max(scalars[1]),
        "mod" => x.rem_euclid(scalars[1]),
        _ => return Err(EvalError::Undefined(name.to_string())),
    };
    Ok(Value::Scalar(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::Stmt;
    use crate::parser::parse;

    fn ev(src: &str, env: &Env) -> Result<Value, EvalError> {
        match parse(src).0 {
            Stmt::Expr(e) => eval(&e, env),
            other => panic!("expected a bare expression, got {:?}", other),
        }
    }

    fn num(src: &str, env: &Env) -> f64 {
        match ev(src, env) {
            Ok(Value::Scalar(x)) => x,
            other => panic!("expected a scalar, got {:?}", other),
        }
    }

    #[test]
    fn arithmetic_and_precedence() {
        let env = Env::new();
        assert_eq!(num("1 + 2*3", &env), 7.0);
        assert_eq!(num("2^3^2", &env), 512.0);
        assert_eq!(num("-2^2", &env), -4.0);
    }

    #[test]
    fn implicit_multiplication_evaluates() {
        let mut env = Env::new();
        env.set("x", 4.0);
        assert_eq!(num("2x", &env), 8.0);
        assert_eq!(num("2(x+1)", &env), 10.0);
    }

    #[test]
    fn variable_juxtaposition_is_multiplication_not_a_call() {
        let mut env = Env::new();
        env.set("k", 3.0).set("x", 2.0);
        assert_eq!(num("k(x)", &env), 6.0);
    }

    #[test]
    fn user_functions() {
        let mut env = Env::new();
        let body = match parse("x^2 + 1").0 {
            Stmt::Expr(e) => e,
            _ => unreachable!(),
        };
        env.def_fn("f", &["x"], body);
        assert_eq!(num("f(3)", &env), 10.0);
    }

    #[test]
    fn constants() {
        let env = Env::new();
        assert!((num("cos pi", &env) + 1.0).abs() < 1e-12);
    }

    #[test]
    fn pending_beats_error_when_input_is_incomplete() {
        let env = Env::new();
        assert_eq!(ev("1 +", &env), Ok(Value::Unevaluated));
    }

    #[test]
    fn missing_name_is_a_real_error() {
        let env = Env::new();
        assert_eq!(ev("q + 1", &env), Err(EvalError::Undefined("q".into())));
    }

    /// Scoping, pinned. The overlay that replaced `env.clone()` has to get
    /// these exactly right, and each one is a way the cheap version could have
    /// been wrong.
    #[test]
    fn a_parameter_does_not_leak_out_of_its_function() {
        let mut env = Env::new();
        let body = match parse("u * 2").0 {
            Stmt::Expr(e) => e,
            _ => unreachable!(),
        };
        env.def_fn("f", &["u"], body);
        assert_eq!(num("f(3)", &env), 6.0);
        // `u` was only ever a parameter, so it must be undefined outside.
        assert_eq!(ev("u", &env), Err(EvalError::Undefined("u".into())));
    }

    #[test]
    fn a_parameter_shadows_a_global_of_the_same_name() {
        let mut env = Env::new();
        env.set("u", 100.0);
        let body = match parse("u * 2").0 {
            Stmt::Expr(e) => e,
            _ => unreachable!(),
        };
        env.def_fn("f", &["u"], body);
        assert_eq!(num("f(3)", &env), 6.0);
        // ...and the global is untouched afterwards.
        assert_eq!(num("u", &env), 100.0);
    }

    #[test]
    fn a_function_body_still_sees_globals() {
        let mut env = Env::new();
        env.set("k", 10.0);
        let body = match parse("k * u").0 {
            Stmt::Expr(e) => e,
            _ => unreachable!(),
        };
        env.def_fn("f", &["u"], body);
        assert_eq!(num("f(3)", &env), 30.0);
    }

    #[test]
    fn a_callee_does_not_see_the_callers_parameters() {
        let mut env = Env::new();
        // g takes no parameter named `u`; if the caller's frame leaked through,
        // `g(1)` would resolve `u` to f's argument instead of failing.
        let gbody = match parse("u + 1").0 {
            Stmt::Expr(e) => e,
            _ => unreachable!(),
        };
        env.def_fn("g", &["w"], gbody);
        let fbody = match parse("g(u)").0 {
            Stmt::Expr(e) => e,
            _ => unreachable!(),
        };
        env.def_fn("f", &["u"], fbody);
        assert_eq!(ev("f(5)", &env), Err(EvalError::Undefined("u".into())));
    }

    #[test]
    fn nested_calls_bind_their_own_arguments() {
        let mut env = Env::new();
        let sq = match parse("w * w").0 {
            Stmt::Expr(e) => e,
            _ => unreachable!(),
        };
        env.def_fn("g", &["w"], sq);
        let f = match parse("g(u) + g(u + 1)").0 {
            Stmt::Expr(e) => e,
            _ => unreachable!(),
        };
        env.def_fn("f", &["u"], f);
        // 3^2 + 4^2
        assert_eq!(num("f(3)", &env), 25.0);
    }

    #[test]
    fn lists_broadcast() {
        let env = Env::new();
        assert_eq!(ev("2 * [1, 2, 3]", &env), Ok(Value::List(vec![2.0, 4.0, 6.0])));
    }

    // ---- noise ----------------------------------------------------------

    fn at_time(src: &str, t: f64) -> f64 {
        let mut env = Env::new();
        env.set("t", t);
        num(src, &env)
    }

    #[test]
    fn every_noise_name_evaluates() {
        for name in ["white", "pink", "brown", "blue", "smooth", "telegraph"] {
            let v = at_time(&format!("{}(t)", name), 1.25);
            assert!(v.is_finite(), "{} gave {}", name, v);
        }
    }

    /// The property the solver depends on, stated at the layer the solver
    /// actually calls: evaluating the same row at the same `t` gives the same
    /// bits. If this ever stops holding, an ODE row that mentions noise stops
    /// converging.
    #[test]
    fn noise_is_a_pure_function_of_time() {
        for name in ["white", "pink", "brown", "blue", "smooth", "telegraph"] {
            let src = format!("{}(t)", name);
            let first = at_time(&src, 0.75);
            for _ in 0..8 {
                assert_eq!(at_time(&src, 0.75).to_bits(), first.to_bits(), "{}", name);
            }
        }
    }

    /// The three call shapes of the spec: `smooth(t)`, `smooth(t, rate)` and
    /// `smooth(t, rate, seed)`. Each added argument has to actually change the
    /// signal, or it is not being read.
    #[test]
    fn noise_takes_optional_rate_and_seed() {
        let bare = at_time("smooth(t)", 3.5);
        let rated = at_time("smooth(t, 8)", 3.5);
        let seeded = at_time("smooth(t, 8, 99)", 3.5);
        assert!(bare.is_finite() && rated.is_finite() && seeded.is_finite());
        assert_ne!(bare, rated, "rate argument ignored");
        assert_ne!(rated, seeded, "seed argument ignored");
    }

    /// Explicit seeds give independent streams — the spec's requirement that
    /// two noise sources in one model do not correlate by accident.
    #[test]
    fn explicit_seeds_give_different_streams() {
        let a: Vec<f64> = (0..200)
            .map(|i| at_time("smooth(t, 1, 1)", i as f64 * 0.05))
            .collect();
        let b: Vec<f64> = (0..200)
            .map(|i| at_time("smooth(t, 1, 2)", i as f64 * 0.05))
            .collect();
        assert!(a.iter().zip(&b).filter(|(x, y)| x != y).count() > 190);
    }

    /// The document's seed is what a bare `smooth(t)` uses, so changing it
    /// re-rolls every unseeded noise source at once.
    #[test]
    fn document_seed_drives_unseeded_noise() {
        let mut a = Env::new();
        a.set("t", 2.0);
        let mut b = Env::new();
        b.set("t", 2.0).set_noise(1234, numpla_noise::DEFAULT_RATE);
        assert_ne!(num("smooth(t)", &a), num("smooth(t)", &b));
        // And naming the document's own seed explicitly reproduces it.
        let mut c = Env::new();
        c.set("t", 2.0);
        assert_eq!(num("smooth(t)", &a), num("smooth(t, 1, 0)", &c));
    }

    #[test]
    fn rand_and_randn_are_pure_functions_of_a_seed() {
        let env = Env::new();
        assert_eq!(num("rand(3)", &env), num("rand(3)", &env));
        assert_ne!(num("rand(3)", &env), num("rand(4)", &env));
        let u = num("rand(7)", &env);
        assert!((0.0..1.0).contains(&u), "{}", u);
        assert!(num("randn(7)", &env).is_finite());
        // No argument: the document seed.
        assert_eq!(num("rand()", &env), num("rand(0)", &env));
    }

    #[test]
    fn noise_arity_is_checked() {
        let mut env = Env::new();
        env.set("t", 1.0);
        assert_eq!(
            ev("smooth()", &env),
            Err(EvalError::Arity {
                name: "smooth".into(),
                got: 0,
                want: 1
            })
        );
        assert_eq!(
            ev("smooth(t, 1, 2, 3)", &env),
            Err(EvalError::Arity {
                name: "smooth".into(),
                got: 4,
                want: 1
            })
        );
        assert_eq!(
            ev("rand(1, 2)", &env),
            Err(EvalError::Arity {
                name: "rand".into(),
                got: 2,
                want: 0
            })
        );
    }

    /// A pending argument keeps the row gray rather than turning it red — the
    /// same rule as everywhere else, and it has to survive the new builtins.
    #[test]
    fn noise_of_a_pending_value_is_pending() {
        let env = Env::new();
        assert_eq!(ev("smooth(t)", &env), Err(EvalError::Undefined("t".into())));
        assert_eq!(ev("smooth(1 +", &env), Ok(Value::Unevaluated));
    }

    /// Noise composes with the rest of the language, including implicit
    /// multiplication — `0.5 smooth(t)` is how a forcing term gets written.
    #[test]
    fn noise_composes_with_arithmetic() {
        let mut env = Env::new();
        env.set("t", 1.5);
        let n = num("smooth(t)", &env);
        assert!((num("0.5 smooth(t)", &env) - 0.5 * n).abs() < 1e-15);
        assert!((num("-x + 0.5 smooth(t)", env.set("x", 2.0)) - (-2.0 + 0.5 * n)).abs() < 1e-15);
    }
}
