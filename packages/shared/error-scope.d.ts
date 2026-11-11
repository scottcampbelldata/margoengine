/** Calls `make()` inside out-of-memory and validation scopes; `check` resolves the first GPU error or null (undefined without scopes). */
export declare function scoped<T>(device: GPUDevice, make: () => T): [T, Promise<GPUError | null> | undefined];
