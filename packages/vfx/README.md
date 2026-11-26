# @margoengine/vfx

Import `margoengine/vfx` from the `margoengine` package, or `@margoengine/vfx` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Optional GPU particle simulation and indirect billboard rendering, with capacity up to 2,097,152 on a default WebGPU device (64 bytes a slot in one 128 MiB storage binding; an adapter that grants larger bindings holds up to 16,776,960). One storage buffer holds particle position/life, velocity/size, color and rotation (birth angle, angular velocity, initial lifetime); each invocation owns one particle. Workgroups of 256 integrate gravity, analytic curl turbulence and ground-plane collisions, touching only position/life and velocity/size after birth. Births take the dead slots in slot order and the particles whose billboard can reach the screen are listed in slot order for the indirect draw, one triangle per particle (workgroup prefix sums, not atomic tickets), so the same frames give the same particles, the same draw order and the same blended pixels on every run.

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

`rate` is births/second (default capacity/2). `burst(count)` adds births on the next frame, limited by capacity and available dead slots; `burst(count, {position, velocity, spread, emissionExtent})` is born where it says (what it leaves out is the effect's), and bursts with a place of their own never share one, so two in one frame start where each asked. Fractional emission budgets carry across frames. Options other than capacity can be adjusted before a frame; validation runs before GPU commands. `frequency` controls the curl field's spatial frequency. Life controls fade-out; rendering uses soft circular, camera-facing billboards with alpha blending and read-only scene depth. A billboard is never drawn under 1.5 px across: a smaller (far) particle is drawn at 1.5 px with its alpha scaled by its true area over that area, so it keeps its average light instead of flickering between pixels. Simulation starts with dead slots and performs no CPU particle initialization or GPU readback. `reset()` takes the effect back to that start: no particles, its clock at 0 and `initialCount` waiting, so the same frames after it give the same particles, ribbons included (`@margoengine/cutscene/vfx` seeks this way). After `dispose()`, `burst` and `reset` throw `MargoError` `'disposed'`.

`emissionExtent: [x,y,z]` distributes births within a box of these half extents
around `position` (default zero). `intensity` multiplies RGB for HDR emission,
0 to 65,504, the largest half float of the HDR target (default 1). Billboards draw at frame-graph order 6, after water and scatter.

One million particles use 64 MB for state plus 4 MB for the draw list, regardless of the live count. Per-frame CPU work is bounded uniform updates and pass submission; there is no JavaScript object/array per particle. A steady frame of 100,000 particles sends the GPU 224 bytes in one write ([counted](../../docs/whitepaper/batch-170-vfx.md)). GPU performance still depends on capacity, fill rate and hardware.

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

`node packages/vfx/test/browser-check.mjs` (real GPU; run it under `node scripts/run-with-timeout.mjs`) draws 64
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

`gpuState` exposes the current particle, indirect, draw-list (`alive`, the draw order) and `visible` buffers for tests/custom integrations. Each particle has 16 floats (64 bytes), split in two halves so the per-frame update reads and writes only the first: particle i's position/life and velocity/size are floats `8i..8i+7`; its color and rotation (birth angle, angular velocity, initial life, unused) are floats `8n+8i..8n+8i+7` (n = capacity). The drawn angle is birth angle + angular velocity x (initial life - remaining life), plus the `overLife` spin curve's turn; the stored birth angle never changes. `indirect` is five 32-bit words whose second word counts live particles; `visible` holds the draw's `drawIndirect` arguments (vertex count 3, then the number of on-screen particles listed at the start of `alive`). The current particle buffer is stable across frames and observes later updates; it is replaced after device restoration. `dispose()`/`destroy()` releases owned buffers. Device restoration recreates simulation resources. Attach multiple emitters independently; none enter the core/stage bundle.

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

### Solid particle system: many meshes as one mesh

`@margoengine/vfx/solid` is a CPU-driven solid particle system for what the GPU `mesh` feature cannot do: a few
thousand pieces (bricks of a wall, a shattering vase, a flock, a scatter of props) that each have their own colour,
scale and rotation, can be hidden or killed, and can be picked with a ray. Many shapes are merged into one vertex and
index buffer, so the whole system is one draw. Build it from `addShape(shape, count, options?)` (copies of a mesh) or
`digest(shape, {number | facetNb})` (the mesh split into pieces of whole triangles, `number` winning over `facetNb`,
default 1 triangle each), call `build()` once, then each frame `setParticles(start?, end?)` runs your `updateParticle(p)`
over the range and rewrites only those vertices.

| Particle field | Default | Meaning |
| --- | --- | --- |
| `position`, `scaling` | `[0,0,0]`, `[1,1,1]` | world position; scale per axis, applied before the rotation |
| `rotation`, `rotationQuaternion` | `[0,0,0]`, `null` | Euler radians (roll, pitch, then yaw), or a quaternion `[x,y,z,w]` that wins when set |
| `color` | white | rgba 0 to 1, written to every vertex |
| `uvs` | `[0,0,1,1]` | the rectangle `[u0,v0,u1,v1]` the shape's uvs map into (a sprite sheet cell) |
| `alive`, `isVisible` | `true` | dead: not updated, not drawn, not picked; invisible: updated but collapsed to a point, not picked |
| `boundingBox` | | world box as last written; `getBounds()` joins the drawn particles |

```ts
import {EngineKernel} from 'margoengine/core';
import {SolidParticleSystem} from 'margoengine/vfx/solid';
import {UnlitMaterial, createMesh} from 'margoengine/materials';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend: 'webgpu'});
const h = 0.5;
const cube = {
  positions: [-h,-h,-h, h,-h,-h, h,h,-h, -h,h,-h, -h,-h,h, h,-h,h, h,h,h, -h,h,h],
  indices: [4,5,6, 4,6,7, 1,0,3, 1,3,2, 5,1,2, 5,2,6, 0,4,7, 0,7,3, 7,6,2, 7,2,3, 0,1,5, 0,5,4],
};
const sps = new SolidParticleSystem({
  updateParticle(p) { p.rotation[1] += 0.02; p.position[1] = 1 + Math.sin(p.idx + p.rotation[1]); },
});
sps.addShape(cube, 200, {
  positionFunction: (p, i) => { p.position = [(i % 20) * 1.5 - 14, 0, Math.floor(i / 20) * 1.5 - 7]; },
  color: [0.9, 0.5, 0.2, 1],
});
const geometry = sps.build();   // one merged mesh: positions, normals, uvs, colors (rgba), indices
const mesh = createMesh(engine, geometry, new UnlitMaterial({}));   // vertex colours are on by default
engine.onFrame(() => {
  sps.setParticles();   // or setParticles(0, 99) for a range
  mesh.setGeometry(geometry, sps.takeDirty()!);   // uploads only the vertices written
});
// Pick: the nearest drawn triangle along a ray, in world units.
const hit = sps.pick({origin: [0, 5, 20], direction: [0, -0.2, -1]});
if (hit) sps.particles[hit.particleIndex].alive = false;   // {particleIndex, shapeId, faceId, localFaceId, distance, point}
engine.start();
```

**One merged buffer, not instancing per shape.** Instancing would need a draw per shape and a per-instance colour and
transform path, and the CPU would still have to transform the geometry to pick it. A merged buffer rebuilt on the CPU
is one draw however many shapes there are, supports per-particle colour and uvs and any mix of shapes, and picking tests
exactly the vertices that were uploaded. The price is CPU work in proportion to the vertices written: `setParticles`
with a range, or the vertex range of `takeDirty()`, keeps a frame to the particles that moved. Colours are in the
geometry's `colors` stream, which `createMesh` of `@margoengine/materials` reads (`vertexColors` on); the core `Mesh`
has no vertex colours.

`pick` walks each drawn particle's box (slab test) and then its triangles with the Moller-Trumbore test; the ray
direction is normalised, so `distance` is in world units. Options: `maxDistance` (default `Infinity`) and `backFaces`
(default `true`). Hidden and dead particles are never hit.

Errors: a bad shape, count, range, option or non-finite particle value throws `TypeError` or `RangeError` naming the fix;
`addShape` after `build()`, `setParticles` or `pick` before it, an empty `build()`, or `setParticles` from inside
`updateParticle` throw `MargoError` `'state'`; any use after `dispose()` throws `'disposed'`. Limits: 1,000,000
particles and 1,000,000 vertices in all (the material mesh's own limit).
`node scripts/run-with-timeout.mjs --max=8 -- node packages/vfx/test/solid-check.mjs` (real GPU; `MARGO_COMPAT=1` for
the WebGL2 layer) draws four coloured boxes from one merged mesh, checks each box's colour at its projected centre, that
a hidden box shows the background, that rays pick the box drawn there, and a ranged upload after a move.

Sources (clean room, from the papers and the rivals' public feature descriptions, no rival code read): Reeves,
"Particle Systems - a Technique for Modeling a Class of Fuzzy Objects", ACM TOG 2(2), 1983; Carucci, "Inside Geometry
Instancing", GPU Gems 2 ch. 3, 2005 (the instancing alternative weighed above); Moller and Trumbore, "Fast, Minimum
Storage Ray-Triangle Intersection", Journal of Graphics Tools 2(1), 1997.

### Sub-emitters and GPU events

`events` gives particles children: when a particle is born from the emitter (`on: 'birth'`: a spark trail, a muzzle
flash), dies (`on: 'death'`), or meets the ground faster than `speed` world units a second (`on: 'collision'`, default
0.5), it raises an event on the GPU, and in the next frame `count` particles (1 to 64, default 8) are born where it was
into free slots of the same effect. They start with `inherit` (default 0) of
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
// Muzzle sparks: every shot the emitter fires puts 6 sparks where it was born.
const gun = VFX.attach(engine, {
  capacity: 2_000, rate: 0, position: [0, 1, 0], velocity: [30, 0, 0], lifetime: [0.4, 0.4], size: 0.02, turbulence: 0,
  events: {on: 'birth', count: 6, lifetime: [0.1, 0.25], size: 0.04, spread: 3, color: [1, 0.7, 0.3, 1]},
}, {events});
gun.burst(1);
engine.start();
```

Events are found, listed and turned into births entirely on the GPU in slot order (no atomics, no read-back), so the
same frames give the same particles byte for byte. Children take only free slots: when there are fewer free slots
than children wanted, the lowest events in slot order get theirs first and the rest are dropped; the emitter's own
births (`rate`, `burst`) come first. Collision events come from the ground plane only, not from `obstacles`. With
events on, the effect counts its free slots every frame, two small dispatches it skips without them, and adds two
storage buffers to the simulation (eight is the device minimum: events with a mesh `emitter` use all eight). On the
WebGL2 compatibility layer every kernel of an effect with events runs on the GPU, none on the layer's CPU tier. `on` is
read at attach; the other settings every frame. Both GPU runners also check disposal and device restoration during read-back, and centres at clip depths 0.98, 1, 1.02 and 1.08. `node packages/vfx/test/features-check.mjs` (real GPU) reads back the
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
import {loadGLTF} from 'margoengine/gltf/pbr';
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

On the WebGL2 layer an effect with a prewarm (hundreds of steps) keeps the steps of its first frames until its compatibility route has loaded, then runs them in order on the route's draws, so the prewarm never runs on the layer's CPU tier; an effect with no prewarm simulates every frame on its WebGPU kernels until the route loads, so no frame is drawn differently; the `overLife` feature reads an effect's stored life and birth velocity before storing, so its route kernels plan as GPU draws too (`test/route-loading.test.js`).

On WebGPU the mix is in the billboard fragment shader. On the WebGL2 route the same shader translates to GLSL ES 3.00
(`mix` of the two cell samples) and the route's draw wrapper still drops instances past the frame's count.
`node packages/vfx/test/flipbook-webgl2.mjs` runs that page on the compatibility layer: on an RTX A6000 the same two
centre pixels read 111,111,0 and 0,79,79, within 1 of the CPU mix 112,112,0 and 0,80,80.
`node packages/vfx/test/features-check.mjs` (real GPU) holds two particles halfway between frames of a 2 x 2 solid
atlas, one of them wrapping onto the next row, and checks each centre pixel against the same mix computed on the CPU.

The WebGL2 visibility kernel retains the simulation declarations and feature bindings used by its cull expression. The full GPU suite checks velocity stretch on that route as well as native WebGPU. Lit particles use weighted `OIT` on WebGL2; the suite also requires the documented `ExactOIT` rejection there, while native WebGPU keeps its exact-pass pixel checks.

### Particle shadows and lights

`shadows` makes particles cast sun shadows and emit point lights. Each live particle is a sphere impostor in the directional shadow map: under the cascade's orthographic matrix the front of the sphere is `centerZ - sqrt(r^2 - x^2 - y^2)`. The map's own receiver bias stays in the shadow pass. The first `count` live slots, in slot order, become point lights (default 8, at most 64). `range` is a distance in world units (default 4), not scaled by the particle's size. `intensity` (default 1) is the light's intensity. `decay` is always 2, so a clustered list uses its windowed inverse-square falloff. `cast` is a `Shadows` and `into` is a `Clustered`; either may be left out. `count`, `range` and `intensity` are read every frame. `range` and `intensity` must be finite f32 values. A finite double that overflows f32 is a RangeError (https://margoengine.com/errors#vfx-float). `cast` and `into` are fixed at attach. The feature sets `buffer` on the options object to the light list (a header, then up to 64 lights). `into` sees that list about two frames later, because the read-back waits for the frame to finish.

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

`nodes` compiles a graph into the simulation. Each operator is `const`, `attribute` (`position`, `velocity`, `size`, `color`, `life`, `age`), `add`, `mul`, `sub`, `mix`, `min`, `max`, `scale`, `normalize`, `length`, `force` or `drag`. `force` adds a vector to the acceleration. `drag` subtracts a number times the velocity. `normalize` divides by the largest absolute component and then by that vector's length, on the CPU and in the shader. The GPU checks cover (1e-21, 0, 0), (1e20, 0, 0), mixed-component vectors and zero on WebGPU and WebGL2. An operator runs after the ones it reads. A cycle, a self input, an unknown operator or a bad width is a `TypeError`. At most 32 operators, and at most 16 numeric literals. Const and scale numbers are read every frame, and each one must be a finite f32. A finite double that overflows f32 is a RangeError (https://margoengine.com/errors#vfx-float). The operators and the wires are fixed at attach. The acceleration is added after gravity, curl and fields. Velocity moves by that acceleration times the step, then position moves by the new velocity times the step.

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

### Curves over life

`overLife` from `@margoengine/vfx/over-life` shapes each particle over its normalized life with 2 to 32 evenly spaced
samples per curve: `spin` adds radians per second to `angularVelocity` (each -1000..1000), `speed` multiplies the birth
velocity (forces stay additive), `size` multiplies the birth size (growth beyond 1 allowed) and `velocityLimit` caps the
world speed (a number or a curve). Curves are read every frame. The spin is applied where the angle is drawn: the drawn
angle is birth angle + angular velocity x age + initial life x the spin curve's integral over the life lived, and the
stored birth angle never moves, so ribbons, random atlas frames and mesh tumble axes stay with their particle.

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx/base';
import {overLife} from 'margoengine/vfx/over-life';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
// Leaves that spin up, slow down and grow as they fall.
VFX.attach(engine, {
  capacity: 2048, rate: 60, size: 0.2, lifetime: [2, 3], gravity: [0, -1, 0],
  overLife: {spin: [0, 6], speed: [1, 0.2], size: [1, 1.5], velocityLimit: 3},
}, {overLife});
engine.start();
```

### Moving emitters: local space, inherited velocity and distance emission

`space` from `@margoengine/vfx/space` gives an emitter a moving frame. `transform` is a column-major rigid 4x4 matrix
(rotation and translation only; scale and shear throw RangeError), read every step, default identity. `mode: 'local'`
carries the live particles with the frame as it moves and turns; `'world'` (the default) leaves them where they were born.
`inheritVelocity` (0..1, default 0) adds that share of the frame origin's velocity to each birth, and `ratePerDistance`
(0..1,000,000, default 0) adds births per world unit the origin travels, spread along the path and carried across
frames, so a fast emitter leaves an unbroken trail. Particles stay in world coordinates in their buffers, so collisions,
fields and other draws read them as usual; `reset()` starts the distance count again without a jump.

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx/base';
import {space} from 'margoengine/vfx/space';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
// A torch carried in a circle: a trail with eight births a metre, half the torch's speed given to each spark.
const transform = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1]);
VFX.attach(engine, {
  capacity: 4096, rate: 30, size: 0.05, lifetime: [0.5, 1], velocity: [0, 1, 0], spread: 0.5, color: [1, 0.6, 0.2, 1],
  space: {mode: 'world', transform, inheritVelocity: 0.5, ratePerDistance: 8},
}, {space});
let angle = 0;
engine.onFrame((_engine, delta) => {
  angle += delta;
  transform[12] = 2 * Math.cos(angle);
  transform[14] = 2 * Math.sin(angle);
});
engine.start();
```

### Prewarm and timed bursts

`schedule` from `@margoengine/vfx/schedule` fixes, at attach, a prewarm and a list of bursts. `prewarm` (0..3600 s,
default 0) runs that much simulation in ordinary steps of `step` seconds (0.001..1, default 1/60, at most 10,000 steps)
before the first visible frame, so a fire or a fountain starts full. Each burst gives `count` births (whole, up to
`capacity`) at `time` seconds after the start, repeated `cycles` times (1..16,384, default 1) every `interval` seconds
(default 0), each repetition happening with chance `probability` (0..1, default 1). The chances are drawn from `seed`
(an unsigned 32-bit integer, default 0) and each repetition's identity, so a seed gives the same bursts on every run,
and `reset()` replays the same schedule. An effect holds at most 1,024 burst definitions and 16,384 repetitions; a
frame's births are capped by its free slots.

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx/base';
import {schedule} from 'margoengine/vfx/schedule';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
// Fireworks: a smouldering base already lit, a volley of five shells half a second apart, and crackle that may skip.
VFX.attach(engine, {
  capacity: 8192, rate: 40, size: 0.06, lifetime: [1, 2], velocity: [0, 6, 0], spread: 3, color: [1, 0.8, 0.3, 1],
  schedule: {
    prewarm: 2,
    seed: 7,
    bursts: [
      {time: 0.5, count: 400, cycles: 5, interval: 0.5},
      {time: 3, count: 100, cycles: 20, interval: 0.1, probability: 0.6},
    ],
  },
}, {schedule});
engine.start();
```

### Node particle systems

`@margoengine/vfx/node-system` describes a whole particle system, or several that chain, as a graph of blocks in versioned JSON. It compiles to ordinary `VFX` options (every range is checked by `VFX` itself) and runs the chaining on a clock you drive.

Blocks, each with a unique `id`; a wire is a block id in place of a literal:

- Values: `number`, `vector`, `color`, `random` (`min`, `max`, optional `seed`, `vector: true` for three draws), `math` (`add`, `sub`, `mul`, `min`, `max`, `mix`), `gradient` (2..8 stops) and `curve` (2..32 samples). A `random` block draws one value per compile, deterministically from its `seed` and the compile `seed` (default 0); fed to a lifetime it stays the range `[min, max]`, so the GPU draws per particle.
- `shape`: `sphere`, `cone`, `hemisphere`, `cylinder`, `torus`, `rectangle-edge` or `grid`, with that shape's fields.
- Creation: `create-capacity`, `create-rate`, `create-initial`, `create-lifetime`, `create-size`, `create-color`, `create-position`, `create-velocity` (with `spread`), `create-prewarm`, `create-burst`.
- Update: `update-size`, `update-alpha`, `update-color` (a gradient), `update-spin`, `update-speed`, `update-velocity-limit`, `update-gravity`, `update-turbulence`, `update-ground`, `update-forces` (the `nodes` operator graph above).
- `system`: `shape`, `create` and `update` list block ids; `duration` is seconds it runs (default 0: until stopped).
- `trigger`: `on: 'start' | 'end'` starts `target` after `delay` seconds (default 0) of `source` starting or ending; `on: 'birth' | 'death' | 'collision'` makes `target` the sub-emitter of `source` (`count`, `inherit`, `speed`), built from the target's creation blocks, which then has no shape, update blocks or triggers. Systems no trigger targets start with `start()`.

`compileNodeSystem(graph, {seed})` returns `{systems, roots}`; `serializeNodeSystem` and `parseNodeSystem` save and read the JSON; `createNodeSystem(graphOrText, {create})` makes a `NodeParticleSystem` (`start()`, `update(dt)`, `running`, `elapsed`, `dispose()` and `Symbol.dispose`); `loadNodeSystem(url, {create, signal})` fetches one. `create(options, id)` runs when a system starts and may return `{stop, dispose}`; `stop` is called at the end of `duration` (else `dispose`). A refused graph throws `VFXNodeSystemError` with a stable `code` (`format`, `version`, `limit`, `duplicate-id`, `unknown-block`, `unknown-ref`, `wrong-type`, `bad-param`, `cycle`, `no-system`, `trigger`, `invalid-options`) and a link to https://margoengine.com/errors#vfx-node-system. At most 512 blocks and 32 systems.

```ts
import {VFX} from 'margoengine/vfx';
import {createNodeSystem, serializeNodeSystem, type NodeSystemGraph} from 'margoengine/vfx/node-system';
// Fireworks: a rocket for two seconds, then a shower that starts half a second later; each rocket spark bursts when it dies.
const graph: NodeSystemGraph = {
  format: 'margo-vfx-node-system',
  version: 1,
  blocks: [
    {id: 'rocket', type: 'system', duration: 2, create: ['r-rate', 'r-life', 'r-up'], update: ['r-grav']},
    {id: 'r-rate', type: 'create-rate', value: 20},
    {id: 'r-life', type: 'create-lifetime', value: 'life'},
    {id: 'life', type: 'random', min: 1, max: 1.5},
    {id: 'r-up', type: 'create-velocity', value: [0, 8, 0], spread: 1},
    {id: 'r-grav', type: 'update-gravity', value: [0, -6, 0]},
    {id: 'pop', type: 'system', create: ['p-life', 'p-size', 'p-color']},
    {id: 'p-life', type: 'create-lifetime', value: [0.4, 0.8]},
    {id: 'p-size', type: 'create-size', value: 0.04},
    {id: 'p-color', type: 'create-color', value: [1, 0.6, 0.2, 1]},
    {id: 'burst', type: 'trigger', on: 'death', source: 'rocket', target: 'pop', count: 16, inherit: 0.2},
    {id: 'shower', type: 'system', create: ['s-rate', 'p-color'], update: ['s-fall']},
    {id: 's-rate', type: 'create-rate', value: 60},
    {id: 's-fall', type: 'update-size', curve: [1, 0]},
    {id: 'after', type: 'trigger', on: 'end', source: 'rocket', target: 'shower', delay: 0.5},
  ],
};
const text = serializeNodeSystem(graph); // JSON you can save and load again with createNodeSystem(text, ...)
using show = createNodeSystem(text, {create: (options) => new VFX(options)});
show.start().update(2.6); // a real app calls update(dt) every frame and attaches each effect to its engine
console.log(show.running); // ['shower']
```

### More emitter shapes

`shapes` from `@margoengine/vfx/shapes` replaces the `emitter` feature with a superset: the original shapes plus
`hemisphere` (`radius`, default 1, the upper half, Y up), `cylinder` (`radius` 1, `height` 1, around Y), `torus`
(`radius` 1 to the tube's centre, `tube` 0.25, smaller than `radius`, lying in XZ), `rectangle-edge` (the perimeter of a
`width` by `height` rectangle in XZ, default 1 by 1) and `grid` (`columns`, `rows` and `layers` cells, whole, each
default 1 and at most 1,000,000 cells in all, `spacing` default `[1, 1, 1]`, centred). Births are spread evenly by
area or volume: `shell: true` places them on the surface of a hemisphere, cylinder or torus, otherwise they fill it.
`speed` (-1000..1000 m/s, default 0) adds a push along the shape's outward direction (up for a grid) to the effect's
`velocity`. All shapes are centred on the effect's `position`; the shape is fixed at attach (its sizes may change).

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx/base';
import {shapes} from 'margoengine/vfx/shapes';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
// A portal ring: sparks born on the surface of a torus and pushed outward from its tube.
VFX.attach(engine, {
  capacity: 8192, rate: 1200, position: [0, 1.5, 0], size: 0.03, lifetime: [0.5, 1], gravity: [0, 0, 0],
  velocity: [0, 0, 0], color: [0.4, 0.7, 1, 1],
  emitter: {shape: 'torus', radius: 1.2, tube: 0.1, shell: true, speed: 0.6},
}, {emitter: shapes});
engine.start();
```

## Film time: seeking an effect to a cut

A film rendered scene by scene starts each scene in a fresh process, and every effect counts its own clock: the time,
the birth remainder of a fractional `rate`, the step number that seeds each birth, queued bursts and the `schedule`
cursor. `VFX` has `advanceTime(delta)`, the CPU part of its frame update, and a `time` getter; its `onPreUpdate` runs
the same `advanceTime` and the simulate pass then simulates the step it counted, once per frame however many views
draw; another view of the frame takes a step of 0 s that lists and sorts the particles for its own camera and moves
nothing, and an effect no frame update reaches (its passes run directly) steps in each pass by the frame delta. An update with a delta of 0 (a `Reflector`, `Refractor` or `CubeCamera` capture
inside the frame) counts nothing, so a mirror in view does not move the seeds or drop the prewarm. So `seek` from `@margoengine/cutscene/seek` replays a run's steps and the next frame births what a run started
at 0 births there (`test/seek.test.js` to 54,000 steps). The particles alive at a cut are history on the GPU: a seek
moves the counters only, and the scene's warm-up frames, at least the longest lifetime, bring the cloud back. A
birth is seeded by its step and its birth number in that step, never by the slot it lands in, so the warm-up births
the very particles a continuous run holds at the cut, in other slots (`test/seek-check.mjs`: every live particle of a
2,000 particle effect equal bit for bit, births per step equal). That holds while every birth finds a free slot;
unsorted particles draw in slot order, so overlapping translucent particles can blend in another order after a seek.

```ts
import {Engine} from 'margoengine/core';
import {VFX} from 'margoengine/vfx';
import {seek} from 'margoengine/cutscene/seek';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sparks = VFX.attach(engine, {capacity: 2000, rate: 600, lifetime: [1, 2]});
// The scene starts 95 s into the film and draws 2 s of warm-up frames first: seek to 93 s.
await seek(engine, 93, {fps: 30});
for (let frame = 0; frame < 60; frame++) engine.render({delta: 1 / 30});
console.log(sparks.time);
```

### A film clock: the same particles at any frame rate

Give the effect a `FilmClock` from `@margoengine/math/clock` as `clock` and it steps in fixed ticks of 1/120 s
(`VFX_TICK_RATE`), as many as the clock owes since the last drawn frame, instead of one step of the frame's delta. Each
tick has its exact time (`ticks / 120`), its births and the step number that seeds them, and the features see the tick's
delta. So the same shot drawn at 24, 30, 60 or 5 fps holds the same particle buffer, every byte, at every time those
rates share; a seek is setting the clock (the next drawn frame runs every tick owed, and a seek back restarts the effect
and replays from 0); and no frame, however long, loses time (`test/film-clock.test.js` for the counters and uniforms,
`test/film-clock-check.mjs` for the particle buffer on WebGPU and the WebGL2 layer). `advanceTime` and `onPreUpdate`
move nothing while a clock is set; frames closer than a tick take the 0 s step a second view takes. A 60 fps frame runs
two steps of 1/120 s where it ran one of 1/60 s, a finer integration of the same motion. Every owed tick runs in the
next drawn frame, so a jump of T seconds costs 120 T simulation passes in that frame.

```ts
import {Engine} from 'margoengine/core';
import {VFX} from 'margoengine/vfx';
import {FilmClock} from 'margoengine/math/clock';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const clock = new FilmClock({fps: 24});
const sparks = VFX.attach(engine, {capacity: 2000, rate: 600, lifetime: [1, 2], clock});
for (let frame = 0; frame <= 48; frame++) {
  clock.frame = frame;
  engine.render({delta: 1 / 24});
}
console.log(sparks.time); // 2: 240 ticks, the same particles a 60 fps render holds at 2 s
```

`Flame` and `Smoke` are clocks too: each has `advanceTime(delta)` and `time`, and works everything it draws (the
puffing, the light's flicker, the dither shift, the wind it samples, a smoke column's speed and size curves and its
puffs' rate and wind) from that clock, so a seek moves them with the effects and a flame or column at a cut draws what a
continuous run draws there (`test/seek.test.js`, uniforms, lights and curves equal to 54,000 steps). A flame's noise
seed follows its place among the flames of its engine, so a scene drawn after another in the same process seeds its
flames as a fresh process does.

Several cuts in one process: `resetTime()` puts each vfx clock back as a fresh one with the same options has it
(`resetClocks` from `@margoengine/cutscene/seek` calls it on every clock), so a later `seek` gives what a fresh world
seeked there gives. `VFX.resetTime()` is `reset()` as a clock (particles, counters, step seeds, queued bursts and the
frame-update flag; nothing after `dispose()`). `Smoke` resets its puffs with it; `FireFront` unburns every cell,
queues the `ignitions` of its options again (ones added with `ignite` are dropped), restarts its random stream from
`seed` and idles its columns, flames and embers; `Battery` queues its `shots` again (ones added with `fire` or
`broadside` are dropped), idles its banks, flashes and lights and clears the holes it drew into its targets' masks;
`HullFire` repaints its mask for time 0. Evidence: `test/reset-time.test.js` (state of a reset clock equals a fresh
one's, before and after a seek) and `test/seek-check.mjs` (on the GPU, a reset effect drawn beside a fresh one holds the
same live particles, bit for bit, on WebGPU and on the WebGL2 layer).

```ts
import {Engine} from 'margoengine/core';
import {VFX} from 'margoengine/vfx';
import {resetClocks, seek} from 'margoengine/cutscene/seek';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
VFX.attach(engine, {capacity: 2000, rate: 600, lifetime: [1, 2]});
for (let frame = 0; frame < 60; frame++) engine.render({delta: 1 / 30});
// The next scene of the film starts at 40 s: put every clock back to 0, then seek.
resetClocks(engine);
await seek(engine, 40, {fps: 30});
```

### Wind

`wind: [x, z]` (m/s) or `{sample(x, y, z, t)}` (a `WindField` or a `WeatherMachine`'s `wind`) makes every particle's horizontal
velocity relax toward the wind with a time constant of 0.25 s, the drag of a parcel that moves with the air (Stokes
drag, dv/dt = (u - v) / tau; Crowe, Schwarzkopf, Sommerfeld and Tsuji, Multiphase Flows with Droplets and Particles,
2nd ed., CRC Press 2011, chapter 1). Smoke that rises at w in a wind U leans atan(U / w) from the vertical once it has
had about a second; the vertical velocity stays with gravity and the launch. A field is read at the emitter every
frame. `setWind(wind)` changes it between frames (undefined and [0, 0] give no wind force; a bad value throws and
keeps the old one). A weather drive writes it for you: `WeatherDrive` (`@margoengine/weather/drive`) finds every
effect by name and gives it the field's wind. It costs no extra upload (the wind rides in a spare word of the 224-byte
frame block as two half floats, so each component is limited to 1,000 m/s and about three digits) and no extra shader
work for an effect with no wind.

```ts
import {EngineKernel} from 'margoengine/core';
import {VFX} from 'margoengine/vfx';
import {WeatherMachine} from 'margoengine/weather';

const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend: 'webgpu'});
const smoke = VFX.attach(engine, {
  capacity: 20_000, rate: 800, position: [0, 0.3, 0], velocity: [0, 3, 0], spread: 0.3,
  gravity: [0, 0, 0], turbulence: 0.2, lifetime: [3, 5], size: 0.5, color: [0.5, 0.5, 0.5, 0.4],
  wind: [6, 0], // leans atan(6 / 3) = 63 degrees toward +x
});
smoke.setWind(new WeatherMachine('storm').wind); // or follow a weather's wind field
engine.start();
```

### A fire from one call

`Fire` (`@margoengine/vfx/fire`) builds a wood fire from a kit's `hearth`: the flames, embers and optional kettle
steam (`@margoengine/vfx`), and the firelight as a flickering flame line over the fuel (`lineLights` of
`@margoengine/clustered/line`) whose points cast soft shadows the size of the flames. The light, its shadows and the
flames come from the same data, so they agree with no tuning; `power` turns the light and the flames up together.

```ts
import {Engine, box} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {LocalShadows} from 'margoengine/clustered/shadows';
import {LightGroups} from 'margoengine/clustered/groups';
import {Fire} from 'margoengine/vfx/fire';

