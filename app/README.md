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
| `demos.js` | the gallery: source, `tSpan`, and the knobs each demo declares |
| `mathfield.js` / `mathfield.css` | the math field itself (see `docs/ui-v2.md` Part A) |
| `serve.mjs` | the dependency-free dev server |

## The five things this shell is built around

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

**There is no "add row" button.** A button is a thing you have to notice, aim
at, and click; rows appear because you kept typing. A blank row always sits at
the end of the list, and it is *not a row*: it is not numbered, never
diagnosed, and never reaches the solver. Type into it and it becomes real, with
a fresh blank one below it. Because it is always last, leaving it out of the
document cannot shift anyone else's line number.

| key | where | action |
|---|---|---|
| `Enter` | anywhere | new row below, caret in it |
| `↑` | anywhere | previous row, caret at its **end** |
| `↓` | anywhere | next row — including the trailing blank one — caret at its start |
| `←` `→` | off the field's edge | previous / next row, caret at that edge |
| `Backspace` | empty row | deletes the row, caret at the **end** of the row above |
| `Backspace` | the trailing blank row | steps back to the row above; deletes nothing |
| click | empty space below the list | focuses the trailing blank row |
| click | a row's margins | focuses that row at its end |

The `×` on a row stays for mouse users, but nobody should ever need it to work
quickly. Backspacing away the row you are in should feel like deleting a
character, not like operating a control — which is why the caret always lands
at the *end* of the row above, where the character you were about to delete is.

The number in the gutter counts **equations**: comment rows, blank spacer rows
and the trailing blank get none, so a document with six lines of prose in it
does not read as a list with holes punched in it.

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

### 4. A slider lives on the variable it drives — and only if asked for

Automatically materialising a slider for every scalar in a document is wrong:
most constants are just constants. A slider is a statement that *this* number is
worth playing with, and only the person writing the document knows which ones
those are.

- A row that is a plain numeric assignment (`k = 0.4`) shows a quiet
  **offer** — `add slider` — in the line it already reserves for its
  diagnostic, so the offer appearing cannot move anything.
- One click promotes it into a **slider on that row**, right under the number
  it drives. Dragging it rewrites that row's source and re-solves: the document
  stays the single source of truth, and the row *is* the value readout.
- The `×` on a slider dismisses it back to an offer.
- **Promotions persist by name** across recompiles, so editing an unrelated row
  never silently demotes a slider you asked for. So does a range you set by
  hand — deleting and retyping the row brings it back.
- **Demos arrive promoted.** A demo declares its knobs, with the ranges over
  which they are actually interesting; its author has already answered the
  question the offer asks.

**`t` is the exception** and lives in the transport bar along the bottom with
play/pause and the readout: it has no defining row to sit on, and it is the
playhead rather than a parameter. **Its min and max *are* the integration
span**, so editing them re-solves.

A slider's **min / max / step** open in a small overlay when you click the `⋯`
affordance (or, for `t`, its name). Opening one closes any other; `Esc` closes
it. Range and step get set once; the value is watched constantly, which is why
only the value is on screen.

### 5. The issue bar says what is missing

The strip along the bottom of the expression pane is where the document tells
you what it still needs. Quiet when nothing is missing (`clean`, or a count).
When the compiler reports an issue carrying a `fix` — a state with no initial
condition, a name used but never defined — it shows the plain sentence and a
button that writes the default in:

```
y has no starting point                        [ add y(0) = 0 ]
```

Clicking it appends that row to the document and re-solves. If several issues
carry fixes, one button applies them all (`add all 3 defaults`) — they are all
the same kind of answer, "this is what it would otherwise have assumed", and
each row still carries its own message, so batching hides nothing. `fix` is
optional in the contract: without it there is simply no button, and a genuine
error outranks a missing default, because there is no point completing a
document that cannot be read yet.

## Demos

The gallery in the top bar lists each demo as **its title and a preview of what
it actually does** — a thumbnail of its own trajectory, not a sentence about it.
Each preview is a throwaway `Model`: `set_source`, `solve`, `sample`, drawn once
into a small canvas. They are generated the first time the menu opens, one per
animation frame so the menu paints immediately, and never again — the menu's DOM
outlives closing it, so the pixels are the cache. A preview that cannot be
produced (a demo that will not solve, no WASM) leaves the title alone rather
than a broken box. The blurb survives as the entry's hover text.

Demo sources are heavily commented, and the comments are the teaching material:
a `#` row round-trips verbatim through the math field, reaches `set_source`
unchanged (the parser skips it), is never diagnosed, and is not numbered as an
equation.

### The shell owns the function names

`d(x, y)` is a call only when the document has a `d(x, y) = ...` row; otherwise
it is `d` times `(x, y)`. Same tokens, two different systems, and one row cannot
answer it alone — so the shell derives the set from the whole document
(`functionNamesIn`) and tells the field, which mirrors the two-pass compile the
Rust parser does (`docs/wasm-api.md`, "Calls and coefficients").

Rows are **constructed** with the set already known — including when a demo
loads — because once a row has been displayed in the wrong reading, its text
genuinely means the wrong thing and re-reading it cannot always recover the
intent. `setFunctions` on every row is the safety net for a definition that
appears later; it does not fire `onChange`, so `recompute` re-reads the document
itself when a row reports that it changed.

## Layout: nothing moves while you type

The panes have explicit sizes and content scrolls *inside* them.

- The row list scrolls within the expression pane; the pane never grows.
- Each row reserves a line for its diagnostic message, so a message appearing
  or clearing cannot push anything. **The slider offer lives in that same
  reserved line**, so it cannot push anything either.
- The issue bar is a fixed-height strip: what it says never changes the height
  of the workspace. When it has a fix to offer, the keyboard hint yields the
  space rather than the bar growing.
- The slider settings are a `position: fixed` overlay, not an expanding panel.
- The canvas is absolutely positioned inside its box, so its size can never feed
  back into the grid that sizes it.

The one thing that does grow is a row that has been given a slider — that is the
row's own content, and it happens on a click, never while typing.

**The divider between the expression pane and the plot is draggable.** Drag it,
or focus it and use `←` `→` (`Shift` for a bigger step, `Home`/`End` for the
limits); double-click resets it. The width is clamped so neither side can
collapse, is persisted in `localStorage` (`numpla.docWidth`, in a `try/catch` —
storage throws in some contexts) and survives a re-solve, a new row, and the
settings overlay opening.

## Keyboard

| key | action |
|---|---|
| `space` | play / pause — unless you are typing in a field or on a button |
| `Esc` | close the slider settings overlay or the demo gallery |
| `tab` | move focus; every focusable control has a visible ring |
