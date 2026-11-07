# @margoengine/core

Import `margoengine/core` from the `margoengine` package, or `@margoengine/core` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

WebGPU rendering (WebGL2 fallback via the optional `@margoengine/webgl`), a deterministic Rust/Wasm transform kernel, instanced drawing of one directional GGX light on position and normal, reversed float depth, picking and CAD camera controls. Materials are color, roughness, and metalness.

Desktop scenes use 4× MSAA with a canvas DPR cap of 1; phones use single-sample rendering with a DPR cap of 2. For slower desktop GPUs, set `globalThis.margoLow` to a pixel ratio (for example `1` or `1.5`) before creating the engine: scenes then render single-sampled with the DPR capped at that value, which on an Intel Arc 140V laptop cut the island demo's GPU frame from about 20 to 10 ms (particles off) compared with 4× MSAA. The site demos choose this light tier by measuring the GPU rather than guessing from the device. Color and depth targets follow canvas resize. Optional scene captures retain that sampling policy and expose single-sample resolved textures. CSS layout and HTML text retain native density.

`engine.pick(x, y)` updates scene state without forcing a color frame. One readback runs at a time and overlapping calls wait their turn, so a loop of picks costs one readback a point; `pickMany` of `@margoengine/selection` answers many points from one. For cached forward-pass IDs, instance culling in a 3×3 micro frustum and neighbor resolution, attach the optional `Picking` plugin from `@margoengine/selection`. On a canvas without client size (an `OffscreenCanvas` in a worker) pick coordinates are canvas pixels.

Static scenes cost little per frame: the kernel recomputes only entities whose position, rotation, scale, parent, bounds or visibility changed (and their descendants); the engine reuses last frame's instance list unless the mesh set, a geometry or material assignment, a material's values, visibility or the culling result changed, and otherwise patches only the moved matrices; the WebGPU renderer uploads only the changed instance range. On an Intel Arc 140V laptop this made the kernel 2.6-4x cheaper and lets 50,000 CAD parts orbit at 92 FPS instead of 49; an orbiting camera still re-collects every frame, so 90,000 parts stay GPU-bound at 33 FPS (CAD measurements). Contract for `@margoengine/core/extension` users: the per-geometry instance buffers (`engine.geometryBuffers(geometry).instance`) belong to core and are read-only for packages (bind them, never write them; use your own buffer, as `@margoengine/selection`'s micro pick pass does), and `store.matrices` is kernel output (change transforms through the mesh, never by writing world matrices). GPU culling of core meshes (`@margoengine/culling`'s `CulledMeshes`) uses one hook: passes see the frame's batches as `context.batches`, and a package may set `batch.redirect = {instances, args}` for the frame; every core draw of that batch (main pass and replays) then reads the package's compacted instance records and `drawIndexedIndirect` arguments instead of core's buffer and count. Core still uploads into its own instance buffer, which stays the read-only source the package culls from. `engine.start({culling: false})` skips core's CPU frustum test in the built-in loop (as `render({culling: false})` does for one frame) when a package culls on the GPU.

Entity capacity grows on demand: `Engine.create(canvas, {capacity})` sets the initial number of slots (default 1,024) and `createMesh` doubles the transform store when it is full, up to 8,388,608 (2^23). Growing re-creates the kernel at the same Wasm address, re-binds every `store` view and `mesh.matrix`, and recomputes every entity once on the next tick; a growth that cannot allocate throws and leaves the store unchanged. Store views and `mesh.matrix` taken before a `createMesh` may be stale afterwards (detached, or aliasing the new layout): re-read them, never keep them. Memory per slot: 344 B of kernel columns plus 7 B of flags (351 B; 352 MB of Wasm memory at 1,048,576 slots) and 5 B in the engine; each drawn instance adds 96 B on the CPU and 96 B on the GPU.

Package name: `@margoengine/core`, version `1.0.0`. Build from source or install a local tarball until the package is published.

```ts
import { Camera, Engine, box, PbrMaterial } from 'margoengine/core';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, { backend: 'auto' });
const mesh = engine.createMesh()
  .setGeometry(box())
  .setMaterial(new PbrMaterial({ color: '#84d6bd', roughness: 0.3 }));
engine.onFrame((_, delta) => { mesh.rotation.y += delta; });
engine.start();
```

`Engine.create(canvas, options)` options (all optional, all part of the v1.0.0 API):

