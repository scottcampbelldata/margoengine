# @margoengine/rigging

Import `margoengine/rigging` from the `margoengine` package, or `@margoengine/rigging` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Rigging and animation authoring for characters made in Margo or anywhere else: smooth automatic skin weights, weight painting with undo, the skin checks game engines need before export, IK chains with poles and retarget presets that play Mixamo, Godot and Roblox clips on any humanoid. Everything here is plain data in, plain data out: no engine, renderer or GPU is needed, core is never imported, and an app that does not import this package ships none of it.

## Automatic weights (bone heat)

`boneHeatWeights(mesh, joints)` gives every vertex smooth weights from a rest skeleton, by bone heat diffusion (I. Baran and J. Popović, "Automatic rigging and animation of 3D characters", SIGGRAPH 2007). Each joint moves the vertices around its bone, the segment from the joint to each child (a point at a leaf joint), and weights blend smoothly across joints. Weights are 0 or more and sum to 1 per vertex. Heat only reaches a vertex from bones it can see, so an arm's weight does not leak into the hip it hangs beside.

```ts
import { boneHeatWeights, checkSkin, type RigJoint } from 'margoengine/rigging';

// Any triangle mesh (positions xyz, optional indices) and a rest skeleton in the same space.
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0, 1, 2, 0]);
const indices = new Uint32Array([0, 1, 2, 2, 1, 3]);
const joints: RigJoint[] = [
  { name: 'hips', parent: -1, position: [0.5, 0, 0] },
  { name: 'spine', parent: 0, position: [0.5, 1, 0] },
  { name: 'head', parent: 1, position: [0.5, 2, 0] },
];
const weights = await boneHeatWeights({ positions, indices }, joints, { visibility: false });
const { joints: JOINTS_0, weights: WEIGHTS_0 } = weights.toInfluences(4); // glTF's four strongest per vertex
console.log(JOINTS_0.length, WEIGHTS_0.length); // 16 16
console.log(checkSkin({ weights: weights.toInfluences(4), joints }).ok); // true
```

Options, each with its default:

| Option | Default | Meaning |
| --- | --- | --- |
| `skip` | `[]` | Joints (indices or names) that move no vertices, such as a root at the feet. |
| `visibility` | `true` | Heat only from visible bones; uses `@margoengine/bvh`, loaded on first use. `false` takes the nearest bone (faster; fine for convex parts). Or pass `(from, to) => boolean`. |
| `heat` | `1` | Heat constant c in H = c / d². Larger keeps vertices closer to their nearest bone. |
| `weld` | `1e-6` | Vertices closer than this fraction of the mesh size are one point, so weights cross UV seams and split faces. |
| `tolerance` | `1e-6` | Largest weight error per vertex when a bone's solve stops. |
| `maxIterations` | `2000` | Conjugate-gradient iterations per bone; a `MargoError` with code `failed` when not enough. |
| `threshold` | `1e-4` | Weights below this share are dropped before renormalising. |
| `signal` | none | `AbortSignal`; the promise rejects with its reason. The solve yields to the event loop every 30 ms. |

Vertices at one position always get the same weights. Pass `joints` from `@margoengine/exporters/skin`'s `humanoidJoints()`, or turn any glTF skeleton into joints with `rigJoints(retargetRig(model))`.

## Weight painting

