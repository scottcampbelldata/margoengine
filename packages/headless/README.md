# @margoengine/headless

Render a scene with no page and get PNG bytes back: server thumbnails, an asset pipeline, automated tests. Core draws to
a stand-in canvas, and the frame stays readable because nothing presents it.

Margo has no video encoder of its own. Video uses WebCodecs in a browser or worker, and in Node the `ffmpeg` you have installed, so rendering to MP4 in Node means installing ffmpeg first.

This package ships no WebGPU binding, because one is a large download that runs code when installed. Your app chooses
one and passes its `gpu` in. It can be any object with `requestAdapter`: `create([])` from a Node binding such as
[`webgpu`](https://www.npmjs.com/package/webgpu) (`npm install webgpu`; every example here runs on version 0.6.2 in Node, on the GPU the machine has), or `navigator.gpu` in a browser or worker.

```ts
import { writeFile } from 'node:fs/promises';
import { Camera, Engine, box, PbrMaterial } from '@margoengine/core';
import { createHeadlessCanvas, installGPU, toPNG } from '@margoengine/headless';
import { create } from 'webgpu';

const gpu = create([]);
using installed = installGPU({ gpu });
const canvas = createHeadlessCanvas({ width: 512, height: 512 });
const engine = await Engine.create(canvas, { backend: 'webgpu' });
engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#84d6bd' }));
engine.render({ camera: new Camera({ position: [2, 2, 3], target: [0, 0, 0] }) });
await writeFile('cube.png', await toPNG(engine));
engine.dispose();
```

| Export | What it does |
| --- | --- |
| `installGPU({ gpu, globals? })` | Sets `navigator.gpu` and the `GPU*` flag globals a runtime lacks; adds `getPreferredCanvasFormat` (`'rgba8unorm'`) if the binding has none. `globals` defaults to none. `dispose()` or `using` restores everything. |
| `createHeadlessCanvas({ width, height })` | The canvas to pass to `Engine.create`. Both sizes are required. Set `canvas.width` and `canvas.height` to resize; the next `engine.render()` uses them. |
| `readPixels(engine, { signal? })` | The last frame as `{ width, height, data }`: RGBA, straight alpha, top row first. |
| `toPNG(engine, { signal? })` | The last frame as PNG file bytes. |
| `encodePNG(pixels)` | RGBA pixels as PNG file bytes. |

Call `engine.render()` yourself: `engine.start()` needs `requestAnimationFrame`, which Node does not have. `createStage`
needs a page; `createHeadlessStage` below is its server version.

## A stage without a page

`@margoengine/headless/stage` gives server thumbnails the same short setup as a page. `createHeadlessStage` returns a real
`Stage`, so its methods and the stage's feature entries work as they do on a page. It needs `@margoengine/stage`, an optional
peer:

```ts
import { writeFile } from 'node:fs/promises';
import { createHeadlessStage } from '@margoengine/headless/stage';
import { addSky } from '@margoengine/stage/sky';
import { create } from 'webgpu';

const gpu = create([]);
using stage = await createHeadlessStage({ gpu, width: 640, height: 360 });
stage.box({ color: '#84d6bd' });
await addSky(stage);
stage.fit();
await writeFile('thumbnail.png', await stage.toPNG());
```

| Export | What it does |
| --- | --- |
| `createHeadlessStage({ width, height, gpu?, globals?, onError?, ...engineOptions })` | Installs the GPU and creates the engine on a stand-in canvas. `width` and `height` are required. `gpu` defaults to `navigator.gpu`, `globals` to none. The backend is always WebGPU. Stages alive at once must share one `gpu`; the globals are restored when the last is disposed. |
| `stage.toPNG({ signal? })`, `stage.readPixels({ signal? })` | Draws a frame and gives it as PNG bytes or RGBA pixels. |
| `stage.step(delta?)` | Runs `onTick` and `engine.onFrame` callbacks, then draws a frame that advances plugins by `delta` seconds (default 0). Nothing runs by itself: there are no camera controls and no frame loop. |
| `stage.resize(width, height)` | Sets the image size for the next frame. |

`stage.onTick` and `stage.engine.onFrame` both run on `step`, so a package that drives itself from `onFrame` advances here too. To load a model
with `addGLTF`, pass an absolute URL, since Node has no page address to resolve against.

## Image sequences and video

`@margoengine/headless/video` renders a sequence on its own clock, so a slow machine gives the same frames as a fast one,
and encodes it for turntables, trailers and docs. `renderFrames` yields each frame's pixels, and `imageSequence` turns them into
numbered PNG files:

```ts
import { writeFile } from 'node:fs/promises';
import { Camera, Engine, box, PbrMaterial } from '@margoengine/core';
import { createHeadlessCanvas, installGPU } from '@margoengine/headless';
import { imageSequence, renderFrames } from '@margoengine/headless/video';
import { create } from 'webgpu';

const gpu = create([]);
using installed = installGPU({ gpu });
const engine = await Engine.create(createHeadlessCanvas({ width: 640, height: 360 }), { backend: 'webgpu' });
const mesh = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#84d6bd' }));
const camera = new Camera({ position: [2, 2, 3], target: [0, 0, 0] });
const frames = renderFrames(engine, {
  frames: 90,
  fps: 30,
  camera,
  update: ({ progress }) => mesh.setRotation([0, progress * Math.PI * 2, 0]),
});
for await (const { name, bytes } of imageSequence(frames)) await writeFile(name, bytes);
engine.dispose();
```

`encodeVideo` makes a WebM or MP4 file with WebCodecs, in a browser or worker, or anywhere you pass `webCodecs`:

```ts
import { Engine, box } from '@margoengine/core';
import { encodeVideo, renderFrames } from '@margoengine/headless/video';
import { createHeadlessCanvas } from '@margoengine/headless';

// In a browser, which has WebCodecs; the readable canvas keeps each rendered frame.
const engine = await Engine.create(createHeadlessCanvas({ width: 512, height: 512 }), { backend: 'webgpu' });
engine.createMesh().setGeometry(box());

const video = await encodeVideo(renderFrames(engine, { frames: 90 }), { format: 'mp4' });
const url = URL.createObjectURL(new Blob([video.bytes], { type: video.mimeType }));
```

Node has no WebCodecs, so `@margoengine/headless/ffmpeg` (Node only) pipes the frames to the ffmpeg you have installed. Nothing
is downloaded, and it runs without a shell:

```ts
import { Engine, box, Camera } from '@margoengine/core';
import { renderFrames } from '@margoengine/headless/video';
import { encodeWithFFmpeg } from '@margoengine/headless/ffmpeg';
import { createHeadlessCanvas, installGPU } from '@margoengine/headless';
import { create } from 'webgpu';

using installed = installGPU({ gpu: create([]) });
const engine = await Engine.create(createHeadlessCanvas({ width: 512, height: 512 }), { backend: 'webgpu' });
engine.createMesh().setGeometry(box());
engine.render({ camera: new Camera({ position: [2, 2, 3], target: [0, 0, 0] }) });

await encodeWithFFmpeg(renderFrames(engine, { frames: 90 }), { output: 'turntable.mp4' });
```

`npm run test:real-ffmpeg` writes an H.264 and a VP9 file through the ffmpeg you have (`FFMPEG` names another) and decodes them back to check frames, tags and colours.

| Export | What it does |
| --- | --- |
| `renderFrames(engine, { frames, fps?, camera?, update?, signal? })` | Async iterator of frames: pixels plus `index`, `time`, `delta` and `progress`. `fps` defaults to 30, `camera` to the engine's. `update` runs before each frame is drawn. `progress` is `index / frames`: it never reaches 1, so a full turn loops with no repeated frame. The next frame is not drawn until you ask for it. |
| `imageSequence(frames, { prefix?, digits? })` | Async iterator of `{ index, name, bytes }` PNG files. `prefix` defaults to `'frame_'`, `digits` to 4. |
| `encodeVideo(frames, options?)` | The whole file in memory as `{ bytes, mimeType, codec, width, height, frames, duration }`. `format` `'webm'` (default) or `'mp4'`. `fps` 30. `codec`: a WebCodecs string; default the first supported of VP9, VP8, AV1 for WebM and H.264, VP9, AV1 for MP4. `bitrate` `width * height * fps / 10`. `keyFrameInterval` 2 seconds. `audio` none: `{ channels, sampleRate, bitrate? }` adds sound from plain samples, one `Float32Array` per channel, one or two channels, `bitrate` 128000, as Opus in WebM and as AAC or else Opus in MP4, and the result then has `audioCodec`. `webCodecs` `globalThis`, with `AudioEncoder` and `AudioData` needed for `audio`, and `AudioDecoder` used to measure an AAC encoder's lead-in (2112 samples, 44 ms at 48 kHz, on Chromium for macOS), which an edit list then cuts so the sound starts on time; without `AudioDecoder` an AAC track plays late by it. `signal` none. |
| `encodeWithFFmpeg(frames, { output, fps?, ffmpeg?, args?, signal? })` | Writes `output` and resolves `{ output, width, height, frames }`. `fps` defaults to 30, `ffmpeg` to `'ffmpeg'` on the `PATH` (or `['nice', 'ffmpeg']`). `args` replaces the output arguments, which default to VP9 at `-crf 32` for `.webm` and H.264 at `-crf 20` for anything else, both 4:2:0 BT.709. A failure's `cause` holds the end of ffmpeg's log. |
| `ffmpegArguments(width, height, { output, fps?, args? })` | The argument list `encodeWithFFmpeg` uses. |

Frames must all be one size. Video drops alpha. H.264 and the default ffmpeg settings need even sizes.

## Comparing images

`@margoengine/headless/compare` is for visual regression tests of your own scenes. `compareImages` takes RGBA pixels or PNG
file bytes, made by any tool, and says whether a picture still matches its reference:

```ts
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { encodePNG, readPixels, createHeadlessCanvas, installGPU } from '@margoengine/headless';
import { compareImages } from '@margoengine/headless/compare';
import { Engine, box, Camera } from '@margoengine/core';
import { create } from 'webgpu';

using installed = installGPU({ gpu: create([]) });
const engine = await Engine.create(createHeadlessCanvas({ width: 512, height: 512 }), { backend: 'webgpu' });
engine.createMesh().setGeometry(box());
engine.render({ camera: new Camera({ position: [2, 2, 3], target: [0, 0, 0] }) });

const result = await compareImages(await readPixels(engine), await readFile('reference.png'));
if (!result.pass) await writeFile('difference.png', await encodePNG(result.image));
assert.ok(result.pass, `${result.different} pixels changed, SSIM ${result.ssim}`);
```

| Export | What it does |
| --- | --- |
| `compareImages(actual, reference, { threshold?, maxRatio?, minSSIM? })` | Both limits must hold for `pass`. `maxRatio` defaults to 0.001, `minSSIM` to 0.99, `threshold` to 2. Resolves the `pixelDiff` result with `image`, plus `pass` and `ssim`. |
| `pixelDiff(a, b, { threshold?, image? })` | `{ different, total, ratio, largest, mean }`. A pixel differs when a channel moves more than `threshold`, 0 to 255, default 2. Colours are compared premultiplied, so colour under full transparency does not count. `image: true` adds changed pixels in red over a faded `a`. |
| `ssim(a, b, { window?, sigma?, map? })` | Structural similarity as `{ score }`: 1 for identical images. `window` defaults to 11, `sigma` to 1.5, as published, on luma. `map: true` adds the score of each window. |
| `decodePNG(bytes)` | A PNG file as RGBA pixels: every colour type and bit depth, interlaced or not, 16-bit samples cut to 8. A chunk with a bad CRC or a bit depth its colour type cannot have rejects. Colour profiles and gamma are ignored. All of PngSuite reads as Chromium reads it. |

A pixel count sees how many pixels moved, and SSIM sees whether the picture looks different: a slight brightness change fails
the first and passes the second, and a small hole does the opposite. Images of different sizes reject.

## JPEG, WebP and EXR files

`@margoengine/headless/formats` writes the pixels you read as the files previews and HDR captures need. Nothing here
loads a codec: JPEG and lossless WebP are written in plain code, so they work in Node, a worker and a page.

```ts
import { writeFile } from 'node:fs/promises';
import { readPixels, createHeadlessCanvas, installGPU } from '@margoengine/headless';
import { encodeEXR, encodeJPEG, encodeWebP, readTexture } from '@margoengine/headless/formats';
import { Engine, box, Camera } from '@margoengine/core';
import { PostStack } from '@margoengine/post/stack';
import { Bloom } from '@margoengine/post/bloom';
import { create } from 'webgpu';

using installed = installGPU({ gpu: create([]) });
const engine = await Engine.create(createHeadlessCanvas({ width: 512, height: 512 }), { backend: 'webgpu' });
engine.createMesh().setGeometry(box());
engine.render({ camera: new Camera({ position: [2, 2, 3], target: [0, 0, 0] }) });
const stack = PostStack.attach(engine, [new Bloom({ strength: 0.6 })]);
engine.render({ camera: new Camera({ position: [2, 2, 3], target: [0, 0, 0] }) });

const pixels = await readPixels(engine);
await writeFile('preview.jpg', encodeJPEG(pixels, { quality: 85 }));
await writeFile('preview.webp', await encodeWebP(pixels));
await writeFile('frame.exr', await encodeEXR(await readTexture(engine, stack.sceneTexture!), { type: 'float' }));
```

| Export | What it does |
| --- | --- |
| `encodeJPEG(pixels, { quality?, subsampling?, background? })` | A baseline JPEG. `quality` is 1 to 100, default 90, scaled as other JPEG tools scale it. `subsampling` is `'420'` (default, smaller) or `'444'` (sharper colour edges). JPEG has no alpha, so pixels are laid over `background`, default white. |
| `encodeWebP(pixels, { quality? })` | Unset `quality`: lossless WebP, the same pixels back, with alpha, in any runtime. `quality` 0 to 1: lossy WebP through the runtime's own encoder, so it needs `OffscreenCanvas` and WebP support (a browser or worker). Rejects, never gives a PNG in its place. |
| `encodeEXR(hdr, { type?, signal? })` | Float RGBA as an uncompressed OpenEXR file. `type` is `'half'` (default) or `'float'`. Written by `@margoengine/environment/exr-write`, an optional peer loaded on first use. |
| `readTexture(engine, texture, { signal? })` | Reads an `rgba16float` or `rgba32float` texture with `COPY_SRC` usage to `{ width, height, data }` float pixels. `stack.sceneTexture` from `@margoengine/post/stack` is the linear frame before tone mapping, where values go over 1. |
| `linearPixels(pixels)` | Undoes the sRGB curve of display pixels, for an EXR of an 8-bit frame. Alpha stays linear. |

The engine's own output is tone-mapped sRGB, so an EXR made from `readPixels` holds display values, not scene light.
For a capture with true highlights, read `stack.sceneTexture`. Images are at most 65,535 pixels wide for JPEG and 16,384 for WebP.

The errors are listed at [margoengine.com/errors#headless](https://margoengine.com/errors#headless).

### Headless stage error callback

`createHeadlessStage` accepts `onError` as a function; its default is
`undefined`. Pass an error callback or omit the option. Other types throw a
TypeError naming `onError`, both accepted choices and the arguments help link,
before installing GPU globals or creating an engine.
