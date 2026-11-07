// The package root: everything in model.ts, with loadGLTF and parseGLTFAsync able to reach the Draco and Basis decoders.
// The decoders' `new URL` files are copied by a bundler that merely reads the module, so nothing outside this file names
// them: packages that need PBRModel, GLTFAsset or parseGLTF import @margoengine/gltf-pro/model and emit no Wasm.
import type { EngineKernel } from '@margoengine/core';
import type { AssetOptions, GLTFImage } from './asset.js';
import type { GLTFLoadOptions as CompressionOptions } from './compression.js';
import { withDecoders } from './decoder-default.js';
import {
  loadGLTF as loadModel,
  parseGLTFAsync as parseModel,
  type GLTFLoadOptions,
  type PBRModel,
} from './model.js';

export * from './model.js';

/** Loads a glTF or GLB file, including Draco, meshopt and KTX2, resolving its external files against the URL. */
export function loadGLTF(instance: EngineKernel, url: string | URL, options: GLTFLoadOptions = {}): Promise<PBRModel> {
  return loadModel(instance, url, withDecoders(options));
}

/**
 * Async in-memory JSON/GLB parsing, including Draco, meshopt and KTX2. With no third argument (or an options object),
 * decodes embedded images and resolves external URIs against the page. The positional buffers/images overload uses
 * supplied ordinary bitmaps; an undefined buffers argument keeps that overload when images or later options are passed.
 */
export function parseGLTFAsync(
  instance: EngineKernel,
  input: string | object | ArrayBuffer | ArrayBufferView,
  buffersOrOptions?: Array<ArrayBuffer | ArrayBufferView> | (AssetOptions & CompressionOptions),
  images: readonly GLTFImage[] = [],
  options: GLTFLoadOptions = {},
): Promise<PBRModel> {
  if (buffersOrOptions === undefined) buffersOrOptions = arguments.length < 4 ? {} : [];
  return Array.isArray(buffersOrOptions)
    ? parseModel(instance, input, buffersOrOptions, images, withDecoders(options))
    : parseModel(instance, input, withDecoders(buffersOrOptions));
}
