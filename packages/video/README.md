# @margoengine/video

WebGPU external video textures from HTMLVideoElement or VideoFrame, imported with `importExternalTexture` (no JS-side copy; whether the browser copies depends on the platform), with a screen-rectangle surface and optional Web Audio frequency sampling.

```ts
import {Video} from '@margoengine/video';
const surface = Video.attach(engine, videoElement, {rect: [0.1,0.1,0.8,0.8], audio: audioContext});
const bins = surface.sampleFrequency();
```

import(device) is also available for custom renderers; external textures are imported per render task and must not be retained across HTML-video tasks. Incomplete frames return null. Frequencies reuse a Uint8Array, fftSize defaults to 2048, and onFrequency receives that same buffer. Caller owns playback, VideoFrame.close and AudioContext.close; disposal only disconnects this package's audio branch. Media sources require same-origin/CORS permission, and playback/audio resume require appropriate browser user gestures. The surface is screen-space, not a new core material slot.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Multiple overlays for one media element share its AudioContext source and one audible route. Each overlay owns only its analysis branch; removing the last audio-enabled overlay disconnects the shared destination route without closing the caller's context.

Build and unit tests: npm test --workspace @margoengine/video

