/** Refuse the small WebGL2 preview before a GPU-only plugin takes ownership or allocates resources. */
export function requireWebGPU<T extends { readonly backend?: string; readonly gpu: GPUDevice | null }>(
  engine: T,
  subject: string,
): asserts engine is T & { readonly gpu: GPUDevice };
