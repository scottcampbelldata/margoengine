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

Done: core instance storage sized to use (`4d4de78`), kernel -Oz + raw deflate (`c82e119`), WebGL renderer moved to
`@margoengine/webgl` (`1356787`; core + stage 18,554 gzip), `@margoengine/math` (`88517f8`).

1. Top-10 parity gaps (non-core parts): materials package [done: `@margoengine/materials`], glTF extensions/decoders [running], post stack +
   FXAA [done: `@margoengine/post/stack`, `@margoengine/post/fxaa`; SMAA not done], raycast/pick glTF models + DragControls, environment IBL apply + background colour + fog,
   orthographic/vertical cameras without core change, WebGL beyond core (gap 8: scope with Scott first).
1b. [running] Composable shader nodes (`@margoengine/shader`, parity gap 19), moved up after Scott noted three.js's TSL /
   RenderPipeline node workflows (r183 RenderPipeline, r186 pipeline hooks): small typed nodes compiling to WGSL for
   materials and post effects, built on the materials package and the post stack once both APIs settle.
1c. Production optimizations (from Scott's three.js conference recap, Paris, Sept 2026): general LOD object (gap 18),
   octahedral imposters, texture atlases (needs texture transforms in materials), vertex animation textures for
   GPU crowds. Imposters and LOD first; they serve CAD/simulator scenes and landing pages alike. Compute nodes belong
   in the 1b shader package.
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

## Launch readiness (Hacker News, YouTube, LinkedIn, X; npm is set up, margoengine.com is live)

Before launch, in addition to the work queue:
- Demos smooth on first load on desktop and phones, including Android. The Galaxy S23 3-5 FPS island issue is parked
  but is a launch risk; revisit before launch.
- Every public number reproducible from the repo: size (core + stage gzip, `npm run measure:size`; three.js comparison
  `test-results/three-size.mjs` should move into `scripts/`), speed proofs, a fair three.js benchmark.
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
