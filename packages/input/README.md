# @margoengine/input

Semantic actions combine keyboard codes, mouse buttons and relative motion, gamepad axes/buttons, and touch controls.

```ts
import {Input} from '@margoengine/input';
const input = new Input({jump: [{type: 'key', code: 'Space'}]});
input.update();
const {pressed, value} = input.state('jump');
```

Call update once per simulation tick. State objects are reused. Opposing bindings sum and clamp to -1..1; gamepad axes use a configurable deadzone. createStick(parent, id) creates a pointer-captured virtual stick; bindTouchButton(button, id) supports pointer and keyboard activation. rumble(durationMs, strength, gamepadIndex) returns false when no actuator is available. dispose removes listeners and owned stick elements. Editable fields do not trigger gameplay key-down actions. Mouse motion is relative, not an absolute screen cursor.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/input

