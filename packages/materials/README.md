# Margo Engine Materials

Import `margoengine/materials` from the `margoengine` package, or `@margoengine/materials` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Optional glTF clearcoat, sheen, specular color, anisotropy, iridescence, transmission, IOR, volume, and TypeScript node materials through `@margoengine/gltf-pro`'s material extension slot. This package is separate from the frozen core and stage facade, and importing `gltf-pro` does not import materials.

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf-pro';
import * as materials from 'margoengine/materials';

const stage = await createStage('#viewport', {backend: 'webgpu'});
const model = await loadGLTF(stage.engine, '/glass.glb');
const installation = materials.install(model);

// When the effect is no longer needed:
installation.dispose();
model.destroy();
stage.dispose();
```

`install(model)` is synchronous and registers its engine plugin automatically. It reads optional `KHR_materials_clearcoat`, `KHR_materials_sheen`, `KHR_materials_specular`, `KHR_materials_anisotropy`, `KHR_materials_iridescence`, `KHR_materials_transmission`, `KHR_materials_ior`, and `KHR_materials_volume` data from each primitive's material and uses the model's already loaded images. The baseline `loadGLTF` and `parseGLTF` APIs remain unchanged. Their existing validation rejects these extensions in `extensionsRequired`; use optional metadata for this explicit installation path.

Normalized author configuration is also supported: `material.clearcoat` uses `factor`, `roughnessFactor`, `clearcoatTexture`, `clearcoatRoughnessTexture`, and `clearcoatNormalTexture`. Normal texture metadata honors `clearcoatNormalTexture.scale`. `material.transmission` uses `factor`, `ior`, and `transmissionTexture`; `material.volume` uses `thicknessFactor`, `thicknessTexture`, `attenuationColor`, and `attenuationDistance`. Volume can also be nested in `material.transmission.volume`. Installation composes clearcoat and transmission into the same extension slot.

For caller-provided resources, `clearcoat(options)` returns a `MaterialExtension` that can be assigned to `model.primitives[i].extension`:

```ts
import {clearcoat} from 'margoengine/materials';

const extension = clearcoat({factor: 1, roughnessFactor: 0.05});
```

`ClearcoatOptions` supports the two factors and three optional textures. Each `ClearcoatTexture` contains a `view`, an optional `sampler`, and an optional `texCoord` (`0` or `1`); the normal texture also accepts `scale`. A `transform` accepts glTF-style `offset`, `rotation`, `scale`, and overriding `texCoord`. A view without a sampler uses nearest sampling with clamped UVs at mip level `0`. Views and samplers supplied to `clearcoat()` stay caller-owned.

Clearcoat adds a second GGX specular lobe with dielectric F0 `0.04`. As KHR_materials_clearcoat defines it, everything under the coat (direct, local, ambient and emitted light) keeps `1 - clearcoat * F(n.v)`, 0.96 of itself at normal incidence and 0.73 at n.v 0.25 with clearcoat 1, and the coat adds its own directional and ambient light on top, the ambient from the same `margoCoatAmbient` as gltf-pro's native materials, so an environment lights it. Its normal affects only the coat; the base shading and g-buffer normal are unchanged, so SSAO and shadows continue to use the base normal. Clearcoat factor `0` preserves the baseline material.

The package supports clearcoat factor, roughness, and the optional clearcoat factor, roughness, and normal textures. Missing factor and roughness default to `0`; missing textures do not allocate samplers. Lighting retains bind group 2, while clearcoat resources use the optional material bind group 3.

The [Khronos clearcoat specification](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_materials_clearcoat) defines the metadata and texture channels: factor uses red, roughness uses green, and the coat normal uses RGB. Extension textures use linear data. Installed clearcoat, transmission and thickness textures support KTX2, `KHR_texture_transform`, and both UV sets; affine rows share group 3 with lobe factors.

The coat receives directional lighting and its shadow visibility. Clustered point lights continue to illuminate the base lobe; this step does not add a clearcoat contribution from those lights.

## Sheen, specular, anisotropy and iridescence

The four additional glTF lobes share group 3 with clearcoat and transmission.
`install(model)` reads the standard Khronos fields, or normalized
`material.sheen`, `material.specular`, `material.anisotropy`, and
`material.iridescence` objects using the factory options below. No material
metadata creates an installation plan on an ordinary PBR primitive.

```ts
import {materialLobes, clearcoat} from 'margoengine/materials';

primitive.extension = materialLobes({
  sheen: {colorFactor: [0.4, 0.1, 0.05], roughnessFactor: 0.5},
  specular: {factor: 0.8, colorFactor: [1, 0.8, 0.5]},
  anisotropy: {strength: 0.5, rotation: Math.PI / 4},
  iridescence: {factor: 0.6, ior: 1.3, thicknessMinimum: 100, thicknessMaximum: 400},
}, clearcoat({factor: 0.2}));
```

`sheen(options, base?)`, `specular(options, base?)`, `anisotropy(options, base?)`,
and `iridescence(options, base?)` are single-lobe conveniences. `base` can be an
existing extension, including a compiled node material; its factors, textures,
clearcoat and output hooks are retained. Repeated lobe factories combine their
options in one shader. The top-level `ior` configures the supplied lobes' substrate,
default 1.5; use `materialLobes({ior: 2, specular: {}})` for an IOR-only dielectric
change. Installation reads `KHR_materials_ior` for it. Iridescence's own `ior` selects the
thin film instead, default 1.3.

| Lobe | Options and defaults | Texture channels |
| --- | --- | --- |
| Sheen | `colorFactor: [0,0,0]`, `roughnessFactor: 0` | `sheenColorTexture`: sRGB RGB; `sheenRoughnessTexture`: linear A |
| Specular | `factor: 1`, `colorFactor: [1,1,1]` | `specularTexture`: linear A; `specularColorTexture`: sRGB RGB |
| Anisotropy | `strength: 0`, `rotation: 0` radians | `anisotropyTexture`: linear RG direction remapped to [-1,1], B strength |
| Iridescence | `factor: 0`, `ior: 1.3`, `thicknessMinimum: 100`, `thicknessMaximum: 400` nm | `iridescenceTexture`: linear R; `iridescenceThicknessTexture`: linear G interpolates endpoints |

All maps support UV0/UV1, texture transforms, and installed KTX2 images.
Caller-owned map views use the existing `view`, optional `sampler`, `texCoord`
and `transform` interface. Color views must decode sRGB; installation creates
the appropriate sRGB views automatically. A missing thickness map uses the
maximum thickness. Specular colors may exceed 1, with dielectric F0 clamped as
specified by glTF. Shared view/sampler pairs reuse bindings; complete materials
must fit the device's texture and sampler limits. Oversized combinations fail
before allocating their secondary uniform.

Zero sheen color, zero anisotropy and zero iridescence preserve the baseline
render bit for bit. Specular's neutral value is factor 1 with white color:
**factor 0 removes the dielectric reflection**, as required by glTF. Metals are
unaffected by specular factor/color. Uniform values can change without creating
another pipeline; changing texture/UV shapes or the substrate IOR changes the shader signature.

Sheen uses a Charlie distribution, Neubelt visibility and analytic directional
albedo scaling. Anisotropy uses tangent-space GGX and a stable derivative frame
when needed. Iridescence evaluates thin-film Fresnel with two spectral harmonics
and CIE color integration. These lobes affect the directional BRDF and the
renderer’s fixed hemisphere approximation. Anisotropy does not change that
hemisphere approximation. Clustered and environment lighting retain their base
PBR response. Clearcoat remains on top of the underlying lobes; transmission
retains its existing single-sample screen-space model.

The sheen and thin-film terms are written from the KHR_materials_sheen and
KHR_materials_iridescence specifications (Estevez and Kulla 2017; Belcour and Barla
2017); the sheen albedo fit is our own (`scripts/sheen-albedo-fit.mjs`). Run
`node scripts/materials-lobe-tests.js` for quantitative GPU and parity checks;
the complete-asset runner also checks original Khronos models.

Positive transmission opts into a shared opaque-color capture. All opaque and masked PBR primitives, including those from other models, render before the snapshot; blended primitives render afterward. The snapshot preserves the scene format and supports 1x or 4x MSAA, including an existing HDR capture. No frozen core or stage pass is changed. Transmission factor `0` leaves the opaque material and its allocation path unchanged.

Transmission defaults to factor `0` and IOR `1.5`. Its optional texture multiplies the factor using the red channel. The IOR also sets the surface's reflection, F0 = ((IOR - 1) / (IOR + 1))^2 (KHR_materials_ior: 0.04 at 1.5, none at 1), and lobes such as sheen or specular keep only the untransmitted share of their diffuse light, so a fully transmissive IOR `1` surface shows exactly what is behind it. The transmitted light is layered as glTF specifies: it is scaled by 1 - specular x max(Fresnel) (`KHR_materials_specular`), by the sheen's 1 - max(colour) x E(n.v) (`KHR_materials_sheen`) and by the coat's 1 - clearcoat x Fresnel (`KHR_materials_clearcoat`), in linear light. A sheen therefore dims the view through the surface even at IOR `1`. On a display-encoded target the lit colour and the transmitted light add in linear light, so encoded 0.5 over encoded 0.5 reads 0.69, and where either is zero the other stays bit for bit. Refraction samples the opaque color already rendered this frame; IOR `1` samples the same pixel without bending. This is screen-space transmission with one background sample. It does not trace rays or produce multiple bounces.

Thin glass (no or zero volume thickness) keeps its sightline: it samples the pixel behind it, as glTF specifies. Only positive thickness bends the view along a refraction path. Off-screen coordinates clamp to the image edge, and transparent layers are absent from the opaque snapshot.

Volume requires positive transmission; otherwise installation throws `KHR_materials_volume requires transmission`. Thickness defaults to `0`, and its optional texture uses the green channel. Beer's law attenuates the transmitted color using `attenuationColor` (default `[1, 1, 1]`) and `attenuationDistance`. A missing distance or `Infinity` leaves the transmitted color unattenuated. There is no participating-media scattering. Transmission and thickness maps accept UV0 or UV1 and use linear data.

Transmissive primitives draw after the opaque capture (`afterOpaque: true`) and keep their authored alpha mode: OPAQUE
and MASK surfaces keep their coverage and depth writes, BLEND surfaces blend. They do not cast shadows or receive the
cascaded shadow map in this version. A clearcoat lobe on the same transmissive material follows this shadow limitation.

For a caller-owned screen capture, `transmission(options)` returns an extension without installing a scene pass:

```ts
import {transmission} from 'margoengine/materials';
import type {PBRPrimitive} from 'margoengine/gltf-pro';

