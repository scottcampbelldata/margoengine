# @margoengine/tween

Import `margoengine/tween` from the `margoengine` package, or `@margoengine/tween` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Numeric property interpolation and easing; `update` steps the existing tracks in place and creates no per-track objects.

## Choose a clock and entry

The root Tween and Timeline remain the small numeric API. Additional workflows use
explicit imports from `@margoengine/tween/<entry>` or `margoengine/tween/<entry>`:

| Entry | API | Clock owner |
|---|---|---|
| `async` | AsyncTween, AsyncTimeline | Caller calls update in seconds. |
| `props` | to, from, fromTo, keyframes | Each returned operation has update. |
| `timeline` | Timeline with arrays, paths, custom clips and nesting | Caller updates the parent. |
| `control` | TweenControl with target/property ownership | Caller updates the control world. |
| `scroll-pin` | pinTimeline, scrollSnapPoint | The link owns scroll listeners and requestAnimationFrame. |
| `inertia` | VelocityTracker, inertia | Caller supplies sample times and update deltas in seconds. |

These imports do not start a clock or install listeners. Only attaching a scroll link
takes browser input ownership. Do not advance the same operation from both a world or
parent and an independent frame loop. Handle completion rejections when cancelling,
replacing or disposing awaitable work; cancellation preserves the last written values.

## Awaitable operations

`AsyncTween` provides the root Tween's to, array, path and custom methods as awaitable
tasks. A returned TweenTask is also a cancel function; it exposes `finished`,
`cancel(reason)` and Symbol.dispose. Completion resolves; abort, replacement, clear or
an update failure rejects. An AbortSignal rejects with its exact reason; explicit
cancellation defaults to AbortError. A replacement on the same target/property rejects
the previous task. Invalid input is checked before valid work is replaced.

Call `driver.update(deltaSeconds)` from the application loop. Awaiting a task does not
advance it. `driver.finished` captures operations active when it is read; tasks added
later are independent. Callback-created work starts on the next update. Recursive
update is rejected. `clear()` or disposal cancels all active tasks. Timing options
match the root Tween: required nonnegative duration, delay 0, linear easing, repeat 0,
yoyo false and optional completion/repeat callbacks; signal defaults to unset.

`AsyncTimeline` wraps the root scalar Timeline with `finished` and then support,
signal cancellation and disposal. Its to, label, call, seek, reverse, pause, play and
update follow the root API. Pause and seek do not settle completion. Replaying a
settled run creates a fresh finished promise; save or await the promise for that run.
An already-aborted signal also cancels a replay. Playback callbacks run during update,
not during seek. Cancelling pauses the timeline and leaves sampled values in place.


```ts
import {AsyncTween, AsyncTimeline} from '@margoengine/tween/async';
const target = {x: 0};
const driver = new AsyncTween();
const task = driver.to(target, 'x', 10, {duration: 1});
driver.update(1); // Application clock, seconds. Await alone does not advance it.
await task;
if (target.x !== 10) throw new Error('Tween did not finish');
const timeline = new AsyncTimeline().to(target, 'x', 20, {duration: 1}).play();
timeline.update(1);
await timeline.finished;
const controller = new AbortController();
const cancelled = driver.to(target, 'x', 30, {duration: 1, signal: controller.signal});
const observed = cancelled.finished.catch(reason => console.log(reason.name));
controller.abort();
await observed;
driver.clear();
```

## Multiple properties and keyframes

The `props` entry's `to(target, values, options)`, `from(target, values, options)` and
`fromTo(target, start, end, options)` animate finite numeric writable properties,
including a Vector3's x/y/z. Destinations may be numbers or relative strings using
+=, -=, *= or /=. Relative scalars resolve against the captured starting value;
relative entries in a keyframe value list resolve against the preceding value.
Nonfinite arithmetic, including division by zero, rejects.

`from` and `fromTo` write their starts immediately. An explicit property keyframe list
also writes its first value immediately, including during a delay; a scalar `to` waits
for update. Lists need at least two values and distribute offsets evenly.
`keyframes(target, frames, options)` accepts frames with values, optional offset in
0..1 and optional per-segment easing. Missing first/last offsets default to 0/1;
interior omissions distribute between explicit offsets. Offsets must be nondecreasing.
Omitted properties carry their previous value; values outside the explicit offset
range hold the corresponding endpoint. Easing defaults to operation easing or linear.

Each result exposes target, keys, duration and finished, plus update, pause, play,
cancel and Symbol.dispose. Its speed defaults to 1 and accepts finite nonnegative
values; zero freezes the clock. Advance it with update even when awaiting completion.
Options include the async timing options and AbortSignal. Cancellation rejects the
completion promise and leaves current property values intact.


