# Why three.js matched or beat Margo on GPU time for static boxes

**Diagnostic, busy machine, not for publication.** Every number below comes from runs on a laptop that other agents
were using for builds (CPU load at each run's start is in the JSON, 0-91%). GPU timestamps are less sensitive to CPU
load than frame rates, the variants alternated within every round and the order rotated between rounds, and only
ratios between variants of the same run are used. Do not quote these numbers as engine performance.

Machine: Intel Core Ultra 7 258V, Intel Arc 140V (Xe2), driver 32.0.101.8860, Edge 155 headless, 1280x720, DPR 1,
4x MSAA, AC power before and after every run, GPU lock held. Harness: `examples/package-benchmarks/vs-threejs`.
Raw JSON: `examples/package-benchmarks/results/vs-threejs-boxes-{diag1,diag2,proto,fps}.json` (per-run `resources`
lists stripped). Reproduce: `node examples/package-benchmarks/vs-threejs/run.mjs --busy --rounds=3 --frames=120
--only=boxes:1000,boxes:10000,boxes:50000,cad:50000 --variants=margo,margo+double,margo+cull,margo+plugin,margo+pass,three-webgpu-instanced,three-webgl-instanced`.
No round overlapped another agent's GPU run: the stray transparency check ran under a lock this worker had taken at
20:40 and released, without measuring, when the quiet gate kept it waiting; `diag1` took the lock afterwards.

## Update 2026-10-15: fix B is in core; like-for-like pairs

Scott approved fix B (below). Core `d96e2d7` draws a geometry batch with a second, back-culled pipeline whose shader has
no `discard` when every drawn instance is single-sided and unmirrored; core + stage 19,577 -> **19,793 B** gzip (+216).
Frames are unchanged: `examples/package-benchmarks/cad/cull-pixels.mjs` renders a mixed scene (single-sided closed
boxes, open shells showing their inner back faces, a mirrored instance, double-sided parts, `material.set({doubleSided})`
both ways, material assignment, hide/show) in the pre-change core (`dc0c4ff`) and the new one: 0 of 153,600 pixels differ
in all 13 steps; `pixels-check.mjs` and `npm run visual:check` (22 views) pass. In the run below, `margo` and
`margo+nocull` (the new core with its culled pipeline turned back into cull none + discard = the old GPU work) have
identical t = 0 frames in all four box scenes.

The harness also compared three's `InstancedMesh` with Margo core meshes (50,000 entities against one object holding
50,000 matrices). It now pairs **mesh <-> mesh** (Margo core meshes, three `Mesh` per box) and **instanced <->
instanced** (`@margoengine/materials` `createInstancedMesh` and `@margoengine/culling` `CulledInstances` against three
`InstancedMesh`); see the harness README for what each variant does and its asymmetries.

Run (`results/vs-threejs-boxes-pairs.json`, diagnostic, busy machine: CPU load at run starts 0-90%, 2 alternating
rounds x 120 frames, at `ef2fb0c`, the pre-rebase hash of `fbe2ce3`): `node examples/package-benchmarks/vs-threejs/run.mjs --busy --rounds=2 --frames=120
--only=boxes:1000,boxes:10000,boxes:50000,boxes:10000:moving --variants=margo,margo+nocull,margo-instanced,margo-culled,three-webgl,three-webgpu,three-webgl-instanced,three-webgpu-instanced`.
Cells: FPS (frames finished by the GPU per second) / CPU ms per frame / GPU ms per frame / serial frame ms; draws in the
variant column.

GPU win of fix B (same run, `margo+nocull` -> `margo`): 1k 1.64 -> 0.46 ms (3.6x), 10k 5.00 -> 1.80 (2.8x), 50k
10.87 -> 6.00 (1.8x), 10k moving 5.30 -> 1.79 (3.0x); FPS 448 -> 788, 189 -> 326, 75 -> 101, 145 -> 155.

**Mesh <-> mesh** (one scene object per box)

