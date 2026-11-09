# @margoengine/pixel

Import `margoengine/pixel` from the `margoengine` package, or `@margoengine/pixel` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Pixel art that stays crisp. A `PixelCamera` scrolls by whole low-res pixels with parallax per layer and a whole-number
zoom. A `LayerCompositor` gives each layer its own low-res target and puts them on the screen with no filtering. Each
output pixel works out which source pixel it shows, so even a layer turned 30 degrees is made only of source colours.
Core stays the same size: an app that does not import this package ships none of it.

```ts
import { EngineKernel } from 'margoengine/core';
import { LayerCompositor, PixelCamera } from 'margoengine/pixel';

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const engine = await EngineKernel.create(canvas, { exactSize: [640, 360] });

// A 160 x 90 view. With no zoom set it takes the largest whole number that fits: 4 here.
const camera = new PixelCamera({ width: 160, height: 90, smooth: true });
const compositor = LayerCompositor.attach(engine, { camera });

// A picture fixed in the world, at half the camera's speed. An ImageBitmap works too.
const data = new Uint8Array(160 * 90 * 4).fill(255);
const hills = compositor.addLayer({ anchor: 'world', parallax: 0.5 });
hills.write({ width: 160, height: 90, data });

// A layer on top of it, turned 30 degrees about the middle of the view and half see-through.
const glow = compositor.addLayer({ anchor: 'world', blend: 'add', opacity: 0.5, rotation: Math.PI / 6 });
glow.write({ width: 160, height: 90, data });

engine.start();

// With smooth: true, half a low-res pixel moves two output pixels at zoom 4.
compositor.camera.x += 0.5;
```

`smooth: true` carries fractional low-res scroll into whole output pixels, preserving crisp texels. The default is
`false`: scrolling then waits for a whole low-res pixel. View layers include the extra border needed by smooth scroll.

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

## Scaling to any screen

`margoengine/pixel/scale` draws a low-res picture as large as the canvas allows when the canvas is not a whole multiple
of it, such as 320 x 180 art on a 1366 x 768 laptop (4.27 times). Nearest sampling there makes some art pixels one
screen pixel wider than others; `'sharp-bilinear'` keeps every art pixel flat and mixes only the one screen pixel that
straddles two of them, by how much of it each covers. `'edge'` first doubles the art by the Scale2x rule, which rounds
diagonal steps, then scales the same way.

```ts
import {EngineKernel} from 'margoengine/core';
import {LayerCompositor} from 'margoengine/pixel';
import {PixelScale} from 'margoengine/pixel/scale';
const canvas = document.querySelector('canvas')!;
const engine = await EngineKernel.create(canvas, {backend: 'webgpu', exactSize: [1366, 768]});
const compositor = LayerCompositor.attach(engine, {camera: {width: 320, height: 180}});
const art = compositor.addLayer({visible: false}); // sprites and maps draw here
const scale = PixelScale.attach(engine, {source: art.target, filter: 'sharp-bilinear'});
engine.render({delta: 1 / 60});
scale.filter = 'edge'; // read each frame
```

| Option | Default | What it does |
| --- | --- | --- |
| `source` | required | The low-res picture, premultiplied as in a pixel layer: a texture or a function returning one |
| `target` | each canvas view | A texture to draw into instead, cleared first; on the canvas the picture goes over what is there |
| `filter` | `'sharp-bilinear'` | `'nearest'`, `'sharp-bilinear'` or `'edge'`, read each frame |
| `fit` | `'contain'` | `'contain'`: as large as fits keeping its shape, in the middle; `'stretch'`: the whole view. Read each frame |
| `layers` | 1 | Render-layer bits; a canvas view whose `layers` shares none is left alone |
| `order` | `35` | Frame-graph order, after a compositor (30) |
| `name` | `pixel-scale-1`, ... | Plugin name, unique per scene |

The picture covers whole screen pixels: `fitRect(width, height, viewWidth, viewHeight, fit)` gives that rectangle.
`'edge'` needs room for the doubled picture: below 2 times it draws as `'sharp-bilinear'`. Colours mix as stored, not
in linear light. `scale2x(image)` is the CPU form of the doubling, to export sprites at twice the size.
Canvas draws intersect the fitted picture with the view's scissor and canvas bounds, without rescaling the clipped
picture. PixelScale and CRT may switch output formats and return to a cached format. Direct `dispose()` unregisters
the pass from its owning scene, even when another scene has a plugin of the same name, and frees its uniform buffers.

## CRT look

