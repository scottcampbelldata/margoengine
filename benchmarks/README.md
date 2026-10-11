# Vexel benchmarks

Every benchmark result summarized here is committed next to this file, together with the commands that produced it. Results from hardware GPUs are not included yet.

The five libraries were published publicly as version `0.1.0` on 11 October 2026. Registry downloads matched the audited tarballs; a clean registry installation passed all package imports, embedded Wasm initialization and React 18.3.1 SSR. See [npm packages and install commands](../README.md#install-from-npm).

GPU suites run one at a time; the finalization and roller assembly checks need the Vite dev server (`npm run dev`). `BROWSER_CHANNEL` picks the browser (`msedge` by default, `bundled` for Playwright's Chromium), JSON `BROWSER_ARGS` passes launch flags, and `GPU_VENDOR` and `GPU_POWER` select and verify the adapter. On Windows, `scripts/gpu-adapters.ps1` lists adapter LUIDs, which vary by machine and session. Rebuilding the Rust kernel needs the toolchain pinned in `rust-toolchain.toml`; ordinary use relies on the checked in Wasm.

## SwiftShader runs (no GPU)

The files in [swiftshader/](swiftshader/) were recorded on 11 October 2026 at commit b3987dd on a Linux 6.12 virtual machine with 8 vCPU (Intel Xeon), 15 GiB RAM and no GPU, using Node.js 24.21.0, Rust 1.99.0 and Playwright Chrome Headless Shell 156.0.8078.4. WebGPU and WebGL2 ran on SwiftShader, a software Vulkan implementation, so GPU completion times in these files do not describe real graphics hardware.

| File | Contents |
| --- | --- |
| `bench-tick-b3987dd-run1.json` to `run3.json` | Three runs of the roller assembly tick and frame timing at 20, 200 and 240 rollers |
| `modern-finalization.json` | The finalization suite, including the 12,014 entity stress scene |
| `modern-browser.json` | The browser suite: 8 check groups for both backends and both starters |
| `modern-domains.json` | The domain suite: 8 check groups for caps, effects, particle sorting and device loss |
| `modern-packages.json` | The packed package suite: standalone imports, strict consumer types and React 18 |
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
