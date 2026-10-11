# Vexel validation baseline

These measurements were captured on 11 October 2026 before the Vexel rename. Historical captures retain their original package names. Raw traces, heap profiles, machine inventories, logs and recovery archives remain local; this repository contains portable summaries and the scripts needed to repeat the checks.

The locked core measures **19,874 bytes gzip**, leaving **606 bytes** below its 20 KiB budget. Its embedded Wasm is **12,046 bytes raw**, with SHA-256 `c9fade2492bc1af53dfd33ece4086e34e634634ea4fea3dec28491c162327fed`. The rename preserves the core implementation and embedded Wasm.

The Vexel rename passed 31 JavaScript tests, four Rust tests, eight AMD browser groups and four standalone package/React 18 groups. A fresh checkout passed `npm ci`, `npm test` and both production builds. All 37 fingerprinted core source/distribution and Rust source files remained byte-for-byte unchanged, as did 120 installed dependency versions. Full stress benchmarks were not repeated for the rename.

The five libraries were published publicly as version `0.1.0` on 11 October 2026. Registry downloads matched the audited tarballs; a clean registry installation passed all package imports, embedded Wasm initialization and React 18.3.1 SSR. See [npm packages and install commands](../README.md#install-from-npm).

After removal of the earlier renderer, 31 JavaScript tests, four Rust tests, production Vite/Next builds and 32 browser check groups passed on physical AMD Radeon integrated graphics. The browser groups cover React 18/19, standalone packed consumers, WebGPU and WebGL2, integer picking, caps, particles/effects, resize, both device-destruction scenarios and conveyor stress.

| Workload | AMD Radeon integrated RDNA 2 | NVIDIA RTX A6000 |
| --- | --- | --- |
| 240-roller motor/coupling/Wasm tick mean | 0.050 ms | 0.050 ms |
| Tick ten-tick-window p95 | 0.060 ms | 0.060 ms |
| Complete submitted CPU frame mean | 0.221 ms | 0.211 ms |
| 12,014 entities: CPU median / p95 | 2.2 / 3.0 ms | 2.0 / 3.2 ms |
| 12,014 entities: GPU-completed median / p95 | 15.9 / 17.7 ms | 5.8 / 7.7 ms |

The conveyor retained two instanced geometry batches at 20, 200 and 240 rollers. The large fixture retained three batches and 5,373,952 bytes of Wasm memory. Picking and selected-pivot orbit passed; grazing-angle checks resolved a 0.4 mm fitting and 0.1 mm surface separation. Device recovery retained CPU state and replaced buffers, textures, views, bind groups and pipelines. Combined passes retained cap depth and reused descriptor shells.

These are headless submitted-work timings, not sustained presentation/FPS guarantees. The final post-cleanup 15-second drag recorded one minor and one major collection, no tasks over 50 ms and no runtime errors. Earlier isolated AMD/NVIDIA traces each recorded one minor collection. None establish zero allocation or zero GC. Firefox/Safari, mobile GPUs and physical driver-reset/OOM recovery remain unverified.

To repeat, follow the commands in [README.md](../README.md). GPU suites run sequentially; finalization and live conveyor checks require the Vite dev server. `GPU_VENDOR`, `GPU_POWER` and JSON `BROWSER_ARGS` select the adapter; `scripts/gpu-adapters.ps1` lists Windows adapter LUIDs, which vary by machine/session. A Rust source rebuild also requires the toolchain pinned in `rust-toolchain.toml`; ordinary consumers use the checked-in embedded Wasm.

## SwiftShader runs (no GPU)

The files in [swiftshader/](swiftshader/) were recorded on 11 October 2026 at commit b3987dd on a Linux 6.12 virtual machine with 8 vCPU (Intel Xeon), 15 GiB RAM and no GPU, using Node.js 24.21.0, Rust 1.99.0 and Playwright Chrome Headless Shell 156.0.8078.4. WebGPU and WebGL2 ran on SwiftShader, a software Vulkan implementation, so GPU completion times in these files do not describe real graphics hardware.

| File | Contents |
| --- | --- |
| `bench-tick-b3987dd-run1.json` to `run3.json` | Three runs of the roller assembly tick and frame timing at 20, 200 and 240 rollers |
| `modern-finalization.json` | The finalization suite, including the 12,014 entity stress scene |
| `conveyor-check-picking-failure.txt` | Output of the full `modern:check:conveyor` run, which fails at its live picking step on SwiftShader (the absolute checkout path is shortened) |

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

### Stress scene

```sh
npm run modern:test:finalization
```

The stress entry in `test-results/modern-finalization.json` reports CPU and GPU completed times over 60 frames for an assembly of 500 rollers plus 10,000 shared geometry parts. On SwiftShader only the CPU figures are meaningful.
