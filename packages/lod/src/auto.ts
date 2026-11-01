// Builds levels of detail instead of taking them: simplified copies of a mesh (`autoLOD`) and one far mesh per cell of
// many still meshes (`hierarchicalLOD`). @margoengine/mesh-edit does the simplifying, loaded when first needed.
import { Geometry, type Mesh } from '@margoengine/core';
import { meshRuntime } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { LOD, LODLevel, LODSystem } from './index.js';

/** Options of {@link autoLOD}. */
export interface AutoLODOptions {
  /** Fraction of the triangles each level below the source keeps, decreasing. Default `[0.5, 0.25, 0.125]`. */
  ratios?: readonly number[];
  /** Height of the bounding sphere as a fraction of the viewport at which each level starts. Default `0.25` halved per level. */
  screens?: readonly number[];
  /** Normals of a level bend across edges up to this angle, in degrees, and break past it. Default 60. */
  crease?: number;
  /** Cancels the wait for the simplifier and the work after it. */
  signal?: AbortSignal;
}
/** Options of {@link hierarchicalLOD}. */
export interface HierarchicalLODOptions {
  /** World size of a cell, above 0. */
  cell: number;
  /** Distance from the camera to a cell's centre at which its far mesh replaces its meshes. Default 8 cells. */
  distance?: number;
  /** Fraction of the triangles the far mesh keeps, up to 1. Default 1: merged, not simplified. */
  ratio?: number;
  /** As {@link AutoLODOptions.crease}, for a simplified far mesh. */
  crease?: number;
  /** Cancels the wait for the simplifier and the work after it. */
  signal?: AbortSignal;
}
/** What {@link hierarchicalLOD} built. */
export interface HierarchicalLOD {
  /** One LOD per cell that holds a mesh. */
  readonly lods: readonly LOD[];
  /** The far meshes made, per cell and material. */
  readonly meshes: readonly Mesh[];
  /** Stops managing the cells, frees the far meshes and shows the source meshes again. */
  remove(): void;
}
type Simplify = (positions: ArrayLike<number>, indices: ArrayLike<number>, ratios: readonly number[]) => Geometry[];

/** Loads the simplifier: an optional package, so a page without this entry never pays for it. */
async function simplifier(crease: number, signal?: AbortSignal): Promise<Simplify> {
  signal?.throwIfAborted();
  const { meshLODChain, polygonMeshFromTriangles } = await import('@margoengine/mesh-edit/modeling');
  signal?.throwIfAborted();
  return (positions, indices, ratios) =>
    meshLODChain(polygonMeshFromTriangles({ positions, indices }).mesh, { ratios }).map(({ mesh }) => {
      const vertices = mesh.vertices,
        triangles: number[] = [];
      for (const { vertices: face } of mesh.faces)
        for (let i = 1; i + 1 < face.length; i++) triangles.push(face[0], face[i], face[i + 1]);
      return creased(vertices, triangles, crease);
    });
}

/**
 * Indexed triangles into a Geometry with a vertex per corner, normals averaged over the faces around a position whose
 * normal lies within `crease` degrees of the corner's own face, weighted by area.
 */
