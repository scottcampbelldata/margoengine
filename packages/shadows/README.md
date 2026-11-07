# @margoengine/shadows

Import `margoengine/shadows` from the `margoengine` package, or `@margoengine/shadows` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Cascade descriptors, attachments and matrix views are retained between frames.
Custom `drawShadow` callbacks receive a borrowed context reused for that cascade;
consume it synchronously rather than retaining it after the pass.

Optional WebGPU directional shadows. Four practical/logarithmic frustum splits (fewer with `cascades`) render to a `depth32float` 2D texture array. Stable spherical extents and world-space texel snapping limit edge swimming. PCSS searches 16 blockers and filters 32 comparison samples using directional-light angular size and blocker/receiver separation. The blocker search reaches from the receiver to the nearest caster in its cascade (a compute pass reduces each changed map to its nearest depth), so its samples stay where blockers can be, however far `casterMargin` puts the map's near plane; its first sample is the receiver's own texel, and a surface behind the receiver never counts as a blocker. The reduction reads the whole map once per frame in which a caster moved (0.11 ms GPU at 2048 with four cascades on an RTX A6000; nothing while the map is unchanged), and the tighter search makes the receiving passes cheaper (0.12 to 0.09 ms in the animation guide's scene). The samples follow a golden-angle spiral that each pixel turns by interleaved gradient noise of its screen position, so penumbrae show fine noise instead of steps; there is no time term, so a still view renders the same pixels every frame. The last tenth of each cascade's depth range dithers into the next cascade with a second noise pattern, so a cascade switch shows no hard seam and still costs one map lookup per tap.

```ts
import {EngineKernel,box} from 'margoengine/core';
import {Shadows} from 'margoengine/shadows';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const terrain = engine.createMesh().setGeometry(box()).setScale([100,1,100]);
const character = engine.createMesh().setGeometry(box()).setPosition([0,2,0]);
const shadows = Shadows.attach(engine, {resolution:2048, distance:500, lambda:0.5, lightSize:0.02});
shadows.add(terrain, {static:true});
const removeCharacter = shadows.add(character);
engine.start();
// removeCharacter() when unloading; engine.dispose() releases attached plugins.
```

`filter` picks the edge: `'soft'` (default) is the PCSS above; `'pcf'` takes four hardware comparison taps half a texel apart (each is the sampler's own 2x2 bilinear comparison, together a smooth edge about three texels wide) with no blocker search and no spiral, for phones and light tiers; `'hard'` takes one tap. `cascades` (1-4, default 4) renders fewer layers: fewer depth passes per frame, coarser texels over the same `distance`; `bounds` always uses one map. `@margoengine/quality` sets `filter:'pcf'` on its light and phone tiers and `cascades:2` on phones when the app leaves them unset.

The defaults cost more than one fixed-filter map: SciFiHelmet takes 0.33 ms of GPU time a frame with them and 0.074 ms with `Shadows.attach(engine, {filter:'pcf', cascades:1})` (RTX A6000, diagnostic). [docs/limits.md](../../docs/limits.md#rendering) has the split.

Map size and an explicit shadow camera, as Crocotile's per-light Shadow Map Width/Height and shadow camera
Near/Far/Left/Right/Top/Bottom:

```ts
const sun = Shadows.attach(engine, {
  resolution: [2048, 1024], // width, height: powers of two; one number keeps a square map
  frustum: { position: [0, 20, 10], left: -15, right: 15, bottom: -8, top: 8, near: 0.5, far: 60 },
});
sun.options.frustum!.right = 20; // live: next frame
sun.options.resolution = 1024;   // live: the maps are reallocated next frame (only when the size changes)
sun.options.cascades = 2;        // live, the same way: fewer depth passes from the next frame
```

`frustum` is an orthographic camera at `position` looking along the engine's light direction (world +Y up, +Z when the
light is within about 8 degrees of vertical): `left`/`right` and `bottom`/`top` are its view extents around `position`,
`near`/`far` distances in front of it. It replaces the cascades and `bounds` with one camera-independent map spread
exactly over that box; casters and receivers outside it get no shadow. Give `bounds` or `frustum`, not both; switching
between them, or back to cascades, is live too. With a non-square map or a `frustum`, light-space
x and y map to texels at different scales, so receivers take a per-axis variant of the filter (receiver-plane slope and
PCSS radii per axis); a square map without a frustum keeps the shaders above byte for byte. Cascades and `bounds` keep
covering a square region, so a non-square map there just gives the two axes different texel sizes.

`lambda:0` gives uniform splits; `lambda:1` gives logarithmic splits. `lightSize` is the tangent of the sun's angular radius; `bias` is normalized depth and `normalBias` is world distance. `casterMargin` extends the depth bounds to include casters outside the camera slice. Shadows follow the engine's directional light.

Core meshes receive shadows automatically. `shadows.add(pbrModel)` or `shadows.add(loadedMesh)` adds the owning model's lighting hook and reads current stride-80 buffers after animation compute. Registering both draws each primitive once; a dynamic registration takes precedence over a cached registration. Removing one registration preserves the remaining lighting hook. Alpha-masked PBR casters honor their base map, vertex alpha, UV set, texture transform and cutoff, and a materials mesh's `map` and `alphaMap` under its `alphaTest`, the threshold its colour pass uses; blended casters are omitted. Opaque casters keep their plain draw. A `triplanar` material's map follows world space, which a caster's UVs cannot, so it casts its whole surface. A map still loading casts as white; a caster added with `static: true` needs `invalidate()` once it has loaded, others redraw by themselves. A caster with an `alphaMap` redraws every frame.

```ts
import { Engine, box } from 'margoengine/core';
import { PbrMaterial, Texture, createMesh } from 'margoengine/materials';
import { planeGeometry } from 'margoengine/geometry';
import { Shadows } from 'margoengine/shadows';

const canvas = document.querySelector('canvas')!;
const leafImage = await createImageBitmap(await (await fetch('/leafImage.png')).blob());
const engine = await Engine.create(canvas);
engine.createMesh().setGeometry(box(10, 0.1, 10));
const leaf = createMesh(engine, planeGeometry(2, 2), new PbrMaterial({ map: new Texture(leafImage), alphaTest: 0.5 }));
leaf.root.setPosition([0, 2, 0]);
Shadows.attach(engine).add(leaf); // the shadow has the leaf's outline, not the quad's
```

`npm run test:gpu:outside --workspace packages/shadows` holds this against Blender Cycles, a path tracer that shares no code with Margo: the real DiffuseTransmissionPlant and AlphaBlendModeTest models, the ground's light with the model over the ground's light without it. `test/outside/reference.py` makes the references and `test/outside/cases.mjs` holds the bounds; the check needs no Blender.

 A caster primitive with `displacement` (materials meshes with a `displacementMap`) is drawn displaced along its normals, as its beauty pass is, and redraws every frame so live scale and bias edits show. No duplicate core geometry is created. `shadows.add(clipmapTerrain)` uses its GPU height sampling for depth and its lighting hook for reception. Custom sources can implement `drawShadow(ShadowContext)`.

A custom source may also implement `prepareShadow(ShadowPrepareContext)`. Shadows calls it once per frame, before any
cascade's depth pass opens and only on frames the source draws, with every cascade's light matrix (`matrices`, 16
floats per cascade) and the cascade count. No pass is open on `context.encoder` then, so the source can record compute
work the cascades share. GPU `Scatter` uses it to cull its instances per cascade: each cascade then draws only the
instances whose bounds reach its light box, so the shadow map comes out the same with fewer draws.

```ts
import { EngineKernel, box } from 'margoengine/core';
import { Shadows, type ShadowContext, type ShadowPrepareContext } from 'margoengine/shadows';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, { backend: 'webgpu' });
const shadows = Shadows.attach(engine, { cascades: 2 });
const lights: Float32Array[] = [];
shadows.add(engine.createMesh().setGeometry(box())); // core meshes cast as before
shadows.add({
  // Once per frame, no pass open: record compute work here (scatter culls per cascade).
  prepareShadow({ matrices, cascades }: ShadowPrepareContext) {
    for (let i = 0; i < cascades; i++) lights[i] = matrices.slice(i * 16, i * 16 + 16);
  },
  // Then once per cascade, inside its open depth-only pass.
  drawShadow({ pass, cascade }: ShadowContext) {
    // Draw this cascade's share with lights[cascade] (setPipeline, setBindGroup, draw...).
    pass.insertDebugMarker(`cascade ${cascade}`);
  },
});
engine.start();
```

Per object, as Crocotile's Cast Shadows and Receive Shadows (both default on): `shadows.add(source, {castShadow: false})` lights the object with the shadow map but leaves it out of the map, and `{receiveShadow: false}` draws it into the map but keeps its own lighting unshadowed (no lighting hook is added). Receiving is per object for sources with their own lighting hook (glTF-pro models, materials meshes, clipmap terrain) and for core meshes: `receiveShadow: false` on a core mesh sets core's `mesh.receiveShadow = false` and the remover restores the earlier value. Setting `mesh.receiveShadow` directly works too, for meshes added or not:

```ts
const groundTile = engine.createMesh().setGeometry(box());
const lamp = engine.createMesh().setGeometry(box()).setPosition([2, 1, 0]);
const marker = engine.createMesh().setGeometry(box()).setPosition([-2, 1, 0]);
shadows.add(groundTile);            // casts and receives
shadows.add(lamp, { receiveShadow: false }); // casts, lit as if unshadowed
marker.receiveShadow = false;      // same for any core mesh, next frame
```

While a core mesh opts out, core's shader patch keeps that mesh's direct light where it is shadowed (`select` on its instance factor); with none, the patch is the original text. To change either flag of another source, call the remover and add the object again.

Static geometry renders into a cached depth array. Each frame copies that array and adds dynamic casters, so dynamic geometry cannot overwrite the cache. Cache invalidation occurs when snapped cascade matrices, clipmap origins, source membership, disposal or device change. Call `invalidate()` after moving/hiding a static mesh, editing its geometry/material, or changing a height texture. Moving the camera far enough to move a cascade rerenders static geometry. Eight or more plain core-mesh casters that share one geometry (no alpha mask, no displacement, no section planes) are drawn as one instanced draw per cascade, with their world matrices uploaded once per frame: 1,000 boxes cost 0.9 ms of CPU per frame instead of 7.2 ms (`npm run bench -- render --cases=shadows`, RTX A6000, smoke). Other casters keep one draw each. `stats` reports static/dynamic primitive draws (each caster in each cascade, batched or not) and cache hits; custom sources record their own draws.

At resolution 2048, the two four-layer maps occupy 128 MiB (width × height × layers × 4 bytes each). Choose smaller maps for constrained devices. All resources are released by `dispose()`/`destroy()` and recreated after device restoration. `cascadeSplits()` and `fitCascades()` are exported for custom cameras. The package has no core/stage imports from other feature packages and does not enter their base bundle.

## Coloured shadows

Light through stained glass or a tinted pane takes the pane's colour. Create the `Shadows` with `colored: true` and add the caster with `tint`, linear RGB from 0 to 1:

```ts
import { EngineKernel, box } from 'margoengine/core';
import {Shadows} from 'margoengine/shadows';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, { backend: 'webgpu' });
const floor = engine.createMesh().setGeometry(box(14, 0.1, 14));
const pane = engine.createMesh().setGeometry(box(2, 0.05, 2)).setPosition([-2, 2, 0]);
const shadows = Shadows.attach(engine, {colored: true});
shadows.add(floor);
shadows.add(pane, {tint: [1, 0.1, 0.1]});
engine.start();
```

A gltf-pro model added to such a `Shadows` casts this way by itself: its transmissive and blended primitives (`model.tintPrimitives`) tint with their transmission colour or their base colour weighed by alpha. Any other source can give `tintPrimitives`.

Off by default, and off the receivers' shaders and the frame are unchanged. On, it costs an `rgba8unorm` and a `depth32float` array of the map's size, three more bindings (27 to 29, two textures) on every receiver, and two draws per cascade for each tinting caster, every frame.

Limits: the tint's edge is bilinear, with no penumbra, under every filter. The tint map keeps the nearest tinting caster's depth, so a surface between two panes takes both colours. A `drawShadow` source cannot tint.

## Virtual shadow maps

`margoengine/shadows/virtual` is a second, optional entry for one directional light: `VirtualShadows` keeps the texel density a camera needs at every distance, in small pages of depth, and renders only the pages that are seen and have changed. Importing it costs `Shadows` users nothing; the root entry does not reach it.

```ts
import { EngineKernel, box } from 'margoengine/core';
import {VirtualShadows} from 'margoengine/shadows/virtual';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, { backend: 'webgpu' });
const city = engine.createMesh().setGeometry(box()).setScale([100,1,100]);
const walker = engine.createMesh().setGeometry(box()).setPosition([0,2,0]);
const pages = VirtualShadows.attach(engine, {distance:500, filter:'soft'});
pages.add(city, {castShadow:false}); // receives, casts nothing
pages.add(walker);
engine.start();
// pages.stats.residentPages and pages.stats.pagesRendered show the page work of the last frame.
```

Options and defaults: `poolSize` 4096 (texels a side of the page pool, 32 x 32 pages of 128 texels; a multiple of 256, 2048 for phones), `levels` 8 (each level's pages are twice the size of the one before), `distance` 500, `budgetPages` the pool's page count, `lightSize` 0.02, `bias` 0.002 and `normalBias` 0.02 (both world units, unlike the root's `bias`), `casterMargin` 100 (world units towards the light for off-screen casters), `filter` `'soft'`. `filter` takes the same three edges as `Shadows`; each `'pcf'` and `'soft'` tap reads the page table for its own position, so an edge crossing a page edge reads the neighbouring page. The `'soft'` search and penumbra stop at one page.

A frame draws the camera's view at half size per axis to find the pages it needs, one frame late; a page not yet resident reads the next coarser level, so a new view starts softer and sharpens, with no holes. Once the view settles a still scene renders no pages. A caster that moves redraws the resident pages its bounds reach; a caster whose bounds the effect cannot know (a node that is not a core mesh, a dynamic, instanced or displaced primitive) redraws every resident page every frame. `invalidate()` redraws them all; so does a change of light direction.

Sources with their own `drawShadow` (terrain, scatter, voxels, VAT, culling) cannot cast here: their uniforms are per cascade, and a page needs its own matrix. `add` throws a `TypeError` naming the fix: add them with `{castShadow:false}` to receive, or use `Shadows`, which they cast into.

Memory at the default pool size is 134,218,752 B (two 64 MiB pools and an 8 KiB page table; `memoryBytes` reports it). WebGPU only, directional light only.

## Update scheduling: `cadence`

`cadence` updates far cascades less often. A held cascade keeps its map and its matrix, so a far shadow can lag by those frames.

```ts
import {Engine} from 'margoengine/core';
import {Shadows} from 'margoengine/shadows';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgpu'});
Shadows.attach(engine, {cadence: [1, 1, 2, 4]});
```
