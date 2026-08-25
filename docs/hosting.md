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

## Publishing it

The repository has no remote yet. Three steps, once:

1. **Create an empty repository** on github.com — no README, no .gitignore, no
   licence, since this one already has them.

2. **Point this checkout at it and push.** The workflow triggers on `main` or
   `master`, so either branch name works:

   ```
   git remote add origin https://github.com/<you>/Numpla.git
   git push -u origin master
   ```

3. **Turn Pages on**: repository → Settings → Pages → *Source: GitHub Actions*.
   Not "Deploy from a branch" — the site is built by the workflow, because
   `app/pkg/` is a build artifact and is never committed.

The first push runs the workflow: it tests the Rust core, fails the build on any
clippy warning, builds the WASM, runs all four JS suites against that real
module, strips the dev-only files, and deploys. The site lands at
`https://<you>.github.io/Numpla/`.

### Visibility

GitHub Pages on a **private** repository needs a paid plan (Pro/Team/
Enterprise). On the free plan the repository has to be **public** for the site
to be served. The code is a maths app with no secrets in it, so public is the
ordinary choice — but it is a choice, and it is worth making deliberately rather
than discovering when the deploy is skipped.

### If the deploy fails

The `test` job runs before `build`, so a red deploy is nearly always a genuine
test failure rather than a Pages problem — read that job first. The one
environment-specific gotcha is that the JS suites need the WASM built, which the
workflow does explicitly for exactly this reason.

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
