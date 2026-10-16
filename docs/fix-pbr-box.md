# Fix the Khronos Box loaded through gltf-pro

Date: 2026-10-16. Audit commit: `6bcf85a`. Fixture: `packages/exporters/tests/fixtures/Box.glb`.

This is the spec to implement. `docs/pbr-mesh-triangles.md` registers triangles on the node that owns the primitive. That part stays. It does not make `physics.addBody(model.root)` see this file. The measured call returned a body with 0 colliders, because the only root-level node is `model.root` and the 24 vertices belong to its grandchild.

`mesh.geometry` stays `null` on every PBR node. `@margoengine/core` and `packages/margoengine` stay untouched. Combined gzip stays at or under 19,999 bytes. `npm run measure:size` is the check.

The same bytes through `@margoengine/gltf` already export 1 mesh and 1 primitive. Leave that loader alone.

## What the audit loaded

`Box.glb` has two glTF nodes and one primitive.

| Engine node | glTF | Triangles |
| --- | --- | --- |
| `model.root` | none, parent of the scene | none |
| `model.nodes[0]` | parent, column-major matrix below, child is node 1 | none |
| `model.nodes[1]` | `mesh: 0` | 1 primitive, 24 vertices |

`PBRModel` creates `root` plus one engine mesh per glTF node. Export of the engine therefore walks 3 nodes. The audit's "0 of 2" is `model.nodes`. The audit's "3 nodes, 0 meshes" is the engine export.

Node 0's matrix is `[1,0,0,0, 0,0,-1,0, 0,1,0,0, 0,0,0,1]`. A point in node 1's local space lands in the root's space as `(x, z, -y)`. A collider fitted to the raw 24 positions does not match the mesh on screen.

`parseFBX` and `parseMargo` return this same `PBRModel`. The `6bcf85a` tree had no `.fbx` file, so this fix is gated on the Box. Current HEAD does contain `packages/fbx/test/fixtures/blender-rig.fbx`. Do not block the Box assertions on it.

## Measured at 6bcf85a

| Call | Result |
| --- | --- |
| Nodes with `mesh.geometry` | 0 of 2. Primitives: 1. Vertices: 24 |
| `physics.addBody` | body returned, 0 colliders |
| `exportGLB` | 3 nodes, 0 meshes |
| `worldBounds` | throws `No geometry` |
| `deduplicateParts` | `{parts: 0, unique: 0}` |
| `AssemblyBVH.create` | throws `BVH requires 1..1000000 triangles` |
| `BoxHelper.update` | `false` |
| Same bytes, `@margoengine/gltf`, then `exportGLB` | 1 mesh, 1 primitive |
| Draco Avocado through gltf-pro | `Required glTF extensions are unsupported: KHR_draco_mesh_compression` |

Inspector, shadows, TAA, XR, the BVH raycaster, and selection were read and not executed. Each skips a mesh whose `geometry` is missing. The Box run shows it is missing. The other 48 packages do not have this hole. Leave them alone.

`@margoengine/gltf-pro` publishes `dist/index.js`. The audit imported that build. Edit source, run `npm run build:packages`, then repeat the Box load through the package entry. A green `src` file with a stale `dist` still reports 0 colliders.

## Leave these alone

- Do not call `setGeometry` on a PBR node. `packages/core/src/engine.ts` draws every visible mesh that has `geometry`. Core `Geometry` is a 6-float stride. The PBR vertex is 20 floats (80 bytes): position 0..2, normal 4..6, tangent 8..11, uv 12..13, color 16..19.
- Do not edit `packages/core` or `packages/margoengine`. `worldBounds` and `Stage.fit` keep throwing `No geometry` for this model. The fit is `model.bounds`.
- Do not return `{parts: 0, unique: 0}`. An empty grouping throws.
- Do not keep a physics body when the default collider cannot be built. `addBody` already removes the body if `addCollider` throws. An empty collider list is still a failure.
- A skinned or morphed primitive has no default collider. Throw `Skinned mesh needs an explicit collider`. The Box is static.

## One reader

`packages/shared/mesh-source.js`. Core does not import it, so it stays out of the measured bundle. Packages bundle separately, so the map lives on `globalThis` under `Symbol.for('margoengine.mesh-sources.v1')`.

```js
export function meshTriangles(mesh) {
  if (mesh?.geometry) return {kind: 'core', geometry: mesh.geometry};
  const source = mesh && sources.get(mesh);
  if (!source || source.model.disposed) return null;
  try { mesh.check?.(); } catch { return null; }
  return {kind: 'pbr', source};
}
```

`PBRModel` calls `setMeshSource` only for nodes that own primitives (`model.nodes[1]` on this file). `dispose` calls `clearMeshSource` on every created node. `meshTriangles(model.root)` and `meshTriangles(model.nodes[0])` stay `null`. `meshTriangles(model.nodes[1])` returns one source whose primitive has the 24 vertices and an index count divisible by 3 (36 indices, 12 triangles, on this file).

