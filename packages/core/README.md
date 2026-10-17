# @margoengine/core

WebGPU rendering (WebGL2 fallback via the optional `@margoengine/webgl`), a deterministic Rust/Wasm transform kernel, instanced PBR, reversed float depth, picking and CAD camera controls.

Desktop scenes use 4× MSAA with a canvas DPR cap of 1; phones use single-sample rendering with a DPR cap of 2. For slower desktop GPUs, set `globalThis.margoLow` to a pixel ratio (for example `1` or `1.5`) before creating the engine: scenes then render single-sampled with the DPR capped at that value, which on an Intel Arc 140V laptop cut the island demo's GPU frame from about 20 to 10 ms (particles off) compared with 4× MSAA. The site demos choose this light tier by measuring the GPU rather than guessing from the device. Color and depth targets follow canvas resize. Optional scene captures retain that sampling policy and expose single-sample resolved textures. CSS layout and HTML text retain native density.

`engine.pick(x, y)` updates scene state without forcing a color frame. For cached forward-pass IDs, instance culling in a 3×3 micro frustum and neighbor resolution, attach the optional `Picking` plugin from `@margoengine/selection`. On a canvas without client size (an `OffscreenCanvas` in a worker) pick coordinates are canvas pixels.

Static scenes cost little per frame: the kernel recomputes only entities whose position, rotation, scale, parent, bounds or visibility changed (and their descendants); the engine reuses last frame's instance list unless the mesh set, a geometry or material assignment, a material's values, visibility or the culling result changed, and otherwise patches only the moved matrices; the WebGPU renderer uploads only the changed instance range. On an Intel Arc 140V laptop this made the kernel 2.6-4x cheaper and lets 50,000 CAD parts orbit at 92 FPS instead of 49; an orbiting camera still re-collects every frame, so 90,000 parts stay GPU-bound at 33 FPS ([CAD measurements](https://github.com/scottcampbelldata/margoengine/blob/main/docs/cad-performance.md)). Contract for `@margoengine/core/extension` users: the per-geometry instance buffers (`engine.geometryBuffers(geometry).instance`) belong to core and are read-only for packages (bind them, never write them; use your own buffer, as `@margoengine/selection`'s micro pick pass does), and `store.matrices` is kernel output (change transforms through the mesh, never by writing world matrices). GPU culling of core meshes (`@margoengine/culling`'s `CulledMeshes`) uses one hook: passes see the frame's batches as `context.batches`, and a package may set `batch.redirect = {instances, args}` for the frame; every core draw of that batch (main pass and replays) then reads the package's compacted instance records and `drawIndexedIndirect` arguments instead of core's buffer and count. Core still uploads into its own instance buffer, which stays the read-only source the package culls from. `engine.start({culling: false})` skips core's CPU frustum test in the built-in loop (as `render({culling: false})` does for one frame) when a package culls on the GPU.

Entity capacity grows on demand: `Engine.create(canvas, {capacity})` sets the initial number of slots (default 1,024) and `createMesh` doubles the transform store when it is full, up to 8,388,608 (2^23). Growing re-creates the kernel at the same Wasm address, re-binds every `store` view and `mesh.matrix`, and recomputes every entity once on the next tick; a growth that cannot allocate throws and leaves the store unchanged. Store views and `mesh.matrix` taken before a `createMesh` may be stale afterwards (detached, or aliasing the new layout): re-read them, never keep them. Memory per slot: 344 B of kernel columns plus 7 B of flags (351 B; 352 MB of Wasm memory at 1,048,576 slots) and 5 B in the engine; each drawn instance adds 96 B on the CPU and 96 B on the GPU.

Package name: `@margoengine/core`, version `0.1.0`. Build from source or install a local tarball until the renamed package is published.

```sh
npm install @margoengine/core@1.0.0
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

Materials are live: `material.set({ color: '#ff8800', roughness: 0.2, metalness: 1, doubleSided: false })` changes the given values in place (omitted ones keep theirs; invalid input throws and changes nothing). Every mesh using the material shows it on the next frame with no new pipeline or bind group. A value change re-collects the frame's instances, so each drawn geometry's whole instance range is uploaded once on that frame (only changed ranges after that); for per-frame recolouring of one part among many thousands, give that part its own material or use `@margoengine/materials`. Core materials are opaque (no `opacity`).

Back faces of single-sided materials (`doubleSided: false`) are culled by the GPU: core draws a geometry batch with a second, back-culled pipeline whose shader has no `discard` (so early depth testing stays on) when every drawn instance of that geometry is single-sided and not mirrored (negative-determinant transform). One double-sided or mirrored instance puts the whole batch on the cull-none pipeline, which drops back faces in the shader as before; pixels are the same either way. Flipping `doubleSided` with `material.set`, assigning a material, or mirroring a mesh takes effect on the next frame; un-mirroring a moved mesh moves its batch back to the culled pipeline at the next full re-collection. Passes that replace core's shader text (fog, clipping, clustered lights...) or draw with extra bindings keep the cull-none pipeline. Instance records carry `Batch.mask` for packages: nonzero when the batch needs back faces.

The canvas is opaque. For a transparent canvas over HTML and CSS (three.js `alpha: true`), attach `TransparentCanvas` from `@margoengine/environment`; core needs no option.

## Camera for one render

`engine.render({camera: anotherCamera, delta: 0})` draws the implicit scene through that camera. The camera supplied to `Engine.create` remains `engine.camera`; its fit animation does not advance during the alternate render. Before returning, core restores the primary camera's frustum, visible instances, batches and statistics, including when a pass throws. Plugins receive one pre-update callback per call. A later ordinary render or pick uses the primary camera.

Alternate renders must be sequential, outside a running frame pass. This hook does not create a second scene, separate temporal histories, CubeCamera or a mirror. Camera-dependent plugins that read `engine.camera` in their update callbacks still follow the primary camera. Use `delta: 0` for additional views so simulation is not advanced again. Projection aspect follows the canvas; an offscreen capture with another aspect needs an explicit `Camera.project` override.

## Ambient RGB

Extension users can tint core's diffuse ambient independently of the directional light:

```ts
import { engineRuntime } from '@margoengine/core/extension';

const lighting = engineRuntime(engine).lighting;
lighting.radiance[3] = 0.2; // existing ambient intensity
lighting.ambient.set([0.4, 0.6, 1]); // linear RGB multiplier; white by default
```

The three components must be finite and nonnegative; values above one are allowed. Core meshes and packages drawing core's shader use this color. Independent material shaders, including glTF-pro's hemisphere model, retain their existing lighting APIs. Environment IBL replaces core ambient; Sky's explicit ambient color supplies its own absolute floor. This is a flat RGB hook, not a HemisphereLight.

For packages supplying `Lighting` directly to a renderer, omitted `ambient` means white. The canonical WGSL `Frame` is now 128 bytes: its original 112-byte prefix is unchanged and an `ambient:vec4f` follows it (RGB at floats 28–30). Packages allocating that uniform must supply the full layout; append their own fields after it.

## Viewport and scissor per core draw

Inside a frame pass, `context.draw` accepts independent rectangles:

```ts
context.draw({
  viewport: [0, 0, 160, 240],
  scissor: [0, 0, 160, 240],
  clear: false,
});
```

Both tuples use top-left drawing-buffer pixels, with nonnegative integer origins and positive integer sizes. Invalid or out-of-bounds rectangles throw before drawing. Custom target owners must set the context dimensions to match their active attachments. Omitted rectangles use the full target and do not retain the preceding draw's state.

Clearing still clears the whole attachment, regardless of either rectangle. Use `clear:false` for later subviews that must retain color and depth. Rectangles do not change camera aspect or culling, the coordinates used by `engine.pick`, or optional packages that open their own native render passes. WebGL's core-mesh preview supports the same rectangles and clear/load behavior.

Call `engine.dispose()` when the canvas is removed. Wasm is embedded; no Rust toolchain or Wasm bundler plugin is required. The public API is exported from `@margoengine/core`; raw GPU/Wasm access uses the explicit `@margoengine/core/extension` entry. Both entries include TypeScript declarations.

TypeScript 7+ with DOM types, Wasm SIMD and DecompressionStream gzip support are required. WebGPU requires HTTPS or localhost. See the [API and lifecycle guide](https://github.com/scottcampbelldata/margoengine/blob/main/MODERN-ENGINE.md) and [committed measurements and how to reproduce them](https://github.com/scottcampbelldata/margoengine/blob/main/docs/whitepaper/claims.md).

MIT licensed.
