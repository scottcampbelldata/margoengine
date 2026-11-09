# WebGL2 package consolidation

The preview and the full compatibility device belong to one optional package,
`@margoengine/webgl2-compat`. The root `install()` path runs the real renderer.
The `/preview` entry preserves the lower-tier renderer on devices without
`EXT_color_buffer_float`; it does not load the translator or compute runtime.

| Former feature | Entry in the combined package | Real WebGL2 evidence |
| --- | --- | --- |
| Core mesh PBR preview, transparency, MSAA, views and frame graph | `/preview`: `webglRenderer`, `GLRenderer` | `test/preview-browser-check.mjs`, existing core draw GPU checks |
| CSS pixel picking, depth, face filtering, views, layers, selection | `/pick`: `webglPicking`, also exports `webglRenderer` | `test/preview-browser-check.mjs`: picks |
| Context loss recovery, retained geometry, reboot and timeout | `/restore`: `webglRestore` | `test/preview-browser-check.mjs`: restore |
| Native WebGPU, preview, then full-device escalation on setup refusal | `/auto`: `autoEngine` | `test/preview-browser-check.mjs`: native and auto |
| Full-device rendering, picking and recovery | root `install()` and existing selection/core APIs | Existing compat GPU suite |

The preview-specific entries remain necessary: the full device requires float
colour attachments, and the preview accepts lower-tier WebGL2. Keeping those
entries also preserves synchronous preview frame graph hooks and renderer factory
options without changing core. Native WebGPU users load neither renderer when
applications use dynamic loaders. The umbrella exposes each new entry under
`margoengine/webgl2-compat`.

## Landing sequence

1. Move implementations and tests into the combined package. The old workspace
   temporarily delegates to those entries until its consumers are switched.
2. Switch consumers and documentation to the new entries.
3. Remove the old workspace and umbrella paths. There is no released deprecation shim.

The core and stage feature freeze and the 25,000 B combined gzip ceiling remain unchanged.

## Inventory at the start

The following tracked files named the former package, its umbrella entry, or its
workspace path. Generated API reports and size records are regenerated as part of
the migration. Historical evidence is retained with its original measurement context.

- `CHANGELOG.md`
- `README.md`
- `THIRD-PARTY-NOTICES.md`
- `api/webgl.api.md`
- `api/webgl.auto.api.md`
- `api/webgl.pick.api.md`
- `api/webgl.restore.api.md`
- `bench/scenes/parity.js`
- `bench/scenes/parity/margo-renderer.js`
- `docs/README.md`
- `docs/api-overview.md`
- `docs/api-surface.md`
- `docs/architecture/operational-playbook.md`
- `docs/catalog.json`
- `docs/from-threejs.md`
- `docs/guides/blender-game.md`
- `docs/guides/imports.md`
- `docs/guides/textures-and-materials.md`
- `docs/known-bugs.md`
- `docs/limits.md`
- `docs/rapier-parity.md`
- `docs/react-nextjs-options.md`
- `docs/three-parity-matrix.md`
- `docs/threejs-parity.md`
- `docs/webgl2-compat-roadmap.md`
- `docs/whitepaper/build-record.md`
- `docs/whitepaper/claims.md`
- `examples/package-benchmarks/results/entry-sizes.json`
- `examples/package-benchmarks/transparent-canvas.html`
- `examples/vite/package.json`
- `examples/vite/src/main.tsx`
- `package-lock.json`
- `package.json`
- `packages/audio/tests/ambisonics-browser.js`
- `packages/audio/tests/doppler-browser.js`
- `packages/audio/tests/events-browser.js`
- `packages/audio/tests/music-browser.js`
- `packages/audio/tests/occlusion-browser.js`
- `packages/audio/tests/zones-browser.js`
- `packages/bvh/tests/bvh-browser.js`
- `packages/controls/tests/controls-browser.js`
- `packages/controls/vite.config.js`
- `packages/core/README.md`
- `packages/core/package.json`
- `packages/core/src/engine.ts`
- `packages/culling/README.md`
- `packages/html/README.md`
- `packages/html/test/html-browser.js`
- `packages/html/vite.config.js`
- `packages/labels/tests/labels-browser.js`
- `packages/margoengine/package.json`
- `packages/margoengine/src/webgl.ts`
- `packages/margoengine/src/webgl/auto.ts`
- `packages/margoengine/src/webgl/pick.ts`
- `packages/margoengine/src/webgl/restore.ts`
- `packages/physics2d/tests/kernel-wasm-browser.js`
- `packages/react/README.md`
- `packages/react/src/components.tsx`
- `packages/react/src/dev-warnings.ts`
- `packages/react/tests/extras-browser.tsx`
- `packages/react/tests/scene-browser.tsx`
- `packages/selection/README.md`
- `packages/selection/src/picking.ts`
- `packages/stage/README.md`
- `packages/text/tests/text-browser.js`
- `packages/ui/README.md`
- `packages/ui/tests/ui-browser.js`
- `packages/video/test/alpha-check.html`
- `packages/video/test/codecs-check.html`
- `packages/video/test/material-check.html`
- `packages/video/test/panorama-check.html`
- `packages/video/test/record-check.html`
- `packages/webgl/README.md`
- `packages/webgl/package.json`
- `packages/webgl/test/browser-check.mjs`
- `packages/webgl2-compat/src/index.ts`
- `packages/webgl2-compat/test/isolation.test.js`
- `packages/worker/README.md`
- `packages/worker/tests/browser-check-worker.js`
- `scripts/build-llms.mjs`
- `scripts/bundler-matrix.mjs`
- `scripts/errors/entries.js`
- `scripts/modern-hardware-gpu-tests.js`
- `scripts/node22-packages.json`
- `scripts/quality/baselines/sizes.json`
- `scripts/scene-helper-tests.js`
- `scripts/test-no-webgpu-browser.mjs`
- `site/errors.html`
- `site/index.html`
- `site/llms-full.txt`
- `site/llms.txt`
- `tests/core-ambient.test.js`
- `tests/core-startup-watchdog.test.js`
- `tests/modern-browser.tsx`
- `tests/modern-msaa.test.js`
- `tests/modern-stress.js`
- `tests/modern-wrapper.html`
- `tests/public-engine-types.test.js`
- `tests/support/core-draw-gpu.js`
- `tests/webgl-preview.test.js`
