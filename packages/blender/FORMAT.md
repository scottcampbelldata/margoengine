# .margo v1

All numeric binary fields are little-endian. Maximum file length is 256 MiB. Offsets below are byte offsets from the start of the file, independent of any enclosing ArrayBuffer view. Files and all sections are padded to four-byte boundaries. Padding is not included in section lengths.

## Header: 64 bytes

| Byte offset | uint32 value |
| --- | --- |
| 0 | `0x4f47524d` (ASCII `MRGO`) |
| 4 | Version `1` |
| 8 | Exact padded file length |
| 12 | Section count, 3..4096 |
| 16 | Section table offset, always `64` |
| 20 | Flags: `0`, or `1` for an animated file (see "Animated files") |
| 24 | Default vertex stride, `80`; a type-2 section's compact layout flag overrides it to `24` |
| 28..60 | Reserved, always `0` |

## Section table

Immediately after the header, each section has four uint32 fields: `type`, `offset`, `byteLength`, `flags`. These section headers describe the mesh buffers referenced by each primitive. Type-2 flags select the vertex layout; type-3 flags select the index format. Other section types require zero flags. Unknown values and combined index flags are rejected. Payloads follow the table in table order. Each offset must equal the padded end of the previous payload (or table for the first). Overlapping sections, unknown types, gaps and trailing data are rejected. Shared resources reference the same section ID rather than overlapping table entries. Compact/PBR vertices and uint16/uint32 indices may coexist in one file. Existing v1 files use zero flags and retain their original layouts; older readers reject the new flags explicitly.

| Type | Content |
| --- | --- |
| 1 | UTF-8 JSON manifest; only section 0; maximum 1 MiB |
| 2 | Packed vertices; nonzero multiple of 80 bytes (flags `0`) or 24 bytes (flags `1`) |
| 3 | Triangle indices; nonzero multiple of 6 bytes (UINT16) or 12 bytes (UINT32) |
| 4 | Embedded RGBA8, non-interlaced PNG |
| 5 | Animation data (animated files only): skin influences, inverse bind matrices, morph deltas and keyframes |
| 8 | Embedded KTX 2.0 texture (Basis Universal), static files only; see "KTX2 textures" |

## Index format: type-3 section header flags

| Flag | Storage | Selection |
| --- | --- | --- |
| `0x00` | Little-endian uint32 | Legacy v1 files; accepted by the reader |
| `0x01` (UINT16) | Little-endian uint16 (`<H`), 2 bytes per index | Maximum index < 65,536 |
| `0x02` (UINT32) | Little-endian uint32 (`<I`), 4 bytes per index | Maximum index >= 65,536 |

The writer accepts little-endian uint32 input indices, checks the vertex count and maximum index, then chooses the smallest valid format. Every index must be less than the primitive's vertex count. Index sections contain complete triangles. The reader expands uint16 indices to uint32 for the existing renderer; uint32 indices retain views of the input.

## Manifest

The manifest uses glTF 2.0 conventions for `asset`, `nodes`, `scenes`, `scene`, `materials`, `textures`, `samplers` and optional `extras`. This is a static prepared scene, not a glTF asset: buffers, bufferViews, accessors, skins, animations and required extensions are prohibited.

`meshes[i].primitives[j]` contains `vertices` and `indices` as zero-based section IDs of types 2 and 3, plus an optional material index. `mode` may be omitted or equal 4. The exporter also records local `bounds` as `[minX,minY,minZ,maxX,maxY,maxZ]`; the renderer computes world bounds from geometry. Primitive accessors, morph targets and extensions are prohibited.

`images[i]` contains a type-4 `section` ID and `mimeType: "image/png"`. External image URIs are prohibited. PNG header dimensions are checked before decoding; decoded dimensions must match. Dimensions are 1..4096 and aggregate decoded RGBA storage is bounded at 256 MiB.

Nodes use TRS (quaternion xyzw) or an affine, non-sheared column-major matrix. They may reference meshes and use children with the existing PBR hierarchy rules. The exporter flattens evaluated world transforms to root-level TRS. Object metadata is `extras.margo: {id: string, properties: {...}}`; runtime handles are allocated independently.

