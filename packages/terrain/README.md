# @margoengine/terrain

All terrain plugins remove their actual scene registration on `dispose()`,
preserving a same-name plugin in another scene. Device restoration retains
registration. Stream disposal also removes its owned terrain; blend and sculpt
leave their borrowed terrain and virtual texture attached. The public `owner`
fields of `TerrainMaterials`, `TerrainDisplacement`, `TerrainVirtualTexture` and
`TerrainDeformation` identify the Engine; use `engine.sceneOf(effect)` for the scene.

```ts
import {Engine} from 'margoengine/core';
import {TerrainHeightmap} from 'margoengine/terrain';
const engine = await Engine.create(document.querySelector('canvas')!);
const product = engine.createScene('product');
const heightmap = new TerrainHeightmap(() => 0, {size: [4, 4], resolution: 16});
product.use(heightmap);
console.assert(engine.sceneOf(heightmap) === product);
heightmap.dispose(); // Frees its texture and registration; product can register a replacement.
```

Import `margoengine/terrain` from the `margoengine` package, or `@margoengine/terrain` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

`heightfieldGeometry(height, {size, origin?, resolution?})` generates a Y-up mesh
with recomputed slope normals; `heightfield(height, options)` gives the same grid as a core `Geometry`, ready for
`mesh.setGeometry`. `origin` is the minimum world XZ corner; it defaults
to a centered rectangle, and mesh resolution defaults to 192 segments.
`TerrainHeightmap.attach(engine, height, {size, origin?, resolution?})` owns an
`r32float` texture sampled at cell centers, exposed as `.texture` for scatter and
water. `Terrain` and `TerrainQuery` read a heightmap corner-aligned instead (texel 0 at `origin`, the last texel at
`origin + size`), so to draw this texture as a `Terrain` give the terrain `origin + size / (2 resolution)` and
`size (resolution - 1) / resolution`; the same `origin` and `size` shift the ground by half a cell and stretch it by
`resolution / (resolution - 1)`. Texture resolution defaults to 256. Resolutions are integers in 1..1024.
The module validates finite samples and device limits, regenerates the texture
on device restoration, and destroys it on disposal. Sampling arrays are released
after upload; there is no per-frame CPU sampling or allocation.

`TerrainColors.attach(engine, mesh, options?)` applies height/slope colors and wet
shoreline darkening to one ordinary terrain mesh using its mesh ID. It preserves
the existing PBR/shadow shader and caches the patch. Options are captured at
attachment, and every one has a default, so `TerrainColors.attach(engine, mesh)` alone gives sand at sea level
(world Y 0, as `@margoengine/water`), grass over the rest and rock on slopes past about 35 degrees:

| Option | Default | Source |
| --- | --- | --- |
| `sand` | `[0.5, 0.42, 0.29]` | dry sand albedo 0.35 to 0.45 (Oke 1987, table 1.1) |
| `meadow` | `[0.133, 0.263, 0.033]`, `[0.274, 0.342, 0.064]` | grass albedo 0.16 to 0.26 (Oke 1987); the biomes package's grass and meadow |
| `stone` | `[0.253, 0.223, 0.187]` | the biomes package's rock |
| `shore` | `[0.3, 1.5]` m | beaches up to 1.5 m above sea level |
| `meadowHeight` | the mesh's lowest to highest point, under its position and Y scale | |
| `stoneHeight` | above the mesh's highest point (only slopes are stone) | pass a range for rocky peaks |
| `stoneNormal` | `[0.75, 0.85]` (normal Y: 32 to 41 degrees) | angle of repose of loose soil and scree, 30 to 40 degrees (Carrigy 1970) |
| `wetHeight` | `[-0.1, 0.4]` m | just above sea level |
| `wetDarkening` | `0.6` | wet ground at about 0.6 of its dry albedo (Lekner and Dorf 1988) |
| `wetDryTime` | `900` s (1 to 604,800) | with `wetness`: sand the water has left dries to 1/e of its moisture (Namikas et al. 2010) |
| `wetGlossTime` | `20` s (0.1 to 3,600) | with `wetness`: its glossy water film drains to 1/e (Horn 2006) |
| `variation` | `0` (0..1) | |
| `detail` | `1` (0..1) | |
| `sandSurface` | `{wind: [1, 0], ripple: 0.1, ripples: 1, streaks: 1, sorting: 1, broad: 0}`; `false` removes it | wind-built sand, below |

Ranges must be increasing; colors are linear RGB in 0..1. Other meshes keep their materials. Sources: T. R. Oke,
"Boundary Layer Climates", 2nd ed., 1987; J. Lekner and M. Dorf, "Why some things are darker when wet", Applied Optics
27(7), 1988, https://doi.org/10.1364/AO.27.001278 ; J. Carrigy, "Experiments on the angles of repose of granular
materials", Sedimentology 14, 1970, https://doi.org/10.1111/j.1365-3091.1970.tb00184.x

```ts
import {Engine} from 'margoengine/core';
import {TerrainColors, heightfield} from 'margoengine/terrain';

const engine = await Engine.create(document.querySelector('canvas')!);
const ground = engine.createMesh();
ground.setGeometry(heightfield((x, z) => 6 * Math.sin(x / 9) * Math.cos(z / 11) + 2, {size: [120, 120]}));
TerrainColors.attach(engine, ground); // sand, grass and rock with no options
engine.camera.position = [0, 40, 90];
engine.camera.target = [0, 0, 0];
```

### Wind-built sand: `sandSurface`

The sand band carries what the wind does to dry sand, on by default (with `detail` above 0): impact ripples across
the wind, streaks along it, and sorting by slope, so a dune field reads as dunes in flat overcast light instead of one
beige sheet. Pass the direction the wind blows toward; a scene with a north wind blows toward +z:

```ts
import {Engine} from 'margoengine/core';
import {TerrainColors, heightfield} from 'margoengine/terrain';
import {duneField} from 'margoengine/terrain/dunes';

const engine = await Engine.create(document.querySelector('canvas')!);
const heights = duneField({width: 129, depth: 129, cellSize: 1, origin: [-64, -64], height: 2, wind: 90, seed: 3});
const ground = engine.createMesh().setGeometry(heightfield((x, z) => {
  const i = Math.min(128, Math.max(0, Math.round(x + 64))), j = Math.min(128, Math.max(0, Math.round(z + 64)));
  return heights[j * 129 + i];
}, {size: [128, 128], resolution: 128}));
TerrainColors.attach(engine, ground, {shore: [20, 30], sandSurface: {wind: [0, 1], ripple: 0.1}});
engine.camera.position = [0, 1.7, -20];
engine.camera.target = [0, 0, 0];
```

| `sandSurface` field | Default | Meaning |
| --- | --- | --- |
| `wind` | `[1, 0]` | direction the wind blows toward, world `[x, z]`, any length above 0 |
| `ripple` | `0.1` m (0.02 to 1) | ripple spacing; impact ripples of fine to medium sand are 5 to 20 cm apart |
| `ripples` | `1` (0 to 2) | relief: height 1/15 of the spacing, a 5.5 degree windward side and a 19 degree lee side |
| `streaks` | `1` (0 to 1) | streaks along the wind, 1 to 2 m wide, albedo up to 8% either way |
| `sorting` | `1` (0 to 1) | lee slip faces up to 10% paler and smooth, with grainflow strips; windward faces up to 7% darker |
| `broad` | `0` (0 to 1) | broad scour bands along the wind, 8 to 15 m wide and about 80 m long, up to 15% albedo either way; they never fade with distance, so far dune faces keep the wind's marks |

- Ripples: crests run across the wind and wander and break off at defects (a two-octave phase warp and an amplitude
  noise), with coarse grains darkening the crests and lee sides. Their relief bends the shading normal as a surface
  gradient. Before a pixel covers half a ripple they fade out in object space (the footprint is the pixel's own, the
  longer screen-space derivative of the position, so it follows the frame size, device pixel ratio and grazing
  angle; `test/sand-footprint.browser.mjs` checks 540 and 270-line frames against a filtered 2160-line one), and the crest band has zero mean, so the far ground keeps its colour and
  does not shimmer. They are left off avalanching slip faces, and with a `wetness` record they fade with its
  moisture: wet and submerged sand carries none (moisture holds the grains; Namikas and Sherman 1995, Wiggs et al.
  2004), so a sea floor seen through water is smooth.
- Sorting: a face turned downwind past about 15 to 27 degrees is a slip face (paler, fresh avalanche sand in strips
  about 1 m wide); a face turned upwind is windward (darker coarse lag). On sand only; meadow and stone are unchanged.
- Measured (`npm run test:gpu` in this package runs `test/sand.browser.mjs`; RTX A6000, WebGPU and the WebGL2
  layer): near ground luma spread 1.77 times that of `sandSurface: false`, slip face 1.047 and windward face 0.963
  times in sRGB luma, far ground pixel-to-pixel change 1.08 times.
- Sources: R. S. Anderson, "A theoretical model for aeolian impact ripples", Sedimentology 34, 1987; B. Andreotti,
  P. Claudin and O. Pouliquen, "Aeolian sand ripples: experimental study of fully developed states", Physical Review
  Letters 96, 2006; R. P. Sharp, "Wind ripples", Journal of Geology 71, 1963; R. A. Bagnold, "The Physics of Blown Sand
  and Desert Dunes", 1941; B. T. Werner and G. Kocurek, "Bedform spacing from defect dynamics", Geology 27, 1999; R. E.
  Hunter, "Basic types of stratification in small eolian dunes", Sedimentology 24, 1977; N. Lancaster, "Geomorphology
  of Desert Dunes", 1995; R. Greeley and J. D. Iversen, "Wind as a Geological Process", 1985; M. Mikkelsen, "Surface
  Gradient-Based Bump Mapping Framework", JCGT 9(3), 2020; A. Norton, A. Rockwood and P. Skolmoski, "Clamping: a method
  of antialiasing textured surfaces by bandwidth limiting in object space", SIGGRAPH 1982.

Colors are worked out per pixel from the interpolated world height and normal, so
band borders follow the true height and slope instead of the mesh's triangles.
`variation` darkens colors by up to twice its value with two octaves of smooth
value noise (14 m and 1.1 m cells, the fine one rotated 37° and faded out between
20 and 60 m from the camera so it cannot shimmer). The noise is hashed per lattice
cell and never repeats, so there is no tile to hide. The patch flags the mesh in a
flat varying (location 6), then wraps the rest of core's fragment after its
shading-normal line in a block whose `i` and `n` are the terrain's own copies:
shadows, clustered lights, sky ambient, IBL and post replays shade the per-pixel
albedo, roughness and normal without changing their own patches. Without core's
standard shader the patch does nothing and the mesh keeps its material color.

`detail` makes the bands read as materials. The 14 m noise moves every border by
up to 30% of its range, so beaches, meadow patches and the stone line wander.
Sand, meadow and stone then blend by procedural height maps, the height-based
blending of Mishkinis's "Advanced Terrain Texture Splatting" (2013): grass tufts
from the fine noise, sand settling in their hollows, rock bumps from the stone
pattern, so the higher surface wins near each transition instead of a smooth
crossfade. Where stone shows, its pattern is triplanar: anisotropic noise on the
two vertical projections reads as horizontal strata, the top projection as
lumps, so cliffs never stretch a top-down pattern. The noise's analytic gradient
tilts the normal by up to about 17° (surface-gradient bump mapping), lighting the
strata; the geometric normal still drives shadow bias. Stone brightness follows
the bumps (±30%), sand grain the fine noise (±10%). Fine detail fades out between
20 and 60 m. `detail: 0` removes all of it from the shader and keeps smooth
per-pixel bands; values in between scale it.

Cost: one flat compare on every core-mesh pixel. On terrain pixels about 40 ALU
operations for the bands; with `variation` or `detail`, about 60 per noise
octave: two octaves everywhere (one beyond 60 m) and three more triplanar ones
where stone shows within 60 m, plus about 30 for the blends and the bump. That is
roughly 200 operations on meadow and sand and 380 on near stone (counted from the
WGSL, not timed). There are no texture fetches and no derivatives, so it runs
inside the mesh-ID branch without uniformity limits.

For a moving wet-sand band, add `wetness: {texture: () => water.coastalDepthTexture,
origin: [-80,-80], size: [160,160]}` using the same world bounds as water's terrain.
The borrowed texture's red channel contains water depth in meters; it must be a
single-layer, single-sample 2D `r32float`, `rgba32float` or `rgba16float` texture
with `COPY_SRC`. Undefined uses dry sand while water initializes or restores.
The module keeps a stable GPU snapshot so flow ping-pong does not rebuild scene
or vegetation bindings each frame. A 256 × 256 `rgba32float` snapshot costs 1 MiB
and one GPU copy per frame. Terrain owns that snapshot, not the provider texture.

Sand the swash has left stays wet (KB-TERRAIN-WETSAND1). Terrain keeps a moisture
record over the water's grid, one `rgba32float` texel per water texel, updated once
a frame by a small compute pass from the depth snapshot: wherever water stands the
moisture and the surface film are full, and once it has gone the moisture falls as
`exp(-t / wetDryTime)` and the film as `exp(-t / wetGlossTime)`. The darkening share
is `(1 - e^-3m) / (1 - e^-3)` of the moisture `m`, since reflectance falls fastest
with the first moisture and levels off near saturation (Lobell and Asner 2002;
Nolet et al. 2014), so drying sand holds its dark tone and pales late; the film
sets the sheen. `wetSandAfter(seconds, dryTime, glossTime)` returns what the record
holds that long after the water left. Both times are live (`setLook`, and the
`wet.dryTime` and `wet.glossTime` rows). The record costs two more textures the size
of the water grid (2 MiB for 256 × 256) and starts dry: a shot that needs the wet
band in its first frame lets the water run before it.

```ts
import {Engine} from 'margoengine/core';
import {TerrainColors, heightfield, wetSandAfter} from 'margoengine/terrain';

const engine = await Engine.create(document.querySelector('canvas')!);
const depth = engine.gpu!.createTexture({
  size: [64, 64],
  format: 'r32float',
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
});
const beach = engine.createMesh().setGeometry(heightfield((x) => x * 0.02, {size: [80, 80], origin: [-40, -40]}));
const colors = TerrainColors.attach(engine, beach, {
  wetness: {texture: () => depth, origin: [-40, -40], size: [80, 80]},
  wetDryTime: 600, // sand behind the swash dries to 1/e in 10 minutes
});
colors.setLook({wetGlossTime: 10});
console.log(wetSandAfter(60, 600, 10).darkening); // 0.98 of the full darkening a minute after the swash
```

Sources: D. P. Horn, "Beach groundwater dynamics", Geomorphology 48, 2002,
https://doi.org/10.1016/S0169-555X(02)00178-2 ; D. P. Horn, "Measurements and modelling of beach groundwater flow in
the swash-zone: a review", Continental Shelf Research 26(5), 2006, https://doi.org/10.1016/j.csr.2006.02.001 ; R. A.
Namikas, B. L. Edwards, M. C. Bitton, J. L. Booth and Y. Zhu, "Temporal and spatial variabilities in the surface
moisture content of a fine-grained beach", Geomorphology 114(3), 2010, https://doi.org/10.1016/j.geomorph.2009.07.011 ;
D. B. Lobell and G. P. Asner, "Moisture effects on soil reflectance", Soil Sci. Soc. Am. J. 66, 2002,
https://doi.org/10.2136/sssaj2002.7220 ; C. Nolet, A. Poortinga, P. Roosjen, H. Bartholomeus and G. Ruessink,
"Measuring and modeling the effect of surface moisture on the spectral reflectance of coastal beach sand", PLoS ONE
9(11), 2014, https://doi.org/10.1371/journal.pone.0112151 ; S. A. Twomey, C. F. Bohren and J. L. Mergenthaler,
Applied Optics 25(3), 1986, https://doi.org/10.1364/AO.25.000431 . The 900 s and 20 s defaults are Margo's values
inside those ranges (minutes of drainage behind the swash, hours of drying landward), not a groundwater model.

Wetness samples world XZ per fragment and darkens only the sand albedo below
`wetHeight[1]`; fully wet sand is also 40% smoother while its film lasts, so it
catches a sheen toward the sun. Meadow/stone blends and geometry stay fixed to
terrain height and slope. It uses a group 0 binding from 40 up and flat output
location 6 in the standard PBR shader. No core changes are required. Physical
regression on WebGPU and the WebGL2 layer: `node packages/terrain/test/wetness.browser.mjs`
from the repository root after building the packages (MARGO_COMPAT=1 for the layer).

Optional geometry clipmaps with vertex texture height and normal sampling and 4 to 16 terrain layers. Fixed grids form a centre and concentric rings. Inner edges align to the finer grid and outer-edge vertices collapse onto the next coarser lattice to close seams. In moving-window mode, [seams.browser.mjs](test/seams.browser.mjs) checks 200 camera offsets for clear pixels through the ground on WebGPU and the WebGL2 layer. Height sampling uses bilinear `textureLoad`, including non-filterable `r32float` maps. Cliff faces use triplanar splatting and normalized slope and height weights blend an sRGB texture array.

