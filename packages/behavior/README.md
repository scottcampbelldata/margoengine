# @margoengine/behavior

Import `margoengine/behavior` from the `margoengine` package, or `@margoengine/behavior` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Game AI for agents: behaviour trees with a typed blackboard and async tasks, utility-AI scoring, steering and
flocking behaviours, and perception. No rendering, no globals, nothing runs on import; it works the same in the browser, a worker or
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

## Perception

Sight, hearing and a memory of last seen targets, written to the blackboard your behaviour tree already reads.

```ts
import { Blackboard } from 'margoengine/behavior';
import {
  OccupancyMap,
  Perception,
  perceptionLevel,
  perceptionPosition,
  sphereOcclusion,
} from 'margoengine/behavior/perception';

const blackboard = new Blackboard();
const guard = { position: [0, 0, 0], forward: [0, 0, 1] };
const eyes = new Perception(guard, {
  blackboard,
  eyeHeight: 1.6,
  sight: [
    { kind: 'cone', range: 12, fov: 1.9, nearTime: 0.2, farTime: 1 },
    { kind: 'coffin', range: 40, shoulder: 15, width: 10, nearTime: 1, farTime: 4 },
  ],
  lineOfSight: sphereOcclusion([{ position: [2, 1, 6], radius: 1 }]),
});

const player = { id: 'player', position: [0, 1, 8], velocity: [1, 0, 0] };
eyes.update(1 / 60, [player]); // every tick
eyes.hear({ position: [3, 0, -2], radius: 15, priority: 0.6 }); // when something makes a noise

blackboard.get(perceptionLevel); // 'calm', 'suspicious' or 'aware'
blackboard.get(perceptionPosition); // last known position, or null
eyes.predict('player'); // where it probably went

// Lost it? Spread the chance out, rule out what the guard can see, and go to the best guess.
const map = OccupancyMap.grid({ min: [-20, -20], size: [40, 40], cell: 1 });
map.observe(player.position);
map.diffuse();
map.cull((at) => eyes.canSee(at));
map.best();
```

A target held by a sight shape with enough `points` in view (`pointsNeeded`, say two of eight bones, more for a target
in cover) fills its awareness over the shape's detection time, which runs linearly from `nearTime` at the eye to
`farTime` at `range` and divides by the target's `visibility`. With several shapes the shortest time wins. A `coffin`
widens to `width` at `shoulder` and narrows to nothing at `range`, so far away the guard sees what is ahead, not the
wide edge a cone would give it. Sound carries its `radius` in sound distance; pass `soundDistance` to measure it around
walls, for example the length of `navMesh.path(from, to)`, and `hearing` to scale it per agent. A `priority` raises
awareness to at least that value. Memories fade over `forgetTime` and go at 0; the level drops from `aware` through
`suspicious` to `calm` on the way, which is what a guard giving up looks like.

`lineOfSight` takes any `(from, to) => boolean`: `sphereOcclusion`, `navVolume.lineOfSight` from
`@margoengine/navmesh/volume`, or a physics ray. Without one nothing blocks sight. Blackboard keys are
`perceptionTarget`, `perceptionPosition`, `perceptionLevel` and `perceptionVisible`, written only when they change.

`OccupancyMap` holds the chance a lost target is at each node of a grid or any graph you give it: `diffuse` spreads it,
with an optional velocity to favour a direction, `observe` pins it and returns how surprising the place was, `cull`
clears nodes seen empty, and `best` is where to look next. Walking there and calling `cull` again is a search.

## Environment queries

Ask the level for a spot: collect candidate points, throw out those that fail a condition, score the rest, take the best.

```ts
import { sphereOcclusion } from 'margoengine/behavior/perception';
import { coverFrom, directness, distance, gridAround, queryPoints, ringsAround, visibleFrom } from 'margoengine/behavior/eqs';

const me = [0, 0, 0];
const enemy = [20, 0, 4];
const lineOfSight = sphereOcclusion([{ position: [10, 0, 2], radius: 3 }]);
const coverSpots = [
  { position: [7, 0, 6], facing: [1, 0, -0.2], data: 'crate' },
  { position: [-4, 0, 3], facing: [-1, 0, 0], data: 'wall' },
];

// Cover first; if no cover works, any hidden point near me.
const [spot] = queryPoints([
  {
    candidates: coverSpots,
    conditions: [{ test: coverFrom(enemy), min: 1 }],
    weights: [{ test: distance(me), weight: -1 }],
  },
  {
    candidates: gridAround(me, 12, 2),
    conditions: [{ test: visibleFrom(enemy, lineOfSight, 1.2), max: 0 }],
    weights: [{ test: distance(me), weight: -1 }],
  },
]);
spot?.position; // where to go; undefined means this behaviour does not fit here, so pick another

// A flank: a move that gets no closer and no further, in view of the enemy.
const flanks = queryPoints(
  [
    {
      candidates: ringsAround(me, 15),
      conditions: [
        { test: directness(me, enemy), min: -0.1, max: 0.1 },
        { test: visibleFrom(enemy, lineOfSight), min: 1 },
      ],
    },
  ],
  { count: 3 },
);
flanks.length; // up to three, best first
```