export function creased(vertices: readonly ArrayLike<number>[], triangles: readonly number[], crease = 60): Geometry {
  const count = triangles.length / 3,
    limit = Math.cos((crease * Math.PI) / 180),
    faces = new Float64Array(count * 3),
    around: number[][] = vertices.map(() => []);
  for (let t = 0; t < count; t++) {
    const a = vertices[triangles[t * 3]],
      b = vertices[triangles[t * 3 + 1]],
      c = vertices[triangles[t * 3 + 2]],
      ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2],
      vx = c[0] - a[0],
      vy = c[1] - a[1],
      vz = c[2] - a[2];
    faces[t * 3] = uy * vz - uz * vy;
    faces[t * 3 + 1] = uz * vx - ux * vz;
    faces[t * 3 + 2] = ux * vy - uy * vx;
    for (let k = 0; k < 3; k++) around[triangles[t * 3 + k]].push(t);
  }
  const positions = new Float32Array(count * 9),
    normals = new Float32Array(count * 9),
    length = (t: number) => Math.hypot(faces[t * 3], faces[t * 3 + 1], faces[t * 3 + 2]) || 1;
  for (let t = 0; t < count; t++)
    for (let k = 0; k < 3; k++) {
      const id = triangles[t * 3 + k],
        at = (t * 3 + k) * 3,
        own = length(t);
      let x = 0,
        y = 0,
        z = 0;
      for (const o of around[id]) {
        const cosine =
          (faces[t * 3] * faces[o * 3] + faces[t * 3 + 1] * faces[o * 3 + 1] + faces[t * 3 + 2] * faces[o * 3 + 2]) /
          (own * length(o));
        if (cosine < limit) continue;
        x += faces[o * 3];
        y += faces[o * 3 + 1];
        z += faces[o * 3 + 2];
      }
      const size = Math.hypot(x, y, z) || 1;
      positions.set(vertices[id] as ArrayLike<number>, at);
      normals[at] = x / size;
      normals[at + 1] = y / size;
      normals[at + 2] = z / size;
    }
  return new Geometry(
    positions,
    normals,
    Array.from({ length: count * 3 }, (_, i) => i),
  );
}
const positionsOf = (geometry: Geometry, out = new Float32Array(geometry.vertices.length / 2)) => {
  for (let i = 0; i < out.length / 3; i++) for (let a = 0; a < 3; a++) out[i * 3 + a] = geometry.vertices[i * 6 + a];
  return out;
};

/**
 * Registers `mesh` in `system` with simplified copies of its own geometry as the lower levels. Loads
 * `@margoengine/mesh-edit` on first use. A mesh with UVs or a texture keeps them on level 0 only: core geometry carries
 * neither, so this is for core meshes.
 * @throws TypeError for a mesh with no core geometry; RangeError for ratios or screens that do not fit; the
 * `signal`'s reason when it aborts.
 */
export async function autoLOD(system: LODSystem, mesh: Mesh, options: AutoLODOptions = {}): Promise<LOD> {
  const { ratios = [0.5, 0.25, 0.125], crease = 60, signal } = options,
    screens = options.screens ?? ratios.map((_, i) => 0.25 * 0.5 ** i),
    geometry = meshRuntime(mesh).geometry;
  if (!(geometry instanceof Geometry))
    throw new TypeError(
      'autoLOD needs a mesh with core geometry; call setGeometry first, or give gltf-pro models MSFT_lod',
    );
  if (screens.length !== ratios.length)
    throw new RangeError('autoLOD needs one screen size per ratio; give them the same length');
  const simplify = await simplifier(crease, signal),
    levels: LODLevel[] = [{ object: geometry }];
  simplify(positionsOf(geometry), geometry.indices, ratios).forEach((object, i) =>
    levels.push({ object, screen: screens[i] }),
  );
  return system.add(mesh, levels);
}

/**
 * Hierarchical level of detail for still meshes: per cell of a world grid, one far mesh per material holds their
 * triangles in world space, and shows in place of those meshes past `distance`. Moving a source mesh afterwards does
 * not move its far mesh. The world matrices are read now: call it after a frame has placed the meshes.
 * @throws TypeError when a mesh has no core geometry; RangeError for options out of range; MargoError `'state'` for an
 * empty list; the `signal`'s reason when it aborts.
 */
