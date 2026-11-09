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
  frame in order from spawn to death (a flipbook). `@margoengine/vfx/flipbook` blends each frame into the next;
  without it the step is instant. Sampling stays half a texel inside the frame, so linear filtering
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

`VFX` from `@margoengine/vfx` (31,135 B min+gzip) carries every feature. An effect that uses none of them can
import the same class from `@margoengine/vfx/base` (11,188 B min+gzip); add features as a second argument from their own
entries: `/obstacles` (1.1 kB alone), `/wrap` (0.2 kB), `/sort` (1.1 kB), `/texture` (1.5 kB; it exports
`textureFeature`, passed as `{texture: textureFeature}`), `/curves` (1.6 kB), `/emitter` (2.4 kB), `/soft` (1.3 kB), `/ribbons` (2.6 kB, the quality gate's figure), `/mesh` (3.2 kB, the same), `/events` (2.3 kB, the same), `/lit` (1.7 kB, the same), `/depth-collide` (2.0 kB, the same), `/stretch` (0.8 kB, the same), `/fields` (1.8 kB, the same), `/skinned` (2.1 kB, the same), `/flipbook` (0.9 kB, 911 B min+gzip, the quality gate's figure), `/shadows` (2.8 kB, 2,805 B min+gzip, the quality gate's figure) and `/nodes` (3.1 kB, 3,093 B min+gzip, the quality gate's figure). Sizes are vite library builds with bare imports external,
each entry compressed on its own ([entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)), so a
bundle that combines them adds less: the whole root is 31,135 B. `node examples/package-benchmarks/vfx-size.mjs` measures base-plus-feature bundles
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

### Sub-emitters and GPU events

`events` gives particles children: when a particle dies (`on: 'death'`), or meets the ground faster than `speed` world
units a second (`on: 'collision'`, default 0.5), it raises an event on the GPU, and in the next frame `count` particles
(1 to 64, default 8) are born where it was into free slots of the same effect. They start with `inherit` (default 0) of
the parent's velocity at that moment plus `velocity` and a random `spread`, and take their own `lifetime`, `size` and
`color` (times `intensity`). Fireworks that burst where the rocket burns out, sparks where debris strikes the floor,
splashes where rain lands. Children never raise events of their own, so one event gives one generation.

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx/base';
import {events} from 'margoengine/vfx/events';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
// Fireworks: rockets climb for about a second and burst into 48 sparks where they burn out.
const fireworks = VFX.attach(engine, {
  capacity: 20_000, rate: 3, position: [0, 0, 0], velocity: [0, 12, 0], spread: 2, size: 0.15,
  lifetime: [0.9, 1.2], gravity: [0, -4, 0], turbulence: 0, color: [1, 0.8, 0.5, 1], intensity: 4,
  events: {on: 'death', count: 48, lifetime: [1, 1.6], size: 0.08, spread: 6, inherit: 0.3, color: [1, 0.4, 0.8, 1]},
}, {events});
engine.start();
```

Events are found, listed and turned into births entirely on the GPU in slot order (no atomics, no read-back), so the
same frames give the same particles byte for byte. Children take only free slots: when there are fewer free slots
than children wanted, the lowest events in slot order get theirs first and the rest are dropped; the emitter's own
births (`rate`, `burst`) come first. Collision events come from the ground plane only, not from `obstacles`. With
events on, the effect counts its free slots every frame, two small dispatches it skips without them, and adds two
storage buffers to the simulation (eight is the device minimum: events with a mesh `emitter` use all eight). `on` is
read at attach; the other settings every frame. `node packages/vfx/test/features-check.mjs` (real GPU) reads back the
children of a death and of an impact (position, velocity, life, size, colour, generation), fewer children when slots
run out, none from a slow impact or from a child, and the same bytes from the same frames.

### Lit particles

`lit` shades each billboard as a ball of its own size, so smoke, dust and steam take light from the side it comes
from: the pixel's normal comes from where it lies on the disc (turning with the particle's spin), and its colour is
the particle colour (texture and curves included) lit by the engine's sun (`engine.lighting`), the ambient light, and
optionally `Clustered` point and spot lights and `Shadows` sun shadows. The sun uses wrap lighting: `wrap` (0 to 1,
default 0.5) lets light reach round the dark side, as it does through thin smoke. Clustered lights use the clustered
shader's own light loop (falloff, cones, IES and local shadows) at roughness 1 and no metal; sun shadows are looked up
at the ball's surface point.

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx/base';
import {lit} from 'margoengine/vfx/lit';
import {Clustered} from 'margoengine/clustered';
import {Shadows} from 'margoengine/shadows';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const lights = Clustered.attach(engine);
lights.setLights([{position: [1, 1.5, 0], range: 8, color: [1, 0.6, 0.3], intensity: 6}]);
const shadows = Shadows.attach(engine);
// Grey smoke rising past an orange lamp, shadowed where the sun is blocked.
const smoke = VFX.attach(engine, {
  capacity: 4096, rate: 400, velocity: [0, 0.8, 0], spread: 0.3, gravity: [0, 0.2, 0], size: 0.6,
  lifetime: [2, 4], color: [0.6, 0.6, 0.6, 0.35], lit: {lights, shadows, wrap: 0.6},
}, {lit});
engine.start();
```

