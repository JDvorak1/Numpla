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
| `index.html` | markup: loading screen, the start screen, expression rows, the plot and its control strip, the compute pane, the overlays |
| `styles.css` | the light theme, the fixed layout, the eased loader → app hand-off |
| `main.js` | boot, WASM binding, the row list, diagnostics, sliders, the frame gestures, the reference |
| `plot.js` | `Plot` — one HiDPI canvas, one frame, and `time` / `phase` / `polar` / `field` all drawn into it, overlapping; the field grid rule, the shade ramp, and seed hit-testing |
| `demos.js` | the gallery: source, `tSpan`, `show`, and the knobs each demo declares |
| `mathfield.js` / `mathfield.css` | the math field itself (see `docs/ui-v2.md` Part A) |
| `serve.mjs` | the dependency-free dev server |

## Two ways in

Numpla opens by asking which of two things you want.

- **Solve & simulate** — the workspace: rows, sliders, the plot and everything
  on its strip.
- **Compute** — a Maple-like pane over the CAS calls: type an expression and
  simplify, differentiate, expand or evaluate it.

**The start screen is not a second gate.** It lives inside the app shell, over
the workspace's own grid row, painted on the loading screen's own background,
and it rises on the same easing and the same delay the workspace rises on. So
the sequence is one motion: the loader fades and drifts out, the top bar and the
question arrive together underneath it, and choosing fades the question out over
a workspace that is already laid out behind it — which is also why choosing
costs no re-measure, no re-sample and no re-solve.

The route is a class on `<body>` — `route-chooser`, `route-solve`,
`route-compute` — and exactly one of the workspace and the compute pane owns the
grid's second row at a time.

