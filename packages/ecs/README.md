# @margoengine/ecs

A bounded sparse-set ECS with packed Float32, Float64, Int32, Uint32 and Uint8 component fields.

```ts
import {World} from '@margoengine/ecs';
const world = new World(1024);
const position = world.component({x: Float32Array, y: Float32Array});
const entity = world.create();
position.add(entity, {x: 10});
const results = new Uint32Array(world.capacity);
const count = world.query([position], results);
```

Numeric entity IDs include a generation, so destroyed/reused slots reject stale handles. Removal swaps the last dense row into the removed row: call component.index(entity) before using a row index. Queries write into caller-owned storage and reject undersized output. Integer writes reject truncation and overflow. Capacity is fixed; this is a sparse-set implementation, not a second archetype storage engine.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/ecs

