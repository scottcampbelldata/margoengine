# Reproducing Margo's numbers

Every public number should come from one of the commands below. Run them from the repository root on the commit you
want to check. Status of each claim and which command backs it: [claims.md](claims.md).

## Setup (once)

```sh
git clone https://github.com/scottcampbelldata/margoengine.git && cd margoengine
npm ci                     # Node 22.12+; installs three@0.186.1, Vite, Playwright and the test tooling
npx playwright install msedge   # or set BROWSER_CHANNEL=chrome; the real-GPU scripts default to Edge
npm run build:packages     # every package, size gates, catalog (no Rust toolchain needed; the Wasm is checked in)
```

## Everything in one command

```sh
npm run bench:all              # size + CPU + recorded-GPU-call proofs; no GPU needed
npm run bench:all -- --gpu     # also every real-GPU benchmark (AC power, GPU lock, about an hour on a laptop)
npm run bench:all -- --list    # the steps
npm run bench:all -- --only=size,vs-threejs   # groups (size, cpu, proofs, gpu) or step names
```

`scripts/bench-all.mjs` runs each step serially and writes `test-results/bench/<date>/`: one `<step>.log` per step,
every result file the step wrote (moved out of the tree; the committed versions are restored, so a run never changes
committed results), and `manifest.json` with the commit, host, exit code, duration and AC power per step. It refuses
to start when `examples/package-benchmarks/` has uncommitted changes. A failing step is recorded and the run goes on.

## Whitepaper timing run (pending: needs a quiet PC)

The harnesses in this repo have only been smoke-tested so far (2026-10-14, a busy machine, few frames, marked "SMOKE
TEST, NOT FOR PUBLICATION"). No timing number from them is whitepaper data yet. When Scott confirms the machine is
quiet (no other apps, no builds, no other agents, on AC power), run this once on the release commit:

```sh
npm run build:packages
BENCH_QUIET=1 npm run bench:all -- --gpu      # PowerShell: $env:BENCH_QUIET=1; npm run bench:all -- --gpu
```

That runs every size, CPU and proof step, then every real-GPU step including the vs-three.js head-to-head (5 rounds x
300 frames, about 30-45 minutes on its own), and writes one dated folder under `test-results/bench/`. Copy the JSON the
whitepaper cites into `examples/package-benchmarks/results/` and commit it with the paper.

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
| Margo vs three.js bundle size | `npm run measure:threejs` | no | console | Minimal lit-box app in three r186 (WebGL and WebGPU) vs Margo's whole core + stage. Prints only; commit the output with the whitepaper. |
| Eager JS per demo | `npm run measure:demos` | no | console / `--json=path` | Builds each demo with Vite. |
| Per-package min+gzip | `node examples/package-benchmarks/proofs/size.js` | no | `proofs/results/sizes.json` | |
| VFX entry sizes | `node examples/package-benchmarks/vfx-size.mjs` | no | `results/vfx-size.json` | |
| Package optimization proofs (same GPU calls / same output, faster) | `node examples/package-benchmarks/proofs/<name>.proof.js [ref]` | no (recording mock GPU) | `proofs/results/<name>.json` | Each builds a baseline ref; some default refs no longer build (see claims.md). |
| Kernel tick in Node | `node examples/package-benchmarks/cad/kernel-node.mjs` | no | `cad/results-kernel-node.json` | |
| glTF export: validator errors and export time | `node examples/package-benchmarks/exporters-model.mjs` | no | `results/exporters-model.json` | Khronos glTF-Validator from node_modules; the timing needs the quiet PC. |
| Textured instancing, encoding CPU | `node examples/package-benchmarks/textured-instancing.mjs` | no (mock) | `results/textured-instancing.json` | Mock GPU: CPU encoding only, not frame rate. |
| **Margo vs three.js, same scenes** | `npm run bench:threejs` (`examples/package-benchmarks/vs-threejs/run.mjs`) | yes | `results/vs-threejs.json`, `test-results/vs-threejs/*.png` | See [vs-three.js](../../examples/package-benchmarks/vs-threejs/README.md). |
| CAD scale 10k/50k/90k parts | `node examples/package-benchmarks/cad/run.mjs --sizes=10000,50000,max --label=<name>` | yes | `cad/results-<name>.json` | `--edges` feature edges, `--low` 1x MSAA, `--step` OCCT STEP/IGES load. Takes no lock itself (bench:all takes it). |
| GPU culling | `node examples/package-benchmarks/cad/culling.mjs --check --label=<name>` | yes | `cad/results-<name>.json` | |
| Post stack per effect, SSAO + IBL | `node examples/package-benchmarks/gates/post-stack.mjs` | yes | `results/gates-post-stack.json` | |
| DOF before/after | `node examples/package-benchmarks/gates/dof.mjs --baseline=5b9dbbd` | yes | `results/gates-dof.json` | Builds the baseline. |
| Loaders + memory cycles | `node examples/package-benchmarks/gates/memory.mjs` | yes | `results/gates-memory.json` | |
| Shadow shimmer | `node examples/package-benchmarks/shadow-shimmer.mjs` | yes | `results/shadow-shimmer.json` | |
| Textured instancing on GPU | `node examples/package-benchmarks/textured-instancing-gpu.mjs` | yes | `results/textured-instancing-gpu.json` | |
| Atlas + VAT | `node examples/package-benchmarks/atlas-vat/check.mjs` | yes | `test-results/atlas-vat-check.json` | Result is not committed today. |
| Workers / OffscreenCanvas | `node examples/package-benchmarks/workers/run.mjs` | yes | `results/workers.json` | Edge and Chrome. |
| VFX 100k/1M particles | `node examples/package-benchmarks/vfx-gpu.mjs --a=<dist> --b=packages/vfx/dist` | yes | `results/vfx-gpu-*.json` | A/B of two builds: snapshot a baseline dist first (header of the script). Not in bench:all. |
| Island demo with VFX | `node examples/package-benchmarks/vfx-island.mjs --variants=...` | yes | `results/vfx-island-*.json` | Needs variant builds. Not in bench:all. |
| Pipeline toggles | `node examples/package-benchmarks/pipeline-toggles/toggle.mjs [stall|pixels|gpu|override]` | yes | `results/pipeline-toggles.json` | Not in bench:all (needs `old-gltf.mjs` first for `pixproof`). |
| Every real-browser test | `node examples/package-benchmarks/gates/run-browser-tests.mjs` | yes | `results/gates-browser-tests.json` | 41 scripts; `modern-hardware-gpu-tests.js` needs `GPU_VENDOR` and a discrete GPU. |
| Unit tests, API snapshots, size gate | `npm run verify` | no | console | `npm run verify:full` adds packed-package and interop suites. |

## A second machine

On a discrete-GPU desktop or a Mac: the setup above, then `npm run bench:all -- --gpu` and send back the
`test-results/bench/<date>/` folder. On Linux or macOS the AC check returns `null` (recorded, not enforced). Set
`BROWSER_CHANNEL=chrome` where Edge is not installed. Phones are not scripted yet (see outline.md).
