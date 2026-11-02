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
   `package-lock.json`).
2. Clone each app and run `npm install` in it.

## Engine dependency preparation

Existing Margo applications call `scripts/engine-sync.mjs` from the private sibling checkout. It is a compatibility
boundary for application dependencies, not a workflow controller: it never fetches, merges, creates branches or
worktrees, commits, or pushes. It verifies that the engine has no tracked changes, builds missing package artifacts
from the checkout already selected by the user or Agent Factory, and writes the ignored app-local
`.engine/manifest.json`.

Each app's Vite config uses `engineBuildInfo()` from `scripts/engine-build-info.mjs`: every build carries the engine
commit as `<meta name="margo-engine">` in `index.html`, in `build-info.json` beside it and as
`import.meta.env.MARGO_ENGINE_COMMIT` for an About box. A build without `.engine/manifest.json` fails.

Every `@margoengine` dependency must resolve from the verified private sibling checkout at
`file:../margoengine/packages/<name>`. `engine-sync.mjs --check` validates those links, build stamps, and the manifest
boundary. Do not commit vendored engine source, `.engine/`, or engine tarballs in an app.

Never pin, copy or vendor an engine version in an app.
