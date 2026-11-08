# @margoengine/terrain

Import `margoengine/terrain` from the `margoengine` package, or `@margoengine/terrain` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

`heightfieldGeometry(height, {size, origin?, resolution?})` generates a Y-up mesh
with recomputed slope normals. `origin` is the minimum world XZ corner; it defaults
to a centered rectangle, and mesh resolution defaults to 192 segments.
`TerrainHeightmap.attach(engine, height, {size, origin?, resolution?})` owns an
`r32float` texture sampled at cell centers, exposed as `.texture` for scatter and
water. Texture resolution defaults to 256. Resolutions are integers in 1..1024.
The module validates finite samples and device limits, regenerates the texture
on device restoration, and destroys it on disposal. Sampling arrays are released
after upload; there is no per-frame CPU sampling or allocation.

`TerrainColors.attach(engine, mesh, options)` applies height/slope colors and wet
shoreline darkening to one ordinary terrain mesh using its mesh ID. It preserves
the existing PBR/shadow shader and caches the patch. Options are captured at
attachment: `sand`, two `meadow` colors, `stone`, height ranges `shore`,
`meadowHeight`, `stoneHeight`, `wetHeight`, plus `stoneNormal` (normal Y in 0..1),
`wetDarkening` (0..1), and optional `variation` (0..1, default 0) and `detail`
(0..1, default 1). Ranges must be increasing; colors are linear RGB in 0..1.
Other meshes keep their materials.

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

Wetness samples world XZ per fragment and darkens only the sand albedo below
`wetHeight[1]`; fully wet sand is also 40% smoother, so it catches a soft sheen
toward the sun. Meadow/stone blends and geometry stay fixed to terrain height and
slope. The mask follows current water depth; it does not simulate erosion or
retain a drying history after recession. It uses a group 0 binding from 40 up and
flat output location 6 in the standard PBR shader. No core changes are required.
Physical WebGPU regression: `node packages/terrain/test/wetness.browser.mjs` from
the repository root after building the packages.

Optional geometry clipmaps with vertex texture height/normal sampling and 4 to 16 terrain layers. Fixed grids form a center and concentric rings. Uniform origins follow the camera, inner ring edges follow the finer grid, and outer-edge vertices collapse onto the next coarser lattice to close seams. Height sampling uses bilinear `textureLoad`, including non-filterable `r32float` maps. Cliff faces use triplanar splatting; normalized slope/height weights blend an sRGB texture array.

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

## Relief and far detail: `bump` and `macro`

Past about 50 m a layer texture's mips average it to its mean colour, and the ground is lit by the vertex normal only,
so rock and snow read as flat grey. Two optional layer settings, each 0 to 1 (`RangeError` outside), keep them
readable:

- `bump` (default 0): the layer's own luma becomes a height of up to half a texture repeat per unit of luma, times
  `bump` (2 m at `scale` 0.25 for luma 0 to 1), and the shading normal follows its slope: derivative bump mapping from
  Mikkelsen's "Bump Mapping Unparametrized Surfaces on the GPU" (2010), screen-space derivatives of the height and the
  position, no extra texture samples. The mips flatten it with distance, as they flatten the colour, and past a footprint
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
adds about 30 ALU operations and four derivatives per pixel; `macro` adds, per showing layer, one top-mip sample and
three texture samples for each triplanar axis that shows (one axis on most of the ground, all three at most). Checked on
a real GPU by `test/bump.browser.mjs` (in `test:gpu`): on flat ground with one grey noise texture, 0 draws the same pixels
as leaving them out, `bump: 1` spreads the near ground's luma 4.3 times as wide, `macro: 0.5` spreads the means of 32 px
blocks of a view from 60 m 9 times as wide, and straight down from 1.5 km the luma at a 96 m lag correlates under 0.2
(RTX A6000).
Where a crest is seen edge-on, the relief's slope is limited to what the pixel can resolve, so crests draw no dark
specks: `test/crest.browser.mjs` (in `test:gpu`) draws alpine crests under the noon sun with `bump: 1` and counts
none more than without it, by rules and by painted weights.

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
    return response.ok ? {heights: new Float32Array(await response.arrayBuffer())} : null;
  },
});
engine.start();
await stream.ready();                                  // every tile of the first window is in
stream.onChange((change) => console.log(change));      // bands uploaded, or the window moved (`shifted`)
```

- The window moves a whole tile when the camera is more than 0.75 of a tile from its centre, so ground at least
  `(window / 2 - 0.75) * tileSize` from the camera on each axis is always in it; the terrain draws nothing past the
  window, as past any heightmap. Tiles leaving it have their loads aborted (`signal`).
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
  tile's load error; a failed tile keeps `fill` until it leaves the window. `options.signal` aborts every load.
  `dispose()` aborts the loads and disposes the terrain.
- Memory: the window's heightmap, a scratch copy and the CPU copy, 4 bytes a texel each (12 MB at 1,024 x 1,024), plus
  three times 4 bytes a texel per weight texture. The window must fit the device's 2D texture limit.

Checked on a real GPU by `test/stream.browser.mjs` (in `test:gpu`) on nine adjacent Terrarium tiles around Mount
Rainier (`test/fixtures/terrarium-10`, Terrain Tiles on AWS), 256 x 256 each with weights made from their heights,
in a 2 x 2 window: through moves along +X, +Z, -X and -Z, a move inside the margin and teleports off the data and back,
the CPU copy, the GPU heightmap read back and the weights hold exactly the mosaic's texels for the expected tiles, the
streamed terrain draws exactly the pixels of a plain `Terrain` given that window whole, no frame uploads more than the
budget (16,384 texels: 17 frames for the first four tiles), and a stream disposed mid-load aborts it and rejects
`ready` with MargoError `'disposed'` (Radeon 680M). Cost not timed.

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

## Shadows

`shadows.add(terrain, {static: true})` casts and receives, in `Shadows` and in `VirtualShadows` alike; give either a `distance` that reaches as far as the camera sees. Any lighting effect may bind what it declares in its WGSL: the lighting group's layout is read from there.

## Terrain as an occluder

A hill can hide GPU-culled parts: `parts.addOccluder(terrain)` (`CulledParts` from `margoengine/culling/parts`, in
`'occlusion'` mode) draws the terrain's depth through `terrain.drawOccluder`, with the rings and uniforms of its main pass.