Materials may carry the glTF material extensions `KHR_materials_transmission`, `KHR_materials_ior`, `KHR_materials_clearcoat`, `KHR_materials_sheen`, `KHR_materials_diffuse_transmission`, `KHR_materials_volume` and `KHR_materials_volume_scatter` (draft), listed in the manifest's `extensionsUsed`, never `extensionsRequired`, so a reader that ignores them still draws the base PBR material. `@margoengine/blender/pbr-ext` draws them.

## PBR vertices: 20 Float32 values, 80 bytes (flags `0`)

| Float offsets | Meaning |
| --- | --- |
| 0..3 | Position xyz, w = 1 |
| 4..7 | Unit normal xyz, w = 0 |
| 8..11 | Unit tangent xyz, handedness ±1; w = 0 means derivative tangent frame |
| 12..15 | UV0 xy, UV1 xy |
| 16..19 | Linear vertex color RGBA, each in [0,1] |

All values must be finite. Each primitive has 3..1,000,000 vertices and triangle indices within its vertex count. Unit-vector tolerance is 0.001. Positions/UVs use the existing glTF Pro shader layout. Blender Z-up coordinates become `(x,z,-y)` in meters; UV V is inverted for top-down images and tangent handedness follows Blender's glTF exporter. Color/emissive textures use sRGB; normal and metallic-roughness textures use linear channels.

## Compact vertices: 6 Float32 values, 24 bytes (flags `1`)

| Float offsets | Meaning |
| --- | --- |
| 0..2 | Position xyz |
| 3..5 | Unit normal xyz |

Meshes without UVs, tangents or vertex colors use this layout. Positions and normals have the same finite-value, unit-vector and vertex/index limits as PBR vertices. The writer accepts `stride: 24` on a primitive and encodes it as a vertex-section flag, omitting it from the manifest. Omitted stride defaults to `80`.

The reader expands each shared compact geometry once into the existing PBR renderer layout: position w = 1, normal w = 0, zero tangents/UVs and white vertex color. PBR vertices and uint32 indices remain typed-array views of the input. Aggregate decoded geometry, including expanded vertices and indices, is bounded at 256 MiB before allocation. GPU uploads copy bytes. Unknown versions, default strides and layout flags fail explicitly; this file is not a dump of the engine's Wasm memory or device-specific uniforms.

## Components (`margo:` tags)

Object custom properties whose names start with `margo:` are kept in `extras.margo.properties` (strings, booleans, finite numbers, and arrays of up to 32 finite numbers). `@margoengine/blender/components` reads the tags its README lists (`margo:collider`, `margo:body`, `margo:light`, `margo:script` and their settings) and writes them into the decoded document as KHR_implicit_shapes, KHR_physics_rigid_bodies and KHR_lights_punctual; the file itself holds only the properties, so the format does not change and older readers keep them as data. The exporter writes these tags itself for Blender lights and cameras (mesh-less nodes; a camera also has `margo:camera`, `margo:yfov` or `margo:ymag`, `margo:aspect`, `margo:znear`, `margo:zfar` and, for the scene camera, `margo:active`), which the components entry turns into KHR_lights_punctual lights and glTF cameras.

## Animated files (header flag `1`)

An exported scene with an Armature modifier or shape keys sets header flag `1` and adds one type-5 section. The static reader (`decodeMargo`, `parseMargo`, `loadMargo`) refuses such a file by name; `@margoengine/blender/anim` reads both kinds. In an animated file the manifest may also hold, with glTF 2.0 meaning:

- `bufferViews[i]`: `{section, byteOffset, byteLength}` with `section` the type-5 section ID and `byteOffset` relative to it. Views lie inside the section.
- `accessors`, `skins` and `animations`, referring to those views. Joints are UNSIGNED_SHORT VEC4, weights FLOAT VEC4 normalised to sum 1, inverse bind matrices FLOAT MAT4, keyframe times FLOAT SCALAR in seconds from the clip's first frame with min and max, morph deltas FLOAT VEC3 with min and max.
- primitive `attributes` with only `JOINTS_0`, `WEIGHTS_0`, `JOINTS_1` and `WEIGHTS_1` (up to eight influences), and `targets` with `POSITION` (and optional `NORMAL`) accessors. Vertices and indices stay in type-2 and type-3 sections.
- mesh `weights` (the shape-key values at export) and `extras.targetNames` (the shape-key names).
- nodes with `children` and `skin`: each armature becomes a node at its world transform with one child node per bone, in the bone hierarchy. A joint's TRS is the pose shown at export; the inverse bind matrices hold the rest pose. A skinned mesh's node is the identity, as glTF ignores it.

