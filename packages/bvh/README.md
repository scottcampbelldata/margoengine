# @margoengine/bvh

Import `margoengine/bvh` from the `margoengine` package, or `@margoengine/bvh` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Triangle bounding volume hierarchy (`MeshBVH`, `shapecast`, `intersectsGeometry`), spatial queries and a CPU `Raycaster` for Margo Engine.

Build from source with `npm run build` in `packages/bvh`.

All-hit and nearest traversal share a conservative node-slab test. Exact parallel axes use finite spatial slack;
an infinite ray range cannot disable node rejection through infinity/NaN arithmetic. Tiny nonzero axes whose
reciprocal overflows retain division-based interval calculation rather than being treated as parallel. Hits still
use the exact triangle predicate, with full layered-hit results available for transparent picking. This changes
query correctness and traversal cost without changing mesh data, public signatures or the serialized BVH format.

```ts
import {Engine, box} from 'margoengine/core';
import {MeshBVH, Raycaster, buildAsync, computeGeometryBVHAsync} from 'margoengine/bvh';

// Engine picking: canvas CSS pixels in, sorted hits out.
const raycaster = new Raycaster();
canvas.addEventListener('pointerdown', event => {
  raycaster.setFromEngine(engine, event.offsetX, event.offsetY);
  const [hit] = raycaster.intersectEngine(engine); // {mesh, distance, point, normal, faceNormal, faceIndex, barycoord, frontFace}
});

// A loaded gltf-pro PBRModel uses its current GPU skin/morph pose.
// This explicit asynchronous query reads back only deformed vertices.
const [animatedHit] = await raycaster.intersectModel(model);

// Keep big builds off the main thread; the Raycaster then uses the cached BVH.
await computeGeometryBVHAsync(bigGeometry);

// Direct queries on raw data or a Geometry.
const bvh = MeshBVH.build({positions, indices});           // or MeshBVH.fromGeometry(geometry)
bvh.raycastFirst({origin: [0, 5, 0], direction: [0, -1, 0]}, {side: 'front'});
bvh.intersectsSegment([0, 0, 0], [0, 5, 0], {includeFace: face => face !== receiverFace});
bvh.closestPointToPoint([1, 2, 3], {maxDistance: 0.5});
bvh.intersectsSphere([0, 0, 0], 0.25);
bvh.intersectsBox({min: [-1, -1, -1], max: [1, 1, 1]}, boxMatrix);
bvh.intersectsBVH(otherBVH, otherToThisMatrix, (faceA, faceB) => {});
bvh.collectFrustum(frustumPlanes(viewProjectionTimesWorld)); // face indices

// Worker build with zero-copy results, then store or ship the tree.
const tree = await buildAsync({positions, indices}, {transfer: true});
const bytes = tree.toArrayBuffer();            // one buffer, 16-byte header
const again = MeshBVH.fromArrayBuffer(bytes, {positions});
```

PBR models and materials meshes honor live `side: 'front' | 'back' | 'double'` in ordinary engine raycasts and
deformed snapshot queries, including mirrored nodes. Ordinary engine raycasts also test each instance;
the asynchronous pose snapshot retains its existing non-instanced primitive transform. `raycaster.side`
can still override material sides.

## Segments and face filters

`intersectsSegment(start, end, {side, includeFace})` says whether a triangle crosses the segment between two
points, ignoring contact within a relative 1e-7 of either end, so a shadow test can stop exactly at a light that sits
on a surface. `includeFace` receives the source face index (also accepted by `raycastFirst` and `raycast`) and
returning false skips that face, for example the receiver's own triangles.

Restored trees (`deserialize`, `fromArrayBuffer`, the `MeshBVH` constructor) are checked to be one packed tree, so
corrupt node links throw instead of looping.

## How it works

