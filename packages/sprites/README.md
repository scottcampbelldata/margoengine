# @margoengine/sprites

Import `margoengine/sprites` from the `margoengine` package, or `@margoengine/sprites` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

2D sprites that land on exact pixels. A `SpriteLayer` holds any number of `Sprite`s and draws them in one instanced draw
from a storage buffer. Texels are read with no filtering and no colour conversion, so with one sample per pixel what you
put in the atlas is what reaches the screen, byte for byte. Core stays the same size: an app that does not import this
package ships none of it.

```ts
import { EngineKernel } from 'margoengine/core';
import { SpriteLayer } from 'margoengine/sprites';

// exactSize keeps the backbuffer at 64 x 32 with no MSAA; CSS scales the canvas up.
const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
canvas.style.imageRendering = 'pixelated';
const engine = await EngineKernel.create(canvas, { exactSize: [64, 32] });

// A 2 x 2 atlas: red, green, blue, white. An ImageBitmap or a GPUTexture works the same way.
const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
const layer = SpriteLayer.attach(engine, { atlas: { width: 2, height: 2, data }, ySort: true });

const hero = layer.add({ x: 10, y: 7, pivotX: 0.5, pivotY: 1, scaleX: 4, scaleY: 4 });
const coin = layer.add({ x: 30, y: 7, rect: [0, 0, 1, 1], tint: '#ffd040' });
engine.start();

// Change any field whenever you like: only the bytes that changed go to the GPU.
hero.x = 12.4; // draws at whole pixels until snap is set to false
hero.flipX = true;
coin.visible = false;
```

## Sprite

| Field | Default | What it does |
| --- | --- | --- |
| `x`, `y` | 0 | World position of the pivot, y down |
| `z` | 0 | Higher draws over lower |
| `pivotX`, `pivotY` | 0 | Pivot across and down the image, 0 to 1 |
| `scaleX`, `scaleY` | 1 | Scale; negative mirrors about the pivot |
| `flipX`, `flipY` | false | Mirrors the image inside its rectangle |
| `rotation` | 0 | Clockwise turn about the pivot, radians; pixels stay nearest, never blended |
| `tint` | white | `0xrrggbb`, `'#rrggbb'` or `'#rgb'`, multiplied with the atlas bytes |
| `alpha` | 1 | Opacity, 0 to 1 |
| `rect` | whole atlas | `[x, y, width, height]` in whole atlas texels |
| `visible` | true | False leaves it out of the draw |

## SpriteLayer

| Option | Default | What it does |
| --- | --- | --- |
| `atlas` | required | `{width, height, data}` RGBA8 bytes, `ImageBitmap`, `GPUTexture` or `(device) => GPUTexture` |
| `camera` | `{x: 0, y: 0, zoom: 1}` | World point at the top-left and pixels per world unit, read each frame |
| `snap` | true | Rounds each image's corner to a whole pixel after the camera, read each frame |
| `ySort` | false | Among equal `z`, sorts by `y`, then by add order; read each frame |
| `target` | frame's colour | A texture, or a function returning one, to draw into instead |
| `clear` | `[0, 0, 0, 0]` | With `target`: the clear colour, or false to draw over it |
| `normals` | none | `{atlas, target, clear}`: a second colour target for 2D lighting |
| `order` | 10 | Frame-graph order, after the scene at 0 |
| `layers` | 1 | Render-layer bits; a view with `layers` that shares none skips this layer |
| `capacity` | 256 | Sprites before the buffer grows |
| `name` | `sprites-1`, ... | Plugin name, unique per scene |

Methods: `add(sprite or options)`, `remove(sprite)`, `clearSprites()`, `setAtlas(atlas)`, `dispose()` (or `using`). Read
`sprites` for the list in draw order.

Exact pixels need one sample per pixel: `exactSize` on the engine, or your own single-sample `target`. A `Tonemap`
grades whatever is drawn before its order of 31, so set `order: 40` to keep a layer's bytes out of it.

Atlas textures made from bytes or an `ImageBitmap` come back by themselves after a device loss, and so does a function.
A plain `GPUTexture` belonged to the lost device: the next frame throws `MargoError` `'state'` until you call `setAtlas`.

