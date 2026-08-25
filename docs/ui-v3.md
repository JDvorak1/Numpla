# UI v3 — rows, offers, and saying what is missing

Three corrections, all the same underlying idea: **stop making the user ask for
things the software could have offered.**

## 1. Rows the way Desmos does them

There is no "Add row" button. A button is a thing you have to notice, aim at,
and click; rows should appear because you kept typing.

- **A blank row always sits at the end of the list.** Clicking it starts an
  expression. It is not a real row until something is typed into it — it does
  not count in the numbering, is never diagnosed, and never reaches the solver.
- **Enter** creates a new row below the current one and moves the caret into it.
- **Down** from the last row moves into the trailing blank row.
- **Backspace in an empty row** deletes that row and puts the caret at the end
  of the row above. Deleting the row you are in should feel like deleting a
  character, not like operating a control.
- **Up / Down** move between rows, entering the field at a sensible caret
  position.
- Clicking empty space below the list focuses the trailing blank row.

The delete affordance on a row stays (mouse users need it), but nobody should
ever have to use it to work quickly.

## 2. Not every variable gets a slider

Automatically materialising a slider for every scalar in the document is wrong:
most constants are just constants. A slider is a statement that *this* number is
worth playing with, and only the user knows which ones those are.

- `t` always has a slider. Time is the one knob that is always interesting.
- Every other parameter gets an **offer**, not a slider: a thin, quiet row in
  the controls section reading `k` · *add slider*. One click promotes it.
- A promoted slider can be dismissed back to an offer.
- **Demos are the exception**: a demo declares its knobs, and those arrive
  already promoted, because the demo's author has already answered the question
  of which numbers are worth turning.
- Promotions persist while the document is edited — changing an unrelated row
  must not silently demote a slider the user asked for.

## 3. The issue bar reports missing information, and offers the default

Today a state with no initial condition silently starts at zero. That is a
guess presented as a fact. It should instead be *stated*, and fixable in one
click.

The issue bar (the strip currently showing "clean") becomes the place the
document tells you what it still needs:

- With nothing missing: quiet, unobtrusive.
- With something missing: a plain sentence — "`y` has no starting point" — and
  a button that inserts the default.

This is the same principle as the slider offer: the software knows the answer,
so it should propose it rather than either demanding it or silently assuming it.

### Contract change: `Issue` gains an optional `fix`

Extends `docs/wasm-api.md`. Backwards compatible — `fix` is absent unless the
compiler can propose something concrete.

```jsonc
{
  "line": 2,
  "severity": "pending",
  "message": "y has no starting point",
  "start": 0, "end": 0,
  "fix": {
    "label": "add y(0) = 0",   // button text, imperative
    "insert": "y(0) = 0"       // a complete row to append to the document
  }
}
```

New diagnostic cases the compiler must report:

| situation | severity | message | fix |
|---|---|---|---|
| state has no initial condition | `pending` | "`y` has no starting point" | append `y(0) = 0` |
| lowered velocity state has none | `pending` | "`x'` has no starting point" | append `x'(0) = 0` |
| name used but never defined | `pending` | "`k` is not defined yet" | append `k = 1` |

An undefined name is currently a hard `error`. It becomes `pending` **when the
compiler can propose a definition for it**, because a name you have not defined
*yet* is the ordinary state of a document being written — exactly the
gray-not-red rule, applied one level up. A genuine error (bad syntax, an
unusable row) stays an error.

`line` for a whole-document issue like a missing initial condition should point
at the row that introduced the state, so the UI can highlight something real.
