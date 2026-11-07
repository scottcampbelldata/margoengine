# @margoengine/cutscene

Import `margoengine/cutscene` from the `margoengine` package, or `@margoengine/cutscene` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

A timeline sequencer for cutscenes and in-game cinematics: tracks of keys and clips in a JSON document, a pure
`evaluate(t)` that gives the whole scene state at any time, and a player with play, pause, reverse, speed, scrubbing,
skip and fast-forward that fires every event in order. It renders nothing itself and imports nothing heavy: apply the
state to your camera, objects, animation mixer, audio and UI.

```ts
import { Camera } from 'margoengine/core';
import { CutscenePlayer, type CutsceneDocument } from 'margoengine/cutscene';

const intro: CutsceneDocument = {
  format: 'margo-cutscene',
  version: 1,
  duration: 6,
  markers: [{ time: 3, name: 'reveal' }],
  tracks: [
    {
      type: 'camera',
      id: 'cam',
      keys: [
        { time: 0, position: [0, 2, 8], target: [0, 1, 0] },
        { time: 3, position: [5, 3, 4], target: [0, 1, 0], ease: 'easeInOutCubic' },
        { time: 4, position: [0, 1.6, 2], target: [0, 1.5, 0], fov: 35, cut: true },
      ],
    },
    { type: 'transform', id: 'door', target: 'door', keys: [{ time: 3, rotation: [0, 0, 0, 1] }, { time: 4, rotation: [0, 0.7071, 0, 0.7071] }] },
    { type: 'animation', id: 'hero', target: 'hero', clips: [{ start: 0, duration: 6, clip: 'Walk', loop: true, length: 1.2 }] },
    { type: 'audio', id: 'music', clips: [{ start: 0, duration: 6, sound: 'theme', fadeIn: 1 }] },
    { type: 'subtitle', id: 'subs', clips: [{ start: 1, duration: 2, text: 'Someone left the door open.', speaker: 'Ada' }] },
    { type: 'event', id: 'cues', events: [{ time: 3.5, name: 'spawnBats', data: { count: 12 } }] },
  ],
};

const camera = new Camera();
const player = new CutscenePlayer(intro);
player.on('event', (event) => console.log('event', event.name, event.data));
player.on('marker', (marker) => console.log('marker', marker.name));
const done = player.play();

// Each frame:
player.update(1 / 60);
const state = player.state;
if (state.camera) {
  camera.position = state.camera.position;
  camera.target = state.camera.target;
  camera.fov = state.camera.fov;
  camera.up = state.camera.up;
}
// state.transforms.door.rotation, state.animations, state.audio, state.subtitles: apply them the same way.

player.skip(); // "Skip cutscene": jumps to the end and still fires spawnBats and the marker, in order.
await done; // true: it finished
```

## Tracks

Every track has an `id` (unique in its timeline) and may be `muted`. Key tracks interpolate between keys sorted by
`time`, holding the first value before the first key and the last after the last; `ease` on a key shapes the move into
it (`'linear'` default, `'step'`, `'smoothstep'`, any `ease*` easing of `@margoengine/tween` such as
`'easeOutBack'`, or cubic-bezier points `[x1, y1, x2, y2]`). Clip tracks hold spans `start` + `duration` (start
inclusive, end exclusive) that may overlap.

| Track | Fields | State |
| --- | --- | --- |
| `camera` | `keys: [{time, position, target, fov?, roll?, ease?, cut?}]`, `path` (`'catmull-rom'` default, `'linear'`) | `camera`: `position`, `target`, `fov` (degrees, default 60), `roll`, `up` |
| `transform` | `target`, `keys: [{time, position?, rotation?, scale?, ease?}]` | `transforms[target]`; each channel among the keys that set it; rotations slerp |
| `property` | `target`, `property`, `keys: [{time, value, ease?}]` (a number or an array) | `properties[target][property]` |
| `animation` | `target`, `clips: [{start, duration, clip, speed?, offset?, loop?, length?, blendIn?, blendOut?}]` | `animations`: clip name, clip time and blend weight |
| `audio` | `clips: [{start, duration, sound, volume?, offset?, fadeIn?, fadeOut?}]` | `audio`: sound, time into it, volume |
| `subtitle` | `clips: [{start, duration, text, speaker?}]` | `subtitles` |
| `event` | `events: [{time, name, data?}]` | fired by the player |
| `timeline` | `clips: [{start, duration, timeline, speed?, offset?}]` naming one of the document's `timelines` | the nested timeline's state, merged in |

