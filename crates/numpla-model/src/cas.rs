//! The compute pane: a worksheet of commands over a document.
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
//!
//! A fourth arrived with `solve`, `equal` and the series verbs, and it is about
//! shape rather than scope: **a result that is not one expression does not get
//! flattened into one.** A solution set can be empty, or two roots, or "every
//! value"; an `equal` list is a set of labelled choices. Both get their own
//! reply type, because the alternative is a pane that parses `output` back out
//! of a string — and a UI that string-matches a result breaks the day somebody
//! rewords it.
//!
//! [`command`] is the entry point a worksheet actually uses: it takes the line
//! as typed, substitutes `%`, and dispatches. Doing that here rather than in the
//! shell is what keeps one answer to "what does `sum(e, k, a, b)` mean".

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

/// Why one line of input never reached the algebra.
///
/// Split out from [`CasReply`] because the same rejection has to be able to
/// become any of the three reply shapes: `solve` and `equal` reject a
/// half-typed expression for exactly the same reasons `simplify` does, and
/// three copies of that decision would be three chances to get `pending` wrong.
struct Rejected {
    message: String,
    pending: bool,
}

impl Rejected {
    fn pending(message: impl Into<String>) -> Rejected {
        Rejected { message: message.into(), pending: true }
    }
    fn refused(message: impl Into<String>) -> Rejected {
        Rejected { message: message.into(), pending: false }
    }
}

