# @margoengine/kinematics-constraints

Standalone capsule and sphere avoidance for IK targets and two-bone chains. The package projects targets out of proxy volumes, checks elbow and link clearance, and searches a shoulder swivel angle through a caller-supplied IK evaluator. It has no engine, renderer, physics, or Wasm dependency. ESM exports and declarations are tree-shakable; core, stage, animation, and the existing IK kernels remain unchanged.

Version `0.1.0` is source-only and has not been published to npm. From the repository root:

```sh
npm ci
npm run build --workspace @margoengine/kinematics-constraints
npm run test --workspace @margoengine/kinematics-constraints
npm pack --workspace @margoengine/kinematics-constraints --pack-destination test-results
```

Install the resulting tarball in another project with `npm install ./margoengine-kinematics-constraints-0.1.0.tgz`. No core peer dependency is required. The package is MIT licensed.

## Interactive arm demo

From the repository root, run:

```sh
npm run modern:dev:extensions
```

Open [http://127.0.0.1:5173/examples/kinematics-constraints.html](http://127.0.0.1:5173/examples/kinematics-constraints.html). If Vite reports a different port, use that port with the same path. Drag the orange request through the torso; the accepted hand stays outside the capsule and the elbow swivels for link clearance. The demo includes collision envelopes, a torso sweep, a swivel speed control, a dead-zone target, pause, and reset. Unresolved calls hold the previous accepted pose.

The [demo source](../../examples/kinematics-constraints.html) includes an analytical elbow callback that reuses vector storage. It transports the last accepted bend reference between reach directions, so overhead and cross-body motion keep one continuous angle convention. Pointer rays meet a curved drag surface in front of the torso and waist; unresolved requests still hold the accepted pose. The demo renders proxy geometry directly and does not skin a character. Reused buffers do not guarantee that the JavaScript runtime or renderer performs no allocations.

## Controller integration

Use one `AvoidanceSolver` per chain. Supply the initial hand and elbow from a known safe pose, use one common coordinate frame, and choose one scene unit consistently. This complete TypeScript controller accepts an evaluator from your pure IK kernel. The evaluator must use the same bone lengths passed to the controller.

```ts
import {
  AvoidanceSolver, CapsuleVolume, SolveStatus,
  type ElbowEvaluator, type SolveOptions, type Vec3View,
} from '@margoengine/kinematics-constraints';

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

Geometry normals at a sphere center or capsule axis use deterministic fallback directions. Output vectors must be writable, distinct, and nonoverlapping. Vector inputs are three-element tuples, `Float32Array`, or `Float64Array`. A custom `ConstraintVolume` must provide a signed-distance `evaluate` with unit normals and an exact `segmentClearance`; sampling only segment endpoints cannot satisfy that contract.

The built-in solver/volume hot paths reuse their vector and result storage and do not explicitly create per-call JavaScript containers when passed reused inputs/options. JavaScript engines can still allocate temporary numeric values at builtin and function boundaries: browser profiling observes allocation and minor garbage collection even with warmed reused buffers. This is not a zero-allocation or zero-GC guarantee. Caller callbacks, pose adapters, and UI code also control their own allocations. `closestPointsBetweenSegments` allocates a result when `out` is omitted; supply a reused `SegmentDistanceResult` with distinct `pointA`/`pointB` vectors to reuse that storage. This package makes no fixed runtime or frame-rate claim.

Point and link queries on unchanged built-in spheres and capsules use internal destination-passing paths into solver-owned `Float64Array` slots. Private pose checks also write their clearance into reused storage. The public `evaluate(...): number` and `segmentClearance(...): number` signatures and all numerical guards remain intact. Custom volumes and overridden methods continue through those public contracts; they do not need additional methods. This avoids numeric return boundaries for built-in queries and private pose checks, while other runtime allocation sites remain measurable.

Reach bounds and search span use private scalar storage. Reach clamping evaluates its norm locally with the same scaled fallback used for tiny coordinates. Search retains accepted numeric angles and reuses a preceding candidate argument only when the new value is exactly equal, including its zero sign. Every candidate still invokes the callback in the original order. A fresh angle passed to an uninlined numeric IK callback can still require boxing; moving that angle through internal scratch would not remove the public callback boundary. Allocation behavior also depends on the runtime's compilation tier.

Run `node scripts/profile-kinematics-constraints.js` from the repository root to capture warmed solver-only workloads, a rendered target sweep, and trusted pointer dragging. Repeat with `--gc-only` to measure heap/GC without the allocation sampler. Reports, allocation stacks, and traces are written to `test-results`; sampled bytes per solve/frame are estimates, not exact allocation counts. The script defaults to Edge with a software GPU for reproducibility and honors `BROWSER_ARGS` when profiling physical hardware. Each report records the selected adapter.

For actual V8 object types, run `node scripts/profile-kinematics-constructors.js` using a Node build that supports GC object statistics (validated with Node 24), or supply `--node=/path/to/node`. It compares a warmed solver burst against a callback/control loop, saves dead-object counts and retained heap snapshots, and records the runtime and bundle hash. `--label=name` preserves separate captures; `--skip-snapshots` skips the retained-object comparison. The default fixture has one capsule; `--colliders=4` separately measures two capsules and two spheres. Snapshots force collection and therefore cannot count discarded transient allocations; the dead-object census and sampled call stacks provide separate evidence.

Geometry helpers reject nonfinite components or magnitudes above `1e100` and keep their calculations in JavaScript number precision. Solver input positions must additionally fit finite Float32 values because accepted targets/elbows use Float32 storage. Float32 range does not imply useful precision at large world coordinates: use a local frame and units where bone lengths, radii, and `tolerance` remain representable. Inputs outside supported ranges throw rather than being silently accepted.

## Scope

`Success` describes static analytical proxy clearance at one evaluated instant, within numerical tolerance. It covers neither unsupplied mesh/skinning geometry nor unchecked link portions. Set proxies to enclose the full deformation envelope and any desired padding in your application.

This package does not implement continuous collision detection, swept-path planning between frames, mesh collision, a joint-limit solver, dynamics, or a formal industrial/physical robot safety system. It cannot certify an interpolated animation or real machine trajectory. A bounded unsuccessful search is not proof of infeasibility; the application decides whether to hold, reduce the requested motion, reposition the target, or use a higher-level planner.
