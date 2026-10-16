# Fix the Khronos Box loaded through gltf-pro

Date: 2026-10-16. Audit commit: `6bcf85a`. Fixture: `packages/exporters/tests/fixtures/Box.glb`.

Implemented on 2026-10-16. `docs/pbr-mesh-triangles.md` registers triangles on the node that owns the primitive. That registration stays primitive-only. Physics now fits a geometry-free root from its static descendants without changing their hierarchy. The original measured call returned a body with 0 colliders, because the only root-level node is `model.root` and the 24 vertices belong to its grandchild.

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

Inspector, shadows, TAA, XR, the BVH raycaster, and selection were only read in the original audit. Their registry integrations were implemented before this follow-up and are exercised by `scripts/silent-geometry-tests.js`; this change adds the attached-root physics and standalone Box gates.

`@margoengine/gltf-pro` publishes `dist/index.js`. The audit imported that build. Edit source, run `npm run build:packages`, then repeat the Box load through the package entry. A green `src` file with a stale `dist` still reports 0 colliders.

## Leave these alone

- Do not call `setGeometry` on a PBR node. `packages/core/src/engine.ts` draws every visible mesh that has `geometry`. Core `Geometry` is a 6-float stride. The PBR vertex is 20 floats (80 bytes): position 0..2, normal 4..6, tangent 8..11, uv 12..13, color 16..19.
- Do not edit `packages/core` or `packages/margoengine`. A PBR-only `Stage.fit([mesh])` keeps throwing `No geometry`. A mixed `Stage.fit([pbrMesh, coreMesh])` does not throw: it drops the PBR vertices and fits the core mesh alone. `PBRModel.bounds` and `camera.fitToBoundingBox` are the fit. `PBRModel.raw` is the buffer list.
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

The preceding registry integration requested a box but only read `meshTriangles(root)`. That returned null, so `createColliderDesc` threw `A box collider without explicit size needs a mesh with geometry`. `colliderGeometry` in `packages/physics/src/physics.ts` now also gathers descendant sources for a geometry-free root.

Default collider selection:

1. `meshTriangles(bodyMesh)` is set. Fit that node's primitives. Positions are local. Apply the body mesh scale once, which is what a detached primitive node already does.
2. It is null. Walk `engine.meshes`. Keep descendants that have a PBR or core source. A skinned or morphed source throws `Skinned mesh needs an explicit collider`.
3. No descendant has triangles. Throw `No geometry`. The `addBody` catch removes the body. `bodyCount` stays 0. This is the result for `engine.createMesh()`, and it replaces `{colliders: 0}`.
4. Descendants have static triangles. Build one box around all of them in the body's rigid frame.

Tick first (`engine.store.tick(false)`). Take each position float 0, 1, 2. Transform by the primitive node's world matrix (`node.matrix`), then remove the body mesh's world translation and rotation. Rapier has no body scale: inverting the full scaled root matrix would incorrectly cancel root scale. Retain root, parent, and primitive scales from the world positions exactly once, and pass unit fit scale when creating the collider. The regression also uses translated, rotated, nonuniformly scaled and mirrored hierarchies so the symmetric Box cannot conceal a transform error.

For this Box, the body is the root and its world matrix is identity, so the collider is the 24 points after node 0's matrix: `(x, z, -y)`. Half extents are `(max - min) / 2`. The center is `(min + max) / 2`. `body.colliders.length` is 1. `mesh.geometry` is still null.

Explicit `options.colliders` are unchanged. A caller who passes a capsule still gets that capsule.

## Export

`exportGLB(engine)` walks all 3 engine nodes and writes a mesh only where `meshTriangles` returns triangles. Result for this file: 3 nodes, 1 mesh, 1 primitive. Positions in the glTF are the primitive's local 24 positions, not the baked `(x, z, -y)` points. Node 0 retains its transform as glTF TRS equivalent to the authored matrix, so a reimport draws the same box. `mesh.geometry` stays null.

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

## Bounds and the four facade TODOs

`worldBounds` and `Stage.fit` read `mesh.geometry` and never call `meshTriangles`. No optional hook can change that. Making the four `todo` cases in `tests/modern-silent-facade-drops.test.js` pass means editing the facade, or wrapping it so the test no longer calls it. Leave both the facade and those `todo` markers alone.

`tests/modern-silent-facade-drops.test.js` loads the real Khronos Box through gltf-pro and `packages/fbx/test/fixtures/blender-rig.fbx` through the FBX loader. Each file has two frozen calls and one passing alternative.

