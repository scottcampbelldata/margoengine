# @margoengine/audio

Web Audio listener, global and positional sounds and a frequency analyser for Margo Engine. Replaces THREE.AudioListener, THREE.Audio, THREE.PositionalAudio, THREE.AudioAnalyser and THREE.AudioLoader.

Build from source with `npm run build` in `packages/audio`.

```ts
import {AudioListener, Audio, PositionalAudio, AudioAnalyser} from '@margoengine/audio';

const listener = new AudioListener({volume: 0.8});
engine.use(listener); // follows engine.camera every frame; resumes on the first click or key press

const engineSound = new PositionalAudio(listener, {
  mesh: truck, refDistance: 2, distanceModel: 'inverse', rolloffFactor: 1.2,
  coneInnerAngle: 90, coneOuterAngle: 220, coneOuterGain: 0.3, muteWhenHidden: true,
});
engineSound.setBuffer(await listener.load('/sounds/engine.ogg'));
engineSound.loop = true;
engineSound.fadeIn(0.5);

const music = new Audio(listener, {volume: 0.4});
music.setMediaElementSource(document.querySelector('audio')).play();

const analyser = new AudioAnalyser(music, 1024);
engine.onFrame(() => meter.style.width = `${analyser.getAverageFrequency() / 2.55}%`);

// On teardown (engine.dispose() does this too):
engine.removePlugin(listener.name);
```

## How it works

- **Lazy context.** Nothing touches `AudioContext`, `window` or `document` at import time. The listener creates its `AudioContext` the first time `listener.context` is read (normally when the first sound is created), or uses the context you pass, for example an `OfflineAudioContext`. A context the listener created is closed on dispose; a context you passed is left open.
- **Listener follows the camera.** As an engine plugin the listener adds a frame pass (order 900) that runs after the camera and world matrices are updated. It writes the listener position, forward (camera position toward target) and Y up, and skips the write when nothing changed. `setPose` sets the pose by hand when you do not use an engine.
- **Autoplay.** With `autoResume` (default) the listener resumes a suspended context on the first `pointerdown`, `mousedown`, `keydown` or `touchend` anywhere in the window, then removes its listeners. `suspend()` and `resume()` are there for explicit control.
- **Graph.** `source -> filters -> fade gain -> volume gain -> [PannerNode] -> master gain -> destination`. Fades have their own gain stage, so `fadeIn`/`fadeOut` never fight with `volume`, and hidden-mesh muting rides on the volume stage.
- **No clicks.** Volume, master volume, playback rate, detune, listener pose and panner pose move with `setTargetAtTime` (time constant `smoothing`, default 20 ms) on a running context. The first write, and every write on a suspended or offline context, is set immediately, so a sound never sweeps in from the origin.
- **Positional audio.** The panner reads its mesh's world matrix from `engineRuntime(engine).store.matrices` each frame: translation for position, the mesh's local `direction` axis (default +Z, like THREE.Object3D.getWorldDirection) for the cone. A disposed mesh keeps the last pose. With `muteWhenHidden` the sound fades out while the mesh or any ancestor is hidden.
- **Sources.** `setBuffer` (decoded files), `setMediaElementSource` (`<audio>`/`<video>`, one node per element and context, reused), `setMediaStreamSource` (microphone, WebRTC) and `setNodeSource` (oscillators, constant sources, worklets). Buffer sources keep a playhead across `pause`/`play`, including playback-rate changes and loop regions.
- **Loading.** `loadAudioBuffer(context, url, {signal})` and `listener.load` share one download and one decoded buffer per context and URL. An aborted caller rejects with an `AbortError`; the download is cancelled once every waiting caller aborted. Failed loads are not cached.

## API

