import type { VoxelTraceScene } from '@margoengine/voxel-pathtracer';
import { TraceMeshBuilder } from './mesh-instances.js';
import type { TraceGeometryBuilder } from './compose-types.js';
import type { PBRMeshTraceScene, TracePBRMesh, TracePBRMaterial, TracePBRTexture } from './mesh-pbr-types.js';

const LIMIT = (128 << 20) / 4;
const MAPS = ['baseColorTexture', 'metallicRoughnessTexture', 'normalTexture', 'emissiveTexture'] as const;
const wraps = ['repeat', 'mirror', 'clamp'];
function finite(value: number, name: string, low = 0, high = 1): number {
  if (!Number.isFinite(value) || value < low || value > high)
    throw new RangeError(`Mesh PBR ${name} must be finite in [${low}, ${high}]; check pbrMaterials`);
  return value;
}
function vector(a: readonly number[], size: number, name: string, high = 1): void {
  if (!a || a.length !== size) throw new TypeError(`Mesh PBR ${name} needs ${size} components`);
  for (const n of a) finite(n, name, 0, high);
}
function texture(t: TracePBRTexture): void {
  if (!t || !Number.isInteger(t.width) || !Number.isInteger(t.height) || t.width < 1 || t.height < 1 ||
      t.width * t.height > LIMIT || !(t.data instanceof Uint8Array || t.data instanceof Uint8ClampedArray) ||
      t.data.length !== t.width * t.height * 4)
    throw new TypeError('Mesh PBR texture needs positive dimensions and exact RGBA8 pixels');
  if (!Number.isInteger(t.texCoord ?? 0) || (t.texCoord ?? 0) < 0 || (t.texCoord ?? 0) > 3)
    throw new RangeError('Mesh PBR texCoord must be 0 through 3');
  if (!wraps.includes(t.wrapS ?? 'repeat') || !wraps.includes(t.wrapT ?? 'repeat') ||
      !['nearest', 'linear'].includes(t.filter ?? 'linear'))
    throw new TypeError('Mesh PBR texture needs repeat, mirror or clamp wrapping and nearest or linear filtering');
  if (t.transform !== undefined && (t.transform.length !== 6 || t.transform.some(n => !Number.isFinite(n) || Math.abs(n) > 1e8)))
    throw new TypeError('Mesh PBR texture transform needs six finite affine values');
}

