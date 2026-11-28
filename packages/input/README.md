# @margoengine/input

Import `margoengine/input` from the `margoengine` package, or `@margoengine/input` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Semantic actions combine keyboard codes, mouse buttons and relative motion, gamepad axes/buttons, and touch controls.

```ts
import {Input} from 'margoengine/input';
const input = new Input({jump: [{type: 'key', code: 'Space'}]});
input.update();
const {pressed, value} = input.state('jump');
```

Call update once per simulation tick. State objects are reused. Opposing bindings sum and clamp to -1..1; gamepad axes use a configurable deadzone. createStick(parent, id) creates a pointer-captured virtual stick; bindTouchButton(button, id) supports pointer and keyboard activation. rumble(durationMs, strength, gamepadIndex) returns false when no actuator is available. dispose removes listeners and owned stick elements. Editable fields do not trigger gameplay key-down actions. Mouse motion is relative, not an absolute screen cursor.

## Chords, contexts, rebinding and prompts

```ts
import {Input, bindingLabel} from 'margoengine/input';
const input = new Input(
  {
    jump: [{type: 'key', code: 'Space'}],
    save: [{type: 'key', code: 'KeyS', modifiers: ['ctrl']}],
    confirm: [{type: 'key', code: 'Enter'}],
  },
  {contexts: {game: ['jump'], menu: ['confirm']}},
);
input.setContext('game', false); // a menu opened: jump reads 0 and releases; confirm keeps working
const prompt = bindingLabel(input.actions.save[0]); // "Ctrl+S"; gamepad buttons use 'xbox' | 'playstation' | 'generic' names
const pressed = input.captureBinding({signal: AbortSignal.timeout(10_000)}); // "press a key to rebind"
window.dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyJ'})); // stands in for the player's key press
const binding = await pressed;
input.rebind('jump', [binding]);
localStorage.setItem('bindings', JSON.stringify(input.exportBindings()));
input.importBindings(localStorage.getItem('bindings')!); // unknown actions are ignored; invalid data changes nothing
input.resetBindings();
```

- `modifiers` (`'shift' | 'ctrl' | 'alt' | 'meta'`) on a `key` binding makes a chord: the key counts only while every modifier is held.
- `contexts` (option) group actions; an action owned by contexts reads 0 unless one is enabled. Unlisted actions are always active.
- `captureBinding` resolves with the next key (with held modifiers), mouse button or gamepad button; Escape or the signal rejects with `AbortError`. A modifier pressed alone waits: Ctrl then S gives Ctrl+S, and Shift pressed and released alone gives Shift. A gamepad button already held when the prompt opens counts only after it is released and pressed again.
- Mouse buttons follow Pointer Events chords: a second button pressed or released during a drag counts, though the browser sends it as a `pointermove`.

## Tap, hold, slow tap and double press

`@margoengine/input/interactions` turns a press into what the player meant. Rules are named, like actions, and read any action, or one binding of it:

```ts
import {Input} from 'margoengine/input';
import {Interactions} from 'margoengine/input/interactions';

const input = new Input({
  use: [{type: 'key', code: 'KeyE'}, {type: 'gamepad-button', index: 2}],
  dodge: [{type: 'key', code: 'KeyD'}],
  fire: [{type: 'gamepad-button', index: 7}],
});
const rules = new Interactions(input, {
  open: {type: 'tap', action: 'use'},
  inspect: {type: 'hold', action: 'use', time: 600},
  dash: {type: 'double-press', action: 'dodge'},
  heavy: {type: 'slow-tap', action: 'fire', threshold: 0.8},
  padOnly: {type: 'hold', action: 'use', binding: 1},
});
function tick() {
  input.update();
  rules.update();
  if (rules.state('open').performed) console.log('open');
  if (rules.state('dash').performed) console.log('dash');
  const charge = rules.state('heavy').progress; // 0 to 1, for a charge bar
  console.log(charge);
}
tick();
```

- `tap`: pressed and released within `time` (default 200 ms). Performed on release.
- `hold`: held for `time` (default 400 ms). Performed while still held.
- `slow-tap`: held for at least `time` (default 500 ms), then released. Performed on release.
- `double-press`: `count` presses (default 2), each shorter than `time` (default 200 ms), each within `gap` (default 300 ms) of the last release. Performed on the last press.
- `binding` (default: the whole action): an index into `input.actions[action]`, so a rule can read one device; after a rebind it reads what is bound there.
- `threshold` (default 0.5): magnitude that counts as pressed, for triggers and sticks. The press ends at three quarters of it, so noise at the press point cannot flicker.
- Option `now` (default `performance.now`): the clock in milliseconds.

`state(rule)` gives `started`, `performed` and `canceled` (each true for one update), `active`, `progress` and `duration`. `reset()` drops every press in progress. Rules do not wait for each other, so one press can start a tap and a hold and each ends by its own rule. To tell a single press from a double, act on the double press's `canceled`, which comes `gap` after a lone press. Time is read once per update, so a rule is as exact as your tick. `input.bindingValue(action, index)` reads one binding yourself.

