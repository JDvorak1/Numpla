# Numpla — Vision Notes

Maple-class math, Desmos-class feel. Local-first, WebAssembly. Physical-modeling
oriented: couple things together, see the result instantly, get ideas from the
feedback loop.

## Priority ranking (user, 2026-08-25)

1. **Live graphing** — the spine. Everything is seen, not printed.
2. **Differential equations** — both continuous solvers AND discrete/stepwise
   simulation of the same system. Must be able to couple multiple systems and
   watch the coupled result.
3. **Code export** — out to Python (NumPy/SciPy/JAX/Torch); import back.
4. **CAS** — lives in its own small UI element *below* the plotted equations,
   not as the main surface. Simplify/solve/diff/integrate on demand.
5. **Data input** — KNIME-like ease. Visual, node-ish, no boilerplate.
6. **Prob/stats + easy conditionals** — `if` statements must be trivial to write
   inline in expressions.
7. **Matrices/vectors where entries are functions of coordinates** — not just
   constant matrices. Field-valued matrices: each entry f(x,y,z,t). This is a
   hard requirement, not a nice-to-have.

Everything else (ML, quant, autodiff, optimizers) is welcome but secondary.

## Hard requirements called out

- **Render to sound** button: takes a *time* signal and an *amplitude* signal
  and renders actual audio. NOT the Desmos model (sine wave whose pitch tracks
  the y-axis). Real waveform → real samples → playback/export.
- Coupling experiments must be first-class: attach system A's output to system
  B's input by name and immediately see/hear the joint behavior.
- Instant feedback is the product. Sub-frame recompute on edit.

## Focus for phase 1

Simulation + differential equations. Build the plotting and the solver/stepper
core first; CAS, data pipeline, and export layer hang off it.

## Decisions — round 2

**Rejected: a hardcoded continuous/discrete toggle.** Special-casing it is
backwards. Instead: a generic **mode slider** — a slider bound to *any* object's
mode enum, which cycles through that object's modes. The user builds their own
before/after comparison in seconds. Same mechanism serves solver choice, plot
style, boundary condition, anything with discrete alternatives. General
mechanism > built-in feature.

**Feedback loops are the point.** Introducing feedback (output of a system fed
back into its own or another's input) must be trivial and visible. Whatever
coupling model we pick is judged on how cheap a feedback loop is to write.

**Discrete solver must be state of the art.** Not a toy Euler/RK4. Follow the
current research literature on discrete/structure-preserving integrators.

**Global time scrubber: yes, but user-configured, not magic.** Setting up a
shared `t` across systems must be a two-second action. Ship **demo documents**
that show off the coupling/scrubbing/sound workflows — demos are part of the
product, not marketing.

**Audio UI is deliberately tucked away.** Path: hover an equation's dropdown
(or the graph) → hover "Other" → click "Hear" → panel opens with bounds and
render settings → "Listen" plays until the user hits exit. Not a button sitting
on the surface.

**Confirmed:** field-valued matrices (5), phase portraits with symbolic
Jacobian classification (6), ghost-trail parameter sweeps (7), conservation
monitor (8). Conservation/telemetry data must also be **exportable to a save
file format**.

## UX north star

Desmos-quality LaTeX editing. That editing experience is the benchmark to beat;
nothing ships that makes typing math feel worse than Desmos does.

## Decisions — round 3 (UX)

Confirmed: type-through LaTeX (1), gray-not-red errors (2), expression list as
document with folders (3), slider-as-offer incl. mode slider (4), draggable
points that write back (6), one universal row dropdown (7), unified undo across
canvas + text + layout (10).

**Seeding.** Dragged points double as *seeds* for trajectories. Need a clean way
to mark one as a seed — likely right-click → "use as seed". A seed is a live
object: move it, the trajectory re-integrates.

**Seed paths are reusable signals.** A seed's trajectory must be projectable as
two separate graphs, x(t) and y(t), and those projections must themselves be
usable as *inputs* to other expressions. Trajectory → signal → drives another
system → (→ audio). This closes the feedback loop story.

**Assignment is multi-path.** Naming something is possible three ways, all
equivalent: type `f =`, type `f(x) =`, or right-click any object → "assign to
variable". Never one blessed syntax.

**Converters are a core feature, not a utility drawer.** The plotter (and every
object dropdown) offers many conversions so a function of (x, y, t) can be
rapidly reshaped into anything else. Speed of transformation IS the idea-
generation loop.

**CAS solve is dual-engine.** Every solve tries symbolic/algebraic first, and
can fall back to (or be explicitly switched to) a numerical search for roots.
The user picks, or takes whichever lands. Numeric results are labeled as such.
