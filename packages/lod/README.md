# @margoengine/lod

Import `margoengine/lod` from the `margoengine` package, or `@margoengine/lod` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Level of detail for scenes with thousands of objects (CAD assemblies, simulators, forests, cities), plus
GPU-baked octahedral imposters for the farthest level. Core is unchanged.

```ts
import {Engine, PbrMaterial} from 'margoengine/core';
import {sphereGeometry, toGeometry} from 'margoengine/geometry';
import {LODSystem, Imposter} from 'margoengine/lod';
import {loadGLTF} from 'margoengine/gltf-pro';
const engine = await Engine.create(document.querySelector('canvas')!);
const highGeometry = toGeometry(sphereGeometry(1, 64, 32)), midGeometry = toGeometry(sphereGeometry(1, 24, 12));
const lowGeometry = toGeometry(sphereGeometry(1, 8, 6));
const material = new PbrMaterial({color: '#8d99a6'});
const part = () => engine.createMesh().setGeometry(highGeometry).setMaterial(material);
const parts = [part(), part()];

const lods = LODSystem.attach(engine, {hysteresis: 0.1});
const imposter = Imposter.bake(engine, highGeometry, {material, frames: 12, frameSize: 128}); // once, at load
for (const part of parts)                      // core meshes; the anchor's world transform drives the choice
  lods.add(part, [
    {object: highGeometry},                    // Geometry levels swap the anchor's geometry (fastest path)
    {object: midGeometry, distance: 40},
    {object: lowGeometry, distance: 90},
    {object: imposter, distance: 150},         // all instances of one atlas: one instanced draw
    {object: null, distance: 1000},            // nothing beyond 1 km
  ]);

// Meshes and models work too: their `visible` (or `root.visible`) is toggled.
const model = await loadGLTF(engine, '/valve.glb');                  // or createMesh() from @margoengine/materials
const anchor = part(), lowMesh = part().setGeometry(lowGeometry);
lods.add(anchor, [{object: model}, {object: lowMesh, screen: 0.05}, {object: Imposter.bake(engine, model), screen: 0.01}]);

const data = await imposter.export();          // cache it (IndexedDB, a file) ...
const cached = Imposter.fromData(engine, data); // ... and skip the bake next load
```

- **Levels** are a core `Mesh`, anything with a `root` Mesh (a gltf-pro model or a materials mesh), a core `Geometry`
  (set on the anchor), an `Imposter`, or `null`. Up to 8 per object. Each object picks by `distance` (world units from
  the camera to the anchor) or by `screen` (bounding-sphere height as a fraction of the viewport height, using the
  object's world scale and the camera's fov); `bias` multiplies every distance, a quality knob for tiers.
- **Hysteresis**: while a level is shown its switch distance shrinks by its `hysteresis` fraction, so
  the camera has to come back further before the finer level returns. No flicker at a boundary.
- **Cost**: one loop over packed typed arrays before the transform tick, reading last frame's world matrices; only
  objects whose level changed are touched; no measurable heap growth (under 64 KB over 1,000 frames with 3,000
  objects switching every frame, `npm test`). Geometry levels keep a hidden mesh per geometry so core never frees and re-uploads a batch whose last
  user just switched away. New objects take effect on the next frame.
