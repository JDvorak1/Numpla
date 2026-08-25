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