| Option | Default | Meaning |
| --- | --- | --- |
| `capacity` | `1024` | Initial mesh slots, 1 to 8,388,608; the store doubles when full. |
| `backend` | `'auto'` | `'auto'` tries WebGPU, then `fallback`; `'webgpu'` fails without WebGPU; `'webgl2'` uses `fallback`. |
| `camera` | `Camera` defaults | Initial camera settings (`position`, `target`, `fov`, ...). |
| `fallback` | none | Builds the non-WebGPU renderer, for example `webglRenderer` from `@margoengine/webgl`. |
| `features` | `[]` | Extra WebGPU features to request when the adapter offers them, such as `['timestamp-query']`. |
| `exactSize` | `false` | `[width, height]` or `true`: pixel-exact backbuffer with no pixel-ratio scaling and no MSAA ([Pixel-perfect rendering](#pixel-perfect-rendering)). |

`delta` is in seconds. The built-in loop clamps a long frame to `engine.maxDelta` (default `0.1`; keep it at 1 or less, since `render` rejects a larger delta with a RangeError), and when the page becomes visible again after a background tab its first frame steps `0`, so animation and physics resume where they paused instead of jumping.

Materials are live: `material.set({ color: '#ff8800', roughness: 0.2, metalness: 1, doubleSided: false })` changes the given values in place (omitted ones keep theirs; invalid input throws and changes nothing). Every mesh using the material shows it on the next frame with no new pipeline or bind group. A value change re-collects the frame's instances, so each drawn geometry's whole instance range is uploaded once on that frame (only changed ranges after that); for per-frame recolouring of one part among many thousands, give that part its own material or use `@margoengine/materials`. Core materials are opaque (no `opacity`).

Back faces of single-sided materials (`doubleSided: false`) are culled by the GPU: core draws a geometry batch with a second, back-culled pipeline whose shader has no `discard` (so early depth testing stays on) when every drawn instance of that geometry is single-sided and not mirrored (negative-determinant transform). One double-sided or mirrored instance puts the whole batch on the cull-none pipeline, which drops back faces in the shader as before; pixels are the same either way. Flipping `doubleSided` with `material.set`, assigning a material, or mirroring a mesh takes effect on the next frame; un-mirroring a moved mesh moves its batch back to the culled pipeline at the next full re-collection. Passes that replace core's shader text (fog, clipping, clustered lights...) or draw with extra bindings keep the cull-none pipeline. Instance records carry `Batch.mask` for packages: nonzero when the batch needs back faces.

`mesh.receiveShadow = false` (default true) keeps a mesh's direct light unshadowed by `@margoengine/shadows` and clustered local shadows while it still casts; the next frame re-collects instances. Core marks it by adding 0.25 to the instance's doubleSided factor (float 22), so every `< 0.5` single-sided test reads it unchanged; the shadow packages patch core's shader for it only while some mesh opts out.

The canvas is opaque. For a transparent canvas over HTML and CSS, attach `TransparentCanvas` from `@margoengine/environment`; core needs no option.

## Camera for one render

`engine.render({camera: anotherCamera, delta: 0})` draws the implicit scene through that camera. The camera supplied to `Engine.create` remains `engine.camera`; its fit animation does not advance during the alternate render. Before returning, core restores the primary camera's frustum, visible instances, batches and statistics, including when a pass throws. Plugins receive one pre-update callback per call. A later ordinary render or pick uses the primary camera.

Alternate renders must be sequential, outside a running frame pass. For several cameras in one frame use views (below). Camera-dependent plugins that read `engine.camera` in their update callbacks still follow the primary camera. Use `delta: 0` for additional views so simulation is not advanced again. Projection aspect follows the canvas; an offscreen capture with another aspect needs an explicit `Camera.project` override.

## Views and scenes

Several cameras in one frame: split screen, a four-view layout, a minimap. Each view is a camera and a rectangle,
fractions of the canvas by default (`pixels: true` for drawing-buffer pixels); the camera aspect follows the rectangle.

```ts
const top = new Camera({ position: [0, 20, 0], target: [0, 0, 0] });
top.up = [0, 0, -1];                               // straight down needs another screen-up
const front = new Camera({ position: [0, 0, 20] });
const side = new Camera({ position: [20, 0, 0] });
engine.views = [
  { camera: top, viewport: [0, 0, 0.5, 0.5], clear: { color: '#20242a' } },
  { camera: front, viewport: [0.5, 0, 0.5, 0.5] },
  { camera: side, viewport: [0, 0.5, 0.5, 0.5] },
  { camera: engine.camera, viewport: [0.5, 0.5, 0.5, 0.5] },
];                                                 // the frame loop draws these instead of the full-canvas view
engine.render({ views: engine.views, delta: 0 });  // or draw them yourself
const hit = await engine.pick(400, 300);           // CSS pixel; picks through the view under it
```

- Views draw in order; the first clears colour, later ones keep it (`clear: {color, depth}` per view). Plugins update
  once per scene and each camera advances once per frame. Partial rectangles clear with a draw inside the rectangle.
- `PassContext.view` (`id`, `camera`, `viewport`, `scissor`, `index`, `count`, `clear`, `layers`) tells passes which
  view they draw; `draw()` uses its rectangles by default and effects key per-view history on `id`.
- `target: {color, depth?}` draws a view into textures (sized by the texture) instead of the canvas. `color` is
  1-sample; `depth`, if given, has the scene's depth format and sample count (core draws into it; another format throws).
- `layers` draws only the meshes whose render layers (`@margoengine/cameras/layers`) share a bit; default the camera's.
- Scenes: `engine.createScene()` makes a scene with its own meshes (`scene.createMesh()`), lighting, `background` and
  plugins (`scene.use(plugin)`); a view draws it with `scene`. `engine.scene` is the default scene; while a scene is
  drawn or set up, `engine.lighting`, `plugins`, `stats` and `createMesh` are that scene's. `scene.dispose()` removes it.
- Which packages are view-aware: [multi-view-roadmap.md](../../docs/multi-view-roadmap.md).

## Pixel-perfect rendering

By default the backbuffer follows the canvas's CSS size times the device pixel ratio (at most 2, and at most 4096 per
side) and desktop scenes use 4x MSAA. Pixel art and pixel-perfect 2D need the opposite, so `exactSize` turns both off:

```ts
import { Engine } from '@margoengine/core';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, { exactSize: [320, 180] }); // or `true`: keep canvas.width / height
canvas.style.width = `${320 * 4}px`; // integer zoom
canvas.style.height = `${180 * 4}px`;
canvas.style.imageRendering = 'pixelated'; // nearest-neighbour scaling, no blur
```

- The backbuffer is exactly the requested size, with no pixel-ratio scaling; change `canvas.width` and `canvas.height`
  to resize it.
- Scenes are single-sampled (no MSAA). Packages that build their own pipelines read `sceneSamples(engine)`, so they
  match.
- `engine.pick(x, y)` still takes CSS pixels and maps them to backbuffer pixels.
- The WebGL2 fallback keeps its own context antialiasing; pass `exactSize` to WebGPU engines.

## Startup that never finishes

`Engine.create` waits for the browser at four steps: `requestAdapter`, `requestDevice` and two pipeline compiles. Some
drivers never answer one of them: on an Intel Arc 140V, with 3 or 4 WebGPU pages alive at once in one browser process,
each new page got slower to get a device and the 4th never did, with no error. So each step has a time limit:

```ts
import { Engine } from '@margoengine/core';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, {
  signal: AbortSignal.timeout(60_000), // cancel creation yourself (here after 60 s); rejects with the signal's reason
  startupWarning: 8000, // one console.warn naming the step still pending after 8 s (the default)
  startupTimeout: 30_000, // then reject with MargoError code 'timeout' naming the step (the default)
}).catch((error) => {
  if (error.code === 'timeout') console.error('The GPU did not answer; close other 3D tabs and reload');
  throw error;
});
engine.start();
```

- With `backend: 'auto'` (the default) and a `fallback` (`webglRenderer` from `@margoengine/webgl`), a `timeout`
  falls back to WebGL2 like any other WebGPU failure; `engine.fallbackReason` says why. An abort never falls back.
- A device that arrives after the limit is destroyed, not leaked; the warning is printed at most once per step.
- The cause is the driver, not the page. A page that shows many engines (a gallery) should start them one at a time,
  each after the previous has drawn, and dispose engines that leave the screen.

## Choosing the GPU

On a laptop with an integrated and a discrete GPU, `powerPreference` picks one: `'low-power'` saves battery,
`'high-performance'` asks for the discrete GPU. It is asked again when the device is restored.

```ts
import { Engine } from '@margoengine/core';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, { powerPreference: 'low-power' });
```

- Default: unset. Core then asks for `'high-performance'`, except on Windows, where it asks for nothing.
- Chrome and Edge on Windows ignore a set value and log a console warning; choose the GPU per browser in Windows
  Settings > System > Display > Graphics there.

## Compiling pipelines early

`engine.renderTarget` names what a render pipeline must match to draw in the canvas pass: the colour format, the depth
format and the sample count. An optional package reads it to compile its pipelines before the first frame, as
`PBRModel.compile()` in `@margoengine/gltf-pro` does. It is `null` off WebGPU, and it follows a restored device.

```ts
import { Engine } from '@margoengine/core';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const target = engine.renderTarget; // { format, depthFormat, samples }, or null on the WebGL2 preview
```

## Ambient RGB

Extension users can tint core's diffuse ambient independently of the directional light:

```ts
import { Engine } from 'margoengine/core';
import { engineRuntime } from 'margoengine/core/extension';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas);
const lighting = engineRuntime(engine).lighting;
lighting.radiance[3] = 0.2; // existing ambient intensity
lighting.ambient.set([0.4, 0.6, 1]); // linear RGB multiplier; white by default
```

The three components must be finite and nonnegative; values above one are allowed. Core meshes and packages drawing core's shader use this color. Independent material shaders, including glTF-pro's hemisphere model, retain their existing lighting APIs. Environment IBL replaces core ambient; Sky's explicit ambient color supplies its own absolute floor. This is a flat RGB hook, not a HemisphereLight.

Core's display curve is Khronos PBR Neutral, then the exact sRGB encoding: base colours under neutral light come out as authored, and highlights roll off to white. glTF-pro, terrain, sky, water, scatter, foliage and the post effects end with the same curve, so one colour looks the same whichever package draws it; `@margoengine/tonemap` defaults to it and adds AgX, ACES and LUT grading.

For packages supplying `Lighting` directly to a renderer, omitted `ambient` means white. The canonical WGSL `Frame` is now 128 bytes: its original 112-byte prefix is unchanged and an `ambient:vec4f` follows it (RGB at floats 28-30). Packages allocating that uniform must supply the full layout; append their own fields after it.

## Viewport and scissor per core draw

Inside a frame pass, `context.draw` accepts independent rectangles:

```ts
import type { FramePass } from 'margoengine/core/extension';

const leftView: FramePass = {
  name: 'left-view',
  order: 1,
  execute: (context) =>
    context.draw({
      viewport: [0, 0, 160, 240],
      scissor: [0, 0, 160, 240],
      clear: false,
    }),
};
```

Both tuples use top-left drawing-buffer pixels, with nonnegative integer origins and positive integer sizes. Invalid or out-of-bounds rectangles throw before drawing. Custom target owners must set the context dimensions to match their active attachments. Omitted rectangles use the full target and do not retain the preceding draw's state.

A pass that opens its own render passes on `color` and `depth` can declare `joins`, and the frame then needs no render pass of core's. Set the attachments to `load` and `store` each frame and call `attach` just before each `beginRenderPass`; `true` means no render pass on them follows in this pass. The first call takes core's clear when core has nothing to draw, and in the graph's last pass the attachments resolve the frame. A pass that draws nothing need do nothing: core clears and resolves as usual.

```ts
import type { FramePass } from 'margoengine/core/extension';

const color: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' };
const depth: GPURenderPassDepthStencilAttachment = { view: undefined!, depthLoadOp: 'load', depthStoreOp: 'store' };
const ownPass: FramePass = {
  name: 'own-pass',
  order: 1,
  joins: true,
  execute(context) {
    if (context.backend !== 'webgpu') return;
    color.view = context.color;
    depth.view = context.depth;
    color.resolveTarget = undefined;
    color.loadOp = depth.depthLoadOp = 'load';
    color.storeOp = depth.depthStoreOp = 'store';
    const stencil = context.descriptor.depthStencil!.format.includes('stencil');
    depth.stencilLoadOp = stencil ? 'load' : undefined;
    depth.stencilStoreOp = stencil ? 'store' : undefined;
    context.attach?.(color, depth, true);
    context.encoder.beginRenderPass({ colorAttachments: [color], depthStencilAttachment: depth }).end();
  },
};
```

Clearing still clears the whole attachment, regardless of either rectangle. Use `clear:false` for later subviews that must retain color and depth. Rectangles do not change camera aspect or culling, the coordinates used by `engine.pick`, or optional packages that open their own native render passes. WebGL's core-mesh preview supports the same rectangles and clear/load behavior.

Call `engine.dispose()` when the canvas is removed, or let `using engine = await Engine.create(canvas)` (and `using mesh = engine.createMesh()`, `using scene = engine.createScene()`) dispose at the end of the block: `[Symbol.dispose]` is `dispose()` where the runtime has the symbol. Disposing twice is harmless.

Errors are a `MargoError` with a `code` (or a `TypeError` / `RangeError`) whose short message links to its entry on [margoengine.com/errors](https://margoengine.com/errors).

Core geometry holds positions and normals only. For a second UV set (lightmaps, ambient occlusion), vertex colours or tangents on CPU geometry, use `createMesh(engine, {positions, normals, uvs, uvs1, ...}, material)` from `@margoengine/materials`; glTF files keep `TEXCOORD_1` through `@margoengine/gltf-pro`. For points (point clouds and sprites), use `PointCloud` and `PointsPlugin` from `@margoengine/points`.

Wasm is embedded; no Rust toolchain or Wasm bundler plugin is required. The public API is exported from `@margoengine/core`; raw GPU/Wasm access uses the explicit `@margoengine/core/extension` entry. Both entries include TypeScript declarations.

TypeScript 7+ with DOM types, Wasm SIMD and DecompressionStream gzip support are required. WebGPU requires HTTPS or localhost. See the API and lifecycle guide and committed measurements and how to reproduce them.

Apache-2.0 licensed.
