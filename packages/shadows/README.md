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
shadows.dispose(); // Release the current shadow effect before replacing its camera.
const sun = Shadows.attach(engine, {
  resolution: [2048, 1024], // width, height: powers of two; one number keeps a square map
  frustum: { position: [0, 20, 10], left: -15, right: 15, bottom: -8, top: 8, near: 0.5, far: 60 },
});
sun.add(terrain, {static: true});
sun.add(character);
sun.options.frustum!.right = 20; // live: next frame
sun.options.resolution = 1024;   // live: the maps are reallocated next frame (only when the size changes)
sun.options.cascades = 2;        // live, the same way: fewer depth passes from the next frame
```

`frustum` is an orthographic camera at `position` looking along the engine's light direction (world +Y up, +Z when the
light is within about 8 degrees of vertical): `left`/`right` and `bottom`/`top` are its view extents around `position`,
`near`/`far` distances in front of it. It replaces the cascades and `bounds` with one camera-independent map spread
exactly over that box; casters and receivers outside it get no shadow. Give `bounds` or `frustum`, not both; switching
between them, or back to cascades, is live too. A `bounds` or `frustum` whose matrix would not be finite in float32
throws a RangeError from the frame and keeps the last good matrix. With a non-square map or a `frustum`, light-space
x and y map to texels at different scales, so receivers take a per-axis variant of the filter (receiver-plane slope and
PCSS radii per axis); a square map without a frustum keeps the shaders above byte for byte. Cascades and `bounds` keep
covering a square region, so a non-square map there just gives the two axes different texel sizes.

`lambda:0` gives uniform splits; `lambda:1` gives logarithmic splits. `lightSize` is the tangent of the sun's angular radius. Shadows follow the engine's directional light.

Any model scale works with the defaults, from a 1 mm part to a 1 km site: every receiver moves a quarter texel along its normal and compares one texel nearer the light, both measured in its own cascade's texels, so the offsets shrink and grow with the scene (Holbert 2011, "Normal Offset Shadows"; Dou, Yan, Kerzner, Dai and Wyman 2014, "Adaptive Depth Bias for Shadow Maps", JCGT 3(4)). `bias` (normalized depth) and `normalBias` (world distance), default 0, add to those. Without `distance`, the cascades fit the casters' bounds when every caster is a core mesh or a model with no skin, morph targets, instances or displacement (what `loadGLTF` and `createMesh` give), their depth reaches the farthest caster towards the light (Lauritzen, Salvi and Lefohn 2011, "Sample Distribution Shadow Maps"), and the shadowed range is 500 units or 20 times the camera's distance to its target, whichever is farther. `casterMargin`, when set, extends every cascade's depth that far towards the light instead (100 when a caster's bounds are unknown). A skinned, morphed, instanced or custom-drawn caster has no fixed bounds, so its cascades cover the camera's near plane to `distance`: a model of that kind a few centimetres across needs `distance` set near its size (docs/limits.md).

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

## Cloud shadows and light patterns

`@margoengine/shadows/light-function` shapes the sun between the sky and the ground. Give its effects to `Shadows` or `VirtualShadows`; every receiver takes them (core meshes, materials, gltf-pro models, terrain, voxels).

```ts
import {EngineKernel, box} from 'margoengine/core';
import {Shadows} from 'margoengine/shadows';
import {cloudShadows} from 'margoengine/shadows/light-function';
import {Sky} from 'margoengine/sky';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend: 'webgpu'});
const sky = Sky.attach(engine, {clouds: {coverage: 0.45}});
const shade = cloudShadows(sky);
const shadows = Shadows.attach(engine, {effects: [shade]});
shadows.add(engine.createMesh().setGeometry(box(4000, 1, 4000)));
shade.options.strength = 0.8;
engine.start();
```

`cloudShadows(sky, options)` reads the sky's own cloud noise, clock and height where a ground point's ray to the sun meets the cloud shell, so the shadow lies under the cloud that stands in front of the sun and moves with it. World units are metres, as the sky takes them. `strength` (default 1) is how much of the cloud's opacity reaches the ground and `sunSize` (default 0.0093 radians) blurs its edge. A sky with no `clouds` shades nothing. The sun is `engine.lighting.direction`: keep it and the sky's sun together, which the sky's `lighting` option does.

`lightPattern({texture})` is a mask over the sun, what a gobo does on a stage: its colour multiplies the sun.

```ts
import {EngineKernel, box} from 'margoengine/core';
import {Shadows} from 'margoengine/shadows';
import {lightPattern} from 'margoengine/shadows/light-function';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend: 'webgpu'});
const device = engine.gpu!;
const mask = device.createTexture({size: [2, 2], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
device.queue.writeTexture({texture: mask}, new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255]), {bytesPerRow: 8}, [2, 2]);
const pattern = lightPattern({texture: mask.createView(), size: 6, speed: [0.02, 0]});
const shadows = Shadows.attach(engine, {effects: [pattern]});
shadows.add(engine.createMesh().setGeometry(box(30, 1, 30)));
engine.start();
```

| `lightPattern` option | Default | Meaning |
| --- | --- | --- |
| `texture` | required | Any filterable 2D view. Read when receivers bind; the rest are live on `pattern.options`. |
| `size` | 10 | World units of one repeat, on a surface facing the sun. |
| `offset` | [0, 0] | Repeats it has moved, along u and v. |
| `speed` | [0, 0] | Repeats per second it scrolls, along u and v. |
| `strength` | 1 | How much of the mask applies, 0 to 1. |

The mask lies across the light and travels along it. Its right is world up crossed with the sun, and image up is world up as the sun sees it. It adds one sampled texture and one sampler to every receiver, and gltf-pro's richest materials already use all 16 sampled textures of a stage, so such a material names the limit in an error; `cloudShadows` adds one uniform buffer and no texture.

The `effects` array is fixed at construction. With none, the receivers' shaders and the frame are unchanged. An effect is any object with `wgsl(group, binding)` and `call` or `style`, eight bindings from 40, resources named `shadowFx...`: see `ShadowEffect` in the types.

## Variance shadow maps

`@margoengine/shadows/vsm` is a filter you give in place of `'soft'`, `'pcf'` or `'hard'`: wide, smooth edges with no grain, at one bilinear read per lit pixel however wide the edge is.

```ts
import {EngineKernel, box} from 'margoengine/core';
import {Shadows} from 'margoengine/shadows';
import {varianceFilter} from 'margoengine/shadows/vsm';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend: 'webgpu'});
const filter = varianceFilter({blur: 8});
const shadows = Shadows.attach(engine, {filter});
shadows.add(engine.createMesh().setGeometry(box(14, 0.1, 14)));
shadows.add(engine.createMesh().setGeometry(box(1, 1, 1)).setPosition([0, 1, 0]));
filter.options.blur = 16;
engine.start();
```

| Option | Default | Meaning |
| --- | --- | --- |
| `size` | 1024 | Side of the moment map in texels, fixed at creation. Two `rg32float` arrays of this size, one layer per cascade: 64 MiB at 1024 with four cascades. |
| `blur` | 4 | Blur radius in moment map texels, 0 to 32. Live. |
| `bleed` | 0.2 | Share of the Chebyshev bound removed against light bleeding, 0 to under 1: more darkens and narrows the edge. Live. |
| `minVariance` | 0.000001 | Least variance, in squared 0 to 1 map depth, a floor against self-shadowing. Live. |

The blur runs only when the map changes, and its cost follows the map's texels, not the lit pixels. Choose it over PCSS for a wide edge with no grain; choose PCSS where edges must harden towards the caster, because a variance edge has one width everywhere, and where casters overlap at different depths, because some light bleeds between them. `VirtualShadows` keeps its named filters: it has no map of this shape to blur.

## Light through leaves

`@margoengine/shadows/transmission` lets thin surfaces pass light on. Any primitive whose gltf-pro material has `KHR_materials_diffuse_transmission` tints the light behind it instead of blocking it; everything else casts as before.

```ts
import {EngineKernel, box} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Shadows} from 'margoengine/shadows';
import {transmission} from 'margoengine/shadows/transmission';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend: 'webgpu'});
const model = await loadGLTF(engine, 'plant.glb');
const leaves = transmission(model, {size: 0.05});
const shadows = Shadows.attach(engine, {colored: true, effects: [leaves.effect]});
shadows.add(leaves);
shadows.add(engine.createMesh().setGeometry(box(6, 0.02, 6)), {castShadow: false});
engine.start();
```

| Option | Default | Meaning |
| --- | --- | --- |
| `size` | 0.05 | World radius of a leaf or sheet. A thin surface scatters what it passes, so a receiver `d` behind it takes `size^2 / (size^2 + d^2)` of it: leaves touching other leaves pass light on, and the ground far below gets little, as it does in a path tracer. Live. |
| `scale` | 1 | Multiplies the light through, to stand for a transmission texture: Margo reads the material's factor and colour factor, not their textures. Live. |

The side of a leaf away from the sun also keeps its glow under any `Shadows` or `VirtualShadows`, with or without this entry: gltf-pro asks for the shadow lookup on the side facing the light.

`leaves.effect` spreads the light behind every tint caster of those shadows, so coloured glass in the same `Shadows` fades with distance too. It reads the tint depth directly, which a device at the compatibility level cannot do.

## Far shadows

`@margoengine/shadows/distance` shades the ground past the end of the cascades or virtual pages from a height field, so a mountain still throws its shadow across a valley far beyond `distance`. There is no depth pass: the sun's horizon is found for every cell of the field by one GPU march when the sun moves, and a lit pixel past the reach reads one bilinear pair from a storage buffer.

```ts
import {EngineKernel, box} from 'margoengine/core';
import {Shadows} from 'margoengine/shadows';
import {distanceShadows} from 'margoengine/shadows/distance';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend: 'webgpu'});
const columns = 256, rows = 256, heights = new Float32Array(columns * rows);
for (let i = 0; i < heights.length; i++) heights[i] = 120 * Math.max(0, Math.sin((i % columns) / 40));
const far = distanceShadows({heights, columns, rows, origin: [-2000, -2000], size: [4000, 4000]});
const shadows = Shadows.attach(engine, {distance: 300, effects: [far]});
shadows.add(engine.createMesh().setGeometry(box(4000, 1, 4000)), {castShadow: false});
engine.start();
```

| Option | Default | Meaning |
| --- | --- | --- |
| `heights` | required | `columns` x `rows` heights, row by row from the minimum corner. Edit it and call `far.invalidate()` to march it again. |
| `columns`, `rows` | required | Cells along X and Z, 2 or more. |
| `size` | required | World XZ extent of the field, each above 0. |
| `origin` | [0, 0] | World XZ of the minimum corner. |
| `heightScale` | 1 | World Y per height unit. |
| `heightOffset` | 0 | World Y added to every height. |
| `fade` | 0.1 | Share of the reach, above 0 to 1, over which far shadows fade in before it ends. Live. |
| `strength` | 1 | How much of the far shadow applies, 0 to 1. Live. |
| `sunSize` | 0.0093 | The sun's angular diameter in radians. A point keeps the share of the disc above its horizon, so the edge widens with the ridge's distance. Live. |
| `bias` | 0 | World units a receiver lifts over the field, to cover the field's coarseness. Live. |
| `sunStep` | 0.25 | Degrees the sun must move before the field is marched again, 0 or more. Live. |

It works with `Shadows` and `VirtualShadows`, on every receiver. Only what is in the field casts here: a building past the reach casts nothing unless its height is in `heights`. Outside the field nothing is shaded. Y is up.

## Shadow intensity and colour

`@margoengine/shadows/style` sets how dark a light's shadow is and tints it, for stylised and art directed scenes. It takes the light's whole shadow: the map's, tinted casters' and the other effects' together. Lit ground keeps its light exactly.

```ts
import {EngineKernel, box} from 'margoengine/core';
import {Shadows} from 'margoengine/shadows';
import {shadowStyle} from 'margoengine/shadows/style';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend: 'webgpu'});
const style = shadowStyle({intensity: 0.7, color: [0.1, 0.1, 0.4]});
const shadows = Shadows.attach(engine, {effects: [style]});
shadows.add(engine.createMesh().setGeometry(box(1, 1, 1)).setPosition([0, 1, 0]));
shadows.add(engine.createMesh().setGeometry(box(20, 0.1, 20)), {castShadow: false});
engine.start();
style.options.intensity = 0.4;
```

| Option | Default | Meaning |
| --- | --- | --- |
| `intensity` | 1 | How much of the light a full shadow takes away, 0 to 1: 0 is no shadow, 1 takes all of it. Live. |
| `color` | [0, 0, 0] | The colour a full shadow takes the light towards, linear RGB, each 0 to 1. Live. |

A point keeps `mix(floor, 1, visibility)` of the light per channel, where `floor` is `1 - intensity + intensity * color`. It works with `Shadows` and `VirtualShadows`, one per shadows object, and each shadows object is one light.

## Ray traced shadows

`@margoengine/shadows/rt` replaces the map filter with rays against a BVH of the scene: each lit pixel asks the tree whether the sun is in sight. Edges are exact, with no texels and no bias to tune against a map, and a sun of some size gives a true penumbra.

```ts
import {EngineKernel, box} from 'margoengine/core';
import {MeshBVH, worldTriangles} from 'margoengine/bvh';
import {Shadows} from 'margoengine/shadows';
import {rayTracedFilter} from 'margoengine/shadows/rt';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend: 'webgpu'});
const caster = engine.createMesh().setGeometry(box(1, 1, 1)).setPosition([0, 1, 0]);
const ground = engine.createMesh().setGeometry(box(20, 0.1, 20));
const {vertices, indices} = worldTriangles(engine, [caster]);
const bvh = MeshBVH.build({positions: vertices, indices});
const shadows = Shadows.attach(engine, {filter: rayTracedFilter(engine, bvh, {lightSize: 0.02, rays: 32})});
shadows.add(ground, {castShadow: false});
engine.start();
```

| Option | Default | Meaning |
| --- | --- | --- |
| `rays` | 16 | Rays per lit pixel, 1 to 256. One is enough for a sun of no size. Live. |
| `lightSize` | 0 | Tangent of the sun's angular radius, as `lightSize` of `Shadows`. 0 is an exact hard edge. Live. |
| `bias` | 0.001 | World units a ray starts off its surface, along the normal. Live. |
| `far` | 1e6 | World units a ray goes towards the sun. Live. |
| `fallback` | `'soft'` | The map filter answered where a fragment shader cannot read storage buffers. Then add the casters to the shadows too. |

WebGPU has no ray queries yet, so no hardware path is used: the rays walk the tree in the fragment shader, on any GPU, and cost follows rays times lit pixels. When browsers expose ray queries this entry is where they go.

Only the tree casts, in the pose it was built. After moving what it holds, call `bvh.refit()` and then `filter.refit()`, for the same triangles. The ordinary tree treats triangles as opaque; use `shadows/rt-alpha` below for MASK coverage. Shadows end where the map's reach ends. `Shadows` only: `VirtualShadows` keeps its named filters.

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

Options and defaults: `poolSize` 4096 (texels a side of the page pool, 32 x 32 pages of 128 texels; a multiple of 256, 2048 for phones), `levels` 8 (each level's pages are twice the size of the one before), `distance` (unset: 500 while the camera is 1 to 25 units from its target, halved per octave closer and doubled per octave farther, so it is at least 20 times that distance), `budgetPages` the pool's page count, `lightSize` 0.02, `bias` 0 and `normalBias` 0 (both world units, unlike the root's `bias`, added to the receiver's own offsets), `casterMargin` (unset: 100, scaled with the default `distance`; world units towards the light for off-screen casters), `filter` `'soft'`. Any model scale works with the defaults, from a 1 mm part to a 1 km site: every receiver moves a quarter texel of the page it reads along its normal (Holbert 2011, as `Shadows` does with its cascades) and compares 2^-20 of the depth range nearer the light, with the receiver-plane slope term reading the same texel (Isidoro 2006), and the default reach and pages follow the camera's distance to its target in powers of two, so pages keep their addresses while the camera moves within an octave and all redraw once when it crosses one. A first-person camera keeps its target distance, so its reach stays 500 unless that distance is under 1. `filter` takes the same three edges as `Shadows`; each `'pcf'` and `'soft'` tap reads the page table for its own position, so an edge crossing a page edge reads the neighbouring page. The `'soft'` search and penumbra stop at one page.

A frame draws the camera's view at half size per axis to find the pages it needs, one frame late; a page not yet resident reads the next coarser level, so a new view starts softer and sharpens, with no holes. Once the view settles a still scene renders no pages. A caster that moves redraws the resident pages its bounds reach; a caster whose bounds the effect cannot know (a node that is not a core mesh, a dynamic, instanced or displaced primitive) redraws every resident page every frame. `invalidate()` redraws them all; so does a change of light direction.

Sources with their own `drawShadow` (terrain, scatter, voxels, culled parts, VAT crowds, imposters, raw meshes) cast here as they cast into `Shadows`, with no change on their side:

```ts
import { Engine, box } from 'margoengine/core';
import { Scatter } from 'margoengine/scatter';
import { VirtualShadows } from 'margoengine/shadows/virtual';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, { backend: 'webgpu' });
const rocks = Scatter.attach(engine, box(1, 2, 1), { count: 200, area: [24, 24] });
const pages = VirtualShadows.attach(engine, { distance: 800 });
pages.add(rocks, { static: true }); // redrawn when its version changes, or call pages.invalidate()
```

Such a source keeps one uniform per cascade, so its pages go to the GPU four at a time in submits of their own: `prepareShadow` gets the four page matrices, `drawShadow` runs with `cascade` 0 to 3. Add a still source with `static: true`, and it costs nothing once its pages are drawn. Without it, it redraws every resident page every frame, a submit per four pages, because the effect cannot know where it reaches. These submits run before the frame's own, so what a source computes on the frame's encoder (scatter's camera cull, say) reaches its shadow one frame late.

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

## Far from world zero: `floatingOrigin`

Under a `FloatingOrigin` the camera is local, so each rebase would move the cascades' texel grid by the shift and make every shadow edge jump by up to half a texel. Pass the origin and the cascades and `bounds` snap to whole texels of float64 world space instead: over 32 rebases 1e5 m from zero a world point keeps its texel phase within 0.01 texel (it moved by up to half a texel before). A rebase also redraws cascades that `cadence` holds. Without the option the fit is unchanged, bit for bit; the frame does the same draws, writes and allocations either way.

```ts
import {Engine} from 'margoengine/core';
import {FloatingOrigin} from 'margoengine/cameras/origin';
import {Shadows} from 'margoengine/shadows';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgpu'});
const origin = FloatingOrigin.attach(engine);
Shadows.attach(engine, {floatingOrigin: origin});
```

## Preview tier contract

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.

## Cutout coverage in ray-traced shadows

The optional `shadows/rt-alpha` entry connects `modelAlphaMasks` to the RT
candidate test. Collect UV provenance with `bvh/alpha-triangles`, build the tree
from those same positions and indices, then pack the masks:

```ts
import { Engine, box } from '@margoengine/core';
import { loadGLTF } from '@margoengine/gltf-pro';
import { MeshBVH } from '@margoengine/bvh';
import { modelAlphaMasks } from '@margoengine/bvh/alpha';
import { alphaWorldTriangles } from '@margoengine/bvh/alpha-triangles';
import { Shadows } from '@margoengine/shadows';
import { alphaRayTracedFilter, packRayTracedAlpha } from '@margoengine/shadows/rt-alpha';

