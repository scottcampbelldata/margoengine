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

