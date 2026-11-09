# @margoengine/video

Import `margoengine/video` from the `margoengine` package, or `@margoengine/video` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

WebGPU external video textures from HTMLVideoElement or VideoFrame, imported with `importExternalTexture` (no JS-side copy; whether the browser copies depends on the platform), with a screen-rectangle surface and optional Web Audio frequency sampling.

```ts
import {Video} from 'margoengine/video';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const videoElement = document.querySelector('video')!;
const audioContext = new AudioContext();
const surface = Video.attach(engine, videoElement, {rect: [0.1,0.1,0.8,0.8], audio: audioContext});
const bins = surface.sampleFrequency();
```

import(device) is also available for custom renderers; external textures are imported per render task and must not be retained across HTML-video tasks. Incomplete frames return null. Frequencies reuse a Uint8Array, fftSize defaults to 2048, and onFrequency receives that same buffer. Caller owns playback, VideoFrame.close and AudioContext.close; disposal only disconnects this package's audio branch. Media sources require same-origin/CORS permission, and playback/audio resume require appropriate browser user gestures. The surface is screen-space, not a new core material slot.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Multiple overlays for one media element share its AudioContext source and one audible route. Each overlay owns only its analysis branch; removing the last audio-enabled overlay disconnects the shared destination route without closing the caller's context.

Build and unit tests: npm test --workspace @margoengine/video

## External video on mesh materials

`videoMaterial` from `margoengine/video/material` (or `@margoengine/video/material`) is a
`Material.features` entry. It multiplies the material's base colour and alpha by an external
video sample, decoded from sRGB to linear before lighting. Standard, physical, unlit, Lambert,
Phong, toon, normal, depth, distance and matcap mesh materials keep their existing shading.
An existing `map` still works as a second multiplier; leave that map unset to avoid its own uploads.

This example makes a video frame locally, with no media download:

```ts
import {Engine} from 'margoengine/core';
import {UnlitMaterial, createMesh} from 'margoengine/materials';
import {videoMaterial} from 'margoengine/video/material';

const pixels = new OffscreenCanvas(8, 8);
const drawing = pixels.getContext('2d')!;
drawing.fillStyle = '#804020';
drawing.fillRect(0, 0, 8, 8);
const frame = new VideoFrame(pixels, {timestamp: 0});
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const material = new UnlitMaterial({features: [videoMaterial(frame)]});
const mesh = createMesh(engine, {
  positions: [-1,-1,0, 1,-1,0, 1,1,0, -1,1,0],
  normals: [0,0,1, 0,0,1, 0,0,1, 0,0,1],
  uvs: [0,0, 1,0, 1,1, 0,1], indices: [0,1,2, 0,2,3],
}, material);
engine.stop();
engine.render({delta: 0});
await engine.gpu!.queue.onSubmittedWorkDone();
mesh.dispose();
material.dispose();
engine.dispose();
frame.close();
```

For playback, pass a ready `HTMLVideoElement` instead of `frame`, after `loadeddata` and
`play()` have completed. Each draw calls `importExternalTexture` in that drawing task; no
expired HTML-video texture is retained between tasks. Each device shares one filtering
sampler for the feature. `texCoord` defaults to `0`; set `1` for UV1. `flipY` defaults to
`true`, matching `Texture`'s image orientation (row zero at v=1); set `false` for row zero
at v=0. Sampling clamps to the image edge, with no mipmaps and no repeat wrap. Source playback, CORS and
`VideoFrame.close()` remain the caller's responsibility. A pending/closed source throws
`MargoError` code `state`. WebGL2 throws `unsupported` with a help link when binding the
feature; use a WebGPU engine. Custom shaders must retain the standard mesh surface hook.
Core's compact material has no feature slot; this entry targets `@margoengine/materials`.

There is no JS-side frame copy. A browser/driver may still copy or convert internally, as
the WebGPU specification permits; no platform zero-copy or speed claim is made. External
textures consume four sampled-texture limit slots and an implicit sampler/uniform, so a
material close to the device's binding limits may exceed them.

GPU checks: `node scripts/gpu-lock.mjs run --owner=video-check -- node packages/video/test/material-check.mjs`.
The check uses generated colour frames and a generated canvas video stream on a real GPU;
these stand in for decoded movie files. Codec files and other GPUs are not covered by this entry's check.

## Canvas recording with audio

`recordCanvas` from `margoengine/video/record` (or `@margoengine/video/record`) records a
page canvas in real time using MediaRecorder. WebGPU, WebGL2 and 2D canvases use the same
capture API. This example records one second of a generated canvas and tone:

```ts
import {recordCanvas} from 'margoengine/video/record';

const canvas = document.createElement('canvas');
canvas.width = canvas.height = 64;
document.body.append(canvas);
const drawing = canvas.getContext('2d')!;
drawing.fillStyle = '#336699';
drawing.fillRect(0, 0, 64, 64);
const audio = new AudioContext();
const destination = audio.createMediaStreamDestination();
const tone = audio.createOscillator();
tone.connect(destination);
tone.start();
await audio.resume(); // Run from a user gesture on pages that restrict audio playback.
const recording = recordCanvas(canvas, {audio: destination.stream, format: 'webm'});
// Media time: let one second of picture and sound reach the recorder.
await new Promise<void>(resolve => setTimeout(resolve, 1000));
const file = await recording.stop(); // Blob, ready for URL.createObjectURL(file) or saving.
console.log(file.type, file.size);
tone.stop();
destination.stream.getTracks().forEach(track => track.stop());
await audio.close();
canvas.remove();
```

`format` defaults to `'webm'`; `'mp4'` requests MP4. Codecs depend on the browser;
an unavailable container throws `MargoError` code `unsupported` with a help link before
capture starts. `fps` defaults to 30 and must be finite and positive. Optional
`videoBitsPerSecond` and `audioBitsPerSecond` are positive integer bitrate hints;
unset leaves the browser's defaults. `audio` defaults to none and takes a MediaStream
of live audio tracks, for example a microphone stream or Web Audio destination.
Each audio track is cloned and only the clones and captured video tracks are stopped.
Mix several sounds into one Web Audio destination for reliable single-track output.

The canvas must be origin-clean. Keep rendering normally during capture. `stop()` and
`result` share one `Promise<Blob>`, resolved after the final chunk; repeated stops are
safe. The optional `signal` aborts and discards the file; `dispose()` and `Symbol.dispose`
discard an unfinished recording. The complete compressed recording stays in memory.
There is no duration, frame-count, codec, audio-mixing or cross-player compatibility
guarantee: this is real-time capture, so overloaded or background pages can drop frames.
Use exporters/capture or headless/video for deterministic offline frame sequences.
Audio permission and user gestures remain the page's responsibility. Neither Node nor
OffscreenCanvas has this page capture API. The GPU check records generated colour and
tone stand-ins, decodes both WebM and MP4 through Edge on WebGPU and WebGL2, checks picture
and sound, and confirms cancellation. Other players and browsers are unmeasured.

## 360 and stereo video

`video360Material` from `margoengine/video/360` maps equirectangular video onto the inside
of `sphereGeometry`. The image centre faces -Z, its right quarter +X, and its top +Y.
Use a camera inside the sphere and an unlit material with `side: 'back'`:

```ts
import {Engine} from 'margoengine/core';
import {sphereGeometry} from 'margoengine/geometry';
import {UnlitMaterial, createMesh} from 'margoengine/materials';
import {video360Material} from 'margoengine/video/360';

const art = new OffscreenCanvas(128, 64);
const paint = art.getContext('2d')!;
paint.fillStyle = '#336699';
paint.fillRect(0, 0, 128, 64);
const frame = new VideoFrame(art, {timestamp: 0});
const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu', camera: {position: [0,0,0], target: [0,0,-1]},
});
const material = new UnlitMaterial({side: 'back', features: [video360Material(frame)]});
const sphere = createMesh(engine, sphereGeometry(10, 64, 32), material);
engine.stop();
engine.render({delta: 0});
await engine.gpu!.queue.onSubmittedWorkDone();
sphere.dispose();
material.dispose();
engine.dispose();
frame.close();
```

Pass a ready, playing HTMLVideoElement for a movie. `layout` defaults to `'mono'`,
usually a 2:1 image. `'stereo-left-right'` holds two complete panoramas side by side,
usually 4:1 overall. `eye` selects `'left'` (default) or `'right'` on screen; make a
material for each eye for separate screen views. A stereo source must be at least
two pixels wide. Each eye clamps half a texel inside
its rectangle, preventing filtering from the adjacent eye. There are no mipmaps or
repeat wrapping. Camera position should match the sphere centre. The feature occupies
the same video slot as `videoMaterial`; choose one per material. It uses UV0 and the
UV convention of `sphereGeometry`, not an arbitrary sphere's authored UVs. WebGL2
binding throws coded `unsupported` with a help link. Source ownership and colour
conversion follow `videoMaterial`.

