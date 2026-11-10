# Known bugs and unverified features

Lane B gate sweep (2026-11-10): `node --test --test-timeout=120000 tests/check-example-types.test.js` fails its cameras-scoped expectation because cameras now reaches 14 packages, above the unchanged 12-package full-run threshold; the planner correctly selects all projects but the fixture expects a named subset. Outside the API-record classification job; reconcile the fixture in the fix phase without weakening closure coverage.

Lane B gate sweep (2026-11-10): `node --test --test-timeout=120000 tests/no-private-paths.test.js` finds 12 tracked files with references to excluded local paths (clean-room, known-bugs, limits, sciviz-a11y, whitepaper claims/reproduce/atmosphere result, netcode lobby test, accessibility audit, two sciviz preparation scripts and llms-full). Cause: producers committed machine-local evidence pointers unavailable in a clone; replace at the owning producers in the fix phase. No classification or assertion change.

Batch 180 job 3 geo-time: no open correctness defect found in the implemented trajectory, WMTS time or SGP4 paths. Quantized trail fading and rebuilt primitives on seek are documented limits; efficient in-place updates remain quality work. All 29 published orbital cases and both rendering backends are covered.



Batch 186 job 1: disk/sphere shadows use the existing centre-map PCSS approximation and guard band (limits.md); no exact extended-emitter visibility claim. Native WebGPU and full WebGL2 production-shader visibility checks pass.


Batch 190 job 2: no open defect found in float32 weighted accumulation. The entry deliberately retains the original weighted-depth approximation and sorted paths for transmission/custom blending; finite f32 sums and final HDR target range are recorded in limits.md.

Batch 190 job 1: no open defect found in depth peeling's distinct-depth transport contract. Single-sample transparent coverage and coplanar depth coalescing are explicit limits in limits.md; finer edge reconstruction and coplanar tie handling remain future quality work, not exact-fragment-list claims.

### Batch 238 follow-up: transformed bitmap alpha precision

Whole untransformed straight-alpha bitmap uploads now preserve every channel. A cropped, flipped or explicitly premultiplied ImageBitmap still passes through Canvas2D in webgl2-compat/device/render.ts and can quantize low-alpha RGB. Repro: crop the 61x23 diagnostic WebP from splats/test/gpu/check.mjs before copying it and compare straight RGB at alpha 0 or 1. Cause: Canvas2D stores premultiplied colour; a GPU transform path is needed to retain straight RGB through these operations. This existing transformed-copy gap is outside the progressive-loading job; unchanged-bitmap regression and existing transform semantics both pass.

Lane A sweep, 2026-11-10: reproduced on f4f7f43ad with a 7x5 ImageData bitmap,
alpha 0/1/128/255, whole/cropped, flipped/unflipped and straight/premultiplied
copies into 1/2/6-layer textures. Native and compatibility differ in 13 of 48
cases. Two bounded investigation rounds rejected a VideoFrame substitution:
whole straight uploads preserve RGB, but visibleRect cropping loses low-alpha
RGB and alpha conversions differ by one byte in some channels (36/48 cases).
No draft or weaker assertion shipped. Next: direct bitmap upload plus a GPU
crop/flip path, with explicit handling of the source's alpha representation.
Standards compared: WHATWG HTML canvas and ImageBitmap (2026), Khronos WebGL
1.0 section 5.14.8 (2026), W3C WebGPU sections 3.11/19.2 (2026), and W3C
WebCodecs section 9.4 (2026); sources in clean-room.md.

### Fixed: Water inside a TAA capture at 4x lost the whole frame

C2 row c2-007 (taa, shadows, toon, water, points with a DepthTexture probe) read depth 0 at every probe on native
WebGPU at 4x MSAA; 1x passed. Bisected to the pair TAA + Water. Cause: inside a 4x scene capture, Water copied the
capture's depth into its own 4x surface depth with `SceneTarget.copyDepth(encoder, view, 4)` and no format, so the copy
pipeline took the capture's format (TAA mirrors the canvas's depth32float-stencil8) while the surface depth uses the
source depth's format (DepthTexture's depth32float). The device rejected the attachment state at `setPipeline` and
dropped the frame's whole command buffer, so no pass of that frame ran. Water now passes its surface depth's format.
Regression: `packages/water/test/water.test.js` "4x surface depth copies in its own format from a capture whose depth
format differs" checks every pipeline's depth format and sample count against its pass's depth attachment.

### Fixed: umbrella indexes after the caustics rebase

The merged workspace exports included optional entries absent from the
umbrella manifest/facades. `node scripts/umbrella.mjs --check` and the binding
identity test caught them. Regenerating the umbrella from the current exports
repairs the indexes; `tests/umbrella.test.js` retains the class regression.

### Fixed: batch 256 synchronous host recovery deadline

A synchronous Connection could complete recovery from inside status broadcast,
then the returning outer frame armed a deadline that closed the healthy session.
Initialize the timer before notifying peers and stop recovery work once authority
is ready. The synchronous-transport case in packages/netcode/tests/migrate.test.js
fails before the change and stays ready past the deadline afterward.

### Fixed: Batch 258 image checks

Fixed within the image job: four-value slice arrays previously remained aliased after validation; defensive copies now cover construction, assignment and reads. Lazy creation of an unused SDF atlas placeholder changed generation after the upload key was captured, causing one redundant image-only second-frame upload. Both WebGPU and GL now retain the post-binding generation. image.test.js and image-browser.mjs preserve the regressions. No other UI defect is being repaired in this build job.

Lane A sweep: the fixes are already on main in 12701037e. The unchanged image
and text-input CPU regressions pass on current main; no README example was run.

### Batch 258 text fields

Fixed by the lane A sweep, 2026-11-10: the disposable Vite consumers under
React tests/.subpaths-*/ were unignored, so quality's Git inventory included
them and failed with ENOENT when the test removed them. The producer's temporary
directory is now ignored. tests/quality-inventory.test.js deterministically
removes the generated hooks.mjs between inventory and detector reads and
retains real untracked source coverage; it fails with ENOENT before the fix.

The former shared Chromium shutdown failure is fixed upstream at 919fdc09e.
This branch is rebased onto that fix; both native and compatibility input
checks now pass all 14 checks and complete teardown.

The input entry supplies the previously missing single-line, multiline and
password widgets. `tests/text-input.test.js` covers native mirror state,
composition, selection, masking and cleanup; `tests/text-input-browser.mjs`
checks canvas focus, real editing, undo, clipboard and browser IME on both
complete backends. Human screen-reader and mobile OS keyboard certification
has not been performed. Image, forms and preview world-panel parity are
separate batch 258 jobs and remain open until their own acceptance.

### Historical: batch 234 flow gate awaited owned Chromium stdio close

At `321282ba3`, `node scripts/gpu-lock.mjs run --owner=codex-batch234
--wait-max=60 --max=3 -- node packages/water/test/flow.browser.mjs` passed all
original flow assertions, then failed the unchanged 30000 ms teardown bound:
`Chromium process/stdio close (95824)`. The browser root was gone when inspected
after failure. The owning wait is in `scripts/lib/browser.mjs` after
`stopOwned` and pipe destruction; its launch-latched ChildProcess `close`
promise did not settle. The missing exit/pipe notification's deeper cause is
not isolated, and load is not claimed as its cause. No timeout was raised.

An instrumented diagnostic of the same real flow input passed, recording all
four owned pipes closed and ChildProcess close counts 5/5. It does not prove
the original hang fixed. The original failure and diagnostic are retained in
`test-results/batch234/caustics-acceptance-flow-webgpu.log` and
`caustics-flow-close-diagnostic.log`. Earlier batch-160 shutdown repairs below
are retained; this is new evidence after those repairs. Main commit 919fdc09e moves the Playwright server into its owned host process,
repairing the shutdown wait. The complete water gate passes on both backends after that rebase;
no competing lifecycle change is made here.

### Fixed in the caustics draft: concentrated half-float flux range

The initial finite-footprint repair retained coverage but stored unscaled
irradiance in additive rgba16float maps. A 2 x 2 m ideal source focused into a
1024-square map exceeds the format's 65504 range. The new GPU total-flux bound
scales accumulation and restores it during projection, preserving physical
energy. `packages/water/test/caustics-energy.browser.mjs` checks 64 and 1024
maps against an independent Fresnel-energy integral with an unchanged 0.005 bar.
Both backends pass. No source intensity or image threshold was reduced.
The receiver, visual and fast gates now pass. Research and explicit limits:
[acceptance record](water-caustics.md).

### Fixed in the caustics draft: boundary slice interpolation

The initial emitter rejects a slice above any source vertex, so a flat -1 m
interface sampled by -2 m and 0 m slices attenuates a valid -1.5 m receiver
toward zero even with absorption disabled. The source-ready emitter now extends
the straight bundle through virtual slices; physical wet/dry masking stays in
the projector. The energy test's flat -1 m interface / 0 m slice is the
regression. Both backends now pass with 0.000137425 relative flux error under
the unchanged 0.005 bar; independent dry/above-water projector checks remain
exact zero. Full package and visual acceptance now pass. See the
[caustics record](water-caustics.md) for optics and retained failures.

### Historical: batch 234 job 3 underwater reflection artifact

The underwater implementation is retained on `batch-234` and
`batch-234-checkpoint-6e16c0d72`, not accepted or landed. Repro in that retained
branch: build water, then run `packages/water/test/underwater-preview.browser.mjs`
through the shared GPU lock. The NOAA-driven FFT scene's `underwater-below.png`
and `underwater-split.png` show fine bands in the underside reflection. The
independent analytic trace suite passes 75 cases on native WebGPU and full
WebGL2 compatibility; it does not close the real-scene failure.

Ruled out as a complete cause: the former hit threshold growing with march
step, and losing the last in-view ray interval. Refined depth crossings, fixed
physical thickness and clipped endpoints fix those classes, but the FFT bands
remain. Disabling both screen traces removes the fine bands while leaving
medium transport and Fresnel active, so absorption/fog and Fresnel alone do
not explain them. Bright seabed under total internal reflection is physically
valid and must remain. Remaining cause is not isolated: distinguish reflection
from transmission, then measure bad-pixel inputs, hit coverage, depth residual
and sampled radiance. No fourth speculative tracing round or acceptance claim.
List 3 batch 66 job 5 then built water/underwater fresh on main without the screen traces (fog, absorption, waterline and shafts only); the underside reflection remains open in finish-later.md.
The independent caustics job landed as `3369f2e4f`; the retained underwater
branches above must not be deleted. This note accompanies batch 213 job 1.

Batch 234 continuation on 2026-11-10 completes the missing underside in the newer main implementation. It replaces the rejected distance-march/binary-depth-crossing strategy with exact pixel-edge traversal and locally reconstructed depth-plane intersections. The independent analytic test initially exposed skipped corner texels and float32 cracks at exact texel boundaries; supercover visits and a relative arithmetic envelope fix those causes. Regression: underwater-optics.browser.mjs covers 1,026 rays including oblique planes and holes. underwater.browser.mjs independently checks every submitted FFT underside pixel against dielectric Fresnel and catches first-frame self-intersections if the opaque depth snapshot is replaced with FFT's later surface depth. The original parked branch remains historical, not reintroduced. Finite screen capture and multi-view limitations remain listed in docs/limits.md.

### Fixed: batch 133 lazy asset package grouping

The new decoder records were separated from its existing records, so grouping
the table changed row enumeration relative to the catalog. Both native records
now sit with the decoder group. The new contiguous-group regression and the
unchanged exact table identity assertion fail before repair and pass afterward;
all nine size-page tests pass. No asset, measured byte or existing assertion is
removed. Research is recorded in clean-room.md.

### Fixed: batch 133 browser fixture duplicate declaration

The optional Draco fixture reused the HDR fixture's native lexical binding in
runDecoderTests, preventing module parsing. A Draco-only binding rename fixes
it. browser-source.test.js fails before and passes after, parsing every non-test
fixture/support module through Node --check. The real GPU gate retains its
unchanged assertions and deadlines. Research is recorded in clean-room.md.

The subsequent empty-input failure came from Vite's dynamic URL table omitting
nested fixture directories, producing tests/undefined (404), not from the Wasm
allocator. An explicit fixture-root URL fixes all new and existing callers. The same CPU regression
rejects dynamic asset paths before browser execution; it fails before repair
and passes after. No decoder, worker, or allocation implementation changed.


### Fixed: normalized fixed-step streamlines stalled near critical points

fields.ts now refines normalized RK4 by step doubling and stage/endpoint direction checks before publishing
points. The exact sink approaches zero monotonically; the unchanged NOAA day 3/seed [-3500,-1500,0]
no longer produces a false reversing two-cycle. All 96 unchanged NOAA day/seed combinations build both
shapes. The analytical and NOAA regressions independently fail the old tracer and pass the repair.
Small periodic orbits continue and a near-saddle trajectory preserves xy through the close encounter.
Physical boundary rounding, zero-speed/minSpeed=0 and invalid controls have permanent regressions too.
Numerical floor and local-error limitations are documented in the package README and limits.md.
GPU demo/final job acceptance now passes. Single full verify: 14012 tests, 14010 passed,
two metadata failures corrected and all seven affected checks passing.
The [final receipt](whitepaper/results/batch-171-tubes-validation.json) supersedes the earlier checkpoint.

### Fixed: scientific mesh failed construction/publication leaked resources

MeshLayer allocated its uniform/colour texture before later creation or triangle validation could throw;
meshLayer registered a drawable before a 2D/disposed/nonlinear figure could reject publication. Both error
paths now release every acquired buffer/texture and renderer registration, preserving the original exception.
Native fallback refuses with linked unsupported before allocation. mesh-ownership.test.js fails on all four
old paths and passes the corrected build. This CPU checkpoint does not claim full job 3 GPU acceptance.

### Fixed in private draft: batch 134 raw-level capacity and memory acceptance

Report25 frees the consumed Wasm output before encoding a new output. The
allocator regression fails on report24 at589824 live bytes and passes at327680
for identical complete decoding work. Layout-checked raw-level reservation
accepts134283264bytes for1x16384x2049layers, with all2049 actual-Wasm image
outputs exact. The128MiB compressed-input cap and dimension/image/pixel limits
remain unchanged. Invalid layouts and limits refuse before allocation.

The same173 fresh-process pairs, with all outputs retained and2289 hashes
unchanged, now have0 RSS losses and0 Wasm high-water losses. The two
previous misses pass: array UASTC BC4,88764 old/87560 newKiB; LensesMat normal
R11,94960 old/93024 newKiB. Original report24 failures remain published:
88788/89104 and94416/95248KiB respectively. This establishes the current
strict per-pair result; it does not decompose JIT/allocator/RSS causality or
prove a universal process-memory bound. No GC, normalization, discarded
outputs, timing waiver or rerun to obtain a better number was used.

[Current evidence](whitepaper/results/batch-134-allocation-checkpoint.json)
contains all pairs and frozen source/artifact pins; prior25loss and2loss
receipts remain available. Final missing-target/public-API memory acceptance
remains open and the prebuilt decoder remains retained.

### Open: batch 134 BC1/BC3 source quality and remaining targets

Lane A current-main audit, 2026-11-10: the default decoder and native Draco
regressions pass 28 tests. Production still retains the prebuilt decoders;
the replacement quality/target gaps below remain build work and are not a
reproduced failure of that default API. ETC2/EAC hardware proof is excluded
from this NVIDIA sweep. No private replacement draft was landed.

The private discrete cluster-fit draft passes71 native tests before owned-range
addition (72 afterward), and87/98 original-source BC1/BC3 pairs (1296 images,
1296 old controls exact). The11 losses are published, not accepted. All11
improve error against the actual decoded payload, but that diagnostic changes
no color bar. Even zero added payload error loses7/98 original-source pairs;
it is not a lower bound on source error for arbitrary encoders. Root work must
stay generic and specification-derived, without hidden originals or file tuning.
The full quality report and diagnostic are in the current evidence above.

ETC1S BC7/ASTC/PVRTC, UASTC PVRTC and BC6H remain missing. ETC2/EAC GPU proof
remains absent on RTX A6000 WebGPU; the AMD Vulkan upload attempt could not
create an adapter because the native binding could not load vulkan-1.dll
(Windows Error87). No ETC upload occurred. Public API/worker/final all-target
corpus, fuzz, memory, upload and entry acceptance remain open; prebuilt retained.

### Resolved scalar bar: batch 134 source-reference mismatch (2026-11-09)

Scott's written "Do recommend" replaces scalar acceptance with per-file SSE
against the spec-defined payload RGBA8 decode, new <= old, zero tolerance,
all 98 BC4/BC5 pairs and every exact old control. The same scalar paths cover
EAC R11/RG11 and ETC2 alpha with their unchanged channel mappings. The
[full evidence](whitepaper/results/batch-134-scalar-payload-bar.json) retains
the 14 BC4/BC5, 26 RG11 and one ETC2 original-source losses, old beside new.
The old losses remain measured facts; their former acceptance reference is
superseded by Scott's ruling, following the 17/98 ideal-fidelity diagnostic.
The rejected latent model is removed; report-16 bytes are restored alongside
later ETC2/EAC. Public integration, other targets, final all-current-Wasm
corpus/fuzz/uploads/memory/entry acceptance remain open; prebuilt retained.

### Fixed: LIC mixed-magnitude normalization

The original squared norm and 1e-20 cutoff changed a parallel 1e-24 velocity region into noise beside unit
velocities. Post-interpolation and post-projection scaled norms remove that cutoff, restoring scalar
magnitude separately. The real repro changed 928/2,048 texels before and zero afterward on both backends.
`entries-cases.js` checks the whole mixed image; `lic.test.js` rejects ranges that need subnormal interpolation.

### Fixed: LIC demo reused an expired loader deadline

The first draft combined every later layer update with the module's initial 120-second data-load signal.
After that signal expired, all day/colour changes failed immediately. Updates now create a new 120-second
deadline combined with the page lifetime. The real LIC demo test expires the original loader signal first,
then exercises those controls; the old draft fails deterministically with TimeoutError.

### Fixed: scientific demo absent from production inputs

Moving wind was linked from the sciviz README but missing from `scripts/build-site.js`'s explicit Vite inputs.
It therefore ran in development but its HTML did not ship. The builder now uses the audited scientific-page
list, including Moving wind and LIC. `tests/sciviz-site-pages.test.js` checks all README scientific links and
their scientific navigation destinations against production targets, and fails against the old builder.

### Verified: LIC validation and remaining native-driver limit

The new optional LIC entry's input/lifecycle tests and real-GPU analytical, animation, mask, slice, exact
restoration and strict backend pixel checks pass. NOAA demo checks pass in all four layout/backend cases.
The one full verify's four metadata/test-fixture failures are corrected and their affected checks pass;
package CPU/GPU, README and quality gates pass. Native sciviz/webgl2 has no LIC implementation and
rejects it explicitly; compatibility-backed WebGL2 is the supported fallback.
There is no claim of physical unsteady advection, volume LIC or arbitrary triangle-surface support.

### Fixed during batch 234: unrendered edits in wave-query snapshots

A draft capture uploaded Water's authored CPU parameters, which `setWaveHeight`
can change before the next draw. Captures now bind the already submitted GPU
uniform, ordered before subsequent render uploads. The query browser regression
requires an unrendered zero-height edit to leave the last-drawn snapshot exactly
unchanged on native/full compatibility. [Research and repro](water-query.md).

### Fixed: moving-flow sort centre on offset grids

The initial moving-flow layer returned its model translation as the transparent sorting centre. That is
the transformed data origin, not the centre of an offset grid. It now transforms the grid-bound midpoint.
The offset `[100,108] x [200,208]` browser regression in `entries-cases.js` independently checks all three
world coordinates, then removes that layer's bounds. The translation-only version fails this assertion.

### Refreshed: incoherent size-page evidence (2026-11-09)

The full batch 134 verify passed 13,727 tests and failed `sizes-page.test.js`
because the network and entry-size records named different measured revisions
and package-dirty states. Regenerating both records from built `94118d9e7`
produced a coherent local pair and the strict size-page regression passed.
The subsequent rebase found that main's lighting repair had already landed
its own coherent `b5822d106`/dirty pair. Those newer package measurements are
retained in full, with another passing size-page check. Successful verification
steps are retained; no metadata was relabeled and no second full verify is claimed.

### Fixed 2026-11-10: palette diagnostics and infinite spread

Palette helpers and pass options shared `Invalid palette value`; WGSL identifiers
and layout had also been shortened for size. The owning palette entry restores
readable names/layout and full field/range guidance. A mutable `pass.spread =
Infinity` previously passed the non-negative check and reached GPU parameters;
it now throws a linked RangeError before GPU work. Regressions:
`packages/pixel/tests/palette-diagnostics.test.js`. Research and measured bytes:
[size-restore.md](size-restore.md). Valid matching/dithering arithmetic is unchanged.

### Fixed 2026-11-10: README runner did not drive Blender's live-link lifecycle

The harness waited for a continuing module without supplying its live service
or pagehide. It now serves one real Blender model through HTTP and native SSE,
waits for attachment and framing, drives pagehide externally, then requires
module completion, model disposal, node removal and EventSource closure. The
20 s deadline and known-failure list are unchanged. The live README passes;
tests/readme-live.test.js proves lifecycle ordering and refusal of missing work
or cleanup, and fails against the old runner. Sources and repro:
`docs/readme-live.md`.

### Fixed 2026-11-10: lighting2d validation lost field and range guidance

The size-shaving emissive validation table emitted only `Invalid <label>`;
shared direct-light, soft and cookie checks used one generic message for many
fields. Reproduce with `new EmissiveSprite2D({glowRadius: -1})` or
`new CookieLight2D({cookieWrap: 'bad'})`. The owning validators now identify
the field and accepted range or names, with their original RangeError and help
link. The scalar predicates and rendering equations are unchanged. Regression:
`packages/lighting2d/tests/diagnostics.test.js`; measurements and research:
[size-restore.md](size-restore.md). No new open defect.

### Fixed 2026-11-10: shared codec diagnostics obscured causes and caller limits

Size-driven generic inflate errors called valid files damaged when they exceeded
the caller's byte limit. GLB errors did not identify header fields or chunk rules.
The shared helpers now report the exact failure and help link; stream policy
errors include minimum required and limit bytes with the caller's real repair
hint. Preset dictionaries report unsupported. Sciviz names maxSamples for
NIfTI/DICOM policy and metadata for paired images and Zarr chunks. Regressions:
`tests/shared-inflate-diagnostics.test.js`, `tests/shared-glb.test.js`, and
`packages/sciviz/tests/formats.test.js`; method and sources: `docs/size-restore.md`.

### Fixed 2026-11-09: owned termination waited before releasing its pipes

The close path awaited native termination work before destroying its owned
stdio/CDP pipes. Termination completion can itself depend on pending I/O being
released, creating a circular wait. It now requests termination, releases the
pipes even if the request throws, then awaits completion and process close.
The deterministic pipe-dependent regression fails on the parent and passes
after the repair; all 42 teardown, shutdown and page-ready tests pass. The full
verify had 13,665 successes and one page-ready cleanup timeout; those successful
results are retained and the failed page-ready test passes after this repair.
The original loaded timeout's native phase was not captured. No deadline changed.
### Batch 56 continuation: fixture and shader ownership repairs

The review56 fixture used different full/partial frame layouts and an unsupported
string view.clear. Matching partial frames with a clear object retain the exact
pixel bar; two deliberately unscoped surface controls expose the original leak.
Both backend proofs now pass. The HDR proof passed up in CameraOptions, which
does not accept it, so its vertical view rejected. It now assigns camera.up;
hdr-shadow-fixture.test.js executes the real fixture initialization and fails on
the old fixture. No core camera repair or tolerance change is needed.

The wider audit also reproduces three shader lifecycle defects: ComputePass
removes the active scene's same-name plugin; ScenePass and RawShaders release
resources but keep their registration. scene-owner.test.js exercises direct
disposal, owning-scene removal, restore, same-name isolation and replacement
with a real engine. Repairs are local; package acceptance and the remaining
non-PostStack audit are open. Capture stability remains with its separate hunter.
The [wider inventory](work-lists/batch-56-scene-owners.md) retains every candidate
and explicitly distinguishes syntactic review from proven defects.

Four terrain provider defects are also reproduced and repaired locally:
TerrainMaterials, TerrainDisplacement, TerrainVirtualTexture and TerrainDeformation
store an Engine in owner and disposed by its active scene. Route their public
attach factory's use into a real secondary scene, install a same-name default
sentinel, then dispose directly: registration remains and the default sentinel
is removed. The scene-owner regression now passes all eight disposal/removal
cases, including provider cardinality after restore. Reverting only the owner
lookups reproduces four failures with four passing controls. Package tests pass
93/93; their full GPU and README gates remain pending in the shared queue.

### Fixed 2026-11-10: labels duplicate attachment lost its error contract

Calling `LabelRenderer.attach(engine)` twice reported a shortened TypeError
(`reuse/rename`) because its diagnostic was squeezed into the optional entry's
size ceiling. It now reports a linked state MargoError with the colliding name,
reuse guidance and a complete alternate-name example, before construction.
`packages/labels/tests/testpage-attach.test.js` rejects the old error and covers
default and custom collisions without replacing existing labels or DOM.

### Historical: batch 134 rejected scalar source model

The report-17 rational estimate failed 21/98 original-source pairs and remains
rejected. It is archived, with the unchanged historical evidence, in
[the rational-source report](whitepaper/results/batch-134-scalar-rational.json).
Scott's 2026-11-09 scalar ruling above resolves the reference decision; it
does not validate that source model or hide any original-source loss.

### Fixed: GPU gate mutex target lookup raced junction retirement

Batch 171's browser gate encountered EINVAL before browser startup. The scheduler statted the reusable mutex
junction and then resolved it, allowing retirement/replacement to invalidate that second lookup. It now reads
the backing name once, retaining dead-owner identity checks. Regression, research and repro:
[GPU mutex target lookup](quality/gpu-mutex-target.md). Permission/I/O errors still surface; no retry or wait
budget changes. The resumed flow browser case passes its original numeric, parity and recovery assertions.

### Fixed 2026-11-09: owned Chromium process listing raced client close

After the helper-program repair, voxel GI passed its rendering assertions but
could still fail shutdown. `withBoundedClose` started client close concurrently
with `stopOwned`'s CDP process-list read, allowing disconnect to invalidate that
read and enter helper fallback. The bounded list now completes first and is
retained for native termination. A deterministic asynchronous-session regression
in `tests/browser-teardown.test.js` fails on the parent; all 56 scoped tests pass.
All nine fresh voxel GPU suites and the README gate now pass, with the README
gate retaining its existing five known failures and no new failure.

### Review 99 remaining tracer findings (2026-11-09)

- Fixed root glass: the interior inverse Snell candidates could offer the same unchanged direction through several face normals, adding their full light estimates while the path used one MIS share. A canonical box-exit face now offers that direction once, with the existing direction-equality predicate. The root glassfurnace GPU case rejects the old 1.03826 result and covers IOR 1, 1.000001, 1.0001 and 1.5 against analytic equilibrium.
- Fixed spectral: wavelength-independent contributions now stay RGB on one path. Importance-sample a hero only at the first dispersive glass interface or active chromatic lens. The spectral GPU suite rejects the old 1.578737 channel spread and requires exactly zero spread and exact root equality at 1 and 64 spp; analytic radiance, lens and restoration bounds are unchanged.
- Fixed composition transport: /compose selects all 32 subsets of five shared transforms with media conversion and atomic mesh storage. CPU, retained native transport/AOV proofs and the failed-only WebGL2/Vulkan continuation pass. Compatibility finishes within the unchanged 12-minute lease; the old uninstrumented timeout has no attributable phase. Triangle emitters and mesh deflectors remain part of full-scene work. Evidence: whitepaper/results/review-99-compose-20261109.json.
- Resolved full-scene mesh source gaps: 5225908a6 supplies retained normal/UV
  attributes, shared affine BLAS instances and degenerate-triangle accounting;
  6e8863845 supplies PBR channels and glTF snapshots; b163daf9e supplies mesh
  emitter sampling and the newer mesh builder. The lane A sweep passes all 26
  unchanged attribute/build/instance/PBR/light CPU regressions. These replace
  the old missing-API allegation; independent full-scene transport, guiding and
  many-light GPU evidence below remain separate requirements. No speed claim.
- Guiding evidence: guiding.html renders its convergence reference with the guided estimator itself and uses absolute bounds for dim scenes. Use an independent root/analytic reference and justified relative bounds.
- Many-light evidence: restir.html covers diffuse receivers and absorption only. Rough metal, coat and scattering-media vertices need root-reference comparisons with relative bounds.
- Reuse naming: /restir implements per-pixel RIS without spatial or temporal reuse. Implement reuse or rename the entry and documentation; retain the equal-cost work-count question without timing runs during the build phase.
- Fixed resampled README gate: isolated exact-example diagnostic passes the unchanged 20-second deadline on native WebGPU (Dawn). Its trace pipeline takes 15.5 seconds and capture 0.13 seconds, so this diagnostic is not ANGLE D3D11 compilation. The prior failure has no per-phase record; the actual runner selection also passes 1/1 at its unchanged deadline. No readiness wait, capture or deadline was removed.
- Root emitter MIS: the full-distance medium-boundary regression is currently only in the optional restir GPU suite. Add it to the root GPU suite so a root-only run detects reversion.

### Fixed 2026-11-09: owned Chromium close waited on helper programs (SHUTDOWN_TIMEOUT, five lanes)

GPU suites passed every check, then failed with `SHUTDOWN_TIMEOUT`, "still open:
browser", at the unchanged 30,000 ms budget; the pipe repair below did not stop
it. The owned browser was ended by `taskkill.exe` (WMI) and a PowerShell handle
wait started at close time; a taskkill that could not run reported no process
ended, which read as success, so nothing ended the browser. It is now ended
through the handle Node holds, with each process Chromium lists over CDP, and
no helper program runs (`stopOwned` in `scripts/lib/browser.mjs`); `taskkillTree`
reports a failed run as the root still running. Regressions in
`tests/browser-teardown.test.js` reach the same "still open: browser" on the
parent commit. Details and sources: operational playbook, "Owned Chromium ended
without helper programs".

### Batch 171 flow asset accounting

The saved CPU foundation copied `flow.wasm` into dist without registering it in `scripts/lazy-files.js`.
The existing sizes-page bidirectional asset regression fails before the registry correction, naming the
unlisted flow binary (`test-results/sciviz-fixes/flow-lazy-before.log`). Flow now has its own measured file
row and explicit load condition; the required-asset list also pins both sciviz Wasm files. Paired entry/network
records from a coherent clean build pass all eight sizes-page tests, including the previously failing asset
check (`flow-current-records.json`). No provenance flag, lazy asset,
pixel bound or time budget is waived. Earlier full verify failures for preview GL mocks and literal error help
are already repaired and retain their passing regressions. Only the failed size prerequisite is rerun.

### Sciviz moving flow implementation (batch 171 job 1)

The source/exports audit found only steady CPU streamlines with normalised velocity in `/maths`; those cannot
trace moving particles through time. `/flow` now supplies the CPU physical-time pathline reference with
temporal interpolation, analytic/real-NOAA correctness tests, cancellation and bounded memory. GPU advection,
fading trails, seeding/respawn, streaklines and an official moving-flow demo are now implemented. The analytic
CPU/GPU, deterministic replay, all-pixel parity and desktop/mobile real-data browser evidence is recorded in
the operational playbook's moving-flow section. Native WebGL2 flow awaits batch 181; jobs 2 to 6 remain pending.
Batch 171 jobs 2 to 6 are not completed by this foundation. Main's teardown repair and the native surface/rectangle
piece are landed; their complete passing browser evidence is retained. The CPU reference's new README example
and paired size-record gate are validated before its push. [Progress](work-lists/sciviz-progress.md) tracks all six jobs.


### Open: full-layer validation transferred to parity batch 273

Run the following package GPU scripts after building, with `MARGO_COMPAT=1` and
one shared GPU slot. These are open gate failures, not accepted differences or
passing results. The completed native evidence remains separate. The coordinator
assigned these compatibility failures to parity batch 273; the preview lane
finishes its own attachment, translator and DOF repairs without chasing them.

- `culling/test:gpu`: `dynamic-check.mjs` reports 3 to 7 shadowed instance/core
  pixels differing by one channel level after moving boxes. The exact assertion
  stays unchanged. Disabling dithering at device creation did not fix it and was
  reverted. The cause remains under investigation between shadow arithmetic and
  asynchronous frame/resource readiness; it is not proven to be dithering.
- `gltf-pro/test:extensions:browser`: the first KTX2 streaming case compares a
  fully streamed level-zero quad against the plain loader at the same camera and
  gets unequal RGBA buffers (`Buffer.compare` returns -1). The divergence is in
  rendering/capture comparison; a repeat capture of the unchanged plain model
  can also differ, so the precise cause is not yet isolated.
- `gltf-pro/test:gpu:materials`: the all-authored-map shader combined with shadows,
  clustered local shadows and IBL exceeds the adapter's 16 fragment texture image
  units after translation. The fixture counts WGSL sampled textures but does not
  include the layer's storage-buffer data textures. Ownership of a viable route
  or an explicit hardware-limit diagnostic still needs review; do not drop maps.
- Resolved `lod/test:gpu` imposter picking hang (batch 222): mapping waits the buffer's own readback readiness after queued submits instead of adding a device-wide fence. Delayed scheduler tasks leave the event loop idle for WebGL sync status. The unchanged 16384-pick grid and all atlas sweeps pass on both backends; task-polling.test.js retains nonforcing, queued-write and device-loss regressions. No limit or tolerance changed.
- Resolved `materials/test:gpu:features`: the fixture assumed every adapter
  advertises optional `clip-distances`. The canonical leaf now selects native
  and full compatibility explicitly, preserving native rasterizer coverage and
  requiring compatibility discard with the original plane/depth/shadow bars.
  All 15 feature groups pass on both devices. Vertex-inputs was separately
  repaired by observing the engine's actual device (see batch 273 evidence below).
- `materials/test:gpu:more`: the full layer refuses an sRGB view of a BC7 linear
  compressed texture because its view-copy path requires a renderable format.
  Reproduced unchanged in batch-273-more-before.log. CompatTexture.copy and
  Replayer.sync require framebuffer storage, while writeBlocks retains no
  compressed subresource bytes for an alternate upload. The generic repair
  must retain exact blocks and versions across partial writes, copies, mip/layer
  and alias views; post-filter sRGB conversion is not equivalent. This remains
  open; no texture or colour work may be removed. `materials/test:gpu:back-side` also reached the 60 s body
  deadline without output and had its process tree killed. A full-grid owned
  diagnostic now completes the 4-sample work and enters the 1-sample transmission
  cases before its 75 s process-tree limit: 116 render starts, 131 completed
  reads and 38 returned pick calls. This is not a permanently stuck initial
  await. The accumulated cost remains unisolated, and the final comparison
  assertion was not reached, so no pixel pass or busy exemption is claimed.
  Receipt: test-results/batch-273-back-side-probe.log.
- `materials/test:gpu:dispersion`: its circular-resource fixture failure is
  repaired by shallow field identity/value comparison. The complete native grid
  passes 278 checks/254 captures. The complete full-compat grid now reaches all
  comparisons: its sole failure is the 4x live positive-to-zero reset, with 10
  HDR channels differing by at most 0.000244140625 against the exact-zero bound.
  1x reset, live-versus-constructor dispersion, all caller scalar-IOR references,
  resource counts and device-restoration checks pass. Repro after building:
  `node scripts/material-dispersion-gpu-check.js --backend=compat` under a shared
  lock; receipt: test-results/batch-273-dispersion-compat-complete.log and
  test-results/material-dispersion/compat-gpu.json. The material setter writes
  ext[3] back to zero without extra GPU allocation or binding. The remaining
  cause is not isolated between uniform replay and multisample rendering;
  neither a driver cause nor acceptable numerical drift is proven. Failure 9
  stays open; no tolerance, shader math, sample grid or resource work is changed.
  The current full grid reproduces the same failure after the stencil repair.
  A focused zero/unchanged/positive/reset sequence is exact. In the complete
  grid, inserting an unchanged-zero frame makes reset exact but moves the sole
  4x failure to live-versus-constructor (7 HDR channels, same maximum error).
  Recorded COPY_WRITE_BUFFER writes include dispersion 8 then 0 at byte 1436;
  these input bytes do not prove actual uniform binding/readback correctness.
  Receipt: whitepaper/results/batch-273-dispersion-state-checkpoint.json.
  PARKED by coordinator ruling for round 9. The unchanged-zero insertion moves
  the error between two 4x comparisons while the focused sequence and 1x stay
  exact. This is state-dependent, with the uniform-binding versus multisample
  replay/resolve cause unresolved. Resume in the fix phase with a full-grid
  draw-binding and resolved-attachment trace; do not change the exact bound.
- `materials/test:gpu:render-state`: failure 10 repaired in the optional device.
  The earlier signed polygon-offset clamp repair is retained. Dynamic stencil
  references now use the target's low eight bits before GL's signed clamp;
  both faces, bit 31, UINT32_MAX, replacement and reset have regressions.
  The full expanded native and compat grids each pass 616 checks/288 captures
  at 4x and 1x. No assertion or tolerance changed. Durable receipt:
  whitepaper/results/batch-273-stencil-checkpoint.json. Remaining batch failures
  are still open; this does not establish whole-package parity.
- `materials/test:gpu:wireframe`: the current-main compatibility sweep passes
  all 249 checks and 60 captures. A second control using the bitmap upload from
  before c06603fef also passes, excluding that repair as its explanation.
  The earlier mirrored/reference and duplicate-edge failure is not reproduced;
  its precise fixing change remains unidentified, so it is not claimed closed.
- Resolved `materials/test:gpu:normal-map` by c06603fef (bitmap orientation).
  The unchanged complete compatibility suite passes, including derived,
  authored/mirrored frames, lobes and export round trips. Replacing only the
  bitmap upload with its pre-fix implementation reproduces the original dent:
  mesh dome top/bottom 96/222, versus corrected 222/99. Constant tilt remains
  221/75 in both controls. Current source and build were restored afterward;
  no normal-map shader, image, threshold or assertion was changed.

- Fixed `react/test:browser` XR preparation: the supported compatibility XR
  route is installed by the fixture; its complete canonical compatibility suite
  now passes, including simulated stereo pixels, controllers and teardown.

The serial continuation preserves each completed result and resumes only
unfinished suites. Additional full-layer failures are evidence for batch 273,
not passing results or permission to weaken a gate.

The bounded continuation is now complete: 89 of 115 selected correctness suites
pass, combining the preserved 22, repaired clustered lighting, and 66 later
passes. The following additional failures remain with batch 273:

- Fixed `scatter/test:browser:shadow-cull`: observe the selected route's actual
  GPU-written command buffer. The original complete native and compatibility
  driver passes depth, frame and count assertions. Regression: shadow-cull-fixture.test.js.
- `scenery/test:gpu`: resolved capture race. The fixture now waits for compatibility submitted work, preserving native submit-task capture. All original native/compatibility scene, HDR, stars and aurora checks pass at1x/4x; presented-frame.test.js regresses the actual capture order.

- `selection/test:browser`: picking and pick-many finish; `models.browser.mjs`
  prints `occlusion ok` and does not finish before the unchanged 60 s body bound.
  The awaited operation after that marker remains unisolated.
  Current-main sweep: the unchanged models command now finishes inside the
  original 60 s body lease, including both 600-pixel perspective/orthographic
  grids (600/600 agreement), silhouettes, outlines and occlusion. The loop
  immediately after the old marker is the perspective pick/Raycaster grid.
  Main's 48ac02963 readback/task-polling repair covers mapping progress; the
  old hang is no longer reproduced. This does not waive a future timeout.
- Resolved failure 18, shader readback: compatibility compute pipelines did not
  enforce advertised binding limits. Resource counts now reject overflow before
  either compute route runs; asynchronous pipeline errors also avoid assigning
  DOMException's read-only name. Five regressions and the unchanged full readback
  leaf pass on native WebGPU and full compat, including validation and recovery.
- `sky/test:gpu`: sky and dither checks pass; features stop after cloud-shadows
  4x at the 98 s body bound. This mixed fixture also printed frame diagnostics;
  those timing values are not accepted evidence during the build phase.
  Current sweep: weather, volumetric, cloud-shadows, aerial and shafts now pass
  at both sample counts before the unchanged 98 s investigation lease ends.
  A second disjoint run passes the unfinished weather-fx, sleet, astro,
  hillaire, albedo and presets at both sample counts, with teardown. All 22
  feature groups have unchanged passing value assertions; no permanently
  stalled await was found. The monolithic command's 98 s investigation limit
  still expires and is not raised or claimed passed. Frame timings remain
  diagnostics, not speed acceptance.
- `splats/test:gpu`: all GPU checks print success, then the command does not exit
  before its 62 s body bound. This is not a passing suite. Cleanup remains with
  the dedicated teardown owner; no teardown repair is attempted in this lane.
  Current-main sweep: the unchanged complete compatibility command passes and
  exits with the 919fdc09e host teardown mechanism already on main. The recorded
  command duration includes GPU queue contention; it is not a body-time speed
  claim. No browser/shutdown code or teardown bound changed in this sweep.
- Resolved reference selection for failures 21 and 25: the outer forced shim
  replaced the native baseline in seven comparison drivers. Each now opts out
  of that shim and retains its own backend selection. All seven setup
  regressions fail without the fix. The full terrain suite passes natively
  and under MARGO_COMPAT=1, closing failure 21. The six affected compatibility
  comparison leaves pass with that override. Failure 25's original assertion
  is repaired, but its complete package suite is not claimed: it includes the
  tracer compilation assigned to a separate owner. No bounds or work changed.
  Receipt: whitepaper/results/batch-273-native-baselines.json.
- Resolved original failures 22-24: the layer capped adapter array capacity at
  the 256-layer device default. It now advertises actual GL capacity and
  negotiates a separate device limit, preserving the unrequested default.
  The full voxel compatibility suite and both slow-path commands pass their
  unchanged assertions, including layers 256/2047 at 4x and 1x. The separate
  synthetic delay coverage gap below remains open. No texture work was reduced.
  Receipt: whitepaper/results/batch-273-array-layer-limits.json.
- Fixed forced-compatibility slow-compile coverage gap (lane A, 2026-11-10):
  the init script retains its prototype instrumenter and the lazy compatShim
  applies it to CompatDevice before installing readiness counters. Render and
  compute promises now include the requested delay in pending counts; shader
  errors retain identity and release readiness. pipeline-delay.test.js loads
  the real shim against a lazy device fixture and proves the old path schedules
  zero timers instead of the required one. Native and compatibility voxel
  slow-compile acceptance uses the unchanged 500 ms delay and both sample counts.
- Fixed `root/modern:test:xr:browser`: simulated bindings identify the selected
  device and compatibility canvas presentation keeps its output context mode
  when reconfigured between page-backed XR and offscreen devices. Root native
  and compatibility stereo, package pass, depth and AR checks pass unchanged.
  Regression: `packages/webgl2-compat/test/canvas-present.test.js`.

All process-tree bounds and numerical assertions remain unchanged. Logs are
preserved in lane-S's `.lane/compat-*.log` and `.lane/scope-compat-*.log`; the
private batch-273 handoff indexes each suite, failure and suspected cause.

`oit/test:gpu` also reaches ExactOIT's setup refusal on the full layer: it needs
fragment-stage storage buffers and recommends weighted OIT. The base OIT check
passes first. Review the advertised storage capabilities, the existing documented
ExactOIT limit, and its refusal/help contract before changing either test or route.


### Fixed 2026-11-09: voxel memory admission and browser revalidation

The earlier voxel GPU run passed render, bevel, lighting, LOD and coloured-light
assertions, then failed closing `light-rgb-browser-check.mjs` with
`SHUTDOWN_TIMEOUT`, still open: browser, at the unchanged30,000ms budget.
The helper-program repair cf699846f was followed by the independent CDP
list/disconnect ordering repair c0e7053ee. All nine voxel GPU suites now pass,
alongside the decoder/glTF GPU gates. The README gate passes with its unchanged
five known failures; 18 of 23 examples succeed. Full verify passed 13,616 tests
with zero failures/skips before the final main rebase; all 80 scoped rebase
regressions pass. The memory-admission fix landed first as 0d318eb86, followed
by the separate browser repair. No timing proof or completed Basis job follows.
### Open: secondary-scene disposal outside the batch 56 environment repair

The cross-package audit reproduced orphaned FXAA/PostStack effects. With a WebGPU engine,
`const scene = engine.createScene('product'); const effect = new FXAA();
scene.use(effect); effect.dispose();` leaves `scene.plugins.has(effect.name)` true.
The same reproduction with `new PostStack([new FXAA()])` leaves both the stack and
its child registered. A same-name effect in the default scene is also at risk.
Cause: post effect disposal calls `engine.removePlugin(name)` after scene setup
has restored the default active scene. Stack disposal additionally checks child
membership against that active scene. The existing `sceneOf` API can hold the
repair in the owning optional packages; no core change is needed.

The post-package repair now uses sceneOf-based identity for disposal and live
child rendering. packages/post/test/scene-owner.test.js proves default-scene
isolation, owner removal, replacement and failed-setup cleanup. The sibling
effect-owners.test.js reproduces and repairs 22 more classes, including the
DepthTexture wrapper (its internal SceneTargets is not itself registered).
An explicit source guard in verify rejects active-scene removal in post cleanup.
GPU and README acceptance remains pending, so this audit is not closed or accepted.
Direct default-scene disposal call sites outside post still need
per-plugin classification and regressions, followed by their package checks.
Do not treat the batch 56 scene-ownership finding as fully accepted until that
work and the required GPU proofs are complete.

The PostStack peer audit also reproduced the same wrong-scene detachment in
DOF, Autofocus and Tonemap; their local sceneOf repairs and per-package
scene-owner.test.js regressions pass CPU checks, with GPU/README acceptance
pending. Creative PostProcessing also left its registration and passes installed:
it stored only the device and used dispose as restoration's resource-release
helper. Its local repair separates resource release from explicit owner removal;
Painterly now removes its own scene registration too. The creative post-owner
regression reproduces the original failures and proves restoration, owner removal,
same-name isolation and replacement. Physical GPU/README gates remain pending.

The remaining PostStack peer scan reproduced the same active-scene removal in
WideAngle and WideAngleCube, and missing detachment in NodePass (dispose dropped
its engine reference but left registration). Their owning-package repairs have
per-class inert-GPU regressions and a cross-package joinStack source guard.
Physical GPU/README gates and the wider non-PostStack lifecycle audit remain open.

Lane A sweep: all 95 existing scene-owner regressions pass across post, DOF,
tonemap, creative, cinematic, shader and terrain. The concrete disposal causes
above are already repaired in 257c0aaf6, 542bca326, daa740e55, 05f35486c,
02fd42e4c, 6eb490883 and 7239d8752. The broader candidate inventory remains
unclassified; no full-package GPU or manual lifecycle certification is inferred
from these CPU results. README work stays deferred.

### Batch 56 review repair audit

Reported causes: TAA's transient matrix entered the still controller/history key;
planar, image and colour draws omitted per-view state; scene capture and explicit
surface/cube disposal selected the active default scene; ground contact projection
had no HDR direction input; studio normalization overflowed for finite directions.
The repair adds focused regressions and the missing optional directional receiver.
Sibling audit includes cube capture/disposal, backgrounds, output, lighting,
volumetric disposal and external probe baking. No core or stage feature is added.
Validation must finish before these repairs are described as landed; browser and
full-gate results accompany the repair commit.



### Closed 2026-11-09: ray-shadow cutouts (batch 49 job 1)

Cause: ordinary RT accepted a geometric candidate without checking its material
coverage. The optional shadows/rt-alpha path now packs source-face UV/material
provenance and modelAlphaMasks into bvhWGSL's candidate predicate, before closest
or any-hit acceptance. A hole continues the same traversal, including coplanar
or farther candidates. Six RT-alpha CPU cases cover malformed/overflowing data,
wraps, transforms, factors, inclusive cutoff, ownership, restore and cleanup.
All 379 owning-package/included integration CPU tests pass. The registered
rt-alpha-browser.mjs and rt-alpha-attach-browser.mjs GPU regressions pass on the
complete real Khronos cutout model, including opaque controls, quarter-turn UVs,
restored coverage resources and map fallback. Raw counts are retained in the
[attached proof](whitepaper/results/rt-alpha-attach-20261109.json). No core or stage
change was needed.

### Withdrawn 2026-11-09: texture-transform rotation sign allegation

The earlier allegation relied on the extension overview's historical GLSL
snippet as an independent oracle. Khronos issue 1563 and PR 1624 explain that
snippet's sign discrepancy in U-right/V-down coordinates. No Margo sign changes
are warranted: the actual TextureTransformMultiTest production GPU proof passes
both independently authored baked-UV comparisons (max UV error 0.0059999654,
unchanged bound 0.01) and their rendered-pixel bars. Default and quarter-turn
cutout ray/shadow coverage also pass. Keep those independent authored references;
do not replace them with an oracle that repeats the implementation's matrix.
Sources are in [the research record](work-lists/skip-gaps-research.md); actual
[production results](whitepaper/results/rt-alpha-texture-reference-20261109.json)
retain the source-model pin and rendered comparison counts.

### Fixed 2026-11-09: owned Windows Chromium shutdown pipes (batch 160)

ChildProcess `exit` does not establish that its stdio has closed. The shared
browser wrapper awaited exit before driver cleanup, leaving stdout, stderr and
both CDP pipes open and allowing synchronous taskkill to block the unchanged
30,000 ms shutdown timer. It now releases all owned pipes after successful native
termination and awaits a close event latched at launch before driver cleanup.
The four-pipe regression fails before this repair. Native termination also checks
process creation time before waiting, so recycled PIDs cannot spend the shutdown
budget on an unrelated replacement. Both cases have regression coverage in
`tests/browser-teardown.test.js`; no timeout or assertion was relaxed.

### Open: test-page 45 context loss during D3D11 trace compilation

Repro on an RTX A6000 with ANGLE Direct3D11: force-install compatibility,
create an engine, attach the test-page voxel scene and render the raster view.
After the trace render pipeline has submitted compilation, wait one second,
dispose the tracer, then dispose the engine. Tracer disposal returns, but engine
disposal enters WEBGL_lose_context.loseContext and never returns before the
unchanged 180 s hard limit kills its process tree. Immediate attach/dispose
returns; awaiting tracer.ready instead encounters the existing D3D11 compilation
defect below before disposal. These are distinct lifecycle boundaries.

Deleting all 15 tracked programs and 30 shaders after unbinding the current
program returns normally, but does not resolve the context-loss hang. A raw
OffscreenCanvas WebGL2 context reproduces it with only the captured trace vertex
and fragment programs (366 and 134,593 bytes), compile/link, a one-second delay,
a false COMPLETION_STATUS_KHR query and loseContext. No Margo module, buffer,
texture, framebuffer, compute binding or draw is involved in that raw repro.
A simple-program control links successfully and returns from context loss.
All three failing probes end at the same three-minute GPU-lock limit.

The active shader compilation/context-loss interaction is therefore sufficient;
the reported float-target/compute-state leak is not required. The precise
internal ANGLE/driver lock is not identified. This intersects the already
documented monolithic D3D11 trace compilation defect below. A complete repair
must preserve transport, materials, random sequences and precision while making
the route compile and dispose correctly; staged transport is a candidate, not a
completed fix. No runtime change or weakened test is claimed. Evidence and
research comparisons are in testpage-bugs.md and testpage-research.md. Browser
process teardown remains with its dedicated owner; no core change is implied.

Current-main continuation (20375ea56 plus the documentation checkpoint): the
same disposal sequence still hits the 180 s process-tree limit. Replacing the
two large uniform blocks with the existing data-texture representation does
not resolve it. Replacing every uniform block also leaves compilation pending
after a 120 s poll, followed by the same context-loss hang. Making the direct
lighting loop's bound uniform-dependent, with its engine-authored value
unchanged, does not resolve that full program either. None of these diagnostic
transformations is installed in the runtime.

Ownership decision: raw reproduction does not make this browser-only work.
Margo owns submission of the monolithic trace program followed by context loss
while native compilation is pending. A smaller representation belongs in the
optional voxel-pathtracer compatibility route; there is no evidence that an
engine-side prevention is impossible. The browser owns native compiler and
context shutdown internals, whose exact blocking mechanism remains unproved.
There is no cancellation API that would turn a promise timeout into bounded
native cleanup. Do not close this defect by omitting context destruction,
rejecting a renderer by name, removing tracing work or raising a timeout.

New compile diagnostics link the isolated camera, closest-hit, surface,
shadow and glass-candidate trees. A one-light direct evaluation, retaining all
five light-kind branches and exposing every Walk member, also links and the
context-loss call returns. The original combined lighting tree stays pending
at the same poll deadline. A CPU f32 diagnostic compares the combined loop
against five ordered light steps: all 144 cases preserve radiance, the 22-word
reservoir and RNG bits exactly (99 nonzero radiances, 3 populated reservoirs).
These fixtures have no voxel geometry and do not prove glass traversal, a full
staged route, state-texture serialization or GPU output parity. That repair and
the actual failing lifecycle regression remain required; bug 45 stays OPEN.

An additional raw one-light control calls context loss one second after link
submission with completion still false. That call returns before the same
180 s deadline; the whole supervised command completes in 92.2 s. This is a
lifecycle observation, not a speed claim or a responsiveness guarantee. It
supports dependence on the submitted compiler workload and is compatible with
context destruction waiting for compilation; it does not identify a native
deadlock. The initial compile probe's Walk starts empty, so carried-state
compilation is a separate required check. No smaller-program result closes the
monolithic trace defect or permits blocking application disposal for that long.

The stronger one-light probe loads all Walk inputs and the partial light sum
from runtime uniforms, retaining carried reservoir evaluation. Its 60,463-byte
fragment is still incomplete at the 120 s poll deadline; context loss then
returns before the unchanged 180 s process-tree limit. The command fails its
compile-completion check (176.1 s overall), not the outer supervisor deadline.
Thus the empty-reservoir success does not prove a bounded complete transport
stage. A finer split, including the final reservoir/BSDF evaluation, needs proof.

Cause (bug hunt, 2026-11-09): the hang is the trace program's compile, and
context loss waits for it. Both raw probes whose loss returned did so only
after tens of seconds (92.2 s and 176.1 s commands), and the trace program's
`D3DCompile` does not finish within 3,000 s (entry below), so its loss does not
return. The same ANGLE HLSL, captured with `WEBGL_debug_shaders` and compiled
by the Windows SDK `fxc` on the CPU, reproduces the non-finishing compile with
no browser or GPU. The compiler's time grows much faster than the code:
calling `cameraRay` 1, 2 and 4 times takes 3.2, 17.1 and 89.7 s, and `closest`
1 and 2 times 36.6 and 130.8 s. `/Od` is no faster (55.6 against 61.7 s), and a
stubbed program that folds to 14 instructions still takes 119.5 s, so the time
is spent on the inlined source before dead code is removed. `[loop]` on every
loop and a table in place of the trig-reduction switch lower the constant only.
In traversal, stubbing `march`'s shape cut and cut-through takes `closest`
from 40 s to 11.5 s. Full table and method: testpage-research.md, "Bug 45 hunt".

What this rules out: no shutdown-side change in Margo can bound the wait
within the rules. Parallel compilation has no cancellation, and skipping
context loss, rejecting a renderer by name or raising a limit are excluded
above. The fix is the wavefront split listed under "The path tracer never
compiles on ANGLE Direct3D 11", with a size budget per compiled program: at
most one traversal and one copy of the precise camera maths in each, since one
traversal alone costs 25 to 40 s here and doubling the code costs 3.6 to 5.3
times as much. A smaller shape-cut/cut-through block in `march` belongs to the
same work. Bug 45 closes with that split plus a disposal-during-compilation
regression on ANGLE D3D11; it stays OPEN until then.

### Fixed: test-page 36 retained mesh transforms and 32 Label diagnostic

Mesh fields were readonly only in TypeScript: JavaScript assignment replaced refs
without updating the store and corrupted inspector snapshots. Core now guards
all three refs at construction with a coded TypeError. No optional package can
guard every mesh. `core/tests/transform-refs.test.js` fails before, passes after,
and checks store growth, identity, supported mutations and snapshot restoration.
Core + stage: 23,837 to 23,924 B gzip. Label.position now rejects replacement
with the same coded TypeError, retaining its getter-only declaration and existing
setPosition behaviour. labels/tests/testpage-position.test.js fails before and
passes after; it also pins use of the declared shared math dependency. Labels
measure 5,450 B gzip, below the unchanged 5,546 B entry budget.

### Closed: sciviz review validation after main's teardown repair (2026-11-10)

Main contains cf699846f and 20375ea56. This lane revalidated the review-only
tree, without the later native drawing or temporal-flow pieces: all 30 base,
13 bricks, 10 entry, 6 restoration/cancellation and 28 demo cases pass with
successful browser teardown. The full sciviz README gate passes all 18 examples
under the unchanged 20-second page budget. All eight head/star captures at
390 x 844 and 1440 x 900 were visually reviewed on both backends; axis titles,
ticks and colour bars remain separated. New screenshots retain the 8 CSS-pixel
assertion. Evidence is in test-results/sciviz-fixes/resume-review-*.log and
test-results/sciviz-demos/. No teardown code was duplicated here.

The stale size/network pair was regenerated from the same build with matching
commit/dirty metadata. All eight unchanged sizes-page tests pass. The prior full
verify's sole failure was this record gate; only that failed step was rerun as
requested. Core + stage remains 23,924 B gzip under the unchanged 25,000 B cap.

### Corrected: native sciviz missing-data parity and resource lifetime

The review fixes are on main through 7289abf3b. Teardown is fixed on main and
the CPU-only hold is over. This local native drawing piece now passes the strict
eight-image WebGPU/native-WebGL2 parity gate, including actual context loss,
live reboots, hostile GL state and disposal with NO_ERROR. The root measures
36,916 B gzip (previously 36,802 B) and /webgl2 4,476 B (previously 4,288 B).
Scott's optional-size ruling raises their ceilings from 36,802/4,442 B to those
measured sizes. Another split would add an artificial shader loader and divide
GL-generation ownership. Readable shaders and full errors are retained; only a
local GL receiver alias survives the stopped size work. Pixel bounds and timeouts
are unchanged. Native drawing remains an incomplete feature: axes,
points/lines, volumes/slices, integrated CPU isosurfaces and real demos are pending.

The gate first stalled because its promise resumed inside webglcontextlost
dispatch; restoration is forbidden until dispatch completes. A MessageChannel
task fixes the test protocol without a sleep, retry or increased timeout. Then
the unchanged pixel gate exposed an initial-frame clear missing outside the
native first-view scissor (35,148 black pixels), plus undefined NaN arithmetic
and partially clipped missing-sample triangles. The preview now initialises the
whole first frame after validating draw rectangles. Both surface shaders reject
complete missing triangles and use finite one-sided differences beside a missing
sample. Native resource disposal ignores an entire already-invalid context
generation, using its linked program as validity witness; current owned programs
are unbound before deletion. Errors-page coverage also exposed missing sciviz
literal help messages, now registered against the existing regression.

Evidence: resume-webgl-native*.log, resume-webgl-parity-fixed.log (NaN failure),
resume-webgl-checkpoint-native.log (pass), webgl2-pixels.json and webgl-sizes.json
under test-results/sciviz-fixes. All 346 scoped CPU tests pass. The final browser
gates pass 30 base, 13 bricks, 10 entry, 6 restoration/cancellation and 28 demo
cases; the separate preview suite and all 32 sciviz/webgl2-compat README examples
pass. The full 972-item quality size gate passes after the explicit optional
ceiling revision. Final evidence: ruling-final-*.log/json and ruling-size-gate.log.
Only the failed size prerequisites are rerun; prior full verify, lint and hygiene
results are retained as requested. Paired entry/network records accompany closure.

### Fixed 2026-11-10: per-voxel half-float allocation churn

The bricked README investigation found real conversion work, rather than a non-settling read: the exact
320 x 200 parent/current fixture completes with the same 62 reads and 15,796,312 source samples over two frames.
The scalar half encoder allocated two typed-array views per voxel, including border copies. Its reusable four-byte
bit-cast buffer now removes 574,992 temporary views per default brick without changing the loops or output bits.
`tests/f16-allocation.test.js` fails on the parent allocation count and verifies every half word and rounding ties.
All 18 rebuilt README examples pass their page budgets and the overall gate now exits successfully.

### Fixed 2026-11-10: GPU lock directory deletion contention on Windows

A sciviz validation waiter failed with `EPERM` creating `gpu.lock/mutex`. Mutex-name retirement already prevents
new clients from deleting that reusable name, but the parent lock directory is still removed when empty and older
clients can delete mutexes in place. Windows reserves either name until the last open directory handle closes.
Directory creation now treats this Windows state as bounded lock contention (at most 10 seconds), while other
errors and persistent permission failures still surface unchanged. `tests/gpu-lock-mutex.test.js` holds a real
Windows directory delete-pending, proves acquisition resumes only after closure, and checks permanent failures.

### Sciviz review repairs (2026-11-10)

The review's exact head MRI reproduction lost isosurface uniforms, layouts, vertices, field and compute context on
device replacement; Figure also kept its old context. Reconstruction now invalidates old work and rebuilds the
last committed CPU-backed surface. The audit found the same missing hooks on meshes, graphs and map tiles,
and stale initial heights after `setHeights`; their latest CPU state is retained and rebuilt. GPU-only arrays require
caller recreation and their lost bindings are suppressed. `restoration-browser.mjs` and `entries-browser.js`
exercise actual replacement devices on both backends.
The held `[4,4,4]`, two-frame read reproduction canceled only a readiness waiter, leaving publication active.
Active frame cancellation now aborts source signals and restores the selected frame to the displayed one before
late reads can complete; unit and real-backend regressions continue rendering after release.
Phone axis offsets were data fractions, so shrinking the viewport collapsed title/tick spacing. Axes now use
measured screen-space spacing; `demos-browser.mjs` checks every visible label at both requested sizes/backends.

### Fixed 2026-11-09: decoder Node Basis README example

The Node `nodeKTX2` example used a page's `document` and fetched the placeholder
`example.com/helmet.gltf`. Its grandfathered fetch failure let the README runner
exit successfully without executing that example. The initial repair created a real Node GPU
binding and headless canvas, disposed both scopes, and loaded the pinned published
StainedGlassLamp Basis sample. Its scoped decoder/glTF
README run executed all 43 examples with zero failures; the runner regression test
requires this example to select Node and treats any execution failure as a gate
failure. No decoder algorithm changed in this documentation repair.

The missing-input audit independently reached the same repair before that branch
landed. The merged example uses the already required complete FlightHelmet Basis
family for exact cache/hash failure checks and a full Node GPU integration proof
(15 textures and 177 mips). Both lanes' host and failure-gate regressions remain;
this is one exception closure, leaving 48 overall. See
whitepaper/results/readme-node-basis-20261109.json.

### Open: batch 133 default replacement remains incomplete

Lane A current-main audit: the default and native regression command passes
28 tests; draco.ts still selects the prebuilt wrapper/Wasm. The missing
specification-derived rules below remain an open replacement build, with the
existing crafted-input black-box authorization. A passing default decoder
does not complete or waive any replacement rule, corpus or quality bar.

This is a replacement prerequisite, not a newly observed failure of the shipped decoder.
Reproduce the source gap by following the published specification's connectivity
dispatch for header encoder type 0, or its attribute decoder for generic,
no-prediction and uncompressed integer payloads. These paths lack complete decoding
rules; the [source review](clean-room.md#draco-replacement-specification-review-batch-133-2026-11-09)
records the exact sections. Cause: the permitted specification does not define all
required behavior. Scott's 2026-11-10 ruling authorizes crafted-input black-box
experiments to infer the missing rules, with each rule and experiment recorded in
the source ledger and private plan. No implementation source may be read or used.
The remedy is the full Rust/Wasm decoder followed by all comparison and quality
gates. The existing prebuilt files remain and batch 133 stays open.

### Fixed 2026-11-09: batch 133 prediction-degree seed coverage

Unshipped crate only. The traversal incorrectly shared depth-first's early
visited-face check. The specification's prediction-degree entry visits all three
seed vertices before checking the face. A capped fan could therefore leave a
vertex unmapped and reject an accepted stream. Removing that early return fixes
the cause. The retained 247 predictor cases include the 12 historical/current
failures, and 42 raw canaries independently cover fan sizes and disconnected
components. Native and Wasm regressions pass without changing expected output.

### Fixed 2026-11-09: batch 133 metadata length and retention

Unshipped crate only. The specification prints a UI8 metadata value length,
whereas crafted black-box canaries establish varUI32. The prototype misread long
values, discarded all metadata and imposed a recursive 64-level ceiling. It now
retains file/attribute roots, keys, binary values and child references in a flat
arena, with iterative parsing and destruction. The 1,024-byte regression fails
before repair; 41 exact native/Wasm cases include 32,769-byte values and depth
129. Public name conversion remains part of the uncompleted integration gate.
`packages/decoders/tests/draco-native.test.js` runs these and the traversal,
prediction, KD and memory regressions through `verify` and `check:merge`, with
hard process-tree limits and no skip when Cargo is unavailable.

### Open: batch 134 Basis replacement remains unverified

Lane A current-main audit: the retained default codec route passes its CPU
regressions as part of the 28-test decoder/native run. This establishes no
replacement identity, quality equivalence, fuzz, memory or GPU acceptance;
those build prerequisites below remain open. No timing was measured or reused.

Scott's ruling dated 2026-11-10 resolves the earlier byte-choice prerequisite:
require identical output where specified and per-file quality no worse than the
old transcoder where encoding choices are open. The old BC1/BC3-alpha/BC4/BC5
objection is no longer a blocker. No new shipped decoder defect is claimed.
The [prebuilt baseline](whitepaper/results/batch-134-prebuilt-baseline.json)
contains 51 files and 699 successful file/target pairs, with all-image hashes,
cold/warm control timings, startup phases and isolated memory measurements.
Source-image quality now covers 685/699 pairs and 9,477/9,491 images across
all 21 served target readers. Fourteen AGI pairs lack source pixels and 12
alpha3 pairs remain provisional. The original 186 base metrics are unchanged.
The manager accepts this baseline to start job 2; final replacement gates remain.
Separate timing/startup/memory passes now cover vendor and built static-embind
glue. Their 9,491 image hashes and 186 source-quality measurements match; shipped
targets use built glue. The retained vendor pass is control evidence.
There is no replacement implementation, replacement identity, paired speed,
hostile-input fuzz or GPU proof. Keep the prebuilt until every gate passes.

The baseline's source rights also remain open. The original uncompressed AGI HQ
atlas and alpha3 alpha plane have not been located, and the image-use grants for
AGI HQ, Kodak and Memorial Church have not been established. The HDR fixture
NOTICE's OpenEXR/BSD attribution for Memorial Church is unsupported: the matching
source is the EXR in the pinned Basis v1.50 asset set, not the current OpenEXR
sample collection. The cause is missing original asset provenance and grant
records; a codec repository's code licence does not establish those image rights.
The manager directs replacement of these files with openly licensed assets
exercising the same formats and features, without waiting for grants. Preserve
this historical snapshot and record each replacement and its coverage. Missing
or provisional source metrics are not passing replacement evidence.

The [active licensed corpus](whitepaper/results/batch-134-active-corpus.json)
replaces the AGI atlas, alpha3, Kodak03 and Memorial cube with CC0 assets of the
same dimensions, input formats, alpha/cube features and mip counts. All 699
served pairs and 9,491 images now have source metrics, with zero provisional
pairs. The four replacements account for 45 pairs and 250 images. Three .basis
files use real FlightHelmet image content; the HDR cube uses an analytic light
field. The historical baseline is retained, and its timings are not transplanted
onto new inputs. Replacement timing and the transcoder's acceptance gates remain.


### Fixed 2026-11-09: batch 133 crafted capped-fan point mapping

Unshipped development crate only. The retained 548-case connectivity fixture
exposed 31 capped-fan point/index mismatches. A non-triangular interior cap can
make an opposite walk leave a vertex's fan. The old boundary update then moved
that vertex's representative onto another vertex, changing seam deduplication.
Boundary representatives now stay on their own vertex; corners not visited by
deduplication keep the oracle's initial point zero. Closed walks retain their
original representative as the published algorithm requires. All 548 retained
cases and 182 newly accepted held-out caps match exact native/Wasm point counts
and ordered indices. No expected result or assertion was weakened. Reproduce
with `cargo test --offline --locked --manifest-path
packages/decoders/native/draco/Cargo.toml --lib` and the 730-case Wasm topology
check. Probe/output hashes are in
[the inference checkpoint](whitepaper/results/batch-133-inference-checkpoint.json).

### Fixed 2026-11-09: batch 133 prototype peak allocation lifetime

Unshipped development crate only. Prediction retained connectivity, mappings and
portable parent positions while allocating final attribute arrays and point
ordering. On the original corpus its Wasm linear memory grew to 23,789,568 bytes,
exceeding the prebuilt's 20,185,088-byte target. Releasing those owners immediately
after reconstruction lowers the same corpus peak to 18,874,368 bytes, with all
454 native/float payloads exact. `packages/decoders/native/draco/tests/wasm-memory.mjs`
checks two pinned ABeautifulGame streams, full oracle-derived output hashes and
three decode/free rounds against the unchanged ceiling. It fails on the saved
pre-fix build at 23,789,568 bytes and passes on the repaired build. Process RSS,
other performance targets and exhaustive feature coverage remain separate gates.

### Fixed 2026-11-09: batch 76 transition review

Built-in/custom composites used viewport-local UVs to address full-target captures, reading uncaptured pixels in offset views. They now derive capture UVs from absolute fragment positions. viewport-browser.js compares spatial colors against baseline at idle/0/0.5/1 across all built-in kinds, custom and mask, at 1x/4x, including preservation outside a stacked scissor. Live target validation omitted the fragment output's format domain, so integer/depth targets could advance source scenes before invalid GPU work. A shared float-color/resolve check now rejects those formats before live allocation or updates and also guards frozen-frame capture. live.test.js, live-browser.js and transitions.test.js cover this class, including non-resolvable 32-bit float 4x outputs. README and limits document custom WGSL's trusted-author requirement and fixed resource interface; real-compiler regressions accept costly code without dispatch, reject reachable extra resources and distinguish unused declarations. No core/stage change.

### Fixed 2026-11-09: five executable README exceptions

React's first scene reached raw CommonJS modules in the page runner; React dependencies are now prebundled.
The picking test was tried in the browser after its Node run failed against a nonexistent server. It now hosts its
own React scene and waits for GPU frames and the picked state in Node. Browser drivers that exceed their deadline
fail instead of passing as an ongoing server. Stage's basic glTF example was given an animated fixture because
the runner selected static files by package name; it now selects by imported loader. The worker page's named
companion source was never written; isolated per-program folders now contain its compiled worker. The text atlas
did not exist; a generated, licensed Source Sans 3 SDF atlas and its relative PNG page now accompany the README.
All 40 scoped examples execute without exceptions. Regression coverage is in tests/run-readme-examples.test.js,
tests/readme-assets.test.js and packages/text/tests/rich.test.js; the text GPU suite fetches and renders the atlas.

### Fixed in batch 76 continuation: transitions scene disposal

Transitions.dispose removed the active scene's plugin by name instead of its own registration. It now resolves its owning scene through engine.sceneOf(this) and removes only that registration. Disposing an already removed or unattached instance leaves other scenes alone. packages/transitions/test/scene-disposal.test.js fails against the old implementation; test/gpu-browser.js checks two actual scenes, preserves the default effect and renders both after disposal. No core change was needed.

### Fixed in batch 68 draft: tiny triangle area underflow

Squaring cross-product components before their norm rounded representable tiny triangle areas to zero.
The Poisson sampler uses scaled `hypot` norms. `packages/procedural/test/poisson.test.js` checks that a triangle
with 1e-150 edge lengths yields one point. Cross products that themselves round to zero remain a documented
float64 geometry limit (LIM-621).

What is known to be wrong or not yet proven, and what it would take to close each item. Design limits (where a
boundary is a decision, with its escape hatch) live in [limits.md](limits.md); this page lists defects and checks that
are still open.

### Fixed 2026-11-09: VDB empty half-value blocks shifted the next node

The pinned OpenVDB website sphere and smoke samples exposed a read of an eight-byte compressed-size prefix
when a half-precision node has zero stored values. That prefix is absent; consuming the next node's bytes led to unknown
value kind -1. The owning VDB reader now consumes no bytes for an empty value array. Its synthetic writer had
mirrored the error and now emits the actual layout. ZIP/Blosc empty-node tests and a required, licensed real
sphere regress the failure, comparing leaf count, active voxels and bounds with stored metadata.

The old libigl/Cosmic Blobs knight fixture has no verified licence grant. It remains solely because held physics
tests and the existing benchmark workload read it; this audit does not replace those workloads while physics
is on hold. Loader comparisons now use explicitly LGPL-licensed Geomview files.


### Fixed 2026-11-09: SQL-store integration cleanup kept verify alive

The newly landed SQL-store restart test registered folder removal before its second server/database cleanup.
Windows refused to unlink the still-open `world.db` with `EBUSY`; that failed hook prevented the later cleanup,
leaving the listener and two generator workers alive. Verify's unchanged watchdog named the file and killed its
process after 360 silent seconds. The test now uses an `AsyncDisposableStack` in the test body, registering each
resource as it is created, so all resources are disposed before the folder hook and on failed setup. An actual
server/database failure-path regression checks database closure and immediate file removal. The parent diagnostic
reproduced `EBUSY` and the live server/worker ports; the repaired seven-test file exits normally with no skips.

### Batch 99: exact parity and noise-free disocclusions remain unproven

- **Job 1, repro:** voxel-pathtracer's README and `tests/magicavoxel/` record subsurface differences of 7-16 display levels, glass over a lit floor 1-2 levels brighter, and atmosphere residuals. The renderer uses a fitted single-density random-walk subsurface model and a fitted single-scattering atmosphere; neither establishes the external editor's full transport model. No checked-in repeatable zero-error image oracle exists. These partial implementations do not satisfy exact pixel parity. Closing this needs an external black-box reference corpus across density, glass and atmosphere settings and a root-cause transport comparison, without changing the oracle or its zero-error requirement. Job 1 remains BLOCKED.
- **Job 2, repro:** `tests/browser-check.mjs denoisehistory` and the README's viewport measurements retain noise on newly uncovered surfaces after a camera move. Reprojection has no valid history there, and a finite noisy first-frame spatial estimate cannot in general recover an arbitrary hidden radiance field exactly. Schied et al., [Spatiotemporal Variance-Guided Filtering](https://research.nvidia.com/sites/default/files/pubs/2017-07_Spatiotemporal-Variance-Guided-Filtering%3A/svgf_preprint.pdf), section 6, also reports low-light and motion limitations. The existing classical temporal filter is partial coverage, not the requested noise-free guarantee. A repeatable disocclusion oracle and an algorithm meeting that guarantee remain missing. Job 2 remains BLOCKED.

### Batch 99 caustic guide scope

Job 4's optional caustic guide is independently covered by `packages/voxel-pathtracer/tests/guiding-browser.mjs`. Its finite deflector table and geometry-prior variance trade-off are design limits in the README and `docs/limits.md`; they do not close the separate job 1 parity or job 2 disocclusion defects above.

### Batch 99 parity continuation: gamma correction and unresolved subsurface transport

The mapping's fixed exponent 2.2 decoded palette and light colours incorrectly when `_film _gam` changed.
The corrected decoder accepts the file gamma; `magicaVoxelLighting` applies it to light and display surface
colours. `magicavoxel.test.js` has regressions that fail on the former build, and
`tests/magicavoxel-gamma-browser.mjs` requires exact measured output bytes on native and compatibility backends.
Record: `docs/whitepaper/results/batch-99-parity-gamma-20261109.json`.
This fixes that colour conversion only. In the recorded 16 x 16 base / 8 x 8 x 6 subsurface block, the corrected
4,096-sample render still differs on 180,988 pixels from the external 1,024-sample reference, with RGB absolute
error 7,398,780. The existing cloud model has no diffuse surface interface and still shows broad soft edges.
Chiang, Kutz and Burley 2016 describe the distinction between apparent surface albedo and single-scattering
albedo with a diffuse interface. That is a candidate transport cause to investigate, not an established match.
Neither this record nor the gamma fix closes exact parity. The full zero-error oracle remains required.

### Fixed in batch 99: media-boundary emitter MIS distance

The root voxel tracer used the final ray segment's `h.t` to convert the emitter PDF to solid angle after crossing a medium without scattering. NEE used the whole vertex-to-light distance, so the two MIS shares did not sum to one and over-counted energy. The tracer retains the last scattering position and uses its full distance for both voxel emission and area hits. `packages/voxel-pathtracer/tests/restir-browser.mjs` compares an absorbing half-block slab under a square light against independent quadrature, for both light types and both native WebGPU and compatibility. Before the correction, voxel emission averaged 0.756703 against about 0.69 physically expected, failing the unchanged 0.02 bound. The many-light 2x requirement is unchanged.

### Fixed 2026-11-09: missing evidence could pass verification

Environment EXR/HDR comparisons, six loader fixture checks, the meshopt LFS buffer check, COLLADA's
animation integration and exporter validation could skip or return successfully when required inputs
were absent. Texture encoder and Python setup absence could also report skipped success. The cause
was treating required test evidence as optional. Fixture reads now fail with a path and recovery command;
the validator is mandatory, imports propagate missing-build failure, and Python setup failure exits
unsuccessfully. `tests/fixture-skips.test.js` regresses missing files, LFS pointers, HTTP/size/hash failure
and executable skip/return patterns; `tests/python-venv.test.js` checks missing Python even with strict
flags unset. [The inventory](work-lists/missing-test-items.md) separates batch 160, held physics and
remaining unverified real-file variants. Their proof gaps are not claimed fixed by the gate.

### Open, outside Margo, worked around 2026-11-10: Windows finishes tearing down an ended Chromium process late under GPU load

- **Repro:** browser suites under machine load (8 to 12 Codex lanes, 3 GPU slots busy, RTX A6000, Windows 11, Edge): `SHUTDOWN_TIMEOUT` naming `Chromium process/stdio close (<pid>)` after every check passed. Batch 171: `test-results/sciviz-fixes/derive-integrated-root.log` in lane-X; batch 160 (`check:readme-run`) and batch 234 the same. Never seen on a quiet machine (five quiet runs in lane-A, 2026-11-09). The earlier entries below (capture-browser, batch 160) were this.
- **Cause, measured 2026-11-10 (lane-Q, 40 cycles of launch, GPU work and close beside the running lanes, `MARGO_TRACE_SHUTDOWN=1`, loop at `.lane/shutdown-loop.mjs` of that worktree):** after `TerminateProcess` the browser's exit code is set 50 to 65 ms later in every cycle, and every owned pipe (stdout, stderr, both CDP pipes) closes within 1 ms of its `destroy()`. The process object is signalled (Node's `exit`, then `close` 1 ms after) 65 ms to 1,172 ms later in those cycles, 8.7 s in lane-A's control beside `verify`, over 30 s in the failures. That gap is the kernel's teardown of the process after its threads are gone (its handle table and address space, which the GPU driver's cleanup is part of). The suite's event loop was never blocked (a 50 ms heartbeat saw no gap over 400 ms) and Playwright started no helper program (every child_process call was logged). Nothing in Margo runs during that time: it is Windows, Edge and the driver under load, which Margo cannot fix. Playwright's `BrowserServer.kill()` (observed as a black box) waits for that same signal and keeps its WebSocket server listening until it arrives, so an in-process server tied the suite to it.
- **Workaround (the mechanism is gone, not the symptom):** `scripts/support/browser-host.mjs`. Playwright's browser server now runs in a host process of its own, which holds everything that waits on the browser process (its handle, its pipes, the WebSocket server, the temporary profile). The suite keeps the same connected browser as before. At close it reads Chromium's process list while connected, the host ends every process (`TerminateProcess` through its handle, each listed child by pid) and acknowledges at once (3 ms measured), the client disconnects (3 ms), and the suite waits for the host's proof that all are gone only up to `TEARDOWN_GRACE_MS` (2,000 ms). Past that the host carries on alone with the native waits, finishes Playwright's cleanup, and after `REAP_MS` (120 s) records any survivor in `test-results/browser-host-survivors.log` and ends. The 30,000 ms budget, the 5,000 ms process-list bound and every assertion are unchanged; no retry, no raised budget, no swallowed error (a host that dies fails the close with `HOST_GONE`).
- **Evidence:** 40 cycles on the new path under the same load (2026-11-10 01:32 to 01:34): 0 timeouts, 0 leaks; close 347 ms median, 2,130 ms maximum; 5 cycles handed off at the grace, in which the kernel needed up to 9.3 s after the close to finish with the browser (cycles 33 to 35: 9,338, 4,950 and 5,230 ms), every browser, child and host process gone by then and no survivor file written; no Node process or pipe handle left in the suite. `tests/browser-host.test.js` (a real host process; a browser the kernel never finishes with is logged as a survivor at the bound, in the host) and `tests/browser-teardown.test.js` ("a browser process the kernel has not finished tearing down cannot hold the close past the grace"; the in-process design it replaces asserted `SHUTDOWN_TIMEOUT` for that case in its own test, and `tests/browser-host.test.js` runs it through `launchBrowser` against a real host whose browser never exits).
- **False survivor, fixed 2026-11-10 (batch 217, lane P):** the host's waiter reported a listed child as a survivor 677 ms after the end, which failed the close with `SHUTDOWN_TIMEOUT` at `scripts/lib/browser.mjs:344`. The waiter read each pid's start time to tell ours from a newer process, and took a start time it could not read (PowerShell's getter gives `$null`) for a survivor. Measured as a black box: a process the waiter has found and the kernel then finishes with has no readable start time (its object already signalled: `WaitForExit(0)` true), while every process Chromium starts as this user stays readable through its teardown (9 of 9 listed; an 8 GB process killed mid-read stayed readable until it was gone); and 135 of 958 processes on the dev PC (services such as svchost, WmiPrvSE, SearchProtocolHost) are unreadable, so a pid such a service takes over was reported too. Both mean the pid names no process of ours, so the waiter now skips it. A survivor is still reported only after the waiter's bound. Regressions in `tests/browser-teardown.test.js`: "Windows waiter: an ended process gone before its start time was read is not a survivor" (the race widened by ending the process between lookup and read) and "a pid held by a process this user cannot query is not reported as ours" (pid 4); both fail on the parent with the pid reported.
- **Still open:** why the kernel takes over 30 s in that machine state is not Margo's to find or fix. A line in `test-results/browser-host-survivors.log` is the signal to look at the Edge version or the driver; the GPU slot is released while the kernel may still be freeing the ended browser's allocations (docs/limits.md).

### Fixed 2026-11-08: text extrusion API report

The batch 110 baseline `npm run verify` found that the text extrusion repair changed
`classifyLoops` to accept readonly loop arrays while its committed API snapshot still
required mutable arrays. Regenerated `api/text.extrude.api.md` from the built declaration;
`npm run api:check` checks the snapshot against the public declaration without changing it.
The runtime and the accepted inputs are unchanged by this documentation repair.

### Fixed 2026-11-09: audio listener camera poles

Camera following omitted camera.up, making exact Top/Bottom views collinear with the listener up vector. Ambisonic decoding then threw from the frame pass. The listener now follows camera up and beds retain a valid decoder basis through degenerate manual poses. The regression in packages/audio/tests/ambisonics.test.js checks exact poles, roll, first-use degeneracy and later-source updates.

## Own 2D physics acceptance gaps

The contact support-ceiling defect is fixed by the sustained-support correction below under Fixed 2026-11-08.
The required centered 1:1000 contact stack now uses the unchanged sag, drift, creep and sleep predicates.
Its constitutive bending limit is documented in [limits](limits.md#own-2d-sustained-contact-support).
Owned-2D CCD remains the separately assigned Rapier parity row T-11 / 127.y.

### Fixed 2026-11-08: direct Rust solver call bypassed input validation

- **Repro:** on `bf40cdace`, step two touching boxes once, set
  `world.contacts[0].manifold.count = 3`, then call the public
  `margoengine_physics2d_kernel::solver::solve(&mut world, 1.0 / 60.0)` directly.
  It panics at `solver.rs:371` indexing point 2 of a two-point array.
- **Cause:** current-data ownership, handle, count and numeric preflight lives only in `World::step`;
  the public solver entry assumes that preflight already ran. Direct callers can bypass it.
- **Fix:** both public entries share the original input and derived-output checks. `World::step` uses a
  private already-checked entry, retaining its single preflight and separate post-sleep check.
  `tests/solver_input.rs` covers malformed direct inputs, finite-input overflow and error recovery;
  a private scalar/SIMD oracle compares complete valid body/contact/cache/joint bits against the old
  algorithm. The existing Wasm `check(i)` also exercises count/handle/nonfinite refusals, recovery and
  derived overflow. The frozen expected-red reproduction remains in lane P's `direct-solver-input-v1`.

## Rendering

### Fixed 2026-11-08: scatter interaction input conversion and teleport wrap

Trampling validated JavaScript numbers rather than their GPU representation: tiny sizes made infinite cell scales,
huge radii overflowed on upload, sparse vectors passed `every`, and a rejected list could partially overwrite the
last successful list. Validation now checks every element and its float representation before changing the upload.
Camera displacement was converted directly to Int32, so a 2^32-cell teleport reused stale pushes. Displacements are
now clamped at the field side, where there is no overlap. All three tests in
`packages/scatter/test/interact-inputs.test.js` fail against the parent implementation and pass with the fix;
`packages/scatter/test/interact.browser.mjs` additionally checks that a nonoverlapping teleport clears every field cell.

The audit also reproduced a finite offset of 1e30 with radius 2e30 producing no push: `length(offset)` overflowed when
squaring its components. The kernel now detects unrepresentable differences as outside any finite radius and scales
the remaining offset before measuring length, retaining direction even with radius 2e38. GPU assertions compare every
cell against a CPU reference for both cases without changing the existing tolerances or stamp/recovery/pixel checks.
The inherited scatter attachment error also lacked its help link. Unsupported native WebGL2 and disposed instances
now report their coded reason with `errors#scatter`; the GPU suite exercises an actual native WebGL2 engine.

### Fixed 2026-11-08: creative targets workspace GPU launch

`npm run test:gpu:targets --workspace @margoengine/creative` started its browser server in the package directory and returned HTTP 404 for the repository's test page. The targets harness now resolves its repository root from its module URL before starting the server. `packages/creative/tests/targets-launch.test.js` invokes the harness from the package directory with a browser stand-in that asserts the served root. The real GPU command separately checks all target subresources.

### Fixed 2026-11-08: meadow phone quality label and stale DPR fixture

`applyQualityTier` intentionally renders phones at DPR 1. The meadow treated every single-sample tier as
mobile, then its nonzero margoLow made the label say Desktop light. Its older GPU fixture and the creative
README still expected a phone DPR cap of 2. The demo now uses the returned tier for the phone label and
documents DPR 1. `scripts/modern-grass-tests.js` asserts the exact phone label and exact DPR 1 on an actual
mobile browser context; the existing pixel, interaction, device restoration and teardown checks remain.

### Fixed 2026-11-09: lighting2d repair byte ceilings

Scott approved the six measured ceilings exactly: "Approve new size" (2026-11-09).
Root/soft/cookie/GI/height/emissive are 5,394/5,901/7,350/8,589/6,832/4,087 B min+gzip, with no headroom.
The repair removed 293 B without dropping work. The 3,273 B increase and the work it buys are recorded beside the
lighting2d rows in [limits.md](limits.md). All correctness regressions and normal quality gates remain enabled.

### Fixed in lane C: lighting2d GI review findings 3..7, 12 and 24

The replacement uses spatial probe grids, radiance/transmittance interval composition and a distinct visible connector
to every interpolated child interval (Osborne/Sannikov appendix A). It evaluates every requested cascade and finite
surface bounce order. Opaque emitter intersections stop transmission. Direct-light storage uses explicit 16-byte groups;
point, spot and directional semantics, masks, layers and shadows match the CPU. Pixel cameras keep their top-left origin.
`gi-regressions.test.js` and `gi-regressions.js` assert opaque-wall and sealed-source darkness, unit energy inside an
opaque emitter at all eight cascade counts, far sources beyond level three, distinct bounce orders, nearest-source
occlusion, analytic circular-source angular measure, light kinds/masks/layers and resource lifecycle.
Original d97d79d67 GI fails 21 of the first 37 new Node assertions and the new GPU value assertions.
The byte ceilings above are approved; all normal checks are required before pushing.

### Two identical runs of GlassVaseFlowers can differ on a few pixels

- **What:** the same model, camera and sorted path, built twice in one page, differed on fewer than 8 of 147,456 pixels
  by up to 9 of 255 at 4x MSAA, in one of six Khronos models tried (RTX A6000). Seen once on TransmissionTest too.
- **Repro:** `node packages/oit/test/gpu/real-check.mjs`; the `repeat` field of each model's line.
- **Cause, not found:** the frame's inputs are the same; the model holds both native transmission and a BLEND part. No
  check of it yet separates the transmission pass from the rest.
- **Needed to close:** save both pictures, find the pixels and which pass writes them, and fix it in the package that
  owns that pass.

Lane A bounded sweep: the unchanged real-file command reproduces a maximum
four-level repeat difference. A second focused capture saves every sorted
pair at eight angles: 4x differs at 180 degrees (5 pixels, maximum 1) and 270
degrees (31 pixels, maximum 4); every 1x pair is exact. One changed pixel is
(185,250), RGB [42,42,23] versus [44,43,27]. The two affected regions are now
localized, but the writing pass and deeper cause remain unisolated. No driver
waiver or numerical tolerance applies. Private lane evidence: oit-focused
PNGs/log; native WebGPU, RTX A6000, Edge 157.0.4341.42.

### A blurred edge of DOF spreads to one side only

- **What:** a card out of focus in `@margoengine/dof` should spread across its outline, half inside and half outside. A far card
  fades inward and stops dead at its outline (row values 20, 154, 164 and on up to 208, RTX A6000); a near card spreads outward and
  keeps its full value inside (147, then 208).
- **Repro:** `node packages/cinematic/test/browser-check.mjs` draws both cards; print the middle row of the picture in `edge`.
- **Cause:** by design of the gathers, not yet fixed. The far gather takes only samples at the centre's depth or behind it, so sky
  behind a far card takes nothing from the card. The near gather always counts the foreground centre, at full weight.
- **Needed to close:** decide from the published work on gather depth of field how a pixel behind a blurred edge takes its share
  without a sharp subject leaking onto its background, build it in `@margoengine/dof` and test the edge profile on the GPU.

Lane A sweep reproduces the original card profiles on current main, with no
GPU errors. At far-card x=464 with near focus, the green row jumps directly
20 -> 154 -> 164 -> 173: background pixels receive no far-card contribution.
With far focus, the near-card x=244 reaches 147 immediately before 208 and
stays full-strength inside. Source audit confirms the far depth predicate and
forced full near coverage still own these two asymmetries. A correction needs
source-footprint coverage and a distinct background estimate at silhouettes;
simply removing the depth predicate would not establish sharp-foreground
occlusion. Compared Demers (2004), Hammon (2007) and Potmesil/Chakravarty (1981),
cited in clean-room.md. No speculative shader or weaker edge bar was landed.

## README examples

### README examples still need matching inputs and repairs

- **What:** `npm run check:readme-run`, a step of `check:merge` since 2026-11-07, ran 641 of 767 examples that day (RTX A6000,
  Chromium). The other 126 went into `scripts/support/readme-run-known.json`; 101 are left there, each with its error. The voxel-pathtracer introduction now builds a complete generated model instead of fetching an absent raw array; its package regression executes the actual scene setup and the browser runner checks capture. A new failure fails the step, and
  so does an entry that passes or names an example that is gone. An id is the heading above an example and a hash of its code, so
  an example added above one on the list leaves it alone; changing a listed example changes its id, and the entry moves with it.
- **Repro:** `npm run build:packages`, then `npm run check:readme-run -- --only=<id>` with an id from that list.
- **Current source audit (2026-11-09):** 101 entries remain after the upstream voxel-pathtracer repair, 84 labelled `sample:` and 17 labelled `example:`.
  The required-test-items scoped rerun ran 62 of 94 examples, with 32 allowed failures. It exited zero; that does not mean
  those 32 examples ran. Their missing/incompatible inputs are indexed in [missing-test-items](work-lists/missing-test-items.md).
- **Cause:** sample entries name a file of their own (a font, a scan, a rigged model with named joints)
  and the check has no matching sample, or the sample does not fit it, so these say nothing about the example yet. The ragdoll's
  get-up is in this group: it needs prone and supine get-up clips (getting up from the front and from the back) on a humanoid rig, and no free rig in the repository has them; the Quaternius Universal Animation Library Standard 3.0 pack (CC0) was checked on 2026-11-07 and has none (its closest clips, `Sitting_Exit`, `Death01` and `Fixing_Kneeling`, are not get-ups). Fbx, the animator's joint indices and `usdz/readme-margoengine-usdz-087124` and `usdz/readme-composition-fbebfe` (no `.usdz` file is in the repository) are in this group too. 17 start
  `example:`, and these need reading one at a time:
  - Four attach one plugin twice to one engine, which core refuses (`post/readme-smaa-10a00a`, `shadows/readme-margoengine-shadows-7183ea`, `quality/readme-tier-presets-0abcba`,
    `sky/readme-fog-b452c1`), so the example shows two alternatives as if one ran after the other.
  - `cameras/readme-physical-exposure-margoengine-ca-6d1c49` needs `source` on Tonemap, `exporters/readme-render-to-file-80cd28` reads a second view the example never made,
    `exporters/readme-unity-asset-and-support-bundles-a4fd05` needs the Studio source profile, `stage/readme-feature-entries-a6844a` gets a model minimal glTF refuses, and
    `headless/readme-image-sequences-and-video-9967ce` passes a page engine to `readPixels`.
  - `react/readme-first-scene-e7b2ea` and `react/readme-pointer-events-and-picking-8b5eb7` fail on how the page loads React, `worker/readme-margoengine-worker-b56e85` on the worker's message, `input/readme-chords-contexts-rebinding-and-pr-5e2c1c`
    times out, `loaders/readme-optional-vertex-color-and-opacit-5d5952` needs a page, `loaders/readme-vdb-volumes-573d3c` wants an OpenVDB sample, `xr/readme-ar-hit-testing-f7eedf` needs a headset,
    `headless/readme-image-sequences-and-video-37bcc7` needs ffmpeg and `voxel-net/readme-margoengine-voxel-net-b6eba6` is a server and a page in one example.
- **Needed to close:** a matching sample for each `sample:` entry, each `example:` entry fixed in its README or its package, and
  the list empty.

### Fixed: unfinished Node examples cannot pass at their deadline

Fixed by eef03d501 (2026-11-09). Both killed-at-limit Node programs and unfinished page imports fail; the owned process tree or page closes. Lane C rechecked the three synthetic deadline regressions in tests/run-readme-examples.test.js on 2026-11-10: all pass. No README examples were run or edited.

## Checks

### SSAO's orthographic picture moves with the eye

- **What:** `scripts/ssao-gpu-check.js` fails on main: moving an orthographic eye along its view from 6 m to 0.6 m changes the
  picture at silhouettes, 87 bytes past 2 levels (limit 90) and one edge pixel by 17 (limit 16). An orthographic picture has no
  reason to change at all. It is the one `*-gpu-check.js` file no check runs, stated in `LOOSE_CHECKS`; the plan refuses any other.
- **Repro:** `npm run build:packages`, then `node scripts/ssao-gpu-check.js`.
- **Cause:** `SSAO` keeps linear view depth in the half-float G-buffer (`packages/post/src/ssao.ts`, the note beside `gbuffer`),
  which holds about 0.004 m at 6 m and 0.125 m at 200 m. The limit of 16 was set before the display curve changed on 2026-10-17.
- **Needed to close:** view depth in an `r32float` target of its own, which also serves scenes past 65,504 units; then the check
  joins `post` as `test:gpu:ssao` and leaves `LOOSE_CHECKS`. The limit stays.
- **Lane C recheck (2026-11-10, two rounds):** current main reproduces 87 channel bytes over 2 and worst 17. A separate r32float view-depth target reduces that to 27, worst 17; all remaining differences are at x=399. The normal extractor chooses a clamped zero-length forward derivative at the screen edge. Selecting the available one-sided derivative plus full-precision depth makes the eye-movement comparison exact (0 bytes, worst 0). The check then reaches a separate IBL bar: perspective crease 4.0 and step 1.9 against strict >4 and >2. No assertion changed. The draft is parked in lane C's private handoff at the two-round cap, not shipped. Next: reproduce the IBL bar independently, then finish both changes with their regression tests before adding this check to post's plan.

## Boulder demo

### The robot's arm shows a copper piston through its shell at close range

- **What:** in the Boulder demo, from the nearest orbit distance (1.2 m), a copper rod shows through the upper arm shell
  and the shell has a jagged edge near the elbow. It does not show from the default view, and it does not affect the
  collision results, which use the link hulls.
- **Repro:** `npm run build:boulder`, then `node scripts/test-boulder-browser.mjs --shots=<dir> --closeups`, and open
  `boulder-high-close-right.png` and `boulder-high-close-left.png`.
- **Cause, not yet confirmed:** the piston, washers and hubs in `examples/assets/source/skinning_ik/build_robot.py` are
  not in its `NO_CROSSING` list, so the crossing check in that script does not see them.
- **Needed to close:** decide whether this model stays. If it does, add those parts to `NO_CROSSING`, fix what the check
  then reports and rebuild the GLB. If another model replaces it, this entry goes with the old model.

### Boulder draws differently on the WebGL2 layer, and visual:compat has no entry for it

- **What:** `npm run visual:compat` fails on `boulder`: the WebGL2 capture differs from the native WebGPU one on 1.78%
  of pixels by more than 2 of 255 (mean 0.473, max 79), while two native captures are identical. The differences are
  spread over the textured climbing walls and the grey side wall, not at object edges. The demo has no entry in
  `scripts/support/visual-compat-expected.json` (it replaced the Light Keeper, whose entry went with it).
- **Repro:** `npm run visual:compat -- --only=boulder` (RTX A6000, Edge 157.0.4341.42, 2026-11-07); the report is
  `test-results/visual-compat/index.html` with `boulder.diff.png`.
- **Cause, not yet found:** the same numbers on the commit before the core instance-row and writePoses commits and
  after them, so those commits are ruled out. The spread over textured surfaces points at texture sampling or shadow
  filtering in `@margoengine/webgl2-compat`, which is where the next look goes.
  Ruled out (2026-11-08): the CPU compute tier's NaN encoding (fixed above), as the comparison is WebGL2 against
  WebGPU drawing, not the CPU tier's two paths, and a NaN's bits change no colour.
- **Needed to close:** the cause fixed in the package that owns it with a regression test, or recorded with
  `--write` as an explained difference, as the other demos that differ are.

### USD composition: stress stages that mix classes, variants and repeated sites

- **What:** 46 of 150 generated stress stages still differ from OpenUSD in a property of some prim (55 of 150 before the rebuild from the Core Specification). They nest classes, variants and references far past real files, and repeat one class through several layers. No real file in the corpus shows it.
- **Repro:** compose `packages/usdz/tests/fixtures/open-difference/root.usda` with `composition()`. `/Q/b/c/c/c/a/c/a.v0` is 961 and OpenUSD says 642.
- **Measured:** the opinion lists from OpenUSD's public `GetPrimStack` call and ours differ in the place or the count of class sites that one stage reaches twice, mostly beside variants. Two stages that matched before the rebuild (46 and 109) differ now; they are among the 46.
- **Not confirmed:** the cause. The AOUSD USD Core Specification v1.1.0 does not say what happens when two arcs reach one site, nor which namespace "deeper" means once an arc has crossed a reference. Margo's two rules for this in `packages/usdz/src/stage.ts` come from watching OpenUSD on test stages, are marked there as seen and not specified, and may not be the whole rule. Earlier text here named one cause as fact; that came from memory of OpenUSD's internals and is withdrawn.
- **Needed to close:** an answer from the specification (an erratum request to the AOUSD issue tracker is the route), or more black-box stages that pin the rule down. Never OpenUSD's source.

## Blocked on hardware we do not have

These features pass their tests against the published specifications, but the only real check is a device the project
does not own. Each entry says exactly what is needed to close it.

### USDZ export with textures: Quick Look on a Mac only

- **What:** `exportUSDZ` in `@margoengine/exporters` (`packages/exporters/src/usdz.ts`) writes UsdPreviewSurface
  materials with texture readers (base colour with opacity and `opacityThreshold`, metal-rough on the g and b channels,
  normal, occlusion, emissive, `st`/`st1` texcoords with the V flip, a base-colour `UsdTransform2d`, wrap modes) and
  stores each image 64-byte aligned and uncompressed.
- **Verified:** the USDZ tests (`packages/exporters/tests/usdz.test.js`) check the shader graph text, every file's
  alignment, the image bytes and a round trip through our own USD reader (`@margoengine/usdz`). On a Mac mini with
  macOS 27.2 (2026-11-05, over SSH), the eight kit files: `usdchecker --arkit` passes all of them, and their Quick Look
  thumbnails draw the alpha mask, the blended texture and the transforms as intended, 07 (+30) leaning clockwise and
  08 (-30) anticlockwise.
- **Open:**
  1. Quick Look ignores `normalScale`: files 03 (scale 1) and 04 (scale 2) give byte-identical thumbnails, and
     `usdchecker` warns `NormalMapTextureValidator.NonCompliantScaleValues` on 04.
  2. The thumbnails were read by eye, not compared with the engine-drawn twins.
  3. Nothing has been opened on an iPhone or iPad, in AR or otherwise.
- **Needed to close:** `node scripts/make-usdz-quicklook-kit.mjs <folder> --glb` writes the eight files and their twins.
  Open them on an iPhone or iPad on iOS 17 or later, compare each with the same scene drawn by Margo, and record the
  result here and in `docs/threejs-parity.md` (USDZExporter row).

### Animated USDZ: the fix for the first iPhone failure awaits a retest

- **What:** Fox-Run in AR Quick Look on an iPhone (2026-11-06) went past the top of the screen, showed the bottom of two legs,
  clipped, and could not be moved. robot-expressive ran half off the screen.
- **Cause:** the file held the true size glTF gives, 79 m and 4.46 m, and Quick Look shows real size. No factor of 2 exists:
  RealityKit's bounds on all 76 files read 1.00 times glTF's, robot-expressive's posed parts aside.
- **Fixed in the exporter:** `height`, `ground`, `size` and `bounds`, skin points at rest in the world, `extent` on each
  `SkelRoot`. `packages/exporters/tests/usdz-size.test.js`.
- **Retest so far:** Scott on his iPhone, of Fox-Run and the Robot files at the new sizes: "Both look right". That covers those two
  models' look on one iPhone only. Dragging, in his words "i could drag them", held on the three files he could open. On all 8
  start-here files, in his words: "they all work but the rigged figure still floats and does not make contact with the ground". The
  rest of the 76 files are untested.
- **Not known:** whether the clipping and the failed move had a cause beyond standing inside a huge model.
- **Needed to close:** on an iPhone, open `Fox-Run.usdz` and `RobotExpressive-Dance.usdz` at the new sizes: each stands on the
  floor in view at about 2 m and a drag moves it.

### RiggedFigure first loads off the floor in AR Quick Look on an iPhone

- **What:** Scott, on his iPhone, of the 8 start-here files (2026-11-06): "they all work but the rigged figure still floats and does not
  make contact with the ground". He named no fault in the other seven. How far it floated is not recorded.
- **Variant run (Scott, 2026-11-06, one phone, one load each):** "rigged figure control loads with its feet in the ground but when i drag it up
  it sits properly same for root joint the rest look good". The five files: Control (byte for byte the file that floated, text USD inside),
  ControlBinary (the same scene as binary USD), Scaled (the exporter's height option at 1.2 m, root scale 0.8276, text), NoAnimation (binary, clip
  removed), RootJoint (binary, an identity joint added at the origin).
- **Repro:** `exportAnimatedUSDZ` of `examples/assets/khronos/RiggedFigure/RiggedFigure.glb` with `{ ground: true }`, opened in AR Quick Look.
- **Cause:** not found. The numbers and the Mac say it touches, the phone says it does not. Ruled out, on a Mac only: the file's rest points
  (lowest y -6.6e-8), the `SkelRoot` extent (-6.3e-8 at all 39 frames), RealityKit's `visualBounds` (1.3e-8) and mesh bounds, and no joint reaches
  below the feet (lowest 0.022). RealityKit's own renderer, running the clip, puts the soles on a plane at y = 0 within one pixel (about 3 mm) at
  three times, as it does the other files. That renderer is not AR Quick Look, whose floor logic could not be read here.
- **Only this file, among the skinned ones:** root scale exactly 1, first joint at the hips (y 0.686) and not near the origin, first joint rotated at rest.
- **What the variant run shows:**
  - The same bytes floated on one load and sank on another, so one fixed offset in the file cannot be the whole story. A drag up leaves the feet on
    the floor, so the distance from feet to origin is right once Quick Look places the model again. Both point at first placement or load timing.
    Neither proves it: the two loads were on different occasions, with the room and how well the phone had found the floor not recorded.
  - Control and ControlBinary hold the same scene and differed. So either a difference this size appears with no change to the scene, or text
    against binary matters, and one load each cannot say which. Either way, Scaled and NoAnimation looking good is no evidence about root scale or the clip.
  - RootJoint was off too, so a joint at the origin did not cure it on that load. Nothing now supports the first joint's position as the cause.
- **What it does not show:**
  - Which of root scale, size or the clip matters, if any. Scaled changes root scale and size together.
  - Text against binary: text was off in 2 of 3 loads, binary in 1 of 3.
  - That Quick Look does this to any file. The animated 1.45 m figure was off in 3 of 4 loads (the first report plus Control, ControlBinary and
    RootJoint), and the seven other files plus Scaled and NoAnimation in 0 of 9. That split was picked after looking, and those nine were reported as
    fine and not measured, so it is weak, but it leaves something in this figure that makes a bad first placement more likely still open.
- **Smallest run that would settle it:** Control and Scaled, three loads each, alternating (Control, Scaled, Control and so on), on the same floor
  spot. Close Quick Look fully between loads, let the phone find the floor first, and before any drag note floats, sinks or touches, with rough centimetres.
  - Control changes direction or sometimes touches, and Scaled does too: first placement varies whatever the root scale. Record it as Quick Look's own
    behaviour, with the exporter unchanged.
  - Control wrong in 3 of 3 and Scaled right in 3 of 3: a file-side candidate. That split comes up by chance 1 time in 20, and it would still need a
    variant that changes root scale without size before any exporter change.
  - Anything between leaves the question open, and the entry says so.
- **Needed to close:** that run, then either a root-cause fix with a regression test or the phone evidence that it is Quick Look's own behaviour. The
  exporter stays as it is until a file-side cause is shown.

### USDZ vertex colours draw grey in Quick Look

- **What:** a painted mesh from `exportUSDZ` is flat grey in Quick Look (macOS 27.2 thumbnail, 2026-11-05). `usdchecker
  --arkit` passes, and `@margoengine/usdz`, `readUSDA` and any reader that follows `UsdPrimvarReader` get the colours.
- **Repro:** `exportUSDZ({ nodes: [{ geometry: { positions, normals, indices, colors, colorSize: 3 }, material: { color:
  [1, 1, 1, 1] } }] })`, then open the file in Quick Look.
- **Cause (measured):** Apple's renderer does not follow a `UsdPrimvarReader_float3` into `inputs:diffuseColor`. `token`
  or `string` for `inputs:varname` makes no difference (byte-identical thumbnails). The same mesh with no material bound
  draws its colours.
- **Plan:** leave the material out when it says nothing but the paint (no textures, metalness 0, roughness 1, no
  emission, opaque), and teach `@margoengine/usdz` to read `displayColor` on an unbound mesh. A material that says more
  cannot show paint on Apple's renderer; it needs the colours baked into a texture.

### WebXR AR hit testing: never run on an AR device

- **What:** `HitTest` in `@margoengine/xr` (`packages/xr/src/hit-test.ts`): hit-test sources from the viewer, an input
  source or transient input, results as reference-space poses, anchors.
- **Verified:** tests against the W3C WebXR Hit Test Module's interfaces with a mocked session
  (`packages/xr/tests/hit-test.test.js`); [limits.md](limits.md) has its row.
- **Needed to close:** an Android phone with ARCore and a Chromium browser that exposes WebXR `immersive-ar` with the
  WebGPU XR binding (`XRGPUBinding`), or an AR headset with the same; then a reticle placed on a real floor and a real
  table (viewer source) and by screen tap (transient source), one placement anchored, and the result recorded here.

### WebXR: no run on a real headset or AR phone

Batch 268 job 1 remains blocked: no Quest/Android device or ADB connection is
available in this lane; the new pointer GPU checks are desktop evidence only.

- **What:** nothing in `@margoengine/xr` has run on a real device: sessions, stereo drawing, inputs, hit testing, or the
  WebGL2 layer's route. `npm run check:xr-runs` lists the four routes, each NOT RUN.
- **Verified:** real WebGPU with a stand-in session (`npm run modern:test:xr:browser`), mocks in
  `packages/xr/tests`, and `packages/webgl2-compat/test/xr-browser.mjs`. This PC has no OpenXR runtime.
- **Needed to close:** run `examples/xr-device-check` on each route's device and add the records to
  [xr-device-runs](xr-device-runs/README.md). The gate then asks for this entry to go.

### Intel Arc 140V: three GPU-suite failures fixed on this PC and rechecked on Intel by the outside audit

- **Verified on Intel** (Core Ultra 7 258V, Arc 140V, driver 32.0.101.8860, main at 30bea6fa, recheck of 2026-10-27):
  the four failures of the first run (main d000e4b6) are fixed there. FFT: the Stockham passes match the host-twiddle
  f32 reference exactly (0.00 u at n = 1024 and 65536); path tracer `combinedHDR` within 1 sRGB level (was 226),
  converged after 17 frames; the Next client drew the mint cube after 598 ms (past the old 300 ms fixed wait); the voxel
  and path-tracer `test:gpu:slow-compile` twins and `modern:test:browser` with its twin pass.
- **What failed instead** (same run), and the cause and fix of each, measured on the RTX A6000:
  1. compute CPU/GPU parity, `sin, cos, atan2[16]: cpu -0.4964582920074463, gpu -0.49644696712493896` (1.13e-5 off,
     tolerance 1e-5). Cause: the WGSL builtins. WGSL allows `sin` and `cos` 2^-11 absolute error inside [-pi, pi] (and
     none promised outside), `atan2` 4096 ulp, `asin` 6.8e-5; the Arc 140V is 1.1e-5 off near 1.5 where the A6000 is
     within 3.3e-7 (the A6000 is itself 1e-5 off at |x| near 100, 133 ulp for `tanh`, 114 for `pow`). Fixed: element-wise
     functions use precise f32 versions (`packages/shared/precise-math.js`: integer Payne-Hanek reduction, minimax
     polynomials from `scripts/precise-math-coefficients.mjs`), within 1 to 2.5 ulp (pow 5) on every GPU;
     `createCompute({ fastMath: true })` keeps the builtins. The parity check is tighter now (1e-6, plus each function
     in ulp) and the fastMath path is checked against the WGSL bounds. Regression tests: `tests/precise-math.test.js`
     (the bounds over dense inputs with fused and unfused rounding and with division and sqrt at WGSL's limits), the
     GPU check `compute-precise-browser.js` (the A6000 computes the host mirror's values bit for bit), and
     `compute test:browser:spec-math`, which moves every builtin result by WGSL's whole allowed error
     (`--spec-math-error`, scripts/browser.js): the old parity check fails there as on Intel, the new one passes.
  2. voxel normal suite, `4x four-view blue`: the bottom two views black. Cause: the bevel check took "the quad and
     triangle counts did not change for 3 frames" for "every chunk is meshed"; with one mesher worker on a slower CPU
     a bevelled chunk takes several frames, so the last two chunks (the bottom views) were not on the GPU yet. Fixed:
     `VoxelRenderer.stats.pending` counts the chunks not yet on the GPU (changed, meshing, waiting for upload); the
     check waits for a frame with `pending` 0, `compiling` false and draws. Regression test: `voxel test:gpu:slow-mesh`
     delivers every worker message 150 ms late (`--worker-delay`): the old check fails there the same way, the new one
     passes.
  3. voxel-pathtracer normal suite, `traversal fisheye: depth`: 1.17e-3 relative depth error against the CPU raycast
     (assertion < 1e-4), 16379 of 16384 first hits alike. Cause: the fisheye rays came from the builtin `asin`, `sin`
     and `cos`; a ray that far off grazes a different voxel face. Fixed: the panorama and fisheye rays use the precise
     functions. Regression test: `voxel-pathtracer test:gpu:spec-math` (the projections check with every builtin at
     WGSL's error bound) fails with the builtins and passes with the fix.
- **The class:** five checks have now waited "N frames" or "N ms" for something that takes longer on a slower GPU or
  CPU. `scripts/check-fixed-waits.mjs` (run by `tests/check-fixed-waits.test.js` in `npm run verify`) fails on any new
  fixed frame count or sleep in a GPU or browser check unless it carries `// fixed-wait: <reason>`; the ones already
  there are counted in `scripts/fixed-waits-baseline.json` and only go down. `scripts/support/gpu-ready.js`
  (`waitForPipelines`) waits for the pipelines themselves.
- **Rechecked on Intel by the outside audit of 2026-10-28** (a second Intel Arc 140V laptop; the audit is the source
  for this paragraph): the compute spec-math case, the voxel normal and slow-compile cases and the voxel-pathtracer
  spec-math fisheye case all passed. The audit does not say whether the three fixes above (the precise maths, the
  `pending` count and the precise fisheye rays) were what changed them, and it reports no per-function bounds.
- **Not verified:** the precise functions' error bounds on the Intel compiler (`compute-browser.json` from an Intel
  PC), which no recheck has recorded.
- **Needed to close:** the `compute-browser.json` precise-maths results from an Intel PC, then this entry removed or
  turned into the cause found.

### Intel Arc 140V: voxel-pathtracer `denoise` case ran out of time with no output

- **What:** on the Intel Arc 140V laptop, `voxel-pathtracer test:gpu` finished every case before `denoise`, which started
  at about 172 s and printed nothing until the test runner killed the suite at 900 s (`HUNG: no result after 900 s`).
  The cases after it never ran there.
- **Measured on the RTX A6000** (shared GPU, 2026-10-29): the case renders six 480 x 300 references at 16384 samples
  and took 196 s (diffuse 14, opaque 15, materials 82, caustics 85); the longest wait for any GPU work to finish was
  1 s. The Arc ran `convergence` in 61.3 s against 13.1 s here (4.7 times slower), which puts `denoise` near 915 s there,
  more than the 728 s it had. Most likely cause: the case was simply longer than the time limit. A GPU wait that never
  resolves is not ruled out without an Arc run.
- **Done:** each scene is its own case (`denoise-diffuse`, `denoise-opaque`, `denoise-materials`,
  `denoise-caustics`; `denoise` runs all four). Every render prints a
  `progress denoise <scene>: ...` line. A case in which no GPU work finishes for `MARGO_GPU_STALL_S` (120 s) now fails
  at once, naming the case, the step and the render (`tests/progress.mjs`). Each case prints its time and its longest GPU
  wait. Regression test: `voxel-pathtracer test:gpu:stall` (`tests/stall-check.mjs`) hangs every GPU wait once the
  first render starts and expects that named failure. It fails in 17 s with the watchdog; without it the run has not
  ended at the 180 s limit.
- **Measured again on the Arc** (origin/main cb42459a, mains, Edge 156): `test:gpu` still hit its 900 s limit with no
  `GPU stall` line, so the GPU kept finishing work: the denoise references started at 147 s (diffuse), 242 s
  (opaque), 327 s (materials) and 748 s (caustics), and the caustics case was still running at 898 s. Slow, not hung.
  `denoisepeak`, `denoisehistory`, `lens`, `viewport`, `capture`, `materialtables`, `largemodels` and `native4k`
  never ran there.
- **Done (split, 2026-10-30):** the check runs as five package scripts that name their cases, each with its own limit
  in `margo.gpuTestTimeoutMinutes`; same cases, samples and tolerances. A6000 time, Arc estimate (from the run above),
  limit: `test:gpu` (agx to convergence) 57 s, about 150 s, 10 min; `test:gpu:denoise` (diffuse, opaque, denoisepeak,
  denoisehistory) 46 s, about 240 s, 10 min; `test:gpu:denoise-materials` 99 s, about 450 s, 15 min;
  `test:gpu:denoise-caustics` 109 s, about 500 s, 15 min; `test:gpu:viewport` (motion, lens, viewport, bloom, capture,
  materialtables, largemodels, native4k) 36 s, about 200 s, 10 min. `tests/voxel-pathtracer-gpu-split.test.js` fails
  if a split script is missing, if their cases are not exactly the check's case list (each once), if a script runs the
  whole check with no case named, or if check:merge would not run one when the package is affected. An unknown case
  name now fails the browser check instead of running nothing.
- **Needed to close:** run the five split scripts above on the Arc. If each passes
  inside its limit, remove this entry. If one stops with `GPU stall`, the message names the render to hunt.

### Linux (Intel UHD, Mesa): three GPU suites not finished

- **What:** on the Ubuntu test server (Intel N100 with Intel UHD, Chromium on Mesa's Vulkan driver, Node 24, main
  b92998d6, 2026-10-28) 42 of the 43 package GPU suites were started, one at a time, and 38 passed. The voxel, voxel
  path tracer and root browser suites were stopped by the heat watchdog at 82 C before they finished, so they have no
  Linux result yet. The text failure of the same run is the colour emoji entry below.
- **Needed to close:** those three suites run to the end on Linux, on a machine that stays cool under a long GPU
  run, and the results recorded here.

## Open defects

### A chain laid out level under a 1000:1 end mass stretches once it is taut

- **What:** `@margoengine/physics/next`, 50 spherical joints of 0.1 m between 1 kg balls of radius 0.05 (a sphere's inertia, 0.001 kg m2), a 1000 kg ball at the end, all laid out level and let fall at the defaults (8 substeps, 2 passes, 60 Hz). The polyline through the link centres passes 1e-4 of its length at step 32 and reaches 2.1 times its length by step 60 (native kernel; 0.107 in the Wasm build). Hung straight down, the same chain holds (the kernel test `a_chain_of_fifty_holds_a_thousand_to_one_end_mass`). End ratio 100:1 passes 1e-4 at step 207 and 10:1 at step 318; 1:1 holds. 16 substeps hold it to step 66, 32 to step 229. Ten times the links' inertia holds it to step 219. The joints open even where the stretch holds, as a bent chain's centre line reads short (measured 2026-11-08, 600 steps, a 3 m/s kick, 600 more): each joint's widest gap is 7.0 mm at 1:1, 9.7 mm at 10:1, 23 mm at 100:1 and 0.38 to 0.45 m at 1000:1, against 1.9e-5 m on the chain hung straight, whose test now bars each joint at 1e-4 of the length. The level 1:1 gap is the turn within a substep, r (h w)^2 / 2 at a whip end of 264 rad/s.
- **Repro:** `new Physics()`, a fixed body at (0, 20, 0), then 50 balls at x = 0.1 i along y = 20, each `spherical` to the one before with anchors (0.05, 0, 0) and (-0.05, 0, 0), density so each ball is 1 kg and the last 1000 kg, `canSleep: false`; step 60 times and sum the distances between successive centres from the first anchor, over 4.95 m.
- **Cause:** a lock's rows, and with them the arm its pull turns a link by, are read from the poses at the start of each substep, so the turning a pull gives is explicit: a light link pulled along its arms by a tension T is a spring of stiffness about 2 T r on its inertia I, with omega = sqrt(2 T r / I). Semi-implicit Euler holds such a spring only while omega h stays under 2. The end mass swings the chain taut (the joint force rises past 2,000 N by step 26 and to 60,000 to 70,000 N at the bottom of a swing), the light links' turn crosses that bound, the links next to the end mass bend first (step 26) and the gaps spread up the chain. Measured per substep before any change: the push cut of `push_share` (TURN 0.2) and the lock bias cap (`joint_max_push` 3 m/s) act on no substep up to step 31, so neither is the cause; they only start to act once the links spin at 100 rad/s.
- **Needed to close:** read the turning implicitly: the geometric stiffness of the locks (the change of J^T lambda with the poses, Tournier et al. 2015, Andrews, Teichmann and Kry 2017) in the path solve, with the joint forces of the last substep. Andrews et al. 2017 add damping only where a stability test on that stiffness asks for it, which keeps a pendulum's energy; that method is claimed by US patent 10,713,400 B2 (CM Labs Simulations, active to 2038), so whether Margo may use it, or must keep to the undamped implicit form, is Scott's decision. Then a kernel test of the level chain under 1e-4, each joint's gap included, with the pendulum period and double pendulum energy tests unchanged.

### A path near a toggle between two kinematic bodies answers in full, so the joint webs have no gap bar

- **What:** `@margoengine/physics/next` kernel, the random webs of `a_web_of_joints_stays_in_the_numbers` (`packages/physics/kernel/tests/stability.rs`). All 60 stay under its 1e5 m/s, but seed 49 reaches 10,991 m/s and a joint stands 165.8 m open, and seed 35 past step 600 a joint 144.6 m open (on main at a6a767220), where the scene puts every body back inside a 32 m cube each step and no joint could stand open past 56.85 m by the scene alone. Without the n u stop (below) seed 59 reached 22,121 m/s at step 1039 and a joint 326 m open.
- **Repro:** `web(49, 2000)` of `tests/stability.rs`; it returns the top speed, the top spin and the widest joint. The path is a spherical joint from a kinematic body to body 22, a fixed joint to body 8 and a slider to kinematic body 31: 14 rows on 12 freedoms.
- **Cause** (measured on main at 82779ba8c, where seed 49 reached 7,772 m/s at step 1153 and 117 m open after step 1217; the contact changes of a6a767220 moved every web since): two rows depend on the others and are dropped (measured left: 1e-32 of their size). A third is 2.3e-3 rad from depending, a pivot of 5.4e-6 of its size at steps 1152 to 1216 against the stop of 14 u = 1.7e-6, so it is independent and the exact solve gives it the speed of one over that angle, as the kinematic ends ask more than the joints allow; at step 1216 it crosses the stop and is dropped. Checked in rationals: with the f32 epsilon stop the kernel's pivots matched an exact elimination to 1e-13 on every path of seed 49 at step 896 and seed 59 at step 1038 (pivots of 1.35e-7 and 1.76e-7 there, nonzero in rationals), so these are the scene's answers and not rounding.
- **Needed to close:** a design for speeds near a toggle when the ends cannot both be met (damping per singular direction, as Buss and Kim 2005 do for a push, or a bound from what the kinematic bodies carry), then a gap bar in `a_web_of_joints_stays_in_the_numbers` for all 60 webs. `a_path_with_more_locks_than_freedoms_drops_the_row_that_depends` holds seeds 1 and 35 under 56.85 m to steps 400 and 600 now.

### Fixed: Python tests avoid the Windows app execution alias

Fixed by 2dbaf192c. Exporter tests now use scripts/support/find-python.mjs, which selects an installed interpreter before trying command names. Lane C rechecked tests/find-python.test.js on 2026-11-10: all four pass, including a Windows alias that must never start and propagation of non-ENOENT spawn failures. This removes the suspected alias path; it does not claim a general Windows CreateProcess defect was proved.

### Fixed: textured glTF loads in Node (2026-11-10)

Without createImageBitmap, ordinary image bytes now use the existing lazy @margoengine/decoders/image reader. Retained RGBA8 pixels upload with writeTexture, with normal material mip generation and restoration. Material extension maps, MToon and React image copies accept the same pixel source. Browser bitmap decoding stays the default when available.

Regression: packages/gltf-pro/tests/node-images.test.js, six PNG/JPEG source cases failed on the original code and pass after the repair. The real Node binding renders textured primary colours exactly like uniform base colours. packages/gltf-pro/scripts/test-pixel-images.mjs compares PNG bitmap and pixel uploads, including restoration, pixel for pixel on both GPU backends. See gltf-node-images.md for limits and sources.

### A limp ragdoll keeps moving on a floor when a limit and a contact cannot both hold

- **What:** a ragdoll lying where a floor holds a limb past its cone limit never comes to rest: Knight.glb with the humanoid preset and fitted hulls, pushed over, still has a hand at 0.7 to 1 m/s after 20 s, with the limb up to 0.8 rad past its limit. Capsules settle under default limits (0.05 m/s) because they are thin enough to meet the limits on the floor. Limits a body can meet lying down settle hulls as well (`swing` 2.5, under 0.05 m/s).
- **Repro:** `Ragdoll.attach(physics, ragdollOptions(humanoidProfile(model.nodes, { bones }), model.nodes))`, `fitRagdollShapes(ragdoll, model)`, `activate()`, then 300 N s on the chest, as in `packages/ragdoll/tests/profile.test.js`, and read the bodies' `linearVelocity` after 1,200 frames.
- **Cause:** the cone limit pass turns the bone back toward its limit from outside the solver, each step, into the floor that put it there; the solver pushes it out, and the two exchange energy for ever. Hinges use Rapier's own limits and do not do this.
- **Tried, measured on the same falls:** skipping the correction on touching limbs settles it (under 0.1 m/s) but a spine ended 2.3 rad past its limit. A fifth of the correction on touching limbs left 0.2 to 0.65 m/s and 0.5 to 1.6 rad. Pulling the joint back with its motor, inside the solver, settled it (under 0.2 m/s) but left bones 1.1 to 1.9 rad past their limits and tore a pinned joint test apart by 3 cm. Each trades a moving limb for a broken pose, so none shipped.
- **Needed to close:** a cone limit as a real solver constraint, with stiffness that does not depend on the limb's own inertia, so a wrist under a body holds as well as a thigh. Rapier has per axis limits on a generic joint, which make a pyramid rather than a cone.
- **Status:** the own solver has that constraint: `physics/next`'s `cone` joint, whose proof is `a_limb_a_floor_holds_past_its_cone_rests` in `packages/physics/kernel/tests/joints.rs` (at rest, 0.02 rad past the cone). `@margoengine/ragdoll` still runs on the root entry, so this repro stands until the ragdoll moves onto the own solver in batch 128, which closes this entry.

### A solver motor on a loaded joint slides what stands on the ground

- **What:** a character that balances no longer shows this (see Fixed 2026-11-07), but Rapier still does it. With a force motor on each knee of a figure held up through those knees, the feet slide along the floor with the body otherwise at rest: RiggedFigure 0.0062 and 0.0090 m/s at 8 solver passes. A foot's reported velocity reads 0.0001 m/s while its position moves that fast, the friction limit is never reached (friction 0.6 to 20 reads the same to the digit), and the same loads with no controller running slide at the same speed.
- **Repro:** the RiggedFigure rig of `packages/ragdoll/tests/balance.test.js`, with the `setMotor` of `RagdollBalance.holdJoints` given the rod motor's gains (`stiffness` limb inertia times frequency squared, `damping` two times limb inertia times frequency), 240 frames, then stop the listeners of balance and motors and keep the bodies awake.
- **Cause:** not found inside Rapier. Measured: the slide stops at once when the knee motor goes, falls with its damping (share 1, 0.3, 0.1, 0 read 0.045, 0.033, 0.015, 0.0005 m in five seconds) and with its stiffness at no damping (share 1, 0.3: 0.0093, 0.0029 m), falls with solver passes and falls fast with inner iterations (1, 2, 4, 8 read 0.0406, 0.0212, 0.0059, 0.0006 m). Inferred from those: a motor pass that has not converged leaves the velocity that goes into the position step different from the one reported.
- **Needed to close:** remeasure on Margo's own solver with the repro above. A motor on a body at rest must move nothing.

### A standing figure can shake at 8 solver passes on some hull roundings

- **What:** on 96 hull roundings no choice was made on (1 to 32 rounding steps, seeds 201 to 216), Seed-san's fastest bone reads over 0.005 m/s on 7 at 8 passes, worst 0.0153, and Mage's on 1, 0.0121. Before real inertia reached the motors the same roundings read 10 of 96 at 0.0137, and 0 of 96. One Seed-san rounding (32 steps, seed 207) slid a foot 0.00204 m in five seconds, past the 0.002 m of the test's 24 roundings; before, the worst of the 96 read 0.0010 m. At 10, 16 and 20 passes all seven figures read under 0.005 m/s on all 96. Every other figure at 8 passes reads under 0.005 m/s too.
- **Repro:** the Seed-san rig of `packages/ragdoll/tests/balance.test.js`, `roundDifferently(ragdoll, 32, 207)`, `numSolverIterations` 8, 360 frames, and read how far the feet moved after frame 60.
- **Cause:** inferred, not proved. Earlier reads caught a heel corner 0.16 mm off the floor rocking on and off in periods of exactly 2, 4, 5 or 10 frames, and contacts are made once per frame, so a four-corner sole can lock to the frame (Small Steps, 4.2, reuses one contact set per frame the same way). It reads as chaotic per rounding, so a constant fitted to one set of roundings does not carry: a stance ankle's motor share growing with foot tilt over a band of 0.08 rad looked clean on 48 roundings and on 48 new ones shook Mage at 0.0411 m/s and Seed-san over 0.005 m/s on 19 of 48, and bands of 0.06, 0.10 and 0.15 read no better. So no band landed.
- **Needed to close:** remeasure on Margo's own solver (Lane P, batch 128): 24 and 96 roundings of a four-corner sole at 8 passes. This one may be Rapier's and no workaround went in.

### A push throws RiggedFigure and Seed-san, and some of the time Barbarian

- **What:** of 128 pushes at 8 solver passes on the upper body, RiggedFigure falls in 60 at 0.5 m/s, 63 at 1 and 95 at 1.5; Seed-san in 69, 93 and 108; Barbarian in 0, 8 and 9. Knight, Ranger, Rogue and Mage fall in none of them. Capture point theory does not excuse this: at 1.5 m/s the capture point lies 0.23 m out on RiggedFigure and 0.25 m on Seed-san, 0.42 and 0.34 of the leg, nearer than Knight's 0.21 m at 0.56 of the leg.
- **Repro:** the Seed-san rig of `packages/ragdoll/tests/balance.test.js`, its upper body set moving at 0.5 m/s to the left as the push tests there do, `roundDifferently(ragdoll, 16, 2)`, 8 passes. It falls inside two seconds.
- **Cause:** not found. Read so far: a foot the controller counts as standing leaves the floor. On Seed-san pushed left at 0.5 m/s no step starts, while the right foot crosses 0.11 m and rises 0.015 m, and the figure tilts 0.82 rad by frame 78. On RiggedFigure pushed forward at 1 m/s both feet stand 0.1 m off the floor at frame 18 with no swing running. `RagdollBalance.landing` gives these two no step at all, as it takes the hips' height for the leg's: `room` reads 0 where Knight's reads 0.253 m. That is wrong, but it is not what throws them: reach from the true hip to ankle line, and reach from the friction cone, both read no better (at 1 m/s RiggedFigure falls in 57 and 58 of 64 against 31, Seed-san in 61 and 59 against 49). Ending a swing on foot contact, as SIMBICON does, and leaving a foot in the air out of the stance legs read worse over all seven figures: 964 and 926 pushes failed of 2,688, against 854.
- **Needed to close:** the controller owns this, so it stays after the solver change. Remeasure on Margo's solver, then find why a standing foot leaves the floor.

### npm run verify hung once in its unit test step

- **What:** on 2026-11-06 one `npm run verify` run in a worktree passed every other step and then sat in the unit test step until its 1,500 s limit, where the same tree took 166 s minutes before and the next run passed in 380 s. Nothing named the test, because the step prints only when it ends.
- **Repro:** none yet. Other lanes were running their own checks on the machine at the time.
- **Cause:** not found. The step now names a hang (see Fixed 2026-11-06), so the next one prints `HUNG TEST:` with its file and test.
- **Needed to close:** a run that prints that line, and a fix of the test it names. Every verify run since is a run of this watch.

- **Lane C sweep (2026-11-10):** no demand repro is available. Full verify is reserved for local CI; this entry remains its per-test hang watch, and no lane verify was run.

### Apple M6 sweep, 2026-11-05 (Chrome 157 and Playwright WebKit; Safari not run)

Sweep record: every package's tests and browser or GPU tests on the Mac mini (M6, macOS 27.2). Repro for each: on a Mac,
`MARGO_BROWSER=chrome` or `MARGO_BROWSER=webkit` with the named script.

- **`sky` `test:gpu`, Playwright WebKit only: full Sky and `sky/base` differ by one half-float step.** Up to 2 pixels a frame in `afterlight`, `meadow`, `preetham` and
  `preetham-clouds-fog`, the same on every run and at 1x and 4x. Cause proved (2026-11-06): Apple's compile under WebKit rounds by the shape of the code. The only trigger is the
  day model branch of the full Sky, `if(frame.settings.x<0.5){color=preetham(w,s);}else{...lookup...}`, of which each frame takes one side. With that branch alone patched out of
  the full module, keeping the side in use, all 12 runs (6 configurations, 1x and 4x) give 0 differing pixels. Moving `lookup` ahead of the branch, which is the same maths, moves
  the differing pixels instead of removing them. The night branch changes nothing. Chrome on the same M6 gives 0 with every one of these texts, so the values are right and only
  the rounding of one compile moves. Ruled out: a stale read, inputs, and an empty branch added to `sky/base` (folded away, same pixels). To close it, Sky would compile only the
  day model in use, and a model switch would recompile the sky, fog, reflection and lighting shaders with `reflectionTexture` kept: Scott's call. No tolerance was raised.
- **`culling` `test:gpu`, Playwright WebKit and Chrome: parts and core meshes differ by 1 level with shadows on.** Chrome 156 on the same M6 shows it too (2026-11-07, `shadows frustum step 2`, 1 pixel). `parts-check.mjs`, `shadows frustum step 2`: 1 pixel reads 145 against 146;
  the close view has 2. Cause proved (2026-11-06): the two engines draw the same surface with two specializations of one shader. A shader patched by Shadows makes core draw single-sided
  meshes with its plain pipeline (`C` false, back faces discarded; the culled pipeline in `renderer.ts` serves only the unpatched shader), while CulledParts keeps its back-culled pipeline
  (`C` true) for them. Apple's compile under WebKit rounds the two differently. With `C` forced false on parts' pipeline every step gives 0; with `C` true and `cullMode` none it stays at
  1 and 2, so the constant decides, not the culling. Without shadows both engines use `C` true, which is why that run gives 0. Ruled out: shadow maps. Parts and mesh casters do round apart
  (12,756 texels by 1 to 24 ulp in WebKit, 139,988 in Chrome), but with both casters rewritten until the maps were bit-identical the frames still differed by the same pixels. Also matrices
  and a shadow edge moving. To close it, either CulledParts follows core's choice, which puts back faces through the rasterizer under shadows, or core culls with patched shaders too, a core
  change: Scott's call. No tolerance was raised.
- **`visual:check` on the RTX A6000: 16 of 81 views fail against baselines last recorded on 2026-10-31.** `npm run visual:check -- --runs=1`, Edge 156.0.4314.58. All 16 pass at 47e4d7c9c on the
  same browser, so neither the browser nor the GPU moved them. A pass/fail search of the 317 code commits since names three, each a deliberate look change that recorded no baseline: cd345c483
  (shoreline foam cap: `night-citadel`, `gameplay-sandbox`), 6f0836ee3 (the tint draw reads the surface: `flight-helmet`, `FlightHelmet`, `ABeautifulGame`, `IridescenceLamp`, `LightsPunctualLamp`) and
  43b39e9df (specular weight: `AnisotropyBarnLamp`, `DiffuseTransmissionTeacup`, `ToyCar`). The 2026-11-05 lighting2d and scatter fixes changed none of them, and all 20 proofs pass. To close: look at
  the 16 views and re-record them: Scott's call.
  Edge 157 (2026-11-08) moved none of them: in Edge 157, abadfb455 still draws the Edge 156 pictures and its child 6f0836ee3 the Edge 157
  profile's (`flight-helmet` lens mean 72.8 against 11.5 of 255, `LightsPunctualLamp` up to 79 levels, the same commit's), and `gameplay-sandbox`
  at abadfb455 on Edge 156 is bit-identical to the Edge 157 profile. The near-black `flight-helmet` lenses were an asset defect that
  6f0836ee3 exposed, fixed since: the demo GLBs' lens base colour had been composited over black when written as JPEG.
- **Playwright WebKit sometimes drops to 20 or 30 FPS after navigating in the same tab.** `examples/voxel-sandbox`, `quality=high`, 1920 x 1000, 60 Hz display:
  in chains of five same-tab loads, 7 of 30 loads ran at 30 FPS, then the rate came back by itself on a later load. Never on the first load of a browser (0 of 11 chains),
  and not at 1280 x 720 (0 of 11 loads). First seen as 20 (light then high) and 30 (high then high), with the rate of the page's own `requestAnimationFrame` the same, frame CPU
  2 ms and the GPU 24% busy. Cause not found. Ruled out: GPU load, CPU load, the back-forward cache as the only cause, and the old page's device (destroying it on `pagehide`
  still gave 3 of 25). A plain WebGPU page that only clears held 60 in 20 of 20 loads at the same size, so a frame's real work plays a part. Safari not run.

### The path tracer never compiles on ANGLE Direct3D 11 (parked)

- **What:** on the WebGL2 layer, `@margoengine/voxel-pathtracer` compiles and runs on ANGLE Vulkan in about 20 s, but on
  ANGLE Direct3D 11, the Windows default for a browser with no WebGPU, the `trace` fragment shader does not finish
  compiling. `tracer.ready` stays pending and the page shows the raster image and never a traced frame. The page keeps
  drawing at full rate meanwhile.
- **Repro:** change `--use-angle=vulkan` to `--use-angle=d3d11` in `packages/voxel-pathtracer/tests/browser-check.mjs`
  and run it with `--compat`. To time the compiler alone: read the HLSL with `WEBGL_debug_shaders` from a page with
  `--use-angle=d3d11`, fill ANGLE's `@@` placeholders, and pass it to `D3DCompile` for `ps_5_0` (`fxc`).
- **Measured** (2026-11-06, one RTX A6000 PC, three compiles at once, so diagnostic; the chain is WGSL, `translateWGSL`
  GLSL, ANGLE HLSL, `D3DCompile`, and the HLSL is 210,679 bytes):

  | What was compiled | Result |
  | --- | --- |
  | The whole of `trace` | Still running at 3,000 s |
  | `precise` trig in `wideRay` replaced by native `sin` and `cos` | Still running at 3,000 s |
  | That, and no `glassCandidates` and no shadow walk | Still running at 3,000 s |
  | `direct`, `closest`, `shadow` and glass stubbed | 516 s, 159 KB of bytecode |
  | Those and the precise trig stubbed | 125 s, 48 KB |
  | Precise trig, `closest` and `shadow` stubbed | 524 s, 57 KB |
  | Precise trig stubbed alone, or with `direct`, glass, or both | Over 560 s |
  | `[loop]` on every loop, or on the path loop | No help within 280 to 560 s |
  | One path iteration | Over 280 s |

  A stub that zeroes `cameraRay` folds the whole shader to 1,132 bytes, so that timing says nothing.
- **Cause boundary:** the earlier standalone HLSL experiments localize the compilation failure below WGSL/GLSL
  translation, in native `D3DCompile`. Its inlining/optimization of the combined program is implicated; the exact
  pathological compiler pass has not been identified, but the 2026-11-09 bug-45 probes show its time grows 3.6 to
  5.3 times per doubling of inlined code, is no lower with `/Od`, and is spent before dead code is removed
  (testpage-research.md, "Bug 45 hunt"). The stub results do not establish that every constituent
  shader is unmanageable: the bug-45 continuation above now links isolated dependency trees, including one direct
  light at a time. The original combined program still fails its bounded check.
- **Ruled out:** native trig (the numbers above, and it would change the output); leaving features out per scene (the
  third row drops glass candidates and the shadow walk and still does not finish).
- **Needed to close:** a wavefront split of `radiance` into bounded fragment programs, preserving first hits,
  ordered direct-light evaluation, surface sampling and all transport state. The typed-IR inventory has 98 scalar
  words of persistent locals/private globals before phase scratch and liveness/bool packing, so the former
  approximate 18-vec4 estimate is not an allocation contract. Integer/RNG state needs exact serialization as well
  as float precision. Constituent compile probes and the CPU light-step comparison do not establish a working
  staged path loop. Actual GPU output parity and disposal-during-compilation regressions remain required.
- **Meanwhile:** a page on this route gets the raster view. WebGPU is the route on such a machine where the browser has
  it, and ANGLE Vulkan works.
- **C2 composition (2026-11-10):** integration row c2-003 (post/FXAA, toon, transitions, scenery/Moon and
  voxel-pathtracer) never returned on the WebGL2 layer at 1x, and the GPU lease reclaimed the run after 195.7 s idle.
  Bisected on an RTX A6000 under ANGLE Direct3D 11: voxel-pathtracer alone stalls at `await tracer.ready`, while the
  other four together pass. Two programs never report `COMPLETION_STATUS_KHR` (45 s, context not lost): the `trace`
  render pipeline (GLSL vertex 366 and fragment 134,717 bytes; ANGLE HLSL fragment 220,071 bytes, SHA-256 prefix
  cc09ce32cd70a8b8) and the compute `preview` stand-in (GLSL vertex 70,244 bytes; HLSL 117,960 bytes, 7ca27c68a5387fb6),
  read back with `WEBGL_debug_shaders`. The same page under `--use-angle=vulkan` on the same GPU passes with the
  expected probes, so the cause is the native compile above, not an interaction between members. The C2 runner now runs
  rows with this member on ANGLE Vulkan on Windows, as the tracer's own compatibility checks do, and bounds each scene
  with `ERR_COMPOSITION_STALL` (docs/integration-composition.md). C2 coverage of the tracer on ANGLE Direct3D 11 stays
  open with this entry.

### Three routes still break WebGPU compatibility-level rules

- **What:** with `allowCompatibilityAdapters` from `@margoengine/webgl2-compat/adapter`, `FogPass` in `@margoengine/sky`, the volumetric pass in `@margoengine/environment` and the spray in `@margoengine/water` take `@builtin(sample_index)` at 4x, found by reading the code and not yet run there. `SurfelPlugin` at 4x refuses with `unsupported`. A page can use the WebGL2 layer instead.
- **Repro:** `npm run build:packages`, add the package to `PACKAGES` in `packages/webgl2-compat/test/adapter-browser.js`, then `node scripts/gpu-lock.mjs run --owner=<you> -- node packages/webgl2-compat/test/adapter-browser.mjs`, and read `packages` in `test-results/compat-adapter.json`.
- **Cause:** the level has no `sample_index` in a fragment shader and no multisampled float format: neither r32float nor rgba16float, so the surfel sums have nothing to add into at 4x.
- **Needed to close:** the routes `Shadows`, `SceneTarget` and eye-dome lighting took: a masked draw per sample (`packages/shared/msaa.js` `copyDepth`, `packages/points/src/plugin.ts` `edlPipelines`). Surfels need sums in a format the level multisamples, or a single-sample pass with its own copy of the scene depth. Then add the names to the list `adapter-browser.mjs` asserts.

- **Lane C source audit (2026-11-10):** sky/fog.ts, environment/volumetric.ts and water/spray.ts retain their multisampled sample_index branches. points/surfels.ts still explicitly refuses 4x compatibility-level float accumulation. These repairs remain open; a per-sample masked draw fixes only the three depth consumers, not the surfel accumulation format. No new runtime pass or closure is claimed.

### External PBR display passes

- K2 external-pass follow-up: PBRModel.draw with a caller-owned already-open external pass on a display-encoded target still uses native tint/add blending; reproduce with bright glass over a bright background via createRenderer. Cause: the caller owns the open pass and the package cannot end it to snapshot its background. Graph-managed Engine scenes are fixed; use a linear HDR external target pending a caller-supplied snapshot hook.

- **Lane C source audit (2026-11-10):** PBRDeviceRenderer.draw still receives an already-open caller-owned pass and view; its prepare method handles deformation, not a colour snapshot. The caller snapshot API and its bright-background regression remain open. No renderer or assertion was changed for this entry.

### Findings of the outside audit (2026-10-28)

- **What:** an outside audit of revision 74a01810 (a source review, canary tests on a second laptop with temporary
  files, mock fetches, fake sockets and loopback servers only, a full verify that passed 6,344 of 6,346 tests with 2
  skipped, a short fuzz run over 36 targets and GPU checks) reported 20 findings, F01 to F20, about input handling,
  the converter command line, the network servers and one slow decoder input. The audit marks each as reproduced, code
  confirmed or project documented, and states its own limits: a short fuzz run, local canaries only, no production
  test, and a passing verify does not show there are no bugs.
- **Status on main (2026-10-28):** 16 of the 20 are fixed with regression tests (F01 to F07 and F11 to
  F19; classes, commits and tests in
  [whitepaper/perf-history.md](whitepaper/perf-history.md#44-an-outside-audit) and the table at the end of this page).
  F20 is being fixed; its details are published once the fix is on main.
- **netcode room server limits (F08, F09, F10): fixed.** `RoomServer` has `joinTimeout`, `maxConnections`,
  `maxRooms` and per-client message rates, and room timers that throw no longer throw uncaught (`92b7c5ba`, bug 50;
  tests in `packages/netcode/tests/rooms.test.js`). The low-level `listenWebSocket` of `@margoengine/netcode/node` had
  none of them (audit E-02, bug 67); it now has the same kind of defaults: own-host `origins` (`'*'` opts out),
  `maxConnections` (1,024) and `firstMessageTimeout` (10 s), with tests in `packages/netcode/tests/transports.test.js`.
  Authentication and network-level denial of service (a flood below the TCP layer) are still the application's.
- **Recheck of F20 (2026-11-05):** not reproduced, and not identified. The repository, the private notes and the commit
  history name no decoder, input or time for it, and the audit report is not on this PC. Every fuzz target ran 10 s (seed
  1, 0 findings on the 26 named targets), and `decoders/ktx2` and `environment/exr` 60 s (seed 7, 0 findings), on the
  RTX A6000 PC. The audit ran on a slower laptop, and one fuzz target it had left the engine with its package on
  2026-10-29, so F20 may have gone with it.
- **Needed to close:** the audit's F20 text (its input, or at least the target and the time). Then a regression test that
  fails without the fix.

### Fixed: the text colour emoji check supplies its own font

Fixed by 03a7d22ea (2026-10-28). packages/text/tests/color-font.js builds an original COLR/CPAL test font. The browser check always renders its two coloured glyphs; an optional system-font probe reports when that system font has no colour glyph. packages/text/tests/text.test.js checks the generated font and the diagnostic contract. Lane C source audit confirms both paths remain in the current check; no system font installation is required for the mandatory colour-rendering proof.

### biomes flythrough on laptops: the slow sends frame runs past 3.5 ms while the page thread is off the CPU

- **Now (2026-11-05):** the 600 s kill below is no longer seen: 3 runs of `test:gpu:flythrough` on the Intel Arc 140V
  laptop at b4d10441 each ended in 40 to 48 s on the slow sends assertion with its own error and a bounded teardown,
  no `SHUTDOWN_TIMEOUT` and no hang. What is open is that assertion; see **The slow sends frame on the Arc laptop**
  below for the measured cause. Earlier history follows.

- **Repro:** on the Intel laptop (Arc 140V) at 6a8607de, `biomes test:gpu` in the GPU package tests printed all three
  checks OK (view; objects 172569; flythrough p99 +0.00 ms) and then "HUNG: no result after 600 s, process tree
  killed". Not seen on the RTX A6000 PC; the laptop reruns it 3 times.
- **Measured here** (RTX A6000, 9950X, one run in a shared GPU slot): the chain takes 431.5 s of its 600 s limit
  (view 2.8 s, objects 14.9 s, flythrough 413.7 s, of it the six timed flights 298 s); the flythrough's close took
  0.2 s. Earlier check:merge runs here: 326 to 431 s.
- **Two causes fit; which one is not known yet:**
  1. A teardown wait with no limit: `close()` in `scripts/browser.js` waited for the WGSL compilation reports with a
     bare `page.evaluate`, which never times out, so a `getCompilationInfo` the GPU process never answered (Arc has
     WebGPU promises that never settle, see the startup-hang fix) or a page that never answered held the suite
     silently. Fixed: `settleWgslReports` (`scripts/support/wgsl-guard.js`) fails within 30 s naming the modules
     still waiting, or the page; and the biomes checks call `watchExit` (`scripts/support/shutdown.mjs`), which names
     what is still open (`process.getActiveResourcesInfo()`) and exits 1 when a finished suite does not end within
     30 s. Tests: `tests/wgsl-guard.test.js`, `tests/shutdown.test.js`.
  2. The chain is near its limit: the whole `test:gpu` (three checks) is one step with the default 10 min limit, and
     on the fastest PC it already takes 72 percent of it; the flights run in real time, but world creation, prefetch
     and idle waits scale with the CPU, so on the laptop the chain can reach 600 s right as the flythrough ends.
- **Needed to close:** the laptop's three reruns at the commit that carries the fix above. A `SHUTDOWN_TIMEOUT` or
  "did not exit" message names the stuck handle (cause 1, fix it there). A kill with no such message is cause 2: the
  step's wall time (gpu-packages.json `seconds`, and the time the flythrough's OK line printed) decides between
  splitting the chain into one step per check and a measured `margo.gpuTestTimeoutMinutes` for biomes, which is
  Scott's call.
- **Since 2026-10-30:** the chain is split, one step per check (`test:gpu` view, `test:gpu:objects`,
  `test:gpu:flythrough`), each with its own 10 min limit; the flythrough, a timing test, runs last under the exclusive
  GPU lock (it failed at +2.6 ms worst frame in a shared slot beside other suites). A failed check exits at once with
  its own error (`runSuite`, `scripts/support/shutdown.mjs`), its teardown bounded and printed beside it: the laptop's
  3 kills at 8bd1fb40 came after 'packing:', which fits an assertion that failed there and then the unbounded WGSL wait
  in close() (cause 1). Open then: the laptop's slow sends check (one frame with 2 ms sends: 5.8 ms seen once
  standalone, limit 3.5 ms, 2.3 to 2.4 ms before); not loosened. See the slow sends bullet below.
- **Since 2026-10-30 (Scott's ruling):** the flythrough step has a 750 s (12.5 min) limit, set per script in
  `packages/biomes/package.json` (`"margo": { "gpuTestTimeoutMinutes": { "test:gpu:flythrough": 12.5 } }`, read by
  `packageMinutes` in `scripts/support/run-limited.mjs`); the view and objects steps keep 600 s. Test:
  `tests/gpu-timing-lock.test.js`.
- **The slow sends frame (cause found for one frame, the rest not proven):** the laptop's 4.0, 5.6 and 5.8 ms frames
  (limit 3.5 ms: a 2 ms send plus 1.5 ms) came from the check before 2bb1ab52f, which timed the view's frame on the wall
  clock with the check's own busy waits inside it. The laptop's trace of the 4.0 ms frame (flight 6, frame 77) shows
  the page thread stopped 2.9 ms inside the wait that stands for a 16 kB r32float write's cost, with no garbage
  collection, compile or task on the thread; the real write took 0.1 ms or less. Since 2bb1ab52f the waits run on
  `tests/flythrough-clock.mjs`, which leaves out time the thread did not run inside them and still counts a stop in the
  view's code or a slow real call (`tests/flythrough-clock.test.js` fails against the old wait); the limit is
  unchanged. The 5.6 and 5.8 ms frames had no trace. Read at 72de6c42, the view cannot spend more than one send or one
  copy step begun inside its 0.25 ms budget in a frame, plus the plan: each send step posts once (the overview job per
  worker starts all 4 workers at attach, so no send in a flight starts a worker, which would post twice), a send starts
  only on budget that covers the last send's cost, and terrain goes in 16 kB bands, never a whole 200 kB tile. That
  fits the 2.3 to 2.4 ms of the other runs, so the 5.8 ms frame was most likely the same kind of stop. Not proven: the
  A6000 PC has never shown it.
- **Needed to close:** on the laptop, at a commit that has the worst-frame report (the commit after 72de6c42 that adds
  this bullet), run `npm run test:gpu:flythrough --workspace @margoengine/biomes` (it takes the exclusive GPU lock) 3
  times. The `slow sends worst frame:` line takes the slowest frame apart: view time, clock time, time not run inside
  the waits, sends, texture writes and kB, and the time in the real postMessage and writeTexture calls. 3 passes:
  remove this entry. A failure names its owner: 2 or more sends, or about 200 kB of writes, in that frame is the view's
  scheduling (`#apply` in `src/view.ts`); most of it in the real calls is the browser or the Arc driver (still counted,
  hunt it there); neither is the view's own code.
- **The slow sends frame on the Arc laptop (measured 2026-11-05, b4d10441, Core Ultra 7 258V, 8 cores, Arc 140V,
  Chrome 156, on mains, Balanced power plan, Zoom, Snagit and Grok Bot open):** the 3 runs failed at 3.7, 3.6 and
  4.0 ms of view time. Their worst frames: 1 send and 0.0 ms in real calls (3.7 ms); 1 send and 0.6 ms in real calls
  (3.6 ms); one terrain band, 4 writes of 16 kB, 0.6 ms in real calls, 2.2 ms more lost inside the waits (4.0 ms).
  None is 2 sends or a whole tile. A diagnostic copy of the flight (3 flights, a per-frame log of every step, send
  and texture write, and a Chrome trace with the page thread's CPU time between marks at each frame's start and end)
  puts the rest on the operating system: the frames over the limit had the page thread on a CPU for 0.9 to 2.4 ms of
  3.6 to 5.3 ms. One objects step (scatter `setTile`, plain JavaScript with no GPU call) took 3.8 ms on the clock in
  a frame of 0.9 ms CPU time; a frame that only planned took 2.3 ms with 0.8 ms CPU time; one real `postMessage` took
  1.4 ms (a worker wake, as on the N100 below) and one 16 kB `writeTexture` 2.5 ms, each with the thread mostly off
  the CPU. The view's own code is as fast as on the A6000 (time outside waits and real calls: median 0.2 ms on the
  laptop, 0.1 ms on the A6000, which ran the same diagnostic at 2.5 ms worst, 0 frames over). The flights failed 1
  in 3 under the diagnostic (4 frames over, worst 4.8 ms; the others 3.1 and 2.8 ms). Same cause as the N100 entry
  below: the page thread loses its core to the 4 busy workers, the GPU process and other programs.
- **Needed to close (Scott's call):** nothing in the view spends the time, so no view change is a fix, and the limit
  and the check stay as they are. Two things are left to decide: (1) a quiet rerun on the laptop with the other
  programs closed, which says whether the laptop can pass as it is; (2) whether the check should time the view's
  frame by the page thread's CPU time from a trace (the diagnostic's method), which leaves out every stop the
  operating system makes, not only those inside the check's waits; it would also leave out a worker wake that blocks
  the thread, which the check counts now.
- **Since 2026-11-05 (bounded without a GPU run, Scott: no GPU checks now):** `packages/biomes/tests/gpu-chain-bound.test.js`
  pins the structure that keeps a stuck check from hiding: every biomes GPU step has a limit above its A6000 time with a
  1.4x margin, none chains more than two check files (the timing test runs alone), and every check file ends through
  `runSuite` and `watchExit`. The kill itself is still not reproduced; the laptop reruns of the first **Needed to close** above still close the entry.
- **Since 2026-11-05, the Ubuntu box (Intel N100, 4 cores and 4 threads, Linux 7.0, Chromium 156) fails the slow sends
  check every run** (view frame max 9.0, 5.4, 5.5, 5.3, 7.6 ms against 3.5; each worst frame 1 send, no texture write,
  3 to 6.8 ms inside the real postMessage). Measured, at 35673dfa1 with no source change:
  1. **Not the message.** A job message is a few fields (`view`: op, x, z, the material names, step, canopy; `place`:
     op, pid, x, z, split, detail, ahead) and results come back as transferred buffers (`collect` in
     `src/biomes.worker.ts`). A trace of one slow sends flight (38 posts over 1 ms) puts every slow post inside a task
     whose thread time is 2.1 to 2.5 ms, which is the check's 2 ms wait plus at most 0.5 ms; the rest of the task, 1.3
     to 7.6 ms, is time the page thread was not on a CPU. No garbage collection or other event inside those posts.
  2. **It is the scheduler waking a worker.** Every post in the pool goes to an idle worker (`#pump` posts only then),
     so every post wakes a sleeping thread. Posts are cheap (at most 0.1 ms over 74 posts) while at most one other
     worker runs, and dear (mean 0.3 to 0.6 ms, up to 5.9 ms) while two or three others run. A page with no engine code
     (4 or 5 workers: some spinning, one asleep) shows the same: waking the sleeping one with 3 spinning took over 1 ms
     in 51 to 63 of 200 posts (about 3 ms each, one Linux time slice), whatever the page thread ran before the post
     (0 to 3 ms); posting to a worker that is running took over 1 ms in 0 of 600 posts. Waking a small relay worker
     that forwards the job made it worse (over 1 ms in 167 to 184 of 200).
  3. **Fewer workers do not clear it.** With the check's world forced to 3 workers: 5.5 and 5.1 ms; with 2 workers:
     4.6 and 2.7 ms. On 4 threads the page thread, the GPU process and two or more busy workers fill the CPU, and the
     operating system takes a slice from the page thread at a wake (and elsewhere: the check already sees up to 2.9 ms
     lost inside its own waits on this box).
  The view sends at most one job per frame, first in its frame, as the check requires; what costs is a wake the job
  needs. No limit is changed and nothing is skipped. The one lever left in the pool is to run fewer workers at once
  than the hardware threads, a throughput loss, and even 2 of 4 failed one run in 2 here; Scott's call. The
  diagnostics (per-post timing by busy workers, the trace reader, the wake page) are kept on the box in
  `~/margo-test/repo` (`diag-flythrough.mjs`, `wake-check.html`, `wake-check.mjs`).

### GPU resets during busy check:merge runs on the RTX A6000 PC (nvlddmkm event 153)

- **What:** the Windows System log shows nine `nvlddmkm` event 153 entries ("Error occurred on GPUID: 100") on
  2026-10-27 and 28: 07:42:55, 08:18:47, 08:58:27, 09:37:03, 09:53:29, 22:45:31, 22:45:39, 01:21:49 and 01:41:02,
  each while two or three `check:merge` runs shared the GPU (NVIDIA RTX A6000, driver 617.42, hardware-accelerated GPU
  scheduling on, Edge 156 headless). Each took the WebGPU device of one page, and a page asking for a device just then
  was refused: sciviz at 01:21:47 failed its first `requestDevice` with "D3D12 create command queue failed with
  E_OUTOFMEMORY (0x8007000E)" with 2 of 48 GB in use, so the failing test is the casualty, not the cause.
- **Two kinds of reset, told apart by measurement (2026-10-28):** a Windows watchdog reset (TDR) of one GPU engine
  writes a WER `LiveKernelEvent` 141 report and a `WATCHDOG-*.dmp`; event 153 comes with none, so it is the NVIDIA
  driver's own reset, not the Windows 2 s watchdog. A deliberate 3 s compute dispatch on the A6000 gives exactly the
  first kind (141 at 02:08 and 03:11) and no event 153, so our long dispatches are not what makes 153. Nine 141
  reports from 19:27 to 23:04 on 10-27 came while Edge ran on the AMD integrated GPU (bug 33; at 23:04 the path tracer's
  spec-math suite was on `amd` and lost its device), which is slow enough for our bigger dispatches to pass 2 s.
- **Not the trigger (each run under the GPU lock, with a watcher sampling every second):** killing the browser's GPU
  process in the middle of a 0.6 s dispatch (15 times) or the whole browser tree (15 times); CDP
  `Browser.crashGpuProcess` mid-work beside a second busy browser (12 times, the lifecycle test's crash); 300 device
  create and destroy cycles; 6 browsers with back-to-back dispatches for 90 s; one 0.4, 0.8, 1.0 or 1.4 s compute or
  draw submission at a time against 2 or 3 other browsers (the A6000 runs each submission to the end before another
  process's, so a short one waits the whole long one, but nothing resets); `test:lifecycle:browser` beside sciviz, 10
  rounds; two whole `check:gpu-packages` runs and four `visual:check` runs beside other agents' checks (03:00 to 03:10).
- **Best evidence so far:** eight of the nine came while Scott's Remote Desktop session was connected (07:14 to 14:42,
  21:11 to 22:59, 01:20 to 01:22; the 01:21:49 reset 17 s before a disconnect); while it is connected the A6000 also
  draws that session's desktop (it is DXGI adapter 0 only then, bug 33). With the session disconnected, 0 resets in about 90 minutes of the heavier load above. The
  01:41:02 reset is the exception (disconnected). The morning ones came about every 40 minutes, the length of one
  check:merge run, while the path tracer still traced a whole frame in one dispatch (fixed 49dca9dd at 11:07).
- **Also found:** a watchdog reset of one engine (141) cuts that submission short and WebGPU does not lose the device:
  `onSubmittedWorkDone` resolved at 2.3 s for a 3 s dispatch, a later dispatch and a new device worked, so the page got
  wrong results with no error. Only the event log shows it, which is why the checks read it (below).
- **What is done:** a page whose device is lost (any reason but `destroy()`), or whose `requestDevice` the driver
  refuses, fails its next wait at once, and the message names the reset from the Windows event log (for example
  "nvlddmkm event 153 at 01:21:49") or says that none was logged (`scripts/support/device-loss.js`,
  `scripts/support/driver-resets.mjs`). A `check:gpu-packages` test, or any other `check:merge` step, that fails while
  the log shows a GPU driver reset runs once more; the reset and the rerun are printed and kept in
  `test-results/gpu-packages.json` and `test-results/check-merge.json`, and a second failure fails the check. A run
  that passed only on such a rerun ends with a "PASSED WITH A DRIVER RESET: <step>, <reset and time>" line per step
  and sets `passedAfterDriverReset: true` at the top of both files, so it never reads like a clean pass. The path
  tracer viewport traces at most 2^20 paths a dispatch (`packages/voxel-pathtracer/src/dispatch.ts`).
- **2026-11-09 skip-gap item 2 occurrence:** shadows' README gate passed 14/15,
  including the new rt-alpha example, but ordinary RT was refused at requestDevice
  with D3D12 create-command-queue E_OUTOFMEMORY. Windows records nvlddmkm event
  153 at 16:05:40 EST, inside that gate's 16:05:18..16:05:51 interval. A later
  nvidia-smi query reports 3,632/49,140 MiB used, not VRAM exhaustion. No shader or
  traversal assertion failed. Preserve the full first report and run only the
  failed ordinary-RT example once under the existing driver-reset policy; do not
  weaken the test or replay the fourteen passes. The single failed example passes on its one isolated rerun. The original gate
  log is test-results/skip-gaps/item2-shadows-readme.log, with the matching reset
  in item2-readme-driver-reset.json and the isolated pass in
  item2-shadows-readme-failed-only.log. This remains a pass after a driver reset,
  not a clean first-run gate.
- **Needed to close:** run the checks with the Remote Desktop session disconnected (or with Remote Desktop not using the
  GPU) for a day and count resets; if 153 still comes, a per-second recorder (GPU engine use and memory per process,
  Edge GPU processes, lock holders, running tests; kept with the private notes) saves the 150 s before it, and the
  NVIDIA driver is the next suspect (update it, or try with hardware-accelerated GPU scheduling off).

### 4x MSAA blending is not repeatable (RTX A6000 under CPU load, and Intel Arc 140V)

- **What:** the voxel GPU check (`packages/voxel/tests/render-browser-check.mjs`, run by `check:merge`) fails now and
  then in a busy run at its "tree and overhang" view, at 4x MSAA: "meshes in another order drew {differing:36, max:1}"
  (mesh arrival order step) and "greedy vs naive differ over an area" (same view, same pixels). Run alone it passes.
- **Repro:** `node scripts/gpu-lock.mjs run --owner=<you> -- node packages/voxel/tests/render-browser-check.mjs
  --repeat=450`: one renderer, the still view drawn 450 times while the other cores spin. 1 to 3 frames in 450 differ
  from the first by 1 in 8 bits (1 ulp on rgba16float) on 13 to 82 pixels, then the next frame is back (Edge and
  Chrome, Dawn D3D12, RTX A6000, driver 32.0.16.1742, 2026-10-26).
- **Intel Arc 140V** (driver 32.0.101.8860, main at 30bea6fa, recheck of 2026-10-27): the same repro drew 6 of 450
  frames differently, always the single pixel (101, 72): [109, 107, 104] instead of [100, 99, 96], 9 of 255 (the
  printed frames: 25, 198, 256, 327, 400), so all 6 also exceed the blended-4x tolerance of 1 below. So it is not
  NVIDIA-only; the earlier run on main d000e4b6 that drew all 450 alike was not a controlled comparison (another
  commit and other conditions).
- **Second Intel Arc 140V** (an outside audit's laptop, revision 74a01810, 2026-10-28): the same 450-frame repro
  differed on 4 frames (46, 99, 112 and 326), at the same pixel (101, 72), [109, 107, 104] instead of [100, 99, 96], 9
  of 255. The standard voxel check passed there.
- **Cause of the Arc's pixel (101, 72): below Margo, in the Arc's 4x MSAA blending (traced 2026-10-30, Arc 140V,
  driver 32.0.101.8860, Edge 156.0.4314.50, main c041238b).** Only sample 0 of that pixel goes wrong, only in the voxel
  translucent pass, always to 99.96.92 instead of 65.63.62 (samples 1 to 3 stay 112.111.108; the clear, the opaque pass
  and every queue write are the same each frame). Four glass faces cover the pixel, in draw order: the back face of
  block (22, 16, 10) on samples 2 and 3, the top face of that block on sample 0 alone, the back face of block
  (21, 16, 10) on sample 1 and the front face of block 21 on all four. 99.96.92 is, to within rounding in all three
  channels, the top face blended over the back face's colour (121.118.111) instead of over the clear colour: sample 0
  takes the destination of samples 2 and 3, which no per-sample blend can do. Each face alone, and the four together
  (as their own draws), drew the same samples 1000 times in 1000; the whole translucent layer (55 quads, as one draw
  or as 55) gave the wrong sample 0 in 7 and 8 frames of 1000. One frame of the view recorded (every WebGPU object
  with its descriptor, shader text and bytes, and the frame's calls) and replayed on a fresh device with no Margo code
  gave it in 4 of 1000 frames, and in 8 of 1000 with the opaque pass's draws left out, so it needs no Margo code and
  no opaque content. A synthetic page (in every pixel one blended triangle on samples 2 and 3, then one on sample 0)
  stayed exact on the Arc in 9 layouts and orders; what more of the real layer it needs is not known.
- **Repro of the Arc case:** `node scripts/gpu-lock.mjs run --owner=<you> -- node
  packages/voxel/tests/render-browser-check.mjs --replay=1000` records the still view's frame
  (`scripts/support/webgpu-trace.js`) and replays it in `scripts/support/webgpu-replay.html` under CPU load; it fails
  when any replayed frame's samples at (101, 72) differ, after checking that the replay reproduces the live frame
  (`--skip=1` drops the opaque pass's draws). On the RTX A6000 the same command shows NVIDIA's fault below (all four
  samples set to their average, about 1 frame in 300).
- **Khronos ToyCar and IridescenceLamp** (gltf-pro transmission, `examples/khronos-gallery.html?model=Name`, native
  WebGPU, 640x480, 2026-10-30): four captures of the still frame differ on 67 to 153 pixels by 1 of 255 (ToyCar, all
  on the windscreen) and on 0 to 18 pixels by up to 28 of 255 (IridescenceLamp, the glass rim over the base). The page
  draws every animation frame; two calls of `engine.render()` in a row already differ.
- **Cause: below Margo, in the GPU's 4x MSAA blending (found 2026-10-30, RTX A6000, Edge 156, Dawn D3D12 and D3D11).**
  A blended draw over a pixel whose samples hold different colours sometimes writes one value to all four samples,
  about the average of the four correct per-sample results, and which pixels get it changes from frame to frame (in
  4x4 and 8x8 pixel blocks along the blended mesh's own edges). Measured in the ToyCar frame: the command stream is
  the same each frame (pipelines, bind groups, buffers, the two `writeBuffer` calls bit for bit), and the
  multisampled colour copied at the start of the glass pass is the same each frame, sample for sample. After the
  transmission tint draw alone (a constant colour, blend `dst x src`) pixel (360, 88), before it
  `[5e5854, 5e5854, 6b8068, 6b8068]`, holds `[1c4619, 1c4619, 20661f, 20661f]` in one frame (dst x constant per
  sample, correct) and `[1e561c, 1e561c, 1e561c, 1e561c]` in the next. No input can make a per-sample blend do that.
  The same happens in plain WebGPU with no Margo code: `scripts/support/msaa-blend-repeat.html` (a clear pass, an
  opaque pass of flat-coloured triangles, a coarse mesh blended `dst x constant`, a resolve pass) gives 11 of 12
  frames different after the blended pass, with 0 samples different before it. Without the glass draws, at 1x, or
  with the blended pipelines' sample mask leaving out any one sample (`mask: 7`, 11, 13 or 14) every frame is the
  same, in the plain page and in both Khronos models; the mask 15 (all four samples) still differs. The voxel
  findings above fit it: the pixels are blended glass over edges whose samples differ, a zero destination factor
  hides it, `max` blending does not.
- **Repro:** `node scripts/gpu-lock.mjs run --owner=<you> -- node scripts/msaa-blend-repeat-check.mjs` (plain WebGPU,
  prints the first changed pixel with its samples before and after the blended pass; exit 1 when frames differ),
  `--mask=7` for the comparison, `--khronos` to also capture ToyCar and IridescenceLamp four times each (after
  `npm run build:packages`).
- **Three GPUs, same repro, Edge 156.0.4314.50, 2026-10-30:** RTX A6000 (driver 32.0.16.1742): 29 of 30 frames
  differ; Intel Arc 140V (driver 32.0.101.8860): 0 of 30, with `--mask=7` 0 of 30, ToyCar and IridescenceLamp 0 pixels
  in three captures; AMD Radeon 680M (driver 32.0.21030.2001): 0 of 30, 0 of 30, 0 pixels. So the plain-page blend
  noise is NVIDIA's (hardware or driver), not Dawn's or Chromium's. The Arc's voxel pixel (101, 72) is a different
  fault of the same kind (one sample takes another's destination), traced above with its own replay repro.
- **Khronos LightsPunctualLamp, the same fault traced to the arithmetic (RTX A6000, driver 32.0.16.1742, Edge
  156.0.4314.50, 2026-10-31):** the still frame changes on 3 to 26 pixels by up to 40 of 255 (usually (292, 160-162) by
  3), so `visual:compat` fails when two native captures catch different frames. One still frame recorded (every object,
  shader and byte) and replayed 1000 times in a new browser with no Margo code gave 12 distinct frames, 40 of 1000 unlike
  the most common one, whose pixels equal the live page's on all 640x480. Margo's inputs are therefore out: every frame clears
  colour and depth, samples only fixed textures (the default transmission path has no scene snapshot or mip chain), and
  has no validation errors. Left-out draws, 300 frames each: no glass draws 0; tint draw only, 32 frames (4 pixels, max 1);
  additive glass draw only, 78 (4 pixels, max 26); all draws 23 to 34. The whole frame rewritten to 1x: 0 of 500. Blended
  pipelines with `mask: 7` or 14: 0 of 300; `mask: 15`: 19 of 300. Hiding the transmission primitive or the point lights
  was measured live before this trace: 0 changing pixels, and no change. At (292, 160) the opaque samples are
  `149.150.149 | 77.80.87 | 157.162.161 | 77.80.87`, whose average is 115.118.121. The additive glass draw adds 81.68.63
  on samples 0 and 2, giving the correct `230.218.212` and `238.230.224`; in the faulty frames both hold `196.186.184`,
  exactly the average plus the source. So the blend reads the four samples' average as its destination and still applies each
  sample's source. On the Dawn D3D11 adapter (`--adapter=d3d11`) this pixel held 200 of 200, while 6 of 200 frames differed
  elsewhere. Not measured on another GPU, and Chromium's software adapter is not available on this PC (Edge and Chrome both
  report no adapter), so that it is NVIDIA's alone rests on the plain page's three-GPU row above.
- **Repro of the lamp:** `node scripts/gpu-lock.mjs run --owner=<you> -- node scripts/msaa-blend-repeat-check.mjs
  --replay=LightsPunctualLamp --pixel=292,160 --replay-frames=1000` (after `npm run build:packages`); `--replay-mask=7`
  for the comparison.
- **Earlier notes on the voxel case:** every differing pixel is seen through
  the glass wall, along glass and terrain edges (pixels whose samples hold more than one surface). Between the frames
  nothing that Margo hands the GPU changes: no buffer write but the frame uniform and indirect arguments, bit for bit
  the same each frame; the glass quads in the same order. The frames stay identical at 1x, without the glass, with the
  glass drawn unblended, with blending on but the destination factor zero, with the glass drawn in the opaque pass,
  without core's mid-frame resolve and with Dawn's D3D12 render-pass toggle off; they still differ with `max`
  blending, which does not depend on order. Mesh arrival order is not involved: 168 permutations of the mesh replies
  drew the same pixels on a quiet machine.
- **What the checks do about it (Scott, 2026-10-26):** the voxel GPU checks allow a difference of at most 1 in 8 bits
  (1 half-float ulp on the rgba16float HDR scene) on views that blend a translucent layer at 4x MSAA, and nowhere else:
  1x views, views with no translucent layer, every other check and every other package stay exact. The rule is the named
  constant `BLENDED_4X_MAX_CHANNEL_DIFF` in `packages/voxel/tests/blend-tolerance.js`, unit-tested
  (`blend-tolerance.test.js`: 1 passes, 2 fails). The GPU check shows it cannot hide an ordering bug: the same two
  translucent panes in the other order differ by up to 132 of 255 (`swapped layer order` step), and the mesh arrival
  order step stays a pixel comparison with that tolerance only. The check's output prints the exact count next to the
  tolerant one, and `--repeat` reports both (it still fails on any exact difference: it is the repro).
- **Recheck (2026-11-05, RTX A6000, driver 32.0.16.1742, Edge 156.0.4314.58):** `scripts/msaa-blend-repeat-check.mjs`
  still has 29 of 30 frames differing with no Margo code, and 0 of 30 with `--mask=7`. Nothing new to fix in Margo.
- **Needed to close:** the plain-WebGPU page sent to NVIDIA (it repeats on no other GPU tested) and the recorded voxel
  frame with its replay page sent to Intel (Scott decides both), and their fixes or explanations recorded here; then
  the voxel tolerance can go (the Arc's 9 of 255 is over it, so the voxel checks can fail now and then on that laptop,
  as `--repeat` does there), and ToyCar and
  IridescenceLamp get an exact repeat-capture check, and LightsPunctualLamp's recorded exact still frame
  (`scripts/support/visual-compat-expected.json`) can hold on this GPU. Margo has no correct way around it: leaving a sample out of the
  blend, or drawing a full-screen layer first to change the GPU's tile state, changes or adds work to hide the
  symptom.


## Performance losses still open

Measured but not fixed. Their history, sources and rerun commands are in
[whitepaper/perf-history.md](whitepaper/perf-history.md#open-losses).

- **Navmesh build of one gapped floor is slower than recast-navigation 0.44.0** (`@margoengine/navmesh`, perf history
  entry 94): 3.190 ms against 1.130 ms, paired turns, per-round minimum, busy machine, diagnostic. Repro:
  `node packages/navmesh/scripts/rival-bench.mjs` after the navmesh build. The rival is installed outside the
  repository. Cause not yet found. Publishing the number does not close it.
- **Navmesh path on that floor is longer than Detour's** (`@margoengine/navmesh`, perf history entry 94): Margo 24.212
  (north hall, 4 points) against recast-navigation 0.44.0 at 23.778 (south hall, 5 points). The corner route through
  either hall is about 23.26. The open floor is equal (both 22.627416997969522, the Euclidean length). Cause not yet
  found. `packages/navmesh/test/path-length.test.js` checks the open floor and that the gapped path stays out of the
  hole. It does not freeze Detour's length. Publishing the number does not close it.
- **Volume-64 frame is slower than VTK.js 38.0.5** (`@margoengine/sciviz`, perf history entry 102): 1.500 ms against
  1.300 ms, one 256 x 256 frame plus the pixel read, paired turns, per-round minimum, busy machine, diagnostic. The
  rounds overlap (Margo 1.5 to 2.0 ms, VTK.js 1.3 to 2.2). Mean absolute channel difference of the last pair is 1.801.
  Repro: `node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/sciviz/scripts/rival-bench.mjs`
  after the sciviz build. The rival is installed outside the repository. Cause not yet found. Publishing the number
  does not close it.
- **A degree-3 cloud of 1,692,538 splats does not attach** (`@margoengine/splats`, perf history entry 103): the
  published truck at iteration 7,000. SH is 16 coefficients per channel as float32 (192 bytes a splat, about 310 MiB).
  `Splats.attach` refuses that buffer because the device's `maxStorageBufferBindingSize` stays at the WebGPU minimum
  of 134,217,728 bytes. Core does not request a higher limit. The largest degree-3 cloud that attaches is 699,050
  splats. The batch 168 row uses that prefix of the ply on both sides. Cause: the storage binding is not raised, and
  the SH buffer is one binding. Publishing the prefix does not close it.
- **Truck 7k prefix frame is slower than GaussianSplats3D 0.4.7** (`@margoengine/splats`, perf history entry 103):
  10.765 ms against 4.500 ms, one still frame of the 699,050 prefix at 979 x 546, paired turns, per-round minimum,
  busy machine, diagnostic. The rounds do not overlap (Margo 10.765 to 14.535 ms, GaussianSplats3D 4.500 to 7.470).
  The rival's shared-memory GPU sort drew no calls, so the number is its CPU sort. Repro:
  `node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/splats/scripts/rival-bench.mjs`.
  Cause not yet found. Publishing the number does not close it.
- **Truck 7k prefix does not match the published photograph** (`@margoengine/splats`, perf history entry 103):
  world-to-camera PSNR 12.226 dB (MAE 52.272), camera-to-world 10.672 dB (MAE 59.713), against `000001`. The rival
  at the same world-to-camera pose is 9.994 dB (MAE 60.646). The principal point is the image centre. The model is
  the 7,000-iteration prefix, not the paper's 30,000-iteration cloud, and it is not the paper's dataset-average
  PSNR. Cause not yet found. Publishing the number does not close it.
- **10 million points are slower than potree-core 2.0.17** (`@margoengine/points`, perf history entry 105):
  9.000 ms against 5.400 ms, one settled frame of a single 10,000,000 point leaf, paired turns, per-round minimum,
  busy machine, diagnostic. The rounds do not overlap (Margo 9.000 to 12.400 ms, potree-core 5.400 to 7.600).
  Both sides draw every point. Margo waits with `onSubmittedWorkDone`. The rival waits with a one-pixel
  `readPixels`, because `fenceSync` returned `WAIT_FAILED`. Repro:
  `node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/points/scripts/rival-bench.mjs`.
  Cause not yet found. Publishing the number does not close it.
- **Cornell box irradiance does not match a Cycles bake** (`@margoengine/lightmap`, perf history entry 108):
  mean absolute error 0.069543 per channel over 881 texels, 0.211475 of the Cycles mean (0.328848). Margo's mean
  is 0.305736. The largest miss is 0.900128. The 8-bit step is 0.016984. Blender 5.3.0 Beta, Cycles, 128 samples,
  `diffuse_bounces` 2. Margo uses physical irradiance, one per-quad radiosity bounce and 16 area samples. The
  short block top is snapped from (240, 165, 272) to (242, 165, 274). Repro:
  `node packages/lightmap/scripts/rival-bench.mjs` after the lightmap build. Cycles runs outside the repository.
  Cause: Margo gathers only 16 cosine rays from each texel using a single mean outgoing radiance per quad,
  whereas Cycles integrates spatially varying transport. Area sampling and 8-bit irradiance quantization also
  contribute; their individual shares of the error are not isolated. Publishing the number does not close it.
  Batch 187 fixes a separate cause: area shadow rays and diffuse gathers culled opaque back faces, allowing light
  through the tops of the blocks onto floor texels inside them. Both sides now block visibility; only front hits
  supply outgoing radiance. With the unchanged frozen 881-texel reference, physical path mode, seed 1, 16 area
  samples, one bounce and 32 bounce rays, MAE is 0.048730 (relative 0.148184), maximum 0.353979. This is still an
  open accuracy difference, not parity: finite ray counts, cached texel-centre direct illumination, RGBA8 output
  and the reference's diffuse-event convention remain to be isolated in the fix phase. No reference was replaced.

- **Own 2D physics steps the 100-row pyramid in 2.9 ms in Wasm where Box2D v3's Wasm takes 1.4 ms**
  (`packages/physics2d/kernel`, perf history entries 83 to 91): repro `BOX2D_WASM=<box2d3-pyramid.mjs> node
  scripts/physics2d-kernel-browsers.mjs` (the Box2D build is in reproduce.md). Cause, measured: the broad phase was
  1.03 ms of 7.2 and now takes 0.14 in Wasm (the box tree); compact solver bodies (entry 85), colour order (86), four
  contacts at a time in SIMD lanes (87), whole-body loads and two blocks a visit (90) and fewer selects, kept gaps and no
  sorted copy (91) took the passes from 4.6 to 1.17 ms, every bit the same; box pairs colliding in lanes (89) took the
  narrow phase from 1.1 to 0.80 ms. In one page (entry 91) Margo's Wasm steps it in 2.93 to 3.24 ms, Box2D v3's Wasm in
  1.40 to 1.45 and Rapier 2D's Wasm in 7.63 to 8.14 (Edge 157, Firefox 157). Like for like natively at four lanes:
  Box2D 1.24 ms, Margo 2.87. Left, Wasm, by phase: the narrow phase 0.80 ms (14,950 box pairs, about 54 ns each), the
  solver's setup 0.58 (contact rows 0.27, colouring 0.11, blocks 0.10) and the passes 1.17 (now about as bound by
  operation count as by the dependency chain). The remaining candidates are contact rows built straight into the
  blocks after the colouring, then `closest` skipped where the face is provably closest.
  Entry 92 implements four-pair SAT/clipping with every manifold bit retained, but only takes the paired narrow
  phase from 0.795 to 0.752 ms (11/12 rounds) and the uninstrumented step from 2.885 to 2.852 (17/24);
  the 0.35 ms narrow target is still open. After: Edge 2.86 ms against Box2D 1.41, Firefox 3.16 against 1.50
  (diagnostic, changing load). Next: setup rows straight into coloured blocks; profile lane gathers, masked
  endpoint selection and scalar distance fallback before doing more narrow-phase work.
  Latest corrected-baseline measurements (entry 106) still lose: Edge 4.090 ms against Box2D 1.490 and Rapier
  8.400; Firefox 4.400 against 1.440 and 9.780 (busy, 12 rounds, unchanged scene). Retained flat planner buffers
  remove 397,400 native allocation/reallocation requests across 40 steps with identical outputs, but paired
  ratio median 0.9916 (IQR 0.9807 to 1.0010) establishes no stable timing gain. The correctness fixes' extra
  cap certification and supported-path planning remain work to profile, not grounds to remove required bars.
  Existing point normals still fail 1:100 drift, 1:1000 sag/drift/creep and chain-box seam speed after the support
  fix, so replacing the block with that option is rejected. No faster solver is accepted from a partial matrix.
  Entry 107 removes compiled finite-predicate work with identical output, but its paired ratio 1.0001
  (IQR 0.9254 to 1.0686, 12/24 faster) proves no timing gain. Latest separate browser sessions still lose:
  Edge Margo/Box2D/Rapier 4.065/1.500/8.855 ms; Firefox 4.420/1.420/10.460 ms. Profile the complete corrected
  hot path before another redesign; the required block-coupled accuracy remains intact.
  Entry 112 avoids repeated bounds validation and rejected-component predicates without changing results.
  Its loaded paired ratio median 0.8705 (IQR 0.7735 to 0.9236, 20/24 faster) favors the combined change;
  the current browser/rival table in that entry still loses to Box2D. The complete checked-step profile now
  identifies setup and support-planner preparation as material phases. No physical work or accuracy bar is removed.

- **Own convex decomposition builds 5 to 120 times slower than Rapier's V-HACD** (`@margoengine/physics/decomposition`,
  perf history entry 81): repro `node packages/physics/scripts/decomposition-vs-rapier.mjs` after the physics build;
  cause, measured: the paper's tree search cuts and hulls every trial piece (60 percent of the time in Quickhull), in
  TypeScript. Fix planned with batch 129's decomposition row.

- **three.js `InstancedMesh` against Margo's instanced paths:** partly closed on 2026-10-25 (culled pipeline, one
  upload per frame, GPU spheres, untextured materials); `CulledInstances` now leads on static boxes at 10k and 50k.
  The three gaps still open are the entries below.
- **Galaxy S23 Ultra island demo at 3-5 FPS** (particles off does not help). Partial fixes have landed; no after number
  exists. **Needed to close:** the device, then a measured run.

The entries below were measured with `npm run bench -- instanced --engines=margo,three-webgl,three-webgpu` (busy
machine, diagnostic; numbers and method in [whitepaper/boxes-vs-threejs.md](whitepaper/boxes-vs-threejs.md),
"Instanced: fixes and what is left"). Each cause was measured, not guessed.

### createInstancedMesh draws 50,000 boxes slower than three.js

- **Status:** BLOCKED on a GPU-alone hunt. The cause is not found. It needs the GPU to itself, so the numbers below are all
  diagnostic: they were taken with other lanes on the machine.
- **What:** `@margoengine/materials` `createInstancedMesh`, 50,000 boxes, GPU time per frame: Margo 0.536 ms (0.525 to 0.554
  across runs) against three's WebGPU `InstancedMesh` 0.32 to 0.34 ms (0.319 to 0.341). `CulledInstances` draws the same scene
  in 0.305 ms. At 10,000 Margo leads (0.111 against 0.127 and 0.141 ms, perf-history entry 51).
- **Repro:** the 50,000 box scene of [whitepaper/boxes-vs-threejs.md](whitepaper/boxes-vs-threejs.md), steps in
  [whitepaper/reproduce.md](whitepaper/reproduce.md), Margo `createInstancedMesh` against three's WebGPU build run in its own
  folder.
- **Fixed part:** gltf-pro fetches and passes only what the finished shader reads (0.615 to 0.546 ms, perf-history entry 50).
- **Ruled out in a raw WebGPU pass:** all within one 0.0655 ms timer quantum: vertex stride 80 against 32 bytes, instance
  stride 96 against 64, uint16 against uint32 indices, instance data from storage against attributes.
- **Ruled out in the real bench, by rewriting the shader at `createShaderModule`:** the `f.model` multiply, the normal cross
  products, the mirror sign, the discard lines and the `depth24plus-stencil8` format: 0.533 to 0.541 ms against 0.536 ms. How far to
  trust this: the patterns to replace were seen in a dump of the shader, but the rewritten shader was not read back, so these
  five rest on the replacement having taken effect. A hunt should confirm that first.
- **Ruled out earlier, on the same page:** a fragment stage returning the vertex colour (0.539 ms), the vertex colour fetch
  (0.547 ms), the outputs between the stages (0.546 ms), texture reads and the node x instance matrix product. The first of
  these came before the fetch trimming and covers the shader's cost as it stood then.
- **Still untested:** the cost of fragment lighting as the shader stands today; how many boxes the culled path really draws,
  which decides whether 0.305 ms compares like with like; the instance attribute count (6 against 2 in the culled pipeline);
  and `DynamicInstances` on a moving frame.
- **Needed to close:** a GPU-alone run of those four, starting with reading back the rewritten shader, then the fix in the
  package that owns the cause, or a measured reason recorded as an accepted difference.

### Moving instances spend more CPU than three's WebGL2 renderer

- **What:** 10,000 instances moving every frame: CPU 0.92 ms (`createInstancedMesh`) and 1.10 ms (`CulledInstances`) per
  frame against three's WebGL2 0.63 ms and WebGPU 0.90 ms (2026-11-05, diagnostic; perf-history entry 53).
- **Fixed part:** the matrix maths was 40% slower than three's for a build reason, now faster (perf-history entry 53).
- **Cause of the rest (measured):** `queue.writeBuffer` of the 960 KB of rows takes about 0.2 ms: the upload with it
  stubbed out drops by that, and three's WebGPU renderer, which uploads the same way, lands level with Margo. Validation
  and the row copy take 0.11 ms, and stay (they keep a bad matrix from reaching the GPU).
- **Ruled out:** a bulk `setMatrices` is no faster than `setMatrixAt` (0.78 against 0.59 ms with the matrix maths, Node),
  so `CulledInstances` did not get one.
- **Plan:** a separate matrix stream, so moving instances upload 64 bytes each (640 KB). That changes the vertex layout of
  every instanced path; at the measured rate it saves about 0.07 ms.
- **Since item 53.2 (2026-10-29):** `DynamicInstances` (@margoengine/culling/dynamic) takes 48-byte rows and a bulk
  path (write `matrices`, then `update(from, to)`; a non-finite row draws nothing instead of throwing). Like for like
  with three's `setMatrixAt` (same CPU matrix maths per box, rows copied unchecked): 0.90 against 0.91 ms at 10,000,
  6.67 against 6.11 ms at 100,000 and 16.2 against 15.7 ms at 250,000 (three.js WebGPU; numbers in
  [whitepaper/boxes-vs-threejs.md](whitepaper/boxes-vs-threejs.md), "Moving instances on the GPU"). The checked
  `setMatrixAt` stays about 15% over three at 100,000, the validation cost.

### DynamicInstances: about 15-35% more GPU time than InstancedMesh at 100,000 and 250,000 moving boxes

- **What:** `boxes-100000` moving, every box in view: GPU 1.41 ms against three.js WebGPU `InstancedMesh` 1.23 ms; at
  250,000, 2.73 against 2.00 ms (2026-11-05, diagnostic; perf-history entry 54).
- **Fixed part:** `world` is now built only for shadows and picking (2.76 to 2.73 ms at 250,000, 1.47 to 1.41 ms at 100,000).
- **Ruled out, by measurement at 250,000:** the compute passes cost little (skipping their dispatches: still 2.51 ms
  moving, 1.38 ms static, against 2.73 and 1.50 with them), so the cull is not the gap. Moving the upload's barrier ahead of the
  timed passes changed nothing (2.70 ms).
- **Cause of the rest: not found.** Moving costs about 1.1 ms more in the timed passes than a still frame, even when the
  moved rows reach no draw (compute skipped, so `drawn` is stale). The 12 MB upload runs then, and the CPU takes 15 ms a
  frame, so the GPU idles between frames: either could slow the passes. **Next to test:** a moving frame with the upload
  held and the CPU work kept, then the reverse. three's still frame at 250,000 was not measured in the same run.

The two entries below come from the three.js speed matrix ([whitepaper/perf-vs-threejs.md](whitepaper/perf-vs-threejs.md),
rows 10.11 and 11.3; run `20261026-165034`, busy machine, diagnostic). Their first causes are fixed (perf-history entry
26); what is left is different work.

### STL import still computes normals three's STLLoader leaves zero

- **What:** `p-stl`, a 204,800-triangle binary STL: the plain `parseSTL` 4.9 ms against three's `STLLoader` 2.8 ms
  (run `20261026-201722`, busy machine, diagnostic). `parseSTL` changed in perf-history entry 31.
- **Cause (measured, Node CPU profile of `parseSTL`):** both readers copy the file's floats into one non-indexed
  buffer (614,400 vertices). This file stores zero facet normals, as most writers do. three copies the zeros;
  `parseSTL` computes the flat normal of each such facet (`flatNormal`, about 1.3 ms of its time in Node), writes an
  identity index array and zero-fills a third array.
- **Status: accepted difference in work (Scott, 2026-10-26).** `parseSTL` computes flat face normals on ingestion so the
  mesh is render-ready; three's `STLLoader` copies the file's zero normals, which light wrongly until the user calls
  `computeVertexNormals()`. The full job is measured as `p-stl-normals` (run `20261026-211213`, diagnostic): three
  `STLLoader.parse` + `computeVertexNormals()` 8.7 ms, `parseSTL` 4.7 ms, so Margo is faster when both produce a
  lit mesh. The plain-copy `p-stl` gap stays listed.
- **Rechecked (2026-11-05, perf-history entry 57):** the binary loop now reads each corner once and computes the normal
  from what it holds, with byte-identical output: in Node 5.5 ms became 4.6, a plain copy being 3.1. Run
  `20261105-233654` (busy machine, diagnostic): `p-stl` 4.5 ms against three's 3.5, `p-stl-normals` 5.2 against 10.7.
  What is left is the work itself: the identity index array (0.4 ms) and about 1.1 ms of normal maths.
- **Plan:** for `parseSTL`, the remaining gap is the computed normals, which are
  the behavior a user needs; an opt-out only to win a benchmark would measure less work, so it is not planned.

### Morph targets: CPU per Animation per frame

- **What:** `p-morph`, 100 MorphStressTest copies with 8 weights each changing every frame: 0.35 ms CPU a frame
  against three's WebGL 0.26 (run `20261105-235113`, busy machine, diagnostic; 0.49 before perf-history entry 58). The GPU
  half is fixed (perf-history entry 34: 1.33 -> 0.19 ms); what is left on the GPU is the 0.05 ms deform pass, an accepted
  difference in work recorded in the matrix row 12.5.
- **Fixed (entry 58):** plain glTF materials composed their shader and pipeline key again on each of the 200 draws of
  every frame, twice when the draw asked to join a batch first. They now keep both while nothing that shapes them
  changed. The planned `PBRMaterial` version was not built: `base`, `factors`, `emission` and `settings` are public arrays
  read live each draw, so a version would miss a direct write. The rows are still read every frame.
- **Cause of what is left:** the 200 draws' rows, uniform writes and bindings, and the 100 Animations' own work
  (`setMorph`, validation, weight writes, `upload`, `deformAll`). A multi-primitive model joining a run would not help this
  scene: deformed primitives cannot join an instanced batch (`batchable`).
- **Plan:** write the weights of every Animation of a device in one upload (`packages/animation/src/index.ts`, `upload`),
  then profile again. No core change. For copies playing one clip, `MorphWeightPlayer`
  (`@margoengine/animation/morph-gpu`, 2026-11-06) samples and writes the weights on the GPU; its effect on `p-morph`
  is not measured yet (quiet pass).

### cloneModel: slower than three's clone

- **What:** `p-skeleton-clone`, 50 `cloneModel` copies of RobotExpressive per call (the call also destroys the
  previous 50): 14.3 ms against three's `SkeletonUtils.clone` 8.1 (run `20261105-235810`, busy machine, diagnostic; 84.5
  before entry 28, 63.6 before entry 29, 47.9 before entry 32, 16.8 before entry 59). That run still had one tick a copy;
  the tick is gone since 2026-11-06 (table below) and the row has not been run again, so its new time is unknown.
- **Cause (measured with timers in the scene, 2026-11-05, before entry 59):** a call was 100 ticks (6.4 ms), `destroy` of
  the old copies (2.9 ms), `setup` beyond its ticks (5 ms) and `new PBRModel` and the node copy (8 ms). three's clone
  creates objects only.
- **Plan:** rerun the row in the quiet pass. Whatever is left is `destroy`, `setup` and node creation: make those
  cheaper, or publish the rest as an accepted difference if it is work three does not do.

### GPU picking waits for one readback per pick

- **What:** `p-gpu-pick`, 100 `engine.pick` calls: 369 ms against three's WebGL 67 (run `20261105-234620` and later, busy
  machine, diagnostic; three's WebGPU backend took 423 ms when measured).
- **Cause (measured, CPU profile):** 0.15 ms of JavaScript a pick; the main thread is idle the rest of the time, waiting
  for the pick's GPU pass and its `mapAsync` readback. `engine.pick` answers overlapping calls one at a time by contract,
  each reading the scene as it is when its turn comes, so 100 picks wait for 100 round trips. three's WebGL
  `readRenderTargetPixels` is a synchronous `readPixels`.
- **Fixed for many points (perf-history entry 60):** `Picking.pickMany` in `@margoengine/selection` answers the same 100
  pixels from one readback: 83 ms, same hits (`p-gpu-pick-batch`, Margo only).
- **Still open:** one `engine.pick` per point keeps its round trip. Starting queued picks early would break its documented
  turn order, so code that picks many points should call `pickMany`.

The entries below are speed-matrix rows diagnosed on 2026-10-27 (item 47 phase 2, round 4; busy machine, RTX A6000,
diagnostic). Their causes and the fixes that landed are in `bench/parity-causes.json` and perf-history entry 36.

### Motion blur needs TAA for velocity

- **What:** `p-motion-blur`: GPU 0.63 ms a frame against three's WebGPU 0.25 in the last ledger run (CPU is faster, 2.3
  against 3.2).
- **Cause (timestamps per pass):** `MotionBlur` reads TAA's velocity, Margo's only motion-vector source, so the frame
  also runs TAA's velocity and resolve passes (about 0.3 ms); the blur itself is about 0.27 ms.
- **Why the two pictures differ (2026-11-06):** the harness drew its still frame at t = 0 straight after the timed loop, so
  Margo blurred by the jump from wherever the loop stopped, in streaks 32 pixels long. The harness now steps one frame
  into the still frame, and Margo's picture is what a 1/60 s step gives: sharp boxes, under a pixel of motion on most of
  them. three's picture did not change with that step and stays a heavy smear, so its blur does not come from the last
  two frames' motion alone. The SSIM of this row compares a true one-frame blur with that smear, so it says nothing
  about either engine's quality. Timings are unaffected. three's velocity scale in the adapter is not yet explained.
- **Fixed for effects that need no anti-aliasing:** `TAA`'s `velocityOnly` option runs the velocity pass with no jitter,
  capture, history or resolve: `p-motion-blur-velocity` 0.48 ms GPU and 1.2 ms CPU, against 0.63 and 2.8 for
  `p-motion-blur` in the same run (busy machine, diagnostic). `p-motion-blur` keeps its full TAA frame.
- **Still open:** three's WebGPU took 0.66 ms in that busy run against 0.25 in the ledger, so whether 0.48 still loses needs
  a quiet run. three has no `p-motion-blur-velocity` scene yet, so that row compares with `p-motion-blur`'s three column.
  `p-motion-blur`'s image has not matched three's since its first run (SSIM 0.656, delta E 13.2); the cause is not known.

### Build plus first frame of 100 morphed copies is still slower than three's WebGL backend

- **What:** with `PBRModel.compile()` (`p-morph-compiled`) the first frame is 17 ms, ahead of three's WebGL 30 and WebGPU
  194, but only because the compile moved into the build. Build plus first frame is 125 to 143 ms, against 154 for
  `p-morph` without it, three's WebGL 54 and WebGPU 217. Busy-machine diagnostic runs, RTX A6000, not gated: entry 56 of
  perf-history.md.
- **Cause:** one-off WebGPU work that does not grow with the copies: 58 ms for the first load (mip pipelines and the
  1024 x 1024 mip chain), 31 ms for the deformation buffers (25 MB written, the bind-pose vertices once per copy, and the
  compute pipeline), and the render pipeline's compile, which overlaps the build by only 11 to 29 ms.
- **Plan:** `1342d03dc` now shares the bind-pose block between copies in `DeformArena`, as the morph deltas are; its effect
  on these numbers is not remeasured yet. If a quiet rerun does not close the gap, record what is left as an accepted
  difference.

## Fixed 2026-11-09

| Bug | Cause | Fix | Regression test |
| --- | --- | --- | --- |
| `scatter` `test:browser:interact` failed every run on an Apple M6 since it was added (67b6324ea): `an empty field draws as plain grass`, about 300 bytes differing, all off by 1 to 3 levels in the far grass | Not trampling. The plain frame is drawn on the page's first heavy frames and the trampled one later. On those first frames an Apple GPU's hidden surface removal treats the 40,000 blades differently: blades read their varyings at the centroid, which follows it (the limit in [limits.md](limits.md), "Apple GPUs: centroid varyings"). Inputs (rings, draw counts, frame uniform) and the depth samples were bit-identical; only colour samples moved. A never-taken `discard` in the blade shader (hidden surface removal off) gave 0 bytes differing, as did one sample a pixel, and drawing 200,000 blades for 3 frames first; 2,000 blades first did not. Stripping `centroid` left 1 byte | The check runs at one sample a pixel (`exactSize`), as the limit prescribes; it still compares the frames bit for bit | `packages/scatter/test/interact.browser.mjs` (5 of 5 on the M6; 0 of 3 before) |

## Fixed 2026-11-08

| Bug | Cause | Fix | Regression test |
| --- | --- | --- | --- |
| Owned 2D 1:1000 contact stack sags 1.186208 m instead of 0.518551 m, with 92.105 mm creep | Capping penetration bias alone imposes C*lambda <= P, about 994.74 kg at the defaults; local split iterations also retain a slow mass-ratio equilibrium mode, while relaxed velocity can hide pose movement from sleep | Cap the elastic residual, retain the original spring root, and apply a certified physical-mass equilibrium correction on supported paths; observe actual substep motion for sleep. No cap, stiffness, iteration or physical tolerance increase | `packages/physics2d/kernel/tests/world.rs::a_heavy_box_on_light_ones_holds_at_one_to_a_thousand` fails unchanged on verified `47f81f909`; all 29 physical bars and input/domain regressions pass. Directed math, SIMD shadow and disconnected-joint regressions cover the new formulation |
| Huge finite angular velocity can silently publish a zero rotation; tiny nonzero rotation pairs can become identity, and nonfinite integration arithmetic can also become identity | Direct f32 squared-length normalization overflows/underflows; the fallback treats NaN length like zero. A finite-only final-state check accepts zero rotation | Preserve the normal-range normalization path, scale exceptional finite pairs, propagate nonfinite arithmetic, and refuse directly mutated zero body rotations | `packages/physics2d/kernel/tests/rotation_input.rs`: four strengthened assertions fail on the retained pre-edge input implementation; the single-substep case catches zero/identity alternation hidden by four substeps |
| Individually finite inverse masses can form an infinite contact metric and the step returns success without collision response | Adding two inverse masses near `2.5e38` overflows; reciprocal Inf becomes zero effective mass and can silently disable a row | Check derived normal/tangent metrics and required reciprocals before solving; propagate a coded arithmetic error | `packages/physics2d/kernel/tests/contact_metric_input.rs`, density `4e-39` fixed-rotation boxes in scalar/SIMD modes; fails on the retained pre-edge input implementation |
| A huge spinning circle returns a successful step with zero contact response despite an unrepresentable contact-point velocity | Finite mass and body speed do not ensure finite `v + w cross r`; normal dot can become NaN through `0*Inf`, and a comparison can select zero without leaving nonfinite final state | Validate computed point-relative velocity, normal approach and anchor base before publishing a solver row | `packages/physics2d/kernel/tests/point_velocity_input.rs`, checked radius `1e9`/`1e10`, density `1e-40`, spin `1e30`, scalar/SIMD; all four cases returned success in the pre-guard diagnostic |
| Finite owned-2D input can panic in scalar friction: MAX-density fixed-rotation effective mass, or two friction values of `1e20`; a negative used cached normal impulse also gives invalid clamp bounds | An inverse mass can round to a finite number whose reciprocal overflows; friction mixing overflows before sqrt; unchecked cached impulses violate unilateral signs. Rust clamp asserts on NaN/reversed bounds before the step's arithmetic-error check | Validate reciprocal metrics and cached normal signs, preserve the ordinary friction-product path but use a scale-safe mean on overflow, and propagate invalid derived clamp bounds as NaN to the checked arithmetic-error boundary. Stage/check both rounded centre and origin before publishing mass updates | `packages/physics2d/kernel/tests/input.rs` directed overflow/cache/origin tests and `math::clamp_tests`; the two derived-coefficient panic cases were reproduced before these fixes (`.lane/p/input-derived-repro.log`) |
| Owned 2D raw collision panics for a NaN pose plus NaN speculative cutoff; the review's NaN pose with a finite cutoff returns an empty manifold on `47f81f909` | No current-input validation; a zero candidate mask becomes index 32, then row 8/vertex 4. Publicly mutable cores also invalidate constructor-only assumptions | Collision entry points return coded `PhysicsError` results; current finite/count checks precede work, and internal absent-face/candidate/incident indices are checked before access. Unrepresentable finite arithmetic returns an error | `kernel/tests/manifold_exact.rs` nonfinite/overflow/sub-slop/huge-extents cases; `manifold::invalid_input_tests`; the original panic reproduced on `47f81f909` before the fix. Existing Node/browser `wasm-check::check` now also checks invalid inputs |
| Owned 2D body/shape creation publishes invalid state: NaN body position, infinite density, or positive density with unrepresentable mass properties; a late chain failure can leave earlier segments published | World entry points accept unchecked inputs and derived mass/reciprocal results; positive mass or inertia rounding to zero takes the deliberate zero-area fallback; chain creation commits segment by segment | Checked world results reject nonfinite input and unrepresentable derived state, preserve legitimate zero-area/density behavior, validate current handles/counts before indexing, and publish body/shape/chain creation atomically | `packages/physics2d/kernel/tests/input.rs`, including two behavioral tests confirmed failing on `47f81f909`; smooth ghost arithmetic and mutable-state cases cover the same unchecked-input class |
| `dof` on the WebGL2 layer: a faint ring as wide as `maxRadius` around every bright object (two boxes at distance 10: 72 px wide on the layer, 31 and 21 px natively at focus 11.53 and 10.5) | The layer reads a multisampled depth texture as one sample, where DOF's resolve keeps the nearest of four, so silhouette pixels held the background's depth with the object's colour blended in and every far gather around them took that colour | DOF's WebGL2 CoC takes the nearest depth of each pixel and its four neighbours when the capture is multisampled (`src/compat.ts`; the closest of the 3x3, plus and one-sided neighbourhoods tried on the M6) | `packages/dof/tests/gpu/compat-check.mjs` (`focus`, `focus 1x`) on the M6 |
| `physics/next` kernel at 4 substeps of one pass (the harness's equal cost): the 20-row pyramid of 210 touching metre cubes never slept; with sleeping off its fastest box still ran 0.278 m/s at 30 s and its top had walked 0.270 m (30 rows: 0.60 m/s and 0.18 m) | One Gauss-Seidel pass a substep does not settle a pile whose contacts all sit at a quarter of the substep rate (60 Hz): what the soft pass pushes into the rocking comes back as speed (on the limit cycle gravity gave 42 J/s, the warm start took 39, the biased pass 1.8 and the relaxing pass 1.3). Damping ratios 1 to 40, pair orders, 400 sweeps, split impulses, a position row, a softer friction anchor, the references' 5 mm slop and over-relaxation each left it rocking | At one pass a substep a contact between two dynamic bodies that neither dominates takes the soft constraint at an eighth of the substep rate (30 Hz at 4 substeps) while it carries under 50 times the lighter body's weight (`CHAIN_LOAD`, `solve_contacts` in `kernel/src/solver.rs`); the ground, kinematic and dominant bodies and heavier loads keep the quarter, and at two passes or more nothing changes. The pile sleeps at 2.28 s and rests at 9.9e-5 m/s with sleeping off, its top moved 32.3 mm; 30 rows sleep at 2.03 s, rest at 5.9e-4 m/s, top 69 mm; the 1:100 and 1:1000 stacks still sag 14.39 and 137.43 mm | `kernel/tests/solver.rs` `a_pyramid_settles_at_one_pass_a_substep` and `a_pyramid_of_thirty_rows_settles_at_one_pass_a_substep` (both fail before the fix) |
| `physics/next` kernel: on a path between two kinematic bodies with more lock rows than freedoms (seed 1 of the joint web of `tests/stability.rs`: a slider from a kinematic body to body 11, a spherical joint 43 m long to body 30, a slider to a second kinematic body, 13 rows on 12 freedoms) the exact speed solve kept the row that depends on the others: 14,424 m/s at step 335, 4,782,492 rad/s at step 336 and a joint 232 m open; seed 35 (15 rows on 12 freedoms) spun a body at 370,728 rad/s at step 577 | Not the f32 rows: J M^-1 J^T built from them in rationals is exactly singular there (pivot 0). The doubles lost it: `refresh_joints` eliminated J M^-1 J^T joint by joint in path order, so each Schur complement carried W^T E W with W = K11^-1 K12 (Higham 1990, Lemma 2.1), and the 43 m arm made W large: the spherical joint's rows lost 1e5 of their size to the slider before them, and the last pivot read 4e-7 of its row's size, over the f32 epsilon stop, so the solve answered that rounding | K is never formed: the factor of each path is Householder QR with column pivoting of A = F^T J^T, F F^T = M^-1 per body, front by front along the path (at most 12 rows a joint), whose R is K's Cholesky factor with complete pivoting (Higham 1990, section 5.2); the solve is R^T y = b, R x = y on the same path sweep. The dependent row now reads 1e-32 of its size and is dropped. The stop is Higham's (4.3) at his suggested n u, n the rows of the path, u f32's epsilon | `kernel/tests/stability.rs` `a_path_with_more_locks_than_freedoms_drops_the_row_that_depends` (seed 1 to step 400: 4,782,492 rad/s and 232.3 m before, 956 rad/s and 38.0 m after; seed 35 to step 600: 370,728 rad/s before, 1,354 rad/s and 40.9 m after) |
| `webgl2-compat` `interpret.test.js` failed on every run (main 0f4f13f95 on, reported by lane P): the splat lighting kernel the commit added to the corpus (8f2fbeee11e8c664) left word 64 of its output as 0x7fc00000 compiled and 0xffc00000 on the interpreter. Both are NaN: the splat's zero-length view vector normalizes to NaN | Not a wrong value but a NaN's bits. JavaScript lets an engine write any NaN encoding to a typed array or DataView (ECMA-262 25.1.3.17), and V8 wrote a different sign for the same arithmetic depending on how the value was held, so the CPU tier's buffer stores, `bitcast`, f16 packing and storage-texture stores copied whatever bits the value had. The corpus had no kernel that stored a NaN before | The CPU tier writes one NaN everywhere a NaN reaches memory or bits: the quiet NaN 0x7fc00000 (f16 0x7e00), in the `stf` store helper, `bfu`, `bfi`, `halfBits` and `ts` (`packages/webgl2-compat/src/compute/cpu.ts`, `js.ts`). WGSL lets a runtime NaN be any value of its type (15.7.2), so this is a valid result on both paths and every engine | `packages/webgl2-compat/test/nan-encoding.test.js` (all four tests fail without the fix; the compiled and interpreted runs gave different words); `interpret.test.js` passes again |
| The root test run (`node --test --test-concurrency=8 ... tests/*.test.js`) never ended: `tests/browser-teardown.test.js` sat over 11 minutes with no output (lane I, 2026-11-08), though its tests have 5 minute limits; alone it passed 12/12 in 31 s. Reproduced with 6 to 8 copies side by side: 2 or 3 of them never exited | Under load Edge lists only its browser process right after the launch, so "a real browser: close ends its main process" failed `assert.ok(pids.length > 1)` within a second, before its `browser.close()`. The browser it left running held the file's process open after its last test. Node's runner ends a test at its limit but never ends a file whose process stays alive, so the run waited on it with no limit. `withBoundedClose` (scripts/lib/browser.mjs) had the same gap: an `endChromium` that threw skipped the ordinary close and left the browser running | The test reads the process list with a page open (a renderer then always runs; it asserts a browser and a renderer) and closes the browser on every path (`processTree`, through `runSuite`). `withBoundedClose` closes the ordinary way when the end of the processes fails, then throws that error | `tests/browser-teardown.test.js`, "a failed check on a real browser still closes it, so the file can exit" and "a Chromium browser whose processes cannot be ended still closes the ordinary way, then the close fails" |
| `tests/parallel-check.test.js` "runLimited keeps a suite log, and a timed-out job has its tree killed" failed under load with `EPERM` removing its temp folder (root tests, lane C, 2026-11-07); the folder could be removed a moment later | `endTree` (scripts/support/shutdown.mjs) took a killed process as gone once `kill(pid, 0)` said so, and on Windows libuv answers that from the exit code, which is set before the process has closed its handles: the hung node still held the folder it ran in and the log it wrote to. `runLimited` and every bounded browser close resolve through `endTree` | On Windows `endTree` then waits for each killed process to finish exiting (its process object signalled, after its handles close) with `waitSignaled`, one PowerShell `Process.WaitForExit` for all the pids, within the same budget; a pid a newer process took is not waited for | `tests/gpu-test-limit.test.js`, "endTree resolves only once the killed processes have closed their handles" and "waitSignaled waits for a running process to finish" |
| `physics/next` kernel: in the joint web of `tests/stability.rs`, seed 45, step 1986, one pass gave a body 457,390 rad/s, contacts passed it to its neighbour (469,700 rad/s), and that body landed 1,100 m from the fixed body it is joined to: top spin 162,278 rad/s and top speed 22,213 m/s against the 18,400 rad/s and 2,300 m/s the scene's kinematic turns carry. The body had not drifted first: it stood 11.8 m from its fixed partner, as the unsatisfiable web holds it, and went 1,100 m within that one step | The pushing pass solved a path's speeds and its position bias as one, and `push_share` cut that one solve. A hinge's limit, solved just before in the same pass, stops a turn about an anchor 24 m off, which only the locks can carry, so it gives its body 7,500 rad/s along them for the path to take back, and the next hinge's limit, reading that turn, gives the body beyond it 457,390 rad/s. The share came out 0 and cut the taking back too. The lock cap that grows with a body's spin was not the cause: the body's spin was 0 when it was read | The pushing pass solves the speeds along the locks whole first, then the position bias on the same factors, cut by `push_share` and capped from the speeds the first solve leaves (`solve_path` in `kernel/src/joints.rs`) | `kernel/tests/stability.rs` `a_cut_push_still_takes_back_the_speed_along_the_locks` (162,278 rad/s before, 2,559 after) |
| `physics` replay proof: `a world that moved one bit gives a different hash` read the hash 50 steps after the move, and once the push fix above changed the run it failed though the hash was right: body 0 drifts alone under damping and the bit it was moved by rounds away by step 80, leaving both worlds bit-equal | The test asked the dynamics to keep a one-bit difference, which a damped body need not do; what the proof needs is that the hash sees any difference | The test compares the whole state every step from the move to step 200 and asks the hash to differ exactly when the state does | `packages/physics/tests/replay.test.js` `a world that moved one bit gives a different hash: the proof can fail` |

## Fixed 2026-11-07

| Bug | Cause | Fix | Regression test |
| --- | --- | --- | --- |
| The gallery's model cabinet (`examples/gallery/khronos.html`) loaded 126,206 B gzip of JavaScript before its first frame, over its 120,000 B budget (`scripts/test-gallery-browser.mjs`) | The page lights from pixels (`Environment.attach` with an image it makes), yet `EnvironmentLighting` imported the EXR, Radiance HDR and UltraHDR decoders and EXR's inflate (about 9.3 KB gzip) statically for `EnvironmentLighting.load(url)`. The growth past the budget since 2026-10-31 was gltf-pro features (+6,582 B); the decoders were the part the page never runs. A plain `import()` was not enough: a bundler keeps a dynamically imported module in the static chunk when a module that holds code also imports it statically, and the root's `index.js` both held the code and re-exported the decoders | `@margoengine/environment` publishes `index.js` as re-exports only, of `main.js` (everything else) and `loaders.js` (the decoders, `src/loaders.ts`); `EnvironmentLighting.load` imports `loaders.js` on its first URL. Same exports and the same code; the page loads 116,849 B | `packages/environment/tests/lazy-loaders.test.js` (an app of `Environment` and `EnvironmentLighting` bundles no decoder; fails without the split); `npm run test:gallery:browser` |
| `stats`: GPU profiling on the M6 Mac mini (Chrome, Metal) threw `Invalid GPU timestamps (end before start or time went backwards)` on every sample, so `Stats` with `profiling: true` logged it each time and `npm run test:gallery:browser` failed on console errors | `GPUProfiler` required each pass to start after the previous pass ended. A tile-based GPU overlaps passes, running the next pass's vertex work under the last one's fragment work: the second pass started 1,416 to 26,500 ns before the first ended (read back from the gallery's model cabinet); each pass's own start and end were in order | A pass is rejected only when it starts before the previous pass's start, or ends before its own start; the elapsed time runs from the first start to the latest end (`packages/stats/src/profiler.ts`) | `packages/stats/test/stats.test.js`, "a pass that starts before the previous one ends is timed" (the M6's own timestamps; fails without the fix) |
| `stats`: on the M6 Mac mini (Chrome, Metal) a later pass started about 9.5 us before the pass recorded ahead of it, so `GPUProfiler` still threw `Invalid GPU timestamps` and `npm run test:gallery:browser` failed on console errors | Not a Margo bug (query indices, resolve range, 16-byte stride, word order, nanosecond units and the 64-bit borrow were checked; all passes come from one encoder in encoding order). WebGPU section 20.4 makes timestamp values implementation-defined, and Metal on Apple silicon samples at stage boundaries without waiting for earlier commands (citations in docs/clean-room.md). Scott's ruling, 2026-11-08: reject only a genuine bug | A pass is discarded only when it ends before its own start or ends before the previous pass starts (a counter reset); overlapping passes in any start order are timed, the elapsed time from the earliest start to the latest end (`packages/stats/src/profiler.ts`) | `packages/stats/test/stats.test.js`, "a pass that starts before the previous one ends is timed" (the M6's starts; fails without the fix) |
| `animation`: zero extra skin influences (JOINTS_1 and WEIGHTS_1 all zero) moved one skinned position by 1 ulp on the M6 Mac mini (Metal), so `scripts/animation-influences-browser-tests.js` failed its bit-for-bit check | WGSL lets a compiler reassociate and fuse floating-point operations (15.7.5): the eight-influence blend adds four zero-weighted bone terms, and Metal folds `skin*vec4f(p,1)` into it, so the position differs by 1 ulp; the skin matrix itself is the same (normals and tangents bit for bit) | Both eight-influence shaders (`deformationShader8` and the batched `linearBlend(true)` in `packages/animation/src/shader.ts`) run the four-influence blend text verbatim where a vertex's extra weights are all zero, and the eight-term blend otherwise; the four-influence shaders are unchanged | `packages/animation/tests/influences.test.js`, "eight influences run the four-influence blend verbatim" (fails without the fix); `scripts/animation-influences-browser-tests.js` passes on Metal |
| `bvh` `test:browser` on an Apple M6 (Chrome, Metal): 142 of 123,200 rays from inside a closed mesh leaked through it | WGSL lets a compile fuse and reassociate (15.7.5), and Metal fuses the edge function `p.x * q.y - p.y * q.x` into one fma, which is not antisymmetric: two triangles on a shared edge no longer got exactly opposite values, and a ray through the edge could miss both (Woop, Benthin and Wald 2013 need them opposite) | Each edge is evaluated with its two ends in one fixed order and negated for the other side (`bvhEdge` in `packages/bvh/src/gpu.ts`) | `packages/bvh/tests/gpu-browser.js` watertight check (142 leaks on the M6 without the fix, 0 with it) |
| `oit` `ExactOIT` at 4x MSAA on an Apple M6 (Chrome, Metal): each layer counted up to four times, so `exact-check.mjs` failed at 4x | A fragment shader that is not sample-frequency may still run more than once per pixel (WebGPU 23.2.10); Apple GPUs run the list shader up to once per sample, at the pixel centre with a whole or partial coverage mask, so one layer entered the list several times | A multisampled sort merges nodes equal in depth, colour and alpha into one whose coverage is the union (`packages/oit/src/exact.ts`); the test page draws at 4x until the list has grown, as Apple fills the starting pool on the first frames | `packages/oit/test/gpu/exact-check.mjs` 4x cases (fail on the M6 without the merge) |
| `oit` `MomentOIT`: two splats added in either order differed by 1 of 255 on an Apple M6 (Chrome), so `vfx-check.mjs` failed "the order of the data changes nothing" (hidden until now behind `moments-check.mjs`) | The M6 adds a fragment's float output to the stored half and rounds once, so round(round(a) + b) and round(round(b) + a) differ by a step. Rounding the outputs with `quantizeToF16` or a `pack2x16float` round trip changed nothing under Chrome on Metal: the stored sums were bit for bit the same | Both passes round every output to a half float on its bits, to nearest even (`margoHalf` in `packages/oit/src/moments.ts`); two halves then sum the same in either order | `packages/oit/test/gpu/vfx-check.mjs`, splat order (fails on the M6 without the rounding, and with `quantizeToF16` in its place) |
| `oit` `MomentOIT`: where a pixel had two or three layers, the order models were added in moved it by 4 of 255 on an Apple M6 (`moments-check.mjs`, bound 3) | Precision, not Metal: four power moments of two layers make a singular Hankel matrix, and the half-float sums sat one rounding step either side of it (`d33` -6e-4 before the bias), so one step moved a layer's transmittance from 0.51 to 0.93. The RTX A6000's rounding happened to stay on the valid side | Three trigonometric moments (Muenstermann et al. 2018, Section 5 and Algorithm 2) in three `rgba16float` targets, wrapping zone pi/10, bias 3e-3 for half floats; no device feature. One step now moves a transmittance by under 0.001, and the check's four layers land at 2.34 of 255 where power moments gave 6.24 on the RTX A6000 | `packages/oit/test/gpu/moments-check.mjs`, "one half-float step" (runs the pass's own WGSL on sums moved by one step in every channel; fails with power moments on any GPU: 0.42 for two layers) |
| A failed `rebootDevice` on a healthy device left the canvas on a destroyed device: the next frame failed WebGPU's validation (`[Invalid TextureView] is associated with [Device], and cannot be used with [Device]`) | `GPURenderer`'s constructor configured the canvas, the one step of a restore with no way back, before the batches were rebuilt; when one could not be, the new device was destroyed and the old renderer kept drawing into a canvas that named it | `GPURenderer.configure` is its own step, and a restore takes it after every rebuild | `tests/deep-core-allocation-failure.test.js`, the scenario "a restore that fails on a healthy device" in `scripts/lifecycle-browser-tests.mjs` |
| A restore that ended after `engine.dispose()` unconfigured the canvas, which a new engine could hold by then | The new renderer configured the canvas and its disposal unconfigured it | It has not touched the canvas at that point, and leaves it alone | `tests/deep-core-allocation-failure.test.js` |
| A failed `addViewer` left the camera on near, far, target and position set for a model that was gone, and ended any fit still animating | The camera was framed before the steps that can fail, and the undo list cannot cover it: a fit in flight is private to `Camera`, and `dispose` must leave the camera to the visitor | Framing is the last step, and a failure inside it restores those four fields; every import runs alongside the load, so nothing after the load waits | `packages/stage/tests/viewer.test.js`, `packages/stage/tests/viewer-missing-package.test.js`, `scripts/stage-viewer-gpu-check.js` |
| A part that threw while `addViewer` cleaned up replaced the real error, and in `viewer.dispose()` too it left every part after it | The undo loop was plain, and it ran inside the catch | Every step runs. The failure reaches the caller and a cleanup error goes to `engine.onError`; `viewer.dispose()` throws the first and reports the rest | `packages/stage/tests/viewer.test.js` |
| `addViewer` rejected a long lens with `Bounds exceed far: raise camera.far`, a value it had just set and the caller cannot change | Far was 50 model sizes whatever the lens, and the fit stands back further than that below about a 1.3 degree `fov` | Far covers the distance the lens needs, and stays 50 model sizes for every other lens | `packages/stage/tests/viewer.test.js` |
| A failed `setGeometry` broke later frames: the retry returned with no GPU buffers and the next frame threw `TypeError`, and a failed growth destroyed the buffers of meshes already drawing | `Engine.retain` counted the reference, swapped the instance array and removed the old buffers before the allocation that can throw | Allocation first; `Renderer.add` replaces a held geometry new first, in core and `@margoengine/webgl2-compat/preview` | `tests/deep-core-allocation-failure.test.js`, `packages/webgl2-compat/test/preview-webgl.test.js` |
| `engine.retain` growing a drawn batch blanked its instances until something else forced a collection | The new array is empty, and only `setGeometry` asked for a collection | Growth asks for one itself | `tests/deep-core-allocation-failure.test.js` |
| Geometry set inside `onDeviceRestored` got no buffers, or too small an instance buffer, and the next frame failed | `retain` skipped the renderer while `recovery` was set, and that stays set through the hooks, after the restore has copied the batches | `retain` always allocates on the renderer in use, which also covers a restore that fails | `tests/deep-core-allocation-failure.test.js`, lifecycle scenario "geometry set during a restore" |
| One `onDeviceRestored` that threw left every later plugin on the lost device | The hooks ran in a plain loop | Every hook runs, then the first error is thrown | `tests/deep-core-allocation-failure.test.js` |
| A plugin that threw in `dispose` stopped `scene.dispose()` after the scene had left the engine, so the other plugins were never disposed | The scene was removed first and the loop was plain | Every step runs, then the first error is thrown | `tests/deep-core-allocation-failure.test.js` |
| An invalid material threw once, then the next frame drew part of the batch with no error, and the later meshes stayed missing once it was fixed | A full collection emptied `materials`, the only thing that had noticed the change, before the step that throws | A full collection clears `collected` first | `tests/deep-core-allocation-failure.test.js` |
| After a failed store growth a frame could read zeroed slots and throw on a geometry-less mesh | `createMesh` swapped `seen` and `slots` before `store.grow` | Swapped in after it | `tests/deep-core-allocation-failure.test.js` |
| `LodInstances` and `DynamicInstances` released geometry they had not retained when `setup` failed | `engine` was set before `retain`, and `dispose` releases by it | Retain first; `LodInstances` takes all levels or none | `packages/culling/test/lod.test.js`, `packages/culling/test/dynamic.test.js` |
| A motor could not hold a limb whose mass lies past its bone: with motors alone Knight's head fell 0.83 rad to its cone limit in a second, Barbarian's 0.53, Ranger's 0.78, Rogue's 0.81, Mage's 0.19, and balance had to replace those motors with its own | `powered.ts` reckoned each limb as a rod per body along its bone: Knight's neck read 0.0028 kg m² against 0.96, so a cap of 1.1 N m met up to 12 N m of weight | Gains and caps come from each body's real centre of mass and inertia, by the parallel axis theorem; balance drops its own motors for those joints. What steadies the solver stays on rods, and a foot on the floor keeps the rods' gains, since the floor holds it and it hangs from nothing: heads now read 0.000 to 0.005 rad | `packages/ragdoll/tests/balance.test.js`, "motors hold up its head with no balance to help", five figures; "RiggedFigure stands quiet at 20 solver passes" for the steadying; "settles on its own legs" fails on four figures with the limb's gains on a standing foot |
| A balancing figure slid along the floor. Worst of 24 roundings over five seconds at 8 passes: RiggedFigure 0.0385 m, up from 0.0207 m before the torques became forces, Seed-san 0.0077 m, Mage 0.0072 m, with feet going at the same speed and friction nowhere near its limit | Two controllers on one knee: the balance gave it its torque and the rod motor, a solver spring and damper, sat beside it. Stopping the controller left the slide at the same speed; taking the knee motor off stopped it at once (9 mm/s to 0.16); it fell with the motor's damping. What a motor does to a contact inside Rapier is listed under Open defects. The 0.0207 m was the same slide at 0.004 m/s where forces read 0.0076, on a curve that rose with passes to 0.18 m at 16, so it was no better | A stance knee has its torque and a spring with no damper that grows with how far the knee is off its bend, full at 0.15 rad. The balance's own knee torque is capped by the body's weight, not the limb's inertia, as it now stands alone. Worst of the seven: 0.0020 m, Seed-san; RiggedFigure 0.0005 m, Mage 0.0005 m, no foot over 0.0009 m | `packages/ragdoll/tests/balance.test.js` (`settles on its own legs` for six figures: a foot under 0.002 m) |
| Seed-san's hips could ring at half the frame rate, 0.026 m/s at 10 passes, for as long as it stood | The height's spring and the hips' turn read velocities a body reports at the end of a step, which hold what the solver's last pass left: 0.02 m/s one way while the hips moved 0.008 m/s the other | The controller reads how the hips moved from where they went. Worst 0.0001 m/s at 10 passes | `packages/ragdoll/tests/balance.test.js` (`Seed-san stands quiet at 10 solver passes`) |
| Balance read worse with more solver passes: at 16 every figure crept about 0.034 m/s where 10 read 0.006 to 0.017, and RiggedFigure and Seed-san fell or drifted 0.09 to 0.15 m | The torques were impulses before the first pass, so one pass's share of friction and of the sole's weight had to take a whole step's kick: the more passes, the less each held, and the feet slid at the same speed on every figure | The torques are forces through every pass, changed only by what differs from the last step | `packages/ragdoll/tests/balance.test.js` (`at 16 solver passes reads no worse than at 10`, `it holds its torques as forces`) |
| Mage shook about half a millimetre, 5 of 24 roundings reading over 0.02 m/s on one frame, and other fitted boots chattered | A contact keeps four points for the solver and a fitted sole has many, a few millimetres apart in height, so which four changed with the slightest turn: Mage's right foot dropped 1.8 mm onto a point left out | A hull foot stands on a flat sole of four corners while it balances; `dispose` puts the hull back. Worst read 0.0044 m/s | `packages/ragdoll/tests/balance.test.js` (`a foot stands on a flat sole of four corners`) |
| Seed-san crept 0.018 m/s, 0.095 m in five seconds | Its foot stood tipped 0.40 rad on the heel, past the ankle's 0.6 rad cone with the bend it held, so the limit pass turned it 0.0016 rad each step and contact flattened it back: a ratchet, read as a steady spin of 0.1 to 0.16 rad/s | With real forces the foot stays flat and no limit turns. 0.0031 m/s at worst; what is left is listed under Open defects | `packages/ragdoll/tests/balance.test.js` (`Seed-san at 16 solver passes reads no worse than at 10`) |
| A push of 1.5 m/s threw Knight in 3 of 128 | The sole limit gave way through a step, when the one stance foot needs the whole torque to stop the body, so the ankle let go | The limit holds only with two feet down: on one foot the ground answers what it can and the foot may roll on its edge. 0 of 128 fall | `packages/ragdoll/tests/balance.test.js` (the existing push tests) |
| `VoxelNetClient` let an error putting a decoded chunk into the world escape as an unhandled rejection, which ends a Node process (a bot, a test), instead of reaching `onError` as `receive` promises | The rejection handler sat beside the fulfilment handler in one `then`, so it caught decode failures only; `addChunk` throwing on a chunk the app had already made at that key was nobody's | `.catch(onError)` after the `then`; the README's `client.onError` row says which errors come there | `packages/voxel-net/tests/chunk-apply.test.js` |
| `examples/voxel-sandbox` "same address, same counts, on every tab" failed under load with `Chunk -1,0,0 is already loaded` (10 of 80 runs beside 10 busy processes) | The test's `stamp` wrote the ore into every client's world while the third client was still loading that chunk; `setBlock` adds a missing chunk, so the server's copy arrived to a chunk already there. All 6 failures of an instrumented run had that client without the chunk, none of 58 passes did | `stamp` waits until every client holds the cell's chunk before it writes (0 of 80 under the same load) | `examples/voxel-sandbox/test/plaza-counts.test.js`, "stamp waits for a client still loading" |
| `examples/voxel-sandbox` "snapshot then rollback" failed under load with `EPERM` renaming `state.json.<pid>.tmp` over `state.json`, and a live shard would stop the same way | Windows refuses a rename over a file any handle has open (MS-FSCC 2.4.42: `STATUS_ACCESS_DENIED` when the target is open and `ReplaceIfExists` is set), and Defender's on-access scan opens a file just written. No handle of the shard's own was open: a stand-in scanner holding `state.json` open made it fail 16 of 16 runs. Two writes of one path at once in one process also shared one temporary file | `writeWhole` moves the file in place aside to `.old` (allowed while every handle shares delete), renames the new one in, deletes the old; `readWhole`, `readWholeSync` and `hasWhole` read a file a crash left aside, `removeWhole` removes both, and writes of one path run in call order. 0 of 16 under the same scanner | `examples/voxel-sandbox/test/snapshots.test.js`; `examples/voxel-sandbox/test/plaza-shard.test.js`, "a shard saves while another process holds its state.json open" |
| A result store eviction could end `npm run verify` the way a prune did | Stored outputs were deleted under their own name, so a lane opening one mid delete could get `EPERM` on Windows, and a blocked delete threw; `restoreOutput` asked whether a file existed and then opened it, so one evicted in between threw `ENOENT` | Stored outputs now leave their name before they are deleted, through the same helper as entries, and a blocked file stays until the next eviction; a file gone at opening counts as not stored | `tests/result-cache.test.js`, "an output another run evicts between asking and opening counts as not stored" and "an eviction another run blocks leaves the output for the next one; other errors still throw" |
| "the probes leave out a window in which V8 collected garbage" failed once with about -118 B per call | `heapWindows` took the cost of reading the heap size from a single read, and takes that figure off every window. One run's read caught about 210 KB of something else, so all five windows fell by the same 210 B per call: -118 against the 92 B of 9,600 other runs, the same steps apart. A shift that way can also let a frame that allocates pass. What the read caught is not known, and the failure did not come back in 9,600 runs under load | The cost is the median of five reads, so one read that catches something else counts for nothing | `tests/frame-alloc.test.js`, "one heap read that catches something else does not shift every window" |

## Fixed 2026-11-06

| Bug | Cause | Fix | Regression test |
| --- | --- | --- | --- |
| A balancing ragdoll's settling turned on rounding: over 24 hull roundings (1, 4 and 16 rounding steps, 8 seeds) all 24 stepped after the first second, drifted 0.087 to 0.711 m, held their hips at 0.312 to 0.370 m of 0.398 asked and ended at 0.032 to 0.474 m/s, with 0.543 of the weight carried from outside | The legs were an angle servo with the weight carried from outside, so a slide of the whole body was invisible to them. Under that: the knee's rest bend of 0.213 rad was read as hinge angle, the source of the 5 cm sag; the ankle's cap came from the limb's inertia at 0.31 N m; the capture point used bone origins, not the centre of mass; and torques given before the solver rattled the light feet | Knee and ankle torques from the weight the leg carries, pairs inside the body, the ankle held to what the sole answers, the turn's reaction passed down to the foot, the real centre of mass, inertia on foot and shin, 8 solver passes on the island. The same sweep now: 0 of 24, no step at all, drift 0.004 m at most, hips at 0.396 m, 0.0034 to 0.0072 m/s, nothing carried; 0 of 96 over 32 seeds. Barbarian, Ranger, Rogue and RiggedFigure went from 24 of 24 bad to 0 of 24 | `packages/ragdoll/tests/balance.test.js`: "it settles on its own legs" at 1, 4 and 16 steps, and one per figure |
| Apple's loader read RiggedFigure's USDZ lying on its back and robot-expressive's hands as 6 cm | A glTF skin's vertices were written in mesh space, and that loader sizes a model without its skeleton | Points rest in the world, with the move taken out of `bindTransforms` | `packages/exporters/tests/usdz-size.test.js`, `packages/exporters/tests/usdz-anim.test.js` |
| `new Ragdoll` and `Ragdoll.attach` threw on a world scale such as 0.9995, 1, 0.9986, which real exporters write, and on any uneven scale. Past the check, a kinematic body read its rotation with one scale for all three axes, the root's local position took the parent's axes as square, and `fitRagdollShapes` used one scale for a hull | `worldPose` compared the three scales with a 1e-4 limit, and a test pinned the refusal of `[1, 2, 1]`. Scott's ruling, 2026-11-06: a ragdoll takes any positive bone scale | Only zero and mirrored bones are refused, by the determinant. Each axis keeps its own scale, the root's position goes through the parent's full inverse, and `bind` holds the difference a skew makes between the bodies' turn and the local rotation, measured as a bone goes limp, for the write back and the motors. Children that are not bones are read for position only | `packages/ragdoll/tests/ragdoll.test.js`, from "any positive bone scale is taken" to "Seed-san's skeleton", `powered.test.js` "motors hold a pose skewed", `hulls.test.js` "uneven scale" |
| The result cache shadow report said "same inputs built different bytes" for `build:package:fbx` and `build:package:usdz` after a rebase | The builds are deterministic (two builds of each gave the same hash). The key was short: a worker bundle and any subpath outside the external list take in the dist of another package, which the bundler reads natively, and a package build declared only its own sources and `packages/shared`. A rebase that changed only `gltf-pro` changed `dist/workers/fbx.js` on an equal key. Changing one string in `gltf-pro`'s dist and building the two packages alone moved both hashes, and restoring it moved them back | A package build now keys on the dist of every package the build order puts before it, near and far (`packageClosure`), so a dependency's change is a changed input. Key version 3, so old entries miss | `tests/result-cache.test.js` |
| `PotreeSource` lost about 70% of a real 1.7 folder: `lion_takanawa_normals` read 101,456 of 341,989 points | PotreeConverter writes 0 points in the `.hrc` record of a leaf. The reader took that as an empty node and dropped it; the test writer never wrote such a record, so only a real folder showed it | A listed leaf of 0 points takes its count from its file when `load` reads it | `packages/points/tests/potree-real.test.js`, `packages/points/tests/potree.test.js` ("a leaf whose record says 0 points") |
| `solvePoseIK`, `addIKChain`, `addCCDChain`, `addLookAt`, `addFootIK` and the shared pose tools (foot placement, warping, full-body IK, spline IK) threw on scales such as 0.9995, 1, 0.9986, which real exporters write | Each compared the three scales with a 1e-5 limit, because it read one scale for all axes | Each axis keeps its own scale; only flat and mirrored matrices are refused | The "off uniform" tests in `packages/rigging/tests/ik.test.js`, `packages/rigging/tests/ik-animator.test.js`, `tests/modern-animator-ccd.test.js`, `tests/modern-animator-look-at.test.js`, `tests/modern-animator-depth.test.js` |
| npm run verify hung once in its unit test step until its 1,500 s limit, with no test named, on 2026-11-06 | Likely `packages/voxel-net/tests/server.test.js`: under load a generator thread made the folder removal fail with ENOTEMPTY, a failed hook ends the hooks, the server stayed open and the file never ended (3 of 192 runs). The first run's log was not kept, so the link is inference from its load and symptom | Hooks in the order that closes the server first (`af185850f`, 0 of 256 runs). A leak of this shape now fails as `HUNG TEST:` with the file and test, and `--test-force-exit` stays off because it would hide the leak | `tests/test-watch.test.js`, "a real hang is named" |
| A hung test in the verify unit step named nothing and sat until the step's outer limit | The step prints only when it ends, tests had no time limit, and `--test-timeout` alone cannot reach a blocked event loop or a process that stays alive after its tests | Each test has 300 s (32 s measured for the longest), and a reporter in the runner's process names a file silent for 360 s and ends the run with its children | `tests/test-watch.test.js` |
| The hung run test failed at `rmSync` with EPERM on its temp folder, under load | The reporter ended the run with `taskkill /T` on its own process, so the runner died while taskkill was still running with the run's folder as its working folder, and Windows refuses to remove a process's working folder. 7 of 1,440 parallel runs left the folder busy, 0 of 1,440 with taskkill working from another folder | The runner stops every process below it, waits on each one's handle, prints `HUNG RUN ENDED:` and exits last; the killer works from the Windows folder | `tests/test-watch.test.js`, "a hung run ends last" |
| MeshBridge.sync made a world with nothing moving slower than the setter loop it replaced | One walk of the links for the mesh checks, then one per group whether it moved or not, and a read past the end of the row arrays to end a run | One pass checks the meshes and marks the groups that moved; only those get a second walk. A run ends after the loop | `packages/ecs/test/engine.test.js`, "one pass finds what moved" |
| The light glTF loader called a valid accessor over one million values not valid glTF | The count limit shared one error with the bounds checks | Its own `unsupported` error naming gltf-pro, so `loadAuto` moves on | `packages/gltf/test/auto.test.js` |
| `loadAuto` drew each instanced node once on gltf-pro, or refused the file | It passed gltf-pro no `decoders.instancing`, which gltf-pro does not import itself | `loadAuto` imports the reader when the file uses `EXT_mesh_gpu_instancing` | `packages/gltf/test/auto.test.js` |
| LAZ formats 1 and 3: wrong GPS times on PDAL `autzen_trim.laz` | GPSTIME11 stored the new difference after a multiplier 1 point, and the test encoder made the same mistake, so round trips passed | The previous difference stays, as in point14; the encoder follows the file | `packages/points/tests/laz-encoder.js` round trips |
| LAZ point14: X and Y past the header bounds for points with four or more returns | Rows 4 and up of the return group map were wrong | First return group 3, last 5, those between 4, checked on real files up to six returns | `packages/points/tests/laz-encoder.js` round trips |
| `parse3DM` threw on every file with the real rhino3dm | `File3dmLayerTable.delete(id)` hides the handle's `delete`, and the stand-in had no such table | The free comes from the base that owns `isDeleted` | `packages/loaders/tests/3dm.test.js` |
| `parse3DM` read solid objects as meshes | They have `vertices` and `faces` of their own kind | Only an object with vertex colours is a mesh | `packages/loaders/tests/3dm.test.js` |
| `parseVDB` read only the first grid of a file OpenVDB wrote, then ran off into its bytes | Each grid sits right after its descriptor, and the reader and the test's own writer both put the descriptors together at the head | The reader goes to each descriptor's end offset, and the test writes files as OpenVDB does | `packages/loaders/tests/vdb.test.js`, `vdb-fire` in `packages/loaders/tests/real-files/manifest.json` |
| `parsePLY` refused Blender 2.4x files | A bare `Created by` header line had no keyword | Kept as a comment | `packages/loaders/tests/loaders.test.js` |
| `parseXYZ` refused swisstopo files | An `X Y Z` line before the data read as a bad point | A line with no numbers before the data is skipped | `packages/loaders/tests/loaders.test.js` |
| `parseDXF` read binary files before R13 as silently empty, and never read a binary file's version | Those files have one-byte group codes with 255 as the escape, and `$ACADVER` was searched as text | Both forms are read | `packages/loaders/tests/dxf.test.js` |
| `parseGCode` read 1,941 mm of filament for a 317 mm print | Retractions were not taken off. A test pinned the wrong value 9 | `filament` is the net length pushed; the pinned value is now 6 | `packages/loaders/tests/gcode.test.js` |
| `parseX3D` read CATIA exports as empty | `CADPart`, `CADLayer`, `CADAssembly` and `CADFace` were not walked | Read as a Transform and groups | `packages/loaders/tests/vrml.test.js` |
| `parseUSDA` refused layers from MaterialX's converter | `'''` strings were not tokens | Read and unquoted | `packages/loaders/tests/usdz.test.js` |
| `webgl2-compat` `test:gpu` failed once in WebKit on an Apple M6: `shadows: the route's dispatches never came` | The check raced the route's `import()`. Shadows loads its layer route by `import()` and, as documented, runs the kernel on the CPU tier until it lands; this scene reduces once, so a late import left no second dispatch to see. The result is the same either way. Delaying the chunk by 800 ms fails it every time in Chrome and WebKit | `routes.html` waits for the route before the first frame, so a route that never loads fails the page's `ready` | `packages/webgl2-compat/test/routes-browser.mjs` (the delayed chunk passes in Chrome and WebKit) |
| Chrome tab crash on the WebGL2 layer: `Target crashed` in the `lines` suite with `--compat`, 4 runs in 6 and later 5 in 5 (Chrome 157, Apple M6) | `device.destroy()` lost the WebGL2 context while the page canvas held an ImageBitmap of it that Chrome had not committed yet. Such an image is invalid once its context dies, and `ImageLayerBridge` in the renderer reads its shared image at the next commit without a check (null at +0x70; `Target crashed` is that read, found from the crash dumps). Five lines of WebGL2 and `loseContext()` crash the tab 5 of 5; Edge 156 on Windows does not. The chance came from whether a commit fell between the last frame and the dispose | `destroy()` first gives each canvas showing a frame of the device its own copy, made in a 2D context of the page (`keepFrame` in `packages/webgl2-compat/src/device/canvas.ts`), so the last frame stays on the page as in WebGPU. One copy per destroy, none per frame | `packages/webgl2-compat/test/destroy-frame-browser.mjs` (crashes the tab 3 of 3 without the fix), `packages/webgl2-compat/test/device.test.js` |
| `scatter` `test:browser:shadow-cull` failed 10 of 12 runs in Chrome on an Apple M6: `blades: frame bytes differ`. It was not atomic order, and nothing to do with shadow culling | The cull's rings, its commands and the shadow map hash the same on the frames that differ, and the cull has kept candidate order since 2026-11-05. Blades read their varyings at the centroid, and on an Apple GPU that point follows hidden surface removal: stripping `centroid`, or running at 1 sample, or adding a `discard` that never runs (which turns the GPU's hidden surface removal off for the draw) each gave 0 frames differing, and 20,000 or more blades are needed for it to show. A plain WebGPU page with the same shader and geometry stayed still, so the exact trigger inside the GPU is not known. Early frames are the most affected; WebKit shows the same on its first frame | The check's blades scene runs at one sample a pixel, where the centroid is the pixel centre: shadow maps and frames are still compared bit for bit, and `repeat.browser.mjs` still holds blades at 4x MSAA. The look of a blade is unchanged; the limit is in [limits.md](limits.md) (Rendering, "Apple GPUs: centroid varyings") | `packages/scatter/test/shadow-cull.browser.mjs` (12 of 12 in Chrome and in WebKit on the M6) |
| `check-wall-budgets` and `check-fixed-waits` in `verify` failed on a helper's scratch build, for any lane | Both walked the disk from the repository root, so they read git-ignored folders such as `.lane/` and `.mutation/`, which can never reach `main` | `checkFiles()` lists files with `git ls-files`: tracked files only, under the same path rules. On the tree at the fix, the list lost only the 21 ignored `.lane` files and no tracked file | The ignored-file tests in `tests/check-wall-budgets.test.js` and `tests/check-fixed-waits.test.js` |
| LAZ formats 7 to 10: files where the scanner channel switches failed with `layer reads past its end` or wrong colours | The context given to the items after POINT14 was the record's channel. It is the new channel only on a record where the channel changed and 0 on every other record, and a record reads the values of the record before with the models of its own context; the LAZ specification does not spell this out, and the test encoder made the same mistake | Follows what LASzip does, found by comparing with it as a black box | `packages/points/tests/laz-real.test.js`, the `laszip-channels-format7` to `format10` files |
| LAS: extra bytes after the first LASF_Spec record 4 were lost (`confidence` of `append-bug.laz`) | Only the first record was read | Every record 4 reads, in order | `packages/points/tests/laz-real.test.js` |
| LAS: a file with a deprecated extra bytes type, 11 to 30, was refused whole | Those pairs and triples were not known | Read as `name[0]`, `name[1]` and so on | `packages/points/tests/laz-real.test.js` |
| LAZ: chunk size 0 failed | Only 2^32-1 meant variable chunks; the specification names both | Both mean variable chunks | `packages/points/tests/laz.test.js` (test encoder) |
| LAS: positions 16 m coarse on a real file (`simple1_3.las`) | ALSXX_PP stored the header box as raw integers, a thousand times too far out, and positions are float32 relative to that box | When the first point lies outside the box the first point is the origin | `packages/points/tests/las.test.js`, `packages/loaders/tests/las.test.js` |
| A web page read as a point cache was refused as "Point cache holds 3418670067845590500 floats, over maxFloats; raise maxFloats" | MDD has no magic, so any file reads as an MDD header, and the reader checked `maxFloats` before the bytes the file holds | The size a header claims is checked against the file first: a cut file or no point cache is refused as one | `packages/animation/tests/point-cache.test.js` |
| Eight README examples on the readme-run known list were renamed by README edits and failed unseen | An id hashes the example's code, and `check:readme-run` runs only in the full check after a push | Six run on KayKit's mannequin (CC0) and the warping and get-up entries carry their new ids; verify now fails on a known entry no example holds | `tests/run-readme-examples.test.js` |
| `docs/known-bugs.md` held rebase conflict markers on main | A conflict resolved by hand in commit 9f8c8a24d kept them, and no check read for them | Both sides kept, markers gone | `tests/conflict-markers.test.js` |

## Fixed 2026-11-05

| Bug | Cause | Fix | Regression test |
| --- | --- | --- | --- |
| `npm run verify` ended with `ENOENT` in `ResultStore.candidates` while another lane ran it | Lanes share one result cache and every `put` prunes its step, so a file could go between the listing and its read | A file gone after the listing counts as not stored, in `get`, `candidates` and the prune; any other read error still throws | `tests/result-cache.test.js`, "an entry another run prunes after the listing counts as not stored" |
| `precisePow` 97 ulp out (bound 5) and `preciseTan` 2.70 ulp (bound 2.5) on an Apple M6, in Chrome and WebKit | Apple's compiler lost the unhidden last product of `pmProductError`: the result equalled the sum without it | Every product there goes through `pmHide` | `tests/precise-math.test.js`, `test:browser:sweep` on the M6 |
| `precisePow` over its bound on every GPU near the top of the range: 5.66 ulp on an RTX A6000, 5.99 on an M6 (bound 5) | `pmLog2Pair` held `s R` in one float, good to about 1.5e-9, and `y` multiplies that. The sweep never drew those inputs | `s R` is a pair, from the series of `R`; `f - sd` is hidden for Apple's compiler. Worst now 1.2 ulp on the A6000, 1.03 on the M6 | The sweep has a new input class that fails on the old maths (A6000), `tests/precise-math.test.js`, `tests/precise-math-reference.js` |
| `preciseLog2` 1.77 ulp off on an M6 (bound 1.5), and `preciseSinh` and `preciseCosh` infinite at 89 | Apple's compiler spread the unhidden tail over the large part, rounding twice, and regrouped `(0.5 t) t` as `0.5 (t t)`, which overflows. Both were behind `preciseTan`, where the test stopped | `pmHide` on the tail and on `0.5 t` | `tests/precise-math.test.js`, `test:browser` on the M6 |
| `lighting2d`: 1.07 levels dark with 43 lights on an M6 | Additive half-float blending on the M6 rounds toward zero (64,965 of 65,536 sums fit that exactly, none fit round to nearest; an A6000 rounds to nearest) | The sum is four layers, each holding a quarter of the lights, added once in the show pass | `packages/lighting2d/tests/browser-check.mjs` on the M6 |
| `webgl2-compat`: an sRGB view read 0.25 for 0.05 on ANGLE Metal | ANGLE on Metal encodes bytes that reach an SRGB8_ALPHA8 texture through a pixel unpack buffer (uploads from an array are right, and `copyTexSubImage2D` from unorm is an error) | Copies into an sRGB twin go through client memory | `packages/webgl2-compat/test/features-browser.mjs` on the M6 |
| `audio`: `ended` never fired on WebKit for a sound with nothing left to play | WebKit fires no `ended` on a node started at or past its end, or with duration 0 | Such a sound plays one silent frame at rate 1 | `packages/audio/tests/pause.test.js`, `audio.test.js`, `test:browser` on WebKit |
| `scatter`: 2 of 65,536 pixels below 0 (-0.046) on WebKit | Centroid can land just outside a thin triangle, so the colour varying is extrapolated | The fragment shader holds the colour varying at 0 and above | `packages/scatter/test/variation.browser.mjs` on WebKit |
| `sciviz` examples: "Importing a module script failed" when a page was left soon after load | `ready` was set before the axes' dynamic import finished | The examples wait for `figure.ready()` | `packages/sciviz/tests/sciviz-browser.js` on WebKit |
| Suites that render and read in one task failed on WebKit (`pixel`, `sprites`, `tilemap`, `ui`, `controls`, `environment`, `exporters`, `sciviz`, `water`) | WebKit keeps a canvas's copied image: render, read, render, read in one task returns the first read. Chrome loses the frame after the task, so the read must be in the render's task. Test harness only: `capture` sets `canvas.width` per tile and the sciviz export ends in `convertToBlob`, a real task | Each harness resets the canvas size around its read, which clears WebKit's copy | The suites themselves, on WebKit |
| Tests that assumed Chromium: `creative` (CDP pinch), `exporters` capture (`repetitionCount`, GIF durations, opaque frames), `kinematics-constraints` (mouse positions in whole pixels), `materials` (`captureStream` sends no frame until the canvas changes, 600 s timeout), `react` extras (JSC tail calls drop `return <Mesh>` frames) | Each was a harness reading one browser's behaviour as the rule | Each test reads what the browser delivers; the tolerances are unchanged. The React difference is in the package README and `docs/limits.md` | The suites themselves, on WebKit |
| `voxel-pathtracer` ground precision control: 280 dim pixels on the M6, the check wants over 1,000 | The control puts the old point `o.y + d.y t` back, and Apple's compile fuses that sum (65,536 of 65,536; an A6000 none), so the rounding the control exists to show mostly went away | The control keeps the product out of the fuse with a bitcast the compiler cannot see through; threshold unchanged. M6 5,309, A6000 4,763 | `packages/voxel-pathtracer/tests/browser-check.html` |
| `webgl2-compat` `features`: depth16unorm 24,575 against 24,576 on WebKit | 0.375 falls between two levels, and which one a clear picks is the driver's: Metal's clear truncates, WebKit's WebGPU rounds | The test clears to a value a quarter above level 24,576, which reads the same everywhere; the comparison stays exact | `packages/webgl2-compat/test/features.html` |
| `npm run verify` ended with `EPERM` in `ResultStore.put` while another lane ran it | Every `put` prunes its step, and Windows refuses a delete while another lane reads or deletes the same file | A refused delete leaves the entry for the next `put`; any other error still throws | `tests/result-cache.test.js`, "a prune another run blocks leaves the entry for the next put; other errors still throw" |
| `npm run verify` ended with `EPERM` in `ResultStore.candidates` while another lane ran it | While Windows deletes a file, opening that name fails with `EPERM`, and a lane reading its step's entries could hit an entry another lane was pruning: about 4 reads in 1,000 with four processes on one step | A prune moves the entry to a temp name first, in one step, so only a name no reader lists is deleted: none in 15,000 rounds of the same four processes | `tests/result-cache.test.js`, "a prune takes an entry off its name before deleting it, so no reader opens a file mid delete" |
| Light tier: 50 FPS on a 100 Hz display, in every browser (a Dell S2725HS, which macOS runs at 100 Hz by default; 90 Hz gave 45, 165 Hz gave 55, and 75 Hz about 58 with 1 ms of jitter) | `capFrameRate` skipped every refresh sooner than 12.67 ms after the last frame, so on a display with no multiple near 60 it dropped every other refresh. Phones are not paced, so a phone on the same page showed 60 | `@margoengine/quality`: each frame spans the most whole refreshes that still reach the rate, counted from a median of the last 16 callback gaps, so no display falls below it and jitter cannot move it. Real page, simulated 100 Hz clock, Apple M6: 50.0 before and 100 after, in Chrome 157 and Playwright WebKit 27.2 | `packages/quality/test/quality.test.js`: "the cap never renders below its rate, at any refresh rate", "the cap holds its rate through callback jitter and whole-millisecond timestamps" |
| Light tier: an Apple M6 read 19 to 32 ms of GPU time a frame while holding 60 FPS, so its reading was over the limit by four times | The reading added up each pass's time, and an M6 runs a frame's 11 passes side by side: 31.9 ms of passes in 8.5 ms of GPU time (Chrome, 90th percentile) | `@margoengine/quality`: a frame reads the time its passes cover, so passes that overlap count once. Passes that run in turn read as before (an RTX A6000 reads 4.33 ms either way). An M6 now reads 8.4 to 9.1 ms at 60 FPS, which is still over `FAST_GPU_MS` (8), so this scene stays on the light tier there | `packages/quality/test/quality.test.js`: "passes that run at the same time count once" |
| `compile()` on a model with no published matrices skipped every draw as singular and compiled nothing, so the first frame blocked anyway | a node's matrix is zero until its first tick, and a zero matrix reads as singular | `compile` ticks when the root is unpublished | `packages/gltf-pro/tests/model-runs.test.js` ("compile() builds first-frame pipelines") |
| `cloneModel`: each copy ran a tick of every mesh of the engine to bake its static batches, so a crowd cost quadratic time (`p-skeleton-clone`: 100 ticks a call, 6.4 ms, before entry 59 halved them) | baking read world matrices, and a tick is the only way to publish them | a copy takes the source's batches (`PBRModel.adoptStaticBatches`): the same baked arrays and part poses at the same pose, so it bakes nothing and ticks nothing; a source moved since baking, or parented, still costs its one tick | `packages/gltf-pro/tests/model-runs.test.js` ("a copy that takes its source batches costs no engine tick", "where the batches do not fit"), `packages/animation/tests/clone.test.js` ("cloneModel of a registered model runs no engine tick") |
| `cloneModel`: every copy uploaded and mipped its own textures (`p-morph`: 700 textures, 300 bitmap copies, 300 submits, about 560 MB of texture memory for 100 copies; the first frame waited 200 ms for it) | the copies held separate `createImageBitmap` copies, so nothing could tell they were one image, and gltf-pro's texture cache was per model | copies hold the source's images (`PBRModel.shareImages`, counted) and gltf-pro shares textures per device, image and format, each freed with its last holder | `packages/gltf-pro/tests/model-runs.test.js` ("copies of one image share its GPU texture"), `packages/animation/tests/clone.test.js` ("cloneModel holds the source image") |
| Apple GPUs: 4x MSAA edges of scatter instances changed from frame to frame (Apple M6, Metal: a still biome view drew about 420 of 76,800 pixels differently every frame; `node packages/biomes/tests/shadows-check.mjs --msaa` failed its control, 1,149 values differ) | scatter's WebGPU cull appended each visible instance at an `atomicAdd` slot, so the LOD rings held the frame's instances in whichever order the GPU's threads ran, and the M6 draws an instance's MSAA edge pixels by that order | the commit "fix(scatter): cull in candidate order on WebGPU": each candidate stores its ring flags (and its instance) at its own index, the prefix count of `packages/shared/prefix.js` gives each its slot and each ring is compacted (`packages/scatter/src/order.ts`, shared with the WebGL2 route). On the M6 the frame-repeat check is exact and `shadows-check.mjs --msaa` passes (control 0); its cost is in [limits.md](limits.md) (Rendering, "Scatter cull in candidate order") | `packages/scatter/test/order.test.js` (fails with the atomic cull: its rings come out reversed when the threads run in reverse); `packages/scatter/test/repeat.browser.mjs` (6 still 4x MSAA frames bit-identical) |

## Fixed 2026-10-31 (flaky root tests under load)

| Bug | Cause | Fix | Regression test |
| --- | --- | --- | --- |
| `SHUTDOWN_TIMEOUT` "still open: browser" on a busy machine (`tests/page-ready.test.js`, `tests/catalog.test.js`, `scripts/frame-alloc-browser.mjs`) | headless Edge shuts down on low-priority threads, which CPU-bound work starves: its graceful close took 68 to 146 s beside CPU hogs | `withBoundedClose` ends a Chromium-family browser's process tree before the close, 7 to 17 s on the same load; the 30 s budget is unchanged | `tests/browser-teardown.test.js` (a close that finishes only once the tree is ended; a real browser leaves no process) |

## Fixed 2026-10-31 (found by the WebGL2 demo comparison)

| Bug | Cause | Fix | Regression test |
| --- | --- | --- | --- |
| VFX: blended particles drew in a different order each frame (the gameplay sandbox still frame differed by 1 level on 41 to 57 pixels between two native captures, RTX A6000, Edge 156) | the update kernel took respawn tickets and draw-list places with `atomicAdd`, so the order of overlapping blended particles changed between runs | `33c403984` (dated 2026-10-30): four workgroup prefix-sum passes give births the lowest dead slots and compact the drawn particles in slot order | the order case of `packages/vfx/test/browser-check.mjs` (65,536 slots, 40,000 births, five frames, two runs; fails with the atomic build, 0 pixels differ with the fix) |

## Fixed 2026-10-31

All were found by `npm run modern:test:extensions` and the other `test:release` suites, which no check ran from about
2026-10-16. They run in `check:gpu-packages` now, and
`unrunReleaseGates` fails a suite that drops out again.

| Bug | Cause | Fix | Regression test |
| --- | --- | --- | --- |
| The packed-browser step of `modern:test:packages` missed its fixed 30 s page-load limit on a busy machine ("Packed browser failure: state null") | a fixed time against load: a cold dev server transforming every package took longer while other check:merge runs shared the CPU | the step waits on the dev server (`waitForRequestsIdle`) and then gives the page 10 s; a 10 minute hard limit fails a real hang naming the server state and page errors, and the browser and server close (`scripts/support/page-ready.js`) | `tests/page-ready.test.js` (holds the last module back in a real dev server: the fixed wait fails, the new wait passes) |
| `npm run dev:examples` refused every page (403) from a checkout reached through an 8.3 short path | Vite's file-serving allow list held the working directory as given and compared it with each file's real path | `dev:examples` runs `scripts/dev-examples.mjs`, which starts Vite in `realpathSync.native(process.cwd())`; no root Vite config, so every other root `vite` command is unchanged | `tests/dev-examples.test.js` (short-path cwd serves 200, a file outside the repository stays 403) |
| Taking one lighting effect out of a `VoxelRenderer` other than the last one added drew the clear colour for 8 to 21 frames (`draws` 0, RTX A6000, 3 ms frames) | a composition never drawn before had nothing compiled, and the pipelines with the removed effect cannot draw (its owner may dispose its resources) | once a composition is ready, those without each one of its effects compile a GPU call per frame and stay among those kept, the one without effects stays always, and while the wanted one is not compiled the largest compiled composition whose effects are all still added draws, which covers several effects leaving at once (`packages/voxel/src/render.ts`). The stand-in way was measured and refused: zeroed bindings draw every voxel black with fog taken out, 190921 black pixels with an environment, 1956 wrong with shadows, and the renderer cannot make a depth or cube texture of a kind it does not know | `packages/voxel/tests/render.test.js` "addLighting: the frame right after" and the three after it, `render-lighting-browser-check.mjs` effectRemoval (either effect, disposed at once, 0 pixels off the settled frame) and severalRemoved (two of three leaving in one frame) |
| `modern:test:extensions` sat silent until the 30 min GPU lock limit | Chromium (Edge 156, RTX A6000) leaves a `getCompilationInfo()` asked once the device is idle pending until another GPU request runs; `material-extension-tests.js` asked for 41 modules then, inside a `page.evaluate` with no time limit, and the eight suites ran in one process with no limit | the WGSL guard asks every module at creation and answers later calls with that (`scripts/support/wgsl-guard.js`); each suite runs alone under `runLimited` (`scripts/modern-extension-suite.mjs`); engine source must ask at creation | `tests/wgsl-guard.test.js`, `tests/modern-extension-suite.test.js`, `tests/compilation-info-at-creation.test.js` |
| IOR 1 transmission (materials) drew a 13-step highlight over the background | since `dc883a59` the host keeps reflections under extension transmission, but its F0 stayed 0.04 whatever `KHR_materials_ior` said | the extension slot takes an `ior` expression and the host sets `s.f0` from it (gltf-pro); transmission and node transmission pass it (materials) | `packages/materials/tests/transmission-ior.test.js`, `scripts/materials-transmission-tests.js` |
| Transmission with a sheen or specular lobe drew about 148 steps of white on a fully transmissive surface | the lobes recompute diffuse light at full strength, ignoring the transmitted share `s.tr` | lobes composed over transmission scale their diffuse by 1 - `s.tr`; `install` composes transmission first (materials) | same two |
| The thin-glass sightline and volume refraction checks compared bytes, which IOR-dependent reflection and transmission (`dd13beb9`) change | the checks measured lighting, not where the background lies | they compare the red/green layout of the background | `scripts/materials-transmission-tests.js` |
| `gltf-ktx2-production-tests.js` and `gltf-compression-browser-tests.js` could not build | the `closeAll` codemod put its import into the source of the generated consumer page (bug 70 again; that guard read only `.mjs`) | the import moved to the script | `tests/undeclared-names.test.js` now reads `scripts/**/*.js` |
| Half metal glass lost light: the transmitted share took the mixed F0 (`mix(dielectric, base, metal)`) on top of `1 - metal`, so white half metal at IOR 1.5 passed 0.24 where glTF's `mix(dielectric_brdf, metal_brdf, metallic)` gives 0.48, and reflected plus transmitted came to 0.76. With a specular lobe in play it read 0.48, so the value jumped at specular 1 | The share was written after the sample implementation's `f0 = mix(0.04, base, metal)`, which is right for reflection and takes this light a second time | `materialTransmissionWeight`, `materialLobesTransmitted` and the `Transmission` pass subtract the dielectric's own Fresnel | `packages/materials/tests/transmission-shader.test.js`, `transmission-layers.test.js` |
| Over transmission, sheen, specular and clearcoat did not touch the transmitted light (materials `install`): a white glass quad read 0.96 of the background whatever the lobes said, against the Khronos numbers 1.0 (specular 0), 0.92 (specular colour [2,1,1]), 0 (colour [25,25,25]), 0.42 (white sheen, roughness 0.5, 75 degrees), 0.54 (clearcoat 1, 75 degrees). Native tint path (no install): 1.0 for all of them | the transmission weight knew only the IOR's Fresnel, and the native tint was a per-material constant; glTF puts transmitted light in `fresnel_mix`'s base, under sheen and clearcoat | lobes set the transmitted share `materialLobesTransmitted`, the coat its `materialCoatKeep`, and the share is applied in linear light (materials); `margoTintShare` computes the same from the material's factors (gltf-pro) | `packages/materials/tests/transmission-layers.test.js`, `scripts/materials-transmission-tests.js` "layeredShare" |
| Suite checks had gone stale against deliberate changes: a pinned shader hash, "New lobes bypassed transmission" (exact pixels, from before reflections stayed over transmission, `dc883a59`), `dynamicDraws === 4` and `staticDraws === 8` (undeformed casters cache automatically), one PBR compile per eye (pipelines are per device), exact error messages (coded errors with links), a lazy gltf chunk (the stage root has no `import()` since 2026-10-27), `engine.recovery` (private, mangled in dist, so the device loss race counted zero recovery frames) | no check ran them | each now states today's contract, as strictly: the shader against its source, lobes byte-exact on the unlit transmitted background plus a reflection check when lit, draws per cascade, the shared compile, the coded messages, no optional package anywhere in the quickstart bundle, frames between the loss and the new device | the suites, in `check:gpu-packages` |
| Scene 05 of the biome scenes seemed to change colour and show sky bands above about 1.4 million objects; no engine fault: sky bytes are identical at 1,357,722, 1,387,928 and 1,429,018 objects, and at 2,028,410 no errors and every buffer stays under 13 MB | the tool that reads a picture to a model re-encodes a file over 3,932,160 bytes (5 MiB of base64) with a reduced palette; the same pixels pass true at 3,932,160 bytes and bands appear at 3,932,161; a 1920x1080 frame sits right at that size, so object count only moved the file size | `scripts/review-png.mjs` rewrites a shot losslessly under the limit and stops with `REVIEW_PNG_TOO_LARGE` if it cannot; judge shots from its output or by their numbers | `tests/review-png.test.js` |

## Plaza (voxel-net) fixed 2026-10-31

Three entries were open on the Plaza branches and did not come across when they landed on main; the findings are in
[voxel-net-capacity-2026-10-31.md](voxel-net-capacity-2026-10-31.md) ("Bugs found by this run" and "Old connections").

| Bug | Cause | Fix | Regression test |
| --- | --- | --- | --- |
| A player flying onto new ground was closed with 1008 "too many messages": 38 of 150 bots on the real server, 18 to 28 of 150 locally at the same generator speed | the server holds a client's inputs until the chunks around it exist, while the client runs ahead on chunks it was sent; the 256 message queue limit (12.8 s) counted the server's own backlog against the player, and a wait has no upper bound under load | `5614fb925`: while held, inputs past 256 fold into the last one (at most 60 steps are banked after a wait, the rest only count), and the chunks that hold a player go to the front of the generator queue; over 64 messages a second during a wait, and 256 in a tick outside one, still close the player | `packages/voxel-net/tests/held-inputs.test.js` |
| Plaza connections were closed after about 15 minutes (first cut at 1,073 s of age: 66 of 100 bots through the CDN, 0 of 40 past it) | not the game or the home line: the first FIN comes from the CDN proxy, and a plain echo server with no Margo code is cut the same way | protocol 4: the server parks a dropped player for 30 s and takes it back on a token, and `connectVoxelNet` and `VoxelBot` resume in place on their own | `packages/voxel-net/tests/resume.test.js`, `resume-client.test.js`, `resume-crowd.test.js` |
| 1006 closes with no cause on old connections | the same CDN proxy cut as the row above | the same resume; the page plays on through the close | the same tests. Not explained: the one `client-silent` close in the capacity run, which `/metrics` counts as a park of its own kind |
| Imposters of a subassembly lit rotated parts from the wrong side, mirrored parts inside out; `hierarchicalLOD` far meshes bent normals on stretched sources and turned mirrored sources inside out | `coreModel` applied the transpose of the cofactor matrix and did not negate it for a mirror; the far mesh used the plain matrix and kept the winding | `normalMatrix` in `packages/lod/src/attributes.ts`, used by both, with mirrored triangles rewound | `packages/lod/test/auto.test.js` (normalMatrix) |

## Fixed 2026-10-26 to 10-28

Each is described with its cause and guard in
[whitepaper/perf-history.md](whitepaper/perf-history.md#what-our-checks-caught-and-what-we-got-wrong-2026-10-26-to-10-28).

| Bug | Fix | Regression test |
| --- | --- | --- |
| Precise maths changed by compilers that reassociate (AMD Radeon 680M, Intel UHD with Mesa) | `b6bea3e9`, `baa66526` | `tests/precise-math.test.js`, `packages/compute/tests/maths.test.js`, compute `test:browser:reassociate` and `test:browser:sweep` |
| `math-consolidation` proof digests differed between Node 22 and Node 26 | `ab27353f` | `tests/proofs-golden.test.js` |
| Repository and package Node minimums were one number | `6c289ed9` | `tests/engines.test.js` |
| VoxelRenderer drew nothing after the last added effect was removed; a replaced clustered light threw | `baa66526` | `packages/voxel/tests/render.test.js`, `render-lighting-browser-check.mjs` |
| Flaky under load: lod heap probe, catalog clipboard | `6d08b0af` | `packages/lod/test/lod.test.js`, `tests/catalog.test.js` |
| Flaky under load: quiet-server timeout | `3a59aa55` | `tests/server-url.test.js` |
| Flaky under load: controls walk step per frame | `7714e84e`, `109ec352` | `packages/controls/tests/walk.test.js` |
| Browser suites shared one Vite dependency cache | `7ab8cd13` | `tests/vite-cache-isolation.test.js` |
| GPU suite waited silently for a fixed port | `6ddd733b` | `tests/browser-port-wait.test.js` |
| Headless Edge used the integrated AMD GPU with Remote Desktop disconnected | `85c96a55` | `tests/gpu-adapter.test.js`, `tests/browser-selection.test.js` |
| A GPU reset left a page waiting 30 to 120 s with no cause named (the reset itself is still open, above) | `49dca9dd`, `51d8786a` | `tests/device-loss-guard.test.js`, `tests/driver-resets.test.js` |
| netcode `openWebSocket` hung on a refused connection on Node 22 | `7f0dd465` | `packages/netcode/tests/transports.test.js` |
| Data after a compressed stream accepted on Node 22 (fbx, loaders ZIP, splats SOG, voxel codec) | `0687e6ec` | `tests/trailing-data.test.js` |
| The exporters USDZ timing test flipped with every core allocating: the whole export against the old search | 2026-11-05 | `packages/exporters/tests/exporters.test.js` |
| The exporters USDZ timing test failed under bursts of load: a 3 ms control found quiet gaps a 20 ms export could not, so the best-of ratio passed its budget of 10 with no slower export. Six controls per timing now last as long as the export; the budget is unchanged | 2026-11-06 | `packages/exporters/tests/exporters.test.js` |
| Audit F01, F02, F05: margo-convert read, deleted or overwrote files outside their folder | `4bc89574` | `tests/margo-convert-paths.test.js` |
| Audit F06, F07: `allowedURLs` matched by prefix; redirects were not rechecked | `c6e7623c` | `tests/security.test.js`, `packages/gltf-pro/tests/progressive.test.js` |
| Audit F04, F17: OBJ material libraries fetched from any host with the caller's options, no total budget | `b96f5f40` | `packages/loaders/tests/mtl.test.js` |
| Audit F11, F12: netcode room joinable before `onCreate`; failing hooks left clients hanging | `158076f1` | `packages/netcode/tests/rooms.test.js` |
| Audit F18, F19: WebSocket control frames counted against the message limit; close reasons cut by characters | `6bebf878` | `packages/netcode/tests/transports.test.js` |
| Audit F14, F15: voxel-net dropped a hello sent with the upgrade; failed chunks were never retried | `8c8b51a0` | `packages/voxel-net/tests/websocket.test.js`, `server.test.js` |
| Audit F03, F13, F16: voxel-net had no authentication, no cap before the hello and no bound on edited chunks | `ddc5c5ff` | `packages/voxel-net/tests/limits.test.js` |
| Audit E-01 (bug 61): partial-view clears drew black at 4x MSAA on Intel Arc 140V (D3D12) because the colour came only from the blend constant | `64034d95` | `tests/clear-draw.test.js` |

## Loaders

### toGraph of MaterialX is not yet compared with a MaterialX render

- **What:** `@margoengine/loaders/materialx` read one real file, an ambientCG `open_pbr_surface` material kept outside the repository, and its test compiles a graph through `nodeMaterial()`. `@margoengine/usdz/materialx` now reads 19 real `.mtlx` files, their networks match OpenUSD, and the shader defaults were checked against the tables of the Physically Based Shading Nodes document. `parseMaterialX` pins them to the published nodedefs, `standard_surface` 1.0.1 and 1.0.0 included (`packages/loaders/tests/materialx.test.js`). Still no material was rendered and compared with a MaterialX viewer.
- **Repro:** convert a material from the MaterialX sample library, render it on a sphere and compare with MaterialXView.
- **Cause:** no reference renderer or sample library in the repository.
- **Needed to close:** add sample documents to `THIRD-PARTY-NOTICES.md` with reference renders, and compare them.

## Mixer batch 111 acceptance

Automatic sidechain has no known open defect in the tested generated-signal paths. Real-speech,
other-browser and latency acceptance remain unmeasured design/coverage limits in [limits.md](limits.md#mixer-automatic-sidechain-batch-111).

Snapshots have no known open defect in tested layouts. Unsupported topology/state coverage and
unmeasured browser/recording paths are documented in the snapshots limits section.

Exact dynamics have no known open defect for finite PCM in the tested reconstruction model.
Conservative attenuation and unmeasured converter/listening/browser coverage are documented limits.
The browser fixture lifetime issue is fixed by awaiting rendering inside the using scope.
The cached-registration cancellation race is fixed in both factories: each checks the signal
immediately before allocating nodes. Regression: sidechain.test.js and worklet.test.js final tests.

Early reflections have no known open defect in tested static rectangular rooms. First-order
geometry, interpolation colouration and unmeasured room/listening coverage are documented limits.

Loudness has no known open defect in supported PCM formats and tested generated standard cases.
Coverage/normalisation limits are recorded in limits.md; no full certification or authentic-programme proof.
The snapshots public budget was stale after a shared ratchet shrink (1,983 to 1,956 B). It is
corrected, with docs.test.js covering the whole mixer class of stale entry/budget records.
Existing mixer mutators changed gain/mute/solo targets and duck membership before a rejected fade;
invalid values could also cancel prior automation. The owning scheduler now validates inputs first,
setGain commits metadata only after scheduling succeeds, and duck release validates before removal.
The undefined-release/gate default inconsistency is fixed too. mixer.test.js adds regressions that
fail on the prior implementation; no known open scheduling defect remains in these tested paths.

### Audio occlusion (batch 110)

No known open defect in tested static geometry/partial-cover paths. Generated browser tests cover native WebGPU and both WebGL2 routes. Sampling, deformation and acoustic-model limits are documented in limits.md. The first browser fixture incorrectly treated the compatibility engine's WebGPU-shaped API label as its underlying backend; the fixture now asserts isCompatDevice and also exercises the native WebGL2 renderer.


- **Weighted OIT has a measured transparency picture loss** (`@margoengine/oit`, perf history 109):
  five unlit binary-colour panes, exact ray-sorted coverage reference, common output encoding. MAE 1.567519,
  PSNR 35.388 dB and max byte miss 15, versus Babylon.js 8.33.0 dual depth peeling MAE 0.048151,
  PSNR 61.305 dB and max 1. Source: `packages/oit/src/index.ts` averages weighted colours with aggregate
  revealage; this does not retain the full ordered layer sequence. Rerun under the exclusive GPU lock:
  `node packages/oit/scripts/rival-bench.mjs`. Publishing the loss does not close it.
- **Transparent material colour is blended in the display domain** (`packages/materials/src/built-material.ts`,
  `packages/oit/src/index.ts`): the material encodes each source before the transparency hook. For a single
  50%-coverage basic red with linear source 0.5 over black, the pipeline computes 0.5*sRGB(0.5) rather than
  sRGB(0.25). Sorted and OIT drawing share this cause. The initial graded-colour batch 168 probe exposed
  nonzero single-layer error; it is not attributed to weighted depth approximation. Binary source channels in
  the published comparison bypass this confound without changing geometry or drawing less work. A linear
  composition/output contract across the owning optional packages is still needed; this remains open.


- **Default Preetham angular radiance differs from Mitsuba sunsky** (`@margoengine/sky`, perf history 110):
  297 directions across sun elevations 10/45/75 degrees and turbidity 2/3/6. Normalize each sky by its own
  zenith Y. RGB MAE 1.439228, max 70.681783, per-case relative MAE 0.199319 to 0.765628 against Mitsuba
  3.9.1 scalar_rgb Hosek-Wilkie sunsky with disk off and albedo 0. Cause: the default model is Preetham,
  with Margo horizon/turbidity clamps and daylight-locus chromaticity adjustment, not the newer fitted
  sunsky model. Absolute units are also not interchangeable. Repro under the shared GPU lock:
  `node packages/sky/scripts/rival-bench.mjs`. The normalized model loss remains open.

### Audio Doppler (batch 110)

No known open defect in tested buffer-motion paths. Node tests cover radial signs, transverse/co-motion, coincident positions, frozen/backward clocks, resets, bounded extreme velocities, rate smoothing, recreated sources, invalid options, duplicate attachment and teardown. The first local build used an error code outside MargoErrorCode; corrected to the established linked RangeError convention. The first test fixture omitted required listener forward/up arguments; corrected the fixture. Source-kind and acoustic approximation limits are in limits.md.

The first Doppler verify found the limits index still at LIM-602 and the generated llms corpus stale after the final size update. Updated the exact index line and regenerated the corpus; existing claims-file and llms regression checks cover both. No tests or budgets were changed.


### Batch 168 closing reference losses

- **Default contact shadow misses broad ray-traced ground occlusion** (`@margoengine/staging`, perf history 111):
  a radius-0.5 sphere touches ground under uniform hemispherical lighting. Across 15,472 visible ground pixels,
  normalized darkness MAE 0.048174, RMSE 0.074416, max 0.288788 against 4096 cosine rays per pixel.
  Reference quadrature differs from projected solid angle by at most 0.001734. Mean darkness is 0.000177
  versus 0.048351. Cause: `packages/staging/src/index.ts` keeps nearest-surface height and applies fixed
  Gaussian blur and opacity, which cannot integrate the directional hemispherical visibility field.
  Repro under the shared GPU lock: `node packages/staging/scripts/rival-bench.mjs`. Loss stays open.


The batch 168 OIT image loss above is also confirmed against an independent Cycles path trace:
MAE 1.632960 (Margo) versus 0.132651 (Babylon), 1024 samples, seed 168, same emission/coverage panes.
The reference has residual noise/silhouette sampling differences (exact oracle versus Cycles MAE
0.094812); this does not close or excuse the weighted-order approximation defect. Repro:
`node scripts/rival-oit-cycles.mjs` under the exclusive GPU lock.

### Audio event containers (batch 110)

No known open defect in tested selection, variation, cooldown and pool-lifecycle paths. Existing AudioVoicePool owns voice stealing and sources. Invalid positions/draws are validated before pool playback so failure does not cut an existing voice or consume container history. Node regression coverage is in events.test.js; real browser PCM uses generated stand-ins. Model and resource limits are in limits.md.

Event review found that Array.every skips sparse-array holes, accepting missing range endpoints and missing coordinates. Explicit finite endpoint/coordinate checks now reject them. AudioVoicePool.play also stopped a sounding voice before validating new coordinates, volume or rate. The owning pool now validates all play inputs before any voice mutation. Regression tests in packages/audio/tests/events.test.js and packages/audio/tests/audio.test.js fail against the previous implementation and pass with both fixes, including preserving the previous source, pose, level, rate and smoothing. No tests or tolerances were loosened.

### Creative texture targets (batch 77)

No open defect found in the tested color-only subresource scope. The generated fixtures and real WebGPU
readback cover faces/layers/slices/mips, load, HDR and explicit device replacement; native WebGL2 rejects with
a coded help link. Scene capture, depth, MSAA, automatic mip generation and other devices are design limits
or unmeasured coverage, recorded in limits.md, not proven capabilities.

### Adaptive music (batch 110)

No known open defect in tested layering, beat/bar scheduling, validation and lifecycle paths. Initial Node tests inspected a bus pre-tap instead of its fader; corrected graph traversal checks the actual mixer automation without changing expectations. The quality API check found two missing exported-interface comments; both now describe the options. Generated-stem PCM proves scheduling, not authored musical quality; limits.md records scope.

### Reverb zones (batch 110)

No known open defect in tested zone selection, overlap, wet routing, tail preservation or lifecycle paths. Invalid bounds/levels reject before graph allocation; an invalid later room response disposes already created effects. Sparse coordinates reject explicitly. Node stand-ins and real browser generated-impulse PCM cover the stated scope; limits.md records model/resource limits.

### Ambisonic beds (batch 110)

No known open defect in tested first-order routing, quaternion/listener orientation, buffer playback and teardown paths. Initial browser fixture reused a plugin name for two independent contexts; unique fixture names now exercise both without changing assertions. Node fetch received HTTP 403 from the audio host; curl retrieved the published file and its MD5 matches Zenodo metadata. This was transport setup, not an engine error. Unsupported conventions/orders and the stereo-decoder/XR evidence limits are explicit in limits.md.


### Batch 160 metallic-roughness picture loss (open)

The README execution check also exposed a missing example asset: pointer-show.glb was not provided,
so the generic replacement had no camera and viewGLTFCamera correctly rejected it. The package now
includes a Margo-authored triangle/camera/sun pointer sample, linked from its README. Regression:
packages/gltf-pro/tests/readme-pointer.test.js checks all three animated values at 0.5 seconds.

Khronos MetalRoughSpheresNoTextures under a matched embedded camera and directional sun differs from the
Sample Viewer: all-pixel RGB byte MAE 1.837511698404948, foreground MAE 11.58277025673087,
RMSE 6.388144511474295, max 254, 40,875 differing pixels of 262,144. Compatibility WebGL2 MAE
1.837506612141927. Full evidence: docs/whitepaper/results/batch-160-metallic-roughness.json.
Repro: scripts/reference-rendering/run.mjs under the shared GPU lock (see whitepaper reproduction).

Known Margo causes to isolate: gltf-pro/src/shader.ts clamps perceptual roughness to 0.045 even for the
sample's authored zero-roughness column, and packages/shared/light-terms.js uses separable single-scatter
Smith G, without height correlation or multiple-scattering compensation. Appendix B.3.6 describes why
these model choices can lose energy. The Sample Viewer is treated strictly as a black box: its exact model
is not inferred from source. These are known limitations of Margo's formulation, not a quantified attribution
of this entire picture error. The residual including the thin model text and silhouettes is not yet isolated;
sampling/display resolution and BRDF effects need separate controls. No shader change is justified by a
guess about that residual, and recording a budget does not close the loss. No physical/path-traced parity
is established by this first job; the environment/Cornell jobs remain outstanding.

### Batch 160 clearcoat picture loss (open)

Repro: `node scripts/reference-rendering/run.mjs --case=clearcoat` through the GPU lock, after
fetching its source and capturing the reference as documented in whitepaper/reproduce.md.
Entire Khronos ClearCoatTest, 27 primitives, no IBL, identical camera and sun, 512 x 512.
All-pixel RGB MAE 1.6809107462565105 (WebGPU), 1.6809145609537761 (compatibility WebGL2),
maximum byte error 180. Frozen result: whitepaper/results/batch-160-clearcoat.json.
Cause of the complete residual is not yet isolated. Known formulation differences to investigate:
Margo clamps clearcoat roughness to .045 and uses separable single-scatter Smith; its coat direct
Fresnel uses VdotH, while the extension's nonnormative layering example uses NdotV.
None of these has been proved to explain the full image error. Base-material, texture-filtering,
normal-map and silhouette errors are included, not removed by masking. No reference-specific
shader adjustment or core change is justified by this measurement alone.

### Fixed 2026-11-09: WFC weight arithmetic overflow

The root tile solver accepted finite weights such as 1e308 even when weight times log(weight) or the total weight overflowed. Its entropy became non-finite, so an undecided grid could look complete. Construction now rejects non-representable totals before solving. Regression: packages/wfc/test/wfc.test.js, finite tile weights cannot overflow entropy or weighted choice. The optional global solver applies the same arithmetic validation.

### Fixed 2026-11-09: WFC browser harness teardown

The WFC browser check closed the browser and Vite server independently, which could wait on retained connections without the shared shutdown budget. It now uses closeAll from startup through failure cleanup, matching the other browser suites. Regression: tests/browser-teardown.test.js; the existing bounded-close tests cover stalled shutdowns. The tracked-script gate exposed this after the first feature commit; new files are staged before subsequent landing checks.

### Batch 160 sheen picture loss (open)

Sheen job 3: complete Khronos SheenTestGrid (20 primitives), matching embedded camera/sun,
512 x 512, no IBL, black background, neutral/sRGB. All-pixel RGB-byte MAE
1.4250882466634114 on both WebGPU and actual WebGL2 compatibility; maximum error 167.
Native WebGL2 rejects PBR. Exact integer budgets and hashes: whitepaper/results/batch-160-sheen.json.
Repro: locked scripts/reference-rendering/run.mjs --case=sheen, as in whitepaper/reproduce.md.
The full cause is not isolated. Known formulation choices: Margo uses the Charlie distribution
with clamped Neubelt visibility and a fitted directional albedo; the glTF shader also floors
sheen roughness at .03. The ratified extension permits simplified visibility, while documenting
its energy-conservation tradeoff. No ablation yet attributes the complete picture loss to these
choices; base shading, silhouettes and texture filtering remain included. No shader was tuned
to this reference or changed without a demonstrated small root cause.

### Fixed 2026-11-09: scatter tile input conversion and byte offsets

Repro: pass a Uint8Array.subarray(1, 9) to setTile, or replace a held tile with side Infinity, sparse origin or an
unrepresentable f32 coordinate. Packed Uint32Array construction assumed word alignment; rectangle validation tested
JS finiteness incompletely and never checked GPU conversion or intermediates. Validate before mutation and copy an
unaligned view. Bounds also reject spans that collapse as f32. Both tests in scatter/test/tiles-inputs.test.js fail
on the parent; its atomic-upload check compares retained record and page buffers. The grass-tiles browser test
uses an unaligned view on real WebGPU, streams crossed-ribbon clumps through all three LODs, removes tiles and
restores the device. Native WebGL2 receives the existing coded unsupported error and help link.

### Fixed 2026-11-09: WFC browser harness cleanup and workspace root

The batch 77 full gate found packages/wfc/test/browser-check.mjs bypassing the shared bounded teardown.
tests/browser-teardown.test.js fails on the parent. Use closeAll for browser and server in one bounded cleanup.
The harness also let Vite serve the workspace directory when npm test:gpu launched it, while its imports address
the repository root. Set root from import.meta.url; wfc/test/browser-launch.test.js fails without that change.
The package GPU script now runs as written from npm's workspace cwd. No WFC algorithm or public API changed.

### WFC sockets review (batch 69, job 3)

No new open defect found in generated labelled-face, 48-ID and invalid-input checks. Orientation-independent labels and proper rotations only are documented limits.

### Fixed 2026-11-09: pre-push browser teardown regressions

WFC omitted shared bounded teardown and served package-relative files under a repository-relative URL when run by npm workspace. Its harness now resolves the repository root, disables unrelated scanning/watchers, releases its configured GPU surface and uses closeAll. Diagnostic teardown confirmed native Chromium termination while the launch client cleanup promise stayed pending beyond 30 seconds. Chromium now uses Playwright launchServer plus connect, and the owning server.kill API settles driver/process cleanup within the unchanged deadline. Regression: tests/browser-selection.test.js; tests/browser-teardown.test.js; packages/wfc/test/browser-check.mjs. Generated llms-full content is refreshed with the README changes and checked by tests/llms.test.js.

### Fixed: batch 160 material GPU teardown and masked check errors

The job 4 blocker used the pre-c1646e3ec Chromium launch path. Ending its native process tree could leave the Playwright launch-client cleanup promise pending past 30,000 ms. Current main owns the process and driver through launchServer and server.kill; the batch adds a pending-client regression and uses runSuite in the actual material GPU script, with an injected double-failure regression. No timeout was raised. Instrumented BRDF runs completed all readbacks and WGSL reports and exited after process cleanup; this does not establish a leaked page device as the original cause. Job 4 must still pass its frozen picture budgets before landing.

### Painterly post effects (batch 77)

No open defect found in the tested scope. The first GPU run exposed an unlinked WebGL2 rejection from the underlying
stack; Painterly now preflights its backend and gives its own coded, linked refusal. Construction/live validation,
terminal disposal and independent view uniforms are covered by paint.test.js; paint-browser.js checks independent
CPU pixels, hard edges, alpha/bypass, MSAA/BGRA, resize, real replacement devices and native WebGL2. Classic
Kuwahara square artifacts and noisy variance ties are documented algorithm limits, not a tensor-filter claim.

### Fixed: blocking Windows Chromium termination in a bounded close

Job 4 verify reported SHUTDOWN_TIMEOUT in tests/catalog.test.js after its five assertions passed (test-results/batch-160/job4-verify.log). The original failure did not name a close substep. Instrumented reproductions had zero contexts and prompt client disconnect; public child-process tracing identified synchronous taskkill inside BrowserServer.kill. The event loop cannot enforce a deadline while that call blocks. The shared launcher now ends the owned native process tree asynchronously, waits for its exit and retains driver/server cleanup. The two new tests in tests/browser-teardown.test.js fail on the parent and check ordering plus a timer that fires during pending termination. No budget is raised, no native-handle cleanup is omitted and no process failure is treated as a busy-machine exemption. Original failure attribution beyond the confirmed blocking primitive is not established.

### Fixed 2026-11-09: audio review timing, lifecycle and authored pitch

Live Doppler divided frame displacement by a quantized audio clock and retained pre-suspension poses, producing warble/resume spikes. It now uses monotonic frame time and explicit state/discontinuity history resets. A source-kind switch detaches rather than throwing from a frame hook. Authored sound/pool/event pitch now composes with Doppler and is validated before pool stealing. Occlusion previously inferred no lifecycle state, continuing BVH work after sound disposal, and threw on a missing engine; explicit sound.isDisposed and deferred tracing resolve both. Regression: packages/audio/tests/doppler-live.test.js and occlusion.test.js. Offline PCM claims now state their actual scope, checked by evidence.test.js. The suspected fractional music loop drift is not a bug in the measured browser: subsample endpoints and long-run marker tests retain the authored grid without a music implementation change.

### Fixed 2026-11-09: heartbeat test startup acknowledgement

The slow-start lease test treated any mtime change as proof that the worker had completed its injected startup. Full verification failed its waiting assertion after 5.5 seconds, too soon to include the Windows two-process 2.5-second startup delays and full four-second observation. The preload now acknowledges worker startup explicitly, and firstBeat waits for a subsequent update. The metadata-before-readiness regression fails the old helper. No lock implementation, lease, observation window or timeout was changed. Regression: tests/gpu-lock-limits.test.js.

### Fixed 2026-11-09: quiet crowd resume fixture moved its players

Full verification observed chunksResent 21 instead of zero in resume-crowd.test.js. Its update loop called VoxelBot.update, which always sends forward movement, so an initially loaded client could stream a new view before the cut. Resending messages lost from that stream is required, not a server defect. The quiet fixture now drives public client.update with zero controls and asserts all spawn columns. All 100 clients, cadence, timing and original zero-resend assertions stay intact; missing/in-flight recovery tests are unchanged.

The voxel-net quickstart previously put Node server imports and browser Engine code in one executable block, so the runtime README gate externalized node:http. It now runs a complete Node server/client example on a free loopback port, with explicit shutdown; the obsolete known-failure entry is removed. All 19 audio/voxel-net examples execute successfully.

### Fixed: SQL-store test cleanup ordered before its dependencies

A focused reproduction of the 3c97c10f4 restart test exposed EBUSY unlinking world.db in its first after hook on Windows. Node runs these hooks in registration order; the directory-removal hook failed before the later server/database hook, leaving that server tick and workers alive after the assertion result. The fixture now registers one cleanup hook before setup and owns each acquired resource immediately. Cleanup releases clients, servers, databases and then the directory in reverse order, continues through cleanup failures and reports every error. Explicit restart closes are idempotent. The original integration test failed before this repair; five subprocess regressions inject failures after directory, database, server, client and spawn acquisition and require natural process exit. They run in verify and therefore check:merge; no limit changed.

### Fixed 2026-11-09: cubic WFC reciprocal validation

ConstrainedWFC checked every adjacency edge with an opposite-list includes scan, making dense T-tile validation O(T cubed). The new 4096-ID heap fixture exposed it by exceeding a five-minute hard limit. Shared prepareGrid now checks a bitset in constant work per edge, preserving input order and copied rules. Regression: packages/wfc/test/chunks.test.js bounds observed adjacency reads linearly and retains the dense 4096-ID solve. Library builds also emit module-relative asset URLs so the new lazy Wasm loads from an installed package rather than the filesystem or site root. Node and real-browser loading are exercised.

### WFC worker lifecycle coverage (batch 69)

No open WFC worker defect after lifecycle, actual classic-worker and dual-backend browser checks. Progress is coalesced work counters, not completion percentage; await result for errors. SSR construction deliberately reports coded unsupported. Synchronous heap APIs still cannot receive new abort events while blocking their thread; the optional worker entry supplies termination-based cancellation.

The worker build initially stopped Vite from implicitly emitting wfc.wasm when URL resolution moved behind the classic-worker boundary. The package build now explicitly copies its own single artifact; chunks.test.js compares installed bytes with the source artifact, and actual TS/SIMD worker tests exercise installed loading. The browser-launch harness fixture was updated to its new evidence result shape while retaining its workspace-root assertion.

### README inputs exposed separate causes (2026-11-09)

Reproduce with `node scripts/fetch-readme-assets.mjs` then
`npm run check:readme-run -- --packages=loaders,fbx`. The explicit files close the 404s but four examples still
have separate causes: the FBX introduction asks for Walking on the CC0 mechanical fan (whose actual clips stay
unchanged); the inherit/deformer samples carry unsupported cubic curves without the layers extension; the NURBS
curve-only sample has no triangle mesh for the glTF model loader; the second textured OBJ example passes the fetched
MTL to parseOBJ. These remain on the runtime known list, deferred to the later README job under Scott's
other-causes scope. They are not claimed passing or patched by renaming clips or substituting unrelated bytes.

### Fixed: optional-peer declaration parameter bindings

A strict consumer of React alone loaded an optional binding declaration whose
Props interface inherited from an absent peer. Its emitted destructured parameter
still checked the inherited binding names and produced TS2339, despite the import
guard. The declaration packager now emits ordinary named parameters for typed
binding patterns in files with optional-peer guards, preserving their annotations,
optional marker and arity. No runtime or physics source changes. The TEMP strict
compiler regression in tests/package-declarations.test.js covers absent and
installed peers, invalid installed option types, array/object patterns, name
collisions and idempotent packaging. The bundler matrix checks the packed React
consumer with skipLibCheck false. Evidence: declarations-red.log and
switch-bundlers-ready.log under test-results/webgl-merge.

### Fixed: unused React camera controls emitted their peer chunks

React camera wrappers called forwardRef at module scope without pure annotations.
The bundler retained unused wrapper creation and its lazy loader, so an app importing
only OrbitControls emitted the arcball renderer too. This exceeded the unchanged
115,000 B emitted-JavaScript budget (115,873 B on the current matrix). Mark all four
camera-control wrapper factories pure; requested controls and their loaders remain.
The Vite regression in packages/react/tests/subpaths.test.js requires orbit-only and
arcball-only builds to emit only the requested peer and keep it out of the static
graph. The original test fails with both arcball modules present. No budget or scene
was changed. Evidence: controls-red.log and bundle-reference-metrics.json under
test-results/webgl-merge.

### Fixed in batch 76 job 1: transitions retained lost history

Transitions.onDeviceRestored destroyed both images but kept elapsed/request state. Restoring during a transition blended the new scene against a newly cleared outgoing image. Restoration now finishes the transition and clears its capture request before setup. packages/transitions/test/custom.test.js checks both built-in and custom progress; test/gpu-browser.js destroys a real device, restores the same instance on a replacement and checks every output pixel. WebGL2 refusal now includes the required help link, with CPU and actual WebGL2 regressions. Resize history was already retained; its stale cancellation wording in the README is corrected. No new open defect is claimed closed beyond these tests.

### Fixed 2026-11-09: AMF real-file oracle ignored constellation placement

The zipped Slic3r box parsed correctly, but the proof compared its placed bounds (x 0.0575..0.0775 m)
with the object's unplaced XML coordinates. The independent AMF reference now applies elementary rotations and
translations through nested/root constellations, checking all coordinates and triangle indices. Its coordinate
bar stays 1e-6. Regression: packages/loaders/tests/amf-reference.test.js; translated and nested rotated builds.
The real zipped file and existing plain rook control pass. No AMF reader or renderer changed.

### Fixed: duplicate gate package-name prefixes

Cross-package value re-exports now compare the complete package name or a slash-delimited
entry. A distinct package sharing a name prefix can no longer evade the gate.
`tests/quality-gate.test.js` creates a TEMP fixture with cross-package, same-package,
subpath and type-only exports; its two runtime re-exports fail to be detected without
the boundary fix. The temporary WebGL bridge is gone, so no exception or budget is added.

### Batch 99 optional sky scope (2026-11-09)

The missing multiple-scattering/ozone/night environment in the voxel tracer is addressed by optional `/sky`,
using the existing sky model. Its generated native/compatibility value and lifecycle proof is recorded under
`docs/whitepaper/results/batch-99-sky-20261109.json`. This does not close the existing exact MagicaVoxel atmosphere
parity or moving-camera denoising defects. Stylized night, isotropic higher orders and the fixed-altitude distant
map are documented limits, not claims of astronomical or spectral reference accuracy.

### Open: nearly closed conservative Hillaire atmospheres

The existing raster Hillaire model accepts atmospheres whose geometric-series transfer rounds to one.
Repro: HillaireSky with atmosphere `{rayleigh:[1,1,1],mie:1,mieAbsorption:0,rayleighHeight:100000,
mieHeight:100000,groundAlbedo:[1,1,1]}` on Earth radii. A native GPU probe returns nonfinite radiance.
Cause: `packages/sky/src/atmosphere-luts.ts` computes `L2 / (1 - fms)`; in this opaque conservative domain
`fms` rounds to one and L2 underflows to zero. The model needs a numerically stable treatment beyond its
large-mean-free-path approximation; no epsilon clamp or scattering-order truncation was added. The new
environment bake rejects vertical scattering depth above 6 before allocating, keeping an upward-quarter
escape bound exp(-6 / 0.625) / 4 above Float32 subtraction error. This is an explicit bake domain limit,
not a repair of the pre-existing raster model. Regression: sky-environment.test.js checks the domain refusal.

### Fixed while building batch 76 job 2: mask addressing and bitmap usage

The new draft mask shader used interpolated UVs, whose rounding selected the adjacent texel at an exact boundary after an odd-size resize. The unchanged per-pixel oracle failed at pixel 0,1 in a 7x3 capture. It now uses integer centre mapping within explicit overflow-safe dimensions. The bitmap draft also lacked the RENDER_ATTACHMENT usage required by WebGPU external-image copies; both that usage and COPY_DST are now required by a unit regression and actual bitmap pixel proof. A reserved WGSL identifier found by the compile guard was corrected before delivery. packages/transitions/test/mask.test.js and test/gpu-browser.js retain these checks; no new open defect remains from these failures.

### Batch 68 BSP layouts

No open dungeon-generator defect is known after bounded-input, connectivity and ownership tests.
Generated grid proofs do not establish gameplay quality, 3D geometry or navigation clearance (LIM-628).
During rebase, prepending the dungeon asset ahead of another package split the procedural asset group.
The size page groups each package once, so registry order and rendered order differed. Dungeon and Poisson
records now stay adjacent; the unchanged lazy-row assertions in `tests/sizes-page.test.js` catch this class.

### Batch 56 ground composition audit

Job 1 reuses the existing projection and catcher with background order 0.25. No new defect was found
in the composition tests on WebGPU or the WebGL2 compatibility layer, including actual device
replacement. The uniform-blur catcher's physical-picture loss recorded under batch 168 remains open;
this audit does not infer HDR light directions or claim that loss is fixed. Native WebGL2 and Y-up
scope remain explicit limits. The generated box is a stand-in.

### Batch 76 job 3: live scene lifecycle

The previously open non-default-scene disposal defect was fixed separately in 1823a741e before this entry. Live transitions own a composite scene and remove it through the same identity-based owner lookup; borrowed scenes survive. Partial texture allocation failures release every created image and propagate the original error, with live.test.js regression coverage. New draft declarations initially omitted GPU constant types; the package build exposed them and the declarations were supplied before delivery. No open defect was found in the live GPU proof; its bounded RGBA8 behavior and resize sampling are limits rather than unproved HDR claims.

### Batch 160 anisotropy and iridescence picture residuals (open)

GPU-locked scripts/reference-rendering/run.mjs --case=anisotropy and --case=iridescence, each with and without --compat, reproduce the complete-scene measured budgets. Full residual causes are not isolated. Anisotropy retains all strength/roughness rows and labels. Iridescence retains all 346 primitives in its three-dimensional material/film-IOR/thickness grid; this direct-light camera contains overlapping spheres and sparse highlights, with no IBL. Margo uses its shared anisotropic GGX and thin-film implementation; the figures alone do not attribute the loss to a particular formula. Silhouette, tone-map and filtering differences remain included, and no small shader fix is claimed without an isolating regression.

### Batch 160 jobs 4 and 5: parked static-render variation (open)

Per Scott's manager ruling, job 4 is preserved locally as 97c74a713 on batch-160-job4-parked and job 5 as bfd887103 on batch-160-job5-parked. Neither is pushed as passing evidence. Original budgets remain unchanged: volume compatibility full-Cycles absolute error 13,792,003 exceeds 13,792,000; native IOR can measure 2,423,421 against its frozen 2,423,418. Volume varies at blue samples (213,199), (214,199), (219,199); IOR varies at RGB (403,299). The bounded shared investigation did not establish the root cause.

Repro on the job 5 branch: GPU-locked node scripts/reference-rendering/repeat.mjs --case=ior and the same command with --case=volume --compat. Each captures 24 static frames, waits for GPU completion before each read and asserts identical decoded bytes. Both fail; all pictures and repeat.json are retained outside engine-bench/batch-160. Fixed GPU command replays also vary with unchanged uploads and draw order, without compute dispatches or float atomics. Native stored multisample values vary before final resolve. Splitting, merging or instrumenting passes changes the observed output, so these interventions do not establish a package-owned API defect or an inherent backend rule. No workaround, bias or tolerance is substituted. Jobs 6 to 8 are independent measurements and do not close this release-blocking defect.

Dedicated continuation (2026-11-09): the variation now reproduces below Margo. Run GPU-locked
`node scripts/reference-rendering/blend-repeat.mjs --api=webgpu`, then `--api=webgl2`.
The page imports no engine or compatibility package. It clears RGBA8, draws fixed finite flat
tints with destination multiplication, draws zero with additive blending, then reads every byte
after completion. There are no sampled textures, PBR/volume/IBL/tone-map calculations, derivatives,
atomics, frame uniforms or uninitialised resources. All 1,280 fixture triangles remain.

On the RTX A6000 with NVIDIA 617.42 (Windows 32.0.16.1742), 400 frames across two fresh browser
processes produced 3 WebGPU hashes and 7 raw-WebGL2 hashes. WebGL dithering is disabled. The same
program through standalone Dawn Node 0.6.2 produces 2 D3D12 and 5 D3D11 hashes in 200 frames each,
with no validation errors. Exclusive GPU access retains the variation in a separate control.
On AMD RDNA 2 (32.0.21042.62), both raw browser APIs give one hash across 400 frames; NVIDIA's
one-sample controls also give one hash. Both complete reference scenes repeat identically on AMD.
Records, input/report hashes and reproduction commands are in
`whitepaper/results/batch-160-determinism.json` and `whitepaper/reproduce.md`.

This isolates an observed NVIDIA multisample-blend platform problem, rather than establishing
an owning Margo package defect. The closed driver/device mechanism is still unknown. A package
patch is not justified by this evidence. Quantizing source colours still varies; reducing MSAA
or substituting AMD would change the tested configuration. AMD's IOR error is 2,424,918, which
also exceeds the original NVIDIA budget. Fresh NVIDIA full-scene captures retain volume error
13,792,000..13,792,003 and IOR 2,423,418..2,423,421. Both original budgets remain frozen. The exact
repeat assertions deliberately fail on the affected platform; jobs 4/5 and batch 160 stay OPEN
until a platform repair or a proven package repair makes those assertions and budgets pass.

Rechecked after the main rebase to bfa1aabc6, including the native physical-sampler binding
repairs: 24 complete frames still give 2 IOR variants and 4 volume variants, with the same
error ranges above. The original parked jobs remain unchanged.

### Fixed: medium boundary offsets shortened physical transport (Batch 99)

Root cause: the voxel tracer used its 0.002-cell geometry offset as the next physical ray origin at
index-matched media boundaries. Three one-unit emitting cells in vacuum consequently produced 2.994
instead of 3. The physical origin now stays on the boundary; only the intersection query advances, and
its distance is restored before attenuation, free flight and emission. Main and refracted shadow walks
share the repair. Regression: packages/voxel-pathtracer/tests/media-boundary.html and media-browser.mjs.
Exact subsurface/glass/atmosphere parity and the existing moving-camera denoiser defects remain open.

The same regression covers a second cause exposed by the physical-origin repair: floor-only cell/brick
selection at a negative grazing boundary can repeatedly select the previous medium when the query
advance rounds away. The walk now selects the forward half-open interval for each direction. A
one-pixel two-material emissive path produced about 0.997 instead of 3.5 without this correction.

### Batch 160 job 7: environment furnace picture loss (open)

Repro: GPU-locked node scripts/reference-rendering/environment.mjs, then --compat, after fetching the pinned job 1 model and generating the Mitsuba references with --capture-reference. All 123 primitives, 528,291 vertices and 1,040,409 triangles are retained. Direct-only MAE is 2.9175326029459634 / 2.9175211588541665; full-transport MAE is 1.8851051330566406 / 1.8851038614908855 (WebGPU / compatibility). Every RGB pixel and silhouette counts.

Known structural causes: Margo's split-sum/SH IBL samples only the environment, so other scene geometry neither occludes it nor appears in reflections. Mitsuba traces geometric visibility in both references and up to eight vertices in the full reference. The direct-only image truncates continued surface paths at two vertices. Mitsuba principled maps the authored base/metal/rough parameters, but its BSDF is not a bit-exact glTF implementation. Margo's shared IBL approximations, finite 128-spp reference noise, different antialiasing and all-pixel silhouettes also remain in the metric. The constant-radiance case does not isolate their individual contributions or prove directional prefilter quality. No small package defect has been isolated, and this loss is not closed by recording a budget.

### Batch 160 job 8: Cornell clustered/shadow picture loss (open)

Repro: GPU-locked node scripts/reference-rendering/cornell.mjs, and --point, each with and without --compat; --capture-reference regenerates a hash-checked Mitsuba candidate. Both retain the existing batch 168 fifteen-quad/thirty-triangle scene, winding, Float32 parallelogram snap and three-band reflectance. No lightmap bake or indirect term is used. Directional shadowed MAE is 0.7214571634928385 on both backends; point shadowed MAE is 0.9285901387532552 / 0.9285939534505209 (native/compatibility). Unshadowed negative controls are 48.63041687011719 both and 7.642925262451172 / 7.642930348714192 respectively; their missing visibility is intentional configuration, not a closed renderer loss.

Known structural differences: default LocalShadows uses 512-square maps, 3x3 PCF, receiver bias 1 and normal bias 1.5 texels; Mitsuba uses hard ray visibility. Filtered edges, detached contacts and thin leakage along room/box edges remain visible, especially with directional light. The point path also applies its authored smooth finite-range window (clamp(1-(d/20)^4,0,1)^2) on top of inverse-square attenuation; Mitsuba's point emitter has no range window. These explain classes of residual without attributing every pixel. Different primary-ray sampling (128-spp box-filtered reference versus Margo MSAA) and finite reference noise remain included. No bias, map size, geometry or light was tuned to lower the frozen error. No isolated small package defect was found; contact/visibility fidelity remains an open loss.

### Batch 68 space colonisation

No open tree-generator defect is known after bounded-input, graph, reference and lifecycle tests.
Growth caps, disconnected attraction clouds and skeleton-only output are explicit limits (LIM-631).
The unchanged dense-crown work assertion exposed full scans of nearby grid cells. Conservative cell-box
pruning now reduces exact distance tests while preserving the exhaustive skeleton. A browser probe
also caught a local focused-build script that cleaned dist then copied only trees.wasm; the production
package build already copies every feature asset. Full package builds preserve all three lazy assets,
as checked by the production browser test. No test or tolerance was loosened.
Review also found that rounded distances can include a point across two grid cells at a radius
boundary (root -Number.MIN_VALUE and point 1 with radius 1). Guard cells now include that candidate;
the existing conservative box bound prunes safely. Native and exhaustive-reference JavaScript
regressions preserve the same distance rule, including negative/subnormal coordinates.
The shared Wasm loader also propagated raw file, network, response-body and ordinary compilation
failures, and a platform AbortError could replace the caller's cancellation reason. The owning loader
now preserves linked/CSP faults and exact abort reasons, and wraps other failures with code failed,
procedural help and the original cause. Seven loading regressions include four cases that fail on the
parent. The missing-file fixture uses a unique absent Windows TEMP path without writing into the checkout.

### Fixed in batch 56 job 2: contact-shadow scene ownership

Repro: put new ContactShadows or AccumulatedShadows in a non-default scene, with a same-name effect
in the default scene, then dispose the non-default effect. The old contact receiver called the engine's
default-scene removePlugin(name), removing the wrong effect and leaving its own registration behind.
Disposal now uses sceneOf(this).removePlugin(name). The accumulation unit test intercepts the wrong
default remover; the GPU test checks empty owner registration and a live default effect on WebGPU
and WebGL2 compatibility. This does not close the independent batch 168 physical contact-picture loss.

Coexistence repro: attach contact and accumulated shadows in the same scene. Both inherited passes
previously registered as contact-shadows, so the second attachment threw Invalid pass. Registration
now uses the plugin's name. CPU and real-GPU regressions attach both, render both and remove the
accumulator while retaining the contact effect.

### Corrected 2026-11-09: static USDZ subdivision documentation

The USDZ README said the default static reader loads subdivision cages. The owning reader
actually refuses subdivision and hole faces unless an optional entry handles them, as the
existing unsupported-feature regression in packages/usdz/tests/usdz.test.js requires. The
outside NormalsTextureBiasAndScale sample reproduced that documented-boundary mismatch.
The README now requires subdivisionScheme none; no parser, test or tolerance changed.
The introduction's missing compatible archive remains open in missing-test-items.md.

### Batch 56 studio rig reuse audit

Job 3 is SKIPPED implementation: environment/studio already supplies the four-box product rig.
The existing studio CPU/value GPU tests and new staging composition variant pass on WebGPU and
WebGL2 compatibility, including contact removal and actual replacement-device recovery. No new
defect was exposed by this scoped audit. Distant image lighting and native WebGL2 exclusion remain
documented limits; the independent batch 168 physical contact-shadow picture loss remains open.

### Batch 65 job 1 audit

Fixed during feature validation: extreme UV scales could return Infinity and narrow distant roads could return collapsed float32 faces. The entry now rejects both at the storage boundary. packages/road/test/junction-precision.test.js fails without these checks and passes with them. No open road-junction defect remains in the bounded planar contract. Graded junctions, curbs and overpasses are explicit design limits in limits.md, not implemented capabilities. Unit and GPU tests cover crossings, T junctions, a courtyard, hostile inputs, aborts, ownership, device reboot and disposal.

### Static USDZ README missing input resolved (2026-11-09)

The introduction's /model.usdz 404 is closed by an explicit alias to the complete
published Blender BoxTextured USDZ. The source/hash/licence live in the required
external manifest, now 353 inputs. tests/readme-assets.test.js fails before the
alias and asserts its exact bytes, topology, UVs and archived PNG. The original
browser example passes. The composition example remains open; no unsupported
input was accepted and no parser boundary changed.

### Batch 65 job 2 audit

Review 65 found a closed-road positional crack and discontinuous end normals, missed by the original finite/unit-normal checks. Fixed with periodic road tangent frames and shared end-row corner-angle normal accumulation, preserving curb edges and UV rows. review65.test.js checks the exact reported loop, variable periodic banks, a graded loop and mismatched-bank rejection. The same clamped-endpoint class was fixed in Spline.tangent, SplineFrames and the shared geometry sweep, with periodic.test.js and periodic-sweep.test.js regressions. No open defect remains from these findings. Tight-bend overlap remains outside this entry, as limits.md records. Analytic, hostile-input, abort, ownership and real backend lifecycle checks cover the contract.

Banking audit regression: input bounds alone missed a section rotated beyond the output coordinate limit. banking.test.js reproduced the missing rejection before the fix. banking.ts now validates transformed float32 positions too; the regression passes.

### Splat README input failures resolved (2026-11-09)

Four explicit format aliases close all four remaining splats exceptions; all 14
original examples execute. tests/readme-assets.test.js fails before the aliases,
then verifies four exact hashes, 8,385 points per file and every locally serialized
.splat position against the independent PLY. The stale skip-when-absent fixture
notice now documents the existing strict shared downloader. No codec/render defect
is hidden by a generic fallback, and no full-capture or encoder-accuracy claim follows.

### Batch 65 job 3: Terrain fit audit

Review 65 found interior holes with zero shoulder on an oblique road and terrain penetration through a banked driving surface under default curbs. Both are fixed: vertical BVH ray containment establishes the footprint and the lowest projected triangle height establishes the bed. review65.test.js checks the exact reported inputs, every strictly interior sampled grid vertex, signed banking, face reordering and depth. Earlier separate tests for banking and curbs did not establish their combined contract. No open defect remains from these findings. Heightfield only, no bridge/tunnel separation or overlapping elevation layers. Inputs within +/-1,000,000 m; up to one million vertices and one million faces; zero-XZ-area faces omitted from the heightfield projection; banked curb overlaps participate in the lower envelope. Zero-area projected faces ignored, at least one remaining face required. Shoulder 0..1000 m (default 2), bed depth 0..100 m (default 0). Existing terrain sampling resolution determines mesh accuracy. No excavation-volume or engineering-design claim.

### Batch 65 job 4: Self intersection repair audit

Review 65 found silent flattening when coarse repair chords missed a grade. Fixed by checking every cubic span at four raw-parameter values before tessellation, independently of chord count and the arc lookup. review65.test.js rejects the exact three-point hill at segments:1 and hidden Bezier/Hermite grades, as well as B-spline, Kochanek-Bartels and closed cases. The old monotonic-grade check did not establish this. No open defect remains from this finding. Constant-elevation XZ footprint only, no banked/graded/curb repair or overpass classification. Width defaults 6 m, in (0,1000]; 1..4095 arc-distance chords (default 128), at most 4096 samples. Junction coordinate, UV and snap-grid bounds apply. Curves are approximated by chords; raise segments for detail. Float32-collapsed boundaries and remaining inverted/zero-area output reject, never silently drop faces or holes.

Closed precision defect: a local 8 m wide hairpin previously rejected after two thin ears inverted on float32 conversion. junction-bends.test.js failed before the correction and passes after rounding boundaries before choosing diagonals. The final face/boundary guards remain in force.

### Batch 56 viewer period regression (resolved)

The viewer accepted finite subnormal turn periods but divided an unreduced elapsed angle by them,
producing Infinity and then NaN camera coordinates. stage/viewer now reduces elapsed time modulo
the period before division, bounding the trigonometric argument. Nonfinite resume delays reject
before loading instead of silently preventing resume forever. stage/tests/viewer.test.js proves both
regressions, finite extreme positive/negative periods and large deltas; the actual-device viewer test
keeps the real helmet visible at extreme periods. No core change or new stage feature.

### Batch 56 physical-map sampler overflow (resolved)

The real FlightHelmet lens uses a transmission factor with no extension maps. gltf-pro nevertheless
bound eight one-texel physical-map fallbacks, leaving too many fragment samplers after the
compatibility layer adds IBL, shadow texture loads/comparisons and a storage data texture. ANGLE
refused the program on its 16-unit device, and the viewer frame loop stopped. Native glTF physical
shaders and group 1 now omit absent extension slots, substituting their exact fallback constants.
Authored maps and custom hook resource contracts remain intact. Regression:
gltf-pro/tests/physical-map-renderer.test.js and the real stage-viewer-gpu-check.js --compat.

### Batch 56 direct GPU input validation (resolved)

The gltf-pro extension GPU harness looked only at MARGO_SPLAT_SAMPLES and returned successfully
when four sample families were absent, even when verify had validated the normal shared cache.
Each case now uses externalAssetRoot and requireExternalAssets. The root external-test-assets
regression, included in verify/check:merge, prevents optional-presence branches from returning.
Missing, partial, changed and LFS-only caches retain the helper's tested hard failures and recovery
command. No renderer change or new third-party input.

### Batch 56 framing reuse audit

The existing viewer meets job 4 without a duplicate entry. The discovered subnormal-period camera
overflow, absent physical-map sampler overflow and silent direct-GPU input returns are resolved
in their own fix commits and regression tests. The real-model whole frame survives actual device
replacement on native and compatibility backends. No additional framing defect was found.
The Y-axis orbit, one-time fit and native WebGL2 PBR refusal remain explicit limits.

### Fixed during batch 99 mixed triangle tracing

An ordinary projected-edge multiply/subtract could give inconsistent signs on adjoining triangles after backend arithmetic contraction. The compatibility regression exposed six missed pixels in a 16-by-16 small orthographic view, leaking sunlight through a complete panel and losing reflected emission. Canonical operand ordering alone did not resolve it. The owning mesh entry now filters uncertain determinants and recomputes their two exact significand products with integer limbs, then rounds their difference. mesh-browser.mjs retains the original zero-leak and exact-emission assertions and adds an independent cancellation-predicate oracle. No tolerance or scene-work requirement was reduced.

The optional mesh design limits are documented in its README and limits.md. They do not close batch 99's separate exact-parity or moving-camera denoising defects.

Mixed-tracer creation also redundantly rebuilt the already-copied voxel snapshot to check added storage. This misreported the first packing as reuse. The constructor now keeps its first snapshot; the existing pre-allocation device check validates the combined binding reserve. mesh.test.js requires one packed model and zero reused models on creation, and still rejects an oversized combined binding before GPU allocation.

### Resolved: decoder stream and Potree README input failures (2026-11-09)

The Draco introduction now serves Avocado's exact 8,722-byte compressed view with
its file-specific IDs 3/1/0. The SIMD snippet serves MeshoptCubeTest view 25 and uses
its real count 24, stride 12, ATTRIBUTES/NONE. Required aliases, exact source-byte
comparisons, independent SIMD output hash and a real Draco Wasm regression cover
the causes. Both browser snippets pass. No codec behavior changed.

Both original Potree snippets now run on the entire licensed 80-file external
lion_takanawa_normals folder, preserving all relative links. The alias regression
fails before mapping and refuses an absent node; the package test independently
compares all 341,989 coordinates and RGB values exactly across all 77 nodes.
All 18 points examples pass. Missing, changed or LFS-only files fail, never skip.

### Closed: decoder Node glTF README context and missing source (2026-11-09)

The Node example incorrectly constructed Engine with document.querySelector and
requested a nonexistent example.com model. It now installs the reader's Node WebGPU
binding on a headless canvas and loads the complete pinned CC0 FlightHelmet Basis
model with nodeKTX2. All 17 decoder examples execute. The GPU regression runs the
original setup/load in Node, checks all 15 textures and their 177 mip levels, all
55,392 vertices and 94,722 triangles, and reads back a visible model with zero GPU
validation errors. tests/readme-assets.test.js requires every resource's original
digest and refuses missing/changed bytes. The package README regression fails on
the old browser setup. Record: docs/whitepaper/results/readme-node-basis-20261109.json.

### Closed: README runner counted unfinished examples as passing (2026-11-09)

Both Node's killed-at-limit path and a page's unfinished import formerly returned
pass when no error had arrived. Every deadline now fails and the process tree or
page closes. Root regressions cover an unresolved Node program with live handles
and an unfinished page import without a reported page error. These tests run in
verify; no deadlines, test inputs or budgets were raised.

### Batch 65 job 5: Lane markings audit

No open defect found within the documented contract. Synchronous caller-owned decal descriptions, no GPU resources. At most 4096 output projectors, empty input returns empty output. Lines use one projector per dash; arrows use three strokes, with no regulatory-glyph claim. Positions within +/-1,000,000 m; positive length through 10000 m and width/depth through 1000 m; each projector half-extent must be a normal float32 value (at least 2^-126). Uses existing post/decals and a scene-depth capture, such as tonemap. Downward box projection can also paint other upward-facing surfaces inside the box. Box depth and camera/float32 precision set placement accuracy. Unlit over blending, no physical paint or retroreflection model.

Markings audit regression: positive subnormal dimensions could underflow when the existing decal renderer packs float32 half-extents. markings.test.js reproduced missing rejection before the fix. Each resulting projector half-extent must now be a normal float32 value (at least 2^-126); tiny representable dimensions remain accepted. No renderer tolerance changed.

### Batch 65 job 6: Road network graph audit

No open defect found within the documented contract. Explicit vertex topology only; at most 65536 vertices and 65536 roads, zero allowed. No geometric intersection detection, snapping, lane/turn restrictions, traffic simulation, live updates or OpenDRIVE parser. Split links at intended junctions; bridges remain distinct IDs. Parallel arcs retain the least travel time, losing road identity; remove closed roads and rebuild for changed traffic. Weights and solver sums are float32, with normal positive edge seconds from 2^-126 to 2^127/max(1,vertices); f32 rounding and generic compute/graph predecessor limitations apply. The bounded adapter reuses the existing graph builder and solver; no new CPU-heavy solver. Dispose graph, solver output arrays and caller-owned context separately. A graph bound to a lost device must be rebuilt with a new context after engine reboot.

### Batch 99 spectral transport evidence

The root tracer's documented unscaled-index convention and single dispersive wavelength are retained
there; the optional /spectral entry provides physical index-ratio transport, hero packets and chromatic
thin-lens power. Generated GPU regressions cover one interface, index cancellation across a closed
slab, a single collapse when lens and glass both disperse, and a finite-slab lens edge. The first edge
oracle incorrectly treated a solid slab as zero thickness; it now includes side-face visibility with
the original tolerance. Spectral material reconstruction and physical lens stacks are documented
scope limits, not proven capabilities. Existing parity and temporal-disocclusion defects remain open.

The initial optional spectral coverage pass left its wavelength at zero, so chromatic aperture rays
were nonfinite and an opaque emitter returned alpha zero. The pass now chooses a uniform wavelength
or the capture wavelength before generating each ray. The unchanged full-coverage GPU regression
fails with alpha [0] before the repair and requires alpha [1] for packet, 450, 587.6 and 650 nm captures.

### Batch 68 job 7 verification scope

No open defect identified in the rectangular building entry. Facade reconstruction,
general grammars and welded solid topology are explicitly outside its shell API;
the tested boundary and missing evidence are recorded in LIM-642.

Building reference checkout correction: Git text conversion changed the pinned
CityJSON bytes. The fixture now opts out of text conversion and its original bytes
are restored. Root procedural-standard-assets.test.js checks the attribute and
length/hash; the existing package test independently parses the actual asset.


### Closed: real-file PLY count oracle assumed float-only rows (2026-11-09)

The count oracle advanced four bytes per float vertex property and ignored color bytes; it also assumed one-byte face counts and 32-bit indices. The valid outside VTK horse reproduced a false face-data failure. The reference count walk now consumes every declared scalar/list width and element, with both-endian and malformed-body regressions in packages/loaders/tests/ply-outside.test.js. Every position, white color and index of the complete horse matches independent python-plyfile output. The production PLY reader needed no change.


### Closed: biome whole-world I/O recomputed unrelated and duplicate fields (2026-11-09)

The whole-world height exporter computed every climate/terrain field, weight exports classified every tile twice to obtain the two outputs of the same classifier, and I/O awaited tiles serially despite available workers. Height-only requests now sample their exact rectangle, weights and IDs travel together, and each export uses at most one outstanding job per worker. All output bytes and metadata of the complete default 4 km README workload match parent 349243b3d, including saved-world digests; its tile requests fall from 1,536 to 1,024. No sample, output, resolution or deadline changed. The 35-example biome runtime gate passes. Regression tests count requested cells/jobs, compare serial/worker outputs including edited/cropped tiles, and prove failure cleanup. Record: whitepaper/results/biomes-io-20261109.json. This is work/output evidence, not a published speed ratio.

### Batch 56 idle-still audit

No new open defect found. ProgressiveStill reuses the triangle integrator and its documented flat
static scene limits. Its Windows compatibility test uses ANGLE Vulkan; the inherited Direct3D
compiler problem is already tracked by the owning package. No new renderer or external source
was copied, and no general photographic-material fidelity is claimed.

The pre-attachment array lifetime across lazy loading was repaired before landing, with an
independent mutation regression including non-cloneable content-key identity. Planner fixture
assumptions were updated for the new real dependency, with stronger downstream/full-plan assertions.

### Batch 56 job 6 review

The contact receiver's native preview refusal lacked its help link; the new regression failed before repair and now checks the unsupported code and link. Malformed up directions also use linked argument errors. No open defect remains from the oriented receiver review. The first new GPU screenshot assertion exposed an invalid clearColor test option: the harness now uses scene.background, then proves the unchanged darkness assertion on white. No production threshold or tolerance was relaxed.

### Closed: GPU mutex reclaimed a paused live requester (2026-11-09)

Lane K's CPU-only reproduction paused a requester after mkdir(mutex), aged the
mutex past ten seconds and let another requester steal it; the original then
failed with ENOENT in retireMutex. Age was treated as proof of a crashed owner,
and the mutex had no published identity. The replacement atomically publishes
identity before exposing the mutex, refreshes its mtime independently for old
clients and reclaims only an identified dead owner. Reclamation claims metadata
at the pinned unique backing path, so a delayed reclaimer cannot touch a later
live owner. Regression: tests/gpu-lock-owner.test.js and
tests/gpu-lock-integration.test.js. No open entry for this defect exists on the
starting origin/main; this closure records the lane K finding and its repair.

### Closed: GPU mutex reuse collided with pending Windows deletion (2026-11-09)

The combined biome/loader runtime gate failed at mkdir(gpu.lock/mutex) with EPERM while other runs released the same reusable directory. Deleting the live mutex name left it unavailable while a Windows handle retained a pending deletion. Mutex release, stale reclamation and tidying now rename that directory to a unique retired name before deletion. Permission and cleanup errors still throw; no retry or suppressed error was added. tests/gpu-lock-mutex.test.js reproduces the original EPERM using a real Win32 delete-pending directory handle, then creates a new mutex while the retired one is still pending. Existing locking, legacy compatibility and limit tests remain required.

### Fixed before landing: batch 68 cave rejection ownership and proof teardown

Dimension validation also precedes grid-volume arithmetic. BigInt/Symbol dimensions
previously threw native coercion errors before the validator could issue its coded
error/help link. The hostile numeric test now covers both types for every option.

The new cave Wasm invalid-request header initially omitted its 16-byte allocation
length. A wrapper releasing that header would otherwise use the wrong layout.
Both valid and rejected results now report the exact size; caves.test.js and the
native kernel invalid-dimensions test assert it and release using the header.
The first cave browser diagnostic passed all values but used the shared teardown
helper with an array instead of its resource object, leaving the browser/server
open. Its owned process tree was ended. caves-browser.mjs now calls bounded
closeAll with browser and servers, then removes its temporary fixture directory.
The GPU gate must finish with exit zero, not merely print passing assertions.
No test, tolerance, size bar or time budget was loosened.

### Batch 56 reflective-floor audit repairs

The new real-product test exposed outer-view viewport leakage into reduced or first-frame resized captures. The fix saves/restores the view and sets the capture view before the MSAA target caches it; both failing regressions now pass. The unchanged independent mip bound exposed directional half-float blur bias; explicit loads plus nearest-half output rounding repair it, with exact boundary probes. The native planar-preview refusal now links its unsupported error. No open defect remains from this review and no tolerance was raised.

### Batch 56 mirror fixture canvas lifetime

The legacy mirror fixture read the presented canvas before its first lazy compatibility compute submission completed, producing a stale or black TAA reference. Moving that read after queue completion also failed: native WebGPU expires its canvas texture across the task boundary. The fixture now configures COPY_SRC, queues a texture-to-buffer copy in the render task, then maps the completed bytes, with BGRA conversion where needed. The unchanged 65 mirror, glass, cube, layer and TAA assertions pass on each backend at 1x and 4x MSAA. The regular environment mirror GPU script now runs both backends. No renderer defect or open fixture defect remains from this review.
### Corrected: one README GPU slot ran three browser workloads (2026-11-09)

The runtime runner held one GPU slot but concurrently created three page examples, each with its own renderer, workers and full deadline. The runner now completes and closes each page before starting the next, matching its single reserved slot. Node-only concurrency is unchanged. A deterministic lifecycle regression holds the first page open, proves no later page starts, checks every successful example completes, and checks that a failure stops scheduling. Workloads and the 20 s complete-page deadline are unchanged. This resource-accounting repair exposed the independent prefetch duplication below, repaired separately.

### Fixed: biome prefetch duplicates active streaming jobs (2026-11-09)

The unmodified default-world terrain-view README prefetch overlapped active streaming,
submitting 204 view and 190 placement jobs for 144 tile keys of each kind. Both paths now
subscribe to one raw generation per kind/tile/revision. Each subscriber cancels independently;
the last abort retires raw work immediately, edits detach old generations, and disposal cancels
even detached revisions. Revision checks prevent stale cache publication. A second cause found
by the regression was concurrent prefetch completions growing the cache beyond its existing
1,024-result bound; capacity is now checked at completion without removing any requested tile.
The full 4 km paired GPU proof retains every result field and typed-array SHA-256 for 292
unique keys while reducing jobs to 144/144. See whitepaper/results/biomes-prefetch-20261109.json.
The view fits the unchanged 10,454 B gzip ceiling by sharing abort composition and removing
duplicate disposal cancellation. packages/biomes/tests/view-prefetch.test.js covers both overlap
orders, independent/final abort, failure recovery, actual edited bytes, cache capacity and
queued/started/detached disposal. No deadline, extent, resolution or exception was changed.

### Closed: llms generator import required a CLI filename (2026-11-09)

Importing scripts/build-llms.mjs from node --input-type=module -e failed because its CLI guard passed absent process.argv[1] to pathToFileURL. The guard now checks that the filename exists before comparing it. tests/llms.test.js imports the actual module in a fresh eval process and checks both its exports and absence of CLI output; generation and --check remain unchanged.

### Resolved API/browser blockers: historical missing-items failures

At local checkpoint 5ee6138db, full verify executed 13,483 tests with zero skips; 13,480 passed.
The short-path API regression's full-report child hit its unchanged 280,000 ms hard deadline.
Repro: npm run verify, or node --test tests/api-report-short-path.test.js after building packages.
The finer cause is not isolated: later instrumented controls completed the same 885 reports and
8,627 exports in 46.7 s and 10.6 s. The correct short-path module trace counted 22,002 source-file
queries and 885 source-file-name queries; this identifies repeated work, not the earlier hang's
cause. A passing control is not treated as a repaired regression or a busy-machine exemption.

The same verify failed catalog.test.js during browser teardown; the registered biome prefetch
GPU proof later passed every byte/work assertion and failed during the same cleanup. Repro:
node --test tests/catalog.test.js or npm run test:gpu:prefetch --workspace @margoengine/biomes.
Both reached SHUTDOWN_TIMEOUT, still open: browser, at the unchanged 30,000 ms bound in
scripts/lib/browser.mjs's owned launchServer cleanup. An isolated public-API trace of client
close, native exit and driver kill completed in 1.93 s; the stalled substep in the original
failures is not yet attributed. Do not retry these gates as a substitute for identifying and
fixing that cause. Raw logs and tracing helpers are in this lane's test-results/missing-items.
These are active landing blockers handed off for continued investigation, not accepted limits.


### Missing-items continuation: repaired work and remaining timing blocker

The full API report repeated the same immutable snapshot file-list RPC for every
entry, then walked a package's global declarations again for every entry. This
multiplied whole-program metadata transfer and declaration work with entry count.
The script now lists the snapshot once and caches each package's ordered, deduplicated
global report. The actual Windows short-path CLI regression failed before repair
(886 requests instead of one) and passes after repair. All 886 reports / 8,631
exports remain identical; the scoped/full augmentations checks also pass (9 tests).
The query-count preload resolves the API from the actual CLI filename, since long
and 8.3 module identities differ. No public API or deadline changed. This repairs
proven repeated work; the original 280 s timeout is not attributed solely to it.
The instrumented full verification remains the required integration evidence.

Three effect ownership examples now release their previous owner before attaching
its replacement: shadows' explicit camera, quality's explicit shadow resolution,
and post's standalone-SMAA-to-stack sequence. The shadow replacement keeps both
casters. A strict execution regression fails on all three original examples and
passes with the repairs; 33 focused root tests pass. The known list removes those
three obsolete IDs (45 to 42). Full real README execution and all registered GPU
tests of shadows, quality and post are pending; no runtime pass is claimed yet.

The slow-send comparison completes 12 interleaved parent/current flights, two per
version in each of three rounds, using unchanged slowSends(2, 0.02) and the full
one-third default-world route. Parent/current per-round minimum maxima in ms:
3.0/2.5, 2.6/2.8, 2.4/2.5; parent round-to-round spread is 0.6 ms. These do not
establish a regression beyond the spread. CPU occupancy was 94.9 percent overall.
However, one current diagnostic maximum is 7.4 ms, over twice the 3.5 ms gate:
zero sends, one 16 kB write, 0.1 ms inside the real write. The remaining time has
not been attributed. Keep this open, not on the busy-exempt list, until its cause
is established. No workload, budget or timing assertion changed. Complete records:
whitepaper/results/biomes-slow-send-paired-20261109.json.


The continuation's full verify now passes both API gates (one list query) and
catalog teardown in this run, with 13,497 of 13,498 tests passing and zero skips.
The single failure exposed the prefetch proof's missing standard test entry. It
now uses tests/prefetch-check.mjs with runSuite/watchExit, exclusive acquisition
and its unchanged 300 s child bound; the documented script is a forwarding entry.
Chain, plan and exclusive-refusal regressions pass. The earlier browser teardown
defect remains owned by batch 160; a single passing catalog run is not its repair.


The GPU planner's exported plan() also failed when imported from eval: its CLI
guard converted absent argv[1] to a file URL. It now checks for the argument
before comparison. An actual eval-process regression fails before and passes
after repair, without starting a GPU suite. The package-GPU request expired in
the queue, not in a test; execution remains pending with per-test budgets intact.


Latest integration follow-up: full verify now passes 13,499/13,499 tests with
zero failures/skips. The API work repair, prefetch entry contract and GPU planner
import regression are included. The current short-path report finishes in 38.8 s
at its unchanged 280 s bound and performs one snapshot-list request. The API
integration blocker is satisfied. Browser teardown still awaits batch 160's actual
repair despite passing catalog controls. The 7.4 ms diagnostic frame remains an
open attribution task, not a busy exemption or accepted limit. Real README/GPU
validation remains queued. No dependent push has occurred.


Missing-items browser closure (2026-11-09): mainline 6ebbd1aa4 repairs the owned
Chromium pipe lifecycle with regression coverage. After rebasing, this lane
confirms catalog and full prefetch including teardown; no browser source was
changed here. Full verify passes 13,534/13,534 with zero skips. Both repaired
README groups and all 16 effect-package GPU scripts pass; runtime validation is
complete for this landing group. Earlier queued/blocker notes above are history.
The separate 7.4 ms flythrough attribution remains open and is next per the
coordinator; it is not a busy exemption. Durable results:
whitepaper/results/missing-items-landing-20261109.json.

### Fixed: test-page 44 bevel output validity

Repro: createPrimitiveMesh('cube', 'box'), extrude its last face by 0.3,
inset its first face by 0.25, then bevelPolygonMesh(mesh, 0.12). The generated
edge strips/caps can be nonplanar, so bevel's own final assertion fails.
A twice-extruded cylinder also exposes the centroid-based winding guess.
The repair triangulates invalid generated loops and follows half edges
for cap cycles/winding. Twelve persistent regressions pass; the first full gate
found an entry size overrun, now reduced to 30,180 B against unchanged 30,203 B.
All four required exporter/mesh-edit browser suites pass. The scoped README gate
exits successfully with 49/52 examples passing and three pre-existing known-list
failures, named in docs/testpage-bugs.md. After repairing the stale generated
research index, full verification without an outer GPU lock passes all 13,562
tests with zero failures or skips (721.2 s). The coordinator ended the preceding
run because it incorrectly held a GPU slot around verification; that ended run
is not a failed disposal repro. Browser teardown stays with its dedicated owner.


### Fixed: batch 160 mip argument duplication and sampler oracle

The draft mip interpolation expanded coordinate/gradient expressions in its LOD
formula, repeating private side effects; revisiting an argument could also consume
a discard hoist twice. The emitter now passes already-emitted argument values
into a sampling helper, where derivatives, hardware fallback and interpolation
read parameters. glsl.test.js fails before repair and checks implicit, bias,
explicit-level and gradient sampling, short-circuiting and discard hoists.
The mipArguments GPU fixture checks exact private call counts for both mip filters.
The native mip oracle now uses unfiltered loads and f32 arithmetic: the WebGPU
sampler spec permits implementation-dependent filtering, so NVIDIA's filtered
0.87499809265 was not an exact 0.875 oracle. All previous exact compatibility
assertions remain. GPU validation and the deliberately broken-weight control
remain pending; this entry does not close job 4 or the AMD cleanup/watchdog work.


### Batch 160 transmission and volume, job 4

The default native gltf-pro volume route precomputed attenuation at mesh
thickness, ignoring world scale and the refracted path. The package now
transforms a refracted unit ray into mesh space and crosses its estimated slab
there. Its regression executes the shipped WGSL across scale, obliquity, shear,
rotation, reflection, instancing and grazing limits. Compact replacement shaders
keep their own resource interface. Absent normal maps now use exact RGBA16F
[0.5,0.5,1] rather than the tilted RGBA8 [128,128,255] fallback; both fallback
and compact-shader ownership have regressions. No core or stage change.

Remaining picture residuals: run the complete TransmissionTest or AttenuationTest
with scripts/reference-rendering/proof.mjs, --case=transmission or --case=volume,
each with and without --compat. Original viewer and Cycles full/direct budgets
stay in the four frozen result JSONs. Full Cycles transport includes cast shadows
and bounce light absent from this default unshadowed Margo scene. The combined
control removes both; it does not attribute the entire residual to shadows.
Rough refraction, filtering, mesh-boundary versus slab paths and reference noise
remain mixed causes. No physical-equivalence claim is made. Native thickness
textures remain unsupported by this route. Extreme precomputed Beer tint can
underflow before an inverse world scale shortens the path; raw extinction
storage is needed to recover that numerical range. These are open limitations,
not accepted proof that the renderers are equivalent.

NVIDIA 617.42 and Intel Arc 4x MSAA blending variation remains the documented
driver defect. AMD Radeon(TM) Graphics / RDNA 2, driver 32.0.21042.62, is the
proof adapter required by Scott. Fresh three-process proofs follow teardown
fixes cf699846f/20375ea56; neither an old failed cleanup nor an archived capture
counts as that fresh proof. Browser teardown remains with its dedicated owner.


### Batch 160 AMD voxel denoise watchdog (open, separate from jobs 4/5)

Repro: select MARGO_GPU=amd, GPU_POWER=low-power and render the unchanged
voxel-pathtracer denoise-materials reference: 480 x 300, 16,384 spp. Earlier
bounded diagnostics, including 4 x 480 x 300 x 7 pixel-samples and dispatch
drain, reset AMD in 4,064/4,068 ms with LiveKernelEvent 141. WER reports
WATCHDOG-20261109-{0950,0952,0959}.dmp are retained outside the repository.
The original package failure is test-results/batch-160/job4-material-gpu.log.
No out-of-bounds access, nontermination or driver fault is established.
DXGI reports AMD packet-boundary and NVIDIA dispatch-boundary compute preemption.
The current radiance loop is bounded by 20 * maxBounces + 32, up to 1,312
steps, each including scene/material work. A bound on pixel-samples alone does
not bound traversal cost or prove a preemptible OS packet. Reducing the work
or retrying the driver reset does not repair this. The earlier row-band draft
passes CPU sample-group/PNG-seam tests but still reset the GPU and is excluded.
Next isolate packet submission and per-ray termination/access invariants in one
bounded diagnostic, preserving every pixel/sample and accumulation order.
This remains an engine bug pending attribution, and is not a speed exemption.
No new watchdog repro was run by the job 4 continuation.

### Fixed: guiding README blocked module initialization (Batch 99)

Repro: run the caustic-guiding README example with the shader disk cache disabled.
The original top-level await of tracer.ready can outlast the unchanged 20-second
module-completion limit. A diagnostic reaches readiness with only the trace
pipeline unresolved, all auxiliary pipelines finished, and no GPU errors; the
off-screen capture has not begun. This is an initialization dependency, not a
transport failure or a busy-machine timing exemption.

The example now starts the existing progressive viewport and disposes on pagehide.
The new controlled-promise regression fails on the old example and verifies the
preview-to-tracing lifecycle on the replacement. A real cold-module diagnostic
passes with the unchanged deadline. Scoped landing checks pass, including all 9 runtime README examples;
the history-tap repair remains separately preserved and must land afterward.

### Fixed: physical-camera README shares one HDR capture (2026-11-09)

The exposure example attached DOF and Tonemap as independent scene capturers,
then attempted another PostStack. It now constructs the effects unattached and
joins one [DOF, MotionBlur, Tonemap] stack. TAA reads its shared depth, and
engine.start renders the configured picture. tests/readme-physical-camera.test.js
fails before the repair and verifies the single capture, TAA depth/velocity
and physical exposure targets after it. The obsolete runtime exception is removed.

Landing checks after GPU queue repairs b7af6646a and d2e8310ef: the sole failed
verify unit-test step was resumed, with 13,612 of 13,613 tests passing and zero
skips. Its only failure was an unavailable private-file pointer inherited in the
GPU lock report. Rewording that pointer passes the existing no-private-paths
regression; the queue FIFO and bootstrap regressions pass. Earlier lint, hygiene,
API, quality, types, size and proofs passed. Camera tests pass all 83 cases.
One shared GPU slot then passed the camera browser suite (10.1 s) and all nine
executable README examples, zero failures (28.9 s combined supervisor).
No camera runtime, assets, exports, core/stage or held physics source changes.
Evidence: test-results/skip-gaps/camera-resume-*.log. Browser teardown and queue
repairs were inherited from main; no assertion or budget was relaxed.

Research: Paul Haeberli and Kurt Akeley, The Accumulation Buffer: Hardware Support
for High-Quality Rendering, SIGGRAPH 1990,
https://graphics.stanford.edu/courses/cs248-06/haeberli-akeley-accumulation-buffer-sig90.pdf;
Craig Kolb, Don Mitchell and Pat Hanrahan, A Realistic Camera Model for Computer
Graphics, SIGGRAPH 1995, https://graphics.stanford.edu/papers/camera/; W3C GPU for
the Web Working Group, WebGPU, 2026, https://www.w3.org/TR/webgpu/.
Sampling and optical exposure are separate concerns; the attachment/resource
rules support sharing the existing PostStack capture. No foreign code was read.

### Fixed: media README blocked module initialization (Batch 99)

The media example exceeded the unchanged 20-second module-completion deadline in
the full README run. Startup awaited full pipeline readiness and an off-screen
capture before any viewport loop. Two later instrumented runs finish within the
deadline; neither reproduces the original timeout. In those runs trace compilation
dominates while capture completes in about 20 ms. The controlled-promise regression
fails the original initialization dependency. The replacement starts the actual
media viewport and retains the same awaited 16-sample float capture on a button.
Capture errors propagate; pagehide disposes tracer, engine and button. Evidence:
whitepaper/results/batch-99-media-readme-startup-20261109.json. No new compilation
latency guarantee, timing exemption or smaller rendering workload is claimed.

### Fixed: viewport denoiser admitted rejected history taps (Batch 99)

The prepare kernel's four-bit surface mask was used only as a nonzero test in
combine, so one surviving tap admitted all four colors and history weights.
Combine now excludes each rejected tap before loading it and normalizes the
remaining bilinear weights. The corrected finite-ray baseline failed 112 of 448
cases, exactly the partial-mask cases with live history; all controls passed.
The repair passes all 448 on native WebGPU and WebGL2 compatibility, on first and
replacement devices, plus the unchanged moving-camera denoisehistory oracle.
Repro: voxel-pathtracer's test:gpu:history-taps. Evidence:
whitepaper/results/batch-99-history-taps-20261109.json. Earlier local probes used
invalid zero rays and do not establish the bug. Noise-free camera moves, newly
visible surfaces and the requested optional /denoise entry remain open above.

### Fixed: WebGL2 README waited for tracing before starting (Batch 99)

The history landing README run failed at the unchanged 20-second module-completion limit in the compatibility example. Its top-level await of tracer.ready preceded any engine.start call. The example now starts the progressive viewport and disposes both owners on pagehide. A controlled unresolved-trace regression fails the original initialization assertion and passes the replacement, including install-before-create, preview dispatch, eventual tracing and disposal. The README runner prefers native WebGPU when available; this failure alone is not WebGL2 shader-compilation evidence. All 9 runtime README examples now pass; the 448-case history test separately covers WebGL2.

### Fixed: sky README waited for tracing before starting (Batch 99)

After the compatibility example repair, the runtime README gate reached the sky example and hit the unchanged 20-second module-completion limit. The isolated cache-disabled diagnostic completed: the sky bake finished before attach, while trace compilation took most of initialization. This did not reproduce the full-run deadline failure. The example nevertheless awaited full readiness before its sole render call. A controlled unresolved-trace regression fails that initialization dependency and passes with the existing progressive loop, eventual tracing and pagehide disposal. All 9 runtime README examples now pass with the unchanged 20-second module limit.

### Skip-audit item 5: complete executable examples (2026-11-09)

PixelCamera now shows smooth: true with fractional movement; tonemap points to
PhysicalCamera, and creative points to grass interaction and terrain chunks/LOD.
The first tonemap example also supplied no grade.cube asset. It now contains
a complete 2x2x2 identity Cube, with no fetch or new parser behavior. The actual
README regression fails before the repair and passes with exact identity samples,
LUT clearing and both owners disposed. Research: docs/work-lists/skip-gaps-research.md.
Landing: lint and hygiene pass; full verify passes 13,637 tests with no failures
or skips (287.1 s), and all 130 package CPU cases pass. One shared GPU slot
passes all ten package GPU suites and all 19 executable README examples with
zero exceptions (59.5 s combined). No size ceiling, runtime or export changed.
The earlier recording-enabled verify attempt was interrupted during shadow-cache
bookkeeping before its test chains; the complete successful run disabled only
shadow recording, never checks or result work. Evidence: test-results/skip-gaps/item5-*.log.

### Batched picking historical loss and pending GPU confirmation (batch 108 job 2)

The 83 ms batch versus three's 67 ms WebGL loop in perf history 60 was not
classified. It is a loss, not an accepted difference. The previous source performed
four matrix-product rows for every micro-frustum sphere test, even when the
first pair of planes rejects it, and checks a captured scene per point.
Selection now evaluates rows lazily with identical arithmetic, and validates
and submits a captured batch once. Both directed regressions fail on the parent
and pass on the repair (`packages/selection/test/picking.test.js`). GPU point-by-point equivalence now passes; the quiet elapsed-time comparison
remains deferred. No speed win or full timing closure follows from CPU counts.

### Batched picking pre-rebase validation (2026-11-09)

Lint, hygiene, API, quality, proofs and full verify pass: 13,669 tests, zero
failures or skips (440.5 s supervisor). All 83 selection CPU cases pass. One
shared GPU slot passes picking, all three captured/MSAA/micro batch comparisons,
real-model perspective/orthographic checks and x-ray, plus all six executable
README examples (36.9 s combined). No --time loop or benchmark was run.
The historical 83 vs 67 ms remains an open loss for the deferred speed phase.
Fresh genuine entry/network records share commit 1d7571281 and dirty=false;
the actual basic scene fetches five requests and no extra file. API generation
follows measurement. Selection is 20,808 B gzip, previously 20,745 B (+63),
below its unchanged ceiling; core + stage stays 23,924 B under 25,000 B.
The short network capture now explicitly limits its shared hold to one minute
and waits at least 60 minutes, with the existing regression expanded.
Evidence: test-results/skip-gaps/item3-*.log; research in skip-gaps-research.md.

Final main rebase: inherited preview error-link and compatibility changes. Rebuilt
all packages and regenerated genuine entry/network records together from
375b56d0b, dirty=false, then API and llms. Lint, hygiene, API, all 83 selection
cases and 21 record/document regressions pass. The fresh shared-slot selection
GPU suite and all six README examples pass (20.2 s combined); the GPU suite
includes captured/MSAA/micro counts and real-model perspective/orthographic
equivalence. Earlier full verify remains the 13,669-test pre-rebase result; no
second full verify or timing benchmark is claimed. Current selection: 20,833 B
gzip under unchanged 21,142 B ceiling; upstream before our change: 20,772 B.
Core + stage remains 23,924 B. Logs: item3-rebased-*.log.

### Physics hold: batch 101 job 2, non-square tile collider merging

Repro: a TileMapSource layer containing adjacent slope or half-tile collision
shapes passed to `tileMapColliders` produces one collider per shape, rather
than merged runs. Cause: packages/physics2d/src/tilemap.ts collects whole-cell
solid squares into mergeable grids and emits all other shapes independently.
Scott's skip-gaps brief explicitly holds physics work. This gap remains open;
no physics source or tests are changed. Batch 17 job 3's mixed core/package
render-pass hook separately awaits Scott's approval for a core change.

### Closed: grass height interaction (batch 77)

Cause: interact.ts packed only interactor X/Z, radius and strength, and never
read its height or the placement heightmap. A blast above terrain could stamp
the same field as a ground blast. The interaction pass now retains XYZ and
samples the same validated texture and rectangle as placement. CPU upload,
texture replacement and single-snapshot regressions pass and fail on the parent.
The real-GPU regression checks every field cell against a 3D distance oracle,
explicit and implicit texture rectangles, terrain Y offset, airborne explosions
and ground effects; all pass on the real GPU in a shared slot. No tolerance
or behavioral bar is relaxed. The README documents one-frame explosions and
contains a complete terrain chunks/LOD example.

Item 4 final proof: all ten registered scatter GPU suites and all 14 README
examples pass in one shared slot (70.2 s combined). The package CPU regressions,
lint and hygiene pass. Entry and basic-scene records genuinely measure
419b34508 with dirty=true, the same source state; five network requests, no extra
files. API generation follows measurement. Completed full verify evidence is
retained from the earlier continuation; no extra full verify or timing loop ran.
Logs: test-results/skip-gaps/item4-*.log; sources: skip-gaps-research.md.

Final rebase inherited only the independent voxel-pathtracer glass correction.
Scatter sources and passing proof inputs are unchanged. Its changed package was
rebuilt and the paired entry/network records regenerated from 21ff80d28,
dirty=false; scatter/interact stays 3345 B and core + stage 23924 B.
The pre-rebase GPU/README proof above remains the scatter execution evidence.

### Closed: ordered erosion production packaging

Repro: build a Vite app importing biomes/erosion-wasm from the saved chain. The
manifest omitted its export and copy-erosion build step, so resolution failed
before loading the module. Restored both registrations; the new
packages/biomes/tests/erosion-bundle.test.js fails before and passes afterward,
checking separate emission and exact asset bytes. The real production browser
checks lazy loading and all crop fields on WebGPU/WebGL2 pages; both pass.

Item 1 final proof: 477 package CPU tests, lint, hygiene and focused metadata
checks pass. All eight existing biomes GPU suites, the new production erosion
browser proof, all 36 biomes README examples and all three umbrella examples
pass. A combined five-minute lease interrupted flythrough after three completed
suites; the orchestration was split, completed suites preserved, and only the
interrupted/pending steps ran. Flythrough passes in 243.2 s; no assertion or
package deadline was changed. This is gate duration, not a speed claim.
Earlier complete verify passed 13,585 tests with zero failures/skips
(repair-api-fullverify.log). No extra full verify ran in this continuation.
Final main rebase inherits unrelated diagnostics and documentation; erosion
source/Wasm and proof inputs stay unchanged. Packages are rebuilt, with genuine
paired entry/network records from 604f09866, dirty=false, then generated API.
Logs: test-results/skip-gaps/item1-*.log; no benchmark or timing-only run.

### Fixed 2026-11-10: splitTRS named results and non-finite failures

The optional math/quat API had been made positional to save bytes. It now returns
an ok-discriminated object with named position/rotation/scale or reason; all six
callers are migrated. The singular contract also missed infinite column lengths
and infinite determinant overflow, returning success with NaN rotation values.
Explicit finite checks fix that cause before normalization. Regressions and
sources: [size restoration](size-restore.md#named-matrix-decomposition-audit-finding-6).

### Fixed 2026-11-10: narrowed package builds lost transitive ordering

Repro: select math, gltf-pro and rigging in build-modern --only while leaving the
intervening animator/animation packages prebuilt. Direct-edge-only scheduling
could compile rigging while gltf-pro replaced declarations, causing unknown/any
model-node errors. package-order now retains paths through unselected packages.
The regression lists the consumer before the provider at one and three jobs:
tests/package-order.test.js. No retries or declaration/type relaxations.

### Batch 273 lower-tier validation remains open

Full-tier KTX2 streaming follow-up after rebase onto 4e5dbdf04: the unchanged
first streaming comparison still fails. The diagnostic reaches level 0 with
all 11 levels resident (5,592,404 GPU bytes) and measures one differing green
channel, 89 versus 88 at (208,137). A repeat screenshot of the unchanged plain
model also differs; a matching streamed/plain pair in that diagnostic does not
prove a repair. Residency alone does not explain the failure. Capture/render
reproducibility and the actual cause remain unresolved. Receipts:
test-results/batch-273-ktx2-repro.log, batch-273-ktx2-probe.log and
batch-273-ktx2-repeat-probe.log. No runtime or assertion was changed.

Full-tier culling failure follow-up on b30aaa010: with MARGO_COMPAT=1,
packages/culling/test/gpu/dynamic-check.mjs still fails at shadowed step 2
(move every third box), exactly seven pixels differing by one channel unit on
RTX A6000 / ANGLE Direct3D 11. The original strict assertion is unchanged.
In a full-sequence diagnostic the two depth arrays are bit-identical and their
shadow matrices, uniform values and camera matrices match. This narrows the
investigation but does not establish a cause or even independently prove populated
depth maps. Adding invariant position outputs to both caster shaders leaves the
same seven differences, so that hypothesis is rejected. A shorter isolated test
passes without the change and is not accepted as repair evidence. Instrumenting
the sequence can instead expose three differing pixels in the unshadowed move
sequence; readiness and render/capture state remain unresolved. No runtime repair
or closure is claimed. Local investigation logs are batch-273-compat-culling-repro-real,
batch-273-culling-full-invariance and batch-273-culling-state-corrected under
test-results; the clean-room section records the primary research. The prepared
culling-causes script, separately owned teardown and voxel tracer are untouched.

The new optional tiers policy is not yet a completed parity row. Repro for the repaired
copy class: on an LDR device, create two rgba32float textures, one
sample-only (COPY_SRC | COPY_DST | TEXTURE_BINDING) and one additionally used as
RENDER_ATTACHMENT, then copy between them. Their logical formats match but their
physical formats differ. The existing copy path compares logical format internals
and previously attempted an invalid framebuffer blit or attached unrenderable float storage.
The owner is webgl2-compat/src/device/render.ts copyTextureToTexture and its
format-view synchronization. The repair uses a counted synchronous bit-fetch and upload for incompatible physical
storage, including view synchronization. Exact GPU regressions pass both copy
directions and all six sample-only cube faces plus a 2D face view on all three tiers.
No sample-only precision is lost and no GL error is suppressed.
Package-wide lower-tier image comparisons and tested attach-time requirements are
still pending beyond the seven new package scenes. The LDR Bloom/Tonemap stack's
HDR capture was clamped before display conversion, exceeding the existing parity
rule (5.322265625 percent over 2, mean 2.09423828125, maximum 6). The owning
PostStack now refuses HDR/display stages on LDR at setup and after device restore;
its CPU regressions verify no partial attachment/allocation, resource release,
and continued half-float and LDR-only support. Standalone Bloom and SSAO now have
the same measured refusal: their LDR images exceed the rule by 5.322265625 percent
over 2 / mean 1.685546875 / maximum 7, and 14.1357421875 percent over 2 /
mean 8.579345703125 / maximum 108 respectively. Half-float passes (SSAO maximum 1,
mean 0.008544921875); LDR-only FXAA is pixel-identical. Their resource-owning
initializers now refuse LDR before allocation and after releasing old resources
on restore; tests include SSAO's GTAO subclass in its real PostStack.
Other standalone HDR effects and other
package entries still need their measured requirement checks.
The brief's separate full-tier compatibility failures remain in scope;
the voxel-pathtracer D3D11 hang has a separate owner and was not investigated here.

### Batch 273 tooling observation: verify import from eval

Repro: node --input-type=module -e "import('./scripts/verify.mjs')".
The exported verify plan cannot be imported from an eval entry: its final CLI
guard passes undefined process.argv[1] to pathToFileURL. The same import from a
normal .mjs file works. Root cause is scripts/verify.mjs's unguarded CLI-entry
comparison, outside this package lane's edit scope. The batch resumes verify's
exported unit-test command from an owned .mjs runner with the same work and bounds.
The tooling owner should guard the missing argument and add an eval-import
regression; no exception is suppressed here.

New-tier creation now accepts AbortSignal with tested pre-abort, pending-wait,
listener cleanup and concurrent ownership semantics. A cancelled native-adapter
probe cannot install when its native request eventually settles. A second probe
also preserves an installation completed by another caller while it waited; the
old implementation could overwrite that owner's restore chain. CPU regressions
cover both interleavings. The selected-minimum refusal diagnostic names the missing
half-float extension rather than the full-tier extension and changes no globals.

### Fixed: batch 56 finite studio direction

The review direction [MAX_VALUE, MAX_VALUE, 0] overflowed Math.hypot and
normalized to zero. Scaling by the largest absolute component first preserves
its direction. studio.test.js compares all texels with [1, 1, 0], including
subnormal input. No assertion or tolerance is weakened.


### Fixed: temporal effect owner detachment (batch 56 sibling audit)

Explicit TAA/TAAUpscale disposal called removePlugin on the active default scene after setup had returned. With matching names it disposed the unrelated default effect and left the secondary effect registered. Both classes now detach through sceneOf(this). The scene-owner regression uses real engine scene registries, asserts same-name isolation, and permits replacement after repeated disposal.

### Fixed 2026-11-09: uniform-only light normalize shaded identical frames differently

Symptom: on the WebGL2 compatibility layer (ANGLE D3D11, NVIDIA RTX A6000) a refractor capture
differed from an identical earlier capture in 24 components by 2^-12 (packages/environment/tests/
capture-stability-browser.mjs). It appeared only while other work loaded the GPU, at 1x and 4x
alike, unrelated to the clip plane or the resolve. Cause: core's lighting shader computed
`normalize(frame.light.xyz)`, an expression of uniforms only. Under GPU load the driver path
evaluated it to one of two values an ulp apart, so nl and the half vector moved by an ulp in
every pixel and some components rounded to a different binary16 value. Probes showed the
interpolated position, normal, colour, eye and raw light bytes stable, the uniform-only
normalize flipping, and the same normalize made per-pixel stable. Fix: core writes the unit
direction, normalized once on the CPU in float64 and rounded to float32, into frame.light, and
no shader normalizes a light or sun uniform any more. Every package that writes the engine light
into its own uniform (animation, creative, culling, environment probes, gltf-pro, lod, post,
scatter, selection, terrain, voxel, water, weather, xr) goes through shared/unit-light.js; lens
flare and creative god rays normalize their sun option the same way. Regressions:
packages/core/tests/unit-light.test.js (upload values, and a scan that fails on a normalize or
length of a light, sun or light-record direction uniform, or on a raw frame write of
`lighting.direction`) and the capture test with `--compat --gpu-load=3000`, each capture in its
own page task: the old shader fails it (pair 0, the same 24 components, 2^-12) and the fix
passes 12 of 12 pairs at the exact-zero bar.

### Batch 56 remaining terrain disposal repair

The seven remaining terrain EnginePlugin classes retained their secondary
scene registrations on direct disposal and could remove default-scene names.
Each now detaches through sceneOf(this). The 14-case real-engine regression
fails seven direct cases on the prior build; all 14 pass after repair. Stream
owns and disposes its terrain; blend and sculpt retain their borrowed inputs.
The expanded class guard covers all 11 terrain plugins. Package units pass
107/107 and the four terrain/shader source guards pass. GPU/README acceptance
is pending in one shared queue. Wider owners and hunter acceptance stay open.

The inherited terrain sequence completed all 15 GPU commands successfully.
Its README gate passed 14/15, failing WebGPU acquisition during confirmed
NVIDIA event 153, not a numerical assertion. Logs and event XML remain in
 test-results/56fix (terrain-readme-reset-event.xml). No repeat of a passed
step was started before the new source change; the changed package requires
its own complete GPU/README sequence.

### Batch 56 ComputeFrame registration repair

Repro: register a new ComputeFrame in a secondary scene, register a same-name
default sentinel, then call frame.dispose(). Its arrays were freed but its
registration remained; the default sentinel was removed. The frame entry now
resolves sceneOf(this). Its direct-disposal regression fails before repair and
both direct and owner-removal cases pass after repair. Package units pass
111/111. GPU/README acceptance and the wider audit remain pending.

### Compute correctness gate ran deferred benchmarks

Cause: the core, extras, CPU-parity and autotune browser modules embedded
throughput/calibration blocks without reading scripts/speed-phase.json. The
runner now forwards the central phase and every benchmark clock/calibration
is gated. All original speed cases and assertions remain in the named release
suite. Every correctness callback remains live, with full-output direct GPU
checks for all original SAXPY/grid candidates and unchanged own-kernel cases.
The new source/policy regression fails on the parent; current regressions pass.
No benchmark was executed to diagnose or prove this repair.

### Batch 56 continuation acceptance snapshot (2026-11-09)

All 11 terrain owner repairs pass 107 units, all 15 package GPU commands and
16 runtime README examples. ComputeFrame passes 111 compute units, the focused
native/compatibility dispatch/owner proof and the complete 132-check browser
suite (413 shader modules, no errors). All 21 compute README examples run.
Throughput/calibration measurements are deferred; correctness candidates remain
live. The 24 focused metadata/source/policy tests pass, as do lint (120 existing
warnings), hygiene, all five quality gates/974 entry ceilings, 1,134 README type
examples and API update (891 entries/8,651 exports). Core plus stage remains
23,924 B; no new ceiling is raised. These are local results, not landing or
combined hunter acceptance. Full verify remains the inherited result recorded
in the [gate receipt](whitepaper/results/batch-56-owner-gates-20261109.json); no second full verify ran.

### Batch 56 authorized partial landing

The coordinator lifted the push hold for the five review repairs and the proven
owner/compute fixes. The intentionally failing capture-stability regression is
retained as the final local commit on batch-56-fixes and is excluded from main,
including its package-script wiring. The capture-msaa-hunt branch later landed
that regression with the root-cause fix (see the fixed uniform-only light entry).
The wider owner audit remains open. The post-rebase receipt records the checks
affected by merged documentation, API metadata and GPU-lock tooling; the unchanged
package execution proofs and historical full verify are retained honestly.

### Fixed 2026-11-10: installed Unity support lost comments and source layout

The generator compacted canonical C# before delivery and rejected interpolated
strings to satisfy its partial lexer. Embed canonical source verbatim instead
and remove the compactor. Regression compares every embedded/delivered byte and
manifest digest to its source; an isolated generator fixture preserves modern
string syntax and comments. See [size restoration](size-restore.md).

### Fixed: ComputeFrame browser regression missing from its package plan

The tracked scene-owner-browser.mjs had no package script, so GPU plan validation
threw before selecting any package. Compute now registers test:gpu:owners;
packages/compute/tests/gpu-registration.test.js pins the real command. Native
and WebGL2 compatibility run the original assertions successfully.

## Batch 234 FFT ocean validation

The new optional ocean's initial reserved WGSL buffer identifier was caught
by its physical shader-compilation test and corrected before landing. The
same test must pass on native WebGPU and full WebGL2 compatibility; numerical
and lifecycle evidence is tracked in [water-fft.md](water-fft.md). No runtime
defect is accepted by this record.

Review also found that snapshot metadata returned authored binary64 height and
lengths instead of the uploaded binary32 values (100000.1 differed by 1.5625 mm).
The owning FFT entry now reports the actual GPU height, lengths and evaluated
time. The strict unit regression failed before the correction; both GPU
backends also check nonexact decimal metadata. The new attachment error now
links to the existing state help entry; its regression rejects the broken link.
Batch 273 full materials follow-up: resolved by the batch-201 owning gltf-pro repair.
The composed worst-case and transmissive pipelines previously spent all 16 fragment
units on material/effect sampled textures, leaving no units for compatibility storage
and depth load/comparison aliases. High-resource native glTF physical/extended
permutations now pack five base maps into RGBA32F layers, retaining source texels,
logical dimensions, mip chains and independent sampler/UV state. The unchanged
materials GPU check passes on both backends; 360-case continuous sampler oracles
and all-map/lifecycle CPU regressions cover the representation. Custom hook resource
contracts remain separate. Allocation and native interpolation differences are in limits.md.

Batch 273 LOD imposter isolation: a diagnostic preserving the full picking grid
advances through successive rows after readiness. The original report's timeout
does not establish a permanently stuck initial await. The optional GPU/CPU
wall-clock loops were removed from this diagnostic before running; all pixel
positions and CPU/GPU comparison work remain. Per-pick render/readback and CPU
cost are not yet isolated. Receipt: test-results/batch-273-lod-picking-probe.log;
its run is bounded at 3.5 minutes under the shared GPU lock. No repair claimed.

Batch 273 resolved vertex-input fixture: the fixture instrumented native
GPUDevice.prototype, which full compatibility does not inherit. It now observes
the engine device itself, preserving the original method receiver. The canonical
leaf explicitly runs both backends, and the existing exact regression retains
all input counts and image assertions. Forced compatibility fails before the
repair (`inputs fetched` is empty), while native and compatibility each pass
with 47,234 lit pixels and zero differing pixels afterwards. No renderer change.

Batch 273 resolved inherited compute gate registration: scene-owner-browser.mjs
had no GPU package script, so plan() rejected it. A dedicated script and planner
regression now cover it. Its four render calls are documented as the exact
four-dispatch value oracle, not a readiness wait. The native baseline explicitly
disables the outer shim before the second case installs compatibility. All
1,024 values and owner/disposal assertions pass both backends; 133 tests in
the nine failed planner/scanner files pass after repair. The original full
verify failure and the invalid README run overlapping a rebuild are retained.
A sequenced materials README run passes 29/29 after the build completes.

Final batch 273 rebase inherits compute registration 39fb88cf9 and keeps its
single test:gpu:owners script and regression. The inherited tracer compose
fixture enumerates all 32 feature subsets, not frames until ready; its existing
32-result assertion remains. A comment explains that fixed work to the wait
scanner, which now passes with no rule/baseline change. No bug 45 compile-hang,
shader or teardown investigation was performed here.


### Fixed: stats secondary-scene registrations

Register any of Stats, FramePhases, PipelineCompiles or FrameBeacon in a secondary
scene and a same-name sentinel in the default scene, then dispose it directly.
The registration stayed in the secondary scene while the default sentinel was
removed. Each owner now uses sceneOf(this); the eight-case real-engine test fails
four direct cases before repair and passes all eight afterward. Scene removal,
restoration, resource release and replacements remain covered. GPU/README and
closing acceptance are pending; the wider audit remains open.

### Fixed: ComputeFrame owner proof absent from package GPU gates

The owner browser driver existed but no compute package script named it, so the
GPU planner rejected the complete plan. Its new package script is covered by
compute-owner-gate.test.js (fails before wiring). The script starts from the
repository root. The owner GPU loop now checks every intermediate dispatch
result after readback, retaining the exact four-step workload and disposal
assertions. Native/compatibility owner proof, all 132 browser checks, all 21
runtime examples and the full failed-gate/compute unit rerun pass.

### Fixed: real-plan test could start before context initialization

Node's test runner starts the registered real-plan assertion before the module's
later top-level await initializes ctx. Register this complete test after that
await, retaining every assertion. The collected verify's ReferenceError is
retained; the complete failed-suite/compute rerun passes 244 checks. No timing
wait, retry, weakened assertion or runtime engine change is involved.

Stats closing acceptance: the collected verify on the current-main stats rebase completes with 13,864 of 13,881 repository tests passing, 17 failures and zero skips. Missing ComputeFrame GPU-script wiring, a fixed-frame workload classification and a pre-initialization planner test reference cause those failures. The repairs pass all 244 checks in the complete failed test files plus compute units and the new gate regression. The complete compute GPU suite, strengthened owner proof on both backends and all 21 compute README examples also pass. Every other verify step passed; no second full verify or fresh all-green full-run claim is made. The original process disappeared without a result, so its incomplete log is retained without a pass claim. The single replacement finished within its 40-minute bound. The real-GPU stats script passes, including eight owner cases, two shader modules and zero compilation errors; all eight runtime README examples pass. Stats source is unchanged by the exporter/documentation-only rebase. Lint and hygiene pass with 120 existing lint warnings; entry ceilings are unchanged. [Durable receipt](whitepaper/results/batch-56-stats-owner-20261109.json). The wider owner audit remains open.

### Fixed in b4bb08a45: Save factory secondary restore target

Repro: restoreScene(engine, saved, {scene: secondary, plugins: {factory: {type}}}) when the type's synchronous attach calls engine.use(plugin). The factory previously ran outside target setup and rollback removed by name from the wrong scene. Commit b4bb08a45 invokes factories in target setup and rolls back by identity. Lane G reran packages/save/tests/scene-owner.test.js on current main: all 16 cases pass, including secondary/default-name isolation and attach/load/later-failure rollback. See the full fixed note below.

Capture root-cause update from the coordinator: the red capture regression is owned by core lighting's uniform-only light-direction normalization under GPU load. The core repair waits for Scott's approval. The red regression and its package wiring stay off main; the exact-zero assertions remain unchanged.

### Fixed: subset enumeration misclassified as a fixed frame wait

The post-rebase fixed-wait scan flagged compose.html's 32 distinct feature
subsets because it recognized list indexing but not bitmask input selection.
The checker now traces the filter's outer counter and callback bit index to an
assigned input passed to render. Its new regression fails before the repair;
all ten tests pass afterward, including five negative forms. The actual browser
fixture, case count, assertions and fixed-wait baseline are unchanged.

### Fixed: published colour-map precision (audit finding 8)

The recorded sciviz tables rounded published decimals to 8 bits and delta-coded
them, so e.g. viridis sample(0) differed from [0.267004, 0.004874, 0.329415].
The root cause was packaging quantization, not scientific data or GPU precision.
Restore plain published decimal RGB rows and interpolate before documented
float32 output conversion. All-row digests and precision regressions cover this
class; sources and proof are in [size restoration](size-restore.md).


### Fixed: Save factories registered into the default scene

`restoreScene(engine, saved, { scene: secondary, plugins })` invoked a missing
plugin's `type.attach(engine)` outside secondary setup. The real engine therefore
attached it to the default scene while rollback removed from secondary. Default
same-name plugins could also prevent attachment. Save now invokes factories and
state callbacks inside the target setup scope and rolls back registrations by
identity, including helpers attached before a factory throws. The 16 owner cases
in `packages/save/tests/scene-owner.test.js` produce 13 failures on the parent and
all pass after repair; the original nine-case fixture had six secondary failures
and three passing default controls. Callback effects outside saved state remain
the binding author's responsibility. The wider owner audit remains open.


### Quality redraw helper lifetime: resolved

The optional-package repair binds cleanup to the actual registration and cancels
both queued frames after stop or disposal. Ten parent failures are covered by
the real-engine suite. All 95 Quality units, its five GPU commands and seven
runtime README examples pass. The exact inherited 7 ms speed budget remains
in the named deferred suite. See the [acceptance receipt](whitepaper/results/batch-56-quality-owner-20261109.json).


### Cinematic owner disposal: resolved

Cinematic and CameraBrain now resolve the scene of their actual instance. All
108 package units and the class guard pass (parent: four failures in sixteen
owner cases). The complete GPU browser check passes, including eight owner
cases each rendering 484 red pixels with no validation errors. All ten runtime
README examples pass. See the [receipt](whitepaper/results/batch-56-cinematic-owner-20261109.json).

### Controls secondary wrapper disposal: resolved

The shared Controls base and two gizmos retain their actual wrappers and detach
from sceneOf(wrapper). The original expanded parent suite has eleven failures;
all 83 owner cases and 304 package/guard checks now pass. The complete browser
proof passes 17 checks including twelve owner pixel cases; all three walk checks
and fourteen runtime README examples pass. See the [acceptance receipt](whitepaper/results/batch-56-controls-owner-20261109.json).

### Animator secondary ownership and runnable examples: resolved

Five parent failures in fourteen real-engine owner cases are repaired in the
optional package. All 213 package/guard checks, eight real-GPU owner cases
(242 model pixels each), the complete game browser and all fifteen README
examples pass. The README now uses the bundled mannequins' authored clip,
marker-table and bone names; twelve of fourteen old asset-contract cases failed
with the fictional hero path. Ten obsolete known-list failures are removed only
after every replacement example executes successfully.
[Acceptance receipt](whitepaper/results/batch-56-animator-owner-20261109.json).

### Read-only Firefox spawn UNKNOWN diagnosis

Direct hidden Process.Start of the installed Firefox with --version also fails
before execution: Windows native error 14001, incorrect side-by-side configuration.
Application/SideBySide event 33 names missing dependent assembly mozglue 1.0.0.0.
Both executable and DLL are x64. The executable's RT_MANIFEST ID 1 requires
mozglue; mozglue.dll embeds its assembly manifest only at ID 2, and no external
mozglue.manifest is installed. Microsoft's [Assembly Searching Sequence](https://learn.microsoft.com/en-us/windows/win32/sbscs/assembly-searching-sequence)
requires resource ID 1 for a private assembly DLL. Thus the installed browser's
manifest packaging explains this loader refusal and Playwright's generic spawn
UNKNOWN, before renderer/GPU startup. The [resource documentation](https://learn.microsoft.com/en-us/windows/win32/sbscs/using-side-by-side-assemblies-as-a-resource)
distinguishes IDs 1 and 2. No installation, binary, registry or setting was changed;
no Firefox pixel pass is claimed. Evidence with hashes, resource IDs, manifest
text and event: docs/whitepaper/results/batch-273-firefox-diagnosis.json.

### Video overlay scene/view ownership: resolved

Direct secondary disposal and a missing viewport/scissor application are repaired
in the optional Video root. All 34 units/guards, all six package GPU leaves and
seven runtime README examples pass. The corrected same-frame parent pixel proof
changes 4608 out-of-scissor components; the repaired four owner cases change
zero and each draws exactly 512 red pixels. The caller's frame stays alive.
[Video receipt](whitepaper/results/batch-56-video-owner-20261109.json).

### Fixed in 8e91c547e: Animation registration cleanup

Animation.dispose previously removed by name from the active default scene,
leaving its secondary registration behind. Commit 8e91c547e repairs Animation,
its model-disposal callback and the other package owners, including VATCrowd.
Lane G reran packages/animation/tests/scene-owner.test.js on current main:
all 19 cases pass, covering 16 constructor/factory owners, same-name default
isolation, asynchronous cache cancellation and disposal during initial loading.

### Browser shutdown recurrence: reproduced PID-wait defect repaired (2026-11-09)

The original full verify at 60bb86ab6 plus dirty headless changes passed every
non-unit step and 13997/13998 cases. tests/page-ready.test.js:30 completed its
readiness assertions, then closeAll timed out at the unchanged 30000 ms budget.
Repro command: node --test --test-timeout=300000 tests/page-ready.test.js.
The original log names only browser; it cannot establish a native/client/pipe
substep retrospectively. A single phase-traced diagnostic run passed before
repair, so that run is not accepted as proof of a fix.

The deterministic teardown repro isolates stopOwned's child-process wait:
a killed child's PID is reused, kill(pid, 0) reports the replacement alive,
and the unbounded children.filter(alive) loop never completes. Use the existing
Windows creation-time-aware native waiter instead. Its failed helper response
must retain all unresolved PIDs; previously a non-timeout launch error with no
stdout falsely meant all gone. Both new regressions fail the parent. The
complete affected teardown/selection/shutdown files pass 59 cases, the changed
shutdown file passes eight cases, and the failed page-ready file passes all four.
This repairs a demonstrated cause, not a proven attribution of the old log.

Pending owned-close phases now identify process listing, native termination
(with PIDs), process/stdio close, Playwright server kill and client close even
through outer closeAll wrappers. A four-case regression injects a hang into
each teardown phase and requires its exact name at the hard limit. Preserve
this record and capture those names if the original recurrence returns. No
deadline was raised, retry loop added, full verify replayed or other lane killed.
See [size restoration](size-restore.md) for research and retained log receipts.


Combined-record follow-up: the failed network child wait named PID 101848, which
was already absent. Captured native waiter output is empty with exit code 1:
a caught GetProcessById exception leaves powershell.exe's final status false.
Explicit successful loop exit plus the native absent-PID regression repairs
this introduced classification defect. Unexpected query errors and unreadable
creation times remain unresolved rather than being called successful cleanup.

### Batch 273 checkpoint fixture acceptance

The full repository units completed 14,099 tests: 14,095 passed and four failed.
Three ViewCube integration tests failed because their single-scene EngineKernel
stand-in lacked sceneOf after Controls began resolving exact wrapper ownership.
The fixture now implements that required identity-based method, matching the
real engine; all 18 ViewCube tests pass without altered camera assertions.
The fourth failure was stale generated site/llms-full.txt after the README edit;
regeneration and tests/llms.test.js resolve it. No failed result is discarded.
ViewCube's full compat browser check also clicked a corner instead of an edge:
front() changed the camera but read CSS hit coordinates before the frame graph
published the new orientation. The fixture now renders that requested frame
synchronously before the next coordinate query. The full original browser
assertions pass afterward. No ViewCube or Controls runtime bytes changed.
Receipts: test-results/batch-273-clamp-resume-units.log,
batch-273-clamp-viewcube-{diagnose,owner-after,compat,compat-after}.log.
### Historical: batch 133 GPU startup contention (resolved on main)

Bounded decoder/glTF/glTF-pro and README wrapper attempts on 2026-11-09 did not
run their tests: shared acquisition reached its four-minute wait limit behind
other sessions' exclusive work; glTF and README also reported Windows EPERM
creating the shared GPU mutex. The latter occurs before ownership/test startup,
not in Draco. The current main retirement fix is already present. A remaining
mixed-client or parent-directory deletion race is suspected but not yet proven;
retain the exact logs in the maintainer's batch 133 gate evidence and reproduce
with concurrent main-checkout lock clients before changing the owning script.
No retries, bypasses, skipped gates or passing GPU claims were used.

### Fixed by batch 160: batch 133 verify browser pipe teardown

The final verify at checkpoint 89793c614 runs 13,477 tests: 13,476 pass, none
are skipped, and tests/page-ready.test.js fails its real-browser readiness
regression during teardown. All page assertions pass, but browser.close exceeds
the unchanged 30,000 ms shutdown budget. The failure is localized to the owned
Chromium teardown in scripts/lib/browser.mjs withBoundedClose, under the outer
closeAll in scripts/browser.js; process termination, child exit, server.kill and
driver close share that budget. Which inner phase stalled is not yet isolated.
The already-landed retirement/owned-server fixes are present on current main.
No matching lane-owned browser was found alive afterward. The coordinator assigns
the pipe-lifecycle root repair to batch 160, not this lane. Commit 6ebbd1aa4
closes owned Chromium pipes before driver cleanup. After rebasing onto that
repair, this lane reran tests/page-ready.test.js: all four tests pass, including
real-browser teardown, in 9.03 seconds at the unchanged budget. The page is plain
HTML and needs no GPU; an unnecessary GPU-lock wrapper first expired in its
queue before test startup. Its failure is retained separately. No competing
teardown fix or busy-machine exemption was applied in this lane.

### Open: batch 133 optional decoder replacement gaps

The optional clean-room decoder retains the warm losses measured in
whitepaper/results/batch-133-paired-checkpoint.json: full 365 and glTF 288 total
losses on the 1,937/1,003 accepted-input sets. Profiling Margo's own named Wasm
localizes remaining cost to mapping, reconstruction and traversal; the proven
mapping work reduction did not establish overall speed parity. Reproduce with
the pinned paired manifest and private batch 133 driver. Cold/RSS/startup coverage
is partial. Historical predictor 3 and full historical KD/type/transform coverage,
and invalid UTF8 public metadata conversion are not established; the published
spec omits rules and no new inference is authorized in this landing run. Both
prebuilts stay default while these gaps remain; no replacement pass is claimed.

### Historical: batch 133 optional landing GPU acquisition (resume 9)

The 20-minute exclusive request by codex-133 expired before starting a test,
while preview-skip-repair held the GPU. No hang, decoder fault, timing exemption
or GPU pass is inferred. CPU gates pass except the sizes-page catalog check:
its missing optional worker/Wasm registrations are repaired and entry sizes
regenerated, but the required matching basic-scene network record and focused
rerun need the GPU. Decoder/glTF/glTF-pro GPU and README runtime gates remain
unrun. Reproduce/resume with the bounded resume9 GPU bundle after ownership
changes; no lock bypass or blind retry was used. Nothing was pushed. The command
results and log hashes are in whitepaper/results/batch-133-landing.json.

### Open: batch 133 malformed metadata trailing groups

The optional native decoder still differs from the full opaque prebuilt on 22
of 1,613 crafted metadata strings. Its short public conversion can consume bytes
beyond the value and terminal NUL. Repro held-8: value8a bf84 4456 d525 3cf2;
opaque UTF16 ends d9c0 dc09, owned conversion ends d9c0 dc00. See the complete stream in
[the 22 retained repros](whitepaper/results/batch-133-metadata-strings.json).
The owned bridge zero-fills absent bytes and never reads another allocation.
Root boundary: public-string conversion outside the bitstream, not metadata
framing or raw preservation. All 1,445 in-bounds cases agree; 168 inputs exercise
external padding, of which 146 happen to agree. No external-padding semantics
have been proved, so default replacement and full UTF8 equivalence remain open.

### Fixed: glTF textured pass raw light alias

The textured frame destructured engine.lighting.direction and copied it raw
after core's shader began consuming an already normalized direction. This
made textured pixels brighter than the equivalent constant material. The
existing shared unitLight writer repairs the owning package. The real draw
writer regression fails before and passes after; GPU comparison assertions
and tolerances remain unchanged.

### Open: batch 133 resource and historical target failures

Fresh-process strict RSS losses: 116/3,881 full and 113/1,003 accepted glTF
inputs. Largest observed excesses: full input83a312e3fe... +5,017,600 B; glTF
inputa22e31f28c... +5,660,672 B. Exact hashes, old/new peaks, copy counts and
manifest identities are in [the complete record](whitepaper/results/batch-133-resources-inventory.json).
Linear-memory peaks pass; physical-page, JIT and live-allocation contributions
to the RSS excess are not yet isolated. This remains an unaccepted target
requiring a root allocation diagnosis, not a busy-machine timing waiver.

Fixed in the lane G sweep: the native descriptor rejected widths above 16,
and quantization, KD minima and prediction scratch also assumed 16 components.
The descriptor now accepts nonzero UI8 counts; budgeted component-sized vectors
cover every affected transform and reuse prediction scratch across rows/faces.
wide.rs retains the historical width17 i8 repro and frozen public oracle, adds
raw/integer/quantized and signed/quantized KD cases through 255 components,
and preserves zero/truncation/output-budget rejection. The native quad checks
all three parallelogram predictors beyond 16; draco-wide.test.js verifies the
shipped Wasm and typed output. The old public binding's negative width255 count
is still a separate parity difference, not reproduced by the owned UI8 API.

Historical predictor3 is absent from integer.rs's supported-method set. The
record contains12 accepted complete version1.0/1.1/1.2 streams, with distinct
UV bytes and intact canaries; native returns code5. The old-format reconstruction
rule remains to be established by further crafted public-API observations.

Outside this decoder repair: packageInputs in scripts/package-stamps.mjs omits native Rust folders (PACKAGE_INPUTS lists package.json, tsconfig.json, src and scripts), so a native-only edit can leave API freshness stamps unchanged. Repro: inspect packageInputs(root, 'decoders', manifest), then change native/draco/src/integer.rs; no listed input changes. Full builds still compile the crate. Tooling ownership; deferred under rule 6.

### Batch 265 native React binding scope

Fixed while building: copying an orthographic projection callback onto the default camera lost its native control
metadata and read a stale camera pose. The binding now transfers the native projection to the leased engine camera,
restoring its property descriptors and prior owner on cleanup. Regression: packages/react/tests/package-bindings.test.js
checks same-frame dolly, vertical views, fixedOrthographic, nested defaults and option/default changes.
Instances, texture hooks, frame priorities and adaptive performance remain separate batch jobs.

Fixed in the lane G sweep: Grid inside Scene name="hud" was missing from a RenderView drawing only hud because it attached with engine.use. Grid now shares Line's attachBinding/detachBinding helpers, using the enclosing world for attachment and cleanup. kit-helpers.test.js fails on the parent and covers StrictMode, prop replacement, same-name default isolation and unmount. The extras browser proof renders a green grid while drawing only its secondary scene. All 278 changed-package/dependent CPU cases and all 13 package GPU scripts on both native and compatibility backends pass, without driver resets.

### Fixed 2026-11-10: XR manager secondary-scene disposal

Register XR on a secondary scene, then dispose outside dispatch: XR.dispose
checked the active default registry by name, removed a same-name default plugin
and left its own registration behind. Resolve the manager's actual scene with
sceneOf(this) before removal. Four real-engine tests in xr.test.js cover direct
disposal and owner removal in default/secondary scenes, an active inline session,
one-time device/session cleanup and safe replacement. The secondary direct case
fails on the parent. scene-owner-source.test.js guards this class of detachment.
All 134 XR CPU cases, six selected XR GPU suites and the fresh 1,470-case
changed-package/dependent CPU run pass with no skips. No headset acceptance
claim is added.

### README browser shutdown observation

The batch 268 README gate reached a new example's HTTP 404, then stopOwned in
scripts/lib/browser.mjs threw SHUTDOWN_TIMEOUT for Chromium PID 93904 after its
termination request. The PID was absent on inspection after the run. The browser
helper's Windows child-exit observation needs a focused reproducer; no timeout
was raised and no shutdown failure was accepted as a passing gate.


### Batch 265 job 2: Instances ownership

The new binding initially applied an explicit material only when its prototype mesh already existed. Child effects
run before the owning Mesh creation; StrictMode exposed the missing attachment. The material now registers with the
prototype attachment set and follows each live mesh. Regression: packages/react/tests/instances.test.js, named Scene,
explicit material and live material edits. Instances is built independently of the remaining texture/priority/adaptive jobs.

Outside batch 265: full verify on parent d34cadf03 plus Instances reached tests/catalog.test.js teardown SHUTDOWN_TIMEOUT at 30,000 ms for Chromium PID 94292 (absent on inspection); the existing Windows child-exit/stdio observation defect recurred. Repro: npm run verify; log retained as test-results/batch265-verify-job2-final.log. No React test failed and no timeout was raised or accepted as passing.

### Batch 197 transition correctness

The optional controls/transitions entry has no known open defect from its current
suite. Opposite-side moves preserve a nonzero eye distance; symmetric quintic
evaluation fixes the new transition polynomial's endpoint rounding overshoot.
Tests reject a target path through a minimum-radius shell and invalid replacement
requests without disturbing a running move. Existing controls remain covered by
all 324 unit cases. Custom perspective projections and dynamically moving fit
bounds are explicit API limits, documented in the controls README.

### Batch 197 globe navigation

No open defect from the globe suite. Radial altitude, perspective/reference-ellipsoid navigation and sky-drag behavior are explicit limits in the controls README.

Batch 251 job 1: no open defect found in reference expansion; missing registrations,
cycles and bounded expansion reject during construction (subtrees.test.js).

Batch 171 outside scope: node scripts/modern-usdz-tests.js --compat fails RiggedFigure.usdz motion (moved false, repeats true, no GPU errors), while native WebGPU passes; narrowed to the USDZ skeleton/animation compatibility drawing path, exact owner unproved. Log test-results/sciviz-fixes/formats-dependent-usdz-true.log. Deferred under rule 21; main 896ebf844 requires GPU gates only for changed packages.

Lane G current-main repro update (2026-11-10): the unchanged RiggedFigure portion,
isolated from the demo and other cases, now returns moved true, repeats true and
zero GPU errors on compatibility. It uses the same archive, camera and seek times
0/0.7/0. No repair commit or cause of the historical failure is established by
this passing control, so no animation or capture code was changed and closure
is not claimed. Local receipt: test-results/kb-g/gate-81788-0.log.

## Fixed: tests/gpu-lock.test.js stops after its fifth test (found 2026-11-10)

- **Repro:** `node --test --test-reporter=tap tests/gpu-lock.test.js` on origin/main 896ebf844 while other lanes hold the shared GPU lock: five tests pass, then the file exits 1 with no failing subtest named (about 78 s). Selected tests (`--test-name-pattern`) pass.
- **Cause and repair (2026-11-10):** the sixth fixture filled three holders after b7d02c892 raised the default capacity to five, then waited forever for a request that had already acquired a free slot to appear in the queue. Current-main reproduction reaches the test's 20-second diagnostic bound; the process tree was terminated at the 35-second hard limit. The FIFO regression now fills the configured capacity and checks identical tied-timestamp, reverse-name admission ordering at one, three and five slots, under its existing 30-second bound. Scheduler policy, deadlines and assertions are unchanged.
Batch 251 job 2: no open inspector defect found by the full-hierarchy, utility,
text-injection, frame, pause/resume and disposal DOM checks (inspect.test.js).

### Batch 255 save capture owner gaps resolved

Jobs 1 and 2 now have owner-backed optional capture APIs. Custom procedural/GPU resources retain explicit application bindings; no current built-in material or playback feature is omitted.


### Fixed: derived-grid validation coerced nonnumeric primitives before its diagnostic

Owner: sciviz/derive prepare. Math.fround performed ToNumber before the own primitive check;
BigInt/Symbol inputs therefore threw a raw TypeError, while optional null components/masks
reached a property access. Primitive and array checks now precede coercion/access, preserving
the linked sciviz RangeError before any GPU allocation. derive.test.js checks both entry paths.
The numerical/consumer limits are in limits.md and the sciviz README; no algorithm is weakened.

Batch 171 derived-field shutdown blocker was repaired on main by 919fdc09e; the original failure remains in its historical validation record.

Batch 255 job 4: no open defect found in authenticated safe storage. Replay under the same physical key and caller-controlled key secrecy are explicit integrity-model limits in docs/limits.md, not claims of rollback protection or encryption.
Fixed 2026-11-10: GPU package-runner owner collision (batch 197). Unrelated worktrees previously shared the generic check owner and were serialized despite free slots. Both serial and parallel admission now use a stable digest of canonical worktree identity, retaining one slot per worktree and distinct suite labels. Regression: tests/gpu-suite-owner.test.js reproduces the parent runner collision with CPU-only admission and checks independent owners; scheduler policy and GPU assertions are unchanged.

Fixed with animation landing: React bindings/instances browser scripts now select repository-root cwd. The package-cwd CPU regression covers every React browser leaf; native/compat GPU checks retain their assertions.
Batch 251 job 3: the exact plateau-mean fixture exposed naive-sum rounding.
Compensated normalized accumulation fixes the cause; the unchanged analytical
fixture now passes. No open defect found by fuzzy.test.js.

Batch 251 job 4: no open text-format defect found in all-node, reference,
200 generated round-trip, syntax-location and bounded-input tests (text.test.js).

Batch 251 job 5: memory namespace/id concatenation could collide, for example
namespace foo with id string:a versus namespace foo:string with id a. Tuple
encoding fixes the cause; triggers.test.js retains the failing-before regression.

Fixed 2026-11-10: batch 251 subtree shared-memory fixture. The fixture uses
BlackboardKey objects, compares the inline and referenced counters, checks an
independent fallback and verifies that serialization names the counter correctly.
Regression: packages/behavior/tests/subtrees.test.js.
Fixed 2026-11-10: batch 251 tree-text options typing. Ordinary-tree options now
exclude possible registrations; a broad overload returns SubtreeDocument when
TreeTextOptions may carry references, including optional options variables.
The compiler regression in packages/behavior/tests/text-types.test.js rejects
passing that result as TreeDocument and retains ordinary-tree inference when
registrations are absent. Runtime parsing and validation are unchanged.
### Batch 215 async lifecycle coverage

No open defect identified in the new completion/AbortSignal entry. Deterministic lifecycle coverage is in packages/tween/test/async.test.js; existing root APIs remain available.

Fixed 2026-11-10: Batch 215 outside scope. cutscene VFX replay waits for the actual compatibility route before recording (326c67544). Unchanged vfx-browser.mjs --compat passes all seven replay frames including frame 40 particle hash 397093820.

## Batch 262 tweak panel

No open defect found in the standalone binding scope. Regression coverage includes
object-valued enum identity, long gestures, independent undo steps, partial numeric
text, retained vector/colour references, shared folders and abort cleanup.

### Batch 262 prior gate blocker

Resolved on main by 2c1b94730: the GPU queue now observes owner exit before replaying completion evidence.

Fixed 2026-11-10: GPU package-runner owner collision (batch 262). Unrelated worktrees previously shared the generic check owner and were serialized despite free slots. Both serial and parallel admission now use a stable digest of canonical worktree identity, retaining one slot per worktree and distinct suite labels. Regression: tests/gpu-suite-owner.test.js reproduces the parent runner collision with CPU-only admission and checks independent owners; scheduler policy and GPU assertions are unchanged.

Fixed 2026-11-10: Outside batch 262. cutscene VFX replay waits for the actual compatibility route before recording (326c67544). Unchanged vfx-browser.mjs --compat passes all seven replay frames including frame 40 particle hash 397093820.


### Fixed in batch 262: inspector disposal in another scene

Repro: keep an inspector in the default scene, attach another using other.use,
then dispose the latter outside a render. The old engine.removePlugin(name)
removed the default inspector and left the other scene's entry registered.
Inspector.dispose now uses sceneOf(this). The multi-scene regression in
packages/inspector/test/gizmo.test.js fails without it and proves both the owner
cleanup and the default inspector's survival.


Batch 171 job 6, small fix-phase follow-up under rule 22: clearing the optional demo UTC datetime input passes an invalid Date from its change handler to globe.setDate, which correctly rejects but leaves the event unhandled. Repro: clear Sun (UTC) in examples/sciviz-atmosphere.html. Cause: the demo does not validate the empty datetime value before calling the typed solar API. The default valid date, API input checks and complete globe feature pass.

Batch 258 dependent fixture: after-scene-browser.tsx now waits for its actual held asset request, in addition to Suspense fallback, before exposing the snapshot. The previous count-0/count-1 race is covered by the unchanged React browser request assertion.

Image follow-up (batch 258): generic attachMirror does not yet emit labelled Image roles; replaced image tiles remain resident until atlas eviction/renderer disposal. Repro: create, draw and remove a sequence of new ImageTexture objects; the colour atlas retains their tile slots. Cause: image tiles share the glyph atlas lifetime. These build-phase quality gaps are queued in private finish-later, with residency limits documented.


Fixed in batch 262 scene editing: a non-callable Edit.discard previously entered
history and could abandon redo before any error. EditHistory.record now validates
the optional finalizer before mutation. Regression: the invalid history finalizer
case in packages/inspector/test/edit.test.js fails without the validation.

Fixed in batch 262: the React after-scene readiness fixture counted historical plugin instances whenever their name was currently attached. Reused materials:opaque-color names could count twice with no material installation, publish ready too soon, then report 0 instead of 1. It now reads the current engine.plugins identities. Regression: packages/react/tests/plugin-state.test.js and the unchanged installation assertion in packages/react/scripts/test-after-scene-browser.js. The latter passed once on clean main 5d6e5facd, failed with the rebased fixture, and passes after the observation fix; no assertion or timeout was loosened.
Fixed 2026-11-10: save/scene-state shadow restoration invoked the inherited __proto__ setter through Object.assign. Restoration now defines the sanitized snapshot's own data properties, preserving bound prototypes and the same behavior during rollback. Regression: packages/save/tests/scene-state.test.js covers ordinary and null prototypes, special property names, detached recapture and failure of a later shadow binding. Both new regressions fail on the parent; playback and light-list restoration remain unchanged.

Fixed during the same save gate: engine-check.mjs captured its animation frame before lazy compatibility submissions had completed, failing the exact layered-fade pixel comparison. The capture helper now awaits the existing GPU queue fence after its batch-building first frame, before drawing and capturing its final frame in the same task. No render, sample, assertion or pixel bound was removed. Regression: packages/save/tests/capture-readiness.test.js executes the real helper with a deferred queue; it returns the stale version before the repair. The unchanged engine GPU fixture passes native and compatibility after repair.

Batch 267 job 1: no open live-bridge defect found in CPU or both-backend browser correctness checks; origin-clean capture and dev-only deployment limits are documented in docs/limits.md.


### Batch 254 audio voice completion
Resolved while building the manager: a physical source that had already fired onEnded could otherwise notify again when logical phase reached its end. voice-manager.test.js covers physical and virtual completion exactly once. No open defect from this job.




Fixed in batch 262: compatibility stencil-only texture previews returned zeros because render bindings retained the default depth sampling mode. The owning backend now enables WEBGL_stencil_texturing, selects the requested stencil/depth mode and separates simultaneous ordinary-view aspects. Native and compatibility texture viewer assertions pass, including the unchanged [64,64,64,255] stencil check and a new depth-after-stencil check. CPU regression: packages/webgl2-compat/test/device.test.js; failing-before log: test-results/batch262-resume-job4-regression-before-0.log.

Fixed in batch 262 texture capture: a second capture published the first capture's temporary preview texture and sent spurious list notifications. Module-owned
allocation depth now excludes viewer outputs through every wrapper layer. The
layered-capture regression in packages/inspector/test/textures.test.js fails
without the shared exclusion and passes with no notifications.

Outside the batch 262 single-aspect viewer: simultaneous depth and stencil bindings of one resolved MSAA source still share the backend resolved texture object. applyBindings changes that object mode per binding, so the last aspect wins; ordinary non-MSAA views already get separate aliases. Repro for the fix phase: one fragment shader textureLoads both aspects of a 4-sample depth24plus-stencil8 texture in the same draw; allocate synchronized resolved aliases per aspect.

Fixed 2026-11-10: Outside batch 262. scoped API merging rejects marked or duplicated input (6cf48539f). tests/api-report-scope.test.js passes all five checks.

### Fixed: batch 254 voice registration callback rollback
Registration now defers its first source change until all gain estimates have
validated; failed estimation releases its own registry/owner entries and
propagates the original error. The caller's playing source, exact phase and other
allocated voices survive NaN, negative, infinite and throwing gain callbacks.
Removal also checks registration identity, so disposing a stale handle twice
cannot release a replacement handle. Regression:
packages/audio/tests/voice-manager.test.js; all three new lifecycle regressions
fail without their corresponding repairs. Valid transport, ranking and waveform
checks retain their existing assertions.
- Batch 260 HTMLBlend inherited custom view: with `HTMLBlend.attach(engine, {view: {viewport: [0.5, 0, 0.5, 1]}})`, the DOM projects into that rectangle while the aperture uses the active render context's camera/viewport. Cause: mask draw consumes PassContext rather than LabelRenderer.view. Ordinary full-canvas blending passes on all three backends; synchronize explicit view/scissor/camera in the fix phase.


Fixed immediately after batch 171 landing: a88cfd4fe contained unresolved boundaries in docs/api-surface.md after a native helper failed but its PowerShell caller continued. Authoritative api:update regenerates the summary; generated-metadata-conflicts.test.js fails on that published artifact and passes on the repair. No engine or atmosphere runtime source changed.


Fixed core version skew: missing engine-local version/module identity checks allowed a plugin from
a second install or a stale build to mutate core's ownership registries silently. The packed
two-install and stale-build regressions now reject before plugin work; same-path matching imports
pass. [Design, regression and size evidence](core-version-guard.md).

Fixed 2026-11-10: GPU package-runner owner collision (version guard). Unrelated worktrees previously shared the generic check owner and were serialized despite free slots. Both serial and parallel admission now use a stable digest of canonical worktree identity, retaining one slot per worktree and distinct suite labels. Regression: tests/gpu-suite-owner.test.js reproduces the parent runner collision with CPU-only admission and checks independent owners; scheduler policy and GPU assertions are unchanged.

Dependent audio GPU validation is incomplete for the version-guard landing: the shared GPU monitor reclaimed lane-T-version-guard at 2026-11-10T02:28:06.439Z after 211623 ms without GPU activity, while audio/scripts/test-browser.js awaited its browser evaluations before writing audio-browser.json. The suite produced no report and did not reach its own 10 min limit. Root cause of the uncompleted audio evaluation is unconfirmed; monitor evidence is in the local GPU idle record and test-results/version-guard-resume/gpu-lane-T.log. No timeout or idle threshold was raised.

Audio follow-up: the bounded instrumented diagnostic ran every unchanged audio assertion successfully and wrote the full report (test-results/version-guard-resume/audio-phase.log, 2026-11-10). It does not explain or waive the initial monitor-reclaimed run; retain that stall for the fix phase.
- Fixed while recording the VRM asset: appended WebXR generic-hand provenance is now part of the notices generator asset table, preserving the original licence and hashes. The existing supply-chain consistency test covers both records.

- Existing VRM scene ownership: without an Animator, `addVRM` in packages/rigging/src/vrm.ts registers/removes its plugin through the engine active scene rather than the model scene; reproduce loading into an inactive secondary scene. Waits for the fix phase.

### Batch 273 Firefox scope and concurrent landing blockers
Shipped Firefox159.0.1 now launches through the package-owned BiDi transport and
passes the scoped46 numeric cases,733 render pipelines and477 legal compute
pipelines plus the required negative pipeline rejection. The old patched-browser
side-by-side loader diagnosis above is historical, not a refusal by this shipped
browser. Its default native WebGPU requestAdapter is null, so native-baseline
canonical driver refusals remain visible in the receipt. Full-package and
physical-device certification remains open; see work-lists/batch-273-browser-matrix.md.
The latest main's committed merge markers in the umbrella manifest and size
baseline blocked this job's package build. Both additions and history records
are retained, budgets unchanged, and tests/integration-json.test.js parses all
workspace manifests and quality baselines and checks their totals.

Batch 258 forms fixed blockers: the generic mirror delegated Enter/Space on div options as though they were native buttons, and transferred focus during a canvas pointer press, losing its pointer ID. Exact activation and pointer-release regressions cover both repairs. Form annotations now run after mirror frame reconciliation; hex editing preserves a valid RGB prefix while alpha is entered. Remaining polish: continuous SV gradient and human AT certification are in private finish-later. No missing form widget remains in this job.

Batch 220 job 1: the requested missing math methods are supplied by math/compat; no open defect found in the added methods. Base per-type entries intentionally retain their original API and size contract; opt into the new entry when porting these methods.


Batch 267 job 2: no open asset-tool defect remains in the CPU and real-CC0 both-backend checks; supported variants and provider/deployment limits are in docs/limits.md.

### Fixed: batch273 scenery append-document integration
Landing04dc98994 retained nested append-document merge boundaries, including
incoming WFC notes, because its native Node helper failed but PowerShell
continued to stage and push. The metadata test did fail; its exit status was
not honored by that local orchestration. Preserve both sets of documentation,
remove the boundaries, and regenerate public help from the repaired sources.
The existing regression now includes both whitepaper documents and standalone
separator boundaries. Future local landing commands check child status before
commit/push; no repository hook or landing queue is introduced.

The same incoming metadata merge reset28 approved size ceilings while leaving their runtime fixes present. Restore the exact approvals from10bf82909 and recompute the total; quality sizes is the regression for the resulting mismatch. No runtime change or newly raised allowance.


Batch 267 job 3: no open HTTP transport defect found in the real-network correctness suite; supported revisions, JSON reply mode and deployment ownership are stated in docs/limits.md.

Fixed 2026-11-10: direct MCP duplicate active tool IDs. createMcpServer now rejects a duplicate active tools/call ID with the standard invalid-request protocol error before invoking the tool or replacing the original cancellation controller. Completion removes only its own controller. Direct and batch regressions in packages/mcp/tests/server.test.js fail on the parent, preserve numeric/string ID distinction and prove cancellation still reaches the original request. Stdio uses that same server handler; completed-ID behavior and HTTP transport are unchanged.

Fixed 2026-11-10: Outside batch 267. GPU planner registrations and command ordering are repaired on main (d7be06653). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.
Fixed 2026-11-10: Upstream notices generator omits the appended WebXR generic-hand provenance on main bae4fcbf8. notice regeneration preserves appended asset credits (a9aecea66). tests/supply-chain.test.js checks retained addenda, idempotence and current generated notices.

### Batch 172 pipeline regression coverage

Independent time-aware branches keep separate cached times; requesting one branch does not invalidate the other. Sparse parameter arrays reject before changing the graph so JSON restoration cannot silently substitute nulls. Regression: packages/sciviz/tests/pipeline.test.js. Operator cancellation and resource ownership limits are explicit in docs/sciviz-analysis.md.

Fixed during batch 172 landing: formats-browser.mjs used the workspace current directory as the Vite root and returned HTTP failure for /examples/sciviz-formats.html under npm run test:browser --workspace @margoengine/sciviz. Both format and pipeline runners now resolve the repository root from their module URL. The unchanged both-backend format pixel checks, invoked from packages/sciviz, are the regression.

Batch 172 landing also restores the exact approved version-guard ceilings from the sizes baseline history record for 57750c4d6. The history survived a merge while its item values reverted to ceilingBefore, causing fresh builds to fail the existing size assertions. No new growth allowance is introduced; the history supplies each before/after figure.

The same baseline merge lost water 20817 B (batch-225), XR 9158 B (version-guard) and lazy compute/readback 31756 B (snorm-storage). Restore those exact retained approvals. Existing quality assertions reproduce all three failures on a fresh build and pass after the data repair; no source algorithm, test or tolerance changes.

The final dependent umbrella test also found the already-landed exporters/materials entry absent from the generated umbrella map. Regenerate with scripts/umbrella.mjs, preserving the sciviz pipeline facade; tests/umbrella.test.js exercises both current generation and binding identity. No exporter source changes.
- Outside batch 263: video/record can resolve a header-only WebM when stopped before Chromium encodes its first frame. Repro: record a native WebGPU canvas at 30 fps, render 12 requestAnimationFrame ticks, then stop; observed 110-byte video/webm;codecs=vp8, decoder rejects DEMUXER_ERROR_COULD_NOT_OPEN. Cause: recordCanvas validates only nonzero Blob size, which also accepts container headers. A 1.2-second recording decodes correctly on WebGPU and preview WebGL2. Fix phase should add first-encoded-frame readiness or structural stream validation in video/record with a short-recording regression.
### Animation scene ownership repaired

Animation plugins now detach by registered identity, preserving same-name plugins
in other scenes. GeometryCachePlayer retains its originating scene through the
first asynchronous read and releases the external abort listener on failure or
disposal. Package-local scene-owner regressions exercise every affected class
and factory without the parked owner-lifetime harness.

Disposed crowds, LOD, morph and interactivity controllers now reject subsequent
setup, preventing a new registration that idempotent disposal could not release.

### Fixed: dependent React bindings browser working directory

The package bindings GPU script used npm's package working directory as the
Vite root, so `/packages/react/tests/bindings-browser.html` answered an HTTP
error before any assertion ran. It now selects the repository root like the
adjacent React browser suites. `packages/react/tests/browser-working-directory.test.js`
reproduces the package invocation with a mocked browser entry and no GPU.

Fixed 2026-11-10: animation dependent cutscene replay (326c67544). The unchanged compatibility VFX suite passes all seven frames including exact frame 40 particle bytes (397093820). The dependent LOD imposter hang is resolved by batch 222: buffer mapping now waits its own nonforcing readback readiness after queued submits, retaining a device fence only for an invalid GPU-only shadow. Delayed scheduler tasks (fresh-timer message fallback) leave the event loop idle for WebGL sync state. The unchanged 16384-pick grid passes with 16362 agreements, every 262 imposter pixel and 1128 full-detail pixel picking correctly, and all original atlas sweep assertions pass (test-results/batch222-imposter-local.log).

Fixed 2026-11-10: GPU runner registration on clean origin/main b47fdef13. GPU planner registrations and command ordering are repaired on main (d7be06653). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.

Compatibility mapping-range gap found while tracing LOD: CompatBuffer.mapAsync ignores offset/size, and getMappedRange slices without enforcing the mapped interval or non-overlap. Repro: map a subrange then request bytes outside it; cause is discarded map arguments in device/resources.ts. Outside this animation job; preserve WebGPU validation rules in the owning package's fix phase.

Batch 220 job 2: the requested scalar interpolants/keyed-curve gap is implemented in math/curve; no open defect found by its analytic and ownership tests. Cubic overshoot and clamped time evaluation are explicit contracts in limits, not monotonic or periodic interpolation claims.

Batch 220 umbrella generation also supplies missing exporter aliases for entries already present on main: optimize-extra during the initial gate and splats during the final rebase. Cause: its exports map had not been regenerated into the umbrella; tests/umbrella.test.js requires exact generator agreement and now passes all eight checks. No exporter implementation changed.

Fixed during batch 220 landing: inspector/gl imported the compatibility preview registry/compiler and declared its package as a peer, violating packages/webgl2-compat/test/isolation.test.js. Native canvas access and locally owned fixed overlay compilation remove both edges. packages/inspector/test/gl.test.js covers registry independence, failed compile/link cleanup and state restoration; isolation tests pass unchanged.

Batch 258 job 4 closes preview GL's missing world-panel drawing in the optional world-gl entry; real pixels, depth, back faces, removal, mouse rays and foreign-state restoration are covered. Context-loss/XR hardware stress and oblique-filter polish remain certification follow-ups in private finish-later.

Separate preview screen-UI follow-up: bind a PIXEL_UNPACK_BUFFER or non-default UNPACK_ROW_LENGTH before a new UiRenderer glyph upload; the existing screen path assumes unpack defaults in GlAtlas. Its owner must isolate that pass in the fix phase. The new world pass isolates and restores those states and its foreign-state regression passes.

Batch 258 landing: existing image GPU fixture sampled two frames before the documented lazy preview painter finished loading. It now waits for the first submitted UI draw before exact pixel/cache assertions.

Batch 258 generated-page landing blocker: newly inherited MCP live-relay literals were absent from the shared error catalog. The catalog now names all 15 existing messages; the existing errors-page literal-coverage regression proves the repair, with no MCP runtime change.
### Batch 226 graph
No open defect found in the requested row. Unrepresentable local shear is an explicit documented TRS limit and rejects before mutation.

### Batch 226 clone
No open defect found in the requested shared-geometry/material subtree-copy row. Plugin, animation and constraints remain owned by their packages and are outside mesh cloning.

Fixed 2026-11-10: Outside batch 239 physical compatibility sampler plan (aa3e347da). The unchanged MARGO_COMPAT=1 scripts/gltf-pro-materials-gpu-check.js passes every extended/transmissive and complete-lighting pipeline plus all 64 iridescence and 96 direct BRDF cases, with zero GPU/page errors. No shader, assertion or tolerance changed in this sweep.

### Batch273 normal-map upload and blocking isolation: resolved
ImageBitmap uploads ignored requested unpack flip/alpha settings at the WebGL boundary, making flipped mesh normal domes appear dented while unflipped glTF remained raised. Cropped drawable-source normalization fixes the owning upload path. The complete canonical native/compatibility normal-map matrix and round-trip exact images pass unchanged; external-image.test.js fails the parent.
Incoming main61b17b70d independently repairs the inspector isolation blocker with its native-context observation, local compiler and regressions. Main also supplies the missing exporters/materials alias. Preserve those owner fixes and the existing isolation/import-equivalence tests; no duplicate implementation lands with this group.
The final dependent check exposed the incoming exporters/sparse umbrella alias missing as well; regenerate it with the owning script and retain the original full import-equivalence regression. Quality was initially run beside React's source-fixture tests, so its file snapshot caught a temporary consumer.tsx that the test then removed. Run that gate after fixture-producing CPU tests finish; no engine failure, ignored file or tolerance change is claimed.
Fixed in batch 208: StreamingAssetCache range misses left the background full-file body unread after its new response hook returned, so flush never finished and an offline full-file visit missed. Background fills now explicitly request complete buffered consumption. Regression: packages/cache/test/stream.test.js, background whole-file fill (5 s timeout before repair, exact 100-byte offline response afterward). Caller-facing streaming stays pull-driven.
Fixed 2026-11-10: Batch 259 tooling follow-up. GPU planner registrations and command ordering are repaired on main (d7be06653). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.

Batch 210 job 1: requested action operations pass mixer.test.js and analytical/real-rig GPU checks. Cache lookup follow-up for the fix phase (under the 5% rule): existingAction on an unknown clip throws instead of returning null, and a fresh optional root can create an unnecessary player because the lookup calls resolve/player; repro new AnimationMixer(skeleton).existingAction("missing"), or existingAction(clip, anotherModel). The umbrella generator also restores the already-exported but missing exporters/splats alias; the existing umbrella consistency test covers that generated-file gap. Optional-root pointer rebinding and reverse-time scheduled starts receive broader fix-phase coverage in private/handoffs/finish-later.md; all requested mixer operations are built.

### Fixed while generating batch 224 aliases
Origin/main 43e08376d added exporters/sparse without its umbrella facade. The ordinary umbrella generator needed for mesh-edit/boolean-batch also restores that upstream alias. Regression: tests/umbrella.test.js (manifest, identity and import-map checks). No exporter implementation changes.
### Batch 226 tags and lifecycle
Fixed during integration: synchronous parent/creation notifications could expose attach transforms or clone metadata before initialization. Optional graph/clone now batch notifications until commit; the tags.test.js attach/clone listener and failed-allocation regression fails without that boundary. Failed observer installation restores any already-installed wrappers. No open defect found in the requested row; pre-saved method references and private-store mutation are documented observation limits.
Fixed 2026-11-10: Batch 245 GPU planner registrations. GPU planner registrations and command ordering are repaired on main (af4b357e1, d7be06653). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.

- XR AR-extras GPU fixture: node packages/xr/tests/ar-extra.browser.mjs fails on clean origin/main 6ab64e777 as well as batch 265 with missing AR observations. The fixture counts session frames started before its async observation helpers attach; under shared load it reads before those helpers receive a frame. Receipt: test-results/batch265-resume-cleanmain-xr-ar.log. Owning fixture fix waits for the fix phase (rule 21).



### Open: review 99 composed native validation exceeds its twelve-minute lease

Repro at mesh checkpoint 4a40f2e29, rebased as 3c9a4f8f8 onto main 0ba1d4f94:
build packages, then run `node scripts/gpu-lock.mjs run --owner=review-99-mesh-compose-native
--wait-max=60 --max=12 -- node packages/voxel-pathtracer/tests/compose-browser.mjs
--backend=native` with MARGO_GPU_SLOTS=1. On the RTX A6000 / native Edge WebGPU,
the lock kills the process tree at 12 minutes. Subsets 0..30 finish; subset 31
(all five features) starts at page time 707653.5 ms and remains in tracer-ready-wait.
The last flushed event is preview pipeline-ready at 710230.1 ms. That subset's
trace pipeline has started but has no pipeline-ready event. Reflected-light and
atomic-update cases have not run. Thirty-one completed trace pipeline creations
account for 704992.5 ms (6179..40723.3 ms each), so accumulated pipeline readiness
consumes the lease. The underlying native compiler cause remains unresolved;
these records do not establish a permanently stuck compile or attribute bug 45.
No assertion, feature subset, readiness wait or lease was changed, and the failed
command was not retried. This is an open bug, not a busy-machine waiver or pass.

Owned receipts: .review/mesh-checkpoint-compose-native.log and process snapshots
mesh-checkpoint-native-processes[-late|-deadline].json, including full command
lines and parent PIDs. At the deadline the GPU lock reported this as its sole
active holder, with lane-U's bug45-dawn-localize and lane-A's mipmap probe queued.
The process tree was killed and the lock released. Raw process snapshots remain
private in this worktree. Durable summary: [mesh checkpoint receipt](whitepaper/results/review-99-mesh-build-checkpoint-20261109.json).
The earlier unattributed WebGL2 timeout remains a distinct bug; this native run
cannot supply its missing phase attribution. The separate unchanged compatibility run passes all 32 subsets, reflected RGB RIS shadows and atomic update on WebGL2/Vulkan; page completion is 12589.7 ms. The earlier WebGL2 timeout did not recur.

The later local vertex-attribute shader passes the same complete composed
WebGL2/Vulkan suite under the unchanged twelve-minute lease. The earlier
WebGL2 timeout did not recur on either checkpoint or attribute inputs. Native
composition was not retried; its readiness failure remains open.
- Bug 45 PARKED (rule 21): native path-tracing compiler pressure and CPU/GPU camera rounding remain unresolved; native split work retained on bug45-native-split at 333a02a44 for the fix phase.
- BLAS landing dependent-gate repair: controls/globe had a manually ordered umbrella export and lacked its generator banner; node scripts/umbrella.mjs restores canonical output, covered by tests/umbrella.test.js.
Fixed 2026-11-10: GPU package-runner owner collision (batch 243). Unrelated worktrees previously shared the generic check owner and were serialized despite free slots. Both serial and parallel admission now use a stable digest of canonical worktree identity, retaining one slot per worktree and distinct suite labels. Regression: tests/gpu-suite-owner.test.js reproduces the parent runner collision with CPU-only admission and checks independent owners; scheduler policy and GPU assertions are unchanged.
- BLAS dependent-gate repair: React bindings/instances commands served rooted fixture URLs from the package directory and returned navigation errors. Commands now select the repository root; packages/react/tests/browser-scripts.test.js fails before repair and checks the browser fixture class.

Fixed 2026-11-10: Batch 243 outside scope. Current complete GPU plan passes browser registration and chain validation; original repairs: d7be06653. Regression: tests/gpu-browser-registration.test.js and tests/modern-extension-suite.test.js.
- Batch 172 clean-main atmosphere check (948fc52e5): native passes; WebGL2 fails zero-cloud transparency before reaching restoration (expected hash 1630307923, actual -1597066215), with no page errors. Repro: node packages/sciviz/tests/atmosphere-browser.mjs. Existing retained atmosphere/GPU-flow render state failure is baseline, not calculator-induced; exact root cause remains in the atmosphere/compatibility owner. Preserve all assertions; rules 21/22 defer it.

Fixed 2026-11-10: Batch 265 integration observation. GPU planner registrations and command ordering are repaired on main (af4b357e1, d7be06653). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.

### Mesh repair validation boundary (batch 224)
The repair entry sanitizes invalid soup positions/faces and compacts discarded vertices before calling the strict hole-fill API. The nonfinite-position fixture in packages/mesh-edit/tests/repair.test.js retains the regression; validation is not weakened. Remaining open borders, zero volume and geometric reconstruction limits are explicitly reported and documented in docs/limits.md.

Batch 210 job 2: no open playback defect found by the loop, endpoint, event, promise, subscriber/owner cancellation and failed-attachment regressions. The umbrella generator restores the pre-existing missing selection/hit-details alias; the existing umbrella test guards generated consistency.


Batch 207 object actions: generated dependency-graph instances still use export-frame world placement (objects.py keeps these as roots); animating the generating collection/pivot does not yet resample instance transforms. Repro: animate a collection-instancing empty and export with object_animation=True; ordinary mesh/empty object actions and hierarchy are covered.
Fixed 2026-11-10: Batch 205 gate observation. Current complete GPU plan passes browser registration and chain validation; original repairs: d7be06653. Regression: tests/gpu-browser-registration.test.js and tests/modern-extension-suite.test.js.

Fixed within batch 205: FBX previously selected only the first image hook, so an image converter later in extensions was unreachable. The reader now tries registered converters in order; packages/fbx/test/textures.test.js covers PBR plus textures in either order.

Batch 206 PointInstancer build: no open static-expansion defect in the schema oracle and array/budget tests. Playback channels for vectorized instance arrays are outside the static expansion entry.

Batch 206 capture regression: scripts/modern-usdz-tests.js used to read the rigged frame before the compatibility queue had loaded compute and replayed its commands, yielding identical images. Each animation capture now awaits queue.onSubmittedWorkDone, without extra renders, retries or altered assertions. The existing three-pose check fails before this change and passes on WebGL2 after it; native WebGPU also passes. The USD suite uses a free port so a different suite cannot occupy its dev server port.

Batch 259 editor: moving only a rendered canvas left its accessibility mirror in the old parent and produced page overflow after viewport changes. The optional editor now moves/restores the adjacent mirror with its canvas, uses a positioned preview container and preserves the original sibling location. editor.test.js covers early/late mirror creation and repeated cleanup; editor-browser.mjs covers desktop-to-320px resizing, invalid-draft save rejection and real download/open.

Batch 210 job 3: repaired default-loop zero-duration actions dropping one-key state, sparse categorical values bypassing Array.some validation, numeric result-buffer coercion, and restoration into a disposed model Mesh. Repros and regressions are in packages/animation/tests/discrete.test.js; before logs are test-results/batch210-discrete-{unit,lifetime}-before.log. No additional open categorical-track defect found by the typed sampling, editing, binding, weighted-action, disposal and real-Fox visibility/text checks.





Batch 243 job 2 historical compatibility timeout: the earlier renderImage call rejected at its unchanged 120000 ms AbortSignal, without per-case phase evidence. The rebased canonical native-then-compatibility suite and separate instrumented/cache-disabled compatibility diagnostics now pass every original case and bound. Cause remains unisolated; the shutdown fix was already in the failed checkpoint. Phase messages are retained for the next natural reproduction. No runtime repair or timing waiver is claimed; follow-up remains in private finish-later tracking under rule 22.

Batch 207 lightmap build integration: Blender's curated bundle external list did not include the new owning lightmap/imported entry, so it duplicated the texture runtime. Fixed in the same job; regression lightmap.test.js checks the bare package import. Generated geometry instances are not independently baked: export real mesh objects for spatially distinct irradiance (repro: collection instances under different shadows; cause: Cycles bake operates on original view-layer mesh objects).

Fixed 2026-11-10: Batch 246 gate inventory finding. GPU planner registrations and command ordering are repaired on main (d7be06653). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.

### Fixed: repair alias during batch 224 rebase
The job 3 shared-manifest conflict resolution took the upstream umbrella manifest, leaving the new repair source facade without its export mapping. Regenerate the umbrella from all package exports after resolving the manifest, before the rebase commit, rather than accepting one side's generated JSON. Job 4 restores the mapping together with the new hull entries. Regression: tests/umbrella.test.js validates manifests, binding identities and import maps; the lane's local merge helper now regenerates before continuing a rebase.

- Batch 265 dispersion follow-up: the full native grid passes; the full compat grid reproduces main failure 9 at the unchanged exact-zero bound (4x live reset, max 0.000244140625). Individual complete clean-main 6ab64e777 and exact-parent adc342df4 runs passed, while historical main 2a74c14e3 has the same recorded failure. Across the complete 57-render 4x prefix through reset, parent and feature have identical GL call counts and paired command-input hashes, and both traced runs pass. This is still state-sensitive and its backend root cause remains unresolved; it is not a feature-only GPU-work difference. Proof and limitations: whitepaper/results/batch-265-dispersion-parent-trace.json. Retain the exact test and finish the pre-existing defect in the fix phase under rules 21/22.
Batch 206 implicit shapes: no open defect in 22 OpenUSD extent cases, analytic normals/winding, attribute preservation and preallocation budget checks. Dimension time samples are read at the first pose, as documented for static geometry.
Batch 205 large: existing default byte-budget errors retain their exact wording, while enabled custom caps report the configured range. packages/fbx/test/errors.test.js and worker.test.js retain page/worker error identity; large.test.js covers caps without reducing imported geometry.

Batch 207 meshopt: no open defect found in the requested compression row. Existing synchronous codec calls only observe cancellation between sections; files need the optional reader, with bounds/stream regressions in meshopt.test.js.

Batch 246 job 2 closes the importer gaps for skipped image layers, text and templates, plus sparse image-collection gid spans. Reproductions and root-cause checks are in tiled-full.test.js. Existing unregistered browser-inventory drivers remain owned by their lanes.

### Batch 261 GPU labels
No open correctness defect identified in this entry. Browser evidence includes shader validation, 100k batching, constant pixel extents, culling and disposal on WebGPU, native WebGL2 and compatibility WebGL2. Incremental upload work is recorded privately for the finish phase.
### Batch 206 API summary repair
The post-push full API check caught an incorrect merge of the generated summary: the aggregate omitted the unscoped margoengine row (97 instead of 98 packages) and retained upstream stale table cells. The initial corrected snapshot has 98 packages, 1073 entries and 9741 names; current totals are generated in api-surface.md. tests/api-report-scope.test.js now checks table totals including the umbrella; the existing full API check remains authoritative for each row. This is a fix forward for the generated index, with no runtime or API implementation change.


Batch 232 moon: no open defect found in the new lunar layer. CPU regression covers
texture replacement/restoration/disposal, malformed inputs and aborted fetch;
`packages/scenery/test/moon-gpu.mjs` proves phase, earthshine, map orientation and
depth masking. The visual approximations are listed in docs/limits.md.
`loaders/geo` (batch 202 fix-phase follow-up): a pre-aborted signal reaches `buildGeo` only after binary decoding in `parseShapefile` and `parseMVT`. Repro: call either parser with `signal: AbortSignal.abort()` and truncated bytes (empty SHP or MVT byte 128); both report code truncated before aborted. Cause: the binary entry functions lack the initial throwIfAborted check already present in the text path. Decoding/cancellation quality gap under lane rules 21/22; add entry checks and a regression in the fix phase.
- Batch 213 MToon integration: two independently loaded blended models with crossing renderQueueOffsetNumber values retain scene model order; the material adapter orders primitives only inside one model. Global model queue scheduling is a fix-phase follow-up.
- Batch 213 MToon integration: an alpha-cutout shadow caster with a spatially varying UV animation mask uses the static alpha UV while beauty moves; optional shadow sampling does not receive the material's mask/time bindings. Beauty, normals, emission and hull animation are built; shadow integration is a fix-phase follow-up.

- Existing gltf-pro GPU driver: test-extensions-browser.js reads argv[2] as a name filter, so --compat selects zero checks. Use MARGO_COMPAT=1 with no filter for the full compatibility run; driver repair waits for the fix phase.
Fixed 2026-11-10: Existing physical-material compatibility limit physical compatibility sampler plan (aa3e347da). The unchanged MARGO_COMPAT=1 scripts/gltf-pro-materials-gpu-check.js passes every extended/transmissive and complete-lighting pipeline plus all 64 iridescence and 96 direct BRDF cases, with zero GPU/page errors. No shader, assertion or tolerance changed in this sweep.

Batch 246 job 3: no open plane-rendering defect found by the matrix, depth and real-GPU ray-plane checks. Existing cross-lane browser-inventory findings remain listed above.


### Batch 261 distance layout
No open correctness defect identified. Regression covers layout scale reaching DOM transforms without distanceScale, boundary visibility, stable-frame writes and opacity restoration; GPU browser checks cover real DOM extents and recovery on both native rendering backends.

Batch 266 input helpers: alias-release and modifier-change regressions are covered in controls-extra.test.js; no additional known defect found in this job.

Fixed 2026-11-10: Batch 266 gate finding. GPU planner registrations and command ordering are repaired on main (d7be06653). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.

Batch 266 fixed: PresentationControls tested only the root mesh, so local dragging a React group never started. The owning controls entry now tests live descendants, excluding detached or unrelated meshes; controls/tests/presentation.test.js and the local-drag browser fixture cover the cause.
### Batch 231 textured scatter

Fixed during construction: general 4x4 conjugation can round an affine last-row 1 off unity for non-dyadic node scales. The attachment restores the mathematically exact affine last row before passing it to PBRInstances; textured.test.js retains a non-dyadic scaled-node regression. No open textured-scatter defect remains.

Fixed 2026-11-10: Build-phase tooling gap. GPU planner registrations and command ordering are repaired on main (d7be06653). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.


### Batch 229 job 1: imagery evidence
No open defect identified in the job: native and compatibility clipmap, RVT and planet checks use exact XYZ/WMTS/GPU image equality, ordered composition, alpha, brightness and bounds. Operational and resource limits are in docs/terrain-imagery.md.
- AnimatorGraph snapshot follow-up (batch 211, rules 21/22): capture graph.animator during a graph fade, change a bool/trigger or take a different interruption, restore the Animator snapshot and update. Graph bools/triggers and the selected interruption source/policy live in the controller and are outside AnimatorState, so restoring playback alone does not rewind graph decisions. Add a graph-level snapshot in the fix phase; live layer, tree and transition features are built.

### Batch 261 label clusters
No open correctness defect identified. Independent all-pairs component tests include negative cells, grid seams, chains, minimum size and zoom splitting. Renderer tests show camera zoom restores individual labels; browser tests show count-bubble centroid alignment and logical zoom recovery on native WebGPU and WebGL2.

Batch 266 portal ownership regressions: explicit RenderView replaces the implicit main view, avoiding a duplicate canvas draw; StrictMode, nested cameras, target resize and last-owner cleanup are covered by portals.test.js. No new open defect identified in the tested paths.
### Batch 231 surface scatter

No open defect in the new placement entry. Its CPU and real-data GPU comparisons cover world area, painted density, source attributes and normal alignment. It explicitly refuses nonfinite sampled attributes rather than returning unusable matrices or colours. Existing geometry/sample accepts nonfinite UV/colour values and can return NaNs (repro: a triangle with all UV.x = NaN or colors[0] = NaN); its constructor checks attribute lengths but not these values. That separate sampler validation gap remains for its owning package in the fix phase; the new surface entry rejects it before returning.

- FBX surface control-net animation (batch 205 follow-up): connect a Skin or BlendShape to NURBS/Patch geometry, as in surfaces.test.js. Generated surface vertices have different rational support from source control points and general bone transforms cannot be represented exactly by a single glTF vertex bind position. Import explicitly refuses with a polygon-bake remedy; exact animated control-net baking remains follow-up work.
Batch 247 job 1 fills the missing painted-geometry input: optional SDFScene2D now rebuilds exact GPU distance fields, casts opaque pixel shadows and emits the painted color through GI. Regression source: packages/lighting2d/tests/sdf-regressions.js. Painted diffuse reflection and temporal history remain the next explicit batch job, not an existing source claim.



### Batch 218 job 1

The former crossfade-only live composition gap is closed for all four built-ins, greyscale masks and trusted custom WGSL. CPU lifecycle/validation tests and full-live-browser pixel fixtures cover the added modes; the existing live recovery and resize checks remain.

Fixed for this landing: compatibility render pipelines accepted explicit layouts missing statically used resources, and async validation also emitted uncaptured errors. render.ts now checks the reflected resource interface and routes async failure only to rejection. device.test.js and compute-limits.test.js retain the regressions. The global WGSL corpus also lacked labels shaders already on main; a scoped real-GPU recording refresh now covers it for the owning package CPU gate. Recorded labels shader ownership is identified by exact equality to packages/labels/src/gpu-shader.ts.
Batch 213 landing correction: the job 2 local rebase helper took maxima for unrelated size ceilings, restoring eight older limits and six stale umbrella keys. Job 3 restores the incoming main limits and removes those stale keys; the helper now applies only the job delta to incoming main, with a three-way check. No runtime, test or tolerance was changed for this correction.
- Build gate concurrency finding (batch 222): running quality while React's subpath tests create and remove packages/react/tests/.subpaths-* can make quality's untracked-file snapshot read a deleted orbit-cube.js (ENOENT). Source: repoFiles includes temporary test outputs that disappear before cleanRoomGate reads them. Repro: run those CPU tests concurrently with quality; serialize the gates during the build phase. Owning quality scanner cleanup waits for the fix phase.


Batch 216 job 1: no open physical-lens defect found. Invalid constructor settings, live edits and tracked focus reject before camera/DOF output writes; physical-lens.test.js covers this contract.



- Batch 207 live-node quality follow-up: Noise uses an independent Margo hash/gradient ordering, so the same Blender settings produce different stochastic texels; socket curves are sampled per frame and interpolate linearly between samples. Reproduce by comparing the nodes fixture with Cycles noise or seeking halfway between non-linear keys. All requested node families and live controls are built; exact stochastic and subframe curve matching remain finish-phase quality work (also in private/handoffs/finish-later.md).

### Batch 261 routed callouts
No open correctness defect identified. The planar assignment replaces independent crossing-prone source/slot connections; a two-point fixture proves label reordering. Independent segment intersection/overlap checks cover integer, fractional, collinear, coincident, enormous and subnormal inputs. Browser tests check SVG-to-DOM endpoints and stable-frame writes on both native rendering backends.

### Labels GPU finish-phase edge cases (batch 261)
- In-flight font cancellation: start GPULabelLayer.create with a Font whose load promise is pending, then abort its signal. Creation stays pending until Font.load resolves because cancellation is checked only before/after loading. Make the caller's wait abortable while retaining shared font loading in the fix phase.
- Canvas borders: with a 400 px drawing content width plus a 3 px CSS border, GPU glyph CSS sizing uses the 406 px outer bounding rectangle and shrinks the intended size by 400/406. Cause: GPULabelLayer.draw derives CSS dimensions from getBoundingClientRect, including borders. Use the transformed content rectangle in the fix phase.

Batch 238 formats: no open format defect found by the malformed-input, real-data getter, SH and PLY round-trip checks. Existing transformed-bitmap alpha precision follow-up above remains outside these CPU entries.


### Batch 218 job 2

The eight requested transition presets and their finite parameter contracts are built for frozen and live composition. Independent gradient pixel checks cover each preset in four cardinal directions, endpoints and intermediate eased progress at 1x/4x. No requested preset is deferred.

### Batch 229 job 2: vector coverage evidence
No open defect identified in the job: the new entry covers metre widths, polygon holes, projection, live updates, imagery ordering and exact restoration on both GPU backends. CPU tests reject coerced numeric strings and preserve old state after malformed/over-budget updates. A draft display-pixel classifier incorrectly assumed that PBR Neutral kept saturated primary channels at zero; the fixture now uses independently rendered primary references through the actual display transform, retaining exact color matching.
### Fixed: GI owning-scene disposal; completed painted/temporal coverage (batch 247 job 2)
GILighting2D previously removed a plugin by name on its saved engine, which can name another active scene. It now resolves its own registration with sceneOf(this) before removal and leaves detached or same-name plugins alone. sdf.test.js contains a regression that fails on the former dispatch. Painted surfaces now carry reflected radiance for every finite bounce order, and exact change detection guards persistent intervals; gi-history-regressions.js compares against independently authored analytic faces, checks cached GPU data remains untouched on static frames, and rejects stale history after scene edits. Earlier GI visibility/energy repairs remain tested without changed tolerances. Historical README correctness exceptions are explicitly owed, with no README edits during build phase.

Batch 216 job 2: no open defect found in orthographic follow, screen framing, projected-sphere group fit or height blends. Mixed projection transitions switch mode at the endpoint, as documented in limits; continuous interpolation between projection families is outside this orthographic job.

Batch 266 effects regressions: explicit Trail target=null stays in native manual mode; new source hooks retain decal parent transforms exactly once. effects-extra.test.js and the native pixel-oracle fixture cover these cases. The kit test fake now declares the existing meshRuntime export used by the new entry; none of its behavior assertions changed.

Batch 212 stereo: no open defect found in the tested pan/width matrix or bus lifecycle.
Batch 212 stereo: no open defect found in the tested pan/width matrix or bus lifecycle.
Batch 212 stereo: no open defect found in the tested pan/width matrix or bus lifecycle.



### Fixed: batch 217 cutscene compatibility replay fixture

The VFX replay fixture recorded early frames on the CPU fallback while the lazy WebGL2 GPU route was loading, then replayed on that route. Frame 40 differed in 182 particle words by a few float ulps, with identical picture and live count. The fixture now waits for actual route and pipeline readiness before reset and capture. The unchanged exact-byte and pixel assertions in packages/cutscene/tests/vfx-browser.mjs are the regression; no engine arithmetic or tolerance changed.

### Resolved: batch 200 meshless scene refusal
The light loader rejected every model without a renderable primitive before sceneExtras.finish could expose cameras or lights. The optional scene-data entry now opts into empty scene acceptance through GLTFExtension.allowEmptyScene; strict root behaviour and malformed-file rollback remain. The two meshless tests in packages/gltf/test/scene-data.test.js fail on the parent and pass with this change.

Resolved by Job 0 conflict-marker hygiene guard: shared docs on origin/main 8ee384c7e retain nested merge markers from mixer/cutscene rebases (for example docs/clean-room.md, Batch 216 onward); cause is prior conflict markers retained during append resolution. Repro: search lines starting with seven <, = or > characters in the six shared docs. All content lines from both sides are preserved; hygiene now rejects this class before landing.
Batch 248 job 1: overflow/fit built with CPU and both-backend clipping coverage; no open defect identified in this job.

- Batch 231 scope finding: `node packages/culling/test/gpu/meshes-occlusion-check.mjs --compat` fails its native Hi-Z draw-count assertion (1509/1509 behind the wall). Cause: existing CulledMeshes compatibility route intentionally performs frustum-only culling (`src/compat.ts`), separate from the new DepthPyramid API; software `culling/webgl2` is a separate API. New scatter/occlusion performs real Hi-Z on both backends. Deferred legacy parity per build-phase rule 21.

### Batch 244 job 1
The camera rig is built with direct CPU trace and GPU overlay regressions. No open defect identified in this job's scope; other known defects remain in their existing entries.

Fixed 2026-11-10: Outside batch 244. Current complete GPU plan passes browser registration and chain validation; original repairs: 326c67544, d7be06653, f235e21f0. Regression: tests/gpu-browser-registration.test.js and tests/modern-extension-suite.test.js.

- Batch 236: origin/main 42c1cbdac already contains conflict markers in known-bugs.md and whitepaper/reproduce.md; reproduce with rg for conflict markers. Cause: committed shared-doc merge text. Outside weather scope, deferred under rule 21.
Batch 212 analyser: repaired bus insertion deleting internal output taps and shared-document merge markers, both covered by regression tests. No open tested defect.
### Batch 274 gate environment: Firefox worker matrix
Repro: node packages/worker/tests/browser-matrix.mjs (default Firefox). On this Windows host the existing Playwright firefox-1555 executable fails to spawn with UNKNOWN before any page or engine code runs. Cause is the browser launch environment, not a worker assertion; the executable is present. Chromium runs the same unchanged worker/mode, buffer-transfer, red-pixel and disposal assertions through the registered script. Firefox launch diagnosis remains owed.

### Batch 228 job 1 survey tools
No open defect found in the new volume/profile computations; boundary, transform, real scan and both-backend rendering regressions are in the points tests. Snapshot and resident-data limits are in docs/limits.md.

- Incoming main 8ee384c7e retains nested merge markers in shared docs (repro: search ^<<<<<<<, ^======= and ^>>>>>>> in docs/clean-room.md); cause: prior lanes committed unresolved document merges. Outside points scope; preserved for the fix phase.



### Fixed: batch 217 inherited API summary merge boundaries

Concurrent main contained nested conflict markers in docs/api-surface.md. Scoped api:update refused it, and api:check failed its generated-summary comparison. A full api:update regenerates the summary from the built exports; no unrelated API implementation changed. scripts/api-report-scope.mjs already rejects marked summaries, and the normal api:check remains the regression gate.
Batch 222 job 2: authored material-chain checks found no remaining defect. External KHR_materials_variants and a material LOD controller both selecting a primitive require caller coordination; a unified selection policy is a fix-phase quality follow-up.

Batch 222 job 2 scope receipt: msft-check passes native and compatibility, including later UV2, retained vertex buffers and original material restoration. Shader-review and extension checks pass both backends. The broader compatibility materials permutation reproduces the already-recorded batch-273 16-fragment-sampler overflow (test-results/batch222-msft-gpu.log); its shader builders are unchanged by material-index/UV preparation work. Keep that separate owning-lane defect open under lane rules 16/21, with no altered assertion or accepted difference.
Batch 248 job 2: selection rectangles built; no new open defect identified in the job.

### Batch 244 job 2
The edge-directed 3x/4x scaler is built with analytic and GPU oracle regressions. No open defect identified in this job's scope; algorithm ambiguity and external-variant differences are documented in limits.

Batch 244 landing repair: the existing umbrella generated-file regression exposed manually appended culling/depth and scatter/occlusion exports with missing generated banners and noncanonical manifest order. Regenerated with scripts/umbrella.mjs, preserving both exports; tests/umbrella.test.js is the existing regression.

### Batch 196 panorama

No known open defect in the completed panorama entry; cancellation observes the pending map rejection before unmapping, covered by panorama-browser.mjs.
Fixed 2026-11-10: GPU plan registration. GPU planner registrations and command ordering are repaired on main (f235e21f0). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.
Batch 248 job 3: prebuilt RGB field reduction was the cause of rounded MSDF corners; fixed by sampling RGB before median, covered by interpolation and GPU regression tests.
Batch 212 fx: full-wet mixing now preserves processed signed zero, covered by the quantisation regression; no open defect found in tested equations or rendered chains.


### Batch 218 job 3

The requested GLSL transition signature importer is built with original semantic fixtures and native GLSL pixel comparison. Parser/typed lowering tests cover macros, overloaded helpers, uniform shapes, matrices, structs, arrays, swizzle writes, loops, out/inout and branch side effects. The native oracle embeds user uniform declarations before its sampling helpers so sampler aliases remain in GLSL lexical scope. Near-boundary float sampling differences are documented in Limits rather than hidden by a larger pixel tolerance.

The importer also has regression fixtures for struct members named like vector swizzles and indexed output addresses evaluated once. Struct type resolution now precedes swizzle decomposition; copy-out reuses the address evaluated before the call.

Native reference defect found during GLSL import testing: on the recorded NVIDIA ANGLE WebGL2 backend, an out argument points[j++].x increments j again during copy-back. Repro is indexed-output-once in glsl-fixtures.js: native direct form yields j=2 while GLSL ES 1.00 section 6.1.1 requires a call-time l-value reused at return. Margo evaluates the address once. That fixture uses an independently written native oracle with the address explicitly stored before the call, preserving the specified semantics; the translated input retains its indexed side effect. No input is special-cased in the importer.

GLSL importer fix-phase syntax edge cases (batch 218, rule 22): uniform float weights[2+2]; followed by a transition rejects at parsing even though the length is a constant expression. Cause: GLSLParser.array currently admits only literal or named lengths. Helpers with unnamed parameters also reject because parameter parsing requires an identifier. Canonical numeric/named array lengths and named helper parameters work and are tested. Expand these source forms and their negative/property-based corpus in the fix phase; the transition import API and all requested modes are built.

### Batch 244 job 3
The CRT composite-video look is built with signal invariants and native/compatibility GPU readback regressions. No open defect identified in this job's scope; the intentionally stylized baseband model and unshifted glow ordering are documented in limits.


Batch 238 job 3: no open reader defect found by real range extraction, cancellation, malformed manifest, v3 and both-backend GPU checks. Fixed owning LOD pool slot exhaustion for uneven nodes while adding structural sources; maxNodes regression in lod-sog.test.js covers it.

Batch 238 dependent gate finding: npm test --workspace @margoengine/sciviz runs glyph-data.test.js from the package directory although its readFileSync paths start at repository-root examples/assets/sciviz/glyph; repro fails ENOENT displacement.e. Cause is the test working directory assumption. All 281 tests pass unchanged from the repository root; suite launcher repair belongs to the fix phase.

### Batch 196 stereo

No known open correctness defect in the completed output modes. StereoRig's initial constructor geometry now matches StereoOutput settings before the first render; stereo.test.js retains the regression. The automatic resize resolution follow-up is recorded privately for finishing polish.

Batch 248 job 4: cylindrical and path text built; numeric and pixel checks cover the new paths.
Batch 212 extended dynamics: no open defect found by curve, envelope, linked-channel and compensated-crossover tests.
### Fixed: scalar volume display range destroyed gradient classification
Before batch 173, CPU halfVoxels and the GPU packing shader clamped normalized scalars to [0,1] before differentiation. A linear field crossing a narrower display range therefore became flat outside that range. Preserve signed normalized scalars in binary16 (saturating only at its representable extrema), and clamp only classifier coordinates. Regression: packages/sciviz/tests/transfer.test.js checks uploaded half-float values; transfer-browser.mjs accepts the true physical gradient and rejects a disjoint gradient throughout the linear field on both backends. Disposed VolumeLayer also now reports valid=false, so editor/binding cleanup after layer disposal is safe; the same unit regression covers that sequence.

### Fixed: PNG export read a stale GPU frame
Figure.toPNG waited for figure updates but not restored drawables or submitted GPU work. A compatibility queue waiting for lazy compute/culling could therefore leave the prior image on the canvas when export snapshotted it, including after device restoration. Await renderer readiness, copy the freshly rendered canvas texture to an owned readback buffer before yielding, then await mapping. This handles both deferred replay and native canvas expiry without changing view/picking state. Regression: transfer-browser.mjs deliberately defers a blue-frame submission behind the existing red frame and requires the exported PNG to be blue, with no sleep or timing threshold.


Batch 243 job 3 cold compatibility compilation defect: canonical mesh-pbr-lobes-browser.mjs now passes all six native and all six WebGL2/Vulkan cases at the original bounds/deadlines. An extra run with Chromium --disable-gpu-shader-disk-cache still reaches ready, completes GL compile/link and submits its first draw, then renderImage rejects at its unchanged 120000 ms signal (last combined diagnostic 231.9 s including setup/shutdown). GPU-process CPU/memory growth with little sampled GPU load supports deferred driver compilation/resource pressure; the exact compiler cause is unisolated. Repro: run the same fixture with that extra Chromium launch argument and retain create/ready/image and GL-call phases. Six source-reduction rounds did not close this defect; investigate split transport programs after the build phase under rules 3/21/22, without weakening the test. Receipt: whitepaper/results/batch243-mesh-lobes-20261110.json.


Batch 212 pitch: no open defect found in transposition ratios, source-clock/quantum invariance, feedback, prefilter or lifecycle tests. Window coloration and residual aliases are documented algorithm limits.

Build-phase follow-up (batch 212, outside pitch landing): hold a disposed Bus after inserting a stage; Bus.teardown clears inserts but retains its insertEdges node-reference array. Clear those references in the fix phase and prove released ownership.
Build-phase follow-up (batch 212 analyser): queue a meter report, call reset(), then deliver the queued report; read() can briefly show pre-reset frames because messages carry no reset generation. Add generation-tagged reset/report handling in the fix phase.

### Batch 214 scope
Chain avoidance has no known defect from its correctness cases; bounded search and static-only limitations are documented in limits.md.

Fixed 2026-11-10: Batch 214 unrelated GPU planner repro. GPU planner registrations and command ordering are repaired on main (f235e21f0). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.

Batch 238 job 4: no open modifier defect found by independent SH/position/opacity probes, repeated seek, lifecycle and real-image restoration checks. Source centre/opacity changes require explicit setRest, as documented; RGB, SH and covariance remain live inputs.

Batch 238 finish-phase validation gap: a streamed manifest with top-level model "2dgs" and chunk metadata omitting model is treated as ordinary 3D. Repro: add model:"2dgs" only to a valid lod-meta.json and open it. Cause: the adapter currently validates the per-chunk SOG model, but ignores the manifest model; propagate/reject that unsupported model before loading images. This does not add 2D Gaussian rendering to the requested 3D reader.



### Fixed 2026-11-10: batch 217 browser shutdown blocker (a false survivor)

The scroll job on batch-217-scroll (6660e0bb7) passed render/VFX/editor/curve interactions, then browser.mjs:344 raised SHUTDOWN_TIMEOUT for Chromium PID 109224; the browser host recorded it still present 677 ms after termination. Repro: private/batch217/scroll-gpu.log of lane P. Cause: the waiter `waitSignaled` (scripts/support/shutdown.mjs) reported any pid whose start time it could not read as a survivor, and it could not read the start time of a pid that named no process of ours any more. A survivor proven within the 2,000 ms grace is only possible this way (a real one is reported after 120 s). Fixed in the waiter; see the entry "Open, outside Margo, worked around 2026-11-10" for the measurements and tests.


### Fixed: batch 217 nested gesture and focus ownership

The base editor cancels pointerdown, so the browser suppresses native mouse/dblclick events, and its broad contains(focused) redraw check also treated focused child items as its own. This prevented native nested opening and moved keyboard focus to the parent after a child edit. The optional editor recognizes stationary pointer pairs after the native pointerup transaction; the base editor restores only its own nearest-panel focus. nested-browser.mjs verifies actual double-click opening, one child key nudge, shared undo, subsequent primitive authoring and two-level playheads without bypassing input handlers.


Build-phase follow-up outside batch 217: numeric property targets named __proto__ (or constructor) use inherited dictionary entries in cutscene/src/cutscene.ts evaluate, unlike the new discrete handler's null-prototype maps. Repro: evaluate a numeric property track targeting __proto__, property x, value 1 at time 0; the inherited Object.prototype receives x because state.properties is {} and target lookup uses ??=. Replace numeric state dictionaries with own-key maps in the fix phase; do not change the discrete step semantics.

Build-phase documentation follow-up: current main already contains orphan >>>>>>> scatter merge-marker lines in clean-room.md, limits.md, whitepaper claims/reproduce and readme-owed.md (28bc61377, 654098cc1, d70b0d2eb). Their originating shared-doc merge left closing markers after content was combined. These do not alter batch 217 implementation or its generated API checks; clean the document merge artifacts in the fix phase.

Batch 248 job 5 precision follow-up (rule 22): FontVariations normalizes in floating point. Repro: a linear wght axis min/default=200, max=900 at 350 produces normalized 0.21428571428571427 before avar instead of the specified fixed-point 2.14 result 0.21429443359375. Cause: the normalization path omits the OpenType 16.16 and final 2.14 round trips. Unhinted outlines/advances can differ slightly from a fixed-coordinate rasterizer; no hinting or FeatureVariation conditions are consumed here. Fix phase: implement specified rounding and compare independent fixed-coordinate outline fixtures; preserve the existing floating-oracle evidence as an explicitly different reference.
Batch 240 job 1: box-model metadata must survive scalar worker and RGB-light world copies. Both adapters now forward the prepared model data; model tests exercise RGB attachment with a custom model. No open defect is accepted for the custom box-model job.
### Batch 235 job 1: ripple composition

Optional geometry effects propagate their bindings into GPU queries and caustic captures; capture pipelines invalidate when the surface shader changes. Regression: packages/water/test/ripples.browser.mjs checks query displacement and vertical velocity on both backends. No open defect identified in this job.
Batch 222 job 3 fixed atlas sequence aliasing: registering a static imposter and an ImposterFrames starting with the same image could access an absent contiguous slot; different sequences could inherit another fps. The cause was image-only atlas matching. Sequence identity is now part of reuse, with CPU shared-frame registration and two-rate GPU playback regressions. No remaining defect found in the tested fade path; target-only shadow/mask behavior is documented in limits.
Batch 222 job 3 gate repair: the inherited API summary omitted pixel/follow and retained an older package/export count. Full api:update regenerated the summary from current declarations; api:check now passes. No unrelated implementation changed, and the existing generated-report check catches recurrence.
Batch 222 job 3 outline fixture repair: a cold compatibility compute import can hold submitted selection work while a synchronous capture sees a blank canvas (including the unchanged mesh outline). CompatQueue.hold/drain correctly orders that work. The fixture now awaits queue.onSubmittedWorkDone for each state, then renders/captures in one task; all original outline pixel assertions remain. This fixes test synchronization, without changing rendering or shutdown support.

Batch 201 job 1: spec/gloss is built with CPU and both-backend GPU coverage. Fixed 2026-11-10: the inherited full physical-composition compatibility sampler limit was repaired by aa3e347da; its unchanged 160-case BRDF and complete-lighting pipeline check now passes with no GPU/page errors. The spec/gloss implementation and its assertions are unchanged.



- Voxel-net /rooms: reconnecting with a consumed room URL gets 1008, because its single-use admission nonce is removed when the player joins. The parked player retains capacity until the server resume timeout; obtain a new lobby reservation after it expires. Follow-up is resume-aware room authorization and separate account identity from seat identity.

Batch 214 job 2: no new defect found in legal-pose rejection; static-only scope and undefined twist at antipodal swing are documented in limits.md.


Fixed 2026-11-10: Batch 203 gate discovery. GPU planner registrations and command ordering are repaired on main (f235e21f0). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.

Batch 240 job 2: object-block tests cover source-disposal independence, invalid graph rejection before defining an id, per-instance culling and streamed removal. No open defect accepted for this job.

- Fixed during batch 242 replay build: Node Buffer.slice returned an alias and a Buffer-typed payload in decodeVoxelRecording. Payloads now copy into owned Uint8Arrays; replay.test.js mutates the original recording and requires decoded messages to remain intact.
Batch 270 job 1: no new open defects identified in space. The cutscene compatibility replay finding is resolved by the batch 217 fixture readiness correction already on main; no cutscene or browser lifecycle files changed here.
### Batch 235 job 2: flow maps

Dual-phase flow shading is optional and stays out of geometric wave captures, so WaveQuery and caustic capture retain valid layouts. GPU regression: packages/water/test/flow-map.browser.mjs composes flow with ripple geometry and queries, checks independent vector/normal values and fixed-time rendering on both backends. No open defect identified in this job.

- Batch 235 follow-up: force GPUDevice.createBuffer to throw during Ripples.readFrame after a successful render, then read again; the second call reports a pending read because the reading flag is set before staging allocation. Non-rendering allocation-error cleanup gap; fix-phase regression should inject allocation failure and move flag assignment after allocation.

# Batch 185 job 2

The previously missing volume and array storage forms are built in shader/compute-volume. No open defect was found in the new dimension, typed load/store, restoration and ping-pong contract; limits are recorded in limits.md. The small WebGL2 preview still requires escalation to the full compatibility backend.


- Fixed in batch 242 WebRTC test setup: the browser driver passed an array to closeAll, whose contract is an object, so successful assertions left handles open until the 90-second process-tree hard limit. The driver now supplies { browser, servers }; real RTC assertions and natural process exit both pass. Shared browser/shutdown code was untouched.

Batch 270 job 2: no new open defects identified in lifetime dynamics; exact reset and rotated zero-speed recovery have regression coverage.

- Batch 193 job 1: no open defect found in HueGrade; its display-linear domain, 64-point cap and HSV luminance difference are documented limits.

Fixed 2026-11-10: Batch 193 gate finding. Current complete GPU plan passes browser registration and chain validation; original repairs: f235e21f0. Regression: tests/gpu-browser-registration.test.js and tests/modern-extension-suite.test.js.

### Closed: draws into a 3D slice beside a depth attachment (batch 271 job 1)
On the WebGL2 layer, a render pass whose colour attachment is a slice of a 3D texture and which also attaches depth or stencil kept its clear colour: every draw was dropped. Cause, measured in raw WebGL2 on ANGLE Direct3D 11 (NVIDIA RTX A6000, Chrome): with a DEPTH_COMPONENT32F texture or renderbuffer beside `framebufferTextureLayer` of an RGBA8 3D texture, the framebuffer is complete, `clearBufferfv` lands and `drawArrays` writes nothing, with no GL error; the same draw into a 2D texture, an array layer, or the 3D slice with no depth attachment lands (30 probe rows, 8 failing, all 3D with depth). Fix in `@margoengine/webgl2-compat` (`Replayer.standIn`, `CompatTexture.sliceStandIn`): such a slice is drawn in a 2D stand-in of the same format and level size, loaded from the slice on `loadOp: 'load'` and blitted back on `storeOp: 'store'`. Regression: `volumeSliceDepth` in `packages/webgl2-compat/test/features.html` (native and layer must match, plus exact expected bytes); it failed before the fix (slice 0 red on the layer, green natively) and passes after. `node packages/creative/scripts/test-targets-depth.js --compat` now passes 164 surfaces.

Batch 270 job 3: no new open defects identified in the five birth shapes; uniform torus area and exact reset have explicit GPU regression coverage.

## Batch 185 job 3
The post/compute graph editor gap is built in shader/editor-pass. No open defect was found in its bounded expression, save/load and hot-reload contract. The source/target registry and floating-point resource requirements are explicit limits, not serialized GPU state.

- Batch 193 job 2: no open defect found in Grade/HueGrade cube export. Finite-grid interpolation and display-linear domain are documented limits; spatial and other Tonemap effects are outside the exported Grade.

Fixed 2026-11-10: Batch 194 job 3 reobserved physical compatibility sampler plan (aa3e347da). The unchanged MARGO_COMPAT=1 scripts/gltf-pro-materials-gpu-check.js passes every extended/transmissive and complete-lighting pipeline plus all 64 iridescence and 96 direct BRDF cases, with zero GPU/page errors. No shader, assertion or tolerance changed in this sweep.



- Voxel-net native Deno host: native WebSocket has no ping/pong observation hook. After clientTimeout without application input, the existing authoritative server can close an otherwise reachable idle client. Repro: join via serveVoxelDeno then stop client.update longer than clientTimeout. Cause: Deno handles control pongs internally and exposes only application message activity. Follow-up: native-provider liveness integration without inventing byte counters. Keep client.update running meanwhile.


- Batch 198 compass: attach CameraProjection and ViewCompass, request Top, then drag a cardinal. Continuous spin at that exact pole retains projection.up instead of turning the image because ViewCube.pole deliberately preserves a projection-owned valid screen up. Ordinary turntable drags, all cardinal clicks and menu actions work. Small rule-22 finish item: integrate arbitrary pole heading with projection-owned screen up without changing quarter-roll semantics or ownership.
### Batch 235 job 3: captured-matrix and water feedback contract

Environment now exposes the matrix of its last successful captured image rather than requiring consumers to read a mutable camera. captureOnly keeps capture active without drawing a second rectangle; water filters its draw from that capture to avoid self-feedback. Regression: environment/tests/mirror.test.js and water/test/reflector.browser.mjs prove snapshot identity, capture-only drawing, independent offscreen-object projection, exact unready fallback, SSR compilation and lifecycle.
Batch 270 job 4: no new open defects identified in scheduling; the prewarm comparison protects separate per-step uniform writes/submissions and exact reset replay.

## Batch 185 job 4
The missing texture-array node is built in shader/texture-array, including restoration through the existing material codec. No open defect was found in layer selection, binding sharing, fallback, colour-space sampling or lifecycle. Limits and backend evidence are recorded in limits.md.
Batch 184 transmission background list: no open defect in eight native/compat, sorted/weighted, 1x/4x grids including foreground, opaque occlusion and device restore. Existing materials dispersion live-reset compatibility defect is outside the unchanged transmission sampling/uniform paths and remains tracked above.
Fixed 2026-11-10: Batch 184 gate discovery. GPU planner registrations and command ordering are repaired on main (f235e21f0). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.

Fixed during batch 184 landing: materials KTX2 BC7/ETC/ASTC copies always uploaded a linear internal format, then requested an sRGB reinterpretation that WebGL2 cannot perform for nonrenderable compressed textures. The materials upload now caches a direct compressed upload per requested colour space on compatibility devices. Regression: materials/test/texture-formats.test.js checks both first-use orders, per-format views, reuse, update and disposal; the original GPU repro is mat-more-gpu-check.js with MARGO_COMPAT=1.

Batch 184 fast-gate continuation: the full materials dispersion grid passes 278 checks/254 captures per backend, including the exact live-reset comparison, in this run; the state-sensitive historical defect remains tracked until its cause is established. The unchanged compatibility wireframe suite repeats its documented mirrored/reference and live-toggle exact-hash failures (three 1x comparisons). Transmission background tests and the direct compressed-upload repro pass both backends; no wireframe code or assertion changed under build rules 21/22.

Batch 214 job 3: no open defect identified in multi-goal IK. The numeric-envelope regression ensures every returned scalar can be reused as a warm start or forward-evaluation input; nonlinear nonconvergence is explicit and documented in limits.md.

Batch 240 job 3: a new vertex-motion uniform must bind in translucent depth as well as colour and shadow passes. All paths now include it; the liquid GPU regression fails without the depth binding. GpuVoxelMesher now routes prepared motion/model/object types through the existing detailed-shape path, preserving unit-cell wave seams. No open defect accepted for the named wind job.

Batch 240 job 3 fixture readiness: compatibility chamfer/shadow compilation can outlast colour-pipeline readiness (10 observed shadow waits). The regression now waits for drawShadow to record its pass before the reference image, retaining exact zero-difference assertions. Explicit liquid motion on a non-liquid shape is rejected before definition instead of silently lacking a surface wave bit.
### Fixed: batch 192 object-velocity raster quantization
Subtracting an interpolated previous clip coordinate from the fragment raster coordinate introduced stationary false motion, exposed by a jittered 0.06-unit thin strip at 200x160 output and scale 0.5. Matching perspective interpolation of both clip coordinates fixes the owning TAA shader; viewport UV scale/offset retains multi-view coordinates. Regression: packages/taa/test/upscale-velocity-browser.mjs on native WebGPU and WebGL2 compatibility. No outstanding defect from this job.

### Existing legacy TAAUpscale 4x MSAA compatibility quality gap (batch 192 investigation)
Repro: install compatShim in packages/taa/test/upscale-browser.mjs and run the unchanged scene/assertions on the full WebGL2 layer. Native accumulation is 31.7646 dB against Lanczos 30.5408; compatibility accumulation is 30.8964 against the identical Lanczos 30.5408, below the fixture's native +0.5 dB bar. Awaiting each submitted frame makes no difference; the 1x diagnostic gives 28.2073 against 26.0547 and passes. The discrepancy is isolated to the 4x resolve/history path; the compatibility layer reads resolved multisample depth rather than individual coverage samples (device GLSL emitter), so depth-conditioned reconstruction differs. No test or threshold changed. The existing native GPU suite remains intact; the new velocity upscaler passes its own native and compatibility stereo, offset-viewport and thin-motion checks. Per rule 21 this legacy image-quality investigation is outside batch 192, with follow-up in the private finish-later handoff.

Batch 270 job 5: no new open defects identified in preset save/load; typed precision, signed zero, missing resources, pollution keys, exact simulation replay and pixel equality have regression coverage.

Fixed 2026-11-10: Batch 272 unrelated gate finding. GPU planner registrations and command ordering are repaired on main (f235e21f0). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.


### Batch 189: cloud/weather fallback support
No new rendering defect found in the full compatibility route. Earlier unsupported wording described the small preview; the new optional entry and native/compatibility browser coverage make the full-layer contract explicit. Existing cloud/weather approximation limits remain in limits.md.

Batch 189 landing repairs an incoming generated-export omission: post/pixelate existed in its owner package but margoengine lacked the facade and subpath export. Regenerated them with scripts/umbrella.mjs. The existing tests/umbrella.test.js fails on the missing alias before this correction.
### Fixed: batch 274 package GPU-suite discovery and serving root

The package GPU planner rejected the existing camera panorama and weather glTF suites because neither had a package test script. Register them in their owning manifests. Shape and decomposition suites also launched from the package directory while their URLs named repository-root pages, yielding HTTP 404; their scripts now enter the repository root, as the ComputeFrame suite already does. packages/compute/tests/gpu-registration.test.js checks discovery and command roots. No browser host or shutdown code changed.
The same landing repair registers the new main camera stereo and voxel font-mask suites, plus the streamed-SOG diagnostic already imported by the broad splat suite. These are executable package commands; no assertions or discovery rules are removed.

### Fixed: batch 274 basic-scene capture double close

The network capture closed its browser before hashing and reporting, then passed the same released browser to closeAll in finally. The second end request reached a released host and returned a null acknowledgement. Cache the version and relinquish the browser owner after the successful early close; finally still owns failure cleanup and the preview server. tests/basic-scene-network-lock.test.js executes the actual early cleanup segment with a strict single-close browser, failing before this change. The real network capture now exits successfully. The three protected browser/shutdown files are unchanged.

Batch 274 lazy-file inventory repair: the existing size-page regression found six built BVH/ECS/navmesh/scene-worker assets missing from LAZY_FILES. Register the existing load sites and measure the missing assets with the same raw/bundle, gzip and Brotli methods. No runtime package code changed for this inventory correction.
The rebased water GPU script also placed its build after the first test, violating the existing planner contract; move that same build to the beginning without removing or changing any test command. The planner regression fails on the old ordering.

Fixed in batch 274 decomp: zero-size factor stacks used to enter the matrix loop once per virtual matrix, allowing huge empty batches to stall. A zero-output work guard preserves empty factors with no kernel calls; packages/compute/tests/decomp.test.js checks the count (64 before, zero after) independently of time.

Batch 274 fix-phase polish: removing/corrupting the served decomp-kernel.wasm asset, or denying its compilation by CSP, can expose native filesystem/CompileError failures rather than a help-linked MargoError. Cause: decomp.ts load() translates HTTP failures but does not wrap readFile/instantiate failures. Numerical decompositions and normal asset loading are complete; normalize these failure types in the fix phase (rule 22).
Fixed batch 270 GPU gate registration: new parity checks ran only by hand because the vfx test:gpu manifest still listed its original five scripts. Added native and compatibility parity.mjs --all commands. Regression: packages/vfx/test/gpu-registration.test.js fails with the previous manifest (zero parity commands), and passes with both backend commands.
Batch 184 fur: fixed the new coarsest-stack sampling defect before landing. Sampling the outer shell at normalized height 1 made two-shell fur's only outer sample empty, because every procedural strand tapers before height 1. Shells now sample k/shells; CPU and native/compat 1x/4x GPU regressions require a nonempty two-shell result. The caster output regression also checks a comma before the added UV varying, for input structs with no trailing comma. Existing unrelated wireframe compatibility findings remain tracked under rules 21/22.
Batch 184 generated aliases: umbrella regeneration also supplies the missing post/mask alias for the already landed post entry; it is a generated facade and manifest mapping only.

Fur follow-up integration, outside the completed shell-controls row: combining an inherited displacementMap with FurMaterial and Shadows applies that map in beauty but not the custom caster, because the custom caster takes precedence over the ordinary map displacement. Fur also has no custom TAA velocity hook yet; TAA currently assumes a texture-displacement layout when that hook is absent, so the optional TAA combination is unsupported until its adapter is composed. Repro: createFur with displacementMap plus Shadows, or attach TAA while advancing wind time. Preserve shell controls and the existing exact-reset regressions while composing those optional hooks in the fix phase.


- Fixed in batch 173 job 4: ordinary, fusion and cinematic rays now stop at actual opaque scene depth. volume-depth-browser.mjs covers half-volume analytical colour, opaque geometry moving after progressive saturation, layer insertion order and actual device reboot on both GPU backends.

`quality/demand` (batch 195 job 1): no open defect found in coalescing, motion/load wake, nested animation and disposal tests; manual onFrame integration and explicit wake requirements are documented in limits.md.

Fixed while landing batch 195 job 1: main 72642362b retained an old VFX test:gpu line beside its fuller replacement with no separator, so every manifest consumer rejected JSON. Remove the stale duplicate and retain all parity cases. Regression: tests/integration-json.test.js.

Fixed batch 270 registration manifest merge: a text-only conflict resolver concatenated two package JSON property lines without a comma during the rebase onto an upstream dedicated parity script. The package manifest is now reconstructed as valid JSON, retaining the upstream script and placing both --all backend runs there. Existing test:gpu stays the original render suite, so CI does not duplicate parity runs. gpu-registration.test.js now checks all automatically discovered GPU scripts together with the same two-backend assertions. The lane resolver rejects other JSON conflicts for structural resolution, and landing validates changed JSON before a push.
Fixed 2026-11-10: Batch 186 gate finding. Current complete GPU plan passes browser registration and chain validation; original repairs: f235e21f0. Regression: tests/gpu-browser-registration.test.js and tests/modern-extension-suite.test.js.

quality/events (batch 195 job 3): no open defect found in motion policy, queued-input coalescing, asynchronous pick serialization, rejection or cancellation tests. Explicit notification of programmatic movement and no stationary-pointer polling are documented contracts in limits.md.

Batch 201 job 2: DDS source loading, retained mip uploads and signed/HDR fallback are built. No new DDS defect identified. The separately assigned batch-273 composed compatibility sampler overflow is repaired in the same lane, with its strict assertions unchanged.

Batch 177 job 1: the finite-supertriangle design was replaced before landing by convex hull initialization plus Delaunay legalization. Thin-domain coverage and empty-circumcircle tests retain the regression; no open contour2d correctness defect is known. Inline label collision avoidance is a future layout quality improvement documented in limits.md.

Fixed 2026-11-10: Batch 177 out-of-scope gate finding. GPU planner registrations and command ordering are repaired on main (f235e21f0). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.
Batch 184 packaging follow-up: the fur conflict resolution locale-sorted the generated umbrella export keys, violating its canonical package-group and owning-entry order. Upstream regeneration has restored the canonical map; this follow-up adds packages/margoengine/tests/export-order.test.js to catch that conflict-resolution class independently. No export key, target or condition changed. Incoming main f9ff16e06 independently contains invalid packages/vfx/package.json JSON: a missing comma between two test:gpu properties (lines 34-35). That pre-existing parse error blocks the full umbrella generator/build/API/quality recheck; VFX owns the cause and stays outside this materials lane under rules 21/22.

The VFX JSON parse blocker above is resolved upstream by f359f4473; the batch 184 packaging continuation rebases onto that valid manifest before its final checks.
Batch 174 job 1 regression: the linked mask uniform is visible to both vertex and fragment stages; link-browser.mjs renders and reads back keyed masks on both backends, catching an invalid pipeline caused by vertex-only uniform visibility. No open selection correctness defect remains from that failure.
Batch 174 presentation follow-up: binding a styled scatter or line currently uses the optional mask renderer (round points and simple segment joins), so advanced point effects, variable sizes and detailed line styling are not preserved; vector SVG export still enumerates the original figure layers. Repro: bindSelection on an EDL cloud or styled line, select rows, then export SVG. Cause: optional mask drawables are separate from the native points/lines and vector-export enumerators. Tracked in private/handoffs/finish-later.md under rules 21 and 22.
Batch 174 landing repair, closed: main 72642362b duplicated the VFX test:gpu property without a separating comma, blocking all workspace parsing. Removed the obsolete member, retaining both parity backends. Regression: tests/package-exports.test.js.
Batch 174 follow-up: a lazily materialized rowIds property on the most recent change event can become empty after SelectionStore.dispose(), because disposal clears the same Set captured by that event. Repro: retain the change detail, dispose the store, then read detail.rowIds. Cause and fix-phase item recorded in private/handoffs/finish-later.md; live linked-view selection is unaffected.
Batch 186 job 2: no open correctness defect found in shared atlas packing/filtering. Whole-atlas redraw on any dirty face and discrete resolution changes without hysteresis are documented trade-offs in limits.md; incremental dirty-tile updates remain later quality work.



## Batch 136 encoder boundary

No new open correctness defect in the implemented encoder is known from its current fixtures. Normal quantization at one bit is not a representable octahedral format and returns RangeError; the new encoder's 30-bit path is covered without invoking the upstream build that aborts on that option. Universal compression dominance and end-to-end timing are not established by finite corpus tests; the remaining proof and deferred speed rows are recorded in limits.md and the work lists.
- Batch 191 optional normal-provider reconfiguration: attach Pixelate or Curvature with {normal: () => texture}, then delete effect.options.normal and render. The default normal capture is not registered, so normal highlights/curvature disappear; setup selected the external path and frame does not activate the owned SceneTargets. Nonblocking fix-phase item; constructor defaults and stable providers work.


## Batch 178 vector publication
No known depth-order, clipping, committed-readback or cancellation defect remains in the tested contract. Appearance refinements (lighting, procedural contour/grid ink and non-pixel series styles) are explicit accepted limits in docs/sciviz-vector-export.md and are tracked in the private finish-phase handoff.
Fixed 2026-11-10: Batch 178 gate discovery finding. Current complete GPU plan passes browser registration and chain validation; original repairs: f235e21f0. Regression: tests/gpu-browser-registration.test.js and tests/modern-extension-suite.test.js.
## Batch 176 job 1
No unresolved defect found in the implemented dataset contract. Exact curved-cell filtering and adaptive error-controlled tessellation are not claimed; the input is explicitly normalized at a caller-controlled refinement level. Invalid or over-budget topology rejects rather than silently losing cells. The remaining batch format, AMR, tensor and molecule jobs are separate unbuilt jobs, not known bugs in this entry.

Fixed during batch 176 job 1: the existing formats GPU leaf wrote test-results/sciviz-fixes/formats-gpu.json without creating its parent directory, so a fresh worktree failed after all GPU assertions passed. The leaf now creates its own output directory; its normal run is the fresh-worktree regression. No browser lifecycle or shutdown code changed.

Build-phase follow-up outside batch 176 job 1: legacy parseVTKXML mislabels mixed PolyData triangleCells. Repro: one Vert, one Line, one polygon on point IDs 0/1/2 and one strip on 3/4/5 yields indices [3,4,5,0,1,2] and triangleCells [2,3], but VTK cell order requires [3,2]. Cause: its eager parser visits Strips before Polys. The new datasets adapter uses the correct vertices/lines/polygons/strips order. Repair the older eager API in the fix phase under rule 21.
### Fixed: batch 217 API summary umbrella row

The lane rebase helper counted only @margoengine rows when rebuilding the shared API summary, omitting margoengine kits from its header. The next full api:update regenerates the header and table from emitted declarations, and api:check requires exact agreement. No public implementation changed; future shared-doc merges include the umbrella row before the normal generated check.

Batch 177 job 2: no open correctness defect after statistical formula, missing-step, constant-axis, input-code and hash regressions. LOESS confidence coverage is an explicitly approximate conditional model, documented in limits.md; simultaneous/prediction intervals are outside this job's mean-band claim. NASA live TAP returned HTTP 503 on both official hosts; the demo's pinned public table snapshot avoids a runtime network dependency and records its date and source.
Fixed 2026-11-10: Outside batch 175. Current complete GPU plan passes browser registration and chain validation; original repairs: f235e21f0. Regression: tests/gpu-browser-registration.test.js and tests/modern-extension-suite.test.js.

### Batch 195 job 2 discovery: legacy feature-scaler compatibility suite deadline

Repro: `MARGO_COMPAT=1` then `node packages/quality/test/features-browser.mjs` under the shared GPU lock. On this busy A6000, the existing 120-second watchdog expires. Diagnostic progress completes all original per-knob pixel checks and the 120-frame lowering phase, then expires in the 400-frame raising phase. The old fixture renders the full Shadows/SSAO/VolumetricFog stack for 523 queue-completed frames in addition to its captures; the compatibility workload exceeds its fixed fixture deadline. This is not a deadlocked new knob or a failed value assertion. Native package suite passes, and the new knobs-browser.mjs passes all dimensions, pixel, particle-count and actual MSAA assertions on both backends. Keep the legacy workload and deadline unchanged for the fix phase (lane rules 21/22); no speed or busy-retest waiver is claimed and no assertion is skipped or weakened. Diagnostic log: lane Z test-results/lane195-features-diagnose.log. Investigate the compatibility stack's per-frame work and redundant capture pipeline construction. New optional knobs do not modify that stack.


- Batch 188 static review, prefiltered IBL: encodePrefilteredIBL accepts source edges 8192/16384 although their embedded full source mip chain makes the KTX2 u32 key/value lengths overflow. Repro: encode a valid 8192-edge cube and inspect the wrapped kvdByteLength; do not allocate multi-GiB fixtures in the gate. Cause: edge checks do not validate total metadata byte length before allocation. Fix phase: reject metadata exceeding 0xffffffff before allocating, with a dimension-only regression. Ordinary tested 16-edge round trips are unaffected; no runtime fix in the unrelated EXR job under lane rule 21.

Batch 201 job 3: audio emitter loading, audio-only scenes and positional source attachment are built with CPU and real Web Audio/frame regressions. Inherited fix-phase issue outside this job: AudioListener.attach(engine), followed by listener.dispose() and another attach with the same name, rejects as a duplicate plugin because direct disposal does not remove the engine's named plugin registration (audio/src/listener.ts dispose). Use the engine's removePlugin ownership operation; the new browser fixture does so.
Batch 201 DDS follow-up: malformed MSFT_texture_dds extension shapes reject correctly but textureSource's shared validation message names KHR_texture_basisu; reproduce with a non-object DDS extension value. Valid DDS loading is unaffected. Correct the diagnostic in the fix phase.


Batch 136 replacement proof: the geometric-normal unsigned-residue scoring defect is fixed with circular-distance and complete-payload selection; the sparse high-precision RAW cutoff is expanded within a fixed memory bound. Rust regressions and the 76-row two-decoder corpus pass with no open defect found in this scope.
Fixed 2026-11-10: Build-phase follow-up. notice regeneration preserves appended asset credits (8b508ad02). tests/supply-chain.test.js checks retained addenda, idempotence and current generated notices.

- Fix-phase investigation, existing sciviz glyph capture: glyph-browser.mjs produced too few compatibility pixels once for custom and once for line shapes in the batch 173 gate. Instrumented failures retain image/canvas/stats now; isolated and full diagnostic runs then matched native output exactly (line 151 pixels, custom 3158), and the original assertions with failure diagnostics pass both backends. Root cause remains unisolated, so this is not claimed as a fix or a timing-only miss. Logs stay in lane-X private/batch173/job5/{gpu-glyph-browser.mjs,final-gpu-glyph,glyph-failure-data,glyph-diagnostic}.log. Investigate cold command replay/capture state without retries or lowered pixel bars.
Batch 186 job 3: no open correctness defect found in cube projection or mixed spot/cube ownership. Filtering is the supplied-image bilinear contract; mipmapped minification and HDR inputs remain documented later quality extensions, not asserted here.

Batch 186 job 3 regression: toggling cubes while spot images keep the shared hook active now invalidates cached shader declarations and bind layouts. The CPU regression fails on the pre-fix build, and live removal/reactivation is checked on both GPU backends.

Batch 186 composition follow-up: all three clustered list buffers plus rectangle, shape, directional, IES, spot-cookie and cube-cookie storage total nine fragment storage bindings, above the minimum WebGPU device limit of eight. Repro: activate all those optional hooks together on a default-limits device. Cause: cube cookies currently retain a separate pixel buffer beside spot storage, even for cube-only lists. Ordinary cube and mixed spot/cube projection passes; consolidate cookie storage in the fix phase without changing core.




Batch 180 job 1: no open defect found in the view/cache/height contract. XYZ source polar coverage, conservative visibility and native-preview refusal are recorded limits; geo-lod.test.js and geo-lod-browser.mjs cover this entry.

Fixed 2026-11-10: GPU package-runner owner collision (batch 180). Unrelated worktrees previously shared the generic check owner and were serialized despite free slots. Both serial and parallel admission now use a stable digest of canonical worktree identity, retaining one slot per worktree and distinct suite labels. Regression: tests/gpu-suite-owner.test.js reproduces the parent runner collision with CPU-only admission and checks independent owners; scheduler policy and GPU assertions are unchanged.

Batch 136 removal landing blocker fixed: supply-chain regeneration previously replaced the whole notices file and discarded appended asset credits. Explicit retained addenda, legacy-boundary migration, unknown-boundary rejection and an idempotence/stale-generated-content regression preserve them. No remaining blocker in this scope.
Fixed 2026-11-10: Build-phase follow-up (batch 177 job 3). notice regeneration preserves appended asset credits (8b508ad02). tests/supply-chain.test.js checks retained addenda, idempotence and current generated notices.

Batch 274 fix-phase API polish: Module.stateDict() and Tensor.read() in compute/nn expose no AbortSignal, so an in-flight large state readback cannot be cancelled by their callers. Repro: start model.stateDict() for a large model; there is no signal option to pass. Cause: the existing wrappers call GpuArray.read() without forwarding ReadOptions; BatchNorm follows that existing signature. Add optional wait/read options through nested modules in the fix phase. NN-extra numerical execution, gradients and saved state are complete.
### Fixed: batch 1 umbrella package test discovery

The original fourteen packages were repaired by 68b55c2ed. The later umbrella package added tests/export-order.test.js without scripts.test, reproducing the same class: node --test tests/package-test-scripts.test.js reported the missing file. Its manifest now runs every tests/*.test.js file. Existing regression: tests/package-test-scripts.test.js, which failed before the manifest change.

The rebased cube-projector alias was appended after the umbrella kits, failing the existing generated-manifest and package export-order checks. Running scripts/umbrella.mjs restores its owning package position without changing the export set.
## Batch 178 PDF and math
No open correctness defect in the documented TeX subset or figure-SVG PDF contract after CPU, both-backend browser and independent MuPDF checks. Font-specific math spacing and variant glyph assembly are accepted appearance differences, tracked in the private finish-phase handoff.


Batch 175 job 2 source-data defect: USGS IA_FullState/ept-data/0-0-0-0.laz first GPS time is -4.799510766208031e194 (implausible). Repro: parseLAS of the archived original, point 0. Cause: identical bits in the uncompressed seed record of the producer file; independent laspy 2.7.0/lazrs 0.8.2 agrees on every decoded record. Preserve original values; use intensity/classification/elevation for this demo, not GPS-time analysis.

Fixed 2026-11-10: points/octree concurrency validation (batch 175 job 2). OctreeCloud now rejects maxConcurrentLoads unless it is a positive safe integer, before allocating its material. Undefined keeps the existing default of four; wrong types throw TypeError and invalid numeric values throw RangeError with a help link. Regression: packages/points/tests/octree.test.js fails on the unchecked parent at zero and verifies actual scheduling of one, four and eight child loads. Selection, sampling, point budgets and rendering work are unchanged.
Batch 177 job 4: no open correctness defect in the checked chart presentation paths. A pre-existing sciviz test:browser:fallback manifest command bypassed browser-root and failed its package-root regression; it now follows the same adapter as the other package browser commands. Legend interaction is layered above inset canvases, preventing an inset from intercepting its clicks. Native hidden traces are excluded from picks, selection and SVG, as checked by the new browser regression.


API conventions lane (2026-11-10): unchanged materials dispersion compatibility reproduces the tracked 4x live-reset error 0.000244140625 against 0; native passes 278 checks/254 captures. The changed optional Fur.attach entry is never imported by this fixture, whose materials root is unchanged. Retain the existing fix-phase item under rules 21/22 without a tolerance or renderer change.
- Fix-phase follow-up in existing scalar/curvilinear marches: constant classifier opacity 1 with a reference distance much larger than the traversed physical thickness remains partly transparent because their fractional-step correction first caps alpha below 1. Repro for curvilinear: unit constant cube, opacity()=>1, referenceStep=1000, no shading; expected opaque red. The new tetrahedral entry keeps exact alpha 1 and tests this endpoint; the pre-existing paths are outside job 173.6 and wait for the fix phase.
- Fix-phase follow-up in existing curvilinear physical metrics: scale a unit cube and referenceStep together by 1e20 or 1e-20, with matching figure limits. Its raw physical length(d*span) squares can overflow/underflow float32 before opacity correction. The tetrahedral entry normalizes extents/reference together and covers both scales; port that bounded metric to the other owning optional paths in the fix phase.


- Batch 174 multivariate brush history: after two axis brushes, SelectionStore.undo restores row highlights but the controller retains its last local range map; a later axis gesture can reapply an undone other-axis range. Cause: selection history snapshots row-key brushes, not controller predicate metadata. Repro: period brush, radius brush, undo, then change period. Rendered undo itself is correct; predicate/control restoration is owed in the fix phase.
Batch 180 gate finding, existing glyph capture: node packages/sciviz/tests/glyph-browser.mjs once failed the unchanged >20 lit-pixel assertion for the thin line glyph on WebGL2 after shape replacement. Native had 151 pixels; subsequent unchanged assertions on both backends had exactly 151 and identical hashes. Cause is not isolated: the captured shape-transition frame lost expected thin-tube coverage; this is a value/capture nondeterminism, not a timing-only budget miss. No test threshold changed. Preserve the diagnostic and investigate readiness/resize/capture ordering in the glyph owner during the fix phase.
Batch 180 job 2: no open correctness defect in the requested vector-geography contract. Future near-plane ribbons and runtime style mutation are documented quality follow-ups. The fallback and newly rebased engineering/pointcloud browser scripts gained the same repository-root bootstrap as other sciviz browser scripts; existing browser-root.test.js caught the missing registrations.
Batch 183 gate finding, deferred by build-phase rule 21: npm test --workspace packages/navmesh fails its border/SIMD bundle probes because test/border.test.js:21 and test/wasm.test.js:97 pass packages/navmesh/src/pipeline.ts to bundleBytes relative to the package cwd. The same complete CPU suite runs from the repository root; fix the probes to anchor entries to the repository rather than process.cwd during the fix phase.
Batch 183 gate finding, deferred by build-phase rule 21: sciviz package-local npm test lacks --experimental-test-module-mocks although tests/pointcloud.test.js:28 calls mock.module. Run its complete CPU suite with that Node flag, as root test:all already does; repair the package test command in the owning lane/fix phase.
Fixed batch 180 landing integration: the generated margoengine/sciviz/monitor alias was present in the working tree but omitted by tracked-only staging while its generated manifest mapping was committed. A clean checkout could not build that entry. The generated source is now committed. The new packages/margoengine/tests/export-order.test.js index-membership regression catches this class even when an unstaged generated source exists locally; it runs in the normal merge CPU suite. Existing tests/umbrella.test.js also checks complete generator output and every runtime alias.

Batch 179 state capture: default MSAA transparent rendering is not self-bit-stable (Aeroflow repeated unchanged captures differed in 14 of 3042432 bytes by one level on this GPU); the same source scene varies while serialized resources, limits and camera are identical; the renderer cause remains to isolate. ExactSize round-trip proofs remain exact. Default-MSAA bit identity is retained for the rendering fix phase; no core change is made.

Quality scanner race: running quality alongside React subpath tests can list then read a temporary .subpaths-* fixture after the test deletes it, yielding ENOENT in clean-room.js; run these gates sequentially until the scanner owns a stable file list. Found during batch 179, outside the state codec.

Batch 179 custom colour-map quality tail: Colormap('quadratic', 'sequential', t => [t*t, 0, 0]) sampled by a CPU-coloured line at t=0.123 is restored from a 256-entry Float32 table, with interpolation error versus the original closure. Cause: executable closures cannot be serialized and the table matches GPU texture sampling, not arbitrary analytic CPU sampling. Preserve exact CPU colours or a registered declarative map definition in the fix phase.
- Batch 178 job 3 media quality: manually setting a scatter cloud material to world size before perspective tiled capture makes its splats too small in short tiles. Repro: scatter.cloud.material.sizeUnits = world, capture with tileSize below image height. Cause: the points focal-length uniform uses tile height while the capture camera retains its full-view fov. Default sciviz pixel-size scatter is unaffected. Fix-phase item under rule 22; all required media formats are built.

Batch 177 job 5: no open correctness defect in the checked live-data paths. Source cancellation covers asynchronous parse waits, including a parser that synchronously aborts its signal. A removed trace no longer appears in ChartPolish unified hover. The streaming SVG regression counts its 64 clipped data circles separately from the intentional legend swatch. Protocol fixtures close the RFC 6455 connection once; no renderer/browser shutdown code changed.

### Fixed: water query browser check rewrote a tracked record (list 3 batch 66 job 5)

packages/water/test/query.browser.mjs wrote docs/whitepaper/results/batch234-water-query-<mode>.json on every GPU run, so a landing's refresh found a tracked file changed and stopped. It now writes test-results/water-query-<mode>.json; the committed record stays as recorded. Regression: packages/water/test/results-path.test.js fails on any water browser check that writes under docs/.


### Open: Water's own coast flow is unbounded on steep falls (list 3 batch 66 job 8)

Water's built-in surface-driven pipe drives each pipe with the full surface difference, so water over a 10 m fall reaches 240 m/s (one cell per step, 1/dt at 240 steps per second) and can overshoot the Courant bound. It stays as it is for coasts and gentle beds; for rivers over falls and steep chutes attach @margoengine/water/rivers, which caps the same fall at 6.75 m/s. Regression: packages/water/test/rivers.test.js "the surface-driven coast pipe exceeds the Courant bound over the same fall" records both.

### Fixed: water/rivers sources narrower than a cell fed nothing (list 3 batch 63 job 2)

A Rivers source with radius 0 (the default) or below half a cell, off a cell centre, had an empty footprint, so it added no water. The footprint now always includes the cell under the position (a position off the map still feeds nothing), in the shader and the float64 model. Regression: packages/water/test/rivers.test.js "a source narrower than a cell feeds the one cell under it", and a radius-0 source in rivers.browser.mjs.

Fixed 2026-11-10: review 3 P1 PixelFollow extreme finite deltas (cde120852). Smoothing preserves stationary zero-lerp axes without evaluating 1**Infinity and retains tiny positive factors through log1p/expm1. Current-main reproduction: all eight packages/pixel/tests/follow.test.js cases pass, including zero/unit/tiny lerps, Number.MIN_VALUE, Number.MAX_VALUE/60 and Number.MAX_VALUE. Accepted input ranges and integer camera positions are unchanged.

- ChartPolish visibility on selection-bound marks: bind a scatter/line layer, attach polishFigure, then setVisible(layer, false); the binding still draws. Cause: format.ts mutates the hidden source visible flag rather than SelectionBinding.visible. Ordinary Figure picking/brushing already follows the linked-draw identity on main. Outside batch 174 query scope; fix phase.

- Existing atmosphere exact-capture defect after main merge: run SPEC_DEMOS=atmosphere SPEC_BACKENDS=webgl2 with packages/sciviz/tests/spec-demos-browser.mjs under the GPU lock. In batch174/j4-land-gpu.log, three blue-channel bytes differ by 1 (offsets 1360474, 1360478, 1365274); sameSourceDiff is also 3 for the unchanged source figure, and camera/limits match. The failure originates in repeated atmosphere compatibility drawing, rather than date/log window restoration; the particular nondeterministic draw operation is not isolated. Record for fix phase under rule 21; exact assertion is unchanged.
Batch 178 job 4: no open correctness defect in the requested colour/legend contract. Surface NaN heights still form holes because they have no geometric position; diagnostic CVD simulation makes no universal distinguishability promise. The PDF equal-stop gap and finite-first volume MIP state are covered by regression tests in the same job.

Review 2 evidence follow-up: running packages/water/test/query.browser.mjs with MARGO_COMPAT=1 and no --compat argument writes compatibility hardware/results under a webgpu suffix (now test-results/water-query-webgpu.json after the separate tracked-record correction). Cause: its output suffix reads argv instead of actual browser hardware.compat. Numerical assertions pass; output labeling is a build-phase tooling follow-up.

- Batch 203 dependent-test finding: npm test --workspace @margoengine/navmesh fails border.test.js and wasm.test.js because their bundleBytes('packages/navmesh/src/pipeline.ts') paths resolve from the package working directory. The complete 121-test suite passes from the repository root, as local CI runs it. This package-command path repair is deferred under build-phase rule 21.

- Batch 203 AVIF validation tail: malformed prem item references with no auxiliary alpha, multiple targets or a target other than the actual alpha are ignored rather than rejected. Repro: add such a prem reference to a valid AVIF primary item. Cause: image.rs tests equality with the one alpha ID and treats a mismatch as straight alpha. Valid straight/premultiplied alpha decoding is implemented; strict invalid-reference rejection is a fix-phase item under rule 22.



### Fixed: batch 181 job 3 CPU point-depth tie direction

Fixed 2026-11-10: nearestPoint now compares projectPoint's normalized near=0/far=1 depth in the correct direction, preserving the existing half-pixel screen-distance tie rule. packages/sciviz/tests/pick.test.js checks a real perspective camera in both point orders and corrects the identity fixture against the same documented depth convention. Both cases fail on the parent. GPU reversed clip depth and its picking pass are unchanged.

Batch 181 job 3 gate fix: linked mask rendering suppressed original draw visibility and Figure queries excluded that visible source data. The upstream linked-draw owner protocol preserves CPU/GPU picking and brush selection, respects replacement visibility and unregisters on disposal. Regression: packages/sciviz/tests/pick-visibility.test.js plus unchanged demos-browser.mjs star brushes.

## Batch 132 audit: compute SVD does not converge on a matrix of many repeated columns

Repro (CPU backend, any host): fill a 512 x 512 matrix row-major from `seed = (seed * 1103515245 + 12345) >>> 0`
computed in doubles (the product loses its low bits, so the stream cycles and only about 15,600 distinct values fill
262,144 entries, giving many exactly repeated columns), divided by 2^32 minus 0.5, then `await svd(ctx.array(data,
{ shape: [512, 512] }))` from `@margoengine/compute/decomp`. It rejects with "Jacobi iteration did not converge" after
the default 100 sweeps; 256 x 256 from the same stream and random rank-deficient products (rank 1 to 50) converge.
Cause: one-sided Jacobi orthogonalizes each repeated pair down to columns at rounding level, which keep rotating
against each other at ever smaller scales into the subnormal range, where rounding is too coarse to reach the
relative stopping test (Drmac and Veselic, LAPACK Working Note 170, 2007, section 3.2: underflow can stop Jacobi
converging). Fix to build: treat a column whose norm falls below eps times the largest column norm as numerically
zero (skip its rotations and complete its singular vector by the existing basis completion), checked against the
relative accuracy the Jacobi method keeps for graded columns.

Fixed 2026-11-10: review 3 SV4 transfer-binding reentrant abort. The abort listener now exists before the initial caller render callback; an already-disposed initialization cannot subscribe to later transfer changes. Failed initialization restores the previous classifier and releases listeners, with both errors retained if restoration also fails. Regression: packages/sciviz/tests/transfer.test.js covers initial synchronous abort, throwing render callbacks and failed restoration; all three fail on the parent. Default LUT work, numerical transfer tests and rendering bounds are unchanged.


- Batch 120 incidental gate finding, base 2ed6fd460: node --test tests/check-fixed-waits.test.js flags packages/biomes/tests/water-check.html line 101, a fixed 90-frame loop absent from the baseline. Cause: the biomes test waits for frame count instead of GPU readiness; unrelated to profile installation, deferred to its owning lane under efficiency rule 21.
Batch 176 job 4: no open defect found in the supported Cartesian cell-centred AMR contract. Format extensions, block-edge reconstruction and explicit sample/index budgets are documented in limits.md; refinements remain on the private finish-later list.

Fixed 2026-11-10: Batch 176 inspection. GPU planner registrations and command ordering are repaired on main (30c8a02db). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.
- Batch 174 annotation keyboard focus: on a running figure, focus an editable SVG handle and let the next engine frame run; focus returns to the document because Annotations.render replaces every SVG child with innerHTML on each frame. Pointer dragging still uses capture on the stable SVG root. Preserve/reconcile the focused handle across frame paints in the fix phase; current keyboard regression covers stopped figures.


- Batch 120 path audit: public npm create margo@latest still reaches the prerelease placeholder until Scott authorizes publication; cause is intentionally pending registry release. The actual create/install/build/frame path is proven against the private packed registry.
- Batch 120 path audit: a browser without WebGPU needs an explicit @margoengine/webgl2-compat install, one extra step compared with a bundled WebGL renderer. Cause is the deliberate optional backend boundary; documentation and both kit-backend checks cover it, while reducing the extra setup remains a release UX decision.
- Batch 120 incidental documentation gate, base b4404cddb: node --test tests/from-threejs-snippets.test.js flags docs/guides/react-test-offscreen.md because it has no ts fence recognized by the snippet harness. All changed kit/import/migration guide snippets pass; the unrelated React guide/harness mismatch is deferred to its owner under rule 21.

### Open: ANGLE D3D11 returns two versions of the same MSAA-resolved HDR texture (compat dispersion live reset; sciviz geo-lod restore; likely the atmosphere same-source byte)

Platform defect below the compatibility layer, proven at the WebGL call level (bug hunt, 2026-11-10). No exact workaround exists inside `@margoengine/webgl2-compat`, so the exact assertions stay unchanged and open.

- Repro: `node scripts/material-dispersion-gpu-check.js --backend=compat` on the RTX A6000 under Chrome's default ANGLE D3D11 backend. Failure 9 (4x live positive-to-zero reset, 10 HDR channels, max 0.000244140625) reproduced on the first run. With six unchanged `live(0)` frames added after the reset, 9 of 9 full-grid runs reached the same second image ("alt"). Every time it differed from the constructor-zero image ("base") in the same 10 channels, each by one float16 step. Most of those pixels lie outside the transmissive quad, where only the opaque background and the final 4x resolve touch them. 1x stays exact.
- Proof that the layer issues identical work: a WebGL2 call recorder (each call's name, object identity and payload FNV hash) shows that consecutive unchanged frames issue byte-identical WebGL2 command streams, yet one frame returns base and the next returns alt. Each frame clears or fully overwrites every attachment it reads, and the opaque-only resolve and its level-0 copy hash identically in every frame. A direct `readPixels` of the resolve target's framebuffer, issued with no WebGL call between it and the layer's own fenced pixel-buffer readback, returned the other version (base, then alt, and in another run alt, then base). Once settled, 30 rereads 20 ms apart agree. So one texture yields two contents with no command in between, which breaks the repeatability rule of the OpenGL ES 3.0 specification, Appendix A.1.
- Ruled out: uniform staleness (the only stream difference between the reset frame and the next is the 4-byte dispersion write; the other frames are identical); invalidateFramebuffer (patching it to a no-op still gives alt in 2 of 2 runs); readback row layout (both reads are tightly packed RGBA float); shader compile variants inside the layer (programs are identical objects across the compared frames); engine timing state (the stream diff is empty). Raw WebGL2 pages without engine code (a UBO-driven refract shader; a 4x RGBA16F renderbuffer resolve with 3,000 edge triangles, with and without invalidate; 300 frames each) did not reproduce it, so the trigger also needs the full grid's earlier resource churn.
- Backend check: the same probe on ANGLE Vulkan with the same NVIDIA GPU (`BROWSER_ARGS='["--use-angle=vulkan"]'`) was exact in 2 of 2 runs (reset and six extras). ANGLE OpenGL fell back to SwiftShader and was refused. This puts the defect in ANGLE's D3D11 backend or the NVIDIA D3D11 driver. Native WebGPU (D3D12) passes all 278 checks.
- Atmosphere (`SPEC_DEMOS=atmosphere SPEC_BACKENDS=webgl2 node packages/sciviz/tests/spec-demos-browser.mjs`, and the zero-cloud hash in `atmosphere-browser.mjs`): this did not reproduce here. One full spec-demo run, 8 repeats, 6 page loads of 4 repeats and 2 parallel probes of 5 loads of 3 repeats all gave byte-identical captures. The earlier failures signed the same way (one-step differences on unchanged source, under the shared GPU queue), but the cause there is not proven. Treat it as the same open item until a failing run is captured with the recorder.
- Sciviz geo-lod (`packages/sciviz/tests/geo-lod-browser.mjs` line 85, `retained data restores identical pixels`, max difference 1): same defect, on an 8-bit 4x resolve. On plain main 5329898ca it failed 1 of 4 test runs. A probe that captures the refined globe four times with no restore, then restores the layer six times with two captures each, showed one-level flips in 4 of 6 page loads under D3D11. They show up just as often between two unchanged captures with no restore as after a restore, so `layer.restore()` is not the cause. Each frame clears, issues 16 tile draws, resolves the 4x target with blitFramebuffer, flips it with a second blit and reads it back. The recorder (per-capture object ids renamed in creation order, sync polling dropped) shows two consecutive unchanged captures with byte-identical streams up to and including the readback. Only the bytes read back differ, in 46 channels by one level. Under ANGLE Vulkan on the same RTX A6000, 6 page loads gave 90 captures and every one was exact. Native WebGPU (D3D12) also flipped one green channel at pixel (313, 57) by one level in 3 of 3 loads. The test compares only the red channel, so native passes. This suggests the NVIDIA D3D resolve path rather than ANGLE alone, but it is not proven. Probes: `geo-lod-probe-browser.mjs` (run from a worktree's `.lane/` through `scripts/gpu-lock.mjs run`; `PROBE_BACKENDS`, `PROBE_LOADS`, `PROBE_ROUNDS`, `PROBE_REC=1` for the recorder), `geo-lod-norm.cjs` and `geo-lod-ndiff.cjs` (stream grouping and diff), `geo-lod-streams-d3d11.json` (failing load; compare after2 with after3), and the D3D11 and Vulkan logs. The exact assertion stays unchanged; the job that hits it changed no geo-lod or compat source.
- Probes (git-excluded, in the main checkout): `private/handoffs/compat-determinism-probes/` holds `disp-probe.js` (the grid with recorder, extra frames, direct reads, attachment map and `PROBE_NOINVALIDATE`), `gl-recorder.js`, `diffstreams.cjs`, the raw pages and one failing stream capture.
- Next step: report to ANGLE/NVIDIA with a self-contained replay of the recorded session (full payloads, not hashes). Until then this stays a release blocker for exact compat captures on Windows D3D11. Never raise the bound for it.


Fixed 2026-11-10: Batch 181 gate observation. GPU planner registrations and command ordering are repaired on main (30c8a02db). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.


Fixed 2026-11-10: Batch 180 job 5 incidental gate finding (base b4404cddb). GPU planner registrations and command ordering are repaired on main (30c8a02db). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.

- Batch 180 job 5 visual review: add two named heatmaps to a default Figure, then remove the first. Figure.#updateLegend sets element.hidden=true when only one remains, but Legend's inline display:grid overrides the browser's hidden rule, leaving both old legend rows visible. Repro: select several field reductions in examples/sciviz-temporal.html; evidence test-results/sciviz-temporal-webgpu.png. Numerical fields and exported pixels without overlays are correct. Small existing legend presentation gap deferred under rules 21/22; fix the owning legend visibility and add its DOM/browser regression in the fix phase.

Batch 181 job 4 fixed before landing: density scatter replacement must retain the source's original visibility across native updateData cloud replacement, including when the replacement is hidden and disposed before its next frame. Cause: capturing the new cloud's logical replacement visibility overwrote the original source visibility, and disposal could still address the old cloud. Regression: packages/sciviz/tests/density.test.js, hidden replacement before/after preparation. All source votes and analytical counts are unaffected.

Batch 274 job 6: no open correctness defect found in signed int8 matmul/Conv2d.
Conservative accumulator limits and f32 rescale error bounds are documented in
docs/compute-quant.md; independent float-reference cases cover CPU and both GPU backends.

Batch 175 job 5: no open defect found in the built graph-gpu paths. The straight-edge zero-subdivision u32 underflow is fixed in the owning optional shader and covered by the invisible-first-edge GPU regression; figure dimensionality, both force references, bundling boundaries, labels and device routes are checked. Float32 precision, concentrated-leaf costs, FDEB quadratic pair work and explicit label snapshot refresh remain documented limits.
Batch 180 job 4: no open correctness defect found in the implemented climate/projection paths. CF coverage and interpolation domains are explicit in docs/limits.md. Outside this job: openCloudZarr rejects valid rank-zero scalar arrays (shape/chunks []); repro public IPSL tas height/.zarray at the climate source URL, cause dimension-count validation requires nonempty shape. The offline data curation reads those uncompressed scalar coordinate bytes directly; CF reads the resulting NetCDF scalar without this restriction. Rule 21 leaves broader Cloud Zarr scalar support to its owner.
Batch 180 job 4 GPU observation (2026-11-10): the existing atmosphere spec demo reproduced the recorded ANGLE D3D11 nondeterminism under the shared queue: 50 bytes differed, including 50 between two unchanged source captures (test-results/batch180-job4-gpu-all.log). No CF/projection scene failed. The unchanged atmosphere/surface/volume/points spec assertions are exact on the documented ANGLE Vulkan backend (test-results/batch180-job4-gpu-remaining.log). D3D11 remains the existing release blocker above; this is not a repaired driver claim or a widened pixel bound.

- Batch 175 job 4 landing gate: the unchanged geo-lod exact restoration assertion observed one-level differences, 1 native channel and 46 WebGL2 channels. This matches the documented ANGLE D3D11/NVIDIA resolve defect above and Scott's 2026-11-10 landing exception. The test and assertion remain unchanged. Evidence: test-results/b175-j4-package-gpu.log and b175-j4-geo-probe-direct.log; /series passes both backends.


## Batch 175 job 6: known driver exception

The sciviz GPU gate encountered the known ANGLE D3D11 MSAA resolve defect documented above: geo-lod-browser.mjs:85 reported max red-channel difference 1; diagnostic evidence found 47 one-level channel differences, no GPU errors, and exact native WebGPU pixels. Scott authorized continuing the gate on 2026-11-10. No geo-lod or compatibility source or assertion changed. Evidence: lane U test-results/job6-gpu.log, job6-geodebug2.log and job6-geodebug3.log.

Batch 176 job 5: no open defect found in the declared tensor/OLS/Cartesian tracking contract. Device precision, degenerate-axis ambiguity, raw indefinite fits and analysis/preprocessing limits are recorded in limits.md.

Batch 176 job 6: no open defect found in the declared first-model molecular sphere/stick contract. Unknown-element fallbacks, geometric bond inference and unsupported assembly/ribbon formats are explicit in limits.md.

### Batch 137 quality gap closed

The former 1024 UASTC data loss was caused by forcing a stronger lossy RDO setting
to compensate for raw Zstandard literals. Finer RDO alone still lost quality.
RFC 8878 Huffman literals preserve the fitted bytes while reducing the required
rate conditioning. At RDO 0.09375: 1,305,680 / 1,306,710 B, PSNR 44.380795263 /
44.027242948 dB and SSIM 0.981507121 / 0.980103599. Every mip row passes.
See whitepaper/results/batch-137-quality-r10.json and basis-zstd.test.js.

## Batch 132 audit: core (read-only package; findings for Scott)

Base dab36e5f9, M6 Mac mini. Core CPU 90/90 and `core test:gpu` (native, WebGL2 compat and preview) pass on Metal.

### Open: core Euler lanes lose the orientation at pitch +-90 degrees

Repro: `mesh.setQuaternion([0.5, 0.5, 0.5, 0.5])` (pitch exactly 90 degrees), then the no-op write
`mesh.rotation.x = mesh.rotation.x`. The stored quaternion becomes `[0, 0.707107, 0, 0.707107]`: the mesh turns 90
degrees. `mesh.rotation` reads `[0, pi/2, 0]` after `setQuaternion`. `writePoses` stores the same lanes, so a physics
body at 90 degrees of pitch that a script then rotates through `rotation` jumps the same way.
Cause: `storeQuaternion` (packages/core/src/engine.ts, the `asin` / two `atan2` lines) takes X and Z each as
`atan2(0, 0) = 0` when `2 (xz + wy)` is +-1, so the combined roll is dropped instead of being put in one angle. Near the
pole (1e-4 rad off) the f32 lanes round-trip with 0.013 degrees of error, which is expected.
Fix to build: at |sinPitch| near 1 set X to 0 and Z to the combined angle `2 atan2(qz, qw)` with the sign rule for
-90 degrees (Shoemake, "Euler Angle Conversion", Graphics Gems IV, 1994), then check `setQuaternion` then a no-op
`rotation` write keeps every quaternion of a 90 degree pitch.

### Open: core backbuffer clamp changes the aspect ratio of a wide canvas

Repro: an engine on a canvas with `clientWidth 5120, clientHeight 1440` at device pixel ratio 1 (a 32:9 monitor, or
any canvas wider than 4096 backing pixels). `resize()` sets the backbuffer to 4096 x 1440 and the camera uses its
aspect 2.844, while the browser stretches it to the CSS aspect 3.556: the picture is 25% too wide (circles render as
ellipses).
Cause: packages/core/src/engine.ts `resize()` clamps width and height to 4096 one at a time. The README promises "at
most 4096 per side" but not the distortion. Fix to build: scale both by `min(1, 4096 / max(w, h))`, or keep the
camera aspect at the CSS aspect.

### Open: core `fitToBoundingBox` frames small parts 11x too far and clips large ones at a wide field of view

Repro 1: `new Camera({fov: 120, position: [1, 1, 1]}).fitToBoundingBox([-0.175, -0.175, -0.175], [0.175, 0.175,
0.175], {duration: 0})`: the eye ends 0.385 from the centre, so the nearest corner is 0.082 away, inside `near = 0.1`;
the box is cut open. At fov 100 the corner is 0.13 away, just past near.
Repro 2: stage `box({size: [0.02, 0.02, 0.02]})` then `fit()` at the defaults: the eye ends 0.44 from the centre where
the sphere fit is 0.038, so a 2 cm part fills a twelfth of the view.
Cause: packages/core/src/camera.ts `fitToBoundingBox` raises the radius to `2 near` (which only moves small parts far
away) and never checks `distance - radius >= near` (which a wide angle breaks). Fix to build: fit the true radius, then
move out (or lower `near`) only when `distance - radius < near`.

### Note: core direct light follows the 2021 glTF Appendix B

The shader uses the separable Smith G of the 2021 revision of glTF 2.0 Appendix B; the current revision gives the
height-correlated form (Heitz 2014). The clean-room record now says which revision (P46). Moving to the
height-correlated form changes WebGL, gltf-pro and core pixels together and is Scott's call.

## Batch 132 audit: stage (read-only package; findings for Scott)

Base dab36e5f9, M6 Mac mini. Stage CPU 134/134; `test:gpu`, `test:gpu:features` (each on WebGPU and with
MARGO_COMPAT=1), `test:gpu:gltf`, `test:gpu:lights` and `test:gpu:viewer-extras` (both modes inside) pass on Metal.

### Open: stage `addScene` and `addLights` remove each other's clustered lights

Repro: `addLights(stage, [{type: 'point', position: [0, 1, 0], range: 5}])`, then `addScene` of a document with one
point light: `lights.clustered.list` holds only the scene's light. The other order: `addScene`, then `addLights`, then
`scene.dispose()`: the list is empty, the `addLights` light is gone.
Cause: packages/stage/src/scene.ts `hold()` keeps its own set of scene lists and calls `setLights` with that set alone,
while packages/stage/src/lights.ts `contribute()` appends to the current list. The README says two scenes add up and
each dispose takes its own. Fix to build: `hold()` appends its own lights to `list.list` and removes only its own, as
`contribute()` does.

### Open: stage scene camera ignores the entity's up and throws looking straight down

Repro: `addScene` of a floor plus `{id: 'top', transform: {position: [0, 10, 0]}, components: {camera: {target: [0, 0,
0]}}}`: every frame throws `Vertical camera`. With a -90 degree X rotation instead of a target it renders only because
the forward vector rounds to `[0, -1, -2.2e-16]`, so the roll is arbitrary; any camera entity rolled about its view
axis renders unrolled.
Cause: packages/stage/src/scene.ts builds `cameras` from position and target only and never sets `camera.up` from the
entity's world +Y. Fix to build: store the entity's world up with each camera and assign it with the switch.

### Open: stage `CADCameraControls` orbit and pan assume Y up

Repro: a camera with `up: [0, 0, 1]` at `[3, -5, 2]`: `pan(-0.1, 0)` moves at cos 0.476 to the screen's right instead
of along it; `orbit(0.3, 0)` from `[0, -5, 2]` changes the height along Z from 2 to 1.911.
Cause: packages/stage/src/controls.ts `orbit` and `pan` work in Y-up spherical coordinates and read `camera.up` only for
a view along Y. The README does not say Y up. Fix to build: build the orbit frame from `camera.up` (or document Y up
and refuse another up).

## Batch 132 audit: cache (fixed and open)

Fixed in this commit (regressions in packages/cache/test/audit-132.test.js, each failing before its fix): `delete`
and `clear` of AssetCache and `clear` of RangeCache ran before writes already queued, so a file answered just before
was stored again after them (and a HashedAssets mismatch left the bad copy stored); a signal already aborted did not
reject a stored answer (Fetch); a RangeCache `no-store` miss returned the whole widened block (`bytes=10-19` gave
`bytes 0-63/200`); `Expires` and `Date` went through `Date.parse`, so `Expires: 2100` was fresh until the year 2100 and
asctime dates were read as local time (RFC 9110 5.6.7, RFC 9111 5.3); `If-Range` was ignored (RFC 9110 13.1.5);
`Prefetcher.settle()` hung while paused; `AssetBundles.load` kept downloading every file after one failed; HashedAssets
and AssetBundles dropped a `Request` input's signal and headers; `throttle` left one abort listener per chunk.

### Open: cache findings not fixed in the audit

- evictionIndex `remove()` per key in one transaction reads the totals before any put lands: deleting a URL with two
  `Vary` entries leaves `usage()` at `{bytes: 100, files: 1}` with nothing stored (packages/cache/src/eviction.ts
  `remove`, called per key from index.ts `delete`). Fix: one read and one put of the totals for all keys.
- `serve()` puts the entry back blind: a hit looked up before a queued write evicts it brings back a record without
  bytes (maxBytes 150, two 100-byte files: usage 200 bytes, 2 files). Fix: get then put in one transaction, only if the
  record exists, as RangeCache `touch` does.
- A 304 without `Cache-Control` or `Expires` drops the stored lifetime instead of keeping it (RFC 9111 4.3.4; only
  non-conforming servers, as RFC 9110 15.4.5 makes servers send them).
- RangeCache combines blocks under a weak ETag or no validator at all; RFC 9111 3.4 allows it only under one strong
  validator. Same size, new bytes, same weak tag: one answer mixes two versions. Fix: combine only under a strong
  validator and send `If-Range` with it on block requests.
- Request cache modes (`cache: 'reload'`, `'no-store'`, `'no-cache'`, request `Cache-Control: no-cache`) are ignored;
  the stored copy answers.
- Stale copies are served on any non-200 answer and on a timeout, also for `no-cache` and `must-revalidate` files
  (RFC 9111 4.2.4 and 5.2.2.2 allow it only when disconnected); by design for offline play, but not in limits.md.
- RangeCache freshness ignores the request's round trip (`freshUntil(headers, now)` without `sent`).
- Slop: index.ts keeps its own copies of http.ts `transact` and the range parsing; `isEntry` and `defaultFetch` are
  duplicated; decoded.ts uses `max-age=3153600000`, past the 2^31 cap of RFC 9111 1.2.2; Vary name records are never
  evicted; 27 throws carry no help link.
