# @margoengine/audio

Web Audio listener, global and positional sounds and a frequency analyser for Margo Engine.

Pose writes read the three stored vector components directly. They preserve the existing parameter scheduling,
smoothing and clock-read order. This removes vector-iterator work; it does not establish a measured speedup.
For a self-contained offline example with no audio device or user gesture:

```ts
import {AudioListener, PositionalAudio} from '@margoengine/audio';

const context = new OfflineAudioContext(2, 4800, 48000);
const listener = new AudioListener({context, autoResume: false, smoothing: 0});
const sound = new PositionalAudio(listener);
const oscillator = context.createOscillator();
sound.setNodeSource(oscillator);
sound.setPosition(1, 0, -2).setDirection([0, 0, 1]);
oscillator.start();
const rendered = await context.startRendering();
console.assert(rendered.length === 4800 && rendered.numberOfChannels === 2);
listener.dispose();
```

Import `margoengine/audio` from the `margoengine` package, or `@margoengine/audio` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Web Audio listener, global and positional sounds, encoded-file loading and a frequency analyser for Margo Engine.

Build from source with `npm run build` in `packages/audio`.

For the loading examples, serve `tests/fixtures/rain-foa.wav` at `/sounds/rain-foa.wav` (CC BY 4.0, attribution in `tests/fixtures/NOTICE.md`). Replace this shared sample with your app's engine, cue and step recordings.

```ts
import {AudioListener, Audio, PositionalAudio, AudioVoicePool, AudioAnalyser} from 'margoengine/audio';
import {Engine} from 'margoengine/core';
import {createMesh} from 'margoengine/materials';
import {box} from 'margoengine/core';
const timeline = {seconds: 0, playing: true, speed: 1};
const meter = document.createElement('div');
const x = 0;
const y = 0;
const z = 0;
const engine = await Engine.create(document.querySelector('canvas')!);
const truck = engine.createMesh().setGeometry(box());

const listener = AudioListener.attach(engine, {volume: 0.8}); // follows engine.camera every frame; resumes on the first click or key press

const engineSound = new PositionalAudio(listener, {
  mesh: truck, refDistance: 2, distanceModel: 'inverse', rolloffFactor: 1.2,
  coneInnerAngle: 90, coneOuterAngle: 220, coneOuterGain: 0.3, muteWhenHidden: true,
});
engineSound.setBuffer(await listener.load('/sounds/rain-foa.wav'));
engineSound.loop = true;
engineSound.fadeIn(0.5);

const music = new Audio(listener, {volume: 0.4});
music.setMediaElementSource(document.querySelector('audio')!).play();

// A sound on an editor timeline: starts at timeline second 4, follows play, pause, scrubbing and timeline speed.
const cue = new Audio(listener, {volume: 0.6, loop: false, timelineStart: 4});
cue.setBuffer(await listener.load('/sounds/rain-foa.wav'));
engine.onFrame(() => cue.sync(timeline.seconds, timeline.playing, timeline.speed));

// Footsteps and block sounds: 6 voices share one buffer; a 7th overlapping play steals the oldest voice.
const steps = new AudioVoicePool(listener, await listener.load('/sounds/rain-foa.wav'), {voices: 6, refDistance: 2});
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
const buffer = await listener.load('/sounds/rain-foa.wav', {signal: AbortSignal.timeout(10_000)}); // rejects with an AbortError
using step = new Audio(listener).setBuffer(buffer);
step.play();
```

Errors carry a stable `code` (`error.code`): `disposed` for a sound used after `dispose()`, `state` for `play()` before a source is set, `unsupported` when Web Audio or `fetch` is missing, `failed` for an HTTP or decoding failure. Each message says what to do.

## How it works

- **Lazy context.** Nothing touches `AudioContext`, `window` or `document` at import time. The listener creates its `AudioContext` the first time `listener.context` is read (normally when the first sound is created), or uses the context you pass, for example an `OfflineAudioContext`. A context the listener created is closed on dispose; a context you passed is left open.
- **Listener follows the camera.** As an engine plugin the listener adds a frame pass (order 900) that runs after the camera and world matrices are updated. It writes the listener position, forward (camera position toward target) and camera up (including rolled and exact-pole views), and skips the write when nothing changed. `listener.follow(mesh, forward = [0, 0, 1], up = [0, 1, 0])` puts the ears on a mesh instead, such as a third-person character: its world position, its local `forward` axis (glTF characters face +Z) and its local `up` axis, read from the engine's world matrices each frame (a disposed mesh keeps the last pose). The listener always hands Web Audio an up at right angles to forward (the part of `up` across forward), so a top view with up +Y, `setPose(p, [0, -1, 0])` or `follow(rocket, [0, 1, 0])` keeps left and right: an up along forward becomes the up of that view pitched from level, `[0, 0, -1]` looking down and `[0, 0, 1]` looking up (in the mesh's own axes for `follow`). `follow('camera')` goes back; `follow(null)` stops following so only `setPose` moves the listener. `setPose` also sets the pose by hand when you do not use an engine.
- **Autoplay.** With `autoResume` (default) the listener resumes a suspended context on the first `pointerdown`, `mousedown`, `keydown` or `touchend` anywhere in the window, then removes its listeners. `suspend()` and `resume()` are there for explicit control.
- **Graph.** `source -> filters -> fade gain -> volume gain -> [PannerNode] -> master gain -> destination`. Fades have their own gain stage, so `fadeIn`/`fadeOut` never fight with `volume`, and hidden-mesh muting rides on the volume stage.
- **No clicks.** Volume, master volume, playback rate, detune, listener pose and panner pose move with `setTargetAtTime` (time constant `smoothing`, default 20 ms) on a running context. The first write, and every write on a suspended or offline context, is set immediately, so a sound never sweeps in from the origin.
- **Positional audio.** The panner reads its mesh's world matrix from `engineRuntime(engine).store.matrices` each frame: translation for position, the mesh's local `direction` axis (default +Z) for the cone. A disposed mesh keeps the last pose. With `muteWhenHidden` the sound fades out while the mesh or any ancestor is hidden.
- **Sources.** `setBuffer` (decoded files), `setMediaElementSource` (`<audio>`/`<video>`, one node per element and context, reused), `setMediaStreamSource` (microphone, WebRTC) and `setNodeSource` (oscillators, constant sources, worklets). Buffer sources keep a playhead across `pause`/`play`, including playback-rate changes and loop regions. `seek(seconds)` moves it whether playing, paused or stopped: a playing buffer restarts on one new source node (the old one is stopped and disconnected first, so they never overlap); looping wraps into the loop region; past the end of a non-looping buffer it clamps to the end and a playing sound ends (`onEnded` fires). Media elements seek through `currentTime`.
- **Timeline sync.** `sync(timelineSeconds, playing, rate = 1)`, called every frame with the editor's own clock, makes a buffer sound follow a timeline instead of the audio clock: silent before `timelineStart`, then at buffer position `offset + timelineSeconds - timelineStart` wrapped by the loop region, silent past the end of a non-looping sound. While playing it re-seeks only when the sound drifts more than `Audio.syncTolerance` (50 ms) from the timeline, so steady playback is never chopped and a seam crossing in a loop does not count as drift. With `playing` false (paused, scrubbing) it moves the playhead silently. `rate` is the timeline speed and sets `playbackRate`.
- **Voice pools.** `new AudioVoicePool(listener, buffer, {voices = 8, ...positional options})` makes `voices` positional sounds that share one decoded buffer, for sounds that overlap: footsteps, block breaks, hits. `play(position, {volume, playbackRate})` takes a voice that is not sounding, or when all are sounding steals the one that started longest ago (it is cut off at once); the play's `volume` and `playbackRate` (pitch variation) default to the pool's options, and a voice jumps to its new position and level instead of easing there. `play` returns the voice. `stopAll()` stops every voice; `dispose()` disposes them (the buffer stays usable).

  Pool play validates all three finite position coordinates, finite playbackRate and
  nonnegative finite volume before selecting or stopping a voice. Invalid inputs,
  including sparse coordinate arrays, raise a linked RangeError and leave current playback intact.
