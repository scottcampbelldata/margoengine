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
| `page` | 0 | Which atlas, on a layer made with a list of them |

## SpriteLayer

| Option | Default | What it does |
| --- | --- | --- |
| `atlas` | required | `{width, height, data}` RGBA8 bytes, `ImageBitmap`, `GPUTexture` or `(device) => GPUTexture`, or a list of same-size ones |
| `camera` | `{x: 0, y: 0, zoom: 1}` | World point at the top-left and pixels per world unit, read each frame |
| `snap` | true | Rounds each image's corner to a whole pixel after the camera, read each frame |
| `ySort` | false | Among equal `z`, sorts by `y`, then by add order; read each frame |
| `target` | frame's colour | A texture, or a function returning one, to draw into instead |
| `clear` | `[0, 0, 0, 0]` | With `target`: the clear colour, or false to draw over it |
| `filter` | `'nearest'` | `'linear'` filters smoothly for HD art: premultiplied, in linear light, with mipmaps |
| `mipmaps` | true | With `filter: 'linear'`: a full mip chain, so sprites drawn small do not shimmer |
| `shader` | none | Custom fragment code from `margoengine/sprites/shader`; sprites then carry `params` |
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

### Several atlases

Give `atlas` a list and one layer draws from all of them in one draw, through a texture array; each sprite picks its
atlas with `page`. Characters, props and effects can live on their own sheets without a layer each.

```ts
import { EngineKernel } from 'margoengine/core';
import { SpriteLayer } from 'margoengine/sprites';

const engine = await EngineKernel.create(document.querySelector('canvas')!, { exactSize: [64, 32] });
const sheet = (r: number, g: number, b: number) => ({ width: 1, height: 1, data: new Uint8Array([r, g, b, 255]) });
const layer = SpriteLayer.attach(engine, { atlas: [sheet(255, 0, 0), sheet(0, 255, 0), sheet(0, 0, 255)] });
layer.add({ x: 4, y: 4, scaleX: 8, scaleY: 8, page: 0 });
layer.add({ x: 16, y: 4, scaleX: 8, scaleY: 8, page: 2 });
engine.start();
```

- The atlases must be the same size; pad smaller sheets. A page past the list throws `RangeError` on the next frame.
- The layer copies them into its own array, so a changed `GPUTexture` atlas needs `setAtlas` with the list again;
  `setAtlas` takes a list on a layer made with one, and one atlas otherwise.
- `filter: 'linear'` and `shader` work with pages; `normals` need a single atlas.

### Smooth sprites

`filter: 'linear'` is for HD art drawn at any scale and angle. The layer keeps its own copy of the atlas, decoded from
sRGB and premultiplied by alpha, with mipmaps, so filtering and mip averages happen in linear light and a transparent
texel's colour never bleeds into an edge. Turn `snap` off too for smooth sub-pixel motion.

```ts
import { EngineKernel } from 'margoengine/core';
import { SpriteLayer } from 'margoengine/sprites';

const engine = await EngineKernel.create(document.querySelector('canvas')!);
// A 2 x 2 atlas: white, transparent, transparent, white.
const data = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255]);
const layer = SpriteLayer.attach(engine, { atlas: { width: 2, height: 2, data }, filter: 'linear', snap: false });
const ball = layer.add({ x: 40.25, y: 30.5, scaleX: 24, scaleY: 24, rotation: 0.3 });
engine.start();
ball.x += 0.1; // moves by a tenth of a pixel
```

- Each cell is sampled half a texel inside its rectangle, so level 0 never reads the next cell. Smaller mip levels
  average across cells: leave a gutter of a few texels around cells drawn very small, or set `mipmaps: false`.
- The copy is made once. After changing a `GPUTexture` atlas's contents, call `setAtlas` with it again.
- Normals stay exact-pixel.

### Sprite shaders

`margoengine/sprites/shader` gives a layer its own fragment code: hit flashes, outlines, dissolves, palette swaps or your
own WGSL. Each sprite carries four `params` the code reads, so one layer flashes one sprite and leaves the rest alone.

