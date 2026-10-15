import { IfcAPI } from 'web-ifc';
import { parseIFC } from '../../packages/ifc/dist/index.js';
import { fetchBytes } from '../../packages/loaders/dist/index.js';
import { assetWorkload, displayGeometry } from './asset-scene.js';

export async function createWorkload(count = 4, options = {}) {
  const source = await fetchBytes(new URL('../../packages/ifc/tests/fixtures/wall.ifc', import.meta.url), {
      ...options,
      maxBytes: 10000,
    }),
    api = new IfcAPI(),
    start = performance.now();
  let initializationElapsedMilliseconds = 0,
    parseCpuMilliseconds = 0,
    schema,
    products = [],
    triangles = 0,
    sourceExtentsMeters = [],
    initialized = false;
  const release = () => {
    if (initialized) {
      initialized = false;
      api.Dispose();
    }
  };
  try {
    await api.Init(
      typeof window === 'undefined'
        ? undefined
        : () => new URL('../../node_modules/web-ifc/web-ifc.wasm', import.meta.url).href,
      true,
    );
    initialized = true;
    initializationElapsedMilliseconds = performance.now() - start;
    options.signal?.throwIfAborted();
    const workload = await assetWorkload(
      count,
      (_, signal) => {
        signal.throwIfAborted();
        const started = performance.now(),
          loaded = parseIFC(api, source, { signal, maxBytes: 10000, maxVertices: 10000, maxTriangles: 20000 });
        parseCpuMilliseconds = performance.now() - started;
        schema = loaded.schema;
        products = loaded.products;
        triangles = loaded.indices.length / 3;
        const min = [Infinity, Infinity, Infinity],
          max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < loaded.positions.length; i++) {
          const axis = i % 3;
          min[axis] = Math.min(min[axis], loaded.positions[i]);
          max[axis] = Math.max(max[axis], loaded.positions[i]);
        }
        sourceExtentsMeters = max.map((value, axis) => value - min[axis]);
        return displayGeometry(loaded);
      },
      'The real IFC4 wall fixture is tessellated through the installed web-ifc runtime and Margo IFC adapter, including millimeter-to-meter placement and BIM identifiers. Rendered surfaces are those parsed triangles. Run retessellates a bounded batch once per second; this does not provide BIM property-set navigation.',
      {
        ...options,
        cleanup: release,
        details: () => ({
          sourceBytes: source.length,
          schema,
          productsPerModel: products.length,
          firstExpressID: products[0]?.expressID ?? null,
          firstProductName: products[0]?.name ?? null,
          trianglesPerModel: triangles,
          sourceExtentsMeters,
          initializationElapsedMilliseconds,
          lastParseCpuMilliseconds: parseCpuMilliseconds,
        }),
      },
    );
    Object.defineProperties(workload, { api: { get: () => api }, products: { get: () => products } });
    return workload;
  } catch (error) {
    release();
    throw error;
  }
}
