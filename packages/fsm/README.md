# @margoengine/fsm

Hierarchical states preserve common ancestors during transitions, bubble events from leaf to root, and expose previous/state/blend for cross-fades.

```ts
import {StateMachine} from '@margoengine/fsm';
const machine = new StateMachine({game: {}, idle: {parent: 'game'}, run: {parent: 'game'}}, 'idle', {}, [
  {from: 'idle', to: 'run', event: 'move', duration: 0.2}
]);
machine.send('move');
machine.update(1 / 60);
```

State hooks receive context; update hooks also receive delta seconds. Guards can decline an event transition. Hierarchy cycles and unknown states are rejected. goto changes state directly. Recursive transitions from enter/exit hooks are rejected. Cross-fade progress is a timer for the caller's animation mixer; this package does not own animations.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/fsm