**It asks once.** The choice is written to `localStorage` under `numpla.route`
(in a `try/catch`, like the divider's width), so a reload goes straight back to
where you were. **The logo is the way back to the chooser** — a mark that goes
home is the one navigation convention everybody already has, and it costs no
width and needs no label. The word beside it says which route you are in.

**A route the build cannot serve is never offered as a live button.** If
`app/pkg/` has none of the four CAS calls, the Compute card is rendered as
unavailable and names the calls it wants, rather than opening a pane with four
dead buttons; and a remembered `compute` route on such a build lands on `solve`.

## Compute

The pane is input on top, history below, and the history is the only thing that
scrolls — the same layout rule the system pane obeys.

**The input is a `MathField`**, the same class every row in the system pane uses.
There is exactly one way to type mathematics in this product; a text box would
have been a second one. **Every result is rendered by another `MathField`** with
its editing taken away (keys and clicks are stopped on the host, in the capture
phase, so nothing reaches the field), which is why an answer comes back as
mathematics rather than as a line of source — and why the input and the answer
cannot disagree about what an expression looks like: they are drawn by the same
code.

| | |
|---|---|
| operations | `simplify`, `d/dx`, `expand`, `evaluate` — one button each, **built from the calls the build actually has**, so a WASM missing `cas_expand` shows three live buttons and says what the fourth needs |
| the variable | `d/dx` reads a small field beside the buttons; the button relabels itself as you change it |
| `Enter` | runs the operation you last used |
| the history | one entry per run, oldest first, scrolling; `use` puts that answer back into the input |
| a refusal | `ok: false` is kept as its own entry with the CAS's own sentence — a refusal is an answer, and throwing it away is how a tool becomes untrustworthy |

**Results are Numpla source, so they round-trip.** `output` goes back through
the same parser the rows use, which is what makes `use` possible: differentiate,
press `use`, simplify the derivative — without retyping anything.

Not here, and said rather than half-done: symbolic integration, equation
solving, limits, series, matrices.

The math keyboard follows you into this pane. While `compute` is the route the
keyboard's target is the pane's own input surface, wrapped in the one shape the
keyboard knows, so a tap and a keystroke take the same path here as they do in a
row — and `Enter` runs the operation instead of opening a row below.

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
picture: the **integrator**, the **views** menu, the **seeds** control, the
frame controls, and the readout. **There is no bottom bar** — the plot has that
height instead — and **there is no `t` widget of any kind**.

Four views, and every one the model supports draws into the **same frame**,
overlapping:

| view | supported when |
|---|---|
| `t–y` | always — every state against time |
| `phase` | the document has **exactly 2 states** |
| `polar` | a **state named `r`** exists (the angle is a state named `theta`/`phi` if there is one, otherwise `t`) |
| `field` | the document has **exactly 2 states** *and* the loaded WASM has `vector_field` |

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

#### 3c. The field is the question; the curves are the answer

An equation *is* a field of arrows, and a solution is a point dropped into it.
The `field` view draws the first half — the right-hand side sampled across the
visible window, through `vector_field(x0, x1, y0, y1, nx, ny, t)` — **under**
everything else on the canvas.

**The grid density comes from the box, per axis, in pixels: one arrow per
~34 CSS pixels, clamped to 5…26 arrows on each axis** (`fieldGrid` in
`plot.js`). Per axis and in pixels because that is the only unit readability is
measured in: a count fixed in *data* units crowds the arrows into rows the
moment you stretch one axis, and a single count for both axes does the same to
a wide, short box. Spacing the samples evenly on the *screen* keeps the cells
square whatever shape the window is, so the arrows never touch and never
scatter. The floor stops a small plot showing three arrows and calling it a
field; the ceiling caps the query at 676 samples, already denser than the eye
can separate.

**Every arrow is the same length; magnitude is the shade.** A field whose
corner is a thousand times faster than its middle is unreadable the moment
length tracks speed — the fast corner becomes a smear and everything else
vanishes. So the length is a fixed fraction of the cell (0.74 × the shorter
side) and |f| runs pale → dark on a **log** ramp between the **5th and 95th
percentile** of the sampled magnitudes: log because a right-hand side routinely
spans decades across one window, and percentiles because one near-singular
corner would otherwise flatten everything else to the palest shade. A field
that really is uniform is widened to half a decade either side rather than
amplifying numerical dust into a picture of variation. A sample with no
magnitude has no direction either, and is drawn as a small ring — which is
exactly what an equilibrium is.

The direction is normalised **in pixels**, after the window's own scaling, so
an arrow is tangent to the curve that would be drawn through it. Normalising in
data units instead would leave every arrow lying about its own tangent the
moment an axis is stretched.

**The window is the query, so the grid follows the window.** Pan or zoom and
the arrows are recomputed for where you are now looking, debounced at the same
180 ms as the re-solve and for the same reason. The arrows already up stay
there meanwhile — they are drawn at their own data coordinates, so a pan slides
them along with everything else and only the newly exposed edge is briefly
bare. A resize is a new query too, because the density is read off the box.

A non-autonomous system has a different field at every instant. This is the one
at the **start of the window**, and the canvas says so — `field at t = 0 · |f|
0.02…14.1 pale→dark · 24×10` sits in the corner rather than letting the picture
imply it is timeless.

#### 3d. Seeds

A **seed** is a starting point you place yourself. Each one is integrated over
the same window with the same method through `trajectory_from(t0, t1, method,
y0, n)`, and drawn in the same frame.

- **Click the plane** to drop one. **Drag** it and the trajectory follows live.
  The `×` that appears on a handle under the pointer removes that one; the
  `seeds · N ×` control on the strip removes them all.
- **A seed never rewrites the document.** It is a *view* of the model, not a
  change to it — `trajectory_from` does not disturb the stored solution, so a
  seed costs exactly its own integration and the document's own curve is
  untouched.
- **The document's initial condition is seed zero, and it is not special**: it
  wears the same ring (with a filled centre, because you move it by editing its
  row rather than by dragging), and a user's seed gets a curve of the same
  weight, not a second-class dashed one.
- A double click still resets the frame, and takes back the seed its first
  click dropped — one gesture, one outcome.

**What a seed means with only `t–y` on.** Placing one is a **phase-plane idea**:
a click only names a state when *both* axes are states, and with `t–y` on the
horizontal axis is time. So a seed can only be **placed** while the plane is on
(`phase` or `field`), and the seeds control carries the reason when it is not.
But a seed is not a phase-plane-only *object*: the ones already placed keep
their handles' meaning and their trajectories are drawn **against t as well**,
thin, one line per state — the same starting point read the other way round.

**Why dragging stays smooth.** The handle follows the pointer on every
`pointermove`; the re-integration is **throttled to one every 55 ms**, leading
edge plus a trailing call so the position the pointer actually stopped at is
never the one that got skipped, and the drag ends with one final un-throttled
integration. Between them the previous trajectory stays on screen, drawn
slightly faded — the same bargain the frame gestures make with the solve, so a
drag is a curve keeping up rather than a curve blinking out.

**Both calls are optional and both are probed**, exactly the way `solve_with`
is: `app/pkg/` is a build artefact that can be older than the crate. Without
`vector_field` the `field` entry in the views menu reads *this WASM build has no
vector_field* — naming the build, not blaming the document — and without
`trajectory_from` the seeds control says the same and a click on the plane does
nothing at all.

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

### What a demo arrives as

The complaint this answers: *the same graph is in every view*. It was true, and
the plot was never at fault — the three views genuinely draw different geometry.
The **policy** was wrong: everything the model supported turned itself on, so
`t–y` was drawn whichever view you had come for.

**A demo declares the one view it is about** — `view: 'time' | 'phase' |
'polar' | 'field'` — and loading it turns that view on and the others off. The
views menu is untouched by this: anything supported can be switched back on the
moment after, and that decision then survives every recompile. This changes what
a demo *arrives as*, not what the menu can do.

- **A demo with no `view` arrives as `time`.** It is the one view every document
  can draw whatever its shape, and it is the view such a demo used to arrive
  with anyway — the change is that it now arrives with exactly *one*.
- **A declared view the document or the build cannot draw degrades to `time`**,
  checked once, after the compile that knows the answer. `field` on a build with
  no `vector_field`, or `phase` on a six-state string, would otherwise arrive as
  an empty plot — which is worse than the wrong picture, and the views menu is
  already saying why it is off.
- **A plain document keeps the old policy**: the one at boot, one typed from
  nothing, one pushed in by the suite. Nobody chose its subject, so nothing here
  may pretend to know it — everything it supports is on.

### New

**New** sits beside **Demos** in the top bar: an empty document and the default
frame, in one press, so starting from nothing does not mean deleting six rows
one at a time. The two live together because they answer the same question —
what is in the document — and the top bar is the only place on screen that is
about the document as a whole rather than about one row.

Everything the document accumulated goes with it: its sliders and their ranges,
its seeds, its `show` list, the demo it came from, the view policy, and the
frame. What survives is what belongs to the *person* rather than to the
document — the pane width, the integrator, the route, the keyboard.

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

## The mark

A **trajectory**, in one curve: a dot at the initial condition, one big
overshoot, a smaller return, and away off the top right. Asymmetric on purpose —
a symmetric bump has no direction, and direction is the entire subject of a
differential-equations tool. Three control points define it, so it survives
being 16px wide.

It is the same curve in all three places it appears, at two scales:

| where | how |
|---|---|
| the favicon | `0 0 32 32`, teal on white, with the rounded plate |
| the top bar | the same 32-unit path in `currentColor`, and it is a button — the way back to the start screen |
| the loading screen | the same shape at `0 0 120 120` inside the ring, traced by the dash animation, with the seed dot at the trajectory's start |

On the loading screen the dash sweeps along the curve, so the mark is not a
picture of a trajectory but a point moving along one — which is what the ring
and the seed dot were always for.

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
  views menu, the seeds control, the frame controls and the readout all live in
  it, and nothing in it can change the size of the canvas below.
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

## Keyboard (hardware)

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
| click the plane (`phase` or `field` on) | drop a seed there |
| drag a seed handle | move it; its trajectory follows live |
| the `×` on a hovered handle | remove that seed |
| `seeds · N ×` on the strip | remove all of them |
| one finger, dragging | pan the frame (a touch pointer is a pointer) |
| two fingers | pinch: pan by their midpoint, zoom by their separation |

Every one of these that moves the **horizontal** axis is also a new query: the
solve is re-run over the new span, once, 180 ms after the gesture stops. Every
one that moves the frame at all re-queries the **field**, on the same 180 ms.

## Phones

Two problems, and the second one is the point (`docs/mobile.md`).

### The narrow layout — a switch, not a horizontal divider

Below **720px** the two panes stop being side by side. The spec offered a
horizontal divider or a segmented switch. This is the switch, and the reason is
arithmetic:

> a phone viewport is about 640 CSS pixels tall. Take the top bar (52) and the
> math keyboard (about 348 while it is up — 44px keys, five rows of them, which
> is what the touch rule costs) and **240 are left to divide**. Split that and
> the plot gets 120px — and the plot's height is not decoration here,
> because *the window is the query*: a 120px-tall frame is a worse question to
> ask the solver, and a 120px-tall row list shows one equation. A divider would
> only let you choose which of the two to make unusable.

Three more reasons the drag loses:

- the surface directly under the divider is a pan/pinch surface. A drag handle
  sitting on top of one is a gesture ambiguity on every touch.
- a 44px grab strip is 7% of the screen spent on a control that does nothing but
  resize.
- a thumb cannot place a divider precisely, and the two useful positions are
  "all of it" and "all of the other one" — which is a switch.

So: a `plot | system` segmented control in the top bar, both panes in the same
grid cell, exactly one visible. Hidden with **`visibility`, never `display`**,
so the canvas keeps its real size and coming back to the plot does not have to
re-measure, re-sample and re-solve. Focusing a row switches to `system` by
itself; switching to `plot` dismisses the keyboard, because nothing is being
edited any more.

The breakpoint is applied as a **class** (`body.is-narrow`, set by `main.js`),
not as a media query. The shell has to know which layout it is in anyway — the
pane switch, the keyboard and the touch targets all read it — and two sources of
truth for one fact would drift.

**The controls that spend width on a desktop** do not wrap and are not hidden:
the plot's strip becomes one 56px row that **scrolls sideways**, with a mask on
its right edge saying there is more. The integrator switch, the views menu,
seeds, hear and the frame buttons are all still there, all still labelled, every
one at least 44px tall. The demos button loses its word and keeps its icon; the
telemetry is already down to the solve badge below 900px.

**44px minimum, everywhere a finger goes.** Row delete buttons become 44×44 and
stop hiding until hover (a finger has no hover). Seed handles keep the ring they
have always been drawn with — a handle that grew when a finger came near would
be a different picture of the same model — but `Plot.setTouch(true)` opens their
*hit* radius to 22px and moves the remove badge out to where it can be pressed
without landing on the handle underneath it.

### Touch gestures on the plot

The window **is** the integration span, so pinch and drag are how a phone
re-solves. One finger pans (a touch pointer has always been a pointer); two
fingers pinch — the frame is panned by their midpoint and zoomed by the distance
between them, in one motion. A pinch never drops a seed.

### The math keyboard

A panel that slides up when a row has the caret and **replaces the OS keyboard
entirely**. It drives the field through the command API and nothing else:

```js
field.insert(text)     // types text, inflating structure
field.command(name)    // one editing command
field.touchDriven      // suppresses the OS keyboard
```

**No synthetic key events, no hidden `<input>`.** A tap and a keystroke reach the
model through one path, so the two cannot drift. Everything is **probed**,
exactly the way `vector_field` and `trajectory_from` are: with `insert` and
`command` absent the same operations go through the model the field has always
exposed, followed by the render and the `onChange` the field would have fired
itself. The keys work either way; the path they take is the only difference.

The layout — six columns, five rows, three pages:

```
 123 | abc | f(x)                                       ⌄
 k   x   y   t   π   e            ← the document's own names, scrolling
 ─────────────────────────────────────────────────────────
  7   8   9   ▫⁄▫   (   )
  4   5   6   ×    ▫˄   √
  1   2   3   −    ′    ,
  0   .   =   +    ⌫⌫
  ←   →   ↑   ↓    ↵↵
```

- **`abc`** is the rest of the alphabet, a–z, plus the subscript key (a subscript
  labels a letter, so it lives where the letters are).
- **`f(x)`** is every function and constant the engine answers to, three to a
  row. Pressing one inflates the call, drops the caret between the parentheses
  and hands the panel back to the digits — because an argument comes next.
- **The name row is the document's own vocabulary.** States, parameters and user
  functions, then `x y t`, then the constants. That is what makes it fast to
  type *this* system rather than a generic one. Read from `field.documentNames`
  when the field publishes it, and from the shell's own `docNames()` otherwise.
- **`e` writes `exp(1)`**, because the engine has `exp` and no `e` constant. The
  key produces the number, not a variable nothing defines.
- **The fraction key is the ÷ key.** In this notation they are one thing, so
  there is one key and it is drawn as a fraction rather than lying about it.

**Structure keys insert structure.** `√` does not type four letters — it inflates
a real radical and leaves the caret inside the radicand, exactly as typing
`sqrt` does on a desktop. Same for the exponent, the fraction and the prime.

**Backspace and the arrows repeat on hold** — 380ms before the first repeat, so
a deliberate single tap can never become two, then every 55ms.

**The panel never covers the row being edited.** The row list is its own
scroller and the panel is fixed to the bottom of the viewport, so this is one
subtraction: the visible bottom of the list is the lower of the list's own
bottom and the top of the panel, and the focused row is scrolled above it.
Nothing is resized and nothing is reflowed — only `scrollTop` moves, which is
what a scroller is for. The list carries an extra `--kb-pad` of bottom padding
while the panel is up, so the *last* row can still reach the top of it; that
padding changes once, when the panel opens, never while anything is typed.

**Dismissable and easy to get back**: the `⌄` on the panel closes it, and a
`keys` button appears in the issue bar in its place. Tapping into a row brings it
straight back.

### How the panel decides it is wanted

Getting this wrong in the permissive direction costs a desktop user a third of
their screen, so it arms on **evidence**, not on a guess:

1. **Capability, but only the unambiguous kind.** `(pointer: coarse)` alone says
   "the primary pointer is a finger" — and a touchscreen laptop reports coarse
   for its screen while its owner is on the trackpad. So the panel arms at boot
   only when the device *also* has no fine pointer at all
   (`(any-pointer: fine)` does not match): a phone or a tablet, with no mouse
   anywhere.
2. **Evidence.** On everything else — a Surface, a touchscreen monitor — the
   first `pointerdown` whose `pointerType` is `touch` or `pen` arms it. A hybrid
   user gets the panel the moment a finger actually touches the glass, and never
   before.
3. **It unarms.** A real `keydown` carrying a character, while a row has the
   caret, means a physical keyboard is present and being used — an iPad with a
   case. The panel goes away and stops arming itself for the rest of the session.
4. **It is always reachable.** The `keys` button opens it by hand on any device.
   Nothing here is a trap in either direction.

A mouse user who has never touched the screen never sees it: focusing a row
raises nothing, and the `keys` button is not on screen either.

On a screen wider than 720px the panel is a 420px card in the bottom-right
corner rather than a full-width bar — a keyboard the width of a monitor is a row
of keys a metre apart.

### What the suite can inspect

`globalThis.__numplaInspect` gained, for all of the above:

| call | answers |
|---|---|
| `layout()` | `{ narrow, pane, breakpoint, width }` |
| `setViewport(w, h)` | resize the window and re-run the breakpoint |
| `setPane(name)` | `plot` or `system`, as the switch does |
| `touch()` | `{ on, reason, locked }` |
| `setTouch(on)` | force it; `null` re-runs the capability probe |
| `keyboard()` | `{ open, page, height, keys, vars, keep, api }` — `keep` is what the last "keep the row visible" pass actually did |
| `setKeyboard(on)` | open or close it by hand |
| `press(id)` | press one key by id, exactly as a tap does |
| `activeRow()` | which row the keys are typing into |
| `source()` | the document as the compiler sees it |
| `setFieldApi(on)` | hide `insert`/`command` on every row, so the fallback path can be proved |
| `names()` | `{ states, params, derived }` as the compiler reported them |
| `demoView()` | `{ want, pending }` — the view the last-loaded demo asked for |
| `route()` | `chooser` \| `solve` \| `compute` |
| `setRoute(name)` | go somewhere, as the cards do |
| `cas()` | `{ available, ops, mounted, input, lastOp, log }` |
| `setCasApi(next)` | `false` = "this build has none", an object = a stub, `null` = whatever the probe found |
| `typeCas(text)` | type into the compute field, through the field's own typing path |
| `clearCas()` | empty it |
| `runCas(op)` | run one operation, exactly as its button does |

`probe()` reports `cas` beside `field` and `seed`, so a suite can tell a build
that has the CAS calls from one that does not — and drive the whole pane against
a stub either way.
