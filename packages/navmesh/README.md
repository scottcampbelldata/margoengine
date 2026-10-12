# @margoengine/navmesh

Dependency-free convex polygon navigation: A* chooses a polygon corridor, the funnel algorithm shortens it, and reciprocal ORCA selects collision-avoiding agent velocities in XZ.

```ts
import {NavMesh} from '@margoengine/navmesh';
const mesh = new NavMesh([[0,0,0], [10,0,0], [0,0,10]], [[0,1,2]]);
const path = mesh.path([1,0,1], [2,0,2]);
```

Polygons must be strictly convex, planar and nonvertical. Neighbor polygons share vertex-index edges; welded coordinates with different indices do not link. Outside or disconnected endpoints return null. Paths use supplied endpoint heights and portal heights. The bounded open set uses a linear scan (4096 polygons maximum). Agent radii are handled by avoid(), not by corridor inset: build an already-eroded walkable mesh. ORCA expects current velocities and preferred velocities for all reciprocal agents, uses seconds, and bounds output by maxSpeed; static-wall constraints are not generated here.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/navmesh

