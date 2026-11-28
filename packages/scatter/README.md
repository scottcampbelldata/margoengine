# @margoengine/scatter

Seeded instancing, distance-based LOD and procedural wind.

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
`[minX,minZ,maxX,maxZ]`, circle exclusions `[x,z,radius]` and ground paths
`{points: [[x, z], ...], width}` (a road, track or river bed: a footprint must stay more than `width / 2` from every
segment of the centreline, the point to segment distance of Ericson, "Real-Time Collision Detection", 2005, 5.1.2);
the optional gap defaults to 0. These initialization helpers preserve their inputs and validate
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

The default LOD distances are `[25,60,120]` world units. All three distances must fit positive normal f32 values
(at least 2^-126 after conversion) and remain strictly increasing after GPU upload; values that collapse to zero
or equal boundaries are rejected with RangeError, including in ScatterTiles. `lodFade` defaults to a
2-unit overlap centered on each of the first two distances. Compute emits both
adjacent meshes inside that band; complementary 4x4 Bayer masks cross-fade them
in both diffuse and PBR rendering, without alpha blending or per-frame history.
The width is clamped to prevent overlapping bands. Identical adjacent Geometry
objects skip the extra draw instances. Set `lodFade: 0` for hard switches.
The third distance remains the culling boundary. `edgeShrink` (world units,
default 0) scales instances down to zero over that last stretch instead of
cutting them at it, so the far edge of a grass field recedes without popping;
it needs no fade mask or `discard`, so it also suits the phone tier.

### Screen-space rings: `lodSize` and `lodPixels`

Distance rings ignore the camera: through a long lens or on a 4K frame a mesh's
finest feature (a leaf spray, a needle band) can still be many pixels wide at the
ring's end, and through a wide lens or a small viewport it can fall under a
pixel and alias long before the next mesh takes over. `lodSize` gives the width
of the near and middle mesh's finest feature at scale 1, in world units; each of
the first two rings then ends at its `lod` distance or where that feature, times
the instance's scale, would project under `lodPixels` viewport pixels (default
1), whichever comes first. The ends follow the camera's field of view and
viewport height each frame, and move only when the pixel footprint drifts more
than 5 percent (hysteresis), set from the footprint plus that 5 percent so a
feature never draws under `lodPixels`. The third distance stays the culling
boundary. Without `lodSize` the shader is the distance-only one, unchanged.
It is off unless asked for: on the Timber Valley blowup shot (biomes, `lodPixels: 1`) it raised speckle from 19.8 to
25.1 ppm early and 47.4 to 48.4 ppm mid (2026-11-28), so a default that worsens real frames stays off.
This is the projected-size criterion of Luebke, Reddy, Cohen, Varshney, Watson
and Huebner, *Level of Detail for 3D Graphics* (2003), ch. 4.

```ts
import {Scatter} from 'margoengine/scatter';
import {sphereGeometry, toGeometry} from 'margoengine/geometry';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const rings = [16, 8, 4].map((n) => toGeometry(sphereGeometry(0.5, n, n / 2)));
// Near spheres hand over once a 0.1 m facet is under 2 px, middle ones once a 0.2 m facet is.
const trees = Scatter.attach(engine, rings, {
  count: 10000, area: [400, 400], lod: [60, 150, 400], lodFade: 0, lodSize: [0.1, 0.2], lodPixels: 2,
});
```

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

