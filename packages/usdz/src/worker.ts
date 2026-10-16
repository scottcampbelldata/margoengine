import type { EngineKernel } from '@margoengine/core';
import type { PBRModel } from '@margoengine/gltf-pro';
import { modelFromPrepared, type PreparedGLTF } from '@margoengine/gltf-pro/worker';
import { fetchBytes, type BinaryInput } from '@margoengine/loaders';
import { canUseWorker, movable, runWorker } from '../../shared/worker.js';
import { loadUSDZ, type USDOptions } from './index.js';
import { parseUSD } from './any.js';
const workerURL = () => new URL(/* @vite-ignore */ './workers/usdz.js?no-inline', import.meta.url);
const job = ({ signal: _signal, fetch: _fetch, ...limits }: USDOptions) => limits;
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
  if (!canUseWorker()) return (await parseUSD(input, options)).create(engine, options);
  const prepared = await runWorker<PreparedGLTF>(
    workerURL(),
    { input: movable(input), options: job(options) },
    options.signal,
  );
  return modelFromPrepared(engine, prepared, options.signal);
}
/** loadUSDZ with the download, parsing and texture decoding in a worker; same model as loadUSDZ. A custom `fetch` downloads here and parses in the worker. */
export async function loadUSDZInWorker(
  engine: EngineKernel,
  url: string | URL,
  options: USDOptions = {},
): Promise<PBRModel> {
  if (!canUseWorker()) return loadUSDZ(engine, url, options);
  if (options.fetch)
    return parseUSDInWorker(
      engine,
      await fetchBytes(url, {
        maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
        signal: options.signal,
        fetch: options.fetch,
      }),
      options,
    );
  const prepared = await runWorker<PreparedGLTF>(
    workerURL(),
    { url: new URL(url, globalThis.location.href).href, options: job(options) },
    options.signal,
  );
  return modelFromPrepared(engine, prepared, options.signal);
}
