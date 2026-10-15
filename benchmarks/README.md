# Margo Engine validation record

**Current numbers live elsewhere.** Every claim Margo publishes, with its hardware, its committed result and the command that reproduces it, is in [docs/whitepaper/claims.md](../docs/whitepaper/claims.md). Today's core + stage size is printed by `npm run measure:size` (19,543 bytes gzip at `3d845a0`, WebGPU backend only; the build fails at 20,000). This page keeps the 11 October 2026 validation record, from before the `@margoengine` rename, and the committed SwiftShader runs.

For release fault injection, deterministic hardware-limit fuzzing, lifecycle soaks and sharded campaigns, see [stress testing](stress-testing.md). Run `npm run test:release` before publishing; it includes a 500-session matrix in addition to the existing regression suites. The [stress validation log](stress-results.md) describes local NVIDIA/AMD campaigns whose raw data was not committed.

Run `npm run benchmark:three-vs-margo` after `npm run build:packages` for the automated Three.js **0.186.1** comparison. Install Playwright Chromium (`npx playwright install chromium`) or select an installed Chromium browser with `BROWSER_CHANNEL`. The runner serves gzipped production bundles through a local Vite server, renders exactly 1,200 frames per scene, records CDP heap/GC and Resource Timing data, and counts actual GPU/GL API draws and dispatches. Results are written to [results.md](results.md) and `test-results/benchmark-three-vs-margo.json`. `BROWSER_ARGS` accepts extra Chromium flags. A missing WebGPU adapter fails explicitly; use a physical adapter for performance claims or explicit SwiftShader flags for validation only. The committed [results.md](results.md) ran with vsync on and three.js drawing plain `Mesh` objects, so it shows payload and GC counts, not speed. No same-machine speed comparison with three.js has been published yet.

On 11 October 2026, before the rename, the then five libraries were published to npm as `0.1.0` under their pre-rename names. The `@margoengine/*` packages are not published yet. That day the core, then 19,874 bytes gzip with WebGL2 still inside it, also passed browser suites on an NVIDIA RTX A6000 and an AMD Radeon integrated GPU, a machinery browser matrix in Chrome 154 and Edge 155, and Night Citadel pacing runs. Those raw traces, heap profiles and logs stayed local and the code has changed a great deal since, so none of their timings is quoted as a current result.

GPU suites run one at a time; the finalization and roller assembly checks need the Vite dev server (`npm run dev`). `BROWSER_CHANNEL` picks the browser (`msedge` by default, `bundled` for Playwright's Chromium), JSON `BROWSER_ARGS` passes launch flags, and `GPU_VENDOR` and `GPU_POWER` select and verify the adapter. On Windows, `scripts/gpu-adapters.ps1` lists adapter LUIDs, which vary by machine and session. Rebuilding the Rust kernel needs the toolchain pinned in `rust-toolchain.toml`; ordinary use relies on the checked in Wasm.

## SwiftShader runs (no GPU)

The files in [swiftshader/](swiftshader/) were recorded on 11 October 2026 at commit b3987dd on a Linux 6.12 virtual machine with 8 vCPU (Intel Xeon), 15 GiB RAM and no GPU, using Node.js 24.21.0, Rust 1.99.0 and Playwright Chrome Headless Shell 156.0.8078.4. WebGPU and WebGL2 ran on SwiftShader, a software Vulkan implementation, so GPU completion times in these files do not describe real graphics hardware.

| File | Contents |
| --- | --- |
| `bench-tick-b3987dd-run1.json` to `run3.json` | Three runs of the roller assembly tick and frame timing at 20, 200 and 240 rollers |
| `modern-finalization.json` | The finalization suite, including the 12,014 entity stress scene |
| `modern-browser.json` | The browser suite: 8 check groups for both backends (WebGL2 was still in core at b3987dd) and both starters |
| `modern-domains.json` | The domain suite: 8 check groups for caps, effects, particle sorting and device loss |
| `modern-packages.json` | The packed package suite: standalone imports, strict consumer types and React 18 |
| `conveyor-check-picking-failure.txt` | Output of the full `modern:check:conveyor` run, which fails at its live picking step on SwiftShader (the absolute checkout path is shortened) |

To repeat, follow the commands in [README.md](../README.md). GPU suites run sequentially; finalization and live conveyor checks require the Vite dev server. `GPU_VENDOR`, `GPU_POWER` and JSON `BROWSER_ARGS` select the adapter; `scripts/gpu-adapters.ps1` lists Windows adapter LUIDs, which vary by machine/session. A Rust source rebuild also requires the toolchain pinned in `rust-toolchain.toml`; ordinary consumers use the checked-in embedded Wasm.

### Setup

```sh
npm ci
npx playwright install chromium
D=~/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64
export VK_ICD_FILENAMES=$D/vk_swiftshader_icd.json LD_LIBRARY_PATH=$D BROWSER_CHANNEL=bundled
export BROWSER_ARGS='["--enable-unsafe-webgpu","--enable-features=Vulkan","--use-vulkan=swiftshader","--use-webgpu-adapter=swiftshader","--use-angle=swiftshader","--enable-unsafe-swiftshader"]'
npm run build
npm run dev &    # the timing and finalization checks use the Vite dev server
```

Adjust `D` to the headless shell folder Playwright installed on your machine.

### Tick and frame timing

```sh
npm run modern:check:conveyor -- --timing-only
```

This loads the demo roller assembly at 20, 200 and 240 rollers. For each size it times 300 ticks of the motor drive, gear couplings and Wasm transform update after 120 warm up ticks, then times 180 rendered frames split into JavaScript before the tick, the Wasm export, and scene collection, encoding and upload. It writes `test-results/modern-conveyor-timing.json` and skips the picking and drag trace steps. The browser timer resolves 0.1 ms, so the summary uses means over 10 tick windows.

The three committed runs were recorded with a copy of the same timing section before the `--timing-only` flag existed; a later run with the flag gave results in the same range.

### Other suites

```sh
npm run modern:test:browser
npm run modern:test:domains
npm run modern:test:packages
```

Each writes the matching JSON file to `test-results/`. The browser suite file in this folder was recorded after the `BROWSER_CHANNEL` change to the test scripts; the engine code is the same as at b3987dd.

### Stress scene

```sh
npm run modern:test:finalization
```

The stress entry in `test-results/modern-finalization.json` reports CPU and GPU completed times over 60 frames for an assembly of 500 rollers plus 10,000 shared geometry parts. On SwiftShader only the CPU figures are meaningful.
