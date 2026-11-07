# @margoengine/splines

Import `margoengine/splines` from the `margoengine` package, or `@margoengine/splines` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Piecewise 3D Catmull-Rom, cubic Bezier, cubic Hermite, uniform B-spline and Kochanek-Bartels curves, with a cached arc-length lookup, closest point, stable frames, knot editing, mesh placement and bending, and curve fitting.

```ts
import {Spline} from 'margoengine/splines';
const curve = new Spline([[0,0,0], [5,1,5], [10,0,10]]);
const point = new Float64Array(3);
curve.atDistance(curve.length / 2, point);
curve.tangent(0.5, point);
```

Bezier curves require 3n+1 points and are open. Hermite requires one tangent per point; Catmull-Rom and Hermite can be closed. at uses t in 0..1; atDistance uses world units. Returned default output is reused, so provide an output buffer to retain multiple results. After editing points, call updateArcLengths. Arc lengths/tangents are numerical approximations controlled by divisions.

## More curve types

`kind: 'bspline'` is the uniform cubic B-spline: smoother than Catmull-Rom (continuous curvature) but it only pulls toward interior points, so it does not pass through them; open curves start and end exactly at the first and last point. `kind: 'kochanek-bartels'` passes through every point and adds `tension`, `continuity` and `bias`, each -1 to 1 and 0 by default (all zero is Catmull-Rom).

```ts
const waypoints: [number, number, number][] = [[0, 2, 0], [5, 3, 5], [10, 2, 10], [15, 4, 5]];
const camera = new Spline(waypoints, {kind: 'kochanek-bartels', tension: 0.3, bias: -0.2});
const smooth = new Spline(waypoints, {kind: 'bspline', closed: true});
```

## Closest point (`@margoengine/splines/closest`)

```ts
import {Spline} from 'margoengine/splines';
import {closestPointOnSpline} from 'margoengine/splines/closest';
const curve = new Spline([[0, 0, 0], [5, 1, 5], [10, 0, 10]]);
const hit = closestPointOnSpline(curve, [3, 1, 4]);
// hit.t (0..1), hit.arc (world units along the curve), hit.point, hit.distance
```

It samples the curve (`samples`, default the spline's `divisions`), then bisects on the slope of the distance around the best sample. A curve that passes close to itself (a tight spiral) needs `samples` high enough to tell the passes apart. `distanceAt(spline, t)` and `parameterAt(spline, distance)` convert between `t` and arc length.

## Stable frames and roll (`@margoengine/splines/frames`)

```ts
import {Spline} from 'margoengine/splines';
import {SplineFrames} from 'margoengine/splines/frames';
const curve = new Spline([[0, 0, 0], [5, 1, 5], [10, 0, 10]]);
const frames = new SplineFrames(curve, {up: [0, 1, 0], roll: (t) => t * 0.5});
const frame = frames.frameAt(curve.length * 0.25);
// frame.position, frame.tangent, frame.normal, frame.binormal (binormal = tangent x normal)
```

Frames are carried along the curve by double reflection (rotation-minimising), so they do not flip where a fixed up vector would (a curve passing through the up direction). `roll` is radians about the tangent: a function of `t`, or one value per knot (`knotCount(curve)`, blended linearly). A closed curve's twist is spread over its length so the last frame meets the first (`closeLoop: false` turns that off). Frames are sampled at `samples` (default 256) steps and blended in between.

## Knot editing (`@margoengine/splines/knots`)

```ts
import {KnotPath} from 'margoengine/splines/knots';
const path = new KnotPath([
  {position: [0, 0, 0], data: [1]},
  {position: [4, 3, 0], data: [2]},
  {position: [8, 0, 0], mode: 'linear', data: [4]},
]);
path.insertAt(0, 0.5);                 // split the first segment; the curve does not move
path.setMode(1, 'broken', {tangentOut: [0, 2, 0]});
const spline = path.toSpline();        // a Bezier Spline
const width = path.dataAt(0.7)[0];     // per-knot numbers blended along the curve
const [a, b] = path.split(2);          // two paths sharing knot 2
```

Modes: `auto` (smooth through the knot), `linear` (handles point at the neighbors; a segment between two linear knots is straight) and `broken` (the stored `tangentIn` and `tangentOut`, so a corner can point any way). `insertAt` keeps the shape by turning the new knot and its two neighbors `broken`; pass `false` as the third argument to insert an `auto` knot and let the curve reshape. A closed path builds an open Bezier whose last point is its first.

## Place and deform along a spline (`@margoengine/splines/mesh`)

```ts
import {boxGeometry} from 'margoengine/geometry';
import {Spline} from 'margoengine/splines';
import {placeAlongSpline, deformAlongSpline} from 'margoengine/splines/mesh';
const curve = new Spline([[0, 0, 0], [5, 1, 5], [10, 0, 10]]);
const posts = placeAlongSpline(curve, {spacing: 2.5, fit: true, forward: 'z'});
// posts.matrices: count column-major 4x4 matrices, ready for an instance buffer
const {positions, normals} = boxGeometry(0.2, 0.2, 1, 1, 1, 16);
const pipe = deformAlongSpline(curve, positions, {axis: 'z', normals, fit: 'stretch'});
// pipe.positions, pipe.normals
```

`frameBasis(frame, forward)` gives that same turn for one frame. `placeAlongSpline` puts the mesh's `forward` axis along the tangent with its up axis on the frame normal (`frames` takes `SplineFrames` options or a ready instance; `align: false` keeps every instance upright). `deformAlongSpline` turns each vertex's coordinate along `axis` into a distance along the curve and its other two coordinates into offsets in the frame there; `fit: 'stretch'` scales the mesh to the curve's length and `overflow` chooses between continuing straight past the ends or holding the end frame. A mesh bends in straight chords between its vertices, so subdivide long pieces first. Normals are rotated with the frame, not re-derived.

## Fit a spline to points (`@margoengine/splines/fit`)

```ts
import {fitSpline} from 'margoengine/splines/fit';
const gpsTrack: [number, number, number][] = [[0, 0, 0], [3, 0, 1], [6, 0, 1.5], [9, 0, 1], [12, 0, 0]];
const {spline, points, pieces, maxError} = fitSpline(gpsTrack, {tolerance: 0.5});
```

Every input point ends up within `tolerance` of the returned cubic Bezier curve (`maxError` is the measured worst, at most `tolerance`). Pieces are cut at the worst point where one cubic misses; repeated points are dropped. The result is a `kind: 'bezier'` spline of `3 * pieces + 1` control points.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/splines

