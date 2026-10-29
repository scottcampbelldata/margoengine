// Which GPU a package runs on, so it can take its compatibility route on the WebGL2 layer (the roadmap
// docs, "Package plan"). Never browser sniffing: the layer's adapters, and so its devices'
// `adapterInfo`, report the vendor 'margo-webgl2'. Core never imports this file.

/** The vendor the WebGL2 compatibility layer's adapters report (`COMPAT_VENDOR` of the layer's device entry). */
export const COMPAT_VENDOR = 'margo-webgl2';

/** `'webgl2'` for a device of the WebGL2 compatibility layer, `'native'` for a browser's own WebGPU device. */
export function compatTier(device) {
  return device?.adapterInfo?.vendor === COMPAT_VENDOR ? 'webgl2' : 'native';
}

/**
 * On the WebGL2 layer, starts loading a package's compatibility route (`load`, a dynamic import, so WebGPU pages never
 * download it) and resolves what it resolves; on native WebGPU returns undefined and loads nothing. Until it resolves
 * the package keeps its WebGPU route, which the layer also runs (more slowly), so no frame is drawn differently.
 */
export function loadCompatRoute(device, load) {
  return compatTier(device) === 'webgl2' ? load() : undefined;
}
