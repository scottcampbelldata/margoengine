# @margoengine/core

WebGPU rendering with WebGL2 fallback, a deterministic Rust/Wasm transform kernel, instanced PBR, reversed float depth, picking and CAD camera controls.

Desktop scenes use 4× MSAA with a canvas DPR cap of 1; phones use single-sample rendering with a DPR cap of 2. Color and depth targets follow canvas resize. Optional scene captures retain that sampling policy and expose single-sample resolved textures. CSS layout and HTML text retain native density.

`engine.pick(x, y)` updates scene state without forcing a color frame. For cached forward-pass IDs, instance culling in a 3×3 micro frustum and neighbor resolution, attach the optional `Picking` plugin from `@margoengine/selection`.

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
