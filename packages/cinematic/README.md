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
import {Cinematic} from 'margoengine/cinematic';
import {Engine} from 'margoengine/core';
import {Physics} from 'margoengine/physics';
const engine = await Engine.create(document.querySelector('canvas')!);
await Physics.load();
const physics = Physics.attach(engine);
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

## Framing composer

`FramingComposer` keeps a subject on a chosen spot of the screen the way a camera operator does: small moves leave the picture still, bigger ones are caught up with, and the subject never leaves the frame. It is a stage, so it goes after whatever places the camera. It only turns the camera:

```ts
import {CameraBrain} from 'margoengine/cinematic/brain';
import {FramingComposer} from 'margoengine/cinematic/composer';
import {Engine} from 'margoengine/core';
import {boxGeometry} from 'margoengine/geometry';
import {PbrMaterial, createMesh} from 'margoengine/materials';
const engine = await Engine.create(document.querySelector('canvas')!);
const player = createMesh(engine, boxGeometry(0.5, 1.8, 0.5), new PbrMaterial()).root;
const brain = CameraBrain.attach(engine);
brain.add({
  position: [0, 4, 12],
  stages: [new FramingComposer(player, {screen: [0.4, 0.6], deadZone: [0.15, 0.1], lookahead: 0.4})],
});
```

The target is a mesh, a world point or a function giving one. Sizes are shares of the screen, and `screen` counts from the top left.

| Option | Default | Meaning |
| --- | --- | --- |
| `screen` | `[0.5, 0.5]` | Where the subject sits. `[1 / 3, 0.5]` is the rule of thirds. |
| `deadZone` | `[0.1, 0.1]` | Full width and height of the box around `screen` where the camera does not move. |
| `softZone` | `[0.8, 0.8]` | The box the subject never leaves. Between the two the camera catches up. |
| `damping` | `4` | Catch-up rate in 1/seconds, or `[horizontal, vertical]`. Higher is stiffer. Any frame rate gives the same motion. |
| `lookahead` | `0` | Seconds to aim ahead of the subject along its velocity. |
| `lookaheadSmoothing` | `6` | How fast the measured velocity follows, in 1/seconds. Lower is calmer. |
| `lookaheadVertical` | `true` | Turn it off for a platformer, so a jump does not nod the camera. |

`composer.onScreen` says where the subject is, and `composer.reset()` snaps it back to `screen`, as after a teleport. The camera's `reset()` does the same for all its stages.

## Dolly tracks

`DollyTrack` puts the camera on a rail: any `Spline` from `@margoengine/splines`. Give it a target and the cart goes to the point of the track nearest that target, so the camera keeps pace with the subject without keyframes. It is a stage and goes first; aim afterwards with `FramingComposer`, or let `lookAlong` look down the track.