impl CasReply {
    fn rejected(input: &str, r: Rejected) -> CasReply {
        CasReply { pending: r.pending, ..CasReply::failed(input, r.message) }
    }

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
        Err(r) => CasReply::rejected(src, r),
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
        Err(r) => return CasReply::rejected(src, r),
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
        Err(r) => return CasReply::rejected(src, r),
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

/// The best exact form the CAS can reach, with the document's values in it.
///
/// `eval` and `evalf` are two different questions, and this is the first one.
/// `sqrt(2)` is *already* the best exact form of itself: replacing it with
/// `1.4142135623730951` throws away the only exact spelling the document can
/// hold, and does it silently. So `eval` substitutes every value the document
/// has, simplifies, and stops — reaching a plain number only when the
/// expression really is one. [`evalf_expr`] is the verb that always answers
/// with a number.
///
/// An expression that still reads a name nothing has given a value — a state
/// variable, say, which only has values *along a solution* — is **not** an
/// error. The useful answer is the simplified expression plus a line saying
/// which name is missing; reporting it as an error would be telling somebody
/// their perfectly good expression is broken because it is general.
pub fn eval_expr(doc: &Document, src: &str) -> CasReply {
    let e = match read(doc, src) {
        Err(r) => return CasReply::rejected(src, r),
        Ok(e) => e,
    };
    let reduced = simplify(&with_document_values(&e, doc));
    // Pending propagates: an `x'` with no solver behind it is not an error.
    if matches!(numpla_expr::eval(&reduced, &doc.env), Ok(Value::Unevaluated)) {
        return CasReply::waiting(src, "that expression has no value yet");
    }
    let mut steps = working(&e, &reduced);
    if let Some(name) = first_unvalued(&reduced, doc) {
        // One line, not two: the note already carries the expression, and
        // repeating it under a second heading would be padding.
        steps = vec![CasStep {
            rule: format!("{} has no value in this document, so this stays symbolic", name),
            expr: to_source(&reduced),
        }];
    }
    CasReply::answer(src, reduced, steps)
}

/// The first name in `e` that nothing has given a value to.
///
/// The built-in constants are not among them: the evaluator has values for
/// those, and naming one as "missing" would be describing a constant as a hole.
fn first_unvalued(e: &Expr, doc: &Document) -> Option<String> {
    e.deps().into_iter().find(|name| {
        !matches!(name.as_str(), "pi" | "tau" | "e" | "inf")
            && !doc.env.vars.contains_key(name)
            && !doc.env.funcs.contains_key(name)
    })
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
fn read(doc: &Document, src: &str) -> Result<Expr, Rejected> {
    match read_statement(doc, src)? {
        Stmt::Expr(e) if e.has_hole() => {
            Err(Rejected::pending("the expression is not finished yet"))
        }
        Stmt::Expr(e) => Ok(inline_user_functions(&e, &doc.env.funcs)),
        // `=` makes it an equation, and most verbs take an expression. `solve`
        // and `subs` are the two that want the other side, and they use
        // `read_equation` instead of this.
        _ => Err(Rejected::refused(
            "the compute pane takes an expression, not a row — drop the `=`, or use `solve`",
        )),
    }
}

/// One line as an equation: both sides, with the document's functions inlined.
///
/// The parser turns `x^2 = 1`, `x = 1` and `sin(x) = 0` into three different
/// statements — it cannot tell a definition from an equation without knowing
/// which names are functions — so the untangling lives in `numpla-cas`, where
/// the solver and its tests already share one answer.
fn read_equation(doc: &Document, src: &str) -> Result<(Expr, Expr), Rejected> {
    let stmt = read_statement(doc, src)?;
    let Some((lhs, rhs)) = numpla_cas::solve::equation_of(&stmt) else {
        return Err(Rejected::refused(
            "a primed row like `x' = -y` is an ODE and belongs in the document, where it can be integrated",
        ));
    };
    if lhs.has_hole() || rhs.has_hole() {
        return Err(Rejected::pending("the equation is not finished yet"));
    }
    Ok((
        inline_user_functions(&lhs, &doc.env.funcs),
        inline_user_functions(&rhs, &doc.env.funcs),
    ))
}

fn read_statement(doc: &Document, src: &str) -> Result<Stmt, Rejected> {
    if src.trim().is_empty() {
        return Err(Rejected::pending("type an expression"));
    }
    // Same function set the document itself was compiled with, so `f(u)` means
    // in the pane what it means in the rows above it.
    let funcs: FuncNames = doc.env.funcs.keys().cloned().collect();
    let (stmt, errs) = parse_with(src, &funcs);
    match errs.first() {
        Some(first) => Err(Rejected::pending(first.msg.clone())),
        None => Ok(stmt),
    }
}

// ---- solve ---------------------------------------------------------------

/// The answer to `solve(equation, var)`.
///
/// A separate shape from [`CasReply`] because a solution *set* is not one
/// expression: it can be empty, it can be two, and it can be "every value".
/// Flattening that into a single `output` string would make the pane parse it
/// back out again, and a UI that string-matches a result is a UI that breaks
/// the day the formatting changes.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CasSolveReply {
    pub ok: bool,
    pub input: String,
    /// The unknown that was solved for. Echoed because it may have been chosen
    /// by the CAS when the caller left it out.
    pub variable: String,
    /// Every solution. An empty list with `ok: true` means there are none, and
    /// that is an answer — see `note` for which field it is an answer over.
    pub solutions: Vec<CasSolution>,
    /// `x = x`: every value of the variable works, so the list is not the
    /// answer and must not be rendered as one.
    #[serde(skip_serializing_if = "is_false")]
    pub every_value: bool,
    /// How the answer was reached: "linear", "quadratic formula", "rational
    /// roots, then the remaining factor".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    /// What the answer assumes, when it assumes anything — "assuming a is not
    /// zero". Show it; an assumption the reader cannot see is one they cannot
    /// check.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub pending: bool,
}

/// One root, and the result of putting it back.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CasSolution {
    /// Numpla source. Paste it, plot it, feed it back in.
    pub expr: String,
    /// `"exact"` when substituting it and simplifying gives literally zero,
    /// `"numeric"` when it vanishes to within rounding — which is the usual
    /// outcome for a root with a radical in it, because cancelling `sqrt(u)^2`
    /// is a rewrite this CAS refuses to make. Never anything else: a root that
    /// fails the check is a bug, and the tests assert it never happens.
    pub verified: &'static str,
    /// The root as a decimal, when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
}

/// Solve one equation for one unknown.
///
/// `var` may be empty, in which case the equation must have exactly one
/// unknown and that is the one. Two unknowns and no name is a question with no
/// answer, so it comes back as a refusal that lists them rather than as a guess.
pub fn solve_expr(doc: &Document, src: &str, var: &str) -> CasSolveReply {
    let reject = |r: Rejected| CasSolveReply {
        ok: false,
        input: src.to_string(),
        variable: var.to_string(),
        solutions: Vec::new(),
        every_value: false,
        method: None,
        note: None,
        error: Some(r.message),
        pending: r.pending,
    };

    let (lhs, rhs) = match read_equation(doc, src) {
        Ok(pair) => pair,
        Err(r) => return reject(r),
    };
    let var = match chosen_unknown(&lhs, &rhs, var) {
        Ok(v) => v,
        Err(message) => return reject(Rejected::refused(message)),
    };

    match numpla_cas::solve(&lhs, &rhs, &var) {
        Ok(answer) => CasSolveReply {
            ok: true,
            input: src.to_string(),
            solutions: answer
                .roots
                .iter()
                .map(|root| CasSolution {
                    expr: to_source(root),
                    verified: match numpla_cas::check_root(&lhs, &rhs, &var, root) {
                        numpla_cas::RootCheck::Exact => "exact",
                        _ => "numeric",
                    },
                    value: numpla_cas::num::const_value(root),
                })
                .collect(),
            every_value: answer.every_value,
            method: Some(answer.method),
            note: answer.note,
            variable: var,
            error: None,
            pending: false,
        },
        Err(numpla_cas::CasError::Incomplete) => {
            reject(Rejected::pending("the equation is not finished yet"))
        }
        Err(e) => CasSolveReply { variable: var, ..reject(Rejected::refused(e.to_string())) },
    }
}

