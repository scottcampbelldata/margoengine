# @margoengine/bvh

Triangle bounding volume hierarchy, spatial queries and a CPU `Raycaster` for Margo Engine. It covers what three-mesh-bvh (`MeshBVH`, `shapecast`, `intersectsGeometry`) and `THREE.Raycaster` do for Three.js.

Build from source with `npm run build` in `packages/bvh`.

```ts
import {Engine, box} from '@margoengine/core';
import {MeshBVH, Raycaster, buildAsync, computeGeometryBVHAsync} from '@margoengine/bvh';

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

## How it works

- **Binned SAH build.** Triangles are binned on all three axes (32 bins, fewer for small ranges) and split at the lowest surface area cost, stopping at `maxLeafTriangles` or `maxDepth`. Triangle boxes move with the triangle ids during partitioning and the child bounds are measured in the same pass, so every pass streams memory.
- **Flat layout.** One `ArrayBuffer` of 32-byte nodes in depth-first order (six float32 bounds, then either a leaf's triangle offset and count or an internal node's right child and split axis; the left child is always the next node), a `Uint32Array` of vertex indices in leaf order and a `Uint32Array` of original face indices. Nothing else is needed, so `serialize`, `toArrayBuffer` and `postMessage` transfers move the tree without copying or rebuilding. Positions are never copied: a `Geometry`'s interleaved stride-6 `vertices` are read in place, which is also what makes `refit()` work after vertices move.
- **Exact queries.** Ray, closest point, sphere, oriented box, triangle/triangle and frustum tests run in float64. Box tests use a tiny relative slack so pruning is always conservative; the tests check that every query returns what a brute-force scan over all triangles returns.
- **Raycaster.** `setFromCamera` inverts `camera.matrix` and unprojects at the backend's clip depths (WebGPU reversed-Z near 1 and far 0, WebGL -1 and 1); `setFromEngine` takes canvas CSS pixels and refreshes the camera first. `intersectEngine` runs the transform kernel (so edits since the last render count), skips meshes that are hidden or under a hidden parent, applies `layers` and `filter`, rejects by the world bounding sphere, and casts the ray in each mesh's local space against that geometry's BVH from a `WeakMap` cache. World normals use the inverse-transpose. With `side: 'material'` (default) single-sided materials only hit their front side, defined like the renderer does by local winding, so mirrored meshes behave as drawn.
- **Deformed picking.** `await raycaster.intersectModel(model)` consumes the structural `DeformedPickingSource` interface implemented by gltf-pro's `PBRModel`. It snapshots the current GPU skin/morph output and local-to-world matrices, builds a separate BVH per primitive and refits it for later poses with unchanged topology. Deformations outside bind-pose bounds remain pickable. Hits have the same fields, side rules, world distances, layer masks and filters as ordinary raycasts, without assigning a core `Geometry` or adding runtime gltf-pro imports. Ray settings are captured before readback; removed, hidden or disposed meshes are skipped when it finishes. GPU readback and CPU refitting have an explicit cost, so use this query for pointer events. Ordinary mesh queries stay synchronous.
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

Other exports: `buildBVH` (raw `BVHData`), `shapecast` callbacks with `NOT_INTERSECTED`/`INTERSECTED`/`CONTAINED`, `getGeometryBVH`/`setGeometryBVH`/`hasGeometryBVH`, `setMeshLayers`/`getMeshLayers`, `terminateBVHWorker`, `frustumPlanes`, `multiplyMatrices`, `invertMatrix`.

## Benchmark

`npm run bench` on Node 22, one core of a shared 2-core container, 1M triangles:

| Mesh | SAH build | Center build | Refit | First-hit rays/s | All-hits rays/s | Closest point/s | Brute force rays/s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Terrain 708x708 (999,698 tris) | 1.54 s | 0.61 s | 54 ms | 187,620 | 129,368 | 41,474 | 44 |
| Bumpy sphere (1,000,000 tris) | 2.03 s | 0.57 s | 59 ms | 118,467 | 65,033 | 17,310 | 39 |

That is roughly 3,000 to 4,200 times the brute-force ray rate. The tree takes about 26 MB for 1M triangles (32 bytes per node plus 16 bytes per triangle).

## Limits

- Triangles only: no lines or points. Synchronous `intersectMeshes` and `intersectEngine` discover static glTF Pro/FBX triangles as well as core `Geometry`, including several primitives on one node. Once a GPU deformation buffer is active they throw with a direction to use `await raycaster.intersectModel(model)`, which reads the current pose. They never silently test a deformed mesh's bind pose. Hits carry barycentric weights but no `uv`.
- `collectFrustum` with `'triangles'` is the conservative culling test (a triangle is dropped only when all three vertices are outside one plane), like three-mesh-bvh's frustum examples, not exact clipping.
- `refit()` keeps the tree topology; rebuild after large deformations for good query speed.
- Hits on a shared edge report every triangle that contains the point (the tests account for ties).
- The Raycaster reads engine internals through the same structural fields `engineRuntime` exposes (`store`, `meshes`, `camera`, `canvas`, `backend`). CPU queries test geometric triangles without evaluating fragment alpha masks or custom vertex-shader deformation. Use gltf-pro's GPU picking for rendered coverage and scene occlusion.

## Tests

`npm test` runs 25 Node tests. Every query is compared with a brute-force scan over all triangles using the same exact predicates: about 2,800 first-hit rays and 2,000 all-hit rays (all three sides, near/far), 1,600 closest-point queries, 1,600 spheres, 1,200 oriented boxes (mirrored and sheared), 120 BVH pairs under random matrices (full pair sets), 240 random frusta (triangles and leaves), on random soups, an indexed bumpy sphere, and the Suzanne and Cow models from [alecjacobson/common-3d-test-models](https://github.com/alecjacobson/common-3d-test-models). They also cover tree structure for every option set, serialization and zero-copy transfer, corrupt-data rejection, refit after moving vertices, core `Geometry` normals, `shapecast`, SSR import safety, and the Raycaster against world-space brute force over 400 rays and 8 transformed meshes with hidden, parented, layered and filtered meshes. Regression checks verify conservative ray rejection under shear and one conversion per plain position/normal attribute during construction. Seven deformed-source tests cover poses outside bind bounds, morph and eight-weight skin samples, topology refits/rebuilds, several primitives per node, mirrored transforms and normals, near/far, side overrides, hidden ancestors, layers, filters, asynchronous ray/matrix snapshots, disposal/id reuse and malformed readback data.

`npm run test:browser` (Playwright, honoring `BROWSER_CHANNEL`, `BROWSER_EXECUTABLE` and `BROWSER_ARGS`) builds a 200k-triangle BVH in the worker and checks it is byte-identical to the synchronous build while main-thread timers keep running, transfers, concurrency, errors, abort and terminate. It then creates real engines on WebGPU and WebGL2, checks picked mesh, point, normal and distance for translated, scaled, mirrored, hidden and parented meshes, compares the Raycaster with rendered pixels on a 64x64 grid and with `engine.pick` on WebGPU, requires zero WebGPU validation errors, and builds a production Vite consumer that must emit the worker.

MIT licensed.
