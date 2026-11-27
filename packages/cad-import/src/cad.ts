/// <reference lib="esnext.disposable" preserve="true" />
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import {
  Geometry,
  PbrMaterial,
  type Engine,
  type Mesh,
  type EnginePlugin,
  type FrameGraph,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { readResponse } from '../../shared/loading.js';
import { captureScene } from '../../shared/scene-scope.js';
import { requireWebGPU } from '../../shared/require-webgpu.js';
import { meshTriangles, mergePrimitives } from '../../shared/mesh-source.js';
import type { PBRSourcePrimitive } from '../../shared/pbr-source.js';
import type { MeshSourceOwner } from '../../shared/mesh-source.js';
import { maxBytes, maxIndices, parseCADGeometry, fingerprint, hash } from './cad-parser.js';
import { parseCADAsync, type CADFormat, type CADImportOptions } from './cad-async.js';
import { cadFormatOf } from './internal/format.js';
import { PartPacks, type PackShadowPrimitive } from './pack.js';
export type { PackShadowPrimitive } from './pack.js';
/** A loaded CAD file: one `root` mesh over one child mesh per part. `dispose()` removes all of them (also via `using`). */
export interface CADModel {
  /** Parent of every part; hidden until the whole file has loaded. */
  root: MeshHandle;
  /** One mesh per part, in file order. */
  meshes: readonly MeshHandle[];
  /** Disposes the root and every part. */
  dispose(): void;
  /**
   * B-rep formats read by the bundled kernel worker: faces the kernel could not mesh, each left out of its part (0 when
   * every face meshed). Not set for STL and OBJ, nor by a custom `importer` unless it sets it.
   */
  failedFaces?: number;
  /**
   * B-rep formats read by the bundled kernel worker: what the reader left out or assumed (an entity it skipped, a
   * conversion it could not make). Not set for STL and OBJ, nor by a custom `importer` unless it sets it.
   */
  warnings?: readonly string[];
}
/**
 * Makes meshes with identical triangles share one geometry, so they upload and draw from one buffer pair. Returns how many
 * parts it saw and how many were unique. Meshes without geometry are skipped; an input with none at all throws.
 *
 * @example
 * ```ts
 * const { parts, unique } = deduplicateParts(model.meshes);
 * ```
 */
export function deduplicateParts(meshes: Iterable<MeshHandle>): { parts: number; unique: number } {
  const seen = new Map<string, Array<{ data: Float32Array; geometry: Geometry }>>(),
    known = new Map<Geometry, Geometry>(),
    pbrSeen = new Map<string, Float32Array[]>(),
    pairs = new Map<object, Map<string, PBRSourcePrimitive[]>>(),
    deformableSeen = new Set<Mesh>(),
    // Only parts with equal triangle counts can match, so a part fingerprints (a sort of its triangles plus a CRC) only
    // once a second part with its count arrives: `lone` holds the first of each count, unfingerprinted. One 200k-triangle
    // STL spent 40 of its 110 ms fingerprinting itself against nothing.
    lone = new Map<number, Geometry>(),
    fingerprinted = new Set<number>();
  const enter = (geometry: Geometry): Geometry | undefined => {
    const data = fingerprint(geometry),
      key = `${data.length}:${hash(data)}`,
      bucket = seen.get(key) ?? [],
      match = bucket.find((entry) => entry.data.length === data.length && entry.data.every((v, i) => v === data[i]));
    if (!match) {
      bucket.push({ data, geometry });
      seen.set(key, bucket);
    }
    return match?.geometry;
  };
  let parts = 0,
    unique = 0;
  for (const handle of meshes) {
    const mesh = meshRuntime(handle);
    mesh.check();
    const triangles = meshTriangles(mesh);
    if (!triangles) continue;
    if (triangles.kind === 'pbr') {
      const { source } = triangles,
        { primitives } = source;
      // Loader roots, transforms and joints legitimately have no triangles of their own.
      if (!primitives.length) continue;
      parts++;
      const data = primitiveFingerprint(primitives);
      // Deformable parts cannot safely share buffers or be treated as interchangeable rigs.
      if (source.skinned || source.morphed) {
        if (!deformableSeen.has(mesh)) {
          deformableSeen.add(mesh);
          unique++;
        }
        continue;
      }
      shareBuffers(source.model, primitives, pairs);
      const key = `${data.length}:${hash(data)}`,
        bucket = pbrSeen.get(key) ?? [];
      if (!bucket.some((entry) => entry.length === data.length && entry.every((value, i) => value === data[i]))) {
        bucket.push(data);
        pbrSeen.set(key, bucket);
        unique++;
      }
      continue;
    }
    parts++;
    const { geometry } = triangles;
    let canonical = known.get(geometry);
    if (!canonical) {
      const count = geometry.indices.length,
        first = lone.get(count);
      if (!first && !fingerprinted.has(count)) {
        lone.set(count, geometry);
        canonical = geometry;
        unique++;
      } else {
        if (first) {
          lone.delete(count);
          fingerprinted.add(count);
          enter(first); // the first of its count: unique, already counted
        }
        const match = enter(geometry);
        canonical = match ?? geometry;
        if (!match) unique++;
      }
      known.set(geometry, canonical);
    }
    if (geometry !== canonical) mesh.setGeometry(canonical);
  }
  if (!parts)
    throw new TypeError('CAD grouping found no supported geometry; pass meshes that have geometry or PBR primitives.');
  return { parts, unique };
}

/**
 * Points every static triangle primitive at the GPU buffer pair of the first primitive of the same glTF PBR model with
 * equal vertices and indices (the model's `shareBuffers`). Skinned and morphed primitives keep their own pair.
 */
function shareBuffers(
  model: MeshSourceOwner,
  primitives: readonly PBRSourcePrimitive[],
  pairs: Map<object, Map<string, PBRSourcePrimitive[]>>,
): void {
  if (typeof model.shareBuffers !== 'function') return;
  let byKey = pairs.get(model);
  if (!byKey) pairs.set(model, (byKey = new Map()));
  for (const p of primitives) {
    if (p.deformed || p.definition.targets?.length || p.definition.attributes?.JOINTS_0 !== undefined) continue;
    const v = p.vertices,
      i = p.indices,
      key = `${v.length}:${i.length}:${hash(v)}:${hash(new Float32Array(i.buffer, i.byteOffset, i.length))}`,
      bucket = byKey.get(key) ?? [],
      match = bucket.find(
        (q) => q.vertices.every((value, k) => value === v[k]) && q.indices.every((value, k) => value === i[k]),
      );
    if (match) model.shareBuffers(p, match);
    else {
      bucket.push(p);
      byKey.set(key, bucket);
    }
  }
}
/** Compare all bind-pose triangles and normals without modifying PBR attributes or GPU buffers. */
function primitiveFingerprint(primitives: readonly PBRSourcePrimitive[]): Float32Array {
  const { vertices, indices } = mergePrimitives(primitives, true, (vertexCount, indexCount) => {
    if (!vertexCount || !indexCount || indexCount % 3) throw new RangeError('PBR geometry needs whole triangles');
    if (indexCount > maxIndices)
      throw new RangeError(
        `Deduplication supports at most ${maxIndices / 3} triangles per part; split the part or skip deduplication.`,
      );
  });
  return fingerprint({ vertices, indices });
}
/**
 * Reads STL or OBJ text or bytes into meshes under one root, synchronously. Units stay as in the file. For the B-rep
 * formats (STEP, IGES, SAT, XT, JT), or to keep the main thread free, use {@link loadCAD} or `parseCADAsync`.
 *
 * @example
 * ```ts
 * const model = parseCAD(engine, await (await fetch('/part.stl')).arrayBuffer(), 'stl');
 * ```
 */
export function parseCAD(
  instance: EngineKernel,
  input: string | ArrayBuffer | ArrayBufferView,
  format: 'stl' | 'obj',
  { maxParts }: Pick<CADImportOptions, 'maxParts'> = {},
): CADModel {
  const engine = engineRuntime(instance);
  const definitions = parseCADGeometry(
    input,
    format,
    (positions, normals, indices) => new Geometry(positions, normals, indices),
    undefined,
    maxParts,
  );
  const created: Mesh[] = [];
  try {
    const root = engine.createMesh();
    created.push(root);
    const meshes = definitions.map((part) => {
      const mesh = engine.createMesh(root);
      created.push(mesh);
      mesh.name = part.name;
      return mesh
        .setGeometry(part.geometry)
        .setMaterial(new PbrMaterial({ color: '#a6b9c8', roughness: 0.4, metalness: 0.3 }));
    });
    deduplicateParts(meshes);
    return {
      root,
      meshes,
      dispose() {
        for (let i = created.length - 1; i >= 0; i--) created[i].dispose();
      },
    };
  } catch (error) {
    for (let i = created.length - 1; i >= 0; i--) created[i].dispose();
    throw error;
  }
}
/**
 * Downloads a CAD file and imports it: STL, OBJ, STEP, IGES, SAT, XT or JT, chosen by the `format` option or the file
 * extension (.stp, .igs, .x_t, .x_b and .xmt_txt too). Pass `signal` to cancel the download and the import. The B-rep
 * formats run in a worker (meters); see {@link CADImportOptions} for every option and its default.
 *
 * @example
 * ```ts
 * const model = await loadCAD(engine, '/part.step', { signal: AbortSignal.timeout(30_000) });
 * ```
 */
export async function loadCAD(
  engine: EngineKernel,
  url: string | URL,
  {
    format,
    signal,
    fetch: get = globalThis.fetch,
    ...options
  }: CADImportOptions & { format?: CADFormat; fetch?: typeof fetch } = {},
): Promise<CADModel> {
  const target = new URL(url, globalThis.location?.href);
  if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('CAD URL must use HTTP(S)');
  signal?.throwIfAborted();
  // The model is built after the download, with any scene active: it belongs to the scene this call was made in.
  const scope = captureScene(engineRuntime(engine));
  const data = await readResponse(await get(target, { signal }), { maxBytes, signal, label: 'CAD download' }),
    kind = cadFormatOf(target.pathname, format);
  if (!kind)
    throw new TypeError(
      'Cannot tell the CAD format from the URL; pass the format option: stl, obj, step, iges, sat, xt or jt.',
    );
  signal?.throwIfAborted();
  const brep = kind !== 'stl' && kind !== 'obj';
  if (typeof Worker === 'undefined' && !(brep && options.importer)) {
    if (brep)
      throw new MargoError(
        'unsupported',
        'B-rep import (STEP, IGES, SAT, XT, JT) requires Web Workers; pass an importer option to read them without one.',
      );
    return scope.run(() => parseCAD(engine, data, kind, options));
  }
  const buffer =
    data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data.buffer
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return scope.run(() => parseCADAsync(engine, buffer as ArrayBuffer, kind, { signal, ...options }));
}
/** Options for {@link PartInstancer}. */
export interface PartInstancerOptions {
  /** Draw small static closed parts that share a material and root from shared GPU buffers (WebGPU). Default true. */
  pack?: boolean;
  /** Parts with more vertices than this keep their own draw. Default 4,096. */
  partVertices?: number;
  /** Most vertices in one pack buffer. Default 262,144 (at least `partVertices`). */
  packVertices?: number;
}
/**
 * Deduplicates identical parts on attach, then packs small static parts into shared buffers. Packed parts stay
 * ordinary visible meshes (names, picks, sections and exports address them); core skips their claimed batches and the
 * plugin draws each pack once inside every core draw, with that draw's pipeline and bindings. A part returns to its own
 * draw when it moves, hides, changes material or geometry, or another visible mesh shares its geometry. Parts loaded
 * after attaching are packed by {@link PartInstancer.refresh}. For directional shadows, pass the plugin to
 * `shadows.add` (it is a ShadowSource for its packs) instead of each packed part.
 */
export class PartInstancer implements EnginePlugin {
  /** Same as `engine.use(new PartInstancer(options))`; returns the plugin. */
  static attach(instance: EngineKernel, options: PartInstancerOptions = {}): PartInstancer {
    const plugin = new PartInstancer(options);
    engineRuntime(instance).use(plugin);
    return plugin;
  }
  readonly name = 'part-instancer';
  /** `parts`/`unique` from deduplication on attach; `packs` buffers and `packed` parts drawn from them now. */
  readonly stats: { parts: number; unique: number; packs: number; packed: number };
  /** Pack while true; false hands every part back to its own draw on the next frame. */
  pack: boolean;
  private readonly packs: PartPacks;
  private removed = false;
  private engine?: Engine;
  constructor(options: PartInstancerOptions = {}) {
    const partVertices = options.partVertices ?? 4096,
      packVertices = options.packVertices ?? Math.max(262_144, partVertices);
    if (!Number.isSafeInteger(partVertices) || partVertices < 3)
      throw new RangeError('partVertices must be an integer of at least 3');
    if (!Number.isSafeInteger(packVertices) || packVertices < partVertices)
      throw new RangeError('packVertices must be an integer no smaller than partVertices');
    if (options.pack !== undefined && typeof options.pack !== 'boolean') throw new TypeError('pack must be a boolean');
    this.pack = options.pack ?? true;
    this.packs = new PartPacks(partVertices, packVertices);
    this.stats = Object.assign(this.packs.stats, { parts: 0, unique: 0 });
  }
  /** Pack buffers as directional shadow casters, clipped by sections like core casters. */
  get shadowPrimitives(): readonly PackShadowPrimitive[] {
    return this.packs.shadowPrimitives;
  }
  /** True once the plugin is removed or disposed. */
  get disposed(): boolean {
    return this.removed;
  }
  setup(engine: Engine): void {
    this.engine = engine;
    // The packs draw through WebGPU indirect batches only: refuse the WebGL2 preview instead of drawing nothing.
    requireWebGPU(engine, 'PartInstancer');
    Object.assign(this.stats, deduplicateParts(engine.meshes.values()));
    this.packs.setup(engine);
  }
  /** Unpacks every part and packs the engine's current meshes again on the next frame. */
  refresh(): void {
    this.packs.refresh();
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'parts:indirect',
      order: -45,
      execute: (context) => {
        if (context.backend === 'webgpu') context.indirect = true;
      },
    });
    // Lowest order, so the pack draw wraps core's draw directly and sees every caller's final options.
    graph.add({
      name: 'parts:pack',
      order: -1000,
      execute: (context) => {
        if (context.backend === 'webgpu') this.packs.execute(context, this.pack);
      },
    });
  }
  onDeviceRestored(): void {
    this.packs.onDeviceRestored();
  }
  /** Hands every part back to its own draw, frees the pack buffers and leaves the plugin's scene. Safe to call twice. */
  dispose(): void {
    if (this.removed) return;
    this.removed = true;
    this.packs.dispose();
    this.engine?.sceneOf(this)?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
