# Numpla — browser shell

Write a system of differential equations as **mathematical notation**, then
**look somewhere** — the visible window is the integration span, so what is on
screen is what gets solved, at the resolution the screen can show.

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
| `plot.js` | `Plot` — one HiDPI canvas, one frame, and `time` / `phase` / `polar` all drawn into it, overlapping |
| `demos.js` | the gallery: source, `tSpan`, `show`, and the knobs each demo declares |
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

### 3. One plot, everything in it, nothing tiled

One canvas, one frame, and a control strip carrying everything that acts on the
picture: the **integrator**, the **views** menu, the frame controls, and the
readout. **There is no bottom bar** — the plot has that height instead — and
**there is no `t` widget of any kind**.

Three views, and every one the model supports draws into the **same frame**,
overlapping:

| view | supported when |
|---|---|
| `t–y` | always — every state against time |
| `phase` | the document has **exactly 2 states** |
| `polar` | a **state named `r`** exists (the angle is a state named `theta`/`phi` if there is one, otherwise `t`) |

Tiling is gone. Splitting the canvas turned "show me two things about this
system" into a layout problem and shrank the picture every time you asked for
more of it. They share the frame deliberately.

**A supported view turns itself on.** That is the right default now that an
extra view is an extra curve rather than a tile taken out of the picture:
`phase` lights up the moment a system gains its second state, without being
asked. The **views menu** on the strip is the other direction — how you turn one
*off* when it is in the way — and it keeps that decision across recompiles and
demo loads. A view the document cannot support is listed **with the reason**
rather than hidden, because that is how the capability is discovered.

#### The frame is yours — and it is the query

The frame starts at **−5 to 5 on both axes** — fixed and predictable, because
that is what makes two runs comparable, and it is what Desmos does. It is not
fitted to the data, and **a re-solve never moves it**.

| gesture | effect |
|---|---|
| drag the plot body | pan both axes |
| drag along the x labels | scale x, about the value you grabbed |
| drag along the y labels | scale y, about the value you grabbed |
| wheel | zoom about the cursor — over an axis strip, that axis only |
| double-click | back to −5…5 |
| `−5…5` | back to the default frame; it lights up while the frame has moved |
| `fit` | around the curve, once, because you asked — vertically only while `t–y` is on, since x there is already the span |

#### The window **is** the integration span

`t` was a slider, then a row, and it was useless both times, because it answered
a question nobody asks. Nobody wants to *set* a span; they want to **look
somewhere** and have the software compute what they are looking at.

> **What is on screen is what gets solved, at the resolution the screen can
> show.**

- The frame's `x0…x1` is passed straight to `solve_with(t0, t1, method)`.
- Panning or zooming the horizontal axis **re-solves over the new span**. The
  curve already in hand redraws inside the moving frame at once, and one
  integration happens when the hand stops: the solve is debounced (180 ms)
  exactly the way editing is, so a drag across the canvas costs **one** solve
  rather than one per `pointermove`. The last good curve stays on screen the
  whole time.
- The guard is the span itself, not "did something move" — panning vertically,
  scaling y, or moving the frame with `t–y` **off** all leave the span alone, so
  they cost nothing.
- **With `t–y` off the span freezes.** The horizontal axis is then a state
  (phase) or a coordinate (polar), and panning it is not a statement about time;
  re-solving over the phase plane's x range would be a number arrived at by
  accident. The last span simply stands until `t–y` comes back, and turning it
  back on hands the axis its meaning — and the span — back.
- **The sample count follows the pixel width**: one point per device pixel of
  canvas (clamped to 240…4000). Asking for more than the canvas can draw is
  waste; asking for fewer is a lie about the curve.
- Zooming out far enough is a genuinely longer integration and may take longer.
  That is honest, and the telemetry (`acc` / `rej` / `rhs`) says so.

A demo still declares a `tSpan` — and it sets the **frame**, not the other way
round. There is no row and no widget left to write it into.