```ts
import {to, from, fromTo, keyframes} from '@margoengine/tween/props';
const target = {x: 0, y: 0};
const move = to(target, {x: '+=4', y: [0, 2, 0]}, {duration: 1});
move.update(1); await move.finished;
const reveal = from(target, {x: -2}, {duration: 1});
reveal.update(1); await reveal.finished;
const reset = fromTo(target, {x: 0}, {x: 8}, {duration: 1});
reset.update(1); await reset.finished;
const sequence = keyframes(target, [{values: {x: 0}, offset: 0}, {values: {x: 6}, offset: 0.5}, {values: {x: 10}, offset: 1}], {duration: 2});
sequence.update(2); await sequence.finished;
if (target.x !== 10) throw new Error('Keyframes did not finish');
```

## Mixed clips and nested timelines

`Timeline` from `/timeline` is a separate optional class from the root scalar Timeline.
It combines to, array, custom and path clips, call callbacks and nested Timeline groups.
Array interpolation defaults to componentwise; pass an interpolate function for
quaternions or other representations. Clips require finite nonnegative duration;
easing defaults to linear. `at` defaults to append and accepts seconds, an existing
label, or a label with a signed seconds offset. `label` adds a named time and labelTimes
returns a defensive snapshot.

`add(child, at)` gives a child one parent, rejects cycles and samples the child from
the parent clock. `remove(child)` detaches it for reuse. The child's speed is applied
once; parent duration includes the child's repeated span divided by that speed. A
child's pause does not suspend parent sampling. Default speed is 1 and must be finite
and positive; repeat defaults to 0 and accepts nonnegative integers or Infinity, while
yoyo defaults to false. Read duration for one pass, totalDuration for repeated local
span, time for the playhead and playing for clock state.

Call play then update(deltaSeconds). Pause preserves position; reverse changes
direction. Seek samples values without call or onComplete notifications. Custom clip
samplers still run when sampled, so keep their side effects appropriate for seeking.
Playback crossings dispatch callbacks, including nested ones. Starting values are
captured when a clip is first sampled. Replay renews finished and the repeat budget.
Abort or cancel rejects completion and stops the hierarchy, preserving values;
cancellation propagates between parent and child. Disposal cancels and detaches children.


```ts
import {Timeline} from '@margoengine/tween/timeline';
const target = {x: 0};
const color = [1, 0, 0];
const child = new Timeline().to(target, 'x', 4, {duration: 1});
const parent = new Timeline()
  .label('start')
  .add(child, 'start')
  .array(color, [0, 0, 1], {duration: 1, at: 'start'})
  .call(() => console.log('complete'));
parent.seek(0.5); // Samples values, without firing the callback.
parent.seek(0).play();
parent.update(parent.totalDuration);
await parent.finished;
console.log(target.x, color);
parent.remove(child);
```

## A control world for target ownership

Construct `TweenControl` from `/control` to keep a target/key registry without globals.
`world.to(target, values, options)` returns a ControlledTween and validates all values
before replacing existing work. `overwrite` defaults to auto, removing matching keys
of older work on that target. All removes every older target key; false allows
coexistence, with writes following update order.

`killTweensOf(target, keys?)` removes selected keys or all keys, including paused and
delayed work, and returns the removed-key count. `getTweensOf(target)` returns active
operations. A ControlledTween exposes target, remaining keys, finished, pause/play,
speed, kill and cancel. Partial removal lets remaining keys finish normally; removing
the last unfinished key cancels and rejects the whole operation. Cancel defaults to
AbortError, and signal aborts preserve their reason.

Call only `world.update(deltaSeconds)` for registered work. Operation speed and the
world's timeScale multiply; both default to 1 and allow finite nonnegative values.
Zero freezes time, including delay. Work created from callbacks starts on the next
update. Disposal cancels the world's remaining operations without resetting targets.


```ts
import {TweenControl} from '@margoengine/tween/control';
const target = {x: 0, y: 0};
const world = new TweenControl();
const first = world.to(target, {x: 4, y: 8}, {duration: 1});
const second = world.to(target, {x: 10}, {duration: 1}); // Replaces only first's x.
world.update(1);
await Promise.all([first.finished, second.finished]);
if (target.x !== 10 || target.y !== 8) throw new Error('Overwrite lost a property');
const interrupted = world.to(target, {x: 20}, {duration: 1});
const observed = interrupted.finished.catch(reason => console.log(reason.name));
world.killTweensOf(target, ['x']);
await observed;
world.dispose();
```