A press and release between two updates counts for one update on keys, mouse buttons and touch buttons, so a short tap is not lost on a slow frame. Gamepads are polled, so a gamepad press shorter than one update can still pass unseen.

## Local multiplayer

`@margoengine/input/players` gives each player devices of their own and a full `Input`, all made from one action map:

```ts
import {LocalPlayers} from 'margoengine/input/players';

const party = new LocalPlayers(
  {
    move: [
      {type: 'key', code: 'KeyD'},
      {type: 'key', code: 'KeyA', scale: -1},
      {type: 'gamepad-axis', index: 0},
    ],
    jump: [{type: 'key', code: 'Space'}, {type: 'gamepad-button', index: 0}],
    start: [{type: 'key', code: 'Enter'}, {type: 'gamepad-button', index: 9}],
  },
  {
    joinAction: 'start', // a press on a device nobody owns adds a player
    schemes: {
      arrows: {
        move: [
          {type: 'key', code: 'ArrowRight'},
          {type: 'key', code: 'ArrowLeft', scale: -1},
        ],
        jump: [{type: 'key', code: 'ArrowUp'}],
        start: [{type: 'key', code: 'ShiftRight'}],
      },
    },
  },
);
party.on('join', ({player, device}) => console.log('player', player.index, 'joined on', device));
party.on('lost', ({player}) => console.log('pause: player', player.index, 'lost a gamepad'));
function tick() {
  party.update(); // in place of input.update()
  for (const player of party.players) {
    if (player.input.state('jump').pressed) void player.rumble(100);
    console.log(player.index, player.input.state('move').value);
  }
}
tick();
```

A device is `'keyboard'` (the key, mouse and pointer bindings), `'keyboard:<scheme>'` (that entry of `schemes`, for two players on one keyboard), `'gamepad:<n>'` (the gamepad bindings, pointed at gamepad `n`), `'touch'` or `'control:<id>'` (the bindings to that control). A device has one owner; a player can own several.

- `party.add(device?)`, `party.remove(player)`: add in the lowest free slot, or remove. `player.index` stays put while others come and go.
- `party.assign(player, device)`, `party.unassign(device)`, `party.owner(device)`: move devices at any time. `assign` rebuilds that player's bindings from the shared map, so apply saved bindings after it.
- `player.input` is a real `Input`: contexts, rebinding, touch controls, `Interactions` and recording are per player. An action with no binding on the player's devices reads 0.
- `party.on(type, handler)` hears `join`, `leave`, `lost` and `regained`, and returns the function that stops listening. An unplugged gamepad keeps its owner and comes back to them on the same index.
- The press that joins does not read as `pressed`, so Start does not also pause.
- Options: `maxPlayers` (default 4), `schemes` (default none), `joinAction` (default none: only `add` adds), `gamepadSlots` (gamepad indices `joinAction` watches, default 4), and `target`, `gamepads`, `deadzone` and `contexts`, which go to every player's `Input`.

## Gyro aiming and steering

`@margoengine/input/motion` turns the device's gyroscope and tilt into aim and steering, in the screen's frame, so portrait and landscape read alike:

```ts
import {Input} from 'margoengine/input';
import {Gyro} from 'margoengine/input/motion';

const button = document.createElement('button');
const input = new Input({
  aimX: [{type: 'pointer', axis: 'x', scale: 0.01}, {type: 'control', id: 'gyro', axis: 'yaw'}],
  steer: [{type: 'key', code: 'KeyD'}, {type: 'control', id: 'gyro', axis: 'steer'}],
  aiming: [{type: 'mouse', button: 2}],
});
using gyro = new Gyro();
gyro.attach(input);
button.onclick = async () => {
  if (await Gyro.requestPermission()) await gyro.calibrate({duration: 500}); // iOS asks only from a tap
};
let heading = 0;
function tick() {
  gyro.enabled = input.state('aiming').down; // aim with the gyro only while aiming, as console games do
  gyro.update(); // before input.update()
  input.update();
  heading += gyro.yaw; // radians turned since the last update: add them straight onto the camera
  console.log(heading, input.state('steer').value);
}
tick();
```

- `gyro.yaw`, `pitch`, `roll`: radians turned since the last update; positive is right, up and clockwise. Use these for aiming, as they do not clamp.
- `gyro.steer`: tilt like a wheel, -1 to 1, reaching 1 at `maxTilt`. `recenter()` takes the present tilt as straight ahead. Reads 0 while the device lies flat.
- Bindings: `{type: 'control', id: 'gyro', axis}` with `axis` `'yaw'`, `'pitch'` or `'roll'` (rate as a share of `maxRate`) or `'steer'`.
- `calibrate({duration, signal})` measures the gyroscope's resting error with the device still, and subtracts it. `enabled = false` ignores the sensors. `available` turns true once a real reading arrives; `Gyro.supported()` says whether the browser has the events at all.
- Options: `maxRate` (degrees per second reading 1, default 180), `maxTilt` (degrees reading 1, default 45), `deadzone` (degrees per second reading 0, default 1), `target` (default `window`), `screenAngle` and `now`.

