# @margoengine/fsm

Import `margoengine/fsm` from the `margoengine` package, or `@margoengine/fsm` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Hierarchical states preserve common ancestors during transitions, bubble events from leaf to root, and expose previous/state/blend for cross-fades. On top of that: [history states](#history-states), [delayed transitions](#delayed-transitions), [parallel regions](#parallel-regions-margoenginefsmparallel), [machines as data](#machines-as-data-margoenginefsmdocument), and [snapshots and traces](#snapshots-and-trace-margoenginefsmtrace).

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

## Delayed transitions

Give a transition `after` in place of `event` and `update` takes it by itself once the machine has spent that many seconds in `from`. No timers to write, and none to cancel.

```ts
import {StateMachine} from 'margoengine/fsm';

const machine = new StateMachine({
  attack: {},
  windup: {parent: 'attack'},
  swing: {parent: 'attack'},
  recover: {},
  ready: {}
}, 'windup', {}, [
  {from: 'windup', to: 'swing', after: 0.2},
  {from: 'attack', to: 'recover', after: 0.5, duration: 0.1},
  {from: 'recover', to: 'ready', after: 0.3}
]);
machine.update(0.6);
console.log(machine.state); // 'recover'
```

- The time counts from entering `from`. A parent keeps counting while the machine moves between its children, as `attack` does above; leaving `from` cancels the wait, and coming back starts it again.
- A delay that ends inside a long `delta` splits it, so the machine does not depend on the frame rate: `update(0.6)` ends where 36 updates of 1/60 do, and the next state's delay counts from the moment the last one ended. Update hooks get the pieces of `delta`, which add up to the whole.
- A guard that declines is asked again on every update until it passes, or the machine leaves `from`.
- Inner states go first when delays end together.
- A delayed transition that leaves its `from` active, such as one from a parent to its child, waits again from that moment. So `{from: 'patrol', to: 'look', after: 5}` runs every five seconds while inside `patrol`.
- `machine.clock` is the machine's running time and `machine.entered` holds when each active state began.

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

## Machines as data (`margoengine/fsm/document`)

Keep a machine in a JSON file, as the animator keeps its graph, so a tool can write it and a designer can change it. Everything a machine has fits: hierarchy, `initial`, `history`, `after`, cross-fades and parallel regions. Functions do not fit in JSON, so hooks and guards are names, and you hand over the functions when loading. Guards get the context.

```ts
import {loadMachine, saveMachine, validateMachine, type MachineDocument} from 'margoengine/fsm/document';

const document: MachineDocument = {
  version: 1,
  initial: 'patrol',
  states: {
    patrol: {enter: 'shout'},
    chase: {update: 'run'},
    both: {regions: {
      legs: {states: {up: {}, down: {}}, initial: 'up', transitions: [{from: 'up', to: 'down', event: 'duck'}]}
    }}
  },
  transitions: [
    {from: 'patrol', to: 'chase', event: 'see', guard: 'awake', duration: 0.2},
    {from: 'chase', to: 'patrol', after: 5}
  ]
};
const guard = {awake: true};
const bindings = {
  hooks: {shout: () => console.log('who goes there'), run: (_context: typeof guard, delta: number) => console.log(delta)},
  guards: {awake: (context: typeof guard) => context.awake}
};

console.log(validateMachine(document, bindings)); // []
const machine = loadMachine(document, guard, bindings);
machine.send('see');
const text = JSON.stringify(saveMachine(machine, bindings));
const again = loadMachine(JSON.parse(text), guard, bindings);
```

- `validateMachine(value, bindings?)` takes anything, such as what `JSON.parse` gave, and lists every problem with its place, `[{path: 'transitions[2].to', message: '...'}]`, or nothing. Unknown keys are problems, so a typing slip does not pass quietly. With `bindings` each name must also have its function.
- `loadMachine(document, context, bindings?)` builds the machine, or throws a `TypeError` listing every problem. A raised event no region takes goes to the machine holding the regions.
- `saveMachine(machine, bindings?)` gives the document of any machine, also one built by hand: it finds each function's name in `bindings`, and throws a `TypeError` for one that has none. It saves the definition, not where the machine is now: for that see below.
- A state with regions takes no hooks in a document; put them on its parent.

Guards in `StateMachine` get the context too: `guard: (context) => context.awake`.

## SCXML (`margoengine/fsm/scxml`)

Read and write the W3C SCXML subset that maps onto machine documents: `state`, `parallel`, `initial`, `history`, `transition` with `event`/`cond`/`target`, and `onentry`/`onexit` hooks written as a name call such as `leave()`. Hooks and guards stay names, as in a document; nothing in the file runs. Margo reads the XML itself, the same way in browsers, workers and Node, so no DOM parser is needed and file text is never parsed as HTML.

```ts
import {loadMachine} from 'margoengine/fsm/document';
import {exportSCXML, importSCXML} from 'margoengine/fsm/scxml';

const document = importSCXML(`<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" initial="idle">
  <state id="idle"><transition event="go" target="run" cond="ready()"/></state>
  <state id="run"><onentry><script>shout()</script></onentry></state>
</scxml>`);
const machine = loadMachine(document, {}, {hooks: {shout: () => console.log('off we go')}, guards: {ready: () => true}});
machine.send('go');
console.log(machine.state); // 'run'
console.log(exportSCXML(document, {extensions: false}).startsWith('<?xml')); // true
```

- `importSCXML(text)` throws a `TypeError` naming the problem for malformed XML, a DTD or entity declaration, processing instructions, script code that is not a single name call, unknown elements or attributes, or input over 1 MiB, 10,000 elements or 128 levels deep.
- `exportSCXML(document, {extensions})` writes the document back. With the default `extensions: true`, fields SCXML cannot hold (`after`, `duration`, `update`, region history, names that are not XML ids) keep their values in the `urn:margoengine:fsm:1` namespace; with `extensions: false` such a document is refused instead of losing them.
- The old `parser` option is ignored and deprecated.

## Snapshots and trace (`margoengine/fsm/trace`)

`snapshotMachine` gives where a machine is now as plain data: the state, cross-fade, every delay's progress, what states remember and all parallel regions. Put it in a save file or send it over the network, and `restoreMachine` puts a machine with the same definition back there. The machine then goes on exactly as the first would have, so rollback netcode can go back and replay.

```ts
import {StateMachine} from 'margoengine/fsm';
import {MachineTrace, restoreMachine, snapshotMachine} from 'margoengine/fsm/trace';

const make = () => new StateMachine({idle: {}, windup: {}, swing: {}}, 'idle', {}, [
  {from: 'idle', to: 'windup', event: 'attack'},
  {from: 'windup', to: 'swing', after: 0.5}
]);

const machine = make();
using trace = new MachineTrace(machine, {capacity: 64});
machine.send('attack');
machine.update(0.25);

const save = JSON.stringify(snapshotMachine(machine));
const loaded = make();
restoreMachine(loaded, JSON.parse(save));
loaded.update(0.25);
console.log(loaded.state); // 'swing'
console.log(trace.records); // [{machine: '', clock: 0, from: 'idle', to: 'windup', event: 'attack', after: null}]
```

- `restoreMachine` runs no hooks. It restores the machine, and what your hooks did to your context is yours to save beside it.
- A snapshot that does not fit the machine throws a `TypeError` and leaves the machine untouched. Both functions throw a `MargoError` with code `state` from a hook in the middle of a change.
- `MachineTrace` keeps the newest `capacity` changes, default 256, oldest first in `records`, for every machine down through parallel regions. `machine` says which, such as `alive/weapon`; `event` and `after` say what caused the change, both null for `goto`. `from` is null when regions start and `to` when they stop. `dispose()`, or `using`, stops it.
- A machine has one `listener`, the hook a trace uses; set it yourself for your own debug overlay. A second trace on the same machine throws a `MargoError` with code `attached`.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/fsm

