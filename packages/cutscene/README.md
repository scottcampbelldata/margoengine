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

## Seeking a world to film time

A film rendered scene by scene starts each scene in a fresh process. The clouds, wind, waves, wetness and lightning
all add up frame deltas, so without help they restart at 0 at every cut and the sky jumps. `@margoengine/cutscene/seek`
brings a fresh world to film time T: it replays every clock's `advanceTime(1 / fps)` in the same order a continuous run
made, without drawing, so the next frame draws what a run started at 0 draws at T, bit for bit.

```ts
import { Engine, type EngineKernel } from 'margoengine/core';
import { seek } from 'margoengine/cutscene/seek';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
// A time-driven plugin: its frame update runs advanceTime, so a live frame and a replayed step do the same sums.
class Drift {
  name = 'drift';
  time = 0;
  offset = 0;
  setup(_engine: EngineKernel) {}
  advanceTime(delta: number) {
    this.time += delta;
    this.offset += delta * 8;
  }
  onPreUpdate(delta: number) {
    this.advanceTime(delta);
  }
}
engine.use(new Drift());
// Scene 2 starts 95 s into the film: replay the clocks to there, then draw on as a continuous run would.
const { steps, clocks, unseekable } = await seek(engine, 95, { fps: 30 }); // 2850, ['drift'], []
engine.render({ delta: 1 / 30 });
```

- A clock is any plugin with `advanceTime(delta)` and a `time` getter (seconds since it started). `advanceTime` is the
  CPU part of its frame update only: no GPU call, no listener call (a replayed lightning strike stays silent).
- `seek(engine, seconds, { fps = 60, steps, scenes, extra, onStep, signal })` runs `Math.round(seconds * fps)` steps
  of `1 / fps` (or the `steps` you list, each 0 to 1 second: the deltas a sub-framed film's renders gave, from
  `subFrameSteps` of `@margoengine/headless/accumulate`) over the
  plugins of each scene (default `[engine.scene]`) in attach order, then `extra` (clocks that are not plugins, such as
  an unattached `WeatherMachine`). `onStep(step, time)` runs before each step, so film code can set what the clocks
  read (a wind, a rate) as it did live. It resolves with the steps, the clocks it moved and `unseekable`: plugins with
  a frame update but no `advanceTime`, which restart at a seek.
