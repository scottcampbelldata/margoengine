# @margoengine/tween

Install `npm i margoengine` and import `margoengine/tween` (or this package alone: `npm i @margoengine/tween`, imported as `@margoengine/tween`; the two are the same module).

Numeric property interpolation and easing; `update` steps the existing tracks in place and creates no per-track objects.

```ts
import {Tween, easeInOutCubic} from 'margoengine/tween';
const timeline = new Tween();
const cancel = timeline.to(object, 'opacity', 1, {duration: 0.5, easing: easeInOutCubic});
timeline.update(1 / 60);
```

Times are seconds. delay, onComplete, zero-duration tracks and cancellation are supported. A new track for the same object/property cancels the old one. Callback-created tracks begin next update; clear cancels all tracks. Completed/cancelled tracks compact in place. Track creation and callbacks can allocate; the in-place stepping above does not cover them. Targets are numeric writable properties; for colours, quaternions and paths use `array`, `path` or `custom` (below). CSS strings are not parsed.

## Repeat, yoyo, easings, springs, timelines, colours, paths

```ts
import {Tween, Timeline, Spring, easeOutBack, cubicBezier, parseHexColor, toHexColor, slerpArray, catmullRomPath} from 'margoengine/tween';
declare const light: {intensity: number}, door: {angle: number}, camera: {position: number[]}, node: {rotation: number[]};
const tween = new Tween();
tween.to(light, 'intensity', 3, {duration: 1, repeat: Infinity, yoyo: true, easing: cubicBezier(0.25, 0.1, 0.25, 1)});
const colour = parseHexColor('#ff0000');
tween.array(colour, parseHexColor('#0000ff'), {duration: 2}); // toHexColor(colour) while it runs
tween.array(node.rotation, [0, 0.7071, 0, 0.7071], {duration: 1, interpolate: slerpArray}); // quaternions
tween.path(camera.position, catmullRomPath([[0, 0, 0], [1, 2, 0], [3, 2, 1]]), {duration: 3});
tween.custom((progress) => console.log(progress), {duration: 1, easing: easeOutBack});

const timeline = new Timeline({repeat: 1})
  .to(door, 'angle', 1.5, {duration: 0.6})
  .label('open')
  .to(light, 'intensity', 3, {duration: 0.4, at: 'open'})
  .call(() => console.log('opened'))
  .play();

const spring = new Spring({stiffness: 120, damping: 12});
spring.target = 1;
const frame = (dt: number) => { tween.update(dt); timeline.update(dt); return spring.update(dt); };
```

- `repeat` (integer or `Infinity`), `yoyo` and `onRepeat` work on every tween kind.
- Easings: `ease{In,Out,InOut}` of `Quad`, `Cubic`, `Quart`, `Quint`, `Sine`, `Expo`, `Circ`, `Back`, `Elastic`, `Bounce`, plus `cubicBezier(x1, y1, x2, y2)` (CSS timing function) and `steps(n)`.
- `Spring` steps the exact damped-oscillator solution, so any frame time is stable and a new `target` keeps the velocity.
- `Timeline` chains tweens and callbacks with labels (`at: 'open+0.2'`), `seek`, `pause`, `reverse`, `speed`, `repeat` and `yoyo`. A property's start value is read when the playhead first reaches its entry; seeking back restores values. Callbacks run on `update`, never on `seek`.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/tween

