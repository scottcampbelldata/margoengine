// The one place that names @margoengine/decoders at run time. A bundler copies their Wasm when it reads a module, used or
// not, so @margoengine/gltf-pro/model must never reach this file; the root and the worker entry do. Internal: not an entry.
import type { GLTFDecoderHooks } from './asset.js';

const decoderModule: NonNullable<GLTFDecoderHooks['decoderModule']> = () => import('@margoengine/decoders');

/** The options with a way to the built-in decoders, unless the caller gave one. */
export const withDecoders = <T extends { decoders?: GLTFDecoderHooks }>(options: T): T => ({
  ...options,
  decoders: { decoderModule, ...options.decoders },
});
