# One reader for PBR triangles

Date: 2026-10-16. This replaces the caller-by-caller sketch in `docs/fix-silent-geometry.md`. `mesh.geometry` stays null on a PBR node. `setGeometry` puts that mesh into the core batch, and `packages/core/src/engine.ts` draws every visible mesh that has `geometry`. There is no flag for "stored here, drawn by `gltf-pro`." Core `Geometry` is also the wrong record. The PBR vertex is five `vec4`s, 20 floats, and a skinned primitive carries joints and morphs on top of that.

Core plus stage is 19,999 bytes gzip. Do not edit `packages/core` or `packages/margoengine`. `Stage.fit(mesh)` and `worldBounds` keep reading core `Geometry` only. The fit for a loaded glTF or FBX is `model.bounds` on the `PBRModel`.

## The registry

`meshTriangles(mesh)` lives in `packages/shared/mesh-source.js`. Core does not import `packages/shared`, so this file stays out of the measured bundle. A symbol-keyed global weak registry keeps independently bundled loaders and consumers interoperable.

```js
const sources = new WeakMap();

export function setMeshSource(mesh, source) { sources.set(mesh, source); }
export function clearMeshSource(mesh) { sources.delete(mesh); }

export function meshTriangles(mesh) {
  if (mesh?.geometry) return { kind: 'core', geometry: mesh.geometry };
  const source = sources.get(mesh);
  return source ? { kind: 'pbr', source } : null;
}
```

`source` contains `model`, `node`, a per-node `primitives` list, `stride: 80`, `skinned`, `morphed`, and a local AABB `bounds` getter. The CPU arrays in `primitives` remain the bind pose. `draws` and `shadowPrimitives` borrow live GPU records, including the current deformed vertex buffer. Each record retains its primitive identity, so shared index buffers do not merge different primitives. Optional consumers can call `prepareDeformation` or `readPickingGeometry` on the owner.

`PBRModel` calls `setMeshSource(primitive.node, source)` when the primitive is created. A node with several primitives stores a list. `dispose` calls `clearMeshSource` for every node. `PBRModel.bounds` walks the primitive positions in the same order `worldBounds` walks core vertices. `PBRModel.raw` returns the GPU buffers.

The 20-float layout matches the shader inputs in `packages/gltf-pro/src/shader.ts`:

| Floats | Values |
| --- | --- |
| 0, 1, 2 | position xyz |
| 4, 5, 6 | normal xyz |
| 8, 9, 10, 11 | tangent xyz and sign |
| 12, 13 | uv |
| 16, 17, 18, 19 | color |

## What every caller does

```ts
const triangles = meshTriangles(mesh);
if (!triangles) throw new Error('No geometry');
```

An empty collider list, a transform-only export, and `{parts: 0}` are failed tests.

| Caller | Result |
| --- | --- |
| `physics` | The default box uses bind-pose positions 0, 1, 2 of every primitive. Mesh scale still applies. This preserves the existing glTF/FBX collider behavior; animated collision shapes should use explicit `colliders`, such as capsules or hulls. |
| `exporters` | Write `GeometryData` from the table above. A skinned source also copies the joints and weights the data-scene writer already accepts. A node with no triangles throws. |
| `usdz-export` | No separate change. It re-exports `exporters`. |
| `machinery` | One part per source. The BVH uses the source indices and positions. |
| `lines` | Draw from the source positions. |
| `inspector` | Wireframe, normals, and bounds use bind-pose source data with current node transforms. No duplicate core `Geometry` is allocated. |
| `shadows` | Draw the source GPU buffers at stride 80. This is the same record as `PBRModel.shadowPrimitives`. |
| `taa`, `xr` | TAA consumes current stride-80 geometry with lazily owned history storage. Native XR owns replicas on its compatible GPU device and re-encodes skin/morph kernels using the current source pose. Caller-owned extension texture views need recreation for that device and reject explicitly. |
| `bvh`, `selection` | Static synchronous queries use source CPU triangles. Synchronous raycasts and AssemblyBVH reject active GPU deformation with an explicit diagnostic; asynchronous `intersectModel` reads the current GPU pose. Selection and GPU picking discover loader-owned sources automatically. |
| `PBRModel` | `bounds` and `raw` as above. The quickstart and the React `<Gltf>` helper fit `model.bounds`. They do not call `Stage.fit` on the root mesh. |

## Tests

Load the real `Box.glb` and `blender-rig.fbx` through `loadGLTF` and `loadFBX` on WebGPU. Do not fabricate a mesh.

- `mesh.geometry` is still null, and `meshTriangles(mesh)` returns one nonempty PBR source.
- Default `addBody` on the box creates one collider.
- Default `addBody` on the rig preserves its bind-pose collider. An explicit collider still attaches.
- Default glTF export of each file writes one mesh. The rig export keeps the skin attributes.
- CAD grouping counts one part for each file.
- `shadows.add(mesh)` draws the source.
- The BVH raycaster and `engine.pick` hit the box.
- After one animation frame, the rig is hit from `readPickingGeometry`, not from a second core `Geometry`.
- `model.bounds` is finite for both files. `Stage.fit(mesh)` still throws `No geometry`.
- Disposing the model makes `meshTriangles(mesh)` return null, and a later `addBody` throws `No geometry`.
- `npm run measure:size` stays at or under 19,999 bytes gzip.

## Done when

A loaded static glTF has one collider, one exported mesh, and one CAD part. A loaded skinned file exports and picks; its default collider uses the bind pose. Core never draws the PBR vertex.

The four original facade assertions remain executable TODO cases in `tests/modern-silent-facade-drops.test.js`: mixed `Stage.fit` and the internal `loadedModel.raw` adapter still read core geometry only. Fixing those APIs requires changing the frozen stage. The same file verifies the supported `PBRModel.bounds`/`raw` alternatives, explicit camera fitting, and registry disposal. The original failures remain visible; they are not reported as fixed.