- **Loading.** `loadAudioBuffer(context, url, {signal})` and `listener.load` share one download and one decoded buffer per context and URL. An aborted caller rejects with an `AbortError`; the download is cancelled once every waiting caller aborted. Failed loads are not cached.

## API

| Export | Purpose |
| --- | --- |
| `AudioListener` | Engine plugin: lazy context, master gain (`input`, `volume`), `suspend`/`resume`, auto-resume, `load`, `follow` (camera, a mesh or nothing), `setPose`, `update` |
| `Audio` | Non-positional sound: `setBuffer`, `setMediaElementSource`, `setMediaStreamSource`, `setNodeSource`, `play(delay)`, `pause`, `stop(delay)`, `seek(seconds)`, `sync(timelineSeconds, playing, rate)`, `fadeIn`, `fadeOut`, `setFilters`, `loop`, `loopStart`, `loopEnd`, `playbackRate`, `detune`, `offset`, `duration`, `timelineStart`, `volume`, `currentTime`, `onEnded`, `getOutput`, readonly `isDisposed`; static `syncTolerance` |
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
| `loop`, `loopStart`, `loopEnd` | sounds | false, 0, 0 (end of buffer: `loopStart: 2` alone loops from 2 s to the end in every browser; since 2026-11-15, as WebKit looped the whole buffer before) |
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

## Occlusion and obstruction

`@margoengine/audio/occlusion` traces scene geometry with the existing BVH raycaster.
Full cover muffles and lowers a positional sound; partial cover gives intermediate filtering.
The listener updates the controller after its sound poses, on WebGPU and both WebGL2 routes.
BVH loads only when `create` is called. Install the optional `@margoengine/bvh` peer when
using this entry alone; the audio root imports neither occlusion nor BVH.

```ts
import {Engine, box} from 'margoengine/core';
import {AudioListener, PositionalAudio} from 'margoengine/audio';
import {AudioOcclusion} from 'margoengine/audio/occlusion';

const canvas = document.createElement('canvas');
document.body.append(canvas);
const engine = await Engine.create(canvas, {camera: {position: [0, 0, 4], target: [0, 0, 0]}});
const context = new OfflineAudioContext(2, 4800, 48000);
const listener = AudioListener.attach(engine, {context});
engine.createMesh().setGeometry(box()).setScale([4, 4, 0.1]).setPosition([0, 0, 2]);
using sound = new PositionalAudio(listener).setPosition(0, 0, 0);
const buffer = listener.context.createBuffer(1, 4800, 48000);
buffer.getChannelData(0).forEach((_, i, data) => { data[i] = 0.2 * Math.sin(2 * Math.PI * 1000 * i / 48000); });
sound.setBuffer(buffer);
using occlusion = await AudioOcclusion.create(sound, {signal: AbortSignal.timeout(10000)});
engine.render(); // updates listener and sound poses, then traces the wall
sound.play();
console.log(occlusion.blocked); // 1: all five rays hit the wall
const rendered = await context.startRendering(); // real muffled PCM without an autoplay gesture
console.log(rendered.length); // 4800 stereo frames
// In a live app, use the listener's default context and retain the objects until teardown.
engine.dispose();
```

Options: `radius=0.25` m (0..100) samples the centre and four perpendicular source offsets;
0 traces one ray. `blockedGain=0.25` (0..1), `blockedFrequency=800` Hz
(10..min(20000, Nyquist)), `smoothing=listener.smoothing` seconds (0..60),
`filter` includes all visible geometry by default, and `signal` defaults to none.
The source mesh and listener's followed mesh are excluded. Gain interpolates linearly with
blocked-ray fraction; cutoff interpolates geometrically from min(20000, Nyquist).
The 1 mm segment-end exclusion avoids endpoint self-intersections. Coincident positions are clear.
Owned `lowpass` and `attenuation` nodes append to the existing filter chain; ordinary volume,
fades and hidden muting stay independent. Keep that chain in place while active.
`dispose()` or `using` removes only these nodes; listener teardown also disposes controllers.
`update(engine)` runs explicitly after world matrices and sound/listener poses are current.
Without a live engine, updates retain the last blocked fraction and filter settings. Sound disposal detaches the controller before tracing; creating one on a disposed sound raises linked disposed. Explicit updates after controller disposal also raise linked disposed.