`input.control(id)` is the general form of this: it returns an object of numbers that `{type: 'control', id, axis}` bindings read (`axis` defaults to `'value'`), so any code can feed an action. `input.removeControl(id)` removes it.

## Recording and replay

`@margoengine/input/replay` records what every binding gave, tick by tick, and plays it back into an `Input`. Game code does not change: it reads the same actions, so tests and attract-mode demos run the real thing.

```ts
import {Input} from 'margoengine/input';
import {Interactions} from 'margoengine/input/interactions';
import {InputRecorder, InputReplay} from 'margoengine/input/replay';

const input = new Input({jump: [{type: 'key', code: 'Space'}]});
const recorder = new InputRecorder(input);
for (let tick = 0; tick < 3; tick++) {
  input.update();
  recorder.capture(); // once per tick, after input.update()
}
const saved = JSON.stringify(recorder.clip());

const replay = new InputReplay(input, saved, {signal: AbortSignal.timeout(60_000)});
const rules = new Interactions(input, {hop: {type: 'tap', action: 'jump'}}, {now: () => replay.time});
while (replay.frame + 1 < replay.frames) {
  input.update(); // takes the next recorded tick; the devices are ignored
  rules.update();
}
input.update(); // past the end: the Input goes back to its devices
await replay.finished;
```

- A clip is plain JSON: action and binding channels, the time of each tick, and only the values that changed, so a held key costs nothing per tick. It holds binding values, so rules on one binding replay too.
- Each `input.update()` plays one tick. Ticks replay in order at whatever rate you call `update`; the recorded time is `replay.time`, so give timing rules that clock and the results match the live run, tick for tick.
- `new InputReplay(input, clip, {loop, signal})` takes the clip or its JSON text and checks all of it first. `loop` (default false) repeats it, with `time` still rising. `replay.stop()` hands the Input back; `finished` resolves at the end or on `stop`, and rejects if `signal` aborts.
- Contexts apply during a replay as they do live. An action the clip does not hold reads 0; an action this Input lacks is refused. With `LocalPlayers`, record each `player.input`.
- `input.setFeed(feed)` is what replay uses: an object with `begin()` and `read(action, binding)` in place of the devices, and `null` to go back.

## Pen pressure and tilt

`@margoengine/input/pen` reads a stylus for painting and sculpting, as action values and as every sample of a stroke. Mouse and touch are ignored. Set `touch-action: none` on the element.

```ts
import {Input} from 'margoengine/input';
import {Pen} from 'margoengine/input/pen';

const canvas = document.querySelector('canvas')!;
const input = new Input({
  size: [{type: 'control', id: 'pen', axis: 'pressure'}],
  lean: [{type: 'control', id: 'pen', axis: 'tiltX'}],
  erase: [{type: 'control', id: 'pen', axis: 'eraser'}],
});
using pen = new Pen(canvas, {curve: (pressure) => pressure ** 1.5});
pen.attach(input);
function tick() {
  pen.update(); // before input.update()
  input.update();
  console.log(input.state('size').value, input.state('lean').value);
  for (const {x, y, pressure, azimuth, altitude} of pen.take()) console.log(x, y, pressure, azimuth, altitude);
}
tick();
```

- Bindings: `{type: 'control', id: 'pen', axis}` with `axis` `'pressure'` (0 to 1), `'tiltX'` and `'tiltY'` (-1 to 1, a share of 90 degrees), `'altitude'` (0 flat to 1 upright), `'azimuth'` and `'twist'` (share of a full turn), `'tangential'` (-1 to 1), or `'down'`, `'barrel'`, `'eraser'` and `'hover'` (0 or 1). Tilt reads while hovering, for a brush preview.
- `pen.take()` returns every sample since the last call at the pen's own rate, unpacking the browser's coalesced events, so a fast stroke keeps its points. A sample with `down` false after true ends a stroke. `pen.latest` is the newest sample and `pen.inRange` says whether the pen is near.
- Tilt and altitude with azimuth are both filled in, whichever the browser gives, by the Pointer Events conversion.
  Directions are the screen's: `tiltX` is positive leaning right (+x), `tiltY` leaning down the screen (+y), and
  `azimuth` turns from +x toward +y (0.25 of a turn is straight down the screen). When the browser sends altitude and
  azimuth they are kept as sent, and tilt is computed from them only when both tilts arrive as 0.
- A pen lying flat is ambiguous: from tilt, a flat lean straight along one axis (90 degrees on one tilt, 0 on the other)
  gives altitude 0 and that axis's azimuth, while a flat lean on both axes gives altitude 0 and azimuth 0, the
  specification's fallback. From altitude 0, tilt takes 90 degrees toward each axis the azimuth leans to, and exactly 0
  on the other axis when the azimuth lies on one.
- A dab between two updates still reads `down` for one update.
- Options: `curve` (shapes pressure within 0 to 1, default none) and `maxSamples` (kept between `take` calls, oldest dropped, default 4096).

## Sticks from keys and axes (`margoengine/input/vector`)

