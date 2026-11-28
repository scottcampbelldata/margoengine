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

`checkSkin` reports what Unity, Unreal, Godot, Roblox and glTF validators reject or render wrongly: unweighted vertices, more than four influences, weights that don't sum to 1, negative or non-finite weights, joint indices outside the skin (in any slot, weighted or not), one joint in two weighted slots of a vertex (`duplicate-joint`; glTF 2.0 3.7.3.3 forbids both), and degenerate bones (each counted once) (a joint on its parent, or a non-invertible inverse bind matrix). `assertSkin` throws a `RangeError` naming each fault and its fix.

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
import { loadGLTF } from 'margoengine/gltf/pbr';
import { Animation } from 'margoengine/animation';
import { Animator } from 'margoengine/animator';
import { addIKChain, type AnimatorIKChain } from 'margoengine/rigging/ik';
import { detectSkeleton, humanoidBones } from 'margoengine/rigging/retarget';

const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, { backend: 'webgpu' });
const model = await loadGLTF(engine, '/character.glb');
const animator = Animator.attach(Animation.attach(model), { initial: 'idle', states: { idle: 'Idle' } });
// Bones by name: Mixamo (any mixamorig prefix), Godot, Roblox R15 or humanoid names, whichever the rig uses.
const names = model.asset.doc.nodes!.map((n) => n.name ?? '');
const bone = humanoidBones(names, detectSkeleton(names)?.preset ?? 'humanoid'); // humanoid bone -> node index
const reach: AnimatorIKChain = {
  joints: [bone.get('leftUpperArm')!, bone.get('leftLowerArm')!, bone.get('leftHand')!], // each the child of the one before
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

`keepBend` (default `true`) keeps an elbow or knee that is already bent more than 2 degrees on the side it is bent to, so a pole on the far side cannot fold it backward: the joint goes to the nearest place on its own side instead, with both bone lengths kept. Pass `keepBend: false` to let the pole fold a joint either way. `addIKChain` takes the same option. Every solve also turns each bone about its own length so its bend axis follows the new bend, so an elbow or knee changes only by a rotation about one axis fixed in the upper bone, as a real hinge does, and the skin never shows a forearm swung sideways (Tolani, Goswami and Badler, *Real-time inverse kinematics techniques for anthropomorphic limbs*, 2000):

```ts
import { solvePoseIK } from 'margoengine/rigging/ik';

const parents = [-1, 0, 1];
const local = new Float64Array([
  0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
  0, -0.3, 0, -0.0998, 0, 0, 0.995, 1, 1, 1, // the forearm starts bent forward
  0, -0.28, 0, 0, 0, 0, 1, 1, 1, 1,
]);
const result = solvePoseIK({ parents, local }, { joints: [0, 1, 2], target: [0, -0.5, 0], pole: [0, -0.3, 1] });
console.log(result.reached); // the elbow stays behind although the pole is in front
```

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

### IK on a fitted body: limbs that obey anatomy

Give a pose, a `Skeleton` or an Animator its fitted body (`body` on the pose or the chain, or `setAnatomy(owner, body)` of `margoengine/animator/ik` once) and every IK solve on it obeys the body's joint ranges. This is on by default wherever a body is present.

- An arm or a leg (a shoulder or hip, a hinge, an end) is solved in closed form by its swivel angle (Tolani, Goswami and Badler 2000). The elbow or knee turns only about its own axis, the anatomical way, between straight and its stop, so a straight limb bends the right way and never folds backwards.
- The pole only picks the limb's swivel inside the shoulder's or hip's reach and twist. With no pole, a limb that is bent in the pose keeps its side, and a straight one takes the swivel that leaves the shoulder or hip nearest neutral: elbow down, knee forward, whatever pose the rig rests in.
- A longer chain is solved by FABRIK and each joint is held to the nearest rotation in its range, a trunk or neck the chain runs along as a whole too. A chain that ends in an arm or a leg finishes with the closed-form limb.
- A target the ranges do not allow is approached as far as they allow, and the result says `held`.
- An arm or leg stays out of the rest of the body: the swivel is the nearest to the wanted one that keeps the limb's two capsules (the table's measured girths, the same volumes `checkPose` tests) clear of the trunk, the other thigh and the shanks, as it keeps the shoulder or hip in range. An arm reaching across the chest lifts its elbow forward instead of dropping it into the belly.
- An arm ends with a relaxed hand: the forearm at its anatomical zero (HAnim's neutral, palm toward the thigh when the arm hangs) and the hand at the body's neutral, whatever turn the playing clip held. `hand: 'keep'` keeps the pose's forearm and hand.

```ts
import type { RigJoint } from 'margoengine/rigging';
import { fitAnatomy, jointAngles } from 'margoengine/rigging/anatomy';
import { human } from 'margoengine/rigging/anatomy/human';
import { type IKPose, solvePoseIK } from 'margoengine/rigging/ik';

const rig: RigJoint[] = [
  { name: 'Hips', parent: -1, position: [0, 1, 0] },
  { name: 'Spine', parent: 0, position: [0, 1.1, 0] },
  { name: 'Head', parent: 1, position: [0, 1.6, 0] },
  { name: 'LeftUpLeg', parent: 0, position: [0.1, 0.95, 0] },
  { name: 'RightUpLeg', parent: 0, position: [-0.1, 0.95, 0] },
  { name: 'LeftArm', parent: 1, position: [0.2, 1.45, 0] },
  { name: 'LeftForeArm', parent: 5, position: [0.48, 1.45, 0] },
  { name: 'LeftHand', parent: 6, position: [0.74, 1.45, 0] },
];
const body = fitAnatomy(rig, { species: human });
// The left hand to a point in front of the chest. The pole sits above and behind the shoulder, where no elbow can
// point: the elbow goes as far that way as the shoulder allows and still bends forward.
const pose: IKPose = { parents: body.parents, local: body.rest.slice(), body };
const result = solvePoseIK(pose, { joints: [5, 6, 7], target: [0.25, 1.3, 0.35], pole: [0.2, 3, -3] });
console.log(result.reached, jointAngles(body, pose.local).l_elbow.flexion > 0); // true true
```

| Option | Default | What it does |
|---|---|---|
| `body` (chain or pose) | the body `setAnatomy` gave the pose, `Skeleton` or Animator, else none | The fitted body the chain obeys. |
| `limits` | `true` | `false` solves as if there were no body: FABRIK and the pole alone. |
| `soft` | `0` | Share of an arm's or leg's length (0 to 0.5) over which the reach eases in before full stretch, so an elbow or knee does not snap straight. At 0 the end meets every target in reach exactly. |
| `hand` | `'natural'` | On an arm: `natural` turns the forearm to its anatomical zero and leaves the hand at the body's neutral; `keep` keeps the pose's forearm twist and hand. |

`solvePoseIK`, `solveSkeletonIK` and `addIKChain` take these; `solveContactIK` takes `body` and reads its ranges as the default for `limits` (pass `body: null`, or your own `limits`, to leave the body out). `setAnatomy` and `anatomyOf` come from `margoengine/animator/ik`, which owns them with the limb solver `solveLimbIK`. Proof: `packages/rigging/tests/ik-anatomy.test.js` (10,000 reaches all around the body for an arm and for a leg, on T, A and arms-down rigs, rolled and mirrored: no hinge reversed, no joint past its stop), `ik-anatomy-animator.test.js`, `ik-reach-across.test.js` (an arm across the chest stays out of the trunk with its palm not up; without the volumes the same reach passes through it), the reach sheet `ik-reach-sheet.browser.mjs` (front, three-quarter and side, with the free solve beside it) and `ik-blender-check.mjs`, which has Blender's own bones and IK solver agree on which way flexion turns and on every hinge angle.

Two fits a Character Creator or Unreal body needs are read from the rig itself. The wrist's roll comes from the knuckle line of the index and middle fingers first (they are the fixed part of the hand's arch; the ring and little metacarpals move, Kapandji, *The Physiology of the Joints*, vol. 1), so a cupped hand at rest does not read as a twisted wrist. A forearm twist bone (a bone hanging under the forearm along it, as `CC_Base_L_ForearmTwist01` does) means the rig turns the hand itself for pronation and spreads the turn along the skin: the wrist's twist range then takes the forearm's pronation as well, and nothing spills into the forearm bone, which would twist the skin a second time.

Root motion and look-at / aim constraints live with the Animator: `addRootMotion`, `addLookAt` and `addAimConstraint` in [`@margoengine/animator`](../animator/README.md).

## Hand and foot contacts (`margoengine/rigging/contact`)

`solveContactIK` puts the point on the hand, shoe or hoof that actually touches the surface at a chosen position and orientation. The chain runs through the wrist, ankle or hoof. `anchor` is the palm, sole or other landmark in the final joint's own coordinates. Read `locked` before applying a grip pose or firing a contact sound. The solve measures the actual landmark after posing and returns its position, angular error and remaining gap. Approaching with `weight` below 1 blends the landmark and wrist toward the contact. A pole selects the bend side. Calibrate each limited joint's neutral rotation and axes from the rig. A hinge gives an elbow, knee or hock one bounded axis. A cone limits wrist or ball-joint swing and signed twist independently. Per-axis limits suit a joint with separate rotation controls.

