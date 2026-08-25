# Vector fields and seeds

Two views of the same idea: a differential equation is a **field of arrows**, and
a solution is what you get by dropping a point into it and letting go.

Right now Numpla only ever shows the second half, for exactly one starting
point — the one the document happens to declare. That is the smallest possible
sample of what the equation says.

## 1. The field

A new view, `field`, alongside `t–y`, `phase` and `polar`, and toggled the same
way. It draws the right-hand side as arrows on the phase plane:

- Available when the document has **exactly two states** — the same condition
  `phase` already uses, and for the same reason: the plane has two axes.
- Arrows on a grid across the visible window. Direction is what matters, so
  normalise the length and show magnitude by shade — a field where one corner is
  a thousand times faster than another is unreadable if arrows scale with speed.
- It is drawn **under** the trajectories. The curves are the answer; the field
  is the question.
- Because the window is the query, the grid follows the window: pan and the
  arrows are recomputed for where you are looking.

Non-autonomous systems (`x'` depending on `t`) have a field that changes with
time. Sample it at the start of the window and say so rather than pretending
otherwise.

## 2. Seeds

A **seed** is a starting point you place yourself. Each one gets its own
trajectory, integrated over the same window, drawn in the same frame.

- The document's own initial conditions are seed zero, and it is not special.
- Click on the plane to add a seed; drag one to move it and the trajectory
  follows live; remove one you no longer want.
- Seeds are a *view* of the model, not a change to it — placing one must not
  rewrite the document. (Promoting a seed into the document's initial condition
  is a natural next step, but not this one.)

This is what makes a phase portrait a portrait rather than a single curve, and
it is the cheapest possible version of "what does this system do in general?".

## Contract

Extends `docs/wasm-api.md`.

```rust
/// The right-hand side sampled on a grid across [x0,x1] x [y0,y1], at time `t`.
///
/// Flat, row-major, four numbers per sample: [x, y, dx, dy] * (nx * ny).
/// Empty when the document does not have exactly two states, or does not
/// compile. Never throws.
pub fn vector_field(&self, x0: f64, x1: f64, y0: f64, y1: f64,
                    nx: usize, ny: usize, t: f64) -> Vec<f64>;

/// One trajectory from an explicit starting state, sampled uniformly.
///
/// Flat: [t, y_0 .. y_{dim-1}] * n, the same layout as `sample`. Does NOT
/// disturb the stored solution — the document's own curve is untouched, so a
/// seed costs nothing but its own integration. Taking `&self` rather than
/// `&mut self` is what makes that a fact the compiler enforces rather than a
/// promise in a comment.
///
/// `y0.len()` must equal the state count; a mismatch returns empty rather than
/// throwing. Obeys the same stop-early rule as `solve`: a seed that blows up
/// returns the part that worked, and the last sample says where it stopped.
pub fn trajectory_from(&self, t0: f64, t1: f64, method: &str,
                       y0: &[f64], n: usize) -> Vec<f64>;
```

Both are additive; nothing existing changes shape.

`vector_field` should evaluate the same right-hand side the solver uses, through
the same path — a field drawn from a second, subtly different evaluation would
be a lie about the system being integrated.