`VectorInput` is an `Input` with named two-axis actions: movement from WASD, a gamepad stick, or both. Each vector sums
its `x` and `y` bindings, then applies one radial deadzone to the pair, so a diagonal is as long as a straight push
and the stick has no square corners. Positive `y` is down, as on gamepads.

```ts
import { VectorInput, wasd } from 'margoengine/input/vector';

const input = new VectorInput(
  {
    move: { ...wasd(), x: [...wasd().x, { type: 'gamepad-axis', index: 0 }], y: [...wasd().y, { type: 'gamepad-axis', index: 1 }] },
    aim: { x: [{ type: 'key', code: 'ArrowRight' }], y: [{ type: 'key', code: 'ArrowDown' }], normalize: true, deadzone: 0.2 },
  },
  { actions: { jump: [{ type: 'key', code: 'Space' }] } }, // ordinary actions alongside
);
const key = (type: string, code: string) => window.dispatchEvent(new KeyboardEvent(type, { code }));
key('keydown', 'KeyD'); // stands in for the player's keys
key('keydown', 'KeyW');
input.update();
const move = input.vector('move'); // the same object every tick
console.log(move.x.toFixed(3), move.y.toFixed(3), move.magnitude, move.pressed); // '0.707' '-0.707' 1 true
key('keydown', 'KeyA'); // A against D cancels
input.update();
console.log(move.x, move.y, move.magnitude); // 0 -1 1
console.log(Object.keys(input.actions)); // ['jump', 'move.x', 'move.y', 'aim.x', 'aim.y']
for (const code of ['KeyA', 'KeyD', 'KeyW']) key('keyup', code);
input.update();
console.log(move.released, move.down); // true false
input.dispose();
```

- A vector's state is `{ x, y, magnitude, down, pressed, released }`. `magnitude` is 0 inside `deadzone` (default
  0.15), then rises from 0 to 1 between the deadzone and the unit circle, `(min(1, length) - deadzone) /
  (1 - deadzone)`, so a stick has no jump at the deadzone edge; `x` and `y` keep the push's direction.
  `normalize: true` makes every push outside the deadzone length 1 (eight-way keys, or a menu cursor). `down` is any
  magnitude above zero.
- Each vector becomes two scalar actions, `<name>.x` and `<name>.y`, so `contexts`, `rebind`, `exportBindings`,
  `InputRecorder` and `InputReplay` work with them unchanged; rebind `move.x` to move the horizontal axis. The `Input`
  axis deadzone is not used: each vector's radial one replaces it.
- An empty name, an empty axis, or a name whose `.x` or `.y` clashes with another action throws a `TypeError`; a
  deadzone outside 0 (inclusive) to 1 throws a `RangeError`. `reset()` (also on window blur) zeroes vectors at once
  and reports `released` for those that were down.

## XR controllers and hands (`margoengine/input/xr`)

`XRBindings` turns a WebXR session's controllers and hands into ordinary `Input` controls: buttons (analogue value,
pressed or touched), thumbstick axes, select and squeeze, a hand pinch, and the grip pose. Mix them with keys and
gamepads in one action map; recording and replay need no headset.

```ts
import { Input } from 'margoengine/input';
import { XRBindings } from 'margoengine/input/xr';

// A stand-in session; pass the real XRSession, and call update(frame, referenceSpace) in its frame loop.
const right = {
  handedness: 'right' as const,
  gamepad: { axes: [0, 0, 0.5, -1], buttons: [{ value: 0.8, pressed: true, touched: true }] },
  gripSpace: {},
};
const left = { handedness: 'left' as const, hand: { get: (joint: string) => ({ joint }) } };
const session = Object.assign(new EventTarget(), { inputSources: [left, right] });
let gap = 0.015; // metres between thumb and index tips
const frame = {
  getJointPose: (joint: object) => ({ transform: { position: { x: (joint as { joint: string }).joint === 'thumb-tip' ? 0 : gap, y: 0, z: 0 } } }),
  getPose: () => ({ transform: { position: { x: 0, y: 1.4, z: -0.3 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } }),
};
const space = {};

const xr = new XRBindings(session);
const input = new Input(
  xr.map({
    fire: [{ type: 'xr-button', hand: 'right', index: 0 }, { type: 'key', code: 'Space' }],
    turn: [{ type: 'xr-axis', hand: 'right', index: 2 }],
    select: [{ type: 'xr-select', hand: 'right' }],
    pinch: [{ type: 'xr-pinch', hand: 'left' }],
    gripY: [{ type: 'xr-grip-pose', hand: 'right', component: 'y' }],
  }),
);
xr.attach(input);
const select = (type: string) => session.dispatchEvent(Object.assign(new Event(type), { inputSource: right }));
select('selectstart'); // a tap: start and end before the next frame
select('selectend');

xr.update(frame, space); // first, then input.update()
input.update();
console.log(input.state('fire').value, input.state('turn').value, input.state('select').pressed); // 0.8 0.5 true: the tap still counts once
console.log(input.state('pinch').down, input.state('gripY').value, input.bindingValue('gripY', 0)); // true 1 1.4: actions clamp
gap = 0.025; // between pinchStart and pinchEnd: the pinch holds
xr.update(frame, space);
input.update();
console.log(input.state('select').down, input.state('pinch').down); // false true
gap = 0.035;
xr.update(frame, space);
input.update();
console.log(input.state('pinch').down); // false
xr.dispose(); // removes its listeners and controls
```