const canvas = document.createElement('canvas');
canvas.width = 480; canvas.height = 240;
document.body.append(canvas);
const engine = await Engine.create(canvas, { backend: 'webgpu' });
const model = await loadGLTF(engine, '/examples/assets/khronos/AlphaBlendModeTest/AlphaBlendModeTest.glb');
// View the receiver from between it and the caster, so the model does not hide its shadow.
engine.camera.position = [0, 1.35, 5];
engine.camera.target = [0, 1.35, 7];
engine.camera.fov = 100;
engine.lighting.direction.set([0, 0, -1]);
const receiver = engine.createMesh().setGeometry(box(8, 6, 0.1)).setPosition([0, 1.35, 7.05]);
const triangles = alphaWorldTriangles(engine, [model]);
const bvh = MeshBVH.build({ positions: triangles.vertices, indices: triangles.indices });
const masks = await modelAlphaMasks(model);
const packed = packRayTracedAlpha(triangles, masks);
// Reach the foreground cutouts, ending before this sample model's opaque backboard.
const filter = alphaRayTracedFilter(engine, bvh, packed, { rays: 1, far: 7.1 });
const shadows = Shadows.attach(engine, { filter });
shadows.add(model); // also supplies cutout casters to the map fallback
shadows.add(receiver, { castShadow: false });
engine.start();
```

Pass an array of mask sources for several models, or a function from an actual
primitive to its `AlphaMask`. Unmasked faces stay opaque. `modelAlphaMasks.skipped`
lists unsupported masks (including texture coordinate sets other than TEXCOORD_0
and compressed images without readable pixels); those stay opaque, as on
`AlphaRaycaster`. Pass an abort signal as `modelAlphaMasks(model, {signal})`.

Coverage uses interpolated TEXCOORD_0, explicit bilinear alpha reads, independent
repeat/mirror/clamp wrapping, affine UV rows, factor and inclusive cutoff
(`alpha >= cutoff`). A rejected texel continues the same traversal, preserving
coplanar candidates. BLEND surfaces follow the existing CPU oracle's opaque
policy; this is deterministic MASK coverage, not stochastic transparency.
Skin/morph positions are bind pose, as with `worldTriangles`.

Packing snapshots UVs and mask pixels. Repack and create a new filter after
topology, UV, material or mask edits; position-only edits use the filter's existing
`refit()` after updating and refitting its BVH. Never pair the data with a different
same-size tree. `createRayTracedAlpha(packed)` exposes the supported coverage hook
for `rayTracedFilter(..., {alpha})`. Each effect owns its hook; do not share a hook
between attached effects. Setup restores resources from the CPU snapshot after a
device loss; disposal frees the GPU buffer. Packed data can be released after
creating the effect. Defaults of rays, bias, light size and far stay those of RT.

Alpha requires five fragment storage buffers (ordinary RT needs four). Unsupported
WebGPU tiers and WebGL2 return the configured map fallback (default `'soft'`).
The alpha image is one binding: 16-byte header, 32 bytes per original face, 64
bytes per distinct mask, and one alpha byte per pixel padded to four bytes per
mask. RGBA input channels must be integer bytes; factor/cutoff must be 0..1;
UVs/transform rows must be finite float32 values. For each masked face, four
times the absolute affine bound over its vertex UVs must fit float32, leaving
headroom for interpolation/row evaluation; reduce UV or transform magnitudes
when this validation rejects them. Mask dimensions are positive
integers at most 1,048,576 per axis. CPU packing is below 256 MiB; the actual
device buffer limits also apply. CPU provenance, real-model packing, candidate ordering and resource tests accompany
real-GPU closest/any-hit and fragment tests. The rendered `Shadows.attach` proof
compares receiver pixels to independent CPU rays for the complete Khronos model,
with default and quarter-turn UV transforms, opaque control, restored resources
and map fallback. Both lit and shaded receiver pixels are required.
