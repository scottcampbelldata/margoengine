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
| 20 | Flags, always `0` |
| 24 | Default vertex stride, `80`; a type-2 section's CAD layout flag overrides it to `24` |
| 28..60 | Reserved, always `0` |

## Section table

Immediately after the header, each section has four uint32 fields: `type`, `offset`, `byteLength`, `flags`. These section headers describe the mesh buffers referenced by each primitive. Type-2 flags select the vertex layout; type-3 flags select the index format. Other section types require zero flags. Unknown values and combined index flags are rejected. Payloads follow the table in table order. Each offset must equal the padded end of the previous payload (or table for the first). Overlapping sections, unknown types, gaps and trailing data are rejected. Shared resources reference the same section ID rather than overlapping table entries. CAD/PBR vertices and uint16/uint32 indices may coexist in one file. Existing v1 files use zero flags and retain their original layouts; older readers reject the new flags explicitly.

| Type | Content |
| --- | --- |
| 1 | UTF-8 JSON manifest; only section 0; maximum 1 MiB |
| 2 | Packed vertices; nonzero multiple of 80 bytes (flags `0`) or 24 bytes (flags `1`) |
| 3 | Triangle indices; nonzero multiple of 6 bytes (UINT16) or 12 bytes (UINT32) |
| 4 | Embedded RGBA8, non-interlaced PNG |

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

## PBR vertices: 20 Float32 values, 80 bytes (flags `0`)

| Float offsets | Meaning |
| --- | --- |
| 0..3 | Position xyz, w = 1 |
| 4..7 | Unit normal xyz, w = 0 |
| 8..11 | Unit tangent xyz, handedness ±1; w = 0 means derivative tangent frame |
| 12..15 | UV0 xy, UV1 xy |
| 16..19 | Linear vertex color RGBA, each in [0,1] |

All values must be finite. Each primitive has 3..1,000,000 vertices and triangle indices within its vertex count. Unit-vector tolerance is 0.001. Positions/UVs use the existing glTF Pro shader layout. Blender Z-up coordinates become `(x,z,-y)` in meters; UV V is inverted for top-down images and tangent handedness follows Blender's glTF exporter. Color/emissive textures use sRGB; normal and metallic-roughness textures use linear channels.

## CAD vertices: 6 Float32 values, 24 bytes (flags `1`)

| Float offsets | Meaning |
| --- | --- |
| 0..2 | Position xyz |
| 3..5 | Unit normal xyz |

Meshes without UVs, tangents or vertex colors use this layout. Positions and normals have the same finite-value, unit-vector and vertex/index limits as PBR vertices. The writer accepts `stride: 24` on a primitive and encodes it as a vertex-section flag, omitting it from the manifest. Omitted stride defaults to `80`.

The reader expands each shared CAD geometry once into the existing PBR renderer layout: position w = 1, normal w = 0, zero tangents/UVs and white vertex color. PBR vertices and uint32 indices remain typed-array views of the input. Aggregate decoded geometry, including expanded vertices and indices, is bounded at 256 MiB before allocation. GPU uploads copy bytes. Unknown versions, default strides and layout flags fail explicitly; this file is not a dump of the engine's Wasm memory or device-specific uniforms.
