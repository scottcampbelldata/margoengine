# @margoengine/tween

Numeric property interpolation and easing, with no per-track allocations in update.

```ts
import {Tween, easeInOutCubic} from '@margoengine/tween';
const timeline = new Tween();
const cancel = timeline.to(object, 'opacity', 1, {duration: 0.5, easing: easeInOutCubic});
timeline.update(1 / 60);
```

Times are seconds. delay, onComplete, zero-duration tracks and cancellation are supported. A new track for the same object/property cancels the old one. Callback-created tracks begin next update; clear cancels all tracks. Completed/cancelled tracks compact in place. Track creation and callbacks are outside the zero-allocation update guarantee. Targets are numeric writable properties; colors, strings and CSS parsing are not included.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/tween

