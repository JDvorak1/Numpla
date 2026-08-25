//! Evaluation.
//!
//! `Unevaluated` propagates through every operation instead of raising. A row
//! that depends on something not yet typed is *pending*, not *wrong* — that
//! distinction is the whole gray-not-red error UX.

use std::collections::HashMap;

use crate::ast::{BinOp, Expr};
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

#[derive(Debug, Clone, Default)]
pub struct Env {
    pub vars: HashMap<String, Value>,
    /// name -> (parameters, body)
    pub funcs: HashMap<String, (Vec<String>, Expr)>,
}

impl Env {
    pub fn new() -> Self {
        Env::default()
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

pub fn eval(e: &Expr, env: &Env) -> Result<Value, EvalError> {
    match e {
        Expr::Hole => Ok(Value::Unevaluated),
        Expr::Num(n) => Ok(Value::Scalar(*n)),
        Expr::Var(name) => match env.vars.get(name) {
            Some(v) => Ok(v.clone()),
            None => match constant(name) {
                Some(c) => Ok(Value::Scalar(c)),
                None => Err(EvalError::Undefined(name.clone())),
            },
        },
        // A derivative referenced as a value only means something once a solver
        // has bound it; until then the row is pending, not broken.
        Expr::Deriv { name, order } => {
            let key = format!("{}{}", name, "'".repeat(*order as usize));
            match env.vars.get(&key) {
                Some(v) => Ok(v.clone()),
                None => Ok(Value::Unevaluated),
            }
        }
        Expr::Neg(a) => match eval(a, env)? {
            Value::Scalar(x) => Ok(Value::Scalar(-x)),
            Value::List(xs) => Ok(Value::List(xs.into_iter().map(|x| -x).collect())),
            Value::Unevaluated => Ok(Value::Unevaluated),
        },
        Expr::Bin { op, lhs, rhs } => {
            let a = eval(lhs, env)?;
            let b = eval(rhs, env)?;
            binary(*op, a, b)
        }
        Expr::List(items) => {
            let mut out = Vec::with_capacity(items.len());
            for it in items {
                match eval(it, env)? {
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
        Expr::Call { name, args } => call(name, args, env),
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

fn call(name: &str, args: &[Expr], env: &Env) -> Result<Value, EvalError> {
    let mut vals = Vec::with_capacity(args.len());
    for a in args {
        let v = eval(a, env)?;
        if v == Value::Unevaluated {
            return Ok(Value::Unevaluated);
        }
        vals.push(v);
    }

    if FUNCS.contains(&name) {
        return builtin(name, &vals);
    }

    if let Some((params, body)) = env.funcs.get(name) {
        if params.len() != vals.len() {
            return Err(EvalError::Arity {
                name: name.to_string(),
                got: vals.len(),
                want: params.len(),
            });
        }
        let mut local = env.clone();
        for (p, v) in params.iter().zip(vals) {
            local.vars.insert(p.clone(), v);
        }
        return eval(body, &local);
    }

    // `k(x+1)` where k is a number, not a function: implicit multiplication.
    // This is required by ordinary math notation, so it is not a fallback hack.
    if vals.len() == 1 {
        if let Some(v) = env.vars.get(name).cloned() {
            return binary(BinOp::Mul, v, vals.into_iter().next().unwrap());
        }
        if let Some(c) = constant(name) {
            return binary(BinOp::Mul, Value::Scalar(c), vals.into_iter().next().unwrap());
        }
    }

    Err(EvalError::Undefined(name.to_string()))
}

fn builtin(name: &str, args: &[Value]) -> Result<Value, EvalError> {
    let want = match name {
        "min" | "max" | "mod" | "log" => 2,
        _ => 1,
    };
    // log with one argument is base 10; every other builtin is strict.
    let flexible = name == "log";
    if args.len() != want && !(flexible && args.len() == 1) {
        return Err(EvalError::Arity {
            name: name.to_string(),
            got: args.len(),
            want,
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

    #[test]
    fn lists_broadcast() {
        let env = Env::new();
        assert_eq!(ev("2 * [1, 2, 3]", &env), Ok(Value::List(vec![2.0, 4.0, 6.0])));
    }
}
