# @margoengine/core

WebGPU rendering (WebGL2 fallback via the optional `@margoengine/webgl`), a deterministic Rust/Wasm transform kernel, instanced PBR, reversed float depth, picking and CAD camera controls.

Desktop scenes use 4× MSAA with a canvas DPR cap of 1; phones use single-sample rendering with a DPR cap of 2. For slower desktop GPUs, set `globalThis.margoLow` to a pixel ratio (for example `1` or `1.5`) before creating the engine: scenes then render single-sampled with the DPR capped at that value, which on an Intel Arc 140V laptop cut the island demo's GPU frame from about 20 to 10 ms (particles off) compared with 4× MSAA. The site demos choose this light tier by measuring the GPU rather than guessing from the device. Color and depth targets follow canvas resize. Optional scene captures retain that sampling policy and expose single-sample resolved textures. CSS layout and HTML text retain native density.

`engine.pick(x, y)` updates scene state without forcing a color frame. For cached forward-pass IDs, instance culling in a 3×3 micro frustum and neighbor resolution, attach the optional `Picking` plugin from `@margoengine/selection`. On a canvas without client size (an `OffscreenCanvas` in a worker) pick coordinates are canvas pixels.

Static scenes cost little per frame: the kernel recomputes only entities whose position, rotation, scale, parent, bounds or visibility changed (and their descendants); the engine reuses last frame's instance list unless the mesh set, a geometry or material assignment, a material's values, visibility or the culling result changed, and otherwise patches only the moved matrices; the WebGPU renderer uploads only the changed instance range. On an Intel Arc 140V laptop this made the kernel 2.6-4x cheaper and lets 50,000 CAD parts orbit at 92 FPS instead of 49; an orbiting camera still re-collects every frame, so 90,000 parts stay GPU-bound at 33 FPS ([CAD measurements](https://github.com/scottcampbelldata/margoengine/blob/main/docs/cad-performance.md)). Contract for `@margoengine/core/extension` users: the per-geometry instance buffers (`engine.geometryBuffers(geometry).instance`) belong to core and are read-only for packages (bind them, never write them; use your own buffer, as `@margoengine/selection`'s micro pick pass does), and `store.matrices` is kernel output (change transforms through the mesh, never by writing world matrices).

Package name: `@margoengine/core`, version `0.1.0`. Build from source or install a local tarball until the renamed package is published.

```sh
npm install @margoengine/core@0.1.0
```

```ts
import { Engine, box, PbrMaterial } from '@margoengine/core';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, { backend: 'auto' });
const mesh = engine.createMesh()
  .setGeometry(box())
  .setMaterial(new PbrMaterial({ color: '#84d6bd', roughness: 0.3 }));
engine.onFrame((_, delta) => { mesh.rotation.y += delta; });
engine.start();
```

Materials are live: `material.set({ color: '#ff8800', roughness: 0.2, metalness: 1, doubleSided: false })` changes the given values in place (omitted ones keep theirs; invalid input throws and changes nothing). Every mesh using the material shows it on the next frame with no new pipeline or bind group. A value change re-collects the frame's instances, so each drawn geometry's whole instance range is uploaded once on that frame (only changed ranges after that); for per-frame recolouring of one part among many thousands, give that part its own material or use `@margoengine/materials`. Core materials are opaque (no `opacity`).

Back faces of single-sided materials (`doubleSided: false`) are culled by the GPU: core draws a geometry batch with a second, back-culled pipeline whose shader has no `discard` (so early depth testing stays on) when every drawn instance of that geometry is single-sided and not mirrored (negative-determinant transform). One double-sided or mirrored instance puts the whole batch on the cull-none pipeline, which drops back faces in the shader as before; pixels are the same either way. Flipping `doubleSided` with `material.set`, assigning a material, or mirroring a mesh takes effect on the next frame; un-mirroring a moved mesh moves its batch back to the culled pipeline at the next full re-collection. Passes that replace core's shader text (fog, clipping, clustered lights...) or draw with extra bindings keep the cull-none pipeline. Instance records carry `Batch.mask` for packages: nonzero when the batch needs back faces.

The canvas is opaque. For a transparent canvas over HTML and CSS (three.js `alpha: true`), attach `TransparentCanvas` from `@margoengine/environment`; core needs no option.

Call `engine.dispose()` when the canvas is removed. Wasm is embedded; no Rust toolchain or Wasm bundler plugin is required. The public API is exported from `@margoengine/core`; raw GPU/Wasm access uses the explicit `@margoengine/core/extension` entry. Both entries include TypeScript declarations.

TypeScript 7+ with DOM types, Wasm SIMD and DecompressionStream gzip support are required. WebGPU requires HTTPS or localhost. See the [API and lifecycle guide](https://github.com/scottcampbelldata/margoengine/blob/main/MODERN-ENGINE.md) and [committed measurements and how to reproduce them](https://github.com/scottcampbelldata/margoengine/blob/main/docs/whitepaper/claims.md).

MIT licensed.