- **Binned SAH build.** Triangles are binned on all three axes (32 bins, fewer for small ranges) and split at the lowest surface area cost, stopping at `maxLeafTriangles` or `maxDepth`. Triangle boxes move with the triangle ids during partitioning and the child bounds are measured in the same pass, so every pass streams memory.
- **Flat layout.** One `ArrayBuffer` of 32-byte nodes in depth-first order (six float32 bounds, then either a leaf's triangle offset and count or an internal node's right child and split axis; the left child is always the next node), a `Uint32Array` of vertex indices in leaf order and a `Uint32Array` of original face indices. Nothing else is needed, so `serialize`, `toArrayBuffer` and `postMessage` transfers move the tree without copying or rebuilding. Positions are never copied: a `Geometry`'s interleaved stride-6 `vertices` are read in place, which is also what makes `refit()` work after vertices move.
- **Exact queries.** Ray, closest point, sphere, oriented box, triangle/triangle and frustum tests run in float64. Box tests use a tiny relative slack so pruning is always conservative; the tests check that every query returns what a brute-force scan over all triangles returns.
- **Raycaster.** `setFromCamera` inverts `camera.matrix` and unprojects at the backend's clip depths (WebGPU reversed-Z near 1 and far 0, WebGL -1 and 1); `setFromEngine` takes canvas CSS pixels and refreshes the camera first. `intersectEngine` runs the transform kernel (so edits since the last render count), skips meshes that are hidden or under a hidden parent, applies `layers` and `filter`, rejects by the world bounding sphere, and casts the ray in each mesh's local space against that geometry's BVH from a `WeakMap` cache. World normals use the inverse-transpose. With `side: 'material'` (default) single-sided materials only hit their front side, defined like the renderer does by local winding, so mirrored meshes behave as drawn.
- **Deformed picking.** `await raycaster.intersectModel(model)` consumes the structural `DeformedPickingSource` interface implemented by gltf-pro's `PBRModel`. It snapshots the current GPU skin/morph output and local-to-world matrices, builds a separate BVH per primitive and refits it for later poses with unchanged topology. Deformations outside bind-pose bounds remain pickable. Hits have the same side rules, world distances, layer masks and filters as ordinary raycasts, without assigning a core `Geometry` or adding runtime gltf-pro imports. Each hit carries `uv` (TEXCOORD_0 interpolated from the posed snapshot) and the snapshot's `primitiveIndex` and `nodeIndex`, which `PBRModel` captures before its readback, so they stay right when snapshots are filtered, primitives share a node or the model changes while the readback is pending. A custom `DeformedPickingSource` whose snapshots leave those two out gets hits without them; posed hits carry no `model` or `primitive` object. Ray settings are captured before readback; removed, hidden or disposed meshes are skipped when it finishes. GPU readback and CPU refitting have an explicit cost, so use this query for pointer events. Ordinary mesh queries stay synchronous.
- **Worker and SSR safety.** `buildAsync` uses `new Worker(new URL('./bvh.worker.js', import.meta.url), {type: 'module'})`, which Vite, webpack 5 and Next.js emit as an asset (the browser test checks a production Vite build). Results come back in transfer lists. Without `Worker` (Node, SSR) it builds synchronously. Importing the package touches no browser globals and the package has no runtime dependency on core (types only).

## Options

| Option | Where | Default |
| --- | --- | --- |
| `maxLeafTriangles` | build | 8 |
| `maxDepth` | build | 40 (1..64) |
| `bins` | build | 32 SAH bins per axis |
| `strategy` | build | `'sah'`; `'center'` builds about 3x faster with slower queries |
| `transfer` | `buildAsync` | false. Moves raw `positions`/`indices` to the worker and back instead of copying |
| `signal` | `buildAsync` | none |
| `near`, `far` | ray queries, `Raycaster` | 0, Infinity |
| `side` | ray queries | `'double'` (`'front'`, `'back'`); `Raycaster` adds `'material'` (default) |
| `maxDistance`, `minDistance` | `closestPointToPoint` | Infinity, 0 (early exit) |
| `mode` | `collectFrustum` | `'triangles'` (face indices) or `'leaves'` (leaf node ids, see `leafTriangles`) |
| `firstHitOnly`, `layers`, `filter`, `bvhOptions` | `Raycaster` | false, every layer, none, build defaults |
| `precision` | `TriangleSource` (build, constructor, `deserialize`, `buildAsync`) | `'float32'`. `'float64'` keeps a Float64Array of positions uncopied, so triangle tests, hit points and barycentric weights keep double precision; node bounds stay float32, rounded outward |

`raycast` returns every hit sorted by distance, then face index; `raycastFirst` returns the same first hit (equal distances resolve to the lowest face index).

Engine-free code (editors, tools, workers) can import `@margoengine/bvh/tree`: `MeshBVH`, `buildBVH`, the shapecast constants and their types, with no engine core in its module graph or types. The core peer dependency is optional.