function applyTransmission(primitive: PBRPrimitive, opaqueTexture: GPUTexture) {
  primitive.extension = transmission({
    factor: 1,
    ior: 1.5,
    opaqueColor: opaqueTexture.createView(),
    volume: {thicknessFactor: 0.1, attenuationColor: [0.8, 1, 1], attenuationDistance: 1},
  });
}
```

The caller renders opaque and masked geometry into `opaqueColor` before this primitive. The view and optional transmission/thickness textures stay caller-owned; textures use the same `view`, optional `sampler`, and `texCoord` interface as clearcoat.

`installation.dispose()` and its `destroy()` alias release installation-owned resources and restore the extension slots
the installation still owns; alpha mode and cutoff are never changed. Destroying the model also cleans up the
installation. The opaque snapshot is shared per engine and released with its final installation. Device restoration
recreates installation-owned glTF texture uploads and capture resources. Caller-owned views and samplers require fresh
GPU resources and extension reassignment or reinstallation after device restoration.

## Atlas (`@margoengine/materials/atlas`)

`packAtlas` and `transformUVs` (also on the root) without the material classes or gltf-pro, for bakers that only pack
images (`@margoengine/lightmap` does).

`padTileGrid(image, {tileWidth, tileHeight, padding = 2, margin = 0, spacing = 0})` pads a texture that is already a
grid of equal tiles (a tileset): each tile is laid out again with `padding` copies of its own border pixels around it,
so linear filtering and the first mip levels sample the tile's own edge instead of its neighbour, with no seams and
no bleeding. `margin` and `spacing` are the source's gutters (as Tiled names them) and are dropped. Tile pixels are
kept exactly; `regions[row * columns + column]` maps a tile's 0-1 UVs onto it, counted from the top-left tile.
`remapTileUVs(uvs, tiles, grid, source)` moves UVs written for the source grid onto the padded one, given each
vertex's tile index.

```ts
import {padTileGrid, remapTileUVs} from 'margoengine/materials/atlas';

declare const tileset: {data: Uint8Array; width: number; height: number};
declare const uvs: Float32Array, tileOfVertex: Uint32Array;
const grid = padTileGrid(tileset, {tileWidth: 16, tileHeight: 16, padding: 2});
const padded = remapTileUVs(uvs, tileOfVertex, grid, {width: tileset.width, height: tileset.height});
```

## Node materials

`nodeMaterial(graph, options?)` compiles a small TypeScript object graph into one `MaterialExtension`. Connect nodes by object reference, list at least the output in `graph.nodes`, then assign the result to a primitive or material's extension slot:

```ts
import {nodeMaterial} from 'margoengine/materials';
import type {PBRPrimitive} from 'margoengine/gltf-pro';

function applyBlueMaterial(primitive: PBRPrimitive) {
  primitive.extension = nodeMaterial({nodes: [{
    type: 'emit',
    color: {type: 'color', value: [0.2, 0.6, 0.9, 1]},
    clearcoat: {
      type: 'clearcoat',
      factor: {type: 'scalar', value: 1},
      roughness: {type: 'scalar', value: 0.05},
    },
  }]});
}
```

`emit.color` enters the existing PBR surface and its lighting; it is not an unlit emission output. Node materials replace the base color, default to metal `0`, roughness `1`, zero emissive, and full occlusion; `metalRough` supplies either or both factors. The existing normal remains unless `emit.normal` supplies a normal map. Color and scalar constants use the extension's separate factors block, while graph textures use its group 3 bindings. Compilation allocates no GPU resources. Views and samplers remain caller-owned.

The supported nodes are a closed set:

| Node | Inputs and result |
| --- | --- |
| `color` | `value: [r, g, b, a]` produces a linear `vec4`. |
| `scalar` | `value: number` produces an `f32`. |
| `texture` | `texture: {view, sampler?}` and optional `texCoord: 0 \| 1` produce a sampled `vec4`. |
| `add`, `mul` | Component-wise arithmetic over `a` and `b`. Scalar inputs broadcast to a vector input. |
| `mix` | Component-wise interpolation of `a` and `b` by `factor`; the factor is scalar or matches the result's width. |
| `normalMap` | Decodes `texture` (a vec4 node) in the existing tangent frame, with optional scalar `scale` and `texCoord`. |
| `metalRough` | Optional `roughness`, `metal`, and packed vec4 `texture` supply roughness G and metal B. |
| `clearcoat` | Optional `factor`, `roughness`, and independent `normal` use the same clearcoat lobe as glTF installation. |
| `transmission` | Optional `factor`, scalar `ior`, and `volume` use the same transmission and volume implementation as glTF installation. |
| `emit` | Required, unique output with `color` and optional `normal`, `metalRough`, `clearcoat`, and `transmission`. |

For lobe inputs, a vec4 factor uses R, roughness and thickness use G, and metal uses B. Scalar inputs use their single value. `volume` accepts `thickness`, `attenuationColor`, and `attenuationDistance`, with the same defaults and restrictions as glTF volume. A texture without a sampler uses the existing nearest, clamped sampling path. Select UV0 or UV1 explicitly for a normal map when its input graph samples that UV set.

An output can reference nested nodes absent from the root list. All listed nodes are validated, including disconnected ones. Reuse an object to share a node. Cycles, multiple or missing outputs, unknown node types, incompatible input types, arbitrary WGSL, and requests for custom vertex attributes throw. The vertex format remains position, normal, tangent, UV, and color. This graph is a TypeScript authoring API; it does not import shader graphs saved by other tools.

`installNodeMaterial(model, graph)` installs one graph on the model and automatically registers a plugin. Graph transmission acquires the same shared opaque-color capture as glTF transmission and sets the affected primitives to the existing blend path:

```ts
import {installNodeMaterial} from 'margoengine/materials';

const installation = installNodeMaterial(model, {nodes: [{
  type: 'emit',
  color: {type: 'color', value: [1, 1, 1, 1]},
  transmission: {
    type: 'transmission',
    factor: {type: 'scalar', value: 1},
    ior: {type: 'scalar', value: 1.5},
    volume: {
      thickness: {type: 'scalar', value: 0.1},
      attenuationColor: {type: 'color', value: [0.8, 1, 1, 1]},
      attenuationDistance: 1,
    },
  },
}]});

