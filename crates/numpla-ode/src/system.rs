//! What a solver integrates.

/// A first-order system `y' = f(t, y)`.
///
/// Deliberately object-safe and allocation-free at the call site: the right
/// hand side writes into a caller-owned buffer, because this is called several
/// times per step and Numpla re-integrates on every edit.
pub trait System {
    fn dim(&self) -> usize;

    /// Write `f(t, y)` into `dy`. `dy.len() == y.len() == self.dim()`.
    fn rhs(&self, t: f64, y: &[f64], dy: &mut [f64]);
}

/// Wraps a closure as a [`System`].
pub struct Field<F> {
    dim: usize,
    f: F,
}

impl<F> Field<F>
where
    F: Fn(f64, &[f64], &mut [f64]),
{
    pub fn new(dim: usize, f: F) -> Self {
        Field { dim, f }
    }
}

impl<F> System for Field<F>
where
    F: Fn(f64, &[f64], &mut [f64]),
{
    fn dim(&self) -> usize {
        self.dim
    }

    fn rhs(&self, t: f64, y: &[f64], dy: &mut [f64]) {
        (self.f)(t, y, dy)
    }
}

impl<S: System + ?Sized> System for &S {
    fn dim(&self) -> usize {
        (**self).dim()
    }

    fn rhs(&self, t: f64, y: &[f64], dy: &mut [f64]) {
        (**self).rhs(t, y, dy)
    }
}

// ---------------------------------------------------------------------------
// Second-order form
// ---------------------------------------------------------------------------

/// A second-order system `q'' = a(t, q, q')`.
///
/// Why a separate trait rather than a flag on [`System`]: the symplectic
/// integrators do not merely *benefit* from knowing which states are positions
/// and which are velocities, they cannot be written at all without it. Velocity
/// Verlet is a kick–drift–kick — half a velocity update, a whole position
/// update, half a velocity update — and each of those three words names one
/// half of the state. A trait makes that requirement a compile-time fact
/// instead of a runtime convention some caller can get wrong, and it lets the
/// acceleration be the thing a physicist actually writes: `a = -k q / m`, not a
/// hand-lowered pair of rows.
///
/// **State layout.** The canonical first-order form of a second-order system is
/// *interleaved*: `[q0, v0, q1, v1, ...]`, each velocity immediately after its
/// position. That is not an arbitrary choice — it is exactly what
/// `numpla-model` produces when it lowers an `x'' = ...` row, and it is the
/// layout every `Float64Array` crossing the wasm boundary already uses. Holding
/// to it is what lets the mode slider swap integrators without the plot's
/// column meanings shifting underneath it. [`Lowered`] presents a second-order
/// system in that form; [`Paired`] goes the other way, back from a lowered
/// first-order system to the structure it came from.
///
/// **On `v` in the signature.** Admitting the velocity is a compromise, made
/// deliberately. A damped row like `x'' = -x - 0.4x'` is ordinary in Numpla, and
/// a signature of `a(t, q)` alone would mean the symplectic methods reject a
/// large part of what people type. The cost is stated rather than hidden: see
/// [`SecondOrderSystem::reads_velocity`].
pub trait SecondOrderSystem {
    /// Degrees of freedom — *half* the length of the state vector.
    fn dof(&self) -> usize;

    /// Write `a(t, q, v)` into `acc`. All three slices have length `dof()`.
    fn accel(&self, t: f64, q: &[f64], v: &[f64], acc: &mut [f64]);

    /// Does the acceleration actually read `v`?
    ///
    /// This is the honesty knob for the Ge–Marsden trade-off. A force that
    /// depends only on position makes each kick and each drift a symplectic map
    /// on its own, so the composition is symplectic and the energy error stays
    /// in a bounded band forever — the property this whole module exists for. A
    /// force that reads velocity (damping, drag, friction) has no such
    /// structure to preserve; the integrator then spends an extra acceleration
    /// evaluation per step to hold on to second order, and promises nothing
    /// about conservation because there is nothing conserved.
    ///
    /// The default is `false` because the overwhelmingly common second-order
    /// row is a force law in `q`, and a default that doubled everyone's cost to
    /// cover the exception would be the wrong trade. Callers that lower text
    /// into systems can answer this exactly rather than guessing: in
    /// `numpla-model` the velocity is a *named* state (`x'`), so the answer is
    /// whether the acceleration row's dependency set contains that name.
    fn reads_velocity(&self) -> bool {
        false
    }
}

