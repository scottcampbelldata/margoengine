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
