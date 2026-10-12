// Module worker that runs the SAH build off the main thread and transfers the result back without copying.
import {buildBVH, type BVHBuildOptions} from './build.js';

interface BuildRequest {id: number; positions: Float32Array; stride: number; indices: Uint32Array | null; options: BVHBuildOptions; returnSource: boolean}
const scope = globalThis as unknown as {onmessage: ((event: MessageEvent<BuildRequest>) => void) | null; postMessage(message: unknown, transfer: Transferable[]): void};

scope.onmessage = ({data}) => {
  const {id, positions, stride, indices, options, returnSource} = data;
  try {
    const result = buildBVH(positions, stride, indices, options);
    const transfer: Transferable[] = [result.nodes, result.index.buffer, result.triangles.buffer];
    // Inputs the caller transferred in go back the same way so it keeps ownership of its arrays.
    if (returnSource) {
      if (!(positions.buffer instanceof SharedArrayBufferCtor())) transfer.push(positions.buffer);
      if (indices && indices.buffer !== positions.buffer && !(indices.buffer instanceof SharedArrayBufferCtor())) transfer.push(indices.buffer);
    }
    scope.postMessage({id, ...result, positions: returnSource ? positions : null, indices: returnSource ? indices : null}, transfer);
  } catch (error) {
    scope.postMessage({id, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)}, []);
  }
};

function SharedArrayBufferCtor(): new (...args: never[]) => object {
  return (typeof SharedArrayBuffer === 'function' ? SharedArrayBuffer : class {}) as unknown as new (...args: never[]) => object;
}
