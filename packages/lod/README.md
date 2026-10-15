# @margoengine/lod

Level of detail for scenes with thousands of objects (CAD assemblies, simulators, forests, cities), the counterpart of
three.js `LOD`, plus GPU-baked octahedral imposters for the farthest level. Core is unchanged.

```ts
import {Engine, PbrMaterial} from '@margoengine/core';
import {LODSystem, Imposter} from '@margoengine/lod';

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
lods.add(anchor, [{object: model}, {object: lowMesh, screen: 0.05}, {object: Imposter.bake(engine, model)}]);

const data = await imposter.export();          // cache it (IndexedDB, a file) ...
const cached = Imposter.fromData(engine, data); // ... and skip the bake next load
```

- **Levels** are a core `Mesh`, anything with a `root` Mesh (a gltf-pro model or a materials mesh), a core `Geometry`
  (set on the anchor), an `Imposter`, or `null`. Up to 8 per object. Each object picks by `distance` (world units from
  the camera to the anchor) or by `screen` (bounding-sphere height as a fraction of the viewport height, using the
  object's world scale and the camera's fov); `bias` multiplies every distance, a quality knob for tiers.
- **Hysteresis** follows three.js: while a level is shown its switch distance shrinks by its `hysteresis` fraction, so
  the camera has to come back further before the finer level returns. No flicker at a boundary.
- **Cost**: one loop over packed typed arrays before the transform tick, reading last frame's world matrices; only
  objects whose level changed are touched; no measurable heap growth (under 64 KB over 1,000 frames with 3,000
  objects switching every frame, `npm test`). Geometry levels keep a hidden mesh per geometry so core never frees and re-uploads a batch whose last
  user just switched away. New objects take effect on the next frame.
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

MIT. Optional, tree-shakable package, about 9.9 kB min+gzip ([entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)); peers: core and gltf-pro
^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/lod. Browser check and benchmark on a real WebGPU adapter:
`node packages/lod/test/browser-check.mjs`; picking and atlas seams: `node packages/lod/test/imposter-check.mjs` (writes
`test-results/imposter-check-current.json` with every per-step series).
