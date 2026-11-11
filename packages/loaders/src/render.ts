import type { EngineKernel, Mesh } from '@margoengine/core';
import { parsePreparedPBR, type GLTFDocument, type PBRModel, type PreparedGeometry } from '@margoengine/gltf-pro/model';
import { SRGBToLinear } from '@margoengine/math/color';
import type { CreateMeshesOptions } from './engine.js';
import { splitTriangles, toGeometries } from './geometry.js';

/** Vertices of one gltf-pro primitive (its packed geometry limit). */
const PRIMITIVE_MAX_VERTICES = 1_000_000;
import { LoaderError, type LoadedGeometry, type LoadedGroup } from './types.js';

/**
 * Options for {@link createPBRMeshes}: `parent` (of the model root), `normals`, `roughness` (default 0.6),
 * `metalness` (default 0) and `doubleSided` (default true) as for `createMeshes`. Colors multiply in linear light.
 */
export interface CreatePBRMeshesOptions
  extends Pick<CreateMeshesOptions, 'parent' | 'normals' | 'roughness' | 'metalness' | 'doubleSided'> {
  /** Linear RGBA material multiplier in [0,1]. Default white, preserving source colors and opacity. */
  baseColorFactor?: readonly [number, number, number, number];
  /** Use the renderer's existing unlit material. Default false. */
  unlit?: boolean;
  /** Maximum packed vertex + index bytes across all parts, checked before GPU allocation. Default 256 MiB. */
  maxBytes?: number;
}

const format = 'Render';
function range(message: string): never {
  throw new LoaderError(format, 'range', message);
}
function unit(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) range(`${name} must be finite and in [0,1]`);
  return value;
}
function attribute(value: Float32Array | undefined, length: number, name: string, bounded = false): void {
  if (value === undefined) return;
  if (!(value instanceof Float32Array) || value.length !== length) range(`${name} must have ${length} Float32 values`);
  for (const v of value)
    if (!Number.isFinite(v) || (bounded && (v < 0 || v > 1)))
      range(`${name} must contain finite${bounded ? ' [0,1]' : ''} values`);
}

/**
 * Renders triangle loader output with exact per-vertex RGB and opacity through optional `gltf-pro`.
 * Source RGB is sRGB; opacity is linear. Group RGBA supplies only missing vertex channels, independently.
 * Uncovered index ranges render with white/opaque fallback. The explicit material factor multiplies RGBA.
 * Returns the renderer's owned model: dispose it once finished; its existing lifecycle restores GPU resources.
 * The input is never modified. A part past gltf-pro's limit of 1,000,000 vertices a primitive becomes several primitives of one
 * glTF mesh, split as toGeometries splits (normals seam-free). Point clouds, overlapping groups, more than 4096
 * parts, or an exceeded packed-data budget are refused before any GPU allocation.
 */
