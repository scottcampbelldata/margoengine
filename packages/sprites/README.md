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
| `snap` | true | Rounds each image's edges to whole pixels after the camera (an unrotated image both edges, so nine-slice parts meet with no gap; a rotated one its corner), read each frame |
| `ySort` | false | Among equal `z`, sorts by `y`, then by add order; read each frame |
| `target` | frame's colour | A texture, or a function returning one, to draw into instead |
| `clear` | `[0, 0, 0, 0]` | With `target`: the clear colour, or false to draw over it |
| `filter` | `'nearest'` | `'linear'` filters smoothly for HD art: premultiplied, in linear light, with mipmaps |
| `mipmaps` | true | With `filter: 'linear'`: a full mip chain, so sprites drawn small do not shimmer |
| `shader` | none | Custom fragment code from `margoengine/sprites/shader`; sprites then carry `params` |
| `mask` | none | Draw only inside, or outside, a rect or circle in world units; read each frame |
| `normals` | none | `{atlas, target, clear}`: a second colour target for 2D lighting |
| `order` | 10 | Frame-graph order, after the scene at 0 |
| `layers` | 1 | Render-layer bits; a view with `layers` that shares none skips this layer |
| `capacity` | 256 | Sprites before the buffer grows |
| `name` | `sprites-1`, ... | Plugin name, unique per scene |

Methods: `add(sprite or options)`, `remove(sprite)`, `clearSprites()`, `setAtlas(atlas)`, `setTarget(target)`,
`setNormals(normals)`, `dispose()` (or `using`). Read
`sprites` for the list in draw order.

Exact pixels need one sample per pixel: `exactSize` on the engine, or your own single-sample `target`. A `Tonemap`
grades whatever is drawn before its order of 31, so set `order: 40` to keep a layer's bytes out of it.

Atlas textures made from bytes or an `ImageBitmap` come back by themselves after a device loss, and so does a function
`(device) => GPUTexture`: the layer calls it once for each device. Pass that form when you make the texture yourself:

```ts
const atlas = (device: GPUDevice) => {
  const texture = device.createTexture({
    size: [2, 2],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, new Uint8Array(16).fill(255), { bytesPerRow: 8 }, [2, 2]);
  return texture;
};
```

A plain `GPUTexture` (atlas or `target`) belongs to the device that made it. After a device restore the layer drops it,
reports it once through `engine.onError` (`MargoError` `'state'`, help `borrowed-lost`) and draws nothing while the
rest of the frame goes on, until `setAtlas`, `setTarget` or `setNormals` hands in one made on `engine.gpu`, for example
from your own plugin's `onDeviceRestored(engine)`. `BillboardLayer` and `SkeletalLayer` atlases follow the same rule.

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

### Sprite masks

`mask` limits where a layer draws: inside a rectangle or circle, or outside it with `outside: true`. The shape is in
world units, like sprite positions, and goes through the layer's camera. It is read each frame, so it can follow a
character for a spotlight or a keyhole, or close in for a scene wipe.

```ts
import { EngineKernel } from 'margoengine/core';
import { SpriteLayer } from 'margoengine/sprites';

const engine = await EngineKernel.create(document.querySelector('canvas')!, { exactSize: [64, 32] });
const sky = { width: 1, height: 1, data: new Uint8Array([90, 150, 230, 255]) };
const layer = SpriteLayer.attach(engine, { atlas: sky, mask: { circle: [32, 16, 12] } });
layer.add({ scaleX: 64, scaleY: 32 });
let radius = 12;
engine.onFrame((_, delta) => {
  radius = Math.max(0, radius - delta * 4);
  layer.mask = { circle: [32, 16, radius] };
});
engine.start();
```

