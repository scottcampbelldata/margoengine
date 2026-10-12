# @margoengine/gltf

Lazy static glTF/GLB loading, named nodes and shared primitive geometry for Margo Engine.

Package name: `@margoengine/gltf`, version `0.1.0`. Build from source or install a local tarball until the renamed package is published.

```sh
npm install @margoengine/core@0.1.0 @margoengine/gltf@0.1.0
```

```ts
import { Engine } from '@margoengine/core';
import { loadGLTF } from '@margoengine/gltf';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas);
const model = await loadGLTF(engine, '/model.glb');
engine.start();
// On teardown: model.dispose(); engine.dispose();
```

This ESM package includes TypeScript declarations and requires `@margoengine/core` 0.1.0. See the [supported glTF subset and lifecycle guide](https://github.com/scottcampbelldata/margoengine/blob/main/MODERN-ENGINE.md) before importing assets.

MIT licensed.
