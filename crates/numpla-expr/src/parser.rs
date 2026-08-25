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
    /// The independent variable this row *named*, if it was written in Leibniz
    /// notation — the `t` of `dx/dt`. See [`ParsedRow::indep`].
    indep: Option<String>,
    pub errors: Vec<ParseError>,
}

/// One parsed row: the tree, the problems, and the independent variable the
/// row named.
///
/// The third field is why this exists. `dx/dt = -y` and `x' = -y` are the same
/// differential equation and produce the *identical* [`Stmt`] — that equality
/// is the whole point of supporting both spellings, and putting the
/// independent variable inside the AST would destroy it. But the Leibniz row
/// says one extra thing the primed row does not: what the derivative is taken
/// *with respect to*. That is a fact about the row's notation rather than about
/// the equation, so it travels beside the tree instead of inside it, and the
/// document layer reconciles the rows into one answer.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedRow {
    pub stmt: Stmt,
    pub errors: Vec<ParseError>,
    /// `Some("t")` for `dx/dt = ...`, `Some("x")` for `df/dx = ...`.
    /// `None` for every other row, including `x' = ...`: a prime names no
    /// independent variable, so such a row takes the document's.
    pub indep: Option<String>,
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
            indep: None,
            errors: Vec::new(),
        }
    }

    /// Parse knowing which names the document defines as functions.
    pub fn with_funcs(src: &str, funcs: &'a FuncNames) -> Self {
        Parser {
            toks: lex(src),
            pos: 0,
            funcs: Some(funcs),
            indep: None,
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

    /// `dx/dt = ...`, `d2x/dt2 = ...`, `d^2x/dt^2 = ...` — a differential
    /// equation written the way most people write one.
    ///
    /// # Why this is safe, given that `d` is an ordinary identifier
    ///
    /// The tokens of `dx/dt` are exactly those of the quotient `d*x / d*t`, and
    /// `d` is a perfectly good parameter name — the predator–prey demo uses it
    /// for a predation rate and the colliding-strings demo for a distance. What
    /// makes the reading unambiguous is not the tokens but *where they sit*:
    /// this matcher fires only when the shape spans the **entire left-hand side
    /// of an `=`**, from the first token of the row to the `=` itself, with
    /// nothing else in it.
    ///
    /// A row of that shape has never meant anything else. `d x / d t = -y`
    /// parses today as an [`Stmt::Equation`] with a bare quotient on the left,
    /// which `numpla_model` rejects outright — the format has no implicit
    /// curves. So every document this changes the meaning of is a document that
    /// was already a red row, and the change can only turn red rows green.
    ///
    /// Everything else is untouched, because nothing else is looked at:
    /// `d = 0.25` has no slash, `y' = d x y` is a right-hand side and is never
    /// scanned, and a bare `dx/dt` with no `=` stays the quotient it always was.
    /// Reading a Leibniz derivative *inside* an expression would need a
    /// symbolic derivative rather than a notation, and is deliberately not
    /// attempted here.
    ///
    /// Returns `(name, independent, numerator order, denominator order, index
    /// of the `=`)`.
    fn at_leibniz_head(&self) -> Option<(String, String, u8, u8, usize)> {
        let mut i = self.pos;
        if self.ident_at(i)? != "d" {
            return None;
        }
        i += 1;
        // `d2x` and `d^2x` both spell the same second derivative; the caret is
        // what a person types when they are copying out of a textbook, and the
        // bare digit is what they type when they are not.
        let (num_order, j) = self.superscript(i);
        i = j;
        let name = self.ident_at(i)?;
        i += 1;
        if !matches!(self.tok(i), Some(Tok::Slash)) {
            return None;
        }
        i += 1;
        if self.ident_at(i)? != "d" {
            return None;
        }
        i += 1;
        let indep = self.ident_at(i)?;
        i += 1;
        let (den_order, j) = self.superscript(i);
        i = j;
        // The `=` is what makes this a row and not a quotient. Without it the
        // text is a bare expression — a plot row — and stays one.
        if !matches!(self.tok(i), Some(Tok::Eq)) {
            return None;
        }
        Some((name, indep, num_order, den_order, i))
    }

    /// An order written as `2` or as `^2`, defaulting to 1 when absent.
    /// Returns the order and the index just past it.
    fn superscript(&self, i: usize) -> (u8, usize) {
        let (n, next) = match self.tok(i) {
            Some(Tok::Caret) => match self.tok(i + 1) {
                Some(&Tok::Num(n)) => (n, i + 2),
                _ => return (1, i),
            },
            Some(&Tok::Num(n)) => (n, i + 1),
            _ => return (1, i),
        };
        // A non-integer or absurd order is not a superscript at all; leaving it
        // unconsumed makes the row fall through to the ordinary parse rather
        // than being silently reinterpreted.
        if n.fract() != 0.0 || !(0.0..=255.0).contains(&n) {
            return (1, i);
        }
        (n as u8, next)
    }

    fn tok(&self, i: usize) -> Option<&Tok> {
        self.toks.get(i).map(|s| &s.tok)
    }

    fn ident_at(&self, i: usize) -> Option<String> {
        match self.tok(i) {
            Some(Tok::Ident(n)) => Some(n.clone()),
            _ => None,
        }
    }

    /// The Leibniz row, if this is one. Leaves the parser on the `=`'s
    /// right-hand side.
    fn leibniz_ode(&mut self) -> Option<Stmt> {
        let (name, indep, num_order, den_order, eq) = self.at_leibniz_head()?;
        let head_start = self.toks[self.pos].start;
        self.pos = eq + 1;
        if num_order != den_order {
            // `d2x/dt` is a slip of the pen, not a different notation. Saying
            // so beats letting the row fall through to "only ODE rows,
            // definitions and initial conditions are supported", which is true
            // but tells the person nothing about what they typed.
            self.errors.push(ParseError {
                msg: format!(
                    "d{}{}/d{}{} does not match — both orders must be the same",
                    order_text(num_order),
                    name,
                    indep,
                    order_text(den_order)
                ),
                start: head_start,
                end: self.toks[eq].start,
            });
        }
        self.indep = Some(indep);
        let rhs = self.expr(0);
        Some(Stmt::Ode {
            name,
            order: num_order,
            rhs,
        })
    }

    /// Parse one row of the expression list.
    pub fn stmt(&mut self) -> Stmt {
        if let Some(ode) = self.leibniz_ode() {
            if self.pos < self.toks.len() {
                self.err("unexpected trailing input");
            }
            return ode;
        }
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

/// How an order is spelled back in a message: `dx/dt`, not `d1x/d1t`.
fn order_text(order: u8) -> String {
    if order == 1 {
        String::new()
    } else {
        order.to_string()
    }
}

/// Parse one row knowing only the builtin functions.
///
/// Every other `name(` is read as a coefficient — `k(x+1)` is `k * (x+1)` —
/// which is the right guess for a caller that has not scanned the document.
/// A caller that *has* should use [`parse_with`].
pub fn parse(src: &str) -> (Stmt, Vec<ParseError>) {
    let r = parse_row(src);
    (r.stmt, r.errors)
}

/// Parse one row and keep the independent variable it named, if any.
///
/// [`parse`] and [`parse_with`] drop that, which is right for anyone holding a
/// single expression: `dx/dt = -y` and `x' = -y` are the same equation and the
/// same [`Stmt`]. A caller that owns the *whole document* wants the extra fact,
/// because one document has one independent variable and it is the rows that
/// say what it is — see `numpla_model::document::compile`.
pub fn parse_row(src: &str) -> ParsedRow {
    let mut p = Parser::new(src);
    finish(&mut p)
}

/// [`parse_row`], knowing which names the document defines as functions.
pub fn parse_row_with(src: &str, funcs: &FuncNames) -> ParsedRow {
    let mut p = Parser::with_funcs(src, funcs);
    finish(&mut p)
}

fn finish(p: &mut Parser) -> ParsedRow {
    let stmt = p.stmt();
    ParsedRow {
        stmt,
        errors: std::mem::take(&mut p.errors),
        indep: p.indep.take(),
    }
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
    let r = parse_row_with(src, funcs);
    (r.stmt, r.errors)
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

    // --- Leibniz notation -------------------------------------------------

    /// The headline claim: the two spellings are not merely equivalent, they
    /// are *the same tree*. Anything downstream that could tell them apart
    /// would be a place where one of them behaves differently.
    #[test]
    fn leibniz_and_prime_produce_the_identical_statement() {
        for (leibniz, prime) in [
            ("dx/dt = -y", "x' = -y"),
            ("d2x/dt2 = -x", "x'' = -x"),
            ("d^2x/dt^2 = -x", "x'' = -x"),
            ("df/dx = 2x", "f' = 2x"),
            ("dx_1/dt = k x_2 - sin(t)", "x_1' = k x_2 - sin(t)"),
        ] {
            let a = parse_row(leibniz);
            let b = parse_row(prime);
            assert!(a.errors.is_empty(), "{}: {:?}", leibniz, a.errors);
            assert!(b.errors.is_empty(), "{}: {:?}", prime, b.errors);
            assert_eq!(a.stmt, b.stmt, "{} vs {}", leibniz, prime);
        }
    }

    /// The one thing the Leibniz row says that the primed row does not.
    #[test]
    fn the_denominator_names_the_independent_variable() {
        assert_eq!(parse_row("dx/dt = -y").indep.as_deref(), Some("t"));
        assert_eq!(parse_row("df/dx = 2x").indep.as_deref(), Some("x"));
        assert_eq!(parse_row("d2y/ds2 = -y").indep.as_deref(), Some("s"));
        // A prime names nothing, so the row takes whatever the document uses.
        assert_eq!(parse_row("x' = -y").indep, None);
        assert_eq!(parse_row("k = 3").indep, None);
    }

    /// Whitespace is not what disambiguates this — the lexer has already
    /// thrown it away — so the spaced spelling has to read the same.
    #[test]
    fn spacing_inside_a_leibniz_row_does_not_change_it() {
        assert_eq!(parse_row("d x / d t = -y").stmt, parse_row("dx/dt = -y").stmt);
    }

    /// `d` is an ordinary single-letter identifier and stays one. The
    /// predator-prey demo writes `d = 0.25` and then `y' = -c y + d x y`; if
    /// the notation reached into right-hand sides, that row would change
    /// meaning and the model would silently become a different one.
    #[test]
    fn d_is_still_an_ordinary_name_everywhere_else() {
        // A parameter row.
        assert!(matches!(parse_row("d = 0.25").stmt, Stmt::Assign { .. }));
        // A coefficient in a right-hand side, quotient included.
        use crate::eval::{eval, Env, Value};
        let mut env = Env::new();
        env.set("d", 2.0).set("x", 3.0).set("y", 5.0).set("t", 4.0);
        let rhs = match parse_row("y' = -c y + d x y").stmt {
            Stmt::Ode { rhs, .. } => rhs,
            other => panic!("{:?}", other),
        };
        env.set("c", 1.0);
        assert_eq!(eval(&rhs, &env), Ok(Value::Scalar(-5.0 + 30.0)));
        // The same tokens as a Leibniz row, but on the right of the `=`: still
        // arithmetic — `d*x/d*t`, left to right, which is `x t`. Reading it as
        // a derivative would need a symbolic derivative rather than a notation.
        let q = match parse_row("y' = dx/dt").stmt {
            Stmt::Ode { rhs, .. } => rhs,
            other => panic!("{:?}", other),
        };
        assert_eq!(eval(&q, &env), Ok(Value::Scalar(3.0 * 4.0)));
    }

    /// Without an `=` the text is a plot row, and a plot row is an expression.
    #[test]
    fn a_bare_leibniz_quotient_is_not_a_row() {
        assert!(matches!(parse_row("dx/dt").stmt, Stmt::Expr(_)));
        assert_eq!(parse_row("dx/dt").indep, None);
    }

    /// A slip of the pen gets told what is wrong with it, rather than being
    /// left to the document layer's "this is not a supported row".
    #[test]
    fn mismatched_orders_are_reported_by_name() {
        let r = parse_row("d2x/dt = -x");
        assert_eq!(r.errors.len(), 1, "{:?}", r.errors);
        assert!(r.errors[0].msg.contains("d2x/dt"), "{:?}", r.errors[0]);
    }

    /// Nothing about this notation is allowed to disturb the shapes the format
    /// already reads.
    #[test]
    fn the_leibniz_shape_does_not_swallow_other_rows() {
        assert!(matches!(parse_row("d(0) = 1").stmt, Stmt::Equation { .. }));
        assert!(matches!(parse_row("d x/d t + 1 = 0").stmt, Stmt::Equation { .. }));
        // The numerator has to be a single name: `d(x+y)/dt` is not this.
        assert!(matches!(parse_row("d(x + y)/dt = 1").stmt, Stmt::Equation { .. }));
    }

    #[test]
    fn dependencies_exclude_bound_parameters() {
        let (s, _) = parse("f(x) = a x + b");
        let d = s.deps();
        assert!(d.contains("a") && d.contains("b"));
        assert!(!d.contains("x"));
    }
}
