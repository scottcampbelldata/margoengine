# @margoengine/tween

Import `margoengine/tween` from the `margoengine` package, or `@margoengine/tween` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Numeric property interpolation and easing; `update` steps the existing tracks in place and creates no per-track objects.

```ts
import {Tween, easeInOutCubic} from 'margoengine/tween';
declare const object: {opacity: number};
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

## smoothDamp: follow a moving target

`smoothDamp(current, target, velocity, smoothTime, maxSpeed, dt, out)` eases a vector (a camera, a follower, a hand) toward a target with no oscillation, and keeps its `velocity` between frames so a moving target stays smooth. It is a critically damped spring solved exactly, so any frame time is stable, and it works on `Float32Array`, `Float64Array` or plain arrays of any length without creating objects.

```ts
import {smoothDamp} from 'margoengine/tween';
const position = new Float32Array(3), velocity = new Float32Array(3), target = new Float32Array([0, 1.6, 4]);
const frame = (dt: number) => smoothDamp(position, target, velocity, 0.3, 6, dt, position); // 0.3 s to arrive, at most 6 units/s
frame(1 / 60);
```

- `smoothTime` is roughly the seconds to arrive. Zero lands on the target at once and zeroes `velocity`.
- `maxSpeed` limits the length of the whole velocity vector (units per second), so the direction of travel is kept. Pass `Infinity` for no limit; 0 holds the point still.
- Each component matches a `Spring` with stiffness `(2 / smoothTime)^2` and damping `4 / smoothTime`, so a velocity heading toward the target can overshoot once, as the spring does.
- `dt` 0 copies `current` to `out` and leaves `velocity` alone; a negative, NaN or infinite `dt`, a non-finite value or mismatched lengths throw `RangeError`. A very long `dt` arrives at rest instead of producing NaN.

## Stagger: one tween across many targets

`stagger` from `margoengine/tween/stagger` starts the same tween on every target, each a little later than the one before:

```ts
import {Tween, Timeline, easeOutBack, easeInQuad} from 'margoengine/tween';
import {stagger, staggerTimeline} from 'margoengine/tween/stagger';

const lamps = Array.from({length: 12}, () => ({intensity: 0}));
const tween = new Tween();

// 0.05 s between neighbours, from the middle of the row outwards.
const cancel = stagger(tween, lamps, 'intensity', 3, {
  duration: 0.5,
  easing: easeOutBack,
  stagger: {each: 0.05, from: 'center'},
  onComplete: () => console.log('all lit'),
});
tween.update(1 / 60);

// The same on a timeline, with the whole spread given as 0.6 s and the starts bunched towards the end.
const cards = Array.from({length: 8}, () => ({opacity: 0}));
const timeline = new Timeline().label('in');
staggerTimeline(timeline, cards, 'opacity', 1, {duration: 0.4, at: 'in', stagger: {amount: 0.6, easing: easeInQuad}});
timeline.play();
```

| `stagger` option | Meaning | Default |
| --- | --- | --- |
| `each` | Seconds between neighbours. A bare number, `stagger: 0.05`, means this. | 0.1 |
| `amount` | Seconds from the first start to the last, shared across the targets. Give this or `each`. | |
| `from` | `'start'`, `'end'`, `'center'`, `'edges'`, `'random'` or a target's index. | `'start'` |
| `easing` | Bends the spread: the order in, a share of the total out. A result below 0 counts as 0. | even |
| `grid` | `[columns, rows]`: targets read row by row, and the spread goes by distance from a cell. | none |
| `seed` | Seed of `from: 'random'`; the same seed gives the same order. | 1 |

- `to` can be a function, `(target, index) => number`, for a different end value each.
- `delay` is added to every target, and `repeat`, `yoyo` and `onRepeat` reach each one. `onComplete` runs once, after the last to finish, or at once with no targets.
- The function returned cancels them all. If `Tween.to` refuses one target, none is left running.
- `staggerDelays(count, options)` returns just the offsets as a `Float64Array`.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/tween

## Speed

10,000 `spring.update(dt)` calls take 0.28 ms in Node on the development PC, with no allocation per call, so a spring per object is fine:

```ts
import {Spring} from 'margoengine/tween';

const springs = Array.from({length: 10000}, () => new Spring({stiffness: 120, damping: 12}));
const frame = (dt: number) => {
  for (const spring of springs) spring.update(dt);
};
frame(1 / 60);
```
