# Known bugs and unverified features

What is known to be wrong or not yet proven, and what it would take to close each item. Design limits (where a
boundary is a decision, with its escape hatch) live in [limits.md](limits.md); this page lists defects and checks that
are still open.

## Rendering

### Two identical runs of GlassVaseFlowers can differ on a few pixels

- **What:** the same model, camera and sorted path, built twice in one page, differed on fewer than 8 of 147,456 pixels
  by up to 9 of 255 at 4x MSAA, in one of six Khronos models tried (RTX A6000). Seen once on TransmissionTest too.
- **Repro:** `node packages/oit/test/gpu/real-check.mjs`; the `repeat` field of each model's line.
- **Cause, not found:** the frame's inputs are the same; the model holds both native transmission and a BLEND part. No
  check of it yet separates the transmission pass from the rest.
- **Needed to close:** save both pictures, find the pixels and which pass writes them, and fix it in the package that
  owns that pass.

### A blurred edge of DOF spreads to one side only

- **What:** a card out of focus in `@margoengine/dof` should spread across its outline, half inside and half outside. A far card
  fades inward and stops dead at its outline (row values 20, 154, 164 and on up to 208, RTX A6000); a near card spreads outward and
  keeps its full value inside (147, then 208).
- **Repro:** `node packages/cinematic/test/browser-check.mjs` draws both cards; print the middle row of the picture in `edge`.
- **Cause:** by design of the gathers, not yet fixed. The far gather takes only samples at the centre's depth or behind it, so sky
  behind a far card takes nothing from the card. The near gather always counts the foreground centre, at full weight.
- **Needed to close:** decide from the published work on gather depth of field how a pixel behind a blurred edge takes its share
  without a sharp subject leaking onto its background, build it in `@margoengine/dof` and test the edge profile on the GPU.

## README examples

### 106 of 767 README examples do not run yet

- **What:** `npm run check:readme-run`, a step of `check:merge` since 2026-11-07, ran 641 of 767 examples that day (RTX A6000,
  Chromium). The other 126 went into `scripts/support/readme-run-known.json`; 106 are left there, each with its error. A new failure fails the step, and
  so does an entry that passes or names an example that is gone. An id is the heading above an example and a hash of its code, so
  an example added above one on the list leaves it alone; changing a listed example changes its id, and the entry moves with it.
- **Repro:** `npm run build:packages`, then `npm run check:readme-run -- --only=<id>` with an id from that list.
- **Cause:** 89 entries start `sample:`. The example names a file of its own (a font, a scan, a rigged model with named joints)
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

### The README check counts a Node example that reaches its time limit as a pass

- **What:** `runInNode` in `scripts/run-readme-examples.mjs` reports `pass` (note "ran to the 30 s limit") for an example
  that is still running at 30 s. Under a whole run's load, examples that fail in a few seconds alone can reach the limit
  and pass, so the same example passes in one run and fails in another, and a known entry can read "passes, still on the
  known list" only because the machine was busy. Seen 2026-11-07 on the Beelink: four rigging entries
  (`readme-corrective-shapes-...-ff3e5c`, `readme-face-tracking-...-8fff06`, `readme-ik-chains-...-138226`,
  `readme-spring-bones-...-a41e82`) passed in a whole run and failed with their listed errors in a run of three packages.
- **Repro:** on a loaded machine, `npm run check:readme-run`, then `npm run check:readme-run -- --packages=rigging`; compare
  the rigging results in the two reports.
- **Cause:** a time limit is taken as "a long-running example, such as a server", not as "unknown"; the result depends on the
  machine's load.
- **Needed to close:** tell a server or loop that is meant to keep running from a slow failure (for example by its
  `listen` port, as `nodeTurns` already reads it), and give the others enough time, or report them as unknown rather than pass.

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

### A Python script test can fail to spawn on Windows, about once in thousands of runs

- **What:** `packages/exporters/tests/precision-native.test.js` failed in `verify` with `spawnSync python3 EINVAL`, on
  the `python -c` call, just after `python3 --version` had worked in the same test (2026-11-06, during a run with other
  lanes loading the machine; `pixel-art.test.js` makes the same call, and one earlier failure of this kind is in the
  history of commit bdcb72659). The test passed in the verify 14 minutes before on the same code.
