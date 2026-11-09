# @margoengine/road

Import `margoengine/road` from the `margoengine` package, or `@margoengine/road` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

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

Custom crossSection entries are [lateralOffset, height]. UV V follows distance / uvMeters and U follows cross-section distance. The core is frozen and has no UV channel: uvs is separate data for a textured optional renderer/exporter. Sweeps are Y-up and reject vertical or zero tangents; banking is available in the optional entry below; self-intersection repair is not included in the root sweep.

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

GPU tests from the repository root: `node scripts/gpu-lock.mjs run --owner=road-tests --max=8 --wait-max=10 -- npm run test:gpu --workspace @margoengine/road`.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/road


## Banking

```ts
import {bankedRoad} from "margoengine/road/banking";
import {Spline} from "margoengine/splines";
const surface = await bankedRoad(new Spline([[0,0,0],[20,2,20],[50,0,25]]), {bank:[0,0.12,0]});
console.log(surface.geometry.indices.length);
```

`bankedRoad` accepts all root road options and `bank` (default 0): radians about the forward tangent, bounded to +/-pi/4. Positive bank raises the positive lateral edge. A list of 2..4097 angles interpolates linearly at equal arc distances. The entire cross section, including curbs, rotates; normals are rebuilt with the existing geometry utility after deformation. `signal` (default none) checks before and after lazy normal-kernel loading. Data is snapshotted before the first await and caller-owned, with no CPU resource to dispose. Dispose rendered meshes and engines. Input and output positions must stay within +/-1,000,000 m; float32 collapsed triangles and UV overflow reject. Nonvertical tangents and the root road limits apply. Banking does not repair tight bends or design civil-engineering transitions. Both native WebGPU and real WebGL2 compatibility render the banked mesh, including exact device reboot and double disposal tests.
