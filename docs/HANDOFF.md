# Margo Engine handoff

Last updated 2026-10-17. Read this first when starting a new session. Update it whenever work lands.

Current parity work (2026-10-17): dispersion, depth/distance materials and back-side-only rendering are on main
(`aa2150c`, `e8befe7`, `95b4eae`). Polygon offset, stencil and color-write controls are on main (`156c4b8`).
Material wireframe is implemented in optional materials/gltf-pro and directional/local/contact shadow consumers;
no core or stage feature is added. The matrix now counts 100 covered / 34 partial /
25 missing of 159 rows. Core + stage measures 21,094 bytes gzip after upstream kernel and Euler lane-view
maintenance, below the strict 25,000-byte ceiling in AGENTS.md. Wireframe adds no core or stage source changes.
Nine stale current-proof references were reconciled against clean upstream `b3ed8ac`; all 15 current proofs and all
nine affected historical proofs pass. The exact comparisons remain in place; evidence and intentional prior changes
are recorded in `docs/whitepaper/claims.md`. Earlier dated measurements below remain historical.

Current launch-gate verification: `npm run check:merge` passes, including the site build and all 55 NVIDIA/Ampere
visual comparisons. The rebased full Node suite passes 2,487 tests; wireframe passes 249 real-GPU checks at actual
1x/4x MSAA, including 24 directional/local/contact shadow cases. Progressive replacement, live flag retention and
exception-safe cleanup have three new regressions. The prior material render-state fixture passed 648 GPU checks.
All seven additional package/interop checks pass, including strict consumers of all 74 packaged modules.
Touched materials/gltf-pro/shadows/clustered/staging hygiene gates have no new violations.
The Windows desktop power probe records actual AC power, and hardware-specific visual profiles preserve the original
Intel references. The NVIDIA reference uses clean `b3ed8ac` rendered sources with four captures per view; its source
and adapter audit is retained beside the profile. Finish actionable PARTIAL rows before MISSING rows; variable-size
`.cube` LUTs are next. Wireframe details and evidence: `docs/materials-wireframe-verification.md`.

## Goal

Sell Margo as a modern replacement for three.js: looks good, runs smooth on PCs and phones, small, and
modular (load only the packages you use). Rules that follow from that:

- Core + stage (`@margoengine/core`, `margoengine`) stay feature-frozen and strictly below 25,000 gzip bytes (CI gate).
  Scott approved the three core hooks under that ceiling; optional packages may grow moderately ("not massive").
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

Size facts for the pitch (three.js 0.186.1, minimal lit scene, minified / gzip, all with the size gate's output options;
`npm run measure:threejs` -> `examples/package-benchmarks/results/threejs-size.json`, 5d): Margo core + stage 45.6 kB /
19.5 kB (WebGPU only); three WebGL 530 kB / 130 kB; three WebGPU 791 kB / 212 kB.

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
   Codex's notes list tried and rejected ideas. VFX done (0b: about 2x less GPU time at 1M; the
   workgroup-compaction lead measured no gain).
5. Fair three.js benchmark: check `examples/conveyor-simulator` and `examples/benchmark` are like-for-like.
6. Verified three.js parity matrix, then the feature gaps below.

## Work queue Scott approved (2026-10-14), in order

CI: GitHub Actions minutes are spent until next month (Scott, 2026-10-14). Until then verify locally before merging:
`npm run verify` (clean package build with the core + stage size gate, catalog, sandbox, all unit tests, the 15 proofs of
ongoing guarantees against the working tree via `npm run proofs -- --current`, about 25 s) and
`npm run verify:full` before anything is pushed (adds the packed-package and interop suites). When minutes return:
the workflow runs on windows-latest (2x minute cost); consider ubuntu-latest, and a fast job per push with the full
suite nightly or manual. Public repositories get free standard Actions minutes, so this eases at launch.

Global rules: core + stage does not grow without Scott's say-so (limit 20,000; currently 18,681 after his approved
`features` option and core hooks). Real-GPU browser
checks and benchmarks run one at a time: take the lock with `mkdir C:\Dev\Projects\margo-engine\test-results\gpu.lock`
(fails if held; wait and retry), remove it when done; never measure while other GPU work runs. Measure only on AC power: check
`(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline` is True and record
it with every number (on battery Windows throttles the CPU/GPU and may drop the display to 60 Hz).

0. [DONE 2026-10-14 on the math-consolidated tip, Arc 140V, AC power before and after every run, GPU lock held; scripts
   and JSON in `examples/package-benchmarks/gates/` and `examples/package-benchmarks/results/gates-*.json`, screenshots
   `test-results/gates-*.png`.] Verification gates:
   - Every browser test once: `node examples/package-benchmarks/gates/run-browser-tests.mjs` (lock + AC per script,
     builds the starters and the usdz fixture first). 39/41 pass (`gates-browser-tests.json`; before the fixes below
     27/39, `gates-browser-tests-before-fixes.json`). Not passing: `modern-hardware-gpu-tests.js` needs a discrete
     NVIDIA/AMD GPU (`GPU_VENDOR`), not applicable on this laptop; `modern-package-tests.js` now installs and packs, then
     failed type-checking README snippets that were fragments. Fixed later the same day: every README snippet is
     self-contained (animation, controls, creative, environment, gltf-pro, machinery, post, sky; gltf-pro's
     `stage.engine.gpu` became `engineRuntime(stage.engine).gpu`), the script also packs materials, decoders, dof and
     tonemap (README imports), gives the packaged React tests the files they read, and aliases each export subpath
     exactly in the browser stage. README type-check, consumer and React unit tests (17/17) now pass. Still failing: the
     browser stage, because `@margoengine/bvh` dist/raycaster.js imports `../../shared/instances.js` (since `c0945b9`;
     bvh builds with plain tsc), which is outside the tarball. Broken for npm users too; needs a bvh build or source fix.
   - Stale tests fixed: postfx DOF uniform 32 -> 48 bytes (see below); WebGL2 paths now pass `fallback: webglRenderer`
     (browser, wrapper, machinery runtime, stress; core needs the fallback since `1356787`); demos that need 4x MSAA or
     unpaced frames load `?quality=high` (grass, extension); sky-fog test uses `sky.tables.view` and its own fog uniform
     (sky internals since `3bab400`); Vite starter status text "Bloom, atmosphere and FX"; package tests parse
     `npm pack --json` after prepack output, allow post's NOTICE.md and pack geometry/lines/text/bvh/math; extension
     test reads the helmet and robot from `examples/assets` (no download).
   - Real bugs fixed: `@margoengine/react` Canvas dropped the `fallback` option (so `backend="webgl2"` could never work);
     the Vite starter had no WebGL fallback (blank on browsers without WebGPU) and now ships `@margoengine/webgl`;
     vfx README sort snippet was not self-contained.
   - Shader browser-check: pass. LOD 2,500 instances (`gates-lod-2500.json`): GPU median 23.2 ms LOD vs 226.9 ms full
     detail (9.8x; empty 3.6 ms), image mean diff 1.72, coverage 0.99. Imposter check (`gates-lod-imposter-check.json`):
     262/262 imposter pixels pick their anchor on GPU and CPU, 1128/1128 full-detail exact, GPU/CPU agree 99.9%; new
     atlas rule has zero bleed at every level.
   - postfx "Near CoC sign/clamp" (`gates-postfx-bisect.json`): fails at `9c761d5` and at `5cf148e`, shader checks pass
     at `5cf148e~1`. Stale test, predates SSAO ortho: `5cf148e` grew the DOF uniform to 48 bytes, the test still bound
     32, bind-group creation failed inside its error scope and the CoC texture read back zero. Test fixed; passes.
   - Post full stack (`gates/post-stack.mjs`, `gates-post-stack.json`): DamagedHelmet + boxes, env IBL, 1280x720 DPR 1,
     4x MSAA, PostStack [SSAO, DOF, Bloom, Tonemap neutral, FXAA]. No black/NaN pixels in any frame; removing each
     effect changes the image (changed pixels, re-run after the SSAO fix below at `9702e57`: SSAO 6.9% (32% with the
     bug), DOF 1.1%, Bloom 0.5%, Tonemap 57%, FXAA 1.9%). GPU per effect (passes each effect begins, median of 8
     alternating rounds x 120 frames, that run): SSAO 2.34 ms, DOF 4.49, Bloom 0.28, Tonemap 0.09, FXAA 0.14, stack
     capture/compose 0.39; post total 7.7 ms vs 0.9 ms for the whole frame without post.
     DOF (64 taps, maxRadius 16, full res) is the cost to look at first. Tonemap 'agx' after Bloom is invisible by
     design (Bloom alone already maps with AgX).
   - DOF made 2-5x cheaper [DONE 2026-10-14, Arc 140V, AC before/after, GPU lock]. Gate `gates/dof.mjs` + `dof.html`
     (`results/gates-dof.json`): same helmet scene, PostStack [DOF, Tonemap], old = DOF built from `5b9dbbd` loaded in
     the same page, 6 alternating rounds x 90 frames, DOF passes only. Median ms old -> new, 720p 4x / 1080p 4x:
     gate focus 3.4 m f/1.4 r16 4.91 -> 1.45 / 8.69 -> 3.26; near 1.6 m 5.15 -> 2.23 / 10.06 -> 4.28; far 12 m
     3.80 -> 0.86 / 8.63 -> 1.69; wide 2 m f/0.35 r32 5.45 -> 2.35 / 10.52 -> 4.84 (1x MSAA columns in the README
     cost table; MSAA does not change DOF work). Quality vs old (8-bit, 720p): mean diff 0.009 / 0.10 / 0 / 0.11,
     max 11 / 118 / 0 / 89, >6 levels on 0.007% / 0.29% / 0 / 0.27% of pixels (single pixels on high-contrast edges
     inside a blur; `test-results/dof-<focus>-{old,new,off}.png`); slow-pan frame-to-frame change equal (gate) or
     lower (near 0.191 vs 0.200). Kept: (1) far gather skipped for in-focus/foreground centers and near taps
     bounded by the largest near radius in the neighbouring 8x8 tiles + 1 px (CoC pass writes tile maxima;
     bit-identical to the 64-tap gather); (2) far taps scale with the disk: 16 to r 2.26, 32 to r 3.19, 64 beyond,
     each a constant-count loop; (3) disks > 3.19 px gathered once per 2x2 block (rgba16float coarse pass) and
     interpolated, 64 taps at depth changes. Rejected (`results/gates-dof-variants-1..4.json`): per-pixel tap count
     ceil(pi r^2) with runtime spiral math (near/wide slower than fixed 64: offsets no longer constant-folded); far
     loop as a WGSL function with a pointer + early-break near loop (+0.3-1 ms vs inline); workgroup atomicMax for
     the tile max (CoC pass 0.05 -> 0.3-0.5 ms; shared-memory max is 0.09-0.13); 2x2 blocks accepted at 10% depth
     without the silhouette fallback (near max diff 184, slower). Not tried: true half-resolution textures, packing
     colour + depth into one fp16 texture (would change the CoC texture the postfx test reads). Size: dist gzip
     5,853 -> 6,761 bytes (+908). `scripts/modern-postfx-tests.js` binds the tile/coarse textures; all its checks
     (incl. Near CoC sign/clamp) pass on the GPU.
   - SSAO with environment IBL (same JSON, `ssaoIbl`): SSAO passes 2.69 ms without IBL, 2.81 ms with it (+0.12 ms,
     inside run-to-run noise): replaying the full lit shader costs nothing measurable here.
     FIXED (`9702e57`): with IBL on, SSAO darkened the floor below a sharp horizontal line and hatched the metal cube.
     Not the ambient replay (read back: margoAmbient continuous across the line, same in stack and standalone). Cause:
     SSAO's extract shader fell back to a camera-facing normal when `dot(n,n)<=1e-8` for n=cross(dy,dx) of
     neighbouring view positions; |n|^2 scales with the pixel footprint^4, so every surface nearer than a fixed depth
     (~4.0 m at 1280x720, fov 60) got normal (0,0,1), sampled into itself and read AO ~0.56 instead of 1.0. A floor seen
     without camera roll has constant view depth per screen row, hence the straight edge. It was always there; the
     constant ambient (0.05) hid it, IBL's ambient (0.21) showed it. Now relative: `dot(n,n)>1e-6*|dx|^2*|dy|^2`. Gate
     floor below the line 19.6 luma darker than no-SSAO -> 0; steel cube 4.5 -> 0.26. `scripts/ssao-gpu-check.js`
     missed it (400x300 canvas, camera 5-7 m away: footprints far above the threshold) and now has an IBL "close" case
     (open floor 2 m away) that fails on the old shader (7.3 darker) and passes now; creases still darken (IBL
     perspective 7.5/4.2, ortho 6.5/4.3), its perspective frames are byte-identical to the unfixed build.
     `proofs/post-ssao-perspective.proof.js` accepts this one shader line; its default ref `12bf774` no longer builds
     (its ssao.ts imports `packages/shared/math.js`, removed by the math consolidation; the harness overlays only
     `packages/post/src` from the ref), so it was run against the pre-fix tip: `node ...proof.js 5b9dbbd` passes
     (3,282 calls identical apart from the extract shader).
   - Loaders + memory (`gates/memory.mjs`, `gates-memory.json`, `test-results/gates-load-*.png`): gltf-pro (DamagedHelmet,
     RobotExpressive, BoxTextured), native FBX (repo `triangle.fbx`; fbx test fixture as zlib binary with skin, blend
     shape, clips), USDA/USDC (repo fixtures), a 50k-triangle USDZ written by exporters, loaders 3MF/PLY/VTK/PCD/OFF all
     load and draw. 20 cycles of load -> render -> unload of all 13: live GPU objects return to the pre-load baseline
     (1 buffer, 2 textures) every cycle, 147 buffers and 40 textures created and destroyed per cycle, zero growth in
     count or bytes from cycle 2 to 20, JS heap -1.5 MB.
   - Helmet SSAO fixture: `examples/assets/damaged-helmet.glb` (Khronos DamagedHelmet, in the repo) is used;
     `modern-extension-tests.js` passes.
   [Done earlier: size comparison is `npm run measure:threejs` (scripts/compare-threejs-size.js).] (Security review: later
   commit reviews in the security log report clean; the one timeout was the service being busy.)

Done: core instance storage sized to use (`4d4de78`), kernel -Oz + raw deflate (`c82e119`), WebGL renderer moved to
`@margoengine/webgl` (`1356787`; core + stage 18,554 gzip), `@margoengine/math` (`88517f8`).

