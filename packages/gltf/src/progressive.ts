import type { PBRInstances } from './pbr-instancing.js';
import type { GLTFPrimitive } from '../../shared/gltf.js';
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { canUseWorker } from '../../shared/worker.js';
import { margoError } from '../../shared/errors.js';
import { Cleanup } from '../../shared/cleanup.js';
import { captureScene } from '../../shared/scene-scope.js';
import { worldRadius } from '../../shared/sphere.js';
import {
  GLTFAsset,
  adaptDraco,
  assetLimit,
  downloadLimit,
  overBudget,
  type GLTFDocument,
  type GLTFImage,
  type GLTFDecoderHooks,
  type GLTFDracoDecodeOptions,
} from './asset.js';
import { withDecoders } from './decoder-default.js';
import { withMaterials } from './default-materials.js';
import { decoded } from './draco-state.js';
import { levelOrder } from './progressive-lod.js';
import { PBRModel, loadGLTF, type GLTFLoadOptions, type PBRMaterial, type PBRPrimitive } from './pbr.js';
import type { PrimitivePart } from './model.js';
import { partLimit } from './parts.js';
import { packed, primitiveDefs } from './pack.js';
import type { GLTFStream, StreamMessage } from './stream.js';
import type { GLTFTextureStream, GLTFTextureStreamOptions } from './texture-stream.js';
export type { GLTFTextureStream, GLTFTextureStreamOptions } from './texture-stream.js';
declare const GPUBufferUsage: { STORAGE: number; VERTEX: number; INDEX: number; COPY_DST: number };
// Same symbol PBRModel reads. Set until finish(), so setup does not bake the placeholder boxes.
const deferStaticBatches = Symbol.for('margoengine.gltf/pbr.defer-static-batches');
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
   * Upload steps per frame, a work count that replaces `frameBudget`: the same steps run on every pump on any machine,
   * so the intermediate model of a film frame is the same on every run (`await load.complete` for the finished model,
   * which is the same whatever the budget). 1 or more, Infinity for every waiting step. Default unset.
   */
  maxJobs?: number;
  /** Clock in milliseconds for `frameBudget` and the view re-sort. Default `performance.now`; pass a simulation clock for replay. */
  clock?: () => number;
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
// A primitive's stand-in until its data arrives: the box of its POSITION accessor's min/max, in gltf/pbr's 80-byte layout.
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
 * worker (dist/workers/progressive.js; on this thread where Worker is unavailable, or for your own `decoders.meshopt`);
 * GPU uploads run here within `frameBudget` ms per animation frame. Draco primitives decode one by one as their bytes
 * arrive and meshopt views as they are read. An `MSFT_lod` object streams its coarsest level first and shows the finest
 * level that has arrived; `LOD.fromModel` called at `ready` takes over and picks only levels that have arrived. A custom
 * `fetch` or a `ktx2` decoder falls back to `loadGLTF` (ready = complete).
 */
