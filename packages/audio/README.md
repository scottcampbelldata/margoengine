# @margoengine/audio

Import `margoengine/audio` from the `margoengine` package, or `@margoengine/audio` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Web Audio listener, global and positional sounds, encoded-file loading and a frequency analyser for Margo Engine.

Build from source with `npm run build` in `packages/audio`.

```ts
import {AudioListener, Audio, PositionalAudio, AudioVoicePool, AudioAnalyser} from 'margoengine/audio';

const listener = AudioListener.attach(engine, {volume: 0.8}); // follows engine.camera every frame; resumes on the first click or key press

const engineSound = new PositionalAudio(listener, {
  mesh: truck, refDistance: 2, distanceModel: 'inverse', rolloffFactor: 1.2,
  coneInnerAngle: 90, coneOuterAngle: 220, coneOuterGain: 0.3, muteWhenHidden: true,
});
engineSound.setBuffer(await listener.load('/sounds/engine.ogg'));
engineSound.loop = true;
engineSound.fadeIn(0.5);

const music = new Audio(listener, {volume: 0.4});
music.setMediaElementSource(document.querySelector('audio')).play();

// A sound on an editor timeline: starts at timeline second 4, follows play, pause, scrubbing and timeline speed.
const cue = new Audio(listener, {volume: 0.6, loop: false, timelineStart: 4});
cue.setBuffer(await listener.load('/sounds/cue.ogg'));
engine.onFrame(() => cue.sync(timeline.seconds, timeline.playing, timeline.speed));

// Footsteps and block sounds: 6 voices share one buffer; a 7th overlapping play steals the oldest voice.
const steps = new AudioVoicePool(listener, await listener.load('/sounds/step.ogg'), {voices: 6, refDistance: 2});
steps.play([x, y, z], {volume: 0.7, playbackRate: 0.9 + Math.random() * 0.2});

const analyser = new AudioAnalyser(music, 1024);
engine.onFrame(() => meter.style.width = `${analyser.getAverageFrequency() / 2.55}%`);

// On teardown (engine.dispose() does this too):
engine.removePlugin(listener.name);
```

## Cancel a load, and clean up with `using`

```ts
import {AudioListener, Audio} from 'margoengine/audio';

using listener = new AudioListener({volume: 0.8}); // disposed at the end of the block
const buffer = await listener.load('/sounds/step.ogg', {signal: AbortSignal.timeout(10_000)}); // rejects with an AbortError
using step = new Audio(listener).setBuffer(buffer);
step.play();
```

Errors carry a stable `code` (`error.code`): `disposed` for a sound used after `dispose()`, `state` for `play()` before a source is set, `unsupported` when Web Audio or `fetch` is missing, `failed` for an HTTP or decoding failure. Each message says what to do.

## How it works

- **Lazy context.** Nothing touches `AudioContext`, `window` or `document` at import time. The listener creates its `AudioContext` the first time `listener.context` is read (normally when the first sound is created), or uses the context you pass, for example an `OfflineAudioContext`. A context the listener created is closed on dispose; a context you passed is left open.
- **Listener follows the camera.** As an engine plugin the listener adds a frame pass (order 900) that runs after the camera and world matrices are updated. It writes the listener position, forward (camera position toward target) and Y up, and skips the write when nothing changed. `listener.follow(mesh, forward = [0, 0, 1])` puts the ears on a mesh instead, such as a third-person character: its world position, its local `forward` axis (glTF characters face +Z) and local +Y as up, read from the engine's world matrices each frame (a disposed mesh keeps the last pose). `follow('camera')` goes back; `follow(null)` stops following so only `setPose` moves the listener. `setPose` also sets the pose by hand when you do not use an engine.
- **Autoplay.** With `autoResume` (default) the listener resumes a suspended context on the first `pointerdown`, `mousedown`, `keydown` or `touchend` anywhere in the window, then removes its listeners. `suspend()` and `resume()` are there for explicit control.
- **Graph.** `source -> filters -> fade gain -> volume gain -> [PannerNode] -> master gain -> destination`. Fades have their own gain stage, so `fadeIn`/`fadeOut` never fight with `volume`, and hidden-mesh muting rides on the volume stage.
- **No clicks.** Volume, master volume, playback rate, detune, listener pose and panner pose move with `setTargetAtTime` (time constant `smoothing`, default 20 ms) on a running context. The first write, and every write on a suspended or offline context, is set immediately, so a sound never sweeps in from the origin.
- **Positional audio.** The panner reads its mesh's world matrix from `engineRuntime(engine).store.matrices` each frame: translation for position, the mesh's local `direction` axis (default +Z) for the cone. A disposed mesh keeps the last pose. With `muteWhenHidden` the sound fades out while the mesh or any ancestor is hidden.
- **Sources.** `setBuffer` (decoded files), `setMediaElementSource` (`<audio>`/`<video>`, one node per element and context, reused), `setMediaStreamSource` (microphone, WebRTC) and `setNodeSource` (oscillators, constant sources, worklets). Buffer sources keep a playhead across `pause`/`play`, including playback-rate changes and loop regions. `seek(seconds)` moves it whether playing, paused or stopped: a playing buffer restarts on one new source node (the old one is stopped and disconnected first, so they never overlap); looping wraps into the loop region; past the end of a non-looping buffer it clamps to the end and a playing sound ends (`onEnded` fires). Media elements seek through `currentTime`.
- **Timeline sync.** `sync(timelineSeconds, playing, rate = 1)`, called every frame with the editor's own clock, makes a buffer sound follow a timeline instead of the audio clock: silent before `timelineStart`, then at buffer position `offset + timelineSeconds - timelineStart` wrapped by the loop region, silent past the end of a non-looping sound. While playing it re-seeks only when the sound drifts more than `Audio.syncTolerance` (50 ms) from the timeline, so steady playback is never chopped and a seam crossing in a loop does not count as drift. With `playing` false (paused, scrubbing) it moves the playhead silently. `rate` is the timeline speed and sets `playbackRate`.
- **Voice pools.** `new AudioVoicePool(listener, buffer, {voices = 8, ...positional options})` makes `voices` positional sounds that share one decoded buffer, for sounds that overlap: footsteps, block breaks, hits. `play(position, {volume, playbackRate})` takes a voice that is not sounding, or when all are sounding steals the one that started longest ago (it is cut off at once); the play's `volume` and `playbackRate` (pitch variation) default to the pool's options, and a voice jumps to its new position and level instead of easing there. `play` returns the voice. `stopAll()` stops every voice; `dispose()` disposes them (the buffer stays usable).
- **Loading.** `loadAudioBuffer(context, url, {signal})` and `listener.load` share one download and one decoded buffer per context and URL. An aborted caller rejects with an `AbortError`; the download is cancelled once every waiting caller aborted. Failed loads are not cached.

