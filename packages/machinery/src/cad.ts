/// <reference lib="esnext.disposable" preserve="true" />
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import {
  type Geometry,
  PbrMaterial,
  type Engine,
  type Mesh,
  type EnginePlugin,
  type FrameGraph,
} from '@margoengine/core/extension';
import { readResponse } from '../../shared/loading.js';
import { meshTriangles } from '../../shared/mesh-source.js';
import type { PBRSourcePrimitive } from '../../shared/pbr-source.js';
import type { MeshSourceOwner } from '../../shared/mesh-source.js';
import { maxBytes, maxIndices, parseCADGeometry, fingerprint, hash } from './cad-parser.js';
import { parseCADAsync, type CADFormat, type CADImportOptions } from './cad-async.js';
import { PartPacks, type PackShadowPrimitive } from './pack.js';
export type { PackShadowPrimitive } from './pack.js';
export interface CADModel {
  root: MeshHandle;
  meshes: readonly MeshHandle[];
  dispose(): void;
}
export function deduplicateParts(meshes: Iterable<MeshHandle>): { parts: number; unique: number } {
  const seen = new Map<string, Array<{ data: Float32Array; geometry: Geometry }>>(),
    known = new Map<Geometry, Geometry>(),
    pbrSeen = new Map<string, Float32Array[]>(),
    pairs = new Map<object, Map<string, PBRSourcePrimitive[]>>(),
    deformableSeen = new Set<Mesh>();
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
      const data = fingerprint(geometry),
        key = `${data.length}:${hash(data)}`,
        bucket = seen.get(key) ?? [],
        match = bucket.find((entry) => entry.data.length === data.length && entry.data.every((v, i) => v === data[i]));
      canonical = match?.geometry ?? geometry;
      if (!match) {
        bucket.push({ data, geometry: canonical });
        seen.set(key, bucket);
        unique++;
      }
      known.set(geometry, canonical);
    }
    if (geometry !== canonical) mesh.setGeometry(canonical);
  }
  if (!parts) throw new TypeError('CAD grouping contains no supported geometry');
  return { parts, unique };
}

/**
 * Points every static triangle primitive at the GPU buffer pair of the first primitive of the same glTF-pro model with
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
  let vertexCount = 0,
    indexCount = 0;
  for (const primitive of primitives) {
    if (primitive.vertices.length % 20) throw new RangeError('PBR vertex array length is not a multiple of its stride');
    vertexCount += primitive.vertices.length / 20;
    indexCount += primitive.indices.length;
  }
  if (!vertexCount || !indexCount || indexCount % 3) throw new RangeError('PBR geometry needs whole triangles');
  if (indexCount > maxIndices) throw new RangeError('Deduplication triangle limit');
  const vertices = new Float32Array(vertexCount * 6),
    indices = new Uint32Array(indexCount);
  let vertexOffset = 0,
    indexOffset = 0;
  for (const primitive of primitives) {
    const count = primitive.vertices.length / 20;
    for (let i = 0; i < count; i++) {
      vertices.set(primitive.vertices.subarray(i * 20, i * 20 + 3), (vertexOffset + i) * 6);
      vertices.set(primitive.vertices.subarray(i * 20 + 4, i * 20 + 7), (vertexOffset + i) * 6 + 3);
    }
    for (const index of primitive.indices) indices[indexOffset++] = vertexOffset + index;
    vertexOffset += count;
  }
  return fingerprint({ vertices, indices });
}
export function parseCAD(
  instance: EngineKernel,
  input: string | ArrayBuffer | ArrayBufferView,
  format: 'stl' | 'obj',
  { maxParts }: Pick<CADImportOptions, 'maxParts'> = {},
): CADModel {
  const engine = engineRuntime(instance);
  const definitions = parseCADGeometry(input, format, undefined, maxParts);
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
  const data = await readResponse(await get(target, { signal }), { maxBytes, signal, label: 'CAD download' }),
    extension = target.pathname.toLowerCase().split('.').at(-1),
    kind = format ?? (extension === 'stp' ? 'step' : extension === 'igs' ? 'iges' : extension);
  if (kind !== 'stl' && kind !== 'obj' && kind !== 'step' && kind !== 'iges')
    throw new TypeError('Specify STL, OBJ, STEP or IGES format');
  signal?.throwIfAborted();
  if (typeof Worker === 'undefined') {
    if (kind === 'step' || kind === 'iges') throw new Error('B-Rep import requires Web Workers');
    return parseCAD(engine, data, kind, options);
  }
  const buffer =
    data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data.buffer
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return parseCADAsync(engine, buffer as ArrayBuffer, kind, { signal, ...options });
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
  dispose(): void {
    this.removed = true;
    this.packs.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
