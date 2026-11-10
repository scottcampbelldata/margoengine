import type { PBRInstances } from './instancing.js';
import type { GLTFPrimitive } from '../../shared/gltf.js';
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { canUseWorker } from '../../shared/worker.js';
import { margoError } from '../../shared/errors.js';
import { Cleanup } from '../../shared/cleanup.js';
import { worldRadius } from '../../shared/sphere.js';
import {
  GLTFAsset,
  assetLimit,
  downloadLimit,
  overBudget,
  type GLTFDocument,
  type GLTFImage,
  type GLTFDecoderHooks,
} from './asset.js';
import { PBRModel, loadGLTF, type GLTFLoadOptions, type PBRMaterial } from './index.js';
import { packed, primitiveDefs } from './pack.js';
import type { GLTFStream, StreamMessage } from './stream.js';
import type { GLTFTextureStream, GLTFTextureStreamOptions } from './texture-stream.js';
export type { GLTFTextureStream, GLTFTextureStreamOptions } from './texture-stream.js';
declare const GPUBufferUsage: { STORAGE: number; VERTEX: number; INDEX: number; COPY_DST: number };
// Same symbol PBRModel reads. Set until finish(), so setup does not bake the placeholder boxes.
const deferStaticBatches = Symbol.for('margoengine.gltf-pro.defer-static-batches');
interface StaticBatchDeferral {
  commit?: () => void;
}

/** A progress report of loadGLTFProgressive: the stage, bytes loaded and total, and primitives drawn and loaded. */
export interface ProgressiveGLTFProgress {
  /** `ready`: placeholders drawn; `geometry`/`textures`: streaming; `complete`: equal to a plain `loadGLTF` model. */
  stage: 'ready' | 'geometry' | 'textures' | 'complete';
  bytesLoaded: number;
  bytesTotal: number;
  /** Distinct glTF primitives (mesh primitives) drawn by the scene, and how many have their real geometry. */
  primitives: number;
  primitivesLoaded: number;
  images: number;
  imagesLoaded: number;
}
/**
 * Options of loadGLTFProgressive: the loadGLTF options, a progress callback and the per-frame upload budget in milliseconds.
 */
export interface ProgressiveGLTFOptions extends GLTFLoadOptions {
  onProgress?: (progress: ProgressiveGLTFProgress) => void;
  /** Main-thread milliseconds per frame spent on GPU uploads (default 4); at least one upload step runs each frame. */
  frameBudget?: number;
  /**
   * Streams KTX2 textures: each starts from its smallest levels, and finer levels load only as its size on screen calls
   * for them, inside `budgetBytes`. PNG and JPEG files hold no mips, so those load whole. Default off; off WebGPU it has no
   * effect.
   */
  textures?: boolean | GLTFTextureStreamOptions;
}
/**
 * A progressive load: `ready` resolves with placeholder boxes, `complete` with the full model, and abort() stops it.
 */
export interface ProgressiveGLTF {
  /** The model, as soon as the JSON is parsed: one box per primitive (its POSITION bounds, material colours), bounds valid. */
  readonly ready: Promise<PBRModel>;
  /** The same model once every primitive, image and byte has arrived: its GPU data then equals `loadGLTF`'s. */
  readonly complete: Promise<PBRModel>;
  /** Stop loading and dispose the model; both promises reject (disposing the model does the same). */
  abort(reason?: unknown): void;
  /** With the `textures` option: the live texture streams, which run for as long as the model lives. */
  readonly textures?: Promise<GLTFTextureStream>;
}

// Kept out of `new Worker(...)` so bundlers copy the prebuilt script as an asset instead of rebuilding it (as /worker).
const workerURL = () => new URL(/* @vite-ignore */ './workers/progressive.js?no-inline', import.meta.url);
const CHUNK = 1 << 20,
  sourceKeys = ['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif'] as const;
