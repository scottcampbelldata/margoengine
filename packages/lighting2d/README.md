# @margoengine/lighting2d

2D lights for pixel pictures: point, spot and directional lights, normal-mapped shading from a sprite layer's normals, and
hard shadows from occluder edges. Each frame the lights add up in one target, which a pixel layer multiplies over what
is below it. WebGPU only.

```ts
import {EngineKernel} from 'margoengine/core';
import {LayerCompositor} from 'margoengine/pixel';
import {Lighting2D} from 'margoengine/lighting2d';
const canvas = document.querySelector('canvas')!;
const engine = await EngineKernel.create(canvas, {backend: 'webgpu', exactSize: [640, 360]});
const compositor = LayerCompositor.attach(engine, {camera: {width: 160, height: 90, zoom: 4}});
const picture = compositor.addLayer();
const shade = compositor.addLayer({blend: 'multiply', z: 1});
const lighting = Lighting2D.attach(engine, {target: shade.target, camera: shade.camera, ambient: '#202030'});
const lamp = lighting.addLight({x: 40, y: 30, radius: 80, color: '#ffd9a0'});
lighting.setOccluders([{shape: 'box', width: 16, height: 16, offset: [80, 45]}]);
picture.write({width: 160, height: 90, data: new Uint8Array(160 * 90 * 4).fill(200)});
engine.render({delta: 1 / 60});
lamp.x += 1; // read each frame
```

## Lighting2D

| Option | Default | What it does |
| --- | --- | --- |
| `target` | required | Where the light goes, a texture or a function such as a layer's `target` |
| `normals` | flat | Surface directions the size of the target, such as a sprite layer's `normals.target` |
| `camera` | `{x: 0, y: 0, zoom: 1}` | World units to pixels, such as a layer's `camera`; read each frame |
| `ambient` | `#000000` | The light everything gets; read each frame |
| `occluders` | none | What blocks light; see `setOccluders` |
| `order` | `20` | Frame-graph order, after sprites and maps and before the compositor |
| `name` | `lighting2d-1`, ... | Plugin name, unique per scene |
| `layer` | `~0` (all) | Layer bitmask this pass illuminates; lights must share a bit to be drawn |

`addLight(options)` returns a `Light2D`, `removeLight(light)` takes it away, and `lights` lists them.

Lights add up in four half-float layers, 32 B per pixel of the target, so a sum of many lights reads the same on GPUs that
round blends differently. `docs/limits.md` has the numbers.

## Light2D

Every field is read each frame. Distances are world units, angles radians, and y runs down the screen.

| Field | Default | What it does |
| --- | --- | --- |
| `kind` | `'point'` | `'point'`, `'spot'` or `'directional'` |
| `x`, `y` | `0` | Position |
| `color`, `intensity` | `#ffffff`, `1` | What it adds at full strength |
| `radius`, `falloff` | `64`, `2` | Strength is `(1 - distance / radius) ^ falloff` |
| `height` | `32` | How far in front of the picture it sits; a low light grazes flat surfaces, and 0 leaves them dark |
| `angle` | `0` | Spot and directional: the way it shines, clockwise from +x |
| `cone`, `softness` | `Math.PI / 4`, `0` | Spot: half the cone, and the outer part of it that fades, 0 to 1 |
| `elevation` | `Math.PI / 4` | Directional: how far above the picture |
| `shadows` | `true` | False lets it through occluders |
| `layers` | `~0` (all) | Bitmask of layers this light illuminates |
| `mask` | none | Geometric boundary (`rect`, `circle`, `polygon`) clipping the light |

A surface gets the strength times the cosine between its normal and the way to the light. Normals follow the sprite
layer's target: x right, y down the screen, z out of it. Where the normal target holds nothing (alpha 0) the surface is flat.

## Occluders

`setOccluders(list)` replaces what blocks light. Each is `{shape: 'polygon', points}`, `{shape: 'polyline', points}`,
`{shape: 'segment', from, to}`, `{shape: 'box', width, height, offset, rotation}` or `{shape: 'circle', radius, offset}`,
in world units. The result of `tileMapColliders(map)` from `margoengine/physics2d` fits as it is, so a tile map's
collision shapes cast shadows too.

A pixel is in shadow when an occluder edge lies between its centre and the light, so the inside of a closed shape is dark
to a light outside it. Shadow edges are hard: each pixel is lit or not, with no soft penumbra.

## Light masks and layers

Lights can be filtered to specific layers or restricted to a geometric mask. Set `layers` on `Light2D` and `layer` on `Lighting2D` to select which lights affect which passes:

```ts
import {EngineKernel} from 'margoengine/core';
import {LayerCompositor} from 'margoengine/pixel';
import {Lighting2D} from 'margoengine/lighting2d';
const canvas = document.querySelector('canvas')!;
const engine = await EngineKernel.create(canvas, {backend: 'webgpu', exactSize: [640, 360]});
const compositor = LayerCompositor.attach(engine, {camera: {width: 160, height: 90, zoom: 4}});
const picture = compositor.addLayer();
const shade = compositor.addLayer({blend: 'multiply', z: 1});
const lighting = Lighting2D.attach(engine, {target: shade.target, camera: shade.camera, layer: 0b01});
const lamp = lighting.addLight({
  x: 40,
  y: 30,
  radius: 80,
  color: '#ffd9a0',
  layers: 0b01,
  mask: {kind: 'rect', minX: 10, minY: 10, maxX: 70, maxY: 60},
});
picture.write({width: 160, height: 90, data: new Uint8Array(160 * 90 * 4).fill(200)});
engine.render({delta: 1 / 60});
lamp.x += 1;
```

`inLightMask(mask, x, y)` and `lightAffectsLayer(light, layerMask)` evaluate masks and layer masks in Node.

## Soft shadows

`@margoengine/lighting2d/soft` provides soft penumbra shadows that soften with distance from the occluder. Near the occluder,
shadow edges remain crisp; as distance increases, the penumbra widens proportionally to the light's emitter radius (`sourceRadius`).

```ts
import {EngineKernel} from 'margoengine/core';
import {LayerCompositor} from 'margoengine/pixel';
import {SoftLighting2D} from 'margoengine/lighting2d/soft';
const canvas = document.querySelector('canvas')!;
const engine = await EngineKernel.create(canvas, {backend: 'webgpu', exactSize: [640, 360]});
const compositor = LayerCompositor.attach(engine, {camera: {width: 160, height: 90, zoom: 4}});
const picture = compositor.addLayer();
const shade = compositor.addLayer({blend: 'multiply', z: 1});
const soft = SoftLighting2D.attach(engine, {target: shade.target, camera: shade.camera, ambient: '#202030', sourceRadius: 6});
const lamp = soft.addLight({x: 40, y: 30, radius: 80, color: '#ffd9a0', sourceRadius: 8});
soft.setOccluders([{shape: 'box', width: 16, height: 16, offset: [80, 45]}]);
picture.write({width: 160, height: 90, data: new Uint8Array(160 * 90 * 4).fill(200)});
engine.render({delta: 1 / 60});
lamp.x += 1;
```

CPU helper functions `softShadowFactor(light, edges, x, y, options)`, `softInShadow(light, edges, x, y, options)` and
`softLightAt(light, x, y, edges, normal, options)` evaluate soft shadows in Node for testing.

## Light textures (cookies)

`@margoengine/lighting2d/cookie` projects 2D textures (cookies / gobos) onto light footprints to shape lights with window patterns,
slats, caustics or flashlights.

```ts
import {EngineKernel} from 'margoengine/core';
import {LayerCompositor} from 'margoengine/pixel';
import {CookieLighting2D, createSpotCookie} from 'margoengine/lighting2d/cookie';
const canvas = document.querySelector('canvas')!;
const engine = await EngineKernel.create(canvas, {backend: 'webgpu', exactSize: [640, 360]});
const compositor = LayerCompositor.attach(engine, {camera: {width: 160, height: 90, zoom: 4}});
const picture = compositor.addLayer();
const shade = compositor.addLayer({blend: 'multiply', z: 1});
const cookies = CookieLighting2D.attach(engine, {target: shade.target, camera: shade.camera, ambient: '#202030'});
const cookie = createSpotCookie(32, 0.4, 0.9);
const flashlight = cookies.addLight({x: 40, y: 30, radius: 80, color: '#ffd9a0', cookie, cookieScale: [60, 60]});
cookies.setOccluders([{shape: 'box', width: 16, height: 16, offset: [80, 45]}]);
picture.write({width: 160, height: 90, data: new Uint8Array(160 * 90 * 4).fill(200)});
engine.render({delta: 1 / 60});
flashlight.x += 1;
```

A `CookieLight2D` takes `cookie: CookieTexture2D`, `cookieScale: [width, height]`, `cookieOffset: [x, y]`, `cookieRotation: radians`,
`cookieWrap: 'zero' | 'clamp' | 'repeat' | 'mirror'`, and `cookieMode: 'multiply' | 'alpha' | 'color'`. Presets `createSpotCookie`
and `createWindowCookie` construct standard patterns. CPU helper `cookieLightAt(light, x, y, normal)` evaluates the shaped light in Node.