- **Subassembly imposters**: a core `Mesh` with child meshes bakes its whole visible subtree in its own space, each part with its own material (`Imposter.bake(engine, module)`), as it is at bake time. Bake once per distinct subassembly design and share the atlas across every copy (the subtree scan is O(meshes)). Anchor each copy on an empty mesh that is not inside the subtree (a sibling with the same transform), because a hidden anchor or ancestor hides the imposter, and use the subassembly mesh itself as level 0: `lods.add(anchor, [{object: module}, {object: imposter, screen: 0.03}], {radius: imposter.radius})`. Picking: `engine.pick` does not see a subassembly while it shows its imposter (its parts are hidden); `lods.pickProxies()` reports it.
- **Imposters** bake `frames`² orthographic views over the whole sphere of directions (octahedral layout) on the
  GPU, through gltf-pro's own shader with an early return, so base-colour textures, vertex colours, normal maps,
  alpha masks and `@margoengine/materials` maps are all captured. The atlas stores albedo + coverage (RGBA8 sRGB, with
  mips) and normal + depth + roughness/metalness (RGBA16F). At runtime each instance is a camera-facing quad that
  reprojects the pixel's ray onto the three nearest views (with one depth parallax step per view, so the views agree on
  the surface), blends colour, normal, depth and roughness/metalness by the view weights, relights with the engine light (matching core
  or gltf-pro shading, whichever the source used) and writes per-pixel depth, so imposters occlude and are occluded
  correctly. Where the views still disagree (silhouettes), coverage cross-fades over blended alpha 0.25-0.75
  (alpha-to-coverage under MSAA, a fixed per-pixel dither at 1x) instead of a hard cut at 0.5. Each tile is sampled
  with its mip level computed from the smooth coordinate and clamped half a texel of the coarser level read, so
  trilinear filtering never reaches a neighbouring view. Bounding-sphere frustum culling on the CPU, hidden anchors (or hidden
  ancestors) are skipped, and all instances of one atlas are one instanced draw (order 1.5, after opaque meshes).
- **Picking**: an imposter has no triangles, so `lods.pickProxies()` lists the objects showing an imposter level, each
  `LOD` with `sphere` (the imposter's local bounding sphere) and `model` (the first gltf-pro model among its levels).
  `@margoengine/bvh` (`Raycaster.intersectEngine`, `intersectObjects` with the anchor or that model) and
  `@margoengine/selection` (`Picking`, `engine.pick`) find this hook on the engine themselves (neither imports lod) and
  hit the sphere under the anchor's world matrix: the hit names the anchor and model and has `approximate: true`.
  Objects on a mesh, model or Geometry level keep exact triangle hits.
- **Device loss**: on a restored device each atlas is baked again from its source, or uploaded again from
  `fromData` data. If the source model was destroyed and there is no data, that atlas stops drawing.
- `lod.level` reads the shown level, `lod.remove()` stops managing an object (the shown level stays shown),
  `lods.dispose()` (or `engine.removePlugin(lods.name)`) frees keepers and GPU buffers; `imposter.dispose()` frees
  the atlas.

Measured on an Intel Arc 140V laptop iGPU, headless Edge 155, 1280×720, 4× MSAA, 2,500 instances of a
50,000-triangle torus knot (125 M triangles at full detail) with 3,072- and 576-triangle reductions and a 12×12×128 px
atlas (baked in about 0.16 s), camera orbiting over the grid, median of 120 serialised frames, one run
([gates-lod-2500.json](../../examples/package-benchmarks/results/gates-lod-2500.json), commit `7c90b73`):

| | CPU `engine.render()` | GPU (submit to done) |
| --- | --- | --- |
| empty scene | 0.5 ms | 3.6 ms |
| full detail (2,228 visible) | 0.7 ms | 226.9 ms |
| LOD + imposters (122 mid, 435 low, 1,943 imposters) | 0.8 ms | 23.2 ms |

The LOD frame differs from the full-detail frame by 1.7/255 on average and covers 99% of its lit pixels. GPU times
vary between runs on this laptop; most of the spread is the foreground fill both modes pay. Rerun with `node packages/lod/test/browser-check.mjs`: it writes
`test-results/lod-benchmark.json` and the screenshot pair `test-results/lod-full.png` / `test-results/lod-lod.png`.

**Atlas seams** (`node packages/lod/test/imposter-check.mjs`, same laptop, 256×256 canvas, 12×12×128 atlas): the camera
turns around one object in 0.5° steps (1° for small cards) and each step renders the full mesh and the imposter. Before
the fixes above, the imposter's largest step-to-step change was 7.8-10× its median change (the full mesh's: 1.2-1.4×):
whole regions flipped where the blend weights crossed the hard 0.5 coverage cut at view midpoints, and a thin disc
jumped by 48/255 per silhouette pixel in one step. Mip bleed, measured on the exported atlas with the GPU mip chain and
bilinear taps at the shader's clamp, reached 0.43 coverage from the neighbouring view at the 8-pixel mip (24-29% of
tile-edge samples). The "before" figures come from an earlier run that was not committed; the "after" row and the
mip-bleed figures are in [gates-lod-imposter-check.json](../../examples/package-benchmarks/results/gates-lod-imposter-check.json)
(Intel Arc 140V laptop iGPU, Edge 155). Now:

| 177 px card, knot | largest step / median | mean difference from full mesh | stray pixels |
| --- | --- | --- | --- |
| before, pitch 20° / -25° / 60° | 7.8 / 8.6 / 10.0 | 22.4 / 21.8 / 28.2 | 4.5% |
| after | 2.6 / 2.3 / 2.4 | 13.8 / 12.7 / 19.8 | 1.2% |

The disc's worst step fell from 48 to 12/255 (grazing views 18° apart on a 12×12 grid still differ), mip bleed is zero
at every level, and the mean difference at 53 and 27 px cards fell from 13.0 and 12.5 to 8.7 and 9.3. Cost: three more
texel loads per imposter pixel, about +2 ms GPU on the 2,500-instance benchmark in an uncommitted A/B run
(20.5-20.9 → 22.6-22.9 ms median, alternating runs, on AC power). The same script checks picking: every rendered imposter pixel picks its object through
`Picking` and the bvh Raycaster, full-detail pixels stay exact, and 16,384 grid pixels agree between GPU and CPU
within one pixel.

Limits: an imposter shows the object as baked: per-instance material colours, animation and emissive are not
captured, and it receives no shadows and casts none (shadows and SSAO only see real meshes). Roughness and metalness
are stored in 32 steps; normals are sampled without filtering. Imposter picks are approximate: the bounding sphere is
larger than the silhouette (a ray through the sphere's empty corners still hits, and the sphere can hide an object just
behind it), and the GPU draws the sphere as a 256-triangle polyhedron that encloses it (up to 4% larger at its
vertices). Selection outlines do not draw for objects on an imposter level. Imposters assume the level's model sits at
the anchor's origin. Selection reads the previous frame's
world matrices, so a teleported object can show the old level for one frame. `distance` levels are measured from the camera
position; `screen` levels use the camera's projection, so they also follow orthographic zoom (use them with
`@margoengine/cameras`). Object removal swaps with the last entry, so `lods.add` order is not kept. WebGPU
for imposters; distance and screen selection also work on the WebGL2 backend.

Apache-2.0. Optional, tree-shakable package, about 9.9 kB min+gzip ([entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)); peers: core and gltf-pro
^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/lod. Browser check and benchmark on a real WebGPU adapter:
`node packages/lod/test/browser-check.mjs`; picking and atlas seams: `node packages/lod/test/imposter-check.mjs` (writes
`test-results/imposter-check-current.json` with every per-step series).

## Fuller imposters

