# Margo Engine whitepaper: outline

Structure for `docs/whitepaper.md` (also published on margoengine.com). Every number in the final paper names the
command, hardware, browser, date and commit that produced it, and links its results JSON. Status of each claim:
[claims.md](claims.md). Commands: [reproduce.md](reproduce.md).

Legend: **[have]** data committed today; **[rerun]** data exists but must be re-measured on the release commit (code
changed since); **[need]** no data yet.

## 0. Abstract (half a page)

- What Margo is: a WebGPU-first 3D engine for the web with a Rust/Wasm transform kernel, a 19.5 kB gzip core + stage,
  and optional tree-shakable packages; aimed at three.js users and at CAD/engineering viewers.
- Three headline results, each with its caveat in the same sentence (size, a same-scene comparison with three.js, CAD
  scale). Only numbers that are PROVEN in claims.md on the release commit go here.
- One line on scope: one integrated-GPU laptop measured so far; Firefox/Safari/Android unverified.

## 1. Architecture

1. Rust/Wasm transform kernel: flat typed arrays in Wasm memory (positions, rotations, scales, hierarchy, world
   matrices, culling); capacity 1,024 initial, doubled on demand up to 8,388,608 entities; what runs per frame and its measured cost per entity. **[rerun]**
   after the approved core speed-ups (skip unchanged entities, reuse instances, partial uploads, fast removal) land.
2. WebGPU first: reversed float depth, automatic instancing (one draw per geometry), uint GPU picking, device-loss
   recovery; WebGL2 only via the optional `@margoengine/webgl` (core meshes, flat PBR, one light). State plainly what
   needs WebGPU.
3. Plugin frame graph: `EnginePlugin` passes, shader hooks and the shader-contract tests (`docs/shader-contracts.md`,
   `tests/shader-contracts.test.js`) that keep cross-package WGSL patches honest.
4. Modular packages: 71 workspace packages, one feature per entry (`/base`, `/ssao`, `/instancing`, `/worker` ...),
   core + stage frozen for 1.0 with a CI size gate. Table: package -> purpose -> min+gzip bytes. **[have]**
   (`proofs/results/sizes.json`, `docs/api-surface.md`), **[rerun]** on the release commit.
5. What is deliberately not in core (material graphs, skinning, post) and why.

## 2. Size methodology and results

- Definitions: minified + gzip (level 9 vs default; say which), tree-shaken by the same Vite build, bare imports
  external or bundled (say which), Wasm embedded. Today three methods disagree for the same entry (e.g. VFX root
  7,653 B in `vfx-size.json` vs 7,009 B in `docs/api-surface.md`): pick one for the paper and re-measure everything
  with it.
- Core + stage: `npm run measure:size` (the CI gate). **[have]**
- vs three.js r186: `npm run measure:threejs` (minimal lit-box app in each). **[have]**, but state the asymmetry: the
  Margo number is the whole core + stage, the three.js numbers are a tree-shaken minimal app.
- Realistic apps: each demo's eager JS (`npm run measure:demos`) and the vs-three.js harness bundles (Margo vs three
  WebGL vs three WebGPU for the same three scenes, `results/vs-threejs.json` `bundles`). **[have]** (harness) / **[rerun]**
  (demos, after the demo rebuild).
- Per-package sizes and the cost of every optimization (HANDOFF records bytes per change). **[have]**

## 3. Performance methodology

- Hardware and software recorded per run (CPU, GPU adapter info, driver, browser build, OS, Node).
- AC power checked before and after every run; runs on battery are discarded (Windows throttles and may drop to 60 Hz).
- One GPU job at a time: `test-results/gpu.lock` in the main checkout.
- Headless Edge, `--disable-gpu-vsync --disable-frame-rate-limit`, fixed canvas and DPR 1; cross-origin isolated so
  `performance.now()` has 5 us resolution.
- Metrics: CPU ms per frame (JS on the main thread), GPU ms per frame (WebGPU timestamp queries injected into every
  pass, identical for every WebGPU engine; WebGL `EXT_disjoint_timer_query_webgl2` where exposed), FPS (median rAF
  interval, uncapped), serial frame latency (submit then wait for GPU idle), load-to-first-frame, JS heap after forced
  GC, transferred JS bytes.
- Alternating A/B rounds with rotating order, fresh browser per run, median of per-run medians; report run-to-run
  spread and the A/A noise floor (DOF and VFX work measured it; the vs-three.js harness needs an A/A run, **[need]**).
- Mock-GPU CPU measurements (recording GPU) are labelled as such and never presented as frame rates.

## 4. Results

1. Head-to-head with three.js r186 (WebGL2 and WebGPU renderers, `Mesh` and `InstancedMesh` variants), same scenes:
   lit boxes 1k/10k/50k static and 10k moving; CAD assembly 10k/50k parts; DamagedHelmet + IBL + shadows.
   `npm run bench:threejs`. Harness built and smoke-tested only. **[need]** the quiet-PC timing run
   (reproduce.md), the particles scene, a second machine and a phone.
