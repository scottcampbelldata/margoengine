# @margoengine/clustered

Optional clustered forward GGX lighting for up to 1,024 point/spot lights. A compute pass builds logarithmic-depth frustum AABBs and tests view-space light spheres and conservative spot-cone bounds. Fragment shaders calculate their screen/depth cluster and evaluate only its light list. This preserves forward alpha blending and does not require a deferred G-buffer.

```ts
import {EngineKernel,box} from '@margoengine/core';
import {Clustered} from '@margoengine/clustered';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
engine.createMesh().setGeometry(box());
const lights = Clustered.attach(engine); // 16 × 9 × 24
lights.setLights([
  {position:[0,2,1], range:12, color:[1,0.3,0.1], intensity:20},
  {position:[2,3,0], range:15, direction:[0,-1,0], innerAngle:0.3, outerAngle:0.7, color:[0.1,0.3,1], intensity:30}
]);
engine.start();
```

Positions and directions are world space; cone angles are radians up to π/2 (a hemisphere: everything in front of the light). Light radiance uses smooth range attenuation, inverse-square distance attenuation, and smooth inner/outer spot cones.

Crocotile's light parameters map one to one, with the falloff `@margoengine/bvh`'s vertex-light bake uses:

```ts
lights.setLights([
  {position:[0,3,0], range:0, decay:1, color:[1,0.8,0.6], intensity:4},                     // Distance 0: unlimited
  {position:[2,4,0], range:10, decay:2, direction:[0,-1,0], angle:0.5, penumbra:0.3, intensity:8},
]);
```

- Attenuation is `window / max(d^decay, 2^-12)` with `window = range > 0 ? clamp(1 - (d/range)^4, 0, 1)^2 : 1`.
  `decay` defaults to 2 (inverse-square); 0 turns distance falloff off. `range: 0` is unlimited (the light reaches every
  cluster); a light with a shadow map needs a finite range.
- A spot takes `angle` (half-angle, up to π/2) and `penumbra` (0 to 1, default 0) instead of `outerAngle`/`innerAngle`:
  the cone is `smoothstep(cos(angle), cos(angle * (1 - penumbra)), dot(-L, direction))`, so outer = angle and
  inner = angle × (1 − penumbra); penumbra 0 is a hard edge. Giving both forms throws.
