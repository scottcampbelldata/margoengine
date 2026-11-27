# @margoengine/robot-planning

Import `margoengine/robot-planning` from the `margoengine` package, or `@margoengine/robot-planning` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Robot arms on [`@margoengine/kinematics-constraints`](../kinematics-constraints/README.md): a tree of revolute, prismatic, continuous, fixed and mimic joints with capsule and convex hull collision shapes, a swept check of a whole joint-space motion, inverse kinematics that keeps every joint in range and every link clear, sampling planners (RRT-Connect and a reusable roadmap), a URDF reader, and a WebGPU batch that measures the clearance of thousands of poses at once. Obstacles are the volumes of kinematics-constraints: spheres, capsules, convex hulls, and from its `/sdf` entry meshes and baked distance fields. No renderer, physics or Wasm is needed.

Version `0.1.0` is source-only and has not been published to npm. From the repository root:

```sh
npm ci
npm run build --workspace @margoengine/robot-planning
npm run test --workspace @margoengine/robot-planning
```

The package is Apache-2.0 licensed. `@margoengine/kinematics-constraints` is a required peer; `@margoengine/loaders` (URDF XML and STL meshes) and `@margoengine/geometry` (mesh hulls) are optional peers the `/urdf` entry loads.

## Entries

| Entry | What it holds |
| --- | --- |
| `@margoengine/robot-planning` | `Robot` (forward kinematics, motion bounds, clearance, self collision) and `sweepRobot` |
| `@margoengine/robot-planning/limits` | `JointLimitSolver` and `armRobot`: damped least squares IK with joint ranges as bounds and a velocity damper per obstacle |
| `@margoengine/robot-planning/plan` | `planPath`, `planPathSync`, `planToPose` and `Roadmap`: RRT-Connect, a probabilistic roadmap and shortcutting, every edge checked with `sweepRobot` |
| `@margoengine/robot-planning/urdf` | `parseURDF` and `loadURDF`: a URDF description as a `Robot`, meshes reduced to convex hulls |
| `@margoengine/robot-planning/gpu` | `GPUClearance`: the clearance of many poses at once in a WebGPU compute pass, and `gridData` for the baked fields it uploads |

## A robot and a swept check

```ts
import { CapsuleVolume } from '@margoengine/kinematics-constraints';
import { Robot, sweepRobot } from '@margoengine/robot-planning';

const arm = new Robot({
  joints: [{ lower: -3, upper: 3 }],
  shapes: [{ joint: 0, end: [1, 0, 0], radius: 0.05 }],
});
const wall = new CapsuleVolume({ start: [0.7, 0.7, -1], end: [0.7, 0.7, 1], radius: 0.01 });
const hit = sweepRobot(arm, [0], [2], [wall]); // both ends are clear; the motion is not
console.log(hit.clear, hit.time);
```

`sweepRobot` is conservative advancement with a per-link motion bound: no step can jump a collider, however thin or fast. A budget that runs out reads `exhausted`, never clear.

## Planning around an obstacle

```ts
import { ConvexHullVolume } from '@margoengine/kinematics-constraints';
import { Robot } from '@margoengine/robot-planning';
import { planPath } from '@margoengine/robot-planning/plan';

const arm = new Robot({
  joints: [{ lower: -3, upper: 3 }, { lower: -3, upper: 3, origin: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1] }],
  shapes: [{ joint: 1, end: [1, 0, 0], radius: 0.05 }],
});
const wall = new ConvexHullVolume({ points: [1.5, -0.2, -1, 1.5, -0.2, 1, 3, -0.2, -1, 3, -0.2, 1] });
const plan = await planPath(arm, [0.3, 0], [-0.3, 0], { colliders: [wall], seed: 7 });
if (plan.status === 'found') console.log(plan.path.length, plan.length);
```

## GPU clearance

`GPUClearance` runs forward kinematics and GJK per pose in a compute pass and reads back one gap per pose, for filtering candidate poses before the exact CPU checks. Its error against the f64 CPU answer is bounded and checked on a real GPU by `npm run test:gpu -w packages/robot-planning` (from the repository root, after building packages).

## Tests and fixtures

The URDF tests read the Franka Emika Panda description from example-robot-data (Apache-2.0, `tests/fixtures/panda`, see `tests/fixtures/NOTICE.md`). Fixtures are not part of the published package.
