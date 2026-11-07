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

`shadows.add(terrain,{static:true})` registers depth rendering and reception; moving clipmap origins invalidates its static shadow cache. `clustered.add(terrain)` adds local PBR lights. Call `terrain.invalidate()` after changing height texture contents. Raycasts/foot IK should use your retained height data or collision BVH; rendering performs no GPU height readback. The clipmap does not add physics or streaming. `dispose()`/`destroy()` releases textures and geometry. `clipmapGrid()` is exported for custom grid consumers.

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