const errors: Record<string, ErrorConstructor> = { TypeError, RangeError, SyntaxError };
// A coded MargoError keeps its name and code across the message, so `error.code` reads as on a plain loadGLTF.
const revive = (e: { name: string; message: string; code?: string } | undefined) => {
  const message = typeof e?.message === 'string' ? e.message : 'Progressive glTF worker sent an invalid message';
  if (e?.name === 'MargoError' && typeof e.code === 'string')
    return margoError(e.code as Parameters<typeof margoError>[0], message);
  return new (Object.hasOwn(errors, e?.name ?? '') ? errors[e!.name] : Error)(message);
};
// A primitive's stand-in until its data arrives: the box of its POSITION accessor's min/max, in gltf-pro's 80-byte layout.
function box(
  doc: GLTFDocument,
  p: GLTFPrimitive,
): { vertices: Float32Array; indices: Uint32Array; lo: number[]; hi: number[] } {
  const a = doc.accessors?.[p?.attributes?.POSITION!],
    ok = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  const scale = a?.normalized
    ? (({ 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 } as Record<number, number>)[a.componentType] ?? 1)
    : 1;
  const read = (v: unknown) => (ok(v) ? v.map((x: number) => (scale > 1 ? Math.max(-1, x / scale) : x)) : [0, 0, 0]),
    lo = read(a?.min),
    hi = read(a?.max);
  const vertices = new Float32Array(24 * 20),
    indices = new Uint32Array(36);
  for (let f = 0; f < 6; f++) {
    const axis = f >> 1,
      sign = f & 1 ? 1 : -1,
      u = (axis + 1) % 3,
      v = (axis + 2) % 3,
      q = f * 4;
    for (let c = 0; c < 4; c++) {
      const o = (q + c) * 20;
      vertices[o + axis] = sign > 0 ? hi[axis] : lo[axis];
      vertices[o + u] = c & 1 ? hi[u] : lo[u];
      vertices[o + v] = c & 2 ? hi[v] : lo[v];
      vertices[o + 3] = 1;
      vertices[o + 4 + axis] = sign;
      vertices.fill(1, o + 16, o + 20);
    }
    indices.set(sign > 0 ? [q, q + 1, q + 3, q, q + 3, q + 2] : [q, q + 3, q + 1, q, q + 2, q + 3], f * 6);
  }
  return { vertices, indices, lo, hi };
}

/**
 * Load a .glb/.gltf so it is interactive at once: `ready` resolves with the model drawn as one box per primitive (fit the
 * camera to `model.bounds`), then real geometry streams in, most visible and largest on screen first (HTTP range requests
 * where the server supports them, else the whole file parsed as it arrives), then textures. Network and decoding run in a
 * worker (dist/workers/progressive.js; on this thread where Worker is unavailable); GPU uploads run here within
 * `frameBudget` ms per animation frame. Draco, meshopt or KTX2 `decoders` fall back to `loadGLTF` (ready = complete).
 */
