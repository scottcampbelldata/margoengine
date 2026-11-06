# @margoengine/gltf

Import `margoengine/gltf` from the `margoengine` package, or `@margoengine/gltf` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Lazy static glTF/GLB loading, named nodes and shared primitive geometry for Margo Engine.

Package name: `@margoengine/gltf`, version `1.0.0`. Build from source or install a local tarball until the renamed package is published.

```sh
npm install @margoengine/core@1.0.0 @margoengine/gltf@1.0.0
```

```ts
import { Engine } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas);
const model = await loadGLTF(engine, '/model.glb');
engine.start();
// On teardown: model.dispose(); engine.dispose();
```

## Optional features

The root loader reads static models with float positions and constant colours. Each feature below is its own entry, so
a file that needs none of them costs none of their bytes. Pass the ones you want in `extensions`, to `loadGLTF` or
`parseGLTF`; they combine. A file needing something no entry covers still throws, with a pointer to `@margoengine/gltf-pro`.

### Quantized meshes

`@margoengine/gltf/quantized` reads `KHR_mesh_quantization`: integer POSITION (signed or unsigned, 8 or 16 bit,
normalized or not) and normalized signed 8 or 16 bit NORMAL. Optimizers such as gltfpack write these. Values turn into
floats on load, so the file is smaller on the wire and the same size on the GPU.

```ts
import { Engine } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf';
import { quantized } from 'margoengine/gltf/quantized';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas);
const model = await loadGLTF(engine, '/packed.glb', { extensions: [quantized] });
engine.start();
// On teardown: model.dispose(); engine.dispose();
```

This ESM package includes TypeScript declarations and requires `@margoengine/core` 1.0.0. See the supported glTF subset and lifecycle guide before importing assets.

Apache-2.0 licensed.
