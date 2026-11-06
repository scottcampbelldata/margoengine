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
const binding = await input.captureBinding({signal: AbortSignal.timeout(10_000)}); // "press a key to rebind"
input.rebind('jump', [binding]);
localStorage.setItem('bindings', JSON.stringify(input.exportBindings()));
input.importBindings(localStorage.getItem('bindings')!); // unknown actions are ignored; invalid data changes nothing
input.resetBindings();
```

- `modifiers` (`'shift' | 'ctrl' | 'alt' | 'meta'`) on a `key` binding makes a chord: the key counts only while every modifier is held.
- `contexts` (option) group actions; an action owned by contexts reads 0 unless one is enabled. Unlisted actions are always active.
- `captureBinding` resolves with the next key (with held modifiers), mouse button or gamepad button; Escape or the signal rejects with `AbortError`.

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

declare const button: HTMLButtonElement;
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

declare const canvas: HTMLCanvasElement;
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
- Tilt and altitude with azimuth are both filled in, whichever the browser gives.
- A dab between two updates still reads `down` for one update.
- Options: `curve` (shapes pressure within 0 to 1, default none) and `maxSamples` (kept between `take` calls, oldest dropped, default 4096).

## Gestures

```ts
import {Gestures} from 'margoengine/input';
declare const canvas: HTMLCanvasElement;
let zoom = 1;
using gestures = new Gestures(canvas, {swipeDistance: 60});
gestures.on('pinch', (e) => (zoom *= e.scale!));
gestures.on('swipe', (e) => console.log(e.direction, e.velocity));
gestures.on('doubletap', () => (zoom = 1));
```

Touch and pen only (mouse never triggers them, so they never fight orbit controls): `tap`, `doubletap`, `swipe` (direction and px/s), two-finger `pinch` (scale since the last event) and `rotate` (radians). Thresholds are options with defaults. Set `touch-action: none` on the element.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/input