- `rect` is `[x, y, width, height]` and `circle` is `[x, y, radius]`. A pixel draws when its centre is inside (edges of a
  rect: left and top in, right and bottom out; a circle's edge in), so masks cut along whole pixels with no soft edge.
- One shape per layer. For several holes or a soft edge, draw the layer into a `target` and mask that.
- Works with `filter`, `shader`, pages and `normals` (a masked pixel writes neither colour nor normal).

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

### Blend modes

`margoengine/sprites/blend` gives each sprite its own `blendMode`: `'normal'` (default), `'add'`, `'multiply'` or
`'screen'`, changeable at any time. Neighbouring sprites with the same mode share one draw, in z, y and insertion order.

```ts
import { EngineKernel } from 'margoengine/core';
import { BlendLayer } from 'margoengine/sprites/blend';

const engine = await EngineKernel.create(document.querySelector('canvas')!, { exactSize: [64, 32] });
// A 1 x 1 white atlas, tinted per sprite.
const atlas = { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) };
const layer = BlendLayer.attach(engine, { atlas });
layer.addBlend({ x: 8, y: 8, scaleX: 32, scaleY: 16, tint: '#3080ff' });
const shade = layer.addBlend({ x: 24, y: 12, scaleX: 16, scaleY: 16, tint: '#ff8040', blendMode: 'multiply' });
engine.start();
shade.blendMode = 'screen'; // takes effect on the next frame
```

- Multiply follows the W3C compositing formula, which keeps the sprite's own colour where the target is transparent.
  One fixed-function blend cannot express it, so each multiply sprite (and each multiply triangle of a `SkeletalLayer`)
  is two draws, one after the other; four adjacent screen sprites are one draw, three multiply sprites six.
- Custom `shader` code is not accepted: the layer owns the fragment code that does premultiplication and the
  multiply correction.
- Every other `SpriteLayer` option works: pages, `filter: 'linear'`, `mask`, `normals`, `camera` and `target`. With a
  transparent `target`, multiply over an uncovered pixel gives the sprite's own colour, as the formula says.
- `addBlend(options)` returns a `BlendSprite`; sprites from the plain `add` are `'normal'`. An unknown mode throws a
  `RangeError`. `blendBatches(sprites, ySort)` returns the runs the layer will draw, `{ mode, first, count }` in draw
  order, hidden sprites left out, so you can count draws before you ship a scene:

```ts
import { Sprite } from 'margoengine/sprites';
import { BlendSprite, blendBatches } from 'margoengine/sprites/blend';

const runs = blendBatches([
  new BlendSprite({}),
  new BlendSprite({ blendMode: 'add' }),
  new BlendSprite({ blendMode: 'add' }),
  new Sprite({ visible: false }),
  new BlendSprite({ blendMode: 'multiply', z: -1 }),
]);
console.log(runs.map((r) => `${r.mode} ${r.first} ${r.count}`)); // ['multiply 0 1', 'normal 1 1', 'add 2 2']
```

### Nine-slice and tiling (`margoengine/sprites/slice`)

A `SliceLayer` is a `SpriteLayer` that also draws resizable images: panels, buttons and frames whose corners stay the
size they were drawn, and tiled or scrolling fills. Ordinary sprites and sliced ones share its one instanced draw, its
atlas pages and its draw order.

```ts
import { EngineKernel } from 'margoengine/core';
import { SliceLayer, SliceSprite, sliceParts } from 'margoengine/sprites/slice';

const engine = await EngineKernel.create(document.querySelector('canvas')!, { exactSize: [128, 64] });
// A 12 x 12 frame with 4-texel borders at (0, 0), and a 16 x 16 pattern at (12, 0).
const data = new Uint8Array(28 * 16 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 37) % 256));
const layer = SliceLayer.attach(engine, { atlas: { width: 28, height: 16, data } });
const panel = layer.addSlice({ rect: [0, 0, 12, 12], borders: [4, 4, 4, 4], width: 100, height: 40, x: 64, y: 32 });
const water = layer.addSlice({ rect: [12, 0, 16, 16], width: 128, height: 16, y: 56, pivotY: 0, middle: 'repeat', z: -1 });
let time = 0;
engine.onFrame((_, delta) => {
  time += delta;
  water.scrollX += delta * 8; // the pattern moves; the image stays put
  panel.width = 100 + Math.sin(time) * 20; // read each frame: corners keep 4 x 4
});
engine.start();

// The layout the layer draws, on the CPU: at most nine parts.
const parts = sliceParts(new SliceSprite({ rect: [0, 0, 12, 12], borders: [4, 4, 4, 4], width: 100, height: 40 }));
console.log(parts.length, parts[1].rect, parts[1].scaleX); // 9 [4, 0, 4, 4] 23: the top edge stretched to 92 units
const small = sliceParts(new SliceSprite({ rect: [0, 0, 12, 12], borders: [4, 4, 4, 4], width: 6, height: 40 }));
console.log(small.length, small[0].scaleX); // 6 0.75: narrower than both borders, they shrink and the middle goes
layer.removeSlice(panel);
```

| `SliceSprite` field | Default | What it does |
| --- | --- | --- |
| `rect` | required | `[x, y, width, height]` in whole atlas texels |
| `width`, `height` | required | Size in world units (0 or more), read each frame; `scaleX` and `scaleY` multiply it |
| `borders` | `[0, 0, 0, 0]` | Left, top, right and bottom in whole texels, drawn at one unit per texel; left plus right at most the rect's width, top plus bottom at most its height |
| `middle` | `'stretch'` | `'repeat'` tiles the edges and centre at their own size instead of stretching them |
| `scrollX`, `scrollY` | 0 | Moves the repeated pattern, in world units |
| `tileScaleX`, `tileScaleY` | 1 | World units per texel in repeated parts (above 0) |

The rest are a `Sprite`'s: `x`, `y`, `z`, `pivotX`, `pivotY` (of the whole size), `rotation`, `flipX`, `flipY`, `tint`,
`alpha`, `page` and `visible`, all read each frame. Zero borders with `middle: 'repeat'` is a tiling sprite in one part.

- A size smaller than its borders shrinks the borders in proportion, and a part with no area is hidden; each sliced
  image keeps nine slots in the layer so a resize never adds or removes sprites. A size, border or scale out of range,
  or a rect that is not whole texels, throws a `RangeError` from `addSlice`, or from the next frame's layout when set later.
- Repeats wrap inside the part's own texels, never into a neighbouring atlas cell, including with `filter: 'linear'`,
  where the sample at a tile seam blends the tile's last and first texels.
- Options are a `SpriteLayer`'s without `shader` and `normals`, which a sliced image needs for itself; use a second
  `SpriteLayer` for those. `addSlice` returns the `SliceSprite`, `removeSlice(sprite)` removes it, and
  `clearSprites()` removes sliced and ordinary sprites alike.

### Picking (`margoengine/sprites/pick`)

`pickSprite(sprites, x, y, options)` finds the sprite drawn on top at a point, on the CPU, with no GPU read-back. It
places sprites as the layer does (camera, pixel snapping, `z`, `ySort`, pages and the mask), and in `'pixel'` mode
looks at the atlas texel under the point, so a click on a transparent corner falls through to what is behind.

```ts
import { Sprite } from 'margoengine/sprites';
import { pickSprite } from 'margoengine/sprites/pick';

// A 4 x 2 white atlas whose texel (3, 0) is transparent: the same bytes the layer draws.
const data = new Uint8Array(4 * 2 * 4);
for (let i = 0; i < 8; i++) data.set([255, 255, 255, i === 3 ? 0 : 255], i * 4);
const atlas = { width: 4, height: 2, data };
const back = new Sprite({ scaleX: 8, scaleY: 8, pivotX: 0, pivotY: 0, rect: [0, 0, 2, 2] });
const front = new Sprite({ x: 8, z: 1, scaleX: 8, scaleY: 8, pivotX: 0, pivotY: 0, rect: [2, 0, 2, 2] });
const sprites = [back, front]; // or layer.sprites

const hit = pickSprite(sprites, 12, 12, { atlas });
console.log(hit?.sprite === front, hit?.texelX, hit?.texelY, hit?.localX, hit?.localY); // true 2 1 0.5 1.5
console.log(pickSprite(sprites, 20, 4, { atlas })); // undefined: the transparent texel, and nothing behind it
console.log(pickSprite(sprites, 20, 4, { atlas, mode: 'box' })?.texelX); // 3: box mode ignores the texel's alpha
front.alpha = 0.5;
console.log(pickSprite(sprites, 12, 12, { atlas, alphaThreshold: 200 })?.sprite === back); // true: too faint, falls through
console.log(pickSprite(sprites, 24, 24, { atlas, camera: { x: 0, y: 0, zoom: 2 } })?.sprite === front); // true
console.log(pickSprite(sprites, 4, 4, { atlas, mask: { rect: [8, 0, 16, 16] } })); // undefined: masked out
```

- `x` and `y` are target pixels, the layer's own pixels, not CSS pixels: scale a pointer's offset by
  `canvas.width / canvas.clientWidth` (and the same for height) first.
- A hit gives `sprite`, the atlas texel `texelX` and `texelY` it shows, `localX` and `localY` (the point in the
  sprite's own texel units from its top-left, before flips) and `alpha`, the texel's alpha times the sprite's, 0 to 1.
- `alphaThreshold` (default 1, in bytes 0 to 255) is the least combined alpha that counts; alpha 0 never picks, and
  neither does a hidden sprite or one with `alpha` 0. `mode: 'box'` (default `'pixel'`) tests the sprite's rectangle
  and its `alpha` only, and needs no atlas bytes.
- `atlas` takes `{ width, height, data }` or a list of same-size pages (`data`: straight-alpha RGBA8,
  `width * height * 4` bytes). Pixel mode needs `data`; without it the pick throws a `RangeError` (so does a point that
  is not finite, a bad threshold or camera, or a sprite whose `page` has no atlas). `camera`, `snap`, `ySort` and
  `mask` take the layer's values (defaults `{ x: 0, y: 0, zoom: 1 }`, true, false, none).
- The texel test reads the source atlas alpha as nearest filtering draws it; a custom `shader` that changes alpha,
  such as a dissolve, is not seen, so pick those in `'box'` mode or give them their own test.

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

### IK, slots, draw order and curves

Bones take a `length` (along their local +x, default 0, never negative), which IK uses to find a chain's tip.
`solveTwoBoneIK(skeleton, root, tip, target, options)` solves a limb exactly with the law of cosines;
`solveChainIK(skeleton, names, target, options)` turns a chain of any length (cyclic coordinate descent). Both work in
skeleton world units, keep the bones' positions and scales, and update the skeleton.

```ts
import { Skeleton2D, SkinnedMesh, gridMesh, poseSkeleton, solveChainIK, solveTwoBoneIK } from 'margoengine/sprites/skeletal';

const leg = new Skeleton2D([
  { name: 'thigh', rotation: Math.PI / 2, length: 10 },
  { name: 'shin', parent: 'thigh', x: 10, length: 10 },
]);
const tipOf = (name: string) => {
  const b = leg.bone(name)!;
  return [b.world[4] + b.world[0] * b.length, b.world[5] + b.world[1] * b.length].map((v) => +v.toFixed(3));
};
const step = solveTwoBoneIK(leg, 'thigh', 'shin', [6, 14]); // bendPositive (default true) picks the knee side
console.log(step.converged, tipOf('shin')); // true [6, 14]
const reach = solveTwoBoneIK(leg, 'thigh', 'shin', [0, 40]);
console.log(reach.converged, +reach.distance.toFixed(3)); // false 20: straight at the target, 20 short

const tail = new Skeleton2D([
  { name: 'a', length: 4 },
  { name: 'b', parent: 'a', x: 4, length: 4 },
  { name: 'c', parent: 'b', x: 4, length: 4 },
]);
console.log(solveChainIK(tail, ['a', 'b', 'c'], [6, 6], { iterations: 32, tolerance: 0.01 }).converged); // true

// Slots: images on a bone that swap, with a draw order a clip can change.
const body = new Skeleton2D([{ name: 'root' }, { name: 'head', parent: 'root', y: -8 }]);
const image = (x: number) => {
  const grid = gridMesh([x, 0, 4, 4], 1, 1);
  const joints = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]; // four vertices on bone 1, the head
  const weights = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  return new SkinnedMesh({ skeleton: body, ...grid, joints, weights });
};
const face = body.addSlot({ name: 'face', bone: 'head', attachments: { open: image(0), shut: image(4) }, attachment: 'open' });
body.addSlot({ name: 'hat', bone: 'head', attachments: { cap: image(8) }, attachment: 'cap' });
const blink = {
  duration: 1,
  bones: { head: { y: [[0, -8], [1, -6]] } },
  curves: { head: { y: [[0.42, 0, 0.58, 1]] } }, // one cubic Bezier per key interval: ease in and out
  slots: { face: [{ time: 0.4, attachment: 'shut' }, { time: 0.5, attachment: 'open' }] },
  drawOrder: [{ time: 0.5, slots: ['hat', 'face'] }], // back to front
};
poseSkeleton(body, blink, 0.45);
console.log(face.attachment, body.drawOrder.map((s) => s.name), body.bone('head')!.y.toFixed(3)); // 'shut' ['face', 'hat'] '-7.171'
poseSkeleton(body, blink, 0.75);
console.log(face.attachment, body.drawOrder.map((s) => s.name)); // 'open' ['hat', 'face']
poseSkeleton(body, blink, 0.25);
console.log(face.attachment, body.drawOrder.map((s) => s.name)); // 'open' ['face', 'hat']: before the first keys, setup
```

- IK options: `mix` (0 to 1, default 1) blends from the current rotations to the solution, `iterations` (1 to 1024,
  default 64) caps chain sweeps, `tolerance` (default 0.001) is the distance that counts as reached, and
  `bendPositive` (default true) chooses the bend side. The result is `{ distance, iterations, converged }`, measured
  after the blend, so a target out of reach or a `mix` below 1 gives `converged: false`. A parent scaled to zero
  throws a `RangeError`. A first bone with uneven scale is solved as a chain.
- `addSlot({ name, bone, attachments, attachment })` adds a slot whose `attachments` are `SkinnedMesh`es of the same
  skeleton, one shown at a time (`attachment`, default none). `setAttachment(name)` swaps it (an unknown name throws),
  `slot(name)` finds one, `slots` lists them in setup order and `drawOrder` in the current order;
  `setDrawOrder(names)` takes every slot name once.
- `curves` give each key interval of a channel `'linear'` (the default), `'stepped'` (hold, then jump) or cubic Bezier
  controls `[x1, y1, x2, y2]` as in CSS `cubic-bezier`. `slots` and `drawOrder` keys are discrete; before a slot's first
  key it shows its setup attachment, and before the first draw-order key the setup order is used.
- `layer.addSkeleton(skeleton)` draws every slot's shown attachment in draw order, following the clip each frame; one
  skeleton goes in one layer once. `layer.removeSkeleton(skeleton)` takes it out with all its slot attachments, while
  `layer.remove(mesh)` removes only meshes you added one by one with `add`.

## Skeletal JSON (`margoengine/sprites/spine`)

`margoengine/sprites/spine` reads the skeletal animation JSON export format onto the same runtime, so a rig is a
`Skeleton2D` that `SkeletalLayer.addSkeleton` draws. It covers bones with shear and inheritance, slots with light and
dark tints and blend modes, skins, region, mesh, linked and weighted attachments, bounding boxes, points, clipping and
paths, IK, transform and path constraints, events, and bone, slot, deform, sequence and constraint timelines with
their curves. `docs/skeletal-json.md` has the whole reference: coordinates, atlas ownership, every default and the
evidence.

```ts
import { parseSpineJSON, serializeSpineJSON } from 'margoengine/sprites/spine';

const document = {
  skeleton: { spine: '4.2.0' },
  bones: [{ name: 'root' }, { name: 'arm', parent: 'root', y: 4, rotation: -90, length: 8 }],
  slots: [{ name: 'arm', bone: 'arm', attachment: 'arm', color: 'ff8040ff' }],
  skins: [
    { name: 'default', attachments: { arm: { arm: { width: 2, height: 8 } } } },
    { name: 'gold', attachments: { arm: { arm: { width: 3, height: 8 } } } },
  ],
  events: { step: { int: 1, string: 'left' } },
  animations: {
    wave: {
      bones: { arm: { rotate: [{ value: 0 }, { time: 0.5, value: 45 }, { time: 1, value: 0 }] } },
      slots: { arm: { rgba: [{ color: 'ff8040ff' }, { time: 1, color: '4080ffff' }] } },
      events: [{ time: 0.5, name: 'step' }],
    },
  },
};
const asset = parseSpineJSON(JSON.stringify(document)); // a string or a plain object
console.log([...asset.animations.keys()], asset.animations.get('wave')!.duration, [...asset.skins.keys()]); // ['wave'] 1 ['default', 'gold']

const rig = asset.createSkeleton(); // any number of independent rigs from one asset
rig.pose('wave', 0.5); // seconds; starts from the setup pose each call, so seeking back is exact
console.log(rig.bone('arm')!.rotation.toFixed(4), rig.slotStates.get('arm')!.color.map((c) => +c.toFixed(3))); // '0.7854' [0.625, 0.502, 0.625, 1]
console.log(rig.eventsBetween('wave', 0.25, 0.75).map((e) => [e.name, e.int, e.string])); // [['step', 1, 'left']]
console.log(rig.eventsBetween('wave', 0.75, 2.6).length); // 2: one in each loop crossed
rig.setSkin('gold'); // falls back to the default skin for what gold lacks; resets slots and pose
console.log(rig.skin, rig.getAttachment('arm') !== undefined); // 'gold' true
console.log(serializeSpineJSON(asset) === JSON.stringify(document)); // true: every exported value round-trips
```

- `createSkeleton(options)`: `regions` (named `{ x, y, width, height, rotation, originalWidth, originalHeight,
  offsetX, offsetY }` rectangles in the one atlas your `SkeletalLayer` draws; default each image at its own full
  size), `scale` (rig units per exported unit, 1), `yDown` (true: the export's y-up becomes sprite y-down, which flips
  rotations) and `skin` (`'default'`, or the first skin).
- `pose(name, seconds, { loop })` wraps time into the animation unless `loop` is false. Constraints run in the
  exported order. `slotStates` holds each slot's animated `color`, `dark`, `blend` and `attachment`.
- `eventsBetween(name, from, to, loop = true)` lists events with `from < time <= to` across the loops crossed (pass
  `from = -1` to include time 0), with definition defaults filled in; a backward range gives none. An event's `audio`,
  `volume` and `balance` are for your audio system to play.
- `loadSpineJSON(url, { signal })` fetches and parses; `signal` covers the request, the body and the parse.
  `maxValues` and `maxVertices` (1,000,000 each) and a 64-level nesting limit bound what a document may hold. A
  document that breaks them, or is invalid (an unknown parent, say), throws a `MargoError` with code `'failed'` that
  names the fault.
- Physics constraints are read, kept and round-tripped, but posing does not simulate them yet (a missing feature,
  KB-SPRITES-SPINEPHYS1 in docs/known-bugs.md): each one logs and lists a `warnings` entry with code
  `'spine-physics-deferred'` when the document loads. Binary skeleton files are not read.
- Spine is a trademark of Esoteric Software LLC; this independent reader of the public JSON format has no affiliation
  with it.

## DragonBones

`margoengine/sprites/dragonbones` reads DragonBones 5.x JSON exports (`_ske.json` with its `_tex.json` atlas) onto the
same skeletal runtime as the skeletal JSON reader (`margoengine/sprites/spine`), so a rig is a `Skeleton2D` that a
`SkeletalLayer` draws. It covers armatures, bones with their inheritance flags, slots with colour multipliers and blend
modes, skins, image, mesh (weighted and shared) and bounding box displays, nested armatures, bone, slot, display,
free-form deformation, z-order and IK timelines, IK constraints, and frame events, sound events and play actions.

```ts
import { EngineKernel } from 'margoengine/core';
import { parseDragonBonesJSON } from 'margoengine/sprites/dragonbones';
import { SkeletalLayer } from 'margoengine/sprites/skeletal';

const engine = await EngineKernel.create(document.querySelector('canvas')!, { exactSize: [64, 32] });
// A 2 x 1 atlas page (an orange texel and a blue texel) and its _tex.json description.
const data = new Uint8Array([230, 120, 40, 255, 40, 90, 230, 255]);
const atlas = {
  width: 2,
  height: 1,
  SubTexture: [
    { name: 'body', x: 0, y: 0, width: 1, height: 1 },
    { name: 'arm', x: 1, y: 0, width: 1, height: 1 },
  ],
};
// A _ske.json document: a body and an arm that swings, at 24 frames a second.
const ske = {
  version: '5.5',
  frameRate: 24,
  armature: [
    {
      name: 'robot',
      bone: [
        { name: 'root', transform: { x: 32, y: 16 } },
        { name: 'arm', parent: 'root', transform: { x: 6, y: -4 } },
      ],
      slot: [
        { name: 'body', parent: 'root' },
        { name: 'arm', parent: 'arm' },
      ],
      skin: [
        {
          slot: [
            { name: 'body', display: [{ name: 'body', transform: { scX: 10, scY: 16 } }] },
            { name: 'arm', display: [{ name: 'arm', transform: { x: 6, scX: 12, scY: 3 } }] },
          ],
        },
      ],
      animation: [
        {
          name: 'wave',
          duration: 24,
          playTimes: 0,
          bone: [
            {
              name: 'arm',
              rotateFrame: [
                { duration: 12, tweenEasing: 0, rotate: -40 },
                { duration: 12, tweenEasing: 0, rotate: 30 },
                { rotate: -40 },
              ],
            },
          ],
        },
      ],
      defaultActions: [{ gotoAndPlay: 'wave' }],
    },
  ],
};
const robot = parseDragonBonesJSON(ske, { atlas }).createArmature('robot');
const layer = SkeletalLayer.attach(engine, { atlas: { width: 2, height: 1, data } });
layer.addSkeleton(robot);
let time = 0;
engine.onFrame((_, delta) => {
  time += delta;
  robot.pose('wave', time);
});
engine.start();
```

| Piece | What it does |
| --- | --- |
| `parseDragonBonesJSON(input, options)` | A `_ske.json` string, object or UTF-8 bytes. Options `atlas` (a parsed atlas, or the `_tex.json` text or object; needed for image displays), `maxValues` (1,000,000), `maxVertices` (1,000,000), `signal`. Returns a `DragonBonesData` |
| `loadDragonBonesJSON(url, options)` | Fetches the document, and the atlas when `atlas` is a URL (resolved beside the document); `signal` covers both |
| `parseDragonBonesAtlas(input)`, `loadDragonBonesAtlas(url)` | Regions by texture name, trimming (`frameX`, `frameY`, `frameWidth`, `frameHeight`) kept, with `imagePath`, `width`, `height` and `scale` |
| `DragonBonesData` | `armatures` by name, `createArmature(name?, options)` (default the first), `warnings`, `toJSON()` |
| `DragonBonesArmatureData` | `animations` (`duration` in seconds, `frames`, `playTimes`, `fadeInTime`, `events`), `defaultAnimation`, `skins`, `asset` (the converted skeletal JSON document) |
| `DragonBonesArmature` | A `SpineSkeleton`, so a `Skeleton2D`. `pose(name, seconds, { playTimes })` loops (play count 0) or plays N times and holds the last frame; `frameEvents(name, from, to)` lists events with `from <= time < to` across loops; `setSkin`, `getAttachment` and `slotStates` as on the skeletal JSON rig. Options `regions` (default: the parsed atlas), `scale` (1), `skin` (the first) |

- Times are seconds; keys come from frame durations at the armature's `frameRate` (default the document's, else 24).
- Nested armatures are flattened in place of their slot: their bones are named `<slot>#<display index>/<bone>`, their
  slots draw only while the host slot shows that display, and they play their default animation on the same clock.
- Colour offsets, blend modes other than normal, add, multiply and screen, `inheritTranslation: false` and timeline
  `scale` and `offset` are read but not reproduced; each cause adds one `warnings` entry. Binary `.dbbin`, the 4.x
  layout, curves of more than four values and rotated atlas regions are refused with a coded error (`docs/limits.md`).
- DragonBones is a project of the DragonBones team; this independent reader has no affiliation with it.

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

Film time: `animation.advanceTime(dt)` steps as `update` does but fires no event, and a `SpriteLayer`'s effect clock
(`layer.time`) moves in its frame update (`layer.advanceTime(delta)`). Pass the animation to `seek` from
`@margoengine/cutscene/seek` as an `extra` clock (`seek(engine, t, { extra: [animation] })`, after `play`) and a film
scene starts on the frame a continuous run shows; the layer is found as a plugin.

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
- **Groups:** with the header's group flag (flag 2), a group below full opacity composites its children on their own
  first, then onto the layers below at its opacity, as the file format describes; without it a group's opacity is ignored.
- **Tilemap layers:** a visible one is refused with `unsupported`; flatten or hide it in Aseprite.
- **Tags:** without a repeat, a clip loops or ping-pongs through its mode. With one, its frames are written out and it
  plays once; a ping-pong repeat counts legs. A tag's frame times come from the file.
- Written from the public `.ase` file format document only.
