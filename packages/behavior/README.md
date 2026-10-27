# @margoengine/behavior

Import `margoengine/behavior` from the `margoengine` package, or `@margoengine/behavior` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Game AI for agents: behaviour trees with a typed blackboard and async tasks, utility-AI scoring, and steering and
flocking behaviours. No rendering, no globals, nothing runs on import; it works the same in the browser, a worker or
Node. For states with cross-fades use `@margoengine/fsm`; for walking on a navigation mesh with ORCA avoidance use
`@margoengine/navmesh`'s `Crowd`. Both work with this package (below).

## Behaviour trees

```ts
import { BehaviorTree, action, blackboardKey, condition, cooldown, reactiveSelector, sequence, wait } from 'margoengine/behavior';

const enemyNear = blackboardKey('enemyNear', false);
const tree = new BehaviorTree(
  reactiveSelector(
    sequence(condition('enemyNear'), cooldown(1, action('attack'))),
    sequence(action('walkToNextPoint'), wait(2)),
  ),
  {
    seed: 42,
    handlers: {
      conditions: { enemyNear: (tick) => tick.blackboard.get(enemyNear) },
      actions: {
        attack: () => 'success',
        // An async action is a task: it runs over several ticks, and its signal aborts when the branch is halted.
        walkToNextPoint: async (tick) => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return !tick.signal.aborted;
        },
      },
    },
  },
);
tree.blackboard.set(enemyNear, true);
const status = tree.tick(1 / 60); // 'success' | 'failure' | 'running'
```

Call `tick(delta)` once per frame or fixed step. Each tick walks the tree from the root, depth first; after the root
finishes, the next tick starts it again. Nodes:

| Node | Builder | Behaviour |
| --- | --- | --- |
| sequence | `sequence(...)`, `reactiveSequence(...)` | children in order until one fails |
| selector | `selector(...)`, `reactiveSelector(...)` | children in order until one succeeds |
| random selector | `randomSelector(children, weights?)` | a selector whose order is drawn from the seeded stream (by weight) each time it starts |
| parallel | `parallel(children, {success, failure})` | ticks every child; `'all'`, `'any'` or a count (defaults `success: 'all'`, `failure: 'any'`) |
| utility | `utility([{score, child}], {inertia, threshold})` | utility-AI selector: runs the best-scoring option each tick (ties go to the first) |
| inverter | `inverter(child)` | flips success and failure |
| repeater | `repeater(child, {count, until})` | runs the child again, one run per tick, `count` times (default forever) or until it returns `until` |
| cooldown | `cooldown(seconds, child)` | after the child finishes, fails without running it for `seconds` |
| guard | `guard(condition, child)` | checks a condition every tick and runs the child only while it holds |
| timeout | `timeout(seconds, child)` | fails, halting the child, when it runs longer than `seconds` |
| condition | `condition(name)` | a named condition handler: true is success |
| action | `action(name)` | a named action handler, sync or async |
| wait | `wait(seconds)` | running for `seconds`, then success |

Plain sequences and selectors have memory: they resume at the child that was running. Reactive ones re-check the
earlier children every tick and halt the running one when an earlier child decides (the usual "abort lower priority").
Halting a node aborts the `signal` of every action under it, so `fetch`, timers and loaders stop with the branch.

Handlers receive a `tick` with `blackboard`, `context` (the `context` option: your agent, entity id or world),
`delta`, `time`, `random` and `signal`. Actions return `'success'`, `'failure'`, `'running'`, a boolean, nothing
(success) or a promise of one of these. A rejected promise is not swallowed: the next `tick` throws `MargoError`
`'failed'` with the error as its `cause`; return `'failure'` for an expected failure.

Deterministic: time is the sum of the deltas you pass (durations count from the tick a node starts on), and all
randomness comes from one mulberry32 stream seeded by `seed` (default 0). The same description, seed, handlers and
deltas give the same statuses and the same trace on every run and every machine. Promise-based actions settle when
their work settles, so a replay that must match exactly should resolve them from your own simulation.

### Saving, loading and validating trees

Every node is plain JSON (leaves name their handlers), so a tree is saved with `JSON.stringify` and loaded with
`parseTree`:

```ts
import { BehaviorTree, action, parseTree, sequence, treeDocument, validateTree, wait } from 'margoengine/behavior';

const text = JSON.stringify(treeDocument(sequence(action('jump'), wait(0.5))));
const handlers = { actions: { jump: () => 'success' as const } };
const problems = validateTree(JSON.parse(text), handlers); // [] when valid: [{path, message}] otherwise
const tree = new BehaviorTree(parseTree(text, handlers), { handlers });
tree.tick(0.1);
```

`validateTree` never throws, whatever it is given, and lists every problem with its path and fix
(`root.children[0].seconds: must be a finite number of seconds, 0 or more`); `parseTree` and the `BehaviorTree`
constructor throw a `TypeError` naming the first one. Trees deeper than `MAX_TREE_DEPTH` (256) or larger than
`MAX_TREE_NODES` (100,000) are rejected. A document is `{format: 'margo-behavior', version: 1, root}`.

### Debug trace

