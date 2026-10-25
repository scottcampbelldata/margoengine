# @margoengine/navmesh

Install `npm i margoengine` and import `margoengine/navmesh` (or this package alone: `npm i @margoengine/navmesh`, imported as `@margoengine/navmesh`; the two are the same module).

Dependency-free navigation: A* chooses a polygon corridor, the funnel algorithm pulls it taut, reciprocal ORCA selects collision-avoiding agent velocities in XZ, and `@margoengine/navmesh/build` generates the walkable polygons from level triangles.

```ts
import {NavMesh} from 'margoengine/navmesh';
const mesh = new NavMesh([[0,0,0], [10,0,0], [0,0,10]], [[0,1,2]]);
const path = mesh.path([1,0,1], [2,0,2]);
```

Polygons must be strictly convex, planar and nonvertical. Neighbor polygons share vertex-index edges; welded coordinates with different indices do not link. Outside or disconnected endpoints return null. Paths use supplied endpoint heights and portal vertex heights. The bounded open set uses a binary heap (4096 polygons maximum). Shared-edge portals are oriented from the source polygon, independently of polygon winding or center-to-center alignment. Agent radii are handled by avoid(), not by corridor inset: build an already-eroded walkable mesh (the generator below does). ORCA expects current velocities and preferred velocities for all reciprocal agents, uses seconds, and bounds output by maxSpeed; when no velocity avoids every neighbor it returns the one that breaks the constraints least. Static-wall constraints are not generated here.

## Generating a navmesh from triangles (`./build`)

```ts
import {Navigation, buildNavMesh} from 'margoengine/navmesh/build';
import {avoid} from 'margoengine/navmesh';

// Flat xyz positions and triangle indices of the level (Y up, any winding).
const nav = await Navigation.create(positions, indices, {cs: 0.25, ch: 0.1, walkableRadius: 2});
const route = nav.path({x: -8, y: 0, z: -8}, {x: 8, y: 0, z: 8}); // [{x, y, z}, ...] or null
nav.dispose();

// Or keep the plain NavMesh for locate() and your own queries.
const mesh = buildNavMesh(positions, indices, {cs: 0.25, ch: 0.1});
```

The generator voxelises the walkable triangles (slope below `walkableSlopeAngle`) into `cs` x `ch` cells, drops cells without `walkableHeight` clearance and ledges that drop more than `walkableClimb`, steps onto low obstacles within `walkableClimb`, erodes the walkable area by `walkableRadius`, splits it into hole-free regions, traces and simplifies their borders (`maxSimplificationError`, `maxEdgeLen` for wall edges) and merges triangles into convex polygons of up to `maxVertsPerPoly` vertices. Slopes rise by their own gradient from cell to cell, so a ramp below the slope limit stays connected even when one cell's rise exceeds `walkableClimb`. Option names and defaults:

| Option | Default | Unit |
| --- | --- | --- |
| `cs`, `ch` | 0.2, 0.2 | world units |
| `walkableSlopeAngle` | 60 | degrees, < 90 |
| `walkableHeight`, `walkableClimb`, `walkableRadius` | 2, 2, 0.5 | voxels |
| `maxEdgeLen`, `maxSimplificationError` | 12, 1.3 | voxels (0 = no edge limit) |
| `minRegionArea`, `mergeRegionArea` | 8, 20 | cells |
| `maxVertsPerPoly` | 6 | 3..6 |
| `detailSampleDist`, `detailSampleMaxError` | 6, 1 | world units; with a distance > 0 vertex heights come from the original triangles and polygons only merge while that surface stays within the error of their plane |
| `borderSize` | 0 | voxels; accepted, no effect on a single mesh |
| `buildBvTree` | true | spatial index for endpoint snapping |

`path` snaps an end that is off the mesh to the nearest walkable point within `walkableRadius + 4` cells across and `walkableHeight + walkableClimb + 2` voxels up or down; an end standing on the mesh is used as given. Both ends at the same point give a one-point path. Limits: 3,000,000 position values, 6,000,000 indices, `ceil(xSize / cs) * ceil(zSize / cs)` at most 16,000,000 cells, and the NavMesh limits on the result (4096 polygons, 100,000 vertices: raise `cs` or `maxEdgeLen` for bigger levels). `create` is async for compatibility and rejects for invalid input; a level with nothing walkable rejects with a `MargoError` of code `failed`.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/navmesh
