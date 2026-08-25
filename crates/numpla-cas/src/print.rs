//! AST back to Numpla source.
//!
//! Everything the CAS returns crosses the boundary as *text a person can paste
//! back into their document*, so this printer is part of the contract rather
//! than a debugging convenience: if `parse(to_source(e))` is not `e`, the
//! compute pane hands out expressions that mean something other than they say.
//! Two rules follow from that, and they are why this file is fussier than a
//! pretty-printer needs to be:
//!
//! 1. **Parenthesise from the parser's own table, not from memory.** The
//!    constants below mirror the binding powers in `numpla_expr::parser`. The
//!    three that catch people out are all here: prefix `-` binds *tighter* than
//!    `*` and looser than `^` (so `-x*y` is `(-x)*y` but `-x^2` is `-(x^2)`),
//!    `^` is right-associative (so a *left* `^` operand always needs brackets),
//!    and implicit multiplication carries multiplication precedence.
//! 2. **Never emit an implicit product that could re-lex as something else.**
//!    Identifiers are single letters, so `s*i*n` written as `sin` becomes a
//!    function call, and `k*(x+1)` written as `k(x+1)` is a call or a product
//!    depending on the rest of the document. So juxtaposition is only ever
//!    emitted after a plain number — `2x`, `2(x+1)`, `2sin(x)` — where no
//!    other reading exists.
//!
//! The round-trip is asserted over the whole corpus in
//! `tests/value_preserving.rs`; this is not a property that survives on care.

use numpla_expr::{BinOp, Expr};

// Mirrors `numpla_expr::parser`: BP_ADD (1,2), BP_MUL (3,4), BP_NEG 5,
// BP_POW (8,7). Only the ordering matters here, so these are renumbered to be
// contiguous.
const P_ADD: u8 = 1;
const P_MUL: u8 = 2;
const P_NEG: u8 = 3;
const P_POW: u8 = 4;
const P_ATOM: u8 = 5;

/// Numpla source for `e`.
///
/// The one input this cannot honour is [`Expr::Hole`] — half-typed input has no
/// source form — and it deliberately emits `?`, which fails to parse, rather
/// than inventing a value. Callers reject incomplete expressions before they
/// get here; see `numpla_model::cas`.
pub fn to_source(e: &Expr) -> String {
    let mut s = String::new();
    write_at(e, 0, &mut s);
    s
}

fn prec(e: &Expr) -> u8 {
    match e {
        // A negative literal prints with a leading `-`, so it must bracket
        // exactly like a `Neg` node: `(-2)^3`, never `-2^3`.
        Expr::Num(n) => {
            if n.is_nan() || !n.is_sign_negative() {
                P_ATOM
            } else {
                P_NEG
            }
        }
        Expr::Var(_) | Expr::Deriv { .. } | Expr::Call { .. } | Expr::List(_) | Expr::Hole => P_ATOM,
        Expr::Neg(_) => P_NEG,
        Expr::Bin { op, .. } => match op {
            BinOp::Add | BinOp::Sub => P_ADD,
            BinOp::Mul | BinOp::Div => P_MUL,
            BinOp::Pow => P_POW,
        },
    }
}

/// Write `e`, bracketing it if it binds more loosely than `min`.
fn write_at(e: &Expr, min: u8, out: &mut String) {
    let bracket = prec(e) < min;
    if bracket {
        out.push('(');
    }
    write_bare(e, out);
    if bracket {
        out.push(')');
    }
}

fn write_bare(e: &Expr, out: &mut String) {
    match e {
        Expr::Num(n) => out.push_str(&number(*n)),
        Expr::Var(name) => out.push_str(name),
        Expr::Deriv { name, order } => {
            out.push_str(name);
            for _ in 0..*order {
                out.push('\'');
            }
        }
        Expr::Call { name, args } => {
            out.push_str(name);
            out.push('(');
            for (i, a) in args.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write_at(a, 0, out);
            }
            out.push(')');
        }
        Expr::List(items) => {
            out.push('[');
            for (i, a) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write_at(a, 0, out);
            }
            out.push(']');
        }
        Expr::Neg(a) => {
            out.push('-');
            write_at(a, P_NEG, out);
        }
        Expr::Bin { op, lhs, rhs } => write_bin(*op, lhs, rhs, out),
        // Not source. Loud beats plausible: `?` fails to parse, which is what
        // an incomplete expression should do if one ever reaches the printer.
        Expr::Hole => out.push('?'),
    }
}

