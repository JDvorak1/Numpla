# Phones

Numpla is laid out for a desktop: two panes and a draggable divider. On a phone
that is unusable, and the deeper problem is that **a phone keyboard cannot write
mathematics**. `^`, `√`, a fraction bar and a prime are all several taps deep
behind a symbols page, if they are there at all.

So two things, and the second is the one that matters:

1. A layout that works on a narrow screen.
2. **A keyboard built for equations**, replacing the OS one entirely.

## Layout

Below roughly 720px the two panes stop being side by side:

- The plot takes the top of the screen, the system the bottom, and the divider
  becomes a horizontal one — or a segmented switch between them if dragging a
  horizontal divider proves worse. Pick whichever is genuinely better on a
  phone and say why.
- Controls that spend width on a desktop (the views menu, the integrator switch,
  the demo and reference buttons) need somewhere sensible to go rather than
  wrapping into a mess.
- Everything already decided still holds: nothing reflows while typing, panes
  scroll internally, overlays do not push layout.
- Touch targets: nothing smaller than 44px, including the seed handles and the
  row delete buttons.

## The keyboard

A panel that slides up from the bottom when a row has focus, and **suppresses
the native keyboard entirely**. It drives the math field through its own
command API — no synthetic key events, no hidden `<input>` to keep in sync.

It needs, at minimum:

- **Digits** and `.`
- **Operators**: `+ − × ÷ = ( ) ,`
- **Structure**, the whole point of the exercise: fraction, exponent, radical,
  subscript, prime
- **Variables**: the letters the document already uses, plus `x y t` — offering
  the document's own names is what makes it fast
- **Functions**: `sin cos tan ln exp` and the constants `π e`
- **Navigation**: left, right, up, down, backspace, and a key that makes the
  next row
- A way to reach the rest of the alphabet without leaving the panel

Design notes that matter more than the key list:

- **Structure keys must insert structure**, not characters. The radical key
  inflates a real radical with the caret inside it, exactly as typing `sqrt`
  does on a desktop.
- Repeating keys (backspace, arrows) should repeat on hold.
- The panel must not cover the row being edited. Scroll the focused row into
  view above it.
- Dismissable, and re-openable without hunting.

## Contract: the field's command API

`MathField` already exposes a model that the desktop key handler drives. The
keyboard needs the same operations as a public, documented API, so that a tap
and a keystroke go through one path — two paths would drift.

```js
/** Type text as if it were typed: 'x', '2', 'sin', '+'. Inflates structure
 *  exactly as the keyboard would (so 'sqrt' becomes a radical). */
field.insert(text)

/** One editing command. Names are stable; unknown names are ignored, not thrown.
 *  'frac' | 'sup' | 'sub' | 'sqrt' | 'prime'
 *  'backspace' | 'delete'
 *  'left' | 'right' | 'up' | 'down' | 'home' | 'end'
 */
field.command(name)

/** True when this field should not raise the OS keyboard. */
field.touchDriven          // settable; also a constructor option
```

Both must fire `onChange` the way typing does, and leave the caret where a
person would expect it — inside the radical, in the numerator, after the prime.
