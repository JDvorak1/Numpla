//! The expression tree every other crate walks.

use std::collections::BTreeSet;

use crate::lexer::FUNCS;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Pow,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Num(f64),
    Var(String),
    /// `x'`, `x''` — a derivative referenced inside an expression.
    Deriv { name: String, order: u8 },
    /// `f(a, b)`. Resolved at eval time: a builtin, a user function, or —
    /// when `name` is a plain variable with one argument — implicit
    /// multiplication, which is what `2(x+1)`-style notation demands.
    Call { name: String, args: Vec<Expr> },
    Neg(Box<Expr>),
    Bin {
        op: BinOp,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    List(Vec<Expr>),
    /// Incomplete input. Never an error — it evaluates to `Unevaluated`, which
    /// is what makes half-typed rows go gray instead of red.
    Hole,
}

/// One row of the expression list.
#[derive(Debug, Clone, PartialEq)]
pub enum Stmt {
    /// `k = 3`, `f(x) = x^2`
    Assign {
        name: String,
        params: Vec<String>,
        rhs: Expr,
    },
    /// `x' = -y`, `x'' = -x`
    Ode {
        name: String,
        order: u8,
        rhs: Expr,
    },
    /// `x^2 + y^2 = 1` — an implicit curve, not an assignment.
    Equation { lhs: Expr, rhs: Expr },
    /// A bare expression: plot it.
    Expr(Expr),
}

impl Expr {
    /// Names this expression reads. Drives recompute order and the
    /// hover-to-highlight dependency view.
    pub fn deps(&self) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        self.collect_deps(&mut out);
        out
    }

    fn collect_deps(&self, out: &mut BTreeSet<String>) {
        match self {
            Expr::Num(_) | Expr::Hole => {}
            Expr::Var(n) => {
                out.insert(n.clone());
            }
            Expr::Deriv { name, .. } => {
                out.insert(name.clone());
            }
            Expr::Call { name, args } => {
                if !FUNCS.contains(&name.as_str()) {
                    out.insert(name.clone());
                }
                for a in args {
                    a.collect_deps(out);
                }
            }
            Expr::Neg(a) => a.collect_deps(out),
            Expr::Bin { lhs, rhs, .. } => {
                lhs.collect_deps(out);
                rhs.collect_deps(out);
            }
            Expr::List(items) => {
                for it in items {
                    it.collect_deps(out);
                }
            }
        }
    }

    /// True if any part of the tree is still incomplete.
    pub fn has_hole(&self) -> bool {
        match self {
            Expr::Hole => true,
            Expr::Num(_) | Expr::Var(_) | Expr::Deriv { .. } => false,
            Expr::Call { args, .. } => args.iter().any(|a| a.has_hole()),
            Expr::Neg(a) => a.has_hole(),
            Expr::Bin { lhs, rhs, .. } => lhs.has_hole() || rhs.has_hole(),
            Expr::List(items) => items.iter().any(|i| i.has_hole()),
        }
    }
}

impl Stmt {
    /// The name this row defines, if any.
    pub fn defines(&self) -> Option<&str> {
        match self {
            Stmt::Assign { name, .. } => Some(name),
            Stmt::Ode { name, .. } => Some(name),
            _ => None,
        }
    }

    pub fn deps(&self) -> BTreeSet<String> {
        match self {
            Stmt::Assign { params, rhs, .. } => {
                let mut d = rhs.deps();
                for p in params {
                    d.remove(p);
                }
                d
            }
            Stmt::Ode { rhs, .. } => rhs.deps(),
            Stmt::Equation { lhs, rhs } => {
                let mut d = lhs.deps();
                d.extend(rhs.deps());
                d
            }
            Stmt::Expr(e) => e.deps(),
        }
    }
}
