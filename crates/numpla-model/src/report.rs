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