## Pin a scrolling section and snap

`pinTimeline(timeline, options)` from `/scroll-pin` takes an attached pin element and
a timeline of positive finite duration. It pauses playback and samples through seek.
The scroll source defaults to the pin's window and may be a scrolling element. Start
defaults to the section's natural offset; distance defaults to one source viewport
height. Both may be functions reread on refresh. Start must be finite and nonnegative;
distance must be finite and positive.
pinSpacing defaults to true, reserving the extra scrolling distance in layout.

Snap defaults to disabled. Supply a normalized interval in (0,1], a nonempty list of
stops in 0..1, a destination function, labels or labelsDirectional. The directional
mode prefers stops in the direction of travel. The optional Timeline supplies
labelTimes; for a root Timeline pass a labels Map explicitly. Label times are seconds,
converted to progress by duration. `scrollSnapPoint(progress, stops, direction)` exposes
the deterministic stop choice independently.

snapDelay defaults to 0.2 seconds, snapDuration to 0.25, and scrub catch-up to 0;
all must be finite and nonnegative. Wheel, pointer, touch and keyboard input interrupt
an active snap. The link exposes progress, snapping, refresh and dispose. Responsive
resize refreshes layout; call refresh after application changes to ranges or labels.
onUpdate runs after each sample; timeline playback callbacks do not fire on seek.
Disposal or signal abort removes listeners, animation frames and spacer and restores
the pin's original inline style and DOM position. The timeline remains caller-owned
and paused, without automatically resuming its prior clock.


```ts
import {Timeline} from '@margoengine/tween/timeline';
import {pinTimeline, scrollSnapPoint} from '@margoengine/tween/scroll-pin';
const section = document.body.appendChild(document.createElement('section'));
section.textContent = 'Scroll through the pinned section';
section.style.height = '100vh';
const camera = {height: 10};
const timeline = new Timeline().label('start').to(camera, 'height', 2, {duration: 1}).label('end');
const controller = new AbortController();
const link = pinTimeline(timeline, {pin: section, distance: 1000, snap: 'labels', signal: controller.signal});
link.refresh();
console.log(link.progress, scrollSnapPoint(0.8, [0, 0.5, 1], 1));
// At page teardown; keep the link alive while the user scrolls.
controller.abort();
section.remove();
```

## Release velocity and inertia

`VelocityTracker` from `/inertia` estimates units per second over recent samples.
Its defaults are a 0.1-second window and capacity 32 (allowed 2..1024). Call
sample(value, seconds) with finite values and nondecreasing nonnegative times; an
equal-time sample replaces the last. reset forgets a previous gesture. velocity uses
the latest sample time. At release use velocityAt(releaseSeconds), which returns zero
when the pointer has been idle beyond the window. No wall clock is read internally.

`inertia(target, key, options)` takes either a numeric velocity or a VelocityTracker.
For a tracker, releaseTime defaults to its latest sample time; supply the actual
release time to account for an idle pointer. Default resistance is 6 per second,
with exponential velocity decay and a projected endpoint of start + velocity/resistance.
Optional end selects an exact endpoint, nearest stop from a list, or the result of a
function of the projected endpoint. min and max default to unbounded; supplied bounds
must be finite and ordered. Selected endpoints clamp to them; stop lists must be
nonempty and entirely within the bounds.

bounce defaults to 0 for hard range bounds and accepts [0,1) for spring motion around
the endpoint. restSpeed defaults to 0.01 units/second, restDelta to 0.001 units and
maxDuration to 10 simulated seconds; each must be finite and positive. Reaching rest
or maxDuration writes the exact endpoint. onUpdate receives value and physical velocity;
onComplete fires once. The returned operation exposes value, velocity, end, finished,
update, pause/play, speed and cancel. Speed defaults to 1 and allows finite values >=0.
Caller update deltas are seconds. Signal abort, cancel and disposal reject unfinished
work and preserve its current value. Observe finished rejections when interrupting it.

```ts
import {Tween, easeInOutCubic} from 'margoengine/tween';
const object = {opacity: 0};
const timeline = new Tween();
const cancel = timeline.to(object, 'opacity', 1, {duration: 0.5, easing: easeInOutCubic});
timeline.update(1 / 60);
```

Times are seconds. delay, onComplete, zero-duration tracks and cancellation are supported. A new track for the same object/property cancels the old one. Callback-created tracks begin next update; clear cancels all tracks. Completed/cancelled tracks compact in place. Track creation and callbacks can allocate; the in-place stepping above does not cover them. Targets are numeric writable properties; for colours, quaternions and paths use `array`, `path` or `custom` (below). CSS strings are not parsed.