/// Which name to solve for.
///
/// Asking the caller to always supply one would make `solve(2x = 2)` an error,
/// and that is the exact expression this whole feature exists to answer. So a
/// single unknown is chosen silently and anything else is a question back.
fn chosen_unknown(lhs: &Expr, rhs: &Expr, requested: &str) -> Result<String, String> {
    let requested = requested.trim();
    if !requested.is_empty() {
        return Ok(requested.to_string());
    }
    let names = numpla_cas::unknowns(lhs, rhs);
    match names.len() {
        1 => Ok(names[0].clone()),
        0 => Err("there is no unknown in that equation to solve for".to_string()),
        _ => Err(format!(
            "that equation has more than one unknown ({}), so say which: solve(..., {})",
            names.join(", "),
            names[0]
        )),
    }
}

// ---- equal ---------------------------------------------------------------

/// Every equivalent form, as a list to choose from.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CasFormsReply {
    pub ok: bool,
    pub input: String,
    /// Simplest and most likely first: `simplify`, `expand`, `factor`, then the
    /// structural rewrites, then the number, then anything recognised from it.
    pub forms: Vec<CasForm>,
    /// The value of the input, when it has one. The pane shows it above the
    /// list, because it is the one thing every form has in common.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub pending: bool,
}

/// One way of writing the input.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CasForm {
    /// Numpla source, like every other string this API returns.
    pub expr: String,
    /// How it was obtained: "simplify", "the log of a product", "double angle
    /// for cos", "recognised from the number".
    pub label: String,
    /// One of `"exact"`, `"conditional"`, `"decimal"`, `"identification"`.
    ///
    /// The distinction is the point of the list and the UI must show it.
    /// `exact` is equal wherever the input has a value at all. `conditional` is
    /// equal where `condition` holds and comes with it. `decimal` is the
    /// floating-point value, an approximation. `identification` is a closed form
    /// that *matches the number* to near machine precision and **is not
    /// proved** — the difference between "this equals your expression" and
    /// "this is what your number looks like", which is exactly the difference a
    /// person needs to see before pasting it into a proof.
    pub kind: &'static str,
    /// The condition, as a sentence: "x > 0 and y > 0". Present only for
    /// `kind: "conditional"`, and always present there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    /// What an identification agreed to, and the reminder that it is a match
    /// rather than a derivation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Every equivalent form of `src` the CAS can find.
pub fn equal_forms(doc: &Document, src: &str) -> CasFormsReply {
    let e = match read(doc, src) {
        Ok(e) => e,
        Err(r) => {
            return CasFormsReply {
                ok: false,
                input: src.to_string(),
                forms: Vec::new(),
                value: None,
                error: Some(r.message),
                pending: r.pending,
            }
        }
    };
    let with_values = simplify(&with_document_values(&e, doc));
    CasFormsReply {
        ok: true,
        input: src.to_string(),
        forms: numpla_cas::equal(&e)
            .into_iter()
            .map(|f| CasForm {
                expr: to_source(&f.expr),
                label: f.label,
                kind: f.kind.as_str(),
                condition: f.condition.as_ref().map(numpla_cas::Condition::describe),
                note: f.note,
            })
            .collect(),
        value: numpla_cas::num::const_value(&with_values),
        error: None,
        pending: false,
    }
}

// ---- evalf, factor, subs, sum, product -----------------------------------

