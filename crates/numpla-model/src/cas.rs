//! The compute pane: `simplify`, `diff`, `expand`, `eval` over a document.
//!
//! `numpla-cas` does the algebra and knows nothing about documents. This module
//! is the other half: it decides what an expression *typed into a document*
//! means before the algebra starts, and it is where three product decisions
//! live.
//!
//! 1. **The document's functions are in scope.** A pane that could not
//!    differentiate `f(x)` after you wrote `f(u) = u^2` two rows up would be a
//!    calculator that happens to share a window with your work. So the source is
//!    parsed with the document's function names (the same two-pass rule
//!    `set_source` uses — see [`crate::document::compile`]) and those calls are
//!    inlined before the CAS sees them.
//! 2. **Parameters keep their names everywhere except `eval`.** `simplify(k*x)`
//!    answers about the expression you typed, not about today's slider position;
//!    `eval(k*x)` is the one that asks for a number and therefore reads the
//!    document's values. Folding `k` into `3` in the first case would quietly
//!    destroy the thing you were manipulating.
//! 3. **Unfinished is not wrong.** A half-typed expression comes back
//!    `pending`, which is the gray-not-red rule at the API level; the shell
//!    mutes it instead of turning it red, exactly as it does for a row.

use serde::Serialize;

use numpla_cas::{diff_with_steps, expand_with_steps, inline_user_functions, simplify, to_source};
use numpla_expr::{parse_with, Expr, FuncNames, Stmt, Value};

use crate::document::{self, Document};

/// One answer from the compute pane.
///
/// `output` is **Numpla source**: it parses, and pasting it back into the
/// document is the point of the whole feature. Every string in `steps` is too.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CasReply {
    pub ok: bool,
    /// Echoed back, so an answer arriving out of order can be matched to what
    /// was asked. The shell sends one of these per keystroke.
    pub input: String,
    /// Numpla source. Empty when `ok` is false.
    pub output: String,
    /// The working, when there is any worth showing. Omitted otherwise —
    /// inventing a step that was not taken would misrepresent what ran.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<Vec<CasStep>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The expression is not finished yet, so there is nothing wrong with it.
    ///
    /// Omitted unless true, which keeps this a backwards-compatible field for
    /// any shell that only reads `ok` and `error`. It exists because the
    /// alternative is for the UI to recognise the *sentence* in `error`, and a
    /// UI that string-matches an error message is a UI that turns red the day
    /// someone rewords it.
    #[serde(skip_serializing_if = "is_false")]
    pub pending: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// One line of working: what was done, and what it produced.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CasStep {
    /// Imperative and short — "differentiate", "distribute", "simplify".
    pub rule: String,
    /// Numpla source for the expression at that point.
    pub expr: String,
}

impl CasReply {
    fn answer(input: &str, output: Expr, steps: Vec<CasStep>) -> CasReply {
        CasReply {
            ok: true,
            input: input.to_string(),
            output: to_source(&output),
            steps: if steps.is_empty() { None } else { Some(steps) },
            error: None,
            pending: false,
        }
    }

    fn failed(input: &str, message: impl Into<String>) -> CasReply {
        CasReply {
            ok: false,
            input: input.to_string(),
            output: String::new(),
            steps: None,
            error: Some(message.into()),
            pending: false,
        }
    }

    fn waiting(input: &str, message: impl Into<String>) -> CasReply {
        CasReply { pending: true, ..CasReply::failed(input, message) }
    }
}

/// Simplify, with the document's functions inlined.
pub fn simplify_expr(doc: &Document, src: &str) -> CasReply {
    match read(doc, src) {
        Err(reply) => reply,
        // No steps: `simplify` reaches its answer by rewriting the whole tree
        // at once rather than by applying one named law after another, and
        // narrating laws it did not apply in that order would be fiction.
        Ok(e) => CasReply::answer(src, simplify(&e), Vec::new()),
    }
}

/// Differentiate with respect to `var`.
pub fn diff_expr(doc: &Document, src: &str, var: &str) -> CasReply {
    let var = var.trim();
    if var.is_empty() {
        return CasReply::failed(src, "name the variable to differentiate with respect to");
    }
    let e = match read(doc, src) {
        Err(reply) => return reply,
        Ok(e) => e,
    };
    match diff_with_steps(&e, var) {
        Ok((raw, done)) => {
            // The unsimplified derivative is only worth a line when it differs
            // from the answer — for `diff(x, x)` it would just say `1` twice.
            let raw_src = to_source(&raw);
            let mut steps = Vec::new();
            if raw_src != to_source(&done) {
                steps.push(CasStep { rule: format!("differentiate by {}", var), expr: raw_src });
                steps.push(CasStep { rule: "simplify".into(), expr: to_source(&done) });
            }
            CasReply::answer(src, done, steps)
        }
        Err(numpla_cas::CasError::Incomplete) => {
            CasReply::waiting(src, "the expression is not finished yet")
        }
        Err(e) => CasReply::failed(src, e.to_string()),
    }
}