The source carries `model`, `node`, `primitives`, `stride: 80`, `skinned`, `morphed`, and a local AABB `bounds`. CPU arrays stay bind pose. `draws` and `shadowPrimitives` borrow the GPU records the model already owns.

That registration fixes every caller that is handed `model.nodes[1]`. It does not fix `addBody(model.root)`.

## Physics: fit the root from its descendants

`addBody` requires a root-level mesh. On this file the only root-level mesh is `model.root`. `addBody(model.nodes[1])` throws `Physics bodies need root-level meshes` until someone calls `setParent(null)`, which drops node 0's matrix. The audit got a body back, so the call was `addBody(model.root)`.

At `6bcf85a` the default collider list is `mesh?.geometry ? [{shape: 'box'}] : []`. The root's `geometry` is null, so the body comes back with 0 colliders.

The uncommitted physics edit always requests a box, then reads `meshTriangles(root)`, gets null, and `createColliderDesc` throws `A box collider without explicit size needs a mesh with geometry`. That throw still fails the audit. The model has triangles.

Default collider selection:

1. `meshTriangles(bodyMesh)` is set. Fit that node's primitives. Positions are local. Apply the body mesh scale once, which is what a detached primitive node already does.
2. It is null. Walk `engine.meshes`. Keep descendants that have a PBR or core source. A skinned or morphed source throws `Skinned mesh needs an explicit collider`.
3. No descendant has triangles. Throw `No geometry`. The `addBody` catch removes the body. `bodyCount` stays 0. This is the result for `engine.createMesh()`, and it replaces `{colliders: 0}`.
4. Descendants have static triangles. Build one box around all of them in the body mesh's local space.

Tick first (`engine.store.tick(false)`). Take each position float 0, 1, 2. Transform by the primitive node's world matrix (`node.matrix`), then by the inverse of the body mesh's world matrix. Those matrices already include scale. Do not multiply by `body.mesh.scale` again.

For this Box, the body is the root and its world matrix is identity, so the collider is the 24 points after node 0's matrix: `(x, z, -y)`. Half extents are `(max - min) / 2`. The center is `(min + max) / 2`. `body.colliders.length` is 1. `mesh.geometry` is still null.

Explicit `options.colliders` are unchanged. A caller who passes a capsule still gets that capsule.

## Export

`exportGLB(engine)` walks all 3 engine nodes and writes a mesh only where `meshTriangles` returns triangles. Result for this file: 3 nodes, 1 mesh, 1 primitive. Positions in the glTF are the primitive's local 24 positions, not the baked `(x, z, -y)` points. Node 0 keeps its matrix so a reimport draws the same box. `mesh.geometry` stays null.

An engine whose nodes have neither core geometry nor a PBR source throws. Returning 3 nodes and 0 meshes is a failure.

`@margoengine/usdz-export` re-exports this package. It needs no second writer.

The `@margoengine/gltf` load of the same bytes still exports 1 mesh and 1 primitive, because that loader calls `setGeometry` and `meshTriangles` returns `{kind: 'core'}`.

## CAD, BVH, and BoxHelper

These take the node list the caller passes. They read `meshTriangles` for each node. They do not pull descendants, and they do not call `setGeometry`.

| Call | Result |
| --- | --- |
| `deduplicateParts(model.nodes)` | `{parts: 1, unique: 1}` |
| `deduplicateParts([model.root])` | throws `CAD grouping contains no supported geometry` |
| `deduplicateParts` of an empty created mesh | same throw |
| `AssemblyBVH.create(model.nodes)` | resolves, 12 triangles, raycast returns `model.nodes[1]` |
| `AssemblyBVH.create([model.root])` | still throws `BVH requires 1..1000000 triangles` |
| `new BoxHelper(model.nodes[1]).update(engine)` | `true`, finite corners around that node's bounds |
| `new BoxHelper(model.root).update(engine)` | `false` |

`{parts: 0, unique: 0}` is the `6bcf85a` fall-through. Delete that return.

`AssemblyBVH` already transforms positions by `node.matrix` at build time. Node 1's world matrix includes node 0, so the 12 triangles sit where the box is drawn. A deformed primitive still throws `Deformed PBR mesh requires async Raycaster.intersectModel`. The Box is static.

## Bounds

`worldBounds(engine, model.nodes)` and `Stage.fit()` keep throwing `No geometry`. `loadedModel()` reads the same function and is for the minimal glTF loader and CAD. Do not pass a `PBRModel` through it.

`PBRModel.bounds` walks primitive positions through each node's world matrix, the same `(x, z, -y)` result as the root collider, and returns six finite floats. The quickstart and React `<Gltf>` fit `model.bounds`. `PBRModel.raw` returns the GPU buffers the primitive already owns.

## The readers that were only re-read

Replace each `mesh.geometry` skip with `meshTriangles`. A core mesh still uses its `Geometry`. A PBR node uses the source. No second core geometry is allocated.