/// A number, always — or a sentence saying which name stopped it being one.
///
/// The split from [`eval_expr`] is the whole point of having two verbs. `eval`
/// answers "what is the best exact form of this", and `sqrt(2)` is its own best
/// exact form; `evalf` answers "what number is it", and a CAS that returned
/// `sqrt(2)` to that question would be answering a different one.
pub fn evalf_expr(doc: &Document, src: &str) -> CasReply {
    let e = match read(doc, src) {
        Ok(e) => e,
        Err(r) => return CasReply::rejected(src, r),
    };
    let reduced = simplify(&with_document_values(&e, doc));
    match numpla_expr::eval(&reduced, &doc.env) {
        Ok(Value::Scalar(x)) => CasReply::answer(src, Expr::Num(x), Vec::new()),
        Ok(Value::List(xs)) => CasReply::answer(
            src,
            Expr::List(xs.into_iter().map(Expr::Num).collect()),
            Vec::new(),
        ),
        Ok(Value::Unevaluated) => CasReply::waiting(src, "that expression has no value yet"),
        Err(numpla_expr::EvalError::Undefined(name)) => CasReply::failed(
            src,
            format!(
                "`evalf` has to produce a number, and `{}` has no value in this document. Give it one with a row like `{} = 1`, or ask for `eval` instead and keep it symbolic.",
                name, name
            ),
        ),
        Err(other) => CasReply::failed(src, document::describe(&other)),
    }
}

/// Factor over the rationals.
pub fn factor_expr(doc: &Document, src: &str) -> CasReply {
    match read(doc, src) {
        Err(r) => CasReply::rejected(src, r),
        Ok(e) => {
            let factored = numpla_cas::factor(&e);
            let steps = working(&simplify(&e), &factored);
            CasReply::answer(src, factored, steps)
        }
    }
}

/// `subs(x = 3, e)` — substitute, then simplify.
pub fn subs_expr(doc: &Document, assignment: &str, src: &str) -> CasReply {
    let e = match read(doc, src) {
        Ok(e) => e,
        Err(r) => return CasReply::rejected(src, r),
    };
    let (lhs, rhs) = match read_equation(doc, assignment) {
        Ok(pair) => pair,
        Err(r) => return CasReply::rejected(src, r),
    };
    let Expr::Var(name) = lhs else {
        return CasReply::failed(
            src,
            format!(
                "`subs` replaces a name: write `subs(x = 3, ...)`, not `subs({} = ..., ...)`",
                to_source(&lhs)
            ),
        );
    };
    CasReply::answer(src, numpla_cas::subs(&e, &name, &rhs), Vec::new())
}

/// `sum(e, k, a, b)` and `product(e, k, a, b)`.
///
/// One function for both because everything except the closed-form table is
/// identical, and two copies of the argument handling is two places for the
/// index and the limits to get swapped.
pub fn series_expr(doc: &Document, kind: SeriesKind, args: [&str; 4]) -> CasReply {
    let input = format!(
        "{}({}, {}, {}, {})",
        kind.name(),
        args[0],
        args[1],
        args[2],
        args[3]
    );
    let mut parsed = Vec::new();
    for src in [args[0], args[2], args[3]] {
        match read(doc, src) {
            Ok(e) => parsed.push(e),
            Err(r) => return CasReply::rejected(&input, r),
        }
    }
    let index = args[1].trim();
    if index.is_empty() || index.chars().any(|c| !c.is_alphanumeric() && c != '_') {
        return CasReply::failed(
            &input,
            format!("`{}` is not a name to sum over — the second argument is the index, as in `sum(k, k, 1, n)`", index),
        );
    }
    let closed = match kind {
        SeriesKind::Sum => numpla_cas::sum(&parsed[0], index, &parsed[1], &parsed[2]),
        SeriesKind::Product => numpla_cas::product(&parsed[0], index, &parsed[1], &parsed[2]),
    };
    match closed {
        Ok(c) => {
            let mut steps = vec![CasStep { rule: c.method, expr: to_source(&c.expr) }];
            if let Some(note) = c.note {
                steps.push(CasStep { rule: note, expr: to_source(&c.expr) });
            }
            CasReply::answer(&input, c.expr, steps)
        }
        Err(numpla_cas::CasError::Incomplete) => {
            CasReply::waiting(&input, "the expression is not finished yet")
        }
        Err(e) => CasReply::failed(&input, e.to_string()),
    }
}

/// Which of the two series verbs is being asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeriesKind {
    Sum,
    Product,
}

impl SeriesKind {
    fn name(self) -> &'static str {
        match self {
            SeriesKind::Sum => "sum",
            SeriesKind::Product => "product",
        }
    }
}

// ---- one typed line ------------------------------------------------------