In XR, `video360Layer(layers, video, {layout: 'stereo-left-right', radius: 0})` reuses
an existing `XRLayers` instance from `margoengine/xr/layers`. Attach it after requesting
an XR session with `optionalFeatures: ['layers']`. This calls the existing native
XRMediaBinding equirectangular layer path; the compositor selects each eye, without
an extra mesh or frame upload. `layout` defaults to `'mono'` and `radius` to 0 (infinity);
a finite positive radius is in metres. Dispose the returned XRPanel to remove it.
The caller owns playback, origin permission and the session. Missing native layers
support propagates the existing XR `unsupported` error. This XR route is not a WebGL2
mesh fallback. The WebXR Layers API is a draft. A stand-in session/binding proves
delegation, packing and disposal; no headset has been run. Generated panorama colours
prove the screen sphere axes and both eyes on RTX A6000/Edge; real movie files, headset
projection, other browsers/GPUs and speed remain unmeasured.

## Frame-accurate seek and step

`openVideo` from `margoengine/video/codecs` (or `@margoengine/video/codecs`) reads a
complete, nonfragmented AVC/H.264 MP4 and decodes with WebCodecs. It includes its own
sample-table demuxer. This example generates a small MP4 with the existing headless
encoder; pass a URL, Blob or ArrayBuffer for an existing movie:

```ts
import {encodeVideo} from 'margoengine/headless/video';
import {openVideo} from 'margoengine/video/codecs';

const data = new Uint8Array(64 * 64 * 4);
for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
const file = await encodeVideo(
  Array.from({length: 4}, () => ({width: 64, height: 64, data})),
  {format: 'mp4', codec: 'avc1.42001e', fps: 10},
);
using video = await openVideo(new Blob([file.bytes]));
const frame = await video.seek(0.2);
console.log(video.currentFrame, video.timestamp(video.currentFrame)); // 2, 0.2 seconds
// A VideoFrame can feed videoMaterial, drawImage, or a custom renderer.
frame.close();
const next = await video.step(); // Frame 3 in presentation order.
next.close();
```

`frame(index)` selects an exact zero-based presentation index. `timestamp(index)` returns
its movie time in seconds; the returned VideoFrame retains its original media timestamp
in integer microseconds. `seek(seconds)` selects the last frame at or before a finite
time, clamped to the ends. `step(delta = 1)` moves by a signed integer frame count,
clamped to the ends; the initial `currentFrame` is -1, so the first `step()` returns 0.
`frameCount` counts visible frames after edits, and `duration` is movie time in seconds.
No wall clock, HTML video seeking or guessed constant frame rate is used. Reordered
samples and variable sample durations use their composition timestamps. Movie times
are rounded to WebCodecs' microsecond precision; colliding timestamps are refused.

Each request decodes from the preceding sync sample through the end of that GOP,
flushes delayed outputs and selects the exact timestamp, closing all other frames.
The caller must close every returned frame after its consumers finish. Requests are
exclusive: await a request before another seek/step; concurrency rejects with code
`state`. A request's optional `{signal}` cancels that request without closing the video.
The signal passed to `openVideo` controls fetching and the whole opened video's lifetime.
`dispose()`/`Symbol.dispose` cancels pending decoding and releases buffered compressed
bytes; previously returned frames remain caller-owned. Blob reading and codec support
probing finish before cancellation is observed; fetch and active decoding are cancelled.

Supported MP4 tables: `stsd/avc1/avcC`, `stsz`, `stsc`, `stco/co64`, `stts`, signed or
unsigned `ctts`, optional `stss`, and one rate-1 `elst` media edit optionally preceded
by an empty edit (versions 0 and 1). The first video track is selected; audio is ignored.
Empty lead-in seeks clamp to the first visible frame. Self-contained, unencrypted media
with one AVC sample description is required. Fragmented MP4, WebM, other codecs,
external data references, arbitrary edit sequences, rotation/display transforms and
audio synchronization are outside this entry. Unsupported structures or codecs receive
a coded error with help link; malformed tables fail before decoding. Browser support
for an AVC profile is checked, never assumed.

The whole file, sample index and one request's GOP are buffered; large files or long
GOPs can use substantial memory and CPU. This is an editor/sync primitive, not a
streaming player or scheduler. WebCodecs requires a secure browser context. Decoding
is renderer independent and also runs beside WebGL2; the separate external-texture
material still requires WebGPU. Node and browsers without VideoDecoder receive coded
`unsupported`. Generated MP4 colours prove random seeks, stepping, exact timestamps,
cancellation and WebGPU material integration on RTX A6000/Edge. Reordered samples,
chunk layouts and ownership also use unit stand-ins. The outside CC0 MDN flower clip
(150 AVC High frames, two GOPs, B-frame reorder depth 2) passes every edited timestamp
and every decoded-frame byte against an independent FFprobe demux plus WebCodecs
reference on RTX A6000/Edge. This tests our demux and frame access with the same
browser decoder, not cross-decoder accuracy. Other browsers/GPUs and speed are unmeasured.