| Package | Use the source for |
| --- | --- |
| `packages/inspector` | wireframe, normals, bounds |
| `packages/lines` | `BoxHelper`, `VertexNormalsHelper` |
| `packages/shadows` and `packages/clustered/src/local-shadows.ts` | the existing stride-80 `shadowPrimitives` |
| `packages/taa` | those same GPU records |
| `packages/xr` | a replica on the XR device from those records |
| `packages/bvh` | CPU triangles for a static query |
| `packages/selection` | the loader source when `geometry` is null, including `readPickingGeometry` after a deform |

GPU buffers already created by `PBRModel.setup` are borrowed. Shadows, TAA, and XR do not upload a second copy of the 24 vertices.

## Draco Avocado

This is a separate failure on the same commit. At `6bcf85a`, `GLTFAsset` throws on every `extensionsRequired` entry:

```ts
if (doc.extensionsRequired?.length) throw new Error('Required glTF extensions are unsupported: ' + doc.extensionsRequired.join(', '));
```

Avocado's only required extension is `KHR_draco_mesh_compression`, so both `parseGLTF` and `loadGLTF` throw before decode.

Current source already filters that name, plus `EXT_meshopt_compression`, `KHR_texture_basisu`, and `KHR_texture_transform`, and throws the same sentence only for whatever remains. Keep that filter. The `6bcf85a` blanket check is what the audit hit. Rebuild `dist` so the package entry matches source.

`loadGLTF` and `parseGLTFAsync` decode, then construct the `PBRModel`. The decoded Avocado primitive is 406 vertices and 2,046 indices, with UVs and tangents. `meshTriangles` on its primitive node follows the Box rules above.

`parseGLTF` stays synchronous and throws `Draco geometry requires parseGLTFAsync or loadGLTF`. That is the sync error. The unsupported-extensions sentence is for an extension that is actually absent from the filter.

`tests/modern-gltf-compression.test.js` is the check. The decoder unit test in `@margoengine/decoders` passing does not prove gltf-pro accepted the file. The audit's throw happened in the gltf-pro constructor.

## Tests

Load `packages/exporters/tests/fixtures/Box.glb` with `loadGLTF` or `parseGLTF` from the built `@margoengine/gltf-pro` entry, on WebGPU. Use the real file.

- `mesh.geometry === null` on `model.root`, `model.nodes[0]`, and `model.nodes[1]`.
- `meshTriangles(model.nodes[1])` is one PBR source, 24 vertices, 36 indices. The root and node 0 return null.
- `addBody(model.root)` returns one collider. Half extents and center match the 24 positions after node 0's matrix. Disposing the model, then `addBody` on a leftover handle, throws `No geometry` and leaves no body.
- `addBody(engine.createMesh())` throws and leaves `bodyCount === 0`.
- `exportGLB(engine)` writes 3 nodes, 1 mesh, 1 primitive, local positions equal to the 24, and keeps node 0's matrix.
- The same bytes through `@margoengine/gltf` still export 1 mesh and 1 primitive.
- `model.bounds` is six finite numbers enclosing the transformed box. `worldBounds(engine, model.nodes)` throws `No geometry`.
- `deduplicateParts(model.nodes)` is `{parts: 1, unique: 1}`. `deduplicateParts([model.root])` throws.
- `AssemblyBVH.create(model.nodes)` resolves. A ray through the transformed box hits `model.nodes[1]`. `create([model.root])` throws the triangle-range error.
- `new BoxHelper(model.nodes[1]).update(engine)` is `true`. `new BoxHelper(model.root).update(engine)` is `false`.
- `npm run measure:size` stays at or under 19,999. `git diff -- packages/core packages/margoengine` is empty for this work.
- `tests/modern-gltf-compression.test.js` loads Avocado through the async gltf-pro path. The unsupported-extensions error does not appear. `parseGLTF` on that file throws the `parseGLTFAsync or loadGLTF` error.

`tests/modern-silent-geometry-drops.test.js` detaches the primitive with `setParent(null)` before `addBody`. Keep that as the direct-node case. Add `addBody(model.root)` on the attached Box beside it. The detached test never sees node 0's matrix, which is the call that returned 0 colliders.

## Done when

| Call | After the fix |
| --- | --- |
| `mesh.geometry` on the Box | still null, 24 vertices on the primitive |
| `addBody(model.root)` | 1 collider around `(x, z, -y)` |
| `exportGLB` | 3 nodes, 1 mesh, 1 primitive |
| `model.bounds` | finite |
| `worldBounds` / `Stage.fit` | still throw `No geometry` |
| `deduplicateParts(model.nodes)` | `{parts: 1, unique: 1}` |
| `AssemblyBVH.create(model.nodes)` | 12 triangles |
| `BoxHelper` on `model.nodes[1]` | `update` returns `true` |
| `@margoengine/gltf` export of the same bytes | 1 mesh, 1 primitive |
| Avocado `loadGLTF` | primitives present, required-extension error gone |
| gzip | ≤ 19,999 |
