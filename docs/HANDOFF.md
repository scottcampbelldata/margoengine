# Margo Engine handoff

Last updated 2026-10-13. Read this first when starting a new session. Update it whenever work lands.

## Goal

Sell Margo as a modern replacement for three.js: looks good, runs smooth on PCs and phones, small, and
modular (load only the packages you use). Rules that follow from that:

- Core + stage (`@margoengine/core`, `margoengine`) stay feature-frozen and under 20,000 gzip bytes (CI gate).
  Scott wants core firmly under 20k; optional packages may grow moderately ("not massive").
- New capability goes in separate, optional, tree-shakable packages.
- Every optimization needs a saved proof (same output, measurably faster) and its byte cost recorded.

## Where things are

- Branch `perf/auto-quality` (not pushed, not merged to `main`). Production (margoengine.com) is unchanged.
- Preview deployment of this branch: https://auto-quality.margoengine.pages.dev
  (`npm run build:site`, then `npx wrangler pages deploy site/dist --project-name margoengine --branch auto-quality --commit-dirty=true`).
- Codex's investigation reports are the dated files in `docs/`; `docs/package-performance-log.md` is its running log.

## What was found

Scott's laptop (ASUS, Intel Arc 140V integrated GPU, 2880x1800 120 Hz) ran the demos at 30-50 FPS while his
iPhone held 60. Causes, from Codex's measurements and ours:

- Desktop tier was chosen by user-agent string, so the laptop got 4x MSAA on HDR targets plus the heaviest
  scene. 4x MSAA was the largest single GPU cost on that GPU.
- One million particles is the second largest cost (about 10 ms of GPU time there).
- On a 120 Hz panel a frame slightly over 16.7 ms lands on the third refresh, so it reads as 40 FPS.
- An iPhone capture (bookmarklet) confirmed the phone really draws 1,000,000 particles at 880x1526 and 58-60 FPS,
  so the gap is hardware/driver throughput, not settings. No rule based on device type picks the right tier.
- Unresolved and parked by Scott: a Galaxy S23 Ultra shows the island at 3-5 FPS (particles Off does not help).

## What was done (all on `perf/auto-quality`)

| Commit | What | Why |
| --- | --- | --- |
| `59350fc` | Measured light tier: `globalThis.margoLow` makes desktops 1x MSAA at DPR 1 (`packages/core/src/quality.ts`, `engine.ts`). `packages/shared/auto-quality.js` watches frame rate, stores `localStorage.margoLow`, reloads once, and caps the light tier at about 60 FPS. Wired into all five demos. Also keeps Codex's package optimizations (net, bvh, usdz CRC, vfx single buffer, shadows, gltf-pro culling, water borrow). | Measure the device instead of guessing; stop 120/40 FPS swings. Core + stage is 19,989 gzip bytes. |
| `af2cb3b` | Animation playback samples into reused buffers. | 2-3.5x faster, identical output, +143 gzip bytes in the optional package. |
| `f05414a` | Proof harness `examples/package-benchmarks/proofs/` (`compare.js`, one `<package>.proof.js` each, `results/*.json`). | Every change must be provable and repeatable. |
| `28f57be` | Island: water 256 segments everywhere; terrain and coastal grid reduced only for phone user agents. | The phone water mesh (64 segments over 400 m) filtered the waves flat and coarsened the shoreline wash. |

Measured on the laptop, light tier, before `28f57be`: 100k particles locked at 60 FPS; 1M particles a steady 45.
Not re-measured since the water restore.

Size facts for the pitch (three.js r186, minimal lit scene, minified / gzip): Margo core + stage 48 kB / 20 kB;
three WebGL 621 kB / 139 kB; three WebGPU 959 kB / 229 kB. Script: `test-results/three-size.mjs` (ignored folder).

## CPU package pass (done, commit `f47ff3f`)

Five parallel workers reviewed 58 packages against baseline `f05414a`; Claude verified the result.

- Kept, with proofs that all pass when re-run alone (slowest case 1.07x, most 1.5-6x): animation, animator,
  bvh, creative, decoders, ecs, exporters, geometry, gltf, gltf-pro, labels, loaders, machinery (CAD parser),
  navmesh, points, post (SSAO), road, splats, splines, taa, terrain, text, wfc.