| Descriptor | Reads |
| --- | --- |
| `{ type: 'xr-button', index, value }` | `gamepad.buttons[index]`: `'value'` (default, 0 to 1), `'pressed'` or `'touched'` (0 or 1) |
| `{ type: 'xr-axis', index }` | `gamepad.axes[index]`, -1 to 1 (2 and 3 are the thumbstick on the xr-standard mapping) |
| `{ type: 'xr-select' }`, `{ type: 'xr-grip' }` | 1 while the session's select or squeeze is held, and for one update after a tap shorter than a frame |
| `{ type: 'xr-pinch' }` | 1 while the thumb and index tips are within `pinchStart` (default 0.02 m), until they part past `pinchEnd` (0.03 m) |
| `{ type: 'xr-grip-pose', component }` | the grip pose in the reference space: `'x'`, `'y'`, `'z'` (metres), `'qx'` to `'qw'`, or `'tracked'` (0 or 1) |

- Every descriptor also takes `hand` (`'left'`, `'right'` or `'none'`; default any), `source` (the nth matching source
  in session order, default 0) and `scale` (default 1). An invalid one throws a `TypeError`.
- `map(actions)` converts the XR descriptors in a mixed map and passes native bindings through; `binding(descriptor)`
  converts one. `attach(input)` publishes to an `Input` or `VectorInput` once and returns a detach function. Several
  `XRBindings` need distinct `id`s (default `'xr'`).
- A missing, untracked or disconnected source reads 0, and the session's `end` zeroes everything. An action clamps to
  -1 to 1, so read a grip position beyond a metre with `input.bindingValue(action, index)`, which is not clamped.
  `update` after `dispose()` throws a `MargoError` with code `'disposed'`.

## Pointer lock (`margoengine/input/lock`)

`PointerLock` asks for pointer lock on an element, with raw mouse movement (no operating-system acceleration) where
the browser offers it, and hands each tick's relative mouse counts to an `Input` as control `'lock'`, axes `'x'` and
`'y'`. It is separate from camera controls, so any look or aim code can use it.

```ts
import { Input } from 'margoengine/input';
import { PointerLock } from 'margoengine/input/lock';

const canvas = document.createElement('canvas');
document.body.append(canvas);
const lock = new PointerLock(canvas); // listens on canvas.ownerDocument; requests nothing yet
const input = new Input({ lookX: [{ type: 'control', id: 'lock', axis: 'x', scale: 0.01 }] });
lock.attach(input);
console.log(lock.supported, lock.locked); // true false in a browser with the Pointer Lock API

canvas.addEventListener('click', async () => {
  try {
    await lock.request({ timeout: 5000 }); // from the click: browsers need a user gesture
    console.log(lock.locked, lock.raw); // true, and true for raw movement (false adjusted, null unknown)
  } catch (error) {
    console.log((error as Error).name); // 'OperationError' refused, 'TimeoutError', 'AbortError', ...
  }
});
function tick() {
  lock.update(); // before input.update(): this tick's counts
  input.update();
  console.log(lock.x, lock.y, input.state('lookX').value); // counts, and the action after scale and clamp
}
tick();
lock.dispose(); // or `using`: releases the lock, cancels a wait, removes listeners and the control
```

- `request({ unadjustedMovement, fallback, signal, timeout })`: `unadjustedMovement` (default true) asks for raw
  movement, and `fallback` (default true) asks again without it when the browser answers `NotSupportedError`.
  `timeout` (default 5000 ms, positive) bounds the whole request; `signal` cancels it, and a lock granted after the
  cancel is released at once. A second request while one waits throws `InvalidStateError`; no Pointer Lock API
  throws `NotSupportedError`. Older browsers whose `requestPointerLock` returns nothing work too, with `raw` null.
- `x` and `y` are the mouse counts summed since the last `update()`, unbounded; they read 0 while this element does
  not hold the lock, and losing the lock (Escape) clears them. `release()` exits only this element's lock.
- `attach(input, id)` publishes to one `Input` per call (default id `'lock'`) and returns a detach function.

## Layout-aware key prompts (`margoengine/input/layout`)

Bindings use physical key codes, so `KeyW` is the key above Tab on every layout. `KeyboardLabels` reads the browser's
Keyboard Map to show what that key is labelled on the player's keyboard: Z on AZERTY, for example. The binding never
changes; only the prompt does.

