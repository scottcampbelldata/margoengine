export const instanceLayout: GPUVertexBufferLayout;
export function instancedDepth(code: string): string;
export function instanceMatrix<T extends Float32Array | Float64Array>(
  node: ArrayLike<number>,
  data: ArrayLike<number>,
  k: number,
  out: T,
): T;
