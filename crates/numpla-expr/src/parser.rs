//! Pratt parser. Error-tolerant by design: a malformed or half-typed row
//! yields a tree containing `Expr::Hole` plus a list of errors, never a hard
//! failure. That is what lets the UI keep drawing while you type.

use std::collections::BTreeSet;

use crate::ast::{deriv_key, BinOp, Expr, Stmt};
use crate::lexer::{lex, Spanned, Tok};

/// The names a document has defined as functions, beyond the builtins.
///
/// Empty means "builtins only", which is what a caller who has not scanned the
/// document yet knows. See [`parse_with`] for why this has to be an input.
pub type FuncNames = BTreeSet<String>;

#[derive(Debug, Clone, PartialEq)]
pub struct ParseError {
    pub msg: String,
    pub start: usize,
    pub end: usize,
}

pub struct Parser<'a> {
    toks: Vec<Spanned>,
    pos: usize,
    /// Names this document defines as functions. A name that is *not* in here
    /// and is followed by `(` is a coefficient, not a call — see [`parse_with`].
    funcs: Option<&'a FuncNames>,
    pub errors: Vec<ParseError>,
}

/// Binding powers. Higher binds tighter.
const BP_ADD: (u8, u8) = (1, 2);
const BP_MUL: (u8, u8) = (3, 4);
const BP_NEG: u8 = 5;
/// Operand of a bare function application: `sin x^2` is `sin(x^2)`,
/// `sin x * y` is `sin(x) * y`.
const BP_APPLY: u8 = 6;
/// Right-associative: `2^3^2` is `2^(3^2)`.
const BP_POW: (u8, u8) = (8, 7);

impl<'a> Parser<'a> {
    /// Parse knowing only the builtins. Every other name followed by `(` is
    /// read as a coefficient.
    pub fn new(src: &str) -> Self {
        Parser {
            toks: lex(src),
            pos: 0,
            funcs: None,
            errors: Vec::new(),
        }
    }

    /// Parse knowing which names the document defines as functions.
    pub fn with_funcs(src: &str, funcs: &'a FuncNames) -> Self {
        Parser {
            toks: lex(src),
            pos: 0,
            funcs: Some(funcs),
            errors: Vec::new(),
        }
    }

    fn is_user_function(&self, name: &str) -> bool {
        self.funcs.is_some_and(|f| f.contains(name))
    }

    fn peek(&self) -> Option<Tok> {
        self.toks.get(self.pos).map(|s| s.tok.clone())
    }

    fn at(&self, t: &Tok) -> bool {
        self.toks.get(self.pos).map(|s| &s.tok) == Some(t)
    }

