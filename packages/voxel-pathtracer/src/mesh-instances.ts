import { MargoError } from '@margoengine/math/errors';
import type { MeshTraceScene, TraceTriangleMesh } from './mesh.js';
import { buildTraceMeshes, meshKernel, type MeshKernel } from './mesh-build.js';
import type { TraceGeometryBuilder } from './compose-types.js';

interface CachedMesh {
  mesh: TraceTriangleMesh;
  words: Uint32Array;
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function equal(a: ArrayBufferView | undefined, b: ArrayBufferView | undefined, k: MeshKernel): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint32Array(a.buffer, a.byteOffset, a.byteLength / 4),
    y = new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  const p = k.allocate(x.length * 2);
  try {
    new Uint32Array(k.memory.buffer, p, x.length).set(x);
    new Uint32Array(k.memory.buffer, p + x.byteLength, y.length).set(y);
    return k.equal_words(p, x.length * 2) === 1;
  } finally {
    k.release(p, x.length * 2);
  }
}
function same(a: TraceTriangleMesh, b: TraceTriangleMesh, k: MeshKernel): boolean {
  return (
    a.material === b.material &&
    equal(a.positions, b.positions, k) &&
    equal(a.indices, b.indices, k) &&
    equal(a.normals, b.normals, k) &&
    equal(a.uvs, b.uvs, k)
  );
}

