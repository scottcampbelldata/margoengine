# @margoengine/ragdoll

Import `margoengine/ragdoll` from the `margoengine` package, or `@margoengine/ragdoll` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Ragdolls for animated characters, on `@margoengine/physics` (Rapier). Give it the hips of a skeleton and it builds one
capsule body per bone, joined at the bone origins with swing and twist limits. While the character is animated the
bodies follow the bones as kinematic hit boxes that push the world; `activate()` makes it limp, keeping the momentum the
animation gave each bone; `deactivate(seconds)` blends the bones back to the animation. Core and physics stay the same
size: an app that does not import this package ships none of it.

```ts
import RAPIER from '@dimforge/rapier3d-compat';
import { EngineKernel } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf-pro';
import { Animation } from 'margoengine/animation';
import { Animator } from 'margoengine/animator';
import { Physics } from 'margoengine/physics';
import { Ragdoll } from 'margoengine/ragdoll';

await RAPIER.init();
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!);
const physics = new Physics(engine, { rapier: RAPIER });
physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [20, 0.1, 20] } });
const model = await loadGLTF(engine, '/hero.glb'); // a skinned character with a Run clip
Animator.attach(Animation.attach(model), { initial: 'run', states: { run: 'Run' } });

// After the Animator, so it runs after the animation each frame.
const hips = model.nodes.find((node) => node.name === 'Hips')!;
const ragdoll = Ragdoll.attach(physics, { root: hips });

// A hit: go limp and push the bone that was struck.
const head = ragdoll.bones.find((part) => part.node.name === 'Head');
ragdoll.activate();
head?.body.applyImpulse([0, 2, -30]);

// Two seconds later, get up: hand the bones back to the animation over half a second.
setTimeout(() => ragdoll.deactivate(0.5), 2000);
engine.start();
```

## What it builds

`Ragdoll.attach(physics, {root})` walks every node under `root`. A node with children becomes a bone; its capsule runs
from the node's origin toward its children's centre (the farthest child when that centre is at the origin). End nodes
and bones whose farthest child is nearer than `minLength` (fingers, toes) are left out with their children and keep their animation. The
radius is `thickness` times the length, or half the distance the children sit off the bone's line when that is more,
so a pelvis between the legs and a chest between the arms come out round. Mass is the capsule volume times `density`.
The pose at construction is the rest pose the joint limits measure from: build it in a T or A pose, or the first frame
of a clip.

Each body's frame is its bone's world frame, so a body's origin is its joint with the parent bone, and the bone's world
pose is the body's pose. `ragdoll.bones` lists the parts, parents first; `bones[0]` is the root. Each part has its
`node`, `body` (a `PhysicsBody`; apply impulses to it), `joint` (null on the root), `parent` index, `length` and
`radius`. Every body's `userData` is `{ragdoll, node}`, so a raycast hit tells you which bone was struck.

For full control, list the bones yourself instead of `root`: each is a node or `{node, joint, length, radius, mass}`.
One bone is the root, and every other bone's parent node must be in the list.

```ts
const node = (name: string) => model.nodes.find((n) => n.name === name)!;
const custom = Ragdoll.attach(physics, {
  bones: [
    node('Hips'),
    { node: node('Spine'), joint: { type: 'cone', swing: 0.4, twist: [-0.3, 0.3] } },
    { node: node('Head'), length: 0.25, radius: 0.1 },
    node('LeftUpLeg'),
    { node: node('LeftLeg'), joint: { type: 'hinge', axis: [1, 0, 0], limits: [0, 2.4] } },
  ],
});
```

## Joints

| Joint | Meaning |
| --- | --- |
| `{type: 'cone', swing, twist}` | A ball joint. The bone stays inside a cone of half angle `swing` radians around its rest direction and twists about its own axis between `twist[0]` and `twist[1]` radians. Shoulders, hips, spine, neck. Defaults `swing` π/4, `twist` [-π/6, π/6]. |
| `{type: 'hinge', axis, limits}` | One axis of rotation, `axis` in the bone's local frame, turning between `limits` radians from the rest pose. Knees, elbows. Default `limits` [-3π/4, 0]. Uses Rapier's revolute joint with both frames aligned at rest (Rapier 0.21 or later). |
| `{type: 'free'}` | A ball joint with no limits. |