- Size: about +5.5 kB gzip across those packages (`results/sizes.json`, `proofs/size.js`). Core + stage unchanged.
- Reverted (no gain): fsm, procedural, blender. Already lean: scatter, water, sky, shadows, vfx, clustered, dof,
  tonemap, environment, toon, transitions, stats, react, html, lines, selection, controls, input, cinematic,
  inspector, gizmo, audio, tween, net, navigation, physics, scenery, fbx, usdz-export.
  Not measurable in Node: video, xr, ifc, usdz.
- Fixed: WFC hang with exactly 32 tile types (signed mask comparison).
- Rerun everything: `npm run test:all`, then each `node examples/package-benchmarks/proofs/<name>.proof.js`.
- Known remaining CPU opportunities: geometry `loopSubdivide` (string weld keys), geometry primitive `Builder`
  (pushes to number arrays), ifc vertex arrays, usdz per-corner sampling. CPU tuning will not raise demo FPS;
  the demos are GPU-bound.

## To do next, in order

1. Done (see below): desktops start on the light tier and probe GPU time; no slow phase, no reload.
2. Light tier looks jagged (1x at DPR 1 on HiDPI). Switch built (`?scale=`); measure per the test plan. TAA
   package as the alternative if no scale holds 60.
3. Island at 60 FPS on the laptop with the full water. If short, test terrain mesh 192 -> 96 on the light tier
   (about 0.9 ms) and check the shoreline still lines up.
4. GPU-side optimization (shaders, particles, passes). Must be measured on hardware one change at a time;
   Codex's notes list tried and rejected ideas. Untested lead: VFX does one shared atomic increment per live
   particle (`docs/vfx-workgroup-compaction-2026-10-13.md`).
5. Fair three.js benchmark: check `examples/conveyor-simulator` and `examples/benchmark` are like-for-like.
6. Verified three.js parity matrix, then the feature gaps below.

## Work queue Scott approved (2026-10-14), in order

Global rules: core + stage does not grow without Scott's say-so (limit 20,000; currently 18,580 after his approved
`features` option). Real-GPU browser
checks and benchmarks run one at a time: take the lock with `mkdir C:\Dev\Projects\margo-engine\test-results\gpu.lock`
(fails if held; wait and retry), remove it when done; never measure while other GPU work runs.

0. Verification gates (serial, idle GPU): shader `browser-check.mjs` re-run; LOD/imposter 2,500-object benchmark on a
   quiet GPU; post full stack (SSAO+DOF+Bloom+Tonemap+FXAA) in a real scene, visuals and frame time; native FBX/USD in a
   real browser plus a memory audit (models unloaded/switched destroy their GPU buffers, no leaks). [Done: size
   comparison is `npm run measure:threejs` (scripts/compare-threejs-size.js).] (Security review: later commit reviews in the
   security log report clean; the one timeout was the service being busy.)

Done: core instance storage sized to use (`4d4de78`), kernel -Oz + raw deflate (`c82e119`), WebGL renderer moved to
`@margoengine/webgl` (`1356787`; core + stage 18,554 gzip), `@margoengine/math` (`88517f8`).

1. Top-10 parity gaps (non-core parts): materials package [done: `@margoengine/materials`], glTF extensions/decoders [done: decoder hooks, KHR extensions, physical materials (`c01eedd`)], post stack +
   FXAA [done: `@margoengine/post/stack`, `@margoengine/post/fxaa`; SMAA not done], raycast/pick glTF models + DragControls [running], environment IBL apply + background colour + fog [done `269401e`: EnvironmentLighting, Fog, ColorBackground, UltraHDR; light probes (gap 44) and SSAO-on-IBL left],
   orthographic/vertical cameras without core change [done: `@margoengine/cameras`; SSAO, lines/points widths, labels,
   clustered, DOF and splats still assume perspective], WebGL beyond core (gap 8: scope with Scott first).
