# @margoengine/scatter

Import `margoengine/scatter` from the `margoengine` package, or `@margoengine/scatter` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

`randomPlacements(count, bounds, [minScale,maxScale], seed)` generates seeded
rectangle candidates. `radialPlacements(centers, perCenter, [minDistance,maxDistance],
[minScale,maxScale], seed)` generates candidates around world XZ anchors. Both
produce `[x,z,scale,yaw]` tuples at initialization. Submit them to a shared
`PlacementLayout` to filter overlaps and reserve accepted footprints.

`instanceTransforms()` packs `[x,y,z,scale,yaw]` placements into affine matrices.
`groundTransforms(placements, height, offsetY)` accepts `[x,z,scale,yaw]`, samples
world height, and applies a vertical offset (negative values sink roots).
`placementBounds(placements,radius)` produces enclosing world XZ rectangles.
`clearPlacements(candidates,radius,exclusions,gap)` accepts rectangle exclusions
`[minX,minZ,maxX,maxZ]` and circle exclusions `[x,z,radius]`; the optional gap
defaults to 0. These initialization helpers preserve their inputs and validate
height samples, scales and exclusion data.

WebGPU seeded, stratified placement with density, world-height and slope rules. Compute culling packs instances into three distance LOD rings, followed by indexed indirect draws.

The rings keep candidate order: each frame they hold the same instances in the same order on every GPU, so a still
view draws the same pixels frame after frame, 4x MSAA edges included (an Apple M6 drew other edge pixels every frame
when the rings were filled with atomics). The cost is a slower cull pass and about 58 bytes of GPU memory per
candidate; [docs/limits.md](../../docs/limits.md) ("Scatter cull in candidate order") has the measured numbers.
`node packages/scatter/test/repeat.browser.mjs` checks repeated frames bit for bit.

```ts
import {Scatter} from 'margoengine/scatter';
import {sphereGeometry, toGeometry} from 'margoengine/geometry';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const nearGeometry = toGeometry(sphereGeometry(0.5, 16, 8)), midGeometry = toGeometry(sphereGeometry(0.5, 8, 4));
const farGeometry = toGeometry(sphereGeometry(0.5, 4, 2));
const scatter = Scatter.attach(engine, [nearGeometry, midGeometry, farGeometry], {
  count: 10000, area: [50,50], density: 0.8, maxSlope: 45, lod: [25,60,120], lodFade: 2
});
```

A single Geometry can be supplied for all rings; the package does not auto-decimate meshes. heightmap returns a sampleable red-channel height texture covering area around center, one height per texel centre (as `TerrainHeightmap` writes it). Each instance takes the bilinear interpolation of the four texel centres around it, and the ground normal (for `maxSlope`) is that patch's gradient, so roots follow slopes between texels. Heights are world units plus center Y; absent heightmap is flat. Rules are fixed at construction and distribution is evaluated on GPU each frame. Output uses random Y rotation and scale with a simple diffuse material. Three storage buffers reserve count instances each, so account for GPU memory; device limits are checked. No core geometry/material feature additions are needed.

The default LOD distances are `[25,60,120]` world units. `lodFade` defaults to a
2-unit overlap centered on each of the first two distances. Compute emits both
adjacent meshes inside that band; complementary 4x4 Bayer masks cross-fade them
in both diffuse and PBR rendering, without alpha blending or per-frame history.
The width is clamped to prevent overlapping bands. Identical adjacent Geometry
objects skip the extra draw instances. Set `lodFade: 0` for hard switches.
The third distance remains the culling boundary. `edgeShrink` (world units,
default 0) scales instances down to zero over that last stretch instead of
cutting them at it, so the far edge of a grass field recedes without popping;
it needs no fade mask or `discard`, so it also suits the phone tier.

`inner` (world units, default 0: off) leaves a hole round the camera, so another
layer can take over nearby, such as stored objects in front of far stand-ins.
`innerFade` (world units, default 0: a sharp circle) is a band past `inner` where
instances appear one by one, each at its own hashed distance. Both are measured in
3D like the LOD distances, and `inner` must be below the last one. Instances beyond
`inner + innerFade` are the very same ones as without the option, and without it the
distribute shader stays the same text.