```ts
import { KeyboardLabels, layoutBindingLabel } from 'margoengine/input/layout';

// A stand-in for navigator.keyboard (the default) on a French AZERTY layout.
const azerty = new Map([['KeyQ', 'a'], ['KeyW', 'z'], ['KeyA', 'q'], ['Digit2', 'é']]);
const keyboard = Object.assign(new EventTarget(), { getLayoutMap: async () => azerty });

const labels = new KeyboardLabels({ keyboard });
labels.addEventListener('change', () => console.log('redraw prompts')); // also after a layout change
console.log(labels.label({ type: 'key', code: 'KeyW' })); // 'W': no map yet, the standard label
console.log(await labels.refresh()); // logs 'redraw prompts', then true
console.log(labels.label({ type: 'key', code: 'KeyW' }), labels.label({ type: 'key', code: 'KeyQ', modifiers: ['ctrl'] })); // 'Z' 'Ctrl+A'
console.log(labels.label({ type: 'key', code: 'Digit2' }), labels.label({ type: 'key', code: 'Space' })); // 'é' 'Space'
console.log(layoutBindingLabel({ type: 'key', code: 'KeyW' }, labels.map)); // 'Z': the same, with a map you hold
labels.dispose();
```

- `refresh({ signal })` loads the map and returns true, or false when the browser has no Keyboard Map (Firefox and
  Safari), the page may not read it (`SecurityError`, `NotAllowedError`, a frame without permission), or a newer
  refresh started; the labels then fall back to `bindingLabel`. A wait past `timeout` (default 5000 ms) rejects with
  `TimeoutError`, `signal` with its reason, and any other error is thrown and kept in `lastError`.
- Where the browser fires `layoutchange`, the labels refresh by themselves: `change` on success, `error` (with
  `lastError`) on failure. `supported` says whether the API exists, `available` whether a map was read, and `map` is
  the snapshot or null.
- Letters are shown in capitals, other glyphs as the map gives them; a blank or control-character glyph falls back.
  Modifiers, mouse and gamepad labels are unchanged (pass the gamepad layout, `'xbox'` by default).
- `keyboard: null` turns the lookup off. After `dispose()`, `label` and `refresh` throw a `MargoError` with code
  `'disposed'`.

## Trigger rumble (`margoengine/input/haptics`)

`triggerRumble(gamepad, options)` plays the browser's trigger-rumble effect: the motors in each trigger (as on Xbox
Wireless Controllers) and the two handle motors, each with its own strength. It never stands in a plain dual rumble
where triggers are missing.

```ts
import { supportsTriggerRumble, triggerRumble } from 'margoengine/input/haptics';

// A stand-in pad; pass navigator.getGamepads()[0].
const played: object[] = [];
const pad = {
  connected: true,
  vibrationActuator: {
    effects: ['dual-rumble', 'trigger-rumble'],
    playEffect: async (_type: 'trigger-rumble', effect: object) => (played.push(effect), 'complete' as const),
    reset: async () => 'complete' as const,
  },
};
console.log(supportsTriggerRumble(pad), supportsTriggerRumble(null)); // true false
console.log(await triggerRumble(pad, { duration: 120, leftTrigger: 0, rightTrigger: 0.6 })); // true: played to the end
console.log(played[0]); // { duration: 120, startDelay: 0, strongMagnitude: 0, weakMagnitude: 0, leftTrigger: 0, rightTrigger: 0.6 }

const controller = new AbortController();
const kick = triggerRumble(pad, { duration: 2000, strongMagnitude: 1, signal: controller.signal });
controller.abort(); // stops the effect if it is still this call's
await kick.catch((error) => console.log((error as Error).name)); // 'AbortError'
```

- Options and defaults: `duration` 100 ms, `startDelay` 0 (whole milliseconds, 0 or more), `strongMagnitude` and
  `weakMagnitude` 0, `leftTrigger` and `rightTrigger` 1 (each 0 to 1), `timeout` 6000 ms (raise it for longer effects)
  and `signal`. A value out of range throws a `RangeError`.
- The promise gives true when the effect ran to the end, false when the pad has no trigger motors, is disconnected,
  or a newer effect took over (`'preempted'`). `supportsTriggerRumble` is true or false from the actuator's `effects`,
  or undefined for an older actuator with no list, which `triggerRumble` then just tries.
- An abort or timeout stops the effect with `reset()` (or a zero effect) only when it is still this call's, bounded at
  1000 ms; if stopping fails too you get an `AggregateError` with both errors. Browsers may cap `duration`.

## Gestures

```ts
import {Gestures} from 'margoengine/input';
const canvas = document.querySelector('canvas')!;
let zoom = 1;
using gestures = new Gestures(canvas, {swipeDistance: 60});
gestures.on('pinch', (e) => (zoom *= e.scale!));
gestures.on('swipe', (e) => console.log(e.direction, e.velocity));
gestures.on('doubletap', () => (zoom = 1));
```

Touch and pen only (mouse never triggers them, so they never fight orbit controls): `tap`, `doubletap`, `swipe` (direction and px/s), two-finger `pinch` (scale since the last event) and `rotate` (radians). Thresholds are options with defaults. Set `touch-action: none` on the element.

## Webcam landmarks

`@margoengine/input/landmarks` turns any face, hand or pose detector's output into one `LandmarkFrame` stream, an async iterator with a timestamp per frame. Margo ships no trained weights and no detector and never downloads one: the app loads its own (MediaPipe Tasks' FaceLandmarker, HandLandmarker or PoseLandmarker, or anything that gives points) and passes its results in.