An imposter keeps its object's look when a whole forest falls back to one atlas. Each object gets its own `color` and `emissive`, both live on the `LOD` handle and both on one instanced draw; `emissive: true` at the bake adds an emissive atlas, kept by `export` and `fromData`; `ImposterFrames` plays an animation from a stack of atlases; and `shadows.add(lods)` makes every imposter of the system cast and receive.

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Imposter, ImposterFrames, LODSystem} from 'margoengine/lod';
import {Shadows} from 'margoengine/shadows';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const engine = stage.engine;
const lods = LODSystem.attach(engine);
const tree = await loadGLTF(engine, '/tree.glb');
tree.root.visible = false;
const atlas = Imposter.bake(engine, tree, {emissive: true}); // default false: no emissive atlas
const anchor = engine.createMesh();
const lod = lods.add(anchor, [{object: atlas}], {color: [0.8, 1, 0.7], emissive: [0, 0, 0]}); // defaults: white, black
lod.color.set([1, 0.7, 0.4]); // live, per object: autumn
const sway = ImposterFrames.bake(engine, tree, {
  count: 8, // frames of the animation, 2 or more
  fps: 12, // default 0: holds lod.frame
  margin: 1.2, // default 1: grows the bounds, for a pose past the bind pose
  pose: (index) => tree.nodes[0].setPosition([0, index * 0.01, 0]), // puts the source in frame `index`, by any means
});
lods.add(engine.createMesh(), [{object: sway}], {frame: 3}); // default 0: start offset, so copies do not move in step
const shadows = Shadows.attach(engine);
shadows.add(lods); // every imposter casts and receives; {castShadow: false} or {receiveShadow: false} as on any source
```

Each frame of `ImposterFrames` is an atlas of its own, so the memory is `count` atlases, and objects on the same frame share a draw: a forest on 8 frames is 8 draws. `shadows` sees an imposter as a card facing the light with the surface of the view nearest the light, standing back from itself by a tile's angle over its radius so that it does not shadow its own surface: an imposter's self-shadowing below that depth is lost, and the shadow it throws on other objects stays in place. Of a lighting effect only the `direct` hook reaches imposters, which is what `Shadows` gives; clustered lights and environment light do not. Casters are not culled against the cascades. The emissive atlas is RGBA8, so baked emissive stops at 1; add more through `lod.emissive`.

## Selection outlines on imposters

`@margoengine/selection` outlines an object shown as an imposter like any other, x-ray included. Select its anchor or any of its levels: the outline stays through a level switch.

```ts
import {createStage} from 'margoengine';
import {box, PbrMaterial} from 'margoengine/core';
import {Imposter, LODSystem} from 'margoengine/lod';
import {Selection} from 'margoengine/selection';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const engine = stage.engine;
const lods = LODSystem.attach(engine);
const near = engine.createMesh().setGeometry(box(1, 1, 1));
const atlas = Imposter.bake(engine, box(1, 1, 1), {material: new PbrMaterial()});
lods.add(engine.createMesh(), [{object: near}, {object: atlas, distance: 50}]);
Selection.attach(engine, {width: 3}).set([near]);
```

## Streamed levels: `margoengine/lod/stream`

For a city too big to load, a `LevelStream` fetches a fine level only when the camera comes near it. While a level is on its way the object keeps the level it has, so give every object a coarse level that needs no fetch.

```ts
import {createStage} from 'margoengine';
import {box} from 'margoengine/core';
import {LODSystem} from 'margoengine/lod';
import {LevelStream} from 'margoengine/lod/stream';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const engine = stage.engine;
const lods = LODSystem.attach(engine);
const stream = LevelStream.attach(engine, {
  maxBytes: 512 * 1024 * 1024, // default 256 MiB: past it the longest unused levels are freed
  concurrency: 4, // default 4: levels fetched at once
});
const anchor = engine.createMesh().setPosition([500, 0, 200]);
const block = engine.createMesh().setGeometry(box(40, 80, 40)).setParent(anchor);
const fine = stream.level('/city/block-12.glb', {parent: anchor}); // fetched with loadGLTF when wanted
lods.add(anchor, [{object: fine}, {object: block, distance: 300}], {radius: 60});
```

A URL goes through `loadGLTF`; a function `(signal) => Promise<object>` loads anything else and must honour `signal`. `bytes` sets what a level counts for against `maxBytes`, by default the vertices and indices it holds. A fetch nobody has asked for over two frames is aborted, and a freed or aborted level fetches again when wanted, so a camera that sweeps past starts little and finishes nothing. Textures are not in the default count. A level on show is never freed, so `resident` can pass `maxBytes` when more than that is on show. A failed level stays `'failed'` with its `error`, listed in `stream.failed`, until `level.retry()`: nothing retries by itself. Levels can be chained: a wish for a level that is not there asks each level from it towards the one on show, and shows the first that can.

## Dithered cross-fade: `margoengine/lod/fade`

`LODFade` makes level switches dissolve instead of pop. For `duration` seconds both levels draw, each pixel from exactly one of them by a fixed noise threshold, so the fade costs no blending and no sorting, and the depth buffer stays right. Mesh, model, materials mesh and Geometry levels fade, as does a `null` level, which dissolves the object away.

```ts
import {createStage} from 'margoengine';
import {LODSystem} from 'margoengine/lod';
import {autoLOD} from 'margoengine/lod/auto';
import {LODFade} from 'margoengine/lod/fade';
import {box} from 'margoengine/core';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const lods = LODSystem.attach(stage.engine);
const fade = LODFade.attach(stage.engine, lods, {duration: 0.25}); // seconds, the default
const lod = await autoLOD(lods, stage.engine.createMesh().setGeometry(box(1, 1, 1)));
fade.prepare(lod); // optional: adds the fade to model levels now, so the first switch compiles nothing
```

The fade patches core's mesh shader while `LODFade` is attached, and adds a lighting effect to a model the first time it fades, or at `prepare`. `fade.finish()` ends every fade at once, and `fade.active` counts them. A switch to or from an `Imposter`, the far level of `hierarchicalLOD`, and everything on WebGL2 stay instant. `shadows` sees both levels during the fade, and picking the one that is on the way out until it ends. A `LODSystem` takes one transition at a time, through `lods.setTransition(fn)`, which is what `LODFade` calls.

## Levels from a file: `LOD.fromModel`

A glTF with `MSFT_lod` loads its level nodes too, hidden, as `model.lods`; `extras.MSFT_screencoverage` gives the switches, read as the bounding sphere's height over the viewport's. Only node levels are read, not `MSFT_lod` on materials.

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf-pro';
import {LOD, LODSystem} from 'margoengine/lod';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const model = await loadGLTF(stage.engine, '/city.glb');
LOD.fromModel(LODSystem.attach(stage.engine), model);
```

