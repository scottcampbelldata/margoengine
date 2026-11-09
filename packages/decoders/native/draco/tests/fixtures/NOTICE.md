# Development Draco fixtures

These fixtures are test inputs and oracle outputs for an unshipped development
crate. They are never package runtime assets. No codec implementation is present.

`established.bin` contains 281 cases: 275 crafted/established syntax and attribute
specimens (including the existing Margo NormalizedTriangle) and six unmodified
Google standard inputs listed below. Original emitters and exact oracle
input/output records are retained in the maintainer-only batch 133 cache; inferred rules and their
SHA-256 records are in `docs/clean-room.md`. Margo specimens use this repository's
Apache-2.0 licence. The recorded prebuilt decoder was only executed outside this
worktree through public APIs; neither its implementation nor its wrapper was read.

`connectivity.bin` contains 305 unmodified connectivity prefixes (304 version 2.2
standard meshes and one historical cube), each terminated with a zero attribute
group count, reference indices, and 425 Margo-made topology/seam cases. All 730
cases match exact native/Wasm ordered points and indices, including every former
capped-fan failure. This is development evidence, not a shipped replacement claim. It does not contain
codec source. The pinned source URLs, bufferView mappings, hashes and source-grant
URLs for the original external assets are in
`docs/whitepaper/results/batch-133-corpus-manifest.json`. Original compressed
streams, complete glTF/GLB buffer inputs and grants remain in the private corpus.

Khronos glTF-Sample-Assets revision
`8f492390ddc7a2ae221a1369ef560589cf8c70fb`, per-model README grants:

- ABeautifulGame: ASWF/MaterialX Project (2020) and Ed Mackey (2022), CC BY 4.0.
- Avocado, BarramundiFish, BoomBox and WaterBottle: Microsoft (2017), CC0 1.0.
- Corset: UX3D/Microsoft (2017), CC0 1.0.
- Box, CesiumMan, CesiumMilkTruck, RiggedFigure and RiggedSimple: Cesium (2017),
  CC BY 4.0. Cesium marks retain their separately recorded mark restrictions.
- Lantern: Microsoft (2017) and Frank Galligan (2018), CC0 1.0.
- MorphPrimitivesTest: ft-lab (2018) and Frank Galligan (2020), CC BY 4.0.
- CarConcept and SunglassesKhronos: Darmstadt Graphics Group GmbH, Eric Chadwick
  (2024), CC BY 4.0. Khronos marks retain their separately recorded restrictions.
- Duck: Sony (2006), SCEA Shared Source License 1.0.
- BrainStem: Smith Micro Software, Keith Hunter (2017), Poser EULA. Its restricted
  content grant is retained privately; do not publish this fixture as a generally
  redistributable model.
- VirtualCity: 3DRT (2017), 3DRT License for Testing. Use only for glTF tool testing;
  its download does not grant rights to republish it as a general model.

CesiumGS/cesium revision `fae001dee63d9fb5bd88eef4162f7e765406ec19` supplies the
independent BoxVertexColorsDracoRGB, BoxWithTangents and unitSquare11x11_draco
standard assets. Copyright 2011-2026 CesiumJS Contributors, Apache-2.0, with the
repository licence retained in the private grant cache.

Google Draco revision `d429de84b52a860705507da0884764c5d8321423` supplies standard
cube, nonmanifold, metadata and point-cloud `.drc` test assets under Apache-2.0,
Copyright The Draco Authors. No Stanford bunny asset or implementation source was
downloaded into this corpus. The external point/historical files are measurement
targets, not yet proof of complete support in this development decoder.

The six full standard inputs are cube_att.drc, cube_pc.drc,
cube_att.obj.edgebreaker.cl10.2.2.drc, test_nm.obj.edgebreaker.0.9.1.drc,
test_nm.obj.edgebreaker.0.10.0.drc and test_nm_quant.0.9.0.drc from that pinned
Google testdata revision, under the same Apache-2.0 grant. Their compressed bytes
and public-API output are test-only; no implementation or wrapper is included.

`kd.bin` contains 369 complete KD cases: 368 Margo-crafted inputs with public-API
oracle outputs and the unmodified `pc_kd_color.drc` standard input from the same
pinned Google testdata revision under Apache-2.0. No implementation is included.

`beautiful-game-first.drc` and `beautiful-game-largest.drc` are unmodified bufferViews
from the ABeautifulGame GLB credited above (CC BY 4.0, ASWF/MaterialX and Ed Mackey).
`memory.json` records the pinned source URL, bufferView, source/extract SHA-256 and
oracle-derived output hash for each. They are memory/correctness regression data
only and never runtime assets. No geometry is modified or attributed to Margo.

`multi.bin` contains 289 Margo-crafted complete files and opaque public-API
outputs: 247 multi-parallelogram discovery/held-out cases and 42 independent
prediction-degree/depth-first traversal canaries. Historical framing is emitted
explicitly, rather than inferred from version-byte changes. `metadata.bin` has
41 Margo-crafted complete files with exact oracle-derived geometry bytes and
the metadata declared by the fixture emitter. `metadata-long.drc` is the crafted
1,024-byte name regression. These fixtures contain no outside implementation.

`flavor.bin` contains 214 Margo-crafted complete inputs with independent opaque
full and glTF output bytes. Sixty discovery controls distinguish no prediction,
difference, single and multi-parallelogram behavior. The remaining accepted
inputs are held-out cases from the existing `multi.bin` campaign. Only the glTF
build falls back from multi-parallelogram to difference prediction; both outputs
are retained. No codec implementation or wrapper source was inspected.

`predictive.bin` retains 2,160 complete Margo-crafted predictive EdgeBreaker
streams and full-build public-API output bytes. The six versions have explicitly
emitted historical framing, 5,130 successful prediction bits (558 C predictions),
transmitted fallbacks, split merges and disconnected components. Input creation
uses the published connectivity rules and the recorded crafted-input inference;
no implementation source, wrapper text or disassembly was read or copied. These
fixtures are Margo-authored syntax and oracle output, not outside source files.
