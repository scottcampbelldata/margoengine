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
| `activate()` | Goes limp: every body becomes dynamic with the velocity its bone had in the last physics step, and physics drives the bones. |
| `deactivate(duration = 0.3)` | The bodies follow the animation again (they jump to it, without sweeping through the world), and the drawn pose blends from the ragdoll's last pose to the animation over `duration` seconds. |
| `active` | True while physics drives the bones. |
| `weight` | How much of the drawn pose is the ragdoll's, 0 to 1. Set it while active for a partial blend. |
| `rootPosition` | World position of the root bone's body: where to move a character before it gets up. |
| `part(node)` | The part of a node, or undefined. |
| `dispose()` | Removes the bodies and joints and the plugin; the bones keep their last pose. `using` works. |

The ragdoll is an engine plugin that runs each frame after the plugins attached before it: create it after the
Animator. It reads the bones' animated pose, sets the kinematic targets, and writes the blended pose. A bone's pose
blends in its parent's frame (rotations for every bone, position for the root bone only), so limbs keep their lengths.
Without an animation, blending back returns to the pose the bones had before the ragdoll moved them.

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

Bones need positive uniform world scales (a scale a little off uniform is a known bug, see `docs/known-bugs.md`). Errors follow the package conventions: a `TypeError` or `RangeError` naming
the fix for bad options, and a `MargoError` with code `disposed` after `dispose()`, `attached` for a second ragdoll on
one skeleton or the wrong engine, and `unsupported` for a hinge on a Rapier build without joint frames.

## Powered ragdolls (`margoengine/ragdoll/powered`)

`addRagdollMotors(ragdoll, options)` gives every joint a motor that pulls its bone toward the pose the animation gives it, while the bone is physical. The character keeps moving, a hit bends it, and the motors take the pose back, instead of it only going limp.

```ts
import { Ragdoll } from 'margoengine/ragdoll';
import { addRagdollMotors } from 'margoengine/ragdoll/powered';

const ragdoll = Ragdoll.attach(physics, { root: hips });
const motors = addRagdollMotors(ragdoll, { root: 1 });
ragdoll.activate(); // physical, and still walking its clip

// A hit: the impulse lands on the chest, the limb weakens at once and gets its strength back over 0.6 seconds.
motors.hit(ragdoll.bones[4], [0, 0, -150], { weaken: 0.8, recover: 0.6 });

motors.setStrength(hand, 0); // that limb hangs while the rest stays powered
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

Joint motors are equal and opposite torques on two bodies, so they keep a pose but cannot hold a character up. With `root: 0` a powered character falls over stiff. `root` above 0 keeps it up, and that spring is an outside force, not a muscle: it acts on every bone by its motor's share, so a limp limb still hangs. To stand on its own feet, use a balance controller.

A motor's target stops at the joint's limits, so it never pulls against a limit it would have to pass. The default cone of π/4 is tighter than most clips: give a ragdoll that follows a clip wider limits, or `{type: 'free'}`, or the clip is clipped. The target's own spin is fed to the motor, so a moving pose is tracked without the lag a spring alone has.

Skeletons put small bodies between big limbs, and a solver cannot hold a strong motor against a body hundreds of times lighter. `addRagdollMotors` adds mass up to an eighth of each body's heaviest neighbour and inertia up to a tenth of the heaviest limb it carries, and `dispose()` takes it off.

## Clean room

Written from public descriptions only, cited in [docs/clean-room.md](../../docs/clean-room.md); no engine's ragdoll code
was read.