Each option in the list is tried in order and the first that finds a valid point answers; `option` on a result says
which. A condition reads the raw value, so `{test: distance(me), max: 8}` means 8 m. A weight scales the value to 0..1
by the criterion's `limits` and multiplies, so a point far past the limit cannot swamp the other weights, and a negative
`weight` prefers low values. The built-in criteria are `distance`, `directness`, `reachBefore`, `visibleFrom` and
`coverFrom`. Your own is an object with `value(candidate)`, optional `limits`, and `expensive: true` for anything slow:
wrap `navMesh.path` to score the real walk, or a physics ray.

Cheap conditions and weights run on every candidate. Expensive ones run last, always on the point that can still score
highest, so a point that cannot win never pays for its ray. The answer is the one full evaluation gives, and equal
scores go to the candidate collected first. `explainQuery(option)` runs everything and returns every candidate with its
score and the first condition it failed, for drawing in a debug view.

## Goal planner

Give agents goals and actions and let them work out the steps. Goals and actions never name each other, so a new action
joins every plan it helps without touching the rest.

```ts
import { type GoapAction, GoapAgent, planActions } from 'margoengine/behavior/goap';

const actions: GoapAction[] = [
  { name: 'Attack', preconditions: { Armed: true, At: 'target' }, effects: { TargetDead: true } },
  { name: 'DrawWeapon', preconditions: { Holstered: true }, effects: { Armed: true } },
  { name: 'PickupPipe', preconditions: { At: 'pipe' }, effects: { Armed: true } },
  { name: 'GotoPipe', cost: 2, effects: { At: 'pipe' } },
  { name: 'GotoTarget', cost: 2, effects: { At: 'target' } },
];

const plan = planActions({ Armed: false, Holstered: false, At: 'door' }, { TargetDead: true }, actions);
plan?.actions.map((action) => action.name); // ['GotoPipe', 'PickupPipe', 'GotoTarget', 'Attack']

const agent = new GoapAgent(
  [
    { name: 'Kill', desired: { TargetDead: true }, relevance: 2 },
    { name: 'Survive', desired: { Safe: true }, relevance: (state) => (state.Danger ? 5 : 0) },
  ],
  [...actions, { name: 'Flee', effects: { Safe: true } }],
  { state: { Armed: false, Holstered: true, At: 'door' } },
);
agent.update(1 / 60); // every tick
agent.state.Danger = true; // a sensor; the next update drops the plan and flees
```

A symbol's value is a boolean, a string or a finite number, and a symbol that is not set matches nothing, `false`
included. `planActions` returns the cheapest sequence, or `null` when there is none within `maxNodes` (10,000). An action
can take `available(state)`, a test no action could make true, run once per plan: keep it cheap, and move anything slow
to a sensor that writes a symbol.

`GoapAgent` plans only when it must: the most relevant goal changed or now holds, an action returned `'failure'`, or the
next action's preconditions broke before it started. `run(state, delta)` does the work and returns `'running'`,
`'success'` or `'failure'`; success writes the action's `effects` to `agent.state`. On failure, write a symbol saying
why, or the next plan will try the same thing. A goal with no plan falls through to the next and is not tried again
until the state changes.

## Smart objects

World objects say what they can be used for, so an agent needs no code per object: drop a new bench in the level and
every agent can use it.

