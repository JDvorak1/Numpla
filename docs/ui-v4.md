# UI v4 — the plot becomes the instrument

## 1. `t` and the bottom bar are dead weight

The playhead currently changes a number nobody looks at. The plot draws the
whole trajectory regardless of `t`, so dragging time has no visible effect —
which makes both the slider and the entire bottom bar useless, and they cost a
strip of screen the plot should have.

Two changes, together:

- **Make `t` do something.** The playhead must be visible *on the curve*: a
  marker at the current time, and the trajectory drawn as travelled-vs-ahead so
  scrubbing reads as motion rather than as a number changing. Time is the one
  control that should feel like it moves the picture.
- **Delete the bottom bar.** Play/pause, the `t` track and the readout move into
  the plot's own control strip, beside the view toggles. The plot takes the
  reclaimed height.

## 2. Views are toggles, not a choice

`t–y`, `phase` and `polar` stop being mutually exclusive. Each is a switch the
user turns on or off, and more than one may be on at once. Turning on a view
the model cannot support stays impossible (the control stays visible but
inert — it is how the capability is discovered), but nothing is *automatically*
switched off on the user's behalf.

## 3. Axes default to −5…5, and dragging scales them

- Default window is **−5 to 5 on both axes**, not a fit-to-data range. A fixed,
  predictable frame is what makes two runs comparable, and it is what Desmos
  does.
- **Dragging on an axis scales that axis**; dragging the plot body pans.
  Scrolling zooms about the cursor. A visible way back to the default frame.
- The frame is the user's; a re-solve must never silently move it.

## 4. An info box: what does this thing actually support?

Next to the solve status, a control that opens a **searchable reference** of
what the engine supports. This is the answer to "what can I type here?", which
is currently answerable only by reading the source.

It must cover, searchable by name and by description:

- **Functions** — every builtin, with its signature and a one-line description:
  the trigonometric set, `sqrt` `exp` `ln` `log` `abs` `floor` `ceil` `round`
  `sign` `min` `max` `mod`, and the noise family `white` `pink` `brown` `blue`
  `smooth` `telegraph` `rand` `randn`.
- **Row kinds** — `x' =`, `x'' =`, `x(0) =`, `k =`, `f(u) =`, `#`.
- **Notation** — implicit multiplication, subscripts, primes, and the
  call-versus-coefficient rule (`f(u)` is a call only when `f(u) = …` exists).
- **Features** — including **switching the integrator**: adaptive Runge–Kutta
  (Tsit5) versus the fixed-step symplectic methods (Verlet, Yoshida4), and what
  the choice costs and buys. This is the discrete-versus-continuous switch.

Each entry should be insertable or copyable, so the reference is a way to write
rather than only a way to read.

## 5. Demos: fewer words, and a collision

The demo comments are far too long. A demo is read by looking at it, not by
reading an essay. Cut them to at most a line or two per demo.

**New demo — colliding strings**, and this is the audio showcase:

Two plucked strings a knob's distance apart. When they would overlap they must
**push each other apart rather than pass through**. Numpla has no event
detection yet, so contact is a one-sided penalty force — `max(0, overlap)`
times a contact stiffness, which is expressible today with the `max` builtin
and is the standard way to write contact before you have events.

- A knob for the **distance between the strings**, which changes everything:
  far apart they ring independently, close together they clatter.
- Non-penetration must be *tested*, not assumed: assert the strings never cross.
- Marked `audio: true` — collision is what makes it worth hearing.
