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
  - Bit-length Mk. 2 and JT 10's packets were left for real files (see "Real JT 9.5 meshes" below).
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

## Real JT 9.5 meshes (2026-10-18)

JT2Go's samples (read in place, never copied): conrod, HandMixer, san2, sextant and Radial_Engine_assm, all literal
JT 9.5. Every tri-strip shape failed before; now every one decodes with all of its stored hashes (topology, vertex
coordinates, normals) matching. What real files do that the text and our test writer did not:

- Shape segments (type 6) are not compressed: they start with the element length, with no compression header. Only
  1-4, 17, 18, 20 and 24 take one (the extracted table's "ZLIB Applied?" column is shifted by a row).
- Mk. 2 packets give the code text as its bit length followed by ceil(bits / 32) words, with no word count.
- Bit-length Mk. 2 (read from the bits, no text defines it fully): a tag bit, then fixed width (0): U{6} bit counts
  of the minimum and maximum, the two values (signed), then each value less the minimum in bitsize(max - min) bits; or
  variable width (1): I32 mean, U{3} width-change bits and U{3} run-length bits (4 and 4), then blocks of signed width
  changes (repeated at either end of their range), a run length and the run's values less the mean, signed.
- `hash32` folds the length in as a word count (Jenkins' `hash2`), not bytes, in every hash the files store.

Checks: each decoded mesh matches the bounding box and surface area its shape node stores in the LSG (worst 0.0002%
of the box size and 0.03% of the area, over all 237 shapes); Radial_Engine's meshes match its own XT B-reps' bounds to
within 0.15 mm and their volumes to within 1% on 20 of its 24 parts (the other four are below, under Radial_Engine's
blends). Triangles stored with normals agree in winding with them on 97.9 to 100% of each file's triangles (at most 1%
disagree; the rest have zero area). Parse times include decoding every mesh, on this PC.

| File | Shapes decoded | Triangles | Parse (ms) |
| --- | --- | --- | --- |
| conrod | 9 / 9 | 15,586 | 37 |
| HandMixer | 33 / 33 | 312,254 | 331 |
| san2 | 106 / 106 | 129,067 | 161 |
| sextant | 58 / 58 | 36,205 | 47 |
| Radial_Engine_assm | 31 / 31 | 94,014 | 316 |

Open surfaces stay open (conrod's rod axis is a cylinder side without caps), so edges with one triangle, counted by
position, are not by themselves a defect.

## Next

- MultiXT segments (type 30) and subordinate XT elements; JT 10 Int32 packets for tessellated shapes.
- JT 10 packets; polygon sets and polylines; colours and texture coordinates if wanted.
- JT B-rep, wireframe and ULP segments, coded with Int32 Mk. 1 packets (bit-length and two-table arithmetic): that
  decoder was written in c91ebc0 and removed unused; bring it back with the first of those segments.