`edgeThin` (world units, default 0: off) is a band before the last LOD distance
where instances drop out one by one, each at its own hashed distance, so the count
falls linearly to none at the last distance while every survivor keeps its size and
place (the thinning of Cook, Halstead, Planck and Ryu, "Stochastic Simplification
of Aggregate Detail", SIGGRAPH 2007). A dense near layer laid over a sparser field
with it set hands over as a smooth fall in density, with no line where it ends;
`@margoengine/biomes` draws its near meadow grass this way. Instances nearer than
the band are the very same ones as without it, and it must be at most the last
distance.

```ts
import { GrassScatter } from '@margoengine/scatter/grass';
import {Engine} from '@margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);

// A sparse field to 120 m and a dense layer to 40 m that thins out over its outer 32 m.
const field = GrassScatter.attach(engine, { count: 500_000, area: [240, 240], follow: true, lod: [36, 72, 120] });
const near = GrassScatter.attach(engine, {
  count: 500_000,
  area: [80, 80],
  follow: true,
  lod: [12, 24, 40],
  edgeThin: 32,
  seed: 2,
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

`blades: { rootShade, widen, translucency }` shades instances as grass blades: upright meshes
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
`translucency` (0-1, default 0) lets the sun through the blades, with the same wrapped back-light translucency
as `ScatterBatch.translucency` (Barre-Brisebois and Bouchard, GDC 2011): blades glow against a low sun instead of
reading as flat card; 0 leaves the lit shader as it was.

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
cascade, depth only, with the colour pass's pose, ground fit and wind, its position `@invariant` (WGSL 12.10) as every Margo shadow caster's is, so another program drawing the same surface writes the same depth bit for bit (the per-cascade list draw and the full draw among them). A lit
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

### Feet and canopy shade: `base` and `skyOcclusion`

Two more options of a lit scatter make objects sit in the ground, both off by default (the shader as before) and fixed
at construction; metres are at instance scale 1.

- `base: { height, shade, tint, amount }`: the lowest `height` metres above the ground lose up to `shade` (default
  0.5) of the sky's light and turn toward the linear RGB `tint` by up to `amount` (default 0.7 with a tint), such as
  moss on stones or soil on trunks. The band's upper edge is ragged (value noise).
- `skyOcclusion: { depth, height }`: `exp(-depth * (1 - h / height))` of the sky's light is kept `h` metres above the
  ground, as under a canopy (Beer-Lambert light in a canopy: Monsi and Saeki 1953; English translation 2005, Annals of
  Botany 95:549, https://doi.org/10.1093/aob/mci052). The sun's beam is untouched.
- `skyOcclusion.crown: { depth, radius, top }`: the sky light a crown keeps from its own leaves. The crown is a cone
  about the up axis, `radius` wide at the ground and a tenth of that from 0.9 of `top` up; a point `d` of the way from
  the axis to it keeps `exp(-depth * (1 - d))`, so inner needles are darker than outer tips (ambient light falls with
  depth inside a tree: Reeves and Blau, SIGGRAPH 1985, https://doi.org/10.1145/325165.325250).

The ground line follows `sink` and the ground's slope, so a sunk stone's band starts where it leaves the soil. Both
reach every ambient term: core's flat one, a hemisphere light's and a Sky's.

```ts
import { Engine, PbrMaterial, box } from '@margoengine/core';
import { Scatter } from '@margoengine/scatter';
const engine = await Engine.create(document.querySelector('canvas')!);
Scatter.attach(engine, box(1, 3, 1), {
  count: 200,
  area: [60, 60],
  material: new PbrMaterial({ color: '#7a7268', roughness: 0.9 }),
  sink: 0.4,
  base: { height: 0.25, shade: 0.5, tint: [0.07, 0.1, 0.03] }, // moss and contact shade at the foot
  skyOcclusion: { depth: 0.9, height: 1.5, crown: { depth: 1.2, radius: 0.6, top: 3 } },
});
engine.start();
```

Checked on WebGPU and the WebGL2 layer by `test/contact.browser.mjs`.

### Ground cover that opens around objects: `@margoengine/scatter/clearing-map`

`clearings` are circles fixed at construction. `thinning: clearingMap(map)` reads a world map every frame instead, such
as the ground contact around trunks and stones that stream in: where its red channel is high, instances drop out and the
survivors stand shorter. The map is read at the instance's root and four places `reach` metres away.

```ts
import { Engine, PbrMaterial } from '@margoengine/core';
import { clearingMap } from '@margoengine/scatter/clearing-map';
import { GrassScatter } from '@margoengine/scatter/grass';
const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const texture = engine.gpu!.createTexture({
  size: [64, 64],
  format: 'r8unorm',
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
});
const thinning = clearingMap(() => ({ texture, bounds: [-32, -32, 32, 32] }), { thin: 1.4 });
GrassScatter.attach(engine, { area: [40, 40], material: new PbrMaterial({ color: '#6a7a3a' }), thinning });
thinning.set({ shorten: 0.5 }); // live
engine.start();
```

| Option | Default | Meaning |
| --- | --- | --- |
| `thin` | 1.4 | Chance of dropping an instance per unit of map value (stops at 1), 0 to 8 |
| `shorten` | 0.6 | Share of its height an instance loses per unit of map value, 0 to 1 |
| `reach` | 0.25 | Metres around the root also read, 0 to 10 |

With a `TerrainGroundContact`: `clearingMap(() => contact.mask())`. `ScatterTiles` does not take `thinning`. Checked on
WebGPU and the WebGL2 layer by `test/clearing-map.browser.mjs`.

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
A `Scatter` built without `wind` can be given one later (`scatter.options.wind = [x, z, strength]`, which `WeatherDrive` does from the
weather's wind): the cull reach doubles for it from the next frame, as for a wind passed at construction, and returns when it is unset.

A fourth number, the mean wind speed in m/s at 10 m, makes plants thrash with the Beaufort force: `wind: [x, z, strength,
speed]`. Up to 5.4 m/s (the top of Beaufort 3, gentle breeze) the plants keep their own sway; past it the sway and leaf
flutter run `speed / 5.4` times as fast (`windClockRate(speed)`: 2 in a force 6 strong breeze, 3.2 in a force 8 gale,
6.1 at hurricane force), because the gusts a canopy feels come at a frequency in proportion to the mean speed. A plant
follows those gusts only as fast as its own sway lets it (below), so grass thrashes with them while a tree keeps its own
slow sway. The strength still sets how far they bend. `scatter.windTime` is the clock the shaders read (it equals `time` with no speed
or a light one); `WeatherDrive` of `@margoengine/weather/drive` writes the speed with the strength, so a storm's grass
and trees thrash by themselves:

```ts
import { Engine, box, PbrMaterial } from '@margoengine/core';
import { Scatter, windClockRate } from '@margoengine/scatter';

const engine = await Engine.create(document.querySelector('canvas')!);
// A force 8 gale (17.2 m/s) from the west: full bend, sway 3.2 times as fast as in a breeze.
const grass = Scatter.attach(engine, box(0.05, 0.6, 0.05), { count: 20000, area: [30, 30], material: new PbrMaterial({ color: [0.2, 0.4, 0.1] }), wind: [1, 0, 1, 17.2] });
console.log(windClockRate(17.2), grass.wind);
engine.start();
```

How far a plant sways depends on its own height H (its mesh top times the instance's scale): its top moves at most
strength x `swayTip(H)` = H^2 / (1 + H + H^2 / reach), never more than 0.354 H, with reach = 1.2 m / `sway.stiffness`.
A 0.3 m blade bends 0.066 m as before; a 5 m sapling's top moves up to 0.93 m and a 25 m conifer's up to 1.14 m (it moved
24 m before KB-LOOK-TV-SHIMMER1). The stem bows as a tapered beam (0.74 x^2 + 0.26 x^4 of the tip offset at a fraction
x of its height) and sinks a little so it keeps its length. Each plant is a damped oscillator at its own frequency
`swayFrequency(H)` = 2.55 H^-0.59 Hz (0.38 Hz for 25 m, 5.2 Hz for a 0.3 m blade): gusts faster than that pass to it
weakly and the rest of its sway runs at its own frequency on the real clock, so a 25 m tree's top moves at most about
2.3 m/s in a 20 m/s gale. `sway: { stiffness, height }` (stiffness 0.1 to 10, default 1; height in mesh units, default
the meshes' top) sets it on `ScatterOptions` and `ScatterBatch`; `scatter.sway` is live and the `wind.stiffness`
settings row writes it. A `ScatterTiles` mesh that shares another (a canopy over its trunk) sways with the larger top.

```ts
import { Engine, box } from '@margoengine/core';
import { Scatter, swayFrequency, swayTip } from '@margoengine/scatter';

const engine = await Engine.create(document.querySelector('canvas')!);
// 25 m conifers (a 1 m box scaled 25 times would do the same): the tops sway about a metre at 0.38 Hz in a gale.
const forest = Scatter.attach(engine, box(1, 50, 1), { count: 400, area: [200, 200], wind: [1, 0, 1, 20] });
forest.sway = { stiffness: 1.5 }; // stiffer trunks: the reach is 0.8 m
console.log(swayTip(25, 1.5), swayFrequency(25), forest.sway);
engine.start();
```

`ScatterBatch` winds (`ScatterInstances`) take the three-number form; their batches share one clock.
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
The internal instance stream is 144 bytes, including HDR emission, wind and sway data.
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

GPU `Scatter` accepts the layout's `exclusions` or an explicit rectangle array, and `paths`, ground paths kept
clear (up to 1,000,000 segments in all; `roadPath` from `@margoengine/road` gives a road's):

```ts
import {Engine} from 'margoengine/core';
import {icosahedronGeometry, toGeometry} from 'margoengine/geometry';
import {roadPath} from 'margoengine/road';
import {Scatter} from 'margoengine/scatter';
import {Spline} from 'margoengine/splines';

const engine = await Engine.create(document.querySelector('canvas')!);
const curve = new Spline([[-60, 0, -40], [0, 0, 10], [60, 0, 40]]);
// Rocks everywhere in a 160 m square except on the road and half a metre either side of it.
Scatter.attach(engine, toGeometry(icosahedronGeometry(0.4, 1, true)), {
  count: 4000,
  area: [160, 160],
  paths: [roadPath(curve, {width: 6})],
});
```

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

## Clumps, clearings and plants of several parts

Plants of one kind grow in drifts, and grass thins around a boulder. Three `Scatter` options, fixed for the scatter's
life:

- `clumps: { size, cover, edge }` gathers the instances into patches: two octaves of smoothed value noise of the world
  position (`size` its wavelength in world units) are cut at `cover` (0 keeps nothing, 0.5 about half the ground, 1
  everything) with a soft rim `edge` wide (default 0.2), and each instance is kept with the chance its place lies in a
  patch, so patches have ragged, thinning edges. The noise follows `seed`.
- `clearings: [{ center: [x, z], radius, falloff }]` (up to 100,000): no instance roots within `radius`, and over the
  next `falloff` the chance of keeping one rises smoothly (a smoothstep) to 1; `inside: true` keeps them inside instead,
  thinning to none over the falloff (moss gathered at a boulder's base).
- `reach` (mesh units, default the meshes' bounds) is the cull reach of an instance; it must hold the meshes' farthest vertex from the root. Draw a plant of several
  materials (leaves, stem, flowers) as one `Scatter` per part with the same `seed`, placement options, `reach` and
  `sway.height`, and every part keeps the same instances and bends alike.

```js
import { PbrMaterial, box } from '@margoengine/core';
import { Scatter, type ScatterOptions } from '@margoengine/scatter';
const shared = {
  count: 4000,
  area: [30, 30],
  seed: 7,
  reach: 0.5,
  sway: { height: 0.3 },
  clumps: { size: 4, cover: 0.35 },
  clearings: [{ center: [2, -1], radius: 0.8, falloff: 1.2 }],
} satisfies ScatterOptions;
const leaves = new Scatter(box(0.3, 0.05, 0.3), { ...shared, material: new PbrMaterial({ color: '#4b5a2c' }) });
const flowers = new Scatter(box(0.05, 0.3, 0.05), { ...shared, material: new PbrMaterial({ color: '#f0a020' }) });
leaves.dispose();
flowers.dispose();
```

## Texture maps: scanned plants, bark and rocks

`textures` draws a mesh with its glTF 2.0 metallic-roughness maps instead of one material colour: `uvs` (two per
vertex, one array per LOD ring geometry or one for all), `baseColor` (sRGB, its alpha an alpha MASK cut-out),
`normal` (tangent space, OpenGL green-up; no tangents needed, the frame comes from screen derivatives) and
`occlusionRoughnessMetal` (R occlusion of the ambient light, G roughness, B metalness). The `material` colour,
roughness and metalness multiply the maps as glTF factors. `alphaCutoff` (default 0.5 with a base colour map, else 0)
drops texels in the colour pass and in the shadow casters, so needle and leaf cards cast their own shapes. Images are
`{width, height, data}` RGBA8 texels or anything a 2D canvas draws (ImageBitmap, canvas, image). Mip levels are built on
the CPU, and the base colour's alpha is rescaled per level so the cut-out keeps its coverage with distance. Works on
`Scatter`, `ScatterTiles` and the biome forests (`BiomeMeshPart.textures` of `@margoengine/biomes/objects`).

```ts
import {Engine, Geometry, PbrMaterial} from 'margoengine';
import {Scatter} from 'margoengine/scatter';
const engine = await Engine.create(document.querySelector('canvas')!);
// One upright leaf card: its left half cut out by the map's alpha.
const card = new Geometry([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2, 0, 2, 3]);
const leaf = {width: 2, height: 1, data: new Uint8Array([60, 140, 50, 0, 60, 140, 50, 255])};
const ferns = Scatter.attach(engine, card, {
  count: 2000,
  material: new PbrMaterial({color: [1, 1, 1], roughness: 0.8}),
  textures: {uvs: [0, 1, 1, 1, 1, 0, 0, 0], baseColor: leaf},
});
```

Cost: 8 more bytes a vertex, three texture reads a pixel and, with a cut-out, a fragment stage in the shadow pass. On the
WebGL2 compatibility layer a textured plain `Scatter` draws through the layer's generic tiers (as `ScatterTiles` always
does), not scatter's own compatibility route. Sources: Khronos glTF 2.0 (2021) section 3.9; Schueler, "Normal Mapping
Without Precomputed Tangents" (ShaderX5, 2006; note 2013); Mikkelsen, "Bump Mapping Unparametrized Surfaces on the GPU"
(JGT 2010); Castano, "Computing Alpha Mipmaps" (2010); Wyman and McGuire, "Hashed Alpha Testing" (JCGT 6(2), 2017).

## Whole glTF plants: `@margoengine/scatter/textured`

`TexturedScatter.attach(engine, model, placements)` copies a whole loaded glTF plant: every primitive of every node,
with its textures, normal maps, material extensions and alpha MASK cut-outs, drawn by the glTF PBR renderer itself.
Use it for a scanned or modelled plant you do not want to rebuild as scatter rings.

```ts
import {Engine, box, PbrMaterial} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf/pbr';
import {Shadows} from 'margoengine/shadows';
import {TexturedScatter} from 'margoengine/scatter/textured';
const engine = await Engine.create(document.querySelector('canvas')!, {camera: {position: [0, 3, 7], target: [0, 0.3, 0]}});
engine.createMesh().setGeometry(box(12, 0.01, 8)).setMaterial(new PbrMaterial({color: '#6b5a40', roughness: 1}));
const shadows = Shadows.attach(engine);
const plant = await loadGLTF(engine, '/DiffuseTransmissionPlant.glb');

// 50 plants in rows, each turned and scaled a little: column-major affine matrices relative to plant.root.
const placements = new Float32Array(50 * 16);
for (let i = 0; i < 50; i++) {
  const turn = i * 2.4, size = 0.8 + (i % 5) * 0.1, c = Math.cos(turn) * size, s = Math.sin(turn) * size;
  placements.set([c, 0, -s, 0, 0, size, 0, 0, s, 0, c, 0, (i % 10) - 4.5, 0, Math.floor(i / 10) - 2, 1], i * 16);
}
const scatter = TexturedScatter.attach(engine, plant, placements);
shadows.add(scatter.model); // cut-out leaves cast their own shapes

scatter.setMatrixAt(0, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -5, 0, 3, 1]); // move one plant
console.log(scatter.count, scatter.getMatrixAt(0)[12]); // 50 -5
```

- A placement moves the whole plant about its root, so a plant made of several nodes keeps their authored offsets
  under every placement. A primitive that already holds glTF instances (`EXT_mesh_gpu_instancing`) is drawn once per
  placement for each of them, keeping each one's own colour and extra rows.
- The node poses are read once, at `attach`: a node animated or moved later is not followed. Move whole plants with
  `setMatrixAt(index, matrix)`; `getMatrixAt(index)` returns a copy of one placement.
- MASK materials use alpha to coverage on multisampled targets; single-sample colour targets and shadow maps use the
  authored `alphaCutoff`. Textures, normal maps and extensions are the model's own, unchanged. The PBR renderer owns
  every draw and rebuilds after a device restore.
- Shadows: pass `scatter.model` to the shadows plugin, as for any glTF model.
- Limits: at most 1,000,000 placements, and a node's placements times its glTF instances at most 1,000,000. A
  placement that is not a finite, invertible affine matrix throws a `RangeError` (all are checked before the model
  changes). A model loaded into another engine throws a `TypeError`; a disposed model or one another
  `TexturedScatter` holds throws a `MargoError` with code `'failed'`.
- `dispose()` puts the model's original instances and material render states back and frees the copies; the model,
  its meshes and textures stay yours. Disposing the engine disposes the attachment. After `dispose()`,
  `setMatrixAt` throws a `MargoError` with code `'disposed'`.

## Placing on any mesh: `@margoengine/scatter/surface`

`scatterSurface(data, count, options)` places `count` instances on any triangle mesh (`GeometryData`: a cliff, a
ceiling, a planet) and turns each one's +Y to the surface normal there. It needs no engine: it returns arrays you pass
to a `ScatterBatch`, a `TexturedScatter` (on a model whose root is at the origin) or your own instancing.

```ts
import {sphereGeometry} from 'margoengine/geometry';
import {scatterSurface} from 'margoengine/scatter/surface';
const planet = sphereGeometry(10, 64, 32);
// Paint density: none on the southern half, rising to the north pole.
const weights = Array.from({length: planet.positions.length / 3}, (_, i) => Math.max(0, planet.positions[i * 3 + 1] / 10));
const rocks = scatterSurface(planet, 2000, {weights, seed: 7, scale: [0.5, 1.5], offset: -0.05});
console.log(rocks.transforms.length / 16, rocks.positions.every((v, i) => i % 3 !== 1 || v >= -1e-4)); // 2000 true
const up = rocks.normals.slice(0, 3), at = rocks.positions.slice(0, 3);
console.log(Math.abs(up[0] * 10 - at[0]) < 0.05, Math.abs(up[1] * 10 - at[1]) < 0.05); // true true: +Y points out of the planet
```

- Density: even over the surface area, measured after `matrix`, or with `weights` (one value of 0 or more a vertex)
  proportional to area times the weight interpolated across each triangle, so painted vertices are exact densities.
  `colors` (3 or 4 values a vertex) are interpolated into the returned colours. `seed` (default 1, a whole number up to
  4294967295) makes the same mesh give the same placements.
- Each placement: root on the surface, then moved `offset` (default 0) along the normal; +Y turned toward the normal by
  `align` of the shortest rotation (default 1, fully; 0 keeps world up); a turn about that axis picked from `yaw`
  (default 0 to 2 pi radians); a uniform scale picked from `scale` (default [1, 1]).
- `matrix`: a column-major affine matrix from the mesh to the world (default identity). Normals take its inverse
  transpose, and a mirroring matrix still gives outward normals.
- Returned, all yours: `transforms` (16 floats a placement, column-major world matrices), `positions` (the roots before
  `offset`), `normals` (unit world normals), `uvs` (the mesh's interpolated UVs) and `colors` (RGBA, white without
  `colors`).
- Limits: `count` 0 to 1,000,000; a bad count, seed, range, matrix or mesh throws a `RangeError`. `signal` cancels it,
  before or during the work, with the signal's reason. The mesh is read once: after you change it, call again.

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

Ring budgeting includes the last LOD distance, matching GPU acceptance at that endpoint. It uses the same f32 tile
origin, side and camera position as the GPU, with conservative allowance for placement and distance arithmetic.
Near a boundary it can reserve extra space; the GPU still selects rings and fades. The explicit `drawn` limit can
truncate a ring, keeping the first instances in record order.

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

## Skipping plants hidden behind hills and buildings: `@margoengine/scatter/occlusion`

`OccludedScatter` is a `Scatter` that also drops, each frame, the instances the camera cannot see because terrain or
a building is in front of them. It takes every `Scatter` option. `addOccluder(source)` names what hides: an opaque
terrain, building, glTF model or core mesh in the scene.

```ts
import {Engine, box, PbrMaterial} from 'margoengine/core';
import {sphereGeometry, toGeometry} from 'margoengine/geometry';
import {OccludedScatter} from 'margoengine/scatter/occlusion';
const engine = await Engine.create(document.querySelector('canvas')!, {camera: {position: [0, 2, 30], target: [0, 1, 0]}});
const wall = engine.createMesh().setGeometry(box(40, 12, 1)).setMaterial(new PbrMaterial({color: '#8a8070'}));
wall.setPosition([0, 6, 10]);
const bush = toGeometry(sphereGeometry(0.5, 12, 6));
const bushes = OccludedScatter.attach(engine, bush, {count: 20000, area: [80, 80]});
bushes.addOccluder(wall); // bushes behind the wall are not drawn; their shadows still are
// bushes.enabled = false turns the test off at any time; removeOccluder(wall) forgets the wall.
```

- How: after the usual culling, the occluders' depth is drawn into a depth pyramid for this frame
  (`@margoengine/culling/depth`) and each instance's bounding sphere (the mesh's radius times its scale, padded a
  little for rounding) is tested against it. An instance any occluder fully hides is left out of the colour pass. It
  uses this frame's depth only: there is no history, so nothing pops in a frame late when the camera turns.
- Shadows are not occlusion-culled: an instance hidden from the camera keeps its shadow-casting rings, so a bush
  behind the wall still shades the ground beyond it. Only the colour pass gets the smaller list.
- Occluders must be opaque and drawn: a source that is transparent, cut out or hidden would hide plants that should
  show. Only what you add hides plants; the scatter's own instances never do.
- `enabled` (default true) can change on any frame; off, the colour pass gets every instance the usual culling keeps.
- Memory: a second instance buffer the size of the scatter's own for the colour pass, 76 bytes of command and
  uniform buffers, and the depth pyramid. All of it is freed by `dispose()` and made again after a device restore.

## Per-instance colours and values: `@margoengine/scatter/attributes`

`AttributedScatter` is a `ScatterInstances` whose instances each carry a linear RGB tint and your own named values,
which a WGSL function you supply turns into position and colour changes. Use it for a field of flowers that bloom one
by one, crops that ripen, or plants a game marks.

```ts
import {AttributedScatter, type AttributeBatch} from 'margoengine/scatter/attributes';
import {boxGeometry, computeTangents, pbrVertexStream} from 'margoengine/geometry';
import {Engine, PbrMaterial} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!, {camera: {position: [0, 4, 12], target: [0, 0, 0]}});
const stem = computeTangents(boxGeometry(0.05, 0.6, 0.05)); // the PBR vertex stream needs tangents
const count = 400, transforms = new Float32Array(count * 16), bloom = new Float32Array(count);
for (let i = 0; i < count; i++) {
  transforms.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (i % 20) - 9.5, 0.3, Math.floor(i / 20) - 9.5, 1], i * 16);
  bloom[i] = (i % 7) / 6;
}
const batches = (): AttributeBatch[] => [{
  name: 'flowers',
  vertices: pbrVertexStream(stem),
  indices: new Uint32Array(stem.indices),
  transforms,
  material: new PbrMaterial({color: [0.3, 0.6, 0.2]}),
  attributes: {bloom},
}];
const flowers = AttributedScatter.attach(engine, batches, {
  attributes: {bloom: 1},
  // A blooming flower grows half again as tall and turns from green to yellow.
  shader: `fn scatterAppearance(position:vec3f,color:vec3f,data:ScatterAttributeData)->ScatterAppearance{
    let b=data.custom[0].x;
    return ScatterAppearance(position+vec3f(0,0.3*b,0),mix(color,vec3f(1,0.85,0.2),b));
  }`,
});
flowers.setAttributeAt(0, 'bloom', [1]).setColorAt(1, [1, 0.2, 0.2]);
console.log(flowers.getAttributeAt(0, 'bloom')[0], flowers.attributeIndex('bloom'), [...flowers.getColorAt(1)]); // 1 0 [1, 0.2, 0.2]
```

- Batches are `ScatterBatch`es (as for `ScatterInstances`) plus optional `colors` (linear RGB, three floats an
  instance, default white) and `attributes`, one tightly packed `Float32Array` per declared name. The factory runs at
  attach and after a device restore.
- `attributes` (in the options) declares each name and its size, 1 to 4 floats; their order is the index in
  `data.custom`, which `attributeIndex(name)` returns. The layout is fixed for the life of the scatter.
- `shader` is WGSL defining `fn scatterAppearance(position:vec3f, color:vec3f, data:ScatterAttributeData) ->
  ScatterAppearance`. `position` is the vertex's world position before wind, `color` the material colour times the
  instance tint; `data.color` is the tint (a `vec4f`) and `data.custom` an array of `vec4f`, one per attribute, unused
  components 0. It returns `ScatterAppearance(position, color)`. The colour pass and the shadow pass both run it, so a
  flower that grows casts the taller shadow. The default returns its inputs.
- `setColorAt(index, rgb, batch = 0)` and `setAttributeAt(index, name, value, batch = 0)` write one instance's 16 bytes
  to the GPU at once, nothing rebuilt; `getColorAt` and `getAttributeAt` return copies. An index or batch outside what
  was uploaded throws a `RangeError`, as do an undeclared name, the wrong number of components, a value that is not a
  finite f32, or a negative colour. After `dispose()` they throw a `MargoError` with code `'disposed'`.
- Memory: 16 bytes an instance, plus 16 for each attribute, on the GPU and again on the CPU. The CPU copy keeps the
  values you set: a device restore uploads them again rather than the batches' first values. A batch whose values
  pass the device's buffer limit throws a `RangeError` at attach; split it.

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
  nearest first. Both faces of a triangle count, as for a blade or a leaf card. A ray through a corner, an edge or a
  box of zero size hits: hit or miss is decided on the box grown by 8 machine epsilons of its farthest corner from the
  ray origin (as math's `Ray.intersectBox`), and the distance is the exact entry.
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

## Reading instances back: `@margoengine/scatter/read`

`readScatter(engine, scatter, { signal? })` reads the instances a GPU `Scatter` culled in its last frame back to the
CPU, one list per LOD ring (near, middle, far), as column-major 4 x 4 world transforms: position, scale, yaw and the
ground tilt of `alignToGround`, the same placement the vertex stage applies. It also gives the scatter's colour,
roughness and metalness. `@margoengine/voxel-pathtracer/from-engine` takes the result as a `scatter` source, so a
path-traced frame holds the field the camera sees; `InstancePicker` takes a ring's `transforms` as they are.

```ts
import { Engine, box } from '@margoengine/core';
import { Scatter } from '@margoengine/scatter';
import { readScatter } from '@margoengine/scatter/read';