```ts
import {fromMediaPipe, landmarkStream, OneEuroFilter, webcamLandmarks, type LandmarkSource} from 'margoengine/input/landmarks';

// A recorded FaceLandmarker result; with MediaPipe Tasks, detect would return
// fromMediaPipe({face: faceLandmarker.detectForVideo(video, time)}, time).
const recorded = {face: {faceLandmarks: [[{x: 0.5, y: 0.5, z: 0}]], faceBlendshapes: [{categories: [{categoryName: 'jawOpen', score: 0.4}]}]}};
const detect = (_video: unknown, time: number) => fromMediaPipe(recorded, time);

const controller = new AbortController();
let source: LandmarkSource;
try {
  source = await webcamLandmarks({detect, signal: controller.signal});
} catch (error) {
  // No camera, or permission refused: play the recording instead.
  console.warn('No webcam:', (error as Error).message);
  const replay = landmarkStream({buffer: 8});
  for (let time = 0; time <= 99; time += 33) replay.push(fromMediaPipe(recorded, time));
  replay.close();
  source = replay;
}
const jaw = new OneEuroFilter({minCutoff: 1, beta: 0.5});
for await (const frame of source) {
  console.log(frame.time, jaw.filter(frame.faces[0]?.blendshapes?.jawOpen ?? 0, frame.time / 1000));
  if (frame.time > 60) break; // break, dispose() or the signal stops the camera
}
```

- `LandmarkFrame`: `time` (ms), `faces` (`landmarks`, optional `blendshapes` by ARKit name, `transform`, `score`), `hands` (`landmarks`, `worldLandmarks`, `handedness` `'left'` or `'right'` for the subject's hand, `score`) and `poses` (`landmarks`, `worldLandmarks`). Points are `{x, y, z, visibility?, presence?}`: image points normalised 0..1 (y down), world points in metres.
- `fromMediaPipe({face, hands, pose}, time, {mirroredHandedness})` reads MediaPipe Tasks Vision results as they come from `detectForVideo`: `faceLandmarks`, `faceBlendshapes` (`_neutral` dropped), `facialTransformationMatrixes`, `landmarks`, `worldLandmarks` and `handedness` (or the older `handednesses`). MediaPipe labels hands as if the picture were mirrored, so `mirroredHandedness` (default true) swaps them for an unmirrored webcam frame.
- `landmarkStream({buffer = 1, signal})` is a source the app pushes frames into (`push`, `close`, `dispose`); a slow reader gets the newest `buffer` frames, older ones are dropped.
- `startWebcam({onFrame, video, constraints, signal, mediaDevices})` opens the camera (`getUserMedia`, default `{facingMode: 'user', width: 640, height: 480}`), plays it muted and inline into `video` (default a new element) and calls `onFrame(video, time)` once per new picture (`requestVideoFrameCallback`, else animation frames). `stop()`, `using` or the signal stops every track.
- `webcamLandmarks({detect, buffer, ...webcam})` is both together: the source the drivers read. A detector that throws stops the camera and its error comes out of the next read.
- `OneEuroFilter({minCutoff = 1, beta = 0.007, dCutoff = 1})` is the one-euro filter (Casiez, Roussel and Vogel, CHI 2012): `filter(value, seconds)` smooths one number, cutting jitter at rest and lag in motion; raise `beta` for less lag, lower `minCutoff` for less jitter. `reset()` forgets the history.

## Webcam face to morph targets

`@margoengine/input/face` drives ARKit-named morph targets (the 52 names face rigs commonly use) and gives the head rotation from face frames. It takes a detector's blendshape scores when they are there (MediaPipe's FaceLandmarker with `outputFaceBlendshapes`) and otherwise measures the face mesh: the eye aspect ratio for blinks, the lip gap for the jaw, mouth width and corners for smiles, frowns and puckers, and brow height.

```ts
import {FaceDriver} from 'margoengine/input/face';
import {fromMediaPipe} from 'margoengine/input/landmarks';

// Any model with named morph targets: a loaded glTF model's primitives fit.
const model = {primitives: [{targetNames: ['jawOpen', 'eyeBlinkLeft', 'Smile_L'], weights: [0, 0, 0]}]};
using face = new FaceDriver({names: {mouthSmileLeft: 'Smile_L'}});

// Two recorded FaceLandmarker results: a resting face (to calibrate on), then a smile with the jaw open.
const result = (jaw: number, smile: number) => ({
  faceLandmarks: [[]],
  faceBlendshapes: [{categories: [{categoryName: 'jawOpen', score: jaw}, {categoryName: 'mouthSmileLeft', score: smile}]}],
  facialTransformationMatrixes: [{data: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -40, 1]}],
});
face.calibrate(fromMediaPipe({face: result(0.05, 0)}, 0));
for (let time = 33; time <= 330; time += 33) face.update(fromMediaPipe({face: result(0.6, 0.8)}, time));
face.apply(model);
console.log(model.primitives[0].weights, face.state.rotation);
// From a webcam: await face.drive(await webcamLandmarks({detect}), model, {signal}).
```

