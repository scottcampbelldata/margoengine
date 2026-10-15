import { fetchBytes, parseOFF, parseUSDZ } from '../../packages/loaders/dist/index.js';
import { exportUSDZ } from '../../packages/usdz-export/dist/index.js';
import { assetWorkload, displayGeometry, geometryData } from './asset-scene.js';

export async function createWorkload(count = 4, options = {}) {
  const source = await fetchBytes(
    new URL('../../packages/loaders/tests/fixtures/decimated-knight.off', import.meta.url),
    { ...options, maxBytes: 100000 },
  );
  const data = geometryData(displayGeometry(parseOFF(source)));
  let outputBytes = 0,
    exportCpuMilliseconds = 0,
    importElapsedMilliseconds = 0,
    snapshot;
  const result = await assetWorkload(
    count,
    async (_, signal) => {
      signal.throwIfAborted();
      const started = performance.now();
      const output = exportUSDZ({
        nodes: [
          {
            name: 'Fixture knight',
            geometry: data,
            material: { color: [0.3, 0.6, 0.45, 1], roughness: 0.65, doubleSided: true },
          },
        ],
      });
      exportCpuMilliseconds = performance.now() - started;
      const parsing = performance.now(),
        loaded = await parseUSDZ(output, { signal, maxVertices: 10000, maxTriangles: 20000 });
      importElapsedMilliseconds = performance.now() - parsing;
      signal.throwIfAborted();
      outputBytes = output.length;
      snapshot = output;
      return displayGeometry(loaded);
    },
    'The standalone USDZ-export package writes the real fixture knight into its aligned USDA archive. Displayed surfaces are parsed from those actual bytes. Run performs one bounded batch per simulation second. This static preview does not claim Apple Quick Look or texture export support.',
    {
      ...options,
      material: { color: [0.3, 0.6, 0.45], roughness: 0.65 },
      details: () => ({
        sourceBytes: source.length,
        sourceVertices: data.positions.length / 3,
        sourceTriangles: data.indices.length / 3,
        outputBytes,
        lastExportCpuMilliseconds: exportCpuMilliseconds,
        lastImportElapsedMilliseconds: importElapsedMilliseconds,
      }),
    },
  );
  Object.defineProperty(result, 'snapshot', { get: () => snapshot });
  return result;
}