/// Multiply out products over sums.
pub fn expand_expr(doc: &Document, src: &str) -> CasReply {
    let e = match read(doc, src) {
        Err(reply) => return reply,
        Ok(e) => e,
    };
    let (distributed, collected) = expand_with_steps(&e);
    let distributed_src = to_source(&distributed);
    let mut steps = Vec::new();
    if distributed_src != to_source(&collected) {
        steps.push(CasStep { rule: "distribute".into(), expr: distributed_src });
        steps.push(CasStep { rule: "collect".into(), expr: to_source(&collected) });
    }
    CasReply::answer(src, collected, steps)
}

/// Evaluate numerically, using the document's parameter values.
///
/// "Numeric where possible" is doing the work in that sentence. An expression
/// that still reads a name nothing has given a value — a state variable, say,
/// which only has values *along a solution* — cannot become a number, and the
/// useful answer then is the simplified expression plus a line saying which
/// name is missing. Reporting that as an error would be telling someone their
/// perfectly good expression is broken because it is general.
pub fn eval_expr(doc: &Document, src: &str) -> CasReply {
    let e = match read(doc, src) {
        Err(reply) => return reply,
        Ok(e) => e,
    };
    let reduced = simplify(&e);
    match numpla_expr::eval(&reduced, &doc.env) {
        Ok(Value::Scalar(x)) => CasReply::answer(src, Expr::Num(x), working(&e, &reduced)),
        Ok(Value::List(xs)) => CasReply::answer(
            src,
            Expr::List(xs.into_iter().map(Expr::Num).collect()),
            working(&e, &reduced),
        ),
        // Pending propagates: a `x'` with no solver behind it is not an error.
        Ok(Value::Unevaluated) => {
            CasReply::waiting(src, "that expression has no value yet")
        }
        Err(numpla_expr::EvalError::Undefined(name)) => {
            // Get as close to a number as the document allows: every name that
            // *does* have a value is put in, so `k*x` with `k = 3` comes back
            // as `3x` rather than retreating all the way to the symbolic form.
            // "Numeric where possible" has to mean partly numeric too.
            let partial = simplify(&with_document_values(&reduced, doc));
            // One line, not two: the note already carries the expression, and
            // repeating it under a second heading would be padding.
            let steps = vec![CasStep {
                rule: format!("{} has no value in this document, so this stays symbolic", name),
                expr: to_source(&partial),
            }];
            CasReply::answer(src, partial, steps)
        }
        Err(other) => CasReply::failed(src, document::describe(&other)),
    }
}

/// Substitute every name the document has given a value.
///
/// Only reached when something *else* has no value: this is the difference
/// between "cannot be a number" and "cannot be a number yet", and showing the
/// half that is known is far more use than showing neither.
fn with_document_values(e: &Expr, doc: &Document) -> Expr {
    let mut out = e.clone();
    for name in e.deps() {
        let literal = match doc.env.vars.get(&name) {
            Some(Value::Scalar(x)) => Expr::Num(*x),
            Some(Value::List(xs)) => Expr::List(xs.iter().copied().map(Expr::Num).collect()),
            _ => continue,
        };
        out = numpla_cas::subs(&out, &name, &literal);
    }
    out
}

/// The simplification line, when simplifying actually changed anything.
fn working(input: &Expr, reduced: &Expr) -> Vec<CasStep> {
    let before = to_source(input);
    let after = to_source(reduced);
    if before == after {
        Vec::new()
    } else {
        vec![CasStep { rule: "simplify".into(), expr: after }]
    }
}