The rings anchor at the main camera's world XZ on the first render. Camera motion then preserves the terrain triangles,
ridge silhouettes, and static shadow cache. Pass `clipmapAnchor: [x, z]` for a fixed centre you choose. Set `levels`,
`resolution`, or `cellSize` so the outer ring spans the terrain in view. For a route that exceeds the fixed outer ring,
pass `clipmapAnchor: 'camera'` to select a moving window on the same world lattice. `TerrainStream` defaults to that mode.
The fixed ring origin remains in world coordinates with `floatingOrigin` and survives rebases and device restoration.
[The rendered regression](test/clipmap-anchor.browser.mjs) checks a subpixel camera move across a clipmap boundary.
The clipmap lattice and seam treatment follow Frank Losasso and Hugues Hoppe,
[Geometry Clipmaps](https://hhoppe.com/geomclipmap.pdf) (2004), and Arul Asirvatham and Hugues Hoppe,
[Terrain Rendering Using GPU-Based Geometry Clipmaps](https://hhoppe.com/gpugcm.pdf) (2005).

Set `captureSurfaceHeight: true` when an object-placement pass needs the heights of the triangles on screen.
`terrain.surfaceHeightTexture` becomes available when the first frame prepares the terrain. The texture shares
the source heightmap's UVs and stores world metres in R. It refreshes on changes to the clipmap or source heights,
so call `terrain.invalidate()` after editing samples. The target is capped at 2,049 texels per side. It uses R32F
on WebGPU and the full compatibility tier, RGBA16F on the half-float tier. The LDR tier cannot render the float target.
[The height regression](test/surface-height.browser.mjs) checks a fine source peak that the coarse rendered triangles omit.
Each ring's 192-byte uniform (and each shadow cascade's and local shadow layer's copy) is uploaded only when its bits
differ from the last upload to that buffer, so a still camera under unchanged light uploads nothing; buffers made
after a device restore always get their first write.

```ts
import {EngineKernel} from 'margoengine/core';
import {Terrain} from 'margoengine/terrain';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const terrain = Terrain.attach(engine, {
  resolution:64, levels:6, cellSize:1, origin:[-50,-50], size:[100,100], heightScale:20,
  layers:[
    {height:[-20,100],slope:[0,0.3],scale:0.3},
    {height:[-20,100],slope:[0.2,1],scale:0.2},
    {height:[-20,2],slope:[0,0.4],scale:0.4},
    {height:[10,100],slope:[0,0.5],scale:0.2}
  ],
  textures:device=>{
    // 6 = TEXTURE_BINDING | COPY_DST. Replace these tiny demo maps with your assets.
    const heightmap = device.createTexture({size:[4,4],format:'r32float',usage:6});
    device.queue.writeTexture({texture:heightmap},new Float32Array(16),{bytesPerRow:16},[4,4]);
    const layers = device.createTexture({size:[1,1,4],format:'rgba8unorm-srgb',usage:6});
    device.queue.writeTexture({texture:layers},new Uint8Array([
      60,120,40,255, 110,110,100,255, 120,90,60,255, 240,245,255,255
    ]),{bytesPerRow:4,rowsPerImage:1},[1,1,4]);
    return {heightmap,layers};
  }
});
engine.start();
```

The texture factory runs at attachment and after device restoration. Terrain owns and destroys returned textures; recreate them from retained asset data. Height maps support `r32float`, `rgba16float`, or `rgba8unorm` (R channel); optional normal maps support `rgba8unorm` or `rgba16float`, with XYZ encoded in 0..1. Without a normal map, the vertex shader samples neighboring heights. Layer arrays support `rgba8unorm-srgb`, `rgba8unorm`, or `rgba16float` and must contain exactly as many layers as the rules. Supply mipmaps for real assets. `heightScale`/`heightOffset` map samples to world Y; origin/size define XZ texture coverage. The clipmap's outer rings reach past the map; nothing is drawn or casts a shadow there (fragments outside the origin/size rectangle are discarded in the colour, capture and shadow passes), so past the map's edge the sky or whatever lies behind shows, not a shelf of clamped edge heights. Checked on a real GPU by `test/edge.browser.mjs` (in `test:gpu`).

Optional painted weights: return `weights: [a, b]` from the factory, 2 to 4 `rgba8unorm` 2D textures over the same
bounds as the heightmap, one per 4 layers, so up to 16 layers (pass the same texture twice for up to 4 layers). Layer
i's weight is channel `i % 4` of texture `i / 4`, sampled bilinearly, and replaces the height and slope rules; each
rule's `scale` still sets that layer's texture repeat. A layer whose weight is 0 at a pixel skips its three triplanar
samples there, so 16 layers cost about what the ones that show do. This is how `@margoengine/biomes/view` draws biome ground layers. Without `weights` the shader, bind
group layout and draw calls are exactly as before (`examples/package-benchmarks/proofs/terrain-ssr.proof.js` checks the
whole call sequence). Update the textures with `queue.writeTexture` and call `terrain.invalidate()`.

Optional tint, with `weights` only: return `tint` from the factory, one `rgba8unorm` or `rgba8unorm-srgb` 2D texture of
any size over the heightmap's bounds, and set `tint: true` on the layers it should colour (plant cover, not rock). Each
such layer is mixed toward the texel's RGB by its A, in linear light, before relief and macro tone; other layers are
drawn as they are. `@margoengine/biomes/view` draws seasons this way. Without `tint` the shader, bindings and rules
are unchanged, whatever the layers say.

```ts
import { Terrain } from 'margoengine/terrain';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
// Your heightmap, layers and weights textures, as above; here small demo maps.
function make(device: GPUDevice) {
  const heightmap = device.createTexture({ size: [4, 4], format: 'r32float', usage: 6 });
  device.queue.writeTexture({ texture: heightmap }, new Float32Array(16), { bytesPerRow: 16 }, [4, 4]);
  const layers = device.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
  const colours = [60, 120, 40, 255, 110, 110, 100, 255, 120, 90, 60, 255, 240, 245, 255, 255];
  device.queue.writeTexture({ texture: layers }, new Uint8Array(colours), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, 4]);
  const weight = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 6 });
  device.queue.writeTexture({ texture: weight }, new Uint8Array([255, 0, 0, 0]), { bytesPerRow: 4 }, [1, 1]);
  return { heightmap, layers, weights: [weight, weight] };
}
Terrain.attach(engine, {
  size: [512, 512],
  layers: [0, 1, 2, 3].map((i) => ({ height: [-1e6, 1e6], slope: [0, 1], scale: 0.25, tint: i === 0 })),
  textures(device) {
    const tint = device.createTexture({
      size: [64, 64],
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // RGB: the colour to mix toward; A: how far (0 keeps the layer).
    device.queue.writeTexture({ texture: tint }, new Uint8Array(64 * 64 * 4).fill(200), { bytesPerRow: 256 }, [64, 64]);
    return { ...make(device), tint };
  },
});
```

Optional patches, with `weights` only: `patches: { size, contrast }` draws layers that share a texel as patches with
crisp edges instead of their average, the way an alpine slope is turf, scree and rock side by side rather than one
grey-brown felt from a kilometre off. Each layer with a weight above 0 adds `contrast` (0 to 1, default 0.6) times its
own value-noise fBm (cells of `size` metres, default 14, three octaves) to its weight, and only the layers within
0.05 x `contrast` of the highest sum keep weight (height-based splatting: Mishkinis 2013, "Advanced Terrain Texture
Splatting"; noise-masked splats as in Andersson 2007, "Terrain Rendering in Frostbite Using Procedural Shader
Splatting", SIGGRAPH; noise cells from the pcg3d hash of Jarzynski and Olano 2020, "Hash Functions for GPU Rendering",
JCGT 9(3); quintic fade of Perlin 2002, "Improving Noise"). Weights of 0 and 1 draw as painted (0 of 255 apart), octaves
finer than half a pixel fade to their mean, and as a pixel grows from 0.3 to 0.8 of a cell the patched weights hand
back to the painted ones, so far ground does not alias. On a 50/50 texel seen from 90 m, 84 percent of pixels are one
layer or the other ([patches.browser.mjs](test/patches.browser.mjs), RTX A6000, the same figures on WebGPU and the
WebGL2 layer); without the option the shader is unchanged. Cost: one noise of three octaves per shown layer per pixel.

```ts
import { Terrain } from 'margoengine/terrain';
import { Engine } from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
Terrain.attach(engine, {
  size: [512, 512],
  layers: [0, 1, 2, 3].map(() => ({ height: [-1e6, 1e6], slope: [0, 1], scale: 0.25 })),
  patches: { size: 18, contrast: 0.7 },
  textures(device) {
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    const heightmap = device.createTexture({ size: [2, 2], format: 'r32float', usage });
    device.queue.writeTexture({ texture: heightmap }, new Float32Array(4), { bytesPerRow: 8 }, [2, 2]);
    const layers = device.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage });
    const colours = [90, 100, 50, 255, 120, 115, 105, 255, 0, 0, 0, 255, 0, 0, 0, 255];
    device.queue.writeTexture({ texture: layers }, new Uint8Array(colours), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, 4]);
    // Turf and rock half and half everywhere: drawn as turf and rock patches.
    const weight = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage });
    device.queue.writeTexture({ texture: weight }, new Uint8Array([128, 127, 0, 0]), { bytesPerRow: 4 }, [1, 1]);
    return { heightmap, layers, weights: [weight, weight] };
  },
});
```

Patches of one cell size read as camouflage from the air. `warp` (0 to 1, default 0) displaces the patch noise by a
broader value noise, up to 1.1 `warp` cells each way, and adds an octave of 3.3 cells (domain distortion: Perlin 1985,
"An image synthesizer"; Ebert, Musgrave et al. 2003, "Texturing and Modeling", ch. 16), so patches come in clusters and
strands of several sizes. `terraces` (metres of height a cycle, 0 or 0.5 to 1,000, default 0) adds to each layer a sine
of the height with a wandering phase, shifted per layer, so patches stretch along the contours as turf banks and gravel
strips do, on slopes of about 10 to 35 degrees and in stretches that come and go; it fades where a cycle covers under
about 3 pixels. Both default to off, and then the shader is the one
above: `patches: { size: 23, contrast: 0.6, warp: 0.65, terraces: 3.5 }` is what the Above the Treeline film draws.

## Rock structure: `rock` and `TerrainTextures.structure`

A heightmap of 4 to 30 m cells draws a steep face as one smooth plane, which reads as grey felt from 100 m to 5 km.
`rock` adds the structure of bare rock at 10 to 100 m to the shading (the normal and the colour's tone; the heights do
not change):

- ledges: beds `strata` metres thick (default 9; 0 for none), tilted by `dip` (rise per metre along x and z, default
  [0, 0]) and wandering by noise, each a riser and a bench; the normal takes the bench's or the riser's slope
  analytically, a quarter of the face's on the top 30 percent of a bed and the rest on the riser, so the mean slope is
  the heightmap's (`ledges` 0 to 1, default 0.6). Ledges break off and come back along a bed;
- facets: jointed blocks `facets` metres across and 2.4 times as tall (default 18; 0 for none), ribs and columns as a
  steep joint set cuts them, and buttresses 4.1 times that, each tilting the
  normal by up to `relief` (0 to 1, default 0.45), with dark joints between them (Worley cells, one point anywhere in
  each cell, the nearest two of the 27 cells around). Each tilt blends into its neighbour's across the cell edge (by
  F2 - F1, over 0.14 of a cell plus two pixels), and relief, tone and joint shade fall to 0.3 as a block shrinks from
  about 170 to 25 pixels across, then to none, so blocks 200 to 600 m away do not read as low-poly shards;
- gullies, with `TerrainTextures.structure` (one `rgba8unorm` texture over the bounds): its R, drainage 0 to 1, is
  carved `gullies` metres deep (default 6) and darkened as wet, shaded rock, and its G is loose debris such as talus
  fans. `@margoengine/biomes/hydrology` `drainageStructure` makes both from a height grid;
- `debris`, with `weights`: the layer index that benches, gully floors below the faces and the debris fans take.

All of it fades in between `slope` degrees (default [28, 44]) and fades out where a pixel covers a good share of a
feature, so far ground keeps its mean. Seen at 50 degrees from 160 m, a plane of one grey layer goes from a tone spread
of 0.5 to 26 (8-bit standard deviation); from 2.5 km it is even again within 0.2 of its mean; a 10 degree slope draws
exactly as without; a drainage line changes the face by 0.89 on average and full debris turns every pixel to the debris
layer ([rock-structure.browser.mjs](test/rock-structure.browser.mjs), RTX A6000, the same figures on WebGPU and the
WebGL2 layer). Without the option the shader is unchanged. Cost: 54 hashes for the two facet scales, two noises for the
beds and five texel reads for the gullies per pixel. Sources: Benes and Forsbach 2001, "Layered data representation for
visual simulation of terrain erosion" (SCCG); Peytavie, Galin, Grosjean and Merillou 2009, "Arches: a framework for
modeling complex terrains" (Computer Graphics Forum 28(2)); Worley 1996, "A cellular texture basis function"
(SIGGRAPH); Jarzynski and Olano 2020, "Hash Functions for GPU Rendering" (JCGT 9(3)).

```ts
import { Terrain } from 'margoengine/terrain';
import { Engine } from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
Terrain.attach(engine, {
  size: [512, 512],
  layers: [0, 1, 2, 3].map(() => ({ height: [-1e6, 1e6], slope: [0, 1], scale: 0.25 })),
  rock: { strata: 8, facets: 20, debris: 1 },
  textures(device) {
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    // A 45 degree face rising along z.
    const heightmap = device.createTexture({ size: [2, 2], format: 'r32float', usage });
    device.queue.writeTexture({ texture: heightmap }, new Float32Array([0, 0, 512, 512]), { bytesPerRow: 8 }, [2, 2]);
    const layers = device.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage });
    const colours = [120, 115, 105, 255, 140, 125, 100, 255, 0, 0, 0, 255, 0, 0, 0, 255];
    device.queue.writeTexture({ texture: layers }, new Uint8Array(colours), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, 4]);
    const weight = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage });
    device.queue.writeTexture({ texture: weight }, new Uint8Array([255, 0, 0, 0]), { bytesPerRow: 4 }, [1, 1]);
    // No drainage, a little debris everywhere.
    const structure = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage });
    device.queue.writeTexture({ texture: structure }, new Uint8Array([0, 40, 0, 255]), { bytesPerRow: 4 }, [1, 1]);
    return { heightmap, layers, weights: [weight, weight], structure };
  },
});
```

## Sliders for the sand and ground look: `@margoengine/terrain/settings`

`TerrainColors` keeps its look (the colours, the height and slope ranges, the wet darkening and the sand surface's wind,
ripples, streaks, sorting and broad bands) in one small uniform, so any of it changes while the scene runs with
`colors.setLook(values)`: nothing is rebuilt, the next frame writes 176 bytes. `@margoengine/terrain/settings` lists those
controls as a table for sliders and panels: `TERRAIN_SETTINGS` has 24 rows (`name`, `group`, `kind`, `default`, `min`,
`max`, `step`, `unit`, `about` and `live`, which is true for every row), `applyTerrainSettings(colors, values)` writes a
set of values (a name left out takes its default) with one `setLook` call, and `TERRAIN_LOOKS` names four looks made only
of row values: `paleDesert`, `redDesert`, `volcanicBeach` and `saltFlat`. An unknown name throws `TypeError`, a value
outside its row's range `RangeError`, and `null` is accepted only on the rows that say `nullable`: the four height
ranges (null is the mesh's own range) and `sand.windDirection` (null leaves the wind to the weather drive).
`detail`, `variation`, `wetness` and whether `sandSurface` is on were compiled in at construction and are not rows; a
sand row on a `TerrainColors` built with `sandSurface: false` throws `TypeError`. Writing every live row each frame for 60
frames creates no pipeline, buffer or texture (`test/sand.browser.mjs`, native WebGPU and the WebGL2 layer), and the
defaults written draw exactly what a plain `TerrainColors` draws.

```ts
import {Engine} from 'margoengine/core';
import {TerrainColors, heightfield} from 'margoengine/terrain';
import {TERRAIN_LOOKS, applyTerrainSettings} from 'margoengine/terrain/settings';

const engine = await Engine.create(document.querySelector('canvas')!);
const ground = engine.createMesh().setGeometry(heightfield((x, z) => 0.3 * Math.sin(x * 0.2) * Math.cos(z * 0.2), {size: [128, 128], resolution: 128}));
const colors = TerrainColors.attach(engine, ground, {shore: [20, 30]});
applyTerrainSettings(colors, {...TERRAIN_LOOKS.paleDesert, 'sand.windDirection': 45});
// Key a row over a shot: the sand drifts from fine ripples to long scour bands.
let time = 0;
engine.onFrame((_, delta) => {
  time += delta;
  applyTerrainSettings(colors, {...TERRAIN_LOOKS.paleDesert, 'sand.windDirection': 45, 'sand.broad': Math.min(1, time / 10)});
});
engine.camera.position = [0, 1.7, -20];
engine.camera.target = [0, 0, 0];
```

## Relief and far detail: `bump` and `macro`

Past about 50 m a layer texture's mips average it to its mean colour, and the ground is lit by the vertex normal only,
so rock and snow read as flat grey. Two optional layer settings, each 0 to 1 (`RangeError` outside), keep them
readable:

- `bump` (default 0): the layer's own luma becomes a height of up to half a texture repeat per unit of luma, times
  `bump` (2 m at `scale` 0.25 for luma 0 to 1), and the shading normal follows its slope: derivative bump mapping from
  Mikkelsen's "Bump Mapping Unparametrized Surfaces on the GPU" (2010), screen-space derivatives of the height and the
  position. Where a pixel covers less than 1/128 of a repeat (3 cm at 0.25) the height is not read through the sampler:
  it is the layer's 128-texel mip through a cubic B-spline over exact texel loads, so a magnified layer draws no
  speckle, facets or lines along texel edges. The mips flatten it with distance, as they flatten the colour, and past a footprint
  of 1/64 of a repeat (6 cm at 0.25) its slope falls with the longer of the pixel's two sides on the ground, so distant or
  grazing ground draws no pixel grain.
- `macro` (default 0): the same layer at 1/24 of its `scale` (a 96 m repeat at 0.25) scales the colour by
  `1 - macro + macro * luma / mean`, where `mean` is the luma of the layer's top mip, so the average colour stays and far
  slopes keep a pattern. A much larger, smooth sample of the layer (about 318 m at 0.25, four mips below the top) adds
  slow variation and picks the repeat's offset, two offsets blended at a time (after Quilez's "Texture Repetition"), so
  the 96 m repeat never lines up into a grid. Give the layers texture a full mip chain for a true mean.

```ts
import {EngineKernel} from 'margoengine/core';
import {Terrain} from 'margoengine/terrain';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const terrain = Terrain.attach(engine, {
  size:[100,100], origin:[-50,-50], heightScale:20,
  layers:[
    {height:[-20,100],slope:[0,0.3],scale:0.25,bump:0.3,macro:0.35},
    {height:[-20,100],slope:[0.2,1],scale:0.25,bump:1,macro:0.5},
    {height:[-20,2],slope:[0,0.4],scale:0.25,bump:0.25,macro:0.3},
    {height:[10,100],slope:[0,0.5],scale:0.25,bump:0.35,macro:0.15}
  ],
  textures:device=>{
    // 6 = TEXTURE_BINDING | COPY_DST. Use real layer textures with full mip chains here.
    const heightmap = device.createTexture({size:[4,4],format:'r32float',usage:6});
    device.queue.writeTexture({texture:heightmap},new Float32Array(16),{bytesPerRow:16},[4,4]);
    const layers = device.createTexture({size:[1,1,4],format:'rgba8unorm-srgb',usage:6});
    device.queue.writeTexture({texture:layers},new Uint8Array([
      60,120,40,255, 110,110,100,255, 120,90,60,255, 240,245,255,255
    ]),{bytesPerRow:4,rowsPerImage:1},[1,1,4]);
    return {heightmap,layers};
  }
});
engine.start();
```

Leaving both out (or 0 on every layer) keeps the shader text, the 8-float rules and so every GPU call exactly as
before; when any layer sets one, the rules grow to 12 floats a layer and the shader adds the relief and the macro
sample for every layer whose value is above 0. This works with painted `weights` and SSR's capture. Cost: `bump`
adds about 30 ALU operations and four derivatives per pixel, and where a pixel covers less than 1/64 of a repeat, 16
texel loads for each showing layer and triplanar axis (one axis on most of the ground); `macro` adds, per showing layer, one top-mip sample and
three texture samples for each triplanar axis that shows (one axis on most of the ground, all three at most). Checked on
a real GPU by `test/bump.browser.mjs` (in `test:gpu`): on flat ground with one grey noise texture, 0 draws the same pixels
as leaving them out, `bump: 1` spreads the near ground's luma 4.3 times as wide, `macro: 0.5` spreads the means of 32 px
blocks of a view from 60 m 9 times as wide, and straight down from 1.5 km the luma at a 96 m lag correlates under 0.2
(RTX A6000).
Where a crest is seen edge-on, the relief's slope is limited to what the pixel can resolve, so crests draw no dark
specks: `test/crest.browser.mjs` (in `test:gpu`) draws alpine crests under the noon sun with `bump: 1` and counts
none more than without it, by rules and by painted weights. Seen from 2 m with a grey value a texel on the noise,
`bump: 0.35` draws a pixel contrast of 8.5 (28.9 with the height read texel by texel; RTX A6000, `test/bump.browser.mjs`).
The cubic basis is Sigg and Hadwiger, "Fast Third-Order Texture Filtering", GPU Gems 2, chapter 20, 2005,
https://developer.nvidia.com/gpugems/gpugems2/part-iii-high-quality-rendering/chapter-20-fast-third-order-texture-filtering

Resolution is a multiple of four from 8-256; levels range from 1-12. The default is 64 cells and six rings, with doubled cell spacing per level. Geometry buffers are allocated once and reused as the camera moves. Layer slope is `1-normal.y` in 0..1; height is world Y. Rules blend smoothly around their thresholds and fall back to layer zero if none match. Terrain uses GGX directional lighting and the scene's reversed depth.

`shadows.add(terrain,{static:true})` registers depth rendering and reception; moving clipmap origins invalidates its static shadow cache. `clustered.add(terrain)` adds local PBR lights. Call `terrain.invalidate()` after changing height texture contents. For picking, foot placement and game logic, ask `@margoengine/terrain/query` (below); rendering itself performs no GPU height readback. The clipmap does not add physics or streaming. `dispose()`/`destroy()` releases textures and geometry. `clipmapGrid()` is exported for custom grid consumers.

## Height and ray queries: `@margoengine/terrain/query`

`TerrainQuery` answers the height, the normal and a ray's first hit on the surface the clipmap's vertex shader samples
(bilinear between texels, texel 0 at `origin`, the last at `origin + size`, times `heightScale` plus `heightOffset`),
on the CPU, so picking, foot placement and game logic need no BVH of the ground. Build it from the heights you upload
(`new TerrainQuery(heights, columns, rows, terrain.options)`; it keeps the array, no copy), or read a live terrain's
heightmap back once with `await TerrainQuery.read(engine, terrain, {signal})` (the heightmap needs
`GPUTextureUsage.COPY_SRC`; `r32float`, `rgba16float` and `rgba8unorm` are read as the shader reads them).

```ts
import {Engine} from 'margoengine/core';
import {Terrain} from 'margoengine/terrain';
import {TerrainQuery} from 'margoengine/terrain/query';
const engine = await Engine.create(document.querySelector('canvas')!);
const columns = 65, heights = new Float32Array(columns * columns).map((_, i) => Math.sin(i % columns / 6) * 0.1);
const terrain = Terrain.attach(engine, {
  size: [128, 128], origin: [-64, -64], heightScale: 20,
  layers: Array.from({length: 4}, () => ({height: [-100, 100] as [number, number], slope: [0, 1] as [number, number], scale: 0.25})),
  textures(device) {
    const heightmap = device.createTexture({size: [columns, columns], format: 'r32float', usage: 6});
    device.queue.writeTexture({texture: heightmap}, heights, {bytesPerRow: columns * 4}, [columns, columns]);
    const layers = device.createTexture({size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6});
    device.queue.writeTexture({texture: layers}, new Uint8Array(16).fill(128), {bytesPerRow: 4, rowsPerImage: 1}, [1, 1, 4]);
    return {heightmap, layers};
  },
});
const ground = new TerrainQuery(heights, columns, columns, terrain.options);
const y = ground.height(10, -5);                       // world Y, or undefined outside the map
const up = ground.normal(10, -5);                      // unit shading normal, as the vertex shader works it out
const hit = ground.raycast([0, 50, 0], [0.2, -1, 0.1]); // {distance, position, normal} or null
console.log(y, up, hit?.position);
```

- `height(x, z)` is the bilinear height; `normal(x, z, out?)` uses the vertex shader's central differences one texel
  either way (a terrain with its own `normalmap` shades with that instead). Both return undefined outside the map's
  rectangle, where the terrain draws nothing.
- `raycast(origin, direction, maxDistance?, out?)` returns the first point where the ray meets the surface, from above or
  below, inside the map, or null. Each cell's bilinear patch is hit exactly (the height along a ray is quadratic in its
  distance), and an implicit min-max quadtree over the cells (Tevs, Ihrke and Seidel's maximum mipmaps, 2008) skips
  ground the ray passes over. The hit has `@margoengine/animator`'s `GroundHit` shape, so
  `raycast: (o, d) => ground.raycast(o, d)` plants a `FootIK` leg as it is; pass `out` to reuse one hit object.
- After changing `heights` in place (a sculpt, a crater), call `ground.refresh(x, z, width, depth)` over the changed
  samples; it rebuilds the tree there. Without it a raised cell is skipped.
- The clipmap draws the surface as triangles at its own cell spacing, morphing between rings, so a drawn point lies
  within that triangulation's error of the query's answer (none at texels the finest ring's vertices sit on).
- Memory: the heights you pass plus a min-max tree of two thirds of their count in floats (2.8 MB for a 1,025 x 1,025 map).
- `triangles({ step?, region? })` returns the surface as a world-space triangle mesh, `{ positions, normals, indices }`
  (xyz per vertex, three indices per triangle, counter-clockwise seen from above), for a path tracer
  (`@margoengine/voxel-pathtracer/from-engine` takes it as a `terrain` source), a collider or an export. Vertices sit on
  the height samples, every `step`-th each way (default 1; the last row and column are always kept), with the normals
  `normal` gives; `region` (world XZ `min` and `max`) is widened to whole cells and clipped to the heightmap; a cell whose
  centre lies in a hole is left out. Up to 16,777,216 vertices a call (RangeError past that: pass a larger step or a
  smaller region). Evidence: `test/query-triangles.test.js`.

```ts
import { TerrainQuery } from '@margoengine/terrain/query';

const heights = new Float32Array(65 * 65).map((_, i) => Math.sin(i * 0.01));
const ground = new TerrainQuery(heights, 65, 65, { origin: [-32, -32], size: [64, 64], heightScale: 4 });
const { positions, normals, indices } = ground.triangles({ step: 2, region: { min: [-16, -16], max: [16, 16] } });
console.log(positions.length / 3, normals.length / 3, indices.length / 3); // 289 289 512
```

Checked on the CPU by `test/query.test.js` (rays against a brute-force march, heights and normals against the shader's
formulas) and on a real GPU by `test/query.browser.mjs` (in `test:gpu`), on real elevation (the Mount Rainier tile in
`packages/shadows/test/fixtures`, 256 x 256 texels, 3.9 km of relief): `TerrainQuery.read` returns every texel as
uploaded (r32float and rgba8unorm exactly, rgba16float within half precision), the terrain's own WGSL `height` run on
the GPU at 3,584 points matches `height` to 2.6 mm, and 512 rays cast onto the mountain all hit, each within 2.3 mm of
the shader's height at the hit (Radeon 680M; the bound from float32 rounding is 4.9 mm).

## Full PBR layer materials: `@margoengine/terrain/layers-pbr`

`TerrainMaterials.attach(engine, terrain, options)` gives every layer its own normal map, ambient occlusion,
roughness and height, sampled triplanar at the layer's `scale` like its colour, so rock, mud and snow read as
materials up close. Its `textures` factory returns two 2D array textures with one layer per terrain layer
(`rgba8unorm` or `rgba16float`), made at attachment and again after device restoration:

- `normals`: tangent-space normals, XYZ encoded 0..1 with +Y up (the OpenGL convention, Poly Haven's `nor_gl`; flip
  green for a DirectX map).
- `surface`: R ambient occlusion, G roughness (glTF's ORM order, Poly Haven's `arm`), B unused, A height 0..1 (a
  `disp` map).

```ts
import {Engine} from 'margoengine/core';
import {Terrain} from 'margoengine/terrain';
import {TerrainMaterials} from 'margoengine/terrain/layers-pbr';
const engine = await Engine.create(document.querySelector('canvas')!);
// Four 1 x 1 layers here; use your layers' full-size, mipmapped maps.
function array(device: GPUDevice, rgba: number[]) {
  const texture = device.createTexture({size: [1, 1, 4], format: 'rgba8unorm', usage: 6});
  device.queue.writeTexture({texture}, new Uint8Array([...rgba, ...rgba, ...rgba, ...rgba]), {bytesPerRow: 4, rowsPerImage: 1}, [1, 1, 4]);
  return texture;
}
const terrain = Terrain.attach(engine, {
  size: [128, 128], origin: [-64, -64], heightScale: 20,
  layers: [0, 1, 2, 3].map(() => ({height: [-100, 100] as [number, number], slope: [0, 1] as [number, number], scale: 0.25})),
  textures(device) {
    const heightmap = device.createTexture({size: [2, 2], format: 'r32float', usage: 6});
    device.queue.writeTexture({texture: heightmap}, new Float32Array(4), {bytesPerRow: 8}, [2, 2]);
    const layers = device.createTexture({size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6});
    device.queue.writeTexture({texture: layers}, new Uint8Array(16).fill(150), {bytesPerRow: 4, rowsPerImage: 1}, [1, 1, 4]);
    return {heightmap, layers};
  },
});
TerrainMaterials.attach(engine, terrain, {
  heightBlend: 0.5,                              // 0 crossfades by weight; 1 lets the higher surface win
  layers: [{normal: 1, occlusion: 1, roughness: 1}], // per layer, the rest take these defaults
  textures: (device) => ({normals: array(device, [128, 128, 255, 255]), surface: array(device, [255, 230, 0, 128])}),
});
engine.start();
```

- Normals: each projection's tangent-space normal becomes the slope of a height over that projection's plane; the
  three are blended by the triplanar weights as one gradient and tilt the shading normal as a surface gradient
  (Mikkelsen's "Surface Gradient-Based Bump Mapping Framework", 2020), so cliffs need no tangents and the three
  projections agree. `normal` (0 to 2, default 1) scales the tilt. It stacks with `bump`.
- Roughness replaces the terrain's `roughness` per pixel, times the layer's `roughness` (0 to 2, default 1), clamped
  to 0.02..1; shadows and clustered lights use it and the tilted normal. AO, times `occlusion` (0 to 1, default 1),
  darkens the terrain's own ambient term only, not image-based light another effect adds.
- Height blending: where layers' weights overlap (rules or painted weights), each weight is scaled by
  2^(8 x `heightBlend` x (height - 1)), so stones stand out of mud and snow fills the hollows first (after Mishkinis,
  "Advanced Terrain Texture Splatting", 2013). `heightBlend: 0` keeps the terrain's own crossfade.
- Where no layer's rule applies (the terrain falls back to layer 0's colour) the vertex normal and the terrain's
  roughness are used. SSR's capture (`ssr.add(terrain)`) takes the blended colour but the terrain's own normal and
  roughness.
- Attach it before any effect that replaces the terrain's lit shader; it patches the layer loop and the fragment.
- Cost per pixel: each showing layer adds three samples of `surface` and up to three of `normals` (one triplanar axis
  on most ground, all three on cliffs); with height rules every layer's `surface` is sampled, with painted weights
  only those that show. About 40 ALU operations a layer more.

Checked on a real GPU by `test/layers-pbr.browser.mjs` (in `test:gpu`), on flat ground seen from above (Radeon 680M):
flat maps draw exactly the terrain's own pixels (0 of 255 apart) with rules, painted weights and `bump`; a normal tilted
toward +U lights the ground from +X (luma 146 against 62 from -X, the plain terrain 123 from both), one toward +V (green
up) from -Z; AO 0 removes the ambient light (151 to 0); roughness 0.1 draws the overhead sun's highlight (254 against
147); full height blending gives the highest of four equal layers the ground; and Poly Haven's CC0 Aerial Rocks 02 maps
(`test/fixtures/aerial-rocks-02`) give a low-sun close-up 1.6 times the luminance spread of its colour alone.

## Height streaming: `@margoengine/terrain/stream`

`TerrainStream.attach(engine, options)` makes a `Terrain` whose heightmap, and painted weights, stream in tiles around
the camera, so a world can be far bigger than one heightmap. The terrain draws a window of `window` x `window` tiles
(default 4) centred on the engine camera; `load(x, z, signal)` returns tile (x, z)'s heights (`tileTexels` squared
float32 samples, rows along +Z) and, with `weights: n`, its n weight byte arrays, or null where there is no data.
With `normals: true` each tile with data also gives `normals` (RGBA bytes, XYZ encoded `n * 0.5 + 0.5`), which the
terrain shades with in place of normals from its heights, so lighting keeps detail finer than the height samples; with
`tint: true` (and weights) a tile may give `tint` (sRGB RGBA bytes), which layers marked `tint: true` move toward by
its A, a draped photograph or a season map. Both stream, scroll and restore with the heights.

