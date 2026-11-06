// Builds levels of detail instead of taking them: simplified copies of a mesh (`autoLOD`) and one far mesh per cell of
// many still meshes (`hierarchicalLOD`). @margoengine/mesh-edit does the simplifying, loaded when first needed;
// @margoengine/materials makes the levels of its own meshes, loaded the same way.
import { Geometry, type Mesh } from '@margoengine/core';
import { meshRuntime } from '@margoengine/core/extension';
import type { PBRModel, PBRPrimitive } from '@margoengine/gltf-pro';
import type { createMesh, Material, MaterialMesh, MeshGeometry } from '@margoengine/materials';
import { MargoError } from '@margoengine/math/errors';
import { normalMatrix, simplifyPacked, type Modeling, type PackedGeometry } from './attributes.js';
import type { LOD, LODLevel, LODObject, LODSystem } from './index.js';
export type { PackedGeometry } from './attributes.js';

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
/** A mesh `autoLOD` and `hierarchicalLOD` take: a core mesh, or a `createMesh` mesh of `@margoengine/materials`. */
export type LODSource = Mesh | MaterialMesh<Material | readonly Material[]>;
/** What {@link hierarchicalLOD} built. */
export interface HierarchicalLOD {
  /** One LOD per cell that holds a mesh. */
  readonly lods: readonly LOD[];
  /** The far meshes made, per cell and material; for a materials mesh, its `root`. */
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
const isModel = (value: unknown): value is PBRModel =>
  Array.isArray((value as PBRModel | undefined)?.primitives) && !!(value as PBRModel).root;
const isMaterialMesh = (value: PBRModel): value is PBRModel & MaterialMesh<Material | readonly Material[]> =>
  'material' in value && typeof (value as { setGeometry?: unknown }).setGeometry === 'function';
/** Stays out of the way of a page that never simplifies a model. */
async function modeling(signal?: AbortSignal): Promise<Modeling> {
  signal?.throwIfAborted();
  const loaded = await import('@margoengine/mesh-edit/modeling');
  signal?.throwIfAborted();
  return loaded;
}
async function materialsPackage(signal?: AbortSignal): Promise<{ createMesh: typeof createMesh }> {
  const loaded = await import('@margoengine/materials');
  signal?.throwIfAborted();
  return loaded;
}
/**
 * Simplifies packed triangles (`primitive.vertices` and `primitive.indices` of a gltf-pro model or materials mesh) and
 * returns one geometry per ratio. Every level is a subset of the source's vertices, so normals, tangents, both UV sets
 * and colours are the source's own, and seams and hard edges stay closed. Loads `@margoengine/mesh-edit` on first use.
 * @throws RangeError for ratios that do not decrease within 0 to 1, or past 200,000 vertices or faces; the `signal`'s
 * reason when it aborts.
 */
export async function simplifyAttributes(
  geometry: PackedGeometry,
  ratios: readonly number[] = [0.5, 0.25, 0.125],
  { signal }: { signal?: AbortSignal } = {},
): Promise<PackedGeometry[]> {
  return simplifyPacked(await modeling(signal), geometry, ratios, signal);
}
/** Packed vertices back into the arrays `createMesh` takes; `colors` stays RGBA, UV1 stays separate from UV0. */
function meshGeometry(parts: readonly PackedGeometry[], slots?: readonly number[]): MeshGeometry {
  let total = 0,
    triangles = 0;
  for (const { vertices, indices } of parts) {
    total += vertices.length / 20;
    triangles += indices.length;
  }
  const positions = new Float32Array(total * 3),
    normals = new Float32Array(total * 3),
    tangents = new Float32Array(total * 4),
    uvs = new Float32Array(total * 2),
    uvs1 = new Float32Array(total * 2),
    colors = new Float32Array(total * 4),
    indices = new Uint32Array(triangles),
    groups: { start: number; count: number; materialIndex: number }[] = [];
  let at = 0,
    start = 0;
  parts.forEach(({ vertices: v, indices: source }, part) => {
    for (let i = 0; i < source.length; i++) indices[start + i] = source[i] + at;
    if (slots) groups.push({ start, count: source.length, materialIndex: slots[part] });
    start += source.length;
    for (let o = 0; o < v.length; o += 20, at++) {
      for (let k = 0; k < 3; k++) {
        positions[at * 3 + k] = v[o + k];
        normals[at * 3 + k] = v[o + 4 + k];
        tangents[at * 4 + k] = v[o + 8 + k];
      }
      tangents[at * 4 + 3] = v[o + 11];
      for (let k = 0; k < 2; k++) {
        uvs[at * 2 + k] = v[o + 12 + k];
        uvs1[at * 2 + k] = v[o + 14 + k];
      }
      for (let k = 0; k < 4; k++) colors[at * 4 + k] = v[o + 16 + k];
    }
  });
  return { positions, normals, tangents, uvs, uvs1, colors, indices, ...(slots ? { groups } : {}) };
}
/** The material slots of a materials mesh's primitives, or undefined for one scalar material. */
const slotsOf = (model: MaterialMesh<Material | readonly Material[]> & PBRModel) =>
  Array.isArray(model.material) ? model.primitives.map((p) => p.definition.material!) : undefined;
/** Shows the top nodes of a model, so its root can stay visible and carry the levels made from it. */
function ownNodes(model: PBRModel): LODObject {
  const children = new Set(model.asset.doc.nodes?.flatMap((node) => node.children ?? [])),
    top = model.nodes.filter((node, i) => !children.has(i) && node.visible);
  let visible = true;
  return {
    get visible() {
      return visible;
    },
    set visible(value: boolean) {
      visible = value;
      for (const node of top) node.visible = value;
    },
  } as unknown as LODObject;
}
function check(model: PBRModel): void {
  if (model.disposed) throw new MargoError('disposed', 'autoLOD needs a live model; load the model again');
  if (
    model.primitives.some(
      (p) =>
        p.definition.targets?.length ||
        p.definition.attributes?.JOINTS_0 !== undefined ||
        model.asset.doc.nodes?.[p.nodeIndex]?.skin !== undefined,
    )
  )
    throw new TypeError(
      'autoLOD needs a model without skins or morph targets; give the file MSFT_lod levels, or bake an Imposter',
    );
}
/** Radius of a model's bounds around their centre, in its root's units. */
function modelRadius(model: PBRModel): number {
  const b = model.bounds,
    m = model.root.matrix,
    scale = Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])) || 1;
  return Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2 / scale || 1;
}
/**
 * The levels of a model: `simplified` holds, per distinct primitive, one geometry per ratio. Each level hangs under the
 * model's root and goes with the model; the model's own nodes are level 0.
 */
