# @margoengine/core

WebGPU rendering (WebGL2 fallback via the optional `@margoengine/webgl`), a deterministic Rust/Wasm transform kernel, instanced PBR, reversed float depth, picking and CAD camera controls.

Desktop scenes use 4× MSAA with a canvas DPR cap of 1; phones use single-sample rendering with a DPR cap of 2. For slower desktop GPUs, set `globalThis.margoLow` to a pixel ratio (for example `1` or `1.5`) before creating the engine: scenes then render single-sampled with the DPR capped at that value, which on an integrated laptop GPU roughly halves GPU time compared with 4× MSAA. The site demos choose this light tier by measuring the GPU rather than guessing from the device. Color and depth targets follow canvas resize. Optional scene captures retain that sampling policy and expose single-sample resolved textures. CSS layout and HTML text retain native density.

`engine.pick(x, y)` updates scene state without forcing a color frame. For cached forward-pass IDs, instance culling in a 3×3 micro frustum and neighbor resolution, attach the optional `Picking` plugin from `@margoengine/selection`. On a canvas without client size (an `OffscreenCanvas` in a worker) pick coordinates are canvas pixels.

Static scenes cost little per frame: the kernel recomputes only entities whose position, rotation, scale, parent, bounds or visibility changed (and their descendants); the engine reuses last frame's instance list unless the mesh set, a geometry or material assignment, a material's values, visibility or the culling result changed, and otherwise patches only the moved matrices; the WebGPU renderer uploads only the changed instance range. Contract for `@margoengine/core/extension` users: the per-geometry instance buffers (`engine.geometryBuffers(geometry).instance`) belong to core and are read-only for packages (bind them, never write them; use your own buffer, as `@margoengine/selection`'s micro pick pass does), and `store.matrices` is kernel output (change transforms through the mesh, never by writing world matrices).

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

Call `engine.dispose()` when the canvas is removed. Wasm is embedded; no Rust toolchain or Wasm bundler plugin is required. The public API is exported from `@margoengine/core`; raw GPU/Wasm access uses the explicit `@margoengine/core/extension` entry. Both entries include TypeScript declarations.

TypeScript 7+ with DOM types, Wasm SIMD and DecompressionStream gzip support are required. WebGPU requires HTTPS or localhost. See the [API and lifecycle guide](https://github.com/scottcampbelldata/margoengine/blob/main/MODERN-ENGINE.md) and [measured baselines](https://github.com/scottcampbelldata/margoengine/blob/main/benchmarks/README.md).

MIT licensed.
