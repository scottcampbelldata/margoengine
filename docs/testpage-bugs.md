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

Follow-up validation before the required core stop: all six changed packages'
470 unit tests pass, as do all 13 environment/transitions browser/GPU scripts.
The expanded transition oracle passes 3,456 spatial pixels at 1x/4x, including
paired and three-kind captures, with zero shader errors. Gate logs are
test-results/testpage-next-packages.log and testpage-next-gpu.log. New-batch
lint/hygiene/verify, remaining package GPU/README gates and API regeneration are
still required before these local commits can land.

Entries 32/36 reproduce on main's core: assignments clobber the three live mesh
refs and leave the store unchanged; snapshots contain undefined components and
restore rejects. Label's same assignment throws a getter-only TypeError. The
universal fix belongs in core Mesh, so work stops for Scott's explicit yes as the
brief requires. Both entries remain open in known-bugs.md; no new core edit or
partial Label assignment rule is applied. Proposed consistent rule: validate and
copy vector-like assignment into the retained reference, with atomic rejection.

The final live log reread also found new entries 42 (exporter collect triangle
index validation), 43 (exportUSDZ root export), and 44 (bevel mesh planarity).
They remain untriaged at this mandatory stop, rather than being silently omitted.
Read their exact live steps and check current main before writing fixes. Lane S
still owns the preview class, and physics remains on hold.

## Resumed local follow-up landing

The stopped run had already regenerated the three changed transition API reports
and passed lint (11.1 s) and hygiene (23.8 s). Its verify process stopped during
the package build, and its GPU request never ran. Only those incomplete gates
are resumed; the completed package and environment/transition results above
remain valid. Logs use test-results/testpage-followup-resumed-*.

Scott's newest ruling approves the bug 36 core repair and prescribes rejection
of retained-reference assignment, with `.set()`/`.copy()` for mutation. Bug 32
keeps the Label getter-only contract and gains the same coded TypeError wording.
This supersedes the historical stop and copy-on-assignment proposal above.
The coordinator's order remains: land these local follow-ups, then continue the
approved work and triage the new live entries 42-44. No core edit is included in
this follow-up landing.

The resumed verify completed its build and proof checks, then failed the labels
entry size ratchet (5,654 B versus its unchanged 5,546 B budget). The duplicate
attachment diagnostic now uses a compact coded TypeError, preserving the name,
reuse/rename guidance and help link. Construction has no DOM side effects; the
check still runs before engine.use/setup allocates the overlay. The regression
now additionally requires TypeError. The measured entry is 5,546 B; no budget or
test was loosened. The failed verify stopped its remaining unit/API chains, so a
complete verify is still required. The next run uses the original landing's
MARGO_RESULT_CACHE=off environment: optional shadow recording is disabled, and
every actual check still runs.

The repaired follow-up gates pass: lint 6 s, hygiene 43.2 s, full verify
593.6 s (590.5 s reported internally), including 13,517 unit tests with zero
failures/skips, all 20 proof scenarios, 887 API entries/8,638 exports, and all
970 quality size entries against unchanged budgets. Logs and result JSON use
test-results/testpage-followup-repaired-*. The labels package unit suite and
scoped API regeneration also pass. Only the queued labels/netcode/tiles browser
and six-package executable README runs remain before the required first push.
An earlier GPU wait expired without starting a test; the replacement has an
explicit 59-minute wait and 20-minute hold limit, owned by codex-testpage.

The 11:25 EST live BUGS.md reread adds entry 45: with forced WebGL2 compatibility,
attach VoxelPathTracer, dispose the tracer, then dispose its engine. The report
attributes an ANGLE/Direct3D11 loseContext hang to float targets/compute state.
That cause is not yet independently confirmed. Preserve this new entry for
reproduction and owning-package triage after the coordinator's required local
landing; do not count it as fixed or silently omit it.

## Completed local follow-up landing gates

All remaining labels/netcode/tiles browser suites pass (17.9 s supervisor;
5.1/6.1/6.3 s suites), including 16 tile spatial/budget checks and 11 shader
modules with zero compilation errors. All 56 environment/transitions/netcode/
inspector/labels/tiles README programs execute: 22 Node and 34 browser, zero
failures or exceptions, 46.7 s. testpage-followup-browser.json and the browser/
readmes logs retain the results. The requeue supervisor also passes and releases
its GPU lock. Full lint/hygiene/verify and the retained earlier package/GPU gates
are complete; no test, tolerance, size budget or workload was loosened.