```ts
import { SmartObject, SmartObjects } from 'margoengine/behavior/smart-objects';

const world = new SmartObjects();
world.add(
  new SmartObject({
    id: 'bench',
    position: [10, 0, 0],
    uses: [
      {
        name: 'sit',
        advertises: { rest: 0.6 },
        slots: [{ offset: [-1, 0, 0], facing: [0, 0, 1] }, { offset: [1, 0, 0], facing: [0, 0, 1] }],
        run: (agent, bench, delta) => 'success', // play the animation, return 'running' until it ends
      },
    ],
  }),
);
world.add(
  new SmartObject({
    id: 'door',
    position: [4, 0, 2],
    state: { broken: true },
    uses: [
      { name: 'open', advertises: { exit: 1 }, available: (door) => !door.state.broken },
      { name: 'repair', advertises: { work: 1 }, available: (door) => door.state.broken === true },
    ],
  }),
);

const agent = { position: [0, 0, 0], needs: { rest: 0.9, work: 0.2 } };
const offer = world.best(agent); // the use that meets its needs best, or null
if (offer) {
  const claim = world.claim(offer, agent); // hold the place before walking, so two agents do not head for one seat
  claim?.position(); // where to go
  // ...walk there, then every tick:
  claim?.update(1 / 60); // 'running', 'success' or 'failure'
}
world.offers(agent, { use: 'sit', radius: 20 }); // told to sit: every free seat in reach, nearest first
```

An offer scores the sum over needs of need times `advertises`, divided by `1 + attenuation * distance`, so a nearby
snack can beat a far feast (`attenuation` defaults to 0.1; 0 never fades). An `advertises` value can be a function of
the agent, for personality. `available` hides a use for now, usually by reading the object's own `state`. Each slot
holds one agent, the claim takes the free slot nearest it, and `exclusive: true` waits until nobody is on the object and
blocks the rest while held.

A claim follows its object. On `'success'` the agent's needs fall by what was advertised, and on `'success'` or
`'failure'` the place is released. `release()` gives it back early and `using` works. `world.remove(id)` ends the
object's claims, so check `claim.active`.

## Flow fields

One field steers any number of units to a goal, for RTS crowds: the work is per cell, so each extra unit costs one
lookup.

```ts
import { FlowField, WALL } from 'margoengine/behavior/flowfield';

const field = new FlowField({
  size: [128, 128], // cells along x and z
  cell: 1,
  cost: (x, z) => (x > 60 && x < 62 && z < 100 ? WALL : z > 110 ? 4 : 1), // 1 clear, up to 254 slow, 255 a wall
});
field.setGoal([120, 0, 20]);

field.direction([5, 0, 20]); // unit heading on the ground, or zeros at the goal, on a wall, or cut off
field.reachable([5, 0, 20]); // an island test, as cheap as a lookup

// A whole crowd at once, as arrays; ECS component fields fit as they are.
const units = { x: new Float32Array(5000).fill(5), z: new Float32Array(5000).fill(20) };
field.steer(units, 5000, 6, 1 / 60); // count, speed, delta; returns how many moved

const undo = field.stamp(80, 10, 4, 4, WALL); // a building lands; the field rebuilds
undo(); // and it goes

field.setGoal([
  [120, 0, 20],
  [10, 0, 120],
]); // several goals: each unit heads for its cheapest
```

Three fields hold it: `cost`, `integration` (travel cost to the goal, by fast marching, so distances are round and there
is no diamond around the goal) and `flow` (the neighbour to step to). Cells with a clear straight line to a single goal
are flagged in `lineOfSight`, and units there head exactly at the goal. Slow ground ends that line, so a unit follows the
flow around it. After writing `field.cost` yourself, call `field.rebuild()`.

`steer` moves a cell at most per step, so no speed jumps a wall, and a step into a wall keeps the part along it, so units
slide. It steers and nothing more: units do not avoid each other, so add `separation` from `./steering` or physics for
that. Build one field per goal and per movement type.

## Task network planner

Write behaviour as high level tasks broken into smaller ones, and let the planner look ahead through their effects: long
multi-step plans that stay readable, with priority set by the order you list things in.