Edit bounds are compared in native time bases, before timestamp rounding. Movie
timestamps are rounded once to microseconds; decode timestamp collisions also fail.
Fetch the required outside clip with node scripts/reference-rendering/fetch-skip-assets.mjs
before npm run test:gpu --workspace @margoengine/video. To regenerate its independent
sample-table oracle, run node packages/video/scripts/flower-reference.mjs with the path
to FFprobe 8.1.2 as its first argument. No movie bytes or FFprobe binary ship in Margo.

## Stacked alpha and chroma key

`stackedAlphaMaterial` and `chromaKeyMaterial` from `margoengine/video/alpha` (or
`@margoengine/video/alpha`) reuse the external-texture material path. Each returns a
`Material.features` entry. Use `transparent: true` for soft alpha, or an `alphaTest`
for cutouts. This example creates both kinds of source locally:

```ts
import {Engine} from 'margoengine/core';
import {UnlitMaterial, createMesh} from 'margoengine/materials';
import {stackedAlphaMaterial, chromaKeyMaterial} from 'margoengine/video/alpha';

const art = new OffscreenCanvas(32, 64);
const paint = art.getContext('2d')!;
paint.fillStyle = 'red';
paint.fillRect(0, 0, 32, 32); // Straight colour in the top half.
paint.fillStyle = '#808080';
paint.fillRect(0, 32, 32, 32); // Raw 128/255 alpha in the bottom half.
const packed = new VideoFrame(art, {timestamp: 0});
const screen = new OffscreenCanvas(32, 32);
const drawing = screen.getContext('2d')!;
drawing.fillStyle = 'lime';
drawing.fillRect(0, 0, 32, 32);
drawing.fillStyle = 'red';
drawing.fillRect(8, 8, 16, 16);
const keyed = new VideoFrame(screen, {timestamp: 0});
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const material = new UnlitMaterial({transparent: true, features: [stackedAlphaMaterial(packed)]});
const mesh = createMesh(engine, {
  positions: [-1,-1,0, 1,-1,0, 1,1,0, -1,1,0],
  normals: [0,0,1, 0,0,1, 0,0,1, 0,0,1],
  uvs: [0,0, 1,0, 1,1, 0,1], indices: [0,1,2, 0,2,3],
}, material);
engine.stop();
engine.render({delta: 0});
await engine.gpu!.queue.onSubmittedWorkDone();
material.features = [chromaKeyMaterial(keyed)]; // Default green key, soft edge.
engine.render({delta: 0});
await engine.gpu!.queue.onSubmittedWorkDone();
mesh.dispose();
material.dispose();
engine.dispose();
packed.close();
keyed.close();
```

For movies, pass a ready playing HTMLVideoElement instead of a generated frame.
Stacked packing defaults to `layout: 'top-bottom'`: colour above, grayscale mask below.
`'left-right'` means colour left, mask right. Both halves must have equal integer pixel
dimensions; an odd or one-pixel packed dimension is rejected before binding. Sampling
clamps half a texel inside each half, preventing filtering across the seam. The mask's
red channel is a raw 0..1 opacity, with no sRGB-to-linear conversion; author grayscale
mask values accordingly. Colour must be straight/unassociated, not premultiplied by
the mask. The source's own alpha is also multiplied.

Chroma key compares the sampled sRGB RGB to `color` (default `[0,1,0]`, channels 0..1)
with Euclidean distance. Alpha is zero through `threshold` (default 0.15), then follows
`smoothstep` to full alpha at `threshold + softness` (`softness` defaults to 0.1).
Threshold is 0..sqrt(3); softness is positive, at most sqrt(3), and must make distinct
float32 edge values. Parameters are fixed when creating a feature; replace it to change
them. This is RGB keying, without despill, lighting adaptation, hair reconstruction or
foreground colour recovery. Colours close to the key disappear even if they belong to
the subject; compression or key-colour spill can leave fringes.

Both modes inherit `texCoord: 0` and `flipY: true` from `videoMaterial`. Alpha multiplies
the existing material/vertex/map alpha before its colour-pass alpha test and blending.
Lighting still uses linear colour. The engine's direct canvas material path encodes
sRGB before output-space blending; these features preserve that behavior. Auxiliary
shadow/picking passes retain their existing material alpha inputs and do not sample
this external mask. Choose one external video feature per material, including panorama
or ordinary video. Playback, frame lifetime, origin access, sampling limits and WebGPU
requirements follow `videoMaterial`; WebGL2 receives coded `unsupported` with a help link.
Generated colour/mask stand-ins prove both packings, raw mask alpha, fractional key
coverage and cutouts on RTX A6000/Edge. No real transparent/keyed movie, other adapter,
browser, keying quality comparison or speed measurement is claimed.

## Preview tier contract

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.