This is a sampled geometric approximation without diffraction, thickness/material transmission,
reflections or reverb-send control. BVH's visible CPU geometry coverage applies: fragment alpha
and arbitrary shader deformation are not evaluated; active skin/morph geometry needs a static
blocker/proxy. Radius is a sampled source aperture, not a physical acoustic simulation.
Node tests use stand-in rendering and audio graphs. The browser test measures generated tones
in real OfflineAudioContext renders beside real WebGPU, WebGL2 and compatibility engines.
Real recordings, listening quality, other browsers and speed are unmeasured.

## Outdoor propagation

`OutdoorAudio` applies a solved outdoor path to a `PositionalAudio`. It uses a delay line, the 1 kHz gain,
and shelves driven by the 63 Hz and 8 kHz gains. The path model handles distance attenuation while the sound
continues to pan and use its authored volume and filters. `maxDelay` defaults to 30 seconds and accepts
values above zero through 180 seconds. Moving paths smooth with the listener's time constant unless you
pass `smoothing`. Use one time-of-flight controller per sound. The controller removes its nodes on disposal
and restores the sound's distance rolloff.

```ts
import { AudioListener, PositionalAudio } from 'margoengine/audio';
import { OutdoorAudio } from 'margoengine/audio/outdoor';
import { OutdoorSound } from 'margoengine/physics/outdoor-sound';
import { PhysicsWorld } from 'margoengine/physics/world';

const paths = new OutdoorSound();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(paths, {
  links: [{ source: [0, 0, -34.3], listener: [0, 0, 0] }],
});
world.advance(1);
const audio = new OfflineAudioContext(2, 12000, 48000);
using listener = new AudioListener({ context: audio, smoothing: 0 });
using sound = new PositionalAudio(listener, { panningModel: 'equalpower' });
sound.setPosition(0, 0, -34.3);
using outdoor = new OutdoorAudio(sound, () => paths.read());
const pulse = audio.createBuffer(1, 64, 48000);
pulse.getChannelData(0)[0] = 1;
sound.setBuffer(pulse).play();
const pcm = (await audio.startRendering()).getChannelData(0);
console.log(pcm.findIndex((value) => Math.abs(value) > 1e-9) / 48000);
```

## Doppler

`@margoengine/audio/doppler` shifts buffer pitch from source and listener world motion.
Attach it after setting the buffer; the listener samples both poses after the sound update.
It works identically with WebGPU, native WebGL2 and WebGL2 compatibility rendering.
The audio root does not import this entry.

```ts
import {AudioListener, PositionalAudio} from 'margoengine/audio';
import {AudioDoppler} from 'margoengine/audio/doppler';

const context = new OfflineAudioContext(2, 24000, 48000);
using listener = new AudioListener({context, smoothing: 0});
listener.follow(null);
using sound = new PositionalAudio(listener, {rolloffFactor: 0});
const buffer = context.createBuffer(1, 48000, 48000);
buffer.getChannelData(0).forEach((_, i, a) => { a[i] = 0.2 * Math.sin(2 * Math.PI * 1000 * i / 48000); });
sound.setBuffer(buffer).setPosition(20, 0, 0).play();
using doppler = new AudioDoppler(sound);
listener.update();
const paused = context.suspend(0.128);
const rendered = context.startRendering();
await paused;
sound.setPosition(20 - 34.3 * context.currentTime, 0, 0);
listener.update();
console.log(doppler.ratio); // 1.111...: source approaching at 34.3 m/s
sound.playbackRate = 1.1; // authored pitch, composed with Doppler (also works on pooled voices)
console.log(doppler.playbackRate, sound.isDisposed); // 1.1, false
await context.resume();
console.log((await rendered).length); // 24000 frames, shifted tone after the motion sample
```

Options: `speedOfSound=343` m/s (finite, positive), `playbackRate=sound.playbackRate`
(finite, nonnegative, at most float32 maximum / 39). `doppler.playbackRate` reports authored pitch; `ratio` reports the motion multiplier. Writes to either `doppler.playbackRate` or `sound.playbackRate`, including pool/event per-play pitch, set authored pitch and compose with the current multiplier. The sound getter reports the effective rate. Controlled pools validate authored rates before stopping or stealing a voice. Disposal restores the last authored pitch. Detune,
volume, fades, filters and the panner stay independent. Use one controller per sound;
duplicate attachment raises `attached`. Buffer sources only; other source kinds raise
`unsupported` on attachment, with a help link. Switching an attached sound to media, stream or node sources detaches Doppler on the next listener update and restores authored pitch without interrupting other sources.

Live contexts estimate velocity with monotonic `performance.now()` frame time, independently of device-clock quantization. Offline contexts use their exact audio clock. Initial, coincident and backward-clock samples are neutral; repeated sample times retain history. Live suspension/resume state changes clear history automatically, including autoplay unlock. A live render gap over 0.25 s or displacement speed over 0.95 times speedOfSound is a discontinuity and produces a neutral sample. Smaller teleports are indistinguishable from real motion: call `reset()` before the next update after those cuts. Explicit `update()` needs current sound/listener poses;
attached listeners do this automatically. Updates use existing playback-rate smoothing
(`listener.smoothing=0.02` s by default). Playback speed and duration change with pitch.
Do not combine with `Audio.sync`, which also owns playback rate.

The classical stationary-medium ratio is `(c + listener radial velocity) / (c + source
radial velocity)` with the axis pointing listener to source. Each radial Mach number
is clamped to -0.95..0.95, bounding the ratio to 1/39..39. This keeps extreme motion
finite; supersonic propagation, sonic booms, wind, travel delay and retarded positions
are outside this instantaneous approximation. Stop updating to freeze the last pitch;
dispose or reset to restore it. Sound disposal detaches on the next listener update;
listener teardown disposes controllers. Supports `using` and idempotent `dispose()`.
Node tests use stand-in audio. Real browser renders measure generated 1 kHz tones for
approach, recession, listener approach, co-motion and rest on all three rendering routes.
Generated audio/motion are stand-ins; recordings, listening quality, other browsers
and performance remain unmeasured.

## Sound event containers

