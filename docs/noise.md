# Randomness and noise

## The trap, first

The obvious implementation — a `rand()` builtin that returns a fresh number
every time it is called — **is broken here**, and it is worth being explicit
about why before any code is written.

1. **Adaptive solvers evaluate the same point more than once.** Tsit5 calls the
   right-hand side six times per step, retries rejected steps, and computes an
   error estimate by comparing two solutions of *the same interval*. If `f(t, y)`
   returns something different each call, the error estimate is measuring noise
   rather than truncation error. The controller responds by shrinking the step
   forever. The integration does not converge; it grinds to `StepTooSmall`.
2. **Scrubbing demands reproducibility.** Dragging time backwards must show the
   same trajectory it showed a moment ago. A non-deterministic right-hand side
   makes the picture change every frame.
3. **Nothing would be reproducible.** Two runs of the same document would
   disagree, so nothing could be saved, shared, or compared against a knob
   change.

So the rule is:

> **Noise is a deterministic function of time.** Same `t`, same seed, same
> value — always. Randomness enters through the *seed*, not through the call.

This costs nothing in expressiveness and buys reproducibility, working
scrubbing, and a solver that converges.

## Noise as a signal

A noise source is a function `n(t)` defined by sampling a seeded generator on a
lattice of spacing `1/rate` and interpolating between lattice points. The
interpolation is what makes it band-limited, and band-limiting is what makes it
integrable: a signal with unbounded high-frequency content forces the step size
to zero for the same reason non-determinism does.

`rate` is therefore a real parameter with real consequences, not a hidden
constant, and it should be visible to the user.

## Types

| Name | Spectrum | Character | Use |
|---|---|---|---|
| `white(t)` | flat | harsh, every frequency equally | forcing, dither |
| `pink(t)` | 1/f | natural, balanced | most physical noise |
| `brown(t)` | 1/f² | drifting, wandering | random walks, slow drift |
| `blue(t)` | f | thin, hissy | complements pink |
| `smooth(t)` | band-limited lattice | rolling, continuous | organic parameter drift |
| `telegraph(t)` | two-state | switches between ±1 | on/off forcing, jumps |

`smooth` is the value-noise/Perlin-style generator and is the safest default
for driving a physical model: it is continuous and differentiable enough not to
fight the integrator.

## Surface in the math language

```
white(t)            pink(t)           brown(t)
blue(t)             smooth(t)         telegraph(t)
```

Each also takes optional arguments: `smooth(t, rate)` and `smooth(t, rate, seed)`.
Defaults come from the document. Explicit `seed` gives **independent** streams —
essential, because two noise sources in one model must not be correlated by
accident.

Non-time randomness for one-shot values:

```
rand(seed)          uniform on [0, 1)
randn(seed)         standard normal
```

These are pure functions of their seed, not stateful generators. `rand()` with
no argument draws from the document seed and a call-site counter, so it is
stable across re-evaluations of the same document.

## Later: real stochastic differential equations

Genuine SDE integration (`dX = f dt + g dW`) is a different mechanism: it needs
Euler–Maruyama or Milstein with a **fixed** step and a Brownian path that is
sampled once and refined consistently (a Brownian bridge) rather than a
deterministic function. That is worth building, but it is a separate solver
mode, not a builtin function, and it does not block any of the above.

Keeping the two apart matters: `brown(t)` is a *drifting signal you can use as
forcing*, not a Wiener process with correct scaling under step refinement. The
documentation must not blur that.

## Requirements

- New crate `numpla-noise`, no dependencies (write the PRNG — a small
  counter-based hash like SplitMix64 or PCG is a few lines and avoids pulling in
  `rand`, which is heavy and awkward under `wasm32`).
- Deterministic and platform-independent: the same seed must give the same bits
  on every target, so no floating-point-dependent hashing and no `HashMap`
  iteration order.
- Cheap: these are called inside the integration hot loop.
