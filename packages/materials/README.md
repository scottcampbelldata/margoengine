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
slot it updates every map except `matcap`, including maps assigned later; `null` restores UV0 and the identity transform. Updates take effect next frame.
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
and is fixed at construction. Geometry groups and instanced meshes use each group's material setting.
Edges include triangulation diagonals; shared triangle edges can be drawn more than once. Wide-line thickness
controls are not provided.

Wireframe alone keeps the existing render-state and transparency paths. The original triangle geometry remains
available to picking and glTF export. Native `primitive.material.wireframe` accepts a live boolean, so assigning
`true` or `false` changes subsequent draws without replacing the source triangle data.
Beauty, auxiliary and shadow passes use the same edges, including deformed vertices. Lines ignore triangle
face culling and polygon offset. Directional casters explicitly registered with `{static: true}` keep their
manual update policy: call `Shadows.invalidate()` after changing the native flag.

## Polygon offset and stencil

`polygonOffset`, `polygonOffsetFactor`, `polygonOffsetUnits` and `polygonOffsetClamp` are fixed at construction.
Positive factors and units push polygons away from the camera; negative values pull them forward. Signs are
converted for reverse-Z. Units must be integers within ±2147483647; factor and clamp must be finite as float32.
Clamp defaults to zero (unclamped). Points and lines ignore polygon offset.

Enable `stencilWrite` to apply stencil comparison and operations. `stencilFunc` defaults to `always`;
`stencilFail`, `stencilZFail` and `stencilZPass` default to `keep`. These use WebGPU comparison/operation names.
`stencilRef` defaults to zero; `stencilReadMask` and `stencilWriteMask` default to `0xff`. Masks and references
accept unsigned 32-bit integers; the attachment's eight stencil bits determine the effective value.
Use `stencilWriteMask: 0` for comparison without changing stencil. These properties are fixed at construction.

```ts
import {Material, StencilBuffer, createMesh} from '@margoengine/materials';

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

Physical and transmissive capabilities are fixed at construction. A non-null map reserves its lobe, and a
transmission or thickness map also reserves transmissive rendering even when its factor is zero. To add
anisotropy, iridescence or transmission maps later, reserve that capability with its factor set to zero first.
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
