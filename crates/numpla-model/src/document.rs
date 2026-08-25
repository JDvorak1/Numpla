//! From a text document to something integrable.
//!
//! One line is one row. The job here is to work out which rows are states,
//! what order they go in, what the constants are worth, and — for every row
//! that cannot contribute — whether it is *incomplete* or *wrong*. That last
//! distinction is the reason this pass evaluates as much as it can up front
//! instead of waiting for the solver to fall over.

use numpla_expr::{eval, parse, Env, EvalError, Expr, Stmt, Value};

use crate::report::{Diagnostics, Issue, Severity};

/// Where one state's derivative comes from.
#[derive(Debug, Clone, PartialEq)]
pub enum StateRhs {
    /// Evaluate this expression against the bound environment.
    Expr(Expr),
    /// Copy state `j`. This is the position half of a lowered second-order row:
    /// `x' = v` is structural, so putting an expression there would only add
    /// interpreter overhead to the hottest loop in the product.
    Velocity(usize),
}

/// A compiled document: the state vector, its initial values, and the
/// environment every right-hand side is evaluated against.
#[derive(Debug, Clone, Default)]
pub struct Document {
    pub states: Vec<String>,
    pub params: Vec<String>,
    pub issues: Vec<Issue>,
    pub y0: Vec<f64>,
    pub rhs: Vec<StateRhs>,
    /// Constants and user functions. States are *not* bound here; the solver
    /// writes them in on every call.
    pub env: Env,
}

impl Document {
    pub fn dim(&self) -> usize {
        self.states.len()
    }

    pub fn has_errors(&self) -> bool {
        self.issues.iter().any(|i| i.severity == Severity::Error)
    }

    pub fn is_pending(&self) -> bool {
        self.issues.iter().any(|i| i.severity == Severity::Pending)
    }

    /// The first error, phrased for a person: `solve` reports this rather than
    /// a count, because one concrete line beats "3 problems".
    pub fn first_error(&self) -> Option<String> {
        self.issues
            .iter()
            .find(|i| i.severity == Severity::Error)
            .map(|i| format!("line {}: {}", i.line + 1, i.message))
    }

    pub fn diagnostics(&self) -> Diagnostics {
        Diagnostics {
            states: self.states.clone(),
            params: self.params.clone(),
            issues: self.issues.clone(),
        }
    }
}

/// One non-blank row, with everything needed to point back at its text.
struct Row {
    line: usize,
    /// Byte length of the code part of the line — the span used for problems
    /// that belong to the row as a whole rather than to a token.
    len: usize,
    stmt: Stmt,
    /// The row is half-typed. Every hole the parser makes comes with a parse
    /// error, so such a row already carries a `Pending` issue and must not be
    /// given a second one by the passes below.
    hole: bool,
}

pub fn compile(src: &str) -> Document {
    let mut doc = Document::default();
    let rows = read_rows(src, &mut doc.issues);

    let ode_rows = declare_states(&rows, &mut doc);
    bind_assignments(&rows, &mut doc);
    apply_initial_conditions(&rows, &mut doc);
    probe_right_hand_sides(&rows, &ode_rows, &mut doc);
    reject_unsupported_rows(&rows, &mut doc);

    doc.issues.sort_by_key(|i| (i.line, i.start));
    doc
}

/// Parse every line. Blank lines and comments simply do not exist downstream.
fn read_rows(src: &str, issues: &mut Vec<Issue>) -> Vec<Row> {
    let mut rows = Vec::new();
    for (line, raw) in src.lines().enumerate() {
        let code = match raw.find('#') {
            Some(i) => &raw[..i],
            None => raw,
        };
        if code.trim().is_empty() {
            continue;
        }
        // Not trimmed at the front: the lexer skips whitespace itself, and
        // trimming would slide every span off the text it underlines.
        let (stmt, errors) = parse(code);
        let hole = stmt_has_hole(&stmt);
        for e in errors {
            issues.push(Issue {
                line,
                // A row the parser could not finish reading is a row still
                // being typed. Anything else it complains about is real.
                severity: if hole {
                    Severity::Pending
                } else {
                    Severity::Error
                },
                message: e.msg,
                start: byte_offset(code, e.start),
                end: byte_offset(code, e.end),
            });
        }
        rows.push(Row {
            line,
            len: code.trim_end().len(),
            stmt,
            hole,
        });
    }
    rows
}

