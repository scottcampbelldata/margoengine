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
import { readResponse } from '../../shared/loading.js';
import { maxBytes, parseCADGeometry, fingerprint, hash } from './cad-parser.js';
import { parseCADAsync, type CADFormat, type CADImportOptions } from './cad-async.js';
export interface CADModel {
  root: MeshHandle;
  meshes: readonly MeshHandle[];
  dispose(): void;
}
export function deduplicateParts(meshes: Iterable<MeshHandle>): { parts: number; unique: number } {
  const seen = new Map<string, Array<{ data: Float32Array; geometry: Geometry }>>(),
    known = new Map<Geometry, Geometry>();
  let parts = 0,
    unique = 0;
  for (const handle of meshes) {
    const mesh = meshRuntime(handle);
    mesh.check();
    if (!mesh.geometry) continue;
    parts++;
    let canonical = known.get(mesh.geometry);
    if (!canonical) {
      const data = fingerprint(mesh.geometry),
        key = `${data.length}:${hash(data)}`,
        bucket = seen.get(key) ?? [],
        match = bucket.find((entry) => entry.data.length === data.length && entry.data.every((v, i) => v === data[i]));
      canonical = match?.geometry ?? mesh.geometry;
      if (!match) {
        bucket.push({ data, geometry: canonical });
        seen.set(key, bucket);
        unique++;
      }
      known.set(mesh.geometry, canonical);
    }
    if (mesh.geometry !== canonical) mesh.setGeometry(canonical);
  }
  return { parts, unique };
}
/** Parse STL or OBJ on this thread; `maxParts` as for loadCAD. */
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
  }: CADImportOptions & {
    format?: CADFormat;
    /** Download fetch, for example `@margoengine/cache`'s `cache.fetch`; parsing still runs in the worker. */
    fetch?: typeof fetch;
  } = {},
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
    return parseCAD(engine, data, kind);
  }
  const buffer =
    data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data.buffer
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return parseCADAsync(engine, buffer as ArrayBuffer, kind, { signal, ...options });
}
export class PartInstancer implements EnginePlugin {
  readonly name = 'part-instancer';
  /** Same as `engine.use(new PartInstancer())`; returns the PartInstancer. */
  static attach(engine: EngineKernel): PartInstancer {
    const value = new PartInstancer();
    engine.use(value);
    return value;
  }
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