| TODO | What it does now | What already passes |
| --- | --- | --- |
| glTF Box, mixed `Stage.fit` (line 28) | Core control at `[12, 0, 0]`. `stage.fit([control])` targets `[12, 0, 0]`. `stage.fit([mesh, control])` still targets `[12, 0, 0]`. The PBR positions are omitted, so the combined center `[6, 0, 0]` is never reached. | Union `model.bounds` with the core mesh, then `camera.fitToBoundingBox`. |
| FBX rig, mixed `Stage.fit` | Same omission. Target stays `[12, 0, 0]`. The combined center is about `[5.304, 0, -0.361]`. | Same helper. |
| glTF Box, facade `raw` (line 51) | `loadedModel(engine, {root, meshes: [mesh], dispose})` returns `raw.length === 0`. | `model.raw.length === model.primitives.length`, stride 80, same GPU buffers as `pickingPrimitives`. |
| FBX rig, facade `raw` | Same empty array. | `PBRModel.raw`. |

`Stage.fit([mesh])` on a PBR node alone still throws `No geometry`. That assertion is the live test at line 75, and it stays.

`loadedModel` is an internal adapter. The raw TODOs construct it around a real PBR root and mesh. Public `Stage.load` imports `@margoengine/gltf` for `.gltf` and `.glb`, and `@margoengine/machinery` for CAD. It does not load gltf-pro or FBX. These four failures are interoperability limits of the frozen helpers, not a `Stage.load` regression on the public path.

The passing tests in that file are the contract: `model.bounds`, `model.raw`, and `camera.fitToBoundingBox` on the union. The optional `@margoengine/gltf-pro/scene` entry now provides `getSceneBounds`, `fitScene`, and `gatherSceneBuffers` for selected roots and their descendants. It combines core/PBR positions and borrowed GPU records without changing `Stage.fit` or `loadedModel`; separate Box/FBX tests cover these helpers. The original four TODO assertions still exercise the frozen APIs.

`PBRModel.bounds` walks primitive positions through each node's world matrix, the same `(x, z, -y)` result as the root collider, and returns six finite floats. The quickstart fits `model.bounds`; React bounds and centering helpers read `model.bounds`. `<Gltf>` itself does not change the camera.

## The readers that were only re-read

These existing integrations use `meshTriangles`. A core mesh still uses its `Geometry`. A PBR node uses the source. No second core geometry is allocated.

| Package | Use the source for |
| --- | --- |
| `packages/inspector` | wireframe, normals, bounds |
| `packages/lines` | `BoxHelper`, `VertexNormalsHelper` |
| `packages/shadows` and `packages/clustered/src/local-shadows.ts` | the existing stride-80 `shadowPrimitives` |
| `packages/taa` | those same GPU records |
| `packages/xr` | a replica on the XR device from those records |
| `packages/bvh` | CPU triangles for a static query |
| `packages/selection` | the loader source when `geometry` is null, including `readPickingGeometry` after a deform |

Shadows borrow the GPU buffers already created by `PBRModel.setup`. TAA creates compatible storage only when used. Native XR owns replicas on its compatible device, including skin/morph kernels. None attaches a second core drawable.

## Draco Avocado

This is a separate failure on the same commit. At `6bcf85a`, `GLTFAsset` throws on every `extensionsRequired` entry:

```ts
if (doc.extensionsRequired?.length) throw new Error('Required glTF extensions are unsupported: ' + doc.extensionsRequired.join(', '));
```

Avocado's only required extension is `KHR_draco_mesh_compression`, so both `parseGLTF` and `loadGLTF` throw before decode.

Current source already filters that name, plus `EXT_meshopt_compression`, `KHR_texture_basisu`, and `KHR_texture_transform`, and throws the same sentence only for whatever remains. Keep that filter. The `6bcf85a` blanket check is what the audit hit. Rebuild `dist` so the package entry matches source.

`loadGLTF` and `parseGLTFAsync` decode, then construct the `PBRModel`. The decoded Avocado primitive is 406 vertices and 2,046 indices, with UVs and tangents. `meshTriangles` on its primitive node follows the Box rules above.

`parseGLTF` stays synchronous and throws `Draco geometry requires parseGLTFAsync or loadGLTF`. That is the sync error. The unsupported-extensions sentence is for an extension that is actually absent from the filter.

`tests/modern-gltf-compression.test.js` checks real compressed Box/Avocado parsing. `scripts/pbr-box-tests.js` additionally loads the complete original Avocado JSON, buffer and three textures through `loadGLTF` on native WebGPU, verifies 406 vertices and 2,046 indices, renders the surface and checks worker/GPU cleanup. `scripts/support/pbr-box-assets.js` pins upstream bytes by revision and SHA-256. The decoder unit test alone does not prove gltf-pro accepted the file. The audit's throw happened in the gltf-pro constructor.

## Tests

Load `packages/exporters/tests/fixtures/Box.glb` with `loadGLTF` or `parseGLTF` from the built `@margoengine/gltf-pro` entry, on WebGPU. Use the real file.

