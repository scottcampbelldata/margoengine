# @margoengine/navmesh

Import `margoengine/navmesh` from the `margoengine` package, or `@margoengine/navmesh` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Dependency-free navigation: A* chooses a polygon corridor, the funnel algorithm pulls it taut, reciprocal ORCA selects collision-avoiding agent velocities in XZ, a `Crowd` manager walks agents along routes with area costs, off-mesh links and obstacles, `@margoengine/navmesh/build` generates the walkable polygons from level triangles, and `@margoengine/navmesh/tiles` cuts big worlds into tiles that rebuild at run time.

```ts
import {NavMesh} from 'margoengine/navmesh';
const mesh = new NavMesh([[0,0,0], [10,0,0], [0,0,10]], [[0,1,2]]);
const path = mesh.path([1,0,1], [2,0,2]);
```

Polygons must be strictly convex, planar and nonvertical. Neighbor polygons share vertex-index edges; welded coordinates with different indices do not link. Outside or disconnected endpoints return null. Paths use supplied endpoint heights and portal vertex heights. The bounded open set uses a binary heap (4096 polygons maximum; `./tiles` goes past that). Shared-edge portals are oriented from the source polygon, independently of polygon winding or center-to-center alignment. Agent radii are handled by avoid(), not by corridor inset: build an already-eroded walkable mesh (the generator below does). ORCA expects current velocities and preferred velocities for all reciprocal agents, uses seconds, and bounds output by maxSpeed; when no velocity avoids every neighbor it returns the one that breaks the constraints least. Static-wall constraints are not generated here; a neighbour with `reciprocal: false` (an obstacle, a player) leaves all of the avoidance to the agent.

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
  crowd.update(Math.min(0.1, Math.max(0, now - last) / 1000)); // a frame's time can be just before the first performance.now()
  last = now;
  // guard.position, guard.velocity and guard.state ('moving', 'offmesh', 'arrived', ...) drive your character.
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
console.log(nav.route([1,0,1], [8,0,1])?.offMesh, removeCrate);
```

- **Crowd.** `crowd.update(dt)` plans each agent's route (A*, funnel), steers toward the next corner, slows over `slowDownDistance` (1) and stops within `arrivalDistance` (0.1), picks a collision-free velocity with ORCA among its `maxNeighbors` (10) nearest agents and obstacles within `neighborDistance` (5), limits the change to `maxAcceleration` (8 per second), and keeps it on the mesh (it slides along edges it would leave by). Agents default to `radius` 0.4 and `maxSpeed` 3.5. `setTarget`, `stop`, `teleport` and `remove` steer one agent; targets and start points off the mesh move to the nearest mesh point. `on('arrive')` and `on('unreachable')` report journeys. Idle and arrived agents still give way to others.
- **Area costs.** `nav.setAreaCost(polygon, cost)` multiplies the cost of the walk across a polygon, from the portal a route enters by to the one it leaves by (1 by default; `Infinity` blocks it, like a closed door). `locate(point)` finds the polygon under a point. Agents replan when a cost or link changes (`nav.version` counts the changes).
- **Off-mesh links.** `nav.addOffMeshLink(start, end, {bidirectional, cost})` joins the polygons under its two ends (a jump, a ladder, a teleporter); `removeOffMeshLink(id)` drops it. `nav.route(start, end)` returns `{points, offMesh}`, where `offMesh` lists the points from which a segment crosses a link; agents cross links straight, at their speed, as state `'offmesh'`.
- **Obstacles.** Three kinds: `crowd.addObstacle({position, radius, velocity?})` for moving or temporary things agents steer around without replanning (avoidance is one-sided, as for anything that does not give way: an `avoid()` neighbour with `reciprocal: false`); `setAreaCost(polygon, Infinity)` to close a polygon to routes; and `obstacles: [{min, max}]` boxes in the `./build` options, carved out of the walkable area (kept `walkableRadius` clear) when the mesh is built, for lasting changes. Rebuilding is the way to move a carved box; `./tiles` rebuilds only the tiles it reaches.
- **Queries.** `closestPoint(point)` gives the nearest mesh point and its polygon, `heightAt(polygon, x, z)` the surface height, `polygonCount`, `polygonCenter(i)`, `polygonVertices(i)` and `polygonLinks(i)` the polygons.

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
| `areas` | [] | `{min, max, area}` world-space boxes of marked ground, area numbers 1 to 255, for route filters (`./agents`) |

`path` snaps an end that is off the mesh to the nearest walkable point within `walkableRadius + 4` cells across and `walkableHeight + walkableClimb + 2` voxels up or down; an end standing on the mesh is used as given. Both ends at the same point give a one-point path. Limits: 3,000,000 position values, 6,000,000 indices, `ceil(xSize / cs) * ceil(zSize / cs)` at most 16,000,000 cells, and the NavMesh limits on the result (4096 polygons, 100,000 vertices: raise `cs` or `maxEdgeLen` for bigger levels). `create` is async for compatibility and rejects for invalid input; a level with nothing walkable rejects with a `MargoError` of code `failed`.

## Tiles: big worlds that change at run time (`./tiles`)

```ts
import {Crowd} from 'margoengine/navmesh';
import {TiledNavMesh} from 'margoengine/navmesh/tiles';

