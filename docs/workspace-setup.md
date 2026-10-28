# Workspace setup: the engine and the Margo apps

Every Margo app builds against the engine checkout beside it, always at the latest `origin/main`. There is one engine
folder per machine, so no app can hold its own engine version. Installed copies of an app carry the engine inside
their build; only developers need this layout.

## Layout

Clone the engine and the apps side by side in one folder (any folder; nothing depends on its path):

```
<workspace>/
  margoengine/            https://github.com/scottcampbelldata/margoengine
  MagicaVoxel/            Margo Voxel Studio
  crocotile3d/            MargoTile
  blockbench/             Margo Mesh
  margopixel/             Margo Pixel
  margo3d-studio-clone/   Margo3D Studio (GitHub margo3d)
```

The folder names matter: each app finds the engine at `../margoengine`.

## Prerequisites

- Node.js 24.18 or later and npm (the repository minimum). End users: Node 22.12 or newer (tested on 22.12 and the
  latest 22.x, 24.18 and 26). Contributors: Node 24.18 or newer. The unit tests of the packages that run code in
  Node (`scripts/node22-packages.json`) also run on Node 22: `npm run test:node22` with a Node 22 first on PATH, after
  `npm run build:packages`; see CONTRIBUTING.md.
- git and git-lfs (`git lfs install` once per machine).
- Margo3D Studio only: Rust with the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` at the version its
  `Cargo.toml` names.

## Order

1. Clone the engine and run `npm ci` in `margoengine` (`npm ci` installs the locked versions without rewriting
   `package-lock.json`; `npm install` can rewrite it, and `engine:sync` refuses a changed engine checkout).
2. Clone each app and run `npm install` in it. Its `postinstall` runs `npm run engine:sync`.

## What `engine:sync` does

Each app's `engine:sync` runs the engine's `scripts/engine-sync.mjs`. It runs before `dev`, `test` and `build` and
after `npm install`:

- fetches `../margoengine` and fast-forwards its `main` to `origin/main`;
- fails if the engine checkout has uncommitted changes, is on another branch or cannot fast-forward; offline, it
  warns and continues only when local `main` equals the last fetched `origin/main`;
- runs `npm ci` in the engine if it has no `node_modules`, and `npm run build:packages` when a package the app
  uses was not built from the current commit;
- writes `<app>/.engine/manifest.json` (ignored by git) with the engine commit and packages.

Each app's Vite config uses `engineBuildInfo()` from `scripts/engine-build-info.mjs`: every build carries the engine
commit as `<meta name="margo-engine">` in `index.html`, in `build-info.json` beside it and as
`import.meta.env.MARGO_ENGINE_COMMIT` for an About box. A build without `.engine/manifest.json` fails.

If `../margoengine` is missing, the app's `engine:sync` stops with the `git clone` command to run.

Each app's `check:engine-apis` runs `engine-sync.mjs --check`: every `@margoengine` dependency must be
`file:../margoengine/packages/<name>` and resolve there, each package the app uses must be built from engine HEAD,
and nothing engine-related (`vendor/margo*`, `.engine/`, tarballs) may be committed in the app.

Never pin, copy or vendor an engine version in an app.