Cone limits are measured by splitting the joint's rotation from rest into a swing of the bone axis and a twist about
it. Where one passes its limit, an impulse stops the two bodies' relative spin that drives it further out, and the
child turns back about the joint by `limitStiffness` (default 0.2) of the error each step. The stop is inelastic, so a
limit does not bounce, and turning about the joint never pulls the joint apart.

## Modes and blending

| Member | Meaning |
| --- | --- |
| `activate(limb?)` | Goes limp: each body becomes dynamic with the velocity its bone had in the last physics step, and physics drives the bones. With a bone or a list, only those limbs. |
| `deactivate(duration = 0.3, limb?)` | The bodies follow the animation again (they jump to it, without sweeping through the world), and the drawn pose blends from the ragdoll's last pose to the animation over `duration` seconds. With a bone or a list, only those limbs. |
| `active` | True while physics drives any bone. |
| `weight` | How much of the drawn pose is the ragdoll's, 0 to 1 (the largest of any bone's). Set it while active for a partial blend of the limp bones. |
| `rootPosition` | World position of the root bone's body: where to move a character before it gets up. |
| `part(node)` | The part of a node, or undefined. |
| `dispose()` | Removes the bodies and joints and the plugin; the bones keep their last pose. `using` works. |

The ragdoll is an engine plugin that runs each frame after the plugins attached before it: create it after the
Animator. It reads the bones' animated pose, sets the kinematic targets, and writes the blended pose. A bone's pose
blends in its parent's frame (rotations for every bone, position for the root bone only), so limbs keep their lengths.
Without an animation, blending back returns to the pose the bones had before the ragdoll moved them.

## Partial ragdolls

`activate(limb)` makes one limb physical while the rest keeps animating: pass a bone (a node or a part), or a list. That bone and every bone under it go limp and hang from the bones that keep animating, so a hit swings one arm while the character walks on. `deactivate(seconds, limb)` blends that limb back alone. The spine takes the whole upper body, with the legs still walking.

```ts
const arm = model.nodes.find((node) => node.name === 'LeftArm')!;
ragdoll.activate(arm);
ragdoll.part(arm)?.body.applyImpulse([0, 2, -20]);
setTimeout(() => ragdoll.deactivate(0.4, arm), 800);

const rightArm = model.nodes.find((node) => node.name === 'RightArm')!;
const spine = model.nodes.find((node) => node.name === 'Spine')!;
ragdoll.activate([arm, rightArm]); // a list: both arms
ragdoll.activate(spine); // the upper body; `activate()` with no bone is all of them
```

Each part has its own `limp` and `weight`, so a second limb can go limp while the first is still blending back. `ragdoll.active` is true while any bone is limp, and `ragdoll.weight` reads the largest weight. Bones that are not limp and have no weight are not written at all, so their animation reaches the screen unchanged. A limb stays attached to the drawn body to within a physics step: the bones above it are kinematic, and a kinematic body reaches a frame's pose at that frame's step.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `root` | none | The skeleton's root bone, usually the hips. Pass `root` or `bones`. |
| `bones` | none | An explicit list of nodes or `{node, joint, length, radius, mass}`. |
| `joint` | cone, π/4, [-π/6, π/6] | Joint of every bone that does not set its own. |
| `minLength` | `0.05` | With `root`, bones whose farthest child is nearer than this (metres) are left out with their children. |
| `thickness` | `0.2` | Capsule radius as a fraction of the bone length. |
| `density` | `1000` | Kilograms per cubic metre, about a human body's. |
| `active` | `false` | Start limp. |
| `collisionGroups` | group 15, colliding with 0 to 14 | Packed groups for every capsule (`collisionGroups()` from physics). The default keeps a ragdoll's parts from colliding with each other; give a character controller's own queries a filter without group 15 so it ignores its hit boxes. |
| `friction` | `0.6` | Capsule friction. |
| `linearDamping` | `0.05` | Per body, so a limp ragdoll settles. |
| `angularDamping` | `0.8` | Per body. |
| `limitStiffness` | `0.2` | Share of a cone limit's error removed per physics step, 0 to 1. |