Under an order-independent pass (`addEffect` from `@margoengine/oit/vfx`) lit particles are lit the same way: the
pass's declarations take bind group 1 and the lights and shadows move to group 2, within the four groups every
device offers. `lights` and `shadows` are read at attach; `wrap` and `ambient` (linear RGB, default the engine's
`radiance[3]` times `ambient`) every frame, on the same object. Lighting is per pixel on the billboards only: ribbons
keep their own fade, and mesh particles their own light. `node packages/vfx/test/features-check.mjs` (real GPU)
compares every third pixel of a sun-lit particle with the wrap-lit ball shading at any spin and at 1x and 4x MSAA;
`node packages/vfx/test/lit-check.mjs` checks a real engine's clustered point light, a shadow caster and both again
in an `ExactOIT` pass against the same light computed on the CPU.

### Depth buffer collision

`depthCollide` makes particles bounce off anything drawn on screen, with no colliders to set up: each frame, before
the simulation, every particle on last frame's draw list is projected with last frame's camera onto last frame's
scene depth (the `depth` option, as for `softness`). A particle that meets the surface under it, within `thickness`
(world units, default 0.5) behind it or less than its radius in front, has the part of its velocity going into the
surface reflected and scaled by the effect's `bounce`, and moves out until it is a radius in front. The surface
normal comes from the depth of the neighbouring pixels, each axis taking the neighbour nearer in depth, so a particle
at an object's edge is not bent by the wall behind it.

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx/base';
import {depthCollide} from 'margoengine/vfx/depth-collide';
import {DepthTexture} from 'margoengine/post/depth';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const depth = DepthTexture.attach(engine);
// Sparks that bounce off the floor, the walls and every prop in view.
const sparks = VFX.attach(engine, {
  capacity: 8192, rate: 600, position: [0, 2, 0], velocity: [0, 2, 0], spread: 4, size: 0.04, bounce: 0.4,
  lifetime: [1, 2], color: [1, 0.7, 0.3, 1], intensity: 3, depth: () => depth.texture,
  depthCollide: {thickness: 0.3},
}, {depthCollide});
engine.start();
```

Only what the camera saw can be hit: a particle off screen, or behind something nearer (more than `thickness`
behind the surface in front of it), flies on, and a particle fast enough to cross a thin object between two frames
can pass through it. Collisions start the frame after the depth texture exists and use the frame before's depth, so
attach `DepthTexture` at its default order (-5, after the particles simulate). One small dispatch a frame over the
listed particles; with `thickness` and `bounce` read every frame. `node packages/vfx/test/features-check.mjs` (real
GPU) reads back a particle bouncing off a wall and a 45 degree slope, at an object's edge in front of a far wall,
behind a wall, and without the feature, against the same frames stepped on the CPU.

### Velocity-stretched billboards

`stretch` turns each billboard into a streak along its motion, for sparks, rain and tracers: the long axis follows the
particle's velocity across the screen and the billboard is `size + factor x speed` long, `factor` seconds of travel
(default 0.05), and keeps `size` across. A particle with no motion across the screen (flying straight at the camera)
stays round, and spin is ignored, since a streak points where it flies. The draw list's cull sphere grows to the
streak's length, so a streak reaching into view is never dropped.

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx/base';
import {stretch} from 'margoengine/vfx/stretch';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
// Sparks that streak as they fly and shorten as they slow down.
VFX.attach(engine, {
  capacity: 4096, rate: 400, position: [0, 1, 0], velocity: [0, 4, 0], spread: 6, size: 0.03, lifetime: [0.5, 1],
  color: [1, 0.6, 0.2, 1], intensity: 4, stretch: {factor: 0.04},
}, {stretch});
engine.start();
```