`margoengine/pixel/crt` draws a low-res picture as an old tube screen would show it: the glass bows out, each art row
is a beam bright in its middle with darker gaps between rows, an aperture grille passes red, green and blue in turn
across the screen columns, and glow adds a soft blur of the picture on top. It is worked out from the art's own rows,
so the lines stay one per art pixel at any screen size.

```ts
import {EngineKernel} from 'margoengine/core';
import {LayerCompositor} from 'margoengine/pixel';
import {CRT} from 'margoengine/pixel/crt';
const canvas = document.querySelector('canvas')!;
const engine = await EngineKernel.create(canvas, {backend: 'webgpu', exactSize: [960, 720]});
const compositor = LayerCompositor.attach(engine, {camera: {width: 256, height: 192}});
const art = compositor.addLayer({visible: false}); // sprites and maps draw here
const crt = CRT.attach(engine, {source: art.target, curvature: 0.1, scanlines: 0.6});
engine.render({delta: 1 / 60});
crt.glow = 0.4; // every look setting is read each frame
```

| Option | Default | What it does |
| --- | --- | --- |
| `source`, `target`, `fit`, `layers` | as `PixelScale` | The picture, where it goes and how it fills the view |
| `curvature` | `0.08` | How much the glass bends, 0 (flat) to 0.5; outside the glass is black |
| `scanlines` | `0.5` | How dark the gaps between art rows get, 0 to 1 |
| `mask` | `0.2` | How much the grille dims the two colours a screen column does not pass, 0 to 1 |
| `glow` | `0.25` | How much of a 3 x 3 blur of the art is added, 0 to 1 |
| `brightness` | `1.2` | Multiplies the beam to win back what the lines and grille take, 0 to 4 |
| `order` | `35` | Frame-graph order, after a compositor (30) |
| `name` | `crt-1`, ... | Plugin name, unique per scene |

With every effect at 0 and `brightness` 1 the CRT is plain nearest sampling, including exact source boundaries:
output coordinate `o` inside a fitted side of length `w` selects source texel `floor((2 * o + 1) * n / (2 * w))`.
Flat glass uses this integer quotient, so a boundary selects the texel on its right or below. The grille needs about 3 screen pixels a
column to read as one; below that it shows as a faint pattern.

## Palettes and dithering

`margoengine/pixel/palette` reduces a low-res picture to a palette: one pass from a layer into another, with each pixel becoming exactly one palette colour. Matching is in Oklab or plain sRGB. Ordered Bayer 2, 4 and 8 and a 64 x 64 blue-noise tile dither before matching. `swap` draws other colours for the same matches.

```ts
import {EngineKernel} from 'margoengine/core';
import {LayerCompositor} from 'margoengine/pixel';
import {PaletteQuantize, paletteRamp} from 'margoengine/pixel/palette';
const canvas = document.querySelector('canvas')!;
const engine = await EngineKernel.create(canvas, {backend: 'webgpu', exactSize: [320, 180]});
const compositor = LayerCompositor.attach(engine, {camera: {width: 320, height: 180}});
const drawn = compositor.addLayer({visible: false}); // sprites and maps draw here
const shown = compositor.addLayer();
PaletteQuantize.attach(engine, {
  palette: paletteRamp('#101820', '#f4e9d8', 4),
  source: drawn.target,
  target: shown.target,
  dither: 'bayer4',
});
engine.render({delta: 1 / 60});
```

| Option | Default | What it does |
| --- | --- | --- |
| `palette` | required | 1 to 256 colours, `#rrggbb` or `[r, g, b]` bytes. `setPalette` swaps it |
| `swap` | the palette | Colours to draw for each match, same length |
| `source`, `target` | required | Different textures, or functions returning them; `target` is cleared first |
| `distance` | `'oklab'` | `'oklab'` or `'srgb'` |
| `dither` | `'none'` | `'none'`, `'bayer2'`, `'bayer4'`, `'bayer8'`, `'blue-noise'`, read each frame |
| `spread` | `0.125` | How far the pattern moves a colour, in sRGB values, read each frame |
| `premultiplied` | `true` | Colours are multiplied by alpha, as in a pixel layer |
| `order` | `20` | Frame-graph order, after sprites and maps and before the compositor |
| `name` | `palette-1`, ... | Plugin name, unique per scene |

The pattern is fixed to the target's pixels. `shiftPaletteHue(colors, degrees)` and `paletteRamp(from, to, steps)` make palettes in Oklab; `bayerMatrix`, `blueNoise` and `nearestPaletteIndex` are the CPU forms the pass uses.

### Palette cycling and ramps

`cyclePalette(colors, cycles, seconds)` rotates runs of palette entries over time, the old way to animate water, fire
and lights by repainting no pixel; `mixPalettes(a, b, t)` mixes two palettes entry by entry in Oklab, for day and
night. Hand the result to `setSwap` each frame: it rewrites the drawn colours in place and keeps the matching.

