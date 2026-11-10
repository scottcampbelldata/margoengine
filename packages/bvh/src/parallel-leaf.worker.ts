import { buildBVH, type BVHBuildOptions } from './build.js';
import type { BVHPositions } from './bvh.js';

const scope = globalThis as unknown as {
  onmessage: (
    event: MessageEvent<{ positions: BVHPositions; stride: number; indices: Uint32Array; options: BVHBuildOptions }>,
  ) => void;
  postMessage(message: unknown, transfer: Transferable[]): void;
};
let positions: BVHPositions;
scope.onmessage = ({ data }) => {
  try {
    if (data.positions) positions = data.positions;
    const result = buildBVH(positions, data.stride, data.indices, data.options);
    scope.postMessage(result, [result.nodes, result.index.buffer, result.triangles.buffer]);
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) }, []);
  }
};
