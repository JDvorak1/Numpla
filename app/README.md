# Numpla — browser shell

The M4 vertical slice: type a system of differential equations as text, watch it
integrate, drag the time scrubber and watch the state move.

No bundler, no build step, no dependencies, no network. Plain HTML, CSS and ES
modules, talking to the Rust core through `app/pkg/numpla_wasm.js`.

## Run it

Two commands, from the repo root:

```
wasm-pack build --target web --out-dir ../../app/pkg crates/numpla-wasm
node app/serve.mjs
```

Then open <http://localhost:5173>.

The static server exists because WebAssembly streaming instantiation rejects any
response that is not served as `application/wasm`, and ES modules need
`text/javascript` — `python -m http.server` gets both wrong. `serve.mjs` uses
only `node:http`, `node:fs` and `node:path`.

If `app/pkg/` has not been built, the app says so on its loading screen instead
of hanging.

## Files

| file | role |
|---|---|
| `index.html` | markup: loading screen, editor pane, plots, scrubber dock |
| `styles.css` | dark theme, the eased loader → app transition, all layout |
| `main.js` | boot, WASM binding, debounced recompute, diagnostics, scrubber |
| `plot.js` | `TimePlot` and `PhasePlot` — HiDPI 2D canvas renderers |
| `serve.mjs` | the dependency-free dev server |

## Using it

- Edit the system in the left pane. One row per line; `#` starts a comment.
  Every edit re-runs `set_source` after a 180 ms debounce, then `solve`.
- `x' = -y` declares a state. `x(0) = 1` sets an initial condition. `x'' = -x`
  is lowered to two states automatically. See `docs/wasm-api.md`.
- Diagnostics render per line, in the gutter and in the list below the editor.
  **`pending` is gray, not red** — it means incomplete, not wrong. Only
  `error` gets error styling, and only an `error` pauses the solve (the last
  good curve stays on screen while you finish typing).
- The scrubber along the bottom drives `eval(t)`: a marker on each curve plus
  the numeric state. Space, or the round button, plays and pauses.
- A phase plane appears underneath whenever the system has exactly two states.

## Keyboard

| key | action |
|---|---|
| `space` | play / pause (unless you are typing in a field) |
| `←` `→` | step the scrubber, when it has focus |
| `tab` | move focus; every focusable control has a visible ring |
