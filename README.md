# Numpla

Maple-class math with Desmos-class feel. Local-first, WebAssembly, built for
physical modeling: couple systems together, see and *hear* the result instantly.

- **[VISION.md](VISION.md)** — what this is and what it refuses to be
- **[ROADMAP.md](ROADMAP.md)** — build order, milestone by milestone

## Status

M0. `numpla-expr` (tokenizer, parser, AST, evaluator) is written; everything
else is scaffolded.

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
