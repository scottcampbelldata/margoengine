# @margoengine/road

Import `margoengine/road` from the `margoengine` package, or `@margoengine/road` from this package alone; the two are the same module. Both are on npm at 0.1.0. See [Install](https://github.com/scottcampbelldata/margoengine/blob/main/README.md#install) in the repository README.

Arc-length spline sweeps generate a road surface, raised curbs, hard cross-section normals and tiled UV coordinates.

```ts
import {road} from 'margoengine/road';
import {Spline} from 'margoengine/splines';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const curve = new Spline([[0, 0, 0], [40, 2, 30], [90, 0, 20]]);
const {geometry, uvs} = road(curve, {width: 6, curbWidth: 0.2, curbHeight: 0.15, uvMeters: 5});
engine.createMesh().setGeometry(geometry);
```

`roadPath(curve, {width, curbWidth, crossSection, segments, margin})` gives the ground the road covers as
`{points, width}`: the centreline as XZ points sampled by arc length like `road`, and the full width of the road,
both curbs and `margin` (default 0.5 m) each side; an asymmetric `crossSection` keeps its wider side clear on both.
It is the shape `Scatter`'s `paths` option and `clearPlacements` take, so grass, trees and rocks keep off the road:

```ts
import {road, roadPath} from 'margoengine/road';
import {Scatter} from 'margoengine/scatter';
import {Spline} from 'margoengine/splines';
import {Engine} from 'margoengine/core';
import {icosahedronGeometry, toGeometry} from 'margoengine/geometry';
const engine = await Engine.create(document.querySelector('canvas')!);
const curve = new Spline([[0, 0, 0], [40, 0, 30], [90, 0, 20]]);
engine.createMesh().setGeometry(road(curve, {width: 6}).geometry);
Scatter.attach(engine, toGeometry(icosahedronGeometry(0.3, 1, true)), {count: 2000, area: [200, 200], paths: [roadPath(curve, {width: 6})]});
```

Closed splines use periodic tangent frames: corresponding first and last section vertices and normals meet exactly, while UV V keeps the full travelled distance.

Custom crossSection entries are [lateralOffset, height]. UV V follows distance / uvMeters and U follows cross-section distance. The core is frozen and has no UV channel: uvs is separate data for a textured optional renderer/exporter. Sweeps are Y-up and reject vertical or zero tangents; banking is available in the optional entry below; self-intersection repair is available in its own optional entry below.

## Junctions

`@margoengine/road/junctions` stitches crossings and T junctions by uniting the entire road footprint before triangulation. Draw this returned surface instead of overlapping road sweeps. It also preserves courtyard holes. Geometry's existing polygon and triangulation entries load only when the function is called; the road root does not load them.

```ts
import {junctions} from 'margoengine/road/junctions';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const {geometry, area} = await junctions([
  {points: [[-10, 0], [10, 0]], width: 4},
  {points: [[0, -10], [0, 10]], width: 4},
]);
engine.createMesh().setGeometry(geometry);
console.log(area); // 144 square metres, not 160 with the crossing counted twice
```

Points are horizontal `[x, z]` metres. Each line has `width` (default 6). Options are `elevation` (default 0), `uvMeters` (default 1), and `signal` (default none). The signal is checked before and after lazy loading; synchronous geometry work cannot be interrupted. Inputs are snapshotted before loading. The result owns `geometry` and `uvs`, with world-space `[x, -z] / uvMeters`, and needs no disposal; dispose meshes and engines when finished.

Limits: 1..64 roads, 2..4096 points per line and 4096 total, no equal neighbours, coordinates/elevation within +/-1,000,000 m, widths in (0,1000], UV scale in (0,1,000,000]. Bevel joins and butt ends, a shared constant elevation, no curbs, turn-radius design or bridge separation. The polygon grid has about 2^26 steps across the footprint; features below two steps may vanish. Result geometry uses float32 coordinates, so place small roads near their local origin. Collapsed or reversed float32 triangles and overflowing UVs reject with coded help-linked errors. Both WebGPU and the WebGL2 compatibility layer render the same CPU-generated geometry. The GPU test checks road and clear pixels, exact restoration after device reboot, and mesh/engine disposal on both.

GPU tests from the repository root: `node scripts/run-with-timeout.mjs --max=8 -- npm run test:gpu --workspace @margoengine/road`.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/road


## Banking

```ts
import {bankedRoad} from "margoengine/road/banking";
import {Spline} from "margoengine/splines";
const surface = await bankedRoad(new Spline([[0,0,0],[20,2,20],[50,0,25]]), {bank:[0,0.12,0]});
console.log(surface.geometry.indices.length);
```

`bankedRoad` accepts all root road options and `bank` (default 0): radians about the forward tangent, bounded to +/-pi/4. Positive bank raises the positive lateral edge. A list of 2..4097 angles interpolates linearly at equal arc distances. The entire cross section, including curbs, rotates; normals are rebuilt with the existing geometry utility after deformation. Closed splines require equal first and last bank angles; a mismatched list rejects with a coded `failed` error. Corresponding terminal vertices share all incident triangle corner angles when rebuilding normals, preserving hard edges between curb strips and the separate UV end row. `signal` (default none) checks before and after lazy normal-kernel loading. Data is snapshotted before the first await and caller-owned, with no CPU resource to dispose. Dispose rendered meshes and engines. Input and output positions must stay within +/-1,000,000 m; float32 collapsed triangles and UV overflow reject. Nonvertical tangents and the root road limits apply. Banking does not repair tight bends or design civil-engineering transitions. Both native WebGPU and real WebGL2 compatibility render the banked mesh, including exact device reboot and double disposal tests.

## Terrain fit

```ts
import {road} from 'margoengine/road';
import {Spline} from 'margoengine/splines';
import {fitTerrain} from 'margoengine/road/terrain';
import {heightfieldGeometry} from 'margoengine/terrain';
const surface = road(new Spline([[0,2,-10],[0,4,10]]));
const height = await fitTerrain(surface.geometry, {base:()=>1, shoulder:3, depth:0.1});
const ground = heightfieldGeometry(height, {size:[30,30], resolution:64});
console.log(ground.indices.length);
```

`fitTerrain` returns a height function compatible with terrain heightfields and biome field sources. It cuts ground above the road and fills ground below it. Pass world-space geometry; root curbs, banked grades and junction surfaces work. `base` defaults to flat zero, `shoulder` to 2 m and `depth` below the road to 0 m. The bed follows the lowest barycentric triangle height at each XZ location, so tilted curb walls cannot raise terrain through the driving surface. Footprint containment uses vertical BVH ray hits and their barycentric coordinates; `shoulder:0` keeps interior points on the bed even on oblique roads and leaves points outside the footprint at base. Outside the footprint it fades from the bed at the nearest projected point to base with cubic smoothstep over the shoulder. Faces with zero XZ area are omitted; banked curb faces with nonzero projected area participate in the lower envelope. Input positions and sampled base/query coordinates stay within +/-1,000,000 m, up to one million vertices/faces. No bridge/tunnel or overlapping-layer classification; use one at-grade surface. The input mesh snapshots before lazy BVH loading. `signal` (default none) checks around loading; synchronous queries/builds finish without interruption. Returned CPU data is garbage collected; dispose rendered meshes and engines. WebGPU and WebGL2 compatibility both have fitted-heightfield pixel, value, reboot and disposal proof. Sampling resolution controls the final terrain mesh fidelity.

## Self intersection repair

```ts
import {repairRoad} from 'margoengine/road/repair';
import {Spline} from 'margoengine/splines';
const surface = await repairRoad(new Spline([[-2,0,-8],[-2,0,8],[0,0,9],[2,0,8],[2,0,-8]]), {width:8});
console.log(surface.area); // one footprint rather than overlapping strips
```

`repairRoad` samples equal arc-distance chords and unions their full footprint before triangulation. It replaces the root sweep when a tight planar bend folds or overlaps. `width` defaults to 6 m, `segments` to 128 (1..4095), and `uvMeters` to 1. All junction bounds apply. Elevation comes from the curve; a grade rejects with coded help-linked `unsupported`. Every cubic span is checked at four distinct raw-parameter values before tessellation, independently of `segments` and the spline arc lookup. Equal-height chord endpoints never authorise flattening a hill or an interior Hermite/Bezier excursion. This is a flat driving surface without curbs or banking; it does not trim a 3D banked mesh. The sampled chord approximation and the polygon snap grid set geometric fidelity. Boundaries round to renderer float32 precision before triangulation; collapsed boundaries and invalid final faces still reject. Inputs snapshot before lazy loading; `signal` (default none) checks around loading. CPU output is caller-owned and needs no disposal. Rendered meshes/engines require disposal and survive device reboot on WebGPU and WebGL2 compatibility, as the pixel tests prove.

## Lane markings

```ts
import {Engine, PbrMaterial} from 'margoengine/core';
import {road} from 'margoengine/road';
import {Spline} from 'margoengine/splines';
import {markings} from 'margoengine/road/markings';
import {Decals} from 'margoengine/post/decals';
import {Tonemap} from 'margoengine/tonemap';
const engine = await Engine.create(document.querySelector('canvas')!);
engine.createMesh().setGeometry(road(new Spline([[0,0,-10],[0,0,10]])).geometry).setMaterial(new PbrMaterial({color:'#202020'}));
Tonemap.attach(engine); // supplies scene depth
const paint = Decals.attach(engine);
paint.setDecals(markings([
  {kind:'line',position:[-1,0,0],length:18,dash:[3,1]},
  {kind:'arrow',position:[1,0,0],length:4,width:1.5},
]));
console.log(paint.count);
```

Render the engine as usual. `markings` is synchronous and returns independently owned `Decal[]`; no image, loading or GPU allocation occurs. Pass the list to the existing decal renderer, with a scene-depth capture attached. The default white texel paints strokes in unlit `over` mode. Shared settings: `color` linear RGB in 0..1 (default white), `opacity` 0..1 (default 1), `depth` positive through 1000 m (default 2). Individual `angle` (radians about +Y, counterclockwise seen from above: 0 along +Z, pi/2 along +X) defaults 0, `length` to 4 m (positive through 10000), `width` to 0.15 m for lines or 1.5 m for arrows (positive through 1000). `dash` is line-only [paint,gap], both positive through 10000 m; default solid. Its last painted segment trims to the authored end. Up to 4096 resulting projectors; empty input clears the list. Positions stay within +/-1,000,000 m. Arrows are stylized three-stroke glyphs; this is not a traffic-standard artwork library. Downward box projection can paint any upward-facing object inside it, so set its centre/depth around the road. Subpixel or imprecise world placement can disappear; use a local origin. CPU descriptions need no disposal; dispose Decals, meshes and engines. Device reboot, disposal, actual white line/arrow pixels and WebGL2 compatibility are tested.

Every projector half-extent must be a normal float32 number (at least 2^-126); dimensions of 1e-30 m remain accepted. This excludes values the GPU may flush to zero.

## Road network graph

```ts
import {roadGraph} from 'margoengine/road/graph';
import {Spline} from 'margoengine/splines';
import {createCompute} from 'margoengine/compute';
import {shortestPaths} from 'margoengine/compute/graph';
using gpu = await createCompute();
using network = roadGraph(gpu, {vertices:3, roads:[
  {from:0,to:1,curve:new Spline([[0,0,0],[100,0,0]]),speed:10,direction:'forward'},
  {from:1,to:2,curve:new Spline([[100,0,0],[160,0,0]]),speed:10,traffic:2,delay:3},
]});
const result = await shortestPaths(network, 0);
using distances = result.distances;
using predecessors = result.predecessors;
console.log(await distances.read()); // Float32Array [0, 10, 25] seconds
console.log(await predecessors.read()); // Int32Array [-1, 0, 1]
```

`roadGraph` synchronously returns a caller-owned `CsrMatrix` for existing `compute/graph` shortest paths, BFS and components. Junctions are integer IDs in `0..vertices-1`, explicitly shared by the roads you want connected. Split roads at intended intersections; crossings and bridge overlaps never connect automatically. No road geometry or mesh is required. Each link's `curve.length` is snapshotted as arc metres. Weight seconds are `length / speed * traffic + delay`, rounded to float32. Defaults: `roads:[]`, `speed:50/3.6` m/s (50 km/h), `direction:'both'`, `traffic:1`, `delay:0`, `signal` none. Direction can also be `'forward'` (from -> to) or `'reverse'`; use separate links for asymmetric costs. Speed and length are positive finite, traffic finite and at least 1, delay finite and nonnegative. Closed roads are omitted. Rebuild for changed traffic; this graph is a snapshot, without a traffic simulator or lane/turn restrictions.

Up to 65536 vertices and 65536 input roads; zero vertices/roads, isolated vertices and positive self loops are supported. Parallel arcs keep only the minimum cost, without road identities. Edge seconds must be normal float32 values at least 2^-126 and at most 2^127/max(1,vertices), keeping simple-path sums finite. Solvers use f32 sums, so rounding affects costs; compute/graph's predecessor limitations apply. This adapter does not reconstruct road itineraries. The signal checks before reading and before upload; a synchronous build cannot yield mid-loop. Solvers and reads accept their own signal.

Native WebGPU and real WebGL2 compatibility both run the existing device-backed compute route, proved by distance/predecessor and lifecycle assertions. For a CPU fallback, use `createCompute({backend:'cpu'})`; the same graph API works in Node. When sharing a render engine, pass `createCompute({engine})`; dispose graph/output arrays/context before engine disposal. Those objects do not own the engine device. After device loss/reboot, create a fresh context and rebuild the graph from your retained road descriptions. Graphs do not restore themselves. The GPU test proves the rebuilt graph has the same answers on both backends.

Tessellated root-road frames use adjacent chord bisectors, joined periodically
on closed curves. On tight bends the inside lateral offsets (curbs included)
compress proportionally before their focal fold. Both projected triangle areas
stay positive, retaining 5% of the available signed span area at the narrowest
limit; the outside width stays unchanged. Cross-section heights and UV distances
remain authored. This can narrow the inside driving surface, so choose a wider
bend when the full lane width matters. Nonlocal footprint overlaps at crossings
or adjacent return legs still use `/repair` or `/junctions` for a planar surface;
local fold prevention does not classify bridges or trim global intersections.
Vertical tangents reject with linked code `unsupported`; arbitrarily steep
nonvertical ramps work. A sampled cusp/reversal rejects with linked code `failed`:
refine the spline or increase segments. Core Geometry/PbrMaterial have no texture
channel by design; use the separate `uvs` with an optional textured renderer or
exporter, as documented above.

## Wet roads and lane driving

`@margoengine/road/driving` turns rendered `road` and `bankedRoad` triangles into fixed colliders with measured dry and wet tyre limits. `RoadSurfaces.register()` applies the same material model to an existing deck or soil collider. An optional pressure–sinkage curve makes suspension compress less as the tyres press into soft soil. Use `groundReaction: true` on a vehicle that exchanges wheel forces with a moving deck.

`RoadDriver` follows a lane made from the road spline. It watches the rigid body's pose at 60 Hz, steers toward a geometric look-ahead point, and brakes before a curve or the end of an open path. Its speed bound depends on bank and available grip. Supply `SurfaceEnergySolver.wetnessField` to use the same ATMO-09 moisture in planning and in `RoadSurfaces` through its wetness callback. Bind the existing `Vehicle` once and unbind it at disposal. The world snapshot includes its drive controls, engine and wheel spin.

```ts
import { Physics } from '@margoengine/physics';
import { PhysicsWorld, RigidSolver, worldMemory } from '@margoengine/physics/world';
import { road } from '@margoengine/road';
import { addRoadVehicle, roadDrivePath, RoadDriver, RoadSurfaces } from '@margoengine/road/driving';
import { Spline } from '@margoengine/splines';

await Physics.load();
const gravity = [0, -9.81, 0] as const;
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity, memory: worldMemory(false) });
using physics = new Physics(null, { arena: world.arena, gravity });
const spline = new Spline([[0, 0, -8], [0, 0, 0], [0, 0, 16]]);
const traction = { dry: 0.8, wet: 0.25 };
const surfaces = new RoadSurfaces();
surfaces.add(physics, road(spline), { traction, wetness: 0.5 });
const wheels = [-1, 1].flatMap((end) => [-1, 1].map((side) => ({
  position: [0.65 * side, -0.15, end] as const, radius: 0.3, steer: end > 0, suspensionStiffness: 18,
})));
const { body, vehicle } = await addRoadVehicle(physics, null, {
  mass: 1200, size: [1.3, 0.36, 2.4], position: [0, 0.614, 0], groundMaterial: surfaces.sample, wheels,
});
const lane = await RoadDriver.create();
world.add(new RigidSolver(), { physics });
world.add(lane, { vehicles: [{ body: body.row, path: roadDrivePath(spline), traction, wheelbase: 2, maxSpeed: 4, attachment: vehicle }] });
world.couple([lane.id, 'rigid'], 'staggered');
const unbind = lane.bindVehicle(world, physics, 0);
try {
  world.advance(90);
  if (body.position[2] < 1) throw new Error('Expected the lane-driven car to move at least 1 m');
} finally {
  unbind();
}
```

`commandsField` uses layout 1 with f64 words for steer, throttle, brake, target speed, measured speed, route progress, relative wetness and segment index. The first three words are normalized `VehicleInput` values. `RoadDriver.read()` returns a copy. `addRoadVehicle()` uses the visual asset's actual dimensions and a supplied measured mass. Provide the asset's local forward direction when it differs from +Z. For wind, pass a `Wind` field such as Weather's `BoundaryLayerWind` and add the existing `AirSolver` to drive the optional attachment on the world clock.
