# @margoengine/lightmap

Import `margoengine/lightmap` from the `margoengine` package, or `@margoengine/lightmap` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Bakes lightmaps on the CPU: one padded UV atlas for a quad mesh with shadowed direct light and ambient occlusion,
plus matching albedo, emission, normal and ORM textures. Built for exporting lit voxel and block models (each
`meshGrid` quad of `@margoengine/voxel-edit` is a parallelogram) to glTF or any engine. No GPU or DOM; optional and
tree-shakable, core and the stage never import it.

```ts
import { bakeLightmap } from 'margoengine/lightmap';

const positions = new Float32Array([0, 0, 0, 4, 0, 0, 4, 0, 4, 0, 0, 4]);
const albedo = new Float32Array([0.8, 0.8, 0.8, 1]);
const abort = new AbortController();
const atlas = await bakeLightmap(
  { positions, albedo }, // 12 floats per quad (p0, p1, p2, p3), RGBA per quad
  {
    texelsPerUnit: 4,
    lights: [{ type: 'directional', direction: [0.3, 1, 0.2], intensity: 2 }],
    onProgress: (done, total) => console.log(done / total),
    signal: abort.signal,
  },
);
atlas.uv; // 8 floats per quad, top-left origin as in glTF
atlas.textures.lightmap; // RGBA8, irradiance / atlas.lightmapScale
```

- **Charts.** Each quad (a parallelogram, corners counterclockwise) gets its own chart, `ceil(edge * texelsPerUnit)`
  texels a side, packed by `@margoengine/materials`' `packAtlas` with `padding` gutter texels copied from the chart's
  edge so filtering never bleeds between charts. Mip levels need gutters to match.
- **Lighting.** Ambient, directional, point and spot lights with shadows, and cosine-weighted ambient occlusion, traced
  through `@margoengine/bvh`. Point and spot shadows test the segment to the light, so blockers beyond the light or
  right at the surface are handled without a bias. The lightmap is irradiance times occlusion, independent of albedo.
  `radiometry: 'physical'` stores irradiance without occlusion instead (the AO texture holds it), for a consumer that
  applies `albedo * (1 - metalness) / pi`; albedo must then be 0 to 1.
