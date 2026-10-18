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

## Stage J2 (next, needs real files)

Decode shape LOD segments (tri-strip sets) so tessellation-only JT files draw.

- Int32 Compressed Data Packets. Layouts confirmed from the 9.5 PDF's figures (the text extraction loses branches):
  - Mk. 1 (Figure 218): U8 codec; arithmetic: probability contexts, I32 out-of-band count, a nested packet when it is
    above 0; codec not null: I32 code-text bits, I32 value count, I32 symbol count when there are two context tables;
    then VecU32 code text in every case.
  - Contexts (Figure 219): U8 table count; per table U32{32} entry count, then U32{6} symbol bits, occurrence bits,
    (first table only: value bits), next-context bits, (first table only: U32{32} minimum value); entries; one
    alignment to a byte after all tables. Symbols are stored plus 2 (escape = -2).
  - Mk. 2 (Figure 221): I32 value count; U8 codec; chopper: U8 chop bits (0 means a complete nested packet follows),
    I32 bias, U8 span bits, MSB packet, LSB packet; others: I32 code-text bits, VecU32 code text, then for arithmetic
    the Mk. 2 contexts and the out-of-band packet.
  - Decoders: bit-length (Appendix C 2.1), arithmetic (Appendix C 3.2, a 16-bit range coder with underflow bits),
    residual predictors (Appendix C 1.3). JT 10's packets differ again (escape flag per context entry, a move-to-front
    codec) and its bit-length coder calls `nibblerGet`, which the text never defines; its block field width reads as
    4 bits in the code and 3 in the comment. Settle both on real files.
- Topologically compressed tri-strip data (9.5 section 7.2.2.1.2.4, Appendix E polygon mesh topology coder), vertex
  coordinate, normal (Deering, Appendix C 4) and colour arrays, quantization.
- Validate against real files: JT version string, segment types in the TOC, part and instance counts, names, and
  meshes against the XT B-rep of the same part where both exist.