- A light that sets neither `decay` nor `angle` keeps the original shader term (`d * d`, and the cone's 1e-5 floor) bit
  for bit, and while no light sets them the shaders are exactly the original ones. Once one does, the light loop
  evaluates each light by its own form, and so does the volumetric fog's froxel loop in `@margoengine/environment`
  (the same terms, from one shared definition). `setLights()` replaces the list, validates all entries before changing it, and uploads only when called. Animate lights by calling it before rendering. Camera transformations and culling happen on the GPU.

`lights.intensityScale` multiplies all local light radiance and defaults to 1.
Set a nonnegative finite GPU-float value or a callback sampled each render, such
as `() => sky.nightFactor` for automatic night lights. Zero clears the GPU cluster
lists; authored intensities remain unchanged. The setting survives restoration.

Core meshes receive local lighting automatically. Call `lights.add(pbrModel)` or `lights.add(terrain)` for optional renderers; the returned function unregisters the receiver. `lights.add(model, {receiveShadow: false})` lights it without any local-light shadow (integrated maps or `LocalShadows`); casting stays per object through `addShadowCaster` / `LocalShadows.add`. A core mesh with `mesh.receiveShadow = false` (core) is lit without local-light shadows too; the core shader patch carries that test only while some mesh opts out. Directional shadows compose with local lighting in either registration order.

## Directional lights

`@margoengine/clustered/directional` adds up to 16 directional lights beside core's one sun,
shaded in the same light loop as the point lights:

```ts
import {EngineKernel} from '@margoengine/core';
import {Clustered} from '@margoengine/clustered';
import {DirectionalLights} from '@margoengine/clustered/directional';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const lights = Clustered.attach(engine), suns = DirectionalLights.attach(engine, {lights});
suns.setLights([{direction: [-1, -2, 0.5], color: [1, 0.9, 0.8], intensity: 3}]); // direction: the way the light travels
```

`intensity` is the illuminance on a surface facing the light (lux in physical units), as core's sun. The lights use the
point lights' GGX and Lambert BRDF text, so materials' Lambert and Phong shade them with their own BRDF and a
`ShadowCatcherMaterial` counts them; `intensityScale` scales them. Every fragment evaluates every directional light
(they reach everywhere, so they are not culled). With `castShadow` they are shadowed by `LocalShadows` (see
[Directional and area light shadows](#directional-and-area-light-shadows)). The storage buffer (binding 141 of the lit
shader's group) and the shader code exist only while the list is not empty: an empty or absent `DirectionalLights`
leaves every GPU call unchanged. `lights.list` and `suns.list` return the lists last set (frozen copies).

## Directional and area light shadows

`DirectionalLights` and `AreaLights` (`@margoengine/clustered/area`) lights with
`castShadow: true` are shadowed by the `LocalShadows` attached to the same lights: the same casters (`local.add`: core
meshes, glTF-pro models, materials and instanced meshes, `{dynamic: true}` for skinned ones), `bias` and `normalBias`,
and the same depth map array, after the point and spot layers. No binding is added.

```ts
import {Clustered} from '@margoengine/clustered';
import {LocalShadows} from '@margoengine/clustered/shadows';
import {DirectionalLights} from '@margoengine/clustered/directional';
import {AreaLights} from '@margoengine/clustered/area';
import {EngineKernel, box} from '@margoengine/core';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const floor = engine.createMesh().setGeometry(box()).setScale([10, 0.1, 10]);
const table = engine.createMesh().setGeometry(box()).setPosition([0, 1, 0]);
const lights = Clustered.attach(engine), local = LocalShadows.attach(engine, {lights, resolution: 1024});
const suns = DirectionalLights.attach(engine, {lights}), panels = AreaLights.attach(engine, {lights});
suns.setLights([
  {direction: [1, -2, 0], intensity: 2, castShadow: true, shadow: {bounds: {min: [-10, 0, -10], max: [10, 5, 10]}}},
  {direction: [-1, -3, 1], intensity: 1, castShadow: true, shadow: {cascades: 3, distance: 60}},
]);
panels.setLights([{position: [0, 3, 0], direction: [0, -1, 0], width: 1.2, height: 0.4, intensity: 5, castShadow: true}]);
local.add(floor);
local.add(table);
```

- **Directional.** `shadow.bounds` renders one orthographic map over that world box, independent of the camera: it
  re-renders only when the light or a caster changes. Casters and receivers must be inside the box. Without `bounds`,
  `cascades` (1 to 4, default 3) maps are fitted to the camera's view out to `distance` (default 100, or the camera's
  far plane), split half logarithmically and half uniformly, each a bounding sphere snapped to whole texels. These
  re-render when the camera moves. Casters up to `distance` past a cascade toward the light still cast into it. A
  receiver uses the finest cascade that holds it, and is lit outside them all. Filtering is the point lights' 3x3 PCF,
  with the bias and normal offset in texels of the cascade.
- **Area.** Cube faces around the light's centre in its own frame: five (the side it lights and the four sides) or six
  when `twoSided`. Each face covers 45 degrees plus a 0.1 UV guard band. The penumbra is PCSS (Fernando 2005). 16 depth
  reads around the receiver find the blockers, and their mean depth sets the filter radius: the light's half
  `width` and `height` at the receiver times (receiver - blocker) / blocker depth. 24 comparisons filter that radius,
  each against the receiver's tangent plane, so wide filters do not shadow the surface they sit on. Wider or taller
  lights give wider penumbrae. On a real GPU a 1.2-wide light gave a 10-90% penumbra 2.9 times wider than a 0.4-wide
  one (analytic 3), each within 15% of the exact uniform-light width
  (`scripts/clustered-shadow-gpu-check.js`). `shadow.near` (default far / 1000) and `shadow.far` (default 100) bound
  the faces; past `far` a receiver is unshadowed.
- Both take `shadow.resolution` (16 up to LocalShadows' `resolution`, one integer or `[width, height]`; a smaller map
  uses its layers' corner, as a local light's). At most 4 directional and 4 area lights of a list cast
  (`MAX_DIRECTIONAL_SHADOWS`, `MAX_AREA_SHADOWS`); a fifth throws RangeError from `setLights`. Layers: one per
  cascade, five or six per area light, `resolution² × 4` bytes each.
- Limits: the filter radius stops at the guard band (0.1 UV, about 50 texels at 512), so very wide penumbrae are
  clipped. Blockers nearer the light than a quarter of the receiver's distance can fall outside the search. The 24-tap
  filter can band on very wide penumbrae. Without `LocalShadows` the lights stay unshadowed. `ShadowCatcherMaterial`
  does not yet count these shadows. A receiver added with `receiveShadow: false`, or a core mesh with
  `mesh.receiveShadow = false`, is not darkened.
- Off is exact: while no directional or area light casts, the shaders, bindings, buffers and uploads are byte for byte
  what they were before these shadows existed (unit-tested by hash; images and probe radiance compared on a real GPU).

## IES profiles

`@margoengine/clustered/ies` reads IES LM-63 photometric files (the 1986 to 2019 revisions, type C photometry) and
shapes point and spot lights with them:

```ts
import {EngineKernel} from '@margoengine/core';
import {Clustered} from '@margoengine/clustered';
import {IESLights, parseIES} from '@margoengine/clustered/ies';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const lights = Clustered.attach(engine);
const profile = parseIES(await (await fetch('/downlight.ies')).text());
const ies = IESLights.attach(engine, {lights});
lights.setLights([{position: [0, 3, 0], range: 0, decay: 2, intensity: profile.peak}]);
ies.setProfiles([profile]); // entry i shapes the light at index i of setLights
```

Entry i of `setProfiles` belongs to the light at index i of `lights.setLights` (a profile, `{profile, rotation}` or
null); update both together when the list changes order. The profile, normalised to its peak, multiplies the light's
cone term, so `intensity` is the candela of the brightest direction: `profile.peak` reproduces the file, and
`profile.flux` (lumens, the distribution integrated over the sphere) converts a lumen rating. Vertical angle 0 points along
a spot's `direction`, or straight down for a point light; horizontal angle 0 is world +x made perpendicular to that axis
(+z when the axis is within 26° of x), turning counterclockwise seen from behind the light (from above, for a downlight),
plus `rotation` radians. Mirrored files (last horizontal angle 90° or 180°, or 90° to 270°) are unfolded as LM-63
describes; vertical angles outside the file emit nothing; lamp tilt data is read past and not applied; types A and B
throw. The shader reads a 1° × 5° grid of each profile (one column when it is rotationally symmetric) from one storage
buffer (binding 142), filtered bilinearly by hand: no textures. At most 16 distinct profiles at a time. Without profiles
it adds nothing to the shaders or the GPU work.

## Projector lights

`@margoengine/clustered/projector` makes spot lights project an image:

```ts
import {EngineKernel} from '@margoengine/core';
import {Clustered} from '@margoengine/clustered';
import {ProjectorLights} from '@margoengine/clustered/projector';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const lights = Clustered.attach(engine);
const projectors = ProjectorLights.attach(engine, {lights});
lights.setLights([{position: [0, 3, 2], range: 10, direction: [0, -1, -0.6], outerAngle: 0.5, intensity: 40}]);
const bitmap = await createImageBitmap(await (await fetch('/slide.png')).blob());
const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), g = canvas.getContext('2d')!;
g.drawImage(bitmap, 0, 0);
projectors.setProjectors([g.getImageData(0, 0, bitmap.width, bitmap.height)]); // entry i: the spot at index i
```

Entry i of `setProjectors` belongs to the spot at index i of `lights.setLights` (an image, `{image, colorSpace, angle,
aspect}` or null); point lights ignore theirs. The image's UVs are those of the spot's local shadow map
(`localShadowMatrix`: a perspective along `direction` with a field of view of twice the outer angle, up +y, or +z within
8° of vertical), so a shadowed projector's image and shadow line up; it appears upright and unmirrored seen from the
light. `angle` (half the vertical field of view) and `aspect` (default 1, the square of the shadow map) change the
frustum; the cone still bounds the light, so at the default it cuts a square image's corners. The image multiplies the
light (filtered bilinearly, edges clamped, alpha premultiplied); outside it the light is dark. Images are sRGB unless
`colorSpace: 'linear'`, and are copied on the call. They live in one storage buffer (binding 143) as packed rgba8
texels, not textures: physical materials with shadows, IBL and LocalShadows already bind all 16 textures a shader
stage may have. At most 16 distinct images of up to 4,096 texels a side, 16,777,216 texels in all. Without images it
adds nothing to the shaders or the GPU work.

## Physical light units

Margo's light intensities are photometric already, as glTF's KHR_lights_punctual (which gltf-pro's `applyGLTFLights`
passes through unchanged): a point or spot `intensity` is candela, a directional light's (core's sun,
`DirectionalLights`) lux on a surface facing it, an area light's nits; the linear output is luminance in nits.
`@margoengine/clustered/units` holds the conversions, plain functions with no GPU work:

```ts
import {EngineKernel} from '@margoengine/core';
import {Clustered} from '@margoengine/clustered';
import {lumensToCandela, nitsToLumens, ev100, exposureFromEV100} from '@margoengine/clustered/units';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const lights = Clustered.attach(engine);
lights.setLights([
  {position: [0, 3, 0], range: 0, decay: 2, intensity: lumensToCandela(800)},                    // an 800 lm bulb
  {position: [2, 3, 0], range: 0, direction: [0, -1, 0], outerAngle: 0.5, innerAngle: 0.3,
    intensity: lumensToCandela(800, {outerAngle: 0.5, innerAngle: 0.3})},                         // the same in a cone
]);
lights.intensityScale = exposureFromEV100(ev100(2.8, 1 / 60, 800));                              // an indoor exposure
```

`lightSolidAngle(cone?)` is 4π for a point light and 2π(1 − (cos outer + cos inner)/2) for a spot: the smooth edge is a
smoothstep in the cosine, which integrates to half its width, so the conversion is exact for clustered's cone.
`lumensToCandela(lm, profile)` takes an IES profile's peak and flux. `candelaToLux`/`luxToCandela` (inverse square at
normal incidence), `nitsToLumens`/`lumensToNits` (π L A per side of a rectangle light), `nitsToCandela` (an area light as
the point light it matches face on), `ev100(aperture, shutter, iso)` and `exposureFromEV100(ev)` (1 / (1.2 × 2^ev),
saturation-based) complete the set.