```ts
import {CameraBrain} from 'margoengine/cinematic/brain';
import {FramingComposer} from 'margoengine/cinematic/composer';
import {DollyTrack} from 'margoengine/cinematic/dolly';
import {Engine} from 'margoengine/core';
import {boxGeometry} from 'margoengine/geometry';
import {PbrMaterial, createMesh} from 'margoengine/materials';
import {Spline} from 'margoengine/splines';
const engine = await Engine.create(document.querySelector('canvas')!);
const runner = createMesh(engine, boxGeometry(0.5, 1.8, 0.5), new PbrMaterial()).root;
const rail = new Spline([[-20, 3, 8], [0, 4, 10], [20, 3, 8]]);
const brain = CameraBrain.attach(engine);
brain.add({stages: [new DollyTrack(rail, {target: runner, lead: 2}), new FramingComposer(runner)]});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `target` | none | A mesh, point or function. Without one the cart stays at `position`; write `dolly.position` to move it. |
| `position` | `0`, or nearest to `target` | Start, in world units along the track. |
| `lead` | `0` | Stay this far ahead of the nearest point; below 0 is behind. |
| `damping` | `4` | Catch-up rate in 1/seconds. |
| `window` | whole track | Search only this far either side of the cart. Set it when the track passes close to itself. |
| `lookAlong` | `false` | Look down the track. |

A closed track wraps and the cart takes the short way round; an open one stops at its ends. `dolly.reset()` puts the cart back on the subject at once.

## Group framing

`GroupFraming` keeps several subjects in one shot. It aims at their centre and moves or zooms until all of them fit. The angle of the shot comes from the pose, so set that with the camera's `position` and `target`, or an earlier stage:

```ts
import {CameraBrain} from 'margoengine/cinematic/brain';
import {GroupFraming} from 'margoengine/cinematic/group';
import {Engine} from 'margoengine/core';
import {boxGeometry} from 'margoengine/geometry';
import {PbrMaterial, createMesh} from 'margoengine/materials';
const engine = await Engine.create(document.querySelector('canvas')!);
const player = (x: number) => {
  const mesh = createMesh(engine, boxGeometry(0.5, 1.8, 0.5), new PbrMaterial()).root;
  mesh.setPosition([x, 0, 0]);
  return mesh;
};
const brain = CameraBrain.attach(engine);
const group = new GroupFraming(
  [{target: player(-4), radius: 1}, {target: player(4), radius: 1, weight: 2}],
  {mode: 'both', maxDistance: 40},
);
brain.add({position: [0, 8, 14], target: [0, 1, 0], fov: 45, stages: [group]});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `'dolly'` | `'dolly'` moves along the view; `'zoom'` stands still and changes the field of view; `'both'` moves, then zooms for what the distance limits left. |
| `padding` | `0.1` | Share of the screen kept clear at each side. |
| `minDistance`, `maxDistance` | `1`, `Infinity` | How near and far the camera goes from the centre. |
| `minFov`, `maxFov` | `10`, `100` | Limits of the zoom, in degrees. |
| `damping` | `4` | How fast the shot follows, in 1/seconds. |

A member is a mesh, a point, a function or `{target, radius, weight}`. `radius` is a sphere that stays in view; `weight` pulls the centre, and 0 leaves the member out. `group.members` can change at any time. `group.fits` is false when the limits stop the shot, and `group.center` can feed a `FramingComposer`: `new FramingComposer(() => group.center)`.

## Noise profiles

`CameraNoise` makes a camera feel held, carried or driven. A profile is plain data, so it can live in a JSON file: bands of smooth noise on each axis, each with a `frequency` in hertz, the middle of its power, and an `amplitude` that is the most it can add. It is a stage and goes after the stages that aim:

```ts
import {CameraBrain} from 'margoengine/cinematic/brain';
import {CameraNoise, handheld, type NoiseProfile} from 'margoengine/cinematic/noise';
const brain = new CameraBrain();
const shaky = new CameraNoise(handheld, {gain: 1.5, seed: 7});
brain.add({name: 'documentary', position: [0, 2, 6], target: [0, 1, 0], stages: [shaky]});

const boat: NoiseProfile = {
  position: {y: [{frequency: 0.2, amplitude: 0.3}]},
  rotation: {roll: [{frequency: 0.15, amplitude: 0.05}], pitch: [{frequency: 0.2, amplitude: 0.02}]},
};
brain.add({name: 'deck', position: [0, 3, 6], target: [0, 2, 0], stages: [new CameraNoise(boat)]});
console.log(brain.update(1 / 60).position);
```

| Export | What it is |
| --- | --- |
| `handheld` | Slow sway of the arms and a little hand tremor near 8 Hz. |
| `walking` | The step up and down near 2 Hz, the sway of each leg at half that. |
| `vehicle` | Body bounce near 1 to 2 Hz and the buzz of the wheels near 12 Hz. |

| Option | Default | Meaning |
| --- | --- | --- |
| `gain` | `1` | Scales every amplitude. Change it at any time, or tween it to fade the noise. |
| `speed` | `1` | Scales every frequency. Tie it to a vehicle's speed. |
| `seed` | `0` | The same seed gives the same motion. |

`position` moves along the camera's own axes in world units; `rotation` is `pitch`, `yaw` and `roll` in radians. The motion is a function of time, so it does not change with the frame rate; set `noise.time` to replay a moment. The amplitudes of the presets were chosen by eye and their frequencies follow published ranges, so treat them as starting points. Keep a band below half the frame rate. For one short hit, use `Cinematic.shake`.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/cinematic

