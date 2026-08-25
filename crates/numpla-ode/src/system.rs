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