/// The reply to one worksheet line, tagged with the command that produced it.
///
/// A worksheet is *typed*, not clicked — `solve(2x = 2, x)` rather than a button
/// — so something has to turn a line into a call. Doing it here rather than in
/// the shell keeps one parser: the argument splitting, the `%` history and the
/// arity errors are the same in every front end, and the shell cannot drift
/// from the CAS about what `sum(e, k, a, b)` means.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CasCommandReply {
    /// Which verb ran: `"solve"`, `"eval"`, `"equal"`, and so on. The shape of
    /// `reply` follows from this, so switch on it rather than sniffing fields.
    pub command: String,
    /// The line after `%` was substituted, which is what actually ran. Shown in
    /// the worksheet so a row that used `%` still reads as a complete thought
    /// after the history has moved on.
    pub source: String,
    pub reply: CasAnyReply,
}

/// One of the three reply shapes, serialised inline.
///
/// Untagged: the discriminator is `command`, one level up, and repeating it
/// inside would give the shell two things to disagree with each other about.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum CasAnyReply {
    Solve(Box<CasSolveReply>),
    Forms(Box<CasFormsReply>),
    Plain(Box<CasReply>),
}

/// The commands the compute pane understands, with their signatures.
///
/// Published so the shell builds its autocomplete from the implementation
/// rather than from a copy of it — a completion list that offers a verb the CAS
/// does not have is worse than no completion at all.
pub const COMMANDS: &[(&str, &str)] = &[
    ("solve", "solve(equation, var)"),
    ("eval", "eval(e)"),
    ("evalf", "evalf(e)"),
    ("equal", "equal(e)"),
    ("simplify", "simplify(e)"),
    ("expand", "expand(e)"),
    ("factor", "factor(e)"),
    ("diff", "diff(e, x)"),
    ("sum", "sum(e, k, a, b)"),
    ("product", "product(e, k, a, b)"),
    ("subs", "subs(x = 3, e)"),
];

/// Run one line of the worksheet.
///
/// `history` is the previous results, most recent first, for `%`, `%%`, `%%%`.
/// Substitution happens **before parsing**, so `%` really is the previous
/// expression rather than a reference resolved later — which is what makes
/// `diff(x^3, x)` then `solve(% = 12)` behave the way a worksheet should.
pub fn command(doc: &Document, line: &str, history: &[String]) -> CasCommandReply {
    let plain = |command: &str, source: &str, reply: CasReply| CasCommandReply {
        command: command.to_string(),
        source: source.to_string(),
        reply: CasAnyReply::Plain(Box::new(reply)),
    };

    let source = match substitute_history(line, history) {
        Ok(s) => s,
        Err(message) => return plain("eval", line, CasReply::failed(line, message)),
    };
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return plain("eval", &source, CasReply::waiting(trimmed, "type an expression"));
    }

    // A bare expression is `eval`. That is the rule from the spec — "Enter
    // evaluates" — and it is why the verbs are all multi-letter: an identifier
    // in this language is one letter, so no command name can ever collide with
    // something a document defined.
    let Some((verb, args)) = split_call(trimmed) else {
        return plain("eval", &source, eval_expr(doc, trimmed));
    };

    let wrong_arity = |want: &str| {
        plain(
            &verb,
            &source,
            CasReply::failed(
                trimmed,
                format!("`{}` takes {}, and got {}", verb, want, args.len()),
            ),
        )
    };

    match (verb.as_str(), args.len()) {
        ("solve", 1) => CasCommandReply {
            command: verb.clone(),
            source: source.clone(),
            reply: CasAnyReply::Solve(Box::new(solve_expr(doc, &args[0], ""))),
        },
        ("solve", 2) => CasCommandReply {
            command: verb.clone(),
            source: source.clone(),
            reply: CasAnyReply::Solve(Box::new(solve_expr(doc, &args[0], &args[1]))),
        },
        ("solve", _) => wrong_arity("an equation and optionally the unknown"),
        ("equal", 1) => CasCommandReply {
            command: verb.clone(),
            source: source.clone(),
            reply: CasAnyReply::Forms(Box::new(equal_forms(doc, &args[0]))),
        },
        ("equal", _) => wrong_arity("one expression"),
        ("eval", 1) => plain(&verb, &source, eval_expr(doc, &args[0])),
        ("evalf", 1) => plain(&verb, &source, evalf_expr(doc, &args[0])),
        ("simplify", 1) => plain(&verb, &source, simplify_expr(doc, &args[0])),
        ("expand", 1) => plain(&verb, &source, expand_expr(doc, &args[0])),
        ("factor", 1) => plain(&verb, &source, factor_expr(doc, &args[0])),
        ("eval" | "evalf" | "simplify" | "expand" | "factor", _) => wrong_arity("one expression"),
        ("diff", 2) => plain(&verb, &source, diff_expr(doc, &args[0], &args[1])),
        ("diff", _) => wrong_arity("an expression and a variable"),
        ("subs", 2) => plain(&verb, &source, subs_expr(doc, &args[0], &args[1])),
        ("subs", _) => wrong_arity("an assignment and an expression"),
        ("sum", 4) => plain(
            &verb,
            &source,
            series_expr(doc, SeriesKind::Sum, [&args[0], &args[1], &args[2], &args[3]]),
        ),
        ("product", 4) => plain(
            &verb,
            &source,
            series_expr(doc, SeriesKind::Product, [&args[0], &args[1], &args[2], &args[3]]),
        ),
        ("sum" | "product", _) => wrong_arity("a summand, an index, and two limits"),
        // Not a command: `f(x)` where the document defines `f`, or `k(x + 1)`
        // where it does not. Both are expressions, and `eval` is what a bare
        // expression means.
        _ => plain("eval", &source, eval_expr(doc, trimmed)),
    }
}

