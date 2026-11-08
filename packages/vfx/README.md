# @margoengine/vfx

Import `margoengine/vfx` from the `margoengine` package, or `@margoengine/vfx` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Optional GPU particle simulation and indirect billboard rendering, with capacity up to 1,000,000. One storage buffer holds particle position/life, velocity/size, color and rotation (birth angle, angular velocity, initial lifetime); each invocation owns one particle. Workgroups of 256 integrate gravity, analytic curl turbulence and ground-plane collisions, touching only position/life and velocity/size after birth. Births take the dead slots in slot order and the particles whose billboard can reach the screen are listed in slot order for the indirect draw, one triangle per particle (workgroup prefix sums, not atomic tickets), so the same frames give the same particles, the same draw order and the same blended pixels on every run.

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const sparks = VFX.attach(engine, {
  capacity:500_000, rate:20_000, position:[0,1,0], velocity:[0,5,0],
  spread:3, lifetime:[0.5,2], size:0.08, color:[1,0.4,0.05,1],
  gravity:[0,-9.81,0], ground:0, bounce:0.3, turbulence:1, angularVelocity:2
});
sparks.burst(10_000);
engine.start();
```

`rate` is births/second (default capacity/2). `burst(count)` adds births on the next frame, limited by capacity and available dead slots. Fractional emission budgets carry across frames. Options other than capacity can be adjusted before a frame; validation runs before GPU commands. `frequency` controls the curl field's spatial frequency. Life controls fade-out; rendering uses soft circular, camera-facing billboards with alpha blending and read-only scene depth. A billboard is never drawn under 1.5 px across: a smaller (far) particle is drawn at 1.5 px with its alpha scaled by its true area over that area, so it keeps its average light instead of flickering between pixels. Simulation starts with dead slots and performs no CPU particle initialization or GPU readback. `reset()` takes the effect back to that start: no particles, its clock at 0 and `initialCount` waiting, so the same frames after it give the same particles (`@margoengine/cutscene/vfx` seeks this way).

`emissionExtent: [x,y,z]` distributes births within a box of these half extents
around `position` (default zero). `intensity` multiplies RGB for HDR emission,
0..16 (default 1). Billboards draw at frame-graph order 6, after water and scatter.

One million particles use 64 MB for state plus 4 MB for the draw list, regardless of the live count. Per-frame CPU work is bounded uniform updates and pass submission; there is no JavaScript object/array per particle. GPU performance still depends on capacity, fill rate and hardware.

This is Margo's one particle system; `GPUParticles` in `@margoengine/creative/particles` is a leaf-field preset
over it. Six optional features patch the shaders only when set, so effects without them compile the same WGSL
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
- `texture: {width, height, data, atlas: {columns, rows, frames}}` treats the texture as `columns` x `rows` equal
  frames, numbered left to right from the top row. `frames: 'random'` gives each particle one frame picked when it
  spawns (block-break debris showing pieces of the block's texture); `'lifetime'` steps each particle through every
  frame in order from spawn to death (a flipbook). Sampling stays half a texel inside the frame, so linear filtering
  never shows a neighbouring frame, and the billboard triangle grows to hold the whole square frame. Without `atlas`
  the WGSL and GPU calls are unchanged.

```ts
// Block-break debris: 24 pieces of a 16 x 16 block texture, a random 4 x 4 texel piece each.
const stonePixels = new Uint8Array(16 * 16 * 4); // the block's RGBA8 texels
const [x, y, z] = [3, 0, -2];                    // the broken block
const debris = VFX.attach(engine, {
  capacity: 256, rate: 0, size: 0.1, lifetime: [0.5, 1], velocity: [0, 3, 0], spread: 2, ground: 0,
  texture: {width: 16, height: 16, data: stonePixels, atlas: {columns: 4, rows: 4, frames: 'random'}},
});
debris.options.position = [x + 0.5, y + 0.5, z + 0.5];
debris.burst(24);
```

`node packages/vfx/test/browser-check.mjs` (real GPU; run it under `node scripts/gpu-lock.mjs run`) draws 64
particles with a 2 x 2 atlas at 1x and 4x MSAA and checks each one's centre and four points near its corners against
the frame it must show (the shader's hash of its birth angle for `'random'`, its age quarter for `'lifetime'`).

`curves: {size, alpha, color}` shapes each particle over its life (birth 0, death 1):

- `size: [0, 1, 0.5]`: 2 to 32 multipliers of `size` (each 0..1), evenly spaced over the life and interpolated
  linearly. The curve can only shrink a particle, never grow it past `size`, so culling stays exact.
- `alpha: [0, 1, 1, 0]`: 2 to 32 opacities (each 0..1); replaces the default fade-out, so end with 0 to fade away.
- `color: [{at: 0, color: [1, 1, 1]}, {at: 1, color: [1, 0.2, 0]}]`: 2 to 8 stops ascending by `at`, linear RGB 0..16,
  multiplying the particle `color` (use `color: [1, 1, 1, 1]` to draw the gradient as it is).

Set at least one; a curve left out keeps the stock size or fade. Which curves are set is read at attach, their numbers
every frame. The shader samples them in the billboard stage only (one 400-byte uniform), so the simulation is unchanged.

`emitter` says where births start and which way they fly; `speed` (world units per second, -1000..1000, default 0,
negative flies inward) pushes along the shape's direction, on top of `velocity` and `spread`; `position` and
`emissionExtent` still apply:

- `{shape: 'sphere', radius = 1, shell = false}`: uniform through the ball, or on its surface with `shell: true`;
  births fly radially.
- `{shape: 'cone', radius = 0, angle = PI / 6, axis = [0, 1, 0]}`: from a disc of `radius` at the apex, directions
  uniform in solid angle within the half `angle` (0..PI/2) of `axis`.
- `{shape: 'mesh', positions, indices?, scale = 1}`: uniform over the surface of a triangle mesh (area-weighted,
  at most 262,144 triangles, zero-area triangles ignored), flying along each face's normal (counter-clockwise faces
  point out). Positions are in world units around `position`.

The shape (and a mesh's triangles) is read when the effect attaches, and again after device restoration; radius, angle,
axis, `speed` and `scale`-free numbers can change every frame. Changing `shape` afterwards throws a `TypeError`.

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
// Embers rising from a cone: swell then shrink, fade in and out, cool from white to orange to dark red.
const embers = VFX.attach(engine, {
  capacity: 20_000, rate: 4_000, position: [0, 0.5, 0], velocity: [0, 0, 0], spread: 0.2, size: 0.12,
  lifetime: [1, 2], color: [1, 1, 1, 1], intensity: 3,
  emitter: {shape: 'cone', radius: 0.3, angle: 0.35, speed: 2.5},
  curves: {
    size: [0.3, 1, 0.6, 0],
    alpha: [0, 1, 1, 0],
    color: [{at: 0, color: [1, 1, 1]}, {at: 0.3, color: [1, 0.55, 0.1]}, {at: 1, color: [0.3, 0.02, 0.01]}],
  },
});
// Sparks from the surface of a mesh (here two triangles of a roof), pushed out along the faces.
const roof = new Float32Array([0, 0, 0, 4, 0, 0, 0, 1, 3, 4, 1, 3]);
const shower = VFX.attach(engine, {
  capacity: 5_000, rate: 800, position: [0, 3, 0], size: 0.05, velocity: [0, 0, 0], spread: 0.1,
  emitter: {shape: 'mesh', positions: roof, indices: [0, 1, 2, 1, 3, 2], speed: 1.5},
});
```

