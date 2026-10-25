# @margoengine/terrain

Install `npm i margoengine` and import `margoengine/terrain` (or this package alone: `npm i @margoengine/terrain`, imported as `@margoengine/terrain`; the two are the same module).

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

Optional geometry clipmaps with vertex texture height/normal sampling and 4–8 terrain layers. Fixed grids form a center and concentric rings. Uniform origins follow the camera, inner ring edges follow the finer grid, and outer-edge vertices collapse onto the next coarser lattice to close seams. Height sampling uses bilinear `textureLoad`, including non-filterable `r32float` maps. Cliff faces use triplanar splatting; normalized slope/height weights blend an sRGB texture array.

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

The texture factory runs at attachment and after device restoration. Terrain owns and destroys returned textures; recreate them from retained asset data. Height maps support `r32float`, `rgba16float`, or `rgba8unorm` (R channel); optional normal maps support `rgba8unorm` or `rgba16float`, with XYZ encoded in 0..1. Without a normal map, the vertex shader samples neighboring heights. Layer arrays support `rgba8unorm-srgb`, `rgba8unorm`, or `rgba16float` and must contain exactly as many layers as the rules. Supply mipmaps for real assets. `heightScale`/`heightOffset` map samples to world Y; origin/size define XZ texture coverage. Heights clamp at map boundaries.

Resolution is a multiple of four from 8–256; levels range from 1–12. The default is 64 cells and six rings, with doubled cell spacing per level. Geometry buffers are allocated once and reused as the camera moves. Layer slope is `1-normal.y` in 0..1; height is world Y. Rules blend smoothly around their thresholds and fall back to layer zero if none match. Terrain uses GGX directional lighting and the scene's reversed depth.

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