The branch rebases onto current main before its fast-forward push. Conflicts
were appended evidence/known-bug documentation and generated indexes; both sides
are retained and LLM indexes regenerated. The rebased focused documentation,
error-page and export-target suite passes 16 tests with zero failures/skips.
Core and stage remain unchanged in this landing. Approved entries 32/36 and
untriaged entries 42-45 remain next, after this required first follow-up push.

### Approved entry 36: retain core transform refs

Current main c00218aaf reproduces silent assignment and inspector corruption.
The persistent `packages/core/tests/transform-refs.test.js` fails before with
Missing expected exception, then passes with construction-time accessor guards.
Arrays, objects, self-assignment, null, numbers and Reflect.set all throw the same
TypeError with code transform; retained refs, supported mutations, store growth
and inspector snapshot/restore remain intact. Core has no quaternion ref; Camera
position/target/up are assignable tuples. No optional package can guard all meshes.
Core + stage measured 23,837 B before, 23,924 B after (+87 B), under 25,000 B.
The class regression is also in check:testpage-contracts (check:merge).

Entry 36 landing evidence: core units passed (8.5 s), lint passed (4.6 s),
hygiene passed (26 s). Initial verify passed 13,545 tests and found one stale
umbrella README size; that number is corrected and the existing size regression
passes. Repaired full verify passed all 13,546 tests, zero failures/skips, in
400.4 s. Core-only measured 21,553 B, below 21,587 B. GPU and executable README
checks are queued under codex-testpage; the local commit is not pushed yet.

### Entry 32: preserve getter-only Label position with the core diagnostic

The before regression fails on the raw getter-only TypeError. A rejecting runtime
setter preserves the getter and the getter-only public declaration, while using
core's shared coded diagnostic verbatim. Array/object/self/null assignment and
Reflect.set preserve the position and followed mesh; setPosition still copies and
detaches. The declared math/mat4 dependency was being embedded by labels' custom
build. Keeping it external removes that redundant implementation and funds the
error guard: 5,546 to 5,450 B gzip, within the unchanged 5,546 B ceiling. The class
regression and the shared dependency assertion are in check:testpage-contracts.

Entry 32 gates: labels units passed (2.3 s), lint passed (2.1 s), hygiene
passed (12.6 s), and full verify passed in 405.2 s with zero failures/skips.
The labels GPU and executable README checks are queued under codex-testpage;
the separate local commit is not pushed until those actual checks pass.

### Entry 42: NOT A BUG on current main

The report's two-index input already throws RangeError from triangleIndices,
before winding conversion, in STL, OBJ and PLY. normalizeGeometry uses that
validator for plain geometry and core geometry, and per-primitive overrides also
use it. The README already documents complete triangles. Persistent coverage in
exporters/tests/testpage-triangles.test.js passes unchanged implementation:
72 rejections across three writers, ordinary/Uint16/Uint32 arrays, lengths
1/2/4/5 and ordinary/mirrored scales. Inputs remain identical; complete triangles
still export. No exporter behaviour or public entry was changed for this finding.

### Entry 43: NOT A BUG, USDZ is a documented optional entry

The current README explicitly says to import exportUSDZ from
@margoengine/exporters/usdz and that the root does not export it. The package
description lists supported formats, not a promise to put every writer in the
root. exporters/tests/testpage-usdz-entry.test.js imports the actual documented
package subpath, writes a ZIP/USDZ header and pins the README's explicit optional
entry contract. The unchanged implementation passes. Adding a root reexport
would reverse this documented choice; no export or behaviour change is needed.

### Entry 44: generated bevel surfaces must satisfy the polygon contract

On current main, cube extrusion alone succeeds, but extrude/inset and double
extrusion reproduce the planar-face failure; wedge and cylinder extrusions also
reproduce it. The persistent twelve-case regression fails eight cases before the
fix. The existing ear clipper now splits generated invalid strips/caps into planar
triangles, preserving corner UVs and mapping every piece to every source face.
Splitting alone revealed an inverted strip/cap on a twice-extruded cylinder
(11/12 passed). Winding now follows source half edges and cap connectivity,
instead of guessing outward from a global centroid. All twelve now pass planar,
closed/opposite edge incidence, UV ownership, provenance, compile and subsequent
extrude/inset assertions. No tests or tolerances were changed to obtain the pass.
No core/stage or separate private modeling implementation was changed.

