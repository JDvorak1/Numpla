//! From a text document to something integrable.
//!
//! One line is one row. The job here is to work out which rows are states,
//! what order they go in, what the constants are worth, and — for every row
//! that cannot contribute — whether it is *incomplete* or *wrong*. That last
//! distinction is the reason this pass evaluates as much as it can up front
//! instead of waiting for the solver to fall over.

use std::collections::{BTreeSet, HashMap};

use numpla_expr::{
    deriv_key, eval, parse_row, parse_row_with, Env, EvalError, Expr, FuncNames, ParsedRow, Stmt,
    Value,
};

use crate::report::{Diagnostics, Fix, Issue, Severity};

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

/// A row that is a *function of the solution* rather than a constant.
///
/// `E = 0.5(x'^2 + x^2)` is the shape: an ordinary `name = expr` row whose
/// expression reads states, so it has no value until there is a trajectory to
/// read it along. Before the conservation monitor existed such a row could only
/// be a mistake — a name used with nothing behind it — and it went red. It is
/// now the *intended* way to ask "is this quantity conserved?", so the compiler
/// recognises it, keeps it out of `params` (it is not a constant), and hands it
/// to [`crate::Model::conservation`] to be evaluated sample by sample.
#[derive(Debug, Clone, PartialEq)]
pub struct Derived {
    pub name: String,
    pub expr: Expr,
}

/// A compiled document: the state vector, its initial values, and the
/// environment every right-hand side is evaluated against.
#[derive(Debug, Clone)]
pub struct Document {
    pub states: Vec<String>,
    pub params: Vec<String>,
    /// Rows that are functions of the solution — see [`Derived`].
    pub derived: Vec<Derived>,
    pub issues: Vec<Issue>,
    pub y0: Vec<f64>,
    pub rhs: Vec<StateRhs>,
    /// Constants and user functions. States are *not* bound here; the solver
    /// writes them in on every call.
    pub env: Env,
    /// What the rows differentiate *with respect to* — the `t` of `dx/dt`, the
    /// `x` of `df/dx`.
    ///
    /// This is a name, not a convention: it is the environment key the solver
    /// binds its parameter to on every right-hand-side call, the name a row may
    /// legitimately read, and the label the horizontal axis deserves. A
    /// document of `x' = ...` rows never says, so it gets `t`; a document that
    /// writes `df/dx = 2x` is integrating along `x` and everything downstream
    /// has to agree, or the row would be reading a name nothing binds.
    ///
    /// One per document. See [`resolve_independent`] for why two is an error
    /// rather than something to pick a winner from.
    pub independent: String,
}

/// `t` unless a row says otherwise — the same default an empty document gets
/// from [`compile`], written once so the two cannot drift apart.
pub const DEFAULT_INDEPENDENT: &str = "t";

impl Default for Document {
    fn default() -> Document {
        Document {
            states: Vec::new(),
            params: Vec::new(),
            derived: Vec::new(),
            issues: Vec::new(),
            y0: Vec::new(),
            rhs: Vec::new(),
            env: Env::default(),
            independent: DEFAULT_INDEPENDENT.to_string(),
        }
    }
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

