import {MeshBVH, CONTAINED, INTERSECTED, NOT_INTERSECTED} from '../../packages/bvh/dist/index.js';
import {grid} from './layout.js';

const cells = 100, row = cells + 1;

export function createWorkload(count = 256) {
  if (!Number.isInteger(count) || count < 1 || count > 1024) throw new RangeError('BVH workload count must be 1..1024');
  const points = grid(count), origins = points.slice(), extent = Math.ceil(Math.sqrt(count)) * 0.2 + 0.5;
  let source = {positions: new Float32Array(row * row * 3), indices: new Uint32Array(cells * cells * 6)};
  for (let z = 0; z <= cells; z++) for (let x = 0; x <= cells; x++) {
    const offset = (z * row + x) * 3;
    source.positions[offset] = (x / cells * 2 - 1) * extent;
    source.positions[offset + 2] = (z / cells * 2 - 1) * extent;
  }
  for (let z = 0; z < cells; z++) for (let x = 0; x < cells; x++) {
    const a = z * row + x, b = a + 1, c = a + row, d = c + 1, offset = (z * cells + x) * 6;
    source.indices.set([a, c, b, b, c, d], offset);
  }
  function deform(time) {
    const vertices = source.positions;
    for (let i = 0; i < vertices.length; i += 3) vertices[i + 1] = 0.55 + Math.sin(vertices[i] * 0.9 + time) * Math.cos(vertices[i + 2] * 0.7 - time * 0.6) * 0.3;
  }
  deform(0);
  const start = performance.now();
  let bvh = MeshBVH.build(source), disposed = false;
  const buildCpuMilliseconds = performance.now() - start, triangleCount = bvh.triangleCount, nodeCount = bvh.nodeCount;
  const rays = Array.from({length: count}, () => ({origin: new Float64Array(3), direction: new Float64Array([0, -1, 0])}));
  const options = {near: 0, far: 4, side: 'front'};
  const selectedFaces = new Uint8Array(triangleCount), region = new Float64Array(4);
  let time = 0, refits = 0, queries = 0, shapecasts = 0, selected = 0, hits = 0, misses = 0, deformMs = 0, refitMs = 0, shapecastMs = 0, raycastMs = 0;
  const regionQuery = {
    intersectsBounds(box) {
      if (box.max[0] < region[0] || box.min[0] > region[2] || box.max[2] < region[1] || box.min[2] > region[3]) return NOT_INTERSECTED;
      return box.min[0] >= region[0] && box.max[0] <= region[2] && box.min[2] >= region[1] && box.max[2] <= region[3] ? CONTAINED : INTERSECTED;
    },
    intersectsRange(offset, count) {
      for (let i = offset; i < offset + count; i++) {selectedFaces[bvh.triangles[i]] = 1; selected++;}
    }
  };
  return {points, rays, extent, selectedFaces,
    get bvh() {return bvh;}, get source() {return source;},
    bounds: {min: [-extent, 0, -extent], max: [extent + 0.7, 2.2, extent]},
    description: 'Build a 20,000-triangle heightfield once, then deform, refit and query it each frame. Boxes follow ray hits; amber marks triangles returned by a moving BVH broad-phase region, green marks other hits, and red marks missed ray origins. Initial build time is separate from frame CPU time.',
    step(delta) {
      if (disposed) return;
      if (!Number.isFinite(delta) || delta < 0 || delta > 0.1) throw new RangeError('BVH frame delta must be finite and within 0..0.1 seconds');
      time += delta;
      const start = performance.now(); deform(time); const deformed = performance.now(); bvh.refit(); const refitted = performance.now();
      const cx = Math.sin(time * 0.8) * extent * 0.45, cz = Math.cos(time * 0.6) * extent * 0.35, half = extent * 0.3;
      region[0] = cx - half; region[1] = cz - half; region[2] = cx + half; region[3] = cz + half;
      selectedFaces.fill(0); selected = 0; bvh.shapecast(regionQuery); shapecasts++; const selectedAt = performance.now();
      refits++; hits = misses = 0;
      for (let i = 0; i < count; i++) {
        const ray = rays[i], offset = i * 4, phase = time * 0.7 + i * 0.173;
        ray.origin[0] = origins[offset] + Math.sin(phase) * 0.09;
        ray.origin[1] = 2; ray.origin[2] = origins[offset + 2] + Math.cos(phase) * 0.09;
        ray.direction[0] = Math.sin(phase) * 0.05; ray.direction[2] = Math.cos(phase) * 0.05;
        if (i % 16 === 0) ray.origin[0] = extent + 0.5;
        const hit = bvh.raycastFirst(ray, options); queries++;
        if (hit) {
          hits++; points[offset] = hit.point[0]; points[offset + 1] = hit.point[1] + 0.12; points[offset + 2] = hit.point[2];
          points[offset + 3] = selectedFaces[hit.faceIndex];
        } else {
          misses++; points[offset] = ray.origin[0]; points[offset + 1] = ray.origin[1]; points[offset + 2] = ray.origin[2]; points[offset + 3] = 3;
        }
      }
      const end = performance.now(); deformMs = deformed - start; refitMs = refitted - deformed; shapecastMs = selectedAt - refitted; raycastMs = end - selectedAt;
    },
    details: () => ({triangles: triangleCount, nodes: nodeCount, raysPerFrame: count, hits, misses, queries, refits, shapecasts, broadPhaseTriangles: selected, buildCpuMilliseconds,
      deformCpuMilliseconds: deformMs, refitCpuMilliseconds: refitMs, shapecastCpuMilliseconds: shapecastMs, raycastCpuMilliseconds: raycastMs}),
    dispose() {disposed = true; bvh = source = null;}
  };
}
