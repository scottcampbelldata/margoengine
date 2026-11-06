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

## Query filters and tags

`world.query` intersects components. `Query` (from `margoengine/ecs`, or `margoengine/ecs/query` alone) adds `without` and `optional` terms, and `world.tag()` makes a component with no fields.

```ts
import {Query, World} from 'margoengine/ecs';
const world = new World(1024);
const position = world.component({x: Float32Array});
const health = world.component({value: Float32Array});
const frozen = world.tag();
const entity = world.create();
position.add(entity, {x: 1});
const stuck = world.create();
position.add(stuck, {x: 2});
frozen.add(stuck);
const moving = new Query(world, {with: [position], without: [frozen], optional: [health]});
moving.forEach((id, rows) => {
  position.fields.x[rows[0]] += 1;
  if (rows[1] >= 0) health.fields.value[rows[1]] -= 1; // -1: this entity has no health
});
const results = new Uint32Array(world.capacity);
console.log(moving.run(results), frozen.has(stuck)); // 1 true
```

| `new Query` term | Default | Meaning |
| --- | --- | --- |
| `with` | required | An entity must have all of these; at least one |
| `without` | none | An entity must have none of these |
| `optional` | none | Never changes the match; `forEach` gives its row, or -1 |

`run(output)` writes the ids into your array. `forEach(visit)` passes the `with` rows, then the `optional` rows, in one reused `Int32Array`. It takes the match list first and looks rows up just before each call, so `visit` can add, remove and destroy; entities that stop matching are passed over, and new matches wait for the next call. A `Query` cannot run inside its own `forEach`; use a second one to nest. Tags store no field data, only the 8 bytes per world slot every component uses for its entity index.

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

## Change detection

`ChangeTracker` (from `margoengine/ecs`, or `margoengine/ecs/changes` alone) answers which entities gained, changed or lost one component since its last `clear()`.

```ts
import {ChangeTracker, World} from 'margoengine/ecs';
const world = new World(1024);
const health = world.component({value: Float32Array});
const tracker = new ChangeTracker(health);
const entity = world.create();
health.add(entity, {value: 100});
const results = new Uint32Array(world.capacity);
console.log(tracker.added(results)); // 1, results[0] is the entity
tracker.clear();
health.add(entity, {value: 90}); // seen
health.fields.value[health.index(entity)] = 80; // not seen by itself...
health.touch(entity); // ...until reported
console.log(tracker.changed(results)); // 1
tracker.clear();
world.destroy(entity);
console.log(tracker.removed(results)); // 1, results[0] is now a stale id
tracker.stop();
```

`fields` are plain typed arrays, so a direct write cannot be seen: call `component.touch(entity)` after one, or write through `component.add`. Results are net over the window: added then removed reports nothing, removed then added back is `changed`, added then written stays `added`. Each tracker keeps its own window, so systems can read at their own pace; call `clear()` when one is done, for example in a last system of a `Schedule`. `stop()`, or `using`, detaches a tracker. A tracker costs 24 bytes per world slot. To react at once instead of reading a window, push your own `{onAdd, onChange, onRemove}` onto `component.observers`; do not add or remove rows of that component from inside one.

## Engine bridge

`MeshBridge` (from `margoengine/ecs/engine`) copies a transform component to core meshes in one call a frame, so systems work on packed arrays and never touch a mesh.

```ts
import {createStage} from 'margoengine';
import {World} from 'margoengine/ecs';
import {MeshBridge, transformSchema} from 'margoengine/ecs/engine';
const stage = await createStage('#app');
const world = new World(1024);
const transform = world.component(transformSchema);
const bridge = new MeshBridge(transform, {disposeMeshes: true});
const entity = world.create();
bridge.link(entity, stage.box());
stage.onTick((delta) => {
  transform.fields.x[transform.index(entity)] += delta;
  bridge.sync();
});
```

| `new MeshBridge` option | Default | Meaning |
| --- | --- | --- |
| `disposeMeshes` | `false` | Dispose a linked mesh when its entity loses the component or is destroyed |

`transformSchema` is position `x y z`, quaternion `qx qy qz qw` and scale `sx sy sz`. A component may hold any of those three groups, whole; a mesh keeps its own values for a group the component lacks. `link(entity, mesh)` fills a new row from the mesh, so nothing jumps; a row made by hand needs `qw: 1` and a scale, or `sync` throws the mesh's RangeError. `sync()` goes through the mesh's setters, so the checks are the same as a hand write and `mesh.rotation` stays correct, and it leaves a group alone when the mesh already holds those values. A link ends with `unlink(entity)`, when the entity loses the component or is destroyed, or with `stop()`. A mesh disposed behind the bridge makes `sync` throw MargoError `'disposed'` rather than write to whichever mesh reuses its slot. Transforms are local to the mesh's parent; set hierarchies on the meshes with `setParent`.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/ecs

