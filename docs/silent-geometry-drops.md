# Silent geometry drops on loaded PBR meshes

Status: implemented and verified. All six reported drops now pass, with ten
repository [regressions](../tests/modern-silent-geometry-drops.test.js) and twelve
real WebGPU checks. The original investigation and acceptance criteria follow.

Date: 2026-10-16. Six checks failed on real files. `loadGLTF` loaded `Box.glb` and `loadFBX` loaded `blender-rig.fbx`, both on WebGPU. Each file produced one nonempty PBR primitive whose engine mesh has `geometry === null`. No meshes or geometry were fabricated. The tests live outside the repository and were not copied in.

| Check | Expected | Actual |
| --- | --- | --- |
| Default `PhysicsBody` collider for `Box.glb` | 1 | 0 |
| Default glTF export mesh count for `Box.glb` | 1 | 0 |
| Default CAD grouping parts for `Box.glb` | 1 | 0 |
| Default `PhysicsBody` collider for `blender-rig.fbx` | 1 | 0 |
| Default glTF export mesh count for `blender-rig.fbx` | 1 | 0 |
| Default CAD grouping parts for `blender-rig.fbx` | 1 | 0 |

The other checks passed. The default inspector keeps each loaded mesh in the scene tree. PBR bounds match the primitive positions for both assets. Facade gathering returns `[]` through a root or list adapter that contains the loaded mesh. `Stage.fit([mesh])` throws `No geometry` instead of returning wrong bounds.

## Cause

`loadGLTF` and `loadFBX` create an engine mesh for the node and keep the triangles on the PBR primitive (`vertices`, `indices`, and the GPU buffers). They never call `setGeometry`. `mesh.geometry === null` is the normal PBR draw path, not a dropped upload. `Box.glb` and `blender-rig.fbx` both do this. Bounds still match the primitive positions, and the inspector still lists the node, because those paths read the primitive.

Three callers treat a null `mesh.geometry` as an empty mesh and continue:

- `packages/physics/src/physics.ts` turns the default collider into `[]` when `mesh.geometry` is missing, so `addBody` returns a body with zero colliders.
- `packages/exporters/src/scene.ts` copies geometry only inside `if (mesh.geometry)`, so the export writes the transform and omits the triangles.
- `packages/machinery/src/cad.ts` uses `if (!mesh.geometry) continue`, so the part count stays 0.

`Stage.fit` is the path that throws `No geometry`. `packages/margoengine/src/model.ts` skips the same meshes while gathering bounds, which is why a root-or-list adapter returns `[]`.

## Fix

Do not stuff the PBR buffers into core `Geometry`. Core geometry cannot hold the joints, morphs, and 80-byte vertex stride, and attaching it would give the core renderer a second mesh to draw. Core and the stage facade stay frozen.

The fix belongs in the three callers. When `mesh.geometry` is null, read the PBR primitive on that node.

- A static box uses `primitive.vertices` for the collider, the export, and the CAD part.
- A skinned primitive uses the bind-pose vertices for a default collider. Export keeps the skin attributes it already knows how to write from a data scene.
- A node with neither core geometry nor a primitive throws.

An empty collider list and a meshless glTF are the silent drops. `Stage.fit` already fails loudly. The physics, export, and CAD paths should fail the same way when they cannot see triangles, and they should see the primitive triangles when they are there.

## Done when

- Default `addBody` on the loaded `Box.glb` mesh creates one collider.
- Default glTF export of that mesh writes one mesh.
- Default CAD grouping counts one part.
- The same three checks pass for `blender-rig.fbx` from bind-pose vertices, without a second core `Geometry` on the node.
- A mesh with neither core geometry nor a PBR primitive throws in all three callers.
- Core plus stage stays under 20,000 bytes gzip.
