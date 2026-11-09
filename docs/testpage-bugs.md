# Test-page bug review

Implementation is preserved in separate local commits and rebased onto origin/main
269da2b90. Final verify, GPU package suites, README execution and push remain pending.

Source: the read-only, untracked test-page log in the main checkout. Reviewed on
2026-11-09 against origin/main b9985bd07. Road entries 1, 2 and 6 are included by
the brief's final Added section. No test-page source files are changed here.

| Entry | Result | Reproduction and owning test |
| --- | --- | --- |
| 1 | FIXED on main b9985bd07; exact input now covered | The three-point closed Catmull-Rom loop at segments 128 already has bit-identical terminal positions/normals. `packages/road/test/testpage.test.js` retains that exact input, also after local fold prevention. |
| 2 | FIXED diagnostic; vertical rejection is intentional | Exact [[0,0,0],[0,20,0],[0,40,0]] input now gives linked code unsupported. A 200:1 nonvertical ramp works. `packages/road/test/testpage.test.js`. |
| 3 | FIXED on main before this review | Optional bankedRoad already supports varying banking; `packages/road/test/banking.test.js`. |
| 4 | NOT A BUG | Core Geometry/PbrMaterial are documented constant-colour, triangle-only interfaces. Road returns separate UV data for optional textured renderers/exporters; adding texture channels to core would violate its boundary. `packages/road/test/road.test.js` checks the returned UVs. |
| 5 | FIXED on main before this review | Optional junctions unions footprints; `packages/road/test/junctions.test.js` and `junction-bends.test.js`. |
| 6 | FIXED local focal folds | Inside offsets compress before either triangle reverses, including curbs, mirrored turns and grades. Chord bisectors keep both sampled spans forward, including the narrow three-point closed loop. `packages/road/test/testpage.test.js` checks every face against its normals. `junction-bends.test.js` retains global-overlap repair assertions. |
| 7 | FIXED | The island box [1.8,2.8,1.8] minus offset sphere previously hit the fixed cube. Analytic tree bounds plus margin now enclose it. Translated/union/intersection/empty and explicit-bound controls: `packages/procedural/test/testpage-sdf.test.js`. |
| 8 | FIXED | SDF output previously lacked normals. The existing Rust contour entry now emits analytic outward gradients at the returned vertices. Sphere and cavity normals, ownership and direct Geometry construction: `testpage-sdf.test.js`. |
| 9 | FIXED; real native-backend GPU proof passes | Native preview previously refused every bake. A lazy fragment implementation uses the source canvas context for all five patterns, with shared validation and native WebGLTexture output. `packages/procedural/test/textures-browser.mjs` compares both backends within one RGBA8 channel step and checks state, abort, loss, restoration and disposal. |
| 10 | FIXED | Cabin previously mixed scalar floor with geometry fields. It now returns floorElevation plus an iterable parts object; all tracked consumers migrate together. `packages/procedural/test/testpage-assets.test.js` constructs every part as Geometry; existing sandbox geometry tests remain. |
| 11 | FIXED diagnostic; clamping is NOT A BUG | Exact amplitude 5, wavelength 20, steepness .8 input must reject rather than silently alter authored waves. Constructor and setWaveHeight now carry code failed and a help link; README gives the exact per-train bound. `packages/water/test/testpage.test.js` checks both paths and unchanged input. |
| 12 | FIXED under Scott's 2026-11-10 exception | Three empty arrays now construct valid zero-bounds Geometry. It owns no renderer buffers/batch and works through erase/refill, shared instances, culling, picking, shadows and disposal. `packages/core/tests/empty.test.js`, `empty.browser.mjs` and `packages/voxel-edit/tests/testpage-contracts.test.js`. Partial inputs still reject. |
| 13 | FIXED | Fourth solve argument previously ignored a pre-aborted signal. It now preserves the reason before mutation and checks propagation/observation. This synchronous API cannot service main-thread events; the existing /worker entry already provides active cancellation and SIMD solving. `packages/wfc/test/testpage.test.js`, existing worker transport/browser tests. |
| 14 | FIXED | push now returns an owned VoxelGrid, matching undo/redo/go/current. Labels remain available through history.label and labelled snapshots through entries(). `packages/voxel-edit/tests/testpage-contracts.test.js`; README and API migrate together. |
| 15 | Separate job | Assigned by the Added section to codex-preview-silent-skip-brief.md. No selection outline/backend change here; selection picking only changes for empty Geometry integration. |
| 16 | FIXED | Ordered ancestor chains now accept intermediate bones. The existing world-space endpoint solve carries their unchanged local transforms. Actual downloaded Khronos RiggedFigure 3/4/6 retains joint 5 and reaches its target; disconnected/reversed chains give linked unsupported before installation. `packages/animator/test/testpage.test.js`. Exact RobotExpressive 55/57/3 remains rejected because it is disconnected. |
| 17 | Separate job | Assigned by the Added section to codex-preview-silent-skip-brief.md. No gltf-pro implementation change here. The actual native-preview rejection is covered incidentally by the character contract tests. |
| 18 | FIXED | Morph errors list candidate mesh node indices/counts with a help link, and setMorph(name, weight) resolves targetNames across every matching mesh node atomically. Actual Khronos MorphStressTest and RobotExpressive inputs: `packages/animation/tests/testpage.test.js`. The indexed overload remains supported. |
| 19 | FIXED documentation | Actual RiggedFigure has no animation name; its existing synthesized name is Animation 0. README now states Animation <zero-based index>, preservation of explicit empty strings, and index-based play. `packages/animation/tests/testpage.test.js` checks actual asset playback and explicit empty names. |

