# @margoengine/pixel

Import `margoengine/pixel` from the `margoengine` package, or `@margoengine/pixel` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Pixel art that stays crisp. A `PixelCamera` scrolls by whole low-res pixels with parallax per layer and a whole-number
zoom. A `LayerCompositor` gives each layer its own low-res target and puts them on the screen with no filtering. Each
output pixel works out which source pixel it shows, so even a layer turned 30 degrees is made only of source colours.
Core stays the same size: an app that does not import this package ships none of it.

```ts
import { EngineKernel } from 'margoengine/core';
import { LayerCompositor } from 'margoengine/pixel';

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const engine = await EngineKernel.create(canvas, { exactSize: [640, 360] });

// A 160 x 90 view. With no zoom set it takes the largest whole number that fits: 4 here.
const compositor = LayerCompositor.attach(engine, { camera: { width: 160, height: 90 } });

// A picture fixed in the world, at half the camera's speed. An ImageBitmap works too.
const data = new Uint8Array(160 * 90 * 4).fill(255);
const hills = compositor.addLayer({ anchor: 'world', parallax: 0.5 });
hills.write({ width: 160, height: 90, data });

// A layer on top of it, turned 30 degrees about the middle of the view and half see-through.
const glow = compositor.addLayer({ anchor: 'world', blend: 'add', opacity: 0.5, rotation: Math.PI / 6 });
glow.write({ width: 160, height: 90, data });

engine.start();

// Moves nothing until the scroll reaches a whole low-res pixel.
compositor.camera.x += 0.5;
```

Draw into a layer with `@margoengine/sprites`, which reads the layer's target and camera each frame, or with a core view.
A sprite layer's order must be below the compositor's, and its default of 10 is. Views into layers come before the canvas:

```ts
import { EngineKernel } from 'margoengine/core';
import { LayerCompositor } from 'margoengine/pixel';

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const engine = await EngineKernel.create(canvas, { exactSize: [320, 180] });
const compositor = LayerCompositor.attach(engine, { camera: { width: 160, height: 90 } });
const actors = compositor.addLayer();

// With sprites: SpriteLayer.attach(engine, { atlas, target: actors.target, camera: actors.camera });
engine.render({
  views: [
    { camera: engine.camera, viewport: [0, 0, 1, 1], target: { color: actors.texture } },
    { camera: engine.camera, viewport: [0, 0, 1, 1] },
  ],
});
```

## PixelCamera

| Option | Default | What it does |
| --- | --- | --- |
| `width`, `height` | required | Low-res view size, whole numbers |
| `x`, `y` | 0 | World position at the top-left, y down, read each frame |
| `zoom` | fits the canvas | Output pixels per low-res pixel. Anything but a whole number throws `RangeError` |
| `minZoom`, `maxZoom` | 1, 64 | Bounds of `zoom` and of `fit` |
| `unitsPerPixel` | 1 | World units in one low-res pixel |
| `smooth` | false | Carries scroll below a low-res pixel into the composite, in whole output pixels |

Methods: `fit(width, height)` sets the largest zoom that fits and returns it; `pixelX(parallax)` and `pixelY(parallax)`
are the whole pixels scrolled; `scroll(parallax)` also gives the rest. `projection(parallax)` gives orthographic bounds
for `CameraProjection` in `@margoengine/cameras`, so 3D views line up with the same pixels.

The scroll goes down to the whole pixel below it, in both directions: `x = 0.9` shows pixel 0 and `x = -0.1` shows
pixel -1, so a step of one world pixel always moves the picture by one.

## LayerCompositor

| Option | Default | What it does |
| --- | --- | --- |
| `camera` | required | A `PixelCamera`, or its options |
| `order` | 30 | Frame-graph order. A `Tonemap` at 31 grades what is drawn before it, so set 40 to keep bytes exact |
| `layers` | 1 | Render-layer bits; a canvas view with `layers` that shares none gets no composite |
| `name` | `pixel-1`, ... | Plugin name, unique per scene |

Methods: `addLayer(options)`, `removeLayer(layer)`, `dispose()` (or `using`). Read `layers` for the list in draw order.
The picture sits in the middle of the canvas or view. Views into a texture get no composite, since they may be drawing a
layer.

## PixelLayer

| Option | Default | What it does |
| --- | --- | --- |
| `width`, `height` | the camera's | Target size in low-res pixels |
| `anchor` | `'view'` | `'view'`: whatever draws it follows `layer.camera`. `'world'`: a fixed picture the compositor moves |
| `parallax` | 1 | Scroll factor, or `[x, y]`. 0 stays put |
| `x`, `y` | 0 | Offset in low-res pixels |
| `opacity` | 1 | Multiplies the colours, 0 to 1 |
| `blend` | `'normal'` | `'normal'`, `'add'`, `'multiply'` or `'screen'` |
| `rotation` | 0 | Clockwise turn, radians |
| `pivot` | middle of the view | Point it turns about, in view pixels |
| `z` | 0 | Higher draws over lower; equal `z` keeps the order added |
| `visible` | true | False leaves it out |

All but size and anchor can change whenever you like. Read `texture` for the `rgba8unorm` target and `target` for the
same thing as a function; `camera` is the live camera for whatever draws the layer; `write(image)` puts a picture in it.
Colours in a target are premultiplied by alpha, which is what a sprite layer leaves over a clear target; `write` takes
straight alpha and converts. A `smooth` camera's `'view'` layers have one extra pixel each way to show when they shift.

Exact bytes need one sample per pixel, which `exactSize` gives; an engine with MSAA draws the same picture. Targets come
back by themselves after a device loss, with the last `write` in them, so read `layer.texture` each frame rather than
keeping it.
