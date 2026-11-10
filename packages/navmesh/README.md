# @margoengine/navmesh

Import `margoengine/navmesh` from the `margoengine` package, or `@margoengine/navmesh` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Dependency-free navigation: A* chooses a polygon corridor, the funnel algorithm pulls it taut, reciprocal ORCA selects collision-avoiding agent velocities in XZ, a `Crowd` manager walks agents along routes with area costs, off-mesh links and obstacles, `@margoengine/navmesh/build` generates the walkable polygons from level triangles, `@margoengine/navmesh/tiles` cuts big worlds into tiles that rebuild at run time, `@margoengine/navmesh/codec` bakes meshes to bytes, `@margoengine/navmesh/links` finds the jumps a level allows, `@margoengine/navmesh/hierarchy` keeps long routes cheap, `@margoengine/navmesh/debug` draws it all, `@margoengine/navmesh/voxel` builds straight from voxel chunks, and `@margoengine/navmesh/volume` routes flying agents in 3D.

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
- **Off-mesh links.** `nav.addOffMeshLink(start, end, {bidirectional, cost})` joins the polygons under its two ends (a jump, a ladder, a teleporter); `removeOffMeshLink(id)` drops it. `nav.route(start, end)` returns `{points, offMesh}`, where `offMesh` lists the points from which a segment crosses a link; agents cross links straight, at their speed, as state `'offmesh'`. A link may cost less than its length (a teleporter, `cost: 0`): routes still come out the cheapest, as the search scales its straight-line estimate down to the cheapest link's cost per metre.
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
| `origin` | the level's lowest corner | `[x, y, z]` the tile lattice grows from; with it a mesh can start empty: `new TiledNavMesh([], [], {origin, deferred: true})`, then `addGeometry` |

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

## Bake once, load fast (`./codec`)

```ts
import {buildNavMesh} from 'margoengine/navmesh/build';
import {decodeNavMesh, decodeTiledNavMesh, encodeNavMesh, encodeTiledNavMesh} from 'margoengine/navmesh/codec';
import {TiledNavMesh} from 'margoengine/navmesh/tiles';

const positions = [0, 0, 0, 64, 0, 0, 64, 0, 64, 0, 0, 64], indices = [0, 2, 1, 0, 3, 2];

// Offline: build, then write the bytes to a file. At run time: read them, no build.
const bytes = encodeNavMesh(buildNavMesh(positions, indices, {cs: 0.25, ch: 0.1}));
const mesh = decodeNavMesh(bytes);
console.log(mesh.path([1, 0, 1], [60, 0, 60]));

// Tiles: `geometry: true` keeps the level, so the loaded mesh still rebuilds.
const world = new TiledNavMesh(positions, indices, {cs: 0.25, ch: 0.1, tileSize: 64});
const loaded = decodeTiledNavMesh(encodeTiledNavMesh(world, {geometry: true}));
loaded.addObstacle({min: [30, 0, 30], max: [33, 3, 31]});
loaded.update();

// Without it the file is smaller and the mesh is fixed: routes and off-mesh links work, level changes throw.
const fixed = decodeTiledNavMesh(encodeTiledNavMesh(world));
console.log(fixed.polygonCount);
```

`encodeNavMesh` keeps vertices, polygons, areas, area costs and off-mesh links. `encodeTiledNavMesh` keeps the settings, each tile's polygons, tiles still waiting for `update`, off-mesh links (sleeping ones too), and with `geometry` (default false) the level's triangles and obstacles under the ids they had. A file that is cut, damaged, of another version or of the other kind throws a `MargoError` of code `failed`; anything but a `Uint8Array` throws `TypeError`.

The format, little-endian: a 16 byte header (`MNAV`, u16 version 1, u16 kind: 0 for a mesh, 1 for tiles, u32 payload size, u32 CRC-32 of the payload), then the payload. Whole numbers are varints, seven bits a byte, low first; signed ones are zigzag; coordinates and costs are f64.

- A mesh: vertex count and vertices; polygon count, and for each its vertex count, vertex numbers and area byte; the polygons whose cost is not 1, as number and cost; then the links as start, end, cost and a two-way byte.
- Tiles: settings as sized JSON, the origin, the next id; tiles as x, z, rise and a mesh without links; waiting tiles as x, z; links as id, start, end, cost and a two-way byte; then a byte for the level and, when set, obstacles as id, min, max, and geometry as id, sized f32 positions and sized u32 indices.

## Jump links (`./links`)