Bones take any positive scale, even or uneven; zero and mirrored bones are refused. Lengths and shapes are read in world units, so a stretched bone gets a longer body. Under an uneven scale a child's world rotation is not its parent's times its own, so each part keeps `bind`, the difference, measured when the bone goes limp: the pose does not jump. Errors follow the package conventions: a `TypeError` or `RangeError` naming
the fix for bad options, and a `MargoError` with code `disposed` after `dispose()`, `attached` for a second ragdoll on
one skeleton or the wrong engine, and `unsupported` for a hinge on a Rapier build without joint frames.

## Powered ragdolls (`margoengine/ragdoll/powered`)

`addRagdollMotors(ragdoll, options)` gives every joint a motor that pulls its bone toward the pose the animation gives it, while the bone is physical. The character keeps moving, a hit bends it, and the motors take the pose back, instead of it only going limp.

```ts
import RAPIER from '@dimforge/rapier3d-compat';
import { EngineKernel } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf-pro';
import { Physics } from 'margoengine/physics';
import { Ragdoll } from 'margoengine/ragdoll';
import { addRagdollMotors } from 'margoengine/ragdoll/powered';

await RAPIER.init();
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!);
const physics = new Physics(engine, { rapier: RAPIER });
physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [20, 0.1, 20] } });
const model = await loadGLTF(engine, '/hero.glb');
const bone = (name: string) => model.nodes.find((node) => node.name === name)!;
const hips = bone('Hips');
const ragdoll = Ragdoll.attach(physics, { root: hips });
const motors = addRagdollMotors(ragdoll, { root: 1 });
ragdoll.activate(); // physical, and still walking its clip

// A hit: the impulse lands on the chest, the limb weakens at once and gets its strength back over 0.6 seconds.
motors.hit(ragdoll.bones[4], [0, 0, -150], { weaken: 0.8, recover: 0.6 });

motors.setStrength(bone('LeftHand'), 0); // that limb hangs while the rest stays powered
motors.fade(0, 1.5); // weaken over a second and a half: a slow collapse
```

| Option | Default | Meaning |
| --- | --- | --- |
| `frequency` | `6` | How fast a motor closes on its target, as a natural frequency in hertz. |
| `damping` | `1` | Damping ratio: 1 settles without overshoot, less rings. |
| `strength` | `1` | Share of the pull, 0 (limp) to 1. |
| `maxAcceleration` | `400` | Largest angular acceleration a motor may give the limb it carries, rad/s². Each joint's torque cap is this times the limb's inertia about the joint. Less gives floppier limbs; 400 is what the hands and feet of a real walk clip need. |
| `root` | `0` | Share of a spring from the world to the root bone, toward where the animation puts it. |

| Member | Meaning |
| --- | --- |
| `strength` | Read or set the share of the pull. |
| `root` | Read or set the root spring's share. |
| `fade(to, seconds)` | Moves `strength` to `to` over `seconds`. |
| `setStrength(bone, share)` | The share of a bone and every bone under it. |
| `hit(bone, impulse, {point, weaken, recover})` | Applies the impulse and weakens the bone, the bones under it and the bones above it up to the root. |
| `error` | Largest angle, radians, between a powered bone and its target at the last step. |
| `dispose()` | Takes the motors and the added mass off. `using` works. |

Joint motors are equal and opposite torques on two bodies, so they keep a pose but cannot hold a character up. With `root: 0` a powered character falls over stiff. `root` above 0 keeps it up, and that spring is an outside force, not a muscle: it acts on every bone by its motor's share, so a limp limb still hangs. To stand on its feet and step, use `margoengine/ragdoll/balance`.

