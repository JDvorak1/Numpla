# UI v2 — the instrument, not the IDE

The first shell was built like a code editor. That was wrong. Numpla is a math
instrument: you write mathematics, not source code, and the interface should
never suggest otherwise.

Four corrections drive this revision.

## 1. Light mode

The default theme is **light**. Paper, not terminal. Calm, high-contrast,
generous whitespace, one restrained accent. Dark mode may return later as an
option; it is not the default and is not the design target.

## 2. A real math field, not a textarea

Rows are edited in a **math field that renders LaTeX as you type** and is
pleasant to move around inside. This is the Desmos benchmark and the single
most important thing in the product.

Requirements:

- Renders real mathematical notation: stacked fractions, raised exponents,
  radicals with a proper overbar, subscripts, primes, matched delimiters that
  grow with their contents.
- Structure is **typed through**, never mode-switched. `/` starts a fraction and
  drops the caret into the numerator. `^` opens a superscript. `sqrt` inflates
  into a radical. Arrow keys walk in and out of every structure.
- Backspace at the left edge of an empty slot **collapses the structure** rather
  than deleting an invisible character.
- The caret is always visible and always somewhere sensible. Clicking places it
  at the nearest valid position.
- No web fonts, no CDN, no libraries. Everything renders from the system font
  stack plus CSS.

## 3. One plot, with view controls on it

There is **one plot surface**, not a grid of them. Which view it shows is chosen
by controls **on the plot itself**, and those controls advertise what the
current model actually supports:

- A small row of view chips on the plot: `t–y`, `phase`, `polar`.
- A chip is **enabled only when the model can support it**: `phase` needs
  exactly 2 states; `polar` needs the document to contain polar content.
- The enabled-but-inactive chips are the discovery mechanism. Seeing `phase`
  light up the moment a system gains its second state teaches the user what the
  software can do without any documentation.
- Disabled chips stay visible but muted — never hidden. Hiding them hides the
  capability.

## 4. One controls section, and settings only while editing

**Every slider lives in one section**, including the time slider `t`. Time is
not special-cased into its own dock; it is a slider like any other, and putting
it beside the parameter sliders is what makes "drag time" and "drag a
parameter" feel like the same gesture — which they are.

Each slider shows, at rest, only: its **name**, its **current value**, and the
**track**. That is all.

Its **min, max, and step become visible and editable only while that slider is
being edited** — opened by clicking the slider's name or a small affordance on
the row. Not always on screen. Rationale: range and step are set once and then
never looked at again, while the value is looked at constantly. Permanently
showing all three triples the visual weight of the row and buries the number
that matters.

Editing one slider's settings closes any other open one. Escape closes it.

---

# Build split

## Part A — `app/mathfield.js` + `app/mathfield.css`

Self-contained, no dependency on the rest of the app.

```js
export class MathField {
  /**
   * @param host  element to mount into (the field replaces its contents)
   * @param opts  { value?: string, onChange?: (field) => void,
   *                onFocus?: (field) => void, onBlur?: (field) => void,
   *                onEnter?: (field) => void, onNavigate?: (field, dir) => void }
   *              onNavigate fires for up/down out of the top/bottom of the
   *              field, so the list can move focus between rows.
   */
  constructor(host, opts)

  /** Plain source for the parser, e.g. "x' = -y", "x'' = -x - 0.4x'". */
  get source()
  set source(text)

  /** LaTeX for display/export, e.g. "x' = \\frac{-y}{2}". */
  get latex()

  focus()
  blur()
  isEmpty()

  /** severity: 'error' | 'pending' | null. Drives the field's own styling. */
  setDiagnostic(severity, message)

  /** Detach listeners and clear the host. */
  destroy()
}
```

**`source` is the contract with the solver.** `numpla-model` parses plain text
(see `docs/wasm-api.md`), so `source` must emit exactly what that parser
accepts: `x' = -y`, `k = 0.5`, `x(0) = 1`, `f(x) = x^2`. A fraction emits
`(num)/(den)` with parentheses so precedence survives the round trip. A radical
emits `sqrt(...)`. A superscript emits `^(...)`. Round-tripping matters: setting
`source` then reading it back must be stable.

## Part B — the shell

`app/index.html`, `app/styles.css`, `app/main.js`, `app/plot.js`.

- Light theme throughout.
- Expression list of `MathField` rows, one per row, add/remove, keyboard
  navigation between them.
- One plot surface with the view chips described above.
- One controls section holding all sliders including `t`, with the
  edit-on-demand settings behaviour.
- Keep what already works: the eased loading screen, gray-not-red diagnostics,
  play/pause, HiDPI canvas, the debounced re-solve, and the rule that an error
  keeps the last good curve on screen instead of blanking the plot.
