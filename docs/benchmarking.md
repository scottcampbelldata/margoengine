# Benchmarking

Margo has one benchmark tool: `npm run bench`. It measures bytes, startup, rendering, objects, kernel maths, glTF,
loaders, CAD, voxels, physics, memory and React. Every run passes the same quiet-machine gate and repeats each case. It
records the machine it ran on and writes a versioned JSON result with a readable report. It can compare that run with
an earlier run or commit and fails when something got slower. The same scenes run in the browser at
[margoengine.com/bench/](https://margoengine.com/bench/), so anyone can measure their own machine with the code we use.

- [Running it](#running-it)
- [Suites](#suites)
- [Reading results](#reading-results)
- [Comparing runs and catching regressions](#comparing-runs-and-catching-regressions)
- [Quiet-machine rules](#quiet-machine-rules)
- [The browser runner](#the-browser-runner)
- [Comparing engines](#comparing-engines)
- [Adding a suite](#adding-a-suite)
- [Adding a scene](#adding-a-scene)
- [What the tool replaced](#what-the-tool-replaced)

## Running it

Build the packages first, once per change to them:

```sh
npm run build:packages
```

Then:

```sh
npm run bench                          # every suite
npm run bench -- render objects        # some suites
npm run bench:render                   # one suite (bench:size, bench:startup, ... bench:react)
npm run bench -- --list                # suites, their cases and the engines found
npm run bench -- scaling --cases=instanced   # only cases whose id contains "instanced"
npm run bench -- --smoke               # quick check: 3 runs, 120 frames, labelled "smoke"
```

Options:

| Option | Default | What it does |
| --- | --- | --- |
| `--runs=N` | 5 (smoke 3) | Measured runs per case. |
| `--warmup=N` | 1 | Runs per case that are measured and thrown away first. |
| `--frames=N` | 300 (smoke 120) | Frames per browser run, after 60 warm-up frames. |
| `--noise=F` | 0.1 | Relative spread over which a metric is noisy. A noisy primary metric makes the run invalid. |
| `--threshold=F` | 0.05 | Relative change that counts as a regression or an improvement. |
| `--label=dev\|smoke\|official` | dev | What the run is for. Official runs must use the defaults and pass the gate. |
| `--compare=TARGET` | this machine's baseline | Compare with a run id, a commit, a result file, `baseline` or `last`. |
| `--no-compare` | | Do not compare. |
| `--baseline` | | Save this run as this machine's baseline (merged per suite). `--baseline-name=x` picks another name. |
| `--record` | | Keep a committed copy in `benchmarks/records/` and update the browser runner's reference. |
| `--engines=a,b` | margo | Engines for the browser scenes; `all` is Margo plus every engine engine-bench provides. |
| `--engine-bench=DIR` | `../engine-bench` next to the main checkout | Where other engines live. |
| `--no-gate` | | Skip the quiet-machine gate. The run is marked invalid. |
| `--quiet-max`, `--quiet-hold`, `--gpu-max`, `--timeout` | 20 %, 20 s, 20 %, 1800 s | Gate limits (see below). |
| `--browser=msedge\|chrome\|bundled` | msedge | The browser for browser suites (`BROWSER_CHANNEL` works too). |
| `--no-fail` | | Report regressions without failing. |
| `--require-valid` | | Exit with code 2 when the run is invalid. |

Exit codes: 0 when every case ran and nothing regressed, 1 for a failed case or a regression, 2 for an invalid run with
`--require-valid`.

Agents on the shared PC wrap GPU runs in the lock as every GPU job does:

```sh
node scripts/gpu-lock.mjs run --owner=<your id> -- npm run bench -- render
```

The tool takes the lock itself when it is not wrapped, so both forms are safe.

## Suites

| Suite | Runs in | What it measures |
| --- | --- | --- |
| `size` | Node, exact | Core + stage gzip (the startup path; fails over the 25,000 B budget), every package entry and worker, every lazily loaded file, each site demo's eager and lazy JS, and other engines' smallest apps when engine-bench provides them. |
| `startup` | browser | Time to the first finished frame of a one-box scene in a fresh browser per run. Then every site demo loaded cold under a phone profile (`LOAD_PROFILE`, default `phone-layout-cold`) when `site/dist` is built. |
| `render` | browser | 10,000 boxes, 256 materials, 64 moving point lights, a 2048 shadow map, and SSAO + bloom + tone mapping + FXAA. |
| `objects` | browser | 10,000 objects as static meshes, moving meshes, instances and moving instances. |
| `scaling` | browser | 1, 100, 1,000, 10,000 and 100,000 meshes, then 100,000 and 250,000 instances, then 400, 5,000 and 10,000 shadow casters. |
| `math` | Node | Kernel world matrices and frustum culling for 100,000 meshes, 100,000 matrix compositions, BVH build and rays on 500,000 triangles, rays against a 500-part assembly. |
| `gltf` | browser | Load and draw DamagedHelmet, FlightHelmet and RobotExpressive, then the helmet with image-based lighting and shadows. |
| `loaders` | Node | PLY, 3MF, OFF, VTK and PCD files from the loaders tests, and a generated 500,000-triangle OBJ. |
| `cad` | Node and browser | Kernel tick for 10,017 to 89,883-part assemblies, 16 B-rep booleans and meshing, a STEP write, parse and tessellation, then 10,000 and 50,000-part assemblies drawn. |
| `voxel` | Node and browser | Fill a 256 x 64 x 256 terrain, mesh its 128 chunks, 10,000 voxel raycasts, then the voxel sandbox at render distance 8. |
| `physics` | Node | Rapier steps for 1,000 and 5,000 boxes, and the machinery conveyor solver for 500 parts. |
| `memory` | Node and browser | Heap and kernel memory per 100,000 meshes, then JS heap and live GPU memory after the boxes, instances and helmet scenes. |
| `compute` | | A stub. It fills in when the data track lands its compute kernels. |
| `viz` | | A stub. It fills in when the data track lands its charts and plots. |
| `react` | browser | Mount 1,000 boxes declared with `@margoengine/react`, then re-render all of them every frame. |
| `claims` | engine-bench | Opt-in: each other engine's own harness, recorded beside the shared scenes (see [Comparing engines](#comparing-engines)). |
| `features` | Node and browser | Opt-in, about an hour: the per-feature scripts in `examples/package-benchmarks` (CAD scale, culling, post stack, loader memory, shadow shimmer, instancing, atlas + VAT, workers, every real-browser test). Each runs once under the run's gate and GPU lock. Its logs and result files go to `benchmarks/runs/<id>/features/`, and the committed results are restored. |

`npm run bench` runs every suite except `features` and `claims`, which run only when named.
`npm run bench -- --list` prints every case id.

## Reading results

Each run writes three files to `benchmarks/runs/` (git-ignored):

- `<id>.json`: the result, schema `margo-bench/1`.
- `<id>.md` and `<id>.html`: the same as tables.

`<id>.png` screenshots of each browser case's first run go into `benchmarks/runs/<id>/`. The id is
`<date>-<time>-<commit>-<label>`.

Every result records:

- the engine version and commit, and whether `packages/` or `bench/` had uncommitted changes;
- the machine: CPU, threads, memory, OS and version, Node;
- the GPU name and driver (nvidia-smi, or the OS);
- the browser name and version, the WebGPU adapter and the user agent;
- the gate: AC power, the GPU lock, CPU and GPU load before the run, and the CPU load before each case;
- the options, and per suite its status and how long it took.

For each case and metric the result keeps the raw samples (one per run) and their summary:

- `median`: the number to quote.
- `p95`: the 95th percentile over runs (nearest rank; with 5 runs it is the slowest run).
- `spread`: (max - min) / median. Below 10% is steady.
- `noisy`: true when the spread is over `--noise`.

Primary metrics are bold in the report. If any primary metric is noisy, the run is invalid. Byte and count metrics
(`exact`) never are.

Browser metrics, per case (each run's value is that run's median over its frames):

| Metric | Meaning |
| --- | --- |
| `cpuMs` | Main-thread time of one frame: scene update + submit. |
| `gpuMs` | GPU time of one frame: the sum of every render and compute pass, from WebGPU timestamp queries the harness adds to every pass. Neither engine's own profiler is used. |
| `fps` | Frames finished by the GPU per second with vsync and the frame cap off. |
| `serialFrameMs` | Submit, then wait until the GPU is idle: latency with no pipelining. |
| `loadMs`, `firstFrameMs`, `createMs`, `buildMs` | Navigation to first finished frame; first frame alone; device and engine creation; scene build or model load. |
| `jsHeapMB`, `gpuMB`, `gpuPeakMB` | JS heap after two forced collections; live and peak GPU buffer and texture memory. |
| `jsBytes`, `drawCalls` | Script bytes the page fetched; draw calls the engine reports. |

## Comparing runs and catching regressions

```sh
npm run bench -- render --baseline            # this run becomes this machine's baseline
npm run bench -- render                        # later: compared with that baseline automatically
npm run bench -- render --compare=last         # with the previous run
npm run bench -- size --compare=ebff9bc4       # with the newest run of a commit
npm run bench -- --compare=benchmarks/records/<id>.json
```

A metric regresses when both of these hold:

- It is worse by more than the threshold: `--threshold`, default 5%, or the metric's own threshold (1% for bytes).
- It is worse by more than either run's spread, so noise alone never fails a run.

Which regressions fail the run:

- Byte and count metrics fail on any machine.
- Timings fail only for a valid run against a baseline from the same machine. The machine id hashes the CPU, threads,
  memory, GPU and OS. Timings from another machine are shown as "not judged".

The report lists each change, and the exit code is 1 when anything regressed. CI can run the deterministic suite
without a GPU:

```sh
npm run bench -- size --compare=benchmarks/baselines/<machine>.json
```

`benchmarks/baselines/<machine>.json` and `benchmarks/records/` are committed. Every other run stays local.

## Quiet-machine rules

The tool runs the gate before every run, so numbers from a busy or throttled machine are never mistaken for real ones:

1. **AC power.** On battery the run refuses to start. `BENCH_ALLOW_BATTERY=1` runs anyway and marks it invalid.
2. **GPU lock.** Any suite that uses the GPU holds `test-results/gpu.lock` in the main checkout
   (`scripts/gpu-lock.mjs`) for the whole run, so no other agent's GPU job overlaps it.
3. **Idle baseline.** Whole-machine CPU must stay at or under `--quiet-max` (20%) for `--quiet-hold` (20 s), from
   `scripts/quiet-gate.mjs`. On NVIDIA GPUs, utilisation must also be at or under `--gpu-max` (20%) in three
   samples. A GPU that stays busy marks the run invalid.
4. **Between cases.** The CPU load is checked again before each case. If it rose over the limit, the run waits for quiet
   (10 s hold).
5. **Repetition.** Each case gets 1 warm-up run and 5 measured runs. Browser runs also warm up for 60 frames before
   measuring 300.
6. **Noise.** If a primary metric's spread over runs is over 10%, the run is invalid.
7. **Fixed conditions.** Browser runs use headless Edge, a 1280 x 720 canvas at DPR 1, vsync and the frame cap off,
   and cross-origin isolation (fine timers). Builds are minified production bundles served without compression or
   caching. Startup and demo loads use a fresh browser per run.

`--no-gate` skips steps 1 and 3 for a quick look and marks the run invalid.

A number is official only if all of these hold:

- the run used `--label=official` with the defaults;
- the run is valid;
- it was recorded with `--record`.

Everything else is smoke or dev and must say so wherever it is quoted.

## The browser runner

[margoengine.com/bench/](https://margoengine.com/bench/) (source: `bench/index.html`, `bench/web/app.js`) runs these
browser suites on the visitor's machine: startup, render, objects, scaling, glTF, memory and React. It uses the
same scene page and harness as the CLI (`bench/scenes/`), loaded in a fresh same-origin frame per run. It shows the
median over runs next to our reference run in `bench/web/reference.json`, which `--record` writes. A smoke reference
never replaces an official one. Visitors can download their results as JSON. Startup numbers there reuse the page's
HTTP cache, so they read lower than the CLI's cold start.

Locally: `npm run build:site`, then open `site/dist/bench/` through any static server.

## Comparing engines

Every browser scene is described once, in `bench/scenes/catalog.js`. The description is plain data: positions,
rotations, colours, lights and the camera path for each frame. It also says what the scene draws and measures. Each
engine implements the scenes as an ES module:

```js
export const scenes = ['boxes', 'materials']; // scene ids this engine implements; others are skipped
export async function create(canvas, { scene, params, data }, marks) {
  // Build `scene` from `data` (the catalog's description) on `canvas`. Fill marks.createMs and marks.buildMs.
  return {
    render(t) {}, // apply frame time t (seconds, fixed 1/60 steps) and submit one frame
    idle: () => device.queue.onSubmittedWorkDone(), // resolves when the GPU has finished
    info: () => ({ drawCalls }), // optional
    gl: undefined, // set to the WebGL2 context for a WebGL engine (GPU time then uses timer queries)
  };
}
```

Margo's implementation is `bench/scenes/margo.js`. **Other engines' implementations never live in this repository.**
AGENTS.md "Clean room" forbids it. They live in `C:\Development\Projects\engine-bench\margo-bench\`, written there and
built there:

```text
engine-bench/
  node_modules/three, ...          the engines, installed there
  margo-bench/
    engines.json                   {"engines": {"three-webgpu": {"entry": "three-webgpu.js", "package": "three",
                                    "alias": {}, "sizeEntry": "three-webgpu-size.js"}}}
    three-webgpu.js                that engine's create() for the catalog's scenes
    three-webgpu-size.js           optional: its smallest lit-box app, for the size suite
    dist/<engine>/engine.js        built by the tool, served at /ext/<engine>/engine.js
```

`npm run bench -- render --engines=margo,three-webgpu` builds each engine's module with Vite in engine-bench, serves
it beside Margo's page and runs the same scenes with the same harness.

Comparisons are apples to apples by construction:

- **Interleaved runs.** The same scene in every engine forms one group. Each repetition runs every engine once, in
  one fixed order with a random first engine (A B A B ... or B A B A ...), so thermal and clock drift hits all of them
  alike. Each case records the order in `interleaved`.
- **Identical settings, recorded once.** `settings` in the result holds what all engines shared:
  - the browser binary and version, the 1280 x 720 canvas at DPR 1, and the flags that turn vsync and the frame cap
    off;
  - how the page is served, and the same model files;
  - warm-up and measured frames, and runs and warm-up runs;
  - each engine's version.

  Each case's `info.samples` records its MSAA.
- **One result file.** Every engine's cases sit in the same JSON, under the same `env` (machine, GPU, driver, gate),
  so engines can never be measured on different days by accident.
- **Published-claim mode.** `npm run bench -- claims --engines=all` (`bench:claims`) runs each engine's own benchmark
  harness where it lives, under the same gate and GPU lock. An engine opts in with
  `"harness": {"command": "npm run bench:render", "cwd": "wasmgpu-repo", "results": ["wasmgpu-repo/bench/out.json"]}` in
  `engines.json` (`command` is one shell command line; paths are relative to engine-bench). Its result files are copied to
  `benchmarks/runs/<id>/claims/<engine>/` and kept in the case as "<engine>'s own harness, not the shared scenes".
  Run it in the same session as the shared scenes, so both sets of numbers carry the same machine record. Case ids get an `@<engine>` suffix, such as
`boxes-10000@three-webgpu`. The tool reads engine-bench and writes only to `engine-bench/margo-bench/dist/`. It never
copies an engine's files into this repository. Each result records the version of every engine it ran.

## Adding a suite

1. Create `bench/suites/<name>.mjs` with a default export:

   ```js
   export default {
     name: 'mysuite',
     title: 'What it measures',
     uses: 'cpu', // 'none' (exact, no gate), 'cpu' (timed, gate) or 'gpu' (gate + GPU lock + browser)
     deterministic: false, // true: one run, no warm-up (sizes, counts)
     async cases(ctx) {
       return [
         {
           id: 'case-id',
           title: 'One line',
           metrics: { ms: { unit: 'ms', better: 'lower', primary: true } },
           async setup() {}, // optional, once before the runs
           async run({ first, warmup, index }) {
             return { values: { ms: 1.23 }, info: {} }; // one sample per metric
           },
           async teardown() {}, // optional
         },
       ];
     },
   };
   ```

2. Add the name to `SUITES` in `bench/suites/index.mjs` and a `bench:<name>` script in `package.json`.
3. Add it to the table above.

Helpers:

- `bench/lib/node.mjs`: `timed()`, `headlessEngine()` (core with a renderer that draws nothing), `memoryMB()`,
  `nodeCase()`.
- `bench/lib/browser.mjs`: `sceneCases(suite, {primary, keep})`, which turns `STANDARD[suite]` into browser cases.

A metric definition takes these fields:

- `unit` and `better` (`lower` or `higher`);
- `primary`: it decides validity;
- `exact`: bytes and counts, never noisy, judged on any machine;
- `threshold`: its own regression threshold.

A case may set `runs` or `warmup` when one sample is already a whole script run (the voxel sandbox does this).

## Adding a scene

1. Describe it in `SCENES` in `bench/scenes/catalog.js`: `title`, `draws`, `measures`, `params` with defaults and
   `data(params, {assets})`, which returns plain data. Every engine must be able to build the scene from that data.
2. Implement it in `bench/scenes/margo.js` (a `builders` entry) and add its id to `scenes`.
3. Add it to `STANDARD` for the suites that should run it. The browser runner picks it up from there.
4. Check it: `npm run bench -- <suite> --cases=<id> --runs=1`, then look at the screenshot in `benchmarks/runs/<id>/`.

## What the tool replaced

| Before | Now |
| --- | --- |
| `npm run bench:all` (`scripts/bench-all.mjs`) | `npm run bench`; its real-GPU steps are `npm run bench -- features`. Proofs stay `npm run proofs -- --current`. |
| `npm run bench:threejs` (`examples/package-benchmarks/vs-threejs/`) | `--engines=` with implementations in engine-bench. Margo's side and the harness moved to `bench/scenes/`. The three.js and Babylon.js files were deleted (clean room); the old harness is in git history before this change. |
| `npm run benchmark:three-vs-margo` (conveyor pages) | Deleted for the same reason. `examples/benchmark/conveyor-scene.js`, its test and the conveyor simulator (a port of a three.js app) followed on 24 October 2026. |
| `npm run measure:threejs` (`scripts/compare-threejs-size.js`) | `npm run bench -- size --engines=all`, with each engine's `sizeEntry` in engine-bench. `examples/package-benchmarks/results/threejs-size.json` stays as the record of the last measurement. |
| `npm run measure:demos` (`scripts/measure-demo-bytes.js`) | `npm run bench -- size --cases=demo-`. |
| `npm run benchmark:demo-loads` | `npm run bench -- startup --cases=demo-` (`LOAD_PROFILE` as before). |
| `npm run modern:bench:machinery` | The `physics` suite (conveyor solver) and `math` (assembly raycasts). |
| `npm run bench:voxel` | Now the `voxel` suite. `examples/voxel-sandbox/bench.mjs` still writes its own detailed record. |

Unchanged:

- `npm run measure:size` (the size gate in `verify`).
- `examples/package-benchmarks/entry-sizes.mjs` (the `sizes.html` record). The size suite calls its
  `measureEntries()`.
- `npm run proofs`.
- `scripts/quiet-gate.mjs` and `scripts/gpu-lock.mjs`, which the gate uses.
- The per-feature GPU scripts in `examples/package-benchmarks/` and their committed results.