## Point and spot shadows

Opt into bounded local shadow maps when creating the effect, enable shadows on
individual lights, and register their casters:

```ts
import {Clustered} from '@margoengine/clustered';
import {EngineKernel,type Mesh} from '@margoengine/core';

function localShadows(engine:EngineKernel,blocker:Mesh) {
  const lights=Clustered.attach(engine,{shadows:{resolution:512,maxLights:4}});
  lights.setLights([
    {position:[0,3,0],range:12,intensity:30,shadow:true},
    {position:[2,4,1],range:15,direction:[0,-1,0],outerAngle:0.6,
      innerAngle:0.3,intensity:40,shadow:{near:0.05,bias:0.0005,normalBias:0.02}},
  ]);
  const removeCaster=lights.addShadowCaster(blocker);
  return ()=>{removeCaster();lights.dispose();};
}
```

`shadows` defaults to resolution 512 and a maximum of four shadowed lights.
`maxLights` is an integer from 1 through 32, independent of the 1,024-light
lighting limit. Each slot reserves six `depth32float` layers; point lights render
all six faces and spot lights render one perspective face; a spot at the full π/2 (a hemisphere, which needs a
180° frustum no single perspective map holds) renders the six cube faces of a point light, here and in
`LocalShadows`. Four slots at 512
reserve 24 MiB of depth storage. Attachment validates texture dimensions, array
layers and buffer limits before allocation. `setLights()` validates the full
replacement before changing the list; too many shadowed lights reject explicitly.

