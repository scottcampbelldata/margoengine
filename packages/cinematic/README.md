# @margoengine/cinematic

Import `margoengine/cinematic` from the `margoengine` package, or `@margoengine/cinematic` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

`rig.setOrbitOffset(yaw, pitch, distance, height = 0)` writes the retained camera
offset in place from orbit angles (no new vector is created). The sandbox uses this
public method after its shared locomotion step.

A virtual camera with analytically integrated critically damped follow and look-at springs plus additive screen shake.

```ts
import {Cinematic} from 'margoengine/cinematic';
import {Engine} from 'margoengine/core';
import {boxGeometry} from 'margoengine/geometry';
import {PbrMaterial, createMesh} from 'margoengine/materials';
const engine = await Engine.create(document.querySelector('canvas')!);
const player = createMesh(engine, boxGeometry(0.5, 1.8, 0.5), new PbrMaterial()).root;
const rig = Cinematic.attach(engine, {offset: [0,3,6], damping: 6});
rig.follow(player);
rig.shake(0.2, 0.4);
```

follow accepts a live mesh from the attached engine or a world-position tuple. Mesh targets use world transforms. Shake amplitude is in world units and duration is seconds; it does not alter the settled spring position. The frame plugin owns camera position/target while attached, so disable competing camera controls. dispose detaches it.

Scope the rig with `using` (it calls `dispose()` and returns the camera to your controls):

```ts
import RAPIER from '@dimforge/rapier3d-compat';
import {Cinematic} from 'margoengine/cinematic';
import {Engine} from 'margoengine/core';
import {Physics} from 'margoengine/physics';
const engine = await Engine.create(document.querySelector('canvas')!);
await RAPIER.init();
const physics = Physics.attach(engine, {rapier: RAPIER});
{
  using rig = Cinematic.attach(engine, {offset: [0, 3, 6]});
  rig.follow([0, 1.6, 0]);
  rig.update(1 / 60);
}
```

Errors name their fix: a bad argument throws `RangeError` or `TypeError` (for example `Invalid camera delta; pass a finite delta of 0 or more seconds`), and attaching a rig twice throws `MargoError` with code `attached`.

Set `ground: (x,z) => height` to keep the camera arm above a CPU heightfield.
`clearance` defaults to 0.65 world units. The rig checks both its desired arm and
the resulting damped/shaken camera, without changing your requested `offset`.
For a below-target orbit, it raises the rendered aim point with the camera so
terrain clearance preserves upward look instead of forcing the view back down.
Six samples along each arm suit broad terrain; narrow ridges and buildings need
collision geometry. Heights must be finite. Ground handling is disabled by default.

Walls and ceilings: set `collide: (origin, direction, distance) => hitDistance | null`. Each frame
the rig asks for the first obstacle along the arm from the look-at point to the (damped, shaken,
ground-lifted) camera; on a hit the camera moves in at once to `clearance` short of it, and once the
arm is clear it eases back out at the follow damping. The spring state and your `offset` are
unchanged. The arrays passed in are reused each frame. Any scene query fits, for example a sphere
cast against the physics world (so the near plane does not clip into the wall):

```ts
const rig = Cinematic.attach(engine, {offset: [0, 3, 6], clearance: 0.3,
  collide: (o, d, max) => physics.shapeCast({shape: 'sphere', radius: 0.2}, [o[0], o[1], o[2]], [0, 0, 0, 1], [d[0], d[1], d[2]], {maxDistance: max, excludeDynamic: true})?.distance});
```

or `@margoengine/bvh`'s Raycaster (`firstHitOnly`, `far = max`) over the level. Exclude the followed
character from the query, and start it above the floor if the look-at point sits on it (the arm
starts at the target, usually the character's feet).

## Camera priorities and blends

`@margoengine/cinematic/brain` runs many virtual cameras and shows one. Every enabled `VirtualCamera` keeps moving; the `CameraBrain` puts the highest `priority` on screen and blends when that changes. Raise a priority to take the shot:

```ts
import {CameraBrain} from 'margoengine/cinematic/brain';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const brain = CameraBrain.attach(engine, {
  blend: {duration: 1.5},
  rules: [{from: 'wide', to: 'boss', duration: 0}],
});
brain.add({name: 'wide', priority: 10, position: [0, 8, 20], target: [0, 1, 0], fov: 50});
const boss = brain.add({name: 'boss', priority: 0, position: [3, 2, 6], target: [0, 2, 0], fov: 35});
brain.on('change', ({from, to}) => console.log(from?.name, 'to', to.name));
boss.priority = 20; // The next frame cuts to it, by the rule. Set it back and it blends out over 1.5 s.
```

| Option | Default | Meaning |
| --- | --- | --- |
| `blend` | `{duration: 1}` | Used when no rule matches. `duration` in seconds, 0 is a cut; `ease` takes and gives 0..1 (any tween easing), default smoothstep; `style` `'direct'` moves straight across, `'orbit'` swings around the subject. |
| `rules` | none | `{from, to, ...blend}` with camera names or `'*'`. The exact pair wins, then `from` to `'*'`, `'*'` to `to`, `'*'` to `'*'`. |
| `camera` | `engine.camera` | The camera written. |
| `aspect` | the canvas's | Width / height, read by stages. |
| `name` | `'cinematic-brain'` | Plugin name, so each view of a split screen can have a brain. |

On a tie the camera on screen stays; with none on screen the one added last wins. A switch in the middle of a blend starts from what is on screen, and every camera in a blend keeps moving. `brain.cut()` ends a blend now. `camera.enabled = false` takes a camera out of the running and stops its work; its stages start fresh when it comes back.

A camera starts each frame from its `base` pose and runs its `stages` in order; `brain.stages` run after them on the blended pose. A stage is a function `(pose, delta, context) => void` or an object with `update` and `reset`. `rigStage` makes a `Cinematic` rig a stage, so the spring follow of this package drives a virtual camera. Do not attach that rig to the engine:

```ts
import {Cinematic} from 'margoengine/cinematic';
import {CameraBrain, rigStage} from 'margoengine/cinematic/brain';
const brain = new CameraBrain();
const rig = new Cinematic({offset: [0, 3, 6]});
rig.follow([0, 1, 0]);
brain.add({name: 'follow', stages: [rigStage(rig)]});
console.log(brain.update(1 / 60).position);
```

Cutscenes have their own timed cameras in `@margoengine/cutscene/shots`; the brain is for play, where what happens decides the shot.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/cinematic