/** One bounded cache per tracer. Exact array content, never revision or caller identity, selects a BLAS. */
export class TraceMeshBuilder implements TraceGeometryBuilder {
  #cache = new Map<string, CachedMesh>();
  #disposed = false;
  async build(input: MeshTraceScene, signal?: AbortSignal): Promise<Uint32Array> {
    signal?.throwIfAborted();
    if (this.#disposed)
      throw new MargoError('disposed', 'Mesh builder is disposed; https://margoengine.com/errors#voxel-pathtracer');
    // Own every byte before the first await, including matrices and unused definitions.
    const scene = {
      ...input,
      meshes: structuredClone(input.meshes),
      materials: structuredClone(input.materials),
      ...(input.meshInstances !== undefined && { meshInstances: structuredClone(input.meshInstances) }),
    };
    if (scene.meshInstances === undefined) {
      const words = await buildTraceMeshes(scene, signal);
      this.#cache.clear();
      return words;
    }
    if (!Array.isArray(scene.meshInstances) || scene.meshInstances.length > 1_000_000)
      throw new TypeError('MeshPathTracer meshInstances must be an array of at most 1,000,000 instances');
    if (!Array.isArray(scene.meshes) || !Array.isArray(scene.materials))
      throw new TypeError('MeshPathTracer scene must contain meshes and materials arrays');
    const definitions = new Map<string, TraceTriangleMesh>();
    for (const mesh of scene.meshes) {
      if (!mesh || typeof mesh.id !== 'string' || !mesh.id || definitions.has(mesh.id))
        throw new TypeError('MeshPathTracer mesh ids must be nonempty and unique');
      if (
        !(mesh.positions instanceof Float32Array) ||
        mesh.positions.length % 3 !== 0 ||
        !(mesh.indices instanceof Uint32Array) ||
        mesh.indices.length % 3 !== 0 ||
        (mesh.normals !== undefined &&
          (!(mesh.normals instanceof Float32Array) || mesh.normals.length !== mesh.positions.length)) ||
        (mesh.uvs !== undefined &&
          (!(mesh.uvs instanceof Float32Array) || mesh.uvs.length !== (mesh.positions.length / 3) * 2))
      )
        throw new TypeError('MeshPathTracer expects Float32Array positions/normals/uvs and Uint32Array indices');
      definitions.set(mesh.id, mesh);
    }
    const ids = new Set<string>();
    let ordinals = 0;
    const instances = scene.meshInstances.map((instance, index) => {
      if (!instance || typeof instance.id !== 'string' || !instance.id || ids.has(instance.id))
        throw new TypeError('MeshPathTracer mesh instance ids must be nonempty and unique');
      ids.add(instance.id);
      const mesh = definitions.get(instance.mesh);
      if (!mesh) throw new TypeError('MeshPathTracer mesh instance must reference a scene mesh id');
      const matrix = instance.transform === undefined ? IDENTITY : instance.transform;
      if (
        (!Array.isArray(matrix) && !(matrix instanceof Float32Array)) ||
        matrix.length !== 16 ||
        matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1 ||
        Array.from(matrix).some((v) => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e8)
      )
        throw new TypeError(
          'MeshPathTracer instance transform must contain 16 finite column-major values within +/-1e8',
        );
      const base = ordinals;
      ordinals += mesh.indices.length / 3;
      if (ordinals > 1_000_000)
        throw new RangeError('MeshPathTracer accepts at most 1,000,000 instanced input triangles');
      return { mesh, matrix, base, index };
    });
    const k = await meshKernel(signal);
    const next = new Map<string, CachedMesh>();
    let built = 0,
      reused = 0,
      retained = 0,
      skipped = 0,
      nodes = 0,
      submitted = 0,
      inputBytes = 0;
    for (const mesh of scene.meshes) {
      submitted += mesh.indices.length / 3;
      inputBytes +=
        mesh.positions.byteLength +
        mesh.indices.byteLength +
        (mesh.normals?.byteLength ?? 0) +
        (mesh.uvs?.byteLength ?? 0);
      if (submitted > 1_000_000 || inputBytes > 128 << 20)
        throw new RangeError('MeshPathTracer accepts at most 1,000,000 triangles and 128 MiB of input words');
      const old = this.#cache.get(mesh.id);
      // Revalidate material-dependent constraints on cache hits as well.
      const material = scene.materials.find((m) => m.id === mesh.material);
      if (
        !material ||
        material.type === 'media' ||
        material.cutout !== undefined ||
        (material.texture !== undefined && (typeof material.texture !== 'number' || mesh.uvs === undefined))
      )
        throw new TypeError('MeshPathTracer meshes require surface materials; textures require vertex UVs');
      const words =
        old && same(old.mesh, mesh, k)
          ? (reused++, old.words)
          : (built++, await buildTraceMeshes({ ...scene, meshes: [mesh] }, signal));
      next.set(mesh.id, { mesh, words });
      retained += words[2];
      skipped += words[3];
      nodes += words[0];
    }
    signal?.throwIfAborted();
    // Empty BLAS definitions remain validated/cached, but have no TLAS leaf.
    const active = instances.filter((i) => next.get(i.mesh.id)!.words[0] !== 0);
    const topWords = Math.max(0, active.length * 2 - 1) * 8,
      recordOffset = 16 + topWords;
    let size = recordOffset + active.length * 32;
    const offsets = new Map<string, number>();
    for (const [id, c] of next) {
      offsets.set(id, size);
      size += c.words.length;
    }
    if (size > (128 << 20) / 4) throw new RangeError('MeshPathTracer instance packet exceeds 128 MiB; pass fewer meshes or instances');
    const request = new Uint32Array(instances.length * 28),
      f = new Float32Array(request.buffer);
    instances.forEach((i, n) => {
      const at = n * 28,
        words = next.get(i.mesh.id)!.words;
      if (words[0] !== 0) request.set(words.subarray(4, 12), at);
      f.set(i.matrix, at + 8);
      request.set([offsets.get(i.mesh.id)!, i.base, i.index, words[0] === 0 ? 1 : 0], at + 24);
    });
    const p = k.allocate(request.length);
    let top: Uint32Array;
    try {
      new Uint32Array(k.memory.buffer, p, request.length).set(request);
      if (k.build_instances(p, request.length))
        throw new RangeError(
          'MeshPathTracer instance transform must be affine, invertible and finite in Float32 within +/-1e8, with transformed bounds within +/-1e8',
        );
      top = new Uint32Array(k.memory.buffer, k.output_ptr(), k.output_len()).slice();
    } finally {
      k.release(p, request.length);
    }
    signal?.throwIfAborted();
    if (this.#disposed)
      throw new MargoError('disposed', 'Mesh builder is disposed; https://margoengine.com/errors#voxel-pathtracer');
    const result = new Uint32Array(size);
    // Zero triangle offset selects the two-level packet. Legacy four-word packets stay valid.
    result.set([top[0], 0, retained, skipped, active.length, recordOffset, built, reused, nodes, 0x4d494e53]);
    result.set(top.subarray(4), 16);
    for (const [id, c] of next) result.set(c.words, offsets.get(id)!);
    this.#cache = next;
    return result;
  }
  dispose(): void {
    this.#disposed = true;
    this.#cache.clear();
  }
}
