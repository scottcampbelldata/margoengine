# @margoengine/headless

Render a scene with no page and get PNG bytes back: server thumbnails, an asset pipeline, automated tests. Core draws to
a stand-in canvas, and the frame stays readable because nothing presents it.

This package ships no WebGPU binding, because one is a large download that runs code when installed. Your app chooses
one and passes its `gpu` in. It can be any object with `requestAdapter`: `create([])` from a Node binding such as
[`webgpu`](https://www.npmjs.com/package/webgpu), or `navigator.gpu` in a browser or worker.

```ts
import { writeFile } from 'node:fs/promises';
import { Camera, Engine, box, PbrMaterial } from '@margoengine/core';
import { createHeadlessCanvas, installGPU, toPNG } from '@margoengine/headless';

declare const gpu: GPU; // from your binding

using installed = installGPU({ gpu });
const canvas = createHeadlessCanvas({ width: 512, height: 512 });
const engine = await Engine.create(canvas, { backend: 'webgpu' });
engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#84d6bd' }));
engine.render({ camera: new Camera({ position: [2, 2, 3], target: [0, 0, 0] }) });
await writeFile('cube.png', await toPNG(engine));
engine.dispose();
```

| Export | What it does |
| --- | --- |
| `installGPU({ gpu, globals? })` | Sets `navigator.gpu` and the `GPU*` flag globals a runtime lacks; adds `getPreferredCanvasFormat` (`'rgba8unorm'`) if the binding has none. `globals` defaults to none. `dispose()` or `using` restores everything. |
| `createHeadlessCanvas({ width, height })` | The canvas to pass to `Engine.create`. Both sizes are required. Set `canvas.width` and `canvas.height` to resize; the next `engine.render()` uses them. |
| `readPixels(engine, { signal? })` | The last frame as `{ width, height, data }`: RGBA, straight alpha, top row first. |
| `toPNG(engine, { signal? })` | The last frame as PNG file bytes. |

Call `engine.render()` yourself: `engine.start()` needs `requestAnimationFrame`, which Node does not have. `createStage`
needs a page, so use `Engine` and packages that take an engine, such as `parseGLTF` from `@margoengine/gltf`.

The errors are listed at [margoengine.com/errors#headless](https://margoengine.com/errors#headless).
