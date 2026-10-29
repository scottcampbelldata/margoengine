# Reproducing Margo's numbers

Every public number should come from one of the commands below. Run them from the repository root on the commit you
want to check. Status of each claim and which command backs it: [claims.md](claims.md).

## Setup (once)

```sh
git clone https://github.com/scottcampbelldata/margoengine.git && cd margoengine
npm ci                     # Node 24.18+; installs three@0.186.1, Vite, Playwright and the test tooling
npx playwright install msedge   # or set MARGO_BROWSER=chrome; the real-GPU scripts default to Edge
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
`test-results/quickstart-timing/`. It fails over 300 s from the first command to the verified interactive frame, and ends
every process it started at a hard limit of 900 s. It is a step of `check:merge`, so the nightly full run has it too.
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
| Core + stage gzip (CI gate, < 20,000 B) | `npm run measure:size` | no | console | Also enforced by `npm run build:packages`. |
| Margo vs other engines, bundle size | `npm run bench -- size --engines=all` | no | `benchmarks/runs/<id>.json` | Each engine's smallest lit-box app from engine-bench (`sizeEntry`) vs Margo's whole core + stage, all built with the size gate's output options. The last three.js measurement stays in `results/threejs-size.json`. |
| Every package entry and worker, min+gzip | `node examples/package-benchmarks/entry-sizes.mjs` (after `build:packages`) | no | `results/entry-sizes.json` | build-modern's method, other packages external; also feeds the Gzip column of `docs/api-surface.md`. |
| Eager JS per demo | `npm run bench -- size --cases=demo-` | no | `benchmarks/runs/<id>.json` | Builds each demo with Vite. |
| Per-package min+gzip | `node examples/package-benchmarks/proofs/size.js` | no | `proofs/results/sizes.json` | |
| VFX entry sizes | `node examples/package-benchmarks/vfx-size.mjs` | no | `results/vfx-size.json` | |
| Package optimization proofs (same GPU calls / same output, faster) | `node examples/package-benchmarks/proofs/<name>.proof.js [ref]` | no (recording mock GPU) | `proofs/results/<name>.json` | Each builds a baseline ref; some default refs no longer build (see claims.md). |
| Kernel tick in Node | `npm run bench -- cad --cases=kernel` (or `node examples/package-benchmarks/cad/kernel-node.mjs`) | no | `benchmarks/runs/<id>.json` (`cad/results-kernel-node.json`) | |
| glTF export: validator errors and export time | `node examples/package-benchmarks/exporters-model.mjs` | no | `results/exporters-model.json` | Khronos glTF-Validator from node_modules; the timing needs the quiet PC. |
| Textured instancing, encoding CPU | `node examples/package-benchmarks/textured-instancing.mjs` | no (mock) | `results/textured-instancing.json` | Mock GPU: CPU encoding only, not frame rate. |
| **Margo vs other engines, same scenes** | `npm run bench -- render objects scaling --engines=all` | yes | `benchmarks/runs/<id>.json`, screenshots in `benchmarks/runs/<id>/` | Scenes in `bench/scenes/catalog.js`; other engines' implementations live in engine-bench. Earlier results: `results/vs-threejs-*.json`. |
| GPU culling | `node examples/package-benchmarks/cad/culling.mjs --check --label=<name>` | yes | `cad/results-<name>.json` | |
| Post stack per effect, SSAO + IBL | `node examples/package-benchmarks/gates/post-stack.mjs` | yes | `results/gates-post-stack.json` | |
| DOF before/after | `node examples/package-benchmarks/gates/dof.mjs --baseline=5b9dbbd` | yes | `results/gates-dof.json` | Builds the baseline. |
| Loaders + memory cycles | `node examples/package-benchmarks/gates/memory.mjs` | yes | `results/gates-memory.json` | |
| Shadow shimmer | `node examples/package-benchmarks/shadow-shimmer.mjs` | yes | `results/shadow-shimmer.json` | |
| Textured instancing on GPU | `node examples/package-benchmarks/textured-instancing-gpu.mjs` | yes | `results/textured-instancing-gpu.json` | |
| Atlas + VAT | `node examples/package-benchmarks/atlas-vat/check.mjs` | yes | `test-results/atlas-vat-check.json` | Result is not committed today. |
| Workers / OffscreenCanvas | `node examples/package-benchmarks/workers/run.mjs` | yes | `results/workers.json` | Edge and Chrome. |
| VFX 100k/1M particles | `node examples/package-benchmarks/vfx-gpu.mjs --a=<dist> --b=packages/vfx/dist` | yes | `results/vfx-gpu-*.json` | A/B of two builds: snapshot a baseline dist first (header of the script). Not in the features suite. |
| Island demo with VFX | `node examples/package-benchmarks/vfx-island.mjs --variants=...` | yes | `results/vfx-island-*.json` | Needs variant builds. Not in the features suite. |
| Pipeline toggles | `node examples/package-benchmarks/pipeline-toggles/toggle.mjs [stall|pixels|gpu|override]` | yes | `results/pipeline-toggles.json` | Not in the features suite (needs `old-gltf.mjs` first for `pixproof`). |
| Every real-browser test | `node examples/package-benchmarks/gates/run-browser-tests.mjs` | yes | `results/gates-browser-tests.json` | 41 scripts; `modern-hardware-gpu-tests.js` needs `GPU_VENDOR` and a discrete GPU. |
| Unit tests, API snapshots, size gate | `npm run verify` | no | console | `npm run verify:full` adds packed-package and interop suites. |

## A second machine

On a discrete-GPU desktop or a Mac: the setup above, then `npm run bench` and `npm run bench -- features`, and
keep the `benchmarks/runs/` folder. On Linux or macOS the AC check returns `null` (recorded, not enforced). Set
`MARGO_BROWSER=chrome` where Edge is not installed. Phones are not scripted yet.