`@margoengine/audio/events` selects decoded one-shots in random or sequence order,
with independent pitch and volume variation and an audio-clock cooldown. It reuses
`AudioVoicePool`; the audio root does not import it. WebGPU and both WebGL2 routes
use the same Web Audio graph.

```ts
import {AudioListener} from 'margoengine/audio';
import {AudioEventContainer} from 'margoengine/audio/events';

const context = new OfflineAudioContext(2, 14400, 48000);
using listener = new AudioListener({context});
const buffers = [600, 900].map(hz => {
  const buffer = context.createBuffer(1, 3840, 48000);
  buffer.getChannelData(0).forEach((_, i, a) => { a[i] = 0.2 * Math.sin(2 * Math.PI * hz * i / 48000); });
  return buffer;
});
using footsteps = new AudioEventContainer(listener, buffers, {
  mode: 'sequence', volume: [0.5, 0.8], pitch: [-50, 50], cooldown: 0.1,
});
footsteps.play([0, 0, -1]);
console.log(footsteps.play([0, 0, -1])); // null: cooldown does not consume a sequence step
const paused = context.suspend(0.128);
const rendered = context.startRendering();
await paused;
footsteps.play([0, 0, -1]); // second buffer
await context.resume();
console.log((await rendered).length); // 14400 frames
// In a live game, load buffers with listener.load(url, {signal}) and call play on game events.
```

`AudioEventContainer(listener, buffers, options)` needs a nonempty list of decoded,
positive-duration buffers. `mode='random'` chooses uniformly, excluding the previous
buffer index when there is more than one; `'sequence'` visits indices in order and
wraps. Repeated buffer objects at different indices remain separate choices.
`voices=4` preallocates that many voices per buffer; a full pool steals its oldest
voice. Total voices are buffer count times `voices`; there is no global container
voice limit. Returned voices can be moved or stopped while they play.

`volume=[1,1]` is a uniform linear gain range within 0..1. `pitch=[0,0]` is a uniform
cents range within -4800..4800, converted to playbackRate with `2 ** (cents / 1200)`;
pitch also changes duration. Endpoints are snapshotted, finite and ordered. `cooldown=0`
is a finite nonnegative interval in audio-clock seconds. A rejected play returns null
without consuming random draws or sequence state. Context suspension freezes cooldown;
a backwards clock accepts a new play and starts a new interval. Play positions default
to `[0,0,0]` in metres. Invalid positions or draws fail before stopping an existing voice.

`random=Math.random` can be replaced with a uniform function returning a finite number
in `[0,1)` for reproducible runs. Constant ranges and a single-buffer selection need
no draw. Draw order is selection (random mode with multiple buffers), volume, pitch.
`voiceOptions` defaults to the pool's spatial and clip defaults; looping, voice count,
volume, detune and playback rate are controlled by the container. No buffer is cloned
or loaded here; existing listener loading supports AbortSignal. No timers or waiting.
`lastIndex=-1` until the first accepted play; `stopAll()` retains history/cooldown.
`dispose()` and `using` release voices, preserve shared buffers and are idempotent;
listener teardown also disposes the container. Disposed use raises `disposed` with a
help link; invalid selections use `state` and invalid ranges use linked RangeError.

Node tests cover order, variation, exact cooldown boundaries, deterministic selection,
single-buffer play, overlap, stealing, teardown and failure atomicity. Real browser
PCM measures generated sequence/random tones and a silent cooldown gap beside WebGPU,
native WebGL2 and compatibility WebGL2. Generated audio/events are stand-ins; real
recordings, listening quality, other browsers and performance are unmeasured.

## Adaptive music

`@margoengine/audio/music` starts decoded stems together and changes their levels on
beat or bar boundaries. Install the optional peer `@margoengine/mixer` alongside audio;
the entry reuses mixer buses and audio-clock gain scheduling. WebGPU, native WebGL2
and compatibility WebGL2 share the same Web Audio graph.

```ts
import {AudioListener} from 'margoengine/audio';
import {AudioMusic} from 'margoengine/audio/music';

const context = new OfflineAudioContext(2, 72000, 48000);
using listener = new AudioListener({context});
const tone = (hz: number) => {
  const buffer = context.createBuffer(1, 24000, 48000);
  buffer.getChannelData(0).forEach((_, i, a) => { a[i] = 0.1 * Math.sin(2 * Math.PI * hz * i / 48000); });
  return buffer;
};
using music = new AudioMusic(listener, {base: tone(600), drums: tone(900)}, {
  explore: {base: -6}, combat: {base: -6, drums: -6},
}, {loopBeats: 1, leadTime: 0});
music.start('explore', 0);
console.log(music.transition('combat', {quantize: 'beat', after: 0.1})); // 0.5 seconds
console.log((await context.startRendering()).length); // 72000 frames
```

In a game, use `listener.load(url, {signal})` for authored stems and call
`transition('combat')` when game state changes. States map stem names to dB levels;
omitted stems and `-Infinity` are silent. States are copied at construction. Gains
must fit finite float32 linear values. This is gain layering of continuously running
loops: muted stems keep their phase. Every loop is its own source started at
`origin + k * loop` on the audio clock, so a browser that rounds start or loop points to
whole frames (Firefox) never drifts off the grid. An `OfflineAudioContext` render (a soundtrack bounce)
is scheduled a window of loops at a time and refilled at `suspend(time)` points, because every scheduled source costs
the renderer work on each render quantum until it ends: an hour at 130 bpm renders in under a second in Chromium
instead of 35 s. A browser without `suspend(time)` on offline contexts (Firefox), or an app that already holds a
suspend at the same render quantum, gets the whole render scheduled at once: the same samples, rendered more slowly.
No tempo analysis, stretching, sequencing of
different sections, streaming, or automatic loudness/headroom management.

Options: `bpm=120` positive finite quarter-note beats/minute, `beatsPerBar=4` and
`loopBeats=4` positive integers, `leadTime=0.05` finite nonnegative scheduling seconds,
`fade=0.02` finite nonnegative mixer exponential fade seconds (about 98% settled;
0 jumps). Each decoded buffer must cover `loopBeats * 60 / bpm` seconds. Only that
interval loops; trailing samples are unused. Author seamless, aligned stems; buffers
are shared. Tempo and loop length stay fixed for a transport.

