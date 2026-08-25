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
- [ ] Velocity Verlet + Yoshida4 (makes the conservation demo work)
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

---

## Known bugs

### Implicit multiplication loses to function-call syntax on `^`

`g (y - x)^3` evaluates as `(g*(y-x))^3`, not `g*(y-x)^3`. At `g=40, y-x=-1`
that is `-64000` instead of `-40`.

Cause: an identifier followed by `(` is parsed as `Expr::Call`, because the
parser cannot yet know whether `g` is a function or a coefficient. The exponent
then attaches to the whole call node, and eval's "not a function, so multiply"
fallback happens *inside* the cube. The fallback itself is right — ordinary
notation needs `2(x+1)` — but it silently changes precedence.

Found by benchmarking two spellings of the same physics against each other and
noticing the trajectories diverged. It is dangerous precisely because nothing
errors: you get a plausible curve of the wrong system.

Fix: resolve call-vs-coefficient with knowledge of which names are functions.
`numpla-model` already collects the `f(u) = ...` rows, so the shape is a
two-pass compile — gather definitions, then build expression trees with the
function set in hand. Until then, parenthesise: `g ((y-x)^3)`.

### `rand()` has no call-site identity

Two separate `rand()` calls in one document draw the same value, because the
evaluator has no notion of where a call sits in the tree. `numpla-noise`
already exports `rand_at(seed, index)` and `derive_seed(doc, site)`; what is
missing is the document layer assigning a stable index per call site.


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
