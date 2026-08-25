//! Pratt parser. Error-tolerant by design: a malformed or half-typed row
//! yields a tree containing `Expr::Hole` plus a list of errors, never a hard
//! failure. That is what lets the UI keep drawing while you type.

use crate::ast::{BinOp, Expr, Stmt};
use crate::lexer::{lex, Spanned, Tok};

#[derive(Debug, Clone, PartialEq)]
pub struct ParseError {
    pub msg: String,
    pub start: usize,
    pub end: usize,
}

pub struct Parser {
    toks: Vec<Spanned>,
    pos: usize,
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

impl Parser {
    pub fn new(src: &str) -> Self {
        Parser {
            toks: lex(src),
            pos: 0,
            errors: Vec::new(),
        }
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

    /// Parse one row of the expression list.
    pub fn stmt(&mut self) -> Stmt {
        let lhs = self.expr(0);
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
        loop {
            let t = match self.peek() {
                Some(t) => t,
                None => break,
            };
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
                if order > 0 {
                    Expr::Deriv { name, order }
                } else if self.at(&Tok::LParen) {
                    let args = self.args();
                    Expr::Call { name, args }
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

/// Parse one row. Returns the tree plus any errors; the tree is always usable.
pub fn parse(src: &str) -> (Stmt, Vec<ParseError>) {
    let mut p = Parser::new(src);
    let s = p.stmt();
    let errs = std::mem::take(&mut p.errors);
    (s, errs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expr_of(src: &str) -> Expr {
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

    #[test]
    fn dependencies_exclude_bound_parameters() {
        let (s, _) = parse("f(x) = a x + b");
        let d = s.deps();
        assert!(d.contains("a") && d.contains("b"));
        assert!(!d.contains("x"));
    }
}