`start(state, at=currentTime+leadTime)` requires a stopped transport and a finite
time at/after now; returns the common origin. `transition(state, {quantize='bar',
after=currentTime, fade=constructor default})` returns the first grid time at/after
both `after` and `currentTime+leadTime`, relative to that origin. Exact boundaries
are eligible. Schedule ahead of time for live playback; a main-thread call that
arrives late moves to the next eligible boundary. Audio-clock suspension freezes
the grid. No timers or frame scheduling. A new request replaces mixer automation
at/after its chosen boundary, preserving earlier transitions; fades are exponential,
not equal-power crossfades. Validate requests before changing playback.

`stop()` cuts sources immediately, including future starts. Restart resets phase and
pending automation. `dispose()`, `using`, and listener teardown release owned sources
and mixer buses, preserving buffers. Disposed use raises linked `disposed`; invalid
states/grid use linked `state` errors. No core/stage changes. Node stand-ins cover
scheduling and lifecycle; real browser generated-stem PCM checks phase, loop, layering
and beat/bar boundaries on all three routes. Recordings, listening quality, other
browsers and performance remain unmeasured.

## Reverb zones

`@margoengine/audio/zones` selects a room response as the listener moves through
axis-aligned areas. It reuses `@margoengine/mixer/reflections` and mixer automation;
install the optional `@margoengine/mixer` peer alongside audio. WebGPU and both
WebGL2 routes use the same Web Audio convolution graph.

```ts
import {AudioListener, Audio} from 'margoengine/audio';
import {AudioReverbZones} from 'margoengine/audio/zones';

const context = new OfflineAudioContext(2, 24000, 48000);
using listener = new AudioListener({context});
using zones = new AudioReverbZones(listener, [
  {name: 'hall', min: [-4, -2, -4], max: [4, 2, 4],
   reverb: {room: [8, 4, 8], seconds: 0.2}},
]);
const buffer = context.createBuffer(1, 4800, 48000);
buffer.getChannelData(0)[0] = 0.25;
using sound = new Audio(listener).setBuffer(buffer);
sound.getOutput().connect(zones.input); // additional wet send; the dry route already exists
sound.play();
console.log(zones.active); // hall
console.log((await context.startRendering()).length); // 24000 frames
sound.getOutput().disconnect(zones.input);
```