export function loadGLTFProgressive(
  instance: EngineKernel,
  url: string | URL,
  options: ProgressiveGLTFOptions = {},
): ProgressiveGLTF {
  const { decoders = {}, signal, onProgress, frameBudget = 4, maxJobs, clock = () => performance.now() } = options,
    controller = new AbortController();
  if (maxJobs !== undefined && !(maxJobs >= 1)) throw new RangeError('Invalid maxJobs; pass a count, 1 or more');
  if (typeof clock !== 'function') throw new TypeError('Invalid clock; pass a function returning milliseconds');
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
  // The model and its texture stream are made after awaits and worker messages: they go in the scene this call came from.
  const scope = captureScene(instance),
    engine = engineRuntime(instance),
    device = () => engine.gpu!,
    settings = options.textures === true ? {} : options.textures,
    textures =
      settings && engine.gpu
        ? import('./texture-stream.js').then(({ GLTFTextureStream }) =>
            scope.run(() => GLTFTextureStream.attach(instance, settings, controller.signal)),
          )
        : undefined;
  textures?.catch(() => {});
  // The whole-file loader, its KTX2 images still streaming when `textures` is on.
  const plain = async () => {
    const stream = await textures,
      loaded = await scope.run(() =>
        loadGLTF(instance, url, {
          ...options,
          decoders: stream ? { ...decoders, textureStream: stream } : decoders,
          signal: controller.signal,
        }),
      );
    stream?.attach(loaded);
    return loaded;
  };
  if (options.fetch || options.ktx2 || decoders.ktx2) {
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
  // Per primitive: its real material while textures load, and its key (glTF primitive). byKey: each key's newest part
  // on each node (its placeholder until the geometry arrives); later parts go in right after it.
  let images: GLTFImage[] = [],
    settled: boolean[] = [],
    bare = new Set<PBRPrimitive>(),
    byKey: PBRPrimitive[][] = [],
    local: number[][][] = [];
  const real = new Map<PBRPrimitive, PBRMaterial>(),
    keys = new Map<PBRPrimitive, number>();
  const received = new Set<number>(),
    pending = new Set<GPUBuffer>(),
    opening: Promise<void>[] = [],
    jobs: Array<() => boolean> = [],
    hooks: GLTFDecoderHooks = {};
  let geometryBytes = 0,
    lastView = '',
    lastSent = -Infinity,
    scheduled = false,
    limit = assetLimit,
    partVertices = 0,
    // Geometry messages not yet on the GPU, and the last step (set once 'done' came and its streams opened), which waits
    // for them: a later part adds a primitive that may still need its textures.
    uploading = 0,
    last: (() => void) | undefined;
  const settle = () => {
    if (!last || uploading) return;
    const run = last;
    last = undefined;
    run();
  };

  // Draco: your decoder, else one this load owns, made for the first compressed primitive and disposed at the end.
  let dracoReady: Promise<NonNullable<GLTFDecoderHooks['draco']>> | undefined, owned: { dispose(): void } | undefined;
  const draco = {
    decode: async (data: Uint8Array, wanted: GLTFDracoDecodeOptions) => {
      dracoReady ??= (async () => {
        const custom = options.draco ?? decoders.draco;
        if (custom) return adaptDraco(custom);
        const { DracoDecoder } = await withDecoders({ decoders }).decoders.decoderModule!();
        controller.signal.throwIfAborted();
        return (owned = new DracoDecoder()) as unknown as NonNullable<GLTFDecoderHooks['draco']>;
      })();
      return (await dracoReady).decode(data, { ...wanted, signal: controller.signal });
    },
  };
  const release = () =>
    void dracoReady?.then(
      () => owned?.dispose(),
      () => {},
    );
  // MSFT_lod: which level of each object shows while it loads, and which primitives come first.
  let levels: ReturnType<typeof levelOrder> | undefined;

  const fail = (error: unknown) => {
    if (finished) return;
    finished = true;
    worker?.terminate();
    release();
    levels?.release();
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
    model!.primitives.forEach((p) => {
      const key = keys.get(p)!,
        [lo, hi] = local[key],
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
      score[key] = Math.max(score[key], visible + size / (1 + size));
    });
    // Level tiers outrank view order: everything's coarsest level, then the levels this view calls for, then the rest.
    levels!.rank(score);
    return byKey
      .map((_, k) => k)
      .filter((k) => byKey[k].length && !received.has(k))
      .sort((a, b) => score[b] - score[a]);
  };
  // Re-run gltf/pbr's own setup for some primitives (sharing the model's GPU cache) and swap their draw resources in place.
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
  const rebuild = (list: PBRPrimitive[]) => {
    const out = setup(list),
      resources = model!['resources'],
      cleanup = new Cleanup();
    list.forEach((p, j) => {
      const i = model!.primitives.indexOf(p),
        previous = resources[i];
      cleanup.run(() => previous.uniform.destroy()).run(() => previous.wireframe?.index.destroy());
      resources[i] = out[j];
    });
    cleanup.finish();
  };
  // One texture (upload + mips) per step: a throwaway setup with only map k fills the cache; the last step swaps the material.
  const texture = (p: PBRPrimitive) => {
    const material = real.get(p)!,
      maps = material.maps;
    let k = 0;
    return () => {
      while (k < maps.length && !maps[k]) k++;
      if (k < maps.length) {
        const only = k++;
        setup([
          {
            ...p,
            material: { ...material, maps: maps.map((m: unknown, j: number) => (j === only ? m : undefined)) },
          },
        ])[0].uniform.destroy();
        return false;
      }
      p.material = material;
      rebuild([p]);
      emit('textures');
      return true;
    };
  };
  // Primitives whose every candidate image (fallback and extension sources) has settled can take their real material.
  const texturesReady = (all = false) => {
    for (const p of bare) {
      const sources = real.get(p)!.maps.flatMap((map) => {
        const t = map && doc.textures?.[map.index];
        return t
          ? ([t.source, ...sourceKeys.map((k) => t.extensions?.[k]?.source)].filter(Number.isSafeInteger) as number[])
          : [];
      });
      if (all || sources.every((s: number) => settled[s])) {
        bare.delete(p);
        jobs.push(texture(p));
      }
    }
  };
  const geometry = (
    key: number,
    vertices: Float32Array,
    indices: Uint32Array,
    uvs?: Float32Array,
    part?: PrimitivePart,
  ) => {
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
      if (part?.index) {
        // A later part: a new primitive right after the key's newest part on each node, fields in plain-load order.
        byKey[key] = byKey[key].map((after) => {
          const made: PBRPrimitive = {
            node: after.node,
            nodeIndex: after.nodeIndex,
            vertices,
            indices,
            definition: after.definition,
            material: after.material,
            weights: Float32Array.from(after.weights),
            targetNames: after.targetNames,
            ...(uvs ? { uvs } : {}),
            part,
          };
          keys.set(made, key);
          real.set(made, real.get(after)!);
          // Still on its stand-in material (textures not swapped in yet): the part gets its own texture swap.
          if (made.material !== real.get(made)) bare.add(made);
          model!['insertPart'](after, made, setup([made])[0]);
          return made;
        });
        texturesReady();
      } else {
        for (const p of byKey[key]) {
          old.add(p.vertices);
          old.add(p.indices);
          p.vertices = vertices;
          p.indices = indices;
          if (uvs) p.uvs = uvs;
          if (part) p.part = part;
        }
        rebuild(byKey[key]);
        // Through the model, which counts buffers other models may share (PBRModel dropBuffer).
        for (const data of old) {
          const buffer = cache.get(data) as GPUBuffer | undefined;
          if (buffer) model!['dropBuffer'](device(), buffer);
        }
      }
      // A split primitive counts as loaded with its last part.
      if (!part || part.index === part.count - 1) {
        progress.primitivesLoaded++;
        levels!.arrived(key);
      }
      uploading--;
      emit('geometry');
      settle();
      return true;
    };
  };
  const finish = (m: Extract<StreamMessage, { type: 'done' }>) => () => {
    m.buffers.forEach((b, i) => {
      (asset.buffers as Uint8Array[])[i] = b;
    });
    for (const [id, data] of m.accessors) asset['cache'].set(id, data);
    if (m.draco) {
      const defs = primitiveDefs(doc);
      decoded.set(asset, new Map(m.draco.map(([key, indices]) => [defs[key] as object, indices])));
    }
    // Every level is whole: level 0 shows, as a plain load has it, unless an LOD system took the object over.
    levels!.release();
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
    release();
    emit('complete');
    resolveComplete(model!);
    return true;
  };
  const pump = () => {
    scheduled = false;
    if (finished) return;
    try {
      const start = clock(),
        camera = engine.camera,
        view = String(camera.position) + camera.target;
      if (model && view !== lastView && start - lastSent > 200) {
        lastView = view;
        lastSent = start;
        send(order());
      }
      let steps = 0;
      do {
        if (jobs.length && jobs[0]()) jobs.shift();
        steps++;
      } while (jobs.length && !finished && (maxJobs === undefined ? clock() - start < frameBudget : steps < maxJobs));
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
  const build = (d: GLTFDocument, materials?: GLTFDecoderHooks['materials']) => {
    doc = d;
    const defs = primitiveDefs(doc),
      keyOf = new Map(defs.map((p, k) => [p, k]));
    // Placeholder geometry through the worker path's packed-geometry map; the buffers fill in when the stream completes.
    defs.forEach((p, k) => {
      const b = box(doc, p);
      local[k] = [b.lo, b.hi];
      if (p && typeof p === 'object') packed.set(p, [b]);
    });
    if (decoders.instancing) hooks.instancing = { read: () => undefined };
    if (materials) hooks.materials = materials;
    if (decoders.meshopt) hooks.meshopt = decoders.meshopt;
    // Placeholder buffers at their declared sizes: checked against the budget before they are allocated. A meshopt
    // fallback buffer is never read, so it gets none.
    const sizes = (doc.buffers ?? []).map((b) => {
      const extensions = b?.extensions as Record<string, { fallback?: boolean } | undefined> | undefined;
      return (extensions?.EXT_meshopt_compression ?? extensions?.KHR_meshopt_compression)?.fallback !== true &&
        Number.isSafeInteger(b?.byteLength) &&
        b.byteLength > 0
        ? b.byteLength
        : 0;
    });
    if (sizes.reduce((sum, n) => sum + n, 0) > limit) throw overBudget('glTF buffers exceed byte budget', limit);
    asset = new GLTFAsset(
      doc,
      sizes.map((n) => new Uint8Array(n)),
      undefined,
      hooks,
      limit,
      options.maxNodes,
    );
    asset.partVertices = partVertices;
    // Later reads of meshopt views (the model's own, an exporter's) need the decoder on this thread too.
    opening.push(asset.prepareMeshopt().catch(fail));
    (asset as GLTFAsset & { [deferStaticBatches]?: StaticBatchDeferral })[deferStaticBatches] = {};
    images = Array.from(doc.images ?? [], () => undefined);
    settled = images.map(() => false);
    progress.images = images.length;
    model = new PBRModel(instance, asset, images);
    byKey = defs.map(() => []);
    for (const p of model.primitives) {
      const k = keyOf.get(p.definition)!;
      byKey[k].push(p);
      keys.set(p, k);
    }
    progress.primitives = byKey.filter((list) => list.length).length;
    // Until its images arrive a primitive draws with its material's factors only.
    const stripped = new Map<object, PBRMaterial>();
    for (const p of model.primitives) {
      const m = p.material;
      real.set(p, m);
      if (!m.maps.some(Boolean)) continue;
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
      bare.add(p);
    }
    engine.use(model);
    levels = levelOrder(model, engine);
    model.onDispose(() => abort(new DOMException('Model disposed while loading', 'AbortError')));
    void textures?.then((stream) => stream.attach(model!), fail);
    // The first order goes out on the next frame, after the app has had `ready` and placed its camera.
    emit('ready');
    resolveReady(model);
    schedule();
  };
  // Messages that arrive while the document's own readers load (its material shaders) wait, in order.
  let held: StreamMessage[] | undefined;
  const message = (m: StreamMessage) => {
    if (held) {
      held.push(m);
      return;
    }
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
      } else if (m.type === 'doc') {
        held = [];
        // As loadGLTF: a file with physical or specular-glossiness materials draws them with no option passed.
        void withMaterials(m.doc, decoders)
          .then((found) => {
            if (!finished) scope.run(() => build(m.doc, found.materials));
          })
          .catch(fail)
          .then(() => {
            const waiting = held!;
            held = undefined;
            waiting.forEach(message);
          });
      } else if (m.type === 'geometry') {
        if (m.error) throw revive(m.error);
        received.add(m.key);
        jobs.push(geometry(m.key, m.vertices!, m.indices!, m.uvs, m.part));
        uploading++;
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
      } else if (m.type === 'draco') {
        const { id } = m,
          to = worker;
        draco.decode(m.data, m.options).then(
          (result) => {
            try {
              to?.postMessage({ draco: id, result });
            } catch (error) {
              fail(error);
            }
          },
          (e: { name?: string; message?: string; code?: string }) =>
            to?.postMessage({ draco: id, error: { name: e?.name, message: e?.message, code: e?.code } }),
        );
      } else if (m.type === 'done') {
        // Streams still opening hold their primitives back until their smallest levels are on the GPU.
        void Promise.all(opening).then(() => {
          if (finished) return;
          last = () => {
            texturesReady(true);
            jobs.push(finish(m));
          };
          settle();
        });
      } else throw revive(m.error);
    } catch (error) {
      fail(error);
    }
  };
  try {
    signal?.throwIfAborted();
    limit = downloadLimit(options.maxDownloadBytes);
    partVertices = partLimit(options.maxPartVertices);
    const href = new URL(url, globalThis.location?.href).href;
    // Your own meshopt decoder cannot cross to a worker, so its stream runs on this thread.
    if (canUseWorker() && !decoders.meshopt) {
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
        maxPartVertices: partVertices,
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
            partVertices,
            { draco, ...(decoders.meshopt ? { meshopt: decoders.meshopt } : {}) },
          )).run();
      }, fail);
  } catch (error) {
    fail(error);
  }
  return { ready, complete, abort, ...(textures ? { textures } : {}) };
}