const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: { position: [0, 6, 10], target: [0, 0, 0] },
});
const stones = Scatter.attach(engine, box(0.4, 0.3, 0.5), { count: 200, area: [12, 12], scale: [0.5, 1.5], seed: 3 });
engine.render();
const { rings } = await readScatter(engine, stones, { signal: AbortSignal.timeout(10_000) });
console.log(rings.map((r) => r.transforms.length / 16)); // instances the camera saw, by ring
stones.dispose();
engine.dispose();
```

- What is read: the frame cull's output, the instances within the camera's view and the last LOD distance that pass
  the height, slope, density, exclusion and path rules, before any occlusion pass. An instance cross-fading between two
  rings is kept once, in the nearer ring. Render a frame first; until then, after `dispose` or on a WebGL engine it
  throws MargoError `'state'`.
- The transforms are rigid. The readback is one copy of the three ring buffers (32 bytes an instance slot) and one
  map.
- `pose: true` also poses every vertex on the GPU: each ring gets `posed`, its instances as one world-space mesh
  (`positions`, unit `normals`, `indices`, one copy of the ring mesh an instance in the order of `transforms`), posed
  by the vertex stage's own `scatterPose` with every patch the scatter applies (the wind's bend, grass blades, plant
  states, plant motion, trampling). Grass blades come at their true width: the raster-only widening with distance and
  the pixel floor are left out, since a path tracer resolves thin blades with its own samples. `previousPositions`
  are the same vertices under the wind of the last frame drawn on an earlier wind clock (equal to `positions` on the
  first frame and after `resetTime`), so a shutter blurs the sway; plant states, trampling and the eye stay at the
  last frame's. The cost is one compute pass and a read of 36 bytes a vertex, in chunks a storage binding holds.

```ts
import { Engine, box } from '@margoengine/core';
import { Scatter } from '@margoengine/scatter';
import { readScatter } from '@margoengine/scatter/read';

