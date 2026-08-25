# M2 — Solver selection

Research notes and decisions for `numpla-ode`. Sources at the bottom.

## The constraint that shapes everything: dense output is not optional

Numpla has a global time scrubber. Scrubbing means evaluating the solution at
arbitrary `t`, not at whatever points the stepper happened to land on. So every
integrator we ship must carry a **continuous extension (dense output)** of
adequate order. This filters the candidate list before accuracy does — a method
without a good interpolant is disqualified no matter how efficient it is.

It pays for itself twice: dense output is also the standard basis for **event
detection**. The robust recipe is to interpolate the event function at the same
order as the method, test for sign changes across the step, subdivide to bracket
a root, then root-find. Contact, bounces, thresholds, and Poincaré sections all
fall out of that one mechanism.

## Non-stiff default: Tsit5, not Dormand–Prince

DP5 is the familiar default (SciPy `RK45`, MATLAB `ode45`), but Tsitouras 5(4)
is the better modern choice and is what the SciML ecosystem defaults to. Same
6 stages and comparable stability, but its leading error coefficient is roughly
an order of magnitude smaller — free accuracy at identical cost per step.

- **Default:** Tsit5, adaptive, with its 4th-order interpolant
- **Tight tolerance:** a Verner method (6/7/8) when the user asks for accuracy
- **Not DP5**, except possibly as a named option for people who want to
  reproduce `ode45` results exactly

## Stiff: Rodas5P first, Radau in reserve

- **Rodas5P** — 5th order A-stable, stiffly stable Rosenbrock, and crucially it
  ships a **stiff-aware 4th-order interpolant**. That interpolant is why it wins
  here: it satisfies the scrubbing requirement natively. Best at the medium
  tolerances real interactive work uses.
- **Radau IIA** — fully implicit, dominant at extreme tolerances (1e-13). Worth
  having, but it is not the interactive default.
- **ESDIRK** (KenCarp4 / TRBDF2) — close to the best performers and simpler to
  implement than Radau. Reasonable as the *first* stiff method we write if
  Rodas5P proves slow to get right.

Auto-detection of stiffness (switching between Tsit5 and Rodas5P on the fly)
should come later; first make the mode slider able to select the method, which
is exactly the general mechanism already decided on.

## Structure-preserving: pick your conservation law, you cannot have all three

The key negative result: **a fixed-step integrator cannot simultaneously
preserve the symplectic form, momentum, and energy** for a non-integrable
system. This is a theorem, not an implementation gap. Consequences for us:

- **Symplectic (Verlet, Yoshida4, Gauss–Legendre)** — preserves the symplectic
  form and momentum. Energy does not drift secularly; it oscillates in a bounded
  band forever. This is what you want for long orbital and oscillator runs, and
  it is the right default for anything expressed as a Hamiltonian.
- **Variational integrators** — a subset of symplectic methods, derived by
  discretising the action rather than the equations. They preserve momenta from
  symmetries exactly (Noether at the discrete level). The right frame for
  mechanical systems built from a Lagrangian.
- **Energy-preserving (discrete gradient / average vector field)** — conserves
  energy exactly, gives up the symplectic form.
- **Adaptive-step variational integrators** — the way to get energy *and*
  structure, by letting the step size absorb the obstruction. Recent literature
  is active here; a good later addition, not a first target.

**This is a feature, not a footnote.** The conservation monitor plus a mode
slider that swaps integrator makes the Ge–Marsden trade-off something you *see*:
same system, three integrators, three different lies. That is the single best
piece of numerical-methods intuition the software can hand someone, and it needs
no explanation text — just a slider and a drifting line.

## Coupling: use the port-Hamiltonian formalism

This is the strongest find, because it answers a design question that was still
open — how systems couple.

Port-Hamiltonian systems describe a physical system by an energy function plus
*ports* through which power flows. The decisive property: **the class is closed
under power-conserving interconnection.** Couple two pH systems and you get a
pH system, whose Hamiltonian is the **sum** of the component Hamiltonians and
whose dissipation is the union of theirs.