installation.dispose();
```

The installation restores replaced extensions and blend modes when disposed and releases its capture reference. For direct compilation of a transmissive graph, pass `nodeMaterial(graph, {opaqueColor})`, render the opaque snapshot before drawing, and set the material's `settings[0]` to `2`, as with `transmission()`. A constant zero transmission factor does not acquire a capture; compile a new graph to activate transmission after changing that constant. Screen-space refraction, volume, shadow, and device-restoration limits above apply equally to node materials. A caller needing custom WGSL can write a `MaterialExtension` directly.

## Material classes and live use

Each shading model has a class: a `Material` with its `shading` fixed and its options typed to what that model reads.
`new Material({shading})` keeps working; every class tree-shakes on its own.

| Class | `shading` | Reads |
| --- | --- | --- |
| `UnlitMaterial` | `basic` | colour, maps, emissive; no lighting |
| `LambertMaterial` | `lambert` | diffuse lighting only |
| `PhongMaterial` | `phong` | Lambert plus `specular` and `shininess` |
| `PbrMaterial` | `standard` | metallic-roughness, maps and the physical options |
| `NormalMaterial` | `normal` | view-space normals as colour |
| `MatcapMaterial` | `matcap` | the `matcap` texture |
| `DepthMaterial`, `DistanceMaterial` | `depth`, `distance` | packed depth or distance (below) |
| `ShadowCatcherMaterial` | `lambert` (its own output) | `color`, `opacity`: only the shadows it receives (below) |

`PbrMaterial` shares its name with core's colour-only `PbrMaterial` and takes every core option (`color`,
`roughness`, `metalness`, `doubleSided`) with the same meaning. Its defaults are a textured material's (white,
roughness 1, metalness 0, front side), so a `map` shows its own colours; core's placeholder defaults (indigo,
double-sided) are only core's.

Everything is live on a `createMesh` mesh, from the next frame:

```ts
import {PbrMaterial, PhongMaterial, createMesh, loadTexture} from 'margoengine/materials';

const tiles = await loadTexture('/tiles.png', {magFilter: 'nearest'});
const paint = new PhongMaterial({color: 0x84d6bd, map: tiles});
const mesh = createMesh(engine, geometry, paint);
paint.color.set('#ff8800');       // or paint.color = 0xff8800; strings and numbers are sRGB, arrays linear
paint.blending = 'additive';      // render state picks the matching pipeline
paint.wireframe = true;
mesh.material = new PbrMaterial({map: tiles}); // swap
mesh.renderOrder = 2;
tiles.magFilter = 'linear';       // sampler options: next frame
const copy = paint.clone();
paint.dispose();
```

- `mesh.material = other` swaps a single-material mesh; a grouped mesh takes an array of the same length (reading it
  gives a frozen snapshot). The model, geometry, transform, render order, skin and every shadows, clustered, fog,
  IBL, SSAO, OIT and selection registration stay; transparent sorting and picking follow the new material. Each
  material's per-engine uniforms are retained while a mesh uses it and released with its last use.
- `color`, `emissive` and `specular` are the live linear arrays meshes read (element writes work); `set(input)` and
  assignment take `'#rrggbb'`, `'#rgb'`, `0xrrggbb` (sRGB) or linear `[r, g, b]` (keeps opacity) / `[r, g, b, a]`.
  Every colour option, including the physical ones, takes numbers.
- Render state is live: `blending`, `depthWrite`, `depthTest`, `colorWrite`, `polygonOffset*`, the stencil options and
  `wireframe`. Returning to the defaults reuses the original pipeline; a `stencilRef` change alone keeps its pipeline.
- `clone()` makes an independent material of the same class sharing only textures; `copy(source)` writes a
  same-shading source's values into this one in place; `dispose()` frees what no live mesh uses, after which
  `createMesh` and `mesh.material =` refuse it (MargoError `disposed`). Textures stay the caller's.
- `Texture` options are live too: `magFilter`, `minFilter`, `wrapS`, `wrapT` and `anisotropy` rebuild the sampler on
  next use; `flipY`, `colorSpace` and `mipmaps` apply on the next `update()`, which then uploads the whole source.
- Physical options and maps enable on demand (below); `mesh.renderOrder` is live.

## Meshes with two UV sets and material groups

`createMesh(engine, geometry, material)` draws CPU geometry through glTF-pro's PBR renderer. `MeshGeometry` accepts
`positions`, `normals`, optional `indices`, `uvs` (UV0), `uvs1` (UV1), `tangents` and RGB/RGBA `colors`. Both UV arrays
contain two finite values per vertex. UV0 defaults to zero; omitted UV1 copies UV0. The vertex layout remains 80 bytes.

```ts
import {Material, createMesh, loadTexture} from 'margoengine/materials';

const surface = new Material({aoMap: await loadTexture('/occlusion.png')});
surface.setUVTransform({texCoord: 1}, 'aoMap');
const mesh = createMesh(engine, {
  positions: [-1,-1,0, 1,-1,0, 1,1,0, -1,1,0],
  normals: [0,0,1, 0,0,1, 0,0,1, 0,0,1],
  uvs: [0,0, 1,0, 1,1, 0,1],
  uvs1: [0.25,0.25, 0.75,0.25, 0.75,0.75, 0.25,0.75],
  indices: [0,1,2, 0,2,3],
  groups: [
    {start: 0, count: 3, materialIndex: 0},
    {start: 3, count: 3, materialIndex: 1},
  ],
}, [surface, new Material({color: '#4488ff'})]);
mesh.root.setPosition([0, 1, 0]);
```

`setUVTransform(transform, slot?)` selects UV0 or UV1 with `texCoord` as well as offset, scale and rotation. Without a
slot it updates every map except `matcap`, including maps assigned later; `null` restores UV0 and the identity transform. Updates take effect next frame.
Normal maps selected from UV1 or transformed UVs derive their tangent frame from those coordinates. Without `tangents`
the derived frame assumes a bottom-left UV origin: a normal map's +Y (green) points toward increasing v, up a `flipY`
image, as it does with tangents whose bitangent `cross(normal, tangent) * w` runs along increasing v. glTF assets keep
glTF's convention (decreasing v, texture origin at the image's top-left). An extension assigned to a materials mesh's
`primitives[i].extension` follows the mesh: a `clearcoat()` normal texture, a `materialLobes()` anisotropy direction
and a `nodeMaterial()` / `installNodeMaterial()` normalMap take that bottom-left orientation there (upload their views with
`flipY`, as `Texture` does) and glTF's on a loaded glTF model.

A material array requires at least one group. Each group has a nonnegative integer `materialIndex` into that array,
and triangle-aligned `start` and positive `count` in index units, or vertex units without indices. Ranges must fit and
must not overlap; gaps are omitted. A single material keeps drawing the whole geometry and ignores groups.
`mesh.material` is that single material, or a frozen snapshot of the supplied array; the materials themselves stay
live, and assigning swaps them (see above).

Groups become primitives of one `PBRModel`, share packed vertices and GPU vertex buffers, and move with one root.
`createInstancedMesh(engine, geometry, materials, capacity)` uses the same groups and shares one live `instances`
object across every primitive. Opaque groups draw before blended groups across the materials queue; transparent
ordering still uses the model's node distance, not individual triangles. Group bounds conservatively include all vertices.
Picking either group returns the shared mesh node. The existing shadows, lighting, SSAO and exporter adapters accept
the model; shadows follow `map` and `alphaMap` cut-outs under `alphaTest`. Picking, contact shadows and TAA velocity follow
`displacementMap` and `clippingPlanes` too: a click through a clipped part misses. `clipShadows: false` leaves shadows whole
and still clips picking and TAA, which follow the surface. Export preserves group materials and UV1.

Packing is cached by geometry identity: finish editing attributes before the first call to `packGeometry` or mesh
creation, and use a new geometry object for changed attributes, or edit a live mesh with `setGeometry`.

`mesh.setGeometry(geometry)` repacks the edited (or a new) geometry into the same mesh: materials, transform, render
order and shadow, clustered, SSAO and selection registrations stay. GPU buffers are rewritten while the data fits
and reallocated at twice their size when it outgrows them, so repeated edits stop allocating. Group ranges may move
and resize; their number and material slots must stay (create a new mesh to change them). For a same-sized edit,
`mesh.setGeometry(geometry, {start, count})` repacks and uploads only those vertices (indices and groups are not
read), for example a tile's four UVs each frame. Raycasts, `worldTriangles`, stage bounds and exports see the new
data at once. An edited mesh casts shadows as a dynamic caster from then on, and static same-material batches of
its groups are retired.

```ts
const geometry = {positions, normals, uvs, indices};
const mesh = createMesh(engine, geometry, tiles);
geometry.uvs.set([0.5, 0, 0.75, 0, 0.75, 0.25, 0.5, 0.25], 8); // vertices 4-7
mesh.setGeometry(geometry, {start: 4, count: 4}); // uploads 320 bytes
mesh.setGeometry({positions: more, normals: moreNormals, uvs: moreUvs, indices: moreIndices}); // resize
```

`mesh.dispose()` releases model resources; textures
remain caller-owned. Device restoration rebuilds the model and texture bindings. Constructed material shading cannot
be copied to another GPU device without rebuilding its material resources. Core and the stage facade are unchanged.

## Many meshes and instances

Meshes made with `createMesh` that share a material and a geometry object draw together: each frame the queue draws
all of them in one render pass, derives the material's shader and pipeline once, and draws the opaque ones as one
instanced draw whose rows are the meshes' world matrices (a moved mesh uploads its own 96-byte row; a camera move
uploads 192 bytes). Nothing changes in how you create, move, hide, swap or dispose them, and each mesh stays its own
object for picking, shadows and export. A mesh with a material extension, transmission, wireframe or instances of its
own draws on its own. Opaque meshes may draw in another order than they were created (as other engines sort opaque
draws by material); transparent ones keep their back-to-front order.

For many copies under one node, `createInstancedMesh` keeps them in one `instances` object; `setMatrices` writes many
rows at once:

```ts
import { Engine } from 'margoengine/core';
import { Material, createInstancedMesh } from 'margoengine/materials';
import { boxGeometry } from 'margoengine/geometry';