/** Owns the optional PBR packet while retaining the existing geometry cache lifetime. */
export class PBRMeshBuilder implements TraceGeometryBuilder {
  #mesh = new TraceMeshBuilder();
  async build(input: VoxelTraceScene, signal?: AbortSignal): Promise<Uint32Array> {
    signal?.throwIfAborted();
    const s = input as PBRMeshTraceScene;
    if (!Array.isArray(s.meshes) || !Array.isArray(s.pbrMaterials))
      throw new TypeError('Mesh PBR needs meshes and pbrMaterials arrays');
    const meshes = s.meshes as readonly TracePBRMesh[];
    const materials = new Map<number, TracePBRMaterial>();
    const materialOffsets = new Map<number, number>();
    const textures = new Map<TracePBRTexture, number>();
    let size = s.pbrMaterials.length * 32;
    for (const m of s.pbrMaterials) {
      if (!m || !Number.isSafeInteger(m.id) || m.id < 1 || materials.has(m.id))
        throw new TypeError('Mesh PBR material ids must be unique positive safe integers');
      materialOffsets.set(m.id, materials.size * 32);
      vector(m.baseColorFactor ?? [1, 1, 1, 1], 4, 'baseColorFactor');
      vector(m.emissiveFactor ?? [0, 0, 0], 3, 'emissiveFactor', 1e8);
      finite(m.emissiveStrength ?? 1, 'emissiveStrength', 0, 1e8);
      finite(m.roughnessFactor ?? 1, 'roughnessFactor');
      finite(m.metallicFactor ?? 1, 'metallicFactor');
      finite(m.normalScale ?? 1, 'normalScale', -1e8, 1e8);
      finite(m.alphaCutoff ?? 0.5, 'alphaCutoff');
      if (!['OPAQUE', 'MASK'].includes(m.alphaMode ?? 'OPAQUE') ||
          (m.doubleSided !== undefined && typeof m.doubleSided !== 'boolean'))
        throw new TypeError('Mesh PBR requires OPAQUE or MASK and a boolean doubleSided');
      for (const name of MAPS) {
        const t = m[name];
        if (t && !textures.has(t)) {
          texture(t);
          textures.set(t, size);
          size += 16 + t.width * t.height;
        }
      }
      materials.set(m.id, m);
    }
    const meshOffsets = new Map<string, number>();
    for (const m of meshes) {
      const count = m.positions.length / 3;
      if (m.uvSets && (!Array.isArray(m.uvSets) || m.uvSets.length > 4))
        throw new TypeError('Mesh PBR uvSets accepts at most four coordinate arrays');
      for (const [name, a, length] of [
        ['tangents', m.tangents, count * 4], ['colors', m.colors, count * 4],
        ...Array.from({length: 4}, (_, i) => [`uv${i}`, m.uvSets?.[i] ?? (i === 0 ? m.uvs : undefined), count * 2]),
      ] as const) {
        if (a !== undefined && (!(a instanceof Float32Array) || a.length !== length || a.some(n => !Number.isFinite(n) || Math.abs(n) > 1e8)))
          throw new TypeError(`Mesh PBR ${name} needs finite Float32Array vertex values`);
      }
      if (m.colors?.some(n => n < 0 || n > 1)) throw new RangeError('Mesh PBR vertex colours must be in [0,1]');
      if (m.tangents) for (let i = 0; i < count; i++) {
        const at = i * 4, w = m.tangents[at + 3]!;
        if (![0, 1, -1].includes(w) || (w !== 0 && Math.hypot(...m.tangents.subarray(at, at+3)) === 0))
          throw new RangeError('Mesh PBR tangents need a nonzero direction and handedness +1 or -1, or handedness 0 for a generated frame');
      }
      const material = materials.get(m.material);
      if (!material) throw new TypeError('Mesh PBR every mesh must name a pbrMaterials id');
      if (material) for (const key of MAPS) {
        const t = material[key];
        if (t && !(m.uvSets?.[t.texCoord ?? 0] ?? ((t.texCoord ?? 0) === 0 ? m.uvs : undefined)))
          throw new TypeError(`Mesh PBR ${key} requires its selected vertex UV set`);
      }
      meshOffsets.set(m.id, size);
      size += 4 + m.indices.length + count * 16;
    }
    if (size > LIMIT) throw new RangeError('Mesh PBR packet exceeds 128 MiB; use fewer vertices or smaller images');
    const clean = {
      ...s,
      meshInstances: s.meshInstances ?? meshes.map(m => ({id: m.id, mesh: m.id})),
      meshes: meshes.map(m => ({...m, material: 1})),
      materials: [{id: 1, type: 'diffuse' as const, color: [1, 1, 1] as const}],
    };
    const geometry = await this.#mesh.build(clean, signal);
    if (geometry.length + size > LIMIT)
      throw new RangeError('Mesh PBR geometry and materials exceed 128 MiB; reduce the scene');
    const out = new Uint32Array(geometry.length + size), f = new Float32Array(out.buffer), base = geometry.length;
    out.set(geometry);
    out[10] = base;
    for (const m of materials.values()) {
      const at = base + materialOffsets.get(m.id)!;
      out[at] = 1;
      f.set(m.baseColorFactor ?? [1, 1, 1, 1], at + 4);
      f.set(m.emissiveFactor ?? [0, 0, 0], at + 8);
      f[at + 11] = m.emissiveStrength ?? 1;
      f.set([m.metallicFactor ?? 1, m.roughnessFactor ?? 1, m.normalScale ?? 1, m.alphaCutoff ?? .5], at + 12);
      out[at + 1] = m.alphaMode === 'MASK' ? 1 : 0;
      out[at + 2] = m.doubleSided ? 1 : 0;
      MAPS.forEach((key, i) => out[at + 16 + i] = m[key] ? base + textures.get(m[key]!)! : 0);
    }
    for (const [t, offset] of textures) {
      const at = base + offset;
      out.set([t.width, t.height, at + 16, t.texCoord ?? 0,
        wraps.indexOf(t.wrapS ?? 'repeat'), wraps.indexOf(t.wrapT ?? 'repeat'), t.filter === 'nearest' ? 0 : 1], at);
      f.set(t.transform ?? [1, 0, 0, 0, 1, 0], at + 8);
      new Uint8Array(out.buffer, (at + 16) * 4, t.data.byteLength).set(t.data);
    }
    for (const m of meshes) {
      const at = base + meshOffsets.get(m.id)!, vertices = at + 4 + m.indices.length;
      out.set([at + 4, vertices, m.tangents ? 1 : 0, 0], at);
      out.set(m.indices, at + 4);
      for (let i = 0; i < m.positions.length / 3; i++) {
        const v = vertices + i * 16;
        for (let j = 0; j < 4; j++) {
          const uv = m.uvSets?.[j] ?? (j === 0 ? m.uvs : undefined);
          if (uv) f.set(uv.subarray(i * 2, i * 2 + 2), v + j * 2);
        }
        f.set(m.tangents?.subarray(i * 4, i * 4 + 4) ?? [0, 0, 0, 0], v + 8);
        f.set(m.colors?.subarray(i * 4, i * 4 + 4) ?? [1, 1, 1, 1], v + 12);
      }
    }
    const placements = clean.meshInstances;
    const meshMaterials = new Map(meshes.map(m => [m.id, m.material]));
    for (let i = 0; i < out[4]!; i++) {
      const record = out[5]! + i * 32;
      const original = out[record + 26]!;
      out[record + 28] = base + meshOffsets.get(placements[original]!.mesh)!;
      out[record + 29] = base + materialOffsets.get(meshMaterials.get(placements[original]!.mesh)!)!;
    }
    signal?.throwIfAborted();
    return out;
  }
  dispose(): void { this.#mesh.dispose(); }
}
