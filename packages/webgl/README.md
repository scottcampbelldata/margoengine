# @margoengine/webgl

Import `margoengine/webgl` from the `margoengine` package, or `@margoengine/webgl` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

WebGL2 fallback renderer for browsers without WebGPU. It draws core meshes with core's PBR
material, shaded per pixel (GGX metallic-roughness from each mesh's constant colour and factors, one directional
light plus ambient, no textures or effects);
optional packages that need WebGPU stay unavailable on this path. Picking is the optional `/pick` entry below.

```ts
import {Engine} from 'margoengine/core';
import {webglRenderer} from 'margoengine/webgl';

// WebGPU when available, otherwise WebGL2.
const engine = await Engine.create(canvas, {backend: 'auto', fallback: webglRenderer});
```

Without a `fallback`, `backend: 'auto'` requires WebGPU and `Engine.create` rejects with
"WebGPU unavailable"; `backend: 'webgl2'` always uses the fallback. The renderer lives outside
core, so apps that target WebGPU only do not load its 3,407 B min+gzip
([entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)).

Without React, load it only when WebGPU is missing (needs no core change; WebGPU users download nothing of
this package, because the dynamic import is a separate chunk that never runs for them):

```ts
import {Engine} from 'margoengine/core';

const fallback = navigator.gpu ? undefined : (await import('margoengine/webgl')).webglRenderer;
const engine = await Engine.create(canvas, {fallback});
```

In React, use the Canvas props `loadFallback={() => import('margoengine/webgl')}` and `fallbackContent`; load
`margoengine/webgl/pick` there instead when the scene has pointer handlers
(see the [React README](../react/README.md)).

`fallback: canvas => webglRenderer(canvas, {transparent: true})` gives the WebGL2 canvas `alpha: true`
(premultiplied) and a transparent clear: the WebGL side of `TransparentCanvas` from
`@margoengine/environment`, which only acts on WebGPU (core passes nothing to the fallback).

## Picking

`engine.pick` refuses on this renderer unless the app adds `webglPicking` from `margoengine/webgl/pick`. With it,
`engine.pick(x, y, view?)` answers as it does on WebGPU: CSS pixels, views, layers, nearest surface, and back faces of
single-sided materials do not count. The plugin does nothing on WebGPU or the compatibility layer, where core's pick
already runs, so load it only on the preview:

```ts
import {Engine, box} from 'margoengine/core';
import {webglRenderer} from 'margoengine/webgl';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgl2', fallback: webglRenderer});
const crate = engine.createMesh().setGeometry(box());
engine.start();

if (engine.backend === 'webgl2') engine.use((await import('margoengine/webgl/pick')).webglPicking());

canvas.addEventListener('click', async (event) => {
  const mesh = await engine.pick(event.offsetX, event.offsetY);
  console.log(mesh === crate ? 'crate' : 'nothing');
});
```

Each pick refreshes the scene as a frame does (without changing the canvas), draws mesh ids into a 1x1 target and reads
that one pixel with a blocking `readPixels`. The program and target are made by the first pick. A view that draws into a
texture cannot be picked here, because the preview refuses to draw one. `engine.removePlugin('webgl-pick')` gives the
engine back core's answer. Picking covers the core meshes this renderer draws: a plugin's `onPick` hook is not called
on the preview. `Picking` from `margoengine/selection` attaches after this plugin and answers through it, so
`HoverHighlight` works with `onHover`; a hit holds the mesh only, and `pickMany` costs one such pick a point. `/pick` also
exports `webglRenderer`, so a React Canvas gets working pointer handlers from
`loadFallback={() => import('margoengine/webgl/pick')}`.

## Lost contexts

A browser can take a WebGL context away (a driver reset, too many contexts, a laptop switching GPUs). Without help the
next frame throws `failed`, and `engine.rebootDevice()` refuses. `webglRestore` from `margoengine/webgl/restore` keeps a
long session alive: frames pass without drawing and new geometry waits, then every program and buffer is made again and
each scene's plugins hear `onDeviceRestored`. Like `webglPicking`, it does nothing on WebGPU or the compatibility layer.

```ts
import {Engine, box} from 'margoengine/core';
import {webglRenderer} from 'margoengine/webgl';
import {webglRestore} from 'margoengine/webgl/restore';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgl2', fallback: webglRenderer});
engine.createMesh().setGeometry(box());
engine.use(webglRestore({timeout: 30_000}));
engine.onError = (error) => console.error(error);
engine.start();

// Rebuilds at once on a live context; on a lost one, resolves when the browser gives it back.
await engine.rebootDevice();
```

`timeout` (default 30000) is how many milliseconds to wait for a lost context. Past it `rebootDevice` rejects with code
`timeout`, and a loss nobody called it for reaches `engine.onError` the same way; a restore after that still recovers. Add
the plugin before the context can be lost: the browser only gives a context back to a page that asked at the moment of
the loss. An engine that draws on demand rather than with `engine.start()` should draw again from `onDeviceRestored`.
`engine.removePlugin('webgl-restore')` gives the engine back core's answers.

## Automatic escalation

The preview draws plain core meshes, and other packages refuse it with code `unsupported`. `autoEngine` from
`margoengine/webgl/auto` picks the path a page's own packages can draw on, so a visitor never gets half a scene: WebGPU
when the browser has it, else this preview, else, when a package refuses the preview, the
[compatibility layer](../webgl2-compat/README.md). One option turns that last step on: `loadCompat`, the layer's dynamic
import. Each WebGL2 package is downloaded only if it is used.

```ts
import {box} from 'margoengine/core';
import {Shadows} from 'margoengine/shadows';
import {autoEngine} from 'margoengine/webgl/auto';

const engine = await autoEngine(
  document.querySelector('canvas')!,
  (engine) => {
    engine.createMesh().setGeometry(box());
    engine.use(new Shadows());
  },
  {loadCompat: () => import('margoengine/webgl2-compat')},
);
engine.canvas.addEventListener('click', () => console.log(engine.backend));
engine.start();
```

`setup` builds the scene and runs twice when the page escalates, so it should start from nothing and use the engine it
is given. The layer cannot draw to a canvas that holds the preview's context, so escalating replaces the element in the
page with a copy: use `engine.canvas` afterwards, as above. The third argument takes every `Engine.create` option except
`fallback`, plus `loadCompat` (default none: the refusal rejects). The app passes the import so that no package names the
layer and a page that leaves it out never bundles it. Only refusals during `setup` escalate, and any other error rejects with the engine disposed. A browser whose WebGL2 is
below what the layer needs rejects with the layer's `unsupported` error, which names what is missing.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/webgl
