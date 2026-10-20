# @margoengine/animator

Optional gameplay animation on the existing `@margoengine/animation` skinning pass. Named states select clips, 1D trees interpolate neighboring samples, and 2D trees use normalized inverse-square distance weights with exact sample reproduction. State transitions crossfade a captured pose into the destination. Masked additive layers apply translation/scale/quaternion and morph deltas relative to a sampled reference pose. A zero reference scale component contributes an identity scale delta on that axis. Primitives sharing a node must have matching morph target counts, as required by glTF.

```ts
import {EngineKernel} from '@margoengine/core';
import {loadGLTF} from '@margoengine/gltf-pro';
import {Animation} from '@margoengine/animation';
import {Animator} from '@margoengine/animator';
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

`addFootIK({hip,knee,ankle,pole,raycast,offset,probeHeight})` requires a direct three-node leg chain. The callback receives a world-space origin above the current ankle and a downward ray. Return `{position,normal?}` or `null`; supply terrain collision data or an existing BVH. For `AssemblyBVH`, adapt its result with `hit ? {position:hit.point} : null`. Normals align the ankle's local +Y with the terrain. Bones/ancestors require positive uniform scales. Unreachable targets clamp to the leg's reach; the pole chooses the knee bend direction. `solveTwoBoneIK()` is also exported as a standalone analytical solver.

## CCD chains (any length)

`addCCDChain(animator, chain)` adds a Cyclic Coordinate Descent IK chain (Wang and Chen 1991) for arms, spines, tails, tentacles or fingers, solved every frame after the pose, additive layers and foot IK. Each sweep goes from the last joint to the first; every joint turns, on its own, so the end effector moves toward the target, then its limit is applied. `joints` lists glTF node indices from the first joint to the last, each the child of the one before. The Animator keeps the chain object and reads `target`, `rotation`, `pole`, `weight` and the solve settings every frame, so move the target by writing into it:

```ts
const reach = {
  joints: [shoulder, elbow, wrist],          // glTF node indices
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
const remove = addCCDChain(animator, reach); // import {addCCDChain} from '@margoengine/animator'
```

- **Limits** are measured from each joint's rest (bind) rotation, in radians: `euler` clamps the qX·qY·qZ angles per axis (equal bounds lock an axis), `hinge` turns about one rest-frame axis, `cone` keeps the bone within `angle` of its rest direction (the bone axis defaults to the direction of the next joint) with an optional `twist` range. Joints start each solve inside their limits.
- **Reach step** (`reach`, default true). Plain CCD straightens a chain slowly: near full reach every joint's best single turn barely changes the chain's length, so the effector stays short for hundreds of sweeps. After each sweep the solver therefore scales every joint's bend by one factor (keeping the chain's shape and twists), found by bisection so the root-to-effector distance equals the target's, and re-aims the first joint. A step that ends farther from the target (limits in the way) is undone; after two in a row the solve continues as plain CCD. `reach: false` runs plain CCD.
- **Unreachable targets** straighten the chain toward them; the result reports how far it stopped.
- **`rotation`** turns the last joint to that world rotation. Each other joint also turns about its own joint-to-effector line (which leaves the effector where it is) to remove what it can of the orientation error.
- **`pole`** turns the chain, after each sweep, about its root-to-effector line so the bend faces the pole (the effector stays put).
- **`weight`** blends from the animated pose (0) to the solved chain (1). `maxAngle` caps one joint's turn per sweep.
- Joints and their ancestors need positive uniform scales. Rotations commit through `writeRotation` when it is set.

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

## Explicit rotation writer

`AnimatorOptions.writeRotation?: (node: Mesh, rotation: readonly number[]) => void` is an optional, explicit commit hook for applications that own their transform writer. It is captured and validated once during construction. Omit it to keep the current dynamic `Mesh.setQuaternion` call, including method overrides. This is an additive public API option; it does not change core/stage.

The hook receives the actual destination mesh and a borrowed normal JavaScript array for both sampled/blended local poses and FootIK corrections. Commit synchronously, validate finite Float32-representable and nonzero quaternion values, normalize using the application's required numeric behavior, and synchronize the mesh's quaternion and XYZ Euler state. Do not mutate or retain the borrowed array, change Animator/model structure from the callback, or reenter pose evaluation. Recursive `onPreUpdate` from a writer throws before changing update state. A thrown writer does not advance the successful rotation cache; previously successful position/scale writes keep their existing partial-update behavior. The next update compares against that earlier successful cache. If a writer restores exactly the earlier accepted quaternion/Euler state before throwing, an unchanged request can legitimately skip another callback, matching the default setter path. Throws do not guarantee callback reinvocation.

Cached unchanged rotations skip the hook, just as they skip the default setter. It is not a per-frame notification or a generic purity guarantee. Construct a stable writer outside the frame loop. Default mesh setter behavior for caller-owned typed arrays is unchanged. An opted-in application is responsible for writer correctness; a hook that ignores validation or does not commit state violates this contract. No allocation-free or whole-scene performance guarantee follows from supplying a callback.