export function createPBRMeshes(
  engine: EngineKernel,
  loaded: LoadedGeometry,
  options: CreatePBRMeshesOptions = {},
): PBRModel {
  if (loaded.kind !== 'mesh')
    throw new LoaderError(
      format,
      'unsupported',
      'createPBRMeshes requires triangles; use createMeshes for point markers',
    );
  const count = loaded.positions?.length / 3,
    indices = loaded.indices,
    opacity = loaded.attributes?.opacity,
    mode = options.normals ?? 'auto',
    factor = options.baseColorFactor ?? [1, 1, 1, 1],
    roughness = unit(options.roughness ?? 0.6, 'roughness'),
    metalness = unit(options.metalness ?? 0, 'metalness'),
    maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  if (!Number.isInteger(count) || count < 3) range('positions must contain at least three xyz vertices');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) range('maxBytes must be a positive safe integer');
  if (!['auto', 'smooth', 'flat'].includes(mode)) range('normals must be auto, smooth or flat');
  if (factor.length !== 4) range('baseColorFactor must contain four values');
  for (const v of factor) unit(v, 'baseColorFactor');
  for (const key of ['doubleSided', 'unlit'] as const)
    if (options[key] !== undefined && typeof options[key] !== 'boolean') range(`${key} must be boolean`);
  attribute(loaded.positions, count * 3, 'positions');
  attribute(loaded.normals, count * 3, 'normals');
  attribute(loaded.colors, count * 3, 'colors', true);
  attribute(loaded.uvs, count * 2, 'uvs');
  attribute(opacity, count, 'opacity', true);
  if (!(indices instanceof Uint32Array) || !indices.length || indices.length % 3)
    range('indices must be a nonempty Uint32 triangle list');
  if (indices.byteLength > maxBytes)
    throw new LoaderError(format, 'limit', 'indices alone exceed maxBytes; increase maxBytes or split the asset');
  for (const index of indices) if (index >= count) range(`index ${index} exceeds the vertex count`);

  const parts: LoadedGroup[] = [];
  let end = 0;
  for (const group of loaded.groups ?? []) {
    const { start, count: size, color } = group;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(size) ||
      start < end ||
      size < 0 ||
      start % 3 ||
      size % 3 ||
      start + size > indices.length
    )
      range('groups must be ordered, non-overlapping triangle ranges inside indices');
    if (color) {
      if (color.length !== 4) range('group color must contain four values');
      for (const v of color) unit(v, 'group color');
    }
    if (start > end) parts.push({ start: end, count: start - end });
    if (size) parts.push(group);
    end = start + size;
  }
  if (end < indices.length) parts.push({ start: end, count: indices.length - end });
  if (parts.length > 4096) throw new LoaderError(format, 'limit', 'more than 4096 parts; merge or split the asset');
  // Count before preparing any renderer resources. The same source order is used by toGeometry's compaction.
  let bytes = 0;
  const chunks: Uint32Array[][] = [];
  for (const part of parts) {
    const triangles = indices.subarray(part.start, part.start + part.count),
      split = splitTriangles(triangles, count, mode === 'flat', PRIMITIVE_MAX_VERTICES).map((r) =>
        triangles.subarray(r.start, r.start + r.count),
      );
    chunks.push(split);
    for (const chunk of split) bytes += (mode === 'flat' ? chunk.length : new Set(chunk).size) * 80 + chunk.length * 4;
    if (bytes > maxBytes)
      throw new LoaderError(
        format,
        'limit',
        `packed geometry needs ${bytes} bytes; increase maxBytes or split the asset`,
      );
  }
  const geometry: PreparedGeometry[][] = [],
    doc: GLTFDocument = { asset: { version: '2.0' }, nodes: [], meshes: [], materials: [] };
  for (const [p, part] of parts.entries()) {
    // toGeometries splits the part exactly as splitTriangles did above, so cores[k] is built from chunks[p][k].
    const cores = toGeometries(loaded, { normals: mode, group: part, maxPartVertices: PRIMITIVE_MAX_VERTICES }),
      primitives: PreparedGeometry[] = [];
    let transparent = factor[3] < 1;
    for (const [k, core] of cores.entries()) {
      const triangles = chunks[p][k],
        sources = mode === 'flat' ? triangles : new Set(triangles),
        vertices = new Float32Array((core.vertices.length / 6) * 20);
      let target = 0;
      for (const source of sources) {
        const o = target * 20,
          c = source * 3,
          uv = source * 2,
          fallback = part.color;
        vertices.set(core.vertices.subarray(target * 6, target * 6 + 3), o);
        vertices[o + 3] = 1;
        vertices.set(core.vertices.subarray(target * 6 + 3, target * 6 + 6), o + 4);
        if (loaded.uvs) vertices.set(loaded.uvs.subarray(uv, uv + 2), o + 12);
        for (let j = 0; j < 3; j++) vertices[o + 16 + j] = SRGBToLinear(loaded.colors?.[c + j] ?? fallback?.[j] ?? 1);
        const alpha = opacity?.[source] ?? fallback?.[3] ?? 1;
        vertices[o + 19] = alpha;
        transparent ||= alpha < 1;
        target++;
      }
      primitives.push({ vertices, indices: core.indices });
    }
    const index = geometry.length;
    geometry.push(primitives);
    doc.nodes!.push({ mesh: index, name: part.name });
    doc.meshes!.push({ primitives: primitives.map(() => ({ attributes: {}, material: index })) });
    doc.materials!.push({
      name: part.name,
      pbrMetallicRoughness: { baseColorFactor: [...factor], roughnessFactor: roughness, metallicFactor: metalness },
      alphaMode: transparent ? 'BLEND' : 'OPAQUE',
      doubleSided: options.doubleSided ?? true,
      ...(options.unlit ? { extensions: { KHR_materials_unlit: {} } } : {}),
    });
  }
  if (options.unlit) doc.extensionsUsed = ['KHR_materials_unlit'];
  const model = parsePreparedPBR(engine, doc, geometry, [], { maxNodes: 4096 });
  try {
    if (options.parent) (model.root as Mesh).setParent(options.parent);
    return model;
  } catch (error) {
    model.dispose();
    throw error;
  }
}
