import type {EngineKernel} from '@margoengine/core';
import type {PBRModel} from '@margoengine/gltf-pro';
import {modelFromPrepared, type PreparedGLTF} from '@margoengine/gltf-pro/worker';
import {canUseWorker, movable, runWorker} from '../../shared/worker.js';
import {loadFBX, parseFBX, type FBXOptions} from './index.js';
const workerURL = () => new URL('./workers/fbx.js?no-inline', import.meta.url);
// Texture paths resolve against the page here, so the worker gets them absolute ('' is the page's folder).
const absolute = (path: string | undefined) => path === undefined ? undefined : new URL(path || '.', globalThis.location.href).href;
/**
 * parseFBX with FBX reading, GLB conversion, glTF parsing and texture decoding in a worker; same model as parseFBX.
 * A whole ArrayBuffer input moves to the worker and is detached here (pass a copy to keep it). Runs on this thread
 * when Workers are unavailable.
 */
export async function parseFBXInWorker(engine: EngineKernel, input: ArrayBuffer | ArrayBufferView, options: FBXOptions = {}): Promise<PBRModel> {
  if (!canUseWorker()) return parseFBX(engine, input, options);
  const prepared = await runWorker<PreparedGLTF>(workerURL(), {input: movable(input), resourcePath: absolute(options.resourcePath ?? '')}, options.signal);
  return modelFromPrepared(engine, prepared, options.signal);
}
/** loadFBX with the download and all parsing in a worker; same model as loadFBX. */
export async function loadFBXInWorker(engine: EngineKernel, url: string | URL, options: FBXOptions = {}): Promise<PBRModel> {
  if (!canUseWorker()) return loadFBX(engine, url, options);
  const target = new URL(url, globalThis.location.href); if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('FBX URL needs HTTP(S)');
  const prepared = await runWorker<PreparedGLTF>(workerURL(), {url: target.href, resourcePath: absolute(options.resourcePath)}, options.signal);
  return modelFromPrepared(engine, prepared, options.signal);
}