`node packages/vfx/test/browser-check.mjs` also reads back, on the real GPU, 320 curve probes (colour, alpha and falloff
against curves evaluated in the test, at 1x and 4x MSAA) and 4,096 births of each shape: a ball's volume (mean r^3 / R^3
is 1/2), a shell's radius, a cone's solid-angle and disc statistics, and a two-triangle mesh's area share, bounds and normals.

`obstacles`, `wrap`, `sort`, `texture`, `curves` and `emitter` are read when the effect attaches; `softness` and `depth` are read every frame.

### Fog

`effect.setFog(fog)` fogs the particles with `@margoengine/environment`'s `Fog` or any object with its fields (`color`,
`near`, `far`, `density`, `heightFalloff`, `height`, `enabled`), read every frame with Fog's maths. Each pixel of a
particle fades toward the fog colour by the fog at its world position (particles blend alpha over the scene, so fog
covers them as it covers meshes). Particles write their colour as it is, so on an 8-bit canvas the fog colour goes in
sRGB-encoded and a fully fogged particle matches the fogged background. VFX does not import environment.
`fog.enabled = false` clears it without recompiling; `effect.setFog(null)` (the default) draws exactly as before.

```ts
import {Fog} from 'margoengine/environment';
import {VFX} from 'margoengine/vfx';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const sparks = VFX.attach(engine, {capacity: 10_000, rate: 1_000, position: [0, 1, 0], velocity: [0, 5, 0]});
const fog = Fog.attach(engine, {color: '#8090a0', near: 5, far: 60});
sparks.setFog(fog);
```

