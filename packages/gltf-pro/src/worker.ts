import type {EngineKernel} from '@margoengine/core';
import {engineRuntime} from '@margoengine/core/extension';
import {canUseWorker, movable, runWorker} from '../../shared/worker.js';
import {GLTFAsset, closeImages, type AssetOptions, type GLTFDecoderHooks} from './asset.js';
import {PBRModel, loadGLTF, parseGLTFAsync, type GLTFLoadOptions} from './index.js';
import {packed} from './pack.js';
import type {PreparedGLTF} from './prepare.js';
export type {PreparedGLTF} from './prepare.js';
// Draco, meshopt and KTX2 decode on this thread; the instancing reader only composes the worker-decoded accessors.
const decoding = ({decoders: d = {}}: {decoders?: GLTFDecoderHooks}) => !!(d.draco || d.meshopt || d.ktx2);
/**
 * Build a PBRModel from a worker's PreparedGLTF on this thread (GPU uploads happen here, at the model's setup).
 * `decoders` takes only the `instancing` reader (@margoengine/gltf-pro/instancing) for EXT_mesh_gpu_instancing.
 */
export function modelFromPrepared(instance: EngineKernel, prepared: PreparedGLTF, signal?: AbortSignal, decoders: Pick<GLTFDecoderHooks, 'instancing'> = {}): PBRModel {
  let model: PBRModel | undefined;
  try {
    signal?.throwIfAborted();
    const asset = new GLTFAsset(prepared.doc, prepared.buffers, undefined, decoders);
    for (const [index, data] of prepared.accessors) asset['cache'].set(index, data);
    prepared.doc.meshes?.forEach((mesh: any, i: number) => mesh?.primitives?.forEach((p: any, j: number) => {const g = prepared.geometry[i]?.[j]; if (g && p && typeof p === 'object') packed.set(p, g);}));
    model = new PBRModel(instance, asset, prepared.images);
    engineRuntime(instance).use(model); return model;
  } catch (error) {if (model) model.dispose(); else closeImages(prepared.images); throw error;}
}
const workerURL = () => new URL('./workers/gltf.js?no-inline', import.meta.url);
/**
 * loadGLTF with fetching, JSON parsing, accessor decoding, vertex packing and image decoding in a worker. Same model as
 * loadGLTF. Runs on this thread instead when Workers are unavailable or Draco, meshopt or KTX2 `decoders` are passed.
 */
export async function loadGLTFInWorker(instance: EngineKernel, url: string | URL, options: GLTFLoadOptions = {}): Promise<PBRModel> {
  if (!canUseWorker() || decoding(options)) return loadGLTF(instance, url, options);
  return modelFromPrepared(instance, await runWorker<PreparedGLTF>(workerURL(), {url: new URL(url, globalThis.location.href).href}, options.signal), options.signal, options.decoders);
}
/**
 * parseGLTFAsync in a worker. A whole ArrayBuffer input (and whole `buffers`) moves to the worker and is detached here;
 * pass a copy to keep it. External URIs resolve against the page.
 */
export async function parseGLTFInWorker(instance: EngineKernel, input: string | object | ArrayBuffer | ArrayBufferView, options: AssetOptions = {}): Promise<PBRModel> {
  if (!canUseWorker() || decoding(options)) return parseGLTFAsync(instance, input, options);
  const message = {url: globalThis.location.href, input: typeof input === 'object' && !(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input) ? input : movable(input), buffers: options.buffers?.map(movable)};
  return modelFromPrepared(instance, await runWorker<PreparedGLTF>(workerURL(), message, options.signal), options.signal, options.decoders);
}
