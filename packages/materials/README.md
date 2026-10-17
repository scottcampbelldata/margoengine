# Margo Engine Materials

Optional glTF clearcoat, sheen, specular color, anisotropy, iridescence, transmission, IOR, volume, and TypeScript node materials through `@margoengine/gltf-pro`'s material extension slot. This package is separate from the frozen core and stage facade, and importing `gltf-pro` does not import materials.

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from '@margoengine/gltf-pro';
import * as materials from '@margoengine/materials';

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
import {clearcoat} from '@margoengine/materials';

const extension = clearcoat({factor: 1, roughnessFactor: 0.05});
```

`ClearcoatOptions` supports the two factors and three optional textures. Each `ClearcoatTexture` contains a `view`, an optional `sampler`, and an optional `texCoord` (`0` or `1`); the normal texture also accepts `scale`. A `transform` accepts glTF-style `offset`, `rotation`, `scale`, and overriding `texCoord`. A view without a sampler uses nearest sampling with clamped UVs at mip level `0`. Views and samplers supplied to `clearcoat()` stay caller-owned.

Clearcoat adds a second GGX specular lobe with dielectric F0 `0.04`. Its normal affects only that lobe; the base shading and g-buffer normal are unchanged, so SSAO and shadows continue to use the base normal. Clearcoat factor `0` preserves the baseline material.

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
import {materialLobes, clearcoat} from '@margoengine/materials';

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

The shader sources and license notices are included in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Run
`node scripts/materials-lobe-tests.js` for quantitative GPU and parity checks;
the complete-asset runner also checks original Khronos models.

Positive transmission opts into a shared opaque-color capture. All opaque and masked PBR primitives, including those from other models, render before the snapshot; blended primitives render afterward. The snapshot preserves the scene format and supports 1x or 4x MSAA, including an existing HDR capture. No frozen core or stage pass is changed. Transmission factor `0` leaves the opaque material and its allocation path unchanged.

Transmission defaults to factor `0` and IOR `1.5`. Its optional texture multiplies the factor using the red channel. Refraction samples the opaque color already rendered this frame; IOR `1` samples the same pixel without bending. This is screen-space transmission with one background sample. It does not trace rays or produce multiple bounces.

Without positive volume thickness, the refracted sample probes 10% of the camera-to-surface distance behind the surface. Positive thickness supplies the probe length. Off-screen coordinates clamp to the image edge, and transparent layers are absent from the opaque snapshot.

Volume requires positive transmission; otherwise installation throws `KHR_materials_volume requires transmission`. Thickness defaults to `0`, and its optional texture uses the green channel. Beer's law attenuates the transmitted color using `attenuationColor` (default `[1, 1, 1]`) and `attenuationDistance`. A missing distance or `Infinity` leaves the transmitted color unattenuated. There is no participating-media scattering. Transmission and thickness maps accept UV0 or UV1 and use linear data.

Transmissive primitives blend without writing depth. They do not cast shadows or receive the cascaded shadow map in this version. A clearcoat lobe on the same transmissive material follows this shadow limitation.

For a caller-owned screen capture, `transmission(options)` returns an extension without installing a scene pass:

```ts
import {transmission} from '@margoengine/materials';
import type {PBRPrimitive} from '@margoengine/gltf-pro';

function applyTransmission(primitive: PBRPrimitive, opaqueTexture: GPUTexture) {
  primitive.extension = transmission({
    factor: 1,
    ior: 1.5,
    opaqueColor: opaqueTexture.createView(),
    volume: {thicknessFactor: 0.1, attenuationColor: [0.8, 1, 1], attenuationDistance: 1},
  });
  primitive.material.settings[0] = 2;
}
```

The caller renders opaque and masked geometry into `opaqueColor` before this primitive. The view and optional transmission/thickness textures stay caller-owned; textures use the same `view`, optional `sampler`, and `texCoord` interface as clearcoat.

`installation.dispose()` and its `destroy()` alias release installation-owned resources and restore the extension slots and blend modes the installation replaced. Destroying the model also cleans up the installation. The opaque snapshot is shared per engine and released with its final installation. Device restoration recreates installation-owned glTF texture uploads and capture resources. Caller-owned views and samplers require fresh GPU resources and extension reassignment or reinstallation after device restoration.

## Node materials

`nodeMaterial(graph, options?)` compiles a small TypeScript object graph into one `MaterialExtension`. Connect nodes by object reference, list at least the output in `graph.nodes`, then assign the result to a primitive or material's extension slot:

```ts
import {nodeMaterial} from '@margoengine/materials';
import type {PBRPrimitive} from '@margoengine/gltf-pro';

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

An output can reference nested nodes absent from the root list. All listed nodes are validated, including disconnected ones. Reuse an object to share a node. Cycles, multiple or missing outputs, unknown node types, incompatible input types, arbitrary WGSL, and requests for custom vertex attributes throw. The vertex format remains position, normal, tangent, UV, and color. This graph is a TypeScript authoring API; it does not load Three.js TSL or node JSON.

`installNodeMaterial(model, graph)` installs one graph on the model and automatically registers a plugin. Graph transmission acquires the same shared opaque-color capture as glTF transmission and sets the affected primitives to the existing blend path:

```ts
import {installNodeMaterial} from '@margoengine/materials';

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

## Meshes with two UV sets and material groups

`createMesh(engine, geometry, material)` draws CPU geometry through glTF-pro's PBR renderer. `MeshGeometry` accepts
`positions`, `normals`, optional `indices`, `uvs` (UV0), `uvs1` (UV1), `tangents` and RGB/RGBA `colors`. Both UV arrays
contain two finite values per vertex. UV0 defaults to zero; omitted UV1 copies UV0. The vertex layout remains 80 bytes.

```ts
import {Material, createMesh, loadTexture} from '@margoengine/materials';

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
slot it updates every standard map; `null` restores UV0 and the identity transform. Updates take effect next frame.
Normal maps selected from UV1 or transformed UVs derive their tangent frame from those coordinates.

A material array requires at least one group. Each group has a nonnegative integer `materialIndex` into that array,
and triangle-aligned `start` and positive `count` in index units, or vertex units without indices. Ranges must fit and
must not overlap; gaps are omitted. A single material keeps drawing the whole geometry and ignores groups.
`mesh.material` is that single material, or a frozen snapshot of the supplied array; the materials themselves stay live.

Groups become primitives of one `PBRModel`, share packed vertices and GPU vertex buffers, and move with one root.
`createInstancedMesh(engine, geometry, materials, capacity)` uses the same groups and shares one live `instances`
object across every primitive. Opaque groups draw before blended groups across the materials queue; transparent
ordering still uses the model's node distance, not individual triangles. Group bounds conservatively include all vertices.
Picking either group returns the shared mesh node. The existing shadows, lighting, SSAO and exporter adapters accept
the model; existing texture-alpha picking/shadow limitations remain. Export preserves group materials and UV1.

Packing is cached by geometry identity: finish editing attributes before the first call to `packGeometry` or mesh
creation, and use a new geometry object for changed attributes. `mesh.dispose()` releases model resources; textures
remain caller-owned. Device restoration rebuilds the model and texture bindings. Constructed material shading cannot
be copied to another GPU device without rebuilding its material resources. Core and the stage facade are unchanged.
