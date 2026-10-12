# @margoengine/vfx

Optional GPU particle simulation and indirect billboard rendering, with capacity up to 1,000,000. Two storage buffers alternate particle position/life, velocity/size, color, rotation/angular velocity and initial lifetime. Workgroups of 256 integrate gravity, analytic curl turbulence and ground-plane collisions. Atomic counters respawn dead slots and compact live indices directly into the indexed indirect draw's instance count.

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

One million particles use 128 MB for state plus 4 MB for live indices, regardless of the live count. Per-frame CPU work is bounded uniform updates and pass submission; there is no JavaScript object/array per particle. GPU performance still depends on capacity, fill rate and hardware. This package does not replace the smaller textured/weather particles in `margoengine-creative`.

`gpuState` exposes the current particle and indirect buffers for tests/custom integrations. Particle records are 16 floats (64 bytes); indirect arguments are five 32-bit words. `dispose()`/`destroy()` releases owned buffers. Device restoration recreates simulation resources and starts with dead particles. Attach multiple emitters independently; none enter the core/stage bundle.