What that buys Numpla, concretely:

- Coupling mechanical + electrical + fluid subsystems is well-defined rather
  than ad hoc, and it is *modular* — exactly the "attach A to B and see what
  happens" workflow.
- Feedback loops are ordinary interconnections, not a special case.
- The conservation monitor gets its quantity for free: total energy of a coupled
  model is the sum of parts, so drift is meaningful across an arbitrary network.
- Passivity is preserved, which means coupled models stay numerically sane
  instead of exploding for structural reasons.

Recommendation: make **energy the native currency of coupling**. A system
declares a Hamiltonian and its ports; wiring outputs to inputs is a
power-conserving interconnection. Plain `x' = f(x,t)` rows stay fully supported
for everything that is not energy-based — but when a model *is* physical, the pH
path gives correctness that ad hoc signal-wiring cannot.

## Found while implementing: `dt_max` must not default to infinity

Every adaptive method shares this failure mode, and it bit the first test
written against Tsit5. Starting on a flat stretch of solution, the controller
grows the step geometrically (10x per accepted step at default settings) and
can **leap clean over a narrow feature**. The error estimate never sees the
bump because the method never lands on it.

Demonstrated concretely in `narrow_features_can_be_stepped_over_without_a_step_cap`: integrating a Gaussian pulse of width ~0.3 over t in [0, 10] with
`dt_max = inf` misses the pulse almost entirely; capping at `dt_max = 1.0`
resolves it to 1e-6.

Product consequence: **`dt_max` must default to something tied to the visible
time window**, not to infinity, or a user can plot a pulse the solver never
notices. A silently-wrong plot is far worse than a slow one. The plotter should
set `dt_max` from the width of the t-axis it is about to draw.

## Implementation order for M2

1. `System` trait + state vector, with dense output in the interface from day
   one, not bolted on
2. Tsit5 adaptive + interpolant  ← unblocks the M4 vertical slice
3. Step telemetry as data (accepted/rejected/local error) — feeds the telemetry
   strip and the save file
4. Velocity Verlet + Yoshida4 (cheap, and they make the conservation demo work)
5. Event detection on the dense output
6. Rodas5P or an ESDIRK for stiffness
7. Port-Hamiltonian system type + interconnection
8. Later: adaptive variational, automatic stiffness switching, Radau

## Sources

- [OrdinaryDiffEqTsit5 — SciML](https://docs.sciml.ai/OrdinaryDiffEq/stable/explicit/Tsit5/)
- [Notes on Algorithms — SciML Developer Documentation](https://docs.sciml.ai/DiffEqDevDocs/stable/internals/notes_on_algorithms/)
- [ODE Solvers — DifferentialEquations.jl](https://docs.sciml.ai/DiffEqDocs/stable/solvers/ode_solve/)
- [Differences Between Methods for Solving Stiff ODEs](https://www.stochasticlifestyle.com/differences-between-methods-for-solving-stiff-odes/)
- [A Fully Adaptive Radau Method](https://arxiv.org/pdf/2412.14362)
- [Performance Assessment of Energy-preserving, Adaptive Time-step Variational Integrators](https://arxiv.org/pdf/2108.05420)
- [Energy-preserving Variational Integrators for Forced Lagrangian Systems](https://arxiv.org/pdf/1801.04996)
- [Structure and structure-preserving algorithms for plasma physics](https://pubs.aip.org/aip/pop/article/24/5/055502/991344/Structure-and-structure-preserving-algorithms-for)
- [Port-Hamiltonian Systems Theory: An Introductory Overview](https://people.math.ethz.ch/~hiptmair/Seminars/PHS_24/VSJ14.pdf)
- [Port-Hamiltonian multibody dynamics: consistent interconnection, structure-preserving simulation](https://arxiv.org/pdf/2603.12841)
- [Benchmarks — heyoka (dense output and event detection)](https://bluescarni.github.io/heyoka/benchmarks.html)
- [ODE Event Location — MATLAB](https://www.mathworks.com/help/matlab/math/ode-event-location.html)
