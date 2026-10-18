# JT reader: status and next stage

Licensing and the notice it must carry: `docs/jt-licensing.md`. Code: `packages/brep/src/jt`. Specification copies
(JT File Format Reference 9.5 Rev-A, JT 10 / ISO 14306 text) stay outside the repository.

## Stage J1 (done, 2026-10-18)

- `parseJT(bytes)`: JT 9.5 and later; older files throw a RangeError (the patent grant covers 9.5 and later, and 8.x
  lays elements out differently).
- Container: header (version string, byte order, TOC offset: I32 in 9.x, U64 in 10), TOC (28-byte entries in 9.x,
  32 in 10), segment headers checked against the TOC, whole-segment zlib (JT 9, flag 2) and LZMA (JT 10, flag 3; the
  "alone" header or the 5-byte one) for segment types 1, 2, 3, 4, 6, 17, 18, 20, 24.
- LSG: version fields I16 in 9.x and U8 in 10; base attribute data has an extra U32 (field final flags) in 10.
  Partitions, groups, instances, parts, meta-data, LOD (finest alternative taken), range LOD, switch (selected child),
  all shape node types, transforms (row-major for row vectors, which is column-major for column vectors), materials
  (diffuse colour), and unknown elements read through their base type. Property atoms (string, integer, float,
  object reference, date, late-loaded, vector4) and the property table. Names from `JT_PROP_NAME` ("name;version:"),
  units from `JT_PROP_MEASUREMENT_UNITS` (millimetres assumed, with a warning, when absent).
- XT B-rep segments (type 17): JT 9.5 layout read exactly (version, Parasolid version, length, neutral binary data);
  JT 10's element has extra fields whose layout the extracted text garbles, so the data is found by its length field
  followed by Parasolid's own start bytes. The data goes through `xtToSTEP` and the STEP structure reader.
- Tests (`tests/jt.test.js`, a small writer in `tests/jt-writer.js`): JT 9.5 little- and big-endian, JT 10 with four
  LZMA variants made by Python's lzma module, malformed files. No real JT file has been read yet.

## Stage J2 (written 2026-10-18; checked only on files our test writer makes)

- `src/jt/codec.ts`: Int32 Compressed Data Packets Mk. 1 and Mk. 2 (layouts confirmed from the 9.5 PDF's figures; the
  text extraction loses branches):
  - Mk. 1 (Figure 218): U8 codec; arithmetic: probability contexts, I32 out-of-band count, a nested packet when it is
    above 0; codec not null: I32 code-text bits, I32 value count, I32 symbol count when there are two context tables;
    then VecU32 code text in every case.
  - Contexts (Figure 219): U8 table count; per table U32{32} entry count, then U32{6} symbol bits, occurrence bits,
    (first table only: value bits), next-context bits, (first table only: U32{32} minimum value); entries; one
    alignment to a byte after all tables. Symbols are stored plus 2 (escape = -2).
  - Mk. 2 (Figure 221): I32 value count; U8 codec; chopper: U8 chop bits (0 means a complete nested packet follows),
    I32 bias, U8 span bits, MSB packet, LSB packet; others: I32 code-text bits, VecU32 code text, then for arithmetic
    the Mk. 2 contexts and the out-of-band packet.
  - Bit-length Mk. 1 (Appendix C 2.1), arithmetic (Appendix C 3.2), residual predictors (Appendix C 1.3), the lookup
    hash (Appendix D; `hash32` is the hash of the words' little-endian bytes, as the appendix says).
  - Not yet: bit-length Mk. 2 (the JT 10 text calls `nibblerGet`, which it never defines, and gives its block width as
    4 bits in code and 3 in a comment) and JT 10's packets (escape flag per entry, move-to-front). Both throw a
    RangeError that names them; settle them on real files, using the stored hashes to confirm a reading.
- `src/jt/mesh.ts`: Tri-Strip Set Shape LOD elements of JT 9: the 22 topology fields with their composite hash, the
  Appendix E decoder (dual vertices are polygons, dual faces mesh vertices; split faces; per-corner attribute masks
  map vertex records to corners), coordinates (quantized codes or float bits, hash checked), normals (Deering codes
  or float bits, hash checked), cover polygons dropped, winding made to agree with the stored normals.
- `parseJT` decodes each tri-strip shape's finest LOD into `JTShape.mesh` (option `meshes: false` skips it).
- Tests: a closed tetrahedron written as the coder would (null-coded packets, one arithmetic-coded array with an
  escape), one vertex record per corner and per triangle, both byte orders; checksums written by a separate byte-wise
  hash, so a wrong word-wise hash fails the read.

## First real files (2026-10-18)

Codex's step-10 samples (NIST models, US public domain, mirrored by Innerscene; in the ignored corpus, never committed):

- NIST MTC CRADA assembly, literal JT 10.5 (DM 9.8): structure reads in about 140 ms: 179 nodes, 13 parts, 41
  instances, millimetres, part names from the instance nodes. Its segments are XZ containers of LZMA2 (not bare LZMA),
  now decoded. The JT 10 XT B-rep element is: U8 version, U8 subordinate flag, I32 Parasolid major/minor/build, one
  more byte, I32 data length, the Parasolid neutral binary (V33, SCH_3300171_32001_13006), then body identifiers and
  attributes. Seven parts read their exact B-rep and mesh with 0 failed faces and 0 open edges in about 0.6 s; volumes
  match the same assembly's STEP file (hex nut 102.5 / 102.4 mm3, flat-head screw 141.0 / 141.0, window 17,045 /
  17,054; cover and plate within about 1%, a revision apart). Two Parasolid reader bugs this exposed are fixed.
- The box part's element is subordinate (23 bytes): its B-rep sits in the assembly's MultiXT segment (type 30) and
  is not read yet. Its tessellated shapes (JT 10 packets) are not decoded yet either.
- The two NIST parts (socket head cap screw, CTC 02) are literal JT 9.4: the reader refuses them (the patent notice
  covers 9.5 and later; for counsel, docs/jt-licensing.md).

## Next

- MultiXT segments (type 30) and subordinate XT elements; JT 10 Int32 packets for tessellated shapes.
- A literal JT 9.5 file and a tessellation-only file to check the JT 9 mesh decoder on (JT2Go's samples).
- JT 10 packets and bit-length Mk. 2; polygon sets and polylines; colours and texture coordinates if wanted.
- JT B-rep, wireframe and ULP segments, coded with Int32 Mk. 1 packets (bit-length and two-table arithmetic): that
  decoder was written in 3bb8099 and removed unused; bring it back with the first of those segments.