/// Pass 1: which rows are states, and in what order.
///
/// Declaration order, with each lowered velocity immediately after its
/// position. That order is public — it is what every `Float64Array` crossing
/// the boundary is laid out in — so it is decided here and nowhere else.
fn declare_states(rows: &[Row], doc: &mut Document) -> Vec<usize> {
    let mut ode_rows = Vec::new();
    for (idx, row) in rows.iter().enumerate() {
        let Stmt::Ode { name, order, rhs } = &row.stmt else {
            continue;
        };
        if doc.states.iter().any(|s| s == name) {
            doc.issues.push(row.issue(
                Severity::Error,
                format!("{} already has an ODE row", name),
            ));
            continue;
        }
        match order {
            1 => {
                doc.states.push(name.clone());
                doc.rhs.push(StateRhs::Expr(rhs.clone()));
            }
            2 => {
                // The hidden state is *named* `x'` on purpose: that is the key
                // the evaluator looks a `Deriv` up under, so binding the state
                // under its own name is also what lets `x'' = -x - 0.1x'` see
                // its own velocity.
                let velocity = doc.states.len() + 1;
                doc.states.push(name.clone());
                doc.rhs.push(StateRhs::Velocity(velocity));
                doc.states.push(numpla_expr::deriv_key(name, 1));
                doc.rhs.push(StateRhs::Expr(rhs.clone()));
            }
            _ => {
                doc.issues.push(row.issue(
                    Severity::Error,
                    "only first- and second-order rows are supported".to_string(),
                ));
                continue;
            }
        }
        ode_rows.push(idx);
    }
    ode_rows
}

/// Pass 2: constants and user functions.
///
/// Rows may be written in any order, so constants are relaxed to a fixed point
/// rather than evaluated top to bottom — a slider defined below the row that
/// uses it is ordinary in a Desmos-shaped editor, not an error.
fn bind_assignments(rows: &[Row], doc: &mut Document) {
    let mut constants: Vec<(usize, &String, &Expr)> = Vec::new();

    for (idx, row) in rows.iter().enumerate() {
        let Stmt::Assign { name, params, rhs } = &row.stmt else {
            continue;
        };
        if name.ends_with('\'') {
            // `x'(t) = -y` reaches us as a function definition named `x'`.
            // Accepting it would quietly define a function where the person
            // meant an ODE, so it is refused with the spelling that works.
            doc.issues.push(row.issue(
                Severity::Error,
                format!(
                    "write `{} = ...` without arguments to define an ODE row",
                    name
                ),
            ));
            continue;
        }
        if params.is_empty() {
            if !doc.params.contains(name) {
                doc.params.push(name.clone());
            }
            constants.push((idx, name, rhs));
        } else {
            doc.env
                .funcs
                .insert(name.clone(), (params.clone(), rhs.clone()));
        }
    }

    let mut unresolved: Vec<usize> = (0..constants.len()).collect();
    loop {
        let before = unresolved.len();
        unresolved.retain(|&c| {
            let (_, name, rhs) = constants[c];
            match eval(rhs, &doc.env) {
                Ok(v) => {
                    doc.env.set_value(name, v);
                    false
                }
                Err(_) => true,
            }
        });
        if unresolved.len() == before {
            break;
        }
    }

    for &c in &unresolved {
        let (idx, name, rhs) = constants[c];
        let message = match eval(rhs, &doc.env) {
            Err(e) => describe(&e),
            // Unreachable: the loop above only keeps rows that fail.
            Ok(_) => "could not be evaluated".to_string(),
        };
        doc.issues.push(rows[idx].issue(Severity::Error, message));
        // Rows downstream of a broken definition go gray rather than inheriting
        // the red: the definition is the one place worth pointing at.
        doc.env.set_value(name, Value::Unevaluated);
    }

    for (c, &(idx, name, _)) in constants.iter().enumerate() {
        if unresolved.contains(&c) || rows[idx].hole {
            continue;
        }
        if doc.env.vars.get(name) == Some(&Value::Unevaluated) {
            doc.issues
                .push(rows[idx].issue(Severity::Pending, waiting()));
        }
    }
}

