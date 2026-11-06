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
const shoulder = new Float32Array([0.2, 1.4, 0]), hand = new Float32Array([0.5, 1.2, 0.2]);
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

A model scaled up swings the same, only larger: forces, `radius`, collider radii and `limit` follow the bones' world scale. Joints and their ancestors need positive scales; a scale a little off uniform, as exported rigs often have, reads as its mean. A `delta` of 0 holds the motion, and a long frame takes at most 8 steps of 1/60 s, so a stall slows the swing and cannot blow it up. Spring bones run after other solvers in the order they were added.

## VRM avatars (`margoengine/rigging/vrm`)

VRM 1.0 avatars from any tool that writes them. `readVRM` takes a `.vrm` file's bytes and gives the avatar's data; `addVRM` puts it to work on the model: the 18 preset expressions and any custom ones, the look-at, the spring bones and a mouth and blink channel for your own lip sync. `writeVRM` puts an avatar back into a `.vrm`, and `createVRM` makes one from any rigged glTF.

```ts
import { loadGLTF } from 'margoengine/gltf-pro';
import { Animation } from 'margoengine/animation';
import { addVRM, readVRM } from 'margoengine/rigging/vrm';
import type { Engine } from 'margoengine';
declare const engine: Engine;
const url = 'Seed-san.vrm';
const avatar = readVRM(new Uint8Array(await (await fetch(url)).arrayBuffer()));
console.log(avatar.meta.name, avatar.meta.authors, avatar.meta.commercialUsage); // what its author allows

const model = await loadGLTF(engine, url); // a .vrm is a binary glTF
const animation = new Animation(model);
const vrm = addVRM(animation, avatar);
vrm.expressions.set('happy', 1); // 0 to 1, shown from the next frame
vrm.lookAtTarget = [0, 1.5, 2]; // the eyes follow this world point
console.log(vrm.unsupported); // what this renderer cannot show, by expression
vrm[Symbol.dispose](); // back to neutral
```

Read `avatar.meta` before you use someone's avatar: it is the author's own statement of what may be done with it (`avatarPermission`, `commercialUsage`, `allowRedistribution` and the rest), and the licence named in `licenseUrl` applies. Margo reads it and keeps it; it enforces nothing.

Pass an `Animator` from `margoengine/animator` as `animator` and the avatar runs inside its frame, after your clips, in the order the specification recommends: look-at, expressions, then spring bones. With none, it runs by itself as an engine plugin. `update(delta)` runs one frame by hand. Dispose the avatar before its `Animation`; disposing the model stops the avatar by itself.

```ts
import { createVRM, readVRM, writeVRM } from 'margoengine/rigging/vrm';
declare const rigged: Uint8Array; // any .glb with a skin
const out = writeVRM(
  rigged,
  createVRM({
    name: 'Scout',
    authors: ['Sam'],
    bones: { hips: 1, spine: 2, head: 3 /* and the rest of VRM_REQUIRED_BONES */ },
    expressions: { preset: { blink: { morphTargetBinds: [{ node: 3, index: 0, weight: 1 }] } } },
  }),
); // a .vrm
console.log(readVRM(out).humanoid.humanBones.head?.node); // 3
```

| Name | Meaning |
| --- | --- |
| `readVRM(bytes or doc)` | The avatar: `meta`, `humanoid`, `expressions`, `lookAt`, `firstPerson`, `springBone`, as the file's own JSON, so nothing is lost. Refuses VRM 0.x and a file with no `VRMC_vrm`. |
| `checkVRM(avatar, doc)` | Problems as strings: a missing required bone, a node or morph index out of range. Empty when sound. |
| `writeVRM(glb, avatar)` | A new `.vrm`: the glTF's own bytes and extensions kept, with the avatar in place of any earlier one. |
| `createVRM(options)` | An avatar from a bone map; `licenseUrl` defaults to VRM Public License 1.0, `lookAt`, `expressions` and `springBone` are optional. |
| `vrmSprings(avatar)` | The file's spring bones as `addSpringBones` options. |
| `VRMExpressions` | The expression rules with no engine: `set`, `get`, `resolve`, `evaluate`, `names`; `isBinary` and the `override*` blocks act as the specification says. |
| `vrmGaze`, `vrmEyeAngles`, `vrmLookWeights` | The look-at maths: yaw and pitch from the head to a point, then bone angles or expression weights through the file's range maps. |