0b. [DONE, see the vfx README "GPU cost"] 1M particles on the laptop light tier. Baseline (island demo, light tier,
   Arc 140V, AC): frame GPU span 15.7 ms at 1M (10.2 ms with particles off), particle passes 5.7 ms: right at the
   16.7 ms edge, hence 40-57 FPS on a 120 Hz panel. Isolated per pass at 1M/1x: simulate 1.6-2.2 ms, draw 2.1-2.8 ms.
   Tried, each against the previous step, 16 alternating rounds (`examples/package-benchmarks/vfx-gpu.mjs`, JSON in
   `examples/package-benchmarks/results/`):
   - Codex's workgroup compaction (one global atomic per 256 particles): REJECTED. Compute unchanged (+0.01/+0.07 ms),
     draw 0.3 ms slower (live-list order). The GPU already handles per-particle atomics well.
   - Writing back only changed fields in the 64-byte record: REJECTED, no change (whole cache lines move either way).
   - Non-instanced draw (3N vertices): REJECTED, no change.
   - KEPT one triangle per billboard instead of a quad: draw -0.34 ms (1x) / -0.24 ms (4x) at 1M; fill-bound 4x
     billboards much faster. At 4x MSAA a triangle covers more samples than the quad, so the fragment shader masks
     to the quad's samples (`multisampled()` in shader.ts).
   - KEPT compute-side frustum culling into a private draw list (`gpuState.visible`; `indirect[1]` still counts live
     particles): draw -0.8/-0.9 ms at 1M, pixel-identical in id order.
   - KEPT hot/cold split of the particle buffer with the angle derived from age: simulate 2.3 -> 1.1 ms at 1M.
   Result at 1M, simulate+draw: 5.00 -> 2.46 ms (1x), 5.12 -> 2.40 ms (4x); 100k 0.28 -> 0.15/0.17 ms. Island demo
   (`vfx-island.mjs`): light 1M span 15.7 -> 13.5 ms, particles 5.7 -> 2.6 ms, 56.7 -> 60 FPS (paced); full tier 1M
   26.2 -> 22.9 ms (the full tier is ~20 ms with particles off, so it misses 60 on this laptop regardless).
   Output: same particle state (angle within 5e-7 rad); in id order 1x pixels differ by at most 0.015 (mean 0.0005),
   4x by at most 0.25 (mean 0.002, 0.11% darker in total), below the old renderer's own A/A blend-order noise (mean
   0.003-0.004, max 0.08-0.10). Sizes (min+gzip, `vfx-size.mjs`): base 5,311 -> 5,709, root 7,260 -> 7,653,
   features unchanged (obstacles 1,366, wrap 437, sort 1,272, texture 750). Particle buffer layout changed (README).
   1M now fits the light tier's 60 FPS in this measurement with ~3 ms headroom; the light-tier default stays 100k
   (Scott's call whether to raise it after checking on the laptop).
1. Top-10 parity gaps (non-core parts): materials package [done: `@margoengine/materials`], glTF extensions/decoders [done: decoder hooks, KHR extensions, physical materials (`c01eedd`)], post stack +
   FXAA [done: `@margoengine/post/stack`, `@margoengine/post/fxaa`; SMAA not done], raycast/pick glTF models + DragControls [running], environment IBL apply + background colour + fog [done `269401e`: EnvironmentLighting, Fog, ColorBackground, UltraHDR; light probes (gap 44) left; SSAO-on-IBL done (1d''')],
   orthographic/vertical cameras without core change [done: `@margoengine/cameras`; lines' world widths too (1d)], WebGL beyond core (gap 8: scope with Scott first).
1b. [done `ed83cb6`; GPU check passed in the worker's tree, re-run on the merged branch pending] Composable shader nodes (`@margoengine/shader`, parity gap 19), moved up after Scott noted three.js's TSL /
   RenderPipeline node workflows (r183 RenderPipeline, r186 pipeline hooks): small typed nodes compiling to WGSL for
   materials and post effects, built on the materials package and the post stack once both APIs settle.
1c. [DONE. LOD + imposters `0fff93c`: about 7-20x less GPU time on a 2,500-instance scene. Texture transforms + atlases:
   materials `uvTransform`/`setUVTransform` (KHR_texture_transform rows shared with gltf-pro's new `textureTransform`),
   `packAtlas`, `transformUVs`; untransformed GPU calls byte-identical (`proofs/materials-uv-transform.proof.js`); 256
   textured boxes 256 -> 1 draw, 8.3 -> 0.05 ms CPU when merged (`proofs/materials-atlas.proof.js`). VAT:
   `@margoengine/animation/vat` (`bakeVAT`, `VATCrowd`, 6.1 kB gzip separate entry): 1,000 walking robots 1 draw and
   <0.01 ms CPU vs 465 ms CPU / 19,000 draws as skinned models (`proofs/animation-vat.proof.js`); real-GPU check
   `node examples/package-benchmarks/atlas-vat/check.mjs` passed on the Arc 140V (AC, Chrome 155): VAT pose matches GPU
   skinning (silhouette IoU 0.98), merged atlas frame = separate (mean diff 0.07/255, 64 -> 1 draws), 1,024 walking robots
   in 1 draw at 0.7-0.9 ms CPU and 11-16 ms GPU per frame (7.4M vertices; machine busy). Left: VAT clip blending, half-float VAT (shadows/IBL for crowds: 5l.j).] Production optimizations (from Scott's three.js conference recap, Paris, Sept 2026): general LOD object (gap 18),
   octahedral imposters, texture atlases (needs texture transforms in materials), vertex animation textures for
   GPU crowds. Imposters and LOD first; they serve CAD/simulator scenes and landing pages alike. Compute nodes belong
   in the 1b shader package.
1d'. [done] Imposter atlas seams: mip bleed (up to 0.43 coverage from neighbouring views at coarse mips) fixed with a
   per-level clamp; snapping (hard 0.5 coverage cut at view midpoints) fixed with a coverage cross-fade and one depth
   parallax step; numbers in packages/lod/README.md, check `node packages/lod/test/imposter-check.mjs`.
1d''. [DONE, "Pipeline toggles 3/n" + "4/n"] Pipeline cache keyed by shader module + override-constant bitmask, with common
   permutations pre-warmed, so toggling a section plane or fog never stalls on a synchronous compile (pairs with 1e.f).
   Done differently where cheaper: `SectionPlanes.enabled` and `Fog.enabled` switch by uniform (clip loop reads 0 planes;
   fog uploads near = far = float max, density 0), so the shader never changes and nothing compiles; while sections are
   off their five cap pipelines compile with createRenderPipelineAsync, and switching on waits for them; FeatureEdges
   compiles its other (section/plain) variant in the background. gltf-pro's pipeline key is now (state, shader-text id,
   alpha-test bit) instead of the whole shader text (a 300-primitive lit draw 10.8 -> 1.3 ms CPU, mock GPU). Real GPU
   (Arc 140V, Edge 1280x720 4x, 1,600 boxes + DamagedHelmet + edges, fresh browser per run, 5 runs): adding the plugin
   when wanted spikes the frame +178 ms (sections, 146-228) / +121 ms (fog, 96-262); switching on a plugin created off at
   load +8.6 ms (sections: the caps' first draw) / -0.4 ms (fog, noise). Off renders the same pixels as absent (0 of
   3.7M channels); GPU frame absent 13.30, off 13.76 (+0.46 ms for the zero-plane loop and zero fog mix), on 16.52 ms.
   Measured first: an async pre-compile of the exact descriptor makes core's later synchronous compile ~5 ms instead of
   ~67 ms, but a package cannot pre-compile core's final shader (later passes patch it further), so the uniform switch
   was used for core-path toggles. Not done: adding/removing an effect still compiles synchronously once (core variant
   and gltf-pro pipelines); IBL has no `enabled` (its off state is the constant ambient, a different shader).
   Scripts/results: examples/package-benchmarks/pipeline-toggles/, results/pipeline-toggles.json.
1d'''. [DONE] Ambient occlusion attenuates image-based lighting (environment IBL), not only the constant ambient term.
   Shader convention `let margoAmbient=` (no imports either way): EnvironmentLighting names its IBL term so; SSAO and
   glTF-pro's ambient replay return it, IBL diffuse and specular occluded by the same AO (specular approximation).
   Real-GPU: `node scripts/ssao-gpu-check.js` (creases darken vs IBL alone, open faces unchanged).
1d. [done] Imposter picking: `LODSystem.pickProxies()` hook; bvh Raycaster and selection Picking hit imposter-level
   objects through their bounding sphere (`approximate: true`, anchor + model). LOD screen levels already follow
   orthographic zoom (done).
1d. [DONE: points, labels, clustered, splats, DOF `5cf148e`; SSAO (camera's own projection, signed depth; `scripts/ssao-gpu-check.js`); lines (world widths from the clip matrix's y row; perspective byte-identical, `examples/package-benchmarks/proofs/lines-perspective.proof.js`; ortho unit test, no GPU run)] Orthographic follow-ups: SSAO, lines/points world widths, labels CSS perspective, clustered froxels, DOF and splats
   assume a perspective camera; fix each in its own package. Optional core hook (Camera.projection + up) would remove
   the cameras package's update replacement; only if Scott wants it.
1e. [a-d done, see below] CAD track (Scott, 2026-10-14: "the smallest, fastest, best CAD engine"; the visualization/interaction layer, not a
   B-rep modelling kernel). Much already exists in @margoengine/machinery: SectionPlanes (with stencil caps),
   ExplodedView, PartInstancer, AssemblyBVH, measurement, annotations, STEP/IGES/STL/OBJ via loadCAD. To do:
   a. Audit and benchmark machinery at CAD scale on real hardware: 10k/50k/100k-part assemblies at 60 FPS, kernel tick
      time per part count (a Node run measured about 12.8 ms per tick at 100,000 entities with 10-deep hierarchies and
      culling, so "<0.5 ms for 50k" claims must be measured before use), pick latency, section-cap correctness.
   b. Feature/crease edge lines: build dihedral-angle edges at import (geometry edgesGeometry exists), draw with
      depth bias via lines, instanced per part, no z-fighting; silhouettes later.
   c. Exploded view and isolation driven from GPU storage buffers (check what ExplodedView does today).
   d. STEP/IGES load cost: measure the OCCT Wasm payload and init time; look for a lighter path.
   Done for a-d (see `docs/cad-performance.md`, raw JSON in `examples/package-benchmarks/cad/`): real-GPU numbers at
   10k/50k/90k parts; `@margoengine/machinery/edges` FeatureEdges (instanced, depth-biased, ortho + section aware, compute
   size culling); ExplodedView free at rest; AssemblyBVH two-level (no 1M instanced-triangle cap, rebuild 370x faster).
   Core hot spots for Scott (not changed): kernel recomputes every entity every frame (139-164 ns each, 16 ms at 100k on AC),
   JS batch collection 11 ms at 81k visible, 10 MB instance upload per frame, engine.pick 64 ms at 90k, O(n) mesh removal,
   100k entity cap. OCCT: 3.1 MB gzip Wasm, ~150 ms init, ~1.2-1.5 s parse for a 442 kB STEP.
   f. Specialized pipelines instead of uber-shaders. The cost of one do-everything shader is register pressure: the
      compiler reserves registers for the worst path, cutting how many threads an integrated GPU runs at once.
      (Branches on per-draw uniforms do not diverge; that part of the usual argument is wrong.) Plan: audit every
      pipeline (core PBR, gltf-pro standard/physical, materials modes, machinery sections, shader nodes) for unused
      paths; define four archetypes (cad-basic: colour/metal/rough + key light + IBL; cad-unlit: caps, axes, handles;
      cad-edges: lines with depth bias, no lighting; pbr-advanced: clearcoat/transmission/sheen for the few parts that
      need it); use WebGPU pipeline-overridable constants (`override`) for small toggles such as clipping, fog and IBL
      instead of runtime branches or string patches. Measure GPU time per archetype on the 50k-part scene before and
      after; keep only what measures faster. Core's shader is frozen and already minimal.
      [DONE, "Specialized pipelines 4/n"] Audit: gltf-pro already splits standard/physical (physical compiled only for
      materials using it); materials' shading modes and shader-node materials each compile their own code; machinery
      edges have section/plain variants; caps are own pipelines. The cost found was not register pressure but `discard`:
      any discard in a fragment shader costs early depth testing. gltf-pro's back-face and alpha-mask discards are now
      `override` constants (margoFaceTest off in gltf-pro's own pipelines, where the pipeline already culls back faces;
      margoAlphaTest on only for MASK): full-screen DamagedHelmet 0.852 -> 0.524 ms GPU (timestamp queries, interleaved
      rounds); turning the other uniform toggles (unlit, HDR output, blend alpha) into constants gave 0.721 alone and
      nothing on top, so they stay uniforms. Real-GPU pixel proof vs 15c87f1 (7 material kinds front and back, helmet,
      SSAO G-buffer/ambient passes): 0 of 3.69M channels differ. CAD 50k + edges: the cad-basic (core) and cad-edges
      shaders are unchanged; pass medians core 12.6/17.9 -> 11.5/13.7 ms, edges 3.54/4.52 -> 3.60/3.67 ms (noise;
      cad/results-1ef-*.json). Overrides cannot be used for patches of core's shader (core builds that pipeline), so
      clipping/fog stay uniform-gated (1d''). For Scott, not measured: core's frozen shader culls back faces with
      `if(!facing&&i.material.z<0.5){discard;}` (its pipeline has cullMode none), so every core mesh pays the same
      early-depth cost; per-sidedness pipelines with cullMode would remove it (a core change).
   e. A CAD launch demo (large assembly, sections, edges, measurement, ortho views) and an honest comparison page.
1e'. [DONE 2026-10-14: steps 1, 2, 3 and 5 ported onto perf/auto-quality, one commit each, plus the CAD-controls pole
   fix and the engine.pick OffscreenCanvas fix; core + stage 18,681 -> 19,543 B gzip (+481, +252, +96, +5, +21, +7).
   Quiet-machine before/after (Scott stopped everything else; AC; GPU lock; alternating rounds; docs/cad-performance.md):
   kernel in frame 2.6-4x cheaper everywhere (90k still 16.0 -> 5.5 ms); collection 7.8 -> 0.28 ms at 90k still, 7.6 ->
   1.1 ms at 90k with 1% moving; FPS 50k orbit 49 -> 92, 50k still 53 -> 78, 50k move 54 -> 133, 90k still 33 -> 52,
   90k move 33 -> 43; 90k orbit unchanged 34 -> 33 (GPU-bound, cull result changes every frame); 10k move 207 -> 182
   (GPU time rose, unexplained); engine.pick 43 -> 31 ms at 90k (only via the cheaper update, step 4 not merged).
   Bit-exact: tests/core-dirty-transforms.test.js, real-GPU pixels-check.mjs 0 differing pixels, verify 1,051 pass.
   Instance-buffer contract in core's README; selection's micro pick pass was the only writer (now its own buffer).
   Back-face culling measured on branch scratch/core-backface-cull, not merged: +315 B, see the decisions below.]
   Original decision text: CAD scale is CPU-bound in core; measured on AC, docs/cad-performance.md: at 50k parts the
   frame is 20.9 ms CPU (45 FPS), at 90k 39.1 ms (25 FPS); kernel tick 7.7 / 16.4 ms and JS batch collection 6.2 /
   11.3 ms dominate. Core hot spots: (1) kernel recomputes every entity every frame, even static ones (~150 ns each);
   (2) JS batch collection walks every mesh every frame; (3) the whole instance buffer is uploaded every frame;
   (4) engine.pick re-renders the scene and creates a pipeline per pick (63.5 ms at 90k); (5) removing a mesh scans
   all meshes (disposing a 90k assembly takes minutes); (6) the 100,000-entity cap. PROTOTYPE DONE, AWAITING SCOTT:
   branch `worktree-agent-a46261c57b837ecd0` (base 7980c86, one commit per step; needs a rebase onto the current tip,
   expect conflicts in selection and scripts/build-modern.js). Core+stage 18,681 -> 19,921 with all five steps:
   s1 kernel skips unchanged entities (+481; 90k tick 16.5 -> 4.4 ms), s2 reuse last frame's instances (+252),
   s3 upload only changed ranges (+96), s4 pick reuses pipeline + draws only parts under the pixel (+406; 90k pick
   57.6 -> ~12 ms), s5 fast removal scan (+5; dispose 90k 48 s -> 20 ms). 90k still: 27 -> 39 FPS; 50k 1% moving:
   45 -> 103 FPS; 50k orbit 46 -> 79 FPS; 90k orbit only 26 -> 30 (culling changes each frame; GPU culling 1f.a is
   the route). Costs: +66 B per kernel entity slot, instance-buffer contract (writers must not touch core's buffers),
   rebuilt Wasm kernel. Raw JSON examples/package-benchmarks/cad/results-s0..s5-*.json on that branch.
1f. Beat-three.js additions (Scott's list, 2026-10-14; checked against the code, modified where noted):
   a. [DONE: `@margoengine/culling` `CulledInstances`, 7,015 B gzip, no core change. Parts uploaded once, compute pass
      tests frustum (+ optional Hi-Z occlusion from a depth prepass of last frame's large visible parts, so no one-frame
      lag), stable in-order compaction, indirect draws with core's frame shader. 90k parts: CPU 23.4 -> 0.4-0.6 ms per
      frame; FPS orbit 36 -> 52, still 32 -> 53, grazing 48 -> 98 (frustum mode). Occlusion does not pay on the open
      sheet (nothing extra culled from above; +1-2 ms GPU) but does on a stacked block (90k orbit 28 -> 37 FPS, 81k -> 21k
      parts drawn), so `frustum` is the default. Real-GPU pixel check: 0 differing pixels over 640 frames vs drawing
      everything, coplanar twins unchanged. Limits: parts are not core meshes (no engine.pick, hierarchy, ExplodedView,
      FeatureEdges, section caps, shadows). Numbers: docs/cad-performance.md; JSON results-culling.json. Follow-ups:
      single-pass Hi-Z downsample, picking via instance IDs, FeatureEdges/caps over these parts.]
      GPU occlusion culling (Hi-Z depth pyramid + indirect draws) in a new optional package. Core's DrawOptions already
      accept `indirect` per batch, so start there; if a core hook turns out to be needed, bring it to Scott first.
   b. Render-bundle replay: measure first. Core already draws one instanced call per distinct geometry, so encoding is
      small when parts share shapes; bundles matter for assemblies with many unique shapes. Use the CAD benchmark's
      encoding numbers to decide.
   c. GPU timing overlay: DONE in core - `Engine.create(canvas, {features: ['timestamp-query']})` (approved by Scott,
      +26 bytes); Stats profiling works with it. Remaining: richer overlay in Stats (VRAM/buffer counts) if wanted.
   d. [DONE] Contact shadows (ground-plane depth blur) in a new staging package; auto-framing exists already (core
      `camera.fitToBoundingBox` with duration and padding) - add orthographic support in @margoengine/cameras.
      `@margoengine/staging` `ContactShadows.attach(engine, {size, height, blur, opacity, color, resolution, static})`,
      `add(model|mesh)`, `fit(model.bounds)`, `invalidate()`, `dispose()` (5.0 kB min+gzip): meshes drawn from the ground
      looking up into an r16float texture (max blend, no depth buffer), 2x separable blur, shadow-catcher plane at
      frame-graph order 0.5 (after core, before glTF models). Real GPU (`node packages/staging/test/browser-check.mjs`,
      Arc 140V, AC, 1280x720): pixel checks pass (contact darkens, mesh above `height` casts nothing, floor outside and
      mesh tops unchanged); texture update 0.05/0.25/0.9-1.1 ms at 256/512/1024, plane 0.02-0.04 ms; `static: true`
      skips the update while nothing moves. Cameras: `projection.fit(bounds, {aspect, duration, padding})` takes the flat
      bounds array; orthographic fits by zoom to the box's projected outline (keeps direction and distance, animated
      through `onPreUpdate`), perspective delegates to core. Cameras 1,072 -> 1,931 B min+gzip.
   e. [DONE] Outlines: selection already uses jump-flood outlines; add dashed x-ray outlines for hidden parts and glTF/model
      support (after the picking worker merges). Done: `Selection` option `xray` (`true` or `{dash, opacity, color,
      width}`; dash 0 = solid dimmer lines), mutable per frame; `name` option for one Selection per selection set. The
      whole selection is marked again into the same mask without the depth test (core meshes via the draw hook,
      gltf-pro/materials primitives via the model replay), jump-flooded and composited blended/dashed before the
      visible outline; perspective and ortho alike. Off = byte-identical GPU calls to 46f9484
      (`proofs/selection-xray-off.proof.js`, 10,586 calls at 1x/4x). Selection 9,504 -> 10,321 min+gzip (+817).
      Real-GPU `node packages/selection/test/xray.browser.mjs`. Hidden lines trace the selection's silhouette only.
   f. [DONE] Text: @margoengine/text is already GPU SDF text (not DOM). Upgrade to MSDF only if corner sharpness at large
      sizes needs it; add instanced dimension callouts that stay sharp at orthographic zoom, tied to machinery's
      annotations. Done: `@margoengine/machinery/dimensions` `Dimensions.attach(engine, options)`: linear (machinery
      `Dimension`/anchors as is), angle and radius/diameter callouts, values from `measureDistance`; laid out in CSS
      pixels per frame and placed in the view plane at each anchor's depth, so constant pixel size at any ortho zoom and
      in perspective; all lines one `@margoengine/lines` segment list (one draw), labels one text block each. New entry
      3,973 min+gzip (machinery root unchanged; lines + text added as machinery dependencies). Real-GPU
      `node packages/machinery/test/dimensions-check.mjs`. MSDF not needed for this.
   g. [done: `@margoengine/viewcube` (DOM/CSS 3D, 2.8 kB gzip, real-browser click check); the gizmo was NOT constant-size
      in orthographic (sized and picked by camera distance): fixed in controls/view.ts + transform.ts, orbit pan too]
      ViewCube (snap to top/front/right/iso, perspective/orthographic toggle) - new; transform gizmos already exist in
      controls/gizmo, check they keep constant screen size in orthographic.
   h. [done: `discard(cond, value)`, `storage(..., {atomic: true})` with atomicAdd/Max/Min/Load/Store; real-GPU check
      passed on Intel Arc] Shader nodes: fragment `discard` and compute atomics (small, high value).
   i. [DONE, verified, no fix needed] Shadows: cascades already snap to texels (shadows/src/cascades.ts); verify there is no shimmer when panning in
      orthographic CAD views rather than re-implementing. `node examples/package-benchmarks/shadow-shimmer.mjs`
      (JSON `results/shadow-shimmer.json`; Arc 140V, AC, 800x600 4x MSAA, 2048 maps, 64 frames, 0.25 px per frame;
      counts are shadow-edge (penumbra) pixels changed by more than 2 levels). Static noise floor 0. Orthographic pan,
      motion-compensated (frame i vs i+4 shifted 1 px): 0.57 of 14,423 per frame (max 10). Live vs cascades fitted to
      the first camera: ortho 9.7 (max 14), perspective 2.9 of 4,276 (max 7). Control, a 0.01 degree per frame light
      turn (real shimmer): 194 per frame (max 466). Ortho zoom (`projection.zoom`): cascade matrices bit-identical, map
      cached. Dolly (ortho, fixed height): texel lattice world-locked (radii constant, centres integral to 6e-14 texel);
      112 per frame, of which 63 where the floor point changes cascade (the split distance sweeping, inherent to CSM)
      and 49 elsewhere (0.36%, isolated flips on the thin posts as depth re-quantizes when the snapped centre steps).
   j. [DONE] Workers and OffscreenCanvas: move FBX/USD/glTF parsing into workers with transferable buffers (machinery CAD and
      decoders already use workers); test core on an OffscreenCanvas (engine sizing falls back to canvas.width, so
      it may already work).
      Done: opt-in `/worker` entries, each falling back to the calling thread without `Worker` (SSR, Node):
      `@margoengine/gltf-pro/worker` (`loadGLTFInWorker`, `parseGLTFInWorker`, `modelFromPrepared`; also falls back when
      `decoders` are passed), `@margoengine/gltf-pro/prepare` (`prepareGLTF`, `prepareAsset`, for other workers),
      `@margoengine/fbx/worker` (`loadFBXInWorker`, `parseFBXInWorker`: FBX -> GLB -> prepare in one worker),
      `@margoengine/usdz/worker` (`loadUSDZInWorker`, `parseUSDInWorker`: USDZ/USDC/USDA by content; `USDAsset.images()`
      split out of `create`), `@margoengine/loaders/worker` (`parseUSDZInWorker`, `parseUSDAInWorker`, LoaderError kept).
      The worker fetches, parses, decodes accessors (geometry, skins, morph targets, animation samplers), packs the
      80-byte vertices and decodes images; ArrayBuffers and ImageBitmaps are transferred both ways (a whole input
      ArrayBuffer is moved/detached, views copied); the main thread builds the PBRModel and uploads to the GPU. gltf-pro's
      packing moved verbatim to `pack.ts`; PBRModel uses worker-packed geometry via an internal WeakMap keyed by
      primitive (a primitive the worker could not pack is packed, and fails, on the main thread as before). Worker scripts
      are self-contained classic workers in `dist/workers/` (`scripts/build-workers.js`, any `src/*.worker.ts`), started
      with `new URL('./workers/x.js?no-inline', import.meta.url)`, so bundlers copy them as assets and apps without a
      `/worker` import ship none of it. One worker per load (pool if many parallel loads ever matter).
      Equality proof: `packages/{gltf-pro,usdz,loaders}/tests/worker.test.js`, `packages/fbx/test/worker.test.js` run the
      built worker script in-process with request and reply through structuredClone and the real transfer lists, then
      compare doc, buffers, every accessor, packed vertices/indices, materials, images and the engine transform store
      byte for byte with the main-thread parse (DamagedHelmet, RobotExpressive, generated 2x66k-vertex GLB; rich, textured
      and grid FBX; USDA, USDC, textured USDZ, 50k-triangle USDZ; loaders USDZ/USDA); a mutated float/accessor/node is caught.
      Main-thread blocking (`node examples/package-benchmarks/workers/run.mjs`, `results/workers.json`; Edge 155 headless,
      Arc 140V, AC before/after, GPU lock; engine rendering every frame during the load; medians of rounds 1-5, round 0
      discarded; longest long task / total blocking time / max rAF gap, main -> worker):
      FBX 160k-quad grid (5.5 MB) 1162 / 1112 / 1167 ms -> 0 / 0 / 217 ms (load 1.33 -> 1.66 s);
      USDZ 200k-triangle knot (12.5 MB) 697 / 647 / 692 -> 0 / 0 / 50 (load 0.83 -> 1.04 s);
      generated GLB 642k vertices, 1.28M triangles (41 MB) 222 / 172 / 217 -> 0 / 0 / 58 (load 0.60 -> 0.68 s);
      DamagedHelmet 0 / 0 / 75 -> 0 / 0 / 117 (load 0.50 -> 0.57 s; main had one 143 ms task in the cold round 0, worker
      none). Worker loads cost 10-25% more wall time (worker start + script parse). Worker mode never produced a long task;
      its occasional 100-240 ms rAF gaps come with no main-thread task (GPU upload or GC; not attributed). GPU upload and
      mip generation stay on the main thread. Edge cases: FBX `resourcePath` '' resolves to the page folder (identical for
      relative texture names); the worker repeats parseFBX's 16M-pixel total texture budget.
      OffscreenCanvas (`examples/package-benchmarks/workers/offscreen.html` + `offscreen.worker.js`, same run, Edge 155 and
      Chrome 155, screenshots `test-results/workers-offscreen-*.png`): `Engine.create(canvas.transferControlToOffscreen())`
      in a module worker works: render, `start()`/`stop()` (rAF exists in dedicated workers), resizing by setting
      canvas.width/height (no clientWidth, devicePixelRatio undefined -> 1), gltf-pro `loadGLTF` (fetch +
      createImageBitmap), `loadGLTFInWorker` (nested worker), decoders `DracoDecoder` (nested pool), PostStack [Bloom, FXAA],
      selection `Picking`; no GPU errors, pixels drawn. Broken: core `engine.pick` returns null (it divides by
      canvas.clientWidth, undefined -> NaN). Package fixes made: decoders' `requireWorkers` rejected worker contexts
      (`typeof window`), now checks `typeof Worker` only; selection `Picking` divided by clientWidth, now
      `clientWidth || width` (coordinates are canvas pixels on an OffscreenCanvas). DOM-bound by design (need the app to
      forward events/elements): core `CADCameraControls`, controls, stats, html, labels, input, inspector, viewcube,
      machinery overlays, margoengine `createStage` (querySelector, style). CORE CHANGE FOR SCOTT (not made): in
      `Engine.pick` use `const w=this.canvas.clientWidth||this.canvas.width,h=this.canvas.clientHeight||this.canvas.height`
      for the bounds check and the `x*this.canvas.width/w, y*this.canvas.height/h` scaling; core + stage 18,681 -> 18,689
      gzip (+8, measured on the built dist).
      Sizes (min+gzip): roots gltf-pro 16,052 -> 16,075 before the instancing merge (17,866 with it), usdz 11,333 -> 11,371,
      fbx/loaders unchanged; the worker pre-decodes EXT_mesh_gpu_instancing accessors too (equality case in the test); new entries (dist file
      gzip) gltf-pro/worker 1.3 kB, fbx/worker 1.2 kB, usdz/worker 1.3 kB, loaders/worker 1.6 kB; worker scripts (minified
      + gzip) gltf 5.5 kB, fbx 16.7 kB, usdz 25.9 kB, loaders usd 6.6 kB; core + stage 18,681 unchanged.
   k. [DONE] docs/from-threejs.md: side-by-side mapping of common three.js code to Margo. Linked from README and
      docs/README.md. Every Margo snippet (```ts blocks) is type-checked against the built packages by
      `tests/from-threejs-snippets.test.js` (part of the unit run). API rough edges found while writing are listed under
      "API rough edges before 1.0" below.
   l. [DONE, not published] One-command start: `npm create margo@latest my-app` (also pnpm/yarn/bun create).
      `tools/create-margo` (not a workspace: tests/modern-support.test.js requires non-package workspaces to be
      private), zero dependencies, no prompts, refuses a non-empty directory. Template: Vite + TypeScript, one
      `src/main.ts` (quality tier before `Engine.create`, `paceEngine`, `watchQuality`, procedural-studio IBL +
      blurred environment background, OrbitControls with damping, Stats overlay, torus knot/sphere/box on a pedestal;
      resize is CSS-only), caret ranges on the 0.1.0 packages, README linking docs/from-threejs.md and
      margoengine.com. Production bundle 36,180 bytes gzip (one JS file). `tests/create-margo.test.js` (in `verify`)
      scaffolds into a temp dir and runs `tsc` + `vite build` against the local packages through node_modules
      links; `node tools/create-margo/test/browser-check.mjs` (GPU lock) renders it under `vite` dev: passed on Arc
      140V, Stats 60 FPS on the light tier. examples/vite (starter-vite) still builds against the current packages and
      was left as is (its React page is the kitchen-sink demo). `npm view create-margo` was a 404 on 2026-10-14
      (no such package; npm can still refuse a name at publish time); publish with `npm publish tools/create-margo` after the @margoengine packages.
1g. Modernization (from the 2026-10-14 source scan; no legacy browser APIs, deprecated WebGPU calls or old WGSL found):
   a. [DONE] Drop the `webkitAudioContext` fallback in packages/audio/src/listener.ts (every WebGPU browser has AudioContext).
   b. Replace the `as any` casts with real types (decoders codec globals may stay; exporters/scene.ts, lod/index.ts,
      materials/index.ts, shader/node.ts, usdz/crate.ts).
   c. Replace WGSL string patching (shadows, tonemap, toon, environment, materials, shader) with override constants,
      specialized pipelines (1e.f) and shader nodes, so one renamed shader line cannot silently break another package.
      [DONE, "Shader contracts 1/n" + "2/n"; docs/shader-contracts.md] Inventory: ~45 cross-package anchors. (1) gltf-pro's
      PBR shader patched by shadows (`direct+ambient(s)`), clustered (`var color=`), environment IBL (`fn ambient`,
      `var color=…+s.emissive;`) and fog (the ACES line), plus gltf-pro's own `includes('let margoAmbient=')` for the SSAO
      replay: replaced by declared lighting hooks (`LightingEffect.pbr(group)` -> `PBRLighting` {declarations, direct,
      light, ambient, output}, contract v1, gltf-pro README), composed by gltf-pro; recorded-GPU-call proof
      (proofs/gltf-pro-lighting-hooks.proof.js): identical to 15c87f1. (2) gltf-pro text patched by materials (map
      samples, fragment head), shader-node NodeMaterial (surface end, vertex position, struct Out) and LOD baking
      (fragment head): kept (they rewrite sampling/vertex code, not lighting; all already throw on a missing anchor);
      anchors listed and tested. (3) core's frozen shader patched by sections, shadows, clustered, environment IBL/fog,
      sky, taa, tonemap, post (stack, bloom, SSAO capture + ambient replay incl. the `let margoAmbient=` convention),
      creative (post, toon), dof, selection picking, scatter, terrain colors, plus shared meshVertex's copy of core's
      inputs (toon, selection): must stay text (core frozen, no overrides possible on core's pipeline); every anchor is in
      tests/shader-contracts.test.js, which fails naming the package if it stops occurring exactly once. Intra-package
      patches (gltf-pro physical variant, machinery caps, vfx features, points EDL, sky fog, water spray/HORIZON, post
      composites) left as is: owner and patcher are the same package and its own tests cover them. Silent no-op patches
      left silent (taa `o.clip=frame.camera*p`, tonemap/post/creative/dof capture regex, toon, scatter, terrain): the
      contract test covers the core side; making them throw would touch post/dof, which another worker owns.
   d. [DONE: core hooks merged `571b2a0` (camera.up, camera.project, engine.pace, engine.plugins), +101 bytes;
      packages migrated: cameras uses project/up (no update replacement, no off-vertical nudge; shared viewMatrix reads
      camera.up, as do points' basis and labels' lookAtView), quality caps via engine.pace (`paceEngine(engine)`, no global rAF wrap), selection reads
      engine.plugins (environment never read the map; bvh's raycaster still does, left for the bvh worker), materials
      uses gltf-pro's new `material.renderState` pipeline hook (proxy deleted). Citadel keeps frameDue (own loop).] A small explicit set of core hooks (camera projection, frame pacing, plugin lookup,
      pipeline state) to replace today's workarounds: cameras replacing camera.update on the instance, quality/pacing
      wrapping requestAnimationFrame globally, environment and selection reading core's private plugin map, materials
      proxying createRenderPipeline. Costs core bytes; these become public API, so decide before launch.
   e. [DONE: 5k phase 1] DECISION FOR SCOTT before 1.0: reformat the dense single-line TypeScript to conventional readable style
      (automated, no behaviour change; minifiers already handle shipped size) to lower the barrier for contributors.
   f. [EVALUATED, recommendation only; workers + OffscreenCanvas done in 1f.j] Evaluate newer platform features:
      Float16Array for half-float data, Symbol.dispose / `using` for engine object
      cleanup, more parsing in workers + OffscreenCanvas (with 1f.j).
      Real-browser check (offscreen.html, `results/workers.json`): Edge 155 and Chrome 155 have Float16Array,
      Math.f16round, DataView get/setFloat16, Symbol.dispose/asyncDispose, DisposableStack and `using` syntax.
      Support from knowledge (mid-2026, verify Safari before relying on it): Float16Array Chrome/Edge 135, Firefox 129,
      Safari 18.2 (Baseline 2025; every WebGPU browser except Chrome/Edge 113-134 has it). Explicit resource management
      (`using`, Symbol.dispose, DisposableStack) Chrome/Edge 134, Firefox 141; Safari had not shipped it, so it is not
      Baseline. Recommendation: (1) `using`: do not add now. Core is frozen (Engine/Mesh are the objects worth it), each
      `[Symbol.dispose]()` alias costs bytes in every package, and `using` needs the symbol at runtime (Safari). Apps can
      already write `using s = new DisposableStack(); s.defer(() => model.destroy())`. Revisit at 1.x when Safari ships:
      add `[Symbol.dispose]` aliases to Engine, PBRModel and the attach() effects in one batch (core change, Scott).
      [Superseded 2026-10-14: Scott approved `[Symbol.dispose]` for packages (not core); done with a guarded key, see
      "Scott's decisions (2026-10-14, 17:10)".]
      (2) Float16Array: not zero-change, so not done. environment's `floatToHalf` rounds double -> float32 -> half (double
      rounding) where Float16Array rounds once, so some encodes would change; EXR HALF decode via a Float16Array view is
      exact but needs a fallback for Chrome 113-134 (more bytes, not fewer). Use it in new code with a feature check
      where half data is bulk (half-float VAT, environment uploads), with a proof per change.
   g. Full read-only audit of all 68 packages listing each modernization finding with file and line, then fix in batches.
1g'. [DONE: exact poles; the cube sets `camera.up` to the arrival heading on the pole and restores the previous up off
   it or on dispose; a CameraProjection's vertical up is left alone; unit-tested, no browser run. OrbitControls now takes the heading
   from `camera.up` on an exact pole; core's CADCameraControls.orbit still leaves a pole at azimuth 0 (a 90° turn after
   a top view reached from the side) — a core change, needs Scott's approval] ViewCube follow-up: use
   core's new `camera.up` for exact top/bottom views instead of stopping 1e-6 rad off the pole.
1h. Less fragile (2026-10-14):
   a. [DONE] Derive the package build order from package.json dependencies (topological sort) instead of the hand-written
      lists in scripts/build-modern.js (the controls-needs-bvh break came from that list). Now one pass in
      build-modern.js over every workspace package in `scripts/package-order.js` order (dependencies, peer and dev
      `@margoengine/*`/`margoengine`; a cycle fails naming its members; `tests/package-order.test.js`). A package's own
      `build` script runs in place of the built-in pipeline, so the 17 duplicate builds (and the separate
      `npm run build --workspace packages` step) are gone. Every `packages/*/dist` file is byte-identical to the old
      two-step build (526 files hashed). No undeclared build-time dependency was found. Rule: a package that needs
      another's dist at build time must declare it in package.json.
   b. [DONE] docs/catalog.json is generated at the end of build-modern.js (so by `build:packages` and `modern:build`); the
      separate step left `verify`; `npm run catalog:build` still works alone. The generator writes only on a real
      change and keeps the checkout's line endings, and keeps the last `published` value when the registry is
      unreachable (offline builds no longer fail).
   c. [DONE] Public API snapshots: `api/<package>[.<entry>].api.md`, one per package.json `exports` entry (129), each
      exported name with its declaration from dist/*.d.ts (comments and private members dropped), the package-local
      types those use but the entry does not export, and `import` lines for other packages' types. `scripts/api-report.js`
      reads them with TypeScript 7's checker (`typescript/unstable/sync`, no new dependency; unstable API, so a
      TypeScript bump may need edits). `npm run api:check` (in `verify` after build:packages, ~3 s) fails with a diff;
      `npm run api:update` rewrites the reports and `docs/api-surface.md` (export counts per entry, unexported types,
      `any` count, gzip) for the 1.0 API review.
   d. [DONE: 5k phase 1, Biome 2.5.15] Add a linter/formatter (Biome: one fast dev tool, no runtime cost) with a small rule set: no `any`, no unused
      code, consistent imports. Pairs with the 1g.e reformat decision.
   e. packages/shared is copied into every package bundle (e.g. sceneSamples, math, msaa, demo-frame); copies can drift
      between packages in one app. Decide: publish it as an internal versioned package, or keep copying but test
      that all copies in a build are identical.
   f. [DONE] Standing visual-regression suite for the site demos: `npm run visual:check` / `npm run visual:update`
      (`scripts/visual-regression.js`, baselines + `tests/visual/manifest.json`; how to run: Worker practice).
      22 views of the 8 demos `scripts/build-site.js` serves: `/night-citadel/`, `/gameplay-sandbox/`,
      `/demos/character-animation.html` (`/demos/robot-expressive.html` is the same page, not captured twice),
      `/demos/flight-helmet.html` (was `/demos/damaged-helmet.html`, see LAUNCH GATES #5), `/demos/windy-meadow.html`, `/demos/earth/`, `/demos/dof/`, `/demos/tonemap/`; each at
      1280x720 `?quality=high` and `?quality=low`, and as an iPhone (390x844, DPR 3, iPhone UA = phone tier); dof and
      tonemap read no tier, so only high + phone. The landing page and /catalog/ are static and not captured.
      Capture contract (no demo or package code changed): fresh browser context with prefers-reduced-motion: reduce,
      which every demo already honours as its pause (delta 0 / animation, rotation or wind paused: a still frame at
      t = 0), the demo's own readiness signal (`submitPrincipalScene` result, `data-ready`, and the helmet's and Earth's
      full-detail upgrade on the high tier), 1 s settle + 4 frames, FPS/telemetry text masked. Images are box-downsampled
      (desktop 640x360, phone 195x422) and stored as 8-bit RGB PNG: 1.8 MB for all 22 (largest: meadow 245 kB) — enough
      to catch a 1-level shift; full-resolution PNGs would be ~15-20 MB per re-baseline in git history.
      Metrics per view: `changed` (share of pixels with any difference) and `hot` (share off by > 24 levels) gated;
      tolerance = worst pairwise noise of 4 separate browser launches x 3 + (0.05% changed, 0.02% hot). (x1.5 was too
      tight: a clean Citadel phone run hit 2.3x its 4-run floor; particles reflected in the water vary a lot.)
      Noise floors (Arc 140V, Edge 155, core 0ed56b9): 16 of 22 views are bit-identical run to run (robot, helmet,
      meadow, Earth, dof, tonemap). Night Citadel (changed 0.003/0.07/0.43% high/light/phone) and the island sandbox
      (changed 5.2/1.3/1.6%, hot 0.34/0.07/0.04%) are not: VFX respawn seeds come from `atomicAdd(&respawn.sequence)` and the draw list from
      `atomicAdd(&drawn.instanceCount)` (`packages/vfx/src/shader.ts` lines 42 and 58), so which particle gets which seed
      and the blend order follow GPU thread scheduling. Seeding from the particle index alone would make VFX demos
      deterministic and let the sandbox tolerance drop ~10x (a package change, not done).
      Proof it catches real changes (scratch build, then reverted): robot studio light green 0.93 -> 0.91 fails all
      three robot views (22.6% of pixels changed by 1 level; limit 0.05%); sandbox golden-hour sun green 0.69 -> 0.67
      fails light (10.3% vs 4.0%) and phone (7.6% vs 4.7%) and stays under the high view's particle-noise limit (13.9%
      vs 15.6%); every other demo passes. A first mean-diff gate missed the sun change in all three views (particle
      noise dominated the mean), so the gate became `changed`. Two clean 3-run checks (6 captures per view): all within the x3 limits. The new core (0ed56b9: kernel skips unchanged entities, instance reuse, ranged
      uploads) renders every view bit-identical to the pre-merge baselines (only the VFX noise above).
   g. Changesets (or similar) for versioning and changelogs before the first npm publish; consistent peer ranges.
   h. [CONVENTION DONE with 5k phase 2 group A; groups B/C/D adopt it] Consistent error types and messages across
      packages (one small error-code convention), documented: docs/conventions.md "Errors". TypeError for a wrong
      argument type/shape, RangeError for out-of-range values, otherwise `MargoError` (`@margoengine/math`, also
      `@margoengine/math/errors`) with `code` 'disposed' | 'attached' | 'state' | 'unsupported' | 'failed'; messages
      say subject, problem, fix (`'Input is disposed; create a new Input'`). Packages bundle their own copy, so the class
      matches by name (`Symbol.hasInstance`) and `instanceof MargoError` works across packages. packages/shared cannot
      import math (its consumers would have to build after math), so it throws `margoError(code, message)` from
      `packages/shared/errors.js` (same name and code). Core (21) and the stage facade (2) keep bare `Error`
      (Scott's decision, allowlisted in `scripts/hygiene-allowlist.json` `errors`). `LoaderError` stays loaders' own.
   i. [DONE] Follow-ups from the dedupe merge. Sky and VFX are split into feature entries: `@margoengine/sky/base` plus
      `/preetham`, `/bruneton`, `/clouds`, `/night`, `/fog`, `/reflection`, `/lighting` (`new Sky(options, {bruneton,
      clouds})`), and `@margoengine/vfx/base` plus `/obstacles`, `/wrap`, `/sort`, `/texture`. Root entries keep every
      feature and record exactly the pre-split GPU work and WGSL (fixtures in `packages/{sky,vfx}/test/fixtures`,
      recorded from the pre-split build, `1970fda`); narrow skies leave out unused WGSL and render bit-identical HDR pixels and reflection
      maps on the real GPU (`node packages/sky/test/browser-check.mjs`, 6 configurations x 4x/1x, Arc 140V). Eager
      gzip per demo (`npm run measure:demos`, against `1970fda`): Night Citadel 65,309 -> 60,704, Afterlight
      99,730 -> 97,049, Meadow 46,661 -> 44,894, Earth 39,402 -> 39,402; `stage.sky()` fetch 10,318 -> 6,720 (Earth's
      lazy chunks 64,772 -> 61,467; Meadow's 57,499 -> 58,858, since its unused `stage.sky()` chunk no longer reuses
      the eager full Sky). Core + stage unchanged at 18,681.
      Cost: root `Sky` 9,623 -> 10,205 and root `VFX` 6,398 -> 6,617 min+gzip (creative `GPUParticles`, hence
      `stage.particles()`, still uses the root VFX). `SkyMoon` is now base + night, so not `instanceof` the root Sky
      and its options cannot add fog/clouds/day. The Citadel browser test asks for `?quality=high` for its 4x checks
      and has a light-tier check (1x, DPR 1). Before `paceEngine` replaced the global requestAnimationFrame patch, that
      check was flaky because the patch broke `cancelAnimationFrame` (Citadel `stop()` could miss); with
      `engine.pace` it passes on the real GPU. Leftover: the apps' unused `src/effects.ts` re-export files still name
      the root entries.
2. [DONE `aec1830` cherry-picked] Dedupe: particles -> vfx, bloom -> post Bloom, sky -> @margoengine/sky (API changes listed in
   the commit message; -6,017 gzip across the five packages).
3. Replace three.js inside fbx and usdz with native parsers [running].
4. Every remaining PARTIAL/MISSING gap in docs/threejs-parity.md that does not need a core change.
5. [DONE, commits "Math consolidation 1/n..9/n"] Math consolidation. `@margoengine/math` gained plain-array entries the
   packages now share, each bundled into the package that uses it (devDependency; a runtime dependency of the
   tsc-emitted bvh, exporters and loaders): `mat4` (multiplyMatrices, invertMatrix, invertMatrixStable = the old
   shared/math invert, composeMatrix), `quat` (eulerToQuaternion, multiplyQuaternions), `vec3` (add, sub, scale, dot,
   cross, length, normalize), `validate` (finiteVector), `color` parseColor + ColorInput, MathUtils.createLcgRandom.
   packages/shared/math.js is deleted. Users: animation, animator, bvh, clustered, controls, creative, environment,
   exporters, gltf-pro, labels, lines, loaders, machinery, physics, points, post, scatter, shadows, sky, splats, taa,
   terrain, text, usdz, vfx. Proof: `node examples/package-benchmarks/proofs/math-consolidation.proof.js` builds every
   replaced copy from 2484971 and compares Object.is per element on random + special inputs (±0, NaN, ±Infinity,
   subnormals, singular matrices; ~2.0M checks); `--time` times the hot paths (all within noise). Public signatures kept
   (bvh/points/animation/labels/physics wrap or alias; physics `eulerToQuat`, points `random`/`multiply`,
   lines/points/text `parseColor` now print as `const` in api/). Only interface change: invertMatrixStable takes
   (m, out, workspace?) and returns out/null (old shared invert: (out, m, offset, workspace), boolean; every caller
   passed offset 0 and tested truthiness). Gzip (compact min, math inlined, vs 2484971): most within ±10; points +42
   (three public-API adapters + createRandom's shape), controls +26 and bvh +23 (wrappers; controls raw +4, the rest is
   gzip placement), environment -111, labels -30, post/sky/taa/machinery/creative -7..-31. Core + stage 18,681.
   Deliberately left (not bit-identical or not duplicates): text's compose (x*(y+y) form; differs from 2*(x*y) on
   under/overflow) and math's own Matrix4/Quaternion class code; every slerp (physics, animation, animator, net, fbx
   differ in threshold/clamp/renormalize); controls invertAffine and transformPoint, lines' projective transformPoint,
   bvh transformPoint/frustumPlanes/normalize(x,y,z) (one user or different shape; a controls wrapper would cost more
   than its copy); exporters decompose (only copy besides fbx's, which differs); loaders/threemf compose (4x3 row-vector
   product) and parseColor (#rrggbbaa, no linearize); usdz xformOp compose; environment srgbColor (sRGB out, different
   validation); fbx sRGB decode (rounded reciprocals); geometry's generic vector helpers (dot starts at +0, length is
   sqrt(dot), normalize copies on zero); audio normalize (fallback); lines/navmesh 2D helpers; lines vs text finiteArray
   (different checks/errors); procedural xorshift + hash; ray tests (controls ray-plane, selection clip-space sphere,
   bvh Moller-Trumbore are different tests); core/geometry colour (core frozen). For the 1.0 API review: `Vec3`,
   `ColorInput`, `Quat` stay declared per package (types are free; re-exporting math's would make bundled packages'
   .d.ts depend on math); animation `multiplyMatrices(out, a, b)` vs bvh `multiplyMatrices(a, b, out?)` disagree on
   argument order.
   Original list (from the math worker:
   shared/math invert+finiteVector users; mat4 multiply in animation, bvh, points, text, exporters, loaders/usdz, usdz;
   mat4 invert in shared, bvh, lines, environment; transformPoint in bvh, lines, controls; compose/decompose in
   exporters, text, loaders/threemf, usdz; euler->quat/slerp in physics, text, controls; frustum planes in bvh, points;
   vector helpers in geometry, controls, audio, bvh, lines, machinery, navmesh, loaders; colour parsing + sRGB decode in
   lines, points, text, loaders/threemf, loaders/engine, splats, core/geometry (core stays as is); seeded PRNGs in points,
   scatter, procedural, creative; ray tests in controls, selection, bvh; per-package math.ts in audio, bvh, controls,
   geometry, lines, physics, points, text). Prove no behaviour change and record bytes per package.
5b. [DONE] Make gltf-pro instancing opt-in: textured instancing (`8e5d704`) added +1,942 B gzip to gltf-pro for every
   app, because reading `EXT_mesh_gpu_instancing` needs `PBRInstances`. Now `@margoengine/gltf-pro/instancing`
   (`src/instancing.ts`, renamed from instances.ts) holds `PBRInstances`, the instanced vertex patch and the reader
   `instancing` ({read(asset, ext)}), passed like a decoder: `loadGLTF(engine, url, {decoders: {instancing}})`, also
   `parseGLTFAsync`, `loadGLTFInWorker`/`parseGLTFInWorker` (instancing does not force the main-thread fallback; the worker
   script still decodes the accessors, `modelFromPrepared(engine, prepared, signal, {instancing})` composes them),
   `parseGLTF(engine, input, buffers, images, {instancing})`. The root imports PBRInstances as a type only and draws
   through the object (`inst.shader(code)`, `inst.layout`, `inst.bounds(...)`), so materials' `createInstancedMesh`
   (imports the entry itself) and hand-assigned `primitive.instances` work unchanged; bvh, selection, shadows, staging
   and taa already duck-type `primitive.instances` and import nothing from gltf-pro. Missing reader: a file whose
   `extensionsRequired` lists the extension throws `Required glTF extensions are unsupported: EXT_mesh_gpu_instancing
   (pass decoders.instancing from @margoengine/gltf-pro/instancing)` (same rule and wording as a missing draco/ktx2
   decoder, checked in PBRModel so the asset layer and parser workers still read such files); a file that only uses it
   draws each mesh once at its node (glTF's fallback for an optional extension, as optional KTX2/meshopt fall back).
   API: root no longer exports PBRInstances; GLTFDecoderHooks gains `instancing`. Gzip (proofs/size.js method, bare
   imports external, measured from a scratch copy so all three columns share one setup; that setup reads ~120 B above
   the in-repo numbers) 6eeffab / 114130c / now: gltf-pro root 17,562 / 19,559 / 17,859 (in repo now 17,736: +274 over
   pre-instancing + the worker change's +23; the remainder is the draw path's instanced branches ~180, the reader call
   ~50 and the required-extension error ~47), /instancing - / - / 2,581 (in repo 2,466), /worker - / 20,292 / 18,620,
   /prepare - / 6,180 / 6,179, worker script - / 6,409 / 6,408, materials 7,726 / 7,805 / 7,817; bvh, selection,
   shadows, staging, taa unchanged vs 114130c (15,701 / 10,855 / 7,098 / 5,362 / 8,696 -> 15,700 / 10,854 / 7,098 /
   5,362 / 8,695). build-modern's gltf-pro record: 17,866 -> 16,265. Tests: gltf-pro instancing (+ missing-reader case)
   and worker equality (instanced case via the reader), materials, selection, staging, shadows, bvh, taa, fbx, usdz.
   Proofs vs 114130c: `gltf-pro-lighting-hooks.proof.js 114130c` 4,556 identical calls, `materials-uv-transform.proof.js
   114130c` 1,277 identical calls (its default baseline 1970fda already differed before this change, and both proof
   loaders now resolve files renamed/deleted since the ref); `textured-instancing.mjs` GPU-call counts unchanged.
   Real GPU re-run (`textured-instancing-gpu.mjs`, Intel Xe2 / Arc 140V, AC before and after, GPU lock held): instanced
   frames equal the references (materials and NodeMaterial max channel diff 1, glTF via `decoders.instancing` 0), picks
   return instances 0/5/77/143, 1k-10k boxes CPU 15-127 ms -> 0.6-0.8 ms, frame 74-659 ms -> 4-5 ms.
5c. [DONE, package-side, no core change] Texture-binding limit: a gltf-pro PHYSICAL-variant material + directional
   shadows + environment IBL + clustered LocalShadows (`590278e`) needed 17 sampled textures per fragment stage, over
   WebGPU's default (and guaranteed minimum, phones included) of 16. Counts per combination: gltf-pro README "Texture
   bindings" (standard 5, physical 13, materials 10/11 matcap, NodeMaterial 10+N; shadows +1, IBL +1, LocalShadows +1,
   fog/clustered lights/SSAO/LOD baking +0; physical + all three now exactly 16 textures and 16 samplers). Fix:
   environment's BRDF LUT is a STORAGE buffer (`environment.brdfLut`, brdfSize² u32 of pack2x16float(scale, bias),
   written by the same compute integration) read by `iblBrdfTerms` with manual clamp-to-edge bilinear, so IBL = 1 cube
   texture (SH irradiance was already a uniform). API: `brdfLut` is a GPUBuffer, `brdfLutView` removed, the IBL WGSL
   binding is `var<storage, read> iblBrdf: array<u32>` (read by name), `iblShade(specular, sampler, sh, params, ...)`
   lost its `brdf` argument; conveyor-simulator example updated. gltf-pro throws a RangeError naming the combination
   when a shader declares more sampled textures or samplers than `device.limits` (e.g. `gltf-pro: physical material +
   environment:lighting + fog + shadows + clustered + clustered:shadows needs 17 sampled textures per shader stage; this
   device allows 16`). Analytic fit (Scott's option 1) measured and NOT shipped: Karis's mobile fit vs the LUT, real GPU,
   physical sphere grid: frame mean 0.46/255, max 21/255, rough metals mean 14/255 (centre) and 8/255 at grazing rims;
   CPU least-squares fits up to 49 terms still reach 0.03 at grazing low roughness. The buffer LUT is exact instead.
   Proofs: `proofs/binding-limit.proof.js e017d50` (recorded GPU calls: without IBL 3,812 identical calls / 80 modules;
   with IBL 4,556 identical after mapping back the LUT text and binding, 384 occurrences); real GPU
   `binding-limit-gpu.mjs` (Intel Xe2 / Arc 140V, Edge 155, AC before/after, GPU lock): e017d50 environment at default limits
   throws the named error; at raised limits (48) it is the reference; the working tree at default limits renders, max
   channel diff 1/255, mean 0.0000; environment `test:browser` passes (LUT vs quadrature 0.0013, furnace). Gzip
   (build-modern): gltf-pro 16,265 -> 16,495 (+230, the limit check), environment 20,544 -> 20,802 (+258, buffer
   LUT filtering); core + stage unchanged. Still over 16 (throws by name): NodeMaterial with 4+ texture nodes (3 with
   matcap) plus all three lighting packages, and any extra texture on a physical material with all three. Remaining
   option for those is the core one (request `maxSampledTexturesPerShaderStage`/`maxSamplersPerShaderStage` up to the
   adapter in `packages/core/src/renderer.ts` `requestDevice`); not needed for any shipped combination.
5d. [DONE] Docs fixed against `docs/whitepaper/claims.md` (its Summary has the before/after table). The original 201
   rows went from 77 PROVEN / 43 STALE / 58 UNPROVEN / 23 OVERCLAIM to 154 PROVEN / 5 STALE / 9 UNPROVEN / 0 OVERCLAIM /
   18 REMOVED / 15 HISTORICAL (two new statuses: deleted from public text; kept only in a doc labelled as a dated record
   without committed data). 32 rows added for `590278e`..`e2cc4c5` (S-12, H-25..32, DOC-062..071, PKG-096..108).
   Left: HANDOFF rows (internal), and honest-but-unevidenced rows that need a committed run (DOC-061, PKG-005, 080,
   092, 103/104). One core size everywhere: "under 20 kB gzip (19,577 B at `e2cc4c5`; `npm run measure:size`)",
   WebGPU only; WebGL2 is the optional `@margoengine/webgl` (2,156 B). 71 packages everywhere. `npm install` lines kept
   (names/versions match package.json) but introduced as "once published". No three.js speed claim anywhere; size
   comparison now committed. New records: `examples/package-benchmarks/entry-sizes.mjs` -> `results/entry-sizes.json`
   (min+gzip of every exports entry and worker, build-modern's method; also feeds api-surface.md's Gzip column, now
   filled for all 71 packages) and `measure:threejs` -> `results/threejs-size.json`, with three.js now built with the
   size gate's output options (lit-box app 129,899 / 211,584 B gzip WebGL/WebGPU; was 138,578 / 229,008 with weaker
   minification on three's side only). Proofs re-baselined so the plain command passes: post-stack -> `e2cc4c5`
   (Bloom/FXAA/SSAO alpha change; creative stays on `5b1fe66^`), materials-uv-transform -> `7f1c9c6`, gltf-pro-lighting-hooks -> `f8a36ca`;
   selection-xray-off still passes vs `46f9484`. Not fixed: `post-ssao-perspective.proof.js`
   (internal claim) fails at `e2cc4c5`, whose alpha change alters the SSAO shader; extend its accepted differences. For Scott: (a) the site's "Browse the packages and their runnable
   examples" leads to catalog examples that load the packages from jsDelivr, so they will not run until the packages
   are published; (b) nothing was deployed: margoengine.com keeps whatever the last deploy built (the old copy said "both
   backends included", "verified in Chrome", 60 packages) until the next deploy; (c) fbx/usdz READMEs quote their three.js-era sizes (85.8 kB, 13.7 kB) from
   commit `95132e9`'s message with "method not recorded": measure that ref with `entry-sizes.mjs` before using the
   comparison publicly; (d) the material setters and TransparentCanvas merged while 5d ran;
   the docs quote 19,577 B at `e2cc4c5` (`measure:size`) next to "under 20 kB", and claims.md has rows for both.
5e. Diagnose why Margo's GPU time on static boxes is not lower than three.js InstancedMesh (vs-threejs smoke run);
   findings in docs/whitepaper/boxes-vs-threejs.md [running].
5f. Gaps from Scott's architecture review (2026-10-14 late):
   a. [DONE, 0 core bytes, no core change needed; details docs/large-coordinates.md] Large coordinates (BIM/GIS/plant
      layouts jitter at mm zoom; core + kernel are float32). `FloatingOrigin` in `@margoengine/cameras/origin` (1,258 B
      min+gzip): `place(rootMesh | model.root, float64World)`, `lookAt(pos, target)` in float64, `toWorld`/`toLocal`/
      `toLocalPlane`, `worldPosition`, `rebase(point?)`, `onRebase(listener)`, option `ratio` (default 1000: rebase when
      the camera is farther from the origin than ratio x its distance to the target; the origin moves to the camera,
      camera + roots + a running fitToBoundingBox shift together). Precision is lost (CPU emulation of core's path,
      10 mm flange 50 mm from the camera) in the kernel world matrices (float32 translations; child bolts snap to the
      grid), the float32 view-projection matrix (the main jitter source; at 6,000 km vertices fall behind the eye), the
      vertex shader's world position, and `frame.eye` (specular off by 2.8° at 100 km, 72° at 6,000 km); clip arithmetic
      is negligible. Real GPU (Arc 140V, Edge 155; core meshes and a gltf-pro model give the same numbers): core alone
      jitter 0.38 px at 1 km, 42 px at 100 km, flange not drawn at 6,000 km; with the plugin 0.019 px jitter and 1 px
      of edge coverage at every distance, engine.pick / selection Picking hit the part at every distance (core alone:
      nothing at 6,000 km). Worst case before a rebase (CPU): 0.05 px jitter, independent of distance. Rebase cost
      (Node, real kernel, fake GPU, quiet machine): 10k roots 0.8 ms call + 1.5 ms frame (static 0.35), 50k 4.3 + 7.1 ms
      (static 1.6); moving all 50k through mesh.position costs 11 ms. Real GPU (frame = render + onSubmittedWorkDone; quiet gate passed before the lock wait, so semi-diagnostic): 10k static 4.7 ms, rebase 0.6 + 6.1 ms; 50k static 5.4, rebase 4.4 + 11 ms, i.e. one ~10 ms hitch per rebase at 50k. Works with core meshes, children,
      gltf-pro models, CADCameraControls/OrbitControls, engine.pick, bvh hits (toWorld within 1 µm at 6,000 km), machinery
      measurement (7 mm bolt spacing at 6,000 km: 7.0000002 mm; core alone 0), section planes via toLocalPlane, parts moved
      through mesh.position (read back). Limits: km-scale vertices or child translations inside one asset (float32 at
      load; re-centre at load, a loader option could do it), state other code keeps in local coordinates (OrbitControls
      saveState, an ortho CameraProjection.fit in flight, saved views: shift in onRebase). Core relative-to-eye
      rendering would not fix the kernel's float32 positions without float64 kernel columns and eye-relative
      store.matrices (breaks every package reading world matrices); not measured since nothing is left that only core
      fixes. Fragile point: the plugin finds core Camera's private fit animation by its `fromTarget` key (unit-tested).
      Tests: `packages/cameras/test/origin.test.js`; measurements `examples/package-benchmarks/large-coordinates.mjs`
      (CPU, `--cost`) and `large-coordinates-gpu.mjs` (GPU, `--cost`).
   b. Order-independent transparency: weighted blended OIT as an optional package (accumulation + revealage targets,
      composite pass) for gltf-pro BLEND and materials transparent meshes; test a 50% housing over nested gears
      (no popping while orbiting), measure cost; core meshes stay opaque.
      DONE: `@margoengine/oit` (2,210 B min+gzip; core + stage unchanged). `OIT.attach(engine, {order?, depthScale?})`,
      `oit.add(model)` (gltf-pro model or materials mesh; returns a remover), `dispose()`. gltf-pro got a declared
      transparency hook (+323 B): `model.setTransparency(hook)` (`PBRTransparency`: `declarations(group)`, `bindings()`,
      `targets`, `begin()`) and `draw(c, 'transparent', ...)`; BLEND primitives without transmission or renderState leave
      the beauty pass and draw (lit shader, fragment head renamed `margoShade`, entry `transparent`) into rgba16float
      accumulation + r16float revealage at order 8, depth read-only; one composite pass (the only 2 texture reads) blends
      premultiplied-over. Weight clamp(10/(depth/depthScale)^6, 0.01, 1000), depthScale = camera-to-target distance.
      Proofs: `proofs/oit-detached.proof.js` (2,964 GPU calls identical to b803d56 without a hook, MSAA 1x/4x),
      `packages/oit/test/oit.test.js`, gltf-pro extensions test. Real GPU (`oit-gpu.mjs`, AC + lock): colour vs analytic
      for 1/2/4 layers 0.5/4.6/8.7 (WBOIT approximation; vs the WBOIT formula 0.5/0.3/0.6), same at MSAA 1x/4x and ortho;
      TransparentCanvas alpha within 0.002; PostStack 1 layer identical to sorted. Orbit 360x1 deg vs a per-triangle
      sorted reference: steps with >1% popped pixels sorted 13, OIT 0 (worst 1.41% vs 0.36%). GPU (diagnostic, busy
      machine) 720p sorted +0.33 / OIT +0.56 ms, 1080p +0.59 / +1.28 ms. Limits in `packages/oit/README.md`.
   c. STEP/IGES: an offline converter (`npx margo-convert part.step part.glb`, Node, reusing machinery's OCCT path and
      the new glTF exporter, optional baked feature edges) so production apps ship pre-tessellated GLB; keep the 3.1 MB
      OCCT path for drag-and-drop; docs say so plainly. Measure conversion time and output size on the repo's STEP files.
      DONE: `tools/margo-convert` (unscoped npm package `margo-convert`, bin `margo-convert`, like create-margo; not a
      machinery `bin`, so no Node-only code or exporters dependency lands in a runtime package). `npx margo-convert
      part.step [part.glb]` (.step/.stp/.iges/.igs/.brep), library `convert(bytes, format, options)`. occt-import-js
      0.0.23 runs in Node as is (same build and `{linearUnit:'meter'}` defaults as loadCAD's worker); GLB written by
      exporters' data-scene `exportGLB`. Writes metres (BREP: `--units`, default mm), the STEP product tree with part
      names, one material per sRGB colour (linear in glTF; parts without colour get loadCAD's #a6b9c8; multi-colour
      parts split into child meshes), OCCT surface normals, part vertices relative to their bbox centre (node translation
      in JSON doubles), and shared meshes for rigid copies (same index buffer + rigid transform from 3 anchors within
      1e-6 of part size; as1-oc-214: 18 parts -> 5 meshes, GLB < half of `--no-instancing`). Not EXT_mesh_gpu_instancing:
      the data-scene writer has none and the light loader rejects node extensions; shared meshes become one shared core
      Geometry (instanced draws). Options `--linear-deflection <mm>`, `--angular-deflection <deg>`, `--merge` (one
      world-space node per material), `--no-instancing`, `--edges`/`--edge-angle` (machinery `featureEdges` offline ->
      `mesh.extras.featureEdges` uint32 index-pair accessor + `featureAngle`; not lines, both Margo loaders take
      triangles only; FeatureEdges does not read it yet, recompute costs ~1 ms per 1,000 distinct triangles). No
      Draco/meshopt (no Draco encoder; meshoptimizer only via @types/three). Results (README, busy machine, quiet gate
      skipped: results/margo-convert-diagnostic.json): as1-oc-214.stp 441,968 B -> 68,352 B GLB (25,579 gzip), 5,040
      triangles, ~1.2-2.1 s; as1-tu-203 142 kB -> 65 kB; dm1-oc-214 226 kB -> 35 kB; cube STEP/IGES ~10 kB -> 1.7 kB;
      BREP 42 kB -> 54 kB. Validator 0/0/0 on all (+1 UNUSED_OBJECT info per edge accessor with --edges). Browser
      loadCAD of as1 was 1.4-1.7 s + 3.1 MB OCCT. Test `tests/margo-convert.test.js` (in verify; skips without OCCT):
      validator, gltf-pro + light loader, triangles/bounds (1e-6 m)/part names equal to loadCAD run in Node through an
      in-process stand-in Worker executing the built cad-runtime.js; instancing, merge, edges == featureEdges, options,
      BREP units, CLI errors, `tsc --checkJs --strict` of the tool. Follow-ups: a FeatureEdges option to take the baked
      edges; a gated (quiet) timing run; optional meshopt output if Scott accepts the dependency.
   d. 16-texture limit, long term: texture arrays for same-size material maps (gltf-pro physical, terrain splats) and
      shared shadow arrays; optionally core requests a higher `maxSampledTexturesPerShaderStage` when the adapter
      allows (core bytes, Scott decides). After 1.0 unless a demo needs it.
5g. Scott (2026-10-14 night): build these now, in this order (not post-1.0):
   a. [DONE, branch worktree-agent-a9bd2499579071c02] Screen-space reflections: `SSR` in `@margoengine/post/ssr` (HDR
      `PostStack` effect, `SSR.attach(engine)` = its own one-effect stack; put it after SSAO, before DOF/Bloom). Core
      meshes are replayed once at 1x into three targets (IBL specular + roughness, split-sum weight, normal; lighting
      in a dead `if(false)` block keeps the bindings without the cost; 4x scenes into SSR's own 1x depth32float), Hi-Z
      march per pixel (perspective + orthographic), roughness blur/fade (`maxRoughness` 0.6), camera/back-face/edge/
      distance fades, deterministic (stable without TAA; works inside TAA). Composite: `scene + f·(W·reflected − iblSpec)`
      with `iblSpec` computed by environment's own LUT and cube, so a hit replaces the IBL specular and a miss leaves the
      pixel exactly as IBL lit it. Proofs: `proofs/post-ssr.proof.js` (PostStack without SSR: 9,269 recorded GPU calls
      identical to 7c47a09, 8 stories) and post-stack.proof.js still identical. Real GPU (Arc 140V, Edge 155, AC, lock;
      `examples/package-benchmarks/ssr-gpu.mjs`, results/ssr-gpu.json): mirror floor reflects the red box inside the
      projected planar-mirror bounds with red at the mirrored centre (4x, 1x, orthographic, TAA, SSAO+SSR); green at
      that pixel 165 -> 41 (the grey IBL reflection is replaced, not added); roughness 0.3 edge 1 -> 18 px, 0.45 faded,
      0.8 untouched; box above the view -> frame byte-identical; no black/NaN. Cost (own passes, quiet-gated, worst-case
      glossy floor): 720p 2.3 ms 4x / 2.2 1x, 1080p 5.8 / 5.9. Entry `./ssr` 7,862 B min+gzip incl. PostStack (0 unless
      imported). Water: own fresnel + sky/probe reflection, its own pipeline (writes depth, so SSR leaves it alone and
      reflects it); SSR would help (boats, shore) but needs a water material replay: not integrated. Limits: only core
      meshes reflect (glTF-pro, water, terrain need a replay source); 1080p trace is the cost (half-res trace = upgrade).
      Finding: SSAO's ambient replay uses `_=` and so still runs the full lighting; the same dead-block trick would cut it.
   b. [DONE] Volumetric fog and light shafts: `VolumetricFog.attach(engine, {density, heightFalloff, height, anisotropy,
      noise, wind, range, grid, temporal, shadows, lights, depth})` in the new entry `@margoengine/environment/volumetric`
      (environment owns scene fog, i.e. three's `scene.fog`; this is its heavier replacement and needs no sky, so CAD and
      indoor scenes can use it; built separately so the root entry is byte-identical, 21,140 B; the entry is 6,658 B
      min+gzip). Froxel grid (default 160x90x64, quadratic slices over `range` m from the near plane, read from
      `camera.matrix`, so perspective and orthographic both work): one compute pass injects density (uniform, height
      falloff, optional noise + wind) and scattered light (sun from engine lighting through `Shadows`' cascades, four
      stratified compare samples per froxel; ambient; clustered point/spot lights from clustered's own cluster lists, times `LocalShadows`'
      `clusterShadow` when attached; Henyey-Greenstein phase), jittered per frame, history reprojected at the froxel centre (0.9), then
      integrates each column into a 3D texture; a full-screen composite at order 5 (where sky fog runs) blends premultiplied
      light + scene x transmittance over opaque surfaces and the sky, per sample on 4x depth. Scene depth from any post
      capture (`sceneTarget`), or `depth: () => texture`. It never patches a lit shader: no texture added to the 16 budget.
      Shadows/Clustered are read duck-typed through their `pbr(group).declarations` + `bindings()` (no import);
      `packages/environment/tests/volumetric.test.js` pins the clustered cell lookup and cascade bias it repeats.
      Fog policy: replaces, never combines. It throws while environment `Fog` is enabled (`enabled = false` may stay
      attached for a quality switch), sky `fog` has a density, or creative `atmosphere.density` > 0. Proof (no GPU):
      `proofs/environment-volumetric.proof.js` (root entry same calls at 7c47a09; a 12-frame story with Tonemap, Clustered,
      Fog off, ColorBackground at 1x/4x: every call outside the fog's own pass, the lit shader and bindings identical with
      it attached for 5 frames and after dispose). GPU (`volumetric-gpu.mjs`, results/volumetric-gpu.json; Arc 140V, Edge, AC before/after,
      gpu-lock; 4x and 1x): shaft through a slit 9.6x vs plugged 1.1x (ortho 15.6x/1.2x); spot cone 4.3x, LocalShadows under a
      caster 0.48x; density 95/152/190 luma; height falloff low/high 2.5x (uniform 1.0x); no NaN/Inf/negative; still camera
      0.05/255 mean change, slow pan 0.19 vs 0.05 no fog, p99 1 level. First try flickered (1.4/255, p99 13): reprojecting the
      jittered sample re-filtered history every frame; centre reprojection fixed it (stratified sun samples and the tent
      filter alone did not). Cost (quiet run, previous build): froxel pass 1.3-2.2 ms (grid-bound; 80x45x32 0.3-0.5,
      240x135x96 3.4-3.9), composite 0.26/0.4 ms 720p/1080p at 1x, 1.1/2.3 ms at 4x (per sample). Final-build timings in the
      JSON are diagnostic (busy machine). Next: per-pixel 4x composite option; fog for particles/VFX via `fog.texture`.
   c. [DONE] Progressive glTF loading: `@margoengine/gltf-pro/progressive` (`src/progressive.ts` main thread,
      `src/stream.ts` network + decode, `src/progressive.worker.ts` -> `dist/workers/progressive.js`). API:
      `const load = loadGLTFProgressive(engine, url, {onProgress, frameBudget = 4, signal, decoders})` ->
      `{ready, complete, abort()}`. `ready`: the PBRModel with every node and one box per primitive (POSITION min/max,
      material factors, no textures), bounds valid; `onProgress` stages ready/geometry/textures/complete with bytes,
      primitives and images counts. Geometry streams by priority (in frustum first, then radius/distance), re-sent
      when the camera moves (<= every 200 ms): range requests rounded to 256 KB blocks, ~1 MB batches, a new batch only
      once < 1 MB is outstanding; a server without Range streams the whole file and primitives decode as bytes land.
      Main thread uploads within `frameBudget` ms/frame (1 MB buffer writes; one texture + mips per step) and swaps a
      primitive's draw resource by re-running gltf-pro's own `setup` on it (root change: setup's GPU caches became the
      model field `gpuCache`, +5 B root gzip). Textures after geometry, then the remaining bytes; `complete` is
      byte-identical to `loadGLTF` (GPU: every draw resource's vertex/index/uniform bytes, bound texture descriptors
      and uploads, samplers; CPU: doc, buffers, accessors, primitives, images, store), `tests/progressive.test.js`
      (DamagedHelmet, RobotExpressive, generated grids, EXT_mesh_gpu_instancing via `decoders.instancing`, .gltf +
      .bin; range and no-range servers; worker script in-process and main-thread fallback; priority, abort, errors).
      Draco/meshopt/KTX2 decoders fall back to `loadGLTF`. Size: +3.0 kB gzip over an app already using `loadGLTF`;
      worker script 7.3 kB; 4.0 kB lazy fallback chunk. Real browser (`examples/package-benchmarks/progressive/run.mjs`,
      `results/progressive-gltf.json`, Edge 155, Arc 140V, AC, quiet-gated, gpu-lock; throttled local server; camera
      orbiting; medians of 4) first visible / complete / max frame gap, plain -> worker -> progressive:
      50 Mbit/s 40 ms: DamagedHelmet 1158/1157/42 -> 1156/1155/19 -> 96/1175/37 ms; 41 MB generated 6913/6912/339 ->
      7049/7048/137 -> 92/6945/20; 2,000-part assembly 2276/2238/289 -> 2493/2450/206 -> 474/2471/162 (interactive
      590; one 115 ms task building 2,000 nodes). 10 Mbit/s 100 ms: helmet 3346/3345/26 -> 3431/3430/19 -> 142/3775/35;
      assembly 10342/10291/330 -> 10571/10533/213 -> 1405/10408/141. Limits: no MSFT_lod/gltfpack LODs, no low-res
      mip first, boxes as placeholders, helpers (animation, shadows, bvh, selection) attach after `complete`, device
      loss during the load not handled. Next: build the 2,000 placeholder boxes over frames (the 115 ms task).
   d. After the core culling (B) and large-coordinate agents merge: massive-scene streaming (hierarchical LOD,
      chunked loading, GPU culling for core-mesh-like parts) and a plan for core's 100,000-entity cap (raising it is a
      core change: measure memory/bytes, Scott decides).
   The Biome reformat (1g.e/1h.d) moves to just before the final-phase demo rebuild, when no agents are landing code.
5h. Production-readiness additions (Scott, 2026-10-14 night; existing pieces checked against the repo):
   a. [DONE, branch worktree-agent-a54824b909f38c507] Offline asset cache: new `@margoengine/cache` (2.4 kB min+gzip,
      no deps). `new AssetCache({name, version, maxBytes = 512 MiB, persist, timeout = 5 s, fetch})`; `cache.fetch` is
      fetch-compatible and goes to every loader's `fetch` option (`cachedFetch` = shared default cache); `flush()`,
      `usage()` (+ `navigator.storage.estimate()`), `delete`, `clear`, `dispose`/`using`. Loaders: one pass-through
      `fetch` option on gltf-pro (+12 B; `loadGLTFInWorker` stays on the main thread when it is passed, like decoders;
      README recipe `parseGLTFInWorker(engine, await (await cache.fetch(url)).arrayBuffer())` keeps worker parsing),
      fbx (+21 B, file + textures), usdz (+9 B; `loadUSDZInWorker` downloads here, parses in the worker, +63 B),
      machinery `loadCAD` (+9 B; STEP parsing stays in the OCCT worker); loaders already had it. Design: GET/HTTP(S)
      only, keyed by URL; miss stores the 200 body in the background (no-store and non-200 skipped); a hit is served
      without a request while `max-age` holds, else revalidated once per AssetCache with If-None-Match /
      If-Modified-Since (304 serve, 200 replace); offline, error status, timeout, or a drop mid-download serve the stored
      copy; the caller's abort still rejects; `version` change clears the DB. Range: hit sliced from the stored whole
      file (206/416), miss passes through + one background whole-file fill (for the progressive loader). LRU eviction
      within maxBytes; QuotaExceededError evicts the new file's size more and retries once; no IndexedDB / any IDB
      error falls through to the network. Works in Web Workers and service workers (README has a 6-line SW recipe for
      full PWA offline: app shell and worker scripts are not covered by the asset cache). Tests: packages/cache/test
      (own in-memory fake IndexedDB; fake-indexeddb is not installed). Real browser (Arc 140V, Edge 155, AC before/after,
      GPU lock, quiet gate passed; `examples/package-benchmarks/cache/offline-gpu.mjs`, results.json, medians of 3,
      call to first frame, HTTP cache disabled): DamagedHelmet 3.8 MB localhost plain 328 / cold 300 / warm 273 ms,
      CDP "factory Wi-Fi" 20 Mbit/s 80 ms plain 1,904 / cold 1,913 / warm 375 ms; generated 48 MB GLB (1.92M tris)
      localhost 766 / 656 / 319 ms, Wi-Fi 20,102 / 20,115 / 414 ms. DevTools offline (context.setOffline): both load
      from the cache (237 / 274 ms) with identical geometry digest and byte-identical frame, and a Web Worker reads
      the identical file (SHA-256) from the cache while offline. The 62 MB conveyor GLB is not loadable by gltf-pro at
      all ("Unsupported glTF accessor", also with plain fetch) - separate issue (fixed in 5l.p). Limits: no Vary; cross-origin ETag
      needs Access-Control-Expose-Headers; a cold range miss costs range bytes + whole file; `@margoengine/gltf` (light
      loader) has no `fetch` option (size-gated with core).
   b. [DONE, branch worktree-agent-a97e430da9ad32b46] CAD navigation profiles: `OrbitControls.attach(engine)
      .setProfile(SOLIDWORKS)` (also AUTOCAD, INVENTOR = FUSION, BLENDER, MAYA, ONSHAPE, RHINO, THREE_ORBIT = default;
      `PROFILES` by name). Profiles are data (`NavigationProfile`: drag table keyed `'shift+1'` = Shift + middle, wheel
      direction, zoom to cursor, touches, double-click fit button, keys keyed by modifiers + `KeyboardEvent.code`) that
      OrbitControls/MapControls read; each is a separate export (OrbitControls + one profile +171 B gzip, all nine
      +427 B). Mechanism cost in OrbitControls alone: 4,224 -> 4,866 B min+gzip (+642; whole controls bundle 17,069 ->
      18,270). `fit` (double middle click, F, Home...) is an event: only the app knows its bounds. View keys snap
      (eased with damping); Blender numpad 5 toggles the engine's CameraProjection. ViewCube gained `flip` (repeat click
      -> opposite view: Blender, SolidWorks; profiles carry `viewCube: {flip}`) and its toggle follows outside
      projection changes (viewcube 3,227 B, budget 3,500). Default proof: `packages/controls/tests/orbit-replay.json`, a
      113-event pointer/mousedown/contextmenu/wheel/touch/key sequence recorded from the pre-profile build (659038f),
      replays bit-identically (positions, targets, preventDefault flags, states, events; plain, damped, zoom to cursor)
      with no profile, `setProfile(THREE_ORBIT)` and Blender -> THREE_ORBIT. Conflicts handled: context menu, middle
      `mousedown` (autoscroll/paste), Alt keyup after an Alt drag (Firefox menu bar), Ctrl + wheel pinch never inverted,
      only bound keys cancelled. Bindings table, sources and uncertain defaults (SolidWorks/Onshape/Inventor wheel
      direction, some zoom-to-cursor defaults, touch rows, Maya dolly axis, Onshape Shift+digit) in the controls README.
      Not done: core CADCameraControls (hard-coded, core frozen: use OrbitControls), roll, 3Dconnexion, gamepads
      (`@margoengine/input` polls per tick; profiles are event chords), Trackball profiles. No real-browser run.
   c. Wide colour gamut: Display P3 canvas as a zero-core-byte plugin (like TransparentCanvas: reconfigure the context
      with `colorSpace: 'display-p3'`), tonemap output in P3 where the display supports it, sRGB fallback; prove sRGB
      output unchanged. tonemap already has AgX / ACES / Khronos PBR Neutral.
      DONE with 5l.i (0 core bytes): `ColorOutput.attach(engine, {gamut: 'p3', hdr: true, peak: 4, force})` in
      `@margoengine/environment` (`output.ts`; one class: format, colorSpace and toneMapping are one configure call and
      share one output pass). Turns on only where `matchMedia` reports P3 / `dynamic-range: high` (or `force`) and the
      browser keeps it (`getConfiguration()`); otherwise no configure, no pass, same GPU calls as without it. Mechanism:
      reconfigures core's context (merging the current configuration; TransparentCanvas now merges too, either order
      works), replaces `getCurrentTexture` on that context object with an offscreen canvas-format texture (core and every
      package draw exactly as before), and at order 1e5 resolves MSAA and writes the real canvas: decode sRGB + Tonemap's
      excess, Rec.709 -> P3, clamp 0..1 or 0..peak, encode. "P3 on" = sRGB content looks the same (0-1 eight-bit P3
      units apart, measured), colours outside sRGB (negative Rec.709 components, e.g. an external HDR source) are kept
      up to P3 instead of clipped. "HDR on" = rgba16float + `extended`; Tonemap (alone or in a PostStack; it reads a
      `Symbol.for('margoengine.color-output')` contract from the pass context, no import) keeps its SDR curves below the
      0.76 knee and rolls highlights off toward `peak` (Khronos Neutral's rolloff; AgX/ACES scaled by its ratio), writing
      the part outside 0..1 to a 1x rgba16float excess texture in a second pass. Bytes: environment +1,791, tonemap +684
      (min+gzip root entries), core+stage +0. Proofs: `packages/environment/tests/output.test.js`;
      `examples/package-benchmarks/proofs/color-output.proof.js` (without ColorOutput, Tonemap alone/DOF-sourced/stacked,
      TransparentCanvas, ColorBackground: 6,174 recorded GPU calls identical to 7dcc958). Real GPU (Arc 140V, Edge 155 and
      Chrome 155, AC, GPU lock; `examples/package-benchmarks/color-output-gpu.mjs`, `results/color-output-gpu-*.json`):
      this laptop's display reports `color-gamut: srgb` only and `dynamic-range: standard` (headed run), so `auto` stays
      sRGB/SDR; forced, the canvas reports display-p3 / rgba16float / extended; a P3-green patch reads (0,188,0) in a
      Display P3 2D canvas with P3 on vs (86,188,55) off; a 3x-white highlight reads 1.373 from the float16 canvas (and a
      float16 P3 2D canvas) with HDR on vs 252/255 off; same after `rebootDevice()`, with TransparentCanvas and with a
      Bloom+Tonemap+FXAA stack, 0 validation errors. Limits (environment README): HDR/wide gamut only via Tonemap (Bloom,
      SSAO, DOF alone and creative PostProcessing stay SDR-range); passes after Tonemap (FXAA, TAA, overlays) see the SDR
      image with the excess added back under them; LUT grades the 0..1 part only; no display headroom API (`peak` is
      the app's choice); no ColorManagement/P3 input; WebGL2 no-op; not seen on a real P3/HDR display (none here).
   d. [DONE] Frame debugger: new opt-in entry `@margoengine/inspector/frame` (8,327 B min+gzip, 8,989 B with the
      stats `GPUProfiler` it reuses; inspector root unchanged at 4,137 B; no core/stage change).
      `FrameDebugger.attach(engine, {parent?})` (+ panel bottom-left, "Capture frame" button, `<details>` tree and
      tables; click a draw's mesh button to select it in an attached Inspector); `await debug.capture({render?})` ->
      plain-JSON `FrameReport`: `graph` (every frame graph pass in order with plugin owner and order, core `main`, plus
      `(before|after frame graph)` for GPU work outside the graph such as core's MSAA resolve; CPU encode ms, GPU ms),
      per GPU pass the render targets (format, size, samples, resolve, load/store) and every draw/dispatch/bundle
      (vertex/index count, instances, triangles, workgroups, pipeline id, bind group ids, core mesh ids), `pipelines`
      (label, passes that used it, topology, cull, blend, formats, depth state, MSAA, compiled-this-frame, most
      textures/samplers bound at once: warning at 15/16), `bindGroups` (each binding's resource), `totals` (draws,
      indexed, indirect, dispatches, triangles, instances, passes, encoders, submits, pipelines + shader modules +
      bind groups created this frame, uploads/bytes), `uploads` per destination, `memory` (live buffers/textures
      created since attach: count, bytes, ten largest), `timing` gpu|cpu + note. How: while attached only the
      device's create* calls are wrapped (descriptions + memory; per-resource destroy/createView, held weakly); for
      the captured frame only, engine.render, each frame-graph pass record (the private pass list is found by shape:
      core's build renames the field), createCommandEncoder, encoders/passes, queue writes/submit and
      `GPUTexture.prototype.createView` are wrapped and restored afterwards (a wrapper someone else stacked on top
      stays as a pass-through). GPU times via `GPUProfiler` timestampWrites on the frame graph's encoder; indirect
      args copied (COPY_SRC buffers) to a readback at that encoder's finish. Tests:
      `packages/inspector/test/frame.test.js` (tracing fake GPU: the report lists exactly the commands the fake
      passes received, pass by pass; fake timestamps 1 ms/pass; pipeline/bind group/target descriptions; the frame
      path (engine.render, graph, device, queue, GPUTexture.prototype) is identical before and after capture and on
      idle frames; dispose restores every device method and unwraps live resources; works under Stats with equal
      draw counts; panel + select; texture size estimate). Real browser (Arc 140V, Edge 155, AC, GPU lock;
      `examples/package-benchmarks/frame-debugger-gpu.mjs`): DamagedHelmet (gltf-pro) + Shadows + CulledInstances
      (400 boxes, compute + drawIndexedIndirect) + PostStack(SSAO, Bloom, FXAA) at 1440x1100: 15 graph passes, 26 GPU
      passes, 15 draws (1 indirect, 336 culled instances read back), 9 dispatches, 81,323 triangles, GPU 19.5-21.8 ms
      by timestamps, 434 MB tracked GPU memory, 0 GPU errors, frame path restored; report
      `test-results/frame-debugger-report.json`, screenshot `test-results/frame-debugger-panel.png` (not committed).
      Limits: resources/pipelines/bind groups made before attach have no description and no memory entry (attach
      before loading); texture bytes estimated from format/size/mips/samples; indirect counts need COPY_SRC (else
      null, excluded from triangles) and are end-of-frame values; GPU time only for passes on the frame graph's
      encoder without their own timestampWrites (Stats' profiled frame, 1 in 15, takes them); bundle contents not
      listed; the texture tally sums all bound groups (sampled + storage); browser CPU times are 0.1 ms granular.
5i. Deployment and resilience (Scott, 2026-10-14 night; checked against the repo):
   a. Deployment guide + starter headers: COOP/COEP are NOT needed (no SharedArrayBuffer requirement; bvh only detects
      it; the Wasm kernel is embedded in JS). The real trap is CSP: `script-src 'wasm-unsafe-eval'` for the kernel and
      `worker-src 'self'` (blob: if any) for parsing workers. Ready-to-paste configs for Cloudflare Pages/Netlify
      `_headers`, Vercel `vercel.json`, Nginx: CSP, caching of fingerprinted assets, compression; `create-margo`
      template ships a `_headers`. Test: a page served with the strict CSP loads every demo-class feature.
      DONE: `docs/deploying.md` (linked from README and docs/README.md). Policy: `default-src 'self'; script-src 'self'
      'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src
      'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'`. Found in the real-browser
      run: two workers need `'unsafe-eval'` in their own (per-file) policy: `decoder.worker-*.js` (decoders runs the
      Draco/Basis Emscripten scripts via indirect eval) and `cad-runtime-*.js` (occt-import-js embind uses `new
      Function`); a worker takes its CSP from its own response headers, so the page stays strict. `'unsafe-inline'`
      styles: Vite keeps index.html `<style>` inline, ViewCube and Inspector insert `<style>`. No package source
      changed. `tools/create-margo/template/public/_headers` (CSP + immutable `/assets/*`); `site/_headers` gains the
      CSP on every page except `/catalog/examples/*` (inline scripts + jsDelivr/esm.sh, left without CSP) and caching
      for dof/tonemap assets and demo `.wasm`. Check: `node scripts/gpu-lock.mjs run --owner=<id> -- node
      scripts/csp-check.mjs` (harness page with core, gltf-pro worker, Draco, KTX2, bvh worker, PostStack SSAO+Bloom+
      FXAA, Stats/HTML/ViewCube/Inspector, machinery STEP; the create-margo app; 11 site/dist pages; zero violations,
      Edge, Arc 140V, AC; `examples/package-benchmarks/results/csp-check.json`; claims DOC-072..075).
      `CSP_OVERRIDE=<policy>` shows what a missing directive breaks (checked: no `'wasm-unsafe-eval'` -> Engine.create
      fails; strict policy on the eval workers -> Draco, KTX2, STEP fail, all else passes). Side finding (fixed in 5l.o):
      every site demo folder (`demos/`, `demos/dof/`, `demos/tonemap/`, `demos/earth/`) shipped the 7.6 MB OCCT `.wasm`
      and CAD chunks although no demo imports STEP (deploy bytes only; never downloaded). Both eval-worker rules are gone
      since 5l.o.
   b. Tier-aware feature presets: `@margoengine/quality` already picks light/full tiers (MSAA, DPR, pacing only). Add
      presets packages read on attach (shadow cascades/resolution, SSR off, volumetrics off/low grid, SSAO half-res,
      particle counts) so the light tier scales features automatically; measure the light tier on the laptop.
      DONE: `applyQualityTier()` publishes the tier's `QualityPreset` as `globalThis.margoPreset` (core's `margoLow`
      pattern: zero imports, automatic, no app plumbing; a `preset` option would need every app to pass it). Readers use
      `packages/shared/preset.js` once at construction and fill only options left undefined (explicit wins; no preset ->
      the app's own options object, unchanged). Light = phone preset: Shadows `resolution` 1024, SSAO `samples` 16, SSR
      `enabled: false` + `steps` 32, VolumetricFog `grid` [80,45,32], LocalShadows `resolution` 256, VFX `capacity`
      100,000 (an explicit larger `initialCount` keeps 1M); full tier empty. Table: quality README; cookbook
      `docs/guides/quality-tiers.md`. Not preset: shadows cascades/PCSS (fixed in the package, no option), Bloom/FXAA/
      Tonemap/TAA/culling (no cost knob), DOF (`maxRadius` 8 vs 16 measured no saving: fixed 64 taps; dropped).
      Proofs: `proofs/quality-presets.proof.js` (6 readers, 1x/4x: recorded GPU calls identical to 96daac7 without a
      preset; preset == passing its values; explicit wins), contract tests `packages/quality/test` (writer) and
      `tests/quality-presets.test.js` (readers). Bytes (min+gzip): quality +172 (1,477); shadows +64, post root +69
      (ssao +58, ssr +61), environment/volumetric +65 (root 0), clustered/shadows +71 (root 0), vfx +76; core 0.
      Demos: DOF demo now applies the tier (it ran 4x everywhere; visual check gains `dof-light`); island particle
      default comes from the preset (same 100k/1M). Every demo passes explicit values for preset-covered options, so
      the presets change no shipped demo's settings. Measured (DIAGNOSTIC: busy machine, CPU 43%, AC, Edge 155, Arc
      140V, GPU lock, 4 ABBA rounds x 6 s, `tier-presets-gpu.mjs`, `results/tier-presets-light-diagnostic.json`):
      island light 1432x768 100k particles, presets off/on: 60.05/59.9 FPS, GPU span p50 10.33/10.16 ms (same config,
      A/A); DOF demo light 1100x461: 60/60 FPS, submit-to-done p50 5.3 ms (maxRadius 16) / 5.6 ms (8). Both hold 60 on
      the light tier with headroom. Not measured: the other demos on the light tier, a quiet-machine rerun.
   c. [DONE 2026-10-15] Pipeline pre-warming: `warmUp(engine)` in `@margoengine/quality/warm` (new subpath; no package
      reads it, so zero cost unless imported; core untouched). Features create pipelines lazily inside their passes, so
      warmUp renders warm frames (delta 0) into an offscreen texture (nothing presented): the device's sync
      `createRenderPipeline`/`createComputePipeline` are patched for those frames only; a missing pipeline stops the
      frame (exception out of the create call), the work the stopped frame already encoded is submitted (else one-time
      work - sky LUTs, static shadow casters - stays marked done but never ran: first version, shadows/sky images
      differed), the pipeline compiles with the `*Async` API, and the retry gets it (keyed by descriptor, shader modules
      by code). A feature that stores state before creating its pipeline fails on the retry -> warmUp restores the device
      (`rebootDevice`, every restore hook) and finishes synchronously (`report.rebooted`); DOF did this until its resize
      early-return also required `presentPipeline` (call-identical: post-stack and color-output proofs identical). It
      resolves after `onSubmittedWorkDone`, so pipelines made synchronously at attach (GrassField) are absorbed too.
      Measured (`node examples/package-benchmarks/warm-up-gpu.mjs --runs=3`, JSON `results/warm-up-gpu.json`; fresh
      browser per sample = cold shader cache; helmet + floor 1280x720, default 4x tier; feature attached after 40 steady
      frames; frame = render() to onSubmittedWorkDone; medians of 3; Edge 155, Arc 140V, AC; DIAGNOSTIC: the committed
      run's quiet gate timed out at 32% CPU with other agents running; an earlier run of the same code minus the final
      onSubmittedWorkDone line passed the gate (16% CPU) and matched within ~20%). First visible frame that draws the
      feature, cold -> after warmUp (steady frame): SSAO 413 -> 9.1 ms (10.1), Bloom 184 -> 4.9 (5.7), DOF 276 -> 7.8
      (7.5), Tonemap 146 -> 5.1 (4.9), Shadows 325 -> 9.8 (8.1), Sky (bruneton+clouds+lighting) 285 -> 4.0 (5.1),
      Grass 222 -> 4.9 (5.0). warmUp itself (during loading): 660 / 236 / 347 / 177 / 407 / 278 / 219 ms; 9/5/5/5/4/1/0
      pipelines made async, 0 fallbacks, 0 reboots; final image identical to the cold run (max diff 0) for all seven.
      Grass makes its pipelines at attach, so its 219 ms is waited out, not parallelised. Sizes (entry-sizes method):
      `@margoengine/quality/warm` 2,586 B min / 1,257 B gzip (new); quality `.` 2,747/1,464 -> 2,980/1,564 (+100 gzip,
      `redrawAfterRestore`, 5i.d); core + stage untouched: 19,928 gzip at this commit. Unit tests `packages/quality/test/warm.test.js`.
      Limits: a feature attached later or `enabled = false` is not warmed (call warmUp again); a feature that swallows
      exceptions around pipeline creation may misbehave; demos do not call warmUp yet (measured on a harness page).
   d. [DONE 2026-10-15] Device-loss verification: `npm run visual:device-loss` (`scripts/visual-regression.js
      --device-loss`; site demos only, one run; GPU lock + AC as visual:check). After the normal capture an init script
      destroys every GPUDevice the page made at the start of its next render pass (mid-frame); a demo that draws no
      frame within 2 s (paused under reduced motion) is hit while idle. Passes when a device made after the loss has
      submitted work and the capture matches the pre-loss capture within the view's manifest tolerance (bit-exact
      allowance if none). Result (Edge 155, Arc 140V, AC, commit 11b22e6): 24/24 views pass - night-citadel x3,
      gameplay-sandbox x3, character-animation x3, robot-expressive (high), flight-helmet x3, windy-meadow x3, earth x3,
      dof x3, tonemap x2; 18 bit-identical after restore, citadel (max diff 12-67, within its noise tolerance) and
      sandbox (particles; changed 1.2-5.2% vs limits 4-16%). Fixed: (1) on-demand rendering - windy-meadow and the
      sandbox, paused, never drew after the restore (empty canvas): new `redrawAfterRestore(engine, render)` in
      `@margoengine/quality` renders the two frames after each restore (water refraction/sky reflection read the previous
      frame: with one frame the sandbox water differed by 30%); (2) found on the way, not device loss: `packages/shared/
      agx.js` (eaddd64) had an extra `(` in the AgX curve, so Bloom's and Tonemap's AgX pipelines were invalid and
      night-citadel/windy-meadow never became ready, character-animation/earth/tonemap stopped rendering; fixed, plus a
      parenthesis-balance check in `packages/tonemap/tests/agx.test.js`. AgX visual baselines need a `visual:update`
      after the eaddd64 re-derivation if visual:check flags them (not run here). Also: visual-regression's default views
      no longer include the Khronos-only `model` view for site demos (it made `<demo>-model` cases with no baseline).
      Not covered: a real driver reset / GPU switch (launch gate 3's Mac check), XR and the Khronos gallery.
5j. [DONE 2026-10-15: `docs/limits.md`, 18 rows in four tables (Scale, Rendering, Assets, Platform), each with an
   enforced/measured/"not measured" threshold, the reason, the exact error string from source and the escape hatch with
   its proof link; linked from README, docs/README.md, the site's "Where it stands" (GitHub link; the site build ships
   no .md pages) and whitepaper outline section 7; every number is claims.md LIM-001..026 (25 PROVEN; LIM-024, the CSP
   error strings, UNPROVEN like DOC-074 until the CSP_OVERRIDE runs are committed). Limits with NO escape hatch yet, to
   queue: (1) [DONE 2026-10-15, 5w worker] the 100,000 node/part caps in gltf, gltf-pro, .margo (blender), OBJ (machinery)
   and SurfacePhysics are options now, default unchanged (100,000), allowed 1..8,388,608 (core's entity cap):
   `maxNodes` on gltf `parseGLTF`/`loadGLTF`, every gltf-pro loader (+ `parseGLTF`/`parsePreparedPBR` last argument, worker
   and progressive paths), blender `decodeMargo`/`parseMargo`/`loadMargo`; `maxParts` on machinery `parseCAD`/`loadCAD`
   (OBJ objects/groups and, new, the STEP/IGES worker's 100,000-mesh cap) and `SurfacePhysics.create` (parts and
   carriers separately). One helper, `packages/shared/limits.js`; errors name the option, e.g. `RangeError: Too many glTF
   nodes (100001 > 100000; raise the maxNodes option)`; `.margo` and SurfacePhysics now say `Too many .margo nodes` /
   `Too many surface parts|carriers` instead of the old combined TypeError/RangeError. Test `tests/count-limits.test.js`
   (each package at 100,001 with and without the option; gltf-pro builds a 100,001-node model headless in < 1 s,
   diagnostic). Not measured: load time/memory past 100,000. Seen in passing (core, frozen, not fixed): disposing a 100,001-node
   gltf-pro model takes ~9.4 s in Node vs ~0.6 s to parse it (diagnostic, not quiet-gated): core `Engine.remove` scans
   the whole parent column for children on every mesh it removes, O(meshes x capacity); a package cannot avoid it. docs/limits.md row
   and claims LIM-007 updated; (2) 16 sampled textures per stage - nothing past dropping a lighting
   feature (texture arrays 5f.d are post-1.0; or core requests the adapter's higher limit, core bytes); (3) a second
   directional light (area lights landed with 5l.f and are in the page: 64, unshadowed); (4) [off-screen part DONE with 5l.e: reflection probes are SSR's fallback] water/terrain reflecting;
   (5) the 64 MiB glTF download budget as an option (5l.r); (6) gltf-pro's 1,000,000 vertices per primitive (no
   splitter); (7) [DONE, 5l.o] the decoder worker's `'unsafe-eval'`; (8) above ~1M core meshes the 41 ms kernel tick stays
   (hierarchical LOD streaming 5g.d not built); (9) volumetric fog does not reach particles/VFX automatically (only via
   `fog.texture`). [DONE, 5l.o] CSP negative runs committed (`results/csp-check-negative.json`): LIM-024/DOC-074 PROVEN.]
   "Design envelope" page (Scott, 2026-10-14 night): `docs/limits.md` (also on the site, linked from README and the
   whitepaper) listing every hard limit as an architectural boundary: the limit, the MEASURED threshold where it
   starts (no unmeasured numbers - e.g. coordinate jitter distance comes from 5f.a's measurements), why it exists
   (usually: keeping core small), the clear error or symptom a user sees, and the escape hatch package/tool with its
   proof link. Rows at least: 100,000-entity cap (GPU culling / streaming 5g.d), 16 sampled textures per stage (named
   error; texture arrays 5f.d), float32 coordinates (floating-origin plugin 5f.a), giant STEP files (offline converter
   5f.c), one directional light in core (clustered), WebGPU-first (WebGL = basic fallback only), order-independent
   transparency (OIT package 5f.b), no visual editor, untested devices. Write it after 5f/5g land so every threshold
   and escape hatch is real.
5k. HARD REQUIREMENT (Scott, 2026-10-14 night): code hygiene >= 9/10 before launch, defined as gates enforced by
   `npm run verify` (warn first, then fail) and reported by a new `npm run hygiene` scorecard:
   1. Biome formatter, conventional readable style, check mode in verify (replaces 1g.e/1h.d).
   2. Biome lint, small rule set (no unused vars/imports, no var, consistent imports, noExplicitAny), 0 warnings.
   3. 0 `any` in public APIs (api/ reports); internal `as any` replaced, any survivor on a justified allowlist (1g.b).
   4. strict TS everywhere (`strict`, `noImplicitOverride`, `noFallthroughCasesInSwitch`), checked per package.
   5. One definition per shared type (Vec3, Quat, ColorInput, Ray, ... type-only from @margoengine/math, 0 bytes);
      resolve clashing names (two loadGLTF, multiplyMatrices argument order).
   6. TSDoc on every public export (checked from api/ reports).
   7. One error convention (shared error classes/codes, messages that name the fix) (1h.h).
   8. Remaining API inconsistencies from "API rough edges before 1.0" resolved.
   9. No dead code (unused exports/files detected and removed).
   Order: after the current feature wave lands, pause new features; one agent runs the Biome reformat + gates (warn);
   then parallel agents by package group fix types/any/TSDoc/errors; then gates switch to fail; then the demo rebuild.
   Features started afterwards (P3, frame debugger, tier presets, pre-warming, streaming) must pass the gates.
   PHASE 1 [DONE 2026-10-15, one commit on 5f1d442]: Biome 2.5.15 (exact devDependency; `biome.json`: 2 spaces,
   width 120, single quotes, semicolons, trailing commas "all", property quotes preserved, `lineEnding: auto` because
   checkouts are CRLF via core.autocrlf; covers packages/tests/scripts/examples/apps/tools JS/TS, excludes dist, vendor,
   the generated ltc.ts and both wasm.ts; no import sorting anywhere). 1,041 of 1,059 files reformatted; lint fixes only
   unused imports (12 files, reviewed: specifiers of still-imported modules or node builtins; React default imports kept
   via `jsxRuntime: reactClassic`) and let -> const (10 files). 25 doc comments the dense style wrote after a member's
   `;` for the NEXT member (Biome pulled them before the `;`, detaching them) were moved back above their member.
   Proof of no behaviour change: core + stage 19,999 B gzip, raw 46,652 B (both identical before/after); 643 dist files
   hashed: every minified file byte-identical; 35 JS files differ only in packages whose build is plain `tsc` emit
   (bvh, decoders, exporters, ifc, loaders, react), all AST-identical with identical comments; 53 .d.ts differ in layout
   and gained JSDoc tsc used to drop from one-line members (AST-identical). Source level: all 1,041 files AST-identical
   (positions, parentheses, literal spelling, `a && (b && c)` re-association and JSX whitespace normalised) except the
   22 lint-fixed files; every `/** */` precedes the same code as before; comment texts identical. Entry sizes and the
   basic-scene network record unchanged except their commit field. Node tests 1,322/1,322 (`--test-concurrency=2`;
   `scripts/support/serializer-number-candidate.js` anchor updated to the formatted source), proofs --current 15/15,
   build:site, visual:check 55/55. api/ reports: 10 changed cosmetically (line breaks from formatted .d.ts, Biome
   dropped parens in shader's `Arith` conditional type); `scripts/api-report.js` now drops binding-pattern trailing
   commas and the space a stripped leading comment leaves. Text-patching benchmark helpers that read the WORKING TREE
   (not a pinned ref) need anchors in the formatted style from now on.
   `npm run hygiene` (`scripts/hygiene.js`, formula in its header: score = max(0, 10 - 1 point per 1% of units in
   violation); hygiene = mean of gates 1-7 and 9) writes test-results/hygiene.json; `npm run verify` starts with
   `hygiene.js --verify` (format + lint, warn only, ~2 s); `--strict` exits 1 on any violation (switch verify to it
   after phase 2). `npm run format` / `npm run lint` run Biome. Internal `any` allowlist: `scripts/hygiene-allowlist.json`
   (decoders codec.ts 13, Emscripten globals). After merging, run `npm install` in the main checkout (Biome binary; worktrees
   need `node_modules/@biomejs` and the `biome` bin shim too). Every agent runs `npm run format` before committing.
   BASELINE (5f1d442 + phase 1): hygiene 3.2 / 10.
   | Gate | Violations / units | Score | Notes |
   | --- | --- | --- | --- |
   | 1 format | 0 / 1,059 files | 10.0 | met |
   | 2 lint | 72 / 1,059 files (282 warnings) | 3.2 | 251 noExplicitAny, 23 unused vars, 8 useImportType |
   | 3 any | 121 / 1,906 (382 public declarations + src files) | 3.7 | 109 `any` in public declarations (shader 48, physics 25, gltf-pro 17, controls 17, usdz 2), 243 explicit internal (13 allowlisted) |
   | 4 strict | 146 / 219 flags | 0.0 | `strict` on everywhere; noImplicitOverride + noFallthroughCasesInSwitch off in all 73 packages. Turning both on costs only 35 TS4114 (missing `override`): controls 14, environment 12, lines 4, shader 2, html/sky/vfx 1; no fallthrough errors |
   | 5 types | 138 / 1,388 names | 0.1 | 57 names: Vec3 in 9 packages, Context in 7, ColorInput/parseColor 4-5, Color 4, math vs shader helpers (add, dot, cross, normalize, clamp, smoothstep, ...), loadGLTF/parseGLTF, parseUSDA/parseUSDZ, multiplyMatrices, Ray, ... (list in hygiene.json `duplicates`) |
   | 6 tsdoc | 593 / 1,326 exported symbols | 0.0 | worst: shader 84, machinery 36, core 27, math 27, loaders 26, physics 22, react 22, bvh 20 |
   | 7 errors | 534 / 1,856 throws are bare `Error` | 0.0 | environment 131, decoders 46, post 32, machinery 29, creative 23, core 21 |
   | 8 api | manual | - | open items of "API rough edges before 1.0" (1, 7, 8, 10) |
   | 9 dead | 43 / 2,869 files + exports | 8.5 | no unreachable src file; 43 unused exports, e.g. bvh SIDE_*, controls gizmo constants, geometry math helpers, shared polygon helpers |
   PHASE 2 groups (4 parallel agents, balanced by measured work = public any + unallowlisted internal any + missing
   TSDoc + bare Errors + duplicate names + dead + strict errors + other lint; total 1,707):
   - A (440) math types + shader + core-adjacent: math, shader, core, margoengine, shared, geometry, procedural, lines,
     text, points, wfc, tween, ecs, fsm, splines, net, input, navigation, navmesh, road, cinematic, quality, cache.
     Lands FIRST the canonical type-only Vec3/Quat/Mat4/ColorInput/Color/Ray in @margoengine/math (0 bytes) and
     the parseColor/helper dedupe; the other groups then import them. Core: TSDoc only (comments cost 0 bytes);
     its 21 bare Errors and any message change cost core bytes at 19,999/20,000, so they need Scott (or an allowlist).
   - B (420) loaders and assets: gltf-pro, gltf, decoders, loaders, exporters, usdz, fbx, animation, animator,
     blender, ifc, materials, usdz-export, video, audio (most internal `any`: 143; loadGLTF/parseGLTF and
     parseUSDA/parseUSDZ clashes).
   - C (426) lighting, post and environment: environment, post, creative, clustered, tonemap, shadows, taa, sky, water,
     terrain, dof, oit, toon, transitions, splats, vfx, scatter, lod, webgl, culling (278 bare Errors, mostly
     mechanical; shader text must stay byte-identical: proofs + visual:check).
   - D (421) interaction, CAD and UI: physics, controls, machinery, bvh, react, xr, selection, labels, inspector,
     staging, stats, cameras, html, viewcube, gizmo, scenery (public `any`: physics raw Rapier 25, controls 17).
   Each group: `npm run hygiene` before/after, api:update only for intended type changes, zero JS byte change unless a
   proof says otherwise; then a short serial pass sets 1h.h's error codes and switches verify to `--strict`.
   GROUP A [DONE 2026-10-15, one commit on da7d1a4; groups B, C, D can start; `npm run check:merge` passed: 1,322/1,322
   node tests, 15/15 proofs --current, api:check, build:site, visual:check 55/55]. Rules and decisions: docs/conventions.md
   (shared types, errors, same-name exports); API changes: CHANGELOG.md.
   - Types (gate 5): `@margoengine/math` `src/types.ts` is the one home: `Vec2`, `Vec3` (declared in frozen core,
     re-exported by math: core cannot import math), `Vec4`, `Quat`, `MutableVec2`, `MutableVec3`, `Mat4`, `ColorInput`,
     `HeightField`, `Vec2/3/4Like`, `SphereLike`/`PlaneLike`/`BoxLike` (math's own five local copies merged). New
     `@margoengine/math/errors` (`MargoError`) and `@margoengine/math/mesh` (`meshWorldMatrix`, the one copy of what
     lines/points/text each had; they re-export it, as they do math's `parseColor`/`ColorInput`). Renamed clashes
     (API break, Scott is the only user): shader `Input`->`NodeInput`, `Stage`->`ShaderStage`, `TextureSource`->
     `BindableTexture`; points `projectPoint`->`projectToPixels`, `PickHit`->`PointsPickHit`, `Blending`->
     `PointsBlending`, `TextureSource`->`PointsTextureSource`; tween `smoothstep`->`easeSmoothstep`; lines
     `ExpandOptions`->`ExpandLineOptions`; procedural `SurfaceOptions`->`MarchingCubesOptions`; navigation `Vector3`->
     math `Vec3Like`; geometry's mutable `Vec2`/`Vec3` -> math `MutableVec2`/`MutableVec3`; lines/text local `Owner`
     -> `LineOwner`/`TextOwner`. Kept on purpose and allowlisted (`scripts/hygiene-allowlist.json` `names`, exempt only
     for exactly that package set): math vs shader `add sub dot cross length normalize clamp smoothstep` (CPU arrays vs
     WGSL nodes; `smoothstep` argument orders differ and are documented) and procedural vs shader `fbm ridged
     domainWarp` (CPU noise and its GPU twin). multiplyMatrices: math's `(a, b, out)` is canonical. A package whose
     .d.ts uses math types or that throws MargoError lists math under `dependencies` (14 packages); build-optional
     externalizes it (one runtime copy), lines/points/text/geometry still bundle it.
   - any (gate 3): shader's 48 public `Node<any>` are typed: free operators return `Node<BinaryResult<A, B>>`,
     component-wise built-ins `Node<Widest<A>>`, `length`/`distance`/`dot` its scalar (new exported helper types
     `Widest`, `BinaryResult`); `Store.buffer` is `StorageBuffer`. Two internal `as unknown as` casts remain, each with a
     one-line reason (StorageBuffer<T>/UniformNode<T> are invariant in T). shared `worker.d.ts` `serve` takes
     `(message: never) => unknown`.
   - TSDoc (gate 6): every group A export documented (purpose, units, ranges, defaults, throws), read from the code;
     core's 27 too (comments only).
   - Errors (gate 7): 27 bare Errors in group A packages converted (TypeError for shader stage misuse, MargoError
     otherwise; old message text kept as the prefix, so regex tests still match; the fix appended). shared's 6 use
     `margoError` (packages/shared/errors.js). Core 21 and stage 2 allowlisted (`errors`), unchanged.
   - Strict (gate 4): `noImplicitOverride` + `noFallthroughCasesInSwitch` on in the shared base
     (`packages/gltf/tsconfig.json`, 69 packages extend it), core and margoengine; 36 `override` added repo-wide
     (controls 14, environment 12, lines 4, shader 2, html, sky, vfx, math 1 each; erased, no emit change); no
     fallthrough errors. Left: react's own tsconfig (group D, 2 flags).
   - Lint and dead (gates 2, 9): 0 in group A (shared polygon's unused `validateContourIntersections` deleted, internal
     helpers un-exported; geometry `add` deleted; test unused bindings removed).
   - Bytes: core + stage 19,999 B gzip, raw 46,652 B, identical; core and margoengine dist byte-identical. Dist
     hashes against a clean build of c12eed9 (da7d1a4 only edits HANDOFF): 530 of 641 files identical (chunks compared with hashes
     masked); every .d.ts diff is the type work above; the 30 JS diffs are all the error convention or the math
     moves, gzip delta per file: text +221, points +110, shader +109, lines +105, usdz worker +93, water +87,
     navigation +84, animation/vat +82, wfc +78 / overlapping +71, gltf-pro asset chunk +77, ecs +73, fbx worker +71,
     fsm +69, blender +69, html +69, tween +66, gltf-pro worker +65, post scene-fade +65, materials +63,
     creative planet +62, gltf +60, cinematic +60, machinery cad +57, fbx +51, input +49, gltf-pro src +37,
     math index +18; new math entries errors 197, mesh 312.
   - Scorecard (`npm run hygiene`), group A (23 packages + shared) before -> after:
     format 0/190 10.0 -> 0/194 10.0; lint 9/190 5.3 -> 0/194 10.0; any 50/739 3.2 -> 0/741 10.0; strict 44/66 0.0 ->
     0/66 10.0; types 68/568 0.0 -> 14/564 7.5; tsdoc 224/544 0.0 -> 0/545 10.0; errors 56/385 0.0 -> 0/377 10.0;
     dead 10/1028 9.0 -> 0/1047 10.0; group A mean 3.4 -> 9.7 (types is the only gate below 10). Every group A package is 10.0 except core 8.8,
     math 8.9, geometry 9.4, shader 9.9 (types 1); their remaining type violations are the B/C/D copies below.
     Overall: format 10.0; lint 3.2 -> 4.1 (72 -> 63 files); any 3.7 -> 6.3 (121 -> 71); strict 0.0 -> 9.1 (146 -> 2);
     types 0.1 -> 4.3 (138 -> 79); tsdoc 0.0 -> 0.0 (593 -> 369); errors 0.0 -> 0.0 (534 -> 478); dead 8.5 -> 8.9
     (43 -> 33); hygiene 3.2 -> 5.3.
   - DUPLICATES GROUPS B/C/D MUST SWITCH TO MATH (each still charges the math/A side too):
     B: animation `multiplyMatrices(out, a, b)` (sampling.ts) -> drop the export, callers use math/mat4
        `multiplyMatrices(a, b, out)` (or rename it); audio `Vec3` -> math `Vec3`; materials local `type Color` ->
        math `ColorInput`; exporters `GeometryData` (different shape: ArrayLike positions) -> rename (e.g.
        `ExportGeometryData`) or accept geometry's; loaders `computeVertexNormals(positions, indices)` and
        `toGeometry(loaded)` (different from geometry's) -> rename; plus B's own `loadGLTF`/`parseGLTF` (gltf vs
        gltf-pro) and `parseUSDA`/`parseUSDZ`/`USDOptions` (loaders vs usdz).
     C: lod `Vec3` (mutable) -> math `MutableVec3`; environment `ColorInput` (`readonly [n, n, n]` arrays only) ->
        math `ColorInput` (keep the 3-component runtime check); sky local `type Color` (9 entries) and terrain local
        `type Color` -> math `Vec3`; terrain `HeightField` -> re-export math's; vfx exported `texture` feature
        object clashes with shader's `texture()` node -> rename vfx's (e.g. `textureFeature`) or allowlist with a
        reason.
     D: bvh `Vec3` (mutable) -> math `MutableVec3`, bvh `Ray` interface -> rename `BVHRay` (math `Ray` is the
        class); labels `Vec3` -> math `Vec3`, labels `composeMatrix(position, quaternion?, scale?, out?)` -> rename
        (e.g. `composeTransform`) or use math's `composeMatrix(t, q, s, out)`; physics `Vec3`, `Quat` -> math's;
        controls `V3` (mutable) -> math `MutableVec3`, controls `HeightField` -> math's; react `Mesh`/`PbrMaterial`
        components vs core's classes -> rename or allowlist (core is frozen); react tsconfig needs the two strict
        flags. Non-math duplicates in the scorecard (`Context`, `GeometryLike`, `ModelLike`, `PickProxy`, ...) are the
        owning group's own.
5l. Raise CAD performance and general 3D rendering to 9/10 (Scott, 2026-10-14 night). Measurable targets (Intel Arc
   laptop, quiet PC):
   CAD: 100k parts + feature edges orbit >= 60 FPS; 1M parts >= 30 FPS; pick < 10 ms at 100k; 100k-part model
   interactive < 2 s; km-scale coordinates jitter-free (5f.a); transparent housings without popping (5f.b).
   Status 2026-10-15 (a-d, 0 core bytes, core + stage 19,922 B): 100k parts + edges orbit MET with GPU small-part
   culling (61-88 FPS, two quiet-gated sessions; core path 28-30); pick < 10 ms MET on the `AssemblyBVH` path only (0.68 ms
   median raycast at 100k), NOT with `engine.pick` (34-54 ms; core re-renders the scene, the unmerged pick fast path is
   core step 4). Numbers, tables and raw JSON: docs/cad-performance.md "100,000 parts", `cad/results-5l-*.json`.
   a. [DONE] Small-part (screen-size) culling + distant-subassembly imposters for core meshes. Small parts: `CulledMeshes`
      `minRadius` (already in @margoengine/culling) is the cull; measured at 100k parts (100,008 parts, 1432x768 4x MSAA
      orbit, `run.mjs --culled=1.5`): 29.3 -> 137.8 FPS, GPU 31.1 -> 6.9 ms, 11,363 parts drawn. Imposters:
      `@margoengine/lod` `Imposter.bake(engine, mesh)` now bakes a Mesh's whole visible subtree (each part with its own
      material, transforms applied, mirrored parts flip winding; `packages/lod/src/imposter.ts`, lod +450 B gzip, test in
      lod.test.js); a module shown as one imposter under 12 px (`run.mjs --imposters=12`): GPU 3.0 ms but CPU-bound at
      91.7 FPS (each LOD switch toggles `visible` -> core re-collects, ~4 ms), so on this laptop small-part culling alone
      wins; imposters are for GPU-limited cases. Limits: imposter modules are not hit by `engine.pick`/`AssemblyBVH`
      (`lods.pickProxies()` reports them); one subtree scan per bake (bake once per distinct design, share the atlas);
      anchors must sit outside the subtree (+1 entity per copy).
   b. [DONE, verified] GPU culling for core meshes with picking, feature edges, exploded view and AssemblyBVH still
      working: `CulledMeshes` (5m.b hook) re-checked on the GPU 2026-10-15 (`cad/culled-meshes.mjs`: 0 differing pixels
      in 8 steps, pick grid identical, BVH hit). Package-side finish: `FeatureEdges` now draws from the redirected
      (culled) list, so edges get the same culling. Not done: Hi-Z occlusion for core meshes (it did not pay on this
      layout for CulledInstances); the `engine.start()` switch was added afterwards with Scott's approval (2026-10-15):
      `engine.start({culling: false})`, core + stage 19,922 -> 19,928 B (+6), test in tests/core-hooks.test.js.
   c. [DONE] Cheaper feature edges (`packages/machinery/src/edges.ts`): counts from core's batches (no per-frame loop over
      meshes: CPU 0.9-2.4 -> 0.07-0.2 ms), reads `CulledMeshes`' culled list, parts fade in between `minRadius` and 2x (no
      popping), segments stored longest first and drawn in 4 tiers (all, 1/4, 1/16, 1/64) chosen per part on the GPU from
      the projected length at its centre depth. GPU edges pass 4.3-4.4 -> 3.5 ms at 50k, 5.5-7.1 -> 4.3-5.6 ms at 100k with
      GPU culling; at 100k with CPU culling sessions disagree (-10 % / +2 %). `refresh()` removed (not needed). Edges
      entry 3,940 -> 4,530 B. Limit: a segment just over half a pixel near a large part's front can be skipped.
   d. [DONE] CAD correctness (machinery): section caps skip open shells (geometry with an edge not shared by exactly two
      consistently wound triangles, positions welded to 0.1 mm/unit; `capOpenShells: true` restores capping):
      `section-open-check.mjs` stray cap pixels on an open sheet 9,429 -> 0, closed box unchanged (8,337). Measurement:
      `measureDistance` composes the hierarchy in float64 below the anchors' common ancestor: 5 mm between parts of an
      assembly 1 km out, float32 world error 47 µm (4.4 mm at 100 km) -> 8.5e-11 m (`test/metrology.test.js`; the
      cameras origin test now asserts it). Snapping: `AssemblyBVH.snap` / `snapAnchor` / new `snapFeature` snap
      'vertex' to CAD corners and 'edge' to the closest point on a feature edge over the whole part (never triangulation
      diagonals or face interiors; before: hit-triangle vertices and triangle-edge midpoints). Sizes: section 3,958 ->
      4,325, metrology 1,173 -> 2,296, spatial 14,411 -> 14,941, dimensions 3,434 -> 3,880, machinery root 33,430 -> 34,608 B (edgesGeometry from
      @margoengine/geometry is external, 551 B, shared).
   (Plus already queued: back-face culling B, 5f.a-c, 5g.d streaming + entity cap decision.)
   General 3D: ~115/156 parity rows covered (93 of 159 now); every demo 60 FPS on the light tier; side-by-side renders that
   hold up against three.js/Babylon for the same scene.
   e. [DONE] Light probes: irradiance volume + local reflection probes, `@margoengine/environment/probes`
      (`packages/environment/src/probes.ts`, 10,845 B min+gzip, own entry; environment root byte-identical).
      `LightProbes.attach(engine, {environment?, volume?: {min, max, counts, sh?: 1|2, resolution?, blend?},
      reflections?: [{position, min, max, blend?}], resolution?})`, `probes.add(model)`, `await probes.bake({bounces?})`,
      `irradianceAt(position, normal)`. Volume: up to 4,096 probes at cell centres, L2 (or L1) SH as irradiance / PI like the
      environment's, trilinear (the 8 corners' packed float16 coefficients are blended, then evaluated once). Reflection
      probes: up to 16, octahedral radiance levels 128 px .. 4 px (level 0 resampled from the faces, levels 1+ a brute-force
      GGX convolution of level 0, n = v = r), box-projected, trilinear over levels by roughness, earlier probe wins where
      boxes overlap; boxes include their faces (a room box lights its own walls) and fade out over `blend` outside.
      Design decision: probes REPLACE the ambient term (named `margoAmbient`, so SSAO occludes them, like
      EnvironmentLighting) rather than adding through clustered's `clusterLighting` hook as area lights do: added
      ambient would double-count with IBL / scalar / hemisphere ambient and escape SSAO. Reach is the same receivers:
      core meshes (`engine.use`, patch at order -1) and every `add(model)` receiver (gltf-pro + materials through the
      `ambient` hook, terrain through the core-style patch). Fallback where the probe weight < 1: the `environment`
      (exactly EnvironmentLighting's term; patching both throws naming the fix) or the receiver's own ambient (core scalar,
      gltf-pro hemisphere), so unbaked probes change nothing. Bindings: ONE storage buffer (binding 26), no sampled
      texture; with an environment its same five IBL bindings: gltf-pro physical + every light stays at 16 textures, lit
      fragment storage buffers 6 of 8 with clustered + area. Bake on the GPU: one ordinary frame, then a capture pass at
      order -0.5 renders each probe's 6 faces (core meshes through core's fully patched lit shader drawn from the probe
      camera, via c.draw with a rebound Frame; added models via `draw` through a device proxy whose shader modules get the
      same edits: linear output, fog zeroed, clustered lights looped in full since the light lists are culled for the
      main camera), alpha 0 where nothing was drawn -> environment sky fill; one submit per face (gltf-pro writes its
      uniform per draw), one compute pass per probe (SH projection with workgroup reduction; octahedral resample and
      prefilter). Read back to the CPU after each bake (device restore re-uploads it). Zero core bytes.
      SSR off-screen fallback (5j limit 4) wired: LightProbes' WGSL exposes `probeSpecular(p,n,v,rough)`; post/ssr's
      replay and gltf-pro's capture hook record the pixel position (`var<private> margoPosition`, emitted only next to
      `probeSpecular`) and SSR removes the probes' specular where it hits, keeping the probe elsewhere. Bytes: post ./ssr
      +85, post root +85, gltf-pro root +28 / ./progressive +28 / ./worker +29 (min+gzip, vs ecdcb31).
      Proof `proofs/probes-decals.proof.js`: every pre-existing environment/post/clustered/gltf-pro/materials/terrain
      entry bundles byte-identical to the base except those carrying the SSR wiring (asserted to differ only by it); an
      EnvironmentLighting + Fog story records identical GPU calls (135) also with an unattached LightProbes; PostStack
      [SSR] / [SSAO, SSR, Bloom, FXAA] with a gltf-pro model reflecting through the capture hook, plain and IBL shaders,
      1x/4x: 12,320 identical calls; with LightProbes' shader the replay removes probeSpecular. Also identical:
      gltf-pro-lighting-hooks (4,556 calls) and oit-detached (2,964) with the base as ref.
      Real GPU (`examples/package-benchmarks/probes-gpu.mjs` + `probes.html`, results/probes-gpu.json, Arc 140V, Edge 155,
      AC, GPU lock): room of six walls radiating exactly their colour; volume SH vs CPU projection of the analytic room
      within 1.7% of DC (all 9 coefficients, 8 probes); reflection level 0 median 0.0002 (max 0.22 on wall-boundary
      texels), levels 1-5 vs CPU GGX convolution p95 <= 0.0083, max <= 0.04; shading through a CPU mirror of the WGSL:
      core + materials spheres and rough metal floor within 1/255, mirror floor p95 2/255 (max 5) away from wall edges,
      mirror vs the physical wall seen p95 2/255; env-only scene: probe SH = Environment SH within 0.05% of DC, spheres
      vs EnvironmentLighting within 1/255; unbaked = no probes (core and gltf-pro 0/255); SSR + probes: 99% of on-screen
      hits no brighter than both wall and probe (replaced, not added), off-screen = frame without SSR (p95 0/255).
      Cost (DIAGNOSTIC: quiet gate passed at 12% CPU but other agents' sessions were open): whole frame 4x, room +
      spheres, volume 4x2x4 + 1 reflection probe: 720p 0.6-1.1 -> 3.8-3.9 ms (volume alone 2.5, reflection alone 2.1);
      1080p 2.4 -> 8.1-9.2 ms (5.6 / 4.9); packing the SH into whole vec4u (32 loads per pixel instead of 72) took the
      720p 'both' from 4.8-5.2 to 3.5-3.9 ms (busy-machine runs). Bake (8 volume probes @16 px + one 128 px reflection
      probe): 114-121 ms, 382 ms first (pipelines). Tests:
      `packages/environment/tests/probes.test.js` (validation, layout, patches on core/clustered/terrain/env variants,
      gltf-pro hook, bake capture shader edits + submits + dispatches, CPU irradiance mirror).
      Limits: static (re-bake for changes; bake cost ~ probes x 6 scene renders); no per-probe visibility (leaks through
      thin walls: one volume box per room); one volume per LightProbes; box projection only; mirror reflections show
      128 px texel steps near wall edges; terrain/water/sky/particles are lit or seen only as the environment fill, not
      captured; GPU-culled CulledMeshes parts use the main camera's culling in captures; per-frame cost is real (above):
      a quiet-gated measurement and, if it holds, a cheaper volume path (L1 default, or one probe-lookup per tile) are
      the follow-ups.
   f. [DONE] Rectangle area lights (LTC), three.js RectAreaLight equivalent: `@margoengine/clustered/area`
      (`packages/clustered/src/area.ts`), `AreaLights.attach(engine, {lights})` + `setLights([{position, direction,
      width, height, up?, color?, intensity?, twoSided?}])`, up to 64. Intensity = radiance (three.js units; a light of
      area A equals a clustered point light of intensity `intensity x A` facing the surface, test to 0.1%). GGX specular
      + Lambert diffuse with linearly transformed cosines; each quad is clipped exactly to the receiver's horizon (three.js
      approximates), so diffuse equals the exact form factor. Composed inside clustered's `clusterLighting` through a new
      `Clustered.area` hook (like `shadow`), so core meshes and every `lights.add()` receiver (gltf-pro, materials,
      terrain) get it; intensityScale applies. LUT: 32x32 cells x 6 float16 (inverse matrix x,y,z,w + magnitude +
      Fresnel), our own fit by `scripts/build-ltc.mjs` (see provenance below) into
      `src/ltc.ts` (2D-predicted zigzag varints, base64), stored in the SAME storage buffer as the lights (binding 17)
      and filtered bilinearly by hand: 0 textures/samplers (gltf-pro "Texture bindings" unchanged; storage buffers in
      the lit fragment 3+1+1 = 5 of 8). Past ~84 deg on glossy surfaces the LTC approximation itself is off by up to
      ~35%. Accuracy
      (`packages/clustered/test/area.test.js`, vs midpoint quadrature of GGX height-correlated Smith + Schlick + Lambert,
      15 cases roughness 0.1-1, views 0-80 deg, one light crossing the horizon): diffuse < 0.2%; specular (F=1) within
      5% up to 60 deg, worst +17% at 80 deg r0.5; dielectric pixel within 14% up to 60 deg, worst -18% at 80 deg r0.5;
      mean |specular| error ~2%. Zero cost unless used: the buffer and hook exist only while the list is non-empty;
      `proofs/clustered-area-lights.proof.js` records 482 identical GPU calls vs 67e0172 at 1x/4x MSAA without the entry
      and with an empty AreaLights (and checks one light reaches both shaders). Sizes: clustered root 4,503 -> 4,590 B
      (+87, hook), `./area` 9,177 B gzip. Limits: no cluster culling (every fragment loops every area light: they have no
      range), no shadows from area lights, no textured lights, WebGPU only. Real GPU: real GPU (`area-lights-gpu.mjs`, Arc 140V, Edge 155, AC, lock): GPU = CPU mirror within 1/255 at 768 px x 4 floors (core + materials, glossy + rough), GPU vs brute force within 1.5% at 10 points, glossy highlight stretched z/x 1.35 vs rough 0.96, two-sided toggle exact, empty AreaLights byte-identical frame; GPU cost (diagnostic, not quiet) 1.25 ms -> 3.34/8.72/32.31 ms for 1/4/16 full-screen lights at 720p, ~1.9 ms per light (diffuse integral alone ~1.3 ms). Follow-ups: optional range + cluster culling of area lights, and a cheaper integral (the per-light cost is high for a full-screen light on an iGPU).
      Provenance (2026-10-15): the table first shipped resampled from three.js's copy of the ltc_code fit; it is now our
      own fit. `scripts/build-ltc.mjs` fits every cell from first principles by Heitz et al.'s 2016 method (the lobe's
      average direction fixes the frame; Nelder-Mead fits m11/m22/m13, minimising the cubed difference of the normalised
      GGX height-correlated lobe and the LTC, both importance sampled with the balance heuristic, each cell starting from
      its neighbour; magnitude and Schlick-Fresnel terms by 512x512 quadrature). Deterministic, single thread, ~1-2 min;
      reruns are byte-identical. Same storage format, area.ts unchanged. Old -> new vs brute force (area.test.js, 15
      cases): specular (F=1) mean 2.44% -> 2.43%, max up to 60 deg 4.54% -> 4.14%, 80 deg r0.5 +15.6% -> +17.2% (the one
      case clearly worse); dielectric mean 3.16% -> 3.08%, worst -18.6% -> -18.1%, up to 60 deg 13.67% -> 13.58%;
      diffuse unchanged (exact). A 151-case sweep (5 lights, 0-80 deg, r0.1-1) is a wash (specular mean 15.71% vs 15.72%,
      dielectric 3.03% vs 2.99%). Tried and rejected: a free frame tilt (specular max 3.8% but dielectric -26% at 80 deg
      and wild tails) and an L2 error (dielectric worst -19.9%). Real GPU with the new table (`area-lights-gpu.mjs`
      correctness, lock; results JSON left at its benchmarked run): GPU = CPU mirror within 1/255 on all 4 floors, GPU vs
      brute force within 1.6% at 10 points, stretch 1.35 glossy / 0.96 rough, two-sided exact. `./area` 9,177 -> 8,881 B
      gzip. AgX: the shared shader
      (`packages/shared/agx.js`, tonemap + post bloom) was adapted from three.js; it is now our own WGSL from the primary
      sources (Sobotka's AgX log range, Eary Chow's Rec.2020 inset/outset parameters, which reproduce Blender's
      config.ocio inset to 9e-9, Wrensch's published polynomial, ITU-R BT.709/BT.2020 primaries), every matrix re-derived
      in `packages/tonemap/tests/agx.test.js`. Inset/outset/curve equal today's by derivation (to 1.2e-8); full-precision
      Rec.709<->Rec.2020 matrices replace 4-digit ones, so output moves by at most 1.3e-4 linear (max abs per channel
      over 128^3 inputs 0 and 2^-14..2^8; at most 1 sRGB 8-bit code). Proofs: color-output and post-stack differ only in
      the agx() text (with that function normalised: 6,174 and 13,056 calls identical); quality-presets, creative,
      environment-volumetric and clustered-area-lights (482 calls) pass unchanged. tonemap 6,406 -> 6,326 B, post
      17,014 -> 16,917 B, post/bloom 4,855 -> 4,768 B gzip. NOTICE.md files cite primary sources only.
   g. [DONE 2026-10-15] Physical material on user-built meshes (materials package), with real transmission/refraction.
      0 core bytes (core + stage 19,999 B gzip, unchanged). `Material` physical options (three.js MeshPhysicalMaterial
      names, glTF KHR_materials_* meaning): `clearcoat`, `clearcoatRoughness`, `sheenColor`, `sheenRoughness`,
      `specularIntensity`, `specularColor`, `ior`, `transmission`, `thickness`, `attenuationColor`, `attenuationDistance`;
      which ones exist is fixed at construction, values are live; factors only (no physical maps), standard shading only.
      The mesh draws gltf-pro's own physical shader, so the BRDF code is shared, not duplicated: `factorPhysicalShader`
      (gltf-pro shader.ts, appended) is physicalShader with each extension-map read replaced by its default 1x1 texel and
      those 8 bindings removed, picked when a physical material lists only the 5 core maps (`m.maps.length>5` picks the
      mapped one, so every glTF keeps its shader). Materials physical = 10 textures (14 with shadows, IBL, LocalShadows and
      refraction). Refraction: new entry `@margoengine/materials/transmission` (`Transmission.attach(engine, {order = 3})`,
      `transmission.add(model)` for materials meshes and any gltf-pro model) through a declared gltf-pro hook,
      `model.setTransmission(PBRTransmission)` + `draw(c, 'transmission')` (README "Transmission hook"): transmissive
      primitives leave the beauty pass; on the first transmissive draw of a frame the HDR scene capture (`sceneTarget`,
      resolved at 4x) is copied into an rgba16float mip chain, then the lit physical shader adds `margoTransmission(s,v,i)`
      under clearcoat and sheen: exit point P + normalize(refract(-v, n, 1/ior)) x thickness x mean model scale, projected;
      mip log2(width) x roughness x clamp(2 ior - 2, 0, 1); Beer-Lambert attenuationColor^(path / attenuationDistance)
      (`margoVolume`, group 0 binding 1, a 16 B buffer per primitive); x base x transmission x (1 - metal) x (1 - Schlick
      at NdotV). Needs an HDR capture (named error otherwise). Without the plugin transmission keeps the tinted blend.
      Written from the Khronos glTF 2.0 spec Appendix B and the KHR_materials_* texts (screen-space approach of the Khronos
      sample renderer), not from three.js. Checks: CPU reference `packages/materials/test/physical-reference.js` with
      `physical.test.js` (F0 from IOR/specular, GGX and Charlie normalisation, Smith, clearcoat mix, Snell, Beer-Lambert,
      blur level, energy; mock GPU: factor variant has 10 textures, live uniforms, transmission passes at 1x/4x, volume
      rows, steady frames create nothing, hidden glass costs no copy, dispose restores the tint, no/LDR capture throws).
      Real GPU (`examples/package-benchmarks/physical-gpu.mjs` + `physical.html`, `results/physical-gpu.json`; Arc 140V,
      Edge 155, AC before and after, GPU lock, 256x256, correctness only): a materials sphere and the equivalent glTF
      sphere are identical (HDR and 8-bit max difference 0) for glass (refracting), clearcoat car paint and sheen fabric;
      the clearcoat and sheen layers against the CPU reference (one light, no ambient): relative error mean 0.07% / 0.08%,
      p95 0.22% / 0.25% (car paint max 6% at the clearcoat highlight peak; the default clearcoat normal texel is 128/255,
      the reference uses the exact normal); the light glass adds over a checkerboard against the CPU model: mean 0.0003,
      p95 0.001 linear HDR at 1x and 4x (the same pixels without refraction: 0.165); with shadows, IBL, fog, clustered and
      LocalShadows every materials preset renders and glTF glass throws the named 17-texture error (its 13 own maps); 0
      validation errors. Proofs vs 5a7bbc2 (no hook, no physical options): materials-uv-transform 1,277,
      gltf-pro-lighting-hooks 4,556, oit-detached 2,964 calls byte-identical; binding-limit passes against its e017d50
      baseline (post-ssr-models' default run fails on the base too: AgX shader text, unrelated). Sizes (min+gzip,
      entry-sizes.mjs): gltf-pro 18,610 -> 18,972, materials 6,908 -> 7,842, materials/transmission 2,503 (new); the usdz worker, which bundles gltf-pro, 27,964 -> 28,360.
      Limits: no physical maps; refraction is screen-space (off screen or in front of the glass is not seen, transmissive
      surfaces do not see each other, punctual lights do not shine through), `thicknessTexture` ignored, glTF glass with
      all three lighting packages exceeds 16 textures (5c.d's texture arrays would fix it).
   h. [DONE] Projected decals: `@margoengine/post/decals` (`packages/post/src/decals.ts`, 4,118 B min+gzip, own entry).
      `Decals.attach(engine, {atlas?})`, `setDecals([{position, direction, width, height, depth?, up?, rect?, color?,
      opacity?, angle?, mode?: 'multiply'|'over'}])`, up to 4,096. Screen-space: a pass at order 1.9 (after opaque core,
      gltf-pro/materials models and LOD; before sky, water, volumetric fog) draws each decal's box (back faces, no depth
      test: once per pixel, camera inside a box works), reconstructs world position from the post capture's scene depth
      (sample 0 at 4x), keeps pixels inside the box, normal from neighbour depths (per axis the nearer neighbour, so
      silhouettes do not smear), fades by angle to the projector (default 60 degrees, over its last third) and at the box
      ends, samples one atlas (rect, derivatives before discard). 'multiply' scales the lit pixel (keeps lighting and
      shadows), 'over' blends unlit radiance. One explicit bind group layout per depth kind shared by both blend
      pipelines; one storage buffer (96 B per decal). With no decals the pass records nothing (proof above). Tests:
      `packages/post/test/decals.test.js`. Real GPU (`decals-gpu.mjs` + `decals.html`, results/decals-gpu.json, Arc 140V,
      Edge 155, AC, GPU lock), 4x and 1x MSAA, every 8th pixel ray-cast on the CPU: outside every box (3 cm margin) the
      frame is exactly the decal-free one; multiply ratios within 0.04 (inverse neutral tone map); 90-degree cube sides
      untouched (0/255) while the top is marked; the floor below a box's depth range untouched; atlas 'over' exactly
      tonemap(0.6, 0, 0); camera inside a box draws; empty == none. Cost (DIAGNOSTIC: quiet gate passed at 6% CPU, other agents'
      sessions open): 720p 4x 1.64 ms -> 1.64 / 1.97 / 6.36 ms with 1 / 16 / 256 one-metre decals; 1080p 3.67 -> 3.93 /
      4.33 / 14.03 ms.
      Limits: needs a post capture (named error); per-pixel edges at 4x; BLEND primitives tinted with the surface
      behind; colour only (no normal/roughness decals); multiply cannot lighten; no culling of decals.
   i. HDR canvas output on HDR displays (with 5h.c Display P3). DONE: environment `ColorOutput` (`hdr: true`, `peak`) +
      Tonemap's HDR rolloff, zero core bytes; details, proofs and limits under 5h.c.
   j. [DONE 2026-10-15, 0 core/stage bytes, core + stage 19,999 B] Shadows for skinned meshes and VAT crowds; IBL for VAT
      crowds; the stage's stair-stepped shadow edge.
      - Skinned/morphed gltf-pro casters needed no code: `shadowPrimitives` already hands Shadows `primitive.deformed`
        (animation's compute pass runs at order -10, shadows at -5). Real GPU proves it now
        (`examples/package-benchmarks/deformed-shadows/check.mjs`, Arc 140V, Edge 155, GPU lock, AC): RobotExpressive
        walking as the only caster, shadow-map silhouette IoU 0.85 between clip times 0.25 s and 0.75 s, 1.0 repeated at
        0.25 s, 0.69 against the bind pose; the visible floor shadow changes too (screen IoU 0.74); 0 validation errors.
      - VAT crowds (`@margoengine/animation/vat`): `crowd.drawShadow` draws the posed instances into each cascade (own
        160-byte frame slot per cascade, the VAT vertex stage as a depth-only pipeline); `crowd.addLighting(effect)` takes
        effects with gltf-pro `pbr` hooks (Shadows, EnvironmentLighting) and composes them into a lit copy of the VAT
        shader with gltf-pro's hook points (lightPBR moved to `packages/shared/pbr-hooks.js`, gltf-pro uses it from there).
        Check above: 25 robots under a slab, crowd luma 182 -> 159 shadowed, 4,056 floor pixels darkened by the crowd,
        IBL changes 74% of crowd pixels, 0 validation errors. Cost (DIAGNOSTIC, quiet gate passed, other agents open;
        `results/deformed-shadows.json`): 1,024 walking robots 13.5 -> 35.8 ms per frame with casting (every instance in
        all four cascades; a per-cascade test in the vertex shader that skipped texture reads measured no gain and was
        dropped; GPU per-cascade instance compaction is the upgrade); one skinned robot 8.6 -> 9.6 ms.
      - Stage: the default `distance: 500` with camera near 0.1 put the 1 m cube in 13 cm texels (cascade 0 spans 0.1-63 m).
        With `distance` unset and only core-mesh casters, Shadows fits near/far to the bounding sphere of all core meshes
        (quarter-octave steps, so orbiting does not resize cascades); other casters keep 500 m. Stage check: 0.35 / 0.66 /
        1.1 / 1.8 cm texels instead of 13 / 25 / 42 / 98 cm, no stair steps (`test-results/stage-features-shadows.png`).
      - Unchanged when unused: `proofs/deformed-shadows.proof.js` (VATCrowd without effects; Shadows with `distance` or a
        non-mesh caster: GPU calls identical to HEAD), gltf-pro-lighting-hooks and binding-limit proofs identical, the
        unlit `vatShader` text byte-identical. visual:check 55/55. Sizes (gzip): animation/vat 5,552 -> 6,791, shadows
        6,433 -> 6,872, gltf-pro 18,972 -> 18,979 and materials 7,835 -> 7,842 (lightPBR now inlined from shared).
      - Limits: no SSAO or clustered lights on VAT crowds; Fog's hook composes but is not GPU-checked; the fit walks every
        core mesh each frame (pass `distance` for 100k-part scenes).
   k. Sweep the remaining PARTIAL parity rows that need no core change.
   (Plus already queued: SSR, volumetrics, progressive loading, OIT, P3, tier presets 5i.b.)
   l. SSR follow-ups (from 3cf1453): [DONE: model capture] `ssr.add(model)` (gltf-pro `PBRModel` or materials mesh;
      returns a remover) makes models REFLECT through a declared gltf-pro capture hook (`model.setCapture(PBRCapture)`,
      `draw(c,'capture')`: the lit shader with the beauty fragment renamed `margoShade` and called only in a dead
      `if(false)` block, entry `capture` returning SSR's `margoCapture(s,v,k)`; own maps, materials' maps, alpha mask,
      instances, skinned/morphed buffers; BLEND/transmission/unlit skipped). Replaced IBL term = environment's own
      split-sum x occlusion x k (k = clearcoat/sheen base-layer share, `layers(1)-layers(0)`), so no double counting.
      With models added the composite caps removal at what the pixel holds (4x silhouettes; 68 black pixels on the
      helmet before). Proofs: `proofs/post-ssr-models.proof.js` (no model added / no SSR: 30,858 calls identical to
      3cf1453); oit-detached, gltf-pro-lighting-hooks and materials-uv-transform identical to 227912f (no hook).
      Real GPU: `ssr-models-gpu.mjs` (results/ssr-models-gpu.json, Arc 140V): glTF-plane and materials mirror floors
      give the core floor's reflection (same mirrored centre colour, red area within 1.5%; green 165 -> 41 = replaced,
      not added), not added = unchanged, roughness map 0.3 blurs (edge 0 -> 17 px) and 0.8 is untouched, DamagedHelmet's
      metal picks up the red box (3,142 px changed, 1,015 redder), no black. Capture pass (diagnostic timing, machine
      not quiet): floor filling the view 0.19-0.21 ms at 720p, 0.44-0.46 ms at 1080p; DamagedHelmet 0.05 / 0.06-0.07 ms
      (the rest of the added cost is the trace on the newly reflective pixels). Sizes: post ./ssr 7,860 -> 8,365 B,
      gltf-pro root +238 B min+gzip (17,342 B after the rebase onto 67e0172); core untouched (19,793 B).
      Water and terrain: not done (own pipelines; each needs its own capture into SSR's targets, documented).
      Remaining: optionally water and terrain; half-resolution trace for
      1080p (trace 4-5 ms there); apply SSR's dead-branch replay trick to SSAO's ambient replay (it halved SSR's
      replay cost) with a proof that SSAO output is unchanged.
   n. Instanced paths vs three.js InstancedMesh (diagnostic, 836b97e: three's WebGL2 InstancedMesh leads at every
      size): give `CulledInstances` the culled pipeline (cullMode back, no discard) and a bulk transform upload (10k
      moving boxes cost 187 ms CPU: one 64 B write per setTransform); profile `createInstancedMesh`'s GPU time vs three
      (gltf-pro shader + ACES vs three's) and close what's package-side. Re-measure with the vs-threejs harness pairs.
   o. [DONE 2026-10-15] CSP follow-ups (from 1a36f67): the decoders worker runs Draco/Basis glue through `eval` (needs per-file
      `'unsafe-eval'`) - load them as module/classic workers or wrap them so the strict page CSP covers everything;
      occt-import-js uses `new Function` (third party: document, or wrap); the site build copies the 7.6 MB OCCT .wasm
      and CAD code into every demo folder though no demo imports STEP (deploy size only) - stop copying it.
      DONE: no file needs `'unsafe-eval'`, workers included. (1) `decoder.worker.js` is now a prebuilt, self-contained
      classic worker (`packages/decoders/scripts/build.js`, Vite iife; `pool.ts` references it as
      `new URL('./decoder.worker.js?no-inline', import.meta.url)`, the gltf-pro pattern) that loads the Draco/Basis
      wrappers with `importScripts`; `codec.ts` lost its `(0, eval)` loader. Asset name unchanged (`decoder.worker-*.js`),
      app still passes `decoderPath`/`transcoderPath`. (2) Basis and occt-import-js 0.0.23 are embind builds without
      `DYNAMIC_EXECUTION=0` (occt-import-js 0.0.23 ships dist, its C++ wrapper, CMakeLists with `--bind` and Windows build
      scripts, not the OpenCascade submodule: rebuilding is not ours).
      But embind's `new Function` is JS-side only: `scripts/static-embind.js` rewrites the glue's two generators
      (`craftInvokerFunction`, `_emval_get_method_caller`) into the closures `DYNAMIC_EXECUTION=0` emits, with exact
      patterns (a different Emscripten version fails the build) and a modification notice in each file's first line;
      applied to dist `basis/basis_transcoder.js` (decoders build) and `workers/occt-import-js.js` (build-modern.js). Both
      `.wasm` files and the Draco wrapper are unmodified; NOTICE.md / OCCT-NOTICE.txt (LGPL-2.1) say so. Proof:
      `tests/no-eval-workers.test.js` (in verify) runs each glue in a Node vm context with code generation from strings
      disabled: vendor Basis and OCCT glue throw `EvalError`; shipped glue gives byte-identical KTX2 transcodes (all 4
      targets), identical `as1-oc-214.stp` and `Cube 10x10.igs` reads; Draco Box/Avocado identical; built workers have no
      `eval`/`Function(`. Glue sizes: Basis 57,548 -> 58,505 B, OCCT 96,871 -> 97,826 B (raw); decoder worker 5,405 B.
      (3) `scripts/build-site.js` resolves `@margoengine/machinery*` to a stand-in that throws for the four demo builds on
      the stage facade (the stage's lazy `load()` CAD import pulled OCCT in): `demos/`, `demos/earth/`, `demos/dof/`,
      `demos/tonemap/` each lose 7,793,583-7,793,677 B of assets (OCCT .wasm + glue, `cad-runtime`, CAD chunks; 31,174,612 B
      in all; night-citadel and gameplay-sandbox unchanged). (4) Evidence: `csp-check.mjs` harness now serves the
      create-margo `_headers` unchanged (`scripts/csp-check/eval-workers.headers` deleted; site/_headers loses its Tokyo-corner decoder-worker eval rule): 14/14 pages PASS, zero
      violations (`results/csp-check.json`); override runs are now recorded in `results/csp-check-negative.json`:
      `script-src 'self'` -> Engine.create's "WebAssembly.compile(): Compiling or instantiating WebAssembly module violates
      ..." page error; the strict policy on every file -> all 8 harness steps pass. claims DOC-072/074, LIM-023/024 updated
      (DOC-074/LIM-024 PROVEN; launch gate 10's CSP rows clear). Docs: deploying.md (eval rules removed from the three
      configs, new "Third-party Emscripten code without eval"), limits.md, decoders README, template README/_headers,
      site/_headers, guides/blender-game.md; `tests/create-margo.test.js` asserts the template has no `'unsafe-eval'`.
      decoders `npm run test:browser` passes with the classic worker (Vite dev server and production consumer, Edge
      155, GPU lock). Firefox/Safari CSP unverified; visual regression not re-run (no render code changed).
   p. [DONE] gltf-pro failed on the 62 MB conveyor GLB ("Unsupported glTF accessor", also without the cache). Cause:
      not a format feature - `GLTFAsset.accessor` capped every accessor at 1,000,000 elements, and two uint32 index
      accessors are larger (174: 1,021,494 for mesh 66 "Mesh_16"; 487: 1,480,944 for mesh 171 "Mesh_15"). The file is
      otherwise plain (float POSITION/NORMAL, one float TEXCOORD_0, uint16/uint32 indices; no normalized, sparse,
      byteStride or extensions). Khronos glTF-Validator 2.0.0-dev.3.10: 0 errors, 0 warnings, 4 infos (an unused
      TEXCOORD_0, 3 empty nodes). Fix (asset.ts/pack.ts only): the element cap is gone (the 256 MB decoded budget bounds
      accessors); vertices stay capped at 1M per primitive in packPrimitive (vertex buffers are also bound as storage,
      and indices pass through Float32), matching validatePreparedGeometry on the worker path. Errors now name mesh,
      primitive, attribute and accessor, e.g. `glTF mesh 0 "part" primitive 0: COLOR_0 (accessor 1): Unsupported glTF
      accessor 1 (componentType 5126, type MAT3)`; gltf-pro.proof.js compares error class + baseline text contained.
      Tests: packages/gltf-pro/tests/accessors.test.js (generated GLBs: 1,000,002 uint32 indices decode exactly on
      both paths; >1M vertices still refused; located message) plus the real conveyor file (skipped when only the LFS
      pointer is checked out): 570 primitives, 2,445,355 triangles, main thread == worker byte for byte. Real browser
      (Edge, Arc 140V): loadGLTF 8.7 s, loadGLTFInWorker 5.0 s, through @margoengine/cache 4.3 s, same geometry digest,
      no GPU errors. gltf-pro +236 B gzip (root entry), +221 B (/worker). Follow-ups: the file is 65.1 MB of the 64 MiB
      (67.1 MB) download budget, so a slightly larger export will fail "glTF download byte budget exceeded"; the
      main-thread path packs a mesh once per node that uses it (570 packs for 242 meshes, ~220 MB instead of ~166 MB),
      the worker path packs each once.
   r. [DONE] gltf-pro memory/limits from the conveyor fix (0c24e76). (1) The main-thread PBRModel packs each mesh
      primitive once (per-model map keyed by primitive definition) and nodes sharing it share the arrays, so setup's
      array-keyed upload cache makes one vertex + one index buffer per mesh primitive, as the worker path did; node,
      weights, material, instances stay per node (packing never depended on the node). Proof: per-primitive sha of the
      bytes written to its vertex/index buffers (recording mock device, scratch harness) identical before/after for
      DamagedHelmet, RobotExpressive, the conveyor GLB and an instanced fixture (EXT_mesh_gpu_instancing node + 3 plain
      nodes on the same mesh); real browser (Edge 155, Arc 140V, quiet-gated, GPU lock, 5 alternating reps): same
      geometry digest and identical frame pixels. Conveyor: GPU geometry 1,140 buffers / 231.3 MB -> 484 / 173.7 MB;
      retained ArrayBuffers in Node 298.9 -> 241.3 MB, peak RSS 431 -> 376 MB; browser renderer ArrayBuffer backing
      store after GC 364 -> 306 MB; browser load to first frame 1,104 -> 973 ms median (Node parse+setup 867 -> 649 ms,
      but that run was on a busy machine: diagnostic only). (2) `maxDownloadBytes` on loadGLTF, parseGLTFAsync,
      loadGLTFInWorker, parseGLTFInWorker and loadGLTFProgressive (validated positive integer; parseGLTF keeps the
      default). Default raised 64 -> 128 MiB (2x the conveyor file; ~0.8 GB peak extrapolated from its 5.7x Node
      ratio, desktop-safe, risky on phones); decoded accessors, packed geometry and images get 4x it. Every budget
      error names the option, e.g. `glTF exceeds download budget (134217728 bytes; raise the maxDownloadBytes option)`
      (old message text kept as prefix). Progressive external images now count toward the budget too. Tests:
      accessors.test.js (sharing + GPU buffer dedup vs worker-packed bytes, conveyor 242 distinct arrays, budget on
      main/worker paths), progressive.test.js (loadGLTF + progressive main/worker, ranged and plain, at size-1 / size).
      gzip: gltf-pro root 17,342 -> 17,552 B (+210), /progressive +247, /worker +226, /prepare +166, /asset +113,
      workers/gltf.js +166, workers/progressive.js +141. Core and stage untouched. README "Download budget and memory".
   t. Physics (Scott agreed, 2026-10-15): never write our own rigid-body solver; keep `@margoengine/physics` (Rapier,
      Apache-2.0) optional and lazily loaded (note: Rapier's Wasm is also ~1-2 MB, similar order to Havok - the win is
      that it's optional, not small; never claim otherwise). Add ergonomics: (1) colliders (trimesh/convex) from a
      glTF node hierarchy in one call, (2) bodies on nested nodes (both also in q), (3) audit the Rapier -> Margo
      transform sync for per-frame allocations and make it allocation-free, (4) a Wasm-free kinematic character
      controller on the bvh Raycaster (walk, slopes, steps, jump, collide with the level) for simple games, with Rapier
      as the upgrade path. Measure bundle size of (4) and of the physics package + Rapier honestly.
      Scott (2026-10-15): (4) must also serve architectural / real-estate walkthroughs: eye height (default ~1.65 m)
      held by down-rays, step height (~0.19 m) for stairs, slope limit, capsule-style wall/counter/glass collision,
      WASD + mouse look, mobile virtual thumbstick + drag-look, smooth (no teleport), and a toggle to an orbit
      "dollhouse" view. Use `@margoengine/bvh` (Raycaster) for collision.
      (4) [DONE] `WalkControls` in a new entry `@margoengine/controls/walk` (`packages/controls/src/walk.ts`; zero bytes
      unless that entry is imported; controls already peers on bvh and owns OrbitControls, which the dollhouse uses, so
      no new package). Collision runs on the Raycaster's own cached trees (`getGeometryBVH`/`getPrimitiveBVH`: core
      meshes, gltf-pro and materials models, instanced primitives, hidden meshes skipped) with one world-box broadphase
      per frame and allocation-free tree walks, not `Raycaster.intersect*` per ray (sorted all-hit lists, a scan of every
      object per ray). Floor: 9 vertical rays per sub-step (centre + ring at 0.9 r) in one tree pass, highest walkable
      hit within `stepHeight` (0.19), eased eye (1.65); falls land only on floors crossed. Walls: capsule from
      stepHeight to head, exact segment-triangle closest points, horizontal push-out, sub-steps <= r/2 (no tunnelling).
      Slope limit, gravity + jump (off by default), crouch with headroom check, WASD/arrows, pointer-lock or drag look,
      first gamepad, touch floating thumbstick (left half, drawn) + drag-look (right half), `axes` for
      @margoengine/input; dollhouse: eased yaw/pitch/distance transition to an OrbitControls view of the bounds and back
      to the exact pose, orthographic through a CameraProjection, saved pose follows a FloatingOrigin rebase.
      Tests: `packages/controls/tests/walk.test.js` (10 tests, generated geometry incl. `tests/house.js`, a two-storey
      house with 16 stairs, deck with gaps, rug, counter, glass pane). Real browser: `npm run test:browser:walk
      --workspace packages/controls` under the GPU lock (Edge 155, Arc 140V, AC): walked the house with the real W key in
      2,176 frames, worst capsule clearance 0.292 m (r 0.25), largest eye change 2 cm/frame, dollhouse out and back,
      phone viewport thumbstick 2.16 m in 1.5 s and drag-look 0.200 rad, 0 WebGPU errors; update() median 0.1 ms, max
      0.9 ms at the browser's timer resolution. Sizes (`examples/package-benchmarks/walk-size.mjs` ->
      results/walk-size.json): WalkControls 11,985 B min+gzip incl. OrbitControls, 21,844 B incl. the bvh code;
      `Physics` 8,057 B + rapier3d-compat 0.21.0 `rapier.mjs` 1,645,573 B gzip (4,340,292 raw, Wasm inlined as
      base64; the bare Wasm is 3,082,103 raw / 1,176,707 gzip). CPU (`walk-cpu.mjs` -> results/walk-cpu.json, Node 24, one thread,
      quiet gate passed at 20% CPU with other agents running, so diagnostic): warm update() median / p99 / max
      0.010 / 0.17 / 0.50 ms on the house, 0.033 / 0.21 / 0.65 ms on a 16-house block (912 meshes), 0.033 / 0.23 /
      0.90 ms on the conveyor GLB (570 primitives, 2.45M triangles); cold first-touch frames up to 57 ms there
      (synchronous BVH builds). Not done: a roof-hiding "cutaway" dollhouse (apps hide roof meshes; hidden meshes
      don't collide), moving platforms. Limits (README): static
      levels (last frame's matrices, no moving platforms), bind-pose skinned meshes, ring can lift the eye
      0.9 r tan(slope) on slopes, first-touch BVH builds are synchronous (prebuild with computePrimitiveBVHAsync).
      (1)-(3) [DONE] (`packages/physics`; Rapier still optional and passed in, never imported; zero core bytes).
      (1) `physics.addModel(model, {type, shape, perNode, filter, collider, ...body options})`: one call turns a
      gltf-pro `PBRModel` (or materials mesh; structural `ModelLike`) into colliders, one per primitive and per
      instance of an EXT_mesh_gpu_instancing primitive, with every node, instance and scale transform baked into the
      collider points (body space = world under the anchor's rigid pose). Default one body on `model.root` (a level, or
      a prop moving as one); `perNode: true` puts a body on each node (hits report the Blender object). Shape: trimesh
      for fixed/kinematic, convex hull for dynamic (a Rapier trimesh has no mass). Error part-way removes every body it
      made. (2) Bodies on child meshes: `addBody(node)` starts at the node's world pose (fitted colliders use the world
      scale) and each sync writes the pose relative to the parent's *current* world transform, composed in float64
      from the parents' local TRS (`src/transform.ts`), so no frame of lag when the parent moves; resting child bodies
      are rewritten every frame (they hold their world pose). Exact for rotation + uniform/per-axis scale parents;
      sheared parents get the nearest rotation. Fake (non-core) meshes with parents are refused. (3) Allocation audit:
      the old frame path allocated about 2,316 B per `sync()` of 16 moving bodies (Math.hypot's argument array in the
      slerp, the boxed interpolation factor passed to the non-inlined slerp, validating setters) and about 357 B per
      step of wrapper code (events array + drain closure, listener snapshot spread, pose getters returning new objects).
      Now `sync()` writes core's transform storage directly with the slerp inlined and Math.sqrt; `step()` drains into
      a reused array with a stable callback, dispatches with `Set.forEach(fn, event)`, and reads poses into private
      class instances (object-literal shapes are shared program-wide by V8 and had generalized to boxed fields: every
      write allocated). A dynamic body asleep since the previous step skips Rapier's getters. Proof:
      `packages/physics/tests/allocations.js`, run by physics.test.js in a child with `--expose-gc` and a 64 MB young
      generation, counts young-space bytes over 20,000 calls with v8.GCProfiler proving no collection in the window:
      requires < 1 B/call; measured 736 B total for 20,000 syncs (one-off) and 0 B for 20,000 wrapper steps (Rapier's
      step and getters stubbed out of that case). Not fixable here, measured by the same script (Node 24, Rapier
      0.21.0): Rapier's own `World.step` allocates ~10.9 kB per step with 16 awake bodies, and each pose getter ~32 B
      (its wasm-bindgen glue makes a Float32Array view of Wasm memory per call); queries and `CharacterController.move`
      results also allocate. Tests: physics.test.js 33 pass (new: child bodies, addModel trimesh/instances/perNode/
      filter/rollback, dynamic convex model, allocation count). Size (walk-size.mjs method, core external, min+gzip):
      `Physics` 8,057 -> 10,289 B (+2,232: addModel, child bodies, transform helpers, math invert/multiply).
   u. ArchViz / real-estate walkthrough showcase (Scott, 2026-10-15): a demo for the final-phase rebuild - a modern
      house GLB loaded with progressive streaming, walk mode with the (t.4) controller, dollhouse orbit toggle,
      environment lighting + shadows (check whether gltf-pro supports lightmaps on a second UV set; queue it if not),
      mobile-first. Needs a house model whose licence allows a public demo (CC0/CC-BY) - Scott picks; don't download
      without asking. Measure (don't assert) load time and memory on desktop and a real phone, with and without
      Rapier. Public copy states Margo's measured numbers; no competitor-bashing. Plus a cookbook recipe in item 8:
      "A mobile-first architectural walkthrough in ~50 lines".
   v. [DONE 2026-10-15] Procedural generation. 0 core bytes (core + stage 19,922 gzip, unchanged); new subpath entries,
      min+gzip with other packages external (entry-sizes.mjs method): `@margoengine/procedural/noise` 2,058,
      `/lsystem` 2,198, `/voronoi` 4,770; `@margoengine/wfc/overlapping` 1,931; `@margoengine/shader/noise` +1,964 over
      the shader root (4,497 standalone, it shares the node chunk). `@margoengine/procedural` now has NO third-party
      runtime dependencies (Scott, 2026-10-15): root entry 4,976 -> 6,776 with npm deps external, but what an app ships
      (deps bundled) 9,976 -> 6,776 (`proofs/procedural-deps.proof.js` -> `results/procedural-deps.json`). READMEs have a
      section each; example pages
      `packages/procedural/examples/{lsystem,voronoi}.html`, `packages/shader/examples/noise.html`,
      `packages/wfc/examples/overlapping.html` (Vite at the repo root).
      (1) L-systems (`procedural/src/lsystem.ts`): `expand` (seeded stochastic weights, parametric rules with conditions,
      function successors, module budget), `interpret` (3D turtle: F/G f/g + - & ^ \ / | [ ] !; segments feed
      `@margoengine/lines` directly), `tubes` (joint rings shared along same-depth continuations). Limits: no
      context-sensitive rules, no expressions inside successor text, open tube ends.
      (2) Voronoi (`procedural/src/voronoi.ts`): Bowyer-Watson `delaunay2`/`delaunay3` (cavity repair: a facet the point
      does not strictly see drops its cell, so grids/co-circular input never overlap; duplicates skipped), `voronoi2`
      (polygons, per-edge sites, unique edges) and `voronoi3` (convex cells, faces, face sites, volume) clipped from the
      bounds by Delaunay-neighbour bisectors; `fractureMesh` (welds, clips by each cell plane, caps cuts with earcut
      incl. holes; collinear cap points the triangulator drops are split back in, cut points on the plane are merged by
      position, otherwise later cuts hit T-junctions). Checked: 240 fractures of box/icosphere/UV sphere/torus closed
      (area-vector hole < 2e-6) with volume conserved to 2e-7. Limits: O(n^2) (scan all cells per insertion; walk is the
      upgrade past ~20k points), closed input mesh, caps flat-normal without UVs, non-indexed chunks, CPU only.
      (3) Noise: `procedural/src/noise.ts` holds `Noise` (moved from index, same API) with `simplex2`/`simplex`/
      `simplex4`, plus `fbm`/`ridged`/`domainWarp`, `permutation`, `SIMPLEX_SCALE`. Own simplex written from Perlin 2001 /
      Gustavson (rank ordering, kernel (0.5 - d^2)^4 in all dimensions, so seamless; scales fitted by sampling +
      hill-climbing so |v| < 1). BREAKING (README): `Noise.simplex` values changed (simplex-noise's 0.6 3D kernel jumps
      5.9e-3 across simplex faces; ours < 1e-6, `test/noise.test.js` checks faces, range, mean/deviation, determinism);
      perlin/worley and the island preset unchanged. `simplex-noise` and `isosurface` removed from package.json and the
      lockfile (offline). `marchingCubes` is now own marching tetrahedra (6 tets per cube along the main diagonal, shared
      edge vertices, winding toward the outside corner): test checks closed + consistently wound + Euler characteristic
      (sphere 2, torus 0) + volume within 2% + sane vertex count. Diagnostic speed vs the old deps (not quiet-gated): 3D
      simplex ~0.9x, 64^3 sphere surface ~1.8x faster (skips cubes the surface misses). No demo calls `simplex` or
      `marchingCubes` (the island uses perlin), so visual baselines are unaffected. WGSL twins in
      `shader/src/noise.ts`: `simplex2`, `simplex3` (seed's permutation as a packed `var<private>` table, declared once
      per shader), `perlin3` (seed may be a u32 node), unrolled `fbm`/`ridged`/`domainWarp`. Real-GPU CPU/GPU agreement:
      `node scripts/gpu-lock.mjs run --owner=<id> -- node packages/shader/test/noise-check.mjs` (4096 points per field):
      passed (msedge channel, adapter intel xe-2lpg = Arc 140V): max |GPU - CPU| simplex2 1.6e-5, simplex3 2.0e-5, perlin3 1.4e-6,
      fbm3 1.9e-5, ridged2 3.7e-5, warp3 4.1e-5, warpFbm2 1.1e-4 (before the seamless kernel, warp3 jumped 2.7e-3 at a
      lattice point). Correctness run, so not quiet-gated. Typing fix in shader `uniform`: `{type: 'u32'|'i32'}` now types as that uniform (was f32; 0 bytes).
      The shader noise API report lists 27 unexported types and 1 `any`: all node.ts's own (Node/Builder/Emit), shared
      with the root entry; for the 5k hygiene pass. Not done: GPU simplex4/Worley.
      (4) WFC overlapping (`wfc/src/overlapping.ts`): N 2..5, symmetry 1..8, periodic input/output, AC-4 supporter counts,
      chronological backtracking on a trail (undo + forbid the failed choice) with a per-attempt budget, then seeded
      restarts, then a throw; hang-proof test runs an unsatisfiable case in a child process with a timeout. A 7 x 7 maze
      sample (symmetry 1) fails 6/6 seeds without backtracking and solves 6/6 with it. Limits: <= 4096 patterns,
      cells x patterns <= 4,194,304, O(cells) entropy scan per choice (heap is the upgrade past ~128 x 128), no pins.
   q. Game-developer gaps from the Blender guide (2eb78b9): a helper that collects a model's world-space triangles
      (for physics colliders and navmeshes); physics bodies on non-root meshes; water refraction can't combine with
      SSAO (needs a scene texture from PostStack); camera rig avoids walls, not just terrain; audio listener on
      something other than the camera; a runnable example game with a rigged character + Blender level GLB (for the
      demo rebuild).
      [DONE except the example game] All zero core bytes; docs/guides/blender-game.md updated (snippets type-checked).
      - World triangles: `worldTriangles(engine, objects, {refresh, filter})` in `@margoengine/bvh`
        (`packages/bvh/src/triangles.ts`): core meshes + gltf-pro/materials models, node/instance/scale transforms,
        skinned in bind pose, merged world-space `{vertices, indices}` (spreads into a physics trimesh, feeds
        `Navigation.create`). Runs the kernel first; hidden meshes not skipped (use `filter`). Test
        (bvh models.test.js): helmet + quad hierarchy + scaled core mesh + instanced primitive, rays at the merged BVH
        give the Raycaster's distances. Size: `worldTriangles` alone 813 B min+gzip; bvh whole index 14,032 -> 14,432 B;
        `Raycaster` alone unchanged (12,674 B).
      - Bodies on non-root meshes + one-call model colliders: see 5l.t (1)-(2).
      - Water refraction + SSAO: `PostStack.sceneTexture` (`packages/post/src/stack.ts`) exposes the shared 1x
        rgba16float capture when the stack has an HDR or display effect (undefined otherwise), which is exactly what
        Water's `sceneColor` validates; no water or core change. Unit test (post stack.test.js: format, 1x, size, COPY_SRC
        + TEXTURE_BINDING; undefined for an LDR-only stack). PostStack +21 B. Real GPU (`packages/water/test/stack.browser.mjs`, run
        under the GPU lock; Edge, Intel Arc 140V; correctness only, no timing): PostStack([SSAO, Bloom]) + Water with
        `sceneColor: () => stack.sceneTexture`, 0 WebGPU validation errors; an underwater red block shows through the
        water (patch redness R-(G+B)/2 = 111.7 with refraction vs -4.8 with the approximate seabed colour); SSAO is live
        in the same frame (232 pixels change at a cube/platform crease when it is disabled). Not checked: how SSAO
        shades the water surface itself (the scene depth does not contain it).
      - Camera walls: Cinematic `collide: (origin, direction, distance) => hit | null` (any query: physics sphere cast,
        bvh Raycaster). Pull-in is instant to `clearance` short of the hit, ease-out at the follow damping, spring state
        and `offset` untouched (`packages/cinematic/src/index.ts`, test in cinematic.test.js). Cinematic 1,489 -> 1,760 B.
      - Audio listener: `listener.follow(mesh | 'camera' | null, forward = [0, 0, 1])` (world position, local forward
        axis, local +Y up from the engine's world matrices; null = setPose only) (`packages/audio/src/listener.ts`, test
        in audio.test.js). AudioListener 2,331 -> 2,694 B; audio whole index 6,339 -> 6,658 B.
      - Not done, for the demo rebuild: a runnable example game with a rigged character + Blender level GLB. Needs: a
        CC0/CC-BY rigged character with Idle/Walk/Run/Jump actions and a Blender-made level GLB with `extras` markers
        (Scott picks; no downloads without asking); an `examples/` app wiring loadGLTF + `physics.addModel(level,
        {type: 'fixed', perNode: true})` + a kinematic capsule on `hero.root` with CharacterController + Animator blend
        tree + Input + Cinematic with `collide` + `listener.follow(hero.root)` + PostStack with water; a browser test
        (walk, jump, coin trigger, no WebGPU errors) and measured load/frame numbers on the light tier.
   s. [DONE] Load-flaky tests in verify. Reproduced each under a 128-thread CPU burn and fixed (tests only):
      - catalog: headless Edge shuts down on low-priority threads, so under load `browser.close()` took 4-6 min
        (graceful close fails after 30 s, then the killed process takes minutes to tear down; 237-394 s measured, even
        with no page work), and the example copy raced the async clipboard write. The verify test now runs catalog.js
        in jsdom against the real preview server (search, ?q= persistence, markup-safe search, clear/focus, every
        install/imports/example copy, export import copy, denied-clipboard fallback, no page errors or CDN loads).
        The real-browser test (layout overflow at 375/1440 px, real clicks and clipboard) moved to
        `tests/browser/catalog.test.js`, `npm run test:catalog:browser` (also in `test:release`); run it under the GPU
        lock: `node scripts/gpu-lock.mjs run --owner=<id> -- npm run test:catalog:browser`. It waits for each clipboard
        write to land before reading.
      - decoders, gltf-pro progressive (and the same pattern in gltf-pro extensions and loaders): `fetch` reused an
        idle keep-alive socket just as the in-process test server's 5 s keep-alive timer closed it (a synchronous
        stretch, e.g. 220 Draco decodes or a big loadGLTF, ran past 5 s under load) -> `fetch failed` ECONNRESET.
        Test servers now set `keepAliveTimeout = 0` so only the client closes idle sockets. Use this for any new
        in-process test server that `fetch` talks to.
      - geometry triangulate-inputs: the 1.5 s spawnSync timeout included Node child startup (ETIMEDOUT under load).
        Kill timeout is now 120 s (catches a hang); the 1.5 s budget is asserted on the child's own CPU time for the
        calls.
   m. [DONE 2026-10-15, with 5l.f] docs/threejs-parity.md summary counts drifted (OIT added a COVERED row without
      updating the totals). Script recount of every row's status column: the summary said 158 rows, 91 / 39 / 28; the
      rows were 159, 92 COVERED (51 †) / 39 PARTIAL / 28 MISSING, no duplicate rows. After RectAreaLight (5l.f):
      93 / 39 / 27, recounted again by script. Summary, "How this was checked" and claims DOC-063 updated.
   Order: after the current wave, alongside the hygiene phase (5k) and under its gates, before the demo rebuild.
5m. [a DONE, b DONE (hook +34 B); core + stage 19,922 B gzip, 77 B headroom] CORE APPROVALS, conditional (Scott, 2026-10-14 night): do both IF core+stage stays under 20,000 B gzip
   (`npm run measure:size`; the build gate fails at >= 20,000). No safety margin needed: 19,999 is acceptable (Scott).
   Start after back-face culling B merges (~19,789).
   a. Raise the 100,000-entity cap (Rust/Wasm kernel + JS side) so streaming can reach 1M parts: measure memory per
      entity (the kernel uses ~66 B/slot + JS ~5 B/slot) and bytes; prefer growth on demand over a bigger fixed
      allocation; keep the dirty-skip fast path; tests at 1M entities in Node.
   b. A core hook letting a package's GPU culling drive regular core meshes (5l.b) - ONLY if the culling package can't
      do it alone; first try package-side. Smallest hook that works; measure bytes.
   If a+b together would cross 20,000, do (a) first, report the remaining budget and the hook's exact cost to Scott,
   and fall back to package-side streaming (CulledInstances) for whatever doesn't fit. Report the final core+stage
   total and remaining headroom.
   Result (a): the store grows on demand: `capacity` is the initial size, `createMesh` doubles it when full, up to 2^23
      (8,388,608) slots. `TransformStore.grow` drops the Wasm kernel and creates a larger one at the same address,
      re-binds views and every `mesh.matrix`, copies values back; failure keeps the old store. Next tick recomputes all
      once; dirty-skip and "failed tick publishes nothing" unchanged. +95 B (19,793 -> 19,888). Memory: 351 B/slot in
      the kernel (the "~66 B" above was only the dirty-skip snapshot), 5 B/slot in the engine: Wasm 44.9 / 176.6 /
      352.1 MB at 131k / 524k / 1,048k slots. Node (quiet, CAD assembly, `cad/scale-node.mjs`): static tick 3.3 / 20.2
      / 41.5 ms, 1% moving 4.5 / 26.2 / 43.4 ms, full recompute 14.4 / 74.9 / 138 ms, full collection 8.3 / 33.8 /
      64.5 ms at 100k / 500k / 1M entities. Proofs: 1M-entity Node test bit-exact vs a fresh kernel
      (`tests/core-dirty-transforms.test.js`), `cad/pixels-check.mjs` (now grows mid-run) and `cad/cull-pixels.mjs
      --ref=b6a3796` 0 differing pixels. Wasm rebuilt reproducibly from lib.rs (SHA-256 9a7d9a44...). Selection's
      outline flags and XR instance storage follow the grown capacity. CAD browser runs at 10k / 50k / 90k (DIAGNOSTIC: the quiet gate never passed, other agents held the GPU;
      `cad/results-cap-{before1,after1,after2}-orbit.json`; the before2 round and the 200k/500k/1M runs were lost to the
      04:30 crash): kernel in frame 0.59 / 3.55 / 5.87 ms before vs 0.46-0.56 / 2.48-2.85 / 5.39-6.0 after, collection
      1.36 / 9.0 / 14.4 vs 1.0 / 5.7-6.6 / 13.6 ms, 90k orbit 14.9 FPS (GPU contended) vs 34.5-35.6; no regression seen,
      quiet re-run still owed.
      Still capped at 100,000 by their own input validation (package-side, not core): glTF/gltf-pro nodes, .margo nodes,
      OBJ parts, `SurfacePhysics` parts; `AssemblyBVH` 1,000,000 triangles per geometry is unrelated. `docs/limits.md`
      does not exist yet (5j): its entity row is "8,388,608 slots, 351 B each; ~40 ms CPU kernel floor at 1M even when
      static; escape hatch CulledMeshes/CulledInstances".
   Result (b): package-side alone cannot make core skip a batch (upload sits inside the draw loop, batches/counts are
      private, the only route is writing core's private indirect buffer). Hook: `PassContext.batches` + `Batch.redirect
      = {instances, args}` (+34 B). `CulledMeshes` in @margoengine/culling: GPU frustum (+ optional `minRadius`)
      culling and stable compaction of core batches; picking, FeatureEdges, ExplodedView, AssemblyBVH keep working
      (`cad/culled-meshes.mjs`: 0 differing pixels in 8 steps incl. explode, hide, growth; pick grid identical; BVH hits). Not done: Hi-Z occlusion for core meshes (CulledInstances has it;
      port its prepass), and an engine-level "CPU culling off" switch for `engine.start()` loops (today only
      `render({culling: false})`; about +15 B as `engine.culling`), which is what makes the kept set stable while
      orbiting.
5w. Khronos sample-asset rendering gaps (launch gate 5; found 2026-10-15 by `examples/khronos-gallery.html`, Edge +
   Arc 140V; per-model verdicts in `examples/assets/khronos/README.md`). Not fixed by the asset task. All in optional
   packages (zero core bytes). After each fix: re-run the gallery, update the model's `render` verdict in
   `manifest.json` (+ `node scripts/khronos-assets.mjs`) and `npm run visual:update -- --only=khronos-<Model>`.
   a. [DONE 2026-10-15, 5w worker] gltf-pro draws every glTF 2.0 topology (`pack.ts` `listIndices`): POINTS as a
      point list, LINES / LINE_LOOP / LINE_STRIP as line lists (index pairs), TRIANGLE_STRIP / TRIANGLE_FAN as triangle
      lists (spec winding). Points and lines go to `model.pointsAndLines` (not `primitives`, which picking, BVH, outlines,
      walk collisions and exporters read as triangles), draw in the beauty pass only (no shadows/SSAO/SSR/OIT), unlit
      without NORMAL (base colour; emission not added, the shader is unchanged); `PreparedGeometry.topology` carries the
      mode through the worker path; progressive loads leave points/lines out (ponytail comment). Also fixed on the way:
      without NORMAL a vertex no triangle shades (unreferenced, as in MeshPrimitiveModes' shared POSITION) threw "Zero
      glTF normal"; it now gets +Z (a zero normal the file supplies still throws). Triangle pipelines and their keys are
      unchanged (GPU-call proofs gltf-pro-lighting-hooks 4,556 calls, binding-limit, oit-detached, materials-uv-transform,
      post-ssr-models, selection-xray-off, clustered-* all identical; gltf-pro.proof.js agrees). Test:
      `packages/gltf-pro/tests/khronos.test.js` (indices per mode vs the spec formulas, unlit, worker parity).
   b. [DONE 2026-10-15] MeshoptCubeTest also needed vertex codec v1 (11 of its views; header 0xa1), not only `COLOR`.
      `packages/decoders/src/meshopt.ts`: v1 (per-byte control modes, 1/2/4/8-bit groups, byte / 16-bit / rotated-XOR
      channels, ported from meshoptimizer 1.1.1's reference decoder) and `COLOR` (YCoCg + alpha precision bit, the SIMD
      decoder's float32 arithmetic; it stores the low bits of the float32 pattern of value + 3<<22, which differs from a
      rounded integer only for out-of-range YCoCg). Bit-exact vs the installed meshoptimizer Wasm decoder: 1,030 fuzz
      streams (v0/v1, strides 4-64, NONE/COLOR) + 132 encoder-made COLOR streams (8/16-bit, 2-16 bits) + all 60
      compressed MeshoptCubeTest views, 0 differences. Vectors: `tests/fixtures/meshopt-vectors.json` + 4 cases
      (attributesV1, color4V1, color8, color8Raw) from `packages/decoders/scripts/meshopt-vectors.mjs`;
      `decoders.proof.js` keeps the 8 old cases baseline-identical.
   c. [DONE 2026-10-15] Already an option since 5l.r: images get 4x `maxDownloadBytes` (default 128 MiB -> 512 MiB) and
      the error names it (`glTF images exceed decoded size limit (536870912 bytes; raise the maxDownloadBytes option)`).
      ABeautifulGame's 33 2048x2048 textures are 553,648,128 B decoded (528 MiB), so it needs >= 132 MiB; the gallery
      passes 160 MiB. No new option (an image-only budget would be a second knob for one case). Documented: gltf-pro
      README "Download budget and memory", docs/limits.md row (which still said 64 MiB / 256 MiB; fixed with LIM-020).
   d. [DONE 2026-10-15] `applyGLTFLights(model, {clustered?, exposure = 1})` in gltf-pro (tree-shakable function): first
      directional light -> `engine.lighting` (direction toward the light from the node's +Z, colour, strength = lux x
      exposure; core's default strength is 3), point/spot -> `clustered.setLights` (candela x exposure) + `clustered.add`;
      returns the remover. `GLTFClusteredLight.color` is now `[number, number, number]`, so `clustered.setLights(
      model.clusteredLights())` type-checks (it did not: `number[]` vs `Vec3`). The gallery uses it with exposure
      3 / sun lux (NodePerformanceTest's sun is 10,000 lux).
   e. [DONE 2026-10-15, 5w-e worker] Written from the Khronos specs (no other engine's source). `KHR_materials_iridescence`
      (thin-film Fresnel of the spec's "Iridescence Fresnel": Schlick at both interfaces, phase shifts, two Fourier
      terms, XYZ to Rec. 709; rgb_mix), `KHR_materials_anisotropy` (Burley anisotropic GGX + the spec's height-correlated
      V, bent-normal IBL) and `KHR_materials_diffuse_transmission` (Lambert BTDF from the back, directional + IBL) are an
      opt-in entry `@margoengine/gltf-pro/extended` passed as `decoders.materials` (like `/instancing`); without it they
      are ignored and a file requiring one is rejected naming the decoder. Extended materials (a factor > 0) compile a
      per-feature, per-texture-plan variant of the physical shader (1,088-byte uniform): only the extension maps they use
      are bound, one binding per distinct glTF texture, at most 8 (`extendedTextureLimit`), so the worst case with
      shadows + IBL + LocalShadows is exactly 16 sampled textures (test composes it; real GPU builds it). IBL/probe
      ambient hooks are evaluated through `margoAmbientTerm` on modified surfaces (shared `pbr-hooks.js`: layered when the
      shader defines `margoAmbientLayers`); clustered lights stay isotropic, front-side only (README limits).
      `KHR_materials_variants`: `model.variants` + `model.selectVariant(name | index | undefined)` (root, rebinds only the
      changed primitives; gallery `&variant=`). CPU reference `tests/support/khr-brdf.js` + `packages/gltf-pro/tests/
      materials-ext.test.js` (10 tests); real GPU `scripts/gltf-pro-materials-gpu-check.js` (Arc 140V, Edge 155, GPU lock):
      20 permutations (8 feature sets, worst-case plan, transmissive; bare and with shadows, clustered + LocalShadows,
      IBL) compile and build every entry point with 0 errors; WGSL vs CPU reference worst relative error 1.6e-5 thin film
      (64 cases), 1.4e-6 isotropic, 3.6e-7 anisotropic direct BRDF (96 cases); `results/gltf-pro-materials-gpu.json`.
      Bytes (min/gzip, entry-sizes.json method, vs 04f941b): gltf-pro root 54,562/18,979 -> 58,446/20,047 (+1,068:
      variants, the transmission fix, the hook plumbing), `/extended` 14,943/5,146 alone and +2,385 gzip on top of the
      root (one bundle 22,432), /worker +1,076, /progressive +1,101, workers/gltf.js +41, /asset +40, usdz worker +1,098
      (bundles the root), animation/vat +140 (pbr-hooks), geometry +41; core + stage unchanged (19,999).
   f. [DONE 2026-10-15, 5w-e worker] Two causes. (1) The tinted blend read its blend constant as 0 in Edge on the Arc 140V
      (D3D12) with 4x MSAA (scratch repro: dst x constant returned 0 for pipelines reused across command buffers, even
      with the constant set before setPipeline), so the glass drew only its own colour over a black background: every
      transmissive surface in the gallery hid what was behind (ToyCar's and FlightHelmet's "showed through" only by their
      reflections). gltf-pro now draws transmission twice without a constant: `margoTint` (blend zero, src; tint in the
      spare Frame lanes coordsB.zw, ext.z) multiplies the background, then the lit surface adds (one, one). (2) IBL and
      clustered hooks lit transmitted glass with the full base colour, so the fridge's white glass read as an opaque
      diffuser: `transmissiveShader(physical | factor-only)` evaluates those hooks on `margoFront(s)` (diffuse x (1 -
      transmission)), as the shader's own terms already did. The `@margoengine/materials/transmission` refraction path is
      unchanged (physical-gpu.mjs: side by side 0 difference, BRDF and refraction numbers identical to 38d448e).
      GPU-call proofs: `npm run proofs -- --current` 15/15 pass (gltf-pro-lighting-hooks 4,556, binding-limit,
      materials-uv-transform, selection-xray-off, ... identical); oit-detached now 2,864 calls (its BLEND + transmission
      material became a plain BLEND one, since transmission now draws twice by design; materials-ext.test.js covers it).
      Visual: `visual:check --no-build` 47/55 pass, the 8 failures exactly the intended khronos views (ABeautifulGame,
      AnisotropyBarnLamp, CommercialRefrigerator, DiffuseTransmissionTeacup, FlightHelmet, IridescenceLamp,
      LightsPunctualLamp, ToyCar), re-baselined with `visual:update` (noise 0). Verdicts in examples/assets/khronos.
   g. [DONE 2026-10-15] `viewGLTFCamera(model, index | GLTFCamera = 0)`: position/direction/up from the node, perspective
      yfov/znear/zfar (canvas aspect) or orthographic ymag/znear/zfar through `camera.project` (reversed depth like core;
      removed again by a later perspective camera). The gallery views through a file's first camera when it has one
      (Cameras, DirectionalLight, NodePerformanceTest, ToyCar).
   h. [RE-CHECKED 2026-10-15, gallery `capacity` dropped] NodePerformanceTest loads at the default capacity (the store
      grows; `khronos.test.js` asserts 10,002 nodes on a default store). Browser, DIAGNOSTIC (Edge, Arc 140V, other agents
      running, not quiet-gated): load 4.0-4.6 s, first presented frame 5.4-5.9 s after the load started (4 runs); the
      20 s capture did not reproduce. CPU profile of that page (`?model=NodePerformanceTest`, 200 us sampling): 2.8 s in
      setup's `upload` (createBuffer + writeBuffer for 20,000 vertex/index buffers: the file has 10,000 distinct meshes),
      0.6 s rest of setup (10,000 uniform buffers, 50,000 samplers/views), 1.06 s first `draw` (10,000 uniform writes +
      bind groups). NOT fixed: the remedy is sub-allocating small primitives into shared vertex/index buffers, which
      changes the `PBRPrimitive.buffers` contract selection/picking draw from (no offsets) and the GPU-call proofs, so it
      needs its own item; per-descriptor sampler caching is the cheap first step (not measured).
      5w a-d/g/h + 5j(1) bytes (minified / gzip of each entry with everything it imports, vs 303fecf; core + stage
      unchanged): gltf-pro root 60,850 / 19,087 -> 64,345 / 20,260 (+1,173 gzip; applyGLTFLights and viewGLTFCamera are
      separate tree-shakable exports), /asset +103, /prepare +377, /progressive +561, /worker +576, workers/gltf.js +401,
      workers/progressive.js +375, /instancing 0; decoders root 5,036 -> 5,917 (+881, meshopt v1 + COLOR); gltf +133;
      blender +158; machinery root +184, /cad +141, /surface +179, cad worker +165. Visual: `visual:update` for the 7
      khronos views whose image changed (MeshPrimitiveModes, MeshoptCubeTest, ABeautifulGame new; Cameras,
      DirectionalLight, NodePerformanceTest, ToyCar now through the file's camera/light), then `visual:check
      --only=khronos` 32/32 pass, run-to-run noise 0.
   i. Gallery coverage, not engine bugs: animations are not played (InterpolationTest, MorphStressTest, RiggedFigure,
      Fox: rest pose only; pose them at a fixed time with `@margoengine/animation` for a still frame); the studio
      environment is a flat procedural grey, so metals look flatter than the HDR references (a CC0 HDR needs Scott's
      approval); views are fitted from a fixed front-right direction.
6. Then give Scott the full list of what was done and what remains.
8. FINAL TO-DO (Scott, 2026-10-15): thorough docs and as many tutorials as possible - "documentation is the product".
   Structure the docs site by Diataxis (keep the four kinds separate): Tutorials (learning), How-to cookbook
   (problems), Explanation (how it works), Reference (API).
   a. Launch-day set (required for 1.0):
      - "Time to triangle" quickstart: lit, rotating object on screen in under 5 minutes, two paths: `npm create
        margo@latest` (exists, tools/create-margo) and a single zero-config HTML file; plus a side-by-side of the raw
        WebGPU boilerplate it replaces.
      - Three.js migration ("Rosetta stone"): docs/from-threejs.md exists - polish into a flagship page (Scene,
        materials, render loop/useFrame, controls, loaders; three.js vs Margo side by side).
      - Flagship tutorial: CAD viewer - large assembly with progressive + worker loading, instancing, section planes,
        edges, picking, ViewCube, navigation profiles, floating origin, offline cache.
      - Flagship tutorial: indie game - grow docs/guides/blender-game.md into a runnable step-by-step (player, Blender
        level via extras, physics jump/gravity, third-person camera, audio), with a matching runnable example.
      - Cookbook (how-to) starter set: resize/DPR, device loss, colliders from a glTF hierarchy, switching controls,
        strict CSP deploy (docs/deploying.md), quality tiers, transparency (OIT), large coordinates, STEP pre-conversion,
        mobile-first architectural walkthrough in ~50 lines (5l.u) [DRAFT: docs/guides/walkthrough.md, snippet
        type-checked; uses a placeholder `/assets/house.glb` until 5l.u picks the house].
      - API reference auto-generated from TSDoc (depends on the hygiene gate 5k item 6), published on the site.
   b. Live-editable examples: an "Edit" button on every docs example (StackBlitz/CodeSandbox once packages are on
      npm, or our own playground that loads the local build), so readers change numbers and see the canvas update.
   c. More tutorials after launch: stylized/retro rendering (voxel/tile art, nearest sampling, palettes, post),
      spatial audio + particles + volumetric fog, and one per major package; short videos once Margo Studio exists.
   Rules: every code block type-checked (tests/from-threejs-snippets.test.js already covers docs/guides/*.md) and
   every tutorial runnable from the repo; numbers only with linked proofs (claims.md); docs pages captured in
   visual:check where they embed a live canvas.
9. LATER (Scott, 2026-10-15, "maybe next week; finish the engine first"): Steam games built on Margo to make money.
   Not started (research agent stopped on Scott's call). When resumed: (1) cited market research - which genres/tags
   sell for 1-2 person teams (median vs top revenue, wishlist->sales, Next Fest, demos), (2) genre ranking by demand x
   Margo fit x scope (factory/automation, stylized roguelike, atmospheric exploration, logistics puzzle are candidates
   to test, not conclusions), (3) packaging reality check - Electron vs Tauri vs native Dawn/wgpu: verify WebGPU per
   platform incl. Steam Deck/Linux (Tauri uses the system WebView: WebKitGTK on Linux), Steamworks bindings, (4) web
   demo -> wishlist funnel evidence, (5) business basics (fees, revenue share, taxes - accountant), (6) phased plan
   after 1.0 with kill/continue criteria, (7) honest odds. Plan doc goes to Scott's Google Drive folder
   "Margo Engine - To Do". Graphics settings for games: frame cap 30/60/120 via `capFrameRate`/`engine.pace`
   (exists); browsers are always vsynced; "VSync off"/uncapped only in the desktop wrapper (Electron
   `--disable-frame-rate-limit`), check tearing support per wrapper during the research.
7. POST-LAUNCH (Scott, 2026-10-15): "Margo Studio" - feature-for-feature equivalents of MagicaVoxel, Crocotile 3D
   and Dust3D, built on and for Margo with new, modern code (no copied code or branding; their file formats are
   supported for import/export). Plan, ground rules and draft feature inventories: `docs/margo-studio.md`. Each tool
   starts with a feature audit against the current release and Scott's scope sign-off. Not before 1.0.

Worker practice: agents run in git worktrees; they must start with `git reset --hard perf/auto-quality` (worktrees
default to an old base). Do not junction the whole node_modules (then `@margoengine/*` resolves to the main checkout's
packages): make a real `node_modules` folder holding junctions to the main checkout's third-party packages and
`@margoengine/*` junctions to the worktree's own packages. Never run a full `npm install` in a worktree; lockfile only
via `npm install --package-lock-only --offline --no-audit --no-fund --ignore-scripts`. Also junction `margoengine`
to the worktree's packages/margoengine. `npm run build:packages` is the whole package build (dependency order from
package.json, then size gates, then docs/catalog.json); there is no separate workspace build step. Commit-message
or other temp files in the shared scratchpad must have unique names (two workers' `msg.txt` collided once).
NO synthetic all-core CPU/GPU burn loads: the 2026-10-15 04:21 crash (kernel bugcheck 0x7E, driver access
violation) happened while an agent ran a 128-thread CPU burn to reproduce flaky tests. Load tests use at most half the
logical cores, run for minutes not hours, and stop if the laptop is on battery or thermals spike.
Use `node scripts/gpu-lock.mjs run --owner=<agent id> -- <command>` (or `acquire()` from it) for every GPU run: it
writes owner.json, waits, holds the lock only while the command runs, never removes someone else's lock, and takes
over a lock whose process is dead. Wrapping a script that takes the lock itself (visual:check, the benchmark
runners) is safe since 2026-10-15: `run` passes `MARGO_GPU_LOCK_NESTED` and those scripts lock that folder instead of
waiting on their own parent (a wrapped visual:check deadlocked for an hour before that). New self-locking scripts
must start with `const lock = process.env.MARGO_GPU_LOCK_NESTED ?? ...` or use `acquire()`.
Any change to WGSL (packages/*/src shaders, packages/shared/*.js shader strings) is not done until `npm run build:site`
and `npm run visual:check -- --no-build` pass: Node has no WGSL compiler, and GPU-call proofs compare shader TEXT, not
validity (eaddd64 shipped an AgX shader with an extra `(` that every Node test and proof passed; it broke five demos
until 4bdfe9e). The merger runs the same check after merging shader changes, before pushing. Never `rmdir` the lock by hand (an agent once deleted another's lock and two GPU
runs overlapped). Hold `test-results/gpu.lock` ONLY while a GPU run is executing; release it between runs (code edits, analysis) so
queued agents can interleave (one agent once held it 40+ minutes and blocked three others).
Before ANY timing run (benchmarks, A/B GPU timings) run `node scripts/quiet-gate.mjs` (or import `waitForQuiet`): it
requires AC power, waits until total CPU stays <= 20% for 20 s, and returns the machine state to store in the results
JSON. Correctness checks (pixel diffs, proofs) don't need it. Publication numbers also need every other agent stopped
(Scott keeps the laptop idle for those windows). A change
to any package's public API (anything in its dist/*.d.ts reachable from an `exports` entry) fails `npm run api:check`:
if intended, run `npm run api:update` after build:packages and commit the `api/` and `docs/api-surface.md` diff.
Visual regression (GPU, so not in `verify`): after `npm run build:packages`, `npm run visual:check` builds the site,
captures every demo view and compares it with `tests/visual/*.png` (report, actual and diff images in
`test-results/visual/index.html`; 1-2.5 min with the site build). It refuses on battery, discards a run that loses AC, and takes the GPU lock
itself (polls every 60 s); do not pipe it through `Select-Object -First`/`head` (killing it mid-run leaves a stale
`gpu.lock` behind). A failing view whose change is intended: `npm run visual:update -- --only=<view>` (4 runs per view,
re-measures the noise floor) and commit the PNG + `tests/visual/manifest.json`, saying why in the commit message.
Baselines are for the Arc 140V + Edge build recorded in the manifest; another GPU or a browser update needs a full
`visual:update` first (the check prints a warning when they differ).

## Scott's decisions (2026-10-14, 17:10)

- Core: APPROVED speed-up steps 1, 2, 3 and 5 from the prototype branch (`worktree-agent-a46261c57b837ecd0`), not
  step 4 (pick pipeline); the core CADCameraControls pole fix (heading from `camera.up` when leaving an exact pole);
  the +8 B `engine.pick` OffscreenCanvas fix (`clientWidth || width`). Target: core+stage under 19,600 B.
  DONE: all three merged (core+stage 19,543 B; numbers in 1e').
- Core back-face culling (pipeline `cullMode` instead of the shader's `discard`): MEASURE ONLY on a scratch branch,
  do not merge; bring the numbers and bytes back to Scott. MEASURED, AWAITING SCOTT: branch
  `scratch/core-backface-cull` (per cull-group pipelines with a shader override; +315 B -> 19,858, over the 19,600
  target). GPU per frame: 50k CAD 15.6 -> 13.7 ms (double-sided, the default) and 14.2 -> 12.4 ms (single-sided);
  one full-screen layer 1.31 -> 0.79 / 0.79 -> 0.39 ms; 16 full-screen layers back to front 11.9 -> 4.7 ms.
  Details and caveats in docs/cad-performance.md.
- API: standardize on `X.attach(engine, options)` for features; `dispose()` is the primary cleanup name, `destroy()`
  stays as a deprecated alias until 1.0, and packages (not core) add `[Symbol.dispose]()` calling `dispose()`.
  [DONE, packages only; core and the stage facade untouched] Every engine feature has `static attach(engine,
  ...constructorArgs)` (`engine.use(new X(...))` in one call; constructors and `engine.use` still work). Async
  features return a Promise: `Environment.attach(engine, source, options)` (create + use; `create` stays for a bare
  GPUDevice), `Planet.attach`, `XR.attach`, `SurfacePhysics.attach`, `TelemetryChannel.attach`. Controls have one
  generic `Controls.attach(engine, ...args)` typed from each subclass constructor (`OrbitControls.attach(engine)`; the
  constructor stays for a bare Camera); DragControls, TransformControls, ViewCube, Physics (`new Physics(null, ...)`
  stays for headless) and GrassField (`attach(engine, options)`) have attach too. GPUParticles and SkyMoon override
  the attach they inherited from VFX/Sky, which built a plain VFX/Sky. `destroy()` is a JSDoc-`@deprecated` alias of
  `dispose()` everywhere (text GlyphAtlas had only destroy; Animation and PBRModel destroy no longer call
  removePlugin again). Every disposable package class has `[Symbol.dispose]()` (base classes carry it for
  subclasses), written `declare [Symbol.dispose]: () => void; [(Symbol.dispose ?? Symbol()) as symbol]() {this.dispose();}`
  so Safari (no Symbol.dispose) gets an unreachable key instead of a method named "undefined"; each such file starts
  with `/// <reference lib="esnext.disposable" preserve="true" />`, kept in the d.ts so consumers on an ES2022 lib
  still type-check. `ibl.add(model)` / `fog.add(model)` replace `applyTo` (deprecated alias). `tests/api-conventions.test.js`
  walks every package's exported classes and fails on drift. Bytes (root entry min+gzip): most packages +15..+65 B,
  controls +98, environment +124 (five attach methods, async attach, applyTo alias). Package benchmarks and proofs
  (`examples/package-benchmarks`) keep the old forms on purpose: they also run against older refs.

Second set (2026-10-14, evening), all APPROVED by Scott:
- 1g.e/1h.d: reformat all TypeScript to conventional style with Biome (formatter + small lint rule set) once the core
  and API-standardization agents have merged (zero shipped bytes; for contributors).
- WebGL stays strictly a fallback (plain meshes, basic preview). Do not expand WebGL parity (gap 8 closed as won't-do).
- Core, measured, each stopped if over budget: transparent canvas (`alpha`/premultiplied canvas + clear alpha;
  budget ~15 B) and minimal live setters on core `PbrMaterial` (color/roughness/metalness without recreating the
  material; budget ~30 B; if it needs dirty-state tracking, leave it to leaf packages). Start after the current core
  agent merges.
  DONE (setters, +34 B -> 19,577, 4 B over the ~30 B budget; a +31 B variant parsed the default hex colour on every
  construction, which `deep-core-box`'s one-map guard rejects): `PbrMaterial.set({color, roughness, metalness,
  doubleSided})` writes `material.data` in place after validating (omitted values keep theirs; a rejected call changes
  nothing); the constructor is `set({...options, color: options.color ?? '#4f46e5'})`. No dirty tracking was needed: the engine already compares every drawn material's
  values each frame, so a change re-collects instances and uploads each drawn batch's range once (static frames after
  that upload nothing). Ceiling: recolouring one part re-uploads all instances that frame; per-part dirty ranges would
  need material->mesh tracking (leaf packages). No `opacity` (core requires alpha 1). Test:
  `tests/core-material-setters.test.js` (fake GPU: one upload with the new colour, no pipeline/bind-group creation).
  Real GPU (Arc 140V, Edge 155, AC before/after, GPU lock; `examples/package-benchmarks/material-setters-gpu.mjs`): red box
  [170,20,20] -> `set({color: blue})` -> next frame [20,20,170], zero pipelines and bind groups created, no GPU errors.
  Transparent canvas in core measured +39 B (`transparent: true`) / +40 B (`clearColor`) vs the ~15 B budget; Scott
  chose the zero-core plugin. The core version stays on `scratch/core-transparent-canvas` (unmerged, for reference).
  DONE (0 core bytes, core+stage stays 19,577): `TransparentCanvas.attach(engine)` in `@margoengine/environment`
  (`color.ts`, a `ColorBackground` subclass): reconfigures core's canvas context (same device, preferred format) with
  `alphaMode: 'premultiplied'`, writes premultiplied alpha 0 over cleared depth (`ColorBackground` now writes
  colour x alpha, alpha; opaque output unchanged), reapplies in `onDeviceRestored` (core reconfigures opaque on
  restore first), `dispose()` restores opaque and detaches. No core hook was needed. WebGL2: the plugin is a no-op;
  `webglRenderer(canvas, {transparent: true})` (new option) gives a premultiplied `alpha: true` canvas, passed by the
  app's `fallback` closure because core passes nothing to the fallback. Post alpha fixes (FXAA alpha filtered with
  colour, Bloom alpha = max(scene alpha, glow), SSAO composite keeps scene alpha); Tonemap/SSAO leave a faint
  silhouette rim, DOF/TAA/SceneFade stay opaque-canvas only (post README). Tests:
  `packages/environment/tests/transparent.test.js`, webgl test, api-conventions.
  Real GPU (Arc 140V, Edge 155, AC before/after, GPU lock; `examples/package-benchmarks/transparent-canvas-gpu.mjs`):
  magenta page shows in empty pixels for core, after `rebootDevice()`, Tonemap, FXAA, Bloom, SSAO, a PostStack and the
  transparent WebGL renderer; black/white-backdrop alpha recovery finds 0 invalid premultiplied pixels for core,
  restore, WebGL, FXAA, Bloom and the stack (Tonemap 183 rim pixels, worst +44/255; SSAO 147, +33/255); after
  `dispose()` the canvas is opaque again; opaque FXAA/Bloom/SSAO/stack frames byte-identical to the pre-fix post build.
- Result (Scott, 2026-10-14 late): material setters TAKEN at +34 B (core+stage 19,577); transparent canvas as a
  ZERO-core-byte optional plugin, not core (the +39 B core version stays unmerged on `scratch/core-transparent-canvas`).
- Multiple directional lights stay OUT of core (belongs in `@margoengine/clustered`).
- Back-face culling REVISED (Scott, 2026-10-14 night): APPROVED option B in core, +212 B (core+stage ~19,789; the
  19,600 working target moves to ~19,800): a second, back-culled pipeline per geometry batch, used only when every
  instance in the batch is single-sided and unmirrored; pixel-identical; `scratch/bvt-core-cull-bytes` (b3514f3).
  Evidence: docs/whitepaper/boxes-vs-threejs.md (the shader `discard` disables early depth; 40-56% of single-sided
  GPU time).
  DONE (`d96e2d7`, core+stage **19,793 B**, +216 on 19,577): ported onto the setters tip unchanged in substance.
  `Batch.mask` (public, api/ updated) is OR-ed during collection and on the moved-matrix fast path; material value
  changes (incl. `set({doubleSided})`) and material assignment already force a full re-collection, which recomputes
  it. Un-mirroring a moved mesh leaves its batch on the cull-none pipeline until the next full re-collection
  (conservative, same pixels). Package shader variants, draws with extra bindings, `CulledInstances` and gltf-pro keep
  their own pipelines. Proof (Arc 140V, Edge 155, AC, GPU lock): `examples/package-benchmarks/cad/cull-pixels.mjs`
  (builds core from `dc0c4ff` into test-results/core-ref and renders a mixed scene in both through 13 edits: 0 of
  153,600 pixels differ at every step), `cad/pixels-check.mjs` passes, `npm run visual:check` 22/22. GPU win (diagnostic,
  busy, same run; `margo+nocull` = the old GPU work): single-sided boxes 1k/10k/50k 1.64/5.00/10.87 -> 0.46/1.80/6.00
  ms; CAD 10k single-sided 4.04 -> 2.15, 50k no gain. Harness (`vs-threejs`) now pairs mesh <-> mesh and instanced <->
  instanced (`margo-instanced` = materials `createInstancedMesh`, `margo-culled` = culling `CulledInstances`); tables in
  the whitepaper, rows in claims.md (still no publishable claim). Follow-ups for packages (not done): `CulledInstances`
  could use the same back-culled discard-free pipeline for single-sided batches and needs a bulk transform upload
  (10k moving parts: 187 ms CPU per frame through `setTransform`).
  Earlier note kept for history:
- Back-face culling: SKIPPED for core (Scott agreed, 2026-10-14). Measured on `scratch/core-backface-cull`
  (+315 B -> 19,858; 50k CAD 15.6 -> 13.7 ms GPU, noisy; 16 full-screen layers 11.9 -> 4.7 ms). CAD files often have
  open shells, mirrored parts and section cuts; pipeline-level culling stays a leaf-package option for closed solids.
- Island light tier keeps 100k particles by default; add a `?particles=1m` URL switch (the menu already has 1M).
  Start after the visual-regression agent merges (it edits the sandbox).

## API rough edges before 1.0 (found writing docs/from-threejs.md, 2026-10-14; 2, 3 and 4 done since)

1. The one directional light and the ambient term are only reachable through `@margoengine/core/extension`
   (`engineRuntime(engine).lighting.direction` = [x, y, z toward the light, intensity], `.radiance` = [r, g, b, ambient]);
   the public `EngineKernel` type has no lighting, and the packing is not in core's README. Same for `engine.gpu`:
   gltf-pro's README passes `stage.engine.gpu` to `KTX2Decoder`, which does not type-check against the public type.
2. [DONE: `X.attach(engine, ...)` everywhere, see Scott's decisions above] Four ways to add a feature: `X.attach(engine, options)` (Shadows, Clustered, Selection, Picking, SSAO, Bloom, FXAA,
   PostStack, Tonemap, TAA, Sky, Stats, ComputePass), `engine.use(new X(options))` (Environment, EnvironmentLighting,
   Fog, ColorBackground, Lines, PointsPlugin, TextRenderer, LabelRenderer, LODSystem, CameraProjection, VATCrowd),
   constructors with side effects (`new OrbitControls(engine)`, `new ViewCube(engine)`) and free functions
   (`createMesh(engine, ...)`, `loadGLTF(engine, ...)`). Pick one primary form.
3. [DONE: `add(model)` everywhere, `applyTo` is a deprecated alias] Including a gltf-pro model in a feature uses different verbs: `shadows.add(model)`, `lights.add(model)`,
   `ssao.add(model)`, but `ibl.applyTo(model)` and `fog.applyTo(model)`. Core meshes need none of them, so a three.js
   user's loaded model silently misses shadows/IBL/fog until each is called.
4. [DONE for dispose/destroy: `dispose()` primary, `destroy()` deprecated alias, READMEs use dispose; option edits
   NOT changed] `dispose()` and `destroy()` both exist (PBRModel, Animation, Tonemap, SSAO have both; READMEs use either). Option
   edits differ too: `tonemap.options.exposure`, `sky.options.hours`, but `fog.far` and `glass.opacity` directly.
5. [FIXED: `material.set({...})`, see Second set] Core `PbrMaterial` has no setters: recolouring means a new material and `setMaterial`, or writing the undocumented
   `material.data` array (math's README does). `@margoengine/materials` `Material` is live. Core meshes move with
   `mesh.position.set(...)`, materials meshes with `mesh.root.setPosition([...])`.
6. [FIXED outside core] `model.bounds` is a flat `[minX, minY, minZ, maxX, maxY, maxZ]` but `camera.fitToBoundingBox(min, max)` takes two
   tuples, so every fit slices by hand. `@margoengine/cameras` `projection.fit(model.bounds)` and staging
   `contact.fit(model.bounds)` take the flat array; core's own signature is unchanged (frozen).
7. Two packages export `loadGLTF` with different results (`@margoengine/gltf` Model with `dispose()`, gltf-pro PBRModel
   with `destroy()`).
8. Animation: `loop` and `speed` are attach-time options (`Animation.attach(model, {loop, speed})`), there is no `stop()`
   (set `playing = false`), and one clip at a time without animator.
9. [ALL DONE: every stale-doc item below fixed in 2c53227 and the README follow-up commit.] Stale docs: root README line 3, `packages/margoengine/README.md` and MODERN-ENGINE.md say core falls back to WebGL2;
   it now needs `fallback: webglRenderer` from `@margoengine/webgl` (`backend: 'auto'` alone rejects without WebGPU).
   `packages/controls/README.md` "How it works"/Limits still say the camera has no up vector and rejects vertical views.
   `packages/animation/README.md` names `margoengine-animator`. `packages/gltf-pro/README.md` says ambient has no IBL.
   [DONE] `docs/threejs-parity.md` re-tallied (see "Feature gaps versus three.js"). Still stale, found in the re-audit:
   `packages/viewcube/README.md` Limits says "no roll (core's camera has none)" (core has `camera.up`);
   `packages/cameras/README.md` says core throws `Vertical camera` looking straight down (only with the default up);
   `packages/gltf-pro/README.md` Limits says models are "outside core GPU picking" (selection `Picking` covers them).
10. [GROUP A PART DONE (5k phase 2): shader `Node<any>` typed, Vec3/ColorInput/parseColor/meshWorldMatrix/Ray/HeightField
    homes in math, group A copies removed; the B/C/D copies are listed in 5k. Still open: core root vs extension
    same-name types (frozen), unexported-but-used types, `SkyMoonConfig`/`SdfParams` naming.] From the API snapshots (`api/*.api.md`, `docs/api-surface.md`; 1,263 exports in 129 entries): 92 `any` in public
    signatures (shader `Node<any>` 47, physics raw Rapier 25, controls 11, gltf-pro `GLTFDocument` 7); core root
    `Engine`/`Mesh`/`EnginePlugin` are different types from `core/extension`'s same names, and root exports both
    `Engine` and `EngineKernel`; 305 types used by exports but not exported (e.g. `Renderer` for `EngineOptions.fallback`,
    `SkyBase`/`VFXBase`); `Vec3` declared in 8 packages (mutable in bvh/geometry/lod, readonly elsewhere) and other
    duplicates (`parseColor` [one implementation since queue item 5: lines/points/text alias math's], `smoothstep`, `Ray`, `HeightField`, `TextureSource`, `RaycastOptions`, two
    `loadGLTF`/`parseUSDZ`); thin re-export packages (gizmo, html, usdz-export, toon); 48 `attach` vs 14 `create`;
    `SkyMoonConfig`/`SdfParams` break the `*Options` rule. Fixed: post and quality .d.ts pointed into ../../shared
    (broken after npm install); `tests/dts-self-contained.test.js` now guards every package.

## Pre-launch hardware investigation

SHELVED by Scott (2026-10-14): he has no way to test on an S23, so do not start S23/storeOp work unless he asks.

- Galaxy S23 (Adreno) 3-5 FPS on the island: audit every render pass's load/store ops; attachments that are not read
  later should use `storeOp: 'discard'` (on tile-based mobile GPUs a needless store flushes tile memory every frame).
  This is a lead to test, not a confirmed cause: particles Off did not help there and other demos run fine on that
  phone. Needs a capture from the device to confirm.

## Final phase (Scott, 2026-10-14): after every queue item above is finished

Whitepaper numbers (Scott, 2026-10-14): every published timing must come from a QUIET PC — no other agents building,
nothing else heavy running (he runs ChatGPT/Codex work on the same laptop), on AC power, under the GPU lock. Ask Scott
to confirm the machine is quiet before the final benchmark run; numbers taken while workers run are smoke tests only.

1. Rebuild every demo on the current packages and bring each up to date with the new capabilities: quality tiers
   and pacing, materials and textures, shader nodes, post stack + FXAA, environment IBL/fog/backgrounds, cameras
   (orthographic, ViewCube), picking/outlines/DragControls, LOD/imposters, glTF extensions, native FBX/USD, lights,
   CAD sections/edges/exploded views. Add new demos where a capability has none (e.g. a CAD assembly viewer).
   Run `npm run visual:check` before and after rebuilding each demo: before, to start from a clean pass; after, every
   failing view of that demo must be an intended change (look at the diff in `test-results/visual/index.html`), then
   `npm run visual:update -- --only=<demo>` and commit the new baselines with the rebuild. Any other demo failing means
   a shared package changed it. Keep the capture contract in rebuilt demos (see 1h.f): a still frame under
   prefers-reduced-motion, a readiness signal, `?quality=high|low`; a new demo gets an entry in
   `scripts/visual-regression.js` and a `visual:update -- --only=<id>`.
2. Whitepaper (`docs/whitepaper.md`, also published on the site) proving every public claim with reproducible tests
   and benchmarks: size (`npm run measure:threejs`), load/startup times, frame times per device tier, CAD scale
   (10k/50k/100k parts), picking latency, LOD/imposter savings, package proofs, fair three.js benchmark (WebGL and
   WebGPU), visual-regression results, and stated limits (devices not tested, WebGPU-first). Each number names the
   command, hardware, browser and date that produced it; all runs serial on an idle GPU.
3. Everything people need to evaluate it: getting-started docs, docs/from-threejs.md, API reference, comparison page,
   benchmark page, changelog, licence and third-party notices.
   - [DONE] `docs/guides/blender-game.md`: a small third-person game from Blender exports (glTF export settings, custom
     properties as level data, gltf-pro + `/worker` + decoders, animation + animator, input, Rapier physics, bvh
     picking/ground snapping, navigation, ecs, audio, sky/water/shadows/post, quality, deploying, "What you build
     yourself", measured numbers each linked to its result file). Linked from README and docs/README.md; its ```ts
     snippets are type-checked by `tests/from-threejs-snippets.test.js` (now every `docs/guides/*.md` too). New API for
     it: gltf-pro `model.extras()` -> `{node, nodeIndex, name, extras, matrix}` for every node with an object `extras`
     (world matrix copied after a transform tick; +79 B gzip root; `packages/gltf-pro/tests/extras.test.js` builds a
     Blender-shaped GLB). Update the guide when progressive loading, volumetric fog and the asset cache (5g.c, 5g.b, 5h.a)
     merge: it says "coming" for each (deploying links docs/deploying.md). Gaps it found, not yet queued: water refraction
     needs standalone Bloom's `sceneTexture` (PostStack has none, and standalone Bloom + SSAO refuse each other); SSR does
     not reflect in glTF surfaces (5l.l); core `Mesh` has no public world matrix (packages read
     `engineRuntime(engine).store.matrices`; the guide uses `node.matrix` after `engine.render`). The water/PostStack,
     child-body, world-triangles, camera-wall and listener gaps were queued as 5l.q and are done there.
4. Deploy the rebuilt site and demos to Cloudflare Pages (project `margoengine`): preview branch first, Scott checks
   it, then production (margoengine.com). Scott asked for the production push; still show him the preview link first.

## Launch readiness (Hacker News, YouTube, LinkedIn, X; npm is set up, margoengine.com is live)

### LAUNCH GATES (Scott, 2026-10-15): every box checked before the engine goes live. No exceptions.

1. **Benchmarks reproducible, not boastful.** Every speed statement names hardware, browser, scene, commit and the
   one command to reproduce it (`BENCH_QUIET=1 npm run bench:all -- --gpu`, vs-three.js harness pairs mesh<->mesh and
   instanced<->instanced, three.js given its best-practice settings); taken on a quiet PC; results committed; places
   where three.js wins are stated. No "Nx faster" headline without that. Never invent hardware or numbers (e.g. no
   "RTX A6000" unless one was actually used).
   Status 2026-10-15 (proofs): every `examples/package-benchmarks/proofs/*.proof.js` is pinned: by default it compares
   its baseline ref with the commit where its claim was made (`refs()` in compare.js; `node <proof> [ref] [pin]`), so
   later code cannot break it. `npm run proofs` runs all 46, two at a time, and prints a table (baseline -> candidate,
   result, seconds); it leaves `results/` alone. 45 pass, procedural-deps reports HISTORICAL (`fff47af`: its baseline
   imports simplex-noise/isosurface, removed from the lockfile in 5l.v; it runs again if both are installed). About
   8 min, so not in `verify`. The 15 ongoing guarantees ("feature off: identical GPU calls") also run against the
   working tree: `npm run proofs -- --current` (all pass, ~25 s, now the last step of `verify`; refs in claims.md
   "Proofs"). Found on the way: post-ssr's current mode differed only by the intended AgX re-derivation (eaddd64;
   `ignoreAgx(calls, ref)` now blanks agx() only for baselines before eaddd64); exporters/post/splats/probes-decals
   failed only because they compared old claims with today's tree (intended later changes: exporters' lazy png/animation
   chunks, SSAO's a281ad2/9702e57/e2cc4c5, splats' orthographic shader 5cf148e, later edits to the probes' sources);
   decoders' pinned run reads the fixtures of its pin (`fileAt`). One real bug: `loopSubdivide` threw a bare TypeError on an index past the vertices (since before the
   proofs; the 96edc75 rewrite only changed its message, which is what geometry.proof.js caught); it now throws a named
   RangeError (test in packages/geometry). Pinned runs still use today's @margoengine/core (frozen), proof scripts and
   fixtures, so mock-GPU timings recorded before the core speed-ups (0ed56b9) re-run faster; those READMEs date them.
   **Triage 2026-10-17 (main, after Codex's 84+3 commits; branch `claude/proof-triage`).** `npm run proofs -- --current`
   was 6 pass / 9 fail on 95b4eae6. 849ff51 (old perf/auto-quality tip) is NOT an ancestor of the main line before
   8f710eb3: its content entered main only through the consolidation commit 8f710eb3 (parents 24f8348b, 79c9f4f2; the
   octopus b4c3e4ba only records history). So "first failing commit" below is on main's first-parent chain
   8f710eb3..95b4eae6, found by running each proof pinned (`node <proof> <ref> <commit>`, no checkouts) and diffing the
   recorded calls (entries renumbered per handle kind, then line-diffed). Classes: A = intended change, B = regression.
   | Proof | First failing | Class | Evidence (first differing calls) | Action | Now |
   | --- | --- | --- | --- | --- | --- |
   | post-stack, post-ssr, post-ssr-models, quality-presets | 6a57389d (core ambient RGB hook, Scott-approved freeze exception) | A | SSAO ambient replay module: `return vec4f(i.color*(1.0-i.material.y)*frame.radiance.w,1)` -> `...*frame.radiance.w*frame.ambient.rgb,1)` (packages/post/src/ssao.ts:478); core Frame gained `ambient:vec4f` (default white, so pixel-identical) | --current ref -> 6a57389d; post-ssr/post-ssr-models' "baseline has no SSR / no ssr.add" checks now run only pinned | PASS |
   | deformed-shadows | 8f710eb3 (from 8efcf5b0), then 2091f12d | A | 8f710eb3: same multiset of calls, a mesh's `geometryBuffers` fetched before the depth pipeline exists (depth() first collects every source's primitives to de-duplicate shared PBR primitives). 2091f12d: still non-static casters cached in the static atlas (hash of matrix/buffers/alpha/hidden): distance500 335 -> 319 calls (24 fewer per-frame dynamic depth passes), customSource +4 static re-renders when the cube moves | --current ref -> 2091f12d; fitted-cascade check pinned-only | PASS |
   | selection-xray-off | 8f710eb3, 6a57389d, 95b4eae6 | A | 8f710eb3: mask-flag write words 7,8 = 1 (a selected mesh/model now flags its descendants; written in the consolidation for loader-owned PBR outlines; matches the documented "nodes select descendants"; side effect: children of a selected plain core mesh are now outlined too - Scott to confirm). 6a57389d: shared `meshVertex` Frame gains `ambient:vec4f`. 95b4eae6: model mask `culled()` adds the BackSide case (`i.info.y==2u&&facing`), a few ALU ops per mask fragment when unused | --current ref -> 95b4eae6; x-ray-on check pinned-only | PASS |
   | oit-detached, gltf-pro-lighting-hooks, materials-uv-transform | 8f710eb3 | **B** (plus A parts) | **B:** the consolidation's new "compact" gltf-pro path (plain materials: no extension, no physical, no texture transform) compiles opaque and BLEND non-instanced materials WITHOUT the 1e.f pipeline constants: their fragment shaders keep `if(!facing&&f.settings.z<0.5){discard;}` and the alpha-test discard as runtime branches, `constants` undefined (only MASK/instanced/non-compact get `override margoFaceTest/margoAlphaTest`). 1e.f (7f1c9c6) measured 0.852 -> 0.524 ms GPU on DamagedHelmet from removing exactly these discards (early-Z). Still on main: packages/gltf-pro/src/index.ts:1776 `const specialized = !compact \|\| !!inst \|\| m.settings[0] === 1;` and :1955 `constants: specialized ? {...} : undefined`. Fix (Codex, not done here: package code): always prefix the overrides for compact code and always pass `{margoFaceTest: face, margoAlphaTest: mask}`. **A parts at 8f710eb3:** compact Frame 880 -> 400 B (uvt/coat/specular/sheen rows only for materials that use them), 8 fewer 1x1 default textures/samplers, explicit `topology:'triangle-list'`, normal scale `v[82]=0` without a normal map, degenerate-tangent fallback; b326518e: derivative tangent-frame text (but see gate 5: that change is a rendering regression); da0eacc6: empty group-2 bind group created later (order only); materials-uv-transform also needed a harness fix (gltf-pro's lazy `import('./compression.js')`/decoders since d6c8feab made the bundle 3 chunks: `inlineDynamicImports`) | refs left unchanged (b803d56 / f8a36ca / 7f1c9c6) so the proofs keep failing until the discard fix lands; after the fix, re-pin --current to the fix commit (pinned da0eacc6 -> 95b4eae6 already passes all three, so nothing after da0eacc6 changes their calls) | FAIL (by design) |
   **Superseded on main while this ran:** d3629be1 ("restore current proofs", pushed during the triage) re-pinned every
   one of these 9 proofs' --current ref to `b3ed8ac` and fixed materials-uv-transform's bundling (`codeSplitting:
   false`). The rebase kept main's proof files and claims.md; the "Action" column above is what this triage did before
   the rebase (re-pins for the A rows; the B row left failing). With b3ed8ac as ref, oit-detached,
   gltf-pro-lighting-hooks and materials-uv-transform pass on main BUT their baseline now contains the 8f710eb3
   discard regression, so the "unchanged when unused" guarantee no longer covers 1e.f. After Codex fixes it, re-pin those
   three to the fix commit and check the stories' opaque/BLEND pipelines carry `margoFaceTest:0, margoAlphaTest:0`.
   Unchanged and passing: clustered-area-lights, clustered-local-shadows, color-output, environment-volumetric,
   lines-perspective, math-consolidation. With this triage's own refs `--current` was 12 pass, 3 fail (the B row); on
   main, with d3629be1's `b3ed8ac` refs, all 15 pass (rechecked at 80de63c). Pinned `npm run proofs` (all 46):
   NOT RUN in this pass (stopped on request); the edited proofs keep their pinned defaults, and materials-uv-transform
   pinned (1970fda -> 700838e) was re-checked after its harness fix: PASS. Run it next.
2. **First 60 seconds bulletproof.** `npm create margo@latest` and the quickstart HTML work on clean environments:
   Windows (this laptop), Linux (WSL or a container), macOS + Safari and iPhone Safari + Android Chrome (Scott's devices,
   or listed as untested). No black canvas ever: WebGPU missing, adapter/device request rejected, or shader errors
   show a clear on-page message with what to do (and the WebGL preview if the app opted in). Packed tarballs install
   and type-check with no missing peers (`scripts/modern-package-tests.js` passes).
3. **Device loss survives.** 5i.d end-to-end test passes on every demo (device destroyed mid-frame -> scene back,
   visual compare); plus a manual check on a Mac (unplug a monitor / switch GPU) if Scott can.
   Status 2026-10-15: automated part passes, 24/24 views (`npm run visual:device-loss`, 5i.d); Mac check open.
4. **Bundle transparency.** A sizes page (treemap or table) generated from `entry-sizes.json`: every package and entry
   (min+gzip), plus every lazily fetched file (workers, Rapier Wasm, OCCT Wasm, Draco/Basis decoders) and WHEN each
   loads. A test proves a basic glTF scene fetches only the expected files. Core+stage figure from
   `npm run measure:size`.
   [DONE 2026-10-15] Sizes page: `site/dist/sizes.html` (margoengine.com/sizes.html, linked from the landing
   page and the catalog) is generated by `scripts/build-sizes.js` during `npm run build:site`, which first re-measures
   `entry-sizes.json` (now also records `coreStage` raw/gzip/limit via `measureCoreStage`, the commit, and `dirty` when
   packages/ had uncommitted changes). Core + stage with the 20,000 B limit on top, then one accessible table per layer:
   every package and entry (bundled workers included), raw and min+gzip bytes, peers. No script; build-site leaves the
   page out when entry-sizes.json was measured at another commit (visual:check runs build-site directly).
   `tests/sizes-page.test.js` (in verify) checks every catalog package is listed with the numbers of that one measured
   commit. Finished the same day (gate 4b): (a) "Loaded later, and what loads it": every file a package fetches or
   compiles on its own after its entry, one row each with raw, gzip and brotli bytes and the exact call that loads it.
   The list is `scripts/lazy-files.js` (25 rows: the stage's 7 lazy packs, the CAD worker + OCCT glue + .wasm, the
   decoder worker + Draco and Basis glue + .wasm, the gltf-pro/fbx/usdz/loaders parser workers, the BVH module worker,
   Rapier, Recast, web-ifc.wasm and web-ifc-mt.wasm); `entry-sizes.mjs` measures them into `entry-sizes.json`
   `lazyFiles` (files the bundler copies as is: bytes on disk; chunks/module worker/Rapier/Recast: bundled and
   minified like the entries). Rapier (rapier3d-compat) and Recast (wasm-compat) inline their Wasm as base64, so they
   make no separate .wasm request; the page says so. `tests/sizes-page.test.js` scans packages/*/dist and fails when a
   built worker or .wasm is missing from the list (or a listed one was not built). (b) `scripts/basic-scene-network.mjs`
   (`npm run test:basic-scene`, in `test:release`; GPU, so run it under the lock): Vite production build of
   `tests/fixtures/basic-scene` (`createStage('#scene')` + `app.load('./model.glb')`, a 1,332 B cube), served by
   `vite preview`, opened in headless Edge 155 (Arc 140V), Playwright network log. It asserts the page fetched exactly
   the HTML, the entry chunk and its static imports, the @margoengine/gltf chunk and the model, each once, and nothing
   with wasm/occt/draco/basis/rapier/recast/ifc/worker/cad in its name, while the same build holds the 7,604,031 B
   OCCT .wasm, the CAD worker and the other packs (16 files, 7,952,535 B, never requested). Measured at 5a7bbc2: 6
   requests, 30,027 B transferred (preview gzips JS; body + headers), 62,702 B raw / 27,020 gzip / 23,774 brotli; the
   entry chunk (core + stage + app) 47,732 raw / 20,564 gzip, the glTF chunk 11,018 / 4,566. It records
   `results/basic-scene-network.json`; the sizes page shows that table and refuses (throws) a record from another
   commit, and build-site leaves the page out unless both records match HEAD. `npm run build:site` now runs
   catalog:build, entry-sizes, then this test under `gpu-lock run --owner=build-site`, then build-site. (c) README.md and
   docs/README.md list all 73 packages in the 10 catalog layers, generated by build-catalog.js
   (`scripts/package-lists.js`) between `<!-- package-list -->` markers; `tests/package-lists.test.js` fails on drift.
   Screenshots: `test-results/gate4/sizes-{top,basic-scene,loaded-later}-{375,1440}.png` (no page-level horizontal
   scroll at 375 px; wide tables scroll inside their regions).
5. **Real assets render correctly.** Khronos glTF sample assets in the visual-regression suite (FlightHelmet exists
   as the helmet demo; add Sponza and a broader set - Scott approves each download/licence), plus the conveyor GLB and the
   archviz house; all pass the glTF validator and render without visual bugs.
   Status 2026-10-15: FlightHelmet (CC0) downloaded to `examples/assets/khronos/` (Git LFS, validator 0/0); shortlist
   of CC0/CC-BY models for Scott's approval in `examples/assets/khronos/SHORTLIST.md`. Sponza excluded (Cryengine
   licence). Later 2026-10-15 (Scott approved the shortlist tiers): 32 models in `examples/assets/khronos/` (31 new,
   212 MB, Git LFS), every one plain CC0 / CC BY 4.0 per its `metadata.json`; 22 shortlisted models skipped because
   their metadata adds a `LicenseRef-LegalMark-*` trademark notice (all 16 Compare models, MultiUVTest, CesiumMan,
   CarConcept, SunglassesKhronos, ChronographWatch, AntiqueCamera) - **Scott to decide**. Validator: 0 errors, 7
   warnings (generated tangents x6, skinned non-root node x1). Credits, third-party notices and per-model render
   verdicts: `examples/assets/khronos/README.md` (`node scripts/khronos-assets.mjs` regenerates). Render check:
   `examples/khronos-gallery.html`; all 32 load since 5w a-d (0 GPU validation errors) and are in `visual:check` (`--only=khronos`). Gaps: 5w. Complement (not substitute): Blender-made test scenes that exercise our own Blender pipeline (export
   settings, custom properties/extras).
   [DONE 2026-10-15] **LICENCE DECISION:** DamagedHelmet's earlier model is CC-BY-NC 4.0 (theblueturtle_), so Scott
   decided: replace every public use with a CC0 helmet, keep DamagedHelmet only in internal tests/benchmarks.
   Picked **FlightHelmet** over SciFiHelmet (both CC0, both rendered in the demo): under the demo's lighting (no IBL)
   SciFiHelmet reads as a flat grey shape seen from the side, while FlightHelmet faces the camera with leather, rubber,
   brass, glass and wood - clearly the better showcase. It costs more bytes, so the packer now welds, quantizes
   (`KHR_mesh_quantization`) and simplifies: `node scripts/optimize-demo-assets.js` builds
   `examples/assets/flight-helmet.glb` (5,553,048 B: 94,722 triangles, 1024 px JPEG maps; DamagedHelmet desktop was
   3,773,916 B with 2048 px maps) and `flight-helmet-mobile.glb` (1,301,036 B: 20,734 triangles, 512 px JPEG maps,
   simplification error 0.005; DamagedHelmet phone was 600,948 B / 6,179 triangles) from the CC0 source in
   `examples/assets/khronos/FlightHelmet/`; Khronos validator 0 errors / 0 warnings for both (DamagedHelmet had a
   tangent-space warning). SciFiHelmet would have been 1.9 MB / 0.67 MB (1024 / 512 px).
   Public demo is now `/demos/flight-helmet.html` (old URL 301 via new `site/_redirects`), landing tile
   `site/images/flight-helmet.jpg`, sitemap, footer link "Demo asset credits" (`/demos/assets/ATTRIBUTION.md`),
   visual-regression views `flight-helmet-{high,light,phone}` (bit-identical over 4 runs), csp-check, demo
   subject/desktop/streaming/extension tests, READMEs and docs. `damaged-helmet-mobile.glb` and the old tile are
   deleted; `damaged-helmet.glb` stays for tests/benchmarks (credits now `examples/assets/damaged-helmet-CREDITS.md`,
   not copied to the site). Remaining DamagedHelmet mentions are internal: package tests, `examples/package-benchmarks`
   and their results, measurement notes in package READMEs/docs/whitepaper (labelled as such), this file's history.
   Not re-measured: the demo-load and frame-rate tables in `docs/demo-loading.md` / `docs/desktop-frame-rate.md`
   (rows labelled "former demo").
   RECHECKED 2026-10-16 at `05d9cf1`: `scripts/test-helmet-streaming.js` exits 0 under the GPU lock on Edge
   155.0.4283.60 / physical NVIDIA RTX A6000 (WebGPU, no software fallback). Direct desktop and streamed full-detail
   loads match exactly with SSAO off and on (`changedChannels: 0`); upgrade, failed-detail fallback, Android layout and
   pagehide cleanup pass. No renderer/core/stage change was needed. The original report had black direct-load goggle
   lenses (~320 px, max diff 165-171); its Arc 140V/D3D12 configuration has not been rechecked, and load/dispose sorting
   was never established as the cause. Results: `test-results/helmet-streaming.json`. csp-check was not re-run; run
   `node scripts/gpu-lock.mjs run --owner=<id> -- node scripts/csp-check.mjs` on AC. How to read this note, including
   what 5w.f already fixed in the gallery: `docs/flight-helmet-transmission.md`.
   **Visual triage 2026-10-17 (main 95b4eae6, branch `claude/proof-triage`).** `npm run visual:check -- --no-build
   --only=khronos` (Edge, GPU lock) reproduced 14 Khronos failures; each candidate commit was checked out, built with
   `npm run build:packages` and re-run. Baselines were NOT updated in this pass.
   | Item | First bad commit | Class | Evidence | Action | Now |
   | --- | --- | --- | --- | --- | --- |
   | ToyCar (62% changed, max 122), SheenChair (11%, 43), MaterialsVariantsShoe (9%, 78), DiffuseTransmissionTeacup (4.6%, 98) | b326518e "Add UV1 and geometry groups" ("correct WebGPU derivative tangent frames"); all four pass at 6a57389d (max 1) | **B** | All four are exactly the models whose normal-mapped primitives have no TANGENT attribute (every passing normal-mapped model has tangents), so they use the derivative tangent frame, which b326518e changed in packages/gltf-pro/src/shader.ts:49-56 and :150-157 (new `orientation=sign(dot(cross(dp1,dp2),n))` multiplying both T and B, plus component pre-scaling). Test: BoomBox, Corset and Lantern rendered with their TANGENTs stripped (derivative path) vs with tangents: difference grows at b326518e+ (mean / max: BoomBox 0.774/222 -> 0.853/163, Corset 0.499/100 -> 0.658/100, Lantern 0.168/95 -> 0.207/95), i.e. the new frame is further from the glTF tangent frame on all three. ToyCar's sheen cloth gets dark blotches absent from the Khronos screenshot and the old baseline. Likely cause (analysis, not yet proven on GPU): glTF's bitangent is cross(N,T) = -dP/dv; Schueler's derivative frame without the 1/det term gives T=det*dP/du, B=det*dP/dv, and WebGPU's y-down makes det<0 for front faces. Before b326518e T was inverted and B right; multiplying both by sign(det) makes T right and B inverted. Suggested fix (Codex, package code): T*=orientation, B*=-orientation (or the sample viewer's frame: T from the UV-determinant solve, B=cross(N,T)); accept it when the stripped-tangent renders match the tangent renders | report only; keep baselines | FAIL (regression) |
   | MetalRoughSpheres, AlphaBlendModeTest, TextureTransformTest, NegativeScaleTest, MorphStressTest, Fox, MeshoptCubeTest, NodePerformanceTest, IridescenceLamp, CommercialRefrigerator (max 1 level) | 8f710eb3 (same numbers at 8f710eb3 and 95b4eae6; not 6a57389d) | A | All have materials without a normal map. Consolidation added `if (!m.maps[2]) v[82] = 0` (normal scale 0 without a normal map; gltf-pro index.ts, dist `C.maps[2]\|\|(O[82]=0)`): the 1x1 flat-normal texel 0x8080ff decodes to (0.0039, 0.0039, 1), a 1/255 tilt that is now gone. Proof: at 8f710eb3 with only that statement removed from the built dist, all 10 pass (9 at 0 changed pixels, CommercialRefrigerator 0.00005) | intended and more correct: update these 10 baselines together (`npm run visual:update -- --no-build --only=<ids>`); not done in this pass | FAIL until baselines updated |
   | flight-helmet-high/light/phone (goggle lenses, max 159) | NOT TRIAGED | - | - | compare with docs/flight-helmet-transmission.md | - |
   | Night Citadel load timeouts | known, NOT TRIAGED here | - | - | - | - |
6. **Code hygiene >= 9** (5k), including zero `any` in public APIs and TSDoc on every export (autocomplete with docs).
7. **Docs + playground** (item 8): quickstart, three.js migration, two flagship tutorials, cookbook, generated API
   reference, live-editable examples.
8. **Humble, exact scope on the landing page:** a small, fast WebGPU engine for high-part-count CAD/engineering
   assemblies, modular web 3D apps and instant-load web games - not "replaces Unreal/Unity/Blender". Design-envelope
   page (5j) linked.
9. **No flaky gates:** `npm run verify` passes 5 times in a row under load (5l.s).
   Seen 2026-10-15: Night Citadel's visual capture hangs at "Preparing the citadel..." past a 90 s page.goto
   timeout (high/light views; phone took 53 s) while three agents built and tested in parallel; alone it loads in 4-7 s
   and passes (twice). No page errors logged. Before launch: reproduce under a bounded load (half the cores) and find
   what the load event waits on (preview server starved vs the app's own init); a visitor's busy laptop must not hang.
10. **claims.md:** 0 OVERCLAIM and 0 UNPROVEN rows for anything on public pages.
   Status 2026-10-15 (proofs): every row resting on a proof now cites the proof and its pinned commits (claims.md
   "Proofs": one table of all 46 with baseline -> pin and the --current ref). H-04 (STALE) became PROVEN: `npm run
   proofs` reproduces every kept optimization proof; the summary is recounted (212 PROVEN, 6 STALE). Mock-GPU timings
   that predate the core speed-ups (PKG-055, the VAT numbers) are dated to `700838e` in the READMEs.
   Triage 2026-10-17 (table under gate 1): claims.md "Proofs" names main's --current refs (`b3ed8ac` for all nine, from
   d3629be1); the rows PKG-035, PKG-054, PKG-065, PKG-068 and LIM-016 still name the older --current refs (fix with this
   gate's STALE rows). Claims that changed:
   PKG-035 / PKG-054 and oit-detached ("feature off: identical GPU calls" for gltf-pro) do NOT hold on main until the
   compact-path discard regression (8f710eb3) is fixed; 1e.f's early-Z win (7f1c9c6, 0.852 -> 0.524 ms) is lost for plain
   opaque/BLEND glTF materials on main. Selection outlines now include descendants of a selected plain core mesh
   (8f710eb3; Scott deferred deciding whether to keep that, 2026-10-17); BackSide support costs selection's model mask a few ALU ops when unused (95b4eae6).
11. **Security (Scott, 2026-10-15):** 0 open findings, each fixed with a regression test. (a) Every parser of untrusted
   input (glTF/GLB, OBJ, STL, PLY, 3MF, PCD, XYZ, OFF, VTK, FBX, USD/USDZ, IFC, STEP/IGES, KTX2/Basis, Draco, meshopt,
   EXR, HDR, UltraHDR, .margo, audio/video metadata, net snapshots) has a seeded fuzzer: malformed and hostile inputs
   produce a named error within the size/time budget, never a hang, crash, out-of-range read or memory blowup; the
   fuzzers run in `test:release`. (b) No script injection (user/file strings into innerHTML in html, labels,
   inspector, stats, viewcube, frame debugger), no prototype pollution from file JSON (glTF extras/extensions, .margo),
   validated worker messages, URIs from model files cannot escape their base (no path traversal, no surprise
   cross-origin fetches, data:/blob: handled). (c) Supply chain: npm audit clean or justified, licences listed, lockfile
   integrity checked, npm publish with 2FA + provenance (plan; publish needs Scott), SECURITY.md with a disclosure
   address. Strict CSP stays (gate 10 / 5l.o).
   (c) [DONE 2026-10-15 except Scott's account steps below] `scripts/supply-chain.mjs` (`npm run supply-chain`)
   generates `THIRD-PARTY-NOTICES.md` for all 75 published packages (73 + create-margo + margo-convert) from the
   manifests and package-lock.json; `--check` (run by `tests/supply-chain.test.js`, in verify) fails on a stale file, a
   manifest without license/repository/files/exports/sideEffects or with `private`, a runtime dependency without a
   stated reason, a licence outside MIT/ISC/Apache-2.0/BSD/Zlib/0BSD (reviewed exceptions: occt-import-js LGPL-2.1,
   web-ifc MPL-2.0), an install script, a deprecation, a non-registry or hash-less lock entry, or a runtime dependency
   the code never imports. The same test reads every tarball's file list with npm's own npm-packlist (~1 s for all 75)
   and requires LICENSE, README and each package's third-party notices, and no src/tests/fixtures/source maps/keys.
   Runtime npm dependencies (lock versions): recast-navigation 0.43.1 + @recast-navigation/core/generators/wasm 0.43.1
   (MIT; navigation), occt-import-js 0.0.23 (LGPL-2.1; margo-convert); peers web-ifc 0.0.78 (MPL-2.0; ifc),
   @dimforge/rapier3d-compat 0.21.0 (Apache-2.0, optional; physics), react 19.3.0 (MIT; react). 65 of 75 packages have
   no third-party runtime dependency. None has an install script; the whole lock has one (fsevents 2.3.3, dev, macOS
   optional) and one deprecation (whatwg-encoding 3.1.1, dev via jsdom). The pre-1.0 runtime deps (occt-import-js,
   web-ifc, recast-navigation) are the maintenance risk: check `npm view <name> time.modified` before each release.
   `npm audit` (registry reachable, 2026-10-15): 0 vulnerabilities (all and `--omit=dev`); `npm audit signatures`
   against the main checkout's install: 116 packages with verified registry signatures, 39 with attestations.
   Shipped third-party code and notices: decoders (Draco, Basis: Apache-2.0, now with `dist/LICENSE-Apache-2.0.txt`;
   the meshopt decoder is a port of meshoptimizer, MIT notice added to its THIRD-PARTY-NOTICE.md), machinery (OCCT
   glue + Wasm, LGPL-2.1: OCCT-NOTICE.txt rewritten to state each obligation; the patched glue's first line now
   carries the change date, LGPL s. 2b, via `scripts/static-embind.js`), text (`sdf.ts` follows TinySDF line by line:
   BSD-2-Clause `NOTICE.md` added and shipped). LGPL how-met list in THIRD-PARTY-NOTICES.md (notice + licence text
   next to the files, modification marked and dated, transformation script public, upstream source linked, glue and
   Wasm loaded by URL so users can swap in their own build). Open for Scott: whether linking upstream occt-import-js
   0.0.23 suffices for LGPL s. 4 or we mirror its source tarball (the airtight option); not legal advice.
   The site build copies THIRD-PARTY-NOTICES.md to `/THIRD-PARTY-NOTICES.md` (a footer link is still to add).
   Tarballs (npm pack --dry-run of all 75, after build:packages): no surprises; only package.json, README, LICENSE,
   NOTICE.md (post, tonemap, text), blender's FORMAT.md and dist/. The OCCT .wasm/.js contain the upstream
   author's build paths (`C:/Users/vkovacs/...` in assert strings), not ours. Secrets scan (tracked files, all
   history, built dist): no tokens, keys, .npmrc/.env files or email addresses in files; scott@scottcampbellconsulting.com
   appears only as the git author email of 389 commits (public once pushed; set user.email to the GitHub noreply
   address for future commits if that matters). `margo-convert` gained `sideEffects: false`; create-margo is
   bin-only (no exports). Root `publish:packages` (a local live publish) became `publish:dry-run`; README points to
   `docs/releasing.md` (2FA, OIDC trusted publishing, bootstrap granular token, `npm ci`, changelog, order:
   @margoengine + margoengine, then margo-convert, then create-margo; deprecate/unpublish). `.github/workflows/publish.yml`:
   manual only, inert until the repo variable `NPM_PUBLISH_ENABLED=true`, `npm-publish` environment, `--provenance`,
   dry run by default; requires a `## <version>` section in CHANGELOG.md (does not exist yet: 1g.g). `SECURITY.md`
   (1.x supported; GitHub private vulnerability reporting preferred, security@margoengine.com; acknowledge 3 business
   days, triage 10, fix or plan 30 days, coordinated disclosure at most 90 days) and a `docs/security.md` stub for the
   gate 11 a/b write-up. **Scott, before launch:** create the security@margoengine.com mailbox (or forwarding) on
   margoengine.com; enable private vulnerability reporting in the GitHub repo settings; 2FA on npm and GitHub;
   create the `npm-publish` environment (Scott as reviewer, `main` only); after the first publish, configure
   trusted publishing per package and revoke the bootstrap token. Blender add-on (Python, not on npm) declares MIT;
   extensions.blender.org listing would need its licence policy checked first.
   Status 2026-10-15 (b), attack-surface review: 0 open findings in (b). Threat model and guarantees: `docs/security.md`
   (trusted: the app's code, its URLs and options; untrusted: every byte of an asset file, URIs inside it, network data,
   worker replies). Every fix has a regression test: `tests/security.test.js` (in `verify`), plus "security: ..." tests
   in `packages/fbx/test/fbx.test.js`, `packages/loaders/tests/loaders.test.js`, `packages/inspector/test/frame.test.js`.
   New shared helpers: `packages/shared/asset-url.js` (`assetURL`), `packages/shared/json.js` (`parseJSON`).
   Findings, severity, fix:
   - HIGH, model URIs escape their base: `gltf` `loadGLTF` buffers, `gltf-pro` buffers/images (`asset.ts`, `stream.ts`
     progressive) and FBX texture names (`fbx/src/index.ts`, built by string concatenation) were fetched as written:
     `../`, absolute, protocol-relative and cross-origin URIs, so a model could make the viewer request intranet or
     same-origin endpoints (with cookies) or track who opens it. Now `assetURL`: same origin, inside the model's
     directory (after redirects), no `%2F`/`%5C`, HTTP(S) only, else TypeError before any fetch; new option
     `allowedURLs` (URL prefixes) on gltf `GLTFOptions`, gltf-pro `AssetOptions` (worker and progressive forward it)
     and `FBXOptions`. Default is the safe one. (API reports updated.)
   - HIGH, ReDoS: STL text `/facet\s+normal[\s\S]*?endfacet/g` (`machinery/src/cad-parser.ts`) rescanned to EOF for each
     unterminated facet (20,000 facets, 380 KB: 0.84 s; a 64 MiB file: hours). Now an indexOf scan, same facets.
   - MEDIUM, ReDoS: 3MF XML attribute regex (`loaders/src/xml.ts`) was quadratic on a long run without `=` (20 KB: 0.3 s);
     a lookbehind now starts names only at token boundaries (1 MB: 6 ms).
   - MEDIUM, budget bypass by prototype lookup: gltf-pro `components[def.type]` / `componentSizes[...]` on plain objects:
     `"type": "constructor"` made sizes NaN, `decoded += NaN` switched the 4x decoded-memory budget off for the asset.
     Tables are now null-prototype and `budget()` fails on NaN. Same class, fixed with own-key lookups / null-prototype
     objects: 3MF `unit in THREEMF_UNITS` (NaN positions), PLY `TYPES[...]` (NaN truncation checks), VTK `SIZES[...]`,
     loaders `detectFormat` extension table, XML `&constructor;` entity, FBX `MIME[ext]` (`x.constructor` passed the
     extension allowlist and was fetched), Draco `fields`/`dracoTypes`, exporters `widths`/`arrays`, gltf-pro image
     `source` lookups (`index.ts`, `progressive.ts` settled[]), `hookFor`.
   - MEDIUM, prototype swap on file-named keys: VTK `SCALARS __proto__`, USDC Crate field token `__proto__`, USDA
     property metadata via `Object.assign`, 3MF `<metadata name>`, XML attributes, exporters attributes, Draco attributes:
     all now null-prototype objects (3MF `metadata` and VTK `attributes` are returned that way; documented).
   - MEDIUM (Scott's rule), `__proto__`/`constructor`/`prototype` keys in glTF/GLB/.margo JSON (extras, extensions)
     were handed to apps as own keys, ready to pollute through an app's merge. `parseJSON` drops them at every depth
     (reviver only when the text contains one of them or a `\u` escape; plain files parse at JSON.parse speed:
     22.8 MB in 230 ms vs 245 ms).
   - LOW, unbounded reads: progressive glTF read a `.gltf` JSON body, its ranged remainder and external images fully
     before checking the budget (`stream.ts`); FBX textures had 64 MiB each with no total. Now streamed under the budget
     (`readResponse`); FBX textures share the converted GLB's 128 MiB.
   - LOW, worker boundary: `shared/worker.js` `runWorker` hung on a null reply and mapped error name `constructor` to
     `Object`; `serve`, decoders, bvh and progressive workers threw on non-object messages; progressive started a
     second stream on any message without `order`; CAD client hung on null; progressive client had no
     `onmessageerror` and no image-index bounds. All checked at the boundary now; unknown messages are ignored.
   Reviewed, no finding: no `innerHTML`-class sink in any package (`tests/security.test.js` scans for them; inspector,
   frame debugger, stats and view cube use `textContent`; a node or GPU label `<img src=x onerror=alert(1)>` renders
   literally); no window `message` listener, `postMessage('*')`, `eval`/`new Function`/string timers or computed
   `import()`; no `fetch` sets `credentials` (browser default same-origin); `Math.random` only in math helpers; net has
   no decoder; USDZ/3MF references stay inside their archive; core + stage untouched (no core finding).
   Accepted by design (documented in security.md): app-supplied URLs and options are trusted (`decoderPath` goes to
   `importScripts`; environment/audio/decoder `.wasm` loads read app URLs without a byte cap; text/lines copy option
   keys onto the instance); `@margoengine/cache` keys by URL only (no `Vary`/credentials) and trusts its own IndexedDB;
   telemetry socket is the app's. Examples (not packages) use `innerHTML` with first-party numbers only
   (`examples/conveyor-simulator/src/main.js`).
   Noted for others (not security, not fixed here): bvh `transfer: true` + abort leaves the caller's buffers detached
   (`bvh/src/async.ts`); progressive glTF ignores the `fetch` option; decoder pool queues are not capped per worker.
   Status 2026-10-15, 11a part 2 (asset parsers; gltf/gltf-pro/decoders/environment images/.margo are part 1):
   `npm run fuzz` (scripts/fuzz/run.js + harness.js, no dependencies; targets in scripts/fuzz/targets-*.js, part 2's in
   targets-assets.js) runs each target in its own Node child (`--jobs` at most 2), seeded and deterministic (input i of
   seed s is fixed; `--dump=i` writes it, `--replay=`/`--minimize=` rerun or shrink one). Oracle: return or a named error
   (the package's class, or a TypeError/RangeError whose message is the package's own, never V8/Wasm text such as
   "Cannot read properties", "Offset is outside the bounds", "unreachable"), within the target's time limit, without
   growing heap + ArrayBuffers by more than 64 MiB + 64x the input; a child that stops progressing is killed and its
   seed/iteration reported. Mutations: bit/byte flips, interesting integers written into length/count/offset fields
   (u8-u64, LE/BE, aligned), truncation (half the time inside the first 128 B), deletion, duplication, insertion,
   splicing between seeds, text numbers replaced with huge counts / negative and out-of-range indices / NaN / Infinity,
   line edits, deep nesting; generators per format: zip bombs (16-200 MiB of zeros), lying declared sizes, traversal and
   65,535-byte entry names, 3MF component fan-out and cycles (also across p:path parts), deep XML/USDA/STEP lists, bad
   string escapes, Crate files with revisiting path jump tables, FBX record trees with hostile values, int64 overflow,
   cyclic connections, ASCII arrays of 8 M values, IFC reference cycles. Seeds: the repo fixtures (loaders, usdz, ifc,
   bvh OBJs, triangle.fbx, the FBX and Crate test writers) and the occt-import-js test STEP/IGES/STL files. STEP/IGES
   run through machinery's built CAD worker (OCCT compiled once, instantiated per file) and IFC through web-ifc, each in
   a worker thread terminated at a deadline as loadCAD and parseIFCInWorker do. `test:release` runs `npm run fuzz --
   --short` (4 s per target, seed 1). Clean run, seed 3, 90 s per target (180 s STEP): ply 11,311, pcd 14,804, xyz
   14,577, off 13,041, vtk 11,739, 3mf 7,696, loaders usda 14,233, loaders usdz 17,134, stl 13,779, obj 8,394, iges
   2,137, step 3,752, SurfacePhysics 12,157, fbx 1,235, usdz usda 14,569, usdc 2,983, usdz 14,740, ifc 5,932, net
   snapshots 15,954, exporters round trip 10,333 inputs, 0 findings. Earlier runs (seed 1 at 120 s, seed 2 at 180 s on
   STEP/IGES/IFC/USDC/FBX/3MF) found the last five below. Findings, all fixed with a regression in
   tests/fuzz-regressions.test.js (reproducers in tests/fixtures/fuzz), packages/ifc/tests/worker.test.js or
   packages/physics/tests/physics.test.js:
   - PLY, PCD, OFF: a short file declaring millions of elements allocated first (PLY: 336 MiB for 314 B; PCD
     binary_compressed: 183 MiB for 167 B via a declared LZF size). Now the body must be able to hold the declared counts
     before any allocation (a digit and a separator per ASCII value, the row size in binary, LZF at most 88x).
   - ZIP (3MF, USDZ): a deflated entry is allocated at its declared size (512 MiB allowed) and a 64 MiB bomb inflated
     from 65 KB. New `maxRatio` (ZipOptions, parse3MF): an entry over 1 MiB may expand at most 200x (real 3MF: 9x;
     deflate's limit is 1,032x), checked before allocating. Traversal names were harmless (entries are map keys; usdz
     already refuses escaping asset paths) and are now generator cases.
   - 3MF: components that reference the next level 64 times, 30 deep, never finished (hang). The build now expands to at
     most 100,000 object instances (the per-file part cap); empty meshes skip per-instance work.
   - USDA (loaders readUSDA, also used by usdz): `( """doc""" )` metadata and quoted prim names with bad escapes threw
     JSON.parse's SyntaxError; now LoaderError `syntax`.
   - STL/OBJ (machinery): non-UTF-8 text threw TextDecoder's TypeError, now `Invalid STL/OBJ: not UTF-8 text`; the
     ASCII STL facet regex was quadratic (hang; the same linear scan also landed in 11b).
   - STEP/IGES (CAD worker): OCCT's own "Maximum call stack size exceeded" (a 50,000-deep list) reached the caller raw.
     OCCT failures and Wasm traps are now `B-Rep import failed: OpenCascade threw/trapped on this STEP file`, OCCT mesh
     indices are bounds checked, and a dead worker rejects with `CAD worker failed: ...`; one worker per load, so the
     next file starts a fresh OCCT (tested). A 4-byte change in Cube 10x10.igs keeps OCCT busy 135 s: new
     `timeoutMs` (default 120,000) terminates the worker with `CAD import did not finish within ... ms`.
   - IFC: web-ifc 0.0.78 loops forever inside its Wasm on malformed parameter lists (`#1e999`, `#11 x`, `.T.x`, `'a'b`,
     `$x`, `#-1`): parseIFC now checks ISO 10303-21 statement syntax first (linear; all 56 occt-import-js STEP files and
     wall.ifc pass) and reports LoaderError `syntax`. web-ifc's own TypeErrors (OpenModel without FILE_SCHEMA) and traps
     are LoaderError `unsupported`. It also loops on syntactically valid but schema-invalid models (a string where a
     set belongs, a missing attribute: fixtures/fuzz/ifc-arity-hang.ifc), which no check in front of it can rule out,
     so untrusted IFC needs the new `@margoengine/ifc/worker` `parseIFCInWorker(bytes, {webIfc, wasmPath, timeoutMs})`:
     a fresh worker loads the app's web-ifc-api-iife.js and is terminated at the deadline (LoaderError `limit`).
     Tested in Node (worker script in-process, deadline with a stub Worker); not yet run in a browser.
   - FBX: a truncated 'Y'/'C' property was read before its bounds check (DataView RangeError); corrupt zlib arrays threw
     DecompressionStream's TypeError, unhandled when a later record failed first; ASCII arrays took 4.6 s for 16 MB
     and had no decoded budget (now linear, 256 MiB as binary); a 100,000-corner polygon ran over 5 minutes (ear
     clipping is quadratic) and 3,000,000 faces filled the corner lists before the vertex budget was checked. Now:
     bounds before reads, `FBX: compressed array is corrupt...`, at most 4,096 corners per polygon and 10^8 corner^2
     of triangulation work, the vertex budget checked per triangle.
   - USD Crate (usdz): path jump tables that revisit entries walked subtrees 2^n times; deep paths were built before
     the depth check (quadratic); list ops filtered deletions with includes (quadratic); 1,706-byte files allocated
     128 MiB and 109 MiB from corrupt path/string counts and LZ4 sizes; an int xformOpOrder threw "n is not iterable";
     an int connection reached String.split; a non-UTF-8 USDA layer threw TextDecoder's TypeError; the convex polygon
     check took 6.3 s for 320 1,024-gons (1.3 MB). Now: each path entry visited once and depth checked while walking,
     Set lookups, counts never preallocated, LZ4 output at most 255x its input, field types checked, `USD: USDA layer is
     not UTF-8 text`, 10^7 polygon work (as loaders' USDA).
   - SurfacePhysics: non-object parts, carriers, nodes or vectors threw "Cannot read properties of undefined"; now
     `TypeError: Invalid surface part/carrier/vector`. Physics (Rapier): a NaN or infinite convex hull failed inside
     Rapier ("expected instance of p"), a NaN trimesh or heightfield was accepted and poisoned the simulation; now
     `RangeError: ... must be finite Float32 values` before Rapier.
   Typed-array audit (every view/index read in these parsers checked against its buffer before access): fixed the FBX
   'Y'/'C' reads, the PLY/PCD/OFF/Crate/LZ4/ZIP allocations sized by file counts, the OCCT index reads; checked and
   left as they were: PLY binary rows, PCD binary/LZF, ZIP directory and local headers, VTK binary, Crate take/seek,
   LZ4 byte reads, FBX arrays and `need`, binary STL, 3MF triangle and property indices, USD face/normal/UV indices,
   FBX layer indices, IFC face indices. No findings: net snapshots (finite packets always sample finite), exporters
   round trip (every exported STL/OBJ/PLY/USDZ re-imports or fails by name). Audio and video parse no containers
   themselves (the browser's decodeAudioData / video element do), so they have no target. Open: parseIFCInWorker
   browser check; navmesh (Recast) is part of the hygiene group and was not changed.

Before launch, in addition to the work queue:
- Demos smooth on first load on desktop and phones, including Android. The Galaxy S23 3-5 FPS island issue is shelved
  (Scott has no device to test it).
- Every public number reproducible from the repo: size (core + stage gzip, `npm run measure:size`; three.js comparison
  `npm run measure:threejs`), speed proofs, a fair three.js benchmark.
- Comparison page states limits honestly (WebGPU-first, which packages still use third-party code, unverified devices).
- READMEs and getting-started docs for every package; licence and third-party notices checked.
- API review of the change list before publishing 1.0 to npm.
- Production deploy and npm publish only with Scott's go-ahead each time.
- Publish create-margo (`npm publish tools/create-margo`, after the @margoengine packages its template depends on),
  then check `npm create margo@latest my-app` from a clean directory and add the command to the README and the
  margoengine.com getting-started page.

### Release presentation: many small packages (Scott, 2026-10-15; checked against the repo the same day)

Message: the package split is WHY the engine starts small, and nobody has to learn it to start. The worry to answer
up front: "do I need 40 installs to draw a cube?" and "will package versions clash?". Recount every number below right
before publishing; use only measured numbers from claims.md.

Facts today: 73 packages (72 `@margoengine/*` + `margoengine`). `margoengine` is the stage facade (`createStage`):
core + stage = 19,999 B gzip (`npm run measure:size`). Installing it also installs gltf, machinery, creative, scenery,
environment and shadows, but their code loads only on first use (`app.load()` for glTF/STL/OBJ/STEP/IGES, `app.sky()`,
particles, post, `app.environment()`, `app.shadows()`), so a spinning model costs core + stage + the gltf entry.

1. Three ways in, shown at the top of the README and the getting-started page, in this order:
   - `npm create margo@latest my-app`: a working app from the template (quality tiers, orbit controls, stats,
     environment lighting, the CSP `_headers` and 404 page).
   - `npm install margoengine`: `createStage('#scene')`, then `app.load('model.glb')` - five lines, no other installs.
   - Pick-and-choose: `npm install @margoengine/core @margoengine/gltf-pro @margoengine/culling` for teams that count
     bytes. Each package README starts with its size and what it peers on.
   Check before launch: does the stage cover the common case? [DONE 2026-10-15: `await app.environment(url, options)`
   and `await app.shadows(options)` lazy-load `@margoengine/environment` and `@margoengine/shadows` (now `margoengine`
   dependencies, `^1.0.0`) like `app.sky()`. Core + stage 19,928 -> 19,999 B gzip (`npm run measure:size`): ONE byte
   under the 20,000 gate, so the stage has no room left for another method. To fit, the IBL glue lives in the
   environment pack (`EnvironmentLighting.load(engine, urlOrSource, options)`: fetch/decode, `Environment.attach`,
   lighting, AbortError and nothing attached if the engine is disposed or `signal` aborts; disposing the lighting also
   removes its environment), and shadows cast from the meshes present at the call (later ones: `shadows.add(mesh)`).
   Lazy packs on first call (Vite minify, core external): environment 25,572 B gzip, shadows 7,120 B.
   Real GPU (`scripts/stage-features-gpu-check.js`, Arc 140V / Edge 155 headless, GPU lock): stage with a loaded glTF
   cube on a floor; `app.environment(spot1Lux.hdr, {intensity: 4})` changed 66,084 of 120,000 pixels, then
   `app.shadows({resolution: 1024})` changed 3,266 (8 dynamic caster draws); 0 validation errors; `app.dispose()`
   disposed the lighting, its environment and shadows and removed the canvas, and a load pending at dispose rejected
   with AbortError. Seen in the frame (test-results/stage-features-shadows.png): the 1 m cube's shadow edge is visibly
   stair-stepped at the default `distance: 500`. FIXED in 5l.j (0 stage bytes): the cascades spanned 0.1-500 m, so the
   cube sat in 13 cm texels; Shadows now fits them to the core meshes' bounding sphere when `distance` is unset
   (0.35-1.8 cm texels; the check measures both and saves `stage-features-shadows-500.png` as the old look).]
   Any further addition is lazy-loaded or it raises core + stage, which must stay under 20,000 B.
2. Show packages grouped by layer wherever they are listed (site catalog, docs/README.md, README), never as one
   alphabetical list of 73: add a `category` field per package (build-catalog.js -> docs/catalog.json) and group the
   catalog page. [DONE 2026-10-15 for catalog.json, the catalog page and sizes.html; build-catalog fails on a package
   without a layer, `tests/catalog.test.js` checks every package has one in this order. README.md and docs/README.md
   DONE the same day: generated from catalog.json, `tests/package-lists.test.js`.] Layers (all 73 real names):
   - Start here (2): margoengine, core
   - Setup and diagnostics (5): math, quality, webgl, stats, inspector
   - Loading and formats (12): gltf, gltf-pro, loaders, decoders, fbx, usdz, usdz-export, exporters, ifc, blender,
     cache, splats
   - Rendering and lighting (18): materials, shader, environment, clustered, shadows, sky, toon, oit, lod, culling,
     points, lines, text, labels, html, video, xr, staging
   - Post-processing (5): post, tonemap, dof, taa, transitions
   - World and effects (10): terrain, water, scenery, scatter, road, vfx, creative, procedural, wfc, splines
   - Animation and interaction (11): animation, animator, tween, cinematic, controls, cameras, input, gizmo, viewcube,
     selection, audio
   - Simulation and games (6): physics, navigation, navmesh, ecs, fsm, net
   - CAD and engineering (3): machinery, bvh, geometry
   - Frameworks (1): react
3. No version clashes: DONE 2026-10-15. All 73 packages, create-margo and margo-convert are 1.0.0; every internal
   range (packages, template, examples, Night Citadel) is `^1.0.0`. `node scripts/set-version.mjs <x.y.z>` moves them
   all at once; `tests/versions.test.js` (in verify) fails on any drift. Still to do: one changelog (1h.g, Changesets
   or a hand-written CHANGELOG.md) before the first publish.
4. Wording: lead with "core + stage is under 20 KB gzip; everything else loads only if you use it". Never claim it
   fits in the first TCP round trip (~14.6 KB; core + stage is 19.9 KB), never quote a package count or package name
   without checking, and link docs/limits.md next to the size claim.

## Feature gaps versus three.js (after optimization; each as an optional package)

Verified matrix: `docs/threejs-parity.md`, recounted 2026-10-17 after the approved core hooks and optional material parity work: 159 rows, 100 covered / 34 partial / 25 missing.
Earlier: re-tallied 2026-10-14 against 2c53227 (156 three.js features: 85 covered,
39 partial, 32 missing after textured instancing (InstancedMesh PARTIAL -> COVERED) and glTF export (GLTFExporter PARTIAL -> COVERED); ShadowMaterial became partial with staging's ContactShadows; was 65 / 43 / 45 in its stale summary; read from source, not run). The first audit's top gaps
(materials, glTF extensions/decoders, picking models, IBL, background colour, post stack, ortho camera, math, FXAA) are
closed. New top 10: WebGL2 beyond core, [DONE: environment `TransparentCanvas`] transparent canvas, multiple directional/coloured ambient/hemisphere
lights, [DONE] point and spot shadows (see below), [DONE] textured instancing (+ `EXT_mesh_gpu_instancing`, see below), remaining glTF extensions
(animation pointer, iridescence, anisotropy, dispersion, variants, refraction, cameras), physical materials on your own
meshes, second UV set/groups/custom attributes, ShadowMaterial, [DONE, below] glTF export with animation. `docs/from-threejs.md`'s
"Not yet" table matches it. Several need core changes (freeze conflicts listed in the doc); those are Scott's decision.

Textured instancing (gap 5, done 2026-10-14, core untouched): gltf-pro `PBRInstances` on `primitive.instances` (matrix in
node space, RGBA tint, UV scale/offset per instance; `setMatrixAt`/`getMatrixAt`/`setColorAt`/`setUVTransformAt`, `count`,
`needsUpdate`, dirty-row uploads) draws N instances in one draw; the instanced vertex patch (`gltf-pro/src/instancing.ts`)
is applied after lighting/material effects so shader `NodeMaterial` vertex nodes keep their anchor. `EXT_mesh_gpu_instancing`
is read (T/R/S, normalized rotations). materials `createInstancedMesh(engine, geometry, material, capacity)`. Shadows and
staging contact shadows draw instanced casters (`packages/shared/instances.js`); TAA skips them (camera motion only); bvh
`Raycaster` and selection `Picking` report `instanceId`, outlines draw every instance in one draw. Proofs: non-instanced
GPU calls byte-identical vs 6eeffab (`gltf-pro-lighting-hooks.proof.js 6eeffab`, `materials-uv-transform.proof.js 6eeffab`).
Real GPU (Arc 140V, AC, lock held): instanced frames equal N meshes (max channel diff 1) for materials, glTF and NodeMaterial
scenes under shadows/clustered/SSAO/IBL/fog; picking returns the right instance; 1k-10k textured boxes: CPU 9-70 ms ->
0.5 ms, frame 63-562 ms -> 4 ms (`examples/package-benchmarks/textured-instancing-gpu.mjs`, `results/textured-instancing-gpu.json`;
mock-GPU CPU sweep `textured-instancing.mjs`). Size (min+gzip): gltf-pro +1.9 kB (opt-in since queue item 5b: the
root keeps +0.27 kB, the rest is `@margoengine/gltf-pro/instancing`), selection +0.38, bvh +0.31, shadows +0.31,
staging +0.28, materials +0.08, taa +0.01. Left: per-instance frustum culling, transparent instance sorting, textured
`ScatterInstances`, one-instance outlines.

glTF export with animation (gap 10, done 2026-10-14, core untouched; GLTFExporter row now COVERED): `exportModel(models,
{binary, animations, onlyVisible, embedImages, maxTextureSize, generator, embed, binUri})` in
`@margoengine/exporters/model` (also the root) writes gltf-pro `PBRModel`s and `@margoengine/materials` meshes: document
node order, live TRS/names/visibility, every attribute and morph target re-written from gltf-pro's decoded accessors
(lossless; weights divided by their sum), node morph weights, skins, clips (`animations: [Animation]`),
`EXT_mesh_gpu_instancing` (+ `_COLOR_0` tints), live material values with textures, `KHR_texture_transform`, emissive
strength, unlit, ior, clearcoat, transmission, sheen, specular, volume factors. Loaded image bytes are copied; materials
textures are PNG-encoded (own encoder via CompressionStream; non-raw sources and `maxTextureSize` via OffscreenCanvas).
Materials' `createMesh` now returns `MaterialMesh` (`mesh.material`, API change). The scene exporter moved onto a shared
`container.ts` (`Bin`); `exportGLB`/`exportGLTF` output is byte-identical to before (checked against the old dist).
Proof: `packages/exporters/tests/model.test.js` (helmet + robot: node tree, transforms, every accessor and packed vertex
byte-exact, materials, images, all 14 clips sampled at 5 times each within 2e-5; instanced grids; materials meshes with
the PNG decoded back exactly; onlyVisible; .gltf). Khronos validator: no new issue vs source (the robot's 752
unnormalized-weight errors are gone; its 4 skinned-mesh-hierarchy warnings and the helmet's missing-tangents warning
are the source's). Time/size (`examples/package-benchmarks/exporters-model.mjs`, Node 24): helmet 3.77 MB in 7.7 ms,
robot 464 -> 451 kB in 3.6 ms, 2 x 500 instanced grids 2.6 ms. Gzip (min, bare external): scene glTF path 7,079 ->
7,157, usdz 5,911 -> 5,915, `/model` eager 6,859 (entry 5,175 + shared container 1,684), lazy chunks: clip writer 539,
PNG encoder 1,026. `node packages/exporters/tests/png-browser.mjs` checks the canvas paths (flipY, maxTextureSize, passed on
Edge 155). Left: cameras/lights, Draco/meshopt output, materials normal/matcap shading and custom blending.

Point and spot light shadows (gap 4, done 2026-10-14, core untouched): `LocalShadows` in the new entry
`@margoengine/clustered/shadows` (`packages/clustered/src/shadows.ts`). `castShadow: true` on a clustered light gives it a
shadow ordinal in the light buffer's unused params.z; the first `maxLights` (1-16, default 4) get layers in one depth32float
texture array (`resolution` default 512): six reversed-depth cube faces per point light (each a little over 90° so the 3x3
PCF stays inside a face), one perspective map per spot light. Bias is texel-scaled at the receiver (`bias` toward the light,
`normalBias` along the normal). Clustered's root gained a declared hook (`lights.shadow`, set by LocalShadows: its WGSL
`clusterShadow(light,position,n)` multiplies each light in clustered's loop, its bindings 14-16 join clustered's), so core
meshes and every `lights.add()` receiver (gltf-pro, materials) receive with no new text anchor. Casters via `add()`: core
meshes, `shadowPrimitives` sources (gltf-pro, materials, `primitive.instances`, alpha masks); not terrain/scatter
`drawShadow`. Maps re-render per light when the light changes, all when a caster moves/hides/changes instances or
`shadowVersion`; `{dynamic:true}` (skinned) re-renders every frame. Proof: clustered GPU calls byte-identical vs 0ed56b9
without the entry (`proofs/clustered-local-shadows.proof.js`; a `castShadow` flag alone changes only params.z). Real GPU
(Arc 140V, AC before/after, lock held, `local-shadows-gpu.mjs`, `results/local-shadows-gpu.json`): shadows where expected
for point and spot on core and materials floors from core, materials and instanced boxes, lit floor unchanged (acne 0),
contact gap 0 px; frame 8.5 ms attached/unshadowed, 1/4/8 point lights 8.9/9.9/11.4 ms cached and 9.8/12.6/16.2 ms
re-rendered each frame; timestamp GPU pass sums were noisy (unshadowed baseline without the entry read 4.5 ms, above the
attached 3.7 ms), so the README quotes frame times. Size (min+gzip): clustered root 4,651 -> 4,829 (+178 B, the hook),
the shadows entry 5.9 kB, shadows package unchanged. Left: per-light caster culling, `drawShadow` casters, PCSS.
The older summary below predates the audit.

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
- Feature presets (5i.b): `applyQualityTier()` also sets `globalThis.margoPreset`; shadows, SSAO, SSR, volumetric
  fog, local shadows and VFX fill options the app left undefined from it (table in the quality README).

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
5. [DONE, rejected: no compute gain, draw 0.3 ms slower; see 0b] VFX workgroup compaction GPU timing.
6. UNCOMMITTED, written while the laptop was busy: `packages/geometry/src/subdivide.ts` (loopSubdivide without
   per-vertex strings, per-edge arrays or Sets). Prove it with
   `node examples/package-benchmarks/proofs/geometry-subdivide.proof.js` (baseline `bdb7521`), run
   `npm run test:all`, then commit or revert. It type-checks; nothing else about it has been run.

## Known issues and caveats
- Provenance (2026-10-15): no shipped code is copied, ported or resampled from three.js any more. The two pieces that were
  (clustered's LTC table and the shared AgX shader) were replaced by independently derived versions; see 5l.f and the
  tonemap/post `NOTICE.md` files (the three.js licence block is gone). Remaining three.js mentions in package sources are
  API-parity notes ("counterpart of", "as in three.js"), not derived code.
- Pending re-verification on the merged branch once workers are idle: `node packages/shader/test/browser-check.mjs`
  (stalled at browser launch while other GPU checks ran), plus each merged package's own `browser-check.mjs`.
- Engine logic moved out of demos (not yet run in a browser): frame pacing `frameDue`/`frameStatus` ->
  `@margoengine/quality`; Citadel `NightAtmosphere` -> `@margoengine/scenery`; Earth `Stars` -> `@margoengine/creative/stars`.
  Verify with `node scripts/modern-night-citadel-tests.js` (passes, 2026-10-14) and by opening the Earth demo.

- The measured tier is remembered per browser with no expiry and no on-page control yet.
- A fast PC sees the light tier on its first page view only; the full tier starts from the next page load.
- `packages/core/src/renderer.ts` requests `timestamp-query` whenever available (for the Stats profiler);
  its runtime cost was never measured.
- Water's 4x path borrows the resolved scene colour; Codex left its pixel/timing acceptance open.
- Earth, meadow and helmet pages build but were not run in a browser after the auto-quality change.
- Frame rates measured while background benchmarks run on the laptop are meaningless (integrated GPU shares
  the CPU's power budget).
