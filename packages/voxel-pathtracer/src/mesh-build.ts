import { MargoError } from '@margoengine/math/errors';
import type { MeshTraceScene } from './mesh.js';

export interface MeshKernel {
  memory: WebAssembly.Memory;
  allocate(n: number): number;
  release(p: number, n: number): void;
  build_mesh(p: number, n: number): number;
  build_instances(p: number, n: number): number;
  equal_words(p: number, n: number): number;
  output_ptr(): number;
  output_len(): number;
}

/** Lazy and feature-local. No Wasm fetch or compilation happens on import. */
export async function meshKernel(signal?: AbortSignal): Promise<MeshKernel> {
  const url = new URL('./mesh.wasm?no-inline', import.meta.url);
  let bytes: ArrayBuffer;
  if (url.protocol === 'file:') {
    url.search = '';
    const module = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ module);
    const file: Uint8Array<ArrayBuffer> = await readFile(url, { signal });
    bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  } else {
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw new MargoError(
        'failed',
        'Mesh Wasm fetch failed; serve package assets: https://margoengine.com/errors#voxel-pathtracer',
      );
    bytes = await response.arrayBuffer();
  }
  signal?.throwIfAborted();
  const result = await WebAssembly.instantiate(bytes);
  signal?.throwIfAborted();
  return result.instance.exports as unknown as MeshKernel;
}

/** Validate/copy caller arrays before the first wait; the Rust kernel owns the heavy geometry work. */
export async function buildTraceMeshes(scene: MeshTraceScene, signal?: AbortSignal): Promise<Uint32Array> {
  signal?.throwIfAborted();
  if (!scene || !Array.isArray(scene.meshes) || !Array.isArray(scene.materials))
    throw new TypeError('MeshPathTracer scene must contain meshes and materials arrays');
  const ids = new Set<string>(),
    materials = new Map(scene.materials.map((m) => [m?.id, m]));
  let size = 1,
    triangles = 0;
  for (const m of scene.meshes) {
    if (!m || typeof m.id !== 'string' || !m.id || ids.has(m.id))
      throw new TypeError('MeshPathTracer mesh ids must be nonempty and unique');
    ids.add(m.id);
    if (
      !(m.positions instanceof Float32Array) ||
      m.positions.length % 3 !== 0 ||
      !(m.indices instanceof Uint32Array) ||
      m.indices.length % 3 !== 0
    )
      throw new TypeError('MeshPathTracer expects Float32Array xyz positions and Uint32Array triangle indices');
    const material = materials.get(m.material);
    if (!material) throw new TypeError('MeshPathTracer mesh.material must name a scene palette material');
    if (
      material.type === 'media' ||
      material.cutout !== undefined ||
      (material.texture !== undefined && (typeof material.texture !== 'number' || m.uvs === undefined))
    )
      throw new TypeError(
        'MeshPathTracer meshes support surface materials; textures require one numeric texture index and vertex UVs; media and cutout are unsupported',
      );
    if (m.normals !== undefined && (!(m.normals instanceof Float32Array) || m.normals.length !== m.positions.length))
      throw new TypeError('MeshPathTracer normals must be Float32Array xyz values, one per position');
    if (m.uvs !== undefined && (!(m.uvs instanceof Float32Array) || m.uvs.length !== (m.positions.length / 3) * 2))
      throw new TypeError('MeshPathTracer uvs must be Float32Array pairs, one per position');
    triangles += m.indices.length / 3;
    size += 3 + m.positions.length + m.indices.length;
  }
  if (triangles > 1_000_000 || size > (128 << 20) / 4)
    throw new RangeError(
      'MeshPathTracer accepts at most 1,000,000 triangles and 128 MiB of input words; pass fewer triangles or vertices',
    );
  const attributes = scene.meshes.some((m) => m.normals !== undefined || m.uvs !== undefined);
  if (attributes) size += 1 + scene.meshes.reduce((n, m) => n + 2 + (m.normals?.length ?? 0) + (m.uvs?.length ?? 0), 0);
  if (size > (128 << 20) / 4) throw new RangeError('MeshPathTracer accepts at most 128 MiB of input words');
  const input = new Uint32Array(size);
  input[0] = scene.meshes.length;
  let at = 1;
  for (const m of scene.meshes) {
    input.set([m.positions.length / 3, m.indices.length, m.material], at);
    at += 3;
    input.set(new Uint32Array(m.positions.buffer, m.positions.byteOffset, m.positions.length), at);
    at += m.positions.length;
    input.set(m.indices, at);
    at += m.indices.length;
  }
  if (attributes) {
    input[at++] = 0x4d415454;
    for (const m of scene.meshes) {
      input.set([m.normals?.length ?? 0, m.uvs?.length ?? 0], at);
      at += 2;
      for (const a of [m.normals, m.uvs])
        if (a) {
          input.set(new Uint32Array(a.buffer, a.byteOffset, a.length), at);
          at += a.length;
        }
    }
  }
  const k = await meshKernel(signal),
    p = k.allocate(size);
  try {
    new Uint32Array(k.memory.buffer, p, size).set(input);
    const code = k.build_mesh(p, size);
    if (code)
      throw new RangeError(
        `MeshPathTracer ${['', 'invalid mesh packet', 'positions must be finite within +/-1e8 world units', 'index outside positions', 'normals must be finite and nonzero', 'UVs must be finite within +/-1e8'][code] ?? 'invalid mesh'}; check scene.meshes`,
      );
    signal?.throwIfAborted();
    return new Uint32Array(k.memory.buffer, k.output_ptr(), k.output_len()).slice();
  } finally {
    k.release(p, size);
  }
}
