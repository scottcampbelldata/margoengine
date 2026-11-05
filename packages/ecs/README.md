# @margoengine/ecs

Import `margoengine/ecs` from the `margoengine` package, or `@margoengine/ecs` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

A bounded sparse-set ECS with packed Float32, Float64, Int32, Uint32 and Uint8 component fields.

```ts
import {World} from 'margoengine/ecs';
const world = new World(1024);
const position = world.component({x: Float32Array, y: Float32Array});
const entity = world.create();
position.add(entity, {x: 10});
const results = new Uint32Array(world.capacity);
const count = world.query([position], results);
```

Numeric entity IDs include a generation, so destroyed/reused slots reject stale handles. Removal swaps the last dense row into the removed row: call component.index(entity) before using a row index. Queries write into caller-owned storage and reject undersized output. Integer writes reject truncation and overflow. Capacity is fixed; this is a sparse-set implementation, not a second archetype storage engine.

## Systems and scheduler

`Schedule` (from `margoengine/ecs`, or `margoengine/ecs/schedule` alone) runs named systems in a dependable order. Each `update(delta)` runs the fixed phase, then the frame phase. A `fixed: true` system runs once per step the elapsed time pays for, so physics stays deterministic at any frame rate. Everything else runs once per update.

```ts
import {Schedule, World} from 'margoengine/ecs';
const world = new World(1024);
const position = world.component({x: Float32Array});
const velocity = world.component({x: Float32Array});
const entity = world.create();
position.add(entity, {x: 0});
velocity.add(entity, {x: 2});
const moving = new Uint32Array(world.capacity);
let paused = false;
const schedule = new Schedule({step: 1 / 60});
schedule.add('move', (time) => {
  const count = world.query([position, velocity], moving);
  for (let i = 0; i < count; i++) {
    const id = moving[i];
    position.fields.x[position.index(id)] += velocity.fields.x[velocity.index(id)] * time.delta;
  }
}, {fixed: true, when: () => !paused});
schedule.add('report', () => console.log(position.fields.x[position.index(entity)]), {after: ['move']});
schedule.update(1 / 30); // two fixed steps of move, then report once
```

| `new Schedule` option | Default | Meaning |
| --- | --- | --- |
| `step` | `1 / 60` | Seconds per fixed step |
| `maxSteps` | `8` | Most fixed steps in one update; the rest of a long stall is dropped and reported in `schedule.dropped` |

| `schedule.add` option | Default | Meaning |
| --- | --- | --- |
| `before`, `after` | none | Names of systems this one runs before or after, in the same phase; a frame system may also run `after` a fixed one |
| `when` | always | Run condition, asked before every run |
| `fixed` | `false` | Run in the fixed phase |

Systems receive `{delta, elapsed, tick, alpha, fixed}`: `delta` is the step in a fixed system and the frame time otherwise, `alpha` is the share of a step left in the accumulator, for blending the last two fixed states when drawing. The object is reused, so read it during the call. Order is `before` and `after`, then the order of `add`. `schedule.order()` lists the result. A missing name, a cycle, or a frame system ordered before a fixed one throws MargoError `'state'` from `order` or the next `update`. Systems are synchronous and run on the calling thread; a `Schedule` holds one step size, so use a second `Schedule` for a second rate.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/ecs

