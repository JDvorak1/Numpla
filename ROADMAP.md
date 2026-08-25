# Numpla — Roadmap

Ordering principle: build the **vertical slice** that proves the product, not
horizontal layers. The slice is —

> Type `x' = -y`, `y' = x` into the expression list. It integrates. The phase
> portrait draws. Drag the seed point; the trajectory re-integrates live.

Nothing else ships until that works, because that loop *is* Numpla.

---

## M0 — Scaffold  (in progress)

- [x] Repo, git, docs (VISION.md, ROADMAP.md)
- [x] Cargo workspace + crate split
- [ ] TS app shell (Vite), WASM build wired
- [ ] `cargo test` green  ← blocked on Rust toolchain install

## M1 — Expression core  (`numpla-expr`)

Everything downstream is an AST walk, so this lands first.

- Tokenizer: numbers, idents, operators, implicit multiplication (`2x`, `xy`)
- Pratt parser -> AST, error-tolerant (partial parse returns a hole, not a fail)
- Eval with an environment; scalar + vector + matrix values
- Derivative-notation parsing: `x'`, `x''`, `dx/dt`
- Dependency extraction (which names does this row read?) -> the graph that
  drives recompute and the hover-to-highlight UX

## M2 — Solvers  (`numpla-ode`)

- `System` trait: state vector, rhs, optional Jacobian
- Continuous: Dormand-Prince RK45 adaptive, dense output (needed for scrubbing)
- Continuous stiff: Radau IIA or ESDIRK
- Discrete/structure-preserving: symplectic (Verlet, Yoshida4) + a modern
  variational/geometric integrator per current literature
- Step telemetry out of the solver as data (accepted/rejected/local error) ->
  feeds the M8 telemetry strip and the save-file export
- Event detection (zero crossings) — needed for anything with contact

## M3 — Render  (`numpla-plot`)

- WebGL2 first (WebGPU behind a flag later)
- Trajectory polylines, vector fields, implicit curves (marching squares)
- Camera: pan/zoom that never drops a frame; LOD on field density

## M4 — The slice

Wire M1+M2+M3 through `numpla-wasm` to a minimal TS shell. Plain-text input at
this stage. This is the milestone that either feels right or doesn't.

## M5 — Editing UX

- Type-through LaTeX editor (the Desmos benchmark)
- Expression list: rows, folders, color chips, drag-reorder
- Gray-not-red errors
- Slider-as-offer, incl. mode slider
- Unified undo stack across text + canvas + layout

## M6 — Seeds & coupling

- Draggable points write back to source
- Right-click -> "use as seed"
- Seed trajectory -> projectable to x(t), y(t) as reusable input signals
- Named coupling between systems; feedback loops must be one line

## M7 — Converters

The dropdown menu of transforms (slice, project, differentiate, sample, FFT,
level set, to-field, to-matrix, to-data, freeze, ...). This is the
idea-generation engine.

## M8 — Instrumentation & output

- Phase portrait pane: nullclines, fixed points classified via symbolic Jacobian
- Ghost-trail parameter sweeps
- Conservation monitor + step telemetry strip
- Save-file format for telemetry/results
- Hear panel (hover -> Other -> Hear -> bounds -> Listen -> exit)

## M9 — CAS pane  (`numpla-cas`)

- e-graph rewriting (`egg`) for simplify/expand/factor
- Symbolic diff/integrate, limits
- Dual-engine solve: algebraic first, numeric search fallback, results labeled

## M10 — Data & export

- KNIME-ish data input pipeline
- Python export (NumPy/SciPy) that reads hand-written; import round-trips

---

## Crate split (published separately)

| crate | contents |
|---|---|
| `numpla-expr` | tokenizer, parser, AST, eval, dependency graph |
| `numpla-autodiff` | forward + reverse mode over the AST |
| `numpla-linalg` | matrices whose entries are functions of coordinates |
| `numpla-ode` | integrators, telemetry, events |
| `numpla-cas` | e-graph rewriting, symbolic calculus, dual-engine solve |
| `numpla-plot` | GPU rendering primitives |
| `numpla-wasm` | wasm-bindgen boundary (thin; no logic) |