2. CAD scale: 10k/50k/90k parts, kernel tick, pick latency, feature edges, GPU culling (`docs/cad-performance.md`,
   `cad/results-*.json`). Core path: **[have]**, publication-grade: the quiet-machine before/after of the merged
   core steps (`cad/results-{before,after}{1,2}-*.json`, 0ed56b9). Edges, culling, load/heap and 1x MSAA: **[rerun]**
   on the quiet machine against the merged core.
3. Feature costs on GPU: post stack per effect, DOF before/after, VFX 100k/1M, shadows shimmer, LOD/imposters,
   textured instancing, VAT crowds, contact shadows. **[have]** (each with JSON), several **[rerun]** (see claims.md).
4. Loading: main-thread blocking with and without workers, OCCT STEP init and parse, gltf-pro load times. **[have]**
5. Memory: load/unload cycles return to baseline (`gates-memory.json`). **[have]**
5b. Export fidelity: glTF round trip of RobotExpressive goes from 752 glTF-Validator errors in the source to 0 in the
   export (`exporters-model.mjs`, `results/exporters-model.json`, `packages/exporters/tests/model.test.js`). **[have]**
   Export time (DamagedHelmet 7.7 ms, Node 24) was measured on a busy machine: **[rerun]** in the quiet-PC run.
6. Frame rate of the shipped demos per device tier. **[need]** after the demo rebuild.

## 5. Correctness proofs

- Recorded-GPU-call proofs: every optimization replays the same GPU calls (or the documented differences) against a
  baseline commit (`examples/package-benchmarks/proofs/*.proof.js`, `compare.js`, `gpu-recorder.js`). **[have]**; list
  which proofs still build their default baseline (some do not, see claims.md).
- Pixel checks on the real GPU (shader, SSAO, DOF, imposters, textured instancing, culling, selection x-ray,
  sky entries). Tolerances and why.
- API snapshots (`api/*.api.md`, `npm run api:check`), `.d.ts` self-containment, README snippet type checks
  (`tests/from-threejs-snippets.test.js`).
- Test counts: unit tests in `npm run verify`, browser suites (`gates-browser-tests.json`: 39/41 pass and why two do
  not). **[rerun]** on the release commit.

## 6. CAD

- What Margo is for CAD (visualization/interaction, not a B-rep kernel): sections with caps, feature edges, exploded
  views, measurement and dimensions, ViewCube, orthographic cameras, AssemblyBVH, GPU culling, STEP/IGES via OCCT.
- Scale numbers with the methodology above; OCCT payload (3.1 MB gzip Wasm) and init/parse times stated as a cost.
- Comparison: the vs-three.js CAD scene (same assembly, three.js `Mesh` per part and `InstancedMesh` per shape).

## 7. Limitations and honest gaps

- WebGPU-first: most packages need WebGPU; WebGL2 fallback draws core meshes only.
- Measured on one machine (Intel Arc 140V integrated GPU). No discrete GPU, no Apple GPU, no Android GPU numbers in the
  current set; Galaxy S23 island at 3-5 FPS unresolved.
- Firefox and Safari unverified.
- Parity with three.js: the re-tallied matrix (`docs/threejs-parity.md`) with the missing features listed, not only
  the covered ones.
- Things three.js does better today (from the head-to-head and the parity matrix).
- Third-party code still inside packages (OCCT, web-ifc, Rapier, decoders) and their sizes.

## 8. Reproduce everything

- `npm ci && npm run build:packages`, then `npm run bench:all` (size, CPU, proofs) and `npm run bench:all -- --gpu`.
  Per-claim commands in [reproduce.md](reproduce.md).

## 9. Hardware list

| Machine | CPU | GPU | Display | OS | Browser | Status |
| --- | --- | --- | --- | --- | --- | --- |
| ASUS Zenbook S 14 UX5406SA | Intel Core Ultra 7 258V | Intel Arc 140V (16 GB shared), driver 32.0.101.8860 | 2880x1800 120 Hz | Windows 11 Pro 26300 | Edge 155 / Chrome 155 headless | measured |
| Discrete-GPU desktop | - | NVIDIA or AMD | - | Windows or Linux | Chrome/Edge stable | **[need]** |
| iPhone | - | Apple | - | iOS | Safari | **[need]** (one capture exists: 1M particles at 58-60 FPS, not scripted) |
| Android phone | - | Adreno/Mali | - | Android | Chrome | **[need]** (S23 island issue) |
| Mac (Apple silicon) | - | Apple | - | macOS | Safari + Chrome | **[need]** |

## What Scott needs to provide or decide

1. A discrete-GPU desktop (NVIDIA preferred; AMD as well if available) for one `npm run bench:all -- --gpu` run, and
   `modern-hardware-gpu-tests.js` (needs `GPU_VENDOR`). Same commit as the laptop run.
2. Phone runs: a scripted page for iPhone Safari and an Android Chrome device (S23 is the known problem). The
   harness runs headless Edge today; phones need a remote-debugging variant (Safari Web Inspector / `adb` + Chrome
   DevTools Protocol) or a manual "copy results" page. Decide which.
3. A Mac with Safari for the WebGPU-on-Safari claim, or drop the claim.
4. Which comparison wording to publish (see claims.md "Corrected wording"), and whether "faster than three.js" is
   claimed at all, scene by scene.
5. Release commit: all numbers re-run on one tagged commit after the core speed-ups and the demo rebuild.