| Export | Purpose |
| --- | --- |
| `AudioListener` | Engine plugin: lazy context, master gain (`input`, `volume`), `suspend`/`resume`, auto-resume, `load`, `setPose`, `update` |
| `Audio` | Non-positional sound: `setBuffer`, `setMediaElementSource`, `setMediaStreamSource`, `setNodeSource`, `play(delay)`, `pause`, `stop(delay)`, `fadeIn`, `fadeOut`, `setFilters`, `loop`, `loopStart`, `loopEnd`, `playbackRate`, `detune`, `offset`, `duration`, `volume`, `currentTime`, `onEnded`, `getOutput` |
| `PositionalAudio` | `Audio` plus a PannerNode: `attach(mesh)`, `setPosition`, `setDirection`, `setDirectionalCone`, `panningModel`, `distanceModel`, `refDistance`, `maxDistance`, `rolloffFactor`, `muteWhenHidden` |
| `AudioAnalyser` | `getFrequencyData`, `getFloatFrequencyData`, `getWaveformData`, `getFloatWaveformData`, `getAverageFrequency`, `getDominantFrequency` |
| `loadAudioBuffer`, `clearAudioBufferCache`, `decodeAudio` | Cached fetch and decode with `AbortSignal` |
| `distanceGain`, `coneGain` | The PannerNode distance and cone formulas, for meters and tests |
| `smoothParam` | The click-free AudioParam setter the package uses |

## Options

| Option | Applies to | Default |
| --- | --- | --- |
| `context` | listener | `new AudioContext()` on first use; pass a context or a factory |
| `volume` | listener, sounds | 1 |
| `autoResume` | listener | true |
| `smoothing` | listener (used by its sounds) | 0.02 s; 0 sets values immediately |
| `loop`, `loopStart`, `loopEnd` | sounds | false, 0, 0 (end of buffer) |
| `playbackRate`, `detune` | sounds | 1, 0 cents |
| `offset`, `duration` | sounds (buffers) | 0, whole buffer (ignored while looping) |
| `autoplay`, `filters`, `onEnded` | sounds | false, none, none |
| `panningModel` | positional | `'HRTF'` (or `'equalpower'`) |
| `distanceModel` | positional | `'inverse'` (or `'linear'`, `'exponential'`) |
| `refDistance`, `maxDistance`, `rolloffFactor` | positional | 1, 10000, 1 |
| `coneInnerAngle`, `coneOuterAngle`, `coneOuterGain` | positional | 360, 360, 0 |
| `mesh`, `direction`, `muteWhenHidden` | positional | none, +Z, false |

## Limits

- `fadeOut` on a buffer source schedules the stop on the audio clock and marks the sound stopped right away; media, stream and node sources stop through a timer.
- `stream` and `node` sources are gated by connecting and disconnecting them; starting an oscillator or constant source is up to you.
- The listener reads the camera, not a separate audio transform; for a listener elsewhere, skip `engine.use` and call `setPose` yourself.
- Browsers without `AudioListener.positionX` (older Firefox) fall back to `setPosition`/`setOrientation`, which cannot be smoothed.

## Tests

`npm test` in `packages/audio` runs 20 Node checks against a small fake Web Audio implementation: no context at import, lazy creation, camera following, first-write-immediate then smoothed automation, auto-resume, graph wiring with filters and panner, playhead math for pause, playback rate, offset, duration and loop regions, `onEnded` only on a natural end, fade ramps, mesh following and hidden-mesh muting, media, stream and node sources, analyser math, the distance and cone formulas, loader caching, abort and failure handling, and dispose. `npm run test:browser` renders with `OfflineAudioContext` in Chromium: a source on the right is louder in the right channel (HRTF and equal-power), linear, inverse and exponential attenuation match the formulas within 2%, the cone drops to `coneOuterGain` behind the source, the analyser finds a 1 kHz tone, loop points, offset and duration pick the right samples and fadeIn ramps linearly. A live WebGPU engine check confirms the listener follows the camera, the panner follows its mesh, hidden meshes go silent, a decoded WAV is cached, a media element reports `onEnded`, there are no WebGPU validation errors, and a real click resumes a suspended context. The script adds `--autoplay-policy=no-user-gesture-required`.

MIT licensed.
