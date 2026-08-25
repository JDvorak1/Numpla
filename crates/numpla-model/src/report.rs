//! The JSON shapes the shell reads.
//!
//! These are the wire format of `docs/wasm-api.md`, so field names and the
//! spelling of every enum are part of the contract rather than a matter of
//! taste. `numpla-wasm` serialises these and does nothing else.

use serde::Serialize;

/// Why a row is not contributing.
///
/// The two variants are not degrees of the same thing. `Pending` is the normal
/// state of a row being typed and the UI must render it muted; `Error` is the
/// only one that turns red. Collapsing them would make Numpla shout at people
/// mid-keystroke, which is the failure mode the whole design is built to avoid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Pending,
}

/// A row the compiler would write for you.
///
/// The software knows the answer, so it proposes it rather than either
/// demanding it or silently assuming it — the same principle as the slider
/// offer. `insert` is therefore a *complete, parseable row*, not a fragment:
/// the shell appends it to the document verbatim and recompiles.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Fix {
    /// Button text, imperative: "add y(0) = 0".
    pub label: String,
    /// A complete row to append to the document.
    pub insert: String,
}

impl Fix {
    /// Both halves come from the row being proposed, so writing them apart
    /// would be two chances to disagree.
    pub fn append(row: impl Into<String>) -> Fix {
        let row = row.into();
        Fix {
            label: format!("add {}", row),
            insert: row,
        }
    }
}

/// One problem, located precisely enough to underline.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Issue {
    /// 0-based line in the source document.
    pub line: usize,
    pub severity: Severity,
    pub message: String,
    /// Byte offsets within that line.
    pub start: usize,
    pub end: usize,
    /// A row that would resolve this issue, when the compiler can name one.
    ///
    /// Absent — and omitted from the JSON entirely — otherwise, which is what
    /// keeps this a backwards-compatible addition to the v1 contract.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<Fix>,
    /// Does this stop the document being integrated?
    ///
    /// Not on the wire, because it answers a different question than
    /// `severity` does. `severity` tells the shell how to *draw* the row;
    /// this tells `solve` whether to *run*. A missing initial condition is
    /// reported and defaulted in the same breath, so it is pending and
    /// harmless; a name that is not defined yet is pending because we can
    /// propose a value, but nothing can integrate until someone accepts it.
    #[serde(skip)]
    pub blocking: bool,
}

impl Issue {
    /// An issue that stops the document integrating. Everything the compiler
    /// finds is this unless it says otherwise.
    pub fn new(line: usize, severity: Severity, message: String, start: usize, end: usize) -> Issue {
        Issue {
            line,
            severity,
            message,
            start,
            end,
            fix: None,
            blocking: true,
        }
    }

    pub fn with_fix(mut self, fix: Fix) -> Issue {
        self.fix = Some(fix);
        self
    }

    /// Information, not an obstruction: the document still solves.
    pub fn informational(mut self) -> Issue {
        self.blocking = false;
        self
    }
}

/// What `set_source` answers with.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Diagnostics {
    /// State vector order. `states.len()` is the dimension of everything the
    /// solver returns, so the shell can label columns without asking again.
    pub states: Vec<String>,
    pub params: Vec<String>,
    /// Rows that are functions of the solution rather than constants — an
    /// energy row, a momentum, anything written in terms of the states. These
    /// are the names [`SolveReport`]'s companion, `conservation`, will accept:
    /// the shell can offer this list directly as the monitor's menu instead of
    /// asking the user to spell a name twice.
    pub derived: Vec<String>,
    pub issues: Vec<Issue>,
}

/// What `solve` answers with.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolveReport {
    pub ok: bool,
    pub t0: f64,
    pub t1: f64,
    pub dim: usize,
    pub states: Vec<String>,
    pub accepted: usize,
    pub rejected: usize,
    pub rhs_evals: usize,
    /// Which integrator produced this solution.
    ///
    /// On the wire so that a UI showing a method name can never show one the
    /// run did not use. When `ok` is false nothing was integrated and this
    /// echoes the method that was asked for — including a name that is not a
    /// method at all, which is exactly the case the shell needs to see.
    pub method: String,
    /// Did this run actually preserve the symplectic form?
    ///
    /// Not the same question as "is the method symplectic", and the difference
    /// is the honest part. Velocity Verlet on `x'' = -x - 0.4x'` is a
    /// symplectic *method* applied to a system with no symplectic structure to
    /// preserve: the damping is the whole point of the model, and there is no
    /// conserved energy for the integrator to keep in a band. Only the model
    /// layer knows that, because only it knows whether the acceleration row
    /// mentions `x'`. The conservation monitor uses this to say what to expect
    /// before the drift has had time to show.
    pub symplectic: bool,
    /// `None` when `ok`; otherwise a sentence a person can act on.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct StepJson {
    pub t: f64,
    pub dt: f64,
    pub error: f64,
    pub accepted: bool,
}

/// Every attempted step, rejections included — the telemetry strip is there to
/// show *where* a problem got hard, and the rejected steps are the answer.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct TelemetryJson {
    pub steps: Vec<StepJson>,
}

/// One integrator, described well enough for the mode slider to be built from
/// this list rather than from a hard-coded copy of it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MethodJson {
    pub name: String,
    pub adaptive: bool,
    pub symplectic: bool,
    pub order: u32,
}

/// The methods a document can be solved with, in slider order.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct MethodsJson {
    pub methods: Vec<MethodJson>,
}

/// How far a quantity wandered. Four numbers, all from one series.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drift {
    /// The largest `|value - initial|` anywhere in the run.
    pub max_abs_deviation: f64,
    /// The same figure relative to `|initial|`, so an energy of 3000 and one of
    /// 0.003 are comparable. Falls back to the absolute figure near zero.
    pub relative_drift: f64,
    /// Signed end-to-end change. A method that gains energy looks nothing like
    /// one that loses it, and the sign is often the first hint of what is wrong.
    pub net_drift: f64,
    /// The band over the last tenth of the run divided by the band over the
    /// first tenth. Around 1 means bounded — the signature of a
    /// structure-preserving method. Large means secular drift.
    pub secular_ratio: f64,
}

/// What `conservation` answers with: how well the run kept one named quantity.
///
/// The series itself is **not** in here. Bulk numbers cross the boundary as a
/// `Float64Array` (`conservation_series`), per the rule in `docs/wasm-api.md`;
/// what a JSON string is good for is the structure around them.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConservationReport {
    pub ok: bool,
    /// The row that was measured.
    pub name: String,
    /// How many samples were actually taken — not necessarily how many were
    /// asked for. See [`crate::Model::conservation`] for why the model raises a
    /// request it considers too coarse.
    pub samples: usize,
    /// The value at the start of the run. Everything else is measured against
    /// it, because the *true* value is whatever the initial condition had.
    pub initial: f64,
    /// Drift measured on the dense output — the curve the monitor draws, and
    /// therefore the one the user is entitled to have described.
    pub drift: Drift,
    /// The same drift measured at the integrator's own step points.
    ///
    /// Both are reported because they answer different questions and
    /// disagreeing is normal. A quantity a method conserves *exactly* is exact
    /// at step points and only nearly exact on the interpolant between them, so
    /// a small `drift` beside a zero `atSteps` is the cubic Hermite talking,
    /// not the method losing the invariant. Showing only the first would
    /// slander the integrator; showing only the second would describe a curve
    /// nobody is looking at.
    pub at_steps: Drift,
    /// `None` when `ok`; otherwise a sentence a person can act on.
    pub error: Option<String>,
}
