# @margoengine/core

WebGPU rendering with WebGL2 fallback, a deterministic Rust/Wasm transform kernel, instanced PBR, reversed float depth, picking and CAD camera controls.

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

TypeScript 7+ with DOM types, Wasm SIMD and DecompressionStream gzip support are required. WebGPU requires HTTPS or localhost. See the [API and lifecycle guide](https://github.com/scottcampbelldata/vexel/blob/main/MODERN-ENGINE.md) and [measured baselines](https://github.com/scottcampbelldata/vexel/blob/main/benchmarks/README.md).

MIT licensed.
