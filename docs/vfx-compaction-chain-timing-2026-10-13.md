# Private compaction compute-and-draw timing preparation

Prepared only. Existing54 no-birth state/set/count checks and27 respawn cases remain unchanged; they contain no speed or actual-order HDR image pass. This new fixture can reject a slower candidate before image acceptance is settled. It cannot support adoption or a lossless-output claim.

Review metadata without native/browser/server execution:

```powershell
node test-results/vfx-compaction-chain-timing.mjs --label=chain-v1
```

Only after root grants the exclusive GPU/CPU slot:

```powershell
node test-results/vfx-compaction-chain-timing.mjs --run --label=chain-v1
```

The new launcher serves the immutable public VFX/Core files from `vfx-compaction-headless-quality-v1/fixture`, verifying their entire saved file manifest. It does not build or use the current dirty public dist. Original/control/grouped WGSL comes from that frozen fixture config and must match the preserved preparation hashes. The old `vfx-render-chain-native.mjs` supplies the chain pattern; its different in-place variants,4× targets and canonical image check are not reused as acceptance evidence. Existing fixtures, package source and raw results are untouched.

| Frozen simulation | Width | SHA256 |
|---|---:|---|
|original256|256|`72f1d762fab9e6e5c03794a0395597c8142e71a1d023ae3faf0dfffab60de8df`|
|control64|64|`1d3df8e1e7c535e3f6c173fda9eb1b16c619c606dfb454ee604e93e20d919521`|
|grouped64|64|`8a9cbb1327c6db23b11a8e7fce7520260a824b3140286aa3777d6a685068b886`|

Frozen public VFX SHA256 is `e6d1f080f91f4a623aeb38ce675b892319005d22de26ba1766f1bad588ea1a55`. Original shader-source file SHA256 is `d42742af00b8d7f4d37a91b4c9b65e8071cd3c6e00f16f8a4fd6f6b6c70c1cd0`; original host-source SHA256 is `6c53a399348e95adadf89c5c33ada36cb45e8cb3c62be41203865f31200a7881`. The new launcher/helper hashes and bounded workload are in [the preparation manifest](../test-results/vfx-compaction-chain-preparation-20261013.json).

One native Intel/nonfallback device explicitly requests timestamp-query and depth32float-stencil8, with no developer/debug/vsync flags. The target is1× rgba16float1432×768 and blank reversed-Z depth32float-stencil8. The retained VFX class creates its actual render pipeline, uses unchanged alpha blending and consumes its own actual atomic alive IDs and indirect buffer. No canonical IDs are substituted. The original native-camera values are retained from `vfx-island-native-ab.json` and hashed. This isolates VFX work without island occlusion, other scene passes or presentation; it is not full-app FPS.

Both inputs use1M capacity and the same64B records/224B class-packed uniforms. Full-live input uses finite25–45s lifetime, live records and zero birth budget. Finite-respawn input mixes live, expiring and expired records, with rate50,000/s and the actual CPU packer's two consecutive1/60s headers. The first two budgets are normally833/833;834 arises on a later frame and is not fabricated here. Actual packed budgets are reported. Gravity, curl, rotation, bounce, emission, alpha and dispatch math remain in the frozen shaders/class.

Per input, separate original-A/A, original/control64 and original/grouped64 blocks each encode four alternating pairs `[A,B],[B,A],[B,A],[A,B]`. Every chain has two compute+actual-draw frames. Both members of each pair occupy the same command buffer. Standard pass `timestampWrites` reports compute, draw, their sum and first-compute-to-last-draw chain span.64 queries and two pooled timestamp buffers are reused blockwise; native ns remain BigInt strings with an uncalibrated GPU clock and unknown quantization. No per-frame await, fence, GPU allocation, query creation or readback is inside measured passes. Lazy pipelines compile before timing. Seed/reset copies precede chain timestamps; clear/header/counter operations between frames remain in the chain span. Reset copies can affect cache state; original A/A uses the same reset buffer bank, so it is a diagnostic of repeat/order noise rather than a perfect substitute for cross-bank A/B behavior. The two A/B comparisons are separate blocks; a direct control64/grouped64 causal pairing is not claimed.

Untimed diagnostics repeat original A twice, then control and grouped from identical inputs. They compare every state word, nonfinite fields, actual alive set/order and indirect ABI; A/A differences are recorded independently from A/B. Full-live no-birth state/set/count must retain the proven invariant. Finite-respawn variation is reported without accepting a mismatch as exact parity. No HDR/depth pixel comparison occurs, and equal counts/sets do not establish image quality. Private COPY_SRC usage is added consistently to storage buffers for these stopped readbacks only; no production usage flag changes.

The fixed workload is96 measured updates/draws,24 warm updates/draws,16 diagnostic updates/draws and3 initial pipeline draws:136 compute dispatches,139 actual draws and11 successful native submits, each containing one command buffer. Runtime counts must match. There are no retries or hidden extra timing loops. Declared fixture buffers/textures total roughly558MB before driver internals; at most two68MB diagnostic mappings are inspected together, plus seed/setup temporaries. These are fixture declarations, not a process-residency guarantee.

The whole page evaluation has a60s observation limit and the existing native watcher a65s limit. Persistent context closure is observed for35s afterward, with targeted exact PID/start-time absence checks. Those are host observation bounds, **not** guaranteed GPU completion or a device reset policy. Shader compilation, driver stalls and a hung GPU can outlive JavaScript timeouts; such a run fails and requires exact owned cleanup before another launch. Resource cleanup is in finally, the shared device is destroyed by the launcher once, and user Chrome is untouched. Existing strict Default-desktop/owned-foreground/known-AC/saver-off guards are reused. Root must ensure no competing capture/load; this launcher neither starts nor stops WPR.

Only short Node syntax checks and lightweight source-hash preparation have run. CPU/runtime preflight and GPU compilation/execution are deferred while root's raw ETL scan holds the CPU/I/O slot. No speed, image, hardware-ceiling, byte-gate or adoption result is claimed.