- **Textures.** Albedo is sRGB; emission, normal (tangent space, the quad's frame), ORM and AO are linear. Lightmap and
  emission store values divided by `lightmapScale` and `emissionScale` (each at least 1), so HDR light survives RGBA8.
- **Materials.** Per-quad `albedo`, `emission` and `roughnessMetalness`, or a `surface` callback that returns them per
  texel centre (procedural surfaces; a returned world-space normal goes into the normal texture).
- **Budgets.** Quads (32,768), texels (262,144 by default, up to 1,048,576), rays (16,777,216, up to 67,108,864), an
  estimate of bytes (192 MiB, up to 256 MiB) and the atlas side (2,048) are checked before any texture is allocated.
  Inputs are copied before the first await; `signal` and `onProgress` run every 256 texels.
- **Quads only.** `bakeLightmap` accepts quads and nothing else: `positions` is a `Float32Array` of 12 floats per quad,
  each a parallelogram with its corners counterclockwise (anything else throws a `RangeError` naming the fix), and the
  atlas UVs are its own, one chart per quad. Triangle meshes with their own lightmap UVs bake through
  `@margoengine/lightmap/mesh` below.
- **Asset record.** `lightingAsset(lightmap, terms)` returns a small record (scales, size, radiometry, baked terms) to
  store next to the textures, for example in glTF extras.

## Any triangle mesh: `@margoengine/lightmap/mesh`

`bakeMeshLightmap(mesh, options)` bakes a triangle mesh at its own second UV set (`uv1`, glTF `TEXCOORD_1`), such as
the lightmap UVs of a glTF file or of `@margoengine/mesh-edit/modeling`'s `meshLightmapUVs`.

```ts
import { bakeMeshLightmap } from 'margoengine/lightmap/mesh';

// A 4 x 4 floor as two triangles, its lightmap UVs covering the whole map.
const baked = await bakeMeshLightmap(
  {
    positions: new Float32Array([0, 0, 0, 4, 0, 0, 4, 0, -4, 0, 0, -4]),
    uv1: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  },
  {
    width: 64, // height defaults to width
    lights: [{ type: 'point', position: [2, 2, -2], intensity: 8 }],
    occluders: [{ positions: new Float32Array([1, 1, -1, 3, 1, -1, 2, 1, -3]) }], // casts shadows, not baked
  },
);
baked.lightmap; // RGBA8, light / baked.lightmapScale; alpha 0 where no chart reaches
baked.irradiance; // Float32 RGB per texel, HDR
```

- **Coverage.** Each triangle is rasterized in texel space conservatively: every texel whose cell it overlaps by more
  than 1e-3 texels (Hasselgren, Akenine-Moller and Ohlsson 2005). A texel whose centre is inside samples that surface
  point; a border texel samples the triangle's point nearest its centre, the nearest triangle winning, so chart
  edges are lit to their outer texels and thin slivers still get texels. `triangle` names each texel's source.
- **Lighting.** The same lights, shadows, AO and `radiometry` as `bakeLightmap`, traced through `@margoengine/bvh`
  against the mesh and `occluders`. Normals are interpolated from `normals` when given, else each triangle's own.
  Point and spot shadows skip the receiving triangle; other rays start `bias` (default 0.001) off the surface.
- **Dilation.** `dilate` passes (default 2) give each empty texel next to a chart the mean of its filled neighbours,
  so bilinear filtering at chart borders reads light, not black. Leave at least that many texels between charts.
- **Checks.** UVs must be 0 to 1; `overlaps` counts texels inside two triangles (overlapping charts) and `degenerate`
  the triangles with no UV area (they still cast shadows). Size (`width`, `height` up to 2,048), texels, rays and
  bytes are checked before tracing; inputs are copied before the first await; `signal` and `onProgress` run every
  256 texels.

## Directional lightmaps: `@margoengine/lightmap/directional`

`bakeDirectionalLightmap(mesh, options)` takes the `bakeMeshLightmap` mesh and options and returns the same lightmap
plus, per texel, the main light direction (world space; `directionMap` stores it 0.5-biased with the directionality in
alpha) and a directional colour (`directionalMap`, divided by `directionalScale`). Normal maps then still answer baked
light: `directionalIrradiance(baked, texel, mappedNormal, vertexNormal)` gives `irradiance + directional *
(max(0, n . d) - max(0, n0 . d))`, exact at the vertex normal and exact for any normal when one light plus ambient
reaches the texel. The direction is the luminance-weighted mean of the light directions (Sloan 2008's optimal linear
direction); ambient light and AO stay non-directional. The flat `lightmap` is the one `bakeMeshLightmap` bakes, with
no extra rays.

## Progressive GPU baking: `@margoengine/lightmap/gpu`

`GPULightmapBaker` bakes the same meshes as `./mesh` in WebGPU compute. Each `step()` adds passes and `texture` (an
`rgba16float` texture at the lightmap size) holds the running mean, so a viewer can draw it while it improves.

```ts
import { bakeMeshLightmapGPU, GPULightmapBaker } from 'margoengine/lightmap/gpu';

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter!.requestDevice(); // or pass an engine: its `gpu` is used
const mesh = {
  positions: new Float32Array([0, 0, 0, 4, 0, 0, 4, 0, -4, 0, 0, -4]),
  uv1: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};
const options = {
  width: 64,
  radiometry: 'physical' as const,
  bounces: 2,
  lights: [{ type: 'directional' as const, direction: [0.3, 1, 0.2], intensity: 2 }],
};
{
  using baker = await GPULightmapBaker.create(device, mesh, options);
  for (let i = 0; i < 8; i++) await baker.step(8); // sample baker.texture between steps to watch it converge
  const baked = await baker.read(); // the same record as bakeMeshLightmap
  console.log(baker.passes, baked.lightmapScale);
}
const done = await bakeMeshLightmapGPU(device, mesh, { ...options, passes: 128 });
console.log(done.samples);
```

- **Per pass, per texel.** A shadow ray to each light (the same falloff, cone and shadow rules as the CPU bake) and
  one cosine-weighted path: its first ray is the AO sample, and with `bounces` (0 to 8, physical radiometry) each hit
  adds `albedo` times the light arriving there (next-event estimation). One pass equals the CPU direct light; more
  passes make AO and indirect light converge (Monte Carlo, error falling as one over the square root of passes).
- **Materials.** `albedo` (default 0.8 grey) for the mesh, and per occluder. Diffuse only.
- **Results.** `read()` averages, dilates and encodes like `bakeMeshLightmap`. `passes` counts the passes run.
  Dispose the baker (`using`, or `[Symbol.dispose]()`) to free its buffers, texture and tree.

## Probes for moving objects: `@margoengine/lightmap/probes`

`bakeLightProbes({ volume, room, lights })` bakes a box of irradiance probes (one at each cell centre of
`volume.counts`) from the same lights and geometry as a mesh bake, so characters match the baked room. Each probe is
order-3 spherical harmonics (27 floats, `SH3` layout) of the shadowed direct lights plus gather rays that read the
room's baked lightmap where they hit it (`albedo * irradiance / pi`) and the ambient lights where they escape.
`probeIrradiance(grid, position, normal)` reads the irradiance trilinearly, in the same units as a physical lightmap.

## More light: `@margoengine/lightmap/global`

`bakeGlobalLightmap(quads, options)` takes every `bakeLightmap` option and adds:

- `areaLights`: rectangle lights, the same `RectAreaLight` objects as `@margoengine/clustered/area`, with
  `areaSamples` shadow rays per texel.
- `emissiveLights`: emissive quads light the others; with a `surface` callback, each emitting texel is its own light.
- `bounces` (0 to 2) and `bounceRays`: diffuse indirect light, as per-quad averages (coarse radiosity).
- `transmission`: quads with albedo alpha below 1 cast no shadows.
- `glassVolumes`: closed convex volumes made of bake quads cast coloured shadows (Fresnel at each boundary, Beer
  absorption inside). Light goes straight through: no refraction or caustics.

## Caustics: `@margoengine/lightmap/refracted`

`bakeRefractedLightmap(quads, {glassVolumes, emitters})` traces photons from point lights, finite directional beams and
rectangle lights through ideal smooth convex glass (Snell refraction, Fresnel reflection, total internal reflection,
Beer absorption, nested volumes) and deposits them at the first receiver they reach after touching glass. It returns
the native atlas with physical irradiance in its lightmap, the irradiance and hit counts per pixel, and `diagnostics`
that account for every emitted watt (deposited, escaped, absorbed, truncated, unrefracted, blocked). Receivers are
opaque; there is no diffuse bounce, rough glass or dispersion.


## Cycles reference measurement

After building, run `node packages/lightmap/scripts/rival-bench.mjs` from the repository root.
Requires Blender at `C:\blender\blender.exe` (override `MARGO_BLENDER`); generated data stays outside
the repository in engine-bench/batch-168/data/cornell. The complete 15-face Cornell scene is baked
on the CPU with 128 samples. Physical irradiance MAE is 0.069543 over 881 texels, relative 0.211475.
This is an open accuracy loss; see [the comparison](../../docs/whitepaper/perf-vs-rivals.md).
