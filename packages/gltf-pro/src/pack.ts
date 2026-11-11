import type { GLTFDocument, GLTFPrimitive } from '../../shared/gltf.js';
import { compressedIndices } from './draco-state.js';
import { entry, type GLTFAsset } from './asset.js';
import type { PreparedGeometry } from './index.js';
import { margoError } from '../../shared/errors.js';
import { partition, PRIMITIVE_VERTICES, type PartPlan } from './parts.js';
/** True for an object holding a `texCoord` above 1 anywhere: the texture infos of a material, extensions included. */
function readsLaterUV(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  for (const [key, item] of Object.entries(value))
    if (key === 'texCoord' ? (item as number) > 1 : readsLaterUV(item)) return true;
  return false;
}
/**
 * True when a material of primitive `p`, its own or a KHR_materials_variants one, reads TEXCOORD_2 or 3: only then do those
 * sets cost a read, a buffer and a shader, so files that merely carry them (common in exports) pay nothing.
 */
export function usesLaterUV(doc: GLTFDocument, p: GLTFPrimitive): boolean {
  const variants = p.extensions?.KHR_materials_variants as { mappings?: { material?: number }[] } | undefined,
    ids = [p.material, ...(variants?.mappings ?? []).map((mapping) => mapping?.material)];
  const seen = new Set<number>();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const material = doc.materials?.[id];
    if (readsLaterUV(material)) return true;
    const levels = (material?.extensions as { MSFT_lod?: { ids?: unknown } } | undefined)?.MSFT_lod?.ids;
    if (Array.isArray(levels))
      for (const level of levels)
        if (Number.isInteger(level) && level >= 0 && level < (doc.materials?.length ?? 0)) ids.push(level);
  }
  return false;
}
/** Geometry already packed by a parse worker, keyed by primitive definition; PBRModel then skips decoding it. */
export const packed = new WeakMap<object, readonly PreparedGeometry[]>();
/**
 * Decode one primitive's accessors into gltf-pro's 80-byte vertices and uint32 indices (main thread or worker): one
 * element, or one per part when the primitive has more vertices than `asset.partVertices` (see parts.ts). With `each`,
 * every element goes to `each` as soon as it is filled and none is kept (a stream holds one part at a time).
 */
export function packPrimitive(
  asset: GLTFAsset,
  p: GLTFPrimitive,
  each?: (geometry: PreparedGeometry) => void,
): PreparedGeometry[] {
  compressedIndices(asset, p);
  try {
    return pack(asset, p, each);
  } catch (error) {
    // Name the mesh and primitive (searched only on this error path), keeping the error's class.
    const meshes = asset.doc.meshes ?? [],
      i = meshes.findIndex((m) => m?.primitives?.includes?.(p));
    if (error instanceof Error && i >= 0)
      error.message = `glTF mesh ${i}${meshes[i].name ? ` "${meshes[i].name}"` : ''} primitive ${meshes[i].primitives.indexOf(p)}: ${error.message}`;
    throw error;
  }
}
/**
 * glTF 2.0 section 3.7.2.1 topologies as lists: strips and fans become triangles, loops and strips become line pairs, so
 * every primitive draws as a point, line or triangle list. Too few indices give an empty list.
 */