const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const floor = engine.createMesh().setGeometry(box(6, 0.1, 6));
const logs = engine.createMesh().setGeometry(box(0.62, 0.12, 0.2)).setPosition([0, 0.11, 0]);
const lights = Clustered.attach(engine);
const shadows = LocalShadows.attach(engine, {lights, resolution: 1024});
shadows.add(floor);
shadows.add(logs);
const groups = LightGroups.attach(engine, lights);
// The flames are born on the logs' top (y 0.17); the light stands 0.3 m above, along x.
const fire = Fire.attach(engine, {position: [0, 0.17, 0], lights: groups, steam: [0.4, 0.6, 0]});
// Lights of your own sit beside the fire's in another group; its flicker never replaces them.
groups.group('room').setLights([{position: [2, 2.4, 1], range: 8, intensity: 2}]);
engine.start();
console.log(fire.lights.length); // 2
```

- Data: `hearth` (default `snowNight().hearth`): `light.length` 0.62 m of flames, `light.height` 0.14 m over the fuel
  top, `light.radius` 0.155 m per point (`lineShadowRadius` for that length), 1,860 K firelight (`FIRELIGHT_KELVIN`), intensity
  13.7 (5.11 cd at the peak) shared by the points, range 9 m, the `fire` flicker curve with one seed for the whole line; `emberHeight` 0.1 m; the `fire`,
  `embers` and `steam` particles, each prewarmed for its longest lifetime.
- A reflection is never brighter than what it reflects: each point is a sphere light (`PointLight.radius`) whose
  radiance, intensity / (pi radius^2), equals the flames' brightest radiance (their intensity times their brightest
  colour), so a metal near the fire mirrors it at most F0 times the flames. The default hearth's flames are as bright
  as its light (intensity 58.5, 33.9 in luminance), so each sphere is the flame line's own 0.155 m share; a light
  brighter than its flames grows the spheres instead. A wall 0.4 m behind the fire (albedo 0.5) is then outside them
  and reads about a ninth of the flames, where 0.634 m spheres sized to dimmer flames lit it about as bright as they
  were (KB-FIRE-RECEIVER1). Its shadow keeps `light.radius`. `power` scales the light and the flames alike, so the
  size does not change with it.
- Options: `position` (required, the fuel top), `power` (default 1: light intensity and the flames' and embers'
  radiance), `width` (default `light.length`; the shadow radius scales with it) and `axis` (default [1, 0, 0]) of the
  flame line, `samples` (default 2), `castShadow` (default true), `depth` (the scene depth: the flames, embers and steam
  fade 0.08 m before the logs; default none, hard-edged particles), `embers` (default true) and `steam` (a point; default no steam).
  `wind` (`[x, z]` m/s or a field; the flames, embers and steam lean with it, see Wind above; default none) and `fire.setWind`.
- `lights`: a `LightGroups` (the fire takes a group of its own, `fire`, `fire 2`, ...) or a `Clustered`, whose whole
  list the fire then owns. With `castShadow`, its `Clustered` needs `LocalShadows` attached first: `Fire.attach` throws
  `MargoError` `'state'` otherwise. Omit `lights` for flames with no light. The fire is a plugin of its scene, so
  disposing the scene disposes it.
- `fire.lights` holds the steady points, `fire.particles` the `flames`, `embers` and `steam` effects. `fire.dispose()`
  stops the flicker, removes the fire's group (or empties a `Clustered` it owned) and disposes the particles.
- Not yet: TAA's reactive mask for the flames (the shared mask registry is a later vfx and taa job) and a light
  source size for highlights on metal (later clustered and materials jobs). Smoke over the fire: `Smoke` (below);
  soot on the walls: `@margoengine/materials/soot`.

### A smoke column from one call

`Smoke` (`@margoengine/vfx/smoke`) stands a smoke column on a source from its heat release: lit soft puffs that rise
by the buoyant plume law, widen as they take in air, bend over and lean in the wind, and level off in stable air. One
call gives a physical column; every number below is an option.

```ts
import {Engine, box} from 'margoengine/core';
import {Smoke, airStability} from 'margoengine/vfx/smoke';
import {SMOKE_LOOKS} from 'margoengine/vfx/settings';