- `update(frame or face, time?)` reads the frame's first face and returns `{weights, rotation, tracked, time}`; `apply(model or models)` writes each weight to the targets named after it (case-insensitive, through `names`), leaving other targets alone. `drive(source, model, {signal, onUpdate})` does both for every frame of a `LandmarkSource`.
- `calibrate(frame)`: take a relaxed face looking at the camera as neutral. Scores are rescaled from the person's resting value, landmark measures are taken against their own face, and the head rotation is measured from that pose.
- Options: `names` (ARKit name to morph name, default the ARKit names), `source` (`'auto'` scores when given else landmarks, `'blendshapes'`, `'landmarks'`), `minScore` (0.5: a weaker face holds the last good values), `hold` (0.5 s, then back to neutral), `smoothing` (one-euro `{minCutoff: 1.5, beta: 0.5}`, or false), `mirror` (false; swaps left and right for a selfie picture) and `aspect` (1; the frame's width over height, for landmark measures).
- Landmarks alone give `LANDMARK_BLENDSHAPES` (blinks, wide eyes, jaw, smiles, frowns, pucker and brows); scores give all 52. `measureFace`, `faceWeightsFromLandmarks` and `headRotation` are the measures on their own. The head rotation is in a y-up frame looking along +z with the face's left at +x; with a face transform from the detector it is that transform's rotation.

ARKit is a trademark of Apple Inc.; only its published blendshape names are used.

## Webcam hands and body to a skeleton

`@margoengine/input/body` poses a humanoid skeleton from Pose Landmarker (33 points) and Hand Landmarker (21 points per hand) frames: each mapped bone turns from its rest direction onto the landmark direction, a second direction fixes the twist of the hips, chest and hands, and each joint stays within its limit. Bones are the VRM humanoid names; `humanoidBones` in `@margoengine/rigging/retarget` maps Mixamo, Godot and other rigs onto them.

```ts
import {Skeleton} from 'margoengine/animation';
import {BodyDriver} from 'margoengine/input/body';
import {landmarkStream, type Landmark} from 'margoengine/input/landmarks';

// A T-pose arm: shoulder, upper arm, forearm and hand, its left at +x (a loaded skin's skeleton fits).
const skeleton = new Skeleton([
  {name: 'upperChest', parent: -1, translation: [0, 1.3, 0]},
  {name: 'leftUpperArm', parent: 0, translation: [0.17, 0.1, 0]},
  {name: 'leftLowerArm', parent: 1, translation: [0.27, 0, 0]},
  {name: 'leftHand', parent: 2, translation: [0.25, 0, 0]},
]);
using body = new BodyDriver(skeleton, {parts: ['pose']});

// Recorded PoseLandmarker world points (metres, y down): a T-pose, then the forearm raised.
const point = (x: number, y: number, z = 0): Landmark => ({x, y, z, visibility: 0.99});
const pose = (wrist: Landmark) => {
  const points = Array.from({length: 33}, () => point(0, 0));
  points[11] = point(0.17, -0.45);
  points[13] = point(0.44, -0.45);
  points[15] = wrist;
  return points;
};
const frame = (time: number, points: Landmark[]) => ({time, faces: [], hands: [], poses: [{landmarks: points, worldLandmarks: points}]});
body.calibrate(frame(0, pose(point(0.69, -0.45))));

const source = landmarkStream({buffer: 30});
for (let time = 33; time <= 990; time += 33) source.push(frame(time, pose(point(0.44, -0.7))));
source.close();
await body.drive(source, {signal: AbortSignal.timeout(5000)});
console.log(skeleton.getPose(2).rotation); // the elbow bent 90 degrees about +z
```

- `update(frame, time?)` poses the bones from the frame's first pose and one hand per side and returns `{tracked, driven, time}`; `drive(source, {signal, onUpdate})` does it for every frame of a `LandmarkSource`, such as `webcamLandmarks`.
- `calibrate(frame)`: the person stands in the skeleton's rest pose (T-pose or A-pose) and their landmark directions become the rest directions, so proportions and camera tilt drop out. Uncalibrated, the skeleton's own rest directions are used.
- Options: `bones` (humanoid name to skeleton name, or the index map `humanoidBones` returns; default the humanoid names, case-insensitive), `parts` (`['pose', 'hands']`), `minVisibility` (0.5: a hidden point leaves its bone where it was), `minScore` (0.5), `hold` (0.5 s, then back to the rest pose), `smoothing` (one-euro `{minCutoff: 1.5, beta: 0.3}` on each direction, or false), `mirror` (false; swaps left and right for a selfie picture), `aspect` (1; for image points when the detector gives no world points) and `limits` (radians per bone name, 0 to pi). A point that is hidden or not a finite number leaves its bone where it was.
- `POSE_TARGETS` and `handTargets(side)` list the driven bones with their landmarks and default limits (elbows and knees 2.7 rad, fingers 1.6 to 1.9, chest and neck 1). A limit bounds the turn from the bone's rest rotation relative to its parent, as a cone about the rest pose; hinge axes are not enforced. Twist about a bone is kept only where a side direction gives it (hips, chest, hands): upper arms and legs take the shortest turn.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/input

