//! Numpla's expression core: tokenizer, parser, AST, evaluator.
//!
//! Two rules shape this crate, and both come from the UX rather than from
//! compiler tradition:
//!
//! 1. **Parsing never fails.** Incomplete input produces [`ast::Expr::Hole`]
//!    alongside a list of errors. Rows stay drawable while you type.
//! 2. **Pending is not wrong.** [`eval::Value::Unevaluated`] propagates through
//!    every operation, so a row waiting on an undefined slider goes gray, not
//!    red.

pub mod ast;
pub mod eval;
pub mod lexer;
pub mod parser;

pub use ast::{deriv_key, BinOp, Expr, Stmt};
pub use eval::{eval, Env, EvalError, Value};
pub use parser::{parse, ParseError};

#[cfg(test)]
mod integration {
    use super::*;

    /// The M1 target: a two-row linear system parses into ODE rows whose
    /// right-hand sides evaluate against a state environment. This is what
    /// `numpla-ode` will call once per step.
    #[test]
    fn harmonic_oscillator_rows_evaluate_as_a_vector_field() {
        let rows = ["x' = -y", "y' = x"];
        let mut env = Env::new();
        env.set("x", 1.0).set("y", 0.0);

        let mut rhs = Vec::new();
        for src in rows {
            let (stmt, errs) = parse(src);
            assert!(errs.is_empty(), "{}: {:?}", src, errs);
            match stmt {
                Stmt::Ode { name, order, rhs: r } => {
                    assert_eq!(order, 1);
                    let v = eval(&r, &env).unwrap().scalar().unwrap();
                    rhs.push((name, v));
                }
                other => panic!("{:?}", other),
            }
        }

        assert_eq!(rhs, vec![("x".to_string(), 0.0), ("y".to_string(), 1.0)]);
    }
}