```ts
import {buildNavMesh} from 'margoengine/navmesh/build';
import {addJumpLinks, findJumpLinks, jumpPoint} from 'margoengine/navmesh/links';

// Two floors 20 x 20 m with a 2 m gap between them.
const positions = [0, 0, 0, 20, 0, 0, 20, 0, 20, 0, 0, 20, 22, 0, 0, 42, 0, 0, 42, 0, 20, 22, 0, 20];
const indices = [0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6];
const mesh = buildNavMesh(positions, indices, {cs: 0.1, ch: 0.05, walkableRadius: 5, walkableHeight: 40});

const links = findJumpLinks(mesh, positions, indices, {radius: 0.5, height: 2});
addJumpLinks(mesh, links);
const route = mesh.route([15, 0, 10], [30, 0, 10]);
console.log(route?.offMesh); // where the route jumps

// To play a jump: 0 at takeoff, 1 at the landing.
const [link] = links;
console.log(link.kind, jumpPoint(link, 0.5));
```

| Option | Default | Unit |
| --- | --- | --- |
| `radius`, `height` | 0.5, 2 | the agent's body; give what the mesh was built for |
| `climb` | 0.4 | highest step it walks; the top of what counts as `across` |
| `jumps` | `{height: 1, distance: 4}`, `{height: 0.25, distance: 1.5}` | each arc it can make: how far up, and how far along before it is back at the height it left |
| `maxFall` | 6 | furthest it may fall, from the top of the arc |
| `spacing` | 1 | metres between takeoffs along an edge |
| `directions` | 9 | directions tried at a takeoff, fanned 160 degrees |
| `jumpCost` | 1 | what a jump costs above the distance it covers |

A jump follows its one arc and lands the first time that arc meets ground on the way down; it counts only if the body touches nothing on the way and the fall is within `maxFall`. So `jumps` lists what the agent can really do: a long leap, and a small hop that lands close under a ledge. Each link gives `start`, `end`, `cost`, `kind` (`across`, `down` or `up`), and the `height` and `distance` of its arc. `positions` and `indices` are what the body is tested against. Links are one way: a gap crossed both ways gets one each way. On a `TiledNavMesh` they sleep and wake with their ground, but run `findJumpLinks` again after the level changes.

## Long routes in huge worlds (`./hierarchy`)

```ts
import {NavHierarchy} from 'margoengine/navmesh/hierarchy';
import {TiledNavMesh} from 'margoengine/navmesh/tiles';

const positions = [0, 0, 0, 512, 0, 0, 512, 0, 512, 0, 0, 512], indices = [0, 2, 1, 0, 3, 2];
const world = new TiledNavMesh(positions, indices, {cs: 0.5, ch: 0.1, tileSize: 32});

const hierarchy = new NavHierarchy(world, {clusterTiles: 2});
console.log(hierarchy.path([5, 0, 5], [500, 0, 500]));

// A door shuts: rebuild the tiles, and the next query works out only the clusters that touch them.
world.addObstacle({min: [100, 0, 100], max: [104, 3, 101]});
world.update();
console.log(hierarchy.update()); // clusters worked out again
```

`route` and `path` answer as they do on the mesh, with both ends on the mesh. The search runs on a coarse graph of the crossings between clusters, whose walking costs are cached, then joins the cached corridors and pulls them taut. It finds a route whenever one can be walked, near the shortest: use `world.route` when you need the search over every polygon. Tile rebuilds and off-mesh links are picked up by the next query.

| Option | Default | Unit |
| --- | --- | --- |
| `clusterTiles` | 4 | tiles along a cluster's side; more makes the coarse graph smaller and each query's two ends dearer |
| `spacing` | a quarter of a cluster's side | world units between crossings on a wide entrance; smaller gives straighter routes and a bigger graph |
| `filter` | none | cost per area number, as in `route`; make one hierarchy per agent type |

## Debug draw (`./debug`)

```ts
import {Engine} from 'margoengine/core';
import {Lines} from 'margoengine/lines';
import {Crowd} from 'margoengine/navmesh';
import {buildNavMesh} from 'margoengine/navmesh/build';
import {NavDebug, meshLines} from 'margoengine/navmesh/debug';

const engine = await Engine.create(document.querySelector('canvas')!);
const lines = new Lines();
engine.use(lines);

const mesh = buildNavMesh([0, 0, 0, 20, 0, 0, 20, 0, 20, 0, 0, 20], [0, 2, 1, 0, 3, 2], {cs: 0.25, ch: 0.1});
const crowd = new Crowd(mesh);
crowd.addAgent({position: [2, 0, 2]}).setTarget([18, 0, 18]);

const debug = new NavDebug(lines, mesh, {crowd});
debug.showRoute(mesh.route([1, 0, 1], [19, 0, 19]));

function frame() {
  crowd.update(1 / 60);
  debug.update(); // agents every frame, the mesh only when it changed
  requestAnimationFrame(frame);
}
frame();

// The same lines as plain data, for a test or your own renderer: no GPU needed.
const {positions, colors} = meshLines(mesh);
console.log(positions.length / 6, colors.length);
```