export function loadGLTFProgressive(
  instance: EngineKernel,
  url: string | URL,
  options: ProgressiveGLTFOptions = {},
): ProgressiveGLTF {
  const { decoders = {}, signal, onProgress, frameBudget = 4 } = options,
    controller = new AbortController();
  const abort = (reason?: unknown) => controller.abort(reason);
  if (signal?.aborted) abort(signal.reason);
  else signal?.addEventListener('abort', () => abort(signal.reason), { once: true });
  const progress: ProgressiveGLTFProgress = {
    stage: 'ready',
    bytesLoaded: 0,
    bytesTotal: 0,
    primitives: 0,
    primitivesLoaded: 0,
    images: 0,
    imagesLoaded: 0,
  };
  const emit = (stage = progress.stage) => {
    progress.stage = stage;
    onProgress?.({ ...progress });
  };
  const engine = engineRuntime(instance),
    device = () => engine.gpu!,
    settings = options.textures === true ? {} : options.textures,
    textures =
      settings && engine.gpu
        ? import('./texture-stream.js').then(({ GLTFTextureStream }) =>
            GLTFTextureStream.attach(instance, settings, controller.signal),
          )
        : undefined;
  textures?.catch(() => {});
  // The whole-file loader, its KTX2 images still streaming when `textures` is on.
  const plain = async () => {
    const stream = await textures,
      loaded = await loadGLTF(instance, url, {
        ...options,
        decoders: stream ? { ...decoders, textureStream: stream } : decoders,
        signal: controller.signal,
      });
    stream?.attach(loaded);
    return loaded;
  };
  if (options.fetch || options.draco || options.ktx2 || decoders.draco || decoders.meshopt || decoders.ktx2) {
    const model = plain().then((m) => {
      emit('complete');
      return m;
    });
    model.catch(() => {});
    return { ready: model, complete: model, abort, ...(textures ? { textures } : {}) };
  }
  let resolveReady!: (m: PBRModel) => void,
    rejectReady!: (e: unknown) => void,
    resolveComplete!: (m: PBRModel) => void,
    rejectComplete!: (e: unknown) => void;
  const ready = new Promise<PBRModel>((y, n) => {
      resolveReady = y;
      rejectReady = n;
    }),
    complete = new Promise<PBRModel>((y, n) => {
      resolveComplete = y;
      rejectComplete = n;
    });
  ready.catch(() => {});
  complete.catch(() => {});
  let model: PBRModel | undefined,
    asset: GLTFAsset,
    doc: GLTFDocument,
    worker: Worker | undefined,
    stream: GLTFStream | undefined,
    finished = false;
  let images: GLTFImage[] = [],
    settled: boolean[] = [],
    real: PBRMaterial[] = [],
    bare = new Set<number>(),
    keys: number[] = [],
    byKey: number[][] = [],
    local: number[][][] = [];
  const received = new Set<number>(),
    pending = new Set<GPUBuffer>(),
    opening: Promise<void>[] = [],
    jobs: Array<() => boolean> = [],
    hooks: GLTFDecoderHooks = {};
  let geometryBytes = 0,
    lastView = '',
    lastSent = -Infinity,
    scheduled = false,
    limit = assetLimit;

  const fail = (error: unknown) => {
    if (finished) return;
    finished = true;
    worker?.terminate();
    controller.abort(error);
    for (const b of pending) b.destroy();
    pending.clear();
    if (model) model.dispose();
    else for (const image of images) (image as ImageBitmap | undefined)?.close?.();
    void textures?.then(
      (stream) => stream.dispose(),
      () => {},
    );
    rejectReady(error);
    rejectComplete(error);
  };
  controller.signal.addEventListener('abort', () => fail(controller.signal.reason), { once: true });
  const send = (order: number[]) => (worker ? worker.postMessage({ order }) : stream?.setOrder(order));
  // Wanted keys, most important first: inside the view frustum, then by bounding-sphere radius over distance (screen size).
  const order = (): number[] => {
    engine.store.tick(false);
    const camera = engine.camera,
      planes = camera.planes,
      eye = camera.position,
      cull = planes.some((v) => v !== 0),
      score = new Float64Array(byKey.length);
    model!.primitives.forEach((p, i) => {
      const [lo, hi] = local[keys[i]],
        m = p.node.matrix,
        c = [0, 1, 2].map(
          (r) =>
            (m[r] * (lo[0] + hi[0])) / 2 +
            (m[4 + r] * (lo[1] + hi[1])) / 2 +
            (m[8 + r] * (lo[2] + hi[2])) / 2 +
            m[12 + r],
        );
      // A bound that holds under shear too (a rotated child of a non-uniformly scaled parent).
      const radius = worldRadius(m, 0, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2, c[0], c[1], c[2]);
      let visible = 1;
      if (cull)
        for (let j = 0; j < 24; j += 4)
          if (planes[j] * c[0] + planes[j + 1] * c[1] + planes[j + 2] * c[2] + planes[j + 3] < -radius) visible = 0;
      const size = radius / Math.max(Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]) - radius, 1e-9);
      score[keys[i]] = Math.max(score[keys[i]], visible + size / (1 + size));
    });
    return byKey
      .map((_, k) => k)
      .filter((k) => byKey[k].length && !received.has(k))
      .sort((a, b) => score[b] - score[a]);
  };
  // Re-run gltf-pro's own setup for some primitives (sharing the model's GPU cache) and swap their draw resources in place.
  const setup = (primitives: object[]) => {
    const out: PBRModel['resources'] = [];
    try {
      PBRModel.prototype.setup.call(
        Object.create(model!, { primitives: { value: primitives }, resources: { value: out } }),
        model!['engine'],
      );
      return out;
    } catch (error) {
      for (const r of out) r.uniform.destroy();
      throw error;
    }
  };
  const rebuild = (list: number[]) => {
    const out = setup(list.map((i) => model!.primitives[i])),
      resources = model!['resources'],
      cleanup = new Cleanup();
    list.forEach((i, j) => {
      const previous = resources[i];
      cleanup.run(() => previous.uniform.destroy()).run(() => previous.wireframe?.index.destroy());
      resources[i] = out[j];
    });
    cleanup.finish();
  };
  // One texture (upload + mips) per step: a throwaway setup with only map k fills the cache; the last step swaps the material.
  const texture = (i: number) => {
    const maps = real[i].maps;
    let k = 0;
    return () => {
      while (k < maps.length && !maps[k]) k++;
      if (k < maps.length) {
        const only = k++;
        setup([
          {
            ...model!.primitives[i],
            material: { ...real[i], maps: maps.map((m: unknown, j: number) => (j === only ? m : undefined)) },
          },
        ])[0].uniform.destroy();
        return false;
      }
      model!.primitives[i].material = real[i];
      rebuild([i]);
      emit('textures');
      return true;
    };
  };
  // Primitives whose every candidate image (fallback and extension sources) has settled can take their real material.
  const texturesReady = (all = false) => {
    for (const i of bare) {
      const sources = real[i].maps.flatMap((map) => {
        const t = map && doc.textures?.[map.index];
        return t
          ? ([t.source, ...sourceKeys.map((k) => t.extensions?.[k]?.source)].filter(Number.isSafeInteger) as number[])
          : [];
      });
      if (all || sources.every((s: number) => settled[s])) {
        bare.delete(i);
        jobs.push(texture(i));
      }
    }
  };
  const geometry = (key: number, vertices: Float32Array, indices: Uint32Array, uvs?: Float32Array) => {
    const uploads = [
      {
        data: vertices,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE,
        at: 0,
        buffer: undefined as GPUBuffer | undefined,
      },
      { data: indices, usage: GPUBufferUsage.INDEX, at: 0, buffer: undefined as GPUBuffer | undefined },
      ...(uvs ? [{ data: uvs, usage: GPUBufferUsage.VERTEX, at: 0, buffer: undefined as GPUBuffer | undefined }] : []),
    ];
    geometryBytes += vertices.byteLength + indices.byteLength + (uvs?.byteLength ?? 0);
    if (geometryBytes > limit * 4) throw overBudget('Decoded glTF geometry exceeds byte budget', limit * 4);
    // Large buffers upload in 1 MB writes spread over frames; the primitive switches once both are complete.
    return () => {
      const u = uploads.find((u) => u.at < u.data.byteLength);
      if (u) {
        if (!u.buffer) {
          if (u.data.byteLength > device().limits.maxBufferSize)
            throw new RangeError(
              'PBR buffer exceeds device limit; load a smaller model, or reduce its textures and meshes',
            );
          pending.add(
            (u.buffer = device().createBuffer({ size: u.data.byteLength, usage: u.usage | GPUBufferUsage.COPY_DST })),
          );
        }
        const bytes = new Uint8Array(u.data.buffer, u.data.byteOffset, u.data.byteLength),
          end = Math.min(u.at + CHUNK, bytes.length);
        device().queue.writeBuffer(u.buffer, u.at, bytes.subarray(u.at, end));
        u.at = end;
        return false;
      }
      const cache = model!['gpuCache'],
        old = new Set<object>();
      for (const { data, buffer } of uploads) {
        cache.set(data, buffer!);
        pending.delete(buffer!);
      }
      for (const i of byKey[key]) {
        const p = model!.primitives[i];
        old.add(p.vertices);
        old.add(p.indices);
        p.vertices = vertices;
        p.indices = indices;
        if (uvs) p.uvs = uvs;
      }
      rebuild(byKey[key]);
      // Through the model, which counts buffers other models may share (PBRModel dropBuffer).
      for (const data of old) {
        const buffer = cache.get(data) as GPUBuffer | undefined;
        if (buffer) model!['dropBuffer'](device(), buffer);
      }
      progress.primitivesLoaded++;
      emit('geometry');
      return true;
    };
  };
  const finish = (buffers: Uint8Array[], accessors: [number, Float32Array][]) => () => {
    buffers.forEach((b, i) => {
      (asset.buffers as Uint8Array[])[i] = b;
    });
    for (const [id, data] of accessors) asset['cache'].set(id, data);
    // EXT_mesh_gpu_instancing reads its accessors, so it applies now (one PBRInstances per node, as PBRModel's constructor).
    if (decoders.instancing) {
      hooks.instancing = decoders.instancing;
      const made = new Map<number, PBRInstances | undefined>();
      for (const p of model!.primitives) {
        const ext = doc.nodes![p.nodeIndex]?.extensions?.EXT_mesh_gpu_instancing;
        if (ext) {
          if (!made.has(p.nodeIndex)) made.set(p.nodeIndex, decoders.instancing.read(asset, ext));
          p.instances = made.get(p.nodeIndex);
        }
      }
    }
    // Default 1x1 maps that only stood in for textures are freed, so the model holds what loadGLTF's holds.
    const cache = model!['gpuCache'];
    const used = new Set(
      model!.primitives.flatMap((p) => p.material.maps.map((m: unknown, i: number) => (m ? -1 : i))),
    );
    for (const [key, t] of cache)
      if (typeof key === 'string' && key.startsWith('default:') && !used.has(+key.slice(8)))
        model!['dropTexture'](device(), key, t as GPUTexture);
    // Instances and final vertices are in place, so the baked batches match a direct loadGLTF.
    (asset as GLTFAsset & { [deferStaticBatches]?: StaticBatchDeferral })[deferStaticBatches]?.commit?.();
    finished = true;
    worker?.terminate();
    emit('complete');
    resolveComplete(model!);
    return true;
  };
  const pump = () => {
    scheduled = false;
    if (finished) return;
    try {
      const start = performance.now(),
        camera = engine.camera,
        view = String(camera.position) + camera.target;
      if (model && view !== lastView && start - lastSent > 200) {
        lastView = view;
        lastSent = start;
        send(order());
      }
      do {
        if (jobs.length && jobs[0]()) jobs.shift();
      } while (jobs.length && !finished && performance.now() - start < frameBudget);
    } catch (error) {
      fail(error);
      return;
    }
    schedule();
  };
  // Uploads run once per animation frame; a timer keeps loading going where frames stop (hidden tab, no rAF).
  const schedule = () => {
    if (scheduled || finished) return;
    scheduled = true;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : 0,
      timer = setTimeout(run, raf ? 100 : 16);
    function run() {
      clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
      if (scheduled) pump();
    }
  };
  const build = (d: GLTFDocument) => {
    doc = d;
    const defs = primitiveDefs(doc),
      keyOf = new Map(defs.map((p, k) => [p, k]));
    // Placeholder geometry through the worker path's packed-geometry map; the buffers fill in when the stream completes.
    defs.forEach((p, k) => {
      const b = box(doc, p);
      local[k] = [b.lo, b.hi];
      if (p && typeof p === 'object') packed.set(p, b);
    });
    if (decoders.instancing) hooks.instancing = { read: () => undefined };
    if (decoders.materials) hooks.materials = decoders.materials;
    // Placeholder buffers at their declared sizes: checked against the budget before they are allocated.
    const sizes = (doc.buffers ?? []).map((b) =>
      Number.isSafeInteger(b?.byteLength) && b.byteLength > 0 ? b.byteLength : 0,
    );
    if (sizes.reduce((sum, n) => sum + n, 0) > limit) throw overBudget('glTF buffers exceed byte budget', limit);
    asset = new GLTFAsset(
      doc,
      sizes.map((n) => new Uint8Array(n)),
      undefined,
      hooks,
      limit,
      options.maxNodes,
    );
    (asset as GLTFAsset & { [deferStaticBatches]?: StaticBatchDeferral })[deferStaticBatches] = {};
    images = Array.from(doc.images ?? [], () => undefined);
    settled = images.map(() => false);
    progress.images = images.length;
    model = new PBRModel(instance, asset, images);
    byKey = defs.map(() => []);
    keys = model.primitives.map((p, i) => {
      const k = keyOf.get(p.definition)!;
      byKey[k].push(i);
      return k;
    });
    progress.primitives = byKey.filter((list) => list.length).length;
    // Until its images arrive a primitive draws with its material's factors only.
    const stripped = new Map<object, PBRMaterial>();
    real = model.primitives.map((p, i) => {
      const m = p.material;
      if (!m.maps.some(Boolean)) return m;
      if (!stripped.has(m))
        stripped.set(
          m,
          Object.defineProperties(
            Object.assign(Object.create(Object.getPrototypeOf(m), Object.getOwnPropertyDescriptors(m)), {
              maps: m.maps.map(() => undefined),
            }),
            {
              side: Object.getOwnPropertyDescriptor(m, 'side')!,
              wireframe: {
                enumerable: true,
                get: () => m.wireframe,
                set: (value: boolean | undefined) => {
                  m.wireframe = value;
                },
              },
            },
          ),
        );
      p.material = stripped.get(m)!;
      bare.add(i);
      return m;
    });
    engine.use(model);
    model.onDispose(() => abort(new DOMException('Model disposed while loading', 'AbortError')));
    void textures?.then((stream) => stream.attach(model!), fail);
    // The first order goes out on the next frame, after the app has had `ready` and placed its camera.
    emit('ready');
    resolveReady(model);
    schedule();
  };
  const message = (m: StreamMessage) => {
    if (finished) {
      if (m.type === 'image' && m.image && 'close' in m.image) m.image.close();
      return;
    }
    try {
      if (m.type === 'fallback') {
        worker?.terminate();
        worker = undefined;
        void plain().then((loaded) => {
          if (finished) {
            loaded.dispose();
            return;
          }
          model = loaded;
          finished = true;
          emit('complete');
          resolveReady(loaded);
          resolveComplete(loaded);
        }, fail);
      } else if (m.type === 'doc') build(m.doc);
      else if (m.type === 'geometry') {
        if (m.error) throw revive(m.error);
        received.add(m.key);
        jobs.push(geometry(m.key, m.vertices!, m.indices!, m.uvs));
      } else if (m.type === 'image') {
        if (!Number.isInteger(m.index) || m.index < 0 || m.index >= images.length)
          throw new RangeError(
            'Progressive glTF worker sent an invalid image index; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
          );
        const { index, source } = m;
        if (source)
          opening.push(
            textures!
              .then((stream) => stream.open(source))
              .then((image) => {
                if (finished) {
                  image.close();
                  return;
                }
                images[index] = image;
                settled[index] = true;
                progress.imagesLoaded++;
                texturesReady();
              })
              .catch(fail),
          );
        else {
          images[index] = m.image;
          settled[index] = true;
          if (m.image) progress.imagesLoaded++;
          texturesReady();
        }
      } else if (m.type === 'bytes') {
        progress.bytesLoaded = m.loaded;
        progress.bytesTotal = m.total;
        if (model) emit();
      } else if (m.type === 'done') {
        const { buffers, accessors } = m;
        // Streams still opening hold their primitives back until their smallest levels are on the GPU.
        void Promise.all(opening).then(() => {
          if (finished) return;
          texturesReady(true);
          jobs.push(finish(buffers, accessors));
        });
      } else throw revive(m.error);
    } catch (error) {
      fail(error);
    }
  };
  try {
    signal?.throwIfAborted();
    limit = downloadLimit(options.maxDownloadBytes);
    const href = new URL(url, globalThis.location?.href).href;
    if (canUseWorker()) {
      worker = new Worker(workerURL(), { name: 'margoengine-progressive' });
      // Replies come only from this package's worker; anything that is not an object fails the load instead of throwing here.
      worker.onmessage = ({ data }) =>
        message(
          data && typeof data === 'object'
            ? data
            : {
                type: 'error',
                error: { name: 'TypeError', message: 'Progressive glTF worker sent an invalid message' },
              },
        );
      worker.onerror = (event) => {
        event.preventDefault?.();
        fail(new Error('Progressive glTF worker failed: ' + (event.message || 'unknown error')));
      };
      worker.onmessageerror = () => fail(new Error('Progressive glTF worker message could not be deserialized'));
      worker.postMessage({
        url: href,
        maxDownloadBytes: limit,
        maxNodes: options.maxNodes,
        allowedURLs: options.allowedURLs,
        textures: !!textures,
      });
    } else
      import('./stream.js').then(({ GLTFStream }) => {
        if (!finished)
          (stream = new GLTFStream(
            new URL(href),
            message,
            controller.signal,
            limit,
            options.maxNodes,
            options.allowedURLs,
            !!textures,
          )).run();
      }, fail);
  } catch (error) {
    fail(error);
  }
  return { ready, complete, abort, ...(textures ? { textures } : {}) };
}
