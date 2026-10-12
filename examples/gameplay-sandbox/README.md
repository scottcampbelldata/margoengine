# Afterlight — gameplay sandbox

The sandbox consumes public package exports and built distributions. Cabin,
foliage, grass, island height sampling, explorer rig/pose, placement, terrain mesh
and heightmap ownership, camera orbit/clearance, lighting and particles all come
from shared modules under `packages/`. The example contains scene coordinates,
material palettes, module composition and UI/input wiring. A boundary test rejects
custom GPU resources, geometry generators and camera math in its source.

The scene enables the shared sky's procedural cloud layer and scatter's GPU wind
for grass, trees, shrubs and ferns. Moving trees use dynamic PCSS shadows; cloud
motion also appears in the sky environment sampled by water. These effects live
in the optional packages, with no sandbox shader overrides.

An offline coastal island with concurrent WebGPU atmosphere, four PCSS shadow
cascades, procedural terrain, grass/rock scatter with three indirect LOD rings,
Gerstner ocean waves with terrain-coupled coastal flow, breaking foam and spray, up to one million GPU particles, a jointed
procedural explorer, damped third-person camera, HDR bloom and AgX presentation.
The character, landscape, coastal cabin, ten trees, spaced shrubs and fern crowns are generated
locally; first launch fetches no assets. The scene starts at 17:30.

After sunset, shared `Sky` blends in blue moonlight at 10% of daytime intensity,
keeps four PCSS shadow cascades active, and supplies a navy RGB ambient floor and
matching sky/water reflections. Shared scatter batches give the recessed windows
and porch lantern warm HDR emission for bloom; existing `Clustered` lighting adds
a 6 m porch light. Water foam and spray follow directional radiance, and warm
HDR fireflies stand out against the darker scene. The porch light and windows stay
on during the day; point lights use the clustered module's existing unshadowed path.

The ocean enables shared water horizon mode. Shoreline flow blends into offshore
wave displacement, normals and optical depth at the terrain boundary; stretched
outer rows fade unresolved swells and remove the visible end of the water plane.

`@margoengine/procedural` builds the 6 × 8 m cedar cabin with recessed glass, corner trim,
a 35° shingled slate roof with fascia/bargeboards and overhangs, a terrain-sunk
stone plinth, a deck with two timber posts and two steps. The sandbox imports tree
and shrub generators from `@margoengine/procedural` and footprint spacing from
`@margoengine/scatter`, so these fixes are shared with other scenes.
Six-segment, eight-sided
trunks lean, twist and flare at the base. Pines use six jagged, drooping skirts;
broadleaf trees combine fifteen noise-deformed geodesic lobes on three limbs.
Pine support branches stay enclosed by their foliage. Pine normals radiate from each tier; all broadleaf normals radiate from one
collective canopy centroid. Architectural corners retain split face normals.
The existing geometry tangent helper computes UV-derived MikkTSpace-compatible
frames. All streams use the 80-byte PBR layout with baked vertex-color occlusion
at ground contacts, wall eaves and inner canopies. Materials use subdued linear
albedos with separate pine, broadleaf and semi-gloss glass settings.

The inland cabin sits at x = -10, z = 23, with its floor above the highest sampled
ground beneath it. Ten tree roots and the accepted perturbed fieldstones sink into the
heightfield. Compact, asymmetric shrubs scatter near the perimeter and rock bases;
their scaled mesh footprints keep 30 cm gaps and clear the foundation and porch
approach. Seeded position, size and rotation variation replaces continuous rows.
The shared `PlacementLayout` reserves the full stone foundation and porch approach,
then places rocks, fern crowns and shrubs in order, recording each accepted
footprint. Its default 30 cm gap prevents overlap between asset types and within
each batch. The current candidates yield two fixed fieldstones, eight fern crowns
and 19 shrubs. Each crown has seven tapered, parabolically curved ribbon fronds.
GPU island rocks receive the same occupied bounds, so they cannot intersect the
cabin, porch, fieldstones or planted foliage. Grass also clears the building.
`ScatterInstances` uploads twelve fixed material batches, releases their CPU arrays,
and submits indexed indirect draws in the beauty pass and all four shadow cascades.
It reuses the engine's PBR/PCSS/HDR shader rather than creating another lighting
model. A deterministic factory regenerates geometry only after device restoration.
The grass scatter also uses a PBR material, so cabin and canopy shadows darken
the blades as well as the terrain. The settlement adds no frame callback or
simulation work.

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
npm run build:packages
npm run build --workspace examples/gameplay-sandbox
npm run test --workspace examples/gameplay-sandbox
npm run test:browser --workspace examples/gameplay-sandbox
```

WASD / arrows move, Shift runs, drag looks, double-click captures the mouse, and
Escape releases it. Touch devices expose movement and look sticks. The control
pill adjusts the sun clock, actual particle capacity, terrain wireframe and wave
height. Reduced motion starts paused. WebGPU support is required and failures
appear in the shell. Canvas size, texture resources and device restoration are
handled by the engine and optional plugins.

Vite and TypeScript resolve the packages through their public distribution exports,
without source aliases. Run `npm run build:packages` before standalone workspace
builds/tests; `npm run dev:sandbox` builds the packages automatically. The example
adds no features to core or stage. CI builds/tests this workspace and retains the
existing core + stage gzip gate of 20,480 bytes.

Before the shrub-spacing adjustment, the physical NVIDIA Ampere production run at 1440 × 900
measured 60.03 / 60.07 / 60.00 FPS at 100k / 500k / 1M particles. The 600-frame
capture measured 60.00 FPS, 59.64 FPS including GPU completion, and 5,428 bytes
retained heap drift. It recorded six Minor GCs and no Major GC, so the existing
strict GC gate still fails; retained heap stability does not prove zero allocation.
The latest package build measured core + stage at 20,136 gzip bytes. Functional, offline-startup and device
restoration checks passed without WebGPU errors. The report and traces are in
`test-results/gameplay-sandbox/procedural-upgrade-verification.json`; allocation sampling adds overhead and should be
run separately from the normal performance capture.

## Allocation audit and reproducible hardware checks

The simulation mutates retained Float32Array input, character and sun vectors. Camera
orbit updates reuse the cinematic module's Float64Array offset. The camera's precise spring solver retains its existing Float64Array
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

# Shorter memory run with 1,200 warmup frames instead of the tier benchmarks.
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