1b. [done `ed83cb6`; GPU check passed in the worker's tree, re-run on the merged branch pending] Composable shader nodes (`@margoengine/shader`, parity gap 19), moved up after Scott noted three.js's TSL /
   RenderPipeline node workflows (r183 RenderPipeline, r186 pipeline hooks): small typed nodes compiling to WGSL for
   materials and post effects, built on the materials package and the post stack once both APIs settle.
1c. [LOD + imposters done `0fff93c`: about 7-20x less GPU time on a 2,500-instance scene; atlases and vertex animation textures left] Production optimizations (from Scott's three.js conference recap, Paris, Sept 2026): general LOD object (gap 18),
   octahedral imposters, texture atlases (needs texture transforms in materials), vertex animation textures for
   GPU crowds. Imposters and LOD first; they serve CAD/simulator scenes and landing pages alike. Compute nodes belong
   in the 1b shader package.
1d'. Imposter atlas seams: check cell padding/clamping so mips don't bleed between views, and that blending across
   the three nearest views has no snapping while rotating.
1d''. Pipeline cache keyed by shader module + override-constant bitmask, with common permutations pre-warmed, so
   toggling a section plane or fog never stalls on a synchronous compile (pairs with 1e.f).
1d'''. Ambient occlusion attenuates image-based lighting (environment IBL), not only the constant ambient term.
1d. Imposter picking: once the glTF picking worker merges, let a raycast that reaches an object in its imposter level
   accept the bounding-sphere/box hit (distant cards have no triangles). LOD screen levels already follow orthographic
   zoom (done).
1d. Orthographic follow-ups: SSAO, lines/points world widths, labels CSS perspective, clustered froxels, DOF and splats
   assume a perspective camera; fix each in its own package. Optional core hook (Camera.projection + up) would remove
   the cameras package's update replacement; only if Scott wants it.
1e. [a-d running] CAD track (Scott, 2026-10-14: "the smallest, fastest, best CAD engine"; the visualization/interaction layer, not a
   B-rep modelling kernel). Much already exists in @margoengine/machinery: SectionPlanes (with stencil caps),
   ExplodedView, PartInstancer, AssemblyBVH, measurement, annotations, STEP/IGES/STL/OBJ via loadCAD. To do:
   a. Audit and benchmark machinery at CAD scale on real hardware: 10k/50k/100k-part assemblies at 60 FPS, kernel tick
      time per part count (a Node run measured about 12.8 ms per tick at 100,000 entities with 10-deep hierarchies and
      culling, so "<0.5 ms for 50k" claims must be measured before use), pick latency, section-cap correctness.
   b. Feature/crease edge lines: build dihedral-angle edges at import (geometry edgesGeometry exists), draw with
      depth bias via lines, instanced per part, no z-fighting; silhouettes later.
   c. Exploded view and isolation driven from GPU storage buffers (check what ExplodedView does today).
   d. STEP/IGES load cost: measure the OCCT Wasm payload and init time; look for a lighter path.
   f. Specialized pipelines instead of uber-shaders. The cost of one do-everything shader is register pressure: the
      compiler reserves registers for the worst path, cutting how many threads an integrated GPU runs at once.
      (Branches on per-draw uniforms do not diverge; that part of the usual argument is wrong.) Plan: audit every
      pipeline (core PBR, gltf-pro standard/physical, materials modes, machinery sections, shader nodes) for unused
      paths; define four archetypes (cad-basic: colour/metal/rough + key light + IBL; cad-unlit: caps, axes, handles;
      cad-edges: lines with depth bias, no lighting; pbr-advanced: clearcoat/transmission/sheen for the few parts that
      need it); use WebGPU pipeline-overridable constants (`override`) for small toggles such as clipping, fog and IBL
      instead of runtime branches or string patches. Measure GPU time per archetype on the 50k-part scene before and
      after; keep only what measures faster. Core's shader is frozen and already minimal.
   e. A CAD launch demo (large assembly, sections, edges, measurement, ortho views) and an honest comparison page.
1f. Beat-three.js additions (Scott's list, 2026-10-14; checked against the code, modified where noted):
   a. GPU occlusion culling (Hi-Z depth pyramid + indirect draws) in a new optional package. Core's DrawOptions already
      accept `indirect` per batch, so start there; if a core hook turns out to be needed, bring it to Scott first.
   b. Render-bundle replay: measure first. Core already draws one instanced call per distinct geometry, so encoding is
      small when parts share shapes; bundles matter for assemblies with many unique shapes. Use the CAD benchmark's
      encoding numbers to decide.
   c. GPU timing overlay: DONE in core - `Engine.create(canvas, {features: ['timestamp-query']})` (approved by Scott,
      +26 bytes); Stats profiling works with it. Remaining: richer overlay in Stats (VRAM/buffer counts) if wanted.
   d. Contact shadows (ground-plane depth blur) in a new staging package; auto-framing exists already (core
      `camera.fitToBoundingBox` with duration and padding) - add orthographic support in @margoengine/cameras.
   e. Outlines: selection already uses jump-flood outlines; add dashed x-ray outlines for hidden parts and glTF/model
      support (after the picking worker merges).
   f. Text: @margoengine/text is already GPU SDF text (not DOM). Upgrade to MSDF only if corner sharpness at large
      sizes needs it; add instanced dimension callouts that stay sharp at orthographic zoom, tied to machinery's
      annotations.
   g. ViewCube (snap to top/front/right/iso, perspective/orthographic toggle) - new; transform gizmos already exist in
      controls/gizmo, check they keep constant screen size in orthographic.
   h. Shader nodes: fragment `discard` and compute atomics (small, high value).
   i. Shadows: cascades already snap to texels (shadows/src/cascades.ts); verify there is no shimmer when panning in
      orthographic CAD views rather than re-implementing.
   j. Workers and OffscreenCanvas: move FBX/USD/glTF parsing into workers with transferable buffers (machinery CAD and
      decoders already use workers); test core on an OffscreenCanvas (engine sizing falls back to canvas.width, so
      it may already work).
   k. docs/from-threejs.md: side-by-side mapping of common three.js code to Margo.
   l. One-command start: `npm create margo` (or a StackBlitz template) opening a 60 FPS scene with environment
      lighting, orbit controls and the stats overlay; build on the existing starter-vite.
2. Dedupe: two particle systems (creative GPUParticles vs vfx), two bloom paths (post Bloom vs creative
   PostProcessing), three sky implementations (sky, scenery, creative atmosphere).
3. Replace three.js inside fbx and usdz with native parsers [running].
4. Every remaining PARTIAL/MISSING gap in docs/threejs-parity.md that does not need a core change.
5. Math consolidation: fold the duplicated helpers into `@margoengine/math` (list from the math worker:
   shared/math invert+finiteVector users; mat4 multiply in animation, bvh, points, text, exporters, loaders/usdz, usdz;
   mat4 invert in shared, bvh, lines, environment; transformPoint in bvh, lines, controls; compose/decompose in
   exporters, text, loaders/threemf, usdz; euler->quat/slerp in physics, text, controls; frustum planes in bvh, points;
   vector helpers in geometry, controls, audio, bvh, lines, machinery, navmesh, loaders; colour parsing + sRGB decode in
   lines, points, text, loaders/threemf, loaders/engine, splats, core/geometry (core stays as is); seeded PRNGs in points,
   scatter, procedural, creative; ray tests in controls, selection, bvh; per-package math.ts in audio, bvh, controls,
   geometry, lines, physics, points, text). Prove no behaviour change and record bytes per package.
6. Then give Scott the full list of what was done and what remains.

Worker practice: agents run in git worktrees; they must start with `git reset --hard perf/auto-quality` (worktrees
default to an old base). Do not junction the whole node_modules (then `@margoengine/*` resolves to the main checkout's
packages): make a real `node_modules` folder holding junctions to the main checkout's third-party packages and
`@margoengine/*` junctions to the worktree's own packages. Never run a full `npm install` in a worktree; lockfile only
via `npm install --package-lock-only --offline --no-audit --no-fund --ignore-scripts`.

## Pre-launch hardware investigation

- Galaxy S23 (Adreno) 3-5 FPS on the island: audit every render pass's load/store ops; attachments that are not read
  later should use `storeOp: 'discard'` (on tile-based mobile GPUs a needless store flushes tile memory every frame).
  This is a lead to test, not a confirmed cause: particles Off did not help there and other demos run fine on that
  phone. Needs a capture from the device to confirm.

## Launch readiness (Hacker News, YouTube, LinkedIn, X; npm is set up, margoengine.com is live)

Before launch, in addition to the work queue:
- Demos smooth on first load on desktop and phones, including Android. The Galaxy S23 3-5 FPS island issue is parked
  but is a launch risk; revisit before launch.
- Every public number reproducible from the repo: size (core + stage gzip, `npm run measure:size`; three.js comparison
  `npm run measure:threejs`), speed proofs, a fair three.js benchmark.
- Comparison page states limits honestly (WebGPU-first, which packages still use third-party code, unverified devices).
- READMEs and getting-started docs for every package; licence and third-party notices checked.
- API review of the change list before publishing 1.0 to npm.
- Production deploy and npm publish only with Scott's go-ahead each time.

## Feature gaps versus three.js (after optimization; each as an optional package)

Verified matrix: `docs/threejs-parity.md` (153 three.js features: 57 covered, 47 partial, 49 missing; read from
source, not run). Its top gaps: user materials and textures, glTF extensions/Draco/KTX2 wiring, raycasting loaded models,
automatic IBL, background colour/transparent canvas, combinable post effects, orthographic and straight-down cameras,
WebGL2 fallback for packages, a public math library, FXAA/SMAA. Several need core changes (freeze conflicts listed in the
doc); those are Scott's decision. The older summary below predates the audit.

From package descriptions, not yet audited against code:

- Custom materials and shaders (ShaderMaterial / node materials). Largest gap; material graphs stay out of core.
- Extended physical material: clearcoat, transmission, sheen, iridescence, anisotropy.
- Lights and shadows: area and hemisphere lights; point and spot light shadows (today: directional cascades).
- Post effects: screen-space reflections, FXAA or SMAA, motion blur, outline and god-ray passes.
- Scene utilities: decals, reflection probes and cube cameras, a level-of-detail object, an SVG loader.
- Browser reach: most packages are WebGPU-only; three's WebGL renderer runs without WebGPU. State this openly.

## Quality tiers as they work now (`@margoengine/quality`, `packages/quality`)

Apps call `applyQualityTier()` before creating an engine and `watchQuality()` once rendering. Rule from Scott:
engine behaviour belongs in packages, never only in demo code.

- Phones (user agent `Mobi|Android`): 1x MSAA, DPR up to 2, phone scene settings. Unchanged.
- Desktops start on the light tier (1x MSAA, DPR 1, capped at ~60 FPS) unless `localStorage.margoQuality` is
  `'high'`. While light, the watcher times submit-to-`onSubmittedWorkDone` for 120 submissions after a 2 s warm-up;
  90th percentile under `FAST_GPU_MS` (5 ms) stores `'high'` for the next page load, else `'low'`. No reload.
- On the full tier, five consecutive seconds under 55 FPS store `'low'` and reload once.
- Laptop result (Arc 140V, busy machine): stored `'low'`, light tier 53-61 FPS with 100k particles.
- Reset: `localStorage.removeItem('margoQuality')` (the older `margoLow` key is still read as `'low'`).

## Test plan for when the laptop is quiet (close other apps first)

Built and deployed to the preview, not yet measured:

1. Island light tier, full water: https://auto-quality.margoengine.pages.dev/gameplay-sandbox/?quality=low
   (100k and 1M particles). Target: locked 60. If short, try terrain 192 -> 96 on the light tier.
2. Sharper light tier: same page with `&scale=1.25`, `&scale=1.5`, `&scale=2`. Keep the highest scale that holds
   60, then set it as the default (`scale` fallback in `packages/quality/src/index.ts`).
3. Full tier for comparison: `?quality=high`.
4. three.js comparison (`examples/conveyor-simulator`, see its README; needs `git lfs pull` and a local HTTP
   server): Margo page vs three page vs three page with `?renderer=webgpu`, with Chromium launched using
   `--disable-gpu-vsync --disable-frame-rate-limit`. Not yet run since the WebGPU option was added.
5. VFX workgroup compaction GPU timing (Codex's prepared harness, correctness already passed headless):
   `node test-results/vfx-compaction-chain-timing.mjs --run --label=chain-v1`. Note: `test-results/` is git-ignored,
   so this harness exists only on this laptop.
6. UNCOMMITTED, written while the laptop was busy: `packages/geometry/src/subdivide.ts` (loopSubdivide without
   per-vertex strings, per-edge arrays or Sets). Prove it with
   `node examples/package-benchmarks/proofs/geometry-subdivide.proof.js` (baseline `bdb7521`), run
   `npm run test:all`, then commit or revert. It type-checks; nothing else about it has been run.

## Known issues and caveats
- Pending re-verification on the merged branch once workers are idle: `node packages/shader/test/browser-check.mjs`
  (stalled at browser launch while other GPU checks ran), plus each merged package's own `browser-check.mjs`.
- Engine logic moved out of demos (not yet run in a browser): frame pacing `frameDue`/`frameStatus` ->
  `@margoengine/quality`; Citadel `NightAtmosphere` -> `@margoengine/scenery`; Earth `Stars` -> `@margoengine/creative/stars`.
  Verify with `node scripts/modern-night-citadel-tests.js` and by opening the Earth demo.

- The measured tier is remembered per browser with no expiry and no on-page control yet.
- A fast PC sees the light tier on its first page view only; the full tier starts from the next page load.
- `packages/core/src/renderer.ts` requests `timestamp-query` whenever available (for the Stats profiler);
  its runtime cost was never measured.
- Water's 4x path borrows the resolved scene colour; Codex left its pixel/timing acceptance open.
- Earth, meadow and helmet pages build but were not run in a browser after the auto-quality change.
- Frame rates measured while background benchmarks run on the laptop are meaningless (integrated GPU shares
  the CPU's power budget).