    fn bump(&mut self) -> Option<Tok> {
        let t = self.peek();
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    fn err(&mut self, msg: impl Into<String>) {
        let (start, end) = self
            .toks
            .get(self.pos)
            .map(|s| (s.start, s.end))
            .unwrap_or_else(|| {
                let e = self.toks.last().map(|s| s.end).unwrap_or(0);
                (e, e)
            });
        self.errors.push(ParseError {
            msg: msg.into(),
            start,
            end,
        });
    }

    /// Is the row a definition head — `f(x) = ...`, `x(0) = ...`, `x'(0) = ...`?
    ///
    /// The left of an `=` is the one place where `name(args)` always means a
    /// call, whatever `name` turns out to be: `f(u) = ...` defines a function
    /// and `x(0) = 1` sets an initial condition, and neither is a product.
    /// Deciding it here, from the shape of the whole row, is what lets
    /// [`Self::primary`] treat *every* other `name(` as a coefficient without
    /// having to know which names are states.
    fn at_definition_head(&self) -> bool {
        let mut i = self.pos;
        if !matches!(self.toks.get(i).map(|s| &s.tok), Some(Tok::Ident(_))) {
            return false;
        }
        i += 1;
        while matches!(self.toks.get(i).map(|s| &s.tok), Some(Tok::Prime)) {
            i += 1;
        }
        if !matches!(self.toks.get(i).map(|s| &s.tok), Some(Tok::LParen)) {
            return false;
        }
        let mut depth = 0usize;
        while let Some(s) = self.toks.get(i) {
            match s.tok {
                Tok::LParen => depth += 1,
                Tok::RParen => {
                    depth -= 1;
                    if depth == 0 {
                        return matches!(self.toks.get(i + 1).map(|s| &s.tok), Some(Tok::Eq));
                    }
                }
                _ => {}
            }
            i += 1;
        }
        false
    }

    /// The `f(x)` / `x'(0)` on the left of an `=`. Caller has checked the shape.
    fn definition_head(&mut self) -> Expr {
        let name = match self.bump() {
            Some(Tok::Ident(n)) => n,
            _ => unreachable!("at_definition_head checked this"),
        };
        let mut order = 0u8;
        while self.at(&Tok::Prime) {
            self.pos += 1;
            order = order.saturating_add(1);
        }
        let args = self.args();
        Expr::Call {
            name: deriv_key(&name, order),
            args,
        }
    }

    /// Parse one row of the expression list.
    pub fn stmt(&mut self) -> Stmt {
        let lhs = if self.at_definition_head() {
            self.definition_head()
        } else {
            self.expr(0)
        };
        let stmt = if self.at(&Tok::Eq) {
            self.pos += 1;
            let rhs = self.expr(0);
            match lhs {
                Expr::Deriv { name, order } => Stmt::Ode { name, order, rhs },
                Expr::Var(name) => Stmt::Assign {
                    name,
                    params: Vec::new(),
                    rhs,
                },
                Expr::Call { name, args } => {
                    let mut params = Vec::new();
                    let mut simple = true;
                    for a in &args {
                        match a {
                            Expr::Var(v) => params.push(v.clone()),
                            _ => simple = false,
                        }
                    }
                    if simple {
                        Stmt::Assign { name, params, rhs }
                    } else {
                        Stmt::Equation {
                            lhs: Expr::Call { name, args },
                            rhs,
                        }
                    }
                }
                other => Stmt::Equation { lhs: other, rhs },
            }
        } else {
            Stmt::Expr(lhs)
        };
        if self.pos < self.toks.len() {
            self.err("unexpected trailing input");
        }
        stmt
    }

    pub fn expr(&mut self, min_bp: u8) -> Expr {
        let mut lhs = self.prefix();
        while let Some(t) = self.peek() {
            let (op, lbp, rbp, explicit) = match t {
                Tok::Plus => (BinOp::Add, BP_ADD.0, BP_ADD.1, true),
                Tok::Minus => (BinOp::Sub, BP_ADD.0, BP_ADD.1, true),
                Tok::Star => (BinOp::Mul, BP_MUL.0, BP_MUL.1, true),
                Tok::Slash => (BinOp::Div, BP_MUL.0, BP_MUL.1, true),
                Tok::Caret => (BinOp::Pow, BP_POW.0, BP_POW.1, true),
                ref t if t.starts_primary() => (BinOp::Mul, BP_MUL.0, BP_MUL.1, false),
                _ => break,
            };
            if lbp < min_bp {
                break;
            }
            if explicit {
                self.pos += 1;
            }
            let rhs = self.expr(rbp);
            lhs = Expr::Bin {
                op,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            };
        }
        lhs
    }

    fn prefix(&mut self) -> Expr {
        match self.peek() {
            Some(Tok::Minus) => {
                self.pos += 1;
                Expr::Neg(Box::new(self.expr(BP_NEG)))
            }
            Some(Tok::Plus) => {
                self.pos += 1;
                self.expr(BP_NEG)
            }
            _ => self.primary(),
        }
    }

    fn primary(&mut self) -> Expr {
        let t = match self.bump() {
            Some(t) => t,
            None => {
                self.err("expected an expression");
                return Expr::Hole;
            }
        };
        match t {
            Tok::Num(n) => Expr::Num(n),
            Tok::Ident(name) => {
                let mut order = 0u8;
                while self.at(&Tok::Prime) {
                    self.pos += 1;
                    order = order.saturating_add(1);
                }
                // `g(...)` is a call only when `g` is known to be a function.
                // Otherwise the paren is left for the implicit-multiplication
                // rule in `expr`, which binds at multiplication strength — so
                // `g (y - x)^3` cubes the group, not the product. Building a
                // `Call` here and multiplying at eval time instead would put
                // the exponent outside the product and silently integrate a
                // different system; see the two-pass compile in `numpla-model`.
                if self.at(&Tok::LParen) && self.is_user_function(&deriv_key(&name, order)) {
                    let args = self.args();
                    Expr::Call {
                        name: deriv_key(&name, order),
                        args,
                    }
                } else if order > 0 {
                    Expr::Deriv { name, order }
                } else {
                    Expr::Var(name)
                }
            }
            Tok::Func(name) => {
                if self.at(&Tok::LParen) {
                    let args = self.args();
                    Expr::Call { name, args }
                } else {
                    let a = self.expr(BP_APPLY);
                    Expr::Call {
                        name,
                        args: vec![a],
                    }
                }
            }
            Tok::LParen => {
                let e = self.expr(0);
                if self.at(&Tok::RParen) {
                    self.pos += 1;
                } else {
                    self.err("missing )");
                }
                e
            }
            Tok::LBracket => {
                let mut items = Vec::new();
                if !self.at(&Tok::RBracket) {
                    loop {
                        items.push(self.expr(0));
                        if self.at(&Tok::Comma) {
                            self.pos += 1;
                        } else {
                            break;
                        }
                    }
                }
                if self.at(&Tok::RBracket) {
                    self.pos += 1;
                } else {
                    self.err("missing ]");
                }
                Expr::List(items)
            }
            other => {
                self.pos -= 1;
                self.err(format!("unexpected {:?}", other));
                self.pos += 1;
                Expr::Hole
            }
        }
    }

    fn args(&mut self) -> Vec<Expr> {
        // caller has verified the current token is an opening paren
        self.pos += 1;
        let mut args = Vec::new();
        if !self.at(&Tok::RParen) {
            loop {
                args.push(self.expr(0));
                if self.at(&Tok::Comma) {
                    self.pos += 1;
                } else {
                    break;
                }
            }
        }
        if self.at(&Tok::RParen) {
            self.pos += 1;
        } else {
            self.err("missing )");
        }
        args
    }
}

/// Parse one row knowing only the builtin functions.
///
/// Every other `name(` is read as a coefficient — `k(x+1)` is `k * (x+1)` —
/// which is the right guess for a caller that has not scanned the document.
/// A caller that *has* should use [`parse_with`].
pub fn parse(src: &str) -> (Stmt, Vec<ParseError>) {
    let mut p = Parser::new(src);
    let s = p.stmt();
    let errs = std::mem::take(&mut p.errors);
    (s, errs)
}

/// Parse one row knowing which names the document defines as functions.
///
/// `g (y - x)^3` and `f(y - x)^3` are the same token sequence, and they mean
/// different things: one cubes a difference and scales it, the other cubes the
/// result of a call. Nothing local to the row can tell them apart — only the
/// rest of the document can, by saying whether `f` has an `f(u) = ...` row.
/// So the function set is an *input* to parsing rather than something resolved
/// afterwards at eval time, and a caller that owns the whole document (see
/// `numpla_model::document::compile`) gathers it in a first pass and parses in
/// a second.
///
/// The zero-argument [`parse`] stays the entry point for anyone holding a
/// single row, and behaves as if the set were empty.
pub fn parse_with(src: &str, funcs: &FuncNames) -> (Stmt, Vec<ParseError>) {
    let mut p = Parser::with_funcs(src, funcs);
    let s = p.stmt();
    let errs = std::mem::take(&mut p.errors);
    (s, errs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expr_of(src: &str) -> Expr {
        // builtins only, which is what `parse` knows
        match parse(src).0 {
            Stmt::Expr(e) => e,
            other => panic!("expected a bare expression, got {:?}", other),
        }
    }

    #[test]
    fn implicit_multiplication() {
        assert_eq!(
            expr_of("2x"),
            Expr::Bin {
                op: BinOp::Mul,
                lhs: Box::new(Expr::Num(2.0)),
                rhs: Box::new(Expr::Var("x".into())),
            }
        );
    }

    #[test]
    fn power_is_right_associative() {
        let e = expr_of("2^3^2");
        match e {
            Expr::Bin {
                op: BinOp::Pow,
                rhs,
                ..
            } => {
                assert!(matches!(*rhs, Expr::Bin { op: BinOp::Pow, .. }));
            }
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn unary_minus_binds_looser_than_power() {
        // -x^2 is -(x^2), not (-x)^2
        assert!(matches!(expr_of("-x^2"), Expr::Neg(_)));
    }

    #[test]
    fn ode_row() {
        let (s, errs) = parse("x' = -y");
        assert!(errs.is_empty(), "{:?}", errs);
        match s {
            Stmt::Ode { name, order, .. } => {
                assert_eq!(name, "x");
                assert_eq!(order, 1);
            }
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn second_order_ode_row() {
        match parse("x'' = -x").0 {
            Stmt::Ode { order, .. } => assert_eq!(order, 2),
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn function_definition() {
        match parse("f(x) = x^2").0 {
            Stmt::Assign { name, params, .. } => {
                assert_eq!(name, "f");
                assert_eq!(params, vec!["x".to_string()]);
            }
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn derivative_initial_condition_is_a_call_on_the_derivative() {
        // `x'(0) = 1` is the initial condition of a lowered velocity state.
        match parse("x'(0) = 1").0 {
            Stmt::Equation {
                lhs: Expr::Call { name, args },
                rhs,
            } => {
                assert_eq!(name, "x'");
                assert_eq!(args, vec![Expr::Num(0.0)]);
                assert_eq!(rhs, Expr::Num(1.0));
            }
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn a_primed_call_still_reads_as_a_product_when_the_derivative_is_bound() {
        // The notation is ambiguous; the value must not change. `x'(t)` means
        // `x' * t` whenever `x'` is a number rather than a function.
        use crate::eval::{eval, Env, Value};
        let mut env = Env::new();
        env.set("x'", 3.0);
        let e = match parse("x'(2)").0 {
            Stmt::Expr(e) => e,
            other => panic!("{:?}", other),
        };
        assert_eq!(eval(&e, &env), Ok(Value::Scalar(6.0)));
    }

    #[test]
    fn an_unbound_primed_call_is_pending_not_undefined() {
        use crate::eval::{eval, Env, Value};
        let e = match parse("x'(2)").0 {
            Stmt::Expr(e) => e,
            other => panic!("{:?}", other),
        };
        assert_eq!(eval(&e, &Env::new()), Ok(Value::Unevaluated));
    }

    #[test]
    fn implicit_curve_is_an_equation_not_an_assignment() {
        assert!(matches!(parse("x^2 + y^2 = 1").0, Stmt::Equation { .. }));
    }

    #[test]
    fn bare_function_application() {
        // sin x^2 == sin(x^2)
        match expr_of("sin x^2") {
            Expr::Call { name, args } => {
                assert_eq!(name, "sin");
                assert!(matches!(args[0], Expr::Bin { op: BinOp::Pow, .. }));
            }
            other => panic!("{:?}", other),
        }
        // sin x * y == sin(x) * y
        assert!(matches!(
            expr_of("sin x * y"),
            Expr::Bin { op: BinOp::Mul, .. }
        ));
    }

    #[test]
    fn incomplete_input_yields_a_hole_not_a_failure() {
        let (s, errs) = parse("x +");
        assert!(!errs.is_empty());
        match s {
            Stmt::Expr(e) => assert!(e.has_hole()),
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn unclosed_paren_still_parses() {
        let (s, errs) = parse("sin(x");
        assert!(!errs.is_empty());
        assert!(matches!(s, Stmt::Expr(_)));
    }

    /// The regression the two-pass compile exists for.
    ///
    /// `g (y - x)^3` at `g = 40, y - x = -1` is `-40`. Reading `g(...)` as a
    /// call put the exponent outside the product and gave `-64000` — a
    /// plausible curve of a different system, with nothing reported.
    #[test]
    fn a_coefficient_before_a_group_does_not_capture_the_exponent() {
        use crate::eval::{eval, Env, Value};
        let mut env = Env::new();
        env.set("g", 40.0).set("y", 0.0).set("x", 1.0);
        assert_eq!(eval(&expr_of("g (y - x)^3"), &env), Ok(Value::Scalar(-40.0)));
        // and the parenthesised spelling has not changed meaning
        assert_eq!(
            eval(&expr_of("g ((y - x)^3)"), &env),
            Ok(Value::Scalar(-40.0))
        );
        // the tree says the same thing: a product whose right half is the power
        assert!(matches!(
            expr_of("g (y - x)^3"),
            Expr::Bin { op: BinOp::Mul, rhs, .. } if matches!(*rhs, Expr::Bin { op: BinOp::Pow, .. })
        ));
    }

    /// The other half of the same ambiguity: a name the document *has* defined
    /// as a function keeps call precedence, so `f(u)^3` cubes the result.
    #[test]
    fn a_known_function_before_a_group_is_still_a_call() {
        let funcs: FuncNames = ["f".to_string()].into_iter().collect();
        let e = match parse_with("f(y - x)^3", &funcs).0 {
            Stmt::Expr(e) => e,
            other => panic!("{:?}", other),
        };
        match e {
            Expr::Bin { op: BinOp::Pow, lhs, .. } => {
                assert!(matches!(*lhs, Expr::Call { .. }), "{:?}", lhs);
            }
            other => panic!("{:?}", other),
        }
        // The same text, without the function set, is a product.
        assert!(matches!(
            expr_of("f(y - x)^3"),
            Expr::Bin { op: BinOp::Mul, .. }
        ));
    }

    /// A builtin never needed the document's help: `sin` is in the lexer.
    #[test]
    fn a_builtin_call_keeps_call_precedence() {
        assert!(matches!(
            expr_of("sin(x)^2"),
            Expr::Bin { op: BinOp::Pow, .. }
        ));
    }

    /// Definition heads are decided by the shape of the row, not by the
    /// function set — otherwise `x(0) = 1` would become `x * 0 = 1` for every
    /// state, which is the notation the model reads initial conditions from.
    #[test]
    fn a_definition_head_is_a_call_whatever_the_function_set_says() {
        let empty = FuncNames::new();
        for src in ["x(0) = 1", "x'(0) = 2", "f(u) = u^2"] {
            let head = match parse_with(src, &empty).0 {
                Stmt::Assign { name, .. } => name,
                Stmt::Equation { lhs: Expr::Call { name, .. }, .. } => name,
                other => panic!("{}: {:?}", src, other),
            };
            assert!(!head.is_empty(), "{}", src);
        }
    }

    #[test]
    fn dependencies_exclude_bound_parameters() {
        let (s, _) = parse("f(x) = a x + b");
        let d = s.deps();
        assert!(d.contains("a") && d.contains("b"));
        assert!(!d.contains("x"));
    }
}
