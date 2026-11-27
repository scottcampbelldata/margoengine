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
| `createFrameReader(engine, { depth?, signal? })` | From `@margoengine/headless/frames`: reads every frame of a film without waiting for each one. See below. |
| `toPNG(engine, { signal? })` | The last frame as PNG file bytes. |
| `encodePNG(pixels)` | RGBA pixels as PNG file bytes. Rejects with a `RangeError` when the size is not a whole number from 1 or `data` is not `width * height * 4` bytes; `encodeJPEG` and `encodeWebP` refuse the same. |

Call `engine.render()` yourself: `engine.start()` needs `requestAnimationFrame`, which Node does not have. `createStage`
needs a page; `createHeadlessStage` below is its server version.

### Reading every frame of a film

`readPixels` waits for the GPU to finish the frame it was given before it returns. `createFrameReader` from
`@margoengine/headless/frames` keeps up to `depth` copies in flight instead, so the next frame is drawn while earlier
ones are still being read. Call `push()` once after each `engine.render()`: it copies that frame and resolves to the
oldest held frame once `depth` are held. `drain()` gives the rest. The frames and their order are the same as
`readPixels` after every render.

```ts
import { writeFile } from 'node:fs/promises';
import { Camera, Engine, box, PbrMaterial } from '@margoengine/core';
import { createHeadlessCanvas, encodePNG, installGPU, type HeadlessPixels } from '@margoengine/headless';
import { createFrameReader } from '@margoengine/headless/frames';
import { create } from 'webgpu';

const gpu = create([]);
using installed = installGPU({ gpu });
const canvas = createHeadlessCanvas({ width: 320, height: 180 });
const engine = await Engine.create(canvas, { backend: 'webgpu' });
engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#84d6bd' }));

const frames: HeadlessPixels[] = [];
{
  using reader = createFrameReader(engine, { depth: 3 });
  for (let i = 0; i < 12; i++) {
    const angle = i / 12;
    engine.render({ camera: new Camera({ position: [3 * Math.sin(angle), 2, 3 * Math.cos(angle)], target: [0, 0, 0] }) });
    const frame = await reader.push();
    if (frame) frames.push(frame);
  }
  for await (const frame of reader.drain()) frames.push(frame);
}
if (frames.length !== 12) throw new Error(`read ${frames.length} frames`);
await writeFile('last.png', await encodePNG(frames[11]));
engine.dispose();
```

| Option or member | What it does |
| --- | --- |
| `depth` | Frames held at once, 1 to 16. Default 3. 1 waits for each frame. Each held frame owns one buffer of `height` rows of `width * 4` bytes rounded up to 256. |
| `signal` | Disposes the reader; waiting reads reject with the reason. Default none. |
| `push()` | Copies the frame just rendered. Resolves to the oldest held frame once `depth` are held, else `undefined`. |
| `drain()` | An async iterator over the frames still held, oldest first. |
| `pending` | Frames copied and not yet handed out. |
| `dispose()` | Frees the buffers; held frames are lost. Also `using`. |

A reader makes `depth` buffers for a whole film, and `readPixels` keeps one buffer on the canvas between reads of one
size; both free them on a resize.

### The same frames on every run

`readPixels` reads the frame texture this package owns, after the GPU has finished it, so a film drawn on
`createHeadlessCanvas` gives the same bytes on every run from its first frame, alone or beside another process on the
GPU, on WebGPU and the WebGL2 layer (`packages/sky/test/rain-frames-check.mjs`: a 90-frame rain shot with the
Bruneton sky, clouds, AgX and shadows, byte for byte in four fresh browsers). A page that reads its real canvas
instead must read it in the same task as `engine.render()`, as `capture` in `@margoengine/exporters` does: after an
`await`, `drawImage`, `toDataURL` and `createImageBitmap` of a WebGPU canvas give the last frame the browser showed,
which lags by a number of frames that differs from run to run (65 of 90 frames differed between two runs read that
way). On the WebGL2 layer the layer loads its compute part before `requestDevice` answers (KB-COMPAT-FIRSTTASK1 in
docs/known-bugs.md), so a page canvas read in the task of the first render shows that frame, as on WebGPU.

### Film frames: anti-aliasing and motion blur from sub-frames

`renderAccumulated` from `@margoengine/headless/accumulate` renders each frame `samples` times, each render at its own
time inside the open shutter and with its own sub-pixel offset, and averages them in linear light with an `Accumulate`
stage from `@margoengine/post/accumulate` (an optional peer, loaded on first use when no stage is given). The tone curve
is applied once, to the average, so a bright edge or a fast highlight keeps its brightness instead of the dark smear
an average of 8-bit frames gives. Everything that moves blurs, since each render is the scene at its own time:
cameras, skinned and morphed meshes, particles, wind. Each frame is read back once, after its last render.

```ts
import { writeFile } from 'node:fs/promises';
import { Camera, Engine, box, PbrMaterial } from '@margoengine/core';
import { createHeadlessCanvas, encodePNG, installGPU } from '@margoengine/headless';
import { renderAccumulated } from '@margoengine/headless/accumulate';
import { encodeEXR } from '@margoengine/headless/formats';
import { Accumulate } from '@margoengine/post/accumulate';
import { PostStack } from '@margoengine/post';
import { Tonemap } from '@margoengine/tonemap';
import { create } from 'webgpu';

const gpu = create([]);
using installed = installGPU({ gpu });
const engine = await Engine.create(createHeadlessCanvas({ width: 320, height: 180 }), { backend: 'webgpu' });
const cube = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#84d6bd' }));
const accumulate = new Accumulate();
PostStack.attach(engine, [accumulate, new Tonemap()]);
const camera = new Camera({ position: [0, 1.5, 4], target: [0, 0, 0] });

let frames = 0;
for await (const frame of renderAccumulated(engine, {
  frames: 4,
  fps: 24,
  samples: 16, // renders per frame
  shutter: 0.5, // a 180 degree shutter
  camera,
  accumulate,
  update: ({ time }) => {
    camera.position = [4 * Math.sin(time * 6), 1.5, 4 * Math.cos(time * 6)];
  },
})) {
  if (frame.data.length !== 320 * 180 * 4) throw new Error('wrong frame size');
  await writeFile(`film_${frame.index}.png`, await encodePNG(frame));
  frames++;
}
// output: 'linear' gives the mean in linear light, for an EXR.
for await (const frame of renderAccumulated(engine, { frames: 1, samples: 8, camera, accumulate, output: 'linear' }))
  await encodeEXR(frame);
if (frames !== 4 || !cube) throw new Error(`rendered ${frames} frames`);
engine.dispose();
```

