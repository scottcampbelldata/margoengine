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

