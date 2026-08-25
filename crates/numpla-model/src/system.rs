//! The compiled document, presented to the solver as a first-order system.

use std::cell::RefCell;

use numpla_expr::{eval, Env, Value};
use numpla_ode::System;

use crate::document::{bind_derived, describe, Derived, Document, StateRhs};

/// A [`Document`] the solver can integrate.
///
/// `System::rhs` takes `&self` because a right-hand side is mathematically a
/// pure function, but interpreting one means writing the current state into an
/// environment. The environment therefore lives behind a `RefCell` and is
/// **mutated in place**: `rhs` runs six or seven times per step and Numpla
/// re-integrates on every keystroke, so cloning an `Env` here would cost more
/// than the arithmetic it exists to support. Wasm is single-threaded, so the
/// borrow is never contended.
pub struct ModelSystem {
    /// Env key per state, in state-vector order. Lowered velocities are named
    /// `x'`, which is exactly the key the evaluator resolves `Expr::Deriv`
    /// against — so one binding serves both the state and `x'` written by hand.
    keys: Vec<String>,
    /// The env key the solver's own parameter binds to on every call.
    ///
    /// Hard-coded as `t` until documents could say otherwise; a document
    /// written `df/dx = 2x` integrates along `x`, and binding `t` there would
    /// leave the right-hand side reading a name nothing had written — the row
    /// would go pending and the model would refuse to run. Carried as a string
    /// rather than looked up per call for the same reason `keys` is.
    indep: String,
    rhs: Vec<StateRhs>,
    /// The derived rows some right-hand side actually reads — `x' = -E` with
    /// `E = 0.5x^2` is ordinary — bound before each evaluation so the solver
    /// sees the same document the probe pass approved. Almost always empty: a
    /// derived row usually exists to be measured, not integrated, and an empty
    /// list costs the hot loop nothing.
    derived: Vec<Derived>,
    env: RefCell<Env>,
    /// The first thing that went wrong inside a right-hand side.
    ///
    /// Nothing can be thrown out of `rhs`, and returning NaN would surface as
    /// an incomprehensible solver failure. Instead the failure is recorded, the
    /// derivative is written as zero so the integrator stays well-behaved, and
    /// the caller turns the recorded message into the report.
    failure: RefCell<Option<String>>,
}

impl ModelSystem {
    pub fn new(doc: &Document) -> Self {
        let mut env = doc.env.clone();
        // Pre-seed every key that `rhs` writes, so the per-call binding is a
        // slot overwrite rather than a hash-map insert with a fresh `String`.
        env.set(&doc.independent, 0.0);
        for (name, v) in doc.states.iter().zip(&doc.y0) {
            env.set(name, *v);
        }
        ModelSystem {
            keys: doc.states.clone(),
            indep: doc.independent.clone(),
            rhs: doc.rhs.clone(),
            derived: doc.derived_for_rhs(),
            env: RefCell::new(env),
            failure: RefCell::new(None),
        }
    }

    /// What went wrong while integrating, if anything.
    pub fn failure(&self) -> Option<String> {
        self.failure.borrow().clone()
    }

    fn fail(&self, message: String) {
        let mut slot = self.failure.borrow_mut();
        if slot.is_none() {
            *slot = Some(message);
        }
    }
}

impl System for ModelSystem {
    fn dim(&self) -> usize {
        self.rhs.len()
    }

    fn rhs(&self, t: f64, y: &[f64], dy: &mut [f64]) {
        let mut env = self.env.borrow_mut();
        bind(&mut env, &self.indep, t);
        for (key, value) in self.keys.iter().zip(y) {
            bind(&mut env, key, *value);
        }
        if !self.derived.is_empty() {
            bind_derived(&self.derived, &mut env);
        }

        for (i, source) in self.rhs.iter().enumerate() {
            dy[i] = match source {
                StateRhs::Velocity(j) => y[*j],
                StateRhs::Expr(e) => match eval(e, &env) {
                    Ok(Value::Scalar(v)) => v,
                    Ok(Value::Unevaluated) => {
                        self.fail("the model is still incomplete".to_string());
                        0.0
                    }
                    Ok(Value::List(_)) => {
                        self.fail(
                            "an ODE right-hand side must be a single number".to_string(),
                        );
                        0.0
                    }
                    Err(e) => {
                        self.fail(describe(&e));
                        0.0
                    }
                },
            };
        }
    }
}

/// Overwrite in place when the key already exists — which, after `new`, it
/// always does. `HashMap::insert` would take ownership of a freshly allocated
/// key on every one of the millions of calls a single solve makes.
fn bind(env: &mut Env, name: &str, value: f64) {
    match env.vars.get_mut(name) {
        Some(slot) => *slot = Value::Scalar(value),
        None => {
            env.set(name, value);
        }
    }
}
