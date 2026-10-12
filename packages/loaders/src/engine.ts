import {PbrMaterial, type Geometry} from '@margoengine/core';
import type {EngineKernel, Mesh} from '@margoengine/core';
import {LoaderError, type LoadedGeometry, type LoadedGroup} from './types.js';
import {pointsToGeometry, toGeometry, type PointsToGeometryOptions, type ToGeometryOptions} from './geometry.js';

export interface CreateMeshesOptions extends Pick<ToGeometryOptions, 'normals'>, PointsToGeometryOptions {
  /** Parent for every created mesh. */
  parent?: Mesh | null;
  /** Color for meshes without a file color: `#rrggbb` (sRGB) or linear RGB. Default `#b8bcc4`. */
  color?: string | readonly number[];
  roughness?: number;
  metalness?: number;
  doubleSided?: boolean;
  /** One mesh for the whole result instead of one per group. Default false. */
  merge?: boolean;
  /**
   * Per-vertex colors cannot be rendered by core materials. `'average'` (default) colors each mesh with the
   * average of its vertex colors; `'ignore'` uses `color`.
   */
  vertexColors?: 'average' | 'ignore';
}

export interface LoadedMeshes {
  meshes: Mesh[];
  geometries: Geometry[];
  materials: PbrMaterial[];
  /** Disposes every created mesh. */
  dispose(): void;
}

const toLinear = (v: number): number => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const clamp = (v: number): number => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

function averageColor(loaded: LoadedGeometry, group: LoadedGroup | undefined): [number, number, number] | undefined {
  const colors = loaded.colors;
  if (!colors) return undefined;
  const sum = [0, 0, 0];
  let count = 0;
  const add = (v: number): void => {for (let a = 0; a < 3; a++) sum[a] += toLinear(clamp(colors[v * 3 + a])); count++;};
  if (loaded.indices) {
    const start = group?.start ?? 0, end = group ? group.start + group.count : loaded.indices.length;
    for (let i = start; i < end; i++) add(loaded.indices[i]);
  } else for (let v = 0; v < colors.length / 3; v++) add(v);
  return count ? sum.map(v => v / count) as [number, number, number] : undefined;
}

/**
 * Creates engine meshes for a loaded result: one per group (3MF objects and colors) or one for the whole mesh,
 * with a `PbrMaterial` per distinct color. Point clouds become octahedron markers through `pointsToGeometry`.
 */
export function createMeshes(engine: EngineKernel, loaded: LoadedGeometry, options: CreateMeshesOptions = {}): LoadedMeshes {
  if (!engine || typeof engine.createMesh !== 'function') throw new LoaderError('Engine', 'range', 'expected a Margo Engine engine');
  const vertexColors = options.vertexColors ?? 'average';
  if (vertexColors !== 'average' && vertexColors !== 'ignore') throw new LoaderError('Engine', 'range', `unknown vertexColors mode "${String(vertexColors)}"`);
  const materials = new Map<string, PbrMaterial>();
  const material = (color: string | readonly number[]): PbrMaterial => {
    const key = typeof color === 'string' ? color.toLowerCase() : color.map(v => v.toFixed(5)).join(',');
    let result = materials.get(key);
    if (!result) materials.set(key, result = new PbrMaterial({color, roughness: options.roughness ?? 0.6, metalness: options.metalness ?? 0, doubleSided: options.doubleSided ?? true}));
    return result;
  };
  const fallback = options.color ?? '#b8bcc4';
  const colorFor = (group: LoadedGroup | undefined): string | readonly number[] => {
    if (group?.color) return group.color.slice(0, 3).map(v => toLinear(clamp(v)));
    if (vertexColors === 'average') return averageColor(loaded, group) ?? fallback;
    return fallback;
  };
  const parts: {geometry: Geometry; color: string | readonly number[]; name?: string}[] = [];
  if (loaded.kind === 'points') parts.push({geometry: pointsToGeometry(loaded, options), color: colorFor(undefined)});
  else if (options.merge || !loaded.groups?.length) {
    const group = !options.merge ? undefined : loaded.groups?.length === 1 ? loaded.groups[0] : undefined;
    parts.push({geometry: toGeometry(loaded, {normals: options.normals}), color: group?.color ? colorFor(group) : colorFor(undefined)});
  } else for (const group of loaded.groups) {
    if (!group.count) continue;
    parts.push({geometry: toGeometry(loaded, {normals: options.normals, group}), color: colorFor(group), name: group.name});
  }
  const meshes: Mesh[] = [];
  try {
    for (const part of parts) {
      const mesh = engine.createMesh(options.parent ?? null);
      meshes.push(mesh);
      mesh.setGeometry(part.geometry).setMaterial(material(part.color));
      if (part.name) mesh.name = part.name;
    }
  } catch (error) {
    for (const mesh of meshes) try {mesh.dispose();} catch {/* already gone */}
    throw error;
  }
  return {
    meshes, geometries: parts.map(p => p.geometry), materials: [...materials.values()],
    dispose() {for (const mesh of meshes) try {mesh.dispose();} catch {/* engine disposed */}},
  };
}