export function listIndices(v: Uint32Array, mode: number): Uint32Array {
  const n = v.length;
  if (mode === 2 || mode === 3) {
    const lines = n < 2 ? 0 : mode === 2 ? n : n - 1,
      out = new Uint32Array(lines * 2);
    for (let i = 0; i < lines; i++) {
      out[i * 2] = v[i];
      out[i * 2 + 1] = v[(i + 1) % n];
    }
    return out;
  }
  if (mode === 5 || mode === 6) {
    const out = new Uint32Array(Math.max(n - 2, 0) * 3);
    for (let i = 0, o = 0; i < n - 2; i++, o += 3) {
      if (mode === 5) {
        out[o] = v[i];
        out[o + 1] = v[i + 1 + (i % 2)];
        out[o + 2] = v[i + 2 - (i % 2)];
      } else {
        out[o] = v[i + 1];
        out[o + 1] = v[i + 2];
        out[o + 2] = v[0];
      }
    }
    return out;
  }
  return v;
}
function pack(asset: GLTFAsset, p: GLTFPrimitive, each?: (geometry: PreparedGeometry) => void): PreparedGeometry[] {
  const mode = p.mode ?? 4,
    per = mode === 0 ? 1 : mode < 4 ? 2 : 3;
  if (!Number.isInteger(mode) || mode < 0 || mode > 6)
    throw new TypeError(
      'Invalid glTF primitive mode; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
    );
  const a = p.attributes ?? {},
    read = (label: string, id: unknown, type?: string) => {
      try {
        return asset.accessor(id, type);
      } catch (error) {
        if (error instanceof Error) error.message = `${label} (accessor ${id}): ${error.message}`;
        throw error;
      }
    };
  // Index accessors decode through Float32, exact to 2^24: refused from the declaration, before any decode.
  if (entry(asset.doc.accessors, a.POSITION, 'POSITION').count > PRIMITIVE_VERTICES)
    throw margoError(
      'unsupported',
      `glTF primitive has more than ${PRIMITIVE_VERTICES} vertices, the most one primitive may hold; split the mesh into several primitives`,
    );
  const positions = read('POSITION', a.POSITION, 'VEC3'),
    count = positions.length / 3,
    quantized = asset.doc.extensionsUsed?.includes('KHR_mesh_quantization'),
    max = asset.partVertices;
  if (count < per) throw new RangeError('Expected bounded triangle geometry');
  // Each part's vertex buffer is also bound as storage: parts of at most `max` vertices keep every binding in range.
  if (count > max && (a.JOINTS_0 !== undefined || (Array.isArray(p.targets) && p.targets.length > 0)))
    throw margoError(
      'unsupported',
      `Skinned or morphed glTF primitive has ${count} vertices, over maxPartVertices (${max}); only static primitives split into parts`,
    );
  for (const key of ['POSITION', 'NORMAL', 'TANGENT'])
    if (a[key] !== undefined && !quantized) {
      const def = entry(asset.doc.accessors, a[key], 'attribute');
      if (def.componentType !== 5126 || def.normalized) throw new TypeError('Expected Float32 ' + key);
    }
  for (const key of ['TEXCOORD_0', 'TEXCOORD_1', 'TEXCOORD_2', 'TEXCOORD_3', 'COLOR_0'])
    if (a[key] !== undefined && !(quantized && key !== 'COLOR_0')) {
      const def = entry(asset.doc.accessors, a[key], 'attribute');
      if (![5126, 5121, 5123].includes(def.componentType) || (def.componentType !== 5126 && !def.normalized))
        throw new TypeError('Invalid normalized ' + key + '; re-export the file and check it with the glTF Validator');
    }
  const normals = a.NORMAL === undefined ? new Float32Array(positions.length) : read('NORMAL', a.NORMAL, 'VEC3');
  const indexValues =
    compressedIndices(asset, p) ?? (p.indices === undefined ? null : read('indices', p.indices, 'SCALAR'));
  if (indexValues)
    for (let i = 0; i < indexValues.length; i++) {
      const v = indexValues[i];
      if (!Number.isInteger(v) || v < 0 || v >= count)
        throw new RangeError(
          'Invalid glTF triangle indices; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
        );
    }
  let indices: Uint32Array = indexValues ? new Uint32Array(indexValues) : new Uint32Array(count);
  if (!indexValues) for (let i = 0; i < count; i++) indices[i] = i;
  indices = listIndices(indices, mode);
  if (!indices.length || indices.length % per)
    throw new RangeError(
      'Invalid glTF triangle indices; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
    );
  if (
    p.indices !== undefined &&
    (![5121, 5123, 5125].includes(entry(asset.doc.accessors, p.indices, 'indices').componentType) ||
      asset.doc.accessors![p.indices].normalized)
  )
    throw new TypeError(
      'Invalid index component type; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
    );
  if (a.NORMAL === undefined && per === 3)
    for (let i = 0; i < indices.length; i += 3) {
      const x = indices[i] * 3,
        y = indices[i + 1] * 3,
        z = indices[i + 2] * 3;
      const ux = positions[y] - positions[x],
        uy = positions[y + 1] - positions[x + 1],
        uz = positions[y + 2] - positions[x + 2],
        vx = positions[z] - positions[x],
        vy = positions[z + 1] - positions[x + 1],
        vz = positions[z + 2] - positions[x + 2];
      const nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      normals[x] += nx;
      normals[x + 1] += ny;
      normals[x + 2] += nz;
      normals[y] += nx;
      normals[y + 1] += ny;
      normals[y + 2] += nz;
      normals[z] += nx;
      normals[z + 1] += ny;
      normals[z + 2] += nz;
    }
  // After the summed normals, whose rounding follows the file's order. Blended triangles layer in the file's order.
  const blend = asset.doc.materials?.[p.material as number]?.alphaMode === 'BLEND',
    plans: PartPlan[] | null = count > max ? partition(indices, per, count, max, blend ? null : positions) : null;
  if (asset.reorder && per === 3 && !blend) {
    if (!plans) indices = asset.reorder(indices, positions, count);
    else
      for (const plan of plans) {
        const n = plan.vertexMap.length,
          local = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) {
          const v = plan.vertexMap[k] * 3;
          local[k * 3] = positions[v];
          local[k * 3 + 1] = positions[v + 1];
          local[k * 3 + 2] = positions[v + 2];
        }
        plan.indices = asset.reorder(plan.indices, local, n);
      }
  }
  const uv0 = a.TEXCOORD_0 === undefined ? null : read('TEXCOORD_0', a.TEXCOORD_0, 'VEC2'),
    uv1 = a.TEXCOORD_1 === undefined ? null : read('TEXCOORD_1', a.TEXCOORD_1, 'VEC2'),
    later = usesLaterUV(asset.doc, p),
    uv2 = !later || a.TEXCOORD_2 === undefined ? null : read('TEXCOORD_2', a.TEXCOORD_2, 'VEC2'),
    uv3 = !later || a.TEXCOORD_3 === undefined ? null : read('TEXCOORD_3', a.TEXCOORD_3, 'VEC2');
  const tangent = a.TANGENT === undefined ? null : read('TANGENT', a.TANGENT, 'VEC4'),
    colors = a.COLOR_0 === undefined ? null : read('COLOR_0', a.COLOR_0);
  const colorWidth = colors ? colors.length / count : 0;
  if (
    normals.length !== count * 3 ||
    (uv0 && uv0.length !== count * 2) ||
    (uv1 && uv1.length !== count * 2) ||
    (uv2 && uv2.length !== count * 2) ||
    (uv3 && uv3.length !== count * 2) ||
    (tangent && tangent.length !== count * 4) ||
    (colors && ![3, 4].includes(colorWidth))
  )
    throw new RangeError(
      'Mismatched glTF attributes; the file holds invalid numbers, re-export it and check it with the glTF Validator',
    );
  // Packed vertex: position+1, normal+0, tangent, uv0 uv1, color; `i` is the source vertex, `o` its first float.
  const fill = (vertices: Float32Array, i: number, o: number) => {
    const p = i * 3,
      nx = normals[p],
      ny = normals[p + 1],
      nz = normals[p + 2],
      length = Math.hypot(nx, ny, nz);
    vertices[o] = positions[p];
    vertices[o + 1] = positions[p + 1];
    vertices[o + 2] = positions[p + 2];
    vertices[o + 3] = 1;
    // Without NORMAL, a vertex no triangle shades (unreferenced, only in degenerate triangles, or in points and lines,
    // which draw unlit) gets +Z, and so does one whose summed face normals overflow Float32 (coordinates past about
    // 1e19: Infinity / Infinity would be NaN); a zero or non-finite normal the file supplies is an error.
    if (!length || !Number.isFinite(length)) {
      if (a.NORMAL !== undefined)
        throw new RangeError(
          'Zero or non-finite glTF normal; the file holds invalid numbers, re-export it and check it with the glTF Validator',
        );
      vertices[o + 6] = 1;
    } else {
      vertices[o + 4] = nx / length;
      vertices[o + 5] = ny / length;
      vertices[o + 6] = nz / length;
    }
    if (tangent) {
      // Quantized tangents (KHR_mesh_quantization) come in about 1% off unit length. A zero one has no direction, so
      // it gets sign 0, which makes the shader take the frame from the UV derivatives.
      const t = i * 4,
        size = Math.hypot(tangent[t], tangent[t + 1], tangent[t + 2]);
      if (size) {
        vertices[o + 8] = tangent[t] / size;
        vertices[o + 9] = tangent[t + 1] / size;
        vertices[o + 10] = tangent[t + 2] / size;
        vertices[o + 11] = Math.sign(tangent[t + 3]);
      }
    }
    if (uv0) {
      vertices[o + 12] = uv0[i * 2];
      vertices[o + 13] = uv0[i * 2 + 1];
    }
    if (uv1) {
      vertices[o + 14] = uv1[i * 2];
      vertices[o + 15] = uv1[i * 2 + 1];
    }
    if (colors) {
      const c = i * colorWidth;
      vertices[o + 16] = colors[c];
      vertices[o + 17] = colors[c + 1];
      vertices[o + 18] = colors[c + 2];
      vertices[o + 19] = colorWidth === 3 ? 1 : colors[c + 3];
    } else {
      vertices[o + 16] = 1;
      vertices[o + 17] = 1;
      vertices[o + 18] = 1;
      vertices[o + 19] = 1;
    }
  };
  const fillLater = (uvs: Float32Array, i: number, o: number) => {
    if (uv2) uvs.set(uv2.subarray(i * 2, i * 2 + 2), o);
    if (uv3) uvs.set(uv3.subarray(i * 2, i * 2 + 2), o + 2);
  };
  const topology = per < 3 ? { topology: per === 1 ? ('point-list' as const) : ('line-list' as const) } : {};
  if (!plans) {
    const vertices = new Float32Array(count * 20),
      uvs = uv2 || uv3 ? new Float32Array(count * 4) : undefined;
    for (let i = 0; i < count; i++) fill(vertices, i, i * 20);
    if (uvs) for (let i = 0; i < count; i++) fillLater(uvs, i, i * 4);
    const whole = { vertices, indices, ...topology, ...(uvs ? { uvs } : {}) };
    if (!each) return [whole];
    each(whole);
    return [];
  }
  const out: PreparedGeometry[] = [];
  for (let index = 0; index < plans.length; index++) {
    const { indices, vertexMap } = plans[index],
      n = vertexMap.length,
      vertices = new Float32Array(n * 20),
      uvs = uv2 || uv3 ? new Float32Array(n * 4) : undefined;
    for (let k = 0; k < n; k++) fill(vertices, vertexMap[k], k * 20);
    if (uvs) for (let k = 0; k < n; k++) fillLater(uvs, vertexMap[k], k * 4);
    const part = {
      vertices,
      indices,
      ...topology,
      ...(uvs ? { uvs } : {}),
      part: { index, count: plans.length, vertexMap },
    };
    if (each) each(part);
    else out.push(part);
  }
  return out;
}
/** TEXCOORD_2 then TEXCOORD_3 of the vertices `vertexMap` names, four floats a vertex (a part's later UVs for a new material). */
export function laterUVs(asset: GLTFAsset, p: GLTFPrimitive, vertexMap: Uint32Array): Float32Array | undefined {
  const a = p.attributes ?? {},
    count = entry(asset.doc.accessors, a.POSITION, 'POSITION').count,
    uv2 = a.TEXCOORD_2 === undefined ? null : asset.accessor(a.TEXCOORD_2, 'VEC2'),
    uv3 = a.TEXCOORD_3 === undefined ? null : asset.accessor(a.TEXCOORD_3, 'VEC2');
  if (!uv2 && !uv3) return undefined;
  if ((uv2 && uv2.length !== count * 2) || (uv3 && uv3.length !== count * 2))
    throw new RangeError(
      'Mismatched glTF attributes; the file holds invalid numbers, re-export it and check it with the glTF Validator',
    );
  const uvs = new Float32Array(vertexMap.length * 4);
  for (let k = 0; k < vertexMap.length; k++) {
    const i = vertexMap[k];
    if (uv2) uvs.set(uv2.subarray(i * 2, i * 2 + 2), k * 4);
    if (uv3) uvs.set(uv3.subarray(i * 2, i * 2 + 2), k * 4 + 2);
  }
  return uvs;
}
/** Decode the accessors read besides packed geometry (skins, morph targets, animation samplers, GPU instancing); failures are left for the reader. */
export function decodeExtras(asset: GLTFAsset): [number, Float32Array][] {
  const doc = asset.doc,
    ids: unknown[] = [];
  for (const skin of doc.skins ?? []) ids.push(skin?.inverseBindMatrices);
  for (const mesh of doc.meshes ?? [])
    for (const p of mesh?.primitives ?? []) {
      ids.push(p?.attributes?.JOINTS_0, p?.attributes?.WEIGHTS_0);
      for (const t of p?.targets ?? []) ids.push(t?.POSITION, t?.NORMAL);
    }
  for (const animation of doc.animations ?? [])
    for (const s of animation?.samplers ?? []) ids.push(s?.input, s?.output);
  for (const node of doc.nodes ?? [])
    ids.push(...Object.values(node?.extensions?.EXT_mesh_gpu_instancing?.attributes ?? {}));
  const out: [number, Float32Array][] = [];
  for (const id of ids)
    if (id !== undefined)
      try {
        out.push([id as number, asset.accessor(id)]);
      } catch {}
  return out;
}
/** Primitive definitions mesh by mesh: @margoengine/gltf-pro/progressive and its worker key primitives by this list. */
export const primitiveDefs = (doc: GLTFAsset['doc']): GLTFPrimitive[] =>
  (doc.meshes ?? []).flatMap((m) => (Array.isArray(m?.primitives) ? m.primitives : []));
