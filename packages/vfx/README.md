# @margoengine/vfx

Optional GPU particle simulation and indirect billboard rendering, with capacity up to 1,000,000. One storage buffer holds particle position/life, velocity/size, color and rotation (birth angle, angular velocity, initial lifetime); each invocation owns one particle. Workgroups of 256 integrate gravity, analytic curl turbulence and ground-plane collisions, touching only position/life and velocity/size after birth. Atomic counters respawn dead slots, count live particles and compact the ones whose billboard can reach the screen into the indirect draw, one triangle per particle.

```ts
import {EngineKernel} from '@margoengine/core';
import {VFX} from '@margoengine/vfx';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const sparks = VFX.attach(engine, {
  capacity:500_000, rate:20_000, position:[0,1,0], velocity:[0,5,0],
  spread:3, lifetime:[0.5,2], size:0.08, color:[1,0.4,0.05,1],
  gravity:[0,-9.81,0], ground:0, bounce:0.3, turbulence:1, angularVelocity:2
});
sparks.burst(10_000);
engine.start();
```

`rate` is births/second (default capacity/2). `burst(count)` adds births on the next frame, limited by capacity and available dead slots. Fractional emission budgets carry across frames. Options other than capacity can be adjusted before a frame; validation runs before GPU commands. `frequency` controls the curl field's spatial frequency. Life controls fade-out; rendering uses soft circular, camera-facing billboards with alpha blending and read-only scene depth. Simulation starts with dead slots and performs no CPU particle initialization or GPU readback.

`emissionExtent: [x,y,z]` distributes births within a box of these half extents
around `position` (default zero). `intensity` multiplies RGB for HDR emission,
0..16 (default 1). Billboards draw at frame-graph order 6, after water and scatter.

One million particles use 64 MB for state plus 4 MB for the draw list, regardless of the live count. Per-frame CPU work is bounded uniform updates and pass submission; there is no JavaScript object/array per particle. GPU performance still depends on capacity, fill rate and hardware.

This is Margo's one particle system; `GPUParticles` in `@margoengine/creative/particles` is a leaf-field preset
over it. Four optional features patch the shaders only when set, so effects without them compile the same WGSL
and make the same GPU calls:

- `obstacles: [{kind:'sphere', center, radius}, {kind:'box', center, halfSize}]` (up to 64): the flow bends
  around each within one unit, and particles inside are pushed out and reflected with `bounce`. The array is read
  every frame (move or replace entries freely); pass one, even `[]`, before attaching. Adds a 2,096-byte uniform.
- `wrap: true` keeps particles inside the emission box (`position` ± `emissionExtent`, every extent > 0): a
  particle leaving one face re-enters on the opposite face at the emitter velocity. Use with a long `lifetime`
  and `rate: 0` for a persistent weather field.
- `sort: true` draws back to front: each frame a bitonic sort orders the live list by view depth. The list is
  padded to a power of two; the sort costs log2(n)·(log2(n)+1)/2 dispatches, so prefer it for thousands, not a
  million.
- `texture: {width, height, data}` (RGBA8, sRGB, up to 4096²) replaces the soft disc; texel RGB multiplies the
  particle colour and texel alpha its opacity. Copied at construction.

`obstacles`, `wrap`, `sort` and `texture` are read when the effect attaches.

### GPU cost

Each billboard is one triangle around the soft disc (half the primitives and 3/4 of the vertex work of a quad), and
the simulation lists only particles whose triangle can reach the screen (a conservative clip-space sphere test, so
nothing visible is dropped). With 4x MSAA the fragment shader keeps exactly the samples the old quad covered. Measured
on an Intel Arc 140V (Edge 154, AC power, 1432x768, Afterlight island options and camera, nothing occluding), median
of 16 alternating rounds against the previous build, all 16 rounds faster:

| Particles | MSAA | Before (simulate + draw) | After |
| --- | --- | --- | --- |
| 1,000,000 | 1x | 5.00 ms | 2.46 ms |
| 1,000,000 | 4x | 5.12 ms | 2.40 ms |
| 100,000 | 1x | 0.28 ms | 0.15 ms |
| 100,000 | 4x | 0.28 ms | 0.17 ms |

In the island demo itself (light tier, 1M particles) the particle passes went from 5.7 to 2.6 ms and the frame's GPU
span from 15.7 to 13.5 ms. Same particle state and pixels within the old renderer's own run-to-run blend-order noise
(numbers, scripts and the pixel comparison: `examples/package-benchmarks/vfx-gpu.mjs`, `vfx-island.mjs`, `results/`).

### Load only what you use

`VFX` from `@margoengine/vfx` (7.7 kB min+gzip) carries all four features. An effect that uses none of them can
import the same class from `@margoengine/vfx/base` (5.7 kB); add features as a second argument from their own
entries: `/obstacles` (+0.8 kB), `/wrap` (+0.1 kB), `/sort` (+0.7 kB), `/texture` (+0.4 kB). Sizes are vite library
builds with bare imports external (`node examples/package-benchmarks/vfx-size.mjs`, `results/vfx-size.json`).

```ts
import {VFX} from '@margoengine/vfx/base';
import {sort} from '@margoengine/vfx/sort';
const smoke = VFX.attach(engine, {capacity: 4096, sort: true}, {sort});
```

Either way the WGSL, uploads and GPU calls are byte-identical for every feature combination (`test/split.test.js`;
fixtures recorded from the root entry). An option whose feature is missing throws a `TypeError` naming the entry.

`initialCount` queues an initial burst on attachment and again after device
restoration. It defaults to 0 and must be an integer from 0 through capacity.
For a continuously populated field, use `initialCount: capacity`; this replaces
application restoration hooks. Restoration reseeds particles rather than preserving
their previous positions and ages.

`gpuState` exposes the current particle, indirect, draw-list (`alive`, the draw order) and `visible` buffers for tests/custom integrations. Each particle has 16 floats (64 bytes), split in two halves so the per-frame update reads and writes only the first: particle i's position/life and velocity/size are floats `8i..8i+7`; its color and rotation (birth angle, angular velocity, initial life, unused) are floats `8n+8i..8n+8i+7` (n = capacity). The drawn angle is birth angle + angular velocity x (initial life - remaining life). `indirect` is five 32-bit words whose second word counts live particles; `visible` holds the draw's `drawIndirect` arguments (vertex count 3, then the number of on-screen particles listed at the start of `alive`). The current particle buffer is stable across frames and observes later updates; it is replaced after device restoration. `dispose()`/`destroy()` releases owned buffers. Device restoration recreates simulation resources. Attach multiple emitters independently; none enter the core/stage bundle.
