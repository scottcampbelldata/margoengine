# Known bugs and unverified features

### Corrected: KB1405, the native sciviz WebGL2 driver drew only part of a figure (2026-11-11, retired)

- **Bug:** `@margoengine/sciviz/webgl2` (`attachWebGL2`) drew surfaces, bars, histograms and heatmaps on the small preview
  renderer and refused axes (`axes: false` was required), points, lines, volumes, slices, isosurfaces and the demos; about
  45 optional entries refuse it by construction. A partial package that would have needed 8 to 10 more pushes, about 20 KB
  of GLSL and a third parity matrix to finish.
- **Fix:** Scott approved retiring it (2026-11-11). The entry, its tests, the root's type-only driver seam and its eleven
  error messages are removed; a Figure on an engine without a WebGPU device rejects with a coded `unsupported` error naming
  `createFallbackFigure`. Every figure draws on the complete WebGL2 layer instead.
- **Evidence:** `packages/sciviz/tests/fallback-browser.mjs` draws axes with scatter, scatter, line and label volumes on
  native WebGPU, on the layer and on `/tiers` forced to half-float and LDR: mean(max RGB channel difference) at most
  0.00004/255, share(d > 8/255) 0, identical tick-label text (bounds fixed before the first run: mean <= 1, share <= 0.02).
  Existing cases cover surface, slice, volume, CPU isosurface, bars and heatmap. `docs/webgl2-compat-demos.md` records
  sciviz-head, points, stars, surface, volume and wind running with the same pixels at 16.7 ms intervals.
  `backend-isolation.test.js` pins the removal and the error help. Sizes and details: `docs/limits.md`.

### Firefox on Windows rejects a WGSL function named `dx` (browser defect, found 2026-11-11, open upstream)

- **Repro:** in Playwright Firefox 157 on Windows (RTX A6000, headed, `dom.webgpu.enabled`), a render pipeline whose
  fragment module is `fn dx()->f32 {return 1.0;} @fragment fn f()->@location(0) vec4f {return vec4f(dx());}` fails
  with "DXC compile error: redefinition of 'dx' as different kind of symbol". `fn dy`, and a local `let dx` or
  `var dx`, compile. Chromium compiles all of them.
- **Cause:** Firefox's WGSL to HLSL step keeps the name `dx`, which DXC reserves as a namespace. Valid WGSL, so the
  defect is the browser's. No Margo package declares a WGSL function `dx` (checked over `packages/*/src`); the WebGL2
  layer's features check named its gradient helpers `dx` and `dy` and now names them `gx` and `gy`, as what it tests is
  the order the layer evaluates `textureSampleGrad`'s arguments in, not the browser's naming.
- **Next:** report it to Mozilla with the shader above; an app that hits it renames the function.
- **Upstream report (draft, nothing filed):** `docs/upstream-reports/KB0003/report.md` with the repro page `dx.html`; still reproduces in Firefox 157 on 2026-11-11 (Edge 157 compiles all five cases).

### Firefox prints WebGL advisory warnings that the lod and materials browser checks count as errors (found 2026-11-11, open)

- **Repro:** `MARGO_BROWSER=firefox node packages/lod/test/browser-check.mjs --compat` and
  `MARGO_BROWSER=firefox node packages/materials/test/browser-check.mjs --compat` (Firefox 157, RTX A6000, WebGL2
  layer): the pages draw correctly (every `ok` line passes) but the checks end on `assert.deepEqual(pageErrors, [])`
  because they collect every console `warning`. Native WebGPU runs of both pass, and so do gltf-pro, postfx, lines and
  points on the layer.
- **What Firefox prints:** (1) `WEBGL_debug_renderer_info is deprecated ... Please use RENDERER`: the layer reads the
  extension for the GPU name (`webgl2Capabilities`, reports and driver workarounds); Firefox's `RENDERER` answers the masked
  `WebKit WebGL` here, so the advice does not give the same string. (2) `WebGL context was lost.`: the probe and
  `device.destroy()` call `loseContext()` on purpose. (3) `texSubImage: Uploads from a buffer with a final row with a byte
  count smaller than the row stride` (142 calls of one 2048x12 `RGBA_INTEGER` upload from a 393,216-byte pixel buffer,
  alignment 1, in the lod page) and, in materials, `Tex image TEXTURE_2D level N is incurring lazy initialization`. Cause
  of (3) not found: the same call in a plain page (exact, larger or partly filled buffer, any usage) prints nothing.
- **Fixed 2026-11-11, (1):** Firefox 157's `RENDERER` names the GPU (the same string as the extension, measured in a plain
  page under Playwright), so the layer asks for `WEBGL_debug_renderer_info` only where `RENDERER` is empty or the masked
  `WebKit WebGL` (Chromium, WebKit). Regression: `packages/webgl2-compat/test/capabilities.test.js`, "the unmasked
  renderer is asked for only where RENDERER is masked".
- **Measured 2026-11-11, (3):** a plain Firefox 157 page prints the "final row" advisory for every `texSubImage2D` from a
  pixel buffer, full rows from an exact buffer included, and "partial upload ... lazy initialization" for a partial
  upload into a `texStorage2D` texture. Earlier "prints nothing" runs did not catch the console.
- **Next:** (2) the checks assert the deliberate `loseContext()` line exactly once (coordinator call); (3) initialise data
  textures at creation, and test whether another unpack alignment stops the "final row" advisory, else an upstream
  report draft. Owner: webgl2-compat (layer) and the two checks.

### Voxel path tracer on the WebGL2 layer in Firefox: the `transparent` case does not finish (found 2026-11-11, open)

- **Repro:** `MARGO_BROWSER=firefox node packages/voxel-pathtracer/tests/browser-check.mjs --compat --report=compat
  traversal analytic textures shapes transparent determinism capture viewport materialtables` on the RTX A6000 PC
  while other GPU suites ran: `traversal` to `shapes` pass, `transparent` was still running at 783 s, and closing
  Firefox then took over the 30 s shutdown budget (SHUTDOWN_TIMEOUT, "still open: browser").
- **Cause:** not found. Firefox's WebGL2 runs on ANGLE Direct3D 11, where Edge takes 90 to 125 s to compile the staged
  tracer's programs (docs/limits.md), and Firefox has no `KHR_parallel_shader_compile`, so each link blocks; the close
  likely waits on a compile in flight, as the 25 to 29 s dispose wait on Edge does. Next: time each program's link in
  Firefox on a quiet machine, and see whether the case finishes given the time.


### Accepted 2026-11-11: batch 160 environment native direct budget re-recorded one level higher (KB3574)

`node scripts/reference-rendering/environment.mjs` (native, RTX A6000) measured absolute 2,294,442 (square
76,817,356) against its budget 2,294,441 (square 76,817,341). Cause, bisected: 40e6f183dc, the deliberate GGX
importance-sampling fix (sin theta from alpha sqrt(xi / d) instead of sqrt(1 - cos^2); Walter et al. 2007,
"Microfacet Models for Refraction through Rough Surfaces", EGSR, eq. 35), which moves the split-sum LUT toward an
f64 integration (worst cell error 1.17e-3 to 4.9e-4, pinned by `packages/environment/tests/environment-browser.js`).
Putting the two old lines back renders 2,294,441; between the two renders 58 of 262,144 pixels move by one 8-bit
level. Scott ruled "re record" on 2026-11-11: the native direct budget is now 2,294,442 in
docs/whitepaper/results/batch-160-environment.json, pinned by `tests/reference-environment.test.js`; docs/limits.md
records the before and after. No other budget moved; the compatibility rows already measured lower and pass. The
furnace picture loss itself (batch 160 job 7) stays open below.

### Accepted 2026-11-11: batch 160 job 8 Cornell clustered/shadow picture loss measured and split (KB3573)

Repro: GPU-locked `node scripts/reference-rendering/cornell.mjs --decompose`, and with --point, each with and without --compat. The frozen shadowed MAE (0.7214571634928385 directional, 0.9285901387532552 point) is measured against Mitsuba hard ray visibility. Decomposition (KB3573, 2026-11-11, RTX A6000): `node scripts/reference-rendering/cornell.mjs [--point] [--compat] --decompose` renders diagnostic variants of the frozen shadowed picture against the same reference; exact budgets in batch-160-clustered-decomposition.json and batch-160-clustered-point-decomposition.json, pinned by tests/reference-cornell.test.js. Point (frozen absolute 730,273): removing only the authored range window (range 0 with shadow far 20, the same shadow camera) gives 469,266 (35.7 % of the residual; changed pixels 164,649 to 48,760, because the window darkens nearly every lit pixel by up to 3 %: clamp(1-(7.2/20)^4)^2 = 0.967 at the far corner); LocalShadows resolution 2048 gives 595,330 (18.5 %), 4096 gives 605,700; both together 346,680 (52.5 %). Directional (frozen 567,377): resolution 1024 gives 356,406, 2048 gives 212,780 (62.5 %), 4096 gives 213,642 (converged; at higher resolution the texel-scaled bias shrinks and one-pixel contact lines grow slightly). What remains at 2048 to 4096 sits on 7,310 to 8,195 reference-edge pixels (silhouettes and contacts: MSAA against a 128-spp box filter) plus one-level rounding over flat areas. Accepted difference: the range window is the documented PointLight model (a finite range must reach zero), Mitsuba's emitter has none, and the frozen scene keeps the authored range 20; the default 512 map with 3x3 PCF is the documented memory default (a point light at 2048 takes 96 MiB). Neither is a renderer defect; no default, bias, budget or frozen scene moved. Docs: docs/limits.md (batch 160 job 8). Sources: Williams 1978, "Casting Curved Shadows on Curved Surfaces", SIGGRAPH, https://doi.org/10.1145/965139.807402; Reeves, Salesin and Cook 1987, "Rendering Antialiased Shadows with Depth Maps", SIGGRAPH, https://doi.org/10.1145/37402.37435; Stamminger and Drettakis 2002, "Perspective Shadow Maps", SIGGRAPH, https://doi.org/10.1145/566654.566616 (perspective versus projection aliasing); Lloyd 2007, "Logarithmic Perspective Shadow Maps", PhD thesis, UNC, https://www.cs.unc.edu/xcms/wpfiles/dissertations/lloyd.pdf (aliasing error from map resolution); Zhang, Zhao and Sun 2009, "An Aliasing Theory of Shadow Mapping", TPCG, https://diglib.eg.org/items/5b958f7a-7b8c-46e9-ba07-4391a8dabb6a; Holbert 2011, "Saying Goodbye to Shadow Acne" (normal offset), GDC; Karis 2013, "Real Shading in Unreal Engine 4", SIGGRAPH course notes, https://cgvr.informatik.uni-bremen.de/teaching/cg_literatur/Brian%20Karis%20-%20Real%20Shading%20in%20Unreal%20Engine%204,%202013%20Siggraph%20Course.pdf (windowed inverse-square falloff).

### Accepted 2026-11-11: batch 160 job 7 environment furnace picture loss measured and split (KB3563)

Repro: GPU-locked `node scripts/reference-rendering/environment.mjs --decompose`, then with --compat (add --capture-decomposition to regenerate the hash-checked CUDA Mitsuba references). The frozen direct-only MAE 2.9175338745117188 (native) is measured against Mitsuba principled with full visibility. Decomposition (KB3563, 2026-11-11, RTX A6000): `node scripts/reference-rendering/environment.mjs [--compat] --decompose` compares the frozen Margo picture with four more Mitsuba 3.9.1 pictures from scripts/reference-rendering/mitsuba-environment-decompose.py (cuda_ad_rgb, 1024 spp, hash-checked, frozen in whitepaper/results/batch-160-environment-decomposition.json and pinned by tests/reference-environment.test.js). Of the native direct absolute 2,294,442: 128-spp reference noise 41,414 (1.8 %); scene visibility (other spheres occlude the environment, which split-sum IBL cannot see) 983,219 (42.9 %); Mitsuba principled against the glTF appendix B BRDF (Burley diffuse, its own specular mapping) 251,899 (11.0 %); Margo's deliberate multiple-scattering compensation and the diffuse that keeps the energy neither specular term reflects (Fdez-Aguera 2019), against single-scattering glTF, 532,957 (23.2 %). Against the split-sum model with its directional albedo terms integrated exactly per pixel, 484,953 remain (21.1 %): 445,796 on silhouette edges (MSAA against a box-filtered reference) and 39,157 (1.7 %) over flat areas with a signed sum of -3,965, so the LUT, SH irradiance and prefiltered cube add no measurable bias in this furnace. Compatibility rows are within 60 of these. Accepted difference: the two large shares are the documented IBL model (no scene visibility; multiple scattering on purpose) and the reference BSDF, not a package defect; no budget or setting moved. Docs: docs/limits.md (batch 160 job 7). Sources: Karis 2013, "Real Shading in Unreal Engine 4", SIGGRAPH course notes (split-sum scale and bias); Fdez-Aguera 2019, "A Multiple-Scattering Microfacet Model for Real-Time Image-based Lighting", JCGT 8(1), https://www.jcgt.org/published/0008/01/03/paper.pdf; Heitz, Hanika, d'Eon and Dachsbacher 2016, "Multiple-Scattering Microfacet BSDFs with the Smith Model", ACM TOG 35(4), https://doi.org/10.1145/2897824.2925943; Walter, Marschner, Li and Torrance 2007, "Microfacet Models for Refraction through Rough Surfaces", EGSR; Heitz 2014, "Understanding the Masking-Shadowing Function in Microfacet-Based BRDFs", JCGT 3(2), https://jcgt.org/published/0003/02/03/ (height-correlated Smith); Heitz 2018, "Sampling the GGX Distribution of Visible Normals", JCGT 7(4), https://jcgt.org/published/0007/04/01/; Burley 2012, "Physically-Based Shading at Disney", SIGGRAPH course notes (the principled diffuse that Mitsuba principled follows); Khronos glTF 2.0 specification, appendix B (BRDF implementation), https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html; Jakob et al. 2022, Mitsuba 3, https://mitsuba-renderer.org.

### Fixed 2026-11-11: gltf-pro parts culled one by one only under CulledModels (bug sweep L2, KB0027)

- **Repro:** `npm run test:gpu:parts` in packages/gltf-pro: without `CulledModels`, a 20-part 10M-triangle field draws
  all 20 parts in a close view where 9 are in the frustum (`draws` in test-results/gltf-pro-parts.json).
- **Cause:** the frame's own culling tests a gltf-pro node's bounds, not each primitive's; parts of one primitive share
  a node.