```ts
import { EngineKernel } from 'margoengine/core';
import { SpriteLayer } from 'margoengine/sprites';
import { flashShader, outlineShader, spriteShader } from 'margoengine/sprites/shader';

const engine = await EngineKernel.create(document.querySelector('canvas')!, { exactSize: [64, 32] });
// A 3 x 3 atlas: one red texel in the middle of a transparent border.
const data = new Uint8Array(36);
data.set([255, 0, 0, 255], 16);
const atlas = { width: 3, height: 3, data };
const enemies = SpriteLayer.attach(engine, { atlas, shader: flashShader() });
const hit = enemies.add({ x: 4, y: 4, scaleX: 4, scaleY: 4 });
hit.params = [1, 0, 0, 0]; // fully white this frame
const picked = SpriteLayer.attach(engine, { atlas, shader: outlineShader({ color: '#ffff00' }) });
picked.add({ x: 24, y: 4, scaleX: 4, scaleY: 4, params: [1, 0, 0, 0] });
// Your own effect: pulse with the layer's time.
const pulse = spriteShader(`fn effect(c: vec4f, s: SpriteInput) -> vec4f {
  return vec4f(c.rgb * (0.75 + 0.25 * sin(s.time * 6.0)), c.a);
}`);
SpriteLayer.attach(engine, { atlas, shader: pulse }).add({ x: 44, y: 4, scaleX: 4, scaleY: 4 });
engine.start();
```

| Effect | `params[0]` | Options |
| --- | --- | --- |
| `flashShader(color)` | amount, 0 to 1 | colour, default white |
| `outlineShader({color, width})` | opacity, 0 to 1 | colour (black), reach 1 to 4 texels with diagonals (1) |
| `dissolveShader({edge, band})` | progress, 0 whole to 1 gone | edge colour (`#ff8020`), band width (0.08) |
| `paletteShader(from, to)` | none | 1 to 16 exact colour pairs, for `filter: 'nearest'` |

`spriteShader(code)` takes WGSL defining `fn effect(color: vec4f, sprite: SpriteInput) -> vec4f`. `color` is the tinted
texel as atlas bytes over 255, straight alpha; return alpha 0 to drop the texel. `SpriteInput` holds `texel`, `cell`
(the texel read), `low` and `high` (the rectangle's first and last texel), `params`, `tint` and `time` (the layer's
`time`, seconds it has run; set it to restart). `spriteTexel(sprite, offset)` reads an untinted neighbour, transparent
outside the rectangle, so outlines need transparent texels around the art. A shader that does not compile shows as a
WebGPU validation error on the first frame.

## Billboards

`margoengine/sprites/billboard` draws camera-facing sprites in a 3D scene: markers, foliage, effects. One instanced draw
per view after the scene, depth tested against it. Sizes are world units that shrink with distance, or pixels with
`sizeAttenuation: false`, so a marker keeps its size at any range.

```ts
import { EngineKernel } from 'margoengine/core';
import { BillboardLayer } from 'margoengine/sprites/billboard';

const engine = await EngineKernel.create(document.querySelector('canvas')!);
engine.camera.position = [0, 1.5, 6];
// A 2 x 1 atlas: a green leaf and an orange marker.
const data = new Uint8Array([40, 160, 60, 255, 255, 140, 0, 255]);
const trees = BillboardLayer.attach(engine, { atlas: { width: 2, height: 1, data }, lockY: true });
for (let i = 0; i < 5; i++) trees.add({ x: i * 2 - 4, width: 1, height: 2, pivotY: 1, rect: [0, 0, 1, 1] });
const markers = BillboardLayer.attach(engine, { atlas: { width: 2, height: 1, data }, sizeAttenuation: false });
const pin = markers.add({ y: 3, width: 12, height: 12, rect: [1, 0, 1, 1] });
engine.start();

// Change any field whenever you like.
pin.x = 1;
pin.rotation = Math.PI / 4;
```

| Option | Default | What it does |
| --- | --- | --- |
| `atlas` | required | Same as a `SpriteLayer` atlas; texels read with no filtering |
| `sizeAttenuation` | true | World-unit sizes (true) or pixel sizes (false), read each frame |
| `lockY` | false | Turn about world +Y only, so trees and grass stay upright; read each frame |
| `transparent` | false | False: cut-out, depth written, any order. True: straight-alpha blend, sorted back to front, depth tested only |
| `alphaTest` | 0.5 | Cut-out: texels with alpha under this are dropped; read each frame |
| `order` | 15 | Frame-graph order: after the scene, before text (22) and post-processing (30) |
| `layers` | 1 | Render-layer bits; a view with `layers` that shares none skips this layer |
| `capacity` | 256 | Billboards before the buffers grow |
| `name` | `billboards-1`, ... | Plugin name, unique per scene |

A `Billboard` has `x`, `y`, `z` (world, y up), `width` and `height` (default 1), `pivotX` and `pivotY` (default 0.5;
`pivotY: 1` stands the image on its point), `rotation` (clockwise on screen, radians), `flipX`, `flipY`, `tint`,
`alpha`, `rect` and `visible`, as on a `Sprite`. Methods: `add`, `remove`, `clearBillboards`, `setAtlas`, `dispose` (or
`using`). Each view gets its own sorted buffer, so split screens sort for their own camera. On an sRGB or float target
texels are decoded from sRGB like any colour texture; on an 8-bit target they go through as they are.