```ts
import {VelocityTracker, inertia} from '@margoengine/tween/inertia';
const tracker = new VelocityTracker();
tracker.sample(0, 0); tracker.sample(10, 0.05);
const target = {x: 10};
const release = inertia(target, 'x', {velocity: tracker, releaseTime: 0.05, resistance: 6, end: [0, 50, 100], min: 0, max: 100});
release.update(10); // Simulate to maxDuration without a wall-clock timer.
await release.finished;
if (target.x !== 50) throw new Error('Unexpected snap endpoint');
console.log(target.x, tracker.velocityAt(1)); // 50, 0 (idle pointer).
```

## Repeat, yoyo, easings, springs, timelines, colours, paths

```ts
import {Tween, Timeline, Spring, easeOutBack, cubicBezier, parseHexColor, toHexColor, slerpArray, catmullRomPath} from 'margoengine/tween';
const light = {intensity: 1}, door = {angle: 0}, camera = {position: [0, 0, 5]}, node = {rotation: [0, 0, 0, 1]};
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

## Motion paths: even speed, facing the way it goes

`motionPath` from `margoengine/tween/motion-path` moves an object along a [spline](../splines/README.md) by arc length, so its speed stays even however the knots are spaced, and turns it to face along the curve:

```ts
import {Engine, box, PbrMaterial} from 'margoengine/core';
import {Spline} from 'margoengine/splines';
import {Tween} from 'margoengine/tween';
import {MotionPath, motionPath} from 'margoengine/tween/motion-path';

const engine = await Engine.create(document.querySelector('canvas')!);
const train = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial());
const track = new Spline([[0, 0, 0], [10, 0, 2], [20, 3, 0], [30, 0, -8]]);
const tween = new Tween();

// 4 m/s from one end to the other; the duration comes from the length.
const stop = motionPath(tween, train, track, {speed: 4, onComplete: () => console.log('arrived')});
tween.update(1 / 60);

// A camera looks down its -z, and a function target gets the pose for anything that is not a mesh.
motionPath(tween, (pose) => console.log(pose.position, pose.quaternion), track, {duration: 10, forward: '-z'});

// Or read poses yourself: arc-length position in, position and rotation out.
const path = new MotionPath(track);
const middle = path.poseAt(path.length / 2);
```

| Option | Meaning | Default |
| --- | --- | --- |
| `duration` or `speed` | Seconds for the run, or world units per second. Give one. | |
| `forward` | Local axis that faces along the path: `'x'`, `'y'`, `'z'`, or `'-x'`, `'-y'`, `'-z'`. | `'z'` |
| `orient` | False moves the object and leaves its rotation alone. | true |
| `start`, `end` | Arc-length positions; `end` below `start` runs backwards. | 0, the length |
| `frames` | `SplineFrames` options such as `up` and `roll`, or ready frames. | |

The options of a tween also work: `delay`, `repeat`, `yoyo`, `onComplete`, `onRepeat`, and `easing`, which shapes the speed. With no `easing` the speed is even. The rotation comes from `SplineFrames`, so it does not flip on a loop. Moving back on a `yoyo` pass, the object keeps facing the path's direction.

## Scroll-linked timelines

`scrollTimeline` from `margoengine/tween/scroll` hands a timeline to the page's scroll, for pages that tell a 3D story as the reader scrolls. The timeline stops running by the clock and its position follows the scroll, both ways:

```ts
import {Timeline} from 'margoengine/tween';
import {scrollTimeline} from 'margoengine/tween/scroll';

const camera = {height: 10, tilt: 0};
const timeline = new Timeline()
  .to(camera, 'height', 2, {duration: 1})
  .to(camera, 'tilt', 0.6, {duration: 1});

// A tall section with a sticky canvas: the timeline runs while the section fills the view.
const section = document.querySelector('#story')!;
const controller = new AbortController();
const link = scrollTimeline(timeline, {
  element: section,
  range: 'contain',
  scrub: 0.2,
  signal: controller.signal,
  onUpdate: (progress) => console.log(progress),
});
// link.dispose() or controller.abort() ends it; `using link = scrollTimeline(...)` does too.
```

| Option | Meaning | Default |
| --- | --- | --- |
| `source` | What scrolls: a scrolling element or a window. | the page |
| `element` | Follow this element through the view instead of the whole scroll range. | none |
| `range` | With `element`, the words of CSS view timelines. `'cover'`: from its top entering the bottom of the view to its bottom leaving the top. `'contain'`: from its top at the top of the view to its bottom at the bottom. | `'cover'` |
| `scrub` | Seconds the timeline takes to catch up, for a soft feel. The same at any frame rate. 0 follows at once. | 0 |
| `signal` | Ends the link. | none |
| `onUpdate` | Called with the progress 0..1 each time the timeline moves. | none |

The timeline's values are written on attach, from where the page already is, so a reload half way down starts half way through. A page that cannot scroll stays at 0. `Timeline.call` callbacks do not run, as for any seek; use `onUpdate`. The link reads the scroll on `scroll`, on `resize` and when the page or the element changes size; `link.refresh()` reads it at any other time.

## Custom ease curves

`customEase` from `margoengine/tween/custom-ease` makes an easing from data, so a curve drawn in an editor can be saved as JSON and loaded again:

```ts
import {Tween} from 'margoengine/tween';
import {customEase, easeFromSamples, easeFromStroke} from 'margoengine/tween/custom-ease';