Entry 44's initial full verify stopped at the unchanged entry size budget:
30,471 > 30,203 B. The repair now keeps valid planar convex loops and directly
ear-clips invalid generated loops, without the optional convex-merging step.
All twelve regressions still pass, and the entry measures 30,180 B. The budget
was not changed. Mesh-edit and exporters suites passed 421 and 502 tests before
this size refinement; the changed mesh-edit suite and full verify run again.
Research/standards comparison for entries 32, 36 and 42-45 is recorded in
[testpage-research.md](testpage-research.md). The newest live rulings also defer
all new speed measurements and require shared correctness locks with >=60-minute
queue bounds. No benchmark or paired wall-clock speed experiment was run here.

Final local entry 44 pre-gates after the size refinement: mesh-edit units pass
421/421 (8.4 s), scoped API refresh passes, lint passes (3 s), hygiene passes
(13.9 s). Full verify is queued shared with wait-max 60 and a 40-minute hold;
actual GPU/browser/README work is separately queued and waits for that result.
The earlier 36/32 ten-minute queues expired without running tests. No push yet.

Continuation: the handoff's two queued supervisors had exited without recording
results. Only their unfinished stages were requeued, shared with wait-max 60;
completed package, lint and hygiene gates were retained. Full verification then
passed 13,561/13,562 tests with zero skips: the new research document was missing
from the generated site/llms.txt index. Regenerating that index repairs the stale
artifact, and all nine existing LLM-index regressions pass. Build, API and quality
checks passed in that run. Verification must finish again with the repaired
artifact; browser and executable README validation remain pending.

### Continuation: entries 36 and 32 landed, entry 44 still gated

Entry 36 landed as 1dbb3bec8 after core GPU passed in native, compat and preview
modes (8.3 s) and all 15 core/umbrella README programs passed (18.7 s).
Entry 32 landed as 99b7dafec after the labels browser suite passed (11.9 s) and
all six labels README programs passed (13.1 s). Both pushes fetched/rebased current
main and used fast-forward pushes. Their retained full verification/unit/lint/
hygiene results above were not duplicated. The research record and generated
index precede both commits, so their early landings include the cited sources.

Exporters' browser, PNG and capture suites and mesh-edit's browser suite passed
in 23.1 s total. The exporters/mesh-edit README command exited successfully in
22.6 s: 49/52 examples passed, with three pre-existing known-list failures:
exporters render-to-file (undefined tuple), exporters Unity support bundle
(fixture lacks the required source profile), and mesh-edit import-to-editable
(fixture lacks the requested glTF accessor). These are not 52 passing examples.
The report is test-results/readme-run/run-88656/report.json.

The repaired full verification exited unsuccessfully after 700 s including its
GPU queue wait. Build, API, quality and other completed chains passed; the unit
chain produced no final output or failure summary before the process exited.
There is no successful verify result for entry 44 and no new attributed cause.
Do not replace that missing result with a blind retry or a passing focused test.
Browser teardown remains the dedicated hunter's work. Entry 44 is not pushed.

Entry 45's D3D11 probe confirms that immediate tracer/engine disposal returns
through loseContext. Its separate ready/render case reached await tracer.ready,
then hit the unchanged 180 s hard limit; its entire process tree was killed.
It never reached render or disposal in that case, so this neither establishes
nor disproves the reported disposal hang. The subsequent isolated pipeline probe
records individual promises and first GL status queries to locate the readiness
boundary, rather than changing tracing work or the timeout.

The isolated probe also ends at its unchanged three-minute GPU hold limit
(182.8 s supervisor result including termination). Add, prepare, atrous, tables,
combine, ids and preview all resolve; only the trace render pipeline remains
pending. First COMPLETION_STATUS_KHR queries return without blocking, and page
heartbeats continue until termination. No render/disposal boundary is reached.
The trace compilation/readiness boundary needs further attribution; no package
runtime change or NOT A BUG conclusion was made. Logs and supervisors use the
testpage-45-pipeline-probe prefix. The final live BUGS.md reread still ends at 45.

### Entry 44 landing gates completed without a GPU lock around verify

The coordinator ended the preceding verification because its outer GPU lock
held a slot during CPU work. The required replacement command is plain
`npm run verify`, supervised with the unchanged 40-minute hard limit and no
GPU-lock environment. It passes in 721.2 s: 13,562 tests, zero failures and zero
skips. Build, API, quality, sizes, README types, both sandbox chains, links and
correctness proofs all pass. No benchmark or separate speed test was run.
The durable local result is test-results/testpage-unlocked-verify.json and its
log; the supervisor reports success in 721.7 s, including process exit.

