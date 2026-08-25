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
- [x] `cargo test` green — 76 tests, clippy clean
- [x] Browser shell + WASM build wired

## M1 — Expression core  (`numpla-expr`)  — done

Everything downstream is an AST walk, so this lands first.

- Tokenizer: numbers, idents, operators, implicit multiplication (`2x`, `xy`)
- Pratt parser -> AST, error-tolerant (partial parse returns a hole, not a fail)
- Eval with an environment; scalar + vector + matrix values
- Derivative-notation parsing: `x'`, `x''`, `dx/dt`
- Dependency extraction (which names does this row read?) -> the graph that
  drives recompute and the hover-to-highlight UX

## M2 — Solvers  (`numpla-ode`)

Selection and rationale in `docs/solvers.md`.

- [x] `System` trait, allocation-free right-hand side
- [x] Tsit5 adaptive with PI step control and Hairer automatic initial step
- [x] Dense output (4th-order continuous extension) — in the interface from day
      one, because scrubbing needs `solution(t)`, not a list of samples
- [x] `Solution::eval` / `sample` — binary search + interpolation
- [x] Step telemetry as data (accepted/rejected/local error, per attempt)
- [x] Velocity Verlet + Yoshida4 — fixed step, symplectic, with cubic-Hermite
      dense output so `Solution::eval` works the same whichever method ran
- [x] `SecondOrderSystem` trait (`q'' = a(t, q, v)`), reachable from the
      lowered position/velocity pairs `numpla-model` already produces
- [x] `Method` selection over one state layout — what the mode slider drives
- [x] Conservation measurement: any invariant sampled along a solution, plus
      the drift statistics the conservation monitor plots
- [ ] Event detection on the dense output
- [ ] Rodas5P or an ESDIRK for stiffness
- [ ] Port-Hamiltonian system type + power-conserving interconnection
- [ ] `dt_max` defaulted from the visible time window (see solvers.md)


## M3 — Render  (`numpla-plot`)

- WebGL2 first (WebGPU behind a flag later)
- Trajectory polylines, vector fields, implicit curves (marching squares)
- Camera: pan/zoom that never drops a frame; LOD on field density

## M4 — The slice  — done, runs in the browser

Wired M1+M2 through `numpla-model` and `numpla-wasm` to a plain ES-module
shell in `app/`. Type a system, watch it integrate, drag time.

- [x] `numpla-model` — text document to `System`, diagnostics, JSON wire shapes
- [x] `numpla-wasm` — thin marshalling layer, contract in `docs/wasm-api.md`
- [x] Eased loading screen; failures reported on it rather than hanging
- [x] Canvas time plot + phase plane, HiDPI
- [x] Scrubber dock with play/pause, driven by `Solution::eval`
- [x] Gray-not-red diagnostics carried all the way from the evaluator to the UI
- [ ] Replace the plain textarea with the real editor (M5)


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

## M8 — Instrumentation  (in progress)

- [x] Derived rows: `E = 0.5(x'^2 + x^2)` is a function of the solution, not an
      error. Drawn dashed beside the states.
- [x] Conservation monitor: drift measured against the initial value, reported
      as a secular ratio (band over the last tenth of the run against the
      first). Around 1 is a bounded band; well above 1 is a real drift.
- [x] Integrator selection reaches the browser, and a symplectic method asked of
      a document with no second-order structure is refused by name rather than
      silently falling back.
- [x] `energy-drift` demo, whose physics check asserts the contrast itself:
      Verlet and Yoshida4 under 1.5, Tsit5 above 2.
- [ ] Step telemetry strip (accepted/rejected/local error along the run)
- [ ] Save-file format for telemetry and results

## Testing

Four suites, and the fourth is the one that matters most:

| suite | proves |
|---|---|
| `cargo test` | the Rust core |
| `app/mathfield.test.mjs` | the editor's model and serialisation |
| `app/demos.test.mjs` | every demo against the real WASM, with physics |
| `app/audio.test.mjs` | rendering produces the actual signal |
| `app/integration.test.mjs` | **the app** — boots `main.js` against the real WASM from the real `index.html` |

The integration suite exists because every bug reported from outside so far —
the demo loader doing nothing, the `t` slider being inert — was invisible to the
unit suites. Each part worked; the seam between them did not. It builds its DOM
by reading `index.html` rather than by hand-mounting elements, so it cannot
quietly go stale, and a `getElementById` with no matching id fails there instead
of in a browser.

---

## Known bugs

None outstanding.

Fixed:

- **Implicit multiplication lost to function-call syntax on `^`.** `g (y - x)^3`
  parsed as `(g*(y-x))^3`, silently integrating a different system. Resolved by
  the two-pass compile in `numpla-model`: gather the `f(u) = ...` definitions,
  then build the trees with the function set in hand
  (`numpla_expr::parse_with`). A name that is not a function and is followed by
  `(` is implicit multiplication, at multiplication precedence.
- **`rand()` had no call-site identity.** Two `rand()`s in one document drew the
  same number. `numpla-model` now names each call site — hashed from the row's
  handle and the position of the call within it, so an unrelated edit does not
  reshuffle anyone's stream — and folds the draw to a literal, since it cannot
  depend on `t` or the state.


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