fn write_bin(op: BinOp, lhs: &Expr, rhs: &Expr, out: &mut String) {
    match op {
        // `+ - * /` are left-associative, so the *right* operand needs brackets
        // at equal precedence: `a - (b - c)` is not `a - b - c`.
        BinOp::Add | BinOp::Sub => {
            write_at(lhs, P_ADD, out);
            // `a + -b` and `a - -b` are legal but nobody writes them, and the
            // sign is the one thing a reader must not have to re-derive.
            let (negative, core) = strip_sign(rhs);
            out.push_str(if (op == BinOp::Sub) != negative { " - " } else { " + " });
            write_at(&core, P_ADD + 1, out);
        }
        BinOp::Mul => {
            // Both sides are rendered once and the join is decided from the
            // text, not from the tree — see `joins_safely`.
            let mut left = String::new();
            write_at(lhs, P_MUL, &mut left);
            let mut right = String::new();
            write_at(rhs, P_MUL + 1, &mut right);
            out.push_str(&left);
            if !joins_safely(lhs, &left, &right) {
                out.push_str(" * ");
            }
            out.push_str(&right);
        }
        BinOp::Div => {
            write_at(lhs, P_MUL, out);
            out.push('/');
            write_at(rhs, P_MUL + 1, out);
        }
        // Right-associative: `x^y^z` is `x^(y^z)`, so the left operand is the
        // one that must be bracketed at equal precedence.
        BinOp::Pow => {
            write_at(lhs, P_POW + 1, out);
            out.push('^');
            write_at(rhs, P_POW, out);
        }
    }
}

/// Peel every leading minus sign off an operand, reporting the parity.
///
/// Folding only *one* level is not enough, and the failure is not cosmetic: a
/// tree with a doubly negated right operand would print as `a - -(1 - k)`,
/// which re-parses and then prints as `a + (1 - k)` — the same value, but a
/// printer that does not agree with itself is a printer whose brackets cannot
/// be trusted either. Found by the random-tree round-trip in
/// `tests/value_preserving.rs`, which is exactly the shape a hand-written case
/// list does not contain.
///
/// Peeling is exact: negation is a sign-bit flip in IEEE arithmetic, so no
/// amount of it changes a value. Signed zero is peeled too — `-0` reads as a
/// negation, and the brackets around `(-0)^2` have to be there for the same
/// reason they do around `(-2)^3`.
fn strip_sign(e: &Expr) -> (bool, Expr) {
    let mut negative = false;
    let mut cur = e.clone();
    loop {
        match cur {
            Expr::Neg(inner) => {
                negative = !negative;
                cur = *inner;
            }
            Expr::Num(n) if n.is_sign_negative() && !n.is_nan() => {
                negative = !negative;
                // `-n` is non-negative, so there is nothing left to peel.
                cur = Expr::Num(-n);
                break;
            }
            _ => break,
        }
    }
    (negative, cur)
}

/// May this product be written as juxtaposition?
///
/// Two conditions, and the second is checked against the **text** rather than
/// against the tree, because "these two pieces of source can be written next to
/// each other" is a fact about characters:
///
/// 1. The left factor is a number, possibly negated — `2x` and `-2x` are
///    coefficients, `x y` is two names that would re-lex as one (`s*i*n` would
///    become `sin`), and `k (x+1)` would re-lex as a call.
/// 2. The emitted left ends in a digit and the emitted right starts with a
///    letter or a bracket. That is what rules out `2 * 3` becoming `23`,
///    `2 * -x` becoming `2-x`, and `2 * 3^x` becoming `23^x`.
///
/// The text check is not belt-and-braces: `--1` is a negated negated literal,
/// and a structural test that only peels one layer would print `--1min(x, 2)`
/// once and `--1 * min(x, 2)` on the way back — a printer that disagrees with
/// itself. Found by the random-tree round-trip in `tests/value_preserving.rs`.
fn joins_safely(lhs: &Expr, left: &str, right: &str) -> bool {
    let (_, core) = strip_sign(lhs);
    if !matches!(core, Expr::Num(n) if n.is_finite()) {
        return false;
    }
    left.chars().next_back().is_some_and(|c| c.is_ascii_digit())
        && right.chars().next().is_some_and(|c| c.is_alphabetic() || c == '(')
}

