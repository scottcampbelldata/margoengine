import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { canUseWorker, movable, runWorker } from '../../shared/worker.js';
import { GLTFAsset, loadAsset, closeImages, type AssetOptions, type GLTFDecoderHooks } from './asset.js';
import { PBRModel, loadGLTF, parseGLTFAsync, type GLTFLoadOptions } from './index.js';
import { packed } from './pack.js';
import { prepareAsset, type PreparedGLTF } from './prepare.js';
export type { PreparedGLTF } from './prepare.js';
// Draco, meshopt and KTX2 decode on this thread; the instancing reader only composes the worker-decoded accessors. A custom
// fetch cannot move to the worker, so it keeps the load on this thread too.
const decoding = ({ decoders: d = {}, fetch, draco, ktx2 }: GLTFLoadOptions) =>
  !!(fetch || draco || ktx2 || d.draco || d.meshopt || d.ktx2);
/**
 * Build a PBRModel from a worker's PreparedGLTF on this thread (GPU uploads happen here, at the model's setup).
 * `decoders` takes only the `instancing` reader (@margoengine/gltf-pro/instancing) for EXT_mesh_gpu_instancing and the
 * `materials` shaders (@margoengine/gltf-pro/extended).
 */
export function modelFromPrepared(
  instance: EngineKernel,
  prepared: PreparedGLTF,
  signal?: AbortSignal,
  decoders: Pick<GLTFDecoderHooks, 'instancing' | 'materials'> = {},
): PBRModel {
  let model: PBRModel | undefined;
  try {
    signal?.throwIfAborted();
    if (prepared.deferred) throw new Error('Compressed PreparedGLTF requires the asynchronous worker loader');
    const asset = new GLTFAsset(
      prepared.doc,
      prepared.buffers,
      undefined,
      decoders,
      prepared.maxDownloadBytes,
      prepared.maxNodes,
    );
    for (const [index, data] of prepared.accessors) asset['cache'].set(index, data);
    prepared.doc.meshes?.forEach((mesh, i) =>
      mesh?.primitives?.forEach((p, j) => {
        const g = prepared.geometry[i]?.[j];
        if (g && p && typeof p === 'object') packed.set(p, g);
      }),
    );
    model = new PBRModel(instance, asset, prepared.images);
    engineRuntime(instance).use(model);
    return model;
  } catch (error) {
    if (model) model.dispose();
    else closeImages(prepared.images);
    throw error;
  }
}
async function finishPrepared(
  instance: EngineKernel,
  prepared: PreparedGLTF,
  options: GLTFLoadOptions,
): Promise<PBRModel> {
  if (prepared.deferred) {
    const { asset, images } = await loadAsset(
      prepared.baseURL,
      { ...options, buffers: prepared.buffers },
      prepared.doc,
      { device: engineRuntime(instance).gpu ?? undefined, ktx2: options.ktx2 },
      false,
      prepared.downloadedBytes,
    );
    try {
      prepared = prepareAsset(asset, images);
    } catch (error) {
      closeImages(images);
      throw error;
    }
  }
  return modelFromPrepared(instance, prepared, options.signal, options.decoders);
}
const workerURL = () => new URL(/* @vite-ignore */ './workers/gltf.js?no-inline', import.meta.url);
/**
 * loadGLTF with fetching, JSON parsing, accessor decoding, vertex packing and image decoding in a worker. Same model as
 * loadGLTF. Runs on this thread instead when Workers are unavailable or Draco, meshopt or KTX2 `decoders` or `fetch` are passed.
 */
export async function loadGLTFInWorker(
  instance: EngineKernel,
  url: string | URL,
  options: GLTFLoadOptions = {},
): Promise<PBRModel> {
  if (!canUseWorker() || decoding(options)) return loadGLTF(instance, url, options);
  return finishPrepared(
    instance,
    await runWorker<PreparedGLTF>(
      workerURL(),
      {
        url: new URL(url, globalThis.location.href).href,
        maxDownloadBytes: options.maxDownloadBytes,
        maxNodes: options.maxNodes,
        allowedURLs: options.allowedURLs,
      },
      options.signal,
    ),
    options,
  );
}
/**
 * parseGLTFAsync in a worker. A whole ArrayBuffer input (and whole `buffers`) moves to the worker and is detached here;
 * pass a copy to keep it. External URIs resolve against the page.
 */
export async function parseGLTFInWorker(
  instance: EngineKernel,
  input: string | object | ArrayBuffer | ArrayBufferView,
  options: AssetOptions & GLTFLoadOptions = {},
): Promise<PBRModel> {
  if (!canUseWorker() || decoding(options)) return parseGLTFAsync(instance, input, options);
  const message = {
    url: globalThis.location.href,
    input:
      typeof input === 'object' && !(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)
        ? input
        : movable(input),
    buffers: options.buffers?.map(movable),
    maxDownloadBytes: options.maxDownloadBytes,
    maxNodes: options.maxNodes,
    allowedURLs: options.allowedURLs,
  };
  return finishPrepared(instance, await runWorker<PreparedGLTF>(workerURL(), message, options.signal), options);
}