Other exports: `buildBVH` (raw `BVHData`), `shapecast` callbacks with `NOT_INTERSECTED`/`INTERSECTED`/`CONTAINED`, `getGeometryBVH`/`setGeometryBVH`/`hasGeometryBVH`, `terminateBVHWorker`, `frustumPlanes` (matrix products and inverses: `@margoengine/math/mat4`). Layer masks: `setRenderLayers` from `@margoengine/cameras/layers`, which raycasts read.

## Baking light and AO into vertex colours

From `@margoengine/bvh/bake`: `bakeVertexColors(target, occluder, options)` is Crocotile's Bake Lighting panel on the CPU: it returns linear RGBA
vertex colours (`Float32Array`, four per vertex) for `target.positions` and `target.normals` (same space as the
occluder BVH; use `creasedNormals` from `@margoengine/geometry` for flat or smooth normals), and
`limitPalette(colors, palette, mode)` snaps them to a palette.

```ts
import {MeshBVH, worldTriangles} from 'margoengine/bvh';
import {bakeVertexColors, limitPalette} from 'margoengine/bvh/bake';
const cast = worldTriangles(engine, castAgainst); // Cast Against: the meshes that occlude
const occluder = MeshBVH.build({positions: cast.vertices, indices: cast.indices});
const colors = bakeVertexColors({positions, normals, colors: existing}, occluder, {
  lights: [{type: 'ambient', intensity: 0.2}, {type: 'directional', direction: [1, 2, 1]},
    {type: 'spot', position: [0, 4, 0], direction: [0, -1, 0], angle: 0.5, penumbra: 0.3, distance: 10}],
  ao: {strength: 0.8, rays: 32, distance: 1}, apply: 'standard', seed: 1,
});
const pixelArt = limitPalette(colors, ['#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75'], 'balanced');
```

| Option | Default |
| --- | --- |
| `lights` | omitted: lighting term 1 (AO only). Types `ambient`, `directional` (`direction` toward the light), `point`, `spot` (`direction` the cone points, `angle` half-angle in radians, `penumbra` 0..1); `color`, `intensity`, `distance` (0 unlimited), `decay` (2), `visible` |
| `shadows` | true: a ray toward each directional, point and spot light |
| `segmentShadows` | false; true tests point and spot shadows on the segment from the unshifted vertex to the light (directional shadows and AO keep the bias) |
| `shadowFaceFilter` | omitted; with `segmentShadows`, `(faceIndex, vertexIndex) => boolean`, false skips that occluder face |
| `backfaces` | true: occluder back faces block rays; false lets them through |
| `includeHidden` | false: lights with `visible: false` are skipped |
| `ao` | omitted: no AO. `strength` 1, `rays` 32 (cosine-weighted over the hemisphere), `distance` 1 |
| `apply` | `'none'` overwrites; `'standard'` multiplies onto `target.colors` (RGB or RGBA; alpha is kept) |
| `multiplier` | 1, scales the baked RGB |
| `seed` | 0; same inputs and seed, same colours |
| `bias` | 1e-3, ray origins move this far along the normal (not used by segment shadows) |

Per vertex: `(sum of lights) * (1 - strength * occludedRays / rays) * multiplier`, times the existing colour with
`'standard'`. Falloff is shared with Margo's GPU lights: directional `color * intensity * max(N.L, 0)`; point and spot
times `window / max(d^decay, 2^-12)` with `window = distance > 0 ? clamp(1 - (d / distance)^4, 0, 1)^2 : 1`; spot also
times `smoothstep(cos(angle), cos(angle * (1 - penumbra)), dot(-L, direction))`, a hard edge at penumbra 0. Results
are not clamped. Palette modes follow Crocotile's: `'nearest'` closest RGB in sRGB-encoded values, `'luminance'`
closest linear Rec. 709 luminance (hue ignored), `'balanced'` nearest after stretching the colours so their darkest and
brightest values map to the palette's lowest and highest r, g and b, which spreads a bake over the whole palette.
Crocotile casts rays over
the whole sphere and keeps the upper half; here every ray is cast in the hemisphere, so `rays` is the count used. The
bake runs synchronously on the calling thread (measured about 0.23 s for 20,000 vertices at 33 rays each, Node 24 on
one laptop core).

## Lines

`intersectLines(raycaster, lines, options)` from `@margoengine/bvh/lines` picks `@margoengine/lines` lines with a Raycaster's ray, using a BVH per line, and returns the line, segment index, point, distance and offset. It has its own entry, so nothing else pays for it. Options, defaults and an example are in the [lines README](../lines/README.md#picking).