Per-light `shadow` defaults to false. `shadow:true` uses near distance
`min(0.1, far/100)`, far distance `range`, depth bias 0.0005, world-space normal bias 0.02 and a map of
`shadows.resolution` texels. An object overrides those values; near must be positive and below far, and both biases
must be finite and nonnegative. Animate positions, directions, ranges or shadow settings with `setLights()` before
rendering.

Per light, as Crocotile's Shadow Map Width/Height and shadow camera Near/Far:

```ts
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const lights = Clustered.attach(engine, {shadows: {resolution: 1024, maxLights: 2}});
lights.setLights([
  {position: [0, 4, 0], range: 12, intensity: 30, shadow: {resolution: 256, near: 0.2, far: 8}},
  {position: [3, 5, 1], range: 0, decay: 1, direction: [0, -1, 0], angle: 0.6, shadow: {resolution: [1024, 512], far: 20}},
]);
```

`far` (default the light's `range`) ends the shadow camera: casters and receivers past it are unshadowed, and a light
with unlimited range (`range: 0`) can have a shadow map only with an explicit `far`. `resolution` is one integer or
`[width, height]`, each from 16 up to `shadows.resolution`, which stays the size of every layer and so the most a light
can ask for: memory is `maxLights × 6 × resolution² × 4` bytes whatever the lights ask (one slot at 2048: 96 MiB). A
smaller map renders into the top-left corner of its layers (a point light all six cube faces, a spot its cone) and is
sampled there with matching UVs, so a 256 light has 256 texels of detail next to a 1024 one; it keeps two texels per
side as a guard band, so the 3×3 filter never reads past it. A light at the full size uploads and renders exactly what
it did before these options existed, and the shaders never change.

`LocalShadows` (`castShadow` lights) takes the same per-light map size and near/far from the light's `shadow` object,
up to its own `resolution`, the same way (corner viewport, matching UVs, two-texel guard band, no shader change):

```ts
import {EngineKernel, box} from '@margoengine/core';
import {Clustered} from '@margoengine/clustered';
import {LocalShadows} from '@margoengine/clustered/shadows';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const blocker = engine.createMesh().setGeometry(box()).setPosition([0, 2, 0]);
const lights = Clustered.attach(engine), local = LocalShadows.attach(engine, {lights, resolution: 1024});
lights.setLights([{position: [0, 4, 0], range: 12, castShadow: true, shadow: {resolution: [512, 256], far: 8}}]);
local.add(blocker);
```

Without `ClusteredOptions.shadows` a castShadow light's `shadow` may hold only `resolution`, `near` (default far /
1000) and `far`: `LocalShadows` takes its biases, in texels, from its options. A size above its `resolution` throws
when the maps render. With both systems attached, a light with `castShadow` and a `shadow` object is shadowed by both.

