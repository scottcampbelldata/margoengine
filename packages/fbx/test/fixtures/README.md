# Blender mechanical fan fixture

`blender-rig.fbx` is an original, rigged and animated mechanical fan exported
through the actual Blender FBX exporter, with its authored source in
`blender-rig.py`. It contains no third-party mesh, motion, texture, or other
asset. The FBX and authoring script are dedicated to the public domain under
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/), whose
complete terms are included in `LICENSE-CC0.txt`.

The checked-in binary was exported on 2026-10-16 using Blender 5.3.0 Beta,
build hash `ecaf39c37b28` (2026-10-15), and its bundled `io_scene_fbx` exporter.
It is a 52,540-byte binary FBX 7400 file with SHA-256:

```text
3676d5b211d05b365eeba7c56c57cf4fef9151a8350fea84a21752603a898732
```

The script creates real Blender mesh, armature, vertex-group, modifier, material,
and action datablocks, then calls `bpy.ops.export_scene.fbx`. Tests read the
checked-in binary; they never run Blender or regenerate the fixture. Blender is
an authoring tool only and adds no project dependency. Regenerate it with:

```text
blender --background --factory-startup --python blender-rig.py -- /absolute/path/blender-rig.fbx
```

Blender's binary export includes creation time and generated object identifiers,
so regeneration need not produce identical bytes. Review source values and
update the recorded hash if deliberately regenerating it. The Blender
[FBX documentation](https://docs.blender.org/manual/en/5.3/files/import_export/fbx_legacy.html)
and [exporter source](https://github.com/blender/blender-addons/blob/main/io_scene_fbx/export_fbx_bin.py)
describe the native exporter and its linear baked-key representation.

## Exported subset

The fan has three closed tapered blades, 24 control points, 18 quad faces, and
three skin clusters named `Base`, `Middle`, and `Tip`. Every vertex belongs to
one cluster with weight 1. `Middle` and `Tip` are disconnected children of
`Base`; their pivots coincide at the fan shaft's origin. The mesh has a +1 X
translation and an offset in its local vertex positions, which makes the
mesh-space bind matrix nonidentity without moving the fan away from its shaft.

The rig deliberately uses identity world bind matrices for every joint.
Blender serializes cluster `Transform` in bone space. With identity
`TransformLink`, this equals the mesh bind space accepted by Margo's current
FBX subset. This asset therefore exercises a valid supported rig without
claiming coverage of other cluster bind conventions or changing the importer.
The authoring script checks the original bind pose using Blender's evaluated
armature modifier; the headless importer test checks its converted bind pose.

Every authored object and bone keeps unit scale. The script configures the
exporter to write `InheritType=0` through its property writer because the legacy
exporter otherwise hardcodes mode 1. These inheritance modes give the same
transforms for this rig's uniform scales. The script does not patch exported
FBX bytes, cluster matrices, or animation curves. There are no leaf bones,
constraints, textures, morphs, blended layers, or cubic animation curves.

## Ground truth from the FBX

The following facts are literal file data, independently checked before
checking the converted glTF:

- Skin clusters/joints: **3**, in order `Base`, `Middle`, `Tip`.
- Clip: **`Bend`**, one layer. At 24 fps, its 25 baked keys span ticks `0` to
  `46186158000`, or exactly **0 to 1 second**.
- All three `TransformLink` arrays are identity. Each cluster's `Transform`, and
  its expected converted inverse-bind matrix, has these 16 column-major values:

```text
1, 0, 0, 0,
0, 1, 0, 0,
0, 0, 1, 0,
1, 0, 0, 1
```

- The `Middle` local rotation curve has X=Y=0 and Z endpoints
  **0** and **90.00000762939453** degrees. Blender's float export accounts for
  the small difference from the authored 90 degrees.
- Export axes are Z-up, Y-forward (`UpAxis=2`, `FrontAxis=1`,
  `FrontAxisSign=-1`), with `UnitScaleFactor=100`. Margo maps source +Z to +Y,
  so the `Middle` quaternion endpoints are `[0, 0, 0, 1]` and, as Float32,
  **`[0, 0.7071068286895752, 0, 0.7071067094802856]`**. They follow directly from
  `[0, sin(radians(Z)/2), 0, cos(radians(Z)/2)]`.
- `Tip` rotates from 0 to -45 degrees, ending at Float32 quaternion
  `[0, -0.3826834261417389, 0, 0.9238795042037964]`.
- Every animation curve has `KeyAttrFlags=24836`, whose interpolation bits
  `flags & 14` equal **4** (linear).
