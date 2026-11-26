export const instanceLayout: GPUVertexBufferLayout;
export function instancedDepth(code: string): string;
export function instanceMatrix<T extends Float32Array | Float64Array>(
  node: ArrayLike<number>,
  data: ArrayLike<number>,
  k: number,
  out: T,
): T;
/** True when the primitive's material reads data by instance index, so its instance rows must keep their order. */
export function readsRows(primitive: object): boolean;