const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: { position: [0, 5, 9], target: [0, 0.8, 0] },
});
const reeds = Scatter.attach(engine, box(0.1, 2, 0.1), { count: 300, area: [10, 10], wind: [1, 0.2, 0.8] });
engine.render({ delta: 1 / 30 });
engine.render({ delta: 1 / 30 });
const { rings } = await readScatter(engine, reeds, { pose: true, signal: AbortSignal.timeout(10_000) });
const posed = rings[0].posed;
console.log(posed && posed.positions.length / 3, posed && posed.indices.length / 3); // vertices, triangles
reeds.dispose();
engine.dispose();
```

- `instanceMatrix(floats, offset, alignToGround, out, at?)` turns one instance record (8 floats) into its transform.
- Evidence: `test/read.test.js` (the matrix against the vertex stage's placement written out again, errors) and
  `packages/voxel-pathtracer/tests/from-engine-browser.mjs` (40 instances aligned to sloped ground drawn and traced:
  silhouette IoU 0.9996; a field split by the fade band, 55 draws, read as 40 instances; a windy field of 30 boxes
  read with `pose: true`: IoU 1.000 against the drawn bent field where the rigid read scores 0.541, the shutter-open
  pose equal bit for bit to the frame before's pose, grass blades and a trampled scatter posed through their own
  patches; WebGPU and the WebGL2 layer).

## Interaction and trampling: `@margoengine/scatter/interact`

`TrampledScatter` is a `Scatter` whose grass bends away from players, animals and vehicles and springs back. A square
push field follows the camera; pass the interactors each frame and every instance in it turns about its root away
from them, in the colour and the shadow passes alike.

```ts
import { Engine, box } from '@margoengine/core';
import { TrampledScatter, type Interactor } from '@margoengine/scatter/interact';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, { backend: 'webgpu' });
const grass = TrampledScatter.attach(
  engine,
  box(0.06, 1, 0.02),
  { count: 40000, area: [40, 40], lod: [30, 60, 90], blades: {} },
  { size: 32, resolution: 64, recover: 1.5, bend: 1.2 },
);
const player = { position: [0, 0, 0] as [number, number, number], radius: 0.8 };
const blasts: Interactor[] = [];
// The app's explosion event supplies a world centre and radius. This demo uses a click.
canvas.addEventListener('click', () => blasts.push({ position: [4, 0, -2], radius: 4, strength: 1 }));
engine.onFrame(() => {
  player.position[0] += 0.02; // the app moves its player
  grass.setInteractors([player, { position: [4, 0, -2], radius: 2.5, strength: 0.7 }, ...blasts]);
  blasts.length = 0; // explosions stamp once; the field then recovers on its own
});
engine.start();
```

| Option | Default | Meaning |
| --- | --- | --- |
| `size` | 64 | side of the square field around the camera, world units; grass outside it is not pushed |
| `resolution` | 128 | cells along a side, 8 to 1,024 |
| `recover` | 1.5 | seconds for a push to fall to 5% once nothing presses it |
| `bend` | 1.2 | turn of fully pressed grass about its root, radians, at most pi / 2 |

- An interactor is `{ position, radius, strength? }`: within a sphere of `radius` around the world `position` the
  push points away from it with amount `strength * (1 - (d / radius)^2)`, and a cell keeps the stronger of its own
  push and the new one, so grass under a standing player stays down. Distance `d` includes the centre's height above
  the bilinearly sampled heightmap plus `center[1]` (or that flat height without a map). An airborne explosion whose
  sphere misses the ground adds no push. Direction is horizontal, away from the sphere centre. Up to 4,096 interactors a frame.
- Positions must have all three finite GPU float components. Radius, bend, size and cells per unit must fit positive
  normal GPU floats (at least 2^-126); strength is a number from 0 to 1. A rejected list preserves the last successful
  list. A camera teleport with no field overlap clears the old pushes, including shifts beyond signed 32-bit cells.
- Distance uses a scaled norm, so finite large offsets and radii do not lose their push through squared-length overflow.
- How it works: one compute pass a frame, before the distribute pass, moves the field with the camera in whole cells,
  scales every cell by `exp(-3 dt / recover)` and stamps the interactors; a cell below 0.001 is upright again, so a
  recovered meadow draws exactly as a plain `Scatter`. The vertex stages read the push at each root (bilinear between
  cell centres) and turn the instance about its root (Rodrigues), so a vertex keeps its distance from the root and the
  cull radii still hold.
- Cost: 8 bytes a cell (128 KB at the default 128 cells) twice, one thread a cell that loops over the interactors, and
  five storage reads a vertex.
- Explosions are one-frame interactors: include the blast on its event frame, then omit it. Existing pushes decay over
  `recover`; a later airborne blast does not clear a previous ground push. Players and wheels stay in the list while pressing.
- Limits: the field stores horizontal pushes on the heightfield and moves with the camera, so grass more than
  `size / 2` from it is not pushed and a push is lost once its cell leaves the field. The
  push field is not shared between scatters: give each its own interactors.
- Real-GPU proof: `npm run test:browser:interact --workspace @margoengine/scatter` (build the packages first).

## Burnt and flooded plants: `@margoengine/scatter/states`

Plants a fire or a flood leaves standing. A `PlantStates` map over a world rectangle records, per cell, the worst fire
and the highest water there; every Scatter given `states: map.plant({...})` treats its own meshes from the cell under
each instance's root, in the colour and the shadow passes: foliage below the crown scorch height turns red-brown, stems
below the flame length char black, a crown fire strips the crown to bare charred branches, ash settles on upward
faces, mud coats everything below the high-water mark with a stain line above it, a fast flow lays the plant flat
downstream and debris catches on its upstream side. No new meshes: these are vertex and colour treatments. The map
fills itself each frame from a `FireFront` burn texture, a `Flood` wetting record and current, and a `GroundChange`'s
plant covers, and keeps each cell's peak, so plants stay burnt or flattened after the front or the wave has gone.

```ts
import { Engine, PbrMaterial, box } from '@margoengine/core';
import { Scatter } from '@margoengine/scatter';
import { PlantStates, fireSource, PLANT_STATE_LOOKS, applyPlantStateSettings } from '@margoengine/scatter/states';
import { FireFront } from '@margoengine/vfx/fire-front';
const engine = await Engine.create(document.querySelector('canvas')!);
const fire = FireFront.attach(engine, { origin: [-50, -50], size: [100, 100], cell: 2, fuel: 'FM4', ignitions: [{ at: [0, 0] }] });
const states = PlantStates.attach(engine, { bounds: [-50, -50, 50, 50], resolution: 128, fire: fireSource(fire) });
const pines = states.plant({ crownBase: 4, trunkRadius: 0.15, stiffness: 2e5 });
Scatter.attach(engine, box(0.3, 6, 0.3), { count: 900, area: [100, 100], material: new PbrMaterial({ color: [0.1, 0.3, 0.1] }), states: pines });
// A flood: states.setSources({ flood: floodSource(flood) }); changed ground: { ground: change.plantCovers() }.
states.paint([-50, -50, 0, 50], [0.45, 0.38, 0.15], 0.5); // a drought tint over the west half
applyPlantStateSettings(states, pines, PLANT_STATE_LOOKS.conifer); // the slider rows
engine.start();
```

| Map option | Default | Meaning |
| --- | --- | --- |
| `bounds` | (required) | world rectangle `[minX, minZ, maxX, maxZ]`; instances rooted outside it are untouched |
| `resolution` | 256 | cells along x and z, 1 to 1,024 (one number or `[x, z]`); 64 bytes a cell |
| `fire` | none | `{ texture, bounds }`, `fireSource(fireFront)` |
| `flood` | none | `{ wet, velocity?, bounds }`, `floodSource(flood)` |
| `ground` | none | `{ covers, bounds }`, `groundChange.plantCovers()` |
| `ambient` | 25 | air temperature at the fire, deg C, -60 to 59 |
| `wind` | 2 | midflame wind at the fire, m/s |
| `manning` | 0.035 | Manning's n of the flooded ground |
| `dryTime` | 3,600 | seconds for flood wetness to fall to 1/e |
| `groundScorch`, `groundChar`, `groundMud` | 4, 1, 0.4 | metres a full GroundChange char or mud cell gives |

| Plant response (`plant()`) | Default | Meaning |
| --- | --- | --- |
| `crownBase` | 0 | crown base height, m; 0 burns the whole plant (grass, low shrubs) |
| `foliarMoisture` | 100 | percent; wetter needles need a hotter fire to crown |
| `trunkRadius` | 0.1 | mesh units; nearer the axis is stem (charred, never stripped) |
| `stiffness` | 0.05 | stem rigidity MEI, N m^2 (grass 0.01 to 0.1, shrubs about 5, trees 1e4 and up) |
| `flatten` | 1.4 | turn of a fully flattened plant, radians |
| `bareShrink` | 0.85 | share of its reach a consumed crown loses |
| `wetDarkening`, `stainBand`, `edge` | 0.55, 0.06, 0.12 | wet albedo, stain line height m, soft edge of the lines m |
| `scorch`, `char`, `ash`, `mud`, `debris` | linear RGB | colours of each treatment |

- The physics, per cell: scorch height `4.665 I^(7/6) / ((60 - T) sqrt(I + 38.7 U^3))` m (Van Wagner 1973, I kW/m, T deg C,
  U m/s), char height Byram's flame length `0.0775 I^0.46` m, crown consumed past twice `(0.010 CBH (460 + 25.9 FMC))^1.5`
  kW/m (Van Wagner 1977), flattened past twice Kouwen and Li's critical shear velocity `min(0.028 + 6.33 MEI^2,
  0.23 MEI^0.106)` with `u* = n V sqrt(g) / h^(1/6)` (Chow 1959), debris from the hazard rating `d (v + 0.5)` between
  0.75 and 2 (Ramsbottom et al. 2006). The same formulas are exported for the CPU: `scorchHeight`, `flameLength`,
  `crownInitiation`, `flatteningShear`, `shearVelocity`.
- One map serves every Scatter, `ScatterTiles`, `GrassScatter` and `TrampledScatter` in the area; each gets its own
  response, and `BiomeObjects` and `BiomeView` take `states: (key, kind) => response` for every part of a biome.
- Colour treatments need `material`; the shape treatments (stripped crowns, flattening) work on any Scatter. A turn
  and a radial pull keep every vertex within its distance from the root, so the cull radii hold.
- Sliders: `PLANT_STATE_SETTINGS` (shared row shape, all live), `PLANT_STATE_LOOKS` (`conifer`, `chaparral`, `grass`,
  `hotGale`), `applyPlantStateSettings(states, plant, values)`.
- Cost: one compute thread a cell a frame while a source is set, five storage reads a vertex and a few more in the
  lit stage. On the WebGL2 compatibility layer the compose pass runs as a GPU draw (never on the layer's CPU tier;
  `states.test.js` plans it) and the treatments are part of the scatter's own vertex stages.
- Limits: one cell per instance (the treatment is uniform along a plant within a cell), nearest source texel; the
  peaks live on the GPU, so a device restore starts the map empty (sources and marks compose again). A source that
  updates later in the frame than the scatters (a `Flood` ticks after them) is read as the frame before left it: the
  plants are one frame behind the water.
- Marks of past fires and floods, with no live source: `states.mark(rect, { scorch, char, intensity, ash, water,
  debris, wetness })` for the cells whose centres lie in a world rectangle, or `states.markEach((x, z) => marks)` for
  every cell from a function (a burn history, a flood line). Like a source, a mark raises a cell's fire and water and
  never lowers them; the map composes them once when they change and again after a reset or a device restore, and
  `reset()` forgets them. `disturbanceStates` of `@margoengine/biomes/disturbance` marks a map from a fire and flood
  history, and `BiomeView` does it by itself from its `disturbance` option:

```ts
import { Engine, box, PbrMaterial } from '@margoengine/core';
import { Scatter } from '@margoengine/scatter';
import { PlantStates, scorchHeight, flameLength } from '@margoengine/scatter/states';

