# @margoengine/kinematics-constraints

Import `margoengine/kinematics-constraints` from the `margoengine` package, or `@margoengine/kinematics-constraints` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Standalone capsule, sphere and convex hull avoidance for IK targets and two-bone chains. The package projects targets out of proxy volumes, checks elbow and link clearance, and searches a shoulder swivel angle through a caller-supplied IK evaluator. It has no engine, renderer, physics, or Wasm dependency. ESM exports and declarations are tree-shakable; core, stage, animation, and the existing IK kernels remain unchanged.

Version `1.0.0` is source-only and has not been published to npm. From the repository root:

```sh
npm ci
npm run build --workspace @margoengine/kinematics-constraints
npm run test --workspace @margoengine/kinematics-constraints
npm pack --workspace @margoengine/kinematics-constraints --pack-destination test-results
```

Install the resulting tarball in another project with `npm install ./margoengine-kinematics-constraints-1.0.0.tgz`. No core peer dependency is required. The package is Apache-2.0 licensed.

## Interactive arm demo

From the repository root, run:

```sh
npm run modern:dev:extensions
```

Open [http://127.0.0.1:5173/examples/kinematics-constraints.html](http://127.0.0.1:5173/examples/kinematics-constraints.html). If Vite reports a different port, use that port with the same path. Drag the orange request across the torso, overhead, and across the waist. Switch from the capsule torso to a mixed scene with an additional sphere and capsule rail; every full-chain acceptance checks all active volumes.

The compact controls demonstrate full-chain `solve()` versus target-only `resolveTarget()`. Target-only mode hides the arm and explicitly certifies only the green target sphere. The full-chain readout separates the accepted physical gap, accepted pole angle, allowed `min(π, speed * dt)` pole window, actual accepted pole step, accepted hand displacement, and requested-target contact. Hand motion can be nonzero while the transported pole coordinate is unchanged; a held pose reports zero for both accepted displacements. Before solving, the demo conditions large requested translations toward a nominal 0.75 m/s using the configured damping response. This reduces large catch-up steps without rejecting a successful solve after its history has advanced; obstacle/reach projection can still alter displacement, so it is not a certified Cartesian or joint velocity limit. Raw requests outside the operational reach band remain diagnostic. A rejected conditioned request can advance through a smaller local step only if another complete `solve()` succeeds; otherwise the controller holds its last accepted pose. Exact angular overshoot is not exposed by the package and is not invented by the HUD.

Advanced settings expose the caller's live/fixed positive time step, angular search budget, required gap, and target damping time. Changing the scene, required gap, or damping constructs a new solver and starts from a newly validated initial pose; changing speed or search budget preserves solve history. Fixed time is per caller update and is not a display-frame-rate guarantee. The optional 25° shoulder/torso yaw assist is an application adapter, not a feature of the package: the rotationally symmetric torso capsule remains in the same frame while a proposed shoulder position and its complete link chain are checked before being committed together. Rejected shoulder candidates retain the accepted root and pose.

The [demo controller](../../examples/kinematics-constraints-controller.js) includes an analytical elbow callback with reused vector storage. It transports the last accepted bend reference between reach directions, so overhead and cross-body motion keep one continuous angle convention. Pointer rays meet a curved drag surface in front of the torso and waist. The demo renders analytical proxies directly, without character skinning, continuous collision detection, joint acceleration limits, or a physical safety guarantee. Reused buffers do not guarantee that the JavaScript runtime or renderer performs no allocations.


For a motion report, expand **Record a problem**, click **Start recording**, reproduce the issue, then click **Stop recording**. The stopped JSON is readable in the panel and can be downloaded explicitly. The temporary recorder keeps the latest 3,600 frame snapshots plus bounded control actions, including raw, paced and final retry targets, accepted and candidate poses, clearance, pole/hand steps, and caller settings. It stays disabled until started, stores only local in-memory numeric snapshots, and never uploads or saves automatically. Clear removes the captured trace from the panel.


## Controller integration

Use one `AvoidanceSolver` per chain. Supply the initial hand and elbow from a known safe pose, use one common coordinate frame, and choose one scene unit consistently. This complete TypeScript controller accepts an evaluator from your pure IK kernel. The evaluator must use the same bone lengths passed to the controller.

```ts
import {
  AvoidanceSolver, CapsuleVolume, SolveStatus,
  type ElbowEvaluator, type SolveOptions, type Vec3View,
} from 'margoengine/kinematics-constraints';

export function createArmController(
  evaluateElbowIK: ElbowEvaluator,
  root: Vec3View,
  initialHand: Vec3View,
  initialElbow: Vec3View,
  upperLength: number,
  forearmLength: number,
) {
  // These dimensions use meters; update the proxy from the torso's world frame.
  const torso = new CapsuleVolume({
    start: [0, 0.45, 0], end: [0, 1.2, 0], radius: 0.32,
  });
  const elbowRadius = 0.065, forearmRadius = 0.055;
  const solver = new AvoidanceSolver([torso], {
    minClearance: 0.008,
    complianceMargin: 0.003,
    targetRadius: forearmRadius,
    damping: 0.12,
  });
  const options: SolveOptions = {
    swivelSpeedLimit: Math.PI,
    reachMargin: 0.015,
    foldMargin: 0.015,
    searchBudget: 128,
  };
  const hand = new Float32Array(initialHand);
  const elbow = new Float32Array(initialElbow);

  return {
    hand, elbow, torso,
    update(rawTarget: Vec3View, dt: number): SolveStatus {
      // dt is positive elapsed seconds; skip calls while the controller is paused.
      const result = solver.solve(
        root, hand, rawTarget, upperLength, forearmLength,
        elbowRadius, forearmRadius, dt, evaluateElbowIK, options,
      );
      if (result.status === SolveStatus.Success && result.resolved) {
        hand.set(result.target);
        elbow.set(result.elbow);
        // Your pose adapter can now commit these accepted positions to the rig.
      }
      // Failure leaves the controller's accepted hand and elbow unchanged.
      return result.status;
    },
    teleportToValidatedPose(safeHand: Vec3View, safeElbow: Vec3View): void {
      hand.set(safeHand);
      elbow.set(safeElbow);
      solver.reset();
    },
  };
}

// For callers that need target projection alone, with no link or reach checks:
export function constrainPoint(
  solver: AvoidanceSolver, rawTarget: Vec3View,
  dt: number, acceptedTarget: Float32Array,
): boolean {
  const candidate = solver.resolveTarget(rawTarget, dt);
  if (!solver.targetResult.resolved) return false;
  acceptedTarget.set(candidate);
  return true;
}
```

`ElbowEvaluator` is `(root, target, poleAngle, outElbow) => void`. Write all three components of `outElbow`; the return value is ignored. Angles are radians. Use a stable angle-zero reference and rotation direction across calls, capture the bone lengths in your evaluator, and keep it pure: do not modify input vectors, colliders, scene transforms, or solver state. Candidate bone lengths are validated before clearance is accepted. Do not retain the evaluator's scratch-vector references.

On the first solve, there is no previous pole, so the search can cover a full revolution around angle zero. Later searches sample the previous successful angle first, then increasing angular distances within `swivelSpeedLimit * dt`, capped at π in either direction. The first clear sampled angle wins; this is a bounded sampled search, not a continuous angular optimum. Failed calls do not update successful target or pole history. Use `reset()` after deliberate teleports or a changed pole convention; it clears history and makes the next swivel search unrestricted again. The controller owns initial-pose validation and its hold/recovery policy. Moving obstacles can invalidate a previously accepted pose, so holding alone does not revalidate that pose.

The speed limit bounds the supplied pole-angle coordinate. Moving the target or transporting its reference frame also moves the elbow; this option does not bound total joint velocity, acceleration, or jerk. Exponential target damping introduces response lag, and a held pose can stop immediately. Applications needing velocity-continuous motion must supply a trajectory controller and validate its resulting poses and paths separately.

## API and defaults

`new AvoidanceSolver(volumes?, options?)` accepts an array of `ConstraintVolume` objects. The alternate `new AvoidanceSolver({colliders, ...options})` form is also supported. The collider list is copied at construction; update moving objects with `volume.set(...)`, or append one with `solver.addVolume(volume)`. Bone/frame attachment and transform conversion belong to the caller.

| Constructor option | Default | Meaning |
| --- | --- | --- |
| `colliders` | `[]` | Volumes in the options-only constructor form. |
| `minClearance` | `0.025` | Required extra gap beyond proxy radii, in scene units. |
| `complianceMargin` | `0.08` | Additional soft projection band outside the hard target shell. Zero disables it. |
| `targetRadius` | `0` | Radius used for target-point projection, independent of the elbow/link radii passed to `solve`. |
| `damping` | `0` | Exponential smoothing time constant in seconds. Zero disables smoothing. |
| `maxIterations` | `32` | Target projection iterations; integer `1..256`. |
| `tolerance` | `1e-6` | Numerical clearance acceptance tolerance in scene units. |
| `upperArmRadius` | Elbow radius from `solve` | Override for the upper-link capsule. `null` explicitly disables its segment check. |
| `rootExclusion` | `0` | Length trimmed from the root end of the upper-link check. |
| `links` | None | Upper link and forearm as convex hulls, in that order: `[{hull, origin?, axis?, hinge?}, {...}]`. Leave either out or `null` for its capsule. See [Convex hulls](#convex-hulls). |

All radii, gaps, damping, and exclusions must be finite and nonnegative; tolerance must be positive. `targetRadius` should enclose the hand/end-effector proxy you want the target projection to accommodate. For a capsule ending at the hand, use at least its forearm radius. A zero target radius projects only the point; subsequent link checks can still reject that target.

By default `solve` checks the elbow sphere, the full upper-link capsule, and the full forearm capsule against every collider, including segment interiors and endpoints. `upperArmRadius: null` leaves the upper link unchecked. `rootExclusion` leaves the trimmed root-side portion unchecked. Use these explicit exclusions only when that omitted geometry is handled separately; `Success` applies only to the geometry still checked. Elbow and forearm checks remain enabled.

```text
solve(root, currentHand, rawTarget, upperLength, forearmLength,
      elbowRadius, forearmRadius, dt, evaluateElbowIK, options?)
resolveTarget(rawTarget, dt)
calculatePoleClearance(root, elbow, end, radius)
```

Both `solve` and `resolveTarget` require an explicit, positive `dt` in seconds. Skip calls when paused rather than passing zero. `solve` smooths from the supplied current hand; `resolveTarget` smooths from its last accepted target after its first call. Bound the elapsed time passed after a suspended tab according to your controller's motion policy.

| Per-call `solve` option | Default | Meaning |
| --- | --- | --- |
| `swivelSpeedLimit` | `2 * Math.PI` | Maximum swivel speed in radians/second; zero holds the prior successful angle. |
| `reachMargin` | `1e-5` | Positive exclusion below full extension. |
| `foldMargin` | `1e-5` | Positive exclusion above full compression. |
| `searchBudget` | `32` | Additional angular samples per search pass; integer `0..256`, beyond the central sample. |

The operational root-to-hand distance is `[abs(upperLength - forearmLength) + foldMargin, upperLength + forearmLength - reachMargin]`. Margins must leave a nonempty interval. Projection alternates collider clearance and this reach interval. Requests outside the interval, or projection that enters an exclusion band, produce a dead-zone status if a clear clamped pose is found. A diagnostic full-angle search can run after a limited search fails to distinguish a swivel-rate failure from an occluded search.

`resolveTarget` returns a solver-owned `Float32Array` and updates `solver.targetResult`. Check `targetResult.resolved` before committing it. This method checks target clearance only; it does not check reach, elbow, links, or swivel rate.

`calculatePoleClearance` geometrically swivels an already solved root/elbow/end pose while retaining its bone lengths and end position. It returns a reused `PoleClearanceResult` with `resolved`, `elbow`, `pole`, `poleAngleOffset`, `clearance`, and `iterations`. Its `pole` is a point equal to the returned elbow, suitable for a point-based pole adapter. It uses the supplied radius for elbow and forearm checks, honors constructor upper-link settings, and does not apply temporal speed limits or update successful solve history.

## Results and statuses

| `SolveStatus` | Value | Meaning and commit policy |
| --- | --- | --- |
| `Success` | `0` | Target and checked pose satisfy clearance within tolerance. `resolved` is true; the controller may commit the pose. |
| `SwivelRateLimitExceeded` | `1` | A clear sampled pose was found outside the permitted angular movement. Hold or recover; no out-of-rate pose is accepted. |
| `SingularDeadZone` | `2` | A request or projection entered a fold/reach exclusion band. The clamped candidate remains unresolved; hold or recover. |
| `ObstacleOccluded` | `3` | No accepted clear pose was found within this call's projection/search budget. This does not prove that no feasible pose exists. |

`SolveResult` contains `status`, `resolved`, `targetResolved`, `target`, `elbow`, `poleAngle`, `poleAngleOffset`, `clearance`, `maxPenetration`, and `iterations`. `poleAngleOffset` aliases the returned absolute pole angle in the evaluator's angle convention; it is not the change since the previous frame. `targetResolved` alone does not certify a safe arm pose. Unresolved candidate vectors are diagnostic output and must not replace the accepted pose.

`clearance` is the worst residual gap after subtracting proxy radii **and `minClearance`**, across the target and checked pose. Zero means the configured gap is met; values down to `-tolerance` can be accepted. It is not the raw physical distance between visible meshes. `maxPenetration` is `max(0, -clearance)` relative to that required shell. `iterations` counts projection iterations and evaluated angular candidates, including any diagnostic search. With no colliders, clearance can be `Infinity`.

Results, vector buffers, `targetResult`, and helper results are reused. Read them before the next call; copy scalar fields and clone vectors when retaining a snapshot. The solver is not reentrant. A callback must not call back into that solver.

## Proxy geometry

| Export | Use |
| --- | --- |
| `CapsuleVolume({start, end, radius})` | Capsule around a segment; coincident endpoints form a sphere. `set(start, end, radius?)` copies updated geometry. |
| `SphereVolume({center, radius})` | Sphere proxy. `set(center, radius?)` copies updated geometry. |
| `volume.evaluate(point, outSurface, outNormal)` | Signed point-to-surface distance; negative inside. Writes a closest surface point and an outward unit normal. |
| `volume.segmentClearance(start, end, radius)` | Signed gap between a swept segment capsule and the volume; negative means overlap. |
| `measureSegmentClearance(start, end, radius, volume)` | Convenience wrapper for the same signed segment clearance. |
| `closestPointsBetweenSegments(a, b, c, d, out?)` | Closest segment points, distance, and parameters in `[0, 1]`; supports degenerate and parallel segments. |

`ConvexHullVolume` is the third built-in proxy; [Convex hulls](#convex-hulls) has its table. Geometry normals at a sphere center or capsule axis use deterministic fallback directions. Output vectors must be writable, distinct, and nonoverlapping. Vector inputs are three-element tuples, `Float32Array`, or `Float64Array`. A custom `ConstraintVolume` must provide a signed-distance `evaluate` with unit normals and an exact `segmentClearance`; sampling only segment endpoints cannot satisfy that contract. It may also provide `evaluateInto` and `segmentClearanceInto`, which write the number to `outDistance[0]` and which the solver then calls instead, and it needs `hullClearanceInto(hull, outDistance)` to sit in a solver that has link hulls.

The built-in solver/volume hot paths reuse their vector and result storage and do not explicitly create per-call JavaScript containers when passed reused inputs/options. JavaScript engines can still allocate temporary numeric values at builtin and function boundaries: a warmed solve against capsule colliders allocates nothing per solve (`tests/capsule-allocation.test.js` runs 20,000 clear solves with no collection and under 64 KB of heap growth, Node 26; it was about 1,150 B per solve before). So do hulls; see [Convex hulls](#convex-hulls). `closestPointsBetweenSegments` allocates about 12 B per call when `out` holds tuple points; reuse typed arrays. This is not a zero-allocation or zero-GC guarantee. Caller callbacks, pose adapters, and UI code also control their own allocations. `closestPointsBetweenSegments` allocates a result when `out` is omitted; supply a reused `SegmentDistanceResult` with distinct `pointA`/`pointB` vectors to reuse that storage. This package makes no fixed runtime or frame-rate claim.

Point and link queries on unchanged built-in spheres and capsules use internal destination-passing paths into solver-owned `Float64Array` slots. Private pose checks also write their clearance into reused storage. The public `evaluate(...): number` and `segmentClearance(...): number` signatures and all numerical guards remain intact. Custom volumes and overridden methods continue through those public contracts; they do not need additional methods. This avoids numeric return boundaries for built-in queries and private pose checks, while other runtime allocation sites remain measurable.

Reach bounds and search span use private scalar storage. Reach clamping evaluates its norm locally with the same scaled fallback used for tiny coordinates. Search retains accepted numeric angles and reuses a preceding candidate argument only when the new value is exactly equal, including its zero sign. Every candidate still invokes the callback in the original order. A fresh angle passed to an uninlined numeric IK callback can still require boxing; moving that angle through internal scratch would not remove the public callback boundary. Allocation behavior also depends on the runtime's compilation tier.

Run `node scripts/profile-kinematics-constraints.js` from the repository root to capture warmed solver-only workloads, a rendered target sweep, and trusted pointer dragging. Repeat with `--gc-only` to measure heap/GC without the allocation sampler. Reports, allocation stacks, and traces are written to `test-results`; sampled bytes per solve/frame are estimates, not exact allocation counts. The script defaults to Edge with a software GPU for reproducibility and honors `BROWSER_ARGS` when profiling physical hardware. Each report records the selected adapter.

For actual V8 object types, run `node scripts/profile-kinematics-constructors.js` using a Node build that supports GC object statistics (validated with Node 24), or supply `--node=/path/to/node`. It compares a warmed solver burst against a callback/control loop, saves dead-object counts and retained heap snapshots, and records the runtime and bundle hash. `--label=name` preserves separate captures; `--skip-snapshots` skips the retained-object comparison. The default fixture has one capsule; `--colliders=4` separately measures two capsules and two spheres. Snapshots force collection and therefore cannot count discarded transient allocations; the dead-object census and sampled call stacks provide separate evidence.

Geometry helpers reject nonfinite components or magnitudes above `1e100` and keep their calculations in JavaScript number precision. Solver input positions must additionally fit finite Float32 values because accepted targets/elbows use Float32 storage. Float32 range does not imply useful precision at large world coordinates: use a local frame and units where bone lengths, radii, and `tolerance` remain representable. Inputs outside supported ranges throw rather than being silently accepted.

## Convex hulls

A capsule fits a box corner or a torso badly: a target can clear the capsule and still be inside the corner. `ConvexHullVolume` takes the corners themselves. It works as a collider anywhere a sphere or capsule does, and a chain link can be a hull too, so an arm can reach round a torso without either passing through the other:

```ts
import {
  AvoidanceSolver, ConvexHullVolume, SolveStatus,
  type ElbowEvaluator,
} from 'margoengine/kinematics-constraints';

// The corners of a box from x, y, z = -0.5 to 0.5. convexGeometry's positions work the same way.
const corners: number[] = [];
for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) corners.push(x, y, z);

// The torso, one metre up and two metres behind the arm, following its bone's world matrix.
const torso = new ConvexHullVolume({ points: corners });
const boneWorldMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 2, 1]);
torso.setTransform(boneWorldMatrix);

// A forearm hull in its bone's local space: the link runs along +Y from the local origin.
const forearm = new ConvexHullVolume({
  points: [-0.05, 0, -0.05, 0.05, 0, -0.05, 0, 0, 0.05, 0, 1, 0],
});

const solver = new AvoidanceSolver([torso], {
  minClearance: 0.01,
  links: [null, { hull: forearm }],
});

// Unit bones, reaching along +X: the elbow swings on a circle around the root to hand line.
const elbow: ElbowEvaluator = (_root, _target, angle, out) => {
  out[0] = 0.6;
  out[1] = 0.8 * Math.cos(angle);
  out[2] = 0.8 * Math.sin(angle);
};

const result = solver.solve([0, 0, 0], [1.2, 0, 0], [1.2, 0, 0], 1, 1, 0.05, 0.05, 1 / 60, elbow);
if (result.status === SolveStatus.Success) console.log(result.elbow, result.clearance);
```

| Export | Use |
| --- | --- |
| `new ConvexHullVolume({points, matrix?, maxPoints?})` | `points` are flat `x, y, z` values in local space; exact duplicates are dropped. `matrix` defaults to the identity. `maxPoints` defaults to `64` and more points throw, because a query costs one dot product per point per step. Raise it for a hull that needs more corners. Interior points cost time and change nothing, so pass hull corners, not a raw mesh. |
| `hull.setTransform(matrix)` | Places the hull. A column-major affine matrix of 16 values; scale and shear are fine. Costs a copy, whatever the point count. |
| `hull.evaluate(point, outSurface, outNormal)` | Signed distance, closest surface point and outward unit normal. Inside, the distance is minus the depth and the surface point is the nearest way out. |
| `hull.segmentClearance(start, end, radius)` | Signed gap to a capsule around a segment. Overlapping, it is minus a distance that moves them apart: the true depth or up to 2 percent more, and within 1e-4 of the shapes' size when nearly touching. |
| `hull.hullClearance(other)` | Signed gap to another hull, each at its current transform, with the same bound on the depth. A clear gap is exact. |
| `evaluateInto`, `segmentClearanceInto`, `hullClearanceInto` | The same, writing the number to `outDistance[0]`. A returned fractional number is a heap allocation unless V8 inlines the call, so use these in a per-frame loop of your own. |

One point, a line and a flat polygon are all valid hulls. They have no inside of their own: a point on one reads zero with a repeatable normal (the plate's normal, sign fixed; an axis across a line; `[1, 0, 0]` on a point).

A link hull's `points` are in the link's local space, such as its bone's. For each candidate pose the solver sets the hull's transform: `origin` goes to the link's start joint, `axis` runs along the link toward its end joint, and `hinge` lies on the normal of the plane through root, elbow and hand, in the direction of `(elbow - root) x (hand - elbow)`.

| `links[i]` option | Default | Meaning |
| --- | --- | --- |
| `hull` | Required | The hull to move. The solver owns its transform, so it cannot also be a collider. |
| `origin` | `[0, 0, 0]` | Local position of the link's start joint. |
| `axis` | `[0, 1, 0]` | Local direction from the start joint to the end joint; +Y is the glTF bone convention. |
| `hinge` | `[1, 0, 0]` | Local direction of the elbow's hinge axis; its part along `axis` is ignored. |

A link hull replaces that link's capsule. The `elbowRadius` sphere is still checked, so pass `0` if the hulls already cover the elbow. An upper link hull replaces `upperArmRadius` and `rootExclusion`, and setting those as well throws; build the hull so it leaves out whatever the root joint is allowed to touch. A collider in a solver with link hulls must have `hullClearanceInto`: spheres, capsules and hulls do. A subclass of a sphere or capsule that overrides `segmentClearance` must override `hullClearanceInto` too, or the solve throws, so its geometry is never silently ignored.

Hull colliders and link hulls allocate nothing per solve once warmed, with any mix of tuples and typed arrays: `tests/hull-allocation.test.js` runs 20,000 clear solves and 20,000 of each overlap query with no heap growth, on V8 14. A fresh fractional `angle` passed to your IK evaluator can still box, as under Proxy geometry above.

Measured on one desktop thread (Node 26, Windows), 64-point hulls unless noted:

| Query | Time |
| --- | --- |
| `segmentClearanceInto`, clear / overlapping | 0.40 / 5.7 us |
| `hullClearanceInto`, clear / deep overlap | 0.59 / 12 us |
| `evaluateInto`, point outside / inside | 0.29 / 5.1 us |
| `solve`, first pose clear, 3 hull colliders and 2 link hulls | 9.4 us (16 points: 5.8 us; 3 capsule colliders and capsule links: 4.1 us) |
| `solve`, no clear pose, all 34 candidates tried, limb-shaped hulls | 0.44 ms (16 points: 0.17 ms) |
| `solve`, no clear pose, a round hull nested in a round hull, the slowest shape found | 1.9 ms (16 points: 0.27 ms); a lower `searchBudget` limits it |

## Swept collision (`margoengine/kinematics-constraints/swept`)

`solve` and `clearance` look at one instant, so an arm that moves far in one frame can pass straight through a thin wall with both of its poses clear. A swept check looks at the whole motion. Each step measures the gap, and no point of a shape can close that gap faster than its motion bound, so the check can jump that far and no farther (conservative advancement). It never steps past a contact, however thin the obstacle or fast the move.

```ts
import { AvoidanceSolver, ConvexHullVolume, SolveStatus, type ElbowEvaluator } from 'margoengine/kinematics-constraints';
import { sweepChain } from 'margoengine/kinematics-constraints/swept';

// A thin plate the forearm must not cross.
const plate = new ConvexHullVolume({ points: [0.6, 0, -1, 2, 0, -1, 0.6, 0, 1, 2, 0, 1] });
const solver = new AvoidanceSolver([plate], { minClearance: 0.02, complianceMargin: 0, targetRadius: 0.05 });

// Unit bones: the elbow stands on a circle round the root to hand line.
const elbowAt: ElbowEvaluator = (_root, hand, angle, out) => {
  const reach = Math.hypot(hand[0], hand[1], hand[2]), height = Math.sqrt(1 - (reach / 2) ** 2);
  const x = hand[0] / reach, y = hand[1] / reach;
  out[0] = (x * reach) / 2 - y * height * Math.cos(angle);
  out[1] = (y * reach) / 2 + x * height * Math.cos(angle);
  out[2] = height * Math.sin(angle);
};

const root = [0, 0, 0] as const;
const hand = [1, 0.8, 0] as const;
const elbow = new Float32Array(3);
elbowAt(root, hand, Math.PI / 2, elbow);

// One big frame, to the far side of the plate. Both poses are clear, so the solver says yes.
const next = solver.solve(root, hand, [1, -0.8, 0], 1, 1, 0.05, 0.05, 1, elbowAt, { swivelSpeedLimit: 10, searchBudget: 64 });
if (next.status === SolveStatus.Success) {
  const motion = sweepChain([root, elbow, hand], [root, next.elbow, next.target], [plate], {
    radius: 0.05,
    minClearance: 0.01, // below the solver's gap, or the start pose already counts as a contact
  });
  if (!motion.clear) console.log('blocked at', motion.time, 'by collider', motion.collider);
}
```

| Check | Motion it certifies |
| --- | --- |
| `sweepChain(from, to, colliders, {radius, jointRadius?, ...})` | `from` and `to` list joint positions. The root moves on a line, each bone turns on its shortest arc with its length held, so the output of `AvoidanceSolver` goes straight in. `radius` and `jointRadius` are one number or one per link and joint. |
| `sweepHull(hull, from, to, colliders, options?)` | Two matrices of rotation, positive scale and translation: a line for the translation, the shortest arc about the hull's origin, the scale eased. For a link hull, pass its bone's world matrices. The hull is left at `to`. |

| Option | Default | Meaning |
| --- | --- | --- |
| `minClearance` | `0` | Gap the motion must keep. |
| `tolerance` | `1e-4` | A gap this close to `minClearance` counts as reached. It also sets the smallest step. |
| `maxSteps` | `4096` | Most poses tested. Running out gives `exhausted`, never `clear`. |

The result holds `clear`, `exhausted`, `time` (the first contact from 0 to 1, or 1 when clear), `clearance` (the smallest gap at a tested pose, beyond `minClearance`), `steps`, `shape` and `collider`. `time` is never later than the true contact, so the pose there is a safe place to stop. A hull needs colliders with `hullClearanceInto`; every built-in collider has it. Colliders hold still during a check: step a moving obstacle yourself. A motion that starts within the gap stops at time 0.

## Concave obstacles (`margoengine/kinematics-constraints/sdf`)

A sphere, a capsule or a convex hull cannot have a hole or a hollow: a hull round a ring fills the ring, and a hull round a bowl fills the bowl. `MeshVolume` and `SDFVolume` take the shape itself. They work anywhere a collider does, in `AvoidanceSolver`, the swept checks, and for link hulls too.

```ts
import { MeshBVH } from 'margoengine/bvh';
import { bakeSDF } from 'margoengine/bvh/sdf';
import { MeshVolume, SDFVolume } from 'margoengine/kinematics-constraints/sdf';
import { sweepChain } from 'margoengine/kinematics-constraints/swept';

// A closed box as a stand-in for your mesh: pass your own positions and indices.
const positions = new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]);
const indices = new Uint32Array([
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
]);
const bvh = MeshBVH.build({ positions, indices });

const exact = new MeshVolume({ bvh }); // exact distances, through the tree
const baked = new SDFVolume({ field: bakeSDF(bvh, { resolution: 32 }) }); // a fixed cost per reading

// A ball on a straight line: both joints of the chain at one point.
const from = [[-4, 0, 0], [-4, 0, 0]] as const;
const to = [[4, 0, 0], [4, 0, 0]] as const;
for (const obstacle of [exact, baked]) {
  const hit = sweepChain(from, to, [obstacle], { radius: 0.1 });
  console.log(hit.clear, hit.time);
}
```

| `new MeshVolume({bvh, matrix?, solid?})` | Default | Meaning |
| --- | --- | --- |
| `bvh` | Required | A `MeshBVH` from `margoengine/bvh`. Its triangles stay in the tree's own space. |
| `matrix` | Identity | Rotation, one uniform scale and a move. `setTransform(matrix)` moves it later. |
| `solid` | `true` | A closed mesh has an inside, by winding number: a point in it reads negative. `false` treats the mesh as a thin sheet, for an open surface such as a terrain or a bowl with no back, and reads the plain distance. |

| `new SDFVolume({field, matrix?, margin?, precision?, lipschitz?, maxCells?})` | Default | Meaning |
| --- | --- | --- |
| `field` | Required | `bakeSDF`'s `MeshSDF`, or any `{distance(point)}`, such as an analytic shape. |
| `matrix` | Identity | As above. |
| `margin` | A grid: one cell's diagonal. A function: `0` | Taken off every reading. A trilinear reading can overstate a true distance by up to a cell's diagonal, so with this default the volume never reports a gap the mesh does not leave. |
| `precision` | A quarter of a cell, or `1e-3` | How close a shape's smallest reading is pinned down. |
| `lipschitz` | A grid: the square root of 3. A function: `1` | Fastest the field changes per unit of distance. A function that is not a true distance must say so here. |
| `maxCells` | `4096` | Most cells one query opens. A query that runs out still answers with a safe lower bound. |

`MeshVolume` is exact and pays for it per query. `SDFVolume` costs the same whatever the mesh, and is only as fine as its grid: a wall thinner than a cell may not be there at all, which is why the margin matters, and a coarse field reads obstacles fatter than they are. A grid field must hold the whole obstacle: past the grid's edge a reading is the distance to the grid. Segment and hull queries on both answer no more than the true gap, so the swept checks keep their promise. A segment that crosses a mesh reads minus its radius, and an overlapping hull reads zero or less: the value ranks poses, it is not a depth. This entry needs `@margoengine/bvh`, an optional peer of this package, and only this entry does.

## Scope

`Success` describes static analytical proxy clearance at one evaluated instant, within numerical tolerance. It covers neither unsupplied mesh/skinning geometry nor unchecked link portions. Set proxies to enclose the full deformation envelope and any desired padding in your application.

Motion between frames is checked by `/swept` above. Concave obstacles are in `/sdf`. This package does not implement dynamics, or a formal industrial/physical robot safety system. It cannot certify an interpolated animation or real machine trajectory. A bounded unsuccessful search is not proof of infeasibility; the application decides whether to hold, reduce the requested motion, or reposition the target.
