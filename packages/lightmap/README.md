# @margoengine/lightmap

Bakes lightmaps on the CPU: one padded UV atlas for a quad mesh with shadowed direct light and ambient occlusion,
plus matching albedo, emission, normal and ORM textures. Built for exporting lit voxel and block models (each
`meshGrid` quad of `@margoengine/voxel-edit` is a parallelogram) to glTF or any engine. No GPU or DOM; optional and
tree-shakable, core and the stage never import it.

```ts
import { bakeLightmap } from '@margoengine/lightmap';

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
  through `@margoengine/bvh`. The lightmap is irradiance times occlusion, independent of albedo. Not included: indirect
  bounces, emissive surfaces as lights, area lights, transmission.
- **Textures.** Albedo is sRGB; emission, normal (tangent space, the quad's frame), ORM and AO are linear. Lightmap and
  emission store values divided by `lightmapScale` and `emissionScale` (each at least 1), so HDR light survives RGBA8.
- **Materials.** Per-quad `albedo`, `emission` and `roughnessMetalness`, or a `surface` callback that returns them per
  texel centre (procedural surfaces; a returned world-space normal goes into the normal texture).
- **Budgets.** Quads (32,768), texels (262,144 by default, up to 1,048,576), rays (16,777,216, up to 67,108,864), an
  estimate of bytes (192 MiB, up to 256 MiB) and the atlas side (2,048) are checked before any texture is allocated.
  Inputs are copied before the first await; `signal` and `onProgress` run every 256 texels.