impl<S: SecondOrderSystem + ?Sized> SecondOrderSystem for &S {
    fn dof(&self) -> usize {
        (**self).dof()
    }

    fn accel(&self, t: f64, q: &[f64], v: &[f64], acc: &mut [f64]) {
        (**self).accel(t, q, v, acc)
    }

    fn reads_velocity(&self) -> bool {
        (**self).reads_velocity()
    }
}

/// An acceleration written as a plain function rather than a closure over
/// captured parameters. Named because it is the shape that can be stored,
/// compared, and passed around by value — a force law with no state of its own.
pub type AccelFn = fn(f64, &[f64], &[f64], &mut [f64]);

/// Wraps a closure as a [`SecondOrderSystem`]. The counterpart of [`Field`].
pub struct Accel<F> {
    dof: usize,
    f: F,
    reads_velocity: bool,
}

impl<F> Accel<F>
where
    F: Fn(f64, &[f64], &[f64], &mut [f64]),
{
    /// A conservative acceleration: one that ignores its `v` argument. This is
    /// the constructor that yields a genuinely symplectic integration.
    pub fn new(dof: usize, f: F) -> Self {
        Accel {
            dof,
            f,
            reads_velocity: false,
        }
    }

    /// Declare that the acceleration reads velocities — see
    /// [`SecondOrderSystem::reads_velocity`] for what that gives up.
    pub fn reading_velocity(mut self) -> Self {
        self.reads_velocity = true;
        self
    }
}

impl<F> SecondOrderSystem for Accel<F>
where
    F: Fn(f64, &[f64], &[f64], &mut [f64]),
{
    fn dof(&self) -> usize {
        self.dof
    }

    fn accel(&self, t: f64, q: &[f64], v: &[f64], acc: &mut [f64]) {
        (self.f)(t, q, v, acc)
    }

    fn reads_velocity(&self) -> bool {
        self.reads_velocity
    }
}

/// Scratch buffers for the two adapters below.
///
/// They live in a `RefCell` because both trait methods take `&self` — the
/// right-hand side is called several times per step and must not allocate,
/// which is the whole reason [`System::rhs`] writes into a caller-owned buffer
/// in the first place. Numpla is single-threaded (it runs as a wasm module), so
/// a `RefCell` costs a branch and buys the allocation-free promise. The borrows
/// never overlap: each is taken and dropped inside one call.
#[derive(Debug, Default)]
struct Scratch {
    q: Vec<f64>,
    v: Vec<f64>,
    a: Vec<f64>,
}

impl Scratch {
    fn with_dof(dof: usize) -> std::cell::RefCell<Scratch> {
        std::cell::RefCell::new(Scratch {
            q: vec![0.0; dof],
            v: vec![0.0; dof],
            a: vec![0.0; dof],
        })
    }
}

/// A second-order system seen as the first-order system it lowers to.
///
/// `q'' = a(t, q, q')` becomes `q' = v`, `v' = a(t, q, v)` in the interleaved
/// layout described on [`SecondOrderSystem`]. This is what lets a
/// non-structure-preserving method integrate a second-order system with no
/// special case anywhere, and therefore what makes `Method::Tsit5` and
/// `Method::Verlet` interchangeable at one call site.
pub struct Lowered<S> {
    sys: S,
    scratch: std::cell::RefCell<Scratch>,
}

impl<S: SecondOrderSystem> Lowered<S> {
    pub fn new(sys: S) -> Self {
        let scratch = Scratch::with_dof(sys.dof());
        Lowered { sys, scratch }
    }