## API

| Export | Purpose |
| --- | --- |
| `AudioListener` | Engine plugin: lazy context, master gain (`input`, `volume`), `suspend`/`resume`, auto-resume, `load`, `follow` (camera, a mesh or nothing), `setPose`, `update` |
| `Audio` | Non-positional sound: `setBuffer`, `setMediaElementSource`, `setMediaStreamSource`, `setNodeSource`, `play(delay)`, `pause`, `stop(delay)`, `seek(seconds)`, `sync(timelineSeconds, playing, rate)`, `fadeIn`, `fadeOut`, `setFilters`, `loop`, `loopStart`, `loopEnd`, `playbackRate`, `detune`, `offset`, `duration`, `timelineStart`, `volume`, `currentTime`, `onEnded`, `getOutput`; static `syncTolerance` |
| `PositionalAudio` | `Audio` plus a PannerNode: `attach(mesh)`, `setPosition`, `setDirection`, `setDirectionalCone`, `panningModel`, `distanceModel`, `refDistance`, `maxDistance`, `rolloffFactor`, `muteWhenHidden` |
| `AudioVoicePool` | `voices` positional sounds on one buffer: `play(position, {volume, playbackRate})` (free voice, else steals the oldest), `stopAll`, `dispose`, `voices` |
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
| `timelineStart` | sounds (buffers, with `sync`) | 0 s |
| `autoplay`, `filters`, `onEnded` | sounds | false, none, none |
| `panningModel` | positional | `'HRTF'` (or `'equalpower'`) |
| `distanceModel` | positional | `'inverse'` (or `'linear'`, `'exponential'`) |
| `refDistance`, `maxDistance`, `rolloffFactor` | positional | 1, 10000, 1 |
| `coneInnerAngle`, `coneOuterAngle`, `coneOuterGain` | positional | 360, 360, 0 |
| `mesh`, `direction`, `muteWhenHidden` | positional | none, +Z, false |
| `voices` | voice pool (which takes the positional options except `mesh`, `autoplay` and `filters`) | 8 |

## Limits

- `fadeOut` on a buffer source schedules the stop on the audio clock and marks the sound stopped right away; media, stream and node sources stop through a timer.
- `stream` and `node` sources are gated by connecting and disconnecting them; starting an oscillator or constant source is up to you.
- The listener follows the camera or one mesh (`follow`); for anything else, `follow(null)` and call `setPose` yourself.
- `sync` is silent at a zero or negative (reverse) timeline rate: Web Audio cannot play a buffer backwards. It drives buffer sources only (it does nothing before `setBuffer`) and owns `play`, `pause` and `playbackRate` while you call it. A clip that ended on its own is not restarted within the last `syncTolerance` of its end.
- Browsers without `AudioListener.positionX` (older Firefox) fall back to `setPosition`/`setOrientation`, which cannot be smoothed.

## Tests

`npm test` in `packages/audio` runs Node checks against a small fake Web Audio implementation: no context at import, lazy creation, camera following, mesh following with a local forward axis, first-write-immediate then smoothed automation, auto-resume, graph wiring with filters and panner, playhead math for pause, playback rate, offset, duration and loop regions, `seek` while playing (exactly one new source at the new offset), paused or stopped, `sync` (silent before `timelineStart`, no re-seek under the drift tolerance, one re-seek over it, silent scrubbing, loop wrapping without re-seeking at the seam, reverse is silent, sources released after many seeks), `onEnded` only on a natural end, fade ramps, mesh following and hidden-mesh muting, media, stream and node sources, analyser math, the distance and cone formulas, loader caching, abort and failure handling, dispose, and voice pools (overlapping plays on separate voices sharing the buffer, positions and per-play volume and rate applied at once, the oldest voice stolen, an ended voice reused first, `stopAll`, release on dispose). `npm run test:browser` (a browser script, not in CI) renders with `OfflineAudioContext` in Chromium: a source on the right is louder in the right channel (HRTF and equal-power), linear, inverse and exponential attenuation match the formulas within 2%, the cone drops to `coneOuterGain` behind the source, the analyser finds a 1 kHz tone, loop points, offset and duration pick the right samples, a seek while playing reads on from the new position on one source (and past the end ends it), fadeIn ramps linearly, and a voice pool plays two overlapping sounds at their own positions and volumes, steals its only voice for a second play and halves the length at playbackRate 2. A live WebGPU engine check confirms the listener follows the camera, the panner follows its mesh, hidden meshes go silent, a decoded WAV is cached, a media element reports `onEnded`, there are no WebGPU validation errors, and a real click resumes a suspended context. The script adds `--autoplay-policy=no-user-gesture-required`.

Apache-2.0 licensed.
