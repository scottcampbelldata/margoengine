# Reproducing Margo's numbers

Every public number should come from one of the commands below. Run them from the repository root on the commit you
want to check. Status of each claim and which command backs it: [claims.md](claims.md).

## Setup (once)

```sh
git clone https://github.com/scottcampbelldata/margoengine.git && cd margoengine
npm ci                     # Node 24.18+; installs three@0.186.1, Vite, Playwright and the test tooling
npx playwright install msedge   # or set MARGO_BROWSER=chrome, or webkit on macOS; the real-GPU scripts default to Edge
npm run build:packages     # every package, size gates, catalog (no Rust toolchain needed; the Wasm is checked in)
```

## Everything in one command

```sh
npm run bench                  # every suite: size, startup, render, objects, scaling, math, glTF, loaders, assemblies,
                               # voxel, physics, memory, React (quiet-machine gate, GPU lock, 5 runs per case)
npm run bench -- features      # also every per-feature real-GPU script below (about an hour)
npm run bench -- --list        # the suites and cases
npm run proofs -- --current    # the recorded-GPU-call proofs
```

`npm run bench` is the one benchmark tool ([docs/benchmarking.md](../benchmarking.md)). Each run writes
`benchmarks/runs/<id>.json` with its Markdown and HTML report. The JSON records the commit, machine, GPU and driver,
browser and the gate's readings. `--record` keeps a committed copy in `benchmarks/records/`. The `features` suite
copies what each script writes to `benchmarks/runs/<id>/features/` and restores the committed results, so a run never
changes them.

## Whitepaper timing run (pending: needs a quiet PC)

No timing number is whitepaper data yet. The tool has only been smoke-tested (labelled "smoke", not for
publication). When the machine is quiet (no other apps, no builds, on AC power), run
this once on the release commit:

```sh
npm run build:packages
npm run bench -- --label=official --record
npm run bench -- features
```

