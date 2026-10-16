import { NavMesh, avoid } from '../../packages/navmesh/dist/index.js';
import { grid } from './layout.js';

const tileCount = 32;
export function createWorkload(count = 96) {
  if (!Number.isInteger(count) || count < 48 || count > 160)
    throw new RangeError('Navmesh workload count must be 48..160');
  const start = performance.now(),
    points = grid(count),
    yaw = new Float32Array(count),
    vertices = [],
    polygons = [],
    centers = [];
  for (let z = 0; z <= 6; z++) for (let x = 0; x <= 6; x++) vertices.push([x - 3, 0, z - 3]);
  for (let z = 0; z < 6; z++)
    for (let x = 0; x < 6; x++) {
      if (x >= 2 && x <= 3 && z >= 2 && z <= 3) continue;
      const a = z * 7 + x;
      polygons.push([a, a + 1, a + 8, a + 7]);
      centers.push([x - 2.5, z - 2.5]);
    }
  let mesh = new NavMesh(vertices, polygons),
    agents = [],
    paths = [],
    disposed = false;
  const agentCount = count - tileCount,
    outputs = Array.from({ length: agentCount }, () => new Float64Array(2)),
    neighbors = [],
    waypoint = new Uint16Array(agentCount),
    goals = new Uint8Array(agentCount);
  let frames = 0,
    routeCursor = 0,
    pathQueries = 0,
    pathQueriesPerFrame = 0,
    avoidanceCalls = 0,
    neighborPairs = 0,
    blockedSteps = 0,
    arrived = 0,
    routingCpuMilliseconds = 0,
    avoidanceCpuMilliseconds = 0;
  for (let i = 0; i < tileCount; i++) {
    points[i * 4] = centers[i][0];
    points[i * 4 + 1] = 0;
    points[i * 4 + 2] = centers[i][1];
    points[i * 4 + 3] = 2;
  }
  const route = (i) => {
    const a = agents[i],
      goal = centers[goals[i]];
    paths[i] = mesh.path([a.position[0], 0, a.position[1]], [goal[0], 0, goal[1]]);
    if (!paths[i]) throw new Error('Connected demo navmesh produced no route');
    waypoint[i] = 1;
    pathQueries++;
    pathQueriesPerFrame++;
  };
  for (let i = 0; i < agentCount; i++) {
    const center = centers[i % tileCount],
      row = Math.floor(i / tileCount),
      offset = row < 2 ? (row ? 0.22 : -0.22) : (row - 2.5) * 0.15;
    agents.push({
      id: i,
      position: [center[0] + offset, center[1]],
      velocity: [0, 0],
      preferred: [0, 0],
      radius: 0.11,
      maxSpeed: 0.8,
    });
    goals[i] = (i + 16) % tileCount;
    route(i);
  }
  const paint = () => {
    for (let i = 0; i < agentCount; i++) {
      const a = agents[i],
        offset = (i + tileCount) * 4;
      points[offset] = a.position[0];
      points[offset + 1] = 0.4;
      points[offset + 2] = a.position[1];
      yaw[i + tileCount] = Math.atan2(a.velocity[0], a.velocity[1]);
    }
  };
  paint();
  const setupCpuMilliseconds = performance.now() - start;
  return {
    points,
    yaw,
    get mesh() {
      return mesh;
    },
    get agents() {
      return agents;
    },
    get paths() {
      return paths;
    },
    bounds: { min: [-3.3, -0.2, -3.3], max: [3.3, 0.7, 3.3] },
    description:
      'A shared-edge navmesh surrounds a blocked center. Purple markers show 32 walkable polygons; agents follow actual A*/funnel paths and ORCA velocities. Amber means avoidance changed velocity; red means a caller boundary guard rejected a step.',
    step(delta) {
      if (disposed) return;
      if (!Number.isFinite(delta) || delta < 0 || delta > 0.1) throw new RangeError('Invalid navmesh frame delta');
      const start = performance.now();
      frames++;
      pathQueriesPerFrame = neighborPairs = 0;
      for (let query = 0; query < Math.min(4, agentCount); query++) {
        route(routeCursor);
        routeCursor = (routeCursor + 1) % agentCount;
      }
      for (let i = 0; i < agentCount; i++) {
        const a = agents[i];
        let target = paths[i][waypoint[i]];
        while (target && Math.hypot(target[0] - a.position[0], target[2] - a.position[1]) < 0.1)
          target = paths[i][++waypoint[i]];
        if (!target) {
          goals[i] = (goals[i] + 16) % tileCount;
          arrived++;
          route(i);
          target = paths[i][1];
        }
        const x = target[0] - a.position[0],
          z = target[2] - a.position[1],
          distance = Math.hypot(x, z),
          speed = Math.min(a.maxSpeed, distance / (delta || 1 / 60));
        a.preferred[0] = distance ? (x / distance) * speed : 0;
        a.preferred[1] = distance ? (z / distance) * speed : 0;
      }
      const routed = performance.now();
      routingCpuMilliseconds = routed - start;
      for (let i = 0; i < agentCount; i++) {
        const a = agents[i];
        neighbors.length = 0;
        for (const b of agents)
          if (a !== b && (b.position[0] - a.position[0]) ** 2 + (b.position[1] - a.position[1]) ** 2 < 6.25)
            neighbors.push(b);
        neighborPairs += neighbors.length;
        avoid(a, neighbors, delta || 1 / 60, 1.5, outputs[i]);
        avoidanceCalls++;
      }
      avoidanceCpuMilliseconds = performance.now() - routed;
      for (let i = 0; i < agentCount; i++) {
        const a = agents[i],
          v = outputs[i],
          x = a.position[0] + v[0] * delta,
          z = a.position[1] + v[1] * delta;
        if (mesh.locate([x, 0, z]) < 0) {
          a.velocity[0] = a.velocity[1] = 0;
          blockedSteps++;
          points[(i + tileCount) * 4 + 3] = 3;
        } else {
          a.position[0] = x;
          a.position[1] = z;
          a.velocity[0] = v[0];
          a.velocity[1] = v[1];
          points[(i + tileCount) * 4 + 3] = Math.hypot(v[0] - a.preferred[0], v[1] - a.preferred[1]) > 0.05 ? 1 : 0;
        }
      }
      paint();
    },
    details: () => ({
      agents: agentCount,
      walkablePolygonMarkers: tileCount,
      polygons: polygons.length,
      frames,
      pathQueries,
      pathQueriesPerFrame,
      avoidanceCalls,
      neighborPairs,
      blockedSteps,
      arrived,
      setupCpuMilliseconds,
      routingCpuMilliseconds,
      avoidanceCpuMilliseconds,
    }),
    dispose() {
      disposed = true;
      mesh = agents = paths = null;
    },
  };
}
