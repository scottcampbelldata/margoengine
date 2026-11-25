# @margoengine/ecs

Import `margoengine/ecs` from the `margoengine` package, or `@margoengine/ecs` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

A sparse-set ECS with packed Float32, Float64, Int32, Uint32 and Uint8 component fields.

```ts
import {World} from 'margoengine/ecs';
const world = new World(1024);
const position = world.component({x: Float32Array, y: Float32Array});
const entity = world.create();
position.add(entity, {x: 10});
const results = new Uint32Array(world.capacity);
const count = world.query([position], results);
```

Numeric entity IDs include a generation, so destroyed/reused slots reject stale handles. Removal swaps the last dense row into the removed row: call component.index(entity) before using a row index. Queries write into caller-owned storage and reject undersized output. Integer writes reject truncation and overflow. A `World` has a fixed capacity; a `GrowableWorld` grows. This is a sparse-set implementation, not a second archetype storage engine.

## Growable worlds

`GrowableWorld` (from `margoengine/ecs/growable`) doubles its slots when `create` runs out, so you do not have to guess a capacity. Everything else works as in a `World`.

```ts
import {GrowableWorld} from 'margoengine/ecs/growable';
const world = new GrowableWorld({capacity: 1024});
const position = world.component({x: Float32Array});
const {x} = position.fields;
const results = world.allocate(Uint32Array); // keeps up with the capacity
for (let i = 0; i < 5000; i++) position.add(world.create(), {x: i});
console.log(world.capacity, x.length); // 8192 8192
console.log(world.query([position], results)); // 5000
```

| `new GrowableWorld` option | Default | Meaning |
| --- | --- | --- |
| `capacity` | `1024` | Slots at the start |
| `limit` | `1000000` | Most slots it may grow to, at most 1,000,000; past it `create` throws `RangeError` |

Growing moves nothing: arrays sit on resizable buffers, so `component.fields`, arrays taken from them and ids all stay valid, and arrays only get longer. A `Uint32Array` you made yourself stays its size, so make query outputs with `world.allocate(Uint32Array)`. Ids are spaced by `limit`, and an id must fit 32 bits, so a slot retires after about 4,294,967,295 / `limit` reuses (4,294 at the default) and the world grows past it; lower `limit` for a world that churns entities hard. Resizable arrays cost speed: a loop over 100,000 rows took about twice as long as on a plain `World` (0.25 to 0.31 ms against 0.12 to 0.15, Node 26, busy machine, [ecs-growable.mjs](../../examples/package-benchmarks/ecs-growable.mjs)). When a bound is known, use a `World`.

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

## Script components

`Scripts` (from `margoengine/ecs/scripts`) puts behaviour on entities the way the script components of PlayCanvas and Needle do: a script type declares typed attributes and lifecycle hooks, and any number of instances attach to an entity. One registry belongs to one `World`; there are no globals. Hooks run with the instance as `this`, which carries `entity`, `world`, `attributes`, `state` (yours, kept across hot reload) and `enabled`.

```ts
import {Schedule, World} from 'margoengine/ecs';
import {Scripts, defineScript} from 'margoengine/ecs/scripts';
const world = new World(64);
const errors: unknown[] = [];
const scripts = new Scripts(world, {onError: (error) => errors.push(error)});
const spin = defineScript({
  name: 'spin',
  attributes: {
    speed: {type: 'number', default: 1, min: 0, max: 10},
    axis: {type: 'vec3', default: [0, 1, 0]},
    tint: {type: 'color', default: '#ff8800'},
  },
  initialize() { this.state.angle = 0; },
  update(dt) { this.state.angle += this.attributes.speed * dt; },
  onAttributeChange(name, value, previous) { console.log(name, previous, '->', value); },
});
scripts.register(spin);
const entity = world.create();
const instance = scripts.add(entity, spin, {values: {speed: 2}});
const schedule = new Schedule();
scripts.install(schedule); // frame system "scripts" and fixed system "scripts.fixed"
schedule.update(0.5);
instance.attributes.speed = 4; // validated; logs: speed 2 -> 4
console.log(instance.state.angle); // 1
// Hot reload: same instances, attribute values and state, no new initialize.
scripts.reload(defineScript({
  name: 'spin',
  attributes: {speed: {type: 'number', default: 1}, axis: {type: 'vec3'}},
  update(dt) { this.state.angle += this.attributes.speed * dt * 2; },
  swap(previous) { console.log('swapped from', previous.name); },
}));
schedule.update(0.5);
console.log(instance.state.angle, scripts.schema()[0].attributes.map((a) => a.name)); // 5 [ 'speed', 'axis' ]
scripts.dispose();
```

| Attribute `type` | Value | Options |
| --- | --- | --- |
| `number` | finite number, default 0 | `min`, `max` |
| `boolean`, `string` | default `false`, `''` | none |
| `enum` | one of `options`, default the first | `options` (required) |
| `vec2`, `vec3`, `vec4` | array of that many finite numbers, default zeros | `min`, `max` per element |
| `color` | `[r, g, b, a]` in 0..1, or `'#rgb'` / `'#rrggbb'`, default white | `min`, `max` (inside 0..1) |
| `entity`, `asset` | entity id or asset id string, default `null` | `assetKind` hint |