/// `%` is the previous result, `%%` the one before, and so on — Maple's own
/// convention.
///
/// Textual, and deliberately: the substitution happens before the parser sees
/// anything, so `%` is genuinely the previous *expression* and not a handle to
/// be resolved later. The replacement is bracketed, because `2%` with a
/// previous result of `x + 1` means `2(x + 1)` and nothing else.
fn substitute_history(line: &str, history: &[String]) -> Result<String, String> {
    if !line.contains('%') {
        return Ok(line.to_string());
    }
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        let mut depth = 1usize;
        while chars.peek() == Some(&'%') {
            chars.next();
            depth += 1;
        }
        match history.get(depth - 1) {
            Some(previous) => {
                out.push('(');
                out.push_str(previous);
                out.push(')');
            }
            None => {
                return Err(format!(
                    "`{}` means {} results back, and this worksheet only has {}",
                    "%".repeat(depth),
                    depth,
                    history.len()
                ))
            }
        }
    }
    Ok(out)
}

/// `name(a, b)` split into the name and its arguments, or `None` if the line is
/// not a call to a known command.
///
/// Deliberately narrow. It matches only a *command* name, so `f(x)` and
/// `sin(x + 1)` fall through to being expressions — which is what they are.
fn split_call(line: &str) -> Option<(String, Vec<String>)> {
    let open = line.find('(')?;
    let name = line[..open].trim();
    if !COMMANDS.iter().any(|(c, _)| *c == name) {
        return None;
    }
    if !line.ends_with(')') {
        return None;
    }
    let inner = &line[open + 1..line.len() - 1];
    Some((name.to_string(), split_arguments(inner)))
}

