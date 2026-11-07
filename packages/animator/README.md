# @margoengine/animator

Import `margoengine/animator` from the `margoengine` package, or `@margoengine/animator` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Optional gameplay animation on the existing `@margoengine/animation` skinning pass. Named states select clips, 1D trees interpolate neighboring samples, and 2D trees use normalized inverse-square distance weights with exact sample reproduction. State transitions crossfade a captured pose into the destination. Masked additive layers apply translation/scale/quaternion and morph deltas relative to a sampled reference pose. A zero reference scale component contributes an identity scale delta on that axis. Primitives sharing a node must have matching morph target counts, as required by glTF.

```ts
import {EngineKernel} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Animation} from 'margoengine/animation';
import {Animator, addCCDChain, type CCDChain} from 'margoengine/animator';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const model = await loadGLTF(engine, '/hero.glb'); // clips named Idle, Walk, Run
const animation = Animation.attach(model);
const animator = Animator.attach(animation, {
  initial:'locomotion', parameters:{speed:0},
  states:{
    locomotion:{parameter:'speed', samples:[{value:0,clip:'Idle'},{value:1,clip:'Walk'},{value:3,clip:'Run'}]},
    idle:'Idle'
  },
  transitions:[{from:'locomotion',to:'idle',when:p=>p.speed<0,duration:0.15}]
});
animator.parameters.speed = 2;
engine.start();
```

For a 2D state use `{parameters:['strafe','forward'],samples:[{value:[0,0],clip:'Idle'},...]}` with unique coordinates. Parameters default to zero. 1D samples must be strictly increasing. Clips loop independently in seconds (`Animation.options.loop` false holds the last frame). `playing = false` pauses state time and crossfades; `Animation.options.speed` scales them, as for Animation playback. `transition(state,duration)` switches states explicitly; predicates are evaluated in declaration order, at most once per frame. Add a layer with `addLayer({clip:'Aim',weight:0.5,mask:[upperBodyNodeIndex,...]})`. Masks use glTF node indices. The returned function removes the layer; mutable weights are validated each frame. `referenceTime` defaults to zero.

`addFootIK({hip,knee,ankle,pole,raycast,offset,probeHeight})` requires a direct three-node leg chain. The callback receives a world-space origin above the current ankle and a downward ray. Return `{position,normal?}` or `null`; supply terrain collision data or an existing BVH. For a BVH raycast, adapt its result to `{position}` or `null`. Normals align the ankle's local +Y with the terrain. Bones/ancestors require positive scales. Unreachable targets clamp to the leg's reach; the pole chooses the knee bend direction. `solveTwoBoneIK()` is also exported as a standalone analytical solver.

## CCD chains (any length)

`addCCDChain(animator, chain)` adds a Cyclic Coordinate Descent IK chain (Wang and Chen 1991) for arms, spines, tails, tentacles or fingers, solved every frame after the pose, additive layers and foot IK. Each sweep goes from the last joint to the first; every joint turns, on its own, so the end effector moves toward the target, then its limit is applied. `joints` lists glTF node indices from the first joint to the last, each the child of the one before. The Animator keeps the chain object and reads `target`, `rotation`, `pole`, `weight` and the solve settings every frame, so move the target by writing into it:

```ts
const joint = (name: string) => model.asset.doc.nodes!.findIndex((node) => node.name === name);
const grab = () => console.log('reached');
const reach: CCDChain = {
  joints: [joint('Shoulder'), joint('Elbow'), joint('Wrist')], // glTF node indices
  target: [0.4, 1.3, 0.5],                   // world space; mutate it per frame
  rotation: null,                            // optional world rotation (x, y, z, w) for the last joint
  pole: [0.3, 1.0, -0.5],                    // optional: the elbow bends toward this point
  tip: [0, 0.08, 0],                         // optional effector offset in the last joint's space
  limits: [
    { type: 'cone', angle: 1.6, twist: [-0.5, 0.5] },        // shoulder: swing cone + twist range
    { type: 'hinge', axis: [1, 0, 0], min: -2.6, max: 0 },  // elbow: one axis, one range
    { type: 'euler', min: [-0.6, -0.3, -1], max: [0.6, 0.3, 1] }, // wrist: per-axis angles (XYZ)
  ],
  iterations: 16, tolerance: 0.001, weight: 1,
  onSolve: (result) => { if (result.reached) grab(); },
};
const remove = addCCDChain(animator, reach);
```

- **Limits** are measured from each joint's rest (bind) rotation, in radians: `euler` clamps the qX·qY·qZ angles per axis (equal bounds lock an axis), `hinge` turns about one rest-frame axis, `cone` keeps the bone within `angle` of its rest direction (the bone axis defaults to the direction of the next joint) with an optional `twist` range. Joints start each solve inside their limits.
- **Reach step** (`reach`, default true). Plain CCD straightens a chain slowly: near full reach every joint's best single turn barely changes the chain's length, so the effector stays short for hundreds of sweeps. After each sweep the solver therefore scales every joint's bend by one factor (keeping the chain's shape and twists), found by bisection so the root-to-effector distance equals the target's, and re-aims the first joint. A step that ends farther from the target (limits in the way) is undone; after two in a row the solve continues as plain CCD. `reach: false` runs plain CCD.
- **Unreachable targets** straighten the chain toward them; the result reports how far it stopped.
- **`rotation`** turns the last joint to that world rotation. Each other joint also turns about its own joint-to-effector line (which leaves the effector where it is) to remove what it can of the orientation error.
- **`pole`** turns the chain, after each sweep, about its root-to-effector line so the bend faces the pole (the effector stays put).
- **`weight`** blends from the animated pose (0) to the solved chain (1). `maxAngle` caps one joint's turn per sweep.
- Joints and their ancestors need positive scales. Rotations commit through `writeRotation` when it is set.