    pub fn inner(&self) -> &S {
        &self.sys
    }
}

impl<S: SecondOrderSystem> System for Lowered<S> {
    fn dim(&self) -> usize {
        2 * self.sys.dof()
    }

    fn rhs(&self, t: f64, y: &[f64], dy: &mut [f64]) {
        let mut s = self.scratch.borrow_mut();
        let dof = self.sys.dof();
        let Scratch { q, v, a } = &mut *s;
        for i in 0..dof {
            q[i] = y[2 * i];
            v[i] = y[2 * i + 1];
        }
        self.sys.accel(t, q, v, a);
        for i in 0..dof {
            dy[2 * i] = v[i];
            dy[2 * i + 1] = a[i];
        }
    }
}

/// Why a first-order system could not be read back as a second-order one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StructureError {
    /// The pairing does not cover the state vector exactly once.
    NotAPartition { dim: usize, pairs: usize },
    /// A pair names a state that does not exist.
    IndexOutOfRange { index: usize, dim: usize },
    /// The pairing is not the canonical interleaving `(0,1), (2,3), ...`.
    ///
    /// Rejected rather than permuted around, on purpose: a solution's column
    /// order is public — it is what the plotter and the wasm boundary read — so
    /// silently reordering it to suit one integrator would make the same state
    /// vector mean different things under different methods. Every
    /// all-second-order document `numpla-model` compiles is already
    /// interleaved, because it pushes each lowered velocity directly after its
    /// position; a document that fails this check is one with unpaired
    /// first-order rows mixed in, which is not a second-order system at all and
    /// has no symplectic structure to preserve.
    NotInterleaved { dof: usize, got: (usize, usize) },
}

impl std::fmt::Display for StructureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StructureError::NotAPartition { dim, pairs } => write!(
                f,
                "{} position/velocity pairs cannot cover {} states",
                pairs, dim
            ),
            StructureError::IndexOutOfRange { index, dim } => {
                write!(f, "state index {} is out of range for {} states", index, dim)
            }
            StructureError::NotInterleaved { dof, got } => write!(
                f,
                "degree of freedom {} is paired as {:?}, expected ({}, {})",
                dof,
                got,
                2 * dof,
                2 * dof + 1
            ),
        }
    }
}

impl std::error::Error for StructureError {}

/// A lowered first-order system read back as the second-order one it came from.
///
/// This is the bridge from `numpla-model`, which turns `x'' = ...` into a pair
/// of states — position, then velocity — before this crate ever sees it. The
/// caller states the pairing it produced and this checks it, rather than this
/// inferring one from an even dimension: three first-order rows plus one
/// second-order row also make an even state count, and pairing that up blindly
/// would integrate a system nobody wrote.
pub struct Paired<S> {
    sys: S,
    dof: usize,
    reads_velocity: bool,
    scratch: std::cell::RefCell<(Vec<f64>, Vec<f64>)>,
}

impl<S: System> Paired<S> {
    /// `pairs[i]` is the `(position, velocity)` state index of degree of
    /// freedom `i`.
    pub fn new(sys: S, pairs: &[(usize, usize)]) -> Result<Self, StructureError> {
        let dim = sys.dim();
        if pairs.len() * 2 != dim {
            return Err(StructureError::NotAPartition {
                dim,
                pairs: pairs.len(),
            });
        }
        for (i, &(p, v)) in pairs.iter().enumerate() {
            for index in [p, v] {
                if index >= dim {
                    return Err(StructureError::IndexOutOfRange { index, dim });
                }
            }
            if (p, v) != (2 * i, 2 * i + 1) {
                return Err(StructureError::NotInterleaved { dof: i, got: (p, v) });
            }
        }
        Ok(Paired {
            sys,
            dof: pairs.len(),
            // Conservative by default, matching the trait: the caller opts in
            // to the truth about its own rows.
            reads_velocity: false,
            scratch: std::cell::RefCell::new((vec![0.0; dim], vec![0.0; dim])),
        })
    }