```ts
import { solveContactIK } from 'margoengine/rigging/contact';

const parents = [-1, 0, 1];
const local = new Float64Array([
  0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
  0.3, 0, 0, 0, 0, 0, 1, 1, 1, 1,
  0.26, 0, 0, 0, 0, 0, 1, 1, 1, 1,
]);
const contact = solveContactIK({ parents, local }, {
  joints: [0, 1, 2],
  point: [0.46, 0.16 * Math.sqrt(3), 0],
  rotation: [0, 0, 0.5, Math.sqrt(3) / 2],
  anchor: [0.06, 0, 0],
  pole: [0.3, 0, 0],
  reach: 'hinged',
  limits: [
    { joint: 1, neutral: [0, 0, 0, 1], limit: { type: 'hinge', axis: [0, 0, 1], min: 0, max: 2.35 } },
    { joint: 2, neutral: [0, 0, 0, 1], limit: { type: 'cone', axis: [1, 0, 0], angle: 0.85, twist: [-0.35, 0.35] } },
  ],
  tolerance: 0.002,
});
console.log(contact.locked, contact.distance);
```

Pose and contact points use skeleton space and the same units. Ancestor scales must be uniform and positive. The end joint can have different positive scales along its axes. Default tolerances are 0.0001 scene units and 0.02 radians. Each solve uses up to 64 CCD sweeps by default. The chain can contain 2–256 joints inside a larger rig. `checkRig` accepts up to 65,536 joints, the number of joint indices representable by glTF unsigned shorts. A weight of 0 measures the input pose exactly. A gap or orientation outside either tolerance leaves `locked` false. Start from the sampled animation pose each frame so corrections cannot accumulate.

Use `reach: 'hinged'` with an explicit pole to keep the elbow or knee on one authored bend plane across samples.
The final three joints form the two links and the penultimate joint needs a hinge whose axis is perpendicular to
both links in its neutral pose. An optional hinge twist axis follows the lower link. Earlier joints carry the reach
and retain their sampled pose within their limits. Animate the pole smoothly off the reach axis. Unreachable goals
clamp to the calibrated reach, and a collision rejects the sample without choosing a different bend plane.
`PalmContactRig` accepts the same option on a target with calibrated elbow and `elbowPole`.