`factor` is read every frame (0 draws round billboards again). The streak is the same soft disc as a round
billboard, drawn longer, so it works with `texture`, `soft`, `curves` and `lit` unchanged; mesh particles and ribbons
keep their own shapes. `node packages/vfx/test/features-check.mjs` (real GPU) compares every pixel along and across a
fast particle's streak, flying across and up the screen, at 1x and 4x MSAA, and with factor 0, against the stretched
disc computed on the CPU.

### Force fields

`fields` adds point attractors and a 3D vector field to each particle's acceleration, alongside gravity and
turbulence: for portals, vortices, wind volumes and magic that gathers to a point. An attractor pulls with `strength
x d / (|d|^2 + radius^2)^1.5` (an inverse square, softened by `radius`, default 0.5, so it stays finite at its centre);
a negative strength pushes. The vector field holds one acceleration per cell over a box, trilinear between the cell
centres, the edge cells' value out to the box's faces and nothing outside it, times `strength`. Up to 16 attractors;
up to 2,097,152 cells (128^3).

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx/base';
import {fields} from 'margoengine/vfx/fields';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
// A swirl: each cell of an 8^3 field pushes around the y axis.
const n = 8, data = new Float32Array(n * n * n * 3);
for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
  const i = (x + n * (y + n * z)) * 3;
  data[i] = -(z - n / 2 + 0.5); data[i + 2] = x - n / 2 + 0.5;
}
const effect = VFX.attach(engine, {
  capacity: 8192, rate: 800, position: [0, 0, 0], spread: 1, gravity: [0, 0, 0], size: 0.03, lifetime: [2, 4],
  color: [0.4, 0.8, 1, 1], intensity: 2,
  fields: {attractors: [{position: [0, 1, 0], strength: 2}], field: {size: [n, n, n], data, halfSize: [2, 2, 2]}},
}, {fields});
engine.start();
// Attractors, the box and strengths are read every frame.
effect.options.fields!.attractors![0]!.strength = -2;
```

The field's cells are copied at attach, and whether an effect has a field is fixed then; attractors, the box's centre
and size and both strengths can change every frame. With `obstacles` the flow bends around them with the field forces
in it, as it does with gravity. `node packages/vfx/test/features-check.mjs` (real GPU) reads back particles under an
attractor and a repeller, and in a linear field inside the cell centres, in the band at the box's edge and outside it,
against the same frames stepped on the CPU.

### Skinned mesh emitters

`skinned` emits from an animated character: each birth picks a triangle of a skinned or morphed primitive by its
bind-pose area (a stretched limb does not emit more than at rest) and a uniform point of it in this frame's pose, and
flies along the posed face's normal times `speed` on top of `velocity` and `spread`. Each frame the posed vertices are
copied from the deformer's output (`primitive.deformed` at `deformedOffset`, both read every frame, so a re-packed
batch is followed); until a deformer writes, births use the bind pose. `transform` (16 numbers, column-major, read
every frame) places the mesh in the world; the emitter's `position` is not used with `skinned`, and it cannot be
combined with `emitter`.

```ts
import {EngineKernel} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Animation} from 'margoengine/animation';
import {VFX} from 'margoengine/vfx/base';
import {skinned} from 'margoengine/vfx/skinned';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const model = await loadGLTF(engine, '/RobotExpressive.glb');
Animation.attach(model).play('Walking');
const body = model.primitives[0]!;
// Embers rising off the robot as it walks.
VFX.attach(engine, {
  capacity: 8192, rate: 600, spread: 0.2, gravity: [0, 0.5, 0], size: 0.01, lifetime: [0.5, 1.5],
  color: [1, 0.5, 0.1, 1], intensity: 3,
  skinned: {primitive: body, transform: body.node.matrix, speed: 0.3},
}, {skinned});
engine.start();
```

The copy is recorded when the particles simulate, so a deformer that dispatches later in the same frame shows a frame
later. Births take only the pose: they do not inherit the surface's own motion. `node packages/vfx/test/features-check.mjs`
(real GPU) emits 2,000 particles from a posed two-triangle primitive, with and without an offset into the deformer's
buffer and with no deformer yet, and checks that every birth lies on a posed triangle and flies along its normal, and
that the births split by bind-pose area.

### Flipbook frame blending

`flipbook` blends a lifetime atlas instead of stepping from one cell to the next. The vertex stage passes this frame,
the next frame (the last frame holds, so it does not wrap) and the fraction between them; the fragment stage samples
both cells, still half a texel in, and mixes them. It needs `texture` with an atlas whose `frames` are `'lifetime'`
(a random frame has no fraction). Pass `{}`.

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx/base';
import {textureFeature} from 'margoengine/vfx/texture';
import {flipbook} from 'margoengine/vfx/flipbook';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
// Four solid frames, 4 x 4 texels each, blended across each spark's life.
const w = 8, frames = new Uint8Array(w * w * 4);
const cell = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255];
for (let i = 0; i < 4; i++) {
  const x0 = (i % 2) * 4, y0 = (i >> 1) * 4;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) frames.set(cell.slice(i * 4, i * 4 + 4), ((y0 + y) * w + x0 + x) * 4);
}
VFX.attach(engine, {
  capacity: 256, rate: 40, size: 0.2, lifetime: [1, 1], color: [1, 1, 1, 1],
  texture: {width: w, height: w, data: frames, atlas: {columns: 2, rows: 2, frames: 'lifetime'}},
  flipbook: {},
}, {texture: textureFeature, flipbook});
engine.start();
```

