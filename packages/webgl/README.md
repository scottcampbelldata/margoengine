# @margoengine/webgl

WebGL2 fallback renderer for browsers without WebGPU. It draws core meshes with core's PBR
material as flat-shaded geometry (one directional light, no textures, effects or picking);
optional packages that need WebGPU stay unavailable on this path.

```ts
import {Engine} from '@margoengine/core';
import {webglRenderer} from '@margoengine/webgl';

// WebGPU when available, otherwise WebGL2.
const engine = await Engine.create(canvas, {backend: 'auto', fallback: webglRenderer});
```

Without a `fallback`, `backend: 'auto'` requires WebGPU and `Engine.create` rejects with
"WebGPU unavailable"; `backend: 'webgl2'` always uses the fallback. The renderer lives outside
core, so apps that target WebGPU only do not load its about 2.1 kB min+gzip
([entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)).

`fallback: canvas => webglRenderer(canvas, {transparent: true})` gives the WebGL2 canvas `alpha: true`
(premultiplied) and a transparent clear: the WebGL side of `TransparentCanvas` from
`@margoengine/environment`, which only acts on WebGPU (core passes nothing to the fallback).

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/webgl
