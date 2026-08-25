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

## M9 — CAS pane  (`numpla-cas`)  (built, in its honest scope)

Brought forward by v6: the start screen offers "compute" beside "solve &
simulate", so the pane had to be real before the rest of the milestone.

- [x] `simplify` — arithmetic folding, identity and zero laws, like terms,
      canonical ordering of commutative operands
- [x] `diff` — sum, product, quotient, chain and power rules (including
      `x^x`), and every builtin `numpla-expr` can evaluate
- [x] `expand` — products over sums, small integer powers of sums
- [x] `subs` and numeric evaluation, with the document's functions and
      parameter values in scope
- [x] The property test that makes it trustworthy: every rewrite is evaluated
      before and after at many pseudo-random points, every result round-trips
      through the parser, and every symbolic derivative is checked against a
      Richardson-extrapolated central difference
- [x] `cas_simplify` / `cas_diff` / `cas_expand` / `cas_eval` across the WASM
      boundary — see `docs/wasm-api.md`

Deliberately **not** built, and there is no function to call for any of them:
symbolic integration, equation solving, limits, series, symbolic matrices. The
reasons are in the `numpla-cas` crate docs. Hand-written rewriting rather than
e-graphs (`egg`), because the crate depends only on `numpla-expr` — an external
rewriting engine would be a second, unverified notion of what an expression is.

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

- **An ODE row reading a derived row compiled clean and refused to solve.**
  The probe pass binds derived rows before probing, so `x' = -E` with
  `E = 0.5x^2` reported no issues — and then `ModelSystem` never bound them,
  so the same document failed at solve time with "the model is still
  incomplete". `ModelSystem` now evaluates the derived rows the right-hand
  sides actually read (usually none, so the hot loop pays nothing), and
  `reads_velocity` follows derived rows too, so damping hidden behind a name
  is still reported as damping.
- **A NaN error estimate froze the adaptive step in place.** Only the FSAL
  stage evaluates at `y_new` itself, so a right-hand side that goes NaN
  exactly there poisons the error estimate while the state stays finite —
  and the PI formula on NaN left `dt` unchanged, replaying the same failing
  attempt until `max_steps` burned out. A non-finite estimate now rejects the
  attempt and shrinks the step directly.
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
| `numpla-cas` | simplify, differentiate, expand, substitute — value-preserving by test |
| `numpla-plot` | GPU rendering primitives |
| `numpla-wasm` | wasm-bindgen boundary (thin; no logic) |
