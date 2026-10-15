import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { canUseWorker } from '../../shared/worker.js';
import { GLTFAsset, assetLimit, downloadLimit, overBudget, type GLTFDocument, type GLTFImage } from './asset.js';
import { PBRModel, loadGLTF, type GLTFLoadOptions } from './index.js';
import { packed, primitiveDefs } from './pack.js';
import type { GLTFStream, StreamMessage } from './stream.js';
declare const GPUBufferUsage: { STORAGE: number; VERTEX: number; INDEX: number; COPY_DST: number };

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
export interface ProgressiveGLTFOptions extends GLTFLoadOptions {
  onProgress?: (progress: ProgressiveGLTFProgress) => void;
  /** Main-thread milliseconds per frame spent on GPU uploads (default 4); at least one upload step runs each frame. */
  frameBudget?: number;
}
export interface ProgressiveGLTF {
  /** The model, as soon as the JSON is parsed: one box per primitive (its POSITION bounds, material colours), bounds valid. */
  readonly ready: Promise<PBRModel>;
  /** The same model once every primitive, image and byte has arrived: its GPU data then equals `loadGLTF`'s. */
  readonly complete: Promise<PBRModel>;
  /** Stop loading and dispose the model; both promises reject (disposing the model does the same). */
  abort(reason?: unknown): void;
}

// Kept out of `new Worker(...)` so bundlers copy the prebuilt script as an asset instead of rebuilding it (as /worker).
const workerURL = () => new URL('./workers/progressive.js?no-inline', import.meta.url);
const CHUNK = 1 << 20,
  sourceKeys = ['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif'];
const revive = (e: { name: string; message: string }) =>
  new ((({ TypeError, RangeError, SyntaxError }) as Record<string, ErrorConstructor>)[e.name] ?? Error)(e.message);