- `mesh.geometry === null` on `model.root`, `model.nodes[0]`, and `model.nodes[1]`.
- `meshTriangles(model.nodes[1])` is one PBR source, 24 vertices, 36 indices. The root and node 0 return null.
- `addBody(model.root)` returns one collider. Half extents and center match the 24 positions after node 0's matrix. Disposing the model, then `addBody` on a leftover handle, preserves the frozen mesh diagnostic `Mesh disposed` and leaves no body. A live empty root throws `No geometry`.
- `addBody(engine.createMesh())` throws and leaves `bodyCount === 0`.
- `exportGLB(engine)` writes 3 nodes, 1 mesh, 1 primitive, local positions equal to the 24, and TRS reconstructing node 0's matrix. Reimport preserves world vertices and rendered pixels.
- The same bytes through `@margoengine/gltf` still export 1 mesh and 1 primitive.
- `model.bounds` is six finite numbers enclosing the transformed box. `Stage.fit([mesh])` on that PBR node throws `No geometry`. `Stage.fit([mesh, control])` with the core Box at `[12, 0, 0]` still targets `[12, 0, 0]`. The union goes through `camera.fitToBoundingBox`. `loadedModel(...).raw` stays empty. `model.raw` is nonempty. The four `todo` tests stay `todo`.
- `deduplicateParts(model.nodes)` is `{parts: 1, unique: 1}`. `deduplicateParts([model.root])` throws.
- `AssemblyBVH.create(model.nodes)` resolves. A ray through the transformed box hits `model.nodes[1]`. `create([model.root])` throws the triangle-range error.
- `new BoxHelper(model.nodes[1]).update(engine)` is `true`. `new BoxHelper(model.root).update(engine)` is `false`.
- `npm run measure:size` stays at or under 19,999. `git diff -- packages/core packages/margoengine` is empty for this work.
- `tests/modern-gltf-compression.test.js` loads Avocado through the async gltf-pro path. The unsupported-extensions error does not appear. `parseGLTF` on that file throws the `parseGLTFAsync or loadGLTF` error.

`tests/modern-silent-geometry-drops.test.js` detaches the primitive with `setParent(null)` before `addBody`. Keep that as the direct-node case. Add `addBody(model.root)` on the attached Box beside it. The detached test never sees node 0's matrix, which is the call that returned 0 colliders.

`tests/modern-pbr-box.test.js` adds eleven built-entry Box regressions with no FBX preflight. `packages/physics/tests/physics.test.js` also checks mixed core/PBR descendants, mirrored/nonuniform scales, explicit collider bypasses and atomic rollback. Run the native Box/complete Avocado gate with `npm run modern:test:pbr-box`; it also runs at the end of `npm run modern:test:extensions` in CI.

Validation on 2026-10-16: the full workspace build passes; Node 24 reports 1,318 passes, zero failures/skips and the four unchanged frozen-stage TODO cases. All 63 packages pass strict typechecks, packed runtime imports, and strict Bundler/NodeNext consumers. The Box/Avocado gate passes on RTX A6000 and SwiftShader with six captures, five shaders, all 35 tracked GPU resources released, and one Draco worker terminated per run. The existing inspector/shadow/TAA/XR suite also passes on both adapters with 36 captures, 67 shaders and all 337 resources released. There are no GPU compilation, validation or page errors. Core/stage sources remain unchanged at 47,983 bytes raw / 19,999 bytes gzip.

The optional mixed scene helpers have fifteen passing Node regressions and native GPU checks for both real Box/FBX assets together with core geometry. Each adapter checks six captures and eight shaders, releases all 64 tracked resources across restoration, and reports no GPU/page errors. Gathering and fitting perform zero GPU work; queries and restoration preserve rendered pixels exactly. The scene entry bundles only its helpers and the shared registry alongside external core APIs; loader, decoder, animation and shader code stay out of this entry.

## Done when

| Call | After the fix |
| --- | --- |
| `mesh.geometry` on the Box | still null, 24 vertices on the primitive |
| `addBody(model.root)` | 1 collider around `(x, z, -y)` |
| `exportGLB` | 3 nodes, 1 mesh, 1 primitive |
| `model.bounds` / `model.raw` | finite bounds, one buffer record per primitive |
| `Stage.fit` of a PBR node alone | still throws `No geometry` |
| mixed `Stage.fit` and facade `raw` | still the four `todo`s; Box target stays `[12, 0, 0]`, `raw` stays `[]` |
| `deduplicateParts(model.nodes)` | `{parts: 1, unique: 1}` |
| `AssemblyBVH.create(model.nodes)` | 12 triangles |
| `BoxHelper` on `model.nodes[1]` | `update` returns `true` |
| `@margoengine/gltf` export of the same bytes | 1 mesh, 1 primitive |
| Avocado `loadGLTF` | primitives present, required-extension error gone |
| gzip | ≤ 19,999 |
