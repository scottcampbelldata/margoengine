# create-margo

Start a [Margo Engine](https://margoengine.com) app (Vite + TypeScript) with one command:

```sh
npm create margo@latest my-app
# or: pnpm create margo my-app / yarn create margo my-app / bun create margo my-app
```

It copies a small scene with image-based lighting, orbit controls, the stats overlay and measured quality tiers into
`my-app` (default `margo-app`), asks no questions and refuses to write into a non-empty directory. No dependencies.

Tests: `node --test tests/create-margo.test.js` from the repository root (scaffolds, type-checks and builds the app
against the local packages); `node tools/create-margo/test/browser-check.mjs` renders it in a real browser.