### In an order-independent pass

Particles blend over the scene in a pass of their own, so they paint over glass in front of them. `addEffect` from
[`margoengine/oit/vfx`](../oit/README.md#particles-splats-and-points-addeffect) draws them with the glass instead, fog,
softness and textures included:

```ts
import {Engine} from 'margoengine/core';
import {OIT} from 'margoengine/oit';
import {addEffect} from 'margoengine/oit/vfx';
import {VFX} from 'margoengine/vfx';
const engine = await Engine.create(document.querySelector('canvas')!);
addEffect(OIT.attach(engine), VFX.attach(engine, {capacity: 10_000}));
```

### Soft particles

`softness` (world units, default 0 = off) fades each particle over that distance in front of any opaque surface behind
it, measured along the view axis, so a particle that meets the floor or a wall no longer shows a hard line. A particle
`softness` or more clear of every surface is drawn exactly as before; one touching a surface fades to nothing. It needs
the `soft` feature (on the root `VFX`; `{soft}` from `@margoengine/vfx/soft` on `/base`) and the scene depth as a
sampleable depth texture of the drawing size, given by the `depth` option: a function returning it, so a texture that is
replaced on resize is picked up. `DepthTexture` from `@margoengine/post/depth` provides one (depth32float, reversed Z, 1 sample);
a multisampled scene depth works too (the nearest sample counts), as do views (the view's rectangle is used).
`softness` may change every frame; with it at 0 the effect compiles the same WGSL, binds the same resources and does the
same per-frame work as without the option. The first soft frame compiles a second billboard shader, like fog.

Without a depth texture the draw throws `MargoError` `'state'` (`depth()` returned undefined: add `DepthTexture` before the
first frame, or set `softness` to 0); a depth texture that cannot be sampled or is not the drawing size throws
`RangeError`; `softness` without the feature or without `depth` throws `TypeError` when the effect is made. Where the
depth is 0 (nothing drawn) the particle is left alone.

```ts
import {DepthTexture} from 'margoengine/post/depth';
import {VFX} from 'margoengine/vfx';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const depth = DepthTexture.attach(engine);
// Steam that thins out over the last 0.5 m before the floor and walls.
const steam = VFX.attach(engine, {
  capacity: 20_000, rate: 2_000, position: [0, 0.1, 0], size: 0.4, color: [0.9, 0.9, 1, 0.3],
  softness: 0.5, depth: () => depth.texture,
});
```

Measured on an RTX A6000 (Edge, 1280x720, one million particles on screen, 40 frames a batch, 9 alternating batches,
simulate + draw + the floor depth pass): see the table below.

### GPU cost

Each billboard is one triangle around the soft disc (half the primitives and 3/4 of the vertex work of a quad), and
the simulation lists only particles whose triangle can reach the screen (a conservative clip-space sphere test, so
nothing visible is dropped). With 4x MSAA the fragment shader keeps exactly the samples the old quad covered. Measured
on an Intel Arc 140V laptop iGPU (Edge 155, AC power, 1432x768, Afterlight island options and camera, nothing occluding), median
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

Since then births and the draw list follow slot order (four small passes of workgroup prefix sums around the
simulation instead of atomic tickets), so two runs of the same frames draw the same pixels; before, two runs of
one still frame differed on up to 6,000 of 65,536 pixels in the browser check. The simulation's compute time on an RTX
A6000 (Edge, 8 alternating rounds against the atomic build) went from 0.094 to 0.184 ms at 1,000,000 particles and
from 0.010 to 0.031 ms at 100,000; the draw is unchanged.

### Load only what you use

`VFX` from `@margoengine/vfx` (about 14.1 kB min+gzip) carries every feature. An effect that uses none of them can
import the same class from `@margoengine/vfx/base` (about 8.3 kB); add features as a second argument from their own
entries: `/obstacles` (1.1 kB alone), `/wrap` (0.2 kB), `/sort` (1.1 kB), `/texture` (1.5 kB; it exports
`textureFeature`, passed as `{texture: textureFeature}`), `/curves` (1.6 kB), `/emitter` (2.4 kB), `/soft` (1.3 kB), `/ribbons` (2.6 kB, the quality gate's figure) and `/mesh` (3.2 kB, the quality gate's figure). Sizes are vite library builds with bare imports external,
each entry compressed on its own ([entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)), so a
bundle that combines them adds less: the whole root is 14.1 kB. `node examples/package-benchmarks/vfx-size.mjs` measures base-plus-feature bundles
(`results/vfx-size.json`, at an earlier commit, `76af7a0`).

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx/base';
import {sort} from 'margoengine/vfx/sort';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const smoke = VFX.attach(engine, {capacity: 4096, sort: true}, {sort});
```

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx/base';
import {curves} from 'margoengine/vfx/curves';
import {emitter} from 'margoengine/vfx/emitter';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const fountain = VFX.attach(
  engine,
  {capacity: 8192, emitter: {shape: 'sphere', radius: 0.2, shell: true, speed: 2}, curves: {alpha: [0, 1, 0]}},
  {curves, emitter},
);
```

Either way the WGSL, uploads and GPU calls are byte-identical for every feature combination (`test/split.test.js`;
fixtures recorded from the root entry). An option whose feature is missing throws a `TypeError` naming the entry.

`initialCount` queues an initial burst on attachment and again after device
restoration. It defaults to 0 and must be an integer from 0 through capacity.
For a continuously populated field, use `initialCount: capacity`; this replaces
application restoration hooks. Restoration reseeds particles rather than preserving
their previous positions and ages.

`gpuState` exposes the current particle, indirect, draw-list (`alive`, the draw order) and `visible` buffers for tests/custom integrations. Each particle has 16 floats (64 bytes), split in two halves so the per-frame update reads and writes only the first: particle i's position/life and velocity/size are floats `8i..8i+7`; its color and rotation (birth angle, angular velocity, initial life, unused) are floats `8n+8i..8n+8i+7` (n = capacity). The drawn angle is birth angle + angular velocity x (initial life - remaining life). `indirect` is five 32-bit words whose second word counts live particles; `visible` holds the draw's `drawIndirect` arguments (vertex count 3, then the number of on-screen particles listed at the start of `alive`). The current particle buffer is stable across frames and observes later updates; it is replaced after device restoration. `dispose()`/`destroy()` releases owned buffers. Device restoration recreates simulation resources. Attach multiple emitters independently; none enter the core/stage bundle.

### Ribbons and trails

`ribbons` leaves a ribbon behind every particle, for smoke, magic and tracer trails: a strip through the particle and
its last positions, turned to face the camera, fading from the particle's own opacity at the head to nothing at the tail
and softly across its width. The `ribbons` feature records every live particle's position each `interval` seconds
(default 1/60; 0 records every frame) into a ring of `points - 1` records per particle (`points`, the particle included,
2 to 64, default 16), so a ribbon covers about `(points - 1) x interval` seconds of flight. `width` (world units) defaults
to the particle `size`; `heads: false` draws the ribbons without the billboards. Each record is stamped with the
particle's life, so a particle that dies and is born again starts a new ribbon instead of joining the old one, and a
young particle's ribbon is as long as its life so far.

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx/base';
import {ribbons} from 'margoengine/vfx/ribbons';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
// Magic sparks that leave half-second trails, drawn without their heads.
const trails = VFX.attach(engine, {
  capacity: 2_000, rate: 400, position: [0, 1, 0], velocity: [0, 2, 0], spread: 2, size: 0.05,
  lifetime: [1, 2], gravity: [0, -1, 0], turbulence: 2, color: [0.4, 0.7, 1, 1], intensity: 3,
  ribbons: {points: 31, interval: 1 / 60, width: 0.04, heads: false},
}, {ribbons});
engine.start();
```

Ribbons draw after the billboards in a pass of their own, alpha blended and depth tested (not written), one triangle
strip of `2 x points` vertices for every slot in slot order, so the same frames give the same pixels. The ring takes
`capacity x (points - 1) x 16` bytes, at most 64 MB (`capacity x (points - 1)` up to 4,194,304); every slot runs the
ribbon's vertices each frame, live or not, so ribbons suit thousands of particles, not a million. Ribbons are not fogged,
softened or drawn in an order-independent pass, and `interval`, `width` and `heads` may change every frame while
`points` is fixed at attach. `node packages/vfx/test/features-check.mjs` (real GPU) flies a particle at a known speed and
checks its ribbon's alpha along the centre row against the fades computed in the test, at 1x and 4x MSAA, every frame
and every second frame, and that a particle born again never joins its old ribbon.

### Mesh particles

`mesh` draws every particle as a small triangle mesh instead of a billboard: debris, leaves, shell casings, coins. The
mesh is scaled so its farthest vertex from the mesh origin sits half the particle `size` away, takes the particle colour,
and is lit by one directional light (`light`, the direction towards it, default `[0.4, 1, 0.3]`; `lightColor`, linear
RGB, default white) plus `ambient` (0 to 1, default 0.35) on faces turned away. `align: 'random'` (the default) tumbles
each particle about its own random axis by its spin (`angularVelocity`); `align: 'velocity'` points the mesh's +y along
the particle's motion, so long shapes fly nose first. Without `normals` each triangle is shaded flat by its face normal
(counter-clockwise triangles face outwards).

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx/base';
import {mesh} from 'margoengine/vfx/mesh';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
// Tumbling stone chips: a cube of 12 triangles for each particle.
const h = 1;
const cube = {
  positions: [-h,-h,-h, h,-h,-h, h,h,-h, -h,h,-h, -h,-h,h, h,-h,h, h,h,h, -h,h,h],
  indices: [4,5,6, 4,6,7, 1,0,3, 1,3,2, 5,1,2, 5,2,6, 0,4,7, 0,7,3, 7,6,2, 7,2,3, 0,1,5, 0,5,4],
};
const chips = VFX.attach(engine, {
  capacity: 5_000, rate: 500, position: [0, 0.5, 0], velocity: [0, 4, 0], spread: 2, size: 0.15,
  lifetime: [2, 3], angularVelocity: 6, turbulence: 0, color: [0.55, 0.5, 0.45, 1],
  mesh: {...cube, align: 'random', light: [0.3, 1, 0.5], ambient: 0.3},
}, {mesh});
engine.start();
```

The meshes are drawn instanced in one indirect draw over the billboards' own list of on-screen particles (the GPU
copies its count into the draw's arguments, no read-back), opaque, back faces culled and depth written, so they hide
each other and anything drawn later behind them; their alpha is ignored and they are not fogged, softened or drawn in an
order-independent pass. Up to 65,536 triangles a mesh; every corner runs for every drawn particle, so keep meshes small
(a 12-triangle cube for 100,000 particles is 3.6 million vertices a frame). The geometry and `align` are read at attach;
`light`, `lightColor` and `ambient` are read every frame from the same object. `node packages/vfx/test/features-check.mjs`
(real GPU) checks a cube lit head-on for its exact lit colour and width and that it hides a cube behind it, at 1x and
4x MSAA, a cube turned by its random axis for the shade of the face turned to the camera, and a long box following its
velocity.