## 2D global illumination

The `@margoengine/lighting2d/gi` prototype has unresolved correctness defects. It is not a validated spatial radiance-cascade
implementation. Multi-bounce transport, interval merging, visibility, light packing and camera alignment remain under repair;
see [the lighting2d findings](../../docs/known-bugs.md#lighting2d-batch-55-gi-review). CPU/GPU agreement in the original scene
is not proof of physical correctness. The example below demonstrates the current API only.

```ts
import {EngineKernel} from 'margoengine/core';
import {LayerCompositor} from 'margoengine/pixel';
import {GILighting2D} from 'margoengine/lighting2d/gi';
const canvas = document.querySelector('canvas')!;
const engine = await EngineKernel.create(canvas, {backend: 'webgpu', exactSize: [640, 360]});
const compositor = LayerCompositor.attach(engine, {camera: {width: 160, height: 90, zoom: 4}});
const picture = compositor.addLayer();
const shade = compositor.addLayer({blend: 'multiply', z: 1});
const gi = GILighting2D.attach(engine, {
  target: shade.target,
  camera: shade.camera,
  ambient: '#101020',
  emitters: [{x: 40, y: 30, radius: 12, color: '#ffd9a0', intensity: 2}],
  occluders: [{shape: 'box', width: 16, height: 16, offset: [80, 45]}],
  cascades: {cascades: 2, baseRays: 4, baseDistance: 32, bounces: 1, albedo: 0.6},
});
picture.write({width: 160, height: 90, data: new Uint8Array(160 * 90 * 4).fill(200)});
engine.render({delta: 1 / 60});
gi.emitters[0] = {x: 41, y: 30, radius: 12, color: '#ffd9a0', intensity: 2};
```

`RadianceCascade2D` and `evaluate2DGI(point, normal, scene, options)` evaluate 2D global illumination on the CPU for tests.

## 2.5D height and self-shadowing

`@margoengine/lighting2d/height` casts perspective height shadows and self-shadows for top-down and isometric games.
Sprites and structures have vertical height (z-axis extrusion) and elevation; light rays from point, spot and directional
lights cast geometric shadows onto flat ground planes and lower receivers. Each GPU pass shades a flat +z-facing receiver
at one elevation; arbitrary vertical-face normals are supported only by the CPU helper.

```ts
import {EngineKernel} from 'margoengine/core';
import {LayerCompositor} from 'margoengine/pixel';
import {HeightLighting2D, createHeightOccluder} from 'margoengine/lighting2d/height';
const canvas = document.querySelector('canvas')!;
const engine = await EngineKernel.create(canvas, {backend: 'webgpu', exactSize: [640, 360]});
const compositor = LayerCompositor.attach(engine, {camera: {width: 160, height: 90, zoom: 4}});
const picture = compositor.addLayer();
const shade = compositor.addLayer({blend: 'multiply', z: 1});
const building = createHeightOccluder({shape: 'box', offset: [80, 45], width: 24, depth: 24, height: 16, selfShadow: true});
const lighting = HeightLighting2D.attach(engine, {
  target: shade.target,
  camera: shade.camera,
  occluders: [building],
  elevation: 0,
});
const sun = lighting.addLight({kind: 'directional', angle: 0, elevation: Math.PI / 4, color: '#fff0d0'});
picture.write({width: 160, height: 90, data: new Uint8Array(160 * 90 * 4).fill(200)});
engine.render({delta: 1 / 60});
sun.angle += 0.01;
```

CPU helper functions `inHeightShadow(light, occluders, x, y, receiverElevation)`, `heightShadowFactor(light, occluders, x, y, receiverElevation)`
and `heightLightAt(light, occluders, x, y, receiverElevation, normal)` evaluate height-based shading and self-shadowing in Node.

## Emissive sprites and bloom hookup

`@margoengine/lighting2d/emissive` adds glowing emissive sprites that emit light into the scene with falloff, and isolates
linear HDR emission and local threshold extraction in separate owned `rgba16float` textures. The pass clears and replaces
its target every frame. `emissiveTexture` contains emission plus the local glow; `bloomTexture` contains the local threshold
contribution alone. Neither texture aliases the caller's target. These textures are replaced on resize or restoration.

```ts
import {EngineKernel} from 'margoengine/core';
import {LayerCompositor} from 'margoengine/pixel';
import {EmissiveLighting2D} from 'margoengine/lighting2d/emissive';
const canvas = document.querySelector('canvas')!;
const engine = await EngineKernel.create(canvas, {backend: 'webgpu', exactSize: [640, 360]});
const compositor = LayerCompositor.attach(engine, {camera: {width: 160, height: 90, zoom: 4}});
const picture = compositor.addLayer();
const shade = compositor.addLayer({blend: 'multiply', z: 1});
const emissive = EmissiveLighting2D.attach(engine, {
  target: shade.target,
  camera: shade.camera,
  bloom: true,
  bloomThreshold: 0.8,
  bloomIntensity: 1.0,
});
const orb = emissive.addSprite({x: 80, y: 45, radius: 8, glowRadius: 24, color: '#ffcc44', intensity: 2.0});
picture.write({width: 160, height: 90, data: new Uint8Array(160 * 90 * 4).fill(200)});
engine.render({delta: 1 / 60});
orb.x += 1;
```

`connectBloom(() => new Bloom(options))` owns an unattached image effect from `@margoengine/post/bloom`, dispatches
its real `encodeImage` API on the isolated HDR emission, and presents the filtered HDR result to the target. Its factory is
called again after device restoration; the pass disposes the old effect. An attached Bloom or a `setInput` mock is not a
supported adapter. Set `bloom: false` to use only the external spatial blur, without the local glow contribution.

```ts
import {EngineKernel} from 'margoengine/core';
import {LayerCompositor} from 'margoengine/pixel';
import {EmissiveLighting2D} from 'margoengine/lighting2d/emissive';
import {Bloom} from 'margoengine/post/bloom';
const engine = await EngineKernel.create(document.querySelector('canvas')!, {backend: 'webgpu', exactSize: [320, 180]});
const compositor = LayerCompositor.attach(engine, {camera: {width: 160, height: 90, zoom: 2}});
const shade = compositor.addLayer({blend: 'add'});
const emission = EmissiveLighting2D.attach(engine, {target: shade.target, camera: shade.camera, bloom: false});
emission.addSprite({x: 80, y: 45, radius: 3, glowRadius: 0, intensity: 3});
emission.connectBloom(() => new Bloom({threshold: 0.8, strength: 0.8}));
engine.render({delta: 0});
```

`emissiveLightAt(sprite, x, y, layerMask, bloomIntensity, bloomThreshold)` evaluates direct emission and local glow in Node.
The effective local threshold is the larger of the sprite threshold and global threshold (default 0.8 for each).
The local glow is an analytic intensity term, not a spatial convolution; the optional Bloom adapter supplies spatial filtering.

## CPU forms

`lightAt(light, x, y, normal)` is what a light adds at a world point, `occluderEdges(list)` the edges of a list, and
`inShadow(light, edges, x, y)` the shadow test. They run in Node, for tools and tests.

Trademark notice: names of other tools belong to their owners.

## Lifetime and scene limits

All entries are WebGPU-only and reject native WebGL2 with `code: 'unsupported'` and a help link. Each entry owns its GPU
resources, rebuilds them after device restoration or target format changes, unregisters on disposal, and allows a new pass
with the same name to attach. Submit a manually supplied command encoder before disposing its pass.

The direct-light entries (root, soft, cookie and height) share rect, circle and polygon masks, including inversion and
pass/light layer filtering. An omitted circle-mask centre is world `(0, 0)`. Mask points are uploaded every frame so mutable
polygons take effect immediately. Polygon storage is bounded by the device's `maxStorageBufferBindingSize` (16 bytes per
point). Height occluders cost 48 bytes each, emissive sprites 64 bytes each, bounded by the same limit; neither silently drops
items beyond 64. Height uniforms cost at least 256 bytes per light, bounded by `maxBufferSize`. Excess storage throws before
a draw. Soft sample counts must be integers in `[1, 64]`. Camera coordinates and zoom must be finite, with zoom above zero.

Height and emissive targets contain the current frame only, including when all lights/sprites are removed. Compose separate
lighting targets with pixel layers when combining passes. The regression suite includes native WebGL2 refusals, distinct
height light uniforms, floating volumes, lights below the receiver, 65-item scenes, frame ordering, repeated frames, target
format changes, name reuse, HDR extraction, the actual Bloom image adapter and device restoration. GI remains the exception
to the physical-correctness claims above until its known defects are resolved.

Height lights accumulate into an owned `rgba16float` image and present once to the target. This retains contributions smaller than one target byte (100 lights at intensity .001 sum to .1); the HDR image is rebuilt on resize or device restoration.