Together with the retained package units, lint/hygiene, four browser suites and
the successful scoped executable README command documented above, this completes
the gates for f4dc6d8e5 and the 15c888929/fdfbace45 coverage. The three existing
README exception failures remain explicitly reported; they are not passing
examples. The live BUGS.md reread at 13:02 EST still ends at entry 45.

The pending readiness observation for entry 45 matches the already documented
ANGLE Direct3D11 monolithic trace compilation defect in known-bugs.md. A new
bounded probe will dispose while trace compilation is active, rather than wait
for that known pending readiness promise. No runtime change or disposal-cause
claim is made before that probe runs.

### Entry 45: confirmed active-compilation context-loss hang, still open

After the entry 44 landing, a new D3D11 probe renders the original raster stand-in
and disposes one second after the trace render pipeline submits compilation.
It reaches 61 raster frames; tracer.dispose returns, engine.dispose enters
loseContext, and that call never returns before the unchanged three-minute lock
limit terminates the entire process tree. The outer supervisor records 181.3 s
and failure; its own 64-minute queue-plus-run deadline did not fire. This is an
actual disposal repro, unlike the earlier ready-only probe.

A second diagnostic unbinds the current program and explicitly deletes all 15
tracked programs and 30 shaders first. Deletion returns; engine context loss
still hangs until the same limit (181.3 s including termination). This does not
justify adding a deletion workaround to the runtime.

The raw-context isolation creates no Margo device or texture/compute objects.
A simple shader pair links and loses context successfully. A second context
compiles and links the exact captured trace shader pair, returns false from
COMPLETION_STATUS_KHR, then hangs in loseContext until the same limit (180.9 s
including termination). The emitted vertex is 366 bytes, SHA-256
9bf388d1a190efbc6471d472e441c211eb26d34e9ae3796786a05aadc35a2b9d;
the fragment is 134,593 bytes, SHA-256
d1c6b1991b9e86d9af892eb298d53bd29a9f48ca55530d31c6a05500a609fd0c.
The compiler/context-loss interaction is sufficient without the alleged float
target leak. The driver's internal locking cause is still unproved.

Local reproducibility files are test-results/testpage-45-delayed-dispose.mjs
(ordinary and --delete-programs modes) and testpage-45-raw-context.mjs, their
supervisors, .log/.json results and captured .glsl pair. Each actual GPU command
takes one shared codex-testpage slot, wait-max 60 and max 3; nothing else holds
the lock. Research and the candidate staged transport repair are documented in
testpage-research.md. No runtime change, completed fix or performance claim is
made. Browser teardown stays with its dedicated owner. BUGS.md still ends at 45.

### Entry 45 continuation: engine input ownership and split evidence

Current-main reproduction after the browser-helper repair still blocks inside
loseContext at the unchanged 180 s deadline. The optional tracer route owns the
monolithic input and therefore the prevention work, even though raw WebGL
reproduces it. No evidence establishes that engine prevention is impossible.
The browser's exact internal lock remains unknown; its public parallel-compile
extension has no cancellation or compiler deadline.

New data-texture and uniform-loop-bound probes retain the full trace program
and still fail at that deadline. They are not runtime changes or repairs.
In contrast, isolated camera/closest-hit/surface/shadow/glass-candidate programs
link. A one-light evaluation with all light-kind branches and every Walk field
exposed also links and returns from context loss. The combined lighting loop
remains pending at the poll deadline. Research, input sizes and precise scope
are in testpage-research.md; all raw GPU runs used one shared slot and max 3.

A bounded CPU f32 diagnostic preserves all radiance/reservoir/RNG bits across
144 cases when evaluating the five lights as ordered steps. It includes no
voxel geometry. A state inventory and the generated shader probes are retained
locally for the staged-route implementation. Full transport, GPU output parity,
state serialization and an actual passing lifecycle regression are still owed.
No runtime package, README or export changed. Bug 45 remains OPEN, with no
FIXED or NOT A BUG claim and no speed measurement.

The one-light early-loss control subsequently observes pending completion after
one second and returns from context loss before the unchanged deadline. The
supervised command takes 92.2 s; this is no responsiveness guarantee. It further
implicates the submitted workload without identifying a native deadlock. A
carried-reservoir shader compile is distinct from the empty-Walk probe and must
be checked before a staged route can claim full work preservation.

That stronger carried-state check remains incomplete at the 120 s poll. Context
loss returns before the unchanged 180 s limit, but the command fails completion
(176.1 s overall). No complete bounded transport stage or fix is established.
The original real-engine hang remains open, and finer decomposition of final
reservoir/BSDF, shadow and candidate work is still required.
