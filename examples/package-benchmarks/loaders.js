import {fetchBytes, parsePLY} from '../../packages/loaders/dist/index.js';
import {assetWorkload, displayGeometry} from './asset-scene.js';

export async function createWorkload(count = 4, options = {}) {
  const source = await fetchBytes(new URL('../../packages/loaders/tests/fixtures/dolphins.ply', import.meta.url), {...options, maxBytes: 100000});
  let parseCpuMilliseconds = 0, buildCpuMilliseconds = 0, vertices = 0, triangles = 0;
  return assetWorkload(count, (_, signal) => {
    signal.throwIfAborted(); const started = performance.now(), loaded = parsePLY(source, {maxVertices: 10000, maxTriangles: 20000}), parsed = performance.now();
    const geometry = displayGeometry(loaded); parseCpuMilliseconds = parsed - started; buildCpuMilliseconds = performance.now() - parsed;
    vertices = loaded.positions.length / 3; triangles = loaded.indices.length / 3; return geometry;
  }, 'Actual PLY dolphins from the existing fixture: load with byte limits, parse positions/faces, build normals and render the resulting surfaces. Run reparses one bounded batch per simulation second; it does not refetch files.',
  {...options, details: () => ({sourceBytes: source.length, verticesPerModel: vertices, trianglesPerModel: triangles, lastParseCpuMilliseconds: parseCpuMilliseconds, lastBuildCpuMilliseconds: buildCpuMilliseconds})});
}