```ts
import { BehaviorTree, action, condition, formatTrace, selector, sequence } from 'margoengine/behavior';

const debug = new BehaviorTree(selector(sequence(condition('seesEnemy'), action('attack')), action('patrol')), {
  handlers: { conditions: { seesEnemy: () => false }, actions: { attack: () => 'success', patrol: () => 'running' } },
  trace: true,
});
debug.tick();
console.log(formatTrace(debug.trace));
// [R] selector
//   [F] sequence
//     [F] condition seesEnemy
//   [R] action patrol
```

`tree.trace` holds one entry per node ticked (`path`, `depth`, `type`, `name`, `status`, and utility `scores`), ready
for an inspector panel or a log. Give any node a `label` to name it in the trace. Tracing is off by default.

### Blackboard

`blackboardKey<T>(name, fallback)` declares a typed key; `blackboard.get(key)` returns the value or the fallback,
`set`, `has`, `delete` and `clear` change it, and `version` counts changes. `toJSON()` and `new Blackboard(json)` save
and restore it. Share one blackboard between several trees for squad memory.

## Utility AI

```ts
import { BehaviorTree, action, chooseBest, combineConsiderations, curves, utility } from 'margoengine/behavior';

const nearness = curves.inverse(),
  urgency = curves.logistic(12, 0.6);
const npc = { health: 0.3, enemyDistance: 0.2 };
const fleeScore = combineConsiderations([urgency(1 - npc.health), nearness(npc.enemyDistance)]);
const choice = chooseBest([
  { value: 'flee', score: fleeScore },
  { value: 'fight', score: npc.health },
]);
const brain = new BehaviorTree(
  utility([
    { score: 'flee', child: action('runAway') },
    { score: 'fight', child: action('attack') },
  ], { inertia: 0.1 }),
  {
    handlers: {
      scores: { flee: () => fleeScore, fight: () => npc.health },
      actions: { runAway: () => 'running', attack: () => 'running' },
    },
  },
);
brain.tick();
```

Response curves (`linear`, `power`, `logistic`, `step`, `inverse`) map an input to [0, 1], clamping both.
`combineConsiderations` multiplies consideration scores with Mark and Dill's compensation factor, so options with more
considerations are not penalised for it. The `utility` node's `inertia` keeps the running option unless another beats
it by that margin; options must score above `threshold` (default 0) to run.

## Steering and flocking

```ts
import { Steering, avoidObstacles, integrate, seek, separation } from 'margoengine/behavior/steering';

const pillars = [{ position: [4, 0, 0.2] as const, radius: 0.5 }];
const others = [{ position: [1, 0, 1] as const, velocity: [0, 0, 0] as const }];
const guard = { position: [0, 0, 0], velocity: [0, 0, 0], maxSpeed: 3, maxForce: 8 };
const steering = new Steering<typeof guard>()
  .add((agent, out) => void avoidObstacles(agent, pillars, { radius: 0.4 }, out), { priority: 1 })
  .add((agent, out) => void seek(agent, [8, 0, 0], out))
  .add((agent, out) => void separation(agent, others, 1.5, out), { weight: 2 });
integrate(guard, steering.compute(guard), 1 / 60);
```

Behaviours, after Reynolds (1987, 1999): `seek`, `flee` (optional panic distance), `arrive` (slows inside a radius),
`pursue` and `evade` (lead a moving target), `wander` (seeded, on the ground plane), `avoidObstacles` (spheres in the
path ahead), `followPath` (a polyline, open or looped), and `separation`, `cohesion` and `alignment` over neighbours.
Each writes a force into `out` and returns it. `Steering` blends forces by weight within a priority group and gives a
higher group precedence whenever it acts (so obstacle avoidance at priority 1 overrides the flock), clamping to
`maxForce`. `integrate(agent, force, delta)` applies it, clamped to `maxSpeed`. Units are world units and seconds.

`flock(arrays, count, options, delta)` steps a whole flock stored as structure-of-arrays, with a uniform grid for
neighbours. ECS component fields fit as they are:

```ts
import { World } from 'margoengine/ecs';
import { flock } from 'margoengine/behavior/steering';

const world = new World(1024);
const boid = world.component({ x: Float32Array, y: Float32Array, z: Float32Array, vx: Float32Array, vy: Float32Array, vz: Float32Array });
for (let i = 0; i < 200; i++) boid.add(world.create(), { x: (i % 20) * 0.8, z: Math.floor(i / 20) * 0.8, vx: 1 });
flock(boid.fields, boid.size, { radius: 2, maxSpeed: 4 }, 1 / 60);
```

With `@margoengine/navmesh`: a `CrowdAgent` is a steering agent as it is (`position`, `velocity`, `maxSpeed`), the
crowd's `agents` are valid neighbours, and a route from `navMesh.path(start, end)` is a valid `followPath` path. The
crowd itself steers its agents to their targets with ORCA avoidance; use these behaviours for agents the crowd does
not drive (birds, fish, a pet following the player) or to compute a preferred velocity for `avoid`.

Errors name their fix: a bad argument throws `TypeError` or `RangeError` (`Agent maxSpeed must be a finite number of
0 or more`), a call that is not valid right now throws `MargoError` with code `state` (ticking from inside a handler),
`disposed` (after `dispose()`) or `failed` (a rejected task). `using tree = new BehaviorTree(...)` halts it at the end
of the scope.

Apache-2.0. Optional, tree-shakable package; no core dependency.

Build and unit tests: npm test --workspace @margoengine/behavior
