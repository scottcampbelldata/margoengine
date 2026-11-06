/** The vendor the WebGL2 compatibility layer's adapters report (`COMPAT_VENDOR` of the layer's device entry). */
export const COMPAT_VENDOR: 'margo-webgl2';
/** `'webgl2'` for a device of the WebGL2 compatibility layer, `'native'` for a browser's own WebGPU device. */
export function compatTier(device: GPUDevice | undefined): 'native' | 'webgl2';
/**
 * On the WebGL2 layer, starts loading a package's compatibility route (`load`, a dynamic import) and resolves what it
 * resolves; on native WebGPU returns undefined and loads nothing.
 */
export function compatibilityLevel(device: { adapterInfo?: { vendor?: string }; features?: { has(name: string): boolean } } | undefined): boolean;
export function loadCompatRoute<T>(device: GPUDevice | undefined, load: () => Promise<T>): Promise<T> | undefined;