A motor's target stops at the joint's limits, so it never pulls against a limit it would have to pass. The default cone of π/4 is tighter than most clips: give a ragdoll that follows a clip wider limits, or `{type: 'free'}`, or the clip is clipped. The target's own spin is fed to the motor, so a moving pose is tracked without the lag a spring alone has.

Skeletons put small bodies between big limbs, and a solver cannot hold a strong motor against a body hundreds of times lighter. `addRagdollMotors` adds mass up to an eighth of each body's heaviest neighbour and inertia up to a tenth of the heaviest limb it carries, and `dispose()` takes it off.

## Getting up (`margoengine/ragdoll/getup`)

`addGetUp(ragdoll, animator, options)` gets a character up from a ragdoll. `start()` compares how the body lies with the first frame of each clip, picks the one that fits, turns and moves the character so that frame lies on the body, on the ground under it, and blends the bones from the ragdoll's pose into the clip. When the clip ends the animator goes on to `then`.

```ts
import { Ragdoll } from 'margoengine/ragdoll';
import { addGetUp } from 'margoengine/ragdoll/getup';
import { Animation } from 'margoengine/animation';
import RAPIER from '@dimforge/rapier3d-compat';
import { EngineKernel } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf-pro';
import { Physics } from 'margoengine/physics';
import { Animator } from 'margoengine/animator';

await RAPIER.init();
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!);
const physics = new Physics(engine, { rapier: RAPIER });
physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [20, 0.1, 20] } });
const model = await loadGLTF(engine, '/hero.glb');
const bone = (name: string) => model.nodes.find((node) => node.name === name)!;
const hips = bone('Hips');
const animator = Animator.attach(Animation.attach(model), {
  initial: 'idle',
  states: { idle: 'Idle', back: 'GetUpFromBack', front: 'GetUpFromFront' },
});
const ragdoll = Ragdoll.attach(physics, { root: hips });
const getUp = addGetUp(ragdoll, animator, { faceUp: 'back', faceDown: 'front', then: 'idle' });

ragdoll.activate();
ragdoll.part(bone('Head'))?.body.applyImpulse([0, 2, -30]);
setTimeout(async () => {
  const { side, mismatch } = await getUp.start();
  console.log(`got up ${side}, ${mismatch} radians from the clip at the root`);
}, 2000);
```

| Option | Default | Meaning |
| --- | --- | --- |
| `faceUp` | none | Animator state of the clip that gets up from lying on the back. |
| `faceDown` | none | Animator state of the clip that gets up from lying on the front. |
| `then` | the animator's state now | State to go to when the clip ends. |
| `blend` | `0.4` | Seconds from the ragdoll's pose into the clip. |
| `fade` | `0.2` | Seconds from the end of the clip into `then`. |
| `root` | the model's root | The top node of the character, moved and turned to the body. |
| `up` | `[0, 1, 0]` | World up. |

`pick()` says which clip fits now, and `mismatch(side)` by how many radians. `start({side, signal})` forces a clip, and an aborted signal rejects the promise while the clip plays on. It throws a `MargoError` with code `state` when no bone is limp or a get-up is running. The promise gives `{side, mismatch}`, where `mismatch` is the radians between the body and the clip's first frame at the root bone.

No facing convention is needed: only the turn about the up axis is free, and what is left over tells the clips apart. `addGetUp` reads each clip's first frame through the animator once, and puts it back as it was; a `statechange` listener sees that visit. The ground is found with a ray down from the hips that ignores moving bodies; with no ground the character keeps its height. The clip should loop off, or be a state with a later transition: the end of its first cycle is what ends the get-up.

## Body shapes from the skin (`margoengine/ragdoll/hulls`)

`fitRagdollShapes(ragdoll, model, options)` swaps each bone's capsule for a convex hull of the vertices it carries, or for the smallest box around them that lies along the bone. A vertex belongs to the bone that dominates its skin weights, and skin joints with no body (fingers, toes) count toward the bone above them. Hits land on what the player sees.