The gate refuses battery power and waits for a quiet CPU and GPU. Any case whose runs spread more than 10% makes the
run invalid. An official label on an invalid run stays invalid. The head-to-head with three.js and other engines runs
the same scenes from `C:DevelopmentProjectsengine-bench` (`--engines=all`, see docs/benchmarking.md "Comparing
engines").

## The five-minute quickstart

The launch claim is that a developer builds a textured, lit scene with shadows and picking in under five minutes by
copy-pasting the README. `npm run check:quickstart` measures the machine part and asserts the result in a real browser:

```sh
npm run check:quickstart                                   # route 2: an own project from local tarballs
npm run publish:rehearsal                                  # the one-line install from a stand-in registry; publishes nothing
node scripts/quickstart-timing.mjs --route=1 --keep --dir=<folder>   # route 1 (the clone's page); keep the folder
```

It clones this checkout (uncommitted work laid over it) into a temp folder with a cold npm cache, then does what the
README says line by line: `npm ci`, `npm run pack:packages`, a new project, `npm install <tarballs> vite`,
`index.html` and `main.ts` extracted from the README text itself (never retyped), `npx vite`, and the page in headless
Edge under one shared GPU slot. The browser asserts, from pixels and handlers:

- a first frame with content, and sharp checker edges on the floor (none in the same scene without the texture);
- a shadow beside the ball, darker than the same scene without `shadows.add`, also on the shipped page;
- a click on the ball and on the crate fires the page's pick handler (waited for) and draws the outline, and an orbit
  drag changes the picture without picking;
- a console with no warning or error (one recorded Chrome-on-Windows warning is reported, see known-bugs.md);
- the messages shown with no `navigator.gpu` and with an adapter request that answers null.

It writes `test-results/quickstart-timing.json` (timeline, sizes, notes) and the pictures in
`test-results/quickstart-timing/`. The three reference pages open one at a time beside the shipped page, and each is
closed once its picture is taken: on an Intel Arc 140V the 4th WebGPU page alive at once in one browser process never
finished starting. A page that is not ready in time leaves `failed-<page>.png` and `failed-<page>.json` there
(visibility, canvas sizes, animation frames per second, what the page logged) before the check fails. It fails over
300 s from the first command to the verified interactive frame, and ends every process it started at a hard limit of
900 s. It is a step of `check:merge`, so the nightly full run has it too.
Not measured: reading the page and copying the two files, and anything after the first interactive frame. The install
route is a clone because 1.0.0 is not on npm yet.

## Rules for real-GPU numbers

- A quiet machine: on an integrated GPU the CPU and GPU share one power budget, so a build or test running at the same
  time changes the GPU numbers too.

- AC power before and after (`(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline`
  on Windows). The scripts check it and refuse or flag battery runs; on battery Windows throttles CPU and GPU.
- One GPU job at a time: the scripts take `test-results/gpu.lock` in the main checkout (they wait while another run
  holds it). Close other GPU apps; on an integrated GPU even a browser tab changes the result.
- Headless Edge/Chrome with `--disable-gpu-vsync --disable-frame-rate-limit`, so FPS is throughput, not the display.
- Medians of alternating rounds; compare A/B only within one run (clocks drift between runs).

## Commands by claim area

| Area | Command | GPU | Output | Notes |
| --- | --- | --- | --- | --- |
| Core + stage gzip (CI gate, < 25,000 B) | `npm run measure:size` | no | console | Also enforced by `npm run build:packages`. |
| meshopt, TypeScript against Wasm SIMD | `node packages/decoders/scripts/meshopt-simd-bench.mjs <file.glb>` (after `npm run build --workspace packages/decoders`) | no | console | Any glTF binary compressed by gltfpack; perf-history entry 75. |
| Own physics replay, Node, native, Chromium and Firefox (LIM-366) | `npm run test:physics-kernel`, `npm test --workspace @margoengine/physics` and `npm run test:replay --workspace @margoengine/physics` | no | `packages/physics/test-results/replay-browsers.json` | Install Firefox once with `node node_modules/@playwright/test/cli.js install firefox`. `REPLAY_FIREFOX` names a `firefox.exe` where Playwright's own will not start. |
| Margo vs other engines, bundle size | `npm run bench -- size --engines=all` | no | `benchmarks/runs/<id>.json` | Each engine's smallest lit-box app from engine-bench (`sizeEntry`) vs Margo's whole core + stage, all built with the size gate's output options. The last three.js measurement stays in `results/threejs-size.json`. |
| Potree reader on real folders | Fetch a folder (`git clone` or `curl`), then `node packages/points/tests/potree-check.mjs <folder URL or path>` (after `build:packages`). Folders used 2026-11-06: `pointclouds/lion_takanawa`, `lion_takanawa_normals`, `lion_takanawa_las`, `lion_takanawa_laz`, `vol_total` of github.com/potree/potree (branch develop), `pointclouds/potree2.0/lion` of github.com/iTowns/iTowns2-sample-data (BROTLI, CC BY-NC-SA, not in this repository), `example/data/pump` of github.com/tentone/potree-core | no | console, one JSON line | Exit 0 when every point lies in its node and counts match. Results: 272,768, 341,989, 341,989, 341,989, 498,868, 3,954,696 and 1,213,990 points, none outside. |
| Every package entry and worker, min+gzip | `node examples/package-benchmarks/entry-sizes.mjs` (after `build:packages`) | no | `results/entry-sizes.json` | build-modern's method, other packages external; also feeds the Gzip column of `docs/api-surface.md`. |
| Eager JS per demo | `npm run bench -- size --cases=demo-` | no | `benchmarks/runs/<id>.json` | Builds each demo with Vite. |
| Per-package min+gzip | `node examples/package-benchmarks/proofs/size.js` | no | `proofs/results/sizes.json` | |
| VFX entry sizes | `node examples/package-benchmarks/vfx-size.mjs` | no | `results/vfx-size.json` | |
| Package optimization proofs (same GPU calls / same output, faster) | `node examples/package-benchmarks/proofs/<name>.proof.js [ref]` | no (recording mock GPU) | `proofs/results/<name>.json` | Each builds a baseline ref; some default refs no longer build (see claims.md). |
| Kernel tick in Node | `npm run bench -- parts --cases=kernel` (or `node examples/package-benchmarks/parts/kernel-node.mjs`) | no | `benchmarks/runs/<id>.json` (`parts/results-kernel-node.json`) | |
| glTF export: validator errors and export time | `node examples/package-benchmarks/exporters-model.mjs` | no | `results/exporters-model.json` | Khronos glTF-Validator from node_modules; the timing needs the quiet PC. |
| Textured instancing, encoding CPU | `node examples/package-benchmarks/textured-instancing.mjs` | no (mock) | `results/textured-instancing.json` | Mock GPU: CPU encoding only, not frame rate. |
| Precise maths against the builtins, in the bench tool | `npm run bench -- compute --cases=compute-elementwise --runs=3` and `npm run bench -- tracer --runs=3` | yes | `benchmarks/runs/<id>.json` | perf-history entry 71. The record is the `precise-math-gpu.mjs` row. |
| **Margo vs other engines, same scenes** | `npm run bench -- render objects scaling --engines=all` | yes | `benchmarks/runs/<id>.json`, screenshots in `benchmarks/runs/<id>/` | Scenes in `bench/scenes/catalog.js`; other engines' implementations live in engine-bench. Earlier results: `results/vs-threejs-*.json`. |
| GPU culling | `node examples/package-benchmarks/parts/culling.mjs --check --label=<name>` | yes | `parts/results-<name>.json` | |
| Post stack per effect, SSAO + IBL | `node examples/package-benchmarks/gates/post-stack.mjs` | yes | `results/gates-post-stack.json` | |
| DOF before/after | `node examples/package-benchmarks/gates/dof.mjs --baseline=5b9dbbd` | yes | `results/gates-dof.json` | Builds the baseline. |
| Loaders + memory cycles | `node examples/package-benchmarks/gates/memory.mjs` | yes | `results/gates-memory.json` | |
| Native glass tint draw cost | `node scripts/gpu-lock.mjs run --exclusive --owner=<id> -- node examples/package-benchmarks/tint-pass-gpu.mjs` | yes | `results/tint-pass-gpu.json` | Patches the served gltf-pro build for its comparison arms; fails if an arm leaves the frame unchanged. About 10 minutes. |
| Precise maths against the WGSL builtins | `node scripts/gpu-lock.mjs run --exclusive --owner=<id> -- node examples/package-benchmarks/precise-math-gpu.mjs` | yes | `results/precise-math-gpu.json` | Compute functions and path tracer lenses. |
| Growable ECS worlds against fixed ones | `node examples/package-benchmarks/ecs-growable.mjs` | no | console | |
| Workgroup sizes of the compute package's own kernels | `node scripts/gpu-lock.mjs run --owner=<id> -- node packages/compute/tests/compute-browser.mjs`, line `tuneCompute, 16M elements` | no | console | perf-history entry 77 |
| Subgroup kernels against the default compute kernels | `node examples/package-benchmarks/compute-subgroups.mjs` | yes | `examples/package-benchmarks/results/compute-subgroups.json` | |
| Shadow shimmer | `node examples/package-benchmarks/shadow-shimmer.mjs` | yes | `results/shadow-shimmer.json` | |
| Textured instancing on GPU | `node examples/package-benchmarks/textured-instancing-gpu.mjs` | yes | `results/textured-instancing-gpu.json` | |
| Atlas + VAT | `node examples/package-benchmarks/atlas-vat/check.mjs` | yes | `test-results/atlas-vat-check.json` | Result is not committed today. |
| Workers / OffscreenCanvas | `node examples/package-benchmarks/workers/run.mjs` | yes | `results/workers.json` | Edge and Chrome. |
| VFX 100k/1M particles | `node examples/package-benchmarks/vfx-gpu.mjs --a=<dist> --b=packages/vfx/dist` | yes | `results/vfx-gpu-*.json` | A/B of two builds: snapshot a baseline dist first (header of the script). Not in the features suite. |
| Scatter cull, atomic against ordered (LIM-034) | `node examples/package-benchmarks/scatter-cull-gpu.mjs --a=test-results/scatter-base --b=packages/scatter/dist` | yes | `results/scatter-cull-gpu-*.json` | A/B of two builds: snapshot a baseline dist first (header of the script). Asserts both builds hold the same instances. |
| Island demo with VFX | `node examples/package-benchmarks/vfx-island.mjs --variants=...` | yes | `results/vfx-island-*.json` | Needs variant builds. Not in the features suite. |
| Pipeline toggles | `node examples/package-benchmarks/pipeline-toggles/toggle.mjs [stall|pixels|gpu|override]` | yes | `results/pipeline-toggles.json` | Not in the features suite (needs `old-gltf.mjs` first for `pixproof`). |
| Every real-browser test | `node examples/package-benchmarks/gates/run-browser-tests.mjs` | yes | `results/gates-browser-tests.json` | 41 scripts; `modern-hardware-gpu-tests.js` needs `GPU_VENDOR` and a discrete GPU. |
| Light-tier pace and GPU reading (LIM-077) | `npm test --workspace @margoengine/quality` | no | console | A physical 100 Hz display shows it live: the voxel sandbox's HUD with `?seed=1`. |
| Bulk transform writes against setters | `node packages/scene/scripts/bulk-bench.mjs 10000` | no | console | CPU only; build the package first. |
| Engine bridge sync, four cases (perf-history entry 74) | `npm run build --workspace packages/ecs`, then `node packages/ecs/scripts/bridge-bench.mjs` | no | console | CPU only. |
| Every three.js parity row (perf-vs-threejs) | `npm run build:packages`, then `npm run bench:parity` | yes | `docs/whitepaper/perf-vs-threejs.md`, `.json` | The ledger keeps every run. The numbers below are diagnostic until a quiet run. |
| One parity row (perf-history entries 56 to 60, 63, 65 to 69) | `node bench/cli.mjs parity --cases=<scene> --engines=margo,three-webgpu-parity,three-webgl-parity --runs=5` | yes for frame scenes | `benchmarks/runs/<id>.json` | Scenes: `p-morph`, `p-morph-compiled`, `p-stl`, `p-stl-normals`, `p-skeleton-clone`, `p-gpu-pick`, `p-gpu-pick-batch`, `helmet`, `p-motion-blur`, `p-motion-blur-velocity`, `p-custom-shader`, `p-rect-area`, `p-pmrem`, `p-pmrem-refresh`, `p-export-usdz`. Each entry names its own engines and runs. |
| Instanced and moving boxes against three.js (entries 50, 51, 53, 54) | `npm run bench -- instanced --engines=margo,three-webgl,three-webgpu --runs=3` and `npm run bench -- dynamic --engines=margo,three-webgpu --runs=3` | yes | `benchmarks/runs/<id>.json` | |
| Polygon offsets (entry 52) | `npm run build` in `packages/geometry`, then `node packages/geometry/scripts/polygon-bench.mjs` | no | console | |
| Not repeatable by a script yet | - | - | - | The `Spring` timing (entry 55), the WebGL2 CPU tier's interpreter (entry 72) and the path tracer on the layer (entry 73). Each is on the re-measure list. |
| WebP and DDS against outside decoders (LIM-285) | `npm run build:packages`, then `node packages/decoders/scripts/test-real-textures.mjs <empty folder>`: downloads the files of `packages/decoders/tests/real-files/manifest.json`, checks each SHA-256, and compares with the planes dwebp 1.4.0 wrote and with Pillow's PNGs | no | prints the counts, exit 1 on any difference |
| Held textures in Blender (LIM-285) | In Node serve a Khronos glTF-Sample-Assets model folder over HTTP, `loadGLTF(engine, url, {ktx2: nodeKTX2, maxDownloadBytes: 2 ** 29})`, `exportOBJ(engine, {materials: true, textures: true})`, `await writeTextures(result)`, write the files. In Blender `wm.obj_import`, then compare each material's image with the model's source image at `Non-Color`, per channel | no | largest and mean difference of 255 |
| OBJ, STL and PLY of loaded models in Blender (LIM-277) | On a real page `loadGLTF` a GLB, then `exportSTL(engine)`, `exportPLY(engine, { binary: true })` and `exportOBJ(engine, { materials: true, textures: true, mtlName: 'tex.mtl' })`. In `blender --background --factory-startup` read the source with `import_scene.gltf(guess_original_bind_pose=False)` and the others with `wm.stl_import`, `wm.ply_import` and `wm.obj_import(forward_axis='NEGATIVE_Z', up_axis='Y')`, leaving out the glTF importer's `glTF_not_exported` collection, and compare world bounds. Use models with no clips: a source with clips imports posed. For the OBJ, connect each material's base colour to an emission surface, multiply `map_Kd` by `Kd` decoded from sRGB, draw source and OBJ with Cycles from one orthographic camera and compare pixels | no | console | Blender is run by hand. |
| COLLADA in Godot and SceneKit (LIM-284) | On a real page `loadGLTF` a GLB and `exportDAE(engine)`. Put the file in an empty Godot 4.7 project, run `--headless --import`, then load it from a script and add up `surface_get_array_index_len`: robot-expressive gives 9,711 and no `Multiple instance_*` error. On a Mac open it with `SCNScene(url:)` and count `geometry.elements`: 19 groups in 14 geometries. | Godot 4.7.2, macOS 27 SceneKit |
| `decodePNG` on PngSuite (LIM-093) | `npm test --workspace packages/headless`: each file's pixels hash to what `packages/headless/tests/fixtures/pngsuite/chromium.json` holds. To remake that file, load each PNG in Chromium with `createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })`, upload it to a WebGL2 texture and `readPixels` | no | console | Reading through WebGL keeps alpha unpremultiplied, which a 2D canvas does not. |
| Compressed GLB in Blender and Godot (LIM-243, LIM-250, LIM-258, LIM-262) | In Node run `compressDraco`, `compressMeshopt`, `optimizeGLB` and `compressTextures` on Fox, robot-expressive, RiggedFigure, MorphStressTest, flight-helmet, scifi-helmet, NegativeScaleTest, OrientationTest, ToyCar and Lantern. In `blender --background` import each with `bpy.ops.import_scene.gltf`, then compare meshes, triangles, materials, images, bones, clips and world bounds with the source. Put the files in an empty Godot 4.7 project, run `--headless --import`, then add up `surface_get_array_index_len` from a script and compare with the source | no | console | Godot has no Draco or meshopt support and refuses those files. Blender has no `KHR_texture_basisu`. Run by hand, 2026-11-06, Blender 5.3 and Godot 4.7.2. |
| Blender add-on in real Blender (LIM-287) | `MARGO_BLENDER=<path to blender> npm run modern:test:blender` after `npm run build:packages` | yes | console, `test-results/blender/` | Not in the checks: Scott has not cleared Blender for them. Run by hand, 2026-11-06, Blender 5.3 and an RTX A6000. |
| USDZ on real models against Apple's tools (LIM-253) | Export with `exportUSDZ`, then on a Mac `usdchecker --arkit model.usdz` and `usdcat --flatten model.usdz -o flat.usda`; take each `Mesh_<i>`'s points through its `xformOp:transform` and compare with the source nodes | no | console | By hand, on a Mac. |
| USDZ in Blender and Quick Look (LIM-095, LIM-253) | `exportUSDZ(bytes)` each GLB. `blender --background --factory-startup --python tools/real-proof/blender_report.py -- out.json a.glb a.usdz` for source and file, then `node tools/real-proof/glb_bounds.mjs a.glb` where the two disagree: Blender's rest pose drops bone scale (robot-expressive) and its GLB import leaves a model at a clip's first frame (CommercialRefrigerator, door ajar). On a Mac `usdcat --flatten` and count Mesh prims; `tools/real-proof/quicklook_thumbnails.swift`, one file at a time | no | console, PNG | By hand, 2026-11-06. Thumbnails are read by eye. |
| Safari on a Mac (LIM-026, LIM-233) | `tools/real-proof/README.md`, `safari/`: the same `dist` in Safari and in Edge, then compare the pictures the page posts | no | `report.json` | By hand, 2026-11-06, Safari 27.2 on an Apple M6 and Edge 156 on an RTX A6000. |
| EXR in Blender (LIM-094) | In Node `encodeEXR` a 17 by 9 float image with values to 1,000 and alpha, `half` and `float`. In `blender --background` load each with `bpy.data.images.load`, set `alpha_mode = 'CHANNEL_PACKED'`, `reload()`, and compare `image.pixels`, whose rows run bottom up | no | console | Without `CHANNEL_PACKED` Blender multiplies colour by alpha. |
| Real files in Blender (LIM-208) | `REAL_FILES_ONLY=ply,stl,obj,usd npm run test:real-files -w @margoengine/loaders`, then `tools/real-proof/blender_report.py` on what it downloaded and compare bounds; OBJ and USD turn Y up to Z up | no | console | Spider_ascii.stl: Blender merges 56 of the file's 1,368 triangles, the reader keeps them. |
| State machines against Sismic (parallel regions and what follows) | `python -m venv <folder>`, `<folder>/Scripts/python -m pip install sismic==1.6.14`, `npm run build --workspace @margoengine/fsm`, then `MARGO_SISMIC_PYTHON=<folder>/Scripts/python npm run test:outside --workspace @margoengine/fsm` | no | prints charts, steps, moves and differences; rewrites `packages/fsm/test/outside/traces.json` | Exit 1 on any difference. `npm test` replays the recorded traces with no Python. |
| Meshopt export on real models against outside tools | `compressMeshopt` a GLB, then `gltfpack -i out.glb -o back.glb -noq` and `gltf-transform inspect out.glb`; decode each stream with the `meshoptimizer` package's `MeshoptDecoder.decodeGltfBuffer` and run the Khronos validator on the result | no | console | By hand; no script in the repository. |
| GLB optimize on real models against outside tools | `optimizeGLB` a GLB with its defaults and with `{ simplify: 0.5, lods: [0.5, 0.25] }`, run the Khronos validator on input and output, then `gltfpack -i out.glb -o back.glb -noq` and `gltf-transform inspect out.glb`; compare the triangles of each node, corner by corner, and each level's vertices with the source's | no | console | By hand; no script in the repository. |
| USDZ real size on real models (LIM-265) | `exportAnimatedUSDZ` each clip and read `size` and `bounds`; compare `bounds` with glTF maths at every frame, node transforms and skinning applied, weights normalized. On a Mac, load the file with RealityKit's `Entity(contentsOf:)` and read `visualBounds(relativeTo: nil)`, and render with `usdrecord --sessionLayer cam.usda --camera Cam -f <frame>` through one fixed camera to compare a file before and after a change. On an iPhone, open the file in AR Quick Look, place it on a floor and check it stands in view at about 2 m and moves with a drag | no | console | By hand; no script in the repository. RealityKit's bounds do not run the skeleton, so they read the rest points. Only the phone shows placement, clipping and moving. |
| USDZ animation on real models against Apple's tools | `exportAnimatedUSDZ` each clip of a rigged GLB, then on a Mac `usdchecker --arkit out.usdz` and `usdcat --flatten out.usdz -o flat.usda`; evaluate the flattened skeleton and Xforms by UsdSkel's rules at a few frames and compare the world bounds with glTF's skinning maths; load it in ModelIO, SceneKit and RealityKit | no | console | By hand; no script in the repository. |
| USD composition against OpenUSD (LIM-303) | Run `packages/usdz/tests/oracle/truth.py` inside Blender's Python on a list of files, for example `blender --background --factory-startup --python packages/usdz/tests/oracle/truth.py -- list.txt truth.json`, then open each file with `composition()` and compare meshes, world bounds, triangle counts and bound materials. `tests/oracle/generate-stages.py` writes stress stages. |
| UsdSkel against OpenUSD (LIM-310) | `packages/usdz/tests/oracle/skel-truth.py` inside Blender's Python on a list of files gives each mesh's points at five times through `UsdSkel.Cache`, `SkinningQuery` and `BlendShapeQuery`. Parse the same file with `skeletons()`, pose it by plain glTF rules (`packages/usdz/tests/pose.js`) and compare point by point. Apple's and Pixar's samples are read from a local download. | yes |
| Time samples against OpenUSD (LIM-315) | `packages/usdz/tests/oracle/anim-truth.py` inside Blender's Python on a list of files gives each moving prim's world matrix and visibility at several times through `UsdGeom.XformCache` and `ComputeVisibility`. Parse the same file with `animation()`, pose it by plain glTF rules (`packages/usdz/tests/pose.js`) and compare matrix by matrix. The usd-wg files are at commit 091bb5c6; Pixar's are read from a local download. | yes |
| Subdivision against Blender (LIM-319) | `packages/usdz/tests/oracle/subdiv-truth.py` (points) and `subdiv-uv-truth.py` (face-varying values, in the mode each mesh authors) run inside Blender 5.3 on a list of files and give refined points and corners through its Subdivision Surface modifier, with `use_limit_surface` off. `subdiv-faces.py` writes the stand-in stage and its truth in all six modes. Parse the same files with `subdivision({level:2})` and pair corners by nearest point, not by a rounded key. Real meshes of the Kitchen Set, OpenChessSet, usd-wg assets and HumanFemale are read locally; two usd-wg files are committed. |
| Lights and cameras against OpenUSD (LIM-320) | `packages/usdz/tests/oracle/lux-truth.py` inside Blender's Python gives each light's and camera's world matrix through `UsdGeom.XformCache`, each camera's frustum through `Gf.Camera`, and `UsdLux.BlackbodyTemperatureAsRgb`. Parse the same stages with `lights()` and compare node world matrices under the root node. The 55 real stages are the files of the usd-wg assets that hold lights or cameras, read locally. |
| Reset transform stacks against OpenUSD (LIM-324) | `packages/usdz/tests/oracle/reset-truth.py` inside Blender's Python writes the stand-in stage and what OpenUSD computes for it into `tests/fixtures/xform/`; `node --test packages/usdz/tests/reset.test.js` compares. |
| MaterialX in USD against OpenUSD (LIM-331) | `packages/usdz/tests/oracle/materialx-truth.py` inside Blender's Python writes what `UsdShade` reads from each material, with the shader registry's defaults, to `tests/fixtures/materialx/openusd.json`; `node --test packages/usdz/tests/materialx.test.js` compares. 53 of the 58 materials are in stored files; the two large stages, `StandardShaderBall/layers/shaderball.usda` and `MaterialXTest/basicTextured_flatten.usda` of the usd-wg assets, are read when copied beside them. `npm run modern:test:usdz:browser` compiles the networks on the GPU. |
| 3MF on real models against a slicer and Windows | `export3MF` a GLB, then `prusa-slicer-console --info out.3mf` and `prusa-slicer-console --support-material --export-gcode --merge --scale-to-fit 150,150,150 --center 100,100 --output out.gcode out.3mf` (without `--support-material` for the 22 of 26); for a print-ready model, read https://github.com/CreativeTools/3DBenchy `Single-part/3DBenchy.stl` with `parseSTL`, `export3MF` it with `upAxis: 'z'`, and slice both with `--export-gcode --center 100,100`, comparing layers and filament; load it with `Windows.Graphics.Printing3D.Printing3D3MFPackage` and compare unit, triangles, items and colours with the file written | no | console | By hand; no script in the repository. |
| FBX cameras and lights from Blender | `blender --background --factory-startup --python packages/fbx/test/fixtures/blender-shot.py -- <folder>` writes the two FBX files and Blender's own numbers as JSON; `node --test packages/fbx/test/scene-extras.test.js` compares them after `npm run build --workspace @margoengine/fbx` | no | console | Blender is run by hand; the fixtures and its numbers are checked in. |
| FBX UV sets and colour layers from Blender | `blender --background --factory-startup --python packages/fbx/test/fixtures/blender-layers.py -- <folder>` writes the FBX and Blender's own values as JSON; `node --test packages/fbx/test/layers-option.test.js` compares them after `npm run build --workspace @margoengine/fbx` | no | console | Blender is run by hand; the fixture and its values are checked in. |
| FBX inherit types against Maya | `node --test packages/fbx/test/inherit.test.js` after `npm run build --workspace @margoengine/fbx` compares a converted rig, posed by plain glTF rules with its skin, with the eight OBJ frames Maya wrote (`packages/fbx/test/fixtures/real/`) | no | console | Sources and sums in that folder's NOTICE.md. |
| FBX animation layers against Maya | `node --test packages/fbx/test/layers.test.js` after `npm run build --workspace @margoengine/fbx` compares a converted clip, posed by plain glTF rules, with the OBJ frame Maya wrote (`packages/fbx/test/fixtures/real/`) | no | console | Sources and sums in that folder's NOTICE.md. |
| FBX PBR materials from Max and Maya | `node --test packages/fbx/test/pbr.test.js` after `npm run build --workspace @margoengine/fbx` reads real 3ds Max and Maya files. |
| FBX curves and deformers against Max and Maya | `node --test packages/fbx/test/curves.test.js packages/fbx/test/deformers.test.js` after `npm run build --workspace @margoengine/fbx` reads real files and Maya's OBJ frames. |
| FBX camera and light export in Blender | Write a scene with `exportFBX`, then `blender --background --factory-startup --python packages/fbx/test/fixtures/blender-read-export.py -- /absolute/file.fbx /absolute/out.json` and compare the JSON with the scene, Blender's axes being x, -z, y. |
| Unit tests, API snapshots, size gate | `npm run verify` | no | console | `npm run verify:full` adds packed-package and interop suites. |

## A second machine

On a discrete-GPU desktop or a Mac: the setup above, then `npm run bench` and `npm run bench -- features`, and
keep the `benchmarks/runs/` folder. On Linux or macOS the AC check returns `null` (recorded, not enforced). Set
`MARGO_BROWSER=chrome` where Edge is not installed. On macOS, `MARGO_BROWSER=webkit` runs the browser suites in Playwright's
WebKit build, which has WebGPU there (`npx playwright install webkit`). That is not Safari. Phones are not scripted yet.
