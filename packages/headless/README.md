# @margoengine/headless

Render a scene with no page and get PNG bytes back: server thumbnails, an asset pipeline, automated tests. Core draws to
a stand-in canvas, and the frame stays readable because nothing presents it.

This package ships no WebGPU binding, because one is a large download that runs code when installed. Your app chooses
one and passes its `gpu` in. It can be any object with `requestAdapter`: `create([])` from a Node binding such as
[`webgpu`](https://www.npmjs.com/package/webgpu), or `navigator.gpu` in a browser or worker.

```ts
import { writeFile } from 'node:fs/promises';
import { Camera, Engine, box, PbrMaterial } from '@margoengine/core';
import { createHeadlessCanvas, installGPU, toPNG } from '@margoengine/headless';

declare const gpu: GPU; // from your binding

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

declare const gpu: GPU; // from your binding

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
| `stage.step(delta?)` | Runs `onTick` callbacks, then draws a frame that advances plugins by `delta` seconds (default 0). Nothing runs by itself: there are no camera controls and no frame loop. |
| `stage.resize(width, height)` | Sets the image size for the next frame. |

`stage.onTick` runs on `step`; `engine.onFrame` callbacks belong to `engine.start()`, so they do not run here. To load a model
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

declare const gpu: GPU; // from your binding

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
import { Engine } from '@margoengine/core';
import { encodeVideo, renderFrames } from '@margoengine/headless/video';

declare const engine: Engine; // on a headless canvas

const video = await encodeVideo(renderFrames(engine, { frames: 90 }), { format: 'mp4' });
const url = URL.createObjectURL(new Blob([video.bytes], { type: video.mimeType }));
```

Node has no WebCodecs, so `@margoengine/headless/ffmpeg` (Node only) pipes the frames to the ffmpeg you have installed. Nothing
is downloaded, and it runs without a shell:

```ts
import { Engine } from '@margoengine/core';
import { renderFrames } from '@margoengine/headless/video';
import { encodeWithFFmpeg } from '@margoengine/headless/ffmpeg';

declare const engine: Engine; // on a headless canvas

await encodeWithFFmpeg(renderFrames(engine, { frames: 90 }), { output: 'turntable.mp4' });
```

| Export | What it does |
| --- | --- |
| `renderFrames(engine, { frames, fps?, camera?, update?, signal? })` | Async iterator of frames: pixels plus `index`, `time`, `delta` and `progress`. `fps` defaults to 30, `camera` to the engine's. `update` runs before each frame is drawn. `progress` is `index / frames`: it never reaches 1, so a full turn loops with no repeated frame. The next frame is not drawn until you ask for it. |
| `imageSequence(frames, { prefix?, digits? })` | Async iterator of `{ index, name, bytes }` PNG files. `prefix` defaults to `'frame_'`, `digits` to 4. |
| `encodeVideo(frames, options?)` | The whole file in memory as `{ bytes, mimeType, codec, width, height, frames, duration }`. `format` `'webm'` (default) or `'mp4'`. `fps` 30. `codec`: a WebCodecs string; default the first supported of VP9, VP8, AV1 for WebM and H.264, VP9, AV1 for MP4. `bitrate` `width * height * fps / 10`. `keyFrameInterval` 2 seconds. `webCodecs` `globalThis`. `signal` none. |
| `encodeWithFFmpeg(frames, { output, fps?, ffmpeg?, args?, signal? })` | Writes `output` and resolves `{ output, width, height, frames }`. `fps` defaults to 30, `ffmpeg` to `'ffmpeg'` on the `PATH` (or `['nice', 'ffmpeg']`). `args` replaces the output arguments, which default to VP9 at `-crf 32` for `.webm` and H.264 at `-crf 20` for anything else, both 4:2:0 BT.709. A failure's `cause` holds the end of ffmpeg's log. |
| `ffmpegArguments(width, height, { output, fps?, args? })` | The argument list `encodeWithFFmpeg` uses. |

Frames must all be one size. Video drops alpha. H.264 and the default ffmpeg settings need even sizes.

The errors are listed at [margoengine.com/errors#headless](https://margoengine.com/errors#headless).