## Levels built for you: `margoengine/lod/auto`

`autoLOD` simplifies a mesh's geometry into lower levels. `hierarchicalLOD` merges still meshes into one far mesh per grid cell and material, shown in their place past `distance`: 400 boxes in 16 cells draw 16 meshes from afar. Both load `@margoengine/mesh-edit` only when they simplify (`autoLOD` always, `hierarchicalLOD` with `ratio` below 1), an optional peer you install.

```ts
import {createStage} from 'margoengine';
import {box} from 'margoengine/core';
import {LODSystem} from 'margoengine/lod';
import {autoLOD, hierarchicalLOD} from 'margoengine/lod/auto';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const lods = LODSystem.attach(stage.engine);
const hero = stage.engine.createMesh().setGeometry(box(1, 1, 1));
await autoLOD(lods, hero, {ratios: [0.5, 0.25]}); // defaults: ratios 0.5, 0.25, 0.125; screens from 0.25, halved; crease 60
const props = Array.from({length: 100}, (_, i) => stage.engine.createMesh().setGeometry(box(1, 1, 1)).setPosition([i, 0, 0]));
stage.engine.render(); // places them: the far mesh reads their world matrices
const city = await hierarchicalLOD(lods, props, {cell: 20}); // defaults: distance 8 cells, ratio 1
city.remove(); // frees the far meshes, shows the sources
```

A core mesh's levels keep positions and normals, since core geometry holds nothing else.

### Baked levels

`bake` keeps the look a level loses. Each primitive of each level gets a normal map of the source's surface, read through the source's own UVs, in the frame the level shades with. On a lumpy sphere at 8% of its triangles the error against the source picture falls to about half, in `packages/lod/test/auto-check.mjs`.