| Variant | 1k | 10k | 50k | 10k moving |
| --- | --- | --- | --- | --- |
| Margo core meshes (1 draw) | **788** / 0.29 / 0.46 / 4.9 | **326** / 2.1 / 1.80 / 9.2 | **101** / 8.7 / 6.00 / 20.2 | **155** / 5.4 / 1.79 / 12.2 |
| three WebGL2 `Mesh` (~1 draw per visible box) | 375 / 2.1 / 1.63* / 5.6 | 60 / 16.0 / 10.3* / 18.7 | 10 / 95 / 74* / 105 | 40 / 26.5 / 16.0* / 28.8 |
| three WebGPU `Mesh` | 223 / 3.4 / 1.09 / 9.7 | 32 / 29.2 / 1.99 / 43.4 | 4.6 / 206 / 4.37 / 255 | 8.7 / 114 / 1.96 / 228 |

**Instanced <-> instanced**

| Variant | 1k | 10k | 50k | 10k moving |
| --- | --- | --- | --- | --- |
| Margo `createInstancedMesh` (1 draw, gltf-pro shader) | 490 / 0.35 / 1.18 / 6.6 | 212 / 0.32 / n/a† / 10.3 | 94 / 0.29 / 10.2 / 15.9 | 135 / 6.0 / 4.53 / 16.4 |
| Margo `CulledInstances` (16 indirect draws) | 389 / 0.31 / 1.00 / 6.5 | 270 / 0.26 / 2.36 / 7.7 | 163 / 0.21 / 5.52 / 11.7 | 5.2 / 187 / 4.14 / 286 |
| three WebGL2 `InstancedMesh` | **891** / 0.15 / 0.73* / 4.8 | **645** / 0.13 / 1.40* / 5.8 | **220** / 0.19 / 5.29* / 12.9 | **256** / 3.3 / 3.15* / 10.0 |
| three WebGPU `InstancedMesh` | 654 / 0.42 / 0.72 / 5.6 | 364 / 0.44 / 2.40 / 8.4 | 113 / 0.98 / 8.28 / 14.9 | 190 / 3.8 / 3.27 / 12.4 |

\* WebGL2 `TIME_ELAPSED` around the render call (includes GPU idle while a CPU-bound renderer submits). † Dawn returned
zeroed timestamps for every frame of both runs (counted in `zeroFrames`, not measured).

Reading (diagnostic only; the quiet-PC run decides any claim):