const engine = await Engine.create(document.querySelector('canvas')!);
const states = PlantStates.attach(engine, { bounds: [-50, -50, 50, 50], resolution: 100 });
// Last summer's burn scar on the east half: a 2,000 kW/m fire, ash still on the ground.
states.mark([0, -50, 50, 50], { scorch: scorchHeight(2000), char: flameLength(2000), intensity: 2, ash: 1 });
// A flood line 0.6 m up along the creek at z < -30.
states.markEach((x, z) => (z < -30 ? { water: 0.6 } : undefined));
Scatter.attach(engine, box(0.3, 6, 0.3), { count: 900, area: [100, 100], material: new PbrMaterial({ color: [0.1, 0.3, 0.1] }), states: states.plant({ crownBase: 3, trunkRadius: 0.15 }) });
engine.start();
```

- Real-GPU proof: `npm run test:browser:states --workspace @margoengine/scatter` (both backends): stand-in source
  textures (`states.browser.mjs`) and a real dam-break `Flood` of `@margoengine/water` driving the map
  (`states-flood.browser.mjs`: the high-water mark is the flood's own record bit for bit, the peak shear and the
  flow direction downstream); test page `examples/test-pages/plant-states.html`.

## Imposter ring: `@margoengine/scatter/imposter`

`ImposterScatter` is a `Scatter` whose far LOD ring draws as octahedral imposters instead of its mesh. Bake the far
mesh once with `Imposter.bake` from `@margoengine/lod` (an optional peer: install it with this entry) and pass it as
`imposter`; the near and middle rings, the distribute pass and the shadow passes are the plain `Scatter`'s.

```ts
import { Engine, PbrMaterial, box } from '@margoengine/core';
import { Imposter } from '@margoengine/lod';
import { ImposterScatter } from '@margoengine/scatter/imposter';
const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const material = new PbrMaterial({ color: [0.35, 0.6, 0.25], roughness: 0.8 });
const tree = box(0.8, 1.6, 0.8), far = box(0.8, 1.6, 0.8);
const imposter = Imposter.bake(engine, far, { material, frames: 12, frameSize: 64 }); // once, at load
const forest = ImposterScatter.attach(engine, [tree, tree, far], {
  count: 20000, area: [400, 400], lod: [40, 120, 600], material, imposter,
});
engine.start();
```

- How it works: after the colour pass, one indirect draw puts a camera-facing quad on every far-ring instance, shaded
  by lod's own imposter shader (the three nearest baked views reprojected and blended, relit, with per-pixel depth),
  reading the scatter instance (root, scale, yaw and ground tilt) in place of a matrix. The instance count is the far
  ring's draw count, copied on the GPU, so nothing is read back. The middle-to-far fade band keeps its complementary
  Bayer masks.
- Bake the same mesh the far ring uses, in its own local space, so the imposter has the same bounds: the cull radius
  comes from the ring meshes.
- Limits: imposters ignore `wind`, `blades`, `variation` and `clusters` (they are baked still and untinted), and the
  far ring still casts shadows with its mesh. A disposed imposter, or one with no device yet, draws the far mesh again.
- Real-GPU proof: `npm run test:browser:imposter --workspace @margoengine/scatter` (build the packages first).

## Automatic LOD rings: `@margoengine/scatter/simplify`

`scatterLODs(mesh, { ratios })` turns one near mesh into the three ring meshes `Scatter` takes. Ring 0 is the mesh
itself; rings 1 and 2 keep `ratios` of its triangles (default 0.4 and 0.12) by quadric-error edge collapses, the
second simplified from the first. It loads `@margoengine/lod/auto` and `@margoengine/mesh-edit` on first use (optional
peers: install both with this entry) and takes an `AbortSignal`.

```ts
import {Engine} from 'margoengine/core';
import {sphereGeometry, toGeometry} from 'margoengine/geometry';
import {Scatter} from 'margoengine/scatter';
import {scatterLODs, ringDistance} from 'margoengine/scatter/simplify';
const engine = await Engine.create(document.querySelector('canvas')!);
const rock = toGeometry(sphereGeometry(0.5, 32, 16));
const rings = await scatterLODs(rock, {ratios: [0.4, 0.12]});
console.log(rings.triangles, rings.meshes[0] === rock); // [960, 383, 115] true
// Switch each ring where its error is under one pixel of a 1080-pixel-tall view, for rocks up to 1.5 times as big.
const [near, mid] = [rings.deviation[1], rings.deviation[2]].map((d) => ringDistance(d * 1.5, 1, 1080));
console.log(+near.toFixed(1), +mid.toFixed(1)); // 27.1 160.9
const rocks = Scatter.attach(engine, rings.meshes, {count: 5000, area: [200, 200], scale: [0.5, 1.5], lod: [near, mid, 300]});
```

- Every ring vertex is a source vertex with its own normal, so hard edges and blade shading stay as authored, and the
  rings nest.
- `deviation` gives each ring's largest distance from a source vertex to its surface in mesh units; `ringDistance(
  deviation * maxScale, pixels, screenHeight, fov)` turns that into the camera distance past which the ring's error
  is under `pixels`, a starting point for the `lod` distances.
- A mesh with nothing to spare (a box, a crossed card) keeps its shape, so a ring may keep more than its ratio.
- Limits: positions and normals only (core Geometry has nothing else); up to 200,000 vertices.

## Needle and leaf levels: `@margoengine/scatter/foliage`

`foliageLODs` makes lighter levels of a mesh of many small pieces (needles, leaves, leaf cards) without thinning the
crown. Edge collapse (`scatterLODs`, or an exported decimation) removes their area; here whole pieces are removed in an
even, seeded order and the rest grow until the level's silhouettes along x, y and z cover what the source's cover. Thin
pieces widen first, down to `slender` times longer than wide (default 4), then grow both ways; pieces over 8 times the
median area (stems) keep their size. Texture coordinates stay with their vertices, and each level's pieces are a subset
of the level before.

```ts
import {foliageLODs} from '@margoengine/scatter/foliage';

