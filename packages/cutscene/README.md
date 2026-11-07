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