Every attribute also takes `default` and `title` (an inspector label). A bad default throws when the script is defined; a bad value throws `RangeError` naming the attribute when it is added or assigned. `scripts.schema()` returns every registered type's attributes as JSON-safe data for an inspector.

| Hook | When |
| --- | --- |
| `onEnable`, `initialize`, `postInitialize` | First `update`, `fixedUpdate` or `flush` after `add` while enabled: every `initialize` of the batch, then every `postInitialize` |
| `update(dt)`, `postUpdate(dt)` | Each `scripts.update(dt)`, every `update` before any `postUpdate`, ordered by `priority` then by `add` |
| `fixedUpdate(step)` | Each `scripts.fixedUpdate(step)` |
| `onEnable`, `onDisable` | `instance.enabled` changes; a disabled instance gets no update hooks |
| `onAttributeChange(name, value, previous)` | An attribute is assigned a different value after `initialize` |
| `destroy` | `scripts.remove`, `world.destroy(entity)` or dispose, after `onDisable` |
| `swap(previous)` | Hot reload, on the new type |

`scripts.reload(newType, {reinitialize})` swaps the implementation registered under that name. Instances stay with their attribute values (kept when the attribute still exists and is valid, else reset to the new default), `state`, enabled flag and order. `initialize` runs again only with `reinitialize: true`, after the old `onDisable` and `destroy`, with `state` cleared. An error thrown by a hook goes to `onError(error, {script, hook})` and the other scripts still run; without `onError` the pass finishes and throws one MargoError `'failed'` whose `cause` is the first error. `scripts.dispose()` (or `using`) destroys every instance.

Sources: the feature set follows the public documentation of PlayCanvas script components (attributes, initialize/postInitialize/update/postUpdate, enable/disable, swap for hot reload) and Needle Engine components; the code is written clean room from those feature names.

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

## Relationships

`Relation` (from `margoengine/ecs`, or `margoengine/ecs/relations` alone) holds pairs of entities with a meaning you name. A pair goes from a source to a target and reads both ways.

```ts
import {Relation, World} from 'margoengine/ecs';
const world = new World(1024);
const childOf = new Relation(world, {exclusive: true, cascade: true, acyclic: true});
const owns = new Relation(world);
const ship = world.create();
const turret = world.create();
const barrel = world.create();
childOf.add(turret, ship);
childOf.add(barrel, turret);
owns.add(ship, barrel);
owns.add(ship, turret);
const results = new Uint32Array(world.capacity);
console.log(childOf.target(barrel) === turret); // true
console.log(childOf.sources(ship, results)); // 1: the children of ship
console.log(childOf.descendants(ship, results)); // 2: turret, then barrel
console.log(owns.targets(ship, results)); // 2
world.destroy(ship); // turret and barrel go with it; every pair ends
console.log(world.alive(barrel), owns.size); // false 0
```

| `new Relation` option | Default | Meaning |
| --- | --- | --- |
| `exclusive` | `false` | A source has at most one target; a new pair replaces the old one |
| `cascade` | `false` | Destroying a target destroys its sources, all the way down |
| `acyclic` | `false` | `add` throws `TypeError` for a pair that would close a loop |

`has`, `target`, `targets`, `sources`, `descendants` and `forEach` read pairs directly. Results go into your `Uint32Array`, oldest pair first, and `descendants` is breadth first, so parents come before children. Pairs of a destroyed entity always end. An `acyclic` add walks up from the target, so it costs the depth of the hierarchy. `stop()`, or `using`, ends all pairs and detaches from the world. Pairs live in Maps and Sets, not typed arrays: keep per-frame data in components.

## Engine bridge

`MeshBridge` (from `margoengine/ecs/engine`) copies a transform component to core meshes in one bulk step a frame, so systems work on packed arrays and never touch a mesh. It writes through `TransformWriter` from `@margoengine/scene/bulk`, an optional peer of this entry: `margoengine` includes it, and with the `@margoengine/*` packages install `@margoengine/scene` beside `@margoengine/ecs`.

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

`transformSchema` is position `x y z`, quaternion `qx qy qz qw` and scale `sx sy sz`. A component may hold any of those three groups, whole; a mesh keeps its own values for a group the component lacks. `link(entity, mesh)` fills a new row from the mesh, so nothing jumps; a row made by hand needs `qw: 1` and a scale, or `sync` throws the mesh's RangeError. `sync()` takes one pass over the links to find what moved, then makes one `TransformWriter` write per changed group for each run of rows that changed, so a world where everything moves costs three writes and a world where nothing moves costs that pass alone. The checks and the result are those of the mesh's setters, `mesh.rotation` included, and a group the mesh already holds is left alone. The first `sync` after a link or unlink builds the writer again, about one pass over the links. A link ends with `unlink(entity)`, when the entity loses the component or is destroyed, or with `stop()`. A mesh disposed behind the bridge makes `sync` throw MargoError `'disposed'` rather than write to whichever mesh reuses its slot. Transforms are local to the mesh's parent; set hierarchies on the meshes with `setParent`.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/ecs