| Option | What it does |
| --- | --- |
| `frames` | How many frames, a whole number from 1. Required. |
| `fps` | Frames per second. Default 30. |
| `samples` | Renders per frame, 1 to 4096. Default 16. 1 renders each frame once, with no offset. |
| `shutter` | Share of the frame interval the shutter is open, 0 to 1. Default 0.5 (180 degrees); 0 is a still instant. |
| `shutterPhase` | `'start'` (open from the frame's time), `'center'` or `'end'`. Default `'start'`. |
| `filter`, `filterWidth` | Pixel filter the offsets are drawn from: `'blackman-harris'` (default), `'gaussian'` or `'box'`; width in pixels, default 2 (1 for `'box'`). |
| `startFrame` | Number of the first frame, for a span of a longer film after a seek with `subFrameSteps`. Default 0. |
| `seed`, `pattern` | The sample pattern's seed (default 0); `'fixed'` (default) repeats it every frame so still edges do not shimmer, `'per-frame'` draws a new one. |
| `camera` | Camera to render through; it is never modified. Default the engine's camera. |
| `update(timing)` | Runs before each render with that render's `time`, `delta`, `index` (frame), `sample` and `samples`. May be async. |
| `accumulate` | The `Accumulate` stage in your PostStack, before `Tonemap`. Default one attached alone and disposed at the end. |
| `output` | `'display'` (default): 8-bit RGBA as `readPixels` reads it. `'linear'`: float RGBA of the mean, for `encodeEXR`. |
| `signal` | Stops between renders or during readback; the iterator rejects with the reason. |

`renderFrames` from `@margoengine/headless/video` takes the same `samples`, `shutter` and filter options and runs
`renderAccumulated` when `samples` is above 1 or `shutter` above 0, so `renderCutscene` and any film loop get motion
blur by adding two options; with neither it renders each frame once, exactly as before.

`subFrames(options)` is the same schedule without rendering: each render's `frame`, `sample`, `time`, `delta`, `offset`
and `last`, pure and repeatable. The engine's clocks start at 0 and the deltas keep them on each render's time (a render
before 0, with a `'center'` or `'end'` shutter on frame 0, moves them 0). `startFrame` starts a span of a longer film,
and `subFrameSteps({ ...options, startFrame })` lists the deltas of every render before it, for
`seek(engine, seconds, { steps })` in `@margoengine/cutscene/seek`: the span then gives the whole film's renders, bit
for bit. Times are the middles of `samples` equal slices of the open shutter, in order, so the
deltas add up to the frame interval; offsets are Owen-scrambled Sobol points (Burley 2020) mapped through the filter
(filter importance sampling, Ernst, Stamminger and Greiner 2006) and shuffled against the time order.

- **Checked on a real GPU** (`npm run test:gpu:accumulate -w @margoengine/headless`, WebGPU and the WebGL2 layer): an
  orthographic edge at x = 20.3 px reads 0.297 of the lit level in linear light at 64 box samples (one sample: 0 or 1);
  at radiance 4 the edge pixel equals a still lit to that share (244 against 244), far from the mean of the two
  display values (76); two runs are bit-identical; an 8 px strip moving 32 px a frame under a 180 degree shutter
  spreads over 24 px, keeps its energy (1.000) and centres at 44.03 px against 44 for mid-shutter; an abort rejects
  with its reason.
- **Limits.** Effects with their own frame history (TAA's jitter, SSGI multi-bounce) advance once per render, so turn
  TAA's jitter off (`velocityOnly`). Simulations see the sub-frame deltas, so a film repeats exactly for fixed `fps`,
  `samples`, `shutter` and phase. Cost is `samples` renders a frame. WebGPU and the WebGL2 layer; on the layer's
  half-float tier the sum is float16.

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
| `createHeadlessStage({ width, height, gpu?, globals?, onError?, transparent?, ...engineOptions })` | Installs the GPU and creates the engine on a stand-in canvas. `width` and `height` are required. `gpu` defaults to `navigator.gpu`, `globals` to none. `transparent` defaults to false; true leaves the background clear (below). The backend is always WebGPU. Stages alive at once must share one `gpu`; the globals are restored when the last is disposed. |
| `stage.toPNG({ signal? })`, `stage.readPixels({ signal? })` | Draws a frame and gives it as PNG bytes or RGBA pixels. |
| `stage.step(delta?)` | Runs `onTick` and `engine.onFrame` callbacks, then draws a frame that advances plugins by `delta` seconds, 0 to 1 (default 0); a delta outside that range, or a step from inside a step, throws before any callback runs. `stage.resize(width, height)` takes whole numbers from 1. Nothing runs by itself: there are no camera controls and no frame loop. |
| `stage.resize(width, height)` | Sets the image size for the next frame. |

`stage.onTick` and `stage.engine.onFrame` both run on `step`, so a package that drives itself from `onFrame` advances here too. To load a model
with `addGLTF`, pass an absolute URL, since Node has no page address to resolve against.

### Graphics over footage

`transparent: true` draws no background: `readPixels` gives alpha 0 where nothing was drawn, 255 on the graphics and
the coverage on their edges, as straight alpha, so titles, maps and lower thirds can be laid over recorded video
(`encodeVideo` and `encodeWithFFmpeg` keep it with `alpha: true`). It attaches `TransparentCanvas` from
`@margoengine/environment`, an optional peer. Tonemap, a `PostStack` ending in Tonemap, FXAA or SMAA, and the
`@margoengine/ui` overlay keep it. DOF, TAA and SceneFade are for opaque frames only; the `@margoengine/post` README
lists the other effects.

```ts
import { writeFile } from 'node:fs/promises';
import { createHeadlessStage } from '@margoengine/headless/stage';
import { Tonemap } from '@margoengine/tonemap';
import { Panel, Ui, UiRenderer } from '@margoengine/ui';
import { create } from 'webgpu';

const gpu = create([]);
using stage = await createHeadlessStage({ gpu, width: 640, height: 360, transparent: true });
stage.box({ color: '#84d6bd' });
Tonemap.attach(stage.engine);
const ui = new Ui();
ui.add(new Panel({ background: '#101820c0', width: 280, height: 64, anchor: 'bottom-left' }));
UiRenderer.attach(stage.engine, ui);
stage.fit();
await writeFile('overlay.png', await stage.toPNG());
```

## Choosing the GPU adapter

On a machine with two GPUs, an integrated one and a discrete one, the render runs on whichever adapter the binding hands out. Three things choose it, checked with the `webgpu` binding 0.6.2 on a Windows PC with an RTX A6000 and an integrated AMD GPU:

- `gpu.requestAdapter()` called with no options returned the integrated AMD GPU. Code that asks the binding for an adapter itself, to read its name or limits, gets that one unless it passes `{ powerPreference: 'high-performance' }`, which returned the RTX A6000.
- `Engine.create` and `createHeadlessStage` ask for `'high-performance'` themselves when you set nothing (Node reports no Windows browser, so the Windows exception in core's `powerPreference` does not apply) and got the RTX A6000. Set `powerPreference: 'low-power'` for the integrated GPU, or `'high-performance'` to say so in your code. It is an engine option, so `createHeadlessStage({ gpu, width, height, powerPreference })` takes it too.
- `create(['adapter=NVIDIA'])` fixes the choice in the binding: the first adapter whose name contains that text, whatever any caller asks for. The match is case sensitive (`adapter=nvidia` found nothing, `adapter=RTX` and `adapter=Radeon` matched). With no match the binding throws `no suitable backends found` and lists the adapters it has by name, which is the quickest way to learn what to write.

`engine.gpu.adapterInfo` names the GPU the engine got. This example runs as it stands; set `GPU_ADAPTER` to a part of an adapter name to fix the choice:

```ts
import { Engine } from '@margoengine/core';
import { createHeadlessCanvas, installGPU } from '@margoengine/headless';
import { create } from 'webgpu';

const wanted = process.env.GPU_ADAPTER;
const gpu = create(wanted ? [`adapter=${wanted}`] : []);
using installed = installGPU({ gpu });
const engine = await Engine.create(createHeadlessCanvas({ width: 640, height: 360 }), {
  backend: 'webgpu',
  powerPreference: 'high-performance',
});
console.log(engine.gpu?.adapterInfo?.device); // for example 'nvidia-rtx-a6000'
engine.dispose();
```

The two GPUs render at different speeds, so time your own scene with each before you fix a render machine's choice.

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

Frames of their own length, such as a capture of real time or a cut that holds a shot, carry `timestamp` (seconds from
the first frame) and the last one its `duration`. Each frame lasts until the next:

```ts
import { Engine, box } from '@margoengine/core';
import { encodeVideo, renderFrames, type VideoInputFrame } from '@margoengine/headless/video';
import { createHeadlessCanvas } from '@margoengine/headless';

const engine = await Engine.create(createHeadlessCanvas({ width: 320, height: 240 }), { backend: 'webgpu' });
const mesh = engine.createMesh().setGeometry(box());

// Three shots, held for half a second, a quarter of a second and two seconds.
const holds = [0.5, 0.25, 2];
async function* shots(): AsyncGenerator<VideoInputFrame> {
  let timestamp = 0;
  const update = ({ index }: { index: number }) => mesh.setRotation([0, index, 0]);
  for await (const frame of renderFrames(engine, { frames: holds.length, update })) {
    yield { ...frame, timestamp, duration: holds[frame.index] };
    timestamp += holds[frame.index];
  }
}

const video = await encodeVideo(shots(), { format: 'webm' });
if (video.frames !== 3 || Math.abs(video.duration - 2.75) > 0.001) throw new Error('unexpected timing');
engine.dispose();
```

`alpha: true` keeps the frames' alpha, for an overlay an editor or a page lays over other pictures. A second encoder
codes the alpha, and WebM carries it beside each frame as Matroska BlockAdditions, which Chromium's `<video>` and
ffmpeg's libvpx decoders read (both are tested); it takes VP9, else VP8:

```ts
import { encodeVideo, type VideoInputFrame } from '@margoengine/headless/video';

// A white bar fading in over two seconds, clear everywhere else: straight alpha, as readPixels gives it.
function* lowerThird(): Generator<VideoInputFrame> {
  const width = 320, height = 180;
  for (let index = 0; index < 60; index++) {
    const data = new Uint8Array(width * height * 4).fill(255);
    for (let i = 0; i < width * height; i++) data[i * 4 + 3] = i >= width * 130 && i < width * 160 ? index * 4 : 0;
    yield { width, height, data };
  }
}

const overlay = await encodeVideo(lowerThird(), { alpha: true });
if (!overlay.alpha || !overlay.mimeType.startsWith('video/webm')) throw new Error('no alpha');
```

`streamVideo` writes a fragmented MP4, or with `format: 'webm'` a live WebM, piece by piece as the frames are encoded,
so a long render holds one key frame interval of video at a time. Write each piece to a file, a socket or a
`WritableStream`, or append all but the last piece (the index) to a Media Source Extensions `SourceBuffer` to play
while it renders:

```ts
import { Engine, box } from '@margoengine/core';
import { renderFrames, streamVideo } from '@margoengine/headless/video';
import { createHeadlessCanvas } from '@margoengine/headless';

const engine = await Engine.create(createHeadlessCanvas({ width: 320, height: 240 }), { backend: 'webgpu' });
engine.createMesh().setGeometry(box());

const pieces: Uint8Array<ArrayBuffer>[] = [];
const stop = new AbortController();
for await (const piece of streamVideo(renderFrames(engine, { frames: 60 }), { keyFrameInterval: 1, signal: stop.signal })) {
  pieces.push(piece); // or: await writer.write(piece)
}
const file = new Blob(pieces, { type: 'video/mp4' });
if (pieces.length !== 4 || file.size === 0) throw new Error('unexpected stream'); // header, 2 fragments, index
engine.dispose();
```

The WebM stream carries alpha too, for an overlay played while it is made:

```ts
import { streamVideo, type VideoInputFrame } from '@margoengine/headless/video';

// A white bar fading in over two seconds, clear everywhere else: straight alpha, as readPixels gives it.
function* fadeIn(): Generator<VideoInputFrame> {
  const width = 320, height = 180;
  for (let index = 0; index < 60; index++) {
    const data = new Uint8Array(width * height * 4).fill(255);
    for (let i = 0; i < width * height; i++) data[i * 4 + 3] = i >= width * 130 && i < width * 160 ? index * 4 : 0;
    yield { width, height, data };
  }
}

const stream = streamVideo(fadeIn(), { format: 'webm', alpha: true, keyFrameInterval: 1 });
const pieces: Uint8Array<ArrayBuffer>[] = [];
let step;
while (!(step = await stream.next()).done) pieces.push(step.value); // header, 2 clusters, Cues
if (!step.value.alpha || pieces.length !== 4) throw new Error('unexpected stream');
const overlay = new Blob(pieces, { type: step.value.mimeType });
```

Node has no WebCodecs, so `@margoengine/headless/ffmpeg` (Node only) pipes the frames to the ffmpeg you have installed. Nothing
is downloaded, and it runs without a shell. `audio` adds sound from plain samples, sent down a second pipe beside the frames:

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

// Three seconds of a 440 Hz tone, as long as the 90 frames at 30 fps.
const tone = Float32Array.from({ length: 3 * 48000 }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / 48000));
const result = await encodeWithFFmpeg(renderFrames(engine, { frames: 90 }), {
  output: 'turntable.mp4',
  audio: { channels: [tone], sampleRate: 48000 },
});
if (result.frames !== 90 || result.audioDuration !== 3) throw new Error('unexpected file');
```

`npm run test:real-ffmpeg` writes H.264 and VP9 files, with and without AAC and Opus sound, through the ffmpeg you have (`FFMPEG` names another) and decodes them back to check frames, tags, colours, and the sound's length, pitch and level; then it reads alpha back with ffmpeg's libvpx decoder from a VP9 alpha file of `encodeWithFFmpeg`. `npm run test:gpu` does the same for the VP9 and VP8 alpha files `encodeVideo` makes in Chromium, after playing them in a `<video>`.

| Export | What it does |
| --- | --- |
| `renderFrames(engine, { frames, fps?, camera?, update?, signal? })` | Async iterator of frames: pixels plus `index`, `time`, `delta` and `progress`. `fps` defaults to 30, `camera` to the engine's. `update` runs before each frame is drawn. `progress` is `index / frames`: it never reaches 1, so a full turn loops with no repeated frame. The next frame is not drawn until you ask for it. |
| `imageSequence(frames, { prefix?, digits? })` | Async iterator of `{ index, name, bytes }` PNG files. `prefix` defaults to `'frame_'`, `digits` to 4. |
| `encodeVideo(frames, options?)` | The whole file in memory as `{ bytes, mimeType, codec, width, height, frames, duration }`, plus `alpha: true` when the file carries alpha. `format` `'webm'` (default) or `'mp4'`. `fps` 30. `codec`: a WebCodecs string; default the first supported of VP9, VP8, AV1 for WebM and H.264, VP9, AV1 for MP4. MP4 also takes H.265 (`hvc1.*` or `hev1.*`, for example `'hvc1.1.6.L93.B0'`) where the runtime encodes it (Safari, and Chromium with a platform encoder). `bitrate` `width * height * fps / 10`, at least 100,000. `keyFrameInterval` 2 seconds. `audio` none: `{ channels, sampleRate, bitrate? }` adds sound from plain samples, one `Float32Array` per channel, one or two channels, `bitrate` 128000, as Opus in WebM and as AAC or else Opus in MP4, and the result then has `audioCodec`. `alpha` false: true keeps the frames' alpha (straight, as `readPixels` gives it) in a WebM file, the same codec and settings whose luma is the alpha, and written as each frame's BlockAdditions (BlockAddID 1, AlphaMode 1 on the track, RFC 9559 and the Matroska V_VP8 and V_VP9 mappings); a frame is a key frame, with a cue, only when its colour and its alpha both are. It takes VP9, else VP8; MP4 and AV1 have no binding for alpha, so `format: 'mp4'` or an `av01` codec with `alpha` rejects with code `'unsupported'`. `webCodecs` `globalThis`, with `AudioEncoder` and `AudioData` needed for `audio`, and `AudioDecoder` used to measure an AAC encoder's lead-in (2112 samples, 44 ms at 48 kHz, on Chromium for macOS), which an edit list then cuts so the sound starts on time; without `AudioDecoder` an AAC track plays late by it. `signal` none. Each frame is converted to limited-range BT.709 4:2:0 before the encoder sees it, and the file says so (BT.709 primaries and matrix, sRGB transfer, chroma on the even columns between rows, the H.264 default), so every player draws the colours that were rendered, chroma edges in place. A frame may carry `timestamp`, seconds counted from the first frame's, for frames of varying length (a capture of real time, a cut that holds a shot): give it on every frame or none, each later than the one before; each frame lasts until the next, and the last one its own `duration` (seconds) or else the gap before it. Key frames then come `keyFrameInterval` seconds apart, and WebM states no default frame duration. Without timestamps frame n shows at n / fps. H.264 and H.265 state sizes in steps of two, so an odd width or height gains one repeated last column or row there (the result's `width` and `height` give the size written); VP8, VP9 and AV1 keep odd sizes. `mimeType` names every stream in the file, the sound's too (`video/mp4; codecs="avc1.640033,mp4a.40.2"`), as RFC 6381 asks, so `MediaSource.isTypeSupported` and `canPlayType` judge the whole file. |
| `streamVideo(frames, options?)` | Async iterator of the pieces of a video file as it is encoded. `format` `'mp4'` (default): a fragmented MP4 (ISO/IEC 14496-12 8.8): the header (`ftyp`, `moov` with empty sample tables and `mvex`) once the encoder gives its configuration, then a `moof` and `mdat` per key frame interval as soon as the next key frame shows where it ends, then an `mfra` index so a player seeks the finished file without reading every fragment. `format` `'webm'`: a WebM written as a live stream (RFC 9559 6.2): the header (EBML header, a Segment of unknown size, Info with no duration, Tracks, Tags), then a Cluster per key frame interval as soon as the next key frame shows where it ends, then the Cues; its clusters are `encodeVideo`'s, and `alpha` keeps the frames' alpha as `encodeVideo` does (VP9, else VP8). Joined, the pieces are one file that browsers and ffmpeg play; all but the last piece are what a Media Source Extensions `SourceBuffer` takes. Options are `encodeVideo`'s (`fps`, `codec`, `bitrate`, `keyFrameInterval`, `audio`, `alpha`, `provenance`, `webCodecs`, `signal`) without `maxBytes`: only one key frame interval of encoded video is held, so there is no total to cap. `alpha` with MP4 or an `av01` codec rejects with code `'unsupported'`. `audio` is encoded first and each fragment or cluster carries the sound of the time its frames cover (in MP4 with the same edit list and roll groups as `encodeVideo`). A joined WebM states no duration, as its header went out before the end was known. The iteration's return value is `encodeVideo`'s result without `bytes`. Stopping the iteration (`break`, or `signal`, which rejects with its reason) closes the encoders. |
| `encodeWithFFmpeg(frames, { output, fps?, ffmpeg?, args?, audio?, alpha?, layers?, signal? })` | Writes `output` and resolves `{ output, width, height, frames }`, plus `audioDuration` (seconds) with sound. `audio` none: `{ channels, sampleRate, bitrate? }`, one `Float32Array` per channel from -1 to 1, one or two channels of one length, a whole `sampleRate`, `bitrate` 128000; it goes to ffmpeg as 32-bit float samples on a second pipe (`pipe:3`) while the frames go down standard input, each waiting only for its own room, and is written as Opus for `.webm` and AAC for anything else. With `args` the sound is still input 1 and mapped (`-map 0:v:0 -map 1:a:0`), and its codec is the one your arguments or ffmpeg's default for the file pick. `fps` defaults to 30, `ffmpeg` to `'ffmpeg'` on the `PATH` (or `['nice', 'ffmpeg']`). `args` replaces the output arguments, which default to VP9 at `-crf 32` for `.webm` and H.264 at `-crf 20` for anything else, both 4:2:0, limited range, tagged BT.709 for matrix and primaries and sRGB for transfer, as `encodeVideo` tags them, with chroma made and tagged on the left column between rows. With the default H.264 arguments an odd width or height gains one repeated last column or row, and the result gives the size written. `alpha` false: true keeps the frames' alpha as VP9 with an alpha plane (`yuva420p`), which ffmpeg writes as WebM BlockAdditions; it needs a `.webm` output and the default arguments, and rejects with code `'unsupported'` otherwise (with `args`, choose the pixel format there). `layers` none: each `{ input, rect: { x, y, width, height }, start?, duration?, in?, speed?, fit? }` lays the file `input` over the frames in the box `rect` (whole pixels inside the written frame), from `start` seconds (default 0) for `duration` seconds (default: until the file ends; a still picture needs one), reading the file from `in` seconds (default 0) at `speed` (default 1), cut to `crop` `[x, y, width, height]` of the file first (even whole pixels inside it; default all of it), fitted by `fit` `'contain'` (default: all of it, the rest of the box `pad`, a colour `'#rgb'`, `'#rrggbb'` or `'#rrggbbaa'`, default clear), `'cover'` or `'fill'` (`contain` and `cover` keep the shape the file is shown at, its width times its sample aspect ratio over its height, so a clip with non-square samples such as 720x480 at 32:27 fills a 16:9 box; `fill` stretches to the box), and read with `matrix` and `range` (default: the file's tags; untagged, `'bt709'` at 720 lines or more and `'bt601'` below, at `'tv'` range; an untagged JPEG `'bt601'` at `'pc'`); later layers lie on top. Each clip frame starts on the film frame nearest its own time (`fps=<fps>:round=near`). Frame k shows a layer when start <= k / fps < start + duration, its last frame held to the end of its window, and the video keeps the rendered frames' length. Each layer file is read once with `probeVideo` before the encode. The layers and the colour chain run as one `-filter_complex` graph, the output arguments' `-vf` moved to its end, so a layered video is tagged exactly as a plain one. A failure's `cause` holds the end of ffmpeg's log. |
| `ffmpegArguments(width, height, { output, fps?, args?, audio?, alpha?, layers? })` | The argument list `encodeWithFFmpeg` uses. It reads no file: pass layers through `resolveLayers` first for the default colours. |
| `probeVideo(input, { ffmpeg?, signal? })` | The first video stream of a video or picture file as ffmpeg reports it: `{ codec, pixelFormat, width, height, rgb, matrix?, range? }`, `matrix` and `range` only when the file is tagged with them (ffmpeg's names, such as `'bt709'`, `'bt470bg'`, `'tv'`), `rgb` true for RGB, palette and grey formats. Rejects with code `'failed'` when there is no video stream. |
| `resolveLayers(layers, { ffmpeg?, signal? })` | The layers with `matrix` and `range` filled in for each untagged file by the defaults above, each file read once; a `crop` outside its file throws a RangeError. |
| `layersOverPicture(picture, output, { frame, fps?, layers, ffmpeg?, signal? })` | Lays `layers` over `picture`, a rendered frame `frame` of a video at `fps` (default 30), exactly as `encodeWithFFmpeg` lays them on that frame, and writes `output` (PNG for a `.png` name). The still equals the encode's frame pixel for pixel when the encode is lossless RGB. |
| `layersPictureArguments(width, height, { picture, output, frame, fps?, layers })` | The argument list `layersOverPicture` uses. |

Frames must all be one size. Video drops alpha unless `alpha` keeps it (WebM only). H.264 and the default ffmpeg settings need even sizes.

### Finished files: encoders, joins, sound, stream-copy cuts and layers

`@margoengine/headless/ffmpeg-files` (Node only) works on finished files with the same ffmpeg, and `encodeWithFFmpeg`
takes `layers`, other video or picture files laid over the frames inside the one encode (picture in picture), put
through the same colour chain as a plain render; `layersOverPicture` lays the same layers over one rendered frame, so a
still matches the video. `encoderArguments` gives a hardware H.264 encoder (NVENC, AMF, Quick
Sync) or x264 the engine's colour handling; `joinVideos` joins chunks by stream copy, writing `avc3` when their
parameter sets differ; `addSound` lays a sound file under a video without encoding the picture again; `copySpan` cuts
a recorded span by stream copy, after checking it is exactly the frames it should be, re-tagged as an engine chunk.

```ts
import { writeFile } from 'node:fs/promises';
import { encodePNG } from '@margoengine/headless';
import { encodeWithFFmpeg, layersOverPicture } from '@margoengine/headless/ffmpeg';
import { addSound, checkSpan, copySpan, encoderArguments, joinVideos } from '@margoengine/headless/ffmpeg-files';
import { encodeWav } from '@margoengine/audio/wav';

// Two one-second chunks of plain frames (any renderFrames source works the same way), each a separate encode.
const frames = (red: number) =>
  Array.from({ length: 30 }, () => ({ width: 128, height: 72, data: new Uint8Array(128 * 72 * 4).fill(red) }));
const args = encoderArguments('x264', { preset: 'veryfast' }); // or 'nvenc', 'amf', 'qsv' where the GPU has one
await encodeWithFFmpeg(frames(60), { output: 'part-1.mp4', args });
await encodeWithFFmpeg(frames(200), { output: 'part-2.mp4', args });

// A third chunk with the middle of part 1 playing in a box at the top left from 0.25 s for half a second, on a dark
// plate where it does not fill the box.
const layers = [
  {
    input: 'part-1.mp4',
    rect: { x: 0, y: 0, width: 64, height: 48 },
    start: 0.25,
    duration: 0.5,
    crop: [32, 18, 64, 36] as const,
    pad: '#202830',
  },
];
await encodeWithFFmpeg(frames(120), { output: 'part-3.mp4', args, layers });

// The same layers over frame 15 of part 3 as one picture: what the video shows at 0.5 s.
await writeFile('frame-15.png', await encodePNG(frames(120)[15]));
await layersOverPicture('frame-15.png', 'still-15.png', { fps: 30, frame: 15, layers });

const entry = await joinVideos(['part-1.mp4', 'part-2.mp4', 'part-3.mp4'], 'film.mp4');
await writeFile('tone.wav', encodeWav({ sampleRate: 48000, channels: [Float32Array.from({ length: 3 * 48000 }, (_, i) => 0.2 * Math.sin(i / 20))] }));
await addSound('film.mp4', 'tone.wav', 'film-with-sound.mp4');

// Part 2 starts on a key frame at 1 s, so it cuts out again without an encode.
const check = await checkSpan('film.mp4', { start: 1, frames: 30, fps: 30 });
if (!check.ok || !entry) throw new Error(check.reason ?? 'not H.264');
await copySpan('film.mp4', 'part-2-again.mp4', { start: 1, frames: 30, fps: 30 });
```

A layer file is read with the matrix and range it is tagged with. Untagged, it is read as ITU-R BT.709 at 720 lines or
more and ITU-R BT.601 below, at TV range: ITU-T H.273 leaves untagged colour to the application, HD video (SMPTE ST
296, ST 274) is BT.709 and SD video is BT.601, while ffmpeg's scaler reads every untagged file as BT.601, so an HD
clip came out up to 8 levels off on red and blue. An untagged JPEG is JFIF (ITU-T T.871): BT.601 at full range. A
layer's `matrix` (`'bt709'`, `'bt601'`, `'bt2020'`) and `range` (`'tv'`, `'pc'`) replace the file's own. Each clip
frame starts on the film frame nearest its own time (ffmpeg's `fps` filter, `round=near`), so a 24 fps clip in a 30
fps film repeats one frame in four, evenly.

`npm run test:real-ffmpeg` also runs these through the ffmpeg you have: the recording's sample times and key flags
against ffprobe's (plain and fragmented MP4), a copied span decoding to the recording's own frames, an engine chunk and
a copied span joined as `avc3` and decoding to both, sound added with the picture packets unchanged, every hardware
encoder ffmpeg lists writing the engine's tags (an encoder with no device is reported, not passed), and layers shown
only inside their window.

| Export of `/ffmpeg-files` | What it does |
| --- | --- |
| `encoderArguments(encoder?, { quality?, preset? })` | Output arguments for `encodeWithFFmpeg`'s `args`: `encoder` `'x264'` (default, libx264), `'nvenc'`, `'amf'` or `'qsv'`, at constant `quality` 1 to 51 (default 20: x264's CRF, NVENC's CQ with `-preset p5 -tune hq` and no rate cap, AMF's QP on every frame type with `-quality quality`, Quick Sync's global quality). `preset` is x264's (`'ultrafast'` to `'placebo'`) or NVENC's (`'p1'` to `'p7'`). Every encoder gets the default's BT.709, TV range, sRGB transfer and left chroma chain, the same stream tags, the `H264_COLOUR_TAGS` VUI rewrite (whatever the encoder writes itself) and `+faststart`. |
| `H264_COLOUR_TAGS` | The `h264_metadata` bitstream filter that writes the engine's colour into an H.264 stream's parameter sets: primaries 1, transfer 13, matrix 1, TV range, chroma location 0 (ITU-T H.273). |
| `joinVideos(inputs, output, { sampleEntry?, ffmpeg?, signal? })` | Joins files end to end by stream copy (ffmpeg's concat demuxer, `-c copy`, `+faststart`). The files must share codec, size and frame rate, as chunks of one render do. `sampleEntry` `'auto'` (default) writes `avc3` when the inputs' H.264 parameter sets differ, since `avc1` keeps one set in its sample entry and such a join carries each file's own sets in band (ISO/IEC 14496-15), and `avc1` when they agree. Resolves the entry written, or undefined for inputs that are not H.264 MP4. |
| `addSound(video, sound, output, { codec?, bitrate?, offset?, shortest?, ffmpeg?, signal? })` | Lays the first audio stream of `sound` (WAV, FLAC, MP3, AAC, anything ffmpeg reads) under `video` with the picture copied, replacing any sound it had. `codec` `'aac'` (default for MP4 and MOV), `'opus'` (default for WebM) or `'copy'`; `bitrate` 192000; `offset` seconds of picture before the sound starts (default 0); `shortest` ends the file with the shorter of the two (default false). |
| `checkSpan(file, { start, frames, fps, timescale? })` | Whether `frames` frames from `start` of an MP4 or MOV file can be cut by stream copy so frame k sits at start + k / fps: H.264; a key frame within half a tick of `start` (ticks of `timescale`, default `mp4Timescale(fps)`); the next `frames` samples in decode order are exactly frames 0 to frames - 1, each within half a tick of its step, so none is missing and none is an open GOP's leading frame decoded after the key frame. Resolves `{ ok: true }` or `{ ok: false, reason }`. |
| `copySpan(input, output, { start, frames, fps, timescale?, ffmpeg?, signal? })` | Cuts that span by stream copy (no decode, no encode): the picture alone, its VUI rewritten by `H264_COLOUR_TAGS`, at `timescale`, with `+faststart`, so it joins engine chunks with `joinVideos`. Rejects with code `'unsupported'` and the reason when `checkSpan` refuses it. |
| `readVideoTrack(file)` | The first video track of an MP4 or MOV file: `codec` (the sample entry, such as `'avc1'`), `timescale`, `avcConfig` (the `avcC` body, H.264 only) and `samples`, each `{ time, key }` in decode order, from the sample tables and any movie fragments, with the edit list applied (ISO/IEC 14496-12). Reads box headers, `moov` and each `moof`, never the media data. Rejects with code `'unsupported'` when there is no video track. |
| `mp4Timescale(fps)` | The MP4 track timescale ffmpeg gives an encode at a whole `fps` (the rate doubled until it reaches 10,000: 15,360 at 30 and 60 fps), the default timescale of a copied span. |

Every tool writes through a temporary file beside `output` and renames it once ffmpeg succeeds, so a failure or an
abort leaves no half file; a failure rejects with code `'failed'` and the end of ffmpeg's log in `cause`, and a missing
ffmpeg with code `'unsupported'`. Paths go to ffmpeg as arguments, never through a shell.

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
| `pixelDiff(a, b, { threshold?, image?, mask?, clusters? })` | `{ different, total, ratio, largest, mean, box }`. A pixel differs when a channel moves more than `threshold`, 0 to 255, default 2. Colours are compared premultiplied, so colour under full transparency does not count. `box` is the smallest `{ x, y, width, height }` holding every changed pixel, null when none changed. `image: true` adds changed pixels in red over a faded `a`; `mask: true` adds `mask`, one byte a pixel, 1 where it changed; `clusters: gap` adds `clusters`, one box per group of touching changed pixels, joining groups at most `gap` pixels apart. |
| `ssim(a, b, { window?, sigma?, map? })` | Structural similarity as `{ score }`: 1 for identical images. `window` defaults to 11, `sigma` to 1.5, as published, on luma. `map: true` adds the score of each window. |
| `decodePNG(bytes)` | A PNG file as RGBA pixels: every colour type and bit depth, interlaced or not, 16-bit samples cut to 8. A chunk with a bad CRC or a bit depth its colour type cannot have rejects. Colour profiles and gamma are ignored. All of PngSuite reads as Chromium reads it. |

A pixel count sees how many pixels moved, and SSIM sees whether the picture looks different: a slight brightness change fails
the first and passes the second, and a small hole does the opposite. Images of different sizes reject.

`box` and `clusters` say where a picture changed, so a test can crop the difference or check that a change stayed inside
the region it meant to touch:

```ts
import assert from 'node:assert/strict';
import { pixelDiff } from '@margoengine/headless/compare';

const width = 64, height = 32;
const before = { width, height, data: new Uint8Array(width * height * 4).fill(255) };
const after = { width, height, data: before.data.slice() };
for (const [x, y] of [[10, 4], [11, 5], [40, 20]]) after.data.set([255, 0, 0, 255], (y * width + x) * 4);

const diff = pixelDiff(before, after, { mask: true, clusters: 2 });
assert.deepEqual(diff.box, { x: 10, y: 4, width: 31, height: 17 });
assert.deepEqual(diff.clusters, [{ x: 10, y: 4, width: 2, height: 2 }, { x: 40, y: 20, width: 1, height: 1 }]);
assert.equal(diff.mask![5 * width + 11], 1);
```

## Look checks for rendered shots

`@margoengine/headless/look` reviews rendered frames before a person does: pure functions over 8-bit frames, float
frames and grey masks, each giving a value and a pass against a bound. `checkShot` runs them on every probe frame of a
shot rendered by the shot tool (`tools/shot`, [docs/shots.md](../../docs/shots.md)), with the bounds of the shot file's
`lookBounds`, and gives one contact sheet and one table, so a shot is reviewed as one page. Nothing here needs a GPU.

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodePNG } from '@margoengine/headless';
import { checkShot } from '@margoengine/headless/look';

// A night sky with 16 grey levels where 8-bit output has 64: the banding a short must not ship.
const width = 270,
  height = 480,
  data = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const v = 20 + Math.floor((y / height) * 16) * 4;
    data.set([v, v, v + 10, 255], (y * width + x) * 4);
  }
await mkdir('shot/probes', { recursive: true });
await writeFile('shot/probes/opening.png', await encodePNG({ width, height, data }));

// The shot tool writes manifest.json beside the frames; its header carries the shot file's lookBounds.
const manifest = {
  id: 'night-sky',
  header: { lookBounds: { banding: 1, lights: [0, 1] as [number, number] } },
  probes: { opening: { frame: 0, file: 'probes/opening.png' } },
};
const report = await checkShot({ manifest, read: (path) => readFile(join('shot', path)) });
await writeFile('shot/look.md', report.markdown);
await writeFile('shot/look.json', JSON.stringify(report.json, null, 2));
await writeFile('shot/look.png', await encodePNG(report.sheet));
console.log(report.pass ? 'looks right' : 'look checks failed: see shot/look.md and shot/look.png');
```

The checks, by their `lookBounds` name. A number bound is the largest value that passes, `[low, high]` a range; a
name left out keeps the default below. A check runs when its inputs are there; one named in `lookBounds` that cannot run,
or a name no check has, fails as `not run`, never a pass. A check that ran over a mask with no pixels in it (a
`sky` mask of a frame with no sky in view) passes with `empty` set, `'0 sky pixels'` for `skyClip`, and the table says
`pass (measured 0 sky pixels)`, so that pass is never silent.

With no `sky` mask, `skyClip` measures inside a `sky-coverage` mask when the probe has one: the pixels
`@margoengine/sky` drew (its `coverage` option), which the shot tool reads from the page's sky. So the flames and a
kettle's glint in an interior are not counted as sky. Only `skyClip` reads it; `grain`, `lights` and `horizonSeam`
keep the `sky` mask or the whole frame. Each `skyClip` row's `mask` says what it measured inside (`sky`,
`sky-coverage` or `frame`), and look.md lists it under the table:

```ts
import { checkProbe, lookReport } from '@margoengine/headless/look';

// An interior: a clipped flame in the lower half, the window's sky in the top-left corner.
const width = 40,
  height = 40,
  data = new Uint8Array(width * height * 4),
  sky = new Uint8Array(width * height);
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const v = y >= 20 && x >= 10 && x < 30 ? 255 : 60;
    data.set([v, v, v, 255], (y * width + x) * 4);
    sky[y * width + x] = x < 12 && y < 12 ? 255 : 0;
  }
const frame = { width, height, data };
const rows = checkProbe({ name: 'hearth', frame, masks: { 'sky-coverage': { width, height, data: sky } } }, { skyClip: 0.5 });
const clip = rows.find((row) => row.check === 'skyClip')!;
console.log(clip.value, clip.mask); // 0 'sky-coverage': the flame is not sky
console.log(lookReport([{ name: 'hearth', frame, results: rows }]).markdown.split('Masks:')[1]);
```

| Name | Value | Default bound | Needs |
| --- | --- | --- | --- |
| `skyClip` | % of sky pixels with a channel at 254 or more | 0.5 | the frame; the `sky` mask if there is one, else `sky-coverage` if there is one |
| `grain` | noise standard deviation in 8-bit codes (Immerkaer's estimator, blind to ramps) | 1.5 | the frame; measured in the `sky` mask if there is one |
| `speckle` | pixels 24 codes above or below all eight neighbours, per million | 50 | the frame |
| `banding` | % of pixels in flat runs of 6 or more split by a step of 1.5 to 12 codes, a skipped code | 1 | the frame |
| `flat` | % of pixels at the centre of a constant 65 x 65 window, black and white left out | 5 | the frame |
| `blocks` | % of the frame in tiles with steps repeating at the 8-pixel froxel pitch | 1 | the frame |
| `horizonSeam` | luma step at the analytic horizon beyond its surroundings, codes (median over the columns with sky just above the line) | 6 | the camera's `viewProjection` and the `sky` mask (an interior's line runs across walls, not a horizon) |
| `waterSeam` | the same at the water line, the top edge of the `water` mask | 6 | the `water` mask |
| `lights` | bright discs (moon, sun, lamps), against the lights the scene shows; a disc counts when its core clips (luma 250 or more) or a ring just outside it is below 0.7 of the level, so sunlit cumulus puffs that shade into their cloud do not | [0, 1] | the frame; the `sky` mask if there is one |
| `foamEdges` | % of strong foam edges 2 pixels wide or less | 35 | the `foam` mask |
| `crush` | % of pixels at black (channels 2 or less) outside the `dark` mask | 0.5 | the frame |
| `flicker` | largest jump of the mean luma off its trend, codes | 0.75 | `still`: 3 or more frames of a still camera |
| `shimmer` | % of pixels jumping more than 6 codes off their own trend | 0.5 | `still` frames |
| `nan` | pixels with a NaN or infinite channel | 0 | `hdr`: the float frame |
| `backends` | mean FLIP of the WebGPU frame against the WebGL2 compatibility layer's | 0.03 | `compat`: the compat frame |
| `reference` | mean FLIP against a 16-sample reference render | 0.05 | `reference`: the reference frame |
| `penumbra` | T1: noise standard deviation inside the shadow penumbra on the ground (the `plants` mask left out, at least `PENUMBRA_MIN_PIXELS`, 2,055, interior pixels), codes | 0.7 | the `penumbra` mask, and `plants` where the shot has plants |
| `penumbraPlants` | T1 on foliage: grain of the plants inside the penumbra over the grain of the plants outside it, in the same frame (foliage texture detail is not shadow noise, so the plants are held to their own detail; KB-LOOK-TV-PENUMBRA2) | 1 | the `penumbra` and `plants` masks |
| `stairs` | T3: % of strong edges (a step over 24 codes) that are one pixel stair steps: a step with no value between its two plateaus in the 3 x 4 window of its two pixels (nothing further than a tenth of the range from both ends), on an edge that is not straight along a pixel row or column | 1 | the frame |
| `colourEdges` | T7: the same on the a* and b* planes: colour edges 4:2:0 smears | 10 | the frame |
| `chromaSmear` | T7: percent of pixels whose colour moves by CIE76 over 6 when the frame is cut to 4:2:0 chroma (BT.709 Y'CbCr, 2 x 2 averages, bilinear read back), no encoder needed | 2 | the frame |
| `shimmerMoving` | T4: % of pixels off by over 6 codes once the camera motion is undone | 0.5 | `moving`: the next frame and each pixel's motion (`reprojectionMotion` makes it from depth and the two view-projections) |
| `motionBlur` | T8: % of edge centres of pixels moving over 8 pixels a frame whose edge is narrower than half the shutter's smear (`shutter` degrees, default 180, smear `shutter / 360` of the travel; `checkShot` reads the angle from `manifest.render` when the shot drew sub-frames) | 5 | `moving` |
| `silhouette` | T5: % of the subject's outline with 15 L* or more against what is behind | [80, 100] | the `subject` mask |
| `silhouetteShape` | T5: % of the subject (at 320 x 180, three L* values) in one value | [70, 100] | the `subject` mask |
| `bounce` | T6: shadowed ground luminance as a % of the lit ground's, linear light, each over its mask's interior (`GROUND_INSET`, 1/360 of the shorter side, in from every edge, where the frame mixes both sides) | [10, 35] under a clear sun; a probe's `light` moves it (`lightBounds`) | the `lit` and `shadow` masks |
| `shadowTint` | T6: lit b* minus shadow b*, points: shadows cooler than the sun, over the masks' interiors as `bounce` | [3, 100] under a clear sun; a probe's `light` moves it (`lightBounds`) | the `lit` and `shadow` masks |
| `nightLuma`, `nightPeak` | T7: mean luma, and the luma of the brightest 1%, of a night frame | [24, 255], [180, 255] | the frame; run only when a shot names them |

| Export | What it does |
| --- | --- |
| `checkShot({ manifest, read, signal?, pitch?, pixelsPerDegree?, thumbWidth?, columns?, title? })` | Reads each probe of a shot tool manifest (`probes.<name>.file`, `aovs`, and the optional `reference`, `compat`, `still` PNGs, `hdr` raw RGBA float32 file and `viewProjection`) through `read(path)`, runs `checkProbe` with `header.lookBounds` under `header.lookFamily`'s bounds (and `moving: { next, motion }` per probe: a PNG and a raw float32 file of x, y per pixel), a probe's own `probes.<name>.lookBounds` in their place for the checks it names, and resolves `lookReport`. `signal` stops it between probes. |
| `checkProbe(probe, bounds?, { pitch?, pixelsPerDegree?, family? })` | The rows of one probe `{ name, frame, masks?, hdr?, reference?, compat?, viewProjection?, still?, moving? }`. Masks are one byte or RGBA per pixel, 128 and above inside: `sky`, `water`, `foam`, `dark`, `penumbra`, `plants`, `subject`, `lit` and `shadow` are read. `family` names a look family (below). `pitch` defaults to 8, `pixelsPerDegree` to 67. |
| `lookReport(probes, { thumbWidth?, columns?, title? })` | `{ pass, json, markdown, sheet }` of `{ name, frame, results }` probes: the table failures first, and a contact sheet of thumbnails (default 270 wide, 4 across) framed green or red and labelled with what failed, each reference check's FLIP map beside its frame. |
| `skyClip`, `grain`, `speckle`, `banding`, `flat`, `blocks`, `horizonSeam`, `waterSeam`, `lights`, `foamEdges`, `crush`, `flicker`, `shimmer`, `nan` | Each check alone, `(frame, options)` with its `bound` and the options above (`flicker` and `shimmer` take the frames), giving `{ check, value, bound, pass, unit, detail }`. `lights` adds `discs` with their centres and radii. |
| `flip(test, reference, { pixelsPerDegree?, map? })` | FLIP (Andersson et al. 2020): the difference a viewer sees flipping between two frames, 0 to 1 per pixel, as `{ mean, p50, p95, p99, max }` and the per-pixel `map` with `map: true`. 67 pixels per degree is a 4K monitor at 0.7 m; a phone at 30 cm showing 1080 pixels across 6.5 cm is about 87. `difference(frame, other, 'reference' or 'backends')` is its check row. |
| `horizonLine(viewProjection, width, height)`, `maskTopEdge(mask)` | The row per column of the horizon of horizontal planes (column-major view-projection, WebGPU clip space) and of a mask's top edge. NaN where there is none. |
| `stairs`, `colourEdges`, `chromaSmear`, `penumbra`, `penumbraPlants`, `shimmerMoving`, `motionBlur`, `silhouette`, `silhouetteShape`, `bounce`, `shadowTint`, `nightLuma`, `nightPeak`, `reprojectionMotion(depth, viewProjection, nextViewProjection, width, height)`, `depthFromDistance(distance, eye, viewProjection, width, height, { water, plane, far })` (NDC depth from each pixel's distance to the eye, for `reprojectionMotion`; pixels with no distance meet the sea plane where `water` is 128 or more, or are `far` away), `detailKeptFloor(family)` (T7: 0.5, and 0.6 for `animatedFeature`, as `LOOK_FAMILY_DETAIL_KEPT`) | The clean-frame checks (below), each alone with its `bound`; `reprojectionMotion` gives the motion of every pixel of a still world seen by a moving camera. |
| `LOOK_FAMILY_BOUNDS`, `LOOK_FAMILY_NAMES`, `familyBounds(name)` | The look families and their bounds. |
| `luma(frame)`, `lookBound(bound)`, `LOOK_CHECKS` | BT.709 luma on 0 to 255, a bound as `[low, high]`, and each check's default bound, unit and meaning. |

**T6 limits that follow the light** (KB-LOOK-TV-PALL1, 2026-11-26). A probe may carry the light its frame was shaded
with, `light: { sun: { direction, intensity, colour }, ambient }` (the shot tool records it on every probe: the sun as
core holds it, `direction` toward the light, and the diffuse light on level ground, irradiance over pi in the same
units: `Sky.irradiance()` where a sky lights the scene, else `lighting.ambient` x `radiance[3]`). `lightBounds(light,
base?)` gives its diffuse fraction d, the sky's luminance over the sky's plus the sun's beam on level ground (intensity x
colour x cos / pi), and the T6 limits for it. A shadow loses the beam and keeps the sky it sees and the light bounced
into it, both in proportion to the diffuse light, so up to `CLEAR_SUN_DIFFUSE` (0.3336: `erbsDiffuseFraction(0.65)`,
Erbs, Klein and Duffie 1982, at the clearness index above which a sky is clear, Fakra et al. 2011) the limits stay 10 to
35 percent and 3 b*; above it `bounce` is the base x d / 0.3336 (at most 100) and the `shadowTint` floor the base x
(1 - d) / (1 - 0.3336). `checkProbe` uses them in place of the family's or default limits; a bound the shot names wins.
Each T6 row records `detail.diffuse`. The timber-valley rail line (2026-11-26): calm, d 0.340 and 0.400 (its sun is 29.5
degrees up under a cloud deck), limits 10.2 to 35.6 and 12.0 to 42.0 percent, read 17.6 and 28.9; blowup under its smoke
pall, d 0.943 and 0.942, limits 28.3 to 99.0 and 28.2 to 98.8 percent and tint floors 0.25 and 0.26 b*, read 93.4 and
91.3 percent and 0.33 and 0.68 b*: all pass. The same pall frame under a clear sun still fails both, and sunlit-looking
20 percent shadows under the pall fail.

```js
import { lightBounds } from '@margoengine/headless/look';
const { diffuse, bounce, shadowTint } = lightBounds({
  sun: { direction: [0.87, 0.49, 0], intensity: 0.249, colour: [1, 0.3, 0.04] },
  ambient: [0.33, 0.29, 0.27],
});
console.log(diffuse.toFixed(2), bounce.map(Math.round), shadowTint[0].toFixed(2)); // 0.95 [ 28, 99 ] 0.24
```

**Clean frames and look families.** The clean-frame checks are the look bar of the animated-feature film (T1 to T8, private roadmap section 3): no grain, banding, stairs or shimmer, shapes that read, bounce light in the shadows, colour that survives YouTube's 4:2:0 H.264 and motion that is blurred. `checkProbe(probe, bounds, { family: 'animatedFeature' })` (or `lookFamily: "animatedFeature"` in a shot file) holds every check the probe can run to the family's bound: grain 0.5 codes, penumbra 0.7, penumbraPlants 1, speckle 5 ppm, banding 0.2%, stairs 1%, still shimmer 0.1% and flicker 0.3, `shimmerMoving` 0.5%, crush 0.1%, the reference FLIP 0.04, plus the ranges above. A check whose input the probe lacks is left out under a family (a shot that names it in `lookBounds` still fails it as missing); a mask that marks no pixel counts as lacking, so a frame with no subject or no shaded ground runs no `silhouette` or `bounce`, and a shot's own `lookBounds` win by name. `natural` keeps every default. `stairs` and `colourEdges` read the frame alone. A step was once judged against the climb along its own row, which misread an antialiased edge near a pixel axis (one pixel of coverage 0.1 per row is a tenth of the climb on one side and nine tenths on the other): a 16 sample per pixel render of the storm-light shot read 15% `stairs`. They now look for a value between the plateaus around the step; on that shot msaa 1 reads 5.70% over the whole frame (5.98% on the crop in `tests/fixtures/look-real`, against 30.6% by the old test), msaa 4 at supersample 1, 1.5 and 2 read 0.10, 0.00 and 0.01%, and the 16 sample reference 0.00%. The flood draft shots (msaa 1, supersample 1) read 2.7 to 22.7%, which is real aliasing: they are not rendered at the film setting.

```ts
import { checkProbe, familyBounds } from '@margoengine/headless/look';

// A dark disc on pale haze with a resolved (antialiased) edge: the family's stairs bound is 1%.
const size = 48,
  data = new Uint8Array(size * size * 4);
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - 24, y - 24),
      v = Math.round(210 - 180 * Math.min(1, Math.max(0, 12.5 - d)));
    data.set([v, v, v, 255], (y * size + x) * 4);
  }
const rows = checkProbe({ name: 'disc', frame: { width: size, height: size, data } }, {}, { family: 'animatedFeature' });
const stairs = rows.find((row) => row.check === 'stairs')!;
console.log(familyBounds('animatedFeature').stairs, stairs.value, stairs.pass); // [0, 1] 0 true
```

Default bounds are starting values for a 1080 x 1920 short; a scene kit or shot file sets its own. FLIP keeps about 30
float planes of the frame's size while it runs, the other checks one or two. Frames and masks of different sizes
reject with a RangeError.

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