const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu',
  camera: {position: [0, 60, 260], target: [0, 60, 0], far: 3000},
});
engine.createMesh().setGeometry(box(400, 1, 400)).setPosition([0, -0.5, 0]);
// A burning house: 5 MW from a 3 m source, in a 4 m/s wind from the west, under air that stops it near 300 m.
const smoke = Smoke.attach(engine, {position: [0, 6, 0], heat: 5e6, radius: 3, wind: [4, 0], stability: airStability(0.005)});
engine.start();
console.log(smoke.column(30).rise.toFixed(0)); // height (m) a puff has risen after 30 s
console.log(Object.keys(SMOKE_LOOKS).join(', ')); // campfire, houseFire, wildfire, oil
```

- The law: a heat release Q (watts, `heat`) gives the buoyancy flux F = g Q / (pi c_p rho T) (Briggs 1969 eq. 4.20;
  `buoyancyFlux`, 8.8 m^4/s^3 a megawatt at 15 C). In calm air the column is the plume of Morton, Taylor and Turner
  1956: it widens as (6/5) alpha z (alpha 0.093) and slows as z^(-1/3), from a virtual origin below a source of radius
  `radius`. In a wind U it is the lower of that and Briggs' bent-over "2/3 law" plume, rise 1.6 F^(1/3) x^(2/3) / U at
  x = U t downwind with radius 0.5 z (eqs. 4.31 and 4.23). In stable air (`stability` s = (g / T) dtheta/dz,
  `airStability(lapse)`) it levels off at Briggs' final rise 5.0 F^(1/4) s^(-3/8) in calm air or 2.9 (F / (U s))^(1/3)
  in a wind (eqs. 4.25 and 5.7) and spreads there. `plumeRise(t, F, U, r, s)` gives the column at any age;
  `smoke.column(t)` gives it for the smoke's own heat, wind and air.
- How it is drawn: each puff is a `VFX` particle (`lit`: shaded as a ball by the sun, ambient and optional `lights` and
  `shadows`; `curves`: fading in and out; `overLife`: its speed follows the column's rise speed and its size the
  column's width; prewarmed so the column is whole on the first frame). The puffs' wind pulls their horizontal speed
  toward U (see Wind above), so the column leans atan(U / w); in calm air the same 0.25 s drag pulls it toward rest,
  so the curl-noise churn stirs the column and never adds up over a puff's minute of life into a walk that lays the
  smoke along the ground and over the camera. Measured on an RTX A6000, WebGPU and the WebGL2 layer
  (`packages/vfx/test/smoke-check.mjs`): puff heights within 0.6% of the law after their first second (bound 7%), the
  same particle bytes on every run, and 60 frames of every live setting make no pipeline, buffer or texture.
- Wind: a `wind` of its own (`[x, z]` m/s or a field) overrides the weather; without one, a `WeatherDrive` in the scene
  writes the weather's wind on the puffs and the column bends with it, the rule of `Fire`. `fire`: stand the column on
  a `Fire` (`Smoke.attach(engine, {fire})`): it takes the flames' position and their wind, 20 kW and a 0.3 m source by
  default (a wood hearth).
- Options, read every frame: `position`, `heat` (default 5 MW), `radius` (2 m), `airTemperature` (288.15 K),
  `stability` (0, neutral), `wind`, `rate` (20 puffs/s), `color` (linear [0.3, 0.29, 0.28]), `opacity` (0.5),
  `turbulence` (0.4 m/s^2 of curl noise), `glow` (1: the fire's glow from below, see next). Read at attach: `lifetime`
  (60 s: the column is a puff's rise at that age; the capacity is rate x lifetime), `prewarm` (true, in steps of 0.1 s
  or a 600th of a long life), `texture` (a puff sprite; default a soft disc), `lights`,
  `shadows` and `depth` (puffs fade 1 m before surfaces). `setHeat`, `setWind`, `setFog`, `refill` (empty the column
  and prewarm it again next frame, for a column moved to a new fire) and `dispose`; `smoke.effect` is the `VFX`.
- Glow from below: the puffs are lit by a point at the source radiating `RADIANT_FRACTION` (0.3, Drysdale 2011;
  McGrattan, Baum and Hamins 2000) of the release, `glow` times 0.3 / 0.7 of `heat`, softened over the source radius
  (`VFXLit.glow` of `@margoengine/vfx/lit`: irradiance P / (4 pi (d^2 + r^2)) lights a puff as a 1,000 W/m^2 sun of
  intensity pi would). So the column over a fire is orange underneath and fades to grey as it climbs, at night with no
  other light; `glow: 0` turns it off. A new puff is opaque within `SMOKE_FADE_IN` (1 s) whatever its lifetime
  (`smokeAlphaCurve`; it was a fifth of the life, 12 s of a minute).

  ```ts
  import {Smoke} from 'margoengine/vfx/smoke';
  import {Engine} from 'margoengine/core';

  const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
  const smoke = Smoke.attach(engine, {position: [0, 8, 0], heat: 20e6, radius: 6, glow: 1.5});
  console.log(smoke.effect.options.lit?.glow?.power); // 12857142.857142856
  ```
- Settings: `SMOKE_SETTINGS` in `@margoengine/vfx/settings` (`applySmokeSettings`, `smokeSettingValues`,
  `SMOKE_LOOKS` campfire, houseFire, wildfire and oil); the wind rows are null by default and follow the weather.
  `applySmokeSettings(front, SMOKE_LOOKS.animatedFeature)` on a `FireFront` writes every smoke column it has and makes later
  (its `setSmokeLook`), except `heat` and `radius`, which the front keeps setting per column from its segments; a row left
  out gives back what the front built the column with (300 s life, 16 puffs a second, wood smoke, its `smoke` options).
- Flame settings: `FLAME_SETTINGS` in `@margoengine/vfx/settings` (`applyFlameSettings`, `FLAME_LOOKS`) are the live look rows of a
  `Fire`: `flames.size`, `flames.radiance` (under 1 keeps the core from blowing out), `flames.opacity`, `flames.ramp` and
  `flames.edgeColor` (a core-to-edge colour ramp along the flame's life), `embers.size`, `embers.count` and `embers.radiance`.
  Each is a multiple of what the kit gave, so the defaults leave the fire as built; `FLAME_LOOKS.animatedFeature` is larger,
  softer flames with a ramp and fewer, larger embers. A `FireFront`'s smoke columns take a smoke look as one target:
  `applySmokeSettings(front, SMOKE_LOOKS.animatedFeature)`.
  `applyFlameSettings(front, rows)` writes a `FireFront`'s flame volumes (its `setFlameLook`), the ones it makes later included.

```js
import { applyFlameSettings, FLAME_LOOKS } from '@margoengine/vfx/settings';

