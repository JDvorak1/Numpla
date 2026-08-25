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
pub use parser::{parse, parse_row, parse_row_with, parse_with, FuncNames, ParseError, ParsedRow};

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

    /// A noise-driven row is a vector field like any other. The solver calls
    /// this six times per step and twice more per rejected step, always at
    /// times it chooses; what it must never see is two different answers for
    /// one `(t, y)`. `numpla-noise` proves the integration converges — this
    /// proves the property survives the parser and the evaluator.
    #[test]
    fn a_noise_driven_row_is_a_deterministic_vector_field() {
        let (stmt, errs) = parse("x' = -x + 0.5 smooth(t)");
        assert!(errs.is_empty(), "{:?}", errs);
        let rhs = match stmt {
            Stmt::Ode { name, order, rhs } => {
                assert_eq!((name.as_str(), order), ("x", 1));
                rhs
            }
            other => panic!("{:?}", other),
        };

        let field = |t: f64, x: f64| -> f64 {
            let mut env = Env::new();
            env.set("t", t).set("x", x);
            eval(&rhs, &env).unwrap().scalar().unwrap()
        };

        // Out of order, repeatedly, exactly as an adaptive stepper would.
        for t in [0.0, 1.7, 0.4, 1.7, 9.9, 0.4] {
            let first = field(t, 1.0);
            assert!(first.is_finite());
            assert_eq!(field(t, 1.0).to_bits(), first.to_bits(), "at t = {}", t);
        }
        // And it is genuinely a function of t, not a constant.
        assert_ne!(field(0.0, 1.0), field(1.7, 1.0));
    }
}