```ts
import { Ragdoll } from 'margoengine/ragdoll';
import RAPIER from '@dimforge/rapier3d-compat';
import { EngineKernel } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf-pro';
import { Physics } from 'margoengine/physics';
import { fitRagdollShapes } from 'margoengine/ragdoll/hulls';

await RAPIER.init();
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!);
const physics = new Physics(engine, { rapier: RAPIER });
physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [20, 0.1, 20] } });
const model = await loadGLTF(engine, '/hero.glb');
const bone = (name: string) => model.nodes.find((node) => node.name === name)!;
const hips = bone('Hips');
const ragdoll = Ragdoll.attach(physics, { root: hips });
const fitted = fitRagdollShapes(ragdoll, model);
console.log(`${fitted.length} of ${ragdoll.bones.length} bones fit the mesh`);

fitRagdollShapes(ragdoll, model, { shape: 'box', minWeight: 0.3 }); // boxes, with blended vertices counted
```

| Option | Default | Meaning |
| --- | --- | --- |
| `shape` | `'hull'` | `'hull'`, or `'box'`: cheaper, and looser. |
| `minWeight` | `0.5` | A vertex counts toward a bone when the bone carries this share of it. |
| `maxPoints` | `64` | Most corners a hull keeps, 8 to 1,024. |

The source is the glTF model the skeleton belongs to, or a `RagdollSkin` of your own (`positions`, `joints`, `weights`, `nodes`, `inverseBindMatrices`). The result lists the bones that got a shape; a bone with no vertices that span a volume keeps its capsule. Mass, friction, groups and joints stay as they were, and each bone's inertia follows its new shape. Call it before `addRagdollMotors`, and give a leaf bone you want a hull for, such as a head with no child, a `length` so it is a bone.

The same data goes in by hand: `ragdoll.setShape(bone, shape)`, or `shape` on an entry of `bones`, takes `{type: 'capsule'}`, `{type: 'hull', points}` or `{type: 'box', center, halfExtents, rotation}`, in the bone's own frame. `part.shape` reads it back and `part.mass` the mass as built.

## Saved profiles (`margoengine/ragdoll/profile`)

A profile is a ragdoll as plain JSON: bones by name, joints and limits, sizes, masses, shapes and the shared body settings. Tune a ragdoll once, save it, and every copy of the character builds the same one. `humanoidProfile` is a place to start.

```ts
import { Ragdoll } from 'margoengine/ragdoll';
import RAPIER from '@dimforge/rapier3d-compat';
import { EngineKernel } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf-pro';
import { Physics } from 'margoengine/physics';
import { humanoidProfile, ragdollOptions, saveRagdollProfile } from 'margoengine/ragdoll/profile';

await RAPIER.init();
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!);
const physics = new Physics(engine, { rapier: RAPIER });
physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [20, 0.1, 20] } });
const model = await loadGLTF(engine, '/hero.glb');
const otherModel = await loadGLTF(engine, '/guard.glb');
const otherPhysics = new Physics(engine, { rapier: RAPIER });

// Anatomical ranges, hinged knees and elbows, published mass shares.
const ragdoll = Ragdoll.attach(physics, ragdollOptions(humanoidProfile(model.nodes, { mass: 82 }), model.nodes));

const saved = JSON.stringify(saveRagdollProfile(ragdoll));
const again = Ragdoll.attach(otherPhysics, ragdollOptions(JSON.parse(saved), otherModel.nodes));
```

| Function | Gives |
| --- | --- |
| `saveRagdollProfile(ragdoll)` | The profile, every value as built. Bones need unique names. |
| `ragdollOptions(profile, nodes)` | The options for `new Ragdoll` or `Ragdoll.attach`; add your own beside them. It throws a `RangeError` naming a bone the skeleton lacks, and for a profile of a newer version. |
| `humanoidProfile(nodes, {mass, bones})` | A profile for a humanoid in a T or A pose. `mass` defaults to 70 kg. |