/// A float as source the lexer will read back as the same float.
///
/// Rust's `Display` for `f64` prints the shortest decimal that round-trips and
/// never uses exponent notation, which is exactly what is needed here: the
/// lexer has no `1e-9` form, and `1e-9` would come back as `1 * e - 9`.
fn number(n: f64) -> String {
    if n.is_nan() {
        // `nan` is not a Numpla constant, and printing something that parses to
        // a *number* would be a lie. `0/0` evaluates to NaN, so this
        // round-trips by value.
        "(0/0)".to_string()
    } else if n.is_infinite() {
        // `inf` is a Numpla constant; `-inf` is its negation.
        if n < 0.0 {
            "-inf".to_string()
        } else {
            "inf".to_string()
        }
    } else {
        format!("{}", n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use numpla_expr::{parse, Stmt};

    fn e(src: &str) -> Expr {
        match parse(src).0 {
            Stmt::Expr(x) => x,
            other => panic!("not an expression: {:?}", other),
        }
    }

    /// Printing then re-parsing must give the same tree, not merely the same
    /// value: the whole point is that the text says what the tree says.
    fn round_trips(src: &str) -> String {
        let tree = e(src);
        let text = to_source(&tree);
        assert_eq!(e(&text), tree, "{} printed as {}", src, text);
        text
    }

    #[test]
    fn precedence_is_only_bracketed_where_it_has_to_be() {
        assert_eq!(round_trips("(x + 1) * 2"), "(x + 1) * 2");
        assert_eq!(round_trips("x + 1 * 2"), "x + 1 * 2");
        assert_eq!(round_trips("x*y + 1"), "x * y + 1");
    }

    /// The three that are easy to get wrong, pinned one at a time.
    #[test]
    fn unary_minus_binds_tighter_than_times_and_looser_than_power() {
        assert_eq!(round_trips("-x*y"), "-x * y");
        assert_eq!(round_trips("-(x*y)"), "-(x * y)");
        assert_eq!(round_trips("-x^2"), "-x^2");
        assert_eq!(round_trips("(-x)^2"), "(-x)^2");
    }

    #[test]
    fn power_is_right_associative() {
        assert_eq!(round_trips("2^3^2"), "2^3^2");
        assert_eq!(round_trips("(2^3)^2"), "(2^3)^2");
    }

    #[test]
    fn subtraction_and_division_keep_their_right_operand_bracketed() {
        assert_eq!(round_trips("a - (b - c)"), "a - (b - c)");
        assert_eq!(round_trips("a/(b*c)"), "a/(b * c)");
        assert_eq!(round_trips("a/b/c"), "a/b/c");
    }

    #[test]
    fn a_negative_literal_brackets_like_a_negation() {
        let tree = Expr::Bin {
            op: BinOp::Pow,
            lhs: Box::new(Expr::Num(-2.0)),
            rhs: Box::new(Expr::Num(3.0)),
        };
        assert_eq!(to_source(&tree), "(-2)^3");
        // The lexer has no negative literal, so this comes back as a negation
        // of 2 rather than as `Num(-2)` — the same value, and the same
        // brackets, which is what the round-trip has to guarantee. Without
        // them it would read as `-(2^3)`.
        assert_eq!(to_source(&e("(-2)^3")), "(-2)^3");
    }

    #[test]
    fn implicit_products_only_after_a_number() {
        assert_eq!(round_trips("2x"), "2x");
        assert_eq!(round_trips("2(x + 1)"), "2(x + 1)");
        assert_eq!(round_trips("2sin(x)"), "2sin(x)");
        // ...and never between two names, which would re-lex as one name.
        let tree = Expr::Bin {
            op: BinOp::Mul,
            lhs: Box::new(Expr::Var("s".into())),
            rhs: Box::new(Expr::Bin {
                op: BinOp::Mul,
                lhs: Box::new(Expr::Var("i".into())),
                rhs: Box::new(Expr::Var("n".into())),
            }),
        };
        assert_eq!(to_source(&tree), "s * (i * n)");
    }

    #[test]
    fn a_plus_of_a_negative_prints_as_a_minus() {
        assert_eq!(
            to_source(&Expr::Bin {
                op: BinOp::Add,
                lhs: Box::new(Expr::Var("x".into())),
                rhs: Box::new(Expr::Num(-3.0)),
            }),
            "x - 3"
        );
        assert_eq!(
            to_source(&Expr::Bin {
                op: BinOp::Sub,
                lhs: Box::new(Expr::Var("x".into())),
                rhs: Box::new(Expr::Neg(Box::new(Expr::Var("y".into())))),
            }),
            "x + y"
        );
    }

    #[test]
    fn numbers_never_print_in_exponent_form() {
        // `1e-9` would come back as `1 * e - 9`.
        assert_eq!(number(1e-9), "0.000000001");
        assert_eq!(number(f64::INFINITY), "inf");
        assert_eq!(number(0.1 + 0.2), "0.30000000000000004");
    }

    #[test]
    fn calls_lists_and_primes() {
        assert_eq!(round_trips("min(x, 2)"), "min(x, 2)");
        assert_eq!(round_trips("[1, 2, x]"), "[1, 2, x]");
        assert_eq!(round_trips("x''"), "x''");
        assert_eq!(round_trips("sin x"), "sin(x)");
    }
}