#### 3b. The integrator is on the strip

The width the view chips used to spend goes to the thing worth reaching for
constantly: **discrete versus continuous**. Adaptive Runge–Kutta (`Tsit5`)
against the fixed-step symplectic methods (`Verlet`, `Yoshida4`), one click,
the live one legible at a glance. Paired with a derived energy row it is the
whole Ge–Marsden lesson in one gesture.

The list is built from `Model.methods()`, never from a hard-coded one, so a
method added to `numpla-ode` reaches the strip without an edit here. The badge
is labelled from `SolveReport.method` — what actually ran — and never from what
was requested; they differ exactly when something went wrong.

**A symplectic method is refused, not downgraded.** `Verlet` and `Yoshida4`
integrate positions and velocities separately, so a document of plain `x' =`
rows has no structure for them to preserve. There is deliberately no silent
fallback to `Tsit5` — it would draw a `Tsit5` curve under a label reading
`Verlet` and teach the opposite of what the switch exists to show. So:

- the entry is **dimmed** when the document has no `x'' =` rows, but stays
  clickable, because the engine's sentence names the offending row and the fix
  and that is worth more than a disabled button;
- the refused chip turns red and the solve badge carries the message;
- and the sentence itself is **drawn on the plot**, wrapped, where a blank
  canvas would otherwise just look broken.

#### A document can say what to look at

`colliding-strings` has twelve states and is about **two strings**. A demo may
declare which series are the picture:

```js
{ id: 'colliding-strings', show: ['a_2', 'b_2'], ... }
```

`show` names states or derived rows. When present, **only those are drawn and
only those appear in the legend**; absent means draw everything, which is right
for a two-state system. The states left out are **still solved** — this is a
display choice, not a model change — so they are still in the hear panel and
still in the sample buffer. A `show` list that matches nothing in the current
document is ignored rather than drawing an empty plot.

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

**`t` is not one of these, and never will be again.** It was a widget in a bar
of its own, then a `t = [0, 20]` row with a slider on it, and both times it was
a dial attached to nothing. The span it runs over is now **the visible window**,
and a window already has a way to be moved — so there is no `t` row, no `t`
slider, no playhead, no play button and no `t` chip in the legend.

A slider's **min / max / step** open in a small overlay when you click the `⋯`
affordance. Opening one closes any other; `Esc` closes
it. Range and step get set once; the value is watched constantly, which is why
only the value is on screen.

### 5. Half-written is a normal state

#### Rows go in any order

The whole document is compiled at once — twice over, to settle calls against
coefficients — so **nothing has to be written before anything else**. An initial
condition may sit above its ODE row; a parameter may be used three rows before
the row that defines it; a function may be called before it is written; a
derived row may read states declared below it. A name that is missing is
reported as *missing*, never as *out of order*, and the shell never implies a
sequence it does not have.

The clearest demonstration is the issue bar's own fix: it appends `k = 1` at the
**end** of the document, below every row that reads `k`, and the model solves.

#### The issue bar says what is missing, by name

The strip along the bottom of the expression pane is where the document tells
you what it still needs. Quiet when nothing is missing (`clean`, or a count).
When the compiler reports an issue carrying a `fix` — a state with no initial
condition, a name used but never defined — it shows the plain sentence and a
button that writes the default in:

```
y has no starting point                        [ add y(0) = 0 ]
```

When several things are missing, **every one of them is named**:

```
k is not defined yet · also q, y(0)            [ add all 3 defaults ]
```

Not "1 issue · and 2 more". "What is it waiting for" is the only question being
asked at that moment, and each fix already knows the answer — so the first keeps
its full sentence and the rest are listed by name, with the full set in the
hover text. One button applies them all, because they are all the same kind of
answer — "this is what it would otherwise have assumed" — and clicking through
them one re-solve at a time is exactly the asking-for-things this is meant to
remove. Every row still carries its own message, so batching hides nothing.