// 2,000 flat needles, 6 cm by 3 mm, in a cone.
const positions: number[] = [], normals: number[] = [], indices: number[] = [];
for (let n = 0; n < 2000; n++) {
  const h = (n * 0.618) % 1, a = n * 2.4, r = (1 - h) * 1.2 * ((n * 0.755) % 1);
  const x = r * Math.cos(a), y = h * 4, z = r * Math.sin(a), first = n * 4;
  for (const [i, j] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    positions.push(x + i * 0.03 * Math.cos(n), y + j * 0.0015, z + i * 0.03 * Math.sin(n));
    normals.push(-Math.sin(n), 0, Math.cos(n));
  }
  indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
}
const levels = foliageLODs({positions, normals, indices}, {triangles: [4000, 800, 200]});
console.log(levels.map((l) => l.triangles), levels.map((l) => Math.round(l.coverage * 10) / 10)); // [4000,800,200] [1,1,1]
```

Each level is `{positions, normals, indices, uvs?}` plus `triangles`, `elements`, `area` and `coverage`: build
`new Geometry(positions, normals, indices)` per level for `Scatter`'s three rings and pass the three `uvs` as
`textures.uvs`. `area` as an option holds a surface area instead of the silhouette (the source's area keeps the
lighting's optical depth and draws a dense crown fuller). `libraryParts` of `@margoengine/scenes/library` does all of
this from one model with `foliageTriangles`. Measured on the CC0 fir scan `fir_tree_01` (4,066,119 needle triangles,
silhouette 35.2 to 35.6 m2): exported decimations of 76,892, 7,800 and 2,282 triangles cover 8.8, 1.9 and 0.8 m2;
these levels at the same counts cover 35.3, 35.5 and 34.5 m2, built in about 1.5 s on the CPU. Limits: give it foliage
only (one connected piece cannot be pruned); weld a mesh whose leaves are split at seams first; grown pieces are
broader and catch more even light than the needles they replace, so up close the crown reads coarser and a little
brighter than the scan. Method: Cook, Halstead, Planck and Ryu,
[Stochastic Simplification of Aggregate Detail](https://graphics.pixar.com/library/StochasticSimplification/), SIGGRAPH
2007; coverage kept as in Neubert, Pirk, Deussen and Dachsbacher,
[Improved Model- and View-Dependent Pruning of Large Botanical Scenes](https://diglib.eg.org/handle/10.1111/v30i6pp1708-1718),
Computer Graphics Forum 30(6), 2011.

## Procedural grass blades: `@margoengine/scatter/grass`

`GrassScatter` is a `Scatter` that takes no mesh: every instance is a clump of blades the vertex stage builds on the
GPU, for dense meadows. `GrassScatter.attach(engine, { count, area, lod, grass: { height, blades, width } })` takes
every `Scatter` option, with `blades` shading on by default.

```ts
import {Engine} from 'margoengine/core';
import {GrassScatter} from 'margoengine/scatter/grass';
const engine = await Engine.create(document.querySelector('canvas')!, {camera: {position: [0, 1.7, 8], target: [0, 0.5, 0]}});
// No mesh: each of the 200,000 instances is a clump of 12 blades built on the GPU.
const meadow = GrassScatter.attach(engine, {
  count: 200_000, area: [60, 60], lod: [12, 30, 60],
  grass: {height: 0.5, heightVariance: 0.4, width: 0.03, blades: 12, segments: [6, 3, 1]},
});
```

- Each blade is a quadratic Bezier spine (root, a control point above it, a leaning tip) widened into a strip that
  tapers to a point (its tip is a pair of vertices drawn as one point up close). Its root inside the clump disc
  (`radius`), facing, height (`heightVariance`) and lean come from a hash of the instance's world root and the blade's
  number, so a blade keeps its shape as the camera moves.
- The ring meshes hold only (side, along, blade number) per vertex; `segments` sets the steps along a blade in rings
  0, 1 and 2 (default 5, 3 and 1), so a far blade is one quad. Distant blades widen across their own width only.
- Coverage, not pixels: every blade is drawn by prefiltered coverage, so a blade thinner than a pixel adds its true
  share of colour and never breaks into lone pixels or broken runs without multisampling. The camera's pixel at the
  blade's distance is worked out each frame; the blade is widened by a filter radius across its screen axis
  (perpendicular to its spine and the eye) and each pixel takes the share of a tent filter the true strip covers as
  alpha (Gupta and Sproull, "Filtering Edges for Gray-Scale Displays", SIGGRAPH 1981; Chan and Durand, "Fast
  Prefiltered Lines", GPU Gems 2, 2005), blended by Porter and Duff's over. The radius is one pixel, and two for a
  blade under 8 pixels tall (mixed over 4 pixels), the prefiltering of far vegetation (Bruneton and Neyret,
  Eurographics 2012). The near ring draws each blade's core (a filter radius in from its edges) opaque with depth
  first, then the whole blade blended over it. After all the blending a depth-only pass writes every covered blade's
  depth where its coverage passes a hash of the blade (a hashed alpha test, Wyman and McGuire, I3D 2017, on the
  coverage; the alpha-tested depth pass of blended hair, Nguyen and Donnelly, GPU Gems 2, 2005), so a pixel keeps
  depth with the chance of its coverage and overlapping blades leave it bare with the chance over leaves its colour
  bare (stochastic transparency, Enderton, Sintorn, Shirley and Luebke, I3D 2010), and the pattern stays on the blade
  as the camera moves. Ambient occlusion (`@margoengine/post` GTAO, which reads only depth), depth of field, fog and
  meshes drawn later see the grass while its colour keeps the blended coverage (KB-SCENES-DUNE-GTAO1). `SSAO` and
  `GTAO` darken only ambient light: the covered blades take their share of each pixel out of the ground's ambient light
  as they take it out of its colour (the product of one less each coverage, the revealage of McGuire and Bavoil,
  "Weighted Blended Order-Independent Transparency", JCGT 2013), so a blade never leaves a black pixel behind
  (KB-SCENES-GRASSBLACK1). A pixel whose blade depth passed its hash is mostly ground where the coverage is low, so
  while `SSAO` or `GTAO` is attached the covered depth draws in its own pass (`<name>:cover-depth`, order 1.52) after
  the effect has kept the depth and ambient light under the blades (order 1.51): the effect then works out such a
  pixel's occlusion at the ground, with the blades still counted as occluders, and leaves no pale outline along the
  blades (KB-SCATTER-AOFRINGE1). Nothing to call: attaching both is enough. See `docs/limits.md`.
  Dune grass (1.6 cm leaves) to 230 m at 480 x 270 without MSAA: 4,902 lone pixels per million before, 0 after on
  WebGPU and 7.8 on the WebGL2 layer, mean luma within 0.31 codes of the same view drawn at 4 x 4 the pixels. Shadows
  keep a pixel floor with a hashed keep (Persson 2012; Cook, Halstead, Planck and Ryu, SIGGRAPH 2007), as does a
  colour stage that cannot carry coverage (several render targets). Cost: the near ring is drawn three times and the
  middle and far rings twice (the extra draw is the depth pass), and a covered fragment blends.
- Normals turn across the width (`round`) so flat blades shade round; wind, ground alignment and blade shading are the
  plain `Scatter`'s.
- Bunchgrass by default. `tussock` (0 to 1, default 0.6) gathers a clump's roots toward its crown and fans the blades
  outward from it, the inner ones upright and the outer ones arching to the full `lean`, the fountain form of the
  tussock grasses of mountain meadows (Thurber and Idaho fescue); 0 keeps the even disc and random leans. `dry` (0 to 1,
  default 0.2) is the share of cured, straw coloured blades a living tussock keeps, each picked by a hash of the blade;
  they take `dryColor` (default linear [0.3476, 0.2394, 0.0983], wild oat litter, ECOSTRESS Spectral Library 1.0
  samples VH354 and VH355; Meerdink, Hook, Roberts and Abbott, Remote Sensing of Environment 230, 2019,
  https://doi.org/10.1016/j.rse.2019.05.015) at the brightness the green blade would have had. `tone` (0 to 1, default
  0.25) spreads brightness blade by blade. The default green, used without a `material`, is green grass leaves
  measured the same way (samples VH350 and VH352, ripgut brome and wild oat): linear [0.1617, 0.2024, 0.0917].
- Leaf to leaf colour from measured leaves. `hue` (0 to 0.5, default 0.02) turns each blade's hue about the grey axis
  by up to that share of a turn either way. `yellow` (0 to 1, default 0.15) is the share of blades losing their
  chlorophyll: each turns part of the way to `yellowColor` (default linear [0.1432, 0.1794, 0.0382], the mean
  reflectance of the 39 ANGERS 2003 leaves of 8 to 20 ug/cm2 chlorophyll). `tipBrown` (0 to 1, default 0.25) is the
  longest dead tip as a share of the blade: each blade takes `dryColor` over its last 0 to `tipBrown`, blended in over
  that span, as grass leaves die back from the tip. `transmittance` (three numbers 0 to 4, default [1.0909, 1.1726, 0])
  is the light through a living leaf over the light it reflects, per channel: ANGERS 2003 green leaves (40 ug/cm2
  chlorophyll and more) integrate to transmittance [0.0528, 0.0856, 0] and reflectance [0.0484, 0.073, 0.0364], so the
  sun seen through a blade (`blades.translucency`) glows yellow green with no blue. ANGERS: S. Jacquemoud, L. Bidel,
  C. Francois and G. Pavan, INRA Angers 2003, from EcoSIS (https://ecosis.org); the spectra are in
  `test/fixtures/leaf-spectra.json` and `test/grass.test.js` integrates them again.

  ```js
  import { PbrMaterial } from '@margoengine/core';
  import { GrassScatter } from '@margoengine/scatter/grass';
  const sward = new GrassScatter({
    count: 20000,
    area: [40, 40],
    material: new PbrMaterial({ color: '#5f6a3a', roughness: 0.55 }),
    blades: { translucency: 0.6 },
    grass: { hue: 0.03, yellow: 0.2, tipBrown: 0.35 },
  });
  sward.dispose();
  ```

  ```js
  import { GrassScatter } from '@margoengine/scatter/grass';
  const meadow = new GrassScatter({ count: 20000, area: [40, 40], grass: { tussock: 0.8, dry: 0.3, blades: 14 } });
  meadow.dispose();
  ```
- The shape is compiled into the shaders: make a new `GrassScatter` to change it.
- Real-GPU proof: `npm run test:browser:grass --workspace @margoengine/scatter`, and the shadows the blades cast, still,
  wind-bent and in each ring, in `Shadows` and `VirtualShadows`: `npm run test:browser:grass-shadow --workspace @margoengine/scatter`
  (build the packages first).
  The coverage: `npm run test:browser:grass-pixel --workspace @margoengine/scatter` (WebGPU, then the WebGL2 layer).

Real WebGPU LOD, diffuse/PBR fade-mask and device-restoration checks:
`npm run test:browser --workspace @margoengine/scatter` (build geometry/core first).


### Tile input storage

`setTile` accepts any byte-aligned Uint8Array view of complete 8-byte records, including subarrays at an unaligned
word offset. Bounds and tile coordinates must remain finite as f32; nonzero coordinates and spans must be normal
f32 values. Bounds must stay ordered after conversion. A tile side must be positive and normal, its product with
65,535 must fit f32 (the packed-coordinate shader intermediate), and its endpoint sums must fit f32. Invalid input
throws before replacing held records.

Stream clumped grass on terrain with `generateGrassMesh(7)`, `(3)` and `(1)` as the three LOD meshes. This complete
WebGPU example shares one height function between a visible terrain mesh and scatter's cell-centred height texture.
Sixteen held 64 m chunks contain 1,024 clumps each. It makes no huge-area or frame-rate claim.

```ts
import { Engine, PbrMaterial } from '@margoengine/core';
import { ScatterTiles } from '@margoengine/scatter/tiles';
import { generateGrassMesh } from '@margoengine/procedural';
import { toGeometry } from '@margoengine/geometry';
import { heightfieldGeometry, TerrainHeightmap } from '@margoengine/terrain';