async function modelLevels(
  model: PBRModel,
  simplified: ReadonlyMap<PBRPrimitive['definition'], PackedGeometry[]>,
  count: number,
  signal?: AbortSignal,
): Promise<PBRModel[]> {
  if (!isMaterialMesh(model)) throw new TypeError('autoLOD takes core meshes and materials meshes; pass one of those');
  if ((model as { instances?: unknown }).instances)
    throw new TypeError('autoLOD needs one mesh, not instances; use LodInstances from @margoengine/culling/lod');
  const { createMesh } = await materialsPackage(signal),
    made: PBRModel[] = [];
  for (let level = 0; level < count; level++) {
    const parts = model.primitives.map((p) => simplified.get(p.definition)![level]);
    const mesh = createMesh(model.root.engine, meshGeometry(parts, slotsOf(model)), model.material, {
      renderOrder: model.renderOrder,
    });
    mesh.root.setParent(model.root);
    model.onDispose(() => mesh.dispose());
    made.push(mesh);
  }
  return made;
}
async function autoModelLOD(
  system: LODSystem,
  model: PBRModel,
  ratios: readonly number[],
  screens: readonly number[],
  signal?: AbortSignal,
): Promise<LOD> {
  check(model);
  const simplify = await modeling(signal),
    simplified = new Map<PBRPrimitive['definition'], PackedGeometry[]>();
  for (const p of model.primitives)
    if (!simplified.has(p.definition)) simplified.set(p.definition, simplifyPacked(simplify, p, ratios, signal));
  const made = await modelLevels(model, simplified, ratios.length, signal),
    levels: LODLevel[] = [{ object: ownNodes(model) }];
  made.forEach((object, i) => levels.push({ object, screen: screens[i] }));
  return system.add(model.root, levels, { radius: modelRadius(model) });
}
const positionsOf = (geometry: Geometry, out = new Float32Array(geometry.vertices.length / 2)) => {
  for (let i = 0; i < out.length / 3; i++) for (let a = 0; a < 3; a++) out[i * 3 + a] = geometry.vertices[i * 6 + a];
  return out;
};

