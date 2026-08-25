# Hosting

Numpla is a **static site**. There is no server, no API, no database — the
entire compute core runs in the user's browser as WebAssembly. `app/serve.mjs`
exists only because some local dev servers send the wrong MIME type for `.wasm`;
it is not part of the deployment.

That makes GitHub Pages a natural fit, and it is what `.github/workflows/pages.yml`
deploys to.

## What gets published

```
app/index.html      app/styles.css     app/main.js
app/mathfield.js    app/mathfield.css  app/plot.js
app/pkg/            <- built by wasm-pack in CI, never committed
```

`app/pkg/` is a build artifact and is gitignored. CI builds it fresh from the
Rust crates on every push, so the published WASM always matches the source.

## The constraint worth knowing about: no threads

GitHub Pages **cannot set custom response headers**, which means it cannot send
`Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`. Without those two
headers, browsers refuse to enable `SharedArrayBuffer`, and without
`SharedArrayBuffer` there is **no multithreaded WebAssembly**.

Concretely: `wasm-bindgen-rayon` and any threaded parallelism are unavailable as
long as we host on Pages.

This is a real constraint but an easy trade for a single-user interactive tool,
and it should shape the performance work rather than be discovered during it:

- **The performance path is single-threaded and must stay that way.** When the
  AST tree-walk becomes the bottleneck (it will — the right-hand side is
  evaluated six times per step), the fix is to compile expressions to a flat
  tape/bytecode with no allocation in the hot loop. That is the same
  representation `numpla-autodiff` needs, so the work pays for itself twice.
- Do **not** add `rayon` to any crate that must run in the browser.
- SIMD (`wasm32` 128-bit) *is* available and needs no special headers. That is
  where the parallelism budget goes.

If threading ever becomes genuinely necessary, hosting has to move to something
that can set headers (Cloudflare Pages, Netlify, a plain nginx). That is a
hosting decision, not a code decision — which is exactly why it is written down
here rather than discovered later.

## Other options, for reference

| Host | Custom headers | Notes |
|---|---|---|
| GitHub Pages | no | Free, zero config, tied to the repo. Current choice. |
| Cloudflare Pages | yes (`_headers`) | Free tier, would unlock threads. |
| Netlify | yes (`_headers`) | Same. |

## Local development

```
wasm-pack build --target web --out-dir ../../app/pkg crates/numpla-wasm
node app/serve.mjs        # http://localhost:5173
```
