# @margoengine/navmesh

Import `margoengine/navmesh` from the `margoengine` package, or `@margoengine/navmesh` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Dependency-free navigation: A* chooses a polygon corridor, the funnel algorithm pulls it taut, reciprocal ORCA selects collision-avoiding agent velocities in XZ, a `Crowd` manager walks agents along routes with area costs, off-mesh links and obstacles, and `@margoengine/navmesh/build` generates the walkable polygons from level triangles.

```ts
import {NavMesh} from 'margoengine/navmesh';
const mesh = new NavMesh([[0,0,0], [10,0,0], [0,0,10]], [[0,1,2]]);
const path = mesh.path([1,0,1], [2,0,2]);
```

Polygons must be strictly convex, planar and nonvertical. Neighbor polygons share vertex-index edges; welded coordinates with different indices do not link. Outside or disconnected endpoints return null. Paths use supplied endpoint heights and portal vertex heights. The bounded open set uses a binary heap (4096 polygons maximum). Shared-edge portals are oriented from the source polygon, independently of polygon winding or center-to-center alignment. Agent radii are handled by avoid(), not by corridor inset: build an already-eroded walkable mesh (the generator below does). ORCA expects current velocities and preferred velocities for all reciprocal agents, uses seconds, and bounds output by maxSpeed; when no velocity avoids every neighbor it returns the one that breaks the constraints least. Static-wall constraints are not generated here; a neighbour with `reciprocal: false` (an obstacle, a player) leaves all of the avoidance to the agent.

## Crowds, area costs, off-mesh links and obstacles

```ts
import {Crowd, NavMesh} from 'margoengine/navmesh';

// Two 4 x 4 m rooms with a 1 m gap between them (x 4 to 5).
const nav = new NavMesh(
  [[0,0,0], [4,0,0], [4,0,4], [0,0,4], [5,0,0], [9,0,0], [9,0,4], [5,0,4]],
  [[0,1,2,3], [4,5,6,7]],
);
nav.addOffMeshLink([3.8,0,2], [5.2,0,2]); // a jump across the gap, both ways
nav.setAreaCost(nav.locate([7,0,2]), 3); // the second room is mud: routes avoid it when they can

const crowd = new Crowd(nav, {neighborDistance: 5, maxNeighbors: 10, timeHorizon: 2});
const guard = crowd.addAgent({position: [1,0,1], radius: 0.4, maxSpeed: 3.5});
const visitor = crowd.addAgent({position: [8,0,3], radius: 0.4});
guard.setTarget([8,0,1]);
visitor.setTarget([1,0,3]);
const removeCrate = crowd.addObstacle({position: [2,0,2], radius: 0.5}); // agents steer around it
crowd.on('arrive', (agent) => console.log('arrived', agent.id));
let last = performance.now();
const frame = (now: number) => {
  crowd.update(Math.min(0.1, (now - last) / 1000));
  last = now;
  // guard.position, guard.velocity and guard.state ('moving', 'offmesh', 'arrived', ...) drive your character.
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
console.log(nav.route([1,0,1], [8,0,1])?.offMesh, removeCrate);
```

- **Crowd.** `crowd.update(dt)` plans each agent's route (A*, funnel), steers toward the next corner, slows over `slowDownDistance` (1) and stops within `arrivalDistance` (0.1), picks a collision-free velocity with ORCA among its `maxNeighbors` (10) nearest agents and obstacles within `neighborDistance` (5), limits the change to `maxAcceleration` (8 per second), and keeps it on the mesh (it slides along edges it would leave by). Agents default to `radius` 0.4 and `maxSpeed` 3.5. `setTarget`, `stop`, `teleport` and `remove` steer one agent; targets and start points off the mesh move to the nearest mesh point. `on('arrive')` and `on('unreachable')` report journeys. Idle and arrived agents still give way to others.
- **Area costs.** `nav.setAreaCost(polygon, cost)` multiplies the cost of walking through a polygon (1 by default; `Infinity` blocks it, like a closed door). `locate(point)` finds the polygon under a point. Agents replan when a cost or link changes (`nav.version` counts the changes).
- **Off-mesh links.** `nav.addOffMeshLink(start, end, {bidirectional, cost})` joins the polygons under its two ends (a jump, a ladder, a teleporter); `removeOffMeshLink(id)` drops it. `nav.route(start, end)` returns `{points, offMesh}`, where `offMesh` lists the points from which a segment crosses a link; agents cross links straight, at their speed, as state `'offmesh'`.
- **Obstacles.** Three kinds: `crowd.addObstacle({position, radius, velocity?})` for moving or temporary things agents steer around without replanning (avoidance is one-sided, as for anything that does not give way: an `avoid()` neighbour with `reciprocal: false`); `setAreaCost(polygon, Infinity)` to close a polygon to routes; and `obstacles: [{min, max}]` boxes in the `./build` options, carved out of the walkable area (kept `walkableRadius` clear) when the mesh is built, for lasting changes. Rebuilding is the way to move a carved box.
- **Queries.** `closestPoint(point)` gives the nearest mesh point and its polygon, `heightAt(polygon, x, z)` the surface height, `polygonCount` and `polygonCenter(i)` the polygons.

## Generating a navmesh from triangles (`./build`)

```ts
import {Navigation, buildNavMesh} from 'margoengine/navmesh/build';
import {avoid} from 'margoengine/navmesh';

// Flat xyz positions and triangle indices of the level (Y up, any winding): here a 20 x 20 m floor.
const positions = [-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, 10], indices = [0, 2, 1, 0, 3, 2];
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
| `obstacles` | [] | `{min, max}` world-space boxes carved out of the walkable area |

`path` snaps an end that is off the mesh to the nearest walkable point within `walkableRadius + 4` cells across and `walkableHeight + walkableClimb + 2` voxels up or down; an end standing on the mesh is used as given. Both ends at the same point give a one-point path. Limits: 3,000,000 position values, 6,000,000 indices, `ceil(xSize / cs) * ceil(zSize / cs)` at most 16,000,000 cells, and the NavMesh limits on the result (4096 polygons, 100,000 vertices: raise `cs` or `maxEdgeLen` for bigger levels). `create` is async for compatibility and rejects for invalid input; a level with nothing walkable rejects with a `MargoError` of code `failed`.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/navmesh
