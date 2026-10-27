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

