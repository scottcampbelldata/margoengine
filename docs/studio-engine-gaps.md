# Margo Voxel Studio engine gaps: engine handoff

2026-10-21. The 34 gap families of the Studio's `docs/engine-gaps.md` (Margo Voxel Studio, read only for this work),
implemented in the engine. Two states are kept apart throughout:

- **Engine implementation verified**: the engine API exists, is tested in the engine and, where the gap needs it, on
  the GPU. All 34 families are in this state (details per row).
- **Studio integration complete**: the Studio uses the API and its frozen code is gone. This is Codex's work; none of
  the 34 is integrated yet. The migration guide below says what to change.

Hardware for every GPU measurement: RTX A6000 (Ampere), Windows 11, Edge 155 headless, WebGPU on D3D12, under
`scripts/gpu-lock.mjs`. No MagicaVoxel program files, renders or saved files were used or committed.

## Where the work is

| Group | Families | Packages | Branch and commits | Pushed |
| --- | --- | --- | --- | --- |
| A | 1-7 | voxel-pathtracer | main, after `f5019cf8`: `bb841e87` (1), `d97f9571` (5, 6, 7), `1ad7761a` (4), `ca109363` (2), `65be98fc` (3), `d2ddb275` (records), then this document | yes, 2026-10-21 |
| B | 8, 9, 10, 12, 23, 27-34 | voxel-edit | `claude/pensive-albattani-f68586`, on `e1c7aefa`: `2af9a0b3`, `b795b0bc`, `745627da`, `92118a83`, `7729f040`, `b6d3ef26`, `996d9a3a`, `d801ce44`, `3e53d978`, `ad195a33` | no |
| C | 11, 13, 14, 15, 16 | voxel (`./vox`), math, animation | `claude/frosty-cerf-0df80c`, on `e1c7aefa`: `5554bbc0`, `d2e947ed`, `88c0d0cd`, `c9e2d3fe` | no |
| D | 17-21, 25 | exporters | main: `e11bd16e`, `cf9e57d2`, `a1463c77`, `cd9ffe72`, `aefcdfd7`, `3f89ce28` | yes, 2026-10-21 |
| E | 22, 24, 26 | environment, shader, procedural | main: `71b95fd1`, `d55f1b41`, `ed7c1ba6`, `0ceb970a` | yes, 2026-10-21 |