const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu', camera: { position: [0, 12, 30], target: [0, 0, 0] },
});
const height = (x: number, z: number) => 2 * Math.sin(x / 35) * Math.cos(z / 40);
const ground = { size: [256, 256] as const, origin: [-128, -128] as const };
engine.createMesh().setGeometry(toGeometry(heightfieldGeometry(height, { ...ground, resolution: 128 })))
  .setMaterial(new PbrMaterial({ color: [0.18, 0.3, 0.08] }));
const map = TerrainHeightmap.attach(engine, height, { ...ground, resolution: 256 });
const grass = ScatterTiles.attach(engine, [
  toGeometry(generateGrassMesh(7)), toGeometry(generateGrassMesh(3)), toGeometry(generateGrassMesh(1)),
], {
  bounds: [-128, -128, 128, 128], heightmap: () => map.texture,
  slots: 16, slotSize: 1024, lod: [20, 50, 100], lodFade: 4, blades: {},
});
const records = new Uint8Array(1024 * 8), words = new DataView(records.buffer);
for (let i = 0; i < 1024; i++) {
  words.setUint16(i * 8, ((i % 32 + 0.5) / 32) * 65536, true); // tile-local X
  words.setUint16(i * 8 + 2, ((Math.floor(i / 32) + 0.5) / 32) * 65536, true); // Z
  records[i * 8 + 5] = 128; // log scale: 128 is scale 1
  records[i * 8 + 6] = (i * 73) % 256; // yaw, 256 steps per turn
}
for (let z = -2; z < 2; z++) for (let x = -2; x < 2; x++)
  grass.setTile(`${x},${z}`, [x * 64, z * 64], 64, records);
engine.start();
// When a chunk streams out: grass.removeTile('1,1'); replace/setTile when one arrives.
// On teardown: engine.dispose(); it owns the terrain map and scatter resources.
```

Each record places a clump; the GPU picks the near, middle and far mesh by distance and fades between them. Manage
the held set with `setTile` and `removeTile`; the coordinate range alone does not allocate records for unheld chunks.

## Shadow cascades draw only what reaches them

With `@margoengine/shadows`, each cascade of the shadow map draws, per LOD ring, only the instances whose posed bounds
reach that cascade's light box. Nothing to set: `Shadows` calls `scatter.prepareShadow` once a frame with every
cascade's matrix, and the cull runs on the GPU before the cascades draw. The shadow map is the same as when every
cascade draws every instance the camera keeps; an instance outside a cascade's box would only clip away there.

```ts
import {Engine} from 'margoengine/core';
import {sphereGeometry, toGeometry} from 'margoengine/geometry';
import {Scatter} from 'margoengine/scatter';
import {Shadows} from 'margoengine/shadows';
const engine = await Engine.create(document.querySelector('canvas')!);
const shadows = Shadows.attach(engine, {cascades: 4});
const bushes = Scatter.attach(engine, toGeometry(sphereGeometry(0.5, 12, 6)), {count: 20000, area: [300, 300], lod: [25, 60, 250]});
shadows.add(bushes); // bushes past the shadow distance are drawn in no cascade; the near ones in the cascades they reach
```

- Proof: `node packages/scatter/test/shadow-cull.browser.mjs` draws three scenes (LOD rings with fades, scales and
  wind; widened wind-bent grass blades; trunks with a raised canopy sharing their rings) and checks that the
  four-cascade shadow map is bit for bit the one drawn without the cull, and the frames pixel for pixel. In its tree
  scene it reads back each cascade's indirect draw counts and checks them against a CPU classification of every
  instance against Shadows' matrices: every instance whose bounds reach a cascade is drawn there, none outside it, so
  49 trees 300 m away (past 120 m of shadows) are drawn in no cascade. Before the cull, 4 cascades redrew every tree 4
  times.
- WebGPU: one compute pass writes a list per cascade and ring and the indirect arguments the cascade draws use.
- WebGL2 compatibility layer: the same tests run as point draws on the GPU, each storing at its own slot, and a prefix
  count compacts the lists in candidate order, so the lists hold the instances WebGPU's hold. WebGL2 has no indirect
  draws and reading the counts back would stall the main thread, so a cascade's draw asks for every slot of its ring
  and the vertex stage drops the slots at or past the list's count, read from a small counts buffer. The shadow map is
  the same; the saving there is the rasterization and fragment work of the instances left out, while the vertex stage
  still runs for every slot.
- A caller that draws scatter shadows through `drawShadow` without calling `prepareShadow` in the frame gets every
  camera-culled instance in every cascade. The lists are made again when the cascade count or the ring buffers change
  (a `ScatterTiles` ring that grew or shrank), and freed by `dispose()`.

## Material capture: SSR, SceneTargets and LightBounce see the plants

`scatter.setCapture(hook)` lets a capture effect of `@margoengine/post` draw the plants with their own material:
`ssr.add(scatter)`, `targets.add(scatter, {ground: false})` and `bounce.add(scatter)` call it for you. The capture pass
draws this frame's three LOD rings with the colour pass's own stage (wind, ground fit, LOD dither, blade normals,
`variation`, texture maps and the cut-out) ending in the effect's `margoSSR`, depth tested and written, so the effect's
masks, reflections and bounce see a fern in front of the ground instead of the ground behind it. Covered rings (grass
tips, far blades) capture where their coverage passes the pose's threshold, as their depth pass keeps them; an imposter
far ring captures as its mesh. One Scatter in several effects keeps each effect's stage. The instances are the main
camera's culled and LOD'd set (as `drawShadow`), and the vertex stage is the colour pass's, so under TAA the plants
depth-test against the core replay exactly.

- Lit Scatters only (the `material` option): an unlit one has no world position, sun or material in its stage, and
  `setCapture` throws MargoError `unsupported` (docs/limits.md).
- `draw(c, 'capture')` draws nothing without a hook, before the first distribute or after `dispose()`;
  `onDispose(callback)` lets an effect forget a disposed Scatter.
- `ScatterTiles`, textured and states scatters inherit it; WebGPU and the WebGL2 layer.
- `ScatterInstances` (and `AttributedScatter`) has the same `setCapture`, `draw(c, 'capture')` and `onDispose`
  (KB-LOOK-MASKOCCLUDE1, 2026-11-26): every fixed batch with the colour pass's own stage (wind, sway, vertex colour and
  occlusion), each view with its own frame uniform. `post/test/scene-targets-scatter-browser.mjs` runs its plant over
  shaded ground with both kinds on WebGPU and the WebGL2 layer: added with `{ground: false}`, no lit or shaded ground
  on the instanced plants (959 plant pixels, 0 and 0).

```ts
import { Engine, PbrMaterial, box } from 'margoengine/core';
import { Scatter } from 'margoengine/scatter';
import { SceneTargets } from 'margoengine/post/mrt';
const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const ferns = new Scatter(box(0.4, 0.6, 0.4), {
  count: 2000,
  area: [40, 40],
  material: new PbrMaterial({ color: [0.2, 0.45, 0.1], roughness: 0.8 }),
});
engine.use(ferns);
const looks = SceneTargets.attach(engine, {
  outputs: { lit: 'litGround', shade: 'shadedGround', plants: { wgsl: 'vec4f(1.0-t.ground,0,0,1)', format: 'r8unorm' } },
});
looks.add(ferns, { ground: false });
engine.start();
```

## Motion vectors and motion blur in wind: `@margoengine/scatter/velocity`

A swaying field is still to TAA and `MotionBlur` unless its motion reaches their velocity buffer. `new
ScatterVelocity(scatter)` is a `TAAVelocityPass`: `taa.add(velocity)` makes TAA draw it in its object velocity pass each
frame (FG-16). Every vertex is posed twice with the scatter's own pose (blades, ground fit, wind bend), with this
frame's wind clock, eye and pixel footprint and with the last frame's, and projected with TAA's current and previous
view-projections, so a blade's vector is its own sway plus the camera's move. TAA keeps sharper history on the blades
and `MotionBlur` smears them along the gust at film shutters.

- Every stage that writes depth takes a vector, drawn as the colour pass draws it (TAA tests depth for equality):
  opaque rings, the opaque core of a `GrassScatter`'s near ring, and the coverage-depth stage of its covered tips and
  middle and far rings, which keeps the same hashed pixels the colour pass gave depth.
- A pixel a covered blade only blends into (no depth of it there) takes the blade's motion where the blade covers at
  least `coverage` of it (default 0.5): each covered stage is drawn once more in front of the depth there, writing no
  depth, nearer rings last, so a pixel whose colour is mostly blade moves with the blade. Below that share it keeps the
  motion of the surface behind. `new ScatterVelocity(grass, { coverage: false })` turns the stage off (one draw fewer
  for each covered ring).
- Plant states (`@margoengine/scatter/states`) and interaction bends are posed as they are now in both frames: their
  own change between frames is not in the vector.
- WebGPU and the full WebGL2 layer. Nothing is drawn before the scatter's first frame or after `dispose()`.
- Streamed scatters work too: a `ScatterTiles` forest remakes its ring, record and table buffers as tiles come and
  go, and the pass makes its bind groups again whenever one of those buffers is replaced, so a ring that grows on the
  frame a tile arrives is drawn from its new buffer.

```ts
import {Engine} from 'margoengine/core';
import {TAA} from 'margoengine/taa';
import {PostStack} from 'margoengine/post';
import {MotionBlur} from 'margoengine/post/motion-blur';
import {GrassScatter} from 'margoengine/scatter/grass';
import {ScatterVelocity} from 'margoengine/scatter/velocity';