// A primitive's stand-in until its data arrives: the box of its POSITION accessor's min/max, in gltf-pro's 80-byte layout.
function box(doc: GLTFDocument, p: any): { vertices: Float32Array; indices: Uint32Array; lo: number[]; hi: number[] } {
  const a = doc.accessors?.[p?.attributes?.POSITION],
    ok = (v: any) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  const scale = a?.normalized
    ? (({ 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 } as Record<number, number>)[a.componentType] ?? 1)
    : 1;
  const read = (v: any) => (ok(v) ? v.map((x: number) => (scale > 1 ? Math.max(-1, x / scale) : x)) : [0, 0, 0]),
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
  if (decoders.draco || decoders.meshopt || decoders.ktx2) {
    const model = loadGLTF(instance, url, {
      decoders,
      signal: controller.signal,
      maxDownloadBytes: options.maxDownloadBytes,
      maxNodes: options.maxNodes,
    }).then((m) => {
      emit('complete');
      return m;
    });
    model.catch(() => {});
    return { ready: model, complete: model, abort };
  }
  const engine = engineRuntime(instance),
    device = () => engine.gpu!;
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
    real: any[] = [],
    bare = new Set<number>(),
    keys: number[] = [],
    byKey: number[][] = [],
    local: number[][][] = [];
  const received = new Set<number>(),
    pending = new Set<GPUBuffer>(),
    jobs: Array<() => boolean> = [],
    hooks: any = {};
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
      const radius =
        (Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2) *
        Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10]));
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
    const out: any[] = [];
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
      resources = model!['resources'];
    list.forEach((i, j) => {
      resources[i].uniform.destroy();
      resources[i] = out[j];
    });
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
      const sources = real[i].maps.flatMap((map: any) => {
        const t = map && doc.textures?.[map.index];
        return t ? [t.source, ...sourceKeys.map((k) => t.extensions?.[k]?.source)].filter((s) => s !== undefined) : [];
      });
      if (all || sources.every((s: number) => settled[s])) {
        bare.delete(i);
        jobs.push(texture(i));
      }
    }
  };
  const geometry = (key: number, vertices: Float32Array, indices: Uint32Array) => {
    const uploads = [
      {
        data: vertices,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE,
        at: 0,
        buffer: undefined as GPUBuffer | undefined,
      },
      { data: indices, usage: GPUBufferUsage.INDEX, at: 0, buffer: undefined as GPUBuffer | undefined },
    ];
    geometryBytes += vertices.byteLength + indices.byteLength;
    if (geometryBytes > limit * 4) throw overBudget('Decoded glTF geometry exceeds byte budget', limit * 4);
    // Large buffers upload in 1 MB writes spread over frames; the primitive switches once both are complete.
    return () => {
      const u = uploads.find((u) => u.at < u.data.byteLength);
      if (u) {
        if (!u.buffer) {
          if (u.data.byteLength > device().limits.maxBufferSize)
            throw new RangeError('PBR buffer exceeds device limit');
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
      const cache = model!['gpuCache'] as Map<unknown, any>,
        old = new Set<object>();
      for (const { data, buffer } of uploads) {
        cache.set(data, buffer);
        pending.delete(buffer!);
      }
      for (const i of byKey[key]) {
        const p = model!.primitives[i];
        old.add(p.vertices);
        old.add(p.indices);
        p.vertices = vertices;
        p.indices = indices;
      }
      rebuild(byKey[key]);
      for (const data of old) {
        cache.get(data)?.destroy();
        cache.delete(data);
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
      const made = new Map<number, any>();
      for (const p of model!.primitives) {
        const ext = doc.nodes[p.nodeIndex]?.extensions?.EXT_mesh_gpu_instancing;
        if (ext) {
          if (!made.has(p.nodeIndex)) made.set(p.nodeIndex, decoders.instancing.read(asset, ext));
          p.instances = made.get(p.nodeIndex);
        }
      }
    }
    // Default 1x1 maps that only stood in for textures are freed, so the model holds what loadGLTF's holds.
    const cache = model!['gpuCache'] as Map<unknown, any>,
      textures: GPUTexture[] = model!['textures'];
    const used = new Set(
      model!.primitives.flatMap((p) => p.material.maps.map((m: unknown, i: number) => (m ? -1 : i))),
    );
    for (const [key, t] of cache)
      if (typeof key === 'string' && key.startsWith('default:') && !used.has(+key.slice(8))) {
        t.destroy();
        cache.delete(key);
        textures.splice(textures.indexOf(t), 1);
      }
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
    asset = new GLTFAsset(
      doc,
      (doc.buffers ?? []).map(
        (b: any) => new Uint8Array(Number.isSafeInteger(b?.byteLength) && b.byteLength > 0 ? b.byteLength : 0),
      ),
      undefined,
      hooks,
      limit,
      options.maxNodes,
    );
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
    const stripped = new Map<object, any>();
    real = model.primitives.map((p, i) => {
      const m = p.material;
      if (!m.maps.some(Boolean)) return m;
      if (!stripped.has(m)) stripped.set(m, { ...m, maps: m.maps.map(() => undefined) });
      p.material = stripped.get(m);
      bare.add(i);
      return m;
    });
    engine.use(model);
    model.onDispose(() => abort(new DOMException('Model disposed while loading', 'AbortError')));
    // The first order goes out on the next frame, after the app has had `ready` and placed its camera.
    emit('ready');
    resolveReady(model);
    schedule();
  };
  const message = (m: StreamMessage) => {
    if (finished) {
      if (m.type === 'image') m.image?.close?.();
      return;
    }
    try {
      if (m.type === 'doc') build(m.doc);
      else if (m.type === 'geometry') {
        if (m.error) throw revive(m.error);
        received.add(m.key);
        jobs.push(geometry(m.key, m.vertices!, m.indices!));
      } else if (m.type === 'image') {
        images[m.index] = m.image;
        settled[m.index] = true;
        if (m.image) progress.imagesLoaded++;
        texturesReady();
      } else if (m.type === 'bytes') {
        progress.bytesLoaded = m.loaded;
        progress.bytesTotal = m.total;
        if (model) emit();
      } else if (m.type === 'done') {
        texturesReady(true);
        jobs.push(finish(m.buffers, m.accessors));
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
      worker.onmessage = ({ data }) => message(data);
      worker.onerror = (event) => {
        event.preventDefault?.();
        fail(new Error('Progressive glTF worker failed: ' + (event.message || 'unknown error')));
      };
      worker.postMessage({ url: href, maxDownloadBytes: limit, maxNodes: options.maxNodes });
    } else
      import('./stream.js').then(({ GLTFStream }) => {
        if (!finished)
          (stream = new GLTFStream(new URL(href), message, controller.signal, limit, options.maxNodes)).run();
      }, fail);
  } catch (error) {
    fail(error);
  }
  return { ready, complete, abort };
}