```ts
import {Engine} from 'margoengine/core';
import {TerrainStream} from 'margoengine/terrain/stream';
const engine = await Engine.create(document.querySelector('canvas')!);
const stream = TerrainStream.attach(engine, {
  tileSize: 256, tileTexels: 256, window: 4, heightScale: 1,   // 1 m texels; a 1,024 x 1,024 window
  layers: [0, 1, 2, 3].map(() => ({height: [-1e4, 1e4] as [number, number], slope: [0, 1] as [number, number], scale: 0.1})),
  colors(device) {
    const texture = device.createTexture({size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6});
    device.queue.writeTexture({texture}, new Uint8Array(16).fill(140), {bytesPerRow: 4, rowsPerImage: 1}, [1, 1, 4]);
    return texture;
  },
  async load(x, z, signal) {
    const response = await fetch(`/tiles/${x}/${z}.f32`, {signal});   // your tile server
    if (response.status === 404) return null;                       // no data there: the tile keeps `fill`
    if (!response.ok) throw new Error(`tile ${x},${z}: HTTP ${response.status}`); // retried, then failed
    return {heights: new Float32Array(await response.arrayBuffer())};
  },
  retries: 3,                                          // default 2; waits up to 250, 500, 1,000 ms (retryDelay)
});
engine.start();
addEventListener('online', () => stream.retry());     // failed tiles start over when the network comes back
await stream.ready();                                  // every tile of the first window is in
stream.onChange((change) => console.log(change));      // bands uploaded, or the window moved (`shifted`)
```

- The window moves a whole tile when the camera is more than 0.75 of a tile from its centre, so ground at least
  `(window / 2 - 0.75) * tileSize` from the camera on each axis is always in it; the terrain draws nothing past the
  window, as past any heightmap, unless `far` adds a coarser ring there (below). Tiles leaving it have their loads
  aborted (`signal`).
- No hitches: the kept texels scroll by two GPU texture copies through a scratch texture (no CPU upload), exposed
  tiles show `fill` (default 0) until they load, and loaded tiles go in as bands of rows within `budget` texels a frame
  (default 65,536), the nearest tile first, with `concurrency` loads in flight (default 4). This is the incremental
  clipmap update of Tanner, Migdal and Jones (1998) and Losasso and Hoppe (2004), scrolled instead of wrapped
  toroidally so the terrain's shader is unchanged.
- A tile's samples sit at the same world positions in every window (sample k of tile x at
  `origin + (x * tileTexels + k) * tileSize / tileTexels`), so the ground does not move when the window does; adjacent
  tiles share no samples and the surface is bilinear across their seam.
- `heights` and `weights` are the window's CPU copies, kept in place; `origin`, `tile` (the window's minimum tile) and
  `version` follow it. For queries, build `new TerrainQuery(stream.heights, stream.columns, stream.columns,
  stream.terrain.options)` and on each `onChange` refresh it over the band, or rebuild it when `shifted`.
- `ready(signal?)` resolves once the current window is all in (uploads go in as frames are drawn) and rejects with a
  tile's load error once its retries are spent; a failed tile keeps `fill` until it leaves the window or `retry()`
  starts it over. `options.signal` aborts every load. `dispose()` aborts the loads and disposes the terrain.
- Retries: a tile whose `load` rejects is loaded again up to `retries` times (0 to 16, default 2), retry k after a
  random wait up to `retryDelay * 2^k` ms (default 250, capped at 30 s): exponential backoff (Metcalfe and Boggs 1976)
  with full jitter (Brooker 2015), so tiles that failed together, or many clients after one outage, do not all ask
  again at once. An aborted load and a tile of the wrong shape (a bug in `load`, which a retry would repeat) are not
  retried. `retry()` starts every failed tile, and every one waiting for a retry, over at once with its full retries,
  and returns how many; a tile leaving the window drops its wait and its count.
  Sources: R. M. Metcalfe and D. R. Boggs, "Ethernet: Distributed Packet Switching for Local Computer Networks",
  Communications of the ACM 19(7), 1976, https://doi.org/10.1145/360248.360253 (binary exponential backoff); M.
  Brooker, "Exponential Backoff And Jitter", AWS Architecture Blog, 2015,
  https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/ (full jitter against synchronised retries).
- Memory: the window's heightmap, a scratch copy and the CPU copy, 4 bytes a texel each (12 MB at 1,024 x 1,024), plus
  twice 4 bytes a texel per weight texture, normal map and tint (the GPU texture and the CPU copy; `normals`, `tint`)
  and one shared 4-byte scratch. The window must fit the device's 2D texture limit.

Checked on a real GPU by `test/stream.browser.mjs` (in `test:gpu`) on nine adjacent Terrarium tiles around Mount
Rainier (`test/fixtures/terrarium-10`, Terrain Tiles on AWS), 256 x 256 each with weights made from their heights,
in a 2 x 2 window: through moves along +X, +Z, -X and -Z, a move inside the margin and teleports off the data and back,
the CPU copy, the GPU heightmap read back and the weights hold exactly the mosaic's texels for the expected tiles, the
streamed terrain draws exactly the pixels of a plain `Terrain` given that window whole, no frame uploads more than the
budget (16,384 texels: 17 frames for the first four tiles), and a stream disposed mid-load aborts it and rejects
`ready` with MargoError `'disposed'` (Radeon 680M). Retries (2026-11-27, RTX A6000): tiles failing twice each load on
their third try with two retries and their third try's heights are uploaded; with one retry `ready` rejects with the
last error after two tries a tile, `retry()` starts the four over and they load; a tile of the wrong shape is tried
once. Normals and tint (2026-11-27, RTX A6000): the same stops with a streamed normal map tilted away from the
heights' own normals and a red tint on every other tile; the CPU copies hold exactly the mosaic's texels and the
picture equals a plain `Terrain` given both whole, which a stream dropping either fails by 112 and 92 of 255. Cost
not timed.

### Past the window: `@margoengine/terrain/far`

`terrainFar(options)` draws coarser ground past the stream's window, out to the horizon you give it. It is a second
window of tiles, each `scale` times as wide (default 4) with as many samples, loaded by its own `load`, and the
terrain's heights blend from the near tiles into the far ones with distance from the camera. Pass it as `far`:

```ts
import {Engine} from 'margoengine/core';
import {terrainFar} from 'margoengine/terrain/far';
import {TerrainStream} from 'margoengine/terrain/stream';
const engine = await Engine.create(document.querySelector('canvas')!, {camera: {far: 20_000}});
// Level "near": 256 m tiles at 1 m. Level "far": 2,048 m tiles at 8 m, from the same server.
const tiles = (level: string) => async (x: number, z: number, signal: AbortSignal) => {
  const response = await fetch(`/tiles/${level}/${x}/${z}.f32`, {signal});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`tile ${level} ${x},${z}: HTTP ${response.status}`);
  return {heights: new Float32Array(await response.arrayBuffer())};
};
const far = terrainFar({scale: 8, load: tiles('far')});
const stream = TerrainStream.attach(engine, {
  tileSize: 256, tileTexels: 256, window: 4, heightScale: 1, load: tiles('near'), far,
  layers: [0, 1, 2, 3].map(() => ({height: [-1e4, 1e4] as [number, number], slope: [0, 1] as [number, number], scale: 0.1})),
  colors(device) {
    const texture = device.createTexture({size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6});
    device.queue.writeTexture({texture}, new Uint8Array(16).fill(140), {bytesPerRow: 4, rowsPerImage: 1}, [1, 1, 4]);
    return texture;
  },
});
engine.start();
await stream.ready();                    // both windows are in
console.log(far.detail, far.reach);      // 190 m of fine ground, 2544 m in all, each way from the camera
console.log(far.heightAt(900, -400));    // the height drawn there, near, far or between
```

| Option | Default | Meaning |
| --- | --- | --- |
| `load` | required | Loads far tile (x, z), which starts at the stream's `origin + [x, z] * scale * tileSize`; same tile shape as the near `load`. |
| `scale` | 4 | Far tile width in near tiles, 2 to 64. |
| `tileTexels` | the stream's | Samples per far tile side, 4 to 1,024. |
| `window` | the stream's | Far tiles per window side, even, 2 to 16. |
| `blend` | half a tile | World distance of the transition from near to far heights (at most half the near reach by default). |
| `fade` | 0.5 | Seconds a near tile takes to fade in over the far ground once uploaded. |

- Where each level shows, on each axis from the camera: the near heights alone up to `far.detail` =
  `(window / 2 - 0.75) * tileSize - 2 * tileSize / tileTexels - blend` (190 m above), the mix over the next `blend`
  metres, the far heights from there to `far.reach`, and nothing past it. Both edges are squares that move with the
  camera, not with the tiles, so nothing steps when a window moves; set the camera's `far` to see the whole ring.
