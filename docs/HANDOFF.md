# Margo Engine handoff

Last updated 2026-10-13. Read this first when starting a new session. Update it whenever work lands.

## Goal

Sell Margo as a modern replacement for three.js: looks good, runs smooth on PCs and phones, small, and
modular (load only the packages you use). Rules that follow from that:

- Core + stage (`@margoengine/core`, `margoengine`) stay feature-frozen and under 20,000 gzip bytes (CI gate).
  Scott will consider letting core grow for a significant improvement: bring him the numbers first.
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

## In progress

Five parallel workers went through 58 packages for CPU-side optimizations (baseline `f05414a`). Their edits are
UNCOMMITTED in the working tree, with proofs in `examples/package-benchmarks/proofs/`. Reported so far:

- Kept (need clean verification): taa, post (SSAO), creative (post), splats, animator, points, text, labels,
  ecs, navmesh, bvh, machinery (CAD parser). Geometry/procedural and file-format workers had not reported when
  this was written; `git status` shows their edits in geometry, procedural, terrain, wfc, splines, road,
  exporters, loaders, gltf, gltf-pro.
- Nothing worth changing: scatter, water, sky, shadows, vfx, clustered, dof, tonemap, environment, toon,
  transitions, stats, react, html, lines, selection, controls, input, cinematic, inspector, gizmo, audio,
  tween, net, navigation, physics. Skipped (need a browser): video, xr. Reverted: fsm.

To finish this step:

1. `npm run test:all` (rebuilds every package, runs about 810 unit tests). Two geometry triangulation tests
   time out when the machine is loaded; re-run them alone before treating that as a failure.
2. `npm run catalog:build` if any package's exports changed (the catalog test compares them).
3. Run each `examples/package-benchmarks/proofs/*.proof.js` one at a time on a quiet machine. Revert any change
   whose speed-up is under about 1.1x or whose output differs. Marginal ones flagged by workers: bvh
   `intersectsBox` and `closestPointToPoint`, navmesh ORCA, labels with an orbiting camera (parity).
4. Record gzip size before/after for each changed package; reject poor speed-for-bytes trades.
5. `npm run measure:size` must stay under 20,000. Commit.

## To do next, in order

1. Finish and commit the package pass above.
2. Demos, first impression: choose the quality tier before the first visible frame (quick GPU timing probe)
   so slow machines never show 10-15 slow seconds and a reload.
3. Light tier looks jagged (1x at DPR 1 on HiDPI). Measure a render scale between 1 and 2 and the optional
   TAA package; keep whichever holds 60.
4. Island at 60 FPS on the laptop with the full water. If short, test terrain mesh 192 -> 96 on the light tier
   (about 0.9 ms) and check the shoreline still lines up.
5. GPU-side optimization (shaders, particles, passes). Must be measured on hardware one change at a time;
   Codex's notes list tried and rejected ideas. Untested lead: VFX does one shared atomic increment per live
   particle (`docs/vfx-workgroup-compaction-2026-10-13.md`).
6. Fair three.js benchmark: check `examples/conveyor-simulator` and `examples/benchmark` are like-for-like.
7. Verified three.js parity matrix, then the feature gaps below.

## Feature gaps versus three.js (after optimization; each as an optional package)

From package descriptions, not yet audited against code:

- Custom materials and shaders (ShaderMaterial / node materials). Largest gap; material graphs stay out of core.
- Extended physical material: clearcoat, transmission, sheen, iridescence, anisotropy.
- Lights and shadows: area and hemisphere lights; point and spot light shadows (today: directional cascades).
- Post effects: screen-space reflections, FXAA or SMAA, motion blur, outline and god-ray passes.
- Scene utilities: decals, reflection probes and cube cameras, a level-of-detail object, an SVG loader.
- Browser reach: most packages are WebGPU-only; three's WebGL renderer runs without WebGPU. State this openly.

## Known issues and caveats

- The light tier is permanent per browser (`localStorage.margoLow`); a 50 Hz display or remote desktop also
  triggers it. Undo with `localStorage.removeItem('margoLow')`. No on-page control yet.
- `packages/core/src/renderer.ts` requests `timestamp-query` whenever available (for the Stats profiler);
  its runtime cost was never measured.
- Water's 4x path borrows the resolved scene colour; Codex left its pixel/timing acceptance open.
- Earth, meadow and helmet pages build but were not run in a browser after the auto-quality change.
- Two zero-byte junk files in the repo root, `({name` and `m[1])`, are safe to delete.
- Frame rates measured while background benchmarks run on the laptop are meaningless (integrated GPU shares
  the CPU's power budget).
