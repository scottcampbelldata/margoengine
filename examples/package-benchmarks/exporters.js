import { fetchBytes, parseOFF, parsePLY } from '../../packages/loaders/dist/index.js';
import { exportGLB, exportPLY, exportOBJ, exportSTL } from '../../packages/exporters/dist/index.js';
import { assetWorkload, displayGeometry, geometryData } from './asset-scene.js';

export async function createWorkload(count = 4, options = {}) {
  const source = await fetchBytes(
    new URL('../../packages/loaders/tests/fixtures/decimated-knight.off', import.meta.url),
    { ...options, maxBytes: 100000 },
  );
  const data = geometryData(displayGeometry(parseOFF(source)));
  let glbBytes = 0,
    plyBytes = 0,
    stlBytes = 0,
    objCharacters = 0,
    exportCpuMilliseconds = 0,
    roundTripCpuMilliseconds = 0,
    snapshot;
  const result = await assetWorkload(
    count,
    (_, signal) => {
      signal.throwIfAborted();
      const scene = {
          nodes: [
            {
              name: 'Fixture knight',
              geometry: data,
              material: { color: [0.3, 0.6, 0.45, 1], roughness: 0.65, doubleSided: true },
            },
          ],
        },
        started = performance.now();
      const ply = exportPLY(scene, { binary: true, colors: true }),
        glb = exportGLB(scene),
        stl = exportSTL(scene),
        obj = exportOBJ(scene, { materials: true });
      exportCpuMilliseconds = performance.now() - started;
      const parsed = performance.now(),
        loaded = parsePLY(ply),
        geometry = displayGeometry(loaded);
      roundTripCpuMilliseconds = performance.now() - parsed;
      glbBytes = glb.length;
      plyBytes = ply.length;
      stlBytes = stl.length;
      objCharacters = obj.obj.length;
      snapshot = glb;
      return geometry;
    },
    'The real OFF knight fixture is serialized to GLB, binary PLY, STL and OBJ/MTL. Displayed surfaces come from parsing the emitted PLY. Run repeats a bounded export/round-trip batch once per simulation second; CPU counters separate writing and reimport.',
    {
      ...options,
      material: { color: [0.3, 0.6, 0.45], roughness: 0.65 },
      details: () => ({
        sourceBytes: source.length,
        sourceVertices: data.positions.length / 3,
        sourceTriangles: data.indices.length / 3,
        glbBytes,
        plyBytes,
        stlBytes,
        objCharacters,
        lastExportCpuMilliseconds: exportCpuMilliseconds,
        lastRoundTripCpuMilliseconds: roundTripCpuMilliseconds,
      }),
    },
  );
  Object.defineProperty(result, 'snapshot', { get: () => snapshot });
  return result;
}