- **Repro:** none on demand. 3,831 runs of `python3 -c` from 32 parallel spawns in 90 s all started, and the test alone
  passes.
- **Cause, not yet confirmed:** `python3` here is the Microsoft Store app execution alias, and `EINVAL` comes from
  `CreateProcess`. Ruled out: the length of the script, the environment that `scripts/support/record-reads.mjs` passes
  (the same on the call before), and spawn concurrency alone.
- **Needed to close:** catch it again with the Windows error code, or run the tests with a Python that is not the alias
  and see whether it stops.

### A textured glTF does not load in Node

- **What:** in Node on the `webgpu` binding, `loadGLTF` of `@margoengine/gltf-pro` rejects with `glTF image 0 could not be decoded (createImageBitmap is not defined)`, so a server thumbnail of a textured model cannot be made. Untextured scenes, sky and shadows draw.
- **Repro:** `createHeadlessStage({ gpu: create([]), width: 640, height: 360 })`, then `loadGLTF(stage.engine, url)` on `examples/assets/flight-helmet.glb` served over HTTP.
- **Cause:** image decoding uses the browser's `createImageBitmap`, Node has none, and upload uses `copyExternalImageToTexture`, which needs a browser image. A fix needs a decoder hook in the loaders and an upload through `writeTexture`.

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
- **Cause:** `D3DCompile` inlines every function, and its time grows worse than linearly with the inlined size. The
  shader has no function small enough to help: with traversal, direct light, shadow, glass and precise maths all removed
  it still takes 125 s, so no single feature accounts for the time, and no flag or loop attribute reaches it from WebGL.
- **Ruled out:** native trig (the numbers above, and it would change the output); leaving features out per scene (the
  third row drops glass candidates and the shadow walk and still does not finish).
- **Needed to close:** a wavefront split of `radiance` into several fragment passes: first hit, direct light, surface
  sampling, with the path state in float targets. The state is about 18 `vec4` a pixel and a pass has 8 targets, so
  each stage also needs more than one pass or a packed state. Every stage must keep the same maths and output. By the
  stub timings a stage would still take minutes to compile. It is a rewrite of the path loop and was not attempted.
- **Meanwhile:** a page on this route gets the raster view. WebGPU is the route on such a machine where the browser has
  it, and ANGLE Vulkan works.

### Three routes still break WebGPU compatibility-level rules

- **What:** with `allowCompatibilityAdapters` from `@margoengine/webgl2-compat/adapter`, `FogPass` in `@margoengine/sky`, the volumetric pass in `@margoengine/environment` and the spray in `@margoengine/water` take `@builtin(sample_index)` at 4x, found by reading the code and not yet run there. `SurfelPlugin` at 4x refuses with `unsupported`. A page can use the WebGL2 layer instead.
- **Repro:** `npm run build:packages`, add the package to `PACKAGES` in `packages/webgl2-compat/test/adapter-browser.js`, then `node scripts/gpu-lock.mjs run --owner=<you> -- node packages/webgl2-compat/test/adapter-browser.mjs`, and read `packages` in `test-results/compat-adapter.json`.
- **Cause:** the level has no `sample_index` in a fragment shader and no multisampled float format: neither r32float nor rgba16float, so the surfel sums have nothing to add into at 4x.
- **Needed to close:** the routes `Shadows`, `SceneTarget` and eye-dome lighting took: a masked draw per sample (`packages/shared/msaa.js` `copyDepth`, `packages/points/src/plugin.ts` `edlPipelines`). Surfels need sums in a format the level multisamples, or a single-sample pass with its own copy of the scene depth. Then add the names to the list `adapter-browser.mjs` asserts.

### Native glass on a display-encoded target adds its lit draw in encoded values

- **What:** without an HDR scene target (`f.settings.w` below 0.5), the lit draw of gltf-pro's native glass blends over
  the tint draw in display-encoded values. Light adds in linear values, so bright highlights over bright backgrounds
  come out too bright. `materials` `install` and `Transmission` add in linear light since 2026-11-05; only the native
  two-draw path is left.