/**
 * Registers `mesh` in `system` with simplified copies of its own geometry as the lower levels. Loads
 * `@margoengine/mesh-edit` on first use. A core mesh's levels are core geometry, which holds positions and normals.
 * A materials mesh's levels are materials meshes on the same materials, keeping its UVs, tangents and colours; they
 * hang under its `root` and are disposed with it, and `shadows.add` and the like take each one like the source.
 * @throws TypeError for a mesh with no core geometry, or one with skins, morph targets or instances; RangeError for
 * ratios or screens that do not fit; the `signal`'s reason when it aborts.
 */
export async function autoLOD(system: LODSystem, mesh: LODSource, options: AutoLODOptions = {}): Promise<LOD> {
  const { ratios = [0.5, 0.25, 0.125], crease = 60, signal } = options,
    screens = options.screens ?? ratios.map((_, i) => 0.25 * 0.5 ** i);
  if (isModel(mesh)) {
    if (screens.length !== ratios.length)
      throw new RangeError('autoLOD needs one screen size per ratio; give them the same length');
    return autoModelLOD(system, mesh, ratios, screens, signal);
  }
  const geometry = meshRuntime(mesh).geometry;
  if (!(geometry instanceof Geometry))
    throw new TypeError(
      'autoLOD needs a mesh with core geometry; call setGeometry first, or pass a materials mesh',
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

/** Packed primitives under their node matrices into one geometry around `center`: normals by the cofactor matrix, a mirrored part rewound. */
function mergePacked(
  parts: readonly { primitive: PackedGeometry; matrix: Float32Array }[],
  center: readonly number[],
): PackedGeometry {
  let floats = 0,
    count = 0;
  for (const { primitive } of parts) {
    floats += primitive.vertices.length;
    count += primitive.indices.length;
  }
  const vertices = new Float32Array(floats),
    indices = new Uint32Array(count);
  let at = 0,
    next = 0;
  for (const { primitive, matrix: m } of parts) {
    const { c, mirrored: flip } = normalMatrix(m),
      v = primitive.vertices,
      base = at / 20,
      source = primitive.indices;
    for (let o = 0; o < v.length; o += 20, at += 20) {
      vertices.set(v.subarray(o, o + 20), at);
      for (let r = 0; r < 3; r++) {
        vertices[at + r] = m[r] * v[o] + m[4 + r] * v[o + 1] + m[8 + r] * v[o + 2] + m[12 + r] - center[r];
        vertices[at + 4 + r] = c[r] * v[o + 4] + c[3 + r] * v[o + 5] + c[6 + r] * v[o + 6];
        vertices[at + 8 + r] = m[r] * v[o + 8] + m[4 + r] * v[o + 9] + m[8 + r] * v[o + 10];
      }
      for (const from of [at + 4, at + 8]) {
        const size = Math.hypot(vertices[from], vertices[from + 1], vertices[from + 2]) || 1;
        for (let r = 0; r < 3; r++) vertices[from + r] /= size;
      }
      if (flip) vertices[at + 11] = -vertices[at + 11];
    }
    for (let i = 0; i < source.length; i += 3) {
      indices[next++] = source[i] + base;
      indices[next++] = source[i + (flip ? 2 : 1)] + base;
      indices[next++] = source[i + (flip ? 1 : 2)] + base;
    }
  }
  return { vertices, indices };
}

/**
 * Hierarchical level of detail for still meshes: per cell of a world grid, one far mesh per material holds their
 * triangles in world space, and shows in place of those meshes past `distance`. Materials meshes merge with their UVs,
 * tangents and colours into one materials mesh per cell and material. Moving a source mesh afterwards does not move
 * its far mesh. The world matrices are read now: call it after a frame has placed the meshes.
 * @throws TypeError when a mesh has no core geometry, or is a model with skins, morph targets or instances; RangeError
 * for options out of range; MargoError `'state'` for an empty list; the `signal`'s reason when it aborts.
 */
export async function hierarchicalLOD(
  system: LODSystem,
  meshes: readonly LODSource[],
  options: HierarchicalLODOptions,
): Promise<HierarchicalLOD> {
  const { cell, distance = cell * 8, ratio = 1, crease = 60, signal } = options ?? {};
  if (!(cell > 0 && cell < Infinity) || !(distance >= 0 && distance < Infinity) || !(ratio > 0 && ratio <= 1))
    throw new RangeError('Invalid hierarchical LOD options; give cell above 0, distance of 0 or more, ratio up to 1');
  if (!meshes?.length) throw new MargoError('state', 'hierarchicalLOD needs meshes; pass at least one still mesh');
  const simplify = ratio < 1 ? await simplifier(crease, signal) : undefined,
    packedSimplify = ratio < 1 && meshes.some(isModel) ? await modeling(signal) : undefined,
    cells = new Map<string, { members: Mesh[]; models: PBRModel[]; center: number[]; total: number }>(),
    point = [0, 0, 0];
  signal?.throwIfAborted();
  const place = (m: Float32Array, x: number, y: number, z: number) => {
    for (let a = 0; a < 3; a++) point[a] = m[a] * x + m[4 + a] * y + m[8 + a] * z + m[12 + a];
  };
  for (const mesh of meshes) {
    if (isModel(mesh)) {
      check(mesh);
      if (!isMaterialMesh(mesh) || (mesh as { instances?: unknown }).instances)
        throw new TypeError('hierarchicalLOD takes core meshes and materials meshes without instances; pass one of those');
      const b = mesh.bounds;
      for (let a = 0; a < 3; a++) point[a] = (b[a] + b[a + 3]) / 2;
    } else {
      const runtime = meshRuntime(mesh),
        geometry = runtime.geometry;
      if (!(geometry instanceof Geometry))
        throw new TypeError('hierarchicalLOD needs meshes with core geometry; call setGeometry first');
      place(runtime.matrix, geometry.bounds[0], geometry.bounds[1], geometry.bounds[2]);
    }
    const key = point.map((v) => Math.floor(v / cell)).join();
    let entry = cells.get(key);
    if (!entry) cells.set(key, (entry = { members: [], models: [], center: [0, 0, 0], total: 0 }));
    if (isModel(mesh)) entry.models.push(mesh);
    else entry.members.push(mesh);
    entry.total++;
    for (let a = 0; a < 3; a++) entry.center[a] += point[a];
  }
  const lods: LOD[] = [],
    made: Mesh[] = [],
    models: PBRModel[] = [];
  for (const { members, models: sources, center, total } of cells.values()) {
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
    if (sources.length) {
      const { createMesh } = await materialsPackage(signal),
        byPart = new Map<Material, { primitive: PBRPrimitive; matrix: Float32Array }[]>();
      for (const model of sources as (PBRModel & MaterialMesh<Material | readonly Material[]>)[]) {
        const material = model.material,
          list = Array.isArray(material) ? (material as readonly Material[]) : [material as Material];
        for (const primitive of model.primitives) {
          const slot = list[Array.isArray(material) ? primitive.definition.material! : 0],
            parts = byPart.get(slot),
            part = { primitive, matrix: primitive.node.matrix };
          if (parts) parts.push(part);
          else byPart.set(slot, [part]);
        }
      }
      for (const [material, parts] of byPart) {
        const whole = mergePacked(parts, center),
          kept = packedSimplify ? simplifyPacked(packedSimplify, whole, [ratio], signal)[0] : whole,
          mesh = createMesh(sources[0].root.engine, meshGeometry([kept]), material);
        for (let o = 0; o < kept.vertices.length; o += 20)
          radius = Math.max(radius, Math.hypot(kept.vertices[o], kept.vertices[o + 1], kept.vertices[o + 2]));
        mesh.root.setPosition(center as [number, number, number]);
        far.push(mesh.root);
        models.push(mesh);
      }
    }
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
          source = geometry.vertices,
          { c, mirrored } = normalMatrix(m);
        for (let i = 0; i < geometry.indices.length; i += 3) {
          indices[n++] = geometry.indices[i] + v;
          indices[n++] = geometry.indices[i + (mirrored ? 2 : 1)] + v;
          indices[n++] = geometry.indices[i + (mirrored ? 1 : 2)] + v;
        }
        for (let i = 0; i < source.length / 6; i++, v++) {
          place(m, source[i * 6], source[i * 6 + 1], source[i * 6 + 2]);
          for (let a = 0; a < 3; a++) {
            positions[v * 3 + a] = point[a] - center[a];
            normals[v * 3 + a] = c[a] * source[i * 6 + 3] + c[3 + a] * source[i * 6 + 4] + c[6 + a] * source[i * 6 + 5];
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
        [
          { object: shown([...members, ...sources.map((model) => model.root)]) as unknown as Mesh },
          { object: shown(far) as unknown as Mesh, distance },
        ],
        {
          radius: radius || cell,
        },
      ),
    );
  }
  return {
    lods,
    meshes: [...made, ...models.map((model) => model.root)],
    remove() {
      for (const lod of lods) lod.remove();
      for (const mesh of made) mesh.dispose();
      for (const model of models) model.dispose();
      for (const mesh of meshes) (isModel(mesh) ? mesh.root : mesh).visible = true;
    },
  };
}