/// Pass 3: initial conditions. Absent means zero, per the contract.
fn apply_initial_conditions(rows: &[Row], doc: &mut Document) {
    doc.y0 = vec![0.0; doc.states.len()];

    for row in rows {
        let Stmt::Equation { lhs, rhs } = &row.stmt else {
            continue;
        };
        let Expr::Call { name, args } = lhs else {
            continue;
        };
        let [Expr::Num(at)] = args.as_slice() else {
            continue;
        };
        let Some(i) = doc.states.iter().position(|s| s == name) else {
            // The ODE row may simply not be typed yet, and writing the initial
            // conditions first is an ordinary way to build a model up.
            doc.issues.push(row.issue(
                Severity::Pending,
                format!("there is no state named {} yet", name),
            ));
            continue;
        };
        if *at != 0.0 {
            doc.issues.push(row.issue(
                Severity::Error,
                "initial conditions are only supported at t = 0".to_string(),
            ));
            continue;
        }
        match eval(rhs, &doc.env) {
            Ok(Value::Scalar(v)) => doc.y0[i] = v,
            Ok(Value::Unevaluated) => {
                if !row.hole {
                    doc.issues.push(row.issue(Severity::Pending, waiting()));
                }
            }
            Ok(Value::List(_)) => doc.issues.push(row.issue(
                Severity::Error,
                "an initial condition must be a single number".to_string(),
            )),
            Err(e) => doc.issues.push(row.issue(Severity::Error, describe(&e))),
        }
    }
}

/// Pass 4: evaluate every right-hand side once, at `t = 0` with the states at
/// their initial values.
///
/// Nothing needs the answer. The point is that a typo like `x' = q` goes red
/// the moment it is typed rather than when someone presses solve.
fn probe_right_hand_sides(rows: &[Row], ode_rows: &[usize], doc: &mut Document) {
    if doc.states.is_empty() {
        return;
    }
    let mut env = doc.env.clone();
    env.set("t", 0.0);
    for (name, v) in doc.states.iter().zip(&doc.y0) {
        env.set(name, *v);
    }

    for &idx in ode_rows {
        let row = &rows[idx];
        let Stmt::Ode { rhs, .. } = &row.stmt else {
            continue;
        };
        match eval(rhs, &env) {
            Ok(Value::Scalar(_)) => {}
            Ok(Value::Unevaluated) => {
                if !row.hole {
                    doc.issues.push(row.issue(Severity::Pending, waiting()));
                }
            }
            Ok(Value::List(_)) => doc.issues.push(row.issue(
                Severity::Error,
                "an ODE right-hand side must be a single number".to_string(),
            )),
            Err(e) => doc.issues.push(row.issue(Severity::Error, describe(&e))),
        }
    }
}

/// Anything the v1 document format has no meaning for.
///
/// Bare expressions are deliberately not caught here: those are plot rows, and
/// the model has no business complaining about them.
fn reject_unsupported_rows(rows: &[Row], doc: &mut Document) {
    for row in rows {
        let Stmt::Equation { lhs, .. } = &row.stmt else {
            continue;
        };
        let is_initial_condition = matches!(
            lhs,
            Expr::Call { args, .. } if matches!(args.as_slice(), [Expr::Num(_)])
        );
        if is_initial_condition || row.hole {
            continue;
        }
        doc.issues.push(row.issue(
            Severity::Error,
            "only ODE rows, definitions and initial conditions are supported".to_string(),
        ));
    }
}

impl Row {
    /// An issue covering the whole row. Expressions carry no spans once parsed,
    /// so anything found by evaluating underlines the line.
    fn issue(&self, severity: Severity, message: String) -> Issue {
        Issue {
            line: self.line,
            severity,
            message,
            start: 0,
            end: self.len,
        }
    }
}

fn waiting() -> String {
    "waiting on an incomplete definition".to_string()
}

/// Eval failures, phrased as something to fix rather than as a variant name.
pub fn describe(e: &EvalError) -> String {
    match e {
        EvalError::Undefined(name) => format!("{} is not defined", name),
        EvalError::TypeMismatch { what, expected } => format!("{} must be {}", what, expected),
        EvalError::Arity { name, got, want } => {
            format!("{} takes {} arguments, got {}", name, want, got)
        }
    }
}

fn stmt_has_hole(s: &Stmt) -> bool {
    match s {
        Stmt::Assign { rhs, .. } | Stmt::Ode { rhs, .. } => rhs.has_hole(),
        Stmt::Equation { lhs, rhs } => lhs.has_hole() || rhs.has_hole(),
        Stmt::Expr(e) => e.has_hole(),
    }
}

/// The lexer counts in characters; the contract promises byte offsets, which is
/// what the shell's editor works in. They agree on ASCII, and this keeps them
/// agreeing on everything else.
fn byte_offset(line: &str, char_index: usize) -> usize {
    line.char_indices()
        .nth(char_index)
        .map(|(b, _)| b)
        .unwrap_or(line.len())
}