const fire = { particles: { flames: { options: { size: 0.2, intensity: 40, curves: { color: [{ at: 0, color: [1, 0.8, 0.3] }, { at: 1, color: [0.8, 0.2, 0.05] }] } } } } }; // a Fire has these parts
applyFlameSettings(fire, FLAME_LOOKS.animatedFeature);
console.log(fire.particles.flames.options.size); // 0.30000000000000004
```

### Flames at house and forest size

`Flame` (`@margoengine/vfx/flame`) draws a flame of any size, from a campfire to a burning house or a forest crown, as
one ray-marched volume over its footprint. Tall tapering tongues rise at the buoyant speed 0.5 sqrt(g L) (Quintiere
1989), break up at the tip so that flame shows half the time at the flame length (Zukoski et al. 1985), and the whole
zone puffs (necks, sheds a bulge that rises and burns out) at Cetegen and Ahmed 1993's 1.5 D^(-1/2) Hz
(`puffingFrequency`, `puffingDiameter`). Each point carries a heat, highest deep in the zone and low in the flame,
coloured by the blackbody of its temperature from `core` (2,200 K) to `edge` (1,000 K) (Planck's law through Wyman,
Sloan and Shirley 2013's fits of the CIE observer, `blackbodyColor`); the ray collects emission and absorption, so a
pixel is never brighter than the hottest gas it crosses, then goes through a camera's per-channel shoulder under
`peak` (default 1, scene-linear): the core saturates red, then green, and reads yellow-white while blue stays low, so no
pixel turns white whatever the rows ask. Give it a `length` in metres, an `intensity` in kW/m (Byram's flame length
0.0775 I^0.46, `byramFlameLength`) or a `heat` in watts over its footprint (Heskestad's height 0.235 Q^(2/5) - 1.02 D,
`heskestadFlameLength`). With `lights` (a `LightGroups` or a `Clustered`) it lights the meshes added to that
`Clustered`, and smoke lit by it, with up to four point lights over its footprint a third of the way up, as bright as
its silhouette at its peak radiance (`FLAME_LIGHT_FILL`), each flickering with the puffing of the tongues above it.
To meter a fire as a real emitter, `flameLuminousFlux(heat, kelvin, radiantFraction = FLAME_RADIANT_FRACTION)` gives
its lumens: the radiated share of its heat release (chi_r about 0.3 for sooty fuels, Tewarson 2016, Koseki 1989) times the
luminous efficacy of blackbody radiation at its soot temperature (`blackbodyLuminousEfficacy`, Planck's law through the
photopic curve, about 0.5 lm/W at 1,760 K and 16.5 at CIE illuminant A). `heskestadHeat(length, diameter)` turns
Heskestad's height round to give the heat of a flame of a given length.
The luminous surface is thin, as the reaction zone of a diffusion flame is (Turns 2012, ch. 9): density rises over a
short step of the field, fine streaks a quarter and an eighth of a tongue across, drawn up with the flow, tear the
edge into wisps, and coverage follows 1 - T^2, so tongues keep crisp edges. The march steps at most 0.03 flame lengths
(64 to 256 steps, two at a time through empty air), bisects back to the surface where a ray first meets the flame, and
starts each ray at interleaved gradient noise shifted with the flame's clock (Jimenez 2014): a grazing view along a long
front shows no layers or fixed hatch, frames averaged by motion blur or TAA converge, and a frame drawn again at the
same time is the same picture. `crowns` (tree spacing, metres) makes it a crown fire: each tree torches as its own
tapering column that starts down in its crown and tops out at 0.6 to 1.4 flame lengths (crown flames one to two and a
half times the stand height, Van Wagner 1977, Alexander and Cruz 2011), so the foot and crest are ragged.
The flame is hottest low down, over the burning fuel (Butler et al. 2004), and along a line of fire its tips rise and fall
as separate tongues 0.7 to 1.3 times the mean length (Albini 1981). `slope` (`[dy/dx, dy/dz]`) stands it on the ground's
plane, so a line across a hillside is not cut by the slope. It lights the air and the ground around it with no light
setup: the light it scatters in the haze (`haze`, per metre, default 0.0005; a `FireFront` gives its flames 0.003) is
Sun et al. 2005's closed form for a point source, and the ground plane within `glowRadius` (3) flame lengths takes its
light at `groundAlbedo` (0.15; 0 with `lights`, whose point lights light the scene); `glow` scales both, 0 turns
them off. Without `depth`, a surface standing in that light (a tree) takes the light of the ground behind it. A second
pass writes the flame's depth where it is opaque, so a spark or a smoke puff behind the flames is hidden and one in front
draws over them.
Everything is read each frame and written into one uniform, so a flame that grows, moves, leans, changes its look or goes
out makes no GPU object after its first frame; every flame volume on a device shares its three pipelines (glow, flame,
depth).
The scene behind the flames shimmers through `HeatHaze` of `@margoengine/post/heat-haze`: `flame.plume` is the hot plume
it reads (base, length, footprint as drawn, lean in the wind, the flame's clock), so `new HeatHaze({sources: [flame]})`
in a `PostStack` bends the light through it, and `() => front.flameVolumes` does it for a `FireFront`.

```ts
import {Engine} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {LightGroups} from 'margoengine/clustered/groups';
import {Flame, byramFlameLength, flameLuminousFlux} from 'margoengine/vfx/flame';
import {FLAME_LOOKS, applyFlameSettings} from 'margoengine/vfx/settings';

