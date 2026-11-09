# @margoengine/terrain

`TerrainMaterials`, `TerrainDisplacement`, `TerrainVirtualTexture` and
`TerrainDeformation` dispose their actual scene registration, preserving a
same-name plugin in another scene. Device restoration keeps registration and
one terrain-lighting provider; explicit disposal removes both. Their public
`owner` field continues to identify the Engine, so use `engine.sceneOf(effect)`
to inspect the scene. All existing options and examples below are unchanged.

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
steeper than `steep` (the cache is baked top down). `declarations(group, binding)` and `entries(binding)` let any
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
map whose highest point stays under it, so no thin ridge is stepped over. No geometry moves: the ground's outline
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
texels finer than a pixel. Cost not timed.

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
  frame); `maxPatches` 2,048 on the GPU at once (about 24 KB each at resolution 32, so 50 MB); `origin` a
  `FloatingOrigin` to follow. Invalid values throw `RangeError` or `TypeError`.
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
resolution 32 with the default ground (Node, Beelink, busy machine: diagnostic); the 1,682 patches a view 100 m above
the ground at 1280 x 720 needs took 2.2 s, which the `budget` spreads over frames. Frame cost not timed.

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

## Shadows

`shadows.add(terrain, {static: true})` casts and receives, in `Shadows` and in `VirtualShadows` alike; give either a `distance` that reaches as far as the camera sees. Any lighting effect may bind what it declares in its WGSL: the lighting group's layout is read from there.

## Terrain as an occluder

A hill can hide GPU-culled parts: `parts.addOccluder(terrain)` (`CulledParts` from `margoengine/culling/parts`, in
`'occlusion'` mode) draws the terrain's depth through `terrain.drawOccluder`, with the rings and uniforms of its main pass.

## Preview tier contract

The small `@margoengine/webgl2-compat/preview` renderer reports `backend: 'webgl2'` and has no GPU device. GPU-only attachments throw a linked `MargoError` with code `unsupported` before allocating resources. Native WebGPU and the full WebGL2 compatibility layer both report `backend: 'webgpu'`. Use [`autoEngine` with `loadCompat`](../webgl2-compat/README.md#automatic-escalation) during scene setup to select a complete tier automatically.

The renderer now refuses the preview during setup, allowing automatic escalation instead of accepting an attachment that cannot draw.
