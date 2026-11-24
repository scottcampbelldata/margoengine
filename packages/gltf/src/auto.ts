// One call for any glTF file: the light loader with just the entries the file needs, or gltf/pbr when it refuses or
// passes one of its own limits.
import type { EngineKernel } from '@margoengine/core';
import type { PBRModel } from '@margoengine/gltf/pbr';
import { MargoError } from '@margoengine/math/errors';
import { glbChunks, isGLB } from '../../shared/glb.js';
import { parseJSON } from '../../shared/json.js';
import { rejectLFSPointer } from '../../shared/lfs.js';
import { captureScene } from '../../shared/scene-scope.js';
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
      loader: 'gltf/pbr';
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
  if (uses(doc, 'EXT_mesh_gpu_instancing')) wanted.push(import('./instancing.js').then((m) => m.instancing));
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
// gltf/pbr's default download budget (asset.ts assetLimit), the most any loader here reads.
const keepLimit = 512 * 1024 * 1024;
// The message readBytes gives, so each loader maps it to its own budget error.
const over = () => new RangeError('glTF download byte budget exceeded; raise maxBytes');
interface Kept {
  response: Response;
  chunks: (Uint8Array | undefined)[];
  size: number;
  error?: unknown;
}
/** A response that replays `kept`; `last` hands its chunks over one by one, so the cache holds none of them after. */
function replay({ response, chunks, error }: Kept, last: boolean): Response {
  let next = 0;
  const empty = response.body === null || [204, 205, 304].includes(response.status),
    body = empty
      ? null
      : new ReadableStream<Uint8Array>({
          pull(controller) {
            if (next < chunks.length) {
              controller.enqueue(chunks[next]!);
              if (last) chunks[next] = undefined;
              next++;
            } else if (error !== undefined) controller.error(error);
            else controller.close();
          },
        });
  const copy = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // A redirect moves the loaders' base and is checked against allowedURLs, so the copy keeps where it came from.
  return Object.defineProperties(copy, {
    url: { value: response.url },
    redirected: { value: response.redirected },
  });
}
/**
 * `get`, with each URL's bytes read once, under gltf/pbr's budget, and kept as the chunks that arrived, so a second
 * loader reads the bytes the first one downloaded without the cache holding a second copy. After `release()` the
 * cache keeps nothing new: each kept URL is handed over once more and dropped, and new URLs go straight to `get`.
 */
function remembering(get: typeof fetch): typeof fetch & { release(drop: boolean): void } {
  const seen = new Map<string, Promise<Kept>>();
  let total = 0,
    keeping = true;
  const keep = async (input: RequestInfo | URL, init?: RequestInit): Promise<Kept> => {
    const response = await get(input, init),
      kept: Kept = { response, chunks: [], size: 0 };
    if (!response.ok || !response.body) {
      response.body?.cancel().catch(() => {});
      return kept;
    }
    const reader = response.body.getReader(),
      signal = init?.signal ?? undefined,
      stop = () => reader.cancel(signal?.reason).catch(() => {});
    signal?.addEventListener('abort', stop, { once: true });
    try {
      if (Number(response.headers.get('content-length')) > keepLimit - total) throw over();
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        signal?.throwIfAborted();
        if (!(read.value instanceof Uint8Array))
          throw new TypeError(
            'glTF download stream requires byte chunks; have fetch return a Response whose body yields Uint8Array',
          );
        if (read.value.byteLength > keepLimit - total - kept.size) throw over();
        kept.chunks.push(read.value);
        kept.size += read.value.byteLength;
      }
      signal?.throwIfAborted();
      total += kept.size;
    } catch (error) {
      reader.cancel(error).catch(() => {});
      // The reader sees the failure where it would have, as it reads the body.
      kept.error = error;
      kept.chunks = [];
      kept.size = 0;
    } finally {
      signal?.removeEventListener('abort', stop);
    }
    return kept;
  };
  const cached = (input: RequestInfo | URL, init?: RequestInit) => {
    const key = String(input instanceof Request ? input.url : input);
    let held = seen.get(key);
    if (!held) {
      if (!keeping) return get(input, init);
      seen.set(key, (held = keep(input, init)));
    }
    const last = !keeping;
    if (last) seen.delete(key);
    return held.then((kept) => replay(kept, last));
  };
  return Object.assign(cached, {
    /** Stops keeping; `drop` also forgets what is kept now, which nothing will read again. */
    release(drop: boolean) {
      keeping = false;
      if (drop) seen.clear();
    },
  });
}