`AudioReverbZones(listener, zones, {fade=0.1})` copies finite ordered `min`/`max`
world bounds in metres. Names must be unique and nonempty. Bounds are inclusive;
o matching zone means a silent wet send. Greatest finite `priority=0` wins overlap;
equal priorities select the first listed zone. `gain=0.25` is linear wet-send gain
in 0..1, added to the unchanged dry route. Manage headroom for combined dry/wet audio.
`reverb={}` takes the existing [mixer room settings and defaults](../mixer/README.md#early-room-reflections),
with `mix` always 1 for wet-only output. Bounds select a response; they do not define
the response's room geometry or move its authored source/listener positions.

`fade=0.1` is finite nonnegative mixer exponential fade seconds (about 98% settled);
0 jumps. One convolution and response buffer per zone are prepared at construction.
Only selection/send gains change on movement. Old tails ring out after a switch or
exit; the input feed fades, preserving convolution state. Resource cost grows with
zone count and room response length; this is an authored zone model, without
continuous propagation, portals, diffraction or automatic room geometry analysis.

`active` reports the selected name or null. Attached listeners update selection each
frame after their pose; otherwise call `listener.update()` or `zones.update()` after
setting the listener pose. Selection follows game frames, fades follow the audio
clock. Unchanged selection schedules nothing. Empty zone lists are valid wet silence.
No loading, waits or timers. Listener loading already supports AbortSignal.

`dispose()`, `using` and listener teardown disconnect owned sends/effects immediately,
cutting tails. If a manually connected source will outlive the controller, disconnect
its connection into `zones.input`. Shared source dry routes stay independent. Disposed
updates raise linked `disposed`; invalid bounds/names/levels raise linked `state`.
Room settings use the mixer's validation. Node tests cover priority, boundaries,
immutable bounds, teardown and failure cleanup. Real browser PCM compares generated
impulses to existing mixer responses across room entry/switch/exit, including dry
sound and retained tails, on all three routes. Generated rooms/motion are stand-ins;
recordings, listening quality, other browsers and performance remain unmeasured.

## Ambisonic beds

`@margoengine/audio/ambisonics` plays and rotates first-order AmbiX beds (four
ACN/SN3D channels W,Y,Z,X). It uses Web Audio splitters, a rotation/decoder gain
matrix and a stereo merger on WebGPU, native WebGL2 and compatibility WebGL2.

```ts
import {AudioListener} from 'margoengine/audio';
import {AmbisonicAudio} from 'margoengine/audio/ambisonics';

const context = new OfflineAudioContext(2, 24000, 48000);
using listener = new AudioListener({context, smoothing: 0});
const buffer = context.createBuffer(4, 24000, 48000);
// A generated plane-wave tone from the recording's front: W = X, Y = Z = 0.
for (let i = 0; i < buffer.length; i++) {
  const sample = 0.1 * Math.sin(2 * Math.PI * 600 * i / 48000);
  buffer.getChannelData(0)[i] = sample;
  buffer.getChannelData(3)[i] = sample;
}
using bed = new AmbisonicAudio(listener, buffer, {volume: 0.5});
bed.setRotation([0, Math.SQRT1_2, 0, Math.SQRT1_2]).play(); // 90-degree world Y rotation
console.log((await context.startRendering()).length); // 24000 frames
```

For a file, use `await listener.load(url, {signal})`, then construct the bed from
that decoded buffer. Four-channel PCM WAV is tested. Browser codec/container support
controls loading; this entry does not parse CAF adaptor matrices, Opus mapping
metadata or infer normalization from a buffer. Confirm ACN/SN3D before passing it.
`format='ambix'` is the only supported convention. FuMa, N3D, A-format, higher orders,
extra stereo channels and mixed-order layouts need conversion first; other formats
or channel counts raise `unsupported` with a help link. Buffers have positive finite
duration and are shared. No core/stage changes or additional peer dependencies.

The decoder uses two virtual cardioid microphones at +/-30 degrees about listener
forward: each output is `0.5 * (W + dot(direction, [X,Y,Z]))`, then output volume.
This gives orientation-dependent stereo ambience. It is not an HRTF/binaural decoder,
loudspeaker-layout decoder or a guarantee of headphone front/back/elevation localization.
ACN axes are X front, Y left, Z up. Identity field orientation maps those to engine
world -Z, -X, +Y respectively. `setRotation([x,y,z,w])` applies an active world-space
field rotation, normalized and copied. Listener orientation applies the inverse head
rotation to the bed. Translation is ignored for this infinitely distant ambience.

`loop=true` loops the complete buffer; `volume=1` is linear gain in 0..1; `smoothing`
defaults to `listener.smoothing` (0.02 s), a finite nonnegative time constant, with
0 immediate. Independent channel gains interpolate during orientation changes;
intermediate matrices during a fade are a blend, not an exact rigid rotation.
Use aligned/seamless loops and manage headroom. Eight gain paths and one source per
bed; no convolution, worklet, per-sample JavaScript or HRTF assets. Unchanged matrices
schedule nothing. `volume` can be changed independently of field rotation.

`play(at=context.currentTime)` starts from phase zero at/after now; a playing or
scheduled bed must be stopped before restart. `isPlaying` includes scheduled starts.
Natural end clears it for `loop=false`. `stop()` cuts and disconnects playback.
`dispose()`, `using` and listener teardown release decoder nodes and preserve buffers.
Disposed calls raise linked `disposed`; invalid values use linked `state` errors.

The listener updates the matrix each frame. For XR, feed the headset's world forward
and up vectors through `listener.follow(null).setPose(position, forward, up)` before
`listener.update()`. A collinear pose keeps the last independent decoder orientation; a bed created at such a pose starts facing -Z with +Y up. A valid pose resumes orientation updates.
This entry adds no XR session/headset driver. Physical headset tracking and subjective
localization are unmeasured. CPU tests cover full quaternion yaw/pitch/roll basis
changes; browser PCM covers channel routing, looping, listener yaw and field yaw on
all three routes. Evidence uses generated independent tones and a licensed external
rain stimulus excerpt: [source/changes](tests/fixtures/NOTICE.md). That file validates
decoding/resampling and matrix output, not a microphone chain or recording provenance.
Listening quality, other browsers/devices and performance remain unmeasured.

The PCM proofs use real browser Web Audio offline rendering, without output-device PCM or listening measurements. Live Doppler regressions use real AudioContext nodes/state changes with controlled 60 Hz frame times and a 10.667 ms quantized audio clock. Long-loop markers at 130 bpm cover one hour at 8 kHz and five minutes each at 44.1/48 kHz; loop endpoints keep fractional sample positions rather than accumulating sample-rounding drift. Other browsers/devices remain unmeasured.

## Offline spectrograms

`@margoengine/audio/spectrogram` analyses a whole array of samples, not the live frames an `AnalyserNode` gives. `stft`
cuts it into windowed frames (Hann by default; also Hamming, Blackman, 4-term Blackman-Harris, Kaiser by `beta`, or
your own coefficients from `windows`) and returns `real` and `imag` arrays of `frames x (size / 2 + 1)` bins. `istft`
puts the frames back by weighted overlap-add (Allen and Rabiner 1977, with the window-squared normaliser), and
`spectrogram` turns a spectrum into an image of bytes (or colours) for a texture. `resynthesize` estimates a signal
from a magnitude spectrogram, which is how an edited or painted spectrogram becomes sound, by the fast Griffin-Lim
algorithm (Griffin and Lim 1984; Perraudin, Balazs and Sondergaard 2013).

- Sizes are powers of two from 32 to 65536 (default 2048); `hop` runs from 1 to `size` (default `size / 4`). Frame k is
  centred on sample `k * hop` by default (`center: true`, reflect padding; `pad: 'zero'` and `'edge'` also work).
- `istft` and `resynthesize` throw a coded `state` error when the window and hop do not overlap-add evenly: the smallest
  over the largest summed squared window (`overlapRatio`) must be at least 0.1. Hann at hop `size / 4` gives 1, at
  `size / 2` gives 0.5 and at 3/4 of `size` gives 0.04.
- `resynthesize(target, { iterations: 32, momentum: 0.99, init: 'random' })` returns `samples`, the spectral
  `convergence` after each iteration and the number of frame FFTs it ran. Momentum 0 is the original algorithm.
- `stft(samples, { gpu })` (a compute context from `@margoengine/compute`, which loads then) transforms frames in
  batches on the GPU and returns a promise; it agrees with the CPU path to 2e-7 of the peak. Pass an `AbortSignal` as
  `signal` to stop between frames.

```ts
import { istft, resynthesize, spectrogram, stft } from '@margoengine/audio/spectrogram';

// One second of a rising chirp, as a loaded file's channel data would be.
const rate = 48000;
const samples = Float32Array.from({ length: rate }, (_, i) => {
  const t = i / rate;
  return 0.8 * Math.sin(2 * Math.PI * (300 * t + 1500 * t * t));
});
const spec = stft(samples, { sampleRate: rate, size: 2048 });
const image = spectrogram(spec, { colormap: 'heat', range: [-80, 0], origin: 'high' });
// image.data is RGBA bytes, image.width x image.height: write it to an rgba8unorm texture with
// device.queue.writeTexture({ texture }, image.data, { bytesPerRow: image.width * 4 }, [image.width, image.height]).
const same = istft(spec); // the samples again, within 1e-6
// Keep only the magnitudes, as a painted spectrogram would, and get a signal back.
const magnitude = Float32Array.from(spec.real, (re, i) => Math.hypot(re, spec.imag[i]));
const { samples: estimate, convergence } = resynthesize(
  { magnitude, frames: spec.frames, size: 2048, hop: spec.hop, length: samples.length },
  { iterations: 16 },
);
console.log(image.width, image.height, same.length, estimate.length, convergence[convergence.length - 1] < convergence[0]);
```

## WAV files without Web Audio

`@margoengine/audio/wav` reads and writes RIFF WAVE files as plain bytes, so a stem or a mix can be made in Node, a
worker or a build script with no `AudioContext` and no `OfflineAudioContext`. `decodeWav` returns the sample rate and
one `Float32Array` per channel; `encodeWav` returns the file as a `Uint8Array` for `fs.writeFile` or a `Blob`.

- Reads 8-bit (unsigned), 16, 24 and 32-bit PCM and 32 and 64-bit float, plain or `WAVE_FORMAT_EXTENSIBLE`, with any
  number of channels; `LIST`, `bext`, `iXML` and other chunks are skipped; a file still being written (data size
  `0xFFFFFFFF` or past the end) reads to its end.
- Writes 16-bit PCM by default (`format: 'pcm8' | 'pcm16' | 'pcm24' | 'pcm32' | 'float32' | 'float64'`). More than two
  channels, or 24 or 32-bit PCM or 64-bit float, get an extensible header with the usual channel mask (5.1 is `0x3F`).
  Integer formats round to nearest, clamp (1.0 is the largest value, no wrap) and turn NaN into silence.
- A file written then read back has the same samples, and writing what was read gives the same bytes. ffmpeg and
  Python's `wave` module read the files it writes.
- Not read: ADPCM, A-law, mu-law, compressed codecs inside WAV, and RF64 (over 4 GiB); they throw a coded error
  ([errors#wav](https://margoengine.com/errors#wav)).
- Sources: Microsoft and IBM, Multimedia Programming Interface and Data Specifications 1.0 (1991), for the RIFF and PCM
  layout; Microsoft, Multiple Channel Audio Data and WAVE Files (2001), for `WAVE_FORMAT_EXTENSIBLE`; EBU Tech 3285
  (Broadcast Wave Format) for the extra chunks; EBU Tech 3306 (RF64) for why files over 4 GiB are refused.

```ts
import { decodeWav, encodeWav } from '@margoengine/audio/wav';

// A second of a 440 Hz tone in the left channel and 660 Hz in the right, written as a 24-bit stereo file.
const rate = 48000;
const tone = (hz: number) => Float32Array.from({ length: rate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));
const file = encodeWav({ sampleRate: rate, channels: [tone(440), tone(660)] }, { format: 'pcm24' });
// In Node: await writeFile('mix.wav', file)
const audio = decodeWav(file);
console.log(file.byteLength, audio.sampleRate, audio.channels.length, audio.channels[0].length, audio.format);
```

## Clipping and silence checks

`@margoengine/audio/scan` checks decoded audio, in Node, a worker or a page, before it ships: a narration, a stem or a
mix read with `decodeWav`.

- `scanClipping(channels, sampleRate, { level?, run? })` finds every run of `run` (default 3) or more samples in a row
  on one channel whose magnitude is at or over `level` of full scale (default 0.999). One full-scale sample is a peak,
  not a clip; the level sits just under 1 so clipped audio that went through a lossy codec still counts. Returns
  `{ runs, clippedSamples, peak }`, each run `{ channel, startSample, length, start, end }` with times in seconds.
- `findSilences(samples, sampleRate, { floorDb?, minSeconds?, window?, spans? })` finds runs of windows (default 10 ms)
  whose level is under `floorDb` (default -50 dBFS) lasting at least `minSeconds` (default 2), only inside `spans`
  (`[start, end]` seconds) when given; a silence never crosses a span's edge. The level is the mean square of all
  channels in dBFS as AES17 defines it (a full-scale sine is 0 dBFS). Returns `{ start, end, duration, level }` per
  silence, `level` being its loudest window. Edges are found to within one window.
- `samples` and `channels` take one channel or an array of them (Float32Array or number arrays, all one length).
- Loudness and true peak are `@margoengine/mixer/loudness`'s job (ITU-R BS.1770, EBU R 128).
- Web rivals: Tone.js and Howler meter live playback only and wavesurfer.js draws peaks; none scans decoded audio for
  clips or silences. ffmpeg's `silencedetect` and `astats` filters are the command-line equivalent.
- Sources: AES17-2020 (full scale and dBFS); IEC 61606-3 and EBU Tech 3341 (sample and true peak); Aleinik, Matveev
  and Raev, "Detection of clipped fragments in speech signals" (2014), and Eaton and Naylor, "Detection of clipping in
  coded speech signals" (EUSIPCO 2013), for runs at the rail rather than single peaks; ITU-R BS.1770-5 (levels over
  short blocks of all channels); ITU-T P.56 (2011) for speech activity with a hangover, which `minSeconds` plays.

```ts
import { decodeWav, encodeWav } from '@margoengine/audio/wav';
import { findSilences, scanClipping } from '@margoengine/audio/scan';

// Two seconds of speech-like tone, four seconds of near silence, then a tone driven past full scale.
const rate = 48000;
const tone = (seconds: number, gain: number) =>
  Float32Array.from({ length: seconds * rate }, (_, i) => Math.max(-1, Math.min(1, gain * Math.sin((2 * Math.PI * 220 * i) / rate))));
const voice = new Float32Array(8 * rate);
voice.set(tone(2, 0.3), 0);
voice.set(tone(2, 2), 6 * rate);
// In Node: decodeWav(await readFile('narration.wav'))
const { channels, sampleRate } = decodeWav(encodeWav({ sampleRate: rate, channels: [voice] }));
const clips = scanClipping(channels, sampleRate);
const silences = findSilences(channels, sampleRate, { floorDb: -50, minSeconds: 3, spans: [[0, 8]] });
console.log(clips.runs.length, clips.runs[0].start.toFixed(3), silences.map((s) => [s.start, s.end]));
```

## Sample rates and channel layouts without Web Audio

`@margoengine/audio/resample` converts decoded audio to another sample rate and channel count on plain `Float32Array`
channels, in Node, a worker or a page, with no `AudioContext`, `OfflineAudioContext` or ffmpeg: a take recorded at 44.1
kHz joins a 48 kHz narration read with `decodeWav`.

- `resample(audio, sampleRate, { channels?, zeroCrossings?, rolloff?, attenuation? })` takes `{ sampleRate, channels }`
  (what `decodeWav` returns) and gives the same shape at the new rate. Each output sample is a sum of input samples
  weighted by a Kaiser-windowed sinc centred on its time (bandlimited interpolation); when the rate goes down the sinc
  widens so it also removes what the new rate cannot hold, and nothing folds back. The output holds
  `ceil(length * sampleRate / input rate)` samples, so one second stays one second; samples past either end count as
  silence. The same rate copies the samples.
- Defaults: `zeroCrossings` 32 (4 to 256) on each side, `rolloff` 0.92 (0.5 to 1) of the lower Nyquist frequency,
  `attenuation` 90 dB (40 to 160) for the Kaiser window. At these a 1 kHz tone taken from 44.1 to 48 kHz is within
  -80 dB of the exact sine, the response is flat within 0.1 dB to 0.86 of the lower Nyquist frequency (19.0 kHz for
  44.1 kHz to 48 kHz), and a tone at or above the lower Nyquist frequency comes out at least 90 dB down (tests in
  `tests/resample.test.js`).
- `channels` mixes by `mixChannels(channels, count)`, also exported: the Web Audio speaker rules for mono, stereo, quad
  and 5.1 up and down (5.1 to stereo puts the centre and surrounds in at -3 dB and drops the LFE), and a discrete copy
  for any other pair (channels in order, missing ones silent, extra ones dropped).
- Rates are whole numbers from 1 to 768000; a bad rate or option throws a coded error
  ([errors#audio-resample](https://margoengine.com/errors#audio-resample)).
- Web rivals: Tone.js, Howler and the Web Audio API itself resample only through an `AudioContext` or
  `OfflineAudioContext`, so not in Node; ffmpeg's `aresample` (swr) is the command-line equivalent.
- Sources: J. O. Smith III and P. Gossett, "A flexible sampling-rate conversion method", ICASSP 1984, and J. O. Smith
  III, Digital Audio Resampling Home Page (CCRMA, Stanford), for bandlimited interpolation from a filter table read
  with linear interpolation; R. E. Crochiere and L. R. Rabiner, Multirate Digital Signal Processing (Prentice Hall,
  1983), for the lowpass at the lower Nyquist rate; J. F. Kaiser, "Nonrecursive digital filter design using the
  I0-sinh window function", ISCAS 1974, and Oppenheim and Schafer, Discrete-Time Signal Processing, 3rd ed. (2010),
  section 7.6, for the window and its beta; Laakso, Valimaki, Karjalainen and Laine, "Splitting the unit delay", IEEE
  Signal Processing Magazine 13(1), 1996, doi:10.1109/79.482137, for why Lagrange and allpass interpolators were not
  used; W3C Web Audio API (2021), "Channel Up-Mixing and Down-Mixing", for the speaker rules.

```ts
import { decodeWav, encodeWav } from '@margoengine/audio/wav';
import { resample } from '@margoengine/audio/resample';

// A second of a 1 kHz mono take at 44.1 kHz, laid into a 48 kHz stereo voice.
const tone = Float32Array.from({ length: 44100 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 44100));
// In Node: decodeWav(await readFile('take.wav'))
const take = decodeWav(encodeWav({ sampleRate: 44100, channels: [tone] }, { format: 'float32' }));
const voice = resample(take, 48000, { channels: 2 });
console.log(voice.sampleRate, voice.channels.length, voice.channels[0].length); // 48000 2 48000
```

## Time-stretch at the same pitch

`@margoengine/audio/stretch` makes decoded audio longer or shorter without changing its pitch, on plain `Float32Array`
channels in Node, a worker or a page: a narration section or a recorded take made a few percent faster or slower to
fit its slot. The mixer's pitch shift is a real-time effect that changes pitch, not length; this changes length.

- `timeStretch(audio, factor, { frameMs?, toleranceMs? })` takes `{ sampleRate, channels }` (what `decodeWav`
  returns) and returns the same shape, `round(length * factor)` samples long: `1.05` is 5 % longer (slower), `0.95` is
  5 % shorter (faster), from `0.25` to `4`. A factor of 1 copies the samples.
- It is WSOLA (waveform similarity overlap-add): Hann-windowed frames of `frameMs` (default 40, 10 to 200) are laid
  half a frame apart in the output, each taken from near its place in the input, moved by up to `toleranceMs` (default
  10, 1 to 50) to where its waveform best continues the frame before it, so periods line up and the pitch stays. Every
  channel uses the same frame positions, chosen on their mean, so the stereo image stays put.
- Tested on tones and chords: the pitch stays within 0.2 % and the level within 2 % at factors 0.8 to 1.25, and the
  period of a two-note chord is unchanged (`tests/stretch.test.js`). WSOLA suits speech; for music with strong
  transients and many voices a phase vocoder can sound better (Driedger and Mueller 2016), and it is not offered here.
- A bad factor or option throws a coded error ([errors#audio-stretch](https://margoengine.com/errors#audio-stretch)).
- Web rivals: Tone.js `GrainPlayer` and the `playbackRate` of Howler and `<audio>` (with `preservesPitch`) stretch
  while playing, in a page; none returns stretched samples offline in Node. ffmpeg's `atempo` and `rubberband` filters
  are the command-line equivalent.
- Sources: W. Verhelst and M. Roelands, "An overlap-add technique based on waveform similarity (WSOLA) for high quality
  time-scale modification of speech", ICASSP 1993, doi:10.1109/ICASSP.1993.319366; S. Roucos and A. M. Wilgus, "High
  quality time-scale modification for speech", ICASSP 1985, doi:10.1109/ICASSP.1985.1168381; J. Driedger and M.
  Mueller, "A Review of Time-Scale Modification of Music Signals", Applied Sciences 6(2):57, 2016,
  doi:10.3390/app6020057; compared and not used: J. L. Flanagan and R. M. Golden, "Phase vocoder", BSTJ 45(9), 1966,
  doi:10.1002/j.1538-7305.1966.tb01706.x, and J. Laroche and M. Dolson, "Improved phase vocoder time-scale
  modification of audio", IEEE TSAP 7(3), 1999, doi:10.1109/89.759041.

```ts
import { timeStretch } from '@margoengine/audio/stretch';

// Two seconds of a 220 Hz tone made 5 % shorter to fit its slot, at the same pitch.
const rate = 48000;
const take = { sampleRate: rate, channels: [Float32Array.from({ length: 2 * rate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / rate))] };
const fitted = timeStretch(take, 0.95);
console.log(fitted.channels[0].length / rate); // 1.9
```
