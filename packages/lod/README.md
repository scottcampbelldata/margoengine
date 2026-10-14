# @margoengine/lod

Level of detail for scenes with thousands of objects (CAD assemblies, simulators, forests, cities), the counterpart of
three.js `LOD`, plus GPU-baked octahedral imposters for the farthest level. Core is unchanged.

```ts
import {Engine, PbrMaterial} from '@margoengine/core';
import {LODSystem, Imposter} from '@margoengine/lod';

const lods = new LODSystem({hysteresis: 0.1});
engine.use(lods);
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
  objects whose level changed are touched; nothing is allocated per frame (tested with 3,000 objects switching
  every frame). Geometry levels keep a hidden mesh per geometry so core never frees and re-uploads a batch whose last
  user just switched away. New objects take effect on the next frame.
- **Imposters** bake `frames`² orthographic views over the whole sphere of directions (octahedral layout) on the
  GPU, through gltf-pro's own shader with an early return, so base-colour textures, vertex colours, normal maps,
  alpha masks and `@margoengine/materials` maps are all captured. The atlas stores albedo + coverage (RGBA8 sRGB, with
  mips) and normal + depth + roughness/metalness (RGBA16F). At runtime each instance is a camera-facing quad that
  reprojects the pixel's ray onto the three nearest views, blends them, relights with the engine light (matching core
  or gltf-pro shading, whichever the source used) and writes per-pixel depth, so imposters occlude and are occluded
  correctly. MSAA edges use alpha-to-coverage. Bounding-sphere frustum culling on the CPU, hidden anchors (or hidden
  ancestors) are skipped, and all instances of one atlas are one instanced draw (order 1.5, after opaque meshes).
- **Device loss**: on a restored device each atlas is baked again from its source, or uploaded again from
  `fromData` data. If the source model was destroyed and there is no data, that atlas stops drawing.
- `lod.level` reads the shown level, `lod.remove()` stops managing an object (the shown level stays shown),
  `lods.dispose()` (or `engine.removePlugin(lods.name)`) frees keepers and GPU buffers; `imposter.dispose()` frees
  the atlas.

Measured on an Intel Arc (Xe2-LPG) laptop GPU, headless Edge, 1280×720, 4× MSAA, 2,500 instances of a
50,000-triangle torus knot (125 M triangles at full detail) with 3,072- and 576-triangle reductions and a 12×12×128 px
atlas (baked in about 0.25 s), camera orbiting over the grid, median of 120 serialised frames, range over four runs:

| | CPU `engine.render()` | GPU (submit to done) |
| --- | --- | --- |
| empty scene | 0.6-0.7 ms | 3.4-4.2 ms |
| full detail (2,228 visible) | 1.1 ms | 160-232 ms |
| LOD + imposters (122 mid, 435 low, 1,943 imposters) | 1.1 ms | 11-25 ms |

The LOD frame differs from the full-detail frame by 1.9/255 on average and covers 99% of its lit pixels. The range is
across runs on a machine shared with other GPU jobs; most of it is the foreground fill both modes pay. Rerun with
`node packages/lod/test/browser-check.mjs`: it writes `test-results/lod-benchmark.json` and the screenshot pair
`test-results/lod-full.png` / `test-results/lod-lod.png`.

Limits: an imposter shows the object as baked: per-instance material colours, animation and emissive are not
captured, and it receives no shadows and casts none (shadows and SSAO only see real meshes). Roughness and metalness
are stored in 32 steps; normals are sampled without filtering. Imposters are not pickable (`engine.pick` and the
bvh only see meshes) and assume the level's model sits at the anchor's origin. Selection reads the previous frame's
world matrices, so a teleported object can show the old level for one frame. `distance` levels are measured from the camera
position; `screen` levels use the camera's projection, so they also follow orthographic zoom (use them with
`@margoengine/cameras`). Object removal swaps with the last entry, so `lods.add` order is not kept. WebGPU
for imposters; distance and screen selection also work on the WebGL2 backend.

MIT. Optional, tree-shakable package, about 9.0 kB min+gzip (the WGSL is most of it); peers: core and gltf-pro
^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/lod. Browser check and benchmark on a real WebGPU adapter:
`node packages/lod/test/browser-check.mjs`.