// Flat xyz positions and triangle indices of the level (Y up): here a 64 x 64 m floor.
const positions = [0, 0, 0, 64, 0, 0, 64, 0, 64, 0, 0, 64], indices = [0, 2, 1, 0, 3, 2];
const world = new TiledNavMesh(positions, indices, {cs: 0.25, ch: 0.1, walkableRadius: 2, walkableHeight: 10, tileSize: 64});

const door = world.addObstacle({min: [30, 0, 30], max: [33, 3, 31]}); // shut a door, park a truck
world.update(); // rebuilds only the tiles the box reaches
world.removeObstacle(door);

// A wall the player built: any triangles. removeGeometry takes it away again.
const wall = world.addGeometry([10, 0, 10, 20, 0, 10, 20, 3, 10, 10, 3, 10], [0, 1, 2, 0, 2, 3]);
world.update(2); // at most two tiles this frame; the rest wait in world.pendingTiles
world.removeGeometry(wall);
world.update();

console.log(world.polygonCount, world.path([1, 0, 1], [60, 0, 60]));
const crowd = new Crowd(world); // agents replan when tiles change
crowd.addAgent({position: [1, 0, 1]}).setTarget([60, 0, 60]);
```

`TiledNavMesh` answers what `NavMesh` answers (`locate`, `closestPoint`, `heightAt`, `path`, `route`, `addOffMeshLink`, `removeOffMeshLink`, `polygonCount`, `polygonCenter`, `polygonLinks`, `version`), so a `Crowd` walks on it. It takes the options of `./build`, and:

| Option | Default | Unit |
| --- | --- | --- |
| `tileSize` | 64 | cells along a tile's side, 8 to 1024; smaller tiles rebuild faster and make more polygons |
| `deferred` | false | build nothing yet: every tile waits for `update`, so a big world can load over several frames |

- **What rebuilds.** `addObstacle`, `moveObstacle`, `removeObstacle`, `addGeometry` and `removeGeometry` mark the tiles they reach; `update(maxTiles)` rebuilds the waiting tiles, oldest first, and returns how many. A tile still waiting keeps its old polygons, so routes never see a half-built world.
- **Same walkable area.** A tile sees past its edge by `walkableRadius + 2` cells before it keeps its own cells, so the area does not depend on the tiling, and any run of changes gives the tiles a fresh build would.
- **Polygon numbers** change when a tile rebuilds: keep positions, not numbers. Off-mesh links are put back after a rebuild, and sleep while an end has no polygon under it. `tile(x, z)` and `tileList()` show each tile's own `NavMesh`.

## Agent types and filters (`./agents`)

```ts
import {Crowd} from 'margoengine/navmesh';
import {NavAgents} from 'margoengine/navmesh/agents';

// A 30 x 30 m floor with a lake and a road across it.
const positions = [0, 0, 0, 30, 0, 0, 30, 0, 30, 0, 0, 30], indices = [0, 2, 1, 0, 3, 2];
const agents = new NavAgents(positions, indices, {
  cs: 0.2, ch: 0.1,
  areas: [
    {min: [10, -1, 0], max: [20, 1, 26], area: 'water'},
    {min: [0, -1, 26], max: [30, 1, 30], area: 'road'},
  ],
  types: {
    soldier: {radius: 0.4, height: 1.8, areas: {water: Infinity}},
    monster: {radius: 1.5, height: 3, climb: 0.8, maxSpeed: 5, areas: {water: 3}},
    truck: {radius: 1.5, height: 3, maxSlope: 15, areas: {ground: 4, water: Infinity}},
    fish: {radius: 0.4, areas: {ground: Infinity, road: Infinity}},
  },
});

console.log(agents.meshCount); // 2: one mesh per size, a filter per type
console.log(agents.path('soldier', [5, 0, 5], [25, 0, 5])); // round the lake
console.log(agents.path('fish', [12, 0, 5], [18, 0, 20])); // stays in it

const crowd = new Crowd(agents.mesh('soldier'));
const guard = agents.addAgent(crowd, 'soldier', {position: [5, 0, 5]});
const beast = agents.addAgent(crowd, 'monster', {position: [5, 0, 8]}); // its own mesh, same crowd
guard.setTarget([25, 0, 5]);
beast.setTarget([25, 0, 5]);
crowd.update(1 / 60);
```

A type gives, in world units, `radius` (0.5), `height` (2), `climb` (0.4), `maxSlope` (45 degrees), `maxSpeed` (3.5), and `areas`, its cost per area name: a multiplier of 1 or more, or `Infinity` for ground it cannot enter. An area it does not name costs 1, and `ground` is everything no box marks. Types of one size share a mesh. The other options are those of `./build`, with `tileSize` to tile each mesh (`./tiles`).

The same pieces work without `NavAgents`: `./build` and `./tiles` take `areas: [{min, max, area}]` with area numbers 1 to 255; `mesh.polygonArea(i)` and `mesh.setPolygonArea(i, area)` read and set them; `route(start, end, filter)` and `path(start, end, filter)` take the cost per area number; and `crowd.addAgent({navMesh, filter})` puts one agent on its own mesh and ground.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/navmesh