`addShadowCaster()` accepts core meshes, individual loaded glTF/FBX nodes and sources exposing `shadowPrimitives`
(a primitive with `displacement`, a materials mesh with a `displacementMap`, is drawn displaced here and in
`LocalShadows`),
including glTF Pro models and their current deformed vertex buffers. Overlapping model/node registrations draw each primitive once, including distinct materials sharing GPU geometry. PBR masks
honor alpha, vertex alpha, UV0/UV1 and texture transforms; blended PBR primitives
are excluded. Hidden ancestors and disposed sources stop casting. Register a
model with both `addShadowCaster(model)` and `add(model)` when it also receives
local lighting. Custom-only `drawShadow()` sources such as clipmap terrain are
not local shadow casters in this version; terrain can receive the shadows.

Local depth passes run before clustered culling and main shading, redraw active
faces each frame, and use a fixed 3×3 comparison filter. Shadows multiply only
their own light's contribution. Ambient, unshadowed local lights and directional
cascades retain their responses. Bias and resolution control acne and detached
edges; this filter does not model area-light penumbrae (area lights' own shadows do, below). Device restoration
recreates the maps and caster bindings; disposal releases owned resources.

Without `ClusteredOptions.shadows`, the original shader, four lighting bindings
and allocation path remain exact. Opted-in effects add bindings 16–18 in the
existing lighting group (group 2 for glTF Pro); group 3 remains the independent
material slot. TAA, sky and terrain's existing bindings remain available.

Fragment lookup removes camera projection jitter before selecting the unjittered compute cluster. This keeps TAA from dropping small lights at fractional tile boundaries; the uniform's previously unused depth.zw fields carry the screen offset, without a dependency on TAA.

Each cluster reserves 1,024 indices, preventing silent truncation when many lights overlap. The default grid uses 13.5 MiB for indices. An optional `grid:[x,y,z]` is checked against storage limits at attachment. `lightLists` exposes GPU counts/indices for diagnostics or custom forward materials; ordinary rendering needs no readback. `clusteredSampling(group)` exports WGSL for custom materials. Frame rate depends on light overlap, materials, resolution and hardware; no locked FPS is promised.

Custom code reproducing `ClusterFrame` must include the trailing `intensity:vec4f`
at byte 112, making the uniform 128 bytes. Its X component is the radiance scale.
Consumers of `clusteredSampling()` and `bindings()` receive this layout automatically.
Custom shadow-aware materials use `clusteredSampling(group,true)` with the
bindings of a shadow-enabled effect; the default second argument is false.

`dispose()`/`destroy()` releases resources and receiver hooks. Device restoration recreates buffers and reuploads the light list. The package stays separate from core, stage and PBR assets.