```ts
import { HtnAgent, type HtnTask, planTasks } from 'margoengine/behavior/htn';

const tasks: HtnTask[] = [
  {
    name: 'BeGuard',
    methods: [
      { when: { CanSeeEnemy: true }, subtasks: ['AttackEnemy'] }, // listed first, so tried first
      { subtasks: ['WalkToPost', 'CheckPost'] },
    ],
  },
  {
    name: 'AttackEnemy',
    methods: [
      { when: (state) => (state.Ammo as number) > 0, subtasks: ['Aim', 'Shoot'] },
      { subtasks: ['FindAmmo', 'Reload', 'AttackEnemy'] }, // a task may name itself once effects end the recursion
    ],
  },
  { name: 'Aim' },
  {
    name: 'Shoot',
    effects: (state) => {
      state.Ammo = (state.Ammo as number) - 1;
    },
  },
  { name: 'FindAmmo', run: (state, delta) => 'success' }, // return 'running' until done
  { name: 'Reload', effects: { Ammo: 6 } },
  { name: 'WalkToPost', effects: { At: 'post' } },
  { name: 'CheckPost', preconditions: { At: 'post' } },
];

const plan = planTasks(tasks, 'BeGuard', { CanSeeEnemy: true, Ammo: 0 });
plan?.tasks.map((task) => task.name); // ['FindAmmo', 'Reload', 'Aim', 'Shoot']

const guard = new HtnAgent(tasks, 'BeGuard', { state: { CanSeeEnemy: false, Ammo: 2 } });
guard.update(1 / 60); // every tick
guard.state.CanSeeEnemy = true; // a sensor; the next update finds a plan of higher priority
```

A compound task lists `methods`, and the first whose `when` holds gives its `subtasks`. A primitive task has
`preconditions`, `effects` and `run`. The planner walks a working copy of the state forward; when a task fails it goes
back to the last decomposition and tries the next method. Conditions and effects are symbols or a function, for sums like
`Ammo -= 1`. There are no costs: use `./goap` to find the cheapest of many orders, and this when you know the shape of the
behaviour and want it fast and readable.

`expected` lists what the world should do by itself while a task runs, such as seeing the enemy on arrival. It counts in
planning and in checking a plan and is never written to the world, so a sensor has to make it true or the plan fails.

`HtnAgent` plans when it has no plan, a task failed, or a sensor changed `agent.state`; a task's own effects never cause
it. On a sensor change it checks the tasks left and fails the plan at once if one no longer works, even one not reached
yet. A new plan replaces a working one only with priority: `plan.record` holds the method index taken at each
decomposition, and `compareRecords(a, b)` compares them, so a recovery animation is not cut short by a lesser plan. For a
partial plan, split it in the domain: a method that only walks while the enemy is far, and one that attacks when near.

## Context steering

Behaviours say what they would like and fear in every direction instead of each deciding, so two of them cannot cancel
out into a stall: the lowest danger masks the interest, and the strongest interest left is the heading.

```ts
import { ContextSteering, avoid, chase } from 'margoengine/behavior/context';
import { Steering, integrate } from 'margoengine/behavior/steering';

const targets = [{ position: [6, 0, 0] }, { position: [0, 0, 12] }];
const obstacles = [{ position: [2.5, 0, 0], radius: 1 }];
const agent = { position: [0, 0, 0], velocity: [0, 0, 0], maxSpeed: 4 };

const context = new ContextSteering({ resolution: 16, memory: 0.3 })
  .add(chase(targets)) // the arrays are read on every update
  .add(avoid(obstacles, { clearance: 3 }))
  .add((interest, danger, self) => {
    interest.write(Math.PI / 2, 0.2, Math.PI / 4); // your own: heading in radians, value, spread
  });

const { direction, strength, danger } = context.decide(agent);
direction; // unit heading on the ground; strength is the share of top speed; danger above 0 means the least bad way

// Or as one behaviour of a Steering, beside anything else.
const steering = new Steering().add((self, out) => void context.steer(self, out));
integrate(agent, steering.compute(agent), 1 / 60);
```

A `ContextMap` is a ring of slots, one per heading, from +X toward +Z. `write` keeps the higher of old and new, so a
second obstacle behind the first adds no danger, and `spread` falls off linearly, or stays full with `flat`. The chosen
heading lands between slots, so 8 slots steer as true as 256 on a smooth peak; next to a masked slot it stays on its
slot, so it cannot drift into danger.

`blur` runs a 1, 2, 1 pass over the interest to soften spikes. `memory` keeps a share of the last update's interest,
so a pull that peaks for a moment does not turn the agent. `slack` lets danger within that much of the lowest count as the
lowest, so a faint hint does not mask a good heading. `context.interest` and `context.danger` hold the last maps, for
drawing.

Errors name their fix: a bad argument throws `TypeError` or `RangeError` (`Agent maxSpeed must be a finite number of
0 or more`), a call that is not valid right now throws `MargoError` with code `state` (ticking from inside a handler),
`disposed` (after `dispose()`) or `failed` (a rejected task). `using tree = new BehaviorTree(...)` halts it at the end
of the scope.

Apache-2.0. Optional, tree-shakable package; no core dependency.

Build and unit tests: npm test --workspace @margoengine/behavior
