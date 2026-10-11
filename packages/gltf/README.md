# @scottcampbelldata/vexel-gltf

Lazy static glTF/GLB loading, named nodes and shared primitive geometry for Vexel.

```sh
npm install @scottcampbelldata/vexel-core @scottcampbelldata/vexel-gltf
```

```ts
import { Engine } from '@scottcampbelldata/vexel-core';
import { loadGLTF } from '@scottcampbelldata/vexel-gltf';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas);
const model = await loadGLTF(engine, '/model.glb');
engine.start();
// On teardown: model.dispose(); engine.dispose();
```

This ESM package includes TypeScript declarations and requires `@scottcampbelldata/vexel-core` 0.1.0. See the [supported glTF subset and lifecycle guide](https://github.com/scottcampbelldata/vexel/blob/main/MODERN-ENGINE.md) before importing assets.

MIT licensed.