`fix` is optional in the contract: without it there is simply no button, and a
genuine error outranks a missing default, because there is no point completing a
document that cannot be read yet.

#### Waiting is not failing — gray-not-red, applied to the solve

A missing **initial condition** does not stop anything: it is reported *and*
defaulted to 0 in the same pass, so the model still draws.

A name used but never defined *does* stop the solve, and the engine says so:
`the model is still incomplete — line 5: k is not defined yet`. That is not a
failure. It is the ordinary state of a document being written, and showing it in
red teaches someone that half-typing is a mistake. So the solve badge reads

```
waiting on k
```

in the **muted** style — not the error style — with the engine's full sentence in
the hover text, and **the last good curve stays exactly where it is**, the same
courtesy an `error` row already gets. Nothing blanks out because a name has not
been typed yet. The badge names only what actually blocks: undefined names, never
a starting point the compiler has already supplied.

The three ways a solve can decline to run are three different events wearing one
shape (`ok: false` and a sentence), and the shell tells them apart:

| | badge | the curve |
|---|---|---|
| waiting on a name | muted, `waiting on k` | stays |
| a method refused (no `x''` rows) | red, the engine's sentence | cleared — the model has already invalidated it — and the sentence is drawn on the plot |
| anything else | red, the engine's sentence | cleared |

### 6. The reference answers "what can I type here?"

Next to the solve status is a `?`. It opens a **searchable reference** of what
the engine actually supports — until now, a question answerable only by reading
Rust. It is searchable by name *and* by description ("noise", "symplectic",
"contact", "logarithm"), and it covers:

| group | what is in it |
|---|---|
| Row kinds | `x' =`, `x'' =`, `x'(0) =`, `x(0) =`, `k =`, `f(u) =`, `#` — and the note that they go in any order |
| Functions | every builtin with its **exact arity** — the trigonometric set, `sqrt` `exp` `ln`, `log(x)` base 10 *and* `log(b, x)` base-first, `abs` `floor` `ceil` `round` `sign`, `min` `max`, `mod` |
| Constants | `pi` `tau` `e` `inf` |
| Noise | `white` `pink` `brown` `blue` `smooth` `telegraph`, their `(t, rate, seed)` arguments, and `rand()` / `randn()` / `rand(s)` with their "a number, not a draw" semantics |
| Notation | implicit multiplication, one-letter names, subscripts, primes, `^`, lists, the whole operator set, and the **call-versus-coefficient rule** |
| The integrator | Tsit5 versus Verlet versus Yoshida4 — what each costs and buys; the same switch that is on the plot's strip |
| Features | the window-is-the-span, one plot, the integrator switch, `show`, sliders, rows-in-any-order, gray-not-red, the issue bar |

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
- **A row's suggestion lives in that reserved line too**, beside its message,
  so the answer appearing next to the problem shifts nothing either.
- The issue bar is a fixed-height strip: what it says never changes the height
  of the workspace. When it has a fix to offer, the keyboard hint yields the
  space rather than the bar growing.
- The slider settings, the demo gallery, the views menu and the reference are
  all `position: fixed` overlays, not expanding panels.
- The plot's control strip is a fixed-height row: the integrator switch, the
  views menu, the frame controls and the readout all live in it, and nothing in
  it can change the size of the canvas below.
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
| `F1` | open (or close) the reference |
| `Esc` | close the reference, the demo gallery, the views menu, or the slider settings overlay |
| `↑` `↓` | in the reference: move between entries |
| `Enter` | in the reference: insert the selected entry |
| `tab` | move focus; every focusable control has a visible ring |

## Pointer, on the plot

| gesture | action |
|---|---|
| drag the body | pan the frame |
| drag along the x or y labels | scale that axis, about the value under the pointer |
| wheel | zoom about the cursor; over an axis strip, that axis alone |
| double-click | back to −5…5 |

Every one of these that moves the **horizontal** axis is also a new query: the
solve is re-run over the new span, once, 180 ms after the gesture stops.