- Every clock must read 0: seek a fresh world once, before its first frame. A clock that already moved throws a
  `MargoError` with code `state` ([film-seek](https://margoengine.com/errors#film-seek)).
- `advanceTime(engine, delta, { scenes, extra })` runs one step, for a host that runs its own loop.
- `seekSync(engine, seconds, options)` is the same seek without waiting (no `onStep`), for code that cannot await.
- `renderCutscene(engine, cutscene, { from })` with `from` after 0 seeks the engine first, in steps of the render's
  `1 / fps` (with `samples` or `shutter`, the sub-frames' own steps), so its first frame equals the frame at `from`
  of a render from 0; `cutsceneFrames(cutscene, { from,
  engine })` does the same when you pass the engine you draw with. Until 2026-11-16 both started every clock at 0.
- Cost: steps x clocks calls, CPU only: 15 minutes at 60 fps is 54,000 steps. Rates of 1 or more steps per second.
- Exact only for state that is a clock. History on the GPU (particles alive, foam, ripples) and history of the view
  (TAA, auto exposure) come from the scene's own warm-up frames; `docs/limits.md` lists each with its bound.

### Several scenes in one process

A render worker that keeps one process for several scenes (fresh processes cost 2 to 3 s each) puts the clocks back
to 0 with `resetClocks(engine)` and then seeks the next scene's start time (GAP-FILM-RESET):

```ts
import { Engine } from 'margoengine/core';
import { resetClocks, seekSync } from 'margoengine/cutscene/seek';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
seekSync(engine, 95, { fps: 30 }); // scene 2
engine.render({ delta: 1 / 30 });
// Scene 3 starts at 40 s: back to 0, then the seek a fresh world would make.
const { clocks, unresettable } = resetClocks(engine);
seekSync(engine, 40, { fps: 30 });
engine.render({ delta: 1 / 30 });
```

- A clock that can go back has `resetTime()`: its time, counters, seeds and history (TAA, auto exposure, fog history)
  return to what a new one with the same options holds; its options and GPU resources stay. A seek after the reset
  then gives what a fresh world seeked as far gives.
- `resetClocks(engine, { scenes, extra })` runs `resetTime` on every clock of the scenes and `extra`, and returns the
  `clocks` it reset and `unresettable`: clocks with no `resetTime` yet and plugins with a frame update but no clock.
  Those keep their time, so a seek after the reset refuses the clocks among them; use a fresh process while a scene
  holds one.
- Clocks with `resetTime` today: `TAA`, `TAAUpscale`, `Tonemap`, `Shadows`, `VirtualShadows` (and their
  `lightPattern`), `HeatHaze`, `Stylize`, `Reflector`, `Refractor`, `VolumetricFog`, `Lines` and `Trail`, creative
  `PostProcessing`, `LODSystem`, `XRaySelection`, `ShaderClock`, `Scatter` and `ScatterInstances`, every sky clock
  (`Sky`, `HillaireSky`, `AstroSky`, `Aurora`, `TornadoCloud`, `VolumetricClouds`, `Weather`), every water clock
  (`Water`, `FFTOcean`, `WaterFlow`, `WaterRain`, `ShipWakes`, `ShotSplash`, `Floater`, `Iceberg`, `SeaIce`, `Flood`)
  every vfx clock (`VFX`, `BlownSand`, `Clouds`, `Flame`, `Smoke`, `FireFront`, `Battery`, `HullFire`) and every
  weather clock (`WeatherMachine`, `WeatherDrive`, `WeatherRegions`, `Hail`, `LensDrops`, `Puddles`, `GLTFWeather`,
  `Eruption`, `LavaFlow`, `Avalanche`, `SnowDrift`). The rest are listed in
  `tests/film-reset-pending.json`, which only shrinks.

## Film captions and chapter cards

A documentary shows its words on film time: captions under the narration, a chapter card at each chapter ("03 / 13",
the title and a place and date line) and a closing card. `@margoengine/cutscene/film-titles` draws them with
`@margoengine/ui`, as a pure function of film time, so a film rendered shot by shot (each shot a fresh page started at
its own film time) shows exactly what one continuous run shows at that second.

```ts
import { Engine } from 'margoengine/core';
import { FilmTitles, filmTitlesAt } from 'margoengine/cutscene/film-titles';
import { parseSrt } from 'margoengine/text/captions';
import { Ui, UiRenderer } from 'margoengine/ui';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const ui = new Ui({ scale: { reference: [1920, 1080], match: 0.5 } });
UiRenderer.attach(engine, ui);
const srt = '1\n00:00:01,000 --> 00:00:04,000\nNovember 1944.\n';
const titles = new FilmTitles(ui, {
  title: 'Fauld',
  cues: parseSrt(srt).cues,
  chapters: [
    { start: 0, title: 'Cold open', card: false },
    { start: 43, title: 'Gentle country', place: 'Fauld, Staffordshire, 1944' },
  ],
  chapterCount: 13,
  closing: { start: 880 },
});
// A shot that starts 44 s into the film shows the card "01 / 13" from its first frame.
let filmTime = 44;
engine.onFrame((_, dt) => {
  filmTime += dt;
  titles.update(filmTime);
});
filmTitlesAt(titles.spec, 2).caption; // { text: 'November 1944.', opacity: 1 }
```

- Cues are `{ start, end, text }`, `[start, end, text]` tuples or the cues of `@margoengine/text/captions`
  (`{ start, end, lines }`, lines joined by newlines), in seconds, `end` exclusive; order does not matter, and where two
  overlap the one that starts first shows.
- Captions and cards fade in over `fadeIn` (default 0.22 s) and out over `fadeOut` (default 0.24 s), each held inside
  half of a short cue so it still reaches full opacity. The closing card fades in over `closingFade` (default 1 s) and
  stays.
- Chapters are in film order. A card numbers each chapter by its place in the list from `firstNumber` (default 0, so a
  cold open is 00) unless it sets `number`; the count is `chapterCount` (default the highest number), both padded to
  two digits. A card holds `chapterHold` seconds (default 4, or the chapter's `hold`) and ends early at the next
  chapter; `card: false` shows none.
- The closing card's lines default to `defaultClosingLines(title)`: "Made with Margo Engine", the title and "Please
  subscribe"; pass `closing.lines` (`{ text, size, color }`) for others.
- The third argument sets the looks (`captionSize` 39, `titleSize` 64, `placeSize` 32, `numberSize` 30, `background`
  `#111a23cf`, `captionMargin` `[0, 0, 74, 97]`, `cardMargin` `[0, 0, 200, 98]`, for a 1920 by 1080 reference UI).
- A bad spec throws a `TypeError` when it is made ([film-titles](https://margoengine.com/errors#film-titles));
  `checkFilmTitles(spec)` checks one without drawing. `dispose()` (or `using`) removes the panels from the UI, and
  `update` after it throws a `MargoError` with code `disposed`.

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
| `samples` | Renders per frame, averaged in linear light (`renderFrames` of `@margoengine/headless/video`): anti-aliasing, and motion blur with `shutter` | `1` |
| `shutter`, `shutterPhase` | Share of the frame interval the shutter is open (0 to 1), and `'start'`, `'center'` or `'end'` of it against the frame's time | `0`, `'start'` |
| `filter`, `filterWidth`, `seed`, `pattern`, `accumulate` | As `renderAccumulated` of `@margoengine/headless/accumulate`: pixel filter, sample pattern, your `Accumulate` stage | as there |
| `onProgress(done, total)` | After each frame | none |
| `signal` | Stops the render; the promise rejects with its reason | none |

With `samples` or `shutter`, `apply` and the camera run before every render at that render's own time inside the
open shutter, so everything you move blurs, and a player fires each instant at the first render past it. Times before
the cutscene's start (a `'center'` shutter on frame 0) show its first instant.

```ts
const film = await renderCutscene(engine, trailer, {
  fps: 24,
  samples: 16, // 16 renders a frame
  shutter: 0.5, // a 180 degree shutter
  camera: new Camera(),
  apply(state) {
    cube.setPosition(state.transforms.cube.position!);
  },
});
```

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

## Dialogue and lip sync

`@margoengine/cutscene/lipsync` adds a `lipsync` track: timed phonemes go in, weights for 15 visemes come out as a pure
function of the time, so scrubbing moves the mouth as playing does. Phonemes come from a tool (a forced aligner gives
the best mouth), or `analyseSpeech` reads them out of the dialogue audio itself.

```ts
import { CutscenePlayer } from 'margoengine/cutscene';
import { analyseSpeech, lipSyncTrack, mouthOf, mouthShapes, type LipSyncTrack } from 'margoengine/cutscene/lipsync';

const dialogue: LipSyncTrack = {
  type: 'lipsync',
  id: 'ada-lines',
  target: 'ada',
  clips: [
    // Phoneme data: ARPAbet, with or without stress digits, or viseme names. Times are from the start of the clip.
    {
      start: 0.5,
      duration: 1,
      phonemes: [
        { time: 0, phoneme: 'HH' },
        { time: 0.1, phoneme: 'AH0' },
        { time: 0.2, phoneme: 'L' },
        { time: 0.3, end: 0.7, phoneme: 'OW1' },
      ],
    },
  ],
};
// Or from audio: an AudioBuffer's channel gives the samples.
const rate = 16_000;
const speech = new Float32Array(rate).map((_, i) => 0.5 * Math.sin(i / 3) * Math.sin(i / 900));
dialogue.clips.push({ start: 2, duration: 1, phonemes: analyseSpeech(speech, rate) });

const player = new CutscenePlayer(
  { format: 'margo-cutscene', version: 1, duration: 4, tracks: [dialogue] },
  { tracks: [lipSyncTrack()] },
);
void player.play();
player.update(0.9);
const mouth = mouthOf(player.state, 'ada'); // { oh: 1 }
const shapes = mouthShapes(mouth, 'vrm'); // { oh: 1 }: VRM's five mouth expressions
```

| Field | Meaning | Default |
| --- | --- | --- |
| `target` | The character, the key `mouthOf` reads | required |
| `blend` | Seconds a mouth takes to move into and out of a sound | `0.06` |
| clip `phonemes` | `{ time, end?, phoneme, weight? }` sorted by `time`; `end` defaults to the next sound's time, and `weight` (0 to 1) to 1 | required |
| clip `gain` | Scale on every weight | `1` |

The visemes are `sil PP FF TH DD kk CH SS nn RR aa E ih oh ou`, the names game and avatar tools use (`VISEMES`, and
`visemeOf(phoneme)` for one sound). Weights of neighbouring sounds cross over the blend and never sum past 1; what is
left of 1 is the mouth at rest, so a line opens into its first sound and closes after its last with no jump. Two
tracks on one character add up, within 1. Clips fire `enter` and `exit`, named after the character, and nest in
timelines like any clip. `visemesAt(clip, t, blend?)` is the same reading with no document.

`mouthShapes(weights, set)` turns weights into blend shapes to set. `'visemes'` (default) names them `viseme_aa` and
so on, as avatar tools do. `'vrm'` gives the VRM 1.0 presets `aa ih ou ee oh`, for `vrm.expressions.set` of
`@margoengine/rigging/vrm`. `'arkit'` gives Apple's face shape names, a frame `face.push` of
`@margoengine/rigging/face` takes as it is. Each sound's mix of shapes is a choice of ours, not a standard.

`analyseSpeech(samples, sampleRate, { step?, floor?, shortest? })` needs no words and no transcript. It finds silence
by level, hiss by its share of high sound, and each vowel's mouth from its formants, by linear prediction, on a chart
scaled to the speaker. It is a rough mouth, not a transcript: it tells closed, hiss and open apart but no other
consonants, a pause under about 70 ms goes unseen, and it gets about half of vowel frames right. Use phonemes from an
aligner when the mouth must be exact.


## Particle effects and activation

`@margoengine/cutscene/vfx` adds a `vfx` track that starts, stops and bursts particle effects on the timeline, and an
`activation` track that shows and hides objects. Both are pure, as every track is. Particles have a past, so
`VfxDirector` turns the state into starts, stops and bursts, and a seek runs the same frames again.

```ts
import { Engine } from 'margoengine/core';
import { Cutscene, CutscenePlayer } from 'margoengine/cutscene';
import { VfxDirector, activationTrack, applyActivation, vfxTrack } from 'margoengine/cutscene/vfx';
import { VFX } from 'margoengine/vfx';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const sparks = VFX.attach(engine, { capacity: 10_000, lifetime: [0.5, 1.5], velocity: [0, 3, 0] });
const door = engine.createMesh();

const cutscene = new Cutscene(
  {
    format: 'margo-cutscene',
    version: 1,
    duration: 6,
    tracks: [
      {
        type: 'vfx',
        id: 'fire',
        target: 'sparks',
        clips: [{ start: 1, duration: 3, rate: 800, bursts: [{ time: 0.5, count: 2000 }] }],
      },
      { type: 'activation', id: 'door-on', target: 'door', clips: [{ start: 2, duration: 4 }] },
    ],
  },
  { tracks: [vfxTrack(), activationTrack()] },
);
const player = new CutscenePlayer(cutscene);
const director = new VfxDirector(cutscene, { sparks }, { step: (delta) => engine.render({ delta }) });

// Each frame, in this order:
function frame(delta: number): void {
  player.update(delta);
  director.apply(player.state);
  applyActivation(player.state, { door });
  engine.render({ delta });
}
void player.play();
frame(1 / 60);

player.seek(3.2); // A scrub, however far: the frame drawn next is the one playing to 3.2 s shows.
director.apply(player.state);
engine.render({ delta: 1 / 60 });
```

| Field | Meaning | Default |
| --- | --- | --- |
| `vfx` `target` | The effect's name in the director | required |
| `vfx` clip `rate` | Births a second while the clip runs | the rate the effect had when the director took it |
| `vfx` clip `bursts` | `{ time, count }` sorted by time, seconds into the clip | none |
| `activation` `target`, `clips` | The object, and spans it shows | required |
| `activation` `invert` | Hides it during the spans instead | `false` |
| director `step(delta)` | Draws one frame of the replay. Required | |
| director `stepSize` | Seconds of a replay frame: use your frame time | `1 / 60` |
| director `longest` | Seconds a seek replays at most | `10` |

`effectsOf(state)` and `activeOf(state)` give the plain state, for an effect or object of your own; clips fire `enter`
and `exit`, and bursts fire an event `<target>:burst` with `{ count }`. The director needs only `options.rate`,
`burst(count)` and `reset()`, so `VFX` of `@margoengine/vfx` fits and so does your own. Objects you do not pass to
`applyActivation` are left alone, and a `Mesh` fits as it is.

The director holds an effect off until a clip. Playing, an effect a clip finds empty starts fresh, so its random
numbers depend on the cutscene alone. A frame that is not the next one (a seek, a step back, a leap past 8 frames)
wipes the effects and plays again from when they were last empty, through as many clips as still have particles alive
by `options.lifetime`. It costs one drawn frame for each step of replay. With the same `stepSize` as your frames it
lands on the same particles, byte for byte; with frames of another length it lands near them. Past `longest` it starts
that far back, so the particles are alike in kind only. Playing backward is a seek on every frame. A pause stops the
cutscene and not the particles: stop drawing, or `delta` 0, to hold them.


## Timeline editor

`@margoengine/cutscene/editor` is an optional panel for authoring in your own page: scrub, zoom, snap, and add, move
and delete keys, clips, events and markers with undo. Margo has no visual editor by design, so this stays a separate
tool: nothing else in the package imports it. It needs `@margoengine/inspector` for its undo stack.

```ts
import { CutscenePlayer } from 'margoengine/cutscene';
import { TimelineEditor } from 'margoengine/cutscene/editor';

const editor = new TimelineEditor(
  {
    format: 'margo-cutscene',
    version: 1,
    duration: 8,
    tracks: [
      { type: 'transform', id: 'door', target: 'door', keys: [{ time: 1, position: [0, 0, 0] }, { time: 3, position: [2, 0, 0] }] },
      { type: 'audio', id: 'music', clips: [{ start: 0, duration: 6, sound: 'theme' }] },
    ],
  },
  { parent: document.body, zoom: 120 },
);

let player = new CutscenePlayer(editor.model.cutscene());
editor.on('seek', (time) => player.seek(time)); // The scene follows the scrub.
editor.on('change', () => {
  player = new CutscenePlayer(editor.model.cutscene()); // A document is frozen once loaded, so edits make a new one.
  player.seek(editor.time);
});
localStorage.setItem('intro', editor.model.save());
```

Pass `tracks` for custom track types, as for `Cutscene`; their clips show and move like any others.

| Option | Meaning | Default |
| --- | --- | --- |
| `parent` | Where the panel goes; or place `editor.element` yourself | none |
| `zoom` | Pixels a second, 10 to 2000 | `100` |
| `step` | Grid in seconds, also what an arrow key moves | `0.1` |
| `snap` | Snap to the grid, other items and the playhead while dragging | `true` |
| `fileName` | Name of the file the Export button saves | `'cutscene.json'` |
| `tracks`, `history` | Custom track types, and an `EditHistory` to share with your tool | none, a new one |

Drag the ruler to scrub and an item to move it; Shift or Ctrl adds to the selection and a selection moves together.
Ctrl and the wheel zoom about the pointer. Every action is on the keyboard too, and each item is a button a screen
reader names:

| Key | Does |
| --- | --- |
| Left, Right | Moves the selection a step, or the playhead with nothing selected; Shift makes it ten |
| Home, End | Playhead to the ends |
| K | Adds a key at the playhead on the current row, the one last clicked |
| Delete, Backspace | Deletes the selection |
| Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y | Undo and redo; Cmd works too |
| +, - | Zoom |
| Escape | Clears the selection |

`editor.on('seek' | 'select' | 'change', listener)` returns an unsubscribe function; `editor.time`, `editor.zoom` and
`editor.selection` read and set; `dispose()` or `using` removes it. The panel's colours are CSS variables on `.mtl`
(`--bg`, `--panel`, `--line`, `--text`, `--dim`, `--accent`, `--clip`).

`editor.model` is a `TimelineModel`, the editing itself with no DOM, so it runs in Node and in your own panel:

```ts
import { MARKERS, TimelineModel } from 'margoengine/cutscene/editor';

const model = new TimelineModel({
  format: 'margo-cutscene',
  version: 1,
  duration: 8,
  tracks: [{ type: 'property', id: 'fade', target: 'screen', property: 'opacity', keys: [{ time: 0, value: 1 }, { time: 4, value: 0 }] }],
});
const key = model.addKey('fade', 2); // Holds 0.5, what the track gives there.
const [moved] = model.moveItems([key], 0.5);
model.setItem(moved, { value: 0.25, ease: 'easeOutCubic' });
model.addKey(MARKERS, 6, { name: 'reveal' });
model.undo();
model.redo();
const text = model.save(); // JSON text; new Cutscene(text) reads it.
```

| Member | Does |
| --- | --- |
| `rows` | Each track with its items, then the markers row (`MARKERS`) |
| `addKey(track, time, fields?)` | A key holding the track's value there, or an event or marker; `addItem(track, item)` adds a whole key or clip |
| `moveItems(items, delta)` | Moves them together, stopping at the ends of the timeline, and gives their new refs |
| `setItem(ref, fields)`, `deleteItems(items)`, `setDuration(seconds)` | Give false when the document refuses, and then change nothing |
| `begin(label)`, `commit()` | A run of edits that undoes as one, such as a drag |
| `undo()`, `redo()`, `history` | The `EditHistory` behind them |
| `snap(time, { step?, reach?, ignore?, times? })` | The time to use: on an item or given time within `reach`, else on the grid |
| `on('change', listener)` | After every change, undo and redo included |
| `document`, `toJSON()`, `save()`, `cutscene()` | A copy, for `JSON.stringify`, JSON text, a `Cutscene` to play or render |

Every edit leaves a valid document: one that would break it, such as two shots overlapping or a track's last key
going, is refused whole. Refs are places in a list, so use the ones the last edit gave. What is inside a nested
timeline does not show: its clip moves as one piece, and to edit inside it, open that timeline as a document of its
own. There is no curve editor, and clip lengths and key values are set by `setItem`, not by dragging.


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
