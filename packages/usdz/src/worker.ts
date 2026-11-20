import type { EngineKernel } from '@margoengine/core';
import type { PBRModel } from '@margoengine/gltf/pbr';
import { modelFromPrepared, type PreparedGLTF } from '@margoengine/gltf/worker';
import { fetchBytes, type BinaryInput } from '@margoengine/loaders/common';
import { canUseWorker, movable, runWorker } from '../../shared/worker.js';
import { captureScene, type SceneScope } from '../../shared/scene-scope.js';
import type { USDExtension, USDOptions } from './index.js';
import type { ExtensionHooks } from './extension.js';

async function finish(
  engine: EngineKernel,
  prepared: PreparedGLTF,
  options: USDOptions,
  scope: SceneScope,
): Promise<PBRModel> {
  const decoders = Object.assign(
    {},
    ...(await Promise.all(
      ((options.extensions ?? []) as readonly ExtensionHooks[]).map((extension) => extension.decoders?.() ?? {}),
    )),
  );
  // The model and what its extensions add go in the scene the load started in, not the one active after the awaits.
  const model = scope.run(() => modelFromPrepared(engine, prepared, options.signal, decoders));
  try {
    for (const extension of (options.extensions ?? []) as readonly ExtensionHooks[])
      await scope.run(() => extension.created?.(engine, model));
    options.signal?.throwIfAborted();
    return model;
  } catch (error) {
    model.destroy();
    throw error;
  }
}
// The main-thread fallback loads the parser lazily, so the worker entry stays small.
const workerURL = () => new URL(/* @vite-ignore */ './workers/usdz.js?no-inline', import.meta.url);
// Extensions cross to the worker as their name and plain options; the worker makes its own copy of each.
const job = ({ signal: _signal, fetch: _fetch, extensions, ...limits }: USDOptions) => ({
  ...limits,
  extensions: extensions?.map(({ name, options }: USDExtension & { options?: unknown }) => ({ name, options })),
});
/**
 * parseUSDZ / parseUSDC / parseUSDA (by content: ZIP, Crate magic, else text) plus `create`, with parsing and texture
 * decoding in a worker; same model as on the main thread. A whole ArrayBuffer input moves to the worker and is detached
 * here (pass a copy to keep it). Runs on this thread when Workers are unavailable.
 */
export async function parseUSDInWorker(
  engine: EngineKernel,
  input: string | BinaryInput,
  options: USDOptions = {},
): Promise<PBRModel> {
  const scope = captureScene(engine);
  if (!canUseWorker()) {
    const asset = await (await import('./any.js')).parseUSD(input, options);
    return scope.run(() => asset.create(engine, options));
  }
  const prepared = await runWorker<PreparedGLTF>(
    workerURL(),
    { input: movable(input), options: job(options) },
    options.signal,
  );
  return finish(engine, prepared, options, scope);
}
/** loadUSDZ with the download, parsing and texture decoding in a worker; same model as loadUSDZ. A custom `fetch` downloads here and parses in the worker. */
export async function loadUSDZInWorker(
  engine: EngineKernel,
  url: string | URL,
  options: USDOptions = {},
): Promise<PBRModel> {
  // Each later step starts inside the scene this call came from; each captures it again before its own awaits.
  const scope = captureScene(engine);
  if (!canUseWorker()) {
    const { loadUSDZ } = await import('./any.js');
    return scope.run(() => loadUSDZ(engine, url, options));
  }
  if (options.fetch) {
    const bytes = await fetchBytes(url, {
      maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
      signal: options.signal,
      fetch: options.fetch,
    });
    return scope.run(() => parseUSDInWorker(engine, bytes, options));
  }
  const prepared = await runWorker<PreparedGLTF>(
    workerURL(),
    { url: new URL(url, globalThis.location.href).href, options: job(options) },
    options.signal,
  );
  return finish(engine, prepared, options, scope);
}