/**
 * Loads a .gltf or .glb without having to know what it holds. The light loader runs with only the `@margoengine/gltf/*`
 * entries the file calls for; if it refuses the file as unsupported, which includes passing a limit only the light loader
 * has (one million vertices, instances past `maxNodes`, 64 MiB of downloads), `@margoengine/gltf/pbr` is imported and loads it from the bytes
 * already downloaded, instances included. A malformed file throws either way.
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
  const target = new URL(url, globalThis.location?.href);
  if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('glTF URL must use HTTP(S)');
  const cached = remembering(get);
  try {
    // Both loaders run after awaits: each is started inside the scene this call came from.
    return await choose(engine, target, captureScene(engine), { signal, fetch: cached, maxNodes, allowedURLs });
  } finally {
    // The loader that took the file has its bytes, and a model that fetches later (images) reads past the cache.
    cached.release(true);
  }
}
async function choose(
  engine: EngineKernel,
  target: URL,
  scope: ReturnType<typeof captureScene>,
  options: Omit<AutoOptions, 'fetch'> & { fetch: ReturnType<typeof remembering> },
): Promise<AutoModel> {
  const { signal, fetch: cached } = options,
    heavy = async (reason: string, doc?: GLTFDocument): Promise<AutoModel> => {
      // gltf/pbr reads last: it takes each kept response over, so the cache holds no copy beside its bytes.
      cached.release(false);
      const pro = await import('@margoengine/gltf/pbr'),
        // gltf/pbr imports its other readers itself; without this one it would draw each instanced node once. A root
        // too large to read here is not looked into, so it gets the reader in case it needs it.
        decoders =
          !doc || uses(doc, 'EXT_mesh_gpu_instancing')
            ? { instancing: (await import('@margoengine/gltf/pbr-instancing')).instancing }
            : undefined;
      try {
        return {
          loader: 'gltf/pbr',
          model: await scope.run(() => pro.loadGLTF(engine, target, decoders ? { ...options, decoders } : options)),
          reason,
        };
      } catch (error) {
        // gltf/pbr cannot run here either (no WebGPU device): say why the light loader let go of the file first, since
        // its reason names the fix (KB-GLTFA B17).
        if (error instanceof MargoError && error.code === 'unsupported' && !error.message.includes(reason))
          throw new MargoError('unsupported', `${reason}; gltf/pbr cannot load it here either: ${error.message}`);
        throw error;
      }
    };
  let data: Uint8Array;
  try {
    data = await readResponse(await cached(target, { signal }), {
      maxBytes: 64 * 1024 * 1024,
      signal,
      label: 'glTF download',
    });
  } catch (error) {
    // Over the light loader's 64 MiB: gltf/pbr reads the bytes kept above, under its own budget.
    if (!(error instanceof RangeError)) throw error;
    return heavy("The file is over the light loader's 64 MiB");
  }
  rejectLFSPointer(data, target.href);
  const doc = documentOf(data);
  try {
    const extensions = await entriesFor(doc);
    return { loader: 'gltf', model: await scope.run(() => loadGLTF(engine, target, { ...options, extensions })) };
  } catch (error) {
    if (!(error instanceof MargoError) || error.code !== 'unsupported') throw error;
    return heavy(error.message, doc);
  }
}