```ts
import { Scatter } from '@margoengine/scatter';
import { planeGeometry, toGeometry } from '@margoengine/geometry';
import {Engine} from '@margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);

const standIn = toGeometry(planeGeometry(4, 8));
const farTrees = Scatter.attach(engine, standIn, {
  count: 100_000,
  area: [5000, 5000],
  follow: true,
  lod: [1000, 2000, 2500],
  inner: 1000,
  innerFade: 256,
});
```

With `lodFade: 0`, or one Geometry for every ring, no instance can fade, so the
shaders are compiled without the fade's `discard`; lit scatter also compiles out
core's back-face `discard` (single-sided materials cull back faces in the
rasterizer instead). A shader without `discard` keeps early depth rejection on
tile-based phone GPUs, so hidden grass blades are not shaded. The phone tier of
`@margoengine/quality` sets `lodFade: 0` when the app leaves it unset.

`alignToGround` (0-1, default 0) tilts each instance's up axis from world +Y
toward the ground normal: 1 lays stones and debris along the slope, while grass
and trees usually stay upright. `sink` (world units, default 0) lowers each
instance by `sink * scale * (1 + tan(slope))`, so stone bases and roots stay
buried on the downhill side of steep ground. Both read the same bilinear patch
of the heightmap as placement. Each instance keeps 32 bytes: position and scale,
then yaw, the ground normal's X and Z packed into one float, and the LOD fade.

`blades: { rootShade, widen }` shades instances as grass blades: upright meshes
whose local origin is the root and whose tallest vertex is the tip. Albedo darkens
linearly toward the root (`rootShade`, default 0.5, is the fraction lost there).
The shading normal blends from the ground normal at the root to the blade's own
normal at the tip, after the back-face flip so both sides agree, and fully to the
ground normal by the last LOD distance: a distant field shades like the terrain
under it instead of speckling, after Wohllaib's Ghost of Tsushima grass (GDC 2021).
Blades also widen with distance, by `widen` (default 1, twice as wide) at the last
LOD distance, so thin far blades stay about a pixel wide instead of shimmering.
Lit and unlit scatter both support it; without `blades` the lit shader keeps
core's shading normal untouched. Cost: one distance per vertex, one extra varying,
and one mix and normalize per fragment.

LOD meshes must use matching origins, scale and shading. For procedural rocks,
pass `true` as the third argument to `icosahedronGeometry(radius, detail, true)`
from `@margoengine/geometry`, including at detail 0, and keep the same radius in
every ring. Scatter preserves authored normals and does not rescale assets.

Supply `material: new PbrMaterial(...)` to shade the GPU-distributed instances
with the engine's PBR shader and receive any attached PCSS shadows. This preserves
the same GPU placement/culling and three indirect LOD draws. Material values are
uploaded through a retained uniform each frame. Opaque scatter draws before sky
and water, so water refraction and depth occlusion include grass and rocks.

`shadows.add(scatter)` (`@margoengine/shadows`) makes GPU `Scatter` and
`ScatterTiles` cast: `drawShadow` draws each LOD ring's instances into every
cascade, depth only, with the colour pass's pose, ground fit and wind. A lit
scatter (`material`) also receives. The instances drawn are the ones culled
against the camera that frame, so an instance outside the view casts no shadow
onto ground inside it (a tall tree just behind the camera, say), as with the
unshadowed translucency below. Before the cascades draw, `prepareShadow` (which
`Shadows` calls once per frame) culls those instances per cascade in one compute
pass: an instance whose posed bounds (the meshes' reach, doubled for wind and
widened for blades, times its scale) lie wholly outside a cascade's light box
would clip away there, so that cascade's indirect draw leaves it out and the
shadow map is unchanged, bit for bit. Instances past the shadow `distance` are
drawn in no cascade, and near cascades draw a small share. The zero-config biome
world (1440 x 900, RTX A6000, camera 25 m up) went from 72.9 to 43 to 44 ms per
frame with four cascades and from 50.1 to 39 to 40 ms with two; it draws in 27 ms
without shadows and 28 to 29 ms with only the terrain casting. Most of what is
left is the last cascade, whose light box holds most trees in view.
Cascades still draw each instance they reach with its ring's full mesh (no
coarser mesh per cascade, which would change the shadow), so light distant rings
still help. The lists cost 4 bytes per ring slot per cascade.