declare const canvas: HTMLCanvasElement;
const engine = await Engine.create(canvas);
const boxes = createInstancedMesh(engine, boxGeometry(1, 1, 1), new Material({ color: '#4080c0' }), 1000);
const matrices = new Float32Array(1000 * 16);
for (let i = 0; i < 1000; i++) matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (i % 40) * 2, 0, Math.floor(i / 40) * 2, 1], i * 16);
boxes.instances.setMatrices(0, matrices);
```

## Animated tiles

A tile animation (Crocotile 3D's per-tileset UV animation) is a looping list of frames, each with a duration in
seconds and the four corner UVs of its tile. `tileAnimationFrame(animation, time, start?)` returns the frame shown at
`time`, deterministic and looping in both directions; a time on a boundary shows the next frame. `start` is a frame
(`{frame: 2}`) or an offset in seconds (`{seconds: 0.4}`, a tile's custom start time). Durations must be finite and
greater than zero.

`tileAnimator(mesh, geometry, tiles)` plays them on a `createMesh` mesh whose tiles are four consecutive vertices:
each call writes the changed tiles' corner UVs into `geometry.uvs` and uploads only those vertices, one range per run
of neighbouring tiles. Tiles whose frame did not change upload nothing. Reading the animation file format is the
application's job.

```ts
import {createMesh, tileAnimator} from 'margoengine/materials';

const water = {frames: [
  {duration: 0.2, uvs: [0, 0, 0.25, 0, 0.25, 0.25, 0, 0.25]},
  {duration: 0.2, uvs: [0.25, 0, 0.5, 0, 0.5, 0.25, 0.25, 0.25]},
]};
const mesh = createMesh(engine, geometry, tileset); // geometry.uvs is a number[] or Float32Array
const play = tileAnimator(mesh, geometry, [{vertex: 0, animation: water}, {vertex: 4, animation: water, start: {frame: 1}}]);
engine.onFrame(() => play(performance.now() / 1000));
```

## Painting textures

`texture.update()` re-uploads the whole source (canvas, ImageData, ImageBitmap, VideoFrame or raw
`{data, width, height}`) on next use. `texture.update({x, y, width, height})` uploads only that rectangle of the
current source, in its top-left pixel coordinates, to the rows the full upload would use: `flipY` (default true)
flips external sources, while raw data and ImageData rows are never flipped, exactly as in the full upload. The
colour space and texture are unchanged. Rectangles updated between two frames upload as their bounding rectangle.
Without mipmaps nothing else runs; with mipmaps the whole chain regenerates on the GPU (one draw per level).

```ts
const canvas = new OffscreenCanvas(1024, 1024);
const atlas = new Texture(canvas, {magFilter: 'nearest', mipmaps: false});
canvas.getContext('2d')!.fillRect(32, 48, 16, 16); // a brush stroke
atlas.update({x: 32, y: 48, width: 16, height: 16}); // uploads 16x16 pixels
```

## Front, back and double sides

`new Material({side: 'back'})` draws only the triangle's back side. `side` accepts `front` (default), `back` or
`double` and stays live, including shared materials, groups and instances. Explicit `side` wins over the legacy
`doubleSided` constructor option. Reading `doubleSided` is true only for `double`; assigning it selects `double`
or `front`. Mirrored transforms preserve the triangle's local front side. Normals on visible back faces follow
the same orientation as double-sided rendering, including normal maps and diagnostic shading.

GPU picking and CPU BVH queries follow the same side. Shadow casting retains the existing two-sided caster
policy. Export bakes back-only triangles by reversing their winding and normals because glTF has no back-side
material flag. Core materials keep their existing API.

## Wireframe

`new Material({wireframe: true})` draws triangle edges with native WebGPU lines. `wireframe` defaults to `false`
and is live. Geometry groups and instanced meshes use each group's material setting.
Edges include triangulation diagonals; shared triangle edges can be drawn more than once. Wide-line thickness
controls are not provided.

Wireframe alone keeps the existing render-state and transparency paths. The original triangle geometry remains
available to picking and glTF export. `material.wireframe` (and, on a materials mesh, `primitive.material.wireframe`,
which writes the material) changes subsequent draws without replacing the source triangle data.
Beauty, auxiliary and shadow passes use the same edges, including deformed vertices. Lines ignore triangle
face culling and polygon offset. Directional casters explicitly registered with `{static: true}` keep their
manual update policy: call `Shadows.invalidate()` after changing the native flag.

## Polygon offset and stencil

`polygonOffset`, `polygonOffsetFactor`, `polygonOffsetUnits` and `polygonOffsetClamp` are live.
Positive factors and units push polygons away from the camera; negative values pull them forward. Signs are
converted for reverse-Z. Units must be integers within ±2147483647; factor and clamp must be finite as float32.
Clamp defaults to zero (unclamped). Points and lines ignore polygon offset.

Enable `stencilWrite` to apply stencil comparison and operations. `stencilFunc` defaults to `always`;
`stencilFail`, `stencilZFail` and `stencilZPass` default to `keep`. These use WebGPU comparison/operation names.
`stencilRef` defaults to zero; `stencilReadMask` and `stencilWriteMask` default to `0xff`. Masks and references
accept unsigned 32-bit integers; the attachment's eight stencil bits determine the effective value.
Use `stencilWriteMask: 0` for comparison without changing stencil. These properties are live; a `stencilRef` change
alone keeps its pipeline (the reference is set per draw).

```ts
import {Material, StencilBuffer, createMesh} from 'margoengine/materials';

StencilBuffer.attach(engine);
const mask = new Material({
  colorWrite: false, depthWrite: false, depthTest: false,
  stencilWrite: true, stencilRef: 1, stencilZPass: 'replace',
});
const clipped = new Material({
  color: '#4488ff', stencilWrite: true, stencilRef: 1,
  stencilFunc: 'equal', stencilWriteMask: 0,
});
createMesh(engine, maskGeometry, mask, {renderOrder: -1});
createMesh(engine, geometry, clipped);
```

`colorWrite: false` suppresses color while retaining depth/stencil processing. `StencilBuffer` borrows a scene
stencil attachment or provides portable `depth24plus-stencil8` at the current size and 1x/4x sampling. Resources
are reused and handle resize, device restoration and disposal. The main scene clears stencil to zero each frame.
Stencil belongs to its attachment: captures and MSAA resolves copy depth, so masks do not cross target boundaries.
Explicit XR, probe and other offscreen renderers must provide their own stencil attachment; incompatible targets throw.

These controls affect beauty draws. G-buffer, ambient, occlusion/capture replays, picking and shadows retain their
existing behavior and do not reproduce stencil masks or polygon bias. Custom state uses the sorted beauty path,
including native transmission's two-pass tint fallback, instead of OIT or screen-space transmission hooks. The tint
tests stencil without writing; the lit draw performs each operation once. Exporters retain underlying materials and
geometry because glTF has no corresponding stencil or polygon-offset state.

Native `primitive.material.renderState` accepts WebGPU `depthBias`, `depthBiasSlopeScale`, `depthBiasClamp`,
`stencilFront`, `stencilBack`, `stencilReadMask`, `stencilWriteMask`, `stencilReference` and `colorWrite`.
Native bias keeps WebGPU's sign by default. `depthBiasMode: 'away'` interprets positive bias as away from the camera
on both the main reverse-Z renderer and forward-Z offscreen renderers; constructed materials use this mode.
Native stencil faces follow raster winding, including mirrored transforms.
The reference stays live per draw, resets to zero for draws without one, and reuses the pipeline.

## Lambert and Phong materials

`shading: 'lambert'` is diffuse only: `base/pi * n.l` times each light's irradiance plus `base` times the hemisphere
ambient, with no specular and no environment specular. `shading: 'phong'` adds a Blinn-Phong highlight (Blinn 1977, half
vector): `specular * (shininess + 2) / (8 pi) * (n.h)^shininess`, the microfacet BRDF of Blinn's distribution normalised
over projected microfacet area with an implicit geometry term. `specular` (default sRGB `#111111`) and `shininess`
(default 30, finite and >= 0) stay live. Base maps, vertex colours, emissive, `alphaTest`, `transparent`, sides and
UV transforms work as for `standard`; `basic` is the unlit choice. Roughness, metalness and the metal-roughness map
are ignored.