```ts
import {EngineKernel} from 'margoengine/core';
import {LayerCompositor} from 'margoengine/pixel';
import {cyclePalette, mixPalettes, PaletteQuantize} from 'margoengine/pixel/palette';
const canvas = document.querySelector('canvas')!;
const engine = await EngineKernel.create(canvas, {backend: 'webgpu', exactSize: [320, 180]});
const compositor = LayerCompositor.attach(engine, {camera: {width: 320, height: 180}});
const drawn = compositor.addLayer({visible: false});
const shown = compositor.addLayer();
// Entries 1 to 3 are water; dusk is the same palette in the evening.
const day = ['#101820', '#1d4e89', '#3a7fc1', '#7fb8e6', '#f4e9d8'];
const dusk = ['#100818', '#2a2a6a', '#4a4a9a', '#8a78b8', '#e8b890'];
const pass = PaletteQuantize.attach(engine, {palette: day, source: drawn.target, target: shown.target});
const water = {from: 1, to: 3, rate: 4, blend: true}; // 4 entries a second, mixed between steps
// Three frames a quarter of a second apart; a game does this in its frame loop.
for (const seconds of [0, 0.25, 0.5]) {
  pass.setSwap(cyclePalette(mixPalettes(day, dusk, seconds), [water], seconds));
  engine.render({delta: 0.25});
}
console.log(cyclePalette(['#000000', '#ff0000', '#00ff00', '#0000ff'], [{from: 1, to: 3, rate: 1}], 1)); // ['#000000', '#0000ff', '#ff0000', '#00ff00']
```

| Field of a cycle | What it does |
| --- | --- |
| `from`, `to` | The run, both ends included, `from < to`; runs must not share entries |
| `rate` | Entries a second the colours move toward `to`; below 0 toward `from` |
| `blend` | Mixes in Oklab between steps instead of jumping a whole entry. Default false |

The finite product `rate * seconds` is reduced modulo the run length before subtracting entry indices, so large
finite shifts preserve the rotation. A product that overflows throws `MargoError` with code `'state'` and a help link;
reduce the rate or elapsed time. `PaletteQuantize.dispose()` unregisters only its owning scene and destroys its
palette textures, dither textures and uniform buffer. `LayerCompositor.dispose()` likewise removes only its owner.

## 3D to pixels

`margoengine/pixel/render3d` draws the 3D scene small. `Render3D` holds a low-res view with depth, and outlines what it shows from depth and surface direction. Pass its `view` to `render` with your canvas view.

```ts
import {Camera, EngineKernel, PbrMaterial, box} from 'margoengine/core';
import {LayerCompositor} from 'margoengine/pixel';
import {Render3D, renderSpriteFrames} from 'margoengine/pixel/render3d';
const canvas = document.querySelector('canvas')!;
const engine = await EngineKernel.create(canvas, {backend: 'webgpu', exactSize: [640, 360]});
const camera = new Camera({position: [3, 2, 4], target: [0, 0, 0]});
const mesh = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({color: '#84d6bd'}));
const compositor = LayerCompositor.attach(engine, {camera: {width: 160, height: 90}});
const layer = compositor.addLayer();
const small = Render3D.attach(engine, {camera, width: 160, height: 90, target: layer.target});
engine.render({delta: 1 / 60, views: [small.view, {camera, viewport: [0, 0, 1, 1]}]});

const sheet = renderSpriteFrames(engine, mesh, {camera, angles: [0, Math.PI / 4], width: 32, height: 32});
console.log(sheet.frames.length); // 2; sheet.texture works as a SpriteLayer atlas
```

| Option | Default | What it does |
| --- | --- | --- |
| `camera`, `width`, `height` | required | The view and its low-res size |
| `target` | a texture of its own, `output` | Where the picture ends up, the same size |
| `outline` | on | `{color: '#000000', depthEdge: 0.1, crease: 0.6}` (world units, radians), or false; read each frame |
| `background` | `transparent` | What the view clears to |
| `scene`, `layers` | the engine's, every layer | What the view draws |
| `samples` | `1` | The engine's samples per pixel: 1 with `exactSize` |
| `order` | `20` | Frame-graph order of the outline pass |
| `name` | `render3d-1`, ... | Plugin name, unique per scene |

Every pixel is one colour of the view or the outline colour. For a palette, chain `PaletteQuantize` of `margoengine/pixel/palette`. `outlineMask` is the CPU form of the outline. `renderSpriteFrames` shoots a mesh at each turn about Y into one sheet and puts its rotation back.
