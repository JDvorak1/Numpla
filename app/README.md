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
| `index.html` | markup: loading screen, expression rows, the plot and its control strip, the overlays |
| `styles.css` | the light theme, the fixed layout, the eased loader → app hand-off |
| `main.js` | boot, WASM binding, the row list, diagnostics, sliders, the frame gestures, the reference |
| `plot.js` | `Plot` — one HiDPI canvas, tiled between whichever of `time` / `phase` / `polar` are on, each with its own window |
| `demos.js` | the gallery: source, `tSpan`, and the knobs each demo declares |
| `mathfield.js` / `mathfield.css` | the math field itself (see `docs/ui-v2.md` Part A) |
| `serve.mjs` | the dependency-free dev server |

## The six things this shell is built around

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

### 3. One plot, and the views are switches

One canvas, and a control strip on it carrying everything that acts on the
picture: play/pause, the view switches, the frame, and the readout.
**There is no bottom bar** — the plot has that height instead.

Three chips, and each one is **on or off independently**. Any number may be on
at once:

| chip | supported when |
|---|---|
| `t–y` | always |
| `phase` | the document has **exactly 2 states** |
| `polar` | a **state named `r`** exists (the angle is a state named `theta`/`phi` if there is one, otherwise `t`) |

**Several views share the canvas by tiling it.** The canvas is split by
recursive bisection along its longer side: one view fills it, two split it in
half, three give the first view half and the other two a quarter each. The cut
always crosses the longer side, so no tile is ever a sliver, and the order is
fixed (`t–y`, `phase`, `polar`) so turning one on never reshuffles the tiles
already there. Overlaying was the alternative and it is not legible — these
views do not share an x axis, and stacking them would put two unrelated
coordinate systems under one set of gridlines.

A chip the document cannot support stays **visible but muted**, never hidden —
seeing `phase` light up the moment a system gains its second state is how you
find out the software can do it. And **nothing is ever switched off on your
behalf**: a view that was on when its support went away keeps its tile and says
why on it, and its chip stays clickable so you can still put it away yourself.

#### The frame is yours

Every view starts at **−5 to 5 on both axes** — a fixed, predictable frame,
because that is what makes two runs comparable, and it is what Desmos does. It
is not fitted to the data, and **a re-solve never moves it**.

| gesture | effect |
|---|---|
| drag the plot body | pan both axes |
| drag along the x labels | scale x, about the value you grabbed |
| drag along the y labels | scale y, about the value you grabbed |
| wheel | zoom about the cursor — over an axis strip, that axis only |
| double-click a tile | that tile back to −5…5 |
| `−5…5` | every tile back to the default frame; it lights up while any tile has moved |
| `fit` | every visible tile around its own curve, once, because you asked |

Each tile carries its own window, so scaling the phase plane does not touch the
`t–y` one.

#### The playhead is visible on the curve

`t` used to change a number and nothing else, which is exactly why it felt
useless. Now the trajectory is drawn **travelled-versus-ahead** — what has
happened at full strength, what has not ghosted behind it — with a marker riding
the curve at `t` (one per series in `t–y`, plus a dashed rule). Scrubbing reads
as motion.

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

**`t` is not an exception any more.** It used to be a widget in a bar of its
own, which is what made it feel like a dial attached to nothing. It is a
variable in the system now, with a row like any other:

```
t = [0, 20]
```

That row says **how far time runs**, and it gets the same offer, the same knob,
the same gear and the same `×` as `k` does. The slider promoted on it is the
**playhead** inside that span: dragging it moves the marker along the curve and
does *not* re-solve, because the solution does not depend on where you are
looking. Widening the span in the gear rewrites the row, and *that* does.

The row is a **list literal**, which today's parser already reads and the math
field already draws — no new row kind was invented to get `t` onto the page. The
solver rebinds `t` at every right-hand-side evaluation
(`crates/numpla-model/src/system.rs`), so the row is inert to the engine and
cannot change what the equations mean; it is read by the shell, which is exactly
what "the span" is. Delete the row and the last span simply stands, the same
courtesy every other deleted row gets.

A demo declares its span in `tSpan` rather than in its source, so loading one
writes the row that says it. It is an ordinary row from that moment on.

`t` is read on the plot's readout, at the front, alongside the state values.

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

### 6. The reference answers "what can I type here?"

Next to the solve status is a `?`. It opens a **searchable reference** of what
the engine actually supports — until now, a question answerable only by reading
Rust. It is searchable by name *and* by description ("noise", "symplectic",
"contact", "logarithm"), and it covers:

| group | what is in it |
|---|---|
| Row kinds | `x' =`, `x'' =`, `x'(0) =`, `x(0) =`, `k =`, `f(u) =`, `t = [0, 20]`, `#` |
| Functions | every builtin with its **exact arity** — the trigonometric set, `sqrt` `exp` `ln`, `log(x)` base 10 *and* `log(b, x)` base-first, `abs` `floor` `ceil` `round` `sign`, `min` `max`, `mod` |
| Constants | `pi` `tau` `e` `inf` |
| Noise | `white` `pink` `brown` `blue` `smooth` `telegraph`, their `(t, rate, seed)` arguments, and `rand()` / `randn()` / `rand(s)` with their "a number, not a draw" semantics |
| Notation | implicit multiplication, one-letter names, subscripts, primes, `^`, lists, the whole operator set, and the **call-versus-coefficient rule** |
| The integrator | Tsit5 versus Verlet versus Yoshida4 — what each costs and buys |
| Features | the playhead, sliders, the view switches, the frame, gray-not-red, the issue bar |

**Every entry is insertable**, because a reference you can only read leaves you
to retype what it just told you. A row kind writes a new row; anything else is
typed into the row you were last in, at the caret; and everything can be copied.
`↑` `↓` move, `Enter` takes the selected entry, `Esc` closes.

The facts come from the source they document — `crates/numpla-expr/src/lexer.rs`
and `eval.rs` for the builtins and their arities, `docs/noise.md` and
`crates/numpla-noise` for the noise family, `docs/wasm-api.md` for the row kinds
and `rand()`, `docs/solvers.md` and `crates/numpla-ode/src/method.rs` for the
integrators.

**Switching the integrator is live when the module offers it.** `Model` exposes
`solve_with(t0, t1, name)` and a static `methods()`; both are *probed*, never
assumed, because `app/pkg/` is a build artefact that can be older than the
crate — a shell that calls a method the loaded module does not have is a blank
screen, and a shell that probes keeps working while someone rebuilds. When they
are there the method names come **from the module**, so a method added to
`numpla-ode` reaches the list without an edit here; the entries become buttons,
the live one is marked, and the solve badge shows the method the report says
actually ran. When they are not, the entries still document the choice and copy
their names.

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
- The slider settings, the demo gallery and the reference are all
  `position: fixed` overlays, not expanding panels.
- The plot's control strip is a fixed-height row: play/pause, the view switches,
  the frame controls and the readout all live in it, and nothing in it can
  change the size of the canvas below.
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
| `F1` | open (or close) the reference |
| `Esc` | close the reference, the demo gallery, or the slider settings overlay |
| `↑` `↓` | in the reference: move between entries |
| `Enter` | in the reference: insert the selected entry |
| `tab` | move focus; every focusable control has a visible ring |

## Pointer, on the plot

| gesture | action |
|---|---|
| drag the body of a tile | pan it |
| drag along its x or y labels | scale that axis, about the value under the pointer |
| wheel | zoom about the cursor; over an axis strip, that axis alone |
| double-click | that tile back to −5…5 |