## Scene BVH

`SceneBVH` from `@margoengine/bvh/scene` keeps one top-level tree over every mesh, model primitive, instance and pick proxy of an engine, so a raycast over a city does not loop over every mesh. It answers what `raycaster.intersectEngine(engine)` answers, in the same order, with the raycaster's `near`, `far`, `side`, `layers`, `filter` and `firstHitOnly`.

```ts
import {box, Engine} from 'margoengine/core';
import {Raycaster} from 'margoengine/bvh';
import {SceneBVH} from 'margoengine/bvh/scene';

const engine = await Engine.create(document.querySelector('canvas')!);
const geometry = box(1, 1, 1);
for (let i = 0; i < 10000; i++) engine.createMesh().setGeometry(geometry).setPosition([(i % 100) * 3, 0, Math.floor(i / 100) * 3]);

using scene = new SceneBVH(engine);
const ray = new Raycaster([30, 50, 30], [0, -1, 0]);
const [hit] = scene.intersect(ray); // looks for moved objects first

// Many rays a frame: one update, then no refresh.
scene.update(); // 'unchanged', 'refit' or 'rebuilt'
for (let x = 0; x < 100; x++) {
  ray.set([x * 3, 50, 30], [0, -1, 0]);
  console.log(hit?.mesh, scene.intersect(ray, {refresh: false}).length);
}
```

`update()` reads every object's world matrix once. Objects that moved refit the tree; objects that came or went rebuild it, and so does a refit that leaves the tree `rebuildThreshold` times as costly (by surface area) as it was when built. With `{refresh: false}` the tree stays as of the last `update()`, so objects moved since are found at their old place; hiding, layers and disposal always count. Instances cost one tree entry each. A mesh under an active GPU deformation throws, as `intersectEngine` does; use `intersectModel` for it.

| Option | Default |
| --- | --- |
| `objects` | everything `intersectEngine` tests; given, only these meshes and models, as `intersectObjects` (`add` and `remove` change the set) |
| `rebuildThreshold` | 1.5 |

## Picking points and sprites

`PointRaycaster` from `@margoengine/bvh/points` is a `Raycaster` whose intersect calls also answer point clouds and sprite batches, sorted with the mesh hits by distance. `intersectEngine` finds the clouds and batches of a `PointsPlugin` by itself; `intersectObjects` takes them in its list beside meshes and models.

```ts
import {Engine} from 'margoengine/core';
import {PointRaycaster} from 'margoengine/bvh/points';
import {PointCloud, PointsPlugin} from 'margoengine/points';

const engine = await Engine.create(document.querySelector('canvas')!);
const points = PointsPlugin.attach(engine);
const cloud = points.add(new PointCloud({positions: new Float32Array([0, 0, 0, 1, 0, 0]), material: {size: 4}}));

const ray = new PointRaycaster();
ray.threshold = 5; // CSS pixels
ray.setFromEngine(engine, 320, 240);
for (const hit of ray.intersectEngine(engine))
  if (hit.target === cloud) console.log('point', hit.index, 'missed its centre by', hit.offset);
```

A point hits when the ray passes within `threshold` of its centre, or within its drawn size when that is larger, and a sprite when the ray crosses its drawn quad grown by `threshold`, with `uv` at the hit. The hit's `distance` is along the ray; `offset` is how far the ray passed from the point's centre. Clipping planes, `visible`, and each cloud's size settings count. A cloud that follows a mesh also obeys the raycaster's `layers` and `filter`; one that follows no mesh has neither, and its hits carry `mesh: UNATTACHED`. Sprite transparency is not read: a sprite's whole quad hits.

| Option | Default |
| --- | --- |
| `threshold` | 3 |
| `thresholdUnits` | `'pixels'` (CSS pixels); or `'world'` |

## Mesh distance fields

`bakeSDF` from `@margoengine/bvh/sdf` samples a mesh's signed distance on a regular grid: negative inside, positive outside, in the mesh's own space. Distance comes from the tree's closest-point query and the sign from the winding number, so a mesh with small holes still bakes a clean inside. The result answers distance, gradient and projection on the CPU and uploads as a 3D texture for shaders.