`humanoidProfile` finds bones by the names `detectSkeleton` knows (Mixamo, Godot, Roblox, humanoid). For other names, pass `bones: {hips: node, leftUpperLeg: node, ...}`; it needs hips, a head, and upper and lower arms and legs. Every node between two named bones joins the lower one's mass, with a small cone. `ragdoll.settings` reads the shared settings a profile saves.

## Balance (`margoengine/ragdoll/balance`)

`addRagdollBalance(ragdoll, motors, {feet})` keeps a powered character on its feet, on its own legs. It watches the capture point of the centre of mass, the spot a step must reach to stop the fall, and swings a foot there; two-bone maths sets each leg from where the hips should be to where its foot is. The weight goes down the stance legs as torque pairs at knee and ankle, held to what the sole can answer, so no outside force holds it up.

```ts
import { Ragdoll } from 'margoengine/ragdoll';
import { addRagdollBalance } from 'margoengine/ragdoll/balance';
import { addRagdollMotors } from 'margoengine/ragdoll/powered';
import RAPIER from '@dimforge/rapier3d-compat';
import { EngineKernel } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf-pro';
import { Physics } from 'margoengine/physics';
import { humanoidProfile, ragdollOptions } from 'margoengine/ragdoll/profile';

await RAPIER.init();
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!);
const physics = new Physics(engine, { rapier: RAPIER });
physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [20, 0.1, 20] } });
const model = await loadGLTF(engine, '/hero.glb');
const bone = (name: string) => model.nodes.find((node) => node.name === name)!;
const ragdoll = Ragdoll.attach(physics, ragdollOptions(humanoidProfile(model.nodes), model.nodes));
const motors = addRagdollMotors(ragdoll, { frequency: 8 });
const balance = addRagdollBalance(ragdoll, motors, { feet: [bone('LeftFoot'), bone('RightFoot')] });
ragdoll.activate();

motors.hit(bone('Spine'), [0, 0, -40]); // it stumbles, steps and catches itself
if (balance.state === 'fallen') motors.fade(0, 0.5);
```

| Option | Default | Meaning |
| --- | --- | --- |
| `feet` | none | The two foot bones. Each needs a knee hinge above it, as `humanoidProfile` builds. |
| `stepTime` | `0.28` | Seconds a step takes. |
| `stepHeight` | `0.15` | How high a foot lifts, as a share of the leg's length. |
| `stepTrigger` | `0.2` | How far the capture point may leave the feet before a step, as a share of the leg's length. |
| `stance` | `0.97` | Hip height held, as a share of the height when added. |
| `carry` | `0` | Share of the upper body's weight an outside force carries, 0 to 1. Off: it stands on its own legs. |
| `upright` | `10` | Frequency in rad/s of the turn that holds the hips upright, answered through the legs by the ground. |
| `maxUpright` | `40` | Largest turn that gives, in rad/s². A harder blow knocks the character over. |
| `fallTilt` | `0.8` | Radians of lean past which it has fallen and balancing stops. |
| `gravity` | `9.81` | World gravity along up, in m/s². |

Every torque is a pair inside the body, so a hard enough blow knocks it over. Set `carry` to lend an outside force, capped at 1.5 times the share asked for; `balance.carried` reads the share of the body's weight it gave at the last step, and is 0 without it. While it balances it adds inertia to the feet and shins, brings the character's island, not the world, to at least 8 solver passes, and stands a foot fitted with a hull on a flat sole of four corners; `dispose` takes all three away. Its torques are forces, so more solver passes only steady it, and a force of your own on a bone stays yours. `steps` counts steps, `capture` is the capture point, `tilt` the lean, and `state` is `standing`, `stepping` or `fallen`. Add it with the character standing still, before `activate`. After a fall, get up with `margoengine/ragdoll/getup` and call `reset()`. `motors.setTarget(bone, rotation)` is what it drives the legs with, and is open to any controller: a rotation relative to the parent bone, or `null` for the animation's pose.

## Clean room

Written from public descriptions only, cited in [docs/clean-room.md](../../docs/clean-room.md); no engine's ragdoll code
was read.