| `addVRM` option | Default | Meaning |
| --- | --- | --- |
| `animator` | none | Run inside this `Animator`; with none, run as an engine plugin. |
| `springs` | `true` | Run the file's spring bones. |
| `mouth`, `blink`, `lookAt` | none | Custom expression names that an expression's `overrideMouth`, `overrideBlink` or `overrideLookAt` also holds back, beside the presets the specification names. |

Expressions drive morph targets, `color` and `emissionColor` of materials, and texture moves. The other colour binds exist only in MToon and land in `unsupported`, because Margo draws MToon materials by their plain glTF fallback: no toon shading or outlines. `VRMC_node_constraint` data stays in the file through `writeVRM` and does not run.

## Voxel weights (`margoengine/rigging/voxel-weights`)

Automatic skin weights for meshes bone heat cannot solve: holes, doubled or flipped faces, non-manifold edges, loose parts, and shells inside shells, such as a coat modelled over a body. The mesh is voxelized, the bones are burned into the grid, and each bone's distance is measured through the solid. Two limbs close together stay apart as long as the grid can see the gap.

```ts
import type { RigJoint } from 'margoengine/rigging';
import { voxelWeights } from 'margoengine/rigging/voxel-weights';

const positions = new Float32Array([0, 0, 0.1, 0.1, 0, -0.1, -0.1, 0, -0.1, 0, 2, 0]);
const joints: RigJoint[] = [
  { name: 'base', parent: -1, position: [0, 0, 0] },
  { name: 'tip', parent: 0, position: [0, 2, 0] },
];
const { weights, unreached } = await voxelWeights(
  { positions, indices: [0, 1, 3, 1, 2, 3, 2, 0, 3] }, // the bottom face is missing
  joints,
);
console.log(weights.toInfluences(), unreached); // JOINTS_0 and WEIGHTS_0
```

| Option | Default | Meaning |
| --- | --- | --- |
| `resolution` | `96` | Voxels along the longest side, 8 to 512. Parts closer than about one voxel join. |
| `skip` | none | Joints that move no vertices, such as a root at the feet. |
| `falloff`, `curve` | `4`, `0.75` | The weight of a bone at distance d voxels is `((1 - curve) * d + curve * d * d) ** -falloff`: a larger `falloff` keeps vertices closer to their nearest bone. |
| `influences` | `4` | Most bones per vertex. |
| `closing` | `0` | Closes gaps up to this many voxels before filling. Parts closer than twice this fuse. |
| `weld` | `1e-6` | Welding tolerance as a fraction of the mesh's size. |
| `signal` | none | Cancels the solve between bones. |

The result also gives `grid`, `voxels` and `unreached`: vertices no bone reached through the solid, such as a hat that floats clear of the head, which take the same falloff from straight-line distances. Where a hole lets the outside into the mesh, the fill grows from the bones through voxels with surface on at least four of the six axis directions. Pick bone heat for clean, closed meshes: it is faster and its weights flow along the surface.

## Corrective shapes (`margoengine/rigging/correctives`)

Linear skinning collapses elbows, knees and shoulders. A corrective is a blend shape sculpted to fix that, and this entry drives it from the joint's rotation: full at the pose you sculpted it for, off at rest. `addCorrectives` runs after the pose and after any IK added before it.

```ts
import type { Animator } from 'margoengine/animator';
import { addCorrectives } from 'margoengine/rigging/correctives';
declare const animator: Animator; // on a model with an elbow at node 12 and a morph target 3 on the mesh at node 2
const s = Math.sin(1);
const elbow = addCorrectives(animator, {
  shapes: [{ node: 2, target: 3, joint: 12, pose: [s, 0, 0, Math.cos(1)], curve: 'smooth' }], // full at two radians
});
elbow.dispose(); // shapes back to 0
```

