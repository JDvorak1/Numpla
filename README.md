# Numpla

### ▶ **[Run it — jdvorak1.github.io/Numpla](https://jdvorak1.github.io/Numpla/)**

Maple-class math with Desmos-class feel. Local-first, WebAssembly, built for
physical modelling: couple systems together, see and *hear* the result
instantly. Everything runs in your browser — there is no server, and nothing
you type leaves the machine.

- **[VISION.md](VISION.md)** — what this is and what it refuses to be
- **[ROADMAP.md](ROADMAP.md)** — build order, milestone by milestone
- **[docs/hosting.md](docs/hosting.md)** — how the site is built and published

## What it does

Write a system of differential equations as mathematics, not as code, and watch
it solve as you type.

- **The window is the query.** What is on screen is what gets integrated, at the
  resolution the screen can show. Pan or zoom and it re-solves.
- **One plot**, with `t–y`, phase, polar and the vector field overlapping in a
  single frame — each one a switch you turn on or off.
- **Seeds**: drop starting points on the phase plane and watch their
  trajectories. They are a view of the model, never an edit to it.
- **Discrete or continuous**, one click apart. An adaptive Runge–Kutta against
  fixed-step symplectic methods — and with an energy row on screen you can watch
  one of them hold energy in a band forever while the other walks away.
- **Derived rows**: `E = 0.5(x'^2 + x^2)` is a function of the solution, drawn
  dashed, reporting whether it is holding or drifting.
- **Hear it.** Any state can be rendered to real audio samples — not a sine wave
  whose pitch follows a curve, the actual signal.
- **It does not mind blowing up.** A run that hits a singularity draws the part
  that worked and says where it stopped.

Thirteen worked demos, from a plucked string to colliding strings to Lorenz.

## Status

The vertical slice works end to end and is tested at every layer: 234 Rust
tests, 912 math-field assertions, 93 demo assertions with real physics checks,
35 audio assertions, and an integration suite that boots the real app against
the real WebAssembly. See [ROADMAP.md](ROADMAP.md) for what is done and what is
next.

## Build

Requires the Rust toolchain (not yet installed on this machine):

```
winget install Rustlang.Rustup
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
```

Then:

```
cargo test
```

## Layout

```
crates/
  numpla-expr      tokenizer, parser, AST, eval, dependency graph
  numpla-ode       integrators, telemetry, event detection
  numpla-linalg    matrices whose entries are functions of coordinates
  numpla-autodiff  forward + reverse mode over the AST
  numpla-cas       e-graph rewriting, symbolic calculus, dual-engine solve
  numpla-plot      GPU rendering primitives
  numpla-wasm      wasm-bindgen boundary (thin by policy)
app/               TypeScript shell: editor, expression list, panes
```
