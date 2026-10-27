# @margoengine/fsm

Import `margoengine/fsm` from the `margoengine` package, or `@margoengine/fsm` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Hierarchical states preserve common ancestors during transitions, bubble events from leaf to root, and expose previous/state/blend for cross-fades.

```ts
import {StateMachine} from 'margoengine/fsm';
const machine = new StateMachine({game: {}, idle: {parent: 'game'}, run: {parent: 'game'}}, 'idle', {}, [
  {from: 'idle', to: 'run', event: 'move', duration: 0.2}
]);
machine.send('move');
machine.update(1 / 60);
```

State hooks receive context; update hooks also receive delta seconds. Guards can decline an event transition. Hierarchy cycles and unknown states are rejected. goto changes state directly. Recursive transitions from enter/exit hooks are rejected. Cross-fade progress is a timer for the caller's animation mixer; this package does not own animations.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/fsm