Camera keys with `cut: true` jump instead of moving there, and the Catmull-Rom path never bends across a cut, so one
track holds a whole edit. The first unmuted camera track wins; a later transform or property track wins a channel two
tracks key. Markers name points in time; `state.marker` is the last one passed.

Nested timelines live under `timelines` and are placed by timeline clips with their own speed and offset; they may
nest (up to 16 levels, no cycles). Their tracks report paths like `intro/sfx`. A nested clip cut by the window of
its timeline clip still enters and exits, at the window's edges.

## Evaluating, scrubbing and seeking

```ts
import { Cutscene } from 'margoengine/cutscene';

const cutscene = new Cutscene({ format: 'margo-cutscene', version: 1, duration: 2, tracks: [
  { type: 'property', id: 'fade', target: 'screen', property: 'opacity', keys: [{ time: 0, value: 1 }, { time: 2, value: 0 }] },
] });
const half = cutscene.evaluate(1); // { time: 1, properties: { screen: { opacity: 0.5 } }, ... }
const passed = cutscene.eventsBetween(0, 2); // instants in the order they are passed
```

`evaluate(t)` is a pure function of the document and `t`: it keeps no playback state and returns a new object, so a
scrub bar, a seek, a reversed playback and a straight play reach exactly the same state at the same time. Documents
are validated and deep-frozen when loaded, so they cannot change underneath.

Instants are custom events, markers and clip starts (`enter`) and ends (`exit`), nested ones included, each with its
time on the top-level timeline. `eventsBetween(from, to)` returns them in a fixed order (time, then exits, markers,
events, enters, then document order); splitting a range anywhere returns the same list, so the frame rate never
changes what fires. Backwards ranges return them latest first.

## Playing

`CutscenePlayer` adds a time and a signed `speed` (negative plays backwards; `reverse()` flips it) and fires
instants as `update(delta)` passes them. `seek(t)` scrubs and fires nothing; `skip(t)` (default: the end) and
`fastForward(seconds)` fire everything on the way, in order. `loop: true` wraps at the ends. `play({signal})` returns
a promise that resolves `true` when playback finishes and `false` when paused or stopped first, and rejects with the
signal's reason on abort. Listen with `on('event' | 'marker' | 'enter' | 'exit' | 'finish' | '*', listener)` (it
returns an unsubscribe function), or stream:

```ts
import { CutscenePlayer } from 'margoengine/cutscene';

const cues = new CutscenePlayer({ format: 'margo-cutscene', version: 1, duration: 1, tracks: [
  { type: 'event', id: 'cues', events: [{ time: 0.5, name: 'flash' }] },
] });
const controller = new AbortController();
const reader = (async () => {
  for await (const event of cues.events({ signal: controller.signal })) console.log(event.name);
})();
void cues.play();
cues.update(1);
await reader; // the stream ends when the player finishes
```

A listener that seeks or skips takes over: the rest of that step's instants are not fired. `update` from inside a
listener throws `MargoError` `'state'`. `using player = new CutscenePlayer(...)` disposes it at the end of the scope.

## Virtual camera shots

`@margoengine/cutscene/shots` adds a `shot` track: name your cameras once, then write the edit as shots that cut or
blend from one to the next, instead of keying raw camera transforms. Both cameras keep moving through a blend.