// Through these points, with no overshoot between them.
const hop = customEase({version: 1, kind: 'smooth', points: [[0, 0], [0.4, 1], [0.7, 0.8], [1, 1]]});

const light = {intensity: 0};
const tween = new Tween();
tween.to(light, 'intensity', 3, {duration: 1, easing: hop});

// Save it and load it back: the same numbers.
const saved = JSON.stringify(hop);
const loaded = customEase(saved);

// What a curve editor draws: anchor, handle, handle, anchor.
const swing = customEase({version: 1, kind: 'bezier', points: [[0, 0], [0.2, 1.4], [0.5, 1.2], [1, 1]]});

// Evenly spaced values, or a stroke drawn with a pointer, in pixels, in the order drawn.
const measured = easeFromSamples([0, 0.1, 0.5, 0.9, 1]);
const drawn = easeFromStroke([[10, 300], [60, 280], [120, 120], [200, 100]]);
```

| `kind` | The curve | Points |
| --- | --- | --- |
| `'smooth'` | Passes through every point. Between two points it does not rise above or fall below them (a monotone cubic). | 2 or more |
| `'linear'` | Straight lines, like CSS `linear()`. | 2 or more |
| `'bezier'` | Cubic segments. A handle's x stays between the two anchors of its segment. | 3n + 1 |

- x runs from exactly 0 to exactly 1 and only moves forward; `y` is free, so a curve can overshoot or end away from 1. A curve that breaks a rule throws a `RangeError` naming it.
- A custom ease is a plain easing function with `curve` holding its data. It works anywhere an `easing` goes.
- `easeFromStroke(samples, tolerance?)` scales a stroke to 0..1 from its first and last sample, drops samples that went back in x, and keeps the few points that hold the shape within `tolerance`, default 0.005 of its height. A stroke that ends at the y it began throws, as there is no height to scale by.

## Springs by duration and bounce

Give a `Spring` the feel you want instead of its physics. `duration` is how long one swing takes in seconds, and `bounce` how much of the damping is taken away:

```ts
import {Spring, springOptions} from 'margoengine/tween';

const snappy = new Spring({duration: 0.3, bounce: 0, target: 1}); // no overshoot, the fastest that has none
const playful = new Spring({duration: 0.5, bounce: 0.4, target: 1}); // overshoots by 9.5%, then settles
const heavy = new Spring({duration: 0.8, bounce: -0.5, target: 1}); // creeps in, slower than bounce 0
playful.update(1 / 60);

// The same numbers, for anything that takes stiffness and damping.
const {stiffness, damping} = springOptions(0.5, 0.4);
```

| `bounce` | Motion | Damping ratio |
| --- | --- | --- |
| above 0, below 1 | Overshoots, more as it nears 1, by `exp(-pi * r / sqrt(1 - r * r))` of the move from rest | `r = 1 - bounce` |
| 0 (default) | Critically damped: no overshoot | 1 |
| below 0, above -1 | Overdamped: no overshoot, slower | `1 / (1 + bounce)` |

`duration` is the period of the same spring with no damping, `2 * pi * sqrt(mass / stiffness)`, the meaning SwiftUI gives it. Doubling it plays the same curve at half speed, and `mass` does not change the motion. A spring moving from rest takes longer than `duration` to settle; `spring.settled` says when. Give `duration` and `bounce`, or `stiffness` and `damping`, not both.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/tween

## Speed

Use the caller's frame loop to update each spring. Measure performance for your target
hardware and workload:

```ts
import {Spring} from 'margoengine/tween';

const springs = Array.from({length: 10000}, () => new Spring({stiffness: 120, damping: 12}));
const frame = (dt: number) => {
  for (const spring of springs) spring.update(dt);
};
frame(1 / 60);
```