The contact landmark follows [*Footskate Cleanup for Motion Capture Editing*, Kovar, Gleicher and Schreiner (2002)](https://research.cs.wisc.edu/graphics/Papers/Gleicher/Mocap/cleanup.pdf). The chain solve uses the Animator's constrained CCD solver. [*Parametrization and Range of Motion of the Ball-and-Socket Joint*, Baerlocher and Boulic (2000)](https://infoscience.epfl.ch/bitstreams/949101d1-ec81-4e38-91d8-c414ee95c8fc/download) describes swing and twist boundaries. Position error is at the surface landmark because the joint origin and the surface point differ, as in the hand and foot annotations of [*CIMI4D*, Yan et al. (2023)](https://openaccess.thecvf.com/content/CVPR2023/papers/Yan_CIMI4D_A_Large_Multimodal_Climbing_Motion_Dataset_Under_Human-Scene_Interactions_CVPR_2023_paper.pdf).

### Human palm and cylindrical grips

`PalmContactRig` measures the palm and digits from the rig's bind pose, aligns a palm pad to a contact point and its
surface normal, and closes the fingers in proportion to the actual contact. Arm reach and finger closure are separate
inputs. While a reach is active, the contact layer owns the digits, including any earlier keyed grip. Closure eases to
zero when the palm is farther away or more misaligned than its tolerance. A reversed palm cannot engage the grip.
`addPalmContact` evaluates this same solve after the Animator's pose and earlier solvers.

```ts
import type { Animator } from 'margoengine/animator';
import { addPalmContact, type PalmContactTarget } from 'margoengine/rigging/contact';

export function attachRailGrip(animator: Animator, upperArm: number, elbow: number, wrist: number) {
  let target: PalmContactTarget | undefined;
  const dispose = addPalmContact(animator, {
    side: 'right',
    preset: 'mixamo',
    joints: [upperArm, elbow, wrist],
    elbow: { joint: elbow, flexDirection: [0, 0, 1] },
  }, () => target);
  return {
    reach(point: PalmContactTarget['point']) {
      target = { point, normal: [0, 0, 1], towardsFingers: [0, 1, 0], diameter: 0.035 };
    },
    release() { target = undefined; },
    dispose,
  };
}
```

Use node indices from the avatar and directions in its skeleton space. Supply a custom humanoid `bones` map for
an unfamiliar naming scheme. For offline posing, construct `new PalmContactRig(rig, calibration)` and call
`solve(sampledLocal, target)` once per sample. Both routes report the achieved position, distance, angle, contact
state and `gripWeight`. Resolve moving holds into model space at the sample time. Supply `close` to animate
release and `weight` to blend the reach. Return `undefined` to give control to the underlying animation.

Default registration tolerances are 3 mm on metre-scale rigs and 5 degrees. With elbow calibration, the forearm
bends about its measured flexion axis, defaults to −0.035 to 2.55 radians relative to bind and rolls ±1.25 radians
about its length. Use `roll: false` for a separately authored twist joint. The measured wrist defaults to 1.15
radians of swing and ±0.22 radians of axial twist. Use `limits` to set per-character bounds and `anchor` for a
measured palm-pad point in wrist-local coordinates. The default anchor starts at 56% of the wrist-to-middle-knuckle
distance. A forward thumb base can move it up to 88% to keep the bar away from the thumb web. The outward pad offset
is 8.5% of palm length. Cylindrical poses use the measured digit lengths and a diameter
above 0 and below 1 m. The solver measures palm registration, and per-digit skin collision requires its own
geometry and verification.

The grip model draws on [*The Computer Animation of Human Hand Grasping*, Rijpkema and Girard (1991)](https://doi.org/10.1145/127719.127748)
and [*Handrix*, ElKoura and Singh (2003)](https://doi.org/10.2312/SCA03/110-119).
The wrist also checks the angle between the forearm and the measured palm frame, with defaults of 1.12 radians
of flexion, 1.0 of extension, and 0.46 of sideways deviation. Calibrate these through `wrist` for the character
and action. A compatible custom constraint can take over this check with `wrist: false`. The cylindrical fit
uses the same diameter as the palm target. It chooses a pose for each digit from its measured lengths, fits the
thumb on the opposing side, and checks for proxy intersections from the open approach through six stages of
closure. The anchor's clearance from the thumb base leaves room to oppose and curl the thumb together.
A second search tests coupled thumb flexion along the same bar when a base turn alone leaves the joints rigid.
A hand with very short
digits or an oversized bar can still have a gap. Check the final deformed skin against the production geometry.

The independent forearm and wrist controls follow the distinct axes described in
[*From Skin to Skeleton*, Keller et al. (2023)](https://doi.org/10.1145/3618381) and
[*In Vivo Analysis of the Mechanical Axes of the Wrist During Dynamic Motion*, Crisco et al. (2011)](https://pmc.ncbi.nlm.nih.gov/articles/PMC3016043/).
The functional ranges measured by [Ryu, Cooney, Askew, An and Chao (1991)](https://pubmed.ncbi.nlm.nih.gov/1861019/)
guide the additional pose check. The opposing thumb follows the grip observations in
[*The GRASP Taxonomy of Human Grasp Types*, Feix et al. (2016)](https://www.eng.yale.edu/grablab/pubs/Feix_THMS2016.pdf)
and [*In Vivo Kinematics of the Thumb Carpometacarpal Joint During Three Isometric Functional Tasks*, Halilaj et al. (2014)](https://pmc.ncbi.nlm.nih.gov/articles/PMC3940759/).
These are rig-space defaults that can be calibrated to the actor's proportions, bind orientation and authored controls.

### Character self-collision during contact

`LimbCollisionRig` attaches capsules and spheres to a human or animal skeleton. Configure a chain of limb links,
the body volumes it can hit, and optional joint directions relative to bones such as the chest or pelvis. Capsule
radii are in skeleton units. Measure them with clothing or fur included, then trim shared segments at the shoulder
or hip to allow the intended attachment. The same API works for a quadruped foreleg, a wing, or a tail when given
the corresponding landmarks and joint slots.

```ts
import { LimbCollisionRig, type PalmContactTarget } from 'margoengine/rigging/contact';

export function guardReach(parents: readonly number[], lowerSpine: number, chest: number) {
  const guard = new LimbCollisionRig(parents, [
    { start: { joint: lowerSpine }, end: { joint: chest }, radius: 0.12 },
  ], [
    { start: 0, end: 1, radius: 0.04, range: [0.35, 1] },
    { start: 1, end: 2, radius: 0.035 },
  ], [
    { start: 0, end: 1, reference: chest, forward: [0, 0, 1] },
  ]);
  return (local: Float64Array, target: PalmContactTarget): PalmContactTarget => {
    guard.setBodyPose(local);
    return { ...target, clearance: guard.clearance };
  };
}
```

Pass the resulting target to `PalmContactRig.solve` with the same three chain slots ordered shoulder, elbow and
wrist. `solveContactIK` also accepts the clearance callback. Negative values reject the candidate. The solver
tries alternate elbow directions when the preferred pose is blocked, and leaves the input arm pose in place if it
finds no clear solution. Check `blocked` and choose a reachable hold or a safe fallback pose. The result's `clearance`
combines proxy separation and the margin to the configured joint directions and wrist range.

Use `snapshot` for the accepted limb at two consecutive poses and `sweep` to test the intervening proxy motion
and direction limits. Capsule endpoints and the vectors between the configured limb joints are linearly
interpolated. Each reference axis follows a short spherical arc as the torso turns. Include intermediate poses for curved joint motion or opposite reference
axes. A sweep that cannot certify clearance returns `clear: false` and `exhausted: true`. Legacy snapshots without
the direction channel still check capsule motion. Use the same snapshot format at both ends.

```ts
import { LimbCollisionRig } from 'margoengine/rigging/contact';

export function checkShoulderTravel(before: number[], after: number[]) {
  const guard = new LimbCollisionRig(
    [-1],
    [{ start: { joint: 0 }, radius: 0.16 }],
    [{ start: 0, end: 1, radius: 0.04 }],
    [{ start: 0, end: 1, reference: 0, forward: [0, 0, 1] }],
  );
  guard.setBodyPose([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
  return guard.sweep(guard.snapshot(before), guard.snapshot(after));
}
```

The alternate elbow search draws on [*Real-Time Inverse Kinematics Techniques for Anthropomorphic Limbs*, Tolani,
Goswami and Badler (2000)](https://www.ambarish.com/paper/Tolani_Goswami_Badler_IK.pdf) and [*Analytical Inverse
Kinematics with Body Posture Control*, Kallmann (2008)](https://mkallmann.github.io/papers/08-cavw-bodyik.pdf).
The explicit-pole mode uses the analytical elbow circle described by Tolani, Goswami and Badler. Keeping the bend
plane on a continuous authored curve follows the use of smooth pose corrections in [*A Hierarchical Approach to
Interactive Motion Editing for Human-like Figures*, Jehee Lee and Sung Yong Shin (1999)](https://doi.org/10.1145/311535.311539).
Capsule gaps use the segment-distance construction in [*On Fast Computation of Distance Between Line Segments*,
Lumelsky (1985)](https://doi.org/10.1016/0020-0190(85)90032-8). The continuous check adapts conservative advancement
to straight proxy paths, following [*Fast Continuous Collision Detection for Articulated Models*, Redon, Lin and
Manocha (2004)](https://diglib.eg.org/items/13aac165-e652-4c78-a0a6-0b42305f0753).
The direction limit uses a body-relative axis, as in [*Parametrization and Range of Motion of the Ball-and-Socket
Joint*, Paolo Baerlocher and Ronan Boulic (2000)](https://infoscience.epfl.ch/bitstreams/949101d1-ec81-4e38-91d8-c414ee95c8fc/download).
The sweep uses the angular speed of that axis and the linear speed of the limb vector
to bound gap changes. See [*Animating Rotation with Quaternion Curves*, Ken Shoemake (1985)](https://doi.org/10.1145/325334.325242)
for spherical interpolation and [*Continuous Collision Detection for Articulated Models Using Taylor Models
and Temporal Culling*, Zhang, Redon, Lee and Kim (2007)](https://doi.org/10.1145/1239451.1239466) for
angular motion bounds in conservative advancement.

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

On a character, joints and collider nodes are glTF node indices; find them by name:

```ts
import {Engine} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf/pbr';
import {Animation} from 'margoengine/animation';
import {Animator} from 'margoengine/animator';
import { detectSkeleton, humanoidBones } from 'margoengine/rigging/retarget';
import { addSpringBones } from 'margoengine/rigging/springs';
const engine = await Engine.create(document.querySelector('canvas')!);
const model = await loadGLTF(engine, '/character.glb');
const animator = Animator.attach(Animation.attach(model), {initial: 'walk', states: {walk: 'Walk'}});
const names = model.asset.doc.nodes!.map((n) => n.name ?? '');
const bone = humanoidBones(names, detectSkeleton(names)?.preset ?? 'humanoid'); // head, chest and the rest
const node = (name: string) => names.indexOf(name); // the model's own extra bones
const head = bone.get('head')!;
const hair = addSpringBones(animator, {
  chains: [
    { joints: [node('Hair1'), node('Hair2'), node('Hair3')], stiffness: 1.5, drag: 0.4, gravity: 0.3, center: head }, // measured against the head
    { joints: [node('LeftEarring')], tail: [0, -0.06, 0], stiffness: 0.8 }, // an earring: one joint and an end point
  ],
  colliders: [{ node: head, radius: 0.09 }, { node: bone.get('upperChest')!, tail: [0, 0.3, 0], radius: 0.12 }],
  jiggles: [{ joint: node('Belly'), frequency: 3, damping: 0.3, limit: 0.03 }], // lags and wobbles in place
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
| `joint` | required | The bone. Its position trails the animated one on a damped spring, solved exactly each step (stable at any frequency and damping); steady motion leaves no lag. |
| `frequency` | `4` | Wobbles a second, up to 15. |
| `damping` | `0.35` | Share of critical damping: 1 stops without a wobble. |
| `limit` | `0.05` | Farthest the bone strays from its animated position. |
| `amount` | `1` | Share of the movement shown. |

A model scaled up swings the same, only larger: forces, `radius`, collider radii and `limit` follow the bones' world scale. Joints and their ancestors need positive scales; a scale a little off uniform, as exported rigs often have, reads as its mean. A `delta` of 0 holds the motion, and a long frame takes at most 8 steps of 1/60 s, so a stall slows the swing and cannot blow it up. Spring bones run after other solvers in the order they were added.

## VRM avatars (`margoengine/rigging/vrm`)

VRM 1.0 avatars from any tool that writes them. `readVRM` takes a `.vrm` file's bytes and gives the avatar's data; `addVRM` puts it to work on the model: the 18 preset expressions and any custom ones, the look-at, the spring bones and a mouth and blink channel for your own lip sync. `writeVRM` puts an avatar back into a `.vrm`, and `createVRM` makes one from any rigged glTF.

```ts
import { loadGLTF } from 'margoengine/gltf/pbr';
import { Animation } from 'margoengine/animation';
import { addVRM, readVRM } from 'margoengine/rigging/vrm';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
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
import { splitGLB } from 'margoengine/exporters';
import { detectSkeleton, humanoidBones } from 'margoengine/rigging/retarget';
import { createVRM, readVRM, writeVRM } from 'margoengine/rigging/vrm';
const rigged = new Uint8Array(await (await fetch('/rigged.glb')).arrayBuffer()); // any .glb with a skin
const { json } = splitGLB(rigged);
const nodes = json.nodes as { name?: string; mesh?: number }[],
  meshes = json.meshes as { extras?: { targetNames?: string[] } }[];
const names = nodes.map((n) => n.name ?? '');
const face = names.indexOf('Face'); // the node of the mesh with the face shapes
const blink = meshes[nodes[face].mesh!].extras?.targetNames?.indexOf('eyeBlinkLeft') ?? -1;
const out = writeVRM(
  rigged,
  createVRM({
    name: 'Scout',
    authors: ['Sam'],
    bones: humanoidBones(names, detectSkeleton(names)?.preset ?? 'humanoid'), // every humanoid bone the names give
    expressions: { preset: { blink: { morphTargetBinds: [{ node: face, index: blink, weight: 1 }] } } },
  }),
); // a .vrm
console.log(readVRM(out).humanoid.humanBones.head?.node === names.indexOf('mixamorig:Head')); // true for a Mixamo rig
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

With `MToon` from `@margoengine/rigging/mtoon` attached, MToon UV animation is computed in float64 and sent as small phases, so a scrolling or turning texture keeps its 1/60 s steps after days of running; [details and limits](../../docs/rigging-mtoon.md).

## VRM first person (`margoengine/rigging/vrm-first-person`)

A VRM 1.0 file says which meshes the wearer sees through their own eyes (`firstPerson.meshAnnotations`): `thirdPersonOnly` meshes (the head, the hair) stay out of the first-person view, `firstPersonOnly` meshes appear only in it, `both` show everywhere, and `auto` (also a mesh with no annotation) means "cut the head off for me". `loadVRM` makes that cut before the model loads: each `auto` skinned mesh is split into the triangles weighted to the head bone or a bone below it, drawn in third person only, and the rest. `addVRMFirstPerson` then puts each mesh on a render layer and gives you the two view masks, so every camera, mirror, probe and XR eye filters the avatar the way the file asks.

```ts
import { Engine } from 'margoengine/core';
import { Reflector } from 'margoengine/environment/reflector';
import { addVRMFirstPerson, loadVRM } from 'margoengine/rigging/vrm-first-person';
const engine = await Engine.create(document.querySelector('canvas')!);
const model = await loadVRM(engine, 'Seed-san.vrm'); // `auto` meshes come back split into head and body
const fp = addVRMFirstPerson(model, { firstPersonCameras: [engine.camera] }); // this camera looks through the eyes
engine.render({ delta: 0 }); // world matrices, so viewpoint() reads the posed head
const eye = fp.viewpoint();
engine.camera.position = eye;
engine.camera.target = [eye[0], eye[1], eye[2] + 1]; // a VRM 1.0 avatar faces +Z
const mirror = Reflector.attach(engine, { width: 2, height: 2, layers: fp.thirdPersonLayers }); // the mirror shows the head
mirror.node.setPosition([0, eye[1], 1]).setRotation([0, Math.PI, 0]);
engine.start();
// In a headset: xr.layers = fp.firstPersonLayers (margoengine/xr) hides the head in both eyes.
```

| Name | Meaning |
| --- | --- |
| `loadVRM(engine, url or bytes, options)` | Fetches (at most `maxDownloadBytes`, 64 MiB by default), splits and loads a VRM 1.0 file as a gltf/pbr `PBRModel`. Takes gltf/pbr's load options, `threshold` and `signal`. For VRM 0.x, run `convertVRM0Bytes` from `margoengine/rigging/vrm0` first. |
| `splitVRMFirstPerson(glb, options)` | The split alone, bytes in and bytes out: no `auto` left, every other byte of the file kept. A second split changes nothing. |
| `addVRMFirstPerson(model, options)` | Applies the annotations through render layers and returns the handle below. Throws a coded `state` error when a mesh is still `auto` (load it with `loadVRM`). |
| `fp.firstPersonLayers`, `fp.thirdPersonLayers` | View masks: every layer but the third-person one, and every layer but the first-person one. Give the second to any mirror, probe or outside camera. |
| `fp.viewpoint(out?)` | World position of the eyes: `lookAt.offsetFromHeadBone` on the head bone. |
| `fp.meshAnnotations` | Each mesh node and the type it resolved to. |
| `fp.dispose()` | Puts every mask back as it was (also `using`). |

| Option | Default | Meaning |
| --- | --- | --- |
| `threshold` (`loadVRM`, `splitVRMFirstPerson`) | `0` | Skin weight a vertex must pass on the head to count as head. 0 is the specification's rule; raise it when a stray head weight pulls collar triangles out of first person. |
| `firstPersonOnlyLayer`, `thirdPersonOnlyLayer` | `29`, `30` | The layers the two kinds of mesh go on (`FIRST_PERSON_ONLY_LAYER`, `THIRD_PERSON_ONLY_LAYER`). |
| `firstPersonCameras` | none | Cameras that get `firstPersonLayers`. |
| `thirdPersonCameras` | the engine camera | Cameras that get `thirdPersonLayers`, only when the file has a `firstPersonOnly` mesh. |

A camera, mirror or probe with no mask draws every layer, so it shows `firstPersonOnly` meshes until you give it `fp.thirdPersonLayers`. Shadows are not filtered: the avatar casts its whole shadow, head included, in every view, which is what you want when you look down at your own shadow. Draco and meshopt compressed meshes are read through `margoengine/decoders`, loaded only for a file that needs them. Limits and the measured GPU checks: [VRM first person](../../docs/rigging-vrm-first-person.md).

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

## Automatic rig (`margoengine/rigging/autorig`)

Places a humanoid skeleton inside a mesh nobody rigged, then weights it. Give it a figure standing in a T or A pose, in any units, turned any way about `up`; the mesh may be broken or in many parts. Joints carry VRM humanoid names, so `margoengine/rigging/retarget` reads them as they are, and `joints` and `weights` go straight to `margoengine/exporters/skin`. The shoulder fit uses the upper-arm cross-section to keep each shoulder beside the chest on figures with thick upper arms. Here the figure is made of boxes, so the example runs by itself:

```ts
import { autoRig } from 'margoengine/rigging/autorig';

const positions: number[] = [];
const indices: number[] = [];
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
  const first = positions.length / 3;
  for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) positions.push(x, y, z);
  for (const [a, b, c, d] of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]])
    indices.push(first + a, first + b, first + c, first + a, first + c, first + d);
};
box(-0.17, 0.85, -0.1, 0.17, 1.42, 0.1); // trunk
box(-0.06, 1.4, -0.05, 0.06, 1.5, 0.05); // neck
box(-0.1, 1.48, -0.1, 0.1, 1.74, 0.1); // head
for (const side of [-1, 1]) {
  box(side * 0.1 - 0.06, 0.05, -0.06, side * 0.1 + 0.06, 0.9, 0.06); // leg
  box(side * 0.1 - 0.06, 0, -0.06, side * 0.1 + 0.06, 0.08, 0.2); // foot
  const [near, far] = [side * 0.15, side * 0.85].sort((p, q) => p - q);
  box(near, 1.32, -0.04, far, 1.4, 0.04); // arm
}

const rig = await autoRig({ positions, indices });
console.log(rig.joints[rig.humanoid.leftHand].position, rig.forward); // on +x, facing +z
console.log(rig.weights?.toInfluences()); // JOINTS_0 and WEIGHTS_0
```

| Option | Default | Meaning |
| --- | --- | --- |
| `resolution` | `128` | Voxels along the longest side, 32 to 384. Thin arms need more. |
| `up` | `[0, 1, 0]` | The mesh's up direction. |
| `forward` | read from the feet | The way the figure faces, which says which side is its left. A forward along `up` is a `RangeError`. |
| `closing` | `1` | Closes gaps up to this many voxels before filling, joining parts that nearly touch. |
| `symmetric` | `true` | Evens left and right joints across the body's centre when they already nearly agree. |
| `weights` | `'voxel'` | `'voxel'` weights with `voxelWeights`; with `'none'`, pass `joints` to `boneHeatWeights` or any other solver. |
| `weld` | `1e-6` | Welding tolerance as a fraction of the mesh's size. |
| `signal` | none | Cancels the fit between stages and the weights between bones. |

The result gives `joints`, `humanoid` (each bone's index, by name), `pose` (the same skeleton as local transforms), `weights`, `forward`, `facingFound` and `voxels`. When `facingFound` is false the feet showed no clear front, +z was assumed and left and right may be swapped: pass `forward`. A figure with no head, two feet and two hands to find fails with a `MargoError` of code `failed`. Fingers are not placed. On real files the joints land about 2 to 4 percent of the figure's height from where people put them; the limits are in [docs/limits.md](../../docs/limits.md).

## Corrective shapes (`margoengine/rigging/correctives`)

Linear skinning collapses elbows, knees and shoulders. A corrective is a blend shape sculpted to fix that, and this entry drives it from the joint's rotation: full at the pose you sculpted it for, off at rest. `addCorrectives` runs after the pose and after any IK added before it.

```ts
import {Engine} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf/pbr';
import {Animation} from 'margoengine/animation';
import {Animator} from 'margoengine/animator';
import { addCorrectives } from 'margoengine/rigging/correctives';
import { detectSkeleton, humanoidBones } from 'margoengine/rigging/retarget';
const engine = await Engine.create(document.querySelector('canvas')!);
const model = await loadGLTF(engine, '/character.glb');
const animator = Animator.attach(Animation.attach(model), {initial: 'walk', states: {walk: 'Walk'}});
// The mesh node, its sculpted morph target and the elbow joint, all by name.
const doc = model.asset.doc,
  names = doc.nodes!.map((n) => n.name ?? '');
const body = names.indexOf('Body');
const target = (doc.meshes![doc.nodes![body].mesh!].extras as { targetNames: string[] }).targetNames.indexOf('LeftElbowFix');
const joint = humanoidBones(names, detectSkeleton(names)?.preset ?? 'humanoid').get('leftLowerArm')!;
const s = Math.sin(1);
const elbow = addCorrectives(animator, {
  shapes: [{ node: body, target, joint, pose: [s, 0, 0, Math.cos(1)], curve: 'smooth' }], // full at two radians
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
| `iterations` | `1000` | Most conjugate-gradient steps of the fill per bone; it stops once the harmonic system's residual is 1e-10 of where it started. |
| `threshold` | `1e-4` | Weights below this are dropped before renormalising. |
| `boneCount` | the source's | Bones in the result, for influences that do not use the last ones. |
| `weld` | `1e-6` | Welding tolerance of the target as a fraction of its size. |
| `signal` | none | Cancels the transfer. |

`matched` and `filled` count target points. A part of the target with no match at all, such as a hat clear of the head, keeps the closest weights as they are.

## Face tracking (`margoengine/rigging/face`)

Puts a tracked face on a character. Face trackers report the same 52 values from 0 to 1, one per facial movement: Apple's ARKit, Google's MediaPipe Face Landmarker and Live Link Face all do. `addFace` reads a frame in any of their shapes, smooths it and drives the model's morph targets, found by name, or a VRM avatar's expressions.

```ts
import { loadGLTF } from 'margoengine/gltf/pbr';
import { Animation } from 'margoengine/animation';
import { addFace } from 'margoengine/rigging/face';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
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
import { addVRM, readVRM } from 'margoengine/rigging/vrm';
import { Animation } from 'margoengine/animation';
import { loadGLTF } from 'margoengine/gltf/pbr';
import { Engine } from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const url = '/avatar.vrm';
const animation = Animation.attach(await loadGLTF(engine, url));
const avatar = addVRM(animation, readVRM(new Uint8Array(await (await fetch(url)).arrayBuffer())));
const byName = addFace(animation, { map: { jawOpen: 'Mouth_Open', eyeBlinkLeft: ['Blink_L', 'Lash_L'] } });
byName.dispose(); // one face per model: dispose it before adding another
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

`FaceMapper` is the same thing as plain data, with no engine: `push(frame)`, `update(delta)`, `get(shape)`, `values`. `vrmFaceExpressions(get)` gives the VRM presets: what both eyes share goes to `blink` and the rest to `blinkLeft` and `blinkRight`, the eyes' mean to the look presets, `jawOpen`, `mouthPucker`, `mouthFunnel`, the mouth's lower lip and stretch to `aa`, `ou`, `oh`, `ih`, `ee`, and smile, frown, brow and wide eyes to `happy`, `sad`, `angry` and `surprised`. No tracker value stands for `relaxed`. A driven morph target belongs to the face: a clip's track on it is overwritten. A model has one face at a time: a second `addFace` throws `MargoError` code `state` until the first is disposed.

ARKit is a trademark of Apple Inc. MediaPipe is a trademark of Google LLC. Live Link Face is a product of Epic Games, Inc. Margo is not affiliated with them. The 52 names are Apple's published `ARFaceAnchor.BlendShapeLocation` identifiers.

## Retarget presets (`margoengine/rigging/retarget`)

Clips made for one skeleton play on another: `prepareRetarget(source, target)` recognises each rig's naming (Mixamo with any `mixamorig` prefix, Godot's humanoid profile, Roblox R15, MPFB (MakeHuman's default rig), Character Creator's CC3+ skeleton (`CC_Base_Hip`, `CC_Base_L_Upperarm`, ...; its twist and share bones stay at rest and follow their limb through the skin), the joints of `@margoengine/exporters/skin`'s `humanoidJoints()`, or the 55 humanoid bone names themselves), maps every target bone to its source bone, and by default turns the target's reference pose so each bone points the way the source's does at rest (an A-pose character driven by T-pose clips). Pass the result to `@margoengine/animation`'s `Retarget`:

```ts
import { Animation, applyKeyframeClip } from 'margoengine/animation';
import { Retarget, retargetRig } from 'margoengine/animation/skeleton-utils';
import { createStage } from 'margoengine';
import { loadGLTF } from 'margoengine/gltf/pbr';
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
| `from` | detected | The source's naming: `mixamo`, `godot`, `roblox`, `margo`, `mpfb`, `characterCreator`, `cmu` (CMU motion capture, as `@margoengine/loaders/mocap` `parseASF` names its joints) or `humanoid`. |
| `to` | detected | The target's naming. |
| `alignRest` | `true` | Turn the target's limbs (arms, hands, fingers, legs, feet) to point as the source's do at rest, so a T-pose source drives an A-pose target. The trunk, neck and collarbones keep the target's own rest: their directions are body layout, and aiming them along a motion-capture skeleton's would hunch and shrug the target. `false` keeps the target's whole rest pose (both rigs already stand alike). |

Rest alignment matches palm roll when both rigs map the wrist and the bases of the middle, index and little fingers. The wrist-to-middle direction sets the aim, and the direction across the knuckles sets the roll about that aim. With missing or collinear landmarks, the wrist uses the aim alone. This uses the humanoid landmarks from [VRM 1.0](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/humanoid.md) and draws on the use of anatomical frames in [*Semantics2Hands*, Ye et al. (2023)](https://arxiv.org/abs/2308.05920). Rest alignment prepares the skeleton for motion transfer. Maintaining hand or foot contact with a surface during a clip requires a separate constraint, as described in [*Retargeting Motion to New Characters*, Gleicher (1998)](https://graphics.cs.wisc.edu/Papers/1998/Gle98/).

A source hand with no finger bones below it, such as a BVH wrist that ends in an End Site (Xsens, the 100STYLE captures) or an ASF hand segment, is one rigid segment. Rest alignment then lays the target's hand and its index, middle, ring and little finger bones straight along that segment, in line with the source forearm when the source has no finger base, and lists the unmapped ones it turned in `prepared.hold`. `Retarget` reads `hold` and keeps those bones at the aligned rest, so they stop holding the target's own bind pose, which for most authored characters is a fanned, curled hand. Thumbs keep the target's rest. A source with one finger segment (CMU's `lfingers`, mapped to the middle finger) drives all four long fingers. This is the intermediate-skeleton idea of [Monzani, Baerlocher, Boulic and Thalmann (2000), *Using an Intermediate Skeleton and Inverse Kinematics for Motion Retargeting*](https://doi.org/10.1111/1467-8659.00393): a target bone the source does not have takes its rest from the source segment that holds it.

```js
import { prepareRetarget } from 'margoengine/rigging/retarget';

const fingerless = { names: ['hips', 'leftLowerArm', 'leftHand'], parents: [-1, 0, 1], rest: Float64Array.from([0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0.3, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0.26, 0, 0, 0, 0, 0, 1, 1, 1, 1]) };
const fingered = { names: ['hips', 'leftLowerArm', 'leftHand', 'leftIndexProximal', 'leftIndexIntermediate'], parents: [-1, 0, 1, 2, 3], rest: Float64Array.from([0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0.3, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0.26, 0, 0, 0, 0, 0.6, 0.8, 1, 1, 1, 0.09, 0, 0.02, 0, 0, 0, 1, 1, 1, 1, 0.03, 0, 0, 0, 0, 0, 1, 1, 1, 1]) };
const { hold } = prepareRetarget(fingerless, fingered, { from: 'humanoid', to: 'humanoid' });
console.log(hold); // ['leftIndexProximal']: the index finger now rests straight along the hand
```

Target bones with no source bone (a Godot `Root`, Roblox's `HumanoidRootPart`, fingers a source lacks) map to `''` and stay at rest; the humanoid bones among them are listed in `unmapped`. Roblox R15 has no neck, shoulders, toes or fingers, so clips from it leave those at rest; its `UpperTorso` maps to `spine`, which VRM 1.0 requires (chest is optional). Both rigs' model spaces must face the same way (glTF: +z forward, the figure's left at +x). `humanoidBones(names, preset)` gives the humanoid bone -> index map for your own tools, and `HUMANOID_BONES` lists every humanoid bone, parents first. An unrecognised naming throws a `RangeError` that asks for `from` or `to`.

## Hands (`margoengine/rigging/hands`)

Named hand poses and a per-hand layer on an `@margoengine/animator` Animator. Body clips often carry flat or no finger
tracks, which read as dead hands; `addHands` blends a relaxed rest pose into every clip whose finger tracks stay under
15 degrees on average, cross-faded with the Animator's own transitions, and leaves clips that key their fingers alone.
Each hand also takes keyed poses over time: `relaxed()`, `fist()`, `flat()`, `point()`, `pinch()`, `grip(diameter)`
(a power grip solved for a bar of that diameter in metres) or `handPose(table)` with your own joint angles. The
fingers are found through the retarget presets: Mixamo, VRM, MPFB (MakeHuman), Godot and the humanoid names.

```ts
import { Animation } from 'margoengine/animation';
import { Animator } from 'margoengine/animator';
import { createStage } from 'margoengine';
import { loadGLTF } from 'margoengine/gltf/pbr';
import { addHands, grip, relaxed } from 'margoengine/rigging/hands';
const stage = await createStage('#viewport', { backend: 'webgpu' });
const model = await loadGLTF(stage.engine, '/mixamo-walk.glb');
const animator = Animator.attach(Animation.attach(model), { initial: 'walk', states: { walk: 'Walk' } });
const hands = addHands(animator); // relaxed fingers on every clip with flat finger tracks
console.log(hands.flat.left); // the clips whose flat fingers get the relaxed pose
hands.right.set(grip(0.035), { blend: 0.3 }); // close the right hand on a 35 mm rail over 0.3 s
hands.right.set(relaxed()); // and open it again later
hands.dispose(); // the clips play as authored again
```

| Option | Default | What it does |
| --- | --- | --- |
| `left`, `right` | null | A pose each hand takes from the start; null leaves the hand to the clip (and the relaxed default). |
| `auto` | true | Blend `rest` into clips whose finger tracks stay under `threshold`. |
| `threshold` | 15 | Mean finger turn from rest, degrees, under which a clip counts as having flat fingers. |
| `rest` | `relaxed()` | The pose `auto` blends in. |
| `preset`, `bones` | detected | The rig's naming, or your own humanoid bone map, when detection cannot tell. |

`hands.left.keys` and `hands.right.keys` are plain `{time, pose, blend, weight}` lists, so a film can write them ahead
of time; with `hands.time` set the hands are a pure function of time and a seek gives what playing gives. A key with
`pose: null` hands the hand back to the clip over its blend. A digit a pose leaves out (the relaxed pose leaves out the
thumb, which a bind pose splays away from the palm) keeps the clip's own rotation and fades back to it.

The poses follow the grasp literature: fingers close joint by joint until they meet the bar, the tip joint at 2/3 of
the middle one (Rijpkema and Girard 1991), flexion grows from the index to the little finger (Santello, Flanders and
Soechting 1998), the grip and rest classes of Feix et al. 2016, and the rest posture's ranges after Wheatland et al.
2015. Without the engine, `measureHands(rig)`, `poseTable(pose, hand)`, `handRotations(hand, table)` and
`gripFinger(lengths, diameter)` give the same numbers as plain data:

```ts
import { gripFinger } from 'margoengine/rigging/hands';
const index = gripFinger([0.045, 0.026, 0.019], 0.035); // phalanx lengths in metres, a 35 mm bar
console.log(index.flex.map(Math.round), index.tipGap < 0.0005); // joint angles in degrees; the tip meets the bar
```

## Joint-space limits (`margoengine/rigging/joint-limits`)

Calibrate a hinge or swing-and-twist cone in the joint's local frame. `PoseJointLimits` projects packed local TRS
samples in place and preserves translations and scales. Use it after clip blending, or install the same projection as a
final Animator solver with `addPoseJointLimits(animator, limits)`. `redistributeJointTwist` can move excessive axial
rotation from a joint to its parent while preserving that joint's attachment and world orientation.

```ts
import { PoseJointLimits } from 'margoengine/rigging/joint-limits';
const elbowPose = new Float64Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
const limit = new PoseJointLimits(1, [
  { joint: 0, neutral: [0, 0, 0, 1], limit: { type: 'hinge', axis: [0, 0, 1], min: 0, max: 2.35 } },
]);
limit.apply(elbowPose);
console.log(elbowPose[6]);
```

Author these axes for the skeleton's bind pose. For human limbs, the limits are per-rig constraints on permitted
motion rather than an estimate of anatomy from a bone name. See [Akhter and Black, Pose-Conditioned Joint Angle
Limits for 3D Human Pose Reconstruction (2015)](https://openaccess.thecvf.com/content_cvpr_2015/html/Akhter_Pose-Conditioned_Joint_Angle_2015_CVPR_paper.html)
and [Crisco et al., The Mechanical Axes of the Wrist Are Oriented Obliquely to the Anatomical Axes (2011)](https://pmc.ncbi.nlm.nih.gov/articles/PMC3016043/).

## Anatomy: the body every solver reads (`margoengine/rigging/anatomy`)

`fitAnatomy(rig, { species })` gives a rig a body: which bone is which joint, which way each joint bends, how far, and
where each number comes from. Every joint's frame is built from landmarks (the rig's joint positions and the way its
feet point), never from bone axes or the rest pose. So a T pose, an A pose and an arms-down pose of one body, with any
bone roll, read the same clinical angles, and a straight elbow or knee still knows which way it bends. Limits are on by
default; `limits: false` turns them off by name.

The human table is its own entry, `margoengine/rigging/anatomy/human`, so a scene of horses ships no human numbers.
Any species uses the same table format through `defineSpecies`.

```ts
import type { RigJoint } from 'margoengine/rigging';
import { type ClampIssue, clampPose, fitAnatomy, jointAngles, poseFromAngles } from 'margoengine/rigging/anatomy';
import { human } from 'margoengine/rigging/anatomy/human';

// Any rig, as joint positions or as { names, parents, rest }. Bones are found by name: Mixamo style here.
const rig: RigJoint[] = [
  { name: 'Hips', parent: -1, position: [0, 1, 0] },
  { name: 'Spine', parent: 0, position: [0, 1.1, 0] },
  { name: 'Head', parent: 1, position: [0, 1.6, 0] },
  { name: 'LeftUpLeg', parent: 0, position: [0.1, 0.95, 0] },
  { name: 'RightUpLeg', parent: 0, position: [-0.1, 0.95, 0] },
  { name: 'LeftArm', parent: 1, position: [0.2, 1.45, 0] },
  { name: 'LeftForeArm', parent: 5, position: [0.48, 1.45, 0] },
  { name: 'LeftHand', parent: 6, position: [0.74, 1.45, 0] },
];
const body = fitAnatomy(rig, { species: human });
console.log(body.preset, body.restPose); // segments T

// A pose with the elbow folded 30 degrees the wrong way is brought back to the stop, and says so.
const pose = poseFromAngles(body, { l_elbow: { flexion: -30 } });
const issues: ClampIssue[] = [];
clampPose(body, pose, { issues });
console.log(issues[0].joint, issues[0].motion, Math.round(issues[0].limit)); // l_elbow hyperextension -5
console.log(jointAngles(body, pose).l_elbow.flexion.toFixed(1)); // -5.0
```

What the entry gives:

| Function | What it does |
| --- | --- |
| `fitAnatomy(rig, { species, preset?, map?, limits?, forward?, roll? })` | The `AnatomicalRig`: body frame, stature, rest pose (`T`, `A`, `arms-down`), and per joint its bone, kind, anatomical axes in the bone's own frame, neutral rotation, rest angles and ranges. |
| `jointAngles(body, pose)`, `readJointAngles(body, pose, out)` | Clinical angles in degrees per joint: the two parts of the swing (flexion and abduction for most joints) and the twist. The second form fills a flat array and allocates nothing. |
| `poseFromAngles(body, angles, base?)` | The pose that has those angles: the inverse. |
| `regionAngles(body, pose)` | The head against the chest and the chest against the pelvis, whatever number of spine bones the rig has. |
| `clampPose(body, pose, { tier?, issues? })` | Brings a pose inside the ranges, in place, and reports each motion it changed with its limit and source. |
| `addAnatomyLimits(animator, body, { tier?, onClamp? })` | The same every frame on an Animator. |
| `hingeRolls(body, poses)` | Reads from motion how a straight limb is rolled, to fit again with `roll`. |
| `poseLimits`, `ikLimits`, `ragdollJoints`, `kinematicsLimits` | The limits in the forms `PoseJointLimits`, IK chains, ragdoll profiles and `JointLimitSet` take. |
| `defineSpecies(table)`, `bound(allowance, ...rows)`, `mirrorJoint(spec, rename)` | Build and check a species table. |

How angles are measured. The body frame is x to the body's left, y up, z forward. Each joint has a long axis (its
segment at neutral) and three motions: two swings across it and the twist about it. The swing is read as one rotation
vector whose two parts are the clinical angles, so flexion and abduction are exact for a single-plane motion and stay
well defined up to 180 degrees; the twist is what is left about the segment. Neutral for a human is the standing pose
of ISO/IEC 19774 (HAnim): arms down, palms to the thighs. A shoulder and a hip are measured from that pose in the
trunk's frame, an elbow, knee, wrist or finger joint from its straight position, and a collarbone, spine joint, ankle
or toe from the rig's own rest pose.

Two tiers. `normal` is the clinical range, where a validator should warn. `structural` is the stop no body passes,
and what `clampPose` holds by default: an elbow or a knee stops 5 degrees past straight. A swing range that differs by
direction (a shoulder reaches 180 degrees forward and 75 back) is an ellipse per quadrant, and a pose outside goes to
the nearest point of it, so a bent knee with sideways noise keeps its bend. A straight knee does not twist: its
rotation opens with flexion. Twist past a wrist's own small range moves into the forearm, which turns with the hand, so
the hand stays where it was. A spine region (neck, trunk) is one budget: each bone may use any part of it, and the
head stays within the neck's range against the chest whatever number of bones the rig spends.

A rig bone stands for every table joint of its region nearest to it: one spine bone for five vertebrae carries their
summed range, and a head bone with no neck bone carries the whole neck.

### The human table (`margoengine/rigging/anatomy/human`)

`human` holds the 139 joints of the body in ISO/IEC 19774-1:2019 names from `humanoid_root` (level of articulation 4
without the 7 joints of the face), each with its kind, axes, ranges, and the source of every number.

```ts
import { human, humanTable } from 'margoengine/rigging/anatomy/human';

const elbow = human.joints.find((joint) => joint.id === 'l_elbow')!;
const flexion = elbow.dofs![0];
console.log(flexion.positive, flexion.max.normal, flexion.max.structural); // flexion 150 160
console.log(flexion.negative, flexion.min.normal, flexion.min.structural); // hyperextension 4.7 5
const row = flexion.max.rows[0];
console.log(row.source, row.provenance, row.what); // cdc2011 dataset elbow flexion, women 20-44 years, mean
// A table for one group: girls of 2 to 8 years bend further past straight.
const girl = humanTable({ sex: 'female', age: 6 });
console.log(girl.joints.find((joint) => joint.id === 'l_elbow')!.dofs![0].min.normal); // 6.8
```

Where the numbers come from. Every number is a row with its source, the page it was read on, and how it was checked:
`dataset` (read from a measured dataset held in a data file of this repository), `online` (read on the page named),
`recalled` (from memory, to be confirmed in print) or `print`. Today 98 numbers are `dataset`, 136 `online`, 90
`recalled` and none `print`; `packages/rigging/tests/anatomy-human.test.js` holds a second copy of each.

- The limb motions the CDC Normal Joint Range of Motion Study measured (hip, knee, ankle, shoulder flexion, elbow,
  forearm rotation) come from that dataset: adults of 20 to 44 years, the larger mean of the two sexes
  (`anatomy-data-cdc.ts`). `humanTable({ sex, age })` reads another group.
- Every other range is the AAOS 1965 value as a readable page reproduces it, with the AMA Guides (5th edition) value
  beside it. The stop of a motion is its largest source value rounded up to 5 degrees plus a stated allowance: 15 for
  the swing or twist of a ball, saddle or condyloid joint and for a spine region, 10 for a hinge's flexion, none for
  the straight side of a hinge.
- A spine region's clinical range is shared among its levels by per-level weights: lumbar levels from Pearcy and
  Tibrewal 1984 and White and Panjabi 1990 as open pages give them; thoracic and cervical levels are White and
  Panjabi's representative values from recall (61 of the 90 recalled numbers), with the thoracic levels scaled to that
  book's thoracic totals. The other recalled numbers are toe joints, the collarbone's split, knee rotation, the wrist's
  own twist, the thumb's base and the small joints of the palm.
- Proportions (`human.proportions`) are shares of stature from the ANSUR II summary statistics, both sexes
  (`anatomy-data-ansur2.ts`), with the Drillis and Contini figure beside them. Segment masses and centres of mass
  (`human.segments`) are de Leva 1996 (`anatomy-data-deleva.ts`). `human.couplings` lists the motions joints share
  (shoulder girdle rhythm, carrying angle, forearm rotation, knee rotation, finger curl, head rotation) with their
  numbers and sources, for the coupling solver.

Bones are found by name under these conventions, the best match winning: `hanim` (the standard's own names and the
HAnim 1.x names of renamed joints), `segments` (Mixamo style, and the BVH form of the CMU captures), `joints` (the
100STYLE captures and other files that name a bone for its joint), `unreal` and `unreal5` (Unreal mannequin names,
`pelvis`, `spine_01`, `upperarm_l`, `thigh_l`, with three or five spine bones; the Quaternius animation library uses
the three-bone form), `kaykit` (KayKit characters, `hips`, `chest`, `upperarm.l`, `wrist.l`, `upperleg.l`), and the
presets of `margoengine/rigging/retarget` (Character Creator, the CMU ASF skeleton, MPFB, Godot, Roblox R15, VRM
humanoid names). `map` adds or overrides one bone at a time.

```ts
import type { RigJoint } from 'margoengine/rigging';
import { fitAnatomy, hingeRolls, poseFromAngles, poseLimits } from 'margoengine/rigging/anatomy';
import { fitHuman, human } from 'margoengine/rigging/anatomy/human';
import { PoseJointLimits } from 'margoengine/rigging/joint-limits';

const rig: RigJoint[] = [
  { name: 'Hips', parent: -1, position: [0, 1, 0] },
  { name: 'Spine', parent: 0, position: [0, 1.1, 0] },
  { name: 'Head', parent: 1, position: [0, 1.6, 0] },
  { name: 'LeftUpLeg', parent: 0, position: [0.1, 0.95, 0] },
  { name: 'RightUpLeg', parent: 0, position: [-0.1, 0.95, 0] },
  { name: 'LeftArm', parent: 1, position: [0.2, 1.45, 0] },
  { name: 'LeftForeArm', parent: 5, position: [0.48, 1.45, 0] },
  { name: 'LeftHand', parent: 6, position: [0.74, 1.45, 0] },
];
const body = fitHuman(rig);
// The same limits in the form PoseJointLimits holds: exact for hinges.
const older = new PoseJointLimits(rig.length, poseLimits(body).filter((limit) => limit.limit.type === 'hinge'));
const pose = poseFromAngles(body, { l_elbow: { flexion: 175 } });
older.apply(pose);
// A capture's frames show how its straight limbs are rolled; fit again with what they show.
const frames = [30, 60, 90].map((flexion) => poseFromAngles(body, { l_elbow: { flexion } }));
const calibrated = fitAnatomy(rig, { species: human, roll: hingeRolls(body, frames) });
console.log(Object.keys(hingeRolls(body, frames)), calibrated.joints.length); // [ 'l_shoulder' ] 8
```

Limits of the fit, stated plainly:

- A straight limb with no bent joint and no knuckle bones shows no roll in its joint positions. The fit then takes the
  limb as unrolled (in a T pose with the palms down the elbow bends forward). Motion capture skeletons are often
  rolled: read from the clips in this repository, the CMU skeleton's upper arms are rolled 15.7 to 18.8 degrees, and
  without that its elbows seem to bend up to 38 degrees sideways. `hingeRolls` reads the roll from the motion.
- A joint whose zero is a direction in the body (shoulder, hip, thumb base) needs the joint at the far end of its
  segment mapped. Without it the joint is left unlimited rather than guessed.
- A modelled bend of under 5 degrees is read as straight; from 5 to 20 degrees it sets the hinge side only when it is
  within 60 degrees of the anatomical side; from 20 degrees it always does.
- When the left and right names disagree with the way the feet point, the feet win and `body.mirrored` is true.
- `poseLimits`, `ikLimits`, `ragdollJoints` and `kinematicsLimits` give a joint that reaches further one way than the
  other the nearest cone the older forms can hold; `clampPose` holds the exact reach.
- The species is passed as its table (`species: human`), not by name, so the core entry loads no table.

Sources: ISO/IEC 19774-1:2019 (HAnim); Wu et al. 2002 and 2005 (ISB joint coordinate systems); Grood and Suntay 1983;
Baerlocher 2001 and Dobrowolski 2015 (swing and twist); Grassia 1998; Wilhelms and Van Gelder 2001 (reach limits);
Akhter and Black 2015 (pose-conditioned limits, the idea only); Soucie et al. 2011 (CDC); AAOS 1965 and the AMA
Guides, 5th edition, through the pages each row names; Paraskevas et al. 2004; Inman, Saunders and Abbott 1944;
Ludewig et al. 2009; White and Panjabi 1990; Pearcy and Tibrewal 1984; Gordon et al., ANSUR II; de Leva 1996; Drillis
and Contini 1966 through Winter 2009. Full citations are in `human.sources` and [docs/clean-room.md](../../docs/clean-room.md).

## Pose checks (`margoengine/rigging/validate`)

The pose checker tells an artist what is wrong with a pose or a clip before anyone has to see it by eye. It works on
any body fitted by `fitAnatomy` or `fitHuman`, so it reads Character Creator, Mixamo, CMU, VRM and the other named rigs
the same way. Every issue names the joint and its bone, the motion, the value against its limit, how far past it is,
the limit's source row (CDC 2011, AAOS 1965 and so on), the frame time in a clip and a help link.

```ts
import type { RigJoint } from 'margoengine/rigging';
import { poseFromAngles } from 'margoengine/rigging/anatomy';
import { fitHuman } from 'margoengine/rigging/anatomy/human';
import { checkClip, checkPose, formatPoseReport } from 'margoengine/rigging/validate';

const rig: RigJoint[] = [
  { name: 'Hips', parent: -1, position: [0, 1, 0] },
  { name: 'Spine', parent: 0, position: [0, 1.1, 0] },
  { name: 'Head', parent: 1, position: [0, 1.6, 0] },
  { name: 'LeftUpLeg', parent: 0, position: [0.1, 0.95, 0] },
  { name: 'RightUpLeg', parent: 0, position: [-0.1, 0.95, 0] },
  { name: 'LeftArm', parent: 1, position: [0.2, 1.45, 0] },
  { name: 'LeftForeArm', parent: 5, position: [0.48, 1.45, 0] },
  { name: 'LeftHand', parent: 6, position: [0.74, 1.45, 0] },
];
const body = fitHuman(rig);
// An elbow folded 30 degrees back: past its 5 degree stop, so an error.
const report = checkPose(body, poseFromAngles(body, { l_elbow: { flexion: -30 } }));
console.log(report.passed, formatPoseReport(report));
// A whole take, frame by frame: one row per fault with its frames, its worst frame and a total.
const frames = [0, 40, 80, 120].map((flexion) => poseFromAngles(body, { l_elbow: { flexion } }));
const clip = checkClip(body, frames, { fps: 30 });
console.log(clip.passed, clip.summary.length);
```

`checkPose(body, pose, options)` returns `{ passed, errors, warnings, issues }`; `checkClip(body, frames, options)`
takes an array (or any iterable) of local poses, or a sampler `(time, out) => void` with `duration`; every issue
carries its `frame` and `time`, and the report adds a `summary` row per joint, motion and fault (how many frames, the
first and last time, the worst issue), errors first, and the clip's `frames` and `fps`. `assertPose` and `assertClip` throw a coded `failed` error carrying the report for a
test or an export step. `checkProportions(body)` checks the fitted rest shape itself. `formatPoseReport` prints any
report, one line per issue.

| Code | Severity | What it means |
| --- | --- | --- |
| `out-of-range` | error past the stop, warning past the clinical range | A swing past the table's range. |
| `hinge-reversed` | error past the stop, warning past straight | An elbow or knee bent the wrong way. |
| `hinge-sideways` | as above | A hinge turned off its plane (a knee bent sideways). |
| `twist-out-of-range` | as above | A bone twisted about its own length past its range. |
| `bone-stretch` | error | A bone longer or shorter than at rest by more than `stretch` (1 percent), or a scaled bone. |
| `ground-penetration` | error past `sink` | A joint or a skin point (`points`) under `ground`. |
| `floating` | warning | A named support (`supports`) more than `float` (6 percent of stature) above `ground`. |
| `self-penetration` | error | Two body volumes (the trunk and the limb segments, from ANSUR II girths, shrunk by `shrink`) overlap. |
| `foot-slide` | error | A planted foot moving sideways faster than `slide` (clip only). |
| `pop` | error | A joint turning faster than `maxSpeed`, a one-frame step or a one-frame blip (clip only). |
| `proportion` | error | A rest segment outside its ANSUR II band (`checkProportions`). |
| `asymmetry` | warning | Left and right segments differ by more than 5 percent (`checkProportions`). |

Options, with their defaults:

- `tier`: `'both'` reports errors past the stops and warnings past the clinical range; `'structural'` or `'normal'`
  reports one tier.
- `tolerance`: 0.5 degrees a joint may pass a limit before it is reported.
- `ground`: null, no ground check; a number is the floor height along the body's up axis.
- `points`: none; skin or mesh points in world units, checked against the ground.
- `supports`: none; joint ids that should touch the ground (a seated pose names its pelvis or feet).
- `float`: 0.06 of stature; `sink`: 0.002 of stature.
- `volumes`: true; `shrink`: 0.7 of each measured radius, so clothes and soft tissue are not read as a collision.
- `stretch`: 0.01, the share a bone may change length.
- In a clip: `fps` 30, `start` 0, `duration` (needed for a sampler), `velocity` (the root's speed, for clips played in
  place), `maxSpeed` 9,000 degrees per second (Fleisig 2017, a pitcher's shoulder, the mean plus three standard
  deviations), `contact` 0.02 of stature, `slide` 0.1 of stature per second.

Limits of the checks, stated plainly:

- The volume check is capsules, not the mesh: it catches an arm through the chest or one leg through the other, not a
  finger through a sleeve. Same-side arm against thigh is left out, because a hanging arm rests on it.
- A foot is read as planted when it stays within `contact` of its lowest height for three frames (Kovar 2002), so a
  clip whose feet never come near their lowest point is not checked for sliding.
- An elbow or knee is reported past straight from 0.5 degrees, even though its clinical range allows a little more
  (CDC 2011 lists 4.7 degrees for the elbow): a mesh elbow past straight looks broken, so the checker warns and the stop decides
  the error.

Sources: Gordon et al., ANSUR II (girths, depths and breadths); Ericson 2005, section 5.1.9 (segment closest points);
Kovar, Schreiner and Gleicher 2002 (footskate); Fleisig et al. 2017 (peak joint speeds); and the anatomy table's
sources above. Full citations are in [docs/clean-room.md](../../docs/clean-room.md).

## Swimming (`margoengine/rigging/swim`)

`createSwimRig` creates a head-to-tail chain in metres, with +Y up and +Z forward. A shark or reef fish sweeps laterally.
A dolphin or humpback flexes in the vertical plane and feathers its flukes. The ray profile supplies fin hinges by
default. Custom fin hinges may include a distal joint to introduce a delayed second bend. Use arbitrary
increasing station fractions to match measured landmark spacing, or choose a uniform segment count. Feed the local
TRS frames to your skin or bake quaternion keys into an animation. Update the caller's world path independently.

```ts
import { createSwimRig, sampleSwimPose, swimCadence } from 'margoengine/rigging/swim';
const rig = createSwimRig('reef-shark', { length: 1.4, segments: 28 });
const phase = 0.25 * swimCadence(rig, 0.9);
const pose = sampleSwimPose(rig, { phase, effort: 0.8, turn: 0.1 });
console.log(rig.names.length, pose.length);
```

With variable speed, accumulate phase across steps or sample a continuous phase curve. Fade effort to zero while
coasting. `swimCadence` estimates cruising frequency from speed and the profile's peak-to-peak tail or fin excursion.
The profiles are kinematic. They illustrate tail and fin mechanics and leave thrust, buoyancy, ecological behaviour
and model-specific skin weights to the caller. The travelling wave and constant-length spine draw on [Lighthill,
Large-Amplitude Elongated-Body Theory of Fish Locomotion (1971)](https://doi.org/10.1098/rspb.1971.0085),
[Wilga and Lauder, Function of the Heterocercal Tail in Sharks (2002)](https://bpb-us-e1.wpmucdn.com/sites.harvard.edu/dist/6/58/files/2022/03/WilgaLauder2002.pdf),
[Fish, Power Output and Propulsive Efficiency of Swimming Bottlenose Dolphins (1993)](https://doi.org/10.1242/jeb.185.1.179),
[Gazzola, Argentina and Mahadevan, Scaling Macroscopic Aquatic Locomotion (2014)](https://doi.org/10.1038/nphys3078),
[Smits, Undulatory and Oscillatory Swimming (2019)](https://doi.org/10.1017/jfm.2019.284),
[Segre et al., A Hydrodynamically Active Flipper-Stroke in Humpback Whales (2017)](https://pubmed.ncbi.nlm.nih.gov/28697357/),
and [Blevins and Lauder, Rajiform Locomotion in the Freshwater Stingray Potamotrygon orbignyi (2012)](https://bpb-us-e1.wpmucdn.com/sites.harvard.edu/dist/6/58/files/2022/03/Blevins.Lauder.2012.pdf).

## Test character

The examples above run as written against an original test character the README runner makes
(`scripts/support/readme-humanoid.mjs`): a skinned figure of boxes with Mixamo-named bones (`/character.glb`,
`/rigged.glb`, `/mixamo-walk.glb`) or Godot humanoid-profile names (`/godot-hero.glb`), the 52 ARKit face shapes,
elbow and shoulder correctives, `Hair1` to `Hair3`, `LeftEarring` and `Belly` bones, and `Idle` and `Walk` clips;
`/avatar.vrm` is the same figure as a VRM 1.0 avatar with face shapes under other names (`Mouth_Open`, `Blink_L`,
`Blink_R`, `Lash_L`). Mixamo is a trademark of Adobe Inc. and Godot of the Godot Foundation; Margo is not affiliated
with them and uses only their published bone names.

## Sources

Written clean room from the published papers listed in [docs/clean-room.md](../../docs/clean-room.md#rigging-margoenginerigging).

## Film time

`MToon.advanceTime(delta)` moves the UV scroll and rotation clock (`mtoon.time`); the frame update runs it, so `seek` from `@margoengine/cutscene/seek` starts a film scene on the UV phase a continuous run shows.

## Physical strand spring bones

The optional strand rig binds weighted bones to an SI fibre model with gravity, drag,
ground, and body contact. Load it through the existing `SpringAccess` or attach it after
an `Animator` pose with `addStrandSpringRig(animator, options)`.

```ts
import { Engine } from 'margoengine';
import { StrandSpringRig } from 'margoengine/rigging/strand-springs';
import { springAccess } from 'margoengine/rigging/springs';

const engine = await Engine.create(document.querySelector('canvas')!);
const scalp = engine.createMesh().setPosition([0, 1.72, 0]);
const root = engine.createMesh().setParent(scalp).setPosition([0, 0, -0.12]);
const tip = engine.createMesh().setParent(root).setPosition([0, -0.24, -0.02]);
const rig = await StrandSpringRig.load(springAccess({ root: scalp, nodes: [scalp, root, tip] }), {
  chains: [{ joints: [1, 2], radius: 0.006, dragWidth: 0.025 }],
});
scalp.setPosition([0.08, 1.72, 0]);
rig.advance(20); // 20 frames on the 240 Hz world clock
console.log(rig.solver.sample(0, 1).position);
```

Pass the chain's ordered glTF indices in `joints`. A single attached earring or antenna
also takes a `tip` in its bone's local metres. Bone and ancestor transforms require positive
uniform scales. Each bundle can override its native radius, density, material and drag
width. The physics controls are the same as in the physics package's strand guide entry.
Set the same `wind` and `bed` fields as the surrounding scene. Each `colliders` entry can
be world-space or attached to a glTF node and moves with that node.

For a VRM avatar, get the authored joint and collider lists from `vrmSprings(avatar)`.
Use `addVRM(animation, avatar, { animator, springs: false })` with the physical attachment
and supply the matching collider list. The physical rig takes its own fibre properties
in metres and pascals. A pure per-chain `anchor(time)` gives exact replay across display
rates and a `seek(frame)` from the initial snapshot. The default live bone attachments
sample the current animation pose. To replay those, evaluate the same animation frames in
the same order. Call `dispose()` on the Animator attachment to stop its updates.
