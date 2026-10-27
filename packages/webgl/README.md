# @margoengine/webgl

Import `margoengine/webgl` from the `margoengine` package, or `@margoengine/webgl` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

WebGL2 fallback renderer for browsers without WebGPU. It draws core meshes with core's PBR
material, shaded per pixel (GGX metallic-roughness from each mesh's constant colour and factors, one directional
light plus ambient, no textures, effects or picking);
optional packages that need WebGPU stay unavailable on this path.

```ts
import {Engine} from 'margoengine/core';
import {webglRenderer} from 'margoengine/webgl';

// WebGPU when available, otherwise WebGL2.
const engine = await Engine.create(canvas, {backend: 'auto', fallback: webglRenderer});
```

Without a `fallback`, `backend: 'auto'` requires WebGPU and `Engine.create` rejects with
"WebGPU unavailable"; `backend: 'webgl2'` always uses the fallback. The renderer lives outside
core, so apps that target WebGPU only do not load its 3,021 B min+gzip
([entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)).

Without React, load it only when WebGPU is missing (needs no core change; WebGPU users download nothing of
this package, because the dynamic import is a separate chunk that never runs for them):

```ts
import {Engine} from 'margoengine/core';

const fallback = navigator.gpu ? undefined : (await import('margoengine/webgl')).webglRenderer;
const engine = await Engine.create(canvas, {fallback});
```

In React, use the Canvas props `loadFallback={() => import('margoengine/webgl')}` and `fallbackContent`
(see the [React README](../react/README.md)).

`fallback: canvas => webglRenderer(canvas, {transparent: true})` gives the WebGL2 canvas `alpha: true`
(premultiplied) and a transparent clear: the WebGL side of `TransparentCanvas` from
`@margoengine/environment`, which only acts on WebGPU (core passes nothing to the fallback).

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/webgl