```ts
import { Engine, PbrMaterial, box } from '@margoengine/core';
import { Scatter } from '@margoengine/scatter';
import { Shadows } from '@margoengine/shadows';
const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const shadows = Shadows.attach(engine);
const rocks = Scatter.attach(engine, box(1, 1, 1), {
  count: 2000,
  area: [60, 60],
  material: new PbrMaterial({ color: '#8a8580', roughness: 0.9 }),
});
const remove = shadows.add(rocks); // casts, and receives through its material
engine.start();
```

One mesh in one colour reads as a forest of copies. Two options of a lit scatter
(`material`) break that up, and both default to off, which draws exactly as
before. `variation: { hue, value }` tints each instance from a hash of its world
position, so the tint stays put across frames, culling and LOD rings: its hue
turns around the grey axis by up to `hue` of the colour wheel either way (0-0.5,
default 0) and its brightness changes by up to `value` either way (0-1, default
0). `clusters` (mesh units, default 0: off) cuts the mesh into cubic cells of that
size: each vertex is lightened or darkened by up to `variation.value` from a hash
of its cell and its instance, and its normal bends away from the cell's centre,
so a smooth canopy shades as clumps of leaves. Both run in the vertex stage (a
few operations each, through spare slots of the material uniform, no new
binding); the shadow pass is unchanged. Without `material` they throw a
RangeError. Both work on `ScatterTiles` too.

```ts
import { Engine, PbrMaterial, box } from '@margoengine/core';
import { Scatter } from '@margoengine/scatter';
const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const canopy = box(2, 2, 2);
const trees = Scatter.attach(engine, canopy, {
  count: 500,
  area: [80, 80],
  material: new PbrMaterial({ color: '#3f7a2a', roughness: 0.9 }),
  variation: { hue: 0.06, value: 0.15 }, // each tree its own green
  clusters: 0.6, // leaf clumps about 0.6 units across
});
engine.start();
```

Thin triangles whose shading changes across them (blade root shade, vertex
colour, occlusion, the blade ground weight, the `clusters` colour) interpolate those values at a
covered sample (`centroid`): with multisampling, a pixel a blade only partly
covers is otherwise shaded at its centre, outside the blade, where the values
extrapolate past their range and drew negative light at grass edges.

Both `ScatterOptions` and `ScatterBatch` accept `wind: [directionX, directionZ,
strength]`, where direction is nonzero and strength is 0-1. Omit it for static
geometry. Rooted GPU bends vary by world position and time, and normals follow
the deformation. Grass LODs use identical motion; fixed instance shadows use the
same bend and clock in every cascade. Use `shadows.add(instances)` for moving
vegetation, without the static-shadow option. Cull bounds include wind movement.
Use upright vegetation whose local origin is its ground root. This is a lightweight
whole-plant bend. Fixed `ScatterBatch` can additionally set `windDetail: 1` (0-1)
for faster branch/foliage ripple. Radial stiffness anchors the trunk and plant
center, while two detail frequencies vary across each plant. Normals use the
deformation's analytic inverse Jacobian, and all shadow cascades share the same
deformation. Omit detail for the original sway. This approximation has no branch
skeletons, individual leaf simulation or collision deformation.

For fixed placement with the engine's PBR lighting and PCSS shadows, use the
separate `ScatterInstances` export:

```ts
import {ScatterInstances, type ScatterBatch} from 'margoengine/scatter';
import {Shadows} from 'margoengine/shadows';
import {Engine, PbrMaterial} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
// One batch: a triangle of three 20-float vertices, drawn once at the origin.
const generateBatches = (): ScatterBatch[] => [{
  name: 'pebbles',
  vertices: new Float32Array(60),
  indices: new Uint32Array([0, 1, 2]),
  transforms: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  material: new PbrMaterial(),
}];
const shadows = Shadows.attach(engine);
const instances = ScatterInstances.attach(engine, () => generateBatches());
shadows.add(instances, {static: true});
```

Each `ScatterBatch` supplies an 80-byte `vertices` stream, Uint32 `indices`,
column-major affine `transforms` (16 floats per instance), a `PbrMaterial`, and
a diagnostic `name`. Vertex RGB at byte offset 64 multiplies the instance albedo;
vertex alpha at byte offset 76 controls ambient occlusion, independently of direct
light, emission and opacity. `pbrVertexStream(data, occlusion)` from geometry packs
this layout. Old manually packed RGB occlusion must move to alpha to retain the
intended ambient-only effect. The factory runs at initialization and device restoration.
Geometry and transforms are uploaded and not retained on the JavaScript heap;
the factory must regenerate them instead of closing over large arrays. Each
material batch uses one indexed indirect draw, including in every shadow cascade.
The internal instance stream is 128 bytes, including HDR emission and wind data.
This fixed path renders all instances; use the existing GPU LOD path for large
distance-culled populations. The gameplay sandbox demonstrates both paths.

For collision-free ground decoration, use one shared occupancy layout before
packing transforms:

```ts
import {PlacementLayout, Scatter} from 'margoengine/scatter';
import {boxGeometry, footprintRadius, toGeometry} from 'margoengine/geometry';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const rockMesh = boxGeometry(1.2, 0.8, 1.2), fernMesh = boxGeometry(0.6, 0.5, 0.6), bushMesh = boxGeometry(0.9, 0.9, 0.9);
const islandRockGeometry = toGeometry(boxGeometry(0.3, 0.2, 0.3));
// x, z, scale, yaw.
const rockCandidates: [number, number, number, number][] = [[8, 0, 1, 0], [12, 3, 1.5, 1]];
const fernCandidates: [number, number, number, number][] = [[8.2, 0, 1, 0], [-9, 4, 1, 2]];
const bushCandidates: [number, number, number, number][] = [[-12, -6, 1, 0]];
const buildingFootprints: [number, number, number, number][] = [[-5, -5, 5, 5]]; // min x, min z, max x, max z
const layout = new PlacementLayout(buildingFootprints);
const rocks = layout.place(rockCandidates, footprintRadius(rockMesh));
const ferns = layout.place(fernCandidates, footprintRadius(fernMesh));
const bushes = layout.place(bushCandidates, footprintRadius(bushMesh));
Scatter.attach(engine, islandRockGeometry, {exclusions: layout.exclusions});
```

Building footprints are world-space `[minX, minZ, maxX, maxZ]` rectangles.
Submit each asset family to the same layout. Every accepted scaled footprint
automatically reserves space, so subsequent placements cannot overlap buildings,
previous assets or each other. A 30 cm gap applies by default; rejected candidates
are omitted. The layout snapshots building bounds, preserves candidate order and
does not mutate inputs. It is initialization-only CPU work for small populations.
Scenes supply geometry/coordinates and register existing buildings in the layout.

GPU `Scatter` accepts the layout's `exclusions` or an explicit rectangle array.
It rejects whole scaled bounding spheres intersecting a rectangle before emitting
any LOD. The largest LOD's bounds include geometry offsets from its origin.
Exclusions are validated and uploaded once per device, with no frame-time CPU
collision arrays. Rules remain fixed at construction. Footprints are conservative
XZ bounds; increase their clearance to reserve paths or porches.

For a single population, `spacePlacements` also filters ground placements:

```ts
import {spacePlacements} from 'margoengine/scatter';
const candidates: [number, number, number, number][] = [[0, 0, 1, 0], [0.4, 0, 1, 0], [3, 1, 1, 0]]; // x, z, scale, yaw
const meshFootprintRadius = 0.5;
const placements = spacePlacements(candidates, meshFootprintRadius, 0.3);
```

Candidates are `[x, z, uniformScale, yaw]` tuples. Supply the mesh's maximum XZ
radius about the instance origin. Each pair retains at least the requested gap
between its scaled footprints (30 cm by default). The deterministic filter keeps
candidate order and references, and leaves the input unchanged. Terrain height
and the supplied obstacle bounds belong to the scene. `clearPlacements` filters
against explicit rectangles or `[x, z, radius]` circles; `placementBounds` encloses
scaled footprints for GPU exclusion. `groundTransforms` samples a heightfield
once and packs flat transforms with an optional root-sinking Y offset.
This quadratic CPU filter is for small initialization sets; use GPU `Scatter`
for large distributed populations.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/scatter

`ScatterBatch.translucency` (0-1, default 0) lets sunlight through thin foliage,
after Barre-Brisebois and Bouchard's wrapped back-light translucency (GDC 2011):
a lobe around the direction away from the sun, bent by the normal so curved
canopies light unevenly, plus wrapped diffuse on the side facing away from it.
It scales with the vertex occlusion (alpha), so outer leaves glow and a canopy's
core does not, and with the albedo and sun colour; 1 matches the front-lit
diffuse. It is not shadowed, because a canopy's own shadow map would hide its
back-lit side, so a tree in a hill's shadow keeps a faint glow. It rides in the
unused fourth float of the instance emission; without any translucent batch the
shader and vertex layout are unchanged. Cost when on: about 15 ALU per fragment
of that ScatterInstances draw.

Fixed `ScatterInstances` batches accept `emissive: [r, g, b]` in linear HDR.
Emission defaults to zero and is added after PBR lighting, shadows and baked
occlusion; for example `[3, 2.16, 0.9]` makes a warm window bloom with optional
`@margoengine/post`. Emission uploads with the batch and survives device restoration.
`instances.emissiveIntensity` multiplies every batch's emission without replacing
geometry or transforms. It defaults to 1 and accepts a nonnegative finite number
or a callback sampled each render, such as `() => sky.nightFactor` for night lights.
The value must fit a GPU float; the callback remains installed after restoration.

## Density maps, a grid that follows the camera, and stored tiles

Three options turn a `Scatter` into world-anchored ground cover: `bounds` (the world rectangle `[minX, minZ, maxX,
maxZ]` the `heightmap` and `densityMap` cover, instead of `area` around `center`), `densityMap` (a red-channel 0..1
texture over `bounds` that multiplies `density` per instance, such as a biome detail map) and `follow` (the grid moves
with the camera in whole cells and every instance takes its random numbers from its world cell, so grass stays put as
the camera moves). Without them the distribute shader is the same text as before, byte for byte
(`scatterCullShader(options)` returns it, and the package test pins it; WebGPU runs it as the candidate kernel of the
ordered cull, also pinned).

```ts
import { Scatter } from '@margoengine/scatter';
import { planeGeometry, toGeometry } from '@margoengine/geometry';
import {Engine} from '@margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);

const blade = toGeometry(planeGeometry(0.05, 0.4, 1, 3));
const texture = (format: GPUTextureFormat) =>
  engine.gpu!.createTexture({size: [1024, 1024], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
const heights = texture('r32float');
const grassDensity = texture('r8unorm');
const grass = Scatter.attach(engine, blade, {
  count: 200_000,
  area: [240, 240], // around the camera
  follow: true,
  bounds: [-2048, -2048, 2048, 2048],
  heightmap: () => heights,
  densityMap: () => grassDensity, // r8unorm over bounds
  blades: {},
});
```

`@margoengine/scatter/paint` makes that map from a brush or a splat map. It uploads only the rectangle that changed:

```ts
import {Engine, box} from 'margoengine/core';
import {Scatter} from 'margoengine/scatter';
import {DensityBrush} from 'margoengine/scatter/paint';
const engine = await Engine.create(document.querySelector('canvas')!);
const bounds = [-50, -50, 50, 50] as const;
const brush = new DensityBrush({bounds, resolution: 512});
brush.paint(0, 0, {radius: 10, strength: 1, hardness: 0.5});   // strength below 0 erases
brush.fromSplat(new Uint8Array(4 * 4 * 4), 4, 4, [0, 1, 0, 0]); // or: the green layer of a splat map
Scatter.attach(engine, box(0.1, 0.5, 0.1), {bounds, densityMap: () => brush.texture(engine.gpu!)});
engine.start();
```

`@margoengine/scatter/tiles` draws stored instances per tile: `ScatterTiles` takes 8-byte records (u16 x and z inside the
tile, palette index, log scale, yaw, variant and age, as `@margoengine/biomes/placement` writes them) and expands them on
the GPU every frame with scatter's own culling, LOD rings, fades, wind and shading. Add tiles as they stream in and
remove them as they leave. GPU memory follows what is held: records live in pages of 64 taken from a free list (a tile
wastes less than one page, adding or removing a tile moves nothing else and streaming never repacks; the pool grows
with headroom only when every page is taken), and each LOD ring holds as many instances as the held tiles within its
distance can give, recounted every frame from the camera, so a ring never drops an instance and a sparse species
costs little. A
second mesh of the same objects (a tree's canopy over its trunk) passes `share` and draws the first one's records,
culling and rings.

```ts
import { ScatterTiles } from '@margoengine/scatter/tiles';
import { cylinderGeometry, sphereGeometry, toGeometry } from '@margoengine/geometry';
import {Engine} from '@margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);

const levels = (make: (sides: number) => ReturnType<typeof sphereGeometry>) => {
  const [a, b, c] = [16, 8, 4].map((sides) => toGeometry(make(sides)));
  return [a, b, c] as const;
};
const [near, middle, far] = levels((sides) => cylinderGeometry(0.3, 0.4, 4, sides));
const [crownNear, crownMiddle, crownFar] = levels((sides) => sphereGeometry(2, sides, sides / 2));
const texture = (format: GPUTextureFormat) =>
  engine.gpu!.createTexture({size: [1024, 1024], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
const heights = texture('r32float');
const records = new Uint8Array(8 * 100); // 100 trees of 8 bytes
const oaks = ScatterTiles.attach(engine, [near, middle, far], {
  bounds: [-2048, -2048, 2048, 2048],
  heightmap: () => heights,
  slots: 100,
  species: 0, // the palette index this mesh draws (default: all)
});
const crowns = ScatterTiles.attach(engine, [crownNear, crownMiddle, crownFar], {
  bounds: [-2048, -2048, 2048, 2048],
  heightmap: () => heights,
  slots: 100,
  share: oaks, // the same objects: no second copy of the records or the rings
});
oaks.setTile('3,4', [-1280, -1024], 256, records);
oaks.removeTile('3,4');
```

| `ScatterTiles` option | Default | Meaning |
| --- | --- | --- |
| `bounds` | required | world rectangle the heightmap covers |
| `slots` | 64 | tiles held at once |
| `slotSize` | 4,096 | records one tile may hold (a limit only: memory follows the held records) |
| `drawn` | 1,000,000 | most instances one LOD ring may draw per frame (rings are sized from the held tiles up to it) |
| `share` | none | another `ScatterTiles` whose records, culling and rings this mesh draws |
| `scale` | 1 | multiplier on every record's scale |
| `species` | all | the record palette index this mesh draws |

Memory: 8 bytes per record slot (pages of 64) on the CPU and the GPU, 32 bytes per instance a ring can draw, plus half
again as headroom, and about 58 bytes per record slot on the GPU for the ordered cull (the culled instance, ring flags
and slots); `tiles.gpuBytes` reports it from the first frame (0 for a mesh that shares another's). A ring at its
capacity keeps the first instances in record order. The GPU's `maxStorageBufferBindingSize` holds 32 bytes per record
slot: 4,194,304 slots at the WebGPU default of 128 MiB.

## Picking instances: `@margoengine/scatter/pick`

`InstancePicker` hit tests single scattered instances for selection and harvesting. It works on the transforms you
already hold (`instanceTransforms`, `groundTransforms`, a `ScatterBatch`'s `transforms`), on the CPU, so it needs no
GPU and no readback. A ray finds the nearest instance; a sphere finds every instance it reaches; `remove` takes an
instance out of later picks, and `kept()` gives the transforms left to draw again.

```ts
import { InstancePicker, boundsOf } from 'margoengine/scatter/pick';
import { instanceTransforms } from 'margoengine/scatter';

// 400 bushes on a 20 x 20 grid, each a box 1 m wide and 1.5 m tall around its root.
const places: [number, number, number, number, number][] = [];
for (let z = 0; z < 20; z++) for (let x = 0; x < 20; x++) places.push([x * 3, 0, z * 3, 1, (x + z) * 0.7]);
const transforms = instanceTransforms(places);
const picker = new InstancePicker(transforms, { bounds: { min: [-0.5, 0, -0.5], max: [0.5, 1.5, 0.5] } });

// A ray from the camera (for example `Raycaster.setFromEngine` in margoengine/bvh gives origin and direction).
const hit = picker.pick([-5, 4, -5], [1, -0.4, 1]);
if (hit) {
  console.log(hit.index, hit.distance.toFixed(2), hit.point);
  picker.remove(hit.index); // harvested: later picks go through to the bush behind
}
console.log(picker.near([30, 0, 30], 4)); // every bush within 4 m of the player, nearest first
const { transforms: left, indices } = picker.kept(); // draw `left` again; indices[k] is its old number
console.log(left.length / 16, indices.length, boundsOf(new Float32Array([0, 0, 0, 1, 2, 3])));
```

| Option | Default | Meaning |
| --- | --- | --- |
| `bounds` | the box of `mesh` | the drawn mesh's local box, `{min, max}` |
| `mesh` | none | `{positions, stride?, indices}`: also test the triangles, so a ray through the gaps of a tree misses it; `stride` 20 reads a `ScatterBatch`'s `vertices` |
| `cell` | from the spread and size | side of a grid cell in world units |

- `pick(origin, direction, maxDistance?)` returns `{index, distance, point}` or `null`; `pickAll` lists every hit,
  nearest first. Both faces of a triangle count, as for a blade or a leaf card.
- `near(center, radius)` returns the instance numbers whose world box comes within `radius`, nearest box first.
- `remove(index)`, `restore(index)`, `removed(index)` and `active` track harvesting; `setTransform(index, matrix)`
  moves one instance. The grid is rebuilt on the next pick after any of these, in time linear in the instance count,
  so many changes in a frame cost one rebuild.
- How it works: the instances' world boxes go into a uniform XZ grid, which a ray walks front to back cell by cell
  (Amanatides and Woo 1987), stopping once the nearest hit lies inside the cells walked. Each instance is tested in its
  own local space: the ray against the box by slabs (Kay and Kajiya 1986), then against the triangles (Moller and
  Trumbore 1997) when a mesh is given. A test checks 3,000 rays against testing every instance one by one.
- Limits: CPU only, on transforms you pass. The GPU `Scatter` and `ScatterTiles` make their instances on the GPU from
  the seed and tiles, so they are not picked here; pick the records you stored for tiles by passing their
  transforms. An instance scaled to 0 is never hit. The picker keeps a copy of the transforms (64 bytes an instance)
  plus 125 bytes of world box, inverse and flags an instance, and 4 bytes a grid entry.

Real WebGPU LOD, diffuse/PBR fade-mask and device-restoration checks:
`npm run test:browser --workspace @margoengine/scatter` (build geometry/core first).