Both use the engine's directional light and ambient, and compose with shadows, fog and SSAO through gltf-pro's
lighting hooks. An environment (`EnvironmentLighting`, probes) adds only its diffuse part. Clustered point and spot
lights use the same Lambert and Blinn-Phong terms as the directional light. Rectangle area lights
(`@margoengine/clustered/area`) shade these surfaces as a dielectric of the matching roughness
(`(2 / (shininess + 2)) ** 0.25`, Walter et al. 2007; 1 for Lambert). `exportModel` writes both as metallic 0 with that
roughness.

```ts
const tiles = new Material({shading: 'phong', map: tileset, specular: '#222222', shininess: 12, alphaTest: 0.5});
tiles.shininess = 40; // live
```

## Depth and distance materials

`Material({shading: 'depth'})` writes projected depth, while `Material({shading: 'distance'})` writes world-space
distance from a reference point. Shading is fixed at construction; physical options require `standard` shading.

```ts
const depth = new Material({shading: 'depth'}); // basic: near white, far black
const distance = new Material({
  shading: 'distance', // rgba packing by default
  referencePosition: [0, 0, 0], nearDistance: 1, farDistance: 1000,
});
distance.referencePosition = [2, 0, 0];
distance.farDistance = 2000;
distance.depthPacking = 'basic';
```

`depthPacking` accepts `basic` or `rgba` and stays live. Basic depth uses the renderer's reverse-Z value, near 1
and far 0. RGBA depth packs forward depth (`1 - reverseZ`), near 0 and far 1; perspective depth remains nonlinear.
Distance normalizes `length(worldPosition - referencePosition)` with `(distance - nearDistance) /
(farDistance - nearDistance)`, clamped to [0, 1]. Its default RGBA packing stores that value; basic distance writes
the same value as grayscale, near black and far white. RGBA packing uses base 256 with R most significant, and
preserves exact zero and one endpoints. Its alpha channel contains packed data; basic outputs retain blend opacity.

Keep packed output opaque, or set `blending: 'none'` when `transparent` is enabled: encoded alpha must not become
blend coverage. Read all four channels from a render target that preserves alpha, before colour/post effects.
Use 1x sampling when decoding boundary pixels; an MSAA resolve averages packed bytes at geometry edges.

`referencePosition`, `nearDistance` and `farDistance` also stay live. The position defaults to `[0, 0, 0]` and is
copied on assignment and read; assign a new three-component tuple to move it. Components and distance bounds must
be finite as float32. Bounds default to 1 and 1000 and must satisfy `0 <= nearDistance < farDistance` after float32
conversion; constructor bounds are validated together, and each live edit must preserve that range.

These outputs bypass material lighting and gamma encoding. Textures affect alpha coverage through the existing
alpha test and UV transforms; texture RGB does not tint the depth or distance value. Geometry groups and instancing
use the same modes, with distance measured after world and instance transforms. Device restoration rebuilds their
bindings. One 32-byte uniform is shared by meshes using a material in an engine, reused across frames, and released
when the last mesh is disposed. Textures remain caller-owned.

## Physical maps on constructed materials

`Material` accepts these optional `Texture | null` properties alongside its physical factors:

| Properties | Channels and default colour space |
| --- | --- |
| `clearcoatMap`, `clearcoatRoughnessMap`, `clearcoatNormalMap` | R strength, G roughness, RGB tangent normal; linear |
| `sheenColorMap`, `sheenRoughnessMap` | sRGB RGB colour, linear A roughness |
| `specularIntensityMap`, `specularColorMap` | Linear A intensity, sRGB RGB colour |
| `transmissionMap`, `thicknessMap` | R transmission, G volume thickness; linear |
| `anisotropyMap` | RG direction remapped to -1…1, B strength; linear |
| `iridescenceMap`, `iridescenceThicknessMap` | R strength, G thickness within the film range; linear |

```ts
const glass = new Material({
  transmission: 1, thickness: 0.8,
  clearcoat: 1, clearcoatNormalMap: await loadTexture('/coat-normal.png'),
  thicknessMap: await loadTexture('/thickness.png'),
  attenuationColor: '#88bbff', attenuationDistance: 2,
});
glass.setUVTransform({texCoord: 1}, 'thicknessMap');
```

Maps multiply their corresponding factors; existing factor defaults remain unchanged. Clearcoat normals use
`clearcoatNormalScale` (default 1). Anisotropy uses `anisotropy` (default 0) and `anisotropyRotation` (radians,
default 0). Iridescence uses `iridescence` (default 0), `iridescenceIOR` (default 1.3) and
`iridescenceThicknessRange` (nanometres, default `[100, 400]`).

Physical and transmissive capabilities enable on demand: a physical option or non-null map set at construction or
later (standard shading only) makes that material physical, and from the next frame gltf-pro draws it with the
matching physical variant; materials that never use them keep the plain shader, uniform layout and queue phase. A
transmission or thickness map, like `transmission`, makes it transmissive even when its factor is zero. Volume values
(`thickness`, `attenuationColor`, `attenuationDistance`) are part of transmission: set it first.
Factors, map assignments (including `null`), texture `update()` calls and per-slot UV transforms stay live.
Clearcoat normals and anisotropy derive independent tangent frames from their own transformed UV set.

Mapped materials bind only assigned textures, share views by texture identity and colour space, and share samplers.
The renderer checks the complete shader against device texture and sampler limits, including lighting and
transmission resources. Combinations exceeding those limits throw a descriptive error; reduce simultaneous maps
or share packed textures. `Texture.options.colorSpace` overrides the defaults in the table.

These maps work with geometry groups, instancing, glTF export and device restoration. Glass uses the maps in both
the tinted-background path and the optional `Transmission` refraction pass. Disposing the last mesh using a
material releases its map uniform buffers; textures remain caller-owned.

## Dispersion

`Material({transmission: 1, thickness: 0.8, dispersion: 0.3})` adds wavelength-dependent refraction through the
`Transmission` pass. `dispersion` defaults to 0, accepts finite nonnegative values (including values above 1), and
stays live. It uses `KHR_materials_dispersion`'s 20/Abbe-number convention. Red, green and blue sample the opaque
scene along separate refracted rays; red's IOR is clamped to at least 1. Zero preserves the existing refraction.
The effect needs nonzero volume thickness; IOR 1 leaves all three channels together. Without a refraction capture,
the existing tinted-background path remains unchanged.

glTF parsing and export preserve `KHR_materials_dispersion`. The retained glTF renderer uses the existing
`extendedMaterials` decoder opt-in; `install(model)` and caller-owned `transmission({dispersion, ...})` also support
the extension. For imported `KHR_materials_volume.thicknessTexture`, use `install(model)`; native glTF transmission
uses scalar thickness. Constructed meshes support their live `thicknessMap` through `Transmission`.
The screen-space volume approximation and existing transmission limitations still apply.

## More maps and options

Every `Material` takes these maps and options, live like the others. Each one compiles into a material's shader only
while it is in use: a material that never sets one keeps exactly its shader, bindings and uniforms.