```ts
import {bakeSDFAsync} from 'margoengine/bvh/sdf';
import {MeshBVH} from 'margoengine/bvh';

const bvh = MeshBVH.build({
  positions: [-1, -1, -1, 1, -1, -1, 0, 1, -1, 0, 0, 1],
  indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3],
});
const controller = new AbortController();
const sdf = await bakeSDFAsync(bvh, {resolution: 48, signal: controller.signal, onProgress: (done) => console.log(done)});

console.log(sdf.distance([0, 0, 0]));   // negative: inside
console.log(sdf.gradient([0, 0, 2]));   // away from the surface
console.log(sdf.project([0, 0, 2]));    // back onto the surface
```

`bakeSDF` is the same bake on the calling thread; each sample costs one closest-point and one winding query, so `bakeSDFAsync` runs in short slices and keeps the page drawing. `sdf.toTexture(device)` uploads an `r16float` 3D texture that the caller owns (`{format: 'r32float'}` keeps full precision but needs `float32-filterable` to filter). Samples sit on cell corners from `sdf.min` to `sdf.max` inclusive, x fastest in `sdf.data`. Past the grid, `distance` adds the way to the grid.

| Option | Default |
| --- | --- |
| `resolution` | 32 samples along the longest side, cells cubic; or `[x, y, z]`, each 2 to 2048 |
| `bounds` | the mesh's box grown by `padding` |
| `padding` | 0.1 of the longest side |
| `signed` | `true`; `false` bakes plain distance, for open meshes such as terrain or cloth |
| `accuracy` | 2; higher is closer to the exact winding sum and slower, `Infinity` is exact |

## Inside tests and mesh distance

`@margoengine/bvh/inside` answers two volume questions. `pointInside` and `windingNumber` use the generalized winding number, so small holes and flipped patches barely move the answer, where counting ray crossings flips it. `meshDistance` finds the closest points of two meshes by walking both trees at once, for clearance checks.

```ts
import {MeshBVH} from 'margoengine/bvh';
import {meshDistance, pointInside, windingNumber} from 'margoengine/bvh/inside';

const tetrahedron = {
  positions: [-1, -1, -1, 1, -1, -1, 0, 1, -1, 0, 0, 1],
  indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3],
};
const a = MeshBVH.build(tetrahedron);
const b = MeshBVH.build(tetrahedron);

console.log(pointInside(a, [0, 0, -0.5]));   // true
console.log(windingNumber(a, [0, 0, -0.5])); // about 1

const moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]; // column-major: b into a's space
const near = meshDistance(a, b, moved, {maxDistance: 10});
console.log(near?.distance, near?.pointA, near?.pointB, near?.faceA, near?.faceB);
```

The winding number is 1 inside a closed mesh wound counter-clockwise, 0 outside, -1 inside one wound the other way, and between on an open mesh; `pointInside` asks whether its size is over one half. `accuracy` (default 2) sets how far away a subtree may be replaced by its first-order estimate; `Infinity` sums every triangle. A refit tree answers at its new shape.

`meshDistance` answers `null` past `maxDistance` (default `Infinity`) and stops at the first pair at or below `minDistance` (default 0), which is enough for a pass or fail check. Meshes that touch or cross answer 0. It measures surfaces: a mesh wholly inside another is the gap between the two surfaces away, not 0; add `pointInside` to tell the two apart.

## GPU traversal

`@margoengine/bvh/gpu` uploads a `MeshBVH` to storage buffers and traces rays in WGSL compute, for picking at scale, baking, path tracing and audio occlusion. `GPUMeshBVH.create` takes a `GPUDevice`, or an `Engine` on WebGPU. The tree is built on the CPU as usual; after `bvh.refit()` call `update()`.

```ts
import {MeshBVH} from 'margoengine/bvh';
import {GPUMeshBVH} from 'margoengine/bvh/gpu';

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter!.requestDevice();
const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
const bvh = MeshBVH.build({positions, indices: [0, 1, 2]});

using gpu = await GPUMeshBVH.create(device, bvh); // disposed at the end of the block
const hits = await gpu.raycast([{origin: [0, 0, 5], direction: [0, 0, -1]}]);
console.log(hits.distance[0], hits.faceIndex[0], hits.frontFace[0]); // 5 0 1
const blocked = await gpu.raycast([{origin: [0, 0, 5], direction: [0, 0, -1]}], {mode: 'any', far: 4});
console.log(blocked.faceIndex[0]); // -1, a miss
```