export async function hierarchicalLOD(
  system: LODSystem,
  meshes: readonly Mesh[],
  options: HierarchicalLODOptions,
): Promise<HierarchicalLOD> {
  const { cell, distance = cell * 8, ratio = 1, crease = 60, signal } = options ?? {};
  if (!(cell > 0 && cell < Infinity) || !(distance >= 0 && distance < Infinity) || !(ratio > 0 && ratio <= 1))
    throw new RangeError('Invalid hierarchical LOD options; give cell above 0, distance of 0 or more, ratio up to 1');
  if (!meshes?.length) throw new MargoError('state', 'hierarchicalLOD needs meshes; pass at least one still mesh');
  const simplify = ratio < 1 ? await simplifier(crease, signal) : undefined,
    cells = new Map<string, { members: Mesh[]; center: number[]; total: number }>(),
    point = [0, 0, 0];
  signal?.throwIfAborted();
  const place = (m: Float32Array, x: number, y: number, z: number) => {
    for (let a = 0; a < 3; a++) point[a] = m[a] * x + m[4 + a] * y + m[8 + a] * z + m[12 + a];
  };
  for (const mesh of meshes) {
    const runtime = meshRuntime(mesh),
      geometry = runtime.geometry;
    if (!(geometry instanceof Geometry))
      throw new TypeError('hierarchicalLOD needs meshes with core geometry; call setGeometry first');
    place(runtime.matrix, geometry.bounds[0], geometry.bounds[1], geometry.bounds[2]);
    const key = point.map((v) => Math.floor(v / cell)).join();
    let entry = cells.get(key);
    if (!entry) cells.set(key, (entry = { members: [], center: [0, 0, 0], total: 0 }));
    entry.members.push(mesh);
    entry.total++;
    for (let a = 0; a < 3; a++) entry.center[a] += point[a];
  }
  const lods: LOD[] = [],
    made: Mesh[] = [];
  for (const { members, center, total } of cells.values()) {
    for (let a = 0; a < 3; a++) center[a] /= total;
    // By value: every mesh made without a material has its own default one.
    const byMaterial = new Map<string, Mesh[]>();
    for (const mesh of members) {
      const key = meshRuntime(mesh).material.data.join(),
        list = byMaterial.get(key);
      if (list) list.push(mesh);
      else byMaterial.set(key, [mesh]);
    }
    const far: Mesh[] = [];
    let radius = 0;
    for (const group of byMaterial.values()) {
      let vertexCount = 0,
        indexCount = 0;
      for (const mesh of group) {
        const geometry = meshRuntime(mesh).geometry as Geometry;
        vertexCount += geometry.vertices.length / 6;
        indexCount += geometry.indices.length;
      }
      const positions = new Float32Array(vertexCount * 3),
        normals = new Float32Array(vertexCount * 3),
        indices = new Uint32Array(indexCount);
      let v = 0,
        n = 0;
      for (const mesh of group) {
        const runtime = meshRuntime(mesh),
          geometry = runtime.geometry as Geometry,
          m = runtime.matrix,
          source = geometry.vertices;
        for (let i = 0; i < geometry.indices.length; i++) indices[n++] = geometry.indices[i] + v;
        for (let i = 0; i < source.length / 6; i++, v++) {
          place(m, source[i * 6], source[i * 6 + 1], source[i * 6 + 2]);
          for (let a = 0; a < 3; a++) {
            positions[v * 3 + a] = point[a] - center[a];
            normals[v * 3 + a] = m[a] * source[i * 6 + 3] + m[4 + a] * source[i * 6 + 4] + m[8 + a] * source[i * 6 + 5];
          }
          radius = Math.max(radius, Math.hypot(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]));
        }
      }
      for (let i = 0; i < vertexCount; i++) {
        const size = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]) || 1;
        for (let a = 0; a < 3; a++) normals[i * 3 + a] /= size;
      }
      const geometry = simplify ? simplify(positions, indices, [ratio])[0] : new Geometry(positions, normals, indices);
      const first = meshRuntime(group[0]),
        mesh = (first.engine as unknown as { createMesh(): Mesh })
          .createMesh()
          .setGeometry(geometry)
          .setPosition(center as [number, number, number])
          .setMaterial(first.material);
      far.push(mesh);
      made.push(mesh);
    }
    const shown = (list: Mesh[]) => ({
      get visible() {
        return list[0].visible;
      },
      set visible(value: boolean) {
        for (const mesh of list) mesh.visible = value;
      },
    });
    lods.push(
      system.add(
        far[0],
        [{ object: shown(members) as unknown as Mesh }, { object: shown(far) as unknown as Mesh, distance }],
        {
          radius: radius || cell,
        },
      ),
    );
  }
  return {
    lods,
    meshes: made,
    remove() {
      for (const lod of lods) lod.remove();
      for (const mesh of made) mesh.dispose();
      for (const mesh of meshes) mesh.visible = true;
    },
  };
}