`WeightPainter` paints a `WeightMap` with brush dabs: `add`, `subtract`, `replace` (toward `value`) and `smooth` (toward the neighbours' average). Each dab keeps every vertex it touches summing to 1: when one bone gains or loses weight, the other unlocked bones on that vertex make up the difference. Locked bones never change. Every stroke returns its undo.

```ts
import { WeightMap, WeightPainter } from 'margoengine/rigging';

const mesh = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
const map = new WeightMap(3, 2, [1, 0, 1, 0, 1, 0]);
const painter = new WeightPainter(map, mesh, { parents: [-1, 0], locked: [] });
const stroke = painter.stroke({ mode: 'add', bone: 1, center: [0, 1, 0], radius: 0.8, strength: 0.5, falloff: 'smooth' });
painter.smoothAll({ iterations: 2, strength: 0.5 });
stroke.undo(); // undo strokes newest first
painter.normalize();
```

| Stroke field | Default | Meaning |
| --- | --- | --- |
| `mode` | required | `add`, `subtract`, `replace` or `smooth`. |
| `bone` | required except for `smooth` | The bone painted. |
| `center`, `radius` | required | Brush sphere in mesh space. |
| `strength` | `0.5` | Amount at the centre (0-1). |
| `value` | `1` | `replace`'s target weight. |
| `falloff` | `smooth` | `smooth` (smoothstep), `linear` or `constant`. |

Subtracting from a vertex whose other bones hold nothing passes the weight to the bone's parent (pass `parents`); with no unlocked parent the vertex keeps it, so a vertex never ends up unweighted. `WeightMap` is dense (`values[vertex * boneCount + bone]`); `toInfluences(4)` returns the strongest four per vertex, renormalised, and `WeightMap.fromInfluences({joints, weights})` reads them back.

## Skin checks before export

`checkSkin` reports what Unity, Unreal, Godot, Roblox and glTF validators reject or render wrongly: unweighted vertices, more than four influences, weights that don't sum to 1, negative or non-finite weights, joint indices outside the skin, and degenerate bones (a joint on its parent, or a non-invertible inverse bind matrix). `assertSkin` throws a `RangeError` naming each fault and its fix.

```ts
import { WeightMap, assertSkin, checkSkin } from 'margoengine/rigging';

const weights = new WeightMap(2, 2, [0.6, 0.6, 0, 0]);
const report = checkSkin({ weights, maxInfluences: 4, tolerance: 1e-3 });
for (const issue of report.issues) console.log(issue.code, issue.count, issue.vertices, issue.message);
// not-normalized 1 [0] "1 vertex(es) have weights that don't sum to 1; call normalize()"
// unweighted 1 [1] "1 vertex(es) have no weight; paint them or run boneHeatWeights"
weights.normalize();
try {
  assertSkin({ weights });
} catch (error) {
  console.log((error as RangeError).message); // still names vertex 1 as unweighted
}
```

Input is a `WeightMap` or per-vertex influences (`{joints, weights, influences?}`, glTF's JOINTS_0 / WEIGHTS_0 at the default width 4); add `joints` (the rest skeleton) or `inverseBindMatrices` to check bones too. Defaults: `maxInfluences` 4, `tolerance` 1e-3.

## IK chains with pole targets (`margoengine/rigging/ik`)

FABRIK (A. Aristidou and J. Lasenby, 2011) chains of any length with a pole: the joints move so the last one reaches the target, every bone keeps its length, and the bend faces the pole (a knee or elbow hint). Solve on an Animator every frame, on a `Skeleton` while authoring a pose, or on raw joint positions.

```ts
import { EngineKernel } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf-pro';
import { Animation } from 'margoengine/animation';
import { Animator } from 'margoengine/animator';
import { addIKChain, type AnimatorIKChain } from 'margoengine/rigging/ik';

const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, { backend: 'webgpu' });
const model = await loadGLTF(engine, '/hero.glb');
const animator = Animator.attach(Animation.attach(model), { initial: 'idle', states: { idle: 'Idle' } });
const node = (name: string) => model.asset.doc.nodes!.findIndex((n) => n.name === name);
const reach: AnimatorIKChain = {
  joints: [node('LeftArm'), node('LeftForeArm'), node('LeftHand')], // each the child of the one before
  target: [0.4, 1.3, 0.5], // world space; write into it every frame
  pole: [0.3, 1.2, -0.6], // the elbow bends toward this point
  weight: 1, // 0 keeps the animated pose
  iterations: 32, // default 32
  tolerance: 1e-4, // default 1e-4, world units
};
const remove = addIKChain(animator, reach);
engine.start();
remove(); // when done
```

For joint limits use `addCCDChain` from `margoengine/animator`. While authoring (no engine), `solveSkeletonIK(skeleton, {joints, target, pole})` poses an `@margoengine/animation` `Skeleton` by bone names or indices, `solvePoseIK({parents, local}, chain)` solves on a local pose array (10 numbers per bone, as `retargetRig` makes), and `solveFABRIK(points, target, {pole})` moves raw joint positions:

```ts
import { Skeleton } from 'margoengine/animation';
import { solveFABRIK, solveSkeletonIK } from 'margoengine/rigging/ik';

const leg = new Skeleton([
  { name: 'hip', parent: -1 },
  { name: 'knee', parent: 0, translation: [0, -0.45, 0] },
  { name: 'ankle', parent: 1, translation: [0, -0.42, 0] },
]);
const result = solveSkeletonIK(leg, { joints: ['hip', 'knee', 'ankle'], target: [0.1, -0.7, 0.2], pole: [0, -0.4, 1] });
console.log(result.reached, result.distance, result.iterations);

const points = new Float64Array([0, 0, 0, 0, 1, 0, 0, 2, 0]); // xyz per joint, the first one fixed
solveFABRIK(points, [1, 1, 0], { pole: [2, 0, 0], iterations: 32, tolerance: 1e-4 });
```

Unreachable targets straighten the chain toward them (`reached` false, `distance` the gap). A straight chain starts bending toward the pole (or, with none, a fixed side).

**With `@margoengine/kinematics-constraints`.** `elbowEvaluator(upperLength, lowerLength, pole)` is the `ElbowEvaluator` an `AvoidanceSolver` needs: the elbow of a two-bone arm reaching from the shoulder to the target, turned `poleAngle` about the shoulder-target line from the pole's side. The solver then searches that angle for an elbow that clears the body's capsules and spheres:

```ts
import { AvoidanceSolver, CapsuleVolume } from 'margoengine/kinematics-constraints';
import { elbowEvaluator } from 'margoengine/rigging/ik';

const torso = new CapsuleVolume({ start: [0, 0.9, 0], end: [0, 1.5, 0], radius: 0.18 });
const avoid = new AvoidanceSolver([torso], { minClearance: 0.01, targetRadius: 0.04 });
const evaluate = elbowEvaluator(0.3, 0.28, [0.2, 1.2, -0.5]); // upper arm, forearm, pole
const shoulder = [0.2, 1.4, 0], hand = new Float32Array([0.5, 1.2, 0.2]);
const solved = avoid.solve(shoulder, hand, [-0.1, 1.2, 0.35], 0.3, 0.28, 0.05, 0.04, 1 / 60, evaluate);
console.log(solved.status, solved.elbow, solved.target);
```

Root motion and look-at / aim constraints live with the Animator: `addRootMotion`, `addLookAt` and `addAimConstraint` in [`@margoengine/animator`](../animator/README.md).

## Joint hulls (`margoengine/rigging/hulls`)

`jointHulls(model, options)` finds the convex hull of the vertices each joint carries, from a skinned mesh in its bind pose. A hull is a short list of corners, so a clearance or collision test can use the real shape of a torso, head or forearm instead of a sphere or capsule. Run it once at load. It uses `@margoengine/geometry`'s quickhull, and only this entry imports it.

```ts
import { jointHulls } from 'margoengine/rigging/hulls';

// A column of four rings of box corners; the lower two rings follow joint 0, the upper two follow joint 1.
const positions: number[] = [];
const joints: number[] = [];
for (let ring = 0; ring < 4; ring++)
  for (const x of [-0.5, 0.5])
    for (const z of [-0.5, 0.5]) {
      positions.push(x, ring, z);
      joints.push(ring < 2 ? 0 : 1);
    }
const skin = { joints: Uint16Array.from(joints), weights: new Float32Array(joints.length).fill(1), influences: 1 };

// Joint 1 sits at y = 2 in the bind pose; its inverse bind matrix (glTF column-major) moves the world down by 2.
const translateDown = (y: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -y, 0, 1];
const inverseBindMatrices = [...translateDown(0), ...translateDown(2)];
for (const hull of jointHulls({ positions, skin }, { inverseBindMatrices }))
  console.log(hull.joint, hull.vertexCount, hull.points.length / 3); // 0 8 8, then 1 8 8
```

| Option | Default | Meaning |
| --- | --- | --- |
| `minWeight` | `0.5` | A vertex counts toward a joint when the joint carries at least this much of it (0 to 1). The default gives each vertex to its main joint, so neighbouring hulls meet without overlapping; lower it so blended vertices (an elbow) reach into both. |
| `maxPoints` | `64` | Most corners a hull keeps (8-1,024). Larger hulls keep the corners that reach farthest in directions spread over the sphere; every kept point is still a corner of the full hull, so the reduced hull lies inside it. |
| `inverseBindMatrices` | none | 16 numbers per joint. With them each hull is in its joint's own space, so the joint's world matrix places it; without them the corners stay in mesh space. |

The model is `{positions, skin}`: bind-pose `positions` (xyz per vertex) and `skin` as a `WeightMap` or per-vertex influences (`{joints, weights, influences?}`). A joint repeated in several slots of one vertex counts its weights together. Joints that own fewer than four vertices, or whose vertices lie on a line or plane, have no hull and are left out of the result. Positions or weights that are not finite, a skin whose vertex count differs from the positions, and a joint with no inverse bind matrix throw a `RangeError` that names the fix.

## Spring bones and jiggle (`margoengine/rigging/springs`)

Secondary motion for hair, tails, cloth strips and accessories with no physics world: `addSpringBones(animator, options)` swings chains of bones after the frame's animation, against sphere and capsule colliders. The settings mean what `VRMC_springBone` 1.0's mean, so a VRM's values work as authored. Tails follow the animated pose, so a clip keeps its say and the chain settles back on it. The step is corrected for time: the same character swings the same at 30, 60 or 144 frames a second.

```ts
import { SpringBones } from 'margoengine/rigging/springs';

// Plain data: a bone at the top and a rope of two bones hanging from it.
const parents = [-1, 0, 1];
const bone = (y: number) => [0, y, 0, 0, 0, 0, 1, 1, 1, 1];
const springs = new SpringBones(parents, {
  chains: [{ joints: [0, 1, 2], stiffness: 1, drag: 0.4, gravity: 0.5, radius: 0.02 }],
  colliders: [{ offset: [0.4, -1, 0], radius: 0.25 }],
});
for (let frame = 0; frame < 60; frame++) {
  const local = Float64Array.from([...bone(0), ...bone(-1), ...bone(-1)]); // this frame's animated pose
  local[0] = frame * 0.02;
  springs.stepPose({ parents, local }, 1 / 60); // rotations swing in place
}
```

On a character, joints and collider nodes are glTF node indices:

```ts
import type { Animator } from 'margoengine/animator';
import { addSpringBones } from 'margoengine/rigging/springs';

declare const animator: Animator; // of a loaded model
const hair = addSpringBones(animator, {
  chains: [
    { joints: [15, 16, 17], stiffness: 1.5, drag: 0.4, gravity: 0.3, center: 8 }, // measured against the head
    { joints: [21], tail: [0, -0.06, 0], stiffness: 0.8 }, // an earring: one joint and an end point
  ],
  colliders: [{ node: 8, radius: 0.09 }, { node: 5, tail: [0, 0.3, 0], radius: 0.12 }],
  jiggles: [{ joint: 30, frequency: 3, damping: 0.3, limit: 0.03 }], // lags and wobbles in place
});
hair.reset(); // after moving the character by hand
hair[Symbol.dispose]();
```

`options` is kept and read every frame, so settings change live. `SpringBones` runs without an engine: `stepPose` for plain data, `stepSkeleton` for a `Skeleton` from `@margoengine/animation`, `step` for your own bones.

| Chain field | Default | Meaning |
| --- | --- | --- |
| `joints` | required | Bones root to tip, each an ancestor of the next (up to 256). Bones left out ride along. The last is only a tail and does not turn, unless `tail` is set. A joint belongs to one chain. |
| `stiffness` | `1` | Pull back toward the animated direction, 0 or more. |
| `drag` | `0.5` | Share of the speed lost each 1/60 s, 0 to 1. |
| `gravity` | `0` | Strength of gravity on the tail. |
| `gravityDirection` | `[0, -1, 0]` | World direction of gravity. |
| `radius` | `0` | Size of the tail against colliders. |
| `settings` | none | Any of the five above per joint, by position in `joints`. |
| `tail` | none | End point past the last joint, in its local space, so that joint turns too. |
| `center` | none | `joints[0]` or an ancestor: motion of this bone does not swing the chain. Gravity stays in world space. |
| `colliders` | all | Indices into `options.colliders` this chain hits. |

| Option | Default | Meaning |
| --- | --- | --- |
| `chains`, `colliders`, `jiggles` | none | What to simulate. A collider is `{node, offset, tail, radius}`: a sphere, or a capsule when `tail` is set; with no `node` its points are world points. |
| `force` | none | Extra world force on every tail, such as wind, in `gravity` units. |
| `weight` | `1` | Blend from the animated pose (0) to the simulated one (1). |
| `teleportSpeed` | `100` | World speed in units a second above which a chain restarts from the animated pose instead of whipping across the gap. |

| Jiggle field | Default | Meaning |
| --- | --- | --- |
| `joint` | required | The bone. Its position trails the animated one on a damped spring; steady motion leaves no lag. |
| `frequency` | `4` | Wobbles a second, up to 15. |
| `damping` | `0.35` | Share of critical damping: 1 stops without a wobble. |
| `limit` | `0.05` | Farthest the bone strays from its animated position. |
| `amount` | `1` | Share of the movement shown. |

A model scaled up swings the same, only larger: forces, `radius`, collider radii and `limit` follow the bones' world scale. Joints and their ancestors need positive uniform scales. A `delta` of 0 holds the motion, and a long frame takes at most 8 steps of 1/60 s, so a stall slows the swing and cannot blow it up. Spring bones run after other solvers in the order they were added.

## Retarget presets (`margoengine/rigging/retarget`)

Clips made for one skeleton play on another: `prepareRetarget(source, target)` recognises each rig's naming (Mixamo with any `mixamorig` prefix, Godot's humanoid profile, Roblox R15, the joints of `@margoengine/exporters/skin`'s `humanoidJoints()`, or the 55 humanoid bone names themselves), maps every target bone to its source bone, and by default turns the target's reference pose so each bone points the way the source's does at rest (an A-pose character driven by T-pose clips). Pass the result to `@margoengine/animation`'s `Retarget`:

```ts
import { Animation, applyKeyframeClip } from 'margoengine/animation';
import { Retarget, retargetRig } from 'margoengine/animation/skeleton-utils';
import { createStage } from 'margoengine';
import { loadGLTF } from 'margoengine/gltf-pro';
import { detectSkeleton, prepareRetarget } from 'margoengine/rigging/retarget';

const stage = await createStage('#viewport', { backend: 'webgpu' });
const [mixamoModel, godotHero] = await Promise.all(
  ['/mixamo-walk.glb', '/godot-hero.glb'].map((url) => loadGLTF(stage.engine, url)),
);
const source = retargetRig(mixamoModel), target = retargetRig(godotHero);
console.log(detectSkeleton(source.names)); // { preset: 'mixamo', bones: (humanoid bones found) }, or null
const prepared = prepareRetarget(source, target); // or { from: 'mixamo', to: 'godot', alignRest: true }
console.log(prepared.from, prepared.to, prepared.hip, prepared.unmapped); // mixamo godot Hips [...]
const retarget = new Retarget(source, prepared.target, prepared); // names and hip come from prepared
const walk = retarget.clip({ animation: Animation.attach(mixamoModel), clip: 'Walk' }, { fps: 30 });
applyKeyframeClip(walk, Animation.attach(godotHero), 0.5);
```

| Option | Default | Meaning |
| --- | --- | --- |
| `from` | detected | The source's naming: `mixamo`, `godot`, `roblox`, `margo` or `humanoid`. |
| `to` | detected | The target's naming. |
| `alignRest` | `true` | Turn the target's reference pose to the source's, bone by bone. `false` keeps the target's own rest pose (both rigs already stand alike). |

Target bones with no source bone (a Godot `Root`, Roblox's `HumanoidRootPart`, fingers a source lacks) map to `''` and stay at rest; the humanoid bones among them are listed in `unmapped`. Roblox R15 has no neck, shoulders, toes or fingers, so clips from it leave those at rest. Both rigs' model spaces must face the same way (glTF: +z forward, the figure's left at +x). `humanoidBones(names, preset)` gives the humanoid bone -> index map for your own tools, and `HUMANOID_BONES` lists every humanoid bone, parents first. An unrecognised naming throws a `RangeError` that asks for `from` or `to`.

## Sources

Written clean room from the published papers listed in [docs/clean-room.md](../../docs/clean-room.md#rigging-margoenginerigging).