- **Mesh <-> mesh: Margo ahead on CPU and frame rate at every size** (CPU 2.1 vs 16-29 ms at 10k, 8.7 vs 95-206 ms at
  50k), because core batches every geometry into one instanced draw and three issues one draw per visible `Mesh`.
  GPU: Margo below three WebGPU at 1k-10k, above it at 50k (6.0 vs 4.4 ms; three's per-object frustum culling skips
  off-screen boxes, Margo's kernel culls too but the 50k grid is mostly on screen; not diagnosed).
- **Instanced <-> instanced: three ahead** on these static boxes except `CulledInstances` at 50k against three WebGPU
  (163 vs 113 FPS). Neither Margo instanced path gets core's culled pipeline: `createInstancedMesh` draws with
  gltf-pro's heavier PBR shader (and ACES, so its frames are brighter: `vsMargoImage` 20/255), `CulledInstances` with
  core's cull-none pipeline and the discard plus its compute passes. Core meshes, which do get it, beat three's
  WebGPU `InstancedMesh` on GPU (0.46 / 1.80 / 6.00 vs 0.72 / 2.40 / 8.28 ms) and take 0.6-1.3x the GPU time of its
  WebGL2 one, but pay 2-9 ms of CPU per frame for entities an `InstancedMesh` does not have.
- **Moving instances**: `CulledInstances.setTransform` is one 64-byte `writeBuffer` per part (187 ms CPU per frame for
  10,000 moving boxes): it is for static assemblies with occasional edits, not for animation. `createInstancedMesh`
  (validated `setMatrixAt`, one ranged upload) costs 6.0 ms against three's 3.3-3.8 ms.
- **CAD** (`results/vs-threejs-cad-pairs.json`, same conditions; single-sided parts unless noted): fix B, 10k parts
  4.04 -> 2.15 ms GPU (`margo+nocull` -> `margo`), 50k 11.44 -> 12.00 ms (no gain; geometry-bound, as before);
  core's default double-sided material draws the same pipeline as before (`margo+double` 5.24 / 14.73 ms).
  Instanced <-> instanced at 50k: `CulledInstances` 80 FPS / 0.26 ms CPU / 11.0 ms GPU, `createInstancedMesh` 55 /
  0.43 / 16.8, three WebGL2 `InstancedMesh` 92 / 0.21 / 10.9, three WebGPU 80 / 0.74 / 11.3; Margo core meshes 69 /
  12.9 / 12.0 (the mesh <-> mesh three `Mesh` variants were not run here).- Open follow-ups (packages, not core): give `CulledInstances` the same back-culled, discard-free pipeline for
  single-sided unmirrored batches, and a bulk transform upload; check gltf-pro's single-sided GPU cost.

## Answer

The smoke run's result was real and has one main cause in core: **Margo core never culls back faces in the
pipeline.** Its only pipeline has `cullMode: 'none'`, and a single-sided material removes back faces with
`if(!facing&&i.material.z<0.5){discard;}` in the fragment shader. That costs twice:

1. Every back-facing triangle is rasterized and shaded up to the `discard` (three's hardware cull drops it before
   rasterization).
2. The `discard` instruction is in the shader whether or not it runs, and its presence costs early depth testing for
   every fragment: hidden fragments that early-Z would have rejected are shaded.

The harness also had a fairness bug that made it look worse: Margo's boxes used core's default **double-sided**
material, which shades back faces too, while three used its default `FrontSide`. Fixed (both single-sided now).

With back faces culled in the pipeline (shader unchanged otherwise), Margo's GPU time on the boxes is **21-37% below
three.js WebGPURenderer with `InstancedMesh`**, and 0.9-1.3x three's WebGL2 renderer, with identical pixels
to today's core. Margo's fragment shader, pass structure and MSAA setup are not the problem: they are lighter than
three's WebGPU path.

## GPU time per frame, ms (median over 3 alternating rounds; `diag2`)

Sum of pass durations (timestamp queries injected into every pass by the harness, for both engines). In brackets:
first pass start to last pass end, where it differs.

| Variant | boxes 1k | boxes 10k | boxes 50k | CAD 50k |
| --- | --- | --- | --- | --- |
| Margo, core's default double-sided material (what the smoke run measured) | 1.67 | 5.38 | 14.51 | 12.70 |
| Margo, single-sided (harness default now) | 1.15 | 3.80 | 9.89 | 11.72 |
| Margo, single-sided + `cullMode: 'back'`, discard line removed (patched) | **0.53** | **1.67** | **5.92** | 11.16 |
| the same done by an engine plugin, no core change (see fixes) | 0.54 [0.75] | 1.80 [2.02] | 5.91 [6.26] | 11.16 [11.47] |
| Margo + an empty plugin pass (control for the row above) | 1.31 [1.51] | 3.94 [4.17] | 11.60 [11.92] | 10.74 [11.00] |
| three.js r186 WebGPURenderer, `InstancedMesh` (scene pass + output pass) | 0.77 (0.66 + 0.11) | 2.61 (2.47 + 0.14) | 7.70 (7.52 + 0.18) | 10.13 |
| three.js r186 WebGLRenderer, `InstancedMesh` (`TIME_ELAPSED`) | 0.46 | 1.51 | 4.68 | 9.31 |

Core prototype on a scratch branch (`proto`, 2 rounds, see fixes): single-sided boxes 0.49 / 1.70 / 5.87 ms,
CAD 11.52 ms; three WebGPU in the same run 0.78 / 2.46 / 7.43 / 9.04, WebGL2 0.52 / 1.42 / 4.52 / 8.93. The
prototype's t = 0 frames equal today's core's (0 of 3,686,400 channels differ, all four scenes).

## Isolating the cause (2 alternating rounds; `diag1`)

Margo rows use core's default double-sided material unless noted; each row changes one thing.

| Variant | 1k | 10k | 50k | Reads as |
| --- | --- | --- | --- | --- |
| Margo as shipped (double-sided) | 1.80 | 5.54 | 14.14 | baseline |
| single-sided | 1.41 | 4.27 | 11.07 | back faces discarded, still rasterized |
| discard line removed (double-sided, so no output change) | 0.83 | 3.24 | 10.05 | **the discard instruction alone: 1.7x / 1.7x / 1.4x** |
| single-sided + `cullMode: 'back'` + no discard | 0.52 | 1.70 | 5.79 | **hardware cull on top: another 1.6x / 1.9x / 1.7x** |
| `depth32float` instead of `depth32float-stencil8` | 1.83 | 5.61 | 12.99 | no consistent effect (50k rounds 11.2 / 14.8) |
| trivial fragment shader (vertex colour), no discard | 0.52 (1 round) | 2.30 | 8.55 | at 10k-50k the cost is geometry, not shading ALU |
| 1x MSAA | 1.04 | 3.16 | 10.01 | MSAA costs both engines; not the difference |
| three WebGPU `InstancedMesh` | 0.85 | 2.50 | 7.86 | |
| three, `side: DoubleSide` | 1.40 | 4.29 | 11.80 | like-for-like with Margo's discard-free double-sided row: Margo 15-41% faster |
| three, `MeshBasicMaterial` | 0.66 | 1.79 | 5.73 | |
| three, 1x MSAA | 0.73 | 1.92 | 5.20 | |
| three WebGL2 `InstancedMesh` | 0.70 | 1.46 | 4.86 | |

The removed-discard row shades *more* fragments than the single-sided row (back faces too) and is still much faster:
the cost is the instruction's effect on early depth testing, not the fragments it discards. A double-sided material
never takes the discard branch and pays it anyway.

## Cause ranking

1. **No pipeline back-face culling; the shader's `discard` costs early-Z** (core, frozen). 54% / 56% / 40% of Margo's
   single-sided GPU time at 1k / 10k / 50k boxes (1.15 -> 0.53, 3.80 -> 1.67, 9.89 -> 5.92 ms). Both halves matter:
   the discard instruction (1.4-1.7x) and rasterizing back faces (1.6-1.9x).
2. **Harness fairness: double-sided vs `FrontSide`** (fixed in this branch). Core's default material is double-sided
   (CAD files have open shells); three's is front-side. 1.67 -> 1.15, 5.38 -> 3.80, 14.51 -> 9.89 ms.
3. **Residual gap to three's WebGL2 renderer, up to 30%** (Margo culled 0.53 / 1.67 / 5.92 vs 0.46 / 1.51 / 4.68 ms). Not
   isolated. Candidates: Dawn on D3D12 vs ANGLE on D3D11 (three's own WebGPU path is 1.6-1.7x slower than its WebGL2
   path on the same scene), the different timers (`TIME_ELAPSED` vs pass timestamps), Margo's 96-byte instance record
   vs three's 64 + 12 bytes, and 13 interpolated floats vs 9.

Ruled out (each measured or read from the WGSL both engines submit, `run.mjs --dump`):

- **Shader ALU (GGX/IBL).** Margo's fragment shader is the smaller one: one light, GGX/Smith/Schlick, ambient,
  Reinhard and sRGB inline, no texture. three's `MeshStandardMaterial` node shader adds a DFG lookup texture sample,
  screen-space derivatives for geometric roughness, and single/multi-scattering terms for the ambient light.
- **Extra full-screen passes.** Margo draws one pass straight into the 4x `bgra8unorm` target and resolves into the
  canvas in the same pass (MSAA color and depth `storeOp: 'discard'`). three's WebGPURenderer draws into a 4x RGBA16F
  target (resolve stored) and runs a separate tone-mapping/output pass (0.11-0.18 ms). three pays more here.
- **Depth format** (`depth32float-stencil8` vs three's `depth24plus`): no consistent effect.
- **MSAA**: both use 4x; 1x saves both engines time.
- **Draw calls**: one per geometry for Margo, one `InstancedMesh` for three.

CAD 50k is a different case: culling gives little there (11.7 -> 11.2 ms) and three stays ahead (10.1 WebGPU, 9.3
WebGL2). Its small, dense parts make it geometry-bound; not diagnosed further here.

## What it takes for Margo to win on GPU (fixes, cost)

| Fix | Where | Bytes (core + stage gzip) | GPU, boxes 1k / 10k / 50k (single-sided) | Limits |
| --- | --- | --- | --- | --- |
| A. Per-cull-group pipelines (`scratch/core-backface-cull`, 7fce5be) | core | +315 (19,543 -> 19,858) | as the patched row: 0.53 / 1.67 / 5.92 | handles mixed and mirrored batches and package shader variants; already declined by Scott |
| B. Per-batch culled pipeline (`scratch/bvt-core-cull-bytes`, b3514f3; **merged as `d96e2d7`**, +216 on 19,577 -> 19,793) | core | **+212** (19,543 -> 19,755) | 0.49 / 1.70 / 5.87 (real GPU, identical frames) | a geometry batch gets culled only if every instance in it is single-sided and unmirrored; package shader variants (fog, clipping, clustered) keep the discard; unit tests that build `GPURenderer` by hand need the new argument |
| C. Engine plugin that rewrites the main pass (12 lines; the harness's `margo+plugin`) | a leaf package | 0 in core | 0.54 / 1.80 / 5.91 (span 0.75 / 2.02 / 6.26) | culls every core mesh: only for scenes of closed, unmirrored, single-sided solids; its pass makes core keep MSAA buffers and resolve in an extra pass (+0.2-0.35 ms span; already paid when any other package adds a pass); must run after any package that replaces the shader text |

Core was at 19,577 B after the material setters (perf/auto-quality e2cc4c5), so A and B both broke the 19,600 target
(B would land near 19,789). Scott then approved B and moved the working target to ~19,800 (B landed at 19,793). C needs no core change and matches HANDOFF's decision that pipeline culling is a
leaf-package option for closed solids; `@margoengine/culling` is the natural home (`BackfaceCulling.attach(engine)`,
following the `X.attach` standard). Not built: it is a new package feature, so it waits for Scott.

With any of the three, Margo's GPU time on the boxes is 63-79% of three's WebGPURenderer's and 0.9-1.3x
its WebGL2 renderer's, on this one integrated GPU.

## Where Margo wins and where it does not (same runs)

- **Bytes**: page JavaScript 24.0 kB gzip (boxes, incl. harness) vs 155.5 kB (three WebGL2) and 242.9 kB (three
  WebGPU). Margo also loads first among the WebGPU pages (442-593 ms to the first finished frame vs 618-705 ms for
  three's WebGPURenderer, whose first frame alone takes ~190-220 ms of pipeline compilation); three's WebGL2 page is
  fastest to load (236-293 ms).
- **CPU per frame: no win in these scenes** (against `InstancedMesh`; for the like-for-like pairs see the update at the top). Margo spends 0.3 / 1.9 / 8.0 ms (boxes) and 11.3 ms (CAD 50k) per frame
  against three's 0.1-0.7 ms. An `InstancedMesh` with a static matrix buffer costs three nothing per instance, while
  Margo's kernel culls every entity each frame and, as the orbiting camera changes the visible set, re-collects the
  instance buffer (HANDOFF 1e'; `@margoengine/culling` is the existing fix). Margo's CPU advantage is against one
  `Mesh` per object, the variant most three.js code uses (not re-measured here).
- **Delivered frame rate follows from the two.** With the corrected `fps` (`vs-threejs-boxes-fps.json`, 2 rounds x 300
  frames, a busier session: all GPU times 10-40% higher than above), single-sided Margo with plugin culling reaches
  227-283 FPS at 10k boxes (three WebGPU 255-287, WebGL2 488-575) and 67-79 FPS at 50k (three WebGPU 107, WebGL2
  181-192): at 50k Margo is CPU-bound (11-13 ms per frame) even once its GPU time is lower than three's WebGPU
  renderer's. Beating three's frame rate on large static instanced scenes needs the CPU side fixed too.

## Harness changes in this branch

- **Fairness fixes**: Margo's box and CAD materials are single-sided like three's (was double-sided). `fps` is now
  frames per second until the GPU has finished them (was the requestAnimationFrame rate, which with vsync off is not
  paced by the GPU: three's `InstancedMesh` pages reported 760-3,400 FPS while their GPU needed 0.5-7.7 ms per frame;
  the old figure is kept as `rafFps`). `--only=boxes:10000` no longer also selects the moving-boxes scene.
- **Diagnostics**: per-pass GPU medians with pass descriptions (`passMs`, `passes`) and the frame span
  (`gpuSpanMs`); `--variants=` with `?diag=` patches (Margo: `double`, `cull`, `plugin`, `pass`, `nodiscard`,
  `nostencil`, `flat`, `msaa1`; three: `double`, `flat`, `msaa1`); `--dump` records every shader and pipeline.
- **Quiet gate**: `scripts/quiet-gate.mjs` before every run; `--busy` skips it and records the CPU load instead and
  labels the JSON (Scott's call for this diagnosis).
