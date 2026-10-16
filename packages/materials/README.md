# Margo Engine Materials

Optional glTF clearcoat, transmission, IOR, volume, and TypeScript node materials through `@margoengine/gltf-pro`'s material extension slot. This package is separate from the frozen core and stage facade, and importing `gltf-pro` does not import materials.

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

`install(model)` is synchronous and registers its engine plugin automatically. It reads optional `KHR_materials_clearcoat`, `KHR_materials_transmission`, `KHR_materials_ior`, and `KHR_materials_volume` data from each primitive's material and uses the model's already loaded images. The baseline `loadGLTF` and `parseGLTF` APIs remain unchanged. Their existing validation rejects these extensions in `extensionsRequired`; use optional metadata for this explicit installation path.

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