```ts
import { CutscenePlayer } from 'margoengine/cutscene';
import { shotOf, shotTrack, type ShotTrack } from 'margoengine/cutscene/shots';

const edit: ShotTrack = {
  type: 'shot',
  id: 'edit',
  cameras: {
    wide: { position: [0, 3, 12], target: [0, 1, 0], fov: 50 },
    dolly: {
      keys: [
        { time: 0, position: [-6, 1.5, 4], target: [0, 1, 0] },
        { time: 4, position: [-2, 1.5, 4], target: [0, 1, 0], fov: 35 },
      ],
    },
    chase: { follow: 'hero', position: [0, 2, 5], lookAt: 'hero', lookOffset: [0, 1, 0] },
    game: { live: 'game' },
  },
  clips: [
    { start: 0, duration: 2, camera: 'game' },
    { start: 2, duration: 3, camera: 'wide', blendIn: 1.5 },
    { start: 5, duration: 4, camera: 'dolly' },
    { start: 9, duration: 3, camera: 'chase', blendIn: 1, blend: 'orbit', ease: 'easeInOutCubic' },
    { start: 12, duration: 2, camera: 'game', blendIn: 1 },
  ],
};
const heroPosition = [0, 0, 0];
const gameCamera = { position: [0, 2, 8], target: [0, 1, 0], fov: 60 };
const player = new CutscenePlayer(
  { format: 'margo-cutscene', version: 1, duration: 14, tracks: [edit] },
  {
    tracks: [
      shotTrack({
        locate: (name) => (name === 'hero' ? { position: heroPosition } : undefined),
        live: { game: () => gameCamera },
      }),
    ],
  },
);
void player.play();
player.update(1 / 60);
const { camera } = player.state; // Apply it as any camera track's state: position, target, fov, up.
const shot = shotOf(player.state); // { camera: 'game', weight: 1, track: 'edit' }
```

| Camera field | Meaning | Default |
| --- | --- | --- |
| `keys`, `path` | A camera move, the keys of a camera track with time 0 at the start of the shot | none, `'catmull-rom'` |
| `live` | A camera of the running game, from the `live` option, read at every evaluate, so a cutscene blends out of play and back | none |
| `position`, `target` | A fixed camera | `[0, 0, 0]`, needed unless `lookAt` is set |
| `follow`, `followRotation` | `position` is measured from this object, in its own axes when `followRotation` is true | none, `false` |
| `lookAt`, `lookOffset` | Aims at this object, plus the offset | none, `[0, 0, 0]` |
| `fov`, `roll` | Degrees and radians | `60`, `0` |

| Shot field | Meaning | Default |
| --- | --- | --- |
| `camera` | Key of the camera | required |
| `blendIn` | Seconds of blend from the shot before, up to the shot's `duration`; 0 is a cut | `0` |
| `ease` | Shape of the blend, any key `ease` | `'smoothstep'` |
| `blend` | `'direct'` moves the camera straight across and turns the view. `'orbit'` swings it around the point looked at, for two cameras on one subject | `'direct'` |
| `speed`, `offset` | Rate of the camera's move and seconds into it at the start of the shot | `1`, `0` |

Shots follow each other and may not overlap; in a gap the last one holds, and before the first the first shows. A
blend starts exactly on the old camera and ends exactly on the new one, and the view turns at even speed rather than
the target sliding, so the target never passes through the camera. A shot track sets `state.camera` in place of any
camera track, and the first unmuted shot track wins. Objects come from the document's transform tracks first, wherever
those tracks sit, then from `locate`; a shot needing an object or a live camera nothing provides throws a `RangeError`
naming the fix. Shots fire `enter` and `exit` like clips, and nested timelines cut them the same way. A shot has no
memory, so a follow camera sits exactly at its offset: for damped follow in play, use `@margoengine/cinematic` and
bring it in as a `live` camera.

## Render to video

`@margoengine/cutscene/render` renders a cutscene at a fixed frame rate to a WebM or MP4 file with WebCodecs, for
trailers. Time is the render's own, so a slow machine makes the same frames as a fast one. It needs
`@margoengine/headless`, and the engine must sit on a `createHeadlessCanvas` canvas of the video's size, in a browser
or worker: Node has no WebCodecs.