A joint that swings every way, a shoulder, needs several sculpted poses. Give them as a pose space: each sample holds exactly its own weights, and rotations between them blend. Include the rest pose with zero weights, or the shapes stay on away from every sample.

```ts
import { Correctives } from 'margoengine/rigging/correctives';

const r = Math.SQRT1_2;
const shoulder = new Correctives({
  spaces: [
    {
      joint: 7,
      shapes: [
        { node: 2, target: 4 }, // arm raised
        { node: 2, target: 5 }, // arm forward
      ],
      samples: [
        { rotation: [0, 0, 0, 1], weights: [0, 0] },
        { rotation: [0, 0, r, r], weights: [1, 0] },
        { rotation: [r, 0, 0, r], weights: [0, 1] },
      ],
    },
  ],
});
console.log(shoulder.evaluate(() => [0, 0, r, r])); // [{ node: 2, target: 4, weight: 1 }, { node: 2, target: 5, weight: 0 }]
```

| Shape field | Default | Meaning |
| --- | --- | --- |
| `node`, `target` | required | The mesh's glTF node and the morph target. |
| `joint` | required | The bone that drives it. |
| `pose` | required | The joint's local rotation where the shape is full. |
| `rest` | the joint's rest | The joint's local rotation where the shape is off. |
| `cone` | none | Radians off the line from `rest` to `pose` at which the shape has faded out. With none only the bend along that line counts, so a hinge's twist does nothing. |
| `start` | `0` | Reading where the shape starts: `0.5` keeps it off for the first half of the bend. |
| `curve` | `'linear'` | `'smooth'` eases in and out. |
| `amount` | `1` | Weight at full bend. |

Shapes on one target add up, then clamp to 0 to 1. `width` on a pose space sets the Gaussian width in radians; the default is the mean angle from each sample to its nearest neighbour. Pose spaces are solved once when made. `Correctives` is plain data, so `evaluate(rotationOf, restOf)` runs with no engine. A driven morph target belongs to the correctives: a clip's track on it is overwritten.

## Weight transfer (`margoengine/rigging/transfer`)

Copies skin weights from a rigged mesh to clothing, or to any mesh around it. Each vertex takes the weights at the closest point of the source's surface, read across that triangle. A match counts only when it is near and the two surfaces lie alike, so a sleeve vertex next to the torso does not take the torso's weights; those vertices are filled in from the matched ones around them, over the target's own surface.

```ts
import { WeightMap } from 'margoengine/rigging';
import { transferWeights } from 'margoengine/rigging/transfer';

// A rigged triangle with one bone per corner, and a smaller one 1 cm in front of it.
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const body = { positions, indices: [0, 1, 2], weights: new WeightMap(3, 3, [1, 0, 0, 0, 1, 0, 0, 0, 1]) };
const shirt = { positions: new Float32Array([0.1, 0.1, 0.01, 0.5, 0.1, 0.01, 0.1, 0.5, 0.01]), indices: [0, 1, 2] };
const { weights, matched, filled } = await transferWeights(body, shirt);
console.log(weights.toInfluences(), matched, filled);
```

`weights` on the source is a `WeightMap`, or `{ joints, weights }` as JOINTS_0 and WEIGHTS_0 hold them. Both meshes share one space, so pose them alike first.

| Option | Default | Meaning |
| --- | --- | --- |
| `maxDistance` | `0.05` | Farthest a match may be, as a fraction of the source's size. |
| `maxAngle` | `60` | Largest angle between the two surfaces at a match, degrees. Either facing counts, because cloth is often one layer with its normals any way round. |
| `iterations` | `1000` | Most sweeps of the fill; it stops sooner once weights settle. |
| `threshold` | `1e-4` | Weights below this are dropped before renormalising. |
| `boneCount` | the source's | Bones in the result, for influences that do not use the last ones. |
| `weld` | `1e-6` | Welding tolerance of the target as a fraction of its size. |
| `signal` | none | Cancels the transfer. |

