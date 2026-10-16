# Fix the silent PBR geometry drops

The optional-package paths are implemented through the canonical reader below.
The four frozen-facade failures remain explicitly tracked in
`tests/modern-silent-facade-drops.test.js`, alongside passing model bounds/raw
alternatives. Their original assertions have not been removed or reported as fixed.

Date: 2026-10-16. The implementation to follow is `docs/pbr-mesh-triangles.md`. This file is the trace that found the hole. Sixteen packages share one hole. `gltf-pro` creates an engine mesh for the node and never calls `setGeometry`. Triangles stay on `PBRPrimitive`: a 20-float vertex (`position`, `normal`, `tangent`, `uv`, `color`) and a `Uint32Array` index buffer, plus the GPU buffers the primitive already owns. `parseFBX` and `parseMargo` return that same `PBRModel`. `@margoengine/gltf` does call `setGeometry`. The same file through `gltf-pro` does not.

Do not fix this by calling `setGeometry` on the PBR node. Core would draw those triangles a second time, and core `Geometry` cannot hold the 80-byte stride, the joints, or the morphs.

Core plus stage is 19,999 bytes gzip. The gate fails at 20,000. Do not edit `packages/core` or `packages/margoengine` for this. `Stage.fit` already throws `No geometry`. That throw stays. `worldBounds` and `loadedModel` in the stage keep reading core `Geometry` only.

## One registry, outside the gate

Add `packages/shared/mesh-source.js`. Core does not import `packages/shared`, so this file stays out of the measured bundle.

```js
const sources = new WeakMap();

export function setMeshSource(mesh, source) { sources.set(mesh, source); }
export function clearMeshSource(mesh) { sources.delete(mesh); }
export function meshSource(mesh) { return sources.get(mesh) ?? null; }
```

`source` is `{ vertices, indices, vertex, index, stride: 80, bounds }`. `vertices` is the primitive's CPU array. `vertex` and `index` are the GPU buffers the primitive already created. `bounds` is the local sphere or box the primitive already computed.

`PBRModel` calls `setMeshSource(primitive.node, source)` when the primitive is created, and `clearMeshSource` for every node in `dispose`. A node with several primitives stores a list. A skinned or morphed source keeps the bind-pose `vertices` and points `vertex` at the deformed buffer when one exists, which is the buffer `pickingPrimitives` already prefers.

Every caller below does this, and nothing else:

```ts
const source = mesh.geometry ?? meshSource(mesh);
if (!source) throw new Error('No geometry');
```

A mesh with neither core geometry nor a registered source throws. An empty collider list, a meshless export, and `{parts: 0}` are the bugs.

## What each package reads

| Package | Today | Read instead |
| --- | --- | --- |
| `physics` | Default collider becomes `[]` when `mesh.geometry` is null (`packages/physics/src/physics.ts`). | Fit the default box from positions at floats 0, 1, 2 of each 20-float vertex. Scale stays the mesh scale. |
| `exporters` | `if (mesh.geometry)` skips the triangles (`packages/exporters/src/scene.ts`). | Build `GeometryData` from the 20-float layout: position `0..2`, normal `4..6`, tangent `8..11`, uv `12..13`, color `16..19`. A skinned source also copies the joints and weights the data-scene writer already accepts. |
| `usdz-export` | Re-exports `exporters`. | No separate change. The export fix covers it. |
| `margoengine` | `worldBounds` skips a null `mesh.geometry`, then throws. A raw-buffer adapter returns `[]`. | Do not patch the stage file. Add `PBRModel.bounds` and `PBRModel.raw` in `gltf-pro`, using the primitive positions and the GPU buffers already in the source. `Stage.fit(mesh)` continues to throw for a PBR node. Callers fit `model.bounds`. |
| `inspector` | Skips wireframe, normals, and bounds when `mesh.geometry` is null. | Build those helpers from the source positions and normals. Do not allocate a core `Geometry`. |
| `machinery` | `if (!mesh.geometry) continue`, so parts and the BVH omit the node. | Count a part per source. The BVH uses the source indices and positions. |
| `lines` | Helpers return false and draw nothing. | Draw from the source positions. |
| `shadows` | `add(mesh)` keeps the registration, then continues because `node.geometry` is null. | Draw with the source GPU buffers, stride 80, and the index count. This is the same record as `PBRModel.shadowPrimitives`. |
| `taa` | Motion draws only `mesh.geometry` at stride 24. | Draw the source at stride 80. |
| `xr` | Stereo collects only `mesh.geometry`. | Collect the source buffers. |
| `bvh` | The raycaster returns before a null `mesh.geometry`. | Build the BVH from the source positions and indices. |
| `selection` | Picking and snapshots require `mesh.geometry`. | Hit-test the source bounds, then the triangles. The snapshot stores the source identity where it stored `mesh.geometry`. |

`gltf-pro` already exposes `pickingPrimitives` and `readPickingGeometry`. `bvh` and `selection` should call those for a deformed frame instead of keeping a second copy of the bind pose. A static box never needs the readback.

## Tests

Use the real `Box.glb` and `blender-rig.fbx` that produced the six failures. Load them through `loadGLTF` and `loadFBX` on WebGPU. Do not fabricate a mesh.

- `mesh.geometry` is still null.
- `meshSource(mesh)` returns one nonempty source.
- Default `addBody(mesh)` creates one collider.
- Default glTF export writes one mesh.
- CAD grouping reports one part.
- `shadows.add(mesh)` draws that source.
- `engine.pick` and the BVH raycaster hit the box.
- The skinned rig is hit from the deformed buffer after one animation frame, not from a second core `Geometry`.
- Disposing the model makes `meshSource(mesh)` return null, and a later `addBody` throws `No geometry`.
- `npm run measure:size` stays under 20,000 bytes gzip.

## Launch gaps that are not this bug

The unpublished install line is still in the root README. Keep the post on clone and `npm run modern:dev`, or publish `margoengine`, `@margoengine/core`, and `@margoengine/react` before telling anyone to `npm install` them.

The WebGPU limit belongs in the same paragraph as the quickstart. PBR, image-based lighting, and shadows require WebGPU. WebGL2 draws the basic mesh. The current opening sentence says "WebGL2 fallback" without that split.

Two items from the handoff are already done. Do not rebuild them. `gltf-pro` reads `KHR_texture_basisu` through `@margoengine/decoders`. `@margoengine/usdz` does not depend on Three.js. Its package peers are core, `gltf-pro`, and `loaders`.
