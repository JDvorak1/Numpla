# Numpla — browser shell

Write a system of differential equations as **mathematical notation**, watch it
integrate, and drag time — or any parameter — while the curve moves under you.

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
of hanging. Same for a missing `mathfield.js`.

## Files

| file | role |
|---|---|
| `index.html` | markup: loading screen, expression rows, the plot, the controls |
| `styles.css` | the light theme, the fixed layout, the eased loader → app hand-off |
| `main.js` | boot, WASM binding, the row list, diagnostics, sliders, transport |
| `plot.js` | `Plot` — one HiDPI canvas, three views (`time`, `phase`, `polar`) |
| `mathfield.js` / `mathfield.css` | the math field itself (see `docs/ui-v2.md` Part A) |
| `serve.mjs` | the dependency-free dev server |

## The four things this shell is built around

### 1. Light

Paper, not terminal. One restrained accent (teal ink), high contrast, generous
whitespace. The loading screen is light too. The plot's gridlines, axis rules
and label greys are tuned for white — not inverted from a dark palette — and
the series palette is mid-dark so every curve reads on paper. `styles.css`
retunes the math field's colour variables to the same accent, so the whole
window has exactly one.

### 2. Rows, not a textarea

The expression pane is a list of rows, each one a `MathField` that renders
notation as you type. The document sent to `set_source` is the rows' `.source`
values joined with newlines — so row *n* is line *n*, and a diagnostic's `line`
maps straight back to the row it came from.

| key | action |
|---|---|
| `Enter` | new row below, caret in it |
| `↑` `↓` | move between rows when the caret leaves the top/bottom of a field |
| `←` `→` | ditto, off the left/right edge |
| `Backspace` | on an already-empty row, deletes the row |

**Gray, not red.** `severity: "pending"` means *incomplete, not wrong*: the row
is muted and the message is grey. Only `"error"` gets error styling, and only
an `"error"` pauses the solve — the last good curve, chips, legend and sliders
all stay exactly as they were while you finish typing.

### 3. One plot, view chips on it

One canvas. Three chips sit on the plot itself and switch what it shows:

| chip | enabled when |
|---|---|
| `t–y` | always |
| `phase` | the document has **exactly 2 states** |
| `polar` | a **state named `r`** exists (the angle is a state named `theta`/`phi` if there is one, otherwise `t`) |

A chip that is not available stays **visible but muted**, never hidden — seeing
`phase` light up the moment a system gains its second state is how you find out
the software can do it. If the active view stops being supported, the plot falls
back to `t–y`.

### 4. One controls section, settings only while editing

Every slider lives in the controls strip along the bottom, **including `t`**.
Time is not special-cased into its own dock; dragging time and dragging a
parameter are the same gesture, so they look the same.

At rest a slider shows its **name**, its **value**, and the **track**. That is
all. Its **min / max / step** open in a small overlay when you click the name or
the `⋯` affordance. Opening one closes any other; `Esc` closes it. Range and
step get set once; the value is watched constantly, which is why only the value
is on screen.

- The **`t` slider's min and max *are* the integration span.** Editing them
  re-solves.
- A **parameter slider** appears for every scalar constant in the document
  (`k = 0.4`). Dragging it rewrites that row's source and re-solves — the
  document stays the single source of truth.

## Layout: nothing moves while you type

The panes have explicit sizes and content scrolls *inside* them.

- The row list scrolls within the expression pane; the pane never grows.
- Each row reserves a line for its diagnostic message, so a message appearing
  or clearing cannot push anything.
- The slider settings are a `position: fixed` overlay, not an expanding panel.
- The canvas is absolutely positioned inside its box, so its size can never feed
  back into the grid that sizes it.

**The divider between the expression pane and the plot is draggable.** Drag it,
or focus it and use `←` `→` (`Shift` for a bigger step, `Home`/`End` for the
limits); double-click resets it. The width is clamped so neither side can
collapse, is persisted in `localStorage` (`numpla.docWidth`, in a `try/catch` —
storage throws in some contexts) and survives a re-solve, a new row, and the
settings overlay opening.

## Keyboard

| key | action |
|---|---|
| `space` | play / pause — unless you are typing in a field |
| `Esc` | close the slider settings overlay |
| `tab` | move focus; every focusable control has a visible ring |