```ts
import {createStage} from 'margoengine';
import {createMesh, PbrMaterial} from 'margoengine/materials';
import {LODSystem} from 'margoengine/lod';
import {autoLOD} from 'margoengine/lod/auto';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const lods = LODSystem.attach(stage.engine);
const positions = [], normals = [], uvs = [], indices = [], n = 64;
for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) {
  const a = (x / n) * Math.PI * 2, b = 0.05 + (y / n) * 3.04, p = [Math.cos(a) * Math.sin(b), Math.cos(b), Math.sin(a) * Math.sin(b)];
  positions.push(...p); normals.push(...p); uvs.push(x / n, y / n);
}
for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
  const i = y * (n + 1) + x, j = i + n + 1;
  indices.push(i, j, i + 1, i + 1, j, j + 1);
}
const mesh = createMesh(stage.engine, {positions, normals, uvs, indices}, new PbrMaterial());
const lod = await autoLOD(lods, mesh, {ratios: [0.25, 0.1], bake: {size: 256, maps: ['normal', 'ao']}});
console.log(lod.levels.length); // 3
```

| `bake` | Default | Meaning |
| --- | --- | --- |
| `true`, or an object | off | A materials mesh or loaded model, skinned or still. A core mesh has no UVs and throws a `TypeError`. |
| `size` | 512 | Texels across the first level's maps, 1 to 8192; each lower level has half the last, down to 32 |
| `maps` | `['normal']` | `'normal'`, `'ao'` or both |
| `distance` | 5% of the primitive's size | How far from a level's surface rays search, in the mesh's own units |

A map the source has of its own stays, and that kind is not baked, so a model with a normal map keeps it on every level. A primitive whose UVs leave the unit square or overlap gets no maps, since one texel would have to serve two places: its levels draw as they do without `bake`. Run `unwrapMesh` from `@margoengine/mesh-edit` on such a mesh first. Levels hold their maps on the CPU as well, with every mip, and the maps go with the mesh. The bake runs on the calling thread, a primitive and level at a time, with a turn for the page between them; a level of a hundred thousand texels takes about a second. `hierarchicalLOD` does not bake.

### Moving sources

A far mesh is built from where its sources stood. `update()` rebuilds the far meshes of every cell whose sources moved, and returns how many; `follow: true` does the same each frame for the cells showing their far mesh, a frame behind the sources.

```ts
import {createStage} from 'margoengine';
import {box} from 'margoengine/core';
import {LODSystem} from 'margoengine/lod';
import {hierarchicalLOD} from 'margoengine/lod/auto';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const lods = LODSystem.attach(stage.engine);
const boats = Array.from({length: 50}, (_, i) => stage.engine.createMesh().setGeometry(box(1, 1, 3)).setPosition([i * 4, 0, 0]));
stage.engine.render();
const fleet = await hierarchicalLOD(lods, boats, {cell: 40, follow: true}); // default false
boats[0].setPosition([0, 0, 10]); // the far mesh of its cell follows
fleet.update(); // or, without follow, when you choose
```

A rebuild is the merge over again, and the simplifying too with a `ratio` below 1, for the whole cell: it suits things that move now and then, not every mesh of a city every frame. Each `update()` compares the matrices of every source. A mesh stays in its cell, however far it goes, and the cell's switch distance stays measured from where the cell began.

### Textured meshes

A loaded model's `TEXCOORD_2` and `TEXCOORD_3` stay with the vertices a level or far mesh keeps. A `createMesh` mesh of `@margoengine/materials` keeps everything: UVs, UV1, tangents, vertex colours and its materials, in `autoLOD` levels and in `hierarchicalLOD` far meshes, one per cell and material. Each collapse keeps one end of an edge, so every vertex of a level is one of the source's, unchanged. Corners that share a position stay welded, and an edge where a UV or any other attribute jumps is held as a seam, so seams and hard edges stay closed.