Every commit is authored and committed as the noreply address. Branches B and C are based on `e1c7aefa`; when they
land they conflict only in the shared records (`docs/api-surface.md` totals, `docs/catalog.json`,
`examples/package-benchmarks/results/entry-sizes.json`): keep both sides' rows and regenerate with `npm run
api:update`. Core + stage stays 21,343 B gzip on every branch (limit 25,000).

## Status of the 34 families

| # | Family | Engine package | Engine implementation | Commit | Public API | Studio integration |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Denoiser quality acceptance | voxel-pathtracer | Verified: the Studio's unchanged benchmark passes 72/72 (was 60/72) on this build, served tracer body hash checked; engine browser check | `bb841e87` | (behaviour; no API) | pending |
| 2 | Model-local material tables | voxel-pathtracer | Verified (node + GPU): 300 distinct materials; own tables render bit-identically to one table | `ca109363` | `TraceModel.materials` | pending |
| 3 | Large dense and sparse tracer models | voxel-pathtracer | Verified (node + GPU): up to 2048 per axis; sparse `blocks`; one 400-cell glass bar equals the stretched reference, tiles do not | `65be98fc` | `TraceModel.size` to 2048, `TraceModel.blocks`, `TraceModelBlock` | pending |
| 4 | Native 4K viewport and storage limits | voxel-pathtracer | Verified (GPU): 3840 x 2160 traced natively with the default limits, raw and denoised | `1ad7761a` | `traceViewportSize`, `stats.requestedWidth/requestedHeight/limitedBy`, types `TraceViewportLimits`, `TraceViewportSize` | pending |
| 5 | Defaults, validation and reset | voxel-pathtracer | Verified (node) | `d97f9571` | `VOXEL_PATHTRACER_DEFAULTS`, `resolveTraceOptions`, `validateTraceOptions`, `resolveTraceMaterial`, `validateTraceMaterial`, `tracer.resetOptions`, `focusDistance: null`, types `ResolvedTraceOptions`, `ResolvedTraceMaterial`, `TraceValidation`, `TraceProblem` | pending |
| 6 | Geometry cache identity | voxel-pathtracer | Verified (node) | `d97f9571` | `TraceModel.contentKey`, `tracer.invalidateModels`, `stats.packedModels/reusedModels` | pending |
| 7 | Capture abort and GPU drain | voxel-pathtracer | Verified (node + GPU: drained 0.4 ms after an abort) | `d97f9571` | `tracer.whenIdle()`, `stats.renders` | pending |
| 8 | Sparse coordinate envelope | voxel-edit `./sparse` | Verified (node; live check against the Studio's code) | `2af9a0b3` | `SparseOptions.envelope: 'wide'`, `SparseGridData.version 2` | pending |
| 9 | Sparse worker transfer | voxel-edit `./sparse` | Verified (node) | `2af9a0b3` | `snapshot`, `fromSnapshot`, `deltaSnapshot`, `applyDeltaSnapshot`, `restoreSnapshots`, `snapshotBuffers` | pending |
| 10 | Raster geometry batch ceiling | voxel-edit `./mesh` | Verified (node; identical to the Studio's batches incl. a 200,000 + 131,776 split) | `b795b0bc` | `partitionMesh` | pending |
| 11 | Typed VOX render dictionaries | voxel `./vox` | Verified (node; 300+ corrupted variants) | `88c0d0cd` | `readVoxRenderDictionaries` | pending |
| 12 | Odd rotated VOX box centering, frame instances | voxel-edit `./vox` | Verified (node; 1,230 instances identical to the Studio's resolver; [3,5,7] box X = 2) | `745627da` | `resolveVoxScene` (`'box-v1'`, `'pivot-v1'`), `voxFrameRange` | pending |
| 13 | Affine decomposition with shear | math `./affine` | Verified (node; 1,000 matrices) | `5554bbc0` | `decomposeAffine` | pending |
| 14 | Saved quaternion interpolation | math `./quat` | Verified (node; bit for bit, 2,000 pairs + the close-angle fixture) | `5554bbc0` | `interpolateQuaternions(a, b, t, 0.9995)` | pending |
| 15 | Saved vector-track arithmetic | animation | Verified (node; bit for bit, ±1e308 keys) | `d2e947ed` | `KeyframeTrackData.blend: 'weighted'` | pending |
| 16 | Homogeneous projection validation | math `./mat4` | Verified (node; 2,000 matrices) | `5554bbc0` | `transformPointChecked` | pending |
| 17 | Static GLB writer | exporters | Verified (Godot headless 85/85 configured, 83/85 vanilla, as the Studio's baseline; Khronos validator 0 errors) | `e11bd16e` | `ExportNode.primitives`, extras, occlusion/emissive textures, transmission, IOR, emissive strength, `paletteTexture` | pending |
| 18 | Animated GLB writer | exporters | Verified (Godot 62/62 compatibility, 46/62 standard as baseline; 5 cel frames) | `cf9e57d2` | `frameTimes`, `sampleFrames`, `animateTransforms`, `animateCels`, `animatePlacements` | pending |
| 19 | Collision augmentation writer | exporters | Verified (1,562/1,562 imported, 770/770 saved) | `a1463c77` | `splitGLB`, `joinGLB`, `appendGLBMeshes` | pending |
| 20 | Baked PBR/lightmap writer | exporters | Verified (Godot 13/13 bindings) | `e11bd16e` | `ExportScene.lightmap` (`LightmapData`) | pending |
| 21 | Sprite atlases, sequences, ZIP | exporters `./capture` | Verified (node) | `cd9ffe72` | `spriteAtlasLayout`, `packSpriteAtlas`, `encodeZIP`, `encodeSequenceZIP`, `encodeAtlasZIP` | pending |
| 22 | Radiance HDR decoding | environment | Verified (node; 42,000 files, 0 differ) | `71b95fd1` | `parseHDR(bytes, {channels, orientation, requireFormat, limits})` | pending |
| 23 | Owned grid/delta byte estimates | voxel-edit | Verified (node) | `92118a83` | `ByteLedger`, `ownedBuffers`, `retainedBytes`, `grid.ownedBuffers`, `SparseGrid.deltaBuffers` | pending |
| 24 | Compute readback, device-loss lifecycle | shader `./readback` | Verified (node + GPU: 4,194,304 values exact; abort, disposal, device loss) | `d55f1b41` | `computeReadback` | pending |
| 25 | Skin weights and bind matrices | exporters `./skin` | Verified (node; Godot rig checks) | `aefcdfd7` | `checkJoints`, `skinWeights`, `skinBindMatrices`, `skinHierarchy`, `humanoidJoints` | pending |
| 26 | Voxel expression/noise interpreter | procedural `./expression` | Verified (node; 15,000 programs identical) | `ed7c1ba6` | `runVoxelExpression`, `compileVoxelExpression`, `validateVoxelExpressionInput`, `VoxelExpressionError`, limits | pending |
| 27 | Flips, quarter turns, clipped translation | voxel-edit | Verified (node; the Studio's kernel as oracle) | `7729f040`, `b6d3ef26` | `flipGrid`, `turnGrid`, `shiftGrid`, `GridLayout` | pending |
| 28 | Crop, resize, shrink, occupied bounds | voxel-edit | Verified (node) | `7729f040` | `cropGrid`, `fitGrid`, `occupiedBounds` | pending |
| 29 | Indexed occupancy inversion | voxel-edit | Verified (node) | `7729f040` | `invertGrid` | pending |
| 30 | Clipboard palette remapping | voxel-edit `./edit` | Verified (node) | `996d9a3a` | `pasteCells` (`PastePlan`, `PasteOverflow`) | pending |
| 31 | Mirrored brush stamping | voxel-edit `./edit` | Verified (node) | `996d9a3a` | `mirrorCells`, `stampCells` | pending |
| 32 | Sprite-slice stacking | voxel-edit | Verified (node; 120 sheets identical to the Studio's) | `d801ce44` | `sliceLayout`, `stackSlices` | pending |
| 33 | Indexed procedural rasterizers | voxel-edit `./edit` | Verified (node) | `3e53d978` | `ellipsoidCells`, `cylinderCells`, `ringCells`, `thickLineCells`, `taperedLineCells` | pending |
| 34 | Large VOX scene partitioning | voxel-edit `./vox` | Verified (node; 9 dense + 6 sparse tiles identical) | `b795b0bc` | `voxTiles` | pending |

Exporter checks in Godot are headless imports (scene, resource and animation checks), not rendered-pixel proof.

## Denoiser: all 72 gates before and after

The Studio's benchmark, unchanged (`scripts/check-denoiser.mjs` and its fixtures, run from an isolated copy of the app
with only the candidate tracer swapped into `node_modules`): 96 x 72, 4/16/64 samples, seeds 101, 7919 and 65537,
65,536-sample references checked against independent 4,096-sample renders, linear and log(1 + x) RMSE, limits all and
flat 1.00, geometry and texture edges 1.03. The browser loaded the candidate build (served body hash compared with the
installed one). Ratio = denoised / raw RMSE, mean over the three seeds; lower is better.

| Scene | Samples | Region | Metric | Before | After | Limit | Before | After |
| --- | ---: | --- | --- | ---: | ---: | ---: | --- | --- |
| diffuse-detail | 4 | all | linear | 0.8106 | 0.8077 | 1.00 | pass | pass |
| diffuse-detail | 4 | all | log | 0.8178 | 0.8148 | 1.00 | pass | pass |
| diffuse-detail | 4 | flat | linear | 0.2276 | 0.2275 | 1.00 | pass | pass |
| diffuse-detail | 4 | flat | log | 0.2280 | 0.2279 | 1.00 | pass | pass |
| diffuse-detail | 4 | geometry edge | linear | 0.8853 | 0.8814 | 1.03 | pass | pass |
| diffuse-detail | 4 | geometry edge | log | 0.8967 | 0.8926 | 1.03 | pass | pass |
| diffuse-detail | 4 | texture edge | linear | 0.9088 | 0.9082 | 1.03 | pass | pass |
| diffuse-detail | 4 | texture edge | log | 0.9253 | 0.9247 | 1.03 | pass | pass |
| diffuse-detail | 16 | all | linear | 0.8771 | 0.8213 | 1.00 | pass | pass |
| diffuse-detail | 16 | all | log | 0.8750 | 0.8192 | 1.00 | pass | pass |
| diffuse-detail | 16 | flat | linear | 0.3198 | 0.3197 | 1.00 | pass | pass |
| diffuse-detail | 16 | flat | log | 0.3204 | 0.3202 | 1.00 | pass | pass |
| diffuse-detail | 16 | geometry edge | linear | 0.9560 | 0.8832 | 1.03 | pass | pass |
| diffuse-detail | 16 | geometry edge | log | 0.9571 | 0.8823 | 1.03 | pass | pass |
| diffuse-detail | 16 | texture edge | linear | 0.9587 | 0.9357 | 1.03 | pass | pass |
| diffuse-detail | 16 | texture edge | log | 0.9647 | 0.9440 | 1.03 | pass | pass |
| diffuse-detail | 64 | all | linear | 0.9548 | 0.8856 | 1.00 | pass | pass |
| diffuse-detail | 64 | all | log | 0.9529 | 0.8825 | 1.00 | pass | pass |
| diffuse-detail | 64 | flat | linear | 0.4530 | 0.4529 | 1.00 | pass | pass |
| diffuse-detail | 64 | flat | log | 0.4528 | 0.4528 | 1.00 | pass | pass |
| diffuse-detail | 64 | geometry edge | linear | 1.0364 | 0.9475 | 1.03 | **fail** | pass |
| diffuse-detail | 64 | geometry edge | log | 1.0390 | 0.9461 | 1.03 | **fail** | pass |
| diffuse-detail | 64 | texture edge | linear | 1.0227 | 0.9849 | 1.03 | pass | pass |
| diffuse-detail | 64 | texture edge | log | 1.0233 | 0.9890 | 1.03 | pass | pass |
| metal-glass | 4 | all | linear | 0.5361 | 0.5361 | 1.00 | pass | pass |
| metal-glass | 4 | all | log | 0.6693 | 0.6696 | 1.00 | pass | pass |
| metal-glass | 4 | flat | linear | 0.2662 | 0.2660 | 1.00 | pass | pass |
| metal-glass | 4 | flat | log | 0.2802 | 0.2800 | 1.00 | pass | pass |
| metal-glass | 4 | geometry edge | linear | 0.7143 | 0.7132 | 1.03 | pass | pass |
| metal-glass | 4 | geometry edge | log | 0.7623 | 0.7614 | 1.03 | pass | pass |
| metal-glass | 4 | texture edge | linear | 0.6025 | 0.6052 | 1.03 | pass | pass |
| metal-glass | 4 | texture edge | log | 0.7234 | 0.7274 | 1.03 | pass | pass |
| metal-glass | 16 | all | linear | 0.6717 | 0.6418 | 1.00 | pass | pass |
| metal-glass | 16 | all | log | 0.7433 | 0.7086 | 1.00 | pass | pass |
| metal-glass | 16 | flat | linear | 0.3632 | 0.3625 | 1.00 | pass | pass |
| metal-glass | 16 | flat | log | 0.3752 | 0.3745 | 1.00 | pass | pass |
| metal-glass | 16 | geometry edge | linear | 0.8492 | 0.8037 | 1.03 | pass | pass |
| metal-glass | 16 | geometry edge | log | 0.8657 | 0.8145 | 1.03 | pass | pass |
| metal-glass | 16 | texture edge | linear | 0.5755 | 0.5674 | 1.03 | pass | pass |
| metal-glass | 16 | texture edge | log | 0.6488 | 0.6436 | 1.03 | pass | pass |
| metal-glass | 64 | all | linear | 0.3396 | 0.3118 | 1.00 | pass | pass |
| metal-glass | 64 | all | log | 0.6154 | 0.5373 | 1.00 | pass | pass |
| metal-glass | 64 | flat | linear | 0.3575 | 0.3572 | 1.00 | pass | pass |
| metal-glass | 64 | flat | log | 0.4340 | 0.4337 | 1.00 | pass | pass |
| metal-glass | 64 | geometry edge | linear | 0.7598 | 0.6725 | 1.03 | pass | pass |
| metal-glass | 64 | geometry edge | log | 0.8886 | 0.7744 | 1.03 | pass | pass |
| metal-glass | 64 | texture edge | linear | 1.0318 | 0.7477 | 1.03 | **fail** | pass |
| metal-glass | 64 | texture edge | log | 1.1018 | 0.8002 | 1.03 | **fail** | pass |
| emissive-glass | 4 | all | linear | 0.9548 | 0.9061 | 1.00 | pass | pass |
| emissive-glass | 4 | all | log | 0.8753 | 0.7896 | 1.00 | pass | pass |
| emissive-glass | 4 | flat | linear | 0.2256 | 0.1773 | 1.00 | pass | pass |
| emissive-glass | 4 | flat | log | 0.2840 | 0.2144 | 1.00 | pass | pass |
| emissive-glass | 4 | geometry edge | linear | 1.0058 | 0.9559 | 1.03 | pass | pass |
| emissive-glass | 4 | geometry edge | log | 1.0486 | 0.9493 | 1.03 | **fail** | pass |
| emissive-glass | 4 | texture edge | linear | 0.9750 | 0.8836 | 1.03 | pass | pass |
| emissive-glass | 4 | texture edge | log | 0.7175 | 0.6172 | 1.03 | pass | pass |
| emissive-glass | 16 | all | linear | 1.0877 | 0.9340 | 1.00 | **fail** | pass |
| emissive-glass | 16 | all | log | 0.9674 | 0.7502 | 1.00 | pass | pass |
| emissive-glass | 16 | flat | linear | 0.2865 | 0.2485 | 1.00 | pass | pass |
| emissive-glass | 16 | flat | log | 0.3046 | 0.2568 | 1.00 | pass | pass |
| emissive-glass | 16 | geometry edge | linear | 1.1711 | 0.9872 | 1.03 | **fail** | pass |
| emissive-glass | 16 | geometry edge | log | 1.1870 | 0.9018 | 1.03 | **fail** | pass |
| emissive-glass | 16 | texture edge | linear | 0.9705 | 0.9283 | 1.03 | pass | pass |
| emissive-glass | 16 | texture edge | log | 0.7709 | 0.6740 | 1.03 | pass | pass |
| emissive-glass | 64 | all | linear | 1.0621 | 0.9152 | 1.00 | **fail** | pass |
| emissive-glass | 64 | all | log | 0.9786 | 0.7541 | 1.00 | pass | pass |
| emissive-glass | 64 | flat | linear | 0.3984 | 0.3798 | 1.00 | pass | pass |
| emissive-glass | 64 | flat | log | 0.3744 | 0.3533 | 1.00 | pass | pass |
| emissive-glass | 64 | geometry edge | linear | 1.1131 | 0.9495 | 1.03 | **fail** | pass |
| emissive-glass | 64 | geometry edge | log | 1.1649 | 0.8756 | 1.03 | **fail** | pass |
| emissive-glass | 64 | texture edge | linear | 1.0556 | 0.9451 | 1.03 | **fail** | pass |
| emissive-glass | 64 | texture edge | log | 0.7983 | 0.6596 | 1.03 | pass | pass |

Passed: before 60 of 72, after 72 of 72.

Timings of the final run, per scene:

| Scene | Reference (65,536 spp) ms | Independent check (4,096 spp) ms | Raw / denoised ms per run (mean) | Reference vs check RMSE (linear / log) |
| --- | ---: | ---: | --- | --- |
| diffuse-detail | 13919 | 856 | 9.2 / 9.4 | 0.00111 / 0.00090 |
| metal-glass | 18163 | 1146 | 10.8 / 11.3 | 0.02000 / 0.01512 |
| emissive-glass | 16480 | 1043 | 10.2 / 10.4 | 0.00460 / 0.00223 |

Every run also passed the benchmark's validation: dimensions, finite and non-negative pixels, AOVs equal for the same
seed, repeated seeds deterministic, no browser errors. The denoiser adds no GPU memory (the benchmark does not record
memory; the engine's timing check measured 348.4 MiB for the denoised 1080p material scene before and after). The
ratios on the final build (`75dac655`) are identical to the first 72/72 run (`6c312e93`, the denoiser commit alone).

What changed in the filter (`packages/voxel-pathtracer/src/shaders.ts`, `DENOISE`):

- The regular chain's wide wavelet levels also stop on the ratio of two luminances, so a wall beside a light keeps its
  level (engine check `denoisepeak`: 0.883 -> 0.912 of the reference at 16 samples, RMSE 0.110 -> 0.075).
- At geometry, material and texture edges, from 16 samples on, the filtered estimate is weighed against the raw mean
  by their estimated squared errors (the filtered one's including the bias its differences from the raw means show
  over 3 x 3), in the manner of Rousselle et al. 2012. Edges no longer blur detail the samples resolve.
- Nothing was relaxed or special-cased: same thresholds, fixtures and reference quality; denoising stays on.
- Engine browser check (480 x 300 scenes against 16,384-sample references): error factors kept or improved at 4, 16
  and 64 samples (diffuse x2.79/x2.64/x2.32, materials x2.44/x2.31/x2.30, caustics x2.23/x2.10/x2.08); object edges
  no worse than raw at 16 and 64 samples in all four scenes (now asserted). At 1024 samples edges of three scenes are
  2.5-4.7% worse than the previous filter (still 26-36% better than raw).
- Moving-camera history (new check `denoisehistory`): RMS 5.31 against the converged image, raw frames 16.00, still
  camera 2.78; the previous filter gave 5.32.
- Cost: 0.2-0.6 ms per denoised 1080p frame, no memory.

## Tests and checks

| Branch | Checks (measured on that branch) |
| --- | --- |
| A main, after `f5019cf8` | `npm run verify` exit 0 on this tree: 3,359/3,359 node tests, API reports match (209 entries, 2,380 names), core + stage 21,343 B, proofs `--current` 20/20. `npm run check:merge` exit 0 (3,348/3,348, site build, visual check 62/62 views) on the same commits over `0ceb970a`, before main's four exporter fixes. voxel-pathtracer: 69/69 node tests (17 new); real-GPU browser check passed (every scenario, including the new `denoisepeak`, `denoisehistory`, `materialtables`, `largemodels`, `native4k`); hygiene 10.0 on all eight gates. Studio denoiser benchmark 72/72 on this tracer build (`75dac655`, unchanged by the rebase). |
| B `claude/pensive-albattani-f68586` | `npm run verify` exit 0: 3,317/3,317, proofs 20/20; voxel-edit 108/108 (was 67); hygiene voxel-edit 0 violations; live checks against the Studio's own files (read only). |
| C `claude/frosty-cerf-0df80c` | `npm run verify` exit 0: 3,288/3,288, proofs 20/20; math, animation and voxel hygiene unchanged. |
| D main `3f89ce28` | `npm run verify` exit 0: 3,300/3,300, proofs 20/20; Godot (headless) and Khronos validator results in the table above; 75/84 of the app's own unit tests for the replaced files pass on the candidates, the 9 others assert exact JSON representations (listed in the guide). |
| E (main `0ceb970a`; branch `claude/agitated-saha-b701b2`) | `npm run verify` exit 0: 3,305/3,305, proofs 20/20; `build:site`; visual check 62/62; readback real-GPU check passed. |

The branch totals overlap (each counts main's tests); they are not a sum.

## Behaviour changes and saved-data compatibility

Group A (voxel-pathtracer). No saved-data format is read or written by the tracer; saved scenes produce the same
`VoxelTraceScene` and pack to byte-identical GPU tables (A/B of all 14 uploaded buffers after the option and material
refactor; model tables render bit for bit as one table).

- Denoised images differ from the previous build: that is the fix (72/72). Undenoised images are unchanged (every
  other engine browser result identical run to run).
- `tracer.options` returns a copy; nested objects can no longer be changed through it.
- `setOptions({focusDistance: null})` is accepted (automatic focus); it used to throw. Leaving a field out still keeps
  the current value.
- `stats` has new fields: `requestedWidth`, `requestedHeight`, `limitedBy`, `packedModels`, `reusedModels`,
  `renders`; `gpuBytes` counts the denoiser's history textures.
- A denoised viewport larger than about 2.8 million pixels is now traced at its full size instead of a reduced one:
  more memory and time (3840 x 2160 denoised: 1,392.5 MiB, 113-115 ms per frame on the A6000).
- Model sizes up to 2048 per axis are accepted (were refused above 256). `TraceModel.voxels` is optional in the type
  (`blocks` is the alternative), so TypeScript code reading it must handle `undefined`.
- The light tables share one storage binding with the scene records and block textures: a scene whose emissive faces,
  environment tables, records and textures together exceed the binding (128 MiB by default) is refused with the sizes.
- The first scene with model material tables compiles a second variant of the tracing kernels (the viewport shows the
  raster frame until it is ready; captures wait for it).

Groups B-E: see the sessions' notes for every difference (summarised in the guide below). The saved formats the
Studio's `current-main-formats.test.ts` pins are covered: sparse v1 loads unchanged and wide-envelope grids save as
sparse version 2 (older builds refuse them); packed animation v1 frames resolve to identical instances; the odd rotated
[3, 5, 7] box keeps X = 2 (`'box-v1'`); close-angle slerp is bit for bit (`interpolateQuaternions(..., 0.9995)`);
extreme finite vector tracks stay finite (`blend: 'weighted'`); checked projection refuses what the Studio refuses and
also non-finite divided points.

## Migration guide for Codex (Studio files; the app was not edited)

Vendor a build that contains the commits above, then per family:

| # | Studio file | Change | Keep in the app |
| --- | --- | --- | --- |
| 1 | `src/viewport/viewport.ts` | Nothing to change; rerun `scripts/check-denoiser.mjs` on the vendored build (72/72 expected) and refresh `test-results/engine-upgrade` | |
| 2 | `src/viewport/renderer-bridge.ts` | Drop the refusal above 255 identities: give each bank's `TraceModel` its own `materials` (the bank palette mapped to `TraceMaterial`) instead of `mergePalettes`/`combineGrids`; equal tables are stored once | refusal text only for the engine's RangeError (over 4096 tables or the binding) |
| 3 | `src/viewport/renderer-bridge.ts` (`tileModel`) | Pass models up to 2048 per axis whole; pass sparse models as `blocks` (one per non-empty `SparseGrid` window or chunk); tile only past 2048 or when the engine refuses the brick grid | memory accounting policy |
| 4 | `src/viewport/viewport.ts`, `src/viewport/renderer-bridge.ts` | Delete the 48/16 bytes-per-pixel budget; predict with `traceViewportSize(w, h, device.limits, {resolutionScale, denoise})`, report `stats.width/height` against `stats.requestedWidth/requestedHeight` and `stats.limitedBy` | |
| 5 | `src/editor/render-settings.ts`, `src/viewport/viewport.ts` | Validate with `validateTraceOptions` (all problems at once) and resolve with `resolveTraceOptions`/`VOXEL_PATHTRACER_DEFAULTS`; on a preset change call `tracer.resetOptions(namesThePresetOmits)`; automatic focus is `setOptions({focusDistance: null})` | saved-shape and version checks; `materialPhysicalDefaults` in `src/editor/materials.ts` (saved-bank identity: compare with `resolveTraceMaterial`, do not replace) |
| 6 | `src/viewport/renderer-bridge.ts` | Give every `TraceModel` a `contentKey` (the immutable buffer object, or a content hash per cel/tile); call `tracer.invalidateModels(ids)` on workspace close or reopen | workspace ownership, cache clearing policy |
| 7 | `src/viewport/viewport.ts` | When a capture promise settles its buffers are released; `await tracer.whenIdle()` where the old code inferred `outputBusy`; `stats.renders` counts queued and running captures | cancellation ownership |
| 8 | `src/editor/sparse-volume.ts` | Drop the -32768 origin trick and envelope refusal: `new SparseGrid({envelope: 'wide'})` | app adapters |
| 9 | `src/editor/document-transfer.ts` | `snapshot()` + `snapshotBuffers` transfer list; `restoreSnapshots({maxBytes: 134217728})` | |
| 10 | `src/viewport/scene-preview.ts` | `partitionMesh(source, {maxQuads: 200_000})` replaces the batching loop | |
| 11 | `src/editor/render-look.ts` (lines 10-46) and its test | `readVoxRenderDictionaries(scene)`; map `diagnostics` to the app's unsupported strings | raw chunks; UI for diagnostics |
| 12 | `src/editor/vox-scene.ts` | `resolveVoxScene({centering: 'box-v1'})`, `voxFrameRange` | bank mapping, name fallback, native instances |
| 13 | `src/io/glb-animation.ts` (`matrixPose`) | `decomposeAffine(m)`; throw unless `lossless` | |
| 14 | `src/editor/animation.ts` (`slerpQuaternion`) | `interpolateQuaternions(a, b, t, 0.9995)` | |
| 15 | `src/editor/animation.ts` (`evaluateDocument` vector arithmetic) | tracks with `blend: 'weighted'` through `createKeyframeClip` and `sampleKeyframes`, cached per animation | `heldIndex` (geometry cels) |
| 16 | `src/editor/scene.ts` (`transformPoint`) | `transformPointChecked(matrix, point)`; throw the app's RangeError when not `ok` | |
| 17 | `src/io/glb.ts` | Replace the serializer with the session D candidate file | document mapping, palette atlas choice, collision box, Godot motion nodes |
| 18 | `src/io/glb-animation.ts` | `animateTransforms`/`animateCels`/`animatePlacements` replace parse/encode/accessor code | document expansion |
| 19 | `src/io/glb-collisions.ts` | `splitGLB`/`joinGLB`/`appendGLBMeshes` (file shrinks to about 20 lines) | Godot suffix naming |
| 20 | `src/io/bake-output.ts` | `ExportScene.lightmap` + `encodeZIP` replace `buildGLB` | bundle composition, README, Godot shader |
| 21 | `src/io/render-output.ts` | `packSpriteAtlas`, `encodeZIP`/`encodeSequenceZIP`/`encodeAtlasZIP` | blob decoding, app limits, manifest fields |
| 22 | `src/io/hdr.ts` | `parseHDR(bytes, {channels: 3, orientation: 'all', requireFormat: true, limits: {...}})`, then `validateEnvironmentMap` | the 1e30 radiance cap |
| 23 | `src/editor/document.ts`, `src/editor/animation.ts` | `ByteLedger` (retain/release per history entry) replaces the byte estimates | `history.ts` policy |
| 24 | `src/viewport/margo-shader.ts`, `src/viewport/margo-shader-device.ts` (+ test) | `computeReadback(engine, cells, body, output, {signal, workgroupSize: 128, name})`; dispose storage in `finally` | input validation, active guard, storage-limit and stale-document checks |
| 25 | `src/editor/rigging.ts` | `skinWeights`, `skinBindMatrices`, `humanoidJoints` (session D candidate file) | 256-joint and volume rules |
| 26 | `src/editor/voxel-program.ts` | `runVoxelExpression`/`compileVoxelExpression`/`validateVoxelExpressionInput`/`VoxelExpressionError`; the worker must serialize `code` and rebuild `new VoxelExpressionError(code, detail, line, column)` | presets (already moved to `voxel-program-presets.ts`) |
| 27 | `src/editor/document.ts` (`transformModel`) | `flipGrid`/`turnGrid`/`shiftGrid` with `selection` and `mapPoint` | crop-compensation pose maths |
| 28 | `resizeModel`/`shrinkModel`, `types.ts` `modelBounds` | `cropGrid`/`fitGrid`/`occupiedBounds` | `clippedPivot`, the empty-model rule |
| 29 | `invertModel` | `invertGrid` | |
| 30 | `pasteAt` | `pasteCells`; map `{status: 'overflow'}` to the existing message | |
| 31 | `applyCells`/`faceStroke` mirroring | `mirrorCells`, `stampCells` | |
| 32 | `src/ingest/slices.ts` | `sliceLayout`, `stackSlices` | 1,024-per-axis rule, document creation |
| 33 | `mechanical-kit.ts`, `skyforge-citadel.ts`, `nature-sculpt.ts` helpers | `ellipsoidCells`, `cylinderCells`, `ringCells`, `thickLineCells`, `taperedLineCells` | colours |
| 34 | `src/io/vox-sparse.ts` | `voxTiles` | naming, parent wrapper, refusals |

Stricter or different engine behaviour Codex must expect (from sessions B-E): `mirrorCells` throws on non-integer
samples; layout operations throw on selections outside the grid; `clipped` is a count; `pasteCells` returns
`'overflow'` instead of throwing; `voxTiles` returns `[]` for an empty grid; `resolveVoxScene` returns every shape and
`[]` for a scene without nodes; `stackSlices` returns an RGBA byte palette; VOX dictionaries decode non-UTF-8 text as
windows-1252 and mark repeated keys malformed; `transformPointChecked` also refuses non-finite divided points; the GLB
writer omits default translations, writes Float32 factors, numbers textures by first use, and adds normals to
position-only meshes; HDR, readback and expression errors are `MargoError`/`TypeError`/`RangeError` with new messages
(the app's test regexes match); readback and expression aborts reject with `signal.reason`.

## Build hashes and commands

| What | Value |
| --- | --- |
| Source commit (group A, records) | `d2ddb275edb116a52bba33b0481426dc5246c128` |
| `packages/voxel-pathtracer/dist/index.js` sha256 (built from it) | `75dac655bfc4d308c0bea33db32842862a92608f7e482b7e9acfb79cd1213a48` |
| Body the Studio's dev server served (Vite prebundle of that build) | `090d03104d6127a54596a78ffe5724a1dde2f737dcf335414ba9ff7eaf86b986` |
| Baseline tracer (main `e1c7aefa`, the 60/72 run) | `e337fb6f3d44a3cabb15b89887d3dd7ba863830174090e1e506e6949e11e6f0d`, served `6dd59f7942bb03e9a60b370701539cc04b9e8fb7587f476669465b4b93bd6c13` |
| voxel-pathtracer entry size | 58,290 -> 63,890 B gzip; core + stage 21,343 B (limit 25,000) |

Evidence files (git-ignored, in the group A worktree): `test-results/studio-gaps/` holds both benchmark reports with
their images, the gate tables, the engine browser-check logs and the timing A/B runs.

Commands (from the engine worktree, GPU work under the lock):

```
npm run check:merge
node scripts/gpu-lock.mjs run --owner=<you> -- node packages/voxel-pathtracer/tests/browser-check.mjs
node scripts/gpu-lock.mjs run --owner=<you> -- node packages/voxel-pathtracer/tests/browser-check.mjs timing native4k
```

The Studio benchmark ran from a scratch copy of the app (its `node_modules` linked to the app's installed packages
except `@margoengine/voxel-pathtracer`, a copy of this build's `package.json` and `dist`), with `vite` serving it on a
free port and the app's own `scripts/check-denoiser.mjs` and `scripts/verify-served-tracer.mjs` unchanged.
