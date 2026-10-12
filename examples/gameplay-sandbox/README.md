# Afterlight — gameplay sandbox

An offline coastal island with concurrent WebGPU atmosphere, four PCSS shadow
cascades, procedural terrain, grass/rock scatter with three indirect LOD rings,
Gerstner ocean waves with terrain-coupled coastal flow, breaking foam and spray, up to one million GPU particles, a jointed
procedural explorer, damped third-person camera, HDR bloom and AgX presentation.
The character and landscape are generated locally; first launch fetches no assets.

The coast exchanges water between heightmap cells on the GPU. Waves enter from
the open ocean; water drains through channels and stays behind raised outlet
sills instead of animating isolated dips with an independent ocean wave. Foam
tracks moving shallow water, and the beach darkens towards the wet shoreline.
Water reflects the live atmospheric sky, refracts a retained HDR scene snapshot,
absorbs light by depth and catches the directional sun. Coherent wind-aligned
swells and micro-ripples reduce repeating interference grids. Water's own depth
target resolves overlapping wave triangles without modifying opaque scene depth.

From the repository root:

```sh
npm install
npm run dev:sandbox
npm run build --workspace examples/gameplay-sandbox
npm run test --workspace examples/gameplay-sandbox
```

WASD / arrows move, Shift runs, drag looks, double-click captures the mouse, and
Escape releases it. Touch devices expose movement and look sticks. The control
pill adjusts the sun clock, actual particle capacity, terrain wireframe and wave
height. Reduced motion starts paused. WebGPU support is required and failures
appear in the shell. Canvas size, texture resources and device restoration are
handled by the engine and optional plugins.

Source aliases let Vite build directly from the local packages. The example adds
no features to core or stage. CI builds/tests this workspace and retains the
existing core + stage gzip gate of 20,480 bytes.

## Allocation audit and reproducible hardware checks

The simulation mutates retained Float32Array input, character, camera delta and
sun vectors. The camera's precise spring solver retains its existing Float64Array
state. Bloom/AgX, water, scatter, sky and shadow passes reuse descriptors and
attachment records, changing views in place. Bind groups, views, shader variants
and scratch math are retained until resize, device restoration or control changes.
Numeric stats samples update every frame; DOM text refreshes every 150 ms.
Optional timestamp readbacks sample every 15 frames and skip pending readbacks;
timestamp profiling is disabled in this sandbox.

```sh
# Production build, physical WebGPU, all particle tiers and exactly 600 frames.
npm run verify --workspace examples/gameplay-sandbox

# Add V8 allocation sampling and two separate 600-frame diagnostic captures.
npm run verify --workspace examples/gameplay-sandbox -- --allocations --diagnose

# Shorter memory run without the 10/10/30-second tier benchmarks.
npm run verify --workspace examples/gameplay-sandbox -- --memory-only
```

Verification uses installed Microsoft Edge by default. Set `BROWSER_CHANNEL`
to another Playwright Chromium channel if needed. A software adapter is rejected.
Reports, Chromium traces, a DevTools-loadable `.heapprofile`, source-mapped
allocation sites and desktop/mobile screenshots are written under
`test-results/gameplay-sandbox/`. Sampling runs have extra profiler overhead;
use the normal verification command for the performance gate. No keyboard or
pointer events are dispatched during memory capture. Capture completion uses a
single preallocated promise, avoiding polling inside the measured window.

The memory gate allows at most 128 KiB retained heap drift, one Minor GC and zero
Major GCs over 600 frames. Forced endpoint collections occur outside the trace.
Matched endpoints measure retained memory, not total allocation. The gate stays
strict: verification exits unsuccessfully if it detects additional collections,
after saving evidence and completing the functional checks.

Initial physical NVIDIA Ampere measurements at 1440 × 900 held approximately
60 FPS at all three particle tiers. A GPU completion fence also verifies queued
work has finished; frame callback frequency alone can overstate GPU throughput
when using Chromium's uncapped-rendering flags. The allocation audit removed explicit
per-frame arrays, views, descriptors, bind groups and shader-string rebuilding
from the exercised optional paths. Minor GCs still occur in the complete browser
render loop; disabling DOM stats text did not remove them, while disabling
counter instrumentation reduced them. V8 sampling also identified shadow draw
calls and frozen-core render traversal. Browser WebGPU wrappers, numeric boxing
and core iteration remain potential contributors. **Literal zero allocation and
the strict GC gate are not yet verified.** Consult the current JSON report for
measured counts rather than inferring allocation freedom from retained heap.

Before terrain-coupled flow was added, the normal-cadence capture measured 5 Minor GCs, 0 Major GCs, 4,128 bytes
retained drift and 3.08 ms total GC time over 600 frames. Disabling text refresh
still measured 5 Minor GCs; disabling counter instrumentation measured 4.

With surf and HDR water optics enabled, physical AMD RDNA2 measurements at
1440 × 900 reached 50.9 / 44.3 / 37.9 FPS at 100k / 500k / 1M particles. The prior
coastal-flow scene measured 56.7 / 48.4 / 41.3 FPS on this adapter. The current
600-frame hands-off trace retained 1,564 bytes, with 6 Minor and 3 Major GCs;
the strict GC gate correctly failed. Functional checks, GPU conservation/spray
checks and triangle-order independence passed. Reports are saved under
`test-results/gameplay-sandbox-amd/surf-verification.json`.

The same updated production scene on NVIDIA RTX A6000 held approximately 60 FPS
at all three tiers. Its 600-frame capture retained 3,708 bytes, with 5 Minor and
1 Major GC; the allocation gate also failed on this adapter. See
`test-results/gameplay-sandbox-nvidia/surf-verification.json`.

The optional water bundle increased from 6,393 to 10,181 gzip bytes for the surf,
depth ordering and optics changes. Core + stage remains 20,053 gzip bytes, below
the 20,480-byte ceiling. This is a compact shallow-water approximation with
spray, not a volumetric overturning-wave simulation. The optics add GPU work;
one million particles do not reach 60 FPS on this integrated AMD adapter.