- Pixel-sized billboards take their depth from the pivot, and `lockY` applies to world sizes only.
- Sorting is by the pivot's distance: two blended billboards that cross each other draw one over the other whole.
- WebGPU only.

## 2D skeletal animation

`margoengine/sprites/skeletal` bends sprite art with bones, for characters that move smoothly instead of swapping
frames. A `Skeleton2D` holds the bones, a `SkinnedMesh` ties each vertex to up to four bones with weights (linear
blend skinning, done on the CPU each frame), and a `SkeletalLayer` draws all its meshes in one indexed draw with exact
texels, like a `SpriteLayer`.

```ts
import { EngineKernel } from 'margoengine/core';
import { gridMesh, poseSkeleton, SkeletalLayer, Skeleton2D, SkinnedMesh } from 'margoengine/sprites/skeletal';

const engine = await EngineKernel.create(document.querySelector('canvas')!, { exactSize: [64, 32] });
// A 4 x 8 atlas: an orange arm.
const data = new Uint8Array(4 * 8 * 4).map((_, i) => [230, 120, 40, 255][i % 4]);
const layer = SkeletalLayer.attach(engine, { atlas: { width: 4, height: 8, data } });
// Two bones: the upper arm at the shoulder, the forearm 4 units down it.
const skeleton = new Skeleton2D([{ name: 'upper' }, { name: 'fore', parent: 'upper', y: 4 }]);
// A 1 x 4 grid over the atlas: vertex rows at y 0 and 2 follow the upper arm, y 6 and 8 the forearm.
const grid = gridMesh([0, 0, 4, 8], 1, 4);
const joints = new Array(40).fill(0);
const weights = new Array(40).fill(0);
for (let v = 0; v < 10; v++) {
  joints[v * 4] = v < 6 ? 0 : 1; // vertices 0 to 5 are the rows at y 0, 2 and 4
  weights[v * 4] = 1;
}
// The elbow row at y 4 is shared half and half, so the bend is smooth.
joints[4 * 4 + 1] = joints[5 * 4 + 1] = 1;
weights[4 * 4 + 1] = weights[5 * 4 + 1] = 1;
const arm = layer.add(new SkinnedMesh({ skeleton, ...grid, joints, weights }));
arm.x = 30;
arm.y = 4;
const wave = { duration: 1, bones: { fore: { rotation: [[0, 0], [0.5, 1.2], [1, 0]] } } };
let time = 0;
engine.onFrame((_, delta) => {
  time += delta;
  poseSkeleton(skeleton, wave, time);
});
engine.start();
```

| Piece | What it does |
| --- | --- |
| `Skeleton2D(bones)` | Bones `{name, parent?, x, y, rotation, scaleX, scaleY}` relative to the parent, y down, rotation clockwise in radians (as on a sprite); any order, parents are found by name. `update()` computes each bone's `world` `[a, b, c, d, tx, ty]`; `resetPose()` puts the bones back; `bone(name)` finds one |
| `SkinnedMesh(options)` | `skeleton`, bind-pose `positions` (x, y per vertex), atlas texel `uvs`, triangle `indices`, four `joints` (bone indices) and four `weights` per vertex. The skeleton's pose when the mesh is made is the bind pose. Place it with `x`, `y`, `z`; `tint`, `alpha` and `visible` as on a `Sprite`; `deform()` returns the skinned positions |
| `gridMesh(rect, columns, rows, {x, y, scale})` | Positions, uvs and indices of a grid over an atlas rectangle, `scale` units per texel (default 1) |
| `poseSkeleton(skeleton, clip, time, loop = true)` | Sets the bones from a clip `{duration, bones: {name: {x?, y?, rotation?, scaleX?, scaleY?: [[time, value], ...]}}}`, keys linear, rotations the short way round, and updates the skeleton |
| `SkeletalLayer` | Options `atlas` (required, as a `SpriteLayer`'s), `camera` (`{x: 0, y: 0, zoom: 1}`), `order` (10), `layers` (1), `name` (`skeletal-1`, ...). Methods `add`, `remove`, `setAtlas`, `dispose` (or `using`) |

- Call `skeleton.update()` after changing bones by hand; `poseSkeleton` does it for you.
- Weights are scaled to sum to 1 per vertex; more than four bones per vertex is not supported.
- Skinning runs on the CPU: about a thousand vertices a frame is light, tens of thousands is not (time not measured).
- Texels are read at exact positions with no filtering, and the layer needs a single-sample target. WebGPU only.

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