- **Size:** encoded 0.5 + 0.5 reads 1.0; adding in linear light reads 0.69. Also, the native tint encodes the share and
  multiplies, which is exact only for a power curve: within 1 step above about 40 of 255, up to 2 steps below it.
- **Repro:** glass with a strong highlight over a bright background through `loadGLTF`, on a target with no PostStack,
  against the same scene with `Tonemap`.
- **Cause:** the blend unit reads the target as it is stored, and core's colour targets are plain `bgra8unorm` or
  `rgba8unorm`, so no blend state can decode the destination.
- **Needed to close:** one of two changes, each with a cost that is Scott's to weigh. A scene copy before every native
  glass draw (the light behind read in the shader, as `install` does) adds a copy and a pass per glass surface to the
  default path. An `-srgb` view of the target for the glass pass (blending then runs in linear light in hardware) needs
  core to create its targets with `viewFormats`, a core change for looks, which the freeze rules out. Until then
  `Tonemap` or any PostStack gives the exact result, and `install(model)` does on any target.

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

### text: the colour emoji check needs a colour emoji font on the machine

- **Repro:** `npm run test:browser --workspace @margoengine/text` on a Linux machine with no colour emoji font
  installed (the Ubuntu test server, 2026-10-28) fails "Emoji not drawn in color" (`colorGlyphs` 0) at
  `packages/text/tests/text-browser.js`.
- **Cause:** the check draws an emoji through the system's fonts, so its result depends on the machine. Windows has a
  colour emoji font; a headless Linux server often has none. The engine draws what the system font gives it.
- **Fix needed:** the test brings its own colour glyph source (a standard emoji font file recorded with its source and
  licence in `THIRD-PARTY-NOTICES.md`, or a test font), or it detects that no colour font exists and says so with a
  clear skip message; either with a test that the check fails when colour glyphs are not drawn although a colour
  font is present.


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

- **Own 2D physics steps the 100-row pyramid in 3.6 ms where Box2D v3 takes 1.02 ms** (`packages/physics2d/kernel`,
  perf history entry 83): repro `cargo test --release --manifest-path packages/physics2d/kernel/Cargo.toml --test broad
  -- --include-ignored --nocapture`. Cause, measured: the broad phase was 1.03 ms of 7.2 and now takes 0.29 (the box
  tree); the solver takes 5.1 ms, 14,000 contacts over 4 substeps, each reading and writing the world's large body
  records. Compact solver bodies (perf history entry 85) took the body records off the contact visit with every bit
  the same, and the step barely moved (7.07 against 7.14 ms, paired): each visit waits on the one before it, which
  wrote the same bodies. Colour order (perf history entry 86) removed that wait, no two contacts of a colour sharing a
  moving body, and the scalar solve still took 5.0 ms (paired, against 5.0): a visit is bound by its own arithmetic.
  Four contacts at a time in SIMD lanes (perf history entry 87) took the passes from 4.6 to 1.5 ms and the step to
  3.6 ms, every bit the same. Left, measured by phase: the narrow phase 1.1 ms (next, batch 127 part 6, B4), the passes
  1.5, contact rows and colouring 0.5, the broad phase 0.2; what remains after the narrow phase is planned from a new
  per-phase measurement and the papers. The comparison that counts is the shipped Wasm in the browser (perf history
  entry 88): there Margo steps it in 4.0 to 4.3 ms against Rapier 2D's Wasm 7.8 to 7.9 (Edge 157, Firefox 157), and
  Box2D v3 has no Wasm build here yet (needs Emscripten); its native 1.02 ms is an AVX2 build, eight lanes to Margo's
  four.

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

## Fixed 2026-11-08

| Bug | Cause | Fix | Regression test |
| --- | --- | --- | --- |
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
| A failed `setGeometry` broke later frames: the retry returned with no GPU buffers and the next frame threw `TypeError`, and a failed growth destroyed the buffers of meshes already drawing | `Engine.retain` counted the reference, swapped the instance array and removed the old buffers before the allocation that can throw | Allocation first; `Renderer.add` replaces a held geometry new first, in core and `@margoengine/webgl` | `tests/deep-core-allocation-failure.test.js`, `packages/webgl/test/webgl.test.js` |
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
