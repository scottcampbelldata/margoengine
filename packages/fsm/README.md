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

## History states

Give a parent `history` and it returns to where it was when you come back, for pause menus and interrupts. Give it `initial` for the child to start in before that, and for any parent that should never rest on itself.

```ts
import {StateMachine} from 'margoengine/fsm';

const machine = new StateMachine({
  play: {history: 'deep', initial: 'explore'},
  explore: {parent: 'play'},
  combat: {parent: 'play', initial: 'melee'},
  melee: {parent: 'combat'},
  ranged: {parent: 'combat'},
  pause: {}
}, 'play', {}, [
  {from: 'explore', to: 'combat', event: 'enemy'},
  {from: 'melee', to: 'ranged', event: 'switch'},
  {from: 'play', to: 'pause', event: 'pause'},
  {from: 'pause', to: 'play', event: 'resume'}
]);
machine.send('enemy');
machine.send('switch');
machine.send('pause');
machine.send('resume');
console.log(machine.state); // 'ranged'; with history: 'shallow', 'melee', as combat restarts at its initial
```

- A transition to `play` uses the memory; a transition straight to a child of `play` does not, and an exit records it again as usual.
- The memory counts when the state is entered. A transition to a parent the machine is still inside goes to the parent's `initial`, or stops on the parent if it has none.
- `machine.memory` maps each state to what it remembers: `machine.memory.delete('play')` forgets one, `machine.memory.clear()` forgets all.
- Each state with `history` keeps its own memory, and a state remembered by a parent uses its own on the way in.
- Parallel regions inside remembered states start again at their `initial`, unless the regions have `{history: true}`.

## Parallel regions (`margoengine/fsm/parallel`)

Run independent states at once, such as what a character's legs do and what its weapon does. Each region is an ordinary machine with one active state of its own; they share a context and hear the same events. Two machines side by side would do until a guard in one reads the other, or a hook in one tells the other: `ParallelRegions` settles those.

```ts
import {ParallelRegions} from 'margoengine/fsm/parallel';

const regions: ParallelRegions<object> = new ParallelRegions({
  movement: {
    states: {idle: {}, run: {}},
    initial: 'idle',
    transitions: [{from: 'idle', to: 'run', event: 'move'}, {from: 'run', to: 'idle', event: 'halt'}]
  },
  weapon: {
    states: {ready: {}, firing: {}},
    initial: 'ready',
    transitions: [{
      from: 'ready', to: 'firing', event: 'fire',
      guard: () => !regions.matches('movement', 'run')
    }]
  }
}, {});

regions.start();
regions.send('fire');
regions.update(1 / 60);
console.log(regions.active); // {movement: 'idle', weapon: 'firing'}
```

- `send(event)` reaches every region and returns true when one took it. All regions choose first and then all move, so a guard sees the same states whichever region it sits in, and the order of the regions changes nothing but the order hooks run in.
- `raise(event)` is for hooks: the event waits until the running delivery ends, then goes to every region, in the order raised. `send` from a hook throws. `forward: (event) => machine.send(event)` gets a raised event no region took.
- `active` gives each region's state, `matches(region, state)` tests one, parents included, and `machines` holds each region's `StateMachine`, for `blend` and the like.
- Regions enter in the order written and leave in reverse. `stop()` leaves them, and `start()` begins at each `initial` again, or where each stopped with `{history: true}`.

Put regions in a state of another machine with `asState()`. Entering that state starts them, leaving stops them, and an event reaches them first: the outer machine's transitions on the same event only run when no region took it. Regions nest the same way.

```ts
import {StateMachine} from 'margoengine/fsm';
import {ParallelRegions} from 'margoengine/fsm/parallel';

const regions: ParallelRegions<object> = new ParallelRegions({
  legs: {states: {stand: {}, walk: {}}, initial: 'stand', transitions: [{from: 'stand', to: 'walk', event: 'move'}]},
  arms: {states: {rest: {}, wave: {}}, initial: 'rest', transitions: [{from: 'rest', to: 'wave', event: 'greet'}]}
}, {});
const machine = new StateMachine({game: {}, alive: {...regions.asState(), parent: 'game'}, dead: {parent: 'game'}}, 'alive', {}, [
  {from: 'alive', to: 'dead', event: 'die'}
]);
machine.send('move'); // the legs walk
machine.send('die'); // the regions stop
```

A transition cannot cross from one region to another or into a region from outside: a region starts at its `initial`, and a transition out of the regions belongs to the state that holds them. `machine.plan(event)` is the choosing half of `send`, which a nested machine uses through the `plan` hook of `State`; `machine.matches(state)` tests the active path.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/fsm

