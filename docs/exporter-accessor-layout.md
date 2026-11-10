# Sparse and interleaved GLB writing

The optional `@margoengine/exporters/sparse` entry exposes `exportSparseGLB` for
ordinary engine/data-scene sources and `layoutGLB` for an existing GLB. The latter
returns the file and deterministic work/storage counts. Both preserve accessor
indices, types, normalized flags, min/max bounds and logical values. Original
arrays and input file bytes remain unchanged.

Defaults: `sparse: 'all'`, `interleave: true`, maxBytes 4,294,967,295 and no signal.
`sparse: 'morphs'` restricts conversion to morph targets; false disables it.
Sparse replacement tables are written only when nonzero rows plus index bytes,
padding and a 200-byte metadata allowance cost less than dense data. Completely
zero accessors need no buffer view. Negative zero is stored explicitly. Sparse
indices are ascending, using the narrowest allowed unsigned type. Matrix columns
retain the specification's padding, including byte MAT3. Existing sparse tables
and compression-owned accessors remain intact.

Dense attributes used by one primitive share interleaved streams grouped by
count. Every attribute offset and stream stride is four-byte aligned, and
streams split at 252 bytes. Shared accessors are placed once; every consumer
continues to address the same accessor. Normalized integer storage is retained
without a float conversion. Morph and animation accessors are not interleaved
unless they also serve as vertex attributes. Matrix accessors remain separate.
Images and extension buffer-view references follow the existing packer's
relocation rules. No semantic or index-order optimization is included.

Layout changes can increase bytes when interleaving introduces padding; there is
no claim that every file becomes smaller. Sparse storage targets many-zero data,
particularly morph deltas. The wrapper's maxBytes applies to final output;
maxBinaryBytes retains the ordinary writer's dense-build allocation limit.
AbortSignal is checked before writing and between accessors/streams. This is
CPU work and never holds the GPU lock.

Research compared storage rules, sparse conversion behavior and memory-layout
motivation. No rival source or paper companion implementation was read:

- Khronos Group, *glTF 2.0 Specification*, 2017 (current clarifications),
  https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html. Sparse substitutions,
  little-endian values, padded matrices and four-byte vertex alignment determine
  the binary writer. Buffer-view byteStride is restricted to 4..252 bytes.
- Khronos Group, *KHR_mesh_quantization*, 2019,
  https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_mesh_quantization/README.md.
  Integer attributes must retain their types, normalized flag and aligned rows;
  they are not expanded to float attributes just for interleaving.
- Don McCurdy, *glTF Transform sparse documentation*, accessed 2026-11-10,
  https://gltf-transform.dev/modules/functions/functions/sparse. Compared
  zero-heavy-accessor and morph-target behavior. This pass chooses by storage
  work/bytes rather than a timing or visual tolerance.
- Hugues Hoppe, *Optimization of Mesh Locality for Transparent Vertex Caching*,
  SIGGRAPH 1999, https://www.hhoppe.com/proj/tvc/. Compared the memory-transfer
  motivation; face reordering is outside this job and no speed result is claimed.

`packages/exporters/tests/sparse-entry.test.js` checks all accessor values before
and after conversion, the existing licensed Khronos Box fixture, Khronos
validator output, sparse morph byte reduction, index widths, implicit zeros,
negative zero, matrix padding, normalized byte attributes, shared streams and
compression retention. New entry size 20,845 B gzip, ceiling 21,471 B; it includes
the existing writer and reader so the direct data-scene API does not require a
manual intermediate export. Core and stage sources are unchanged.