/// Split on the commas that are not inside brackets.
///
/// `sum(min(k, 3), k, 1, n)` has five commas and four arguments, and telling
/// them apart is the whole job.
fn split_arguments(inner: &str) -> Vec<String> {
    if inner.trim().is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();
    for c in inner.chars() {
        match c {
            '(' | '[' => {
                depth += 1;
                current.push(c);
            }
            ')' | ']' => {
                depth -= 1;
                current.push(c);
            }
            ',' if depth == 0 => {
                out.push(current.trim().to_string());
                current = String::new();
            }
            _ => current.push(c),
        }
    }
    out.push(current.trim().to_string());
    out
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

    // ---- the worksheet verbs ---------------------------------------------

    /// The complaint the whole feature exists to answer, through the API the
    /// pane actually calls.
    #[test]
    fn the_cas_can_solve_two_x_equals_two() {
        let d = empty();
        let reply = solve_expr(&d, "2x = 2", "x");
        assert!(reply.ok, "{:?}", reply);
        assert_eq!(reply.variable, "x");
        assert_eq!(reply.solutions.len(), 1);
        assert_eq!(reply.solutions[0].expr, "1");
        assert_eq!(reply.solutions[0].verified, "exact");
        assert_eq!(reply.solutions[0].value, Some(1.0));
    }

    /// One unknown means the caller does not have to name it. Two means they do,
    /// and the refusal lists them rather than picking.
    #[test]
    fn the_unknown_can_be_left_out_when_there_is_only_one() {
        let d = empty();
        assert_eq!(solve_expr(&d, "2x = 2", "").variable, "x");
        let ambiguous = solve_expr(&d, "a*x = b", "");
        assert!(!ambiguous.ok);
        let message = ambiguous.error.unwrap();
        assert!(message.contains("more than one unknown"), "{}", message);
        assert!(message.contains('a') && message.contains('x'), "{}", message);
    }

    #[test]
    fn a_solution_set_can_be_empty_or_everything() {
        let d = empty();
        let none = solve_expr(&d, "x^2 + 1 = 0", "x");
        assert!(none.ok && none.solutions.is_empty() && !none.every_value);
        let all = solve_expr(&d, "2x = 2x", "x");
        assert!(all.ok && all.every_value);
    }

    #[test]
    fn a_refused_equation_says_why() {
        let d = empty();
        let reply = solve_expr(&d, "sin(x) = 0", "x");
        assert!(!reply.ok && !reply.pending);
        assert!(reply.error.unwrap().contains("infinitely many"));
    }

    /// `eval` keeps the exact form; `evalf` insists on a number. Two verbs
    /// because they are two questions.
    #[test]
    fn eval_is_exact_and_evalf_is_a_number() {
        let d = empty();
        assert_eq!(eval_expr(&d, "sqrt(2)").output, "sqrt(2)");
        assert_eq!(evalf_expr(&d, "sqrt(2)").output, "1.4142135623730951");
        assert_eq!(eval_expr(&d, "sqrt(8)").output, "2sqrt(2)");
        assert_eq!(eval_expr(&d, "2 + 3*4").output, "14");
        // ...and when it cannot be a number, `evalf` says which name stopped it.
        let refused = evalf_expr(&d, "x + 1");
        assert!(!refused.ok, "{:?}", refused);
        assert!(refused.error.unwrap().contains("`x` has no value"));
    }

    #[test]
    fn factoring_and_substituting() {
        let d = empty();
        assert_eq!(factor_expr(&d, "x^2 - 1").output, "(x + 1) * (x - 1)");
        assert_eq!(subs_expr(&d, "x = 3", "x^2 + 1").output, "10");
        let wrong = subs_expr(&d, "x + y = 3", "x");
        assert!(!wrong.ok && wrong.error.unwrap().contains("replaces a name"));
    }

    #[test]
    fn sums_and_products() {
        let d = empty();
        assert_eq!(
            series_expr(&d, SeriesKind::Sum, ["k", "k", "1", "n"]).output,
            "n * (n + 1)/2"
        );
        assert_eq!(
            series_expr(&d, SeriesKind::Sum, ["k^2", "k", "1", "10"]).output,
            "385"
        );
        assert_eq!(
            series_expr(&d, SeriesKind::Product, ["k", "k", "1", "5"]).output,
            "120"
        );
        // A factorial has no name in this language, and the refusal says so
        // rather than inventing one that nothing else could read.
        let refused = series_expr(&d, SeriesKind::Product, ["k", "k", "1", "n"]);
        assert!(!refused.ok);
        assert!(refused.error.unwrap().contains("factorial"));
    }

    /// The example from the spec, through the wire shape the pane renders.
    #[test]
    fn equal_offers_a_labelled_list_to_choose_from() {
        let d = empty();
        let reply = equal_forms(&d, "1^(1/2)");
        assert!(reply.ok, "{:?}", reply);
        let sources: Vec<&str> = reply.forms.iter().map(|f| f.expr.as_str()).collect();
        assert!(sources.contains(&"1"), "{:?}", sources);
        assert!(sources.contains(&"sqrt(1)"), "{:?}", sources);
        // Every form carries a label and a kind the UI can switch on.
        for form in &reply.forms {
            assert!(!form.label.is_empty());
            assert!(
                ["exact", "conditional", "decimal", "identification"].contains(&form.kind),
                "{:?}",
                form
            );
            assert_eq!(form.condition.is_some(), form.kind == "conditional", "{:?}", form);
        }
    }

    /// A number gets its closed forms back, tagged as *recognised* rather than
    /// as proved. The tag is the whole point: one of these is an identity and
    /// the other is a coincidence that has not happened yet.
    #[test]
    fn a_recognised_number_is_labelled_as_a_guess() {
        let d = empty();
        let reply = equal_forms(&d, "1.6449340668482264");
        let identified: Vec<&CasForm> = reply
            .forms
            .iter()
            .filter(|f| f.kind == "identification")
            .collect();
        assert!(
            identified.iter().any(|f| f.expr == "pi^2/6"),
            "{:?}",
            reply.forms
        );
        for f in identified {
            assert!(f.note.as_ref().unwrap().contains("not a proof"), "{:?}", f);
        }
    }

    // ---- the command line ------------------------------------------------

    #[test]
    fn a_typed_line_dispatches_to_the_right_verb() {
        let d = empty();
        for (line, verb) in [
            ("solve(2x = 2, x)", "solve"),
            ("solve(2x = 2)", "solve"),
            ("equal(sqrt(2))", "equal"),
            ("simplify(2x + 3x)", "simplify"),
            ("diff(x^3, x)", "diff"),
            ("sum(k, k, 1, n)", "sum"),
            ("product(k, k, 1, 5)", "product"),
            ("evalf(pi)", "evalf"),
            ("subs(x = 3, x^2)", "subs"),
            // A bare expression is `eval`, which is what "Enter evaluates"
            // means at this boundary.
            ("2x + 3x", "eval"),
            ("sin(x)", "eval"),
        ] {
            let reply = command(&d, line, &[]);
            assert_eq!(reply.command, verb, "{}", line);
        }
    }

    /// `%` is the previous result, substituted before parsing — which is what
    /// makes a worksheet a worksheet rather than a list of independent sums.
    #[test]
    fn the_ditto_operator_reaches_back_through_the_history() {
        let d = empty();
        let history = vec!["3x^2".to_string(), "x^3".to_string()];
        let reply = command(&d, "solve(% = 12, x)", &history);
        assert_eq!(reply.source, "solve((3x^2) = 12, x)");
        let CasAnyReply::Solve(solved) = reply.reply else {
            panic!("not a solve reply");
        };
        assert_eq!(
            solved.solutions.iter().map(|s| s.expr.clone()).collect::<Vec<_>>(),
            vec!["-2", "2"]
        );
        // `%%` is the one before. Reaching past the end is a refusal, not a
        // silent empty substitution.
        assert_eq!(command(&d, "eval(%%)", &history).source, "eval((x^3))");
        let too_far = command(&d, "eval(%%%)", &history);
        assert!(matches!(&too_far.reply, CasAnyReply::Plain(r) if !r.ok));
    }

    #[test]
    fn a_command_with_the_wrong_number_of_arguments_says_so() {
        let d = empty();
        let reply = command(&d, "diff(x^3)", &[]);
        let CasAnyReply::Plain(inner) = reply.reply else {
            panic!("not a plain reply");
        };
        assert!(!inner.ok);
        assert!(inner.error.unwrap().contains("takes an expression and a variable"));
    }

    /// Commas inside an argument are not argument separators.
    #[test]
    fn arguments_split_on_the_commas_that_are_not_nested() {
        assert_eq!(split_arguments("a, b"), vec!["a", "b"]);
        assert_eq!(split_arguments("min(k, 3), k, 1, n"), vec!["min(k, 3)", "k", "1", "n"]);
        assert_eq!(split_arguments("[1, 2], x"), vec!["[1, 2]", "x"]);
        assert!(split_arguments("  ").is_empty());
    }

    /// Every string that crosses the boundary has to be Numpla source — for the
    /// new verbs as much as the old ones. A root you cannot paste back is not a
    /// root, and an alternative form you cannot paste back is not an
    /// alternative.
    #[test]
    fn every_string_from_every_verb_parses() {
        let d = doc("f(u) = u^2\nk = 3");
        let mut sources: Vec<String> = Vec::new();
        for reply in [
            simplify_expr(&d, "2x + 3x + f(x)"),
            factor_expr(&d, "x^2 - 5x + 6"),
            eval_expr(&d, "sqrt(8)"),
            evalf_expr(&d, "sqrt(8)"),
            subs_expr(&d, "x = 2", "x^3"),
            series_expr(&d, SeriesKind::Sum, ["k^2", "k", "1", "n"]),
        ] {
            assert!(reply.ok, "{:?}", reply);
            sources.push(reply.output.clone());
            sources.extend(reply.steps.iter().flatten().map(|s| s.expr.clone()));
        }
        sources.extend(
            solve_expr(&d, "x^2 - 2x - 1 = 0", "x")
                .solutions
                .iter()
                .map(|s| s.expr.clone()),
        );
        sources.extend(equal_forms(&d, "sin(2x)").forms.iter().map(|f| f.expr.clone()));

        for src in sources {
            let (stmt, errs) = numpla_expr::parse(&src);
            assert!(errs.is_empty(), "`{}`: {:?}", src, errs);
            assert!(matches!(stmt, Stmt::Expr(_)), "`{}` is not an expression", src);
        }
    }

}

