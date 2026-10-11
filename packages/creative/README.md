# @vexel/creative

WebGPU particles, wind obstacles, procedural atmosphere, toon shading, HDR targets and post-processing for Vexel.

```sh
npm install @vexel/core @vexel/creative
```

```ts
import { Engine } from '@vexel/core';
import { GPUParticles } from '@vexel/creative';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, { backend: 'webgpu' });
engine.use(new GPUParticles({ count: 5000, sort: true, curl: 0.2 }));
engine.start();
```

Call `engine.dispose()` on teardown. Creative rendering requires supported WebGPU hardware on HTTPS or localhost. Import individual effects to let your bundler remove unused features.

This ESM package includes TypeScript declarations and requires `@vexel/core` 0.1.0. See the [effect options and limitations](https://github.com/scottcampbelldata/vexel/blob/main/MODERN-ENGINE.md).

MIT licensed.
