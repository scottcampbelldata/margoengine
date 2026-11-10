// A dedicated CPU worker: SIMD rasterization and the same polygon pipeline as ./build and ./tiles.
import { rasterKernel } from './raster-kernel.js';
import { failed, gridOf, solve, validate, type Grid, type NavigationOptions } from './pipeline.js';
import { TiledNavMesh } from './tiles.js';
import { encodeNavMesh, encodeTiledNavMesh } from './codec.js';
import type { NavBuildWork } from './wasm.js';

const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(data: unknown, transfer: Transferable[]): void;
};
worker.onmessage = async ({ data }) => {
  try {
    const work: NavBuildWork = { cells: 0, intersections: 0, vectorPairs: 0, rasterCalls: 0, memoryBytes: 0 },
      raster = await rasterKernel(data.wasm, work);
    let bytes: Uint8Array;
    if (data.tiled) {
      class WasmTiles extends TiledNavMesh {
        protected override buildTile(
          points: Float32Array,
          triangles: Uint32Array,
          config: Required<NavigationOptions>,
          grid: Grid,
        ) {
          return solve(points, triangles, config, grid, raster);
        }
      }
      using mesh = new WasmTiles(data.positions, data.indices, data.options);
      bytes = encodeTiledNavMesh(mesh, { geometry: true });
    } else {
      const input = validate(data.positions, data.indices, data.options),
        built = solve(input.points, input.triangles, input.config, gridOf(input), raster);
      if (typeof built === 'string') failed(built);
      bytes = encodeNavMesh(built.mesh);
    }
    worker.postMessage({ bytes, work }, [bytes.buffer]);
  } catch (error) {
    const e = error as Error & { code?: string };
    worker.postMessage({ error: { name: e.name, message: e.message, code: e.code } }, []);
  }
};