`raycast` reads the answers back: `distance` (Infinity for a miss), `faceIndex` (-1 for a miss), `barycoord` (three weights a ray) and `frontFace`. It takes ray objects, or a `Float32Array` of `GPU_RAY_FLOATS` floats a ray (origin xyz, near, direction xyz, far) with a finite `far`; `packRays(rays, {near, far})` makes one. To keep everything on the GPU, `encodeTrace(encoder, rayBuffer, hitBuffer, count, {mode, side})` adds a trace to your encoder and writes `GPU_HIT_WORDS` words a ray: distance, face index with the front flag in bit 31, and the weights of vertices b and c.

To trace inside your own shader, paste `bvhWGSL({group, binding})` into it and bind `gpu.bindings(binding)`:

```ts
import {bvhWGSL} from 'margoengine/bvh/gpu';

const code = `${bvhWGSL({group: 1, binding: 0})}
@group(0) @binding(0) var<storage, read_write> shade: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  // side: 0 double, 1 front, 2 back. hit.face == BVH_MISS for a miss.
  let hit = bvhClosest(vec3f(0.0, 0.0, 5.0), vec3f(0.0, 0.0, -1.0), 0.0, 1000.0, 0u);
  let blocked = bvhAny(vec3f(0.0, 1.0, 5.0), vec3f(0.0, 0.0, -1.0), 0.0, 1000.0, 0u);
  shade[id.x] = select(hit.distance, 0.0, blocked.face != BVH_MISS);
}`;
console.log(code.length);
```

| Option | Where | Default |
| --- | --- | --- |
| `mode` | `raycast`, `encodeTrace` | `'closest'`; `'any'` stops at the first hit found, which need not be the nearest |
| `side` | `raycast`, `encodeTrace` | `'double'` (`'front'`, `'back'`) |
| `near`, `far` | `raycast` with ray objects | 0, Infinity |
| `signal` | `raycast` | none |
| `group`, `binding` | `bvhWGSL` | 0, 0 (five bindings from `binding`) |

Queries run in float32, so a `precision: 'float64'` source is rounded on upload. The triangle test is watertight (Woop, Benthin and Wald, JCGT 2013): no ray slips between two triangles that share an edge. Equal distances answer the lowest face index, as `raycastFirst` does. The tree, the rays and the hits must each fit `maxStorageBufferBindingSize`; anything larger throws a RangeError, so request a higher limit or split the work.

## Benchmark

`npm run bench` on Node 22, one core of a shared 2-core container, 1M triangles:

| Mesh | SAH build | Center build | Refit | First-hit rays/s | All-hits rays/s | Closest point/s | Brute force rays/s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Terrain 708x708 (999,698 tris) | 1.54 s | 0.61 s | 54 ms | 187,620 | 129,368 | 41,474 | 44 |
| Bumpy sphere (1,000,000 tris) | 2.03 s | 0.57 s | 59 ms | 118,467 | 65,033 | 17,310 | 39 |

That is roughly 3,000 to 4,200 times the brute-force ray rate. The tree takes about 26 MB for 1M triangles (32 bytes per node plus 16 bytes per triangle).

## Limits

- Raw indices may be any numeric array; each must be a whole number within the vertex range. With `buildAsync({transfer: true})` the input is checked before the buffers move, and normals may not share a buffer with the moved positions or Uint32 indices.
- Triangles only: no lines or points. Synchronous `intersectMeshes` and `intersectEngine` discover static glTF Pro/FBX triangles as well as core `Geometry`, including several primitives on one node. Once a GPU deformation buffer is active they throw with a direction to use `await raycaster.intersectModel(model)`, which reads the current pose. They never silently test a deformed mesh's bind pose. Hits carry barycentric weights but no `uv`.
- `collectFrustum` with `'triangles'` is the conservative culling test (a triangle is dropped only when all three vertices are outside one plane), not exact clipping.
- `refit()` keeps the tree topology; rebuild after large deformations for good query speed.
- Hits on a shared edge report every triangle that contains the point (the tests account for ties).
- The Raycaster reads engine internals through the same structural fields `engineRuntime` exposes (`store`, `meshes`, `camera`, `canvas`, `backend`). CPU queries test geometric triangles without evaluating fragment alpha masks or custom vertex-shader deformation. Use gltf-pro's GPU picking for rendered coverage and scene occlusion.

## Tests