On WebGPU the mix is in the billboard fragment shader. On the WebGL2 route the same shader translates to GLSL ES 3.00
(`mix` of the two cell samples) and the route's draw wrapper still drops instances past the frame's count.
`node packages/vfx/test/flipbook-webgl2.mjs` runs that page on the compatibility layer: on an RTX A6000 the same two
centre pixels read 111,111,0 and 0,79,79, within 1 of the CPU mix 112,112,0 and 0,80,80.
`node packages/vfx/test/features-check.mjs` (real GPU) holds two particles halfway between frames of a 2 x 2 solid
atlas, one of them wrapping onto the next row, and checks each centre pixel against the same mix computed on the CPU.

### Particle shadows and lights

`shadows` makes particles cast sun shadows and emit point lights. Each live particle is a sphere impostor in the directional shadow map: under the cascade's orthographic matrix the front of the sphere is `centerZ - sqrt(r^2 - x^2 - y^2)`. The map's own receiver bias stays in the shadow pass. The first `count` live slots, in slot order, become point lights (default 8, at most 64). `range` is a distance in world units (default 4), not scaled by the particle's size. `intensity` (default 1) is the light's intensity. `decay` is always 2, so a clustered list uses its windowed inverse-square falloff. `cast` is a `Shadows` and `into` is a `Clustered`; either may be left out. `count`, `range` and `intensity` are read every frame. `cast` and `into` are fixed at attach. The feature sets `buffer` on the options object to the light list (a header, then up to 64 lights). `into` sees that list about two frames later, because the read-back waits for the frame to finish.

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx/base';
import {shadows} from 'margoengine/vfx/shadows';
import {Clustered} from 'margoengine/clustered';
import {Shadows} from 'margoengine/shadows';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const sun = Shadows.attach(engine);
const lights = Clustered.attach(engine);
// Sparks that block the sun and light what is near them.
VFX.attach(engine, {
  capacity: 4096, rate: 200, size: 0.15, lifetime: [1, 2], color: [1, 0.4, 0.1, 1], intensity: 2,
  shadows: {cast: sun, into: lights, count: 8, range: 5},
}, {shadows});
engine.start();
```

The light list is packed with a workgroup prefix sum, so the same slots give the same lights and nothing is chosen with an atomic. The sphere draw is a depth-only pass, one per cascade, and it does not add a storage buffer to the simulation. A centre past the cascade far plane still draws when the front of the sphere is inside the map: the quad's clip depth stays inside the clip volume, and the fragment writes the front. Disposing the effect removes the point lights it published. Disposing the effect, or restoring the device, while the light read-back is still mapping settles that cancelled map. `node packages/vfx/test/features-check.mjs` (real GPU) reads the light buffer of four slots (live, dead, live, live) with `count` 2 and checks a sphere at the origin against the orthographic depth. `node packages/vfx/test/shadows-nodes-webgl2.mjs` runs that page on the WebGL2 compatibility layer: on an RTX A6000 the header is 2, 5, 3, the lights are (1, 2, 3) red and (4, 5, 6) blue, and the depths are 0.45005, 0.48770 and 1.00000. A particle that uses neither shadows nor nodes, with velocity (1, 0, 0), is at (0.20000, 0, 0) after four steps of 0.05 s.

### Particle update nodes

`nodes` compiles a graph into the simulation. Each operator is `const`, `attribute` (`position`, `velocity`, `size`, `color`, `life`, `age`), `add`, `mul`, `sub`, `mix`, `min`, `max`, `scale`, `normalize`, `length`, `force` or `drag`. `force` adds a vector to the acceleration. `drag` subtracts a number times the velocity. `normalize` divides by the largest absolute component and then by that vector's length, on the CPU and in the shader, so a tiny or huge finite vector matches on WebGPU and WebGL2. An operator runs after the ones it reads. A cycle, a self input, an unknown operator or a bad width is a `TypeError`. At most 32 operators, and at most 16 numeric literals. Const and scale numbers are read every frame. The operators and the wires are fixed at attach. The acceleration is added after gravity, curl and fields. Velocity moves by that acceleration times the step, then position moves by the new velocity times the step.

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx/base';
import {nodes} from 'margoengine/vfx/nodes';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
// A constant push upward, with drag on the velocity.
const graph = [
  {op: 'const', value: [0, 2, 0]},
  {op: 'force', inputs: [0]},
  {op: 'const', value: 0.5},
  {op: 'drag', inputs: [2]},
] as const;
VFX.attach(engine, {
  capacity: 1024, rate: 40, size: 0.15, lifetime: [1, 2], color: [1, 0.6, 0.2, 1],
  nodes: {graph},
}, {nodes});
engine.start();
```

`evaluateNodes(graph, sample)` runs the same operators on the CPU. `node packages/vfx/test/features-check.mjs` (real GPU) holds one particle at velocity (1, 0, 0) under force (0, 2, 0) and drag 0.5, and checks position and velocity after four steps of 0.05 s. `node packages/vfx/test/shadows-nodes-webgl2.mjs` runs the same four steps on the WebGL2 compatibility layer: on an RTX A6000 the particle is at (0.18781, 0.04877, 0.00000) with velocity (0.90369, 0.38525, 0.00000).
