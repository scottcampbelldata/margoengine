# @margoengine/lightmap

Install `npm i margoengine` and import `margoengine/lightmap` (or this package alone: `npm i @margoengine/lightmap`, imported as `@margoengine/lightmap`; the two are the same module).

Bakes lightmaps on the CPU: one padded UV atlas for a quad mesh with shadowed direct light and ambient occlusion,
plus matching albedo, emission, normal and ORM textures. Built for exporting lit voxel and block models (each
`meshGrid` quad of `@margoengine/voxel-edit` is a parallelogram) to glTF or any engine. No GPU or DOM; optional and
tree-shakable, core and the stage never import it.

```ts
import { bakeLightmap } from 'margoengine/lightmap';

const atlas = await bakeLightmap(
  { positions, albedo }, // 12 floats per quad (p0, p1, p2, p3), RGBA per quad
  {
    texelsPerUnit: 4,
    lights: [{ type: 'directional', direction: [0.3, 1, 0.2], intensity: 2 }],
    onProgress: (done, total) => progress.update(done / total),
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
  atlas UVs are its own, one chart per quad. It does not read triangles, n-gons or a mesh's existing UVs, including the
  lightmap UVs `@margoengine/mesh-edit/modeling`'s `meshLightmapUVs` makes; those are ready for a future general-mesh
  baker but cannot be baked here today.
- **Asset record.** `lightingAsset(lightmap, terms)` returns a small record (scales, size, radiometry, baked terms) to
  store next to the textures, for example in glTF extras.

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