```ts
import {createStage} from 'margoengine';
import {LODSystem} from 'margoengine/lod';
import {autoLOD} from 'margoengine/lod/auto';
import {PbrMaterial, Texture, createMesh} from 'margoengine/materials';
import {sphereGeometry} from 'margoengine/geometry';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const lods = LODSystem.attach(stage.engine);
const data = new Uint8Array(4 * 4 * 4).fill(200);
const map = new Texture({data, width: 4, height: 4});
const mesh = createMesh(stage.engine, sphereGeometry(1), new PbrMaterial({map}));
const lod = await autoLOD(lods, mesh, {ratios: [0.5, 0.25]}); // levels hang under mesh.root and go with the mesh
```

### Loaded models

`autoLOD` and `hierarchicalLOD` take a `loadGLTF` model the same way. Each level is a model of the same file with the same node tree, its triangle primitives simplified: a primitive used by many nodes simplifies once, and every level holds the file's GPU textures, not a copy. Level 0 is the model's own nodes, so the model's `root` stays visible and you keep moving and hiding it as before. `hierarchicalLOD` makes one far model per cell and file, with a primitive per material.

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf-pro';
import {LODSystem} from 'margoengine/lod';
import {autoLOD} from 'margoengine/lod/auto';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const lods = LODSystem.attach(stage.engine);
const helmet = await loadGLTF(stage.engine, '/helmet.glb');
const lod = await autoLOD(lods, helmet); // ratios 0.5, 0.25, 0.125
```

Skinned and morphed models get levels too. Attach the model's `Animation` first:

```ts
import { Animation } from '@margoengine/animation';
import { loadGLTF } from '@margoengine/gltf-pro';
import { LODSystem } from '@margoengine/lod';
import { autoLOD } from '@margoengine/lod/auto';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});

const lods = LODSystem.attach(stage.engine);
const fox = await loadGLTF(stage.engine, '/fox.glb');
const animation = Animation.attach(fox);
const lod = await autoLOD(lods, fox, { ratios: [0.5, 0.25] }); // 576 triangles, then 288 and 144
animation.play('Run'); // every level runs with it
```

A level keeps the skin weights and morph deltas of the vertices it keeps, reads its joints from the source's nodes and shares the source's morph weights, so it follows whatever moves the source: clips, a mixer, your own code. Only the shown level deforms: a hidden source holds its last deformed vertices until it shows again, while its clips keep running. This loads `@margoengine/animation`, so these levels need WebGPU. Vertices at one position that deform differently, such as closed lips, are not welded. `hierarchicalLOD` still refuses a model that deforms, since its far mesh stands still.

When the file has animations, the shown level's drawing nodes follow the source's each frame, in plugin order: an `Animation` attached after `autoLOD` shows a frame late on a level. A file with no animations keeps the node transforms of the call, so a node you move by hand afterwards moves on level 0 only.

A flat-shaded mesh, Fox.glb and RobotExpressive among them, has a hard edge everywhere, which would keep any edge from collapsing. When a level misses its ratio by half on a part of 64 triangles or more with nine in ten triangles flat, normals stop counting as seams, and each kept triangle takes its own new normal. Points and lines stay on level 0, and `hierarchicalLOD` leaves them out of the far model. A part too small to reach a ratio keeps its last triangles. A level's vertices are its own compact copy: three levels at the default ratios cost about 0.875 of the source's vertex memory. `selectVariant` on the source does not reach its levels.

The levels are materials meshes of their own: pass each of `lod.levels.slice(1)` to `shadows.add` and the like as you do the source. `simplifyAttributes(geometry, ratios)` does the simplifying alone, on any packed `{vertices, indices}` such as a model's `primitive`. A material swapped on the source later does not reach its levels. A mesh with instances is refused: use `LodInstances` from `margoengine/culling/lod`. Faces mesh-edit cannot take (a third face on an edge, a flipped neighbour) simplify as separate sheets. mesh-edit's limit of 200,000 vertices or faces applies per primitive.
