# The compute pane — an online Maple

The CAS answers questions but cannot yet *solve* one: `2x = 2` is refused. That
is the gap, and closing it properly means the pane becomes a worksheet rather
than a calculator with four buttons.

## Commands

Typed as functions, not chosen from buttons. A worksheet is written, not
clicked.

| | |
|---|---|
| `solve(2x = 2, x)` | the solutions. `x` may be omitted when there is one unknown |
| `eval(e)` | the best exact form the CAS can reach |
| `evalf(e)` | a number, always |
| `equal(e)` | **every equivalent form it can find**, to choose from — see below |
| `simplify(e)` `expand(e)` `factor(e)` | as now, and also feeding `equal` |
| `diff(e, x)` | as now |
| `sum(e, k, a, b)` `product(e, k, a, b)` | closed form where one exists, else a number |
| `subs(x = 3, e)` | substitution |

**Enter evaluates.** A bare expression with no command is `eval`.

## `%` — the ditto operator

`%` is the previous result, `%%` the one before, `%%%` the one before that —
Maple's own convention. It is substituted before parsing, so `%` is genuinely
the previous *expression*, not a reference to be resolved later.

This is what makes a worksheet a worksheet: `diff(x^3, x)` then `solve(% = 12)`
without retyping anything.

## `equal` — the point of the exercise

Given an expression, return **all the ways of writing it that the system can
find**, as a list the user picks from. `equal(1^(1/2))` should offer `sqrt(1)`
and `1`. The user's words: *"a vast amount of equation and alternative ways of
writing something, kinda like expand and simplify but with more options"*, and
*"the expand and simplify result should also show up in the choice list"*.

Sources for candidates, each labelled with how it was obtained:

- `simplify`, `expand`, `factor` — the existing rewrites are candidates too
- radical ↔ exponent (`sqrt(u)` ↔ `u^(1/2)`)
- logarithm laws in both directions (`ln(ab)` ↔ `ln a + ln b`, `ln(u^n)` ↔ `n ln u`, `log(b,u)` ↔ `ln u / ln b`)
- exponent laws where they are genuinely valid (integer exponents only — see below)
- trigonometric identities: Pythagorean, double angle, sum-to-product
- rationalising, common denominator, partial fractions where cheap
- the numeric value, and **`evalf`**

### Going backwards: identify

The user remembers Maple returning `zeta()` for a sum, because it *recognised*
the value. That is inverse symbolic lookup, and it belongs here.

When an expression is numeric, search a table of closed forms for anything that
matches it to near machine precision, and offer those as candidates: rationals,
`pi`, `e`, `sqrt(n)`, `ln(n)`, `pi^2/6` and friends, the golden ratio, and small
rational multiples and simple combinations of them. A match must agree to a
tolerance tight enough that a coincidence is implausible, and it must be
**labelled as a numeric identification**, not presented as a proven identity —
the difference matters and the UI must be able to show it.

### The rule that keeps it honest

**Every candidate must equal the input.** Same property test as the existing
rewrites: evaluate input and candidate at many points and compare. A candidate
that is only *sometimes* equal — `sqrt(u^2) = u`, `ln(e^u) = u`, `(u^a)^b =
u^(ab)` — must either carry its condition or not be offered. An "equal" list
containing something unequal is worse than no list at all.

## Sums, products, logarithms

- `sum(k, k, 1, n)` → `n(n+1)/2`. Closed forms for a constant, `k`, `k^2`,
  `k^3`, and geometric `r^k`; numeric evaluation when the limits are numbers;
  an honest refusal otherwise.
- `product` likewise, including factorial-shaped cases.
- Logarithms need real support in `simplify` and `expand`, not just as `equal`
  candidates.

## Autocomplete

Typing `sol` and pressing Tab gives `solve(⎸)` with the caret **inside the
parentheses**. The math field already has tab completion driven by a name list;
the compute pane's list is these commands. Show the signature while choosing.

## Document style

A worksheet: input, then its result beneath, then the next input — a scrolling
document you can go back through, not a form with an answer box. Every result
is selectable, insertable, and reachable by `%`.
