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

A surface gets the strength times the cosine between its normal and the way to the light. Normals follow the sprite
layer's target: x right, y down the screen, z out of it. Where the normal target holds nothing (alpha 0) the surface is flat.

## Occluders

`setOccluders(list)` replaces what blocks light. Each is `{shape: 'polygon', points}`, `{shape: 'polyline', points}`,
`{shape: 'segment', from, to}`, `{shape: 'box', width, height, offset, rotation}` or `{shape: 'circle', radius, offset}`,
in world units. The result of `tileMapColliders(map)` from `margoengine/physics2d` fits as it is, so a tile map's
collision shapes cast shadows too.

A pixel is in shadow when an occluder edge lies between its centre and the light, so the inside of a closed shape is dark
to a light outside it. Shadow edges are hard: each pixel is lit or not, with no soft penumbra.

## CPU forms

`lightAt(light, x, y, normal)` is what a light adds at a world point, `occluderEdges(list)` the edges of a list, and
`inShadow(light, edges, x, y)` the shadow test. They run in Node, for tools and tests.

Trademark notice: names of other tools belong to their owners.