Each action becomes one clip named after it: the armature's active action and its NLA strips' actions, and the shape keys' actions, sampled at every frame of the action's range with LINEAR interpolation (rotations as continuous quaternions). A clip starts from the pose shown at export, so a bone or key the action does not key keeps that pose; channels equal to it throughout are omitted. Object-level animation, constraints' targets outside the armature and drivers are baked into the bone samples only.

`margoToGLTF(bytes)` turns either kind into a glTF 2.0 document whose single buffer is the file: type-2 sections become interleaved bufferViews (stride 80: POSITION 0, NORMAL 16, TANGENT 32 when no tangent has w = 0, TEXCOORD_0 48, TEXCOORD_1 56, COLOR_0 64; stride 24: POSITION 0, NORMAL 12), type-3 sections index accessors, type-4 sections images, and the manifest's views move by their section's file offset.

## Curves, points and volumes (header flag `2`)

With "Curves, points and volumes" on (`export_scene(..., curves=True)`), visible curves objects (legacy curves, hair curves and curves made by geometry nodes, read from the object's evaluated geometry), point clouds and volumes are written as data, header flag `2`. The static and animation readers refuse such a file by name; `@margoengine/blender/curves` reads it, and its meshes as `decodeMargo` does. A file holds either animation (flag `1`) or shapes (flag `2`), never both. Two more section types are allowed, both with zero flags:

| Type | Content |
| --- | --- |
| 6 | Shape data: little-endian Float32 values, viewed by the manifest's `curves` and `pointClouds` |
| 7 | One volume's grids as an OpenVDB file, as Blender's `VolumeGrids.save` writes it |

The manifest adds three arrays, and a node points at one entry with `curves`, `points` or `volume` (an index):

- `curves[i]`: `{section, count, splines, attributes}`. `count` is the curves object's control points; `splines[j]` is `{type, points, cyclic, resolution}` with `type` `catmullRom`, `poly`, `bezier` or `nurbs` and, for NURBS, `order` (2..64) and `knots` (`normal`, `endpoint`, `bezier` or `endpointBezier`). The splines' points follow each other, in order, and sum to `count`.
- `pointClouds[i]`: `{section, count, attributes}`.
- `attributes` maps a name to `{byteOffset, components}` in the type-6 `section`, `count` values of `components` floats each: `position` (3, required), `handleLeft`, `handleRight` (3, Bezier, required for a Bezier spline), `handleTypeLeft`, `handleTypeRight` (1, Blender's enum: 0 free, 1 auto, 2 vector, 3 aligned), `radius` (1, metres), `tilt` (1, radians), `weight` (1, NURBS) and, for a point cloud, `color` (4, linear RGBA of its first colour attribute). An attribute Blender does not hold is left out. Positions, handles and radii are in the object's space in Y-up metres, as mesh vertices are, and the node's TRS places them.
- `volumes[i]`: `{section, grids}`: the type-7 section and the grid names. OpenVDB keeps Blender's Z-up object space, so a volume's node TRS is the unit scale times the Z-up to Y-up turn times the object's world matrix.

## KTX2 textures

A static file may hold its textures as KTX 2.0 files with Basis Universal data instead of PNG: `images[i]` is then `{section, mimeType: "image/ktx2"}` with a type-8 `section`. The identifier is checked, each texture is 2D (one layer, one face) and 1..4096 pixels a side, and the decoded budget counts it as RGBA8. `compressMargo` in `@margoengine/blender/ktx2` writes such a file from an exported one (colour slots as sRGB, normal maps as normal maps, other data as linear); `decodeMargo` refuses it by name, and `parseMargoKTX2` transcodes it on the device.
