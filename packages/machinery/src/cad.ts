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
import { maxBytes, maxIndices, parseCADGeometry, fingerprint, hash } from './cad-parser.js';
import { parseCADAsync, type CADFormat, type CADImportOptions } from './cad-async.js';
export interface CADModel {
  root: MeshHandle;
  meshes: readonly MeshHandle[];
  dispose(): void;
}
export function deduplicateParts(meshes: Iterable<MeshHandle>): { parts: number; unique: number } {
  const seen = new Map<string, Array<{ data: Float32Array; geometry: Geometry }>>(),
    known = new Map<Geometry, Geometry>(),
    pbrSeen = new Map<string, Float32Array[]>(),
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
export class PartInstancer implements EnginePlugin {
  static attach(instance: EngineKernel): PartInstancer {
    const plugin = new PartInstancer();
    engineRuntime(instance).use(plugin);
    return plugin;
  }
  readonly name = 'part-instancer';
  readonly stats = { parts: 0, unique: 0 };
  setup(engine: Engine): void {
    Object.assign(this.stats, deduplicateParts(engine.meshes.values()));
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'parts:indirect',
      order: -45,
      execute: (context) => {
        if (context.backend === 'webgpu') context.indirect = true;
      },
    });
  }
}