const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu',
  camera: {position: [0, 3, 6], target: [0, 0, 0], near: 0.1, far: 200},
});
// 700,000 clumps of blades in a 12 m/s wind.
const grass = GrassScatter.attach(engine, {count: 700_000, area: [60, 60], wind: [1, 0.3, 0.8, 12]});
let taa: TAA | undefined;
const stack = PostStack.attach(engine, [new MotionBlur({velocity: () => taa?.velocity, shutter: 0.5})]);
taa = TAA.attach(engine, {depth: () => stack.depthTexture});
taa.add(new ScatterVelocity(grass));
for (let i = 0; i < 4; i++) engine.render({delta: 1 / 24});
```

Real-GPU proof: `node packages/scatter/test/velocity.browser.mjs` (and with `MARGO_COMPAT=1`): a still camera over a
meadow in wind has no vectors without the pass, vectors along the wind with it (diffuse and PBR, 4,000 and 700,000
clumps), and none at wind strength 0. `node packages/scatter/test/velocity-tiles.browser.mjs` (and `--compat`) streams `ScatterTiles`
tiles in and out with the pass attached, so the rings grow, the record pool grows and the rings shrink, and every
frame must submit without a destroyed buffer (KB-SCATTER-VELTILES1).

## Film time: seeking the wind to a cut

A film rendered scene by scene starts each scene in a fresh process, and the wind clock of every `Scatter` (grass
blades, tiles, imposters and the other subclasses included) and `ScatterInstances` adds up frame deltas. Each has
`advanceTime(delta)`, the CPU part of its frame update, and a `time` getter (seconds on its wind clock); its
`onPreUpdate` runs the same `advanceTime`. So `seek` from `@margoengine/cutscene/seek` replays a run's steps and the
next frame sways every plant as a run started at 0 sways it there, bit for bit (`test/seek.test.js` to 54,000 steps;
`test/seek-check.mjs` pixel for pixel on WebGPU and the WebGL2 compatibility layer).

```ts
import {Engine, Geometry} from 'margoengine/core';
import {Scatter} from 'margoengine/scatter';
import {seek} from 'margoengine/cutscene/seek';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const blade = new Geometry([-0.02, 0, 0, 0.02, 0, 0, 0, 0.8, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2]);
const grass = Scatter.attach(engine, blade, {count: 20000, area: [20, 20], blades: {}, wind: [1, 0.2, 0.6]});
// This scene starts 95 s into the film: the gusts are where a run from 0 had them.
await seek(engine, 95, {fps: 30});
engine.render({delta: 1 / 30});
console.log(grass.time);
```

`TrampledScatter`'s trample field is history on the GPU: a cut starts it flat, and the scene's warm-up frames bring
it back (it recovers with `e^(-3 t / recover)`).

Several cuts in one process: `resetTime()` on every `Scatter` and `ScatterInstances` puts the wind clock back to 0 as
a fresh one has it (`resetClocks` from `@margoengine/cutscene/seek` calls it on every clock), so a later `seek` gives
what a fresh world seeked there gives. `TrampledScatter` also clears its trample field on the GPU, flat as at the
start. Evidence: `test/reset-time.test.js` (state of a reset scatter equals a fresh one's, before and after a 90-step
seek, for `Scatter`, `ScatterInstances`, `TrampledScatter` and `GrassScatter`).

## Sliders: `@margoengine/scatter/settings`

A `Scatter` reads its density, colour, wind, blade root shade and blade width from its frame uniform every frame, so they change while the scene runs. `Scatter` has the setters `density` (0 to 1, the kept fraction of candidates, the same instances each time), `color` (linear RGB, used with no material), `wind` (`[x, z, strength]` or undefined, as a weather drive writes it) and `rootShade` (needs `blades`). `@margoengine/scatter/settings` lists them as a table for sliders and panels: `SCATTER_SETTINGS` has 11 rows (`scatter.density`, `scatter.color`, `wind.directionX`, `wind.directionZ`, `wind.strength`, `blades.rootShade`, `blades.widen`, `blades.translucency`, `variation.hue`, `variation.value`, `variation.clusters`; each has `name`, `group`, `kind`, `default`, `min`, `max`, `step`, `unit`, `about` and `live`). The first seven are `live`. `blades.widen` (setter `widen`, 0 to 10) also moves the cull reach with it. `blades.translucency` (`translucencyAmount`), `variation.hue` and `variation.value` (`variationHue`, `variationValue`) and `variation.clusters` (`clusters`) are `live: false`: their values are read from the material uniform every frame, but moving one off 0 (or back to 0) adds or removes a stage of the lit shader, so Scatter builds the other pipeline once (kept for the way back). Between nonzero values nothing is built. `variation` and `clusters` need a Scatter built with a `material`, translucency and widen one built with `blades`. `applyScatterSettings(scatter, values)` writes a set of values (a name left out takes its default; wind strength 0 removes the wind), and `SCATTER_LOOKS` names `natural`, `thinMeadow` and `dryWindy`. An unknown name throws `TypeError`, a value outside its row `RangeError`, and `blades.rootShade` off its default on a Scatter built without `blades` (or, for the variation rows, without a `material`) `TypeError`. Not rows: everything that places instances at construction. Proof on a real GPU (`npm run test:settings:browser`, native WebGPU and the WebGL2 layer): the defaults written draw the frame exact, 60 frames of every live row, and of the four other rows between nonzero values, create no pipeline, buffer or texture, turning translucency on from 0 builds one pipeline, and the last frame equals writing the values once.

```ts
import {Engine, box} from 'margoengine/core';
import {Scatter} from 'margoengine/scatter';
import {SCATTER_LOOKS, applyScatterSettings} from 'margoengine/scatter/settings';

const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const meadow = Scatter.attach(engine, box(0.08, 0.6, 0.08), {count: 40000, area: [24, 24], blades: {}});
let time = 0;
engine.onFrame((_, delta) => {
  time += delta;
  // The wind builds over the first four seconds of the shot.
  applyScatterSettings(meadow, {...SCATTER_LOOKS.dryWindy, 'wind.strength': 0.9 * Math.min(time / 4, 1)});
});
```

## Exact first frames on the WebGL2 layer

`scatter.ready` is a promise that settles once every frame draws the instances as it will from then on. On the WebGL2
compatibility layer a plain `Scatter` (no texture maps, no states) fetches its compatibility route (`import()`) when it
attaches, and until it arrives frames run the WebGPU kernels on the layer. On WebGPU, and for every other Scatter, it is
already settled. Await it before a frame that must be exact, such as a film frame or a pixel comparison:

```ts
import {Scatter} from 'margoengine/scatter';
import {Engine, box} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const grass = Scatter.attach(engine, box(0.1, 0.4, 0.1), {count: 10_000, area: [20, 20]});
await grass.ready;
engine.render();
```

## Preview tier contract

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.

### Interaction entry size

The optional interaction entry keeps its numerical safety explanation in
TypeScript comments, outside shipped shader strings. This removes runtime
comment text while preserving the shader token sequence, heightfield sampling,
extreme-coordinate guards, recovery and all defaults. The CPU interaction and
scatter tests run unchanged; real-GPU coverage remains a separate gate.

## Solved plant sway

Use `@margoengine/scatter/plant-motion` as the `states` source for a Scatter or ScatterTiles. It reads the modal pose
from `PlantSway` and bends the same plant geometry in the colour, depth and shadow passes. A root and its rendered
instance share an X/Z cell. Pick a cell size that gives every independently simulated root its own cell and covers
the placement jitter. Unmapped instances keep their usual scatter wind and posing. Positions are in metres.

```ts
import { PlantSway } from '@margoengine/physics/vegetation';
import { PhysicsWorld } from '@margoengine/physics/world';
import { PlantMotion } from '@margoengine/scatter/plant-motion';

const sway = await PlantSway.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(sway, {
  plants: [{ root: [0, 0, 0], height: 2, baseDiameter: 0.02,
    youngModulus: 5e8, density: 600, initialDisplacement: [0.04, 0, 0, 0] }],
});
const motion = new PlantMotion({
  roots: [{ xz: [0, 0], height: 2 }],
  cellSize: 0.5,
  origin: [-0.25, -0.25],
  readSway: () => sway.readSway(),
});
world.advance(1);
const options = { states: motion, wind: [1, 0, 0] as const };
// Pass options to Scatter.attach(engine, geometry, options).
// Dispose the Scatter before calling motion.dispose().
console.log(options.states, sway.sample(0, 2));
```

The zero-strength wind in this example enables Scatter's wind culling reach allowance. The physical pose replaces
wind on mapped roots. Set the mesh pivot at the root and match its scaled tip height to the solver's height.
To compose an existing burn or flood treatment, pass its `PlantStateSource` as `states` to `PlantMotion`.
Use `hideFailed: true` to remove a failed standing instance when detached geometry is drawn by the rigid body. This
hides the entire instance, so a visible stump needs its own mesh.

For submerged plants, pass the same `SpectralSea.water` to `PlantSway` as `flow`. The fixed-camera seagrass check runs with `npm run test:gpu:plant-surge -w @margoengine/scatter`. It compares two rooted clumps one wavelength apart at different depths. The submitted poses match the accepted sway field, the shallow clump bends farther in the solved orbital flow, and both WebGPU and WebGL2 reproduce the held and restored frames. The fixture exercises the small-displacement beam regime described by Luhar and Nepf. [Luhar and Nepf (2016)](https://doi.org/10.1016/j.jfluidstructs.2015.11.007), [FHWA HEC-25, Chapter 5](https://www.govinfo.gov/content/pkg/GOVPUB-TD2-PURL-gpo161099/pdf/GOVPUB-TD2-PURL-gpo161099.pdf)

For timed wind, pass the result of Weather's `travellingGust(baseWind, options)` as the `PlantSway` `flow`. The TREE-1 technical meadow runs with `npm run test:gpu:plant-gust -w @margoengine/scatter`. A 4 m/s front reaches roots 1, 3 and 5 m from the trigger at 0.75, 1.25 and 1.75 s. The first accepted sway follows each crossing by one 60 Hz step. The test checks the actual registered poses and visible downstream movement, a stationary far clump before the front arrives, and byte-identical held and replayed snapshots and frames on both renderers. The one-cosine event supplies the authored forcing. Plant bending comes from the solved stem modes. [14 CFR § 25.341(a)(2), gust profile](https://www.govinfo.gov/app/details/CFR-2025-title14-vol1/CFR-2025-title14-vol1-sec25-341), [Py, de Langre and Moulia (2006), wind and plant canopies](https://doi.org/10.1017/S0022112006002667)
