# What goes in core and the stage

Date: 2026-10-16. Combined core plus stage gzip fails at 25,000 bytes. The current measurement is **18,876 bytes gzip** (43,637 raw) for core and **21,107 bytes gzip** (50,207 raw) for core plus stage. Those bytes are a mesh, one directional light, orbit controls, and the loader shell. The new bytes belong in the stage file, `packages/margoengine`. `@margoengine/core` stays the draw path it already is.

`gltf-pro` alone measured 19,256 bytes gzip. Animation, post, and the Draco decoder do not fit beside core. They stay optional packages. The stage does not import them.

## Core

Leave `packages/core` as it is.

`packages/core/src/engine.ts` draws a mesh only when `mesh.geometry` is set. A PBR or FBX node keeps `mesh.geometry === null`, so the core batch does not draw it. `gltf-pro` already draws that node. Calling `setGeometry` with the 20-float PBR vertex would put the same mesh in both drawers. Core `Geometry` is position plus normal, six floats. The PBR vertex is five `vec4`s, 20 floats, plus joints and morphs.

Do not add a PBR stride, a material graph, skinning, or a post pass to core.

## Stage

`worldBounds`, `Stage.fit`, and `loadedModel` in `packages/margoengine/src/model.ts` are the calls that still miss a loaded model. The current `rejectGeometry` helper sees `Symbol.for('margoengine.mesh-sources.v1')` and throws `No geometry`. Replace that throw with a read.

The registry already exists. `PBRModel` calls `setMeshSource` on the node that owns the primitive. The stage may import `packages/shared/mesh-source.js` and nothing else from `packages/shared`. Core does not import that file.

For each mesh, after `store.tick(false)`:

1. Core `Geometry` is present. Keep the stride-6 walk. Positions are floats 0, 1, 2. Transform by `mesh.matrix`.
2. `meshTriangles(mesh)` returns a PBR source. Walk `source.primitives`. Positions are floats 0, 1, 2 of each 20-float vertex. Transform by that primitive node's `matrix`.
3. Neither is present. The node is a root or a transform parent. Skip it.
4. The source is missing because the model was disposed. Skip it. If the scan finishes with no finite position, throw `No geometry`.

`Stage.fit` already calls `worldBounds` with hidden meshes excluded. A hidden PBR node stays out of the camera fit. `worldBounds` without that flag still includes it, which is the same rule core geometry already follows.

`loadedModel(...).raw` on WebGPU returns the core `geometryBuffers` records it returns today, then the GPU buffers the loader already created. Read `source.draws`. Each record has `vertex` and `index`. Do not allocate a second buffer. Do not require the core `instance` buffer on a PBR record. `LoadedModel.raw` in the stage can carry `instance` only for core geometry. On a WebGL2 device, `raw` stays `null`.

`Stage.load` of `.gltf` and `.glb` keeps importing `@margoengine/gltf`. That loader calls `setGeometry`, and `Stage.fit` keeps using the stride-6 path. PBR stays `loadGLTF` from `@margoengine/gltf-pro`. FBX stays `loadFBX`. Both register the same mesh source, so `Stage.fit` on those nodes works without a new format branch in `Stage.load`.

`Stage.sky`, `Stage.particles`, and `Stage.effects` stay dynamic imports. Do not inline those modules into the measured file.

## The Box and the rig

`packages/exporters/tests/fixtures/Box.glb` through gltf-pro is three engine nodes. The 24 vertices are on `model.nodes[1]`. Node 0's matrix maps local `(x, y, z)` to `(x, z, -y)`. `mesh.geometry` stays null on all three. Core's batch count for that model stays 0.

| Call | Result |
| --- | --- |
| `Stage.fit([pbrMesh, coreBox])` with the core Box at `[12, 0, 0]` | camera target `[6, 0, 0]` |
| Same call for `packages/fbx/test/fixtures/blender-rig.fbx` | camera target about `[5.304, 0, -0.361]` |
| `Stage.fit([pbrMesh])` | finite target on the PBR bounds, no `No geometry` throw |
| `loadedModel` `raw` for that mesh on WebGPU | one record per primitive, same `vertex` and `index` as `model.raw` |
| `Stage.load` of the same Box bytes through `@margoengine/gltf` | still one core mesh, fit unchanged |
| `npm run measure:size` | gzip at or under 24,999 |

`tests/modern-silent-facade-drops.test.js` should assert those results. The `todo` markers and the `rejectGeometry` throw both come out.

## Stays optional

These measured too large for the 25,000-byte file, and they already have a package:

| Package | Stays there because |
| --- | --- |
| `@margoengine/gltf-pro` | PBR shader, IBL, materials. About 19 KB gzip by itself |
| `@margoengine/animation`, `@margoengine/animator` | skinning and clips |
| `@margoengine/post`, `@margoengine/dof`, `@margoengine/taa`, `@margoengine/tonemap` | post passes |
| `@margoengine/decoders` | Draco and KTX2 |
| `@margoengine/physics` | Rapier stays a peer |

The stage reads positions and existing GPU buffers. It does not compile the PBR shader, sample a clip, or decode Draco.