`NavDebug` draws a `NavMesh` or `TiledNavMesh`: shared edges, outlines (tile lines among them, so tiles show), and off-mesh links as arcs; a `crowd` adds a ring per agent coloured by state (idle grey, moving green, off-mesh amber, arrived blue, unreachable red), its velocity and the rest of its route. `showRoute(route)` shows one route, and `null` clears it. Options: `lift` (0.05 world units off the ground), `width` (1.5 CSS pixels) and `colors`, which takes `inner`, `outline`, `link`, `route` and `agents` by state as linear `[r, g, b]`. `meshLines`, `routeLines` and `crowdLines` return `{positions, colors}` as segment pairs: pass them to `new Line({mode: 'segments', positions, colors})`. `dispose` takes the lines away; `using` works.

## Navmesh from voxel worlds (`./voxel`)

```ts
import {BlockTypes, VoxelWorld} from 'margoengine/voxel';
import {VoxelNavMesh} from 'margoengine/navmesh/voxel';

const blocks = new BlockTypes();
const stone = blocks.define('stone', {});
const world = new VoxelWorld({blocks, minY: -32, maxY: 95});
for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) world.setBlock(x, 0, z, stone);

// No triangles: tiles read the chunks. Sizes in cells, as in `./build`.
const mesh = new VoxelNavMesh(world, {walkableRadius: 1, walkableHeight: 8, walkableClimb: 2, tileSize: 32});
console.log(mesh.path([5, 1, 5], [60, 1, 60]));

// Blocks change: the tiles that see them wait for update, as many a frame as you allow.
for (let z = 0; z < 60; z++) for (let y = 1; y < 4; y++) world.setBlock(32, y, z, stone);
mesh.update(4);
mesh.update();
console.log(mesh.path([5, 1, 5], [60, 1, 5])); // round the new wall

mesh.dispose(); // stops listening to the world
```

`VoxelNavMesh` is a `TiledNavMesh`: routes, off-mesh links, `update`, a `Crowd`, `./debug` and `./hierarchy` all work on it. Its options are those of `./tiles`, with `cs` 0.5 and `ch` 0.25 by default, each one block over a whole number, and `solid(type, state)` to choose what is ground and what bumps a walker, by default `BlockType.solid`: pass `(type) => type.solid || type.liquid` for a walker that wades. A slab or stair counts as the half blocks it fills, and unloaded chunks are air. Chunks that load or unload mark their tiles too.

## Flying agents (`./volume`)

```ts
import {NavVolume} from 'margoengine/navmesh/volume';

// A 40 m floor and a 10 m tall block in the middle of it, as triangles (Y up).
const positions = [0, 0, 0, 40, 0, 0, 40, 0, 40, 0, 0, 40, 15, 0, 15, 25, 0, 15, 25, 0, 25, 15, 0, 25, 15, 10, 15, 25, 10, 15, 25, 10, 25, 15, 10, 25];
const indices = [0, 2, 1, 0, 3, 2, 8, 10, 9, 8, 11, 10, 4, 5, 9, 4, 9, 8, 5, 6, 10, 5, 10, 9, 6, 7, 11, 6, 11, 10, 7, 4, 8, 7, 8, 11];

const volume = new NavVolume(positions, indices, {voxelSize: 0.5, radius: 0.5, padding: 10});
console.log(volume.path([2, 5, 20], [38, 5, 20])); // round or over the block, in 3D
console.log(volume.lineOfSight([2, 15, 2], [38, 15, 38]));
console.log(volume.nodeCount, volume.byteLength);

// An end too close to a solid has no path; move it out first.
const perch = volume.closestFree([14.5, 5, 20]);
if (perch) console.log(volume.path(perch, [38, 5, 20]));
```

| Option | Default | Unit |
| --- | --- | --- |
| `voxelSize` | 0.5 | side of the smallest cell, world units |
| `radius` | 0.5 | the flyer's radius: solids grow by it |
| `min`, `max` | the level, plus `padding` | corners of the volume |
| `padding` | 8 voxels | open air around the level |

`path(start, end)` gives corner points clear of every triangle by the radius, or null when an end is not free or nothing joins them. `isFree(point)`, `lineOfSight(a, b)` and `closestFree(point, reach = 8)` answer in the same world; the hollow inside of a closed solid counts as free, so `closestFree` right against a thin wall can pick the far side, and `path` then says null. Free space costs almost nothing: a node with no children is open air however big, so open sky takes no memory. The volume is built once; make a new one if the level changes.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/navmesh
