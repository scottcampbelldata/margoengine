import { hasStrokes } from './stroke-width.js';
import { margoError } from '../../shared/errors.js';
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { canUseWorker, movable, runWorker } from '../../shared/worker.js';
import { captureScene, type SceneScope } from '../../shared/scene-scope.js';
import { GLTFAsset, loadAsset, closeImages, type AssetOptions, type GLTFDecoderHooks } from './asset.js';
import { PBRModel, loadGLTF, parseGLTFAsync, type GLTFLoadOptions } from './pbr.js';
import { packed } from './pack.js';
import { partLimit } from './parts.js';
import { withDecoders } from './decoder-default.js';
import { prepareAsset, type PreparedGLTF } from './prepare.js';
import type { PreparedGeometry } from './pbr.js';
export type { PreparedGLTF } from './prepare.js';
// Draco, meshopt and KTX2 decode on this thread; the instancing reader only composes the worker-decoded accessors. A custom
// fetch cannot move to the worker, so it keeps the load on this thread too.
const decoding = ({ decoders: d = {}, fetch, draco, ktx2 }: GLTFLoadOptions) =>
  !!(fetch || draco || ktx2 || d.draco || d.meshopt || d.ktx2);
/**
 * Build a PBRModel from a worker's PreparedGLTF on this thread (GPU uploads happen here, at the model's setup).
 * `decoders` takes only the `instancing` reader (@margoengine/gltf/pbr-instancing) for EXT_mesh_gpu_instancing and the
 * `materials` shaders (@margoengine/gltf/extended-materials). Points and lines draw 1 px wide.
 */
export function modelFromPrepared(
  instance: EngineKernel,
  prepared: PreparedGLTF,
  signal?: AbortSignal,
  decoders: Pick<GLTFDecoderHooks, 'instancing' | 'materials'> = {},
): PBRModel {
  return preparedModel(instance, prepared, signal, decoders);
}
/** `modelFromPrepared` that also takes the `strokes` reader, whose primitives `model.attachStrokes` then hands over. */
function preparedModel(
  instance: EngineKernel,
  prepared: PreparedGLTF,
  signal: AbortSignal | undefined,
  decoders: Pick<GLTFDecoderHooks, 'instancing' | 'materials' | 'strokes'>,
): PBRModel {
  let model: PBRModel | undefined;
  try {
    signal?.throwIfAborted();
    if (prepared.deferred)
      throw margoError(
        'state',
        'Compressed PreparedGLTF requires the asynchronous worker loader; call loadGLTF or parseGLTFAsync',
      );
    const asset = new GLTFAsset(
      prepared.doc,
      prepared.buffers,
      undefined,
      decoders,
      prepared.maxDownloadBytes,
      prepared.maxNodes,
    );
    asset.baseURL = prepared.baseURL;
    if (prepared.maxPartVertices !== undefined) asset.partVertices = partLimit(prepared.maxPartVertices);
    for (const [index, data] of prepared.accessors) asset['cache'].set(index, data);
    prepared.doc.meshes?.forEach((mesh, i) =>
      mesh?.primitives?.forEach((p, j) => {
        const g = prepared.geometry[i]?.[j];
        if (g && p && typeof p === 'object') packed.set(p, Array.isArray(g) ? g : [g as PreparedGeometry]);
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
  scope: SceneScope,
): Promise<PBRModel> {
  if (prepared.deferred) {
    const { asset, images } = await loadAsset(
      prepared.baseURL,
      withDecoders({ ...options, buffers: prepared.buffers }),
      prepared.doc,
      { device: engineRuntime(instance).gpu ?? undefined, ktx2: options.ktx2 },
      false,
      prepared.downloadedBytes,
    );
    // Splats are not vertices: the file loads as loadGLTF does, on this thread.
    if (asset.hooks.splats) {
      const model = scope.run(() => new PBRModel(instance, asset, images));
      try {
        scope.run(() => engineRuntime(instance).use(model));
        await scope.run(() => model.attachSplats(options.signal));
        await scope.run(() => model.attachStrokes(options.signal));
        return model;
      } catch (error) {
        model.dispose();
        throw error;
      }
    }
    try {
      prepared = prepareAsset(asset, images);
    } catch (error) {
      closeImages(images);
      throw error;
    }
  }
  // Points and lines that ask for a width are drawn wide on this thread, as loadGLTF draws them.
  const given = options.decoders ?? {},
    decoders =
      given.strokes === undefined && hasStrokes(prepared.doc)
        ? { ...given, strokes: (await import('./strokes.js')).wideStrokes }
        : given,
    model = scope.run(() => preparedModel(instance, prepared, options.signal, decoders));
  try {
    await scope.run(() => model.attachStrokes(options.signal));
    return model;
  } catch (error) {
    model.dispose();
    throw error;
  }
}
const workerURL = () => new URL(/* @vite-ignore */ './workers/gltf.js?no-inline', import.meta.url);
/**
 * loadGLTF with fetching, JSON parsing, accessor decoding, vertex packing and image decoding in a worker. Same model as
 * loadGLTF. Runs on this thread instead when Workers are unavailable, when Draco, meshopt or KTX2 `decoders` or `fetch` are passed, or with `optimize`.
 */
export async function loadGLTFInWorker(
  instance: EngineKernel,
  url: string | URL,
  options: GLTFLoadOptions = {},
): Promise<PBRModel> {
  if (!canUseWorker() || decoding(options) || options.optimize) return loadGLTF(instance, url, options);
  const scope = captureScene(instance);
  return finishPrepared(
    instance,
    await runWorker<PreparedGLTF>(
      workerURL(),
      {
        url: new URL(url, globalThis.location.href).href,
        maxDownloadBytes: options.maxDownloadBytes,
        maxNodes: options.maxNodes,
        allowedURLs: options.allowedURLs,
        maxPartVertices: options.maxPartVertices,
      },
      options.signal,
    ),
    options,
    scope,
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
  const scope = captureScene(instance),
    message = {
      url: globalThis.location.href,
      input:
        typeof input === 'object' && !(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)
          ? input
          : movable(input),
      buffers: options.buffers?.map(movable),
      maxDownloadBytes: options.maxDownloadBytes,
      maxNodes: options.maxNodes,
      allowedURLs: options.allowedURLs,
      maxPartVertices: options.maxPartVertices,
    };
  return finishPrepared(instance, await runWorker<PreparedGLTF>(workerURL(), message, options.signal), options, scope);
}