const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const lights = LightGroups.attach(engine, Clustered.attach(engine));
// A house fire: 20 MW through a 6 m by 6 m roof breach (Heskestad's 5.4 m flames), lighting the street.
const house = Flame.attach(engine, {position: [0, 3, 0], heat: 20e6, footprint: [6, 6], wind: [3, 0], lights});
// A crown fire front: a 10,000 kW/m fireline has Byram's 5.4 m flames, torching trees 8 m apart.
const crown = Flame.attach(engine, {position: [40, 0, 0], intensity: 10000, footprint: [30, 4], crowns: 8, lights});
// A line of fire across a 30 percent hillside in smoky air: it stands on the slope and lights the haze around it.
const line = Flame.attach(engine, {position: [0, 0, 60], length: 6, footprint: [40, 4], slope: [0.3, 0], haze: 0.003});
applyFlameSettings(house, {...FLAME_LOOKS.animatedFeature, 'flames.core': 2400, 'flames.tongues': 0.8});
house.options.footprint = [8, 6]; // it spreads; the same uniform, rewritten in place
console.log(byramFlameLength(10000).toFixed(1), house.puffing.toFixed(2)); // 5.4 0.54
console.log(Math.round(flameLuminousFlux(1e6, 1760))); // about 150,000 lm from a 1 MW wood fire
```

- The flame rows of `FLAME_SETTINGS` (`applyFlameSettings`, all live): `flames.core` and `flames.edge` (kelvin),
  `flames.peak`, `flames.flicker` (puffing and light flicker, 0 holds it steady), `flames.tongues` (tongue size),
  `flames.size`, `flames.radiance`, `flames.opacity`, `flames.ramp`, `flames.edgeColor`, `flames.glow` and `flames.haze`
  (the glow and the haze of a flame volume as multiples of its own). On a hearth `Fire` they
  change its billboards after attach: core, edge and peak away from their defaults give them the blackbody ramp of
  `flameRamp`, flicker scales their turbulence and tongues their noise scale; every row at its default gives the kit back.
- Under a tonemap, raise `peak` (up to 16 on the row) so the core blooms; the light follows the peak, so a wall is never
  brighter than the flame that lights it. With the animatedFeature looks of `@margoengine/post` (bloom over 1) and
  `@margoengine/tonemap` (AgX), `flames.peak` 4 makes the core glow and grade a bright yellow-white with no white pixel
  (flame-check `graded`); at peak 1 it never reaches that bloom and grades dim orange.
- `Fire.attach(engine, {position, flameLength: 10, width: 12, lights})` makes the fire's flames such a `Flame`
  (`fire.flame`, along `axis`), lit through the fire's `lights`; its embers scale by the square root of the length over
  the hearth's 0.25 m. A `Smoke` column (`fire.smoke`) stands on the
  flame tips with the fire's convective heat: Heskestad's length turned back into a heat release, 70% convected
  (Heskestad 1983; Drysdale 2011 ch. 4), as wide as the flames and lit by the fire's `lights`. `smoke: {...}` gives it
  options of its own, `smoke: false` none. It is on by default with `flameLength` and off for the hearth's own flames.
- A flame volume is drawn just before the particle effects, smoke and cloud puffs (order 5.95), then writes its depth
  where its transmittance falls below a half (5.96): a puff or ember behind the flames is hidden by them, one in front
  draws over them (flame-check `order`: a dark column in front of an 8 m flame leaves 254 of its 2,583 flame pixels, one
  behind leaves all of them; drawn after the particles with no depth, as before, the one in front left 2,301 of 2,458).
  Drawn before them with no depth, a smoke column behind the flame covered it as a hard-edged slab (flame-check `veil`).
- `FireFront` draws flames: `flames` (16) volumes on its hottest stretches, each as long as Byram's flame of that
  stretch's fireline intensity, and `buildingFlames` (8) on burning buildings, each as long as Heskestad's height of the
  building's heat over its vent (`structureVent`, 0.1 of the floor). `flame: {lights}` lights the land, smoke and
  buildings from every volume (a bare `Clustered` is shared through a `LightGroups`). They are a fixed pool: the volumes
  move between stretches and no GPU object is made as the fire spreads. `front.flames()` lists what is drawn, with the
  ground's `slope` across each stretch, which the volume stands on. Each front volume throws embers (`flameEmbers`,
  default true; `front.flameEmbers` lists the effects): the hearth kit's embers scaled to a 20 m flame, born over the
  footprint a third of the flame up, their rate and launch speed growing as sqrt(L / 20) (embers loft with the plume,
  Sardoy et al. 2007), carried ahead of the front by the open wind; the ember rows of `FLAME_SETTINGS` scale them.
- Pass the scene `depth` (`DepthTexture` of `@margoengine/post/depth`) so the march stops at a house inside its own
  flames and the camera may stand in the fire; without it the volume's box is depth-tested against the scene.
- Limits: a flame is a procedural volume, not a fluid simulation; it has no soot of its own (a `Fire` adds `Smoke`), its
  light does not cast shadows, the glow lights a plane (the ground under the flame), not the scene's own surfaces, unless
  `depth` is given, and there is no heat shimmer (refraction needs the scene's colour, which a frame pass cannot read;
  KB-FLAME-HEATHAZE1).

### A wildfire front from one call

`FireFront` (`@margoengine/vfx/fire-front`) spreads a fire over a fuel map by wind, slope and fuel moisture in fixed steps,
leaves a burn texture behind it, feeds smoke columns along the whole front, throws embers that start spot fires and burns
buildings. It stands on a ground function and a fuel function and nothing else.

```ts
import {Engine, box} from 'margoengine/core';
import {FireFront} from 'margoengine/vfx/fire-front';
import {FIRE_LOOKS, applyFireSettings} from 'margoengine/vfx/settings';