    /// The first pending issue that actually stops the document integrating.
    ///
    /// Not every pending issue does. A state with no initial condition is
    /// reported *and* defaulted in the same pass, so the document still
    /// solves; a name that is not defined yet is pending because we can
    /// propose a value, but nothing has been assumed on the user's behalf and
    /// there is nothing to integrate until they accept it.
    pub fn first_blocker(&self) -> Option<String> {
        self.issues
            .iter()
            .find(|i| i.severity == Severity::Pending && i.blocking)
            .map(|i| format!("line {}: {}", i.line + 1, i.message))
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
            derived: self.derived.iter().map(|d| d.name.clone()).collect(),
            independent: self.independent.clone(),
            issues: self.issues.clone(),
        }
    }

    /// The `(position, velocity)` pairing this document's lowering produced, or
    /// a sentence naming the first state that is not half of a pair.
    ///
    /// This is the bridge to the symplectic integrators: `numpla-ode` refuses
    /// to guess a pairing from an even state count, and it is right to — three
    /// first-order rows plus one second-order row is also even. The pairing is
    /// not inferred here either, it is *read back* from what
    /// [`declare_states`] wrote: a lowered `x'' = ...` row is exactly a
    /// [`StateRhs::Velocity`] pointing at the state immediately after it, and
    /// nothing else in the format produces that.
    ///
    /// The error is a sentence rather than a flag because it is the thing the
    /// person needs told: a document of plain `x' = ...` rows has no
    /// position/velocity structure, so there is nothing for a symplectic
    /// method to preserve, and no amount of retrying will change that.
    pub fn pairs(&self) -> Result<Vec<(usize, usize)>, String> {
        let mut pairs = Vec::new();
        let mut i = 0;
        while i < self.rhs.len() {
            match self.rhs[i] {
                StateRhs::Velocity(j) if j == i + 1 => {
                    pairs.push((i, i + 1));
                    i += 2;
                }
                _ => {
                    return Err(format!(
                        "{} is a first-order row, so the document has no position/velocity structure",
                        self.states[i]
                    ))
                }
            }
        }
        Ok(pairs)
    }

    /// Does any acceleration row read a velocity?
    ///
    /// Answered exactly rather than assumed, which is what `numpla-ode` asks of
    /// callers that lower text (see `SecondOrderSystem::reads_velocity`). The
    /// velocity of `x` is a *named* state here — `x'` — so the question is
    /// whether an acceleration row's dependency set contains one of those
    /// names, and a dependency set is something the compiler already has. The
    /// answer costs Verlet an extra acceleration evaluation per step and costs
    /// the run its symplecticity, so guessing `true` would quietly make every
    /// undamped oscillator both slower and structurally worse.
    ///
    /// Only the *acceleration* rows are asked. The position row of a lowered
    /// pair is `x' = v` by construction and reads a velocity by definition;
    /// counting it would make the answer `true` for every second-order
    /// document there is.
    ///
    /// A derived row is followed like a user function: `x'' = -x - E` with
    /// `E = 0.4x'` is the same damping as writing the term inline, and
    /// answering `false` for it would report a damped run as symplectic.
    pub fn reads_velocity(&self) -> bool {
        let Ok(pairs) = self.pairs() else {
            return false;
        };
        // The velocity names, plus every derived name that (transitively)
        // reads one — relaxed to a fixed point, since derived rows may be
        // written in terms of each other.
        let mut names: BTreeSet<String> =
            pairs.iter().map(|&(_, v)| self.states[v].clone()).collect();
        loop {
            let mut changed = false;
            for d in &self.derived {
                if !names.contains(&d.name) && reads_any(&d.expr, &names, &self.env) {
                    names.insert(d.name.clone());
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        pairs.iter().any(|&(_, v)| match &self.rhs[v] {
            StateRhs::Expr(e) => reads_any(e, &names, &self.env),
            StateRhs::Velocity(_) => false,
        })
    }

    /// The derived rows an ODE right-hand side (transitively) reads.
    ///
    /// Usually empty: a derived row exists to be *measured*, not integrated.
    /// But `x' = -E` with `E = 0.5x^2` is an ordinary way to name a quantity
    /// and use it, the probe pass accepts it, and a solver that then refused
    /// it would be two answers to one document. This is the subset
    /// [`crate::ModelSystem`] has to evaluate per right-hand-side call — kept
    /// minimal so a document that merely *monitors* an energy pays nothing for
    /// it in the hot loop.
    pub fn derived_for_rhs(&self) -> Vec<Derived> {
        let mut needed: BTreeSet<String> = BTreeSet::new();
        loop {
            let mut changed = false;
            for d in &self.derived {
                if needed.contains(&d.name) {
                    continue;
                }
                let name: BTreeSet<String> = [d.name.clone()].into();
                let read = self
                    .rhs
                    .iter()
                    .any(|r| matches!(r, StateRhs::Expr(e) if reads_any(e, &name, &self.env)))
                    || self
                        .derived
                        .iter()
                        .filter(|o| needed.contains(&o.name))
                        .any(|o| reads_any(&o.expr, &name, &self.env));
                if read {
                    needed.insert(d.name.clone());
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        self.derived
            .iter()
            .filter(|d| needed.contains(&d.name))
            .cloned()
            .collect()
    }
}

/// Does `e` read any of `names`, following user functions into their bodies?
///
/// Three details make this exact rather than approximate, and all three matter
/// for the two questions it answers — whether an acceleration row reads a
/// velocity, and whether a `name = ...` row is a function of the solution:
///
/// - `Expr::deps` reports a `Deriv` under its *base* name, so it cannot tell
///   `x` from `x'`. Here the derivative key is rebuilt, because the whole point
///   is telling those two apart.
/// - A call to a user function reads whatever that function's body reads. A row
///   written as `x'' = drag(x')` and one written as `x'' = -0.4x'` are the same
///   physics and must get the same answer.
/// - Parameters shadow globals inside a body, so a function whose parameter
///   happens to be called `x` does not make its caller read the state `x`.
fn reads_any(e: &Expr, names: &BTreeSet<String>, env: &Env) -> bool {
    fn walk(e: &Expr, names: &BTreeSet<String>, env: &Env, seen: &mut BTreeSet<String>) -> bool {
        match e {
            Expr::Num(_) | Expr::Hole => false,
            Expr::Var(n) => names.contains(n),
            Expr::Deriv { name, order } => names.contains(&deriv_key(name, *order)),
            Expr::Call { name, args } => {
                if args.iter().any(|a| walk(a, names, env, seen)) {
                    return true;
                }
                match env.funcs.get(name) {
                    // `seen` stops a recursive definition from recursing here.
                    Some((params, body)) if seen.insert(name.clone()) => {
                        let shadowed: BTreeSet<String> =
                            names.difference(&params.iter().cloned().collect()).cloned().collect();
                        walk(body, &shadowed, env, seen)
                    }
                    _ => false,
                }
            }
            Expr::Neg(a) => walk(a, names, env, seen),
            Expr::Bin { lhs, rhs, .. } => {
                walk(lhs, names, env, seen) || walk(rhs, names, env, seen)
            }
            Expr::List(items) => items.iter().any(|i| walk(i, names, env, seen)),
        }
    }
    walk(e, names, env, &mut BTreeSet::new())
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
    /// A stable handle for the row, used to name the random call sites inside
    /// it. See [`resolve_random_sites`].
    key: String,
    /// The independent variable this row named, if it was written in Leibniz
    /// notation. `None` for `x' = ...` and for every non-ODE row.
    indep: Option<String>,
}

pub fn compile(src: &str) -> Document {
    let mut doc = Document::default();
    let mut rows = read_rows(src, &mut doc.issues);
    resolve_random_sites(&mut rows, doc.env.noise_seed);

    doc.independent = resolve_independent(&rows, &mut doc.issues);
    let states = declare_states(&rows, &mut doc);
    reject_independent_that_is_also_a_state(&rows, &mut doc);
    let derived_rows = bind_assignments(&rows, &mut doc);
    let stated = apply_initial_conditions(&rows, &mut doc);
    report_missing_initial_conditions(&rows, &states, &stated, &mut doc);
    probe_right_hand_sides(&rows, &states.ode_rows, &derived_rows, &mut doc);
    reject_unsupported_rows(&rows, &mut doc);

    doc.issues.sort_by_key(|i| (i.line, i.start));
    offer_each_fix_once(&mut doc.issues);
    doc
}

/// Read every line, in two passes. Blank lines and comments simply do not
/// exist downstream.
///
/// # Why twice
///
/// `g (y - x)^3` and `f(y - x)^3` are the same token sequence and mean
/// different things — the first scales a cubed difference, the second cubes
/// the result of a call. Nothing inside the row can tell them apart; only the
/// rest of the document can, by saying whether `f` has an `f(u) = ...` row.
/// So the first pass reads every row knowing only the builtins and collects
/// the function definitions, and the second re-reads them with that set in
/// hand. Getting this wrong is not a syntax error — it silently changes the
/// precedence of `^` and integrates a different system.
///
/// A document with no function definitions is the common case and skips the
/// second pass entirely: with an empty set the two passes agree by definition.
fn read_rows(src: &str, issues: &mut Vec<Issue>) -> Vec<Row> {
    // Not trimmed at the front: the lexer skips whitespace itself, and
    // trimming would slide every span off the text it underlines.
    let code: Vec<(usize, &str)> = src
        .lines()
        .enumerate()
        .map(|(line, raw)| {
            (
                line,
                match raw.find('#') {
                    Some(i) => &raw[..i],
                    None => raw,
                },
            )
        })
        .filter(|(_, c)| !c.trim().is_empty())
        .collect();

    let mut parsed: Vec<ParsedRow> = code.iter().map(|(_, c)| parse_row(c)).collect();

    let funcs: FuncNames = parsed
        .iter()
        .filter_map(|r| match &r.stmt {
            // A row with parameters. `x(0) = 1` reaches us as an equation
            // rather than an assignment, so an initial condition cannot be
            // mistaken for a function definition here.
            Stmt::Assign { name, params, .. } if !params.is_empty() => Some(name.clone()),
            _ => None,
        })
        .collect();

    if !funcs.is_empty() {
        parsed = code.iter().map(|(_, c)| parse_row_with(c, &funcs)).collect();
    }

    let mut rows = Vec::with_capacity(parsed.len());
    for ((line, code), row) in code.into_iter().zip(parsed) {
        let ParsedRow { stmt, errors, indep } = row;
        let hole = stmt_has_hole(&stmt);
        for e in errors {
            issues.push(Issue::new(
                line,
                // A row the parser could not finish reading is a row still
                // being typed. Anything else it complains about is real.
                if hole {
                    Severity::Pending
                } else {
                    Severity::Error
                },
                e.msg,
                byte_offset(code, e.start),
                byte_offset(code, e.end),
            ));
        }
        rows.push(Row {
            line,
            len: code.trim_end().len(),
            key: row_key(&stmt, code),
            stmt,
            hole,
            indep,
        });
    }
    rows
}

/// A stable handle for one row, used to name the random call sites inside it.
///
/// A row that defines something is named by *what it defines*, so that editing
/// its right-hand side — which happens on every keystroke, since the shell
/// recompiles as you type — does not re-roll the numbers already on screen. A
/// row that defines nothing has only its text to be identified by.
fn row_key(stmt: &Stmt, code: &str) -> String {
    match stmt {
        Stmt::Assign { name, .. } => name.clone(),
        Stmt::Ode { name, order, .. } => deriv_key(name, *order),
        Stmt::Equation { .. } | Stmt::Expr(_) => code.trim().to_string(),
    }
}

/// Pass 0: what the document differentiates with respect to.
///
/// A row written `dx/dt = ...` asserts that the independent variable is `t`;
/// `df/dx = ...` asserts it is `x`; `x' = ...` asserts nothing and goes along
/// with whatever the rest of the document said. With no assertion at all the
/// answer is [`DEFAULT_INDEPENDENT`], which is what every document written
/// before this notation existed gets, so nothing about them changes.
///
/// # Why disagreement is an error rather than a choice
///
/// `dx/dt = -y` beside `dy/ds = x` is not a system. There is one solver
/// parameter and one horizontal axis, so picking the first row's answer would
/// integrate the second row along a variable it never mentions and label the
/// plot with a name half the document disagrees with — a plausible curve of
/// something nobody wrote, which is the failure mode this codebase reports
/// rather than smooths over. Both rows are named, in both directions, because
/// neither is the wrong one: the document has to choose.
fn resolve_independent(rows: &[Row], issues: &mut Vec<Issue>) -> String {
    let named: Vec<&Row> = rows.iter().filter(|r| r.indep.is_some()).collect();
    let Some(first) = named.first() else {
        return DEFAULT_INDEPENDENT.to_string();
    };
    let agreed = first.indep.clone().unwrap_or_default();

    let mut disagreed = false;
    for row in named.iter().skip(1) {
        let other = row.indep.clone().unwrap_or_default();
        if other == agreed {
            continue;
        }
        disagreed = true;
        issues.push(row.issue(Severity::Error, mixed(first, &agreed, row, &other)));
    }
    if disagreed {
        // The first row is as much part of the disagreement as the others, and
        // it is the one a person is most likely to want to change, so it is
        // underlined too rather than being treated as the winner.
        let (row, other) = named
            .iter()
            .skip(1)
            .map(|r| (*r, r.indep.clone().unwrap_or_default()))
            .find(|(_, o)| *o != agreed)
            .expect("disagreed means one exists");
        issues.push(first.issue(Severity::Error, mixed(first, &agreed, row, &other)));
    }
    agreed
}

/// The sentence both halves of a mixed document get, naming both rows so the
/// person can see the pair without hunting for the other one.
fn mixed(a: &Row, a_name: &str, b: &Row, b_name: &str) -> String {
    format!(
        "line {} differentiates by {} and line {} by {} — a document has one independent variable",
        a.line + 1,
        a_name,
        b.line + 1,
        b_name
    )
}

/// A name cannot be both the thing being integrated and the thing it is
/// integrated against.
///
/// `dx/dx = 1` is the shape. Left alone it would bind `x` twice per
/// right-hand-side call — once as the solver's parameter, once as the state —
/// and the second write would win silently, which is a different equation
/// wearing the same text. Reported on the row that introduced the clash.
fn reject_independent_that_is_also_a_state(rows: &[Row], doc: &mut Document) {
    if !doc.states.contains(&doc.independent) {
        return;
    }
    let Some(row) = rows.iter().find(|r| match &r.stmt {
        Stmt::Ode { name, .. } => *name == doc.independent,
        _ => false,
    }) else {
        return;
    };
    doc.issues.push(row.issue(
        Severity::Error,
        format!(
            "{} is the independent variable, so it cannot also be a state",
            doc.independent
        ),
    ));
}

/// Which rows the states came from.
struct States {
    /// The row that introduced each state, aligned with `Document::states`.
    ///
    /// A missing initial condition belongs to the whole document, but the UI
    /// can only highlight a line — so it is reported against the row that
    /// brought the state into existence, which is the one place a person can
    /// look and see why the state exists at all.
    row_of: Vec<usize>,
    /// The ODE rows, for the right-hand-side probe.
    ode_rows: Vec<usize>,
}

/// Pass 1: which rows are states, and in what order.
///
/// Declaration order, with each lowered velocity immediately after its
/// position. That order is public — it is what every `Float64Array` crossing
/// the boundary is laid out in — so it is decided here and nowhere else.
fn declare_states(rows: &[Row], doc: &mut Document) -> States {
    let mut ode_rows = Vec::new();
    let mut row_of = Vec::new();
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
                row_of.push(idx);
            }
            2 => {
                // The hidden state is *named* `x'` on purpose: that is the key
                // the evaluator looks a `Deriv` up under, so binding the state
                // under its own name is also what lets `x'' = -x - 0.1x'` see
                // its own velocity.
                let velocity = doc.states.len() + 1;
                doc.states.push(name.clone());
                doc.rhs.push(StateRhs::Velocity(velocity));
                doc.states.push(deriv_key(name, 1));
                doc.rhs.push(StateRhs::Expr(rhs.clone()));
                // Both halves of a lowered row came from the same line.
                row_of.push(idx);
                row_of.push(idx);
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
    States { row_of, ode_rows }
}

/// Pass 2: constants, user functions, and rows that are functions of the
/// solution.
///
/// Rows may be written in any order, so constants are relaxed to a fixed point
/// rather than evaluated top to bottom — a slider defined below the row that
/// uses it is ordinary in a Desmos-shaped editor, not an error.
///
/// Returns the rows classified as [`Derived`], so the probe pass can check them
/// with the states bound.
fn bind_assignments(rows: &[Row], doc: &mut Document) -> Vec<usize> {
    let mut assignments: Vec<(usize, &String, &Expr)> = Vec::new();

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
            assignments.push((idx, name, rhs));
        } else {
            doc.env
                .funcs
                .insert(name.clone(), (params.clone(), rhs.clone()));
        }
    }

    // Split constants from rows that read the solution. Done after the loop
    // above rather than inside it because a derived row may call a function
    // defined further down the document, and the classification has to see
    // every definition before it can follow one.
    //
    // The independent variable counts as a solution name: `drive = sin(t)` has
    // no value until there is a time to evaluate it at, exactly like a row
    // reading a state.
    let mut solution_names: BTreeSet<String> = doc.states.iter().cloned().collect();
    solution_names.insert(doc.independent.clone());

    // Relaxed to a fixed point, because reading a derived row makes a row
    // derived in turn: `K = 0.5x'^2`, `U = 0.5x^2`, `E = K + U` is how anyone
    // actually writes an energy, and only the first two mention a state.
    let mut derived = vec![false; assignments.len()];
    loop {
        let mut changed = false;
        for (i, (_, name, rhs)) in assignments.iter().enumerate() {
            if derived[i] || !reads_any(rhs, &solution_names, &doc.env) {
                continue;
            }
            derived[i] = true;
            solution_names.insert((*name).clone());
            changed = true;
        }
        if !changed {
            break;
        }
    }

    let mut derived_rows = Vec::new();
    let mut constants: Vec<(usize, &String, &Expr)> = Vec::new();
    for (i, (idx, name, rhs)) in assignments.into_iter().enumerate() {
        if derived[i] {
            doc.derived.push(Derived {
                name: name.clone(),
                expr: rhs.clone(),
            });
            // Bound as pending rather than left undefined: a row using `E`
            // should go gray with "waiting", not red with an offer to define a
            // second thing called `E`.
            doc.env.set_value(name, Value::Unevaluated);
            derived_rows.push(idx);
            continue;
        }
        if !doc.params.contains(name) {
            doc.params.push(name.clone());
        }
        constants.push((idx, name, rhs));
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
        let issue = match eval(rhs, &doc.env) {
            Err(e) => issue_for_eval_error(&rows[idx], &e, doc),
            // Unreachable: the loop above only keeps rows that fail.
            Ok(_) => rows[idx].issue(Severity::Error, "could not be evaluated".to_string()),
        };
        doc.issues.push(issue);
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

    derived_rows
}

/// Pass 3: initial conditions. Absent means zero, per the contract.
///
/// Returns, per state, whether the document actually said where it starts —
/// which is what [`report_missing_initial_conditions`] turns into an offer.
/// A row that names the state counts even if it is broken: the person is
/// plainly trying to say where the state begins, and stacking "and it has no
/// starting point" on top of their red row would be noise, not information.
fn apply_initial_conditions(rows: &[Row], doc: &mut Document) -> Vec<bool> {
    doc.y0 = vec![0.0; doc.states.len()];
    let mut stated = vec![false; doc.states.len()];

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
        stated[i] = true;
        if *at != 0.0 {
            doc.issues.push(row.issue(
                Severity::Error,
                format!(
                    "initial conditions are only supported at {} = 0",
                    doc.independent
                ),
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
            Err(e) => {
                let issue = issue_for_eval_error(row, &e, doc);
                doc.issues.push(issue);
            }
        }
    }
    stated
}

/// Say which states are still starting from the default, and offer the row
/// that would say so out loud.
///
/// A state with no initial condition starts at zero, and until now it did so
/// in silence — a guess presented as a fact. It is reported instead, with the
/// row we would have written, and the document still integrates: this is
/// information, not an obstruction (`docs/ui-v3.md` §3). A lowered velocity
/// gets the same treatment under its own name, `x'`, because it is as real a
/// state as its position.
fn report_missing_initial_conditions(
    rows: &[Row],
    states: &States,
    stated: &[bool],
    doc: &mut Document,
) {
    let mut notes = Vec::new();
    for (i, name) in doc.states.iter().enumerate() {
        if stated[i] {
            continue;
        }
        let row = &rows[states.row_of[i]];
        // A row still being typed already says it is incomplete. Telling the
        // person their half-written state has no starting point yet would be
        // shouting about the obvious.
        if row.hole {
            continue;
        }
        notes.push(
            row.issue(Severity::Pending, format!("{} has no starting point", name))
                .with_fix(Fix::append(format!("{}(0) = 0", name)))
                .informational(),
        );
    }
    doc.issues.extend(notes);
}

/// Bind every derived row that can be evaluated in `env`, relaxed to a fixed
/// point.
///
/// The relaxation is what lets `K = 0.5x'^2`, `U = 0.5x^2`, `E = K + U` work,
/// which is how anyone actually writes an energy: in named pieces. It is the
/// same fixed point `bind_assignments` runs over constants, for the same
/// reason — rows are a set, not a sequence — but it happens once per *sample*
/// rather than once per compile, because these rows only have values where
/// there is a state vector.
///
/// Rows that stay unevaluable keep whatever they had, which is
/// [`Value::Unevaluated`]: pending propagates, so a quantity written in terms
/// of a broken one is reported as waiting rather than as wrong.
pub fn bind_derived(derived: &[Derived], env: &mut Env) {
    // Every name starts from scratch. These bindings are facts about *this*
    // sample; a row that fails to evaluate here must read as pending, not as
    // whatever it happened to be worth a sample ago.
    for d in derived {
        match env.vars.get_mut(&d.name) {
            Some(slot) => *slot = Value::Unevaluated,
            None => {
                env.set_value(&d.name, Value::Unevaluated);
            }
        }
    }
    let mut unresolved: Vec<usize> = (0..derived.len()).collect();
    loop {
        let before = unresolved.len();
        unresolved.retain(|&i| match eval(&derived[i].expr, env) {
            Ok(v @ Value::Scalar(_)) => {
                env.set_value(&derived[i].name, v);
                false
            }
            _ => true,
        });
        if unresolved.len() == before {
            break;
        }
    }
}

/// Pass 4: evaluate every right-hand side once, at `t = 0` with the states at
/// their initial values.
///
/// Nothing needs the answer. The point is that a typo like `x' = q` goes red
/// the moment it is typed rather than when someone presses solve.
///
/// Derived rows are probed here too, and this is the only pass that can: they
/// were set aside in pass 2 *because* they cannot be evaluated without a state
/// vector, so `E = 0.5(x^2 + x'^2) + q` would otherwise carry its typo silently
/// until someone opened the conservation monitor.
fn probe_right_hand_sides(
    rows: &[Row],
    ode_rows: &[usize],
    derived_rows: &[usize],
    doc: &mut Document,
) {
    if doc.states.is_empty() && doc.derived.is_empty() {
        return;
    }
    let mut env = doc.env.clone();
    env.set(&doc.independent, 0.0);
    for (name, v) in doc.states.iter().zip(&doc.y0) {
        env.set(name, *v);
    }
    bind_derived(&doc.derived, &mut env);

    for &idx in ode_rows.iter().chain(derived_rows) {
        let row = &rows[idx];
        let rhs = match &row.stmt {
            Stmt::Ode { rhs, .. } | Stmt::Assign { rhs, .. } => rhs,
            _ => continue,
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
            Err(e) => {
                let issue = issue_for_eval_error(row, &e, doc);
                doc.issues.push(issue);
            }
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

/// An eval failure, as an issue on the row that hit it.
///
/// A name that has not been defined *yet* is the ordinary state of a document
/// being written, so when we can name the definition it is waiting for it
/// becomes a `pending` note carrying that row — the gray-not-red rule applied
/// one level up (`docs/ui-v3.md` §3). It still blocks solving: unlike a
/// missing initial condition, nothing has been assumed on the user's behalf.
/// Anything else — a type mismatch, a wrong arity — is a genuine mistake and
/// stays red.
fn issue_for_eval_error(row: &Row, e: &EvalError, doc: &Document) -> Issue {
    if let EvalError::Undefined(name) = e {
        if let Some(fix) = propose_definition(name, doc) {
            return row
                .issue(Severity::Pending, format!("{} is not defined yet", name))
                .with_fix(fix);
        }
    }
    row.issue(Severity::Error, describe(e))
}

/// The definition we would write for a name nothing has defined — `k = 1`.
///
/// Nothing is proposed for a name the document already gives a meaning to. A
/// state that failed to resolve is not waiting for a constant of the same
/// spelling, and offering one would quietly create a second thing under that
/// name — which is worse than the red row it replaced.
fn propose_definition(name: &str, doc: &Document) -> Option<Fix> {
    let unknown = !name.is_empty()
        && !name.ends_with('\'')
        && !doc.states.iter().any(|s| s == name)
        && !doc.params.iter().any(|p| p == name)
        && !doc.env.funcs.contains_key(name);
    // `1` rather than `0`: the name is being used, and a parameter that is
    // zero makes most of the rows reading it collapse to nothing, which looks
    // like the fix did not work.
    unknown.then(|| Fix::append(format!("{} = 1", name)))
}

/// One offer per proposal, on the earliest row that wants it.
///
/// A name used in three rows leaves three pending rows, but there is only one
/// definition to write. Three identical buttons would invite two clicks and
/// two copies of the same row, so the later ones keep the message and lose the
/// offer. Run after the sort, so "earliest" means earliest in the document.
fn offer_each_fix_once(issues: &mut [Issue]) {
    let mut offered = std::collections::BTreeSet::new();
    for issue in issues {
        if let Some(fix) = &issue.fix {
            if !offered.insert(fix.insert.clone()) {
                issue.fix = None;
            }
        }
    }
}

/// Give every zero-argument `rand()` / `randn()` the stream that belongs to
/// its call site, and fold it to the number that stream draws.
///
/// `rand()` is already a *number*, not a draw from a generator — see
/// `numpla_noise`, where determinism is what makes an adaptive solver able to
/// integrate at all. The only thing missing was that every site in a document
/// named the same stream, so two `rand()`s came out equal. The document layer
/// is the only place that can tell two sites apart, so it names them here.
///
/// The answer is written straight into the tree as a literal because it cannot
/// depend on `t` or on the state: leaving a call there would buy nothing and
/// cost a hash on every right-hand-side evaluation.
///
/// # Why the site name is hashed rather than counted
///
/// A counter would number the sites in document order, so inserting a row
/// above would slide every later site onto a different stream and re-roll
/// numbers the user was already looking at. Hashing what the row *is* — the
/// name it defines, else its text — together with the position of the call
/// inside that row means a site changes only when its own row changes. The
/// same document therefore gives the same numbers on every compile, and an
/// edit elsewhere leaves them alone.
fn resolve_random_sites(rows: &mut [Row], seed: u64) {
    // Two rows can share a key — the same text twice, or a duplicate ODE row.
    // They are not "unrelated rows", but they still must not share a stream.
    let mut repeats: HashMap<String, u32> = HashMap::new();
    for row in rows.iter_mut() {
        let slot = repeats.entry(row.key.clone()).or_insert(0);
        let repeat = *slot;
        *slot += 1;
        let mut nth = 0u32;
        let site = Site {
            key: row.key.clone(),
            repeat,
            seed,
        };
        match &mut row.stmt {
            Stmt::Assign { rhs, .. } | Stmt::Ode { rhs, .. } => fold_random(rhs, &site, &mut nth),
            Stmt::Equation { lhs, rhs } => {
                fold_random(lhs, &site, &mut nth);
                fold_random(rhs, &site, &mut nth);
            }
            Stmt::Expr(e) => fold_random(e, &site, &mut nth),
        }
    }
}

/// Everything a call site needs to name its stream, except its position in the
/// row — which the traversal counts as it goes.
struct Site {
    key: String,
    repeat: u32,
    seed: u64,
}

/// Depth-first, left to right — the order the row reads in, so the first
/// `rand()` on the line is site 0.
fn fold_random(e: &mut Expr, site: &Site, nth: &mut u32) {
    let drawn = match e {
        Expr::Call { name, args } => {
            for a in args.iter_mut() {
                fold_random(a, site, nth);
            }
            // `rand(s)` names its own stream and is left exactly as written;
            // only the bare form is ours to resolve.
            let draw = match (args.is_empty(), name.as_str()) {
                (true, "rand") => Some(numpla_noise::rand_at(site.seed, site.index(*nth))),
                (true, "randn") => Some(numpla_noise::randn_at(site.seed, site.index(*nth))),
                _ => None,
            };
            if draw.is_some() {
                *nth += 1;
            }
            draw
        }
        Expr::Neg(a) => {
            fold_random(a, site, nth);
            None
        }
        Expr::Bin { lhs, rhs, .. } => {
            fold_random(lhs, site, nth);
            fold_random(rhs, site, nth);
            None
        }
        Expr::List(items) => {
            for it in items {
                fold_random(it, site, nth);
            }
            None
        }
        Expr::Num(_) | Expr::Var(_) | Expr::Deriv { .. } | Expr::Hole => None,
    };
    if let Some(v) = drawn {
        *e = Expr::Num(v);
    }
}

impl Site {
    /// The index this site draws at. FNV-1a over the row's handle, which copy
    /// of that handle this is, and how many random calls came before it in the
    /// row — written out here rather than pulled in, because it has to give
    /// the same answer on `wasm32` and x86-64 forever.
    fn index(&self, nth: u32) -> i64 {
        const OFFSET: u64 = 0xCBF2_9CE4_8422_2325;
        let h = fnv1a(OFFSET, self.key.as_bytes());
        let h = fnv1a(h, &self.repeat.to_le_bytes());
        fnv1a(h, &nth.to_le_bytes()) as i64
    }
}

fn fnv1a(mut hash: u64, bytes: &[u8]) -> u64 {
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
    }
    hash
}

impl Row {
    /// An issue covering the whole row. Expressions carry no spans once parsed,
    /// so anything found by evaluating underlines the line.
    fn issue(&self, severity: Severity, message: String) -> Issue {
        Issue::new(self.line, severity, message, 0, self.len)
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