`matched` and `filled` count target points. A part of the target with no match at all, such as a hat clear of the head, keeps the closest weights as they are.

## Face tracking (`margoengine/rigging/face`)

Puts a tracked face on a character. Face trackers report the same 52 values from 0 to 1, one per facial movement: Apple's ARKit, Google's MediaPipe Face Landmarker and Live Link Face all do. `addFace` reads a frame in any of their shapes, smooths it and drives the model's morph targets, found by name, or a VRM avatar's expressions.

```ts
import { loadGLTF } from 'margoengine/gltf-pro';
import { Animation } from 'margoengine/animation';
import { addFace } from 'margoengine/rigging/face';
import type { Engine } from 'margoengine';
declare const engine: Engine;
const animation = new Animation(await loadGLTF(engine, 'character.glb'));
const face = addFace(animation, { mirror: true }); // a selfie camera: swap sides
console.log(face.matched, face.missing); // which of the 52 this model can show

// Call this with each tracker frame, at the tracker's own rate.
face.push({ jawOpen: 0.4, eyeBlinkLeft: 1 });
face.push(null); // tracking lost: back to neutral
face.dispose();
```

A frame is a record of names to values, or a list of `{ categoryName, score }`, so MediaPipe's `result.faceBlendshapes[0].categories` goes straight in. Names are matched by `faceShapeOf`, which ignores case, separators and any prefix and knows `_L` and `_R`: `EyeBlinkLeft`, `eye_blink_left`, `eyeBlink_L` and `ARKit_eyeBlinkLeft` all read as `eyeBlinkLeft`. Model morph targets are read from `extras.targetNames` on every mesh, so head, teeth and lashes move together. For other names, pass `map`:

```ts
import { addFace } from 'margoengine/rigging/face';
import type { VRMHandle } from 'margoengine/rigging/vrm';
import type { Animator } from 'margoengine/animator';
declare const animation: Animator['animation'];
declare const avatar: VRMHandle;
addFace(animation, { map: { jawOpen: 'Mouth_Open', eyeBlinkLeft: ['Blink_L', 'Lash_L'] } });
addFace(animation, { vrm: avatar }); // or a VRM avatar: drives its preset expressions
```

| `addFace` option | Default | Meaning |
| --- | --- | --- |
| `smoothing` | `0.05` | Time constant in seconds; 0 follows the tracker exactly. The same at any frame rate. |
| `gain` | `1` | Multiplies values before they clamp to 0 to 1: one number, or per shape. |
| `mirror` | `false` | Swaps left and right, for a mirrored camera. |
| `map` | none | Morph target names for shapes the names alone do not find. |
| `vrm` | none | Drive this avatar's expressions rather than morph targets. |
| `animator` | none | Run inside this `Animator`; with none, run as an engine plugin. |

`FaceMapper` is the same thing as plain data, with no engine: `push(frame)`, `update(delta)`, `get(shape)`, `values`. `vrmFaceExpressions(get)` gives the VRM presets: what both eyes share goes to `blink` and the rest to `blinkLeft` and `blinkRight`, the eyes' mean to the look presets, `jawOpen`, `mouthPucker`, `mouthFunnel`, the mouth's lower lip and stretch to `aa`, `ou`, `oh`, `ih`, `ee`, and smile, frown, brow and wide eyes to `happy`, `sad`, `angry` and `surprised`. No tracker value stands for `relaxed`. A driven morph target belongs to the face: a clip's track on it is overwritten.

ARKit is a trademark of Apple Inc. MediaPipe is a trademark of Google LLC. Live Link Face is a product of Epic Games, Inc. Margo is not affiliated with them. The 52 names are Apple's published `ARFaceAnchor.BlendShapeLocation` identifiers.

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