/// Parse one line of compute-pane input into an expression the CAS can work on.
///
/// Everything that can go wrong with the *input* rather than with the algebra
/// is decided here, so the four entry points above are about their own verb.
fn read(doc: &Document, src: &str) -> Result<Expr, CasReply> {
    if src.trim().is_empty() {
        return Err(CasReply::waiting(src, "type an expression"));
    }
    // Same function set the document itself was compiled with, so `f(u)` means
    // in the pane what it means in the rows above it.
    let funcs: FuncNames = doc.env.funcs.keys().cloned().collect();
    let (stmt, errs) = parse_with(src, &funcs);
    if let Some(first) = errs.first() {
        return Err(CasReply::waiting(src, first.msg.clone()));
    }
    match stmt {
        Stmt::Expr(e) if e.has_hole() => {
            Err(CasReply::waiting(src, "the expression is not finished yet"))
        }
        Stmt::Expr(e) => Ok(inline_user_functions(&e, &doc.env.funcs)),
        // `=` makes it a row, and rows belong in the document where they can be
        // solved. Saying so beats silently computing with one side of it.
        _ => Err(CasReply::failed(
            src,
            "the compute pane takes an expression, not a row — drop the `=`",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(src: &str) -> Document {
        document::compile(src)
    }

    fn empty() -> Document {
        Document::default()
    }

    #[test]
    fn the_four_verbs() {
        let d = empty();
        assert_eq!(simplify_expr(&d, "2x + 3x").output, "5x");
        assert_eq!(diff_expr(&d, "x^3", "x").output, "3x^2");
        assert_eq!(expand_expr(&d, "(x + 1)^2").output, "x^2 + 2x + 1");
        assert_eq!(eval_expr(&d, "2 + 3*4").output, "14");
    }

    #[test]
    fn the_documents_functions_are_in_scope() {
        let d = doc("f(u) = u^2 + 1");
        assert_eq!(simplify_expr(&d, "f(x)").output, "x^2 + 1");
        assert_eq!(diff_expr(&d, "f(x)", "x").output, "2x");
    }

    /// A parameter keeps its name under `simplify` and becomes a number under
    /// `eval`. Both are deliberate; see the module docs.
    #[test]
    fn parameters_are_symbolic_until_you_ask_for_a_number() {
        let d = doc("k = 3");
        assert_eq!(simplify_expr(&d, "k*x + k*x").output, "2k * x");
        assert_eq!(eval_expr(&d, "k^2").output, "9");
    }

    /// Partly numeric beats not numeric: `k` is known, `x` is not, and the
    /// answer says as much as the document can.
    #[test]
    fn eval_puts_in_the_values_it_has() {
        let d = doc("k = 3");
        let reply = eval_expr(&d, "k*x + k*x");
        assert!(reply.ok, "{:?}", reply);
        assert_eq!(reply.output, "6x");
    }

    #[test]
    fn an_expression_with_no_value_stays_symbolic_rather_than_failing() {
        let d = empty();
        let reply = eval_expr(&d, "x + x");
        assert!(reply.ok, "{:?}", reply);
        assert_eq!(reply.output, "2x");
        assert!(reply.steps.unwrap().iter().any(|s| s.rule.contains("x has no value")));
    }

    #[test]
    fn unfinished_input_is_pending_not_an_error() {
        let d = empty();
        for src in ["", "1 +", "sin("] {
            let reply = simplify_expr(&d, src);
            assert!(!reply.ok && reply.pending, "{}: {:?}", src, reply);
        }
    }

    #[test]
    fn a_row_is_not_an_expression() {
        let d = empty();
        let reply = simplify_expr(&d, "x' = -y");
        assert!(!reply.ok && !reply.pending);
        assert!(reply.error.unwrap().contains("not a row"));
    }

    #[test]
    fn a_refusal_says_what_it_refused() {
        let d = empty();
        let reply = diff_expr(&d, "smooth(t)", "t");
        assert!(!reply.ok && !reply.pending);
        assert!(reply.error.unwrap().contains("noise"));
    }

    /// Every string that crosses the boundary has to be Numpla source, steps
    /// included — otherwise a step is something you can read but not use.
    #[test]
    fn every_string_in_a_reply_parses() {
        let d = doc("f(u) = u^2\nk = 3");
        let replies = [
            simplify_expr(&d, "2x + 3x + f(x)"),
            diff_expr(&d, "sin(x)*f(x)", "x"),
            expand_expr(&d, "(x + 1)^3"),
            eval_expr(&d, "k*x"),
        ];
        for reply in replies {
            assert!(reply.ok, "{:?}", reply);
            let mut sources = vec![reply.output.clone()];
            sources.extend(reply.steps.iter().flatten().map(|s| s.expr.clone()));
            for src in sources {
                let (stmt, errs) = numpla_expr::parse(&src);
                assert!(errs.is_empty(), "`{}`: {:?}", src, errs);
                assert!(matches!(stmt, Stmt::Expr(_)), "`{}` is not an expression", src);
            }
        }
    }
}