const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu',
  camera: {position: [0, 200, 520], target: [0, 20, 0], far: 6000},
});
engine.createMesh().setGeometry(box(1000, 1, 1000)).setPosition([0, -0.5, 0]);
// A chaparral slope with a house on it, lit at the foot in a Santa Ana wind.
const fire = FireFront.attach(engine, {
  size: [1024, 1024], cell: 8, ground: (x) => 0.25 * (x + 512) / 4,
  fuel: 'FM4', structures: [{at: [150, 0]}], ignitions: [{at: [-300, 0], radius: 12}],
});
applyFireSettings(fire, FIRE_LOOKS.santaAna);
await fire.ready; // the smoke columns exist
engine.start();
console.log(fire.texture !== undefined, fire.smokeColumns.length); // true 12
```

- The spread: each fuel is a model of size classes (`FUEL_MODELS`: Anderson 1982's `FM1` to `FM13`, and a
  wood-frame `STRUCTURE`), combined by Albini 1976's area weights into Rothermel 1972's rate R = I_R xi (1 + phi_w +
  phi_s) / (rho_b eps Q_ig). `fireBehaviour(model, {moisture, wind, slope})` gives the head's rate, reaction and fireline
  intensity (Byram), flame length and length-to-breadth ratio; `fuelBed` is its precomputed part. Against the rates
  Anderson publishes at 5 mi/h midflame wind and 8 percent dead fuel moisture (`packages/vfx/test/fire-front.test.js`),
  with every dead class at Anderson's 8 percent (Albini's chart convention) the models are within 10 percent except FM5 (-19.5) and FM7 (+29.6), and FM13 is +4.8; the values were checked against the reports, and FM5 matches Albini 1976's own chart within 4 percent (its 18 is not the chart's), while FM7's chart runs 0.8 of ours: Albini's charts and Anderson's rates are a 1974 program run that differs from Rothermel 1972 as published, and the fuel models instead reproduce the values Andrews 2018 (RMRS-GTR-371) computes with BehavePlus, FM7 with its standard live surface-area-to-volume ratio of 1,500 1/ft (`docs/limits.md`). Each category is damped by its surface-area weighted moisture (Rothermel 1972). `moisture10` and `moisture100` set the heavier dead classes (default +0.01 and +0.02), in `fireBehaviour` and as `FireFront` options. A `WeatherDrive` (`@margoengine/weather/drive`) dries and wets a front's dead fuel from the weather's humidity, temperature and rain (`FuelMoistureModel`: Simard's equilibrium moisture, the timelag of each class, 35 percent in rain) while `moisture`, `moisture10` and `moisture100` are unset; the `moisture` rows of `FIRE_SETTINGS` are null by default (the option left unset), which is 0.06 with no weather. `smokeEmission` is the fine smoke the front gives off in grams a second (the fuel it burns times `smokeYield`, 15 g/kg, the extratropical forest PM2.5 of Akagi et al. 2011 table 1; temperate forest is 12.7, boreal 15.3); a `WeatherDrive` raises the weather's smoke from it (`@margoengine/weather`).
  Wind and slope add as vectors; each cell spreads as the focus of Richards' ellipse (`ellipseRate`), so a fire runs
  fast with the wind and uphill and creeps against them.
- Crown fire (on by default, `crown: false` keeps a fire on the ground): the timber models `FM8`, `FM9` and `FM10`
  carry a `canopy` (base height, bulk density, stand height), or `canopy: (x, z) => stand | null` sets it per place. A
  surface fire past Van Wagner 1977's critical intensity (0.010 z (460 + 25.9 M))^1.5 kW/m (canopy base height z,
  `foliarMoisture` M, default 1 = 100 percent) lifts into the crowns: it torches (passive, the crown fraction burned
  1 - exp(-0.23 (R - R0)) of the Canadian FBP System blends the surface and crown rates) or, where Rothermel 1991's crown
  rate (3.34 times FM10's rate at 0.4 of the 20 ft wind) passes Van Wagner's 3 / CBD m/min, runs as an active crown
  fire. A crown fire runs on into any stand where that rate criterion holds, even one too high to torch from below
  (the conditional crown fire of USDA report RMRS-RP-29, 2001). Burning crowns add their foliage to the intensity, so the flames
  (Thomas 1963's 0.0266 I^(2/3), drawn as torching trees), the smoke heat and the embers' throw all grow.
  `crownBehaviour` and `crownRate10` give the numbers alone; `crownFraction(x, z)` and `crowningCells` read the front.
  In a 20 m/s gale at 5 percent dead moisture an FM10 stand runs at 47 m/min (the Sundance fire of 1967 averaged 48 over
  nine hours; Cruz et al. 2005's active model gives 154, and Rothermel 1991 is known to run under it), releases about
  50 MW/m and draws 36 m flames.

  ```ts
  import {FUEL_MODELS, crownBehaviour, crownRate10, fireBehaviour} from 'margoengine/vfx/fire-front';

  const surface = fireBehaviour(FUEL_MODELS.FM10!, {moisture: 0.05, wind: 8});
  const crown = crownBehaviour(surface, FUEL_MODELS.FM10!.canopy!, 1, crownRate10({moisture: 0.05, wind: 20}), 20);
  console.log(crown.type, Math.round(crown.rate * 60)); // active 47
  ```
- Fixed steps: `step` (0.5 s). `advanceTime(delta)` runs whole steps (a frame does it once attached), `await
  fire.settle()` runs it until nothing burns, as `Flood` does. The same options and seed give the same fire, whatever the
  frame times.
- The burn texture: `fire.texture`, rgba32float, one texel per cell, row z: r the fire time it caught, g the time it
  burns out, b the fireline intensity in MW/m (kept after the cell burns out, for the scorch of plants left standing:
  `fireSource(fire)` in `@margoengine/scatter/states`), a the state (`UNBURNT` 0, `BURNING` 1, `BURNT` 2, `NO_FUEL` 3).
  `fire.origin`, `fire.cell` and `fire.width` place it. `fire.read()` is the same on the CPU, `state(x, z)` and
  `arrivalTime(x, z)` look one cell up.
- Flames: `flames` (16) and `buildingFlames` (8) `Flame` volumes, see above; `front.flames()` lists the stretches of front
  (Byram's length) and the burning buildings (Heskestad's) to draw. Each front volume lies along its stretch of fire line: `footprint`
  is `[along, across]` the heat-weighted spread of the burning cells on their principal axes (sqrt(12 var) plus a
  cell) and `yaw` turns it, so a diagonal or ragged line is not drawn as its axis-aligned box. A burning building releases its fuel over its burn
  time (about 200 kW per square metre of floor), so a house is megawatts of smoke heat.
- Smoke: `columns` (12) `Smoke` columns follow the hottest `segments()` of the front (heat is 0.7 of the reaction
  intensity over the burning cells of a `segment`-metre block, a column at the heat-weighted centre); `await fire.ready`
  for them, `columns: 0` for none. Each column leaves the top of its segment's flames (`segments()` gives the
  `flameLength`), as wide as its burning ground (2 to 60 m), lives 300 s at 16 puffs a second in slightly stable air
  (1.5e-4 / s^2), so it climbs to Briggs' final rise and spreads there as a pall over the valley, wood smoke
  [0.24, 0.22, 0.2] at 0.6, glowing orange from the fire below; `smoke` options override any of these. A column that
  takes up a fire after standing idle starts full (`refill`).
- Embers: a burning cell of more than 1,000 kW/m throws embers (`spotting`) that loft with the flame, fall at 4 m/s and
  land downwind at a lognormal distance (`spotSpread`); each lights dry fuel with chance `emberIgnition`. `onSpot` sees each.
- Buildings: `structures` burn as the `STRUCTURE` fuel, igniting from flame within 1.5 flame lengths for `structureExposure`
  seconds or from an ember, and burning `structureBurnTime` seconds.
- Wind: set `wind` (`[x, z]` m/s at 10 m, or a field) or leave it to a `WeatherDrive`, which writes it into a front it finds
  by name; `windReduction` (0.4) takes it to midflame height. Settings: `FIRE_SETTINGS` (`applyFireSettings`,
  `fireSettingValues`, `FIRE_LOOKS` mild, redFlag and santaAna) in `@margoengine/vfx/settings`; the wind rows follow the weather at null.
- Not yet: crown fire and fire-driven wind, and a fuel map made from biomes. Live fuel moisture does not follow the weather (it changes over weeks).

### Sliders for every particle control: settings

`@margoengine/vfx/settings` lists the look and motion options an effect reads every frame as one table for panels and
tools. `VFX_SETTINGS` has 24 rows in four groups (emission: `rate`, `spread`, `emissionExtent.x/y/z`; motion:
`velocity.x/y/z`, `gravity.x/y/z`, `turbulence`, `frequency`, `bounce`, `ground`, `angularVelocity`; wind: `wind.x`,
`wind.z`; look: `size`, `lifetime.min`, `lifetime.max`, `color`, `alpha`, `intensity`), each with `name`, `group`,
`kind`, `default`, `min`, `max`, `step`, `unit`, `about` and `live`; the row shape is the one every package's settings
share (`packages/shared/settings.js`). Every row is `live`: writing it creates no pipeline, buffer or texture, so it can
be keyed over a shot (`test/settings-check.mjs` counts 60 frames of every row and compares displayed frames byte for byte: the default rows draw the frame of an unconfigured effect and written rows the frame of the same options built in, native and on the WebGL2 layer).
Not rows: what is fixed at attach (`capacity`, `wrap`, `sort`, `texture`, an emitter's shape), the structured options of
the feature entries (`curves`, `fields`, `lit` ...) and `position`.

`applyVfxSettings(effect, values)` writes the values onto the effect (a name left out takes its default) and leaves an
option unset when its rows are all at their defaults, so an untouched effect keeps the options it was built with. Start a
panel from `vfxSettingValues(effect)` (each row from the effect's options, or its default) so the effect's own values
stay: that works for the `flames`, `embers` and `steam` of a `Fire` too (`fire.particles.flames`). `rate` null is the
effect's own rate (half its capacity a second). The two wind rows are `nullable` with `weather: 'wind'`: both null leave
the option unset and `WeatherDrive` writes the weather's wind into the effect each frame; a number (the other reads as 0)
sets `[x, z]` m/s and the drive leaves it alone, so a value overrides the weather. A name not in the table throws a
`TypeError`, a value outside its row's range or `lifetime.min` above `lifetime.max` a `RangeError`.

```ts
import {VFX} from 'margoengine/vfx';
import {VFX_SETTINGS, applyVfxSettings, vfxSettingValues} from 'margoengine/vfx/settings';
import {Engine} from 'margoengine/core';

const engine = await Engine.create(document.querySelector('canvas')!);
const smoke = VFX.attach(engine, {capacity: 4096, rate: 200, velocity: [0, 3, 0], color: [0.5, 0.5, 0.5, 0.6]});
// The panel's state starts from the effect's own values.
const values = vfxSettingValues(smoke);
const apply = () => applyVfxSettings(smoke, values);
// One slider per number row, built from the table; wind null follows the weather.
for (const row of VFX_SETTINGS) {
  if (row.kind !== 'number') continue;
  const slider = Object.assign(document.createElement('input'), {type: 'range', title: row.about, min: String(row.min), max: String(row.max), step: String(row.step)});
  slider.value = String(values[row.name] ?? row.min);
  slider.oninput = () => {
    values[row.name] = Number(slider.value);
    apply(); // every frame is fine
  };
  document.body.append(slider);
}
values['velocity.y'] = 6; // smoke rises faster
apply();
```

#### Sliders for blown sand

The same entry lists a `BlownSand` layer's controls: `SAND_SETTINGS` (18 rows, 13 live), `SAND_LIVE_SETTINGS`,
`SAND_LOOKS` (`drift`, `sandstorm`, `weather`), `applySandSettings(sand, values)`, `sandSettingValues(sand)` and
`sandSettingDefaults()`. The wind rows (`wind.speed`, `wind.direction` in degrees, `wind.gust`) and `fog` are `nullable`: at
null the layer follows the weather (`WeatherDrive` writes the state's wind and the air's extinction, dust included), a
number overrides it. `amount`, `seed`, `limit`, `range` and `softness` lay the particles out again or change the draw, so
they are not live; the other 13 rows cost no pipeline, buffer or texture (`test/settings-check.mjs`, native and WebGL2
layer, which also checks the default rows draw the layer's own frame exact).

```js
import {BlownSand} from 'margoengine/vfx/blown-sand';
import {SAND_LOOKS, applySandSettings, sandSettingValues} from 'margoengine/vfx/settings';

const sand = new BlownSand({ground: () => 0, wind: {speed: 0}});
applySandSettings(sand, SAND_LOOKS.sandstorm);
console.log(sandSettingValues(sand)['wind.speed']); // 18
```

### Puff clouds

`Clouds` (`@margoengine/vfx/clouds`) draws soft billboard clouds, drei's Clouds and Cloud for any engine: each cloud is
a seeded set of camera-facing puffs inside a box, and every puff of every cloud is drawn back to front in one
instanced draw (frame-graph order 6, with the particles). Each puff is lit by the light that reaches it through the
puffs between it and the light and scattered toward the eye, so the tops are bright and the undersides grey; puffs
fade out near the camera, can fade softly into the surfaces behind them, and take the scene fog.

```ts
import {Engine} from 'margoengine/core';
import {Clouds} from 'margoengine/vfx/clouds';