`CCDSolver` is the solver on its own, for chains that are not glTF nodes: `new CCDSolver(offsets, tip)` takes one translation per joint (in the previous joint's frame) and keeps everything in `Float64Array`s (`rotations`, `rest`, `scales`, `positions`, `worldRotations`, `parentPosition`, `parentRotation`, `parentScale`). Its settings are fields (`iterations`, `tolerance`, `angleTolerance`, `maxAngle`, `reach`), limits are set once with `setLimit(index, limit)`, and `solve(target, rotation?, pole?)` turns `rotations` in place and returns a reused `{iterations, distance, angle, reached}`. `setParentMatrix(m)` takes a parent bone's world matrix.

A solve allocates nothing: every number stays in preallocated typed arrays, and no number is read from a caller's options object (a property read that the engine has seen in many object shapes boxes the number; measured at 16 bytes per solve before the settings moved onto the solver). The test runs 20,000 solves with limits, a pole and an orientation target and sees neither a garbage collection nor heap growth. The Animator path then commits through core's `Mesh.setQuaternion`, which allocates on its own; pass `writeRotation` to avoid that.

Measured (`tests/modern-animator-ccd.test.js`, Node 26, from a straight chain):

- Random reachable targets within 95% of full reach, 2-12 joints (360 targets): a median of 1 sweep to 1 mm, 90th percentile 1, worst 46. Plain CCD took a median of 5-13 (90th percentile 19-55).
- Targets at 99.5-99.99% of full reach (2-12 joints, chains about 1-8 m): every one met in 1 sweep, within 1e-9 m (median 6e-16 m). Plain CCD was still a median 19 cm short after 16 sweeps and 2.6 cm after 256.
- Unreachable targets: the chain is straight toward the target within 4 sweeps.
- With Euler or cone limits (tight ones, most targets out of their reach): the same median final distance as plain CCD.
- Solve time on the development PC, 6 joints: 3.6 µs without limits (plain CCD 4.9 µs, 10 sweeps); 110 µs with limits, an orientation target and a pole on mostly unreachable random targets (plain 47 µs; both run about 23 sweeps there).
- In the demo below on the RTX A6000 (headless Edge 155), 10 joints, 2.4 m: at 99.5% of reach the reach step lands within 0.01 mm in 1 sweep where plain CCD stays 167-195 mm short after 16; out of reach (115%) it lies straight, 360 mm from the target (the best possible), where plain CCD stops 495-522 mm away.

For two-bone limbs, `solveTwoBoneIK` is also exact.

**Demo:** `packages/animator/examples` (on the site at `/demos/animator/`): a skinned ten-joint tentacle, built as glTF in code and swaying on its own clip, reaches for an orange target that wanders (sometimes out of reach) or that you drag; switch the reach step, cone limits, the clip, sweeps per frame and the IK weight, and read the sweeps used and the distance left. Run it with `npx vite packages/animator/examples` after `npm run build:packages`.

Bundle cost (min+gzip, other packages external, the method of `examples/package-benchmarks/entry-sizes.mjs`): `Animator` alone 5,023 B (4,862 B before CCD), with `addCCDChain` 11,312 B, `CCDSolver` alone 5,922 B. The package has no side effects, so an app that imports neither `addCCDChain` nor `CCDSolver` does not bundle the solver.

Animator owns pose playback while attached: it pauses `Animation`, updates node transforms and the morph weights its clips animate (other morph weights stay the application's, e.g. expression sliders) before world-matrix evaluation, and lets that same animation pass write its existing bone palette storage buffer and deform vertices. There is no second skinning buffer or pass. Attach `Animation` first. Unloading the model removes both plugins; disposing the animator restores the prior playback flag. Removing Animation also removes its animator on the next update. GPU restoration retains gameplay state. Core/stage stay frozen.

## Root motion

`addRootMotion(animator, {joint})` plays locomotion in place and moves the character instead: every frame, the travel the current state's clips give the root (hips) bone between the previous and the current time is taken out of that bone's pose and added to the character node. It is exact across loop wraps (whole cycles plus the partial ones) and follows 1D and 2D blend trees by their weights. The travel is in the bone's parent space and is carried into the character's frame, so a turned character walks the way it faces.

```ts
import { EngineKernel } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf-pro';
import { Animation } from 'margoengine/animation';
import { Animator, addRootMotion } from 'margoengine/animator';

const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, { backend: 'webgpu' });
const model = await loadGLTF(engine, '/Rig_Medium_MovementBasic.glb'); // KayKit's mannequin (CC0)
const animator = Animator.attach(Animation.attach(model), { initial: 'walk', states: { walk: 'Walking_A' } });
const hips = model.asset.doc.nodes!.findIndex((n) => n.name === 'hips');
const motion = addRootMotion(animator, {
  joint: hips, // the bone whose clip translation is the travel
  target: model.root, // default: the model's root node
  axes: 'xz', // default: ground-plane travel; the hips' bob stays animated ('xyz' takes all of it)
  rotation: false, // default: true also takes the hips' turn about +Y and turns the target by it
  apply: true, // default: false only reports, e.g. to feed a physics character controller
  smoothing: 0, // default: seconds of path averaged into the travel; 0.5 suits a real walk
});
engine.start();
console.log(motion.translation, motion.yaw); // last frame's travel and turn: none, as Walking_A walks in place
motion.dispose(); // the hips travel with the clip again
```

`smoothing` matters for motion capture. Real hips surge and lag on every step; at 0 all of that counts as travel, so it leaves the pose, and a game that moves the character steadily sees it as foot slide (44 mm on a CMU walk, where the take's own feet slide 21 mm). About one step of `smoothing` takes only the journey and leaves the surge in the pose (27 mm). A loop keeps its whole lap of travel; a clip that stops carries its path on through its ends.

A transition starts the new state's travel at its time 0; during a crossfade the travel follows the new state. Yaw is taken per clip cycle, so a clip should turn less than half a turn per cycle. The target's ancestors need nonzero scales.

## Look-at and aim constraints

`addLookAt(animator, lookAt)` turns a head (or a spine, neck and head, each taking a share) so a local axis points at a world target, after the pose, layers, foot IK and the solvers added before it. `addAimConstraint(animator, aim)` is the same for one bone. Both read their object every frame, so move the target by writing into it.

```ts
import { EngineKernel } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf-pro';
import { Animation } from 'margoengine/animation';
import { Animator, addAimConstraint, addLookAt, type LookAt } from 'margoengine/animator';

const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, { backend: 'webgpu' });
const model = await loadGLTF(engine, '/hero.glb');
const animator = Animator.attach(Animation.attach(model), { initial: 'idle', states: { idle: 'Idle' } });
const node = (name: string) => model.asset.doc.nodes!.findIndex((n) => n.name === name);
const look: LookAt = {
  joints: [node('Spine2'), node('Neck'), node('Head')], // first to last, each below the one before
  target: [0, 1.6, 2], // world point; write into it every frame
  shares: [1, 2, 4], // default equal: how much of the turn each bone takes
  axis: [0, 0, 1], // default: the last bone's local look direction (glTF forward)
  origin: [0, 0.08, 0.1], // default [0, 0, 0]: aim from this point in the last bone's space (an eye, a lens)
  up: [0, 1, 0], // default: rolled toward worldUp after aiming; null skips the roll
  worldUp: [0, 1, 0], // default
  maxAngle: Math.PI / 3, // default π: largest turn from the animated look direction
  weight: 1, // default 1: blend from the animated pose
};
const removeLook = addLookAt(animator, look);
const removeAim = addAimConstraint(animator, { joint: node('RightHand'), target: [1, 1, 1], axis: [0, 1, 0], up: null });
engine.start();
removeLook();
removeAim();
```

Each bone in turn takes its share of what is left, so the last bone's axis ends exactly on the target (or `maxAngle` from where the animation pointed it). With `origin` the bone still turns about its own origin, and the ray from `origin` along `axis` passes through the target; a target nearer the bone than that ray reaches gets the ray's nearest point turned toward it. A target within 1 mm of the last bone's origin has no usable direction, so the bones hold the last aim until it moves out again (a dragged target can pass through the head without a jump or an error). The solve allocates nothing per frame. `weight` below 1 blends every bone's local rotation from the animated one to the solved one. Bones and their ancestors need positive scales; rotations commit through `writeRotation` when it is set. For IK chains with poles see `addIKChain` in [`@margoengine/rigging`](../rigging/README.md).

## Triggers, exit times, any-state transitions and events

```ts
import { EngineKernel } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf-pro';
import { Animation } from 'margoengine/animation';
import { Animator } from 'margoengine/animator';

const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, { backend: 'webgpu' });
const model = await loadGLTF(engine, '/hero.glb'); // clips named Idle, Walk, Jump, Land
const animator = Animator.attach(Animation.attach(model), {
  initial: 'idle',
  parameters: { speed: 0 },
  states: { idle: 'Idle', walk: 'Walk', jump: 'Jump', land: 'Land' },
  transitions: [
    { from: 'idle', to: 'walk', when: (p) => p.speed > 0.1 },
    { from: 'walk', to: 'idle', when: (p) => p.speed <= 0.1 },
    { from: '*', to: 'jump', trigger: 'jump', duration: 0.05 }, // from any state
    { from: 'jump', to: 'land', exitTime: 1 }, // once the jump clip has played through
    { from: 'land', to: 'idle', exitTime: 0.9, duration: 0.2 },
  ],
  events: [
    { state: 'walk', time: 0.1, name: 'footstep', data: 'left' }, // normalized time in the state's cycle
    { state: 'walk', time: 0.6, name: 'footstep', data: 'right' },
  ],
});
animator.on('event', (e) => console.log(e.name, e.data)); // footstep left, footstep right, every cycle
animator.on('statechange', (e) => console.log(`${e.from} -> ${e.to}`));
addEventListener('keydown', (e) => {
  if (e.code === 'Space') animator.setTrigger('jump');
});
engine.start();
```

- **Conditions.** A transition lists any of `when(parameters)`, `trigger` and `exitTime`; it is taken once all of them hold. At least one is required. Transitions are checked once per frame in declaration order; the first that holds wins.
- **Any state.** `from: '*'` applies in every state except its own `to` (so it never restarts the state it leads to). The name `'*'` is reserved.
- **Triggers.** `setTrigger(name)` sets a one-shot flag; the transition that takes it clears it. A trigger no transition can take yet stays set until `resetTrigger(name)`. `hasTrigger(name)` reads it.
- **Normalized time.** `animator.normalizedTime` is the time in the current state over its cycle (its longest clip): 0 on entry, 1 after one cycle, 2.5 halfway through the third. `exitTime` and events measure the same way.
- **Events.** `options.events` lists `{state, time, name, data}` moments, `time` from 0 to 1 in the state's cycle. Each fires once per cycle it is passed, loops and long frames included (a 3-cycle frame fires it three times); an event at 0 fires on entering the state. With `Animation.options.loop` false each fires once. Paused (`playing = false`) nothing passes. `animator.on('event' | 'statechange', listener)` returns its unsubscribe function; `statechange` reports `{from, to, duration}` for rules and for `transition()`.

## State graph as data (`margoengine/animator/graph`)

`AnimatorGraph` is the same state machine written as plain data, as in the animator controllers of the big engines:
typed parameters, transitions whose conditions compare them, crossfades, interruption rules and events. The document
holds no functions, so a tool can save it as JSON and load it back. It is a separate entry, so an app that writes its
own `when` predicates does not bundle it.

```ts
import { EngineKernel } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf-pro';
import { Animation } from 'margoengine/animation';
import { AnimatorGraph, type AnimatorGraphDocument } from 'margoengine/animator/graph';

const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!);
const model = await loadGLTF(engine, '/hero.glb'); // clips named Idle, Walk, Run, Jump, Land
const locomotion: AnimatorGraphDocument = {
  parameters: { speed: 'float', grounded: { type: 'bool', default: true }, weapon: 'int', jump: 'trigger' },
  initial: 'move',
  states: {
    move: { parameter: 'speed', samples: [{ value: 0, clip: 'Idle' }, { value: 1, clip: 'Walk' }, { value: 3, clip: 'Run' }] },
    jump: 'Jump',
    land: 'Land',
  },
  transitions: [
    { from: 'move', to: 'jump', conditions: [['jump'], ['grounded']], duration: 0.05 },
    { from: 'jump', to: 'land', conditions: [['grounded', '==', true]], exitTime: 0.5, interruptible: false, duration: 0.2 },
    { from: 'land', to: 'move', exitTime: 0.9, duration: 0.2 },
  ],
  events: [{ state: 'land', time: 0, name: 'thud' }],
};
const graph = AnimatorGraph.attach(Animation.attach(model), locomotion);
graph.on('event', (e) => console.log(e.name));
graph.set('speed', 2.2);
addEventListener('keydown', (e) => {
  if (e.code === 'Space') graph.trigger('jump');
});
engine.start();
```

| Part | Meaning |
| --- | --- |
| `parameters` | `'float'`, `'int'`, `'bool'` or `'trigger'`, or `{type, default}` (default 0 or false). Floats and ints are the blend parameters the states' blend trees read; a blend tree may only read those. |
| `conditions` | All must hold. `[bool]` or `[trigger]`; `[bool, '==' or '!=', true or false]`; `[float or int, '>' '>=' '<' '<=' '==' '!=', number]`. Unknown names, comparisons and types throw a `TypeError` when the graph is built. |
| `exitTime` | The source state's normalized time from which the transition may be taken, as for the Animator. A transition needs conditions, an `exitTime` or both. |
| `duration` | Crossfade seconds, default 0.15. |
| `interruptible` | Default true: during the crossfade another transition may cut in, from the blended pose. `false` holds every transition until the crossfade ends. |
| `from: '*'` | Any state but `to`. |

`set(name, value)` takes a value of the parameter's type (a `RangeError` for a non-integer int or a non-finite
number, a `TypeError` for a wrong type); `get(name)` reads it. `trigger(name)` sets a trigger until a transition that
lists it is taken (which clears it) or `resetTrigger(name)`. `graph.state` is the current state, `graph.on` subscribes
to `'event'` and `'statechange'`, and `graph.animator` is the underlying Animator, so layers, foot IK, CCD chains and
root motion work on it. `dispose()` (or `using`) removes the Animator.

## Override layers

`addLayer({clip, weight, mask, blend: 'override'})` blends the masked bones toward the clip's pose by `weight` (an upper-body wave or aim over a walk), where the default `blend: 'additive'` adds the clip's difference from its reference pose. `time` (seconds, read every frame) plays a layer on its own clock; by default a layer follows the state's time. `weight` and `time` may change every frame, for example from `@margoengine/tween`.

```ts
import {Engine} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Animation} from 'margoengine/animation';
import {Animator} from 'margoengine/animator';
const engine = await Engine.create(document.querySelector('canvas')!);
const model = await loadGLTF(engine, '/hero.glb');
const animator = Animator.attach(Animation.attach(model), {initial: 'walk', states: {walk: 'Walk'}});
const upperBody = [3, 4, 5, 6, 7]; // glTF node indices of the spine, arms and head
const wave = { clip: 'Wave', weight: 0, mask: upperBody, blend: 'override' as const, time: 0 };
const removeWave = animator.addLayer(wave);
wave.weight = 1; // then advance wave.time from your frame loop; removeWave() when done
removeWave();
```

## Foot placement (feet on uneven ground, pelvis drop)

`addFootPlacement(animator, placement)` keeps a walk's stride on stairs and slopes: each frame it casts a ray down through every animated ankle, raises or lowers that foot by how far the ground under it is from the character's flat floor (the `ground` node, default the model root, so a lifted swing foot stays lifted), drops the pelvis by the largest downward offset (at most `maxPelvisDrop`) so that foot can reach, then bends each leg with two-bone IK toward its pole. Feet keep their animated world orientation and, with `alignFeet`, tilt to the ground normal. Unlike `addFootIK`, which plants each ankle on the hit point, this keeps the animation's foot motion.

```ts
import { EngineKernel } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf-pro';
import { Animation } from 'margoengine/animation';
import { Animator, addFootPlacement } from 'margoengine/animator';

const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, { backend: 'webgpu' });
const model = await loadGLTF(engine, '/hero.glb');
const animator = Animator.attach(Animation.attach(model), { initial: 'walk', states: { walk: 'Walk' } });
const node = (name: string) => model.asset.doc.nodes!.findIndex((n) => n.name === name);
const stepHeight = (x: number) => (x > 2 ? 0.2 : 0); // your terrain or physics raycast
const feet = addFootPlacement(animator, {
  pelvis: node('Hips'),
  legs: [
    { hip: node('LeftUpLeg'), knee: node('LeftLeg'), ankle: node('LeftFoot'), pole: [0, 0.5, 2] },
    { hip: node('RightUpLeg'), knee: node('RightLeg'), ankle: node('RightFoot'), pole: [0, 0.5, 2] },
  ],
  raycast: (origin) => ({ position: [origin[0], stepHeight(origin[0]), origin[2]], normal: [0, 1, 0] }),
  probeHeight: 0.5, // default: highest step found above the ankle
  probeDepth: 0.5, // default: deepest drop followed
  maxPelvisDrop: 0.5, // default
  alignFeet: true, // default
  weight: 1, // default
});
engine.start();
console.log(feet.pelvisOffset, feet.footOffsets);
feet.dispose();
```

The placement object is read every frame, so poles, weight and the raycast may change. A leg whose ray misses keeps its animated pose. Each frame starts from the animated pose, so nothing accumulates. Bones and their ancestors need positive scales; rotations commit through `writeRotation` when it is set.

## Inertialization (`margoengine/animator/inertialize`)

`addInertialization(animator, {duration})` replaces crossfades. A state change plays the new pose at once, and the difference between where the old motion was heading and the new pose fades out by itself, keeping the old motion's speed. Only the new state is sampled and there is no snapshot of the old pose to mix. Transitions, triggers and `animator.transition()` work as before.

```ts
import {Animator} from 'margoengine/animator';
import {EngineKernel} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Animation} from 'margoengine/animation';
import {addInertialization} from 'margoengine/animator/inertialize';

const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const model = await loadGLTF(engine, '/hero.glb');
const animation = Animation.attach(model);
const animator = Animator.attach(animation, {
  initial: 'run',
  states: {run: 'Run', stop: 'Stop'},
  transitions: [{from: 'run', to: 'stop', when: (p) => p.speed < 0.1, duration: 0.25}],
});
const inertia = addInertialization(animator); // each transition's duration is how long its offset fades
animator.parameters.speed = 0;
console.log(inertia.active, inertia.remaining); // true while something fades, and for how many seconds
inertia.dispose();                              // back to crossfades
```

- **`duration`** (default: each transition's own `duration`) fixes one fade length for every switch. Without it, a transition of 0 stays a hard cut.
- **Speed.** The frame after a switch continues the old motion, the next measures the new pose's speed, and the offset starts from their difference, so nothing pops and the speed along the offset does not jump. Sideways speed is dropped (see [limits](../../docs/limits.md)).
- **It ends exactly.** After the fade the pose is the new state's, to the bit. An offset that is already closing never crosses the target: its fade is cut short instead.
- **What fades:** local positions, rotations, scales and morph weights, on the finished pose (states and layers). Foot IK and solvers run after it, so their targets are still met.
- **`smooth(duration?)`** fades a jump the graph did not cause, such as a clip time set by hand or a layer switched on: call it, then change the pose.

## Sync groups (`margoengine/animator/sync`)

Clips of different lengths drift apart in a blend: at half weight a 1 s walk and a 0.6 s run show each foot at two places in its stride. `addSyncGroup(animator, {states})` gives a set of states one phase. In a blend tree every clip plays at that phase, the cycle takes the blended length, and a transition inside the group starts the new state at the phase the old one had. During a crossfade the old state keeps playing in phase instead of freezing.

```ts
import {Animator} from 'margoengine/animator';
import {EngineKernel} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Animation} from 'margoengine/animation';
import {addSyncGroup} from 'margoengine/animator/sync';

const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const model = await loadGLTF(engine, '/hero.glb');
const animation = Animation.attach(model);
const animator = Animator.attach(animation, {
  initial: 'move', parameters: {speed: 0},
  states: {
    move: {parameter: 'speed', samples: [{value: 0, clip: 'Walk'}, {value: 1, clip: 'Run'}]},
    sprint: 'Sprint',
  },
  transitions: [{from: 'move', to: 'sprint', when: (p) => p.speed > 1, duration: 0.2}],
});
const sync = addSyncGroup(animator, {
  states: ['move', 'sprint'],
  markers: ['LeftFootDown', 'RightFootDown'],   // optional: line up steps, not just clip fractions
  clipMarkers: {                                // for clips with no markers of their own, as glTF clips are
    Walk: [{time: 0.1, name: 'LeftFootDown'}, {time: 0.6, name: 'RightFootDown'}],
    Run: [{time: 0.05, name: 'LeftFootDown'}, {time: 0.3, name: 'RightFootDown'}],
    Sprint: [{time: 0.02, name: 'LeftFootDown'}, {time: 0.25, name: 'RightFootDown'}],
  },
});
console.log(sync.phase); // 0 up to 1, the group's place in its cycle
```

- **`markers`** (default none) cuts the cycle at named moments, in order. Each clip maps phase to its own time piece by piece, so steps at different fractions of two clips still land together, and each piece runs at its blended length. Without markers, phase is each clip's fraction. Every clip must have those markers in that order round its loop; a clip built with `createKeyframeClip` brings its own, and `clipMarkers` serves the rest. Phase 0 is the first name, so a state entered from outside the group starts at that marker rather than at the clip's first frame.
- **State time.** In a group, `animator.time` is the phase counted in the state's longest clip, so `normalizedTime`, `exitTime` and timed events all read phase: a footstep event at 0.5 stays on the step at any blend.
- **Root motion** follows the phase through `addRootMotion`: a blended cycle travels the blended stride, and entering a state mid-cycle adds no jump.
- A state belongs to one group. Disposing the group gives each clip its own clock back.

## Warping (`margoengine/animator/warping`)

One walk cycle has to serve every speed and direction a game asks for. `addWarping(animator, warp)` fits the pose to how the character really moves so feet do not slide, and `addDistanceWarp` drives a stop or start clip by distance so it lands on its mark.

```ts
import {Animator, addRootMotion} from 'margoengine/animator';
import {EngineKernel} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Animation} from 'margoengine/animation';
import {addDistanceWarp, addWarping} from 'margoengine/animator/warping';

const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const model = await loadGLTF(engine, '/hero.glb');
const animation = Animation.attach(model);
const animator = Animator.attach(animation, {initial: 'walk', states: {walk: 'Walk', stop: 'Stop'}});
const node = (name: string) => model.asset.doc.nodes!.findIndex((n) => n.name === name);
addRootMotion(animator, {joint: node('Hips'), apply: false, smoothing: 0.5}); // the game moves the character

const velocity: [number, number, number] = [0, 0, 0];
const warp = addWarping(animator, {
  pelvis: node('Hips'),
  spine: [node('Spine'), node('Chest')],
  velocity, // write the character's real velocity into this every frame
  legs: [
    {hip: node('LeftUpLeg'), knee: node('LeftLeg'), ankle: node('LeftFoot')},
    {hip: node('RightUpLeg'), knee: node('RightLeg'), ankle: node('RightFoot')},
  ],
});
velocity[0] = 0.8; velocity[2] = 0.8;       // a strafe at 1.13 units a second on a forward walk
console.log(warp.turn, warp.stride, warp.rate, warp.pelvisDrop);

const stop = {state: 'stop', joint: node('Hips'), distance: 2};
addDistanceWarp(animator, stop);
animator.transition('stop');
stop.distance = 1.5;                        // what is left to the mark, written every frame
```

- **Orientation.** The hips turn toward the direction of travel, up to `maxTurn` (default pi / 2), settling over `turnTime` (default 0.1 s), and `spine` shares out the turn back so the chest keeps facing front. Facing is the `character` node's +Z (default the model's root).
- **Stride.** Each foot's offset from the hips scales along the direction of travel by real speed over clip speed, so a planted foot stands still. Knees bend toward each leg's `pole`, by default forward of the animated knee, and feet keep their world rotation.
- **Clip speed.** Measured from the `speedJoint` travel (default `pelvis`) of the state's clips through its blend tree. In-place clips have no travel to measure: set `clipSpeed`. `addRootMotion` with `apply: false` keeps a travelling clip's bone in place while the game moves the character.
- **Limits and rate.** Past `minStride` (default 0.5) and `maxStride` (default 1.6) the clip's rate makes up the rest, from the next frame, so feet stay planted at any speed and a stopped character stops stepping. `adjustRate: false` leaves the rate alone. `animator.time` then runs at that rate; crossfades keep real time.
- **Pelvis.** It drops by what the longest stride needs, at most `maxPelvisDrop` (default 0.2).
- **Motion capture.** Proved on CMU takes with contacts found from the data: at speeds from 0.7 to 3 m/s on a 1.31 m/s walk a planted foot slides 24 to 50 mm, against 21 mm in the take itself and 48 to 564 mm with no warp. Pass `smoothing: 0.5` to `addRootMotion`, or the hips' surge shows as foot slide.
- **Distance.** `addDistanceWarp` stands a clip where the travel of `joint` matches `distance`: `mode: 'stop'` reads what is left, `'start'` what has been covered. Time only runs forward, and a distance longer than the clip holds its first frame. The state must play one clip.

## Full-body IK (`margoengine/animator/fbik`)

`addFullBodyIK(animator, rig)` reaches hands, feet and head together, for reaching, climbing and interactions. One solve moves and turns the pelvis and bends the spine only as far as the targets need: a hand in reach moves the arm alone, a far one bends the body, and a pinned foot stops the pelvis going further than the leg allows. The centre of mass stays over what bears weight, so a long reach pushes the hips back. Each limb is finished by the two-bone solver, so bones keep their lengths.

```ts
import {EngineKernel} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Animation} from 'margoengine/animation';
import {Animator} from 'margoengine/animator';
import {addFullBodyIK, type FullBodyLimb} from 'margoengine/animator/fbik';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const model = await loadGLTF(engine, '/hero.glb'); // a clip named Idle
const animator = Animator.attach(Animation.attach(model), {initial:'idle', states:{idle:'Idle'}});
const joint = (name: string) => model.asset.doc.nodes!.findIndex((node) => node.name === name);
const limb = (side: string, a: string, b: string, c: string): FullBodyLimb => ({
  upper: joint(side + a), lower: joint(side + b), end: joint(side + c)
});
const leftHand = limb('Left', 'Arm', 'ForeArm', 'Hand');
const ik = addFullBodyIK(animator, {
  pelvis: joint('Hips'),
  spine: [joint('Spine'), joint('Chest')],
  legs: [limb('Left', 'UpLeg', 'Leg', 'Foot'), limb('Right', 'UpLeg', 'Leg', 'Foot')],
  arms: [leftHand, limb('Right', 'Arm', 'ForeArm', 'Hand')],
  head: {joint: joint('Head')}
});
leftHand.target = [0.3, 1.15, 0.85]; // world space; write into it every frame
engine.start();
console.log(ik.result.reached, ik.result.distance, ik.result.balanced);
```

Each limb takes `target`, `rotation`, `pole`, `weight` (default 1), `pinned` (holds its animated place with no target: default true for legs, false for arms) and `support` (counts for balance: default true for legs; set it on a hand that grips, for climbing). `head` takes `joint`, `target`, `rotation` and `weight`. The rig takes `balance` (default true), `supportRadius` (how far the centre of mass may stand outside the supports, default a tenth of the first leg's length), `maxBend` (radians a spine joint turns from the animated pose, default 0.8), `reach` (share of a limb's length the torso plans for, default 0.98), `iterations` (default 12), `tolerance` (default 0.001), `weight` (default 1) and `onSolve`. `ik.result` reports `reached`, `distance`, `balanced`, `imbalance` and `iterations`. The solve runs after foot IK and the solvers added before it.

The torso is a damped Gauss-Newton solve (Levenberg 1944, Marquardt 1963); the centre of mass uses Winter's segment shares. A target past what the pinned feet allow leaves the arm straight toward it and `reached` false, with the feet still down. Balance is about world +Y, and a limb must be a direct chain of three joints.

## Motion matching (`margoengine/animator/motion-matching`)

Motion matching needs no state graph. `MotionDatabase.build` turns every frame of your clips into a row of features; `addMotionMatching` then finds, a few times a second, the row that best continues the current pose along the path the character is asked to take, and jumps there with an inertialized blend. Add more clips and the character gets better, with no transitions to wire.

```ts
import {EngineKernel} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Animation} from 'margoengine/animation';
import {Animator} from 'margoengine/animator';
import {addMotionMatching, MotionDatabase, motionStates} from 'margoengine/animator/motion-matching';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const model = await loadGLTF(engine, '/hero.glb'); // clips named Idle, Walk, Run
const animation = Animation.attach(model);
const animator = Animator.attach(animation, {initial: 'Idle', states: motionStates(animation)}); // one state per clip
const joint = (name: string) => model.asset.doc.nodes!.findIndex((node) => node.name === name);
const database = MotionDatabase.build(animator, {
  root: joint('Hips'),
  bones: [joint('LeftFoot'), joint('RightFoot')],
});
const velocity: [number, number, number] = [0, 0, 0];
const matcher = addMotionMatching(animator, {database, velocity});
velocity[2] = 3; // where to go, world units a second; write into it every frame
engine.start();
console.log(matcher.clip, matcher.cost, matcher.jumps);
const bytes = database.toBinary();               // build offline, ship the bytes
const same = MotionDatabase.fromBinary(bytes);
console.log(same.rows, same.search(same.features.subarray(0, same.width)).clip);
```

- **Database.** `root` is the hips: their path on the ground, averaged over `smoothing` seconds (default 0.5), is the character's root, so a walk's sway stays in the pose. `bones` are the bones to match (1-8, usually the feet). `clips` defaults to every clip; give `{clip, loop, speed}` to say a clip does not loop or to tell an in-place clip how fast it travels. `rate` (default 30 rows a second), `trajectory` (default a third, two thirds and one second ahead), `forward` (the rest pose's facing, default +Z) and `weights` set the rest. A row of a clip that does not loop whose path runs past its end can be played but not landed on.
- **Features.** Each row holds the bones' places and speeds, the hips' speed, and the root's future places and facings, all in the root's own frame. Each group is centred and scaled by its spread, then weighted: `position` 0.5, `velocity` 0.5, `hips` 1, `trajectory` 2, `facing` 1.5. The path counts most, so a request is answered even with no clip that eases into it.
- **Search.** `database.search(query)` is exact: boxes around 16 and 64 rows are skipped when their nearest corner cannot win, and the answer is what comparing every row gives.
- **Matching.** `velocity` and `facing` (default the way `velocity` points) are smoothed into a predicted path over `response` seconds (default 0.5). Every `interval` (default 0.1 s) the search runs; a row must beat the current one by `stickiness` (default 1, measured on motion capture, where 0.05 jumped three times as often and the feet paid for it) and be over 0.2 s away. `blend` (default 0.2 s) is the inertialization. The clips play in place and `character` (default the model's root) moves along the predicted path; `drive: false` leaves that to the game. `matcher.search()` searches on the next frame.

Motion capture works as it comes: on eight CMU takes, with `{clip, loop: false}` and no speed labelled by hand, a request for 1.1, 1.3, 1.7, 2.7 or 4 m/s plays the take recorded at that speed. A take that ends forces a jump, so longer takes jump less: a 1.1 s run jumped 19 times in 4 s, a 3.5 s walk 4 times.

The Animator needs one state per clip, named after it, and `motionStates(animation)` gives that. The search is on the CPU, and the database holds what you put in it: it has no clip for a move you did not record, and a character asked for one plays the nearest it has.

## Runtime mirroring (`margoengine/animator/mirror`)

`addMirror(animator, mirror)` plays any clip on the other side at run time, so one left-handed swing serves both hands and you author half the clips. It mirrors the finished pose, so blends and layers mirror too, and foot IK and solvers still meet their targets.

```ts
import {Animator} from 'margoengine/animator';
import {EngineKernel} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Animation} from 'margoengine/animation';
import {addMirror, mirrorPairs} from 'margoengine/animator/mirror';

const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const model = await loadGLTF(engine, '/hero.glb');
const animation = Animation.attach(model);
const animator = Animator.attach(animation, {initial: 'swing', states: {swing: 'SwingLeft', idle: 'Idle'}});
const mirror = {enabled: true, states: ['swing']}; // read every frame
const handle = addMirror(animator, mirror);
console.log(handle.pairs);                    // each node's partner, by glTF node index
mirror.enabled = false;                       // back to the clip as authored
console.log(mirrorPairs(['arm.L', 'arm.R', 'spine'])); // [1, 0, 2]
```

Partners come from node names: `LeftArm` and `RightArm`, `arm.L` and `arm.R`, `leg_joint_L_1` and `leg_joint_R_1`, and ids at the end are ignored when names do not pair with them (`b_LeftArm_09` and `b_RightArm_06`). A node with no partner mirrors onto itself. Pass `pairs` (a partner per glTF node index) to set them by hand.

`axis` is the axis across the plane of symmetry in the model's space (default `'x'`, for a glTF character facing +Z). `enabled` defaults to true, `states` to every state, and `morphs` (default true) trades morph targets by name, from each mesh's `extras.targetNames`. Each bone's local axes are accounted for from the rest pose, so the two sides of a rig need not share them, and the rest pose stays the rest pose. Root motion travels mirrored and turns the other way. Switching `enabled` is a hard cut; call `smooth()` on an inertialization first for a soft one.

## Spline IK (`margoengine/animator/spline-ik`)

`addSplineIK(animator, chain)` lays a joint chain along a curve, for spines, tails and tentacles. Each joint lands on the curve one bone's length from the joint before, so bones keep their lengths and the chain stays on the curve however tightly it bends. Needs `@margoengine/splines`, an optional peer.

```ts
import {Animator} from 'margoengine/animator';
import {EngineKernel} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Animation} from 'margoengine/animation';
import {addSplineIK, type SplineIKChain} from 'margoengine/animator/spline-ik';

const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const model = await loadGLTF(engine, '/hero.glb');
const animation = Animation.attach(model);
const animator = Animator.attach(animation, {initial: 'idle', states: {idle: 'Idle'}});
const joint = (name: string) => model.asset.doc.nodes!.findIndex((node) => node.name === name);
const points: [number, number, number][] = [[0, 1, 0], [0.4, 1.3, 0], [0.4, 1.8, 0.3], [0, 2.1, 0.5]];
const tail: SplineIKChain = {
  joints: [joint('Tail1'), joint('Tail2'), joint('Tail3'), joint('Tail4')], // from first to last
  curve: points,            // or a Spline of any kind; rewrite the points every frame to animate it
  anchor: 'root',           // keep the first joint on the body and bring the curve to it
  twist: [0, Math.PI / 2],  // radians about the chain, at its first and last bone
};
const handle = addSplineIK(animator, tail);
points[3][0] = 0.3;         // read every frame
console.log(handle.overrun); // how far the chain ran past the curve's end
```

`curve` is a `Spline` from `@margoengine/splines`, or two or more points for a Catmull-Rom curve through them, in world space unless `space` names a node, so a tail's curve can travel with its body. `anchor` is `'curve'` (default: the first joint moves to the curve) or `'root'` (it stays animated and the curve comes to it). `offset` (default 0) slides the chain along the curve, `twist` (default none) turns it about itself, `weight` (default 1) blends from the animated pose, and `samples` (default 64) sets how finely the curve's frames are built.

Twist follows the curve's rotation-minimising frames (`@margoengine/splines/frames`), started from the animated chain's own, so a curl past half a turn does not flip and a chain on a straight curve does not turn. Past the curve's end the chain carries on along the last tangent, and `overrun` says how far. A joint takes the first place along the curve one bone away, so a hairpin is followed, not cut. Each joint lands exactly on the curve, so a bone is a chord: a chain coarser than the curve cuts its corners.

## Explicit rotation writer

`AnimatorOptions.writeRotation?: (node: Mesh, rotation: readonly number[]) => void` is an optional, explicit commit hook for applications that own their transform writer. It is captured and validated once during construction. Omit it to keep the current dynamic `Mesh.setQuaternion` call, including method overrides. This is an additive public API option; it does not change core/stage.

The hook receives the actual destination mesh and a borrowed normal JavaScript array for both sampled/blended local poses and FootIK corrections. Commit synchronously, validate finite Float32-representable and nonzero quaternion values, normalize using the application's required numeric behavior, and synchronize the mesh's quaternion and XYZ Euler state. Do not mutate or retain the borrowed array, change Animator/model structure from the callback, or reenter pose evaluation. Recursive `onPreUpdate` from a writer throws before changing update state. A thrown writer does not advance the successful rotation cache; previously successful position/scale writes keep their existing partial-update behavior. The next update compares against that earlier successful cache. If a writer restores exactly the earlier accepted quaternion/Euler state before throwing, an unchanged request can legitimately skip another callback, matching the default setter path. Throws do not guarantee callback reinvocation.

Cached unchanged rotations skip the hook, just as they skip the default setter. It is not a per-frame notification or a generic purity guarantee. Construct a stable writer outside the frame loop. Default mesh setter behavior for caller-owned typed arrays is unchanged. An opted-in application is responsible for writer correctness; a hook that ignores validation or does not commit state violates this contract. No allocation-free or whole-scene performance guarantee follows from supplying a callback.