    /// The common case: every state is already a `(2i, 2i+1)` pair.
    pub fn interleaved(sys: S) -> Result<Self, StructureError> {
        let dof = sys.dim() / 2;
        let pairs: Vec<(usize, usize)> = (0..dof).map(|i| (2 * i, 2 * i + 1)).collect();
        Paired::new(sys, &pairs)
    }

    /// See [`SecondOrderSystem::reads_velocity`].
    pub fn reading_velocity(mut self) -> Self {
        self.reads_velocity = true;
        self
    }
}

impl<S: System> SecondOrderSystem for Paired<S> {
    fn dof(&self) -> usize {
        self.dof
    }

    fn accel(&self, t: f64, q: &[f64], v: &[f64], acc: &mut [f64]) {
        let mut s = self.scratch.borrow_mut();
        let (y, dy) = &mut *s;
        for i in 0..self.dof {
            y[2 * i] = q[i];
            y[2 * i + 1] = v[i];
        }
        self.sys.rhs(t, y, dy);
        // Only the velocity rows are read back. The position rows are `q' = v`
        // by construction, and re-deriving them here would be asking the
        // expression evaluator to confirm arithmetic we already know.
        for i in 0..self.dof {
            acc[i] = dy[2 * i + 1];
        }
    }

    fn reads_velocity(&self) -> bool {
        self.reads_velocity
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spring() -> Accel<AccelFn> {
        Accel::new(1, |_t, q: &[f64], _v: &[f64], a: &mut [f64]| a[0] = -q[0])
    }

    #[test]
    fn lowering_produces_the_interleaved_first_order_form() {
        let sys = Lowered::new(spring());
        assert_eq!(sys.dim(), 2);
        let mut dy = [0.0; 2];
        sys.rhs(0.0, &[0.5, -2.0], &mut dy);
        assert_eq!(dy, [-2.0, -0.5]);
    }

    /// The round trip that matters: what `numpla-model` hands over is a
    /// first-order system in the lowered layout, and reading it back as a
    /// second-order one must recover the same acceleration.
    #[test]
    fn pairing_recovers_the_acceleration_a_lowering_hid() {
        let lowered = Field::new(2, |_t, y: &[f64], dy: &mut [f64]| {
            dy[0] = y[1];
            dy[1] = -y[0];
        });
        let sys = Paired::interleaved(lowered).unwrap();
        assert_eq!(sys.dof(), 1);
        let mut a = [0.0];
        sys.accel(0.0, &[0.5], &[-2.0], &mut a);
        assert_eq!(a, [-0.5]);
    }

    #[test]
    fn a_pairing_that_is_not_the_lowered_layout_is_refused() {
        let sys = Field::new(4, |_t, _y: &[f64], dy: &mut [f64]| dy.fill(0.0));
        // Positions first, velocities after — a perfectly sensible layout, and
        // not the one the rest of the product speaks.
        let r = Paired::new(sys, &[(0, 2), (1, 3)]);
        assert_eq!(
            r.err().unwrap(),
            StructureError::NotInterleaved {
                dof: 0,
                got: (0, 2)
            }
        );
    }

    #[test]
    fn a_pairing_that_leaves_states_out_is_refused() {
        let sys = Field::new(3, |_t, _y: &[f64], dy: &mut [f64]| dy.fill(0.0));
        let r = Paired::new(sys, &[(0, 1)]);
        assert_eq!(
            r.err().unwrap(),
            StructureError::NotAPartition { dim: 3, pairs: 1 }
        );
    }

    #[test]
    fn velocity_dependence_is_opt_in_and_survives_both_adapters() {
        assert!(!spring().reads_velocity());
        let zero: AccelFn = |_t, _q, _v, a| a[0] = 0.0;
        assert!(Accel::new(1, zero).reading_velocity().reads_velocity());
        let sys = Field::new(2, |_t, _y: &[f64], dy: &mut [f64]| dy.fill(0.0));
        assert!(Paired::interleaved(sys).unwrap().reading_velocity().reads_velocity());
    }
}