const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu',
  camera: {position: [0, 2, 18], target: [0, 4, 0]},
});
const clouds = Clouds.attach(engine, {limit: 200, lightDirection: [0.4, 1, 0.3]});
const cumulus = clouds.add({seed: 1, segments: 30, bounds: [10, 2, 3], volume: 6, speed: 0.2});
cumulus.matrix.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 5, -6, 1]); // its world matrix: 5 m up, 6 m back
clouds.add({seed: 2, segments: 12, color: '#ffd9c4', opacity: 0.8}).matrix[13] = 3;
engine.start();
console.log(clouds.clouds.length); // 2
```

- `Clouds` options, read every frame: `limit` (200, the most puffs drawn; later ones are counted in
  `stats.dropped`), `range` (draw only the first puffs; default all), `texture` (pixels `{width, height, data}` or an
  image; default a generated soft, lumpy puff, filtered with mips), `frustumCulled` (true: puffs wholly outside the
  view are skipped), `shading` (`'scatter'` default, `'unlit'` draws the colour as it is), `lightDirection` (toward the
  light, default [0.4, 1, 0.3]), `lightColor` (white), `ambient` (0.55), `density` (1, the optical depth through a
  full-size puff for the light behind it; a smaller puff shades in proportion to its width), `relief` (0; up to 1 each
  puff is shaded as a rounded lobe: the half-Lambert of its sphere normal for the direct light, the sky it faces and
  the sky light left under the puffs above it for the ambient, and three octaves of multiple scattering through the
  cloud, so a heap of puffs reads as a cauliflower cloud with lit tops and dark undersides), `softness` (0; world units over which a puff fades into the surface behind
  it) with `depth` (the scene depth, `() => depthTexture.texture` with `DepthTexture` from
  `@margoengine/post/depth`). `setFog(fog)` fogs the puffs with an `@margoengine/environment` `Fog`.
- A cloud (`clouds.add(options)`, options read every frame; `cloud.matrix` is its world matrix, `cloud.remove()` takes
  it out): `seed` (default its number in its Clouds), `segments` (20 puffs), `bounds` ([5, 1, 1], the box the centres
  lie in), `concentrate` (`'inside'` makes puffs smaller toward the box edge, `'outside'` larger, `'random'`),
  `volume` (6, the width of a full-size puff), `smallestVolume` (0.25 of `volume`), `distribute(index, random)`
  (return `{point, volume}` in -1..1 box units to place each puff yourself, plus optional `color`, linear RGB in place
  of the cloud's, and `emission`, linear RGB light the puff gives off, added after the lighting, for a fire glowing
  inside smoke; `clouds.puffs()` reports each puff's `light`, `sky` and `emission`), `speed` (0; puffs turn at up to `speed`
  radians a second and breathe), `growth` (4: a puff breathes by up to 1 / growth of its size), `fade` (10: a puff
  closer to the camera than this fades out, to nothing at the camera), `opacity` (1) and `color` (white). Puff sizes
  follow the matrix scale.
- Runs on WebGPU or the full WebGL2 compatibility layer. The small WebGL2 preview has no route for the puffs, so
  `Clouds.attach` refuses it at setup with `MargoError` code `unsupported` (https://margoengine.com/errors#webgpu).
- The animation is a function of the clouds' clock (`time`, the sum of frame deltas), so the same frames draw the same
  pixels; `puffs()` lists every puff at the current time in world space, and `stats` counts the last frame's puffs,
  `dropped`, `culled` and `drawn`.
- Lighting follows Harris, "Real-Time Cloud Rendering for Games" (GDC 2002): the light reaching a puff is the product
  of the transmittances of the puffs nearer the light (each weighted by a Gaussian of how far the puff lies off its
  light ray, in units of its radius), times the Rayleigh phase 3/4 (1 + cos^2) between the view ray and the light.
  It is computed per puff on the CPU, so a cloud of a few hundred puffs costs microseconds; the soft fade uses
  Lorach's symmetric contrast curve ("Soft Particles", NVIDIA 2007).

### Ballistic debris

`Debris` (`@margoengine/vfx/debris`) throws earth clods, rock blocks or timber out of an explosion or an impact over
film time: `count` pieces leave from within `radius` of `origin`, the inner ones first and fastest (launch speed
`speed (x / R)^(-1 / mu)`, Housen and Holsapple 2011), fly through air drag (`1/2 rho Cd A v^2`, Mastin 2001), tumble,
land on `ground` and raise a dust puff that grows and fades. Every path is solved once when the Debris is made, so
`seek(t)` shows the same pieces from any frame in any order. `draw(instances)` writes the pieces into a gltf
`PBRInstances` of any unit-sized mesh; `drawPuffs(clouds)` puts the landing dust into a `Clouds`.

```ts
import { Debris } from 'margoengine/vfx/debris';

const debris = new Debris({ origin: [0, 0, 0], radius: 60, count: 400, speed: 35, size: [0.3, 2], density: 2300 });
debris.seek(4);
const flying = debris.pieces().filter((p) => p.state === 'flying').length;
console.log(flying > 0); // true: four seconds after the throw, clods are in the air
```

Options (all optional): `origin` ([0, 0, 0]), `radius` (30 m), `count` (300, up to 20,000), `start` (0 s), `spread`
(1.5 s over which the pieces leave, inner first), `speed` (40 m/s at the rim), `maxSpeed` (4 x `speed`), `mu` (0.41),
`angle` (50 degrees) and `angleSpread` (12), `size` ([0.2, 1.2] m, log-uniform), `density` (1,800 kg/m^3), `drag` (1),
`airDensity` (1.2), `ground` ((x, z) => height; default flat at the origin), `tumble` (6 rad/s), `color`, `puffLife`
(6 s), `puffColor`, `puffScale` (0.04 m per cube root of joule) and `seed`. `pieces(t)` gives each piece's position,
velocity, size, state, launch and landing times; `puffs(t)` the live landing puffs.

### Wind-blown sand

`BlownSand` (`@margoengine/vfx/blown-sand`) draws sand that the wind lifts off bare ground: streaks of saltating grains
drifting low over the sand, plumes of spindrift streaming off dune crests, and a thin haze sheet of moving sand near the
ground. It is one instanced draw (frame-graph order 6, with the particles). Where the wind is under the threshold of
motion nothing is drawn, and the same time always draws the same sand, so it seeks to a cut like the rest of vfx.

```ts
import {Engine} from 'margoengine/core';
import {BlownSand, sandThreshold} from 'margoengine/vfx/blown-sand';

const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu',
  camera: {position: [0, 1.6, -20], target: [0, 0.5, 0]},
});
const dune = (x: number, z: number) => 6 * Math.exp(-((z - 30) * (z - 30)) / 400); // a ridge along x, 6 m high
const sand = BlownSand.attach(engine, {ground: dune, wind: {speed: 12, direction: 0, gust: 0.35}, seed: 7});
engine.start();
console.log(sandThreshold().toFixed(1)); // 6.6, m/s at 10 m for 0.25 mm sand
console.log(sand.time); // 0
```

- Options, read every frame (a change of `ground`, `mask`, `amount`, `seed` or the wind direction lays the particles out
  again): `ground` (a height function `(x, z) => y` or a grid `{samples, width, depth, cellSize, origin}`; required),
  `wind` (`{speed, direction, gust, gustPeriod}`, or a `WindField` from `@margoengine/weather`; required for prescribed transport; `direction`
  is where it blows toward in radians, 0 toward +z and pi/2 toward +x), `mask` (0 to 1 at world x, z: 0 where the sand
  is wet, grassed or paved), `amount` (1), `threshold` (default `sandThreshold(grainSize)`), `grainSize` (0.00025 m),
  `windHeight` (10 m), `color` (the grain albedo, `[0.5, 0.42, 0.29]` linear), `streak` (0.6 m), `height` (0.3 m),
  `opacity` (0.6), `gustiness` (the wind's `gust`, else 0.35), `seed` (1), `limit` (32,768 particles), `range` (250 m
  around the camera), `fog` (exponential density per metre, 0), `softness` (0, with `depth` the scene depth of
  `@margoengine/post/depth`: the sand fades into surfaces behind it) and `sky` (a `Sky` with `lighting.ambient` or
  `environment`: the grains take its diffuse light and the sky behind them; without it the engine's ambient term).
  `BLOWN_SAND_SETTINGS` lists every option with its default, range and unit as data.
- `sand.time` is the clock (the sum of frame deltas); set it or call `advanceTime(seconds)` to seek. `grains(eye)`
  lists the laid-out grains for a camera position. `sandEmission(options, x, z)` gives the flux, the speed-up and whether spindrift
  blows off there (`brink`), and `sandFlux(ratio)` the saturated flux for the ratio of shear velocity to its threshold.
- Physics. The threshold is Bagnold's fluid threshold (1941), u*t = 0.1 sqrt((rho_s - rho_a) / rho_a g d), carried to
  `windHeight` up the logarithmic profile over a rippled bed (roughness 0.1 mm, Sherman and Farrell 2008). The flux over
  the threshold follows Owen (1964) and Kawamura (1951) as reviewed by Kok et al. (2012), saturating over metres
  (Duran and Herrmann 2006). The wind over a dune is sped up by 1 + A (H[h'] + B h') with the Hilbert transform H of
  the slope (Jackson and Hunt 1975; Sauermann et al. 2001; Kroy et al. 2002, with A = 3 and B = 0.3 chosen here,
  not their values), largest just upwind of the crest and zero behind the brink, where grains fly out over the slip face
  (Bagnold 1941). Streaks are about 0.2 m wide and a metre apart and follow the gusts (Baas and Sherman 2005; Anderson
  and Haff 1988). The grains scatter light as half a diffraction lobe (Henyey and Greenstein 1941) and half a Lambert
  sphere, with a single-scattering albedo from the bed colour (Hapke 1981). Sources are in `docs/clean-room.md`.
- Limits: the sand is drawn within `range` of the camera, `limit` particles at most; with no `sky` the grains are lit
  by the engine's ambient term only, so under a bright clear sky the plumes read as faint smudges (`docs/limits.md`).

#### Blown snow from a live bed

Pass an attached `AeolianTransport` as `transport` to use the bed's moving mass and velocity. Supply a live terrain
sampler as `ground`. `referenceMass` sets the moving mass at half visual strength (0.02 kg/m² by default).
`transport.sample(x, z)` gives the local moving mass and velocity. Advance the physics world and
set the effect clock to the corresponding time when seeking a shot.

```ts
import { Engine } from '@margoengine/core';
import { AeolianTransport } from '@margoengine/physics/aeolian';
import { TerrainBed } from '@margoengine/physics/earth';
import { PhysicsWorld } from '@margoengine/physics/world';
import { BlownSand } from '@margoengine/vfx/blown-sand';

