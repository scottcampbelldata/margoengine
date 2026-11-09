# Test-page bug review

Implementation is preserved in separate commits and rebased onto origin/main
31bd81d60. Corrective verify and all remaining GPU/README gates pass. No
next-batch bug has been taken before this landing.

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

## Gate-discovered shader-brush example defect

The required README runner exposed a pre-existing whole-grid dilation inside
`grid.voxels.every(...)` in voxel-edit's shader-brush example. An equal 64^3-cell
result would recompute the same reference 262,144 times. The reference is now
computed once; the grid and equality comparison are identical.
`packages/voxel-edit/tests/readme-brush-work.test.js` executes the actual README
block with the real CPU dilation and a GPU stand-in, checks equality, resource
disposal and exactly one reference call. The same test on origin/main's README
fails on the second call. This is a deterministic work-count fix, with no timing
claim or raised deadline. The browser runner's original 20 s timeout stays intact.
Verify also caught missing TSDoc on the new BakedTexture union; its documentation
is now present. The failed gate is retained in testpage-resume-verify.log.

## Final gate integration

All 13 GPU package scripts pass, including core erase/refill after device
replacement, all culling cases, native texture parity, roads, selection, voxel
edits, water and WFC. `test-results/testpage-resume-gpu.json` retains the results.
The corrected README run passes: 98/112 examples ran, 14 unchanged known failures
and zero new failures. No known list, tolerance or deadline was changed.
The full unit run completed 13,490 tests: 13,483 passed and seven failed. Causes:
box-only geometry retained an unused lattice class method (fixed by a private
standalone helper, same output); generated umbrella/tree exports, umbrella size
and site LLM docs were stale (regenerated); the new merge step lacked STEP_AFTER
(now depends on verify's build); catalog teardown exceeded its unchanged 30 s
close budget by 13.1942 ms on the loaded host (recorded for quiet release retest).
Geometry tests and merge scheduler regressions now pass together, 70 tests.
The box consumer's existing 1,550 B budget remains unchanged. Core has no further
change beyond the approved empty-Geometry exception.

## Corrective verify and current local commits

After reconciling origin/main bd41f0279, lint and hygiene pass and verify passes
in 440.3 seconds: 13,499 unit tests passed, zero failed or skipped. API: 887
entries, 8,638 exports; quality, all proof suites, links, sandbox checks and README
types pass. Geometry's full package suite passes 291 tests; the box-only bundle
measures 1,464 B, below its unchanged strict 1,550 B budget. These are packaging
measurements, without a rendering-speed claim.

The three remaining gates pass under codex-testpage: geometry GPU after the
private lattice-helper refactor (3.6 s), procedural GPU including main's new caves
test (12.7 s), and geometry/margoengine README execution (17/17 examples, 10.5 s).
Results are in test-results/testpage-landing-exclusive-results.json and the
corresponding logs. The old session's queued processes were gone; replacement
shared requests were cancelled before execution and replaced by one bounded
exclusive request so newer exclusive jobs could not indefinitely preempt them.
All 13 original package GPU scripts and the ten-package corrected README run
already passed. Completed gates were retained without duplicate execution.

| Bug | Local commit (before any subsequent rebase) | Regression |
| --- | --- | --- |
| 1 FIXED | `6502c7f77` | `packages/road/test/testpage.test.js` |
| 2 FIXED | `11e2a8fd5` | `packages/road/test/testpage.test.js` |
| 6 FIXED | `2a7f37504` | `packages/road/test/testpage.test.js` |
| 7 FIXED | `2aad90aea` | `packages/procedural/test/testpage-sdf.test.js` |
| 8 FIXED | `824adfd10` | `packages/procedural/test/testpage-sdf.test.js` |
| 9 FIXED | `b663cd24d` | `packages/procedural/test/textures-browser.mjs` |
| 10 FIXED | `fe7b60ba9` | `packages/procedural/test/testpage-assets.test.js` |
| 11 FIXED | `6b89cbd1e` | `packages/water/test/testpage.test.js` |
| 12 FIXED | `5188c684b` | `packages/core/tests/empty.test.js and empty.browser.mjs` |
| 13 FIXED | `cb6a1d506` | `packages/wfc/test/testpage.test.js` |
| 14 FIXED | `489258925` | `packages/voxel-edit/tests/testpage-contracts.test.js` |
| 16 FIXED | `472375fac` | `packages/animator/test/testpage.test.js` |
| 18 FIXED | `aa3cc1ac9` | `packages/animation/tests/testpage.test.js` |
| 19 FIXED | `3429283f6` | `packages/animation/tests/testpage.test.js` |

Bugs 20, 23, 24 and 25 remain next, after this batch lands. The other latest
Added entries belong to lane S. Physics remains on hold.

The final live reread found a newer Added night section covering 32 and 34-41.
These remain untriaged after this batch lands, alongside 20/23/24/25. Entries
35/38/40 must first be checked on a fresh build; working declared exports are
not a package defect, but an existing post-build export-target check must be
confirmed or added. For 32/36, choose one consistent vector-assignment rule;
if 36 requires core, stop and report for Scott's approval. The other assignments
are burst-join counting (34), initial inspector ranges (37), relative tile URLs
(39), and existing LabelRenderer attachment (41). No implementation for these
entries has begun, preserving the required landing order.

## Follow-up after the first landing

The original 17 fix commits and their supporting changes landed at 1cc86b9a5.
Entry 20 reproduces on that main: direct disposal leaves the environment registered
in both the default and a secondary scene. Environment now retains its setup
engine and removes itself through sceneOf before releasing resources. The two
new real-Engine tests in environment/tests/brdf-share.test.js fail on main and
pass with the fix (7/7 tests). Dependent backgrounds/lighting still borrow the
original environment; replacement does not retarget them. No core change.

Entries 23 and 25 are NOT A BUG on main 1cc86b9a5 after a fresh package build.
There is no Materials class or materials.set export in the current package;
neither the README nor its API report declares one. The read-only page now edits
primitive material factors directly. PbrMaterial's documented live roughness,
metalness and clearcoat assignments work without a caller-created uniform block;
materials/test/material-classes.test.js covers those defaults and physical options.
The bounded test-results/testpage-23-repro.mjs records the absent exports and the
working live properties. Adding the reported API would invent a new feature.

For 25, Engine.sceneOf returns the default Scene for default-scene plugins, so
Transitions.dispose already removes its registration. A new real-Engine check in
transitions/test/scene-disposal.test.js passes without production changes: attach,
dispose twice, confirm ownership/registration removed, immediately reattach.
The existing GPU test/gpu-browser.js also checks actual scene ownership. The
reported premise that sceneOf is undefined for direct engine attachment is false.

Entry 24 reproduces on main: attaching a mask after built-in Transitions gives
Invalid plugin. Optional mask/custom entries now use distinct plugin and pass
names. Captures nest built-in/mask/custom and composites unwind in reverse,
independently of attachment order. Without that reverse ordering, merely renaming
the passes would leave the final frame pointing at an intermediate target.
transitions/test/mask.test.js fails on main and passes with the fix; it uses real
Engine registration, both attachment orders, independent progress, device restore,
capture restoration and independent disposal. The existing viewport GPU oracle
now also covers all three kinds together; its gate remains required before push.

Entry 34 reproduces on main: 50 simultaneous hello messages admit only 32 players
with maxPlayers 64. The players getter already includes accepted joins, so the
additional joins.length double-counted them. Capacity now checks players once.
netcode/tests/testpage-burst.test.js verifies 50 accepted before the first tick,
64 accepted from a 65-client burst with exactly one full refusal, authoritative
state after stepping, and immediate slot reuse after a disconnect. Its initial
state checks include the arena fixture's four pre-existing crates. No timer or
wall-clock tolerance is used.

Entry 37 is FIXED: disabled range inputs inherited the browser's range midpoint
instead of an authored value. Inspector now initializes every material/effect
range after setting its bounds. Missing exposure/bloom bindings display zero;
unselected material sliders display core defaults 0.5/0. The new real-Engine/jsdom
case in inspector/test/inspector.test.js fails on main and covers omitted, empty
and partial effects plus refresh. The reported literal undefined console warning
is not produced by this code path: disabled controls already skip refresh writes.

Entry 41 is FIXED in labels, without a core change. LabelRenderer.attach checks
its intended name before allocating an overlay and throws linked code state,
naming the collision and explaining reuse or an unused name. It never silently
replaces the existing layout. labels/tests/testpage-attach.test.js fails on main's
opaque Invalid plugin error and passes with the fix, preserving existing DOM and
registration and allowing independent named annotations.

Entries 35, 38 and 40 are NOT A BUG after a fresh npm run build:packages (57.1 s):
preview, tilemap/iso, tilemap/hex and viewcube/axes resolve, and ViewCube has both
setTheme and roll. The stale dist reports do not reproduce. New verify unit gate
tests/package-exports.test.js checks every declared export target of every package,
including types, nested conditions and wildcard targets, after the build. Its
negative control detects missing runtime/declaration/conditional outputs; direct
imports retain the specifically reported APIs. Existing API imports/hygiene
checked many outputs but did not explicitly check every conditional target.

Entry 39 was already FIXED on main in 1c2b04bcf: Tileset.load and Tileset.from
resolve their input against location.href before resolving linked content. The
existing tiles/tests/tiles.test.js regression passes; it now also keeps the
reported root-relative variant beside the relative variant. The combined export
and tiles run passes 22 tests. No production tile-loader change was needed.
