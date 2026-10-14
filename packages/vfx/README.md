# @margoengine/vfx

Optional GPU particle simulation and indirect billboard rendering, with capacity up to 1,000,000. One storage buffer updates particle position/life, velocity/size, color, rotation/angular velocity and initial lifetime in place; each invocation owns one particle record. Workgroups of 256 integrate gravity, analytic curl turbulence and ground-plane collisions. Atomic counters respawn dead slots and compact live indices directly into the indexed indirect draw's instance count.

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

One million particles use 64 MB for state plus 4 MB for live indices, regardless of the live count. Per-frame CPU work is bounded uniform updates and pass submission; there is no JavaScript object/array per particle. GPU performance still depends on capacity, fill rate and hardware.

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

### Load only what you use

`VFX` from `@margoengine/vfx` (6.6 kB min+gzip) carries all four features. An effect that uses none of them can
import the same class from `@margoengine/vfx/base` (4.8 kB); add features as a second argument from their own
entries: `/obstacles` (+0.7 kB), `/wrap` (+0.1 kB), `/sort` (+0.6 kB), `/texture` (+0.4 kB).

```ts
import {VFX} from '@margoengine/vfx/base';
import {sort} from '@margoengine/vfx/sort';
const smoke = VFX.attach(engine, {capacity: 4096, sort: true}, {sort});
```

Either way the WGSL, uploads and GPU calls are byte-identical to the build before the split for every feature
combination (`test/split.test.js`). An option whose feature is missing throws a `TypeError` naming the entry.

`initialCount` queues an initial burst on attachment and again after device
restoration. It defaults to 0 and must be an integer from 0 through capacity.
For a continuously populated field, use `initialCount: capacity`; this replaces
application restoration hooks. Restoration reseeds particles rather than preserving
their previous positions and ages.

`gpuState` exposes the current particle, indirect and live-list (`alive`, the draw order) buffers for tests/custom integrations. Particle records are 16 floats (64 bytes); indirect arguments are five 32-bit words. The current particle buffer is stable across frames and observes later updates; it is replaced after device restoration. `dispose()`/`destroy()` releases owned buffers. Device restoration recreates simulation resources. Attach multiple emitters independently; none enter the core/stage bundle.