The Added floating-crown issue was page misuse: a broadleaf canopy is elevated
above a rooted trunk. The README now renders both parts. Optional
`@margoengine/procedural/tree` provides createTree(engine,
kind, options) to create both child meshes under one positioned root, with a
single disposer. `testpage-assets.test.js` proves both kinds, every detail,
parenting, world placement, movement and resource removal.

No global road intersection topology is inferred: separate crossing/return legs
may overlap even when every local triangle is outward. Existing repair/junction
entries resolve planar footprints; they do not promise a 3D civil-road designer.
Core changes only under Scott's explicit empty-Geometry exception; stage and physics stay untouched. No package can hold that fix because every producer/app otherwise needs an empty special case, and erasing an editor model throws. Generated geometry remains
bounded by the existing generator limits. CPU/GPU results, quality gate evidence
and final commit are recorded below after validation.

Texture GPU proof passes on both native backends: 88,830 oracle channel checks,
maximum error one RGBA8 step, five WebGL2 patterns and no page errors. A prior
harness hung restoring the lost GL context from the loss-event dispatch. It now
waits for the next task, and event waits have a 10 s hard limit; loss and actual
restoration both pass. Core + stage currently measures 23,837 B gzip, below the
unchanged 25,000 B gate. SDF entry: 1,856 B gzip; sdf.wasm: 40,798 B raw / 17,310 B
gzip. Textures joined entry (including lazy fragment code): 5,030 B gzip; complete
tree helper: 3,144 B gzip. These are size measurements, with no speed claim.

## Follow-up entries discovered before handoff

The live, read-only log expanded through entry 31 during this session, including
reordered/duplicated page sections. Entries 20-31 still need exact reproductions
and disposition from the latest source: environment disposal/reattach (20),
PostStack preview (21), directional shadows preview (22), Materials.set without
predefined buffers (23), mask-transition name collisions (24), transition
removal (25), video preview (26), forced compatibility installation docs (27),
explicit fallback configuration (28), VFX preview (29), splats preview (30), and
pixel/lighting2d preview (31). Check the separate whole-class preview brief before
editing overlapping code. Their listing here is not a defect finding or waiver.

## Local bug commits before gates

Each implementation was committed before resuming gates: 1 `441e94276`,
2 `f8ec42559`, 6 `fc29ef757`, 7 `e161c8b1a`, 8 `bf538cf01`,
9 `71ef97171`, 10 `a4df18805`, floating crowns `529a10616`,
11 `09d835599`, 12 `ef5247d1e`, 13 `6a4f24a76`, 14 `9b6f1d665`,
16 `6b064b64b`, 18 `4bfd3ed76`, 19 `43aa7b861`. These IDs precede
any later rebase; the commit subjects retain the entry numbers. API regeneration
after rebuilding procedural, sciviz and staging reports 886 entries/8,634 exports
with no unrelated snapshot changes. The final procedural suite passes 101 tests.
The latest Added section assigns 20, 23, 24 and 25 after this batch lands;
21, 22 and 26-31 belong to lane S. Physics remains on hold.