- No cracks and no popping. The blend is part of the height function every vertex reads, so there are not two meshes to
  join: no seam, skirt or stitching. A near window gains and loses tiles only where the ground is already all far, and
  a far window only past `reach`. This is the transition region of a geometry clipmap (Losasso and Hoppe, "Geometry
  Clipmaps", SIGGRAPH 2004, https://hhoppe.com/geomclipmap.pdf; Asirvatham and Hoppe, GPU Gems 2 chapter 2, 2005)
  with two data levels; the mesh rings morph into each other as before (Strugar, CDLOD, Journal of Graphics Tools
  14(4), 2009, https://doi.org/10.1080/2151237X.2009.10129287).
- A near tile that is late, failed or without data (`null`) shows the far ground, ramped into its neighbours over half
  a tile or less, and fades in when it arrives. So fine data may cover only part of a world the far data covers whole.
- Far tiles carry what near tiles do: `weights` blend with the heights, as do `tint` and `normals` when streamed.
  Loads share `concurrency` and uploads share `budget`, the far ring first. `ready()` waits for both windows,
  `retry()` restarts both, and `far.tiles` has the far window's CPU copies, `origin`, `tile` and `onChange`.
- Mesh: `levels` defaults to enough rings to reach `far.reach` (12 at most; raise `cellSize` for a longer view).
  Colour, shadows, occlusion, screen-space reflections and `captureSurfaceHeight` all draw the blended ground.
  `TerrainQuery` over `stream.heights` matches it within `far.detail` over loaded tiles; `far.heightAt(x, z)`
  gives the drawn height anywhere. A far ring serves one stream at a time.
- Memory and cost: the far window takes what the near one does for its own size, plus one float per near tile; the
  vertex shader reads up to 4 per-tile weights and the far heights in the blend and the far zone. Not timed.

Checked on a real GPU by `test/far.browser.mjs` (RTX A6000, WebGPU and the WebGL2 compatibility layer, 2026-11-27),
with far heights set 40 m under the near ones so the blend shows: the drawn surface read back at every near sample
equals `far.heightAt` within 0.01 m (3.1e-5 m on WebGPU) when settled, around a missing and a failed tile, mid-fade and
after window moves; over a 360 m flight with eight window moves and tiles arriving late no point's height changed by
more than 1.34 m in a 1 m step (2.95 m allowed by the blend and the fade; a hard switch jumps 40 m), also under a
floating origin 100 km out; painted weights, tint and normals pass from the near tiles' to the far ones', ground is
drawn up to `reach` and not past it, and shadows and SSR draw it with no validation error, and a runtime virtual texture baked over it draws the same ground.

## Sculpt and paint brushes: `@margoengine/terrain/sculpt`

`await TerrainSculpt.attach(engine, terrain, options?)` adds GPU brushes to any terrain, for in-game editors and level
tools: `raise`, `lower`, `smooth`, `flatten` and `paint` (layer weights), with undo and redo. The heightmap must be
`r32float` and the weight textures (for `paint`) `rgba8unorm`, created with usage 15 (`TEXTURE_BINDING |
STORAGE_BINDING | COPY_SRC | COPY_DST`); attaching reads them back once into the CPU copies `heights` and `weights`.

```ts
import {Engine} from 'margoengine/core';
import {Terrain} from 'margoengine/terrain';
import {TerrainSculpt} from 'margoengine/terrain/sculpt';
import {TerrainQuery} from 'margoengine/terrain/query';
const engine = await Engine.create(document.querySelector('canvas')!);
const n = 257, heights = new Float32Array(n * n);
const terrain = Terrain.attach(engine, {
  size: [256, 256], origin: [-128, -128], heightScale: 1,
  layers: [0, 1, 2, 3].map(() => ({height: [-100, 100] as [number, number], slope: [0, 1] as [number, number], scale: 0.25})),
  textures(device) {
    const heightmap = device.createTexture({size: [n, n], format: 'r32float', usage: 15});
    device.queue.writeTexture({texture: heightmap}, heights, {bytesPerRow: n * 4}, [n, n]);
    const weight = device.createTexture({size: [n, n], format: 'rgba8unorm', usage: 15});
    device.queue.writeTexture({texture: weight}, new Uint8Array(n * n * 4).map((_, i) => (i % 4 ? 0 : 255)), {bytesPerRow: n * 4}, [n, n]);
    const layers = device.createTexture({size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6});
    device.queue.writeTexture({texture: layers}, new Uint8Array(16).fill(140), {bytesPerRow: 4, rowsPerImage: 1}, [1, 1, 4]);
    return {heightmap, layers, weights: [weight, weight]};
  },
});
const sculpt = await TerrainSculpt.attach(engine, terrain, {radius: 12, strength: 0.5});
const ground = new TerrainQuery(sculpt.heights, sculpt.columns, sculpt.rows, terrain.options);
sculpt.onChange((c) => { if (c.weights === undefined) ground.refresh(c.u, c.v, c.width, c.depth); });
{
  using stroke = sculpt.stroke({brush: 'raise', amount: 4});  // one undo step
  for (let x = -40; x <= 40; x += 4) sculpt.dab(x, 0);
}
sculpt.dab(0, 20, {brush: 'paint', layer: 2, radius: 16});   // a dab is a stroke of its own
sculpt.dab(10, 10, {brush: 'flatten', height: 2});
await sculpt.undo();                                          // the flatten
await sculpt.flush();                                         // heights and the query hold every finished stroke
console.log(ground.height(0, 0));
engine.start();
```

- Brushes: `raise` and `lower` move heights by `amount` world units (default a tenth of `radius`) times the brush
  weight; `smooth` moves them toward the 5 x 5 binomial blur of the ground under the brush (Burt and Adelson's
  [1 4 6 4 1] filter), `flatten` toward `height` (default the height under the stroke's first dab), `paint` the
  weights toward `layer` (the other layers fall, so the shares still add up). The weight is `strength` (0 to 1,
  default 0.5) times the falloff of the distance over `radius` (world units, default 8): `smooth` (default) is
  Wendland's (1 - t)^4 (4t + 1), `linear` and `constant` as named.
- Each dab is one compute pass over the texels under the brush (a copy with a 2 texel border is read, the terrain's
  texture written), on the GPU, at once; the terrain's shadow is invalidated.
- `stroke(options?)` groups dabs into one undo step (`using`, or call `end()`); `undoLimit` strokes are kept (default
  32), each as the changed rectangle's values before and after it, so `undo()` and `redo()` are exact. A new stroke
  clears the redo steps. Await `undo()` before the next dab.
- `heights` and `weights` follow the GPU when a stroke's rectangle has been read back (`await flush()`); `onChange`
  reports each rectangle they take, for a `TerrainQuery` built on `heights` (refresh it there).
- After device restoration the CPU copies, edits included, are written into the terrain's new textures.
- Memory: the CPU copies (4 bytes a texel each), the scratch copy of the largest dab, and per kept stroke its
  rectangle's values twice.

Checked on a real GPU by `test/sculpt.browser.mjs` (in `test:gpu`) on the Mount Rainier tile (256 x 256 texels 100 m
apart) with painted weights (Radeon 680M): raise, lower, smooth and flatten dabs match the brush formulas worked on the
CPU to 0.14 mm inside the brush and leave every texel outside it exactly as it was; a 30-dab smoothing stroke cuts the
ground's squared Laplacian there by 96%; full-strength paint sets the layer exactly and soft paint is within one 8-bit
step of the formula; after every stroke the CPU copy equals the GPU read back and a `TerrainQuery` refreshed from
`onChange` (height and a ray cast) answers the raised ground; undoing all 8 strokes gives back the original heightmap,
weights and picture exactly, and redoing them the edited ones; a heightmap without storage usage is refused. Cost not
timed.

## Holes and cutouts: `@margoengine/terrain/holes`

`TerrainTextures.holes` takes a mask over the heightmap's bounds (`r8unorm` or `rgba8unorm`, a texel per cell); where
its R is below 0.5 the terrain draws nothing, in its colour, SSR capture, shadow and occluder passes alike, so caves,
tunnels, basements and mine entrances pass through the ground and light falls through them. `TerrainHoles` makes and
edits that mask on the CPU, by cell centre: `circle`, `rect` and `polygon` (even-odd rule) cut, or fill with
`hole: false`; `texture(device)` makes the texture for the factory and `upload(terrain)` sends later cuts.
`TerrainQuery` takes the same mask as its `holes` option: no height or normal there, and rays pass through.

```ts
import {Engine} from 'margoengine/core';
import {Terrain} from 'margoengine/terrain';
import {TerrainHoles} from 'margoengine/terrain/holes';
import {TerrainQuery} from 'margoengine/terrain/query';
const engine = await Engine.create(document.querySelector('canvas')!);
const n = 129, heights = new Float32Array(n * n).fill(0.05);
const options = {size: [128, 128] as [number, number], origin: [-64, -64] as [number, number], heightScale: 20};
const holes = new TerrainHoles(options, n - 1);          // one mask cell per heightmap cell
holes.circle(10, -5, 6).polygon([[-30, 20], [-20, 20], [-25, 30]]);
const terrain = Terrain.attach(engine, {
  ...options,
  layers: [0, 1, 2, 3].map(() => ({height: [-100, 100] as [number, number], slope: [0, 1] as [number, number], scale: 0.25})),
  textures(device) {
    const heightmap = device.createTexture({size: [n, n], format: 'r32float', usage: 6});
    device.queue.writeTexture({texture: heightmap}, heights, {bytesPerRow: n * 4}, [n, n]);
    const layers = device.createTexture({size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6});
    device.queue.writeTexture({texture: layers}, new Uint8Array(16).fill(140), {bytesPerRow: 4, rowsPerImage: 1}, [1, 1, 4]);
    return {heightmap, layers, holes: holes.texture(device)};
  },
});
const ground = new TerrainQuery(heights, n, n, {...options, holes});
console.log(ground.height(10, -5));                       // undefined: a hole
holes.rect(30, 30, 40, 36);                               // a basement, cut later
holes.upload(terrain);
engine.start();
```

- A mask cell covers the bounds split evenly into the mask's width by height, so one per heightmap cell
  (`columns - 1` by `rows - 1`) cuts the ground cell by cell; any size works. Hole edges follow the cells, not the
  triangles, so a hole's rim is exact on the drawn surface.
- `TerrainQuery` reads the mask live (no refresh after a cut). A ray that meets a hole cell passes on to the next
  ground it meets; with a mask finer than the heightmap's cells, a cell hit inside a hole is skipped whole.
- Without `holes` every shader and binding is as it was. With it, one texel load and a compare a fragment in each
  pass; the mask binds after the weights and tint.

Checked on a real GPU by `test/holes.browser.mjs` (in `test:gpu`) on the Mount Rainier tile (Radeon 680M): a mask
with no hole draws exactly the terrain without one and a mask of all holes exactly no terrain, alone and with SSR on;
a 3 km crater shows the empty scene's pixels through it; a flat roof 50 m over flat ground, sun overhead, lets the
ground under its hole be lit exactly as with no roof, while a slanted sun shades the hole's far edge; an all-hole
occluder writes no depth; a cut sent with `upload` draws as one made before attaching. The node tests check the
bindings and that the colour, shadow and occluder shaders each declare and test the mask, and that queries skip holes.

## Erosion: `erode` from `@margoengine/biomes/erosion`

Weathered ground needs no terrain entry of its own: `erode(grid, options)` in `@margoengine/biomes/erosion` erodes
any height grid (integer millimetres, so the same heights and options give the same bytes on every machine): thermal
erosion slides material down slopes steeper than the angle of repose (`talus`, default 35 degrees) into scree, and
hydraulic erosion lets every cell's water run to an outlet, cutting gullies where a flow can carry more than it holds
and dropping the excess where its slope eases, in fans at the foot of slopes. It is deterministic: noise you generate
from a seed erodes to the same ground every time. Convert a terrain's heights to millimetres, erode, and upload:

```ts
import {Engine} from 'margoengine/core';
import {Terrain} from 'margoengine/terrain';
import {erode} from 'margoengine/biomes/erosion';
const engine = await Engine.create(document.querySelector('canvas')!);
const n = 129, size = 1280, heightScale = 400;          // 10 m cells, heights 0..1 times 400 m
let seed = 7;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const heights = new Float32Array(n * n).map((_, i) =>
  Math.max(0, 1 - Math.hypot(i % n - 64, Math.floor(i / n) - 64) / 50) + random() * 0.01);
const eroded = erode(
  {height: Int32Array.from(heights, (h) => Math.round(h * heightScale * 1000)), nx: n, nz: n, step: (size / (n - 1)) * 1000},
  {iterations: 64, talus: 35, capacity: 0.05},
);
const weathered = Float32Array.from(eroded.height, (mm) => mm / 1000 / heightScale);
Terrain.attach(engine, {
  size: [size, size], origin: [-size / 2, -size / 2], heightScale, cellSize: 5,
  layers: [0, 1, 2, 3].map(() => ({height: [-1e4, 1e4] as [number, number], slope: [0, 1] as [number, number], scale: 0.05})),
  textures(device) {
    const heightmap = device.createTexture({size: [n, n], format: 'r32float', usage: 6});
    device.queue.writeTexture({texture: heightmap}, weathered, {bytesPerRow: n * 4}, [n, n]);
    const layers = device.createTexture({size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6});
    device.queue.writeTexture({texture: layers}, new Uint8Array(16).fill(140), {bytesPerRow: 4, rowsPerImage: 1}, [1, 1, 4]);
    return {heightmap, layers};
  },
});
engine.start();
```

`eroded.wear` and `eroded.deposit` (mm a cell) make good painted weights: rock where it wore, gravel or mud where it
filled. On a 1.3 km cone of 10 m cells with seeded noise (run on the CPU, 2026-11-07): 64 rounds took the steepest
slope from tan 1.19 to 0.89 toward the talus slope's 0.70 (scree), hydraulic erosion alone (`thermal: 0, capacity:
0.05`) raised the relief across the slope (height spread around rings of the cone) from 0.86 m to 6.6 m (gullies), with the defaults the
foot of the cone took 6.4 m of deposit on average against 0.07 m on the far plain (fans), and two runs gave the same
bytes. It runs on the CPU (in a worker if you like); a GPU port would be a second erosion with float results that
differ by GPU.

## Runtime virtual texture: `@margoengine/terrain/rvt`

`TerrainVirtualTexture.attach(engine, terrain, options)` bakes the terrain's blended ground colour, with decals and
roads on top, into a cache around the camera: clipmap levels of `size` texels, the finest `texel` wide and each next
twice as coarse, addressed toroidally, so a camera move bakes only the rows and columns it exposes and a still frame
bakes nothing. The terrain's lit shader then reads its ground from the cache, one or two samples a pixel whatever the
number of layers and decals, and draws with its own shader only where the cache does not reach or the ground is
steeper than `steep` (the cache is baked top down). The coarsest level reaches `(size / 2 - 2) * texel *
2^(levels - 1)` along X or Z (1,632 m at 1,024 texels of 5 cm and 7 levels); the cache fades into the terrain's own
shader over the outer 29% of that reach (batch 132b, 2026-11-11: it used to fade from half the reach, so the outer half
of the coarsest level was baked and never read). `declarations(group, binding)` and `entries(binding)` let any
other material read the ground under it (`terrainVirtualColor(position, footprint)`), to blend a rock or a path into
the terrain.

```ts
import {Engine} from 'margoengine/core';
import {Terrain} from 'margoengine/terrain';
import {TerrainVirtualTexture} from 'margoengine/terrain/rvt';
const engine = await Engine.create(document.querySelector('canvas')!);
const n = 129, heights = new Float32Array(n * n).map((_, i) => 0.02 * Math.sin(i % n / 9) + 0.02 * Math.cos(i / n / 7));
const terrain = Terrain.attach(engine, {
  size: [512, 512], origin: [-256, -256], heightScale: 100,
  layers: [0, 1, 2, 3].map((i) => ({height: [-100 + i, 100] as [number, number], slope: [0, 1] as [number, number], scale: 0.25})),
  textures(device) {
    const heightmap = device.createTexture({size: [n, n], format: 'r32float', usage: 6});
    device.queue.writeTexture({texture: heightmap}, heights, {bytesPerRow: n * 4}, [n, n]);
    const layers = device.createTexture({size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6});
    device.queue.writeTexture({texture: layers}, new Uint8Array(16).fill(140), {bytesPerRow: 4, rowsPerImage: 1}, [1, 1, 4]);
    return {heightmap, layers};
  },
});
const ground = TerrainVirtualTexture.attach(engine, terrain, {
  texel: 0.05, size: 1024, levels: 6,
  decals(device) {                                        // layer 0 a puddle, layer 1 a road surface
    const pictures = device.createTexture({size: [1, 1, 2], format: 'rgba8unorm-srgb', usage: 6});
    device.queue.writeTexture({texture: pictures}, new Uint8Array([40, 50, 60, 200, 70, 70, 70, 255]),
      {bytesPerRow: 4, rowsPerImage: 1}, [1, 1, 2]);
    return pictures;
  },
});
ground.addDecal({center: [12, 30], size: [6, 4], angle: 0.3, layer: 0});
ground.road([[-40, 0], [0, 20], [50, 25]], 5, {layer: 1});
ground.invalidate(-20, -20, 20, 20);                      // after sculpting or painting there
engine.start();
```

On a Radeon 680M, on the real Mount Rainier tile under four layers of real rock (levels of 1,024 texels, 7 levels,
a 160 by 160 view, 2026-11-07): the cached ground drew within 0.33 of 255 of the terrain's own shader on average
(99th percentile 2, worst 5); a camera that moved there over four frames drew exactly what a cache made there drew, a
still frame baked nothing and a one-texel move baked one 1,024-texel strip; a 14 m decal laid later showed red on 240
pixels with no change more than 2 pixels from it, and removing it restored the picture exactly; a compute pass reading
through `declarations` and `entries` saw the decal's red at its centre and no coverage past the cache. Cost not timed.

- Memory: `size * size * levels` texels, 4 bytes each (`rgba8unorm-srgb`) or 8 (`rgba16float`): 24 MiB at the
  defaults. The first frame bakes every level whole; later frames bake the texels a move exposes plus invalidated
  areas.
- The cache holds colour only: not with `TerrainMaterials` (whose normals and roughness come from the layer loop it
  replaces); `bump` relief shows only where the terrain's own shader draws. SSR's capture keeps the terrain's own
  colour. Edits to heights, weights, tint or streamed tiles show after `invalidate(area)`.
- Decals (up to 4,096) are baked in the order added, each over its rectangle; a road is a decal a segment, so sharp
  bends leave a gap on their outer side.

## Near displacement and parallax: `@margoengine/terrain/displace`

`TerrainDisplacement.attach(engine, terrain, materials, options)` gives ground near the camera the depth of its layer
height maps (the `surface` maps' alpha that `TerrainMaterials` binds): each pixel within `distance` walks its view ray
down through the relief (parallax occlusion mapping), and the terrain shades the point the ray hits, so pebbles hide
the ground behind them and cracks look deep. With `shadows` (the default) the relief also shadows itself from the sun:
a ray from the hit toward the sun runs through a maximum mipmap of the height maps, passing over every square of the
map whose highest point stays under it, so no thin ridge is stepped over. A pixel that spans several texels of the
finest layer traces up to 4 by 4 such rays over its footprint and takes their mean, so far relief shows the share of
its area in sunlight rather than aliasing on whichever texel its centre lands. No geometry moves: the ground's outline
against the sky stays the clipmap's.

```ts
import {Engine} from 'margoengine/core';
import {Terrain} from 'margoengine/terrain';
import {TerrainMaterials} from 'margoengine/terrain/layers-pbr';
import {TerrainDisplacement} from 'margoengine/terrain/displace';
const engine = await Engine.create(document.querySelector('canvas')!);
// Four 2 x 2 layers here; use your layers' full-size maps (square, a power of two in size for shadows).
function array(device: GPUDevice, rgba: (i: number) => number[]) {
  const texture = device.createTexture({size: [2, 2, 4], format: 'rgba8unorm', usage: 6});
  const data = new Uint8Array(Array.from({length: 16}, (_, i) => rgba(i % 4)).flat());
  device.queue.writeTexture({texture}, data, {bytesPerRow: 8, rowsPerImage: 2}, [2, 2, 4]);
  return texture;
}
const terrain = Terrain.attach(engine, {
  size: [128, 128], origin: [-64, -64], heightScale: 20,
  layers: [0, 1, 2, 3].map(() => ({height: [-100, 100] as [number, number], slope: [0, 1] as [number, number], scale: 0.5})),
  textures(device) {
    const heightmap = device.createTexture({size: [2, 2], format: 'r32float', usage: 6});
    device.queue.writeTexture({texture: heightmap}, new Float32Array(4), {bytesPerRow: 8}, [2, 2]);
    const layers = device.createTexture({size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6});
    device.queue.writeTexture({texture: layers}, new Uint8Array(16).fill(150), {bytesPerRow: 4, rowsPerImage: 1}, [1, 1, 4]);
    return {heightmap, layers};
  },
});
const materials = TerrainMaterials.attach(engine, terrain, {
  textures: (device) => ({
    normals: array(device, () => [128, 128, 255, 255]),
    surface: array(device, (texel) => [255, 230, 0, texel === 0 ? 255 : 40]), // one raised stone in four
  }),
});
TerrainDisplacement.attach(engine, terrain, materials, {
  depth: 0.05,          // world depth from height 1 to 0 (per layer: layers: [{depth}])
  distance: 30,         // shown within 30 m, fading over the last quarter
  steps: 24,            // most view-ray steps a pixel takes
  shadows: true,
});
engine.start();
```

Checked on a real GPU by `test/displace.browser.mjs` (in `test:gpu`), on Poly Haven's CC0 Aerial Rocks 02 maps (one
4 m repeat of 1,024 texels, Radeon 680M, 2026-11-08): seen from 0.35 m at a slant with 10 cm of relief, the parallax
picture was 3.07 of 255 from the same rock built as real geometry (a terrain whose heightmap is the displacement map,
on a 4 mm clipmap), the flat one 24.5; depth 0 and a reach short of the view drew the flat picture exactly; painted
weights drew the same rock. Seen from straight above under a 14 degree sun, with white, flat materials and no ambient
light, the share of the ground in shadow was 2.71% against 2.76% from a CPU trace of the same relief at 10 cm deep, and
30.7% against 30.85% at 30 cm; the shadowed pixels overlapped the CPU's by 0.57 and 0.56 (union), the rest being
texels finer than a pixel. There a pixel spans about 6.7 texels; against the share of each pixel's area a CPU trace
finds lit (4 by 4 traces a pixel), the mean per-pixel error is 0.109 at 30 cm and 0.0125 at 10 cm (one ray from the
pixel's centre: 0.176 and 0.024). Cost not timed.

- Relief: the layers' heights blended by the terrain's weights with the materials' `heightBlend`, from the top
  projection only, on ground no steeper than about 57 degrees (fading out from about 32); cliffs stay flat. The view
  ray reads the height maps' mipmaps at the pixel's footprint; the shadow ray reads the full-size map.
- Shadows: soft over about 1.1 degrees either side of the relief's horizon; a ray takes at most 160 steps through the
  mipmap (squares passed over, descended into or tested) and counts what it has not reached as lit. Where layers of
  different `scale` overlap, the mipmap of the finest decides the squares and the coarser ones are bounded by up to
  four of their own texels. They need square surface maps a power of two in size (`'unsupported'` otherwise; pass
  `shadows: false`) and add an `r32float` maximum mipmap: 4 bytes a texel a layer plus a third, about 21 MiB for four
  1,024-texel layers.
- Attach it after `TerrainMaterials`, before any effect that replaces the terrain's lit shader. `shadows` darkens the
  sun's light only, not ambient or image-based light.
- Shadow maps: with `@margoengine/shadows` (`Shadows` or `VirtualShadows`, attached before or after the displacement)
  objects' sun shadows fall on the relief. The maps hold the clipmap surface, the relief's top, so each point reads
  them where its ray toward the sun leaves that surface: the relief is not shadowed by its own ground (checked on a
  real GPU by `test/displace-shadows.browser.mjs`: none of the lit relief darkened; before, 95.2% did), and an object
  sitting within the relief's depth does not shadow it. The relief casts no shadow onto other objects.

## Wind-built dunes: `@margoengine/terrain/dunes`

`duneField(options)` returns the heights of a dune field (a `Float32Array`, `width` heights a row, `depth` rows, in
metres) to feed a `Terrain` heightmap or a `BiomeWorld`'s `height.samples`. Each dune has a long gentle windward side
whose steepest slope is `stoss` and a short slip face at the angle of repose `lee`, the profile measured on real
dunes: a 5 m dune is about 37 m from its windward toe to the crest and 8 m from the crest to the foot of its face.
`transverse` lays ridges across the wind every `spacing` metres, their crests wandering and varying in height
(`irregularity`); a ridge too high for its spacing is lowered so it fits. `barchan` lays isolated crescents, about 11
heights wide, with their horns trailing downwind and some cells left bare where sand is short. `base` builds the dunes on
ground you already have (real heights, a beach), and `amount(x, z)` (0 to 1) keeps them off wet sand or a launch flat.

```ts
import {duneField, duneLengths, slopeAt} from 'margoengine/terrain/dunes';
const heights = duneField({width: 256, depth: 256, cellSize: 1, type: 'transverse', height: 5, spacing: 70, wind: 90, seed: 2});
console.log(heights.length, duneLengths(5).stoss.toFixed(1), slopeAt(heights, 256, 128, 128).toFixed(1)); // 65536 37.0 ...
```

| Option | Default | Meaning |
| --- | --- | --- |
| `width`, `depth` | required | heights along x and z (2 or more each, at most 67,108,864 in all) |
| `cellSize` | 1 | metres between heights |
| `origin` | [0, 0] | world x and z of the first height |
| `wind` | 90 | degrees from +x toward +z that the wind blows toward; slip faces face downwind |
| `type` | `'transverse'` | `'transverse'` ridges (plenty of sand) or `'barchan'` crescents (scarce sand), Werner 1995 |
| `height` | 4 | crest height in metres |
| `spacing` | 70 | crest-to-crest spacing (transverse) or the cell each barchan stands in, metres |
| `stoss` | 12 | steepest windward slope, 3 to 20 degrees |
| `lee` | 32 | slip face, the angle of repose of dry sand, 25 to 36 degrees |
| `irregularity` | 0.35 | 0 to 1: crest wander, height variation, bare cells and low hummocks between dunes |
| `seed` | 1 | the same seed gives the same heights on every machine |
| `base` | flat 0 | heights to build on, the grid's layout (not changed) |
| `amount` | 1 | `(x, z) => 0..1`, the share of dune height at each point |
| `round` | 0 | metres over which each brink is rounded; 0 keeps a sharp brink |

`duneHill(x, z, {crest, height, wind, halfWidth, stoss, lee, round})` is the height of one big isolated dune, such as
a coastal hill built by one main wind: a long windward side at `stoss` (default 12 degrees), a crest rounded over
`round` metres (default a third of the height), a lee face at `lee` (default 30 degrees, a settled face) and a crest
that falls off as a raised cosine to `halfWidth` across the wind (default 5 heights). Add it to a field or to real
heights:

```ts
import {duneHill} from 'margoengine/terrain/dunes';
const hill = {crest: [0, 0] as [number, number], height: 30, wind: 90, stoss: 12, lee: 30};
console.log(duneHill(0, 0, hill).toFixed(1), duneHill(0, -100, hill).toFixed(1), duneHill(0, 40, hill).toFixed(1)); // crest, windward, lee
```

`duneProfile(p, height, tanStoss, tanLee, toe, round)` is one dune's height `p` metres downwind of its windward toe, `duneLengths`
its windward and lee lengths, `barchan(u, v, height, tanStoss, tanLee)` one crescent around its crest, and
`slopeAt(heights, width, i, j, cellSize)` the steepest slope at a height in degrees. Aeolian ripples (5 to 20 cm,
Anderson 1987) are far finer than a terrain cell and belong in the sand material's relief, not the height field. Plain
JavaScript with no GPU and no dependency; the dunes do not move (no saltation or avalanche simulation in v1.0.0,
docs/limits.md).

Sources: Bagnold 1941, *The Physics of Blown Sand and Desert Dunes* (London, 1941), slip faces at the angle of repose;
Sauermann, Kroy and Herrmann 2001, "Continuum saltation model for sand dunes", Phys. Rev. E 64, 031305
(https://doi.org/10.1103/PhysRevE.64.031305), and Kroy, Sauermann and Herrmann 2002, "Minimal model for sand dunes", Phys.
Rev. Lett. 88, 054301 (https://doi.org/10.1103/PhysRevLett.88.054301), the convex windward profile and the brink at the
crest; Hersen, Douady and Andreotti 2002, "Relevant length scale of barchan dunes", Phys. Rev. Lett. 89, 264301
(https://doi.org/10.1103/PhysRevLett.89.264301), barchan width in proportion to height; Andreotti, Claudin and Douady 2002,
"Selection of dune shapes and velocities", Eur. Phys. J. B 28, 321 (https://doi.org/10.1140/epjb/e2002-00236-4), sinuous
crests; Werner 1995, "Eolian dunes: computer simulations and attractor interpretation", Geology 23(12), 1107
(https://doi.org/10.1130/0091-7613(1995)023<1107:EDCSAA>2.3.CO;2), ridges against crescents by sand supply; Anderson 1987,
"A theoretical model for aeolian impact ripples", Sedimentology 34, 943 (https://doi.org/10.1111/j.1365-3091.1987.tb00814.x).

## Wind scour and shadow dunes: `@margoengine/terrain/scour`

`windScour(options)` is the change of ground height that wind leaves on sand round obstacles. `change(x, z)` returns
metres to add to your ground, and `bounds` the rectangles outside which it is 0:

- round a **building**, a scour moat along the windward wall and flanks (deepest at the windward corners), a deposit
  horseshoe whose crest stands 0.65 building heights upwind, and two tails past the flanks that run `tail` times
  B = w^(2/3) h^(1/3) past the leeward wall (w the width across the wind, h the height);
- behind a **plant** or other small porous obstacle, a pyramidal shadow dune: half the obstacle's width times the side
  slope high, its length shorter in a stronger wind.

Nothing changes at a building's walls (it stays on the ground it stood on), at or below `threshold`, or far from every
obstacle. A shed's moat is about 1.4 m wide, finer than most ground cells, so `refinedHeightfieldGeometry` builds the
ground with the cells that touch `regions` split `subdivide` times a side. The split cells lie on the coarse triangles
(grass placed on the coarse grid still stands on the mesh) until `add` moves them, and the mesh has no cracks.

```ts
import {refinedHeightfieldGeometry, windScour} from 'margoengine/terrain/scour';
const wind = windScour({
  wind: 90, speed: 11,
  buildings: [{center: [0, 0], size: [12, 5], height: 3}],
  plants: [{center: [14, 6], width: 1}],
});
const data = refinedHeightfieldGeometry((x, z) => 0.02 * x, {size: [200, 200], resolution: 100, regions: wind.bounds, add: wind.change});
console.log(wind.change(0, -3.3).toFixed(2), wind.change(0, -4.5).toFixed(2), data.indices.length / 3); // moat, horseshoe, triangles
```

| `windScour` option | Default | Meaning |
| --- | --- | --- |
| `buildings` | none | `{center, size, height, yaw}`: footprint middle (x, z), its x and z extents, ridge height, turn about +y in radians |
| `plants` | none | `{center, width}`: obstacles that grow a shadow dune |
| `wind` | 90 | degrees from +x toward +z that the wind blows toward, as `duneField` |
| `speed` | 11 | wind speed at 10 m, m/s |
| `threshold` | 6.6 | m/s at or below which nothing changes (0.25 mm sand); the forms are full from 1.3 times it |
| `scour` | 0.06 | moat depth as a share of the building's height, 0 to 0.075 |
| `deposit` | 0.07 | horseshoe and tail height as a share of the building's height, 0 to 0.3 |
| `tail` | 3 | tail length past the leeward wall in units of B, 0.5 to 8 |
| `slope` | 20 | side slope of a shadow dune, 5 to 32 degrees |

| `refinedHeightfieldGeometry` option | Default | Meaning |
| --- | --- | --- |
| `size`, `origin`, `resolution` | as `heightfieldGeometry` | the coarse grid |
| `regions` | required | `[minX, minZ, maxX, maxZ]` rectangles whose cells are split |
| `subdivide` | 5 | splits per cell side, 1 to 16 |
| `add` | none | `(x, z) =>` metres added at every vertex |

`scourScale(width, height)` is B, and `shadowDuneLength(width, speed)` a shadow dune's length. Plain JavaScript with no
GPU. The papers give where the forms stand, how long they are and the shadow dune's shape; the moat and ridge depths and
their cross profiles are Margo's choices (the options above). One steady wind direction, no change over time, sand not
conserved between moat and deposits, and no scour round open structures such as rails or posts (docs/limits.md).

Sources: Hunt, Abell, Peterka and Woo 1978, "Kinematical studies of the flows around free or surface-mounted obstacles",
J. Fluid Mech. 86, 179 (https://doi.org/10.1017/S0022112078001068), the horseshoe vortex; Tominaga, Okaze and Mochida
2018, J. Wind Eng. Ind. Aerodyn. 182, 262 (https://doi.org/10.1016/j.jweia.2018.09.008), erosion at the windward
corners; Poppema, Wijnberg, Mulder, Vos and Hulscher 2021, Coastal Engineering 168, 103866
(https://doi.org/10.1016/j.coastaleng.2021.103866), the length scale B; the upwind deposit distance of Thiis and Gjessing
1999 as reported in D. Poppema, University of Twente report 2020R-001-WEM-001
(https://ris.utwente.nl/ws/portalfiles/portal/168667961/2020R_001_WEM_001_Daan_Poppema.pdf); Hesp 1981, "The formation of
shadow dunes", J. Sed. Petrology 51, 101 (https://doi.org/10.1306/212F7C1B-2B24-11D7-8648000102C1865D), its height
rule as given by Hesp and Smyth 2017, "Nebkha flow dynamics and shadow dune formation", Geomorphology 282, 27
(https://doi.org/10.1016/j.geomorph.2016.12.026; accepted manuscript https://hira.hope.ac.uk/1824/), which gives the
lengths.

## Stored height grids: `@margoengine/terrain/height-grid`

`gridHeightField(options)` turns a height grid you already have (a USGS 3DEP or SRTM tile read from a GeoTIFF, a decoded
heightmap, any row-major numbers) into the `(x, z) => height` function that `heightfield`, `heightfieldGeometry` and
`TerrainHeightmap` take. It reads bilinearly between texels over the grid's real ground size, holds the edge heights
outside the box, and fills missing samples (NaN, or the file's no-data value such as -32768 or -999999) before the first
read. The function also carries `min`, `max`, `origin`, `size` and `filled` (how many samples were missing).

```ts
import {heightfield} from 'margoengine/terrain';
import {gridHeightField} from 'margoengine/terrain/height-grid';
const heights = new Float32Array([0, 1, 0, 1, 2, -999999, 0, 1, 0]); // 3 by 3, one missing sample
const ground = gridHeightField({width: 3, height: 3, heights, size: [300, 300], noData: -999999, exaggeration: 1.5});
console.log(ground(0, 0), ground.max, ground.filled); // 3 3 1
const mesh = heightfield(ground, {size: [300, 300], resolution: 96});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `width`, `height` | required | texels across x and down z, integers 2 to 65,536 |
| `heights` | required | `width * height` numbers, row-major; row 0 at the minimum z (the north edge of a north-up raster when north is -z), copied once |
| `size` | required | real ground extent `[x, z]`, each above 0 to 100,000 |
| `origin` | centred on 0 | world x and z of the minimum corner |
| `exaggeration` | 1 | vertical scale applied to the samples |
| `base` | 0 | added to every height after `exaggeration` |
| `noData` | none | a sample value that means no data (compared as float32); NaN always does |
| `fill` | `'nearest'` | what a missing sample becomes: a number (world height), `'nearest'` valid texel over the eight neighbours, `'min'` or `'mean'` of the valid heights; a grid with no valid sample needs a number |
| `registration` | `'point'` | `'point'`: texel (0, 0) at the corner and the last at `origin + size`, as `Terrain` and `TerrainQuery` read heights; `'area'`: texels are cells centred half a cell in (GeoTIFF PixelIsArea) |
| `flipRows` | false | row 0 at the maximum z (a south-up grid) |

Sources: bilinear interpolation, W. Press and others, Numerical Recipes, 3rd ed., 2007, section 3.6; no-data values,
the GDAL raster data model (https://gdal.org/user/raster_data_model.html); PixelIsArea and PixelIsPoint, OGC GeoTIFF
standard 1.1 (OGC 19-008r4); the nearest-valid sweep, A. Rosenfeld and J. Pfaltz, "Sequential operations in digital
picture processing", Journal of the ACM 13(4), 1966. Our own code from those descriptions.

## Footprints, tracks and trails: `@margoengine/terrain/deform`

`TerrainDeformation.attach(engine, terrain, options)` presses footprints, tyre tracks and trails into snow, mud and sand.
Prints go into a deformation map of `size` texels a side, `texel` wide each, centred on the camera (or on what
`follow` returns) and moved with it a texel at a time, so prints stay while they are within half its width; the
ground pushed aside rises in a rim around each print; prints fill back in over `fade` seconds. The terrain's lit shader
walks each near pixel's view ray down through the prints (parallax occlusion mapping) and shades the ground it meets,
with the print's slope as its normal and darkened where it is pressed, so a footprint shows its walls and hides its far
floor. No vertex moves: clipmap cells are far wider than a footprint.

```ts
import {Engine} from 'margoengine/core';
import {Terrain} from 'margoengine/terrain';
import {TerrainDeformation} from 'margoengine/terrain/deform';
const engine = await Engine.create(document.querySelector('canvas')!);
const terrain = Terrain.attach(engine, {
  size: [256, 256], origin: [-128, -128], heightScale: 10,
  layers: [0, 1, 2, 3].map(() => ({height: [-100, 100] as [number, number], slope: [0, 1] as [number, number], scale: 0.5})),
  textures(device) {
    const heightmap = device.createTexture({size: [2, 2], format: 'r32float', usage: 6});
    device.queue.writeTexture({texture: heightmap}, new Float32Array(4), {bytesPerRow: 8}, [2, 2]);
    const layers = device.createTexture({size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6});
    device.queue.writeTexture({texture: layers}, new Uint8Array(16).fill(230), {bytesPerRow: 4, rowsPerImage: 1}, [1, 1, 4]);
    return {heightmap, layers};
  },
});
const snow = TerrainDeformation.attach(engine, terrain, {
  depth: 0.15,     // deepest print, and a print's depth by default
  fade: 120,       // seconds for a full-depth print to fill back in; 0 keeps prints
  rim: 0.25,       // the rim's height as a share of the print's depth
});
for (let step = 0; step < 10; step++)                     // a walk along +X, left and right feet
  snow.footprint(step * 0.35, step % 2 ? 0.12 : -0.12, {angle: 0, depth: 0.08});
snow.track([-5, 2], [5, 2.5], {width: 0.22});              // a tyre
snow.trail([[0, -3], [1, -3.5], [2, -3.2]], {width: 0.5, depth: 0.04});  // a sledge
engine.start();
```

**Ground meshes, walking and kept prints.** `TerrainDeformation.attach(engine, mesh, options)` shades a ground mesh
drawn by core's standard shader the same way, over `TerrainColors` if it has them (attach it after them): the print
darkens their colour, takes its own slope as normal and presses their ripples flat. `walk(points, options)` lays the
footprints of someone walking through the points: left and right in turn, a heel and a forefoot each, `step` 0.75 m,
`straddle` 0.08 m between the feet's lines, `toeOut` 0.12 radians, feet `length` 0.28 by `width` 0.11 m, unevenly by
`jitter` 0.5 from `seed` 1 (the means of Murray, Drought and Kory, J. Bone Joint Surg. 46-A, 1964, a little shorter
for loose ground). `persist: true` keeps every print: one the map leaves is pressed again when the map returns (needs
`fade` 0, its default then; at most 16,384 prints and track pieces). Real-GPU check, WebGPU and the WebGL2 layer:
`node packages/terrain/test/deform-mesh.browser.mjs`.

```ts
import {Engine, PbrMaterial} from 'margoengine/core';
import {heightfield, TerrainColors} from 'margoengine/terrain';
import {TerrainDeformation} from 'margoengine/terrain/deform';

const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: {position: [0, 1.6, 4], target: [0, 0, -2]},
});
const ground = engine
  .createMesh()
  .setGeometry(heightfield((x, z) => 0.1 * Math.sin(x / 3) * Math.cos(z / 4), {size: [40, 40]}))
  .setMaterial(new PbrMaterial({color: [0.52, 0.46, 0.35], roughness: 0.92}));
TerrainColors.attach(engine, ground, {sand: [0.52, 0.46, 0.35], shore: [80, 90]});
const prints = TerrainDeformation.attach(engine, ground, {depth: 0.045, darken: 0.22, persist: true});
prints.walk([[0.5, 3], [-0.5, -2], [1.5, -8]], {seed: 7});
engine.start();
```

- A print is pressed on the GPU at the next frame: a footprint is an ellipse (`length` 0.28 and `width` 0.11 by
  default, turned by `angle`), a track a band of `width` with round ends; the full depth reaches 55% of the way to
  the edge and falls smoothly to 0 there, and the rim peaks at 1.2 times the half size. Each texel keeps the deepest
  print over it. With painted `weights`, `layers` gives each layer's softness (rock 0 takes no print).
- Defaults: `size` 1,024 texels of 2.5 cm (25.6 m), `depth` 0.15, `rim` 0.25, `fade` 120, `darken` 0.25,
  `distance` 40 (prints shown within, fading over the last quarter), `steps` 12.
- Memory: 16 bytes a texel (the depths and rims, and the `rgba16float` relief `texture`): 16 MiB at the defaults.
  A frame with a print, a move or `fade` runs a compute pass over the map; a still frame with `fade: 0` runs none.
- Prints the window leaves are gone when it comes back; device loss clears every print. The terrain's geometry,
  shadows and SSR capture do not see prints. Attach it after the terrain's other effects.

Checked on a real GPU by `test/deform.browser.mjs` (in `test:gpu`, Radeon 680M, 2026-11-08): a footprint and a track
read back from the GPU are the profile above worked on the CPU to 0.06 mm (half-float storage) and its slopes to 0.1%;
nothing pressed draws exactly the picture without deformation; seen from 0.6 m under a slanted sun, the deformed picture
is 6.6 of 255 on average from the same prints built as real geometry (a terrain on a 4 mm clipmap whose heightmap is the
read-back relief), the flat picture 33.3; a print fills back in by `depth / fade` a second of frame time (0.075, 0.050
and 0 deep after 0.5, 1 and 2 s at 0.05 m a second); a 2 m move keeps it, a 12 m one clears it; a painted layer of
softness 0 takes none. Cost not timed.

## Ground that changes on screen: `@margoengine/terrain/ground-change`

`GroundChange.attach(engine, mesh, options)` changes a heightfield mesh's ground over film time: gullies cut back from
their mouths, river banks retreat, scour holes deepen, slopes fail and run out, a flood leaves mud that dries, ash falls
from a vent, lava flows and cools, and fire leaves a burn scar that whitens. Each event is a closed form of film time,
so the ground at a time is the same whether a film is rendered in order, seeked to that time or rendered again. Each
frame whose time moved recomputes only the vertices the active events can touch, writes their heights and normals into
the mesh's own vertex buffer (so shadows and every other pass see the new shape) and lays the covers over the mesh's
colour (after `TerrainColors`, if attached), with lava's glow added to its light.

```ts
import {Engine, PbrMaterial} from 'margoengine/core';
import {heightfieldGeometry, TerrainColors} from 'margoengine/terrain';
import {toGeometry} from 'margoengine/geometry/utils';
import {GroundChange} from 'margoengine/terrain/ground-change';
import {applyGroundChangeSettings} from 'margoengine/terrain/ground-change-settings';
const engine = await Engine.create(document.querySelector('canvas')!);
const grid = {size: [400, 400] as [number, number], origin: [-200, -200] as [number, number], resolution: 512};
const hills = (x: number, z: number) => 0.05 * z + 4 * Math.sin(x * 0.02) * Math.cos(z * 0.015);
const ground = engine.createMesh()
  .setGeometry(toGeometry(heightfieldGeometry(hills, grid)))
  .setMaterial(new PbrMaterial({color: [0.3, 0.26, 0.2], roughness: 0.9}));
TerrainColors.attach(engine, ground);
const change = GroundChange.attach(engine, ground, {
  grid,                                   // the grid the mesh was built on
  events: [
    {kind: 'gully', path: [[-80, -120], [-60, -40], [-70, 30]], width: 6, depth: 2.5, duration: 40},
    {kind: 'bank', path: [[-200, 120], [200, 140]], river: 'left', retreat: 12, bed: 2, duration: 60},
    {kind: 'scour', center: [60, -20], radius: 8, depth: 3, flow: [0, 1], start: 10},
    {kind: 'slide', from: [120, 160], to: [140, 60], width: 30, depth: 4, start: 20},
    {kind: 'mud', shore: [[-200, -180], [200, -180]], land: 'right', reach: 250, thickness: 0.3, duration: 90},
    {kind: 'ash', vent: [150, -150], thickness: 0.08, half: 80, wind: [6, 2], start: 30, duration: 60},
    {kind: 'lava', path: [[150, -150], [100, -60], [40, -40]], width: 14, thickness: 2, start: 30, duration: 120},
    {kind: 'burn', ignition: [-120, 60], wind: [5, -1], rate: 0.6, start: 5, duration: 240},
  ],
});
applyGroundChangeSettings(change, {'lava.glow': 16, 'wet.rain': null});   // null: wet with the weather's rain
change.setTime(45);                                                    // or let frames advance it
engine.start();
const {height, lava, heat} = change.sample(100, -60);                  // stand a person or a prop on it
console.log(height, lava, heat);
```

On a clipmap `Terrain`, attach it to the terrain instead: the grid is the heightmap's texels, the changed heights are
written into the heightmap itself (so every ring, the terrain's shadows and its normals show them), and the covers lie
over `terrainColor` as a terrain lighting effect (after the terrain's other effects that replace its shader). The
heightmap must be `r32float` with `COPY_SRC | COPY_DST` usage; its base is read back once (`await change.ready`).

```ts
import {Engine} from 'margoengine/core';
import {Terrain} from 'margoengine/terrain';
import {GroundChange} from 'margoengine/terrain/ground-change';
const engine = await Engine.create(document.querySelector('canvas')!);
const n = 513, heights = new Float32Array(n * n).map((_, k) => 0.02 * Math.floor(k / n));
const terrain = Terrain.attach(engine, {
  size: [512, 512], origin: [-256, -256], heightScale: 1,
  layers: Array.from({length: 4}, () => ({height: [-1e4, 1e4] as [number, number], slope: [0, 1] as [number, number], scale: 0.1})),
  textures: (device) => {
    const heightmap = device.createTexture({size: [n, n], format: 'r32float', usage: 15});   // COPY_SRC | COPY_DST | ...
    device.queue.writeTexture({texture: heightmap}, heights, {bytesPerRow: n * 4}, [n, n]);
    const layers = device.createTexture({size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6});
    device.queue.writeTexture({texture: layers}, new Uint8Array(16).fill(128), {bytesPerRow: 4, rowsPerImage: 1}, [1, 1, 4]);
    return {heightmap, layers};
  },
});
const change = GroundChange.attach(engine, terrain, {   // grid left out: the heightmap's texels
  events: [{kind: 'lava', path: [[0, 0], [60, 120]], width: 20, thickness: 3, duration: 90}],
});
await change.ready;                                      // the base heights are read back
engine.start();
```


  default 0.3) and `seed`:
  - `gully` (`path` mouth first, `width` 4, `depth` 1.5, `shape` `'v'` or `'u'`, `deposit` 0.6 of the eroded volume
    left as a fan of radius `fan` below the mouth): the headcut climbs the path at a steady rate and the channel behind
    it deepens and widens toward its full section.
  - `bank` (`path`, `river` side, `retreat` 6, `bed` world Y, `face` 60 degrees): the land side retreats at a steady
    rate, cut down to the bed with its face at the angle.
  - `scour` (`center`, `radius` 5, `depth` 2, `flow`, `deposit` 0.5): depth grows as 1 - exp(-t / T) to the full depth
    at the end; with a `flow` the scoured sand forms a mound downstream.
  - `crater` (`center`, `radius` 30, `depth` 10, `heave` 0.4 depth, `heaveTime` sqrt(2 heave / g), `domeSpread` 1.3,
    `ejecta` 0.7, `duration` 6 s after the heave): a buried explosion. The ground first heaves into a dome
    `domeSpread` times the crater's radius, the surface thrown up ballistically to `heave` metres (1.43 s for 10 m);
    then the dome vents and the crater opens over `duration`, a paraboloid bowl of `radius` and `depth` with a lip at
    the rim and an ejecta blanket thinning as (r / R)^-3 (McGetchin et al. 1973) out to 5 R, holding `ejecta` of the
    bowl's volume. Pair it with `BlastCloud` of `margoengine/weather/eruption` for the cloud:
    `{kind: 'crater', center: [0, 0], radius: 120, depth: 30, heave: 20, start: 2}`.
  - `slide` (`from` crown, `to` toe, `width` 20, `depth` 3, `length` 40% of the way, `bulking` 1.15): the scar fails in
    the first third and the lobe runs out as a block under friction, holding the scar's volume times `bulking`.
  - `mud` (`shore`, `land` side, `reach` 400, `thickness` 0.25, `decay` reach / 3, `drying` 1,800 s): the front slows
    inland, the deposit thins by e every `decay` metres and dries by e every `drying` seconds after the water passes.
  - `ash` (`vent`, `thickness` 0.1, `half` 400, `wind`, `elongation` 1 + 0.25 wind speed): thickness halves every
    `half` metres of an isopach's crosswind half width, the isopachs stretched downwind; it falls at a steady rate.
  - `lava` (`path` vent first, `width` 12, `thickness` 2, `levee` 0.35, `cooling` 1, `glowCrust` 0.03): the front
    advances and slows, the sheet stands between levees, and its glow fades as the crust grows 0.0779 sqrt(hours) m
    (`cooling` real seconds per film second). With `arrival` (film seconds the front reaches each path point), and
    optionally `widths`, `thicknesses` and `glows` (one per point), the front follows those times instead and stops
    where they stop: `LavaFlow.lavaEvent()` of `margoengine/weather/lava` gives all four for a flow that runs down the
    slope. `pond` (`center`, `start`, `end`, `flux` m^3/s, `viscosity` Pa s, `density` 2,600) fills a pond where the
    flow can run no further: it spreads as Huppert's (1982) R = 0.715 (g Q^3 / (3 nu))^(1/8) t^(1/2) while fed and
    holds after `end`, its thickness H (1 - (r/R)^2)^(1/3) with H = Q t / (0.75 pi R^2), so it holds the volume fed
    into it (to 1 percent on a 0.5 m lattice in the tests), and its surface glows by the time since its edge passed;
    `lavaEvent()` gives it for a flow that ponds. `roofs` (film seconds, one per point, 1e9 for never) roofs the
    channel from each point into a lava tube: from the front's arrival to then a crust grows in from the levees
    (Peterson et al. 1994) until it closes level with their crests, and nothing under it glows; `lavaEvent()` gives
    them for a flow on gentle ground. `skylights` (metres, default 200, 0 for none) is the mean spacing of skylights
    in a closed roof (Kauahikaua et al. 1998): a hole 0.8 widths long and half a width across in three of four
    stretches of that length, at a seeded place, showing the stream half a sheet down, fresh until `drains` (film
    seconds per point, 1e9 for never) and crusting from then on.
  - `burn` (`ignition`, `wind`, `rate` 0.3 m/s, `severity` 1, `ashing` 900 s, `consume` 0.03 m): a wind ellipse grows
    with the head running `rate`, its length to breadth from the wind; char whitens to ash by e every `ashing` seconds.
- Look (all live, `setLook` or the rows of `@margoengine/terrain/ground-change-settings`): `soil`, `mud`, `ash`,
  `char`, `ashen` and `lava` colours, `glow` 12, `cracks` 0.7, `crackSize` 0.8 m, `wetDarkening` 0.55, `wetGloss` 0.5,
  and `rain` (null: a `WeatherDrive` writes the weather's rain; a number holds it).
- Time: frames add their delta, or `clock` returns a shot's time, or `setTime(t)`; `advanceTime(delta)` is the clock
  step `seek` from `@margoengine/cutscene/seek` replays. Pass `shadows` so a cached still shadow map re-renders when the
  ground moves.
- CPU model alone: `new GroundChange({grid, base, events})`, then `setTime` and `update()`; `change`, `heights` and
  `covers` hold the grid, `sample(x, z, t)` the exact value anywhere, `onChange` reports each changed rectangle.
- Plants follow the ground: spread `change.scatterGround()` into a `Scatter` or `GrassScatter`
  (`@margoengine/scatter`). Its `heightmap` holds base plus change in metres, so plants rise and sink with the ground;
  its `densityMap` keeps them where the ground keeps its own cover and clears them under fresh soil, mud, ash, char and
  lava (255 less the strongest cover byte), so a gully or slide scar is bare, mud, ash and lava bury them and a burn
  scar is burned clear as its front passes; `bounds` is the rectangle both cover. On a terrain, `await change.ready`
  before the first frame. Dispose the scatter before the change (the maps go with it). Plants left standing at the edge
  of a cover take its char, ash and mud through `change.plantCovers()` (`{covers, bounds}`, rgba8 mud, ash, char and
  wetness per grid vertex) as the `ground` source of a `PlantStates` map (`@margoengine/scatter/states`).

  ```ts
  import {Engine, box} from 'margoengine/core';
  import {heightfieldGeometry} from 'margoengine/terrain';
  import {toGeometry} from 'margoengine/geometry/utils';
  import {GroundChange} from 'margoengine/terrain/ground-change';
  import {Scatter} from 'margoengine/scatter';
  const engine = await Engine.create(document.querySelector('canvas')!);
  const grid = {size: [48, 48] as [number, number], resolution: 96};
  const ground = engine.createMesh().setGeometry(toGeometry(heightfieldGeometry((x, z) => 0.05 * z, grid)));
  const change = GroundChange.attach(engine, ground, {
    grid,
    events: [{kind: 'burn', ignition: [-12, 0], rate: 0.25, duration: 60}],
  });
  Scatter.attach(engine, box(0.2, 0.8, 0.2), {count: 60000, area: [48, 48], ...change.scatterGround()});
  engine.start();
  ```
- A terrain's heightmap must be `r32float` with `COPY_SRC` and `COPY_DST` (the read back and the writes); the grid is
  its texels over the terrain's `origin` and `size` (`resolution` may differ along X and Z). Each changed frame writes
  the changed texels (base plus change over `heightScale`) and invalidates the terrain's cached shadows; `dispose()` or
  `engine.removePlugin(change.name)` writes the read-back texels back exactly. Normals the terrain takes from a
  `normalmap` are tilted by the change's slope in the fragment shader. The terrain's CPU copies (`TerrainQuery`,
  `TerrainSculpt.heights`) keep the base: read heights from `change.sample`. Memory on the GPU: 12 bytes a texel.
- The mesh must be a `heightfieldGeometry` on the same grid at the identity transform (any vertex order). The mesh's
  culling sphere grows over any raise past it, so ground lifted at the edge of a small mesh is never culled early.
  `dispose()` or `engine.removePlugin(change.name)` gives the mesh its base heights, normals and sphere back, on the GPU
  and in the CPU copy. Memory: 8 bytes of cover textures and 25 bytes of CPU grids a
  vertex (26 MiB at 1,024 cells a side).

Checked by `test/ground-change.test.js` against each law (Sumer's scour curve to 1e-9, Pyle's halving, Hon's crust,
Alexander's length to breadth to 3%, volumes kept to 2 to 5%, the same grid whatever order the times come in) and on a
real GPU by `test/ground-change.browser.mjs` (in `test:gpu`, WebGPU and `MARGO_COMPAT=1`, 2026-11-17): a gully and a
scour drawn through GroundChange are 0.05 of 255 on average from a mesh built from the same final heights, the uncut
ground 1.29; fresh lava glows orange (235, 132, 63), cooled lava is dark (33, 28, 25), ash greys and char blackens the
ground; time 40 reached directly or in 1,200 steps draws the same pixels; `dispose` and `engine.removePlugin` draw the
uncut ground exactly; lava 3 m thick at the edge of a 4 m mesh grows its culling sphere from 2.83 to 4.65 m, every
vertex inside, and dispose puts 2.83 back. On a clipmap terrain (`test/ground-change-terrain.browser.mjs`, 129 x 129 texels 0.5 m
apart, rings of 16 cells, WebGPU and `MARGO_COMPAT=1`): the heightmap holds base plus change exactly; the cut draws
0.016 of 255 on average from a terrain whose heightmap is the final heights (the uncut 1.0); lava glows (235, 131, 63)
and cools to (33, 28, 25); with a normal map the tilted cut is 0.12 from a normal map of the cut ground (untilted
1.15); `dispose` and `engine.removePlugin` give every texel and pixel back. With a `Scatter` (`test/ground-change-scatter.browser.mjs`, both
backends): its heightmap equals the changed heights exactly and its density map the cleared covers exactly; the burn
scar and the lava draw no plants, the ground beside them 98 to 100% green.
The whole-scene test page `examples/test-pages/ground-change.html` runs all eight kinds on one hillside with a weather
drive (`node scripts/test-pages-browser.mjs --page=ground-change`). A changed frame recomputes the box around every
active event on the CPU: 31 ms for 148,225 vertices with all eight active, measured once on a loaded dev PC.
Sources: Mei, Decaudin and Hu 2007 (Pacific Graphics); Galin et al. 2019 (Computer Graphics Forum 38(2)); Bennett et
al. 2000 (Water Resources Research 36(7)); Ikeda, Parker and Sawai 1981 (J. Fluid Mech. 112); Sumer, Fredsoe and
Christiansen 1992 (J. Waterway, Port, Coastal and Ocean Eng. 118(1)); Heim 1932; Scheidegger 1973 (Rock Mechanics 5);
Goto et al. 2011 (Marine Geology 290); Abe, Goto and Sugawara 2012 (Sedimentary Geology 282); Pyle 1989 (Bulletin of
Volcanology 51); Hulme 1974 (Geophys. J. R. Astr. Soc. 39); Hon et al. 1994 (GSA Bulletin 106); Anderson 1983 (USDA
INT-305); Alexander 1985 (8th Conf. Fire and Forest Meteorology); Key and Benson 2006 (USDA RMRS-GTR-164-CD).

## Wet ground where a flood has been: `@margoengine/terrain/wet-ground`

`WetGround.attach(engine, terrain, {record, origin, size})` draws a clipmap `Terrain` darker and glossier wherever a
wetting record says the water has been, and dries it back over time. The record is `Flood.wetTexture` of
`margoengine/water/flood` (rgba32float, one texel a flood cell: green the seconds since the cell was last wet above
1 cm, blue 1 once it has been wet), read every frame, so the wet ground follows each tick, seek and device restore of
the flood. A cell's wetness is `exp(-seconds since wet / dryTime)`; fully wet ground has `darkening` of the dry albedo
(Lekner and Dorf 1988, https://doi.org/10.1364/AO.27.001278) and `1 - gloss` of the roughness, so the sun's highlight
sharpens. It is a terrain lighting effect, so it composes with `GroundChange`, shadows and lights.

```ts
import {Engine} from 'margoengine/core';
import {Terrain} from 'margoengine/terrain';
import {WetGround, applyWetGroundSettings} from 'margoengine/terrain/wet-ground';
import {Water} from 'margoengine/water';
import {Flood} from 'margoengine/water/flood';
const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu',
  camera: {position: [0, 30, 40], target: [0, 0, 0], near: 0.5, far: 1000},
});
// A street 64 m square falling gently east, and 1 m of water held west of x = -20 m that breaks loose.
const n = 129, heights = new Float32Array(n * n).map((_, k) => 1 - 0.01 * (k % n));
const terrain = Terrain.attach(engine, {
  size: [64, 64], origin: [-32, -32], heightScale: 1, cellSize: 0.5,
  layers: Array.from({length: 4}, () => ({height: [-1e4, 1e4] as [number, number], slope: [0, 1] as [number, number], scale: 0.1})),
  textures: (device) => {
    const heightmap = device.createTexture({size: [n, n], format: 'r32float', usage: 15});
    device.queue.writeTexture({texture: heightmap}, heights, {bytesPerRow: n * 4}, [n, n]);
    const layers = device.createTexture({size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6});
    device.queue.writeTexture({texture: layers}, new Uint8Array(16).fill(128), {bytesPerRow: 4, rowsPerImage: 1}, [1, 1, 4]);
    return {heightmap, layers};
  },
});
const water = Water.attach(engine, {
  height: -50,
  terrain: {heightmap: () => terrain.heightmap, origin: [-32, -32], size: [64, 64]},
  fill: (x) => (x < -20 ? 2 : undefined),
});
const flood = Flood.attach(engine, {surface: water, maxDepth: 2, maxSpeed: 6});
const wet = WetGround.attach(engine, terrain, {record: () => flood.wetTexture, origin: [-32, -32], size: [64, 64]});
applyWetGroundSettings(wet, {'wet.dryTime': 120});   // dries within minutes for this shot (live, keyable)
engine.start();
```

- Look (all live, `setLook` or the rows of `WET_GROUND_SETTINGS`, the shared slider row shape): `darkening` 0.55,
  `gloss` 0.5, `dryTime` 10,800 s (3 hours; a soil surface dries over hours to a day, Idso et al. 1974,
  https://doi.org/10.2136/sssaj1974.03615995003800050037x). `wetGroundSettingDefaults()` gives a panel's state.
- `binding` (default 116) moves its two lighting-group bindings if another effect uses them. `dispose()` gives the
  terrain its shader back; the record stays the flood's.
- Measured on WebGPU and the WebGL2 layer (`test/wet-ground.browser.mjs`): fully wet ground draws as the terrain whose
  layer is 0.55 of the dry albedo and, under the sun's mirror direction, as the terrain at roughness 0.45 (its highlight
  1.19 times the dry ground's); at `dryTime` it is the layer times 1 - 0.45 / e, and at 20 x `dryTime` the plain terrain.
  Limits: one wetness a flood cell, the same darkening for every layer, no evaporation model (docs/limits.md).

## Soil and contact shade at the feet: `@margoengine/terrain/ground-contact`

`TerrainGroundContact.attach(engine, terrain)` draws the ground around the feet of the objects standing on it: a ring
of soil and litter, and the sky light the object keeps from the ground. Give it footprints by key, flat
`[x, z, radius, kind, ...]` in world metres, kind 0 a trunk and 1 a stone; `BiomeView` feeds it every stored trunk and
stone by itself (`view.groundContact`).

```ts
import { Engine } from '@margoengine/core';
import { Terrain } from '@margoengine/terrain';
import { TerrainGroundContact } from '@margoengine/terrain/ground-contact';
const engine = await Engine.create(document.querySelector('canvas')!);
const terrain = Terrain.attach(engine, { size: [256, 256] });
const contact = TerrainGroundContact.attach(engine, terrain);
contact.set('camp', [4, -2, 0.6, 1, 9, 3, 0.25, 0]); // a boulder and a tree trunk
contact.setLook({ soil: 0.8 });
engine.start();
```

- Sky lost at distance d from a footprint of radius r: `(1 + (d / r)^2)^-1.5`, the form factor of a sphere resting
  there (Quilez, https://iquilezles.org/articles/sphereao/; Evans, "Fast Approximations for Global Illumination on
  Dynamic Scenes", SIGGRAPH 2006), faded out from 3.5 to 4 radii; a trunk takes 0.6 of it (chosen).
- Soil: a trunk's thins as `exp(-s / (1.1 r))` past the bark and ends 3 radii out (duff is deepest at the stem: Ryan
  and Frandsen 1991, International Journal of Wildland Fire 1(2):107-118,
  https://www.fs.usda.gov/rm/pubs/rmrs_gtr292/1991_ryan.pdf; the numbers are a chosen fit). A stone's is a narrow ring
  whose width and 0.75 strength are chosen, with no measurement behind them.
- Options (defaults): `color` ([0.1, 0.08, 0.055] linear), `soil` (1), `occlusion` (1), live through `setLook`;
  `texel` (0.2 m), `resolution` (1024: the mask covers 205 m around the camera, 2 MB), `binding` (124, three bindings).
- The mask is baked on the CPU and re-centred as the camera moves; footprints past it draw nothing until it reaches
  them. A footprint is a circle, and meshes you place yourself get one only from your own `set`.

## Mesh to terrain blending: `@margoengine/terrain/blend`

`TerrainBlend.attach(engine, terrain, virtualTexture, options)` blends rocks, cliffs and buildings into the ground they
stand on, so a placed asset shows no hard seam line where its surface meets the terrain's. `add(mesh, options)` picks
the meshes. On each pixel of an added mesh the ground height under it is read from the heightmap (as the terrain's
vertex shader reads it); over the lowest `height` above that ground the mesh fades into the ground: its colour to the
terrain's colour there, read from the runtime virtual texture (`@margoengine/terrain/rvt`), its roughness to the
terrain's and its shading normal to the ground's, so core's lighting then shades the foot of the mesh as it shades the
ground. Value noise moves the fade up and down so it never reads as a ruled line.

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {Terrain} from 'margoengine/terrain';
import {TerrainVirtualTexture} from 'margoengine/terrain/rvt';
import {TerrainBlend} from 'margoengine/terrain/blend';
const engine = await Engine.create(document.querySelector('canvas')!, {camera: {position: [0, 1, -6], target: [0, 0.5, 0]}});
const terrain = Terrain.attach(engine, {
  size: [64, 64], origin: [-32, -32], heightScale: 1,
  layers: [0, 1, 2, 3].map(() => ({height: [-100, 100] as [number, number], slope: [0, 1] as [number, number], scale: 1})),
  textures(device) {
    const heightmap = device.createTexture({size: [2, 2], format: 'r32float', usage: 6});
    device.queue.writeTexture({texture: heightmap}, new Float32Array(4), {bytesPerRow: 8}, [2, 2]);
    const layers = device.createTexture({size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6});
    device.queue.writeTexture({texture: layers}, new Uint8Array(16).fill(160), {bytesPerRow: 4, rowsPerImage: 1}, [1, 1, 4]);
    return {heightmap, layers};
  },
});
const ground = TerrainVirtualTexture.attach(engine, terrain);
const rock = engine.createMesh().setGeometry(box(2, 2, 2)).setPosition([0, 0.5, 0])
  .setMaterial(new PbrMaterial({color: '#4f6f9f', roughness: 0.5}));
const blend = TerrainBlend.attach(engine, terrain, ground, {
  height: 0.5,  // world units above the ground over which a mesh fades into it
  noise: 0.5,   // how far noise moves the fade, as a share of height
  normal: 1,    // how far the shading normal turns to the ground's
});
blend.add(rock);                       // or blend.add(rock, {height: 1}) for this mesh alone
engine.start();
```

- Defaults: `height` 0.5, `noise` 0.5 (the fade's top and bottom move by up to a quarter of `height` either way),
  `normal` 1. Each mesh can override them; adding a mesh again changes its settings, `remove(mesh)` stops it, and
  neither recompiles the shader after the first mesh (the settings are a storage buffer row per mesh id).
- It works on meshes drawn with core's standard material, next to `TerrainColors` (they share one varying and one
  per-pixel block). Meshes on other shaders (glTF PBR, custom materials) draw as they were.
- The ground colour is the virtual texture's, so the terrain must use one (`TerrainVirtualTexture` refuses layer
  materials); past the cache's reach the mesh does not fade. The normal is the heightmap's (a terrain `normalmap` is
  not read). The fade is in the mesh's colour, roughness and normal only: its shape and shadow stay as they are, and a
  mesh floating higher than `height` above the ground is not touched.
- Cost: five group-0 bindings (from 40, past any taken) and, on an added mesh's pixels, five height reads, one noise
  and one or two cache samples; other meshes pay one storage read. WebGPU only.

Checked on a real GPU by `test/blend.browser.mjs` (in `test:gpu`, Radeon 680M, 2026-11-08): a 2 m box half a metre into
flat sandy ground, seen square from 6 m. Without the blend the colour jumps by 126.6 of 255 across the contact line;
with it 6.8 (noise 0.5) and 8.0 (noise 0), and the box's lowest row is 3.5 of 255 from the ground below it (126.7
without). Every pixel that changes lies on the box's foot (within the fade's reach): the rest of the picture is the
same bytes. With noise 0 the fade's top is the same row across the face (spread 1), with noise 1 it wanders over 10
rows. Cost not timed.

## Cliffs, overhangs and sea rocks: `@margoengine/terrain/rocks`

A heightfield holds one height per point, so it can draw neither an overhang nor a sea stack with a notch cut at its
foot, and its steep slopes stretch into smooth ramps. `findRockSites(ground, options)` finds where rock belongs on a
height grid (any grid: a `Terrain`'s heightmap texels, a `@margoengine/biomes` world's heights, a sculpted grid) from
its relief and slope; `buildCliff`, `buildSeaRock` and `buildBoulder` build each piece as a closed mesh standing a little
proud of the heightfield; `TerrainBlend` fades their feet into the ground and `RockSurface`
(`@margoengine/terrain/rock-surface`) shades them as rock that holds up close.

```ts
import {Engine, PbrMaterial} from 'margoengine/core';
import {Terrain} from 'margoengine/terrain';
import {TerrainVirtualTexture} from 'margoengine/terrain/rvt';
import {TerrainBlend} from 'margoengine/terrain/blend';
import {findRockSites, buildRocks} from 'margoengine/terrain/rocks';
import {RockSurface} from 'margoengine/terrain/rock-surface';
// A 30 m cliffed headland falling to the sea (sea level 0), as heights on a 129 x 129 grid over 256 m.
const n = 129, heights = new Float32Array(n * n);
for (let j = 0; j < n; j++)
  for (let i = 0; i < n; i++) heights[j * n + i] = 30 / (1 + Math.exp(-(j * 2 - 138) / 2.5)) - 8;
const ground = {heights, resolution: [n, n] as [number, number], origin: [-128, -128] as [number, number], size: [256, 256] as [number, number]};
const engine = await Engine.create(document.querySelector('canvas')!, {camera: {position: [0, 12, -40], target: [0, 8, 10]}});
const terrain = Terrain.attach(engine, {
  size: [256, 256], origin: [-128, -128], heightScale: 1,
  layers: [0, 1, 2, 3].map(() => ({height: [-100, 100] as [number, number], slope: [0, 1] as [number, number], scale: 1})),
  textures(device) {
    const heightmap = device.createTexture({size: [n, n], format: 'r32float', usage: 6});
    device.queue.writeTexture({texture: heightmap}, heights, {bytesPerRow: n * 4}, [n, n]);
    const layers = device.createTexture({size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6});
    device.queue.writeTexture({texture: layers}, new Uint8Array(16).fill(150), {bytesPerRow: 4, rowsPerImage: 1}, [1, 1, 4]);
    return {heightmap, layers};
  },
});
const sites = findRockSites(ground, {
  seaLevel: 0,         // the water the sea rocks stand in
  cliffSlope: 50,      // degrees of slope that can hold a cliff
  cliffRelief: 8,      // metres of local relief a cliff needs, within reliefRadius (16 m)
  seaRocks: 12,        // most stacks and skerries
  boulders: 3,         // fallen blocks at each cliff piece's foot
});
const blend = TerrainBlend.attach(engine, terrain, TerrainVirtualTexture.attach(engine, terrain), {height: 1});
const rock = RockSurface.attach(engine, {moss: 0.3, tideHeight: 1.5});
for (const piece of buildRocks(sites, ground, {cliff: {overhang: 3, strata: 1.4}, seaRock: {notchDepth: 0.8}})) {
  const mesh = engine.createMesh().setGeometry(piece.geometry).setPosition(piece.position)
    .setMaterial(new PbrMaterial({color: '#888888', roughness: 0.9}));
  blend.add(mesh);
  rock.add(mesh, {type: 'sandstone', seaLevel: 0});
}
engine.start();
```

- Sites. Slope is Horn's 3 x 3 weighted difference (Horn 1981); local relief is the highest less the lowest ground in a
  square of `reliefRadius` (van Herk 1992, Gil and Werman 1993: linear in the grid whatever the radius). A cliff piece
  stands where ground at least `cliffSlope` steep (default 50 degrees) has `cliffRelief` of relief (default 8 m); its
  foot and crest are found by walking down and up the slope until it eases to half the cliff slope, its `position` is
  mid-face and `facing` points down the slope. Pieces are `cliffWidth` wide (24 m) and 0.75 of that apart at mid-face,
  so they overlap; none is placed nearer the grid's edge than half a width. Sea rocks stand in water `seaRockDepth`
  deep (1 to 15 m) within `shoreDistance` (80 m) of land (a two-pass chamfer distance, Borgefors 1986), most often about
  half that reach out, at least `seaRockSpacing` (14 m) apart: stacks (0.35 to 0.85 of the nearby cliff's height) off
  cliffed coast as its remnants, skerries (0.4 to 2.5 m above the sea) elsewhere (Sunamura 1992, Trenhaile 1987).
  Boulders lie in front of each cliff's foot, bigger ones further out (fall sorting, Kirkby and Statham 1975). Sites
  are a pure function of the ground and options (`seed` picks again); `slope` and `relief` come back as grids too.
- Cliff pieces. The face is the ground's own crossing of each height along the facing, so the piece follows the real
  relief, moved `proud` (0.6 m) out past its deepest crack, soft bed and bump so the smooth slope never shows. It leans
  `overhang` (2.5 m) out over its top third (a true overhang once that beats the slope's lean back), steps in strata of
  `strata` (1.4 m) beds whose hard ones stand up to `ledges` (0.5 m) out (tilted by `dip`), is cut by vertical joints
  every `joints` (3 m), shifted bed by bed, `crackDepth` (0.35 m) deep (jointed blocks after Paris et al. 2020), carries
  3D bumps of `roughness` (0.35 m), stops just under the crest and goes `embed` (1.5 m) into the ground at its foot; its
  ends fold back into the hill. Rock volumes over a heightfield after Peytavie et al. 2009 (Arches), Paris et al. 2019
  and Gamito and Musgrave 2001.
- Sea rocks. A lumpy (`lobes` 0.22 of the radius), tapering (`taper` 0.25, a skerry 0.5) column with a wave-cut notch
  `notchDepth` (0.6 m, at most 0.45 of the radius) deep in a band `notchHeight` (1.2 m) high, centred a tenth of it over
  the still water, so the rock above overhangs it; strata ledges, `joints` (7) around it and a rounded top. Boulders
  use `facets` (9) bed, joint and corner cuts through a seeded block. The bed face sits under the ground at the
  default `embed` (0.3). The upper face has a seeded pitch and each side has its own cut, with `rounding` (0.18)
  controlling edge wear. These cuts draw on [A. Peytavie, E. Galin, J. Grosjean and S. Mérillou,
  *Procedural Generation of Rock Piles using Aperiodic Tiling* (2009)](https://perso.liris.cnrs.fr/eric.galin/Articles/2009-aperiodic.pdf)
  and [A. Paris, A. Peytavie, E. Guérin, J.-M. Dischler and E. Galin, *Modeling Rocky Scenery using Implicit Blocks*
  (2020)](https://perso.liris.cnrs.fr/aparis/public_html/projects/paris2020_Blocks.html).
- Meshes. Each piece is a signed distance field polygonized by Marching Cubes (Lorensen and Cline 1987, `marchingCubes`
  of `@margoengine/procedural`) at `cell` spacing (cliffs 0.5 m, sea rocks radius / 12, boulders radius / 10) in blocks
  of up to 127 cells whose shared vertices are welded and whose normals all come from the field's central differences,
  so every mesh is closed and shows no seam between blocks. Geometry is about `position` (set the mesh there). A 24 m
  wide, 30 m high cliff piece at 0.5 m is about 25,000 triangles and takes about a fifth of a second on one core; build
  a long coast in a worker. `cliffField`, `seaRockField` and `boulderField` return the signed distance and its box, for
  collision or your own polygonizer.
- `RockSurface` replaces an added mesh's colour, roughness and metalness, per pixel from the world position (no UVs or
  textures): six octaves of triplanar relief as a surface gradient on the normal (Mikkelsen 2020, Blinn 1978), each
  octave fading as its wavelength nears the pixel's footprint so far rock does not shimmer (Norton et al. 1982); the
  rock type's two bed tones banded by its `strata` with thin bedding lines; broad tone variation; broken joint cracks;
  moss on faces that look up; a wet, algae-dark band up to `tideHeight` over the rock's `seaLevel`; and rain that
  darkens and smooths it (Lekner and Dorf 1988, Jensen et al. 1999). Rock types: `sandstone` (default), `limestone`,
  `chalk`, `granite`, `basalt`, `shale` (`ROCK_TYPES`; give `color`, `color2`, `strata` or `porosity` to override).
  At close range, granite is a mosaic of 5 mm crystals whatever `scale` is: feldspar (64 percent, light), quartz
  (30 percent, grey) and dark biotite flecks (6 percent), after the granite field of Streckeisen (Earth-Science
  Reviews 12(1), 1976, doi:10.1016/0012-8252(76)90052-0) and the coarse Front Range granites (Barker et al.,
  Precambrian Research 2(2), 1975, doi:10.1016/0301-9268(75)90001-7); averaged they keep granite's measured tone, so a
  boulder seen from metres away shows no blotches. Basalt has subtle dark pits, and shale has thin laminations between
  beds. Grain color and relief fade when the screen footprint can no longer resolve them.
  Granite's two tones are measured: linear (0.2709, 0.224, 0.1869), the mean of ECOSTRESS Spectral Library 1.0 samples
  Granite_H2, H3 and H5, and (0.1678, 0.171, 0.1512), the grey alkalic Granite_H1 (Meerdink et al., Remote Sensing of
  Environment 230, 2019, https://doi.org/10.1016/j.rse.2019.05.015), each spectrum integrated under a 6504 K black body.
  These materials use visual characteristics from the [British Columbia Geological Survey, *Rock Identification
  Key* (1987)](https://cmscontent.nrs.gov.bc.ca/geoscience/publicationcatalogue/InformationCircular/BCGS_IC1987-05_METC1980.pdf)
  and [Utah Geological Survey, *Igneous, Sedimentary, & Metamorphic Rocks*](https://geology.utah.gov/map-pub/survey-notes/glad-you-asked/igneous-sedimentary-metamorphic-rocks/).
  Set `tideHeight: 0` for inland scenes to disable shoreline darkening, including below the assigned sea level. The
  look (`RockLook`, defaults in `ROCK_LOOK_DEFAULTS`) is live through `setLook`; `look.rain` null follows a
  `WeatherDrive`, which finds the surface by its name. One group-0 binding (from 40, past any taken); an added mesh's
  pixels cost about twenty value-noise reads plus three triplanar grain samples in close shots, other meshes one
  storage read. WebGPU, and WebGPU on the WebGL2 layer.
  Its patch runs after `TerrainBlend`'s, so the blend's fade into the ground is laid over the rock.
- Sliders: `@margoengine/terrain/rock-settings` holds every control on the shared row shape: the live look rows
  (`detail.*`, `moss.*`, `tide.*`, `wet.*`; `wet.rain` null follows the weather's `rainRate`) for
  `applyRockSettings(surface, values)`, and the shape rows (`cliff.*`, `sea.*`, `live` false) that `rockShapeOf(values)`
  turns into the builders' options.

Checked by `test/rocks.test.js` (CPU): slope exact on a 45 degree plane, relief equal to a brute-force window; on a
coast of a 30 m headland beside a beach, cliffs only on the steep high ground and facing down it, sea rocks in their
depth band within reach of the shore and spaced, stacks off the cliffs, boulders in front of the feet; 98% of the
ground's slope behind the face; an overhang of 4 m standing 3.4 m or more past the plain face at 85% of the height
with the lower face unmoved, and a 12 m one past the face below it; a stack's notch cut 1.1 m or more at the sea
surface and under 0.05 m 2.5 m away; meshes closed (every edge in two triangles) across polygonizer blocks, normals out
of the rock, the same input giving the same bytes. On a real GPU by `test/rocks.browser.mjs` (in `test:gpu`, WebGPU and
`MARGO_COMPAT=1`, RTX A6000, 2026-11-18): a cliff piece seen from 12 m has 3.0 times the plain mesh's mean absolute Laplacian of
luminance; rain darkens it to 0.69 of its light, the tide band to 0.61 with the rock above unchanged; with
`TerrainBlend` the changed foot pixels sit 40 of 255 from the bare ground against 96 without; 150 m off, a quarter-pixel
camera move changes the picture by 0.17 against the plain mesh's 0.15. Both backends give the same figures.

## Planet terrain: `@margoengine/terrain/planet`

`PlanetTerrain.attach(engine, options)` draws a whole planet that can be flown around from orbit down to a metre above
the ground. The six faces of a cube are each a quadtree of height patches mapped onto the sphere, so the ground curves
and the horizon dips as on a real world. A patch splits into four while its vertices would be more than `screenError`
pixels apart on screen (the ground nearest the camera first); patches behind the horizon or outside the view are not
drawn, and skirts hung from patch edges close the seams between levels. Each patch keeps its centre in float64 and is
drawn relative to the camera, so an Earth-sized planet holds still at any distance with no setting. With a
`FloatingOrigin` (`@margoengine/cameras/origin`) the planet's centre follows each rebase, so meshes placed near the
camera stay precise too.

```ts
import {Engine} from 'margoengine/core';
import {FloatingOrigin} from 'margoengine/cameras/origin';
import {PlanetTerrain} from 'margoengine/terrain/planet';
const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: {position: [0, 0, 2e7], target: [0, 0, 0], near: 1, far: 1e9},
});
const origin = FloatingOrigin.attach(engine);
const planet = PlanetTerrain.attach(engine, {
  radius: 6371000,  // metres at height 0 (the Earth's mean radius)
  relief: 8000,     // the default ground spans about -8 km to 8 km
  seaLevel: 0,      // lower ground draws as flat sea; false for none
  screenError: 4,   // pixels between vertices before a patch splits
  origin,           // the planet's centre follows the origin's rebases
});
engine.start();
console.log(planet.altitude(engine.camera.position)); // metres above the ground under the camera
```

- Options and defaults: `radius` 6,371,000 m; `center` [0, 0, 0] (a float64 world position); `height` (default
  `planetNoise({radius, relief, seed})`, fractal value noise); `relief` 8,000 m; `seed` 1; `seaLevel` 0 (or `false`);
  `resolution` 32 quads a patch side (even, 4 to 64); `maxLevel` 20 (vertices 0.3 m apart on the Earth); `screenError`
  4 px; `budget` 4 ms of patch building a frame (at least one patch; `Infinity` builds everything a view needs in one
  frame); `maxPatches` 2,048 on the GPU at once (about 24 KB each at resolution 32, so 50 MB; when every slot holds a
  patch the view uses, the planet keeps drawing the coarser parents where it wanted finer ones, never a hole, and
  `stats.resident` equals `maxPatches`: raise it, up to 16,384, for more detail; the patches share one vertex buffer
  that must fit the device's `maxBufferSize`, 256 MiB by default, so 10,992 patches at resolution 32 and 2,992 at 64,
  and `attach` throws `RangeError` past it, batch 132b); `origin` a
  `FloatingOrigin` to follow. Invalid values throw `RangeError` or `TypeError`.
- The same patches on every machine (KB-FILM-CLOCK1): the millisecond `budget` makes a slower machine build fewer patches
  a frame, so a frame drawn mid-refinement differs. For a film pass `maxBuilds` (patches a frame, 1 or more, `Infinity`
  until nothing more is wanted): it replaces `budget`, and the patches built and drawn are the same on every run. `clock`
  (milliseconds, default `performance.now`) is the clock the `budget` reads, for a simulation clock in replay.
- Your own ground: `height(x, y, z, detail)` gets a unit direction from the centre (float64) and returns metres above
  `radius`; `detail` is the spacing of the vertices being built there, so a procedural height can skip finer detail.
  `cubeSphere(face, s, t)` maps a cube face point to its direction.
- `heightAt(direction)` and `altitude(position)` read the ground on the CPU (the drawn surface is that ground sampled at
  the patch's vertices). `update(camera, [width, height])` plans and builds the patches for a view ahead of time (the
  frame calls it); `stats` says what the last frame drew and built, `patches` lists the drawn patches.
- Shading: the sun (`engine.lighting`) and ambient light over colours by height and slope (sea, sand, grass, dry
  ground, rock, snow). No shadows, SSR, lighting effects or layer textures yet; one view per frame.

Checked on a real GPU by `test/planet.browser.mjs` (in `test:gpu`, Radeon 680M, Edge 157, 2026-11-08), an Earth-sized
planet at 320 x 240: from 3 radii out the planet is a disc of 16,939 px against the 16,965 px of a sphere's projection;
on a smooth planet 100 km up, looking level, the horizon dips to the row `acos(R / (R + h))` predicts (157 against
156.97 in the middle), within a pixel in every column; 300 m above the default ground, 6,371 km from the world origin,
no sky shows through the ground, and the same view with a `FloatingOrigin` (which rebases the camera to near zero) is
the same picture, pixel for pixel; a 41-frame flight from two radii up to 2.8 m above the ground draws ground in every
frame, reaches level 20 and rebases once, with no validation error. `test/planet.test.js` checks the cube sphere's
seams and cell areas, the horizon culling, the screen error, that refining with no budget never leaves a hole, the
patch limit, sea level and following an origin. Building a patch costs about 1.3 ms of main-thread time at
resolution 32 with the default ground (Node, AMD mini PC, busy machine: diagnostic); the 1,682 patches a view 100 m above
the ground at 1280 x 720 needs took 2.2 s, which the `budget` spreads over frames. Frame cost not timed.

## Far from the origin: `floatingOrigin`

GPUs draw in float32, which holds about 7 digits: a terrain 10,000 km out has its vertices rounded to a metre and its
textures swim. Give the terrain the scene's `FloatingOrigin` (`@margoengine/cameras/origin`) as `floatingOrigin` and it
plans everything in float64 world space first: the ring lattice, the layer texture phases, the virtual texture's
windows and decals, the deformation window, streamed tiles and imagery views. Only small local numbers (world less the
origin) reach the GPU. A terrain 1e7 m out then draws the same vertices, levels, cache texels and pixels as the same
terrain at zero, and a rebase moves nothing on screen and bakes nothing again.

```ts
import {Engine} from 'margoengine/core';
import {FloatingOrigin} from 'margoengine/cameras/origin';
import {Terrain, type TerrainOptions} from 'margoengine/terrain';
import {TerrainQuery} from 'margoengine/terrain/query';
const engine = await Engine.create(document.querySelector('canvas')!);
// ratio 10: rebase once the camera is 10 times its target distance from local zero, so local numbers stay small.
const origin = FloatingOrigin.attach(engine, {ratio: 10});
const columns = 65, heights = new Float32Array(columns * columns).map((_, i) => Math.sin(i % columns / 6) * 0.1);
const options: TerrainOptions = {
  origin: [1e7 - 64, 1e7 - 64], // world XZ, float64, as without the option
  size: [128, 128],
  heightScale: 20,
  floatingOrigin: origin,
  layers: Array.from({length: 4}, () => ({height: [-100, 100] as const, slope: [0, 1] as const, scale: 0.25})),
  textures(device) {
    const heightmap = device.createTexture({size: [columns, columns], format: 'r32float', usage: 6});
    device.queue.writeTexture({texture: heightmap}, heights, {bytesPerRow: columns * 4}, [columns, columns]);
    const layers = device.createTexture({size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6});
    device.queue.writeTexture({texture: layers}, new Uint8Array(16).fill(128), {bytesPerRow: 4, rowsPerImage: 1}, [1, 1, 4]);
    return {heightmap, layers};
  },
};
const terrain = Terrain.attach(engine, options);
origin.lookAt([1e7 + 50, 80, 1e7 + 50], [1e7 + 60, 30, 1e7 + 90]); // world points; the camera becomes local
engine.start();
// CPU calls stay in world coordinates: convert the local camera ray with origin.toWorld.
const query = new TerrainQuery(heights, columns, columns, options);
console.log(query.height(1e7, 1e7), query.raycast(origin.toWorld(engine.camera.position), [0.2, -1, 0.8]));
console.log(terrain.shift); // the float64 world point at local zero, which every terrain entry follows
```

- `floatingOrigin` takes any `{origin, onRebase}` (a `FloatingOrigin` as is). Without it the shaders, uniforms and
  layer rules are byte for byte what they were. `terrain.shift` is the world point at local zero (zeros without the
  option); `terrain.anchor` is `origin` at construction.
- World in, world out: `origin`, `size`, `TerrainQuery`, holes, sculpt dabs, virtual texture decals, roads and
  `invalidate` areas, overlays, imagery bounds and deformation prints (and its `follow`) take float64 world
  coordinates, as without the option.
- Why `ratio` 10: core rebases when the camera is `ratio` times its target distance from local zero, so local numbers
  reach about `ratio` times the view distance before a rebase. float32 is clean to about 1e4 m (0.5 mm steps), so 10
  keeps a view a few hundred metres across well inside it; `FloatingOrigin`'s default of 1000 lets positions grow to
  kilometres first and shows float32 noise.
- Layer textures repeat on terrain-relative coordinates (world less `anchor`), so moving a terrain and its camera
  together draws the same picture; a terrain at zero draws as before. A streamed terrain (`/stream`) keeps the anchor
  where it started, and its overlays and imagery read XZ relative to it in float32: precise within about 1e4 m of the
  start, as at zero.
- The virtual texture addresses its cache by world texel (`floor(world / texel)`, a 32-bit integer): up to 1e8 m from
  zero at the default 5 cm texel. Its texel and the deformation's are taken as the float32 the GPU holds (a relative
  change under 1e-7), so the CPU's texel indices and the GPU's coordinates agree at any distance.

Checked on a real GPU by `test/origin.browser.mjs` (in `test:gpu`, RTX A6000, Edge 157, WebGPU and the WebGL2 layer,
2026-11-11), a 320 x 240 scene of rules with bump and macro, a hole, and a virtual texture with a decal and a road,
moved with its camera by 0, 100,352 and 10,000,384 m: with the origin at the offset every picture is the zero case's,
pixel for pixel, with the same draw calls and 1,324,960 texels baked; rebased onto the camera at 1e7, rebased in place
(which bakes nothing that frame) and after a 400 m flight that rebases on the way, every pixel is within 1 of 255 of it
(99.93, 99.93 and 99.84 percent equal; the flight ends on an origin 2/3 m off the metre grid, and the same pose drawn
at rest on that origin, with no rebase at all, is 99.83 percent equal: float32 rounding of the frame, not the rebase,
which changes 0.004 percent of pixels). Cached imagery with an overlay polygon, layer materials with displacement,
footprints, imagery on the lit path, a mesh blended into the ground and a streamed terrain each draw the same picture
at 1e7 as at zero, and blend and stream stay within 1 of 255 after a rebase in place. `test/origin.test.js` checks
`planRings` and `planWindows` bit for bit at those offsets, the layer wrap and tone, a rebase rewriting the rules once
and redrawing shadows once, and `TerrainQuery` at the offsets.

## Textures after a device restore

`textures` is a function `(device) => TerrainTextures`, never a plain set, so a device restore needs nothing from you. The terrain calls it once
for each device (at attach and again after `engine.rebootDevice()` or core's own recovery), binds the textures it returns, and destroys the old
set. Make the textures from data you keep (the heights, the layer colours, the painted weights, the holes mask), not from a texture you made
earlier, and nothing is lost and nothing is reported.

## On the WebGL2 compatibility layer

Where the browser has no WebGPU, install the layer (`margoengine/webgl2-compat`) before `Engine.create` and the
clipmap terrain draws with nothing else changed: the same options, the same textures factory, the same pixels. The
root entry and `rvt` have no compute pass, so they need no route of their own there: this package holds no WebGL2
code and a page with WebGPU downloads nothing extra.

```ts
import {Engine} from 'margoengine/core';
import {install} from 'margoengine/webgl2-compat';
import {Terrain} from 'margoengine/terrain';
await install(); // changes nothing where WebGPU has an adapter; else navigator.gpu draws through WebGL2
const engine = await Engine.create(document.querySelector('canvas')!, {camera: {position: [0, 20, -40], target: [0, 0, 0]}});
Terrain.attach(engine, {
  size: [64, 64], origin: [-32, -32], heightScale: 4,
  layers: [0, 1, 2, 3].map(() => ({height: [-100, 100] as [number, number], slope: [0, 1] as [number, number], scale: 1})),
  textures(device) {
    const heightmap = device.createTexture({size: [2, 2], format: 'r32float', usage: 6});
    device.queue.writeTexture({texture: heightmap}, new Float32Array([0, 1, 1, 0]), {bytesPerRow: 8}, [2, 2]);
    const layers = device.createTexture({size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6});
    device.queue.writeTexture({texture: layers}, new Uint8Array(16).fill(160), {bytesPerRow: 4, rowsPerImage: 1}, [1, 1, 4]);
    return {heightmap, layers};
  },
});
engine.start();
```

Checked on a real GPU by `test/compat.browser.mjs` (in `test:gpu`, Radeon 680M, ANGLE on Direct3D 11, Edge 157,
2026-11-08): a 129 x 129 heightmap of hills and a ridge with four checked layers, drawn natively and on the layer
(`install({force: true})`) in exact-pixel mode, in three cases: layer rules alone; painted weights with a hole; and a
runtime virtual texture (`@margoengine/terrain/rvt`), which bakes the same 1,310,720 texels on both. In every case no
pixel differs by more than 1 of 255 (the layer roadmap allows 0.1% of pixels over 2 and a mean of 0.25). Cost on the
layer, counted, not timed: a frame of six clipmap levels is 6 engine draws, 6 GL draws and 48 GL calls (50 with the
virtual texture).

- Checked on the layer: the root entry (rules, painted weights, holes) and `rvt`. Not run there yet: `layers-pbr`,
  `stream`, `sculpt`, `deform` and `displace` (the last three have compute passes, which the layer runs on its own
  tiers), `blend`, the SSR capture, shadows and the occluder pass.
- Frame times on the layer are not measured; only one GPU and one ANGLE back end ran it.

## Screen-space reflections

`Terrain` takes SSR's capture hook (`@margoengine/post/ssr`): `ssr.add(terrain)` draws its own normal, layer colour and
roughness into SSR's material targets (through the hook's `margoSSR`, metal 0), depth tested and written, so wet
ground, ice or polished stone reflect what is on screen. `roughness` (GGX, 0-1, default 0.9; `RangeError` outside)
sets the terrain's roughness for the sun's highlight and for SSR, whose default `maxRoughness` of 0.6 skips the
default 0.9. With an `EnvironmentLighting` on the terrain the IBL specular it added is what SSR replaces where its ray
hits; without one the reflection is added (as for core meshes). Leaving out `roughness` and the hook keeps the GPU
calls exactly as before (`examples/package-benchmarks/proofs/terrain-ssr.proof.js`, against `6c20076d`).
Checked on a real GPU (NVIDIA RTX A6000, Edge 155; `examples/package-benchmarks/post-effects-gpu.mjs --only=ssr-surfaces`, [ssr-surfaces-gpu.json](../../examples/package-benchmarks/results/ssr-surfaces-gpu.json)): a red box above a flat terrain (roughness 0.05, albedo 0.04) appears in it inside the box's planar
mirror (24,929 pixels, none outside the projected mirror bounds by more than 6 px) and red at the mirrored centre,
at 4x and 1x MSAA. A terrain is reflected only on screen and, being a dielectric, reflects 4-10% at most view angles.

## Ambient light and the sky

Without other light, terrain's ambient is `engine.lighting.radiance[3]` times `engine.lighting.ambient` (white by
default) times the albedo, the same term core meshes use, so a coloured `lighting.ambient` colours the ground as it
colours the meshes on it. `sky.add(terrain)` (`@margoengine/sky` with `lighting.ambient`) puts the sky's own light in
its place: diffuse from the sky's nine spherical harmonics (Ramamoorthi and Hanrahan 2001) along the shaded normal and
split-sum sky reflections (Karis 2013), so ground in shadow takes the blue of the sky above it. A `HemisphereLight`
(`@margoengine/environment`) added to the terrain takes the flat term's place the same way. Checked on WebGPU and the
WebGL2 compatibility layer by `test/sky-ambient.browser.mjs` (in `test:gpu`): under no sun, `lighting.ambient`
[1, 0.5, 0.25] draws flat grey ground at sRGB (82, 50, 14) against (74, 74, 74) for white; under a clear noon sky the
ground with the sky's light reads (20, 22, 31) against (19, 19, 19) without, the same pixels on both backends.

```ts
import {EngineKernel} from 'margoengine/core';
import {Terrain} from 'margoengine/terrain';
import {Sky} from 'margoengine/sky';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const terrain = Terrain.attach(engine, {
  resolution:64, levels:6, cellSize:1, origin:[-50,-50], size:[100,100], heightScale:20,
  layers:[0.3,0.2,0.4,0.2].map((scale)=>({height:[-20,100] as [number,number],slope:[0,1] as [number,number],scale})),
  textures:device=>{
    // 6 = TEXTURE_BINDING | COPY_DST: flat grey demo ground; replace with your assets.
    const heightmap = device.createTexture({size:[4,4],format:'r32float',usage:6});
    device.queue.writeTexture({texture:heightmap},new Float32Array(16),{bytesPerRow:16},[4,4]);
    const layers = device.createTexture({size:[1,1,4],format:'rgba8unorm-srgb',usage:6});
    device.queue.writeTexture({texture:layers},new Uint8Array(16).fill(128),{bytesPerRow:4,rowsPerImage:1},[1,1,4]);
    return {heightmap,layers};
  }
});
engine.lighting.ambient.set([1, 0.9, 0.8]); // warm flat ambient on the ground, as on core meshes
const sky = new Sky({hours:15, lighting:{ambient:{day:[0.05,0.05,0.06], night:[0.01,0.01,0.02]}}});
engine.use(sky);
const removeSkyLight = sky.add(terrain); // the sky's light in place of the flat ambient; removeSkyLight() undoes it
engine.start();
```

## Shadows

`shadows.add(terrain, {static: true})` casts and receives, in `Shadows` and in `VirtualShadows` alike, through the vertex entry of its colour pass, its position `@invariant` (WGSL 12.10) as every Margo shadow caster's is, so another program drawing the same surface writes the same depth bit for bit; give either a `distance` that reaches as far as the camera sees. Any lighting effect may bind what it declares in its WGSL: the lighting group's layout is read from there.

## Terrain as an occluder

A hill can hide GPU-culled parts: `parts.addOccluder(terrain)` (`CulledParts` from `margoengine/culling/parts`, in
`'occlusion'` mode) draws the terrain's depth through `terrain.drawOccluder`, with the rings and uniforms of its main pass.

## Preview tier contract

The small `@margoengine/webgl2-compat/preview` renderer reports `backend: 'webgl2'` and has no GPU device. GPU-only attachments throw a linked `MargoError` with code `unsupported` before allocating resources. Native WebGPU and the full WebGL2 compatibility layer both report `backend: 'webgpu'`. Use [`autoEngine` with `loadCompat`](../webgl2-compat/README.md#automatic-escalation) during scene setup to select a complete tier automatically.

The renderer now refuses the preview during setup, allowing automatic escalation instead of accepting an attachment that cannot draw.

`TerrainImagery` refuses the small preview through the shared `requireWebGPU` (`TerrainImagery needs WebGPU`, code `unsupported`, help link). Before 2026-11-10 it threw `unsupported` with `Imagery requires WebGPU or its compatibility device` and no help link, which the preview-contract gate counted as a silent skip, so `npm run verify` failed. It now also refuses an engine whose backend is `webgl2` even when a device object is present, as every shared refusal does. Regression: `test/imagery.test.js`.

## Planet recipes: `@margoengine/terrain/planet-recipes`

Ground functions for `PlanetTerrain`: impact craters with a real size distribution and profile, ridged noise, domain
warp and ready-made moons, Mars-like worlds, asteroids and ice moons. Every function returns a `PlanetHeight`, so it
goes straight into `PlanetTerrain`'s `height` and composes with `planetNoise`.

```ts
import {Engine} from 'margoengine/core';
import {PlanetTerrain} from 'margoengine/terrain/planet';
import {planetPreset, planetPresetBrightness, planetPresetRadius} from 'margoengine/terrain/planet-recipes';
const radius = planetPresetRadius('moon'); // 1,737,400 m
const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: {position: [0, 0, 3 * radius], target: [0, 0, 0], near: 1, far: 1e9},
});
const height = planetPreset('moon', {radius}),
  brightness = planetPresetBrightness('moon', {radius}); // its crater rays
PlanetTerrain.attach(engine, {radius, height, brightness, relief: 4000, seaLevel: false});
engine.render({delta: 0});
```

Place a young crater yourself and its rays and secondary chains come with it:

```ts
import {craterField} from 'margoengine/terrain/planet-recipes';
const craters = craterField({
  radius: 1737400,
  rayed: [{x: 0.6, y: -0.7, z: 0.4, diameter: 85000}],
});
craters(0.6, -0.7, 0.4, 0); // metres at the central peak, below the undisturbed ground
craters.brightness(0.6, -0.7, 0.4, 0); // 1: fresh bright ground
```

- `craterField({radius, density | count, dMin, dMax, exponent, seed, depthRatio, rimRatio, maxDepth, floor, ejecta, blend, transition, peaks, terraces, rayed, rayedSize})`:
  craters are Poisson placed, uniformly over the sphere, with diameters from a power law (cumulative exponent 2 by
  default, Neukum et al. 2001) between `dMin` (default `radius / 20,000`) and `dMax` (`radius / 4`). `density` counts
  craters of `dMin` or more per million square kilometres (default 1,000), or give `count` for the whole planet. Depth,
  rim crest to floor, is `0.196 D^1.01` and rim height above the ground `0.036 D^1.01` with D in kilometres (Pike 1977);
  a floor is never more than `maxDepth` 3,400 m below the ground (larger craters are scaled, not clipped). The ejecta blanket is `0.14 R^0.74 (r / R)^-3` metres beyond
  the rim (McGetchin et al. 1973), the rim uplift falls off as `(r / R)^-4`, both fade to nothing by 3 radii. `floor`
  is the fraction of the radius that is flat floor (default 0). A younger crater replaces what an older one left inside
  its rim and fades into it over `blend` radii (0.15). Heights are relative to the undisturbed ground: `combine` it with a base.
  The result also has `craters(x, y, z, detail)`, the list of craters that reach a point (centre, diameter, age), for decals
  or labels. A sample reads the 27 lattice cells around it for each octave of diameter; craters under twice `detail`
  are skipped. A density that puts over 256 craters in one cell throws a `RangeError` that says to raise `dMin`.
- Complex craters: past `transition` (default 10,583 m, the Moon's; `Infinity` for none) a crater is shallower for its
  size, with rim crest to floor `1.044 D^0.301` and rim `0.236 D^0.399` (km, Pike 1977, continuous with the simple laws),
  a flat floor `0.187 D^1.249` wide from 20 km, a central peak `0.032 D^0.900` high from 27 km (`peaks` scales it,
  default 1) and terraces on its wall from about 15 km, the outermost about `0.09 D^0.87` wide (Pearce and Melosh 1986;
  `terraces` 0 to 1, default 1). Another body's `transition` rescales these lunar laws about it.
- Rays: `rayed` (default 0) adds young craters, a count of up to 64 sized within `rayedSize`
  (`[radius / 60, radius / 16]`) or your own `{x, y, z, diameter}` list. Each has 8 to 14 rays of median length
  `6.59 Rp^1.27` km (Elliott et al. 2018) and chains of secondary craters along them from 1.3 diameters past the rim, the
  largest 5 percent of the primary and smaller with range (Singer et al. 2020). The result's `rayed` lists them and
  `brightness(x, y, z, detail)` is 0 to 1; give it to `PlanetTerrain`'s `brightness`.
- `PlanetTerrain.attach(engine, {brightness})`: per vertex, 0 leaves the ground's colour, up to 1 turns it to bright
  fresh rock, down to -1 darkens it to black. Default none.
- `ridgeNoise({radius, relief, octaves, gain, frequency, seed})`: ridged multifractal noise between 0 and `relief`
  (Musgrave et al. 1989); defaults 8,000 m, 6 octaves, gain 2, 2 cycles around the planet.
- `domainWarp(height, {radius, amplitude, frequency, levels, seed})`: reads `height` at positions shifted by noise,
  up to `amplitude` metres (default 100,000) along each axis, so up to sqrt(3) times it in all; `levels: 2` warps by a
  warped noise, which moves a point no further.
- `combine(heights, {mode, smooth})`: `'add'` (default), `'max'` or `'smoothMax'` (rounded joins, `smooth` 100 m).
- `planetPreset('moon' | 'mars' | 'asteroid' | 'ice', {radius, seed})` and `planetPresetRadius(name)`: authored looks
  (numbers in [limits](../../docs/limits.md)), made for the body's own radius; pass the same `radius` to `PlanetTerrain`.
  The Moon's has 6 rayed craters; `planetPresetBrightness(name, {radius, seed})` gives their brightness (0 everywhere
  for the other presets).
  The preset is shaded by `PlanetTerrain` with its height colours, so set `relief` to suit and `seaLevel: false`.

Complex craters, rays and secondaries are checked in `test/planet-complex-craters.test.js` (depth, rim, floor and peak
against the laws within 2%, benches on the wall, no step across the transition, ray count and reach, chains on the rays).
The simple craters are checked in `test/planet-recipes.test.js` (an isolated crater's depth and rim over diameter against the Pike ratios and its
ejecta against McGetchin within 2%, a flat floor within 1e-6, diameters against the power law with a
Kolmogorov-Smirnov statistic under 0.02, determinism, pruning by detail, bounded reads, validation) and on both GPU backends by
`test/planet-recipes.browser.mjs` (every preset drawn on `PlanetTerrain`, deterministic, no validation error).

## Terrain relief lighting

Use `@margoengine/terrain/relief-lighting` to shade terrain from its measured or generated heightfield. A ridge can
block the sun on the floor of a valley, even if the ridge is outside the camera view. The visible sky supplies the
remaining diffuse light. The bake keeps sunlight visibility and projected sky visibility separate so layer albedo,
roughness and explicit light sources retain their roles.

```ts
import { Engine } from '@margoengine/core';
import { Terrain } from '@margoengine/terrain';
import { TerrainReliefLighting } from '@margoengine/terrain/relief-lighting';

const canvas = document.body.appendChild(document.createElement('canvas'));
const engine = await Engine.create(canvas, {
  backend: 'webgpu',
  camera: { position: [31, 43, 65], target: [31, 0, 25] },
});
engine.lighting.direction.set([1, 0.28, 0, 3]);
const terrain = Terrain.attach(engine, {
  size: [64, 64],
  heightScale: 1,
  layers: Array.from({ length: 4 }, () => ({ height: [-1, 100], slope: [0, 1], scale: 1 })),
  textures(device) {
    const heightmap = device.createTexture({ size: [65, 65], format: 'r32float', usage: 6 });
    const samples = new Float32Array(65 * 65);
    for (let z = 0; z < 65; z++) samples[z * 65 + 32] = 18;
    device.queue.writeTexture({ texture: heightmap }, samples, { bytesPerRow: 260 }, [65, 65]);
    const layers = device.createTexture({ size: [1, 1, 4], format: 'rgba8unorm', usage: 6 });
    device.queue.writeTexture(
      { texture: layers }, new Uint8Array(16).fill(140), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, 4],
    );
    return { heightmap, layers };
  },
});
const relief = TerrainReliefLighting.attach(engine, terrain);
engine.start();
// After a height or sun change, call relief.rebake(). Call engine.dispose() when leaving the view.
```

- Attach to a live clipmap terrain. On device restore the effect bakes from the heightmap on the restored device.
  Disposing the effect releases its texture and detaches it from its actual scene.
- `direction` defaults to the engine light at the time of the bake. `radius` defaults to one quarter of the
  shorter extent. The defaults are 12 sky azimuths, 48 samples per ray and a 0.75-degree half-width for the sun.
  Use 4–32 azimuths, 8–256 samples and a positive half-width of up to 10 degrees.
- Height samples must be finite and corner aligned. The effect uses the terrain height scale by default. It
  works with a single sampled 2D `r32float`, `rgba16float` or `rgba8unorm` height texture at least 2×2.
- For Blender meshes and custom terrain draws, `bakeTerrainReliefLighting(device, heightmap, size, options)`
  returns an owned filterable `rgba16float` texture. Its R channel is sun visibility and its G channel is
  projected sky visibility. Call `texture.destroy()` when finished. `terrainReliefLightingWGSL` provides
  `terrainReliefLight(map, sampler, uv)`, with UV coordinates 0 and 1 at the first and last height samples.
- Work is bounded by `width × height × (rays + 1) × steps` horizon samples per bake. Draws fetch one texel
  bilinearly. Radii and sample spacing limit the result. Distant narrow ridges can fall between samples.
  Overhangs and occluders absent from the heightfield require regular shadow casters.

Terrain horizons follow Nicolas Max, *Horizon Mapping: Shadows for Bump-Mapped Surfaces* (1988), and
A. James Stewart, *Fast Horizon Computation at All Points of a Terrain with Visibility and Shading Applications*
(1998). The azimuth-sampled sky view follows Klemen Zakšek, Krištof Oštir and Žiga Kokalj, *Sky-View Factor as
a Relief Visualization Technique* (2011).
[Max](https://cir.nii.ac.jp/crid/1573387451457112064)
[Stewart](https://research.cs.queensu.ca/home/jstewart/papers/tvcg97.html)
[Zakšek, Oštir and Kokalj](https://doi.org/10.3390/RS3020398)