```ts
import { Camera, Engine, PbrMaterial, box } from 'margoengine/core';
import { Cutscene } from 'margoengine/cutscene';
import { renderCutscene } from 'margoengine/cutscene/render';
import { createHeadlessCanvas, installGPU } from 'margoengine/headless';

installGPU({ gpu: navigator.gpu });
const engine = await Engine.create(createHeadlessCanvas({ width: 1280, height: 720 }), { backend: 'webgpu' });
const cube = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#e8d44d' }));
const trailer = new Cutscene({
  format: 'margo-cutscene',
  version: 1,
  duration: 4,
  tracks: [
    { type: 'camera', id: 'cam', keys: [{ time: 0, position: [0, 1, 5], target: [0, 0, 0] }] },
    { type: 'transform', id: 'spin', target: 'cube', keys: [{ time: 0, position: [-1, 0, 0] }, { time: 4, position: [1, 0, 0] }] },
    { type: 'audio', id: 'music', clips: [{ start: 0, duration: 4, sound: 'theme', fadeOut: 1 }] },
  ],
});
const theme = await new AudioContext().decodeAudioData(await (await fetch('theme.ogg')).arrayBuffer());

const video = await renderCutscene(engine, trailer, {
  format: 'mp4',
  fps: 60,
  camera: new Camera(),
  sounds: { theme },
  apply(state) {
    cube.setPosition(state.transforms.cube.position!);
  },
  onProgress: (done, total) => console.log(`${done} of ${total}`),
});
const url = URL.createObjectURL(new Blob([video.bytes], { type: video.mimeType }));
```

| Option | Meaning | Default |
| --- | --- | --- |
| `apply(state, frame)` | Puts a frame's state on your scene; may be async | required |
| `camera` | Renders through this camera, set from `state.camera` before `apply` | the engine's, left to `apply` |
| `fps` | Frames per second; frame `i` shows `from + i / fps`, and the last starts before `to` | `30` |
| `from`, `to` | The span to render, seconds | the whole cutscene |
| `sounds` | The sounds the audio tracks name, as `AudioBuffer`s or the same shape | none: the file has no sound |
| `sampleRate`, `audioBitrate` | Of the sound | `48000`, `128000` |
| `format`, `codec`, `bitrate`, `keyFrameInterval`, `webCodecs` | As `encodeVideo` of `@margoengine/headless/video` | as there |
| `tracks` | Custom track types, for a document you pass as data | none |
| `onProgress(done, total)` | After each frame | none |
| `signal` | Stops the render; the promise rejects with its reason | none |

Pass a `CutscenePlayer` in place of the cutscene and it fires every instant in order as the frames go by, so listeners
can spawn things and the frames show them. The result is `encodeVideo`'s, with `audioCodec` when the file has sound:
Opus in WebM, and AAC or else Opus in MP4.

`mixCutsceneAudio(cutscene, sounds, { sampleRate?, channels?, from?, to? })` is the mix on its own, plain samples from
plain code, so it runs in Node. It holds every audio clip, in nested timelines too, with its volume, fades, offset and
nested speed. The mix is a sum with no limiter: `peak` above 1 means it will clip, so lower the clips' `volume`. A clip
naming a sound `sounds` does not hold is a `RangeError`. `cutsceneFrames(cutscene, { fps?, from?, to? })` gives each
frame's time and state with no engine, for a pipeline of your own.

## Recording takes

`@margoengine/cutscene/record` records live play into cutscene tracks: say what to record, call `capture()` once a
tick, and `stop()` gives a take to put in a document. It needs `@margoengine/input` only if you record input.

```ts
import { Camera } from 'margoengine/core';
import { Cutscene } from 'margoengine/cutscene';
import { TakeRecorder, appendTake, takeDocument } from 'margoengine/cutscene/record';

const camera = new Camera();
const hero = { position: [0, 0, 0], rotation: [0, 0, 0] }; // A Mesh works as it is.
let health = 100;

const recorder = new TakeRecorder({ tolerance: { position: 0.01 } });
recorder.transform('hero', hero).camera(camera).property('hero', 'health', () => health);
// recorder.input(input) records every binding of an Input; capture after input.update().

for (let tick = 0; tick < 120; tick++) {
  hero.position = [tick * 0.05, 0, 0];
  health -= 0.1;
  if (tick === 60) recorder.event('door', { open: true }).marker('halfway');
  recorder.capture(tick / 60); // Your fixed-step clock; with no argument the wall clock runs.
}
const take = recorder.stop();
console.log(take.kept['transform-hero']); // { samples: 120, keys: 1 or more, far fewer than the samples }

const cutscene = new Cutscene(takeDocument(take));
const position = cutscene.evaluate(1).transforms.hero.position;
const longer = appendTake({ format: 'margo-cutscene', version: 1, duration: 3, tracks: [] }, take, { at: 1 });
```