Normals write `n * 0.5 + 0.5` from a same-size normal atlas, turned and flipped with the sprite, with alpha 1 where a
sprite covers the pixel. They need a single-sample colour target and a single-sample normal target of the same size.

## Animation

`@margoengine/sprites/animation` (`margoengine/sprites/animation`) plays sprite-sheet clips. It is plain CPU code, so it
runs in Node and an app that only draws still frames does not ship it.

```ts
import { EngineKernel } from 'margoengine/core';
import { SpriteLayer } from 'margoengine/sprites';
import { frameGrid, SpriteAnimation } from 'margoengine/sprites/animation';

const engine = await EngineKernel.create(document.querySelector('canvas')!, { exactSize: [64, 32] });
const layer = SpriteLayer.attach(engine, { atlas: { width: 32, height: 32, data: new Uint8Array(32 * 32 * 4).fill(255) } });
const hero = layer.add({ x: 10, y: 7, rect: [0, 0, 8, 8] });
const animation = new SpriteAnimation({
  clips: {
    walk: { frames: frameGrid(8, 8, 4), fps: 8, events: [{ frame: 1, name: 'step' }] },
    jump: { frames: frameGrid(8, 8, 2, 2, 0, 8), mode: 'once' },
  },
  onEvent: (name, clip) => console.log(clip, name),
});
animation.play('walk');
// Once per frame, with the seconds since the last one:
animation.update(1 / 60).apply(hero);
```

A clip is `frames` (rectangles, or `{ rect, duration }` for a frame with its own seconds), `mode` (`'loop'` default,
`'once'` or `'pingpong'`), `fps` (default 12, for frames without a `duration`) and `events`, names fired once each time
a frame starts showing, in order even when one `update` skips several frames. `speed` (default 1) scales time and 0
pauses. `play(name)` keeps going if that clip is already playing; pass `true` to restart. `finished` turns true when a
`'once'` clip ends. Read `frame` or `rect` instead of `apply` if the sprite is not a `Sprite`.

## Aseprite

`margoengine/sprites/aseprite` reads `.aseprite` and `.ase` files and the JSON sheets Aseprite exports, and writes
`.aseprite` files. Pure CPU code, Node included.

```ts
import {SpriteAnimation} from 'margoengine/sprites/animation';
import {clipsFromAsepriteJSON, encodeAseprite, parseAseprite} from 'margoengine/sprites/aseprite';

const bytes = await encodeAseprite({
  width: 1,
  height: 1,
  frames: [new Uint8Array([255, 0, 0, 255]), new Uint8Array([0, 0, 255, 255])],
  durations: [100, 300],
  tags: [{name: 'blink', from: 0, to: 1, direction: 'pingpong'}],
});
const {frames, durations, clips, slices, palette} = await parseAseprite(bytes, {columns: 2});
const blink = new SpriteAnimation({clips});
blink.play('blink');
console.log(frames.length, durations, slices.length, palette.length);

const sheet = clipsFromAsepriteJSON({
  frames: [{frame: {x: 0, y: 0, w: 8, h: 8}, duration: 100}],
  meta: {frameTags: [{name: 'idle', from: 0, to: 0}]},
});
console.log(Object.keys(sheet.clips), sheet.rects, sheet.slices);
```

| `parseAseprite` option | Default |
| --- | --- |
| `columns`: columns of the sheet the clip rects point into | all frames in one row |
| `maxPixels`: most pixels to decode, over all frames and cels | 2^28 |
| `signal`: an `AbortSignal`, checked between frames | none |

- RGBA, grayscale and indexed sprites; raw, linked and compressed cels; layer, group and cel opacity; z-index; tags;
  slices with 9-slice and pivot; palettes (old chunks too); user data text on the sprite, layers, tags and slices.
- **Blend modes:** every layer composites as Normal. A layer's stored mode is in `layers[i].blend`.
- **Tilemap layers:** a visible one is refused with `unsupported`; flatten or hide it in Aseprite.
- **Tags:** without a repeat, a clip loops or ping-pongs through its mode. With one, its frames are written out and it
  plays once; a ping-pong repeat counts legs. A tag's frame times come from the file.
- Written from the public `.ase` file format document only.
