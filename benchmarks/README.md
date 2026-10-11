# Vexel validation baseline

These measurements were captured on 11 October 2026 before the Vexel rename. Historical captures retain their original package names. Raw traces, heap profiles, machine inventories, logs and recovery archives remain local; this repository contains portable summaries and the scripts needed to repeat the checks.

The locked core measures **19,874 bytes gzip**, leaving **606 bytes** below its 20 KiB budget. Its embedded Wasm is **12,046 bytes raw**, with SHA-256 `c9fade2492bc1af53dfd33ece4086e34e634634ea4fea3dec28491c162327fed`. The rename preserves the core implementation and embedded Wasm.

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
