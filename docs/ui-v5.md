# UI v5 — the window is the query

## The idea that replaces `t`

`t` has been a slider, then a row, and it has been useless both times. The
reason is that it was answering a question nobody asked. Nobody wants to *set*
a time span; they want to **look somewhere**, and have the software compute what
they are looking at.

So `t` disappears entirely, and:

> **The visible window is the integration span.** What is on screen is what gets
> solved, at the resolution the screen can show.

- Delete the `t` row, the `t` slider, the playhead, the per-curve playhead
  markers, and play/pause. All of it was ceremony around a number the frame
  already knows.
- Pan or zoom the horizontal axis and the model re-solves over the new span.
- Sample count follows the pixel width — asking for more points than the canvas
  can draw is waste, asking for fewer is a lie.
- Zooming out far enough is a genuinely longer integration and may take longer.
  That is honest and the telemetry already says so.

This is why the earlier versions felt dead: the frame and the solve were two
separate ideas, and the user was made to operate both. They are one idea.

## One plot. Everything in it. Nothing tiled.

There is **one** drawing surface and one frame. Every enabled view draws into
it, overlapping. No tiling, no split panes, ever.

- `t–y` maps time to the horizontal axis — and because the window is the span,
  that axis *is* the integration range.
- `phase` maps state 0 to horizontal, state 1 to vertical.
- `polar` maps `(r, theta)` to the same cartesian frame.

They share the frame deliberately. The frame defaults to −5…5 on both axes and
belongs to the user; a re-solve never moves it.

**The toggles live in a small menu**, not as three chips spending permanent
width. Views that the model supports turn on **automatically**; the menu is how
you turn one *off* when it is in the way.

## The mode switch earns the strip instead

The space the view chips occupied goes to the thing worth reaching for
constantly: **discrete versus continuous** — the integrator. Adaptive
Runge–Kutta (Tsit5) against the fixed-step symplectic methods (Verlet,
Yoshida4). Switching should be one click, always visible, and the current
choice legible at a glance.

That is the mode slider from `VISION.md`, finally on the surface, and paired
with a derived energy row it is the whole Ge–Marsden lesson in one gesture.

## The system panel is too airy

Rows waste vertical space. Tighten the line spacing so more of the document is
visible at once. A system is read as a block; every row pushed off-screen costs
more than the breathing room gains.

## A document should say what to look at

The `colliding-strings` demo draws twelve curves because it has twelve states.
Nobody wants twelve; they want **two** — one line per string.

So a demo may declare which series are worth drawing:

```js
{ id: 'colliding-strings', show: ['a_2', 'b_2'], ... }
```

- `show` lists state or derived names. When present, only those are drawn and
  only those appear in the legend.
- Absent means draw everything, which is right for a two-state system.
- The states not drawn are still solved — this is a display choice, not a model
  change.

This is the smallest version of a real missing feature (the document cannot yet
say how it wants to be viewed). Demos get it first because they are where the
problem bites.
