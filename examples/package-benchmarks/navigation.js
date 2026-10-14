import {Navigation} from '../../packages/navigation/dist/index.js';

const floorMarkers = 72;
export async function createWorkload(count = 128) {
  if (!Number.isInteger(count) || count < 96 || count > 256) throw new RangeError('Navigation workload count must be 96..256');
  const started = performance.now(), points = new Float32Array(count * 4), yaw = new Float32Array(count), positions = [], indices = [];
  let tile = 0;
  for (let z = 0; z < 9; z++) for (let x = 0; x < 9; x++) {
    if (x >= 3 && x <= 5 && z >= 3 && z <= 5) continue;
    const left = x * 2 - 9, near = z * 2 - 9, vertex = positions.length / 3;
    positions.push(left,0,near, left+2,0,near, left+2,0,near+2, left,0,near+2);
    indices.push(vertex,vertex+2,vertex+1, vertex,vertex+3,vertex+2);
    points.set([left+1,-0.15,near+1,2], tile++ * 4);
  }
  const buildStarted = performance.now();
  let navigation = await Navigation.create(positions, indices, {cs: 0.25, ch: 0.1, walkableHeight: 0.3, walkableClimb: 0.2, walkableRadius: 0.35, minRegionArea: 0, mergeRegionArea: 0});
  const buildElapsedMilliseconds = performance.now() - buildStarted;
  const agents = Array.from({length: count - floorMarkers}, (_,i) => {
    const angle = i / (count - floorMarkers) * Math.PI * 2, x = Math.cos(angle) * 7.4, z = Math.sin(angle) * 7.4;
    return {position: {x,y: 0,z}, target: {x: -x,y: 0,z: -z}, home: {x,y: 0,z}, away: true};
  });
  let disposed = false, frames = 0, pathQueries = 0, failedQueries = 0, bentPaths = 0, arrived = 0, pathCpuMilliseconds = 0, paths = [];
  const update = delta => {
    const start = performance.now(); bentPaths = 0;
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i], path = navigation.path(agent.position,agent.target); pathQueries++; paths[i] = path;
      const offset = (i + floorMarkers) * 4;
      if (!path || path.length < 2) {failedQueries++; points[offset+3] = 3;}
      else {
        if (path.length > 2) bentPaths++;
        points[offset+3] = path.length > 2 ? 1 : 0;
        let remaining = delta * 1.6;
        // Consume actual Detour waypoints; a long callback cannot cut across the hole.
        for (let waypoint = 1; waypoint < path.length && remaining > 0; waypoint++) {
          const next = path[waypoint], dx = next.x - agent.position.x, dz = next.z - agent.position.z, length = Math.hypot(dx,dz), distance = Math.min(length,remaining);
          if (length) {agent.position.x += dx / length * distance; agent.position.z += dz / length * distance; yaw[i+floorMarkers] = Math.atan2(dx,dz);}
          agent.position.y = next.y; remaining -= distance;
          if (distance < length) break;
        }
        if (Math.hypot(agent.target.x-agent.position.x,agent.target.z-agent.position.z) < 0.05) {
          agent.away = !agent.away; agent.target.x = agent.home.x * (agent.away ? -1 : 1); agent.target.z = agent.home.z * (agent.away ? -1 : 1); arrived++;
        }
      }
      points[offset] = agent.position.x; points[offset+1] = agent.position.y + 0.3; points[offset+2] = agent.position.z;
    }
    pathCpuMilliseconds = performance.now() - start;
  };
  try {update(0);} catch (error) {navigation.dispose(); throw error;}
  const setupElapsedMilliseconds = performance.now() - started;
  return {points,yaw, get navigation() {return navigation;}, get agents() {return disposed ? null : agents;}, get paths() {return paths;},
    bounds: {min: [-9.2,-0.3,-9.2], max: [9.2,0.7,9.2]},
    description: 'Actual Recast voxelization and Detour queries route agents around a missing central floor. Purple marks 72 walkable input tiles; amber marks a route with bends, green a direct route and red a failed query. This is pathfinding, without crowd avoidance.',
    step(delta) {if (disposed) return; if (!Number.isFinite(delta) || delta < 0 || delta > 0.1) throw new RangeError('Invalid navigation frame delta'); frames++; update(delta);},
    details: () => ({agents: agents.length, walkableInputTiles: floorMarkers, inputTriangles: indices.length / 3, frames, pathQueries, failedQueries, bentPaths, arrived, setupElapsedMilliseconds, buildElapsedMilliseconds, pathCpuMilliseconds}),
    dispose() {if (disposed) return; disposed = true; navigation.dispose(); navigation = null; paths = null;}
  };
}