| Record | Source | Comes out as |
| --- | --- | --- |
| `transform(name, source)` | A `Mesh`, anything with `position`, `rotation` or `scale`, or a function giving them; 3 rotation values are Euler radians as a `Mesh` holds them, 4 a quaternion | `transform` track `transform-<name>` |
| `camera(source)` | A `Camera`, or a function giving `position`, `target`, `fov` and `roll` | `camera` track `camera` with a straight-line path |
| `property(target, name, read)` | A function giving a number or a numeric array | `property` track `property-<target>-<name>` |
| `input(input, { target? })` | An `Input`; it starts at the next capture | one stepped `property` track for each binding (`state.properties.input.jump`, later bindings `jump#1`), and an event track with `jump` as a binding leaves 0 and `jump:up` as it comes back |
| `event(name, data?)`, `marker(name)` | Noted at the time of the last capture | `event` track `events`, the take's `markers` |

Keys are thinned on the track's own straight-line interpolation (Ramer-Douglas-Peucker), so every captured sample
stays within the tolerance of what the tracks play: `position` (world units, also the camera's position and target),
`rotation` (radians), `scale` and `value` (properties and fields of view, on each component), each default `0.001`. A
tolerance of 0 keeps every change a straight line cannot explain. Input is never thinned. `take.kept` says how many
samples each track came from. Signs of quaternions are put on one side, so a source that flips them still turns the
short way. A recorded rotation is a quaternion: apply it with `mesh.setQuaternion`, and the mesh's world matrix comes
back as it was.

`takeDocument(take)` makes the take a document; `appendTake(document, take, { at?, prefix? })` gives a new document
with it added at a time, longer if it must be, and a `prefix` lets a second take of one object sit beside the first.
`inputTracks(clip, { at?, target? })` turns a saved `InputRecorder` clip of `@margoengine/input/replay` into the same
tracks. A sample that is not finite is a `RangeError`, and so is a capture time going backwards. `stop()` with nothing
captured and any use after `stop()` throw `MargoError` `'state'`.

## Custom tracks

`shotTrack()` is a `CutsceneTrackType`, and you can write your own for anything a document should hold: pass types in
the `tracks` option of `Cutscene` or `CutscenePlayer`, and a document using a type you did not pass is refused. A type
gives `validate(track, check)`, `evaluate(track, time, state, path)` and optionally `instants(track)`. It runs after
the built-in tracks, reads what they set, and puts its own results in `state.extras`.

```ts
import { Cutscene, type CutsceneTrackType } from 'margoengine/cutscene';

const weather: CutsceneTrackType = {
  type: 'weather',
  validate(track, { path, add }) {
    if (typeof track.rain !== 'number') add(`${path}.rain`, 'must be a number');
  },
  evaluate(track, time, state) {
    (state.extras ??= {}).rain = (track.rain as number) * time;
  },
};
const scene = new Cutscene(
  { format: 'margo-cutscene', version: 1, duration: 2, tracks: [{ type: 'weather', id: 'storm', rain: 0.5 }] },
  { tracks: [weather] },
);
const rain = scene.evaluate(1).extras?.rain; // 0.5
```

## Saving and validating

```ts
import { Cutscene, validateCutscene } from 'margoengine/cutscene';

const text = JSON.stringify({ format: 'margo-cutscene', version: 1, duration: 3, tracks: [] });
const problems = validateCutscene(JSON.parse(text)); // [] when valid, else [{path, message}]
const loaded = new Cutscene(text);
```

`validateCutscene` never throws and lists every problem with its path and fix (`tracks[0].keys[1].time: is earlier
than the one before; sort the list by time`). `new Cutscene`, `parseCutscene` and `new CutscenePlayer` throw a
`TypeError` naming the first one. Bad arguments throw `RangeError` (`Cutscene time must be a finite number of
seconds`); use after `dispose()` throws `MargoError` `'disposed'`.

Apache-2.0. Optional, tree-shakable package; no core dependency.

Build and unit tests: npm test --workspace @margoengine/cutscene