const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu', camera: { position: [-4, 2, -5], target: [0, 0.4, 2] },
});
const grid = { columns: 16, rows: 16, width: 16, depth: 16, centre: [0, 0] as const };
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
const terrain = new TerrainBed();
const transport = await AeolianTransport.load();
world.add(terrain, { ...grid, elevations: (_x, z) => Math.max(0, 0.8 - Math.abs(z) * 0.16) });
world.add(transport, { grid, material: 'snow', frictionVelocity: [0, 0.55], open: { maxZ: true } });
world.advance(180);
const bed = terrain.bed;
const snow = BlownSand.attach(engine, { ground: (x, z) => bed.sample(x, z).elevation, transport, color: [0.87, 0.90, 0.94] });
snow.time = 3;
engine.render({ delta: 0 });
```

### Cannon fire and burning hulls

`@margoengine/vfx/gunfire` fires muzzle-loading cannon for sea battle films: the muzzle flash and its light, the white
powder-smoke bank that rolls out of the barrel, hangs and drifts down the wind, the burning powder grains thrown out
with the flash, the round shot's flight through the wind to the water or into a ship (splinters, holes, ricochets),
and a burning wooden hull with flames over the deck, flames out of the gun ports, dark smoke above them, char on its
timbers and masts that fall when their stays burn.

```ts
import {Engine} from 'margoengine/core';
import {VFX} from 'margoengine/vfx';
import {Battery, HullFire, hullMaskImage} from 'margoengine/vfx/gunfire';
import {Texture} from 'margoengine/materials';
import {GUNFIRE_LOOKS, applyGunfireSettings} from 'margoengine/vfx/settings';
import {SPLASH_EMITTERS, ShotSplash} from 'margoengine/water/splash';

const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu',
  camera: {position: [-60, 12, 140], target: [60, 5, 0]},
});
// Eight 32-pounders down the side of a ship, firing a ripple broadside two seconds in.
const guns = Array.from({length: 8}, (_, i) => ({position: [6.5, 3, -21 + 6 * i] as [number, number, number], direction: [1, 0.02, 0] as [number, number, number]}));
const battery = Battery.attach(engine, {guns, wind: [3, 1]}).broadside(2, 0.3);
applyGunfireSettings(battery, GUNFIRE_LOOKS.trafalgar);
// The enemy ship 300 m off, burning from her waist: her char and shot holes go in one mask for her hull's material.
const enemy = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 300, 0, 0, 1];
const mask = new Texture(hullMaskImage(), {colorSpace: 'linear'});
battery.options.targets = [{ship: enemy, mask}];
const fire = HullFire.attach(engine, {
  ship: enemy,
  ignition: {at: [0, 6, 0], time: 0},
  ports: [{position: [6.5, 3, -8]}, {position: [6.5, 3, 8]}],
  wind: [3, 1],
  mask,
  masts: [{position: [0, 6, 2], height: 45, yards: [{at: 30, length: 24}]}],
});
// Where each shot lands: crown, column and mist (from @margoengine/water/splash).
ShotSplash.attach(engine, {source: battery, particles: (kind) => VFX.attach(engine, {...SPLASH_EMITTERS[kind]})});
for (let i = 0; i < 120; i++) engine.render({delta: 1 / 30});
console.log(battery.fired.length, battery.impacts().length, battery.hits().length, (fire.heat / 1e6).toFixed(1), 'MW', fire.rigging().length);
```

- `Battery` options: `guns` (up to 128; each a muzzle `position`, a barrel `direction`, `charge` 4.5 kg,
  `muzzleVelocity` 490 m/s and a `shot`, by default a 14.5 kg iron ball), `shots` (`{gun, time}` in film seconds; add
  more with `fire(gun, time)` or `broadside(time, interval, guns)`), `ship` (a `Floater` of `@margoengine/water/ships`
  or anything with `matrix()`: the guns ride it and are read at each shot), `wind` (`[x, z]` m/s or a field; leave it
  out and a `WeatherDrive` writes the weather's), `water` (a height source for the shots' fall; default the plane
  `seaLevel`), `lights` (a `Clustered` or a `LightGroups`: each gun lights the scene through a light of its own), and
  the look rows below. `banks` (48, at most 512) and `puffs` (24) size the pool of smoke banks, the oldest reused.
- The flash. Black powder burns to 43% gas and 56% solids (Noble and Abel 1875). The hot gas, still fuel-rich, burns
  again in the air past the muzzle (Klingenberg and Heimerl 1992) as a fireball the size of the charge's gas at its
  explosion temperature (`muzzleFlash(charge)`), lasting `flashDuration` (0.04 s). A flash is far shorter than a frame,
  so each frame shows the share of it that its shutter caught (`flashExposure`, `shutter` 0.5 for a 180 degree shutter):
  the flash lands on one frame at any frame rate and carries the same total light. The light is a sphere of the
  fireball's radius at its radiance (`flashLight` scales it).
- The smoke. Each shot's smoke is a puff that grows as a quarter of the distance it has moved through the air, keeps
  the gas's momentum along the barrel and rises on its heat (Richards 1965, Scorer 1957), levelling off in stable air
  (`stability`, N^2). Once still, the air's turbulence spreads it at Richardson's law (Batchelor 1952), at the
  dissipation of the sea's surface layer (Large and Pond 1981), and the wind carries it. `PowderPuff` gives the path.
  How dense it looks is its smoke mass over its area (`extinction`, 3 m^2/g for the white salts); `smokeColor(soot)`
  gives white powder smoke at 0 and black soot at 1 (Mulholland and Croarkin 2000). The banks are `Clouds` puffs (drawn
  with the puff-cloud lighting above), so `clouds` takes their light direction, colour and ambient.
- The shot. `shotPath` (and `shotFlight`, its impact) flies a round shot under gravity and sphere drag through the
  sound barrier (`sphereDrag`, Hoerner 1965) on its velocity relative to the wind, so a crosswind moves it by McCoy's
  (1999) lag-time rule; the battery flies its shots in its wind (its own, or the one the weather wrote). `impacts()`
  lists where and when each shot meets the water, at what speed, for `ShotSplash` of `@margoengine/water/splash`,
  which plans skips and the entry splash from it.
- Sparks. About 2% of a black-powder charge leaves the bore still burning (Margo's share). Each grain (`grain`, 3 mm)
  burns from its surface at about 1 cm/s (Piobert's law; Conkling and Mocella 2019), so it is out in d / 2r, and its
  quadratic drag slows it meanwhile: `powderGrains(charge, grain, speed)` gives the count, the burn time, the reach
  and the speed curve each shot's `sparks` emitter flies them with. They are drawn as the streaks the shutter records
  (`sparks` multiple, `sparkRadiance` 30, `sparkSize` 0.3 m for the flame and halation round each grain).
- Hits on ships. `targets` lists ships the shots can strike (each a `ship` matrix or `Floater`, `length`, `beam`,
  `height`, `draft`, side `thickness` 0.5 m and `wood`, white oak by default: 680 kg/m^3 and 7.4 MPa across the
  grain, Wood Handbook 2010). At a side the ball meets Poncelet's resistance A (R + rho v^2 / 2) (`woodPenetration`,
  `woodExitSpeed`): a ball that cannot sink a radius in glances off and flies on (a ricochet, which may still reach
  the water); one whose reach is more than the side holes it and goes on at the exit speed, and out of the far side
  the same way; any other lodges. `hits()` lists the strikes whose time has come; each throws `splinters`
  (hand-sized pieces of the hole's timber) and draws its hole into the target's `mask`.
- The hull mask. `hullMaskImage()` makes a blank RGBA8 image for a materials `Texture`; `HullFire` paints its char
  (red) and the glow of the fire over it now (green) into it, and the battery its holes (blue). `hullMaskUVs(positions,
  hull)` gives a hull mesh the UV set that reads it: starboard on the left half, port on the right, stern to bow, keel
  to deck. Use red as the mask of a dark char layer of `layered()`, green for an ember glow and blue for the holes.
- Char. Timber under fire chars at `charRate` (0.5 mm/min for oak, 0.65 for softwood: EN 1995-1-2 table 3.1) for as
  long as the fire over it has burnt. `exposure(z)` is that time in closed form and `charDepth(point)` the depth in
  mm: the deck chars where its stretch burns and 1.5 m down the side, and each flaming port the side above it to its
  flame height. A face reads black past about half a millimetre.
- Rigging. `masts` (a foot on the deck, a `height`, `yards` and the side it `falls` to) stand until the fire has
  reached them and burnt their stays (`mastFall`, 600 s, or `fallAt`), then topple on their feet as falling chimneys
  (`mastTopple`; Varieschi and Kamiya 2003) until their tops are in the water. `rigging()` gives each mast and yard
  as a world matrix for the scene's mast and yard meshes, riding the ship.
- `HullFire` burns a wooden hull (`ship`, a `Floater` or a fixed matrix; `hull` 50 by 13 m, deck 6 m). The fire spreads
  from `ignition` along the hull at `spread` (0.03 m/s), each stretch burning at `deckHeat` (250 kW/m^2) for `burnTime`
  (2,400 s) and then dying down. Each open gun port (`ports`) burns as a room vents through a window: 0.09 A sqrt(H)
  kg/s of wood (Kawagoe 1958), with a flame out of it Law's (1978) height above the opening. Deck flames stand at
  Heskestad's length for their heat. `flames` (10) `Flame` volumes take the hottest; `columns` (2) `Smoke` columns
  carry 0.7 of the heat as smoke darkened by `soot` (0.35, wood and tar). `heat` is the fire's power in watts and
  `flames()` lists every flame.
- Both have `advanceTime(delta)`: their state is a function of film time, so a cutscene `seek` (with them in `extra`)
  lands where playing lands. `time` is their clock.
- Sliders: `GUNFIRE_SETTINGS` and `HULL_FIRE_SETTINGS` in `@margoengine/vfx/settings` hold every look row on the
  shared shape (flash size, radiance and light, shutter, smoke extinction, colour, dispersion and life, air stability,
  heat share, entrainment, sparks, spark radiance and size, grain size, splinters; spread, burn time, deck heat,
  soot, opacity, char rate and mast fall). The `wind.x` and `wind.z` rows are null by
  default and follow the weather. `GUNFIRE_LOOKS` names `trafalgar`, `breezy` and `animatedFeature`, and
  `HULL_FIRE_LOOKS` `tarred`, `smouldering` and `animatedFeature`; `applyGunfireSettings(battery, values)` and
  `applyHullFireSettings(fire, values)` write a set.
- `test/gunfire.test.js` holds the laws: the products, the flash energy at 24, 30, 60 and 120 frames a second, the puff
  closed forms, the level-off scaling, the dispersion, a shot in vacuum, the vent laws and the hull's heat;
  `test/gunfire-hits.test.js` the lag-time rule, the grains' burn-out and drag, Poncelet's law and the three outcomes
  of a strike, the holes, the Eurocode char rate and a falling mast's energy and fall time. The GPU check
  (`test/gunfire-check.mjs`, WebGPU and MARGO_COMPAT=1) draws the flash on its frame only, the bank where the law puts
  it, flames and dark smoke over a hull, sparks past the flash, splinters at a strike, a charred hull side that matches
  its CPU twin, the same bytes twice, and 60 frames of live rows with no new GPU object.
- Limits: a strike reads the target ships where they are at the shot; masts fall from fire, not from shot; the
  rigging is rigid pieces (no ropes or sails); sinking is a Blender bake (`docs/limits.md`). Sources are in
  `docs/clean-room.md`.

## Preview tier contract

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.