`npm test` runs 113 Node tests. The bake tests check AO of exactly 1 on an open plane and darker AO toward a box, shadow rays (including backfaces), point falloff and spot cone values against the formulas, seed determinism, apply modes and palette picks per mode. Every query is compared with a brute-force scan over all triangles using the same exact predicates: about 2,800 first-hit rays and 2,000 all-hit rays (all three sides, near/far), 1,600 closest-point queries, 1,600 spheres, 1,200 oriented boxes (mirrored and sheared), 120 BVH pairs under random matrices (full pair sets), 240 random frusta (triangles and leaves), on random soups, an indexed bumpy sphere, and the Suzanne and Cow models from [alecjacobson/common-3d-test-models](https://github.com/alecjacobson/common-3d-test-models). They also cover tree structure for every option set, serialization and zero-copy transfer, corrupt-data rejection, refit after moving vertices, core `Geometry` normals, `shapecast`, SSR import safety, and the Raycaster against world-space brute force over 400 rays and 8 transformed meshes with hidden, parented, layered and filtered meshes. Precision tests check float64 sources against a float64 brute force 30 million units from the origin (all hits, order, barycentric weights, first hit), outward-rounded bounds after build and refit, exact bounds for float32 sources, tie order, and that the `tree` entry never reaches the engine core. Regression checks verify conservative ray rejection under shear and one conversion per plain position/normal attribute during construction. Seven deformed-source tests cover poses outside bind bounds, morph and eight-weight skin samples, topology refits/rebuilds, several primitives per node, mirrored transforms and normals, near/far, side overrides, hidden ancestors, layers, filters, asynchronous ray/matrix snapshots, disposal/id reuse and malformed readback data.

`npm run test:browser` (Playwright, honoring `BROWSER_CHANNEL`, `BROWSER_EXECUTABLE` and `BROWSER_ARGS`) builds a 200k-triangle BVH in the worker and checks it is byte-identical to the synchronous build while main-thread timers keep running, transfers, concurrency, errors, abort and terminate. It then creates real engines on WebGPU and WebGL2, checks picked mesh, point, normal and distance for translated, scaled, mirrored, hidden and parented meshes, compares the Raycaster with rendered pixels on a 64x64 grid and with `engine.pick` on WebGPU, requires zero WebGPU validation errors, and builds a production Vite consumer that must emit the worker.

Apache-2.0 licensed.

## Captured static-frame queries

`RaycastSnapshot.capture(engine, objects, {refresh: false})` copies local geometry/UVs,affine matrices,material sides,layer masks,visibility and camera mapping after a render. `snapshot.setFromCanvas(raycaster,x,y)` reuses the captured camera inversion; `snapshot.intersect(raycaster)` uses owned local BVHs and conservative Float64 top-level bounds. Dispose the snapshot when the frame/query operation ends. Later source or camera edits require recapture. Original owner references remain identity fields; numeric hits describe the captured frame. Removed/reused handles and disposed models are skipped,and disposed snapshots/engines reject.

Queries copy ray settings at entry,return owned hit arrays and support reentrant filters. Filters run in source order for conservative sphere candidates; source/settings mutations affect later queries or new captures,not the current captured numeric state. Filters that dispose handles cannot attach hits to replacements. Instances and analytic pick proxies preserve their existing identity/UV/normal fields. Empty geometry is skipped; malformed data rejects capture atomically. Active GPU deformation is explicitly unsupported: use async `Raycaster.intersectModel(model)` for current skin/morph geometry. Live model-list queries now reject that case too,closing a bind-pose fallback gap.

The17 snapshot regressions include exact live-query parity,affine hierarchy/mirrors,sides/masks/near/far,independent1,681-ray UV/plane oracles,large world translations without Float32 rebaking,camera ownership,instances/proxies,source/result isolation,invalid/deformed data,disposal/id reuse and callback mutations. Actual browser coverage compares captured and live numeric hits on both renderer backends. These static-frame checks do not establish general-rig,real-time performance or export acceptance.

## Owned projection and alpha visibility

RaycastProjection.capture(engine,{orthographicHeight}) captures camera/canvas data without scene geometry. Its project,depth,basis,pixelWorldSize and setFromCanvas methods reuse owned camera state. Points clip only at the near plane,not the far plane or canvas edges. Returned data never aliases cached values;changed coordinates invalidate projection reuse. Camera/canvas changes require recapture. Dispose releases the frame;engine disposal also rejects operations. Orthographic pixel scale needs the explicit rendered world height.

RaycastSnapshot.intersectDepth(raycaster) retains identical captured distance/world-point/UV,ordering,ray settings,filter order and liveness while omitting unused normal transforms/identity metadata. Rich intersect results remain intact. Owned Float32 geometry with an exactly zero-extent axis cannot intersect a ray whose corresponding local direction is zero:every triangle determinant is zero. That exact rejection runs after source/filter/liveness checks and only for direction magnitudes bounded against cross-product overflow;near-parallel or nonplanar data takes the ordinary path. No visible triangle or geometry detail is removed.

Snapshot.createVisibilityQuery({projection,orthographicHeight,alphaTexture,alphaThreshold,near,far,side,layers,filter}) captures query policy and a shared clamped nearest atlas's alpha bytes once. RGB is not sampled/validated. Recapture after atlas edits;this is not general material-shader alpha evaluation. Original handle/model/engine liveness remains checked on every ray. project,depthAtCanvas,visible and visibleMany own complete point-to-depth/alpha policy. All hits are retained for transparent-foreground resolution;known transparent hits differ from true misses. Only true misses issue all eight quarter-CSS-pixel boundary rays. Tolerance remains max(1e-5,depth*1e-5,one world pixel). No visibility-result cache or far clipping is introduced. Batch points are copied before callbacks;failures publish no partial array. Reentrant calls reject with state;query/snapshot/projection/engine disposal rejects with disposed. The snapshot and any borrowed projection must outlive the query. Dispose query first,then its dependencies.

Sixteen new cases cover analytic plane/CSS/depth/tolerance oracles,all boundary-ray offsets,opaque/transparent layers,clamped UVs,alpha threshold/capture,WebGPU/WebGL2 and vertical orthographic mapping,rich/depth parity,flat parallel rejection and nonflat controls,batch ownership,invalid input,callbacks and disposal. Frozen-editor differential checks334,992projected points/visibility classifications across16epochs plus3,200rich/depth rays on the full10,000-triangle/128-object fixture. CPU diagnostics do not establish actual GPU,UI,p95,FPS,general rigs or overall acceptance.


## Captured screen primitives

RaycastProjection.pointDistance(point,x,y) returns owned world point,CSS point/depth and pixel distance. closestSegmentPoint(a,b,x,y) preserves clamped closest CSS position and harmonic perspective world interpolation. Both endpoints must be at/after near;crossing edges are deliberately rejected by this pick primitive. Zero CSS length selects endpoint a,including depth. These policies match the existing Mesh editor;near-crossing pickability and depth-coincident edge choice are not newly solved.

projectSegment(a,b,{nearPadding}) clips owned endpoints to captured near plus a finite nonnegative world-depth padding(default0),then projects them without far/canvas clipping. It returns a,b,start,end or null. Its sequential directional arithmetic matches Mesh guide lines;it is distinct from endpoint-reject picking.

rectangle(x1,y1,x2,y2) normalizes an inclusive CSS rectangle borrowing the captured frame. project(point) applies near/rectangle containment. canvasSamples() returns owned top-left,top-right,bottom-left,bottom-right,center CSS pairs. segmentSamples(a,b) copies and validates both endpoints immediately,then lazily yields owned closest-segment results at fractions .5,.15,.85,0,1 of the rectangle-clipped CSS span. Exact Liang-Barsky operand order and CSS-to-world reconstruction are retained,including duplicate samples. It runs no visibility callbacks or scene queries;the caller may stop at the first visible result. Every iterator next,including after exhaustion,and every rectangle method checks borrowed frame/engine liveness. Keep the frame alive until all queries/iterators finish.

Source/camera/result ownership,finite inputs and actionable typed failures follow the other captured APIs. Nonfinite/overflowing or invalid reconstructed data rejects instead of publishing unusable numbers. The 15 focused cases include independent perspective/orthographic arithmetic,ordinary Float32 camera storage,inclusive/zero spans,near crossing,duplicates,directional degeneracy,lazy ownership,invalid data,getter disposal and engine disposal. Caller-owned eligibility,radii,layer priority,document identities and visibility remain outside these primitives. Synthetic checks alone do not establish actual gesture coverage,UI/p95/FPS,custom projection hooks,general rigs or overall acceptance.

Finite clip ratios that overflow to infinity are safely clamped by the same Liang-Barsky span rules;no nonfinite sample is published. Unclipped guide endpoints reuse captured point projections;returned world endpoints remain separate owned copies. Independent regressions cover extreme finite enclosing/excluding rectangles and repeated-guide transform counts plus cache ownership.