- **Fix to build:** test each primitive's sphere on the CPU in the PBR draw loop (work count: spheres tested per frame).
- **Fix:** the PBR draw loop tests each primitive's bounding sphere against the camera planes (`outsideView` in
  packages/gltf-pro/src/model.ts): one sphere test per primitive per draw call, measured once per vertex array, and a
  part out of view issues no draw. Primitives whose vertices may move (instanced, skinned, morphed, deformed, own
  shader, displacement map) are not tested. Regression: packages/gltf-pro/tests/parts.test.js ("each part culls on its
  own"): a strip in 3 parts with a frustum over the first draws 1, not 3.

### compressDraco cannot encode a 10M-triangle mesh with normals and UVs (found 2026-11-11, open)

- **Repro:** `encodeNativeMesh` in `packages/exporters/src/draco-native-encode.ts` with a 5,004,169-vertex,
  9,999,392-triangle grid carrying float positions, normals and UVs: its packed input is 280 MB.
- **Cause:** the encoder refuses packed input over 256 MiB (`Draco encoder input exceeds 256 MiB`); the decoders read
  up to 384 MiB of output since 2026-11-11, so files at that size decode but cannot be re-encoded here.
- **Fix to build:** size the encoder's input ceiling from its measured peak memory as the decoders' was.

### gltf-pro extensions browser check: the page went away once on the WebGL2 layer (found 2026-11-11, open)

- **Repro:** `MARGO_COMPAT=1 node packages/gltf-pro/scripts/test-extensions-browser.js` on the dev PC while 30 package
  test suites ran beside it: "lights: the real EnvironmentTest" failed with `page.evaluate: Execution context was
  destroyed`. Run alone, and the full check run again on the same build and on origin/main 519906bcf6, it passed.
- **Cause:** not found. The page was replaced or its renderer exited after about 40 earlier checks on one page, under
  heavy memory load; nothing in the failing check navigates. Next: record the renderer's exit reason and memory when
  the context goes, so a repeat names the cause.

### Path tracer analytic furnace read low twice on the WebGL2 layer under a concurrent GPU load page (2026-11-10, open, not reproduced)

- **Repro (not reproduced since):** `analytic` of `packages/voxel-pathtracer/tests/browser-check.mjs` on ANGLE Vulkan
  while a second browser traced 1024 x 1024 viewport batches on the same RTX A6000 gave "clear glass" 0.8459 against 1
  and "emissive media sigma 0.125" 9.83 against 10.11 once each, like paths cut short. The same case passed in 4 of 4
  later loaded runs, in every full `MARGO_COMPAT=1 test:gpu` run on 2026-11-11 and alone; the failing logs were not kept.
- **Cause:** not found. Ruled out by reading `packages/voxel-pathtracer/src/compat.ts`: renders and the viewport trace
  share the route but run one after another; the learned horizon is checked by a census at the horizon in every part;
  each occlusion query is held until its resolve reads it. Two flaws found on the way are fixed: dispatches of more than
  2,048 parts were stopped at the horizon without that check (they now run adaptively to the loop's limit), and disposed
  tracers were never collected (above), which put the page under heavy memory pressure. A third flaw that fits the
  symptom is fixed: the WebGL2 layer never read `GL_OUT_OF_MEMORY`, so a buffer or texture the driver could not allocate
  read as empty and drew silently; it now reads `getError()` once after each allocation and reports an `out-of-memory`
  error (`GPUOutOfMemoryError`) to its scope or as `uncapturederror` (packages/webgl2-compat/test/device.test.js).
- **Next:** rerun the loaded pair (`analytic` repeated beside a 1024 x 1024 viewport page) on the quiet machine with the
  results kept, watching for an `out-of-memory` error.

### SSGI multiBounce off does not return the one-bounce frame exactly under MARGO_COMPAT=1 (found 2026-11-11, open)

- **Repro:** `MARGO_COMPAT=1 node scripts/gpu-lock.mjs run --owner=<lane> -- node packages/post/test/ssgi-bounce-browser.mjs`
  fails at `ssgi-bounce-browser.mjs:108` ("switching multiBounce off gives the one-bounce frame back exactly", 1 !== 0).
  It fails the same way on `main` before the clear-colour fix (53bbc39b42), so that fix did not cause it; native passes.
  Same defect as "ANGLE D3D11 SSGI trace difference" further down; this entry holds the 2026-11-11 measurements.
- **Cause, as far as it is located (RTX A6000, Chrome ANGLE D3D11, aaace8b22f):** below the GL calls Margo makes, not
  state Margo keeps across the toggle. Measured on this PC: 48 one-bounce frames with no toggle are bit-identical;
  switching recreates every SSGI target, and forcing that recreation six times without `multiBounce` changes nothing;
  three short `multiBounce` round trips change nothing. After 43 multi-bounce frames, the first two one-bounce frames
  are exact and the frame 30 later differs in 97 channels by one level, with nothing changed in between; with waits or
  a recorder slowing the calls, a run can pass. In a failing run the full-payload GL stream of a one-bounce frame
  before the round trip and one after it are identical (509 calls, uniforms and uploads included, object identities
  checked, no deleted object used again). The same flow under `--use-angle=vulkan` is exact at every step. So the
  GPU work Margo submits is unchanged and its result drifts with time on D3D11 only.
- **Next idea:** a D3D11 repro outside Margo (the trace shader alone, identical draws timed apart) to report upstream;
  the test and its exact assertion stay unchanged.

### Fixed 2026-11-11: OpenEXR chromaticities were read as sRGB (Rust finding R10)

- **Repro:** an EXR whose `chromaticities` attribute names ACEScg (AP1) primaries and one pixel (1, 0, 0): `parseEXR`,
  `/exr-tiled` and the `/exr-codecs` worker returned (1, 0, 0), where linear sRGB is about (1.705, -0.130, -0.024).
- **Cause:** `packages/environment/src/exr.ts` skipped the attribute, so every decode path treated the data as Rec.709.
- **Fix:** `packages/environment/src/exr-primaries.ts` reads the attribute from any part's header and converts RGB with
  the RP 177 plus Bradford matrix `parseHDR` uses for Radiance PRIMARIES, in all three readers; images report
  `primaries` and `primariesConverted`, and `encodeEXR` writes `chromaticities`. Regression:
  `packages/environment/tests/exr-chromaticities.test.js`.


Batch 170 React harness (2026-11-10): when an external engine module fails to evaluate (seen with an R3F build whose React bundle read `process.env`), `bench/scenes/page.js` top-level `await import(...)` rejects without setting `window.result`, so `bench/lib/browser.mjs` waits its full 600 s before the case errors. Repro: an engines.json entry whose module throws on import, then `scripts/parity-smoke-browser.mjs --standard=react --engines=margo,<that engine>`. Cause: the engine import is outside the harness's error reporting. Fix in the fix phase: report the import error as the case result, with a test that loads a throwing module.


Fixed in lane Q fix phase (2026-11-10): Spline at/tangent/atDistance and CubicSpline tangent explicitly return typed arrays. Their emitted declarations no longer derive a possibly undefined return from an optional output parameter. The strict built-declaration consumer in packages/splines/test/declarations.test.js checks omitted, explicit undefined and caller-owned outputs, direct ControlPath assignment and the PathControls constructor argument; it fails before the repair.

Lane B README runtime gate (2026-11-10): concurrent check:readme-run commands in distinct worktrees serialize as one lane because scripts/run-readme-examples.mjs passes the constant owner check-readme-run and scripts/support/gpu-admission.mjs sameLane compares owner-derived lane names across worktrees. Repro: start the full local CI README runner, then a narrowed runner elsewhere while another GPU slot is free. Run a narrowed command under scripts/gpu-lock.mjs run --owner=lane-B-readme so nested locking retains a real lane identity; fix the runner owner at its owning lane in the fix phase.

Fixed in lane Q fix phase (2026-11-10): KHR_animation_pointer transmissionFactor can start at zero, become positive, then return to the opaque path. The physical parser reserves medium state from extension presence and native capture admission observes that capability; the pointer writer activates tint only for a positive factor. Regression: packages/animation/tests/volume-pointer.test.js, packages/gltf-pro/tests/beer-distance.test.js and packages/gltf-pro/tests/native-volume.html. Source documents remain unchanged.

Lane B gate sweep (2026-11-10): `node --test --test-timeout=120000 tests/check-example-types.test.js` fails its cameras-scoped expectation because cameras now reaches 14 packages, above the unchanged 12-package full-run threshold; the planner correctly selects all projects but the fixture expects a named subset. Outside the API-record classification job; reconcile the fixture in the fix phase without weakening closure coverage.

Lane B gate sweep (2026-11-10): `node --test --test-timeout=120000 tests/no-private-paths.test.js` finds 12 tracked files with references to excluded local paths (clean-room, known-bugs, limits, sciviz-a11y, whitepaper claims/reproduce/atmosphere result, netcode lobby test, accessibility audit, two sciviz preparation scripts and llms-full). Cause: producers committed machine-local evidence pointers unavailable in a clone; replace at the owning producers in the fix phase. No classification or assertion change.

Batch 180 job 3 geo-time: no open correctness defect found in the implemented trajectory, WMTS time or SGP4 paths. Quantized trail fading and rebuilt primitives on seek are documented limits; efficient in-place updates remain quality work. All 29 published orbital cases and both rendering backends are covered.



Batch 186 job 1: disk/sphere shadows use the existing centre-map PCSS approximation and guard band (limits.md); no exact extended-emitter visibility claim. Native WebGPU and full WebGL2 production-shader visibility checks pass.


Batch 190 job 2: no open defect found in float32 weighted accumulation. The entry deliberately retains the original weighted-depth approximation and sorted paths for transmission/custom blending; finite f32 sums and final HDR target range are recorded in limits.md.

Batch 190 job 1: no open defect found in depth peeling's distinct-depth transport contract. Single-sample transparent coverage and coplanar depth coalescing are explicit limits in limits.md; finer edge reconstruction and coplanar tie handling remain future quality work, not exact-fragment-list claims.

### Radeon 680M: pixel's `screen` blend lands one step below the exact result (list 5 R6 row 14, 2026-11-10, open)

- **What:** `packages/pixel/tests/browser-check.js`, case `screen`, on the Beelink (Radeon 680M, RDNA2, driver
  32.0.21030.2001, Chrome on D3D12): 80 pixels one step below the CPU image, the first at (44, 4), red 157 where the
  CPU image has 158. The other blend cases pass.
- **Repro:** source 151 composited over destination 16 with `screen`, the fixed-function blend `color: one,
  one-minus-src` of `LayerCompositor` (`packages/pixel/src/index.ts`). Exact: 151 + 16 x (1 - 151/255) = 151 + 16 x
  104/255 = 157.5255, which the CPU model rounds to 158. The 680M writes 157, as if it took the destination product
  (6.5255) to a whole byte before the add.
- **Cause:** below Margo, in the blend unit's precision. WebGPU leaves blend arithmetic precision undefined, so a GPU
  may round the intermediate product; every whole-byte `screen` result is at least 1/510 of a step from x.5, so a GPU
  that blends in float gets the CPU image exactly, and this one does not. The test's tolerance and the test stay as
  they are (Scott's ruling, 2026-11-10).
- **Why the blend stays in the blend unit:** an exact blend in the shader needs the destination as a texture, and the
  compositor does not have it: `composite()` draws every layer, in order, into the frame's colour attachment in one
  render pass, so the destination of a `screen` layer is that pass's own attachment (a canvas texture configured by
  core for rendering only, and multisampled when the engine is). Reading it would need, per `screen` layer, the pass
  ended, the covered region copied (or resolved) to a texture, and a new pass begun, or the whole composite moved to
  an extra target: a new copy and an extra render pass per frame, which Scott's ruling (2026-11-10) does not allow.
- **Upstream report (draft, nothing filed):** `docs/upstream-reports/KB0171/report.md` with the raw WebGPU and WebGL2 page `screen-blend.html`. Reproduces on 2026-11-11 on this PC's AMD RDNA2 iGPU (19 of 1024 pixels off, including source 151 over destination 16: 157 instead of 158) and not on the RTX A6000.

### Fixed 2026-11-11: the transitions GLSL oracle and the WGSL port disagreed at a texel edge (list 5 R6 row 21)

- **What:** `packages/transitions` `test:gpu` (`test/glsl-browser.js`) on the Beelink (Radeon 680M): fixture `matrix`
  at p = 0.25, texel (12, 2) channel 0: the native WebGL2 oracle gives 145, the WGSL port 133.
- **Repro:** the rotated lookup of `matrix` lands at x = 10.99938 texels of a nearest-filtered gradient, 6e-4 of a texel
  below the edge between texels 10 and 11. 133 is texel 10 (167 and 32 mixed at 0.25), 145 is texel 11.
- **Cause:** the two read the texture differently near an edge. The oracle samples through the hardware (GL `NEAREST`):
  a sampler snaps the coordinate to its subtexel grid (1/256 of a texel in D3D11) and on this GPU the snap rounds up to
  texel 11. The product's `sample()` (`src/custom-code.ts`, `src/builtin.ts`) floors exactly with `textureLoad`, and the
  harness mirrors the product, so it reads texel 10. Neither is wrong for its own rule; a lookup within one snap step of
  an edge picks a different texel.
- **Not done:** a harness that samples through a nearest sampler would pass, but the product does not sample that way,
  so the harness would no longer test the product (manager's ruling, 2026-11-10). Fixing it means choosing one rule for
  the product: keep the exact floor (and give the oracle comparison a documented edge allowance) or sample through a
  nearest sampler as GLSL transitions do.
- **Fix (coordinator ruling 2026-11-11, under Scott's "fix everything else"):** the product keeps its rule, the WebGPU
  spec's nearest texel selection (the texel containing the coordinate: truncate uv * size, clamp), and the oracle now
  applies the same rule with `texelFetch` (`margoFetch` in `test/glsl-browser.js`, the GLSL bottom-left flip included,
  `texture2D` and `texture2DProj` mapped to it), so oracle and port agree exactly at the edge. No allowance added. New
  fixture `texel edge` reads 6e-4 of a texel either side of an edge. Regression: `test/glsl.test.js` "the GLSL oracle
  reads texels by the product rule, not through a sampler"; the GPU fixture passes native and compat on the RTX A6000
  (whose sampler truncates, so the old oracle passed there too); the Radeon 680M rerun is the hardware proof still owed.

### Radeon 680M: the 4x MSAA resolve rounds an exact .5 average by draw history (list 5 R6 row 8, 2026-11-10, worked around in the checks)

- **What:** `packages/culling` `dynamic-check.mjs`, `parts-check.mjs` and `lod-check.mjs` on the Beelink (Radeon 680M,
  driver 32.0.21030.2001, Chrome on D3D12) found 1-level channel differences on 6 to 67 resolved pixels between the
  culled engine and core, which draws the same instances in another order once a mesh hides.
- **Cause:** below Margo. The multisampled colour samples of both engines are equal bit for bit (read before the
  resolve); only the resolved pixel differs, where the four samples average to exactly x.5 and the resolve rounds it
  one way or the other depending on what was drawn before. WebGPU does not define the resolve's rounding.
- **Workaround:** those checks compare the samples before the resolve (`test/gpu/msaa-samples.js`, `msaa.mjs`; Scott's
  decision 2026-11-09), with a control that drops one box from the culled engine alone and must show. `meshlets-check`
  compares A and B without MSAA instead. On the WebGL2 layer the resolved frames are compared as before.

### Radeon 680M: a colour attachment's export narrows the shader output to binary16 by truncation (list 5 R6 row 25, 2026-11-10, worked around in webgl2-compat)

- **What:** `packages/webgl2-compat` `test:gpu:preview-contract` (`test/package-tiers-browser.mjs`) on the Beelink
  (Radeon 680M, driver 32.0.21030.2001, Chrome, WebGL2 on ANGLE D3D11): the procedural texture baker (bricks,
  16 x 16) stored red 133 at texel (3, 0) on the WebGL2 layer where native WebGPU stores 134; the other 15 texels of
  the row matched.
- **Repro:** a CPU model of the bake in f32 (the bricks shader, op by op): texel 3 is 133.5204 / 255. Rounded straight
  from f32, as a WebGPU storage texture store does, that is 134, and the model gives native's whole row. Truncated to
  binary16 first (11 significant bits: 0.523609 becomes 0.5234375, 133.477 / 255) and then rounded, it is 133, and
  that model gives the layer's whole row. `compute-browser.mjs` case `fragmentUnormRound` stores (k + 0.52) / 255 and
  three other near-half values into an rgba8unorm storage texture: before the fix the layer stored k on many texels
  (the first at texel 8, blue 8.505 / 255) where native WebGPU stores k + 1.
- **Cause:** below Margo. The layer runs a compute store into rgba8unorm as a draw into a colour attachment, and the
  680M's driver exports the fragment output to an 8-bit target as binary16, truncating, before the UNORM conversion
  (the same truncation as R6 row 7's half targets). WGSL's inverse channel transfer function for 8unorm only clamps
  (WGSL, "Texel Formats"), so which of the two nearest steps a GPU stores is its own choice, and GPUs differ: the
  dev PC's RTX A6000 (Chrome, D3D12 and ANGLE D3D11 alike) stores k for (k + 0.52) / 255 when k % 16 is 0 to 10 and
  k + 1 otherwise, and only from k + 0.57 up on every k (probe of 256 x 21 values, storage store, render target and
  raw WebGL2 all equal), where the 680M's storage store rounds to the nearest.
- **Workaround (`packages/webgl2-compat/src/compute/glsl.ts`):** the fragment and scatter tiers round a float texel to
  the 255 steps in the shader before an 8-bit UNORM target stores it, as the CPU tier's quantize already did. A value
  on the k / 255 grid survives any narrowing to 11 or more bits (under 0.13 of a step), so every GPU stores exactly
  the nearest step. Because native WebGPU's own rounding differs by GPU, `fragmentUnormRound` and
  `scatterUnormRound` check the layer against the nearest step computed in f32 and native against the two nearest
  steps; comparing the layer to native byte for byte failed on the A6000 (layer 1, native 0 for 0.52 / 255) after the
  first version of this fix. The procedural texture baker (`texture-shader.ts`, `textures-webgl.ts`) rounds to the
  255 steps itself, as its PBR baker already did, so the store's rounding no longer depends on the GPU or tier;
  before that, the preview-contract baker comparison failed on the A6000 (layer 134, native 133 at texel (3, 0)).
  Not rerun on the Radeon 680M (the Beelink was unreachable on 2026-11-10): by the spec both checks hold there, since
  its native store rounds to the nearest and the layer's grid values survive its truncation.

### Fixed 2026-11-11: in WebKit a check's first run could be the previous document's, at 300 x 150 (KB-L4-W1)

- **Repro:** on the Apple M6 Mac, `MARGO_BROWSER=webkit node packages/sky/test/browser-check.mjs` in a freshly copied
  checkout failed `night-citadel 4x frame 0 scene vs control` in about 1 run in 10 (3 of 21, then 1 of 19 and 1 of
  12): the `full` frames were 300 x 150 (45,000 pixels) against 256 x 192. Smaller: tests/stale-document.test.js
  under `MARGO_BROWSER=webkit` fails both its cases without the fix.
- **Cause:** Playwright's WebKit keeps resolving the WebGPU promises of a document after the tab has navigated away
  from it. openBrowser loads the check's page, and the check navigates to it again at once; on a first load (Vite
  transforms every module) the first document was still starting up, so it finished in the background with no page
  (hidden, innerWidth 0, devicePixelRatio 0, so the engine kept the canvas default 300 x 150). Every document of a tab
  shares one `window` object, so its `window.ready = true` and `window.check = {...}` landed on the new document, and
  the check's first `check.run` was the old document's. Traced by logging each document's `performance.timeOrigin`
  and state inside one run: the run started in a 346 ms old hidden document and its frames read the 48 ms old one. No
  canvas size was ever written to 300; core's resize is not involved and needs no change. No page reload happened, and
  the dependency scan message was a separate defect (fixed below).
- **Fix:** openBrowser installs `holdStaleDocumentGpu` (scripts/support/stale-document.js) first in every page: once a
  document's `pagehide` has fired, each WebGPU promise it settles is held, so its script stops at its next GPU wait; a
  document the back/forward cache shows again gets the held results. Chromium and Firefox already stop a left
  document's script. Before the fix 5 of 52 fresh-folder sky runs on the Mac failed; after it 60 of 60 passed.
  Regression: tests/stale-document.test.js.

### Fixed 2026-11-11: the browser teardown test failed on main over a standalone upstream repro runner

- **Repro:** `node --test tests/browser-teardown.test.js` after c456fb6d05 named `docs/upstream-reports/run-page.mjs`
  as a script that starts a browser and a server without `closeAll`.
- **Cause:** the runner opens repro pages for other projects' bug trackers and must carry no Margo code, so it cannot
  import `scripts/support/shutdown.mjs`; the checker covered every tracked script.
- **Fix:** the checker skips `docs/upstream-reports/`, with the reason beside the rule (49e7d087c5). Those scripts run
  by hand, never in a suite or gate. Regression: tests/browser-teardown.test.js.

### Fixed 2026-11-11: every suite dev server scanned every HTML page in the checkout for dependencies

- **Repro:** `startDevServer({ startPath: '/LICENSE', port: 0 })` from `scripts/browser.js`; its
  `server.config.optimizeDeps.entries` held the root `vite.config.mjs` list (`'**/*.html'` and its exclusions) as well
  as the start page.
- **Cause:** startDevServer passes `optimizeDeps.entries: [startPath]`, but Vite's mergeConfig concatenates arrays, so
  the root config's whole-checkout pattern came along. Each suite server scanned every page before its first load, and
  one unresolvable import in any other page (an untracked local page, for example) failed the scan ("Failed to run
  dependency scan"), which skips pre-bundling for the suite's own page.
- **Fix:** the start-owner plugin sets the resolved `optimizeDeps.entries` to the start page alone, next to the watcher
  setting it already overrides for the same reason. The root dev servers keep the root config. Regression:
  tests/dev-server-watch.test.js ("a suite dev server scans only its start page").

### Fixed 2026-11-11: `gpu-lock run` refused browser checks, so they ran outside the GPU slot cap (KB-GL1)

- **Repro:** `node scripts/gpu-lock.mjs run --owner=lane-x -- node scripts/csp-check.mjs` exited 2 with
  `ERR_GPU_COMMAND_NOT_GPU`. Helpers then started such checks directly, and 8 GPU users were seen at once against the
  5-slot cap.
- **Cause:** the admission check in `scripts/support/gpu-command.mjs` knew a node script as a GPU leaf only by a GPU
  word in its file name (gpu, browser, pixel, capture, render, xr). Browser checks named for what they check carry none.
- **Fix:** a node script that imports `playwright` or one of the repository's browser launchers, itself or through its
  own relative imports up to three files deep, is a GPU leaf, so `run` admits it and it holds a slot. CPU commands are
  classified as before. Not chosen: having the browser host take a slot itself, since one slot per lane and children
  started without the nested marker could deadlock. Regression: tests/gpu-command.test.js.

### Fixed 2026-11-11: Playwright's headed Chromium and Firefox would not start from a packaged app's redirected %LOCALAPPDATA%

- **Repro:** from a process of an MSIX-packaged app on Windows (the Claude desktop app), start
  `%LOCALAPPDATA%\ms-playwright\chromium-1248\chrome-win64\chrome.exe --headless --dump-dom about:blank` with Node's
  `spawnSync`: `spawn UNKNOWN`, and the Application event log reports a side-by-side error. The same file by its
  real path (`fs.realpathSync.native`, inside the package's `LocalCache` folder) starts.
- **Cause:** the package redirects `%LOCALAPPDATA%` for its own processes, but Windows builds the new process's
  side-by-side activation context from the path it was given, outside the redirection, and finds no private assembly
  beside it. Firefox (`mozglue`) and full Chromium hit it; Chromium's headless shell, Edge and Chrome do not.
- **Fix:** `scripts/lib/browser.mjs` starts Playwright's Firefox (`firefoxExecutable`, 34fe47227a) and its headed
  Chromium (`chromiumExecutablePath`) by their real paths. Headless Chromium, Edge, Chrome, WebKit and an executable named
  by the caller or `BROWSER_EXECUTABLE` start as before. Regression: tests/browser-selection.test.js. Checked from the app:
  headed `MARGO_BROWSER=chromium` failed with `spawn UNKNOWN` before and starts now.

### Fixed 2026-11-11: SSR and SSGI kept a clear-colour buffer after disposal

- **Repro:** SSR or SSGI in a partial view (a viewport smaller than the canvas), then dispose it: the 16 byte uniform
  buffer behind its material clear stayed alive until 64 newer colours evicted it or the device went. With
  `ssr: ['SSR'], ssgi: ['SSGI']` in `packages/post/test/owner-lifetime.fixture.js`, all 22 `SSR.attach` and
  `SSGI.attach` cases of `check:owners` failed 'no leaked GPU buffers, textures or query sets'.
- **Cause:** `packages/shared/clear-color.js` caches one buffer per colour per device, and nothing released post's
  entries when the pass that made them went away.
- **Fix (0 B in core + stage):** post bundles its own copy of the cache, used only by its material clears. The new
  `releaseClears(device)` export (core never imports it, so core's bundle drops it) hands back the device's cached
  colour buffers; `MaterialClear.dispose()` retires them, and SSR and SSGI call it whenever they release their targets
  (resize, device restore, dispose). Another live clear on the device makes its colour again on its next partial view.
  Tests: `packages/post/test/material-clear.test.js` (fails on the old build: dispose and restore left the buffer),
  `tests/clear-draw.test.js`, and SSR and SSGI in the post owner fixture.

### Fixed 2026-11-11: per-object `device.lost` reactions kept disposed objects alive as long as their device

- **Repro:** make and dispose an object below many times on one live device, then collect garbage: the disposed objects
  stayed reachable from the device's `lost` promise (a heap snapshot shows `GPUDevice.lost` -> PromiseReaction ->
  closure context -> the object). `VoxelPathTracer` grew a test page to 4.7 GB of JavaScript heap over 204 renders
  until it stalled.
- **Cause:** a reaction on `device.lost` cannot be removed, so a closure made per object (and the closure context it
  shares with the object's other closures, which often holds `this`) lived as long as the device.
- **Fix:** one reaction per device over a set the objects leave on dispose, each with a test that fails on the old
  build: the path tracer (`packages/voxel-pathtracer/tests/tracer.test.js`), `@margoengine/inspector` texture capture
  (`test/textures.test.js`), `@margoengine/toon` model hatching (`test/hatch-models.test.js`), `@margoengine/xr`
  (`tests/xr.test.js`), the `@margoengine/biomes` placement and flow session (`tests/gpu-placement-flow.test.js`),
  `@margoengine/materials` texture copies and material uniforms (`test/device-lost.test.js`) and the
  `@margoengine/react` separate roughness map (`test/roughness-feature.test.js`). `packages/biomes/src/gpu.ts`,
  `packages/shader/src/compute.ts`, `packages/shared/frame-resources.js` and `packages/environment/src/environment.ts`
  already kept one reaction per device; `@margoengine/procedural` bakes hold only a `WeakRef` to their controller.

### Fixed 2026-11-11: a video texture threw in Firefox (copyExternalImageToTexture refuses video sources)

- **Repro:** `MARGO_BROWSER=firefox node packages/materials/test/browser-check.mjs` (WebGPU, Firefox 157): the `video`
  scenario threw `GPUQueue.copyExternalImageToTexture: 'source' member of GPUCopyExternalImageSourceInfo could not be
  converted to any of: ImageBitmap, HTMLImageElement, HTMLCanvasElement, OffscreenCanvas`.
- **Cause:** Firefox's `copyExternalImageToTexture` takes no `HTMLVideoElement` or `VideoFrame`, which the spec and
  `ImageSource` allow. **Fix:** materials copies the frame through a canvas when the queue throws that TypeError, once per
  queue. Regression: packages/materials/test/texture-region.test.js. Other packages that pass a video to
  `copyExternalImageToTexture` (points, voxel, xr, video) are not checked in Firefox yet.

### Fixed 2026-11-11: README examples stalled behind the previous example's shader compiles in a shared browser

- **Repro:** `npm run check:readme-run -- --packages=voxel-pathtracer` on main c37980e173: the resampled emissive
  lighting example missed its 20 s deadline while waiting for module completion, and the runner then failed closing the
  browser (`browser host ... did not acknowledge the end`). Run alone (`--only=resampled-emissive`) it passed.
- **Cause:** every page example shared one browser; closing a page does not end its GPU process, so shader-compile
  teardown left by the example before held the GPU process the next example's `requestAdapter` waited on.
- **Fix:** `scripts/run-readme-examples.mjs` gives each page example its own browser and closes it, within the same
  20 s deadline; a browser that arrives after the deadline is closed without a page. 27 of 27 examples of the path
  tracer and the WebGL2 layer pass. Regression: `tests/run-readme-examples.test.js` (two tests that fail on the old
  runner).

### Fixed 2026-11-11: every `onSubmittedWorkDone()` on the WebGL2 layer took about 270 ms when no frame was shown

- **Repro:** `npm run check:owners -- --packages=materials` on ANGLE Direct3D 11 (Chrome 157, RTX A6000): the native
  leg passed its 44 cases, the WebGL2-layer leg stopped at its 180 s limit (`OWNER_GPU_TIMEOUT`), the same on main's
  own materials code. Timed per case it was no hang and no shader compile: every case took 2.8, 5.5 or 7.7 s whatever
  the fixture, one step of about 0.28 s per wait after a render, and 44 cases need about 230 s.
- **Cause:** the owner check renders into its own texture and waits with `onSubmittedWorkDone()`, which the layer
  answers with a fence and `gl.flush()`. On Direct3D 11 that fence reported signaled only after about 17 polls (about
  270 ms) on a context that showed no frame; raw WebGL2 with no layer does the same, also for a fence with no work
  before it. A frame shown on a page canvas, or any command after the fence (a 4-byte buffer copy, a pixel-buffer
  `readPixels`), makes it signal on the next poll.
- **Fix:** the device's fence (`fence()` in `packages/webgl2-compat/src/device/tasks.ts`) sends a 4-byte copy between
  two buffers of its own after the fence, before the flush. The fence then signals on the first poll (7 of 7), and the
  materials owner check passes on both legs in 26 s together. No limit changed. Regressions:
  `packages/webgl2-compat/test/task-polling.test.js` ("a device fence is followed by a command of its own ...") and
  `packages/webgl2-compat/test/idle-fence-browser.mjs` in `test:gpu` (18 fence checks before, 1 after).

### Fixed 2026-11-11: a voxel path tracer run could overrun a small GPU's watchdog (KB-BL1, Beelink Radeon 680M)

- **Repro:** a path tracer GPU suite on the Beelink mini PC (Radeon 680M, integrated) crashed the machine. The tracer's
  bound was 2^20 paths a dispatch (bug 25), measured on the RTX A6000 at the default 8 bounces: it did not count the
  path loop (1,312 iterations a path at `maxBounces` 64 against 192 at 8, 6.8 times the work), nor the GPU (the 680M
  runs the tracer about ten times slower), and the viewport put all of a frame's bands in the frame's one submission,
  which a GPU that preempts only between submissions (AMD reports packet boundaries; KB4037 below) runs as one piece
  against Windows' 2 s watchdog. `renderImage` dispatched a whole tile (up to 1,088 x 1,088 paths) at once.
- **Cause:** the work bound counted paths, not path-iterations, per dispatch rather than per submission, and was fixed
  to one GPU's speed.
- **Fix (`packages/voxel-pathtracer/src/dispatch.ts`, `src/tracer.ts`):** a submission carries at most 2^20 x 192
  path-iterations (`SUBMIT_WORK`; fewer paths at more bounces), and a tracer starts at a sixteenth of that, then sizes
  its row bands to what its own GPU finished in 50 ms (`WorkPacer`, from submission to completion, at most twice the
  step before). Every viewport band and every `renderImage` band is a submission of its own. Bands change no pixel's
  sums and sample runs follow the fixed figure, so images do not depend on the GPU's speed: the browser check's
  `determinism` case renders with one 8-row band a submission and gets the same image bit for bit. The WebGL2 route
  already submits one part (2^17 paths) for one window (8 iterations) at a time, within the first budget. A converged
  viewport submits nothing; a hidden tab draws no frames. Every shader loop is bounded by structure: the path loop by
  `limit`, light loops by uniform counts, brick and cell walks step one cell along one axis each turn and stop outside
  the grid (a NaN distance steps z), the instance tree visits each node once.
- **Regression:** `packages/voxel-pathtracer/tests/dispatch-budget.test.js` (work per submission at 64 bounces, one
  submission a band, the first budget a sixteenth, renderImage bands, converged frames submit nothing, the route's
  window); three of its tests fail on the old code. `packages/voxel-pathtracer/tests/browser-check.mjs` `determinism`
  (bands change no value). The machine-profile fallback that let the suite run there is fixed separately.
- **Sources:** Microsoft, [Timeout Detection and Recovery (TDR)](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/timeout-detection-and-recovery)
  (2 s default, per scheduled packet); Microsoft, [DXGI_COMPUTE_PREEMPTION_GRANULARITY](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/ne-dxgi1_2-dxgi_compute_preemption_granularity)
  (DMA buffer, dispatch, thread group, thread boundaries); S. Laine, T. Karras, T. Aila, "Megakernels Considered
  Harmful: Wavefront Path Tracing on GPUs", HPG 2013 (bounded work per launch).

### Fixed 2026-11-11: the path tracer's transparent render never compiled on Direct3D 11 (WebGL2 layer)

- **Repro:** `transparent` of `packages/voxel-pathtracer/tests/browser-check.mjs` with `MARGO_COMPAT=1` on ANGLE
  Direct3D 11, a fresh browser profile: the CPU sat in the driver's shader compiler with the GPU idle, and the case was
  stopped at the 22 minute limit without finishing; the whole compat check never passed.
- **Cause:** the `coverage` kernel in `packages/voxel-pathtracer/src/shaders.ts` looped a constant 64 times around a
  traversal (`closest()`), and fxc unrolled it into 64 traversals.
- **Fix:** the loop takes its bound from the frame uniform (`tile.w`, written as 64 by the tracer), so the program holds
  one traversal; the same image hashes on WebGPU, and `transparent` passes in 89.4 s. Regression:
  `packages/voxel-pathtracer/tests/compat-staged.test.js` ("layer-compiled kernels ... hold no constant-bound loop around
  a traversal").

### Fixed 2026-11-11: VirtualShadows lost a centimetre model's shadow, and a model framed from kilometres

- **Repro:** `node packages/shadows/test/scale-browser.mjs --virtual`: before the fix the 1 mm, 2 cm, 1 km, 2 cm with
  core's default camera and BoomBox cases kept every umbra pixel lit (4,626 of 4,626; the BoomBox shaded 0 pixels).
- **Cause:** `VirtualShadows` defaults were fixed world lengths: a depth bias of 0.002 and a normal offset of 0.02 (the
  whole size of a 2 cm model), a 500 unit reach (a camera 3 km away was outside it) and with it level 0 texels of 4.4 mm.
- **Fix:** each receiver moves a quarter texel of the page it reads along its normal and compares 2^-20 of the depth
  range nearer the light, a range that scales with the reach (`bias` and `normalBias` add to them, default 0); an unset `distance` and `casterMargin` scale by powers of two
  with the camera's target distance (`reachScale` in `packages/shadows/src/pages.ts`: 1 from 1 to 25 units, finer
  closer, at least 20 times it farther), the pool rebuilt on an octave change. Regression:
  `packages/shadows/test/scale-browser.mjs --virtual` (1 mm to 1 km, the default camera and the BoomBox, WebGPU and
  MARGO_COMPAT=1) and `packages/shadows/test/virtual-pages.test.js`.

### Fixed 2026-11-11: a model a few centimetres across cast no visible directional shadow

- **Repro:** the loading-gltf guide with the Khronos BoomBox (about 2 cm) at its own size: the floor showed no shadow.
- **Cause:** three `Shadows` defaults were fixed world lengths, right for a model of about a metre and wrong at other
  scales. A model (`loadGLTF`, materials' `createMesh`) never fitted the cascades, which fit only core meshes, so they
  spanned 0.1 to 500 m and the first cascade's texels were 6 cm wide; the depth bias was 0.0005 of a depth range of at
  least 200 m (0.1 m) and the normal offset 0.02 m, both larger than the model; and the 500 m `distance` left a model
  framed from kilometres outside the shadowed range.
- **Fix:** still models fit the cascades as core meshes do (their local boxes cached, not recomputed each frame); the
  depth range reaches the farthest caster instead of 100 m; below one unit the cascade radius rounds to 1/16 of its
  octave; every receiver's normal offset and depth bias are fractions of its cascade's texel (`normalBias` and `bias`
  now add to them, default 0); and the default `distance` is 500 or 20 times the camera's target distance, whichever
  is farther. Steady-frame GPU calls and uploaded bytes are unchanged (deformed-shadows, quality-presets and
  gltf-pro-lighting-hooks proofs). Regression: `packages/shadows/test/scale-browser.mjs` (1 mm, 2 cm, 1 m, 100 m, 1 km,
  the default camera and the BoomBox, WebGPU and the WebGL2 layer) and `packages/shadows/test/scale.test.js`.

### Fixed 2026-11-10: weather machine stopped its schedule on a refused call and dropped time after 256 steps

- **What:** `WeatherMachine.transitionTo` and `set` (`packages/weather/src/machine.ts`) cleared a running schedule or
  random walk before checking the target, seconds and ease, so a refused call still stopped it. `update` processed at
  most 256 blends and holds per 5 s piece and silently dropped the rest of the time: 300 steps of 1 ms in one
  `update(5)` arrived short. Found in Scott's native Rust engine, which ported this machine.
- **Fix:** both check first, then stop and start; a piece runs every blend and hold that ends inside it, and throws
  only if zero-length steps make no progress past a bound set by the schedule length. Regression:
  `packages/weather/tests/weather.test.js` (both tests fail on the old machine).

### Fixed 2026-11-10: a MASK texel with alpha equal to alphaCutoff was cut where vertex alpha was 1

- **What:** glTF 2.0 keeps a MASK texel whose alpha is greater than or equal to `alphaCutoff`. With base colour alpha
  0.5, cutoff 0.5 and COLOR_0 alpha 1 (or no COLOR_0, which packs 1), the gltf-pro colour pass cut 40,257 of 77,822
  pixels of a tilted grid and the pick pass lost 8 of 64 points (RTX A6000, WebGPU). Cause: the stage output alpha
  of 1 reaches the fragment through perspective-correct interpolation as 0.99999994 in some pixels; the
  `vertexAlpha: false` caster path wrote `o.alpha=1.0` and kept the same fault. Found in Scott's native Rust engine.
- **Fix:** the stage hands on 1 - alpha and the fragment reads 1 minus that, so a constant alpha of 1 arrives as an
  exactly interpolated 0 (gltf-pro `exactAlphaShader` on MASK pipelines; `solidVertexDepth` in `packages/shared/caster.js`
  for shadows, selection, clustered, staging and taa). gltf-pro casters and pick primitives whose vertex alpha is all 1
  take the `vertexAlpha: false` path. Regression: `packages/gltf-pro/scripts/test-mask-alpha-browser.mjs`
  (`npm run test:gpu:mask-alpha`, WebGPU and WebGL2 compat), `packages/gltf-pro/tests/vertex-inputs.test.js`,
  `packages/shadows/test/cutout-casters.test.js`. The directional shadow map lost nothing before the fix on this GPU
  (orthographic, no perspective division); it is checked anyway.

### Fixed 2026-11-10: bright HDR sources overflowed half floats in Environment (Rust finding R2)

- **What:** `Environment` stores its cube, prefiltered mips and equirect as rgba16float. On the float32-filterable path
  the rgba32float equirect kept texels up to 3.4e38 and the cube store overflowed; on the half path texels clamped to
  65,504, so an unclipped 1e6 sun lost 93 percent of its energy. Measured before the fix (RTX A6000): SH of a CubeFaces
  sun 1.59 off an f64 projection of L0, an equirect sun's SH 1.26 off linear on the rgba32float path.
- **Fix:** the brightest finite RGB texel above 60,000 sets `radianceScale` = peak / 60000; texels are divided by it
  before upload and lighting multiplies it back (paramsBuffer w, irradianceAt, the background, EnvironmentBlend, baked
  KTX2 version 2, materials envMap). Now 3.6e-7 and 1.9e-4. Regression: `packages/environment/tests/bright-browser.js`
  and `packages/environment/tests/half-upload.test.js`.

### Fixed 2026-11-11: EnvironmentBlend output overflowed half floats when unscaled sources' intensities summed above 1

- **What:** the blend output holds `(1 - t) * from.intensity * A + t * to.intensity * B` in rgba16float. Only a source
  with `radianceScale` above 1 counted towards the output's scale, so two unscaled sources with a peak above 32,752 and
  `intensity` 2 wrote Inf. Repro: an equirect with one texel of 50,000, `intensity = 2`, `EnvironmentBlend.create(device,
  a, b, { t: 1 })`.
- **Cause:** the blend did not know the sources' stored peaks.
- **Fix:** every Environment records `storedPeak`, the largest RGB value its textures hold (exact for equirect and
  CubeFaces sources, 65,504 for GPU textures and baked files). The blend sums the weighted peaks in radiance; past
  65,504 it divides its output down to 60,000 and sets its own `radianceScale` and `storedPeak`. The 50,000 texel at
  intensity 2 now stores 60,000 with `radianceScale` 1.667 and lights the same. Regression:
  `packages/environment/tests/blend-browser.js` case 5 (fails with "output scale 1" before the fix).

### Fixed 2026-11-10: GGX importance samples collapsed onto the normal at low roughness

- **What:** `importanceGGX` (`packages/environment/src/shader-common.ts`, used by the prefilter, the BRDF LUT and
  sampled probe bakes) took sinTheta as sqrt(1 - cosTheta^2). In f32, below alpha^2 = 2^-24 (roughness under about
  0.0156) cosTheta rounds to 1 and every sample lands on the normal; just above it the subtraction cancels. The
  default 128 x 128 LUT was 0.00117 off an f64 integration of the same samples at its smoothest grazing cell (0, 0),
  2.4 f16 steps. Found in Scott's native Rust engine, which ported this code.
- **Fix:** cosTheta = sqrt((1 - xi) / d) and sinTheta = alpha sqrt(xi / d) with d = (1 - xi) + alpha^2 xi, from
  tan^2 theta = alpha^2 xi / (1 - xi) (Walter et al. 2007). Worst cell now 4.9e-4, within one f16 step, on WebGPU and
  WebGL2 compat. Regression: `packages/environment/tests/environment-browser.js` section 4c.

### Fixed 2026-11-11: the weather lens long-time parity bound was below the shader's own f32 rounding (list 5 R6 row 24)

- **What:** `packages/weather` `test:browser:parity` lens case (`tests/parity-browser.mjs`, `tests/lens-check.html`)
  on the Beelink (Radeon 680M, Chrome on D3D12): `longTime` worst 1.374e-4 over 2,400 cases, over its bound 1e-4.
  The `math` case passes (7.6e-5). Repeats exactly on every run.
- **Repro:** a CPU model of `lens_field` that rounds every WGSL operation once to f32, with the inputs
  `lensSettings` packs, against `lensField` in f64 on the same 2,400 cases: worst 1.364e-4, at case 1441
  (time 123456.75, x 1.1293, y 0.9679, the mask: 0.37333 in f64, 0.37347 in f32). The bound is 1e-4.
- **Cause:** the test, not the GPU. The field divides cell-local positions (about 1.7, f32 step 1.2e-7) by the drop
  radius (down to 0.01375) and passes them through smoothsteps with slopes up to about 17, so a correctly rounded f32
  evaluation of the shipped shader already misses the f64 field by 1.36e-4. A GPU that fuses or reorders operations
  can land under 1e-4 (the workstation does); one that rounds each operation as written cannot. The long-time packing
  the case guards (c9b0a86ba) works: the raw time * speed product it replaced is off by far more.
- **Open:** needs Scott's ruling. The bound is not loosened here. Options: an f32 reference (the model above) with a
  bound from WGSL's accuracy rules, or a bound derived from the f32 analysis.
- **Fix (coordinator ruling 2026-11-11):** the long-time case compares the GPU with an f32 reference of `lens_field`
  (`packages/weather/tests/lens-f32.js`: every WGSL operation rounded once as written, `fma` once, the inputs
  `lensSettings` packs) at the unchanged 1e-4 bound. On the RTX A6000: 1.8e-6 native, 8.6e-6 on the WebGL2
  compatibility layer. The f64 `lensField` stays the truth for that reference: `tests/lens-f32.test.js` holds it within
  1e-4 of the f64 field on the same 2,400 cases (5.2e-5 measured) and fails it with the raw time * speed product (over
  100 times worse), so a broken packing still fails. The short-time `math` case still compares with f64 at 1e-4. On
  the Radeon 680M (Beelink, `b187ac2d4`, 2026-11-11): long-time 4.05e-5 on WebGPU and on the WebGL2 layer, math 5.9e-5.

### Fixed 2026-11-11: the instanced frame allocated 4,048 B, over its 292 B floor (list 5 R6 row 15, Radeon 680M, then RTX A6000)

- **What:** `npm run test:frame-alloc:browser`, `instanced` (10,000 moving instanced boxes): median 4,048 B a frame
  against its 292 B floor, first on the Beelink (Radeon 680M), then on the RTX A6000 desktop with Edge 157.
- **Cause:** core's `uploadRows` (`packages/core/src/renderer.ts`) read each dirty-row word from the `Uint32Array`. A
  word with every row marked is 4294967295, outside V8's small integers (31 bits with pointer compression), so every
  tier that keeps the value tagged (the interpreter, the baseline, Maglev's loop) made a 12 B heap number of it: 312 full
  words, 3,744 B a frame. At the baseline tier (`--max-opt=1`) the walk allocated 15,024 B a call.
- **Fix (Scott's 2026-11-11 core ruling):** `uploadRows` reads the words 16 bits at a time through a `Uint16Array` view of
  the same buffer, made once per words array (little-endian halves, as every buffer core writes); a half is always a
  small integer. The same runs reach `writeBuffer`. Core 22,125 B to 22,145 B gzip, core + stage 24,726 B to 24,743 B.
  The instanced frame now reads 304 B (three runs, Edge 157, RTX A6000); the 12 B left is not in `uploadRows` (next
  entry).
- **Regression:** `tests/frame-alloc.test.js` ("uploading 10,000 changed rows allocates nothing in the baseline and middle
  tiers", probe `tests/support/tier-alloc-probe.mjs uploadRows`): 15,024 B a call before, 0 after; the existing
  `tests/core-instance-cache.test.js` run merges keep the same writes.

### Open: Edge 157 frames allocate 12 to 20 B over the instanced and shadowed floors (RTX A6000, 2026-11-11)

- **What:** `node scripts/frame-alloc-browser.mjs` at the KB0378 fix, msedge 157.0.4341.42 headless, RTX A6000: instanced
  304 B (floor 292 B, three runs), shadowed 880 B (floor 860 B); basic 328 B, post 1,476 B and dynamic 376 B pass. The
  floors were set on Edge 156.
- **Cause:** not isolated. `--profile` lists one more 12 B heap number a frame in core's `Engine.update` (minified `C`)
  in the instanced scene; it was in the profile before the KB0378 fix too, hidden by the 15-row listing. The floors are
  never raised: the fix is to find the boxed value (a fractional number passed to a call V8 does not inline is the
  usual one) and remove it.
- **Also on the Radeon 680M** (Beelink, Chromium through Playwright, `b187ac2d4`, 2026-11-11): instanced 304 B, shadowed
  880 B, basic 328 B, post 1,476 B, dynamic 376 B, the same figures, so it is not one GPU's (list 5 R6 row 15).

### Open: sciviz tiled export differs from the whole image by one level on the Radeon 680M (list 5 R6 row 18)

- **What:** `npm run test:browser:export-media -w packages/sciviz` (`tests/export-media-browser.mjs`) on the Beelink
  (Radeon 680M, WebGPU on D3D12), 2026-11-10 and again on `b187ac2d4`: "Tile seams differ: max 1, changed 0". The
  RTX A6000 gives 0 on both backends.
- **Repro:** the NOAA wind figure (`examples/sciviz-wind.html`, two line layers), `exportImage` at 320 x 240 with
  `overlays: false`, tiled against `tileSize: 512` (diag `.lane/r6s6/media-diag.mjs` in the lane N worktree): 1,982 of
  307,200 channel values differ, every one by exactly 1, spread over the line interiors (rows 7 to 230, not at tile
  edges). 64 px and 128 px tiles differ at exactly the same values; 160 px tiles match the whole image exactly; two
  whole-image exports match each other.
- **Cause (not proven):** each tile draws with the whole-image projection cropped by `cropProjection`
  (`packages/sciviz/src/media-tiles.ts`); with 64 and 128 px tiles the x scale is 5 or 2.5, with 160 px tiles 2, a
  power of two that f32 keeps exact. A colour interpolated across a line from rounded clip positions then lands on the
  other side of a rounding step on this GPU. WebGPU keeps a viewport inside its target, so tiles cannot reuse the
  whole-image projection through a viewport offset. Not loosened: the check still asks for 0.
- **Next:** confirm by drawing the 64 px tiles with power-of-two crop scales (tiles of width / 2^k), or interpolate the
  line colour in a form that does not depend on the clip-space scale.

### Fixed 2026-11-10: culling readbacks said nothing was drawn on the WebGL2 layer (list 5 R6)

- **What:** on the WebGL2 layer, which runs no level or cluster kernel and culls no loaded model, `MeshletMesh`
  `readTriangles()` and `readShadowTriangles()` returned 0, `LodInstances.readCounts()` returned 0 for every level and
  `CulledModels.readCounts()` an empty map, although every frame matched core. Found by the compat runs of
  `meshlets-check.mjs`, `lod-check.mjs` and `models-plain-check.mjs`, which skipped or failed on every machine.
- **Fix:** the readbacks report what the layer draws: every part kept, whole (the shadow pass: every shown part), every
  shown instance at the first level, and every row of each primitive `CulledModels` would cull (1 for a plain one). The
  checks assert that under `--compat` instead of skipping. Regression tests in `packages/culling/test/meshlets.test.js`,
  `lod.test.js` and `models.test.js`.

### WebKit draws its own MediaRecorder VP8 WebM 10 levels too bright (batch 121, 2026-11-10)

- **What:** `packages/video/test/record-check.mjs` fails in Playwright WebKit 2370 on the Apple M6: a recording of #336699
  (51, 102, 153) reads back through WebKit's `<video>` as (61, 113, 164), outside the check's 4 levels. MP4 from the same page
  reads (50, 101, 151).
- **Repro:** record a plain 2D canvas filled with #336699 for 1.5 s with `recordCanvas(canvas, { format: 'webm' })` in WebKit,
  seek the decoded `<video>` to 0.5 s and read the centre pixel. No engine code is involved.
- **Cause:** WebKit's side. ffmpeg reads the same file as Y 95, Cb 159, Cr 100, the BT.601 limited-range code of #336699, and
  draws (47, 103, 155); the WebM carries no colour range, and WebKit's player draws it as full range. Not fixed: Margo writes
  neither the container nor the decoder. The check is unchanged and stays red in WebKit.
- **Coded as a known browser defect (lane L, 2026-11-10, Scott's list-4 Mac fix):** `record-check.html` now also decodes
  the WebM's first VP8 key frame with WebCodecs `VideoDecoder` and reads the raw planes at the centre, before any colour
  conversion. WebKit 27.2 gives NV12 Y 95, Cb 159, Cr 100 (the BT.601 limited-range code of #336699, as ffmpeg reads it;
  WebKit's frame is labelled `bt709`, limited); Chrome 156 gives I420 Y 97, Cb 156, Cr 104 (BT.709 limited) and draws
  (51, 101, 153). `record-check.mjs` checks every WebM row's code values against the nearer of the two matrices within
  2.5 levels, then accepts a wrong drawn colour only when the browser is WebKit, the row is WebM, the code is BT.601's and
  the colour is (61, 113, 164) within 4, and prints `KNOWN BROWSER DEFECT webkit-vp8-webm-playback-colour`. Any change
  in the encoded values, or another colour, still fails. The earlier "drawn as full range" explanation is withdrawn:
  full-range BT.601 decoding of those values gives about (56, 104, 150), not what WebKit draws; how WebKit arrives at
  (61, 113, 164) is not known. Not done: switching WebKit callers to MP4, since the WebM is correct and the caller asked
  for it (limits.md, video/record). Found on the way: `scripts/browser.js` reported `hardware.browserName` as `chromium`
  for every `MARGO_BROWSER=webkit` or `firefox` run, since those engines launch through the default Chromium path; it now
  names the engine (`tests/browser-startup.test.js`, "a MARGO_BROWSER=webkit run names webkit").
- **Upstream report (draft, nothing filed):** `docs/upstream-reports/KB0401/report.md` with `webm-colour.html`. Not runnable on this PC (Playwright WebKit for Windows has no MediaRecorder); the page passes on Edge 157, the WebKit numbers are the Mac record above and need a Mac run before filing.

### WebKit canvas snapshot: drawImage keeps returning a frame's first read (WebKit sweep, 2026-11-11, WebKit's side)

- **What:** in Playwright WebKit 2370 (Version/27.2) on the Apple M6, once `drawImage(canvas)` has read a WebGPU canvas,
  later reads return that same image until a `getCurrentTexture()` made after a task boundary, even though more work was
  submitted to the same current texture in between. `voxel` `models-browser-check` read 2116 red pixels after
  `renderer.dispose()` and one more render; Playwright Chromium on the same Mac read 0.
- **Repro:** configure a WebGPU canvas, clear it red and submit, `drawImage` it into an `OffscreenCanvas` and read a pixel,
  then (same task) clear it green and submit, read again, `await device.queue.onSubmittedWorkDone()`, read again. WebKit:
  red, red, red; a clear after that await reads as drawn. Chromium: red, green.
- **Spec:** WebGPU (W3C CR), section 21.2 `GPUCanvasContext`, `[[drawingBuffer]]`: "Any time the drawing buffer is read,
  implementations must ensure that all previously submitted work (e.g. queue submissions) have completed writing to it via
  [[currentTexture]]." https://www.w3.org/TR/webgpu/
- **Margo:** no library path reads a canvas twice in one frame (`exporters` `capture` resizes the canvas before each tile
  read, which replaces the drawing buffer). The voxel check now draws its disposed frame after the queue drains, as its
  other steps already did; the assertion (0 red pixels) is unchanged. To report upstream at bugs.webkit.org.
- **Upstream report (draft, nothing filed):** `docs/upstream-reports/KB0425/report.md` with `drawimage.html`. Not runnable on this PC (Playwright WebKit for Windows has no WebGPU); the page gives the expected red, green, blue on Edge 157. Needs a Mac run before filing.

### Fixed: WebKit ephemeral sessions: AssetCache and RangeCache stored nothing (WebKit sweep, 2026-11-11)

- **What was wrong:** WebKit refuses every Blob put into IndexedDB in an ephemeral session (Safari Private Browsing,
  Playwright contexts) with `UnknownError: Error preparing Blob/File data to be stored in object store`, so `AssetCache`
  and `RangeCache` cached nothing there and `cache` `test:browser` waited on a second fetch that never came.
- **Fix:** both caches see the refusal once per instance and store the bytes (`ArrayBuffer`, which WebKit accepts) from
  then on, reading either kind back as a Blob (`packages/cache/src/bytes.ts`). The transaction helpers now reject with the
  failed request's own error instead of a bare AbortError, which is what made the refusal detectable. The check's
  server answers every request for the held file, so a copy that was not stored fails an assertion. Regression:
  `packages/cache/test/blob-refused.test.js` (the fake IndexedDB gained `refuseBlobs`, WebKit's refusal); it fails on the parent.
  In Playwright WebKit the cold, decoded, streamRanges, rangeOf and eviction steps of `test:browser` now pass.

### Fixed 2026-11-11: WebKit: cache `test:browser` staleTouch step did not finish

- **Repro:** `MARGO_BROWSER=webkit npm run test:browser --workspace @margoengine/cache`; every step before `staleTouch`
  passed, then `staleTouch took over 180 s`. Chromium passed.
- **Cause:** run alone with a log line per await and per transaction, the stuck call was the second cache's write of b,
  whose transaction deletes the evicted a before it puts b's Blob. A probe in Playwright WebKit (Windows, 2026-11-11)
  showed the rule: a refused Blob put that is the first request of its transaction aborts it with UnknownError, as the
  cache expected; one that comes after any other request (a delete, a get, a put to the other store) leaves the
  transaction for ever, with no complete, no abort, not even after `abort()`, and every later transaction on its stores
  waits behind it. The warm cache had passed only because its first write put the Blob first.
- **Fix:** AssetCache and RangeCache ask once at open with a transaction of their own that puts a 1-byte Blob first and
  deletes it (`storesBlobs` in `packages/cache/src/bytes.ts`), and store bytes from the first write when it is refused.
  The write's own fallback stays for any other refusal. In WebKit `staleTouch` now passes in 3.0 s.
- **Regression:** `packages/cache/test/stale-touch.test.js` (four "refuses Blobs as WebKit does" cases); the fake
  IndexedDB's `refuseBlobs: 'webkit'` models the stall. Three of the four time out on the parent.

### Fixed 2026-11-11: WebKit: cache `test:browser` evictionReads step over its limit

- **Repro:** `MARGO_BROWSER=webkit npm run test:browser --workspace @margoengine/cache` (Windows, busy dev PC): plain
  `evictionReads` (2,030 fetches and writes) took 158.9 s and the indexed run passed the 180 s call limit; Chromium took
  17.7 s and 8.8 s in the same session.
- **Cause:** not the check's `context.route` (the same with and without it). Measured in Playwright WebKit on Windows,
  every IndexedDB request outstanding at once is answered on its own timer tick of about 15 ms (1 get 15 ms, 10 gets in
  one transaction 152 ms, 40 gets 547 ms; a lone `setTimeout(0)` 15 ms; Chromium 0.1 ms), so time there follows the
  number of requests. The cache made more than it needed: a miss read the bytes record it then found absent, the
  default eviction used a read transaction and then a write transaction, the index opened its last-use cursor when
  nothing had to go, and every miss of a burst was its own transaction that read the totals again (and, by default,
  every record again: 2,000 misses read 2 million records).
- **Fix:** a miss asks only for the record; the default eviction reads and writes in one transaction; the index opens
  no cursor within the budget; misses queued behind a running write share one transaction (in arrival order, the same
  stored result as separate writes), reading the records or the totals once (`AssetCacheEviction.writeAll`). WebKit
  `evictionReads` now 70.1 s plain and 72.6 s indexed. Regression: packages/cache/test/write-requests.test.js
  (requests per miss, and a 60-miss burst against separate writes).
- Found with it and fixed: the check expected `requestIdleCallback` in every window; WebKit has none, so it now
  expects what the page has (the Prefetcher's timer fallback runs there).

### Safari recordCanvas MP4 of 2 frames claims 5,576 s (batch 121, 2026-11-10, open)

- **What:** the `tools/real-proof/safari` page in Safari 27.2 at 07:52 recorded Fox for 3 s with `recordCanvas` MP4 and got 2
  frames (at 0 and 1.33 s) in a file whose duration AVFoundation and ffprobe read as 5,576.2 s. The page's loop drew 1 frame.
- **Not known:** whether the page was hidden then (the Mac locked at 08:06; later runs reported `hidden` and the page now skips
  recording when hidden). Playwright WebKit's MP4 of the same kind is right (1.5 s, 44 frames in AVFoundation).
- **Needed to close:** the Safari recording run in Scott's list in docs/whitepaper/proof-audit.md, with the screen unlocked.

### WebKit `headless` browser check: lossy WebP encode is refused (batch 121, 2026-11-10; check fixed 2026-11-11, WebKit run needs a Mac)

- **What:** `packages/headless/tests/browser-check.mjs` passed its WebM and MP4 rows in Playwright WebKit and then stopped on
  `This runtime cannot encode lossy WebP`: WebKit's canvas has no WebP encoder, and the library says so with its coded error,
  but the check expected every browser to encode WebP. `packages/headless/tests/browser-check.js` now probes the canvas:
  where it has no WebP encoder the check requires the coded `unsupported` error instead of a measurement, and where it
  has one it measures as before (Chromium native and compat pass). Playwright WebKit on Windows has no WebGPU adapter,
  so the unsupported branch is unconfirmed until a Mac run.

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

### Fixed 2026-11-10: batch 132 sciviz audit, seven colour, isosurface and reader defects

- `diverging` compared Lab hues without wrapping, so endpoints 43 degrees apart across +-180 degrees went through
  white; hues now compare and blend the short way round.
- Isosurface normals at the grid's faces used an unscaled one-sided difference (up to 11 degrees off on a planar
  field), in both the CPU Wasm kernel and the WGSL; one-sided differences are now scaled like central ones.
- An HDF5 enumeration took byte order and sign from its member count; they now come from its base type.
- FITS rejected HISTORY and COMMENT cards with '=' in column 9 and complex values, and read a blank value as 0; a zero-
  width binary table row count looped to out-of-memory. Commentary is skipped, complex values keep their text, a blank
  value reads as absent and the row count is bounded by maxBytes.
- Xdmf polyhedron face counts and CoRectMesh Dimensions, and EnSight uniform blocks, looped or allocated without bound;
  they are now checked against the data left and maxBytes before any allocation.
- Regression: packages/sciviz/tests/audit-132.test.js (every case fails on the old code).

### Fixed 2026-11-11: sciviz volume march physics (batch 132 audit, GPU volume defects)

Found by reading the shaders against Max 1995 and the package's own docs; fixed in `volume.ts`, `multivolume.ts`,
`bricks.ts`, `cinematic-shader.ts`, `volume-quality.ts` and `volume-quality-shader.ts`.

- **Absorption followed the box shape.** Steps were measured in unit-box coordinates against 1 / max(dims), so a ray
  along a short axis absorbed as if it crossed the longest one. Every march (the quality wrapper included, which used
  scene units) now steps in data units along the ray against the finest data voxel spacing.
- **Voxel centres were offset by half a voxel.** Box coordinate p now samples texel (p (n - 1) + 0.5) / n, so bounds
  are voxel centres as documented, in every march and in multivolume channels of different resolutions.
- **The lighting view direction used the normal matrix.** It now uses the model matrix; normals keep the inverse
  transpose.
- **`density` meant two things.** It now scales extinction everywhere: alpha = 1 - (1 - a)^(density step / voxel).
- **The quality wrapper failed with a colorScale map.** The rgba32float table is bound unfilterable and read by the
  shared manual lookup, row 0 only.
- **Jittered preintegration spanned the wrong length.** A segment now spans [sample, sample + step], the length its
  opacity is applied over, so segments tile the ray whatever the jitter.
- **Multivolume culled back faces and ignored scene depth.** It now reads the scene depth and, with the eye inside
  the box, culls front faces and draws always.
- Regression: packages/sciviz/tests/volume-physics-browser.mjs (short-axis absorption 252 against 135 and oblique
  shading 135 against 145 on the old code), the preintegrated spike case of
  packages/sciviz/tests/volume-quality-browser.mjs (old code: a ray at 9 of an expected 28.6), and
  packages/sciviz/tests/volume-depth-browser.mjs; all on both backends. The one-brick check of
  packages/sciviz/tests/bricks-browser.js now compares under exact float filtering and bounds each hardware-filtered
  march by the 8-bit weight model (docs/limits.md, "Sciviz volume filtering precision").

### Fixed 2026-11-11: sciviz preintegration range and cyclic table placement (batch 132 audit)

- **Preintegration used the transfer function's range, not the layer's.** `preintegrateTransfer` built its table over
  tf.state.range while the shader reads values normalised to the layer range. It now takes `range` (default the
  function's range), records it on the table, and `VolumeLayer.setClassification` refuses a preintegrated table whose
  recorded range differs from the layer's, naming the fix. Regression: packages/sciviz/tests/transfer.test.js
  (range case) and packages/sciviz/tests/transfer-browser.mjs (refusal on both backends).
- **Cyclic tables were read half an entry off.** `Colormap.table` placed cyclic entries at k / n while the GPU lookup
  reads entry t (n - 1). Every kind now places entry k at k / (n - 1) (a cyclic table's last entry repeats its first,
  so a wrapped read is seamless), and the portable figure format restores tables the same way. Regression:
  packages/sciviz/tests/colormaps.test.js (cyclic lookup case).

### Fixed 2026-11-11 from the batch 132 sciviz audit (2026-11-10): HDF5 reader gaps

- **Fixed 2026-11-11 (KB0535a): dense attributes were not read.** `src/hdf5.ts` read attribute messages (type 12) only;
  an object with more than 8 attributes stores them in a fractal heap (attribute info message, type 21) and
  `attributes()` returned none or some. It now walks the attribute info message's name index (v2 B-tree, type 8
  records) and reads each attribute message from the heap; shared attribute messages still raise the coded error.
  Regression: packages/sciviz/tests/hdf5.test.js (dense attributes case: the test writes a 12-attribute object with
  its own fractal heap and B-tree, after the HDF5 file format specification 3.0, since no h5py was available).
- **Fixed 2026-11-11 (KB0535b): the implicit chunk index walked every chunk.** `src/hdf5.ts` looped over all chunks of
  a dataset with an implicit index whatever the selection, with no abort check, so a large shape with chunk size 1 took
  very long (2^40 x 4 in 1 x 4 chunks never finished). It now lists, per axis, only the chunks holding a selected value
  (strides included) and checks the signal every 4096 chunks. Regression: packages/sciviz/tests/hdf5.test.js (implicit
  index case, a file written by the test).

### Fixed 2026-11-10: blender parseMargoPBR leaked decoded images when the physical shader failed to load

- **What:** `parseMargoPBR` (`@margoengine/blender/pbr-ext`) awaited the physical shader import and the PNG decode with
  `Promise.all`. When the import rejected (a failed chunk download, for example), the decode kept running and its
  ImageBitmaps were never closed.
- **Repro:** make the shader chunk fail to resolve and call `parseMargoPBR` on a .margo file with images; every
  decoded bitmap stays open.
- **Fix:** both promises settle before either error is thrown; a failed import closes every decoded image. The success
  path is unchanged. Regression: packages/blender/tests/pbr-ext-close.test.js (fails on the old code: closed 0 of 1).

### Fixed 2026-11-10: a shadowed frame allocated 1,688 B against its 512 B budget

- **What:** `tests/frame-alloc.test.js` failed on main from local CI run 2026-11-10 13:00 on (bd92fa67b): eight
  moving casters with four cascades added 1,688 B per frame on the CPU (budget 512 B) and 1,680 B at Maglev (budget
  620 B), Node 26.12.0, V8 14.6.
- **Cause:** 3d7dd74c9 (`feat(stage): load full glTF through optional PBR path`) let static PBR meshes tighten the
  cascades, and for that called `meshTriangles` in `Shadows.range()` once per caster and in `worldSphere()` twice per
  caster each frame. For a core mesh `meshTriangles` builds a new `{ kind: 'core', geometry }` object on every call:
  33 objects a frame in the probe scene. Building shadows at 3d7dd74c9 and its parent alone gives 1,840 B against
  520 B per frame (Maglev 1,976 B against 656 B).
- **Fix:** `range()`, `worldSphere()` and the coloured-shadow pass read a core mesh directly (`mesh.geometry` set
  means `meshTriangles` would answer `core`) and call `meshTriangles` only for a mesh without core geometry, as
  `casters()` already did. The static-primitive test that `range()` runs for PBR casters is one function made once
  instead of a closure per caster per frame. Same decisions, same cascades: the frame is back to 520 B (shadows add
  368 B) and 656 B at Maglev (shadows add 360 B), the parent's numbers.
- **Regression:** `tests/frame-alloc.test.js` (failed before, passes after).

### Fixed 2026-11-10: terrain overlays check read its canvas after the browser presented it

- **What:** `packages/terrain/test/overlays.browser.mjs` (native WebGPU, "overlays visible on the actual terrain")
  failed once in the batch 169 gate on a busy machine; an A/B right after passed with red 313/273, green 1169/1105.
- **Cause:** the check drew its frame, awaited a compute probe's `mapAsync`, and only then copied the canvas. When the
  browser ran a rendering update during that await it presented the canvas texture, and the later `drawImage` read
  transparent black (every pixel 0,0,0,0, measured in Chromium 157). A quiet machine usually finished the await first.
  The RVT, overlay bake and probes were right throughout.
- **Fix:** the check reads the canvas in the task that drew the frame, before the probe. `scripts/support/canvas-frame.js`
  (`watchCanvas`, `readCanvas`) marks a canvas frame expired once the task that took its texture ends and
  `readCanvas` throws on an expired canvas, so the old order fails on every run instead of on a busy one.
- **Regression:** `tests/canvas-frame.test.js`; the overlays check now reads through `readCanvas`, which threw on every
  run with the old order.

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

The underwater implementation was kept on `batch-234` and
`batch-234-checkpoint-6e16c0d72`, never accepted or landed; both were deleted on
2026-11-10 as superseded by the continuation below. Repro on that branch was: build water, then run `packages/water/test/underwater-preview.browser.mjs`
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
The independent caustics job landed as `3369f2e4f`. This note accompanies batch 213 job 1.

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
package CPU/GPU, README and quality gates pass. The retired native sciviz/webgl2 driver had no LIC
implementation; compatibility-backed WebGL2 (createFallbackFigure) is the supported fallback.
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
- Fixed reuse naming (2026-11-11): the per-pixel RIS entry, which has no spatial or temporal reuse, was named `/restir`. It is now `/resampled` (the class and factory were already `ResampledVoxelPathTracer` and `resampledEmitters`); README, limits, claims and reproduce follow. `tests/entry-names.test.js` fails on any entry or script named ReSTIR. Spatiotemporal reuse is not added: it correlates samples across pixels and frames, which a progressive converged render does not want, and no web rival ships it. The equal-cost work-count question stays open for the speed phase.
- Fixed resampled README gate: isolated exact-example diagnostic passes the unchanged 20-second deadline on native WebGPU (Dawn). Its trace pipeline takes 15.5 seconds and capture 0.13 seconds, so this diagnostic is not ANGLE D3D11 compilation. The prior failure has no per-phase record; the actual runner selection also passes 1/1 at its unchanged deadline. No readiness wait, capture or deadline was removed.
- Fixed root emitter MIS coverage (2026-11-11): the full-distance medium-boundary regression was only in the optional resampled GPU suite. The root `test:gpu` now runs `mediaboundary` (tests/browser-check.html and browser-check.mjs): voxel emission and an area light through an absorbing slab against independent quadrature at the same 0.02 bound. With the old last-segment distance restored it fails at 0.7557 against 0.6917.

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
  Materials hunt continuation: two complete compat grids and 48 focused resets
  were exact; the third full grid reproduced the 4x reset error 0.000244140625.
  A full-prefix synchronous attachment trace was exact, so its extra readbacks
  may perturb the failing state. Cause remains uniform replay versus multisample
  rendering, unisolated. Next capture and replay the failing sequence without
  blocking reads, retaining every upload and readback payload byte. Evidence:
  whitepaper/materials-compat-hunt.md. PARKED at the five-round cap.
- `materials/test:gpu:render-state`: failure 10 repaired in the optional device.
  The earlier signed polygon-offset clamp repair is retained. Dynamic stencil
  references now use the target's low eight bits before GL's signed clamp;
  both faces, bit 31, UINT32_MAX, replacement and reset have regressions.
  The full expanded native and compat grids each pass 616 checks/288 captures
  at 4x and 1x. No assertion or tolerance changed. Durable receipt:
  whitepaper/results/batch-273-stencil-checkpoint.json. Remaining batch failures
  are still open; this does not establish whole-package parity.

- `materials/test:gpu:wireframe` is repaired: ANGLE D3D11 sometimes retained a
  retired index buffer's storage after binding its replacement on a draw VAO.
  Detaching the old element binding first preserves the uploaded bytes. Raw GL
  replay reproduces the defect without engine imports; CPU replacement/cache
  regression and the expanded 285-check native/compat wireframe grids pass.
  See whitepaper/materials-compat-hunt.md for proof and reproduction.
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

- Fixed 2026-11-11 (`selection/test:browser`, `models.browser.mjs`): the 60 s hang after `occlusion ok` is gone. The unchanged command finishes inside its 60 s body lease, both 600-pixel grids agree 600/600, and silhouettes, outlines and occlusion pass. Cause: mapping progress on the WebGL2 layer, repaired by 48ac029631 (readback and task polling); regressions in `packages/webgl2-compat/test/task-polling.test.js`. A future timeout is not waived.
- Resolved failure 18, shader readback: compatibility compute pipelines did not
  enforce advertised binding limits. Resource counts now reject overflow before
  either compute route runs; asynchronous pipeline errors also avoid assigning
  DOMException's read-only name. Five regressions and the unchanged full readback
  leaf pass on native WebGPU and full compat, including validation and recovery.
- Fixed 2026-11-11 `sky/test:gpu`: the one features-check command ran all eleven feature checks at both sample
  counts and outlived its 98 s bound though every value assertion passed. test:gpu now runs them as four named
  groups of at most three, one browser each, and every case has its own 60 s hard limit inside features-check.mjs
  (unknown names are refused). Regression: packages/sky/test/features-groups.test.js.
- Fixed 2026-11-11 (`splats/test:gpu`): the command exited only at its 62 s body bound after every check had printed success. The complete compatibility command now passes and exits through the host teardown of 919fdc09ef (Playwright browser server in a host process; regressions in `tests/browser-host.test.js` and `tests/browser-teardown.test.js`). No browser or shutdown code and no bound changed in the sweep that closed it.
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
Closed 2026-11-11 (bug sweep L3b, KB1042j): the refusal is the documented contract (oit README,
"Exact (ExactOIT)"), and since 5a6087049c `exact-check.mjs` under MARGO_COMPAT=1 asserts it: the coded
`unsupported` with the message naming the fix (use OIT) at 1x and 4x, core's sorted blend and the weighted
fallback drawing the layers. Passed under MARGO_COMPAT=1 on 6077d08e87. Regression:
packages/oit/test/gpu/exact-check.mjs.


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
### Fixed 2026-11-11: secondary-scene disposal outside the batch 56 environment repair

Cause: post effects (FXAA, PostStack, DOF, Autofocus, Tonemap, creative PostProcessing, Painterly, WideAngle, NodePass)
called `engine.removePlugin(name)` after scene setup had restored the default active scene, so an effect attached to a
secondary scene stayed registered. Fixed in the owning packages by sceneOf-based identity in 257c0aaf6, 542bca326,
daa740e55, 05f35486c, 02fd42e4c, 6eb490883 and 7239d8752; the regressions are the per-package `scene-owner.test.js` files
(for post, `packages/post/test/scene-owner.test.js` and `effect-owners.test.js`). The class is now gated for every package:
f67185ba34 added `check:owners`, which runs each package's owner/lifetime fixture on a real device with device loss and
recovery.

### Fixed 2026-11-11: batch 56 review repair audit

Reported causes: TAA's transient matrix entered the still controller/history key; planar, image and colour draws omitted
per-view state; scene capture and explicit surface/cube disposal selected the active default scene; ground contact
projection had no HDR direction input; studio normalization overflowed for finite directions. The repairs landed in
853b9e74f6 (TAA still key; regression `packages/taa/test/temporal-camera.test.js`), 315eebeb39 (per-view state and the
studio overflow; `packages/environment/tests/review56.test.js`, `review56-browser.mjs` and
`tests/environment-staging-view-state.test.js`) and b04ae2dfe9 (owner-scene capture and disposal; `review56.test.js`);
75dd1304df and 4e5dbdf049 record the batch 56 owner and tier integration gates that passed on them, and the owner
class is gated by `check:owners` since f67185ba34. No core or stage feature was added.

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

### Fixed: test-page 45 context loss during D3D11 trace compilation, and the tracer on ANGLE Direct3D 11

Was: on the WebGL2 layer under ANGLE Direct3D 11 the voxel path tracer's single `trace` program never finished
compiling (`D3DCompile` still running at 3,000 s; its time grows 3.6 to 5.3 times per doubling of inlined code), so
`tracer.ready` never settled, the page showed raster only, C2 tracer rows stalled, and disposing the engine during
that compile hung in `WEBGL_lose_context.loseContext` until the 180 s process-tree limit (bug 45).

Cause: one fragment program held the whole path loop (camera maths, traversal, surface, lights, shadow, glass). Context
loss waits for the driver's pending compiles, and that compile never ended.

Fix (voxel-pathtracer `src/compat-staged.ts`, `src/compat.ts`): the WebGL2 route is a wavefront of staged programs, at
most one traversal each (hit, vertex, surface, shadow and the rest), carrying the full path state between them in
float and integer textures, with output bit-identical to the single-kernel route. Three further D3D11 faults found on
the way are fixed at their cause: fxc X3511 on a generated one-pass loop (`unloop()` turns break and continue into
guards, so no one-pass loop is emitted), the vertex program's draw-time recompile (split at `VERTEX_CUT` into vertex
and surface: offline fxc 62.5 s to 14.4 s plus 25.8 s), and passes of finished paths (the CPU drives the loop in windows and reads a census back with
`mapAsync` between them, then stops recording a part whose paths all finished; no synchronous GPU read).
The preview kernel is not compiled on this route (docs/limits.md). No timeout, scene limit or tracing work changed.

Evidence (RTX A6000 PC, loaded): `npm run test:gpu:d3d11` passes in 117.9 s, 18,432 of 18,432 values identical with
the same seed. `npm run test:gpu:d3d11-dispose` (the bug 45 sequence:
attach, raster frame, dispose the tracer and then the engine one second after submission) passes: tracer disposal 1 ms,
engine disposal returns in 29.0 s, `ready` rejects with `disposed`, the page's other engine still draws. C2 tracer rows
c2-003/010/013/016/025/028/031 pass on native and on the default D3D11 backend at 1x and 4x within the unchanged 150 s
scene limit. Regressions: packages/voxel-pathtracer/tests/browser-check.mjs (`determinism`, `disposecompile`),
tests/compat-staged.test.js, packages/webgl2-compat/test/passes.test.js. Engine disposal during compilation still
waits for the driver's longest pending compile (up to about 30 s here); that bound is recorded in docs/limits.md.
History: docs/testpage-research.md ("Bug 45 hunt") and docs/testpage-bugs.md.

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
are unchanged. Native drawing was an incomplete feature (axes,
points/lines, volumes/slices, isosurfaces and demos pending); it was retired as KB1405 on 2026-11-11, see above.

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
- **Upstream report (draft, nothing filed):** `docs/upstream-reports/KB1703/report.md` with `teardown-latency.mjs` and `load.html`. On a quiet 2026-11-11 PC it does not give the multi-second case (median exit 104 ms with 4 busy browsers, 253 ms with 12, max 470 ms); the report says a Windows trace from a slow run is still needed.

### Open, outside Margo, worked around 2026-11-10: ANGLE Vulkan writes fragment output 7 wrong after dead programs are deleted

- **What:** the voxel path tracer's `analytic` glass furnace (96 x 72, 512 samples, 64 bounces) on the WebGL2 layer
  under ANGLE Vulkan (RTX A6000, NVIDIA driver 617.42, Edge 157) came out dark in 13 of 78 renders: for 5 to 7
  consecutive parts (about 0.5 s) the values its loop programs wrote through fragment output location 7
  (`COLOR_ATTACHMENT7`) were words of other state, so glass paths ended early. Swapping the attachment order moved the
  damage to layer 0, so it follows output 7, not the texture. No GL error, no warning. ANGLE Direct3D 11: 28 of 28 right.
- **Margo's defect (fixed):** webgl2-compat made 95 programs and 95 vertex arrays over four tracers and deleted none, and
  left about 45 textures and 26 framebuffers to the browser, which deletes a WebGL object when it collects the JS
  wrapper, at a moment of its own, possibly in the middle of a replay. Keeping every object reachable from JS gave 0
  wrong in 26 renders; a capture of one render's 694,127 GL calls replayed bit-identical 80 of 80 times. Fix
  (`packages/webgl2-compat/src/device/gl.ts` `GLObjects`, `render.ts` `LinkedProgram`): the device holds every object
  its context makes and deletes it itself, on `destroy()` of its resource, at the end of the first submission after
  the resource was collected, or with `device.destroy()`; a delete asked for during a replay waits for its end; render
  pipelines with the same GLSL and vertex attributes share one program and VAO (up to 64 idle ones kept), so a rebuilt
  tracer creates and deletes no program. Measured: three tracers made 72 programs and left 156 objects live before, 26
  programs and 64 live objects after, and 0 objects live after the engine's disposal (`device.glObjects`). Vulkan repro
  after the fix: 64 of 64 renders right (one image hash; p = 0.83^64, about 7e-6, at the old rate). Regression:
  `packages/webgl2-compat/test/gl-objects.test.js` (created equals deleted after `destroy()`; a pipeline made again
  reuses its program; collected pipelines' programs go at a submission, beyond 64 only; deletes wait for the end of a
  replay; collected bind groups' textures go at a submission).
- **Still open, outside Margo:** deleting programs a page no longer uses must not change what live programs write. The
  repro still needs a self-contained page: a raw WebGL2 page with the tracer's texture and pass pattern renders right,
  and a variant that makes new copies of its loop programs every round fails differently (whole page wrong, never
  recovering), so it is not yet shown to be the same fault. A page that drops more than 64 distinct pipelines still has
  their programs deleted between submissions; no wrong image has been seen from that path. A report for the ANGLE
  tracker is drafted and waits for Scott.

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
  get-up is in this group: it needs prone and supine get-up clips (getting up from the front and from the back) on a humanoid rig, and no free rig in the repository has them; the Quaternius Universal Animation Library Standard 3.0 pack (CC0) was checked on 2026-11-07 and has none (its closest clips, `Sitting_Exit`, `Death01` and `Fixing_Kneeling`, are not get-ups). Fbx and the animator's joint indices are in this group too (the two usdz examples once listed here now run on repository files). 17 start
  `example:`. Fixed 2026-11-11 in their READMEs (the examples now run as written; `check:readme-run` passes them):
  the four that attached one plugin twice (post SMAA, shadows, quality tier presets, sky fog) release the first owner before attaching
  the alternative; `exporters` render-to-file makes the second view it captures, and the Unity bundle example writes a GLB
  from the Margo Mesh Studio generator the profile requires; `input` chords stands in a key press for the player's; the
  `voxel-net` server examples end themselves (close their clients and servers) so they finish inside the example limit.
  The other `example:` rows listed here before (cameras, stage, headless readPixels, react, worker, loaders) already pass.
  Still open: `xr/readme-ar-hit-testing` needs a headset (hardware), and `headless/readme-image-sequences-and-video-37bcc7`
  needs ffmpeg on the machine (`node scripts/fetch-readme-assets.mjs --ffmpeg`, `MARGO_README_FFMPEG`).
- **Needed to close:** a matching sample for each `sample:` entry, each `example:` entry fixed in its README or its package, and
  the list empty.

### Fixed: unfinished Node examples cannot pass at their deadline

Fixed by eef03d501 (2026-11-09). Both killed-at-limit Node programs and unfinished page imports fail; the owned process tree or page closes. Lane C rechecked the three synthetic deadline regressions in tests/run-readme-examples.test.js on 2026-11-10: all pass. No README examples were run or edited.

## Checks

- Fixed 2026-11-11: suite dev servers watched files, and a rebuild reloaded a suite's page. check:owners sky on the WebGL2 layer failed once on a loaded machine with "Execution context was destroyed, most likely because of a navigation", passing on rerun (sweep0, 2026-11-11). `startDevServer` asks Vite for `watch: null`, but Vite's mergeConfig skips null values, so the root `vite.config.mjs`'s `watch: { ignored }` won and every suite's server ran a chokidar watcher over the files it had served. Rewriting a served module (a package's `npm test` rebuilds its dist, often beside the checks in one worktree) made Vite send the page a full reload, and the next `page.evaluate` failed. Measured: a page served by `openBrowser` reloaded within 3 s of its module being rewritten. Fix: the server's own first plugin sets `server.watch` to null in `configResolved`, so Vite starts its no-op watcher. Regression: `tests/dev-server-watch.test.js` (both cases fail on the parent).

- Fixed 2026-11-11: check:readme-run: after an example hits its 20 s limit, closing the owned browser threw `browser host <pid> did not acknowledge the end: null` from scripts/lib/browser.mjs (2026-11-10, lane U). Repro: before the companion fix, `npm run check:readme-run -- --packages=worker` on unchanged main. Cause (traced 2026-11-11): the browser was closed twice, once by the example's deadline handler and once more for the shared browser at the end of the run (349243b3d3). The first bounded close released its host; the second asked the released host to end again, and a released host answers `null`. Fix: `withBoundedClose` closes a browser once, as Playwright's own `close()` does, and a second call shares the first one's outcome (since 242e8a7542 each example also owns its browser and one close). Regression: `tests/browser-teardown.test.js` ("closing a browser twice").

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

- **Status:** worked around 2026-11-11 for paint-only materials (bug sweep L2, KB2028); the Apple defect is open.

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
- **Workaround (landed):** `exportUSDZ` writes a paint-only mesh unbound (no Material, no `MaterialBindingAPI`), and
  `@margoengine/usdz` already read an unbound mesh's `displayColor`. Regression: packages/exporters/tests/usdz.test.js
  ("a paint-only material is left out"). Still open upstream: Quick Look ignores `UsdPrimvarReader_float3` on
  `inputs:diffuseColor`; still owed: a Quick Look thumbnail of the unbound file on a Mac (none on this PC).

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

### Fixed 2026-11-11: npm run verify hung once in its unit test step

- **What:** on 2026-11-06 one `npm run verify` run in a worktree passed every other step and then sat in the unit test step until its 1,500 s limit, where the same tree took 166 s minutes before and the next run passed in 380 s. Nothing named the test, because the step prints only when it ends.
- **Repro:** none yet. Other lanes were running their own checks on the machine at the time.
- **Cause:** not found. The step now names a hang (see Fixed 2026-11-06), so the next one prints `HUNG TEST:` with its file and test.
- **Needed to close:** a run that prints that line, and a fix of the test it names. Every verify run since is a run of this watch.

- **Lane C sweep (2026-11-10):** no demand repro is available. Full verify is reserved for local CI; this entry remains its per-test hang watch, and no lane verify was run.
- **Named (local CI, 2026-11-11 03:00, `16-root-tests.log`):** `HUNG TEST: testsite-cache-isolation.test.js after its last test "a checkout reached through a Windows short path serves its pages" (something keeps the process alive): no event for 361 s`. That test ran its child with `spawnSync` and no limit, so a child that never exited held the runner's event loop. The child starts a suite dev server, and every suite dev server then ran a chokidar file watcher it had asked Vite not to start (below, "suite dev servers watched files"): file system watches are what kept an earlier child of this file alive (the failed-start case).
- **Fix:** suite dev servers start no watcher (`scripts/browser.js`), and the child now has the same 60 s bound as its sibling and prints `process.getActiveResourcesInfo()` if it is still open 20 s after its close, so any recurrence fails in the test, naming what stays open. Regressions: `tests/dev-server-watch.test.js` (no FSWatcher), `tests/vite-cache-isolation.test.js`. One occurrence in 10 local CI runs kept (2026-11-10 01:00 to 2026-11-11 03:00).

### Apple M6 sweep, 2026-11-05 (Chrome 157 and Playwright WebKit; Safari not run)

Sweep record: every package's tests and browser or GPU tests on the Mac mini (M6, macOS 27.2). Repro for each: on a Mac,
`MARGO_BROWSER=chrome` or `MARGO_BROWSER=webkit` with the named script.

- **Fixed (2026-11-11, L4, KB2224a): `sky` `test:gpu`, Playwright WebKit only: full Sky and `sky/base` differ by one half-float step.** Up to 2 pixels a frame in `afterlight`, `meadow`, `preetham` and
  `preetham-clouds-fog`, the same on every run and at 1x and 4x. Cause proved (2026-11-06): Apple's compile under WebKit rounds by the shape of the code. The only trigger is the
  day model branch of the full Sky, `if(frame.settings.x<0.5){color=preetham(w,s);}else{...lookup...}`, of which each frame takes one side. With that branch alone patched out of
  the full module, keeping the side in use, all 12 runs (6 configurations, 1x and 4x) give 0 differing pixels. Moving `lookup` ahead of the branch, which is the same maths, moves
  the differing pixels instead of removing them. The night branch changes nothing. Chrome on the same M6 gives 0 with every one of these texts, so the values are right and only
  the rounding of one compile moves. Ruled out: a stale read, inputs, and an empty branch added to `sky/base` (folded away, same pixels). To close it, Sky would compile only the
  day model in use, and a model switch would recompile the sky, fog, reflection and lighting shaders with `reflectionTexture` kept: Scott's call. No tolerance was raised.
  Fix (2026-11-11, Scott approved): Sky compiles only the day model in use (`compose` in `packages/sky/src/base.ts`); editing
  `options.model` live recompiles the sky, fog, reflection and lighting shaders on the next frame, with `reflectionTexture` and
  the lighting map, buffer and bindings kept, and binds the Bruneton tables only for the Bruneton model (auto layouts drop an
  unread binding). Steady frames compile nothing; the recorded traces keep their command and resource counts. Mac mini M6,
  macOS 27.2, Playwright WebKit, `browser-check.mjs`: origin/main still fails `afterlight 4x frame 1 scene vs narrow` (1 pixel,
  0.0000153); with the fix all 12 runs (6 configurations, 4x and 1x) give 0 differing pixels, so the KB2224b baselines need no
  re-record for this. Regression: `packages/sky/test/sky.test.js` "KB2224a" (fails on the old build: a model branch in every
  shader). A first run in a freshly copied folder once failed `night-citadel 4x frame 0 scene vs control` (44,792 pixels) and
  passed on the rerun; logged as a sweep row (harness, not sky).
- **Fixed (2026-11-10, Mac lane H): `culling` `test:gpu`, Playwright WebKit and Chrome: parts and core meshes differ by 1 level with shadows on.** Chrome 156 on the same M6 shows it too (2026-11-07, `shadows frustum step 2`, 1 pixel). `parts-check.mjs`, `shadows frustum step 2`: 1 pixel reads 145 against 146;
  the close view has 2. Cause proved (2026-11-06): the two engines draw the same surface with two specializations of one shader. A shader patched by Shadows makes core draw single-sided
  meshes with its plain pipeline (`C` false, back faces discarded; the culled pipeline in `renderer.ts` serves only the unpatched shader), while CulledParts keeps its back-culled pipeline
  (`C` true) for them. Apple's compile under WebKit rounds the two differently. With `C` forced false on parts' pipeline every step gives 0; with `C` true and `cullMode` none it stays at
  1 and 2, so the constant decides, not the culling. Without shadows both engines use `C` true, which is why that run gives 0. Ruled out: shadow maps. Parts and mesh casters do round apart
  (12,756 texels by 1 to 24 ulp in WebKit, 139,988 in Chrome), but with both casters rewritten until the maps were bit-identical the frames still differed by the same pixels. Also matrices
  and a shadow edge moving. To close it, either CulledParts follows core's choice, which puts back faces through the rasterizer under shadows, or core culls with patched shaders too, a core
  change: Scott's call. No tolerance was raised.
  Fix (2026-11-10, in culling, the first option without its cost): `CulledInstances` (so `CulledParts` and `MeshletMesh`)
  records core's unpatched shader, format and descriptor in a pass at the lowest order, and its back-culled variant sets
  `C=1` only when the frame is still core's own with no extra bindings, which is exactly when core draws with its own
  `C=1` pipeline. Otherwise the variant keeps `cullMode: 'back'` with core's `C` false: the same fragment code as core's
  plain pipeline, whose discard removes the same back faces. Not the MSAA order effect: the comparison keeps MSAA and
  0 pixels. parts-check now gives 0 on all 32 steps on the M6 (Chromium WebGPU on Metal). Regression: "the back-culled
  variant sets C=1 only when core would draw the frame with its own C=1 pipeline" in packages/culling/test/culling.test.js
  (fails on the old code). Not run here: Playwright WebKit. Open, same cause, outside culling: `packages/scatter/src/index.ts`
  sets `C: 1` on its lit pipeline whenever the shader keeps the switch, patched or not.
  Scatter fixed (2026-11-10, Mac lane E): `Scatter` records core's frame state the same way and sets `C=1` only on its
  back-culled lit pipeline when core would draw the frame with its own `C=1` pipeline; double-sided and patched frames
  keep `C` false. Regression: "the back-culled lit pipeline sets C=1 only when core would draw the frame with its own
  C=1 pipeline" in packages/scatter/test/scatter.test.js (fails on the old code).
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
  Upstream report (draft, nothing filed): `docs/upstream-reports/KB2224c/report.md`; no standalone repro exists yet (a plain clear page holds 60).

### Fixed 2026-11-11: three routes broke WebGPU compatibility-level rules (KB2272); surfels at 4x since fixed

Follow-up (KBnew-skyfog-ldr, L4, 2026-11-11): the three 4x cases KB2272 added to the shared adapter scenes made
`webgl2-compat test:gpu:tiers` fail at "sky fog 4x ldr: the package accepts this tier". Cause: the cases get their
4x scene from PostStack's capture (the only 4x route), and PostStack refuses HDR stages on the LDR tier by design,
so the tier check met the documented refusal it did not list. Sky, VolumetricFog and spray have no fault there.
`tier-packages-browser.mjs` now lists the three 4x scenes as LDR refusals and still checks their message; they
render at half-float. Regression: that check (failed on 16fbe3c86c, passes now). Docs: webgl2-compat README.

- **Was:** with `allowCompatibilityAdapters`, `FogPass` in `@margoengine/sky`, the `VolumetricFog` composite in `@margoengine/environment` and the spray in `@margoengine/water` failed pipeline creation at 4x ("sample_index is not supported in compatibility mode").
- **Fix:** each draws once per sample at the level, with the sample index as a constant and `multisample.mask` writing that sample alone (`perSample` in `packages/shared/msaa.js`, the route `SceneTarget.copyDepth` and eye-dome lighting already took). The full level keeps its single `sample_index` draw, so its work is unchanged. Regression: `packages/webgl2-compat/test/adapter-browser.mjs` cases `sky fog 4x`, `environment volumetric 4x`, `water spray 4x` (each threw on the old source) and the fogged-frame check.
- **Fixed later the same day (bug sweep L3), surfels:** `SurfelPlugin` at 4x refused with `unsupported`, as its sums need a multisampled float target to add into and the level multisamples neither `r32float` nor `rgba16float`. It does multisample `rg16float` (probed on the forced level, Chromium, A6000) and `rgba8unorm`, so at the level the front depth goes out as the four bytes of its float in `rgba8unorm` (exact: no blend touches it, as eye-dome lighting packs it) and the sums into two `rg16float` targets, (r, g) and (b, weight): the same half floats the full level adds in `rgba16float`, so no precision is lost (the `rg11b10ufloat` idea would have cut sums to 6 and 5 mantissa bits). The resolve draws once per sample with a one-sample mask. Same 12 bytes a sample as the full level; the resolve is four draws where the full level takes one, the full level's work is unchanged. Regression: `packages/points/tests/compat-level.test.js` (threw `unsupported` on the old source) and `packages/webgl2-compat/test/adapter-browser.mjs` case `points surfels 4x` with the surfel frame within 4 of 255 of the full level's (red 3, blue 4: PostStack's `rg11b10ufloat` capture under it, as on the sky frame).

### Fixed 2026-11-11: sky and other packages drew HDR as display colour over PostStack's rg11b10ufloat capture

- **Was:** at WebGPU's compatibility level `PostStack` captures 4x in `rg11b10ufloat`. Sky (base, aerial, Hillaire, shafts, volumetric clouds) and 25 more sites in animation, creative, environment, gltf-pro, lod, materials, scatter, splats, terrain, voxel, voxel-pathtracer and water decided linear HDR output by `format === 'rgba16float'` (some also `rgba32float`), so over that capture they encoded for display and the stack tonemapped again: the sky drew up to 19 of 255 brighter than at the full level.
- **Fix:** one predicate, `linearHdr` in `packages/shared/hdr-format.js` (every float format is linear), at every site; creative's planet and grass passes also accept the `rg11b10ufloat` capture instead of refusing it. The sky now differs from the full level by at most 3 of 255 and the fogged frame by 4, all in blue, the capture's 5-bit blue mantissa against rgba16float's 10 bits.
- **Regression:** `tests/hdr-format.test.js` (fails on the old source: 25 sites compare a pass format with `rgba16float` alone); `packages/webgl2-compat/test/adapter-browser.mjs` asserts the sky and fogged frames within 4 of 255 (19 before); `packages/creative/tests/planet.test.js` draws into `rg11b10ufloat`.

### Fixed 2026-11-11: a lone Bloom failed at 4x on WebGPU's compatibility level

- **Was:** `Bloom.attach(engine)` without `PostStack` created a 4x `rgba16float` capture, which the level cannot multisample ("does not support multisampling"); `PostStack` picked `rg11b10ufloat` there, Bloom alone did not.
- **Fix:** both take the capture format from one function, `captureFormat` in `packages/post/src/capture.ts`; Bloom's scene pipelines target the capture's format.
- **Regression:** `packages/webgl2-compat/test/adapter-browser.mjs` case `post bloom alone 4x` (threw on the old source).

### Fixed 2026-11-11: external PBR display passes blend glass in encoded values (KB2281)

- **Was:** `PBRModel.createRenderer(device).draw(context, pass, view)` into a caller-owned, already-open pass on a display-encoded target drew native glass with the tint/add blend in stored values: bright glass over a 128 grey read 197, 221, 239 of 255 against the linear 143, 154, 165. The package cannot end the caller's pass to snapshot the light behind a surface.
- **Fix:** `draw` takes `options.snapshot(pass, target)`: before each glass surface the caller ends its pass, writes the colour into `target` and returns the reopened pass, and `draw` returns the open pass. The glass then composites in linear light as graph-managed scenes do. Without the hook the native blend stays (exact on `rgba16float`), as documented in the gltf-pro README. Regression: `packages/gltf-pro/tests/external-glass.test.js`, `packages/materials/test/native-glass-browser.mjs` (`externalGlass`, 143, 155, 165 with the hook).
- **Fixed 2026-11-11 in `@margoengine/xr` too (KB2281-xr):** the eye passes drew through `createRenderer` without a hook, so glass on a display-encoded layer texture kept the tint/add blend. When a drawn model has a native glass material (the rule gltf-pro uses, now shared as `nativeGlassMaterial` in `packages/shared/pbr-transmission.js`) and the layer format is not `rgba16float`, the eye pass stores its samples and lends the hook: it ends the pass, resolves the samples into the renderer's snapshot with a resolve-only pass (the layer texture need not allow COPY_SRC) and reopens the eye pass with `load` and the eye's viewport. Scenes without glass keep `storeOp: 'discard'` and one pass per eye. Regression: `packages/xr/tests/xr.test.js` ("XR eye passes lend gltf-pro a glass snapshot hook").

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
- **Held for the speed phase (2026-11-11, bug sweep lane L4):** the slow sends assertion is a timing budget, and
  `scripts/speed-phase.json` defers every timing assertion from the correctness gates until Scott ends the build
  phase (row `biomes-slow-sends` in `docs/work-lists/speed-phase.md`). The measured cause above is the operating
  system taking the page thread's core, not Margo code, so no code change is a fix now. The open choice (time the
  view's frame by the page thread's CPU time from a trace, or keep the wall clock) is made on the quiet machine at the
  start of the speed phase, before the budget is run there; the budget itself is not changed.

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
- **Upstream report (draft, nothing filed):** `docs/upstream-reports/KB2426/report.md` with `collect-evidence.ps1`. There is no on-demand trigger; on 2026-11-11 the System log still holds ten event 153 entries (3 on 11-11 before 00:25, 7 on 11-09), none during the repro runs of that morning.

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


## Sciviz comparison gaps

Found by the batch 182 feature comparison ([sciviz-vs-rivals](whitepaper/sciviz-vs-rivals.md)). Each is a missing
feature that a web rival or desktop tool documents, with no export, README section or test in `@margoengine/sciviz`.
Repro: search `packages/sciviz/src` and `packages/sciviz/tests` for the name.

- **Fixed 2026-11-11 (KB2594a): rival accuracy rows were unmeasured.** `node scripts/sciviz-compare.mjs --accuracy` now runs the isosurface, streamline and isoline references through VTK.js 38.0.5 public filters (black box, in engine-bench) next to Margo; the results are in [sciviz-vs-rivals](whitepaper/sciviz-vs-rivals.md#accuracy-against-closed-form-answers). Beer-Lambert has no public VTK.js extraction API, and the other five rivals expose no isosurface, streamline or contour output, so those rows are recorded as not measurable. Regression: tests/sciviz-compare.test.js (accuracy references case).
- **Closed 2026-11-11 (KB2594b) as a measured accepted difference: Cosmograph link appearance differs** at the shared
  colour and width (graph smoke mean RGB difference 23). Measured: the brightest interior link pixel is the asked
  colour in Margo and 0.42 of it over the background in Cosmograph 2.5.1, with linkOpacity 1 and
  linkVisibilityMinTransparency 1 (its documented opacity options at full), so the cause is inside the rival. Recorded in
  [sciviz-vs-rivals](whitepaper/sciviz-vs-rivals.md) and docs/limits.md. Regression: tests/sciviz-compare.test.js
  (graph link peak case); the comparison report carries `linkPeak`.

## Performance losses still open

Measured but not fixed. Their history, sources and rerun commands are in
[whitepaper/perf-history.md](whitepaper/perf-history.md#open-losses).

- **Navmesh build of one gapped floor is slower than recast-navigation 0.44.0** (`@margoengine/navmesh`, perf history
  entry 94): 3.190 ms against 1.130 ms, paired turns, per-round minimum, busy machine, diagnostic. Repro:
  `node packages/navmesh/scripts/rival-bench.mjs` after the navmesh build. The rival is installed outside the
  repository. Cause not yet found. Publishing the number does not close it.
- **Fixed (KB2604b, 2026-11-11): navmesh path on that floor was longer than Detour's** (`@margoengine/navmesh`, perf
  history entry 94): Margo 24.212 against recast-navigation 0.44.0 at 23.778. Two causes. Erosion measured the agent
  radius from the far side of a dropped ledge cell, so the walkable edge sat a radius plus one cell from a drop; it now
  measures from the drop (an agent of radius r stands anywhere r from the edge), and the gapped path is 23.823 (corner
  at (1.25, 8.25); a disc agent's bound is about 23.69). That moved the floor edge half a block on voxel meshes and
  exposed the corridor search: it charged each polygon from the middle of the portal it entered by and kept one way
  into each polygon, so straight walks over an open voxel floor bent at tile lines (192 of 363 rows, 1 of 363 before
  the erosion change). The search now runs over portals, crosses each where the walk to the goal through it is
  shortest, and breaks ties by position; tiles split a shared outer edge at the same point on both sides. Tests:
  `packages/navmesh/test/path-length.test.js` (gapped path under 23.85), `packages/navmesh/test/voxel.test.js`
  (straight walks, shared edge splits), `packages/navmesh/test/build.test.js` (radius 2 rows re-recorded with the
  clearance proof). The remaining 0.045 against Detour is an accepted difference in `docs/limits.md` (navmesh routes).
- **Volume-64 frame is slower than VTK.js 38.0.5** (`@margoengine/sciviz`, perf history entry 102): 1.500 ms against
  1.300 ms, one 256 x 256 frame plus the pixel read, paired turns, per-round minimum, busy machine, diagnostic. The
  rounds overlap (Margo 1.5 to 2.0 ms, VTK.js 1.3 to 2.2). Mean absolute channel difference of the last pair is 1.801.
  Repro: `node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/sciviz/scripts/rival-bench.mjs`
  after the sciviz build and only in the active quiet speed phase. The rival stays outside the repository.
  Batch 182 diagnoses unequal anisotropic stepping/lighting and extra Margo depth/capture work; its separate
  isotropic controls record full workloads. Two per-frame matrix allocations are removed with exact uniform-byte
  regression coverage. The elapsed-time loss remains open; [controls and reproduction](sciviz-rivals.md).
- **Fixed (KB2604d, 2026-11-11): a degree-3 cloud of 1,692,538 splats did not attach on the WebGL2 layer**
  (`@margoengine/splats` on `@margoengine/webgl2-compat`, perf history entry 103): the published truck at iteration
  7,000, 325 MB of SH (16 coefficients per channel as float32, 192 bytes a splat). Natively it attaches since core asks
  the adapter for its binding size (d9be88943f). The 3,000,000-splat case without SH was fixed earlier the same day
  (the group's data texture grows wider than 2,048 texels). The layer was the wrong side: it advertised WebGPU's default
  `maxStorageBufferBindingSize` and `maxBufferSize` (128 and 256 MiB), because the compute tier wrote a buffer through
  one R32UI word texture of 4,096 x 8,192 words (128 MiB). The compute tier now draws a larger buffer into as many word
  textures as it needs, each store landing in the one that holds its word, and both limits are what one data texture
  of maxTextureDimension2D squared RGBA32UI texels holds (1 GiB at 8,192); a device gets them through `requiredLimits`, as core asks, and otherwise keeps WebGPU's defaults (before, a layer device took every adapter limit, unlike WebGPU, which the vfx compat scale check caught once the adapter offered more). Splats needed no change. Regression:
  `packages/webgl2-compat/test/device.test.js` ("limits come from the context", "a device has the WebGPU default storage
  binding and buffer sizes"), the `largeWords` case of
  `packages/webgl2-compat/test/compute-browser.mjs` (a 160 MiB scatter target, stores on both sides of 128 MiB), and
  `packages/splats/test/gpu/scale-check.mjs`, which now draws the truck natively and with `MARGO_COMPAT=1` (61.0% of the
  frame on both). Found while fixing it: the layer's `createBuffer` does not check `maxBufferSize` (KBnew-compat-maxbuffer).
- **Truck 7k prefix frame is slower than GaussianSplats3D 0.4.7** (`@margoengine/splats`, perf history entry 103):
  10.765 ms against 4.500 ms, one still frame of the 699,050 prefix at 979 x 546, paired turns, per-round minimum,
  busy machine, diagnostic. The rounds do not overlap (Margo 10.765 to 14.535 ms, GaussianSplats3D 4.500 to 7.470).
  The rival's shared-memory GPU sort drew no calls, so the number is its CPU sort. Repro:
  `node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/splats/scripts/rival-bench.mjs`.
  Cause not yet found. Publishing the number does not close it.
- **Fixed (KB2604f, 2026-11-11): Truck 7k did not match the published photograph** (`@margoengine/splats`, perf
  history entries 103 and 115): it scored 12.226 dB. Cause: the projection linearised the EWA Jacobian at each
  splat's true view direction; a splat beside the camera (x / depth far past the view) got an ellipse thousands of
  pixels long that covered the frame, so the camera-to-world pose (the right one) drew a grey blur and lost to the
  wrong world-to-camera pose. The prefix was not the cause (full cloud 12.262 dB before the fix). Fix: the
  linearisation point is clamped to 1.3 times the half-view tangent, the convention the captures were trained with
  (shader.ts `projectSplat`, shared by picking). Full 1,692,538-splat cloud, camera-to-world: PSNR 20.882 dB
  (MAE 13.037); the 699,050 prefix 12.814 dB. Regression: `packages/splats/test/gpu/check.mjs` case "beside" (a
  splat at x / depth 30 lit 16,384 of 16,384 pixels, now 0). Measure: `node scripts/gpu-lock.mjs run
  --owner=<you> --gpu=splats-truck-photo -- node packages/splats/scripts/truck-photo.mjs`. Sources: Kerbl, Kopanas, Leimkuehler and Drettakis 2023, "3D Gaussian Splatting for Real-Time Radiance Field Rendering", ACM TOG 42(4), https://doi.org/10.1145/3592433; Zwicker, Pfister, van Baar and Gross 2001, "EWA Volume Splatting", IEEE Visualization, https://doi.org/10.1109/VISUAL.2001.964490; Ye and Kanazawa 2023, "Mathematical Supplement for the gsplat Library", https://arxiv.org/abs/2312.02121.
- **10 million points are slower than potree-core 2.0.17** (`@margoengine/points`, perf history entry 105):
  9.000 ms against 5.400 ms, one settled frame of a single 10,000,000 point leaf, paired turns, per-round minimum,
  busy machine, diagnostic. The rounds do not overlap (Margo 9.000 to 12.400 ms, potree-core 5.400 to 7.600).
  Both sides draw every point. Margo waits with `onSubmittedWorkDone`. The rival waits with a one-pixel
  `readPixels`, because `fenceSync` returned `WAIT_FAILED`. Repro:
  `node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/points/scripts/rival-bench.mjs`.
  Cause not yet found. Publishing the number does not close it.
- **Fixed (KB2604h, 2026-11-11): Cornell box irradiance did not match a Cycles bake** (`@margoengine/lightmap`,
  perf history entries 108 and 116): MAE 0.069543 (0.048730 after batch 187). Cause: the Cycles reference baked
  `diffuse_bounces` 2 against Margo's 1 indirect bounce (a +1 left from when faces were baked alone and the ceiling
  came out black at 1). With every face present Cycles at 1 lights the ceiling and matches Margo at 1. Fix:
  `packages/lightmap/scripts/cornell-cycles.py` bakes Margo's count, the bench refuses a reference with another
  count and uses path bounces (32 paths). Result: MAE 0.024863 (relative 0.087125); 8 seeds 0.012063, under the
  8-bit step 0.016813, so the rest is ray noise. Regression: `packages/lightmap/tests/cornell-cycles-lifecycle.py`
  (run by `cornell-box.test.js`), which failed on the old script (`diffuse_bounces` 2).
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
- **Upstream reports (drafts, nothing filed):** `docs/upstream-reports/KB2481/report.md` (this entry) and `docs/upstream-reports/KB3508/report.md` (the NVIDIA repro page `msaa-blend-repeat.html`, which has no Margo code). On 2026-11-11 the page still reproduces on the RTX A6000 (WebGPU: 299 of 299 frames differ, 36 distinct images; with `mask: 7` none). The Intel Arc half has no hand-written repro and could not be run here.

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
  Batch 166 job 2 counted the vertex stage against `CulledInstances` and cut the rest: 144 to 104 bytes a vertex
  invocation (no colour fetch for all-white vertices, no unread instance UV row, position and normal as three floats),
  against 120 for `CulledInstances`; identical pixels (perf-history entry 114). Timing pending the quiet rerun.
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
  which decides whether 0.305 ms compares like with like; the instance attribute count (now 5, 80 bytes fetched, against
  the culled pipeline's six attributes over the same 96-byte record); and `DynamicInstances` on a moving frame.
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
- **Counted (batch 166, 2026-11-10), per frame at 250,000 moving boxes:** n calls of `setMatrixAt` (16 finite tests, the
  affine test, a determinant, 12 copies) or n row copies and one `update()`; 0 allocations; one `writeBuffer` run of
  12,000,000 bytes (48 a row, where three uploads 64); a 176-byte frame and a 64-byte part uniform; the attribute rows
  untouched. Timing pending the quiet rerun.

### DynamicInstances: about 15-35% more GPU time than InstancedMesh at 100,000 and 250,000 moving boxes

- **What:** `boxes-100000` moving, every box in view: GPU 1.41 ms against three.js WebGPU `InstancedMesh` 1.23 ms; at
  250,000, 2.73 against 2.00 ms (2026-11-05, diagnostic; perf-history entry 54).
- **Fixed part:** `world` is now built only for shadows and picking (2.76 to 2.73 ms at 250,000, 1.47 to 1.41 ms at 100,000).
- **Ruled out, by measurement at 250,000:** the compute passes cost little (skipping their dispatches: still 2.51 ms
  moving, 1.38 ms static, against 2.73 and 1.50 with them), so the cull is not the gap. Moving the upload's barrier ahead of the
  timed passes changed nothing (2.70 ms).
- **Counted (batch 166, 2026-11-10):** a moving frame with the compute skipped submits the same passes, bytes and
  draws as a still frame plus one 12,000,000-byte staging copy outside the timed passes, so the 1.1 ms seen inside the
  passes is not work: the frame is CPU bound (about 15 ms CPU, 2.7 ms GPU), the GPU idles about 80% and its clocks
  drop, and the copy can overlap the passes. three at 250,000 is CPU bound too (15.7 ms). Inside the design the kernels
  read each row twice with 36 scalar loads and round-tripped 4 bytes a row through a scan: fixed by `perf(culling)` one-dispatch dynamic cull (batch 166 job 1)
  (one dispatch, three vec4 loads a row; 232 to 160 bytes of GPU memory traffic a kept row; perf-history entry 113).
- **Left:** the 96-byte record with six attributes is core's frozen instance layout, an accepted structural difference
  (`docs/limits.md`, "DynamicInstances record size"). **Next:** the quiet rerun reads the `dynamic-upload` (GPU bound,
  no CPU maths) and `dynamic-cpu` (CPU maths, no upload) bench modes beside the moving and still cases, which separates
  clocks from the copy; this entry is rewritten from that run.

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
- **Batch 161 job 1:** the per-frame validation pass (a `Map` and a primitives loop per Animation per frame) is gone:
  primitives are grouped by node once and re-checked without allocating (`packages/animation/tests/frame-path.test.js`).
  Timing pending the quiet rerun.
- **Batch 161 jobs 2 and 3:** bone palettes are made once per skinned node, kept in one array per Animation, swapped
  with their uploaded copy instead of copied, and written in one call when contiguous. Morph weights still go up per
  primitive (2 writes per MorphStressTest copy a frame).
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
- **Batch 161 job 4:** a copy no longer passes 225 arrays to the node setters and the constructor no longer filters
  the primitives per node (`packages/animation/tests/clone-work.test.js`). The GPU state a copy builds up front is
  published as an accepted difference (`docs/limits.md`, "Work per `cloneModel` copy"). Timing pending the quiet rerun.

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
- **Batch 164 (2026-11-10):** the velocity pass without TAA is `velocityOnly`; `p-motion-blur-velocity` is the like-for-like row. The separate velocity geometry pass stays while core's scene pass is frozen (limits.md).
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
| `npm run dev:examples` refused every page (403) from a checkout reached through an 8.3 short path | Vite's file-serving allow list held the working directory as given and compared it with each file's real path | `dev:examples` runs `scripts/dev-examples.mjs`, which starts Vite in `realpathSync.native(process.cwd())`; the root `vite.config.mjs` (added 2026-11-10) only sets `optimizeDeps.entries`, so every other root `vite` command is unchanged | `tests/dev-examples.test.js` (short-path cwd serves 200, a file outside the repository stays 403) |
| `vite` at the repository root (`npm run modern:dev:extensions`, `npm run dev:examples`) printed "Failed to run dependency scan. Skipping dependency pre-bundling" | with no root config the scan read every HTML file, the rival comparison pages (`scripts/rival-*.html`, `scripts/sciviz-compare/page.html`, `packages/*/scripts/rival-page.html`) and local `test-results` copies; the pages import engines that are deliberately not installed and are served by their own scripts | root `vite.config.mjs` lists the entries and leaves those out; `packages/creative` `dev` also opens its example page (it had none at `/`); `npm run check:dev-servers` starts every dev server in `verify` | `tests/dev-servers.test.js` |
| `npm run build` in a new `create-margo` game app printed "(!) Some chunks are larger than 500 kB after minification" | Rapier embedded its WebAssembly in its JavaScript (`@dimforge/rapier3d-compat`, 4.3 MB), a lazy chunk of its own; Vite warns about any chunk over 500 kB. The game template first raised `chunkSizeWarningLimit` to 4500 to hide it | 2026-11-10: `@margoengine/physics` bundles `@dimforge/rapier3d` 0.21.0 and ships its Wasm as `dist/rapier3d.wasm`, loaded with `new URL(..., import.meta.url)` and compiled while it downloads; the template's limit fell from 4,500 to 700 kB, just above the game's own start-up chunk (675,315 B minified: stage, materials with the glTF model code they import, animation, shadows, sky, physics), which the old limit had hidden too. `npm run check:templates` fails on any warning line, on a JavaScript file over 500 kB (700 kB for the game) in a Vite template build, and on a game build with no `.wasm` asset | `tests/create-margo.test.js` (game limit at most 700 kB, no Rapier install in the game template), `packages/physics/tests/wasm-load.test.js` (no JavaScript file over 500 kB), `scripts/template-install-check.mjs` |
| An app using `@margoengine/physics2d` had to install `@dimforge/rapier2d-compat` itself, and its build carried Rapier 2D as one lazy JavaScript chunk over Vite's 500 kB warning | the compat build embeds its WebAssembly in its JavaScript as base64 (3,409,863 bytes unbundled), so the Wasm could not be emitted as an asset or compiled while it downloads | 2026-11-11: `@margoengine/physics2d` bundles `@dimforge/rapier2d` 0.21.0 the way `@margoengine/physics` bundles the 3D build: its JavaScript in the lazy `rapier-solver` chunk, its Wasm as `dist/rapier2d.wasm` loaded with `new URL(..., import.meta.url)`; `Physics2D.load({wasm})` takes another copy and refuses foreign Wasm. The load and check code is shared by both packages (`packages/shared/rapier-wasm.js`, `packages/shared/shared-load.js`) | `packages/physics2d/tests/wasm-load.test.js` (no JavaScript file over 500 kB, file URL, server, abort), `wasm-response.test.js`, `wasm-module.test.js` |
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

Lane G's current-main parser/graph control passes all 26 materialx.test.js
cases. This does not supply a paired MaterialXView image: no installed viewer
was found in the external comparison tools. The rendering-validation gap and
required source/licence/reference artifacts remain open; no renderer parity
is inferred from graph compilation.

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

  Lane G current-main controls (2026-11-10): the complete five-pane weighted
  picture still has MAE 1.5675188078703703 and max 15 on both backends. The
  graded single-layer probe reads red 94 sorted and 93 weighted, against 137
  for linear-light composition; opaque control is 188. Same-frame GPU buffer
  copies retain the canvas before presentation expiry. Neither cause is closed.


- **Accepted 2026-11-11 (KB3148c): default Preetham angular radiance differs from Mitsuba sunsky** (`@margoengine/sky`,
  perf history 110): MAE 1.439228 over 297 directions against Mitsuba 3.9.1 sunsky (Hosek-Wilkie). The paper Preetham
  model alone measures MAE 1.436382; Margo's tuning moves the grid by MAE 0.012108
  (`packages/sky/test/sunsky-reference.test.js`). A model difference, recorded as an accepted difference in
  docs/limits.md ("Batch 168 sky radiance reference"); not a defect.

### Audio Doppler (batch 110)

No known open defect in tested buffer-motion paths. Node tests cover radial signs, transverse/co-motion, coincident positions, frozen/backward clocks, resets, bounded extreme velocities, rate smoothing, recreated sources, invalid options, duplicate attachment and teardown. The first local build used an error code outside MargoErrorCode; corrected to the established linked RangeError convention. The first test fixture omitted required listener forward/up arguments; corrected the fixture. Source-kind and acoustic approximation limits are in limits.md.

The first Doppler verify found the limits index still at LIM-602 and the generated llms corpus stale after the final size update. Updated the exact index line and regenerated the corpus; existing claims-file and llms regression checks cover both. No tests or budgets were changed.


### Batch 168 closing reference losses

- **Closed, accepted difference (KB3193, 2026-11-11): default contact shadow misses broad ray-traced ground occlusion** (`@margoengine/staging`, perf history 111):
  a radius-0.5 sphere touches ground under uniform hemispherical lighting. Across 15,472 visible ground pixels,
  normalized darkness MAE 0.048174, RMSE 0.074416, max 0.288788 against 4096 cosine rays per pixel.
  Reference quadrature differs from projected solid angle by at most 0.001734. Mean darkness is 0.000177
  versus 0.048351. Cause: `packages/staging/src/index.ts` keeps nearest-surface height and applies fixed
  Gaussian blur and opacity, which cannot integrate the directional hemispherical visibility field.
  Repro under the shared GPU lock: `node packages/staging/scripts/rival-bench.mjs`. Loss stays open.

  Lane G's current-main correctness-only contact comparison retains all
  15,472 pixels and 4096 rays: MAE 0.04817386029045438, mean darkness
  0.00017742360646430213 against 0.048351283896918625. No shadow option changed.

  Closed 2026-11-11 (L4): working as designed, not a defect. The pictured mean darkness matches the footprint
  model (darkness 0.6 x (1 - underside height), Gaussian sigma 0.03: the brightest exposed pixel, 0.047, is the blur
  tail one sigma outside a 0.3 edge). AmbientShadows with `ambient: 1` (all-sky visibility, 1024 cosine directions, opacity 1) on the same scene, pixels and reference measures MAE 0.001561, RMSE 0.001948, max 0.007994, mean darkness 0.048200 against 0.048351, on WebGPU and the WebGL2 compatibility layer, so Margo draws the broad occlusion through that entry. Pinned
  by `packages/staging/test/sky-occlusion-browser.mjs` (MAE below one 8-bit step). Recorded in docs/limits.md.


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
1.837506612141927. Since the height-correlated Smith G (KB5875a, 2026-11-11) the measured and recorded MAE is
1.7865498860677083 (WebGPU) and 1.7865447998046875 (WebGL2 compatibility); see docs/limits.md, "Batch 160 budgets
re-recorded". Full evidence: docs/whitepaper/results/batch-160-metallic-roughness.json.
Repro: scripts/reference-rendering/run.mjs under the shared GPU lock (see whitepaper reproduction).

Known Margo causes to isolate: gltf-pro/src/shader.ts clamps perceptual roughness to 0.045 even for the
sample's authored zero-roughness column, and its single-scatter Smith G has no multiple-scattering compensation
(it was separable until 2026-11-11 and is height-correlated since, KB5875a). Appendix B.3.6 describes why
these model choices can lose energy. The Sample Viewer is treated strictly as a black box: its exact model
is not inferred from source. These are known limitations of Margo's formulation, not a quantified attribution
of this entire picture error. The residual including the thin model text and silhouettes is not yet isolated;
sampling/display resolution and BRDF effects need separate controls. No shader change is justified by a
guess about that residual, and recording a budget does not close the loss. No physical/path-traced parity
is established by this first job; the environment/Cornell jobs remain outstanding.

Lane G reran the complete frozen scene on both backends without capturing a
new reference or changing a budget. Both integer gates pass with the same
MAEs above; the measured picture loss remains open.

### Batch 160 clearcoat picture loss (open)

Repro: `node scripts/reference-rendering/run.mjs --case=clearcoat` through the GPU lock, after
fetching its source and capturing the reference as documented in whitepaper/reproduce.md.
Entire Khronos ClearCoatTest, 27 primitives, no IBL, identical camera and sun, 512 x 512.
All-pixel RGB MAE 1.6809107462565105 (WebGPU), 1.6809145609537761 (compatibility WebGL2),
maximum byte error 180. Frozen result: whitepaper/results/batch-160-clearcoat.json. Re-recorded 2026-11-11 at
1.6820462544759114 on both backends (absolute 1,322,815) after da12bd07e1, 65098f33fe and KB5875a (Scott's ruling).
Cause of the complete residual is not yet isolated. Known formulation differences to investigate:
Margo clamps clearcoat roughness to .045 and uses single-scatter Smith (height-correlated since 2026-11-11); its coat direct
Fresnel uses VdotH, while the extension's nonnormative layering example uses NdotV.
None of these has been proved to explain the full image error. Base-material, texture-filtering,
normal-map and silhouette errors are included, not removed by masking. No reference-specific
shader adjustment or core change is justified by this measurement alone.

Lane G current-main repro: native absolute error 1321923 exceeds 1321922 and
square error 54029515 exceeds 54029506. Against the archived native picture,
one blue component at (304,301) changed from 134 to 133. The compatibility
image has 62142 foreground pixels against the unchanged minimum 62180.
A 24-frame complete single-instance native control repeats exactly, which
does not explain the cross-capture difference. Causes remain unisolated;
no budget, assertion or renderer was changed to pass this comparison.
Resolved 2026-11-11: the +1 is da12bd07e1 (bisected); the budget is re-recorded with the entries below.

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

Lane G current-main repro: native passes the frozen integer budgets;
compatibility square error 33928555 exceeds 33927045. All other picture
content remains included. The slight overrun is retained, not exempted.

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

### Fixed 2026-11-10: GPU lock read a failed heartbeat stat as a beat at time 0

Waiters logged "removing stale shared entry of sec-sinks (no heartbeat for 1794337171 s)" and the same for lane-B-bvh-compat (1794330223 s): the whole epoch in seconds. Cause: `deadReason` in `scripts/gpu-lock.mjs` read the holder's entry, then took the heartbeat time from the file's mtime, and a failed `statSync` left that time at 0. Holders release, and heartbeat processes remove entries, without the scheduler mutex, so a release between the waiter's read and its stat produced the message. Evidence: lane-B's command log was last written at 17:03:42 UTC and the eviction was logged at 17:03:43; a two-process loop on this PC (one writing and removing an entry, one reading then stating it) saw the stat fail with ENOENT after a good read 980 times in 6 s. Those two entries were already gone, so they did not add a holder, but any other stat failure (EPERM or EBUSY while Windows holds the file) took the same path and removed a live, beating holder, which lets more holders than the slot limit onto the GPU. Fix: ENOENT now means released (not logged, nothing removed); any other stat failure or an unreadable mtime leaves the pid check alone to decide. Regression: `tests/gpu-lock-stale.test.js` (no beat yet, current beat, stopped beat, dead pid, beats:false, released mid-read, failing stat on a live and on a dead holder). Found in the same gate: `tests/gpu-queue.test.js` filled 3 shared slots by hand and expected a new ticket to wait, but the default became 5 slots in b7d02c892, so the ticket ran at once; it now fills `slots()` holders.

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

### Fixed 2026-11-11: README inputs exposed separate causes (2026-11-09)

Four examples had causes beyond a missing file, found by `node scripts/fetch-readme-assets.mjs` then
`npm run check:readme-run -- --packages=loaders,fbx`. All four READMEs now run as written:
the FBX introduction plays clip 0 (the sample fan has the clip `Bend`, not `Walking`); the scale-inheritance and
skinning-modes examples pass `animationLayers` because their Maya samples animate with cubic curves, which the base
reader refuses; the NURBS example converts the curve-only sample with `convertFBX` and reads the curves from the GLB's
nodes, since `loadFBX` needs a mesh. The loaders NURBS and textured-OBJ examples already pass (the OBJ example reads the
MTL with `parseMTL`). No clip was renamed and no unrelated bytes were substituted.

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

### Fixed: nearly closed conservative Hillaire atmospheres (KB3454, 2026-11-11)

The raster Hillaire model gave nonfinite radiance for atmospheres whose geometric-series transfer rounds to one.
Repro: HillaireSky with atmosphere `{rayleigh:[1,1,1],mie:1,mieAbsorption:0,rayleighHeight:100000,
mieHeight:100000,groundAlbedo:[1,1,1],ozone:[0,0,0]}` on Earth radii: 2688 of the 3072 RGB components of the
32x32 multiple scattering table were nonfinite on native and compatibility devices.
Cause: `packages/sky/src/atmosphere-luts.ts` computed `L2 / (1 - fms)` with `fms` a sum that rounds to one, and
both L2 and the throughput underflow f32 deep in such a medium (a vertical optical depth near 200).
Fix: 1 - f_ms of each direction is now summed as what leaves it (final throughput plus what the medium absorbs,
an exact telescoping of the step integrals), and both that sum and L2 are kept as v x exp(-e), e an optical depth,
added log-sum-exp style so every rescale factor is at most one (Blanchard, Higham and Higham 2021, "Accurately
computing the log-sum-exp and softmax functions", IMA J. Numer. Anal. 41(4), https://doi.org/10.1093/imanum/draa038;
Milakov and Gimelshein 2018, "Online normalizer calculation for softmax", https://arxiv.org/abs/1805.02867). No
clamp, epsilon or order truncation. Earth's tables are unchanged (noon, sunset, twilight and the table-against-march
check give the same values). The closed table now holds finite values up to 455 (native) and 444 (compatibility
level): Hillaire's one-transfer-for-every-order approximation is far outside its domain there, which is a model
limit, not a numeric failure. The environment bake's refusal above vertical scattering depth 6 stays as its own
domain limit (sky-environment.test.js).
Regression: `packages/sky/test/features-check.mjs` hillaire, case "closed" (nonfinite table count 0, finite sky),
both backends.

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

Accepted 2026-11-11 (Scott, "Yes, re-record"): four batch 160 cases failed on main after deliberate renderer
changes, bisected on the RTX A6000 (Edge, each old budget reproduced exactly at the parent commit, so the browser and
driver did not move them): da12bd07e1 (unit light direction from the CPU: iridescence +1, anisotropy +3, clearcoat +1),
65098f33fe (alpha-weighted area-filter mips: iridescence 454,342 to 613,669, anisotropy +207, clearcoat 1,321,923 to
1,322,883; the IridescenceMetallicSpheres guides texture is 2048 x 2048 BLEND, alpha-0 white with opaque black lines,
which the weighted chain keeps black and the Sample Viewer greys), 401c2e032b (linear glass: transmission 1,763,456
to 1,590,805, foreground 67,050 to 67,046). The height-correlated Smith G (KB5875a) then moved these and the other
direct-light cases. Every budget is re-recorded at its measured value; before and after figures and causes are in
docs/limits.md, "Batch 160 budgets re-recorded". The picture residual against the Sample Viewer stays open above.
- **Upstream report (draft, nothing filed):** `docs/upstream-reports/KB3497/report.md`; it points at the KB3508 NVIDIA page and says the link is consistent, not proven.

### Batch 160 AMD budgets not re-measured after the 2026-11-11 changes (open)

The `amd` rows of batch-160-specular.json and batch-160-ior.json and the budgets in batch-160-amd-transmission.json
and batch-160-amd-volume.json were measured before da12bd07e1, 65098f33fe, 401c2e032b and KB5875a; only the NVIDIA
rows were re-recorded. Repro: the same scripts with MARGO_GPU=amd on the Radeon (RDNA 2) machine. Cause: no AMD
adapter on the dev PC. Owed: rerun there and re-record under the same ruling.

### Batch 160 jobs 4 and 5: parked static-render variation (open)

Jobs 4 and 5 are now on main (job 5 on 2026-11-10, measured on main's area-filter mip chain; in that run all 72 SpecularTest and IORTestGrid captures matched on NVIDIA and AMD, so the IOR variation below did not appear, which does not close this entry). The parked branches named here earlier are deleted. Earlier budgets, recorded as found: volume compatibility full-Cycles absolute error 13,792,003 exceeds 13,792,000; native IOR can measure 2,423,421 against its frozen 2,423,418. Volume varies at blue samples (213,199), (214,199), (219,199); IOR varies at RGB (403,299). The bounded shared investigation did not establish the root cause.

Repro, from the earlier job 5 branch (deleted; the dedicated continuation below reproduces it on main): GPU-locked repeat.mjs --case=ior and the same with --case=volume --compat. Each captures 24 static frames, waits for GPU completion before each read and asserts identical decoded bytes. Both fail; all pictures and repeat.json are retained outside engine-bench/batch-160. Fixed GPU command replays also vary with unchanged uploads and draw order, without compute dispatches or float atomics. Native stored multisample values vary before final resolve. Splitting, merging or instrumenting passes changes the observed output, so these interventions do not establish a package-owned API defect or an inherent backend rule. No workaround, bias or tolerance is substituted. Jobs 6 to 8 are independent measurements and do not close this release-blocking defect.

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

Lane G current-main raw-API repro retains all 1280 triangles and captures
400 frames per API across two browser processes: four WebGPU hashes and
eight raw-WebGL2 hashes, no validation errors. Both exact-repeat assertions
fail. This is still an external multisample-blend problem with an unknown
closed-driver mechanism, not an attributed Margo repair.
- **Upstream report (draft, nothing filed):** `docs/upstream-reports/KB3508/report.md` with `msaa-blend-repeat.html` (WebGPU and WebGL2, no Margo code). On 2026-11-11, Edge 157, RTX A6000: WebGPU 299 of 299 frames differ (36 distinct), `mask: 7` none; WebGL2 on ANGLE D3D11 10 of 299 differ (9 distinct), on ANGLE Vulkan and D3D11on12 none; the AMD iGPU none.

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
coordinator; it is not a busy exemption. Held for the speed phase with the slow sends entry above (2026-11-11, lane L4):
the 7.4 ms frame had zero sends and 0.1 ms in the real write, the same shape as the measured page-thread stops on
the laptops (heading "biomes flythrough on laptops"); it is attributed on the quiet machine with the same trace
method before the budget runs there. Durable results:
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
textures remain unsupported by this route. The lane G native tint repair now
retains natural optical depth until the world-space refracted path is known;
the old thickness-200/scale-1/200 case draws black red/green channels before
repair and exact [137,188,255,255] afterwards. Thickness 1200, instancing and
mirrors are covered too. The existing public attenuation arrays retain their
meaning; materials without opticalDepth derive it from attenuation. Binary32
depth/transform bounds and the separate hooked per-unit-transmittance route
remain outside this repair. See [native-volume-range.md](native-volume-range.md).
The other transport and thickness-map gaps above remain open limitations,
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

Lane G current-main repro (2026-11-10): MARGO_GPU=amd and GPU_POWER=low-power,
browser-check.mjs denoise-materials reaches the unchanged 480x300 reference at
16384 samples on vendor amd / rdna-2, then loses its device. Dawn reports
DXGI_ERROR_DEVICE_REMOVED (0x887A0005); four shader modules compiled with zero
errors. This confirms the current failure, not a driver/kernel attribution.
The failed run was not retried or treated as a timing exemption. Local log:
test-results/kb-g/gate-62620-0.log. Per-ray termination/access invariants and
packet submission still require an isolating repair.

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

Lane G's current-main run of the original complete compatibility dynamic-check
sequence passes every exact pixel and pick assertion, including shadowed move
step 2. No repair commit or historical failure cause is established by this
single passing control, so this is not claimed fixed. The KTX2 continuation's
canonical FlightHelmet test is demo work and was not rerun during this sweep.

Bug sweep L3b (KB1042a, KB4278b, 2026-11-11): five consecutive MARGO_COMPAT=1 runs of the
unchanged check on 6077d08e87 (RTX A6000, ANGLE Direct3D 11, a shared GPU) passed every step with
0 of 153,600 pixels different, shadowed move step 2 included. Closed as not reproduced; the
regression guard is that exact check, packages/culling/test/gpu/dynamic-check.mjs (culling
test:gpu, native and MARGO_COMPAT=1). A recurrence reopens it here with the failing step.

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
Lane G's standalone DOF control exposes the same missing requirement: LDR has
5.322265625 percent over 2, mean 2.09423828125 and max 6; full and half-float
are byte-identical. DOF now checks the existing half-float requirement before
allocation and after releasing resources on restore. Six CPU cases fail on
the parent and cover default/temporal setup and replacement lifetimes; the
package's new tier GPU entry retains the unchanged parity rule and expects
the coded LDR refusal. See [DOF requirement](dof-tier-requirement.md).
Standalone TAA and TAAUpscale (KB4278c, 2026-11-11): their LDR images put 90.4 and 92.1 percent of pixels more
than 2 levels off (half-float at most 0.024 percent in two runs), so both now refuse LDR (`TAA history`) before allocation and
after releasing resources on restore, leaving the scene. Regression: packages/taa/test/lower-tiers.test.js (4 cases
fail on the parent) and the `taa alone` / `taa upscale` scenes of
packages/webgl2-compat/test/tier-packages-browser.mjs. That check had failed on main since 0525c34e14 added the
`post bloom alone 4x` scene without listing it among the LDR refusals (Bloom refuses LDR by design); it is listed now.
Other standalone HDR effects and other
package entries still need their measured requirement checks.
The DOF landing also repairs sciviz notebook/share dependency ownership: host
adapters install fallback, and both unchanged isolation assertions pass. See
[host backends](sciviz-host-backends.md).
The brief's separate full-tier compatibility failures remain in scope;
the voxel-pathtracer D3D11 hang has a separate owner and was not investigated here.

### Fixed 2026-11-10: verify plan import from eval and stdin

Repro: node --input-type=module -e "import('./scripts/verify.mjs')", or import
from stdin. Both launch modes omit process.argv[1], which the CLI guard passed
to pathToFileURL. Check that a CLI filename exists before converting it. The
real child-process regressions in tests/verify-import.test.js fail in both
modes on the parent and pass with the repair; an eval argument remains a
passing control. Imports expose the plan without starting checks. No verify
run, check list, deadline or public package API changes.

Lane G has a local guard repair with failing-parent eval/stdin regressions,
but it is not on main: its expanded dependent preview-contract.test.js still
fails twenty package-owner contracts. That unrelated check requires an owning
repair; no allowlist or weaker assertion was added to land the import fix.

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

### Fixed in 3982f1d7e: batch 56 remaining terrain disposal repair

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

### Fixed in ab70595e9: batch 56 ComputeFrame registration repair

Repro: register a new ComputeFrame in a secondary scene, register a same-name
default sentinel, then call frame.dispose(). Its arrays were freed but its
registration remained; the default sentinel was removed. The frame entry now
resolves sceneOf(this). Its direct-disposal regression fails before repair and
both direct and owner-removal cases pass after repair. Package units pass
111/111. GPU/README acceptance and the wider audit remain pending.

These owner repairs are already on main. Lane G reran both terrain owner files,
ComputeFrame owner tests and its GPU-registration regression: all 26 pass.
The completed GPU acceptance snapshot below supersedes the older pending note.

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

Fixed 2026-11-11: batch 222 LOD imposter picking hang. The picking grid stalled in readback mapping; 48ac029631 makes the mapping wait the buffer's own readiness, covered by `packages/webgl2-compat/test/task-polling.test.js` (nonforcing, queued-write and device-loss cases). The unchanged 16384-pick grid passes on both backends.

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

Lane G's hidden current-installation `--version` control still fails before
execution with native error 14001. No browser, DLL, manifest or setting changed.

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
the pinned paired manifest and private batch 133 driver. Speed work is deferred
by scripts/speed-phase.json; the item is listed in docs/work-lists/speed-phase.md.
Fresh-process RSS losses are closed (KB4824a, below); the native process
starts below the prebuilt in every campaign.
Historical predictor 3 and invalid UTF8 metadata conversion were closed on
2026-11-11 (bug sweep L5b, see the two entries below and above). Full
historical KD/type/transform coverage beyond the crafted one-triangle layouts
is not established. Both prebuilts stay default while the warm speed losses
remain (deferred speed proof, KB1492 held); no replacement pass is claimed.

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

### Fixed 2026-11-11: batch 133 malformed metadata trailing groups had no defined rule (bug sweep L5b, KB4798)

The optional native decoder differed from the full opaque prebuilt on 22 of
1,613 crafted metadata strings whose last 2/3/4-byte group runs past the value
and its terminal NUL. E25 ([clean-room.md](clean-room.md#bug-sweep-l5b-e23-to-e25-historical-predictor-3-bit-streams-and-past-value-strings-2026-11-11))
settles the rule: with every stream byte after the value unchanged, the opaque
binding's last code point changes with the value's length alone (held-8 at
lengths 9 to 13 gives U+80009, U+8028B, U+80807, U+801C1, U+80040), so the
bytes it reads come from its own memory, not the bitstream. No bitstream rule
can reproduce them. Margo reads absent group bytes as zero, which equals the
opaque decoder's own result for the same value carrying explicit zero bytes in
all 22 cases. Regression: `packages/decoders/tests/draco-native-entry.test.js`
("never read past the value"). The remaining difference is recorded in
[limits.md](limits.md); no code change was needed.

### Fixed: glTF textured pass raw light alias

The textured frame destructured engine.lighting.direction and copied it raw
after core's shader began consuming an already normalized direction. This
made textured pixels brighter than the equivalent constant material. The
existing shared unitLight writer repairs the owning package. The real draw
writer regression fails before and passes after; GPU comparison assertions
and tolerances remain unchanged.

### Fixed 2026-11-11: batch 133 fresh-process RSS losses (bug sweep L5b, KB4824a)

Fresh-process strict RSS losses: 116/3,881 full and 113/1,003 accepted glTF
inputs. Largest observed excesses: full input83a312e3fe... +5,017,600 B; glTF
inputa22e31f28c... +5,660,672 B. Exact hashes, old/new peaks, copy counts and
manifest identities are in [the complete record](whitepaper/results/batch-133-resources-inventory.json).
Linear-memory peaks pass; physical-page, JIT and live-allocation contributions
to the RSS excess are not yet isolated. This remains an unaccepted target
requiring a root allocation diagnosis, not a busy-machine timing waiver.

Lane G's one fresh pair per retained largest-loss input still fails RSS while
matching output: full hash83a312e3fe is 77971456 native versus 73531392 old;
glTF hasha22e31f28c is 78626816 versus 74055680. Native linear memory is
1376256 versus 16777216 old in both controls. These two samples do not replace
the full campaign or isolate physical pages/JIT/live allocations. An initial
manifest used a missing relative input path and failed before sampling;
the resolved-path run and setup failure are retained separately.

Bug sweep L5b round 2, 2026-11-11 (KB4824a, cause found and fixed): the pinned
original corpus (404 entries, 323 unique inputs, BrainStem and CarConcept
included) was rebuilt outside the repository from the manifest's source URLs,
every hash matching. With the current Wasm the loss reproduced: 84 of 168
BrainStem/CarConcept inputs (full) and 93 (glTF), largest +5,107,712 B. The
excess was not decoder memory: with `--liftoff-only` the native process grows
1.7 MB against the prebuilt's 2.9 MB on the worst input. V8 dynamic tiering
(Liftoff, then TurboFan once a function's budget runs out; V8 blog, "Liftoff: a
new baseline compiler for WebAssembly in V8", C. Backes, 2018,
https://v8.dev/blog/liftoff, and "WebAssembly Dynamic Tiering ready to try in
Chrome 96", A. Haas, 2021, https://v8.dev/blog/wasm-dynamic-tiering) compiled
four hot native functions of 5,623 to 12,171 B, whose optimizing work memory
grows with body size: 7,402,376 B peak against 1,626,064 B for the prebuilt
(`--trace-wasm-compilation-times`, deterministic). Every predictor, both
traversals and all setup code sat in those bodies. Fix, output unchanged: one
row loop per predictor (`Integer::rows::<M>`), one EdgeBreaker symbol loop per
traversal with rare split work out of line, the mapping phases, Walk
traversals, per-point output loops of the sequential and KD decoders and the
result buffer as separate functions. Same input: 2,178,952 B; the committed
CarConcept fixture: 7,683,216 to 3,241,160 B. Campaigns on all 323 inputs, one
observation each, outputs exact: full 1 loss (was 84 on the subset), glTF 2
losses of 81,920 and 90,112 B, below the 434,176 to 667,648 B spread of the
native startup stage within the same run; largest native peaks now below the
prebuilt's (107,794,432 against 108,666,880 B). The full loss is pc_kd_color
(+196,608 B): the measurement child converts native point attributes to float
in JavaScript, which Margo's point API never does; without that conversion the
native process grows 2.1 MB against the prebuilt's 3.9 MB. Regression:
packages/decoders/tests/draco-native-tierup.test.js (fails at 7,683,216 B
before, passes at 3,241,160 B).

Residues closed the same day (records in
[whitepaper/results/batch-133-kb4824a-residues.json](whitepaper/results/batch-133-kb4824a-residues.json)).
pc_kd_color: the measurement child now asks each side for what Margo's API
returns (`--outputs=api`, the default): DracoPointsDecoder hands point
attributes in their stored type on both decoders, so neither side converts.
On the four point clouds of the pinned corpus the native process peaks lower
on every input (pc_kd_color 81,539,072 against 83,222,528 B). The old
conversion stays as a like-for-like row (`--outputs=float`, both sides convert:
the prebuilt in its Wasm, the native side in JavaScript): pc_kd_color is
+327,680 B there, a cost no Margo call pays, recorded in limits.md. The two
glTF samples: re-measured with the allowed paired check (`--paired=9`, sides
taking turns in fresh processes, per-side minimum), the native minimum is
lower on both (BrainStem 0/54: 82,485,248 against 82,935,808 B; CarConcept
20/0: 82,145,280 against 82,944,000 B), and lower in 17 of 18 rounds. No RSS
loss remains on what Margo's API does. Regression:
tests/draco-resource-harness.test.js (api outputs leave point-cloud floats out
on both sides, float outputs convert on both; paired turns and minima; a
float-output checkpoint cannot resume as an api campaign), failing on the old
harness.

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

Fixed 2026-11-11 (bug sweep L5b, KB4824b): historical texture-coordinate
predictor 3 (versions 1.0 to 1.2) is now decoded. E23/E24 crafted black-box
observations fix its float32 arithmetic, half-up rounding, orientation sense,
coincident-neighbour and equal-value behaviour, the bit-stream state bound and
exhausted refill, and the pre-2.0 wrap-span limit. The 12 retained streams and
246 further crafted cases (237 accepted, 21 rejected) match the full opaque
decoder byte for byte; 18,000 randomized comparisons on the final build agree
on output and acceptance (12,437 accepted and 5,563 rejected by both). Regression: `packages/decoders/native/draco/tests/legacy_uv.rs`
(fails before the fix with code 5 on the first retained stream).

Fixed 2026-11-11: packageInputs in scripts/package-stamps.mjs now lists the Rust folders `native` and `kernel`, so an edit there changes the package's API freshness stamp (cargo `target` stays skipped). Regression: tests/package-stamps.test.js (changed Rust file test).

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

### Fixed 2026-11-11: README browser shutdown SHUTDOWN_TIMEOUT for an exited Chromium

The batch 268 README gate threw SHUTDOWN_TIMEOUT for a Chromium PID that was already gone. Cause: the shutdown waiter
counted a pid whose start time could not be read as a survivor of ours. Fixed in 7f88e42a8a (regression in
`tests/browser-teardown.test.js`), with 919fdc09ef (browser server in a host process) and 956c3d0514 (a killed tree ends
only after its processes close their handles).

### Batch 265 job 2: Instances ownership

The new binding initially applied an explicit material only when its prototype mesh already existed. Child effects
run before the owning Mesh creation; StrictMode exposed the missing attachment. The material now registers with the
prototype attachment set and follows each live mesh. Regression: packages/react/tests/instances.test.js, named Scene,
explicit material and live material edits. Instances is built independently of the remaining texture/priority/adaptive jobs.

Outside batch 265 (fixed 2026-11-11): the catalog teardown SHUTDOWN_TIMEOUT for an exited Chromium was the same false-survivor waiter as the README browser shutdown entry, fixed in 7f88e42a8a with the regression in `tests/browser-teardown.test.js`. No React test failed.

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

Closed 2026-11-11 (KB4915, sweep L2): the cause was the capture read fixed by the batch 206 entry below (the rigged frame was read before the compatibility queue replayed its commands); on main 00ffed75f3, Edge 157, RTX A6000, `node scripts/modern-usdz-tests.js --compat` passed 3 of 3 runs and native WebGPU 1 of 1 with no GPU errors, and that three-pose check is its regression test. Original entry: Batch 171 outside scope: node scripts/modern-usdz-tests.js --compat fails RiggedFigure.usdz motion (moved false, repeats true, no GPU errors), while native WebGPU passes; narrowed to the USDZ skeleton/animation compatibility drawing path, exact owner unproved. Log test-results/sciviz-fixes/formats-dependent-usdz-true.log. Deferred under rule 21; main 896ebf844 requires GPU gates only for changed packages.

Fixed 2026-11-11 (KB4915-fixture, sweep L2): `node scripts/modern-usdz-tests.js` failed with ENOENT when run on its own, because it read `test-results/usdz-textured.usdz`, which only a repo-root run of `packages/usdz/tests/usdz.test.js` wrote (a run inside packages/usdz wrote it under packages/usdz/test-results). Both now build the textured archive in memory from `packages/usdz/tests/preview-fixture.js` (`texturedFixture`), the file picker gets it as a buffer, and the script creates `test-results/` before writing its record. With no archive on disk, native WebGPU and `--compat` each passed 1 of 1. Regression: packages/usdz/tests/usdz.test.js ('the browser check builds its textured archive in memory').

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


Fixed 2026-11-11 (batch 171 job 6 follow-up): clearing the demo's Sun (UTC) datetime input passed an invalid Date to globe.setDate, which rejects it, leaving the event unhandled. The demo now keeps the last valid time and says so in its status line. Regression: packages/sciviz/tests/atmosphere-browser.mjs (clears the input on both backends; no page error).

Batch 258 dependent fixture: after-scene-browser.tsx now waits for its actual held asset request, in addition to Suspense fallback, before exposing the snapshot. The previous count-0/count-1 race is covered by the unchanged React browser request assertion.

Image follow-up (batch 258): generic attachMirror does not yet emit labelled Image roles; replaced image tiles stayed resident until atlas eviction/renderer disposal (fixed 2026-11-11, KB4990b: a build that no longer draws an image releases its colour atlas slots, and a page left empty is reused; 100 replacements of a 250 px image used 16 pages and then threw "Glyph atlas is full", now at most 3 pages; regression packages/ui/tests/webgl2.test.js and packages/text/tests/text.test.js KB4990b cases). These build-phase quality gaps are queued in private finish-later, with residency limits documented.


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
Fixed 2026-11-10: batch 260 HTMLBlend inherited custom view. Apertures now use the same explicit camera and view rectangle as the DOM, converting normalized or drawing-buffer-pixel coordinates into the current target's pixels. Both drawing paths set the matching scissor; preview restores its prior scissor rectangle and enable state. Four CPU regressions fail on the parent and cover engine-camera fallback, a custom camera, fractional edges and a scaled target. blend-browser.js checks live DOM centers, intact opaque control pixels outside both view and panel, input and GL state on native WebGPU, full compatibility and preview. Existing foreground, visibility, resize, removal and disposal assertions remain intact.


Fixed immediately after batch 171 landing: a88cfd4fe contained unresolved boundaries in docs/api-surface.md after a native helper failed but its PowerShell caller continued. Authoritative api:update regenerates the summary; generated-metadata-conflicts.test.js fails on that published artifact and passes on the repair. No engine or atmosphere runtime source changed.


Fixed core version skew: missing engine-local version/module identity checks allowed a plugin from
a second install or a stale build to mutate core's ownership registries silently. The packed
two-install and stale-build regressions now reject before plugin work; same-path matching imports
pass. [Design, regression and size evidence](core-version-guard.md).

Fixed 2026-11-10: GPU package-runner owner collision (version guard). Unrelated worktrees previously shared the generic check owner and were serialized despite free slots. Both serial and parallel admission now use a stable digest of canonical worktree identity, retaining one slot per worktree and distinct suite labels. Regression: tests/gpu-suite-owner.test.js reproduces the parent runner collision with CPU-only admission and checks independent owners; scheduler policy and GPU assertions are unchanged.

Dependent audio GPU validation is incomplete for the version-guard landing: the shared GPU monitor reclaimed lane-T-version-guard at 2026-11-10T02:28:06.439Z after 211623 ms without GPU activity, while audio/scripts/test-browser.js awaited its browser evaluations before writing audio-browser.json. The suite produced no report and did not reach its own 10 min limit. Root cause of the uncompleted audio evaluation is unconfirmed; monitor evidence is in the local GPU idle record and test-results/version-guard-resume/gpu-lane-T.log. No timeout or idle threshold was raised.

Audio follow-up: the bounded instrumented diagnostic ran every unchanged audio assertion successfully and wrote the full report (test-results/version-guard-resume/audio-phase.log, 2026-11-10). It does not explain or waive the initial monitor-reclaimed run; retain that stall for the fix phase.

Audio follow-up (sweep L6, 2026-11-11, still open): not reproduced; the whole suite takes 9 to 10 s on the dev PC. The reclaimed run was the audio step of a serial `scripts/gpu-package-tests.mjs` run (local GPU idle record, 02:28:06Z, 211,623 ms idle), and the Windows System log holds no driver reset (4101, nvlddmkm 153) between 02:15 and 02:30Z, so a GPU reset did not cause it. Every page call of `packages/audio/scripts/test-browser.js` now has a 60 s limit that names its step and prints the state and clock of every real AudioContext the page made, so the next stall fails in about a minute and names the call (a real-time `resume()` that never settles, an `Engine.create`, or a media element that never plays).
- Fixed while recording the VRM asset: appended WebXR generic-hand provenance is now part of the notices generator asset table, preserving the original licence and hashes. The existing supply-chain consistency test covers both records.

- Fixed 2026-11-11 (4e703eb6e6): `addVRM` in packages/rigging/src/vrm.ts registered and removed its plugin through the active scene rather than the model scene. Dispose now removes it from its own scene (`engine.sceneOf(plugin)`); regression: the "dispose removes the face plugin from its own scene" test in `packages/rigging/tests/face.test.js`.

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
- Fixed 2026-11-11 (sweep L6): `recordCanvas` checks that the file holds an encoded frame before it resolves (a SimpleBlock or BlockGroup inside a WebM Cluster, read by an EBML walk of the first MiB; an `mdat` box with a payload in MP4, read box header by box header) and otherwise rejects with code `state`. Regression: packages/video/test/record.test.js ("a recording with no encoded frame rejects"), failing on the parent. Was: outside batch 263: video/record can resolve a header-only WebM when stopped before Chromium encodes its first frame. Repro: record a native WebGPU canvas at 30 fps, render 12 requestAnimationFrame ticks, then stop; observed 110-byte video/webm;codecs=vp8, decoder rejects DEMUXER_ERROR_COULD_NOT_OPEN. Cause: recordCanvas validates only nonzero Blob size, which also accepts container headers. A 1.2-second recording decodes correctly on WebGPU and preview WebGL2. Fix phase should add first-encoded-frame readiness or structural stream validation in video/record with a short-recording regression.
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

Fixed 2026-11-11 (KB5128a, bug sweep L3): CompatBuffer.mapAsync ignored offset and size, and getMappedRange sliced without enforcing the mapped interval or non-overlap. Both now follow WebGPU's rules: mapAsync rejects with OperationError (and reports a validation error) for a mode the buffer lacks, an offset not on 8 bytes, a size not of whole words or a range past the buffer; getMappedRange throws OperationError outside the mapped range, unaligned or overlapping a range already returned. Regression: packages/webgl2-compat/test/device.test.js, "mapAsync and getMappedRange keep to the mapped range".

Batch 220 job 2: the requested scalar interpolants/keyed-curve gap is implemented in math/curve; no open defect found by its analytic and ownership tests. Cubic overshoot and clamped time evaluation are explicit contracts in limits, not monotonic or periodic interpolation claims.

Batch 220 umbrella generation also supplies missing exporter aliases for entries already present on main: optimize-extra during the initial gate and splats during the final rebase. Cause: its exports map had not been regenerated into the umbrella; tests/umbrella.test.js requires exact generator agreement and now passes all eight checks. No exporter implementation changed.

Fixed during batch 220 landing: inspector/gl imported the compatibility preview registry/compiler and declared its package as a peer, violating packages/webgl2-compat/test/isolation.test.js. Native canvas access and locally owned fixed overlay compilation remove both edges. packages/inspector/test/gl.test.js covers registry independence, failed compile/link cleanup and state restoration; isolation tests pass unchanged.

Batch 258 job 4 closes preview GL's missing world-panel drawing in the optional world-gl entry; real pixels, depth, back faces, removal, mouse rays and foreign-state restoration are covered. Context-loss/XR hardware stress and oblique-filter polish remain certification follow-ups in private finish-later.

Fixed 2026-11-11: UiRenderer's glyph upload (GlAtlas.upload in packages/ui/src/gl.ts) reset the unpack buffer and alignment but not UNPACK_ROW_LENGTH, the skip counts or the image height, so a caller's row length shifted every glyph row. It now sets all of them to 0 before texSubImage3D. Regression: packages/ui/tests/webgl2.test.js (the unpack reset test fails on the parent).

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

Batch 210 job 1: requested action operations pass mixer.test.js and analytical/real-rig GPU checks. Cache lookup follow-up, fixed 2026-11-11: existingAction on an unknown clip returns null and an unused root gets no player (Regression: packages/animation/tests/mixer.test.js, existingAction test). The umbrella generator also restores the already-exported but missing exporters/splats alias; the existing umbrella consistency test covers that generated-file gap. Optional-root pointer rebinding and reverse-time scheduled starts receive broader fix-phase coverage in the finish-later list (git-excluded, outside a clone); all requested mixer operations are built.

### Fixed while generating batch 224 aliases
Origin/main 43e08376d added exporters/sparse without its umbrella facade. The ordinary umbrella generator needed for mesh-edit/boolean-batch also restores that upstream alias. Regression: tests/umbrella.test.js (manifest, identity and import-map checks). No exporter implementation changes.
### Batch 226 tags and lifecycle
Fixed during integration: synchronous parent/creation notifications could expose attach transforms or clone metadata before initialization. Optional graph/clone now batch notifications until commit; the tags.test.js attach/clone listener and failed-allocation regression fails without that boundary. Failed observer installation restores any already-installed wrappers. No open defect found in the requested row; pre-saved method references and private-store mutation are documented observation limits.
Fixed 2026-11-10: Batch 245 GPU planner registrations. GPU planner registrations and command ordering are repaired on main (af4b357e1, d7be06653). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.

- Fixed 2026-11-10 (lane I, batch 132 Mac sweep): XR AR-extras GPU fixture: node packages/xr/tests/ar-extra.browser.mjs fails on clean origin/main 6ab64e777 as well as batch 265 with missing AR observations. The fixture counts session frames started before its async observation helpers attach; under shared load it reads before those helpers receive a frame. Receipt: test-results/batch265-resume-cleanmain-xr-ar.log. Owning fixture fix waits for the fix phase (rule 21). Fix: the injected check now waits three session frames counted from after MeshDetection and ImageTracking attach before it reads them (packages/xr/tests/ar-extra.browser.mjs). On the M6 Mac mini it failed in both the native and MARGO_COMPAT=1 sweeps before the change and passed 3 of 3 runs in each after it. No assertion or threshold changed.



### Fixed: review 99 composed native validation exceeds its twelve-minute lease

Fixed 2026-11-10. Cause: each of the 32 feature subsets (plus the reflected and update cases) builds its own trace
program, and on native Dawn/D3D12 (RTX A6000, Edge 157) each trace pipeline takes about 17 s to compile (16.3 to
18.6 s measured, other pipelines of a tracer under 3.2 s). `compose.html` made one tracer at a time, so 35 compiles
ran end to end (about 600 s) before any rendering, past the twelve-minute lease. The page now makes `parallel`
subsets at once (default 8 natively, 1 on the WebGL2 layer, where 8 measured 223 s against 43 s; `--parallel=<1..32>`), so their pipelines compile side by side on the browser's worker
threads: 8 trace pipelines were ready in 34 s against 136 s one after another, and the whole native run passed in
146 s with every subset oracle, the reflected RIS case and the atomic update unchanged. The check now fails if
native trace compiles stop overlapping (`trace pipelines compile side by side`). The per-pipeline compile time
itself is the parked bug 45 compiler-pressure work (native split), not changed here. The review 99 timeout
supervisor (ee32e602f) was not landed: the page's `compose-progress` lines already name the phase and pipeline a
stalled run waits on. Regression: packages/voxel-pathtracer/tests/compose-browser.mjs.

History:

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

Batch 207 lightmap build integration: Blender's curated bundle external list did not include the new owning lightmap/imported entry, so it duplicated the texture runtime. Fixed in the same job; regression lightmap.test.js checks the bare package import. Generated geometry instances are not independently baked (repro: collection instances under different shadows; cause: Cycles bake operates on original view-layer mesh objects). Documented 2026-11-11 as a limit in `docs/limits.md` (Blender lightmap bake row) and in the Blender README: make the instances real before export for spatially distinct irradiance. Pinned 2026-11-11 by `tools/blender-addon/tests/blender_lightmap_instances.py` (run by `npm run modern:test:blender`): two collection instances of one plane bake once, as the source mesh.

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
The post-push full API check caught an incorrect merge of the generated summary: the aggregate omitted the unscoped margoengine row (97 instead of 98 packages) and retained upstream stale table cells. The initial corrected snapshot counted 98 packages, 1073 entries and 9741 names; current totals are generated in api-surface.md. tests/api-report-scope.test.js now checks table totals including the umbrella; the existing full API check remains authoritative for each row. This is a fix forward for the generated index, with no runtime or API implementation change.


Batch 232 moon: no open defect found in the new lunar layer. CPU regression covers
texture replacement/restoration/disposal, malformed inputs and aborted fetch;
`packages/scenery/test/moon-gpu.mjs` proves phase, earthshine, map orientation and
depth masking. The visual approximations are listed in docs/limits.md.
Fixed 2026-11-10: loaders/geo pre-abort precedence (batch 202). Shapefile and MVT now check cancellation before inspecting bytes. The same guard precedes binary XML conversion for GPX/KML and caller object serialization for GeoJSON, closing the shared early-conversion gap. Regression: packages/loaders/tests/geo.test.js has five cases that fail on the parent, including malformed/truncated binary input, wrong-shape binary input and an observable toJSON callback. The existing LoaderError code aborted is retained; ordinary format validation and parse output are unchanged.
- Batch 213 MToon integration: two independently loaded blended models with crossing renderQueueOffsetNumber values retain scene model order; the material adapter orders primitives only inside one model. Global model queue scheduling is a fix-phase follow-up.
- Batch 213 MToon integration: an alpha-cutout shadow caster with a spatially varying UV animation mask uses the static alpha UV while beauty moves; optional shadow sampling does not receive the material's mask/time bindings. Beauty, normals, emission and hull animation are built; shadow integration is a fix-phase follow-up.

- Fixed 2026-11-11 (bug sweep L2, KB5289c): test-extensions-browser.js read argv[2] as a name filter, so --compat selected zero checks and passed. It now takes the first argument that is not a flag as the filter and refuses a filter that matches no check (scripts/name-filter.mjs). Regression: packages/gltf-pro/tests/name-filter.test.js.
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
- Fixed 2026-11-11 (bug sweep L6, KB5322): AnimatorGraph.captureState() and restoreState() snapshot the bools, set triggers, the active transition (its interruption rule) and the source state and time with the Animator's playback; a snapshot that does not fit the graph is refused before anything changes. Regression: packages/animator/test/transitions.test.js (two graph snapshot tests). Original entry: AnimatorGraph snapshot follow-up (batch 211, rules 21/22): capture graph.animator during a graph fade, change a bool/trigger or take a different interruption, restore the Animator snapshot and update. Graph bools/triggers and the selected interruption source/policy live in the controller and are outside AnimatorState, so restoring playback alone does not rewind graph decisions. Add a graph-level snapshot in the fix phase; live layer, tree and transition features are built.

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
- Fixed 2026-11-11: quality's scanners (clean-room, duplicates, tests floor) read repo files through readRepoFile, which skips a listed file removed before the read (the React `.subpaths-*` case was ignored earlier). Regression: tests/quality-inventory.test.js (scanners skip a removed file).
- Fixed 2026-11-11 (f671ae5d85): `npm run quality -- --gate=sizes --update` shrank other lanes' size budgets from a stale dist (video/record 1,996 to 1,460 broke main's sizes gate; post/ssgi, post/ssr and sciviz/multivolume shrank too). Cause: the sizes gate measured dist files without asking whether they match the checked-out sources. The gate now names each item's owning package and reads the build stamps; an update keeps a stale package's recorded budget and refuses a first budget from a stale build. The four budgets were restored. Regression: tests/quality-gate.test.js (stale-build budgets kept; every sizes item has an owning package); docs/conventions.md, Quality gate.


Batch 216 job 1: no open physical-lens defect found. Invalid constructor settings, live edits and tracked focus reject before camera/DOF output writes; physical-lens.test.js covers this contract.



- Batch 207 live-node quality follow-up: Noise uses an independent Margo hash/gradient ordering, so the same Blender settings produce different stochastic texels; socket curves are sampled per frame and interpolate linearly between samples. Reproduce by comparing the nodes fixture with Cycles noise or seeking halfway between non-linear keys. All requested node families and live controls are built; exact stochastic and subframe curve matching remain finish-phase quality work (also in the finish-later list (git-excluded, outside a clone)).

### Batch 261 routed callouts
No open correctness defect identified. The planar assignment replaces independent crossing-prone source/slot connections; a two-point fixture proves label reordering. Independent segment intersection/overlap checks cover integer, fractional, collinear, coincident, enormous and subnormal inputs. Browser tests check SVG-to-DOM endpoints and stable-frame writes on both native rendering backends.

### Labels GPU finish-phase edge cases (batch 261)
- Fixed 2026-11-11: GPULabelLayer.create's wait for Font.load now races the signal, so an abort rejects with the signal's reason at once and the load ends unobserved. Regression: packages/labels/tests/gpu.test.js (create stops waiting for a font that is still loading).
- Fixed 2026-11-11: GPULabelLayer.draw sizes labels from the canvas content box (bounding rectangle less border and padding), not the outer rectangle. Regression: packages/labels/tests/gpu.test.js (content box test).

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

- Batch 231 scope finding: `node packages/culling/test/gpu/meshes-occlusion-check.mjs --compat` fails its native Hi-Z draw-count assertion (1509/1509 behind the wall). Cause: existing CulledMeshes compatibility route intentionally performs frustum-only culling (`src/compat.ts`), separate from the new DepthPyramid API; software `culling/webgl2` is a separate API. New scatter/occlusion performs real Hi-Z on both backends. Deferred legacy parity per build-phase rule 21. Closed, lane L (2026-11-10): the check has a compat branch (frustum-only counts asserted, occlusion counts skipped with a note); docs/limits.md "Compat branches for GPU-only assertions".

### Batch 244 job 1
The camera rig is built with direct CPU trace and GPU overlay regressions. No open defect identified in this job's scope; other known defects remain in their existing entries.

Fixed 2026-11-10: Outside batch 244. Current complete GPU plan passes browser registration and chain validation; original repairs: 326c67544, d7be06653, f235e21f0. Regression: tests/gpu-browser-registration.test.js and tests/modern-extension-suite.test.js.

- Fixed 2026-11-11: package-lock.json went stale on main when 29b4a5cea added an optional `@margoengine/compute` peer to packages/audio without the lock (a fresh `npm install` rewrote the lock; relocked in 991322178c). The lock check lived only in a test that the fast gate does not run, so hygiene now calls `assertLockInSync` (scripts/support/lock-sync.mjs), which also compares optional peer flags and workspaces missing from the lock; regression: `tests/package-lock-sync.test.js`.
- Fixed 2026-11-11: conflict markers in known-bugs.md and whitepaper/reproduce.md (seen on origin/main 42c1cbdac) were removed in 3f71b2d491, and 856e8f21da makes hygiene reject tracked conflict markers; regression: `tests/hygiene-conflict-markers.test.js`.
Batch 212 analyser: repaired bus insertion deleting internal output taps and shared-document merge markers, both covered by regression tests. No open tested defect.
### Fixed 2026-11-11: Firefox worker matrix failed to spawn (UNKNOWN)

Cause: the Firefox launch environment (a side-by-side manifest refusal of the installed browser), not a worker assertion.
34fe47227a made the GPU suites run Firefox, and 9d48f32882 added `packages/worker/tests/browser-matrix.mjs`, which proves
worker rendering in Firefox and the WebKit fallback with the unchanged mode, buffer-transfer, red-pixel and disposal
assertions.

### Batch 228 job 1 survey tools
No open defect found in the new volume/profile computations; boundary, transform, real scan and both-backend rendering regressions are in the points tests. Snapshot and resident-data limits are in docs/limits.md.

- Fixed 2026-11-11: nested merge markers in shared docs (seen on main 8ee384c7e, for example docs/clean-room.md) were removed and 856e8f21da makes hygiene reject the class; regression: `tests/hygiene-conflict-markers.test.js`.



### Fixed: batch 217 inherited API summary merge boundaries

Concurrent main contained nested conflict markers in docs/api-surface.md. Scoped api:update refused it, and api:check failed its generated-summary comparison. A full api:update regenerates the summary from the built exports; no unrelated API implementation changed. scripts/api-report-scope.mjs already rejects marked summaries, and the normal api:check remains the regression gate.
Batch 222 job 2: authored material-chain checks found no remaining defect. Fixed 2026-11-11 (bug sweep L3b, KB5405b): KHR_materials_variants and MSFTMaterialLOD both selected a primitive's material. Repro: attach MSFTMaterialLOD, then `model.selectVariant(name)`: the variant's finest material stayed on a far primitive (the controller kept its old level), a variant selected before attach was ignored, and dispose put the file's material back over the variant. Cause: the controller read only each primitive's file material chain and restored `undefined` (the file material). Fix: the controller follows the material the primitive shows at full detail, the selected variant's mapping or else its file material, and its MSFT_lod chain; when selectVariant or an edit replaces the material it starts over at full detail of the new one; dispose restores that variant material. Regression: packages/lod/test/msft.test.js ("follows the selected KHR_materials_variants material", "variant selected before attach").

Batch 222 job 2 scope receipt: msft-check passes native and compatibility, including later UV2, retained vertex buffers and original material restoration. Shader-review and extension checks pass both backends. The broader compatibility materials permutation reproduced a 16-fragment-sampler overflow (test-results/batch222-msft-gpu.log); fixed 2026-11-11 by aa3e347dac (complete physical permutations budgeted for compatibility sampler units, five base maps packed into shared float layers), with regressions in `packages/gltf-pro/tests/base-textures.test.js`, `materials-ext.test.js` and `tests/integration-json.test.js`.
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

Fixed 2026-11-11, GLSL importer syntax edge cases (batch 218, rule 22): `uniform float weights[2+2];` followed by a transition rejected at parsing, because GLSLParser.array admitted only literal or named lengths, and helpers with unnamed parameters rejected because parameter parsing required an identifier. The parser now folds a constant-expression length (+, -, *, /, %, unary signs, parentheses, integer literals and earlier `const` globals) to one integer and refuses anything else (a division by zero, a uniform, a float, a non-const name); an unnamed parameter gets a name no source can spell. Regression: packages/transitions/test/glsl.test.js "constant-expression array lengths fold and unnamed helper parameters are accepted".

### Batch 244 job 3
The CRT composite-video look is built with signal invariants and native/compatibility GPU readback regressions. No open defect identified in this job's scope; the intentionally stylized baseband model and unshifted glow ordering are documented in limits.


Batch 238 job 3: no open reader defect found by real range extraction, cancellation, malformed manifest, v3 and both-backend GPU checks. Fixed owning LOD pool slot exhaustion for uneven nodes while adding structural sources; maxNodes regression in lod-sog.test.js covers it.

Batch 238 dependent gate finding (fixed 2026-11-11 by 302f23d1ef): `npm test --workspace @margoengine/sciviz` ran glyph-data.test.js from the package directory while its fixture paths started at the repository root (ENOENT displacement.e). The test now reads its fixtures relative to its own file (`import.meta.url`), so it passes from either directory.

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

Fixed 2026-11-10: batch 212 retained mixer insert references. Bus.teardown now clears its insert-edge references after disposing stages. packages/mixer/tests/mixer.test.js traverses the held bus's owned JavaScript object graph, excluding borrowed mixer/context owners, and proves that former stage objects and nodes are unreachable after bus or mixer disposal. The regression fails on the parent; node disconnection and idempotent disposal remain checked without garbage-collection timing assumptions.
Fixed upstream: batch 212 stale meter reports after reset (f1596f19f). Audio-thread reports carry the reset generation and the main thread rejects stale reports. Rechecked 2026-11-10: the unchanged analyser.test.js in-flight-report regression delivers the old report after reset, retains zero frames/levels, then accepts the current generation's new audio samples.

### Batch 214 scope
Chain avoidance has no known defect from its correctness cases; bounded search and static-only limitations are documented in limits.md.

Fixed 2026-11-10: Batch 214 unrelated GPU planner repro. GPU planner registrations and command ordering are repaired on main (f235e21f0). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.

Batch 238 job 4: no open modifier defect found by independent SH/position/opacity probes, repeated seek, lifecycle and real-image restoration checks. Source centre/opacity changes require explicit setRest, as documented; RGB, SH and covariance remain live inputs.

Fixed 2026-11-11 (batch 238 finish-phase validation gap): a streamed manifest with top-level model "2dgs" and chunk metadata omitting model was treated as ordinary 3D. Cause: the adapter validated only the per-chunk SOG model. `loadStreamedSog` now refuses any manifest model other than `antialiased` with code `unsupported` before it fetches a chunk. Regression: packages/splats/test/lod-sog.test.js "streamed SOG refuses a manifest model it cannot draw before fetching any chunk".



### Fixed 2026-11-10: batch 217 browser shutdown blocker (a false survivor)

The scroll job on batch-217-scroll (6660e0bb7) passed render/VFX/editor/curve interactions, then browser.mjs:344 raised SHUTDOWN_TIMEOUT for Chromium PID 109224; the browser host recorded it still present 677 ms after termination. Repro: scroll-gpu.log of lane P (git-excluded, outside a clone). Cause: the waiter `waitSignaled` (scripts/support/shutdown.mjs) reported any pid whose start time it could not read as a survivor, and it could not read the start time of a pid that named no process of ours any more. A survivor proven within the 2,000 ms grace is only possible this way (a real one is reported after 120 s). Fixed in the waiter; see the entry "Open, outside Margo, worked around 2026-11-10" for the measurements and tests.


### Fixed: batch 217 nested gesture and focus ownership

The base editor cancels pointerdown, so the browser suppresses native mouse/dblclick events, and its broad contains(focused) redraw check also treated focused child items as its own. This prevented native nested opening and moved keyboard focus to the parent after a child edit. The optional editor recognizes stationary pointer pairs after the native pointerup transaction; the base editor restores only its own nearest-panel focus. nested-browser.mjs verifies actual double-click opening, one child key nudge, shared undo, subsequent primitive authoring and two-level playheads without bypassing input handlers.


Fixed 2026-11-11: cutscene state.transforms and state.properties no longer use inherited dictionary entries; a target or property named __proto__ or constructor stays an own data property and never reaches Object.prototype. Regression: packages/cutscene/tests/cutscene.test.js (__proto__ test).

Fixed 2026-11-11: the orphan closing merge-marker lines in clean-room.md, limits.md, whitepaper claims/reproduce and readme-owed.md (28bc61377, 654098cc1, d70b0d2eb) were removed in 3f71b2d491 and 856e8f21da; regression: `tests/hygiene-conflict-markers.test.js`.

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

- Fixed 2026-11-11 (lane L4): `Ripples.readFrame` marked a read pending before its staging allocation, so a refused `createBuffer` left every later read refused as pending. The flag is now set once the buffer exists. Regression: `packages/water/test/ripples.test.js` "a read whose buffer allocation fails leaves no read pending".

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


Fixed 2026-11-11 (KB5545b): Batch 198 compass spin at the Top pole under a CameraProjection kept projection.up, so the image did not turn. A drag on the cube or its compass now turns the projection's vertical up to the heading it reached (rolled as the view is); clicks, named views and quarter rolls still leave it alone. Regression: packages/viewcube/test/compass.test.js (KB5545b case).
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

Fixed 2026-11-11 (bug sweep L5): removing or corrupting decomp-kernel.wasm, or a CSP that denies its compilation, exposed a raw filesystem error or CompileError. load() in decomp.ts now wraps every read, fetch, compile and link failure as a `failed` MargoError with the original kept as `cause`; an abort stays an AbortError. Regression: packages/compute/tests/decomp.test.js "decomp Wasm read and compile failures reject as coded MargoErrors".
Fixed batch 270 GPU gate registration: new parity checks ran only by hand because the vfx test:gpu manifest still listed its original five scripts. Added native and compatibility parity.mjs --all commands. Regression: packages/vfx/test/gpu-registration.test.js fails with the previous manifest (zero parity commands), and passes with both backend commands.
Batch 184 fur: fixed the new coarsest-stack sampling defect before landing. Sampling the outer shell at normalized height 1 made two-shell fur's only outer sample empty, because every procedural strand tapers before height 1. Shells now sample k/shells; CPU and native/compat 1x/4x GPU regressions require a nonempty two-shell result. The caster output regression also checks a comma before the added UV varying, for input structs with no trailing comma. Existing unrelated wireframe compatibility findings remain tracked under rules 21/22.
Batch 184 generated aliases: umbrella regeneration also supplies the missing post/mask alias for the already landed post entry; it is a generated facade and manifest mapping only.

Fixed 2026-11-11 (KB5588b, sweep L2): the fur caster record now moves on top of the material's own displacementMap record (built-material passes it to `caster`), in the shadow, contact-shadow, selection and depth passes alike, and it carries TAA's velocity patch: the same move and strand cut, with the move run again on last frame's fur block (TAA's `move`/`program` contract), so wind has motion vectors. The record is kept while unchanged instead of rebuilt per read. Regression: packages/materials/tests/fur.test.js (displaced caster, TAA graph and before-move WGSL) and packages/materials/test/fur-browser.mjs (displaced shells with Shadows and TAA with advancing wind, native and compatibility, 1x and 4x, no GPU errors). Original entry: Fur follow-up integration, outside the completed shell-controls row: combining an inherited displacementMap with FurMaterial and Shadows applies that map in beauty but not the custom caster, because the custom caster takes precedence over the ordinary map displacement. Fur also has no custom TAA velocity hook yet; TAA currently assumes a texture-displacement layout when that hook is absent, so the optional TAA combination is unsupported until its adapter is composed. Repro: createFur with displacementMap plus Shadows, or attach TAA while advancing wind time. Preserve shell controls and the existing exact-reset regressions while composing those optional hooks in the fix phase.


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
- Fixed 2026-11-11 (KB5588c): bindSelection on a scatter or line hid the layer and drew its marks through sciviz's own mask renderer (round points, plain segments), so eye-dome lighting, per-point sizes, square shapes, sphere shading, widths and dashes were lost, and toSVG/exportVector enumerated the original unmasked marks (exportVector even dropped the hidden source). Cause: the selection mask lived in a drawable separate from the points and lines plugins and both exporters. @margoengine/points (`PointCloud.setMask`/`updateMask`/`setMaskStyle`/`isSelected`) and @margoengine/lines (`Line.setMask` and the same methods) now take a native selection mask, one bit a point after a 16-byte style header (packages/shared/selection-mask.js), applied in their vertex shaders (fade, highlight or filter on the displayed sRGB colour, the highlight given as a linear `[r, g, b]`; filtered marks are not pickable); bindSelection feeds it, and toSVG and exportVector apply it with the same maths (the shared `maskColor` in packages/shared/selection-mask.js). Bars and histograms keep their f32 mask drawable and both exports now apply it too. The 2M-point stars binding uploads 250,016 bytes a selection instead of 8,000,000. Regressions: packages/sciviz/tests/link-browser.mjs (a bound EDL square scatter with per-point sizes and a dashed line draw byte-identical to unbound with nothing selected, and the SVG fades exactly the unselected points and keeps only the selected segment; failed on the parent at the first check), packages/points/tests/mask.test.js, packages/lines/tests/mask.test.js.
Batch 174 landing repair, closed: main 72642362b duplicated the VFX test:gpu property without a separating comma, blocking all workspace parsing. Removed the obsolete member, retaining both parity backends. Regression: tests/package-exports.test.js.
Fixed 2026-11-11 (batch 174 follow-up): the lazily materialized rowIds of the most recent SelectionStore change event read empty after dispose(), because disposal cleared the Set the event had captured. Disposal now replaces that set instead of clearing it. Regression: packages/sciviz/tests/link.test.js (rows after dispose, fixed and open stores).
Batch 186 job 2: no open correctness defect found in shared atlas packing/filtering. Whole-atlas redraw on any dirty face and discrete resolution changes without hysteresis are documented trade-offs in limits.md; incremental dirty-tile updates remain later quality work.



## Batch 136 encoder boundary

No new open correctness defect in the implemented encoder is known from its current fixtures. Normal quantization at one bit is not a representable octahedral format and returns RangeError; the new encoder's 30-bit path is covered without invoking the upstream build that aborts on that option. Universal compression dominance and end-to-end timing are not established by finite corpus tests; the remaining proof and deferred speed rows are recorded in limits.md and the work lists.
- Fixed 2026-11-11 (bug sweep L3b, KB5641a): Batch 191 optional normal-provider reconfiguration. Repro: attach Pixelate or Curvature with {normal: () => texture}, then delete effect.options.normal and render; normal highlights/curvature disappeared. Cause: only setup chose between the supplied and the owned normals, and frame cannot add the owned SceneTargets (the frame graph refuses new passes while it runs). Fix: both effects check in onPreUpdate, which the engine runs before the graph, and attach the owned capture once the provider is gone; nothing changes per frame while a provider is set. Regression: packages/post/test/pixelate.test.js and packages/post/test/curvature.test.js ("provider is deleted mid-run").


## Batch 178 vector publication
No known depth-order, clipping, committed-readback or cancellation defect remains in the tested contract. Appearance refinements (lighting, procedural contour/grid ink and non-pixel series styles) are explicit accepted limits in docs/sciviz-vector-export.md and are tracked in the private finish-phase handoff.
Fixed 2026-11-10: Batch 178 gate discovery finding. Current complete GPU plan passes browser registration and chain validation; original repairs: f235e21f0. Regression: tests/gpu-browser-registration.test.js and tests/modern-extension-suite.test.js.
## Batch 176 job 1
No unresolved defect found in the implemented dataset contract. Exact curved-cell filtering and adaptive error-controlled tessellation are not claimed; the input is explicitly normalized at a caller-controlled refinement level. Invalid or over-budget topology rejects rather than silently losing cells. The remaining batch format, AMR, tensor and molecule jobs are separate unbuilt jobs, not known bugs in this entry.

Fixed during batch 176 job 1: the existing formats GPU leaf wrote test-results/sciviz-fixes/formats-gpu.json without creating its parent directory, so a fresh worktree failed after all GPU assertions passed. The leaf now creates its own output directory; its normal run is the fresh-worktree regression. No browser lifecycle or shutdown code changed.

Fixed 2026-11-11 (bug sweep L2, KB5650a): legacy parseVTKXML mislabelled mixed PolyData triangleCells; it now reads Verts, Lines, Polys, then Strips, VTK's cell order. Regression: packages/loaders/tests/vtk-xml.test.js. Original entry: Repro: one Vert, one Line, one polygon on point IDs 0/1/2 and one strip on 3/4/5 yields indices [3,4,5,0,1,2] and triangleCells [2,3], but VTK cell order requires [3,2]. Cause: its eager parser visits Strips before Polys. The new datasets adapter uses the correct vertices/lines/polygons/strips order. Repair the older eager API in the fix phase under rule 21.
### Fixed: batch 217 API summary umbrella row

The lane rebase helper counted only @margoengine rows when rebuilding the shared API summary, omitting margoengine kits from its header. The next full api:update regenerates the header and table from emitted declarations, and api:check requires exact agreement. No public implementation changed; future shared-doc merges include the umbrella row before the normal generated check.

Batch 177 job 2: no open correctness defect after statistical formula, missing-step, constant-axis, input-code and hash regressions. LOESS confidence coverage is an explicitly approximate conditional model, documented in limits.md; simultaneous/prediction intervals are outside this job's mean-band claim. NASA live TAP returned HTTP 503 on both official hosts; the demo's pinned public table snapshot avoids a runtime network dependency and records its date and source.
Fixed 2026-11-10: Outside batch 175. Current complete GPU plan passes browser registration and chain validation; original repairs: f235e21f0. Regression: tests/gpu-browser-registration.test.js and tests/modern-extension-suite.test.js.

### Batch 195 job 2 discovery: legacy feature-scaler compatibility suite deadline

Repro: `MARGO_COMPAT=1` then `node packages/quality/test/features-browser.mjs` under the shared GPU lock. On this busy A6000, the existing 120-second watchdog expires. Diagnostic progress completes all original per-knob pixel checks and the 120-frame lowering phase, then expires in the 400-frame raising phase. The old fixture renders the full Shadows/SSAO/VolumetricFog stack for 523 queue-completed frames in addition to its captures; the compatibility workload exceeds its fixed fixture deadline. This is not a deadlocked new knob or a failed value assertion. Native package suite passes, and the new knobs-browser.mjs passes all dimensions, pixel, particle-count and actual MSAA assertions on both backends. Keep the legacy workload and deadline unchanged for the fix phase (lane rules 21/22); no speed or busy-retest waiver is claimed and no assertion is skipped or weakened. Diagnostic log: lane Z test-results/lane195-features-diagnose.log. Investigate the compatibility stack's per-frame work and redundant capture pipeline construction. New optional knobs do not modify that stack.


- Fixed, lane S prefiltered IBL metadata overflow (2026-11-10): encodePrefilteredIBL checks the complete KTX2 key/value byte count, including the length word, key and padding, before accessing source mips or allocating output. The validated full source chain is sized from its dimensions; edges 8192/16384 cannot fit the u32 field and throw RangeError. The dimension-only regression in packages/environment/tests/prefiltered.test.js fails on the parent without allocating large fixtures, also checking that a 4096-edge source reaches ordinary mip validation. Existing bit-exact round trips and malformed-file checks remain intact.

Fixed 2026-11-10: batch 201 AudioListener direct disposal registration. A registered listener now delegates to its owning Scene.removePlugin, which releases its name and frame passes before calling the existing resource teardown. Same-name replacement works immediately, stale handles retain replacement ownership, and another scene's same-name listener remains attached. Regression: packages/audio/tests/audio.test.js has two cases that fail on the parent; listener-disposal-browser.mjs checks the real engine on native WebGPU and WebGL2. Engine-driven cleanup and lazy audio-context creation are preserved; core is unchanged.
Fixed 2026-11-11 (bug sweep L2, KB5663b; regression packages/gltf-pro/tests/dds.test.js): textureSource names the malformed extension. Original entry: Batch 201 DDS follow-up: malformed MSFT_texture_dds extension shapes reject correctly but textureSource's shared validation message names KHR_texture_basisu; reproduce with a non-object DDS extension value. Valid DDS loading is unaffected. Correct the diagnostic in the fix phase.


Batch 136 replacement proof: the geometric-normal unsigned-residue scoring defect is fixed with circular-distance and complete-payload selection; the sparse high-precision RAW cutoff is expanded within a fixed memory bound. Rust regressions and the 76-row two-decoder corpus pass with no open defect found in this scope.
Fixed 2026-11-10: Build-phase follow-up. notice regeneration preserves appended asset credits (8b508ad02). tests/supply-chain.test.js checks retained addenda, idempotence and current generated notices.

- Fix-phase investigation, existing sciviz glyph capture: glyph-browser.mjs produced too few compatibility pixels once for custom and once for line shapes in the batch 173 gate. Instrumented failures retain image/canvas/stats now; isolated and full diagnostic runs then matched native output exactly (line 151 pixels, custom 3158), and the original assertions with failure diagnostics pass both backends. Root cause remains unisolated, so this is not claimed as a fix or a timing-only miss. Logs stay in lane-X git-excluded batch173/job5/{gpu-glyph-browser.mjs,final-gpu-glyph,glyph-failure-data,glyph-diagnostic}.log. Investigate cold command replay/capture state without retries or lowered pixel bars. Closed 2026-11-11 (KB5663c, with KB5700d) as not reproduced: the unchanged suite (`node packages/sciviz/scripts/browser-root.mjs tests/glyph-browser.mjs`, both backends, a fresh browser each run) passed 10 of 10 cold runs and 30 of 30 runs under GPU load with 3 to 5 other gpu-lock holders active (check-owner-lifetime, gpu-packages, sweep-l2, sweep-l3, sweep-l5, check-readme-run, core34); every run gave line 151 lit pixels (hash 1716337270) and custom 3158 on WebGPU and WebGL2. No test or bar changed; a recurrence reopens it with the retained failure diagnostics.
Batch 186 job 3: no open correctness defect found in cube projection or mixed spot/cube ownership. Filtering is the supplied-image bilinear contract; mipmapped minification and HDR inputs remain documented later quality extensions, not asserted here.

Batch 186 job 3 regression: toggling cubes while spot images keep the shared hook active now invalidates cached shader declarations and bind layouts. The CPU regression fails on the pre-fix build, and live removal/reactivation is checked on both GPU backends.

Fixed 2026-11-11 (bug sweep L3b, KB5663d): Batch 186 composition follow-up: all three clustered list buffers plus rectangle, shape, directional, IES, spot-cookie and cube-cookie storage totalled nine fragment storage bindings, above the minimum WebGPU device limit of eight. Repro: activate all those optional hooks together on a default-limits device. Cause: cube cookies kept a separate pixel buffer (binding 152) beside spot storage, even for cube-only lists. Fix: the cube block now follows the spot words in the one projector buffer (binding 143), whose header word 2 names where it starts; the upload stays one pass, so all hooks together take eight fragment storage bindings. Regression: packages/clustered/test/cube-projector.test.js ("one fragment storage binding") and the pixel check scripts/clustered-cube-projector-gpu.mjs.




Batch 180 job 1: no open defect found in the view/cache/height contract. XYZ source polar coverage, conservative visibility and native-preview refusal are recorded limits; geo-lod.test.js and geo-lod-browser.mjs cover this entry.

Fixed 2026-11-10: GPU package-runner owner collision (batch 180). Unrelated worktrees previously shared the generic check owner and were serialized despite free slots. Both serial and parallel admission now use a stable digest of canonical worktree identity, retaining one slot per worktree and distinct suite labels. Regression: tests/gpu-suite-owner.test.js reproduces the parent runner collision with CPU-only admission and checks independent owners; scheduler policy and GPU assertions are unchanged.

Batch 136 removal landing blocker fixed: supply-chain regeneration previously replaced the whole notices file and discarded appended asset credits. Explicit retained addenda, legacy-boundary migration, unknown-boundary rejection and an idempotence/stale-generated-content regression preserve them. No remaining blocker in this scope.
Fixed 2026-11-10: Build-phase follow-up (batch 177 job 3). notice regeneration preserves appended asset credits (8b508ad02). tests/supply-chain.test.js checks retained addenda, idempotence and current generated notices.

Fixed 2026-11-11 (bug sweep L5): Module.stateDict() and Tensor.read() in compute/nn took no options, so a large state readback could not be cancelled. Tensor.read(options) forwards ReadOptions; stateDict({ signal }) passes the signal to every parameter read and nested module, BatchNorm running statistics included. Regression: packages/compute/tests/nn.test.js "stateDict and Tensor.read forward an AbortSignal through nested modules".
### Fixed: batch 1 umbrella package test discovery

The original fourteen packages were repaired by 68b55c2ed. The later umbrella package added tests/export-order.test.js without scripts.test, reproducing the same class: node --test tests/package-test-scripts.test.js reported the missing file. Its manifest now runs every tests/*.test.js file. Existing regression: tests/package-test-scripts.test.js, which failed before the manifest change.

The rebased cube-projector alias was appended after the umbrella kits, failing the existing generated-manifest and package export-order checks. Running scripts/umbrella.mjs restores its owning package position without changing the export set.
## Batch 178 PDF and math
No open correctness defect in the documented TeX subset or figure-SVG PDF contract after CPU, both-backend browser and independent MuPDF checks. Font-specific math spacing and variant glyph assembly are accepted appearance differences, tracked in the private finish-phase handoff.


Batch 175 job 2 source-data defect: USGS IA_FullState/ept-data/0-0-0-0.laz first GPS time is -4.799510766208031e194 (implausible). Repro: parseLAS of the archived original, point 0. Cause: identical bits in the uncompressed seed record of the producer file; independent laspy 2.7.0/lazrs 0.8.2 agrees on every decoded record. Preserve original values; use intensity/classification/elevation for this demo, not GPS-time analysis.

Fixed 2026-11-10: points/octree concurrency validation (batch 175 job 2). OctreeCloud now rejects maxConcurrentLoads unless it is a positive safe integer, before allocating its material. Undefined keeps the existing default of four; wrong types throw TypeError and invalid numeric values throw RangeError with a help link. Regression: packages/points/tests/octree.test.js fails on the unchecked parent at zero and verifies actual scheduling of one, four and eight child loads. Selection, sampling, point budgets and rendering work are unchanged.
Batch 177 job 4: no open correctness defect in the checked chart presentation paths. A pre-existing sciviz test:browser:fallback manifest command bypassed browser-root and failed its package-root regression; it now follows the same adapter as the other package browser commands. Legend interaction is layered above inset canvases, preventing an inset from intercepting its clicks. Native hidden traces are excluded from picks, selection and SVG, as checked by the new browser regression.


API conventions lane (2026-11-10): unchanged materials dispersion compatibility reproduces the tracked 4x live-reset error 0.000244140625 against 0; native passes 278 checks/254 captures. The changed optional Fur.attach entry is never imported by this fixture, whose materials root is unchanged. Retain the existing fix-phase item under rules 21/22 without a tolerance or renderer change.
- Fixed 2026-11-11 (KB5700a): opacity 1 in the scalar, bricked, multi-volume, quality and curvilinear marches stayed partly transparent when the per-step length was a tiny fraction of the reference (curvilinear referenceStep 1000, or density 1e-4), because the opacity correction capped alpha first (log of max(1 - a, 1e-6), or a clamp to 0.999999). Opacity 1 is infinite extinction, so each march now takes alpha exactly 1 for any positive step (density 0 stays clear); GPU picking does the same, so `opacityThreshold: 1` finds an opacity-1 voxel. Regressions: packages/sciviz/tests/volume-physics-browser.mjs case 8, curvilinear-browser.mjs `opaque`, bricks-browser.js, pick-gpu-browser.mjs.
- Fixed 2026-11-11 (KB5700b): curvilinear physical metrics: scale a unit cube and referenceStep together by 1e20 or 1e-20, with matching figure limits. Its raw physical length(d*span) squared overflowed or underflowed float32 before the opacity correction (1e20 drew fully opaque). The march now measures lengths and the reference in units of the longest box side, as the tetrahedral and AMR entries already did. Regression: packages/sciviz/tests/curvilinear-browser.mjs `scaled` (both scales match the unit cube within 1 of 255).


- Fixed 2026-11-11 (KB5700c, batch 174 multivariate brush history): after two axis brushes and SelectionStore.undo the controller kept its last range map, so the next axis gesture reapplied the undone range. SelectionStore brushes now carry an optional `predicate` kept through undo, redo, toJSON and fromJSON; parallel coordinates and scatter matrices store their ranges there and rebuild them on every store change. Regressions: packages/sciviz/tests/link.test.js (predicate history), parcoords-browser.mjs (period, radius, undo, then period).
Batch 180 gate finding, existing glyph capture: node packages/sciviz/tests/glyph-browser.mjs once failed the unchanged >20 lit-pixel assertion for the thin line glyph on WebGL2 after shape replacement. Native had 151 pixels; subsequent unchanged assertions on both backends had exactly 151 and identical hashes. Cause is not isolated: the captured shape-transition frame lost expected thin-tube coverage; this is a value/capture nondeterminism, not a timing-only budget miss. No test threshold changed. Preserve the diagnostic and investigate readiness/resize/capture ordering in the glyph owner during the fix phase. Closed 2026-11-11 (KB5700d) as not reproduced: 40 unchanged runs (10 cold, 30 under GPU load with 3 to 5 other gpu-lock holders) all gave line 151 pixels with identical hashes on both backends; see the KB5663c entry above.
Batch 180 job 2: no open correctness defect in the requested vector-geography contract. Future near-plane ribbons and runtime style mutation are documented quality follow-ups. The fallback and newly rebased engineering/pointcloud browser scripts gained the same repository-root bootstrap as other sciviz browser scripts; existing browser-root.test.js caught the missing registrations.
Fixed upstream: batch 183 navmesh package-directory bundle probes. e295cc68a anchors both pipeline inputs with fileURLToPath(new URL('../src/pipeline.ts', import.meta.url)); 3296cce94 creates their repository-anchored output directory and 6ede7aa75 removes duplicate imports. Rechecked 2026-11-10: all 121 unchanged navmesh CPU tests pass from packages/navmesh, including border and SIMD probes. No navigation algorithm or assertion changed in this sweep.
Batch 183 gate finding (fixed 2026-11-11 by 38e03b1187): the sciviz package-local `npm test` lacked `--experimental-test-module-mocks` although tests/pointcloud.test.js calls mock.module. The package test script now passes the flag.
Fixed batch 180 landing integration: the generated margoengine/sciviz/monitor alias was present in the working tree but omitted by tracked-only staging while its generated manifest mapping was committed. A clean checkout could not build that entry. The generated source is now committed. The new packages/margoengine/tests/export-order.test.js index-membership regression catches this class even when an unstaged generated source exists locally; it runs in the normal merge CPU suite. Existing tests/umbrella.test.js also checks complete generator output and every runtime alias.

Batch 179 state capture: default MSAA transparent rendering is not self-bit-stable (Aeroflow repeated unchanged captures differed in 14 of 3042432 bytes by one level on this GPU); the same source scene varies while serialized resources, limits and camera are identical; the renderer cause remains to isolate. ExactSize round-trip proofs remain exact. Default-MSAA bit identity is retained for the rendering fix phase; no core change is made.

Fixed 2026-11-11 (2413bb2901): quality scanner race. Running quality alongside React subpath tests could list then read a temporary .subpaths-* fixture after the test deleted it, yielding ENOENT in clean-room.js (found during batch 179, outside the state codec). The scanners now read through readRepoFile, which skips a listed file removed before the read, so the gates may run side by side. Regression: tests/quality-inventory.test.js (scanners skip a removed file).

Fixed 2026-11-11 (KB5700h): batch 179 custom colour-map quality tail: Colormap('quadratic', 'sequential', t => [t*t, 0, 0]) sampled by a CPU-coloured line at t=0.123 was restored from a 256-entry Float32 table, with interpolation error versus the original closure. Loading now takes a `colormaps` option: a registered map (or a built-in) whose name, kind and saved table all match restores as itself, exact; any other map still rebuilds from the table. Regression: packages/sciviz/tests/color-scales.test.js (KB5700h case). Original note: Cause: executable closures cannot be serialized and the table matches GPU texture sampling, not arbitrary analytic CPU sampling. Preserve exact CPU colours or a registered declarative map definition in the fix phase.
- Fixed 2026-11-11 (KB5700i): batch 178 job 3 media quality: a scatter cloud material set to world size drew its splats too small in short tiles of a perspective tiled capture (scatter.cloud.material.sizeUnits = 'world', tileSize below the image height). Cause: the points focal-length uniform (packages/points/src/frame.ts) took the tile height with the full-view fov, ignoring the cropped tile projection. It now derives pixels per world unit from the clip matrix (the y row without its share along the w row, over the w row length), as the orthographic branch already did, so cropped and off-axis projections keep their scale. Regressions: packages/points/tests/frame-scale.test.js; packages/sciviz/tests/export-media-browser.mjs (world-size splats, 64-pixel tiles against one 512-pixel tile: 0 of 1932 covered pixels differ on both backends, 1880 before).
- Fixed 2026-11-11 (found under KB5700i): a perspective 3D figure exported with exportImage or renderMediaTiles drew no layers at all (axes, scatter, lines), only the background. Cause: the tile camera rebuilt the default perspective in packages/sciviz/src/media-tiles.ts with near minus far sign-flipped from core's reversed-depth WebGPU projection, so every fragment fell outside the depth range. The tile camera now uses the core perspective of the same fov, near and far; a custom camera.project is still taken as the source camera made it. Regression: packages/sciviz/tests/export-media-browser.mjs (a perspective scatter covers 1932 pixels of the export, 0 before; in a probe the export and the live canvas held the same 2805 red marker pixels).

Batch 177 job 5: no open correctness defect in the checked live-data paths. Source cancellation covers asynchronous parse waits, including a parser that synchronously aborts its signal. A removed trace no longer appears in ChartPolish unified hover. The streaming SVG regression counts its 64 clipped data circles separately from the intentional legend swatch. Protocol fixtures close the RFC 6455 connection once; no renderer/browser shutdown code changed.

### Fixed: water query browser check rewrote a tracked record (list 3 batch 66 job 5)

packages/water/test/query.browser.mjs wrote docs/whitepaper/results/batch234-water-query-<mode>.json on every GPU run, so a landing's refresh found a tracked file changed and stopped. It now writes test-results/water-query-<mode>.json; the committed record stays as recorded. Regression: packages/water/test/results-path.test.js fails on any water browser check that writes under docs/.


### Fixed 2026-11-11: Water's own coast flow was unbounded on steep falls (list 3 batch 66 job 8)

Water's built-in surface-driven pipe drove each pipe with the full surface difference and no cap, so water over a 10 m fall reached 240 m/s (one cell per step, 1/dt at 240 steps per second) and could overshoot the Courant bound. Each coast pipe's speed is now capped at Froude 4 and at half a cell per step, the bounds water/rivers uses (`coastFlowShader` in `packages/water/src/coastal.ts`); below them coast dynamics are unchanged (flow.browser.mjs basins, surf and spray pass as before). The hydrostatically reconstructed pipe of water/rivers was tried for the coast too and refused: its weir-limited exchange did not drain the flow check's flooded basin back over its sill in 10 s. Regression: packages/water/test/rivers.test.js "Water's own coast pipe stays within the Froude and Courant bounds over the same fall".

### Fixed: water/rivers sources narrower than a cell fed nothing (list 3 batch 63 job 2)

A Rivers source with radius 0 (the default) or below half a cell, off a cell centre, had an empty footprint, so it added no water. The footprint now always includes the cell under the position (a position off the map still feeds nothing), in the shader and the float64 model. Regression: packages/water/test/rivers.test.js "a source narrower than a cell feeds the one cell under it", and a radius-0 source in rivers.browser.mjs.

Fixed 2026-11-10: review 3 P1 PixelFollow extreme finite deltas (cde120852). Smoothing preserves stationary zero-lerp axes without evaluating 1**Infinity and retains tiny positive factors through log1p/expm1. Current-main reproduction: all eight packages/pixel/tests/follow.test.js cases pass, including zero/unit/tiny lerps, Number.MIN_VALUE, Number.MAX_VALUE/60 and Number.MAX_VALUE. Accepted input ranges and integer camera positions are unchanged.

- Fixed 2026-11-11 (KB5736b): ChartPolish visibility on selection-bound marks: bind a scatter/line layer, attach polishFigure, then setVisible(layer, false); the binding still drew, because format.ts set the hidden source's visible flag rather than SelectionBinding.visible. ChartPolish now shows and hides whatever draws the layer (its binding or density replacement), and a binding starts with its source's visibility and hands it back on dispose (binding a hidden layer used to show it). Regression: packages/sciviz/tests/chart-polish-browser.mjs (bound line case).

- Existing atmosphere exact-capture defect after main merge: run SPEC_DEMOS=atmosphere SPEC_BACKENDS=webgl2 with packages/sciviz/tests/spec-demos-browser.mjs under the GPU lock. In batch174/j4-land-gpu.log, three blue-channel bytes differ by 1 (offsets 1360474, 1360478, 1365274); sameSourceDiff is also 3 for the unchanged source figure, and camera/limits match. The failure originates in repeated atmosphere compatibility drawing, rather than date/log window restoration; the particular nondeterministic draw operation is not isolated. Record for fix phase under rule 21; exact assertion is unchanged.
Batch 178 job 4: no open correctness defect in the requested colour/legend contract. Surface NaN heights still form holes because they have no geometric position; diagnostic CVD simulation makes no universal distinguishability promise. The PDF equal-stop gap and finite-first volume MIP state are covered by regression tests in the same job.

Fixed 2026-11-11 (lane L4): water browser checks run with MARGO_COMPAT=1 and no --compat argument wrote WebGL2-layer results under a webgpu name (query, caustics, fft, flow-map, reflector, ripples, rivers, underwater, bodies, rain and scatter): each read argv instead of the browser's `hardware.compat`. They now read the hardware record. Regression: `packages/water/test/results-path.test.js` fails on any water browser check that names a result or backend from argv.

Fixed upstream: batch 203 duplicate navmesh package-directory probe finding. The entry anchoring in e295cc68a, output-directory creation in 3296cce94 and import repair in 6ede7aa75 are on main. All 121 unchanged CPU tests pass from the package directory on 2026-11-10, including both affected probes.

- Fixed 2026-11-11 (bug sweep L5): Batch 203 AVIF validation tail. A 'prem' item reference with no auxiliary alpha, no or several targets, or a target other than the alpha item was read as straight alpha. image.rs now accepts only a 'prem' reference to exactly the one alpha item (ISO/IEC 23008-12 'prem' reference type; AVIF v1.1.0 section 4) and rejects every other shape as invalid. Regression: packages/decoders/native/avif/tests/premultiplied.rs.



### Fixed: batch 181 job 3 CPU point-depth tie direction

Fixed 2026-11-10: nearestPoint now compares projectPoint's normalized near=0/far=1 depth in the correct direction, preserving the existing half-pixel screen-distance tie rule. packages/sciviz/tests/pick.test.js checks a real perspective camera in both point orders and corrects the identity fixture against the same documented depth convention. Both cases fail on the parent. GPU reversed clip depth and its picking pass are unchanged.

Batch 181 job 3 gate fix: linked mask rendering suppressed original draw visibility and Figure queries excluded that visible source data. The upstream linked-draw owner protocol preserves CPU/GPU picking and brush selection, respects replacement visibility and unregisters on disposal. Regression: packages/sciviz/tests/pick-visibility.test.js plus unchanged demos-browser.mjs star brushes.

## Fixed 2026-11-11: sciviz geo-lod frames not bit-stable on native WebGPU (KB-GEO1)

Repro (RTX A6000, Edge 157 headless, native WebGPU on D3D12): `packages/sciviz/tests/geo-lod-browser.mjs` failed
"retained data restores identical pixels" in about 1 run in 6. With the view unchanged, about 1 frame in 3 changed
one level in one channel at one fixed pixel (sometimes 6 to 8 bytes), restore or not; the WebGL2 compatibility layer
was stable. Cause, as far as it is located: below the calls Margo makes. Every geo-lod tile was drawn through a
src-alpha blend. A per-frame log of every pass, pipeline, bind group, draw and buffer write (with a hash of the
bytes) was identical between frames that differed, so draw order, uploads, uniforms and restore are ruled out. The
pixel is covered once and its texel alpha is exactly 1, so the blend's result equals its source; even so, with 30
frames per variant, the flips stayed with a blend that reads the destination (src-alpha or one / one-minus-src-alpha)
and stopped with no blend or a one / zero blend; storing the MSAA colour instead of discarding it changed nothing.
Nearest filtering also stopped them, by moving the value off the rounding tie. A standalone page with the same blend
and 4x MSAA did not reproduce, so the driver or hardware mechanism is not isolated. Fix
(`packages/sciviz/src/geo-lod.ts`): a tile whose texels are all opaque, at full opacity, draws with an unblended
pipeline (it replaces what is under it, so the blend did no work); fading and translucent tiles keep the blend in the
same coarse-to-fine order. Regression test: `geo-lod-browser.mjs` renders the unchanged view 24 more times and
requires every frame byte-identical in all channels (6 of 24 frames differed before the fix), and the restore check
now compares all channels, not only red.

## Fixed 2026-11-11: compute SVD does not converge on a matrix of many repeated columns

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

Fixed (bug sweep L5): a column whose norm times the input scale is below 2^-150 (its f32 singular value is 0 in every case) is set to exactly zero, takes no more rotations and is completed orthogonally; graded columns above that floor keep every rotation (Rust test `svd_floor_keeps_graded_values_and_zeroes_only_f32_zero_columns`). The repro converges in 11 to 20 sweeps. The basis completion now picks the axis with the smallest row norm and orthogonalizes only it twice (CGS2), so the repro takes 8 s instead of 85 s on a loaded dev PC. Regression: packages/compute/tests/decomp.test.js "svd converges on a 512 x 512 matrix of many repeated columns".

Fixed 2026-11-10: review 3 SV4 transfer-binding reentrant abort. The abort listener now exists before the initial caller render callback; an already-disposed initialization cannot subscribe to later transfer changes. Failed initialization restores the previous classifier and releases listeners, with both errors retained if restoration also fails. Regression: packages/sciviz/tests/transfer.test.js covers initial synchronous abort, throwing render callbacks and failed restoration; all three fail on the parent. Default LUT work, numerical transfer tests and rendering bounds are unchanged.


- Closed 2026-11-11 (batch 120 incidental gate finding, base 2ed6fd460): tests/check-fixed-waits.test.js flagged the 90-frame loop in packages/biomes/tests/water-check.html. The loop is not a readiness wait: it steps the river flow 3 s (90 frames of 1/30 s) after `view.ready`, `whenIdle` and `waitForPipelines`. The checker now resolves the frame helper and reads a delta that steps time as simulation (scripts/check-fixed-waits.mjs), so the page is not flagged. Regression: tests/check-fixed-waits.test.js "a counted loop through a frame helper that steps time is not a wait; the same helper at delta 0 is".
Batch 176 job 4: no open defect found in the supported Cartesian cell-centred AMR contract. Format extensions, block-edge reconstruction and explicit sample/index budgets are documented in limits.md; refinements remain on the private finish-later list.

Fixed 2026-11-10: Batch 176 inspection. GPU planner registrations and command ordering are repaired on main (30c8a02db). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.
- Fixed 2026-11-11 (KB5765c, batch 174 annotation keyboard focus): Annotations.render rebuilt every SVG child on each engine frame, so a focused handle lost focus. Render now skips the rebuild when the markup is unchanged and, when it does change, focuses the same handle of the same record. Regression: packages/sciviz/tests/annotate-browser.mjs (unchanged frames keep the element; a moved handle is refocused).


- Batch 120 path audit: public npm create margo@latest still reaches the prerelease placeholder until Scott authorizes publication; cause is intentionally pending registry release. The actual create/install/build/frame path is proven against the private packed registry.
- Batch 120 path audit: a browser without WebGPU needs an explicit @margoengine/webgl2-compat install, one extra step compared with a bundled WebGL renderer. Cause is the deliberate optional backend boundary; documentation and both kit-backend checks cover it, while reducing the extra setup remains a release UX decision.
- Batch 120 incidental documentation gate, base b4404cddb: node --test tests/from-threejs-snippets.test.js flags docs/guides/react-test-offscreen.md because it has no ts fence recognized by the snippet harness. All changed kit/import/migration guide snippets pass; the React guide/harness mismatch is fixed (2026-11-11): docs/guides/react-test-offscreen.md carries a ts fence the harness recognizes, and the same test passes.

### Fixed: ANGLE D3D11 flipped blit left the next draws' fragment uniform blocks reading zero (batch 166 job 2)

- **Symptom:** on the WebGL2 layer under Chrome's default ANGLE D3D11 backend (RTX A6000), the 50,000-box frame of
  `packages/materials/test/vertex-inputs.html?bench` drew every box black, coverage intact, in about 35 of 100 page
  loads with batch 166 job 2's vertex fetch cuts, and in about 7 of 100 with origin/main's code once Chrome's program
  cache was off (`--disable-gpu-program-cache --disable-gpu-shader-disk-cache`, as on a first visit). Native WebGPU and
  ANGLE Vulkan never did it.
- **Not Margo's GL state:** a recorder of every WebGL2 call with its payload bytes showed good and black loads issuing
  the same 389 calls with byte-identical data; they differ only in how many times the layer polled a fence. Redrawing
  the same draw from the same state after a black frame came out right. A changed fragment shader showed the fragment
  stage's uniform blocks reading zero while varyings and the vertex stage's reads of the same binding were correct.
- **Below Margo:** replaying the recorded calls on a bare WebGL2 context, no Margo code loaded
  (kept outside the repository in lane A's `.lane/`: `b166hunt-gl.js` recorder and replayer, `b166hunt-rr.mjs` with `MODE=record` or `MODE=replay`, recordings `b166hunt/rec-*.json`; program cache off): the job 2 stream drew black
  in 6 to 7 of 15 replays, origin/main's stream in 5 of 20, and the job 2 stream on ANGLE Vulkan in 0 of 20. Edits of
  the replayed stream: changing only the present's y-flipped `blitFramebuffer` into an unflipped one gave 0 of 20;
  binding either uniform range again before each draw gave 0 of 15; leaving out the two programs that were linked but
  never drawn gave 0 of 15; resolving every link at once, clearing without the scissor, dropping
  `invalidateFramebuffer` or giving the vertex blocks their own binding points did not help. So after the flipped
  blit, which ANGLE's D3D11 backend makes with shaders and constant buffers of its own, a later draw that changes no
  uniform binding sometimes runs with its fragment constant buffers unbound. Whether ANGLE or the NVIDIA D3D11 driver
  owns the lost binding is not settled; it needs a report to ANGLE with the replay.
- **Fix in the layer:** the canvas present no longer blits. `Replayer.presentTexture` draws a full-target triangle of
  the layer's own that fetches one texel a pixel, flipped in the shader, and writes alpha 1 for an opaque canvas
  instead of a colour-masked clear (also a shader path in ANGLE D3D11). The copy is exact. Regression tests:
  `packages/webgl2-compat/test/canvas-present.test.js` (no blit, no clear, one helper draw, fails before the fix) and
  `packages/webgl2-compat/test/present-uniforms-browser.mjs` (12 cold-cache loads of the 50,000-box frame, all lit and
  identical; before the fix load 7 drew black). After the fix, real page: job 2 0 of 20 with the cache and 0 of 20
  without it, origin/main's code 0 of 20 without it.

### Open: ANGLE D3D11 returns two versions of the same MSAA-resolved HDR texture (compat dispersion live reset; sciviz geo-lod restore; likely the atmosphere same-source byte)

Platform defect below the compatibility layer, proven at the WebGL call level (bug hunt, 2026-11-10). No exact workaround exists inside `@margoengine/webgl2-compat`, so the exact assertions stay unchanged and open.

- Repro: `node scripts/material-dispersion-gpu-check.js --backend=compat` on the RTX A6000 under Chrome's default ANGLE D3D11 backend. Failure 9 (4x live positive-to-zero reset, 10 HDR channels, max 0.000244140625) reproduced on the first run. With six unchanged `live(0)` frames added after the reset, 9 of 9 full-grid runs reached the same second image ("alt"). Every time it differed from the constructor-zero image ("base") in the same 10 channels, each by one float16 step. Most of those pixels lie outside the transmissive quad, where only the opaque background and the final 4x resolve touch them. 1x stays exact.
- Proof that the layer issues identical work: a WebGL2 call recorder (each call's name, object identity and payload FNV hash) shows that consecutive unchanged frames issue byte-identical WebGL2 command streams, yet one frame returns base and the next returns alt. Each frame clears or fully overwrites every attachment it reads, and the opaque-only resolve and its level-0 copy hash identically in every frame. A direct `readPixels` of the resolve target's framebuffer, issued with no WebGL call between it and the layer's own fenced pixel-buffer readback, returned the other version (base, then alt, and in another run alt, then base). Once settled, 30 rereads 20 ms apart agree. So one texture yields two contents with no command in between, which breaks the repeatability rule of the OpenGL ES 3.0 specification, Appendix A.1.
- Ruled out: uniform staleness (the only stream difference between the reset frame and the next is the 4-byte dispersion write; the other frames are identical); invalidateFramebuffer (patching it to a no-op still gives alt in 2 of 2 runs); readback row layout (both reads are tightly packed RGBA float); shader compile variants inside the layer (programs are identical objects across the compared frames); engine timing state (the stream diff is empty). Raw WebGL2 pages without engine code (a UBO-driven refract shader; a 4x RGBA16F renderbuffer resolve with 3,000 edge triangles, with and without invalidate; 300 frames each) did not reproduce it, so the trigger also needs the full grid's earlier resource churn.
- Backend check: the same probe on ANGLE Vulkan with the same NVIDIA GPU (`BROWSER_ARGS='["--use-angle=vulkan"]'`) was exact in 2 of 2 runs (reset and six extras). ANGLE OpenGL fell back to SwiftShader and was refused. This puts the defect in ANGLE's D3D11 backend or the NVIDIA D3D11 driver. Native WebGPU (D3D12) passes all 278 checks.
- Atmosphere (`SPEC_DEMOS=atmosphere SPEC_BACKENDS=webgl2 node packages/sciviz/tests/spec-demos-browser.mjs`, and the zero-cloud hash in `atmosphere-browser.mjs`): this did not reproduce here. One full spec-demo run, 8 repeats, 6 page loads of 4 repeats and 2 parallel probes of 5 loads of 3 repeats all gave byte-identical captures. The earlier failures signed the same way (one-step differences on unchanged source, under the shared GPU queue), but the cause there is not proven. Treat it as the same open item until a failing run is captured with the recorder.
- Sciviz geo-lod (`packages/sciviz/tests/geo-lod-browser.mjs` line 85, `retained data restores identical pixels`, max difference 1): same defect, on an 8-bit 4x resolve. On plain main 5329898ca it failed 1 of 4 test runs. A probe that captures the refined globe four times with no restore, then restores the layer six times with two captures each, showed one-level flips in 4 of 6 page loads under D3D11. They show up just as often between two unchanged captures with no restore as after a restore, so `layer.restore()` is not the cause. Each frame clears, issues 16 tile draws, resolves the 4x target with blitFramebuffer, flips it with a second blit and reads it back. The recorder (per-capture object ids renamed in creation order, sync polling dropped) shows two consecutive unchanged captures with byte-identical streams up to and including the readback. Only the bytes read back differ, in 46 channels by one level. Under ANGLE Vulkan on the same RTX A6000, 6 page loads gave 90 captures and every one was exact. Native WebGPU (D3D12) also flipped one green channel at pixel (313, 57) by one level in 3 of 3 loads. The test compares only the red channel, so native passes. This suggests the NVIDIA D3D resolve path rather than ANGLE alone, but it is not proven. Probes: `geo-lod-probe-browser.mjs` (run from a worktree's `.lane/` through `scripts/gpu-lock.mjs run`; `PROBE_BACKENDS`, `PROBE_LOADS`, `PROBE_ROUNDS`, `PROBE_REC=1` for the recorder), `geo-lod-norm.cjs` and `geo-lod-ndiff.cjs` (stream grouping and diff), `geo-lod-streams-d3d11.json` (failing load; compare after2 with after3), and the D3D11 and Vulkan logs. The exact assertion stays unchanged; the job that hits it changed no geo-lod or compat source.
- Probes (git-excluded, in the main checkout): `handoffs/compat-determinism-probes/` in the git-excluded work folder holds `disp-probe.js` (the grid with recorder, extra frames, direct reads, attachment map and `PROBE_NOINVALIDATE`), `gl-recorder.js`, `diffstreams.cjs`, the raw pages and one failing stream capture.
- Batch 164 SSAO resolve control (2026-11-10): `node packages/post/test/ssao-resolve-browser.mjs` with `MARGO_COMPAT=1` fails default ANGLE D3D11 exact pixels after odd-size 4x resize (59 channels, max two display levels). Its three unchanged historical-control frames also vary by the same 59 channels and two levels; native and ANGLE Vulkan (`BROWSER_ARGS=["--use-angle=vulkan"]`) pass all 12 pairs. This is consistent with the recorded D3D resolve defect above, but this fixture still needs a raw GL command replay to isolate the cause. Control evidence: `test-results/bp164-compat-diagnostic.log`; native `bp164-ssao-pixels.log` and actual Vulkan `bp164-compat-vulkan-real.log` (the earlier `bp164-compat-vulkan.log` did not forward the backend argument and is not Vulkan evidence). Under Scott's 2026-11-10 control-variance ruling, D3D11 cannot prove or disprove this change's identical output; the exact native and Vulkan checks supply that proof. The original exact test and assertion remain unchanged. This is a landing exception, not a repaired driver claim.

- Next step: report to ANGLE/NVIDIA with a self-contained replay of the recorded session (full payloads, not hashes). Until then this stays a release blocker for exact compat captures on Windows D3D11. Never raise the bound for it.


Fixed 2026-11-10: Batch 181 gate observation. GPU planner registrations and command ordering are repaired on main (30c8a02db). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.


Fixed 2026-11-10: Batch 180 job 5 incidental gate finding (base b4404cddb). GPU planner registrations and command ordering are repaired on main (30c8a02db). Current plan() and tests/gpu-browser-registration.test.js plus modern-extension-suite.test.js pass without omitting any browser leaf.

Fixed 2026-11-10: batch 180 job 5 stale legend visibility. The legend root now retains native block display, so its hidden attribute removes it from rendering when fewer named layers remain. Row margins and title spacing retain the existing three-pixel separation. Regression: packages/sciviz/tests/legend.test.js fails on the old inline grid override; spec-browser.mjs reproduces two named heatmaps, removal to one, reappearance with current labels and exact row spacing on both backends. Existing fixture layers and pixel assertions remain intact.

Batch 181 job 4 fixed before landing: density scatter replacement must retain the source's original visibility across native updateData cloud replacement, including when the replacement is hidden and disposed before its next frame. Cause: capturing the new cloud's logical replacement visibility overwrote the original source visibility, and disposal could still address the old cloud. Regression: packages/sciviz/tests/density.test.js, hidden replacement before/after preparation. All source votes and analytical counts are unaffected.

Batch 274 job 6: no open correctness defect found in signed int8 matmul/Conv2d.
Conservative accumulator limits and f32 rescale error bounds are documented in
docs/compute-quant.md; independent float-reference cases cover CPU and both GPU backends.

Batch 175 job 5: no open defect found in the built graph-gpu paths. The straight-edge zero-subdivision u32 underflow is fixed in the owning optional shader and covered by the invisible-first-edge GPU regression; figure dimensionality, both force references, bundling boundaries, labels and device routes are checked. Float32 precision, concentrated-leaf costs, FDEB quadratic pair work and explicit label snapshot refresh remain documented limits.
Batch 180 job 4: no open correctness defect found in the implemented climate/projection paths. CF coverage and interpolation domains are explicit in docs/limits.md. Outside this job: openCloudZarr rejected valid rank-zero scalar arrays (shape/chunks []); repro public IPSL tas height/.zarray at the climate source URL, cause dimension-count validation required a nonempty shape. Fixed 2026-11-11 (KB5822b): the cloud Zarr store accepts empty chunk shapes for rank-zero v2 and v3 arrays (key "0" or "c"); volume formats keep requiring three dimensions. Regression: packages/sciviz/tests/omezarr.test.js (rank-zero case). The offline data curation reads those uncompressed scalar coordinate bytes directly; CF reads the resulting NetCDF scalar without this restriction. Rule 21 leaves broader Cloud Zarr scalar support to its owner.
Batch 180 job 4 GPU observation (2026-11-10): the existing atmosphere spec demo reproduced the recorded ANGLE D3D11 nondeterminism under the shared queue: 50 bytes differed, including 50 between two unchanged source captures (test-results/batch180-job4-gpu-all.log). No CF/projection scene failed. The unchanged atmosphere/surface/volume/points spec assertions are exact on the documented ANGLE Vulkan backend (test-results/batch180-job4-gpu-remaining.log). D3D11 remains the existing release blocker above; this is not a repaired driver claim or a widened pixel bound.

- Batch 175 job 4 landing gate: the unchanged geo-lod exact restoration assertion observed one-level differences, 1 native channel and 46 WebGL2 channels. This matches the documented ANGLE D3D11/NVIDIA resolve defect above and Scott's 2026-11-10 landing exception. The test and assertion remain unchanged. Evidence: test-results/b175-j4-package-gpu.log and b175-j4-geo-probe-direct.log; /series passes both backends.


## Batch 175 job 6: known driver exception

The sciviz GPU gate encountered the known ANGLE D3D11 MSAA resolve defect documented above: geo-lod-browser.mjs:85 reported max red-channel difference 1; diagnostic evidence found 47 one-level channel differences, no GPU errors, and exact native WebGPU pixels. Scott authorized continuing the gate on 2026-11-10. No geo-lod or compatibility source or assertion changed. Evidence: lane U test-results/job6-gpu.log, job6-geodebug2.log and job6-geodebug3.log.

Batch 176 job 5: no open defect found in the declared tensor/OLS/Cartesian tracking contract. Device precision, degenerate-axis ambiguity, raw indefinite fits and analysis/preprocessing limits are recorded in limits.md.

Batch 176 job 6: no open defect found in the declared first-model molecular sphere/stick contract. Unknown-element fallbacks, geometric bond inference and unsupported assembly/ribbon formats are explicit in limits.md.
- **Upstream report drafts (nothing filed):** `docs/upstream-reports/KB5247d/report.md` (dispersion live reset) and `docs/upstream-reports/KB5185b/report.md` (atmosphere zero-cloud hash). Neither has a standalone repro; the nearest evidence is `docs/upstream-reports/KB3508/msaa-blend-repeat.html?api=webgl2` (ANGLE D3D11 + RTX A6000 returns different bytes for identical 4x frames, Vulkan does not). The report for this entry itself belongs to the webgl2-compat lane (KB5822a).

### Batch 137 quality gap closed

The former 1024 UASTC data loss was caused by forcing a stronger lossy RDO setting
to compensate for raw Zstandard literals. Finer RDO alone still lost quality.
RFC 8878 Huffman literals preserve the fitted bytes while reducing the required
rate conditioning. At RDO 0.09375: 1,305,680 / 1,306,710 B, PSNR 44.380795263 /
44.027242948 dB and SSIM 0.981507121 / 0.980103599. Every mip row passes.
See whitepaper/results/batch-137-quality-r10.json and basis-zstd.test.js.

## Batch 132 audit: core (read-only package; findings for Scott)

Base dab36e5f9, M6 Mac mini. Core CPU 90/90 and `core test:gpu` (native, WebGL2 compat and preview) pass on Metal.

### Fixed: core Euler lanes lose the orientation at pitch +-90 degrees

Fixed in e8f3decf6 `fix(core): keep roll at pitch +-90 degrees, keep aspect past 4096, fit boxes past near` (lane J, 2026-11-10). At the pole X is 0 and Z takes 2 atan2(qz, qw); regression in tests/modern-quaternion.test.js.

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

### Fixed: core backbuffer clamp changes the aspect ratio of a wide canvas

Fixed in e8f3decf6 `fix(core): keep roll at pitch +-90 degrees, keep aspect past 4096, fit boxes past near` (lane J, 2026-11-10). Both sides scale by min(1, 4096 / longer side); regression rows in tests/modern-resolution.test.js.

Repro: an engine on a canvas with `clientWidth 5120, clientHeight 1440` at device pixel ratio 1 (a 32:9 monitor, or
any canvas wider than 4096 backing pixels). `resize()` sets the backbuffer to 4096 x 1440 and the camera uses its
aspect 2.844, while the browser stretches it to the CSS aspect 3.556: the picture is 25% too wide (circles render as
ellipses).
Cause: packages/core/src/engine.ts `resize()` clamps width and height to 4096 one at a time. The README promises "at
most 4096 per side" but not the distortion. Fix to build: scale both by `min(1, 4096 / max(w, h))`, or keep the
camera aspect at the CSS aspect.

### Fixed: core `fitToBoundingBox` frames small parts 11x too far and clips large ones at a wide field of view

Fixed in e8f3decf6 `fix(core): keep roll at pitch +-90 degrees, keep aspect past 4096, fit boxes past near` (lane J, 2026-11-10). Distance is max(radius / sin(half angle), radius + near) * padding; a part whose sphere fit falls inside near still sits at (radius + near) * padding (0.13 for the 2 cm part at near 0.1). Regression in tests/modern.test.js.

Repro 1: `new Camera({fov: 120, position: [1, 1, 1]}).fitToBoundingBox([-0.175, -0.175, -0.175], [0.175, 0.175,
0.175], {duration: 0})`: the eye ends 0.385 from the centre, so the nearest corner is 0.082 away, inside `near = 0.1`;
the box is cut open. At fov 100 the corner is 0.13 away, just past near.
Repro 2: stage `box({size: [0.02, 0.02, 0.02]})` then `fit()` at the defaults: the eye ends 0.44 from the centre where
the sphere fit is 0.038, so a 2 cm part fills a twelfth of the view.
Cause: packages/core/src/camera.ts `fitToBoundingBox` raises the radius to `2 near` (which only moves small parts far
away) and never checks `distance - radius >= near` (which a wide angle breaks). Fix to build: fit the true radius, then
move out (or lower `near`) only when `distance - radius < near`.

### Fixed 2026-11-11: core direct light used the separable Smith G of the 2021 glTF Appendix B (KB5875a)

Core's WGSL direct light, its WebGL2 twin (`@margoengine/webgl2-compat` preview) and gltf-pro (base shader, the
physical shader's coat lobe and the extended materials' isotropic path) multiplied two separate G1 terms, which counts a
microfacet hidden from both the light and the eye twice and darkens rough surfaces at grazing angles. They now use the
height-correlated G2 = 1 / (1 + Lambda(v) + Lambda(l)) of Heitz 2014 (JCGT 3(2), eq. 99), the form the current glTF
Appendix B.3.2 gives (`smithGCorrelated` in `packages/shared/light-terms.js`). G2 is never below G1 G1; on the tests'
grid the largest gain is over 25 percent (rough, grazing); at normal incidence both are 1. Core + stage 24,812 B to
24,808 B gzip (the expression is shorter). Scott's 2026-11-11 core ruling. Regression: packages/core/tests/smith.test.js,
packages/gltf-pro/tests/smith.test.js, packages/webgl2-compat/test/smith.test.js (each fails on the separable form).
The other PBR shaders (clustered, materials, terrain, lod, animation, post decals, voxel) still write the separable
`smithG` (next entry).

### Open: clustered, materials and the other PBR shaders still use the separable Smith G (2026-11-11)

Repro: `packages/shared/light-terms.js` `smithG` (and `ggxNamed`), used by clustered/src/shader.ts, materials,
terrain, lod imposters, animation VAT, post material decals and voxel render. A clustered light on a core or gltf-pro
material uses the separable G while the sun uses the height-correlated one, so the two lights shade the same surface
with different masking. Cause: KB5875a moved only core, its WebGL2 twin and gltf-pro (the approved core row). Fix to
build: switch `smithG` to the height-correlated form and re-record each package's proofs.

## Batch 132 audit: stage (read-only package; findings for Scott)

Base dab36e5f9, M6 Mac mini. Stage CPU 134/134; `test:gpu`, `test:gpu:features` (each on WebGPU and with
MARGO_COMPAT=1), `test:gpu:gltf`, `test:gpu:lights` and `test:gpu:viewer-extras` (both modes inside) pass on Metal.

### Fixed: stage `addScene` and `addLights` remove each other's clustered lights

Fixed in c6dd876b1 `fix(stage): scene and addLights share lights, scene cameras keep up, CAD controls orbit about camera.up` (lane J, 2026-11-10). Regression in packages/stage/tests/lights.test.js.

Repro: `addLights(stage, [{type: 'point', position: [0, 1, 0], range: 5}])`, then `addScene` of a document with one
point light: `lights.clustered.list` holds only the scene's light. The other order: `addScene`, then `addLights`, then
`scene.dispose()`: the list is empty, the `addLights` light is gone.
Cause: packages/stage/src/scene.ts `hold()` keeps its own set of scene lists and calls `setLights` with that set alone,
while packages/stage/src/lights.ts `contribute()` appends to the current list. The README says two scenes add up and
each dispose takes its own. Fix to build: `hold()` appends its own lights to `list.list` and removes only its own, as
`contribute()` does.

### Fixed: stage scene camera ignores the entity's up and throws looking straight down

Fixed in c6dd876b1 `fix(stage): scene and addLights share lights, scene cameras keep up, CAD controls orbit about camera.up` (lane J, 2026-11-10). Each camera carries the entity's world +Y as `up` (its -Z when the target lies along +Y). Regression in packages/stage/tests/scene.test.js.

Repro: `addScene` of a floor plus `{id: 'top', transform: {position: [0, 10, 0]}, components: {camera: {target: [0, 0,
0]}}}`: every frame throws `Vertical camera`. With a -90 degree X rotation instead of a target it renders only because
the forward vector rounds to `[0, -1, -2.2e-16]`, so the roll is arbitrary; any camera entity rolled about its view
axis renders unrolled.
Cause: packages/stage/src/scene.ts builds `cameras` from position and target only and never sets `camera.up` from the
entity's world +Y. Fix to build: store the entity's world up with each camera and assign it with the switch.

### Fixed: stage `CADCameraControls` orbit and pan assume Y up

Fixed in c6dd876b1 `fix(stage): scene and addLights share lights, scene cameras keep up, CAD controls orbit about camera.up` (lane J, 2026-11-10). Orbit and pan work in a frame built from `camera.up`; Y up gives the same numbers. Regression in tests/modern.test.js.

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

- Fixed, lane S (2026-11-10): evictionIndex coalesces same-transaction removals, reading and writing totals once for the complete key set. Deleting every Vary entry now leaves exact usage and preserves unrelated files; repeated deletion is harmless. Parent-failing regression: packages/cache/test/eviction.test.js (two and five variants). The real IndexedDB browser gate also deletes five negotiated copies together and checks the remaining bytes and file count.
- Fixed, lane S (2026-11-10): AssetCache hit bookkeeping reads the current record and updates it in the same readwrite transaction. Missing records stay evicted; current sizes, validators and content type cannot be overwritten by an older hit. A 304 refresh updates freshness only if the stored validators still match, and last-use time never moves backwards. Four parent-failing regressions in packages/cache/test/stale-touch.test.js cover eviction and replacement under plain/indexed bookkeeping. The same proof runs on real browser IndexedDB, retaining the already-read response while respecting the byte budget.
- Fixed, lane S (2026-11-10): AssetCache and RangeCache retain stored Cache-Control/Expires fields when omitted by a 304; provided fields replace them, and Date/Age are taken from the validating response. The common policy helper persists only the two lifetime fields, with matching-validator updates. Parent-failing regressions in packages/cache/test/freshness.test.js cover both caches; additional cases cover retained Expires, current Age and no-cache replacement/retention. Legacy metadata without saved policy remains conservatively revalidated until a response supplies that policy; offline bytes remain usable.
- Fixed 2026-11-11: RangeCache response snapshot race (lane S, 2026-11-10, found during 304 policy retention): warm URL a with 100 bytes, ETag "a" and model/gltf-binary; hold a reader's conditional 304, then replace a from a second cache with 80 different bytes, ETag "new" and application/new before releasing the 304. The held response contained the new 80 bytes with the old ETag/type, because assemble read the blocks in a transaction of their own, after the record. Assemble now reads the record and the blocks in one transaction; when the record no longer has the validators and size the answer was planned with, the request is answered again from the new record (RFC 9111 section 3.4), so the held response is the new 80 bytes with ETag "new" and application/new. Regression: packages/cache/test/ranges.test.js ("a file replaced while a revalidation is held"), failing on the parent.
- Fixed 2026-11-11: RangeCache combines stored blocks only under one strong ETag (RFC 9111 section 3.4) and sends
  `If-Range` with it on block requests; under a weak ETag or none a miss fetches every block of the range again and the write
  replaces the old blocks. Regression: packages/cache/test/ranges.test.js (weak ETag and If-Range tests).
- Fixed 2026-11-11: AssetCache honours Request cache modes: `no-store` goes to the network and is not stored, `reload` skips
  the stored copy and replaces it, `no-cache` (or request `Cache-Control: no-cache`) revalidates before serving.
  Regression: packages/cache/test/cache.test.js (request cache modes test). RangeCache still ignores these modes.
- Stale copies are served on any non-200 answer and on a timeout, also for `no-cache` and `must-revalidate` files
  (RFC 9111 4.2.4 and 5.2.2.2 allow it only when disconnected); by design for offline play. Documented 2026-11-11 in
  `docs/limits.md` ("Stale copies on failure"); the cache README already states it.
- Fixed, lane S (2026-11-10): RangeCache captures request start time for a miss and a 304 revalidation and passes it to the existing RFC 9111 freshness calculation. Age plus transit now consumes the correct lifetime. Two controlled-clock regressions in packages/cache/test/freshness.test.js fail on the parent and cover both partly consumed and entirely expired responses without real waits or speed assertions.
- Fixed, sweep L6 (2026-11-11, KB5974e): index.ts keeps its own copies of http.ts `transact` and the range parsing;
  `isEntry` and `defaultFetch` were duplicated; Vary name records were never evicted; 27 throws carried no help link.
  index.ts now uses http.ts `transact` and `byteRange`, `isEntry` lives in http.ts, LoadingManager uses
  `defaultFetch`. Each entry lists the records `keys` wrote with it, and both eviction paths delete a record with the
  last entry that lists it (default: a reference count over the batch; `evictionIndex`: a read of the URL's own keys).
  Every throw goes through typeError, rangeError or fault with the `#cache` help entry. Regressions:
  packages/cache/test/vary-evict.test.js (fails before: the names record outlived its entries), tests/errors-page.test.js
  (now scans packages/cache/src).
- Verified, lane S (2026-11-10): decoded.ts's max-age=3153600000 is not a 2^31-cap defect. RFC 9111 section 1.2.2 defines an overflow fallback rather than an absolute cap; this value and its millisecond deadline are exact safe JavaScript integers. The literal introduced in 4f7774957 is unchanged. The current freshUntil calculation returns an exact 3153600000000-ms lifetime with no wrap. Source: https://www.rfc-editor.org/rfc/rfc9111.html#section-1.2.2. This review does not certify arbitrarily large delta-seconds values.

### Fixed: webgl2-compat explicit-gradient footprint (materials stochastic tiling)
materials `test:gpu:features`, compatibility pass, failed "a triangle edge chose another mip" with 4253 channel values off (main since 42d6e24ae; it passed at a4522807). The plain read is a hardware `textureSample`; stochasticTiling reads with `textureSampleGrad(dpdx(uv), dpdy(uv))`, which webgl2-compat still sent through its float LOD estimate and shader blend. On the 4x tiled floor some quads have a UV derivative 1.5e-4 short of 1/64, a float LOD of 1.99978. The sampler snaps the LOD fraction and mixes in 1/256 of level 1 (sRGB green 13 on the blue level), as native WebGPU does for both reads; the estimate gave pure level 2. Native and compat plain reads were identical, so the gradient path was the outlier. Explicit gradients now keep hardware footprint selection like implicit and biased reads; shader interpolation stays for explicit levels. Regressions: six `glsl.test.js` cases (2D, array and 3D, with and without offset) and the webgl2-compat `implicitFootprint` GPU case, whose oblique and near-integer `dpdx`/`dpdy` gradients must match native bits and `textureSample` bits (oblique before the fix: native 0x3e99f89a, compat 0x3ed98258). The mipFiltering gradient rows now match the native hardware sampler exactly, as implicit and bias rows do: RTX A6000 hardware returns 0.874998 where the f32 oracle says 0.875, natively and on the layer alike. Measured on RTX A6000, ANGLE D3D11 only.

### Fixed: J6 product implicit-sampler footprint
The red 121 versus 120 product probe came from webgl2-compat replacing implicit textureSample footprint selection with a Euclidean derivative LOD estimate. The first resolved scene HDR red was binary16 0x3329 on native and 0x3321 on both ANGLE backends. Keeping hardware implicit sampling repairs the owning emitter; explicit mip interpolation stays unchanged. The glsl.test.js regression fails before repair; the oblique implicitFootprint GPU case changes from native 0x3e99f89a versus old compatibility 0x3ed98258 to 0x3e99f89a on all three paths. Product's existing exact cross-backend and restoration probes now pass, with zero tracked allocations after disposal. Intermediate HDR bit equality is not claimed. Reproduction and raw centre copies: docs/integration-product.md.

## Batch 132 audit: sprites (fixed and open)

Fixed with regressions in `packages/sprites/tests/audit-132.test.js` (all 8 fail on the code before the fix):
`SpriteLayer`, `BillboardLayer` and `SkeletalLayer` `dispose()` removed the active scene's plugin of the same name
(a layer attached to a second scene stayed registered, its pass drawing a disposed layer, and the default scene lost
its `hud`); they now leave through `sceneOf(this)`. `SkeletalLayer` skinned only on view index 0, so a layer that
view 0 leaves out by `layers` drew nothing in view 1 (count 0 from a frame that never built); a `SpriteLayer` with
its own `target` likewise skipped every view after index 0, and its normals target cleared only on index 0. A frame
flag set in `onPreUpdate` now marks the first view the layer draws. `packSprites` and `packBillboards` compared a
float32 slot with the double they wrote, so any value such as rotation 0.1 counted as changed and uploaded every
frame; they compare `Math.fround(value)`. A linked Aseprite cel took the z-index of the cel it links to (spec NOTE.5
orders by each cel's own z). A Spine IK key without `mix` kept the setup mix (0 stayed 0; the JSON export format
says assume 1) and one without `softness` interpolated toward 1 (format: assume 0).

### Open: sprites findings not fixed in the audit

- Fixed 2026-11-11 (KB6013a): nine-slice parts with squeezed or fractional borders left a one-pixel gap under `snap`,
  because each part's corner was rounded on its own and its size kept. packSprites now rounds both edges of an
  unrotated image once, from float32, so parts that share an edge meet there. Regression: packages/sprites/tests/slice.test.js
  (KB6013a case).
- Spine IK keys that leave out `bendPositive`, `compress` or `stretch` keep the setup values; the JSON export format
  page says "Assume false if omitted" for keys, but it shows a 3.8 export and the 4.x default was not confirmed from a
  specification, so this is left as it is (spine.ts applyAnimation constraint loop).
- Fixed 2026-11-11: `sortBillboards` takes an optional `forward` direction and the layer sorts by depth along the view direction, which is right under an orthographic camera. Regression: packages/sprites/tests/billboard.test.js (depth sort test).
- `BlendLayer` and `SkeletalLayer` multiply issue two draws per sprite or triangle; speed unmeasured.
- Aseprite group compositing: header flag 2 says groups composite separately first; the parser multiplies a group's
  opacity into its children (documented in the README, not fixed).

## Batch 132 audit: behavior (fixed and open)

Fixed with regressions in `packages/behavior/tests/audit-132.test.js` (all 3 fail on the code before the fix):
`FlowField.stamp` undo wrote back the costs it saw when it was placed, so overlapping stamps undone oldest first left
the newer stamp's "before" behind: on a 6x1 field, a wall at cells 2-3 and mud (10) at cells 3-4, undone wall then
mud, left cell 3 at 255 (a permanent wall). Live stamps are now kept oldest first and an undone stamp hands its saved
cost to the next stamp over the same cell; a second undo call does nothing. `flock` with `separationRadius` above
`radius` dropped every neighbour beyond `radius` before the separation test, so boids 2.5 apart with radius 2 and
separationRadius 3 never pushed apart; the grid cell is now the larger radius and each rule tests its own.

Open: `flock` and `separation` skip a neighbour at distance 0, so two boids spawned on the same point with the same
velocity never part (repro: `flock({x:[0,0], y:[0,0], z:[0,0], vx:[1,1], vy:[0,0], vz:[0,0]}, 2)` for any number of
steps keeps x[0] === x[1]); Reynolds 1987 gives no direction for a zero offset, and any fixed choice breaks the
row-order independence `flock` promises. `avoidObstacles` scales its push by `1 + (reach - along) / reach` and
`min(1, clearance / radius + 0.5)`, Margo's own heuristic with no source or measurement behind the 0.5.

## Batch 132 audit: culling (fixed and open)

Fixed with regressions in `packages/culling/test/audit-132.test.js` (all 7 fail on the code before the fix):
`CulledInstances`, `DynamicInstances`, `LodInstances`, `CulledMeshes`, `CulledModels`, `FrontToBack` and
`WebGL2Culling` `dispose()` called `engine.removePlugin(this.name)`, which acts on the active scene; a plugin used by a
second scene released its buffers and stayed registered there, its pass drawing a disposed plugin. They now leave
through `engine.sceneOf(this)`.

Fixed, found by the Mac sweep (M6, Chromium WebGPU on Metal): `MeshletMesh` frames were not deterministic. Redrawing
engine A with nothing changed differed from its own last frame by 21 to 33 pixels at step 0 of
`node packages/culling/test/gpu/meshlets-check.mjs`. Cause: the cull kernel reserved each kept cluster's room with
`atomicAdd` on the part's index count (meshlets.ts clusterShader), so the order of clusters in `kept`, and with it the
draw order, changed from frame to frame. Fix: three kernels, `test` (each cluster's index count if kept, at its own word),
`scan` (one workgroup per part, an inclusive scan by doubling in workgroup memory, Hillis and Steele 1986, gives each
kept cluster its place) and `copy`; the kept clusters sit in cluster order every frame. Regressions: the frame-repeat
assertion in meshlets-check.mjs (each step redraws and compares A with its last frame to the byte; 21 pixels on the old
kernel) and "the cluster cull keeps clusters in cluster order" in packages/culling/test/meshlets.test.js.

Closed, Scott approved (2026-11-10, comparing without MSAA): meshlets-check failed at step 0 against core, 69 pixels off by 1 level, all on
the ball's silhouette, now the same count every run. It is not the cull: on the M6 core's own MSAA frame changes with the
primitive stream. A probe page drew the ball with core twice: the same 36,864 triangles in cluster order instead of index
order differed by 75 pixels; only the cone-kept 25,447 triangles in index order (every dropped one back facing by at
least 4.5 degrees, checked in double precision) differed by 14; with `exactSize` (no MSAA) all three cases are 0. So no
cluster cull can match core to the byte under MSAA on this GPU (the scatter entry above saw the same M6 MSAA order
dependence). Now A and B are made with `exactSize` (no MSAA) and match core at 0 pixels on every step; the 0-pixel
requirement is unchanged. The frame-repeat check still runs under MSAA: a third engine R is A with the default 4x MSAA,
and each step redraws and compares both A and R to the byte. On `MARGO_COMPAT=1` the check failed at step 0 ("clusters
drop triangles (0)"): the WebGL2 layer draws the whole mesh by design. It now has a compat branch: the frame must still
match core and repeat, and "clusters drop triangles" is skipped with a printed note. Both runs pass on the M6. The `parts-check.mjs`
shadows step 2 1-pixel failure was the entry above (CulledParts back-culled pipeline under shadows), fixed 2026-11-10.

Fixed (2026-11-10, Mac lane H): `LodInstances` appended each kept instance to its level's list at an `atomicAdd` slot
(lod.ts shader), so the order of a level's instances changed from frame to frame. On the M6 lod-check's pictures still
repeated (its boxes share no edges), but the lists read back did not: a redraw of the unchanged step 0 moved instances
64 to 82 to other places in a level's list, on both runs. Fix: three kernels like MeshletMesh's, `cull` (each
instance's level and a workgroup scan of one-hot level counts), `scan` (workgroup totals to offsets, and each level's
count) and `scatter` (copy into the level's list at offset plus place); each list is in instance order every frame.
Regression: lod-check.mjs redraws every step and compares the pixels and each level's list (read back; the lists'
buffers gained COPY_SRC) to the byte, and checks each list is in ascending instance order; it fails on the old kernel.
lod.test.js checks the three entry points and no atomics. lod-check also gained a compat branch (the WebGL2 layer draws
every shown instance at the first level by design, so core's side does too and "every level drew" is skipped).


## Batch 132 audit: input (fixed and open)

Fixed with regressions in `packages/input/test/audit-132.test.js` (all 5 fail on the code before the fix):
- Chorded mouse buttons. `Input` set and cleared button bits only on `pointerdown` and `pointerup` (index.ts:179-187
  before the fix), but Pointer Events 3, 4.1.1.1 fires neither for a button pressed or released while another is held,
  only a `pointermove` whose `button` names it. Holding left and pressing right never pressed a `{type: 'mouse', button: 2}`
  action; releasing left while right was held left the left action down until a later `pointerup`. Every pointer event
  now reads the `buttons` bitmask (4.1.1.3 bit order: left 1, right 2, middle 4).
- `Gestures`: a two-finger pinch or spread ended with the last finger's lift read as a single pointer, so a quick spread
  emitted a `swipe` (100 px in 100 ms from the second finger's start) and a still two-finger touch emitted a `tap`. A
  sequence that ever had two pointers now ends with neither.
- `captureBinding` resolved on the first keydown, so pressing Ctrl to enter Ctrl+S captured `ControlLeft` and a chord
  could never be captured; a lone modifier now resolves on its release with no other key. It also resolved with a
  gamepad button already held when it was called (the A press that opened the rebind prompt); it now waits for a new press.
- `Pen` tilt from `altitudeAngle` 0: `1 / tan(0)` is Infinity and `cos(pi / 2)` is 6e-17, so azimuth pi/2 gave tiltX 90
  instead of the specification's 0 (Pointer Events 3, 4.1.5, `spherical2tilt`); a flat pen on an axis now takes the
  specification's values.

- `Gyro` read `rotationRate.alpha` as the rate about the device z axis, `beta` about x and `gamma` about y (the
  Euler-angle meaning of `deviceorientation`). Device Orientation (W3C CRD 2026-10-26) 6.3.2 defines the `alpha`,
  `beta` and `gamma` getters of `rotationRate` as the rates about x, y and z. So `{alpha: 90}` (tipping the top back)
  rolled the aim instead of pitching it, and a turn about the screen's up axis (`beta`) pitched it. motion.ts now reads
  x, y and z from alpha, beta and gamma; the old motion tests fed the old meaning and now encode the specification.
  Caveat: the same specification's informative vehicle example gives a turn about y as `gamma`; the normative getter
  steps were followed. Not yet checked on a real phone.

Open (not fixed in the audit):
- Closed, lane L (2026-11-10): on the M6, `packages/input/test/input-browser.mjs` (and `packages/worker/tests/browser-check.mjs`)
  failed before their pixel steps because Chromium rejected `requestPointerLock` with `WrongDocumentError`. Root cause
  is outside Margo: the Mac's console was locked (`ioreg` CGSSessionScreenIsLocked true, front app
  `com.apple.loginwindow`), and Chromium on macOS grants pointer lock only to a view in the key window of the front
  app. Both checks now probe native lock and, only for that macOS reason, run against a Pointer Lock 2.0 stand-in with
  a printed note; any other refusal still fails. Native acquisition on this Mac stays unproven while it runs
  unattended; docs/limits.md "Native pointer lock on a locked Mac". Regression: tests/pointer-lock-harness.test.js.
- Fixed 2026-11-11: `pointer` `wheel` bindings now sum `WheelEvent.deltaY` in pixels (a line counts 16, a page 800), so a wheel
  action's size matches across browsers. Regression: packages/input/test/input.test.js (wheel deltaMode test).
- Fixed, lane S (2026-11-10): Pen uses azimuth zero for ambiguous flat, off-axis tilt when spherical readings are absent, matching the Pointer Events Level 3/4 conversion convention. Axis-aligned flat tilts retain their exact direction, and explicitly supplied altitude/azimuth remain authoritative. Regression: packages/input/test/pen.test.js covers all 12 sign/boundary combinations, action values, sample retention, four axes and supplied spherical data; the input browser gate checks the same boundary matrix.

## Batch 132 audit: net (fixed and open)

Fixed with a regression in `packages/net/test/audit-132.test.js` (fails on the code before the fix): `SnapshotBuffer.sample`
drew the cubic Hermite position but returned the straight blend of the two snapshots' velocities, so the velocity was
not the one the position moved at. On a cubic path p(t) = t^3 - 2t pushed at 0, 0.5 and 1.3 with exact velocities, the
position came back exact and the velocity was off by 0.18 at t = 0.2 and 0.48 at t = 0.9. It is now the derivative of
the Hermite curve (exact on that path; equal to the old value at the snapshots themselves).

Documented 2026-11-11: the playout papers behind `net/delay` (Ramjee et al. 1994, Moon, Kurose and Towsley 1998) are
cited with what Margo takes from them and what is its own in `docs/clean-room.md`; `WARM` (8 arrivals before the
measurement replaces `initial`) and the 0.9995 slerp cut-over in `net/timeline` are recorded there as Margo's own
numbers, not taken from the papers (the nlerp error at that cut-over is below 1e-6 rad). Both are pinned (2026-11-11):
`packages/net/test/delay.test.js` ("the initial delay is the floor for exactly 8 arrivals") and
`packages/net/test/timeline.test.js` ("slerpInto blends near-parallel pairs"), each failing if its constant moves.

## Batch 132 audit: gltf (fixed)

Fixed with a regression in `packages/gltf/test/audit-132.test.js` (fails on the code before the fix): an accessor with no
`bufferView` and no `sparse` is valid glTF 2.0 and holds zeros (specification 3.6.2.1), but `readAccessor`
(accessor.ts:42 before the fix) threw "Invalid glTF bufferView; the file is not valid glTF 2.0". A mesh whose NORMAL
accessor had no bufferView failed to load. It now reads as zeros; a sparse accessor without a view is still refused
as unsupported by the light loader.

## Batch 132 audit: oit (fixed and open)

- Fixed: `TransparentPass.dispose` (packages/oit/src/pass.ts:137, so `OIT`, `ExactOIT`, `PeelOIT`, `PreciseOIT`,
  `MomentOIT`) and `TransparentDepth.dispose` (depth.ts:180) called `engine.removePlugin(this.name)`, which acts on the
  active scene. Input: `engine.createScene('other').use(new OIT()); oit.dispose()`. Wrong output: the pass stayed in
  `other.plugins` and `engine.sceneOf(oit)` still returned `other`. Regression packages/oit/test/audit-132.test.js.
- Closed, lane L (2026-11-10): packages/oit/test/gpu exact-check, vfx-check and real-check failed under MARGO_COMPAT=1
  with the coded refusal "ExactOIT needs storage buffers in fragment shaders" (by design of the WebGL2 layer). Each now
  has a compat branch that asserts that refusal and skips only the ExactOIT picture comparisons; docs/limits.md
  "Compat branches for GPU-only assertions". Adding the branch to vfx-check exposed a real leak in webgl2-compat (next
  section).

## Batch 132 audit: voxel-net (fixed)

- Fixed: a resume's chunk count (protocol.ts encodeClientMessage, accepted up to 2^53 - 1) went through
  shared/bytes.js `ByteWriter.varint`, whose `>>>` keeps 32 bits, so it arrived modulo 2^32, and server.ts `#resume`
  compared it with the unreduced `chunksSent`. Input: a session past 2^32 chunk messages, then a cut and a resume.
  Wrong output: chunks the client had went out again (or a full resend). The count is now sent modulo 2^32 and
  compared modulo 2^32. Regression in packages/voxel-net/tests/resume.test.js.

## Batch 132 audit: headless (fixed)

- Fixed: `decodePNG` (packages/headless/src/compare.ts) took width, height, depth and colour type from bytes 16 to 28
  without checking the first chunk. Input: a PNG whose first chunk is renamed `aHDR` with a matching CRC. Wrong output:
  decoded as if it were IHDR, where the PNG specification (5.6) requires IHDR first. Regression
  packages/headless/tests/audit-132.test.js.

## Batch 132 audit: sky (fixed and open)

- Fixed: `dispose()` of `Sky` (base.ts:662), `AerialPerspective`, `AstroSky`, `HillaireSky`, `LightShafts`,
  `VolumetricClouds`, `Weather` and `WeatherFX` called `engine.removePlugin(this.name)`, which acts on the active scene.
  Input: `engine.createScene('other').use(sky); sky.dispose()`. Wrong output: the plugin stayed in `other.plugins`.
  Regressions packages/sky/test/audit-132.test.js.
- Fixed 2026-11-11 (Scott chose 0.000444 /km, the albedo-0.9 reading): `EARTH_ATMOSPHERE.mieAbsorption` is now
  0.000444 /km, so Hillaire Mie extinction is 4.44e-6 /m, the same as the Bruneton model in atmosphere.ts.
  test/aerial.test.js and test/features-check.mjs follow the new default; sky CPU 116/116 and test:gpu,
  test:gpu:planet pass on the M6 (WebGPU), and under MARGO_COMPAT=1 test:gpu:planet passes while test:gpu keeps only
  the separate ANGLE Metal 2 px meadow case. Every Hillaire sky and aerial picture is less hazy than before. History:
  was `mieAbsorption: 0.00444` /km, cited as
  Hillaire 2020 Table 1, which prints sigma_ma = 4.40e-6 /m. With sigma_ms = 3.996 a single-scattering albedo of 0.9
  (Bruneton 2017) gives absorption 0.444e-6 /m and extinction 4.44e-6 /m, so the table's 4.40 looks like the extinction
  with a typo and the code's 4.44 like the extinction taken as absorption: Mie extinction comes out 8.436e-6 /m, about
  1.9x. Changing it changes every Hillaire sky and aerial picture, and test/aerial.test.js:92 pins 0.00444.
  Source re-read (lane N, batch 132b, 2026-11-11; Hillaire 2020 fetched again from sebh.github.io/publications/egsr2020.pdf
  and read with pdftotext): the text settles what the citation says and leaves its intent open. Table 1's column is
  headed "Absorption (x10^-6 m^-1)" and prints sigma_ma = 4.40; section 3 defines sigma_t = sigma_a + sigma_s; nothing
  else in the paper gives a Mie extinction, albedo or 4.44. So the code's 0.00444 /km (4.44e-6 /m) matches neither the
  cited table (0.00440 /km, 0.9% lower) nor the albedo-0.9 reading (0.000444 /km, 10x lower). The table cites Bruneton
  2017 for the values, whose text was not re-read here. Choices for Scott, value unchanged: 0.00440 (the citation as
  printed: Mie extinction 8.396e-6 /m against 8.436e-6 /m, 0.5% lower) or 0.000444 (Mie extinction 4.44e-6 /m, about half the current one);
  either moves test/aerial.test.js:92 and the sky pictures.
  The package already holds both readings: packages/sky/src/atmosphere.ts (the Bruneton model's tables) takes Mie
  extinction as scattering / 0.9 = 4.44e-6 /m at turbidity 3, while atmosphere-luts.ts (Hillaire) adds 4.44e-6 /m of
  absorption to 3.996e-6 /m of scattering, so the two sky models dim the sun by Mie haze differently for the same Earth.
- Open (Mac bug, M6, MARGO_COMPAT=1): `node packages/sky/test/browser-check.mjs` fails at "meadow 4x frame 1 scene vs
  narrow: differing 2, max 0.0009765625" every run, also on the source before the dispose fix; native passes. The full
  `Sky` and the base entry with only meadow's features differ by one half-float ulp in two pixels.
  Narrowed (lane N, 2026-11-10, M6, Chrome 156, MARGO_COMPAT=1): the two pixels are cloud pixels of frame 1 (coverage
  0.7) at (51, 5) and (135, 55) of the 256-wide scene texture, blue channel only: 0.84765625 vs 0.84716796875 and
  1.1298828125 vs 1.12890625, one half-float step each, so a float32 result a hair apart lands on either side of a
  half rounding boundary. The trigger is the `night` feature's text alone: with the narrow list
  [bruneton, clouds, lighting] plus `night` all three frames are bit-identical to the full `Sky`; plus `preetham`, `fog`
  or `reflection` instead, the same 2 pixels differ. meadow never enables the stylized night and its sun blend is 0 at
  16 h, so the night code (stylizedNight and the uniform branch at the top of nightSky, base.ts compose) does not
  change any value these pixels compute. Both WGSL texts give identical pixels on native WebGPU. Cause: the two
  programs differ in text, and on the WebGL2 layer (ANGLE on Metal) the driver compiles the live arithmetic of the
  cloud pixels differently when that dead branch is present; floating-point contraction or reassociation by the
  compiler is the likely mechanism, not checked (ANGLE's code is out of bounds for this project, and no
  documented switch to test it was found). Not fixed: no change to the sky's arithmetic would make two different
  programs bit-identical under such a compiler, and adding a dead branch to the narrow program only to steer the
  compiler would be a stand-in. The test is not loosened, so browser-check stays red under MARGO_COMPAT=1 on the M6.
  Repro: `MARGO_COMPAT=1 node packages/sky/test/browser-check.mjs`; to see the trigger, open
  /packages/sky/test/browser-check.html under the compat shim, run `check.run('meadow','full')`, then
  `(await import('/packages/sky/test/configs.js')).configs.meadow.features.push('night')`, `check.run('meadow','narrow')`
  and `check.compare('full','narrow')` (0 differing); without the push, 2 differing in frame 1.
  Emitted GLSL checked (lane L, 2026-11-10, M6, Chrome 156, MARGO_COMPAT=1): webgl2-compat's fragment shader for
  [bruneton, clouds, lighting] and for the same list plus `night` is the same text for every shared function, cloud path
  included, apart from the counters in local names (`lr_84` against `lr_110`, `qlookup_s15` against `qlookup_s16`): no
  inlining, precision qualifier, uniform block layout or temporary differs. The night text adds only `stylizedNight`,
  `hash21`, `nightPcg` and the uniform branch in `nightSky`. `packages/sky/test/compat-night-glsl.test.js` pins this.
  Swapping the narrow program's GLSL just before `shaderSource`, with the browser's own text otherwise unchanged
  (`packages/sky/test/compat-night-probe.mjs`, differing scene pixels per frame): narrow as emitted [0,2,0]; the night
  text [0,0,0]; the night text with the branch that calls `stylizedNight` removed, its functions kept [0,2,0]; the night
  text with `stylizedNight`'s body replaced by `return vec3(footprint)` [0,2,0]; narrow with a dead
  `if(...>0.5){return vec3(0.0);}` [0,2,0]. So the live cloud arithmetic rounds one way only when the program also calls
  the full `stylizedNight` body from a branch the frame never takes: ANGLE's or Apple's Metal compiler, not Margo's text.
  Left red: making two different programs round alike would mean steering that compiler with dead code. No tolerance
  changed.
- **Upstream report (draft, nothing filed):** `docs/upstream-reports/KB6171a/report.md`. No standalone repro: it needs a Mac and a hand-minimised page, which this PC cannot do.

## Batch 132 audit: viewcube (fixed)

- Fixed: `ViewCube.dispose` (packages/viewcube/src/index.ts:570) and `ViewCompass.dispose` (compass.ts:333) did
  `engine.hasPlugin(name) && engine.removePlugin(name)`, both on the active scene. Input: create the cube, make another
  scene active, dispose. Wrong output: the cube's plugin stayed in its own scene and kept calling `update` and `sync`
  on a removed element. Regressions packages/viewcube/test/audit-132.test.js.

### ANGLE D3D11 SSGI trace difference (2026-11-10)

On RTX A6000 / ANGLE D3D11, `node packages/post/test/ssgi-bounce-browser.mjs --compat` reports `back.most=1`, mean channel error 0.00005642361111111111 (13 one-level channels across 320x240), after multiBounce is disabled. The unchanged test reproduces exactly on plain origin/main f38642c02 without this restoration repair. Native WebGPU and ANGLE Vulkan give back.most=0. This is a separate signature from the geo-lod/dispersion same-texture reread defect; those rereads remain exact here.

Two unchanged one-bounce frames have identical 435-call GL streams, normalized to 434 calls (full payloads, only sync ids renamed and polling removed), SHA-256 `554ac7a2d65e8cb0abf7a2cea71a2a21b558f166a7c23fd18faf3ec60b9ab30c`. Their D3D11 screenshots differ in 97 one-level channels; Vulkan has zero differences with the same stream hash. Raw-target tracing first differs in SSGI's rgba16float ray-trace output, before either bilateral pass. At GL texel (110,74), red is 0.06024169921875 before the mode round trip and 0.060272216796875 afterward; all preceding captured scene, material replay, Hi-Z and prefilter outputs match. Eleven trace components differ, including alpha 0.5 versus 0.75 at (300,76).

Across D3D11 and Vulkan, the first captured target difference is also the trace output: at (122,150), green is 0.447509765625 versus 0.447265625 and blue is 0.448486328125 versus 0.4482421875. Diagnostic f32 shader outputs at affected texel (300,76) first separate at ray normalization: the identical finite nonzero vector (-0.9959985613822937,-0.001060005626641214,-0.08936194330453873) stays unchanged on D3D11 but normalizes to (-0.9959986805915833,-0.0010600057430565357,-0.08936195075511932) on Vulkan. This ordinary cross-backend precision difference is not proof that normalization causes the repeat-render discrepancy. No Margo undefined-input dependence was found in the bounded investigation; the exact driver/compiler cause remains unresolved. All dumped float targets are finite and the final probe has zero GL errors.

Scott's coordinator ruling (2026-11-10) accepts the identical-stream and backend evidence as below-Margo proof: this one compat-D3D11 SSGI case is recorded and does not block the restore repair. The original test and exact assertion stay unchanged; every other failure still stops. [Reproduction, raw dumps, scope and standards](review5-ssgi-angle.md). No blanket SSGI or backend exemption is added to the test runner.

### Batch 159 matrix preflight gaps (2026-11-10)

Update 2026-11-11 (bug sweep L2 round 2, KB6250d/e/f): closed as rival unsupported. The depth-material WebGPU, USDZ and FourCC-zero DDS rows are three.js 0.186.1 failures on cases Margo completes; bench/parity-causes.json records each with its measured error, the matrix shows them as rival unsupported, and tests/parity-diagnoses.test.js holds that (docs/whitepaper/parity-diagnoses.md, round 3). The shared scene and adapter are unchanged. Still open here: the compute and grading adapters and the SH/lens-flare inputs (KB6250b, KB6250c). Update 2026-11-11 (bug sweep L2, KB6250a): the MeshoptCubeTest row was fixed by 1d9d2297bb (gltf-pro honours KHR_meshopt_compression fallback buffers; regression packages/gltf-pro/tests/meshopt-fallback.test.js), and the packer in bench/scenes/parity/margo-loaders.js keeps KHR fallback buffers; the harness's pack of the sample parses with the meshopt decoder on current main. The three other black-box rows (depth-material, USDZ, FourCC-zero DDS) fail on the three.js side of the harness (bp-159-preflight.json: NodeBuilder refuses MeshDepthMaterial, the USDZ loader throws on isVector3, DDSLoader reports an unsupported FourCC 0), not in Margo. Original entry: Repro: the --runs=1 correctness preflight in docs/whitepaper/parity-diagnoses.md. MeshoptCubeTest fails because gltf-pro recognizes KHR meshopt views but only EXT fallback-buffer markers; the packer omits that KHR fallback payload. The compute and grading adapters reject APIs now available in shader; coefficient-supplied SH and point-position/configurable-element lens-flare inputs still need owning-package work. Black-box reference depth-material WebGPU, USDZ (both) and FourCC-zero DDS (both) fail their current adapter/fixture contracts. Exact errors and outputs: docs/whitepaper/results/bp-159-preflight.json. These remain open; no test assertion or workload was removed.

### hygiene gate 6: TypeScript async API threw "getNodeId requires a RemoteNode" once (2026-11-10)

`npm run hygiene` in the lane-P worktree (bp-161, branch from 5ecb5ab1a, packages freshly built) failed once at
`scripts/hygiene.js` gate 6 (`checker.getSymbolAtLocation(await program.getSourceFile(dts))`) with
`Error: getNodeId requires a RemoteNode` while 14 packages' CPU tests ran beside it; the rerun on the same files passed,
and a standalone pass over all 1,312 entry `.d.ts` files found every source file. Cause not found yet: a
`getSourceFile` that resolves to a non-remote node under load in `typescript/unstable/async`. Repro attempt: run
`npm run hygiene` while `npm test` runs in several packages.

- **Fixed (2026-11-10, Mac lane E): wrong-scene dispose in creative, labels, points, tiles, lod, materials, rigging, usdz,
  gltf-pro, mcp and scatter.** `engine.removePlugin(name)` acts on the active scene, so disposing a plugin attached to
  another scene removed the active scene's same-name plugin and left the disposed one registered and running. Each
  site now removes through `engine.sceneOf(plugin)` (one `fix(<pkg>): dispose removes the plugin from its own scene`
  commit per package, each with a regression that fails on the old code). Left as is on purpose: react's and ui's
  React effects (attach and detach both run in a React commit, where the default scene is active; react's plugins stay
  in the default scene, and adaptive-resolution uses `engine.scene` both ways), controls' `cadControls` (replaces the
  active scene's stage controls on purpose), environment's `EnvironmentLighting.load` rollback (same synchronous call
  as the attach), and the already scene-scoped sites in animation, audio, inspector, save, shader, xr and the other
  gltf-pro and materials files. Open, outside the lanes that may edit them: `packages/physics/src/physics.ts:1209`,
  `packages/physics/src/next/physics.ts:896` and `packages/physics2d/src/physics.ts:630` check `hasPlugin` and remove
  by name in the active scene (same bug); `packages/ragdoll/src/ragdoll.ts:1211` compares against the active scene, so
  a ragdoll in another scene is never removed. Sciviz `axes.ts`, `media-tiles.ts` and `pointcloud.ts` had the same
  pattern; fixed 2026-11-11 through `sceneOf` (regression: packages/sciviz/tests/scene-owner-browser.mjs for the axes,
  both backends; the scene cases of packages/sciviz/tests/export-media.test.js and pointcloud.test.js). Also open: tiles' points plugin and usdz `curves()` attached after an
  import's await used to land in the default scene; tiles now attaches its points plugin to the renderer's scene,
  usdz is in finish-later.md.

### Fixed 2026-11-11: sciviz preview-contract owners (lane E, 2026-11-10)

`TileClear` (media-tiles.ts), `ProgressiveRendering` (progressive.ts) and `VolumeDepthCapture` (volume-depth.ts) registered
frame-graph passes gated on `backend` with no `requireWebGPU` refusal in setup and no `previewRoutes` row. They now
refuse in setup through `requireWebGPU` (b061399b78). `node scripts/check-preview-contract.mjs` reports all 162 owners
refusing during setup or holding a tested preview route.

## Batch 132 audit: gltf-pro (fixed and open)

- Fixed: `applyGLTFLightExtensions` (packages/gltf-pro/src/lights.ts, the aimed-profile cache) keyed fixtures by profile format + profile name + aim. Two EXT_lights_ies profiles with the default name "" and the same LM-63 first line, on nodes aimed alike, shared the first profile: input `LightProfile.ies` (peak 8500 cd) and a second profile peaking at 5250 cd; the second fixture drew at 8500 cd with the first one's beam. Cause: the name is optional and not unique. Fix: the loop is now `placeIESLights`, keyed by the parsed profile object (one per `lights` index) and the aim. Regression: packages/gltf-pro/tests/lights.test.js, "two unnamed profiles of one format aimed alike keep their own candela" (fails with the old key).
- Open: EXT_lights_image_based says each saved image "must be flipped about its vertical axis". The reader swaps rows (a flip about the horizontal axis), which the README says is how the one real file reads, but the check that picked it (the mean against the first SH coefficient) does not depend on orientation. Repro to settle it: project the decoded cube onto the l = 1 SH basis and compare signs with the file's coefficients 1 to 3, with rows swapped and with columns swapped.

## Batch 132 audit: animation (fixed, Mac sweep)

Found by lane I's Mac sweep on 2026-11-10 (M6 Mac mini, Metal; forced compatibility with `MARGO_COMPAT=1`, which runs the WebGPU code on the WebGL2 layer). Both checks pass natively. Neither script asks for a compat pass in package.json, so no gate ran them this way before. Both fixed by lane I the same day; the commit is the one that changed this section.
- `MARGO_COMPAT=1 npm run test:gpu:morph` (scripts/animation-morph-gpu-tests.js): every STEP and LINEAR weight read back wrong, worst error 1 (CUBICSPLINE 0.79); first failure STEP loop, copy 1, at 0.4: expected 1, read 0. None of the three first suspects (the scatter tier's `num_workgroups` index, `arrayLength(&items)`, a readback at an offset) was it: the first frame was right and every later frame read the CPU's zeros. **Cause: a browser bug below the layer**, Chrome on ANGLE's Metal back end. When the first draw through a framebuffer after the WebGL2 context's OffscreenCanvas was shown with `transferToImageBitmap` comes after an upload into the framebuffer's texture (`texSubImage2D`, from memory or from a pixel unpack buffer, before or after the frame was shown), that draw is dropped: no GL error, the framebuffer reports complete, the texture keeps the uploaded data. The layer refreshes a buffer's "word texture" with such an upload before each scatter dispatch, so from the second frame on (the first one shown) the morph pass's stores never landed and the Animation's own weight upload (zeros) won. Raw WebGL2 repro with no layer: `node packages/webgl2-compat/test/metal-dropped-draw-repro.mjs` (prints one line per order; not a gate): an R32UI 4096x1 texture attached to a framebuffer; draw 7 into it, read 7; show the canvas; upload zeros; draw 9; read 0 (9 without the frame shown, 9 with no upload, 9 when the texture is attached to the framebuffer again before the draw, 9 when any draw through the framebuffer comes first). Measured with `ANGLE (Apple, ANGLE Metal Renderer: Apple M6, Unspecified Version)`, HeadlessChrome 156.0.8078.4. Not reported upstream from here (this repository does not read or file against Chromium or ANGLE code). **Workaround in the layer** (packages/webgl2-compat/src/device/device.ts `framebuffer`, canvas.ts `present`): each shown frame bumps `CompatDevice.frame`, and a cached framebuffer is attached again (its attachments, draw buffers and status check) on its first use in each new frame. Cost: one re-attach per framebuffer used per frame, no new GL objects. Regression: `scatterAfterWrite` in packages/webgl2-compat/test/compute.html (run by `test:gpu` through compute-browser.mjs): a scatter dispatch, a frame shown, 70 small writes into the same buffer, a second dispatch; without the workaround the layer read `second[0..3]` as 0 where native WebGPU read 10, 20, 30, 40. The morph check now passes under `MARGO_COMPAT=1` (worst error 6.0e-6, under its 1e-5 bound; the bound is unchanged).
- `MARGO_COMPAT=1 npm run test:gpu:uploads` (packages/animation/tests/upload-copies-browser.mjs): "a held pose stays certified as uploaded" failed; the page reported `{"skinned":4,"palettes":2,"copies":0,"mismatched":0,"held":false}`. **Cause in animation's design, not a wrong result**: the uploaded-palette and morph weight caches (packages/animation/src/index.ts `reusableWriter`) only trust the browser's own `GPUQueue.prototype.writeBuffer`, because a custom writer could change its input while it copies and restore it before returning, so comparing afterwards could not certify the upload. The layer's `CompatQueue.writeBuffer` is a JavaScript method, so on the layer every held palette and every unchanged morph weight went up again each frame and `bonesUploaded` never held. That method copies its input before it returns (straight into GL, or into a slice that waits its turn) and never changes it. **Fix**: it now carries the mark `Symbol.for('margoengine.writeBuffer.copiesInput')` (non-writable), and `reusableWriter` also accepts a queue whose prototype's own `writeBuffer` is the writer and carries that mark, with the same own-property and getter checks as the native path. Like the native check, it is a host filter, not a security boundary. Regressions: the compat run of `test:gpu:uploads` (held true) and `writeBuffer carries the copies-input mark` in packages/webgl2-compat/test/device.test.js.

## Fixed: webgl2-compat `implicitFootprint` oblique-gradient case differed on the Mac (ANGLE on Metal)

Fixed by `62941de87`: ANGLE Metal's `textureGrad` takes its generic explicit-gradient path even when the gradients are
the coordinate's own `dpdx`/`dpdy`, where native Metal (and WGSL's definition) uses the implicit footprint; the layer
now samples implicitly in that case. `features-browser.mjs` passes on the M6 at `5a6087049` (all `implicitFootprint`
texels match native). The original report follows.

Found 2026-11-10 by the Mac's full `packages/webgl2-compat` `npm run test:gpu` on `main` 5dfe40d1f (M6 Mac mini,
"ANGLE Metal Renderer: Apple M6", HeadlessChrome 156.0.8078.4). `node packages/webgl2-compat/test/features-browser.mjs`
stops at `implicitFootprint: compat differs from native`: all eight `.linear/oblique-grad/false` texels read
1054299991 (0.42059 as f32 bits) on the compatibility layer against 1052145270 (0.35637) on native WebGPU. The case
came in with 42d6e24ae and was edited by 43b65e70e (both another machine's sampler-footprint work), and it fails the
same way before and after 60552800e, so the Mac's per-frame framebuffer re-attach is not the cause. The test is not
changed. Repro: `MARGO_GPU_SLOTS=2 node packages/webgl2-compat/test/features-browser.mjs` on the M6.

## Batch 132 audit: netcode (fixed)

- Fixed: `GameServer` (packages/netcode/src/server.ts) queued a join on hello and a leave on close, and `step()` runs leaves before joins. A client that said hello and closed before the next tick got `game.leave` first (a no-op) and then `game.join`, so its player stayed in the authoritative state for good, and every client saw it; a hostile client could repeat hello and close to fill the state. A leave now cancels a join that has not run. Regression: "a player who joins and leaves within one tick leaves no ghost in the state" in packages/netcode/tests/netcode.test.js.
- Fixed: `RollbackSession` (packages/netcode/src/rollback.ts) stored every checksum a peer sent, whatever its frame, and only deleted one when it compared it. A broken or hostile peer sending checksums for frames off the exchange interval or far past anything it could have confirmed grew the map without bound (10,000 entries from 10,000 messages in the test). Such checksums are now refused and stale ones pruned with this peer's own. Regression: "checksums a peer sends for frames that can never be compared are not kept" in packages/netcode/tests/rollback.test.js.

## Batch 132 audit: mixer (fixed)

- Fixed: `createEffect` (packages/mixer/src/effects.ts) accepted a filter `q` from -40 to 1000 for every filter type, so an eq band or filter effect took a bandpass, notch, allpass or peaking `q` of 0 or below (alpha = sin(w0) / 2q gives no filter of that kind) and a lowpass or highpass resonance up to 1000 dB, while the reference `biquadCoefficients` refuses all of them. The effect now uses the reference ranges. Regression: the bad-q cases in "effect settings are validated and mapped to node parameters" in packages/mixer/tests/mixer.test.js.

## Batch 132 audit: mesh-edit (fixed)

- Fixed: `simplifyMesh` (packages/mesh-edit/src/simplify.ts) documented `maxError` and `error` as squared distances, but its quadrics are weighted by face area (Garland and Heckbert), so the cost was area times squared distance (length to the fourth): scaling a model by 10 scaled `error` by 10,000, and a `maxError` picked as a squared distance stopped at a different point on every model scale. Each vertex now carries the face area summed into its quadric and the cost is divided by it (an area-weighted mean squared distance). Regression: "simplify error and maxError are squared distances: scaling the model by 4 scales them by 16" in packages/mesh-edit/tests/simplify.test.js.

## Batch 132 audit: mcp (fixed)

- Fixed: `createMcpServer` (packages/mcp/src/server.ts) handled `resources/read` without refusing a request id that was already running. A reused id replaced the running `tools/call`'s cancellation controller and deleted it when the read finished, so a later `notifications/cancelled` for that call did nothing and the tool ran on. `resources/read` now refuses an active id (as `tools/call` already did) and removes only its own controller. Regression: "a resources/read reusing an active tool id is refused and leaves the tool cancellable" in packages/mcp/tests/server.test.js.

## webgl2-compat explicit gradients on ANGLE Metal (lane L, 2026-11-10, fixed)

Fixed: on the M6 Mac mini, `textureSampleGrad(t, s, uv, dpdx(uv), dpdy(uv))` through the WebGL2 layer chose a
different mip (0.4205882 against native 0.3563725 on the bias-browser oblique map), because ANGLE Metal's GLSL
`textureGrad` takes the generic explicit-gradient path while native Metal returns the implicit footprint for those
gradients. Repro before the fix: `node packages/webgl2-compat/test/bias-browser.mjs` on a Mac (128 of 1280 words
differ, keys `linear/oblique-grad/false` and `/true`). Fix: `packages/webgl2-compat/src/glsl/emit.ts` samples
implicitly when the gradients are the coordinate's own derivatives. Regression: `packages/webgl2-compat/test/glsl.test.js`.
Details and numbers: docs/limits.md "webgl2-compat footprint check per platform".

## webgl2-compat bind groups kept their device and engine alive (lane L, 2026-11-10, fixed)

Fixed: `CompatBindGroup.storageTexture()` (packages/webgl2-compat/src/device/resources.ts) registered each shared
storage texture with a module-level `FinalizationRegistry` whose held value was `{ gl, texture }`. A registry holds
held values strongly, and a WebGL2 context reaches its device (the canvas's context-lost listener), the device its
engine, and the engine the plugin that owns the bind group, so neither the group nor anything around it was ever
collected. Repro before the fix: `MARGO_COMPAT=1 node packages/oit/test/gpu/vfx-check.mjs` stopped with "RangeError:
WebAssembly.instantiate(): Out of memory" when the page created its 124th engine with a VFX effect (a heap snapshot
showed the path from the registry's WeakCells through `gl` to the disposed engines). Fix: the held value is a
`WeakRef` to the device and an id into a per-device `WeakMap` of shared textures. Regression:
packages/webgl2-compat/test/bind-group-release.test.js (fails with the old held value), and vfx-check under compat.

### Fixed: ANGLE D3D11 on an AMD driver hung the GPU under the old flipped-blit present (2026-11-10, Beelink)

Repro (Radeon 680M, Windows 11, AMD driver 32.0.21030.2001, Edge 157.0.4341.42): `node
packages/materials/test/features-browser.mjs` failed its compat half 2 of 2 on 48ca54edd, at a different step each run
("eye angle 0.6: 0,256", "white highlight at NaN", "hair shows: 0,0,0"): every pixel of the frame read 0, alpha too.
Cause, from the browser's GPU log (edge://gpu after the run): `Renderer11::testDeviceLost: The D3D11 device was removed,
HRESULT: 0x887A0006` (DXGI_ERROR_DEVICE_HUNG), then `The GPU process crashed! Exit code:
RESULT_CODE_GPU_EXIT_ON_CONTEXT_LOST`. The scene's context was lost and its frames stayed empty; after the third GPU
process restart the browser blocked WebGL for the page (`getContext('webgl2')` null: "WebGPU adapter unavailable").
No Windows TDR event was logged; native WebGPU (Dawn D3D12) never hung. Measured with loops of 30 fresh devices, each a
256x128 PBR sphere (65k triangles): hangs in 12 of 13 runs with the old present (a y-flipped `blitFramebuffer` and a
colour-masked clear, both ANGLE D3D11 shader paths) while frames reached the page through `transferToImageBitmap` and
the layer polled fence syncs. Removing any one ingredient stopped it: a 2D `drawImage` present 0 in 90 devices,
`fenceSync` returning null 0 in 60, a 32x16 sphere 0 in 30, an unlit sphere 0 in 72; `gl.finish()` before each
transfer, never calling `loseContext` or no `keepFrame` copy did not. A plain WebGL2 page with the same mesh, MSAA
resolve, flip blit, fences and transfers did not hang in 240 contexts, so the trigger inside ANGLE or the driver is
not isolated. Valid WebGL calls must not hang the device: below Margo. Not caused by the 2026-11-10 compat commits
first suspected (compat source at 42d6e24ae^ hung the same). 450015cb1 ("present the canvas with a texel-fetch draw,
not a flipped blit", for the NVIDIA uniform-block bug above) removes the old present, and with it the hang: 0 in 60
devices, and the features test passes 2 of 2 on 000a11e1d. Regression: packages/webgl2-compat/test/device-churn-browser.mjs
(in test:gpu; 30 fresh devices must each show their frame) fails at device 1 with compat source at 450015cb1^ on the
Beelink and passes on main. Diagnostics kept outside the repository in lane M1's `.lane/diag` (raw-launch.mjs, wrap.js
GL wrappers, feat.html, min.html).

### Accepted: AMD D3D11 compressed mip blend makes implicitFootprint differ from native (2026-11-10, Beelink)

Repro (Radeon 680M, Windows 11, AMD driver 32.0.21030.2001): `node packages/webgl2-compat/test/features-browser.mjs`
on main 50b7ceddc stopped at `implicitFootprint: compat differs from native`, `.linear/implicit/false[0..7]: native
1051063284, compat 1048608897`. Decoded: native 0x3ea5f3f4 = 0.32413 = level 2 (64/255) plus 25/256 of level 1, so
LOD 487/256 (1.90234); compat 0x3e808081 = 64/255, level 2 alone. Every one of the 20 linear-mip rows fits that one
LOD on both sides (bias -1.25, 0.375 and 1.25 give LOD fractions 0.652, 0.277, 0.152; native blends by the fraction,
compat by 0.6875, 0.21875, 0.0625); nearest-mip rows and the near-integer map are bit-identical. Cause, below Margo:
the layer emits a plain GLSL `texture()` for these footprints and the AMD driver under ANGLE D3D11 blends two mip
levels with weight clamp((frac - 0.1) / 0.8, 0, 1) on a 1/64 grid. Raw WebGL2 without the layer
("ANGLE (AMD Radeon(TM) Graphics 0x1681 Direct3D11)") at LOD fractions 0, .0625, .125, .1875, .25, .3125, .375, .5,
.625, .75, .875, .9375 between a white and a black level returns 1, 1, .96875, .89063, .8125, .73438, .65625, .5,
.34375, .1875, .03125, 0, through `textureLod` and through `texture()` with a bias alike; native WebGPU (Dawn D3D12)
on the same GPU in the same page returns 1 - frac exactly, and so does ANGLE Vulkan. The LOD itself is the same.
Spec: WebGPU 7.1.1 (GPUSamplerDescriptor), "The precise filtering behavior is implementation-dependent."; OpenGL ES
3.0 section 3.8.10.4 gives tau = [1 - frac(lambda)] tau1 + frac(lambda) tau2 for LINEAR_MIPMAP_LINEAR, which the
D3D11 driver does not follow. Exact layer-equals-native bits for hardware-blended footprints is therefore not a spec
requirement; it held on NVIDIA, Intel and ANGLE Vulkan only because their blends are linear.
Scott ruled 2026-11-10: a spec-scoped test. test/blend-check.mjs classifies the backend with a raw WebGL2 probe
(textureLod at every LOD k/256). Linear-blend backends keep the exact bit equality unchanged. On a compressed-blend
backend the linear-mip rows of implicitFootprint and the footprint rows of mipFiltering must pick native's LOD
(nearest-mip sweeps of 512 biases i/256 - 1, compared bit for bit) and each blended texel must equal, bit for bit,
native's own textureSampleLevel and raw WebGL2 textureLod at one shared LOD k/256; every other row stays exact. A
self-test scales the layer's footprint coordinates by 1.01 (LOD 3.7/256 high, inside the clamp, so the blend alone
cannot see it) and must fail through the sweeps. bias-browser.mjs (test:gpu:bias) uses the same scheme: D3D11
compressed, Vulkan linear and exact. Regression: blend-check.test.js (classification and the comparison on synthetic
probes); on the Beelink features-browser.mjs passes with the self-test failing as required. No system or driver
setting was changed (the AMD "Texture Filtering Quality" setting may control the compression; not tried).

### Fixed: weather lens drops lost sub-cell precision far from the origin (2026-11-10)

Repro: `node scripts/gpu-lock.mjs run --owner=weather -- node packages/weather/tests/parity-browser.mjs lens` on native WebGPU (RTX A6000) failed its unchanged 0.0001 CPU-oracle bound in the 2400 long-time cases at 0.000135468. Cause: the lens shader formed the full drop centre `(cell + offset) * spacing` before subtracting it from the sample, so f32 cancellation dropped the fractional offset bits. It now reduces the sample to its cell with `fma(-cell, spacing, q)` and subtracts only the fractional centre. Regression: the same parity run, native and `--compat`.

### Fixed: stage viewer GPU check captured before the GPU had finished (2026-11-10)

Repro: `node scripts/stage-viewer-gpu-check.js` under a loaded GPU could compare a capture taken while pipelines were still compiling or before the restored environment device was in use. Cause: the fixture (tests/stage-viewer.ts) waited a fixed number of animation frames, which does not establish pipeline readiness or completion of submitted work. It now waits for pipeline quiescence, `queue.onSubmittedWorkDone()` and the current environment device before every capture. Regression: tests/viewer-fixture-ready.test.js (runs the real fixture with the submitted-work fence held; fails on the old fixture).

### Fixed: tests/vite-cache-isolation.test.js passed every test and then never exited (2026-11-10)

Repro: `node --test tests/vite-cache-isolation.test.js` on main printed 5 passing tests and then sat until the gate's 1500 s limit killed it. Cause: "a failed start removes its cache folder" starts Vite with a plugin whose `configureServer` throws; `createServer` then rejects after it has opened two file system watches (FSEventWrap), and the rejected call returns no server, so `startDevServer` had nothing to close. `startDevServer` now adds a first plugin that receives the server before any other `configureServer` hook, so a failed start closes it. Regression: "a failed start leaves nothing open, so its process exits" in the same file (a child process making only a failed start exits by itself; on the old code it still holds two FSEventWrap after 20 s).

### Open (below Margo): AMD Direct3D 11 steepens the trilinear blend, so AMD compat IOR stays over its budget (2026-11-10)

Repro: `MARGO_GPU=amd GPU_POWER=low-power node scripts/gpu-lock.mjs run --owner=<you> --gpu=render-correctness -- node scripts/reference-rendering/mip-blend-control.mjs` on the dev PC's AMD Radeon iGPU (RDNA 2, driver 32.0.21042.62). The page is raw WebGL2 and raw WebGPU with no Margo code: level 0 white, every other level black, one sampler with linear min, mag and mip filters, sampled at LOD fractions 0.125 to 0.875 both by explicit LOD and by implicit derivatives. Raw WebGL2 on ANGLE D3D11 uses level-1 weights 0.03125, 0.1875, 0.34375, 0.5, 0.65625, 0.8125, 0.96875, that is clamp(1.25 f - 0.125), flat below 0.1 and above 0.9 (worst error 0.098), for explicit and implicit sampling alike. Raw WebGPU (Dawn on D3D12) on the same GPU gives exactly f (worst 0 explicit, 1/256 implicit, the hardware's 8-bit LOD fraction), and both APIs give exactly f on the RTX A6000. So the steepened blend is the AMD driver's Direct3D 11 trilinear path under ANGLE, not compat state: compat binds LINEAR_MIPMAP_LINEAR, MIN_LOD/MAX_LOD from the descriptor, base level 0, and no anisotropy for an isotropic sampler, exactly the raw page's state.

Effect: since 42d6e24ae compat keeps the hardware's implicit footprint (the Euclidean derivative estimate chose a different mip from native, J6 ToyCar). On AMD D3D11 that footprint is blended with the steepened weight, which native AMD WebGPU does not do, so batch 160's AMD compat IOR proof scores 2,423,682 against its frozen 2,421,642 while native AMD scores 2,421,894. Compat cannot undo it: WebGL2 exposes no query of the hardware LOD (textureQueryLod is not in GLSL ES 3.00), and the flat zones throw the fraction away, so no shader arithmetic recovers f. Computing LOD in the shader instead brings back the J6 footprint mismatch on every vendor. Coordinator ruling (2026-11-10): the AMD compat IOR budget is not re-frozen; this one AMD D3D11 compat case is recorded here, every other case still stops. Fix condition: a driver or ANGLE change that makes the control print f for WebGL2, then the proof rerun against the unchanged budget.

### Fixed: one live texture more or less after 100 device restores on the WebGL2 layer, in one run of three (2026-11-11)

Repro: `MARGO_COMPAT=1 node scripts/gpu-lock.mjs run --owner=<you> -- node scripts/device-recreation-soak.mjs` (core meshes, `Shadows` and `LODSystem`, 100 forced losses restored by core, 120 frames between losses), RTX A6000, Edge 157. One run of three had 6 textures live after the first restore and 5 after the hundredth, the picture the same. Logging every restore's live textures by format and size showed the missing one in about one restore in seven: the `r32float` level of `@margoengine/shadows`' WebGL2 nearest-depth route (`src/compat.ts`).

Cause: `Shadows.setup` asked `import()` for that route again on every device, and frames drawn before the import settled ran the WebGPU nearest-depth kernel, whose atomics put it on the layer's CPU tier (the whole map read back and looped over in JavaScript, about 0.5 s a frame at 2048 x 2048). In a still scene the map did not change again, so the route never built its level. The WebGPU kernel's pipeline was also compiled on the layer when the route was there. Fix: once loaded, the route is kept and every later setup (a restore, another `Shadows`) takes it at once, and the kernel is compiled only when the route is missing. Regression: `packages/shadows/test/compat-route.test.js` (three restores, each first frame builds the route's level and compiles no atomics kernel); the soak now names each live texture by format and size and, run 4 times (400 restores), kept 6 textures and 12 buffers after every restore.

### Fixed: a device lost while an environment rebuilt was reported as an error, and a failed restore twice (2026-11-11)

Repro: `node scripts/gpu-lock.mjs run --owner=<you> -- node scripts/restore-fault-sweep.mjs` before this fix: after any failure that kept the next settle from finishing, the clean restore reported "Failed to execute 'mapAsync' on 'GPUBuffer': The Device was lost before mapping was resolved", and every environment failure reached `engine.onError` twice. Cause: `Environment.restore` passed on its SH readback's rejection when its device was lost mid-rebuild, though core restores onto the next device and the environment rebuilds there (core reports no loss it recovers from); `Environment` and `EnvironmentLighting` share one restore and both reported its rejection. Fix (environment): a rebuild whose device was lost rejects with a coded `MargoError` (`failed`, help link `gpu-lost`) that the plugins do not report, and a restore's failure is reported once (`src/restore-report.ts`). Regression: `packages/environment/tests/restore-lost.test.js`.

### Fixed: the GPU fault helper fired uncapturederror inside the failing call (2026-11-11)

`tests/support/gpu-faults.js` dispatched `uncapturederror` synchronously, so core, which adds its listener right after its first buffers, never heard of a failed first buffer, and on the WebGL2 layer that failure went unreported. A device fires it in a task of its own (WebGPU, "dispatch error"); the helper now does too. Regression: `tests/gpu-faults.test.js` (no event inside the call). The helper also takes `select(method, descriptor, buffer)` so a plan can count one package's calls.

### Open: an allocation failure in core, shadows or culling stops the engine until the next device restore (2026-11-11)

Repro: `node scripts/gpu-lock.mjs run --owner=<you> -- node scripts/restore-fault-sweep.mjs` (and with `MARGO_COMPAT=1`), RTX A6000, Edge 157. Each of the 40 (native) or 42 (WebGL2 layer) allocations a restore makes fails once in turn. Every failure is reported and a clean restore after it gives the same buffers, textures and picture. But a failed allocation of core (10 native, 8 layer), `@margoengine/shadows` (5) or `@margoengine/culling` (13 native, reported at the next frame) stops the engine: the out-of-memory error reaches core's `uncapturederror` listener, and every frame throws the coded `gpu-lost` fault (`engine.start()` stops its loop) until the next device restore. `@margoengine/environment` scopes its allocations, rejects its restore and the frames go on. Cause: those allocations run outside an `out-of-memory` error scope, and WebGPU only reports the failure later, after frames have used the object. Fix needed: scope the allocations of each package's setup and restore, skip the package's passes until the scope resolves, and on failure release, report a coded error and retry at the next restore, with `scripts/restore-fault-sweep.mjs` asserting that the frame after any one failure renders.

### Fixed: at the WebGPU compatibility level a one-layer shadow map was bound through a view dimension it was not made for (KB-C34f, 2026-11-11)

Repro: `node scripts/gpu-lock.mjs run --owner=<you> -- node packages/webgl2-compat/test/adapter-browser.mjs` with `Shadows` on one layer (RTX A6000, Edge 157): every compatibility-level frame failed with "[Invalid CommandBuffer] is invalid due to a previous error. While calling [Queue].Submit". On main this was `Shadows` with `bounds` (one cascade); a 1x1 fallback map tried on branch core34 showed it first. Cause: receivers bind the shadow maps as '2d-array' views. A device without `core-features-and-limits` binds a texture only as its `textureBindingViewDimension`, '2d' by default for a texture of one layer, so a one-layer map made bind groups that failed validation. Fix: `packages/shadows/src/index.ts` makes every receiver-bound map (depth arrays and tint maps) with `textureBindingViewDimension: '2d-array'` on such devices; full-level devices get the descriptors they always did (the pinned GPU call proofs are unchanged). Regression: `packages/shadows/test/compat-view-dimension.test.js` (the `bounds` case fails without the fix); real GPU: `packages/webgl2-compat/test/adapter-browser.mjs`.

### Fixed 2026-11-11 (KB6438a): sciviz views ResizeObserver callback rendered and resized the canvases it observes (WebKit)

- **What:** `sciviz test:browser:views` in Playwright WebKit fails on some runs with the page error "ResizeObserver loop
  completed with undelivered notifications." (3 of 3 runs at 90f7f7dd0, 1 of 2 at 8ac516006); it passes in Chromium.
- **Repro:** `MARGO_BROWSER=webkit npm run test:browser:views --workspace @margoengine/sciviz`.
- **Cause:** the observer in `packages/sciviz/src/views.ts` (the `#resize` callback of the three-slice view) fits the
  slices and called `figure.render()`, which can change the size of the canvases it observes in the same frame.
- **Fix:** the callback schedules one refit and redraw on the next animation frame (deliveries before it share it;
  dispose cancels it). Regression: packages/sciviz/tests/views-browser.mjs counts renders inside the delivery (must be
  0) and after it. WebKit evidence: on the Mac mini (Apple M6, macOS 27.2) the views browser test passed 10 of 10
  Playwright WebKit runs at 397545736b, compatibility layer off and on, with no ResizeObserver page error.

## Batch 132b audit: materials (fixed, 2026-11-11, lane N)

- Fixed: `Transmission` (packages/materials/src/transmission-pass.ts) built its scene-copy mip chain with a 2x2 box
  read from texel 2p of the level above. At an odd size the last column and row never reached a coarser level, and
  each level drifted by up to a texel from its footprint; the comment claimed the odd edge repeated. Input: a 37 x 23
  canvas with refracting glass (`npm run test:gpu:transmission-layers`). Wrong output: level 1 off a float64 area filter
  of level 0 by 106 times the half-float tolerance (0.002 + 0.2%). Fix: the chain uses shared/mipmaps.js's area
  filter (each source texel weighted by its overlap, as gltf-pro's mips since 65098f33f); worst error now 0.16 of the
  tolerance on Metal WebGPU and MARGO_COMPAT=1. Rough glass near an odd-sized frame's right and bottom edges now
  blurs the last column and row in. Size (scripts/quality/baselines/sizes.json, entry of 2026-11-11 for f2cd28c42):
  the transmission entry grew 323 B gzip (8,350 to 8,673) and transmission-layers 271 B (5,193 to 5,464), the shared
  filter's loop in place of the 2x2 box.
- Test that passed whatever the code did: test/physical.test.js asserted "group 0 binds the volume" by finding any
  2-entry bind group whose second entry was binding 1; that matched the old reduce groups (source, sampler), not the
  frame group [0, 3, 1] that holds the volume. It now looks for a buffer at binding 1.