| Option | Meaning |
| --- | --- |
| `alphaMap` | Green channel (linear) multiplies opacity, before `alphaTest` and blending (`transparent`) |
| `bumpMap`, `bumpScale` | Red channel (linear) is a height, `bumpScale` (default 1, finite, negative inverts) its full range in mesh units; its screen-space slope tilts the shading normal (Mikkelsen 2010), after `normalMap` when both are set |
| `displacementMap`, `displacementScale`, `displacementBias` | Each vertex moves along its normal by red (linear) * scale (default 1) + bias (default 0) mesh units, before the model and instance matrices: in the beauty and G-buffer passes and in the directional (`Shadows`) and clustered (integrated and `LocalShadows`) shadow maps. Normals are not recomputed; CPU picking, bounds and exports see the undisplaced mesh |
| `lightMap`, `lightMapIntensity` | Baked light (RGB, sRGB by default), read on UV1 (`geometry.uvs1`, else UV0) unless `setUVTransform(t, 'lightMap')` names another set; it keeps its own UV set when `uvTransform` moves the other maps. Lit shadings (standard, Lambert, Phong) add diffuse colour * map * intensity (default 1) as indirect light, darkened by `aoMap`; unlit materials multiply their colour by map * intensity. Normal, matcap, depth and distance output ignore it. glTF has no light maps: `exportModel` leaves it out |
| `lightMapResponse` | `'multiply'` (default) multiplies by the light map; `'lambertian'` converts physical irradiance with `1 / pi`, on standard/Lambert/Phong shading only. Use a linear texture and nonnegative raw intensity. Constructor, live setter, clone and copy preserve the selected response; raw `lightMapIntensity` remains the decode scale |
| `emissiveIntensity` | Scales `emissive` and `emissiveMap` (default 1, finite, >= 0), so emission can pass 1 (bloom). No shader change. `exportModel` writes it as `KHR_materials_emissive_strength` with `emissive` as the factor |
| `flatShading` | Each triangle shades with its own face normal (from the position's screen derivatives, facing the viewer on both sides) instead of the interpolated vertex normals; lit, normal and matcap shading. Default false |
| `vertexColors` | Geometry `colors` multiply colour and opacity while true (the default, Margo's behaviour so far); false ignores them. Instance tints (`setColorAt`) still apply |
| `fog` | Lit shadings: false leaves the material out of `@margoengine/environment`'s `Fog` (default true). Unlit, normal, matcap, depth and distance output are never fogged |
| `toneMapped` | Lit shadings: false skips the display tone map (PBR Neutral) and only clamps before sRGB encoding, as unlit output does; default true for lit shadings, false for the others (which never tone map). On an HDR target (a post stack's tone map runs later) it changes nothing |

Each map has its own UV transform slot (`material.setUVTransform(t, 'alphaMap')`); `uvTransform` and
`setUVTransform(t)` without a slot set it with the other maps'.

```ts
const leaves = new LambertMaterial({map: leafColour, alphaMap: leafCutout, alphaTest: 0.5, side: 'double'});
leaves.alphaMap = null; // live: the next frame draws without it
```

Directional (cascaded and virtual), spot and point shadows, contact shadows, TAA velocity and picking cut along the same `map` alpha, `alphaMap`, UV transforms and `alphaTest` as the colour pass, and `vertexColors: false` keeps vertex alpha out of all of them. Picking also passes through the holes of a blended material. `triplanar` is the exception: its projection follows world space, so the mesh keeps its whole surface in those passes.

```js
import { Picking } from '@margoengine/selection';
import { ContactShadows } from '@margoengine/staging';
import { PbrMaterial, createMesh } from '@margoengine/materials';

Picking.attach(engine);
const contact = ContactShadows.attach(engine);
const fence = createMesh(engine, geometry, new PbrMaterial({ map, alphaMap, alphaTest: 0.5 }));
contact.add(fence);
await engine.pick(x, y); // null through a hole, and no contact shadow under one
```

## Parallax, triplanar and subsurface

Three more surface options, live like the others. Each compiles into a material's shader only while it is in use:
a material that never sets one keeps exactly its shader, bindings and uniforms, and steady frames upload nothing for
them.

```ts
import { Engine } from 'margoengine/core';
import { LambertMaterial, PbrMaterial, createMesh, loadTexture } from 'margoengine/materials';
import { boxGeometry, planeGeometry, sphereGeometry } from 'margoengine/geometry';

declare const canvas: HTMLCanvasElement;
const engine = await Engine.create(canvas);
const [bricks, bricksHeight, rock] = await Promise.all(
  ['/bricks.png', '/bricks-height.png', '/rock.png'].map((url) => loadTexture(url)),
);
// Parallax occlusion mapping: mortar 2 cm deep on a flat wall, no extra triangles.
const wall = new PbrMaterial({ map: bricks, parallaxMap: bricksHeight, parallaxScale: 0.02 });
createMesh(engine, planeGeometry(4, 4), wall);
wall.parallaxMode = 'relief'; // sharper steps, live
// Triplanar: rock projected from world space, two repeats per metre, no UV unwrap needed.
createMesh(engine, boxGeometry(3, 1, 2), new PbrMaterial({ map: rock, triplanar: true, triplanarScale: 2 }));
// Subsurface scattering: wax glowing where the sun shines through it, and a leaf lit from behind.
createMesh(engine, sphereGeometry(0.5), new PbrMaterial({ color: '#f4e4c8', subsurface: 0.8, subsurfaceColor: '#ff9a50' }));
createMesh(engine, planeGeometry(0.3, 0.5), new LambertMaterial({ color: '#4a8a2a', side: 'double', subsurface: 1, subsurfaceMode: 'thin' }));
```

| Option | Meaning |
| --- | --- |
| `parallaxMap`, `parallaxScale` | Height map (red, linear: 1 the surface, 0 the deepest) and the depth of its full range in world units (default 0.05, finite, >= 0). The view ray is marched through it and every map on the same UV set (UV0, unless `setUVTransform(t, 'parallaxMap')` names UV1) is read where the ray meets the relief. Any shading |
| `parallaxMode` | `'occlusion'` (default): parallax occlusion mapping, stepped along the ray and interpolated between the last two steps (Tatarchuk 2006). `'relief'`: the step refined by six bisections (Policarpo et al. 2005), sharper edges. `'offset'`: one step without dividing by n.v (Welsh 2004), cheapest, flattens at grazing angles |
| `parallaxSteps` | Steps of the occlusion and relief march, an integer 1 through 64 (default 16). Every step is one texture read per pixel |
| `triplanar`, `triplanarScale`, `triplanarSharpness` | `true` projects the maps on UV0 (colour, metal-roughness, normal, occlusion, emissive, alpha, bump, parallax and physical maps) from world space along X, Y and Z, `triplanarScale` repeats per world unit (default 1, > 0), blended by the normal's components to the power `triplanarSharpness` (default 4, >= 1). Maps on UV1 (a `lightMap`) keep their UVs. Each projection runs U to the viewer's right and V up, so no face shows its texture mirrored; normal maps tilt in each projection's own plane. Default false; any shading |
| `subsurface` | Subsurface scattering weight, 0 through 1 (default 0: off). Standard, Lambert and Phong shading (others throw a `TypeError`). The engine's directional light scatters, tinted by the base colour times `subsurfaceColor` (default white); metals do not |
| `subsurfaceMode` | `'thick'` (default): light seen through the object around the light's direction (Barre-Brisebois and Bouchard 2011), plus a diffuse that wraps past the terminator and keeps Lambert's total energy (Green 2004). `'thin'`: a sheet lit from behind shows the light through it as a front-lit Lambert surface would (leaves, paper, lampshades) |
| `subsurfaceThickness`, `subsurfaceThicknessMap` | Local thickness 0 through 1 (default 0.5) times the map's red channel (linear); light passes through 1 - thickness |
| `subsurfaceDistortion`, `subsurfacePower`, `subsurfaceWrap` | Thick only: how far the normal bends the light seen through (default 0.2, >= 0), how tightly it gathers around the light (default 4, > 0), and how far diffuse light wraps (default 0.5, 0 through 1) |

These are shading effects: the silhouette, depth, shadow maps, picking, bounds and exports keep the flat mesh, and
`exportModel` leaves the options out (glTF has none of them). Triplanar mapping reads every map three times and the
march reads the height map once per step, so use them where they show. World-space triplanar textures stay where they
are when a mesh moves; a `WgslMaterial`'s `shade()` runs once per projection and sees that projection's
coordinates in `i.uv.xy`. The subsurface translucency is not shadowed (light reaching the back of an object is assumed to
arrive) and clustered point and spot lights do not scatter. Each map has its UV transform slot
(`setUVTransform(t, 'parallaxMap')`, `'subsurfaceThicknessMap'`).

## Shadow catcher

`ShadowCatcherMaterial` is invisible except for the shadows it receives, for ground planes under product shots.
Where a shadow falls it draws `color` (default black) at alpha `opacity` (default 1) times the share of the light that
the shadow takes: received / unshadowed luminance of a white Lambert surface, over the sun (`@margoengine/shadows`) and
clustered point, spot, directional and area lights (integrated maps or `LocalShadows`, `castShadow` directional and
area lights included). An unshadowed light lightens the shadows of the others; ambient and environment light do not count. Register the plane with those
effects like any receiver. It is transparent (drawn after opaque meshes, no depth write) and so casts no shadow.
`color` and `opacity` are live, and `clone()` keeps it a catcher.

```ts
const ground = createMesh(engine, planeGeometry(20, 20), new ShadowCatcherMaterial({opacity: 0.5}));
ground.root.setRotation([-Math.PI / 2, 0, 0]);
shadows.add(ground);
lights.add(ground); // clustered local shadows too
```

## WGSL materials

`WgslMaterial` runs your WGSL inside gltf-pro's PBR shader, at the sites `@margoengine/shader`'s `NodeMaterial` uses;
every other Material option (shading, maps, render state, the options above) still applies, and the chosen shading
lights the surface your code returns.

- `fn shade(i: Out, s: Surface) -> Surface` (required) runs at the end of the material's surface, before the face and
  alpha tests, in every pass (beauty, G-buffer, SSAO ambient). `i` holds the interpolated vertex outputs:
  `position` (world, vec3f), `normal` (world, vec3f), `tangent` (vec4f), `uv` (vec4f: UV0 in `xy`, UV1 in `zw`),
  `color` (vec4f) and `clip`. `s` is what the material computed: `base` (linear RGBA, opacity in `a`), `n` (world
  shading normal), `roughness`, `metal`, `occlusion`, `emissive` (linear RGB). Return the surface to light.
- `fn displace(i: Input) -> vec3f` (optional) returns the mesh-space vertex position, before the model and instance
  matrices. `i` is the vertex input: `position`, `normal`, `tangent`, `uv` (as above) and `color`, all vec4f.
- `uniforms: {name: value}`: a number is an `f32`, 2 to 4 numbers a `vec2f` to `vec4f`; read them as
  `uniforms.name`. `material.uniforms.name = value` (same component count) or writing an array uniform's elements in
  place changes them from the next frame.
- `textures: {name: texture}`: read `name` with its sampler `nameSampler`; sRGB unless the Texture says otherwise.
  Each is declared by its `dimension`: `texture_2d<f32>`, `texture_2d_array<f32>`, `texture_3d<f32>` or
  `texture_cube<f32>`. Assign another Texture of the same dimension to the same name to swap it live.

The WGSL, uniform names and texture names are fixed at construction. The constructor throws `TypeError` for a
missing or misdeclared entry point, a name that is not a WGSL identifier or that the PBR shader already uses (`f`,
`uv`, `surface`, `margo...`, `mat_...`), a uniform that is not 1 to 4 numbers or a texture that is not a Texture, and
`RangeError` for a non-finite uniform. Errors inside your WGSL are WebGPU's own: they show as a validation error
(console, `device` `uncapturederror`) when the shader first draws. `clone()` copies the uniforms and shares the
textures.

```ts
const water = new WgslMaterial({
  shading: 'phong',
  wgsl: `fn shade(i: Out, s: Surface) -> Surface {
  var o = s;
  o.base = vec4f(o.base.rgb * textureSample(ripples, ripplesSampler, i.uv.xy + uniforms.flow * uniforms.time).rgb, 1.0);
  return o;
}`,
  uniforms: {flow: [0.05, 0.02], time: 0},
  textures: {ripples},
});
createMesh(engine, planeGeometry(10, 10), water);
let time = 0;
engine.onFrame((_, delta) => {
  water.uniforms.time = time += delta; // live from the next frame
});
```

## Toon materials

`ToonMaterial` (or `shading: 'toon'`) is Lambert's diffuse light read through a ramp instead of `n.l`: the
`gradientMap` texture, sampled across at `u = n.l * 0.5 + 0.5` (its left texel is the side away from the light, its
right texel the side facing it; RGB, so a ramp may be coloured), or without one `steps` flat bands (an integer 2
through 256, default 3; band `k` of `n` is `k / (n - 1)`, the same as a nearest-filtered gradient of `n` texels). Both
are live. The engine's light, clustered point, spot and extra directional lights and their shadows go through the ramp;
the hemisphere ambient, an environment's diffuse light and light maps light it as Lambert; area lights shade it as a
rough dielectric. There is no highlight. Use `magFilter: 'nearest'` on a gradient for hard steps.

```ts
import {ToonMaterial, Texture, createMesh, toonModel} from 'margoengine/materials';
const bands = new Texture({data: new Uint8Array([40, 40, 40, 255, 140, 140, 140, 255, 255, 255, 255, 255]), width: 3, height: 1},
  {colorSpace: 'linear', magFilter: 'nearest', minFilter: 'nearest', mipmaps: false});
createMesh(engine, geometry, new ToonMaterial({color: '#e07040', gradientMap: bands}));
createMesh(engine, geometry, new ToonMaterial({color: '#4080e0', steps: 4}));
// A loaded glTF model, or some of its primitives (skinned, morphed and instanced ones keep their deformation):
const toon = toonModel(model, {steps: 3}); // or {gradientMap, primitives: [0, 2]}
toon.steps = 5; // live
toon.dispose(); // the model's own materials again
```

`toonModel` gives each chosen primitive a copy of its glTF material with the toon lighting; colours, factors and maps
stay shared and live. Physical layers (clearcoat, sheen, transmission, iridescence) and material extensions are left
out of the toon primitives. `selectVariant` replaces the toon copies (call `toonModel` again after it), and a
`createMesh` mesh takes a `ToonMaterial` instead. Outlines stay `@margoengine/toon`'s whole-scene `Toon` pass.

## Environment maps

`envMap` gives one material its own cube of surroundings: a `CubeTexture`, an `@margoengine/environment`
`Environment`, a cube render target `{texture, view}` (the shape of environment's `CubeCamera`) or a six-layer
GPUTexture. Live, with `envMapIntensity` (default 1), `envMapRotation` (radians about +Y, added to an Environment's own
rotation) and `envMapMode: 'refraction'` with `refractionRatio` (default 1/1.5, air into crown glass) to sample along the bent view ray
instead of the mirrored one.

- **Standard shading** lights itself with the map in place of its ambient light: specular radiance from the mip level
  of its roughness (`roughness * (levels - 1)`) weighted by an analytic split-sum environment BRDF (Karis 2014), plus
  diffuse irradiance from the Environment's spherical harmonics or, for other cubes, a level about four texels across.
  It overrides the built-in hemisphere and an attached scene IBL for this material (their bindings stay). Physical
  clearcoat and sheen layers read it too; the thin film and anisotropy do not.
- **Basic, Lambert and Phong** combine the sharp reflection with their colour by `combine` (`'multiply'`, default:
  colour x reflection; `'mix'`: toward the reflection; `'add'`) and `reflectivity` (0-1, default 1).

Other shadings refuse an envMap. A `CubeTexture`'s mips are box filtered per face, not GGX prefiltered: rough
surfaces blur toward the face averages; an `Environment` is prefiltered. Bindings 188-190 of the material's group.

```ts
import {CubeTexture, PbrMaterial, UnlitMaterial, loadCubeTexture} from 'margoengine/materials';
const sky = await loadCubeTexture(['px.jpg', 'nx.jpg', 'py.jpg', 'ny.jpg', 'pz.jpg', 'nz.jpg']);
const chrome = new PbrMaterial({metalness: 1, roughness: 0.1, envMap: sky});
const glass = new UnlitMaterial({envMap: sky, envMapMode: 'refraction', refractionRatio: 0.66, combine: 'mix'});
chrome.envMap = environment; // an @margoengine/environment Environment, or a CubeCamera target
```

## Cube textures

`new CubeTexture(faces)` takes six images (or raw RGBA8, or float `DataImage`s) in WebGPU layer order +X, -X, +Y, -Y,
+Z, -Z: square, one size, row 0 at the top (`flipY` defaults to false), the orientation of environment's `CubeFaces`.
`new CubeTexture(texture, {size})` resamples an equirectangular 2D Texture (centre facing -Z, +X to its right, top row
straight up, environment's convention) into rgba16float faces on the GPU, again whenever that texture updates.
`loadCubeTexture(urls)` loads six image URLs, or one equirect URL. Faces get per-face mip chains (`mipmaps`, default
true). A CubeTexture is a `Texture` with `dimension: 'cube'`: use it as an `envMap` or a WgslMaterial
`texture_cube<f32>`, sampled with world directions.

## Data, 3D and array textures

A `DataImage` source `{data, width, height, depth?, format?}` uploads raw texels, row 0 first, then each layer or
slice: `rgba8unorm`, `rg8unorm` and `r8unorm` take bytes; `rgba16float`, `rg16float` and `r16float` take a
Uint16Array of half-float bits or a Float32Array (converted on upload); `rgba32float`, `rg32float` and `r32float` take
a Float32Array. The `dimension` option makes `depth > 1` a `'2d-array'` (layers) or `'3d'` (slices) texture.
`texture.update({x, y, z, width, height, depth})` re-uploads just that box on the next frame; `update()` all of it.
Data defaults to no mip chain (2D and array data may set `mipmaps: true`, not 3D or 32-bit floats) and is linear
(`colorSpace: 'srgb'` only for `rgba8unorm`).

```ts
const field = new Float32Array(32 * 32 * 32);
const volume = new Texture({data: field, width: 32, height: 32, depth: 32, format: 'r32float'}, {dimension: '3d'});
const material = new WgslMaterial({
  wgsl: `fn shade(i: Out, s: Surface) -> Surface {
  var o = s; o.emissive = vec3f(textureLoad(volume, vec3i(i.position * 8.0 + 16.0), 0).r); return o;
}`,
  textures: {volume},
});
field[0] = 1;
volume.update({x: 0, y: 0, z: 0, width: 1, height: 1, depth: 1}); // live
```

Material map slots take 2D textures (a 3D, array or cube one throws a `TypeError`), floats included; 32-bit floats
filter only on a device with `float32-filterable` (request it in `Engine.create({features})`), so map slots refuse them
elsewhere with a `MargoError('unsupported')` and a WgslMaterial reads them with `textureLoad`. A borrowed GPUTexture
source (`new Texture(gpuTexture, {dimension})`) binds as it is and stays its owner's.

## Batched meshes (`@margoengine/materials/batched`)

`BatchedMesh` draws many different geometries as one materials mesh: one draw call in the main pass and one per
shadow cascade, however many items it holds. Each item has its own matrix, colour (multiplied into its vertex colours)
and visibility. Items are copied into shared vertex and index ranges once; moving, tinting or hiding one uploads 20
floats and reruns a compute pass over the used vertices on the next frame (an unchanged batch costs nothing). Removed
items' space is reused by later items that fit. `batch.mesh` takes `shadows.add`, `clustered.add`, `ssao.add` and
picking like any `createMesh` mesh; `batch.itemOf(vertex)` maps a hit vertex back to its item and `batch.bounds(id)`
gives an item's world box. Every item is its own copy of its geometry: for many copies of one geometry use
`createInstancedMesh`. On the RTX A6000, 10,000 distinct boxes cost 36.8 ms of CPU per frame as one mesh each and
0.13 ms as one batch (`npm run bench -- scaling --cases=shapes`). WebGPU only.

```ts
import { Engine } from 'margoengine/core';
import { Material } from 'margoengine/materials';
import { BatchedMesh } from 'margoengine/materials/batched';
import { boxGeometry, sphereGeometry } from 'margoengine/geometry';

declare const canvas: HTMLCanvasElement;
const engine = await Engine.create(canvas);
const batch = BatchedMesh.attach(engine, new Material({ roughness: 0.5 }), { maxItems: 1000, maxVertices: 200_000 });
const crate = batch.add(boxGeometry(1, 1, 1), { color: '#c08040' });
const ball = batch.add(sphereGeometry(0.5), { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0.5, 0, 1] });
batch.setColor(ball, [0.2, 0.6, 1]).setVisible(crate, false);
batch.remove(crate); // its space is reused by a later item that fits
```

## Clipping planes

`clippingPlanes` takes up to 6 world-space planes `[a, b, c, d]`; points with `a x + b y + c z + d < 0` are cut away
(the same convention as the scene's section binding), on every material class: standard, physical, unlit, Lambert, Phong,
toon, normal, matcap, depth, distance, `WgslMaterial` and `@margoengine/shader` node materials. The cut applies in the
beauty, G-buffer and SSAO passes and, with `clipShadows` (default true), in `@margoengine/shadows` directional shadow
maps. Planes are normalised on assignment and reading returns copies; assign a new list to change them (live). A
clipped caster redraws its shadow every frame. `@margoengine/lines` and `@margoengine/points` materials take the same
option. `clipIntersection: true` cuts away only what is behind every plane (their intersection: a wedge or a corner out of a solid) instead of what is behind any of them; it is a uniform value, so switching it compiles nothing, and shadows follow it. A scene's section planes (the `section` binding) still clip everything; with both, the scene's planes clip the shadows. Clustered
point-light shadows and GPU picking ignore material planes.

```ts
import { Engine } from 'margoengine/core';
import { Material, createMesh } from 'margoengine/materials';
import { torusKnotGeometry } from 'margoengine/geometry';

declare const canvas: HTMLCanvasElement;
const engine = await Engine.create(canvas);
const material = new Material({ color: '#e0a040', doubleSided: true, clippingPlanes: [[0, -1, 0, 0.5]] });
createMesh(engine, torusKnotGeometry(), material); // everything above y = 0.5 is cut away
material.clippingPlanes = [[0, -1, 0, 0.5], [1, 0, 0, 0]]; // live: also cut x < 0
material.clipShadows = false; // the shadow stays whole
material.clipIntersection = true; // only what is behind both planes is cut: a wedge
```

## KTX2 textures

A `.ktx2` file goes on any map through `@margoengine/decoders`' `KTX2Decoder`: `loadKTX2Texture(url, {decoder})`
fetches and transcodes it, and `new Texture(await decoder.transcode(bytes))` takes a transcode result. Each device gets
its own upload of every mip level, in the compressed format the decoder chose (BC7, ASTC 4x4, ETC2 or RGBA8); a device
without that format's feature throws `MargoError('unsupported')`, so create the decoder with the engine's device. Colour
slots decode sRGB unless `colorSpace` says otherwise. `new Texture(await decoder.createTexture(bytes))` borrows the
decoder's GPUTexture instead (one device, its own format). The decoder rejects KTX2 cube maps, arrays and UASTC HDR.

```ts
import {KTX2Decoder} from 'margoengine/decoders';
const decoder = new KTX2Decoder({device: engine.gpu});
const albedo = await loadKTX2Texture('/textures/albedo.ktx2', {decoder});
createMesh(engine, geometry, new PbrMaterial({map: albedo}));
```

`loadTexture`, `loadKTX2Texture` and `loadCubeTexture` take a `fetch` option (default `globalThis.fetch`): pass a
`LoadingManager`'s (`@margoengine/cache/manager`) or an `AssetCache`'s `fetch` to count the download or serve it from
the cache.

## Display P3 textures

`colorSpace: 'display-p3'` on an 8-bit RGBA image or raw RGBA8 data reads its pixels as Display P3 (sRGB transfer
curve, P3 primaries) and converts them once on the GPU, after each upload, into an rgba16float copy in the linear sRGB
working space, with `@margoengine/math`'s `P3_TO_SRGB`: colours outside sRGB keep negative channels, as
`color(display-p3 ...)` colours do, so an environment `ColorOutput` P3 canvas shows them. Load images with `loadTexture`
(no browser colour conversion). Float data takes linear sRGB values instead (`linearP3ToLinearSRGB`).

### Physical irradiance atlases

For `bakeLightmap(..., { radiometry: 'physical' })` or `bakeRefractedLightmap`, use the existing linear atlas with an
explicit Lambertian diffuse response. Emission remains separate and is added once.

```ts
const texture = new Texture(
  { width: atlas.width, height: atlas.height, data: atlas.textures.lightmap },
  { colorSpace: 'linear', mipmaps: false },
);
const material = new PbrMaterial({
  lightMap: texture,
  lightMapIntensity: atlas.lightmapScale,
  lightMapResponse: 'lambertian',
});
```

Set the mesh's UV1 to `atlas.uv`. Constructed materials add baked lighting to live lighting; disable duplicate live
terms when the atlas already includes them. An `aoMap` still applies artist attenuation. This slot approximates
Lambertian diffuse with metal suppression, not the complete layered BRDF. `'multiply'` keeps the plain multiplication,
including unlit shading and its existing intensity range. Neither this selector nor linear RGB defines a universal
RGB-watts-to-lumens conversion.

GPU scalars (`normalScale`, `clearcoatNormalScale`, `ior`, `iridescenceIOR`, `thickness`, `shininess` and
`iridescenceThicknessRange`) must stay finite as float32; a value such as `1e39` throws `RangeError` and leaves the
material unchanged. A white attenuation channel stays white at any attenuation distance.
