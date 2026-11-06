// One call for any glTF file: the light loader with just the entries the file needs, or gltf-pro when it refuses.
import type { EngineKernel } from '@margoengine/core';
import type { PBRModel } from '@margoengine/gltf-pro';
import { MargoError } from '@margoengine/math/errors';
import { glbChunks, isGLB } from '../../shared/glb.js';
import { parseJSON } from '../../shared/json.js';
import { readResponse } from '../../shared/loading.js';
import type { GLTFDocument } from '../../shared/gltf.js';
import { loadGLTF, type GLTFExtension, type GLTFOptions, type Model } from './index.js';

/** Options for {@link loadAuto}: those of `loadGLTF`, minus `extensions`, which the file decides. */
export interface AutoOptions extends Omit<GLTFOptions, 'extensions'> {
  signal?: AbortSignal;
  /** Fetch for the file and what it refers to. Default `globalThis.fetch`. Each URL is fetched once, whichever loader runs. */
  fetch?: typeof fetch;
}
/** What {@link loadAuto} loaded, tagged by the loader that took it. */
export type AutoModel =
  | { loader: 'gltf'; model: Model }
  | {
      loader: 'gltf-pro';
      model: PBRModel;
      /** Why the light loader refused the file. */
      reason: string;
    };

// The document is unchecked here: a field of the wrong type reads as empty, and the loader names it.
const list = <T>(value: readonly T[] | undefined): readonly T[] => (Array.isArray(value) ? value : []);
const uses = (doc: GLTFDocument, name: string) =>
  list(doc.extensionsUsed).includes(name) || list(doc.extensionsRequired).includes(name);
/** The light entries `doc` calls for, imported now. Looks only at what each entry would act on. */
async function entriesFor(doc: GLTFDocument): Promise<GLTFExtension[]> {
  const primitives = list(doc.meshes).flatMap((mesh) => list(mesh?.primitives)),
    wanted: Promise<GLTFExtension>[] = [];
  if (
    uses(doc, 'EXT_meshopt_compression') ||
    uses(doc, 'KHR_meshopt_compression') ||
    list(doc.bufferViews).some((v) => v?.extensions)
  )
    wanted.push(import('./meshopt.js').then((m) => m.meshopt));
  if (
    uses(doc, 'KHR_mesh_quantization') ||
    primitives.some((p) =>
      [p?.attributes?.POSITION, p?.attributes?.NORMAL].some(
        (id) => id !== undefined && list(doc.accessors)[id]?.componentType !== 5126,
      ),
    )
  )
    wanted.push(import('./quantized.js').then((m) => m.quantized));
  if (list(doc.materials).some((m) => m?.pbrMetallicRoughness?.baseColorTexture || m?.alphaMode === 'MASK'))
    wanted.push(import('./textured.js').then((m) => m.textured));
  if (uses(doc, 'EXT_mesh_gpu_instancing'))
    wanted.push(import('./instancing.js').then((m) => m.instancing));
  if (uses(doc, 'KHR_lights_punctual') || list(doc.nodes).some((n) => n?.camera !== undefined))
    wanted.push(import('./scene-data.js').then((m) => m.sceneExtras));
  return Promise.all(wanted);
}
function documentOf(data: Uint8Array): GLTFDocument {
  const source = isGLB(data) ? glbChunks(data)[0].data : data;
  try {
    return parseJSON<GLTFDocument | null>(new TextDecoder().decode(source)) ?? {};
  } catch (error) {
    throw new TypeError(
      `Invalid glTF JSON: ${(error as Error).message}; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator`,
    );
  }
}
/** `get`, with each URL's response kept, so a second loader reads the bytes the first one downloaded. */
function remembering(get: typeof fetch): typeof fetch {
  const seen = new Map<string, Promise<Response>>();
  return (input, init) => {
    const key = String(input instanceof Request ? input.url : input);
    let held = seen.get(key);
    if (!held) seen.set(key, (held = get(input, init)));
    return held.then((response) => response.clone());
  };
}

/**
 * Loads a .gltf or .glb without having to know what it holds. The light loader runs with only the `@margoengine/gltf/*`
 * entries the file calls for; if it refuses the file as unsupported, `@margoengine/gltf-pro` is imported and loads it from
 * the bytes already downloaded. A malformed file throws either way. gltf-pro is an optional peer: a file that needs it
 * rejects with `Install @margoengine/gltf-pro` when it is missing.
 * @example
 * const { model, loader } = await loadAuto(engine, '/any.glb');
 * // On teardown: model.dispose();
 */
export async function loadAuto(
  engine: EngineKernel,
  url: string | URL,
  { signal, fetch: get = globalThis.fetch, maxNodes, allowedURLs }: AutoOptions = {},
): Promise<AutoModel> {
  signal?.throwIfAborted();
  const cached = remembering(get),
    target = new URL(url, globalThis.location?.href);
  if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('glTF URL must use HTTP(S)');
  const data = await readResponse(await cached(target, { signal }), { maxBytes: 64 * 1024 * 1024, signal, label: 'glTF download' }),
    options = { signal, fetch: cached, maxNodes, allowedURLs };
  try {
    const extensions = await entriesFor(documentOf(data));
    return { loader: 'gltf', model: await loadGLTF(engine, target, { ...options, extensions }) };
  } catch (error) {
    if (!(error instanceof MargoError) || error.code !== 'unsupported') throw error;
    const pro = await gltfPro();
    return { loader: 'gltf-pro', model: await pro.loadGLTF(engine, target, options), reason: error.message };
  }
}
async function gltfPro(): Promise<typeof import('@margoengine/gltf-pro')> {
  try {
    return await import('@margoengine/gltf-pro');
  } catch (error) {
    if (/Cannot find|Failed to resolve|dynamically imported module/i.test((error as Error).message))
      throw new MargoError('failed', 'This glTF file needs more than the light loader; install @margoengine/gltf-pro');
    throw error;
  }
}
